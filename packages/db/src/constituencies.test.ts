// @ts-ignore -- no @types/node under this package's tsconfig; vitest runs in node, where this module is real
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "./schema.testkit";
// @ts-ignore -- ditto; the migration files are read off disk so the fixture cannot drift from production
import { beforeEach, describe, expect, it } from "vitest";
import {
  getAllConstituencies,
  getAllConstituenciesOrderedByName,
  getAllConstituencySlugs,
  getAllConstituencySlugsWithNames,
  getConstituencyBySlug,
  getConstituencyBySlugNarrow,
  getConstituencySlugByPcon24cd,
  getFoodbanksForConstituency,
} from "./constituencies";
import type { Session } from "./types";

// The eight queries behind /needs/in/constituencies/, /needs/in/constituency/
// <slug>/, /write/to/<slug>/, both sitemaps and gfapi2's `constituencies` /
// `constituency` endpoints.
//
// WHY A REAL DATABASE, AND NOT A MOCK. This module is nothing but SQL. Every
// way it can be wrong is silent: a dropped `is_closed = 0` returns closed food
// banks to the constituency page, a lost `ORDER BY name` shuffles the index
// page, an INNER JOIN in place of the view's LEFT JOIN loses orphaned
// locations, a widened SELECT drags 650 boundary_geojson blobs across the wire.
// None of those raise, none of them log, and every one of them renders a page
// that looks fine. This package already carries that scar -- migration 0019
// dropped five columns off six tables and four queries went on naming them
// until /dashboard/beautybanks/ was measured and found to be a live 500. A
// session handing back canned rows would have agreed with all of it, because
// the bug is in the SQL and a mock does not run SQL.
//
// THE FIXTURE IS THE MIGRATION FILES THEMSELVES, applied in order, for exactly
// that reason -- a CREATE TABLE transcribed into this file is a second copy of
// the truth and drifts the same way 0019's dropped columns did. Two things
// below depend on the real DDL and could not be faked honestly: the
// `foodbanklocation_full` VIEW that getFoodbanksForConstituency reads (its
// LEFT JOIN is one of the things under test, so a hand-built stand-in row
// would make the assertion circular), and `parliamentaryconstituency.name`
// being NULLABLE, which is what makes the NULL-ordering case reachable at all.
//
// The D1 100-bound-parameter limit has nothing to bite on here and there is
// deliberately no boundary case for it: every statement in this module binds
// either nothing or exactly one value, and none builds a variable-length IN
// list. If one ever does, that is the moment to add the at-and-over-100 cases.
//
// MUTATION-TESTED (TESTING.md's convention -- the evidence that a test is
// load-bearing rather than decoration). The module, and for one case the
// migration that defines the view it reads, were copied to a scratchpad,
// broken eighty-one ways in place, and this file re-run against every one of
// them: seventy-nine failed at least one case, and the two that did not are
// equivalent mutants, named at the end of this note.
//
// Caught: `ORDER BY name` deleted, flipped to DESC, moved to `slug`, given
// `COLLATE NOCASE` and given `NULLS LAST`; the ordered list and the slug list
// each widened to `SELECT *`, and the ordered list's `country` dropped and its
// `name`/`slug` transposed; `LIMIT 1` and `LIMIT 2` on the three list queries;
// each of the seven statements' WHERE clause deleted outright; `pcon24cd = ?`
// rewritten to the null-matching `IS ?`, to a prefix LIKE and to COLLATE
// NOCASE, and `slug = ?` the same three ways on BOTH by-slug reads;
// `mp_parl_id` dropped from getConstituencyBySlugNarrow's select list and from
// LOCATION_COLUMNS_NARROW, `mp_display_name` aliased off `mp`, `id` aliased off
// `mp_parl_id`, `latitude`/`longitude` transposed, `boundary_geojson` added to
// both narrow lists; `AND is_closed = 0` deleted from the food-bank statement
// and from the location statement one at a time, and inverted to `= 1`;
// `foodbanklocation_full` reverted to the base table and its LEFT JOIN turned
// INNER in 0019 itself; the location statement re-scoped through its parent's
// constituency, and its bound id replaced with a literal; the two batch results
// swapped; an `ORDER BY name` added to the food-bank statement, the location
// statement, getAllConstituencies and getAllConstituencySlugsWithNames; either
// list truncated to its first row; coerceBooleans and mapFoodbankRow each
// replaced with a bare cast; session.batch() unrolled into two round trips.
//
// SURVIVORS FOUND ON THE ADVERSARIAL PASS, and the cases added to kill them,
// each named in its own comment below: `LIMIT 1` and `ORDER BY name DESC` on
// getAllConstituencySlugsWithNames (every case seeded one row); a prefix LIKE
// and a COLLATE NOCASE on getConstituencyBySlugNarrow (only the wide read had
// an exactness case); `latitude`/`longitude` transposed in the narrow select
// list (every fixture leaves both NULL); `= ?` rewritten to `IS ?` on both
// halves of getFoodbanksForConstituency (nothing bound a NULL id); and
// `ORDER BY name` widened to `ORDER BY country, name` (no fixture held a
// country whose grouping disagreed with the name order).
//
// Two mutants survive and are EQUIVALENT, not holes: `is_closed = 0` rewritten
// to `is_closed != 1`, and `slug = ?` to `slug IS ?` -- `is_closed` and `slug`
// are both NOT NULL (0001_core.sql:37, :70, :131), so neither rewrite can
// change a row's fate. Writing a case for either would pin the schema, not the
// query.


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

// What the harness saw the module ask for. Only used by the two assertions
// that are about the STATEMENT rather than the rows -- PLAN.md's hard rule
// ("nothing in the codebase issues SELECT * on parliamentaryconstituency or
// foodbanklocation") is a claim about the select list, and a function that
// maps its rows down to bare strings destroys the evidence before a test can
// look at it. Everywhere else the rows themselves are the assertion.
interface Executed {
  sql: string;
  params: Bindable[];
}

// The same adapter as adminStats.test.ts / adminDashboardStats.test.ts, so all
// three tiers drive the real code through one shape rather than three.
// Deliberately dumb -- it never inspects or rewrites the SQL, it hands the
// statement straight to SQLite, which is the entire point of the exercise.
//
// batch() RUNS ITS STATEMENTS IN ORDER AND RETURNS ONE RESULT PER INPUT, in
// that order, because getFoodbanksForConstituency indexes straight into the
// array (`results[0]!` / `results[1]!`). That indexing is the contract: a
// batch that reordered or coalesced results would hand the location list back
// as `foodbanks` without erroring anywhere.
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
  return db.prepare("SELECT name FROM pragma_table_info(?)").all(table).map((row) => row.name as string);
}

// ===========================================================================
// SEEDS
// ===========================================================================
// Every fixture below uses REAL 2024 constituency names and real ONS PCON24CD
// codes. Not decoration: the ordering cases turn on the exact bytes of
// "Mid and South Pembrokeshire" against "Mid Bedfordshire", and a made-up
// name would have hidden the divergence those cases exist to pin.

interface ConstituencySeed {
  id: number;
  name: string | null;
  slug: string;
  country?: string | null;
  pcon24cd?: string | null;
  centroid?: string;
  boundaryGeojson?: string | null;
  mpParlId?: number;
}

function seedConstituency(c: ConstituencySeed): void {
  db.prepare(
    `INSERT INTO parliamentaryconstituency
       (id, name, slug, country, mp, mp_party, mp_parl_id, mp_display_name, email,
        centroid, latitude, longitude, boundary_geojson, pcon24cd)
     VALUES (?, ?, ?, ?, 'Blake Stephenson', 'Conservative', ?, 'Mr Blake Stephenson MP', 'blake.stephenson.mp@parliament.uk',
        ?, NULL, NULL, ?, ?)`,
  ).run(
    c.id,
    c.name,
    c.slug,
    c.country === undefined ? "England" : c.country,
    c.mpParlId ?? 5000 + c.id,
    // latitude/longitude stay NULL on purpose: 646 of 650 production rows are,
    // and latt()/long() read `centroid` instead (see ConstituencyRow's own
    // comment). A fixture that helpfully filled them in would hide a caller
    // that had started reading the vestigial columns.
    c.centroid ?? "52.0406,-0.4269",
    c.boundaryGeojson === undefined ? null : c.boundaryGeojson,
    c.pcon24cd === undefined ? null : c.pcon24cd,
  );
}

interface FoodbankSeed {
  id: number;
  name: string;
  slug: string;
  constituencyId: number | null;
  isClosed?: number;
  isSchool?: number | null;
  charityJustFoodbank?: number;
}

// Fills in the sixteen NOT NULL columns nothing in this module filters on, so
// each call site can say only what it is actually about. The three that DO
// matter -- parliamentary_constituency_id, is_closed and the boolean columns
// coerceBooleans touches -- are always explicit.
function seedFoodbank(f: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank
       (id, uuid, name, slug, address, postcode, country, lat_lng, latitude, longitude,
        charity_just_foodbank, contact_email, url, shopping_list_url, facebook_page,
        phone_number, latest_need_id, address_is_administrative, is_closed, is_school,
        place_has_photo, no_locations, days_between_needs,
        parliamentary_constituency_id, parliamentary_constituency_name, parliamentary_constituency_slug,
        created, modified, edited)
     VALUES (?, ?, ?, ?, 'Unit 1\r\nSomewhere', 'SP2 9DY', 'England', '51.0688,-1.7945', 51.0688, -1.7945,
        ?, ?, ?, ?, 'https://www.facebook.com/example',
        '01722 349556', 12345, 0, ?, ?,
        NULL, 0, 7,
        ?, NULL, NULL,
        '2024-07-04 12:00:00.000000', '2026-09-05 19:28:08.853000', '2026-09-05 19:28:08.853000')`,
  ).run(
    f.id,
    `uuid-foodbank-${f.id}`,
    f.name,
    f.slug,
    f.charityJustFoodbank ?? 1,
    `info@${f.slug}.foodbank.org.uk`,
    `https://${f.slug}.foodbank.org.uk/`,
    `https://${f.slug}.foodbank.org.uk/give-help/donate-food/`,
    f.isClosed ?? 0,
    f.isSchool === undefined ? null : f.isSchool,
    f.constituencyId,
  );
}

interface LocationSeed {
  id: number;
  foodbankId: number;
  name: string;
  slug: string;
  constituencyId: number | null;
  isClosed?: number;
  isDonationPoint?: number | null;
  isMobile?: number | null;
  placeHasPhoto?: number | null;
  boundaryGeojson?: string | null;
}

function seedLocation(l: LocationSeed): void {
  db.prepare(
    `INSERT INTO foodbanklocation
       (id, uuid, foodbank_id, name, slug, address, postcode, country, lat_lng, latitude, longitude,
        place_id, place_has_photo, parliamentary_constituency_id, parliamentary_constituency_name,
        parliamentary_constituency_slug, is_closed, is_donation_point, is_mobile, boundary_geojson,
        phone_number, email, modified, edited)
     VALUES (?, ?, ?, ?, ?, 'Pembroke Road', 'SP2 9DY', 'England', '51.0812,-1.8231', 51.0812, -1.8231,
        'ChIJVXealLU_xkcRja_At0z9AGY', ?, ?, NULL,
        NULL, ?, ?, ?, ?,
        NULL, NULL, '2026-09-05 19:28:08.853000', NULL)`,
  ).run(
    l.id,
    `uuid-location-${l.id}`,
    l.foodbankId,
    l.name,
    l.slug,
    l.placeHasPhoto === undefined ? null : l.placeHasPhoto,
    l.constituencyId,
    l.isClosed ?? 0,
    l.isDonationPoint === undefined ? null : l.isDonationPoint,
    l.isMobile === undefined ? null : l.isMobile,
    l.boundaryGeojson === undefined ? null : l.boundaryGeojson,
  );
}

// A boundary blob that is recognisable in a row dump. The real ones run to
// ~1.6 MB; nothing here needs the size, only the presence or absence.
const BOUNDARY = '{"type":"Polygon","coordinates":[[[-0.5,52.0],[-0.3,52.0],[-0.3,52.1],[-0.5,52.0]]]}';

// The three names whose SQL byte order and en_US order genuinely disagree, out
// of the real 650 (17 of 650 positions differ; the clusters are Mid*, Richmond*
// and Sutton*). Used by the ordering cases below.
const MID_PEMBS = "Mid and South Pembrokeshire";
const MID_BEDS = "Mid Bedfordshire";
const MID_CHESHIRE = "Mid Cheshire";

// ===========================================================================
// getAllConstituencies
// ===========================================================================

describe("getAllConstituencies", () => {
  // gfapi2's /constituencies/ is the only caller and its handler carries the
  // comment "Deliberately unordered ... Do not sort", matching Django's
  // `ParliamentaryConstituency.objects.all()` with no `.order_by()`. Pinning
  // the absence of an ORDER BY needs ids whose order is neither the byte order
  // nor the collated order of the names, or "no sort" and "sorted" produce the
  // same list and the test proves nothing.
  //
  // SQLite answers an unqualified full scan in rowid order, which is what
  // makes the ids observable here at all; D1 makes no such promise and the
  // module says so. The claim being pinned is the negative one -- that nobody
  // has quietly added `ORDER BY name` to this statement, which would silently
  // reorder the public API's output.
  it("returns every row, unfiltered and unsorted", async () => {
    seedConstituency({ id: 1, name: MID_PEMBS, slug: "mid-and-south-pembrokeshire", country: "Wales" });
    seedConstituency({ id: 2, name: "Salisbury", slug: "salisbury" });
    seedConstituency({ id: 3, name: "Aldershot", slug: "aldershot" });

    const rows = await getAllConstituencies(session);

    expect(rows.map((r) => r.name)).toEqual([MID_PEMBS, "Salisbury", "Aldershot"]);
    // Not the ORDER BY name that getAllConstituenciesOrderedByName applies --
    // under either collation, which is where "Aldershot" earns its place.
    expect(rows.map((r) => r.name)).not.toEqual(["Aldershot", MID_PEMBS, "Salisbury"]);
  });

  // Django's `.all()` has no is_closed concept for constituencies and there is
  // no such column; the point of this case is that no OTHER predicate has crept
  // in either -- a constituency with no food banks, no MP name and a NULL name
  // is still one of the 650 and still gets a page.
  it("keeps rows with NULL name, NULL country and no pcon24cd", async () => {
    seedConstituency({ id: 1, name: null, slug: "unnamed", country: null, pcon24cd: null });

    const rows = await getAllConstituencies(session);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBeNull();
    expect(rows[0]!.country).toBeNull();
  });

  // SELECT * -- so the ~1.6 MB boundary blob comes back on every one of the
  // 650 rows even though the only caller emits name/slug/country. That is the
  // exact cost getAllConstituencySlugs's own comment cites as the reason the
  // narrow variants exist, and it is asserted rather than described so that
  // narrowing this statement (which would be an improvement) is a deliberate
  // change with a failing test attached, not a silent one.
  it("returns boundary_geojson and pcon24cd, because the statement is SELECT *", async () => {
    seedConstituency({ id: 1, name: MID_BEDS, slug: "mid-bedfordshire", pcon24cd: "E14001063", boundaryGeojson: BOUNDARY });

    const rows = await getAllConstituencies(session);

    expect(rows[0]!.boundary_geojson).toBe(BOUNDARY);
    // pcon24cd is NOT on the ConstituencyRow interface (0011 added the column
    // after the type was written), so mapConstituencyRow's bare cast hands
    // callers a row with a field its own type denies exists. Harmless today --
    // no caller spreads a constituency row into a response -- and pinned here
    // so it is a known gap rather than a surprise.
    expect(Object.keys(rows[0]!)).toEqual(columnsOf("parliamentaryconstituency"));
    expect((rows[0]! as unknown as { pcon24cd: string }).pcon24cd).toBe("E14001063");
  });

  it("returns an empty array on an empty table rather than throwing", async () => {
    expect(await getAllConstituencies(session)).toEqual([]);
  });
});

// ===========================================================================
// getAllConstituencySlugs
// ===========================================================================

describe("getAllConstituencySlugs", () => {
  // Seeded in REVERSE alphabetical order deliberately, which turned up
  // something the original alphabetical fixture could not see: this statement
  // does NOT come back in table order. `SELECT slug` names only the column
  // parlcon_slug_idx indexes (0001_core.sql:137), so SQLite answers it as
  // "SCAN parliamentaryconstituency USING COVERING INDEX parlcon_slug_idx"
  // (verified with EXPLAIN QUERY PLAN on the real schema) and the rows arrive
  // slug-ascending despite the statement asking for no order at all.
  //
  // Pinned because it is free but fragile: sitemap.xml and sitemap.md list
  // constituencies alphabetically today for no reason anyone wrote down, and
  // adding one non-indexed column to this SELECT -- or dropping the index --
  // silently reshuffles both. The completeness claim (every seeded slug, no
  // duplicates) is the part that must hold whatever the planner does, so it is
  // asserted separately below.
  it("returns one bare slug string per row, ordered by the covering index rather than the table", async () => {
    seedConstituency({ id: 1, name: MID_CHESHIRE, slug: "mid-cheshire" });
    seedConstituency({ id: 2, name: MID_BEDS, slug: "mid-bedfordshire" });

    const slugs = await getAllConstituencySlugs(session);

    expect([...slugs].sort()).toEqual(["mid-bedfordshire", "mid-cheshire"]);
    expect(slugs).toEqual(["mid-bedfordshire", "mid-cheshire"]);
  });

  // PLAN.md's hard rule, asserted on the STATEMENT because this function is
  // the one place the rows cannot carry the evidence: it maps each row down to
  // `r.slug`, so a `SELECT *` that dragged 650 boundary blobs (up to ~1.6 MB
  // each) into the Worker's memory to build the sitemap would return exactly
  // the same array of strings and look identical from the outside. Every other
  // narrow query in this file is proved by its row's own key set instead.
  it("selects the slug column only, never the boundary blob", async () => {
    seedConstituency({ id: 1, name: MID_BEDS, slug: "mid-bedfordshire", boundaryGeojson: BOUNDARY });

    await getAllConstituencySlugs(session);

    expect(log.executed).toHaveLength(1);
    expect(log.executed[0]!.sql).toBe("SELECT slug FROM parliamentaryconstituency");
    expect(log.executed[0]!.sql).not.toContain("*");
    expect(log.executed[0]!.sql).not.toContain("boundary_geojson");
  });

  // Both sitemaps list every constituency, open or closed, named or not --
  // there is no filter here and a row with a NULL name still has a URL.
  it("includes a constituency whose name is NULL", async () => {
    seedConstituency({ id: 1, name: null, slug: "unnamed" });

    expect(await getAllConstituencySlugs(session)).toEqual(["unnamed"]);
  });

  it("returns an empty array on an empty table", async () => {
    expect(await getAllConstituencySlugs(session)).toEqual([]);
  });
});

// ===========================================================================
// getAllConstituencySlugsWithNames
// ===========================================================================

describe("getAllConstituencySlugsWithNames", () => {
  // The narrowness proof here is the ROW, not the SQL: these rows come back
  // straight out of SQLite untouched, so their own key set is the select list.
  // A widened statement fails this without anyone having to read the string.
  it("returns exactly slug and name, and nothing else", async () => {
    seedConstituency({ id: 1, name: MID_BEDS, slug: "mid-bedfordshire", boundaryGeojson: BOUNDARY });

    const rows = await getAllConstituencySlugsWithNames(session);

    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(["name", "slug"]);
    expect({ ...rows[0]! }).toEqual({ slug: "mid-bedfordshire", name: MID_BEDS });
  });

  // SUSPECT, PINNED NOT FIXED. The declared return type is
  // `Array<{ slug: string; name: string }>`, but `name` is NULLABLE in the
  // schema (0001_core.sql:131) and Django declares it `null=True, blank=True`
  // -- so this row's `name` really can be null and the type says it cannot.
  // public/md.ts feeds these straight into public/md/sitemap.njk as link text,
  // where a null renders as an empty label rather than failing. Asserting what
  // it DOES so the next person to widen the type knows the null is reachable.
  it("hands back a NULL name despite the declared string type", async () => {
    seedConstituency({ id: 1, name: null, slug: "unnamed" });

    const rows = await getAllConstituencySlugsWithNames(session);

    expect(rows[0]!.name).toBeNull();
  });

  // EVERY ROW, IN TABLE ORDER -- and the only case in this describe that seeds
  // more than one. That mattered: with one-row fixtures a `LIMIT 1` and a
  // bolted-on `ORDER BY name DESC` both survived mutation, and the first of
  // those is the markdown sitemap listing one constituency out of 650 while
  // still returning 200. Django's md_sitemap_md (givefood/views.py:794) is
  // `ParliamentaryConstituency.objects.all().only('slug','name')` -- no
  // filter, no ORDER BY -- and public/md/sitemap.njk emits them in the order
  // it is handed, so table order is the ported behaviour. Seeded out of name
  // order so a sort mutant cannot hide behind insertion order.
  it("returns every row, in table order, sorting and truncating nothing", async () => {
    seedConstituency({ id: 1, name: "Salisbury", slug: "salisbury" });
    seedConstituency({ id: 2, name: "Aldershot", slug: "aldershot" });
    seedConstituency({ id: 3, name: MID_BEDS, slug: "mid-bedfordshire" });

    const rows = await getAllConstituencySlugsWithNames(session);

    expect(rows.map((r) => ({ ...r }))).toEqual([
      { slug: "salisbury", name: "Salisbury" },
      { slug: "aldershot", name: "Aldershot" },
      { slug: "mid-bedfordshire", name: MID_BEDS },
    ]);
  });

  it("returns an empty array on an empty table", async () => {
    expect(await getAllConstituencySlugsWithNames(session)).toEqual([]);
  });
});

// ===========================================================================
// getAllConstituenciesOrderedByName
// ===========================================================================

describe("getAllConstituenciesOrderedByName", () => {
  // `get_all_constituencies()` (givefood/utils/cache.py:138-146) is
  // `.defer("boundary_geojson").order_by("name")`. Both halves are asserted:
  // the four columns that survive the defer, and the sort.
  it("returns exactly name, slug, country and centroid -- boundary_geojson deferred", async () => {
    seedConstituency({ id: 1, name: MID_BEDS, slug: "mid-bedfordshire", centroid: "52.0406,-0.4269", boundaryGeojson: BOUNDARY });

    const rows = await getAllConstituenciesOrderedByName(session);

    // The row's own keys are the select list -- see the note on
    // getAllConstituencySlugsWithNames. Nearby-constituency search reads
    // `centroid` (never latitude/longitude, which are 646/650 NULL), so its
    // presence is load-bearing, not incidental.
    expect(Object.keys(rows[0]!).sort()).toEqual(["centroid", "country", "name", "slug"]);
    expect({ ...rows[0]! }).toEqual({ name: MID_BEDS, slug: "mid-bedfordshire", country: "England", centroid: "52.0406,-0.4269" });
  });

  // The ORDER BY itself, seeded out of order so a dropped clause reorders the
  // constituency index page rather than passing quietly.
  //
  // "Belfast East" is here to make the sort key observable. With only English
  // rows and one Welsh one, name order and country-then-name order are the
  // same list, and `ORDER BY country, name` survived mutation -- harmless for
  // today's two callers (wfbnConstituencies re-sorts by country in JS with a
  // stable sort, and the nearby-constituency search ignores order entirely),
  // but it is not what `get_all_constituencies()` does, and the next caller to
  // read this list will assume the name it carries. A Northern Ireland row
  // whose name sorts into the middle of the English ones separates the two.
  it("sorts by name ascending regardless of insertion order or country", async () => {
    seedConstituency({ id: 1, name: "Salisbury", slug: "salisbury" });
    seedConstituency({ id: 2, name: "Aldershot", slug: "aldershot" });
    seedConstituency({ id: 3, name: "Ynys Môn", slug: "ynys-mon", country: "Wales" });
    seedConstituency({ id: 4, name: "Bath", slug: "bath" });
    seedConstituency({ id: 5, name: "Belfast East", slug: "belfast-east", country: "Northern Ireland" });

    const rows = await getAllConstituenciesOrderedByName(session);

    expect(rows.map((r) => r.name)).toEqual(["Aldershot", "Bath", "Belfast East", "Salisbury", "Ynys Môn"]);
  });

  // SUSPECT, PINNED NOT FIXED -- and the reason this test names real
  // constituencies. This is the one query in the module that sorts in SQL, and
  // SQLite's default TEXT collation is BINARY: byte for byte, so a space
  // (0x20) beats every letter and every uppercase letter (0x42 for 'B') beats
  // every lowercase one (0x61 for 'a'). Postgres sorted the same column under
  // en_US.utf8, and this package's own sortByName() (types.ts) exists
  // precisely because those two disagree -- yet this function does not use it.
  //
  // Measured against the real 650 names in parlcon.json: 17 positions differ
  // between the two orders, in three clusters (Mid*, Richmond*, Sutton*). The
  // /needs/in/constituencies/ index therefore lists "Mid and South
  // Pembrokeshire" AFTER "Mid Cheshire", where production listed it first.
  //
  // The collator's answer is computed here rather than written down, so this
  // records a genuine disagreement between the two orderings instead of a
  // claim about one. If someone routes this through sortByName the assertion
  // flips and this comment is where they find out why it was ever this way.
  it("sorts by SQLite's byte order, which is NOT the collation the rest of this package uses", async () => {
    seedConstituency({ id: 1, name: MID_CHESHIRE, slug: "mid-cheshire" });
    seedConstituency({ id: 2, name: MID_PEMBS, slug: "mid-and-south-pembrokeshire", country: "Wales" });
    seedConstituency({ id: 3, name: MID_BEDS, slug: "mid-bedfordshire" });

    const rows = await getAllConstituenciesOrderedByName(session);

    expect(rows.map((r) => r.name)).toEqual([MID_BEDS, MID_CHESHIRE, MID_PEMBS]);

    const collated = [MID_CHESHIRE, MID_PEMBS, MID_BEDS].sort(new Intl.Collator("en-US").compare);
    expect(collated).toEqual([MID_PEMBS, MID_BEDS, MID_CHESHIRE]);
    expect(rows.map((r) => r.name)).not.toEqual(collated);
  });

  // SUSPECT, PINNED NOT FIXED. `name` is nullable and SQLite puts NULLs FIRST
  // in an ascending sort; Postgres puts them LAST. A constituency saved with
  // no name would therefore head the index page here and have tailed it in
  // production. No production row has a NULL name today, which is why this is
  // a pin rather than a fix -- but the column allows it and the admin form at
  // routes/admin/parlcon.ts can write it.
  it("puts a NULL name first, the opposite of Postgres", async () => {
    seedConstituency({ id: 1, name: "Aldershot", slug: "aldershot" });
    seedConstituency({ id: 2, name: null, slug: "unnamed" });

    const rows = await getAllConstituenciesOrderedByName(session);

    expect(rows.map((r) => r.name)).toEqual([null, "Aldershot"]);
  });

  it("returns an empty array on an empty table", async () => {
    expect(await getAllConstituenciesOrderedByName(session)).toEqual([]);
  });
});

// ===========================================================================
// getConstituencySlugByPcon24cd
// ===========================================================================

describe("getConstituencySlugByPcon24cd", () => {
  // PLAN.md §6.9 R7's whole point: /write/ looks a constituency up by its ONS
  // code so no second slugify has to exist in the browser. The name that broke
  // the old client-side derivation -- "Montgomeryshire and Glyndŵr", whose ŵ
  // the map's transliteration table has no entry for -- is the fixture here,
  // because the slug it must return is exactly the one that used to be built
  // wrong.
  it("returns the slug for a code, including one no client-side slugify could derive", async () => {
    seedConstituency({ id: 1, name: "Montgomeryshire and Glyndŵr", slug: "montgomeryshire-and-glyndwr", country: "Wales", pcon24cd: "W07000081" });
    seedConstituency({ id: 2, name: MID_BEDS, slug: "mid-bedfordshire", pcon24cd: "E14001063" });

    expect(await getConstituencySlugByPcon24cd(session, "W07000081")).toBe("montgomeryshire-and-glyndwr");
    expect(await getConstituencySlugByPcon24cd(session, "E14001063")).toBe("mid-bedfordshire");
  });

  it("returns null for a code that is not in the table", async () => {
    seedConstituency({ id: 1, name: MID_BEDS, slug: "mid-bedfordshire", pcon24cd: "E14001063" });

    expect(await getConstituencySlugByPcon24cd(session, "E14009999")).toBeNull();
  });

  // THE NULL TRAP, RUN RATHER THAN REASONED ABOUT. `pcon24cd = ?` bound with
  // NULL is `NULL = NULL`, which is UNKNOWN, never true -- so a row whose code
  // is NULL is unreachable through this function even when the caller asks for
  // NULL. 0011 backfilled all 650 from parlcon.json, but the column is
  // nullable and its unique index is PARTIAL (`WHERE pcon24cd IS NOT NULL`),
  // so nothing stops a hand-added constituency having none. writeConstituencyByCode
  // 404s, which is the right answer -- pinned so a future `IS ?` rewrite,
  // which would start matching those rows, is a visible decision.
  it("never matches a NULL pcon24cd, even when asked for one", async () => {
    seedConstituency({ id: 1, name: MID_BEDS, slug: "mid-bedfordshire", pcon24cd: null });

    expect(await getConstituencySlugByPcon24cd(session, null as unknown as string)).toBeNull();
  });

  // The partial unique index tolerates any number of NULL codes; two rows both
  // missing one must not make each other findable.
  it("finds neither of two rows that both have a NULL code", async () => {
    seedConstituency({ id: 1, name: MID_BEDS, slug: "mid-bedfordshire", pcon24cd: null });
    seedConstituency({ id: 2, name: MID_CHESHIRE, slug: "mid-cheshire", pcon24cd: null });

    expect(await getConstituencySlugByPcon24cd(session, "E14001063")).toBeNull();
  });

  // The code arrives as a URL path segment, so it is whatever the visitor
  // typed. `=` on TEXT is case-sensitive under SQLite's BINARY collation, so
  // the lowercase form 404s. Correct (a 404 is the honest answer for a code
  // that is not stored) but worth pinning: a later `COLLATE NOCASE` or a
  // `lower()` on both sides would change a live URL's behaviour.
  it("matches the code exactly, so a lowercased code finds nothing", async () => {
    seedConstituency({ id: 1, name: MID_BEDS, slug: "mid-bedfordshire", pcon24cd: "E14001063" });

    expect(await getConstituencySlugByPcon24cd(session, "e14001063")).toBeNull();
  });

  // Reads one column, not the row -- boundary_geojson must not ride along on
  // what is only ever a redirect lookup.
  it("selects slug only", async () => {
    seedConstituency({ id: 1, name: MID_BEDS, slug: "mid-bedfordshire", pcon24cd: "E14001063", boundaryGeojson: BOUNDARY });

    await getConstituencySlugByPcon24cd(session, "E14001063");

    expect(log.executed).toHaveLength(1);
    expect(log.executed[0]!.sql).toBe("SELECT slug FROM parliamentaryconstituency WHERE pcon24cd = ?");
    expect(log.executed[0]!.params).toEqual(["E14001063"]);
  });
});

// ===========================================================================
// getConstituencyBySlug
// ===========================================================================

describe("getConstituencyBySlug", () => {
  // The one caller that genuinely wants the blob is the geojson feed, so this
  // is the one read where SELECT * is the right answer. Asserting the blob
  // comes back is asserting the feed has something to serve.
  it("returns the whole row including boundary_geojson", async () => {
    seedConstituency({ id: 4, name: "Ynys Môn", slug: "ynys-mon", country: "Wales", centroid: "53.2707,-4.3227", boundaryGeojson: BOUNDARY });

    const row = await getConstituencyBySlug(session, "ynys-mon");

    expect(row).not.toBeNull();
    expect(row!.id).toBe(4);
    expect(row!.name).toBe("Ynys Môn");
    expect(row!.country).toBe("Wales");
    expect(row!.centroid).toBe("53.2707,-4.3227");
    expect(row!.boundary_geojson).toBe(BOUNDARY);
    // latt()/long() split `centroid`; these two stay NULL in production and
    // the port must not have started deriving them.
    expect(row!.latitude).toBeNull();
    expect(row!.longitude).toBeNull();
  });

  it("returns null for an unknown slug rather than the first row in the table", async () => {
    seedConstituency({ id: 1, name: MID_BEDS, slug: "mid-bedfordshire" });

    expect(await getConstituencyBySlug(session, "mid-bedforshire")).toBeNull();
  });

  // A `LIKE` or a trimmed comparison would make /needs/in/constituency/<slug>/
  // answer for URLs that are not the canonical one, quietly duplicating every
  // constituency page for search engines.
  it("matches the slug exactly -- no prefix, no case-folding", async () => {
    seedConstituency({ id: 1, name: MID_BEDS, slug: "mid-bedfordshire" });

    expect(await getConstituencyBySlug(session, "mid-bed")).toBeNull();
    expect(await getConstituencyBySlug(session, "Mid-Bedfordshire")).toBeNull();
    expect(await getConstituencyBySlug(session, "mid-bedfordshire ")).toBeNull();
  });

  // parlcon_slug_idx is NOT unique (0001_core.sql:137), and the slug is
  // derived from the name by Django's slugify, which can collide. `.first()`
  // silently picks one -- the lowest rowid, since nothing orders the scan.
  // Pinned because "returns a row" hides it: the losing constituency has no
  // reachable page at all, and this is where that shows up.
  it("returns only the lowest-rowid row when two constituencies share a slug", async () => {
    seedConstituency({ id: 9, name: "Ynys Môn", slug: "ynys-mon", country: "Wales" });
    seedConstituency({ id: 2, name: "Ynys Mon", slug: "ynys-mon", country: "Wales" });

    const row = await getConstituencyBySlug(session, "ynys-mon");

    expect(row!.id).toBe(2);
  });
});

// ===========================================================================
// getConstituencyBySlugNarrow
// ===========================================================================

describe("getConstituencyBySlugNarrow", () => {
  // PLAN.md's hard rule for the detail page and the MP-photo redirect: every
  // ConstituencyRow field EXCEPT the blob. Proved by the row's own key set --
  // widen the statement and this fails, drop a column the template reads and
  // it fails too. /write/to/<slug>/ reads mp_parl_id for the photo URL and
  // mp/mp_party/mp_display_name for the page furniture, so the list is not
  // cosmetic.
  it("returns the twelve non-blob columns and nothing else", async () => {
    seedConstituency({ id: 1, name: MID_BEDS, slug: "mid-bedfordshire", pcon24cd: "E14001063", boundaryGeojson: BOUNDARY, mpParlId: 5164 });

    const row = await getConstituencyBySlugNarrow(session, "mid-bedfordshire");

    expect(Object.keys(row!).sort()).toEqual(
      ["centroid", "country", "email", "id", "latitude", "longitude", "mp", "mp_display_name", "mp_parl_id", "mp_party", "name", "slug"].sort(),
    );
    expect(Object.keys(row!)).not.toContain("boundary_geojson");
    // 0011's column is deliberately absent too -- the narrow list was written
    // before it existed and no caller needs it.
    expect(Object.keys(row!)).not.toContain("pcon24cd");
    expect(row!.mp_parl_id).toBe(5164);
    expect(row!.mp_display_name).toBe("Mr Blake Stephenson MP");
  });

  // Same values as the wide read for every column they share. A narrow variant
  // that had drifted -- a renamed alias, a column selected twice under one
  // name -- would still return "a row", and only this comparison catches it.
  it("agrees with getConstituencyBySlug on every column they share", async () => {
    seedConstituency({ id: 7, name: "Ynys Môn", slug: "ynys-mon", country: "Wales", centroid: "53.2707,-4.3227", boundaryGeojson: BOUNDARY });

    const wide = await getConstituencyBySlug(session, "ynys-mon");
    const narrow = await getConstituencyBySlugNarrow(session, "ynys-mon");

    for (const key of Object.keys(narrow!)) {
      expect(narrow![key as keyof typeof narrow]).toEqual((wide as unknown as Record<string, unknown>)[key]);
    }
  });

  it("returns null for an unknown slug", async () => {
    seedConstituency({ id: 1, name: MID_BEDS, slug: "mid-bedfordshire" });

    expect(await getConstituencyBySlugNarrow(session, "nowhere")).toBeNull();
  });

  // THE SAME EXACTNESS CASE getConstituencyBySlug CARRIES, and its absence
  // here was a real hole: `WHERE slug LIKE ? || '%'` and `WHERE slug = ?
  // COLLATE NOCASE` both survived mutation, because "nowhere" above is not a
  // prefix of anything and no other case asks for a near-miss. This is the
  // narrow read, so it is the one that matters most -- it gates FOUR live
  // routes (routes/write/index.ts:178, :209, :328, :406 and
  // routes/wfbn/constituencies.ts:119, :296), and every one of them 404s on
  // its null. A prefix match makes /write/to/mid/ a working page, and
  // writeEmail takes the recipient address straight off this row
  // (write/index.ts:388: `to: constituency.email`), so the letter a
  // constituent writes to their MP is delivered to a different one. The photo
  // redirect sends the wrong face with it.
  it("matches the slug exactly -- no prefix, no case-folding, no trimming", async () => {
    seedConstituency({ id: 1, name: MID_BEDS, slug: "mid-bedfordshire" });

    expect(await getConstituencyBySlugNarrow(session, "mid-bed")).toBeNull();
    expect(await getConstituencyBySlugNarrow(session, "Mid-Bedfordshire")).toBeNull();
    expect(await getConstituencyBySlugNarrow(session, "mid-bedfordshire ")).toBeNull();
  });

  // COLUMN IDENTITY, not just column presence. Every other fixture in this
  // file leaves latitude and longitude NULL on purpose (646/650 production
  // rows are, and latt()/long() read `centroid` instead) -- which is exactly
  // what let a select list of `longitude AS latitude, latitude AS longitude`
  // pass everything, including the key-set assertion above and the
  // wide-versus-narrow comparison: NULL swapped with NULL is invisible. They
  // are the same REAL type and adjacent in the statement, so a careless edit
  // can transpose them, and a constituency's stated position lands in the
  // North Sea. Given values, this is the only case that notices.
  it("keeps latitude and longitude in their own columns", async () => {
    seedConstituency({ id: 1, name: MID_BEDS, slug: "mid-bedfordshire", centroid: "52.0406,-0.4269" });
    db.prepare("UPDATE parliamentaryconstituency SET latitude = ?, longitude = ? WHERE id = ?").run(52.0406, -0.4269, 1);

    const row = await getConstituencyBySlugNarrow(session, "mid-bedfordshire");

    expect(row!.latitude).toBe(52.0406);
    expect(row!.longitude).toBe(-0.4269);
    expect(row!.centroid).toBe("52.0406,-0.4269");
  });
});

// ===========================================================================
// getFoodbanksForConstituency
// ===========================================================================
// `ParliamentaryConstituency.foodbanks()` (givefood/models/political.py:100-137)
// via foodbank_obj() / location_obj(), both of which filter
// `parliamentary_constituency = self, is_closed = False`. Two independent
// SELECTs against two tables, returned as two raw lists -- frozen bug B3
// (PLAN.md §7.3) lives in the CALLER, which does not check which list an entry
// came from, so this function must keep them separable and must not sort or
// merge them.

describe("getFoodbanksForConstituency", () => {
  const MID_BEDS_ID = 1;
  const OTHER_ID = 2;

  beforeEach(() => {
    seedConstituency({ id: MID_BEDS_ID, name: MID_BEDS, slug: "mid-bedfordshire" });
    seedConstituency({ id: OTHER_ID, name: MID_CHESHIRE, slug: "mid-cheshire" });
  });

  // ONE ROUND TRIP, not two. The module's own comment claims it, and D1 charges
  // per round trip -- a refactor back to two sequential awaits would be
  // invisible in every row-level assertion in this file.
  it("issues both statements as a single batch", async () => {
    await getFoodbanksForConstituency(session, MID_BEDS_ID);

    expect(log.batches).toBe(1);
    expect(log.executed).toHaveLength(2);
    // Both scoped to the same constituency: a batch that bound the id to only
    // one of them would return the whole country's locations.
    expect(log.executed[0]!.params).toEqual([MID_BEDS_ID]);
    expect(log.executed[1]!.params).toEqual([MID_BEDS_ID]);
  });

  // The filter, seeded so that a predicate which did nothing would still fail.
  // Every excluded row here is one a broken WHERE would put on a live page:
  // a closed food bank the public would be sent to, and another
  // constituency's food banks appearing under this MP's name.
  it("returns open food banks in this constituency and excludes closed, foreign and unassigned ones", async () => {
    seedFoodbank({ id: 10, name: "Bedford Foodbank", slug: "bedford", constituencyId: MID_BEDS_ID, isClosed: 0 });
    seedFoodbank({ id: 11, name: "Ampthill Foodbank", slug: "ampthill", constituencyId: MID_BEDS_ID, isClosed: 1 });
    seedFoodbank({ id: 12, name: "Northwich Foodbank", slug: "northwich", constituencyId: OTHER_ID, isClosed: 0 });
    seedFoodbank({ id: 13, name: "Unplaced Foodbank", slug: "unplaced", constituencyId: null, isClosed: 0 });

    const { foodbanks } = await getFoodbanksForConstituency(session, MID_BEDS_ID);

    expect(foodbanks.map((f) => f.slug)).toEqual(["bedford"]);
  });

  // The location half of the same filter. `is_closed` is the one cached
  // Foodbank field 0019 deliberately KEPT on the child table, so this
  // predicate reads the LOCATION's own column -- a closed location under an
  // open food bank is excluded, matching Django's
  // `FoodbankLocation.objects.filter(..., is_closed = False)`.
  it("returns open locations in this constituency and excludes closed and foreign ones", async () => {
    seedFoodbank({ id: 10, name: "Bedford Foodbank", slug: "bedford", constituencyId: MID_BEDS_ID });
    seedLocation({ id: 20, foodbankId: 10, name: "Ampthill Centre", slug: "ampthill-centre", constituencyId: MID_BEDS_ID, isClosed: 0 });
    seedLocation({ id: 21, foodbankId: 10, name: "Flitwick Centre", slug: "flitwick-centre", constituencyId: MID_BEDS_ID, isClosed: 1 });
    seedLocation({ id: 22, foodbankId: 10, name: "Northwich Centre", slug: "northwich-centre", constituencyId: OTHER_ID, isClosed: 0 });
    seedLocation({ id: 23, foodbankId: 10, name: "Unplaced Centre", slug: "unplaced-centre", constituencyId: null, isClosed: 0 });

    const { locations } = await getFoodbanksForConstituency(session, MID_BEDS_ID);

    expect(locations.map((l) => l.slug)).toEqual(["ampthill-centre"]);
  });

  // THE JOIN-DIRECTION CASE. A location's constituency is its OWN column, not
  // its parent food bank's -- a food bank in Mid Cheshire can perfectly well
  // run a distribution centre in Mid Bedfordshire, and that centre belongs on
  // the Mid Bedfordshire page. A query "simplified" to filter through the
  // parent would drop it from one page and invent it on the other.
  it("scopes a location by its own constituency, not its parent food bank's", async () => {
    seedFoodbank({ id: 12, name: "Northwich Foodbank", slug: "northwich", constituencyId: OTHER_ID });
    seedLocation({ id: 24, foodbankId: 12, name: "Ampthill Outreach", slug: "ampthill-outreach", constituencyId: MID_BEDS_ID });

    const here = await getFoodbanksForConstituency(session, MID_BEDS_ID);
    const there = await getFoodbanksForConstituency(session, OTHER_ID);

    expect(here.locations.map((l) => l.slug)).toEqual(["ampthill-outreach"]);
    expect(here.foodbanks).toEqual([]);
    expect(there.foodbanks.map((f) => f.slug)).toEqual(["northwich"]);
    expect(there.locations).toEqual([]);
  });

  // CARDINALITY. One parent with two children must yield one food bank and two
  // locations -- a query that had grown a join would duplicate the parent once
  // per child, and the /write/ page's food-bank name list would say "Bedford
  // Foodbank" twice. The childless parent in the same constituency is the
  // other half: an INNER-shaped rewrite would lose it entirely.
  it("does not duplicate a food bank that has two locations, and keeps one that has none", async () => {
    seedFoodbank({ id: 10, name: "Bedford Foodbank", slug: "bedford", constituencyId: MID_BEDS_ID });
    seedFoodbank({ id: 14, name: "Biggleswade Foodbank", slug: "biggleswade", constituencyId: MID_BEDS_ID });
    seedLocation({ id: 20, foodbankId: 10, name: "Ampthill Centre", slug: "ampthill-centre", constituencyId: MID_BEDS_ID });
    seedLocation({ id: 21, foodbankId: 10, name: "Flitwick Centre", slug: "flitwick-centre", constituencyId: MID_BEDS_ID });

    const { foodbanks, locations } = await getFoodbanksForConstituency(session, MID_BEDS_ID);

    expect(foodbanks.map((f) => f.slug)).toEqual(["bedford", "biggleswade"]);
    expect(locations.map((l) => l.slug)).toEqual(["ampthill-centre", "flitwick-centre"]);
  });

  // THE VIEW'S LEFT JOIN, which is the reason this test seeds against the real
  // migration rather than a hand-written CREATE VIEW. D1 has no foreign keys
  // (PLAN.md §4.5), so a location can outlive its parent row; 0019's header
  // says "LEFT JOIN, not JOIN ... a LEFT JOIN cannot lose a row either way".
  // Swap the view to an INNER JOIN and this location silently vanishes off the
  // constituency page while everything else still passes.
  it("keeps a location whose parent food bank row is missing, with NULL parent fields", async () => {
    seedLocation({ id: 25, foodbankId: 999, name: "Orphan Centre", slug: "orphan-centre", constituencyId: MID_BEDS_ID });

    const { locations } = await getFoodbanksForConstituency(session, MID_BEDS_ID);

    expect(locations.map((l) => l.slug)).toEqual(["orphan-centre"]);
    expect(locations[0]!.foodbank_name).toBeNull();
    expect(locations[0]!.foodbank_slug).toBeNull();
    expect(locations[0]!.foodbank_email).toBeNull();
  });

  // The point of 0019: the parent's fields are JOINED at read time, not read
  // from a stale copy on the child. Before that migration, 24 rows in
  // production disagreed with their parent's slug and name and 38 with its
  // email, and getDonationPointBySlugs FINDS children by that cached slug --
  // so a stale copy 404s the child's own page. Renaming the parent here and
  // re-reading is the shortest possible proof the copy is gone.
  it("takes the parent's name, slug, network, phone and email live from the foodbank table", async () => {
    seedFoodbank({ id: 10, name: "Bedford Foodbank", slug: "bedford", constituencyId: MID_BEDS_ID });
    seedLocation({ id: 20, foodbankId: 10, name: "Ampthill Centre", slug: "ampthill-centre", constituencyId: MID_BEDS_ID });

    db.prepare("UPDATE foodbank SET name = ?, slug = ?, contact_email = ? WHERE id = ?").run(
      "Bedford & District Foodbank",
      "bedford-and-district",
      "hello@bedford-and-district.foodbank.org.uk",
      10,
    );

    const { locations } = await getFoodbanksForConstituency(session, MID_BEDS_ID);

    expect(locations[0]!.foodbank_name).toBe("Bedford & District Foodbank");
    expect(locations[0]!.foodbank_slug).toBe("bedford-and-district");
    expect(locations[0]!.foodbank_email).toBe("hello@bedford-and-district.foodbank.org.uk");
  });

  // THE 0019 DRIFT DETECTOR. LOCATION_COLUMNS_NARROW is a hand-maintained
  // 38-name string in constituencies.ts; the view is defined in a migration.
  // Those are two copies of one list and they drift -- that is precisely what
  // 0019 did to four other queries. Comparing the returned row's keys against
  // the view's actual columns means the next ALTER TABLE either updates this
  // constant or turns this test red, instead of producing a D1 error on a page
  // nobody loads until it is measured.
  it("selects every column of foodbanklocation_full except boundary_geojson", async () => {
    seedFoodbank({ id: 10, name: "Bedford Foodbank", slug: "bedford", constituencyId: MID_BEDS_ID });
    seedLocation({ id: 20, foodbankId: 10, name: "Ampthill Centre", slug: "ampthill-centre", constituencyId: MID_BEDS_ID, boundaryGeojson: BOUNDARY });

    const { locations } = await getFoodbanksForConstituency(session, MID_BEDS_ID);

    const expected = columnsOf("foodbanklocation_full").filter((column) => column !== "boundary_geojson");
    expect(Object.keys(locations[0]!).sort()).toEqual(expected.sort());
    expect(Object.keys(locations[0]!)).not.toContain("boundary_geojson");
  });

  // The food-bank half is a SELECT *, so the same drift check applies in
  // reverse: whatever the table holds is what the callers get. The named
  // columns are the ones api2's buildConstituencyFoodbankEntries actually
  // reads -- 0019 is the proof that "the column is still there" is worth
  // asserting rather than assuming.
  it("returns every foodbank column, including the ones the constituency API reads", async () => {
    seedFoodbank({ id: 10, name: "Bedford Foodbank", slug: "bedford", constituencyId: MID_BEDS_ID });

    const { foodbanks } = await getFoodbanksForConstituency(session, MID_BEDS_ID);

    expect(Object.keys(foodbanks[0]!).sort()).toEqual(columnsOf("foodbank").sort());
    expect(foodbanks[0]!.lat_lng).toBe("51.0688,-1.7945");
    expect(foodbanks[0]!.url).toBe("https://bedford.foodbank.org.uk/");
    expect(foodbanks[0]!.shopping_list_url).toBe("https://bedford.foodbank.org.uk/give-help/donate-food/");
    expect(foodbanks[0]!.facebook_page).toBe("https://www.facebook.com/example");
    expect(foodbanks[0]!.contact_email).toBe("info@bedford.foodbank.org.uk");
    expect(foodbanks[0]!.phone_number).toBe("01722 349556");
    expect(foodbanks[0]!.latest_need_id).toBe(12345);
  });

  // coerceBooleans, wired through LOCATION_BOOLEAN_COLUMNS. D1 returns 0/1/NULL
  // and every consumer downstream -- packages/serialise, the templates -- tests
  // these as booleans, where the integer 0 is falsy but the STRING "0" and the
  // number 1 are not. is_donation_point and is_mobile are NULLABLE in
  // production despite the model declaring them NOT NULL (0001_core.sql:73),
  // and NULL must survive as null rather than collapsing to false: "we do not
  // know" is not "no".
  it("coerces the four location boolean columns and preserves their NULLs", async () => {
    seedFoodbank({ id: 10, name: "Bedford Foodbank", slug: "bedford", constituencyId: MID_BEDS_ID });
    seedLocation({
      id: 20,
      foodbankId: 10,
      name: "Ampthill Centre",
      slug: "ampthill-centre",
      constituencyId: MID_BEDS_ID,
      isClosed: 0,
      isDonationPoint: 1,
      isMobile: null,
      placeHasPhoto: null,
    });

    const { locations } = await getFoodbanksForConstituency(session, MID_BEDS_ID);

    expect(locations[0]!.is_closed).toBe(false);
    expect(locations[0]!.is_donation_point).toBe(true);
    expect(locations[0]!.is_mobile).toBeNull();
    expect(locations[0]!.place_has_photo).toBeNull();
  });

  // The same for the food-bank half, through mapFoodbankRow. `is_school` is
  // the nullable one here.
  it("coerces the foodbank boolean columns and preserves is_school's NULL", async () => {
    seedFoodbank({ id: 10, name: "Bedford Foodbank", slug: "bedford", constituencyId: MID_BEDS_ID, charityJustFoodbank: 1, isSchool: null });

    const { foodbanks } = await getFoodbanksForConstituency(session, MID_BEDS_ID);

    expect(foodbanks[0]!.is_closed).toBe(false);
    expect(foodbanks[0]!.charity_just_foodbank).toBe(true);
    expect(foodbanks[0]!.address_is_administrative).toBe(false);
    expect(foodbanks[0]!.is_school).toBeNull();
  });

  // NEITHER SUB-LIST IS SORTED, and that is deliberate -- Django's
  // foodbanks() concatenates two unsorted querysets in this order, and frozen
  // bug B3 depends on the caller being able to tell them apart. Seeded so that
  // insertion order is not name order: an ORDER BY name quietly added to
  // either statement changes the /write/ page's list and the API's
  // containsPlace order, and would pass any test that only checked membership.
  it("returns both lists in table order, sorting neither", async () => {
    seedFoodbank({ id: 10, name: "Sandy Foodbank", slug: "sandy", constituencyId: MID_BEDS_ID });
    seedFoodbank({ id: 11, name: "Ampthill Foodbank", slug: "ampthill", constituencyId: MID_BEDS_ID });
    seedLocation({ id: 20, foodbankId: 10, name: "Woburn Centre", slug: "woburn-centre", constituencyId: MID_BEDS_ID });
    seedLocation({ id: 21, foodbankId: 10, name: "Arlesey Centre", slug: "arlesey-centre", constituencyId: MID_BEDS_ID });

    const { foodbanks, locations } = await getFoodbanksForConstituency(session, MID_BEDS_ID);

    expect(foodbanks.map((f) => f.name)).toEqual(["Sandy Foodbank", "Ampthill Foodbank"]);
    expect(locations.map((l) => l.name)).toEqual(["Woburn Centre", "Arlesey Centre"]);
  });

  // An empty constituency must come back as two empty arrays, not as a
  // throw and not as one array standing in for both -- routes/write/index.ts
  // destructures the result unconditionally and iterates each list.
  it("returns two empty arrays for a constituency with nothing in it", async () => {
    const result = await getFoodbanksForConstituency(session, MID_BEDS_ID);

    expect(result).toEqual({ foodbanks: [], locations: [] });
  });

  // THE NULL TRAP AGAIN, the one getConstituencySlugByPcon24cd carries on the
  // other side of the file. `parliamentary_constituency_id = ?` bound with
  // NULL is `NULL = NULL` -- UNKNOWN, never true -- so the rows that have no
  // constituency stay invisible, which is the right answer and is what the
  // exclusion cases above assume without ever proving. Both columns are
  // genuinely nullable (a food bank or location awaiting geocoding has none),
  // and rewriting either predicate to `IS ?`, the reflexive move when a
  // nullable column is compared, would tip every unassigned row in the country
  // onto whatever page asked with a null id. No caller can pass null today --
  // wfbnConstituency passes constituency.id, a NOT NULL primary key -- so this
  // pins a latent difference rather than a live bug, and it is the only case
  // in this file that kills the `IS ?` rewrite of either statement.
  it("matches nothing for a NULL constituency id, not even the rows that have none", async () => {
    seedFoodbank({ id: 13, name: "Unplaced Foodbank", slug: "unplaced", constituencyId: null });
    seedLocation({ id: 23, foodbankId: 13, name: "Unplaced Centre", slug: "unplaced-centre", constituencyId: null });

    const result = await getFoodbanksForConstituency(session, null as unknown as number);

    expect(result).toEqual({ foodbanks: [], locations: [] });
  });

  it("returns two empty arrays for a constituency id that does not exist", async () => {
    seedFoodbank({ id: 10, name: "Bedford Foodbank", slug: "bedford", constituencyId: MID_BEDS_ID });
    seedLocation({ id: 20, foodbankId: 10, name: "Ampthill Centre", slug: "ampthill-centre", constituencyId: MID_BEDS_ID });

    expect(await getFoodbanksForConstituency(session, 9999)).toEqual({ foodbanks: [], locations: [] });
  });
});
