import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../types";
import { hmacSha256Hex } from "../../lib/hmac";
import { adminApp } from "./index";

// /admin/query/ -- WP 6.10, the guarded query console. The one admin page
// with NO Django ancestor at all (query.ts:10-16, PLAN.md:10851: "Genuinely
// new -- there is no Django admin page like this to port"), so there is no
// view to check parity against; the contract is PLAN.md §8.13.1's five
// bullets plus the two additions the build note records, and that is what
// this file pins.
//
// IT IS THE ONE PAGE IN THE ADMIN WHOSE INPUT IS SQL. Every other handler
// puts the maintainer's typing through parseAdminFields and a hand-written
// statement; this one hands it to the engine. That inverts where the danger
// is. Issue #34's shape -- "a value parsed, threaded through the handler,
// then used by nothing, with a response that looks like success" -- has two
// twins here, and both look exactly like a working console:
//
//   * THE GUARD THAT DOES NOTHING. `^(SELECT|EXPLAIN)\b` and the
//     no-semicolon rule are the only things between the admin's textarea and
//     D1. A guard that let `DELETE FROM foodbank` through renders a perfectly
//     ordinary "No rows." page on its way to emptying a table, and a guard
//     that ran the statement BEFORE deciding to reject it would render the
//     rejection banner over an already-executed write. So every rejection
//     test below asserts three things and not one: the banner, that no
//     statement was ever PREPARED, and that the database is byte-identical
//     afterwards. A status code alone cannot tell those apart.
//
//   * THE CAP THAT DOES NOT CAP. The hard LIMIT 500 exists so a
//     `SELECT * FROM foodbankchange` on a Friday afternoon cannot try to
//     render 400,000 rows into an admin page. It is implemented by wrapping
//     the admin's own text as `SELECT * FROM (<query>) LIMIT ?`, and the
//     `truncated` flag is a `> RESULT_LIMIT` comparison against a deliberate
//     501-row fetch. An off-by-one there, or a wrap that silently dropped the
//     admin's own ORDER BY, produces a page that is wrong and calm. The
//     boundary is therefore tested from BOTH sides -- exactly 500 rows and
//     exactly 501 -- and the SQL log is asserted verbatim so that the wrap is
//     checked as text, not inferred from the row count it produced.
//
// REAL ROUTER, REAL AUTH, REAL TEMPLATES, REAL SQLITE -- the same harness as
// jobs.test.ts and crawlSets.test.ts. `adminApp` is mounted at /admin exactly
// as workers/site/src/index.ts mounts it, so requests go through the real
// route registration (which is what makes GET and POST two different things
// here) and the real requireAdminAuth. D1 is node:sqlite behind the Sessions
// surface, SESSIONS is a Map, and CSRF is the shipped lib/csrf.ts with a real
// HMAC over a real cookie. NOTHING IS MOCKED: this page makes no outbound
// call, so there is nothing that leaves the machine to stub. (The single
// vi.spyOn below silences a console.log and replaces no behaviour.)
//
// Assertions are on the RENDERED HTML rather than on the render() context
// because half of what silently breaks lives in query.njk: `show_results` is
// an explicit flag precisely so that an empty-but-successful SELECT still
// renders a Results section (PLAN.md:10851 calls out that an accidental
// `rows.length` check "would have also hidden a legitimately empty result
// set"), the truncation warning is in the heading text and nowhere else, and
// the columns are derived per-table from the first row. A context-level
// assertion cannot tell "Results: No rows." from no Results section at all,
// and that is the exact distinction the flag was added for.
//
// One divergence between this harness and D1 is worth stating rather than
// discovering: node:sqlite's error strings are SQLite's raw ones
// ("no such table: nope"), while D1 wraps them ("D1_ERROR: no such table:
// nope: SQLITE_ERROR"). The handler renders `err.message` verbatim either
// way, so the tests below assert the SQLite substring inside the banner
// rather than a whole message this fixture alone would produce.

// Reduced from packages/db/migrations/0001_core.sql:10-46 -- the columns a
// human would actually type into this console, and nothing else. The console
// runs whatever it is given, so unlike every other admin suite the fixture is
// not "the tables the handler names": the handler names none. What it needs
// is a plausible thing to SELECT from, a second table to prove a rejected
// statement touched nothing anywhere, and a wide one for the 500-row cap.
const SCHEMA = `
CREATE TABLE foodbank (
  id INTEGER PRIMARY KEY,
  uuid TEXT NOT NULL,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  postcode TEXT NOT NULL, country TEXT NOT NULL,
  network TEXT, is_closed INTEGER NOT NULL
);
CREATE UNIQUE INDEX foodbank_slug_uniq ON foodbank(slug);
CREATE TABLE foodbankchange (
  id INTEGER PRIMARY KEY, need_id TEXT NOT NULL,
  foodbank_id INTEGER NOT NULL, published INTEGER
);
`;

type Bindable = null | number | bigint | string | Uint8Array;

/** One statement as it was EXECUTED, with the values bound to it.
 *
 *  The `log` below records what was PREPARED, which is what tells "the guard
 *  refused this" apart from "the guard ran it and then complained". This
 *  records what the engine was asked to run it WITH, and it exists because
 *  the prepared text alone cannot see the cap at all: `LIMIT ?` is the same
 *  string whether the bound value is 501 or 1,000,000. Mutants
 *  `cap-bind-overfetch-by-100` and `cap-bind-huge` -- `.bind(RESULT_LIMIT +
 *  1)` changed to any larger number -- SURVIVED the whole of the rest of this
 *  file: every rendered page stayed correct, because 501 rows or a million
 *  both get sliced back to 500 before rendering. The console would simply
 *  pull the entire table out of D1 on every run to show 500 rows of it, which
 *  is the exact outcome the cap exists to prevent and is invisible in the
 *  HTML. */
interface Executed {
  sql: string;
  params: unknown[];
}

// The D1DatabaseSession surface packages/db uses, over node:sqlite, with a
// `log` of every statement prepared. The log is not decoration here: it is
// the only way "the guard rejected this" can be told apart from "the guard
// ran it and then complained", and the only way the LIMIT wrap can be
// asserted as the text it is rather than guessed at from its output. An
// UPDATE that happened to match no fixture row leaves the snapshot identical
// and is still a mutation against production data.
//
// db.prepare() is deliberately called INSIDE all()/run() rather than in
// prepare(), so that SQLite's compile-time errors (a bad table name, a
// syntax error) surface from the awaited call exactly as D1's do -- which is
// where query.ts's try/catch is waiting for them.
function d1Session(db: DatabaseSync, log: string[], executed: Executed[] = []): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => {
      executed.push({ sql, params });
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    all: async () => {
      executed.push({ sql, params });
      return { results: db.prepare(sql).all(...params), success: true, meta: {} };
    },
    run: async () => {
      executed.push({ sql, params });
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return {
    prepare: (sql: string) => {
      log.push(sql);
      return statement(sql, []);
    },
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

const ORIGIN = "https://www.givefood.org.uk";
const SESSION_ID = "test-session-id";
const ADMIN_EMAIL = "someone@givefood.org.uk";
const CSRF_SECRET = "test-csrf-secret-not-a-real-one";
// A 64-hex raw token, the shape issueCsrfToken mints (32 random bytes, hex).
const CSRF_RAW = "a".repeat(64);

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let sessionStore: Map<string, string>;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  seedFoodbank(1, "Salisbury Foodbank", "salisbury", "SP2 7QQ", "Trussell Trust");
  seedFoodbank(2, "Brixton Food Bank", "brixton", "SW2 5SG", "Independent");
  seedFoodbank(3, "Ayr Foodbank", "ayr", "KA8 8DL", null);
  db.prepare("INSERT INTO foodbankchange (id, need_id, foodbank_id, published) VALUES (1, 'need-1', 1, 1)").run();
  // The shape lib/adminAuth.ts's getAdminSession reads back out of KV.
  // expiresAt a full TTL ahead so the sliding-refresh branch (past the
  // halfway point) does not fire and put() noise into these tests.
  sessionStore = new Map([
    [
      `admin-session:${SESSION_ID}`,
      JSON.stringify({ email: ADMIN_EMAIL, name: "Some One", givenName: "Some", picture: "", expiresAt: Date.now() + 12 * 60 * 60 * 1000 }),
    ],
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function seedFoodbank(id: number, name: string, slug: string, postcode: string, network: string | null): void {
  db.prepare("INSERT INTO foodbank (id, uuid, name, slug, postcode, country, network, is_closed) VALUES (?, ?, ?, ?, ?, 'England', ?, 0)").run(
    id,
    `uuid-${slug}`,
    name,
    slug,
    postcode,
    network,
  );
}

/** Every row of every table, as one comparable value. Snapshotted either side
 *  of a request so "this was refused" covers columns no assertion names, and
 *  tables the statement under test never mentioned. */
function snapshot(): string {
  return JSON.stringify({
    foodbank: db.prepare("SELECT * FROM foodbank ORDER BY id").all(),
    foodbankchange: db.prepare("SELECT * FROM foodbankchange ORDER BY id").all(),
    // The schema itself, so that a DROP or an ALTER that slipped through the
    // guard is caught even though it leaves no row behind to compare.
    schema: db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all(),
  });
}

interface Fetched {
  res: Response;
  html: string;
  /** Every SQL statement the request prepared, in order. Empty means nothing reached the engine. */
  sql: string[];
  /** The same statements as they were executed, each with its bound values. */
  executed: Executed[];
  /** The mode every D1 session this request opened was opened with. Empty
   *  means the handler never even asked for a session. */
  sessionModes: string[];
}

function buildEnv(log: string[], secret: string | undefined, executed: Executed[] = [], sessionModes: string[] = []): AppEnv["Bindings"] {
  return {
    DB: {
      // The mode is captured rather than ignored because it is the one D1
      // configuration decision this handler makes, and it is invisible in
      // every other assertion: mutant `dbsession-mode-primary` -- swapping
      // lib/session.ts's dbSession(c) for a hand-rolled
      // withSession("first-primary") -- survived the whole file. On a
      // read-replicated database (PLAN.md §3.3, the reason every packages/db
      // query goes through a Session at all) that silently sends every
      // console query to the primary.
      withSession: (mode: string) => {
        sessionModes.push(mode);
        return d1Session(db, log, executed);
      },
    },
    SESSIONS: {
      get: async (key: string) => sessionStore.get(key) ?? null,
      put: async (key: string, value: string) => void sessionStore.set(key, value),
      delete: async (key: string) => void sessionStore.delete(key),
    },
    CSRF_SECRET: secret,
    GMAP_STATIC_KEY: "",
    GMAP_GEOCODE_KEY: "",
    D1_DATABASE_NAME: "givefood-test",
  } as unknown as AppEnv["Bindings"];
}

// A real Hono app with adminApp mounted at the production prefix. onError is
// caught and labelled rather than left to become an unhandled rejection, so a
// regression reads as "expected 200, got 500: <message>" -- which matters
// more here than elsewhere, because "the SQL error reached the 500 page
// instead of the banner" is one of the failures this page is meant to
// prevent (a `psql`-style error at the prompt, not a stack trace).
function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // index.ts sets this globally (middleware/serverTiming.ts); adminPageContext
  // reads it for the footer's "Rendered in N ms", and without it every page
  // would say "NaN ms" -- true of the real app too.
  app.use("*", async (c, next) => {
    c.set("requestStartTime", performance.now());
    await next();
  });
  app.route("/admin", adminApp);
  app.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));
  return app;
}

interface RequestOptions {
  signedIn?: boolean;
  /** Omit for the valid token; pass a string to submit a different one, or null to submit no field at all. */
  formToken?: string | null;
  /** Omit for a correctly signed cookie; pass a string for a raw Cookie header, or null for none. */
  cookie?: string | null;
  origin?: string | null;
  secFetchSite?: string | null;
  /** Deploy the Worker with no CSRF_SECRET binding, which lib/csrf.ts fails closed on. */
  noCsrfSecret?: boolean;
}

async function request(method: string, path: string, body: Record<string, string> | null, opts: RequestOptions = {}): Promise<Fetched> {
  const sql: string[] = [];
  const executed: Executed[] = [];
  const sessionModes: string[] = [];
  const headers: Record<string, string> = {};

  const cookies: string[] = [];
  if (opts.signedIn !== false) cookies.push(`__Host-gfsession=${SESSION_ID}`);
  if (opts.cookie === undefined) {
    const signature = await hmacSha256Hex(CSRF_SECRET, CSRF_RAW);
    cookies.push(`__Host-csrf=${CSRF_RAW}.${signature}`);
  } else if (opts.cookie !== null) {
    cookies.push(opts.cookie);
  }
  if (cookies.length) headers.Cookie = cookies.join("; ");

  let payload: string | undefined;
  if (body) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    const fields = new URLSearchParams(body);
    if (opts.formToken === undefined) fields.set("csrf_token", CSRF_RAW);
    else if (opts.formToken !== null) fields.set("csrf_token", opts.formToken);
    payload = fields.toString();
    // Both of these are sent by every real browser on a same-origin form POST,
    // and verifyCsrf checks both. Overridable so the cross-origin refusals can
    // be exercised through the route rather than only in csrf.test.ts.
    if (opts.origin !== null) headers.Origin = opts.origin ?? ORIGIN;
    if (opts.secFetchSite !== null) headers["Sec-Fetch-Site"] = opts.secFetchSite ?? "same-origin";
  }

  const res = await buildApp().fetch(
    new Request(`${ORIGIN}${path}`, { method, headers, body: payload }),
    buildEnv(sql, opts.noCsrfSecret ? undefined : CSRF_SECRET, executed, sessionModes),
    execCtx,
  );
  // Read the body once, here: several assertions want it and a Response body
  // can only be consumed once.
  const html = res.status === 302 ? "" : await res.text();
  return { res, html, sql, executed, sessionModes };
}

/** POST /admin/query/ with `query` as the admin typed it, signed in and with a valid token unless told otherwise. */
function runQuery(query: string, opts: RequestOptions = {}): Promise<Fetched> {
  return request("POST", "/admin/query/", { query }, opts);
}

/** GET /admin/query/ -- the empty form. */
function getConsole(path = "/admin/query/", opts: RequestOptions = {}): Promise<Fetched> {
  return request("GET", path, null, opts);
}

// ---------------------------------------------------------------------------
// Reading the rendered page
// ---------------------------------------------------------------------------

// query.njk lays the page out under three <h2>s -- the title, "Query plan"
// and "Results" -- and admin/page.njk's chrome contains no <h2> at all, so
// splitting on the tag is exact. Addressed by heading rather than by index
// because the Results panel is CONDITIONAL on `show_results`: an EXPLAIN
// renders a plan and no results, and asserting by position would quietly
// compare the plan against the results expectations.
function panels(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of html.split("<h2>").slice(1)) {
    const end = part.indexOf("</h2>");
    out[part.slice(0, end)] = part.slice(end + "</h2>".length);
  }
  return out;
}

/** The headings, in document order -- so "the plan comes ABOVE the results"
 *  (PLAN.md §8.13.1's third bullet, "so a SCAN is visible") is an assertion
 *  and not an assumption. */
function headings(html: string): string[] {
  return [...html.matchAll(/<h2>([\s\S]*?)<\/h2>/g)].map((m) => m[1]!);
}

interface Table {
  columns: string[];
  rows: string[][];
}

/** The one table inside a panel, or null when the panel rendered "No rows."
 *  instead. Column headers are returned separately from the cells because
 *  rowsToColumns() derives them from the FIRST ROW ONLY -- a header list that
 *  disagreed with the cells is the failure mode that hides a column. */
// Addressed by heading PREFIX, because the Results heading grows a
// "(truncated at 500 rows)" suffix exactly when this file most wants to read
// the table under it.
function table(html: string, heading: string): Table | null {
  const key = Object.keys(panels(html)).find((h) => h.startsWith(heading));
  if (key === undefined) throw new Error(`no <h2>${heading}...</h2> panel in the rendered page`);
  const panel = panels(html)[key]!;
  const head = /<thead>([\s\S]*?)<\/thead>/.exec(panel);
  if (!head) return null;
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(panel)!;
  return {
    columns: [...head[1]!.matchAll(/<th>([\s\S]*?)<\/th>/g)].map((m) => m[1]!),
    rows: [...body[1]!.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((tr) => [...tr[1]!.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((td) => td[1]!)),
  };
}

/** The panel heading that starts with `prefix`, in full -- the truncation
 *  warning lives in the Results heading text and nowhere else. */
function headingStartingWith(html: string, prefix: string): string | undefined {
  return headings(html).find((h) => h.startsWith(prefix));
}

/** The banner query.njk:45 renders `error` into, entity-decoded so the
 *  expectation reads as the sentence a human sees. */
function errorBanner(html: string): string | null {
  const match = /<div class="notification is-danger is-light">([\s\S]*?)<\/div>/.exec(html);
  if (!match) return null;
  return match[1]!
    .trim()
    .replace(/&#34;|&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** The raw contents of the query textarea -- NOT decoded, because whether the
 *  admin's own angle brackets come back escaped is one of the things asserted. */
function textareaValue(html: string): string {
  const match = /<textarea name="query"[^>]*>([\s\S]*?)<\/textarea>/.exec(html);
  if (!match) throw new Error("the query form has no textarea -- the page is not the console");
  return match[1]!;
}

/** The same, decoded -- what the admin actually sees in the box, and so what
 *  "my query came back" means. Nunjucks autoescapes, so the apostrophes in
 *  every realistic WHERE clause arrive as `&#39;`; decoding here rather than
 *  writing the expectations in entities keeps them readable as SQL. */
function textareaText(html: string): string {
  return textareaValue(html)
    .replace(/&#34;|&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** The value of the hidden token query.njk:31 renders into the form. */
function formToken(html: string): string {
  const match = /<input type="hidden" name="csrf_token" value="([^"]*)">/.exec(html);
  if (!match) throw new Error("the query form has no csrf_token field");
  return match[1]!;
}

/** The rejection query.ts:50 produces for anything the guard refuses. */
const GUARD_ERROR = "Only a single SELECT or EXPLAIN statement is allowed.";

// ---------------------------------------------------------------------------
// The harness itself
// ---------------------------------------------------------------------------

// Most of this file's strongest claims are NEGATIVE -- `sql` is empty, the
// snapshot is unchanged -- and a negative assertion is worthless if the thing
// it watches cannot move. This drives a write through the same D1 shim every
// test uses and shows both instruments responding, so that every "nothing
// reached the engine" and "nothing changed" below is a claim that could have
// failed. Without it, a `log` that was never pushed to, or a snapshot() that
// silently returned a constant, would make two dozen tests pass by being
// blind.
describe("the D1 shim reports what it is asked to report", () => {
  it("logs a statement and shows the write in the snapshot", async () => {
    const log: string[] = [];
    const before = snapshot();

    await d1Session(db, log).prepare("DELETE FROM foodbank WHERE slug = 'ayr'").run();

    expect(log).toEqual(["DELETE FROM foodbank WHERE slug = 'ayr'"]);
    expect(snapshot()).not.toBe(before);
  });

  // The same argument for the bound-value collector. `executed` carries the
  // only assertion in this file that can see the cap's own parameter, so a
  // collector that recorded an empty params array for everything would make
  // that assertion pass against a `.bind(1000000)`. Driven here with a value
  // that has to survive prepare() -> bind() -> all() to show up.
  it("records a bound value alongside the statement it was bound to", async () => {
    const executed: Executed[] = [];

    const rows = await d1Session(db, [], executed).prepare("SELECT slug FROM foodbank WHERE id = ?").bind(2).all();

    expect(executed).toEqual([{ sql: "SELECT slug FROM foodbank WHERE id = ?", params: [2] }]);
    expect(rows.results).toEqual([{ slug: "brixton" }]);
  });

  // The schema half of the snapshot, which no row-level comparison would see:
  // a CREATE leaves every existing row exactly as it was. (A DROP is caught
  // even more bluntly -- snapshot() then throws "no such table" from its own
  // SELECT, which fails the test just as loudly.)
  it("shows a new table in the snapshot even though no row moved", async () => {
    const before = snapshot();

    await d1Session(db, []).prepare("CREATE TABLE evil (id INTEGER)").run();

    expect(db.prepare("SELECT * FROM foodbank ORDER BY id").all()).toHaveLength(3);
    expect(snapshot()).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe("auth", () => {
  // requireAdminAuth (middleware/adminAuth.ts, Django's LoginRequiredAccess)
  // is registered on adminApp with use("*"), so it must run before this
  // handler. PLAN.md §8.13.1's first bullet is "POST-only, inside the admin
  // session gate", and on this page in particular the gate is the whole of
  // the authorisation model: past it, the caller chooses the SQL. Asserted
  // through the SQL log rather than the status alone -- a handler that ran
  // the statement and then noticed the missing session would have already
  // read the row out of the database.
  it("redirects a signed-out GET to sign-in without touching D1", async () => {
    const { res, sql } = await getConsole("/admin/query/", { signedIn: false });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fquery%2F");
    expect(sql).toEqual([]);
  });

  // The one that matters: an anonymous POST is an anonymous SELECT against
  // production if it reaches the handler, and the CSRF check inside the
  // handler would never even be consulted.
  it("redirects a signed-out POST to sign-in without running the statement", async () => {
    const before = snapshot();

    const { res, sql } = await runQuery("SELECT * FROM foodbank", { signedIn: false });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fquery%2F");
    expect(sql).toEqual([]);
    expect(snapshot()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// GET -- the form, and only the form
// ---------------------------------------------------------------------------

describe("GET /admin/query/", () => {
  it("renders the empty form with its CSRF field and its documented cap", async () => {
    const { res, html } = await getConsole();

    expect(res.status).toBe(200);
    expect(textareaValue(html)).toBe("");
    // Without a token in the form there is nothing to submit -- the console
    // would render and then 403 every run.
    expect(html).toContain('name="csrf_token"');
    // RESULT_LIMIT is threaded to the template as `result_limit` and appears
    // in the standing explanation as well as the truncation warning, so a cap
    // changed in the code but not in the prose is visible here.
    expect(html).toContain("results are capped at 500 rows");
  });

  // `ran` is false on a GET, which is what hides both panels. The distinction
  // this asserts is between "no query was run" and "a query ran and returned
  // nothing" -- the latter renders a Results panel saying "No rows.", and
  // conflating them is exactly the accident show_results exists to avoid.
  it("shows neither a plan nor a results panel", async () => {
    const { html } = await getConsole();

    expect(headings(html)).toEqual(["Query console"]);
    expect(html).not.toContain("Query plan");
    expect(html).not.toContain("No rows.");
    expect(errorBanner(html)).toBeNull();
  });

  it("prepares no statement at all", async () => {
    const { sql } = await getConsole();

    expect(sql).toEqual([]);
  });

  // THE POINT OF THE POST-ONLY DESIGN, spelled out in query.ts:13-15 and
  // PLAN.md:10851: "never accepted via a URL query string, so a stray link or
  // an image tag can't trigger one, and raw SQL never lands in access logs".
  // A handler that read c.req.query("query") as a fallback would make an
  // <img src="/admin/query/?query=..."> in any page the admin visits run SQL
  // as them, and would put the statement into every access log and Referer
  // header on the way. Nothing about the rendered page would look different,
  // which is why this is asserted and not assumed.
  it("ignores a query supplied in the URL rather than running it", async () => {
    const before = snapshot();

    const { res, html, sql } = await getConsole("/admin/query/?query=SELECT%20*%20FROM%20foodbank");

    expect(res.status).toBe(200);
    expect(sql).toEqual([]);
    expect(textareaValue(html)).toBe("");
    expect(headings(html)).toEqual(["Query console"]);
    expect(snapshot()).toBe(before);
  });

  // The same URL-parameter path, with a statement that would be refused
  // anyway: a GET must not even reach the guard, so there must be no banner
  // either. A page that rendered "Only a single SELECT..." here would be
  // proof the URL was being parsed.
  it("does not even report on a URL-supplied statement it would have refused", async () => {
    const { html } = await getConsole("/admin/query/?query=DELETE%20FROM%20foodbank");

    expect(errorBanner(html)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The URL query string is not an input to this page, on ANY method
// ---------------------------------------------------------------------------

// The GET block above proves a `?query=` is ignored on a GET, which is where
// the design's stated risk is ("a stray link or an image tag can't trigger
// one"). It leaves the POST side of the same claim untested, and two mutants
// walked straight through the gap:
//
//   * `get-runs-a-url-supplied-query` -- a `?? c.req.query("query")` fallback
//     added after the body read. Every test in this file supplies a `query`
//     field, so the fallback never fired and all 80 passed.
//   * `post-body-query-ignored-url-used` -- the URL param taking PRECEDENCE
//     over the body. Same blind spot: no request here ever sent both.
//
// Either one puts raw SQL into the URL, which is the half of the POST-only
// rule that is about access logs and Referer headers rather than about
// forgery -- and neither changes anything a rendered page would show.
describe("the URL query string", () => {
  it("is not read as a fallback when the POST body carries no query field", async () => {
    const before = snapshot();

    const { res, html, sql } = await request("POST", "/admin/query/?query=SELECT%20*%20FROM%20foodbank", {});

    // Treated exactly as an empty submission is: refused by the guard,
    // nothing prepared, nothing changed.
    expect(res.status).toBe(200);
    expect(errorBanner(html)).toBe(GUARD_ERROR);
    expect(sql).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  it("does not override the query the admin actually typed", async () => {
    const { sql, html } = await request("POST", "/admin/query/?query=SELECT%20postcode%20FROM%20foodbank", { query: "SELECT slug FROM foodbank ORDER BY slug" });

    // The body's statement, and only the body's statement.
    expect(sql).toEqual([
      "EXPLAIN QUERY PLAN SELECT slug FROM foodbank ORDER BY slug",
      "SELECT * FROM (SELECT slug FROM foodbank ORDER BY slug) LIMIT ?",
    ]);
    expect(table(html, "Results")!.columns).toEqual(["slug"]);
  });

  // And the token is a body field too. Mutant `csrf-token-read-from-url` --
  // accepting `csrf_token` from the query string as well -- also survived,
  // and it is the same class of leak: the CSRF token would end up in every
  // access log line and every Referer header sent from this page, on the one
  // admin page where holding a valid token means holding a SQL prompt.
  it("is not a place a CSRF token can be submitted from", async () => {
    const before = snapshot();

    const { res, sql } = await request("POST", `/admin/query/?csrf_token=${CSRF_RAW}`, { query: "SELECT * FROM foodbank" }, { formToken: null });

    expect(res.status).toBe(403);
    expect(sql).toEqual([]);
    expect(snapshot()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// CSRF -- the double-submit check, through the real lib/csrf.ts
// ---------------------------------------------------------------------------

// Every case here asserts the same three things: 403, no statement prepared,
// and a byte-identical database. A refusal that happened AFTER the run would
// return the same 403.
describe("CSRF", () => {
  it("refuses a POST with no token field", async () => {
    const before = snapshot();

    const { res, html, sql } = await runQuery("SELECT * FROM foodbank", { formToken: null });

    expect(res.status).toBe(403);
    expect(html).toBe("Forbidden");
    expect(sql).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  it("refuses a POST whose token does not match the cookie", async () => {
    const { res, sql } = await runQuery("SELECT * FROM foodbank", { formToken: "b".repeat(64) });

    expect(res.status).toBe(403);
    expect(sql).toEqual([]);
  });

  it("refuses a POST with no CSRF cookie", async () => {
    const { res, sql } = await runQuery("SELECT * FROM foodbank", { cookie: null });

    expect(res.status).toBe(403);
    expect(sql).toEqual([]);
  });

  // An attacker who can set a cookie on a sibling subdomain can put any value
  // in `__Host-csrf` and the matching value in a form they control. The HMAC
  // is what stops that, and it is only load-bearing if an unsigned cookie is
  // actually rejected rather than merely compared against the field.
  it("refuses a cookie whose signature does not verify, even when the field matches it", async () => {
    const { res, sql } = await runQuery("SELECT * FROM foodbank", { cookie: `__Host-csrf=${CSRF_RAW}.${"0".repeat(64)}` });

    expect(res.status).toBe(403);
    expect(sql).toEqual([]);
  });

  it("refuses a cross-origin POST that carries a valid token", async () => {
    const { res, sql } = await runQuery("SELECT * FROM foodbank", { origin: "https://evil.example" });

    expect(res.status).toBe(403);
    expect(sql).toEqual([]);
  });

  it("refuses a cross-site POST that carries a valid token", async () => {
    const { res, sql } = await runQuery("SELECT * FROM foodbank", { secFetchSite: "cross-site" });

    expect(res.status).toBe(403);
    expect(sql).toEqual([]);
  });

  // lib/csrf.ts fails closed on an unset secret rather than skipping the
  // check -- the convention its own comment names. On this page a
  // fail-OPEN would turn a missing binding into an unauthenticated-by-CSRF
  // SQL endpoint, so it is worth pinning from the route.
  it("refuses everything when CSRF_SECRET is unset rather than waving it through", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const { res, sql } = await runQuery("SELECT * FROM foodbank", { noCsrfSecret: true });

    expect(res.status).toBe(403);
    expect(sql).toEqual([]);
  });

  // The other half: the refusals above are only meaningful if a correctly
  // formed submission is accepted. Without this, a handler that 403'd
  // unconditionally would pass every test in this block.
  it("accepts a same-origin POST with a matching signed token", async () => {
    const { res, sql } = await runQuery("SELECT slug FROM foodbank ORDER BY slug");

    expect(res.status).toBe(200);
    expect(sql).toHaveLength(2);
  });

  // THE ROUND TRIP, using only what a browser would actually have. Every test
  // above hands the request a token this file minted, which proves the check
  // rejects the wrong things but not that the console can be USED: if the
  // cookie issueCsrfToken sets and the field adminPageContext renders ever
  // stopped agreeing, every run would 403 and every one of the assertions
  // above would still pass. So this loads the page cold (no CSRF cookie at
  // all), takes the Set-Cookie and the hidden field exactly as a browser
  // would, and submits with them.
  it("issues a cookie and a field that work together on the very first visit", async () => {
    const page = await getConsole("/admin/query/", { cookie: null });
    const setCookie = page.res.headers.get("Set-Cookie");

    expect(setCookie).toContain("__Host-csrf=");
    // The signed cookie is `<raw>.<hmac>`; the form gets the raw half only,
    // so the HttpOnly cookie never has to be readable from script.
    const cookieValue = /__Host-csrf=([^;]+)/.exec(setCookie!)![1]!;
    expect(cookieValue.startsWith(`${formToken(page.html)}.`)).toBe(true);

    const run = await runQuery("SELECT slug FROM foodbank ORDER BY slug", {
      cookie: `__Host-csrf=${cookieValue}`,
      formToken: formToken(page.html),
    });

    expect(run.res.status).toBe(200);
    expect(table(run.html, "Results")!.rows).toEqual([["ayr"], ["brixton"], ["salisbury"]]);
  });
});

// ---------------------------------------------------------------------------
// The guard -- extractStatement, exercised through the route
// ---------------------------------------------------------------------------

// extractStatement is not exported, and testing it through the route is the
// stronger claim anyway: what matters is not that a helper returned null but
// that nothing reached the engine and nothing changed on disk. Each case
// below asserts the banner, an empty SQL log and an unchanged snapshot.
describe("the SELECT/EXPLAIN guard", () => {
  async function expectRefused(query: string): Promise<Fetched> {
    const before = snapshot();
    const fetched = await runQuery(query);

    // 200, not 400: this is a diagnostic tool and the rejection is rendered
    // in the page beside the admin's text, the same way a SQL error is.
    expect(fetched.res.status).toBe(200);
    expect(errorBanner(fetched.html)).toBe(GUARD_ERROR);
    expect(fetched.sql).toEqual([]);
    expect(snapshot()).toBe(before);
    // NO PANELS BESIDE THE BANNER. `ran` stays false on a rejection, which is
    // what keeps both panels off the page; mutant `guard-rejection-sets-ran`
    // (setting it beside the error, the sort of thing a "always show the
    // plan" edit does) survived everything else in this file. It renders an
    // empty "Query plan" and an empty "Results: No rows." above a refusal --
    // a page that says both "this was refused" and "this returned nothing",
    // and the maintainer has no way to tell which one is true.
    expect(headings(fetched.html)).toEqual(["Query console"]);
    expect(fetched.html).not.toContain("No rows.");
    // Nothing was refused AFTER a session was opened, either -- query.ts only
    // reaches dbSession() past the guard.
    expect(fetched.sessionModes).toEqual([]);
    return fetched;
  }

  // PLAN.md §8.13.1: "Rejects anything not beginning with SELECT or EXPLAIN."
  // The four verbs below are the ones the build note records as verified by
  // hand, and each is a different kind of loss -- rows, a column's contents,
  // a whole table, and a connection-level setting.
  it.each(["DELETE FROM foodbank", "UPDATE foodbank SET name = 'x'", "DROP TABLE foodbank", "INSERT INTO foodbank (id) VALUES (99)"])(
    "refuses %s without preparing it",
    async (query) => {
      await expectRefused(query);
      // Belt and braces on the two that would be visible: the rows are still
      // there and so is the table.
      expect(db.prepare("SELECT count(*) AS c FROM foodbank").get()).toEqual({ c: 3 });
    },
  );

  it.each(["PRAGMA table_info('foodbank')", "ALTER TABLE foodbank ADD COLUMN x TEXT", "CREATE TABLE evil (id INTEGER)", "VACUUM", "ATTACH DATABASE ':memory:' AS other"])(
    "refuses %s",
    async (query) => {
      await expectRefused(query);
    },
  );

  // The one addition beyond PLAN.md's own sketch (recorded at PLAN.md:10851):
  // "rejects a semicolon anywhere before the trimmed end (blocks
  // statement-stacking, e.g. `SELECT 1; DROP TABLE foodbank`)". The example
  // from the note verbatim, because it is the one where the FIRST statement
  // is legitimate -- a guard that only inspected the prefix would pass this,
  // and D1 executing only the first statement is defence this port chose not
  // to rely on.
  it("refuses a stacked statement even when the first half is a valid SELECT", async () => {
    await expectRefused("SELECT 1; DROP TABLE foodbank");
    expect(db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE name = 'foodbank'").get()).toEqual({ c: 1 });
  });

  it("refuses a second statement even when both halves are SELECTs", async () => {
    await expectRefused("SELECT 1; SELECT 2");
  });

  // The trailing-semicolon strip runs BEFORE the stacking check, so the
  // habitual `SELECT ...;` a psql user types is accepted rather than read as
  // stacking. If the two were ordered the other way round every copy-pasted
  // statement in the world would be refused, and the console would be useless
  // for the workflow it exists to replace.
  it("accepts a single trailing semicolon, and any run of them", async () => {
    const one = await runQuery("SELECT slug FROM foodbank ORDER BY slug;");
    expect(errorBanner(one.html)).toBeNull();
    // Stripped before the statement was built, not passed through to SQLite.
    expect(one.sql[0]).toBe("EXPLAIN QUERY PLAN SELECT slug FROM foodbank ORDER BY slug");

    // Note the surviving space before the stripped semicolons: the trim runs
    // BEFORE the strip and is not repeated after it, so `SELECT 1 ;;` becomes
    // `SELECT 1 ` and goes to the engine with the trailing space on. Harmless
    // to SQLite, and pinned so that tightening it later is a deliberate
    // change rather than a surprise in a SQL-log assertion.
    const several = await runQuery("SELECT 1 ;;  ");
    expect(errorBanner(several.html)).toBeNull();
    expect(several.sql[0]).toBe("EXPLAIN QUERY PLAN SELECT 1 ");
  });

  it.each(["", "   ", "\n\t ", ";", ";;"])("refuses %o as empty", async (query) => {
    const before = snapshot();
    const { res, html, sql } = await runQuery(query);

    expect(res.status).toBe(200);
    expect(errorBanner(html)).toBe(GUARD_ERROR);
    expect(sql).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  // A missing `query` field (a form posted by something other than this page)
  // must take the same path as an empty one rather than throwing on
  // undefined -- query.ts:47 coerces it to "" for exactly this reason.
  it("refuses a POST with no query field at all rather than 500ing", async () => {
    const { res, html, sql } = await request("POST", "/admin/query/", {});

    expect(res.status).toBe(200);
    expect(errorBanner(html)).toBe(GUARD_ERROR);
    expect(sql).toEqual([]);
    expect(headings(html)).toEqual(["Query console"]);
  });

  it("accepts leading whitespace and newlines, which is how a pasted query arrives", async () => {
    const { html, sql } = await runQuery("\n\n   SELECT slug FROM foodbank ORDER BY slug\n");

    expect(errorBanner(html)).toBeNull();
    expect(sql[0]).toBe("EXPLAIN QUERY PLAN SELECT slug FROM foodbank ORDER BY slug");
  });

  it("is case-insensitive about the keyword", async () => {
    const lower = await runQuery("select slug from foodbank order by slug");
    expect(errorBanner(lower.html)).toBeNull();

    const mixed = await runQuery("SeLeCt slug FROM foodbank");
    expect(errorBanner(mixed.html)).toBeNull();
  });

  // The `\b` in the prefix test. Without it, any verb beginning with those
  // letters is accepted and handed to the engine -- and while SQLite has no
  // statement called SELECTOR today, the guard's job is to be a whitelist,
  // not a spell-check.
  it.each(["SELECTOR 1", "SELECT_ALL 1", "EXPLAINING 1"])("refuses %s, which only starts with the keyword's letters", async (query) => {
    await expectRefused(query);
  });

  // A leading SQL comment is the natural way to label a saved diagnostic
  // query, and it is refused: the check is on the first non-whitespace
  // characters, not on the first keyword. Pinned as CURRENT BEHAVIOUR and
  // flagged as suspect rather than asserted as desirable -- see this file's
  // closing note.
  it("refuses a statement behind a leading SQL comment (suspect: a labelled query is a normal thing to paste)", async () => {
    await expectRefused("-- open food banks in Wiltshire\nSELECT * FROM foodbank");
    await expectRefused("/* nightly check */ SELECT * FROM foodbank");
  });

  // Likewise a CTE. `WITH x AS (...) SELECT ...` is read-only by
  // construction and is the natural spelling of exactly the "40-line
  // diagnostic query" PLAN.md:12216 names as the thing being lost with psql,
  // and this guard refuses all of them. Current behaviour, pinned.
  it("refuses a read-only CTE (suspect: WITH ... SELECT cannot write, and is the shape of a real diagnostic query)", async () => {
    await expectRefused("WITH open AS (SELECT * FROM foodbank WHERE is_closed = 0) SELECT count(*) FROM open");
  });

  // A semicolon inside a string literal is not statement-stacking, but the
  // check is textual and cannot tell the difference. This fails SAFE -- a
  // legitimate query is refused, nothing runs -- so it is pinned as
  // behaviour, with the note that the refusal is a false one.
  it("refuses a semicolon inside a string literal (suspect: a false positive, but it fails closed)", async () => {
    await expectRefused("SELECT name FROM foodbank WHERE name = 'A;B'");
  });
});

// ---------------------------------------------------------------------------
// EXPLAIN -- the plan-only path
// ---------------------------------------------------------------------------

describe("EXPLAIN input", () => {
  // PLAN.md:10851: "EXPLAIN-prefixed input is run as-is with only the plan
  // section shown (no results, no LIMIT -- a plan has no row cap to speak
  // of)". Both halves asserted: one statement prepared, and it is the
  // admin's own text with nothing wrapped round it.
  it("runs the admin's statement verbatim and prepares nothing else", async () => {
    const { res, sql } = await runQuery("EXPLAIN QUERY PLAN SELECT * FROM foodbank WHERE slug = 'salisbury'");

    expect(res.status).toBe(200);
    expect(sql).toEqual(["EXPLAIN QUERY PLAN SELECT * FROM foodbank WHERE slug = 'salisbury'"]);
  });

  // The plan is the point of the page's third bullet ("so a SCAN is
  // visible"), so the actual plan rows have to reach the table -- a panel
  // rendered with the right heading and no rows would look like a working
  // console and answer nothing. foodbank_slug_uniq is in the fixture schema
  // precisely so this says SEARCH rather than SCAN.
  it("renders the plan rows in the Query plan panel", async () => {
    const { html } = await runQuery("EXPLAIN QUERY PLAN SELECT * FROM foodbank WHERE slug = 'salisbury'");

    const plan = table(html, "Query plan")!;
    expect(plan.columns).toEqual(["id", "parent", "notused", "detail"]);
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]![3]).toContain("SEARCH foodbank USING INDEX foodbank_slug_uniq");
  });

  // `show_results` is a separate flag from `ran` for this: an EXPLAIN has no
  // result set, and the Results panel must be absent rather than present and
  // empty. The complement -- a SELECT that legitimately matched nothing --
  // is asserted in the SELECT block below, and the pair is what makes the
  // flag meaningful.
  it("shows no Results panel at all", async () => {
    const { html } = await runQuery("EXPLAIN QUERY PLAN SELECT * FROM foodbank");

    expect(headings(html)).toEqual(["Query console", "Query plan"]);
    expect(html).not.toContain("Results");
  });

  // A bare EXPLAIN (the VDBE program, not the query plan) takes the same
  // branch. Worth its own case because `/^EXPLAIN\b/i` is what routes it, and
  // a check written against the longer "EXPLAIN QUERY PLAN" string would send
  // this down the SELECT path instead -- where it would be wrapped as
  // `SELECT * FROM (EXPLAIN ...)`, which is not valid SQL, and the console
  // would answer a legitimate question with a syntax error.
  it("runs a bare EXPLAIN as a plan too, not as a wrapped SELECT", async () => {
    const { html, sql } = await runQuery("EXPLAIN SELECT * FROM foodbank");

    expect(sql).toEqual(["EXPLAIN SELECT * FROM foodbank"]);
    expect(errorBanner(html)).toBeNull();
    // The opcode listing, not a query plan -- different columns entirely.
    expect(table(html, "Query plan")!.columns).toEqual(["addr", "opcode", "p1", "p2", "p3", "p4", "p5", "comment"]);
  });

  it("is case-insensitive, so a lowercase explain is not sent down the SELECT path", async () => {
    const { sql } = await runQuery("explain query plan select * from foodbank");

    expect(sql).toEqual(["explain query plan select * from foodbank"]);
  });

  // THE HOLE THE GUARD LEAVES, AND WHY IT IS NOT A BREACH. `^(SELECT|EXPLAIN)`
  // accepts `EXPLAIN DELETE FROM foodbank` -- the prefix is EXPLAIN, so the
  // guard is satisfied -- and query.ts hands it straight to the engine
  // unwrapped. SQLite never EXECUTES an explained statement; it compiles it
  // and dumps the bytecode. So the page's read-only promise survives, but it
  // survives because of SQLite's semantics rather than because of the guard,
  // and that is worth a test rather than a comment: if a future engine (or a
  // D1 shim) ever ran the inner statement, this is the only place it would
  // show up before a table went missing in production.
  it("compiles but does not execute an explained write", async () => {
    const before = snapshot();

    const deletion = await runQuery("EXPLAIN DELETE FROM foodbank");
    expect(deletion.res.status).toBe(200);
    expect(errorBanner(deletion.html)).toBeNull();
    expect(db.prepare("SELECT count(*) AS c FROM foodbank").get()).toEqual({ c: 3 });

    const drop = await runQuery("EXPLAIN QUERY PLAN DROP TABLE foodbank");
    expect(drop.res.status).toBe(200);

    expect(snapshot()).toBe(before);
  });

  // The plan of a broken statement is still a compile, so it still throws --
  // and it has to land in the banner, not the 500 page, exactly like the
  // SELECT path's errors.
  it("reports a compile error from an EXPLAIN in the banner", async () => {
    const { res, html } = await runQuery("EXPLAIN QUERY PLAN SELECT * FROM nosuchtable");

    expect(res.status).toBe(200);
    expect(errorBanner(html)).toContain("no such table: nosuchtable");
    expect(headings(html)).toEqual(["Query console"]);
  });
});

// ---------------------------------------------------------------------------
// SELECT -- the plan-then-results path
// ---------------------------------------------------------------------------

describe("SELECT input", () => {
  // THE WRAP, ASSERTED AS TEXT. PLAN.md:10851 is specific about the shape --
  // `SELECT * FROM (<query>) LIMIT ?` with 500 "**bound**, not interpolated"
  // -- and about the order (plan first). Reading it out of the SQL log rather
  // than inferring it from the rows means an interpolated limit, a dropped
  // wrap, or a plan run against something other than the admin's own text is
  // caught here rather than in whichever later test happens to notice a row
  // count.
  it("runs the plan first, then the admin's query wrapped in a bound LIMIT", async () => {
    const { sql } = await runQuery("SELECT name FROM foodbank WHERE is_closed = 0");

    expect(sql).toEqual([
      "EXPLAIN QUERY PLAN SELECT name FROM foodbank WHERE is_closed = 0",
      "SELECT * FROM (SELECT name FROM foodbank WHERE is_closed = 0) LIMIT ?",
    ]);
    // The cap is a placeholder in the text, so it cannot be the string 500.
    expect(sql[1]).not.toContain("500");
  });

  // WHAT THE STATEMENTS WERE ACTUALLY RUN WITH -- the assertion above reads
  // the prepared TEXT, and `LIMIT ?` is the same text whatever is bound to
  // it. That is not a hypothetical gap: mutants `cap-bind-overfetch-by-100`
  // and `cap-bind-huge` (`.bind(RESULT_LIMIT + 1)` -> `.bind(1000000)`) left
  // all 80 of the tests that predate this one green, because every rendered
  // page is identical -- the extra rows are sliced away before the template
  // ever sees them. The console would fetch the whole of foodbankchange out
  // of D1 on every run to display 500 rows of it: the exact cost the cap
  // exists to avoid, on a Worker with a 128MB heap and a per-row-read bill.
  //
  // 501 and not 500, because the 501st row is the ONLY evidence there was
  // more to come; the plan carries no bound values at all.
  it("binds exactly one row more than the cap, and binds nothing to the plan", async () => {
    const { executed } = await runQuery("SELECT name FROM foodbank WHERE is_closed = 0");

    expect(executed).toEqual([
      { sql: "EXPLAIN QUERY PLAN SELECT name FROM foodbank WHERE is_closed = 0", params: [] },
      { sql: "SELECT * FROM (SELECT name FROM foodbank WHERE is_closed = 0) LIMIT ?", params: [501] },
    ]);
  });

  // PLAN.md §3.3: every query goes through a D1 Session, never a bare
  // env.DB.prepare(), because this database has read replication enabled --
  // and lib/session.ts opens it "first-unconstrained", which is what lets a
  // read-only page be answered by a replica. Pinned because nothing else in
  // this file can see it: `dbsession-mode-primary` survived, and a console
  // pinned to the primary is a page that adds load to the write instance
  // every time the maintainer presses Run.
  it("reads through an unconstrained D1 session, opened once", async () => {
    const { sessionModes } = await runQuery("SELECT name FROM foodbank");

    expect(sessionModes).toEqual(["first-unconstrained"]);
  });

  it("renders the plan above the results, both populated", async () => {
    const { res, html } = await runQuery("SELECT slug, postcode FROM foodbank ORDER BY slug");

    expect(res.status).toBe(200);
    // PLAN.md §8.13.1: "Shows EXPLAIN QUERY PLAN above the results, so a SCAN
    // is visible." Order, not just presence.
    expect(headings(html)).toEqual(["Query console", "Query plan", "Results"]);
    expect(table(html, "Query plan")!.rows[0]![3]).toContain("SCAN foodbank");
  });

  // The rows, the columns and the order all the way through the wrap. Every
  // cell is compared rather than sampled: a column dropped between the query
  // and the table is a blank cell, never an error, because env.ts pins
  // throwOnUndefined false to match Django.
  it("renders every column and row of the result set", async () => {
    const { html } = await runQuery("SELECT slug, postcode, network FROM foodbank ORDER BY slug");

    expect(table(html, "Results")).toEqual({
      columns: ["slug", "postcode", "network"],
      rows: [
        ["ayr", "KA8 8DL", ""],
        ["brixton", "SW2 5SG", "Independent"],
        ["salisbury", "SP2 7QQ", "Trussell Trust"],
      ],
    });
  });

  // PLAN.md:10851: "the wrapping subquery also means an admin-supplied
  // ORDER BY / LIMIT inside their own query still works exactly as they wrote
  // it, since the cap only clips the outer result set". SQLite does not
  // formally guarantee that a subquery's ORDER BY survives flattening, so
  // this is the claim being executed rather than reasoned about -- if it ever
  // stopped holding, the console would silently reorder results and the
  // maintainer would have no way to tell.
  it("preserves the admin's own ORDER BY through the wrap", async () => {
    // Ordered by a column the query does not even SELECT, and descending, so
    // the expected order matches neither insertion order (salisbury, brixton,
    // ayr) nor the slug order every other test here uses. A wrap that lost
    // the ORDER BY would fall back to one of those and look plausible.
    const { html } = await runQuery("SELECT slug FROM foodbank ORDER BY postcode DESC");

    expect(table(html, "Results")!.rows).toEqual([["brixton"], ["salisbury"], ["ayr"]]);
  });

  it("preserves the admin's own LIMIT through the wrap", async () => {
    const { html } = await runQuery("SELECT slug FROM foodbank ORDER BY slug LIMIT 2");

    expect(table(html, "Results")!.rows).toEqual([["ayr"], ["brixton"]]);
  });

  // THE COMPLEMENT TO THE EXPLAIN CASE, and the reason `show_results` is a
  // flag rather than a row count. A SELECT that matched nothing is a real
  // answer -- "no food bank has that postcode" -- and it must render a
  // Results panel saying so. Collapsing it into "no panel" would make a
  // successful query indistinguishable from one that never ran, which is the
  // accident PLAN.md:10851 records as deliberately avoided.
  it("renders a Results panel saying No rows for a query that matched nothing", async () => {
    const { html } = await runQuery("SELECT slug FROM foodbank WHERE postcode = 'ZZ99 9ZZ'");

    expect(headings(html)).toEqual(["Query console", "Query plan", "Results"]);
    expect(panels(html)["Results"]).toContain("No rows.");
    expect(table(html, "Results")).toBeNull();
    expect(errorBanner(html)).toBeNull();
  });

  // NULL is a first-class answer here -- "which food banks have no network"
  // is a real question -- and the template prints it as an empty cell. Pinned
  // so that a future `| default("-")` or a JSON round-trip that turned it into
  // the string "null" is a visible change rather than a quiet one.
  it("renders a NULL as an empty cell, not as the word null", async () => {
    const { html } = await runQuery("SELECT network FROM foodbank WHERE slug = 'ayr'");

    expect(table(html, "Results")!.rows).toEqual([[""]]);
  });

  // The console is a read tool, and a read tool that writes is the worst
  // possible bug in it. The whole database, schema included, either side of a
  // perfectly ordinary successful run.
  it("changes nothing when a SELECT succeeds", async () => {
    const before = snapshot();

    await runQuery("SELECT * FROM foodbank");

    expect(snapshot()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// The 500-row cap
// ---------------------------------------------------------------------------

// The cap is fetched as RESULT_LIMIT + 1 and compared with `>`, which is two
// off-by-one opportunities in three lines. Both sides of the boundary are
// exercised with rows that exist for no other reason, because a cap tested
// only from far below it passes with any comparison at all.
describe("the 500-row cap", () => {
  function seedNeeds(count: number): void {
    const insert = db.prepare("INSERT INTO foodbankchange (id, need_id, foodbank_id, published) VALUES (?, ?, 1, 1)");
    // id 1 is already seeded by the outer beforeEach.
    for (let i = 2; i <= count + 1; i++) insert.run(i, `need-${i}`);
  }

  it("does not warn, and shows everything, at exactly 500 rows", async () => {
    seedNeeds(499);
    expect(db.prepare("SELECT count(*) AS c FROM foodbankchange").get()).toEqual({ c: 500 });

    const { html } = await runQuery("SELECT id FROM foodbankchange ORDER BY id");

    expect(headingStartingWith(html, "Results")).toBe("Results");
    const rows = table(html, "Results")!.rows;
    expect(rows).toHaveLength(500);
    expect(rows[499]).toEqual(["500"]);
  });

  // One row past the cap: the 501st is fetched (that is what the +1 is for),
  // recognised as an overflow, and then discarded. A `>=` in the comparison
  // would warn on the exact-500 case above; a missing `slice` would render
  // 501 rows under a heading claiming 500.
  it("warns and clips to 500 at 501 rows", async () => {
    seedNeeds(500);
    expect(db.prepare("SELECT count(*) AS c FROM foodbankchange").get()).toEqual({ c: 501 });

    const { html } = await runQuery("SELECT id FROM foodbankchange ORDER BY id");

    expect(headingStartingWith(html, "Results")).toBe("Results (truncated at 500 rows)");
    const rows = table(html, "Results")!.rows;
    expect(rows).toHaveLength(500);
    // Clipped from the END, so the first 500 are the ones shown.
    expect(rows[0]).toEqual(["1"]);
    expect(rows[499]).toEqual(["500"]);
  });

  // Far past the cap, so that a `slice` that clipped to the fetched 501
  // rather than to RESULT_LIMIT is also caught.
  it("clips to 500 well past the boundary", async () => {
    seedNeeds(999);

    const { html } = await runQuery("SELECT id FROM foodbankchange ORDER BY id");

    expect(headingStartingWith(html, "Results")).toBe("Results (truncated at 500 rows)");
    expect(table(html, "Results")!.rows).toHaveLength(500);
  });

  // The admin's own LIMIT is inside the subquery, so the outer cap only ever
  // clips what is left. A wrap that put the cap on the inside would silently
  // ignore a `LIMIT 600` and report a truncation that was really the admin's
  // own instruction.
  it("does not warn when the admin's own smaller LIMIT already fits", async () => {
    seedNeeds(999);

    const { html } = await runQuery("SELECT id FROM foodbankchange ORDER BY id LIMIT 10");

    expect(headingStartingWith(html, "Results")).toBe("Results");
    expect(table(html, "Results")!.rows).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// Errors, and not losing the admin's typing
// ---------------------------------------------------------------------------

// The failure mode issue #12 is about, in this page's dialect: the admin
// pastes forty lines of SQL, gets one table name wrong, and the page comes
// back empty. PLAN.md:10851 is explicit that D1 errors are "caught and shown
// verbatim in the page ... the direct equivalent of a psql error at the
// prompt", which means the prompt has to still have the query in it.
describe("errors", () => {
  it("shows a missing table in the banner rather than on the 500 page", async () => {
    const { res, html } = await runQuery("SELECT * FROM nosuchtable");

    expect(res.status).toBe(200);
    expect(html).not.toContain("five hundred");
    expect(errorBanner(html)).toContain("no such table: nosuchtable");
  });

  it("shows a syntax error in the banner", async () => {
    const { res, html } = await runQuery("SELECT FROM WHERE");

    expect(res.status).toBe(200);
    expect(errorBanner(html)).toContain("syntax error");
  });

  it("shows a bad column name in the banner", async () => {
    const { html } = await runQuery("SELECT nosuchcolumn FROM foodbank");

    expect(errorBanner(html)).toContain("no such column: nosuchcolumn");
  });

  // `ran` is only set after BOTH statements come back, so a query whose plan
  // compiled but whose execution failed shows no half-built plan panel above
  // the error. A partially-rendered page here would read as "it worked, and
  // separately something went wrong".
  it("renders no plan or results panel beside the error", async () => {
    const { html } = await runQuery("SELECT * FROM nosuchtable");

    expect(headings(html)).toEqual(["Query console"]);
  });

  // THE ONE THAT MATTERS. Every failure path -- guard rejection and engine
  // error alike -- re-renders the form with the admin's own text still in the
  // textarea, because `query` is assigned before parsing and passed to the
  // template on every branch.
  it.each([
    ["a rejected verb", "DELETE FROM foodbank WHERE slug = 'salisbury'"],
    ["a stacked statement", "SELECT 1; DROP TABLE foodbank"],
    ["a missing table", "SELECT slug, postcode FROM nosuchtable ORDER BY slug"],
    ["a syntax error", "SELECT FROM WHERE"],
  ])("gives the admin back their query after %s", async (_label, query) => {
    const { html } = await runQuery(query);

    expect(textareaText(html)).toBe(query);
    // Still the form, not an error page: without the token there is nothing
    // to correct the query and re-submit from.
    expect(html).toContain('name="csrf_token"');
    expect(html).toContain(">Run</button>");
  });

  // Multi-line SQL is the normal case for the "40-line diagnostic query"
  // this page exists to make possible, and a textarea round-trip is where
  // newlines get eaten. Pinned with the leading indentation intact.
  it("gives back a multi-line query with its newlines and indentation", async () => {
    const query = "SELECT slug,\n       postcode\n  FROM nosuchtable\n ORDER BY slug";

    const { html } = await runQuery(query);

    expect(textareaText(html)).toBe(query);
  });

  // A successful run keeps the query too -- otherwise every iteration on a
  // query means retyping it, which is the workflow this replaces.
  it("gives back the query after a successful run", async () => {
    const query = "SELECT slug FROM foodbank ORDER BY slug";

    const { html } = await runQuery(query);

    expect(textareaText(html)).toBe(query);
  });

  // WHAT COMES BACK IS WHAT WAS TYPED, NOT WHAT WAS PARSED. query.ts assigns
  // `query` from the body BEFORE extractStatement() touches it, so the
  // trailing semicolon a psql user types and the leading newlines a pasted
  // query arrives with are still there on the next render. Mutant
  // `textarea-gets-the-parsed-statement` (echoing the trimmed, semicolon-
  // stripped statement instead) survived every round-trip test above,
  // because all of them use queries the parser would not have altered.
  //
  // It matters for the same reason issue #12 mattered: the admin edits the
  // box and presses Run again. A console that quietly rewrites their text
  // between attempts means the thing they are debugging is not the thing
  // they are looking at -- and the semicolon it eats is the one they would
  // paste back into a psql session to compare.
  it.each([
    ["a trailing semicolon", "SELECT slug FROM foodbank ORDER BY slug;"],
    ["leading newlines and indentation", "\n\n    SELECT slug\n      FROM foodbank"],
    ["trailing whitespace after the semicolon", "SELECT slug FROM foodbank ;  "],
  ])("gives back %s exactly as typed, not as parsed", async (_label, query) => {
    const { html } = await runQuery(query);

    expect(errorBanner(html)).toBeNull();
    expect(textareaText(html)).toBe(query);
  });

  // A user-supplied `?` ends up sharing the statement with the cap's own
  // placeholder, and the single bound value goes to the wrong one. It errors
  // rather than silently binding 501 into the admin's predicate, which is the
  // outcome that matters -- pinned on the substring, not the message, because
  // SQLite's wording here differs from D1's. Suspect: the console has no way
  // to supply parameters at all, so this is a dead end rather than a bug, but
  // the error the admin sees says nothing about why.
  it("errors rather than misbinding when the admin's own query contains a placeholder", async () => {
    const { res, html } = await runQuery("SELECT * FROM foodbank WHERE id = ?");

    expect(res.status).toBe(200);
    expect(errorBanner(html)).not.toBeNull();
    expect(headings(html)).toEqual(["Query console"]);
  });
});

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

// This page renders two things that are attacker-influenced in a way no other
// admin page's are: the admin's own text, and arbitrary column values pulled
// from rows that ultimately came from food bank websites, scrapes and public
// form submissions. crawlSets.test.ts already notes the sibling hazard -- a
// `| safe` migrating onto the wrong variable turns stored text into script in
// the admin's own browser. Here it would run in a page that can query the
// whole database.
describe("escaping", () => {
  it("escapes the admin's own query on the way back into the textarea", async () => {
    const { html } = await runQuery("SELECT * FROM nosuchtable -- </textarea><script>alert(1)</script>");

    expect(html).not.toContain("<script>alert(1)</script>");
    // The closing tag is escaped too, so the textarea cannot be broken out of.
    expect(html).not.toContain("</textarea><script>");
    expect(textareaValue(html)).toContain("&lt;script&gt;");
  });

  it("escapes a value that came out of the database", async () => {
    seedFoodbank(4, "<script>alert(1)</script>", "xss", "SW1A 1AA", null);

    const { html } = await runQuery("SELECT name FROM foodbank WHERE slug = 'xss'");

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(table(html, "Results")!.rows).toEqual([["&lt;script&gt;alert(1)&lt;/script&gt;"]]);
  });

  it("escapes a column NAME that came out of the database", async () => {
    // rowsToColumns feeds Object.keys(row) into <th>, and a column name is
    // just as much admin-supplied text as the values are.
    const { html } = await runQuery("SELECT slug AS \"<b>x</b>\" FROM foodbank WHERE slug = 'ayr'");

    expect(html).not.toContain("<th><b>x</b></th>");
    expect(table(html, "Results")!.columns).toEqual(["&lt;b&gt;x&lt;/b&gt;"]);
  });

  it("escapes the engine's error message", async () => {
    const { html } = await runQuery("SELECT * FROM \"<script>alert(1)</script>\"");

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(errorBanner(html)).toContain("no such table: <script>alert(1)</script>");
  });
});

// ---------------------------------------------------------------------------
// Page chrome
// ---------------------------------------------------------------------------

describe("the page itself", () => {
  // adminPageContext is called with "settings", which is what lights the
  // Settings item in admin/page.njk's navbar (:50) -- the console is reached
  // from settings.njk:63 and nowhere else, so a section that drifted would
  // leave the admin with no lit nav item on the page they just navigated to.
  it("lights the Settings nav item on both GET and POST", async () => {
    const get = await getConsole();
    expect(get.html).toContain('<a class="navbar-item is-active" href="/admin/settings/">Settings</a>');

    const post = await runQuery("SELECT 1");
    expect(post.html).toContain('<a class="navbar-item is-active" href="/admin/settings/">Settings</a>');
  });

  it("titles itself the same on both", async () => {
    const get = await getConsole();
    const post = await runQuery("SELECT 1");

    expect(headings(get.html)[0]).toBe("Query console");
    expect(headings(post.html)[0]).toBe("Query console");
  });

  // IT IS SERVED AS HTML. Every other assertion in this file reads
  // res.text() and parses the markup out of it, which is exactly as happy
  // with `text/plain` as with `text/html` -- mutant
  // `response-sent-as-text-not-html` (c.html(html) -> c.text(html), a
  // one-word slip, and the shape of every other handler's error return in
  // this directory) survived all 80. The admin would get the page source
  // printed at them as text: no form, no textarea, no way to run anything.
  //
  // Asserted on all three render paths because they are three separate
  // returns' worth of opportunity, and on the CSRF refusal too -- that one is
  // deliberately NOT html, and pinning it stops the pair being "fixed" the
  // wrong way round.
  it("serves the console as HTML on every path that renders it", async () => {
    const get = await getConsole();
    const ok = await runQuery("SELECT slug FROM foodbank");
    const refused = await runQuery("DELETE FROM foodbank");
    const failed = await runQuery("SELECT * FROM nosuchtable");

    for (const { res } of [get, ok, refused, failed]) {
      expect(res.headers.get("Content-Type")).toContain("text/html");
    }

    const forbidden = await runQuery("SELECT slug FROM foodbank", { formToken: null });
    expect(forbidden.res.headers.get("Content-Type")).toContain("text/plain");
  });
});

// ---------------------------------------------------------------------------
// SUSPECT, PINNED ABOVE AS CURRENT BEHAVIOUR -- see this file's individual
// tests for each. None is fixed here, per the convention in TESTING.md that a
// failing test is always a regression and never a wishlist item:
//
//   1. rowsToColumns() derives the header row from Object.keys(rows[0]) --
//      the FIRST row only, and via an object. Two columns with the same name
//      (`SELECT f.name, l.name FROM ...`, which is how a join is usually
//      typed) collapse into one key, so a column silently disappears from
//      the table with no warning anywhere. Not asserted here because the
//      collision is resolved by the driver, not by query.ts, and node:sqlite
//      and D1 resolve it differently -- a test would pin this fixture rather
//      than the handler.
//   2. A leading SQL comment, and any CTE, are refused (tested above). Both
//      are read-only and both are the natural spelling of the diagnostic
//      queries PLAN.md:12216 names as the capability being replaced.
//   3. A semicolon inside a string literal is read as statement-stacking
//      (tested above). Fails closed, so it costs a legitimate query rather
//      than allowing an illegitimate one.
//   4. `EXPLAIN <any statement>` passes the guard (tested above). Harmless
//      only because SQLite compiles rather than executes an explained
//      statement -- the read-only promise rests on the engine here, not on
//      the guard.
//   5. A CSRF failure returns a bare `text/plain` "Forbidden" and discards
//      whatever the admin had typed -- unlike every other rejection path on
//      this page, which re-renders the form with the query still in it. The
//      __Host-csrf cookie carries no Max-Age, so it is a session cookie that
//      dies with the browser while the 12h admin session in KV lives on: a
//      console tab restored after a browser restart still shows the form,
//      still passes the auth gate, and loses the query on the first Run.
//      Worth noting because this is the one page where the discarded input
//      is not a form the admin can retype from memory.
// ---------------------------------------------------------------------------
//
// MUTATION-TESTED (65 mutants, in a copy of the repo outside it). The seven
// that survived the first pass are each named in the comment of the test
// added to kill it: cap-bind-overfetch-by-100 and cap-bind-huge (the cap's
// bound VALUE, invisible in the prepared text), get-runs-a-url-supplied-query
// and post-body-query-ignored-url-used (a `?query=` reaching the POST branch),
// csrf-token-read-from-url, response-sent-as-text-not-html (Content-Type),
// guard-rejection-sets-ran (empty panels above a refusal),
// dbsession-mode-primary (the read-replica session mode) and
// textarea-gets-the-parsed-statement (the echo losing the admin's own
// semicolon). Route registration was mutated too: removing either the GET or
// the POST binding, dropping the trailing slash, and removing
// adminApp.use("*", requireAdminAuth) are all caught here.
//
// Three mutants survive and are EQUIVALENT rather than uncaught -- no test
// can distinguish them, so none was contrived:
//   * deleting `if (!statement) return null` -- an empty string fails the
//     SELECT/EXPLAIN prefix test on the next line and is refused anyway;
//   * deriving the column headers from the LAST row instead of the first --
//     every row of a SQL result set carries the same keys, and both spellings
//     yield [] for an empty one;
//   * `String(body.csrf_token)` in place of the typeof guard -- no non-string
//     value can stringify to the 64-hex token in the cookie, so it still 403s.
// ---------------------------------------------------------------------------
