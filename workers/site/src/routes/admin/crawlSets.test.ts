import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../../types";
import { adminApp } from "./index";
import { adminCrawlSetDetail } from "./crawlSets";

// gfadmin/views.py:3228-3280 crawl_sets() / crawl_set() -- the two pages behind
// the admin navbar's "Crawls" item, and the only place an admin can see whether
// last night's sweep ran, how long it took, and which food banks it touched.
//
// BOTH HANDLERS ARE READ-ONLY, which changes what "a bug" looks like but not how
// bad one is. Issue #34's shape -- a value parsed, threaded through the handler,
// and then used by no SQL at all, redirecting as though it had worked -- has an
// exact read-side twin here: TWO INDEPENDENT FILTERS, `?type=` for the crawl
// sets and `?adhoc_type=` for the ad-hoc list, parsed by the same function,
// carried side by side, and handed to two different queries. Pass the wrong one
// to either query, or drop one from the template context, and the page still
// renders, still returns 200, still shows a populated table, and answers a
// question the admin did not ask. Nothing throws and nothing logs. So the
// filter tests below all seed rows that MUST BE EXCLUDED and rows the OTHER
// list must keep -- a filter that did nothing, or that filtered both lists,
// passes any test written only from rows it is supposed to show.
//
// REAL ROUTER, REAL AUTH, REAL TEMPLATES, REAL SQLITE. The app under test is
// `adminApp` itself, mounted at /admin exactly as workers/site/src/index.ts:637
// mounts it, so these tests go through the real route registrations (including
// the `:id{[0-9]+}` constraint that is the detail page's actual id validation --
// see the "1e3" test below for what the handler's own guard does and does not
// catch) and through the real requireAdminAuth middleware. Only the three
// bindings are faked: D1 is node:sqlite behind the D1 Sessions surface,
// SESSIONS is a Map, and nothing else is touched -- these pages send no mail,
// enqueue nothing and call no external API, so there is nothing else to mock.
// packages/db/src/crawlSets.test.ts already proves the SQL selects the right
// rows; this file proves the HANDLER asks for the right rows and that every
// column it asks for survives the trip into the HTML the admin actually reads.
//
// MUTATION-TESTED (TESTING.md's convention: the evidence a test is
// load-bearing rather than decoration). 96 mutants were injected into
// crawlSets.ts, packages/db's crawlSets.ts and foodbankTabs.ts,
// middleware/adminAuth.ts and routes/admin/index.ts -- rewritten at transform
// time by a vite plugin in a scratchpad config, so no repo file was ever
// edited -- covering every class this tier hunts: the two filters crossed,
// each filter reaching no query at all (#34's read-side shape), each
// validation branch deleted, each context key dropped, bind parameters
// swapped, LIMITs and ORDER BYs removed, columns transposed, the auth gate
// unmounted, redirect targets and status codes changed, and the route
// registrations loosened.
//
// NINE SURVIVED THE FIRST PASS and each is now killed by a test that names
// it. They are recorded here because they are what this file was missing, not
// because they are interesting individually:
//   * `adminApp.get` -> `adminApp.all` on either route: a POST rendered the
//     whole admin page, and nothing in the suite ever used a method but GET.
//   * the detail handler's `Number.isInteger` guard deleted, and the same
//     guard weakened to `Number.isNaN`: invisible behind the route's own
//     `{[0-9]+}`, so only the unconstrained probe mount can see them.
//   * the 50-row cap applied BEFORE the type filter, in either list: every
//     filter test seeded two rows, so none could see a cap-vs-filter ordering.
//   * either query falling back to the unfiltered list when the filter matched
//     nothing: every filter test seeded rows the filter was meant to KEEP.
//   * the detail page's `c.html` -> `c.text`: a byte-identical body, so only
//     the Content-Type header tells the difference.
//
// ONE SURVIVOR IS LEFT UNCLOSED, deliberately: `c.text(...)` -> `c.html(...)`
// on the two 403s. It changes only the Content-Type of a response whose body
// is a bare sentence nothing parses -- and Django's own HttpResponseForbidden
// sends text/html there, so the port already differs and a test would pin the
// divergence rather than the behaviour. That is decoration, which TESTING.md
// says to delete rather than write.
//
// WHY ASSERT ON RENDERED HTML rather than the context object handed to
// render(). Half of what can silently break on a read-only page lives in the
// template: crawl_sets.njk:41 prints time_taken only `{% if cs.time_taken %}`,
// crawl_set.njk:22-28 hides the Time Taken row and mounts the polling script
// only while a crawl is unfinished, and the crawl-type icon is deliberately on
// the LIST and deliberately absent from the DETAIL (Django does the same, and
// a context-level assertion cannot see the difference). Cells are compared as
// whole rows so a column that vanishes is a failure rather than a `toContain`
// that still passes on the five columns left.

// Reduced from migrations/0008_needcheck.sql (crawlset, crawlitem),
// 0001_core.sql (foodbank, foodbankchange) as amended by
// 0019_drop_foodbank_cache.sql -- the columns these two pages' four statements
// name, and nothing else, following the convention of the other workers/site
// suites (foodbankLocation.test.ts, donationPoint.test.ts) rather than
// packages/db's shared migration loader.
//
// crawlitem_crawlset_foodbank_uniq is transcribed because it is what makes the
// seeds below realistic: a crawl set holds AT MOST ONE item per food bank, so
// every multi-item set here spans several food banks, as production's do. NULLs
// compare distinct in a SQLite unique index, which is why one food bank can
// still have many ad-hoc items.
const SCHEMA = `
CREATE TABLE crawlset (
  id INTEGER PRIMARY KEY, crawl_type TEXT NOT NULL, run_id TEXT,
  start TEXT NOT NULL, finish TEXT, expected INTEGER, remaining INTEGER
);
CREATE TABLE crawlitem (
  id INTEGER PRIMARY KEY, crawl_set_id INTEGER, crawl_type TEXT NOT NULL,
  start TEXT NOT NULL, finish TEXT, foodbank_id INTEGER NOT NULL,
  url TEXT, need_id INTEGER
);
CREATE UNIQUE INDEX crawlitem_crawlset_foodbank_uniq ON crawlitem(crawl_set_id, foodbank_id);
CREATE TABLE foodbank (id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL);
CREATE TABLE foodbankchange (
  id INTEGER PRIMARY KEY, need_id TEXT NOT NULL, foodbank_id INTEGER NOT NULL,
  nonpertinent INTEGER, published INTEGER
);
`;

type Bindable = null | number | bigint | string | Uint8Array;

// The D1DatabaseSession surface packages/db uses, over node:sqlite -- same
// adapter as donationPoint.test.ts's, plus a `log` of every statement prepared.
// The log is how "a GET never writes" is asserted as a claim about the SQL
// ISSUED rather than only about the rows left behind: a write that happened to
// be a no-op against this fixture (an UPDATE matching nothing) would leave the
// snapshot identical and still be a mutation on production data.
function d1Session(db: DatabaseSync, log: string[]): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
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

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let sessionStore: Map<string, string>;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  // The shape lib/adminAuth.ts's getAdminSession reads back out of KV.
  // expiresAt a full TTL ahead so the sliding-refresh branch (past the halfway
  // point) does not fire and put() noise into these tests.
  sessionStore = new Map([
    [
      `admin-session:${SESSION_ID}`,
      JSON.stringify({ email: ADMIN_EMAIL, name: "Some One", givenName: "Some", picture: "", expiresAt: Date.now() + 12 * 60 * 60 * 1000 }),
    ],
  ]);
});

function buildEnv(log: string[]): AppEnv["Bindings"] {
  return {
    DB: { withSession: () => d1Session(db, log) },
    SESSIONS: {
      get: async (key: string) => sessionStore.get(key) ?? null,
      put: async (key: string, value: string) => void sessionStore.set(key, value),
      delete: async (key: string) => void sessionStore.delete(key),
    },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    GMAP_STATIC_KEY: "",
    GMAP_GEOCODE_KEY: "",
    D1_DATABASE_NAME: "givefood-test",
  } as unknown as AppEnv["Bindings"];
}

interface Fetched {
  res: Response;
  html: string;
  /** Every SQL statement the request prepared, in order. Empty means the handler never ran. */
  sql: string[];
}

// A real Hono app with adminApp mounted at the production prefix. `onError` is
// caught and labelled rather than left to become an unhandled rejection, so a
// regression reads as "expected 200, got 500: <message>" instead of a crash.
function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // index.ts sets this globally (middleware/serverTiming.ts); adminPageContext
  // reads it for the footer's "Rendered in N ms", and without it every page
  // would say "NaN ms" -- true of the real app too, which is why it is set here
  // rather than worked around.
  app.use("*", async (c, next) => {
    c.set("requestStartTime", performance.now());
    await next();
  });
  app.route("/admin", adminApp);
  app.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));
  return app;
}

async function get(path: string, opts: { signedIn?: boolean } = {}): Promise<Fetched> {
  const sql: string[] = [];
  const headers: Record<string, string> = {};
  if (opts.signedIn !== false) headers.Cookie = `__Host-gfsession=${SESSION_ID}`;
  const res = await buildApp().fetch(new Request(`${ORIGIN}${path}`, { headers }), buildEnv(sql), execCtx);
  // Read the body once, here: several assertions want it and a Response body
  // can only be consumed once.
  const html = res.status === 302 ? "" : await res.text();
  return { res, html, sql };
}

// The same request with a method these routes do not register. Sends a form
// body and NO CSRF token, because that is precisely what a cross-site form
// post looks like -- see the "serves GET only" tests for why that matters on
// two handlers that read neither.
async function post(path: string, opts: { signedIn?: boolean } = {}): Promise<Fetched> {
  const sql: string[] = [];
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (opts.signedIn !== false) headers.Cookie = `__Host-gfsession=${SESSION_ID}`;
  const res = await buildApp().fetch(new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: "type=need" }), buildEnv(sql), execCtx);
  const html = res.status === 302 ? "" : await res.text();
  return { res, html, sql };
}

// adminCrawlSetDetail mounted on a path with NO `{[0-9]+}` constraint, so the
// handler's own id parsing is what answers rather than the router's regex.
// Both are real validation and they are not the same validation; the tests
// that use this are the only ones that can see the handler's half.
async function probeDetail(rawId: string): Promise<Fetched> {
  const sql: string[] = [];
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("requestStartTime", performance.now());
    c.set("adminUser", { email: ADMIN_EMAIL, name: "Some One", givenName: "Some", picture: "" });
    await next();
  });
  app.get("/probe/:id/", adminCrawlSetDetail);
  const res = await app.fetch(new Request(`${ORIGIN}/probe/${rawId}/`), buildEnv(sql), execCtx);
  return { res, html: await res.text(), sql };
}

function seedFoodbank(id: number, name: string, slug: string): void {
  db.prepare("INSERT INTO foodbank (id, name, slug) VALUES (?, ?, ?)").run(id, name, slug);
}

// `needId` is the 32-char dashless UUID, not the row's integer primary key --
// two different columns, both called need_id in their own table, and the one
// the templates build /admin/need/<uuid>/ out of is the former. Seeded as
// visibly different values so a query returning the wrong one cannot look right.
function seedNeed(id: number, needId: string, foodbankId: number, flags: { nonpertinent?: number; published?: number } = {}): void {
  db.prepare("INSERT INTO foodbankchange (id, need_id, foodbank_id, nonpertinent, published) VALUES (?, ?, ?, ?, ?)").run(
    id,
    needId,
    foodbankId,
    flags.nonpertinent ?? 0,
    flags.published ?? 0,
  );
}

// EVERY TIMESTAMP IN THIS FILE IS DJANGO'S FORMAT, "YYYY-MM-DD HH:MM:SS.ffffff"
// -- what pyDatetime() writes and what migration 0022 rewrote the imported
// Postgres rows into. These columns are TEXT, so every ORDER BY over them is a
// byte-wise string comparison and the format is load-bearing: an ISO
// "2026-09-05T..." value sorts above every space-separated one because 'T'
// (0x54) beats ' ' (0x20). Seeding ISO here would test a database this app
// does not have.
function seedCrawlSet(cs: { id: number; crawl_type: string; start: string; finish?: string | null }): void {
  db.prepare("INSERT INTO crawlset (id, crawl_type, start, finish) VALUES (?, ?, ?, ?)").run(cs.id, cs.crawl_type, cs.start, cs.finish ?? null);
}

// `2026-09-30 12:00:00` minus N hours, in that same format -- for the two
// pagination tests, where 51 rows have to be seeded with genuinely descending
// starts and hand-written literals run out of month.
function startMinusHours(hours: number): string {
  return `${new Date(Date.UTC(2026, 8, 30, 12) - hours * 3_600_000).toISOString().slice(0, 19).replace("T", " ")}.000000`;
}

function seedCrawlItem(ci: {
  id: number;
  crawl_set_id: number | null;
  crawl_type: string;
  start: string;
  finish?: string | null;
  foodbank_id: number;
  url?: string | null;
  need_id?: number | null;
}): void {
  db.prepare("INSERT INTO crawlitem (id, crawl_set_id, crawl_type, start, finish, foodbank_id, url, need_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    ci.id,
    ci.crawl_set_id,
    ci.crawl_type,
    ci.start,
    ci.finish ?? null,
    ci.foodbank_id,
    ci.url ?? null,
    ci.need_id ?? null,
  );
}

// ---------------------------------------------------------------------------
// Reading the rendered page
// ---------------------------------------------------------------------------

// crawl_sets.njk renders exactly two <tbody> elements (crawl sets, then ad hoc
// crawls) and crawl_set.njk exactly one; admin/page.njk's chrome contributes
// none. Indexed rather than searched so that "the ad hoc list was filtered"
// is a claim about the SECOND table specifically -- the whole point of the
// two-filter tests is that the wrong table changing is the bug.
function tbody(html: string, nth: number): string {
  const bodies = [...html.matchAll(/<tbody[^>]*>([\s\S]*?)<\/tbody>/g)];
  if (bodies.length <= nth) throw new Error(`expected at least ${nth + 1} <tbody> elements, found ${bodies.length}`);
  return bodies[nth]![1]!;
}

// One array of cell texts per row, tags stripped, HTML ENTITIES LEFT AS THEY
// ARE (`&#10003;`, `&#128279;`) -- both templates emit those numerically and
// the expectations below should read like the markup, not like a decoded
// approximation of it. Whole rows are compared against whole expected rows so
// that a column dropped between the query and the template fails here;
// nunjucks renders a missing variable as "" (env.ts pins throwOnUndefined:
// false, matching Django), so a dropped column is a blank cell and never an
// error.
function cells(html: string, nth: number): string[][] {
  return [...tbody(html, nth).matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((tr) =>
    [...tr[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((td) =>
      td[1]!
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    ),
  );
}

// The `value="..."` of every <option> in the nth <select>, plus which one
// carries `selected`. The dropdowns are how an admin changes either filter, so
// their links are as much a part of "the filter works" as the rows are.
function selectOptions(html: string, nth: number): { values: string[]; selected: string | null } {
  const selects = [...html.matchAll(/<select[^>]*>([\s\S]*?)<\/select>/g)];
  if (selects.length <= nth) throw new Error(`expected at least ${nth + 1} <select> elements, found ${selects.length}`);
  const options = [...selects[nth]![1]!.matchAll(/<option value="([^"]*)"( selected)?>/g)];
  return {
    // &amp; decoded: the template writes the entity (correctly -- it is an
    // attribute value), and the expectation should read as the URL an admin
    // would land on.
    values: options.map((o) => o[1]!.replace(/&amp;/g, "&")),
    selected: options.find((o) => o[2])?.[1]?.replace(/&amp;/g, "&") ?? null,
  };
}

// Every row of every table, as one comparable value. Snapshotted either side of
// a GET so "a read page wrote nothing" covers columns no assertion names.
function snapshot(): string {
  return JSON.stringify({
    crawlset: db.prepare("SELECT * FROM crawlset ORDER BY id").all(),
    crawlitem: db.prepare("SELECT * FROM crawlitem ORDER BY id").all(),
    foodbank: db.prepare("SELECT * FROM foodbank ORDER BY id").all(),
    foodbankchange: db.prepare("SELECT * FROM foodbankchange ORDER BY id").all(),
  });
}

function writeStatements(sql: string[]): string[] {
  return sql.filter((s) => /\b(insert|update|delete|drop|create|replace)\b/i.test(s));
}

// The two shared seeds. `salisbury` and `amesbury` are two food banks in one
// crawl set, which is the only way a set can hold two items given
// crawlitem_crawlset_foodbank_uniq.
function seedTwoFoodbanks(): void {
  seedFoodbank(1, "Salisbury", "salisbury");
  seedFoodbank(2, "Amesbury", "amesbury");
}

describe("adminCrawlSetsList -- GET /admin/crawl-sets/", () => {
  // ---------------------------------------------------------------------
  // The gate
  // ---------------------------------------------------------------------

  // requireAdminAuth (middleware/adminAuth.ts, Django's LoginRequiredAccess)
  // is registered on adminApp with `use("*")`, so it must run before this
  // handler for every path under /admin/. Asserted through the SQL LOG as well
  // as the status: a redirect that still ran the queries would be a page's
  // worth of data fetched for a signed-out caller, and the redirect alone
  // cannot tell the two apart.
  it("redirects a signed-out caller to sign-in without running a single query", async () => {
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });

    const { res, sql } = await get("/admin/crawl-sets/", { signedIn: false });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fcrawl-sets%2F");
    expect(sql).toEqual([]);
  });

  // The gate is BEFORE the filter validation, not after. Getting this backwards
  // would turn the 403 into an oracle -- a signed-out caller could distinguish
  // "this admin URL exists and rejected my filter" from "sign in first" -- and
  // it is the kind of ordering that only ever gets checked once.
  it("redirects a signed-out caller even when the filter is the invalid one", async () => {
    const { res, sql } = await get("/admin/crawl-sets/?type=bogus", { signedIn: false });

    expect(res.status).toBe(302);
    // Query included: requireAdminAuth captures c.req.path + the query string,
    // matching what Django's middleware.py stored (request.get_full_path()).
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fcrawl-sets%2F%3Ftype%3Dbogus");
    expect(sql).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // The crawl sets table
  // ---------------------------------------------------------------------

  // EVERY COLUMN THE ROW CARRIES, READ BACK OFF THE PAGE. crawl_sets.njk:38-43
  // prints six cells plus the detail link, each from a different key of the row
  // getCrawlSets returns; drop any one of them from the SELECT, the map() or
  // the template and nunjucks renders a blank cell rather than an error. The
  // values are deliberately distinguishable from one another (7 items, 3
  // objects) so no cell can be mistaken for its neighbour.
  it("renders every column of a crawl set row, including the icon and the detail link", async () => {
    seedFoodbank(1, "Salisbury", "salisbury");
    seedFoodbank(2, "Amesbury", "amesbury");
    seedFoodbank(3, "Andover", "andover");
    seedNeed(41, "aaaaaaabbbbbbbbccccccccdddddddd1", 1);
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000", finish: "2026-09-05 15:04:32.000000" });
    seedCrawlItem({ id: 100, crawl_set_id: 10, crawl_type: "need", start: "2026-09-05 15:00:01.000000", foodbank_id: 1, need_id: 41 });
    seedCrawlItem({ id: 101, crawl_set_id: 10, crawl_type: "need", start: "2026-09-05 15:00:02.000000", foodbank_id: 2 });
    seedCrawlItem({ id: 102, crawl_set_id: 10, crawl_type: "need", start: "2026-09-05 15:00:03.000000", foodbank_id: 3 });

    const { res, html } = await get("/admin/crawl-sets/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    // Django's `|date:"N j, Y, P"` -- AP-style month, then Django's "P" time
    // ("3 p.m." on the hour, "3:04 p.m." otherwise). time_taken is already
    // Python's str(timedelta) by the time it leaves packages/db.
    expect(cells(html, 0)).toEqual([["need", "Sept. 5, 2026, 3 p.m.", "Sept. 5, 2026, 3:04 p.m.", "0:04:32", "3", "1"]]);
    expect(html).toContain('<a href="/admin/crawl-set/10/"><span class="mdi mdi-cart"></span> need</a>');
  });

  // givefood/const/general.py:62-70's icons reach the page as MARKUP -- the
  // template renders crawl_type_icon through `| safe` (crawl_sets.njk:38),
  // which is only sound because the value comes from crawlTypeIcon's own
  // constant table and never from the row. Six types, six glyphs, and the
  // wrong glyph is not distinguishable from the right one by any other test
  // here.
  it("gives each crawl type its own icon on both tables", async () => {
    seedTwoFoodbanks();
    seedCrawlSet({ id: 10, crawl_type: "article", start: "2026-09-05 15:00:00.000000" });
    seedCrawlSet({ id: 11, crawl_type: "charity", start: "2026-09-04 15:00:00.000000" });
    seedCrawlItem({ id: 100, crawl_set_id: null, crawl_type: "check", start: "2026-09-05 16:00:00.000000", foodbank_id: 1 });
    seedCrawlItem({ id: 101, crawl_set_id: null, crawl_type: "urls", start: "2026-09-05 15:00:00.000000", foodbank_id: 2 });

    const { html } = await get("/admin/crawl-sets/");

    expect(html).toContain('<span class="mdi mdi-newspaper"></span> article');
    expect(html).toContain('<span class="mdi mdi-bank"></span> charity');
    expect(html).toContain('<span class="mdi mdi-clipboard-check"></span>&nbsp;check');
    expect(html).toContain('<span class="mdi mdi-link"></span>&nbsp;urls');
  });

  // crawl_type is a free TEXT column with no CHECK constraint, so a seventh
  // type added by a future producer (or a hand-inserted row) reaches this page
  // before anyone adds it to CRAWL_TYPE_ICONS. crawlTypeIcon's fallback is what
  // keeps that row rendering a glyph rather than the empty string, and the row
  // itself must still be LISTED -- an unrecognised type is not a filter.
  it("renders an unrecognised crawl type with the fallback icon rather than dropping it", async () => {
    seedCrawlSet({ id: 10, crawl_type: "fsa", start: "2026-09-05 15:00:00.000000" });

    const { html } = await get("/admin/crawl-sets/");

    expect(cells(html, 0)).toEqual([["fsa", "Sept. 5, 2026, 3 p.m.", "Unfinished", "", "0", "0"]]);
    expect(html).toContain('<span class="mdi mdi-help-circle"></span> fsa');
  });

  // The other half of that `| safe`: the icon is trusted markup, the TYPE
  // ITSELF is not. crawl_type is stored TEXT that no constraint validates, and
  // the two tables print it next to the icon -- so if `| safe` ever migrated
  // from the icon to the whole cell, a row written by a future producer (or by
  // the /admin/query/ console) would become script in the admin's own browser,
  // where the session cookie is. Nunjucks autoescapes by default; this pins
  // that nothing here opts out.
  it("escapes the crawl type itself, however it was written", async () => {
    seedCrawlSet({ id: 10, crawl_type: "<img src=x onerror=alert(1)>", start: "2026-09-05 15:00:00.000000" });

    const { html } = await get("/admin/crawl-sets/");

    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  // CrawlSet.time_taken() returns None while a sweep is still going and Django
  // renders it as an empty cell (crawl_sets.njk:41's `{% if cs.time_taken %}`).
  // The red "Unfinished" is the only signal on this page that a nightly sweep
  // never came back -- printing "0:00:00" instead would say a crawl still in
  // flight finished instantly, and a blank Finish cell would say nothing at all.
  it("marks an unfinished crawl set as Unfinished, with no time taken", async () => {
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000", finish: null });

    const { html } = await get("/admin/crawl-sets/");

    expect(cells(html, 0)).toEqual([["need", "Sept. 5, 2026, 3 p.m.", "Unfinished", "", "0", "0"]]);
    expect(tbody(html, 0)).toContain('<span style="color:red;">Unfinished</span>');
  });

  // Django's `{% empty %}` branch, both tables. An empty <tbody> would look
  // like a broken page; "None" is an answer.
  it("says None in both tables when there is nothing to show", async () => {
    const { res, html } = await get("/admin/crawl-sets/");

    expect(res.status).toBe(200);
    expect(cells(html, 0)).toEqual([["None"]]);
    expect(cells(html, 1)).toEqual([["None"]]);
  });

  // Django is `.order_by("-start")[:50]`, and CRAWL_SET_LIMIT is that 50. The
  // cap is not cosmetic -- crawlset gains roughly 4,000 rows a year and loses
  // none before the 30-day prune, so an uncapped page would grow without bound.
  // Which 50 matters more than how many: a LIMIT applied before the sort, or an
  // ASC ordering, returns the same row COUNT and the wrong half of the history.
  //
  // THE SEED ORDER IS SCRAMBLED, deliberately. In production id order and start
  // order agree (rows are only appended), so seeding ids 1..51 against
  // descending starts makes "the newest 50" identical to "the first 50 rowids"
  // -- which is what an ORDER BY deleted altogether also returns, so the
  // assertion would agree with a query promising no order at all. Multiplying
  // by 13 mod 51 permutes the starts, and the surviving 50 are now determined
  // by `start DESC` and by nothing else.
  it("shows the newest 50 crawl sets and drops the oldest, whatever order the rows were written in", async () => {
    const hoursOld = (id: number) => ((id * 13) % 51) + 1;
    for (let i = 1; i <= 51; i++) seedCrawlSet({ id: i, crawl_type: "need", start: startMinusHours(hoursOld(i)) });
    const byAge = [...Array(51)].map((_, k) => k + 1).sort((a, b) => hoursOld(a) - hoursOld(b));

    const { html } = await get("/admin/crawl-sets/");

    expect(cells(html, 0)).toHaveLength(50);
    // Newest first, and the single oldest is the one the cap loses.
    expect(tbody(html, 0).match(/href="\/admin\/crawl-set\/(\d+)\/"/)?.[1]).toBe(String(byAge[0]));
    expect(html).toContain(`href="/admin/crawl-set/${byAge[49]}/"`);
    expect(html).not.toContain(`href="/admin/crawl-set/${byAge[50]}/"`);
  });

  // ---------------------------------------------------------------------
  // The ad hoc list
  // ---------------------------------------------------------------------

  // gfadmin/views.py:3251-3257: crawl items with no crawl set -- what the food
  // bank detail page's "Force Check" / "Force Article Crawl" buttons create.
  // Every column again, and the need link in particular: the template builds
  // /admin/need/<uuid>/ out of foodbankchange.need_id, NOT out of the crawl
  // item's integer need_id (41 here), and both are called need_id in their own
  // table. Return the integer and the link goes nowhere, with nothing to say so.
  it("renders every column of an ad hoc crawl, linking the food bank and the need it found", async () => {
    seedFoodbank(1, "Salisbury", "salisbury");
    seedNeed(41, "aaaaaaabbbbbbbbccccccccdddddddd1", 1);
    seedCrawlItem({ id: 100, crawl_set_id: null, crawl_type: "check", start: "2026-09-05 18:09:00.000000", foodbank_id: 1, need_id: 41 });

    const { html } = await get("/admin/crawl-sets/");

    // The ad hoc table's start is `|date:"Y-m-d H:i"` -- a different format
    // from the crawl set table's, because the column is 150px wide.
    expect(cells(html, 1)).toEqual([["Salisbury", "2026-09-05 18:09", "check", "&#128279;"]]);
    expect(tbody(html, 1)).toContain('<a href="/admin/foodbank/salisbury/">Salisbury</a>');
    expect(tbody(html, 1)).toContain('<a href="/admin/need/aaaaaaabbbbbbbbccccccccdddddddd1/">&#128279;</a>');
  });

  // Most ad hoc crawls find nothing, and a handful point at a FoodbankChange
  // since deleted by hand (D1 declares no foreign keys, so nothing cleans the
  // pointer up). Both must still be LISTED -- they are the runs an admin is
  // looking for when a check "did nothing" -- with an empty last cell rather
  // than a link to /admin/need//.
  it("lists an ad hoc crawl that found nothing, and one whose need was deleted, with no link", async () => {
    seedFoodbank(1, "Salisbury", "salisbury");
    seedCrawlItem({ id: 100, crawl_set_id: null, crawl_type: "need", start: "2026-09-05 18:00:00.000000", foodbank_id: 1, need_id: null });
    // Points at a foodbankchange row that no longer exists.
    seedCrawlItem({ id: 101, crawl_set_id: null, crawl_type: "need", start: "2026-09-05 17:00:00.000000", foodbank_id: 1, need_id: 999 });

    const { html } = await get("/admin/crawl-sets/");

    expect(cells(html, 1)).toEqual([
      ["Salisbury", "2026-09-05 18:00", "need", ""],
      ["Salisbury", "2026-09-05 17:00", "need", ""],
    ]);
    expect(html).not.toContain("/admin/need//");
  });

  // ORPHANED_LIMIT, the same 50 and for the same reason -- scrambled the same
  // way, and asserted through the START cell rather than a link, because ad hoc
  // rows carry no id an admin can see.
  it("shows the newest 50 ad hoc crawls and drops the oldest, whatever order the rows were written in", async () => {
    seedFoodbank(1, "Salisbury", "salisbury");
    const hoursOld = (id: number) => ((id * 13) % 51) + 1;
    for (let i = 1; i <= 51; i++) {
      seedCrawlItem({ id: i, crawl_set_id: null, crawl_type: "need", start: startMinusHours(hoursOld(i)), foodbank_id: 1 });
    }

    const { html } = await get("/admin/crawl-sets/");

    const rows = cells(html, 1);
    expect(rows).toHaveLength(50);
    // Sliced to the minute, which is the precision this table prints.
    expect(rows[0]![1]).toBe(startMinusHours(1).slice(0, 16));
    expect(rows[49]![1]).toBe(startMinusHours(50).slice(0, 16));
    expect(tbody(html, 1)).not.toContain(startMinusHours(51).slice(0, 16));
  });

  // ---------------------------------------------------------------------
  // The two filters -- issue #34's read-side twin
  // ---------------------------------------------------------------------

  // ?type= FILTERS THE CRAWL SETS AND NOTHING ELSE. Both lists are seeded with
  // rows of both types, so three separate mistakes fail here: a filter that
  // does nothing (the article set stays), a filter applied to the wrong query
  // (the ad hoc article item vanishes), and a filter applied to BOTH (same).
  // None of them throws, and each renders a perfectly plausible page.
  it("applies ?type= to the crawl sets and leaves the ad hoc list alone", async () => {
    seedTwoFoodbanks();
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });
    seedCrawlSet({ id: 11, crawl_type: "article", start: "2026-09-04 15:00:00.000000" });
    seedCrawlItem({ id: 100, crawl_set_id: null, crawl_type: "need", start: "2026-09-05 18:00:00.000000", foodbank_id: 1 });
    seedCrawlItem({ id: 101, crawl_set_id: null, crawl_type: "article", start: "2026-09-05 17:00:00.000000", foodbank_id: 2 });

    const { res, html } = await get("/admin/crawl-sets/?type=need");

    expect(res.status).toBe(200);
    expect(cells(html, 0).map((row) => row[0])).toEqual(["need"]);
    expect(html).not.toContain('href="/admin/crawl-set/11/"');
    // Untouched: both ad hoc items, in start DESC order.
    expect(cells(html, 1).map((row) => row[2])).toEqual(["need", "article"]);
  });

  // The mirror image, and the reason both directions are written out: a handler
  // that passed `typeFilter` to both queries passes the test above and fails
  // this one, and a handler that passed `adhocFilter` to both fails the test
  // above and passes this one. Only the pair pins that each filter reaches its
  // own query.
  it("applies ?adhoc_type= to the ad hoc list and leaves the crawl sets alone", async () => {
    seedTwoFoodbanks();
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });
    seedCrawlSet({ id: 11, crawl_type: "article", start: "2026-09-04 15:00:00.000000" });
    seedCrawlItem({ id: 100, crawl_set_id: null, crawl_type: "need", start: "2026-09-05 18:00:00.000000", foodbank_id: 1 });
    seedCrawlItem({ id: 101, crawl_set_id: null, crawl_type: "article", start: "2026-09-05 17:00:00.000000", foodbank_id: 2 });

    const { html } = await get("/admin/crawl-sets/?adhoc_type=article");

    expect(cells(html, 1).map((row) => row[2])).toEqual(["article"]);
    expect(cells(html, 0).map((row) => row[0])).toEqual(["need", "article"]);
  });

  // Both at once, each to its own table and CROSSED so that swapping the two
  // context values -- the one-character edit that would pass every
  // single-filter test above -- shows up as the wrong rows in both tables at
  // once. An ad hoc item belonging to a crawl set is seeded too: the ad hoc
  // clause is `crawl_set_id IS NULL AND crawl_type = ?`, and an OR there would
  // sweep it in.
  it("applies both filters at once, each to its own table", async () => {
    seedTwoFoodbanks();
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });
    seedCrawlSet({ id: 11, crawl_type: "article", start: "2026-09-04 15:00:00.000000" });
    seedCrawlItem({ id: 100, crawl_set_id: null, crawl_type: "need", start: "2026-09-05 18:00:00.000000", foodbank_id: 1 });
    seedCrawlItem({ id: 101, crawl_set_id: null, crawl_type: "article", start: "2026-09-05 17:00:00.000000", foodbank_id: 2 });
    seedCrawlItem({ id: 102, crawl_set_id: 10, crawl_type: "article", start: "2026-09-05 16:00:00.000000", foodbank_id: 1 });

    const { html } = await get("/admin/crawl-sets/?type=need&adhoc_type=article");

    expect(cells(html, 0).map((row) => row[0])).toEqual(["need"]);
    expect(cells(html, 1)).toEqual([["Amesbury", "2026-09-05 17:00", "article", ""]]);
  });

  // THE CAP IS APPLIED AFTER THE FILTER, NOT BEFORE -- and the two filter tests
  // above cannot tell the difference, because they seed two rows. This one
  // seeds 60 `need` sets that are ALL NEWER than the three `article` sets, so
  // the newest fifty rows of the unfiltered table contain no article at all.
  //
  // KILLS THE MUTANT that wraps the LIMIT in a subquery and filters outside it
  // (`SELECT * FROM (... ORDER BY start DESC LIMIT 50) WHERE crawl_type = ?`),
  // which the whole suite survived before this test existed. That is not an
  // exotic edit: it is what "paginate first, then filter" looks like, and its
  // symptom is the worst kind this page has -- ?type=article renders 200 with a
  // clean, plausible, EMPTY table, telling an admin no article crawl has ever
  // run. `charity` and `urls` are exactly the rare types that would hit it in
  // production, where a nightly `need` sweep dominates the table.
  it("applies the 50-row cap after the filter, so a rare type is not squeezed out by a common one", async () => {
    seedTwoFoodbanks();
    // 60 of the common type, all newer than anything rare.
    for (let i = 1; i <= 60; i++) {
      seedCrawlSet({ id: i, crawl_type: "need", start: startMinusHours(i) });
      seedCrawlItem({ id: i, crawl_set_id: null, crawl_type: "check", start: startMinusHours(i), foodbank_id: 1 });
    }
    // Three of the rare type, older than every one of them.
    for (let i = 0; i < 3; i++) {
      seedCrawlSet({ id: 200 + i, crawl_type: "article", start: startMinusHours(100 + i) });
      seedCrawlItem({ id: 200 + i, crawl_set_id: null, crawl_type: "urls", start: startMinusHours(100 + i), foodbank_id: 2 });
    }

    const { res, html } = await get("/admin/crawl-sets/?type=article&adhoc_type=urls");

    expect(res.status).toBe(200);
    // All three survive the cap in both tables, because the cap saw only them.
    expect(cells(html, 0).map((row) => row[0])).toEqual(["article", "article", "article"]);
    expect(cells(html, 1).map((row) => row[2])).toEqual(["urls", "urls", "urls"]);
  });

  // A FILTER THAT MATCHES NOTHING MUST SAY SO. Both tables are seeded with rows
  // of a DIFFERENT type from the one asked for, so the only correct answer is
  // "None" twice -- and the wrong answer is a full page of crawl history the
  // admin did not ask for, which reads as though the filter simply is not
  // implemented.
  //
  // KILLS the "no rows? show everything instead" fallback in either query --
  // the shape an empty-state fix takes when someone reads a blank table as a
  // bug rather than as an answer. Both directions are asserted because the
  // fallback would plausibly be added to one query and not the other, and
  // every other filter test on this page seeds rows the filter is supposed to
  // KEEP, so none of them can see it.
  it("says None for a filter that matches nothing, rather than falling back to the whole list", async () => {
    seedTwoFoodbanks();
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });
    seedCrawlSet({ id: 11, crawl_type: "need", start: "2026-09-04 15:00:00.000000" });
    seedCrawlItem({ id: 100, crawl_set_id: null, crawl_type: "check", start: "2026-09-05 18:00:00.000000", foodbank_id: 1 });
    seedCrawlItem({ id: 101, crawl_set_id: null, crawl_type: "check", start: "2026-09-05 17:00:00.000000", foodbank_id: 2 });

    const { res, html } = await get("/admin/crawl-sets/?type=charity&adhoc_type=urls");

    expect(res.status).toBe(200);
    expect(cells(html, 0)).toEqual([["None"]]);
    expect(cells(html, 1)).toEqual([["None"]]);
    // The rows that exist are genuinely absent, not merely unmatched by the
    // "None" assertion -- a fallback would put the food bank names back.
    expect(html).not.toContain('href="/admin/crawl-set/10/"');
    expect(html).not.toContain("Salisbury");
    // ...and the dropdowns still report the filter that produced the empty
    // page, so the admin can see WHY it is empty and click back out.
    expect(selectOptions(html, 0).selected).toBe("?type=charity&adhoc_type=urls");
    expect(selectOptions(html, 1).selected).toBe("?type=charity&adhoc_type=urls");
  });

  // THE DROPDOWNS ARE THE FILTER'S ONLY UI. crawl_type_filter and
  // adhoc_type_filter go into the context purely to drive them
  // (crawl_sets.njk:15-18, :59-62), so a handler that filtered correctly but
  // reported the filters back wrongly would give the admin a page whose two
  // selects disagree with the rows next to them -- and, worse, whose links drop
  // the OTHER filter, silently widening it on the next click. Both selects and
  // the whole option list are asserted, not just the selected value.
  it("reflects both filters in the two dropdowns, each link preserving the other filter", async () => {
    const { html } = await get("/admin/crawl-sets/?type=need&adhoc_type=article");

    const typeSelect = selectOptions(html, 0);
    expect(typeSelect.selected).toBe("?type=need&adhoc_type=article");
    expect(typeSelect.values).toEqual([
      // "All Types" clears this filter only -- ?type= empty, adhoc kept.
      "?type=&adhoc_type=article",
      "?type=need&adhoc_type=article",
      "?type=article&adhoc_type=article",
      "?type=charity&adhoc_type=article",
      "?type=discrepancy&adhoc_type=article",
      "?type=check&adhoc_type=article",
      "?type=urls&adhoc_type=article",
    ]);

    const adhocSelect = selectOptions(html, 1);
    expect(adhocSelect.selected).toBe("?type=need&adhoc_type=article");
    expect(adhocSelect.values).toEqual([
      "?type=need&adhoc_type=",
      "?type=need&adhoc_type=need",
      "?type=need&adhoc_type=article",
      "?type=need&adhoc_type=charity",
      "?type=need&adhoc_type=discrepancy",
      "?type=need&adhoc_type=check",
      "?type=need&adhoc_type=urls",
    ]);
  });

  // Unfiltered, nothing is selected and the links carry only their own
  // parameter -- CRAWL_TYPE_OPTIONS in Django's own order (views.py:3230),
  // which is the order of the dropdown the admin reads.
  it("selects nothing and carries no stray parameters when neither filter is set", async () => {
    const { html } = await get("/admin/crawl-sets/");

    expect(selectOptions(html, 0)).toEqual({
      values: ["?type=", "?type=need", "?type=article", "?type=charity", "?type=discrepancy", "?type=check", "?type=urls"],
      selected: null,
    });
    expect(selectOptions(html, 1).selected).toBeNull();
  });

  // gfadmin/views.py:3233-3238 returns HttpResponseForbidden, not a silent
  // fallback to "all types" -- kept deliberately (crawlSets.ts:14-16), because
  // showing every crawl type to a caller who asked for one is a WRONG ANSWER
  // rather than a differently-ordered one. Asserted as the whole body, and as
  // NOT a rendered page: a 403 that still rendered the admin chrome would mean
  // the queries ran first.
  it("403s an unrecognised ?type= with Django's own message, before any query runs", async () => {
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });

    const { res, html, sql } = await get("/admin/crawl-sets/?type=bogus");

    expect(res.status).toBe(403);
    expect(html).toBe("Invalid crawl type filter");
    expect(sql).toEqual([]);
  });

  it("403s an unrecognised ?adhoc_type= with its own distinct message", async () => {
    const { res, html, sql } = await get("/admin/crawl-sets/?adhoc_type=bogus");

    expect(res.status).toBe(403);
    // A different sentence from the one above, matching views.py:3237 -- the
    // two messages are how an admin tells which of two dropdown links is broken.
    expect(html).toBe("Invalid adhoc type filter");
    expect(sql).toEqual([]);
  });

  // Both invalid: the crawl type is checked first, so its message is the one
  // returned. Django checks in the same order (views.py:3233 then :3236).
  it("reports the crawl type filter first when both are invalid", async () => {
    const { res, html } = await get("/admin/crawl-sets/?type=bogus&adhoc_type=alsobogus");

    expect(res.status).toBe(403);
    expect(html).toBe("Invalid crawl type filter");
  });

  // AN EMPTY FILTER IS NOT AN INVALID ONE. This is not a hypothetical URL: it
  // is exactly what the template's own "All Types" option navigates to
  // (crawl_sets.njk:15, :59), so a parseTypeFilter that treated "" as
  // unrecognised would 403 the one link an admin uses to get back to the
  // unfiltered page. Django's `if crawl_type_filter and ...` has the same
  // guard, for the same reason.
  it("treats an empty filter as no filter, which is what the All Types links send", async () => {
    seedFoodbank(1, "Salisbury", "salisbury");
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });
    seedCrawlSet({ id: 11, crawl_type: "article", start: "2026-09-04 15:00:00.000000" });
    seedCrawlItem({ id: 100, crawl_set_id: null, crawl_type: "need", start: "2026-09-05 18:00:00.000000", foodbank_id: 1 });

    const { res, html } = await get("/admin/crawl-sets/?type=&adhoc_type=");

    expect(res.status).toBe(200);
    expect(cells(html, 0).map((row) => row[0])).toEqual(["need", "article"]);
    expect(cells(html, 1)).toHaveLength(1);
    expect(selectOptions(html, 0).selected).toBeNull();
  });

  // A KNOWN DIVERGENCE FROM DJANGO, pinned as-is rather than wished away.
  // Hono's `c.req.query(k)` returns the FIRST value of a repeated parameter;
  // Django's `request.GET.get(k)` is QueryDict.__getitem__, which returns the
  // LAST. Both were run, not reasoned about: Hono answers "need" and CPython's
  // parse_qs()['type'][-1] answers "article" for this very query string. So
  // this URL filters to `need` here and would have filtered to `article` in
  // Django. Harmless in practice -- nothing generates a doubled parameter, and
  // both dropdowns emit exactly one of each -- and recorded here so that
  // finding the two apps disagreeing on a hand-edited URL does not start
  // another hunt for a filter bug that is not in the filter.
  it("takes the FIRST of a repeated ?type=, where Django took the last", async () => {
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });
    seedCrawlSet({ id: 11, crawl_type: "article", start: "2026-09-04 15:00:00.000000" });

    const { res, html } = await get("/admin/crawl-sets/?type=need&type=article");

    expect(res.status).toBe(200);
    expect(cells(html, 0).map((row) => row[0])).toEqual(["need"]);
  });

  // The allowlist is byte-for-byte, and this is the other half of the claim
  // packages/db's isCrawlTypeOption test makes about the predicate: crawl_type
  // is stored lower case and SQLite's `=` is case-sensitive, so accepting
  // "Need" here would hand the WHERE clause a value matching no row and present
  // an empty crawl history as if it were the truth. The 403 is the honest
  // answer. Trailing whitespace is rejected for the same reason.
  it("403s a differently-cased or padded type rather than filtering to nothing", async () => {
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });

    expect((await get("/admin/crawl-sets/?type=Need")).res.status).toBe(403);
    expect((await get("/admin/crawl-sets/?type=NEED")).res.status).toBe(403);
    expect((await get("/admin/crawl-sets/?type=need%20")).res.status).toBe(403);
    // The plural is the option; the singular is not.
    expect((await get("/admin/crawl-sets/?type=url")).res.status).toBe(403);
    expect((await get("/admin/crawl-sets/?type=urls")).res.status).toBe(200);
  });

  // isCrawlTypeOption is an Array.includes, not a lookup on an object literal
  // -- which would inherit Object.prototype and let "constructor" through into
  // `cs.crawl_type = ?`, a filter matching nothing, shown to the admin as an
  // empty crawl history instead of the 403 Django returns. Asserted here at the
  // ROUTE, because the 403 is the part an admin can see.
  it("403s an Object.prototype key rather than binding it into the WHERE clause", async () => {
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });

    expect((await get("/admin/crawl-sets/?type=constructor")).res.status).toBe(403);
    expect((await get("/admin/crawl-sets/?type=toString")).res.status).toBe(403);
    expect((await get("/admin/crawl-sets/?adhoc_type=__proto__")).res.status).toBe(403);
  });

  // ---------------------------------------------------------------------
  // Read-only means read-only
  // ---------------------------------------------------------------------

  // Django's crawl_sets() is a plain GET view with no side effect, and this
  // page is linked from every admin page's navbar -- so it is loaded
  // constantly, and prefetched by the browser's own instant.page (page.njk's
  // `data-instant-allow-query-string`). Anything this handler wrote would be
  // written by hovering a link. Asserted twice over: the SQL issued contains no
  // write, and every row of every table is byte-identical afterwards.
  it("writes nothing at all", async () => {
    seedTwoFoodbanks();
    seedNeed(41, "aaaaaaabbbbbbbbccccccccdddddddd1", 1);
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000", finish: "2026-09-05 15:04:32.000000" });
    seedCrawlItem({ id: 100, crawl_set_id: 10, crawl_type: "need", start: "2026-09-05 15:00:01.000000", foodbank_id: 1, need_id: 41 });
    seedCrawlItem({ id: 101, crawl_set_id: null, crawl_type: "check", start: "2026-09-05 16:00:00.000000", foodbank_id: 2 });
    const before = snapshot();

    const { res, sql } = await get("/admin/crawl-sets/?type=need&adhoc_type=check");

    expect(res.status).toBe(200);
    expect(writeStatements(sql)).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  // GET ONLY, AND THE METHOD IS THE WHOLE PROTECTION. index.ts:194 registers
  // this route with adminApp.get, and the handler reads no body and verifies no
  // CSRF token -- which is sound exactly as long as it can only be reached by a
  // GET. Every mutating admin route in this codebase pairs a POST with
  // verifyCsrf; these two pages have neither, so `adminApp.get` IS their token.
  //
  // KILLS THE MUTANT `adminApp.get("/crawl-sets/", ...)` -> `adminApp.all(...)`,
  // which the whole suite survived before this test existed. Under `.all`, a
  // cross-site <form method=post> would render the full admin page -- navbar,
  // signed-in email, 50 rows of crawl history -- into a signed-in admin's
  // browser with no token anywhere in the exchange. Asserted through the SQL log
  // too, because a 404 that had already run both queries is a different failure
  // from one that never dispatched to the handler at all.
  it("serves GET only -- a POST reaches neither the handler nor the database", async () => {
    seedTwoFoodbanks();
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });
    seedCrawlItem({ id: 100, crawl_set_id: null, crawl_type: "check", start: "2026-09-05 16:00:00.000000", foodbank_id: 1 });
    const before = snapshot();

    const { res, html, sql } = await post("/admin/crawl-sets/");

    expect(res.status).toBe(404);
    expect(html).not.toContain("navbar-item");
    expect(sql).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  // Two statements, one per table, and no third. The page issues them through
  // ONE Promise.all so they overlap rather than queue -- but the count is what
  // catches an N+1 creeping in later (a per-row icon lookup that hit the
  // database, say), which on a 50-row page is 50 extra round trips to a
  // replicated D1 for a screen an admin is waiting on.
  it("answers the whole page in two queries, however many rows it shows", async () => {
    seedTwoFoodbanks();
    for (let i = 1; i <= 10; i++) {
      seedCrawlSet({ id: i, crawl_type: "need", start: `2026-09-${String(10 + i).padStart(2, "0")} 15:00:00.000000` });
      seedCrawlItem({ id: i, crawl_set_id: null, crawl_type: "need", start: `2026-09-${String(10 + i).padStart(2, "0")} 16:00:00.000000`, foodbank_id: (i % 2) + 1 });
    }

    const { sql } = await get("/admin/crawl-sets/");

    expect(sql).toHaveLength(2);
  });

  // The section string, which is the only thing that lights the navbar. It is
  // a real failure mode with a real precedent: routes/admin/index.ts:322 has a
  // comment about the dashboard having passed "needs" here, which lit a tab
  // pointing at a completely different page. Exactly one item can be active.
  it("lights the Crawls navbar item and no other", async () => {
    const { html } = await get("/admin/crawl-sets/");

    expect([...html.matchAll(/class="navbar-item is-active"/g)]).toHaveLength(1);
    expect(html).toContain('<a class="navbar-item is-active" href="/admin/crawl-sets/">Crawls</a>');
    // adminPageContext ran with the session requireAdminAuth resolved, not with
    // an anonymous one -- page.njk's "signed in as" comes from `admin_user`.
    expect(html).toContain(ADMIN_EMAIL);
  });

  // The link every row carries has to resolve, and it resolves through the
  // route registration rather than through anything this page knows -- so it is
  // checked by ASKING THE SAME APP for it. A detail route renamed or
  // regex-tightened without updating crawl_sets.njk:38 would leave a table of
  // links to a 404 page, which nothing else here would notice.
  it("links each row at a URL the admin router actually serves", async () => {
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });

    const { html } = await get("/admin/crawl-sets/");
    const href = html.match(/href="(\/admin\/crawl-set\/\d+\/)"/)?.[1];
    expect(href).toBe("/admin/crawl-set/10/");

    const followed = await get(href!);
    expect(followed.res.status).toBe(200);
    expect(followed.html).toContain("<h2>Crawl Set</h2>");
  });
});

describe("adminCrawlSetDetail -- GET /admin/crawl-set/<id>/", () => {
  it("redirects a signed-out caller to sign-in without running a single query", async () => {
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });

    const { res, sql } = await get("/admin/crawl-set/10/", { signedIn: false });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fcrawl-set%2F10%2F");
    expect(sql).toEqual([]);
  });

  // Every field of the <dl>, which is the summary an admin reads before
  // deciding whether last night's sweep is worth investigating. Item and object
  // counts are seeded to DIFFERENT numbers (3 and 1) so neither can be mistaken
  // for the other: object_count is "items that produced a need", not "items
  // that finished", and the two printed side by side are the page's only
  // evidence that a crawl did any work.
  it("renders every field of the crawl set summary", async () => {
    seedFoodbank(1, "Salisbury", "salisbury");
    seedFoodbank(2, "Amesbury", "amesbury");
    seedFoodbank(3, "Andover", "andover");
    seedNeed(41, "aaaaaaabbbbbbbbccccccccdddddddd1", 1);
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000", finish: "2026-09-05 15:04:32.000000" });
    seedCrawlItem({ id: 100, crawl_set_id: 10, crawl_type: "need", start: "2026-09-05 15:00:01.000000", finish: "2026-09-05 15:00:03.000000", foodbank_id: 1, need_id: 41 });
    seedCrawlItem({ id: 101, crawl_set_id: 10, crawl_type: "need", start: "2026-09-05 15:00:02.000000", finish: "2026-09-05 15:00:04.000000", foodbank_id: 2 });
    seedCrawlItem({ id: 102, crawl_set_id: 10, crawl_type: "need", start: "2026-09-05 15:00:03.000000", finish: null, foodbank_id: 3 });

    const { res, html } = await get("/admin/crawl-set/10/");

    expect(res.status).toBe(200);
    // Asserted here as well as on the list page, because this handler builds
    // its own response and `c.html` -> `c.text` is a one-word edit that no
    // other assertion on this page can see: the body is byte-identical, and
    // only the header decides whether a browser renders the page or shows the
    // admin its markup as plain text. Kills that mutant, which the suite
    // survived while every content assertion below still passed.
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(html).toContain("<dd>need</dd>");
    expect(html).toContain("<dd>Sept. 5, 2026, 3 p.m.</dd>");
    expect(html).toMatch(/<dd id="crawl-set-finish">\s*Sept\. 5, 2026, 3:04 p\.m\.\s*<\/dd>/);
    expect(html).toContain('<dd id="crawl-set-time-taken">0:04:32</dd>');
    expect(html).toContain('<dd id="crawl-set-item-count">3</dd>');
    expect(html).toContain('<dd id="crawl-set-object-count">1</dd>');
  });

  // DELIBERATE DIVERGENCE FROM THE LIST PAGE, and the reason crawlSets.ts:63-65
  // spells it out: Django prefixes the type with its icon on crawl_sets.html:43
  // and NOT in crawl_set.html:16's <dl>, so the detail handler builds its
  // context without crawl_type_icon at all. Asserted because "add the icon here
  // too, for consistency" is a plausible tidy-up that would silently diverge
  // from Django -- and because it is the one context key whose ABSENCE is the
  // ported behaviour.
  it("shows the crawl type without an icon, unlike the list page", async () => {
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });

    const { html } = await get("/admin/crawl-set/10/");

    expect(html).toContain("<dd>need</dd>");
    // mdi-cart is `need`'s glyph on the list page. Nothing in this page's own
    // markup should carry it.
    expect(html).not.toContain("mdi-cart");
  });

  // Every column of an item row. time_taken_ms is milliseconds here, NOT the
  // str(timedelta) the set-level Time Taken uses -- individual crawl items
  // finish in hundreds of milliseconds, and Django's own crawl_set.html prints
  // the same two units on the same page for the same reason.
  it("renders every column of a crawl item row", async () => {
    seedFoodbank(1, "Salisbury", "salisbury");
    seedNeed(41, "aaaaaaabbbbbbbbccccccccdddddddd1", 1, { published: 1 });
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000", finish: "2026-09-05 15:04:32.000000" });
    seedCrawlItem({
      id: 100,
      crawl_set_id: 10,
      crawl_type: "need",
      start: "2026-09-05 15:01:00.000000",
      finish: "2026-09-05 15:02:02.500000",
      foodbank_id: 1,
      url: "https://example.org/shopping-list/",
      need_id: 41,
    });

    const { html } = await get("/admin/crawl-set/10/");

    expect(cells(html, 0)).toEqual([
      [
        "Salisbury",
        "Sept. 5, 2026, 3:01 p.m.",
        "Sept. 5, 2026, 3:02 p.m.",
        "62500 ms",
        // `|truncatechars:30` -- 29 characters plus a single-character
        // ellipsis, Django's own arithmetic.
        //
        // SUSPECT, PINNED AS THE SERVER RENDERS IT. crawl_set.njk's own poll
        // loop truncates the same URL differently (`substring(0, 27) + "..."`,
        // :138), so the first tick of the poll silently rewrites every URL cell
        // on the page to a shorter string with three dots -- "https://example.
        // org/shopping" + "..." here. Cosmetic, but it is exactly the
        // SSR-vs-poll drift the template's own comment at :152-157 was written
        // to stop for the Object column, left unfixed one column to the left.
        "https://example.org/shopping-…",
        "aaaaaaa &#10003; Published",
      ],
    ]);
    expect(tbody(html, 0)).toContain('<a href="/admin/foodbank/salisbury/">Salisbury</a>');
    // need_id_short is the first 7 characters of the need's UUID, and the link
    // is built from the whole one.
    expect(tbody(html, 0)).toContain('<a href="/admin/need/aaaaaaabbbbbbbbccccccccdddddddd1/">aaaaaaa</a>');
  });

  // The three other shapes of the Object column, which is where an admin looks
  // to see what a crawl actually produced. `nonpertinent` and `published` are
  // the FoodbankChange's own flags, read live through the join -- a crawl item
  // whose need has since been published must say so here, and one whose need
  // was deleted by hand (D1 declares no foreign keys, so the pointer survives)
  // must say Deleted rather than link to nothing.
  it("distinguishes a nonpertinent need, a deleted one, and an item that found nothing", async () => {
    seedFoodbank(1, "Salisbury", "salisbury");
    seedFoodbank(2, "Amesbury", "amesbury");
    seedFoodbank(3, "Andover", "andover");
    seedNeed(41, "bbbbbbbcccccccdddddddeeeeeeefff1", 1, { nonpertinent: 1 });
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });
    seedCrawlItem({ id: 100, crawl_set_id: 10, crawl_type: "need", start: "2026-09-05 15:00:01.000000", foodbank_id: 1, need_id: 41 });
    // need_id pointing at a foodbankchange row that no longer exists.
    seedCrawlItem({ id: 101, crawl_set_id: 10, crawl_type: "need", start: "2026-09-05 15:00:02.000000", foodbank_id: 2, need_id: 999 });
    seedCrawlItem({ id: 102, crawl_set_id: 10, crawl_type: "need", start: "2026-09-05 15:00:03.000000", foodbank_id: 3, need_id: null });

    const { html } = await get("/admin/crawl-set/10/");

    const objectCells = cells(html, 0).map((row) => row[5]);
    expect(objectCells).toEqual(["bbbbbbb Nonpertinent", "Deleted", ""]);
    expect(tbody(html, 0)).toContain('<span style="color:red;">Deleted</span>');
    // A deleted object still counts towards object_count -- the item DID
    // produce one, and CrawlSet.object_count() counts the pointer, not the row
    // it points at.
    expect(html).toContain('<dd id="crawl-set-object-count">2</dd>');
  });

  // THE POSTGRES NULLS-LAST EMULATION, seen from the page rather than from the
  // SQL. Django runs on Postgres, where `order_by("object_id", "-start")` sorts
  // NULLs LAST and so floats the handful of items that actually produced a need
  // to the TOP of the table; SQLite sorts NULLs FIRST, which buried them past
  // the end of the first screenful on a several-hundred-row `need` crawl. The
  // seeds are scrambled -- the need-bearing items are inserted LAST and have
  // the OLDEST starts -- so this ordering is produced by the leading
  // `(need_id IS NULL)` key and by nothing else.
  it("floats the items that produced a need to the top, Postgres-style", async () => {
    for (let id = 1; id <= 4; id++) seedFoodbank(id, `FB ${id}`, `fb-${id}`);
    seedNeed(41, "aaaaaaabbbbbbbbccccccccdddddddd1", 1);
    seedNeed(42, "eeeeeeefffffffgggggggghhhhhhhh12", 2);
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });
    seedCrawlItem({ id: 100, crawl_set_id: 10, crawl_type: "need", start: "2026-09-05 15:09:00.000000", foodbank_id: 3, need_id: null });
    seedCrawlItem({ id: 101, crawl_set_id: 10, crawl_type: "need", start: "2026-09-05 15:08:00.000000", foodbank_id: 4, need_id: null });
    seedCrawlItem({ id: 102, crawl_set_id: 10, crawl_type: "need", start: "2026-09-05 15:02:00.000000", foodbank_id: 2, need_id: 42 });
    seedCrawlItem({ id: 103, crawl_set_id: 10, crawl_type: "need", start: "2026-09-05 15:01:00.000000", foodbank_id: 1, need_id: 41 });

    const { html } = await get("/admin/crawl-set/10/");

    expect(cells(html, 0).map((row) => row[0])).toEqual(["FB 1", "FB 2", "FB 3", "FB 4"]);
  });

  // An unfinished set is the one an admin opens this page to watch, so the page
  // has to (a) say so, (b) HIDE the Time Taken row rather than print a blank or
  // a zero, and (c) mount the poll loop that fills it in when the crawl lands.
  // The hidden-but-present dt/dd pair is not decoration: crawl_set.njk's script
  // unhides those exact ids, so removing them would make the poll throw on a
  // null element and stop updating everything else on the page with it.
  it("marks a running crawl unfinished, hides Time Taken, and mounts the poll loop", async () => {
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000", finish: null });

    const { html } = await get("/admin/crawl-set/10/");

    expect(html).toContain('<span style="color:red;">Unfinished</span>');
    expect(html).toContain('<dt id="crawl-set-time-taken-dt" style="display:none;">Time Taken</dt>');
    expect(html).toContain('<dd id="crawl-set-time-taken" style="display:none;">&nbsp;</dd>');
    expect(html).toContain("setInterval");
  });

  // The other side of it, and the more important half: a FINISHED crawl set
  // must NOT mount the poll. It never changes again, and a page left open on a
  // finished crawl would otherwise fetch the JSON endpoint every two seconds
  // for as long as the tab lives.
  it("mounts no poll loop once the crawl has finished", async () => {
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000", finish: "2026-09-05 15:04:32.000000" });

    const { html } = await get("/admin/crawl-set/10/");

    expect(html).not.toContain("setInterval");
    expect(html).toContain('<dt id="crawl-set-time-taken-dt">Time Taken</dt>');
  });

  // THE POLLED URL HAS TO EXIST. It is built by string concatenation inside a
  // template's inline script (crawl_set.njk:87), so nothing typechecks it and
  // nothing renders an error if it is wrong -- the page would simply stop
  // updating, which is indistinguishable from a crawl that has stalled, the
  // exact thing an admin comes here to diagnose. Checked by pulling the URL out
  // of the rendered script and asking the same router for it: note it has NO
  // trailing slash, unlike every other admin URL, which is why routes/admin/
  // crawlSet.ts answers a miss with c.text() rather than c.notFound() (the
  // latter would trigger the app's APPEND_SLASH probe on a URL that must never
  // be retried slashed).
  it("polls a JSON URL the admin router actually serves, shaped like the page it refreshes", async () => {
    seedFoodbank(1, "Salisbury", "salisbury");
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000", finish: null });
    seedCrawlItem({ id: 100, crawl_set_id: 10, crawl_type: "need", start: "2026-09-05 15:00:01.000000", foodbank_id: 1 });

    const { html } = await get("/admin/crawl-set/10/");
    const polled = html.match(/fetch\("([^"]+)"\)/)?.[1];
    expect(polled).toBe("/admin/crawl-set/10.json");

    const json = await get(polled!);
    expect(json.res.status).toBe(200);
    const data = JSON.parse(json.html) as { crawl_type: string; item_count: number; finish: string | null };
    // The same three values the SSR page above printed, so the poll cannot
    // disagree with the page it is refreshing -- which is the whole reason
    // crawlSets.ts renders from getCrawlSetJson rather than from a second
    // near-identical query (Django runs two, and they have drifted before).
    expect(data.crawl_type).toBe("need");
    expect(data.item_count).toBe(1);
    expect(data.finish).toBeNull();
  });

  // get_object_or_404(CrawlSet, pk=crawl_set_id). A missing set must 404, not
  // render an empty crawl set page -- which is what a handler that skipped the
  // null check would do, since nunjucks prints undefined as "" and the items
  // table has its own "None" branch. So the assertion is on the status AND on
  // the absence of the page.
  it("404s an id no crawl set has, rather than rendering an empty one", async () => {
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });

    const { res, html, sql } = await get("/admin/crawl-set/999/");

    expect(res.status).toBe(404);
    expect(html).not.toContain("<h2>Crawl Set</h2>");
    // The handler DID run and DID look -- one statement, the crawlset probe --
    // which is how this 404 differs from the routing 404 below.
    expect(sql).toHaveLength(1);
  });

  // The route's own `{[0-9]+}` constraint (routes/admin/index.ts:195), which is
  // Django's `<int:crawl_set_id>` converter: a non-numeric id never reaches the
  // handler at all. Asserted through the empty SQL log, because a 404 alone
  // cannot tell "no route matched" from "the handler looked and found nothing".
  it("never reaches the handler for a non-numeric id", async () => {
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });

    const { res, sql } = await get("/admin/crawl-set/abc/");

    expect(res.status).toBe(404);
    expect(sql).toEqual([]);
  });

  // Pinned, not endorsed. THE ROUTE'S REGEX IS THE REAL VALIDATION; the
  // handler's own `Number.isInteger` guard is much weaker than it looks,
  // because Number() accepts scientific and hex notation and whitespace.
  // Mounted here on a deliberately unconstrained path to show what the guard
  // alone does: "1e3" is an integer to JavaScript and resolves crawl set 1000.
  // Harmless today (the id is a lookup key, and a miss is a 404), and recorded
  // so that loosening index.ts:195's constraint is a visible decision rather
  // than a quiet widening of what an id can be.
  it("parses an id with Number(), so only the route's regex keeps 1e3 out", async () => {
    seedCrawlSet({ id: 1000, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });

    const { res, html } = await probeDetail("1e3");

    expect(res.status).toBe(200);
    expect(html).toContain("<h2>Crawl Set</h2>");

    // The real route refuses the same id outright.
    expect((await get("/admin/crawl-set/1e3/")).res.status).toBe(404);
  });

  // THE HANDLER'S OWN GUARD, WHICH THE ROUTE'S REGEX OTHERWISE HIDES. Every
  // request that arrives through /admin/crawl-set/<id>/ has already matched
  // `[0-9]+`, so `Number.isInteger` never rejects anything there and the whole
  // suite passed with the guard DELETED -- a survivor found by mutation, and
  // exactly the "validation branch removed, bad input reaches the query" shape
  // this file exists to catch. Read on the unconstrained mount, where the guard
  // is the only thing standing between a raw path segment and a bind parameter.
  //
  // KILLS TWO MUTANTS the rest of the file survives:
  //   * `if (!Number.isInteger(id)) return c.notFound();` deleted outright --
  //     "abc" becomes NaN and is bound into `WHERE id = ?`, which is a query
  //     issued on behalf of a value that was never an id.
  //   * the same guard weakened to `Number.isNaN(id)` -- which lets "1.5" and
  //     "10.5" through, and 10.5 is a plausible typo for the crawl set the
  //     admin actually wanted.
  // The SQL log is what kills them: all three spellings 404 either way, so a
  // status-only assertion sees nothing at all. What differs is whether the
  // database was asked.
  it("refuses a non-integer id in the handler itself, before a single query", async () => {
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });

    for (const bad of ["abc", "1.5", "10.5", ""]) {
      const { res, sql } = await probeDetail(bad);
      expect({ id: bad, status: res.status, queries: sql.length }).toEqual({ id: bad, status: 404, queries: 0 });
    }

    // The control: an id that IS an integer gets its queries through the same
    // mount, so the assertion above is about the guard and not about the probe
    // route failing to reach the handler at all.
    const ok = await probeDetail("10");
    expect(ok.res.status).toBe(200);
    expect(ok.sql).toHaveLength(2);
  });

  // THE OTHER HALF OF THAT GUARD, PINNED AND NOT ENDORSED -- the surprising
  // accepts. crawlSets.ts's own comment says Number() "accepts scientific and
  // hex notation and whitespace", and the 1e3 test above proves the scientific
  // case; these are the two the comment claims and nothing checked. Number()
  // trims ASCII whitespace before parsing and understands an 0x prefix, so
  // BOTH of these resolve a real crawl set through the handler's guard:
  // "%2010" is crawl set 10, and "0x10" is crawl set 16 -- an id an admin never
  // typed and a row they did not ask for, reached without the guard objecting.
  //
  // Harmless today, and pinned rather than "fixed", for the same reason the
  // 1e3 test gives: index.ts:195's `{[0-9]+}` refuses every one of these at the
  // router, so the only route an admin can actually reach is strict, and
  // Django's own `<int:crawl_set_id>` converter refuses them too. What this
  // records is that LOOSENING that regex would silently widen what an id means,
  // because the handler behind it validates almost nothing.
  it("also accepts whitespace-padded and hex ids, which only the route's regex keeps out", async () => {
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });
    seedCrawlSet({ id: 16, crawl_type: "article", start: "2026-09-04 15:00:00.000000" });

    // Leading whitespace: Number(" 10") === 10.
    const padded = await probeDetail(" 10");
    expect(padded.res.status).toBe(200);
    expect(padded.html).toContain("<dd>need</dd>");

    // Hex: Number("0x10") === 16, so this serves the ARTICLE set, not set 10.
    const hex = await probeDetail("0x10");
    expect(hex.res.status).toBe(200);
    expect(hex.html).toContain("<dd>article</dd>");

    // The real route refuses both, which is what makes the above harmless.
    expect((await get("/admin/crawl-set/%2010/")).res.status).toBe(404);
    expect((await get("/admin/crawl-set/0x10/")).res.status).toBe(404);
  });

  // The detail page's half of the GET-only claim (index.ts:195). It matters
  // more here than on the list page: this route takes a path parameter, so
  // under `adminApp.all` it would be a POST endpoint that reads an id out of
  // the URL and queries on it, with no CSRF token in the handler to refuse one.
  // KILLS `adminApp.get("/crawl-set/:id{[0-9]+}/", ...)` -> `adminApp.all(...)`.
  it("serves GET only -- a POST to a real crawl set reaches neither handler nor database", async () => {
    seedFoodbank(1, "Salisbury", "salisbury");
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });
    seedCrawlItem({ id: 100, crawl_set_id: 10, crawl_type: "need", start: "2026-09-05 15:00:01.000000", foodbank_id: 1 });
    const before = snapshot();

    const { res, html, sql } = await post("/admin/crawl-set/10/");

    expect(res.status).toBe(404);
    expect(html).not.toContain("<h2>Crawl Set</h2>");
    expect(sql).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  // A 20-digit id is past Number.MAX_SAFE_INTEGER, so it survives
  // Number.isInteger and is bound as a float. SQLite matches nothing and the
  // page 404s -- the point being that it does NOT throw, because an uncaught
  // bind error here would be a 500 reachable from a hand-typed URL.
  it("404s an id too large to be a row id, without throwing", async () => {
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });

    const { res } = await get("/admin/crawl-set/99999999999999999999/");

    expect(res.status).toBe(404);
  });

  // Django's `<int:...>` converter accepts leading zeros and int()s them away,
  // and Hono's `[0-9]+` plus Number() land in the same place: /0010/ is a
  // second URL for crawl set 10. Parity, pinned rather than "fixed" -- nothing
  // links to the padded form, so there is no canonicalisation to do.
  it("serves a zero-padded id as the same crawl set, as Django's int converter does", async () => {
    seedCrawlSet({ id: 10, crawl_type: "article", start: "2026-09-05 15:00:00.000000" });

    const { res, html } = await get("/admin/crawl-set/0010/");

    expect(res.status).toBe(200);
    expect(html).toContain("<dd>article</dd>");
  });

  // A crawl set with no items yet -- every set looks like this for its first
  // few seconds, and it is also what a set whose queue never delivered looks
  // like forever.
  it("renders a crawl set that has no items with a None row and zero counts", async () => {
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });

    const { res, html } = await get("/admin/crawl-set/10/");

    expect(res.status).toBe(200);
    expect(cells(html, 0)).toEqual([["None"]]);
    expect(html).toContain('<dd id="crawl-set-item-count">0</dd>');
    expect(html).toContain('<dd id="crawl-set-object-count">0</dd>');
  });

  // NO LIMIT ON THIS PAGE, matching Django (views.py:3271 has no slice, unlike
  // the list page's [:50]). A real `need` sweep is ~1,100 items and every one
  // of them belongs here -- this page is the archive the LIST page deliberately
  // is not. Pinned so that "cap it like the other one" cannot happen silently,
  // because a cap would hide exactly the food banks a partial crawl missed.
  it("lists every item in the set, uncapped", async () => {
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });
    for (let i = 1; i <= 60; i++) {
      seedFoodbank(i, `FB ${i}`, `fb-${i}`);
      seedCrawlItem({ id: i, crawl_set_id: 10, crawl_type: "need", start: `2026-09-05 15:${String(i).padStart(2, "0")}:00.000000`, foodbank_id: i });
    }

    const { html } = await get("/admin/crawl-set/10/");

    expect(cells(html, 0)).toHaveLength(60);
    expect(html).toContain('<dd id="crawl-set-item-count">60</dd>');
  });

  it("lights the Crawls navbar item and no other", async () => {
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });

    const { html } = await get("/admin/crawl-set/10/");

    expect([...html.matchAll(/class="navbar-item is-active"/g)]).toHaveLength(1);
    expect(html).toContain('<a class="navbar-item is-active" href="/admin/crawl-sets/">Crawls</a>');
  });

  // Same claim as the list page's, and it matters more here: this page is
  // POLLED, so anything it wrote would be written every two seconds for as
  // long as an admin leaves the tab open on a running crawl.
  it("writes nothing at all", async () => {
    seedFoodbank(1, "Salisbury", "salisbury");
    seedNeed(41, "aaaaaaabbbbbbbbccccccccdddddddd1", 1);
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000", finish: null });
    seedCrawlItem({ id: 100, crawl_set_id: 10, crawl_type: "need", start: "2026-09-05 15:00:01.000000", foodbank_id: 1, need_id: 41 });
    const before = snapshot();

    const { res, sql } = await get("/admin/crawl-set/10/");

    expect(res.status).toBe(200);
    expect(writeStatements(sql)).toEqual([]);
    expect(snapshot()).toBe(before);
  });
});
