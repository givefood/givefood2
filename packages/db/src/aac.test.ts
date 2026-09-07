import { describe, expect, it } from "vitest";
// @ts-ignore -- node:sqlite has no types under this package's tsconfig
// (`"types": ["@cloudflare/workers-types"]`, and @types/node is not a
// dependency here), so a plain import fails `pnpm typecheck` for everyone --
// see foodbankAdmin.test.ts's header, which is why that file settled for a
// hand-written fake instead. This module cannot: everything in aac.ts is a
// range scan, an FTS5 MATCH, a generated column and an ORDER BY, none of
// which a JavaScript fake can be trusted to reproduce. The suppression buys a
// real engine at the cost of `DatabaseSync` being `any`, which the local
// SqliteDatabase interface below immediately narrows again.
import { DatabaseSync } from "node:sqlite";
import { searchAddressAutocomplete, searchAddressAutocompleteNext } from "./aac";
import type { AacResult } from "./aac";
import type { Session } from "./types";

// /aac/ -- givefood/views.py:1522-1580 address_autocomplete(), PLAN.md
// §4.8.6/§4.8.7. Two exported functions, and BOTH are pure SQL: a range scan
// standing in for Postgres's `LIKE 'X%'`, an FTS5 trigram MATCH standing in
// for `gin_trgm_ops`, a generated column standing in for a stored one, and
// three ORDER BY clauses standing in for `population DESC NULLS LAST`.
//
// EVERY FAILURE MODE HERE IS SILENT. A wrong upper bound on the range returns
// fewer places, not an error. A dropped `NOT LIKE` returns each place twice. A
// missing `population IS NULL` puts every unpopulated hamlet above London. An
// unquoted FTS5 phrase throws only for the queries that contain an apostrophe
// or a hyphen -- "King's Lynn", "Bishop's Stortford", "Llanfair-yn-neubwll" --
// which is to say for real traffic and never in a smoke test. Nothing about
// any of that shows up as a 500, so the only way to catch it is to run the
// SQL. Hence a real in-memory SQLite seeded from migrations/0009_aac.sql
// verbatim, not a session that hands back canned rows: a canned row proves
// only that mapPlaceRow() renames three fields.
//
// The fixtures deliberately seed rows that MUST BE ABSENT from each result --
// the place one character past the range's upper bound, the postcode in the
// next range, the prefix hit the substring pass has to suppress. A filter that
// filtered nothing would pass every test that only seeded matching rows.
//
// MUTATION-TESTED (TESTING.md's convention), twice: once while it was written
// and once adversarially afterwards, 99 mutants in all, each applied to a copy
// of aac.ts in a scratchpad with this file left untouched. `<` to `<=` at both
// range bounds, the FTS join turned into a cross join and into a LEFT JOIN,
// ftsPhrase() reduced to the identity, the `NOT LIKE` de-duplication deleted
// and inverted, every one of the six constants nudged both ways, every ORDER
// BY deleted and reversed, every LIMIT deleted, every bind pair swapped, each
// query reduced to its first row, `Array.from` swapped for `split("")`, the
// trim and the toUpperCase() removed, places and codes swapped in both
// concatenations. 111 mutants, 101 caught.
//
// THE SECOND ROUND FOUND TEN REAL HOLES, all now closed, each named in the
// comment of the test that closes it:
//
//   * the substring pass's own ORDER BY was entirely unpinned -- every
//     substring fixture happened to seed its rows in the order it expected
//     back, so deleting that clause changed nothing;
//   * so was its LIMIT: cutting it from ten to nine is invisible unless the
//     prefix pass returns nothing at all;
//   * nothing searched for a place with a SPACE in the query, so handing the
//     prefix pass the space-stripped POSTCODE form -- which breaks every
//     multi-word search on the site -- went unnoticed in both functions;
//   * nextCharsAfter() was never given OVERLAPPING occurrences, nor an
//     occurrence at the very end of a name;
//   * neither were the other two bucket loops given a query that runs to the
//     end of the value, so all three `if (nextChar)` guards could be deleted
//     and the response gained a bucket called "undefined";
//   * searchAddressAutocompleteNext() never proved it SKIPS the FTS round trip
//     below three characters, nor that it reads postcodes to DEEP_LIMIT rather
//     than to the ten-row POSTCODE_LIMIT.
//
// TEN SURVIVE, every one of them because it cannot be observed through the
// two exported functions, not because nothing looked. They are recorded here
// so the next reader knows the gap is understood rather than missed, and each
// is also named at the test that would otherwise be assumed to cover it:
//
//   * DELETING `population IS NULL` from either ORDER BY -- SQLite already
//     sorts NULL lowest, so DESC puts it last regardless. Kept because
//     PLAN.md §4.8.6 chose it as the portable spelling of Postgres's
//     `NULLS LAST`, where it is load-bearing.
//   * DELETING `ORDER BY pcn` -- the range is answered from postcode_pcn_idx,
//     which already walks in that order. Kept because that is a planner
//     choice, not a guarantee D1 owes us. (Reversing it to DESC *is* caught.)
//   * `JOIN place` to `LEFT JOIN place`, and reading the `NOT LIKE` off the
//     FTS copy (`f.name_upper`) instead of the place row. Both are invisible
//     for an external-content FTS5 table: `f.name_upper` reads through to
//     `place`, and an index entry orphaned from its row is dropped by the
//     `NOT LIKE` anyway, since `NULL NOT LIKE 'X%'` is NULL. Executed against
//     this engine with a deliberately orphaned rowid, not assumed.
//   * `f.name_upper MATCH` to `place_fts MATCH` -- identical on a one-column
//     FTS5 table.
//   * Dropping `.slice(0, POSTCODE_LIMIT)` from the combined response, and
//     dropping addToBucket()'s per-bucket `length < NEXT_BUCKET_LIMIT` guard.
//     Both are belt-and-braces: the SQL LIMIT and the final `merged.slice()`
//     respectively already impose the same bound.
//   * Emitting empty buckets (`if (merged.length)`) -- addToBucket() only ever
//     creates a bucket by putting a row in it, so no bucket is ever empty.
//   * Binding PLACE_LIMIT where POSTCODE_LIMIT is meant, which is unobservable
//     for the dull reason that both constants are 10. Listed rather than
//     quietly dropped, because it stops being equivalent the day one moves.

// Verbatim from packages/db/migrations/0009_aac.sql (columns, index names and
// the FTS5 options all copied, not paraphrased). The point of using the real
// DDL is that it is the thing the TypeScript might disagree with: `postcode`
// being GENERATED rather than stored, `name_upper` being pre-computed rather
// than something D1 could `upper()` for itself, and place_fts being an
// EXTERNAL-CONTENT table whose rows come from `place` and not from its own
// storage are three facts a hand-built fixture would quietly get wrong.
const SCHEMA = `
CREATE TABLE place (
  id INTEGER PRIMARY KEY, gbpnid INTEGER NOT NULL,
  name TEXT,
  name_upper TEXT,
  lat_lng TEXT, county TEXT, county_slug TEXT NOT NULL,
  name_slug TEXT NOT NULL, population INTEGER
);
CREATE UNIQUE INDEX place_gbpnid_uniq   ON place(gbpnid);
CREATE INDEX place_name_upper_idx       ON place(name_upper);
CREATE VIRTUAL TABLE place_fts USING fts5(
  name_upper, content='place', content_rowid='id', tokenize='trigram');

CREATE TABLE postcode (
  id INTEGER PRIMARY KEY,
  pcn TEXT NOT NULL,
  postcode TEXT GENERATED ALWAYS AS
      (substr(pcn, 1, length(pcn) - 3) || ' ' || substr(pcn, -3)) VIRTUAL,
  lat_lng TEXT NOT NULL, county TEXT
);
CREATE INDEX postcode_pcn_idx ON postcode(pcn);
`;

interface SqliteStatement {
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): void;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

interface Recorded {
  sql: string;
  params: unknown[];
}

// The D1 Sessions API surface aac.ts actually uses, over node:sqlite. Same
// adapter as workers/site/src/routes/admin/foodbankLocation.test.ts, kept
// deliberately thin: it must not interpret the SQL, only carry it to a real
// engine, or these tests would be asserting against a second implementation
// of the thing under test.
//
// `calls` exists for the guard cases. "Returns [] for a 41-character query"
// is a weaker claim than "returns [] WITHOUT ISSUING A QUERY", and the guard
// exists for the second one: D1 caps LIKE/GLOB patterns at 50 bytes
// (PLAN.md §4.8.6) and /aac/ is an uncredentialed, CORS-open endpoint taking
// arbitrary `?q=`, so the long query must never reach the database at all.
function d1Session(db: SqliteDatabase): { session: Session; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const statement = (sql: string, params: unknown[]) => ({
    bind: (...next: unknown[]) => {
      calls.push({ sql, params: next });
      return statement(sql, next);
    },
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return {
    session: { prepare: (sql: string) => statement(sql, []), getBookmark: () => null } as unknown as Session,
    calls,
  };
}

interface PlaceSeed {
  name: string;
  population?: number | null;
  county?: string | null;
  latLng?: string | null;
}

interface PostcodeSeed {
  pcn: string;
  county?: string | null;
  latLng?: string;
}

// `name_upper` is computed here in JavaScript for the same reason production
// computes it in Postgres at export time and 0009_aac.sql spells out on the
// column: SQLite's own upper() is ASCII-only, so a fixture that let D1 derive
// this column would silently mis-case every Welsh and Gaelic name in the
// table. JS toUpperCase() is full-Unicode, like Postgres's.
//
// place_fts is content='place' with no triggers in the migration, so it is
// populated exactly the way tools/pg-to-d1/extract_core.py:582 populates it
// in production -- `INSERT INTO place_fts(place_fts) VALUES('rebuild')`. That
// matters: it means the index under test is derived from the seeded rows
// rather than hand-written, so a fixture cannot accidentally teach the FTS
// table something the `place` table does not say.
function seedPlaces(db: SqliteDatabase, seeds: PlaceSeed[]): void {
  const insert = db.prepare(
    "INSERT INTO place (id, gbpnid, name, name_upper, lat_lng, county, county_slug, name_slug, population) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  seeds.forEach((seed, index) => {
    insert.run(
      index + 1,
      1000 + index,
      seed.name,
      seed.name.toUpperCase(),
      seed.latLng === undefined ? "51.5,-0.1" : seed.latLng,
      seed.county === undefined ? "Greater London" : seed.county,
      "county-slug",
      `name-slug-${index}`,
      seed.population === undefined ? null : seed.population,
    );
  });
  db.exec("INSERT INTO place_fts(place_fts) VALUES('rebuild')");
}

function seedPostcodes(db: SqliteDatabase, seeds: PostcodeSeed[]): void {
  const insert = db.prepare("INSERT INTO postcode (id, pcn, lat_lng, county) VALUES (?, ?, ?, ?)");
  seeds.forEach((seed, index) => {
    insert.run(index + 1, seed.pcn, seed.latLng ?? "51.50,-0.14", seed.county === undefined ? "Greater London" : seed.county);
  });
}

function fixture(places: PlaceSeed[] = [], postcodes: PostcodeSeed[] = []): { session: Session; calls: Recorded[] } {
  const db = new DatabaseSync(":memory:") as SqliteDatabase;
  db.exec(SCHEMA);
  seedPlaces(db, places);
  seedPostcodes(db, postcodes);
  return d1Session(db);
}

const names = (rows: AacResult[]): string[] => rows.map((row) => row.n);
const types = (rows: AacResult[]): string[] => rows.map((row) => row.t);

// ============================ searchAddressAutocomplete ====================

describe("searchAddressAutocomplete -- the query guards", () => {
  // views.py:1533-1535: `if not query or len(query) < 2: return []`. The port
  // keeps the empty array rather than a 400 because the response shape is
  // contract (PLAN.md §4.8.6) and the client renders whatever array it gets.
  it("returns [] below two characters, without touching D1", async () => {
    const { session, calls } = fixture([{ name: "Aberdeen", population: 100 }]);

    expect(await searchAddressAutocomplete(session, "")).toEqual([]);
    expect(await searchAddressAutocomplete(session, "a")).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  // The trim runs BEFORE the length test, same as views.py's
  // `request.GET.get("q", "").strip()`. A single typed character surrounded by
  // the spaces a mobile keyboard adds must still be too short, and a padded
  // real query must still be searched -- on the trimmed form, or the range
  // scan looks for names beginning with a space.
  it("trims first, then measures", async () => {
    const { session } = fixture([{ name: "Aberdeen", population: 100 }]);

    expect(await searchAddressAutocomplete(session, "   a   ")).toEqual([]);
    expect(names(await searchAddressAutocomplete(session, "  aberdeen  "))).toEqual(["Aberdeen"]);
  });

  // PLAN.md §4.8.6's 50-byte D1 LIKE/GLOB cap. Django has no upper bound at
  // all -- this limit is a deliberate divergence, and the boundary is
  // inclusive at 40. Three statements at 40 characters (prefix, substring,
  // postcode); none at 41.
  it("accepts exactly 40 characters and refuses 41 before reaching D1", async () => {
    const { session, calls } = fixture();

    expect(await searchAddressAutocomplete(session, "A".repeat(40))).toEqual([]);
    expect(calls).toHaveLength(3);

    calls.length = 0;
    expect(await searchAddressAutocomplete(session, "A".repeat(41))).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  // SUSPECT, pinned as-is. The 40 is counted in UTF-16 code units, but the cap
  // it stands in for is 50 BYTES of LIKE pattern. A 40-character accented
  // query is accepted and hands the substring pass an 81-byte `NOT LIKE`
  // pattern -- over the documented D1 limit. Recorded rather than fixed
  // because the limit is a real D1 behaviour this suite cannot exercise
  // (node:sqlite has no such cap), so "fixing" it here would be asserting a
  // guess. Reported in suspectedBugs.
  it("counts the 40-character limit in UTF-16 units, not the bytes the cap is about", async () => {
    const { session, calls } = fixture();

    await searchAddressAutocomplete(session, "É".repeat(40));

    const notLike = calls.find((call) => call.sql.includes("NOT LIKE"))?.params[1] as string;
    expect(notLike).toBe(`${"É".repeat(40)}%`);
    expect(new TextEncoder().encode(notLike).length).toBe(81);
  });

  // `query.length` is UTF-16 units throughout, which cuts both ways for a
  // single astral character: it clears the two-character MINIMUM on its own
  // (two units), and it simultaneously fails the three-character test that
  // gates the FTS pass. So exactly two statements are issued, not three.
  // Pinned because an `Array.from(query).length` tidy-up -- which is the
  // obviously "more correct" spelling, and matches what incrementLastChar()
  // already does -- would silently make this query return nothing at all.
  it("counts a single astral character as two, clearing the minimum but not the FTS gate", async () => {
    const { session, calls } = fixture();

    await searchAddressAutocomplete(session, "\u{1F3FF}");

    expect(calls).toHaveLength(2);
    expect(calls.filter((call) => call.sql.includes("place_fts"))).toHaveLength(0);
  });
});

describe("searchAddressAutocomplete -- the place prefix pass", () => {
  // The range scan replacing Postgres's `LIKE 'HACKNEY%'`: `name_upper >=
  // 'HACKNEY' AND name_upper < 'HACKNEZ'`. Three rows exist only to be
  // excluded, one per way the bounds can rot:
  //
  //   * "Hacknez" is not a place -- it is the literal value of the exclusive
  //     upper bound, seeded so that relaxing `<` to `<=` fails here. Without
  //     it the `<=` mutant survives: "Hacknez Town" sorts ABOVE "HACKNEZ" and
  //     is excluded either way, so a fixture with only that row proves
  //     nothing about which comparison is used.
  //   * "Hacknez Town" catches a dropped or widened upper bound (unbounded,
  //     the query returns the whole table from H onwards in population order,
  //     which looks plausible enough to ship).
  //   * "Hackne" is one character short of the lower bound.
  //
  // All three are seeded with an implausibly large population so that any of
  // them leaking in lands at the TOP of the list, not somewhere a
  // `toHaveLength` check would miss.
  it("scans the half-open range and excludes both boundaries", async () => {
    const { session } = fixture([
      { name: "Hacknez", population: 9_000_000 },
      { name: "Hacknez Town", population: 9_000_000 },
      { name: "Hackne", population: 9_000_000 },
      { name: "Hackney", population: 280_000 },
      { name: "Hackney Wick", population: 12_000 },
      { name: "Islington", population: 240_000 },
    ]);

    expect(names(await searchAddressAutocomplete(session, "hackney"))).toEqual(["Hackney", "Hackney Wick"]);
  });

  // views.py:1536 upper-cases the query before matching, and `name_upper` is
  // the pre-computed upper-case column, so the search is case-insensitive in
  // both directions. Without the toUpperCase() the range scan looks for
  // lower-case names and returns nothing at all -- an empty autocomplete for
  // every user who does not type in capitals.
  it("matches regardless of the case typed", async () => {
    const { session } = fixture([{ name: "Hackney", population: 280_000 }]);

    for (const typed of ["hackney", "HACKNEY", "HaCkNeY"]) {
      expect(names(await searchAddressAutocomplete(session, typed))).toEqual(["Hackney"]);
    }
  });

  // THE PLACE PASSES SEARCH THE QUERY AS TYPED; ONLY THE POSTCODE PASS SEES
  // THE SPACE-STRIPPED FORM. searchAddressAutocomplete() computes both
  // `upperQuery` and `normalizedPostcode` from the same input, hands the first
  // to the two place queries and the second to the postcode query, and the two
  // are the same string for every single-word query -- which was every place
  // query in this file until this test existed. Handing `normalizedPostcode`
  // to searchPlacePrefix() therefore survived the whole suite while breaking
  // every multi-word search on the site: "weston super" would look for names
  // beginning "WESTONSUPER" and find nothing at all.
  //
  // "Westonsuper Village" is seeded as the mutant's answer, so the two
  // spellings cannot both be right: it is the row the space-stripped range
  // returns and the correct range must exclude (' ' is 0x20 and sorts below
  // 'S', so it falls outside "WESTON SUPER".."WESTON SUPES").
  it("prefix-matches on the query as typed, interior spaces and all", async () => {
    const { session } = fixture([
      { name: "Weston super Mare", population: 82_000 },
      { name: "Westonsuper Village", population: 400 },
    ]);

    expect(names(await searchAddressAutocomplete(session, "weston super"))).toEqual(["Weston super Mare"]);
  });

  // `ORDER BY population IS NULL, population DESC, name ASC` is the portable
  // spelling of Postgres's `population DESC NULLS LAST, name ASC`
  // (views.py:1493). The seeds are shaped so each clause fails separately:
  //
  //   * `population IS NULL` reversed to `IS NOT NULL` puts Salford first.
  //     Note what this test canNOT show: SQLite already sorts NULL as the
  //     smallest value, so under `DESC` the NULLs land last with or without
  //     that first term, and DELETING it changes nothing on this engine. It
  //     is carried because PLAN.md §4.8.6 chose the portable spelling over
  //     `NULLS LAST`, not because SQLite needs it -- so this test pins the
  //     resulting ORDER, which is what the client sees, rather than the
  //     presence of a clause that is a no-op here and load-bearing on
  //     Postgres.
  //   * flip DESC to ASC and the smallest town in the country leads.
  //   * drop `name ASC` and the two equal-population rows come back in rowid
  //     order, which is insertion order -- invisible in a fixture seeded in
  //     the expected order, so Sale and Salcombe are seeded BACKWARDS.
  it("orders by population descending with NULLs last, tie-broken by name", async () => {
    const { session } = fixture([
      { name: "Sale", population: 5000 },
      { name: "Salcombe", population: 5000 },
      { name: "Salford", population: null },
      { name: "Sandwich", population: 4000 },
      { name: "Sheffield", population: 580_000 },
    ]);

    // Sheffield is the most populous row in the table and must NOT appear --
    // it is outside the range, and a broken range scan would put it first.
    // "Sale" before "Salcombe" would mean the name tie-break was dropped;
    // "Salford" anywhere but last would mean the NULLS-LAST clause was.
    expect(names(await searchAddressAutocomplete(session, "sa"))).toEqual([
      "Salcombe",
      "Sale",
      "Sandwich",
      "Salford",
    ]);
  });

  it("puts the higher population first across the whole matched set", async () => {
    const { session } = fixture([
      { name: "Newport Pagnell", population: 15_000 },
      { name: "Newport", population: 300_000 },
      { name: "Newport-on-Tay", population: null },
      { name: "Newbury", population: 32_000 },
    ]);

    expect(names(await searchAddressAutocomplete(session, "newport"))).toEqual([
      "Newport",
      "Newport Pagnell",
      "Newport-on-Tay",
    ]);
  });

  // SQLite's default text collation is byte-wise -- every upper-case letter
  // sorts before every lower-case one -- where the source Postgres sorts under
  // en_US.utf8. packages/db/src/types.ts documents this at length and provides
  // sortByName() to work around it; the /aac/ queries deliberately do NOT use
  // it, sorting in SQL instead. That divergence is real and is pinned here
  // rather than wished away, because if someone later routes these results
  // through sortByName() this is the test that tells them the order changed.
  it("tie-breaks on name with SQLite's byte-wise collation, not a locale one", async () => {
    const { session } = fixture([
      { name: "Ely Bridge", population: 5000 },
      { name: "ELY Common", population: 5000 },
    ]);

    // Both rows match (the range scan runs on `name_upper`), both have the
    // same population, so the whole answer is the `name ASC` tie-break -- and
    // it runs on the ORIGINAL-CASE name under BINARY collation, where every
    // capital sorts before every lower-case letter: 'L' (0x4C) < 'l' (0x6C).
    const rows = names(await searchAddressAutocomplete(session, "ely"));
    expect(rows).toEqual(["ELY Common", "Ely Bridge"]);

    // The same two names under the en-US collator sortByName() uses
    // (packages/db/src/types.ts) come out the other way round. Asserted so
    // that anyone who later routes these rows through sortByName() "for
    // consistency" is told by this test that they changed the response.
    expect([...rows].sort(new Intl.Collator("en-US").compare)).toEqual(["Ely Bridge", "ELY Common"]);
  });

  // PLACE_LIMIT. Eleven matches, ten slots: the eleventh by the ORDER BY --
  // the smallest -- is the one that must be missing. Asserting only
  // `toHaveLength(10)` would pass with the LIMIT applied to an unordered scan,
  // which is the version that drops London.
  it("returns at most ten places, dropping the least populated", async () => {
    const { session } = fixture(
      Array.from({ length: 11 }, (_, index) => ({ name: `Bolton ${index}`, population: (index + 1) * 100 })),
    );

    const rows = await searchAddressAutocomplete(session, "bolton");
    expect(rows).toHaveLength(10);
    expect(names(rows)).not.toContain("Bolton 0");
    expect(names(rows)[0]).toBe("Bolton 10");
  });

  // incrementLastChar() is documented as working on CODE POINTS, not UTF-16
  // code units, "so it increments the whole trailing character even when that
  // character is outside the BMP". That claim is executed here, not trusted:
  // U+1F3FF's upper bound must be U+1F400. The naive
  // `s.slice(0, -1) + fromCharCode(charCodeAt(last) + 1)` produces a lone
  // high surrogate followed by U+E000, which was run against this engine and
  // returns NOTHING -- so a search that starts with an emoji silently returns
  // an empty list under the mutant while every ASCII test stays green.
  it("increments the upper bound by code point, not UTF-16 code unit", async () => {
    const { session } = fixture([
      { name: "\u{1F3FF} Village", population: 30 },
      { name: "\u{1F400} Village", population: 40 },
    ]);

    expect(names(await searchAddressAutocomplete(session, "\u{1F3FF}"))).toEqual(["\u{1F3FF} Village"]);
  });

  // The increment walks off the end of the alphabet: 'Z' (0x5A) becomes '['
  // (0x5B), which is not a letter but is still the correct exclusive bound
  // because nothing sorts between them. "A[ Town" is seeded precisely because
  // it sits ON that bound and must be excluded -- proof the bound is exclusive
  // rather than merely "past the letters".
  it("handles a query ending at the top of the alphabet", async () => {
    const { session } = fixture([
      { name: "az Town", population: 10 },
      { name: "A[ Town", population: 99 },
    ]);

    expect(names(await searchAddressAutocomplete(session, "az"))).toEqual(["az Town"]);
  });
});

describe("searchAddressAutocomplete -- the place substring pass", () => {
  // views.py:1552-1560 and aac.ts's own comment: below three characters there
  // is nothing for the trigram tokenizer to match on. At two characters the
  // substring pass must not run AT ALL -- not merely return nothing -- because
  // FTS5's trigram tokenizer cannot answer a two-character phrase and the
  // fallback would be a full scan of 253,584 rows on the hottest endpoint on
  // the site.
  it("does not run below three characters", async () => {
    const { session, calls } = fixture([{ name: "New Ely", population: 20_000 }]);

    expect(names(await searchAddressAutocomplete(session, "el"))).toEqual([]);
    expect(calls.filter((call) => call.sql.includes("place_fts"))).toHaveLength(0);
  });

  it("runs at exactly three characters", async () => {
    const { session } = fixture([{ name: "New Ely", population: 20_000 }]);

    expect(names(await searchAddressAutocomplete(session, "ely"))).toEqual(["New Ely"]);
  });

  // PLAN.md §4.8.6(c) / issue C3, the whole reason ftsPhrase() exists. Bound
  // parameters do not escape FTS5 QUERY-EXPRESSION syntax, so an unquoted
  // `KING'S` raises `fts5: syntax error near "'"` and an unquoted `-YN-`
  // raises `no such column: YN`. Both were run against this engine to confirm
  // those are still the exact errors. They are ordinary UK place-name
  // substrings -- King's Lynn, Llanfair-yn-neubwll -- so the failure mode is a
  // 500 on real traffic and a green smoke test, which is why this is asserted
  // as returned ROWS and not merely "does not throw".
  it("survives an apostrophe, which is an FTS5 syntax error unquoted", async () => {
    const { session } = fixture([
      { name: "King's Lynn", population: 46_000 },
      { name: "New King's Lynn", population: 900 },
    ]);

    expect(names(await searchAddressAutocomplete(session, "king's"))).toEqual(["King's Lynn", "New King's Lynn"]);
  });

  it("survives a leading hyphen, which reads as a column reference unquoted", async () => {
    const { session } = fixture([{ name: "Llanfair-yn-neubwll", population: 300 }]);

    // The prefix pass cannot match this at all -- the query is mid-name -- so
    // the row can only have arrived through the FTS5 pass.
    expect(names(await searchAddressAutocomplete(session, "-yn-"))).toEqual(["Llanfair-yn-neubwll"]);
  });

  // The `"` doubling inside ftsPhrase(). This is the one case a naive
  // "just wrap it in quotes" fix gets wrong AND that a "pass it through raw"
  // implementation appears to survive: `"ANCHOR"` is itself already valid
  // FTS5, so the raw version runs happily and matches the wrong thing --
  // "New Anchor Bay", which does not contain the quote characters the user
  // typed. Seeded here specifically so that mutant fails.
  it("doubles an internal double quote so the phrase matches literally", async () => {
    const { session } = fixture([
      { name: 'Ye Olde "Anchor" Green', population: 10 },
      { name: "New Anchor Bay", population: 20_000 },
    ]);

    expect(names(await searchAddressAutocomplete(session, '"anchor"'))).toEqual(['Ye Olde "Anchor" Green']);
  });

  // THE SUBSTRING PASS HAS ITS OWN ORDER BY -- `p.population IS NULL,
  // p.population DESC, p.name ASC` -- and it is a separate statement from the
  // prefix pass's, so the prefix-pass ordering tests above say nothing about
  // it. Every other substring fixture in this file seeds its rows in the order
  // it expects back, which means FTS docid order (insertion order) and
  // population order coincide and DELETING THE WHOLE ORDER BY passes; that
  // mutant survived until this test, as did dropping just `p.name ASC`.
  //
  // So the seeds here are deliberately hostile to insertion order: the least
  // populous row is inserted first, and the two equal-population rows are
  // inserted with their names backwards. Nothing seeded begins with "ELY", so
  // the prefix pass contributes nothing and the order below is entirely this
  // query's own.
  it("orders substring hits by population then name, not by insertion order", async () => {
    const { session } = fixture([
      { name: "New Ely Bottom", population: 100 },
      { name: "New Ely Zed", population: 5000 },
      { name: "New Ely Alpha", population: 5000 },
      { name: "New Ely Nowhere", population: null },
    ]);

    expect(names(await searchAddressAutocomplete(session, "ely"))).toEqual([
      "New Ely Alpha",
      "New Ely Zed",
      "New Ely Bottom",
      "New Ely Nowhere",
    ]);
  });

  // `AND p.name_upper NOT LIKE ?2` is the two passes' de-duplication. Drop it
  // and "Hackney" comes back twice -- once from the prefix pass, once from the
  // substring pass -- eating two of the ten slots with the same row. Django
  // does the same exclusion at views.py:1557 with an explicit NOT LIKE.
  it("suppresses the prefix pass's own hits so no place appears twice", async () => {
    const { session } = fixture([
      { name: "Hackney", population: 280_000 },
      { name: "New Hackney", population: 500 },
    ]);

    const rows = await searchAddressAutocomplete(session, "hackney");
    expect(names(rows)).toEqual(["Hackney", "New Hackney"]);
    expect(new Set(names(rows)).size).toBe(rows.length);
  });

  // JOIN cardinality. `place_fts f JOIN place p ON p.id = f.rowid` is one FTS5
  // document per place row, so a name containing the query twice is ONE result
  // row, not two. A join written the other way round, or on a non-unique key,
  // duplicates it -- and the duplicate would consume a slot in a
  // ten-row response.
  it("returns a place containing the query twice exactly once", async () => {
    const { session } = fixture([{ name: "New Weston super Weston", population: 76_000 }]);

    expect(names(await searchAddressAutocomplete(session, "weston"))).toEqual(["New Weston super Weston"]);
  });

  // Concatenation order and the combined cap: `[...prefixRows,
  // ...substringRows].slice(0, PLACE_LIMIT)`. Prefix hits always come first
  // and substring hits only fill what is left, matching views.py:1555's
  // `10 - len(results)`. The port passes the FULL limit of 10 to both queries
  // and truncates afterwards rather than computing the remainder in SQL; the
  // observable result must be identical, which is what this asserts. Six of
  // each seeded, so the seventh substring row is the one that must be cut.
  it("puts prefix hits first and fills the remaining slots with substring hits", async () => {
    const { session } = fixture([
      ...Array.from({ length: 6 }, (_, index) => ({ name: `Ely ${index}`, population: 6000 - index })),
      ...Array.from({ length: 6 }, (_, index) => ({ name: `New Ely ${index}`, population: 900 - index })),
    ]);

    const rows = await searchAddressAutocomplete(session, "ely");
    expect(names(rows)).toEqual([
      "Ely 0",
      "Ely 1",
      "Ely 2",
      "Ely 3",
      "Ely 4",
      "Ely 5",
      "New Ely 0",
      "New Ely 1",
      "New Ely 2",
      "New Ely 3",
    ]);
  });

  // ...and the other half of that claim: the substring query is given the FULL
  // limit of ten, not the four slots the previous test happens to leave it. It
  // only shows when the prefix pass returns NOTHING, which is the ordinary case
  // for a query typed into the middle of a name, so the previous test cannot
  // see it: cutting the substring LIMIT to nine keeps every assertion there
  // green (four slots are still four slots) and quietly returns nine places
  // instead of ten for "ely". Eleven seeded, ten expected, in population order.
  it("fills all ten place slots from the substring pass when nothing prefix-matches", async () => {
    const { session } = fixture(
      Array.from({ length: 11 }, (_, index) => ({ name: `New Ely ${index}`, population: 1000 - index })),
    );

    expect(names(await searchAddressAutocomplete(session, "ely"))).toEqual(
      Array.from({ length: 10 }, (_, index) => `New Ely ${index}`),
    );
  });

  // SUSPECT, pinned as-is. aac.ts's comment on incrementLastChar() says
  // "both place and postcode prefix matching use this same range-scan shape,
  // not LIKE, so neither needs _like_escape()" -- but the substring pass DOES
  // still use LIKE, in its exclusion clause, with the raw query interpolated
  // as `${upperQuery}%`. `_` and `%` in the typed query are therefore live
  // wildcards there, and over-exclude: "Abca_c" matches `A_C%` (A, any, C,
  // rest) even though it does not begin with the literal "a_c", so a
  // legitimate substring hit is dropped. Django escapes both characters at
  // views.py:1475-1477 and returns it. Asserted as the port behaves, not as
  // Django behaves; reported in suspectedBugs.
  it("treats LIKE wildcards in the query as wildcards in the exclusion clause", async () => {
    const { session } = fixture([
      { name: "Xa_c", population: 8 },
      { name: "Abca_c", population: 7 },
    ]);

    // Django's _like_escape() would have returned both of these.
    expect(names(await searchAddressAutocomplete(session, "a_c"))).toEqual(["Xa_c"]);
  });
});

describe("searchAddressAutocomplete -- postcodes", () => {
  // §4.8.7: `postcode` is not stored, it is reconstructed by a GENERATED
  // column from the normalised form. The response's `n` is therefore the
  // spaced postcode a human recognises even though every index and every
  // comparison uses the unspaced one. Reading `pcn` instead would put
  // "SW1A1AA" in the dropdown, and any fixture that hand-wrote a `postcode`
  // value would have hidden that.
  it("returns the spaced postcode rebuilt by the generated column", async () => {
    const { session } = fixture([], [{ pcn: "SW1A1AA" }, { pcn: "E11AA" }]);

    expect(names(await searchAddressAutocomplete(session, "sw1a1aa"))).toEqual(["SW1A 1AA"]);
    expect(names(await searchAddressAutocomplete(session, "e11aa"))).toEqual(["E1 1AA"]);
  });

  // views.py:1568: `query.upper().replace(" ", "")` against
  // `postcode_normalized`. The user types the space; the index does not have
  // one. All four spellings must find the same row.
  it("normalises spaces and case out of the typed postcode", async () => {
    const { session } = fixture([], [{ pcn: "SW1A1AA" }]);

    for (const typed of ["SW1A 1AA", "sw1a1aa", "sw1a 1aa", " SW1A1AA "]) {
      expect(names(await searchAddressAutocomplete(session, typed))).toEqual(["SW1A 1AA"]);
    }
  });

  // Same half-open range scan as places, and the same boundary risk. "SW1B0AA"
  // is seeded on the exclusive upper bound of the "SW1A" query ('SW1A' ->
  // 'SW1B') and must be absent from it, while "SE11AA" sits below the lower
  // bound. Widening to "SW1" ('SW1' -> 'SW2') must then pull BOTH the SW19 and
  // the SW1B rows in -- a range scan is byte order, not "starts with these
  // letters", and SW19 sorts before SW1A because '9' < 'A'. The pair of
  // assertions is the point: one bound moving would break exactly one of them.
  it("scans the half-open pcn range, excluding the row on the upper bound", async () => {
    const { session } = fixture(
      [],
      [
        { pcn: "SW1B0AA" },
        { pcn: "SW1A2AA" },
        { pcn: "SW1A1AB" },
        { pcn: "SW1A1AA" },
        { pcn: "SW190AA" },
        { pcn: "SE11AA" },
      ],
    );

    expect(names(await searchAddressAutocomplete(session, "sw1a"))).toEqual([
      "SW1A 1AA",
      "SW1A 1AB",
      "SW1A 2AA",
    ]);
    expect(names(await searchAddressAutocomplete(session, "sw1"))).toEqual([
      "SW19 0AA",
      "SW1A 1AA",
      "SW1A 1AB",
      "SW1A 2AA",
      "SW1B 0AA",
    ]);

    // The `<=`-instead-of-`<` mutant, which nothing above catches: for a query
    // that is already a COMPLETE postcode the exclusive upper bound is itself
    // a real postcode ("SW1A1AA" -> "SW1A1AB"), and it is seeded. Typing a
    // full postcode must return that postcode, not it and its neighbour.
    expect(names(await searchAddressAutocomplete(session, "SW1A 1AA"))).toEqual(["SW1A 1AA"]);
  });

  // `ORDER BY pcn` -- there is no population to rank by, so this is the only
  // ordering there is, and it is what makes the ten-row limit deterministic
  // rather than "whatever the scan reached first". Seeded in reverse so
  // insertion order cannot fake the result.
  //
  // Honest limit, since it would be easy to read more into this than is
  // there: on SQLite the range predicate is answered from postcode_pcn_idx,
  // which already walks in pcn order, so DELETING the ORDER BY changes
  // nothing here and this test cannot prove the clause is present. It pins
  // the order the client depends on, and it does catch a reversal to DESC --
  // which is the mutation that would actually change what a user sees.
  it("orders postcodes by their normalised form, ascending", async () => {
    const { session } = fixture([], [{ pcn: "N19DX" }, { pcn: "N11AA" }, { pcn: "N15ZZ" }]);

    expect(names(await searchAddressAutocomplete(session, "n1"))).toEqual(["N1 1AA", "N1 5ZZ", "N1 9DX"]);
  });

  it("returns at most ten postcodes, keeping the ten lowest by pcn", async () => {
    const { session } = fixture(
      [],
      Array.from({ length: 11 }, (_, index) => ({ pcn: `N1${index}AA` })),
    );

    const rows = await searchAddressAutocomplete(session, "n1");
    expect(rows).toHaveLength(10);
    // pcn is TEXT and the ORDER BY is text order, not numeric: "N110AA" sorts
    // between "N10AA" and "N11AA" ('0' < 'A'), so the eleventh and dropped row
    // is the "9", not the "10". Both ends asserted, because a LIMIT applied to
    // an unordered scan would keep ten arbitrary rows and still be ten long.
    expect(names(rows)[0]).toBe("N1 0AA");
    expect(names(rows)).not.toContain("N1 9AA");
  });

  it("passes a NULL county through as null rather than inventing one", async () => {
    const { session } = fixture([], [{ pcn: "SW1A1AA", county: null }]);

    expect(await searchAddressAutocomplete(session, "sw1a1aa")).toEqual([
      { n: "SW1A 1AA", l: "51.50,-0.14", t: "c", c: null },
    ]);
  });
});

describe("searchAddressAutocomplete -- the combined response", () => {
  // The frozen response contract (PLAN.md §4.8.6): a bare array of exactly
  // four terse keys, "p"laces before "c"odes. The client keys its rendering
  // off `t`, so a swapped marker labels every postcode as a place.
  it("emits exactly the four contract keys, places before codes", async () => {
    const { session } = fixture([{ name: "Ely", population: 20_000, county: "Cambridgeshire", latLng: "52.4,0.26" }], [
      { pcn: "EL11AA", latLng: "52.0,0.0", county: "Cambridgeshire" },
    ]);

    expect(await searchAddressAutocomplete(session, "el")).toEqual([
      { n: "Ely", l: "52.4,0.26", t: "p", c: "Cambridgeshire" },
      { n: "EL1 1AA", l: "52.0,0.0", t: "c", c: "Cambridgeshire" },
    ]);
  });

  // THE PARITY CLAIM aac.ts's long comment makes, executed. Django runs the
  // postcode query under `if len(results) < 20` with a limit of
  // `min(10, 20 - len(results))`; the port drops both guards on the grounds
  // that places can never exceed 10, so the condition is always true and the
  // limit is always 10. With the place half FULL -- the only case where a
  // surviving guard could differ -- the answer must still be ten places
  // followed by ten postcodes. If the reasoning were wrong this is where it
  // would show, as a response that quietly stopped carrying postcodes for
  // common prefixes.
  it("still returns ten postcodes when the ten place slots are already full", async () => {
    const { session } = fixture(
      Array.from({ length: 11 }, (_, index) => ({ name: `Nn${index} Town`, population: 100 + index })),
      Array.from({ length: 11 }, (_, index) => ({ pcn: `NN${index}1AA` })),
    );

    const rows = await searchAddressAutocomplete(session, "nn");
    expect(rows).toHaveLength(20);
    expect(types(rows)).toEqual([...Array<string>(10).fill("p"), ...Array<string>(10).fill("c")]);
  });

  it("returns postcodes alone when nothing matches on the place side", async () => {
    const { session } = fixture([{ name: "Ely", population: 20_000 }], [{ pcn: "SW1A1AA" }]);

    expect(names(await searchAddressAutocomplete(session, "sw1a"))).toEqual(["SW1A 1AA"]);
  });

  it("returns places alone when nothing matches on the postcode side", async () => {
    const { session } = fixture([{ name: "Ely", population: 20_000 }], [{ pcn: "SW1A1AA" }]);

    expect(names(await searchAddressAutocomplete(session, "ely"))).toEqual(["Ely"]);
  });

  it("returns an empty array, not a null or an error, when nothing matches", async () => {
    const { session } = fixture([{ name: "Ely", population: 20_000 }], [{ pcn: "SW1A1AA" }]);

    expect(await searchAddressAutocomplete(session, "zzzz")).toEqual([]);
  });

  it("passes a NULL lat_lng and county through untouched", async () => {
    const { session } = fixture([{ name: "Nowhere", population: null, county: null, latLng: null }]);

    expect(await searchAddressAutocomplete(session, "nowhere")).toEqual([{ n: "Nowhere", l: null, t: "p", c: null }]);
  });
});

// ========================= searchAddressAutocompleteNext ===================
//
// Ticket #8's speculative buckets. This half has no Django ancestor and no
// user-visible failure -- a wrong bucket is silently replaced by the real
// response a moment later -- which is exactly why it needs tests: nothing
// downstream will ever complain about it.

describe("searchAddressAutocompleteNext -- the query guards", () => {
  // Note the different empty value from searchAddressAutocomplete: `{}`, not
  // `[]`. The route JSON-encodes this directly, and `[]` would be a different
  // response body for the client to look keys up on.
  it("returns an empty OBJECT, not an array, outside the length window", async () => {
    const { session, calls } = fixture([{ name: "Ely", population: 20_000 }]);

    expect(await searchAddressAutocompleteNext(session, "e")).toEqual({});
    expect(await searchAddressAutocompleteNext(session, "A".repeat(41))).toEqual({});
    expect(calls).toHaveLength(0);
  });
});

describe("searchAddressAutocompleteNext -- bucketing", () => {
  // The core of the feature: results for "EL" bucketed by the character that
  // would follow it, so the next keystroke renders from memory. Keys are the
  // UPPER-CASED next character even though the values carry the original
  // mixed-case name, because the client looks the bucket up with what the user
  // typed. Lower-casing that key would make every bucket a miss.
  it("buckets prefix matches under the upper-cased next character", async () => {
    const { session } = fixture([
      { name: "Ely", population: 20_000 },
      { name: "Elgin", population: 9000 },
      { name: "Elstree", population: 5000 },
    ]);

    const next = await searchAddressAutocompleteNext(session, "el");
    expect(Object.keys(next).sort()).toEqual(["G", "S", "Y"]);
    expect(names(next.Y ?? [])).toEqual(["Ely"]);
    expect(names(next.G ?? [])).toEqual(["Elgin"]);
    expect(names(next.S ?? [])).toEqual(["Elstree"]);
  });

  it("keeps the bucketed rows in the same population order as the real response", async () => {
    const { session } = fixture([
      { name: "Elyard", population: 100 },
      { name: "Elystan", population: 900 },
      { name: "Elyot", population: null },
    ]);

    expect(names((await searchAddressAutocompleteNext(session, "el")).Y ?? [])).toEqual([
      "Elystan",
      "Elyard",
      "Elyot",
    ]);
  });

  // nextCharsAfter() collects EVERY continuation, not just the first, because
  // the substring pass matched the name for all of them. "New Elyot super
  // Elystan" is a hit for "ely" whether the user goes on to type "o" or "s",
  // so it must appear in both buckets -- one row object, two keys. Taking only
  // the first occurrence would leave the "S" bucket empty and the client
  // waiting for the round trip this feature exists to avoid.
  //
  // Three characters, not two: below that the substring pass does not run at
  // all, so a two-character query here would have tested nothing (it is its
  // own documented gap, covered further down).
  it("puts a substring match in a bucket for every continuation in the name", async () => {
    const { session } = fixture([{ name: "New Elyot super Elystan", population: 1000 }]);

    const next = await searchAddressAutocompleteNext(session, "ely");
    expect(Object.keys(next).sort()).toEqual(["O", "S"]);
    expect(names(next.O ?? [])).toEqual(["New Elyot super Elystan"]);
    expect(names(next.S ?? [])).toEqual(["New Elyot super Elystan"]);
  });

  // ...and the occurrences may OVERLAP, which the test above does not show:
  // "New Elyot super Elystan" contains "ELY" twice, but four characters apart.
  // nextCharsAfter() advances by ONE character after each hit (`from = at + 1`)
  // precisely so a name containing the prefix at overlapping positions is
  // still bucketed under both continuations; advancing by `prefix.length`
  // instead -- the obvious "don't rescan what you matched" tidy-up, and a
  // mutant that survived every other test here -- finds only the first.
  //
  // "NEW ABABAZ" holds "ABA" at offsets 4 and 6, continuing 'B' and 'Z', so
  // the two spellings give visibly different answers: {B, Z} against {B}.
  it("finds overlapping occurrences of the prefix, not just disjoint ones", async () => {
    const { session } = fixture([{ name: "New Ababaz", population: 1000 }]);

    const next = await searchAddressAutocompleteNext(session, "aba");
    expect(Object.keys(next).sort()).toEqual(["B", "Z"]);
    expect(names(next.Z ?? [])).toEqual(["New Ababaz"]);
  });

  // The other half of the same loop: when two occurrences share a
  // continuation, addToBucket()'s `!bucket.includes(row)` must collapse them.
  // Without it "New Elyot super Elyot" fills two of the eight slots in the "O"
  // bucket with the same row, and the client draws it twice.
  it("de-duplicates a row whose occurrences share a continuation", async () => {
    const { session } = fixture([{ name: "New Elyot super Elyot", population: 1000 }]);

    expect(names((await searchAddressAutocompleteNext(session, "ely")).O ?? [])).toEqual([
      "New Elyot super Elyot",
    ]);
  });

  // ALL THREE BUCKET LOOPS GUARD ON `if (nextChar)`, and the guard is the only
  // thing standing between the client and a bucket literally called
  // "undefined": indexing past the end of a string gives undefined, a Map
  // keyed on undefined stringifies to "undefined" when the record is
  // JSON-encoded, and the bucket would hold the row the user has just finished
  // typing in full. Three separate mutants -- one per loop -- all survived
  // until this test, because every other fixture here seeds names strictly
  // longer than the query.
  //
  // One test, three end-of-string cases: "Ely" is a PREFIX hit whose name ends
  // exactly at the query, "New Ely" is a SUBSTRING hit whose occurrence ends at
  // the name's end (so nextCharsAfter() must return nothing rather than a hole
  // in an array), and "EL1 1AA" is a POSTCODE typed out in full. Each query
  // must produce no keys at all -- not a key with an empty bucket, and
  // certainly not "undefined".
  it("creates no bucket when the query reaches the end of a name or a postcode", async () => {
    const { session } = fixture(
      [
        { name: "Ely", population: 20_000 },
        { name: "New Ely", population: 500 },
      ],
      [{ pcn: "EL11AA" }],
    );

    expect(Object.keys(await searchAddressAutocompleteNext(session, "ely"))).toEqual([]);
    expect(Object.keys(await searchAddressAutocompleteNext(session, "el11aa"))).toEqual([]);
  });

  // NEXT_BUCKET_LIMIT. The whole justification for splitting this into its own
  // request is that the payload stays bounded (~10 KB); an unbounded bucket
  // for a common prefix would put the entire H-section of the gazetteer on the
  // wire. Nine seeded, eight kept, and the one dropped is the least populated.
  it("caps each bucket at eight rows, keeping the most populated", async () => {
    const { session } = fixture(
      Array.from({ length: 9 }, (_, index) => ({ name: `Elz ${index}`, population: (index + 1) * 10 })),
    );

    const bucket = (await searchAddressAutocompleteNext(session, "el")).Z ?? [];
    expect(bucket).toHaveLength(8);
    expect(names(bucket)).not.toContain("Elz 0");
  });

  // MAX_NEXT_BUCKETS. addToBucket() stops CREATING keys at forty but keeps
  // filling the ones it has, so the cap is on distinct next-characters, not on
  // rows. Forty-five continuations seeded; the five with the lowest population
  // -- the ones the ORDER BY reaches last -- are the ones with no bucket.
  //
  // Worth knowing and not asserted here: the cap is applied to the place map
  // and the postcode map SEPARATELY, so the merged response can carry more
  // than forty keys. It is left untested because it cannot be reached with a
  // realistic fixture -- postcodes only ever contribute letters and digits,
  // and forty distinct place continuations already cover all thirty-six of
  // those -- so every extra postcode key merges into an existing bucket
  // rather than creating a forty-first.
  it("stops creating new place buckets after forty distinct next characters", async () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-'./ ()&+,";
    const chars = Array.from(alphabet).slice(0, 45);
    expect(chars).toHaveLength(45);
    const { session } = fixture(
      chars.map((char, index) => ({ name: `AA${char}`, population: 1000 - index })),
    );

    const next = await searchAddressAutocompleteNext(session, "aa");
    expect(Object.keys(next)).toHaveLength(40);
    // The first forty by population got in; the tail did not.
    expect(next[chars[0] as string]).toBeDefined();
    expect(next[chars[39] as string]).toBeDefined();
    expect(next[chars[40] as string]).toBeUndefined();
    expect(next[chars[44] as string]).toBeUndefined();
  });
});

describe("searchAddressAutocompleteNext -- postcode buckets", () => {
  // Postcode bucket keys come off the SPACE-STRIPPED postcode, so "SW" +
  // "SW1A1AA" gives "1". Reading the character out of the spaced display form
  // instead would bucket half the country's postcodes under " ".
  it("buckets postcodes on the unspaced form the index is built on", async () => {
    const { session } = fixture([], [{ pcn: "SW1A1AA" }, { pcn: "SW2B2BB" }]);

    const next = await searchAddressAutocompleteNext(session, "sw");
    expect(Object.keys(next).sort()).toEqual(["1", "2"]);
    expect(names(next["1"] ?? [])).toEqual(["SW1A 1AA"]);
  });

  // The postcode half of the deep read is DEEP_LIMIT rows, not the ten the
  // real response returns -- the whole premise of this function is one deeper
  // read instead of one query per candidate character, so a postcode pass
  // capped at POSTCODE_LIMIT would leave the client able to answer only the
  // first ten postcodes' worth of next keystrokes. That mutant (passing
  // POSTCODE_LIMIT where DEEP_LIMIT belongs) survived every other test here,
  // because none seeded more than eleven postcodes.
  //
  // Twenty continuations, one per seeded postcode, ordered A..T by pcn: under
  // the ten-row limit only A..J would have buckets, so the assertion is on the
  // whole key set rather than on its size.
  it("reads postcodes to the deep limit, not to the ten-row response limit", async () => {
    const letters = Array.from("ABCDEFGHIJKLMNOPQRST");
    const { session } = fixture(
      [],
      letters.map((letter) => ({ pcn: `N1${letter}1AA` })),
    );

    expect(Object.keys(await searchAddressAutocompleteNext(session, "n1")).sort()).toEqual(letters);
  });

  // The documented deliberate omission: when the typed query contains a space,
  // the character following the prefix in the UNSPACED index is not the
  // character the user will type next, so guessing would be worse than not
  // answering. Places still bucket normally -- only the postcode half is
  // dropped -- which is what makes this a narrow omission rather than a
  // switched-off feature.
  //
  // The space has to be INTERIOR. `rawQuery.trim()` removes a trailing one
  // before the comparison ever happens, so "SW1A " and "SW1A" are the same
  // query and a test written with a trailing space would assert nothing.
  it("omits postcode buckets entirely once the query contains a space", async () => {
    const seed = () =>
      fixture([{ name: "Sw1a 1Green", population: 10 }], [{ pcn: "SW1A1AA" }, { pcn: "SW1A1BB" }]).session;

    // "SW1A 1" != "SW1A1", so the postcode half is skipped and only the place
    // bucket survives.
    expect(Object.keys(await searchAddressAutocompleteNext(seed(), "sw1a 1"))).toEqual(["G"]);

    // The same two postcodes, reached by the spelling with no space: their
    // buckets are back, keyed on the character after "SW1A1".
    expect(Object.keys(await searchAddressAutocompleteNext(seed(), "sw1a1")).sort()).toEqual(["A", "B"]);
  });

  // Same ordering contract as the real response, applied inside each bucket:
  // places, then codes.
  it("puts places before codes inside a shared bucket", async () => {
    const { session } = fixture([{ name: "Sw1 Green", population: 10 }], [{ pcn: "SW11AA" }]);

    expect(await searchAddressAutocompleteNext(session, "sw")).toEqual({
      "1": [
        { n: "Sw1 Green", l: "51.5,-0.1", t: "p", c: "Greater London" },
        { n: "SW1 1AA", l: "51.50,-0.14", t: "c", c: "Greater London" },
      ],
    });
  });

  // The two maps are capped independently at eight and then merged and sliced
  // to eight again, so a bucket already full of places carries no postcodes at
  // all. Pinned because it is a real, non-obvious consequence of the merge
  // order -- someone widening NEXT_BUCKET_LIMIT would change what the client
  // can answer offline for a postcode prefix, and this is the test that says
  // so.
  it("squeezes postcodes out of a bucket that eight places have already filled", async () => {
    const { session } = fixture(
      Array.from({ length: 8 }, (_, index) => ({ name: `Sw1 Town ${index}`, population: 100 + index })),
      [{ pcn: "SW11AA" }],
    );

    const bucket = (await searchAddressAutocompleteNext(session, "sw"))["1"] ?? [];
    expect(bucket).toHaveLength(8);
    expect(types(bucket)).toEqual(Array<string>(8).fill("p"));
  });
});

describe("searchAddressAutocompleteNext -- the two documented gaps", () => {
  // Gap 1, from aac.ts's header: at a two-character prefix the substring pass
  // has not run, so those buckets carry prefix and postcode matches only. This
  // is asserted rather than left implicit because it looks exactly like a bug
  // from the client side -- "New Ely" is a legitimate result for "ely" and
  // simply is not in the "Y" bucket at "el" -- and the reason it is acceptable
  // (the client always issues the real request too) lives in a comment that a
  // future reader may not find.
  it("carries no substring matches at a two-character prefix, and issues no FTS query", async () => {
    const { session, calls } = fixture([
      { name: "Ely", population: 20_000 },
      { name: "New Elyot", population: 500 },
    ]);

    // At "el" only the prefix pass has run, so "New Elyot" -- a perfectly good
    // "ely" result -- is in no bucket at all.
    const twoChars = await searchAddressAutocompleteNext(session, "el");
    expect(Object.keys(twoChars)).toEqual(["Y"]);
    expect(names(twoChars.Y ?? [])).toEqual(["Ely"]);

    // And the gate is a SKIPPED ROUND TRIP, not a filter. This is the only
    // assertion that can say so, which is why it is here rather than left to
    // the buckets above: FTS5's trigram tokenizer answers a two-character
    // phrase with zero rows and no error (run against this engine to check),
    // so relaxing this function's `query.length >= 3` to `>= 2` returns byte
    // for byte the same response while adding a query to the hottest endpoint
    // on the site. searchAddressAutocomplete has the same assertion for the
    // same reason -- it is 253,584 rows of table scan on the real database if
    // the planner ever declines the index.
    expect(calls.filter((call) => call.sql.includes("place_fts"))).toHaveLength(0);

    // One character later the same row DOES arrive, through the FTS pass.
    // That is what makes the absence above the documented two-character rule
    // rather than a fixture that simply never matched anything.
    expect(names((await searchAddressAutocompleteNext(session, "ely")).O ?? [])).toEqual(["New Elyot"]);
  });

  // Gap 2: DEEP_LIMIT. A bucket whose rows all sat beyond the 400-row read is
  // empty rather than wrong. Both sides of the boundary are exercised, because
  // "the cutoff exists" and "the cutoff is at 400" are different claims and
  // only the second one pins the constant: at 399 filler rows the odd one out
  // is inside the read and gets a bucket; at 400 it is not and does not.
  it("drops buckets whose only rows sat beyond the 400-row deep read", async () => {
    const seedWithFiller = (fillerCount: number) =>
      fixture([
        ...Array.from({ length: fillerCount }, (_, index) => ({ name: `AAB${index}`, population: 10_000 - index })),
        { name: "AAZ Oddity", population: 1 },
      ]).session;

    const justInside = await searchAddressAutocompleteNext(seedWithFiller(399), "aa");
    expect(Object.keys(justInside).sort()).toEqual(["B", "Z"]);

    const justOutside = await searchAddressAutocompleteNext(seedWithFiller(400), "aa");
    expect(Object.keys(justOutside)).toEqual(["B"]);
  });
});
