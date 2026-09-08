import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/wfbn/nearby.ts -- wfbnFoodbankNearby, GET /needs/at/<slug>/nearby/
// and its three locale-prefixed twins. Ported from gfwfbn/views.py:661-685
// (`foodbank_nearby`), read in full alongside this file, together with
// gfwfbn/templates/wfbn/foodbank/nearby.html, givefood/utils/geo.py's
// find_locations() (:246-301) and givefood/middleware.py's GeoJSONPreload.
//
// WHY THIS FILE EXISTS. Every visible symptom of this page being wrong looks
// exactly like it being right: it is a list of place names with a mileage
// against each, and nobody reading it can tell a correct one from a
// plausible one.
//
//   * the whole page hangs off find_locations(lat_lng, 20, True) --
//     skip_first=True. The item dropped is index 0 of a GLOBAL ranking, not
//     "the food bank itself"; those are the same thing only while the food
//     bank is in the candidate set at all, which a CLOSED one is not;
//   * the candidate scans filter is_closed = 0 on both tables. A filter that
//     stopped working would put shut food banks back on the page, which is
//     the single worst thing this site can tell someone;
//   * the list interleaves two row KINDS with different markup and different
//     URL shapes -- an organisation links to /needs/at/<slug>/, a location to
//     /needs/at/<foodbank_slug>/<slug>/ and additionally prints its parent's
//     name. Rank the two kinds separately and the page still renders;
//   * `nearby` is deliberately NULLED when empty, for a Nunjucks truthiness
//     gotcha that -- measured, not assumed -- this particular template cannot
//     actually exhibit (see the empty-list test);
//   * map_config is a JSON STRING handed to the map JS, and this page's is
//     the only one in the wfbn family that points at the SITE-WIDE geojson
//     rather than the food bank's own -- as does its preload Link header.
//
// So every assertion below reads a VALUE out of the rendered body, out of the
// map config string, or off a response header -- never a bare status code.
//
// REAL EVERYTHING, the harness routes/wfbn/foodbank.test.ts already uses (this
// file's primary style reference, matching nearby.ts's own choice of primary
// style reference): the real production app (src/index.ts's default export),
// so the four locale registrations, resolveLanguage, slugRedirect, cacheTag,
// geoJsonPreload and pageCacheControl are the genuine articles rather than a
// hand-built router; the real @givefood/geo ranking; the real Nunjucks
// templates and the real .po catalogues; the real packages/db queries over
// real in-memory SQLite whose DDL comes from schemaFor(), i.e. from the
// migrations. Nothing this route touches leaves the machine, so NOTHING is
// mocked -- there is not a single vi.fn() in this file except a console.error
// silencer.
//
// PARITY CLAIMS. Where a comment says "Django does X", X was read out of
// /Users/jasoncartwright/Sites/foodcharity (gfwfbn/views.py,
// givefood/utils/geo.py, givefood/middleware.py and the wfbn/foodbank
// templates). No Python was EXECUTED for this file -- where a claim would need
// a running Django to settle it, the comment says so rather than inventing a
// citation.

const ORIGIN = "https://www.givefood.org.uk";

type Bindable = null | number | bigint | string | Uint8Array;

// One statement as it reached the engine: the SQL text and the values bound to
// it. The bindings matter as much as the text here -- the two candidate scans
// take NO bindings (they are whole-table covering-index scans) while the three
// hydration reads take exactly the ids that won, and "which ids were hydrated"
// is the difference between this page costing five small reads and it costing
// two full-table reads of 40-80 column rows.
interface Prepared {
  sql: string;
  params: Bindable[];
}

// The slice of the D1 Sessions API packages/db uses, over node:sqlite. Same
// shim as routes/wfbn/foodbank.test.ts, including its `batch` --
// getFoodbankBySlug sends the food bank row and its latest need as ONE batch
// and indexes straight into the result array, so this must run them in order
// and return one result per input.
function d1Session(db: DatabaseSync, prepared: Prepared[]): D1DatabaseSession {
  const statement = (sql: string, entry: Prepared) => ({
    sql,
    get params() {
      return entry.params;
    },
    bind: (...next: unknown[]) => {
      entry.params = next as Bindable[];
      return statement(sql, entry);
    },
    first: async <T>() => (db.prepare(sql).get(...entry.params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...entry.params), success: true, meta: {} }),
    run: async () => {
      db.prepare(sql).run(...entry.params);
      return { success: true, meta: {} };
    },
  });
  return {
    prepare: (sql: string) => {
      const entry: Prepared = { sql, params: [] };
      prepared.push(entry);
      return statement(sql, entry);
    },
    batch: async (statements: Array<{ sql: string; params: Bindable[] }>) =>
      statements.map((s) => ({ results: db.prepare(s.sql).all(...s.params), success: true, meta: {} })),
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let prepared: Prepared[];
let sessions: number;

function env(): AppEnv["Bindings"] {
  return {
    DB: {
      withSession: () => {
        sessions += 1;
        return d1Session(db, prepared);
      },
    },
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: { get: async () => null, put: async () => {}, delete: async () => {} },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    D1_DATABASE_NAME: "givefood-test",
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

// ---------------------------------------------------------------------------
// Seeds. Only the columns this page reads are parameterised; every other NOT
// NULL column is filled with something the real migration accepts, so a seeded
// row is one production would have taken.
//
// latitude/longitude are REAL columns SEPARATE from the lat_lng TEXT string,
// and this page uses both: lat_lng is split for the search ORIGIN and printed
// verbatim into <meta name="geo.position">, while latitude/longitude are what
// the two candidate scans rank. Every seed below sets them consistently, which
// is what production does -- but they are genuinely independent columns, and
// the "origin and candidate disagree" test below relies on that.
// ---------------------------------------------------------------------------

interface FoodbankSeed {
  id: number;
  slug: string;
  name: string;
  lat: number;
  lng: number;
  latLng?: string;
  altName?: string | null;
  country?: string;
  charityName?: string | null;
  charityNumber?: string | null;
  isClosed?: 0 | 1;
  noLocations?: number;
  latestNeedId?: number | null;
}

function seedFoodbank(s: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, alt_name, slug, address, postcode, country, lat_lng,
       latitude, longitude, network, charity_number, charity_just_foodbank, charity_name,
       contact_email, url, shopping_list_url, address_is_administrative, is_closed,
       no_locations, no_donation_points, days_between_needs, latest_need_id, created, modified)
     VALUES (?, ?, ?, ?, ?, '12 High Street\r\nHarnham', 'SP2 8LZ', ?, ?, ?, ?, NULL, ?, 0, ?, ?,
       ?, ?, 0, ?, ?, 0, 14, ?,
       '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run(
    s.id,
    String(s.id).padStart(32, "a"),
    s.name,
    s.altName ?? null,
    s.slug,
    s.country ?? "England",
    s.latLng ?? `${s.lat},${s.lng}`,
    s.lat,
    s.lng,
    s.charityNumber ?? null,
    s.charityName ?? null,
    `info@${s.slug}.invalid`,
    `https://${s.slug}.invalid/`,
    `https://${s.slug}.invalid/list/`,
    s.isClosed ?? 0,
    s.noLocations ?? 0,
    s.latestNeedId ?? null,
  );
}

// `created`/`modified` are TEXT and are written in Django's own spelling
// ("2026-09-05 19:28:08.853000", a space and six digits of microseconds)
// throughout, because that is what the ETL copied out of Postgres and what
// every lexicographic comparison in this codebase is written against.
function seedNeed(o: { id: number; foodbankId: number; changeText: string }): void {
  db.prepare(
    `INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, excess_change_text,
       published, input_method, created, modified)
     VALUES (?, ?, ?, ?, NULL, 1, 'scrape', '2026-09-05 19:28:08.853000', '2026-09-05 19:28:08.853000')`,
  ).run(o.id, String(o.id).padStart(32, "b"), o.foodbankId, o.changeText);
}

function seedLocation(o: {
  id: number;
  foodbankId: number;
  name: string;
  slug: string;
  lat: number;
  lng: number;
  isClosed?: 0 | 1;
  boundary?: string | null;
}): void {
  db.prepare(
    `INSERT INTO foodbanklocation (id, uuid, foodbank_id, name, slug, address, postcode, country,
       lat_lng, latitude, longitude, is_closed, boundary_geojson, phone_number, email, modified)
     VALUES (?, ?, ?, ?, ?, '1 Side Street', 'SP1 1AA', 'England', ?, ?, ?, ?, ?, NULL, NULL,
       '2020-01-01 00:00:00.000000')`,
  ).run(
    o.id,
    String(o.id).padStart(32, "e"),
    o.foodbankId,
    o.name,
    o.slug,
    `${o.lat},${o.lng}`,
    o.lat,
    o.lng,
    o.isClosed ?? 0,
    o.boundary ?? null,
  );
}

// THE FIXTURE IS THE RANKING. Every coordinate below is a real point in
// Wiltshire, and the distances they produce from Salisbury INTERLEAVE the two
// row kinds -- location, location, organisation, location, location,
// organisation, organisation. A port that ranked food banks and locations as
// two separate lists and concatenated them would render a plausible page and
// fail every ordering assertion here.
//
// Distances from 51.0688,-1.7945, in the miles this page prints (computed with
// @givefood/geo's own haversineMeters/miles at R_EARTHDISTANCE while writing
// the fixture, and re-derived independently by the DISTANCES table below):
//
//   fb  1 salisbury          0.000000   the page's own subject -- index 0
//   loc 101 harnham          0.000000   ties with it, on the same spot
//   loc 102 bemerton         0.798603
//   fb  2 wilton             2.950225
//   loc 104 downton          5.137572
//   loc 105 tisbury         12.245657
//   fb  3 andover           16.587269
//   fb  5 shaftesbury       18.034474
//
// And two rows that MUST NEVER APPEAR, both sited ~9 metres from Salisbury so
// they would rank second and third if the is_closed filters stopped working:
//
//   fb  4 closed-bank       is_closed = 1
//   loc 103 closed-outreach is_closed = 1
function seed(): void {
  seedFoodbank({
    id: 1,
    slug: "salisbury",
    name: "Salisbury",
    lat: 51.0688,
    lng: -1.7945,
    charityNumber: "1130237",
    charityName: "Salisbury Foodbank Trust",
    noLocations: 2,
    latestNeedId: 101,
  });
  seedNeed({ id: 101, foodbankId: 1, changeText: "Tinned soup\nLong life milk" });

  // alt_name is deliberately NOT "Banc Bwyd Wilton": that is exactly what the
  // cy prefix branch would produce from the bare name anyway, so an
  // alt_name-shaped alt_name makes a test unable to tell "alt_name won" from
  // "alt_name was ignored".
  seedFoodbank({
    id: 2,
    slug: "wilton",
    name: "Wilton",
    altName: "Pantri Bwyd Dyffryn Wylye",
    country: "Wales",
    lat: 51.08,
    lng: -1.86,
    latestNeedId: 102,
  });
  seedNeed({ id: 102, foodbankId: 2, changeText: "Nappies" });

  seedFoodbank({ id: 3, slug: "andover", name: "Andover", lat: 51.2113, lng: -1.4871, latestNeedId: 103 });
  seedNeed({ id: 103, foodbankId: 3, changeText: "Rice" });

  // Closed, and sited about nine metres from Salisbury -- so it is the second
  // nearest thing in the fixture and would head the list if `is_closed = 0`
  // ever fell out of getOpenFoodbankCoordinates. It also has a nearby page of
  // its own (Django's get_object_or_404 does not filter is_closed), which is
  // what the skip_first test below is about.
  seedFoodbank({ id: 4, slug: "closed-bank", name: "Closed Bank", lat: 51.0689, lng: -1.7946, isClosed: 1, latestNeedId: 104 });
  seedNeed({ id: 104, foodbankId: 4, changeText: "Nothing" });

  // Jersey is outside CHARITY_DETAIL_COUNTRIES, so has_charity_details is
  // false here and true for Salisbury -- the one context value this handler
  // computes that nothing else on the page can produce.
  seedFoodbank({
    id: 5,
    slug: "shaftesbury",
    name: "Shaftesbury",
    country: "Jersey",
    charityNumber: "NPO123",
    charityName: "Shaftesbury Trust",
    lat: 51.0057,
    lng: -2.1968,
    latestNeedId: 105,
  });
  seedNeed({ id: 105, foodbankId: 5, changeText: "Pasta" });

  // Salisbury's OWN location, on the same spot as Salisbury itself. skip_first
  // drops index 0 of the ranking, and stable sorting puts the food bank there
  // (candidates are spread food-banks-first), so this location survives at
  // 0.0mi -- the page lists a food bank's own outreach centre while hiding the
  // food bank. Both halves are asserted below.
  seedLocation({ id: 101, foodbankId: 1, name: "Harnham Centre", slug: "harnham", lat: 51.0688, lng: -1.7945 });
  seedLocation({
    id: 102,
    foodbankId: 2,
    name: "Bemerton Pantry",
    slug: "bemerton",
    lat: 51.075,
    lng: -1.81,
    boundary: '{"type":"Polygon","coordinates":[]}',
  });
  seedLocation({ id: 103, foodbankId: 2, name: "Closed Outreach", slug: "closed-outreach", lat: 51.0689, lng: -1.7946, isClosed: 1 });
  seedLocation({ id: 104, foodbankId: 3, name: "Downton Hub", slug: "downton", lat: 51.0, lng: -1.75 });
  seedLocation({ id: 105, foodbankId: 5, name: "Tisbury Store", slug: "tisbury", lat: 51.062, lng: -2.076 });
}

beforeEach(async () => {
  db = new DatabaseSync(":memory:");
  // schemaFor, not hand-written DDL: getFoodbankBySlug reads through the
  // `foodbankchange_full` VIEW and findLocations' hydration reads through
  // `foodbanklocation_full` (github #51 -- eight suites 500'd at once when the
  // first of those started doing so), and `slugredirect` is read by the
  // slugRedirect middleware on every /needs/at/ URL whether this route wants it
  // or not.
  db.exec(schemaFor("foodbank", "foodbankchange", "foodbankchange_full", "foodbanklocation", "foodbanklocation_full", "slugredirect"));
  seed();
  prepared = [];
  sessions = 0;

  // WARM THE SLUG-REDIRECT MEMO BEFORE COUNTING ANYTHING. middleware/
  // slugRedirect.ts holds its map in a MODULE-level memo with a 5-minute TTL,
  // so the first /needs/at/ request through this file's isolate opens a second
  // D1 session and issues a `SELECT ... FROM slugredirect` that no later
  // request repeats. Without this line the query-count assertions below would
  // depend on which test ran first -- which is exactly the kind of
  // order-dependence that makes a suite flaky when someone adds a `.only`.
  await get("/needs/at/warm-the-memo/nearby/");
  prepared = [];
  sessions = 0;
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

// `async`, not a bare arrow: app.fetch is typed Response | Promise<Response>.
const get = async (path: string, init?: RequestInit): Promise<Response> => app.fetch(new Request(`${ORIGIN}${path}`, init), env(), execCtx);
const body = async (path: string): Promise<string> => (await get(path)).text();

// One rendered row of the nearby list, flattened to a single comparable
// string: "<href>|<name>|<parent name or empty>|<distance text>". The parent
// group is optional in the regex on purpose -- an ORGANISATION row has no
// "(...)" segment at all, and a location row that lost its parent name would
// otherwise be indistinguishable from an organisation row in a `toContain`
// assertion.
const ROW = /<a href="([^"]+)">([^<]*)<\/a>(?: \(([^)]*)\))? <span class="is-size-7">([^<]*)<\/span><br>/g;

function rowsOf(html: string): string[] {
  return Array.from(html.matchAll(ROW), (m) => `${m[1]}|${m[2]}|${m[3] ?? ""}|${m[4]}`);
}

const nearbyRows = async (path: string): Promise<string[]> => rowsOf(await body(path));

// includes/mapconfig.njk drops `map_config` into a <script> verbatim, so the
// string between "= " and ";" is exactly what the map JS parses.
function mapConfigOf(html: string): string {
  const match = /window\.gfMapConfig = ([\s\S]*?);\n/.exec(html);
  if (!match) throw new Error("no gfMapConfig in the rendered page");
  return match[1] as string;
}

describe("wfbnFoodbankNearby -- the response envelope", () => {
  // Django's `foodbank_nearby` is @cache_page(SECONDS_IN_WEEK)
  // (gfwfbn/views.py:660, the decorator above the def at 661), and
  // middleware/pageCacheControl.ts carries a rule for exactly this suffix --
  // `p.endsWith("/nearby/")` -> 604800 -- rather
  // than letting it fall through to the DAY default every other food bank page
  // gets. A week is right because the answer only changes when a NEIGHBOUR
  // opens or closes, not when this food bank's shopping list does. The browser
  // number is deliberately NOT Django's: BROWSER_MAX_AGE is 300 because a
  // browser cache cannot be purged.
  it("serves cacheable HTML with Django's week at the purgeable edge, not the site-wide day", async () => {
    const res = await get("/needs/at/salisbury/nearby/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=604800");
    expect(res.headers.get("Content-Language")).toBe("en");
    // The neighbouring /needs/at/<slug>/ page is the one that falls through to
    // DAY. Asserted here because the two rules live in one ordered list and a
    // reordering that broke the suffix rule would be invisible on this page
    // alone.
    expect((await get("/needs/at/salisbury/")).headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
  });

  // THE TAG IS WHY THE WEEK ABOVE IS SAFE. queues/cachePurge.ts purges by
  // `fb-<slug>`; without this header an edge copy of this list would sit there
  // for seven days with no way to revoke it. Cloudflare strips Cache-Tag before
  // the browser sees it, so nobody would notice its absence from outside.
  //
  // NOTE WHOSE TAG IT IS. cacheTag derives it from the PATH, so this page is
  // tagged for the food bank it is ABOUT, not for the seven neighbours listed
  // on it. A neighbour opening or closing therefore does not purge this page --
  // documented, not endorsed; it is the same rule Django's hand-maintained
  // purge list in models/foodbank.py's save() applies.
  it("stamps the subject food bank's purge tag, and only that one", async () => {
    expect((await get("/needs/at/salisbury/nearby/")).headers.get("Cache-Tag")).toBe("fb-salisbury");
    expect((await get("/cy/needs/at/salisbury/nearby/")).headers.get("Cache-Tag")).toBe("fb-salisbury");
  });

  // THE SITE-WIDE GEOJSON, NOT THIS FOOD BANK'S. givefood/middleware.py's
  // GeoJSONPreload gives `foodbank_nearby` its own branch returning
  // reverse("wfbn:geojson") -- because the map on this page plots every food
  // bank in the country, not one. The neighbouring /needs/at/<slug>/ page
  // preloads /needs/at/<slug>/geo.json instead, and confusing the two costs a
  // wasted preload of a several-hundred-kilobyte document.
  //
  // The locale-prefixed page gets NO hint, because index.ts registers
  // "/cy/needs/at/:slug/nearby/" as its own route and geoJsonPreload compares
  // routePath against the unprefixed literal -- a real divergence from Django,
  // already pinned in middleware/geoJsonPreload.test.ts and asserted here
  // because this is one of the pages it costs.
  it("preloads the whole-country geojson in English and, divergently, nothing in Welsh", async () => {
    expect((await get("/needs/at/salisbury/nearby/")).headers.get("Link")).toBe(
      "</needs/geo.json>; rel=preload; as=fetch; crossorigin=anonymous",
    );
    expect((await get("/needs/at/salisbury/")).headers.get("Link")).toBe(
      "</needs/at/salisbury/geo.json>; rel=preload; as=fetch; crossorigin=anonymous",
    );
    expect((await get("/cy/needs/at/salisbury/nearby/")).headers.get("Link")).toBeNull();
  });

  // ONE D1 SESSION, SIX STATEMENTS, AND THE SHAPE OF THEM.
  //
  // lib/session.ts opens a single withSession("first-unconstrained") per
  // request so every query sees one snapshot of a replicated database. That
  // matters more here than on most pages: the ranking is computed in
  // application code from one scan and then hydrated by a second, so two
  // snapshots could rank an id that the hydration read no longer returns --
  // which findLocations turns into a 500, not a shortened list.
  //
  // The shape is the WP 2.5 pattern: TWO covering-index scans over three
  // columns of every open row (no bindings at all), then full rows for the
  // ranked winners only, then one more pair for the winning LOCATIONS' parent
  // food banks -- a location row carries no latest_need of its own. If the
  // first two ever grew a `SELECT *`, this page would pull thousands of 40-80
  // column rows to render seven.
  it("reads the page from one session: the batched pair, two coordinate scans, then hydration by id", async () => {
    await get("/needs/at/salisbury/nearby/");

    expect(sessions).toBe(1);
    expect(prepared.map((p) => [p.sql, p.params])).toEqual([
      // getFoodbankBySlug's batch. Both statements go out in one round trip,
      // and the second is fetched even though this page never renders a need --
      // it is the price of reusing the shared by-slug reader.
      ["SELECT * FROM foodbank WHERE slug = ?", ["salisbury"]],
      ["SELECT * FROM foodbankchange_full WHERE id = (SELECT latest_need_id FROM foodbank WHERE slug = ?)", ["salisbury"]],
      // The two candidate scans, issued concurrently and bound to nothing.
      ["SELECT id, latitude, longitude FROM foodbank WHERE is_closed = 0", []],
      ["SELECT id, latitude, longitude FROM foodbanklocation WHERE is_closed = 0", []],
      // Wave two: the ranked winners, by id, in ranked order. Three food banks
      // and four locations out of a five-and-five candidate set.
      ["SELECT * FROM foodbank WHERE id IN (?, ?, ?)", [2, 3, 5]],
      ["SELECT * FROM foodbanklocation_full WHERE id IN (?, ?, ?, ?)", [101, 102, 104, 105]],
      ["SELECT * FROM foodbankchange_full WHERE id IN (?, ?, ?)", [102, 103, 105]],
      // Wave three: the winning locations' parents, deduplicated (Wilton
      // appears twice over -- as a winner in its own right and as Bemerton's
      // parent) and, per findLocations' documented redundancy, re-read even
      // though wave two already had them.
      ["SELECT * FROM foodbank WHERE id IN (?, ?, ?, ?)", [1, 2, 3, 5]],
      ["SELECT * FROM foodbankchange_full WHERE id IN (?, ?, ?, ?)", [101, 102, 103, 105]],
    ]);
  });

  // An unknown slug is Django's get_object_or_404. It must reach the real 404
  // page and, above all, must NOT be stamped cacheable: pageCacheControl only
  // touches 200s and cacheTag only touches ok responses, so a mistyped slug
  // cannot poison the edge with a WEEK-long negative entry -- which on this
  // route is seven times worse than on any other food bank page.
  it("404s an unknown slug, uncached and untagged, without scanning anything", async () => {
    const res = await get("/needs/at/nowhere/nearby/");

    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(res.headers.get("Cache-Tag")).toBeNull();
    // The `if (!foodbank) return c.notFound()` guard comes BEFORE
    // findLocations, so a bad slug costs the batch and nothing else. Two full
    // covering-index scans per 404 would be a cheap way to make a crawler
    // expensive.
    expect(prepared.map((p) => p.sql)).toEqual([
      "SELECT * FROM foodbank WHERE slug = ?",
      "SELECT * FROM foodbankchange_full WHERE id = (SELECT latest_need_id FROM foodbank WHERE slug = ?)",
    ]);
  });

  // lib/appendSlash.ts, Django's APPEND_SLASH. The slashless spelling is what a
  // hand-typed URL and a good many inbound links look like.
  it("redirects the slashless spelling rather than 404ing it", async () => {
    const res = await get("/needs/at/salisbury/nearby");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/needs/at/salisbury/nearby/`);
  });

  // GET ONLY, matching Django's `foodbank_nearby`. index.ts registers this with
  // app.get; a stray app.all would hand a POST to a handler whose response
  // pageCacheControl then stamps public for a WEEK. The handler reads nothing
  // from a body, so a POST that reached it would render and be cached.
  it("does not answer a POST at all", async () => {
    expect((await get("/needs/at/salisbury/nearby/", { method: "POST" })).status).toBe(404);
  });

  // A GET THAT WRITES IS THE FAILURE THIS ASSERTS AGAINST -- a route in this
  // repo has been caught with one before. Every statement that reaches the
  // engine is a SELECT, in every locale and with a query string attached. A
  // page stamped `public, s-maxage=604800` cannot afford a side effect: the
  // edge would serve it once and swallow every subsequent one for a week.
  it("issues nothing but SELECTs, in any locale and with any query string", async () => {
    await get("/needs/at/salisbury/nearby/?utm_source=newsletter&email=donor%40example.org");
    await get("/gd/needs/at/salisbury/nearby/");

    expect(prepared).not.toHaveLength(0);
    for (const { sql } of prepared) expect(sql).toMatch(/^SELECT /);
  });

  // The slug comparison is SQLite's default case-sensitive `=` on TEXT, so a
  // shouted URL is a 404 rather than a second, uncanonical spelling of the
  // page. Django's slug lookup is exact too.
  it("does not answer a differently-cased slug", async () => {
    expect((await get("/needs/at/SALISBURY/nearby/")).status).toBe(404);
    expect((await get("/needs/at/Salisbury/nearby/")).status).toBe(404);
  });

  // A D1 outage must produce the 500 page, not a nearby page with an empty
  // list -- and must not be cached, or a WEEK of "there is nothing near you"
  // goes out to everyone.
  it("500s, uncached, when the database is unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      ...env(),
      DB: {
        withSession: () => {
          throw new Error("D1_ERROR: network");
        },
      },
    } as unknown as AppEnv["Bindings"];

    const res = await app.fetch(new Request(`${ORIGIN}/needs/at/salisbury/nearby/`), broken, execCtx);

    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(await res.text()).not.toContain("Harnham Centre");
  });

  // elapsedMs() reports WHOLE milliseconds, deliberately unlike Django's three
  // decimal places -- on Workers performance.now() is coarsened and the
  // fraction was always ".000", decoration that reads like precision. A revert
  // to toFixed(3) shows up here as "Took 0.000ms"; dropping render_time_ms
  // leaves "Took ms". Only the FORMAT is asserted: 0 is a legitimate value on
  // the clock this exists to describe.
  it("stamps the debug comment with a whole-millisecond render time", async () => {
    expect(/⏱️ Took (\S+)/.exec(await body("/needs/at/salisbury/nearby/"))?.[1]).toMatch(/^\d+ms$/);
  });

  // "en" is never a URL prefix (prefix_default_language=False in Django, and
  // resolveLanguage's PREFIXES set excludes it), and an unrecognised prefix is
  // not a locale at all. Both spellings are 404s here as they are in
  // production, rather than second, uncanonical copies of a page the edge is
  // told to keep for a week.
  it("answers only under the three real locale prefixes", async () => {
    for (const locale of ["cy", "ga", "gd"]) {
      expect((await get(`/${locale}/needs/at/salisbury/nearby/`)).status).toBe(200);
    }
    expect((await get("/en/needs/at/salisbury/nearby/")).status).toBe(404);
    expect((await get("/de/needs/at/salisbury/nearby/")).status).toBe(404);
  });
});

describe("wfbnFoodbankNearby -- the list, which is the whole page", () => {
  // THE HAPPY PATH, asserted as the WHOLE list in order rather than as a
  // handful of `toContain`s. Every part of a row is here: the URL shape (two
  // segments for a location, one for an organisation), the name, the parent
  // name a location prints in brackets and no organisation does, and the
  // mileage.
  //
  // The order interleaves the two kinds -- location, location, organisation,
  // location, location, organisation, organisation -- which is what PLAN.md
  // §7.5.2's "rank as ONE list" means in practice. A port that took the
  // nearest N food banks and the nearest N locations and concatenated them
  // renders a perfectly plausible page and fails this.
  it("lists every open neighbour once, nearest first, with the right markup per kind", async () => {
    expect(await nearbyRows("/needs/at/salisbury/nearby/")).toEqual([
      "/needs/at/salisbury/harnham/|Harnham Centre|Salisbury|0.0mi away",
      "/needs/at/wilton/bemerton/|Bemerton Pantry|Wilton|0.8mi away",
      "/needs/at/wilton/|Wilton||3.0mi away",
      "/needs/at/andover/downton/|Downton Hub|Andover|5.1mi away",
      "/needs/at/shaftesbury/tisbury/|Tisbury Store|Shaftesbury|12.2mi away",
      "/needs/at/andover/|Andover||16.6mi away",
      "/needs/at/shaftesbury/|Shaftesbury||18.0mi away",
    ]);
  });

  // THE ROW THAT IS NOT THERE, which is the only kind of assertion that can
  // fail when a filter stops filtering. Both closed rows sit about nine metres
  // from Salisbury, so if `WHERE is_closed = 0` fell out of either coordinate
  // scan they would be second and third in the list above -- and this site
  // sending someone to a food bank that has shut is the worst single thing it
  // can do. Seeding them far away instead would have made this test pass
  // against a scan with no filter at all.
  it("excludes closed food banks and closed locations even when they are the nearest things there are", async () => {
    const html = await body("/needs/at/salisbury/nearby/");

    expect(html).not.toContain("Closed Bank");
    expect(html).not.toContain("closed-outreach");
    // And they really are nearer than everything that IS listed -- otherwise
    // the negatives above would hold for a filter that never ran.
    expect(rowsOf(html)[0]).toBe("/needs/at/salisbury/harnham/|Harnham Centre|Salisbury|0.0mi away");
  });

  // skip_first=True, the whole reason this page calls find_locations with a
  // third argument. Salisbury is at distance zero from itself and is dropped;
  // its own location, on the very same spot, is NOT -- only index 0 goes.
  //
  // Both halves matter. A port that filtered "any row belonging to this food
  // bank" would silently lose Harnham Centre, and a port that dropped nothing
  // would head every nearby page with "Salisbury, 0.0mi away".
  it("drops the food bank itself but keeps its own co-located outreach centre", async () => {
    const rows = await nearbyRows("/needs/at/salisbury/nearby/");

    expect(rows).not.toContain("/needs/at/salisbury/|Salisbury||0.0mi away");
    expect(rows.some((row) => row.startsWith("/needs/at/salisbury/|"))).toBe(false);
    expect(rows[0]).toBe("/needs/at/salisbury/harnham/|Harnham Centre|Salisbury|0.0mi away");
  });

  // SUSPECT, PINNED AS-IS, AND IT IS PARITY RATHER THAN A PORT DEFECT.
  // skip_first drops index 0 of the ranking, on the assumption that index 0 is
  // the food bank whose page this is. For a CLOSED food bank that assumption is
  // false: the candidate scans filter is_closed = 0, so the subject is not in
  // the ranking at all and the item dropped is a real, open neighbour.
  //
  // Closed Bank sits nine metres from Salisbury, so Salisbury is genuinely its
  // nearest neighbour -- and is exactly what disappears from its page. Django
  // does the same: find_locations() filters is_closed=False on both querysets
  // and then slices [1:], while foodbank_nearby's get_object_or_404 does not
  // filter is_closed. Closed food banks keep their pages indefinitely (the
  // `is_closed` banner is the point of them), so this is a live state, not a
  // hypothetical.
  it("SUSPECT: a closed food bank's page silently drops a real neighbour instead of itself", async () => {
    const rows = await nearbyRows("/needs/at/closed-bank/nearby/");

    // Salisbury is the nearest open thing to Closed Bank, and it is gone.
    expect(rows.some((row) => row.startsWith("/needs/at/salisbury/|"))).toBe(false);
    // Its co-located location, one place further down the ranking, survives --
    // which is what makes the omission look like a rendering quirk rather than
    // a missing row.
    expect(rows[0]).toBe("/needs/at/salisbury/harnham/|Harnham Centre|Salisbury|0.0mi away");
    expect(rows).toHaveLength(7);
  });

  // The window is TWENTY items after the skip, not nineteen: Django writes it
  // as `first_item = 1; quantity = quantity + 1` then `[first_item:quantity]`,
  // so the window SHIFTS by one rather than shrinking. Twenty-five extra open
  // food banks strung out due north at 0.1 degrees (~6.9 miles) apart must
  // therefore yield exactly twenty rows -- and the twentieth is the
  // twenty-FIRST nearest candidate overall, because Salisbury itself took the
  // slot the window moved off.
  it("caps the list at twenty, shifting the window rather than shrinking it", async () => {
    for (let i = 0; i < 25; i++) {
      const id = 200 + i;
      seedFoodbank({ id, slug: `filler-${id}`, name: `Filler ${id}`, lat: 51.0688 + 0.1 * (i + 1), lng: -1.7945, latestNeedId: id });
      seedNeed({ id, foodbankId: id, changeText: "Soup" });
    }

    const rows = await nearbyRows("/needs/at/salisbury/nearby/");
    expect(rows).toHaveLength(20);
    // Still nearest-first across the join: the fillers interleave with the
    // fixture's own rows rather than being appended after them, which is the
    // half a bare length check cannot see.
    expect(rows.slice(0, 6)).toEqual([
      "/needs/at/salisbury/harnham/|Harnham Centre|Salisbury|0.0mi away",
      "/needs/at/wilton/bemerton/|Bemerton Pantry|Wilton|0.8mi away",
      "/needs/at/wilton/|Wilton||3.0mi away",
      "/needs/at/andover/downton/|Downton Hub|Andover|5.1mi away",
      "/needs/at/filler-200/|Filler 200||6.9mi away",
      "/needs/at/shaftesbury/tisbury/|Tisbury Store|Shaftesbury|12.2mi away",
    ]);
    // Nineteen rows would end at filler-211. Twenty-one would reach
    // filler-213. This is the one that says the window is Django's.
    expect(rows[19]).toBe("/needs/at/filler-212/|Filler 212||89.9mi away");
  });

  // THE ONLY-CANDIDATE CASE. Reachable in production for the last open food
  // bank in a region, and for every food bank at once during a bad ETL run. It
  // must render the page, not 500 and not print a stray empty row.
  //
  // ON THE `rawNearby.length > 0 ? rawNearby : null` CONVERSION, which is what
  // this test looks like it is about and is NOT. The handler's comment says the
  // conversion exists so nearby.njk's `{% if nearby %}` hides correctly, an
  // empty array being truthy in Nunjucks where Django's `if nearby:` is not.
  // The premise is right and the consequence does not follow HERE: that
  // `{% if %}` wraps nothing but a `{% for %}`, and a for-loop over an empty
  // array emits exactly what a skipped if-block does. Mutation-tested --
  // replacing the whole line with `const nearby = rawNearby;` and re-rendering
  // this page produced a byte-identical document (7,094 bytes both ways, modulo
  // the generated-at timestamp), and every test in this file still passed.
  //
  // So it is defensive rather than load-bearing, and this test deliberately
  // does not pretend otherwise by asserting something only the conversion could
  // produce. It pins what a VISITOR gets, which is what would actually regress
  // if nearby.njk ever grew a second use of `nearby` (a count, an "or nothing
  // nearby" else-branch) where the two spellings do diverge.
  it("renders an empty page rather than a stray row when the food bank is the only candidate", async () => {
    db.prepare("DELETE FROM foodbanklocation").run();
    db.prepare("DELETE FROM foodbank WHERE id != 1").run();

    const res = await get("/needs/at/salisbury/nearby/");
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(rowsOf(html)).toEqual([]);
    expect(html).not.toContain("mi away");
    // The rest of the page is still a page: the map, the menu and the heading
    // all survive, so an empty list reads as "nothing near here" and not as a
    // broken render.
    expect(html).toContain('<div id="map" class="mainmap"></div>');
    expect(html).toMatch(/<h1>[\s\S]*?Nearby[\s\S]*?-[\s\S]*?Salisbury Foodbank[\s\S]*?<\/h1>/);
  });

  // The mileage is Django's `|floatformat:1`, i.e. exactly one decimal place,
  // always -- "3.0mi", never "3mi". The 0.0 at the top is the load-bearing
  // one: a truncating or rounding-to-integer formatter prints "0mi" there and
  // looks fine everywhere else in the list.
  it("prints one decimal place on every distance, including the zero", async () => {
    const rows = await nearbyRows("/needs/at/salisbury/nearby/");

    for (const row of rows) expect(row).toMatch(/\|\d+\.\dmi away$/);
    expect(rows[0]!.endsWith("|0.0mi away")).toBe(true);
  });

  // The distances are measured with R_EARTHDISTANCE (6378168 m), the api/2
  // radius, not api/1's R_PYTHON -- PLAN.md §7.5.1 keeps both and says "do not
  // unify". The two differ by 0.175%, which is invisible in a smoke test and a
  // changed number on every row of this page. These figures were derived from
  // the fixture coordinates with @givefood/geo's own haversineMeters/miles at
  // that radius; they are quoted to six places here so a radius change shows up
  // as a diff rather than rounding to the same single decimal.
  it("publishes real-world mileages, not kilometres and not metres", async () => {
    const rows = await nearbyRows("/needs/at/salisbury/nearby/");

    // Wilton is a shade under three miles from Salisbury on the ground
    // (2.950225 mi). A units slip lands at 4.7 (km) or somewhere in the
    // thousands (metres left unconverted).
    expect(rows[2]).toBe("/needs/at/wilton/|Wilton||3.0mi away");
    // And Shaftesbury, the far end of the list, at 18.034474 mi.
    expect(rows[6]).toBe("/needs/at/shaftesbury/|Shaftesbury||18.0mi away");
  });

  // A location's bracketed name is its PARENT food bank's, read from the
  // foodbanklocation_full view -- not its own. Tisbury Store belongs to
  // Shaftesbury, and the pair appear in the list separately as well, so a
  // lookup keyed on the wrong id would produce a page where every bracket said
  // the same thing.
  it("labels each location with its own parent, not with the page's food bank", async () => {
    const rows = await nearbyRows("/needs/at/salisbury/nearby/");

    expect(rows[1]).toBe("/needs/at/wilton/bemerton/|Bemerton Pantry|Wilton|0.8mi away");
    expect(rows[4]).toBe("/needs/at/shaftesbury/tisbury/|Tisbury Store|Shaftesbury|12.2mi away");
    // Only Salisbury's own location says Salisbury.
    expect(rows.filter((row) => row.includes("|Salisbury|"))).toHaveLength(1);
  });

  // FROZEN BUG B12, reached through this route. findLocations dereferences
  // `row.latestNeed!.change_text` for every winner -- including the parent of
  // every winning location -- so a neighbour with no need row at all takes the
  // whole page down with a TypeError. lib/findLocations.test.ts pins the throw;
  // this pins what a VISITOR gets, which is a 500 on a page that has nothing to
  // do with need text and never renders any.
  //
  // Documented, NOT endorsed: Django's template does
  // `{{ result.latest_need.change_text }}` against None and errors in the same
  // place, so both sides of the migration fail loudly and identically. All
  // 1,070 production rows have a latest_need_id (packages/db/src/foodbank.ts
  // records that), which is why this needs a test rather than an observation.
  it("SUSPECT: 500s the whole page when any listed neighbour has no need row", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.prepare("UPDATE foodbank SET latest_need_id = NULL WHERE slug = 'wilton'").run();

    const res = await get("/needs/at/salisbury/nearby/");
    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(await res.text()).not.toContain("Harnham Centre");
  });

  // THE OTHER SIDE OF THAT, and the asymmetry is the point. The SUBJECT food
  // bank's need row is fetched (it rides in getFoodbankBySlug's batch) and then
  // never read: unlike /needs/at/<slug>/, this page renders no need text at
  // all. So a food bank with no need row has a perfectly good nearby page --
  // provided it is not also somebody's listed neighbour or somebody's parent,
  // which is what the test above covers.
  //
  // Closed Bank is the fixture row that can show this cleanly: closed, so it is
  // filtered out of both candidate scans, and childless, so no location drags
  // it into the parent read either.
  it("renders fine for a subject with no need row, because this page never reads one", async () => {
    db.prepare("UPDATE foodbank SET latest_need_id = NULL WHERE slug = 'closed-bank'").run();

    const res = await get("/needs/at/closed-bank/nearby/");
    expect(res.status).toBe(200);
    expect((await res.text()).includes("Harnham Centre")).toBe(true);
  });

  // NOTHING ON THIS PAGE COMES FROM THE VISITOR, which is the property that
  // makes `public, s-maxage=604800` safe. The neighbouring /needs/at/<slug>/
  // page echoes ?email= into a form field; this one takes no input at all, so
  // two requests differing only in their query string must produce the same
  // document. A future edit that read a query parameter here would be cached
  // for a week against a key the edge may or may not vary on.
  it("renders the same document whatever the query string says", async () => {
    const strip = (html: string) => html.replace(/Took \d+ms/, "Took Xms").replace(/Generated at [^\n]*/, "Generated at X");

    const plain = strip(await body("/needs/at/salisbury/nearby/"));
    const noisy = strip(await body("/needs/at/salisbury/nearby/?email=donor%40example.org&utm_source=x&q=%3Cscript%3E"));

    expect(noisy).toBe(plain);
    expect(noisy).not.toContain("donor@example.org");
  });
});

describe("wfbnFoodbankNearby -- map_config, the string the map JS parses", () => {
  // JSON.stringify of the handler's object, verbatim and in key order.
  // `location_marker: false` is what stops the map dropping a pin on the
  // searched-from point, and `zoom: 12` is a wider view than the detail page's
  // -- both are literals in gfwfbn/views.py:669-674 and both are invisible in
  // any rendered assertion, because the map is drawn by JS this suite does not
  // run.
  //
  // `geojson` is the SITE-WIDE feed, matching the preload header above: this
  // map plots every food bank in the country so the seven neighbours have
  // something to sit on.
  it("points the map at the whole-country geojson, at zoom 12, with no origin marker", async () => {
    expect(mapConfigOf(await body("/needs/at/salisbury/nearby/"))).toBe(
      '{"geojson":"/needs/geo.json","lat":51.0688,"lng":-1.7945,"zoom":12,"location_marker":false}',
    );
  });

  // The geojson URL is locale-prefixed, because `geojson` is an i18n_patterns
  // route: a Welsh page fetching /needs/geo.json would work, but would defeat
  // the preload and split the edge cache. lat/lng/zoom do not change with the
  // locale, which is the other half of what this asserts.
  it("prefixes the geojson url on a locale page and changes nothing else", async () => {
    expect(mapConfigOf(await body("/cy/needs/at/salisbury/nearby/"))).toBe(
      '{"geojson":"/cy/needs/geo.json","lat":51.0688,"lng":-1.7945,"zoom":12,"location_marker":false}',
    );
    expect(mapConfigOf(await body("/gd/needs/at/salisbury/nearby/"))).toBe(
      '{"geojson":"/gd/needs/geo.json","lat":51.0688,"lng":-1.7945,"zoom":12,"location_marker":false}',
    );
  });

  // lat/lng are Number()s of the two halves of lat_lng, and the map centres on
  // them. Swapping the halves is the classic version of this mistake and puts
  // the map in the North Sea; a negative longitude that lost its sign puts it
  // in Kazakhstan. Both spellings of the coordinate are on the page -- the
  // parsed pair here, the raw column in geo.position -- which is what makes it
  // assertable.
  it("centres on this food bank's own coordinates, in the right order", async () => {
    const html = await body("/needs/at/andover/nearby/");

    expect(mapConfigOf(html)).toContain('"lat":51.2113,"lng":-1.4871');
    expect(html).toContain('<meta name="geo.position" content="51.2113,-1.4871">');
    expect(html).toContain('<meta property="place:location:latitude" content="51.2113">');
    expect(html).toContain('<meta property="place:location:longitude" content="-1.4871">');
  });

  // SUSPECT, PINNED AS-IS. Nothing validates lat_lng. A value with no comma in
  // it -- an admin typo, a half-written geocode, a "0" from geocode()'s own
  // failure path -- makes lngStr undefined and lng NaN, and three separate
  // things then go quietly wrong at once on a page that still returns 200 and
  // still gets stamped `public, s-maxage=604800`:
  //
  //   * JSON.stringify writes NaN as `null`, so the map JS is handed
  //     `"lng":null` and centres wherever it decides that means;
  //   * every haversine returns NaN, so the sort comparator returns NaN for
  //     every pair and the list comes out in whatever order the engine's sort
  //     happened to leave -- NOT a distance ranking, and not reliably the scan
  //     order either;
  //   * floatformat prints "NaNmi away" against every row, which is the only
  //     visible symptom.
  //
  // lib/findLocations.test.ts pins the ranking half of this; this pins what the
  // page does with it. Asserted rather than fixed because the fix is in the
  // source and this file may not touch it.
  //
  // The exact row ORDER is deliberately not asserted: a comparator that returns
  // NaN puts Array.prototype.sort outside anything the spec pins down, so the
  // sequence is a property of V8's TimSort on this exact input and would change
  // under a Node upgrade without the behaviour under test changing at all. What
  // IS asserted is everything that stays true regardless: the null centre, the
  // NaN mileages, the set of rows, and that the order is not the correct one.
  it("SUSPECT: a lat_lng with no comma yields a null map centre and an unranked list of NaNs", async () => {
    const ranked = (await nearbyRows("/needs/at/salisbury/nearby/")).map((row) => row.split("|")[0]);

    db.prepare("UPDATE foodbank SET lat_lng = '51.0688' WHERE slug = 'salisbury'").run();

    const res = await get("/needs/at/salisbury/nearby/");
    expect(res.status).toBe(200);
    // Still stamped shareable for a week, which is the half that makes a
    // silently-wrong page worth writing down rather than shrugging at.
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=604800");

    const html = await res.text();
    expect(mapConfigOf(html)).toBe('{"geojson":"/needs/geo.json","lat":51.0688,"lng":null,"zoom":12,"location_marker":false}');

    const rows = rowsOf(html);
    expect(rows.every((row) => row.endsWith("|NaNmi away"))).toBe(true);
    // Seven rows out of eight open candidates: the slice still drops exactly
    // one, and the closed pair are still excluded -- the is_closed filters run
    // in SQL and are untouched by a junk origin.
    expect(rows).toHaveLength(7);
    expect(html).not.toContain("Closed Bank");
    expect(html).not.toContain("closed-outreach");
    // The same rows as the good page, in a different order. Sorted, so this
    // says "the set is intact" without pretending the sequence is meaningful.
    const hrefs = rows.map((row) => row.split("|")[0]);
    expect([...hrefs].sort()).toEqual([...ranked].sort());
    expect(hrefs).not.toEqual(ranked);
  });
});

describe("wfbnFoodbankNearby -- identity, locale and the page furniture", () => {
  // Foodbank.full_name() (givefood/models/foodbank.py) via @givefood/models'
  // fullNameLocaleAware. Four locales, three different rules, and this page
  // prints it in the <title>, the <h1>, the breadcrumb and three <meta>s -- so
  // getting it wrong is loud, but getting it wrong in ONE locale is silent to
  // an English-speaking reviewer.
  it("appends Foodbank in English and Irish, translates the word in Welsh and Gaelic", async () => {
    expect(await body("/needs/at/salisbury/nearby/")).toContain("<title>Nearby - Salisbury Foodbank - Give Food</title>");
    expect(await body("/ga/needs/at/salisbury/nearby/")).toContain("Salisbury Foodbank - Give Food</title>");
    expect(await body("/cy/needs/at/salisbury/nearby/")).toContain("<title>Gerllaw - Banc Bwyd Salisbury - Give Food</title>");
    expect(await body("/gd/needs/at/salisbury/nearby/")).toContain("Banca-bìdh Salisbury - Give Food</title>");
  });

  // The cy-with-alt_name branch: alt_name wins OUTRIGHT, with no prefix and no
  // suffix. Every other locale ignores alt_name entirely -- including gd, which
  // is the pair most easily conflated with cy.
  it("uses alt_name verbatim in Welsh only", async () => {
    expect(await body("/cy/needs/at/wilton/nearby/")).toContain("<title>Gerllaw - Pantri Bwyd Dyffryn Wylye - Give Food</title>");
    expect(await body("/needs/at/wilton/nearby/")).toContain("<title>Nearby - Wilton Foodbank - Give Food</title>");
    expect(await body("/gd/needs/at/wilton/nearby/")).not.toContain("Pantri Bwyd Dyffryn Wylye");
  });

  // THE LIST IS NOT TRANSLATED, and that is deliberate: nearby.njk renders
  // `{{ location.name }}`, the raw column, exactly as Django's nearby.html
  // does. Only the SUBJECT food bank gets fullNameLocaleAware treatment,
  // because only the subject is passed through it. So the Welsh page says
  // "Banc Bwyd Salisbury" at the top and lists "Wilton" underneath, even
  // though Wilton has a Welsh alt_name of its own.
  //
  // Pinned because "use full_name in the list too, obviously" is a one-line
  // template change that would diverge from Django on every locale page.
  it("keeps neighbour names in their raw English spelling on a Welsh page", async () => {
    const html = await body("/cy/needs/at/salisbury/nearby/");

    expect(html).toContain("Banc Bwyd Salisbury");
    expect(rowsOf(html)[2]).toBe("/cy/needs/at/wilton/|Wilton||3.0mi i ffwrdd");
    expect(html).not.toContain("Pantri Bwyd Dyffryn Wylye");
  });

  // Every in-site link the list produces carries the locale prefix, because
  // they are built through render()'s locale-bound url() rather than a
  // hardcoded path. A bare /needs/at/wilton/ from an Irish page bounces the
  // visitor back into English mid-journey. Irish rather than Welsh on purpose:
  // ga has its own "away" msgstr, so this also shows the loop body picking up a
  // catalogue that is not the one every other test in this file reads.
  it("prefixes every neighbour link on a locale page", async () => {
    const rows = await nearbyRows("/ga/needs/at/salisbury/nearby/");

    expect(rows[0]).toBe("/ga/needs/at/salisbury/harnham/|Harnham Centre|Salisbury|0.0mi ar shiúl");
    expect(rows[2]).toBe("/ga/needs/at/wilton/|Wilton||3.0mi ar shiúl");
  });

  // The whole surrounding page really is in Welsh, from the real .po catalogue
  // -- if it were not, every assertion above would still pass on an
  // all-English page. "away" -> "i ffwrdd" is the one translated string INSIDE
  // a list row, so it is the one that proves the loop body is translated and
  // not just the chrome.
  it("renders the chrome, the breadcrumb and the row suffix from the real Welsh catalogue", async () => {
    const html = await body("/cy/needs/at/salisbury/nearby/");

    expect(html).toContain('<html lang="cy" dir="ltr"');
    expect(html).toContain('<li class="is-active"><a href="#" aria-current="page">Gerllaw</a></li>');
    expect(html).toContain('<a class="is-active" href="/cy/needs/at/salisbury/nearby/">Gerllaw</a>');
    expect(html).toContain("3.0mi i ffwrdd");
  });

  // `prefix` is set to the translated "Nearby" and pagetitle.njk prints it
  // ahead of the name -- unlike the /needs/at/<slug>/ page, which passes null
  // and gets a bare h1. The two share the include, so a change to it shows up
  // in exactly one of them.
  it("puts the section name in front of the food bank name in the h1", async () => {
    expect(await body("/needs/at/salisbury/nearby/")).toMatch(/<h1>\s*Nearby -\s*Salisbury Foodbank\s*<\/h1>/);
    expect(await body("/cy/needs/at/salisbury/nearby/")).toMatch(/<h1>\s*Gerllaw -\s*Banc Bwyd Salisbury\s*<\/h1>/);
  });

  // The breadcrumb's middle link goes back to the food bank's own page, and the
  // last crumb is the section. A breadcrumb pointing at the nearby page it is
  // already on is the failure this catches.
  it("breadcrumbs home, then the food bank, then Nearby", async () => {
    const html = await body("/needs/at/salisbury/nearby/");

    expect(html).toContain('<li><a href="/">Home</a></li>');
    expect(html).toContain('<li><a href="/needs/at/salisbury/">Salisbury Foodbank</a></li>');
    expect(html).toContain('<li class="is-active"><a href="#" aria-current="page">Nearby</a></li>');
  });

  // The social/description meta block, all built from full_name. og:image
  // points at the food bank's map PNG, which is a different endpoint from
  // either geojson on this page.
  it("fills the social meta from the food bank's locale-aware name", async () => {
    const html = await body("/needs/at/salisbury/nearby/");

    expect(html).toContain('<meta property="og:title" content="Salisbury Foodbank">');
    expect(html).toContain('<meta name="description" content="Find what Salisbury Foodbank is requesting to have donated">');
    expect(html).toContain('<meta property="og:image" content="https://www.givefood.org.uk/needs/at/salisbury/map.png">');
    expect(html).toContain('<meta property="og:image:alt" content="Map of Salisbury Foodbank">');
    expect(html).toContain('<meta name="geo.placename" content="Salisbury Foodbank">');
  });

  // has_charity_details is CHARITY_DETAIL_COUNTRIES membership, and on this
  // page it does exactly one thing: gate the Charity entry in the left-hand
  // menu (menu.njk additionally requires a charity_name). Shaftesbury HAS a
  // charity_name and still gets no entry, because Jersey has no register page
  // to send anyone to -- so a helper that returned true unconditionally would
  // render a link to a page that 404s.
  it("offers the Charity menu entry only for a country with a register", async () => {
    expect(await body("/needs/at/salisbury/nearby/")).toContain('href="/needs/at/salisbury/charity/">Charity</a>');
    expect(await body("/needs/at/shaftesbury/nearby/")).not.toContain(">Charity</a>");
  });

  // `section: "nearby"` is what marks the current menu entry, and it is the
  // only thing distinguishing this page's menu from the detail page's. Both
  // halves are asserted: Nearby active, Details not.
  it("marks Nearby as the active menu entry and nothing else", async () => {
    const html = await body("/needs/at/salisbury/nearby/");

    expect(html).toContain('<a class="is-active" href="/needs/at/salisbury/nearby/">Nearby</a>');
    expect(html).toContain('<a href="/needs/at/salisbury/">Details</a>');
    expect(html).toContain('href="/needs/at/salisbury/locations/">Locations</a>');
  });

  // is_closed drives two independent things: the robots meta here and the
  // banner on the detail page. Losing the meta alone leaves a closed food
  // bank's nearby page in the index indefinitely, with no visible symptom at
  // all -- and this page has no closure banner of its own to give the game
  // away, unlike /needs/at/<slug>/.
  it("marks a closed food bank's nearby page noindex", async () => {
    expect(await body("/needs/at/closed-bank/nearby/")).toContain('<meta name="robots" content="noindex">');
    expect(await body("/needs/at/salisbury/nearby/")).not.toContain('content="noindex"');
  });

  // DIVERGENCE FROM DJANGO, pinned as the current behaviour. Django's
  // nearby.html:6 carries
  // `<link rel="alternate" type="text/markdown" href="{% url
  // 'wfbn-md:md_foodbank_nearby' foodbank.slug %}">`, and nearby.njk does not
  // -- even though index.ts really does register /md/needs/at/:slug/nearby/ and
  // /needs/at/<slug>/ really does advertise its own markdown twin. So the
  // markdown mirror of this page exists and is simply unadvertised. Asserted
  // rather than fixed because the fix is in a template this file may not touch.
  it("SUSPECT: omits the markdown alternate Django's own nearby template emits", async () => {
    const html = await body("/needs/at/salisbury/nearby/");

    expect(html).not.toContain('type="text/markdown"');
    expect(html).not.toContain("/md/needs/at/salisbury/nearby/");
    // The sibling page does advertise its markdown twin, so this is a
    // per-template omission and not a site-wide policy.
    expect(await body("/needs/at/salisbury/")).toContain('<link rel="alternate" type="text/markdown" href="/md/needs/at/salisbury/">');
  });

  // maplegend.njk's service-area entry is gated on
  // `foodbank.has_service_area and show_service_area`, and this handler passes
  // NEITHER -- so the legend never shows it, even for a food bank one of whose
  // locations really does have a boundary (Bemerton Pantry's, in the fixture).
  // Django's nearby view passes no show_service_area either, so the `and` is
  // false there too and this is parity. Pinned because the three markers that
  // ARE in the legend make it look complete.
  it("renders a legend without the service area, even for a food bank that has one", async () => {
    const html = await body("/needs/at/wilton/nearby/");

    expect(html).toContain("Organisation<br>");
    expect(html).toContain("Location<br>");
    expect(html).toContain("Donation point<br>");
    expect(html).not.toContain("Service area");
  });

  // The hit beacon at the bottom of every food bank page: it is what feeds
  // foodbankhit, which the homepage's "most viewed this week" panel ranks on.
  // A wrong slug here silently attributes one food bank's traffic to another --
  // and on this page the temptation is real, because the template is full of
  // OTHER food banks' slugs.
  it("fires the hit beacon at the subject food bank, not at a neighbour", async () => {
    const html = await body("/needs/at/salisbury/nearby/");

    expect(html).toContain('fetch("/needs/at/salisbury/hit/", {method: "POST", keepalive: true});');
    expect(html).not.toContain("/needs/at/wilton/hit/");
  });

  // pageTranslatable: true gates BOTH the four hreflang alternates and the
  // whole language switcher. Passing false (or forgetting it) delists three
  // languages from search engines while the page still looks perfect. The
  // alternate URLs are built from pathAfterPrefix, so this also pins that the
  // slug and the /nearby/ segment both survive the prefix swap.
  it("advertises all four language variants of the same nearby page", async () => {
    const html = await body("/cy/needs/at/salisbury/nearby/");

    for (const [code, url] of [
      ["en", "/needs/at/salisbury/nearby/"],
      ["cy", "/cy/needs/at/salisbury/nearby/"],
      ["ga", "/ga/needs/at/salisbury/nearby/"],
      ["gd", "/gd/needs/at/salisbury/nearby/"],
    ]) {
      expect(html).toContain(`<link rel="alternate" hreflang="${code}" href="${ORIGIN}${url}">`);
    }
    expect(html).toContain('<div class="langswitcher');
    expect(html).toContain('<link rel="canonical" href="https://www.givefood.org.uk/cy/needs/at/salisbury/nearby/">');
  });
});
