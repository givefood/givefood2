// @ts-ignore -- no @types/node under this package's tsconfig; vitest runs in node, where this module is real
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "./schema.testkit";
// @ts-ignore -- ditto; the migration files are read off disk so the fixture cannot drift from production
import { beforeEach, describe, expect, it } from "vitest";
import { getLocationsAndDonationPointsByFoodbankId } from "./foodbankDetail";
import { getLocationsByFoodbankId } from "./locations";
import { getDonationPointsByFoodbankId } from "./donationpoints";
import type { Session } from "./types";

// The pair of reads behind `/api/2/foodbank/<slug>/` (routes/api2/foodbanks.ts
// :136) -- a food bank's locations AND its donation points, fetched in one D1
// round trip instead of two. Django's originals are
// `Foodbank.locations()` and `Foodbank.donation_points()`
// (givefood/models/foodbank.py:546 and :552), both
// `.filter(foodbank = self).order_by("name")`, both called unconditionally by
// `gfapi2.views.foodbank` (:157 and :190) before the json/geojson branch.
// Verified against the Django source rather than taken from the port's own
// comments: neither queryset filters `is_closed`, and both sort by name.
//
// WHY A REAL DATABASE, AND NOT A MOCK. This module is thirteen lines and every
// one of the ways it can be wrong is SILENT -- no throw, no log, a 200 with
// wrong data:
//
//   * the two batch results read back in the wrong order, so the "locations"
//     array is the donation points and vice versa. Both row shapes have `id`,
//     `name` and `slug`, both go through a mapper that is a bare spread, and
//     the response serialises either way. Nothing errors.
//   * the food bank id bound to only one of the two statements, so every food
//     bank's page lists the whole country's donation points.
//   * `sortByName` dropped from one of the two lines, silently reverting that
//     list to SQLite's byte order -- which is NOT the order production served.
//   * an `is_closed = 0` helpfully added, silently deleting rows the API is
//     supposed to publish.
//   * the view swapped back to its base table, or its LEFT JOIN tightened to
//     an INNER JOIN.
//
// A session handing back canned rows agrees with all five, because the bug is
// in the SQL and a mock does not run SQL. This package already carries that
// scar: migration 0019 dropped five columns off six tables, four queries went
// on naming them, and /dashboard/beautybanks/ was a live 500 nobody noticed
// until it was measured.
//
// THE FIXTURE IS THE MIGRATION FILES THEMSELVES, applied in order, for exactly
// that reason -- a CREATE TABLE transcribed into this file is a second copy of
// the truth and drifts the same way 0019's dropped columns did. Both statements
// here read a VIEW (`foodbanklocation_full`, `foodbankdonationpoint_full`), and
// the view's LEFT JOIN is one of the things under test, so a hand-built
// stand-in row would have made those assertions circular.
//
// THE D1 100-BOUND-PARAMETER LIMIT has nothing to bite on here and there is
// deliberately no boundary case for it: both statements bind exactly one value
// and neither builds a variable-length IN list. If one ever does, that is the
// moment to add the at-and-over-100 cases (see getLocationsByIds, which does).
//
// MUTATION-TESTED TWICE (TESTING.md's convention -- the evidence that a test is
// load-bearing rather than decoration). The module, its two mappers, types.ts
// and migration 0019 were copied to a scratchpad, broken one way at a time, and
// this file re-run against each break. Fifty-one mutants; the ones worth naming,
// all caught: the two batch result indexes swapped, and the two statements
// swapped inside batch() with the indexes left alone; sortByName deleted from
// the locations line and from the donation points line, one at a time; sortByName
// reversed, replaced with a naive JS `<` comparison, and made to sort on `slug`
// instead of `name`; `AND is_closed = 0` added to each statement in turn, and the
// same filter applied in JS after the fetch; a `LIMIT 5` sneaked onto the
// locations statement; each read reverted from its _full view to its base table,
// and each narrowed from `SELECT *` to a column list; the batch unrolled into two
// sequential round trips; the donation-point statement's bound id hardcoded, its
// WHERE dropped entirely, and the locations statement's `foodbank_id = ?` changed
// to `id = ?`; the id string-interpolated into the SQL instead of bound; the
// second statement made a copy-paste of the first, and both lists built from the
// first result; the two lists de-duplicated against each other by id;
// mapLocationRow and mapDonationPointRow each replaced with a bare cast, and the
// two swapped; coerceBooleans made to collapse NULL to false; `is_closed`,
// `is_donation_point`, `in_store_only` and `wheelchair_accessible` deleted from
// their BOOLEAN_COLUMNS lists one at a time; the timestamps re-rendered through a
// Date on the way out; the whole "tidy-up" refactor of `ORDER BY name` in both
// statements with both sortByName calls removed; and -- run against the migration
// in a scratchpad rather than by editing it -- both views' LEFT JOIN tightened to
// an INNER JOIN, each view's aliases mis-fed by copy-paste (`f.url AS
// foodbank_email`, `f.name AS foodbank_slug`), the locations view joined on
// `f.id = l.id`, and `country` coalesced in the donation-point view.
//
// FIVE MUTANTS SURVIVED an earlier version of this file and each now has a test
// that kills it, named at that test. Every one of them survived for the same
// reason -- a fixture that only ever exercised the state the assertion already
// expected:
//
//   * `is_mobile` and `place_has_photo` deleted from LOCATION_BOOLEAN_COLUMNS,
//     and `place_has_photo` from the donation point list -- all three were
//     asserted only in their NULL state, where coerceBooleans does nothing.
//   * a column ADDED to a base table, which rides `l.*`/`d.*` into the view and
//     into every row, with neither hand-maintained interface declaring it --
//     invisible to an assertion that compares the database against itself.
//   * `AND f.is_closed = 0` added to both views' join condition, which empties
//     the parent fields of every CLOSED food bank's children. Every food bank
//     in the fixture was open.
//
// The first version did NOT kill the two dropped-sortByName mutants either. See
// the note above LOCATION_SEEDS for why, and for the case that now stops the
// fixture from quietly regressing to that state.


// ===========================================================================
// HARNESS
// ===========================================================================

type Bindable = null | number | bigint | string;

interface SqliteStatement {
  run(...params: Bindable[]): unknown;
  all(...params: Bindable[]): Array<Record<string, unknown>>;
  get(...params: Bindable[]): Record<string, unknown> | undefined;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

// What the harness saw the module ask for. Only the round-trip and binding
// cases look at this; everywhere else the ROWS are the assertion.
interface Executed {
  sql: string;
  params: Bindable[];
}

// The same adapter as constituencies.test.ts / adminStats.test.ts, so every
// tier drives the real code through one shape rather than three. Deliberately
// dumb -- it never inspects or rewrites the SQL, it hands the statement
// straight to SQLite, which is the entire point of the exercise.
//
// batch() RUNS ITS STATEMENTS IN ORDER AND RETURNS ONE RESULT PER INPUT, in
// that order, because the module indexes straight into the array
// (`results[0]!` / `results[1]!`). That indexing is the contract this file
// exists to defend: a batch that reordered or coalesced results would hand the
// donation points back as `locations` without erroring anywhere.
function d1Session(database: SqliteDatabase, log: { executed: Executed[]; batches: number }): Session {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => {
      log.executed.push({ sql, params });
      return (database.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    all: async () => {
      log.executed.push({ sql, params });
      return { results: database.prepare(sql).all(...params), success: true, meta: {} };
    },
    run: async () => {
      log.executed.push({ sql, params });
      database.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return {
    prepare: (sql: string) => statement(sql, []),
    batch: async (statements: Array<{ all: () => Promise<unknown> }>) => {
      log.batches += 1;
      const out: unknown[] = [];
      for (const each of statements) out.push(await each.all());
      return out;
    },
    getBookmark: () => null,
  } as unknown as Session;
}

let db: SqliteDatabase;
let session: Session;
let log: { executed: Executed[]; batches: number };

beforeEach(() => {
  db = new DatabaseSync(":memory:") as SqliteDatabase;
  db.exec(SCHEMA);
  log = { executed: [], batches: 0 };
  session = d1Session(db, log);
});

function columnsOf(table: string): string[] {
  return db
    .prepare("SELECT name FROM pragma_table_info(?)")
    .all(table)
    .map((row) => row.name as string);
}

// The order the module's own statement gets its rows in, before sortByName --
// i.e. what the answer would be if the sort were dropped. Not a stable
// contract in D1 or anywhere else; read here precisely to prove the module
// does not depend on it.
function namesInScanOrder(view: string): string[] {
  return db
    .prepare(`SELECT * FROM ${view} WHERE foodbank_id = ?`)
    .all(SALISBURY)
    .map((row) => row.name as string);
}

// What an `ORDER BY name` in the SQL would have produced on this engine:
// SQLite's default BINARY collation, byte for byte.
function namesInByteOrder(table: string): string[] {
  return db
    .prepare(`SELECT name FROM ${table} WHERE foodbank_id = ? ORDER BY name`)
    .all(SALISBURY)
    .map((row) => row.name as string);
}

// ===========================================================================
// SEEDS
// ===========================================================================

const SALISBURY = 1;
const TROWBRIDGE = 2;

// Django's own format, from 0022_normalise_timestamps.sql: 'YYYY-MM-DD
// HH:MM:SS.ffffff', six fractional digits, space separator, no offset. Never
// toISOString() -- these columns are TEXT and SQLite compares TEXT
// lexicographically, so a stray 'T' (0x54) sorts after a space (0x20) and every
// ISO value beat every Django value within the same day. That cost the site a
// wrong "latest published need" and dropped 31 of 46 rows from a threshold
// query before 0022 repaired it.
const MODIFIED = "2026-09-05 19:28:08.853000";

function seedFoodbank(id: number, name: string, slug: string, network: string | null = "Trussell"): void {
  db.prepare(
    `INSERT INTO foodbank
       (id, uuid, name, slug, address, postcode, country, lat_lng, latitude, longitude,
        network, charity_just_foodbank, contact_email, url, shopping_list_url,
        phone_number, address_is_administrative, is_closed, no_locations, days_between_needs,
        created, modified, edited)
     VALUES (?, ?, ?, ?, 'Unit 1\r\nSomewhere', 'SP2 9DY', 'England', '51.0688,-1.7945', 51.0688, -1.7945,
        ?, 1, ?, ?, ?,
        '01722 349556', 0, 0, 0, 7,
        ?, ?, ?)`,
  ).run(
    id,
    `uuid-foodbank-${id}`,
    name,
    slug,
    network,
    `info@${slug}.foodbank.org.uk`,
    `https://${slug}.foodbank.org.uk/`,
    `https://${slug}.foodbank.org.uk/give-help/donate-food/`,
    "2024-07-04 12:00:00.000000",
    MODIFIED,
    MODIFIED,
  );
}

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

interface LocationSeed {
  id: number;
  foodbankId: number;
  name: string;
  slug?: string;
  isClosed?: number;
  isDonationPoint?: number | null;
  isMobile?: number | null;
  placeHasPhoto?: number | null;
  boundaryGeojson?: string | null;
  edited?: string | null;
}

// Fills in the columns nothing in this module filters on, so each call site can
// say only what it is actually about. The ones that DO matter -- foodbank_id,
// name, and the four boolean columns coerceBooleans touches -- are explicit.
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
     VALUES (?, ?, ?, ?, ?, 'Pembroke Road', 'SP2 9DY', 'England', '51.0812,-1.8231', 51.0812, -1.8231,
        'ChIJVXealLU_xkcRja_At0z9AGY', 'QX2H+4M Salisbury', '9C3VQX2H+4M', ?,
        'Wiltshire', 'Wiltshire', 'Bemerton', 'E01032065', 'E02006654',
        41, 'Salisbury', 'salisbury',
        'John Glen', 'Conservative', 4051,
        ?, ?, ?, ?,
        '01722 349556', 'bemerton@salisbury.foodbank.org.uk', ?, ?)`,
  ).run(
    l.id,
    `uuid-location-${l.id}`,
    l.foodbankId,
    l.name,
    l.slug ?? slugify(l.name),
    l.placeHasPhoto === undefined ? null : l.placeHasPhoto,
    l.isClosed ?? 0,
    l.isDonationPoint === undefined ? null : l.isDonationPoint,
    l.isMobile === undefined ? null : l.isMobile,
    l.boundaryGeojson === undefined ? null : l.boundaryGeojson,
    MODIFIED,
    l.edited === undefined ? null : l.edited,
  );
}

interface DonationPointSeed {
  id: number;
  foodbankId: number;
  name: string;
  slug?: string;
  isClosed?: number;
  inStoreOnly?: number;
  wheelchairAccessible?: number | null;
  placeHasPhoto?: number | null;
  country?: string | null;
  companySlug?: string | null;
  edited?: string | null;
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
        company, company_slug, store_id, notes, modified, edited)
     VALUES (?, ?, ?, ?, ?, 'Southampton Road', 'SP1 2LN', ?, '51.0655,-1.7905', 51.0655, -1.7905,
        'ChIJ68J3tUsbdkgRDVK5UPlkX4A', 'QX2H+4M Salisbury', '9C3VQX2H+4M', ?,
        'Wiltshire', 'Wiltshire', 'St Martin', 'E01032072', 'E02006658',
        41, 'Salisbury', 'salisbury',
        'John Glen', 'Conservative', 4051,
        ?, ?, '01722 333444', 'https://www.tesco.com/store-locator/salisbury', 'Mon-Sat 08:00-22:00', ?,
        'Tesco', ?, '3421', 'Trolley by the tills', ?, ?)`,
  ).run(
    d.id,
    `uuid-donationpoint-${d.id}`,
    d.foodbankId,
    d.name,
    d.slug ?? slugify(d.name),
    d.country === undefined ? "England" : d.country,
    d.placeHasPhoto === undefined ? null : d.placeHasPhoto,
    d.isClosed ?? 0,
    d.inStoreOnly ?? 0,
    d.wheelchairAccessible === undefined ? null : d.wheelchairAccessible,
    d.companySlug === undefined ? "tesco" : d.companySlug,
    MODIFIED,
    d.edited === undefined ? null : d.edited,
  );
}

// A boundary blob recognisable in a row dump. The real ones run to ~1.6 MB;
// nothing here needs the size, only the presence.
const BOUNDARY = '{"type":"Polygon","coordinates":[[[-1.9,51.0],[-1.7,51.0],[-1.7,51.1],[-1.9,51.0]]]}';

const COLLATOR = new Intl.Collator("en-US");

// The three name shapes where SQLite's BINARY collation and en-US genuinely
// disagree, established by running both orders rather than by reasoning about
// code points:
//
//   lowercase initial   "iCentre" sorts after EVERY uppercase name in byte
//                       order ('i' is 0x69, 'Z' is 0x5A) and between H and J
//                       under the collator.
//   accented letter     "Ynys Môn" sorts AFTER "Ynys Mona" in byte order (the
//                       UTF-8 lead byte of 'ô' is 0xC3, above plain 'o' at
//                       0x6F) and BEFORE it under the collator, which weighs
//                       'ô' as an 'o' and then finds "Môn" the shorter prefix.
//   space before letter "Ely and" sorts after "Ely Bridge" in byte order
//                       (' ' is 0x20, but 'B' 0x42 < 'a' 0x61) and before it
//                       under the collator.
//
// Real Welsh place names are used for the accent case because this repo
// already sorts them for real -- "Ynys Môn" is one of the 650 constituencies.
//
// THE SLUGS ARE DELIBERATELY NOT DERIVED FROM THESE NAMES, and that is the
// whole reason these fixtures are written out by hand instead of generated.
// SQLite answers `WHERE foodbank_id = ?` on both tables from the (foodbank_id,
// slug) index -- loc_foodbank_slug_idx and dp_foodbank_slug_idx -- so the rows
// arrive in SLUG order. A production-shaped slug is `locationSlug(name)`:
// lower-cased, accent-stripped, punctuation-collapsed -- which is very nearly
// what the en-US collator does to a name before comparing it. Seed the obvious
// way and the engine hands the rows back ALREADY in collation order, sortByName
// becomes a no-op, and deleting it passes every assertion below. That was not a
// hypothetical: the first version of this file did exactly that, and the
// dropped-sortByName mutant survived it.
//
// So each slug here is chosen to make the incoming order the REVERSE of the
// collated one. The sort has to do real work, and the last case in this block
// asserts that the fixture is still arranged that way -- so if someone later
// "tidies" these slugs to match their names, they are told the fixture has gone
// toothless instead of finding out never.
const LOCATION_SEEDS = [
  { name: "Ynys Môn Hall", slug: "bemerton-heath" },
  { name: "Amesbury Library", slug: "wilton-road" },
  { name: "iCentre Durrington", slug: "downton-hub" },
  { name: "Ynys Mona Hall", slug: "amesbury-abbey" },
  { name: "Ely and District Hall", slug: "tisbury-annexe" },
  { name: "Ely Bridge Centre", slug: "salisbury-central" },
];

const DONATION_POINT_SEEDS = [
  { name: "Tesco Extra Salisbury", slug: "coop-wilton" },
  { name: "iCentre Kiosk", slug: "waitrose-salisbury" },
  { name: "Ynys Môn Co-op", slug: "budgens-downton" },
  { name: "Ynys Mona Co-op", slug: "aldi-amesbury" },
  { name: "Sainsbury's Wilton", slug: "morrisons-tisbury" },
];

const LOCATION_NAMES = LOCATION_SEEDS.map((s) => s.name);
const DONATION_POINT_NAMES = DONATION_POINT_SEEDS.map((s) => s.name);

// ===========================================================================
// ONE ROUND TRIP
// ===========================================================================

describe("the batch", () => {
  beforeEach(() => {
    seedFoodbank(SALISBURY, "Salisbury Foodbank", "salisbury");
  });

  // THE WHOLE REASON THIS MODULE EXISTS, and the one claim no row-level
  // assertion in this file can make. The module's header says the detail
  // endpoint was measured at ~2x Django's and that this sequential pair was the
  // biggest piece of it; D1 charges per round trip, so a refactor back to two
  // sequential awaits would return byte-identical data, pass every other test
  // here, and quietly undo the fix.
  it("sends both SELECTs in a single round trip, not two sequential ones", async () => {
    await getLocationsAndDonationPointsByFoodbankId(session, SALISBURY);

    expect(log.batches).toBe(1);
    expect(log.executed).toHaveLength(2);
  });

  // The id must reach BOTH statements. Bound to only one, that statement
  // becomes an unfiltered scan -- every food bank's page would list all 5,700
  // donation points in the country. (SQLite would in fact refuse an unbound
  // `?`, but a hardcoded id, or the wrong variable, would not raise: this
  // asserts the value, not merely that something was bound.)
  //
  // Asserting the PARAMS, not just the SQL, is also what catches the id being
  // interpolated into the statement text instead of bound -- which would still
  // return the right rows here, and is a SQL injection everywhere the argument
  // is not already a number. There is deliberately no swapped-parameter case:
  // both statements bind one value and it is the same value, so a swap is a
  // genuine no-op rather than an untested mutant.
  it("binds the same food bank id to both statements", async () => {
    await getLocationsAndDonationPointsByFoodbankId(session, SALISBURY);

    expect(log.executed[0]!.params).toEqual([SALISBURY]);
    expect(log.executed[1]!.params).toEqual([SALISBURY]);
  });

  // Both reads go through the VIEWS, never the base tables. After 0019 the base
  // tables no longer HAVE foodbank_name / foodbank_slug / foodbank_network, and
  // FoodbankLocationRow and DonationPointRow still declare them -- so a revert
  // to `FROM foodbanklocation` gives every caller undefined where the parent's
  // name should be, which serialises to a missing JSON key rather than an
  // error. Asserted on the statement because a row from the base table would
  // simply be missing keys, which the mappers' bare casts do not notice.
  it("reads the two _full views, never the base tables", async () => {
    await getLocationsAndDonationPointsByFoodbankId(session, SALISBURY);

    expect(log.executed[0]!.sql).toBe("SELECT * FROM foodbanklocation_full WHERE foodbank_id = ?");
    expect(log.executed[1]!.sql).toBe("SELECT * FROM foodbankdonationpoint_full WHERE foodbank_id = ?");
  });
});

// ===========================================================================
// WHICH LIST IS WHICH
// ===========================================================================
// batch() returns one result per input statement in input order, and the module
// reads them back by hard-coded index (`results[0]!`, `results[1]!`). Swap those
// two indexes and NOTHING throws: both tables have id/uuid/name/slug, both
// mappers are `{...raw}` with a few 0/1 columns rewritten, and
// routes/api2/foodbanks.ts reads only fields that exist on both or serialise as
// undefined. The API would publish each food bank's donation points as its
// locations and vice versa, at 200, forever.

describe("the two lists are not interchangeable", () => {
  beforeEach(() => {
    seedFoodbank(SALISBURY, "Salisbury Foodbank", "salisbury");
    // Deliberately OVERLAPPING primary keys across the two tables -- id 20
    // exists in both. They are separate tables with independent id sequences
    // and production really does collide this way, so anything that keyed or
    // de-duplicated by id across the pair fails here rather than in the field.
    seedLocation({ id: 20, foodbankId: SALISBURY, name: "Bemerton Heath Centre" });
    seedLocation({ id: 21, foodbankId: SALISBURY, name: "Amesbury Library" });
    seedDonationPoint({ id: 20, foodbankId: SALISBURY, name: "Tesco Extra Salisbury" });
    seedDonationPoint({ id: 21, foodbankId: SALISBURY, name: "Sainsbury's Wilton" });
  });

  it("puts the locations in `locations` and the donation points in `donationPoints`", async () => {
    const { locations, donationPoints } = await getLocationsAndDonationPointsByFoodbankId(session, SALISBURY);

    expect(locations.map((l) => l.name)).toEqual(["Amesbury Library", "Bemerton Heath Centre"]);
    expect(donationPoints.map((d) => d.name)).toEqual(["Sainsbury's Wilton", "Tesco Extra Salisbury"]);
  });

  // The name check above would survive a swap on a food bank whose two lists
  // happened to be similar. This one cannot: it compares each row's own key set
  // against the view it must have come from. `boundary_geojson` and `is_mobile`
  // exist only on a location; `in_store_only`, `wheelchair_accessible` and
  // `store_id` only on a donation point.
  it("hands back rows shaped by their own table, so a swapped result index cannot pass", async () => {
    const { locations, donationPoints } = await getLocationsAndDonationPointsByFoodbankId(session, SALISBURY);

    expect(Object.keys(locations[0]!)).toContain("boundary_geojson");
    expect(Object.keys(locations[0]!)).toContain("is_mobile");
    expect(Object.keys(locations[0]!)).not.toContain("in_store_only");
    expect(Object.keys(locations[0]!)).not.toContain("wheelchair_accessible");

    expect(Object.keys(donationPoints[0]!)).toContain("in_store_only");
    expect(Object.keys(donationPoints[0]!)).toContain("store_id");
    expect(Object.keys(donationPoints[0]!)).not.toContain("boundary_geojson");
    expect(Object.keys(donationPoints[0]!)).not.toContain("is_mobile");
  });

  // A food bank with locations but no donation points, and one with donation
  // points but no locations. Either list going missing, or being filled from
  // the other, shows up here as an obvious wrong answer -- and this is the
  // shape most production food banks actually have.
  it("returns an empty list for the side a food bank has none of", async () => {
    seedFoodbank(TROWBRIDGE, "Trowbridge Foodbank", "trowbridge");
    seedDonationPoint({ id: 30, foodbankId: TROWBRIDGE, name: "Morrisons Trowbridge" });

    const trowbridge = await getLocationsAndDonationPointsByFoodbankId(session, TROWBRIDGE);

    expect(trowbridge.locations).toEqual([]);
    expect(trowbridge.donationPoints.map((d) => d.name)).toEqual(["Morrisons Trowbridge"]);
  });
});

// ===========================================================================
// SCOPING
// ===========================================================================

describe("scoping to one food bank", () => {
  beforeEach(() => {
    seedFoodbank(SALISBURY, "Salisbury Foodbank", "salisbury");
    seedFoodbank(TROWBRIDGE, "Trowbridge Foodbank", "trowbridge");
  });

  // A filter that does nothing passes every test that only seeds matching rows,
  // so the neighbour's rows are seeded on purpose. Losing `WHERE foodbank_id = ?`
  // on the donation-point statement would put all 5,700 of the country's
  // donation points on every food bank's API response and its public page.
  it("excludes another food bank's locations and donation points", async () => {
    seedLocation({ id: 20, foodbankId: SALISBURY, name: "Bemerton Heath Centre" });
    seedLocation({ id: 21, foodbankId: TROWBRIDGE, name: "Melksham Centre" });
    seedDonationPoint({ id: 30, foodbankId: SALISBURY, name: "Tesco Extra Salisbury" });
    seedDonationPoint({ id: 31, foodbankId: TROWBRIDGE, name: "Tesco Extra Trowbridge" });

    const { locations, donationPoints } = await getLocationsAndDonationPointsByFoodbankId(session, SALISBURY);

    expect(locations.map((l) => l.name)).toEqual(["Bemerton Heath Centre"]);
    expect(donationPoints.map((d) => d.name)).toEqual(["Tesco Extra Salisbury"]);
  });

  // CARDINALITY. Two independent SELECTs, not one join -- so two locations and
  // three donation points must come back as 2 and 3, never as 6 of each. A
  // "simplification" into a single joined statement would multiply both lists
  // and the API would repeat every location once per donation point.
  it("does not multiply the two lists against each other", async () => {
    seedLocation({ id: 20, foodbankId: SALISBURY, name: "Bemerton Heath Centre" });
    seedLocation({ id: 21, foodbankId: SALISBURY, name: "Amesbury Library" });
    seedDonationPoint({ id: 30, foodbankId: SALISBURY, name: "Tesco Extra Salisbury" });
    seedDonationPoint({ id: 31, foodbankId: SALISBURY, name: "Sainsbury's Wilton" });
    seedDonationPoint({ id: 32, foodbankId: SALISBURY, name: "Waitrose Salisbury" });

    const { locations, donationPoints } = await getLocationsAndDonationPointsByFoodbankId(session, SALISBURY);

    // The names as well as the counts: 2 and 3 would also be satisfied by a
    // join that returned the right number of the wrong rows.
    expect(locations.map((l) => l.name)).toEqual(["Amesbury Library", "Bemerton Heath Centre"]);
    expect(donationPoints.map((d) => d.name)).toEqual(["Sainsbury's Wilton", "Tesco Extra Salisbury", "Waitrose Salisbury"]);
  });

  it("returns two empty arrays for a food bank with neither", async () => {
    expect(await getLocationsAndDonationPointsByFoodbankId(session, SALISBURY)).toEqual({ locations: [], donationPoints: [] });
  });

  // The caller destructures the result unconditionally and maps both lists
  // (routes/api2/foodbanks.ts:136-140), so an unknown id must give two empty
  // arrays rather than throwing or returning undefined. Reachable in practice:
  // getFoodbankBySlug 404s first today, but nothing in this function's contract
  // depends on that.
  it("returns two empty arrays for a food bank id that does not exist", async () => {
    seedLocation({ id: 20, foodbankId: SALISBURY, name: "Bemerton Heath Centre" });
    seedDonationPoint({ id: 30, foodbankId: SALISBURY, name: "Tesco Extra Salisbury" });

    expect(await getLocationsAndDonationPointsByFoodbankId(session, 9999)).toEqual({ locations: [], donationPoints: [] });
  });
});

// ===========================================================================
// ORDERING
// ===========================================================================
// Both Django querysets carry `.order_by("name")`, executed by Postgres under
// en_US.utf8. The port sorts in JS with Intl.Collator("en-US") instead, because
// D1's default TEXT collation is BINARY and an `ORDER BY name` reproduced
// verbatim would reorder any list with mixed-case or accented names -- see
// sortByName's comment in types.ts. Each list is sorted on its own line of the
// return statement, so each needs its own assertion: deleting one `sortByName`
// leaves the other passing.

describe("ordering", () => {
  beforeEach(() => {
    seedFoodbank(SALISBURY, "Salisbury Foodbank", "salisbury");
    LOCATION_SEEDS.forEach((seed, i) => seedLocation({ id: 20 + i, foodbankId: SALISBURY, ...seed }));
    DONATION_POINT_SEEDS.forEach((seed, i) => seedDonationPoint({ id: 40 + i, foodbankId: SALISBURY, ...seed }));
  });

  // Seeded out of order, so a dropped sort is a different list and not a
  // coincidence. The exact sequence is the assertion, not "is sorted".
  it("returns the locations in en-US collation order", async () => {
    const { locations } = await getLocationsAndDonationPointsByFoodbankId(session, SALISBURY);

    expect(locations.map((l) => l.name)).toEqual([
      "Amesbury Library",
      "Ely and District Hall",
      "Ely Bridge Centre",
      "iCentre Durrington",
      "Ynys Môn Hall",
      "Ynys Mona Hall",
    ]);
  });

  it("returns the donation points in en-US collation order", async () => {
    const { donationPoints } = await getLocationsAndDonationPointsByFoodbankId(session, SALISBURY);

    expect(donationPoints.map((d) => d.name)).toEqual([
      "iCentre Kiosk",
      "Sainsbury's Wilton",
      "Tesco Extra Salisbury",
      "Ynys Môn Co-op",
      "Ynys Mona Co-op",
    ]);
  });

  // THE MUTANT THE TWO CASES ABOVE CANNOT KILL ON THEIR OWN: `ORDER BY name`
  // added to the SQL and sortByName removed, which looks like a tidy-up and
  // reads as "still sorted". Both orders are computed by the engine and the
  // collator here rather than written down, so this records a genuine
  // disagreement between two real orderings instead of a claim about one.
  it("is NOT the byte order an ORDER BY name would have produced on this engine", async () => {
    const { locations, donationPoints } = await getLocationsAndDonationPointsByFoodbankId(session, SALISBURY);

    expect(locations.map((l) => l.name)).not.toEqual(namesInByteOrder("foodbanklocation"));
    expect(donationPoints.map((d) => d.name)).not.toEqual(namesInByteOrder("foodbankdonationpoint"));
    // ...and it IS what the collator says, so this is a statement about which
    // of two real orders was chosen, not merely that something was shuffled.
    expect(locations.map((l) => l.name)).toEqual([...LOCATION_NAMES].sort(COLLATOR.compare));
    expect(donationPoints.map((d) => d.name)).toEqual([...DONATION_POINT_NAMES].sort(COLLATOR.compare));
  });

  // THE FIXTURE'S OWN SMOKE ALARM, and the reason the two ordering cases above
  // are worth anything. Both statements are answered from the (foodbank_id,
  // slug) index, so the rows arrive in slug order -- and a slug derived from a
  // name the production way lands very close to that name's collation position.
  // Seeded that way, the engine does the sorting, sortByName becomes a no-op,
  // and every assertion above passes with it deleted. The slugs in
  // LOCATION_SEEDS / DONATION_POINT_SEEDS therefore hand the rows in REVERSE
  // collated order on purpose. This asserts they still do: change them to match
  // their names and this fails here, loudly, rather than quietly turning the
  // ordering coverage into decoration.
  it("is handed the rows in an order that is genuinely wrong, so the sort has work to do", async () => {
    const { locations, donationPoints } = await getLocationsAndDonationPointsByFoodbankId(session, SALISBURY);

    expect(namesInScanOrder("foodbanklocation_full")).toEqual([...LOCATION_NAMES].sort(COLLATOR.compare).reverse());
    expect(namesInScanOrder("foodbankdonationpoint_full")).toEqual([...DONATION_POINT_NAMES].sort(COLLATOR.compare).reverse());

    expect(locations.map((l) => l.name)).not.toEqual(namesInScanOrder("foodbanklocation_full"));
    expect(donationPoints.map((d) => d.name)).not.toEqual(namesInScanOrder("foodbankdonationpoint_full"));
  });
});

// ===========================================================================
// NO is_closed FILTER
// ===========================================================================

describe("closed rows", () => {
  // DELIBERATE, AND THE OPPOSITE OF THE HOT QUERIES EITHER SIDE OF IT.
  // getAllOpenLocations, getOpenDonationPointsByCountry and every search
  // candidate set filter `is_closed = 0`; these two do not, because Django's
  // `Foodbank.locations()` / `donation_points()` do not
  // (models/foodbank.py:546, :552 -- confirmed in the source, both are a bare
  // `.filter(foodbank = self).order_by("name")`). A food bank's own detail page
  // lists its closed sites so a visitor who knows the old address learns it has
  // closed rather than finding nothing. `is_closed` is the one cached parent
  // field 0019 deliberately KEPT on the child tables, which is what makes an
  // `AND is_closed = 0` such an easy line to add here by analogy -- and it
  // would silently delete rows from a live public endpoint.
  it("returns closed locations and closed donation points, because neither queryset filters them", async () => {
    seedFoodbank(SALISBURY, "Salisbury Foodbank", "salisbury");
    seedLocation({ id: 20, foodbankId: SALISBURY, name: "Amesbury Library", isClosed: 0 });
    seedLocation({ id: 21, foodbankId: SALISBURY, name: "Bemerton Heath Centre", isClosed: 1 });
    seedDonationPoint({ id: 30, foodbankId: SALISBURY, name: "Sainsbury's Wilton", isClosed: 0 });
    seedDonationPoint({ id: 31, foodbankId: SALISBURY, name: "Tesco Extra Salisbury", isClosed: 1 });

    const { locations, donationPoints } = await getLocationsAndDonationPointsByFoodbankId(session, SALISBURY);

    expect(locations.map((l) => l.name)).toEqual(["Amesbury Library", "Bemerton Heath Centre"]);
    expect(locations.map((l) => l.is_closed)).toEqual([false, true]);
    expect(donationPoints.map((d) => d.name)).toEqual(["Sainsbury's Wilton", "Tesco Extra Salisbury"]);
    expect(donationPoints.map((d) => d.is_closed)).toEqual([false, true]);
  });
});

// ===========================================================================
// THE VIEWS
// ===========================================================================

describe("the parent food bank's fields", () => {
  beforeEach(() => {
    seedFoodbank(SALISBURY, "Salisbury Foodbank", "salisbury");
    seedLocation({ id: 20, foodbankId: SALISBURY, name: "Bemerton Heath Centre" });
    seedDonationPoint({ id: 30, foodbankId: SALISBURY, name: "Tesco Extra Salisbury" });
  });

  // THE POINT OF 0019, and the shortest possible proof the cached copy is gone.
  // The copy was refreshed only in the CHILD's save() and Foodbank.save() did
  // not cascade, so renaming a food bank left every location and donation point
  // holding the old value: measured against production before 0019, 24 rows
  // disagreed with their parent's slug and name, 44 with its phone number, 38
  // with its email. Because getDonationPointBySlugs FINDS a child by that
  // cached slug, a stale copy 404s the child's own page.
  it("comes live from the foodbank table, not from a copy on the child row", async () => {
    db.prepare("UPDATE foodbank SET name = ?, slug = ?, network = ?, phone_number = ?, contact_email = ? WHERE id = ?").run(
      "Salisbury & District Foodbank",
      "salisbury-and-district",
      "IFAN",
      "01722 000111",
      "hello@salisbury-and-district.foodbank.org.uk",
      SALISBURY,
    );

    const { locations, donationPoints } = await getLocationsAndDonationPointsByFoodbankId(session, SALISBURY);

    expect(locations[0]!.foodbank_name).toBe("Salisbury & District Foodbank");
    expect(locations[0]!.foodbank_slug).toBe("salisbury-and-district");
    expect(locations[0]!.foodbank_network).toBe("IFAN");
    expect(locations[0]!.foodbank_phone_number).toBe("01722 000111");
    expect(locations[0]!.foodbank_email).toBe("hello@salisbury-and-district.foodbank.org.uk");

    // The donation-point view joins three of the five; DonationPointRow
    // declares exactly those three and no phone/email, matching 0019.
    expect(donationPoints[0]!.foodbank_name).toBe("Salisbury & District Foodbank");
    expect(donationPoints[0]!.foodbank_slug).toBe("salisbury-and-district");
    expect(donationPoints[0]!.foodbank_network).toBe("IFAN");
  });

  // A CLOSED PARENT, which every other fixture in this file is not. THE MUTANT:
  // `AND f.is_closed = 0` added to the views' join condition -- the same
  // "helpfully filter the closed ones" instinct that the is_closed section
  // above guards the WHERE clause against, one level up in the ON clause where
  // it does something far worse than drop rows. The children survive; their
  // parent fields all go NULL. `foodbank_slug` is how the geojson branch builds
  // every location's and donation point's URL (routes/api2/foodbanks.ts:315
  // and :333), so the whole feature collection would carry
  // "/needs/at/null/..." links, and emailOrFoodbankEmail /
  // phoneOrFoodbankPhone would lose their fallbacks.
  //
  // This survived until it was seeded: a closed food bank's own detail page and
  // API response are still served -- `closed: foodbank.is_closed` is a
  // published field, not a 404 -- so a fixture where every parent is open tests
  // only half of production.
  it("resolves the parent's fields for a CLOSED food bank's own locations and donation points", async () => {
    db.prepare("UPDATE foodbank SET is_closed = 1 WHERE id = ?").run(SALISBURY);

    const { locations, donationPoints } = await getLocationsAndDonationPointsByFoodbankId(session, SALISBURY);

    expect(locations.map((l) => l.name)).toEqual(["Bemerton Heath Centre"]);
    expect(locations[0]!.foodbank_name).toBe("Salisbury Foodbank");
    expect(locations[0]!.foodbank_slug).toBe("salisbury");
    expect(locations[0]!.foodbank_email).toBe("info@salisbury.foodbank.org.uk");
    expect(donationPoints.map((d) => d.name)).toEqual(["Tesco Extra Salisbury"]);
    expect(donationPoints[0]!.foodbank_slug).toBe("salisbury");
    expect(donationPoints[0]!.foodbank_network).toBe("Trussell");
  });

  // THE LEFT JOIN, which is the reason this file seeds from the real migration
  // rather than a hand-written CREATE VIEW. D1 has no foreign keys (PLAN.md
  // §4.5), so a child can outlive its parent row; 0019's header says "LEFT
  // JOIN, not JOIN ... a LEFT JOIN cannot lose a row either way". Tighten
  // either view to an INNER JOIN and these two rows vanish off the food bank's
  // page and out of its API response with nothing raised anywhere.
  it("keeps a location and a donation point whose parent row is missing, with NULL parent fields", async () => {
    seedLocation({ id: 21, foodbankId: 999, name: "Orphan Centre" });
    seedDonationPoint({ id: 31, foodbankId: 999, name: "Orphan Co-op" });

    const { locations, donationPoints } = await getLocationsAndDonationPointsByFoodbankId(session, 999);

    expect(locations.map((l) => l.name)).toEqual(["Orphan Centre"]);
    expect(locations[0]!.foodbank_name).toBeNull();
    expect(locations[0]!.foodbank_slug).toBeNull();
    expect(locations[0]!.foodbank_email).toBeNull();

    expect(donationPoints.map((d) => d.name)).toEqual(["Orphan Co-op"]);
    expect(donationPoints[0]!.foodbank_name).toBeNull();
    expect(donationPoints[0]!.foodbank_network).toBeNull();
  });
});

// ===========================================================================
// THE FULL ROW
// ===========================================================================

// THE SECOND COPY OF THE TRUTH, WRITTEN DOWN ON PURPOSE. Everything else in
// this file reads the schema off disk precisely so it cannot drift; these two
// lists are the deliberate exception, because drift is the thing they exist to
// catch. `Object.keys(row)` compared against `columnsOf(view)` is two readings
// of the SAME database, so a `SELECT *` read matches it by construction no
// matter what the schema says -- A COLUMN ADDED TO EITHER BASE TABLE RIDES
// `l.*`/`d.*` STRAIGHT INTO THE VIEW, INTO EVERY ROW AND PAST THAT ASSERTION,
// which is a mutant that survived the version of this file without these lists.
//
// The lists below are FoodbankLocationRow's and DonationPointRow's field sets
// (locations.ts:9, donationpoints.ts:6) -- hand-maintained TypeScript
// interfaces that are erased at runtime and so can never disagree with the
// database on their own. Written in the view's column order, which differs from
// the interfaces' only in that the joined foodbank_* fields are declared near
// the top of each interface and appended by each view.
//
// So the next ALTER TABLE on foodbanklocation or foodbankdonationpoint fails
// here, loudly, and whoever wrote it has to decide what the interface should
// say -- rather than shipping a public API row with an undeclared field on it,
// or (0019's actual scar, in reverse) an interface promising a column the view
// no longer has.
const LOCATION_FULL_COLUMNS = [
  "id", "uuid", "foodbank_id", "name", "slug", "address", "postcode", "country", "lat_lng", "latitude", "longitude",
  "place_id", "plus_code_compound", "plus_code_global", "place_has_photo",
  "county", "district", "ward", "lsoa", "msoa",
  "parliamentary_constituency_id", "parliamentary_constituency_name", "parliamentary_constituency_slug",
  "mp", "mp_party", "mp_parl_id",
  "is_closed", "is_donation_point", "is_mobile", "boundary_geojson",
  "phone_number", "email", "modified", "edited",
  "foodbank_name", "foodbank_slug", "foodbank_network", "foodbank_phone_number", "foodbank_email",
];

const DONATION_POINT_FULL_COLUMNS = [
  "id", "uuid", "foodbank_id", "name", "slug", "address", "postcode", "country", "lat_lng", "latitude", "longitude",
  "place_id", "plus_code_compound", "plus_code_global", "place_has_photo",
  "county", "district", "ward", "lsoa", "msoa",
  "parliamentary_constituency_id", "parliamentary_constituency_name", "parliamentary_constituency_slug",
  "mp", "mp_party", "mp_parl_id",
  "is_closed", "in_store_only", "phone_number", "url", "opening_hours", "wheelchair_accessible",
  "company", "company_slug", "store_id", "notes", "modified", "edited",
  "foodbank_name", "foodbank_slug", "foodbank_network",
];

describe("the columns that come back", () => {
  beforeEach(() => {
    seedFoodbank(SALISBURY, "Salisbury Foodbank", "salisbury");
  });

  // THE 0019 DRIFT DETECTOR. FoodbankLocationRow and DonationPointRow are
  // hand-maintained TypeScript interfaces; the views are defined in a
  // migration. Those are two copies of one list and they drift -- which is
  // precisely what 0019 did to four other queries, leaving four queries naming
  // five columns that no longer existed and /dashboard/beautybanks/ a live 500.
  //
  // THREE ASSERTIONS, AND THEY ARE NOT THE SAME ONE. The row's keys against the
  // view's columns catches the module narrowing away from `SELECT *`; the
  // view's columns against LOCATION_FULL_COLUMNS catches the schema moving
  // under the interface in EITHER direction, which nothing derived from the
  // database can do (see that list's comment: the added-column mutant survived
  // until it existed).
  //
  // These are SELECT * reads, so `boundary_geojson` really does ride along on
  // every location -- unlike the narrow variants elsewhere in the package. The
  // blob is asserted rather than described BECAUSE IT IS THE SUSPECT PART OF
  // THIS QUERY: the sole caller (routes/api2/foodbanks.ts:136) reads neither
  // branch's boundary -- the json branch never mentions it and the geojson
  // branch emits Point features only (:306-341) -- so a module whose entire
  // reason for existing is a measured round-trip saving is also shipping a
  // column that can run to ~1.6 MB per location and is then discarded.
  // Everything that DOES want the boundary (lib/buildGeojson.ts,
  // wfbn/locationDetail.ts, jobs' map.png) comes through a different query.
  // Pinned as behaviour, not endorsed as a design: narrowing this statement
  // would be an improvement, and this is the test that makes it a deliberate
  // change rather than an accident.
  it("returns every column of foodbanklocation_full, boundary_geojson included", async () => {
    seedLocation({ id: 20, foodbankId: SALISBURY, name: "Bemerton Heath Centre", boundaryGeojson: BOUNDARY });

    const { locations } = await getLocationsAndDonationPointsByFoodbankId(session, SALISBURY);

    expect(columnsOf("foodbanklocation_full")).toEqual(LOCATION_FULL_COLUMNS);
    expect(Object.keys(locations[0]!).sort()).toEqual([...LOCATION_FULL_COLUMNS].sort());
    expect(Object.keys(locations[0]!).sort()).toEqual(columnsOf("foodbanklocation_full").sort());
    expect(locations[0]!.boundary_geojson).toBe(BOUNDARY);
  });

  it("returns every column of foodbankdonationpoint_full", async () => {
    seedDonationPoint({ id: 30, foodbankId: SALISBURY, name: "Tesco Extra Salisbury" });

    const { donationPoints } = await getLocationsAndDonationPointsByFoodbankId(session, SALISBURY);

    expect(columnsOf("foodbankdonationpoint_full")).toEqual(DONATION_POINT_FULL_COLUMNS);
    expect(Object.keys(donationPoints[0]!).sort()).toEqual([...DONATION_POINT_FULL_COLUMNS].sort());
    expect(Object.keys(donationPoints[0]!).sort()).toEqual(columnsOf("foodbankdonationpoint_full").sort());
    // The four the detail endpoint reads and nothing else in the row implies,
    // so a column dropped from the view is named here rather than only counted.
    expect(donationPoints[0]!.url).toBe("https://www.tesco.com/store-locator/salisbury");
    expect(donationPoints[0]!.opening_hours).toBe("Mon-Sat 08:00-22:00");
    expect(donationPoints[0]!.store_id).toBe("3421");
    expect(donationPoints[0]!.company_slug).toBe("tesco");
  });

  // coerceBooleans, wired through each module's own BOOLEAN_COLUMNS list. D1
  // returns 0/1/NULL and every consumer downstream -- packages/serialise, the
  // templates -- tests these as booleans, where the integer 0 is falsy but the
  // STRING "0" and the number 1 are not. is_donation_point and is_mobile are
  // NULLABLE in production despite the model declaring them NOT NULL
  // (0001_core.sql:71: 567 and 1,773 of 1,972 rows are NULL), and NULL must
  // survive as null rather than collapsing to false: "we do not know" is not
  // "no". `is_donation_point` is published raw by this endpoint
  // (routes/api2/foodbanks.ts:148 in the json branch, :320 in the geojson one),
  // where Django emits true/false, so an uncoerced 1 is a visible change to the
  // public JSON.
  //
  // ALL FOUR COLUMNS ARE EXERCISED IN ALL THREE STATES, which is not
  // thoroughness for its own sake: TWO MUTANTS SURVIVED THE VERSION THAT DID
  // NOT -- `is_mobile` deleted from LOCATION_BOOLEAN_COLUMNS, and
  // `place_has_photo` deleted from it. Both were asserted here only where the
  // column was NULL, and coerceBooleans maps NULL to null, i.e. does nothing at
  // all. A mapper that had stopped coercing either one entirely, handing back
  // the raw integer 1 where FoodbankLocationRow promises `true`, passed every
  // assertion in this file. Only the 1 and the 0 cases can tell coercion from
  // its absence, so every column in the list needs all three.
  it("coerces every location boolean column in all three of its states", async () => {
    seedLocation({ id: 20, foodbankId: SALISBURY, name: "Set", isClosed: 1, isDonationPoint: 1, isMobile: 1, placeHasPhoto: 1 });
    seedLocation({ id: 21, foodbankId: SALISBURY, name: "Cleared", isClosed: 0, isDonationPoint: 0, isMobile: 0, placeHasPhoto: 0 });
    seedLocation({ id: 22, foodbankId: SALISBURY, name: "Unknown", isClosed: 0, isDonationPoint: null, isMobile: null, placeHasPhoto: null });

    const { locations } = await getLocationsAndDonationPointsByFoodbankId(session, SALISBURY);
    const byName = new Map(locations.map((l) => [l.name, l]));

    // toBe throughout, never toBeTruthy/toBeFalsy: Object.is(1, true) is false
    // and Object.is(0, false) is false, which is precisely the distinction an
    // uncoerced column loses and a truthiness assertion cannot see.
    expect(byName.get("Set")!.is_closed).toBe(true);
    expect(byName.get("Set")!.is_donation_point).toBe(true);
    expect(byName.get("Set")!.is_mobile).toBe(true);
    expect(byName.get("Set")!.place_has_photo).toBe(true);

    expect(byName.get("Cleared")!.is_closed).toBe(false);
    expect(byName.get("Cleared")!.is_donation_point).toBe(false);
    expect(byName.get("Cleared")!.is_mobile).toBe(false);
    expect(byName.get("Cleared")!.place_has_photo).toBe(false);

    expect(byName.get("Unknown")!.is_donation_point).toBeNull();
    expect(byName.get("Unknown")!.is_mobile).toBeNull();
    expect(byName.get("Unknown")!.place_has_photo).toBeNull();
  });

  // The donation-point half, and `wheelchair_accessible` is the one that
  // matters most: 0001_core.sql marks it "TRI-STATE: NULL/0/1, do not coalesce"
  // and gfapi2 emits it verbatim (views.py:202). Coalescing NULL to false would
  // tell a wheelchair user a store is inaccessible when the truth is that
  // nobody has checked.
  //
  // `place_has_photo` is asserted here for the same reason as its location
  // twin above and not because this endpoint reads it: THE MUTANT THAT DELETED
  // IT FROM THE DONATION POINT BOOLEAN_COLUMNS LIST SURVIVED the version of
  // this test that left the column NULL on all three rows. It is the fourth
  // name in that list and nothing else in the file pinned it.
  it("coerces every donation point boolean column and keeps wheelchair_accessible tri-state", async () => {
    seedDonationPoint({ id: 30, foodbankId: SALISBURY, name: "Unchecked", isClosed: 0, inStoreOnly: 1, wheelchairAccessible: null, placeHasPhoto: null });
    seedDonationPoint({ id: 31, foodbankId: SALISBURY, name: "Step-free", isClosed: 1, inStoreOnly: 0, wheelchairAccessible: 1, placeHasPhoto: 1 });
    seedDonationPoint({ id: 32, foodbankId: SALISBURY, name: "Stairs only", isClosed: 0, inStoreOnly: 0, wheelchairAccessible: 0, placeHasPhoto: 0 });

    const { donationPoints } = await getLocationsAndDonationPointsByFoodbankId(session, SALISBURY);
    const byName = new Map(donationPoints.map((d) => [d.name, d]));

    expect(byName.get("Unchecked")!.wheelchair_accessible).toBeNull();
    expect(byName.get("Step-free")!.wheelchair_accessible).toBe(true);
    expect(byName.get("Stairs only")!.wheelchair_accessible).toBe(false);
    expect(byName.get("Unchecked")!.in_store_only).toBe(true);
    expect(byName.get("Step-free")!.in_store_only).toBe(false);
    expect(byName.get("Unchecked")!.is_closed).toBe(false);
    expect(byName.get("Step-free")!.is_closed).toBe(true);
    expect(byName.get("Unchecked")!.place_has_photo).toBeNull();
    expect(byName.get("Step-free")!.place_has_photo).toBe(true);
    expect(byName.get("Stairs only")!.place_has_photo).toBe(false);
  });

  // `country` is declared NOT NULL on the model and is NULLABLE in the database
  // (0001_core.sql:88 -- 1 of 5,744 production rows is NULL), which is why
  // DonationPointRow types it `string | null`. The single real NULL is
  // reachable through this exact endpoint, so it is seeded rather than assumed
  // away.
  it("hands back a donation point with a NULL country rather than dropping it", async () => {
    seedDonationPoint({ id: 30, foodbankId: SALISBURY, name: "Tesco Extra Salisbury", country: null });

    const { donationPoints } = await getLocationsAndDonationPointsByFoodbankId(session, SALISBURY);

    expect(donationPoints).toHaveLength(1);
    expect(donationPoints[0]!.country).toBeNull();
  });

  // Timestamps are TEXT and stay TEXT, in Django's exact format. Ticket #9 /
  // 0022 is the scar: these columns are compared lexicographically, so anything
  // that re-rendered them through a Date on the way out -- 'T' for the space,
  // three fractional digits instead of six -- would sort wrongly against every
  // row the ETL writes. Nothing here should be doing that; this is the test
  // that says so if someone starts.
  it("passes Django-format timestamps through unaltered", async () => {
    seedLocation({ id: 20, foodbankId: SALISBURY, name: "Bemerton Heath Centre", edited: MODIFIED });
    seedDonationPoint({ id: 30, foodbankId: SALISBURY, name: "Tesco Extra Salisbury", edited: null });

    const { locations, donationPoints } = await getLocationsAndDonationPointsByFoodbankId(session, SALISBURY);

    expect(locations[0]!.modified).toBe("2026-09-05 19:28:08.853000");
    expect(locations[0]!.edited).toBe("2026-09-05 19:28:08.853000");
    expect(donationPoints[0]!.modified).toBe("2026-09-05 19:28:08.853000");
    // Nullable, and null must not become "" or the epoch.
    expect(donationPoints[0]!.edited).toBeNull();
  });
});

// ===========================================================================
// EQUIVALENCE WITH THE PAIR IT REPLACED
// ===========================================================================

describe("against the two single-statement functions it batches", () => {
  // THE CLAIM THE WHOLE MODULE RESTS ON: same rows, one round trip instead of
  // two. getLocationsByFoodbankId and getDonationPointsByFoodbankId are the
  // functions Django's `locations()` / `donation_points()` were ported into and
  // are still used elsewhere (foodbank(slug), the geojson branches), so if this
  // batched pair ever drifts from them the API and the public page start
  // disagreeing about the same food bank. Nothing else in this file would
  // notice: both would still return plausible, well-shaped rows.
  //
  // Seeded with the divergent names, a closed row on each side and an
  // untouched-NULL boolean so the comparison covers ordering, filtering and
  // mapping at once rather than only row count.
  it("returns exactly what the unbatched pair returns", async () => {
    seedFoodbank(SALISBURY, "Salisbury Foodbank", "salisbury");
    seedFoodbank(TROWBRIDGE, "Trowbridge Foodbank", "trowbridge");
    LOCATION_SEEDS.forEach((seed, i) =>
      seedLocation({ id: 20 + i, foodbankId: SALISBURY, ...seed, isClosed: i === 0 ? 1 : 0, isMobile: i === 1 ? 1 : null }),
    );
    DONATION_POINT_SEEDS.forEach((seed, i) =>
      seedDonationPoint({ id: 40 + i, foodbankId: SALISBURY, ...seed, isClosed: i === 0 ? 1 : 0, wheelchairAccessible: i === 1 ? null : 1 }),
    );
    // The neighbour's rows, so the comparison also covers the WHERE clause and
    // not just the sort and the mapping.
    seedLocation({ id: 60, foodbankId: TROWBRIDGE, name: "Melksham Centre" });
    seedDonationPoint({ id: 61, foodbankId: TROWBRIDGE, name: "Tesco Extra Trowbridge" });

    const batched = await getLocationsAndDonationPointsByFoodbankId(session, SALISBURY);

    expect(batched.locations).toEqual(await getLocationsByFoodbankId(session, SALISBURY));
    expect(batched.donationPoints).toEqual(await getDonationPointsByFoodbankId(session, SALISBURY));
    // Belt and braces on the comparison itself: toEqual on two empty arrays
    // would pass while proving nothing, so both lists must be non-empty.
    expect(batched.locations).toHaveLength(LOCATION_NAMES.length);
    expect(batched.donationPoints).toHaveLength(DONATION_POINT_NAMES.length);
  });
});
