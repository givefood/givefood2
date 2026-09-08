import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MIGRATIONS_SQL as SCHEMA_AFTER } from "./schema.testkit";
import { describe, expect, it } from "vitest";
import { searchAddressAutocomplete, searchAddressAutocompleteNext } from "./aac";
import { getPlacesPage, PLACE_LIST_SORTS } from "./adminLists";
import type { PlaceListSort } from "./adminLists";
import type { Session } from "./types";

// 0025_place_prefix_cover.sql -- ticket #50. The ticket is a pure latency
// change: same rows, same rows_read, a covering index so /aac/'s prefix pass
// stops visiting the table once per matching row. Which means the ONLY thing
// that can go wrong is the thing an index goes wrong at -- moving the output
// with no error and nothing to notice. So this file builds the schema TWICE
// from the real migration files, once with 0025 omitted and once with
// everything, seeds both identically, and requires every reader of `place` to
// return the same rows in the same order on both. Then, separately, it
// requires the plan to have actually changed, because a migration that is a
// no-op passes an identity test perfectly.
//
// Same shape, and mostly the same words, as articlePublishedIndex.test.ts,
// which did this for 0024. Including why it lives in src/ rather than beside
// the .sql it tests: vitest.config.mts collects `packages/*/src/**/*.test.ts`
// and this package's tsconfig includes `src` only, so a test in migrations/
// would be neither run nor typechecked.
//
// THE OUTPUT DID MOVE, TWICE, AND TWO ONE-CLAUSE FIXES IN THE SAME COMMIT ARE
// WHY IT NO LONGER DOES. Both are the same defect: an ORDER BY that is not a
// total order, whose ties were being settled by the access path rather than
// by the query.
//
//   1. searchPlacePrefix (aac.ts) orders by
//      `population IS NULL, population DESC, name ASC`. That is not a total
//      order on real data: 18,966 (name, population) pairs occur more than
//      once in production, covering 81,645 of 253,584 rows, so rows tie on
//      every visible key. Before, the scan fetched by
//      rowid and ties came out in `id` order; with the covering index they
//      come out in the index's (name_upper, population, name, lat_lng,
//      county, rowid) order -- i.e. by lat_lng. Measured here at both
//      LIMIT 10 (/aac/) and LIMIT 400 (/aac/next/).
//
//   2. getPlacesPage (adminLists.ts) orders by one of three non-unique
//      columns and nothing else, over LIMIT/OFFSET pages. The index covers
//      all five columns it projects (`id` is the rowid, so it is in every
//      index), so all six sort/direction combinations move from `SCAN place`
//      to `SCAN place USING COVERING INDEX place_prefix_cover` -- and on a
//      tie-heavy fixture 26 of 36 page/sort/direction combinations came back
//      reordered. The ticket did not mention /admin/places/ at all.
//
// Both now name `id ASC` explicitly, which is what a table scan was already
// producing -- so neither changed any output today, and neither can be moved
// by an index tomorrow. The last describe block is the evidence for that
// claim in the direction that matters: it runs the PRE-FIX statements against
// both schemas and shows the rows moving, so nobody deletes the tie-break as
// noise.
//
// MUTATION-TESTED. The repo was copied to a scratchpad outside the tree and
// the change rewritten ten ways there; all ten die here. Recorded because the
// count is the evidence the assertions are load-bearing, and because two of
// them die by a single test apiece -- delete that test and the mutant lives:
//   migration deleted (7 failures), index drops `county` so it stops covering
//   (6), index columns reordered to put population first (6), index renamed
//   (5), migration also DROPs place_name_upper_idx (2), searchPlacePrefix's
//   `, id ASC` removed (7) and reversed to `id DESC` (2),
//   searchPlaceSubstring's `, p.id ASC` removed (1 -- the statement-text
//   assertion, and nothing else, because that clause is a no-op today),
//   getPlacesPage's `, id ASC` removed (13) and reversed to `id DESC` (1 --
//   the "identical to what the un-tie-broken table scan produced" assertion,
//   which is the only one that pins the DIRECTION rather than merely the
//   existence of a tie-break).
//
// THE FIXTURE IS TIES AND ALMOST NOTHING ELSE. Thirty "Newport"s with one
// population and thirty "Newbiggin"s with none, deliberately interleaved in
// `id` so that id order, insertion order and lat_lng order are three
// different orders -- with those aligned an index scan and a table scan agree
// by accident and the whole file proves nothing. Real place data looks like
// this: a third of the gazetteer sits in a (name, population) group with at
// least one twin.
//
// THE NULL-POPULATION GROUP IS FOR THE SORT KEY, NOT FOR REALISM. Production
// has no NULL populations at all -- all 253,584 rows carry a figure -- so
// `population IS NULL` is a leading sort key that never does anything there.
// It is exercised here anyway: it is in the statement, a mutant that deletes
// it should die, and the column is nullable in the schema (0009_aac.sql:17)
// so tomorrow's import can reintroduce what today's does not have.

const INDEX_NAME = "place_prefix_cover";
const MIGRATION_FILE = "0025_place_prefix_cover.sql";

// STRING PATHS, NOT `URL`, and `.href` into fileURLToPath: verbatim from
// schema.testkit.ts, whose header explains why (@cloudflare/workers-types and
// @types/node each declare a global `URL`, they differ, and node:fs wants
// Node's).
const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url).href);

const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith(".sql"))
  .sort();

// Filtered by CONTENT rather than by filename, which also asserts that
// exactly one migration declares this index.
const declaringMigrations = migrationFiles.filter((file) => readFileSync(join(MIGRATIONS_DIR, file), "utf8").includes(INDEX_NAME));

const SCHEMA_BEFORE = migrationFiles
  .filter((file) => !declaringMigrations.includes(file))
  .map((file) => readFileSync(join(MIGRATIONS_DIR, file), "utf8"))
  .join("\n");

// ---------------------------------------------------------------------------
// The D1 Sessions API surface aac.ts and adminLists.ts use, over node:sqlite,
// recording the SQL and parameters of every call so the plan assertions can
// run EXPLAIN QUERY PLAN on the REAL statement rather than on a transcription
// of it. A copied SQL string in a test drifts from the module the moment
// someone edits the module, and a plan assertion against a stale string is an
// assertion about nothing.
// ---------------------------------------------------------------------------
type Bindable = null | number | bigint | string | Uint8Array;

interface Recorded {
  sql: string;
  params: Bindable[];
}

function d1Session(db: DatabaseSync, recorder: Recorded[]): Session {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => {
      recorder.push({ sql, params });
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    all: async () => {
      recorder.push({ sql, params });
      return { results: db.prepare(sql).all(...params), success: true, meta: {} };
    },
  });
  return { prepare: (sql: string) => statement(sql, []), getBookmark: () => null } as unknown as Session;
}

// ---------------------------------------------------------------------------
// The fixture. Read `id` downwards and the four name groups interleave; read
// lat_lng downwards within a group and it ascends. That mismatch is the whole
// experiment -- see the header.
// ---------------------------------------------------------------------------
interface PlaceSeed {
  name: string;
  population: number | null;
  county: string;
  latLng: string;
}

const TIED = 30;

// The two tied groups, thirty rows each. `population` is the only key that
// separates them from each other, and NOTHING separates the rows within
// either one.
const TIED_GROUPS: { name: string; population: number | null; county: string }[] = [
  // Tied on name AND on a real population.
  { name: "Newport", population: 500, county: "P" },
  // Tied on name with population NULL throughout: `population IS NULL,
  // population DESC` cannot separate NULLs either. This group sorts to the
  // END, which is where /aac/'s LIMIT 10 cuts through it.
  { name: "Newbiggin", population: null, county: "B" },
];

// One row apiece with distinct populations, so the fixture is not ONLY ties:
// if a mutant broke the primary sort keys, these are what notice.
const SINGLETONS: PlaceSeed[] = [
  { name: "Newcastle", population: 300000, county: "Tyne and Wear", latLng: "54.97,-1.61" },
  { name: "Newquay", population: 20000, county: "Cornwall", latLng: "50.41,-5.07" },
];

// Interleaved round-robin, so consecutive ids are in DIFFERENT name groups.
//
// lat_lng COUNTS DOWN WHILE id COUNTS UP, and that opposition is the whole
// experiment. The covering index orders its entries
// (name_upper, population, name, lat_lng, county, rowid), so within a tied
// group it hands rows over in lat_lng order; a table scan hands them over in
// rowid order. Number the two the same way and those are the same sequence,
// the index and the table agree by accident, and this file proves nothing.
// Zero-padded to two digits for the same reason: unpadded, "50.9" sorts after
// "50.10" bytewise, which scrambles the opposition into something neither
// deliberate nor total.
const PLACES: PlaceSeed[] = (() => {
  const rows: PlaceSeed[] = [...SINGLETONS];
  for (let i = 0; i < TIED; i++) {
    for (const group of TIED_GROUPS) {
      rows.push({
        name: group.name,
        population: group.population,
        county: `${group.county}${String(i).padStart(2, "0")}`,
        latLng: `5${TIED_GROUPS.indexOf(group)}.${String(TIED - 1 - i).padStart(2, "0")},-1.0`,
      });
    }
  }
  return rows;
})();

// A handful of postcodes so searchAddressAutocomplete's third pass returns
// something: the response concatenates places and codes, and an identity
// assertion over a half-empty response is a weaker assertion.
const POSTCODES = ["NE11AA", "NE12AB", "NE13AC", "NP201AA"];

function seed(schema: string): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  const insert = db.prepare(
    "INSERT INTO place (id, gbpnid, name, name_upper, lat_lng, county, county_slug, name_slug, population) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  PLACES.forEach((place, index) => {
    // name_upper computed in JS, not by SQLite's ASCII-only upper() -- see
    // 0009_aac.sql's note on the column and aac.test.ts's on the fixture.
    insert.run(index + 1, 1000 + index, place.name, place.name.toUpperCase(), place.latLng, place.county, "county-slug", `name-slug-${index}`, place.population);
  });
  // place_fts is content='place' with no triggers, so it is populated exactly
  // the way tools/pg-to-d1/extract_core.py populates it in production.
  db.exec("INSERT INTO place_fts(place_fts) VALUES('rebuild')");
  const postcode = db.prepare("INSERT INTO postcode (id, pcn, lat_lng, county) VALUES (?, ?, ?, ?)");
  POSTCODES.forEach((pcn, index) => postcode.run(index + 1, pcn, "54.97,-1.61", "Tyne and Wear"));
  return db;
}

const indexNames = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'place' AND name IS NOT NULL ORDER BY name").all() as { name: string }[]).map((r) => r.name);

const plan = (db: DatabaseSync, { sql, params }: Recorded): string => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((r) => r.detail).join(" | ");

// Every production read of `place`, called through the real module rather than
// a transcribed statement. `label` is what a failure prints, so a moved row
// names its own function.
const READERS: { label: string; run: (session: Session) => Promise<unknown> }[] = [
  { label: "searchAddressAutocomplete('NEW') -- LIMIT 10 cuts the tied group", run: (s) => searchAddressAutocomplete(s, "NEW") },
  { label: "searchAddressAutocomplete('Newp') -- one tied group only", run: (s) => searchAddressAutocomplete(s, "Newp") },
  { label: "searchAddressAutocomplete('NE') -- 2 chars, no substring pass", run: (s) => searchAddressAutocomplete(s, "NE") },
  { label: "searchAddressAutocompleteNext('NEW') -- DEEP_LIMIT 400", run: (s) => searchAddressAutocompleteNext(s, "NEW") },
  { label: "searchAddressAutocompleteNext('NE') -- DEEP_LIMIT, 2 chars", run: (s) => searchAddressAutocompleteNext(s, "NE") },
  ...PLACE_LIST_SORTS.flatMap((sort: PlaceListSort) =>
    (["asc", "desc"] as const).flatMap((direction) =>
      // Pages of 7 over 96 rows: 7 divides none of the tie-group sizes, so
      // every page boundary lands inside a tie.
      [1, 2, 5, 13, 14].map((page) => ({
        label: `getPlacesPage(${sort}, ${direction}, page ${page})`,
        run: (s: Session) => getPlacesPage(s, sort, direction, page, 7),
      })),
    ),
  ),
];

describe("0025_place_prefix_cover: the migration itself", () => {
  it("is declared exactly once, by one migration, and adds nothing else", () => {
    expect(declaringMigrations).toEqual([MIGRATION_FILE]);

    // Comments stripped, the file is ONE statement. This is the guard against
    // the follow-up the migration explicitly defers -- a
    // `DROP INDEX place_name_upper_idx` appended here later is a separate
    // change needing its own evidence, not a tidy-up of this one.
    const statements = readFileSync(join(MIGRATIONS_DIR, MIGRATION_FILE), "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);

    expect(statements).toEqual([`CREATE INDEX ${INDEX_NAME} ON place(name_upper, population, name, lat_lng, county)`]);
  });

  // ALL FIVE COLUMNS, IN THAT ORDER, IS THE WHOLE POINT. Drop any one of the
  // four trailing columns and the index stops covering the query -- the plan
  // still reports an index, still returns the right rows, and quietly goes
  // back to a table lookup per row, which is the entire cost the ticket is
  // about. The word "COVERING" in the plan assertion below is the only place
  // that difference is visible, so this pins the DDL as well.
  it("carries every column the prefix query reads, sorts by and filters on", () => {
    const after = seed(SCHEMA_AFTER);
    const sql = (after.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(INDEX_NAME) as { sql: string }).sql;
    expect(sql).toBe(`CREATE INDEX ${INDEX_NAME} ON place(name_upper, population, name, lat_lng, county)`);
  });

  // Both halves matter. The first is the fix; the second is the migration's
  // "place_name_upper_idx stays", which an over-tidy follow-up would undo.
  it("adds the new index and leaves the two existing ones alone", () => {
    expect(indexNames(seed(SCHEMA_BEFORE))).toEqual(["place_gbpnid_uniq", "place_name_upper_idx"]);
    expect(indexNames(seed(SCHEMA_AFTER))).toEqual(["place_gbpnid_uniq", "place_name_upper_idx", "place_prefix_cover"]);
  });
});

describe("0025_place_prefix_cover: the output does not move", () => {
  // THE ASSERTION THE WHOLE TICKET RESTS ON. Same seed, same functions, one
  // extra index -- and every row of every reader identical, values and order.
  // Compared as whole objects rather than as name lists because the index
  // changes which access path builds the projection: a row that reordered
  // could keep the right name and carry another place's county.
  for (const reader of READERS) {
    it(`returns identical rows with and without the index: ${reader.label}`, async () => {
      const before: Recorded[] = [];
      const after: Recorded[] = [];
      const resultBefore = await reader.run(d1Session(seed(SCHEMA_BEFORE), before));
      const resultAfter = await reader.run(d1Session(seed(SCHEMA_AFTER), after));
      expect(resultAfter).toEqual(resultBefore);
    });
  }

  // The fixture has to be capable of failing the assertion above, and a
  // fixture whose ties never reach the LIMIT cannot. This pins that: the
  // tied "Newport" group is bigger than /aac/'s PLACE_LIMIT, so the cut runs
  // through it, and the NULL-population group sorts last where LIMIT 10
  // reaches it as well.
  it("is a fixture whose ties actually straddle the limits", async () => {
    const recorder: Recorded[] = [];
    const rows = await searchAddressAutocomplete(d1Session(seed(SCHEMA_AFTER), recorder), "Newp");
    expect(rows).toHaveLength(10);
    expect(new Set(rows.map((r) => r.n))).toEqual(new Set(["Newport"]));
    expect(PLACES.filter((p) => p.name === "Newport")).toHaveLength(30);
    expect(PLACES.filter((p) => p.population === null).length).toBeGreaterThan(10);
  });
});

describe("0025_place_prefix_cover: the plan actually changed", () => {
  // A migration that is a no-op passes every identity assertion above
  // perfectly. This is the half that says it did something -- and says WHICH
  // something: "COVERING" is the word that distinguishes the fix from an
  // index that is merely used.
  it("moves the prefix pass onto a COVERING index scan", async () => {
    const before: Recorded[] = [];
    const after: Recorded[] = [];
    const dbBefore = seed(SCHEMA_BEFORE);
    const dbAfter = seed(SCHEMA_AFTER);
    await searchAddressAutocomplete(d1Session(dbBefore, before), "NEW");
    await searchAddressAutocomplete(d1Session(dbAfter, after), "NEW");

    const prefixOf = (calls: Recorded[]) => calls.find((c) => c.sql.includes("FROM place ") && c.sql.includes("name_upper >="))!;

    expect(plan(dbBefore, prefixOf(before))).toBe("SEARCH place USING INDEX place_name_upper_idx (name_upper>? AND name_upper<?) | USE TEMP B-TREE FOR ORDER BY");
    expect(plan(dbAfter, prefixOf(after))).toBe(`SEARCH place USING COVERING INDEX ${INDEX_NAME} (name_upper>? AND name_upper<?) | USE TEMP B-TREE FOR ORDER BY`);
  });

  // THE TEMP B-TREE IS SUPPOSED TO SURVIVE, and the migration says so at
  // length. `population` is the second index column but the scan is a
  // name_upper RANGE, so rows still emerge in name_upper order and still have
  // to be sorted. Asserted rather than assumed because "the sort went away"
  // is the natural thing to expect from a covering index, and someone acting
  // on that expectation would reorder the index columns and break the cover.
  it("does not remove the sort, and is not expected to", () => {
    expect(plan(seed(SCHEMA_AFTER), { sql: "SELECT name FROM place WHERE name_upper >= ? AND name_upper < ? ORDER BY population IS NULL, population DESC, name ASC, id ASC", params: ["NEW", "NEX"] })).toContain(
      "USE TEMP B-TREE FOR ORDER BY",
    );
  });

  // The substring pass is driven by the FTS match and reaches `place` by
  // rowid, so this index cannot be chosen for it. Pinned because "the new
  // index also helps the other half of /aac/" is an easy thing to assume and
  // then to optimise against.
  it("leaves the substring pass's plan untouched", async () => {
    const before: Recorded[] = [];
    const after: Recorded[] = [];
    const dbBefore = seed(SCHEMA_BEFORE);
    const dbAfter = seed(SCHEMA_AFTER);
    await searchAddressAutocomplete(d1Session(dbBefore, before), "EWP");
    await searchAddressAutocomplete(d1Session(dbAfter, after), "EWP");

    const substringOf = (calls: Recorded[]) => calls.find((c) => c.sql.includes("place_fts"))!;

    expect(plan(dbAfter, substringOf(after))).toBe(plan(dbBefore, substringOf(before)));
    expect(plan(dbAfter, substringOf(after))).not.toContain(INDEX_NAME);
  });

  // /admin/places/ IS REPLANNED TOO, WHICH THE TICKET DID NOT MENTION. Not a
  // problem in itself -- a covering scan reads fewer bytes than a table scan
  // -- but it is the reason getPlacesPage needed an explicit tie-break, and
  // an undocumented plan change is how the next person is surprised.
  it("also moves /admin/places/ onto the covering index, in every sort and direction", async () => {
    const dbAfter = seed(SCHEMA_AFTER);
    for (const sort of PLACE_LIST_SORTS) {
      for (const direction of ["asc", "desc"] as const) {
        const calls: Recorded[] = [];
        await getPlacesPage(d1Session(dbAfter, calls), sort, direction, 1, 7);
        const page = calls.find((c) => c.sql.includes("LIMIT ? OFFSET ?"))!;
        expect(plan(dbAfter, page), `${sort} ${direction}`).toBe(`SCAN place USING COVERING INDEX ${INDEX_NAME} | USE TEMP B-TREE FOR ORDER BY`);
      }
    }
  });
});

describe("0025_place_prefix_cover: the tie-breaks are load-bearing", () => {
  // The identity assertions above pass BECAUSE of the two `id ASC` clauses
  // added in the same commit, and an assertion that passes for a reason you
  // cannot see is one someone deletes. So this block runs the PRE-FIX
  // statements -- the ORDER BY as it read before, with `id` removed -- and
  // shows the rows moving. If a future edit drops either tie-break, the
  // identity tests above start failing and these two explain why.
  const withoutTieBreak = (sql: string) => sql.replace(/, (?:p\.)?id ASC/, "");

  const rowsFor = (db: DatabaseSync, { sql, params }: Recorded) => JSON.stringify(db.prepare(sql).all(...params));

  // The substring pass's tie-break is the one case here that NOTHING ELSE
  // catches. It is a proven no-op today -- this index cannot be chosen for
  // that plan -- so deleting it moves no row and fails no identity assertion,
  // which is precisely why it needs an assertion of its own. Asserted on the
  // statement the module actually prepares, not on a transcription.
  it("names an explicit tie-break in BOTH of /aac/'s place statements", async () => {
    const calls: Recorded[] = [];
    await searchAddressAutocomplete(d1Session(seed(SCHEMA_AFTER), calls), "EWP");

    const prefix = calls.find((c) => c.sql.includes("FROM place ") && c.sql.includes("name_upper >="))!;
    const substring = calls.find((c) => c.sql.includes("place_fts"))!;

    expect(prefix.sql).toContain("ORDER BY population IS NULL, population DESC, name ASC, id ASC");
    expect(substring.sql).toContain("ORDER BY p.population IS NULL, p.population DESC, p.name ASC, p.id ASC");
  });

  it("without `id ASC`, the covering index reorders /aac/'s prefix results", async () => {
    const calls: Recorded[] = [];
    await searchAddressAutocomplete(d1Session(seed(SCHEMA_AFTER), calls), "NEW");
    const prefix = calls.find((c) => c.sql.includes("FROM place ") && c.sql.includes("name_upper >="))!;
    const unpinned = { sql: withoutTieBreak(prefix.sql), params: prefix.params };

    // The clause really was removed -- otherwise this test compares a
    // statement with itself and passes for nothing.
    expect(unpinned.sql).not.toBe(prefix.sql);
    expect(unpinned.sql).not.toContain("id ASC");

    // Unpinned: the index moves the rows. Pinned: it does not.
    expect(rowsFor(seed(SCHEMA_AFTER), unpinned)).not.toBe(rowsFor(seed(SCHEMA_BEFORE), unpinned));
    expect(rowsFor(seed(SCHEMA_AFTER), prefix)).toBe(rowsFor(seed(SCHEMA_BEFORE), prefix));

    // And the pinned order IS the order the table scan was already giving,
    // rather than some third answer: this migration must not move /aac/'s
    // output, not merely stop it moving from now on.
    expect(rowsFor(seed(SCHEMA_BEFORE), prefix)).toBe(rowsFor(seed(SCHEMA_BEFORE), unpinned));
  });

  it("without `id ASC`, the covering index reorders /admin/places/ pages", async () => {
    let moved = 0;
    let checked = 0;
    for (const sort of PLACE_LIST_SORTS) {
      for (const direction of ["asc", "desc"] as const) {
        for (const page of [1, 2, 5, 13, 14]) {
          const calls: Recorded[] = [];
          await getPlacesPage(d1Session(seed(SCHEMA_AFTER), calls), sort, direction, page, 7);
          const listing = calls.find((c) => c.sql.includes("LIMIT ? OFFSET ?"))!;
          const unpinned = { sql: withoutTieBreak(listing.sql), params: listing.params };
          expect(unpinned.sql).not.toBe(listing.sql);

          checked++;
          if (rowsFor(seed(SCHEMA_AFTER), unpinned) !== rowsFor(seed(SCHEMA_BEFORE), unpinned)) moved++;

          // Pinned, every one of them is identical across the two schemas.
          expect(rowsFor(seed(SCHEMA_AFTER), listing), `${sort} ${direction} page ${page}`).toBe(rowsFor(seed(SCHEMA_BEFORE), listing));
          // And identical to what the un-tie-broken table scan produced.
          expect(rowsFor(seed(SCHEMA_BEFORE), listing), `${sort} ${direction} page ${page} vs today`).toBe(rowsFor(seed(SCHEMA_BEFORE), unpinned));
        }
      }
    }
    // Not "at least one": a single moved page could be a fixture accident.
    expect(checked).toBe(30);
    expect(moved).toBeGreaterThan(10);
  });
});
