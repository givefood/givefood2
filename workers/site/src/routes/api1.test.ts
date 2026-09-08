import { DatabaseSync } from "node:sqlite";
import { LOCATION_COLUMNS_NARROW } from "@givefood/db";
import { MIGRATIONS_SQL as SCHEMA } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../index";
import type { AppEnv } from "../types";

// routes/api1.ts -- gfapi1, the DEPRECATED v1 API that is still live and still
// consumed. Five endpoints, ported verbatim from gfapi1/views.py including its
// frozen bugs (B4, B6, B8, B12), and until now the only thing standing between
// a wrong number in one of them and a third party's pipeline was that nobody
// had changed the file.
//
// WHY A WRONG VALUE HERE IS INVISIBLE. Every one of these endpoints answers 200
// with a well-formed JSON document whatever it puts in it. A `distance_m`
// computed from the wrong column, a `foodbank_slug` pointing at a URL that
// 404s, a `created` in the wrong datetime shape, a closed food bank that
// silently vanished from the list -- none of them changes the status code, the
// shape, or the size of the response. So nothing below asserts a status and
// stops: every test asserts VALUES, and all six endpoint bodies -- the JSON
// list, the CSV file, the search, the detail, the needs list and one need --
// are asserted whole, field for field.
//
// REAL EVERYTHING. The real root app from src/index.ts (so these run at the
// real mount point, through the real middleware stack, and reach the real 404
// and 500 pages), the real migrations via schema.testkit's MIGRATIONS_SQL, real
// SQLite through node:sqlite behind the real packages/db queries, the real
// @givefood/geo ranking and the real @givefood/serialise formatters. The ONLY
// stub is `fetch`, which is what Google's geocoder is on the other end of --
// the one thing in this file's reach that leaves the machine.
//
// PARITY CLAIMS BELOW WERE RUN, NOT REASONED. Where a comment says Django does
// X, X came out of a Python process on this machine:
//   - django.utils.text.slugify (Django 5.2.6) for every foodbank_slug claim,
//     including slugify(None) == "none";
//   - django.utils.timesince.timesince (same install) for every updated_text;
//   - givefood/utils/geo.py's own distance_meters()/miles(), transcribed and
//     run, for every distance_m and distance_mi expectation -- so those numbers
//     are Python's, and the assertions are a genuine cross-check of the JS
//     haversine rather than a recording of it.
// Where a comment says the port DIVERGES from Django, the same applies: the
// Django side of the comparison was executed.
//
// MUTATION-TESTED, in a copy of the tree OUTSIDE the repo (TESTING.md's
// "several suites were mutation-tested"). 69 mutants across api1.ts,
// lib/timesince.ts, lib/geocode.ts, packages/db, packages/models,
// packages/serialise and packages/geo; 68 killed. A sample, each run rather
// than imagined:
//   - getAllFoodbanks gaining `WHERE is_closed = 0` (B8 "harmonised") -- 7
//   - the candidate scan LOSING `WHERE is_closed = 0` -- 11
//   - Math.trunc on distance_m becoming Math.round -- 1 (which is why the
//     expected metres came from Python, to the whole metre)
//   - R_PYTHON 6367000 -> 6371000, the earthdistance radius -- 2
//   - lat and lng swapped when the query string is split -- 4
//   - the ranked ids sorted numerically before enrichment, and the id-order
//     re-sort deleted from packages/db -- 6 each
//   - an is_uk() check added to the search (B6 "fixed") -- 11
//   - the B4 ValueError caught and turned into a 400 -- 3
//   - the ?limit= default changed from 100 to 1000, and the LIMIT dropped -- 1
//     and 13
//   - `published = 1` dropped from the list query, and ADDED to the detail
//     one -- 5 and 1
//   - DjangoJSONEncoder's 3-digit truncation widened to 6 -- 4
//   - timesince's U+00A0 replaced with a plain space -- 2
//   - a Cache-Control or CORS header added to a response -- 1 each
//   - slugify losing its hyphen trim, or keeping case and underscores -- 1, 4
//   - `foodbank_slug` taken from the view's real slug instead of the name -- 4
//
// ONE MUTANT SURVIVES AND IT IS EQUIVALENT: guarding only the FIRST two
// `latestNeed!` dereferences in the detail handler changes nothing, because
// `need_id: toDashedUuid(foodbank.latestNeed!.need_id)` three lines later
// throws anyway and the response is the same 500. The guard someone would
// actually write -- `if (!foodbank || !foodbank.latestNeed) return
// c.notFound()` -- is killed by 2 tests.
//
// Mutating packages/* needs the workspace links to resolve INSIDE the copy;
// symlinking node_modules wholesale sends them back to the real tree and every
// packages/* mutant silently does nothing. That mistake made 26 mutants read as
// survivors on the first pass, so it is worth knowing about before repeating
// this run.

const ORIGIN = "https://www.givefood.org.uk";

// The location SELECT api_foodbank now sends: every column of
// foodbanklocation_full EXCEPT the boundary blob, and NOT the has_boundary flag
// the food bank PAGE asks for -- this endpoint publishes neither. Built from
// packages/db's own exported fragment rather than retyped, so this file pins
// the SHAPE of the statement (named columns, no blob, view, WHERE) while the
// 38-name list keeps its single definition in packages/db, which has the
// pragma-driven drift detector that holds it to the view's real columns.
const LOCATIONS_SQL = `SELECT ${LOCATION_COLUMNS_NARROW} FROM foodbanklocation_full WHERE foodbank_id = ?`;

type Bindable = null | number | bigint | string | Uint8Array;

// The D1DatabaseSession surface packages/db uses, over node:sqlite -- the same
// shim as routes/api2/foodbanks.test.ts, for the same reason: D1 is async where
// node:sqlite is synchronous and that is the only difference that matters, the
// SQL text, the binding and the NULL semantics being SQLite's on both sides.
//
// `prepared` records the SQL that actually reached the engine. Two endpoints
// here have a documented cost story -- WP 2.5's covering-index candidate scan
// for the search, and "one query, no ORDER BY" for the list -- and a body
// assertion cannot see either.
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
    // getFoodbankBySlug sends the food bank row and its latest need as ONE
    // batch (packages/db/src/foodbank.ts), and indexes straight into the
    // result array -- so this must run the statements in order and return one
    // result per input, in that order.
    batch: async (statements: Array<{ sql: string; params: Bindable[] }>) =>
      statements.map((s) => ({ results: db.prepare(s.sql).all(...s.params), success: true, meta: {} })),
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let prepared: string[];
let fetchMock: ReturnType<typeof vi.fn>;

const GEOCODE_KEY = "test-geocode-key-not-a-real-one";

function env(): AppEnv["Bindings"] {
  return {
    DB: { withSession: () => d1Session(db, prepared) },
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: { get: async () => null, put: async () => {}, delete: async () => {} },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    D1_DATABASE_NAME: "givefood-test",
    GMAP_GEOCODE_KEY: GEOCODE_KEY,
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

const get = (path: string) => app.fetch(new Request(`${ORIGIN}${path}`), env(), execCtx);
const json = async (path: string): Promise<unknown> => JSON.parse(await (await get(path)).text());

// ===========================================================================
// SEEDS
// ===========================================================================

// The two datetime shapes that genuinely coexist in this database, both real:
// Django's own `str(datetime)` (six digits, space separator) for rows the ETL
// copied out of Postgres, and JavaScript's toISOString() for rows this port has
// written since. pyDatetime.ts's header records the count -- 114 of 34,175
// foodbankchange rows were already in the second shape when it was written --
// and both appear below, because the ordering hazard they create is real and
// is pinned in "the ISO-shaped row" test.
const SALISBURY_NEED_CREATED = "2020-01-24 16:30:23.173268";

// Frozen so that `updated_text` (django.utils.timesince) is assertable at all.
// Every expected string in this file was produced by running the real Django
// function against these same two instants.
const NOW = new Date("2026-09-05T12:00:00.000Z");

// THE IDS ARE SCRAMBLED ON PURPOSE. `SELECT * FROM foodbank` has no ORDER BY
// (neither does Django's `Foodbank.objects.all()`), so what comes back is rowid
// order -- which for an INTEGER PRIMARY KEY is id order, not insertion order.
// Assigning ids in seed order would make those two indistinguishable and the
// list body's order assertion vacuous. They are also chosen so that the search
// ranking disagrees with ascending id order; see the two fixture guards below.
const WONKY_ID = 1;
const SALISBURY_ID = 7;
const PERTH_ID = 12;
const ST_MARYS_ID = 30;
const SHUT_ID = 90;

// Real hex uuids, in both the 32-char dashless form the column holds (PLAN.md
// §4.4) and the dashed form toDashedUuid must emit. Written out as two literals
// rather than one derived from the other: the pair IS the contract, and a
// helper that computed one from the other would be the implementation under
// test wearing a false moustache. "the fixture's own uuids are consistent"
// below checks the pairs really do correspond.
const NEED_SALISBURY = { dashless: "0f2fe1cba1f947e9b0e5ec6d1c7f3a01", dashed: "0f2fe1cb-a1f9-47e9-b0e5-ec6d1c7f3a01" };
const NEED_PERTH = { dashless: "1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6", dashed: "1a2b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6" };
const NEED_ST_MARYS = { dashless: "22222222333344445555666677778888", dashed: "22222222-3333-4444-5555-666677778888" };
const NEED_WONKY = { dashless: "aaaaaaaabbbbccccddddeeeeffff0000", dashed: "aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000" };
const NEED_DRAFT = { dashless: "99999999888877776666555544443333", dashed: "99999999-8888-7777-6666-555544443333" };
const NEED_ORPHAN = { dashless: "0123456789abcdef0123456789abcdef", dashed: "01234567-89ab-cdef-0123-456789abcdef" };
const NEED_ISO = { dashless: "fedcba9876543210fedcba9876543210", dashed: "fedcba98-7654-3210-fedc-ba9876543210" };

interface FoodbankSeed {
  id: number;
  slug: string;
  name: string;
  address: string;
  postcode: string;
  country: string;
  latLng: string; // the STRING column, emitted verbatim as `latt_long`
  latitude: number; // the ranking columns -- see WONKY, where the two disagree
  longitude: number;
  url: string;
  shoppingListUrl: string;
  phone: string | null;
  email: string;
  parlcon: string | null;
  mp: string | null;
  mpParty: string | null;
  ward: string | null;
  district: string | null;
  charityNumber: string | null;
  network: string | null;
  isClosed: 0 | 1;
  latestNeedId: number | null;
  lastNeed: string | null;
}

function seedFoodbank(s: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank
       (id, uuid, name, slug, address, postcode, country, lat_lng, latitude, longitude,
        network, charity_number, charity_just_foodbank, contact_email, phone_number,
        url, shopping_list_url,
        parliamentary_constituency_name, parliamentary_constituency_slug, mp, mp_party, ward, district,
        address_is_administrative, is_closed, no_locations, days_between_needs,
        latest_need_id, last_need, created, modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, 0, ?, ?,
        ?, ?,
        ?, 'unused-parlcon-slug', ?, ?, ?, ?,
        0, ?, 0, 14,
        ?, ?, '2019-06-01 09:00:00.000000', '2026-08-14 09:15:00.000000')`,
  ).run(
    s.id,
    `f${String(s.id).padStart(31, "0")}`,
    s.name,
    s.slug,
    s.address,
    s.postcode,
    s.country,
    s.latLng,
    s.latitude,
    s.longitude,
    s.network,
    s.charityNumber,
    s.email,
    s.phone,
    s.url,
    s.shoppingListUrl,
    s.parlcon,
    s.mp,
    s.mpParty,
    s.ward,
    s.district,
    s.isClosed,
    s.latestNeedId,
    s.lastNeed,
  );
}

function seedNeed(
  id: number,
  uuid: string,
  foodbankId: number | null,
  changeText: string,
  published: 0 | 1,
  created: string,
  uri: string | null,
): void {
  db.prepare(
    `INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, uri, published, input_method, created, modified)
     VALUES (?, ?, ?, ?, ?, ?, 'scrape', ?, ?)`,
  ).run(id, uuid, foodbankId, changeText, uri, published, created, created);
}

interface LocationSeed {
  id: number;
  foodbankId: number;
  name: string;
  address: string | null;
  postcode: string | null;
  latLng: string;
  phone: string | null;
  isClosed: 0 | 1;
}

function seedLocation(l: LocationSeed): void {
  db.prepare(
    `INSERT INTO foodbanklocation
       (id, uuid, foodbank_id, name, slug, address, postcode, country, lat_lng, latitude, longitude,
        parliamentary_constituency_name, parliamentary_constituency_slug, mp, mp_party, ward, district,
        is_closed, is_donation_point, phone_number, email, modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'England', ?, 51.08, -1.82,
        'Salisbury', 'salisbury', 'John Glen', 'Conservative', 'Bemerton LocWard', 'Salisbury LocDistrict',
        ?, 0, ?, 'loc@salisburyfoodbank.invalid', '2026-08-15 10:00:00.000000')`,
  ).run(
    l.id,
    `l${String(l.id).padStart(31, "0")}`,
    l.foodbankId,
    l.name,
    `slug-${l.id}`,
    l.address,
    l.postcode,
    l.latLng,
    l.isClosed,
    l.phone,
  );
}

// The search point every /foodbanks/search/ test below uses -- Salisbury's own
// coordinates, so its own food bank is the first result (gfapi1's search does
// NOT skip_first, unlike Foodbank.nearby()).
const QUERY_LAT_LNG = "51.0688,-1.7945";

function seed(): void {
  // Scotland, so charity_register_url takes the OSCR branch. Its name is the
  // one whose Django slugify() and this port's slugify() AGREE, and which also
  // matches its real slug -- the control case for the two that do not.
  seedFoodbank({
    id: PERTH_ID,
    slug: "perth-kinross-foodbank",
    name: "Perth & Kinross Foodbank",
    address: "12 Tay Street\r\nPerth",
    postcode: "PH1 5LQ",
    country: "Scotland",
    latLng: "56.396,-3.437",
    latitude: 56.396,
    longitude: -3.437,
    url: "https://perthfoodbank.invalid/",
    shoppingListUrl: "https://perthfoodbank.invalid/shopping-list/",
    phone: "01738 555000",
    email: "info@perthfoodbank.invalid",
    parlcon: "Perth and Kinross-shire",
    mp: "Pete Wishart",
    mpParty: "Scottish National Party",
    ward: "Perth City Centre",
    district: "Perth and Kinross",
    charityNumber: "SC012345",
    network: "IFAN",
    isClosed: 0,
    latestNeedId: 501,
    lastNeed: null, // -> need_found: null, the one guarded latest_need field
  });

  // The comma in the name is load-bearing twice: it is what QUOTE_MINIMAL has
  // to quote in the CSV, and it is what makes `foodbank_name_slug()`
  // ("trussell-trust-salisbury") differ from the real slug ("salisbury") --
  // in Django exactly as much as here.
  seedFoodbank({
    id: SALISBURY_ID,
    slug: "salisbury",
    name: "Trussell Trust, Salisbury",
    address: "Unit 1\r\nBemerton Heath",
    postcode: "SP2 9DY",
    country: "England",
    latLng: QUERY_LAT_LNG,
    latitude: 51.0688,
    longitude: -1.7945,
    url: "https://salisburyfoodbank.invalid/",
    shoppingListUrl: "https://salisburyfoodbank.invalid/shopping-list/",
    phone: "01722 411900",
    email: "info@salisburyfoodbank.invalid",
    parlcon: "Salisbury",
    mp: "John Glen",
    mpParty: "Conservative",
    ward: "Bemerton Ward",
    district: "Wiltshire",
    charityNumber: "1130136",
    network: "Trussell Trust",
    isClosed: 0,
    latestNeedId: 500,
    lastNeed: "2026-09-01 07:05:00.123456",
  });

  // EVERY OPTIONAL COLUMN NULL: no phone, no politics, no charity number, no
  // network. A serialiser that coalesced a null to "" (or dropped the key)
  // publishes a food bank with no MP as one whose MP is blank, and the CSV
  // consumer downstream cannot tell the two apart either way -- but the JSON
  // one can, and Django sent null.
  //
  // Its name is the DIVERGENT slugify case: Django 5.2.6 gives
  // "st-marys-foodbank" (which is this row's real slug); routes/api1.ts's
  // simplified slugify gives "st-mary-s-foodbank", which is nobody's slug.
  seedFoodbank({
    id: ST_MARYS_ID,
    slug: "st-marys-foodbank",
    name: "St. Mary's Foodbank",
    address: "St Mary's Hall\r\nChurch Road",
    postcode: "SP10 1AA",
    country: "England",
    latLng: "51.2113,-1.4871",
    latitude: 51.2113,
    longitude: -1.4871,
    url: "https://stmarys.invalid/",
    shoppingListUrl: "https://stmarys.invalid/list/",
    phone: null,
    email: "hello@stmarys.invalid",
    parlcon: null,
    mp: null,
    mpParty: null,
    ward: null,
    district: null,
    charityNumber: null,
    network: null,
    isClosed: 0,
    latestNeedId: 512,
    lastNeed: "2026-08-29 12:00:00.000000",
  });

  // THE ROW WHOSE lat_lng STRING AND latitude/longitude COLUMNS DISAGREE.
  // PLAN.md §7.2 records that they can and do on real rows, and this endpoint
  // reads BOTH: the ranking reads the columns (getOpenFoodbankCoordinates),
  // while `latt_long` publishes the string. Django's find_foodbanks() ranks
  // from `foodbank.latt()`/`long()`, which parse the STRING. Seeded closed so
  // it stays out of every other search assertion; the one test that cares
  // opens it. Northern Ireland, so charity_register_url takes the NIC-stripping
  // branch.
  seedFoodbank({
    id: WONKY_ID,
    slug: "wonky-latlng",
    name: "Wonky (Coordinates) Foodbank!",
    address: "3 Bridge Street\r\nBelfast",
    postcode: "BT1 1AA",
    country: "Northern Ireland",
    latLng: "56.396,-3.437", // Perth, 601 km away
    latitude: 51.07, // 341 m away
    longitude: -1.79,
    url: "https://wonky.invalid/",
    shoppingListUrl: "https://wonky.invalid/list/",
    phone: "028 9024 0000",
    email: "info@wonky.invalid",
    parlcon: "Belfast South and Mid Down",
    mp: "Claire Hanna",
    mpParty: "SDLP",
    ward: "Botanic",
    district: "Belfast",
    charityNumber: "NIC101234",
    network: "Trussell Trust",
    isClosed: 1,
    latestNeedId: 530,
    lastNeed: null,
  });

  // CLOSED, AT THE EXACT SEARCH POINT, AND WITH NO LATEST NEED. Three jobs:
  // it must appear in /foodbanks/ (frozen bug B8 -- v1 lists closed food banks
  // where v2 does not); it must never rank into a search (if the candidate
  // query lost its `is_closed = 0` it would be result #1, at distance 0); and
  // /foodbank/shut-foodbank/ is where B12's unguarded `latest_need` crash is
  // reachable, because the detail endpoint has no is_closed filter either.
  // Isle of Man, the fifth charity_register_url branch.
  seedFoodbank({
    id: SHUT_ID,
    slug: "shut-foodbank",
    name: "Shut Foodbank",
    address: "Old Depot\r\nDouglas",
    postcode: "IM1 1AA",
    country: "Isle of Man",
    latLng: QUERY_LAT_LNG,
    latitude: 51.0688,
    longitude: -1.7945,
    url: "https://shut.invalid/",
    shoppingListUrl: "https://shut.invalid/list/",
    phone: "01624 000000",
    email: "info@shut.invalid",
    parlcon: null,
    mp: null,
    mpParty: null,
    ward: "Douglas",
    district: "Douglas Borough",
    charityNumber: "1234567",
    network: null,
    isClosed: 1,
    latestNeedId: null,
    lastNeed: null,
  });

  // MIXED line endings inside change_text, because the real column holds both
  // and because it is the only shape that pins WHICH separator no_items()
  // splits on: split("\n") counts 3, split("\r\n") counts 2, and a fixture with
  // uniform \r\n cannot tell them apart. Django's
  // len(change_text.split('\n')) is 3, so 3 is the parity answer. The \r
  // characters survive into the published `needs` string untouched, on both
  // sides.
  seedNeed(500, NEED_SALISBURY.dashless, SALISBURY_ID, "Tinned tomatoes\r\nUHT milk\nCoffee", 1, SALISBURY_NEED_CREATED, "https://salisburyfoodbank.invalid/shopping-list/");
  // The two sentinels no_items() answers 0 for. "Nothing" would otherwise
  // count as one item, which is the opposite of what it means.
  seedNeed(501, NEED_PERTH.dashless, PERTH_ID, "Nothing", 1, "2026-09-04 10:00:00.000000", null);
  seedNeed(512, NEED_ST_MARYS.dashless, ST_MARYS_ID, "Unknown", 1, "2026-08-29 12:00:00.000000", "https://stmarys.invalid/list/");
  seedNeed(530, NEED_WONKY.dashless, WONKY_ID, "Pasta\r\nRice", 1, "2026-09-05 09:00:00.000000", null);
  // THE ROW THAT MUST BE EXCLUDED from /needs/ -- and that /need/<id>/ serves
  // anyway, because neither view filters on `published` (Django's api_need is a
  // bare get_object_or_404 too).
  seedNeed(540, NEED_DRAFT.dashless, SALISBURY_ID, "Draft crisps", 0, "2026-09-05 11:59:12.000000", null);
  // An orphan: foodbank_id NULL, so foodbankchange_full's LEFT JOIN yields a
  // NULL foodbank_name. Reachable in production -- the column is nullable on
  // both sides (givefood/models/needs.py:58 is null=True) and D1 has no foreign
  // keys.
  seedNeed(550, NEED_ORPHAN.dashless, null, "Soup", 1, "2026-08-01 00:00:00.000000", null);
  // A row THIS PORT wrote: JavaScript's toISOString() shape. Its instant is an
  // hour BEFORE need 530's, and it still sorts above it -- see "the ISO-shaped
  // row" below.
  seedNeed(560, NEED_ISO.dashless, SALISBURY_ID, "Cereal", 1, "2026-09-05T08:00:00.000Z", null);

  // Seeded out of alphabetical order, and one of them belongs to a DIFFERENT
  // food bank. `Foodbank.locations()` is `.order_by("name")` and filtered by
  // food bank; the bystander is named to sort first, so a lost WHERE puts it at
  // the top of Salisbury's list where it cannot be missed.
  seedLocation({ id: 20, foodbankId: SALISBURY_ID, name: "Wilton Road Centre", address: "12 Wilton Road", postcode: "SP2 7EF", latLng: "51.08,-1.82", phone: "01722 222222", isClosed: 0 });
  // No phone of its own. gfapi1's api_foodbank publishes `location.phone_number`
  // raw -- NOT FoodbankLocation.phone(), which falls back to the food bank's
  // number -- so this must come back null and not "01722 411900".
  seedLocation({ id: 21, foodbankId: SALISBURY_ID, name: "Amesbury Library", address: null, postcode: null, latLng: "51.17,-1.78", phone: null, isClosed: 0 });
  // Closed, and still listed: locations() has no is_closed filter, and a food
  // bank's location list does include closed locations in production.
  seedLocation({ id: 22, foodbankId: SALISBURY_ID, name: "Closed Annexe", address: "9 Shut Lane", postcode: "SP1 9ZZ", latLng: "51.09,-1.75", phone: "01722 333333", isClosed: 1 });
  seedLocation({ id: 23, foodbankId: PERTH_ID, name: "Aardvark Hall", address: "1 Aardvark Way", postcode: "PH2 0AA", latLng: "56.4,-3.44", phone: "01738 111111", isClosed: 0 });
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  prepared = [];
  seed();

  // Date only. `updated_text` is django.utils.timesince against `new Date()`,
  // so without this the field is untestable; faking the timers themselves would
  // be gratuitous, since nothing on these paths waits on one.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);

  // The geocoder. Anything that reaches it without a test having said what
  // Google replies is a bug in the test, not a default worth having, so the
  // default reply is a distinctive coordinate rather than a plausible one.
  fetchMock = vi.fn(async () =>
    Response.json({ results: [{ geometry: { location: { lat: 51.0688, lng: -1.7945 } } }] }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ===========================================================================
// THE FIXTURE'S OWN GUARDS
// ===========================================================================

describe("the fixture", () => {
  // toDashedUuid is a pure slice, so a dashed literal that did not actually
  // correspond to its dashless twin would make every id assertion below agree
  // with itself and with nothing else.
  it("pairs each dashless uuid with its real dashed form", () => {
    for (const pair of [NEED_SALISBURY, NEED_PERTH, NEED_ST_MARYS, NEED_WONKY, NEED_DRAFT, NEED_ORPHAN, NEED_ISO]) {
      expect(pair.dashless).toMatch(/^[0-9a-f]{32}$/);
      expect(pair.dashed).toBe(
        `${pair.dashless.slice(0, 8)}-${pair.dashless.slice(8, 12)}-${pair.dashless.slice(12, 16)}-${pair.dashless.slice(16, 20)}-${pair.dashless.slice(20)}`,
      );
    }
  });

  // The list body below asserts an order, and that assertion is only
  // load-bearing while the order it pins is distinguishable from the obvious
  // alternative. seed() writes Perth, Salisbury, St Mary's, Wonky, Shut -- ids
  // 12, 7, 30, 1, 90 -- so "the order they were written in" and "the order the
  // table scan returns them in" are two different answers, and the body test
  // picks one.
  it("is seeded so that rowid order and insertion order disagree", () => {
    const insertion = [PERTH_ID, SALISBURY_ID, ST_MARYS_ID, WONKY_ID, SHUT_ID];
    // The handler's own statement, so this reads the rows exactly as it does --
    // `SELECT id` alone would be answered from whichever index covers it (here
    // foodbank_last_need_idx, giving a third order again), which is not what
    // the endpoint runs.
    const scanned = (db.prepare("SELECT * FROM foodbank").all() as Array<{ id: number }>).map((r) => r.id);

    expect(scanned).toEqual([...insertion].sort((a, b) => a - b));
    expect(scanned).not.toEqual(insertion);
  });

  // The same guard for the search. `WHERE id IN (...)` gives no ordering
  // guarantee and D1 answers it in rowid order, so getFoodbanksByIds re-sorts
  // the rows back into the ranked order its caller asked for. Seed the obvious
  // way -- nearest food bank holding the lowest id -- and the two orders
  // coincide, the re-sort becomes a no-op, and deleting it passes every
  // assertion in this file. It is not hypothetical: the same mutant survived
  // the first version of routes/api2/foodbanks.test.ts. Here the ranking runs
  // Salisbury (id 7), St Mary's (30), Perth (12), which is NOT ascending id
  // order, so the re-sort has to happen for the search body to be right.
  it("is seeded so that ranked order and id order genuinely disagree", () => {
    const rankedIds = [SALISBURY_ID, ST_MARYS_ID, PERTH_ID];

    expect(rankedIds).toEqual([7, 30, 12]);
    expect(rankedIds).not.toEqual([...rankedIds].sort((a, b) => a - b));
  });
});

// ===========================================================================
// GET /api/1/foodbanks/
// ===========================================================================

// The 19 fields of gfapi1/views.py's api_foodbanks, plus "self". Written out
// per row rather than generated from the seed: a helper that built the
// expectation from the same inputs the handler reads would agree with any
// transformation the handler applied to both.
const PERTH_LIST_ENTRY = {
  name: "Perth & Kinross Foodbank",
  slug: "perth-kinross-foodbank",
  url: "https://perthfoodbank.invalid/",
  shopping_list_url: "https://perthfoodbank.invalid/shopping-list/",
  phone: "01738 555000",
  email: "info@perthfoodbank.invalid",
  address: "12 Tay Street\r\nPerth\r\nPH1 5LQ",
  postcode: "PH1 5LQ",
  parliamentary_constituency: "Perth and Kinross-shire",
  mp: "Pete Wishart",
  mp_party: "Scottish National Party",
  ward: "Perth City Centre",
  district: "Perth and Kinross",
  country: "Scotland",
  charity_number: "SC012345",
  charity_register_url: "https://www.oscr.org.uk/about-charities/search-the-register/charity-details?number=SC012345",
  closed: false,
  latt_long: "56.396,-3.437",
  network: "IFAN",
  self: `${ORIGIN}/api/1/foodbank/perth-kinross-foodbank/`,
};

const SALISBURY_LIST_ENTRY = {
  name: "Trussell Trust, Salisbury",
  slug: "salisbury",
  url: "https://salisburyfoodbank.invalid/",
  shopping_list_url: "https://salisburyfoodbank.invalid/shopping-list/",
  phone: "01722 411900",
  email: "info@salisburyfoodbank.invalid",
  address: "Unit 1\r\nBemerton Heath\r\nSP2 9DY",
  postcode: "SP2 9DY",
  parliamentary_constituency: "Salisbury",
  mp: "John Glen",
  mp_party: "Conservative",
  ward: "Bemerton Ward",
  district: "Wiltshire",
  country: "England",
  charity_number: "1130136",
  charity_register_url: "https://register-of-charities.charitycommission.gov.uk/charity-details/?regid=1130136&subid=0",
  closed: false,
  latt_long: "51.0688,-1.7945",
  network: "Trussell Trust",
  self: `${ORIGIN}/api/1/foodbank/salisbury/`,
};

const ST_MARYS_LIST_ENTRY = {
  name: "St. Mary's Foodbank",
  slug: "st-marys-foodbank",
  url: "https://stmarys.invalid/",
  shopping_list_url: "https://stmarys.invalid/list/",
  phone: null,
  email: "hello@stmarys.invalid",
  address: "St Mary's Hall\r\nChurch Road\r\nSP10 1AA",
  postcode: "SP10 1AA",
  parliamentary_constituency: null,
  mp: null,
  mp_party: null,
  ward: null,
  district: null,
  country: "England",
  charity_number: null,
  // Foodbank.charity_register_url() returns None when there is no charity
  // number, whatever the country -- the first guard, not the country branch.
  charity_register_url: null,
  closed: false,
  latt_long: "51.2113,-1.4871",
  network: null,
  self: `${ORIGIN}/api/1/foodbank/st-marys-foodbank/`,
};

const WONKY_LIST_ENTRY = {
  name: "Wonky (Coordinates) Foodbank!",
  slug: "wonky-latlng",
  url: "https://wonky.invalid/",
  shopping_list_url: "https://wonky.invalid/list/",
  phone: "028 9024 0000",
  email: "info@wonky.invalid",
  address: "3 Bridge Street\r\nBelfast\r\nBT1 1AA",
  postcode: "BT1 1AA",
  parliamentary_constituency: "Belfast South and Mid Down",
  mp: "Claire Hanna",
  mp_party: "SDLP",
  ward: "Botanic",
  district: "Belfast",
  country: "Northern Ireland",
  charity_number: "NIC101234",
  // The "NIC" prefix is stripped from the query string but NOT from
  // charity_number itself -- models/foodbank.py does the replace inline in the
  // URL only.
  charity_register_url: "https://www.charitycommissionni.org.uk/charity-details/?regId=101234",
  closed: true,
  latt_long: "56.396,-3.437",
  network: "Trussell Trust",
  self: `${ORIGIN}/api/1/foodbank/wonky-latlng/`,
};

const SHUT_LIST_ENTRY = {
  name: "Shut Foodbank",
  slug: "shut-foodbank",
  url: "https://shut.invalid/",
  shopping_list_url: "https://shut.invalid/list/",
  phone: "01624 000000",
  email: "info@shut.invalid",
  address: "Old Depot\r\nDouglas\r\nIM1 1AA",
  postcode: "IM1 1AA",
  parliamentary_constituency: null,
  mp: null,
  mp_party: null,
  ward: "Douglas",
  district: "Douglas Borough",
  country: "Isle of Man",
  charity_number: "1234567",
  charity_register_url:
    "https://www.gov.im/about-the-government/offices/attorney-generals-chambers/crown-office/charities/index-of-charities-registered-in-the-isle-of-man/",
  closed: true,
  latt_long: "51.0688,-1.7945",
  network: null,
  self: `${ORIGIN}/api/1/foodbank/shut-foodbank/`,
};

describe("GET /api/1/foodbanks/", () => {
  // THE WHOLE BODY, all five rows, in order. Every field is one a wrong join,
  // a dropped null or a swapped column could change without changing the shape
  // -- and `closed: true` on two of the five is frozen bug B8 stated as data:
  // v1 lists closed food banks, v2 does not, and the two must not be
  // "harmonised".
  it("returns every food bank, open or closed, field for field", async () => {
    const res = await get("/api/1/foodbanks/");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    // Rowid order -- ids 1, 7, 12, 30, 90 -- which the fixture guard above
    // makes distinguishable from the order seed() writes them in.
    expect(await res.json()).toEqual([
      WONKY_LIST_ENTRY,
      SALISBURY_LIST_ENTRY,
      PERTH_LIST_ENTRY,
      ST_MARYS_LIST_ENTRY,
      SHUT_LIST_ENTRY,
    ]);
  });

  // Stated separately from the body above because it is the bug, not a detail
  // of it: if someone "fixes" v1 to match v2's open-only list, the assertion
  // that fails should say what was lost.
  it("keeps closed food banks in the list -- frozen bug B8", async () => {
    const body = (await json("/api/1/foodbanks/")) as Array<{ slug: string; closed: boolean }>;

    expect(body.filter((f) => f.closed).map((f) => f.slug)).toEqual(["wonky-latlng", "shut-foodbank"]);
    expect(body).toHaveLength(5);
  });

  // A food bank with `latest_need_id` NULL is listed here without trouble --
  // this endpoint never touches the need. The SAME row 500s on
  // /api/1/foodbank/shut-foodbank/ (see B12 below), which is worth having as
  // one statement: the crash is the detail endpoint's, not the row's.
  it("lists a food bank that has no latest need at all", async () => {
    const body = (await json("/api/1/foodbanks/")) as Array<{ slug: string }>;

    expect(body.map((f) => f.slug)).toContain("shut-foodbank");
    expect((await get("/api/1/foodbank/shut-foodbank/")).status).toBe(500);
  });

  // `?format=` defaults to json and accepts exactly two values. HttpResponseBad
  // Request() is an empty body, and the port matches it -- no JSON error
  // document, no explanation.
  it("400s an unknown format with an empty body", async () => {
    for (const format of ["xml", "JSON", "yaml", "", "csv%20"]) {
      const res = await get(`/api/1/foodbanks/?format=${format}`);
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("");
    }
  });

  it("treats a missing ?format= as json", async () => {
    expect(await (await get("/api/1/foodbanks/")).text()).toBe(await (await get("/api/1/foodbanks/?format=json")).text());
  });

  // ONE QUERY, and specifically not one-per-food-bank. `SELECT * FROM foodbank`
  // with no WHERE and no ORDER BY is what get_all_foodbanks() was.
  it("reads the whole table in a single unordered query", async () => {
    await get("/api/1/foodbanks/");

    expect(prepared).toEqual(["SELECT * FROM foodbank"]);
  });
});

// The CSV body, record by record. `formatCsvRow` is separately and heavily
// tested in packages/serialise/src/csv.test.ts, byte for byte against real
// Python -- what is tested HERE is that this endpoint feeds it the right 19
// values in the right order, which that file cannot see.
//
// Each entry ends with its own \r\n and the addresses contain \r\n of their
// own, so these are joined with "" rather than being split on a line
// terminator: an embedded newline inside a quoted field means the file has
// more physical lines than records, which is exactly the property a consumer's
// naive line-splitter gets wrong and the reason the quoting matters.
const CSV_HEADER =
  "name,slug,url,shopping_list_url,phone,email,address,postcode,parliamentary_constituency," +
  "mp,mp_party,ward,district,country,charity_number,charity_register_url,closed,latt_long,network\r\n";

const CSV_PERTH_RECORD = `Perth & Kinross Foodbank,perth-kinross-foodbank,https://perthfoodbank.invalid/,https://perthfoodbank.invalid/shopping-list/,01738 555000,info@perthfoodbank.invalid,"12 Tay Street\r\nPerth\r\nPH1 5LQ",PH1 5LQ,Perth and Kinross-shire,Pete Wishart,Scottish National Party,Perth City Centre,Perth and Kinross,Scotland,SC012345,https://www.oscr.org.uk/about-charities/search-the-register/charity-details?number=SC012345,False,"56.396,-3.437",IFAN\r\n`;

const CSV_SALISBURY_RECORD = `"Trussell Trust, Salisbury",salisbury,https://salisburyfoodbank.invalid/,https://salisburyfoodbank.invalid/shopping-list/,01722 411900,info@salisburyfoodbank.invalid,"Unit 1\r\nBemerton Heath\r\nSP2 9DY",SP2 9DY,Salisbury,John Glen,Conservative,Bemerton Ward,Wiltshire,England,1130136,https://register-of-charities.charitycommission.gov.uk/charity-details/?regid=1130136&subid=0,False,"51.0688,-1.7945",Trussell Trust\r\n`;

const CSV_ST_MARYS_RECORD = `St. Mary's Foodbank,st-marys-foodbank,https://stmarys.invalid/,https://stmarys.invalid/list/,,hello@stmarys.invalid,"St Mary's Hall\r\nChurch Road\r\nSP10 1AA",SP10 1AA,,,,,,England,,,False,"51.2113,-1.4871",\r\n`;

const CSV_WONKY_RECORD = `Wonky (Coordinates) Foodbank!,wonky-latlng,https://wonky.invalid/,https://wonky.invalid/list/,028 9024 0000,info@wonky.invalid,"3 Bridge Street\r\nBelfast\r\nBT1 1AA",BT1 1AA,Belfast South and Mid Down,Claire Hanna,SDLP,Botanic,Belfast,Northern Ireland,NIC101234,https://www.charitycommissionni.org.uk/charity-details/?regId=101234,True,"56.396,-3.437",Trussell Trust\r\n`;

const CSV_SHUT_RECORD = `Shut Foodbank,shut-foodbank,https://shut.invalid/,https://shut.invalid/list/,01624 000000,info@shut.invalid,"Old Depot\r\nDouglas\r\nIM1 1AA",IM1 1AA,,,,Douglas,Douglas Borough,Isle of Man,1234567,https://www.gov.im/about-the-government/offices/attorney-generals-chambers/crown-office/charities/index-of-charities-registered-in-the-isle-of-man/,True,"51.0688,-1.7945",\r\n`;

// Header, then the same rowid order the JSON body comes back in -- the CSV
// branch walks the SAME response_list, so a divergence in order between the two
// formats would mean one of them had grown a sort of its own.
const CSV_RECORDS = [
  CSV_HEADER,
  CSV_WONKY_RECORD,
  CSV_SALISBURY_RECORD,
  CSV_PERTH_RECORD,
  CSV_ST_MARYS_RECORD,
  CSV_SHUT_RECORD,
];

describe("GET /api/1/foodbanks/?format=csv", () => {
  it("writes the whole file byte for byte", async () => {
    const res = await get("/api/1/foodbanks/?format=csv");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(CSV_RECORDS.join(""));
  });

  // The header is the line third-party pipelines key their columns off, and
  // the ONE difference between it and the JSON body's field list is that
  // "self" is not in it. A header that gained the 20th column would break
  // every consumer's positional read.
  it("writes the 19-column header with no self column", async () => {
    const body = await (await get("/api/1/foodbanks/?format=csv")).text();

    expect(body.startsWith(CSV_HEADER)).toBe(true);
    expect(CSV_HEADER.trimEnd().split(",")).toHaveLength(19);
    expect(CSV_HEADER).not.toContain("self");
    expect(body).not.toContain("/api/1/foodbank/salisbury/");
  });

  // `closed` is a real JS boolean by the time it reaches the writer (packages/
  // db coerces the INTEGER column), and Python's csv.writer renders a bool
  // through str() -- "False"/"True", capitalised. A 0/1 or a "false" here is a
  // silent format change for anyone parsing the column.
  it("renders the booleans as Python's True/False, not 0/1", async () => {
    const body = await (await get("/api/1/foodbanks/?format=csv")).text();

    expect(body).toContain(",False,");
    expect(body).toContain(",True,");
    expect(body).not.toContain(",false,");
    expect(body).not.toMatch(/,[01],"5/);
  });

  it("sends it as an attachment called foodbanks.csv", async () => {
    const res = await get("/api/1/foodbanks/?format=csv");

    expect(res.headers.get("content-type")).toBe("text/csv");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="foodbanks.csv"');
  });

  // The CSV branch reads the SAME response_list the JSON branch builds, so
  // both must show the same food banks. Django builds it once and branches
  // afterwards; a port that filtered in one branch only would be invisible to
  // either body assertion on its own.
  it("covers exactly the food banks the json body does", async () => {
    const csv = await (await get("/api/1/foodbanks/?format=csv")).text();
    const jsonBody = (await json("/api/1/foodbanks/")) as Array<{ slug: string }>;

    for (const entry of jsonBody) expect(csv).toContain(`,${entry.slug},`);
    expect(csv).toContain("shut-foodbank");
  });
});

// ===========================================================================
// GET /api/1/foodbanks/search/
// ===========================================================================

// Distances from Python. Each number below is the output of givefood/utils/
// geo.py's own distance_meters() (R = 6367000, the sin/cos/asin form) and
// miles() run against these exact fixture coordinates, then int()ed and
// round()ed the way gfapi1/views.py:133-134 does. They are the PYTHON answers,
// so an assertion that passes is a cross-check of @givefood/geo against the
// implementation it replaces, not a recording of its own output.
const SALISBURY_DISTANCE = { m: 0, mi: 0 };
const ST_MARYS_DISTANCE = { m: 26647, mi: 16.56 }; // 26647.8796965008 m, 16.5582247712873 mi
const PERTH_DISTANCE = { m: 601705, mi: 373.88 }; // 601705.4505900927 m, 373.882433066063 mi
const WONKY_COLUMN_DISTANCE = { m: 341, mi: 0.21 }; // 341.353275199546 m -- from the COLUMNS

const SALISBURY_SEARCH_ENTRY = {
  name: "Trussell Trust, Salisbury",
  slug: "salisbury",
  distance_m: SALISBURY_DISTANCE.m,
  distance_mi: SALISBURY_DISTANCE.mi,
  url: "https://salisburyfoodbank.invalid/",
  shopping_list_url: "https://salisburyfoodbank.invalid/shopping-list/",
  phone: "01722 411900",
  email: "info@salisburyfoodbank.invalid",
  address: "Unit 1\r\nBemerton Heath\r\nSP2 9DY",
  postcode: "SP2 9DY",
  country: "England",
  parliamentary_constituency: "Salisbury",
  mp: "John Glen",
  mp_party: "Conservative",
  ward: "Bemerton Ward",
  district: "Wiltshire",
  charity_number: "1130136",
  charity_register_url: "https://register-of-charities.charitycommission.gov.uk/charity-details/?regid=1130136&subid=0",
  needs: "Tinned tomatoes\r\nUHT milk\nCoffee",
  number_needs: 3,
  need_id: NEED_SALISBURY.dashed,
  // gfapi1/views.py:151 is `str(foodbank.latest_need.created)` -- space
  // separator, six fractional digits. Two fields later the same API renders a
  // near-identical value with a "T" and three (see /foodbank/<slug>/'s
  // need_found), which is Django's own inconsistency, reproduced.
  updated: "2020-01-24 16:30:23.173268",
  // django.utils.timesince, run for real: timesince(datetime(2020,1,24,16,30,23,173268), datetime(2026,9,5,12,0,0))
  // == '6\xa0years, 7\xa0months'. The separator inside each unit is U+00A0
  // (Django's avoid_wrapping); the one between units is a plain ", ".
  updated_text: "6\u00a0years, 7\u00a0months",
  latt_long: "51.0688,-1.7945",
  self: `${ORIGIN}/api/1/foodbank/salisbury/`,
};

const ST_MARYS_SEARCH_ENTRY = {
  name: "St. Mary's Foodbank",
  slug: "st-marys-foodbank",
  distance_m: ST_MARYS_DISTANCE.m,
  distance_mi: ST_MARYS_DISTANCE.mi,
  url: "https://stmarys.invalid/",
  shopping_list_url: "https://stmarys.invalid/list/",
  phone: null,
  email: "hello@stmarys.invalid",
  address: "St Mary's Hall\r\nChurch Road\r\nSP10 1AA",
  postcode: "SP10 1AA",
  country: "England",
  parliamentary_constituency: null,
  mp: null,
  mp_party: null,
  ward: null,
  district: null,
  charity_number: null,
  charity_register_url: null,
  needs: "Unknown",
  number_needs: 0, // the sentinel, not len(["Unknown"])
  need_id: NEED_ST_MARYS.dashed,
  updated: "2026-08-29 12:00:00",
  updated_text: "1\u00a0week", // Django: timesince(2026-08-29 12:00, 2026-09-05 12:00)
  latt_long: "51.2113,-1.4871",
  self: `${ORIGIN}/api/1/foodbank/st-marys-foodbank/`,
};

const PERTH_SEARCH_ENTRY = {
  name: "Perth & Kinross Foodbank",
  slug: "perth-kinross-foodbank",
  distance_m: PERTH_DISTANCE.m,
  distance_mi: PERTH_DISTANCE.mi,
  url: "https://perthfoodbank.invalid/",
  shopping_list_url: "https://perthfoodbank.invalid/shopping-list/",
  phone: "01738 555000",
  email: "info@perthfoodbank.invalid",
  address: "12 Tay Street\r\nPerth\r\nPH1 5LQ",
  postcode: "PH1 5LQ",
  country: "Scotland",
  parliamentary_constituency: "Perth and Kinross-shire",
  mp: "Pete Wishart",
  mp_party: "Scottish National Party",
  ward: "Perth City Centre",
  district: "Perth and Kinross",
  charity_number: "SC012345",
  charity_register_url: "https://www.oscr.org.uk/about-charities/search-the-register/charity-details?number=SC012345",
  needs: "Nothing",
  number_needs: 0,
  need_id: NEED_PERTH.dashed,
  // A microsecond field of exactly 0 prints NO fractional part at all in
  // Python -- str(datetime) omits it rather than writing ".000000".
  updated: "2026-09-04 10:00:00",
  updated_text: "1\u00a0day, 2\u00a0hours", // Django, run
  latt_long: "56.396,-3.437",
  self: `${ORIGIN}/api/1/foodbank/perth-kinross-foodbank/`,
};

describe("GET /api/1/foodbanks/search/", () => {
  it("returns the nearest open food banks, field for field, nearest first", async () => {
    const res = await get(`/api/1/foodbanks/search/?lattlong=${QUERY_LAT_LNG}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([SALISBURY_SEARCH_ENTRY, ST_MARYS_SEARCH_ENTRY, PERTH_SEARCH_ENTRY]);
  });

  // THE ROW THAT MUST NOT BE THERE. shut-foodbank sits at distance 0 -- the
  // same coordinates as the query -- so it would be result #1 if the candidate
  // query lost its `is_closed = 0`. A search fixture with only open food banks
  // in it cannot tell a filter that works from one that does nothing.
  it("never ranks a closed food bank, even one at distance zero", async () => {
    const body = (await json(`/api/1/foodbanks/search/?lattlong=${QUERY_LAT_LNG}`)) as Array<{ slug: string }>;

    expect(body.map((f) => f.slug)).toEqual(["salisbury", "st-marys-foodbank", "perth-kinross-foodbank"]);
    expect(JSON.stringify(body)).not.toContain("shut-foodbank");
    expect(JSON.stringify(body)).not.toContain("wonky-latlng");
  });

  // WP 2.5's whole point, and invisible in the body: the ranking runs against
  // an id+coordinate projection -- which the production schema has a partial
  // index for, see packages/db/src/types.ts's queryCoordinates -- and only the
  // survivors are fetched in full. A revert to `SELECT * FROM foodbank WHERE
  // is_closed = 0`, 1,000 rows x 79 columns to rank and then discard, is
  // byte-identical in the response and was (per that comment, measured against
  // production by whoever wrote it -- not re-measured here) the dominant cost
  // of every uncached search.
  it("ranks against the cheap coordinate projection, not full rows", async () => {
    await get(`/api/1/foodbanks/search/?lattlong=${QUERY_LAT_LNG}`);

    expect(prepared).toContain("SELECT id, latitude, longitude FROM foodbank WHERE is_closed = 0");
    expect(prepared).not.toContain("SELECT * FROM foodbank WHERE is_closed = 0");
    // Full rows for the three survivors come back in ONE `IN (...)` query, and
    // their needs in one more -- not one round trip per result, which is what
    // the Django view's per-row `foodbank.latest_need` access would have been.
    expect(prepared.filter((sql) => sql.startsWith("SELECT * FROM foodbank WHERE id IN"))).toHaveLength(1);
    expect(prepared.filter((sql) => sql.startsWith("SELECT * FROM foodbankchange_full WHERE id IN"))).toHaveLength(1);
  });

  // SUSPECT, and reported: a real divergence from Django rather than a frozen
  // bug the port chose to keep. Django's find_foodbanks() ranks by
  // `foodbank.latt()`/`long()`, which parse the lat_lng STRING; this port ranks
  // by the latitude/longitude COLUMNS (getOpenFoodbankCoordinates), and PLAN.md
  // §7.2 records that the two disagree on real rows. The wonky fixture makes
  // the disagreement 601 km wide: opened up, it ranks SECOND here (341 m by its
  // columns) where Django would have put it last (601 km by its string) -- and
  // the response then publishes a `distance_m` of 341 next to a `latt_long`
  // 601 km away, which is self-contradictory whichever reading is right.
  it("ranks from the latitude/longitude columns, not the lat_lng string Django used", async () => {
    db.exec("UPDATE foodbank SET is_closed = 0 WHERE slug = 'wonky-latlng'");

    const body = (await json(`/api/1/foodbanks/search/?lattlong=${QUERY_LAT_LNG}`)) as Array<{
      slug: string;
      distance_m: number;
      latt_long: string;
    }>;

    expect(body.map((f) => f.slug)).toEqual(["salisbury", "wonky-latlng", "st-marys-foodbank", "perth-kinross-foodbank"]);
    const wonky = body[1]!;
    expect(wonky.distance_m).toBe(WONKY_COLUMN_DISTANCE.m);
    // The contradiction, stated: the published coordinate is Perth's, and it is
    // the same string Perth itself publishes, 601 km from the distance beside
    // it.
    expect(wonky.latt_long).toBe("56.396,-3.437");
    expect(body[3]!.latt_long).toBe(wonky.latt_long);
  });

  // FROZEN BUG B12, reached where it actually bites. gfapi1/views.py:148-152
  // dereferences `foodbank.latest_need` with no null guard, so an open food
  // bank with no need on file is a 500 -- for the WHOLE SEARCH, not just that
  // row, which is why a single bad row takes out every search near it.
  it("500s the entire search when any ranked food bank has no latest need -- B12", async () => {
    db.exec("UPDATE foodbank SET is_closed = 0 WHERE slug = 'shut-foodbank'");

    const res = await get(`/api/1/foodbanks/search/?lattlong=${QUERY_LAT_LNG}`);

    expect(res.status).toBe(500);
    // The 500 page, not a partial list: the three food banks that WOULD have
    // ranked are nowhere in the response.
    const body = await res.text();
    expect(body).not.toContain("salisbury");
    expect(body).not.toContain("distance_m");
  });

  it("400s with an empty body when neither lattlong nor address is given", async () => {
    for (const query of ["", "?", "?lattlong=", "?address=", "?foo=bar", "?lattlong=&address="]) {
      const res = await get(`/api/1/foodbanks/search/${query}`);
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // FROZEN BUG B6, half one: no is_uk() check. Django's other search endpoints
  // reject an out-of-UK coordinate; this one does not, and answers happily with
  // the nearest UK food banks to a point in the Pacific.
  it("answers a coordinate nowhere near the UK -- B6", async () => {
    const body = (await json("/api/1/foodbanks/search/?lattlong=-33.8688,151.2093")) as Array<{ slug: string; distance_m: number }>;

    expect(body.map((f) => f.slug)).toEqual(["perth-kinross-foodbank", "st-marys-foodbank", "salisbury"]);
    // Sydney is far enough that the ranking inverts -- proof the distances were
    // recomputed from the given point and not served from anything cached.
    expect(body[0]!.distance_m).toBeGreaterThan(10_000_000);
  });

  // SUSPECT (reported, not fixed), and NOT a frozen bug -- Django 500s here.
  // `float("abc")` raises ValueError inside find_foodbanks(), so the real API
  // answers 500. The port's `Number("abc")` is NaN, every haversine distance is
  // NaN, Array#sort treats a NaN comparator result as 0 (so the order is the
  // candidate order, i.e. rowid), and JSON.stringify renders NaN as null. The
  // caller gets 200 with a plausible-looking list of food banks whose distances
  // are all null and whose order means nothing.
  it("answers 200 with null distances for an unparseable lattlong, where Django 500s", async () => {
    const body = (await json("/api/1/foodbanks/search/?lattlong=abc,def")) as Array<{ slug: string; distance_m: number | null; distance_mi: number | null }>;

    // NOT the distance order (there are no distances): this is the candidate
    // set in the order the scan produced it, ids 7, 12, 30 -- which is the
    // giveaway that the ranking silently did nothing at all.
    expect(body.map((f) => f.slug)).toEqual(["salisbury", "perth-kinross-foodbank", "st-marys-foodbank"]);
    expect(body.map((f) => f.slug)).not.toEqual(["salisbury", "st-marys-foodbank", "perth-kinross-foodbank"]);
    for (const entry of body) {
      expect(entry.distance_m).toBeNull();
      expect(entry.distance_mi).toBeNull();
    }
  });

  // Same family: Django does `lattlong.split(",")[1]`, which raises IndexError
  // on a value with no comma -- a 500. Here the longitude is undefined, so
  // again NaN, again 200.
  it("answers 200 for a lattlong with no comma, where Django raises IndexError", async () => {
    const res = await get("/api/1/foodbanks/search/?lattlong=51.0688");

    expect(res.status).toBe(200);
    expect(((await res.json()) as Array<{ distance_m: number | null }>)[0]!.distance_m).toBeNull();
  });

  // A third coordinate is simply ignored -- "51,-1,999" splits and the extra
  // piece is dropped, on both sides. Pinned because it is the one malformed
  // input of the family that does NOT diverge.
  it("ignores anything after the second comma", async () => {
    const three = await (await get("/api/1/foodbanks/search/?lattlong=51.0688,-1.7945,999")).text();
    const two = await (await get(`/api/1/foodbanks/search/?lattlong=${QUERY_LAT_LNG}`)).text();

    expect(three).toBe(two);
  });
});

describe("GET /api/1/foodbanks/search/?address=", () => {
  // The outbound request, asserted exactly -- it is the only thing in this file
  // that leaves the machine, and a wrong key parameter or a missing ",UK" is
  // invisible in the response (Google would just return a different place).
  //
  // TWO CHARACTERS DIFFER FROM DJANGO, both from encodeURIComponent vs Python's
  // urllib quote(safe="/"): an apostrophe stays literal here where Python sends
  // %27, and a "/" in an address would be sent as %2F where Python leaves it
  // bare. Both were run to confirm. Neither changes what Google resolves, so
  // this is recorded rather than filed.
  it("asks Google for the address with ',UK' appended", async () => {
    await get("/api/1/foodbanks/search/?address=St%20Mary's%20Road%2C%20Salisbury");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `https://maps.googleapis.com/maps/api/geocode/json?region=uk&key=${GEOCODE_KEY}&address=St%20Mary's%20Road%2C%20Salisbury%2CUK`,
    );
  });

  it("ranks from the geocoded coordinate", async () => {
    fetchMock.mockResolvedValue(Response.json({ results: [{ geometry: { location: { lat: 56.396, lng: -3.437 } } }] }));

    const body = (await json("/api/1/foodbanks/search/?address=Perth")) as Array<{ slug: string; distance_m: number }>;

    expect(body.map((f) => f.slug)).toEqual(["perth-kinross-foodbank", "st-marys-foodbank", "salisbury"]);
    expect(body[0]!.distance_m).toBe(0);
    expect(body[2]!.distance_m).toBe(PERTH_DISTANCE.m);
  });

  // `lattlong` wins outright and the geocoder is never asked -- `if address and
  // not lat_lng`. Worth pinning because the obvious refactor (geocode when
  // `address` is present) would put a paid Google call on every request that
  // sends both.
  it("does not geocode when lattlong is also given", async () => {
    const both = await (await get(`/api/1/foodbanks/search/?lattlong=${QUERY_LAT_LNG}&address=Perth`)).text();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(both).toBe(await (await get(`/api/1/foodbanks/search/?lattlong=${QUERY_LAT_LNG}`)).text());
  });

  // FROZEN BUG B6, half two. lib/geocode.ts never throws: a failed lookup is
  // "0,0", and gfapi1 -- alone among the search endpoints -- does not run
  // is_uk() over it. So a geocode failure is not an error, it is a ranking from
  // the Gulf of Guinea, returned as 200 with real food banks in it. The nearest
  // food bank to (0,0) here is the southernmost, which is the reverse of the
  // real answer for any UK address.
  it("returns food banks ranked from 0,0 when geocoding fails -- B6", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));

    const res = await get("/api/1/foodbanks/search/?address=Nowhere%20At%20All");
    const body = (await res.json()) as Array<{ slug: string; distance_m: number }>;

    expect(res.status).toBe(200);
    expect(body.map((f) => f.slug)).toEqual(["salisbury", "st-marys-foodbank", "perth-kinross-foodbank"]);
    expect(body[0]!.distance_m).toBeGreaterThan(5_000_000);
  });

  // The same "0,0" fallback for a 200 whose body has no results at all -- the
  // Python original's bare `except (KeyError, IndexError, ValueError)`.
  it("falls back to 0,0 on an empty geocoder response rather than erroring", async () => {
    fetchMock.mockResolvedValue(Response.json({ results: [] }));

    const res = await get("/api/1/foodbanks/search/?address=Nowhere");

    expect(res.status).toBe(200);
    expect(((await res.json()) as unknown[]).length).toBe(3);
  });
});

// ===========================================================================
// GET /api/1/foodbank/<slug>/
// ===========================================================================

describe("GET /api/1/foodbank/<slug>/", () => {
  // THE WHOLE BODY. Two things in it are worth naming, because both are
  // Django's own inconsistencies reproduced rather than tidied:
  //   - `address` is the RAW column here, where /foodbanks/ publishes
  //     full_address() (address + CRLF + postcode). Same food bank, same API,
  //     two different values under the same key.
  //   - `need_found` is DjangoJSONEncoder's rendering (T, three digits) and
  //     `updated` is str()'s (space, six), two lines apart in views.py.
  it("returns the documented body, field for field", async () => {
    const res = await get("/api/1/foodbank/salisbury/");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: "Trussell Trust, Salisbury",
      slug: "salisbury",
      url: "https://salisburyfoodbank.invalid/",
      shopping_list_url: "https://salisburyfoodbank.invalid/shopping-list/",
      phone: "01722 411900",
      email: "info@salisburyfoodbank.invalid",
      address: "Unit 1\r\nBemerton Heath",
      postcode: "SP2 9DY",
      country: "England",
      parliamentary_constituency: "Salisbury",
      mp: "John Glen",
      mp_party: "Conservative",
      ward: "Bemerton Ward",
      district: "Wiltshire",
      charity_number: "1130136",
      charity_register_url: "https://register-of-charities.charitycommission.gov.uk/charity-details/?regid=1130136&subid=0",
      closed: false,
      latt_long: "51.0688,-1.7945",
      network: "Trussell Trust",
      needs: "Tinned tomatoes\r\nUHT milk\nCoffee",
      number_needs: 3,
      need_found: "2026-09-01T07:05:00.123", // the `last_need` COLUMN, not the need's created
      need_id: NEED_SALISBURY.dashed,
      need_self: `${ORIGIN}/api/1/need/${NEED_SALISBURY.dashed}/`,
      locations: [
        // .order_by("name"): Amesbury, Closed Annexe, Wilton Road -- seeded
        // Wilton, Amesbury, Closed.
        {
          name: "Amesbury Library",
          address: null,
          postcode: null,
          latt_long: "51.17,-1.78",
          // NULL, not the food bank's "01722 411900": api_foodbank publishes
          // location.phone_number raw, without FoodbankLocation.phone()'s
          // fallback.
          phone: null,
          parliamentary_constituency: "Salisbury",
          mp: "John Glen",
          mp_party: "Conservative",
          ward: "Bemerton LocWard",
          district: "Salisbury LocDistrict",
        },
        {
          name: "Closed Annexe",
          address: "9 Shut Lane",
          postcode: "SP1 9ZZ",
          latt_long: "51.09,-1.75",
          phone: "01722 333333",
          parliamentary_constituency: "Salisbury",
          mp: "John Glen",
          mp_party: "Conservative",
          ward: "Bemerton LocWard",
          district: "Salisbury LocDistrict",
        },
        {
          name: "Wilton Road Centre",
          address: "12 Wilton Road",
          postcode: "SP2 7EF",
          latt_long: "51.08,-1.82",
          phone: "01722 222222",
          parliamentary_constituency: "Salisbury",
          mp: "John Glen",
          mp_party: "Conservative",
          ward: "Bemerton LocWard",
          district: "Salisbury LocDistrict",
        },
      ],
      updated: "2020-01-24 16:30:23.173268",
      updated_text: "6\u00a0years, 7\u00a0months",
      self: `${ORIGIN}/api/1/foodbank/salisbury/`,
    });
  });

  // Stated on its own because the two renderings sit two lines apart in the
  // source and "harmonising" them is the obvious tidy-up. They are the same
  // KIND of value in the same document: one has a T and three digits, the other
  // a space and six. PLAN.md §7.4.6 calls this "three different renderings in
  // one API" and asks for it to be kept.
  it("renders need_found and updated in two different datetime formats", async () => {
    const body = (await json("/api/1/foodbank/salisbury/")) as { need_found: string; updated: string };

    expect(body.need_found).toBe("2026-09-01T07:05:00.123");
    expect(body.updated).toBe("2020-01-24 16:30:23.173268");
    expect(body.need_found).toContain("T");
    expect(body.updated).not.toContain("T");
  });

  // `need_found` is the one latest_need-adjacent field that is genuinely
  // guarded (it reads the food bank's own last_need column). Perth's is NULL.
  it("publishes a null need_found rather than omitting it", async () => {
    const body = (await json("/api/1/foodbank/perth-kinross-foodbank/")) as Record<string, unknown>;

    expect(body).toHaveProperty("need_found");
    expect(body.need_found).toBeNull();
    expect(body.updated).toBe("2026-09-04 10:00:00");
  });

  // A closed food bank is still servable by slug -- neither Django's
  // get_object_or_404 nor getFoodbankBySlug filters is_closed. It is only
  // SEARCH that excludes them.
  it("serves a closed food bank", async () => {
    const body = (await json("/api/1/foodbank/wonky-latlng/")) as { closed: boolean; needs: string };

    expect(body.closed).toBe(true);
    expect(body.needs).toBe("Pasta\r\nRice");
  });

  // FROZEN BUG B12. `needs: foodbank.latestNeed!.change_text` is the first of
  // five unguarded dereferences and it throws before the ternary on `updated`
  // -- which is why that ternary (the one field Django DOES guard, via
  // latest_need_date()) is unreachable dead code on both sides. Django fails
  // identically: its dict literal evaluates "needs" before "updated" too.
  it("500s a food bank with no latest need -- B12", async () => {
    const res = await get("/api/1/foodbank/shut-foodbank/");

    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain("Shut Foodbank");
    expect(body).not.toContain("latt_long");
  });

  it("404s an unknown slug without leaking a partial document", async () => {
    const res = await get("/api/1/foodbank/no-such-foodbank/");

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("latt_long");
  });

  // The locations list is filtered by food bank AND sorted by name. The
  // bystander belongs to Perth and is named to sort first, so a lost WHERE
  // would put "Aardvark Hall" at the head of Salisbury's list.
  it("lists only this food bank's locations, name-sorted", async () => {
    const salisbury = (await json("/api/1/foodbank/salisbury/")) as { locations: Array<{ name: string }> };
    const perth = (await json("/api/1/foodbank/perth-kinross-foodbank/")) as { locations: Array<{ name: string }> };

    expect(salisbury.locations.map((l) => l.name)).toEqual(["Amesbury Library", "Closed Annexe", "Wilton Road Centre"]);
    expect(perth.locations.map((l) => l.name)).toEqual(["Aardvark Hall"]);
  });

  it("publishes an empty locations array for a food bank with none", async () => {
    const body = (await json("/api/1/foodbank/st-marys-foodbank/")) as { locations: unknown[] };

    expect(body.locations).toEqual([]);
  });

  // THE LOCATION QUERY IS PROJECTED, not `SELECT *` -- github #52's closing
  // observation, third instalment. The serialiser above names TEN location
  // fields and boundary_geojson is not one of them, so this endpoint was
  // pulling a TEXT blob across the wire to drop it on the floor: measured
  // read-only against production D1 on canterbury (21 locations, all 21 with a
  // boundary, the largest of the only 7 food banks that have one at all),
  // 2,319,826 -> 19,532 bytes for this statement, -99.2%, same query plan,
  // rows_read unchanged at 43.
  //
  // Asserted on the SQL that reached the ENGINE, because the projection is
  // invisible in the response: a revert to `SELECT *` changes not one byte of
  // any document this file asserts. And NOT the flagged sibling either -- the
  // food bank page's has_boundary would be just as unread here.
  it("reads its locations with a named column list, never SELECT * and never the boundary blob", async () => {
    await get("/api/1/foodbank/salisbury/");

    expect(prepared).toContain(LOCATIONS_SQL);
    expect(prepared.filter((sql) => sql.includes("foodbanklocation_full"))).toEqual([LOCATIONS_SQL]);
    expect(LOCATIONS_SQL).not.toContain("SELECT *");
    expect(LOCATIONS_SQL).not.toContain("boundary_geojson");
    expect(LOCATIONS_SQL).not.toContain("has_boundary");
  });

  // THE VALUE DID NOT MOVE, which is the half the statement assertion above
  // cannot see. A projection that dropped `ward`, `mp_party` or `postcode`
  // would leave the ten keys present and their values null -- a live v1 API
  // publishing blanks, with a 200 and the right shape. So the whole locations
  // array is asserted again here, against a fixture where every Salisbury
  // location now stores a boundary the endpoint must continue to ignore.
  it("publishes the identical locations array whether or not the rows carry a boundary blob", async () => {
    const before = ((await json("/api/1/foodbank/salisbury/")) as { locations: unknown[] }).locations;

    db.prepare("UPDATE foodbanklocation SET boundary_geojson = ? WHERE foodbank_id = ?").run(
      '{"type":"Polygon","coordinates":[[[-1.8,51.0],[-1.7,51.0],[-1.7,51.1],[-1.8,51.0]]]}',
      SALISBURY_ID,
    );
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbanklocation WHERE boundary_geojson IS NOT NULL").get()).toEqual({ n: 3 });

    const after = (await json("/api/1/foodbank/salisbury/")) as { locations: Array<Record<string, unknown>> };

    expect(after.locations).toEqual(before);
    // Not vacuously equal, and not merely the right shape: the ten fields are
    // named and their values pinned, so a column silently missing from the
    // narrow list fails here rather than publishing null under a live key.
    expect(after.locations).toHaveLength(3);
    for (const location of after.locations) {
      expect(Object.keys(location)).toEqual([
        "name",
        "address",
        "postcode",
        "latt_long",
        "phone",
        "parliamentary_constituency",
        "mp",
        "mp_party",
        "ward",
        "district",
      ]);
      expect(location).not.toHaveProperty("boundary_geojson");
      expect(location).not.toHaveProperty("has_boundary");
      expect(location.parliamentary_constituency).toBe("Salisbury");
      expect(location.mp).toBe("John Glen");
      expect(location.mp_party).toBe("Conservative");
      expect(location.ward).toBe("Bemerton LocWard");
      expect(location.district).toBe("Salisbury LocDistrict");
    }
    expect(after.locations.map((l) => l.name)).toEqual(["Amesbury Library", "Closed Annexe", "Wilton Road Centre"]);
    expect(after.locations.map((l) => l.postcode)).toEqual([null, "SP1 9ZZ", "SP2 7EF"]);
    expect(after.locations.map((l) => l.latt_long)).toEqual(["51.17,-1.78", "51.09,-1.75", "51.08,-1.82"]);
  });
});

// ===========================================================================
// GET /api/1/needs/
// ===========================================================================

// The published needs, newest first -- as this endpoint actually orders them.
// See "the ISO-shaped row" for why 08:00 comes before 09:00.
const NEEDS_IN_ORDER = [
  {
    id: NEED_ISO.dashed,
    created: "2026-09-05T08:00:00",
    foodbank_name: "Trussell Trust, Salisbury",
    foodbank_slug: "trussell-trust-salisbury",
    foodbank_self: `${ORIGIN}/api/1/foodbank/trussell-trust-salisbury/`,
    needs: "Cereal",
    url: null,
    self: `${ORIGIN}/api/1/need/${NEED_ISO.dashed}/`,
  },
  {
    id: NEED_WONKY.dashed,
    created: "2026-09-05T09:00:00",
    foodbank_name: "Wonky (Coordinates) Foodbank!",
    foodbank_slug: "wonky-coordinates-foodbank",
    foodbank_self: `${ORIGIN}/api/1/foodbank/wonky-coordinates-foodbank/`,
    needs: "Pasta\r\nRice",
    url: null,
    self: `${ORIGIN}/api/1/need/${NEED_WONKY.dashed}/`,
  },
  {
    id: NEED_PERTH.dashed,
    created: "2026-09-04T10:00:00",
    foodbank_name: "Perth & Kinross Foodbank",
    foodbank_slug: "perth-kinross-foodbank",
    foodbank_self: `${ORIGIN}/api/1/foodbank/perth-kinross-foodbank/`,
    needs: "Nothing",
    url: null,
    self: `${ORIGIN}/api/1/need/${NEED_PERTH.dashed}/`,
  },
  {
    id: NEED_ST_MARYS.dashed,
    created: "2026-08-29T12:00:00",
    foodbank_name: "St. Mary's Foodbank",
    // Django 5.2.6's slugify gives "st-marys-foodbank" (this food bank's real
    // slug). See "slugifies a name" below.
    foodbank_slug: "st-mary-s-foodbank",
    foodbank_self: `${ORIGIN}/api/1/foodbank/st-mary-s-foodbank/`,
    needs: "Unknown",
    url: "https://stmarys.invalid/list/",
    self: `${ORIGIN}/api/1/need/${NEED_ST_MARYS.dashed}/`,
  },
  {
    id: NEED_ORPHAN.dashed,
    created: "2026-08-01T00:00:00",
    foodbank_name: null,
    // Django's slugify(None) is "none" -- str(None) first. Run, not assumed.
    foodbank_slug: "",
    foodbank_self: `${ORIGIN}/api/1/foodbank//`,
    needs: "Soup",
    url: null,
    self: `${ORIGIN}/api/1/need/${NEED_ORPHAN.dashed}/`,
  },
  {
    id: NEED_SALISBURY.dashed,
    // DjangoJSONEncoder: isoformat() truncated (never rounded) to three
    // fractional digits -- .173268 becomes .173.
    created: "2020-01-24T16:30:23.173",
    foodbank_name: "Trussell Trust, Salisbury",
    foodbank_slug: "trussell-trust-salisbury",
    foodbank_self: `${ORIGIN}/api/1/foodbank/trussell-trust-salisbury/`,
    needs: "Tinned tomatoes\r\nUHT milk\nCoffee",
    url: "https://salisburyfoodbank.invalid/shopping-list/",
    self: `${ORIGIN}/api/1/need/${NEED_SALISBURY.dashed}/`,
  },
];

describe("GET /api/1/needs/", () => {
  it("returns the published needs, newest first, field for field", async () => {
    const res = await get("/api/1/needs/");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(NEEDS_IN_ORDER);
  });

  // THE ROW THAT MUST BE EXCLUDED. An unpublished need is a draft the site has
  // deliberately not shown anyone; publishing it through the API would be the
  // worst kind of failure this endpoint can have, and a fixture with only
  // published rows in it cannot tell `WHERE published = 1` from no filter.
  it("excludes unpublished needs", async () => {
    const body = await (await get("/api/1/needs/")).text();

    expect(body).not.toContain("Draft crisps");
    expect(body).not.toContain(NEED_DRAFT.dashed);
    expect(JSON.parse(body)).toHaveLength(6);
    // ...and the draft really is in the database, so the assertion above cannot
    // pass because the row is missing.
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbankchange").get()).toEqual({ n: 7 });
  });

  // SUSPECT (reported, not fixed). `created` is TEXT compared
  // lexicographically, and this database holds two shapes of it: Django's
  // "2026-09-05 09:00:00.000000" and this port's "2026-09-05T08:00:00.000Z".
  // "T" (0x54) sorts above " " (0x20), so on any day where both shapes appear
  // EVERY port-written row sorts above EVERY Django-written one regardless of
  // the actual time -- here an 08:00 need is published as newer than an 09:00
  // one. It is only ever a same-day inversion (the date prefix compares first),
  // which is why it has gone unnoticed, but "newest first" is the whole
  // contract of this endpoint.
  it("sorts the ISO-shaped row above an earlier-in-the-day Django-shaped one", async () => {
    const body = (await json("/api/1/needs/")) as Array<{ id: string; created: string }>;

    expect(body[0]!.id).toBe(NEED_ISO.dashed);
    expect(body[0]!.created).toBe("2026-09-05T08:00:00");
    expect(body[1]!.created).toBe("2026-09-05T09:00:00");
    // Both rows are the same calendar day, and the one published first is the
    // LATER instant. Stated as a comparison so the inversion is unmissable.
    expect(body[0]!.created < body[1]!.created).toBe(true);
    // The raw columns are what the ordering actually sees.
    const raw = db.prepare("SELECT created FROM foodbankchange WHERE need_id = ?").get(NEED_ISO.dashless) as { created: string };
    expect(raw.created).toBe("2026-09-05T08:00:00.000Z");
  });

  // `?limit=` accepts exactly 100 and 1000. Every other numeric value is a 400
  // with an empty body -- including 0, and including a value BELOW the default.
  it("400s any limit outside the allow-list", async () => {
    for (const limit of ["50", "0", "-1", "101", "999", "1001", "10000"]) {
      const res = await get(`/api/1/needs/?limit=${limit}`);
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("");
    }
  });

  it("accepts the two allowed limits and defaults to 100", async () => {
    const none = await (await get("/api/1/needs/")).text();

    expect(none).toBe(await (await get("/api/1/needs/?limit=100")).text());
    expect((await get("/api/1/needs/?limit=1000")).status).toBe(200);
  });

  // THE DEFAULT IS A NUMBER, AND THE NUMBER MATTERS. The test above compares
  // the default against ?limit=100 and passes just as happily if the default
  // were 1000 -- with six needs in the fixture, every limit returns the same
  // six rows. So this one floods the table past the cut: 100 further published
  // needs, all older than the six real ones, which therefore stay at the head
  // of the list while the truncation lands inside the filler.
  it("cuts the list at 100 by default and at 1000 when asked", async () => {
    for (let i = 0; i < 100; i += 1) {
      seedNeed(
        700 + i,
        `eeeeeeeeeeeeeeeeeeeeeeeeeeee${String(i).padStart(4, "0")}`,
        SALISBURY_ID,
        `Filler ${i}`,
        1,
        // Older than every seeded need, and distinct from each other so the
        // ORDER BY is total rather than arbitrary within the filler.
        `2018-01-01 00:00:00.${String(i).padStart(6, "0")}`,
        null,
      );
    }

    const dflt = (await json("/api/1/needs/")) as Array<{ id: string; needs: string }>;
    const thousand = (await json("/api/1/needs/?limit=1000")) as unknown[];

    expect(dflt).toHaveLength(100);
    expect(thousand).toHaveLength(106);
    // The six real needs survive the cut, in their own order, and the other 94
    // slots are filler -- so the cut is at the TAIL, not a slice off the front.
    expect(dflt.slice(0, 6).map((n) => n.id)).toEqual(NEEDS_IN_ORDER.map((n) => n.id));
    expect(dflt.filter((n) => n.needs.startsWith("Filler "))).toHaveLength(94);
  });

  // FROZEN BUG B4. Python's `int(limit)` runs BEFORE the allow-list check, so a
  // non-numeric limit raises ValueError and the real API answers 500, not 400.
  // The port reproduces it by throwing from pythonInt() and letting it reach
  // app.onError. A "tidy-up" to 400 would be a behaviour change to a live API.
  it("500s a non-numeric limit rather than 400ing it -- B4", async () => {
    // Each of these was run through CPython's int() to confirm it raises
    // ValueError there too, so the 500 is parity and not the port being
    // stricter -- see the next test for the two inputs where it IS stricter.
    for (const limit of ["abc", "1e3", "100.0", "0x64", "null", "100abc"]) {
      const res = await get(`/api/1/needs/?limit=${limit}`);
      expect(res.status).toBe(500);
    }
  });

  // SUSPECT (reported, not fixed), and divergences rather than frozen bugs.
  // pythonInt's `/^[+-]?\d+$/` is NARROWER than CPython's int() in two ways,
  // both run on this machine rather than assumed:
  //   int("١٠٠")  == 100  -- int() accepts any Unicode decimal digit; JS's \d
  //                          is ASCII-only.
  //   int("1_0_0") == 100  -- int() accepts PEP 515 underscore separators.
  // Django therefore serves both of these requests and the port 500s them.
  // Nobody is typing either into this parameter; they are here because they are
  // the inputs on which "reproduces Python's int()" is measurably false, and a
  // future rewrite of that function should know which way it differs.
  it("500s the two limit spellings CPython's int() would have accepted", async () => {
    expect((await get("/api/1/needs/?limit=١٠٠")).status).toBe(500);
    expect((await get("/api/1/needs/?limit=1_0_0")).status).toBe(500);
  });

  // The other half of B4: pythonInt is Python's int(), not JavaScript's
  // Number(). Number("") is 0 and Number("1e3") is 1000 -- both would be
  // accepted or rejected in the wrong place. What int() DOES accept is
  // surrounding whitespace and an explicit sign, and those must still reach the
  // allow-list as 100.
  it("accepts the whitespace and sign forms Python's int() accepts", async () => {
    const expected = await (await get("/api/1/needs/?limit=100")).text();

    for (const limit of ["%20100%20", "+100", "%09100%0A"]) {
      const res = await get(`/api/1/needs/?limit=${limit}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(expected);
    }
    // An empty ?limit= is NOT int()-parseable ... but it never reaches
    // pythonInt: `c.req.query("limit") ?? "100"` only defaults on an ABSENT
    // parameter, and "" is present. Python's request.GET.get("limit", 100) does
    // the same, so `int("")` raises there too -- a 500 on both sides.
    expect((await get("/api/1/needs/?limit=")).status).toBe(500);
  });

  // The limit is a real SQL LIMIT, not a slice applied afterwards -- and it is
  // bound, not interpolated. Proven by lowering it below the row count, which
  // the allow-list forbids from outside; the query itself is asserted instead.
  it("passes the limit to SQL rather than trimming in JavaScript", async () => {
    await get("/api/1/needs/?limit=1000");

    expect(prepared).toEqual(["SELECT * FROM foodbankchange_full WHERE published = 1 ORDER BY created DESC LIMIT ?"]);
  });

  // SUSPECT, and a divergence from Django rather than a frozen bug -- the
  // Django side was RUN (django.utils.text.slugify, 5.2.6). routes/api1.ts's
  // slugify is `[^a-z0-9]+ -> "-"`, which is not Django's: Django strips
  // punctuation before collapsing whitespace, keeps underscores, and
  // ASCII-folds accents. So:
  //   Django "st-marys-foodbank"  <-  "St. Mary's Foodbank"  ->  port "st-mary-s-foodbank"
  //   Django "bristol_north"      <-  "Bristol_North"        ->  port "bristol-north"
  //   Django "cafe-bank"          <-  "Café Bank"      ->  port "caf-bank"
  // The module's own comment acknowledges the simplification (PLAN.md R7), but
  // the consequence is concrete: `foodbank_self` for St Mary's points at a slug
  // that does not exist, and this API says so itself.
  it("slugifies a name differently from Django, producing a 404 URL", async () => {
    const body = (await json("/api/1/needs/")) as Array<{ foodbank_slug: string; foodbank_self: string }>;
    const stMarys = body.find((n) => n.foodbank_self.includes("mary"))!;

    expect(stMarys.foodbank_slug).toBe("st-mary-s-foodbank");
    // Django's answer for the same name is this row's real slug, which resolves.
    expect((await get("/api/1/foodbank/st-marys-foodbank/")).status).toBe(200);
    // The port's does not.
    expect((await get(`/api/1/foodbank/${stMarys.foodbank_slug}/`)).status).toBe(404);
  });

  // NOT a port bug: `foodbank_name_slug()` is Django's own, and it has never
  // been the food bank's slug -- it is slugify(name), which for a name with a
  // comma in it is nobody's URL. Reproduced deliberately, and pinned here so
  // that "fixing" it (by joining to foodbank.slug, which foodbankchange_full
  // already exposes) is a visible decision about a live API rather than a
  // tidy-up.
  it("derives foodbank_slug from the NAME even when the real slug is right there", async () => {
    const body = (await json("/api/1/needs/")) as Array<{ foodbank_slug: string; foodbank_self: string }>;

    expect(body[0]!.foodbank_slug).toBe("trussell-trust-salisbury");
    expect((await get("/api/1/foodbank/trussell-trust-salisbury/")).status).toBe(404);
    expect((await get("/api/1/foodbank/salisbury/")).status).toBe(200);
    // The view this reads from carries the real slug, so the join is not the
    // obstacle -- the behaviour is.
    expect(db.prepare("SELECT foodbank_slug FROM foodbankchange_full WHERE need_id = ?").get(NEED_ISO.dashless)).toEqual({
      foodbank_slug: "salisbury",
    });
  });

  // A need whose food bank row is gone (or was never linked). Django's
  // slugify(None) is "none", so the real API publishes
  // /api/1/foodbank/none/; this port publishes /api/1/foodbank// -- a
  // different broken URL, from `need.foodbank_name ?? ""`. Both 404.
  it("publishes an empty foodbank_slug for an orphaned need, where Django says 'none'", async () => {
    const body = (await json("/api/1/needs/")) as Array<{ foodbank_name: string | null; foodbank_slug: string; foodbank_self: string }>;
    const orphan = body.find((n) => n.foodbank_name === null)!;

    expect(orphan.foodbank_slug).toBe("");
    expect(orphan.foodbank_self).toBe(`${ORIGIN}/api/1/foodbank//`);
    expect(orphan.foodbank_self).not.toContain("/foodbank/none/");
  });
});

// ===========================================================================
// GET /api/1/need/<id>/
// ===========================================================================

describe("GET /api/1/need/<id>/", () => {
  it("returns one need, field for field", async () => {
    const res = await get(`/api/1/need/${NEED_SALISBURY.dashed}/`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: NEED_SALISBURY.dashed,
      created: "2020-01-24T16:30:23.173",
      foodbank_name: "Trussell Trust, Salisbury",
      foodbank_slug: "trussell-trust-salisbury",
      foodbank_self: `${ORIGIN}/api/1/foodbank/trussell-trust-salisbury/`,
      needs: "Tinned tomatoes\r\nUHT milk\nCoffee",
      url: "https://salisburyfoodbank.invalid/shopping-list/",
      self: `${ORIGIN}/api/1/need/${NEED_SALISBURY.dashed}/`,
    });
  });

  // The list and the detail build the same eight fields from the same columns
  // in two places (views.py:228-238 and :246-256). Asserted as an equality so
  // that a change to one of them fails here rather than in a body assertion
  // that someone updates twice.
  it("is byte-identical to the same need's entry in the list", async () => {
    const list = (await json("/api/1/needs/")) as unknown[];
    const one = await json(`/api/1/need/${NEED_SALISBURY.dashed}/`);

    expect(list).toContainEqual(one);
  });

  // Accepts the dashless form the column holds, because normalizeUuid strips
  // dashes on the way in. DIVERGENCE, recorded: Django's `<uuid:id>` path
  // converter only matches the dashed, lowercase 8-4-4-4-12 form, so both of
  // these are 404s there -- the URL never reaches the view.
  it("also accepts the dashless and upper-case forms Django's URL pattern rejects", async () => {
    const dashed = await (await get(`/api/1/need/${NEED_SALISBURY.dashed}/`)).text();

    expect(await (await get(`/api/1/need/${NEED_SALISBURY.dashless}/`)).text()).toBe(dashed);
    expect(await (await get(`/api/1/need/${NEED_SALISBURY.dashed.toUpperCase()}/`)).text()).toBe(dashed);
    // Whatever form is asked for, the id and self URL come back dashed and
    // lower-case -- so a client cannot end up with two spellings of one need.
    const body = (await json(`/api/1/need/${NEED_SALISBURY.dashed.toUpperCase()}/`)) as { id: string; self: string };
    expect(body.id).toBe(NEED_SALISBURY.dashed);
    expect(body.self).toBe(`${ORIGIN}/api/1/need/${NEED_SALISBURY.dashed}/`);
  });

  // NO published FILTER, on either side -- Django's is a bare
  // get_object_or_404(FoodbankChange, need_id=id). So a draft that /needs/
  // deliberately withholds is served in full to anyone holding its uuid. That
  // is the real API's behaviour and the port keeps it; the uuid is not
  // guessable, which is presumably why nobody has minded.
  it("serves an UNPUBLISHED need that /needs/ withholds", async () => {
    const res = await get(`/api/1/need/${NEED_DRAFT.dashed}/`);

    expect(res.status).toBe(200);
    expect((await res.json() as { needs: string }).needs).toBe("Draft crisps");
    expect(await (await get("/api/1/needs/")).text()).not.toContain("Draft crisps");
  });

  it("404s an unknown, malformed or empty uuid", async () => {
    for (const id of ["00000000-0000-0000-0000-000000000000", "not-a-uuid", "0f2fe1cb"]) {
      const res = await get(`/api/1/need/${id}/`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("Tinned tomatoes");
    }
  });

  // A need with no `uri` publishes null, not "". Django sent None; the column
  // is nullable and most rows entered by hand have nothing in it.
  it("publishes a null url rather than an empty string", async () => {
    const body = (await json(`/api/1/need/${NEED_PERTH.dashed}/`)) as { url: string | null };

    expect(body.url).toBeNull();
  });
});

// ===========================================================================
// THE MOUNT ITSELF
// ===========================================================================

describe("the endpoints as mounted", () => {
  // gfapi1/views.py sets NO Cache-Control and NO CORS header on any of these
  // five, and routes/api1.ts's header comment says nothing here should add
  // either. Both are reachable by accident from OUTSIDE this file --
  // middleware/pageCacheControl.ts stamps a public TTL on any 200 with no
  // header of its own -- so this is the assertion that says the middleware's
  // CACHEABLE_TYPES list still excludes JSON and CSV.
  //
  // The contrast is deliberate: gfapi2 DOES send both (see
  // routes/api2/foodbanks.test.ts), so "the API sets these" is not a rule of
  // the codebase that could be relied on to keep v1 correct.
  it("sends no Cache-Control and no CORS header on any endpoint", async () => {
    const paths = [
      "/api/1/foodbanks/",
      "/api/1/foodbanks/?format=csv",
      `/api/1/foodbanks/search/?lattlong=${QUERY_LAT_LNG}`,
      "/api/1/foodbank/salisbury/",
      "/api/1/needs/",
      `/api/1/need/${NEED_SALISBURY.dashed}/`,
    ];

    for (const path of paths) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBeNull();
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
  });

  // PLAN.md §7.9 is why these endpoints cannot simply be deleted:
  // `Foodbank.save()` reverses api_foodbanks/api_foodbank to purge them. In
  // this port that purge is a cache TAG (PLAN.md §3.6), so the tag has to
  // actually be on the response -- an untagged v1 response would go stale to
  // TTL after every admin edit, silently, on a deprecated API nobody watches.
  it("carries the cache tags the purge job invalidates by", async () => {
    expect((await get("/api/1/foodbanks/")).headers.get("Cache-Tag")).toBe("fb-all");
    expect((await get("/api/1/needs/")).headers.get("Cache-Tag")).toBe("fb-all");
    expect((await get("/api/1/foodbank/salisbury/")).headers.get("Cache-Tag")).toBe("fb-salisbury");
  });

  // Django's urlconf restricts no method: POST /api/1/foodbanks/ runs the same
  // view and returns the same JSON there. Hono registers these with app.get(),
  // so anything but GET falls through to the site's 404. Harmless -- every one
  // of these handlers is a pure read -- but pinned, because it is a real
  // difference in what the deprecated API answers and because the ONLY thing
  // making a POST safe here is that no handler writes.
  it("answers GET only, where Django answered any method", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await app.fetch(new Request(`${ORIGIN}/api/1/foodbanks/`, { method }), env(), execCtx);
      expect(res.status).toBe(404);
    }
  });

  // Django's APPEND_SLASH, reproduced by lib/appendSlash.ts: the unslashed form
  // 301s to the slashed one. It works here only because the probe that decides
  // it is a HEAD request and Hono answers HEAD from a GET route -- so this is
  // as much a test of that assumption as of the redirect. An absolute Location,
  // matching Django's own.
  it("301s the unslashed form onto the slashed one", async () => {
    for (const path of ["/api/1/foodbanks", "/api/1/needs", "/api/1/foodbank/salisbury"]) {
      const res = await get(path);
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe(`${ORIGIN}${path}/`);
    }
    // A slug that does not exist has nothing to redirect TO, so the probe fails
    // and the 404 page is served rather than a redirect into another 404.
    expect((await get("/api/1/foodbank/no-such-foodbank")).status).toBe(404);
  });

  // Unlike gfapi2, which is dual-mounted at /api/2 and the bare /api
  // (givefood/urls.py:94 and :96, two includes of one urlconf), gfapi1 has a
  // single include -- urls.py:93, `path('api/1/', include('gfapi1.urls'))`. A
  // /api/foodbanks/ request is gfapi2's own endpoint, with a completely
  // different body -- so this is not a missing alias to add.
  it("is mounted at /api/1 only", async () => {
    expect((await get("/api/1/foodbanks/")).status).toBe(200);
    const bare = await get("/api/foodbanks/");
    expect(await bare.text()).not.toBe(await (await get("/api/1/foodbanks/")).text());
  });

  // Every self/html URL in gfapi1 is `"%s%s" % (API_DOMAIN, reverse(...))`, and
  // API_DOMAIN is a module-level literal -- givefood/const/general.py:149-150,
  // `SITE_DOMAIN = "https://www.givefood.org.uk"` then `API_DOMAIN =
  // SITE_DOMAIN`, both read rather than assumed. Nothing about it comes from
  // the request, so a request arriving on any other hostname still publishes
  // www.givefood.org.uk URLs. Pinned because "use the request's origin" looks
  // like an improvement and would change every URL the beta environment hands
  // out.
  it("hardcodes www.givefood.org.uk in every self URL, whatever host was asked", async () => {
    const res = await app.fetch(new Request("https://beta.givefood.invalid/api/1/foodbank/salisbury/"), env(), execCtx);
    const body = (await res.json()) as { self: string; need_self: string };

    expect(body.self).toBe(`${ORIGIN}/api/1/foodbank/salisbury/`);
    expect(body.need_self).toBe(`${ORIGIN}/api/1/need/${NEED_SALISBURY.dashed}/`);
  });
});
