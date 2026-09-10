// @ts-ignore -- node:sqlite has no types under this package's tsconfig, whose
// `"types": ["@cloudflare/workers-types"]` deliberately excludes @types/node
// (foodbankAdmin.test.ts's header explains the same constraint). The import
// works at runtime -- vitest runs this file in a node environment -- and the
// casts below are the whole cost of getting a real SQL engine in here.
// `@ts-ignore` rather than `@ts-expect-error`: if someone later adds
// @types/node to this package, an expect-error directive would itself become
// the error and break `pnpm typecheck` for everyone.
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { getDuplicatePostcodes } from "./dupePostcodes";
import type { Session } from "./types";

// dupePostcodes.ts is one statement and eleven lines of grouping. Everything
// interesting about it -- which rows count, which are excluded, what order
// they come back in, where the ceiling bites -- lives inside SQL text that
// cannot throw when it is wrong. It renders a plausible page either way. This
// repo's own scar is migration 0019: it dropped the cached `foodbank_name`
// columns, four queries kept naming them, and nothing went red until
// /dashboard/beautybanks/ was measured and found to be a silent 500.
//
// So this file runs the REAL statement against a REAL SQLite database built
// from packages/db/migrations, and asserts ROWS: which postcodes, which
// places under each, in which order. "Returns an array of groups" would pass
// against a query that had lost its HAVING clause, its is_closed rows, its
// donation-point exclusion or its ORDER BY.
//
// THE VIEW IS THE REAL VIEW. The `places` CTE reads `foodbanklocation_full`,
// so that view is created below verbatim from 0019_drop_foodbank_cache.sql
// :68-76. A hand-built table with `foodbank_name`/`foodbank_slug` already
// flattened into it would make the test circular -- the LEFT JOIN, and the
// fact that it is a LEFT and not an INNER, is one of the things under test
// (see "counts an orphaned location" below).
//
// THE DJANGO ORIGINAL is gfadmin/views.py:340-358, read while writing this.
// It builds a Python list of every `Foodbank.objects.all()` postcode followed
// by every `FoodbankLocation.objects.all()` postcode -- the UNFILTERED
// managers, via get_all_foodbanks()/get_all_locations() (givefood/utils/
// cache.py:37,:59), confirmed by reading them -- then keeps
// `set([x for x in postcodes if postcodes.count(x) > 1])`. Three consequences
// are asserted here as parity: closed rows count, donation points do not, and
// the comparison is a raw `==` on the stored string.
//
// D1's 100-BOUND-PARAMETER CEILING does not apply to this module and the test
// at the bottom of this file proves why rather than asserting it in prose:
// there is exactly one statement and it binds exactly one value, whatever the
// data looks like. Nothing here builds an IN list or chunks. If a future
// change adds one, it needs a test at 100 and at 101.
//
// NO TIMESTAMP IS READ OR COMPARED by this module -- no cutoff, no ORDER BY on
// a datetime -- so the "Django writes '2026-09-05 19:28:08.853000' and TEXT
// sorts bytewise" hazard that dogs the rest of this package is genuinely
// absent here. The seeds still use Django-format stamps in the NOT NULL
// columns so that nothing in this fixture teaches the wrong habit.
//
// MUTATION-TESTED, in a scratchpad copy, never in src/ (TESTING.md's rule).
// 42 mutants applied to a pristine copy and re-run; 38 died. Killed:
// HAVING > 1 -> >= 1 and -> > 2 and -> COUNT(DISTINCT kind) > 1;
// probeLimit = limit; truncated > -> >= and -> <; truncated computed after
// the trim instead of before; the truncation trim deleted, and off-by-one to
// `limit - 1`; the outer ORDER BY losing p.postcode or p.kind, and reversing
// any one of its three terms; LIMIT moved off the dupes CTE onto the outer
// SELECT; the dupes CTE's ORDER BY reversed to DESC; JOIN dupes -> LEFT JOIN;
// either UNION branch losing its WHERE clause; AND -> OR between the two
// halves of that WHERE; `postcode IS NOT NULL` -> `postcode != NULL`; TRIM()
// dropped from the emptiness check; WHERE is_closed = 0 added; is_closed
// replaced by a literal 0; GROUP BY UPPER(postcode); UNION ALL -> UNION;
// foodbankdonationpoint_full added to the UNION; foodbanklocation_full
// swapped for the bare table (the 0019 shape); the location branch's
// foodbank_name/foodbank_slug transposed; the food bank branch's
// NULL AS loc_slug and name AS foodbank_name rewired; 'foodbank' AS kind
// recased; the outer SELECT's p.name sourced from p.foodbank_name; the
// default limit changed from 500; iterating only the first result row;
// the grouping loop reading groups[0] instead of the last group; a second,
// unparameterised `SELECT COUNT(*)` round trip added to the module; and, in
// the fixture, the view's LEFT JOIN narrowed to an INNER JOIN.
//
// FOUR SURVIVORS, all four EQUIVALENT ON THIS ENGINE rather than untested,
// recorded because "the tests catch everything" would be a lie and because
// the reason is the same each time -- SQLite reaches the right answer by a
// route that makes the code's explicit guarantee redundant:
//
//  1. Deleting `ORDER BY postcode` from inside the dupes CTE. There is no
//     index on either postcode column (refused on purpose, dupePostcodes.ts
//     :24-27), so SQLite answers that GROUP BY through a temp b-tree and
//     hands back key order regardless. Reversing it to DESC *is* caught --
//     see "selects which postcodes to keep by postcode order" below, which
//     is the test that makes the CTE's LIMIT a documented selection rule
//     rather than an accident.
//  2. and 3. Deleting `p.name` from the outer ORDER BY, or deleting the
//     entire outer ORDER BY. `EXPLAIN QUERY PLAN` on the real statement ends
//     `SEARCH p USING AUTOMATIC COVERING INDEX (postcode=?)`: SQLite builds
//     a transient index over the materialised `places` whose columns are in
//     projection order -- postcode, kind, name, ... -- which is byte-for-byte
//     the ORDER BY. So the rows arrive sorted whether or not the clause is
//     there. Dropping p.postcode or p.kind, or reversing any term, forces a
//     real sorter and dies. The clause is a guarantee against a future plan
//     change, not decoration; the tests below still assert the order against
//     a deliberately disagreeing insertion order so that a plan change shows
//     up as a failure rather than as a quietly reordered page.
//  4. `d.postcode = p.postcode` -> `IS`. Equivalent only because the WHERE
//     clause has already excluded every NULL postcode from `places`; see the
//     ceiling test in "the NULL and empty-postcode exclusions", which spells
//     out what that join is guarding and why the two mutations together are
//     what the NULL test finally fails on.

// ---------------------------------------------------------------------------
// The schema, as it stands after every migration in packages/db/migrations.
// Column definitions are copied from the migrations, NOT inferred from the
// TypeScript interfaces -- catching a disagreement between the two is half the
// point of running real SQL. `foodbank` is untouched since 0001_core.sql:10-55;
// `foodbanklocation` and `foodbankdonationpoint` are 0001_core.sql:57-105 less
// the columns 0019_drop_foodbank_cache.sql:46-54 dropped. A query that still
// named `foodbanklocation.foodbank_name` would die here with "no such column",
// which is precisely the 0019 regression.
//
// NOT NULL is reproduced faithfully rather than relaxed for convenience,
// because it is load-bearing twice over: `foodbank.postcode` being NOT NULL is
// why the module's "NULL postcodes" divergence can only ever be reached
// through a location (asserted below), and `foodbanklocation.postcode` being
// nullable is why that divergence exists at all.
// ---------------------------------------------------------------------------
const SCHEMA = `
-- 0001_core.sql:10-55
CREATE TABLE foodbank (
  id INTEGER PRIMARY KEY,
  uuid TEXT NOT NULL,
  name TEXT NOT NULL, alt_name TEXT, slug TEXT NOT NULL,
  address TEXT NOT NULL,
  postcode TEXT NOT NULL, country TEXT NOT NULL,
  lat_lng TEXT NOT NULL,
  latitude REAL, longitude REAL,
  delivery_address TEXT, delivery_lat_lng TEXT,
  network TEXT, network_id TEXT, notes TEXT,
  charity_number TEXT, charity_just_foodbank INTEGER NOT NULL,
  charity_id TEXT, charity_name TEXT, charity_type TEXT,
  charity_reg_date TEXT, charity_postcode TEXT, charity_website TEXT,
  charity_objectives TEXT, charity_purpose TEXT,
  facebook_page TEXT, bankuet_slug TEXT, fsa_id TEXT,
  contact_email TEXT NOT NULL, notification_email TEXT,
  phone_number TEXT, secondary_phone_number TEXT, delivery_phone_number TEXT,
  url TEXT NOT NULL, shopping_list_url TEXT NOT NULL,
  rss_url TEXT, news_url TEXT, donation_points_url TEXT,
  locations_url TEXT, contacts_url TEXT,
  place_id TEXT, plus_code_compound TEXT, plus_code_global TEXT,
  place_has_photo INTEGER,
  county TEXT, district TEXT, ward TEXT, lsoa TEXT, msoa TEXT,
  parliamentary_constituency_id INTEGER,
  parliamentary_constituency_name TEXT, parliamentary_constituency_slug TEXT,
  mp TEXT, mp_party TEXT, mp_parl_id INTEGER,
  address_is_administrative INTEGER NOT NULL,
  is_closed INTEGER NOT NULL, is_school INTEGER,
  no_locations INTEGER NOT NULL, no_donation_points INTEGER,
  days_between_needs INTEGER NOT NULL, footprint INTEGER,
  bounds_north REAL, bounds_south REAL, bounds_east REAL, bounds_west REAL,
  latest_need_id INTEGER,
  last_order TEXT, last_need TEXT, last_rfi TEXT, last_crawl TEXT,
  last_social_media_check TEXT, last_discrepancy_check TEXT,
  last_need_check TEXT, last_charity_check TEXT,
  created TEXT NOT NULL, modified TEXT NOT NULL, edited TEXT
);
CREATE UNIQUE INDEX foodbank_name_uniq ON foodbank(name);
CREATE UNIQUE INDEX foodbank_slug_uniq ON foodbank(slug);

-- 0001_core.sql:57-75, less the five cache columns 0019 dropped
CREATE TABLE foodbanklocation (
  id INTEGER PRIMARY KEY, uuid TEXT NOT NULL,
  foodbank_id INTEGER NOT NULL,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  address TEXT, postcode TEXT,
  country TEXT NOT NULL, lat_lng TEXT NOT NULL, latitude REAL, longitude REAL,
  place_id TEXT, plus_code_compound TEXT, plus_code_global TEXT, place_has_photo INTEGER,
  county TEXT, district TEXT, ward TEXT, lsoa TEXT, msoa TEXT,
  parliamentary_constituency_id INTEGER,
  parliamentary_constituency_name TEXT, parliamentary_constituency_slug TEXT,
  mp TEXT, mp_party TEXT, mp_parl_id INTEGER,
  is_closed INTEGER NOT NULL,
  is_donation_point INTEGER, is_mobile INTEGER,
  boundary_geojson TEXT,
  phone_number TEXT, email TEXT,
  modified TEXT NOT NULL, edited TEXT
);
CREATE UNIQUE INDEX loc_fb_name_uniq ON foodbanklocation(foodbank_id, name);

-- 0001_core.sql:84-105, less the three cache columns 0019 dropped. Present
-- ONLY so that "donation points are not consulted" is a real negative: with
-- the table absent, a mutant that added foodbankdonationpoint_full to the
-- UNION would fail with "no such table", which proves nothing about rows.
CREATE TABLE foodbankdonationpoint (
  id INTEGER PRIMARY KEY, uuid TEXT NOT NULL,
  foodbank_id INTEGER NOT NULL,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  address TEXT NOT NULL, postcode TEXT NOT NULL, country TEXT,
  lat_lng TEXT NOT NULL, latitude REAL, longitude REAL,
  place_id TEXT, plus_code_compound TEXT, plus_code_global TEXT, place_has_photo INTEGER,
  county TEXT, district TEXT, ward TEXT, lsoa TEXT, msoa TEXT,
  parliamentary_constituency_id INTEGER,
  parliamentary_constituency_name TEXT, parliamentary_constituency_slug TEXT,
  mp TEXT, mp_party TEXT, mp_parl_id INTEGER,
  is_closed INTEGER NOT NULL, in_store_only INTEGER NOT NULL,
  phone_number TEXT, url TEXT, opening_hours TEXT,
  wheelchair_accessible INTEGER,
  company TEXT, company_slug TEXT, store_id TEXT, notes TEXT,
  modified TEXT NOT NULL, edited TEXT
);
CREATE UNIQUE INDEX dp_fb_name_uniq ON foodbankdonationpoint(foodbank_id, name);

-- 0019_drop_foodbank_cache.sql:68-84, verbatim. The LEFT JOIN is the reason
-- an orphaned child row survives into the places CTE; see the orphan test.
CREATE VIEW foodbanklocation_full AS
  SELECT l.*,
         f.name          AS foodbank_name,
         f.slug          AS foodbank_slug,
         f.network       AS foodbank_network,
         f.phone_number  AS foodbank_phone_number,
         f.contact_email AS foodbank_email
    FROM foodbanklocation l
    LEFT JOIN foodbank f ON f.id = l.foodbank_id;
CREATE VIEW foodbankdonationpoint_full AS
  SELECT d.*,
         f.name    AS foodbank_name,
         f.slug    AS foodbank_slug,
         f.network AS foodbank_network
    FROM foodbankdonationpoint d
    LEFT JOIN foodbank f ON f.id = d.foodbank_id;
`;

// ---------------------------------------------------------------------------
// The slice of the D1 Sessions API this module touches, over node:sqlite.
// Copied from adminLists.test.ts's d1Session, minus the `first`/`run` arms
// this module never calls. getDuplicatePostcodes issues one prepare().bind()
// .all(), and nothing else.
// ---------------------------------------------------------------------------
type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number | bigint };
  };
};

function d1Session(db: SqliteDb): Session {
  const statement = (sql: string, params: unknown[]) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
  });
  return { prepare: (sql: string) => statement(sql, []), getBookmark: () => null } as unknown as Session;
}

// A pass-through that records every statement and its bindings while still
// running it for real. Used once, at the bottom, for the two claims that are
// about the SHAPE of the database traffic rather than the rows -- one round
// trip, one bound parameter -- which no row assertion can make.
interface Recorded {
  sql: string;
  params: unknown[];
}

// Recording happens at PREPARE, not at bind, and the record is then mutated
// in place by bind. Recording at bind would count only the statements that
// happen to take a parameter, so the "exactly one statement" assertion below
// would sail straight past the refactor it exists to catch -- a second
// `SELECT COUNT(*) ...` round trip added to compute `truncated` takes no
// bindings at all and would have been invisible.
function watchedSession(db: SqliteDb, sink: Recorded[]): Session {
  const prepare = (sql: string) => {
    const record: Recorded = { sql, params: [] };
    sink.push(record);
    const statement = (params: unknown[]) => ({
      bind: (...next: unknown[]) => {
        record.params = next;
        return statement(next);
      },
      all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    });
    return statement([]);
  };
  return { prepare, getBookmark: () => null } as unknown as Session;
}

let db: SqliteDb;
let session: Session;
let nextId: number;

beforeEach(() => {
  // @ts-ignore -- see the import comment
  db = new DatabaseSync(":memory:") as SqliteDb;
  db.exec(SCHEMA);
  session = d1Session(db);
  nextId = 1;
});

// A generic INSERT built from the object's own keys, so a seed helper names
// only the columns a test cares about and the NOT NULL filler lives in one
// place per table. Values are inlined as SQL literals rather than bound
// because every seed here is a test-authored constant.
function insert(table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  const values = columns.map((c) => {
    const v = row[c];
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number") return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  });
  db.exec(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${values.join(", ")})`);
}

// Django-format timestamps -- "YYYY-MM-DD HH:MM:SS.ffffff", the form
// 0022_normalise_timestamps.sql settled on. Nothing in this module reads a
// timestamp, but the fixture should not model a shape the rest of the
// database does not use.
const STAMP = "2026-09-05 19:28:08.853000";

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

interface FoodbankSeed {
  name: string;
  postcode: string;
  isClosed?: number;
}

function seedFoodbank({ name, postcode, isClosed = 0 }: FoodbankSeed): number {
  const id = nextId++;
  insert("foodbank", {
    id,
    uuid: `fb${String(id).padStart(30, "0")}`,
    name,
    slug: slugify(name),
    address: "1 Test Street\r\nTestville",
    postcode,
    country: "England",
    lat_lng: "51.5,-0.1",
    charity_just_foodbank: 0,
    contact_email: "test@example.org",
    url: "https://example.org/",
    shopping_list_url: "https://example.org/list/",
    address_is_administrative: 0,
    is_closed: isClosed,
    no_locations: 0,
    days_between_needs: 7,
    created: STAMP,
    modified: STAMP,
  });
  return id;
}

interface LocationSeed {
  foodbankId: number;
  name: string;
  // null is a real production state: foodbanklocation.postcode is nullable
  // (0001_core.sql:63) and mobile locations have none.
  postcode: string | null;
  isClosed?: number;
}

function seedLocation({ foodbankId, name, postcode, isClosed = 0 }: LocationSeed): number {
  const id = nextId++;
  insert("foodbanklocation", {
    id,
    uuid: `lo${String(id).padStart(30, "0")}`,
    foodbank_id: foodbankId,
    name,
    slug: slugify(name),
    address: "2 Test Street",
    postcode,
    country: "England",
    lat_lng: "51.5,-0.1",
    is_closed: isClosed,
    modified: STAMP,
  });
  return id;
}

function seedDonationPoint({ foodbankId, name, postcode }: { foodbankId: number; name: string; postcode: string }): void {
  const id = nextId++;
  insert("foodbankdonationpoint", {
    id,
    uuid: `dp${String(id).padStart(30, "0")}`,
    foodbank_id: foodbankId,
    name,
    slug: slugify(name),
    address: "3 Test Street",
    postcode,
    country: "England",
    lat_lng: "51.5,-0.1",
    is_closed: 0,
    in_store_only: 0,
    modified: STAMP,
  });
}

// Reading helpers. Every assertion below is on values, never on lengths
// alone: `toEqual` on an exact list catches a row that should not be there,
// which `toHaveLength` on a subset does not.
const postcodesOf = (result: { groups: { postcode: string }[] }): string[] => result.groups.map((g) => g.postcode);

const placeKeysOf = (group: { places: { kind: string; name: string }[] }): string[] => group.places.map((p) => `${p.kind}:${p.name}`);

// ---------------------------------------------------------------------------

describe("which postcodes come back as duplicated", () => {
  // The HAVING clause, in one assertion. A postcode held by exactly one row
  // must not appear; the page's entire purpose is that the ones listed are
  // genuinely shared, and an operator who is sent to fix a non-duplicate
  // stops trusting the page.
  it("returns the shared postcodes and not the unshared ones", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", postcode: "SP2 9DY" });
    seedLocation({ foodbankId: salisbury, name: "Bemerton Heath Centre", postcode: "SP2 9DY" });
    seedFoodbank({ name: "Exeter", postcode: "EX10 8LZ" });

    const result = await getDuplicatePostcodes(session);

    expect(postcodesOf(result)).toEqual(["SP2 9DY"]);
  });

  // The commonest real shape on this site: a food bank whose main site is
  // also entered as one of its own locations. Both rows are in `places`, so
  // the pair is a duplicate -- which is exactly what the page is for.
  it("counts a food bank and one of its own locations as a pair", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", postcode: "SP2 9DY" });
    seedLocation({ foodbankId: salisbury, name: "Salisbury Central", postcode: "SP2 9DY" });

    const result = await getDuplicatePostcodes(session);

    expect(postcodesOf(result)).toEqual(["SP2 9DY"]);
    expect(placeKeysOf(result.groups[0]!)).toEqual(["foodbank:Salisbury", "location:Salisbury Central"]);
  });

  // Two children of ONE parent. The UNION ALL branch that reads locations has
  // to count rows, not distinct food banks -- a mutant that grouped by
  // (postcode, foodbank_id) or de-duplicated by parent would miss the single
  // commonest data-entry mistake this page exists to catch.
  it("counts two locations of the same food bank", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", postcode: "SP1 1AA" });
    seedLocation({ foodbankId: salisbury, name: "Amesbury", postcode: "SP4 7HH" });
    seedLocation({ foodbankId: salisbury, name: "Durrington", postcode: "SP4 7HH" });

    const result = await getDuplicatePostcodes(session);

    expect(postcodesOf(result)).toEqual(["SP4 7HH"]);
    expect(placeKeysOf(result.groups[0]!)).toEqual(["location:Amesbury", "location:Durrington"]);
  });

  it("puts three rows sharing one postcode in a single group", async () => {
    const a = seedFoodbank({ name: "Alpha", postcode: "SW1A 1AA" });
    const b = seedFoodbank({ name: "Bravo", postcode: "SW1A 1AA" });
    seedLocation({ foodbankId: a, name: "Alpha Annexe", postcode: "SW1A 1AA" });
    seedLocation({ foodbankId: b, name: "Bravo Annexe", postcode: "EX10 8LZ" });

    const result = await getDuplicatePostcodes(session);

    expect(result.groups).toHaveLength(1);
    expect(placeKeysOf(result.groups[0]!)).toEqual(["foodbank:Alpha", "foodbank:Bravo", "location:Alpha Annexe"]);
  });

  // PARITY, and the module's own header says so: Django's view walks
  // get_all_foodbanks() + get_all_locations() and never touches
  // FoodbankDonationPoint. There are ~5,700 donation points against ~3,000
  // food banks and locations, so folding them in would roughly triple the
  // page and fill it with supermarket collection bins that legitimately share
  // a postcode with the store next door. Both halves are seeded: a pair of
  // donation points sharing a postcode with each other, and one sharing a
  // food bank's postcode. Neither may produce a group.
  it("ignores donation points, exactly as the Django view does", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", postcode: "SP2 9DY" });
    seedDonationPoint({ foodbankId: salisbury, name: "Tesco Southampton Road", postcode: "SP2 9DY" });
    seedDonationPoint({ foodbankId: salisbury, name: "Co-op Fisherton Street", postcode: "SP2 7SU" });
    seedDonationPoint({ foodbankId: salisbury, name: "Waitrose Churchill Way", postcode: "SP2 7SU" });

    const result = await getDuplicatePostcodes(session);

    expect(result.groups).toEqual([]);
  });

  // PARITY, the other one Django gets by accident: `Foodbank.objects.all()`
  // and `FoodbankLocation.objects.all()` are the unfiltered managers, not
  // their get_all_open_* siblings. A closed food bank still occupies its
  // postcode in the data, and this is a data-quality screen, so it belongs on
  // the list. This is the test that kills a copy-pasted `WHERE is_closed = 0`
  // -- the predicate that is on almost every other query in this package, and
  // therefore the single likeliest thing to be added here "for consistency".
  it("includes closed food banks and closed locations", async () => {
    const shut = seedFoodbank({ name: "Shuttered", postcode: "SP2 9DY", isClosed: 1 });
    seedLocation({ foodbankId: shut, name: "Shuttered Annexe", postcode: "SP2 9DY", isClosed: 1 });

    const result = await getDuplicatePostcodes(session);

    expect(postcodesOf(result)).toEqual(["SP2 9DY"]);
    // Carried through to the caller, because foodbanks_dupe_postcodes.njk:84
    // renders a "Closed" tag from it -- an operator has to be able to tell a
    // live clash from a historical one before deciding which row to edit.
    expect(result.groups[0]!.places.map((p) => p.is_closed)).toEqual([1, 1]);
  });

  it("returns an empty list, not a null group, when nothing is duplicated", async () => {
    seedFoodbank({ name: "Salisbury", postcode: "SP2 9DY" });
    seedFoodbank({ name: "Exeter", postcode: "EX10 8LZ" });

    const result = await getDuplicatePostcodes(session);

    expect(result).toEqual({ groups: [], truncated: false, limit: 500 });
  });
});

describe("the NULL and empty-postcode exclusions", () => {
  // DIVERGENCE FROM DJANGO, deliberate, stated in dupePostcodes.ts:66-72. In
  // Python `None` satisfies `postcodes.count(None) > 1`, so two locations with
  // no postcode put a literal "None" entry in Django's set, rendered as a row
  // linking to /admin/search/?q=None.
  it("excludes locations with a NULL postcode", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", postcode: "SP2 9DY" });
    seedLocation({ foodbankId: salisbury, name: "Mobile Tuesday", postcode: null });
    seedLocation({ foodbankId: salisbury, name: "Mobile Thursday", postcode: null });

    const result = await getDuplicatePostcodes(session);

    expect(result.groups).toEqual([]);
  });

  // WHERE THE NULL EXCLUSION ACTUALLY LIVES, established by deleting each
  // half of the predicate and re-running this file rather than by reading it:
  //
  //  - Delete `postcode IS NOT NULL` alone and NOTHING changes -- 31 passed.
  //    `TRIM(NULL) <> ''` is UNKNOWN, so the TRIM half already drops the row.
  //    The predicate is belt-and-braces, and dupePostcodes.ts's first listed
  //    fix over Django is in practice carried by the TRIM.
  //  - Delete BOTH and the test above STILL passes, which is why this second
  //    one exists. Two later steps swallow a NULL group on their own: SQLite
  //    collects NULLs under one GROUP BY key, and then the outer join is
  //    `d.postcode = p.postcode`, where NULL = NULL is UNKNOWN, so the group
  //    joins to nothing and no row is emitted.
  //
  // What a NULL group still costs, and what this test measures, is a SLOT IN
  // THE CEILING: it is a row in the `dupes` CTE and consumes one of its
  // `limit + 1` slots before being silently discarded. A page whose last real
  // group sat just past the cut would then report `truncated: false` -- the
  // one state this page must never be in, because the operator is told there
  // is nothing more to fix. Seeded at limit 1 so the phantom slot is the
  // difference between "one of two" and "one of one".
  //
  // (And the reason to leave the outer join spelled `=` rather than the
  // NULL-safe `IS` used elsewhere in this package: on its own that swap
  // changes nothing here -- run, 31 passed -- but it removes the second of
  // the two accidental guards, so a later relaxation of the WHERE clause
  // would put Django's "None" row straight back on the page instead of being
  // caught here. Both mutations together are what the "excludes locations
  // with a NULL postcode" test above finally fails on.)
  it("does not let a NULL postcode consume a slot in the ceiling", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", postcode: "SP2 9DY" });
    seedLocation({ foodbankId: salisbury, name: "Mobile Tuesday", postcode: null });
    seedLocation({ foodbankId: salisbury, name: "Mobile Thursday", postcode: null });
    seedFoodbank({ name: "A One", postcode: "B1 1AA" });
    seedFoodbank({ name: "A Two", postcode: "B1 1AA" });
    seedFoodbank({ name: "B One", postcode: "M1 1AE" });
    seedFoodbank({ name: "B Two", postcode: "M1 1AE" });

    const result = await getDuplicatePostcodes(session, 1);

    expect(postcodesOf(result)).toEqual(["B1 1AA"]);
    expect(result.truncated).toBe(true);
  });

  // The other half of the same divergence, and the reason it is expressed as
  // TRIM rather than as `<> ''`: an admin who clears the box leaves "", an
  // admin who types a space leaves " ", and neither is a postcode two records
  // meaningfully share.
  //
  // BOTH BRANCHES of the UNION ALL carry this predicate and both are seeded
  // here, because they are two separate copies of the same clause and a
  // deletion only ever happens to one of them. Dropping it from the location
  // branch alone leaves every foodbank-only assertion in this file green.
  it("excludes empty and space-only postcodes, on food banks and on locations alike", async () => {
    const parent = seedFoodbank({ name: "Parent", postcode: "SP1 1AA" });
    seedFoodbank({ name: "Blank One", postcode: "" });
    seedFoodbank({ name: "Blank Two", postcode: "" });
    seedFoodbank({ name: "Spacey One", postcode: "   " });
    seedFoodbank({ name: "Spacey Two", postcode: "  " });
    seedLocation({ foodbankId: parent, name: "Blank Hall", postcode: "" });
    seedLocation({ foodbankId: parent, name: "Blanker Hall", postcode: "" });
    seedLocation({ foodbankId: parent, name: "Spacey Hall", postcode: " " });
    seedLocation({ foodbankId: parent, name: "Spacier Hall", postcode: " " });

    const result = await getDuplicatePostcodes(session);

    expect(result.groups).toEqual([]);
  });

  // Why the NULL half of that divergence can only ever arrive through a
  // location: `foodbank.postcode` is NOT NULL (0001_core.sql:15) while
  // `foodbanklocation.postcode` is not (0001_core.sql:63). Asserted rather
  // than trusted, because dupePostcodes.ts's comment cites that exact line
  // and a schema change that relaxed it would quietly widen the divergence
  // the module claims to have bounded.
  it("cannot get a NULL postcode from the foodbank table at all", () => {
    expect(() => insert("foodbank", { id: 99, uuid: "x", name: "No Postcode", slug: "no-postcode", postcode: null })).toThrow(/NOT NULL/i);
  });

  // SUSPECT, pinned as-is. SQLite's one-argument TRIM strips SPACES ONLY --
  // verified by running it: `TRIM(char(9)) <> ''` is 1, and so is char(10)
  // and char(160). So a postcode of a single tab, or a non-breaking space
  // pasted out of a spreadsheet, survives the filter and is reported as a
  // duplicated "postcode" with an invisible value, linking to
  // /admin/search/?q=%09. The exclusion is narrower than the comment above it
  // ("NULL and empty postcodes are excluded") reads.
  //
  // Not a fix, and arguably not worth one: parseAdminFields trims every text
  // field before it is stored, so today this can only arrive from the ETL.
  // Recorded so the next person to widen the filter to `TRIM(postcode, ' ' ||
  // char(9) || char(10) || char(13))` knows they are changing behaviour, not
  // correcting an oversight.
  it("does NOT exclude a tab-only postcode -- SQLite's TRIM strips spaces only", async () => {
    seedFoodbank({ name: "Tabbed One", postcode: "\t" });
    seedFoodbank({ name: "Tabbed Two", postcode: "\t" });

    const result = await getDuplicatePostcodes(session);

    expect(postcodesOf(result)).toEqual(["\t"]);
  });
});

describe("the comparison is an exact raw-string match, like Django's", () => {
  // dupePostcodes.ts:74-80 commits to this on purpose: "this page exists
  // precisely to surface data entered inconsistently", so normalising the
  // comparison would delete the finding instead of reporting it. Each of the
  // three tests below would go green if someone added UPPER(), REPLACE(' ')
  // or TRIM() to the GROUP BY -- which is the tempting "improvement" here.
  it("treats a case difference as two different postcodes", async () => {
    // NO LONGER REACHABLE FROM THE ADMIN. It was until github #24:
    // parseAdminFields uppercased only for the format check and stored the
    // value as typed, so "ex10 8lz" could land in D1 lowercase. It now
    // stores upper-cased, and production D1 holds zero non-upper-case
    // postcodes across all 8,779 rows.
    //
    // The test stays, and is seeded directly rather than through the form,
    // because it pins the QUERY's behaviour, not the writer's: the GROUP BY
    // runs under SQLite's BINARY collation on a column declared without
    // COLLATE NOCASE (0001_core.sql:15,63,89), and that is deliberate --
    // adding UPPER() here would delete a finding this page exists to
    // surface. A legacy import or a direct SQL edit can still produce the
    // case variant the admin no longer can.
    seedFoodbank({ name: "Upper", postcode: "EX10 8LZ" });
    seedFoodbank({ name: "Lower", postcode: "ex10 8lz" });

    const result = await getDuplicatePostcodes(session);

    expect(result.groups).toEqual([]);
  });

  it("treats a missing space as a different postcode", async () => {
    seedFoodbank({ name: "Spaced", postcode: "SW1A 1AA" });
    seedFoodbank({ name: "Unspaced", postcode: "SW1A1AA" });

    const result = await getDuplicatePostcodes(session);

    expect(result.groups).toEqual([]);
  });

  // The subtlety the TRIM in the WHERE clause invites: TRIM gates ENTRY to
  // `places`, it does not normalise the value that is then grouped on. So a
  // padded postcode is compared, grouped and RENDERED with its padding --
  // " SW1A 1AA " is not the same postcode as "SW1A 1AA", and two padded rows
  // form a group whose heading and /admin/search/?q= link both carry the
  // spaces. Consistent with the no-normalising rule above, and pinned because
  // it is the one place where the module does touch whitespace and could
  // plausibly be assumed to have normalised it.
  it("does not normalise padding: a padded postcode groups separately, and keeps its padding", async () => {
    seedFoodbank({ name: "Padded One", postcode: " SW1A 1AA " });
    seedFoodbank({ name: "Padded Two", postcode: " SW1A 1AA " });
    seedFoodbank({ name: "Clean", postcode: "SW1A 1AA" });

    const result = await getDuplicatePostcodes(session);

    expect(postcodesOf(result)).toEqual([" SW1A 1AA "]);
    expect(placeKeysOf(result.groups[0]!)).toEqual(["foodbank:Padded One", "foodbank:Padded Two"]);
  });
});

describe("ordering", () => {
  // Django renders a `set()` (views.py:353), so the same data comes out in a
  // different order between requests -- one of the two deliberate fixes this
  // module lists. Ordering is also the thing a test can most easily fail to
  // notice: seed two groups and almost any ORDER BY looks right, so this
  // seeds five whose insertion order, id order and alphabetical order all
  // differ.
  it("orders groups by postcode, not by insertion or by id", async () => {
    for (const postcode of ["SP2 9DY", "EX10 8LZ", "M1 1AE", "B1 1AA", "SW1A 1AA"]) {
      seedFoodbank({ name: `First ${postcode}`, postcode });
      seedFoodbank({ name: `Second ${postcode}`, postcode });
    }

    const result = await getDuplicatePostcodes(session);

    expect(postcodesOf(result)).toEqual(["B1 1AA", "EX10 8LZ", "M1 1AE", "SP2 9DY", "SW1A 1AA"]);
  });

  // `ORDER BY p.postcode, p.kind, p.name` -- and 'foodbank' < 'location'
  // bytewise, verified by running `SELECT 'foodbank' < 'location'`. So the
  // food bank always heads its group. That matters to the reader: the food
  // bank is the parent record, and the template gives it a different edit
  // link (/edit/address/ versus /location/<slug>/edit/), so a group that led
  // with a location would read as though the location were the primary row.
  // Seeded with a food bank whose name sorts LAST, so a query that had lost
  // the `p.kind` term and ordered by name alone would fail here -- and with
  // the two locations inserted in DESCENDING name order, so that the expected
  // answer disagrees with insertion order, id order and the order the rows sit
  // in on disk. See the header's survivor note 2: on this engine the outer
  // ORDER BY is currently redundant, because SQLite's automatic covering index
  // over `places` happens to be built in the same column order. That makes it
  // doubly worth seeding against the natural order rather than with it: the
  // day a plan change stops handing back sorted rows, this fails instead of
  // silently reordering the page.
  it("puts the food bank before its locations within a group", async () => {
    const zulu = seedFoodbank({ name: "Zulu Food Bank", postcode: "SP2 9DY" });
    seedLocation({ foodbankId: zulu, name: "Bravo Hall", postcode: "SP2 9DY" });
    seedLocation({ foodbankId: zulu, name: "Alpha Hall", postcode: "SP2 9DY" });

    const result = await getDuplicatePostcodes(session);

    expect(placeKeysOf(result.groups[0]!)).toEqual(["foodbank:Zulu Food Bank", "location:Alpha Hall", "location:Bravo Hall"]);
  });

  // DIVERGENCE FROM THE REST OF THIS PACKAGE, and dupePostcodes.ts:82-86
  // argues for it: the inner sort is raw SQL, so it uses SQLite's BINARY
  // collation (every uppercase letter before every lowercase one), where
  // sortByName() in types.ts uses an Intl.Collator that would put "apple
  // hall" first. Verified by running `SELECT 'Zebra' < 'apple'` -> 1.
  //
  // The module's justification is that this "only ever orders the two or
  // three rows that share one postcode", which is true and makes the
  // divergence harmless. Pinned so that a future change to sortByName-
  // everywhere is a visible decision rather than a silent reordering, and so
  // that anyone reading the comment can see the claim is actually tested.
  //
  // Inserted in the order the locale collator would produce, so that the
  // assertion is satisfied only by the byte-wise answer -- seeding "Zebra
  // Hall" first would have let a query with no ORDER BY at all pass by
  // returning insertion order.
  it("orders names bytewise, not by the locale collator used elsewhere in this package", async () => {
    const parent = seedFoodbank({ name: "Parent", postcode: "SP1 1AA" });
    seedLocation({ foodbankId: parent, name: "apple hall", postcode: "SP2 9DY" });
    seedLocation({ foodbankId: parent, name: "Zebra Hall", postcode: "SP2 9DY" });

    const result = await getDuplicatePostcodes(session);

    expect(placeKeysOf(result.groups[0]!)).toEqual(["location:Zebra Hall", "location:apple hall"]);
  });

  // The same BINARY collation applied to the OUTER sort key, where
  // dupePostcodes.ts:83-85 says it does not matter because postcodes are
  // "uppercase alphanumerics, where the two orders agree". They are not
  // always: the admin stores a postcode exactly as typed, lowercase included
  // (adminFormFields.test.ts pins that), and 'SW1' < 'sw1' bytewise puts
  // every lowercase postcode after every uppercase one regardless of letter.
  // Cosmetic on a page that is a list of anomalies anyway, but the comment's
  // premise is not quite true and this is where that shows.
  it("sorts a lowercase postcode after every uppercase one", async () => {
    seedFoodbank({ name: "Lower One", postcode: "ex10 8lz" });
    seedFoodbank({ name: "Lower Two", postcode: "ex10 8lz" });
    seedFoodbank({ name: "Upper One", postcode: "SW1A 1AA" });
    seedFoodbank({ name: "Upper Two", postcode: "SW1A 1AA" });

    const result = await getDuplicatePostcodes(session);

    expect(postcodesOf(result)).toEqual(["SW1A 1AA", "ex10 8lz"]);
  });

  // The grouping loop reads the flat result set and starts a new group only
  // when the postcode CHANGES from the previous row -- so it is correct only
  // while `p.postcode` is the leading ORDER BY term. Drop it (leaving
  // `ORDER BY p.kind, p.name`, which still looks like a deliberate ordering)
  // and the rows interleave: every food bank first, then every location, so
  // each postcode is split across two groups and the page shows the same
  // postcode twice with half its rows under each. Three postcodes, each with
  // one food bank and one location, is the smallest seed that produces that.
  it("never splits one postcode across two groups", async () => {
    for (const [name, postcode] of [
      ["Alpha", "B1 1AA"],
      ["Bravo", "M1 1AE"],
      ["Charlie", "SW1A 1AA"],
    ] as const) {
      const id = seedFoodbank({ name, postcode });
      seedLocation({ foodbankId: id, name: `${name} Annexe`, postcode });
    }

    const result = await getDuplicatePostcodes(session);

    expect(postcodesOf(result)).toEqual(["B1 1AA", "M1 1AE", "SW1A 1AA"]);
    expect(result.groups.map((g) => placeKeysOf(g))).toEqual([
      ["foodbank:Alpha", "location:Alpha Annexe"],
      ["foodbank:Bravo", "location:Bravo Annexe"],
      ["foodbank:Charlie", "location:Charlie Annexe"],
    ]);
  });
});

describe("what each row carries", () => {
  // The `places` CTE aliases seven columns into a common shape across a
  // UNION ALL, and UNION ALL matches by POSITION, not by name. Swap two
  // columns in the second branch -- `foodbank_slug, foodbank_name` instead of
  // `foodbank_name, foodbank_slug` -- and SQLite accepts it silently: the
  // result set keeps the first branch's names, every type still matches, and
  // the page renders a food bank called "salisbury" linking to
  // /admin/foodbank/Salisbury/. So both branches are asserted field by field.
  it("gives a food bank row its own name in both name and foodbank_name, and no loc_slug", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", postcode: "SP2 9DY" });
    seedLocation({ foodbankId: salisbury, name: "Bemerton Heath Centre", postcode: "SP2 9DY" });

    const result = await getDuplicatePostcodes(session);

    expect(result.groups[0]!.places[0]).toEqual({
      postcode: "SP2 9DY",
      kind: "foodbank",
      name: "Salisbury",
      foodbank_name: "Salisbury",
      foodbank_slug: "salisbury",
      // NULL, and the template branches on `kind` rather than on this -- but
      // it is what tells a consumer the row has no location URL to build.
      loc_slug: null,
      is_closed: 0,
    });
  });

  it("gives a location row its own name and slug, and its parent's name and slug", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", postcode: "SP2 9DY" });
    seedLocation({ foodbankId: salisbury, name: "Bemerton Heath Centre", postcode: "SP2 9DY" });

    const result = await getDuplicatePostcodes(session);

    // foodbanks_dupe_postcodes.njk:92 builds
    // /admin/foodbank/{{ foodbank_slug }}/location/{{ loc_slug }}/edit/ from
    // these two, so a swap between them is a dead link on every location row.
    expect(result.groups[0]!.places[1]).toEqual({
      postcode: "SP2 9DY",
      kind: "location",
      name: "Bemerton Heath Centre",
      foodbank_name: "Salisbury",
      foodbank_slug: "salisbury",
      loc_slug: "bemerton-heath-centre",
      is_closed: 0,
    });
  });

  // JOIN DIRECTION, which no shape assertion can see. `foodbanklocation_full`
  // is a LEFT JOIN (0019:68-76) and this schema declares no foreign keys at
  // all (PLAN.md §4.5), so a location whose parent has been deleted still
  // exists. Under the LEFT JOIN it stays in `places` and its postcode still
  // counts toward the duplicate; swap the view to an INNER JOIN and the row
  // vanishes, the postcode drops below COUNT(*) > 1, and the whole group
  // disappears from the page -- silently, and precisely for the rows whose
  // data is most broken.
  //
  // The orphan's own foodbank_name and foodbank_slug come back NULL, which
  // the template renders as an empty cell linking to /admin/foodbank//. Ugly,
  // but it is a row that should not exist, and showing it is the point.
  it("counts an orphaned location, because the view LEFT JOINs its parent", async () => {
    seedFoodbank({ name: "Salisbury", postcode: "SP2 9DY" });
    seedLocation({ foodbankId: 9999, name: "Orphan Hall", postcode: "SP2 9DY" });

    const result = await getDuplicatePostcodes(session);

    expect(postcodesOf(result)).toEqual(["SP2 9DY"]);
    expect(placeKeysOf(result.groups[0]!)).toEqual(["foodbank:Salisbury", "location:Orphan Hall"]);
    expect(result.groups[0]!.places[1]).toMatchObject({ foodbank_name: null, foodbank_slug: null });
  });

  // UNION ALL, NOT UNION -- and this is the only seed that can tell them
  // apart, which is why it looks so peculiar. `UNION ALL` -> `UNION` is a
  // one-word edit that reads like a harmless tidy-up, and it de-duplicates
  // whole rows: a postcode whose two entries are identical in all seven
  // projected columns collapses to one, drops below COUNT(*) > 1, and
  // vanishes from the page. Verified in a scratchpad: the same fixture
  // returns 2 rows under UNION ALL and 0 under UNION.
  //
  // Reaching identical rows takes the orphan case above. Two locations of the
  // SAME food bank cannot share a name (loc_fb_name_uniq, 0001_core.sql:76)
  // and two locations of DIFFERENT food banks differ in foodbank_name and
  // foodbank_slug -- unless both parents are gone, when the view's LEFT JOIN
  // supplies NULL for both and the rows become indistinguishable. Two
  // orphaned "Mobile Unit" rows at one postcode is a real shape: a mobile
  // location is exactly the kind of generically-named row a food bank has,
  // and the parent deletion is what created the orphan in the first place.
  //
  // It is also the worst possible thing for this page to hide, since a
  // duplicate between two records whose parents no longer exist is precisely
  // the data an operator is here to find.
  it("counts two identical orphaned locations as a pair, because the branches are UNION ALL", async () => {
    seedLocation({ foodbankId: 9998, name: "Mobile Unit", postcode: "SP2 9DY" });
    seedLocation({ foodbankId: 9999, name: "Mobile Unit", postcode: "SP2 9DY" });

    const result = await getDuplicatePostcodes(session);

    expect(postcodesOf(result)).toEqual(["SP2 9DY"]);
    expect(placeKeysOf(result.groups[0]!)).toEqual(["location:Mobile Unit", "location:Mobile Unit"]);
  });
});

describe("the limit and the truncation flag", () => {
  it("reports the default limit of 500 when the caller passes none", async () => {
    // The route calls getDuplicatePostcodes(dbSession(c)) with no limit
    // (routes/admin/dupePostcodes.ts:22) and hands `limit` straight to the
    // template's "Showing the first {{ limit }}" notice, so the default is
    // user-visible text, not just an internal cap.
    const result = await getDuplicatePostcodes(session);

    expect(result.limit).toBe(500);
  });

  // THE OFF-BY-ONE. The statement asks for `limit + 1` postcodes purely to
  // learn whether a further one exists, and `truncated` is
  // `groups.length > limit`. Get either half wrong and the page shows a
  // "there are more" warning when there are exactly `limit` -- or, worse,
  // hides the warning when there is one more. Both boundaries are asserted,
  // because a mutant that binds `limit` instead of `limit + 1` passes the
  // "exactly at the limit" case and only fails the one above it.
  it("does not flag truncation when the count lands exactly on the limit", async () => {
    seedFoodbank({ name: "A One", postcode: "B1 1AA" });
    seedFoodbank({ name: "A Two", postcode: "B1 1AA" });
    seedFoodbank({ name: "B One", postcode: "M1 1AE" });
    seedFoodbank({ name: "B Two", postcode: "M1 1AE" });

    const result = await getDuplicatePostcodes(session, 2);

    expect(postcodesOf(result)).toEqual(["B1 1AA", "M1 1AE"]);
    expect(result.truncated).toBe(false);
    expect(result.limit).toBe(2);
  });

  // One over. The kept groups must be the lexicographically FIRST two, not
  // whichever two SQLite happened to reach first, so this is seeded with
  // insertion order and postcode order deliberately disagreeing.
  //
  // What this test catches is the mistake someone actually makes: moving the
  // LIMIT out of the CTE and onto the outer SELECT, which caps ROWS instead
  // of groups and takes the third group's first row while leaving its second
  // behind. It does NOT pin which postcodes the CTE selects, because at three
  // duplicates and a probe of three the CTE discards nothing -- the test
  // below is the one that puts the CTE's own ORDER BY under load.
  it("trims to the limit, keeps the first groups by postcode, and flags it", async () => {
    for (const postcode of ["SW1A 1AA", "B1 1AA", "M1 1AE"]) {
      seedFoodbank({ name: `First ${postcode}`, postcode });
      seedFoodbank({ name: `Second ${postcode}`, postcode });
    }

    const result = await getDuplicatePostcodes(session, 2);

    expect(postcodesOf(result)).toEqual(["B1 1AA", "M1 1AE"]);
    expect(result.truncated).toBe(true);
    // The trimmed group's rows are dropped whole; a half-populated final
    // group would be worse than none, since the page would show a postcode
    // with fewer places than it has and read as a two-way clash that is
    // really three-way.
    expect(result.groups.map((g) => g.places.length)).toEqual([2, 2]);
  });

  // THE CTE'S OWN ORDER BY, under the only conditions that can exercise it:
  // MORE duplicated postcodes than the probe fetches. Every other limit test
  // in this file seeds at most `limit + 1` duplicates, so `LIMIT ?` discards
  // nothing and the order it discards in is unobservable -- which is why
  // reversing the CTE to `ORDER BY postcode DESC` survived all of them.
  //
  // Five duplicated postcodes at a limit of 2 makes the probe fetch three and
  // throw two away. Under the code as written the CTE keeps B1/EX10/M1 and the
  // caller trims to B1/EX10; reversed, it keeps M1/SP2/SW1A and the caller
  // trims to M1/SP2. Both are two groups, both flag truncation, and both
  // render a perfectly plausible page -- the difference is only ever visible
  // in WHICH duplicates an operator is shown, which is the whole output of
  // this screen. Confirmed in a scratchpad: DESC returns
  // ["M1 1AE", "SP2 9DY"] here.
  //
  // Seeded in an order that agrees with neither the answer nor its reverse,
  // so a query returning insertion or id order fails too.
  it("selects which postcodes to keep by postcode order, not by whatever SQLite reaches first", async () => {
    for (const postcode of ["SW1A 1AA", "SP2 9DY", "M1 1AE", "EX10 8LZ", "B1 1AA"]) {
      seedFoodbank({ name: `First ${postcode}`, postcode });
      seedFoodbank({ name: `Second ${postcode}`, postcode });
    }

    const result = await getDuplicatePostcodes(session, 2);

    expect(postcodesOf(result)).toEqual(["B1 1AA", "EX10 8LZ"]);
    expect(result.truncated).toBe(true);
    expect(result.groups.map((g) => placeKeysOf(g))).toEqual([
      ["foodbank:First B1 1AA", "foodbank:Second B1 1AA"],
      ["foodbank:First EX10 8LZ", "foodbank:Second EX10 8LZ"],
    ]);
  });

  // The degenerate edge, pinned rather than endorsed: limit 0 still runs a
  // statement (probeLimit 1), still builds one group, then throws it away and
  // reports truncated -- an empty page with a "there are more" banner. No
  // caller passes 0 today; this is here so that a future caller wiring the
  // limit to a query parameter finds out from a test rather than from the
  // page.
  it("returns nothing but still flags truncation at a limit of 0", async () => {
    seedFoodbank({ name: "A One", postcode: "B1 1AA" });
    seedFoodbank({ name: "A Two", postcode: "B1 1AA" });

    const result = await getDuplicatePostcodes(session, 0);

    expect(result).toEqual({ groups: [], truncated: true, limit: 0 });
  });

  // SUSPECT, pinned as-is. DupePostcodeResult's comment says the ceiling
  // exists because "D1 meters rows scanned ... so it gets a ceiling rather
  // than an unbounded render", but the LIMIT is inside the `dupes` CTE and
  // therefore caps DISTINCT POSTCODES, not rows. The outer SELECT has no
  // LIMIT, so one pathological postcode shared by ten thousand rows returns
  // ten thousand rows and renders a ten-thousand-row table -- exactly the
  // "pathological import silently blows the page up" case the flag was
  // written to prevent. Six rows under a limit of 1 is the smallest
  // demonstration.
  //
  // Not a fix: the ceiling that exists does bound the common shape (many
  // postcodes, two or three rows each), and capping rows instead would mean
  // rendering a partial group, which is its own bug. Recorded so the
  // comment's claim and the code's behaviour are visibly different things.
  it("caps the number of GROUPS, not the number of rows", async () => {
    const parent = seedFoodbank({ name: "Salisbury", postcode: "SP2 9DY" });
    for (const suffix of ["A", "B", "C", "D", "E"]) {
      seedLocation({ foodbankId: parent, name: `Hall ${suffix}`, postcode: "SP2 9DY" });
    }

    const result = await getDuplicatePostcodes(session, 1);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.places).toHaveLength(6);
    expect(result.truncated).toBe(false);
  });

  // The default path at its real boundary, because 500 is the number that
  // actually ships and a cap that only works for the hand-written limits
  // above would be no cap at all. 501 duplicated postcodes, fixed-width so
  // that lexicographic order is numeric order, each held by two food banks.
  it("caps at the default 500 and reports the 501st as truncation", async () => {
    db.exec("BEGIN");
    for (let i = 0; i <= 500; i++) {
      const postcode = `AA${String(i).padStart(3, "0")} 1AA`;
      seedFoodbank({ name: `Bulk ${i} A`, postcode });
      seedFoodbank({ name: `Bulk ${i} B`, postcode });
    }
    db.exec("COMMIT");

    const result = await getDuplicatePostcodes(session);

    expect(result.groups).toHaveLength(500);
    expect(result.truncated).toBe(true);
    expect(result.limit).toBe(500);
    // The 500 kept are the first 500 by postcode, and the 501st is the one
    // dropped -- not an arbitrary 500 of the 501.
    expect(result.groups[0]!.postcode).toBe("AA000 1AA");
    expect(result.groups[499]!.postcode).toBe("AA499 1AA");
    expect(postcodesOf(result)).not.toContain("AA500 1AA");
  });
});

describe("the database traffic itself", () => {
  // The two claims that are about the SHAPE of the traffic rather than the
  // rows, which no assertion above can make.
  //
  // ONE STATEMENT: the module's comment says the probe row is fetched
  // "purely to learn whether there are more -- cheaper than a second full
  // scan just to COUNT them". A refactor that added a COUNT query would keep
  // every row assertion in this file green while doubling the work on a page
  // whose whole design rationale (dupePostcodes.ts:16-27) is that it scans
  // ~6k rows without an index and must therefore do it once.
  //
  // ONE BOUND PARAMETER: D1 rejects a statement with more than 100 bound
  // parameters, and the brief for this package treats any variable-length
  // binding as a boundary to test at 100 and 101. There is no boundary to
  // test here, and this is the assertion that says so in a way that fails if
  // it ever stops being true -- a future `WHERE postcode IN (...)` built from
  // the data would show up as a second parameter long before it reached 100.
  it("issues exactly one statement, binding exactly one value", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", postcode: "SP2 9DY" });
    seedLocation({ foodbankId: salisbury, name: "Bemerton Heath Centre", postcode: "SP2 9DY" });
    for (let i = 0; i < 60; i++) {
      const postcode = `ZZ${String(i).padStart(3, "0")} 1AA`;
      seedFoodbank({ name: `Filler ${i} A`, postcode });
      seedFoodbank({ name: `Filler ${i} B`, postcode });
    }

    const sink: Recorded[] = [];
    const result = await getDuplicatePostcodes(watchedSession(db, sink), 50);

    expect(sink).toHaveLength(1);
    // 61 duplicated postcodes in the database and a limit of 50 -- the
    // parameter count does not move with either.
    expect(sink[0]!.params).toHaveLength(1);
    expect(result.groups).toHaveLength(50);
  });

  // The probe itself: limit + 1, not limit. This is the mechanism behind
  // every truncation assertion above, asserted directly so that a failure is
  // reported as "the probe stopped probing" rather than as three unrelated
  // limit tests going red at once.
  it("binds one more than the limit, so a further group can be detected", async () => {
    const sink: Recorded[] = [];
    await getDuplicatePostcodes(watchedSession(db, sink), 500);
    expect(sink[0]!.params).toEqual([501]);

    sink.length = 0;
    await getDuplicatePostcodes(watchedSession(db, sink));
    expect(sink[0]!.params).toEqual([501]);

    sink.length = 0;
    await getDuplicatePostcodes(watchedSession(db, sink), 2);
    expect(sink[0]!.params).toEqual([3]);
  });
});
