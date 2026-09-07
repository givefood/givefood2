import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { ExecutionContext } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../types";
import { requireAdminAuth } from "../../middleware/adminAuth";
import { noStore } from "../../middleware/noStore";
import { tryAppendSlashRedirect } from "../../lib/appendSlash";
import { adminCrawlSetJson } from "./crawlSet";
import { adminApp } from "./index";

// gfadmin/views.py:3283-3323 crawl_set_json(), as reached through the URL it is
// actually registered at -- gfadmin/urls/crawl_sets.py:7's
// `crawl-set/<int:crawl_set_id>.json`, ported at routes/admin/index.ts:282 as
// `/crawl-set/:idJson{[0-9]+\.json}`.
//
// WHAT IS ALREADY COVERED ELSEWHERE, so that this file can be about the route.
// packages/db/src/foodbankTabs.test.ts drives getCrawlSetJson itself against the
// real migrations -- the Postgres NULLS-LAST emulation, the deleted-need branch,
// the two counts, str(timedelta). None of that is re-litigated here. What no
// test anywhere covers is the fifteen lines BETWEEN the URL and that function:
// the ".json" suffix being sliced off the param, the id reaching the query, the
// auth gate in front of it, and -- the whole reason this handler is not a
// one-liner -- its deliberate refusal to answer a miss with c.notFound().
//
// THE BUG THIS HANDLER EXISTS TO AVOID (PLAN.md §Phase 9, and the shipped-first
// version quoted in lib/appendSlash.test.ts:566). c.notFound() inside a sub-app
// does not stop at the sub-app: it falls through to the PARENT's app.notFound(),
// which is index.ts:650's APPEND_SLASH probe -- the same request re-dispatched
// with a trailing slash to see whether THAT resolves. A miss on this endpoint
// then answers 301 to `<id>.json/`, an HTML page, to a
// `fetch().then(r => r.json())` poll loop that runs every five seconds
// (admin/crawl_set.njk:86-88). So every test below that expects a miss asserts
// the BODY and the absence of a Location, not just the 404 -- the status is the
// half that was never wrong.
//
// AND THE 301 IS STILL LIVE, which was NOT what this file set out to show. The
// handler's own comment attributes it to a sibling route loose enough to answer
// the slashed form, and today's `/crawl-set/:id{[0-9]+}/` is not loose enough --
// so on that reading the hazard would be gone and `c.text` merely tidy. It is
// not gone: the probe is built as `new Request(slashed, { method: "HEAD" })` and
// carries no cookie, so requireAdminAuth answers it with a 302, and the probe
// treats any status but 404/501 as "the slashed URL resolves". Every slashless
// URL under /admin/ therefore looks resolvable to it. See the two tests in "a
// crawl set that does not exist" -- one runs the real handler, one runs the
// shipped-first c.notFound() version through the identical, real registration.
//
// NOTHING IS MOCKED. This handler imports getCrawlSetJson and dbSession and
// nothing else -- no template, no CSRF, no fetch that leaves the machine -- so
// the real router, the real auth middleware, the real query and a real SQLite
// database all run. The only stand-ins are the two bindings themselves: D1
// (node:sqlite behind the slice of the Sessions API packages/db is handed) and
// the SESSIONS KV the admin session lives in.
//
// MUTATION-TESTED TWICE. First by mounting deliberately broken copies of the
// handler on the same routes (buildApp's `handler` option, which the
// c.notFound() counterfactual below still uses), and then -- an adversarial
// second pass -- by breaking crawlSet.ts and routes/admin/index.ts on disk from
// a scratchpad script and re-running this file against each break.
//
// KILLED IN THE HANDLER: dropping the slice; slicing from index 1; a hardcoded
// crawl set id; `if (!id)` in place of Number.isInteger, and dropping that guard
// altogether; reading the param under the wrong name; c.text(JSON.stringify(...))
// in place of c.json; returning only `data.items`; a 201 instead of a 200;
// dropping the `await`; dropping the `if (!data)` guard; c.notFound() in place
// of c.text; that miss answered 200, answered as JSON, or with its body re-cased.
//
// KILLED IN THE REGISTRATION, by the "production route registration" block at
// the foot of this file, and by NOTHING ELSE HERE -- all five survived while the
// hand-built mirror was the only router in the suite: the `{[0-9]+\.json}`
// constraint relaxed; `.all` in place of `.get`; the `:idJson` param renamed;
// the path renamed; index.ts:85's `use("*", requireAdminAuth)` deleted. Also
// killed: `dbSession(c)` swapped for a "first-primary" session, which changes
// nothing in the response and sends every poll tick to the primary region.
//
// TWO SURVIVORS, both equivalent mutants rather than gaps. `slice(0, -4)`
// instead of `slice(0, -".json".length)` leaves "10." behind, and Number("10.")
// is 10, so no input reachable through this route can tell the two apart; and
// relaxing the sibling DETAIL route's `{[0-9]+}` constraint, for the reason
// given on the slashed-spelling test below.

type Bindable = null | number | bigint | string | Uint8Array;

// Mirrors packages/db/migrations/0008_needcheck.sql:17-51 verbatim for the two
// crawl tables -- including crawlitem_crawlset_foodbank_uniq, because it is what
// forces every multi-item crawl set seeded below to span several food banks, as
// production's do. `foodbank` and `foodbankchange` carry only the columns this
// query's two joins actually read (0001_core.sql:109-122 for the change table,
// as amended by 0019_drop_foodbank_cache.sql, which is why no foodbank_name copy
// appears on either side): a column the query does not name cannot be the thing
// that breaks, and a fixture that transcribes columns nobody reads is a second
// copy of the truth waiting to drift from the first.
const SCHEMA = `
CREATE TABLE foodbank (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL
);
CREATE TABLE foodbankchange (
  id INTEGER PRIMARY KEY,
  need_id TEXT NOT NULL,
  foodbank_id INTEGER,
  published INTEGER NOT NULL DEFAULT 0,
  nonpertinent INTEGER
);
CREATE UNIQUE INDEX need_need_id_uniq ON foodbankchange(need_id);
CREATE TABLE crawlset (
  id INTEGER PRIMARY KEY,
  crawl_type TEXT NOT NULL,
  run_id TEXT,
  start TEXT NOT NULL,
  finish TEXT,
  expected INTEGER,
  remaining INTEGER
);
CREATE UNIQUE INDEX crawlset_runid_uniq ON crawlset(run_id) WHERE run_id IS NOT NULL;
CREATE TABLE crawlitem (
  id INTEGER PRIMARY KEY,
  crawl_set_id INTEGER,
  crawl_type TEXT NOT NULL,
  start TEXT NOT NULL,
  finish TEXT,
  foodbank_id INTEGER NOT NULL,
  url TEXT,
  need_id INTEGER
);
CREATE INDEX crawlitem_crawlset_idx ON crawlitem(crawl_set_id);
CREATE UNIQUE INDEX crawlitem_crawlset_foodbank_uniq ON crawlitem(crawl_set_id, foodbank_id);
`;

// The slice of the D1 Sessions API packages/db is handed, backed by node:sqlite.
// Copied from foodbankLocation.test.ts (and its descendants in packages/db) so
// every tier drives the real SQL through one adapter, with one addition: it
// records the statements it is asked to prepare and the ones actually RUN, so
// "this GET wrote nothing" can be asserted as a fact about the SQL rather than
// inferred from a row count that a compensating pair of writes would satisfy.
function d1Session(db: DatabaseSync, log: { prepared: string[]; ran: string[] }) {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      log.ran.push(sql);
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return {
    prepare: (sql: string) => {
      log.prepared.push(sql);
      return statement(sql, []);
    },
    getBookmark: () => null,
  };
}

// EVERY TIMESTAMP HERE IS DJANGO'S FORMAT: "YYYY-MM-DD HH:MM:SS.ffffff", which
// is what pyNow() writes and what migration 0022 rewrote the imported Postgres
// rows into. These columns are TEXT, every ORDER BY over them is a byte-wise
// string comparison, and parseD1Timestamp is written against this exact spelling
// -- seeding toISOString() values would test a database this app does not have.
const SET_START = "2026-09-05 15:00:00.000000";
const SET_FINISH = "2026-09-05 15:04:32.000000";
const NEED_UUID = "abcdef1234567890abcdef1234567890"; // 32-char dashless, as foodbankchange.need_id holds

function seedFoodbank(db: DatabaseSync, id: number, name: string, slug: string): void {
  db.prepare("INSERT INTO foodbank (id, name, slug) VALUES (?, ?, ?)").run(id, name, slug);
}

function seedCrawlSet(db: DatabaseSync, row: { id: number; crawl_type: string; start: string; finish?: string | null }): void {
  db.prepare("INSERT INTO crawlset (id, crawl_type, start, finish) VALUES (?, ?, ?, ?)").run(
    row.id,
    row.crawl_type,
    row.start,
    row.finish ?? null,
  );
}

function seedCrawlItem(
  db: DatabaseSync,
  row: { id: number; crawl_set_id: number | null; start: string; finish?: string | null; foodbank_id: number; url?: string | null; need_id?: number | null },
): void {
  db.prepare("INSERT INTO crawlitem (id, crawl_set_id, crawl_type, start, finish, foodbank_id, url, need_id) VALUES (?, ?, 'need', ?, ?, ?, ?, ?)").run(
    row.id,
    row.crawl_set_id,
    row.start,
    row.finish ?? null,
    row.foodbank_id,
    row.url ?? null,
    row.need_id ?? null,
  );
}

const SESSION_COOKIE = "__Host-gfsession=poll-session";
const SESSION_KV_KEY = "admin-session:poll-session";

let db: DatabaseSync;
let sqlLog: { prepared: string[]; ran: string[] };
let kv: { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };
let env: AppEnv["Bindings"];
let withSession: ReturnType<typeof vi.fn>;

function makeCtx() {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } satisfies ExecutionContext;
}

// The registration from routes/admin/index.ts, reproduced in the order and with
// the constraints it actually uses: requireAdminAuth on the sub-app
// (index.ts:85), the crawl-set detail route BEFORE the .json one (195, then
// 282), the sub-app grafted on with app.route("/admin", ...) (index.ts:637), and
// the parent's notFound() wired to the real APPEND_SLASH probe (index.ts:650).
// All four are load-bearing here and a flat app reproduces none of them:
// c.notFound() inside a sub-app resolves to the PARENT's handler, the sub-app
// rebases the path the auth redirect has to echo back, the probe re-enters this
// same router, and re-entering it runs requireAdminAuth again -- cookieless, as
// the probe builds its own Request.
//
// Registration ORDER is part of the fidelity, not decoration: Hono matches in
// the order routes are declared (the reason index.ts:100 and :179 carry their
// own warnings about literal-before-param), so the detail route being declared
// first is the arrangement under which the .json route has to keep working.
//
// The detail page in the mirror is a one-line stand-in rather than the real
// adminCrawlSetDetail, so that these tests turn on this endpoint's behaviour and
// never on a Nunjucks render. Nothing here asserts anything about its output;
// it exists to occupy the URL the APPEND_SLASH probe lands on.
//
// AND A MIRROR CANNOT FAIL WHEN THE THING IT MIRRORS CHANGES, which is why
// `router: "real"` exists beside it and why the last describe block in this file
// uses it. Mutating routes/admin/index.ts:282 -- relaxing the `{[0-9]+\.json}`
// constraint, registering it with .all instead of .get, renaming the `:idJson`
// param the handler reads by name, renaming the path -- and deleting
// index.ts:85's `adminApp.use("*", requireAdminAuth)` all left this file green
// while the mirror was the only router in it. "real" is the imported adminApp
// itself, mounted the way workers/site/src/index.ts:637 mounts it; seven sibling
// suites (articles.test.ts, jobs.test.ts, query.test.ts and friends) import it
// the same way, so this is the house pattern rather than a new one. The mirror
// stays for everything else, because it is what makes the c.notFound()
// counterfactual and the relaxed-constraint hazard expressible at all.
//
// THE PRICE of importing adminApp, stated so it is not discovered by surprise:
// its module graph reaches @givefood/templates, whose env.ts imports
// src/generated/precompiled -- a gitignored build artefact. So this file, like
// the seven suites that already import adminApp, needs the precompile step to
// have run (pnpm typecheck and pnpm dev both run it) and cannot pass against a
// checkout where it has not. Nothing in this file renders a template; the
// dependency is the import graph's, not this endpoint's.
function buildApp(options: { looseJsonRoute?: boolean; handler?: typeof adminCrawlSetJson; router?: "mirror" | "real"; noStore?: boolean } = {}) {
  const probes: (Response | null)[] = [];

  let mounted: Hono<AppEnv>;
  if (options.router === "real") {
    mounted = adminApp;
  } else {
    const mirror = new Hono<AppEnv>();
    mirror.use("*", requireAdminAuth);
    mirror.get("/crawl-set/:id{[0-9]+}/", (c) => c.text(`detail page for ${c.req.param("id")}`));
    const handler = options.handler ?? adminCrawlSetJson;
    if (options.looseJsonRoute) {
      mirror.get("/crawl-set/:idJson", handler);
    } else {
      mirror.get("/crawl-set/:idJson{[0-9]+\\.json}", handler);
    }
    mounted = mirror;
  }

  const app = new Hono<AppEnv>();
  // index.ts:137-138. Off by default so the rest of the file keeps asserting
  // this handler's OWN headers with nothing layered over them; the one test
  // that wants it says so.
  if (options.noStore) {
    app.use("/admin", noStore);
    app.use("/admin/*", noStore);
  }
  app.route("/admin", mounted);
  app.notFound(async (c) => {
    const redirect = await tryAppendSlashRedirect(c, app);
    probes.push(redirect);
    return redirect ?? c.html("<html>the real 404 page</html>", 404);
  });
  // Named rather than left to Hono's default, so a handler that throws reads as
  // "expected 200, got 500: <message>" instead of a bare 500 plus a stack in the
  // run output. index.ts:658's own onError renders the HTML 500 page; nothing
  // here asserts against that page, only against the fact of the throw.
  app.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));

  const ctx = makeCtx();
  return {
    probes,
    fetch: (path: string, init: RequestInit & { signedIn?: boolean } = {}) => {
      const { signedIn = true, ...rest } = init;
      const headers = signedIn ? { Cookie: SESSION_COOKIE, ...(rest.headers as Record<string, string> | undefined) } : rest.headers;
      return app.fetch(new Request(`https://www.givefood.org.uk${path}`, { ...rest, headers }), env, ctx);
    },
  };
}

// One scenario, seeded once, shaped so that every ORDER BY key and every
// predicate in the query has something to get wrong. Crawl set 11 and the ad-hoc
// item exist ONLY to be excluded -- a filter that does nothing passes any test
// that seeds only matching rows.
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);

  seedFoodbank(db, 1, "Salisbury", "salisbury");
  seedFoodbank(db, 2, "Amesbury", "amesbury");
  seedFoodbank(db, 3, "Wilton", "wilton");
  seedFoodbank(db, 4, "Downton", "downton");
  db.prepare("INSERT INTO foodbankchange (id, need_id, foodbank_id, published, nonpertinent) VALUES (41, ?, 1, 1, 0)").run(NEED_UUID);

  // The set under test: finished, two items, one of which produced a need.
  seedCrawlSet(db, { id: 10, crawl_type: "need", start: SET_START, finish: SET_FINISH });
  seedCrawlItem(db, {
    id: 100,
    crawl_set_id: 10,
    start: "2026-09-05 15:00:01.000000",
    finish: "2026-09-05 15:00:03.500000",
    foodbank_id: 1,
    url: "https://salisbury.foodbank.org.uk/shopping-list/",
    need_id: 41,
  });
  seedCrawlItem(db, { id: 101, crawl_set_id: 10, start: "2026-09-05 15:00:02.000000", finish: null, foodbank_id: 2, need_id: null });

  // A DIFFERENT crawl set, and an ad-hoc item belonging to none (crawl_set_id
  // NULL, which `= ?` is never true for -- 0008's own comment: a Force Check
  // item). Both must be absent from set 10's payload.
  seedCrawlSet(db, { id: 11, crawl_type: "article", start: "2026-09-04 09:00:00.000000", finish: null });
  seedCrawlItem(db, { id: 110, crawl_set_id: 11, start: "2026-09-04 09:00:01.000000", foodbank_id: 3 });
  seedCrawlItem(db, { id: 120, crawl_set_id: null, start: "2026-09-05 16:00:00.000000", foodbank_id: 4 });

  sqlLog = { prepared: [], ran: [] };
  const session = d1Session(db, sqlLog);
  withSession = vi.fn(() => session);

  // The real getAdminSession reads `admin-session:<id>` out of KV and slides the
  // TTL only once the session is past its halfway point (lib/adminAuth.ts:286),
  // so a session written "now" is read without a write -- see the KV-cost test.
  kv = {
    get: vi.fn(async (key: string) =>
      key === SESSION_KV_KEY
        ? JSON.stringify({
            email: "admin@givefood.org.uk",
            name: "An Admin",
            givenName: "An",
            picture: "",
            expiresAt: Date.now() + 12 * 60 * 60 * 1000,
          })
        : null,
    ),
    put: vi.fn(async () => {}),
  };

  env = { DB: { withSession }, SESSIONS: kv } as unknown as AppEnv["Bindings"];
});

// The whole payload for crawl set 10, spelled out rather than compared against a
// second call to getCrawlSetJson: the point of an end-to-end assertion is that
// nothing between the query and the wire reshaped it, and comparing the handler
// to the function it calls could not detect that.
const SET_10_JSON = {
  crawl_type: "need",
  start: SET_START,
  finish: SET_FINISH,
  time_taken: "0:04:32",
  item_count: 2,
  object_count: 1,
  items: [
    {
      foodbank_name: "Salisbury",
      foodbank_slug: "salisbury",
      start: "2026-09-05 15:00:01.000000",
      finish: "2026-09-05 15:00:03.500000",
      time_taken_ms: 2500,
      url: "https://salisbury.foodbank.org.uk/shopping-list/",
      object: {
        url: `/admin/need/${NEED_UUID}/`,
        class_name: "FoodbankChange",
        need_id_short: "abcdef1",
        nonpertinent: false,
        published: true,
      },
    },
    {
      foodbank_name: "Amesbury",
      foodbank_slug: "amesbury",
      start: "2026-09-05 15:00:02.000000",
      finish: null,
      time_taken_ms: null,
      url: null,
      object: null,
    },
  ],
};

describe("adminCrawlSetJson", () => {
  // THE READ ACTUALLY HAPPENED, and it happened for the crawl set named in the
  // URL. A 200 with a plausible body is not evidence of that on its own: the id
  // is sliced out of a param that also carries the ".json" suffix, and a slice
  // that took the wrong number of characters, or a handler that ignored the
  // param, would still answer 200 for SOME crawl set. So both sets are requested
  // through the same app and the two payloads have to differ in the way the
  // seeded rows differ.
  it("serves the crawl set the URL names, whole, out of the database", async () => {
    const h = buildApp();

    const res = await h.fetch("/admin/crawl-set/10.json");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SET_10_JSON);

    const other = await h.fetch("/admin/crawl-set/11.json");
    expect(other.status).toBe(200);
    expect(await other.json()).toMatchObject({ crawl_type: "article", finish: null, time_taken: null, item_count: 1 });
  });

  // A crawl set page is read as "these are MY crawl's items", and the two counts
  // beside them are read as this crawl's productivity. Set 11's item and the
  // ad-hoc one are seeded precisely so their absence can be asserted: a lost
  // `WHERE ci.crawl_set_id = ?` would show every crawl item in the database on
  // one page, and the poll would overwrite the table with it every five seconds.
  it("excludes another set's items and the ad-hoc ones", async () => {
    const h = buildApp();

    const body = (await (await h.fetch("/admin/crawl-set/10.json")).json()) as typeof SET_10_JSON;

    expect(body.items.map((i) => i.foodbank_slug)).toEqual(["salisbury", "amesbury"]);
    expect(body.items.map((i) => i.foodbank_slug)).not.toContain("wilton"); // set 11's
    expect(body.items.map((i) => i.foodbank_slug)).not.toContain("downton"); // the ad-hoc one
    expect(body.item_count).toBe(2);
  });

  // The consumer is not a browser rendering a page, it is
  // admin/crawl_set.njk:87-88's `fetch(...).then(r => r.json())`, so the keys ARE
  // the contract -- a renamed or dropped one is a column that silently stops
  // updating mid-crawl, which reads as a stalled crawl rather than as a bug.
  // Django's own crawl_set_json is test-pinned on this same dict
  // (gfadmin/tests/test_crawl_set_json.py, quoted in the WP 6.7 research).
  it("emits exactly Django's seven top-level keys, nulls included", async () => {
    const h = buildApp();

    const body = (await (await h.fetch("/admin/crawl-set/11.json")).json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(["crawl_type", "finish", "item_count", "items", "object_count", "start", "time_taken"]);
    // Present-and-null, not absent. The poll branches on `if (data.finish)` and
    // writes `data.time_taken` into the page; JSON.stringify drops undefined but
    // keeps null, and Django's JsonResponse emits null here too.
    expect(body).toHaveProperty("finish", null);
    expect(body).toHaveProperty("time_taken", null);
  });

  // c.json()'s Content-Type, pinned because it is what makes the poll's
  // response.json() legal and because it matches Django's JsonResponse
  // ("application/json", no charset) exactly.
  //
  // AND NO CACHE HEADER OF ITS OWN. MUTANT KILLED: `c.json(data, 200,
  // { "Cache-Control": "max-age=60" })`, an obvious-looking way to spare the
  // database a query every five seconds. It survives the no-store test at the
  // foot of this file, because middleware/noStore.ts overwrites Cache-Control on
  // the way out and so hides it for as long as index.ts:138's /admin/* mount
  // exists. This assertion is the one that says the handler contributes nothing
  // of its own -- the endpoint's uncacheability is the middleware's doing, whole.
  it("answers as application/json, and sets no cache header itself", async () => {
    const h = buildApp();

    const res = await h.fetch("/admin/crawl-set/10.json");

    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(res.headers.get("CDN-Cache-Control")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The id in the URL -- everything between `crawl-set/` and the query's `?`
// ---------------------------------------------------------------------------

describe("the id", () => {
  // Django's `<int:crawl_set_id>` converter matches [0-9]+ and hands the view
  // int("007") == 7, so /crawl-set/007.json has always served crawl set 7. The
  // Hono constraint is the same [0-9]+ and Number("007") is likewise 7, so the
  // port agrees -- asserted rather than assumed, because it is the one input
  // shape where the two URL layers could plausibly have disagreed.
  it("accepts a zero-padded id, as Django's int converter does", async () => {
    const h = buildApp();

    const res = await h.fetch("/admin/crawl-set/010.json");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SET_10_JSON);
  });

  // THE ID COMES FROM THE ROUTER, NOT FROM THE URL TEXT. MUTANT KILLED:
  // `c.req.url.split("/").pop()!` in place of `c.req.param("idJson")!`, which is
  // indistinguishable from the real thing for every other request in this file
  // -- the last path segment IS the param -- and breaks the moment anything
  // appends a query string, because the "?..." travels with the segment and
  // ".json" is then no longer what gets sliced off. crawl_set.njk:87 polls a
  // bare URL today, so this is not a live bug; it is the reason a cache-buster
  // could never become one, and cache-busting a five-second poll is exactly the
  // sort of thing someone adds without touching this handler.
  it("ignores a query string when reading the id", async () => {
    const h = buildApp();

    const res = await h.fetch("/admin/crawl-set/10.json?_=1757088000000");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SET_10_JSON);
  });

  // The guard is `Number.isInteger(id)`, not `if (!id)`. Zero is the only value
  // that separates the two spellings, and the tidier-looking one would 404 a
  // crawl set that exists. Not reachable from this app's own writes -- SQLite
  // rowids start at 1 -- but reachable from an ETL or a hand-run INSERT, which
  // is exactly how packages/db's own suite justifies the sibling test for a
  // crawlitem.need_id of 0.
  it("serves crawl set 0 rather than treating the id as missing", async () => {
    seedCrawlSet(db, { id: 0, crawl_type: "charity", start: SET_START, finish: null });
    const h = buildApp();

    const res = await h.fetch("/admin/crawl-set/0.json");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ crawl_type: "charity", item_count: 0, items: [] });
  });

  // The route constraint, not the handler, is what rejects these: `prepared`
  // empty is the assertion that matters, because a status alone cannot tell
  // apart "the router refused the URL" from "the handler queried for a nonsense
  // id and found nothing", and only the first is what routes/admin/index.ts:282
  // claims. Django's `<int:>` converter rejects the same three spellings: its
  // pattern compiles to `crawl-set/(?P<crawl_set_id>[0-9]+)\.json`, so a letter
  // in the id, a letter after it, and an upper-case suffix all miss.
  //
  // WHAT THEY THEN GET IS A 301, NOT A 404, and that is a DIVERGENCE from
  // Django rather than a port of it. Django's CommonMiddleware asks
  // `is_valid_path("/admin/crawl-set/abc.json/")`, which only runs the URL
  // resolver -- no view, no middleware -- gets no match, and 404s. This port
  // asks the question by re-dispatching a real (and, because the probe builds
  // its own Request, cookieless) HEAD through the whole app, where
  // requireAdminAuth answers 302 for anything under /admin/ whether a route
  // exists there or not. Harmless here -- the slashed URL 404s on arrival, one
  // redirect later -- but it is the same mechanism the missing-crawl-set 301
  // came out of, which is why it is pinned rather than left as trivia.
  it.each([
    ["a non-numeric id", "/admin/crawl-set/abc.json"],
    ["a mixed id", "/admin/crawl-set/10a.json"],
    ["an upper-case suffix", "/admin/crawl-set/10.JSON"],
  ])("never reaches the handler for %s", async (_label, path) => {
    const h = buildApp();

    const res = await h.fetch(path);

    expect(sqlLog.prepared).toEqual([]);
    expect(withSession).not.toHaveBeenCalled();
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`https://www.givefood.org.uk${path}/`);
  });

  // Already slashed, so lib/appendSlash.ts bails before probing (`if (...
  // url.pathname.endsWith("/")) return null`) and the request gets the site's
  // ordinary HTML 404 page. The contrast with the three above is the whole of
  // what APPEND_SLASH does; neither reaches the handler.
  it("never reaches the handler for a trailing slash, and 404s outright", async () => {
    const h = buildApp();

    const res = await h.fetch("/admin/crawl-set/10.json/");

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(sqlLog.prepared).toEqual([]);
  });

  // The one slashless spelling whose redirect is CORRECT and load-bearing:
  // Django's APPEND_SLASH has 301'd /admin/crawl-set/10 to the detail page for
  // years (gfadmin/urls/crawl_sets.py:8's own pattern ends in a slash), and this
  // is the port doing the same. It also proves the .json route is not greedy --
  // a constraint of `[0-9]+.*` would swallow this URL and hand the JSON endpoint
  // an id with no suffix to slice.
  it("leaves the slashless detail URL to APPEND_SLASH, not to this endpoint", async () => {
    const h = buildApp();

    const res = await h.fetch("/admin/crawl-set/10");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("https://www.givefood.org.uk/admin/crawl-set/10/");
    expect(sqlLog.prepared).toEqual([]);
  });

  // An id far past Number.MAX_SAFE_INTEGER. `Number.isInteger` does NOT reject
  // it -- 1e20 is an integer as far as JavaScript is concerned -- so it is bound
  // into the query as a float and matches nothing. Pinned because the outcome
  // that matters is "a plain 404", not a 500: index.ts's onError would answer a
  // crashed bind with the full HTML error page, which is what a poll loop would
  // then try to parse as JSON.
  it("404s an absurdly large id instead of throwing", async () => {
    const h = buildApp();

    const res = await h.fetch("/admin/crawl-set/99999999999999999999.json");

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });
});

// ---------------------------------------------------------------------------
// The miss -- the branch the whole handler is shaped around
// ---------------------------------------------------------------------------

describe("a crawl set that does not exist", () => {
  // get_object_or_404(CrawlSet, pk=crawl_set_id), as a nine-byte text/plain
  // response. Every assertion except the status is what distinguishes this from
  // c.notFound(), which under this exact wiring answers a 301 instead (see the
  // mutant killer below) and, once followed, the site's full HTML 404 page --
  // for a request the poll makes every five seconds for the length of a crawl.
  // `probes` empty is the strongest of the four: it says the request never left
  // this handler at all, so the re-entrant router pass never happened either.
  it("answers a plain-text 404 without ever reaching app.notFound()", async () => {
    const h = buildApp();

    const res = await h.fetch("/admin/crawl-set/999.json");

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=UTF-8");
    expect(res.headers.get("Location")).toBeNull();
    // The APPEND_SLASH probe never ran: no second pass through the router, and
    // the parent's HTML 404 page was never rendered.
    expect(h.probes).toEqual([]);
  });

  // The query DID run -- the miss is a real "no such crawl set", not the route
  // constraint refusing the URL. Without this the test above would pass equally
  // well against a handler that had stopped talking to the database at all.
  it("reached the database and found nothing, rather than short-circuiting", async () => {
    const h = buildApp();

    await h.fetch("/admin/crawl-set/999.json");

    expect(withSession).toHaveBeenCalledTimes(1);
    expect(sqlLog.prepared).toHaveLength(1); // the header SELECT only; the items query is never issued
    expect(sqlLog.prepared[0]).toContain("FROM crawlset");
  });

  // THE MUTANT KILLER, and the live bug reproduced end to end against the REAL
  // registration -- no contrived routes. Swap this handler's
  // `c.text("Not Found", 404)` for `c.notFound()` and a poll for a crawl set
  // that has been deleted answers 301 to `/admin/crawl-set/999.json/`.
  //
  // AND THE MECHANISM IS NOT THE ONE THE HANDLER'S COMMENT DESCRIBES, which is
  // why this is asserted rather than reasoned about. That comment (and
  // lib/appendSlash.test.ts:553-582) blames a loose sibling route swallowing the
  // slashed form; the registered detail route carries `{[0-9]+}` and cannot
  // match "999.json", so on that account the 301 could not happen any more. It
  // still does, for a different reason: tryAppendSlashRedirect probes with
  // `new Request(slashed, { method: "HEAD" })`, which carries NO COOKIE, so
  // requireAdminAuth answers the probe with its 302 to /auth/ -- and the probe's
  // test is `status !== 404 && status !== 501`. Every slashless URL under
  // /admin/ therefore looks like it "resolves", whether or not any route exists
  // there. So the route constraint is not a second line of defence for this
  // endpoint; this handler's `c.text` is the only one.
  it("refuses to 301 a missing crawl set, where the shipped-first version 301s", async () => {
    const real = buildApp();
    const res = await real.fetch("/admin/crawl-set/999.json");

    expect(res.status).toBe(404);
    expect(res.headers.get("Location")).toBeNull();
    expect(real.probes).toEqual([]);

    // The counterfactual, in the same app shape with the same routes: without
    // it, a test that only asserted 404 would pass against the broken version
    // too. Note where the Location points -- at a URL that does not resolve
    // either, since the detail route needs `[0-9]+`. So the poll pays a second
    // round trip to arrive at the HTML 404 page and hand it to `r.json()`.
    const broken = buildApp({ handler: async (c) => c.notFound() });
    const brokenRes = await broken.fetch("/admin/crawl-set/999.json");

    expect(brokenRes.status).toBe(301);
    expect(brokenRes.headers.get("Location")).toBe("https://www.givefood.org.uk/admin/crawl-set/999.json/");
    expect(broken.probes).toHaveLength(1);
  });

  // SUSPECT, PINNED AS-IS. The handler's OTHER exit -- the bad-id guard on
  // crawlSet.ts:14 -- IS `return c.notFound()`, the exact call the comment three
  // lines below it explains must never be used for this URL. It is unreachable
  // through the registered route (the `{[0-9]+\.json}` constraint means an id
  // that fails Number.isInteger cannot arrive), so it costs nothing today. It is
  // recorded here because the day someone relaxes that constraint the 301 comes
  // straight back, and relaxing it would look harmless precisely because the
  // handler appears to validate the id itself. This mounts the real handler on
  // an unconstrained route to show what the guard does; it is NOT the registered
  // wiring, and the assertion records a hazard, not a shipped behaviour.
  it("would 301 through its own bad-id guard if the route constraint were ever relaxed", async () => {
    const h = buildApp({ looseJsonRoute: true });

    const res = await h.fetch("/admin/crawl-set/abc.json");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("https://www.givefood.org.uk/admin/crawl-set/abc.json/");
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe("auth", () => {
  // givefood/middleware.py's LoginRequiredAccess, as ported in
  // middleware/adminAuth.ts. The redirect target has to survive the sub-app's
  // path rebasing -- a Location of "/auth/?next=%2Fcrawl-set%2F10.json" would
  // send the admin somewhere that does not exist after signing in -- and the
  // handler must not have run: `prepared` empty is the assertion that the query
  // never happened, which a status check alone does not make.
  it("redirects an unauthenticated request to sign-in without touching the database", async () => {
    const h = buildApp();

    const res = await h.fetch("/admin/crawl-set/10.json", { signedIn: false });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fcrawl-set%2F10.json");
    expect(withSession).not.toHaveBeenCalled();
    expect(sqlLog.prepared).toEqual([]);
  });

  // A cookie is not a session. The expired/revoked case goes through the whole
  // of getAdminSession -- cookie parsed, KV read, miss -- and has to land in the
  // same place as no cookie at all, because that is what an admin who left a
  // crawl page open overnight actually has.
  it("refuses a cookie whose session is gone from KV", async () => {
    const h = buildApp();

    const res = await h.fetch("/admin/crawl-set/10.json", { headers: { Cookie: "__Host-gfsession=long-expired" } });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fcrawl-set%2F10.json");
    expect(kv.get).toHaveBeenCalledWith("admin-session:long-expired");
    expect(withSession).not.toHaveBeenCalled();
  });

  // KNOWN DIVERGENCE FROM WHAT THE CONSUMER WANTS, pinned because it is Django's
  // behaviour and therefore deliberate. When the session expires mid-crawl the
  // poll receives a 302 to an HTML sign-in page, `fetch` follows it, and
  // `response.json()` throws inside the setInterval callback
  // (admin/crawl_set.njk:88) -- the table simply stops updating, with the error
  // only in the console. Django's LoginRequiredAccess did exactly the same to
  // the original page, so this is parity, not a regression; a 401 with a JSON
  // body would be the improvement, and changing it here would be a divergence
  // worth making on purpose rather than by accident.
  it("hands the poll loop an HTML redirect rather than a JSON error", async () => {
    const h = buildApp();

    const res = await h.fetch("/admin/crawl-set/10.json", { signedIn: false });

    expect(res.status).not.toBe(401);
    expect(res.headers.get("Content-Type")).not.toBe("application/json");
  });

  // The cost of the poll, per tick. crawl_set.njk fires this every five seconds
  // for the whole of a 1,071-food-bank sweep, so one KV read is the budget and a
  // KV WRITE per tick would be a different order of expense -- lib/adminAuth.ts
  // slides the session only past its halfway point (SESSION_REFRESH_THRESHOLD_
  // SECONDS's own comment) and this is where that promise is checked from the
  // route that leans on it hardest.
  it("costs one KV read and no KV write while the session is fresh", async () => {
    const h = buildApp();

    await h.fetch("/admin/crawl-set/10.json");

    expect(kv.get).toHaveBeenCalledTimes(1);
    expect(kv.put).not.toHaveBeenCalled();
  });

  // The OTHER half of the per-tick cost, and the one nothing in the response
  // body can show. lib/session.ts opens the session as "first-unconstrained" --
  // a read replica is allowed to answer -- because this database has read
  // replication on and every packages/db query goes through a Session for that
  // reason (PLAN.md §3.3). MUTANT KILLED: swapping `dbSession(c)` for
  // `c.env.DB.withSession("first-primary")` inside the handler, which every
  // other assertion in this file survives unchanged -- same JSON, same status,
  // same one call -- while sending each of the poll's twelve reads a minute to
  // the primary region for the whole of a 1,071-food-bank sweep.
  it("reads through a replica-eligible session, not the primary", async () => {
    const h = buildApp();

    await h.fetch("/admin/crawl-set/10.json");

    expect(withSession).toHaveBeenCalledTimes(1);
    expect(withSession).toHaveBeenCalledWith("first-unconstrained");
  });
});

// ---------------------------------------------------------------------------
// Read-only
// ---------------------------------------------------------------------------

describe("mutation", () => {
  function snapshot() {
    return JSON.stringify({
      crawlset: db.prepare("SELECT * FROM crawlset ORDER BY id").all(),
      crawlitem: db.prepare("SELECT * FROM crawlitem ORDER BY id").all(),
      foodbank: db.prepare("SELECT * FROM foodbank ORDER BY id").all(),
      foodbankchange: db.prepare("SELECT * FROM foodbankchange ORDER BY id").all(),
    });
  }

  // A GET on an admin URL must never write. Asserted twice over because either
  // assertion alone has a hole: the row snapshot would miss a write that
  // happened to be idempotent (a `modified` stamp rewritten to the same value,
  // say), and the SQL log would miss a write issued through some path other than
  // run(). Together they say the request was read-only in both senses.
  it("writes nothing -- no run(), no changed row", async () => {
    const before = snapshot();
    const h = buildApp();

    expect((await h.fetch("/admin/crawl-set/10.json")).status).toBe(200);

    expect(sqlLog.ran).toEqual([]);
    expect(sqlLog.prepared.every((sql) => /^\s*SELECT/i.test(sql))).toBe(true);
    expect(snapshot()).toBe(before);
  });

  // Hono answers HEAD from the GET handler, which is not incidental here: it is
  // how lib/appendSlash.ts probes, so this endpoint is HEAD-requested by the
  // site's own 404 path whenever some OTHER slashless admin URL misses. It must
  // be as inert as the GET.
  it("writes nothing on a HEAD either", async () => {
    const before = snapshot();
    const h = buildApp();

    const res = await h.fetch("/admin/crawl-set/10.json", { method: "HEAD" });

    expect(res.status).toBe(200);
    expect(sqlLog.ran).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  // DIVERGENCE FROM DJANGO, pinned. gfadmin's crawl_set_json has no method
  // restriction, so a POST to it returned the same JSON; index.ts:282 registers
  // this with .get, so a POST falls through to the site's HTML 404. Nothing
  // consumes it by POST (the poll uses fetch's default GET), and refusing to
  // answer a read-only endpoint on a method that implies a mutation is the safer
  // of the two -- but it is a difference, and the assertion that nothing was
  // written is the half that matters if that ever changes.
  it("does not answer a POST at all", async () => {
    const before = snapshot();
    const h = buildApp();

    const res = await h.fetch("/admin/crawl-set/10.json", { method: "POST" });

    expect(res.status).toBe(404);
    expect(sqlLog.prepared).toEqual([]);
    expect(snapshot()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// The production registration -- routes/admin/index.ts:85,195,282 themselves,
// not this file's reconstruction of them
// ---------------------------------------------------------------------------

// EVERY TEST ABOVE THIS LINE RUNS AGAINST A MIRROR of index.ts's registration,
// and a mirror is by construction incapable of failing when the thing it mirrors
// changes. That is not a theoretical objection: mutating index.ts and re-running
// this file left all of the following green.
//
//   * `/crawl-set/:idJson` with the `{[0-9]+\.json}` constraint dropped -- the
//     constraint is what routes/admin/index.ts:282's own comment says keeps the
//     id and its suffix together, and losing it hands the handler ids it was
//     never meant to see (see "the id" above: the guard it meets there answers
//     c.notFound(), which is the 301 this whole handler exists to avoid).
//   * `.all` in place of `.get` -- the endpoint starts answering POST.
//   * `:id` in place of `:idJson` -- the handler reads the param BY NAME, so
//     the poll gets a 500 (`c.req.param("idJson")!` is undefined, `.slice`
//     throws) on every tick.
//   * `/crawlset/` in place of `/crawl-set/` -- crawl_set.njk:87's hardcoded
//     poll URL 404s.
//   * index.ts:85's `adminApp.use("*", requireAdminAuth)` deleted -- the entire
//     admin area, this endpoint included, served to anyone.
//
// A sixth, `adminCrawlSetDetail` wired to the .json route by a bad merge, would
// have survived too -- an HTML page served to `r.json()` at the poll's own URL.
//
// So the six tests below re-ask the questions that matter of the REAL adminApp,
// mounted at /admin exactly as workers/site/src/index.ts:637 mounts it. They are
// deliberately few: the mirror is the better place to characterise behaviour
// (it can be given a broken handler, or a deliberately loose route), and this
// block exists only to hold the wiring itself still.
describe("the production route registration", () => {
  // Kills the path- and param-rename mutants in one go, and is the only
  // assertion in this file that the shipped URL serves the shipped payload.
  it("serves the poll's own URL, whole, through the real adminApp", async () => {
    const h = buildApp({ router: "real" });

    const res = await h.fetch("/admin/crawl-set/10.json");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SET_10_JSON);
  });

  // The miss, through the real wiring rather than the mirror -- because the
  // claim this handler is built on ("a deleted crawl set must not 301 the poll
  // into an HTML page") is a claim about production, and the mirror could keep
  // it true after index.ts stopped being. `probes` empty says the parent's
  // APPEND_SLASH handler was never reached.
  it("answers a deleted crawl set with the plain-text 404 in production too", async () => {
    const h = buildApp({ router: "real" });

    const res = await h.fetch("/admin/crawl-set/999.json");

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
    expect(res.headers.get("Location")).toBeNull();
    expect(h.probes).toEqual([]);
  });

  // MUTANT KILLED: `/crawl-set/:idJson` with no constraint. Under that mutant
  // this URL stops belonging to the detail page and starts matching the JSON
  // route, which slices ".json" off a param that never had it -- Number("") is
  // 0, so the poll endpoint quietly answers for crawl set 0 (or 404s) at the URL
  // an admin typed to read the crawl. `prepared` empty is the assertion that
  // carries it: the status alone cannot tell "no route matched, so APPEND_SLASH
  // redirected" from "the JSON handler ran and found nothing".
  it("leaves the slashless detail URL to APPEND_SLASH, in the real router too", async () => {
    const h = buildApp({ router: "real" });

    const res = await h.fetch("/admin/crawl-set/10");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("https://www.givefood.org.uk/admin/crawl-set/10/");
    expect(sqlLog.prepared).toEqual([]);
    expect(withSession).not.toHaveBeenCalled();
  });

  // MUTANT KILLED: `.all` in place of `.get` at index.ts:282. Registered as GET
  // only, a POST never matches, so it reaches the parent's notFound -- and
  // because tryAppendSlashRedirect refuses non-GET/HEAD methods outright, it is
  // the HTML 404 page rather than a redirect. Pinned as the DIVERGENCE it is:
  // gfadmin's crawl_set_json carries no method restriction and answered POST
  // with the same JSON.
  it("is registered for GET only, so a POST reaches the 404 page", async () => {
    const h = buildApp({ router: "real" });

    const res = await h.fetch("/admin/crawl-set/10.json", { method: "POST" });

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(h.probes).toEqual([null]); // asked, and declined: not a GET
    expect(withSession).not.toHaveBeenCalled();
  });

  // The slashed spelling, through the real router: nothing matches (the detail
  // route at index.ts:195 wants `{[0-9]+}` and "10.json" is not that),
  // tryAppendSlashRedirect declines because the path already ends in a slash,
  // and the site's HTML 404 answers -- with no query issued.
  //
  // MUTANT NOT KILLED, and named here so the next reader does not assume it is:
  // relaxing THAT route to `/crawl-set/:id/` changes nothing observable, because
  // adminCrawlSetDetail (crawlSets.ts:53-54) parses its id with the same
  // `Number.isInteger` guard, so "10.json" is rejected there before any query
  // and the 404 arrives by a different path. It is an equivalent mutant for this
  // URL, not a gap -- the difference would only show for a slashed id that DOES
  // parse, which belongs to crawlSets.test.ts.
  it("leaves the slashed spelling of this URL to the 404 page, in the real router too", async () => {
    const h = buildApp({ router: "real" });

    const res = await h.fetch("/admin/crawl-set/10.json/");

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(sqlLog.prepared).toEqual([]);
  });

  // NOT CACHEABLE, which for this endpoint is the /admin/* half of the beta
  // 2026-09-02 exposure recorded in middleware/noStore.ts: wrangler.jsonc turns
  // the Workers Cache on, and a HIT is served WITHOUT EXECUTING THE WORKER, so
  // requireAdminAuth never runs. A cached crawl payload is both a stale poll and
  // an authenticated response handed to whoever asks next. The two mounts are
  // reproduced from index.ts:137-138 (auth.test.ts:527 does the same for /auth),
  // so what this pins is the pair of facts that ARE about this route: that a
  // ".json" last segment still matches the "/admin/*" pattern, and that
  // `c.json()` does not overwrite the header noStore sets on the way out.
  it("is covered by the /admin/* no-store mount", async () => {
    const h = buildApp({ router: "real", noStore: true });

    const res = await h.fetch("/admin/crawl-set/10.json");

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store, max-age=0, must-revalidate");
    expect(res.headers.get("CDN-Cache-Control")).toBe("no-store");
  });

  // MUTANT KILLED: deleting index.ts:85's `adminApp.use("*", requireAdminAuth)`.
  // The auth gate is registered once, on the sub-app, and this handler carries
  // no check of its own -- so this is the only place the fact that the poll
  // endpoint is behind sign-in is asserted against the router that actually
  // serves it.
  it("sits behind the sub-app's own requireAdminAuth, not this file's copy of it", async () => {
    const h = buildApp({ router: "real" });

    const res = await h.fetch("/admin/crawl-set/10.json", { signedIn: false });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fcrawl-set%2F10.json");
    expect(withSession).not.toHaveBeenCalled();
    expect(sqlLog.prepared).toEqual([]);
  });
});
