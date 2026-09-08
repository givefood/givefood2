import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { MIGRATIONS_SQL as SCHEMA } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import { wfbnFoodbankHit } from "./hit";
import type { AppEnv } from "../../types";

// routes/wfbn/hit.ts -- the hit beacon. Every food bank page on the site fires
// this from wfbn/includes/hit.njk:
//
//   <script>fetch("...", {method: "POST", keepalive: true});</script>
//
// so it is the single highest-traffic endpoint in the Worker (PLAN.md §10.7.2
// puts it at ~11M requests/month on its own) and the ONLY source of the
// "most viewed food banks" numbers in the footer, on the home page and in the
// annual reports.
//
// WHY THIS ENDPOINT IS WORTH A LOT OF TEST FOR TWELVE LINES OF CODE. Nothing
// about it is observable from a browser. It answers 204 with no body, and a
// `fetch()` with `keepalive: true` and no `.then()` never looks at the answer
// anyway -- so a beacon that has stopped counting, or that has started
// counting the wrong thing, looks EXACTLY like one that works, from both ends,
// until someone opens a dashboard months later and finds a flat line or a
// column of nulls. There is no error to surface, no queue to back up and no
// row to go missing. That is the same failure shape as the Browser Rendering
// credential that broke unattended for a day, and it is the reason the
// assertions below are on the data point's exact contents rather than on the
// status code.
//
// DJANGO SOURCE, read at /Users/jasoncartwright/Sites/foodcharity:
// gfwfbn/views.py:1203-1228 (`@csrf_exempt @require_POST @never_cache def
// foodbank_hit`) and gfwfbn/urls/generic.py:9. The port deliberately keeps the
// slug lookup and the 404, and deliberately replaces the D1 write with an
// Analytics Engine data point (PLAN.md §10.7.3). Both halves of that are
// asserted here: the 404 parity, and that D1 is READ and never written.
//
// REAL APP, REAL SCHEMA, REAL SQL. `app` is the default export of
// workers/site/src/index.ts, so every request below goes through the real
// router (which is where the method gate, the locale-prefix behaviour and the
// slug-redirect interaction actually live -- none of them is in hit.ts) and
// the real middleware chain, and the real packages/db query runs against a
// real in-memory SQLite built from the real migrations. MIGRATIONS_SQL rather
// than schemaFor(...) because the GET tests below fall through to
// wfbnFoodbankLocation, whose queries reach several more tables and a view;
// naming them here would be a list to keep in sync with somebody else's route.
//
// The ONLY double is the Analytics Engine binding, which is the one thing in
// reach that leaves the machine and has no local equivalent.
//
// MUTATION-TESTED, in a copy of the tree OUTSIDE the repo (TESTING.md's
// "several suites were mutation-tested"). 27 mutants across hit.ts, index.ts's
// route registration and packages/db's getFoodbankIdBySlug; all 27 killed. The
// ones worth naming, because each is a plausible edit rather than an invented
// one: swapping the two blobs, promoting `country` into the index, `doubles:
// [0]`, dropping either array, `?? "unknown"` instead of `?? ""`, reading the
// country from the CF-IPCountry header, `if (!foodbankId)` in place of
// `=== null`, deleting or reordering the 404 gate, wrapping the write in
// try/catch, writing the point twice, restoring Django's `INSERT ... ON
// CONFLICT` upsert, adding @never_cache's Cache-Control or Expires, adding an
// Origin check, folding the query string into the index, `app.all` in place of
// `app.post`, mounting the route under the locale prefixes, and -- in
// packages/db -- `SELECT *`, an `AND is_closed = 0`, and `OR 1 = 1`.
//
// The mutant worth calling out is "lowercase the slug before the lookup",
// which looks equivalent (every slug in the table is slugified, so the value
// beaconed is byte-identical to `foodbank.slug` either way) and is not: it
// turns /needs/at/Salisbury/hit/ from a 404 into a counted hit. One test
// catches it, and that test is the only reason the case-sensitivity of the
// column is pinned anywhere.

const ORIGIN = "https://www.givefood.org.uk";

type Bindable = null | number | bigint | string | Uint8Array;

// The D1DatabaseSession surface packages/db uses, over node:sqlite -- the same
// shim as routes/api1.test.ts, for the same reason: D1 is async where
// node:sqlite is synchronous, and that is the only difference that matters,
// the SQL text, the binding and the NULL semantics being SQLite's on both
// sides.
//
// `prepared` records every statement that actually reached the engine, because
// the central architectural claim of this file's header comment -- "never
// touches D1 for this endpoint" (hit.ts:12) -- is a claim about statements, and
// a response body cannot see it. A port that quietly re-grew Django's
// `INSERT ... ON CONFLICT DO UPDATE SET hits = hits + 1` would pass every other
// assertion in this suite.
function d1Session(db: DatabaseSync, prepared: string[]): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    sql,
    params,
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
      prepared.push(sql);
      return statement(sql, []);
    },
    // getFoodbankBySlug (the GET fall-through) sends its two statements as one
    // batch and indexes straight into the result array, so this must run them
    // in order and return one result per input, in that order.
    batch: async (statements: Array<{ sql: string; params: Bindable[] }>) =>
      statements.map((s) => ({ results: db.prepare(s.sql).all(...s.params), success: true, meta: {} })),
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

// What writeDataPoint() was handed, verbatim. Analytics Engine is
// write-only-from-the-Worker (it is read back hours later over the SQL API), so
// there is no "read it back" assertion available; capturing the argument is the
// whole of the observable contract.
type Point = { indexes?: string[]; blobs?: (string | null)[]; doubles?: number[] };

let db: DatabaseSync;
let prepared: string[];
let points: Point[];
let hitsThrows: Error | null;

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

function env(): AppEnv["Bindings"] {
  return {
    DB: { withSession: () => d1Session(db, prepared) },
    HITS: {
      writeDataPoint: (point: Point) => {
        if (hitsThrows) throw hitsThrows;
        points.push(point);
      },
    },
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: { get: async () => null, put: async () => {}, delete: async () => {} },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

// ===========================================================================
// SEEDS
// ===========================================================================

const SALISBURY = "salisbury";
const BATH = "bath";
const CLOSED = "closed-town";
// Django's URL converter is `<slug:slug>`, i.e. [-a-zA-Z0-9_]+, so an
// underscore and a digit are both legal in a real slug and both have to survive
// into the index unchanged -- see "the slug reaches the data point verbatim".
const ODD = "st_marys-2";

// Only the NOT NULL columns of `foodbank` are supplied; every other column this
// endpoint never reads is left NULL on purpose, so that a future version of
// hit.ts that started reading one of them fails here rather than silently
// beaconing a null.
function seedFoodbank(id: number, slug: string, isClosed: 0 | 1 = 0): void {
  db.prepare(
    `INSERT INTO foodbank
       (id, uuid, name, slug, address, postcode, country, lat_lng,
        charity_just_foodbank, contact_email, url, shopping_list_url,
        address_is_administrative, is_closed, no_locations, days_between_needs,
        created, modified)
     VALUES (?, ?, ?, ?, '1 High St', 'SP1 1AA', 'England', '51.06,-1.79',
        0, 'mail@example.org', 'https://example.org/', 'https://example.org/list/',
        0, ?, 0, 14,
        '2019-06-01 09:00:00.000000', '2026-08-14 09:15:00.000000')`,
  ).run(id, `uuid-${id}`.padEnd(32, "0"), `Food bank ${id}`, slug, isClosed);
}

// SEEDED IN EVERY TEST, DELIBERATELY, AND NEVER VARIED.
//
// middleware/slugRedirect.ts memoises the whole redirect map in a MODULE-LEVEL
// variable for 5 minutes, and a module-level variable outlives beforeEach: the
// first request this file makes fixes the map for the entire run, whichever
// test happens to make it. Seeding the same single row before every test is
// what makes that memo harmless -- the map is the same object whatever the test
// order -- and it is also what lets "a renamed food bank" below be asserted at
// all. Do not make this conditional on the test.
const RENAMED_FROM = "renamed-town";

function seedSlugRedirect(): void {
  db.prepare(
    `INSERT INTO slugredirect (id, old_slug, new_slug, created, modified)
     VALUES (1, ?, ?, '2024-01-01 00:00:00.000000', '2024-01-01 00:00:00.000000')`,
  ).run(RENAMED_FROM, SALISBURY);
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  prepared = [];
  points = [];
  hitsThrows = null;
  seedSlugRedirect();
  seedFoodbank(7, SALISBURY);
  seedFoodbank(8, BATH);
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

// A beacon exactly as hit.njk's fetch() sends it: POST, no body, no
// Content-Type, and a `cf` object as the Cloudflare edge attaches it.
//
// `cf` is set with defineProperty rather than passed to the Request
// constructor: undici's Request silently DROPS an unknown `cf` init field, so a
// test written the obvious way would assert against `country: ""` on every
// single request and never notice. Checked by running it on this machine
// (node v24.15.0): `new Request(url, { cf: { country: "GB" } }).cf` is
// `undefined`; the defineProperty form reads back.
//
// `null`, NOT `undefined`, is how a caller asks for a request with no `cf` at
// all -- passing `undefined` to a parameter with a default gets the default,
// which is how the first draft of the "no cf object" test below quietly
// asserted "GB" against a request that had one.
const NO_CF = null;

// `async`, not a bare `return app.fetch(...)`: Hono types fetch as
// `Response | Promise<Response>`, which vitest runs happily and `tsc --noEmit`
// rejects. Awaiting collapses the union.
async function beacon(path: string, cf: { country?: string } | null = { country: "GB" }, init: RequestInit = {}): Promise<Response> {
  const request = new Request(`${ORIGIN}${path}`, { method: "POST", ...init });
  if (cf !== null) Object.defineProperty(request, "cf", { value: cf, enumerable: true });
  return await app.fetch(request, env(), execCtx);
}

/** Every statement the request sent, minus slugRedirect's own map read. */
function foodbankQueries(): string[] {
  return prepared.filter((sql) => !sql.includes("slugredirect"));
}

// ===========================================================================
// THE DATA POINT -- the entire product of this endpoint
// ===========================================================================

describe("the Analytics Engine data point", () => {
  it("writes exactly one point, with the slug indexed and the country blobbed", async () => {
    const res = await beacon(`/needs/at/${SALISBURY}/hit/`);

    expect(res.status).toBe(204);
    // The WHOLE point, not field by field. indexes/blobs/doubles are POSITIONAL
    // on the read side -- the SQL API calls them index1, blob1, blob2, double1
    // -- so swapping the two blobs, or promoting the country into the index, is
    // a change nothing in the Worker can detect and nothing in a browser can
    // see. It surfaces months later as a dashboard grouped by country instead
    // of by food bank. PLAN.md §10.7.3 fixes this layout; this is the
    // assertion that holds it.
    expect(points).toEqual([{ indexes: [SALISBURY], blobs: [SALISBURY, "GB"], doubles: [1] }]);
  });

  it("puts a 1 in doubles, because the read side sums a per-hit weight", async () => {
    // PLAN.md §10.7.3: "Read back with SUM(_sample_interval), never COUNT()".
    // The double is the hit's own weight, and it is 1 per request -- a 0 here
    // would zero the published metric while leaving every row present and the
    // endpoint answering 204, which is the least detectable possible failure.
    await beacon(`/needs/at/${SALISBURY}/hit/`);
    expect(points[0]?.doubles).toEqual([1]);
  });

  it("counts every delivery, because Cloudflare retries and the browser refires", async () => {
    // NOT idempotent, and must not be. Django's view was an atomic
    // `hits = hits + 1` upsert keyed on (foodbank_id, day); the Analytics
    // Engine port replaces that accumulator with one row per hit, so N POSTs
    // must produce N points. A "write once per slug per isolate" optimisation
    // would look like a sensible de-duplication and would silently reduce every
    // food bank's count to the number of isolates that served it.
    await beacon(`/needs/at/${SALISBURY}/hit/`);
    await beacon(`/needs/at/${SALISBURY}/hit/`);
    await beacon(`/needs/at/${BATH}/hit/`);

    expect(points).toEqual([
      { indexes: [SALISBURY], blobs: [SALISBURY, "GB"], doubles: [1] },
      { indexes: [SALISBURY], blobs: [SALISBURY, "GB"], doubles: [1] },
      { indexes: [BATH], blobs: [BATH, "GB"], doubles: [1] },
    ]);
  });

  it("requires no CSRF token, no cookie and no same-origin check", async () => {
    // Django's view is `@csrf_exempt` (gfwfbn/views.py:1203) and this port adds
    // no gate of its own. That is LOAD-BEARING, not an oversight: the beacon is
    // fired by a page that may have been served from the edge cache hours ago,
    // by a visitor with no session and no cookie, and lib/csrf.ts's token is
    // per-visitor -- so any CSRF check here would reject a large fraction of
    // real beacons and the count would drop without a single error anywhere.
    // The trade is accepted deliberately: forging hits costs nothing to begin
    // with, since a POST is all it takes.
    const res = await beacon(`/needs/at/${SALISBURY}/hit/`, { country: "GB" }, {
      headers: { Origin: "https://attacker.example", "Content-Type": "application/x-www-form-urlencoded" },
      body: "csrfmiddlewaretoken=&junk=1",
    });

    expect(res.status).toBe(204);
    expect(points).toEqual([{ indexes: [SALISBURY], blobs: [SALISBURY, "GB"], doubles: [1] }]);
  });

  it("ignores the query string rather than letting it into the index", async () => {
    // hit.njk sends none, but a browser extension, an analytics rewriter or a
    // paste can add `?utm_source=...`. The index is keyed on the ROUTE PARAM,
    // so the query cannot fragment one food bank's count across many index
    // values -- which is exactly what would happen if this ever became
    // `new URL(c.req.url).pathname` arithmetic.
    const res = await beacon(`/needs/at/${SALISBURY}/hit/?utm_source=newsletter&fbclid=xyz`);

    expect(res.status).toBe(204);
    expect(points).toEqual([{ indexes: [SALISBURY], blobs: [SALISBURY, "GB"], doubles: [1] }]);
  });

  it("takes the slug from the URL verbatim, punctuation included", async () => {
    // The index is what the dashboard groups by and what a purge/rollup cron
    // will join back to `foodbank.slug`, so any normalisation here (lowercasing,
    // stripping, slugify-ing) would produce a key that matches no row in D1.
    seedFoodbank(30, ODD);
    await beacon(`/needs/at/${ODD}/hit/`);

    expect(points).toEqual([{ indexes: [ODD], blobs: [ODD, "GB"], doubles: [1] }]);
  });
});

// ===========================================================================
// COUNTRY -- the one field the port ADDS over Django
// ===========================================================================

describe("the country blob", () => {
  it("comes from request.cf, not from the CF-IPCountry header", async () => {
    // A header is attacker-controlled and `cf` is not: anyone can curl this
    // endpoint with `CF-IPCountry: XX` and, if the header were the source,
    // poison the geography of the published figures at will. Asserted with the
    // two DISAGREEING, because a test where they match cannot tell them apart.
    await beacon(`/needs/at/${SALISBURY}/hit/`, { country: "GB" }, { headers: { "CF-IPCountry": "US" } });

    expect(points[0]?.blobs).toEqual([SALISBURY, "GB"]);
  });

  it('records "" when there is no cf object at all', async () => {
    // `wrangler dev` without --remote, and any request that did not come
    // through the Cloudflare edge, has no `cf` -- hit.ts:31-32 exists for
    // exactly that. The failure being prevented is not a wrong country, it is
    // `cf.country` throwing on undefined and turning the whole beacon into a
    // 500 for every local developer.
    const res = await beacon(`/needs/at/${SALISBURY}/hit/`, NO_CF);

    expect(res.status).toBe(204);
    expect(points).toEqual([{ indexes: [SALISBURY], blobs: [SALISBURY, ""], doubles: [1] }]);
  });

  it('records "" when cf is present but carries no country', async () => {
    // Cloudflare omits `country` for some clients (and sends the synthetic
    // "T1"/"XX" values for others). The `?? ""` must survive; a `|| "unknown"`
    // or a bare `cf.country` would put `undefined` in a blob column that the
    // SQL API types as a string.
    await beacon(`/needs/at/${SALISBURY}/hit/`, {});

    expect(points[0]?.blobs).toEqual([SALISBURY, ""]);
  });

  it("passes an unusual country code straight through, uppercase and all", async () => {
    // Cloudflare's `cf.country` is not restricted to ISO 3166 -- it emits
    // synthetic codes ("T1" for Tor, "XX" for unknown) alongside real ones. A
    // "validate it is a real country" guard would drop those requests' hits on
    // the floor, so the value is beaconed verbatim whatever it is.
    await beacon(`/needs/at/${SALISBURY}/hit/`, { country: "T1" });

    expect(points[0]?.blobs).toEqual([SALISBURY, "T1"]);
  });
});

// ===========================================================================
// 404 PARITY -- gfwfbn/views.py:1210-1212
// ===========================================================================

describe("an unknown slug", () => {
  it("404s and writes NOTHING, rather than counting a hit for a food bank that does not exist", async () => {
    // The existence check is the ONLY reason this endpoint touches D1 at all
    // (hit.ts:16-20). If it stopped 404ing, the dashboard would grow index
    // values for every scanner and every stale bookmark on the internet -- and
    // because index cardinality is what Analytics Engine bills and samples on,
    // that is a cost and an accuracy problem, not just an untidy one.
    //
    // `bath` is seeded (in beforeEach) and deliberately not asked for: a
    // `WHERE slug = ?` that had stopped filtering would return the first row in
    // the table, which against an empty fixture is indistinguishable from a
    // correct null.
    const res = await beacon("/needs/at/no-such-foodbank/hit/");

    expect(res.status).toBe(404);
    expect(points).toEqual([]);
  });

  it("answers with the site's real 404 page, not a bare Hono 404", async () => {
    // Django raises Http404, which renders 404.html through the normal template
    // pipeline. The beacon's own caller never looks, but this URL is also what
    // a person sees if they paste it into a browser, and index.ts routes it
    // through app.notFound() like every other miss.
    const res = await beacon("/needs/at/no-such-foodbank/hit/");
    const body = await res.text();

    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(body).toContain("404 - Not Found");
    // The apostrophe arrives HTML-escaped: the .po msgid is passed through
    // Nunjucks' autoescape by `_()`, so the page says `can&#39;t`. Asserted in
    // the shape it actually ships, since that is what a browser and a
    // parity-diff both see.
    expect(body).toContain("Sorry, we can&#39;t find that page.");
  });

  it("treats a case-mismatched slug as unknown, because the column collates BINARY", async () => {
    // `foodbank.slug` has no COLLATE NOCASE, so `WHERE slug = ?` is
    // case-sensitive and /needs/at/Salisbury/hit/ is a 404 with no hit counted.
    // Pinned because it is the behaviour, not because it is desirable: a
    // capitalised link in somebody's newsletter silently counts zero.
    const res = await beacon("/needs/at/Salisbury/hit/");

    expect(res.status).toBe(404);
    expect(points).toEqual([]);
  });

  it("still counts a CLOSED food bank, whose page is still served", async () => {
    // Django filters on slug alone -- no is_closed clause (gfwfbn/views.py:1210)
    // -- and the closed food bank's page is still rendered and still fires the
    // beacon. Adding the `is_closed = 0` that most other queries in
    // packages/db carry would be a plausible "harmonisation" that silently
    // stops counting a whole class of page.
    seedFoodbank(90, CLOSED, 1);
    const res = await beacon(`/needs/at/${CLOSED}/hit/`);

    expect(res.status).toBe(204);
    expect(points).toEqual([{ indexes: [CLOSED], blobs: [CLOSED, "GB"], doubles: [1] }]);
  });

  it("counts food bank 0, rather than reporting it missing", async () => {
    // hit.ts:25 is `if (foodbankId === null)`, and it has to be: `id INTEGER
    // PRIMARY KEY` admits 0, and the tidy-looking `if (!foodbankId)` would
    // 404 a food bank whose page exists and is being viewed. The id is thrown
    // away immediately afterwards, so this is the ONLY place the distinction is
    // ever observable.
    seedFoodbank(0, "zero");
    const res = await beacon("/needs/at/zero/hit/");

    expect(res.status).toBe(204);
    expect(points).toEqual([{ indexes: ["zero"], blobs: ["zero", "GB"], doubles: [1] }]);
  });
});

// ===========================================================================
// D1 IS READ, NEVER WRITTEN -- the deliberate architecture change
// ===========================================================================

describe("what reaches the database", () => {
  it("sends exactly one statement, a SELECT of the id", async () => {
    // hit.ts:8-12: the Django view's atomic upsert is GONE, replaced by an
    // Analytics Engine write. This endpoint carries roughly a third of the
    // Worker's total request volume, so a D1 WRITE creeping back onto this path
    // is both a correctness regression against PLAN.md §10.7.3 and, at 11M
    // writes a month, a bill.
    //
    // The first request of the run also warms middleware/slugRedirect.ts's
    // 5-minute memo, so one throwaway beacon is fired and the log reset before
    // the statement that is actually counted.
    await beacon(`/needs/at/${SALISBURY}/hit/`);
    prepared.length = 0;

    await beacon(`/needs/at/${SALISBURY}/hit/`);

    expect(prepared).toEqual(["SELECT id FROM foodbank WHERE slug = ?"]);
  });

  it("writes no rows -- foodbankhit is left completely empty", async () => {
    // The table Django wrote to still exists in the schema and is still READ
    // (packages/db/src/frag.ts's getRecentHitsTotal, homepage.ts, adminLists.ts),
    // so "no INSERT" is asserted against the table itself and not only against
    // the statement log: a write arriving by some other route would still show
    // up here.
    //
    // WORTH KNOWING WHILE READING THIS: nothing else in the Worker writes
    // foodbankhit either. PLAN.md §10.7.3 specifies a nightly cron to roll the
    // Analytics Engine data back into it, and that cron does not exist in
    // workers/jobs -- grepped, not assumed; the only INSERTs into this table
    // anywhere in the repo are in test fixtures. See this file's report in
    // suspectedBugs. That is NOT this endpoint's bug and is not asserted here;
    // it is recorded so nobody reads "writes no rows" as "and something else
    // does".
    await beacon(`/needs/at/${SALISBURY}/hit/`);
    await beacon(`/needs/at/${SALISBURY}/hit/`);

    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbankhit").get()).toEqual({ n: 0 });
    expect(foodbankQueries().every((sql) => sql.trimStart().toUpperCase().startsWith("SELECT"))).toBe(true);
  });

  it("does not read the food bank row, only its id", async () => {
    // hit.ts:19-20 -- "nothing else about the row is read". A `SELECT *` here
    // would be invisible in every other assertion in this file and would put a
    // 60-column read on the site's busiest path.
    await beacon(`/needs/at/${SALISBURY}/hit/`);

    expect(foodbankQueries()).toContain("SELECT id FROM foodbank WHERE slug = ?");
    expect(foodbankQueries().some((sql) => sql.includes("SELECT *"))).toBe(false);
  });
});

// ===========================================================================
// THE RESPONSE -- 204, and what the middleware chain adds to it
// ===========================================================================

describe("the 204", () => {
  it("has no body and no Content-Type", async () => {
    // `c.body(null, 204)`. A 204 with a body is a protocol violation that some
    // intermediaries reject outright, and the beacon has nothing to say anyway.
    const res = await beacon(`/needs/at/${SALISBURY}/hit/`);

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.get("Content-Type")).toBeNull();
  });

  it("carries Content-Language and the three security headers", async () => {
    // resolveLanguage and securityHeaders are mounted on "*" and run on the way
    // out, so they stamp even a bodiless response. Pinned because a 204 is
    // exactly the sort of response a future "skip the middleware for the hot
    // path" optimisation would quietly exclude.
    const res = await beacon(`/needs/at/${SALISBURY}/hit/`);

    expect(res.headers.get("Content-Language")).toBe("en");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  });

  it("sets neither Cache-Control nor Expires, unlike Django's @never_cache", async () => {
    // A DIVERGENCE, pinned as-is rather than wished away. gfwfbn/views.py:1205
    // is `@never_cache`. RUN, not reasoned -- the decorator was applied to a
    // 204-returning view under the Django 5.2.6 on this machine and the
    // response printed:
    //   Cache-Control: 'max-age=0, no-cache, no-store, must-revalidate, private'
    //   Expires:       'Tue, 08 Sep 2026 10:48:45 GMT'
    // This port sends neither, and middleware/pageCacheControl.ts declines to
    // fill the gap because it only ever touches a GET. Harmless in practice --
    // no cache stores a POST response -- but it is a real difference from the
    // source this file cites, and it stops being harmless the day the beacon
    // grows a GET form or sits behind an intermediary that ignores the method.
    const res = await beacon(`/needs/at/${SALISBURY}/hit/`);

    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(res.headers.get("Expires")).toBeNull();
  });

  it("is stamped with the food bank's cache tag, even though a 204 is not cacheable", async () => {
    // middleware/cacheTag.ts tags by PATH and skips only non-2xx and
    // no-store/private responses, and a 204 is neither -- so this response
    // carries `fb-salisbury`. Pinned because it is surprising, not because it
    // is wrong: it is inert (there is nothing in any cache to purge), and it is
    // the price of the "a rule over the path cannot rot" design that comment
    // argues for.
    const res = await beacon(`/needs/at/${SALISBURY}/hit/`);

    expect(res.headers.get("Cache-Tag")).toBe("fb-salisbury");
  });
});

// ===========================================================================
// ROUTING -- none of this lives in hit.ts, all of it decides whether it runs
// ===========================================================================

describe("where the beacon is and is not mounted", () => {
  it("does not fire on GET, which falls through to the location page and 404s", async () => {
    // index.ts:375 registers POST only. Django's view is `@require_POST`, which
    // answers 405; here the GET is instead swallowed by
    // `app.get("/needs/at/:slug/:locslug/")` (index.ts:315) with locslug="hit",
    // which finds no such location and 404s. DIVERGENCE FROM DJANGO on the
    // status code, pinned as the port's actual behaviour.
    //
    // What matters far more than the number: NO data point. A GET that counted
    // would let any crawler, prefetcher or link-preview bot inflate a food
    // bank's figures just by following a URL.
    const request = new Request(`${ORIGIN}/needs/at/${SALISBURY}/hit/`);
    const res = await app.fetch(request, env(), execCtx);

    expect(res.status).toBe(404);
    expect(points).toEqual([]);
    // Proof of WHICH route answered, and therefore of why the status is 404
    // and not 405: `SELECT *` is wfbnFoodbankLocation's getFoodbankBySlug, and
    // hit.ts never issues it.
    expect(foodbankQueries()).toContain("SELECT * FROM foodbank WHERE slug = ?");
  });

  it("does not fire on HEAD, PUT, DELETE or PATCH either", async () => {
    // HEAD is included because lib/appendSlash.ts probes with one, and because
    // a link-checker or an uptime monitor sends nothing else.
    for (const method of ["HEAD", "PUT", "DELETE", "PATCH"]) {
      const request = new Request(`${ORIGIN}/needs/at/${SALISBURY}/hit/`, { method });
      const res = await app.fetch(request, env(), execCtx);
      expect(res.status, method).toBe(404);
    }
    expect(points).toEqual([]);
  });

  it("404s the unslashed /hit and does NOT redirect, so the POST is never replayed", async () => {
    // lib/appendSlash.ts restricts APPEND_SLASH to GET/HEAD -- a deliberate
    // deviation from Django, which 301s a POST too. On this endpoint the
    // Django behaviour would be worse than a 404: a browser following a 301
    // from a POST re-issues it as a GET, which lands on the location page above
    // and counts nothing, while the 301 itself is cached by the browser
    // forever.
    const res = await beacon(`/needs/at/${SALISBURY}/hit`);

    expect(res.status).toBe(404);
    expect(res.headers.get("Location")).toBeNull();
    expect(points).toEqual([]);
  });

  it("is not mounted under any language prefix", async () => {
    // gfwfbn/urls/generic.py is included in givefood/urls.py BEFORE
    // i18n_patterns, so `foodbank_hit` has exactly one URL in Django too, and
    // hit.njk's `url('wfbn-generic:foodbank_hit', slug)` reverses to the
    // unprefixed form on a Welsh page as much as on an English one. If that
    // ever stopped being true, every non-English page would beacon into a 404
    // and three languages' worth of traffic would vanish from the figures
    // without any page looking broken.
    for (const prefix of ["/cy", "/ga", "/gd", "/en"]) {
      const res = await beacon(`${prefix}/needs/at/${SALISBURY}/hit/`);
      expect(res.status, prefix).toBe(404);
    }
    expect(points).toEqual([]);
  });

  it("301s a renamed food bank's beacon before the handler ever runs, losing the hit", async () => {
    // middleware/slugRedirect.ts matches /needs/at/<slug>/<subpath>/ and
    // redirects on the old slug, so a page cached under a pre-rename URL
    // beacons into a 301. `fetch()` follows it, but a 301 turns a POST into a
    // GET, which the location route then 404s -- so the hit is lost twice over.
    //
    // Pinned as behaviour, not endorsed. Django did the same: its
    // SlugRedirectMiddleware matches
    // `^(/[a-z]{2})?/needs/at/([-\w]+)(/[-\w]+)?/?$` and returns
    // `redirect(new_path, permanent=True)` -- givefood/middleware.py:177 and
    // :197, read directly, NOT the ":171" the port's own slugRedirect.ts
    // header cites (that line is an `import re`). So the lost hit predates the
    // port; the affected window is however long a stale page survives.
    const res = await beacon(`/needs/at/${RENAMED_FROM}/hit/`);

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`/needs/at/${SALISBURY}/hit/`);
    expect(points).toEqual([]);
    // The redirect happens in middleware, so the handler's own SELECT never ran.
    expect(foodbankQueries()).toEqual([]);
  });
});

// ===========================================================================
// FAILURE
// ===========================================================================

describe("when the Analytics Engine binding fails", () => {
  it("500s rather than swallowing it -- there is no try/catch on the write", async () => {
    // Pinned as the CURRENT behaviour and flagged as questionable. The visitor
    // pays nothing (hit.njk ignores the response) so a 500 here is invisible to
    // them, but it is invisible to everyone else too: the 500 page is rendered
    // and thrown away by a `keepalive` fetch with no handler. If writeDataPoint
    // ever starts throwing in production, the only trace is the console.error
    // in index.ts's onError and a 500 rate on an endpoint nobody watches.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    hitsThrows = new Error("analytics engine unavailable");

    const res = await beacon(`/needs/at/${SALISBURY}/hit/`);

    expect(res.status).toBe(500);
    expect(errors).toHaveBeenCalled();
    // The lookup still happened -- the failure is on the write, after the 404
    // gate, which is why a failing binding cannot be mistaken for a bad slug.
    expect(foodbankQueries()).toEqual(["SELECT id FROM foodbank WHERE slug = ?"]);
  });
});

// ===========================================================================
// THE EXPORT ITSELF
// ===========================================================================

describe("wfbnFoodbankHit as a function", () => {
  it("exports exactly one symbol", async () => {
    // A second export would be a second thing to keep tested, and this file's
    // claim to cover the module rests on there being only the one.
    const module = await import("./hit");
    expect(Object.keys(module)).toEqual(["wfbnFoodbankHit"]);
  });

  // Mounted on a BARE Hono app at a path that shares nothing with the real one
  // -- no /needs/, no /hit/, and a differently-named prefix -- so the handler
  // is exercised with none of index.ts's middleware present and with a URL that
  // would produce a different answer if the slug were derived from the path
  // instead of read off the route param. It reproduces exactly the assertions
  // the routed tests make, which is the evidence that those tests are testing
  // this function and not the router around it.
  function bare(): Hono<AppEnv> {
    const isolated = new Hono<AppEnv>();
    isolated.post("/anything/:slug/counted/", wfbnFoodbankHit);
    return isolated;
  }

  it("beacons off the route param, with no middleware in front of it", async () => {
    const request = new Request(`${ORIGIN}/anything/${SALISBURY}/counted/`, { method: "POST" });
    Object.defineProperty(request, "cf", { value: { country: "IE" }, enumerable: true });

    const res = await bare().fetch(request, env(), execCtx);

    expect(res.status).toBe(204);
    expect(points).toEqual([{ indexes: [SALISBURY], blobs: [SALISBURY, "IE"], doubles: [1] }]);
  });

  it("404s an unknown slug with no middleware in front of it either", async () => {
    // The 404 is the handler's own `c.notFound()`, not index.ts's rendered 404
    // page -- so on a bare app it is Hono's default text. Asserting it here
    // separates "the handler refuses" from "the site's error page happened to
    // render", which the routed tests above cannot tell apart.
    const request = new Request(`${ORIGIN}/anything/no-such-foodbank/counted/`, { method: "POST" });

    const res = await bare().fetch(request, env(), execCtx);

    expect(res.status).toBe(404);
    expect(points).toEqual([]);
  });
});
