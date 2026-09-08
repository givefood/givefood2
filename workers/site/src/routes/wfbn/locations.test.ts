import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { LOCATION_COLUMNS_FLAGGED } from "@givefood/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/wfbn/locations.ts -- BOTH of its exports:
//
//   wfbnFoodbankLocations       GET /needs/at/<slug>/locations/
//   wfbnFoodbankDonationpoints  GET /needs/at/<slug>/donationpoints/
//
// plus their three locale-prefixed twins each. Ported from
// gfwfbn/views.py:557-616 (`foodbank_locations` and `foodbank_donationpoints`),
// read in full alongside this file together with
// gfwfbn/templates/wfbn/foodbank/{locations,donationpoints}.html and the
// includes all four share.
//
// WHY THIS FILE EXISTS. These two pages are where a donor finds out WHERE to
// take a bag of food, and every way they can be wrong renders a clean 200:
//
//   * both lists are filtered by hand rather than by the query -- the
//     donation-points page picks `is_donation_point` locations out of the
//     WHOLE location list in JS. A filter that stopped filtering shows a food
//     bank's warehouse and its admin office as places to donate at;
//   * neither list filters `is_closed`, deliberately (Django's
//     `Foodbank.locations()`/`location_donation_points()`/`donation_points()`
//     have no such filter), so a shut branch is still listed. That is the
//     ported behaviour and a "tidy-up" that added the filter would silently
//     delete rows from ~1,000 pages;
//   * order comes from packages/db's JS collator, not from SQL. Seeded here
//     in an order that is neither alphabetical nor rowid order, so a lost
//     sort is visible;
//   * has_service_area is passed TWICE -- nested under `foodbank` for
//     includes/maplegend.njk and bare for includes/serviceareadisclaimer.njk
//     -- and on the donation-points page it is short-circuited on the
//     denormalised `no_locations` counter, so a stale counter hides a real
//     service area while the same page still lists the location it belongs to;
//   * the two 404 gates are NOT the same gate. Locations uses `=== 0` on a
//     NOT NULL column; donation points uses `!x` on a NULLABLE one, which is
//     a real divergence from Django's `== 0` for the NULL case;
//   * map_config is a JSON STRING handed to the map JS, and its bounds key
//     is gated on bounds_north ALONE.
//
// So every assertion below reads a VALUE out of the rendered body, out of the
// statements that reached the engine, or off a response header -- never a bare
// status code on its own.
//
// REAL EVERYTHING, the harness routes/wfbn/foodbank.test.ts already uses: the
// real production app (src/index.ts's default export), so the locale
// registrations, resolveLanguage, slugRedirect, cacheTag, geoJsonPreload and
// pageCacheControl are the genuine articles rather than a hand-built router;
// the real Nunjucks templates and the real .po catalogues; the real
// packages/db queries over real in-memory SQLite whose DDL comes from
// schemaFor(), i.e. from the migrations. Nothing either route touches leaves
// the machine, so nothing is mocked except a console.error silencer.
//
// PARITY CLAIMS. Where a comment says "Django does X", X was read out of
// /Users/jasoncartwright/Sites/foodcharity (gfwfbn/views.py,
// givefood/models/foodbank.py and the four templates named above). No Python
// was EXECUTED for this file -- where a claim would need a running Django to
// settle it, the comment says so rather than inventing a citation.
//
// MUTATION-TESTED (TESTING.md's convention -- the evidence that a test is
// load-bearing rather than decoration), most recently for github #52, which
// deleted the `hasServiceArea` round trip from both handlers and batched the
// donation-points page's two list queries into one. Run against a scratchpad
// copy of the repo, this file and packages/db/src/foodbankDetail.test.ts as
// the suite. All caught: the derived flag pinned true and pinned false; its
// `!== null` term dropped, and its `!== ""` term dropped; `.some` swapped for
// `.every`; the donation-points page's `no_locations !== 0` guard removed (see
// the note at that test -- this is the mutant #52's own suggested fix
// proposed as a change); that page's flag derived from the FILTERED
// donation-point locations instead of all of them; the locations page's flag
// derived from an empty list; the batched pair unrolled back into two
// sequential awaits; and the flag passed at the top level only, with the
// nested `foodbank.has_service_area` maplegend.njk reads dropped.
//
// A SECOND #52 ROUND, in adversarial review, found the one gap that list left
// and closed it: `is_closed`. Neither side of the equivalence filters closed
// locations, but every case in the block below put its boundary on an OPEN
// row, so a derivation taught to skip closed locations
// (`.filter((l) => !l.is_closed)`) SURVIVED, and `AND is_closed = 0` on the
// query feeding it was caught only by the statement-shape and list-contents
// assertions, never by a has_service_area one. The "boundary on the CLOSED
// location and nowhere else" case was added for that, and it is now the only
// thing that kills the first mutant.
//
// A THIRD #52 ROUND covered its closing observation -- the location rows now
// arrive with a computed `has_boundary` flag instead of the boundary blob
// itself, which for the seven production food banks that own one was up to
// 2.3 MB of geojson per render used as a truthiness test. Thirteen mutants over
// this file plus packages/db's locations/foodbankDetail suites, all killed;
// the four that only this file could see were the route's `=== 1` loosened to
// `!== undefined` (which makes every food bank claim a service area), `.some`
// swapped for `.every`, the no_locations guard removed again, and -- the one
// that is invisible in packages/db entirely -- wfbn/foodbank/locations.njk's
// photo gate left reading `location.boundary_geojson`, a column that is no
// longer on the row, so `not undefined` is true and every boundary-bearing
// location grows a place photo it should not have. The full list, including the
// two `SELECT *` reverts that ONLY the statement-text assertions can see, is in
// foodbankDetail.test.ts's header.
//
// ONE EQUIVALENT MUTANT SURVIVED and is recorded rather than papered over:
// ADDING a `foodbank.no_locations !== 0 &&` guard to the LOCATIONS page's
// derivation changes nothing, because the 404 gate at the top of that handler
// has already returned for every food bank the guard would catch. It is
// genuinely unobservable, which is exactly why the handler does not carry it.

const ORIGIN = "https://www.givefood.org.uk";

// The location SELECT both handlers now send: every column of
// foodbanklocation_full EXCEPT the boundary blob, plus the 0/1 flag computed in
// SQL from it. Built from packages/db's own exported fragment rather than
// retyped, so this file pins the SHAPE of the statement (named columns, flag,
// view, WHERE) while the 38-name list keeps its single definition -- see
// packages/db/src/locations.test.ts for the drift detector that holds that list
// to the view's real columns.
const LOCATIONS_SQL = `SELECT ${LOCATION_COLUMNS_FLAGGED} FROM foodbanklocation_full WHERE foodbank_id = ?`;

type Bindable = null | number | bigint | string | Uint8Array;

// One statement as it reached the engine: the SQL text and the values bound to
// it. The ABSENCE of a statement is half of what this file pins -- the
// donation-points page's `hasServiceArea` round trip is skipped entirely when
// no_locations is 0, and a skipped query is invisible in a rendered page.
interface Prepared {
  sql: string;
  params: Bindable[];
}

// EVERY ROUND TRIP, IN ORDER, AS THE SQL IT CARRIED -- a `batch()` is ONE
// entry holding all of its statements, a lone `first()`/`all()` is an entry of
// one. `prepared` alone cannot see this and github #52 is a round-trip change:
// four statements sent as two batches and four statements sent one at a time
// are indistinguishable in a flat statement log, and the whole point of the
// change is that the donation-points page now makes two waits where it made
// four. So the count of THIS array is what the win is asserted on, and a
// refactor that unrolled either batch back into sequential awaits would return
// byte-identical pages and fail here.
type RoundTrip = string[];

// The slice of the D1 Sessions API packages/db uses, over node:sqlite,
// including `batch` -- getFoodbankBySlug sends the food bank row and its
// latest need as ONE batch and indexes straight into the result array, so this
// must run them in order and return one result per input.
function d1Session(db: DatabaseSync, prepared: Prepared[], roundTrips: RoundTrip[]): D1DatabaseSession {
  const statement = (sql: string, entry: Prepared) => ({
    sql,
    get params() {
      return entry.params;
    },
    bind: (...next: unknown[]) => {
      entry.params = next as Bindable[];
      return statement(sql, entry);
    },
    first: async <T>() => {
      roundTrips.push([sql]);
      return (db.prepare(sql).get(...entry.params) as T | undefined) ?? null;
    },
    all: async () => {
      roundTrips.push([sql]);
      return { results: db.prepare(sql).all(...entry.params), success: true, meta: {} };
    },
    run: async () => {
      roundTrips.push([sql]);
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
    batch: async (statements: Array<{ sql: string; params: Bindable[] }>) => {
      roundTrips.push(statements.map((s) => s.sql));
      return statements.map((s) => ({ results: db.prepare(s.sql).all(...s.params), success: true, meta: {} }));
    },
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let prepared: Prepared[];
let roundTrips: RoundTrip[];
let sessions: number;

function env(): AppEnv["Bindings"] {
  return {
    DB: {
      withSession: () => {
        sessions += 1;
        return d1Session(db, prepared, roundTrips);
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
// Seeds. Only the columns these two pages read are parameterised; every other
// NOT NULL column is filled with something the real migration accepts, so a
// seeded row is one production would have taken.
// ---------------------------------------------------------------------------

interface FoodbankSeed {
  id: number;
  slug: string;
  name: string;
  altName?: string | null;
  country?: string;
  latLng?: string;
  charityNumber?: string | null;
  charityName?: string | null;
  address?: string;
  postcode?: string;
  deliveryAddress?: string | null;
  addressIsAdministrative?: 0 | 1;
  isClosed?: 0 | 1;
  noLocations?: number;
  noDonationPoints?: number | null;
  bounds?: [number | null, number | null, number | null, number | null];
  rssUrl?: string | null;
}

function seedFoodbank(s: FoodbankSeed): void {
  const [north, south, east, west] = s.bounds ?? [null, null, null, null];
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, alt_name, slug, address, postcode, country, lat_lng,
       latitude, longitude, delivery_address, network, charity_number, charity_just_foodbank,
       charity_name, contact_email, url, shopping_list_url, rss_url, address_is_administrative,
       is_closed, no_locations, no_donation_points, days_between_needs,
       bounds_north, bounds_south, bounds_east, bounds_west, latest_need_id, created, modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'Trussell', ?, 0,
       ?, ?, ?, ?, ?, ?, ?, ?, ?, 14, ?, ?, ?, ?, NULL,
       '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run(
    s.id,
    String(s.id).padStart(32, "a"),
    s.name,
    s.altName ?? null,
    s.slug,
    s.address ?? "12 High Street\r\nHarnham",
    s.postcode ?? "SP2 8LZ",
    s.country ?? "England",
    s.latLng ?? "51.0688,-1.7945",
    s.deliveryAddress ?? null,
    s.charityNumber ?? null,
    s.charityName ?? null,
    `info@${s.slug}.invalid`,
    `https://${s.slug}.invalid/`,
    `https://${s.slug}.invalid/list/`,
    s.rssUrl ?? null,
    s.addressIsAdministrative ?? 0,
    s.isClosed ?? 0,
    s.noLocations ?? 1,
    // `?? 1` would turn an explicit null into 1 and quietly delete the
    // nullable-counter test below, which is the whole reason this column is
    // parameterised at all.
    s.noDonationPoints === undefined ? 1 : s.noDonationPoints,
    north,
    south,
    east,
    west,
  );
}

interface LocationSeed {
  id: number;
  foodbankId: number;
  name: string;
  slug: string;
  address?: string | null;
  postcode?: string | null;
  isClosed?: 0 | 1;
  boundary?: string | null;
  placeHasPhoto?: 0 | 1 | null;
  isDonationPoint?: 0 | 1 | null;
}

function seedLocation(s: LocationSeed): void {
  db.prepare(
    `INSERT INTO foodbanklocation (id, uuid, foodbank_id, name, slug, address, postcode, country,
       lat_lng, is_closed, is_donation_point, place_has_photo, boundary_geojson, modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'England', '51.07,-1.79', ?, ?, ?, ?, '2020-01-01 00:00:00.000000')`,
  ).run(
    s.id,
    String(s.id).padStart(32, "e"),
    s.foodbankId,
    s.name,
    s.slug,
    s.address === undefined ? "1 Side Street" : s.address,
    s.postcode === undefined ? "SP1 1AA" : s.postcode,
    s.isClosed ?? 0,
    s.isDonationPoint ?? null,
    s.placeHasPhoto ?? null,
    s.boundary ?? null,
  );
}

interface DonationPointSeed {
  id: number;
  foodbankId: number;
  name: string;
  slug: string;
  company?: string | null;
  isClosed?: 0 | 1;
  placeHasPhoto?: 0 | 1 | null;
}

function seedDonationPoint(s: DonationPointSeed): void {
  db.prepare(
    `INSERT INTO foodbankdonationpoint (id, uuid, foodbank_id, name, slug, address, postcode, country,
       lat_lng, is_closed, in_store_only, place_has_photo, company, company_slug, modified)
     VALUES (?, ?, ?, ?, ?, '5 Retail Park', 'SP4 4DD', 'England', '51.08,-1.80', ?, 0, ?, ?, ?,
       '2020-01-01 00:00:00.000000')`,
  ).run(
    s.id,
    String(s.id).padStart(32, "d"),
    s.foodbankId,
    s.name,
    s.slug,
    s.isClosed ?? 0,
    s.placeHasPhoto ?? null,
    s.company ?? null,
    s.company ? s.company.toLowerCase().replace(/\s+/g, "-") : null,
  );
}

const BOUNDARY = '{"type":"Polygon","coordinates":[[[-1.9,51.0],[-1.7,51.0],[-1.7,51.1],[-1.9,51.0]]]}';

// THE FIXTURE IS THE TEST: each food bank turns exactly one branch of one of
// the two pages on or off relative to its neighbour.
//
//   1  salisbury     the full page: four locations covering every combination
//                    of photo/boundary/address/postcode/donation-point/closed,
//                    three donation points, and a service area
//   2  bath          no_locations = 0 while OWNING a boundary-bearing location
//                    that is also a donation point -- the has_service_area
//                    short circuit, and the one row that proves the two lists
//                    are read from different places
//   3  truro         country "Jersey", outside CHARITY_DETAIL_COUNTRIES
//   4  no-dp-town    no_donation_points = 0 -- the donation-points 404
//   5  null-dp-town  no_donation_points NULL -- the NULLABLE half of that gate
//   6  bounded       all four bounds columns set
//   7  half-bounded  bounds_north NULL, the other three set
//   8  closed-town   is_closed, an administrative address and a delivery one
//   9  caerdydd      alt_name, for full_name()'s Welsh branch
function seed(): void {
  seedFoodbank({
    id: 1,
    slug: "salisbury",
    name: "Salisbury",
    charityNumber: "1130237",
    charityName: "Salisbury Foodbank Trust",
    noLocations: 4,
    noDonationPoints: 5,
    rssUrl: "https://salisbury.invalid/feed/",
  });
  // ONE ROW IN EACH LIST IS DELIBERATELY NAMED OUT OF SLUG ORDER, and this
  // file's first draft got it wrong. Ids ascend in a non-alphabetical order,
  // which looked like enough -- but `SELECT * FROM foodbanklocation_full
  // WHERE foodbank_id = ?` is answered through `loc_foodbank_slug_idx`
  // (foodbank_id, slug) and `dp_foodbank_slug_idx` for its sibling, so
  // unsorted rows arrive in SLUG order, and slugs are minted from names. With
  // every slug agreeing with its name, swapping getLocationsByFoodbankId for
  // its Unsorted twin changed NOTHING and the whole list assertion passed
  // against a sort that was not happening -- confirmed by running exactly that
  // mutation against a copy of this repo.
  //
  // "Alderholt Rooms" (slug closed-centre) and "Waitrose Amesbury" (slug asda)
  // are the fix, and they are what production looks like anyway: slugs are
  // stable URL identifiers minted once, names get edited afterwards when a
  // centre is renamed or a store rebrands.
  seedLocation({ id: 11, foodbankId: 1, name: "Zeals Centre", slug: "zeals", boundary: BOUNDARY, placeHasPhoto: 1 });
  seedLocation({ id: 12, foodbankId: 1, name: "Amesbury Centre", slug: "amesbury", placeHasPhoto: 1, isDonationPoint: 1, postcode: "SP4 7AA" });
  seedLocation({ id: 13, foodbankId: 1, name: "Alderholt Rooms", slug: "closed-centre", isClosed: 1, isDonationPoint: 1, address: null, postcode: null });
  seedLocation({ id: 14, foodbankId: 1, name: "Bemerton Heath", slug: "bemerton", address: null, postcode: "SP2 9DJ", isDonationPoint: 0 });
  seedDonationPoint({ id: 21, foodbankId: 1, name: "Tesco Extra", slug: "tesco-extra", company: "Tesco Extra", placeHasPhoto: 1 });
  seedDonationPoint({ id: 22, foodbankId: 1, name: "Waitrose Amesbury", slug: "asda" });
  seedDonationPoint({ id: 23, foodbankId: 1, name: "Closed Co-op", slug: "closed-coop", isClosed: 1 });

  seedFoodbank({ id: 2, slug: "bath", name: "Bath", noLocations: 0, noDonationPoints: 2 });
  seedLocation({ id: 31, foodbankId: 2, name: "Twerton Centre", slug: "twerton", boundary: BOUNDARY, isDonationPoint: 1 });
  seedDonationPoint({ id: 32, foodbankId: 2, name: "Bath Co-op", slug: "bath-coop" });

  seedFoodbank({ id: 3, slug: "truro", name: "Truro", country: "Jersey", charityNumber: "NPO123", charityName: "Truro Trust" });
  seedLocation({ id: 41, foodbankId: 3, name: "Truro Hall", slug: "truro-hall" });
  seedDonationPoint({ id: 42, foodbankId: 3, name: "Truro Store", slug: "truro-store" });

  seedFoodbank({ id: 4, slug: "no-dp-town", name: "No DP Town", noLocations: 2, noDonationPoints: 0 });
  seedLocation({ id: 51, foodbankId: 4, name: "One Centre", slug: "one" });

  seedFoodbank({ id: 5, slug: "null-dp-town", name: "Null DP Town", noDonationPoints: null });
  seedLocation({ id: 61, foodbankId: 5, name: "Null Centre", slug: "null-centre" });
  seedDonationPoint({ id: 62, foodbankId: 5, name: "Null Store", slug: "null-store" });

  seedFoodbank({ id: 6, slug: "bounded", name: "Bounded", bounds: [52.5, 51.5, -1.5, -2.5] });
  seedLocation({ id: 71, foodbankId: 6, name: "Bounded Centre", slug: "bounded-centre" });

  seedFoodbank({ id: 7, slug: "half-bounded", name: "Half Bounded", bounds: [null, 51.5, -1.5, -2.5] });
  seedLocation({ id: 81, foodbankId: 7, name: "Half Centre", slug: "half-centre" });

  seedFoodbank({
    id: 8,
    slug: "closed-town",
    name: "Closed Town",
    isClosed: 1,
    addressIsAdministrative: 1,
    deliveryAddress: "Depot Road\r\nIndustrial Estate",
  });
  seedLocation({ id: 91, foodbankId: 8, name: "Shut Centre", slug: "shut" });
  seedDonationPoint({ id: 92, foodbankId: 8, name: "Shut Store", slug: "shut-store" });

  seedFoodbank({ id: 9, slug: "caerdydd", name: "Caerdydd", altName: "Banc Bwyd Caerdydd", country: "Wales" });
  seedLocation({ id: 101, foodbankId: 9, name: "Caerdydd Centre", slug: "caerdydd-centre" });
  seedDonationPoint({ id: 102, foodbankId: 9, name: "Caerdydd Store", slug: "caerdydd-store" });
}

beforeEach(async () => {
  db = new DatabaseSync(":memory:");
  // schemaFor, not hand-written DDL: both queries read through the
  // `*_full` VIEWS, getFoodbankBySlug reads `foodbankchange_full`
  // unconditionally (github #51 -- eight suites 500'd at once when it started
  // doing so), and `slugredirect` is read by the slugRedirect middleware on
  // every /needs/at/ URL whether these routes want it or not.
  db.exec(
    schemaFor(
      "foodbank",
      "foodbankchange",
      "foodbankchange_full",
      "foodbanklocation",
      "foodbanklocation_full",
      "foodbankdonationpoint",
      "foodbankdonationpoint_full",
      "slugredirect",
    ),
  );
  seed();
  prepared = [];
  roundTrips = [];
  sessions = 0;

  // WARM THE SLUG-REDIRECT MEMO BEFORE COUNTING ANYTHING. middleware/
  // slugRedirect.ts holds its map in a MODULE-level memo with a 5-minute TTL,
  // so the first /needs/at/ request through this file's isolate opens a second
  // D1 session and issues a `SELECT ... FROM slugredirect` that no later
  // request repeats. Without this line the query-count assertions below would
  // depend on which test ran first -- the kind of order-dependence that makes
  // a suite flaky the moment someone adds a `.only`.
  await get("/needs/at/warm-the-memo/locations/");
  prepared = [];
  roundTrips = [];
  sessions = 0;
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

// `async`, not a bare arrow: app.fetch is typed Response | Promise<Response>.
const get = async (path: string, init?: RequestInit): Promise<Response> => app.fetch(new Request(`${ORIGIN}${path}`, init), env(), execCtx);
const body = async (path: string): Promise<string> => (await get(path)).text();

// The single column each page prints its list into, sliced out of the page so
// an assertion about "what is listed" cannot accidentally be satisfied by the
// left-hand menu, the breadcrumb or the footer -- all of which link to the
// same slugs with similar text.
function listColumn(html: string, className: "locations" | "donationpoints"): string {
  const start = html.indexOf(`<div class="column ${className}">`);
  const end = html.indexOf('<div class="column is-6">', start);
  if (start === -1 || end === -1) throw new Error(`no ${className} column in the rendered page`);
  return html.slice(start, end);
}

// Every anchor's visible text in that column, in document order. The photo
// anchors wrap a <picture> and so contribute whitespace only, which is
// dropped; what is left is exactly the heading anchors ("Main"/"Administrative"
// /"Delivery") followed by the list, in the order a donor reads them.
function listedNames(html: string, className: "locations" | "donationpoints"): string[] {
  return [...listColumn(html, className).matchAll(/>([^<]*)<\/a>/g)].map((m) => (m[1] ?? "").trim()).filter((text) => text !== "");
}

// includes/mapconfig.njk drops `map_config` into a <script> verbatim, so the
// string between "= " and ";" is exactly what the map JS parses.
function mapConfigOf(html: string): string {
  const match = /window\.gfMapConfig = ([\s\S]*?);\n/.exec(html);
  if (!match) throw new Error("no gfMapConfig in the rendered page");
  return match[1] as string;
}

describe("wfbnFoodbankLocations -- the response envelope", () => {
  // Django's `foodbank_locations` carries @cache_page(SECONDS_IN_DAY)
  // (gfwfbn/views.py:556), and pageCacheControl's fall-through DAY rule gives
  // this path the same s-maxage. The browser number is deliberately NOT
  // Django's -- BROWSER_MAX_AGE is 300 because a browser cache cannot be
  // purged and a location can close overnight.
  it("serves cacheable HTML: five minutes in the browser, Django's day at the purgeable edge", async () => {
    const res = await get("/needs/at/salisbury/locations/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    expect(res.headers.get("Content-Language")).toBe("en");
  });

  // THE TAG IS WHY THE DAY ABOVE IS SAFE, and this page is the reason
  // cacheTag.ts derives tags from the PATH rather than copying Django's
  // hand-maintained URL list: that list (models/foodbank.py:717-758) never
  // mentioned /locations/ or /donationpoints/, so editing a food bank in
  // Django never purged either of these two pages.
  it("stamps the food bank's own purge tag on both pages, in every locale", async () => {
    expect((await get("/needs/at/salisbury/locations/")).headers.get("Cache-Tag")).toBe("fb-salisbury");
    expect((await get("/needs/at/salisbury/donationpoints/")).headers.get("Cache-Tag")).toBe("fb-salisbury");
    expect((await get("/cy/needs/at/salisbury/locations/")).headers.get("Cache-Tag")).toBe("fb-salisbury");
    expect((await get("/gd/needs/at/salisbury/donationpoints/")).headers.get("Cache-Tag")).toBe("fb-salisbury");
  });

  // Django's GeoJSONPreload (givefood/middleware.py) lists both of these
  // views' url_names, and the port reproduces it for the unprefixed routes
  // only: index.ts registers "/cy/needs/at/:slug/locations/" as its own route
  // and geoJsonPreload compares routePath against the unprefixed literal. A
  // real divergence, already pinned in middleware/geoJsonPreload.test.ts and
  // asserted here because these are two of the four pages it costs.
  it("preloads the food bank's geojson in English and, divergently, not in Welsh", async () => {
    const expected = "</needs/at/salisbury/geo.json>; rel=preload; as=fetch; crossorigin=anonymous";
    expect((await get("/needs/at/salisbury/locations/")).headers.get("Link")).toBe(expected);
    expect((await get("/needs/at/salisbury/donationpoints/")).headers.get("Link")).toBe(expected);
    expect((await get("/cy/needs/at/salisbury/locations/")).headers.get("Link")).toBeNull();
    expect((await get("/cy/needs/at/salisbury/donationpoints/")).headers.get("Link")).toBeNull();
  });

  // ONE D1 SESSION, THREE STATEMENTS, TWO ROUND TRIPS, AND THE SHAPE OF THEM.
  //
  // lib/session.ts opens a single withSession("first-unconstrained") per
  // request so every query sees one snapshot of a replicated database; a
  // handler that opened one per query would render identically.
  //
  // The first two are getFoodbankBySlug's BATCH -- one round trip, not two.
  // The third is the location list, and it is now the LAST thing this page
  // asks D1 for: github #52 deleted the fourth statement, hasServiceArea's
  // `SELECT COUNT(*)`, whose answer is false for 1,016 of the 1,023 open food
  // banks and which was counting a predicate over rows the third statement had
  // just returned in full. has_service_area is derived from those rows
  // instead; the equivalence is proved case by case further down this file.
  //
  // AND THE THIRD STATEMENT NAMES ITS COLUMNS. #52's closing observation: the
  // page reads boundary_geojson twice and prints it neither time, so it asks
  // for `... AS has_boundary` and leaves the blob in D1. That is invisible from
  // the rendered page -- `SELECT *` returns a superset and every other
  // assertion in this file still passes -- so the statement text is the only
  // thing that can see a revert. Worth 2,299,936 bytes per render on the
  // largest of the seven production food banks that own a boundary.
  it("reads the locations page from one session: the batched foodbank+need pair, then the locations, and nothing else", async () => {
    await get("/needs/at/salisbury/locations/");

    expect(sessions).toBe(1);
    expect(prepared.map((p) => [p.sql, p.params])).toEqual([
      ["SELECT * FROM foodbank WHERE slug = ?", ["salisbury"]],
      ["SELECT * FROM foodbankchange_full WHERE id = (SELECT latest_need_id FROM foodbank WHERE slug = ?)", ["salisbury"]],
      [LOCATIONS_SQL, [1]],
    ]);
    expect(LOCATIONS_SQL).not.toContain("SELECT *");
    // Three statements, two waits -- and the statement log above cannot tell
    // those apart. Four sequential round trips is what this page cost before
    // #52; the pair below is what it costs now.
    expect(roundTrips).toEqual([
      [
        "SELECT * FROM foodbank WHERE slug = ?",
        "SELECT * FROM foodbankchange_full WHERE id = (SELECT latest_need_id FROM foodbank WHERE slug = ?)",
      ],
      [LOCATIONS_SQL],
    ]);
  });

  // An unknown slug is Django's get_object_or_404. It must reach the real 404
  // page and, above all, must NOT be stamped cacheable: pageCacheControl only
  // touches 200s and cacheTag only touches ok responses, so a mistyped slug
  // cannot poison the edge with a day-long negative entry.
  it("404s an unknown slug, uncached and untagged", async () => {
    const res = await get("/needs/at/nowhere/locations/");

    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(res.headers.get("Cache-Tag")).toBeNull();
  });

  // THE no_locations GATE, matching gfwfbn/views.py:563 exactly. Bath's
  // counter says zero while it owns a location row, and the page 404s anyway
  // -- the counter is what decides, not the table. Django is identical, which
  // is why this pins the 404 rather than the (arguably more useful) listing.
  it("404s a food bank whose no_locations counter is zero, even though it owns a location", async () => {
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbanklocation WHERE foodbank_id = 2").get()).toEqual({ n: 1 });

    expect((await get("/needs/at/bath/locations/")).status).toBe(404);
    expect((await get("/cy/needs/at/bath/locations/")).status).toBe(404);
  });

  // The opposite disagreement: a counter above zero with nothing behind it.
  // no_locations is denormalised (Django recomputes it in Foodbank.save()), so
  // it can be stale in either direction -- and this direction renders the page
  // with an empty list rather than 404ing or erroring.
  it("renders an empty list when the counter says locations exist and none do", async () => {
    db.prepare("DELETE FROM foodbanklocation WHERE foodbank_id = 1").run();

    const html = await body("/needs/at/salisbury/locations/");
    expect((await get("/needs/at/salisbury/locations/")).status).toBe(200);
    expect(listedNames(html, "locations")).toEqual(["Main"]);
  });

  // lib/appendSlash.ts, Django's APPEND_SLASH. The slashless spelling is what
  // a hand-typed URL and a good many inbound links look like.
  it("redirects the slashless spelling rather than 404ing it", async () => {
    const res = await get("/needs/at/salisbury/locations");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/needs/at/salisbury/locations/`);
  });

  // GET ONLY, matching Django, where neither view takes a request body. A
  // stray app.all would hand a POST to a handler whose response
  // pageCacheControl then stamps public for a day.
  it("does not answer a POST at all", async () => {
    expect((await get("/needs/at/salisbury/locations/", { method: "POST" })).status).toBe(404);
    expect((await get("/needs/at/salisbury/donationpoints/", { method: "POST" })).status).toBe(404);
  });

  // A GET THAT WRITES IS THE FAILURE THIS ASSERTS AGAINST -- a route in this
  // repo has been caught with one before. Both pages are stamped
  // `public, s-maxage=86400`, so a side effect would run once and then be
  // swallowed by the edge for a day.
  it("issues nothing but SELECTs, on both pages and in every locale", async () => {
    await get("/needs/at/salisbury/locations/");
    await get("/cy/needs/at/salisbury/donationpoints/");
    await get("/gd/needs/at/salisbury/locations/?anything=1");

    expect(prepared).not.toHaveLength(0);
    for (const { sql } of prepared) expect(sql).toMatch(/^SELECT /);
  });

  // The slug comparison is SQLite's default case-sensitive `=` on TEXT, so a
  // shouted URL is a 404 rather than a second, uncanonical spelling of the
  // page. A `COLLATE NOCASE` on the column would silently create duplicate
  // content for every food bank.
  it("does not answer a differently-cased slug", async () => {
    expect((await get("/needs/at/SALISBURY/locations/")).status).toBe(404);
    expect((await get("/needs/at/Salisbury/donationpoints/")).status).toBe(404);
  });

  // A D1 outage must produce the 500 page, not a locations page with an empty
  // list -- and must not be cached, or a day of "this food bank has no
  // locations" goes out to everyone who asks.
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

    const res = await app.fetch(new Request(`${ORIGIN}/needs/at/salisbury/locations/`), broken, execCtx);

    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(await res.text()).not.toContain("Amesbury Centre");
  });

  // elapsedMs() reports WHOLE milliseconds, deliberately unlike Django's three
  // decimal places -- on Workers performance.now() is coarsened and the
  // fraction was always ".000", decoration that reads like precision. A revert
  // to toFixed(3) shows up here as "Took 0.000ms"; dropping render_time_ms
  // leaves "Took ms". Only the FORMAT is asserted: 0 is a legitimate value on
  // the clock this exists to describe.
  it("stamps the debug comment with a whole-millisecond render time", async () => {
    expect(/⏱️ Took (\S+)/.exec(await body("/needs/at/salisbury/locations/"))?.[1]).toMatch(/^\d+ms$/);
    expect(/⏱️ Took (\S+)/.exec(await body("/needs/at/salisbury/donationpoints/"))?.[1]).toMatch(/^\d+ms$/);
  });
});

describe("wfbnFoodbankLocations -- the list a donor actually reads", () => {
  // THE WHOLE COLUMN, IN ORDER, AS ONE VALUE. This single assertion carries
  // four separate contracts, each of which has its own way of failing quietly:
  //
  //   * ORDER is packages/db's Intl.Collator applied in JS, not an SQL ORDER
  //     BY. D1 answers the query through (foodbank_id, slug), so an unsorted
  //     result would read Amesbury, Bemerton, Alderholt, Zeals -- see the
  //     fixture's own note on why one row is named out of slug order;
  //   * "Alderholt Rooms" is is_closed = 1 and is STILL LISTED. Django's
  //     Foodbank.locations() has no is_closed filter either
  //     (givefood/models/foodbank.py:546), so adding the "obvious" filter here
  //     would delete rows from real pages;
  //   * the heading anchor above the list says "Main", not "Administrative";
  //   * nothing belonging to another food bank appears.
  it("lists every location of this food bank, closed ones included, in collator order", async () => {
    expect(listedNames(await body("/needs/at/salisbury/locations/"), "locations")).toEqual([
      "Main",
      "Alderholt Rooms",
      "Amesbury Centre",
      "Bemerton Heath",
      "Zeals Centre",
    ]);
  });

  // The negative half of the filter, spelled out. A `WHERE foodbank_id = ?`
  // that lost its predicate would pass the assertion above unchanged -- the
  // extra rows would simply sort in among the others -- so the exclusion needs
  // naming rows that exist in the same table and must not be here.
  it("excludes other food banks' locations entirely", async () => {
    const html = await body("/needs/at/salisbury/locations/");

    expect(html).not.toContain("Twerton Centre");
    expect(html).not.toContain("Truro Hall");
    expect(html).not.toContain("Shut Centre");
  });

  // Each location links to its own detail page under this food bank's slug. A
  // link built from the wrong slug 404s, which is at least visible; one built
  // from the wrong LOCATION slug lands on a different, real branch, which is
  // not.
  it("links each location to its own page under this food bank", async () => {
    const column = listColumn(await body("/needs/at/salisbury/locations/"), "locations");

    expect(column).toContain('<a href="/needs/at/salisbury/amesbury/">Amesbury Centre</a>');
    expect(column).toContain('<a href="/needs/at/salisbury/closed-centre/">Alderholt Rooms</a>');
  });

  // THE PHOTO GATE IS `place_has_photo AND NOT has_boundary`. Both of these
  // locations have a photo; only the one WITHOUT a service-area boundary shows
  // it, because Django prints a map thumbnail instead for the other -- and that
  // thumbnail branch is deliberately NOT ported (the .njk says so:
  // wfbn:foodbank_location_map_size has no url() entry or handler here). So a
  // boundary-bearing location renders with no image at all, where Django
  // renders a map. Pinned as the current, knowingly-divergent behaviour.
  //
  // THE SECOND HALF OF THE GATE IS THE FLAG, NOT THE BLOB, and this is the one
  // assertion in the repo that can see the difference. Django tests
  // `location.boundary_geojson`; since #52's projection change the column is
  // not on the row at all, so the template reads `location.has_boundary`
  // instead. Leave the template on the old name and Nunjucks evaluates `not
  // undefined` -- true for every location -- and Zeals grows a photo it must
  // not have, on a page that still renders a clean 200.
  it("shows a photo only for a location that has one and has no boundary", async () => {
    const column = listColumn(await body("/needs/at/salisbury/locations/"), "locations");

    expect(column).toContain(
      '<img src="/needs/at/salisbury/amesbury/photo.jpg?s=300" alt="Amesbury Centre" loading="lazy" class="placephoto is-pulled-right" style="width:150px;clear:left">',
    );
    expect(column).toContain('srcset="/needs/at/salisbury/amesbury/photo.jpg?s=150&amp;f=avif 150w');
    // Zeals has place_has_photo = 1 AND a boundary: no photo, and no map
    // thumbnail either, because that branch is unported.
    expect(column).not.toContain("zeals/photo.jpg");
    expect(column).not.toContain("zeals/map");
  });

  // The <address> block is gated on `location.address or location.postcode`,
  // with the <br> between them gated on BOTH. All four states are reachable in
  // production (address is nullable on this table and postcode is too), and
  // the failure mode of getting it wrong is a stray leading <br> or an empty
  // <address> element -- invisible to a reviewer skim-reading a rendered page.
  it("prints address and postcode independently, and no address block when both are null", async () => {
    const column = listColumn(await body("/needs/at/salisbury/locations/"), "locations");

    // Both: joined by a <br>.
    expect(column).toContain("1 Side Street<br>SP4 7AA");
    // Postcode only (Bemerton): no leading <br>.
    expect(column).toMatch(/<address>\s*SP2 9DJ\s*<\/address>/);
    // Neither (Alderholt Rooms): the whole element is gone, so the anchor is
    // followed straight by the closing div.
    expect(column).toMatch(/Alderholt Rooms<\/a>\s*<\/div>/);
  });

  // The food bank's own address heads the list, and it is the one place these
  // two templates disagree with each other: locations.njk prints the block
  // with an "Administrative" heading, donationpoints.njk omits the block
  // entirely. Both match their Django originals.
  it("heads the list with the food bank's own address, labelled Administrative when it is one", async () => {
    const salisbury = listColumn(await body("/needs/at/salisbury/locations/"), "locations");
    expect(salisbury).toContain("12 High Street<br>Harnham<br>");
    expect(salisbury).toContain("SP2 8LZ");
    expect(listedNames(await body("/needs/at/salisbury/locations/"), "locations")[0]).toBe("Main");

    const closed = await body("/needs/at/closed-town/locations/");
    expect(listedNames(closed, "locations")).toEqual(["Administrative", "Delivery", "Shut Centre"]);
    expect(listColumn(closed, "locations")).toContain("Depot Road<br>Industrial Estate");
  });

  // is_closed drives the robots meta as well as the visible page. Losing the
  // meta alone leaves a closed food bank's location list in the search index
  // indefinitely, with no visible symptom at all.
  it("marks a closed food bank's pages noindex", async () => {
    expect(await body("/needs/at/closed-town/locations/")).toContain('<meta name="robots" content="noindex">');
    expect(await body("/needs/at/closed-town/donationpoints/")).toContain('<meta name="robots" content="noindex">');
    expect(await body("/needs/at/salisbury/locations/")).not.toContain('content="noindex"');
  });

  // The head block, which is what a share preview and a search result show.
  // `latt`/`long` are Number()s of the two halves of lat_lng and the column
  // itself goes out verbatim in geo.position -- swapping the halves is the
  // classic version of this mistake and puts the marker in the North Sea.
  // Both spellings are on the page, which is what makes it assertable.
  it("builds the social and geo meta from full_name and the two halves of lat_lng", async () => {
    const html = await body("/needs/at/salisbury/locations/");

    expect(html).toContain('<title>Locations - Salisbury Foodbank - Give Food</title>');
    expect(html).toContain('<meta property="og:title" content="Salisbury Foodbank">');
    expect(html).toContain('<meta name="description" content="Find what Salisbury Foodbank is requesting to have donated">');
    expect(html).toContain('<meta property="og:image" content="https://www.givefood.org.uk/needs/at/salisbury/map.png">');
    expect(html).toContain('<meta property="og:image:alt" content="Map of Salisbury Foodbank">');
    expect(html).toContain('<meta name="geo.position" content="51.0688,-1.7945">');
    expect(html).toContain('<meta property="place:location:latitude" content="51.0688">');
    expect(html).toContain('<meta property="place:location:longitude" content="-1.7945">');
  });

  // SUSPECT, PINNED AS-IS. `lat_lng.split(",")` is destructured into two
  // consts with no length check, so a column that is not "lat,lng" yields
  // Number(undefined) === NaN and the page renders the literal string "NaN"
  // into an Open Graph meta rather than erroring. lat_lng is NOT NULL and
  // every production row is well-formed, so this is a state the data does not
  // currently reach -- which is exactly why it needs a test rather than an
  // observation. Asserted, not fixed: this file may not touch the source.
  it("SUSPECT: renders NaN into the place meta for a malformed lat_lng instead of failing", async () => {
    db.prepare("UPDATE foodbank SET lat_lng = '51.0688' WHERE slug = 'salisbury'").run();

    const res = await get("/needs/at/salisbury/locations/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<meta property="place:location:longitude" content="NaN">');
  });

  // The markdown alternate is the machine-readable twin of this page, and it
  // is NOT locale-prefixed: /md/ is registered outside i18n_patterns, so the
  // Welsh page must advertise the same bare URL.
  it("advertises the markdown twin of each page, unprefixed in every locale", async () => {
    expect(await body("/needs/at/salisbury/locations/")).toContain(
      '<link rel="alternate" type="text/markdown" href="/md/needs/at/salisbury/locations/">',
    );
    expect(await body("/cy/needs/at/salisbury/locations/")).toContain(
      '<link rel="alternate" type="text/markdown" href="/md/needs/at/salisbury/locations/">',
    );
    expect(await body("/needs/at/salisbury/donationpoints/")).toContain(
      '<link rel="alternate" type="text/markdown" href="/md/needs/at/salisbury/donationpoints/">',
    );
  });

  // The hit beacon feeds foodbankhit, which the homepage's "most viewed this
  // week" panel ranks on. A wrong slug here silently attributes one food
  // bank's traffic to another.
  it("fires the hit beacon at this food bank's own endpoint from both pages", async () => {
    const beacon = '<script>fetch("/needs/at/salisbury/hit/", {method: "POST", keepalive: true});</script>';
    expect(await body("/needs/at/salisbury/locations/")).toContain(beacon);
    expect(await body("/needs/at/salisbury/donationpoints/")).toContain(beacon);
  });
});

describe("wfbnFoodbankDonationpoints -- the gate, which is not the same gate", () => {
  // Django's `foodbank_donationpoints` is `if foodbank.no_donation_points == 0`
  // (gfwfbn/views.py:594); the port is `if (!foodbank.no_donation_points)`.
  // For a real 0 the two agree, and this is the case production is full of.
  it("404s a food bank whose donation-point counter is zero", async () => {
    const res = await get("/needs/at/no-dp-town/donationpoints/");

    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBeNull();
    // ...while its locations page, gated on the other counter, is fine.
    expect((await get("/needs/at/no-dp-town/locations/")).status).toBe(200);
  });

  // THE DIVERGENCE, PINNED RATHER THAN FIXED. no_donation_points is NULLABLE
  // in D1 (0001_core.sql:38) where Django's field is a plain
  // IntegerField(default=0). `!null` is true, so this food bank 404s here;
  // Python's `None == 0` is False, so Django would have RENDERED the page and
  // listed its donation point. The port's own comment (and md/donationpoints.ts's)
  // calls this "matching Django's `== 0`", which it is not for NULL.
  //
  // Whether any production row actually holds NULL is not something this repo
  // can settle and is not verified here -- the divergence is what is pinned.
  it("SUSPECT: 404s a NULL donation-point counter where Django's == 0 would have rendered the page", async () => {
    expect(db.prepare("SELECT no_donation_points AS n FROM foodbank WHERE slug = 'null-dp-town'").get()).toEqual({ n: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbankdonationpoint WHERE foodbank_id = 5").get()).toEqual({ n: 1 });

    expect((await get("/needs/at/null-dp-town/donationpoints/")).status).toBe(404);
  });

  // AND THE MENU STILL LINKS TO IT. menu.njk gates the entry on
  // `foodbank.no_donation_points != 0`, which is TRUE for null in both
  // Nunjucks and Django's template language -- so this food bank's own
  // locations page offers a "Donation points" link that 404s. The two halves
  // disagree about what null means; asserted together because neither half is
  // wrong on its own.
  it("SUSPECT: the menu offers a Donation points link to that 404, from the sibling page", async () => {
    const html = await body("/needs/at/null-dp-town/locations/");

    expect(html).toContain('<li><a href="/needs/at/null-dp-town/donationpoints/">Donation points</a></li>');
    expect((await get("/needs/at/null-dp-town/donationpoints/")).status).toBe(404);
  });

  // FOUR STATEMENTS, IN THIS ORDER, ON ONE SESSION -- AND TWO ROUND TRIPS.
  //
  // THIS IS THE TEST github #52 EXISTS FOR, and it is the one that changed
  // most. Before: five statements in four sequential waits -- getFoodbankBySlug's
  // batch, then the locations, then the donation points, then a `SELECT
  // COUNT(*)` for has_service_area, each one a fresh ~16 ms hop measured
  // against production. None of the last three depended on another's result.
  //
  // Now: the locations and the donation points ride the same batch (packages/db's
  // getLocationsAndDonationPointsByFoodbankId, the same two statements it always
  // sent), and the COUNT is gone entirely -- its answer is derived from the
  // location rows the batch brings back. Two waits, not four.
  //
  // The statement list is asserted first because it is what proves the batched
  // pair did not quietly change the SQL: same views, same bound id, same order.
  // The one thing it DID change afterwards is the location projection -- #52's
  // closing observation -- which is why the expected SQL is built from
  // packages/db's LOCATION_COLUMNS_FLAGGED rather than being `SELECT *`.
  it("reads the donation-points page from one session, in four statements and only two round trips", async () => {
    await get("/needs/at/salisbury/donationpoints/");

    expect(sessions).toBe(1);
    expect(prepared.map((p) => [p.sql, p.params])).toEqual([
      ["SELECT * FROM foodbank WHERE slug = ?", ["salisbury"]],
      ["SELECT * FROM foodbankchange_full WHERE id = (SELECT latest_need_id FROM foodbank WHERE slug = ?)", ["salisbury"]],
      [LOCATIONS_SQL, [1]],
      ["SELECT * FROM foodbankdonationpoint_full WHERE foodbank_id = ?", [1]],
    ]);
    expect(roundTrips).toEqual([
      [
        "SELECT * FROM foodbank WHERE slug = ?",
        "SELECT * FROM foodbankchange_full WHERE id = (SELECT latest_need_id FROM foodbank WHERE slug = ?)",
      ],
      [LOCATIONS_SQL, "SELECT * FROM foodbankdonationpoint_full WHERE foodbank_id = ?"],
    ]);
    // The locations half of the batch is projected; the donation-point half is
    // not, and does not need to be -- foodbankdonationpoint has no boundary
    // column. Asserted so "make the two statements match" is a deliberate
    // change rather than a tidy-up.
    expect(LOCATIONS_SQL).not.toContain("SELECT *");
  });
});

describe("wfbnFoodbankDonationpoints -- the two lists, which come from two different tables", () => {
  // THE WHOLE COLUMN AGAIN, AND IT IS TWO LOOPS CONCATENATED. The first is
  // locations that are ALSO donation points, filtered in JS out of the full
  // location list; the second is the FoodbankDonationPoint rows. Both are
  // name-sorted within themselves and the two are NOT merged, matching
  // Django's donationpoints.html, which runs the same two loops in the same
  // order.
  //
  // Read against the locations page's own list, this one assertion pins the
  // client-side filter in both directions: "Bemerton Heath"
  // (is_donation_point = 0) and "Zeals Centre" (NULL) are on that page and
  // absent here, while "Alderholt Rooms" (is_donation_point = 1, is_closed = 1)
  // is on both.
  it("lists the donation-point locations first, then the donation points, each in collator order", async () => {
    expect(listedNames(await body("/needs/at/salisbury/donationpoints/"), "donationpoints")).toEqual([
      "Main",
      "Alderholt Rooms",
      "Amesbury Centre",
      "Closed Co-op",
      "Tesco Extra",
      "Waitrose Amesbury",
    ]);
  });

  // The negative half of the JS filter, named. `is_donation_point` is a
  // TRI-STATE column in D1 (1/0/NULL) coerced to boolean/null by
  // mapLocationRow, and Django's `filter(is_donation_point=True)` excludes
  // both falsy spellings under three-valued SQL logic -- so 0 and NULL must
  // behave identically here.
  it("excludes locations that are not donation points, whether the flag is 0 or NULL", async () => {
    const column = listColumn(await body("/needs/at/salisbury/donationpoints/"), "donationpoints");

    expect(column).not.toContain("Bemerton Heath");
    expect(column).not.toContain("Zeals Centre");
  });

  it("excludes other food banks' donation points", async () => {
    const html = await body("/needs/at/salisbury/donationpoints/");

    expect(html).not.toContain("Bath Co-op");
    expect(html).not.toContain("Truro Store");
    expect(html).not.toContain("Shut Store");
  });

  // THE TWO LOOPS LINK TO DIFFERENT ROUTES, and this is the one thing on the
  // page a reader cannot check by eye: a location donation point is a
  // FoodbankLocation and links to /needs/at/<slug>/<locslug>/, while a
  // donation point links to /needs/at/<slug>/donationpoint/<dpslug>/. Swap
  // them and both links 404 -- or worse, resolve to an unrelated row that
  // happens to share a slug.
  it("links each list to its own detail route", async () => {
    const column = listColumn(await body("/needs/at/salisbury/donationpoints/"), "donationpoints");

    expect(column).toContain('<a href="/needs/at/salisbury/amesbury/">Amesbury Centre</a>');
    expect(column).toContain('<a href="/needs/at/salisbury/donationpoint/tesco-extra/">Tesco Extra</a>');
    expect(column).toContain('<a href="/needs/at/salisbury/donationpoint/asda/">Waitrose Amesbury</a>');
  });

  // The company logo is `donation_point.company|slugify`, and the file it
  // points at is a static asset that either exists or 404s as a broken image.
  // Only rows with a company get one -- an unconditional <img> would put a
  // broken icon beside every independent collection point.
  it("badges a donation point with its company logo, and only when it has a company", async () => {
    const column = listColumn(await body("/needs/at/salisbury/donationpoints/"), "donationpoints");

    expect(column).toContain('<img src="/static/img/co/tesco-extra.png" alt="Tesco Extra" class="companyicon">');
    expect(column.match(/companyicon/g)).toHaveLength(1);
  });

  // The photo gate on THIS page is `place_has_photo` alone -- no
  // boundary_geojson term, unlike the locations page -- and the two loops use
  // two different photo endpoints. Django's template is the same.
  it("shows photos from the location endpoint for one loop and the donation-point endpoint for the other", async () => {
    const column = listColumn(await body("/needs/at/salisbury/donationpoints/"), "donationpoints");

    expect(column).toContain('<img src="/needs/at/salisbury/amesbury/photo.jpg?s=300" alt="Amesbury Centre"');
    expect(column).toContain('<img src="/needs/at/salisbury/donationpoint/tesco-extra/photo.jpg?s=300" alt="Tesco Extra"');
    // The Waitrose has place_has_photo NULL: no <picture> at all.
    expect(column).not.toContain("donationpoint/asda/photo.jpg");
  });

  // Unlike locations.njk, donationpoints.njk has NO address/postcode guard --
  // it prints `{{ address|linebreaksbr }}<br>{{ postcode }}` unconditionally.
  // Alderholt Rooms is a location donation point with both columns NULL, so it
  // renders an <address> holding nothing but a <br>. Django's template does
  // exactly the same, so this is ported behaviour, not a port defect --
  // pinned so that "add the guard from the other template" is a deliberate
  // change rather than an accidental one.
  it("renders an empty address element for a donation-point location with no address at all", async () => {
    const column = listColumn(await body("/needs/at/salisbury/donationpoints/"), "donationpoints");

    expect(column).toMatch(/Alderholt Rooms<\/a>\s*<address>\s*<br>\s*<\/address>/);
  });

  // The food bank's own address block is SUPPRESSED for an administrative
  // address here, where the locations page keeps it under an "Administrative"
  // heading -- an admin office is not somewhere to drop off a bag of food.
  // Django's two templates differ in exactly this way.
  it("omits the food bank's own address entirely when it is administrative", async () => {
    const html = await body("/needs/at/closed-town/donationpoints/");

    expect(listedNames(html, "donationpoints")).toEqual(["Delivery", "Shut Store"]);
    expect(listColumn(html, "donationpoints")).not.toContain("12 High Street");
    expect(listColumn(html, "donationpoints")).toContain("Depot Road<br>Industrial Estate");
  });
});

// The exact statement packages/db's hasServiceArea() used to send, run
// straight at the fixture, wrapped in the counter guard its callers wrapped
// around it -- i.e. Django's Foodbank.has_service_area()
// (givefood/models/foodbank.py:296-302) transcribed:
//
//     def has_service_area(self):
//         if self.no_locations == 0:
//             return False
//         locations = FoodbankLocation.objects.filter(foodbank = self)
//             .exclude(boundary_geojson__isnull = True)
//             .exclude(boundary_geojson = '').count()
//         return locations != 0
//
// This is the ORACLE the derived answer has to match, and it is deliberately
// written as SQL against the same rows rather than as a second copy of the
// route's `.some()`: a JS reimplementation would agree with a JS bug.
function serviceAreaOracle(foodbankId: number): boolean {
  const { no_locations } = db.prepare("SELECT no_locations FROM foodbank WHERE id = ?").get(foodbankId) as { no_locations: number };
  if (no_locations === 0) return false;
  const { n } = db
    .prepare("SELECT COUNT(*) AS n FROM foodbanklocation WHERE foodbank_id = ? AND boundary_geojson IS NOT NULL AND boundary_geojson != ''")
    .get(foodbankId) as { n: number };
  return n > 0;
}

// What the PAGE says its answer is. has_service_area reaches the template
// twice -- nested under `foodbank` for includes/maplegend.njk and bare for
// includes/serviceareadisclaimer.njk -- so both marks are read and required to
// agree with each other. A change that dropped one of the two passes surfaces
// here as a thrown disagreement rather than as a silently half-right page.
function renderedServiceArea(html: string): boolean {
  const legend = html.includes('<div class="deliveryarea"></div>');
  const disclaimer = html.includes('class="serviceareadisclaimer"');
  if (legend !== disclaimer) {
    throw new Error(`the two has_service_area passes disagree: map legend ${legend}, disclaimer ${disclaimer}`);
  }
  return legend;
}

describe("has_service_area -- passed twice, and short-circuited on one page only", () => {
  // hasServiceArea() counts locations with a non-empty boundary_geojson, and
  // the handler passes the result TWICE: nested under `foodbank` (maplegend.njk
  // reads `foodbank.has_service_area`, a level the top-level key never
  // reaches) and bare at the top level (serviceareadisclaimer.njk reads the
  // bare name). Dropping either one silently removes one of the two and leaves
  // the other working -- which is why both strings are asserted every time.
  //
  // NOTE the port and Django read the disclaimer's flag from different places:
  // Django's serviceareadisclaimer.html tests `foodbank.has_service_area`, a
  // model method, so it needs no view-supplied variable at all.
  it("adds both the map legend entry and the disclaimer when a location has a boundary", async () => {
    for (const path of ["/needs/at/salisbury/locations/", "/needs/at/salisbury/donationpoints/"]) {
      const html = await body(path);
      expect(html).toContain('<div class="deliveryarea"></div> Service area<br>');
      expect(html).toContain('<p class="serviceareadisclaimer">Service areas are approximate. You should check with the food bank</p>');
    }
  });

  // A food bank with locations but no boundaries: both pieces disappear.
  // Seeding the removal rather than a boundary-less fixture is the point -- a
  // predicate that stopped testing boundary_geojson would pass any test whose
  // only locations have boundaries.
  it("drops both when no location has a boundary", async () => {
    db.prepare("UPDATE foodbanklocation SET boundary_geojson = NULL WHERE foodbank_id = 1").run();

    const html = await body("/needs/at/salisbury/locations/");
    expect(html).not.toContain("deliveryarea");
    expect(html).not.toContain("serviceareadisclaimer");
  });

  // The empty string is not a boundary. `boundary_geojson != ''` is a separate
  // predicate from the NULL check, and D1 holds both spellings of "no
  // boundary".
  it("treats an empty-string boundary as no boundary", async () => {
    db.prepare("UPDATE foodbanklocation SET boundary_geojson = '' WHERE foodbank_id = 1").run();

    expect(await body("/needs/at/salisbury/donationpoints/")).not.toContain("deliveryarea");
  });

  // THE SHORT CIRCUIT, WHICH IS PARITY AND NOT A BUG -- AND WHICH SURVIVED
  // github #52 DELIBERATELY. Django's has_service_area()
  // (givefood/models/foodbank.py:296-302) returns False immediately when
  // no_locations == 0 without querying, and the donation-points handler still
  // reproduces that, now as `foodbank.no_locations !== 0 && <derived>` rather
  // than as a ternary around a query. Bath's counter says zero while it owns a
  // location WITH a boundary, so the service area is hidden.
  //
  // #52's suggested fix proposed dropping this guard, on the reading that
  // Django's method is "a live query with no such guard" and that a stale zero
  // hiding a real service area would therefore be a CONVERGENCE. The Python
  // above says otherwise -- the counter is checked FIRST -- so dropping it
  // would have been a divergence, and this page would have started claiming a
  // service area that /needs/at/bath/, /needs/at/bath/<locslug>/ and
  // /needs/at/bath/donationpoint/<dpslug>/ all still deny. Those three fetch no
  // location rows of their own, so since #52 item 3 they take the flag -- guard
  // included -- from packages/db's getFoodbankBySlugWithServiceArea.
  //
  // /needs/at/bath/<locslug>/ only joined that list in item 3: its handler used
  // to issue the count UNGUARDED and answer true. That is the one input in the
  // whole of #52 on which a rendered page moves, it is a convergence with the
  // Python above rather than a regression, and it is pinned by
  // locationDetail.test.ts's "hides the service area when the parent's
  // no_locations is 0, even though a location has a boundary". Everywhere else
  // the guard stays put and #52 is a round-trip change that moves no pixel.
  //
  // The same page LISTS that location in its donation-point loop, because that
  // loop reads the table rather than the counter. So one stale integer makes a
  // page that shows a service-area location while denying it has a service
  // area; asserted together, because seeing only one half of it looks like a
  // template bug.
  it("shows nothing when no_locations is zero, while still listing the boundary-bearing location", async () => {
    const html = await body("/needs/at/bath/donationpoints/");

    // The row IS there, and it DOES carry a boundary -- so `false` here is the
    // counter's doing and not an empty result set.
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbanklocation WHERE foodbank_id = 2 AND boundary_geojson != ''").get()).toEqual({ n: 1 });
    expect(renderedServiceArea(html)).toBe(false);
    expect(listedNames(html, "donationpoints")).toEqual(["Main", "Twerton Centre", "Bath Co-op"]);
  });

  // NEITHER PAGE ASKS FOR THE COUNT ANY MORE, AND NEITHER PULLS THE BLOB, on
  // any of the branches the fixture reaches -- including bath, where the count
  // was already skipped, and truro, where it always ran. A revert to
  // hasServiceArea(), or to `SELECT *` for the location rows, would render
  // identically and pass every assertion in this block except this one.
  //
  // THE SECOND LOOP IS NOT "boundary_geojson IS ABSENT" -- it cannot be, since
  // the flag is computed FROM that column and so must name it. What must never
  // happen is the column being SELECTED, i.e. crossing the wire. So the
  // assertion is that wherever the name appears it appears exactly twice, both
  // times inside the has_boundary expression, and nowhere in a `SELECT *` over
  // a table that carries it. Dropping either half of that pair is what a
  // careless edit does, and either half changes the answer for a real stored
  // value ('' on one side, and nothing on the other -- SQLite's `NULL != ''` is
  // UNKNOWN, so that mutant is equivalent and is recorded in the header note).
  it("issues no service-area count on either page, and never lifts the boundary blob out of D1", async () => {
    for (const path of [
      "/needs/at/salisbury/locations/",
      "/needs/at/salisbury/donationpoints/",
      "/needs/at/truro/locations/",
      "/needs/at/truro/donationpoints/",
      "/needs/at/bath/donationpoints/",
      "/cy/needs/at/salisbury/locations/",
    ]) {
      await get(path);
    }

    expect(prepared).not.toHaveLength(0);
    for (const { sql } of prepared) {
      expect(sql).not.toContain("COUNT(*)");
      expect(sql).not.toContain("SELECT * FROM foodbanklocation");
      if (sql.includes("boundary_geojson")) {
        expect(sql.match(/boundary_geojson/g)).toEqual(["boundary_geojson", "boundary_geojson"]);
        expect(sql).toContain("(boundary_geojson IS NOT NULL AND boundary_geojson != '') AS has_boundary");
      }
    }
    // ...and the projection really did reach every one of those pages, rather
    // than the loop above passing vacuously because no location statement was
    // sent at all. All six fetch locations -- the donation-points page needs
    // them for its location_donation_points list, bath included, where the
    // no_locations guard short-circuits only the FLAG and not the query.
    expect(prepared.filter((p) => p.sql === LOCATIONS_SQL)).toHaveLength(6);
  });
});

// ===========================================================================
// THE EQUIVALENCE github #52 RESTS ON
// ===========================================================================

// DERIVING A VALUE IS ONLY FREE IF IT IS THE SAME VALUE. Both handlers used to
// answer has_service_area with packages/db's hasServiceArea() -- `SELECT
// COUNT(*) ... WHERE foodbank_id = ? AND boundary_geojson IS NOT NULL AND
// boundary_geojson != ''` -- and now answer it from the location rows the page
// has already fetched. The two agree by construction:
//
//   SAME ROWS. The count reads `foodbanklocation`; the page reads
//   `foodbanklocation_full`, which migration 0019_drop_foodbank_cache.sql:68
//   defines as `SELECT l.*, ... FROM foodbanklocation l LEFT JOIN foodbank f
//   ON f.id = l.foodbank_id` -- LEFT, onto a primary key, so one output row
//   per input row, and boundary_geojson reaches the view untouched (the page's
//   own projection then reduces it to a flag). Neither side filters is_closed.
//   SAME PREDICATE, and since #52's closing observation the same SQL text on
//   both sides rather than a JS translation of it: `has_boundary` IS
//   `(boundary_geojson IS NOT NULL AND boundary_geojson != '')`, evaluated in
//   SQLite, which is what the count counts.
//   SAME REDUCTION. `COUNT(*) > 0` is `.some()`.
//
// That is an argument. This block is the check -- run the count against the
// same database and compare it with what the page rendered, for every state
// the fixture can be put into. The oracle is SQL, not a second copy of the
// route's JS, so the two sides cannot be wrong together.
describe("the derived flag equals what the COUNT(*) it replaced would have returned", () => {
  // Each case is a food bank plus a mutation, chosen so the ORACLE's answer
  // differs across the set -- one true, four false, for four different
  // reasons. A derivation stuck on a constant passes a one-case test.
  const CASES = [
    { what: "a boundary-bearing location", slug: "salisbury", id: 1, expected: true },
    {
      what: "locations whose boundaries are all NULL",
      slug: "salisbury",
      id: 1,
      expected: false,
      mutate: () => db.prepare("UPDATE foodbanklocation SET boundary_geojson = NULL WHERE foodbank_id = 1").run(),
    },
    {
      what: "an empty-string boundary, which is not a boundary",
      slug: "salisbury",
      id: 1,
      expected: false,
      mutate: () => db.prepare("UPDATE foodbanklocation SET boundary_geojson = '' WHERE foodbank_id = 1").run(),
    },
    {
      // The counter stays at 4, so neither page 404s: `WHERE foodbank_id = ?`
      // simply returns nothing and `.some()` over [] is false, exactly as
      // `COUNT(*) = 0` was.
      what: "no location rows at all behind a non-zero counter",
      slug: "salisbury",
      id: 1,
      expected: false,
      mutate: () => db.prepare("DELETE FROM foodbanklocation WHERE foodbank_id = 1").run(),
    },
    {
      // THE CASE THAT DISCRIMINATES ON is_closed, and the only one that does.
      // NEITHER side filters closed locations -- hasServiceArea's `WHERE
      // foodbank_id = ?` carries no is_closed term and neither does `SELECT *
      // FROM foodbanklocation_full WHERE foodbank_id = ?` -- so a boundary on
      // a SHUT branch is still a service area, and the equivalence depends on
      // that staying true on BOTH sides at once. Every other case here leaves
      // the boundary on an open row, where a `.filter((l) => !l.is_closed)`
      // slipped into the derivation, or an `AND is_closed = 0` added to the
      // query feeding it, changes no answer and survives. Alderholt Rooms
      // (is_closed = 1) is where the fixture's only boundary goes to make that
      // mutant visible -- and it is a donation point too, so both pages read it.
      what: "a boundary on the CLOSED location and nowhere else",
      slug: "salisbury",
      id: 1,
      expected: true,
      mutate: () => {
        db.prepare("UPDATE foodbanklocation SET boundary_geojson = NULL WHERE foodbank_id = 1").run();
        db.prepare("UPDATE foodbanklocation SET boundary_geojson = ? WHERE id = 13").run(BOUNDARY);
      },
    },
    { what: "locations, none of which has a boundary", slug: "truro", id: 3, expected: false },
  ] as const;

  for (const { what, slug, id, expected, mutate } of CASES.map((c) => ({ mutate: undefined, ...c }))) {
    it(`agrees on ${what}, on both pages`, async () => {
      mutate?.();

      // The oracle first, and asserted against a hardcoded expectation, so a
      // fixture edit that quietly made every case false is caught here rather
      // than agreeing with a derivation that had also broken.
      expect(serviceAreaOracle(id)).toBe(expected);

      expect(renderedServiceArea(await body(`/needs/at/${slug}/locations/`))).toBe(expected);
      expect(renderedServiceArea(await body(`/needs/at/${slug}/donationpoints/`))).toBe(expected);
    });
  }

  // THE FIFTH CASE, WHICH ONLY ONE PAGE CAN SHOW. A stale zero in
  // no_locations 404s the locations page outright (that gate is the counter's,
  // not the table's), so bath is only reachable through donationpoints -- and
  // it is the one row where the counter and the table disagree. Both the
  // oracle and the page must return false, which is the guard's doing: the
  // table alone would say true.
  it("agrees on a stale no_locations = 0 hiding a real boundary, where only the donation-points page renders", async () => {
    expect(serviceAreaOracle(2)).toBe(false);
    expect((await get("/needs/at/bath/locations/")).status).toBe(404);

    expect(renderedServiceArea(await body("/needs/at/bath/donationpoints/"))).toBe(false);

    // And the guard is what did it, not an absence of boundary rows: with the
    // counter repaired -- Django's own Foodbank.save() recomputes it -- the
    // same rows now yield true on both sides.
    db.prepare("UPDATE foodbank SET no_locations = 1 WHERE id = 2").run();
    expect(serviceAreaOracle(2)).toBe(true);
    expect(renderedServiceArea(await body("/needs/at/bath/donationpoints/"))).toBe(true);
    expect(renderedServiceArea(await body("/needs/at/bath/locations/"))).toBe(true);
  });
});

describe("map_config -- the string the map JS parses", () => {
  // JSON.stringify of the handler's object, verbatim, and NOT the same object
  // routes/wfbn/foodbank.ts builds: this one has no `max_zoom` key. Both
  // handlers write `geojson` first, so a byte comparison is the honest
  // assertion here.
  it("points the map at this food bank's own geojson, with no bounds when there are none", async () => {
    expect(mapConfigOf(await body("/needs/at/salisbury/locations/"))).toBe('{"geojson":"/needs/at/salisbury/geo.json"}');
    expect(mapConfigOf(await body("/needs/at/salisbury/donationpoints/"))).toBe('{"geojson":"/needs/at/salisbury/geo.json"}');
  });

  // The geojson URL is locale-prefixed, because foodbank_geojson is an
  // i18n_patterns route: a Welsh page fetching the bare URL would work, but
  // would defeat the preload and split the edge cache.
  it("prefixes the geojson url on a locale page", async () => {
    expect(mapConfigOf(await body("/cy/needs/at/salisbury/locations/"))).toBe('{"geojson":"/cy/needs/at/salisbury/geo.json"}');
    expect(mapConfigOf(await body("/gd/needs/at/salisbury/donationpoints/"))).toBe('{"geojson":"/gd/needs/at/salisbury/geo.json"}');
  });

  // All four precomputed bounds, in the key order the handler writes them.
  // These come from the food bank's own service-area geometry and are what
  // stops the map opening on the whole of Great Britain.
  it("adds the precomputed bounds when they exist, on both pages", async () => {
    const expected = '{"geojson":"/needs/at/bounded/geo.json","bounds":{"north":52.5,"south":51.5,"east":-1.5,"west":-2.5}}';
    expect(mapConfigOf(await body("/needs/at/bounded/locations/"))).toBe(expected);
    expect(mapConfigOf(await body("/needs/at/bounded/donationpoints/"))).toBe(expected);
  });

  // THE GATE IS bounds_north ALONE, matching gfwfbn/views.py:569's
  // `if foodbank.bounds_north is not None`. A row with three of the four set
  // gets no bounds key at all -- not a partial one, and not a crash. Pinned
  // because the alternative (checking all four, or checking any) is a
  // reasonable-looking change that alters what a real page does.
  it("emits no bounds when bounds_north alone is missing, even with the other three present", async () => {
    expect(mapConfigOf(await body("/needs/at/half-bounded/locations/"))).toBe('{"geojson":"/needs/at/half-bounded/geo.json"}');
  });

  // A zero bound is a legitimate coordinate -- the Greenwich meridian runs
  // through England, and `bounds_east: 0` is real. `!== null` is what keeps
  // it; a truthiness check would drop the whole bounds block for it.
  it("keeps a bounds block whose north is zero", async () => {
    db.prepare("UPDATE foodbank SET bounds_north = 0, bounds_south = 0, bounds_east = 0, bounds_west = 0 WHERE slug = 'bounded'").run();

    expect(mapConfigOf(await body("/needs/at/bounded/donationpoints/"))).toBe(
      '{"geojson":"/needs/at/bounded/geo.json","bounds":{"north":0,"south":0,"east":0,"west":0}}',
    );
  });
});

describe("the locale-aware half: full_name, the catalogue and the menu", () => {
  // Foodbank.full_name() via @givefood/models' fullNameLocaleAware. Four
  // locales, three different rules, and each page prints the result in the
  // <title>, the <h1>, the breadcrumb and four <meta>s -- so getting it wrong
  // is loud, and getting it wrong in ONE locale is silent to an
  // English-speaking reviewer.
  it("appends Foodbank in English and Irish, translates the word in Welsh and Gaelic", async () => {
    expect(await body("/needs/at/salisbury/locations/")).toContain("<title>Locations - Salisbury Foodbank - Give Food</title>");
    expect(await body("/ga/needs/at/salisbury/locations/")).toContain("Salisbury Foodbank - Give Food</title>");
    expect(await body("/cy/needs/at/salisbury/locations/")).toContain("<title>Lleoliadau - Banc Bwyd Salisbury - Give Food</title>");
    expect(await body("/gd/needs/at/salisbury/donationpoints/")).toContain("Banca-bìdh Salisbury - Give Food</title>");
  });

  // The cy-with-alt_name branch: alt_name wins OUTRIGHT, with no prefix and no
  // suffix. Every other locale ignores alt_name entirely -- including gd,
  // which is the pair most easily conflated with cy.
  it("uses alt_name verbatim in Welsh only", async () => {
    expect(await body("/cy/needs/at/caerdydd/locations/")).toContain("Banc Bwyd Caerdydd - Give Food</title>");
    expect(await body("/needs/at/caerdydd/locations/")).toContain("Caerdydd Foodbank - Give Food</title>");
    expect(await body("/gd/needs/at/caerdydd/locations/")).toContain("Banca-bìdh Caerdydd - Give Food</title>");
  });

  // `prefix` is set by these two templates and NOT by the food bank page,
  // which shares pagetitle.njk with them -- so the h1 here carries a segment
  // the sibling page must not grow.
  it("prefixes the h1 and the breadcrumb with the section name", async () => {
    const html = await body("/needs/at/salisbury/donationpoints/");

    expect(html).toMatch(/<h1>\s*Donation points -\s*Salisbury Foodbank\s*<\/h1>/);
    expect(html).toContain('<li><a href="/needs/at/salisbury/">Salisbury Foodbank</a></li>');
    expect(html).toContain('<li class="is-active"><a href="#" aria-current="page">Donation points</a></li>');
  });

  // The Welsh catalogue really is loaded and really is applied to the section
  // chrome AND to the map legend -- if it were not, every assertion above
  // would still pass on an all-English page.
  it("renders the surrounding page in Welsh, from the real .po catalogue", async () => {
    const html = await body("/cy/needs/at/salisbury/locations/");

    expect(html).toContain('<html lang="cy" dir="ltr"');
    expect(html).toContain('<li class="is-active"><a href="#" aria-current="page">Lleoliadau</a></li>');
    expect(html).toContain('<div class="deliveryarea"></div> Ardal gwasanaeth<br>');
    expect(html).toContain('<p class="serviceareadisclaimer">Mae\'r ardaloedd gwasanaeth yn fras. Dylech wirio gyda\'r banc bwyd</p>');
  });

  // `section` is the only thing distinguishing these two pages' menus, and it
  // is passed as a literal by each handler. Swap the two strings and both
  // pages still render perfectly, with the wrong item highlighted.
  it("marks its own menu entry active and not the sibling's", async () => {
    const locations = await body("/needs/at/salisbury/locations/");
    expect(locations).toContain('<li><a class="is-active" href="/needs/at/salisbury/locations/">Locations</a></li>');
    expect(locations).toContain('<li><a href="/needs/at/salisbury/donationpoints/">Donation points</a></li>');

    const donationpoints = await body("/needs/at/salisbury/donationpoints/");
    expect(donationpoints).toContain('<li><a class="is-active" href="/needs/at/salisbury/donationpoints/">Donation points</a></li>');
    expect(donationpoints).toContain('<li><a href="/needs/at/salisbury/locations/">Locations</a></li>');
  });

  // has_charity_details is CHARITY_DETAIL_COUNTRIES membership, and on these
  // two pages its ONLY visible effect is the menu's Charity entry (the food
  // bank page uses it for a whole panel). Truro HAS a charity_name and still
  // gets no entry, because Jersey has no register page to send anyone to --
  // both halves of `charity_name and has_charity_details` matter.
  it("offers the Charity menu entry only for a country with a register", async () => {
    expect(await body("/needs/at/salisbury/locations/")).toContain('href="/needs/at/salisbury/charity/">Charity</a>');
    expect(await body("/needs/at/truro/locations/")).not.toContain(">Charity</a>");
    expect(await body("/needs/at/truro/donationpoints/")).not.toContain(">Charity</a>");
  });

  // pageTranslatable: true gates BOTH the four hreflang alternates and the
  // whole language switcher. Passing false (or forgetting it) delists three
  // languages from search engines while the page still looks perfect. The
  // alternate URLs are built from pathAfterPrefix, so this also pins that the
  // "/locations/" tail survives the prefix swap.
  it("advertises all four language variants of the same page", async () => {
    const html = await body("/cy/needs/at/salisbury/locations/");

    for (const [code, url] of [
      ["en", "/needs/at/salisbury/locations/"],
      ["cy", "/cy/needs/at/salisbury/locations/"],
      ["ga", "/ga/needs/at/salisbury/locations/"],
      ["gd", "/gd/needs/at/salisbury/locations/"],
    ]) {
      expect(html).toContain(`<link rel="alternate" hreflang="${code}" href="${ORIGIN}${url}">`);
    }
    expect(html).toContain('<div class="langswitcher');
    expect(html).toContain('<link rel="canonical" href="https://www.givefood.org.uk/cy/needs/at/salisbury/locations/">');
  });

  // Every in-page link is built through render()'s locale-bound url(), so the
  // whole page stays inside the locale a visitor chose. One hardcoded path
  // here would drop them back into English mid-journey.
  it("prefixes every in-site link on a locale page", async () => {
    const html = await body("/cy/needs/at/salisbury/donationpoints/");

    expect(html).toContain('<a href="/cy/needs/at/salisbury/donationpoint/tesco-extra/">Tesco Extra</a>');
    expect(html).toContain('<a href="/cy/needs/at/salisbury/amesbury/">Amesbury Centre</a>');
    expect(html).toContain('<li><a href="/cy/needs/at/salisbury/">Manylion</a></li>');
  });

  // "en" is never a URL prefix (prefix_default_language=False in Django, and
  // resolveLanguage's PREFIXES set excludes it), and an unrecognised prefix is
  // not a locale at all -- so neither is a second spelling of these pages.
  it("does not answer under /en/ or an unsupported language prefix", async () => {
    expect((await get("/en/needs/at/salisbury/locations/")).status).toBe(404);
    expect((await get("/de/needs/at/salisbury/locations/")).status).toBe(404);
    expect((await get("/en/needs/at/salisbury/donationpoints/")).status).toBe(404);
    expect((await get("/pl/needs/at/salisbury/donationpoints/")).status).toBe(404);
  });
});
