import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/wfbn/locationDetail.ts -- the three handlers a single food bank
// LOCATION or DONATION POINT is served by:
//
//   wfbnFoodbankLocation                   GET /needs/at/<slug>/<locslug>/
//   wfbnFoodbankDonationpoint              GET /needs/at/<slug>/donationpoint/<dpslug>/
//   wfbnFoodbankDonationpointOpeninghours  GET .../donationpoint/<dpslug>/openinghours/
//
// Ported from gfwfbn/views.py's `foodbank_location` (837-863),
// `foodbank_donationpoint` (949-987) and
// `foodbank_donationpoint_openinghours` (990-1006), all three read in full
// alongside this file.
//
// WHY THIS FILE EXISTS. These are the deepest pages of the site's largest
// page family, and every way of getting one wrong renders a 200 with a
// plausible-looking page on it:
//
//   * THE PAIR IS THE IDENTITY. A location is addressed by (foodbank slug,
//     location slug) and nothing else -- there is no global uniqueness on the
//     child slug. Drop `AND foodbank_slug = ?` from either lookup and
//     /needs/at/cardiff/amesbury/ silently serves Salisbury's Amesbury
//     centre: right template, right food bank name in the breadcrumb, wrong
//     address, wrong postcode, wrong map pin. So both legs below are fixtured
//     with a COLLIDING child slug and asserted from both sides.
//
//   * THE MAP READS lat_lng, NOT latitude/longitude. Those two REAL columns
//     are nullable in production while lat_lng is NOT NULL, and Django's
//     latt()/long() derive from lat_lng in every one of these views. A port
//     that reached for the obvious columns puts `"lat": null` in the map
//     config for every row that has them empty -- invisible until the map
//     draws in the Atlantic. Both fixtures below therefore carry
//     latitude/longitude that DISAGREE with lat_lng, so the two sources
//     cannot be mistaken for one another.
//
//   * THE NEED TEXT HAS THREE SENTINELS AND ONE NON-SENTINEL EMPTY STATE, and
//     the two page handlers treat that empty state differently from each
//     other (see the `has_need` tests). Both behaviours are pinned as they
//     stand.
//
//   * THE PRELOAD HEADER IS A ONE-TOKEN CONTRACT. The openinghours
//     `Link: rel=preload` is inert without `crossorigin=anonymous` (ticket
//     #11, recorded at length in the module), it must NOT be sent when the
//     fragment will not be requested, and it sits on a route
//     middleware/geoJsonPreload.ts deliberately does not recognise -- so that
//     middleware must leave it alone. All three are asserted.
//
// REAL EVERYTHING, the same harness as routes/public/country.test.ts and
// routes/api2/foodbanks.test.ts: the REAL production app (index.ts's default
// export), so the route order that makes /needs/at/x/locations/ a list page
// rather than a location called "locations" is the genuine one, and so are
// resolveLanguage, slugRedirect, cacheTag, geoJsonPreload and
// pageCacheControl; the REAL Nunjucks templates and .po catalogues; and real
// in-memory SQLite built by schemaFor() from the real migrations -- which
// matters here because both child lookups read through the _full VIEWS, whose
// LEFT JOIN is where a location's foodbank_phone_number/foodbank_email
// fallbacks come from. Mocked: only the two KV namespaces, which have no
// local double and which none of these three routes touch.
//
// MUTATION-TESTED (TESTING.md's convention). The whole repo was copied to a
// scratchpad outside it -- never edited in place -- and 34 single-line breaks
// were applied one at a time to locationDetail.ts, packages/db's locations.ts
// and donationpoints.ts, lib/needDisplay.ts and lib/openingHours.ts, with this
// file re-run against each. Two survived the first version of it and are why
// two of the tests below look the way they do: `has_need` stopped excluding
// "Facebook" and nothing failed, because no donation point in the fixture
// belonged to a food bank whose need was that sentinel (hence food banks 4 and
// 5, and the three-case loop); and the donation point's JSON-LD lost its
// parent organisation's name while only the parent's "@id" was asserted.
// Everything else was caught, including both lookups losing their foodbank
// scoping, either map reading latitude/longitude, the preload losing
// crossorigin, the service-area guard moving between the two handlers, and a
// second D1 session being opened for the child lookup.
//
// RE-RUN FOR github #52 ITEM 3, which moved the service-area count into the
// batched food bank lookup and, with it, the `no_locations == 0` guard that
// used to be spelled out in one of these two handlers and MISSING from the
// other. Both handlers reverted to their pre-#52 shape -- separate hop, and
// for wfbnFoodbankLocation no guard at all -- are killed, two tests each: the
// round-trip assertion and the guard assertion. So are the flag forced true on
// either page. That is only possible because the shim now logs ROUND TRIPS as
// well as statements; before it did not, and moving a statement into or out of
// a batch was invisible to this file.

const ORIGIN = "https://www.givefood.org.uk";

// Tuesday 8 September 2026, 09:30 UTC. The opening-hours fragment builds its
// seven rows from `new Date()` and computes `is_open` against the wall clock,
// so without a frozen clock every assertion in that describe would be a
// different test on each day of the week. Date only -- elapsedMs() uses
// performance.now() and must stay real.
const NOW = new Date("2026-09-08T09:30:00.000Z");

type Bindable = null | number | bigint | string | Uint8Array;

// One statement as it reached the engine: which SESSION opened it, the SQL,
// and the values bound to it. All three matter here. The session id is what
// proves lib/session.ts's one-session-per-request contract (two sessions
// against a replicated database can see two different snapshots, and the page
// would still render). The bindings are what prove the food bank slug reaches
// the child lookup at all.
interface Prepared {
  session: number;
  sql: string;
  params: Bindable[];
}

let db: DatabaseSync;
let prepared: Prepared[];
let roundTrips: RoundTrip[];
let sessions: number;

// STATEMENTS AND ROUND TRIPS ARE DIFFERENT COUNTS. github #52 item 3 moved
// has_service_area's COUNT(*) off a serial hop of its own and into
// getFoodbankBySlug's batch on both page handlers below: the same statements
// go out, one D1 wait earlier. `prepared` cannot see that -- only their ORDER
// moved -- so the shim logs the trips too, one entry per network call, exactly
// as packages/db/src/foodbank.test.ts does.
type RoundTrip = Array<{ sql: string; params: Bindable[] }>;

// The slice of the D1 Sessions API packages/db uses, over node:sqlite --
// routes/public/country.test.ts's shim plus the batch() getFoodbankBySlug
// needs (it sends the food bank row, its latest need and, on these pages, the
// service-area count as one round trip). Deliberately dumb otherwise: it never
// inspects or rewrites SQL, it hands every statement to real SQLite.
function d1Session(): D1DatabaseSession {
  sessions += 1;
  const id = sessions;
  const statement = (sql: string, params: Bindable[], entry: Prepared) => ({
    sql,
    params,
    bind: (...next: unknown[]) => {
      entry.params = next as Bindable[];
      return statement(sql, next as Bindable[], entry);
    },
    first: async <T>() => {
      roundTrips.push([{ sql, params }]);
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    all: async () => {
      roundTrips.push([{ sql, params }]);
      return { results: db.prepare(sql).all(...params), success: true, meta: {} };
    },
    run: async () => {
      roundTrips.push([{ sql, params }]);
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return {
    prepare: (sql: string) => {
      const entry: Prepared = { session: id, sql, params: [] };
      prepared.push(entry);
      return statement(sql, [], entry);
    },
    batch: async (statements: Array<{ sql: string; params: Bindable[] }>) => {
      roundTrips.push(statements.map((s) => ({ sql: s.sql, params: s.params })));
      return statements.map((s) => ({ results: db.prepare(s.sql).all(...s.params), success: true, meta: {} }));
    },
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

function env(): AppEnv["Bindings"] {
  return {
    DB: { withSession: () => d1Session() },
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: { get: async () => null, put: async () => {}, delete: async () => {} },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

// ---------------------------------------------------------------------------
// Seeds. Only the columns these handlers and their templates read are
// parameterised; every other NOT NULL column is filled with whatever the real
// migration insists on, so a seeded row is one production would have accepted.
// ---------------------------------------------------------------------------

interface FoodbankSeed {
  id: number;
  slug: string;
  name: string;
  altName?: string | null;
  country?: string;
  network?: string | null;
  charityNumber?: string | null;
  latestNeedId?: number | null;
  noLocations?: number;
  noDonationPoints?: number | null;
  isClosed?: 0 | 1;
  phone?: string | null;
  email?: string;
  url?: string;
  facebookPage?: string | null;
  bankuetSlug?: string | null;
}

// `name` is stored BARE ("Salisbury"): fullNameLocaleAware() is what appends
// " Foodbank" (or prefixes "Banc Bwyd"), and a fixture already carrying the
// suffix would hide that helper behind "Salisbury Foodbank Foodbank".
function seedFoodbank(s: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, alt_name, slug, address, postcode, country, lat_lng,
       latitude, longitude, delivery_address, delivery_lat_lng, network, charity_just_foodbank,
       charity_number, charity_name, facebook_page, bankuet_slug, contact_email, phone_number, url,
       shopping_list_url, plus_code_global, place_id, district, parliamentary_constituency_name,
       address_is_administrative, is_closed, no_locations, no_donation_points, days_between_needs,
       latest_need_id, created, modified)
     VALUES (?, ?, ?, ?, ?, '1 High Street', 'SP1 1AA', ?, '51.07,-1.79',
       51.07, -1.79, NULL, '51.5,-1.5', ?, 0,
       ?, 'The Trussell Trust', ?, ?, ?, ?, ?,
       'https://example.invalid/list/', '9C3V+2X Salisbury', 'ChIJplaceid', 'Salisbury', 'Salisbury',
       0, ?, ?, ?, 14,
       ?, '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run(
    s.id,
    String(s.id).padStart(32, "a"),
    s.name,
    s.altName ?? null,
    s.slug,
    s.country ?? "England",
    s.network ?? "Trussell",
    s.charityNumber ?? null,
    s.facebookPage ?? null,
    s.bankuetSlug ?? null,
    s.email ?? `info@${s.slug}.invalid`,
    s.phone ?? null,
    s.url ?? `https://${s.slug}.invalid/`,
    s.isClosed ?? 0,
    s.noLocations ?? 1,
    s.noDonationPoints ?? 1,
    s.latestNeedId ?? null,
  );
}

// `created`/`modified` are TEXT compared lexicographically, so every fixture
// timestamp is written in Django's own spelling -- "2026-09-05 19:28:08.853000",
// a space and six digits of microseconds, never toISOString()'s.
function seedNeed(o: { id: number; foodbankId: number; changeText: string; excess?: string | null }): void {
  db.prepare(
    `INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, excess_change_text, published,
       input_method, created, modified)
     VALUES (?, ?, ?, ?, ?, 1, 'scrape', '2026-09-05 19:28:08.853000', '2026-09-05 19:28:08.853000')`,
  ).run(o.id, String(o.id).padStart(32, "c"), o.foodbankId, o.changeText, o.excess ?? null);
}

function seedTranslation(o: { id: number; needId: number; language: string; changeText: string | null; excess?: string | null }): void {
  db.prepare(
    "INSERT INTO foodbankchangetranslation (id, need_id, foodbank_id, language, change_text, excess_change_text) VALUES (?, ?, 1, ?, ?, ?)",
  ).run(o.id, o.needId, o.language, o.changeText, o.excess ?? null);
}

interface LocationSeed {
  id: number;
  foodbankId: number;
  name: string;
  slug: string;
  country?: string;
  address?: string | null;
  postcode?: string | null;
  latLng: string;
  latitude?: number | null;
  longitude?: number | null;
  isClosed?: 0 | 1;
  boundary?: string | null;
  phone?: string | null;
  email?: string | null;
  placeHasPhoto?: 0 | 1 | null;
  isDonationPoint?: 0 | 1 | null;
  isMobile?: 0 | 1 | null;
}

function seedLocation(s: LocationSeed): void {
  db.prepare(
    `INSERT INTO foodbanklocation (id, uuid, foodbank_id, name, slug, address, postcode, country,
       lat_lng, latitude, longitude, plus_code_global, place_has_photo, district,
       parliamentary_constituency_name, is_closed, is_donation_point, is_mobile, boundary_geojson,
       phone_number, email, modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Salisbury', 'Salisbury',
       ?, ?, ?, ?, ?, ?, '2020-01-01 00:00:00.000000')`,
  ).run(
    s.id,
    String(s.id).padStart(32, "e"),
    s.foodbankId,
    s.name,
    s.slug,
    s.address === undefined ? "2 Low Street" : s.address,
    s.postcode === undefined ? "SP2 2BB" : s.postcode,
    s.country ?? "England",
    s.latLng,
    s.latitude === undefined ? null : s.latitude,
    s.longitude === undefined ? null : s.longitude,
    `PLUS+${s.id}`,
    s.placeHasPhoto ?? null,
    s.isClosed ?? 0,
    s.isDonationPoint ?? null,
    s.isMobile ?? null,
    s.boundary ?? null,
    s.phone ?? null,
    s.email ?? null,
  );
}

interface DonationPointSeed {
  id: number;
  foodbankId: number;
  name: string;
  slug: string;
  country?: string | null;
  latLng: string;
  latitude?: number | null;
  longitude?: number | null;
  url?: string | null;
  phone?: string | null;
  openingHours?: string | null;
  notes?: string | null;
  inStoreOnly?: 0 | 1;
  wheelchair?: 0 | 1 | null;
  placeHasPhoto?: 0 | 1 | null;
}

function seedDonationPoint(s: DonationPointSeed): void {
  db.prepare(
    `INSERT INTO foodbankdonationpoint (id, uuid, foodbank_id, name, slug, address, postcode, country,
       lat_lng, latitude, longitude, plus_code_global, place_has_photo, district,
       parliamentary_constituency_name, is_closed, in_store_only, phone_number, url, opening_hours,
       wheelchair_accessible, notes, modified)
     VALUES (?, ?, ?, ?, ?, '5 Retail Park', 'SP4 4DD', ?, ?, ?, ?, ?, ?, 'Salisbury',
       'Salisbury', 0, ?, ?, ?, ?, ?, ?, '2020-01-01 00:00:00.000000')`,
  ).run(
    s.id,
    String(s.id).padStart(32, "d"),
    s.foodbankId,
    s.name,
    s.slug,
    s.country === undefined ? "England" : s.country,
    s.latLng,
    s.latitude === undefined ? null : s.latitude,
    s.longitude === undefined ? null : s.longitude,
    `PLUS+${s.id}`,
    s.placeHasPhoto ?? null,
    s.inStoreOnly ?? 0,
    s.phone ?? null,
    s.url ?? null,
    s.openingHours ?? null,
    s.wheelchair ?? null,
    s.notes ?? null,
  );
}

// Seven "Day: hours" lines, Monday first -- the exact stored shape
// FoodbankDonationPoint.opening_hours has in production. Wednesday and Sunday
// are the "Closed" rows; Saturday's hours differ from the weekday block, so a
// fragment that printed one row seven times cannot pass.
const HOURS = [
  "Monday: 9:00 AM - 5:00 PM",
  "Tuesday: 9:00 AM - 5:00 PM",
  "Wednesday: Closed",
  "Thursday: 9:00 AM - 5:00 PM",
  "Friday: 9:00 AM - 5:00 PM",
  "Saturday: 10:00 AM - 4:00 PM",
  "Sunday: Closed",
].join("\n");

const BOUNDARY = '{"type":"Polygon","coordinates":[[[-1.9,51.0],[-1.7,51.0],[-1.7,51.1],[-1.9,51.0]]]}';

// THE FIXTURE IS THE TEST, so each row turns exactly one rule on or off
// relative to its neighbour.
//
// Food banks:
//   1 salisbury     open, Trussell, charity number, phone, bankuet_slug,
//                   latest need 1 (a real list, with a blank line in it)
//   2 cardiff       Wales, IFAN, alt_name set, NO phone, NO latest need at all
//   3 closed-town   is_closed = 1, no_locations = 0, latest need "Unknown"
//   4 fb-town       latest need "Facebook", facebook_page set
//   5 nothing-town  latest need "Nothing"
//
// Those four need texts are the whole sentinel space -- "Unknown", "Facebook",
// "Nothing" and the "" a food bank with no need record at all resolves to --
// and each handler treats them differently, so every one of them has a food
// bank of its own here.
//
// Locations (child slugs deliberately collide across parents):
//   11 salisbury/amesbury    no own phone/email -> parent fallbacks;
//                            latitude/longitude columns 99.9/88.8 DISAGREE
//                            with lat_lng; no boundary -> zoom 15
//   12 salisbury/wilton      is_closed = 1; boundary -> zoom 12; own phone
//                            and email; NO address and NO postcode
//   13 cardiff/amesbury      SAME slug as 11 under a different food bank; own
//                            phone (whose parent has none) and own email
//   14 fb-town/fb-centre     the Facebook-embed branch
//   15 closed-town/shut      parent closed AND no_locations = 0
//   16 salisbury/locations   a location whose slug collides with the
//                            /locations/ LIST route -- the route-order trap
//
// Donation points (same collision, same reasoning):
//   21 salisbury/tesco-extra     full hours, notes, in_store_only, wheelchair,
//                                url with tracking params, own phone
//   22 salisbury/blank-hours     opening_hours is WHITESPACE ONLY
//   23 cardiff/tesco-extra       SAME slug, different parent, no hours, no url
//   24 closed-town/corner-shop   parent has no_locations = 0, need "Unknown"
//   25 salisbury/glasgow-store   in SCOTLAND while its food bank is in England
//   26 fb-town/fb-store          parent's need is "Facebook"
//   27 nothing-town/no-need-shop parent's need is "Nothing"
function seed(): void {
  seedFoodbank({
    id: 1,
    slug: "salisbury",
    name: "Salisbury",
    charityNumber: "1147244",
    latestNeedId: 1,
    noLocations: 4,
    noDonationPoints: 3,
    phone: "01722 411900",
    email: "info@salisbury.invalid",
    url: "https://salisburyfoodbank.invalid/",
    bankuetSlug: "salisbury",
  });
  seedFoodbank({
    id: 2,
    slug: "cardiff",
    name: "Cardiff",
    altName: "Banc Bwyd Caerdydd",
    country: "Wales",
    network: "IFAN",
    latestNeedId: null,
  });
  seedFoodbank({ id: 3, slug: "closed-town", name: "Closed Town", isClosed: 1, latestNeedId: 3, noLocations: 0 });
  seedFoodbank({ id: 4, slug: "fb-town", name: "FB Town", latestNeedId: 4, facebookPage: "fbtown" });
  seedFoodbank({ id: 5, slug: "nothing-town", name: "Nothing Town", latestNeedId: 5 });

  // The blank line inside change_text is load-bearing: get_change_text()
  // strips it (nonEmptyLines) while schema_org()'s `seeks` does not.
  seedNeed({ id: 1, foodbankId: 1, changeText: "Tinned Meat\n\nPasta\nRice", excess: "Baked Beans\n\nSoup" });
  seedNeed({ id: 3, foodbankId: 3, changeText: "Unknown" });
  seedNeed({ id: 4, foodbankId: 4, changeText: "Facebook" });
  seedNeed({ id: 5, foodbankId: 5, changeText: "Nothing" });

  // Two translations of the SAME need in two languages: the cy page must pick
  // the cy row, which a lookup that forgot to bind `language` would not.
  seedTranslation({ id: 1, needId: 1, language: "cy", changeText: "Cig Tun\n\nPasta", excess: "Ffa Pob" });
  seedTranslation({ id: 2, needId: 1, language: "ga", changeText: "Feoil Stánaithe", excess: "Pónairí" });

  seedLocation({
    id: 11,
    foodbankId: 1,
    name: "Amesbury Centre",
    slug: "amesbury",
    latLng: "51.1662,-1.7827",
    latitude: 99.9,
    longitude: 88.8,
    placeHasPhoto: 1,
    isDonationPoint: 1,
  });
  seedLocation({
    id: 12,
    foodbankId: 1,
    name: "Wilton Centre",
    slug: "wilton",
    latLng: "51.08,-1.86",
    address: null,
    postcode: null,
    isClosed: 1,
    boundary: BOUNDARY,
    phone: "01722 000111",
    email: "wilton@salisbury.invalid",
    isMobile: 1,
  });
  seedLocation({
    id: 13,
    foodbankId: 2,
    name: "Amesbury Hall",
    slug: "amesbury",
    country: "Wales",
    latLng: "51.48,-3.17",
    phone: "029 2000 1111",
    email: "hall@cardiff.invalid",
  });
  seedLocation({ id: 14, foodbankId: 4, name: "FB Centre", slug: "fb-centre", latLng: "52.0,-1.0" });
  seedLocation({ id: 15, foodbankId: 3, name: "Shut Centre", slug: "shut", latLng: "53.5,-2.5" });
  seedLocation({ id: 16, foodbankId: 1, name: "Trap Centre", slug: "locations", latLng: "51.0,-1.0" });

  seedDonationPoint({
    id: 21,
    foodbankId: 1,
    name: "Tesco Extra",
    slug: "tesco-extra",
    latLng: "51.3811,-2.3590",
    latitude: 11.1,
    longitude: 22.2,
    url: "https://tesco.invalid/store/1?utm_source=newsletter&keep=yes",
    phone: "01722 999888",
    openingHours: HOURS,
    notes: "Ask at the kiosk",
    inStoreOnly: 1,
    wheelchair: 1,
  });
  seedDonationPoint({ id: 22, foodbankId: 1, name: "Blank Hours", slug: "blank-hours", latLng: "51.1,-1.1", openingHours: "   " });
  seedDonationPoint({ id: 23, foodbankId: 2, name: "Cardiff Co-op", slug: "tesco-extra", country: "Wales", latLng: "51.48,-3.18" });
  seedDonationPoint({ id: 24, foodbankId: 3, name: "Corner Shop", slug: "corner-shop", latLng: "53.0,-2.0" });
  seedDonationPoint({
    id: 25,
    foodbankId: 1,
    name: "Glasgow Store",
    slug: "glasgow-store",
    country: "Scotland",
    latLng: "55.86,-4.25",
    openingHours: HOURS,
  });
  seedDonationPoint({ id: 26, foodbankId: 4, name: "FB Store", slug: "fb-store", latLng: "52.1,-1.1" });
  seedDonationPoint({ id: 27, foodbankId: 5, name: "No Need Shop", slug: "no-need-shop", latLng: "52.2,-1.2" });

  // One row that must never fire: middleware/slugRedirect.ts reads this table
  // on any /needs/at/<slug>/<one more segment>/ path, and a redirect for a
  // slug none of these tests uses proves the read happens without changing a
  // single response below.
  db.prepare(
    `INSERT INTO slugredirect (id, old_slug, new_slug, created, modified)
     VALUES (1, 'old-name', 'salisbury', '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run();
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  // schemaFor rather than hand-written DDL: both child lookups read the _full
  // VIEWS and getFoodbankBySlug reads foodbankchange_full, and a hand-built
  // fixture that lacked any of them would fail with "no such table" somewhere
  // else entirely.
  db.exec(
    schemaFor(
      "foodbank",
      "foodbankchange",
      "foodbankchange_full",
      "foodbankchangetranslation",
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
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
});

// `async`, not a bare arrow: app.fetch is typed Response | Promise<Response>.
const get = async (path: string, init?: RequestInit): Promise<Response> => app.fetch(new Request(`${ORIGIN}${path}`, init), env(), execCtx);
const body = async (path: string): Promise<string> => (await get(path)).text();

// The statements the HANDLER issued, without middleware/slugRedirect.ts's own
// read. That middleware memoises the map at module scope for five minutes, so
// whether its query appears at all depends on which test ran first -- an order
// dependency that has nothing to do with this module. Its behaviour is
// slugRedirect.test.ts's subject; here it is noise, and it opens its own
// session, which is why the session assertions filter it out too.
const SLUG_REDIRECT_SQL = "SELECT old_slug, new_slug FROM slugredirect";
const handlerQueries = (): Prepared[] => prepared.filter((p) => p.sql !== SLUG_REDIRECT_SQL);
const handlerTrips = (): RoundTrip[] => roundTrips.filter((t) => !t.some((s) => s.sql === SLUG_REDIRECT_SQL));

// ---------------------------------------------------------------------------
// Reading the rendered page. Everything asserted below is a VALUE off the page
// -- a meta tag's content, the parsed map config, the parsed JSON-LD, an href
// -- never "the page contains some HTML".
// ---------------------------------------------------------------------------

function meta(html: string, key: string): string | null {
  const m = new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)">`).exec(html);
  return m ? (m[1] as string) : null;
}

function pageTitle(html: string): string {
  const m = /<title>([\s\S]*?)<\/title>/.exec(html);
  if (!m) throw new Error("no <title> in the rendered page");
  return m[1] as string;
}

// includes/mapconfig.njk writes the handler's JSON.stringify(mapConfig)
// verbatim into `window.gfMapConfig`. Parsed rather than string-matched, so a
// reordered key cannot fail a test that is really about the values.
function mapConfig(html: string): Record<string, unknown> {
  const m = /window\.gfMapConfig = (\{.*?\});/.exec(html);
  if (!m) throw new Error("no window.gfMapConfig in the rendered page");
  return JSON.parse(m[1] as string) as Record<string, unknown>;
}

// The FIRST application/ld+json block is the page's own schema_org_str: both
// templates emit it inside {% block head %}, which page.njk renders before its
// own site-wide "Give Food" organisation block.
function pageJsonLd(html: string): Record<string, unknown> {
  const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error("no JSON-LD in the rendered page");
  return JSON.parse(m[1] as string) as Record<string, unknown>;
}

// Every <a href="..." ... class="..."> on the page, as a pair. The contact
// links this module builds all carry a stable class, so the assertions can
// talk in hrefs rather than in HTML.
function anchors(html: string): { href: string; cls: string | null }[] {
  return [...html.matchAll(/<a href="([^"]*)"(?:[^>]*?class="([^"]*)")?[^>]*>/g)].map((m) => ({
    href: m[1] as string,
    cls: (m[2] as string | undefined) ?? null,
  }));
}

const hrefWithClass = (html: string, cls: string): string | null => anchors(html).find((a) => a.cls === cls)?.href ?? null;

// The seven <tr>s of the opening-hours fragment, as {day, text} with runs of
// whitespace collapsed -- the template indents heavily and the interesting
// content is one or two short strings per cell.
function hoursRows(html: string): { day: string; text: string }[] {
  return [...html.matchAll(/<td class="dayname"><strong>(.*?)<\/strong><\/td>\s*<td>([\s\S]*?)<\/td>/g)].map((m) => ({
    day: m[1] as string,
    text: (m[2] as string).replace(/\s+/g, " ").trim(),
  }));
}

// ===========================================================================
// wfbnFoodbankLocation
// ===========================================================================

describe("wfbnFoodbankLocation -- which row, if any", () => {
  // THE WHOLE POINT OF THE PAIR. Locations 11 and 13 share the slug "amesbury"
  // under two different food banks, a state production really has (there is no
  // unique index on foodbanklocation.slug alone). getFoodbankLocationBySlugs
  // binds BOTH slugs; drop the foodbank_slug half and SQLite happily returns
  // whichever row it reaches first, rendering Salisbury's centre under
  // Cardiff's breadcrumb with a 200. Asserted from both sides, so "always
  // returns the first row" cannot pass either.
  it("resolves the child slug within its own food bank, not globally", async () => {
    const salisbury = await body("/needs/at/salisbury/amesbury/");
    const cardiff = await body("/needs/at/cardiff/amesbury/");

    expect(pageTitle(salisbury)).toBe("Amesbury Centre - Salisbury Foodbank - Give Food");
    expect(meta(salisbury, "geo.position")).toBe("51.1662,-1.7827");
    expect(pageTitle(cardiff)).toBe("Amesbury Hall - Cardiff Foodbank - Give Food");
    expect(meta(cardiff, "geo.position")).toBe("51.48,-3.17");
  });

  // Django's two get_object_or_404 calls, in order. A missing food bank must
  // 404 before the location lookup runs at all -- not 500 on a null parent.
  it("404s on an unknown food bank slug, without looking the location up", async () => {
    const res = await get("/needs/at/nope/amesbury/");

    expect(res.status).toBe(404);
    expect(handlerQueries().some((q) => q.sql.includes("foodbanklocation_full"))).toBe(false);
  });

  it("404s on an unknown location slug under a real food bank", async () => {
    expect((await get("/needs/at/salisbury/nope/")).status).toBe(404);
  });

  // The other half of the pair check, stated as a 404 rather than as a
  // different page: "wilton" is a real location slug, just not Cardiff's.
  it("404s on a location slug that belongs to a different food bank", async () => {
    expect((await get("/needs/at/cardiff/wilton/")).status).toBe(404);
  });

  // NO is_closed FILTER, deliberately -- Django's
  // get_object_or_404(FoodbankLocation, slug=..., foodbank=...) has none, and
  // a closed centre's page must stay reachable (people arrive at it from
  // search results and need to be told). Location 12 is closed and renders.
  it("still serves a CLOSED location's page", async () => {
    const res = await get("/needs/at/salisbury/wilton/");

    expect(res.status).toBe(200);
    expect(pageTitle(await res.text())).toBe("Wilton Centre - Salisbury Foodbank - Give Food");
  });

  // ROUTE ORDER, which is index.ts's decision but is only observable here.
  // /needs/at/:slug/:locslug/ is a catch-all registered AFTER /locations/,
  // /donationpoints/, /news/, /charity/ and the rest; location 16's slug is
  // literally "locations", so if the catch-all came first this URL would serve
  // its detail page instead of the list. Nothing else in the suite would fail.
  it("does not swallow the sibling list routes despite the catch-all shape", async () => {
    const list = await body("/needs/at/salisbury/locations/");

    expect(pageTitle(list)).toBe("Locations - Salisbury Foodbank - Give Food");
    // ...and the trap row really is there to have been served instead: the list
    // page links it like any other location, so "the list won" is not just
    // "there was no such location".
    expect(list).toContain('<a href="/needs/at/salisbury/locations/">Trap Centre</a>');
  });

  // GET only, matching Django's foodbank_location(). Worth asserting rather
  // than assuming: a stray app.all would hand a POST to a handler whose
  // response pageCacheControl then stamps public for a day.
  it("does not answer a POST", async () => {
    expect((await get("/needs/at/salisbury/amesbury/", { method: "POST" })).status).toBe(404);
  });
});

describe("wfbnFoodbankLocation -- the map config", () => {
  // THE lat_lng-NOT-latitude/longitude RULE. Location 11's latitude/longitude
  // columns say 99.9/88.8, which is nowhere; its lat_lng says Amesbury.
  // Django's latt()/long() split lat_lng, so the map must say Amesbury -- and
  // the two nullable columns are exactly what a "tidier" port reaches for,
  // silently producing null coordinates for every production row that has them
  // empty.
  it("takes the centre from lat_lng, never from the nullable latitude/longitude columns", async () => {
    expect(mapConfig(await body("/needs/at/salisbury/amesbury/"))).toEqual({
      geojson: "/needs/at/salisbury/geo.json",
      lat: 51.1662,
      lng: -1.7827,
      zoom: 15,
      location_marker: false,
    });
  });

  // ...while the two raw columns ARE what the place meta tags print, straight
  // off the row. Pinned alongside the test above precisely because the page
  // shows BOTH numbers: a change that "unified" them would look like a cleanup
  // and would move the map.
  it("still prints the raw latitude/longitude columns in the place meta tags", async () => {
    const html = await body("/needs/at/salisbury/amesbury/");

    expect(meta(html, "place:location:latitude")).toBe("99.9");
    expect(meta(html, "place:location:longitude")).toBe("88.8");
    expect(meta(html, "geo.position")).toBe("51.1662,-1.7827");
  });

  // gfwfbn/views.py:855-856 -- `if location.boundary_geojson: zoom = 12`,
  // pulled back from 15 to fit a service area on screen. The two locations
  // differ only in that column, so this cannot pass by accident.
  it("zooms out to 12 for a location with a service-area boundary, 15 without", async () => {
    expect(mapConfig(await body("/needs/at/salisbury/amesbury/")).zoom).toBe(15);
    expect(mapConfig(await body("/needs/at/salisbury/wilton/")).zoom).toBe(12);
  });

  // The feed is the FOOD BANK's, not the location's -- one file per food bank
  // carries every one of its locations, and this page draws all of them.
  it("points the map at the food bank's geo.json, locale-prefixed", async () => {
    expect(mapConfig(await body("/needs/at/cardiff/amesbury/")).geojson).toBe("/needs/at/cardiff/geo.json");
    expect(mapConfig(await body("/cy/needs/at/salisbury/amesbury/")).geojson).toBe("/cy/needs/at/salisbury/geo.json");
  });
});

describe("wfbnFoodbankLocation -- the rendered page", () => {
  // The head block, read as values. og:title/description/geo.placename all
  // combine the location name with the LOCALE-AWARE food bank name, and the
  // markdown alternate is NOT locale-prefixed (the /md/ mirror sits outside
  // Django's i18n_patterns) while the RSS one is.
  it("builds the head from the location name and the food bank's full name", async () => {
    const html = await body("/needs/at/salisbury/amesbury/");

    expect(pageTitle(html)).toBe("Amesbury Centre - Salisbury Foodbank - Give Food");
    expect(meta(html, "og:title")).toBe("Amesbury Centre, Salisbury Foodbank");
    expect(meta(html, "og:description")).toBe("Find what Salisbury Foodbank in Amesbury Centre is requesting to have donated");
    expect(meta(html, "description")).toBe("Find what Salisbury Foodbank in Amesbury Centre is requesting to have donated");
    expect(meta(html, "geo.placename")).toBe("Amesbury Centre - Salisbury Foodbank");
    expect(html).toContain('<link rel="alternate" type="text/markdown" href="/md/needs/at/salisbury/amesbury/">');
    expect(html).toContain('href="/needs/at/salisbury/rss.xml"');
  });

  // og:image is the location's own map.png, absolute. D7 moved this from an
  // inline template literal in the handler into the urls table; the value is
  // asserted here because a wrong one is a broken social-card image and
  // nothing else.
  it("points og:image at the location's own map.png", async () => {
    expect(meta(await body("/needs/at/salisbury/amesbury/"), "og:image")).toBe("https://www.givefood.org.uk/needs/at/salisbury/amesbury/map.png");
  });

  // The need list, translated-or-English, with blank lines stripped by
  // get_change_text()'s nonEmptyLines. The excess list is a separate field and
  // separately stripped.
  it("renders the food bank's current need list and its excess items", async () => {
    const html = await body("/needs/at/salisbury/amesbury/");

    expect(html).toContain("<p>Salisbury Foodbank is currently requesting the following items to be donated:</p>");
    expect(html).toContain("Tinned Meat<br>Pasta<br>Rice");
    expect(html).toContain("<p>They don't need any more Baked Beans, Soup.</p>");
  });

  // The location's own flags, off the row rather than off the parent.
  it("shows the per-location donation-point and mobile flags", async () => {
    const amesbury = await body("/needs/at/salisbury/amesbury/"); // is_donation_point = 1
    const wilton = await body("/needs/at/salisbury/wilton/"); // is_mobile = 1

    expect(amesbury).toContain("<p>🛒 This location accepts donations</p>");
    expect(amesbury).not.toContain("Mobile food bank location");
    expect(wilton).toContain("<p>🚚 Mobile food bank location</p>");
    expect(wilton).not.toContain("This location accepts donations");
  });

  // FoodbankLocation's phone/email fall back to the PARENT's when the row has
  // none -- the two columns foodbanklocation_full's LEFT JOIN exists to
  // supply. Location 11 has neither of its own; location 12 has both.
  it("falls back to the food bank's phone and email only when the location has none", async () => {
    const amesbury = await body("/needs/at/salisbury/amesbury/");
    const wilton = await body("/needs/at/salisbury/wilton/");

    expect(hrefWithClass(amesbury, "email")).toBe("mailto:info@salisbury.invalid");
    expect(amesbury).toContain('<a href="tel:+441722 411900" class="phone">');
    expect(hrefWithClass(wilton, "email")).toBe("mailto:wilton@salisbury.invalid");
    expect(wilton).toContain('<a href="tel:+441722 000111" class="phone">');
  });

  // SUSPECT, PINNED. location.njk gates the phone link on
  // `foodbank.phone_number` -- the PARENT's column -- while printing
  // `location.phone_or_foodbank_phone`. Location 13 has its own phone and its
  // food bank has none, so the number exists, reaches the template, lands in
  // the JSON-LD, and is the one thing a visitor cannot see. Django's
  // location.html has the same gate, so this is ported faithfully rather than
  // introduced here; recorded because this is the page where it costs someone
  // a phone call.
  it("hides a location's own phone number when its food bank has none (suspect, pinned)", async () => {
    const html = await body("/needs/at/cardiff/amesbury/");

    expect(html).not.toContain('class="phone"');
    expect(pageJsonLd(html).telephone).toBe("029 2000 1111"); // present in the JSON-LD, invisible in the page
  });

  // The address block is skipped entirely when the row has neither address nor
  // postcode (both nullable on foodbanklocation, unlike on foodbank), and the
  // directions link and plus code go with it.
  it("omits the address block, directions link and plus code when the row has no address at all", async () => {
    const amesbury = await body("/needs/at/salisbury/amesbury/");
    const wilton = await body("/needs/at/salisbury/wilton/");

    expect(amesbury).toContain("2 Low Street<br>SP2 2BB");
    expect(amesbury).toContain('href="https://www.google.com/maps?saddr=My+Location&daddr=51.1662,-1.7827"');
    expect(amesbury).toContain("PLUS+11");
    expect(wilton).not.toContain("directions-btn");
    expect(wilton).not.toContain("PLUS+12");
  });

  // has_service_area is passed BOTH nested under `foodbank` and bare at the
  // top level, because includes/maplegend.njk reads the nested one and
  // includes/serviceareadisclaimer.njk reads the bare one. Pass only one and
  // exactly one of these two lines disappears -- with no error anywhere.
  it("passes has_service_area at both scopes the two partials read it from", async () => {
    const html = await body("/needs/at/salisbury/amesbury/");

    expect(html).toContain('<div class="deliveryarea"></div> Service area<br>'); // maplegend -> foodbank.has_service_area
    expect(html).toContain('<p class="serviceareadisclaimer">'); // serviceareadisclaimer -> has_service_area
  });

  // ...and it is a live COUNT over the food bank's locations, so it is true on
  // Amesbury's page because a DIFFERENT location of the same food bank
  // (Wilton) holds the boundary. Cardiff has no boundary anywhere and gets
  // neither line -- the exclusion half, without which a hardcoded `true` would
  // pass the test above.
  it("computes has_service_area across the food bank's other locations, and is false when none has one", async () => {
    const cardiff = await body("/needs/at/cardiff/amesbury/");

    expect(cardiff).not.toContain("Service area<br>");
    expect(cardiff).not.toContain("serviceareadisclaimer");
  });

  // The JSON-LD the page publishes for search engines. `seeks` is built from
  // the RAW change_text, so the blank line becomes an empty-named Product --
  // pinned as current behaviour (get_change_text strips it for the visible
  // list, schema_org() does not), and it is the difference between the two
  // that makes this worth asserting rather than assuming.
  it("publishes the location's schema.org block, seeded from the raw need text", async () => {
    const ld = pageJsonLd(await body("/needs/at/salisbury/amesbury/"));

    expect(ld["@id"]).toBe("https://www.givefood.org.uk/needs/at/salisbury/amesbury/");
    expect(ld.name).toBe("Amesbury Centre, Salisbury Foodbank");
    expect(ld.email).toBe("info@salisbury.invalid");
    expect(ld.telephone).toBe("01722 411900");
    expect(ld.location).toEqual({ "@type": "Place", geo: { "@type": "GeoCoordinates", latitude: 51.1662, longitude: -1.7827 } });
    expect(ld.address).toEqual({
      "@type": "PostalAddress",
      addressCountry: "England",
      postalCode: "SP2 2BB",
      streetAddress: "2 Low Street",
      addressLocality: "Salisbury",
    });
    expect((ld.memberOf as Record<string, unknown>).name).toBe("Trussell");
    expect((ld.parentOrganization as Record<string, unknown>)["@id"]).toBe("https://www.givefood.org.uk/needs/at/salisbury/");
    expect(ld.seeks).toEqual([
      { "@type": "Demand", itemOffered: { "@type": "Product", name: "Tinned Meat" } },
      { "@type": "Demand", itemOffered: { "@type": "Product", name: "" } },
      { "@type": "Demand", itemOffered: { "@type": "Product", name: "Pasta" } },
      { "@type": "Demand", itemOffered: { "@type": "Product", name: "Rice" } },
    ]);
  });

  // A closed food bank's location page is noindex'd and says so on the page.
  // Both come off `foodbank.is_closed`, which reaches the template through the
  // spread -- a handler that rebuilt the foodbank object field by field would
  // drop it and quietly let closed food banks back into the index.
  it("marks a closed food bank's location noindex and says so on the page", async () => {
    const html = await body("/needs/at/closed-town/shut/");

    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('<p class="tag is-danger is-large">This food bank is closed</p>');
  });

  // The Unknown sentinel takes the page's other branch: no need list, no
  // subscribe form, and the contacts/charity block instead. There is also no
  // RSS alternate, because there is nothing to feed.
  it("switches to the contacts branch for an Unknown need, and drops the RSS alternate", async () => {
    const html = await body("/needs/at/closed-town/shut/");

    expect(html).not.toContain("is currently requesting the following items");
    expect(html).not.toContain("rss.xml");
    expect(html).toContain('<div class="contacts">');
  });

  // The Facebook sentinel takes the third branch: the FB SDK embed, whose
  // script src carries the module's FACEBOOK_LOCALES value. That map is the
  // only reason `facebook_locale` is in the context at all, and ga/gd collapse
  // to en_GB where cy does not.
  it("embeds the Facebook page, with the SDK locale the map gives", async () => {
    const en = await body("/needs/at/fb-town/fb-centre/");
    const cy = await body("/cy/needs/at/fb-town/fb-centre/");
    const gd = await body("/gd/needs/at/fb-town/fb-centre/");

    expect(en).toContain("<p>You can find out what FB Town Foodbank is requesting to have donated on their Facebook page:</p>");
    expect(en).toContain('src="https://connect.facebook.net/en_GB/sdk.js#xfbml=1&version=v16.0');
    expect(cy).toContain('src="https://connect.facebook.net/cy_GB/sdk.js#xfbml=1&version=v16.0');
    expect(gd).toContain('src="https://connect.facebook.net/en_GB/sdk.js#xfbml=1&version=v16.0');
    expect(en).toContain('data-href="https://www.facebook.com/fbtown"');
  });

  // "" AND NOT "Nothing" for a food bank with no latest need at all -- the
  // module's own comment calls this out, and it is not cosmetic: "" passes
  // location.njk's `!= "Unknown" and != "Nothing"` gate, so a food bank with
  // NO need record renders the full "is currently requesting the following
  // items to be donated:" heading above an EMPTY list, plus a subscribe form.
  // Suspect, pinned: Django reaches the same page by a different route (its
  // template swallows the attribute error on a null latest_need), so the port
  // is faithful in effect and the oddity is upstream.
  it("renders the requesting-these-items heading above an empty list when there is no need record at all", async () => {
    const html = await body("/needs/at/cardiff/amesbury/");

    expect(html).toContain("<p>Cardiff Foodbank is currently requesting the following items to be donated:</p>");
    expect(html).toMatch(/<p class="needs">\s*<\/p>/);
    expect(html).toContain('<div class="subscribe">');
    expect(html).not.toContain("They don't need any more");
  });

  // SUSPECT, PINNED. wfbn/foodbank/includes/ctas.njk reads a BARE
  // `bankuet_url`, which routes/wfbn/foodbank.ts passes and this handler does
  // not -- so on a location page for a food bank with a bankuet_slug the
  // button renders with an empty href. Django's ctas.html reads
  // `{{ foodbank.bankuet_url }}`, a model method that is always available, so
  // this is a port regression rather than inherited behaviour. Asserted as it
  // stands (a red test helps nobody) and reported.
  it("renders the Bankuet button with an empty href on a location page (suspect, pinned)", async () => {
    const html = await body("/needs/at/salisbury/amesbury/");

    expect(html).toContain('<a href="" class="button is-info is-small is-light" id="bankuet_btn">Bankuet</a>');
    // The Donate button beside it DOES get its href here, because this handler
    // passes url_with_ref -- so the empty one above is a missing variable, not
    // a broken partial.
    expect(hrefWithClass(html, "button is-info is-medium is-light")).toBe("https://salisburyfoodbank.invalid/?ref=givefood.org.uk");
  });
});

describe("wfbnFoodbankLocation -- locale", () => {
  // fullNameLocaleAware, end to end and in the two shapes that differ: cy
  // PREFIXES "Banc Bwyd" when there is no alt_name, and returns the alt_name
  // verbatim (no prefix, no suffix) when there is one.
  it("uses the locale-aware food bank name everywhere the page names it", async () => {
    const salisbury = await body("/cy/needs/at/salisbury/amesbury/");
    const cardiff = await body("/cy/needs/at/cardiff/amesbury/");

    expect(pageTitle(salisbury)).toBe("Amesbury Centre - Banc Bwyd Salisbury - Give Food");
    expect(meta(salisbury, "og:title")).toBe("Amesbury Centre, Banc Bwyd Salisbury");
    expect(pageJsonLd(salisbury).name).toBe("Amesbury Centre, Banc Bwyd Salisbury");
    expect(pageTitle(cardiff)).toBe("Amesbury Hall - Banc Bwyd Caerdydd - Give Food");
  });

  // The translated need list wins on cy, and the ga row for the SAME need must
  // not: getNeedTranslation binds the language, and a lookup that dropped it
  // would return whichever row came first.
  it("renders the Welsh translation of the need, not another language's row", async () => {
    const html = await body("/cy/needs/at/salisbury/amesbury/");

    expect(html).toContain("Cig Tun<br>Pasta");
    expect(html).not.toContain("Feoil Stánaithe");
    expect(html).toContain("<p>Nid oes angen mwy arnynt Ffa Pob.</p>");
  });

  // English never queries the translation table at all (FoodbankChange
  // .get_text()'s `current_language == "en"` branch reads the raw columns), so
  // the absence of the query is the assertion.
  it("never looks up a translation on the English page", async () => {
    await get("/needs/at/salisbury/amesbury/");

    expect(handlerQueries().some((q) => q.sql.includes("foodbankchangetranslation"))).toBe(false);
  });

  it("looks the translation up by need id and language on a prefixed page", async () => {
    await get("/cy/needs/at/salisbury/amesbury/");

    const lookup = handlerQueries().find((q) => q.sql.includes("foodbankchangetranslation"));
    expect(lookup?.sql).toBe("SELECT change_text, excess_change_text FROM foodbankchangetranslation WHERE language = ? AND need_id = ?");
    expect(lookup?.params).toEqual(["cy", 1]);
  });

  it("stamps Content-Language and the locale-prefixed alternates", async () => {
    const res = await get("/gd/needs/at/salisbury/amesbury/");
    const html = await res.text();

    expect(res.headers.get("Content-Language")).toBe("gd");
    expect(html).toContain('<link rel="alternate" hreflang="cy" href="https://www.givefood.org.uk/cy/needs/at/salisbury/amesbury/">');
    expect(html).toContain('<link rel="alternate" hreflang="en" href="https://www.givefood.org.uk/needs/at/salisbury/amesbury/">');
  });

  // SUSPECT, PINNED. `wfbn:foodbank_location_map` is in @givefood/urls'
  // I18N_SCOPED set, so og:image gets a /cy/ prefix -- but index.ts mounts
  // mediaApp at "/needs" only, outside the per-locale loop, so no
  // locale-prefixed map.png route exists and the URL 404s. Every Welsh, Irish
  // and Gaelic location page therefore advertises a social-card image that is
  // not there. Asserted as it stands, both halves, and reported.
  it("advertises a locale-prefixed og:image that does not resolve (suspect, pinned)", async () => {
    const html = await body("/cy/needs/at/salisbury/amesbury/");

    expect(meta(html, "og:image")).toBe("https://www.givefood.org.uk/cy/needs/at/salisbury/amesbury/map.png");
    expect((await get("/cy/needs/at/salisbury/amesbury/map.png")).status).toBe(404);
    // The English one, which is the same code path minus the prefix, is fine.
    expect(meta(await body("/needs/at/salisbury/amesbury/"), "og:image")).toBe("https://www.givefood.org.uk/needs/at/salisbury/amesbury/map.png");
  });
});

describe("wfbnFoodbankLocation -- the response envelope and D1 traffic", () => {
  // ONE SESSION FOR EVERY QUERY THE HANDLER MAKES. lib/session.ts opens a
  // single withSession("first-unconstrained") per request precisely so the
  // batched read and the location lookup see one consistent snapshot of a
  // replicated database; a handler that opened one per query would render
  // identically and pass every other test in this file.
  //
  // THE STATEMENTS, IN ORDER, WITH THEIR BINDINGS -- AND THE TRIPS THEY CAME
  // IN. Since github #52 item 3 the service-area count is the THIRD statement
  // of getFoodbankBySlugWithServiceArea's batch rather than a fourth,
  // separately-awaited one: three statements in one wait, then the location
  // lookup. Two waits, where an English page used to take three.
  //
  // It moved from `foodbank_id = ?` bound to the id to a scalar subquery on
  // the SLUG, and that is the enabling trick rather than a rewrite for its own
  // sake -- the id it used to bind is only known once THIS batch's first
  // result is back, so the id-keyed spelling could never have joined it.
  it("reads everything through one session, in two round trips, with the slug bound to every lookup", async () => {
    await get("/needs/at/salisbury/amesbury/");

    const queries = handlerQueries();
    expect(new Set(queries.map((q) => q.session)).size).toBe(1);
    expect(queries.map((q) => [q.sql, q.params])).toEqual([
      ["SELECT * FROM foodbank WHERE slug = ?", ["salisbury"]],
      ["SELECT * FROM foodbankchange_full WHERE id = (SELECT latest_need_id FROM foodbank WHERE slug = ?)", ["salisbury"]],
      [
        "SELECT COUNT(*) AS n FROM foodbanklocation l WHERE l.foodbank_id = (SELECT id FROM foodbank WHERE slug = ?) " +
          "AND l.boundary_geojson IS NOT NULL AND l.boundary_geojson != ''",
        ["salisbury"],
      ],
      ["SELECT * FROM foodbanklocation_full WHERE slug = ? AND foodbank_slug = ?", ["amesbury", "salisbury"]],
    ]);
    expect(handlerTrips().map((t) => t.length)).toEqual([3, 1]);
  });

  // THE TWO PAGE HANDLERS IN THIS FILE NO LONGER DISAGREE, and the disagreement
  // they used to have was this one's bug. The test that stood here pinned
  // wfbnFoodbankLocation as issuing the count with no `no_locations !== 0`
  // guard, on the stated grounds that "Django has no such guard on either
  // view". THAT WAS WRONG, and it is the same wrong claim #52's own verifier
  // made and 9464049's commit message corrected. givefood/models/foodbank.py:296:
  //
  //     def has_service_area(self):
  //         if self.no_locations == 0:
  //             return False
  //
  // One definition, on the model, reached by every view that renders the flag
  // -- foodbank_location included. So the guard is not a property of one
  // handler; it is a property of has_service_area, and github #52 item 3 moved
  // it to where the flag is computed, which fixes this page by construction.
  //
  // A BEHAVIOUR CHANGE, NARROWLY: for a food bank whose cached no_locations is
  // a stale 0 while a location really does carry a boundary, this page used to
  // show a service area and now does not -- converging on the Python. Checked
  // read-only against production before making it: 0 of 1,070 food banks are in
  // that state, so no live page moves. The count still goes out (it has to --
  // no_locations arrives in the same batch), so the ANSWER is the only
  // observable, and the answer is what this asserts.
  it("hides the service area when the parent's no_locations is 0, even though a location has a boundary", async () => {
    // closed-town: no_locations = 0, and now a location with a real boundary.
    db.prepare("UPDATE foodbanklocation SET boundary_geojson = ? WHERE id = 15").run(BOUNDARY);

    const html = await body("/needs/at/closed-town/shut/");

    expect(handlerQueries().some((q) => q.sql.startsWith("SELECT COUNT(*) AS n FROM foodbanklocation"))).toBe(true);
    expect(html).not.toContain("Service area<br>");
    expect(html).not.toContain("serviceareadisclaimer");
  });

  // The other half, without which the guard test above could pass on a
  // hardcoded `false`: correct the counter, change nothing else, and the same
  // boundary on the same row lights both partials up.
  it("shows it for the same rows once the stale counter is corrected", async () => {
    db.prepare("UPDATE foodbanklocation SET boundary_geojson = ? WHERE id = 15").run(BOUNDARY);
    db.prepare("UPDATE foodbank SET no_locations = 1 WHERE slug = 'closed-town'").run();

    const html = await body("/needs/at/closed-town/shut/");

    expect(html).toContain('<div class="deliveryarea"></div> Service area<br>');
  });

  // Django's foodbank_location carried @cache_page(SECONDS_IN_DAY) -- twice
  // over, in fact, a known pre-existing bug the port does not reproduce.
  // middleware/pageCacheControl.ts's default family is the day, and the
  // browser gets five minutes rather than Django's day (a deliberate
  // divergence recorded in that file: an unpurgeable browser cache must not
  // hold a stale shopping list).
  it("serves cacheable HTML for a day at the edge, five minutes in the browser", async () => {
    const res = await get("/needs/at/salisbury/amesbury/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    expect(res.headers.get("Cache-Tag")).toBe("fb-salisbury");
    expect(res.headers.get("Server-Timing")).toMatch(/^render;dur=/);
  });

  // middleware/geoJsonPreload.ts recognises this route template and hints the
  // food bank's feed -- the file the map JS fetches the moment the page loads.
  // crossorigin=anonymous is the whole point (ticket #11); without it the
  // browser discards the preload and fetches the feed twice.
  it("carries the geojson preload hint, with the crossorigin token that makes it usable", async () => {
    const res = await get("/needs/at/salisbury/amesbury/");

    expect(res.headers.get("Link")).toBe("</needs/at/salisbury/geo.json>; rel=preload; as=fetch; crossorigin=anonymous");
  });

  // SUSPECT, PINNED, and not this module's bug: geoJsonPreload matches on
  // Hono's route template, and index.ts registers the locale variants as
  // separate routes, so "/cy/needs/at/:slug/:locslug/" matches no literal in
  // that middleware. Django's own resolve() strips the prefix and DOES send
  // the header on Welsh pages. Recorded in middleware/geoJsonPreload.test.ts
  // too; asserted here because this is one of the pages it costs.
  // github #30: this asserted null, "(suspect, pinned)". The location detail
  // page is the one that reaches the middleware through the catch-all
  // `/needs/at/:slug/:locslug/` route, registered LAST -- so it is the route
  // most likely to be missed by a fix written against the tidier literals,
  // and the reason it is asserted here rather than only in the middleware's
  // own suite.
  it("preloads the parent food bank's geojson on a locale-prefixed location page", async () => {
    expect((await get("/cy/needs/at/salisbury/amesbury/")).headers.get("Link")).toBe(
      "</cy/needs/at/salisbury/geo.json>; rel=preload; as=fetch; crossorigin=anonymous",
    );
  });
});

// ===========================================================================
// wfbnFoodbankDonationpoint
// ===========================================================================

describe("wfbnFoodbankDonationpoint -- which row, if any", () => {
  // Same collision as the location leg, same reasoning: donation points 21 and
  // 23 share the slug "tesco-extra" under different food banks, and a lookup
  // that dropped the foodbank_slug bind would serve Salisbury's Tesco under
  // Cardiff's breadcrumb.
  it("resolves the donation point slug within its own food bank", async () => {
    const salisbury = await body("/needs/at/salisbury/donationpoint/tesco-extra/");
    const cardiff = await body("/needs/at/cardiff/donationpoint/tesco-extra/");

    expect(pageTitle(salisbury)).toBe("Tesco Extra - Salisbury Foodbank - Give Food");
    expect(pageTitle(cardiff)).toBe("Cardiff Co-op - Cardiff Foodbank - Give Food");
    expect(meta(salisbury, "geo.position")).toBe("51.3811,-2.3590");
    expect(meta(cardiff, "geo.position")).toBe("51.48,-3.18");
  });

  it("404s on an unknown food bank slug, without looking the donation point up", async () => {
    const res = await get("/needs/at/nope/donationpoint/tesco-extra/");

    expect(res.status).toBe(404);
    expect(handlerQueries().some((q) => q.sql.includes("foodbankdonationpoint_full"))).toBe(false);
  });

  it("404s on an unknown donation point slug, and on one belonging to another food bank", async () => {
    expect((await get("/needs/at/salisbury/donationpoint/nope/")).status).toBe(404);
    expect((await get("/needs/at/cardiff/donationpoint/corner-shop/")).status).toBe(404);
  });

  it("does not answer a POST", async () => {
    expect((await get("/needs/at/salisbury/donationpoint/tesco-extra/", { method: "POST" })).status).toBe(404);
  });
});

describe("wfbnFoodbankDonationpoint -- the opening-hours preload header", () => {
  // THE HEADER THIS ROUTE EXISTS TO GET RIGHT. Three separate things are
  // asserted at once and all three have been wrong in this codebase's history:
  // the angle-bracketed URI, the three parameters, and crossorigin=anonymous
  // -- without which the browser issues the preload in no-cors mode, throws it
  // away, and refetches the fragment (ticket #11).
  it("preloads the opening-hours fragment in the same mode csi.js will fetch it", async () => {
    const res = await get("/needs/at/salisbury/donationpoint/tesco-extra/");

    expect(res.headers.get("Link")).toBe(
      "</needs/at/salisbury/donationpoint/tesco-extra/openinghours/>; rel=preload; as=fetch; crossorigin=anonymous",
    );
  });

  // The same URL the page's own data-include uses -- they are one variable in
  // the handler for exactly this reason, and a preload for a URL the page does
  // not then request is worse than no preload.
  it("hints the same URL the page's data-include will actually request", async () => {
    const res = await get("/needs/at/salisbury/donationpoint/tesco-extra/");
    const html = await res.text();
    const hinted = /^<([^>]+)>/.exec(res.headers.get("Link") ?? "")?.[1];

    expect(hinted).toBe("/needs/at/salisbury/donationpoint/tesco-extra/openinghours/");
    expect(html).toContain(`<p data-include="${hinted}" data-update="3600"></p>`);
  });

  it("prefixes the hinted URL on a locale page, where the fragment route really is registered", async () => {
    const res = await get("/cy/needs/at/salisbury/donationpoint/tesco-extra/");

    expect(res.headers.get("Link")).toBe(
      "</cy/needs/at/salisbury/donationpoint/tesco-extra/openinghours/>; rel=preload; as=fetch; crossorigin=anonymous",
    );
    // ...and unlike the location page's og:image map.png, this one resolves.
    expect((await get("/cy/needs/at/salisbury/donationpoint/tesco-extra/openinghours/")).status).toBe(200);
  });

  // No hours, no fragment, no hint. Donation point 23 has opening_hours NULL.
  it("sends no hint at all when the donation point has no opening hours", async () => {
    const res = await get("/needs/at/cardiff/donationpoint/tesco-extra/");

    expect(res.headers.get("Link")).toBeNull();
    expect(await res.text()).not.toContain('data-update="3600"');
  });

  // SUSPECT, PINNED, and the reason the handler's guard is `.trim()`ed: a
  // whitespace-only opening_hours is falsy to the HEADER guard but truthy to
  // the TEMPLATE's `{% if donationpoint.opening_hours %}`, so this page
  // renders a data-include for a fragment that was never hinted -- and the
  // fragment route itself answers 200 with an empty table, since its own guard
  // is a bare truthiness check. Harmless but genuinely inconsistent; asserted
  // as it stands.
  it("renders the fragment include but no hint for whitespace-only opening hours (suspect, pinned)", async () => {
    const res = await get("/needs/at/salisbury/donationpoint/blank-hours/");
    const html = await res.text();

    expect(res.headers.get("Link")).toBeNull();
    expect(html).toContain('<p data-include="/needs/at/salisbury/donationpoint/blank-hours/openinghours/" data-update="3600"></p>');
    expect((await get("/needs/at/salisbury/donationpoint/blank-hours/openinghours/")).status).toBe(200);
  });

  // middleware/geoJsonPreload.ts must not clobber this. That middleware runs
  // after the handler and sets Link on the five route templates it knows; this
  // route is deliberately not among them, so an implementation that hoisted
  // its `headers.set` out of its `if` would delete a preload this page depends
  // on and still pass every test in its own file.
  it("keeps its own Link header past the geojson preload middleware", async () => {
    const res = await get("/needs/at/salisbury/donationpoint/tesco-extra/");

    expect(res.headers.get("Link")).not.toContain("geo.json");
    expect(res.headers.get("Link")).toContain("openinghours");
  });
});

describe("wfbnFoodbankDonationpoint -- the rendered page", () => {
  it("builds the head from the donation point name and the food bank's full name", async () => {
    const html = await body("/needs/at/salisbury/donationpoint/tesco-extra/");

    expect(pageTitle(html)).toBe("Tesco Extra - Salisbury Foodbank - Give Food");
    expect(meta(html, "og:title")).toBe("Tesco Extra, Salisbury Foodbank");
    expect(meta(html, "geo.placename")).toBe("Tesco Extra - Salisbury Foodbank");
    expect(html).toContain('<link rel="alternate" type="text/markdown" href="/md/needs/at/salisbury/donationpoint/tesco-extra/">');
  });

  // A DJANGO BUG PRESERVED VERBATIM, and donationpoint.njk says so in a
  // comment: the original donationpoint.html interpolates `{{ foodbank }}`
  // (the bare model __str__, i.e. the name without the " Foodbank" suffix) and
  // `{{ location }}`, a variable this view has never set. Both render exactly
  // as they do in Django -- the second as nothing at all, leaving the double
  // space. Pinned so that a future fix is a deliberate decision rather than a
  // tidy-up of something that merely looks broken.
  it("keeps Django's own broken meta description, empty gap and all", async () => {
    const html = await body("/needs/at/salisbury/donationpoint/tesco-extra/");

    expect(meta(html, "og:description")).toBe("Find what Salisbury food bank in  is requesting to have donated");
    expect(meta(html, "description")).toBe("Find what Salisbury food bank in  is requesting to have donated");
  });

  // gfwfbn/views.py:958-962 sets has_need False for exactly Unknown, Nothing
  // and Facebook -- so all three are fixtured, each under its own food bank.
  // ONE IS NOT ENOUGH: the check is a chain of three !== comparisons and
  // dropping any single link is invisible unless that particular sentinel has
  // a donation point to render. The introductory sentence stays either way, so
  // the whole difference is one trailing clause and the subscribe form.
  it("hides the need list for every one of the three sentinel need texts", async () => {
    const cases = [
      ["/needs/at/closed-town/donationpoint/corner-shop/", '<p>Corner Shop is a donation point for <a href="/needs/at/closed-town/">Closed Town Foodbank</a>. </p>'],
      ["/needs/at/fb-town/donationpoint/fb-store/", '<p>FB Store is a donation point for <a href="/needs/at/fb-town/">FB Town Foodbank</a>. </p>'],
      ["/needs/at/nothing-town/donationpoint/no-need-shop/", '<p>No Need Shop is a donation point for <a href="/needs/at/nothing-town/">Nothing Town Foodbank</a>. </p>'],
    ] as const;

    for (const [path, sentence] of cases) {
      const html = await body(path);
      expect(html, path).toContain(sentence);
      expect(html, path).not.toContain("Here they are requesting to have donated...");
      expect(html, path).not.toContain('<div class="subscribe">');
    }
  });

  // "" IS NOT ONE OF THE THREE SENTINELS, so a food bank with no need record
  // at all comes out has_need = TRUE and the page invites the reader to donate
  // a list that is empty. Same "" fallback as the location leg, one step
  // further along -- and this one IS a divergence from Django, whose
  // `foodbank.latest_need.change_text` raises inside the view on a null
  // latest_need rather than reaching the template. Suspect, pinned.
  it("claims a food bank with no need record is requesting items (suspect, pinned)", async () => {
    const html = await body("/needs/at/cardiff/donationpoint/tesco-extra/");

    expect(html).toContain("Here they are requesting to have donated...");
    expect(html).toMatch(/<p class="needs">\s*<\/p>/);
  });

  // The need list itself, when there is one, plus the excess line -- the same
  // resolveNeedDisplay output as the location leg, proving both pages share it.
  it("renders the need list and excess items when the food bank has a real need", async () => {
    const html = await body("/needs/at/salisbury/donationpoint/tesco-extra/");

    expect(html).toContain("Tinned Meat<br>Pasta<br>Rice");
    expect(html).toContain("<p>They don't need any more Baked Beans, Soup.</p>");
  });

  // The donation point's own flags and free text, each off its own column.
  it("shows the donation point's notes, in-store-only warning and accessibility flag", async () => {
    const html = await body("/needs/at/salisbury/donationpoint/tesco-extra/");

    expect(html).toContain("<p>📝 Ask at the kiosk</p>");
    expect(html).toContain("⚠️ Only accepts in-store purchases as donations");
    expect(html).toContain("<p>♿ Wheelchair accessible</p>");
  });

  it("omits those three when the columns are empty", async () => {
    const html = await body("/needs/at/closed-town/donationpoint/corner-shop/");

    expect(html).not.toContain("📝");
    expect(html).not.toContain("Only accepts in-store purchases");
    expect(html).not.toContain("Wheelchair accessible");
  });

  // FoodbankDonationPoint.url_with_ref() strips the known tracking parameters
  // BEFORE adding ref (unlike the food bank version, which only merges) --
  // `keep=yes` survives, `utm_source` does not.
  it("strips tracking parameters from the store link and adds the referrer tag", async () => {
    const html = await body("/needs/at/salisbury/donationpoint/tesco-extra/");

    expect(hrefWithClass(html, "website")).toBe("https://tesco.invalid/store/1?keep=yes&amp;ref=givefood.org.uk");
    expect(hrefWithClass(html, "phone")).toBe("tel:+441722 999888");
  });

  it("renders no store link at all for a donation point with no url", async () => {
    const html = await body("/needs/at/closed-town/donationpoint/corner-shop/");

    expect(hrefWithClass(html, "website")).toBeNull();
  });

  // Same lat_lng-not-latitude/longitude rule as the location leg, and this one
  // has no boundary branch: zoom is always 15 (gfwfbn/views.py:963-969).
  it("centres the map on lat_lng at a fixed zoom of 15", async () => {
    const html = await body("/needs/at/salisbury/donationpoint/tesco-extra/");

    expect(mapConfig(html)).toEqual({
      geojson: "/needs/at/salisbury/geo.json",
      lat: 51.3811,
      lng: -2.359,
      zoom: 15,
      location_marker: false,
    });
    // ...while the meta tags still print the disagreeing raw columns.
    expect(meta(html, "place:location:latitude")).toBe("11.1");
  });

  // The JSON-LD. Note `url` here is the RAW stored url, tracking parameters
  // and all, while the visible link above is the stripped one -- two different
  // values from one column, so neither can be asserted by assuming the other.
  it("publishes the donation point's schema.org block, with the untouched store url", async () => {
    const ld = pageJsonLd(await body("/needs/at/salisbury/donationpoint/tesco-extra/"));

    expect(ld["@type"]).toBe("Place");
    expect(ld.name).toBe("Tesco Extra");
    expect(ld.url).toBe("https://tesco.invalid/store/1?utm_source=newsletter&keep=yes");
    expect(ld.telephone).toBe("01722 999888");
    expect(ld.isAccessibleForFree).toBe(true);
    expect(ld.location).toEqual({ "@type": "Place", geo: { "@type": "GeoCoordinates", latitude: 51.3811, longitude: -2.359 } });
    expect(ld.address).toEqual({
      "@type": "PostalAddress",
      postalCode: "SP4 4DD",
      addressCountry: "England",
      streetAddress: "5 Retail Park",
      addressLocality: "Salisbury",
    });
    // The nested food bank, whose `name` is the locale-aware full name this
    // handler computed -- the one value the sub-schema does not read off the
    // row itself, and so the one a wrong argument would silently replace.
    expect(ld.parentOrganization).toMatchObject({
      "@id": "https://www.givefood.org.uk/needs/at/salisbury/",
      name: "Salisbury Foodbank",
      identifier: "1147244",
    });
  });

  // SUSPECT, PINNED, and worse than the location page's version of the same
  // fault: this handler passes NEITHER `url_with_ref` NOR `bankuet_url`, and
  // ctas.njk reads both as bare variables, so the primary "Donate" call to
  // action on every donation point page has an empty href. Django's ctas.html
  // reads `{{ foodbank.url_with_ref }}` off the model and always has a value.
  it("renders both call-to-action buttons with empty hrefs (suspect, pinned)", async () => {
    const html = await body("/needs/at/salisbury/donationpoint/tesco-extra/");

    expect(html).toContain('<a href="" class="button is-info is-medium is-light" id="donate_btn">Donate</a>');
    expect(html).toContain('<a href="" class="button is-info is-small is-light" id="bankuet_btn">Bankuet</a>');
  });

  // The menu partial highlights the section its handler declares --
  // "donationpoints" here, "locations" on the location leg. One string each,
  // and getting one wrong moves the highlight to another page's tab.
  it("marks the right menu tab active on each of the two pages", async () => {
    const dp = await body("/needs/at/salisbury/donationpoint/tesco-extra/");
    const loc = await body("/needs/at/salisbury/amesbury/");

    expect(dp).toContain('<a class="is-active" href="/needs/at/salisbury/donationpoints/">Donation points</a>');
    expect(loc).toContain('<a class="is-active" href="/needs/at/salisbury/locations/">Locations</a>');
  });
});

describe("wfbnFoodbankDonationpoint -- D1 traffic and the response envelope", () => {
  // The same two round trips as its sibling above: the food bank, its latest
  // need and the service-area count in one batch, then the donation-point
  // lookup. The count is bound to the SLUG, which is what let it into the
  // batch at all -- see wfbnFoodbankLocation's own D1-traffic test.
  it("reads everything through one session, in two round trips, with the slug bound to every lookup", async () => {
    await get("/needs/at/salisbury/donationpoint/tesco-extra/");

    const queries = handlerQueries();
    expect(new Set(queries.map((q) => q.session)).size).toBe(1);
    expect(queries.map((q) => [q.sql, q.params])).toEqual([
      ["SELECT * FROM foodbank WHERE slug = ?", ["salisbury"]],
      ["SELECT * FROM foodbankchange_full WHERE id = (SELECT latest_need_id FROM foodbank WHERE slug = ?)", ["salisbury"]],
      [
        "SELECT COUNT(*) AS n FROM foodbanklocation l WHERE l.foodbank_id = (SELECT id FROM foodbank WHERE slug = ?) " +
          "AND l.boundary_geojson IS NOT NULL AND l.boundary_geojson != ''",
        ["salisbury"],
      ],
      ["SELECT * FROM foodbankdonationpoint_full WHERE slug = ? AND foodbank_slug = ?", ["tesco-extra", "salisbury"]],
    ]);
    expect(handlerTrips().map((t) => t.length)).toEqual([3, 1]);
  });

  // THE GUARD, WHICH SURVIVED github #52 ITEM 3 AS AN ANSWER RATHER THAN AS A
  // SKIPPED QUERY. closed-town has no_locations = 0, so Django's
  // has_service_area() returns False without querying
  // (givefood/models/foodbank.py:296-298). The port used to reproduce that
  // literally, with a `?:` in this handler that skipped the round trip; it
  // cannot now, because no_locations is a column of the very row the batch
  // fetches, so the count always travels and the SHORT CIRCUIT IS ON THE
  // ANSWER. The statement being present is asserted alongside the bare page,
  // because "shows nothing" would also be true of a handler that had quietly
  // stopped computing the flag at all.
  //
  // This page is genuinely reachable in that state -- it is addressed by a
  // donation point, which a food bank with zero LOCATIONS can perfectly well
  // have -- which is why the guard is not theoretical here.
  it("still answers false for a food bank with no locations, with the count in flight", async () => {
    const html = await body("/needs/at/closed-town/donationpoint/corner-shop/");

    expect(handlerQueries().map((q) => q.sql)).toEqual([
      "SELECT * FROM foodbank WHERE slug = ?",
      "SELECT * FROM foodbankchange_full WHERE id = (SELECT latest_need_id FROM foodbank WHERE slug = ?)",
      "SELECT COUNT(*) AS n FROM foodbanklocation l WHERE l.foodbank_id = (SELECT id FROM foodbank WHERE slug = ?) " +
        "AND l.boundary_geojson IS NOT NULL AND l.boundary_geojson != ''",
      "SELECT * FROM foodbankdonationpoint_full WHERE slug = ? AND foodbank_slug = ?",
    ]);
    expect(html).not.toContain("Service area<br>");
  });

  // ...and the guard is doing the work, not an empty table: give closed-town's
  // location a boundary and the answer stays false. This is the case the whole
  // "THE GUARD IS NOT NEGOTIABLE" note in packages/db/src/foodbank.ts exists
  // for, and the one a `count > 0` alone would get wrong.
  it("stays false even when a location really does carry a boundary", async () => {
    db.prepare("UPDATE foodbanklocation SET boundary_geojson = ? WHERE id = 15").run(BOUNDARY);

    const html = await body("/needs/at/closed-town/donationpoint/corner-shop/");

    expect(html).not.toContain("Service area<br>");

    // Non-vacuity: the same row, the same boundary, a corrected counter.
    db.prepare("UPDATE foodbank SET no_locations = 1 WHERE slug = 'closed-town'").run();
    expect(await body("/needs/at/closed-town/donationpoint/corner-shop/")).toContain("Service area<br>");
  });

  it("serves cacheable HTML for a day at the edge, tagged for its food bank", async () => {
    const res = await get("/needs/at/salisbury/donationpoint/tesco-extra/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    expect(res.headers.get("Cache-Tag")).toBe("fb-salisbury");
  });
});

// ===========================================================================
// wfbnFoodbankDonationpointOpeninghours
// ===========================================================================

describe("wfbnFoodbankDonationpointOpeninghours", () => {
  // A BARE FRAGMENT, not a page: donationpoint_openinghours.njk has no
  // {% extends %}, matching the Django template it was ported from. csi.js
  // drops the response straight into the page, so a fragment that started
  // extending page.njk would inject a second whole document into the DOM.
  it("returns a bare table fragment with no page chrome", async () => {
    const html = await body("/needs/at/salisbury/donationpoint/tesco-extra/openinghours/");

    expect(html).not.toContain("<!DOCTYPE html>");
    expect(html).not.toContain("<title>");
    expect(html.trim().startsWith("<span")).toBe(true);
    expect(html.trim().endsWith("</table>")).toBe(true);
  });

  // Django set X-Robots-Tag: noindex on this response (views.py:1004) -- it is
  // a fragment of another page and has no business being a search result of
  // its own.
  it("marks the fragment noindex", async () => {
    const res = await get("/needs/at/salisbury/donationpoint/tesco-extra/openinghours/");

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  // THE SEVEN ROWS START AT TODAY AND WRAP, rather than starting at Monday:
  // opening_hours_days() walks offset 0..6 from now and indexes the stored
  // Monday-first lines by Python weekday. Frozen at Tuesday 8 September 2026,
  // so Monday must come LAST. An off-by-one in either the weekday conversion or
  // the wrap shows up here and essentially nowhere else.
  it("lists seven days starting from today, wrapping past Sunday", async () => {
    const rows = hoursRows(await body("/needs/at/salisbury/donationpoint/tesco-extra/openinghours/"));

    expect(rows.map((r) => r.day)).toEqual(["Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", "Monday"]);
    expect(rows.map((r) => r.text)).toEqual([
      "9:00 AM - 5:00 PM",
      "Closed",
      "9:00 AM - 5:00 PM",
      "9:00 AM - 5:00 PM",
      "10:00 AM - 4:00 PM",
      "Closed",
      "9:00 AM - 5:00 PM",
    ]);
  });

  // Proof the wrap really happened rather than the list being rotated by luck:
  // on the following Sunday the order is Sunday-first.
  it("re-anchors on whatever day it is asked", async () => {
    vi.setSystemTime(new Date("2026-09-13T12:00:00.000Z")); // a Sunday

    const rows = hoursRows(await body("/needs/at/salisbury/donationpoint/tesco-extra/openinghours/"));

    expect(rows.map((r) => r.day)).toEqual(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]);
  });

  // is_open, from the wall clock against today's line. 09:30 is inside
  // Tuesday's 9-5 and 18:00 is outside it; Wednesday is a Closed line. The
  // template's `{% elif donationpoint.is_open == false %}` is what keeps the
  // false case distinct from the null one.
  it("shows an Open tag inside today's hours and a Closed tag outside them", async () => {
    const open = await body("/needs/at/salisbury/donationpoint/tesco-extra/openinghours/");
    expect(open).toContain('<span class="tag is-success is-pulled-right">Open</span>');

    vi.setSystemTime(new Date("2026-09-08T18:00:00.000Z"));
    const shut = await body("/needs/at/salisbury/donationpoint/tesco-extra/openinghours/");
    expect(shut).toContain('<span class="tag is-danger is-pulled-right">Closed</span>');
    expect(shut).not.toContain("is-success");

    vi.setSystemTime(new Date("2026-09-09T12:00:00.000Z")); // Wednesday: Closed
    const wednesday = await body("/needs/at/salisbury/donationpoint/tesco-extra/openinghours/");
    expect(wednesday).toContain('<span class="tag is-danger is-pulled-right">Closed</span>');
  });

  // THE BANK HOLIDAY DIVISION COMES OFF THE DONATION POINT'S OWN COUNTRY, not
  // its food bank's. Donation point 25 belongs to Salisbury (England) but sits
  // in Scotland, and 31 August 2026 is a bank holiday in england-and-wales
  // only -- so with the clock a week before it, the English store's Monday row
  // carries the warning and the Scottish one does not, from identical hours
  // under the same parent. That contrast is the whole test: a handler passing
  // the wrong country still renders seven perfectly plausible rows.
  it("annotates bank holidays using the donation point's own country", async () => {
    vi.setSystemTime(new Date("2026-08-25T10:00:00.000Z")); // Tuesday; Monday 31st is the 7th row

    const english = hoursRows(await body("/needs/at/salisbury/donationpoint/tesco-extra/openinghours/"));
    const scottish = hoursRows(await body("/needs/at/salisbury/donationpoint/glasgow-store/openinghours/"));

    expect(english[6]).toEqual({
      day: "Monday",
      text: '9:00 AM - 5:00 PM <span class="is-size-7">Hours may vary because of Summer bank holiday</span>',
    });
    expect(scottish[6]).toEqual({ day: "Monday", text: "9:00 AM - 5:00 PM" });
  });

  // Both 404 legs the page routes have, plus the third this route adds: a
  // donation point with no opening_hours at all is a 404 rather than an empty
  // table (views.py:999-1000).
  it("404s for an unknown food bank, an unknown donation point, and one with no hours", async () => {
    expect((await get("/needs/at/nope/donationpoint/tesco-extra/openinghours/")).status).toBe(404);
    expect((await get("/needs/at/salisbury/donationpoint/nope/openinghours/")).status).toBe(404);
    expect((await get("/needs/at/closed-town/donationpoint/corner-shop/openinghours/")).status).toBe(404);
  });

  it("404s for a donation point belonging to a different food bank", async () => {
    expect((await get("/needs/at/cardiff/donationpoint/glasgow-store/openinghours/")).status).toBe(404);
  });

  // ONE STATEMENT (github #46). This asserted three, under a comment saying
  // the route "needs neither the need text nor the service area, so it must
  // not pay for either" -- which was half true: it had stopped paying for the
  // service-area count, and was still paying for the food bank row AND its
  // need, both of which it then ignored. `foodbank` was bound, null-checked
  // and never read.
  //
  // The pairing check the deleted call appeared to provide is done by the
  // remaining query, and structurally rather than by luck:
  // foodbankdonationpoint_full derives foodbank_slug by LEFT JOIN, so
  // `WHERE slug = ? AND foodbank_slug = ?` cannot match across food banks and
  // cannot match at all when the parent is missing. The three 404 cases above
  // -- unknown food bank, unknown donation point, donation point belonging to
  // someone else -- are unchanged and still pass, which is the evidence that
  // matters here; this test only says what it now costs.
  it("reads only the donation point, in one statement and one session", async () => {
    await get("/needs/at/salisbury/donationpoint/tesco-extra/openinghours/");

    const queries = handlerQueries();
    expect(new Set(queries.map((q) => q.session)).size).toBe(1);
    expect(queries.map((q) => [q.sql, q.params])).toEqual([
      ["SELECT * FROM foodbankdonationpoint_full WHERE slug = ? AND foodbank_slug = ?", ["tesco-extra", "salisbury"]],
    ]);
  });

  // ...including on a locale page: this handler never calls resolveNeedDisplay,
  // so there is no translation lookup to make.
  it("makes no translation lookup on a locale-prefixed fragment", async () => {
    await get("/cy/needs/at/salisbury/donationpoint/tesco-extra/openinghours/");

    expect(handlerQueries().some((q) => q.sql.includes("foodbankchangetranslation"))).toBe(false);
  });

  // TRANSLATION IS HALF-DONE HERE, AND THAT IS THE CURRENT BEHAVIOUR. The
  // module deliberately leaves day-name and "Closed" translation to the
  // template's `_()`, but the catalogues carry "Closed" and not the seven day
  // names (nor "Open", which is a blocktrans in the same file) -- so a Welsh
  // reader gets "Wedi cau" beside "Tuesday". Checked directly against
  // packages/templates/src/generated/locales/cy.json, which has no Monday..Sunday
  // keys. Asserted as it stands rather than wished into shape.
  it("translates Closed but not the day names on a Welsh fragment (suspect, pinned)", async () => {
    const html = await body("/cy/needs/at/salisbury/donationpoint/tesco-extra/openinghours/");
    const rows = hoursRows(html);

    expect(rows[0]?.day).toBe("Tuesday");
    expect(rows[1]).toEqual({ day: "Wednesday", text: "Wedi cau" });
    expect(html).toContain('<span class="tag is-success is-pulled-right">Open</span>');
  });

  // SUSPECT, PINNED. Django gave this fragment @cache_page(SECONDS_IN_HOUR);
  // middleware/pageCacheControl.ts has no rule for it, so it falls through to
  // the day-long default -- 24x Django's shared TTL on the one response whose
  // contents change at midnight, when its first row stops being today. The page
  // that embeds it re-fetches every 3600s (data-update), which is the number
  // that was chosen to match. Not this module's decision (the TTL table lives
  // in that middleware), recorded here because this is the response it is
  // wrong for.
  it("is cached for a day rather than Django's hour (suspect, pinned)", async () => {
    const res = await get("/needs/at/salisbury/donationpoint/tesco-extra/openinghours/");

    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    expect(res.headers.get("Cache-Tag")).toBe("fb-salisbury");
  });

  it("does not answer a POST", async () => {
    expect((await get("/needs/at/salisbury/donationpoint/tesco-extra/openinghours/", { method: "POST" })).status).toBe(404);
  });
});
