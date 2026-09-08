import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getNeedByUuid } from "@givefood/db";
import { adminNeedNew } from "./needNew";
import { requireAdminAuth } from "../../middleware/adminAuth";
import { hmacSha256Hex } from "../../lib/hmac";
import type { AppEnv } from "../../types";

// routes/admin/needNew.ts is /admin/need/new/ -- gfadmin/views.py:1916-1946
// need_form's CREATE branch. It is the endpoint the maintainer uses when a food
// bank phones or emails a shopping list in, so the thing being typed into it is
// a dozen lines of text that exists NOWHERE ELSE until this handler stores it.
// That is what makes it worth a route-level suite rather than stopping at
// packages/db, and it is the same shape as the two bugs this tier was opened
// for:
//
//   * #34 -- the location form parsed a Place ID, passed it down, and no SQL
//     wrote it; the handler redirected as though the save had worked. So no
//     test below accepts a 302 as evidence of anything: every save reads the
//     row back out of SQLite and asserts its columns.
//   * #12 -- a rejected save reached the 500 page and took the whole form with
//     it. Every refusal below therefore asserts BOTH halves: the refusal, and
//     that the shopping list came back in the textarea the admin would retype
//     it into. A handler that refused with an empty form would pass a status
//     check and still be the bug.
//
// ONLY THE QUEUE IS MOCKED. JOBS_Q.sendBatch is the one thing on this path that
// leaves the machine (workers/jobs' translate-need consumer, which then calls
// Google Translate). Everything else is real:
//
//   * a real in-memory SQLite carrying the real foodbankchange table and the
//     real foodbankchange_full view, driven through the real insertAdminNeed /
//     getFoodbankBySlug / getOpenFoodbankOptions;
//   * a real Hono app registered at all four production paths
//     (routes/admin/index.ts:100-103), because the trailing-slashless spelling
//     is Django's own and is what the "New Need" buttons link to;
//   * the real requireAdminAuth over a fake KV, so "an unauthenticated request
//     never reaches the handler" is a claim about the shipped middleware;
//   * the real verifyCsrf against the real issueCsrfToken, so one test below
//     GETs the form, takes the token the server actually minted and posts it
//     back -- the only shape of CSRF test that proves the check is not theatre;
//   * the real Nunjucks templates, so "the admin's values came back" is read
//     out of the HTML the admin would have received and not out of a context
//     object a broken template could still fail to render.
//
// MUTATION-TESTED, per TESTING.md's convention: the handler was copied into a
// scratchpad, deliberately broken, and this file re-run against each mutant
// through a vitest alias. 21 mutants, 21 dead -- clean_foodbank_need_text
// dropped from change_text and from excess_change_text; the redirect aimed at
// the rowid instead of need_id, and made a 301; the queue message keyed on
// need_id instead of the rowid; the queue sent always, and never; the required
// check and the publish-without-a-food-bank check each deleted; those two
// checks swapped; an empty excess stored as "" instead of NULL; the slug's
// trim() removed; the missing-food-bank guard reverted to Django's throw, and
// its GET half silenced; the CSRF check removed; the error re-render handed a
// blank form (issue #12's own shape, killed by five tests); the datalist
// emptied and widened to closed food banks; `published` pinned false;
// show_preview pinned true. TWO of those survived an earlier draft and are why
// two tests below look the way they do -- see "shows no preview on a refused
// save when the food bank has no website", which exists because the POST path
// computes show_preview separately from the GET path.
//
// RE-MUTATED ADVERSARIALLY afterwards, and this time the three packages/db
// modules the route writes THROUGH were mutated as well -- insertAdminNeed's
// INSERT, recomputeFoodbankNeedFields' two reads and its UPDATE, and
// getOpenFoodbankOptions' query -- because "the write actually happened" is a
// claim about the SQL, not about the handler that calls it. 86 mutants, 9
// survivors. Two of the nine are provably equivalent and were left alone: the
// handler's `.trim()` in `form.change_text.trim() === ""` and in the excess
// guard are both dead code, since cleanFoodbankNeedText's step 5 trims every
// line and step 3 trims the whole, so its output never has outer whitespace.
// The other seven were real gaps, closed by four new tests plus assertions
// added to two existing ones, each naming the mutant it kills:
//
//   * created/modified written with toISOString() instead of pyNow(), and
//     modified stamped separately from created;
//   * insertAdminNeed handing out one constant need_id;
//   * recomputeFoodbankNeedFields' last_need read losing `WHERE foodbank_id
//     = ?`, and its UPDATE losing `WHERE id = ?`;
//   * the required-field check re-reading the RAW body instead of the cleaned
//     text;
//   * adminPageContext's section, which lights the admin nav.

// ---------------------------------------------------------------------------
// The fixture schema. foodbankchange is migrations/0001_core.sql:109-122
// VERBATIM as amended by 0019 (which dropped foodbank_name off this table),
// because the column list is the thing insertAdminNeed's INSERT has to agree
// with -- a fixture that still carried foodbank_name would let a statement
// naming it pass here and fail in D1. foodbankchange_full is
// 0019_drop_foodbank_cache.sql:86-89 verbatim, LEFT JOIN included: it is what
// getNeedByUuid and every admin need list read, so it is where an orphan need
// (no food bank -- legal on this form) would disappear if the join direction
// were ever changed.
//
// `foodbank` is deliberately REDUCED to the columns this path touches -- the
// five getOpenFoodbankOptions selects, `url` (which decides the preview pane),
// and the two cached columns the recompute writes. getFoodbankBySlug does
// SELECT *, so a narrow table is a truthful stand-in for a wide one; the full
// 70-column definition would add nothing to any assertion here. The two UNIQUE
// indexes are kept because the seeds rely on slugs being unique, which is what
// makes "look up by slug" a meaningful operation at all.
// ---------------------------------------------------------------------------
const SCHEMA = `
CREATE TABLE foodbank (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL, slug TEXT NOT NULL, country TEXT NOT NULL,
  url TEXT NOT NULL,
  is_closed INTEGER NOT NULL,
  latest_need_id INTEGER,
  last_need TEXT
);
CREATE UNIQUE INDEX foodbank_name_uniq ON foodbank(name);
CREATE UNIQUE INDEX foodbank_slug_uniq ON foodbank(slug);

CREATE TABLE foodbankchange (
  id INTEGER PRIMARY KEY,
  need_id TEXT NOT NULL,
  foodbank_id INTEGER,
  distill_id TEXT, name TEXT, uri TEXT,
  change_text TEXT NOT NULL,
  change_text_original TEXT,
  excess_change_text TEXT, excess_change_text_original TEXT,
  published INTEGER NOT NULL DEFAULT 0,
  nonpertinent INTEGER,
  is_categorised INTEGER,
  notified TEXT, input_method TEXT NOT NULL,
  created TEXT NOT NULL, modified TEXT NOT NULL
);
CREATE UNIQUE INDEX need_need_id_uniq ON foodbankchange(need_id);

CREATE VIEW foodbankchange_full AS
  SELECT c.*, f.name AS foodbank_name, f.slug AS foodbank_slug
    FROM foodbankchange c
    LEFT JOIN foodbank f ON f.id = c.foodbank_id;
`;

type Bindable = null | number | bigint | string | Uint8Array;

// The slice of the D1 Sessions API packages/db uses, over node:sqlite. Copied
// from items.test.ts, which copied it from donationPoint.test.ts, with ONE
// addition that is load-bearing here: `run()` returns the engine's real
// meta.last_row_id. insertAdminNeed returns that value and this handler puts it
// straight on the translate-need queue message, so a fake that answered `{}`
// would make every queue assertion below agree with a handler enqueueing
// `undefined` -- which is the shape of bug the whole tier is about.
function d1Session(db: DatabaseSync): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      const info = db.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql: string) => statement(sql, []),
    // getFoodbankBySlug sends its food bank row and its latest-need row as ONE
    // batch() rather than two sequential awaits (packages/db/src/foodbank.ts).
    // The same adapter as packages/db/src/foodbankDetail.test.ts: statements
    // run in order and there is one result per input statement, in that order,
    // because the caller indexes straight into the array -- a batch that
    // reordered or coalesced results would hand back the wrong row without
    // erroring anywhere.
    batch: async (statements: Array<{ all: () => Promise<unknown> }>) => {
      const out: unknown[] = [];
      for (const each of statements) out.push(await each.all());
      return out;
    },
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

const ORIGIN = "https://www.givefood.org.uk";
const CSRF_SECRET = "test-csrf-secret-not-a-real-one";
const CSRF_RAW = "c".repeat(64);
// lib/csrf.ts's cookie format is `<raw>.<hmac>`, minted here with the real hmac
// so the real verifyCsrf accepts it -- and so a test that tampers with either
// half is refused for the real reason rather than by a stub.
const CSRF_COOKIE = `${CSRF_RAW}.${await hmacSha256Hex(CSRF_SECRET, CSRF_RAW)}`;

// lib/adminAuth.ts:61 SESSION_COOKIE_NAME and :250 sessionKvKey.
const SESSION_ID = "test-admin-session";
const SESSION_KEY = `admin-session:${SESSION_ID}`;
const ADMIN = { email: "someone@givefood.org.uk", name: "Some One", givenName: "Some", picture: "" };

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

// What the operator types when a food bank rings up: a multi-line list with
// real punctuation in it. Distinctive enough that "the values came back" is an
// assertion about THESE values and not about boilerplate an empty form would
// carry anyway.
const SHOPPING_LIST = "Tinned tomatoes\nChildren's toothpaste\nUHT milk";
const EXCESS_LIST = "Baked beans\nPasta";

let db: DatabaseSync;
let app: Hono<AppEnv>;
let env: AppEnv["Bindings"];
let sessions: Map<string, string>;
let sendBatch: ReturnType<typeof vi.fn>;
// Bound even though this handler never touches it, so that "no cache purge was
// enqueued" is a fact about the handler rather than about a binding that would
// have thrown had it been reached. See the purge test at the end of the create
// block for why that is worth asserting.
let purgeSend: ReturnType<typeof vi.fn>;

interface FoodbankSeed {
  id: number;
  name: string;
  slug: string;
  url?: string;
  isClosed?: 0 | 1;
  lastNeed?: string | null;
  latestNeedId?: number | null;
}

function seedFoodbank({ id, name, slug, url = "https://example.org/", isClosed = 0, lastNeed = null, latestNeedId = null }: FoodbankSeed): void {
  db.prepare("INSERT INTO foodbank (id, name, slug, country, url, is_closed, latest_need_id, last_need) VALUES (?, ?, ?, 'England', ?, ?, ?, ?)").run(
    id,
    name,
    slug,
    url,
    isClosed,
    latestNeedId,
    lastNeed,
  );
}

// A need row as the ETL and the needcheck crawler already left them -- these
// stand in for the 21,000 rows that were there before this endpoint existed,
// and are what a newly created need has to sort correctly against.
function seedNeed(row: { id: number; foodbankId: number | null; created: string; published?: 0 | 1 }): void {
  db.prepare(
    `INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, published, nonpertinent, is_categorised, input_method, created, modified)
     VALUES (?, ?, ?, 'Beans', ?, 0, 0, 'scrape', ?, ?)`,
  ).run(row.id, `seeded${row.id}`.padEnd(32, "0"), row.foodbankId, row.published ?? 0, row.created, row.created);
}

// Read the table back RAW. Reading through packages/db's own reader would make
// every write assertion pass or fail on the read function's bugs as well as the
// handler's -- and #34 was precisely a write that no SQL performed, so storage
// is what has to be inspected directly.
interface NeedRow {
  id: number;
  need_id: string;
  foodbank_id: number | null;
  change_text: string;
  excess_change_text: string | null;
  published: number;
  nonpertinent: number | null;
  is_categorised: number | null;
  input_method: string;
  created: string;
  modified: string;
}

function needRows(): NeedRow[] {
  return db
    .prepare(
      `SELECT id, need_id, foodbank_id, change_text, excess_change_text, published,
              nonpertinent, is_categorised, input_method, created, modified
         FROM foodbankchange ORDER BY id`,
    )
    .all() as never;
}

function onlyNeed(): NeedRow {
  const rows = needRows();
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

function foodbankRow(id: number): { last_need: string | null; latest_need_id: number | null } {
  return db.prepare("SELECT last_need, latest_need_id FROM foodbank WHERE id = ?").get(id) as never;
}

const SALISBURY = { id: 22, name: "Salisbury Foodbank", slug: "salisbury" };
const WESTBURY = { id: 12, name: "Westbury Foodbank", slug: "westbury" };

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  seedFoodbank({ ...SALISBURY, url: "https://salisburyfoodbank.org.uk/" });

  sessions = new Map<string, string>();
  // getAdminSession slides the expiry once more than half the 12h window has
  // gone (lib/adminAuth.ts:286-293); a freshly written expiry keeps every test
  // on the read-only path, so a stray KV put can never be mistaken for a write
  // the handler made.
  sessions.set(SESSION_KEY, JSON.stringify({ ...ADMIN, expiresAt: Date.now() + 12 * 60 * 60 * 1000 }));

  sendBatch = vi.fn(async () => {});
  purgeSend = vi.fn(async () => {});

  env = {
    DB: { withSession: () => d1Session(db) },
    SESSIONS: {
      get: async (key: string) => sessions.get(key) ?? null,
      put: async (key: string, value: string) => void sessions.set(key, value),
      delete: async (key: string) => void sessions.delete(key),
    },
    JOBS_Q: { sendBatch },
    PURGE_Q: { send: purgeSend },
    CSRF_SECRET,
    GMAP_STATIC_KEY: "",
    GMAP_GEOCODE_KEY: "",
    D1_DATABASE_NAME: "givefood-test",
  } as unknown as AppEnv["Bindings"];

  app = new Hono<AppEnv>();
  // middleware/serverTiming.ts's elapsedMs reads this; index.ts sets it for
  // every request before anything else runs.
  app.use("*", async (c, next) => {
    c.set("requestStartTime", performance.now());
    await next();
  });
  // The REAL gate, mounted the way routes/admin/index.ts:85 mounts it.
  app.use("/admin/*", requireAdminAuth);
  // routes/admin/index.ts:100-103, verbatim. All four registrations, because
  // Django's own URL (gfadmin/urls/needs.py:10) uniquely has NO trailing slash
  // and both spellings are in circulation.
  app.get("/admin/need/new/", adminNeedNew);
  app.post("/admin/need/new/", adminNeedNew);
  app.get("/admin/need/new", adminNeedNew);
  app.post("/admin/need/new", adminNeedNew);
  // The 500 page issue #12 is about. Labelled rather than left to become an
  // unhandled rejection, so a regression reads as "expected 200, got 500: ..."
  // instead of a vitest crash.
  app.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));
});

interface Opts {
  signedIn?: boolean;
  /** what goes in the POST body; null omits the field entirely */
  csrfField?: string | null;
  /** what goes in the __Host-csrf cookie; null omits the cookie */
  csrfCookie?: string | null;
  origin?: string | null;
  secFetchSite?: string | null;
}

function cookieHeader(opts: Opts): string | undefined {
  const parts: string[] = [];
  if (opts.signedIn !== false) parts.push(`__Host-gfsession=${SESSION_ID}`);
  const csrf = opts.csrfCookie === undefined ? CSRF_COOKIE : opts.csrfCookie;
  if (csrf !== null) parts.push(`__Host-csrf=${csrf}`);
  return parts.length ? parts.join("; ") : undefined;
}

interface Result {
  res: Response;
  html: string;
}

async function get(path: string, opts: Opts = {}): Promise<Result> {
  const headers = new Headers();
  const cookie = cookieHeader(opts);
  if (cookie) headers.set("Cookie", cookie);
  const res = await app.fetch(new Request(`${ORIGIN}${path}`, { headers }), env, execCtx);
  return { res, html: res.status === 302 ? "" : await res.text() };
}

async function post(path: string, fields: Record<string, string>, opts: Opts = {}): Promise<Result> {
  const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded" });
  const cookie = cookieHeader(opts);
  if (cookie) headers.set("Cookie", cookie);
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin !== null) headers.set("Origin", origin);
  const site = opts.secFetchSite === undefined ? "same-origin" : opts.secFetchSite;
  if (site !== null) headers.set("Sec-Fetch-Site", site);

  const body = new URLSearchParams(fields);
  const token = opts.csrfField === undefined ? CSRF_RAW : opts.csrfField;
  if (token !== null) body.set("csrf_token", token);

  const res = await app.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: body.toString() }), env, execCtx);
  // Read the body once, here: several assertions want it and a Response body
  // can only be consumed once.
  return { res, html: res.status === 302 ? "" : await res.text() };
}

// Nunjucks autoescapes, so a value round-tripping through the form comes back
// entity-encoded. Decoded here rather than asserted around, so expectations
// stay the strings a human would type into the box.
function decode(value: string): string {
  return value
    .replace(/&#34;|&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// The banner need_new.njk:44 renders `error` into, read as the admin reads it.
function errorBanner(html: string): string | null {
  const match = html.match(/<div class="notification is-danger is-light">([\s\S]*?)<\/div>/);
  return match ? decode(match[1]!.trim()) : null;
}

// What is actually IN the food bank box, not what the handler passed to the
// template -- need_new.njk:66 puts `value` before the remaining attributes.
function slugField(html: string): string | null {
  const match = html.match(/id="id_foodbank"[^>]*value="([^"]*)"/);
  return match ? decode(match[1]!) : null;
}

// A <textarea>'s value is its BODY, not an attribute, which is the one place a
// "re-render the form with the values" fix can be half-done: the inputs come
// back and the twelve lines of shopping list do not.
function textarea(html: string, id: string): string | null {
  const match = html.match(new RegExp(`id="${id}"[^>]*>([\\s\\S]*?)</textarea>`));
  return match ? decode(match[1]!) : null;
}

function publishedChecked(html: string): boolean {
  return /name="published" value="1" checked/.test(html);
}

function csrfField(html: string): string | null {
  const match = html.match(/name="csrf_token" value="([^"]*)"/);
  return match ? match[1]! : null;
}

// The datalist need_new.njk:67-71 renders, in render order -- so this is the
// assertion for BOTH which food banks the operator can pick by name and what
// order they are offered in.
function datalist(html: string): Array<[string, string]> {
  const block = html.match(/<datalist id="foodbank_slugs">([\s\S]*?)<\/datalist>/);
  if (!block) return [];
  return [...block[1]!.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map((m) => [decode(m[1]!), decode(m[2]!)]);
}

function hasPreview(html: string): boolean {
  return html.includes('<iframe class="preview-frame"');
}

// The messages the handler put on the jobs queue, flattened out of sendBatch's
// [{ body }] envelope.
function queuedMessages(): Array<{ type: string; needId: number; language: string }> {
  return sendBatch.mock.calls.flatMap((call) => (call[0] as Array<{ body: { type: string; needId: number; language: string } }>).map((m) => m.body));
}

// ===========================================================================
// GET -- gfadmin/views.py:1926-1945's `else` branch, the unbound form.
// ===========================================================================
describe("adminNeedNew on GET", () => {
  it("renders an empty New Need form", async () => {
    const { res, html } = await get("/admin/need/new/");

    expect(res.status).toBe(200);
    // views.py:1922's page_title verbatim.
    expect(html).toContain("<h2>New Need</h2>");
    expect(slugField(html)).toBe("");
    expect(textarea(html, "id_change_text")).toBe("");
    expect(textarea(html, "id_excess_change_text")).toBe("");
    expect(publishedChecked(html)).toBe(false);
    expect(errorBanner(html)).toBeNull();
    // Without a token in the page the form is unsubmittable, so everything else
    // this file asserts about preserved values would be preserved somewhere the
    // admin cannot press Submit from.
    expect(csrfField(html)).toBe(CSRF_RAW);
    // No `?foodbank=` seed, so nothing to preview -- and the template's own
    // fix for admin/form.html:8-10 means the single column is full width
    // rather than a half-width strip.
    expect(hasPreview(html)).toBe(false);
    // The nav's lit tab, which is nothing but the `section` string this
    // handler passes to adminPageContext (page.njk:46). MUTANT KILLED:
    // `adminPageContext(c, "foodbanks")` -- a one-word edit shared with a
    // dozen sibling handlers, which changed nothing else on the page and
    // survived every other assertion in this file.
    expect(html).toContain('<a class="navbar-item is-active" href="/admin/needs/">Needs</a>');
  });

  // The datalist IS the port's replacement for Django's name-based <select>
  // (forms.py:232's ModelChoiceField). Losing it would leave a bare slug box
  // and an operator who has a NAME on the phone and not a slug -- which is the
  // whole reason the module comment says it was added back.
  //
  // THE ORDER IS THE TEST. The ids are deliberately not in name order, so
  // three plausible implementations give three different answers: an
  // unordered SELECT comes back in rowid order (bath 5, Westbury 12,
  // Salisbury 22); a raw SQL `ORDER BY name` under SQLite's byte-wise BINARY
  // collation gives Salisbury, Westbury, bath, because every capital sorts
  // before any lowercase; only getOpenFoodbankOptions' Intl.Collator sort
  // gives the order below, which is what production's Postgres en_US.utf8
  // ordering did and what an operator scanning the list expects.
  it("offers open food banks as name/slug pairs, collated the way production ordered them", async () => {
    seedFoodbank(WESTBURY);
    seedFoodbank({ id: 5, name: "bath Foodbank", slug: "bath" });

    const options = datalist((await get("/admin/need/new/")).html);

    expect(options).toEqual([
      ["bath", "bath Foodbank"],
      ["salisbury", "Salisbury Foodbank"],
      ["westbury", "Westbury Foodbank"],
    ]);
  });

  // A filter that does nothing passes every test that only seeds matching rows,
  // so a closed food bank is seeded specifically to be ABSENT. Django's
  // NeedForm listed every food bank open or closed (forms.py:232's unscoped
  // queryset); getOpenFoodbankOptions is the port's narrowing, and the
  // datalist's whole job is to be the list an operator picks from -- a closed
  // food bank has no business being offered as this month's need.
  //
  // It stays REACHABLE, though, which is the other half of the decision and is
  // asserted by "still saves a need against a closed food bank" below.
  it("leaves closed food banks out of the datalist", async () => {
    seedFoodbank({ id: 99, name: "Ashford Foodbank", slug: "ashford", isClosed: 1 });

    const options = datalist((await get("/admin/need/new/")).html);

    expect(options.map(([slug]) => slug)).toEqual(["salisbury"]);
    expect((await get("/admin/need/new/")).html).not.toContain("Ashford Foodbank");
  });

  // views.py:1926-1928's `initial={"foodbank": foodbank}` -- how BOTH "New
  // Need" buttons on the food bank page arrive here
  // (gfadmin/templates/admin/foodbank.html:394 and :461, which the port had
  // silently dropped and this module's comment restores).
  it("pre-fills the food bank from ?foodbank= and shows its site alongside", async () => {
    const { res, html } = await get("/admin/need/new/?foodbank=salisbury");

    expect(res.status).toBe(200);
    expect(slugField(html)).toBe("salisbury");
    // A prefill is not an error: a banner here would tell the admin something
    // is wrong before they have typed anything.
    expect(errorBanner(html)).toBeNull();
    // need_new.njk's FIX for admin/form.html:31-37, which views.py resolved a
    // food bank for and then never put in template_vars -- so this pane has
    // never rendered in production. Through the port's own safe proxy
    // signature, never Django's raw `?url=`.
    expect(hasPreview(html)).toBe(true);
    expect(html).toContain("/admin/proxy/?foodbank=salisbury&amp;field=url");
  });

  // `show_preview` is `!!foodbank.url` and the column is NOT NULL, so "" is
  // what "no website" looks like in this database. Rendering the iframe anyway
  // would put an admin-authenticated frame on /admin/proxy/?foodbank=<slug>
  // with no target, for every food bank we have no URL for.
  it("shows no preview pane for a food bank with no website", async () => {
    seedFoodbank({ ...WESTBURY, url: "" });

    const { html } = await get("/admin/need/new/?foodbank=westbury");

    expect(slugField(html)).toBe("westbury");
    expect(hasPreview(html)).toBe(false);
  });

  // views.py:1928's `Foodbank.objects.get(slug=foodbank_slug)` is unguarded and
  // raises DoesNotExist -> 500 on a bad slug, which is reachable from any stale
  // bookmark or hand-edited URL. Fixed here, and asserted as a 200 with a
  // banner rather than merely "not a 500": the difference matters because this
  // page is also where a mistyped slug on a POST lands (see the refusals
  // below), and the two paths share the same re-render.
  it("names an unknown ?foodbank= slug in a banner instead of 500ing the way Django does", async () => {
    const { res, html } = await get("/admin/need/new/?foodbank=nosuchbank");

    expect(res.status).toBe(200);
    expect(errorBanner(html)).toBe('No food bank with slug "nosuchbank"');
    // The typo stays in the box so it can be corrected, rather than being
    // blanked and retyped from memory.
    expect(slugField(html)).toBe("nosuchbank");
    expect(hasPreview(html)).toBe(false);
  });

  // The slug is attacker-influenced text echoed back into an admin-only page,
  // and the error path echoes it verbatim. Nunjucks autoescape is what stops
  // that being stored-free reflected XSS against a signed-in admin, and it is
  // exactly the kind of thing a later `| safe` added to make some other
  // message render would quietly undo.
  it("escapes the slug it echoes back into the error", async () => {
    const { html } = await get("/admin/need/new/?foodbank=%3Cscript%3Ealert(1)%3C%2Fscript%3E");

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(errorBanner(html)).toBe('No food bank with slug "<script>alert(1)</script>"');
  });

  // GET and POST are ONE function branching on c.req.method (needNew.ts:79),
  // which is exactly the shape in which a write leaks onto the read path.
  // Asserted across all three GET shapes, including the one that resolves a
  // food bank -- a stray recompute there would rewrite last_need/latest_need_id
  // on a food bank nobody had touched.
  it("writes nothing on any GET", async () => {
    seedNeed({ id: 900, foodbankId: SALISBURY.id, created: "2026-08-01 09:00:00.000000", published: 1 });
    db.prepare("UPDATE foodbank SET last_need = ?, latest_need_id = ? WHERE id = ?").run("2026-08-01 09:00:00.000000", 900, SALISBURY.id);
    const before = needRows();

    await get("/admin/need/new/");
    await get("/admin/need/new/?foodbank=salisbury");
    await get("/admin/need/new/?foodbank=nosuchbank");

    expect(needRows()).toEqual(before);
    expect(foodbankRow(SALISBURY.id)).toEqual({ last_need: "2026-08-01 09:00:00.000000", latest_need_id: 900 });
    expect(sendBatch).not.toHaveBeenCalled();
  });

  // gfadmin/urls/needs.py:10 is `path("need/new", ...)` -- the ONE admin URL in
  // Django with no trailing slash, so that is the spelling every "New Need"
  // button and every bookmark carries. Both are registered
  // (routes/admin/index.ts:100-103) and both must serve the same page; a
  // regression here is a 404 on the link the maintainer actually clicks.
  it("serves the trailing-slashless URL Django's own link uses", async () => {
    const { res, html } = await get("/admin/need/new?foodbank=salisbury");

    expect(res.status).toBe(200);
    expect(html).toContain("<h2>New Need</h2>");
    expect(slugField(html)).toBe("salisbury");
  });

  // The gate is the real requireAdminAuth: getAdminSession short-circuits to
  // null with no __Host-gfsession cookie, so this is the shipped middleware and
  // not a stand-in. The redirect target has to carry the full path, or an admin
  // signing in from a "New Need" link lands somewhere else.
  it("redirects an unauthenticated visitor before the handler runs", async () => {
    const { res } = await get("/admin/need/new/", { signedIn: false });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fneed%2Fnew%2F");
    expect(needRows()).toEqual([]);
  });
});

// ===========================================================================
// POST, the save. views.py:1931-1934's `if form.is_valid(): need = form.save();
// return redirect("admin:need", id=need.need_id)`.
// ===========================================================================
describe("adminNeedNew creating a need", () => {
  // ISSUE #34's CLASS AT ITS NARROWEST: a redirect is not evidence of a save.
  // All four fields the form declares (needNew.ts's module comment: foodbank,
  // change_text, excess_change_text, published) are set here and every one is
  // read back out of SQLite, because a handler that parsed them, passed them
  // down and wrote none of them would produce this exact 302.
  it("stores every field the form declares", async () => {
    const { res } = await post("/admin/need/new/", {
      foodbank_slug: "salisbury",
      change_text: SHOPPING_LIST,
      excess_change_text: EXCESS_LIST,
      published: "1",
    });

    expect(res.status).toBe(302);
    const row = onlyNeed();
    expect(row.foodbank_id).toBe(SALISBURY.id);
    expect(row.change_text).toBe(SHOPPING_LIST);
    expect(row.excess_change_text).toBe(EXCESS_LIST);
    expect(row.published).toBe(1);
    // The three values no form field can reach, written as literals by
    // insertAdminNeed: a "scrape" here would credit the crawler with a
    // hand-typed list, and a NULL nonpertinent would keep the new need out of
    // the review queue's `nonpertinent = 0` filter entirely.
    expect(row.input_method).toBe("typed");
    expect(row.nonpertinent).toBe(0);
    expect(row.is_categorised).toBe(0);
  });

  // THE TWO COLUMNS THE ASSERTIONS ABOVE STEP OVER. `created` is what every
  // admin need list, the review queue and the food bank's cached `last_need`
  // are ordered and compared by, and it is written in Django's own
  // `str(datetime)` spelling by pyNow() -- "YYYY-MM-DD HH:MM:SS.ffffff".
  //
  // MUTANTS KILLED: `const now = new Date().toISOString()` in
  // insertAdminNeed, and `?6, ?6` widened so `modified` comes off a
  // different clock than `created`. The first survived every other test in
  // this file, and it is ticket #9 exactly (packages/models/src/pyDatetime.ts
  // header): D1 stores timestamps as TEXT and SQLite compares TEXT
  // byte-wise, so "T" (0x54) beats " " (0x20) and an ISO-spelled 08:00 row
  // sorts ABOVE a Django-spelled 20:00 one. That is not cosmetic here --
  // insertAdminNeed's own recompute then runs `ORDER BY created DESC LIMIT
  // 1` over this new row and the food bank's 21,000 migrated ones, which is
  // the query pyDatetime.ts records picking the wrong "latest published
  // need" during the 2026-09-05 migration.
  it("stamps created and modified in Django's spelling, both off one clock", async () => {
    seedNeed({ id: 900, foodbankId: SALISBURY.id, created: "2026-08-01 09:00:00.000000" });

    await post("/admin/need/new/", { foodbank_slug: "salisbury", change_text: SHOPPING_LIST });

    const created = needRows().find((r) => r.id !== 900)!;
    expect(created.created).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
    // One `now`, bound twice -- an insert whose modified predates its created
    // would make "recently edited" sorts nonsense from the row's first day.
    expect(created.modified).toBe(created.created);
    // And the consequence, through the same ORDER BY the need lists use: the
    // new row must sort above a Django-spelled row from an earlier date.
    const newest = db.prepare("SELECT need_id FROM foodbankchange ORDER BY created DESC LIMIT 1").get() as { need_id: string };
    expect(newest.need_id).toBe(created.need_id);
  });

  // TWO SAVES IN A ROW -- an afternoon in which three food banks ring in --
  // and the only shape in which need_id's uniqueness is a fact rather than an
  // assumption. Every other test here creates exactly ONE need, so an insert
  // handing out a single constant need_id satisfies all of them.
  //
  // MUTANT KILLED: `const needId = "a".repeat(32)` in insertAdminNeed. The
  // second save then hits need_need_id_uniq, 500s onto the page issue #12 is
  // about, and loses the second shopping list -- and it survived, because the
  // one other place two needs are created in a row (the cache-purge test
  // below) asserted the purge queue was empty and never looked at the second
  // response at all. That is the "assertions on status alone" failure with
  // the status left out entirely.
  it("gives every save its own need_id, so the second list typed in is a second row", async () => {
    const first = await post("/admin/need/new/", { foodbank_slug: "salisbury", change_text: SHOPPING_LIST });
    const second = await post("/admin/need/new/", { foodbank_slug: "salisbury", change_text: "Nappies\nWashing powder" });

    expect(first.res.status).toBe(302);
    expect(second.res.status).toBe(302);
    const rows = needRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.need_id).not.toBe(rows[1]!.need_id);
    expect(rows.map((r) => r.change_text)).toEqual([SHOPPING_LIST, "Nappies\nWashing powder"]);
    // And two different need pages to land on, since the redirect is keyed on
    // need_id: one URL for both saves would send the operator back to the
    // first list every time.
    expect(first.res.headers.get("Location")).not.toBe(second.res.headers.get("Location"));
  });

  // DIVERGENCE FROM DJANGO, pinned as a hazard rather than reported as a live
  // bug. `published` is `!!body.published` (needNew.ts:110), so ANY non-empty
  // value ticks the box -- including the literal string "false", which Django
  // maps to False: CheckboxInput.value_from_datadict does
  // `values = {"true": True, "false": False}` before `bool(value)`
  // (django/forms/widgets.py:713-723, read out of the Django 6.1 vendored in
  // the reference checkout's .venv rather than recalled).
  //
  // Unreachable from need_new.njk, whose checkbox posts "1" or is absent
  // altogether, so nothing is broken today. It is written down because this is
  // the shape that bites the moment someone adds the usual "send false when
  // unchecked" hidden companion field, or ports a client that spells a
  // boolean out: every need it touched would silently publish, translate and
  // go live. The empty string is the one falsy spelling both agree on.
  it("treats any non-empty published value as ticked, including the string Django reads as false", async () => {
    await post("/admin/need/new/", { foodbank_slug: "salisbury", change_text: SHOPPING_LIST, published: "false" });

    expect(onlyNeed().published).toBe(1);
    expect(queuedMessages()).toHaveLength(3);

    db.exec("DELETE FROM foodbankchange");
    await post("/admin/need/new/", { foodbank_slug: "salisbury", change_text: SHOPPING_LIST, published: "" });

    expect(onlyNeed().published).toBe(0);
  });

  // THE REDIRECT TARGET IS A SEPARATE CLAIM from "the row exists". Django's
  // `redirect("admin:need", id=need.need_id)` goes to the need's own page, and
  // this handler has TWO identifiers to hand -- the numeric rowid it puts on
  // the queue and the 32-char need_id the URLs use. Sending the rowid would
  // still be a plausible-looking 302 and would land the admin on a 404 every
  // time they created a need. Proved by resolving the URL's id through the real
  // getNeedByUuid, which is what /admin/need/:id/ does.
  it("redirects to the new need's own page, keyed on need_id and not the rowid", async () => {
    seedNeed({ id: 900, foodbankId: SALISBURY.id, created: "2026-08-01 09:00:00.000000" });

    const { res } = await post("/admin/need/new/", { foodbank_slug: "salisbury", change_text: SHOPPING_LIST });

    const location = res.headers.get("Location")!;
    const created = needRows().find((r) => r.id !== 900)!;
    expect(location).toBe(`/admin/need/${created.need_id}/`);
    expect(location).not.toBe(`/admin/need/${created.id}/`);
    expect(created.need_id).toMatch(/^[0-9a-f]{32}$/);
    // The page that URL resolves to reads through foodbankchange_full; this is
    // the read half actually running against the row just written.
    const found = await getNeedByUuid(d1Session(db) as never, location.split("/")[3]!);
    expect(found?.change_text).toBe(SHOPPING_LIST);
  });

  // TICKET #6, the reason cleanFoodbankNeedText moved into @givefood/models and
  // onto this path. A browser submits <textarea> content with CRLF (HTML spec),
  // Django's clean() normalises it away, and this handler did not -- so a need
  // typed in the admin was stored with \r\n. Every downstream reader splits on
  // "\n", leaving a trailing \r on every line but the last, and those readers
  // compare item text against foodbankchangeline.item, which holds no \r in any
  // of its 333,208 rows. The categorise page's suggestions therefore missed for
  // every item except the final one.
  //
  // Asserted on the STORED COLUMN rather than on the response, because the
  // damage was invisible in the admin and only showed up three screens away.
  it("strips the CRLF a browser textarea submits, which is ticket #6", async () => {
    await post("/admin/need/new/", {
      foodbank_slug: "salisbury",
      change_text: "Tinned tomatoes\r\nChildren's toothpaste\r\nUHT milk",
      excess_change_text: "Baked beans\r\nPasta",
    });

    const row = onlyNeed();
    expect(row.change_text).toBe(SHOPPING_LIST);
    expect(row.change_text).not.toContain("\r");
    expect(row.excess_change_text).toBe(EXCESS_LIST);
    expect(row.excess_change_text).not.toContain("\r");
  });

  // The other five operations of givefood/utils/text.py:91-115
  // clean_foodbank_need_text(), which Django ran inside FoodbankChange.save()
  // on EVERY write including the form path (models/needs.py:295-297). They are
  // asserted through the ROUTE because the route is now the only place they
  // happen -- packages/db's insertAdminNeed deliberately stores its argument
  // verbatim, so a handler that stopped calling clean would write dirty text
  // and nothing below it would notice.
  it("cleans the shopping list the way Django's save() did", async () => {
    await post("/admin/need/new/", {
      foodbank_slug: "salisbury",
      // entity, double space, blank line, leading/trailing per-line whitespace,
      // and the Uht miscapitalisation -- one of each, in one list.
      change_text: "  Beans &amp; Peas  \n\n  Uht  Milk\n   Rice   \n",
      excess_change_text: "  Uht  Milk  ",
    });

    const row = onlyNeed();
    expect(row.change_text).toBe("Beans & Peas\nUHT Milk\nRice");
    expect(row.excess_change_text).toBe("UHT Milk");
  });

  // NULL, never "". `excess_list` downstream is `need.excess_change_text ?
  // split("\n") : []` -- an empty string is falsy there too -- but `has_excess`
  // and the whole "Excess" block in the notification email hang off the same
  // value, and production holds NULLs.
  it("stores an untouched excess box as NULL, not an empty string", async () => {
    await post("/admin/need/new/", { foodbank_slug: "salisbury", change_text: SHOPPING_LIST });

    expect(onlyNeed().excess_change_text).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbankchange WHERE excess_change_text = ''").get()).toEqual({ n: 0 });
  });

  // Same decision reached through the cleaner's trim rather than an empty box:
  // a box holding only spaces or a stray newline must not become a stored " ",
  // which would be neither an excess list nor absent.
  it("treats a whitespace-only excess box as absent", async () => {
    await post("/admin/need/new/", { foodbank_slug: "salisbury", change_text: SHOPPING_LIST, excess_change_text: "   \n  \n" });

    expect(onlyNeed().excess_change_text).toBeNull();
  });

  // foodbank is `required=False` on Django's NeedForm (forms.py:232) and
  // foodbank_id is NULLABLE, so an unassigned need is legal -- it is what the
  // operator creates when a list arrives before they know which food bank sent
  // it. The row must also stay FINDABLE: foodbankchange_full is a LEFT JOIN and
  // every admin need list reads the view rather than the table, so an INNER
  // JOIN there would delete every orphan need from the admin UI while leaving
  // the rows on disk.
  it("stores an unassigned need and leaves it visible through the view the admin lists read", async () => {
    const { res } = await post("/admin/need/new/", { change_text: SHOPPING_LIST });

    expect(res.status).toBe(302);
    const row = onlyNeed();
    expect(row.foodbank_id).toBeNull();
    expect(db.prepare("SELECT foodbank_id, foodbank_name FROM foodbankchange_full WHERE need_id = ?").get(row.need_id)).toEqual({
      foodbank_id: null,
      foodbank_name: null,
    });
  });

  // The food bank's own cached columns, which is the second write this one POST
  // performs and the one nothing on screen would reveal. `last_need` feeds the
  // food bank's admin page and the needcheck scheduler; `latest_need_id` is
  // what /needs/at/<slug>/ renders. Both are asserted against the row this POST
  // wrote, so a recompute pointed at the wrong food bank or skipped entirely
  // fails here rather than showing up as a six-week-old date on a page.
  it("moves the food bank's cached last_need and latest_need_id onto a published need", async () => {
    seedFoodbank({ ...WESTBURY, lastNeed: "2026-08-01 09:00:00.000000", latestNeedId: 900 });
    seedNeed({ id: 900, foodbankId: WESTBURY.id, created: "2026-08-01 09:00:00.000000", published: 1 });

    await post("/admin/need/new/", { foodbank_slug: "westbury", change_text: SHOPPING_LIST, published: "1" });

    const created = needRows().find((r) => r.id !== 900)!;
    expect(foodbankRow(WESTBURY.id)).toEqual({ last_need: created.created, latest_need_id: created.id });
  });

  // The deliberate divergence, from the route's side. Django recomputes only
  // `if self.foodbank and self.published` (needs.py:301-302), leaving last_need
  // -- a plain "when did we last see ANY need" timestamp -- stale after an
  // unpublished insert; the port recomputes unconditionally. The fix must not
  // overreach either: latest_need_id stays where it was, because promoting an
  // unpublished need would put an unreviewed shopping list on the public page.
  it("moves last_need but not latest_need_id when the new need is unpublished", async () => {
    seedFoodbank({ ...WESTBURY, lastNeed: "2026-08-01 09:00:00.000000", latestNeedId: 900 });
    seedNeed({ id: 900, foodbankId: WESTBURY.id, created: "2026-08-01 09:00:00.000000", published: 1 });

    await post("/admin/need/new/", { foodbank_slug: "westbury", change_text: SHOPPING_LIST });

    const created = needRows().find((r) => r.id !== 900)!;
    expect(foodbankRow(WESTBURY.id)).toEqual({ last_need: created.created, latest_need_id: 900 });
  });

  // THE SECOND WRITE, SCOPED. Everything above proves the recompute moves the
  // right food bank's columns; nothing above proves it leaves everyone else's
  // alone, because every test here has exactly one food bank holding needs --
  // so an unscoped query returns the right row by accident.
  //
  // MUTANTS KILLED, both in recomputeFoodbankNeedFields and both survivors of
  // the whole file before this test:
  //   * the last_need read with `WHERE foodbank_id = ?` deleted, which gives
  //     this food bank the newest need on the SITE;
  //   * the UPDATE widened past `WHERE id = ?`, which is the expensive one --
  //     one list typed in for one food bank rewrites last_need and
  //     latest_need_id for EVERY food bank, pointing each one's public page
  //     and needcheck schedule at a need belonging to somebody else.
  //
  // Salisbury's need is dated AHEAD of the clock deliberately. insertAdminNeed
  // stamps pyNow(), so the row this POST creates is otherwise always the
  // newest on the table and an unfiltered `ORDER BY created DESC LIMIT 1`
  // answers correctly by luck; only a rival row that would WIN that sort
  // separates the scoped query from the unscoped one.
  it("moves the cached columns of the food bank it was given and of no other", async () => {
    seedFoodbank({ ...WESTBURY, lastNeed: "2026-08-01 09:00:00.000000", latestNeedId: 900 });
    seedNeed({ id: 900, foodbankId: WESTBURY.id, created: "2026-08-01 09:00:00.000000", published: 1 });
    seedNeed({ id: 901, foodbankId: SALISBURY.id, created: "2027-01-01 00:00:00.000000", published: 1 });
    db.prepare("UPDATE foodbank SET last_need = ?, latest_need_id = ? WHERE id = ?").run("2027-01-01 00:00:00.000000", 901, SALISBURY.id);

    await post("/admin/need/new/", { foodbank_slug: "westbury", change_text: SHOPPING_LIST, published: "1" });

    const created = needRows().find((r) => r.id !== 900 && r.id !== 901)!;
    expect(foodbankRow(WESTBURY.id)).toEqual({ last_need: created.created, latest_need_id: created.id });
    expect(foodbankRow(SALISBURY.id)).toEqual({ last_need: "2027-01-01 00:00:00.000000", latest_need_id: 901 });
  });

  // models/needs.py:305-317's `do_translate = self.published`: Django fans out
  // one translate task per language whenever the saved need is published, from
  // the FORM path as much as from the Publish button. Three languages here, not
  // Django's 19 (PLAN.md §2.7.1).
  //
  // THE needId IS THE POINT. TranslateNeedMessage.needId is the numeric rowid
  // (workers/jobs/src/queues/translateNeed.ts:17, consumed by getNeedById), NOT
  // the need_id the redirect uses -- send the wrong one and every message is
  // dropped by the consumer's `if (!need) return`, silently, so a published
  // need would simply never appear in Welsh.
  it("enqueues one translate task per language, keyed on the numeric id the consumer reads", async () => {
    seedNeed({ id: 900, foodbankId: SALISBURY.id, created: "2026-08-01 09:00:00.000000" });

    await post("/admin/need/new/", { foodbank_slug: "salisbury", change_text: SHOPPING_LIST, published: "1" });

    const created = needRows().find((r) => r.id !== 900)!;
    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(queuedMessages()).toEqual([
      { type: "translate-need", needId: created.id, language: "cy" },
      { type: "translate-need", needId: created.id, language: "ga" },
      { type: "translate-need", needId: created.id, language: "gd" },
    ]);
    // Not the rowid of the pre-existing need, and not the need_id string.
    expect(created.id).not.toBe(900);
  });

  // The other direction. An unpublished need is a draft in the review queue;
  // translating it would spend Google Translate quota on text nobody has
  // approved and would leave translations for a need the public cannot see.
  it("enqueues nothing for an unpublished need", async () => {
    await post("/admin/need/new/", { foodbank_slug: "salisbury", change_text: SHOPPING_LIST });

    expect(sendBatch).not.toHaveBeenCalled();
  });

  // SUSPECT, pinned as current behaviour rather than fixed (TESTING.md: tests
  // pin what the code does). Publishing a need is what changes
  // /needs/at/<slug>/ for a visitor, and the sibling route says so in as many
  // words: needs.ts's handlePublishTransition calls purgeFoodbank() on BOTH
  // transitions, commented "the most frequent reason a cached page goes
  // stale". This handler makes the same state change -- the recompute moves
  // latest_need_id, which is the row that page renders -- and enqueues
  // nothing; needNew.ts does not mention PURGE_Q at all. So a list phoned in,
  // typed here and published is invisible to the public until the `fb-<slug>`
  // tag's TTL expires or some unrelated edit purges the food bank, which is
  // exactly the silent, no-error class this tier is about.
  //
  // Both directions asserted, because the published one is the reachable
  // damage and the unpublished one is what a fix must NOT start purging for
  // (nothing public changed, and a purge per draft would flush a food bank's
  // whole page set on every keystroke of the review queue).
  it("enqueues no cache purge for the food bank it just published a need for", async () => {
    await post("/admin/need/new/", { foodbank_slug: "salisbury", change_text: SHOPPING_LIST, published: "1" });

    expect(onlyNeed().published).toBe(1);
    expect(foodbankRow(SALISBURY.id).latest_need_id).toBe(onlyNeed().id);
    expect(purgeSend).not.toHaveBeenCalled();

    const draft = await post("/admin/need/new/", { foodbank_slug: "salisbury", change_text: SHOPPING_LIST });

    // The second save's own outcome, asserted rather than assumed: "no purge
    // was enqueued" is only evidence about the purge queue if the save
    // actually got as far as writing. Without these two lines a second POST
    // that 500ed -- which is exactly what a constant need_id does against
    // need_need_id_uniq -- read as a pass.
    expect(draft.res.status).toBe(302);
    expect(needRows()).toHaveLength(2);
    expect(purgeSend).not.toHaveBeenCalled();
  });

  // The other half of the datalist decision: closed food banks are left OUT of
  // the list but stay reachable by typing the slug, which is exactly why the
  // field is free text rather than a <select>. A need still arrives for a food
  // bank that closed last month, and refusing it would send the operator to
  // SQL.
  it("still saves a need against a closed food bank typed in by slug", async () => {
    seedFoodbank({ id: 99, name: "Ashford Foodbank", slug: "ashford", isClosed: 1 });

    const { res } = await post("/admin/need/new/", { foodbank_slug: "ashford", change_text: SHOPPING_LIST });

    expect(res.status).toBe(302);
    expect(onlyNeed().foodbank_id).toBe(99);
  });

  // parseAdminFields-style trimming is done by hand on this form
  // (needNew.ts:106), and it matters more here than on a name field: a slug
  // copy-pasted out of a URL or an email arrives with a trailing space, the
  // lookup is byte-exact, and without the trim the operator would be told the
  // food bank does not exist.
  it("trims a pasted food bank slug rather than failing the lookup on a stray space", async () => {
    const { res } = await post("/admin/need/new/", { foodbank_slug: "  salisbury  ", change_text: SHOPPING_LIST });

    expect(res.status).toBe(302);
    expect(onlyNeed().foodbank_id).toBe(SALISBURY.id);
  });

  it("saves identically through the trailing-slashless URL", async () => {
    const { res } = await post("/admin/need/new", { foodbank_slug: "salisbury", change_text: SHOPPING_LIST });

    expect(res.status).toBe(302);
    expect(onlyNeed().change_text).toBe(SHOPPING_LIST);
  });

  // SUSPECT, pinned as-is rather than fixed (TESTING.md: tests pin current
  // behaviour). The queue send happens AFTER the INSERT and is awaited, so a
  // queue outage turns a save that DID happen into a 500 the admin reads as
  // "it failed" -- and pressing Submit again writes a second, duplicate need,
  // since nothing on this form is unique. Django had the same ordering
  // (needs.py enqueues after super().save()) but its enqueue was to a local
  // task table rather than a network call, so the window is new.
  //
  // Asserted here so that the day someone moves the send behind
  // c.executionCtx.waitUntil() or ahead of the redirect, the change is a
  // deliberate one against a test that says what today's behaviour is.
  it("has already written the row when a queue failure 500s the response", async () => {
    sendBatch.mockRejectedValueOnce(new Error("queue unavailable"));

    const { res } = await post("/admin/need/new/", { foodbank_slug: "salisbury", change_text: SHOPPING_LIST, published: "1" });

    expect(res.status).toBe(500);
    // The need is in the database and published, despite the error page.
    expect(onlyNeed().published).toBe(1);
    expect(onlyNeed().change_text).toBe(SHOPPING_LIST);
  });
});

// ===========================================================================
// POST, refused. Django's `if form.is_valid()` else-branch: the SAME page
// re-rendered with the errors attached and every value still bound to it --
// which is the behaviour issue #12 was reported for losing.
// ===========================================================================
describe("adminNeedNew refusing a save", () => {
  // givefood/models/needs.py:64 -- `change_text = models.TextField(
  // verbose_name="Shopping List")` with no blank=True, so NeedForm builds a
  // REQUIRED CharField and Django answers with "This field is required."
  // verbatim. An empty need is not inert: with a food bank set it feeds the
  // cached-need recompute, and ticked as published it would be translated and
  // reach /needs/at/<slug>/ as an empty list.
  it("refuses an empty shopping list with Django's own message, and writes nothing", async () => {
    const { res, html } = await post("/admin/need/new/", { foodbank_slug: "salisbury", change_text: "", excess_change_text: EXCESS_LIST });

    // 200, not 4xx: a Django ModelForm that fails validation re-renders the
    // same page, it does not return an error status. Pinned deliberately --
    // the sibling location/donation-point forms answer 400 on their refusals,
    // so the difference is a decision and not drift.
    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
    expect(errorBanner(html)).toBe("This field is required.");
    expect(needRows()).toEqual([]);
    expect(sendBatch).not.toHaveBeenCalled();
  });

  // Cleaning happens BEFORE the required check, so a list of nothing but blank
  // lines and spaces -- what a stray paste produces -- is empty by the time it
  // is checked, rather than being stored as a need whose every line is blank.
  it("treats a whitespace-only shopping list as empty", async () => {
    const { res, html } = await post("/admin/need/new/", { foodbank_slug: "salisbury", change_text: "   \n\n  \n" });

    expect(res.status).toBe(200);
    expect(errorBanner(html)).toBe("This field is required.");
    expect(needRows()).toEqual([]);
  });

  // THE CHECK IS ON THE CLEANED TEXT, i.e. on exactly the string the INSERT
  // would carry -- not on what the admin typed. `&nbsp;` is the one input
  // that separates the two: it is non-empty as submitted, and
  // cleanFoodbankNeedText decodes it to U+00A0 and drops it (step 4's
  // blank-line filter, step 5's per-line trim), so the value reaching the
  // column would be "".
  //
  // MUTANT KILLED: the guard re-reading `body.change_text` instead of
  // `form.change_text`. It survived every whitespace case already in this
  // file -- a raw "   \n\n  \n" is empty under .trim() too -- and stored an
  // EMPTY need with a 302: a row that then feeds the cached-need recompute,
  // and, with Published ticked, gets translated into three languages and
  // rendered as an empty shopping list on /needs/at/<slug>/. An operator
  // pasting out of a Word document is how a lone &nbsp; arrives.
  it("refuses a shopping list that is only an entity for a blank", async () => {
    const { res, html } = await post("/admin/need/new/", { foodbank_slug: "salisbury", change_text: "&nbsp;" });

    expect(res.status).toBe(200);
    expect(errorBanner(html)).toBe("This field is required.");
    expect(needRows()).toEqual([]);
    expect(sendBatch).not.toHaveBeenCalled();
  });

  // FoodbankChange.clean() (needs.py:77-79) declares this invalid and
  // ModelForm.full_clean() DOES enforce it on this path -- unlike need_publish,
  // where Django never calls clean() at all and can therefore publish an orphan
  // need. Message verbatim from the model.
  it("refuses to publish a need with no food bank", async () => {
    const { res, html } = await post("/admin/need/new/", { change_text: SHOPPING_LIST, published: "1" });

    expect(res.status).toBe(200);
    expect(errorBanner(html)).toBe("Need to set a food bank to publish need");
    expect(needRows()).toEqual([]);
    expect(sendBatch).not.toHaveBeenCalled();
  });

  // THE #12 LOSS, on this form. A mistyped slug is the single likeliest thing
  // to go wrong here -- the operator is typing a name into a slug box -- and
  // before the guard views.py:1928's unguarded .get() would have 500ed, taking
  // the thirteen lines they had just transcribed off a phone call with it.
  //
  // Every field is asserted back, out of the HTML: the two textareas
  // especially, because a textarea's value is its body rather than an
  // attribute, which is where a half-done "re-render with the values" fix
  // leaves the inputs full and the shopping list empty.
  it("hands back everything typed when the food bank slug is wrong", async () => {
    const { res, html } = await post("/admin/need/new/", {
      foodbank_slug: "salisbry",
      change_text: SHOPPING_LIST,
      excess_change_text: EXCESS_LIST,
      published: "1",
    });

    expect(res.status).toBe(200);
    expect(errorBanner(html)).toBe('No food bank with slug "salisbry"');
    expect(needRows()).toEqual([]);

    expect(slugField(html)).toBe("salisbry");
    expect(textarea(html, "id_change_text")).toBe(SHOPPING_LIST);
    expect(textarea(html, "id_excess_change_text")).toBe(EXCESS_LIST);
    // The checkbox is a value too, and the one most easily lost: it re-renders
    // as an attribute rather than as text, so a `toContain` sweep over the HTML
    // would pass while the admin silently re-submitted an unpublished need.
    expect(publishedChecked(html)).toBe(true);
  });

  // The same preservation on the two errors that do not involve the slug, so
  // that "the form comes back whole" is a property of the re-render and not of
  // one branch. The empty shopping list is the field being complained about;
  // the excess list beside it is what the admin would otherwise retype.
  it("hands back the rest of the form when the shopping list is the thing missing", async () => {
    const { html } = await post("/admin/need/new/", {
      foodbank_slug: "salisbury",
      change_text: "",
      excess_change_text: EXCESS_LIST,
      published: "1",
    });

    expect(slugField(html)).toBe("salisbury");
    expect(textarea(html, "id_excess_change_text")).toBe(EXCESS_LIST);
    expect(publishedChecked(html)).toBe(true);
  });

  // A refused page has to be RE-SUBMITTABLE, which is a different claim from
  // "the values are still there": without a CSRF token the next press of Submit
  // is a 403, and without the datalist the operator has lost the only way to
  // find a food bank by name -- which is precisely what a mistyped slug means
  // they need. needNew.ts:66 fetches the options inside renderForm rather than
  // at each call site for exactly this reason.
  it("comes back submittable, with the food bank list still on the page", async () => {
    seedFoodbank(WESTBURY);

    const { html } = await post("/admin/need/new/", { foodbank_slug: "salisbry", change_text: SHOPPING_LIST });

    expect(csrfField(html)).toBe(CSRF_RAW);
    expect(html).toContain("Submit");
    expect(datalist(html)).toEqual([
      ["salisbury", "Salisbury Foodbank"],
      ["westbury", "Westbury Foodbank"],
    ]);
  });

  // ORDER, matching Django's field-validation-then-clean(): ModelForm runs each
  // field's own validation first and only reaches Model.clean() afterwards, so
  // a submission that is invalid in both ways reports "This field is required."
  // and not the food-bank rule. The port's single `error` slot keeps that
  // order (needNew.ts:135 ahead of :143).
  it("reports the missing shopping list ahead of the publish-without-a-food-bank rule", async () => {
    const { html } = await post("/admin/need/new/", { change_text: "", published: "1" });

    expect(errorBanner(html)).toBe("This field is required.");
    expect(html).not.toContain("Need to set a food bank");
  });

  // The slug lookup happens before either check (needNew.ts:116), so a
  // submission that is wrong in two ways reports the slug first. That is the
  // right order for this form -- the food bank is the field everything else
  // depends on -- but it is worth pinning: reordering it would mean an operator
  // fixing a shopping list, re-submitting, and only THEN being told the food
  // bank does not exist.
  it("reports an unknown slug ahead of the empty shopping list", async () => {
    const { html } = await post("/admin/need/new/", { foodbank_slug: "salisbry", change_text: "" });

    expect(errorBanner(html)).toBe('No food bank with slug "salisbry"');
  });

  // Slug matching is byte-exact -- getFoodbankBySlug is a plain `WHERE slug =
  // ?` and SQLite's default collation is BINARY -- so the capitalised form a
  // human would type is NOT found. Pinned rather than "helpfully" lower-cased
  // here, because the datalist exists to stop this happening and because a
  // lookup that normalised its input would diverge from every other slug read
  // in the port. What matters is that it is a banner and not a 500.
  it("does not resolve a capitalised slug, and says so instead of 500ing", async () => {
    const { res, html } = await post("/admin/need/new/", { foodbank_slug: "Salisbury", change_text: SHOPPING_LIST });

    expect(res.status).toBe(200);
    expect(errorBanner(html)).toBe('No food bank with slug "Salisbury"');
    expect(needRows()).toEqual([]);
  });

  // DIVERGENCE FROM DJANGO, pinned. Django re-rendered a BOUND form, i.e. the
  // raw POST data, so an admin whose refused submission held "Uht  milk" got
  // "Uht  milk" back in the box. This port cleans before it validates, so the
  // cleaned text is what returns. It is the same divergence the location form
  // has with parseAdminFields' normalised values, it is what the next Submit
  // would have stored anyway, and it is asserted here so that a future "why did
  // my spacing change" question has an answer written down.
  it("hands back the CLEANED text rather than the raw submission", async () => {
    const { html } = await post("/admin/need/new/", { foodbank_slug: "salisbry", change_text: "  Uht  milk  \n\n  Beans &amp; Peas" });

    expect(textarea(html, "id_change_text")).toBe("UHT milk\nBeans & Peas");
  });

  // The preview pane follows the food bank, not the outcome: a refused save
  // whose slug DID resolve keeps the site alongside the form, which is what the
  // operator is reading the list off. `show_preview` is threaded through both
  // refusal paths (needNew.ts:136 and :144) rather than hardcoded false, and
  // this is the assertion that says so.
  it("keeps the food bank's site alongside a refused save", async () => {
    const { html } = await post("/admin/need/new/", { foodbank_slug: "salisbury", change_text: "" });

    expect(hasPreview(html)).toBe(true);
    expect(html).toContain("/admin/proxy/?foodbank=salisbury&amp;field=url");
  });

  // And the negative, which is a genuinely separate branch: the POST path
  // computes show_preview itself (needNew.ts:124) rather than reusing the GET's,
  // so `showPreview = true` in place of `!!foodbank.url` is invisible to the
  // GET-side test above. It would frame /admin/proxy/?foodbank=<slug>&field=url
  // for a food bank we hold no URL for -- an empty admin-authenticated iframe
  // on every refused save for the food banks whose website we never found.
  it("shows no preview on a refused save when the food bank has no website", async () => {
    seedFoodbank({ ...WESTBURY, url: "" });

    const { html } = await post("/admin/need/new/", { foodbank_slug: "westbury", change_text: "" });

    expect(errorBanner(html)).toBe("This field is required.");
    expect(hasPreview(html)).toBe(false);
  });
});

// ===========================================================================
// CSRF. Django's CsrfViewMiddleware is commented out in production
// (settings.py:97), so this whole check is the port's own (PLAN.md §6.9 R3) and
// nothing upstream can vouch for it.
// ===========================================================================
describe("adminNeedNew CSRF", () => {
  it.each([
    ["the form field is missing", { csrfField: null } as Opts],
    ["the form field is empty", { csrfField: "" } as Opts],
    ["the form field is somebody else's token", { csrfField: "a".repeat(64) } as Opts],
    ["the cookie is missing", { csrfCookie: null } as Opts],
    // The raw half is right and only the signature is wrong, so a check that
    // compared the field to the cookie's first segment alone would let this
    // through -- which is the whole difference between lib/csrf.ts's SIGNED
    // double-submit and a plain one an attacker can plant from a sibling
    // subdomain.
    ["the cookie signature does not verify", { csrfCookie: `${CSRF_RAW}.${"0".repeat(64)}` } as Opts],
    ["the cookie has no signature at all", { csrfCookie: CSRF_RAW } as Opts],
    ["the Origin is another site", { origin: "https://evil.invalid" } as Opts],
    ["Sec-Fetch-Site says cross-site", { secFetchSite: "cross-site" } as Opts],
  ])("refuses to create a need when %s", async (_why, opts) => {
    const { res, html } = await post("/admin/need/new/", { foodbank_slug: "salisbury", change_text: SHOPPING_LIST, published: "1" }, opts);

    expect(res.status).toBe(403);
    expect(html).toBe("Forbidden");
    // Both writes, and the queue: a forged submission must not create a need,
    // must not move the food bank's cached columns, and must not spend
    // translation quota.
    expect(needRows()).toEqual([]);
    expect(foodbankRow(SALISBURY.id)).toEqual({ last_need: null, latest_need_id: null });
    expect(sendBatch).not.toHaveBeenCalled();
  });

  // The check runs FIRST (needNew.ts:82, ahead of parsing anything else), so a
  // forged request learns nothing about the form's rules. Asserted with a body
  // that is invalid in two different ways: 403, never the 200-with-a-banner a
  // real admin would get.
  it("refuses before it validates, so a forged request learns nothing", async () => {
    const { res, html } = await post("/admin/need/new/", { change_text: "", published: "1" }, { csrfField: null });

    expect(res.status).toBe(403);
    expect(html).not.toContain("This field is required.");
    expect(html).not.toContain("Need to set a food bank");
  });

  // The trailing-slashless registration is a SEPARATE route entry, and a check
  // wired into only one of the two spellings would leave the other open.
  it("covers the trailing-slashless URL too", async () => {
    const { res } = await post("/admin/need/new", { foodbank_slug: "salisbury", change_text: SHOPPING_LIST }, { csrfField: null });

    expect(res.status).toBe(403);
    expect(needRows()).toEqual([]);
  });

  // Browsers that send neither header are still allowed through -- lib/csrf.ts
  // enforces Origin and Sec-Fetch-Site only WHEN PRESENT, because older
  // browsers omit both and the signed double-submit is the real protection.
  // Pinned so that "we also require Origin" is a decision someone makes on
  // purpose rather than a silent tightening that starts 403ing real admins.
  it("accepts a valid token from a client that sends neither Origin nor Sec-Fetch-Site", async () => {
    const { res } = await post(
      "/admin/need/new/",
      { foodbank_slug: "salisbury", change_text: SHOPPING_LIST },
      { origin: null, secFetchSite: null },
    );

    expect(res.status).toBe(302);
    expect(needRows()).toHaveLength(1);
  });

  // A GET carries no token and must still render, or the form can never be
  // reached in the first place.
  it("does not gate the GET", async () => {
    const { res } = await get("/admin/need/new/", { csrfCookie: null });

    expect(res.status).toBe(200);
  });

  // THE END-TO-END PROOF, and the only shape of CSRF test that shows the
  // mechanism joins up: no token is manufactured here. The form is fetched with
  // no CSRF cookie at all, the server mints one, and the raw token is taken
  // from the hidden field it rendered while the signed half is taken from the
  // Set-Cookie it sent. Posting those two back must succeed AND store the need.
  // If issueCsrfToken and verifyCsrf ever stop agreeing -- a changed cookie
  // name, a different separator, a re-minted token per render -- every admin
  // save in the port breaks, and this is the test that says so.
  it("accepts the token a fresh render actually minted", async () => {
    const form = await get("/admin/need/new/", { csrfCookie: null });
    expect(form.res.status).toBe(200);

    const minted = /__Host-csrf=([^;]+)/.exec(form.res.headers.get("Set-Cookie") ?? "")?.[1];
    const rendered = csrfField(form.html);
    expect(minted).toBeTruthy();
    expect(rendered).toBeTruthy();
    // The hidden field is the RAW half of the cookie, never the whole thing --
    // shipping the signature into the page would defeat the point of signing.
    expect(minted).toBe(`${rendered}.${await hmacSha256Hex(CSRF_SECRET, rendered!)}`);

    const { res } = await post(
      "/admin/need/new/",
      { foodbank_slug: "salisbury", change_text: SHOPPING_LIST },
      { csrfField: rendered, csrfCookie: minted },
    );

    expect(res.status).toBe(302);
    expect(onlyNeed().change_text).toBe(SHOPPING_LIST);
  });
});

// ===========================================================================
// Auth. requireAdminAuth is mounted on the sub-app rather than on the handler,
// so the POST half needs its own assertion: the CSRF cookie alone must not be
// enough to write.
// ===========================================================================
describe("adminNeedNew authentication", () => {
  it("never lets an unauthenticated POST reach the handler", async () => {
    const { res } = await post("/admin/need/new/", { foodbank_slug: "salisbury", change_text: SHOPPING_LIST, published: "1" }, { signedIn: false });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fneed%2Fnew%2F");
    expect(needRows()).toEqual([]);
    expect(sendBatch).not.toHaveBeenCalled();
  });

  // A session id the KV store does not hold -- an expired or revoked session,
  // which is what an admin's laptop sends the morning after. It must be refused
  // the same way a missing cookie is, rather than falling through to a handler
  // with no `adminUser` on the context.
  it("refuses a session the store no longer holds", async () => {
    sessions.delete(SESSION_KEY);

    const { res } = await post("/admin/need/new/", { foodbank_slug: "salisbury", change_text: SHOPPING_LIST });

    expect(res.status).toBe(302);
    expect(needRows()).toEqual([]);
  });
});
