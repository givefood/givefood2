import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "@givefood/db/src/schema.testkit";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/api2/foodbanks.ts's detail endpoint -- GET /api/2/foodbank/<slug>/,
// ported from gfapi2/views.py's `foodbank`. The two sibling endpoints on the
// same router (`foodbanks`, `foodbanks/search/`) are untouched by this work
// and are not covered here.
//
// WHY THIS FILE EXISTS (github #49). This handler was issuing FIVE sequential
// D1 round trips where three would do, and D1 round trips are the whole cost
// of this page: every statement on the path is index-covered (EXPLAIN QUERY
// PLAN against production: foodbank_slug_uniq, loc_foodbank_slug_idx, INTEGER
// PRIMARY KEY, foodbank_open_latlng_idx), so the wall clock is network wait,
// not SQL. Measured against production by interleaving cache-busted json and
// geojson requests for the same slug -- the geojson branch skips the three
// nearby-food-bank trips, so the pair is a clean contrast -- and reading the
// Worker's own `Server-Timing: render`, which on Workers only advances at I/O
// boundaries: hackney 138 ms json vs 68 ms geojson (n=10), canterbury 192 vs
// 108 (n=12), i.e. 23-28 ms per round trip. The locations query was also
// `SELECT *` over foodbanklocation_full, whose boundary_geojson column is 2.30
// MB on canterbury alone and which NEITHER branch of this handler reads.
//
// THE CLAIM THAT HAS TO BE DEFENDED IS "NO RESPONSE BYTE MOVED", and the only
// honest way to defend it is to assert the WHOLE BODY of both formats. Nothing
// here is a smoke test: every field below is read off a column that a
// hand-written projection could silently omit or that a reordered query could
// silently reshuffle, and neither failure throws -- one publishes `null`, the
// other publishes a different food bank's neighbours in a different order.
//
// THIS FILE WAS WRITTEN BEFORE THE RESTRUCTURE AND RUN GREEN AGAINST THE
// FIVE-ROUND-TRIP, `SELECT *` VERSION FIRST, then re-run against the batched,
// projected one -- with only the two round-trip counts changed. That order is
// the whole evidence: an expectation written after a change can only say what
// the code now does, not that it still does what it did.
//
// REAL EVERYTHING (real app, real router, real migrations), same harness as
// routes/api2/locations.test.ts and routes/api2/donationpoints.test.ts, plus a
// batch() the two of them never needed.
//
// MUTATION-TESTED (TESTING.md's convention). The handler, packages/db's
// foodbank.ts, foodbankDetail.ts and locations.ts were copied to a scratchpad
// -- never edited in place -- broken one way at a time, and this file re-run
// against each break. Caught: both batches unrolled into sequential awaits;
// the candidate scan hoisted so geojson pays for it, and separately gated off
// entirely; the candidate rows read from the wrong batch index, and thrown
// away; the locations projection reverted to `SELECT *`; skip_first dropped
// from Foodbank.nearby(); the ranked ids never reaching the second wave, and
// sorted numerically before it.
//
// THAT LAST ONE SURVIVED THE FIRST VERSION OF THIS FILE, which is why the
// neighbour ids below run backwards -- see the note on NEIGHBOURS. One
// equivalent mutant is recorded rather than chased: swapping R_PYTHON for
// R_EARTHDISTANCE cannot be caught here, and no test should pretend to. The
// radius is a pure multiplier on haversineMeters, so it can only scale
// distances, never reorder them, and this endpoint publishes no distance for a
// nearby food bank. It is observable on /api/2/foodbanks/search/, which does.

const ORIGIN = "https://www.givefood.org.uk";

type Bindable = null | number | bigint | string | Uint8Array;

// The harness's one addition over its two siblings: this endpoint's whole
// point is HOW MANY TIMES it waits for D1, and a statement count cannot see
// that -- batch() executes N statements in ONE network wait. `roundTrips`
// therefore counts waits (a batch is 1, a lone all()/first() is 1) while
// `prepared` goes on counting statements, and the two are recorded
// independently so neither can paper over the other.
//
// batch() runs its statements IN ORDER and returns one result per input, in
// that order -- the contract packages/db indexes straight into. Deliberately
// dumb otherwise: it never inspects or rewrites SQL, it hands each statement
// to real SQLite.
function d1Session(db: DatabaseSync, prepared: string[], roundTrips: string[][]): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    sql,
    params,
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => {
      roundTrips.push([sql]);
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    all: async () => {
      roundTrips.push([sql]);
      return { results: db.prepare(sql).all(...params), success: true, meta: {} };
    },
    run: async () => {
      roundTrips.push([sql]);
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return {
    prepare: (sql: string) => {
      prepared.push(sql);
      // A seam for simulating a row that vanishes MID-REQUEST -- see the
      // github #48 test at the bottom of this file. Null except there, and
      // reset in beforeEach.
      onPrepare?.(sql);
      return statement(sql, []);
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
let prepared: string[];
let roundTrips: string[][];
let onPrepare: ((sql: string) => void) | null = null;

function env(): AppEnv["Bindings"] {
  return {
    DB: { withSession: () => d1Session(db, prepared, roundTrips) },
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: { get: async () => null, put: async () => {}, delete: async () => {} },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

const get = (path: string) => app.fetch(new Request(`${ORIGIN}${path}`), env(), execCtx);

// ===========================================================================
// SEEDS
// ===========================================================================

// Django's own format, from 0022_normalise_timestamps.sql: six fractional
// digits, space separator, no offset. DjangoJSONEncoder renders it truncated
// to milliseconds, which is what the `created` assertions below expect.
const CREATED = "2020-01-24 16:30:23.173268";
const MODIFIED = "2026-08-14 09:15:00.000000";

// A real stored boundary shape. The production ones run to ~1.6 MB; nothing
// here needs the size, only that its absence from the body is unambiguous and
// its presence would be obvious.
const BOUNDARY = '{"type":"Polygon","coordinates":[[[-1.9,51.0],[-1.7,51.0],[-1.7,51.1],[-1.9,51.0]]]}';

const uuidFor = (prefix: string, id: number): string => (prefix + String(id).padStart(31, "0")).slice(0, 32);

interface FoodbankSeed {
  id: number;
  slug: string;
  name: string;
  latitude: number;
  longitude: number;
  isClosed?: 0 | 1;
  latestNeedId?: number | null;
  charityNumber?: string | null;
  altName?: string | null;
  // The `lat_lng` STRING, when it must differ from the latitude/longitude
  // COLUMNS. Defaults to "<latitude>,<longitude>", which is what every other
  // row here wants -- see the WONKY seed for the one case that does not, and
  // for why a fixture where they always agree cannot see which one the
  // handler reads.
  latLng?: string;
}

function seedFoodbank(s: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank
       (id, uuid, name, alt_name, slug, address, postcode, country, lat_lng, latitude, longitude,
        delivery_address, delivery_lat_lng, network, charity_number, contact_email,
        phone_number, secondary_phone_number, url, shopping_list_url,
        parliamentary_constituency_id, parliamentary_constituency_name, parliamentary_constituency_slug,
        mp, mp_party, mp_parl_id, ward, district,
        charity_just_foodbank, address_is_administrative, is_closed, no_locations, days_between_needs,
        latest_need_id, created, modified)
     VALUES (?, ?, ?, ?, ?, '1 High Street', 'SP1 1AA', 'England', ?, ?, ?,
        '2 Depot Way', '51.0700,-1.8000', 'Trussell Trust', ?, ?,
        '01722 411900', '01722 411901', ?, ?,
        41, 'Salisbury', 'salisbury',
        'John Glen', 'Conservative', 4051, 'Bemerton Ward', 'Salisbury District',
        0, 0, ?, 0, 14,
        ?, ?, ?)`,
  ).run(
    s.id,
    uuidFor("f", s.id),
    s.name,
    s.altName === undefined ? null : s.altName,
    s.slug,
    s.latLng ?? `${s.latitude},${s.longitude}`,
    s.latitude,
    s.longitude,
    s.charityNumber === undefined ? "1130136" : s.charityNumber,
    `info@${s.slug}.invalid`,
    `https://${s.slug}.invalid/`,
    `https://${s.slug}.invalid/list/`,
    s.isClosed ?? 0,
    s.latestNeedId === undefined ? null : s.latestNeedId,
    CREATED,
    MODIFIED,
  );
}

function seedNeed(id: number, foodbankId: number, changeText: string, excess: string | null): void {
  db.prepare(
    `INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, excess_change_text,
       published, input_method, created, modified)
     VALUES (?, ?, ?, ?, ?, 1, 'scrape', ?, ?)`,
  ).run(id, uuidFor("n", id), foodbankId, changeText, excess, CREATED, MODIFIED);
}

interface LocationSeed {
  id: number;
  foodbankId: number;
  slug: string;
  name: string;
  latitude: number;
  longitude: number;
  isClosed?: 0 | 1;
  isDonationPoint?: 0 | 1 | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  postcode?: string | null;
}

// Every column the ETL writes, including the ones neither branch of this
// handler may publish: boundary_geojson (the 2.3 MB blob the projection
// drops), place_id, plus_code_*, lsoa/msoa, county, is_mobile and the
// timestamps are all filled with recognisable values so a body that leaks one
// says so by name.
function seedLocation(l: LocationSeed): void {
  db.prepare(
    `INSERT INTO foodbanklocation
       (id, uuid, foodbank_id, name, slug, address, postcode, country, lat_lng, latitude, longitude,
        place_id, plus_code_compound, plus_code_global, place_has_photo,
        county, district, ward, lsoa, msoa,
        parliamentary_constituency_id, parliamentary_constituency_name, parliamentary_constituency_slug,
        mp, mp_party, mp_parl_id,
        is_closed, is_donation_point, is_mobile, boundary_geojson,
        phone_number, email, modified, edited)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'England', ?, ?, ?,
        'ChIJdd4hrwug2EcRmSrV3Vo6llI', 'PLUSCODECOMPOUND', 'PLUSCODEGLOBAL', 1,
        'Wiltshire', 'Salisbury LocDistrict', 'Bemerton LocWard', 'E01032015', 'E02006697',
        41, 'Salisbury', 'salisbury',
        'John Glen', 'Conservative', 9999,
        ?, ?, 1, ?,
        ?, ?, ?, '2026-08-15 10:00:00.000000')`,
  ).run(
    l.id,
    uuidFor("l", l.id),
    l.foodbankId,
    l.name,
    l.slug,
    l.address === undefined ? "10 Church Lane" : l.address,
    l.postcode === undefined ? "SP2 7RB" : l.postcode,
    `${l.latitude},${l.longitude}`,
    l.latitude,
    l.longitude,
    l.isClosed ?? 0,
    l.isDonationPoint === undefined ? 0 : l.isDonationPoint,
    BOUNDARY,
    l.phone === undefined ? "01722 222222" : l.phone,
    l.email === undefined ? "loc@salisbury.invalid" : l.email,
    MODIFIED,
  );
}

interface DonationPointSeed {
  id: number;
  foodbankId: number;
  slug: string;
  name: string;
  latitude: number;
  longitude: number;
  isClosed?: 0 | 1;
  wheelchairAccessible?: 0 | 1 | null;
}

function seedDonationPoint(d: DonationPointSeed): void {
  db.prepare(
    `INSERT INTO foodbankdonationpoint
       (id, uuid, foodbank_id, name, slug, address, postcode, country, lat_lng, latitude, longitude,
        place_id, plus_code_compound, plus_code_global, place_has_photo,
        county, district, ward, lsoa, msoa,
        parliamentary_constituency_id, parliamentary_constituency_name, parliamentary_constituency_slug,
        mp, mp_party, mp_parl_id,
        is_closed, in_store_only, phone_number, url, opening_hours, wheelchair_accessible,
        company, company_slug, store_id, notes, modified)
     VALUES (?, ?, ?, ?, ?, '12 Castle Street', 'SP1 3TA', 'England', ?, ?, ?,
        'ChIJ68J3tUsbdkgRDVK5UPlkX4A', 'DPPLUSCOMPOUND', 'DPPLUSGLOBAL', 1,
        'Wiltshire', 'Salisbury DpDistrict', 'Bemerton DpWard', 'E01032099', 'E02006699',
        41, 'Salisbury', 'salisbury',
        'John Glen', 'Conservative', 4242,
        ?, 0, '01722 333333', 'https://tesco.invalid/store/', 'Mon-Sat 08:00-20:00', ?,
        'Tesco Stores Ltd', 'tesco', 'STORE-4471', 'Internal note, never published', ?)`,
  ).run(
    d.id,
    uuidFor("d", d.id),
    d.foodbankId,
    d.name,
    d.slug,
    `${d.latitude},${d.longitude}`,
    d.latitude,
    d.longitude,
    d.isClosed ?? 0,
    d.wheelchairAccessible === undefined ? null : d.wheelchairAccessible,
    MODIFIED,
  );
}

const SALISBURY_LAT = 51.0688;
const SALISBURY_LNG = -1.7945;

// Twelve neighbours on the same parallel at rising longitude, so the haversine
// ranking is strictly monotonic in seed order and no assertion below depends
// on a tie-break. Two of them exist only to be cut: `nearest(..., 10, ...)`
// with skip_first drops index 0 (Salisbury itself, at distance 0) and then
// takes ten, so nb-11 and nb-12 must not appear.
//
// THE IDS RUN BACKWARDS -- nearest is 29, furthest is 18 -- and that is the
// whole reason they are written as `29 - i` rather than `10 + i`. D1 answers
// `WHERE id IN (...)` in rowid order, so the ranked order has to be restored
// in JavaScript afterwards (mapFoodbanksByIds). Seed the obvious way, with the
// nearest neighbour holding the lowest id, and the two orders coincide: the
// re-sort becomes a no-op and deleting it passes every assertion here. That
// was not hypothetical -- the first version of this file seeded 10 + i, and a
// mutant that sorted the ranked ids numerically before fetching them survived
// it. Now it cannot.
const NEIGHBOURS = Array.from({ length: 12 }, (_, i) => ({
  id: 29 - i,
  slug: `nb-${i + 1}`,
  name: `Neighbour ${i + 1}`,
  latitude: SALISBURY_LAT,
  longitude: SALISBURY_LNG + 0.01 * (i + 1),
}));

function seed(): void {
  seedFoodbank({
    id: 1,
    slug: "salisbury",
    name: "Salisbury",
    altName: "Banc Bwyd Caersallog",
    latitude: SALISBURY_LAT,
    longitude: SALISBURY_LNG,
    latestNeedId: 500,
  });
  seedNeed(500, 1, "Tinned tomatoes\r\nUHT milk", "Baked beans");

  // Deliberately seeded so that neither table's incoming order is its output
  // order: both lists are name-sorted by packages/db (Django's own
  // `.order_by("name")`), and a lost sort would show up here rather than in a
  // test that happened to seed alphabetically.
  seedLocation({ id: 20, foodbankId: 1, slug: "wilton-road", name: "Wilton Road Centre", latitude: 51.08, longitude: -1.82 });
  seedLocation({
    id: 21,
    foodbankId: 1,
    slug: "amesbury",
    name: "Amesbury Library",
    latitude: 51.17,
    longitude: -1.78,
    isDonationPoint: 1,
    phone: null,
    email: null,
  });
  seedLocation({
    id: 22,
    foodbankId: 1,
    slug: "closed-annexe",
    name: "Closed Annexe",
    latitude: 51.09,
    longitude: -1.75,
    isClosed: 1,
    address: null,
    postcode: null,
  });

  seedDonationPoint({ id: 30, foodbankId: 1, slug: "tesco-extra", name: "Tesco Extra", latitude: 51.065, longitude: -1.79 });
  seedDonationPoint({
    id: 31,
    foodbankId: 1,
    slug: "coop-wilton",
    name: "Co-op Wilton",
    latitude: 51.077,
    longitude: -1.86,
    wheelchairAccessible: 1,
  });

  // Only SOME neighbours carry a latest need, so the third round trip's
  // de-duplicated id list is a real subset rather than "all of them" -- and so
  // a mutant that fetched needs for every row, or for none, is distinguishable.
  const withNeeds = new Set(["nb-1", "nb-4", "nb-9"]);
  for (const n of NEIGHBOURS) seedFoodbank({ ...n, latestNeedId: withNeeds.has(n.slug) ? 600 + n.id : null });
  for (const n of NEIGHBOURS.filter((x) => withNeeds.has(x.slug))) seedNeed(600 + n.id, n.id, `Need for ${n.slug}`, null);

  // Closer than every neighbour above, and closed -- so it can only appear if
  // the candidate query stops filtering `is_closed = 0`. It carries a need of
  // its own because frozen bug B12 dereferences latest_need unguarded, so a
  // closed food bank without one 500s here exactly as it does in Django.
  seedFoodbank({
    id: 90,
    slug: "shut-foodbank",
    name: "Shut",
    latitude: SALISBURY_LAT,
    longitude: SALISBURY_LNG + 0.001,
    isClosed: 1,
    latestNeedId: 590,
  });
  seedNeed(590, 90, "Nothing", null);

  // THE ONE ROW WHOSE `lat_lng` AND latitude/longitude DISAGREE. Every other
  // food bank here is seeded with lat_lng derived from the two columns, which
  // is faithful to production but makes "which of the two does the ranking
  // read?" unanswerable -- and the answer is load-bearing: PLAN.md §7.2
  // records that the string and the columns can and do disagree on real rows,
  // and Foodbank.nearby() splits the STRING (parseLatLng), matching
  // find_foodbanks(self.lat_lng, ...). #49 hoisted that parseLatLng call out
  // of the json branch and above the second wave, so the line moved; without
  // this row, swapping it for `foodbank.latitude/longitude` passes every
  // assertion in this file.
  //
  // Closed, so it can never enter anyone else's candidate set and none of the
  // expectations above move. Its columns sit at +0.20, past all twelve
  // neighbours, while its lat_lng string is Salisbury's exact position -- so
  // reading the columns instead would rank the neighbours from the far end and
  // return them in the opposite order. It carries a need for B12's sake.
  seedFoodbank({
    id: 91,
    slug: "wonky-latlng",
    name: "Wonky",
    latitude: SALISBURY_LAT,
    longitude: SALISBURY_LNG + 0.2,
    latLng: `${SALISBURY_LAT},${SALISBURY_LNG}`,
    isClosed: 1,
    latestNeedId: 591,
  });
  seedNeed(591, 91, "Nothing", null);
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  prepared = [];
  roundTrips = [];
  onPrepare = null;
  seed();
});

// The nearby list, in the order the ranking must produce it. Written out
// rather than derived from NEIGHBOURS so that a change to the ranking, the
// slice or the id-order re-sort inside getFoodbanksByIds cannot quietly
// rewrite the expectation along with the code.
const NEARBY_SLUGS = ["nb-1", "nb-2", "nb-3", "nb-4", "nb-5", "nb-6", "nb-7", "nb-8", "nb-9", "nb-10"];

const nearbyEntry = (slug: string, name: string) => ({
  name,
  slug,
  urls: {
    self: `${ORIGIN}/api/2/foodbank/${slug}/`,
    html: `${ORIGIN}/needs/at/${slug}/`,
    homepage: `https://${slug}.invalid/`,
    shopping_list: `https://${slug}.invalid/list/`,
  },
  address: "1 High Street\r\nSP1 1AA",
  lat_lng: `${SALISBURY_LAT},${SALISBURY_LNG + 0.01 * (NEARBY_SLUGS.indexOf(slug) + 1)}`,
});

// ===========================================================================
// THE BODY
// ===========================================================================

describe("GET /api/2/foodbank/<slug>/", () => {
  // THE WHOLE JSON BODY. Frozen bugs B2 (a location's mp_parl_id is the
  // PARENT's, 9999 never appears), B9 (no top-level `country`, no
  // `politics.mp_parl_id`) and B10 (`need.created`, not `need.found`) are all
  // asserted here by being written into the expectation exactly as the handler
  // emits them -- this endpoint's parity with Django is these details.
  it("returns the documented json body, field for field", async () => {
    const res = await get("/api/2/foodbank/salisbury/");

    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toEqual({
      id: "f0000000-0000-0000-0000-000000000001",
      name: "Salisbury",
      alt_name: "Banc Bwyd Caersallog",
      slug: "salisbury",
      phone: "01722 411900",
      secondary_phone: "01722 411901",
      email: "info@salisbury.invalid",
      address: "1 High Street\r\nSP1 1AA",
      postcode: "SP1 1AA",
      closed: false,
      lat_lng: "51.0688,-1.7945",
      network: "Trussell Trust",
      created: "2020-01-24T16:30:23.173",
      urls: {
        self: `${ORIGIN}/api/2/foodbank/salisbury/`,
        html: `${ORIGIN}/needs/at/salisbury/`,
        homepage: "https://salisbury.invalid/",
        shopping_list: "https://salisbury.invalid/list/",
        map: `${ORIGIN}/needs/at/salisbury/map.png`,
      },
      charity: {
        registration_id: "1130136",
        register_url: "https://register-of-charities.charitycommission.gov.uk/charity-details/?regid=1130136&subid=0",
      },
      delivery_address: "2 Depot Way",
      delivery_lat_lng: "51.0700,-1.8000",
      locations: [
        {
          id: "l0000000-0000-0000-0000-000000000021",
          name: "Amesbury Library",
          slug: "amesbury",
          address: "10 Church Lane\r\nSP2 7RB",
          postcode: "SP2 7RB",
          lat_lng: "51.17,-1.78",
          phone: null,
          is_donation_point: true,
          politics: {
            parliamentary_constituency: "Salisbury",
            mp: "John Glen",
            mp_party: "Conservative",
            mp_parl_id: 4051,
            ward: "Bemerton LocWard",
            district: "Salisbury LocDistrict",
            urls: {
              self: `${ORIGIN}/api/2/constituency/salisbury/`,
              html: `${ORIGIN}/needs/in/constituency/salisbury/`,
            },
          },
        },
        {
          id: "l0000000-0000-0000-0000-000000000022",
          name: "Closed Annexe",
          slug: "closed-annexe",
          address: "",
          postcode: null,
          lat_lng: "51.09,-1.75",
          phone: "01722 222222",
          is_donation_point: false,
          politics: {
            parliamentary_constituency: "Salisbury",
            mp: "John Glen",
            mp_party: "Conservative",
            mp_parl_id: 4051,
            ward: "Bemerton LocWard",
            district: "Salisbury LocDistrict",
            urls: {
              self: `${ORIGIN}/api/2/constituency/salisbury/`,
              html: `${ORIGIN}/needs/in/constituency/salisbury/`,
            },
          },
        },
        {
          id: "l0000000-0000-0000-0000-000000000020",
          name: "Wilton Road Centre",
          slug: "wilton-road",
          address: "10 Church Lane\r\nSP2 7RB",
          postcode: "SP2 7RB",
          lat_lng: "51.08,-1.82",
          phone: "01722 222222",
          is_donation_point: false,
          politics: {
            parliamentary_constituency: "Salisbury",
            mp: "John Glen",
            mp_party: "Conservative",
            mp_parl_id: 4051,
            ward: "Bemerton LocWard",
            district: "Salisbury LocDistrict",
            urls: {
              self: `${ORIGIN}/api/2/constituency/salisbury/`,
              html: `${ORIGIN}/needs/in/constituency/salisbury/`,
            },
          },
        },
      ],
      donationpoints: [
        {
          id: "d0000000-0000-0000-0000-000000000031",
          name: "Co-op Wilton",
          slug: "coop-wilton",
          address: "12 Castle Street\r\nSP1 3TA",
          postcode: "SP1 3TA",
          lat_lng: "51.077,-1.86",
          phone: "01722 333333",
          url: "https://tesco.invalid/store/",
          opening_hours: "Mon-Sat 08:00-20:00",
          wheelchair_accessible: true,
          politics: {
            parliamentary_constituency: "Salisbury",
            mp: "John Glen",
            mp_party: "Conservative",
            mp_parl_id: 4242,
            ward: "Bemerton DpWard",
            district: "Salisbury DpDistrict",
            urls: {
              self: `${ORIGIN}/api/2/constituency/salisbury/`,
              html: `${ORIGIN}/needs/in/constituency/salisbury/`,
            },
          },
        },
        {
          id: "d0000000-0000-0000-0000-000000000030",
          name: "Tesco Extra",
          slug: "tesco-extra",
          address: "12 Castle Street\r\nSP1 3TA",
          postcode: "SP1 3TA",
          lat_lng: "51.065,-1.79",
          phone: "01722 333333",
          url: "https://tesco.invalid/store/",
          opening_hours: "Mon-Sat 08:00-20:00",
          // Tri-state, never coalesced: this row's column is NULL.
          wheelchair_accessible: null,
          politics: {
            parliamentary_constituency: "Salisbury",
            mp: "John Glen",
            mp_party: "Conservative",
            mp_parl_id: 4242,
            ward: "Bemerton DpWard",
            district: "Salisbury DpDistrict",
            urls: {
              self: `${ORIGIN}/api/2/constituency/salisbury/`,
              html: `${ORIGIN}/needs/in/constituency/salisbury/`,
            },
          },
        },
      ],
      politics: {
        parliamentary_constituency: "Salisbury",
        mp: "John Glen",
        mp_party: "Conservative",
        ward: "Bemerton Ward",
        district: "Salisbury District",
        urls: {
          self: `${ORIGIN}/api/2/constituency/salisbury/`,
          html: `${ORIGIN}/needs/in/constituency/salisbury/`,
        },
      },
      need: {
        id: "n0000000-0000-0000-0000-000000000500",
        needs: "Tinned tomatoes\r\nUHT milk",
        excess: "Baked beans",
        created: "2020-01-24T16:30:23.173",
        self: `${ORIGIN}/api/2/need/n0000000-0000-0000-0000-000000000500/`,
      },
      nearby_foodbanks: NEARBY_SLUGS.map((slug, i) => nearbyEntry(slug, `Neighbour ${i + 1}`)),
    });
  });

  // THE WHOLE GEOJSON BODY. A different set of columns off the same two lists
  // -- foodbank_slug, foodbank_network, foodbank_email and
  // foodbank_phone_number reach a location row through the view's LEFT JOIN
  // rather than off the row itself, so a projection that drops them publishes
  // nulls here while the json branch above stays perfectly green.
  it("returns the documented geojson body, feature for feature", async () => {
    const res = await get("/api/2/foodbank/salisbury/?format=geojson");

    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toEqual({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-1.7945, 51.0688] },
          properties: {
            name: "Salisbury",
            slug: "salisbury",
            address: "1 High Street\r\nSP1 1AA",
            url: `${ORIGIN}/needs/at/salisbury/`,
            network: "Trussell Trust",
            email: "info@salisbury.invalid",
            telephone: "01722 411900",
            parliamentary_constituency: "Salisbury",
          },
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-1.78, 51.17] },
          properties: {
            name: "Amesbury Library",
            slug: "amesbury",
            address: "10 Church Lane\r\nSP2 7RB",
            url: `${ORIGIN}/needs/at/salisbury/amesbury/`,
            network: "Trussell Trust",
            // Both fall back through the view's join: this row's own email and
            // phone_number are NULL.
            email: "info@salisbury.invalid",
            telephone: "01722 411900",
            parliamentary_constituency: "Salisbury",
            is_donation_point: true,
          },
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-1.75, 51.09] },
          properties: {
            name: "Closed Annexe",
            slug: "closed-annexe",
            address: "",
            url: `${ORIGIN}/needs/at/salisbury/closed-annexe/`,
            network: "Trussell Trust",
            email: "loc@salisbury.invalid",
            telephone: "01722 222222",
            parliamentary_constituency: "Salisbury",
            is_donation_point: false,
          },
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-1.82, 51.08] },
          properties: {
            name: "Wilton Road Centre",
            slug: "wilton-road",
            address: "10 Church Lane\r\nSP2 7RB",
            url: `${ORIGIN}/needs/at/salisbury/wilton-road/`,
            network: "Trussell Trust",
            email: "loc@salisbury.invalid",
            telephone: "01722 222222",
            parliamentary_constituency: "Salisbury",
            is_donation_point: false,
          },
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-1.86, 51.077] },
          properties: {
            name: "Co-op Wilton",
            slug: "coop-wilton",
            address: "12 Castle Street\r\nSP1 3TA",
            url: `${ORIGIN}/needs/at/salisbury/donationpoint/coop-wilton/`,
            web: "https://tesco.invalid/store/",
            network: "Trussell Trust",
            telephone: "01722 333333",
            opening_hours: "Mon-Sat 08:00-20:00",
            wheelchair_accessible: true,
            parliamentary_constituency: "Salisbury",
            is_donation_point: true,
          },
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-1.79, 51.065] },
          properties: {
            name: "Tesco Extra",
            slug: "tesco-extra",
            address: "12 Castle Street\r\nSP1 3TA",
            url: `${ORIGIN}/needs/at/salisbury/donationpoint/tesco-extra/`,
            web: "https://tesco.invalid/store/",
            network: "Trussell Trust",
            telephone: "01722 333333",
            opening_hours: "Mon-Sat 08:00-20:00",
            wheelchair_accessible: null,
            parliamentary_constituency: "Salisbury",
            is_donation_point: true,
          },
        },
      ],
    });
  });

  it("sets the day-long public cache headers and the CORS header", async () => {
    const res = await get("/api/2/foodbank/salisbury/");

    expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400, s-maxage=86400");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  // The same handler is mounted at both /api/2 and /api, and every "self" URL
  // it emits is hardcoded to /api/2 regardless -- verified against the Python
  // source, which does not derive them from the request path either.
  it("serves the identical body from the /api mount point", async () => {
    const two = await (await get("/api/2/foodbank/salisbury/")).text();
    const one = await (await get("/api/foodbank/salisbury/")).text();

    expect(one).toBe(two);
  });

  it("404s an unknown slug", async () => {
    expect((await get("/api/2/foodbank/no-such-foodbank/")).status).toBe(404);
  });

  // THE FIXTURE'S OWN GUARD, in the spirit of foodbankDetail.test.ts's slug
  // note. `nearby_foodbanks` order is asserted inside a whole-body toEqual
  // above, which is only load-bearing while the ranked order DIFFERS from the
  // id order D1 hands the rows back in. Seed the neighbours the obvious way and
  // the two coincide, the re-sort becomes a no-op, and deleting it passes
  // everything. This says so out loud instead of letting it rot silently.
  it("is seeded so that ranked order and id order genuinely disagree", () => {
    const rankedIds = NEARBY_SLUGS.map((slug) => NEIGHBOURS.find((n) => n.slug === slug)!.id);

    expect(rankedIds).not.toEqual([...rankedIds].sort((a, b) => a - b));
    expect(rankedIds).toEqual([...rankedIds].sort((a, b) => b - a));
  });

  it("serves a closed food bank by slug, and never ranks one into nearby_foodbanks", async () => {
    const closed = JSON.parse(await (await get("/api/2/foodbank/shut-foodbank/")).text()) as { closed: boolean };
    expect(closed.closed).toBe(true);

    const body = await (await get("/api/2/foodbank/salisbury/")).text();
    expect(body).not.toContain("shut-foodbank");
  });

  // Foodbank.nearby() is find_foodbanks(self.lat_lng, 10, True) -- the STRING,
  // split by parseLatLng, not the latitude/longitude columns, which PLAN.md
  // §7.2 records as able to disagree with it. #49 moved that call out of the
  // json branch and above the second wave; this is what stops the move from
  // silently becoming a swap. See the WONKY seed: its columns are 0.2° east of
  // its lat_lng, so the two readings rank the same twelve neighbours in
  // opposite directions.
  it("ranks nearby_foodbanks from lat_lng, not from the latitude/longitude columns", async () => {
    const body = JSON.parse(await (await get("/api/2/foodbank/wonky-latlng/")).text()) as {
      lat_lng: string;
      nearby_foodbanks: Array<{ slug: string }>;
    };

    // The divergence is real in the fixture, not just asserted about.
    expect(body.lat_lng).toBe(`${SALISBURY_LAT},${SALISBURY_LNG}`);
    // Ranked from that position: Salisbury itself is at distance 0 and is what
    // skip_first drops, leaving the ten nearest neighbours in order. Reading
    // the columns instead would drop nb-12 and return nb-11 .. nb-2.
    expect(body.nearby_foodbanks.map((f) => f.slug)).toEqual(NEARBY_SLUGS);
  });
});

// ===========================================================================
// THE CHANGE ITSELF
// ===========================================================================

// Everything above is equally true of the five-round-trip `SELECT *` version
// this replaced -- that is exactly why this file was run green against it
// first -- so the fix is invisible without counting the waits and reading the
// statement that reached the engine.
describe("the round trips", () => {
  // Was FIVE: the slug+need batch, the locations/donation-points batch, the
  // open-coordinate scan, the nearby food banks, and their needs. The first
  // three collapse into two batches; the needs lookup is genuinely dependent
  // on the second and stays.
  it("waits for D1 three times on a json request, not five", async () => {
    await get("/api/2/foodbank/salisbury/");

    expect(roundTrips).toHaveLength(3);
    // Wave 1: the food bank, its need, and the open-food-bank candidate set.
    expect(roundTrips[0]).toHaveLength(3);
    // Wave 2: its locations, its donation points, and the ranked neighbours.
    expect(roundTrips[1]).toHaveLength(3);
    // Wave 3: the neighbours' latest needs, which cannot be known until wave 2
    // comes back.
    expect(roundTrips[2]).toHaveLength(1);
  });

  // The geojson branch reads no neighbours at all, so the coordinate scan must
  // NOT be batched into its first wave -- hoisting it unconditionally would
  // add a 1,024-row scan to every geojson request to save nothing.
  it("waits for D1 twice on a geojson request, and never scans the open food banks", async () => {
    await get("/api/2/foodbank/salisbury/?format=geojson");

    expect(roundTrips).toHaveLength(2);
    expect(roundTrips[0]).toHaveLength(2);
    expect(roundTrips[1]).toHaveLength(2);
    expect(prepared.filter((sql) => sql.includes("latitude, longitude FROM foodbank WHERE is_closed = 0"))).toHaveLength(0);
  });

  // THE PROJECTION. boundary_geojson is 2.30 MB on one production food bank
  // and neither branch of this handler mentions it.
  it("reads the locations through a named column list, not SELECT *", async () => {
    await get("/api/2/foodbank/salisbury/");

    const queries = prepared.filter((sql) => sql.includes("foodbanklocation_full"));
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toContain("SELECT *");
    expect(queries[0]).not.toContain("boundary_geojson");
  });

  // Stated as a negative that cannot pass vacuously: the blob is gone from
  // both bodies AND the rows that carry it are still there.
  it("never emits boundary_geojson in either format", async () => {
    for (const path of ["/api/2/foodbank/salisbury/", "/api/2/foodbank/salisbury/?format=geojson"]) {
      const body = await (await get(path)).text();
      expect(body).toContain("wilton-road");
      expect(body).not.toContain("boundary_geojson");
      expect(body).not.toContain("coordinates\\\":[[[");
    }
  });
});

// ===========================================================================
// GET /api/2/foodbanks/search/ -- github #48
// ===========================================================================
// THIS ENDPOINT HAD NO FUNCTIONAL TEST AT ALL before #48, which is part of
// why the defect below survived: the only mention of it in this file was a
// comment observing that it exists.
//
// The defect was a 200 with wrong numbers in it, the worst kind this endpoint
// has. Distances were zipped onto food banks BY POSITION --
// `foodbanksWithNeed.map((foodbank, i) => ranked[i].distanceM)` -- on the
// strength of a comment claiming getFoodbanksByIds "preserves rankedIds's
// order". It does preserve the order; it does not preserve the LENGTH.
// mapFoodbanksByIds drops any id whose row it cannot find, so one missing row
// shifts every distance after it onto the wrong food bank, and nothing
// downstream can tell.
//
// The window is narrow and real: the candidate scan and the hydration read
// are two statements, and /admin/'s delete (foodbankAdmin.ts:29) removes the
// row outright between them. CLOSING a food bank does NOT do this, which is
// worth saying because it is the intuitive guess -- the hydration query is
// `SELECT * FROM foodbank WHERE id IN (...)` with no is_closed filter.
describe("GET /api/2/foodbanks/search/", () => {
  // Every open food bank is pointed at need 500 first: frozen bug B12
  // dereferences latest_need unguarded, and the shared fixture deliberately
  // leaves most neighbours without one, so an untouched search 500s before it
  // can say anything about distances. The need's CONTENT is irrelevant here --
  // the assertion is about which distance is attached to which slug.
  const searchBody = async (): Promise<Array<{ slug: string; distance_m: number }>> => {
    const res = await get(`/api/2/foodbanks/search/?lat_lng=${SALISBURY_LAT},${SALISBURY_LNG}`);
    expect(res.status).toBe(200);
    return (await res.json()) as Array<{ slug: string; distance_m: number }>;
  };

  it("returns the ten nearest open food banks, nearest first", async () => {
    db.exec("UPDATE foodbank SET latest_need_id = 500 WHERE is_closed = 0");

    const body = await searchBody();

    expect(body).toHaveLength(10);
    expect(body[0]!.slug).toBe("salisbury");
    expect(body.map((f) => f.distance_m)).toEqual([...body.map((f) => f.distance_m)].sort((a, b) => a - b));
    // The closed rows must not appear: shut-foodbank sits nearer than every
    // neighbour, and wonky-latlng would reorder the whole list.
    expect(JSON.stringify(body)).not.toContain("shut-foodbank");
    expect(JSON.stringify(body)).not.toContain("wonky-latlng");
  });

  // Asserted against the SAME REQUEST RUN TWICE, once whole and once with a
  // row pulled out from under it, so the expectation is the endpoint's own
  // output rather than a transcription of it.
  it("keeps every distance attached to its own food bank when one is deleted mid-request", async () => {
    db.exec("UPDATE foodbank SET latest_need_id = 500 WHERE is_closed = 0");
    const whole = await searchBody();

    // Deleting the NEAREST one is what makes this bite: it shifts every
    // subsequent index, so a positional zip gets all of the remainder wrong
    // rather than none of them.
    onPrepare = (sql) => {
      if (sql.startsWith("SELECT * FROM foodbank WHERE id IN")) db.exec("DELETE FROM foodbank WHERE slug = 'salisbury'");
    };
    const afterDelete = await searchBody();

    expect(afterDelete.map((f) => f.slug)).toEqual(whole.map((f) => f.slug).filter((slug) => slug !== "salisbury"));
    for (const row of afterDelete) {
      expect(row.distance_m, row.slug).toBe(whole.find((f) => f.slug === row.slug)!.distance_m);
    }
  });
});

// ===========================================================================
// GET /api/2/foodbanks/search/ -- malformed coordinates (github #15)
// ===========================================================================
// Django's own guard is here and is kept: gfapi2/views.py:376-380 requires a
// comma, then requires the value to be digits once `,`, `-` and `.` are
// stripped. That catches `abc,def` and answers 400. What it does NOT catch is
// an EMPTY HALF: "51.5074," strips to "515074" and passes, ",-0.1278" strips
// to "01278" and passes, ",,12" strips to "12" and passes.
//
// Django then reaches is_uk(), whose bare `float(lat_lng.split(",")[0])`
// (geo.py:193-194) raises ValueError on the empty string, uncaught -- a 500.
// The port used a parseFloat pair that answered NaN, and isUk(51.5074, NaN)
// is TRUE because its four comparisons are all false against NaN, so the 400
// never fired either. The caller got 200 and the first ten open food banks in
// rowid order with `distance_m: null`.
describe("GET /api/2/foodbanks/search/ -- coordinates the isdigit guard lets through", () => {
  const searchStatus = async (latLng: string): Promise<number> => {
    const res = await get(`/api/2/foodbanks/search/?lat_lng=${encodeURIComponent(latLng)}`);
    return res.status;
  };

  it.each([
    ["51.5074,", "empty longitude -- a `${lat},${lng}` with one side undefined"],
    [",-0.1278", "empty latitude"],
    [",,12", "three parts, the first two empty"],
    [".,1", "a bare point, which strips to nothing"],
    ["-,1", "a bare sign, which strips to nothing"],
  ])("500s on ?lat_lng=%s (%s), where it used to answer 200", async (value) => {
    db.exec("UPDATE foodbank SET latest_need_id = 500 WHERE is_closed = 0");

    expect(await searchStatus(value)).toBe(500);
  });

  // STILL 400, NOT 500, and the distinction is Django's. These never reach
  // is_uk() at all: the isdigit guard rejects them first and returns
  // HttpResponseBadRequest. A fix that moved the parse in front of the guard
  // would turn these into 500s -- a new divergence, in the opposite direction.
  //
  // `,` is in this group and not the one above, which is not obvious: strip
  // its comma and the empty string is left, and `"".isdigit()` is False in
  // Python -- so Django rejects it at the guard and never reaches float().
  // Same for a third part that is not numeric: "51.06,-1.79,junk" strips to
  // "5106179junk" and fails isdigit, so it is a 400 rather than the 200 an
  // indexing parser alone would give. Both verified by running the guard and
  // the parse in CPython, after this suite asserted the opposite and was
  // wrong.
  it.each([["abc,def"], ["banana,split"], ["0x10,0x10"], [","], ["51.0688,-1.7945,junk"]])(
    "still 400s on ?lat_lng=%s, which Django's isdigit guard rejects before the parse",
    async (value) => {
      expect(await searchStatus(value)).toBe(400);
    },
  );

  it("still 400s on a value with no comma at all", async () => {
    expect(await searchStatus("51.5074")).toBe(400);
  });

  // Django INDEXES rather than unpacks, so a third part is ignored, not an
  // error -- and the obvious implementation, reject unless there are exactly
  // two parts, would 500 this. It has to be a NUMERIC third part to get this
  // far: a non-numeric one is a 400 at the guard above, which is why that case
  // sits in the other list.
  it("accepts a numeric third comma-separated part, which Django ignores", async () => {
    db.exec("UPDATE foodbank SET latest_need_id = 500 WHERE is_closed = 0");

    expect(await searchStatus(`${SALISBURY_LAT},${SALISBURY_LNG},999`)).toBe(200);
  });

  // The control: the fix must not have made everything an error.
  it("still ranks a well-formed coordinate", async () => {
    db.exec("UPDATE foodbank SET latest_need_id = 500 WHERE is_closed = 0");

    const res = await get(`/api/2/foodbanks/search/?lat_lng=${SALISBURY_LAT},${SALISBURY_LNG}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ slug: string; distance_m: number }>;
    expect(body[0]!.slug).toBe("salisbury");
    expect(typeof body[0]!.distance_m).toBe("number");
  });
});
