import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/wfbn/geojson.ts -- the four map feeds: wfbnGeojson (/needs/geo.json),
// wfbnFoodbankGeojson (/needs/at/<slug>/geo.json), wfbnFoodbankLocationGeojson
// (/needs/at/<slug>/<locslug>/geo.json) and wfbnConstituencyGeojson
// (/needs/in/constituency/<slug>/geo.json). Django's `geojson()` at
// gfwfbn/views.py:207-339 -- ONE view serving all four URL patterns, branching
// on which of slug/locslug/parlcon_slug arrived -- read in full alongside this
// file; every parity claim below is against that function's actual text.
//
// WHY THIS FILE EXISTS, given that lib/buildGeojson.test.ts already covers the
// shared body builder against mocked queries. What is untested there is
// everything these four handlers ARE: which scope each URL selects, which
// param it reads, what happens when a lookup misses, and the response envelope
// each one puts around the body. Every one of those fails silently:
//
//   * the four handlers differ only by the scope object they build, and they
//     all return a well-formed FeatureCollection whichever one they pick --
//     a location feed built with { kind: "foodbank" } is a 200 with a map on
//     it, just the wrong map;
//   * wfbnFoodbankLocationGeojson reads TWO params, and a handler that passed
//     them in the wrong order 404s only when the two slugs differ -- which is
//     why the fixture below never reuses a slug across the two positions;
//   * buildGeojsonResponse returns null for "no such thing" and a valid EMPTY
//     FeatureCollection for "nothing matched", and a handler that confused the
//     two would either 404 a live constituency or serve 200 for a slug that
//     does not exist (and be cached for a week doing it);
//   * the Cache-Control here is a bare `max-age=604800` on purpose (see the
//     module's own comment: Django's @cache_page(SECONDS_IN_WEEK) emits no
//     `public`/`s-maxage`), and middleware/pageCacheControl.ts is mounted on
//     "*" ready to stamp its own header over any response that lacks one;
//   * the all-items feed is the site's largest response (resolveLanguage.ts
//     records two 2,037,055-byte copies of it sitting in one colo's edge
//     cache) and its queries are deliberately PROJECTED -- a revert to
//     `SELECT *` changes not one byte of the body.
//
// So the assertions below read whole response bodies and exact SQL out of a
// real database, never a status code alone.
//
// REAL EVERYTHING, the same harness as routes/public/country.test.ts (the
// nearest neighbour: publicCountryGeojson is the fifth scope of the same
// builder): the real production app -- so the route table, the route ORDER
// between /needs/at/:slug/geo.json and /needs/at/:slug/:locslug/geo.json, the
// four locale registrations, resolveLanguage, cacheTag and pageCacheControl
// are the genuine articles -- real @givefood/serialise, @givefood/urls and
// @givefood/models, and real in-memory SQLite built by schemaFor() from the
// real migrations. The views matter here: every location and donation point
// feature's "foodbank" property comes from foodbanklocation_full /
// foodbankdonationpoint_full's LEFT JOIN, and getFoodbankBySlug reads
// foodbankchange_full whether or not there is a need to find. Mocked: only
// the two KV namespaces, which are Maps, because there is no local double.
//
// MUTATION-TESTED in a copy of the repo outside it, never edited in place --
// 23 deliberate breakages, all caught. The full list is at the bottom of this
// file, above the last describe block.

const ORIGIN = "https://www.givefood.org.uk";

type Bindable = null | number | bigint | string | Uint8Array;

// One statement as it reached the engine: the SQL text AND the values bound to
// it. Both halves are load-bearing here -- the SQL says which query a scope
// chose (and whether it is still projected), the bindings say which id or slug
// the handler resolved and passed down, neither of which is visible in the
// body when the fixture is small.
interface Prepared {
  sql: string;
  params: Bindable[];
}

// The slice of the D1 Sessions API packages/db uses, over node:sqlite -- the
// same shim routes/public/country.test.ts uses, plus batch(): getFoodbankBySlug
// sends its two statements as one, and the food bank scope is the only one of
// these four that goes through it. batch() runs its statements IN ORDER and
// returns one result per input in that order, which is the contract
// packages/db indexes straight into.
function d1Session(db: DatabaseSync, prepared: Prepared[]): D1DatabaseSession {
  const statement = (entry: Prepared, params: Bindable[]): unknown => ({
    sql: entry.sql,
    params,
    bind: (...next: unknown[]) => {
      entry.params = next as Bindable[];
      return statement(entry, next as Bindable[]);
    },
    first: async <T>() => (db.prepare(entry.sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(entry.sql).all(...params), success: true, meta: {} }),
    run: async () => {
      db.prepare(entry.sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return {
    prepare: (sql: string) => {
      const entry: Prepared = { sql, params: [] };
      prepared.push(entry);
      return statement(entry, []);
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
let kv: Map<string, string>;

function env(): AppEnv["Bindings"] {
  return {
    DB: {
      withSession: () => {
        sessions += 1;
        return d1Session(db, prepared);
      },
    },
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => void kv.set(key, value),
      delete: async (key: string) => void kv.delete(key),
    },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

// ---------------------------------------------------------------------------
// Seeds. Only the columns these feeds read are parameterised; every other NOT
// NULL column is filled with whatever the real migration insists on, so a
// seeded row is one production would have accepted.
// ---------------------------------------------------------------------------

interface FoodbankSeed {
  id: number;
  slug: string;
  name: string;
  latLng: string;
  constituencyId: number | null;
  isClosed?: 0 | 1;
  address?: string;
  postcode?: string;
  deliveryAddress?: string | null;
  deliveryLatLng?: string | null;
  altName?: string | null;
}

// `name` is stored BARE ("Salisbury"): Foodbank.full_name() is what appends
// " Foodbank", and every "f" feature below prints full_name() while every "l"
// and "d" feature prints the parent's RAW name in its "foodbank" property.
// A fixture storing "Salisbury Foodbank" could not tell the two apart.
function seedFoodbank(s: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, alt_name, slug, address, postcode, country, lat_lng,
       delivery_address, delivery_lat_lng, network, charity_just_foodbank, contact_email, url,
       shopping_list_url, parliamentary_constituency_id, address_is_administrative, is_closed,
       no_locations, days_between_needs, created, modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'England', ?, ?, ?, 'Trussell Trust', 0, ?, ?, ?, ?, 0, ?, 0, 14,
       '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run(
    s.id,
    String(s.id).padStart(32, "a"),
    s.name,
    s.altName ?? null,
    s.slug,
    s.address ?? `${s.id} High Street`,
    s.postcode ?? "SP1 1AA",
    s.latLng,
    s.deliveryAddress ?? null,
    s.deliveryLatLng ?? null,
    `info@${s.slug}.invalid`,
    `https://${s.slug}.invalid/`,
    `https://${s.slug}.invalid/list/`,
    s.constituencyId,
    s.isClosed ?? 0,
  );
}

// `parliamentary_constituency_id` on the LOCATION row, not on its food bank:
// that column is what the constituency feed filters on
// (gfwfbn/views.py:242 filters locations by parliamentary_constituency_slug,
// not by their food bank's), and location 15 below is the row that makes the
// difference visible.
function seedLocation(o: {
  id: number;
  foodbankId: number;
  name: string;
  slug: string;
  constituencyId: number | null;
  address?: string | null;
  postcode?: string | null;
  latLng: string;
  isClosed?: 0 | 1;
  boundary?: string | null;
}): void {
  db.prepare(
    `INSERT INTO foodbanklocation (id, uuid, foodbank_id, name, slug, address, postcode, country,
       lat_lng, parliamentary_constituency_id, is_closed, boundary_geojson, modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'England', ?, ?, ?, ?, '2020-01-01 00:00:00.000000')`,
  ).run(
    o.id,
    String(o.id).padStart(32, "e"),
    o.foodbankId,
    o.name,
    o.slug,
    o.address ?? null,
    o.postcode ?? null,
    o.latLng,
    o.constituencyId,
    o.isClosed ?? 0,
    o.boundary ?? null,
  );
}

function seedDonationPoint(o: {
  id: number;
  foodbankId: number;
  name: string;
  slug: string;
  constituencyId: number | null;
  address: string;
  postcode: string;
  latLng: string;
  isClosed?: 0 | 1;
}): void {
  db.prepare(
    `INSERT INTO foodbankdonationpoint (id, uuid, foodbank_id, name, slug, address, postcode, country,
       lat_lng, parliamentary_constituency_id, is_closed, in_store_only, modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'England', ?, ?, ?, 0, '2020-01-01 00:00:00.000000')`,
  ).run(
    o.id,
    String(o.id).padStart(32, "d"),
    o.foodbankId,
    o.name,
    o.slug,
    o.address,
    o.postcode,
    o.latLng,
    o.constituencyId,
    o.isClosed ?? 0,
  );
}

function seedConstituency(o: { id: number; slug: string; name: string; boundary?: string | null }): void {
  db.prepare(
    `INSERT INTO parliamentaryconstituency (id, name, slug, country, mp, mp_party, mp_parl_id,
       centroid, boundary_geojson)
     VALUES (?, ?, ?, 'England', 'A Member', 'Independent', ?, '51.07,-1.79', ?)`,
  ).run(o.id, o.name, o.slug, o.id, o.boundary ?? null);
}

// A stored location boundary, in the compact shape packages/serialise's
// geojsonBoundary.ts records for production rows -- including a coordinate
// written as "-1.74000" and one as "51.10", the trailing zeros a
// JSON.parse/JSON.stringify round trip would silently eat, and a leftover
// "stored" property that Django's `boundary["properties"] = {...}` throws away
// wholesale rather than merging into.
const STORED_LOCATION_BOUNDARY =
  '{"type":"Feature","properties":{"stored":"gone"},"geometry":{"type":"Polygon","coordinates":[[[-1.74000,51.10]]]}}';

// A stored constituency boundary keeping its real ONS fields -- one holding a
// raw (unescaped) non-ASCII character, as the production column really does --
// and NO "type" key, so the view's `boundary["properties"]["type"] = "b"`
// appends rather than replaces, and "type" lands LAST.
const STORED_CONSTITUENCY_BOUNDARY =
  '{"type":"Feature","properties":{"PCON24CD":"E14001427","PCON24NM":"Salisbury Môn"},' +
  '"geometry":{"type":"Polygon","coordinates":[[[-1.80000,51.10]]]}}';

// THE FIXTURE IS THE TEST: each row exists to turn exactly one rule on or off
// relative to its neighbour.
//
// Constituencies:
//   41 salisbury  has a stored boundary  (the "b" feature, and ensure_ascii)
//   42 bath       boundary NULL          (the skip-the-feature branch)
//
// Food banks -- note that no two of the six slugs below are reused as a
// location or donation point slug, so a handler that swapped :slug and
// :locslug cannot accidentally still resolve:
//   1 salisbury    "Salisbury"    pc 41  open    7-dp coordinates + a delivery address
//   2 bath         "Bath"         pc 42  open    whole-number coordinates, no delivery
//   3 closed-town  "Closed Town"  pc 41  CLOSED  (excluded from the all-items and
//                                                 constituency feeds, INCLUDED when
//                                                 asked for by its own slug -- Django's
//                                                 slug branch has no is_closed filter)
//
// Locations:
//   11 amesbury     fb 1  pc 41  open    address + postcode
//   12 wilton       fb 1  pc 41  CLOSED  (excluded from all-items/constituency,
//                                         INCLUDED in its food bank's own feed)
//   13 downton      fb 1  pc 41  open    HAS a stored boundary polygon
//   14 widcombe     fb 2  pc 42  open    address NULL, postcode only
//   15 crossborder  fb 1  pc 42  open    parent food bank is in 41, the ROW is in 42
//   16 st-thomas    fb 1  pc 41  open    NAME AND SLUG SORT DIFFERENTLY -- see below
//   17 annexe       fb 3  pc 41  open    an OPEN location of the CLOSED food bank
//
// Donation points:
//   21 tesco-extra    fb 1  pc 41  open
//   22 boarded-up     fb 1  pc 41  CLOSED  (as location 12: excluded from the
//                                           aggregate feeds, kept in its own)
//   23 aldi-central   fb 1  pc 41  open
//   24 waitrose-bath  fb 2  pc 42  open
//   25 iceland        fb 1  pc 41  open    NAME AND SLUG SORT DIFFERENTLY
//
// THE LAST TWO EXIST TO MAKE ORDERING VISIBLE AT ALL. Slugs are normally
// slugify(name), so name order and slug order agree and every ordering rule in
// this module is unobservable -- and both per-food-bank queries are answered
// through the (foodbank_id, slug) indexes -- EXPLAIN QUERY PLAN, run against a
// database built from these same migrations: `SEARCH l USING INDEX
// loc_foodbank_slug_idx (foodbank_id=?)` and `SEARCH d USING INDEX
// dp_foodbank_slug_idx (foodbank_id=?)` -- so rows arrive in SLUG order, not
// insertion order.
// A location and a donation point are therefore seeded with the shape real
// renames leave behind -- a new name over the old, URL-stable slug -- so that
// "sorted by name" and "whatever the engine returned" are two different
// answers and a test can tell which one shipped.
function seed(): void {
  seedConstituency({ id: 41, slug: "salisbury", name: "Salisbury", boundary: STORED_CONSTITUENCY_BOUNDARY });
  seedConstituency({ id: 42, slug: "bath", name: "Bath", boundary: null });

  // 7 decimal places: the same row rendered at 4dp on the all-items feed and
  // at 6dp on its own, so one fixture proves both rules and a swap of the two
  // shows up in both places at once.
  seedFoodbank({
    id: 1,
    slug: "salisbury",
    name: "Salisbury",
    latLng: "51.0688123,-1.7945678",
    constituencyId: 41,
    address: "1 High Street",
    postcode: "SP1 1AA",
    deliveryAddress: "Unit 5, Depot Way",
    deliveryLatLng: "51.07,-1.8",
  });
  // Whole numbers: Python's repr() prints 51.0, JSON.stringify prints 51, and
  // the UK straddles the 0 meridian so this is not a contrived case.
  seedFoodbank({ id: 2, slug: "bath", name: "Bath", latLng: "51.0,-2.0", constituencyId: 42, address: "2 Milsom Street", postcode: "BA1 1DN" });
  seedFoodbank({ id: 3, slug: "closed-town", name: "Closed Town", latLng: "52.5,-1.5", constituencyId: 41, isClosed: 1 });

  seedLocation({ id: 11, foodbankId: 1, name: "Amesbury Centre", slug: "amesbury", constituencyId: 41, address: "2 Low Street", postcode: "SP4 7HQ", latLng: "51.1662,-1.7827" });
  seedLocation({ id: 12, foodbankId: 1, name: "Wilton Centre", slug: "wilton", constituencyId: 41, address: "3 Mid Street", postcode: "SP2 0RS", latLng: "51.08,-1.86", isClosed: 1 });
  seedLocation({
    id: 13,
    foodbankId: 1,
    name: "Downton Hall",
    slug: "downton",
    constituencyId: 41,
    address: "4 Church Road",
    postcode: "SP5 3PA",
    latLng: "50.99,-1.74",
    boundary: STORED_LOCATION_BOUNDARY,
  });
  seedLocation({ id: 14, foodbankId: 2, name: "Widcombe Hall", slug: "widcombe", constituencyId: 42, address: null, postcode: "BA2 4AA", latLng: "51.37,-2.35" });
  seedLocation({ id: 15, foodbankId: 1, name: "Crossborder Centre", slug: "crossborder", constituencyId: 42, address: "6 Border Road", postcode: "BA3 5AA", latLng: "51.2,-2.0" });
  // Renamed, slug kept: sorts FOURTH by slug and FIRST by name.
  seedLocation({ id: 16, foodbankId: 1, name: "Alderbury Room", slug: "st-thomas", constituencyId: 41, address: "11 Bell Street", postcode: "SP1 6VV", latLng: "51.09,-1.8" });
  // An OPEN location of the CLOSED food bank 3: every one of these feeds
  // filters locations on the LOCATION's own is_closed and never on its food
  // bank's, so this row is on the map while its parent is not.
  seedLocation({ id: 17, foodbankId: 3, name: "Closed Town Annexe", slug: "annexe", constituencyId: 41, address: "13 Mill Lane", postcode: "SP1 8XX", latLng: "52.51,-1.51" });

  seedDonationPoint({ id: 21, foodbankId: 1, name: "Tesco Extra", slug: "tesco-extra", constituencyId: 41, address: "7 Retail Park", postcode: "SP1 3SL", latLng: "51.07,-1.79" });
  seedDonationPoint({ id: 22, foodbankId: 1, name: "Boarded Up", slug: "boarded-up", constituencyId: 41, address: "8 Empty Row", postcode: "SP1 4TT", latLng: "51.06,-1.78", isClosed: 1 });
  seedDonationPoint({ id: 23, foodbankId: 1, name: "Aldi Central", slug: "aldi-central", constituencyId: 41, address: "9 Market Place", postcode: "SP1 5UU", latLng: "51.05,-1.77" });
  seedDonationPoint({ id: 24, foodbankId: 2, name: "Waitrose Bath", slug: "waitrose-bath", constituencyId: 42, address: "10 Queen Square", postcode: "BA1 2HA", latLng: "51.38,-2.36" });
  // Renamed, slug kept: sorts THIRD by slug and LAST by name.
  seedDonationPoint({ id: 25, foodbankId: 1, name: "The Food Warehouse", slug: "iceland", constituencyId: 41, address: "12 Southampton Road", postcode: "SP1 7WW", latLng: "51.04,-1.76" });
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  // schemaFor rather than hand-written DDL: three of these four feeds read the
  // _full VIEWS, and getFoodbankBySlug reads foodbankchange_full on every
  // call whether or not a need exists -- a hand-built fixture missing any of
  // them fails somewhere else entirely with "no such table".
  db.exec(
    schemaFor(
      "foodbank",
      "foodbankchange",
      "foodbankchange_full",
      "foodbanklocation",
      "foodbanklocation_full",
      "foodbankdonationpoint",
      "foodbankdonationpoint_full",
      "parliamentaryconstituency",
    ),
  );
  seed();
  prepared = [];
  sessions = 0;
  kv = new Map();
});

afterEach(() => {
  db.close();
});

// `async`, not a bare arrow: app.fetch is typed Response | Promise<Response>.
const get = async (path: string): Promise<Response> => app.fetch(new Request(`${ORIGIN}${path}`), env(), execCtx);
const getBody = async (path: string): Promise<string> => (await get(path)).text();

const post = async (path: string): Promise<Response> => app.fetch(new Request(`${ORIGIN}${path}`, { method: "POST" }), env(), execCtx);

// The `"name": "..."` values a response carries, in emission order -- enough to
// say "these features, in this order, and nothing else" without spelling out
// ten full Point literals. The byte-exact shape of those is pinned by the
// whole-body assertions instead.
function featureNames(body: string): string[] {
  return [...body.matchAll(/"name": "([^"]*)"/g)].map((m) => m[1] as string);
}

const sqlOf = (): string[] => prepared.map((p) => p.sql);

// ===========================================================================
// wfbnGeojson -- /needs/geo.json
// ===========================================================================

describe("wfbnGeojson -- the response envelope", () => {
  // A BARE max-age, and nothing else. The module comment records that Django's
  // @cache_page(SECONDS_IN_WEEK) goes through patch_response_headers, which
  // emits `max-age=` with no `public` and no `s-maxage` -- deliberately NOT
  // apiResponse.ts's `public, max-age=X, s-maxage=X` convention, which is this
  // codebase's own and not what this endpoint emits in production.
  //
  // THIS LINE IS THE ONLY THING SETTING IT. pageCacheControl is mounted on "*"
  // but its CACHEABLE_TYPES list is html/rss/markdown only, so it does not fill
  // this gap: deleting the header from the handler (done, in a scratchpad copy)
  // leaves the response with NO Cache-Control at all, i.e. uncached by every
  // browser on the site's largest response. Nothing downstream would catch that.
  it("serves JSON with a bare one-week max-age, the only Cache-Control on this path", async () => {
    const res = await get("/needs/geo.json");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("max-age=604800");
    expect(res.headers.get("Content-Language")).toBe("en");
  });

  // A week is a long time to serve a stale map, so this feed HAS to be
  // purgeable: middleware/cacheTag.ts lists /needs/geo.json among its
  // AGGREGATE_PATHS, and every admin save that could change it queues that
  // same tag (routes/admin/foodbank.ts:160 and its location/donation point/
  // needs siblings). Without the tag, the only thing that clears this response
  // is the seven days running out.
  it("is tagged as an aggregate so any food bank's save can purge it", async () => {
    expect((await get("/needs/geo.json")).headers.get("Cache-Tag")).toBe("fb-all");
  });

  // ONE D1 session for the three queries, not three. Every packages/db call
  // goes through a Session because this database has read replication on:
  // three sessions could serve a food bank from one replica and its locations
  // from another, i.e. a map with pins for a food bank that is not on it.
  it("reads all three legs through a single D1 session", async () => {
    await get("/needs/geo.json");

    expect(sessions).toBe(1);
    expect(prepared).toHaveLength(3);
  });

  // THE PROJECTIONS ARE THE POINT OF THESE TWO QUERIES, and nothing in the
  // response body can see them: getAllOpenLocationsFlagged replaces the
  // ~2,000 boundary_geojson blobs this feed never renders with a 0/1 flag, and
  // getAllOpenDonationPoints names twelve columns instead of forty-odd. The
  // savings those buy (-3.4 MB, and 10.6 MB -> 3.3 MB of result payload) are
  // the measurements recorded in those two functions' own comments in
  // packages/db, not something re-measured here. A revert to `SELECT *` on
  // either is byte-identical output and a materially slower site, so the SQL
  // is the only place it can be caught.
  it("reads the two big legs through projected queries, never SELECT *", async () => {
    await get("/needs/geo.json");

    const [foodbanksSql, locationsSql, donationPointsSql] = sqlOf();
    expect(foodbanksSql).toBe("SELECT * FROM foodbank WHERE is_closed = 0");

    expect(locationsSql).toContain("FROM foodbanklocation_full WHERE is_closed = 0");
    expect(locationsSql).toContain("AS has_boundary");
    expect(locationsSql).not.toContain("SELECT *");
    // The blob is named ONLY inside the has_boundary expression -- it is not
    // also selected as a column, which is the whole saving.
    expect(locationsSql).not.toMatch(/boundary_geojson\s*,/);

    expect(donationPointsSql).toContain("FROM foodbankdonationpoint_full WHERE is_closed = 0");
    expect(donationPointsSql).not.toContain("SELECT *");
  });

  // Django registers this URL for GET only (it is a plain function view under
  // i18n_patterns, and Hono's app.get here); a POST is not a 405 in either.
  it("does not answer a POST", async () => {
    expect((await post("/needs/geo.json")).status).toBe(404);
  });

  // "en" is never a URL prefix (prefix_default_language=False in Django, and
  // resolveLanguage's PREFIXES set excludes it here), so /en/... is not a
  // second spelling of this feed -- it is a 404, as in production.
  it("does not answer at /en/needs/geo.json", async () => {
    expect((await get("/en/needs/geo.json")).status).toBe(404);
  });
});

describe("wfbnGeojson -- the body", () => {
  // THE WHOLE FEED, BYTE FOR BYTE. geo.json is in PLAN.md's strict
  // byte-equality corpus, so this asserts the complete string rather than a
  // parsed object: json.dumps's `, `/`: ` separators and a Python float
  // printed as "51.0" where JSON.stringify prints "51" are both invisible to
  // JSON.parse, and so is the FEATURE ORDER (food banks, then locations, then
  // donation points -- the Python view's loop order) that the map front end
  // draws in.
  //
  // Every rule of this scope is visible in this one string:
  //   * NO "address" key anywhere -- the all-items feed pops it (views.py:329-332)
  //   * coordinates at 4dp: 51.0688123 -> 51.0688, -1.7945678 -> -1.7946
  //   * [longitude, latitude], GeoJSON's order, not the stored lat_lng's
  //   * "51.0"/"-2.0" for bath, Python's repr() of a whole float
  //   * the delivery address is a SECOND "f" feature reusing the food bank's
  //     own url, emitted immediately after it rather than in a later pass
  //   * "Downton Hall" HAS a stored boundary polygon and is a plain "l" point
  //     here anyway (views.py:288's `and not all_items`)
  //   * "Crossborder Centre" is a location of food bank 1, so its "foodbank"
  //     property is the RAW name "Salisbury" while the food bank feature's own
  //     "name" is full_name()'s "Salisbury Foodbank"
  //   * closed rows (Closed Town, Wilton Centre, Boarded Up) are all absent
  //   * "Closed Town Annexe" IS here, though its food bank is not: the filter
  //     is `FoodbankLocation.objects.filter(is_closed=False)` on the location's
  //     own flag, never on the parent's (views.py:246)
  it("renders every open food bank, location and donation point in Django's json.dumps formatting", async () => {
    expect(await getBody("/needs/geo.json")).toBe(
      '{"type": "FeatureCollection", "features": [' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-1.7946, 51.0688]}, ' +
        '"properties": {"type": "f", "name": "Salisbury Foodbank", "url": "/needs/at/salisbury/"}}, ' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-1.8, 51.07]}, ' +
        '"properties": {"type": "f", "name": "Salisbury Foodbank Delivery Address", "url": "/needs/at/salisbury/"}}, ' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-2.0, 51.0]}, ' +
        '"properties": {"type": "f", "name": "Bath Foodbank", "url": "/needs/at/bath/"}}, ' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-1.7827, 51.1662]}, ' +
        '"properties": {"type": "l", "name": "Amesbury Centre", "foodbank": "Salisbury", "url": "/needs/at/salisbury/amesbury/"}}, ' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-1.74, 50.99]}, ' +
        '"properties": {"type": "l", "name": "Downton Hall", "foodbank": "Salisbury", "url": "/needs/at/salisbury/downton/"}}, ' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-2.35, 51.37]}, ' +
        '"properties": {"type": "l", "name": "Widcombe Hall", "foodbank": "Bath", "url": "/needs/at/bath/widcombe/"}}, ' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-2.0, 51.2]}, ' +
        '"properties": {"type": "l", "name": "Crossborder Centre", "foodbank": "Salisbury", "url": "/needs/at/salisbury/crossborder/"}}, ' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-1.8, 51.09]}, ' +
        '"properties": {"type": "l", "name": "Alderbury Room", "foodbank": "Salisbury", "url": "/needs/at/salisbury/st-thomas/"}}, ' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-1.51, 52.51]}, ' +
        '"properties": {"type": "l", "name": "Closed Town Annexe", "foodbank": "Closed Town", "url": "/needs/at/closed-town/annexe/"}}, ' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-1.79, 51.07]}, ' +
        '"properties": {"type": "d", "name": "Tesco Extra", "foodbank": "Salisbury", "url": "/needs/at/salisbury/donationpoint/tesco-extra/"}}, ' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-1.77, 51.05]}, ' +
        '"properties": {"type": "d", "name": "Aldi Central", "foodbank": "Salisbury", "url": "/needs/at/salisbury/donationpoint/aldi-central/"}}, ' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-2.36, 51.38]}, ' +
        '"properties": {"type": "d", "name": "Waitrose Bath", "foodbank": "Bath", "url": "/needs/at/bath/donationpoint/waitrose-bath/"}}, ' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-1.76, 51.04]}, ' +
        '"properties": {"type": "d", "name": "The Food Warehouse", "foodbank": "Salisbury", "url": "/needs/at/salisbury/donationpoint/iceland/"}}]}',
    );
  });

  // The closed rows, stated as their own rule because a fixture of only open
  // rows passes whether the three `is_closed = 0` clauses survived or not.
  // The names list is asserted positively first: `not.toContain` alone is also
  // satisfied by a build that emitted no features at all, and an empty
  // FeatureCollection is a legitimate response shape for this module.
  it("drops the closed food bank, the closed location and the closed donation point", async () => {
    const names = featureNames(await getBody("/needs/geo.json"));

    expect(names).toHaveLength(13);
    expect(names).toContain("Salisbury Foodbank");
    expect(names).not.toContain("Closed Town Foodbank");
    expect(names).not.toContain("Wilton Centre");
    expect(names).not.toContain("Boarded Up");
  });

  // ...AND CLOSEDNESS DOES NOT CASCADE. Django filters each of the three
  // querysets on its OWN is_closed (views.py:245-247) and never joins to the
  // parent, so a closed food bank's still-open outreach centre stays on the
  // national map, linking to a page that says the food bank has closed.
  // Whether that is intended in Django is not recorded anywhere I can find --
  // what IS certain is that it is the current behaviour on both sides, and
  // that "fixing" it here (a join on the food bank's is_closed) would delete
  // live pins. Pinned as parity, so the divergence has to be deliberate.
  it("keeps an open location of a closed food bank, because the filter never cascades", async () => {
    const names = featureNames(await getBody("/needs/geo.json"));

    expect(names).toContain("Closed Town Annexe");
    expect(names).not.toContain("Closed Town Foodbank");
    expect(await getBody("/needs/geo.json")).toContain('"foodbank": "Closed Town", "url": "/needs/at/closed-town/annexe/"');
  });

  // SUSPECTED BUG, pinned rather than fixed, and only visible against a real
  // database. `foodbank_name`/`foodbank_slug` are columns on Django's
  // FoodbankLocation model but are supplied HERE by foodbanklocation_full's
  // LEFT JOIN, so a location row whose food bank has gone renders
  // `"foodbank": null` -- a JSON null where every other feature has a string --
  // and a url of "/needs/at/null/<locslug>/", which 404s. Django would print
  // the stored name and slug and link somewhere real.
  //
  // Reachable only if a food bank row is deleted without its children:
  // foodbank_id is NOT NULL but no FK is declared, and the admin's own delete
  // (packages/db/src/foodbankAdmin.ts) removes locations in the same batch, so
  // this is a torn-write/bad-import case rather than an everyday one. NOT
  // verified against production data. The fix would be a COALESCE in the view
  // or a filter here, and both are outside this file.
  it("emits a null foodbank and a /needs/at/null/ url for an orphaned location (suspect, pinned)", async () => {
    db.prepare("UPDATE foodbanklocation SET foodbank_id = 999 WHERE id = 11").run();

    const body = await getBody("/needs/geo.json");

    expect(body).toContain('"type": "l", "name": "Amesbury Centre", "foodbank": null, "url": "/needs/at/null/amesbury/"');
  });

  // "Remove address if all items (for download size)" -- views.py:329-332. The
  // positive half of the pair matters: a feed with no features at all would
  // also contain no "address".
  it("strips every address, and only on this feed", async () => {
    const body = await getBody("/needs/geo.json");

    expect(body).toContain('"name": "Amesbury Centre"');
    expect(body).not.toContain("address");
    expect(body).not.toContain("SP4 7HQ");
    // The same location, on its food bank's own feed, keeps it.
    expect(await getBody("/needs/at/salisbury/geo.json")).toContain('"address": "2 Low Street\\r\\nSP4 7HQ"');
  });

  // reverse() inside an i18n_patterns request carries the current language
  // prefix, and all three url names in these features are in @givefood/urls'
  // I18N_SCOPED set -- an unprefixed url would bounce a Welsh visitor out of
  // Welsh the moment they clicked a map pin. full_name() is locale-aware too,
  // so under cy the name takes the translated PREFIX rather than the English
  // suffix: the feature changes shape, not just its links.
  it("prefixes every url with the request's language and localises the food bank name", async () => {
    const body = await getBody("/cy/needs/geo.json");

    expect(body).toContain('"name": "Banc Bwyd Salisbury"');
    expect(body).toContain('"url": "/cy/needs/at/salisbury/"');
    expect(body).toContain('"url": "/cy/needs/at/salisbury/amesbury/"');
    expect(body).toContain('"url": "/cy/needs/at/salisbury/donationpoint/tesco-extra/"');
    expect((await get("/cy/needs/geo.json")).headers.get("Content-Language")).toBe("cy");
    // English is the unprefixed default, not an "/en" prefix.
    expect(await getBody("/needs/geo.json")).not.toContain("/en/needs/");
  });

  // A site with nothing open is an EMPTY FeatureCollection, not a 404 and not
  // a 500: buildGeojsonResponse reserves null for the "no such thing" cases,
  // and this scope has none. The map page would render fine and simply have no
  // pins on it.
  it("returns an empty feature list, not a 404, when nothing is open", async () => {
    db.prepare("UPDATE foodbank SET is_closed = 1").run();
    db.prepare("UPDATE foodbanklocation SET is_closed = 1").run();
    db.prepare("UPDATE foodbankdonationpoint SET is_closed = 1").run();

    const res = await get("/needs/geo.json");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"type": "FeatureCollection", "features": []}');
  });
});

// ===========================================================================
// wfbnFoodbankGeojson -- /needs/at/<slug>/geo.json
// ===========================================================================

describe("wfbnFoodbankGeojson -- the response envelope", () => {
  it("serves JSON with the same bare one-week max-age", async () => {
    const res = await get("/needs/at/salisbury/geo.json");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("max-age=604800");
  });

  // cacheTag.ts's FOODBANK_PATH covers everything under /needs/at/<slug>/, so
  // editing one food bank purges its map without touching the other thousand.
  it("is tagged with its own food bank, not the aggregate", async () => {
    expect((await get("/needs/at/salisbury/geo.json")).headers.get("Cache-Tag")).toBe("fb-salisbury");
  });

  // Four statements, one session: the slug lookup and its latest-need probe go
  // out together as getFoodbankBySlug's batch (which is why this shim needs a
  // batch() at all), then the locations and donation points.
  //
  // WHICH location query is the load-bearing part. This view builds its own
  // unordered queryset (views.py:238) rather than going through
  // Foodbank.locations(), so the port calls getLocationsByFoodbankIdUnsorted
  // -- an ORDER BY name here would be a divergence invisible in any single
  // feature.
  it("resolves the slug, then reads locations unsorted and donation points, in one session", async () => {
    await get("/needs/at/salisbury/geo.json");

    expect(sessions).toBe(1);
    expect(prepared.map((p) => [p.sql, p.params])).toEqual([
      ["SELECT * FROM foodbank WHERE slug = ?", ["salisbury"]],
      ["SELECT * FROM foodbankchange_full WHERE id = (SELECT latest_need_id FROM foodbank WHERE slug = ?)", ["salisbury"]],
      ["SELECT * FROM foodbanklocation_full WHERE foodbank_id = ?", [1]],
      ["SELECT * FROM foodbankdonationpoint_full WHERE foodbank_id = ?", [1]],
    ]);
  });

  // get_object_or_404(Foodbank, slug=slug), views.py:224. The distinction that
  // matters is 404 versus a 200 carrying an empty FeatureCollection: the
  // latter is what a handler that forgot the null check would serve, and it
  // would be cached for a week.
  it("404s an unknown slug rather than serving an empty feed", async () => {
    const res = await get("/needs/at/no-such-foodbank/geo.json");

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(await res.text()).not.toContain("FeatureCollection");
  });

  // ROUTE ORDER, not handler logic. /needs/at/:slug/geo.json is registered
  // before /needs/at/:slug/:locslug/geo.json, so "geo.json" is a literal
  // segment here and never a locslug. Reverse the two registrations and this
  // URL becomes a location lookup for a location called "geo.json", which
  // 404s every food bank map on the site.
  it("is the handler for /needs/at/<slug>/geo.json, not a location called geo.json", async () => {
    const names = featureNames(await getBody("/needs/at/bath/geo.json"));

    // The location scope emits exactly one feature and never an "f" one.
    expect(names).toContain("Bath Foodbank");
    expect(names.length).toBeGreaterThan(1);
  });
});

describe("wfbnFoodbankGeojson -- the body", () => {
  // A WHOLE SMALL FEED, BYTE FOR BYTE -- bath has one location and one
  // donation point, so this pins every rule of the scope in a readable string:
  //   * "address" is KEPT here (only the all-items feed pops it)
  //   * Widcombe Hall has a NULL address column, so full_address() falls
  //     through to the postcode alone (models/foodbank.py:907-915) -- an
  //     unconditional "%s\r\n%s" would print "None\r\nBA2 4AA" here
  //   * no delivery feature, because bath has no delivery_address
  it("renders one food bank's whole feed, addresses included", async () => {
    expect(await getBody("/needs/at/bath/geo.json")).toBe(
      '{"type": "FeatureCollection", "features": [' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-2.0, 51.0]}, ' +
        '"properties": {"type": "f", "name": "Bath Foodbank", "address": "2 Milsom Street\\r\\nBA1 1DN", "url": "/needs/at/bath/"}}, ' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-2.35, 51.37]}, ' +
        '"properties": {"type": "l", "name": "Widcombe Hall", "foodbank": "Bath", "address": "BA2 4AA", "url": "/needs/at/bath/widcombe/"}}, ' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-2.36, 51.38]}, ' +
        '"properties": {"type": "d", "name": "Waitrose Bath", "foodbank": "Bath", "address": "10 Queen Square\\r\\nBA1 2HA", ' +
        '"url": "/needs/at/bath/donationpoint/waitrose-bath/"}}]}',
    );
  });

  // SIX decimal places on this scope, four on the all-items feed
  // (views.py:217-220). The same food bank is seeded at a 7-dp coordinate so
  // the two feeds disagree on the same row: a scope that took the wrong branch
  // would still emit a plausible pin about 8 metres from the right one.
  it("rounds coordinates to six decimal places, where the all-items feed uses four", async () => {
    expect(await getBody("/needs/at/salisbury/geo.json")).toContain('"coordinates": [-1.794568, 51.068812]');
    expect(await getBody("/needs/geo.json")).toContain('"coordinates": [-1.7946, 51.0688]');
  });

  // CLOSED ROWS BELONG ON THEIR OWN FOOD BANK'S MAP, and this is not an
  // oversight in the port: views.py:237-239's slug branch filters by
  // foodbank__slug ALONE, with no is_closed=False anywhere, unlike the
  // parlcon branch immediately below it (241-243), which has one on all three.
  // A "harmonising" is_closed = 0 added to either query here would silently
  // delete pins from a live map.
  it("keeps closed locations and closed donation points, matching Django's unfiltered slug branch", async () => {
    const names = featureNames(await getBody("/needs/at/salisbury/geo.json"));

    expect(names).toContain("Wilton Centre");
    expect(names).toContain("Boarded Up");
    // ...and the same two rows are absent from the aggregate feed, so this is
    // the query's own rule and not a fixture in which nothing is closed.
    const allItems = featureNames(await getBody("/needs/geo.json"));
    expect(allItems).not.toContain("Wilton Centre");
    expect(allItems).not.toContain("Boarded Up");
  });

  // Same rule one level up: Foodbank.objects.filter(slug = slug) has no
  // is_closed filter either, so a closed food bank still has a working map
  // page. It is excluded from the all-items feed by contrast, which is what
  // makes this a rule rather than an artefact.
  it("serves a closed food bank's own feed while leaving it out of the aggregate", async () => {
    const res = await get("/needs/at/closed-town/geo.json");

    expect(res.status).toBe(200);
    expect(featureNames(await res.text())).toEqual(["Closed Town Foodbank", "Closed Town Annexe"]);
    expect(featureNames(await getBody("/needs/geo.json"))).not.toContain("Closed Town Foodbank");
  });

  // TWO ORDERINGS, ONE FIXTURE, AND THEY DISAGREE. Donation points are sorted
  // by NAME in JS (getDonationPointsByFoodbankId): this view builds its own
  // unordered queryset, but four live per-food-bank responses came back in
  // exact alphabetical order, so the sorted query is the empirically closer
  // match -- that function's own comment records the evidence. Locations are
  // deliberately NOT sorted (getLocationsByFoodbankIdUnsorted), because
  // Foodbank.locations()'s `.order_by("name")` is a model method this view
  // never calls; they arrive in whatever order the engine gives, which here is
  // the (foodbank_id, slug) index's, i.e. slug order.
  //
  // "Alderbury Room" (slug st-thomas) and "The Food Warehouse" (slug iceland)
  // are what make this assertion mean anything: the location list below is in
  // SLUG order and is NOT alphabetical by name, and the donation point list is
  // alphabetical by NAME and is NOT in slug order. Add an ORDER BY to the
  // locations query, or drop sortByName from the donation points, and exactly
  // one half of this array moves.
  it("sorts donation points by name and leaves locations in the engine's slug order", async () => {
    const names = featureNames(await getBody("/needs/at/salisbury/geo.json"));

    expect(names).toEqual([
      "Salisbury Foodbank",
      "Salisbury Foodbank Delivery Address",
      // slug order: amesbury, crossborder, downton, st-thomas, wilton
      "Amesbury Centre",
      "Crossborder Centre",
      "Downton Hall",
      "Alderbury Room",
      "Wilton Centre",
      // name order: Aldi Central, Boarded Up, Tesco Extra, The Food Warehouse
      // (slug order would have put "The Food Warehouse"/iceland third)
      "Aldi Central",
      "Boarded Up",
      "Tesco Extra",
      "The Food Warehouse",
    ]);
  });

  // `if foodbank.delivery_address:` (views.py:272) -- checked, then
  // delivery_lat_lng dereferenced unguarded. The second "f" feature reuses the
  // food bank's OWN url (a delivery address has no page of its own) and prints
  // delivery_address verbatim with no postcode line appended.
  it("emits the delivery address as a second food bank feature at its own coordinates", async () => {
    expect(await getBody("/needs/at/salisbury/geo.json")).toContain(
      '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-1.8, 51.07]}, ' +
        '"properties": {"type": "f", "name": "Salisbury Foodbank Delivery Address", "address": "Unit 5, Depot Way", ' +
        '"url": "/needs/at/salisbury/"}}',
    );
  });

  // A location with a stored boundary becomes an "lb" POLYGON here, with its
  // stored properties REPLACED wholesale (`boundary["properties"] = {...}`,
  // views.py:290) rather than merged -- so the "stored" key is gone and there
  // is no "address" key even though every other feature on this feed has one.
  // The polygon's own coordinate text is spliced through untouched: "-1.74000"
  // and "51.10" keep their trailing zeros, which a JSON.parse/JSON.stringify
  // round trip would silently rewrite to -1.74 and 51.1.
  it("renders a location's stored boundary as an lb polygon with replaced properties", async () => {
    const body = await getBody("/needs/at/salisbury/geo.json");

    expect(body).toContain(
      '{"type": "Feature", "properties": {"type": "lb", "name": "Downton Hall", "foodbank": "Salisbury", ' +
        '"url": "/needs/at/salisbury/downton/"}, "geometry": {"type": "Polygon", "coordinates": [[[-1.74000, 51.10]]]}}',
    );
    expect(body).not.toContain("stored");
    // The point form of that same location is what the all-items feed emits,
    // so "renders as a polygon" is a property of this scope and not of the row.
    expect(await getBody("/needs/geo.json")).not.toContain("Polygon");
  });
});

// ===========================================================================
// wfbnFoodbankLocationGeojson -- /needs/at/<slug>/<locslug>/geo.json
// ===========================================================================

describe("wfbnFoodbankLocationGeojson", () => {
  it("serves JSON with the same bare one-week max-age, tagged with its food bank", async () => {
    const res = await get("/needs/at/salisbury/amesbury/geo.json");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("max-age=604800");
    expect(res.headers.get("Cache-Tag")).toBe("fb-salisbury");
  });

  // ONE FEATURE AND NOTHING ELSE, byte for byte. Django's locslug branch sets
  // `foodbanks = Foodbank.objects.none()` and
  // `donationpoints = FoodbankDonationPoint.objects.none()` (views.py:234-235)
  // -- this feed is for the location page's own map, where a pin for the food
  // bank's head office would be wrong rather than merely extra. 6dp and the
  // address are both kept, as on the food bank scope.
  it("renders the one location and nothing else -- no food bank, no donation points", async () => {
    expect(await getBody("/needs/at/salisbury/amesbury/geo.json")).toBe(
      '{"type": "FeatureCollection", "features": [' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-1.7827, 51.1662]}, ' +
        '"properties": {"type": "l", "name": "Amesbury Centre", "foodbank": "Salisbury", ' +
        '"address": "2 Low Street\\r\\nSP4 7HQ", "url": "/needs/at/salisbury/amesbury/"}}]}',
    );
  });

  // ONE STATEMENT. The other three scopes each run three or four queries, so
  // "the location scope reads only the location" is a claim about which branch
  // ran that the single-feature body above cannot quite make on its own -- and
  // it is the bound parameters that pin the ARGUMENT ORDER: the query filters
  // (locslug, foodbank slug), the handler passes (slug, locslug), and a swap
  // anywhere between them is a silent 404 for every location whose slug is not
  // also its food bank's.
  it("runs exactly one query, filtering by location slug and food bank slug in that order", async () => {
    await get("/needs/at/salisbury/amesbury/geo.json");

    expect(sessions).toBe(1);
    expect(prepared.map((p) => [p.sql, p.params])).toEqual([
      ["SELECT * FROM foodbanklocation_full WHERE slug = ? AND foodbank_slug = ?", ["amesbury", "salisbury"]],
    ]);
  });

  // THE FOOD BANK HALF OF THAT FILTER, ON ITS OWN. "widcombe" is a real
  // location slug -- under BATH -- so a handler that ignored :slug would serve
  // Bath's location under Salisbury's URL with a 200 and a correct-looking
  // pin. Salisbury itself exists, so Django's get_object_or_404(Foodbank) is
  // not what stops this: its 404 comes from the `foodbank__slug` half of the
  // location filter and the explicit `if not locations.exists()` after it
  // (views.py:229-232). The port collapses that pair into one query with two
  // bindings, which is why their order is asserted above.
  it("404s a location slug that belongs to a different food bank", async () => {
    expect((await get("/needs/at/bath/widcombe/geo.json")).status).toBe(200);
    expect((await get("/needs/at/salisbury/widcombe/geo.json")).status).toBe(404);
  });

  it("404s an unknown location slug rather than serving an empty feed", async () => {
    const res = await get("/needs/at/salisbury/no-such-location/geo.json");

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("FeatureCollection");
  });

  // views.py:229's queryset has no is_closed filter, same as the slug
  // branch: a closed outreach centre's own page still renders, and its map
  // still has to have a pin on it.
  it("still serves a closed location's own feed", async () => {
    const res = await get("/needs/at/salisbury/wilton/geo.json");

    expect(res.status).toBe(200);
    expect(featureNames(await res.text())).toEqual(["Wilton Centre"]);
  });

  // The polygon branch on the one-location scope: `includeBoundary` is true
  // for everything except the all-items and country feeds, so this feed is a
  // single "lb" Feature with no Point in it at all -- which is exactly what
  // the location page's map draws when a food bank publishes a service area.
  it("renders a boundaried location as a single lb polygon", async () => {
    expect(await getBody("/needs/at/salisbury/downton/geo.json")).toBe(
      '{"type": "FeatureCollection", "features": [' +
        '{"type": "Feature", "properties": {"type": "lb", "name": "Downton Hall", "foodbank": "Salisbury", ' +
        '"url": "/needs/at/salisbury/downton/"}, "geometry": {"type": "Polygon", "coordinates": [[[-1.74000, 51.10]]]}}]}',
    );
  });

  it("prefixes the location url with the request's language", async () => {
    expect(await getBody("/gd/needs/at/salisbury/amesbury/geo.json")).toContain('"url": "/gd/needs/at/salisbury/amesbury/"');
  });
});

// ===========================================================================
// wfbnConstituencyGeojson -- /needs/in/constituency/<slug>/geo.json
// ===========================================================================

describe("wfbnConstituencyGeojson", () => {
  it("serves JSON with the same bare one-week max-age", async () => {
    const res = await get("/needs/in/constituency/salisbury/geo.json");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("max-age=604800");
  });

  // github #18: this asserted null, "pinned as current behaviour rather than
  // endorsed". CONSTITUENCY_PATH expected /constituency/<slug> at the root
  // while these URLs live under /needs/in/constituency/<slug>/, so the
  // response was untagged and a constituency purge could not reach it -- it
  // served the old boundary for the full week. From this route's side that is
  // the difference between a purgeable week-long cache entry and an
  // unpurgeable one, which is why it is asserted here as well as in
  // middleware/cacheTag.test.ts.
  it("carries the constituency cache tag, so a food bank save can purge it", async () => {
    expect((await get("/needs/in/constituency/salisbury/geo.json")).headers.get("Cache-Tag")).toBe("pc-salisbury");
  });

  // THE WHOLE FEED, BYTE FOR BYTE, and the only scope with a boundary FIRST:
  // the `if parlcon_slug:` block runs before the food bank loop (views.py:
  // 252-256), and the map front end draws in receive order, so a boundary
  // pushed last would paint over every pin inside it.
  //
  // The "b" feature is the STORED text with one key spliced in:
  //   * both ONS properties survive, in their stored order, and "type" is
  //     APPENDED after them -- Python's `boundary["properties"]["type"] = "b"`
  //     on a dict with no "type" key adds it at the end
  //   * "Môn" comes back \u-escaped: json.dumps defaults to ensure_ascii=True,
  //     where JS's JSON.stringify would emit the raw UTF-8 byte
  //   * the polygon's "-1.80000"/"51.10" keep their trailing zeros
  // Bath's is the compact case: 42 has no boundary at all, so this fixture
  // covers the branch below with its own assertion.
  it("renders the constituency boundary first, then food banks, locations and donation points", async () => {
    expect(await getBody("/needs/in/constituency/salisbury/geo.json")).toBe(
      '{"type": "FeatureCollection", "features": [' +
        '{"type": "Feature", "properties": {"PCON24CD": "E14001427", "PCON24NM": "Salisbury M\\u00f4n", "type": "b"}, ' +
        '"geometry": {"type": "Polygon", "coordinates": [[[-1.80000, 51.10]]]}}, ' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-1.794568, 51.068812]}, ' +
        '"properties": {"type": "f", "name": "Salisbury Foodbank", "address": "1 High Street\\r\\nSP1 1AA", ' +
        '"url": "/needs/at/salisbury/"}}, ' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-1.8, 51.07]}, ' +
        '"properties": {"type": "f", "name": "Salisbury Foodbank Delivery Address", "address": "Unit 5, Depot Way", ' +
        '"url": "/needs/at/salisbury/"}}, ' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-1.7827, 51.1662]}, ' +
        '"properties": {"type": "l", "name": "Amesbury Centre", "foodbank": "Salisbury", ' +
        '"address": "2 Low Street\\r\\nSP4 7HQ", "url": "/needs/at/salisbury/amesbury/"}}, ' +
        '{"type": "Feature", "properties": {"type": "lb", "name": "Downton Hall", "foodbank": "Salisbury", ' +
        '"url": "/needs/at/salisbury/downton/"}, "geometry": {"type": "Polygon", "coordinates": [[[-1.74000, 51.10]]]}}, ' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-1.8, 51.09]}, ' +
        '"properties": {"type": "l", "name": "Alderbury Room", "foodbank": "Salisbury", ' +
        '"address": "11 Bell Street\\r\\nSP1 6VV", "url": "/needs/at/salisbury/st-thomas/"}}, ' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-1.51, 52.51]}, ' +
        '"properties": {"type": "l", "name": "Closed Town Annexe", "foodbank": "Closed Town", ' +
        '"address": "13 Mill Lane\\r\\nSP1 8XX", "url": "/needs/at/closed-town/annexe/"}}, ' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-1.79, 51.07]}, ' +
        '"properties": {"type": "d", "name": "Tesco Extra", "foodbank": "Salisbury", ' +
        '"address": "7 Retail Park\\r\\nSP1 3SL", "url": "/needs/at/salisbury/donationpoint/tesco-extra/"}}, ' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-1.77, 51.05]}, ' +
        '"properties": {"type": "d", "name": "Aldi Central", "foodbank": "Salisbury", ' +
        '"address": "9 Market Place\\r\\nSP1 5UU", "url": "/needs/at/salisbury/donationpoint/aldi-central/"}}, ' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-1.76, 51.04]}, ' +
        '"properties": {"type": "d", "name": "The Food Warehouse", "foodbank": "Salisbury", ' +
        '"address": "12 Southampton Road\\r\\nSP1 7WW", "url": "/needs/at/salisbury/donationpoint/iceland/"}}]}',
    );
  });

  // THE SORT IS THE FOOD BANK SCOPE'S ALONE. The same four donation points,
  // read by constituency instead, come back in the engine's own order with no
  // sortByName anywhere near them -- so "alphabetical" is a property of
  // getDonationPointsByFoodbankId, not of the feature builder, and a sort
  // added here (or lost there) moves exactly one of these two lists.
  it("leaves the constituency feed's donation points in the engine's order, unlike the food bank feed", async () => {
    const byConstituency = featureNames(await getBody("/needs/in/constituency/salisbury/geo.json"));
    const byFoodbank = featureNames(await getBody("/needs/at/salisbury/geo.json"));

    expect(byConstituency.slice(-3)).toEqual(["Tesco Extra", "Aldi Central", "The Food Warehouse"]);
    expect(byFoodbank.slice(-4)).toEqual(["Aldi Central", "Boarded Up", "Tesco Extra", "The Food Warehouse"]);
  });

  // The slug is resolved to an id ONCE and the three feeds are read by that
  // id, where Django filters all three by the denormalised
  // parliamentary_constituency_slug column. The equivalence is the reason the
  // bindings are asserted: a query bound with the SLUG against an id column
  // matches nothing and returns a boundary with no pins inside it -- a plausible
  // enough map that nobody would report it.
  it("resolves the slug to an id, then reads all three feeds by that id, excluding closed rows", async () => {
    await get("/needs/in/constituency/salisbury/geo.json");

    expect(sessions).toBe(1);
    expect(prepared.map((p) => [p.sql, p.params])).toEqual([
      ["SELECT * FROM parliamentaryconstituency WHERE slug = ?", ["salisbury"]],
      ["SELECT * FROM foodbank WHERE parliamentary_constituency_id = ? AND is_closed = 0", [41]],
      ["SELECT * FROM foodbanklocation_full WHERE parliamentary_constituency_id = ? AND is_closed = 0", [41]],
      ["SELECT * FROM foodbankdonationpoint_full WHERE parliamentary_constituency_id = ? AND is_closed = 0", [41]],
    ]);
  });

  // views.py:241-243 puts is_closed=False on all three querysets of this
  // branch -- unlike the slug branch above it, which has none on any of them.
  // Each closed row is seeded next to an open sibling in the same constituency
  // so a lost filter shows up as an extra name rather than an empty feed.
  it("drops closed food banks, locations and donation points", async () => {
    const names = featureNames(await getBody("/needs/in/constituency/salisbury/geo.json"));

    expect(names).toContain("Salisbury Foodbank");
    expect(names).not.toContain("Closed Town Foodbank");
    expect(names).not.toContain("Wilton Centre");
    expect(names).not.toContain("Boarded Up");
  });

  // THE ROW-LEVEL CONSTITUENCY FILTER, stated on its own because it is the
  // easiest thing here to get wrong in a way nothing else notices. Location 15
  // belongs to a Salisbury food bank and sits in Bath: it belongs on Bath's
  // map, and its "foodbank" property still reads "Salisbury". Filtering by the
  // parent food bank's constituency instead would put it on the wrong one of
  // the two and neither map would look broken.
  it("scopes locations by their OWN constituency, not their food bank's", async () => {
    expect(await getBody("/needs/in/constituency/bath/geo.json")).toBe(
      '{"type": "FeatureCollection", "features": [' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-2.0, 51.0]}, ' +
        '"properties": {"type": "f", "name": "Bath Foodbank", "address": "2 Milsom Street\\r\\nBA1 1DN", ' +
        '"url": "/needs/at/bath/"}}, ' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-2.35, 51.37]}, ' +
        '"properties": {"type": "l", "name": "Widcombe Hall", "foodbank": "Bath", "address": "BA2 4AA", ' +
        '"url": "/needs/at/bath/widcombe/"}}, ' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-2.0, 51.2]}, ' +
        '"properties": {"type": "l", "name": "Crossborder Centre", "foodbank": "Salisbury", ' +
        '"address": "6 Border Road\\r\\nBA3 5AA", "url": "/needs/at/salisbury/crossborder/"}}, ' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-2.36, 51.38]}, ' +
        '"properties": {"type": "d", "name": "Waitrose Bath", "foodbank": "Bath", ' +
        '"address": "10 Queen Square\\r\\nBA1 2HA", "url": "/needs/at/bath/donationpoint/waitrose-bath/"}}]}',
    );
  });

  // A DELIBERATE DIVERGENCE, pinned. Django's
  // `parlcon.boundary_geojson_dict()` would raise on a NULL column
  // (None.strip()); buildGeojson.ts skips the feature instead. Bath is seeded
  // with no boundary, so this is the live branch rather than a mutated row --
  // and the pins inside it still render, which is the whole point of not
  // reproducing the crash.
  it("omits the boundary feature, rather than 500ing, for a constituency with none", async () => {
    const body = await getBody("/needs/in/constituency/bath/geo.json");

    expect(body).not.toContain("Polygon");
    expect(body).not.toContain('"b"');
    expect(featureNames(body)).toContain("Bath Foodbank");
  });

  // The same skip on an EMPTY STRING, which is what an older import pipeline
  // stored where a NULL would be expected. `if (constituency.boundary_geojson)`
  // is a truthiness test, not `!== null`, so both shapes take the same branch
  // -- and an empty string reaching setBoundaryPropertyType would throw
  // ("not a JSON object") and turn the whole feed into a 500.
  it("also skips an empty-string boundary rather than trying to splice it", async () => {
    db.prepare("UPDATE parliamentaryconstituency SET boundary_geojson = '' WHERE slug = 'salisbury'").run();

    const res = await get("/needs/in/constituency/salisbury/geo.json");

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('"type": "b"');
    expect(body).not.toContain("PCON24CD");
    // The rest of the feed is untouched -- including Downton Hall's own "lb"
    // polygon, which is why this cannot simply assert "no Polygon anywhere".
    expect(featureNames(body)).toContain("Salisbury Foodbank");
    expect(body).toContain('"type": "lb"');
  });

  // get_object_or_404(ParliamentaryConstituency, slug=parlcon_slug),
  // views.py:253. The three scoped queries must not run at all: a handler that
  // ran them with `undefined` would 200 with an empty collection.
  it("404s an unknown constituency slug without running the three feeds", async () => {
    const res = await get("/needs/in/constituency/no-such-seat/geo.json");

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("FeatureCollection");
    expect(sqlOf()).toEqual(["SELECT * FROM parliamentaryconstituency WHERE slug = ?"]);
  });

  // A constituency with no open food banks in it is an empty-but-for-the-
  // boundary feed, not a 404: the outline is exactly what such a page wants to
  // draw. Salisbury's rows are closed rather than deleted so the constituency
  // itself still exists.
  it("returns the boundary alone when the constituency has nothing open in it", async () => {
    db.prepare("UPDATE foodbank SET is_closed = 1").run();
    db.prepare("UPDATE foodbanklocation SET is_closed = 1").run();
    db.prepare("UPDATE foodbankdonationpoint SET is_closed = 1").run();

    const body = await getBody("/needs/in/constituency/salisbury/geo.json");

    expect(body).toContain('"type": "b"');
    expect(featureNames(body)).toEqual([]);
  });

  it("prefixes urls with the request's language on this scope too", async () => {
    const body = await getBody("/ga/needs/in/constituency/salisbury/geo.json");

    expect(body).toContain('"url": "/ga/needs/at/salisbury/"');
    expect(body).toContain('"url": "/ga/needs/at/salisbury/donationpoint/tesco-extra/"');
  });

  it("does not answer a POST", async () => {
    expect((await post("/needs/in/constituency/salisbury/geo.json")).status).toBe(404);
  });
});

// ===========================================================================
// THE FOUR HANDLERS SIDE BY SIDE
//
// Each of the four builds a different GeojsonScope from the same three
// ingredients (the session, the language, its own params), and each returns a
// syntactically perfect FeatureCollection whichever scope it picks. The four
// bodies below are all different, which is the only way to say that each
// handler is wired to its own scope and not to a neighbour's.
//
// MUTATION-TESTED against a copy of this repo in a scratchpad -- never edited
// in place -- one breakage at a time, this file re-run against each. 23
// mutants, 23 caught. That is the evidence these assertions are load-bearing
// rather than decorative.
//
// routes/wfbn/geojson.ts (12): kind "all" in place of "foodbank"; kind
// "foodbank" in place of "location"; the constituency handler reading
// c.req.param("slug") instead of "parlconSlug"; the location handler passing
// (locslug, slug); each of the three `if (body === null) return c.notFound()`
// guards deleted; the Cache-Control header dropped entirely; its max-age
// changed to 3600; `public, max-age=X, s-maxage=X` (apiResponse.ts's own
// convention) in place of the bare max-age; Content-Type text/plain; and
// c.get("lang") replaced with a hardcoded "en".
//
// lib/buildGeojson.ts (4): includeAddress forced true; the 4dp and 6dp
// branches swapped; the constituency boundary pushed last instead of first;
// includeBoundary forced false.
//
// packages/db (7): the all-items locations query reverted to `SELECT *`;
// sortByName dropped from getDonationPointsByFoodbankId;
// getFoodbankLocationBySlugs's two bindings swapped; `AND is_closed = 0` added
// to the per-food-bank location and donation point queries (the "harmonising"
// mistake), and removed from the constituency food bank and location queries.
// ===========================================================================

describe("the four scopes are actually four different scopes", () => {
  it("gives each URL its own feed", async () => {
    const [all, foodbank, location, constituency] = await Promise.all([
      getBody("/needs/geo.json"),
      getBody("/needs/at/salisbury/geo.json"),
      getBody("/needs/at/salisbury/amesbury/geo.json"),
      getBody("/needs/in/constituency/salisbury/geo.json"),
    ]);

    // The all-items feed spans both food banks and carries no address;
    // the food bank feed is one food bank's rows INCLUDING the closed ones;
    // the location feed is a single feature;
    // the constituency feed leads with a boundary and drops the closed rows.
    expect(featureNames(all)).toContain("Waitrose Bath");
    expect(featureNames(foodbank)).not.toContain("Waitrose Bath");
    expect(featureNames(foodbank)).toContain("Wilton Centre");
    expect(featureNames(constituency)).not.toContain("Wilton Centre");
    expect(featureNames(location)).toEqual(["Amesbury Centre"]);
    expect(constituency.startsWith('{"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"PCON24CD"')).toBe(true);
    expect(all).not.toContain("address");
    expect(foodbank).toContain("address");
  });
});
