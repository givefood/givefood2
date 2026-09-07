import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MIGRATIONS_SQL as SCHEMA_AFTER } from "./schema.testkit";
import { describe, expect, it } from "vitest";
import { getArticlesByFoodbankId, getFeaturedArticles, getRecentArticles } from "./homepage";
import { getRecentArticlesForAdmin } from "./adminLists";
import { getArticlesForFoodbankTab } from "./foodbankTabs";
import { getArticlesForNeedEmail } from "./needAdminExtras";
import type { Session } from "./types";

// 0024_article_published_all_idx.sql -- ticket #42. The one thing a schema
// change has to prove is that IT DID NOT MOVE THE OUTPUT, and an index is
// the worst offender for that, because it moves output silently: no error,
// no exception, just a different order arriving at a template. So this file
// builds the schema TWICE from the real migration files -- once with 0024
// omitted, once with everything -- seeds both identically, and requires
// every reader of foodbankarticle to return the SAME ROWS IN THE SAME ORDER
// on both. Then, separately, it requires the plan to have actually changed,
// because a migration that is a no-op passes an identity test perfectly.
//
// WHY THIS FILE IS IN src/ AND NOT NEXT TO THE MIGRATION IT TESTS.
// vitest.config.mts collects `packages/*/src/**/*.test.ts` and this package's
// tsconfig includes `src` only, so a `.test.ts` sat beside the .sql in
// migrations/ would be neither run nor typechecked -- it would look like
// coverage and be nothing. schema.testkit.ts is here for the same reason and
// says so.
//
// SIX FUNCTIONS READ foodbankarticle AND ALL SIX GET A NEW PLAN, not just
// the one the ticket is about. Measured on the fixture below:
//
//   getRecentArticles          SCAN a + temp b-tree  ->  SCAN a USING INDEX
//   getRecentArticlesForAdmin  SCAN a + temp b-tree  ->  SCAN a USING INDEX
//   getArticlesByFoodbankId    SCAN a + temp b-tree  ->  SCAN a USING INDEX
//   getArticlesForFoodbankTab  SCAN + temp b-tree    ->  SCAN USING INDEX
//   getArticlesForNeedEmail    SCAN + temp b-tree    ->  SCAN USING INDEX
//   getFeaturedArticles        article_published_idx ->  UNCHANGED
//
// Only the first of those is in the ticket. The other four plan changes are
// the reason this file tests all six rather than the one: an index nobody
// asked those queries to use is exactly how a "surgical" change becomes an
// incident, and the identity assertions below are the evidence it did not.
//
// THE `DESC` IN THE MIGRATION IS LOAD-BEARING AND ALMOST INVISIBLE. SQLite
// serves `ORDER BY published_date DESC` from an ASC index by scanning it
// backwards, and EXPLAIN QUERY PLAN prints the SAME LINE for both -- so an
// ASC index is indistinguishable from the right one by plan, by row count
// and by timing. It differs only in TIE ORDER: entries in a DESC index are
// ordered (published_date DESC, rowid ASC) and a forward scan hands ties over
// in rowid order, which is what today's temp-b-tree sort already produces; an
// ASC index scanned backwards hands them over reversed. The last describe
// block builds that ASC variant and shows the rows moving, so nobody
// "tidies" the DESC away.
//
// THE FIXTURE IS SHAPED ROUND THE THINGS THAT CAN MOVE, not round a pretty
// list. It carries two groups of tied published_dates -- one wholly inside
// the window, one straddling a LIMIT so the tie decides MEMBERSHIP and not
// merely order -- ids deliberately scrambled so rowid order is not date
// order (with the two aligned, an index scan and a table scan agree by
// accident and the whole file proves nothing), a row with a NULL
// foodbank_id so the INNER/LEFT join split stays visible, and a featured
// mix so the partial index has something to be right about.
//
// Timestamps are the single post-0022 spelling. Production carries no other:
// `SELECT COUNT(*) FROM foodbankarticle WHERE published_date LIKE '%T%'`
// returned 0 on 2026-09-07, because 0022_normalise_timestamps.sql rewrote
// the nine rows that had the ISO form. needAdminExtras.ts's comment about
// two spellings describes the pre-0022 table.
//
// MUTATION-TESTED. The repo was copied to a scratchpad outside the tree and
// the migration rewritten there nine ways; all nine die here. Recorded
// because the count is the evidence the assertions are load-bearing:
//   no index at all (9 failures), ASC instead of DESC (8), indexed on `title`
//   (8), on `id DESC` (8), `COLLATE NOCASE` (8), renamed (9), made partial
//   with `WHERE featured = 1` (9), turned composite on
//   (foodbank_id, published_date DESC) (11), and the ticket's forbidden
//   follow-up -- the right index plus `DROP INDEX article_published_idx` (3).
// Six mutations of homepage.ts's own SQL were run in the same copy; five die
// (ORDER BY reversed, ORDER BY deleted, JOIN widened to LEFT JOIN,
// `featured = 1` flipped to 0, and getArticlesByFoodbankId reordered by id).
// The sixth survives and is meant to -- see the identity test's own comment.
//
// PRODUCTION FIGURES THIS FILE CANNOT ASSERT, recorded so they are not lost
// (measured against the live D1 `givefood`, 2026-09-07):
//   * sqlite_master for foodbankarticle holds exactly article_published_idx
//     and article_url_uniq -- nothing covering the unfiltered ordering.
//   * getRecentArticles at LIMIT 100: rows_read 51,744 (3 x the 17,248-row
//     table), sql_duration 46.2 ms, plan `SCAN a` + `USE TEMP B-TREE FOR
//     ORDER BY`. The same 51,744 at LIMIT 10 and 200 -- the sort must see
//     every row before it knows which ten are newest, so the limit is free
//     of charge and free of benefit.
//   * Ties at the live cut points: exactly one row sits on the 10th, 100th
//     and 200th published_date, so no rendered page's membership changes on
//     the day this lands. One tied PAIR exists inside the top 200, at ranks
//     182/183 -- inside /dashboard/articles/ only, and the DESC index keeps
//     even those two in their current order.

// ---------------------------------------------------------------------------
// The two schemas, both read from packages/db/migrations. The "before" half
// cannot come from schema.testkit.ts -- MIGRATIONS_SQL is deliberately ALL of
// them -- so the directory is read again here and the migration under test
// filtered out by CONTENT rather than by filename, which also asserts that
// exactly one migration declares this index.
//
// STRING PATHS, NOT `URL`, and `.href` into fileURLToPath: verbatim from
// schema.testkit.ts, whose header explains why (@cloudflare/workers-types and
// @types/node each declare a global `URL`, they differ, and node:fs wants
// Node's -- 46 of the 105 typecheck errors that file was extracted to fix
// came from getting this wrong).
// ---------------------------------------------------------------------------
const INDEX_NAME = "article_published_all_idx";
const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url).href);

const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith(".sql"))
  .sort();

const declaringMigrations = migrationFiles.filter((file) => readFileSync(join(MIGRATIONS_DIR, file), "utf8").includes(INDEX_NAME));

const SCHEMA_BEFORE = migrationFiles
  .filter((file) => !declaringMigrations.includes(file))
  .map((file) => readFileSync(join(MIGRATIONS_DIR, file), "utf8"))
  .join("\n");

// ---------------------------------------------------------------------------
// The D1 Sessions API surface these six functions use, over node:sqlite --
// copied from foodbankTabs.test.ts's d1Session, plus one addition: it RECORDS
// the SQL and parameters each call prepares.
//
// That recording is what lets the plan assertions run EXPLAIN QUERY PLAN on
// the REAL statement instead of a transcription of it. A copied SQL string in
// a test drifts from the module the moment someone edits the module, and a
// plan assertion against a stale string is an assertion about nothing.
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

// The fixture. Read the id column downwards and it is scrambled; read
// published_date downwards and it descends. That mismatch is the whole
// experiment -- see the header.
const SALISBURY = 1;
const AMESBURY = 2;
const TROWBRIDGE = 3;

const D = (day: string) => `2026-09-${day} 10:00:00.000000`;

const ARTICLES: { id: number; foodbankId: number | null; publishedDate: string; featured: 0 | 1 }[] = [
  { id: 50, foodbankId: SALISBURY, publishedDate: D("07"), featured: 1 },
  { id: 12, foodbankId: AMESBURY, publishedDate: D("06"), featured: 0 },
  // Tie group A -- three rows on one date, wholly inside every window below.
  { id: 41, foodbankId: SALISBURY, publishedDate: D("05"), featured: 0 },
  { id: 7, foodbankId: TROWBRIDGE, publishedDate: D("05"), featured: 1 },
  { id: 33, foodbankId: AMESBURY, publishedDate: D("05"), featured: 0 },
  { id: 25, foodbankId: SALISBURY, publishedDate: D("04"), featured: 0 },
  // Tie group B -- three rows on one date, straddling LIMIT 8, so which of
  // them survives the cut is decided by the tie-break and not by the dates.
  { id: 60, foodbankId: AMESBURY, publishedDate: D("03"), featured: 0 },
  { id: 3, foodbankId: SALISBURY, publishedDate: D("03"), featured: 0 },
  { id: 18, foodbankId: TROWBRIDGE, publishedDate: D("03"), featured: 1 },
  { id: 44, foodbankId: TROWBRIDGE, publishedDate: D("02"), featured: 0 },
  { id: 9, foodbankId: SALISBURY, publishedDate: D("01"), featured: 0 },
  // foodbank_id IS NULL -- an article whose food bank was deleted. Dropped by
  // getRecentArticles' INNER JOIN, kept by getRecentArticlesForAdmin's LEFT
  // JOIN. If the index change ever flipped one into the other this row is the
  // only thing in the fixture that would notice.
  { id: 71, foodbankId: null, publishedDate: "2026-08-31 10:00:00.000000", featured: 0 },
  { id: 5, foodbankId: AMESBURY, publishedDate: "2026-08-30 10:00:00.000000", featured: 1 },
];

function seed(schema: string, extraDdl?: string): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  if (extraDdl) db.exec(extraDdl);
  for (const [id, name, slug] of [
    [SALISBURY, "Salisbury", "salisbury"],
    [AMESBURY, "Amesbury", "amesbury"],
    [TROWBRIDGE, "Trowbridge", "trowbridge"],
  ] as const) {
    db.prepare(
      `INSERT INTO foodbank (
         id, uuid, name, slug, address, postcode, country, lat_lng,
         charity_just_foodbank, contact_email, url, shopping_list_url,
         address_is_administrative, is_closed, no_locations, days_between_needs,
         created, modified
       ) VALUES (?, ?, ?, ?, 'Address', 'SP2 9DY', 'England', '51.06,-1.79',
         0, 'info@example.org', 'https://example.org/', 'https://example.org/list/',
         0, 0, 0, 7,
         '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
    ).run(id, `uuid-${id}`, name, slug);
  }
  // `id INTEGER PRIMARY KEY` IS the rowid, so within tie group A rowid order
  // is 7/33/41 while INSERT order is 41/7/33, and within group B rowid order
  // is 3/18/60 while INSERT order is 60/3/18. Both plans break ties by rowid
  // -- a table scan walks the b-tree in rowid order, and the index's entries
  // are (published_date DESC, rowid ASC) -- so the deliberate mismatch is what
  // makes a tie-break that came from insertion order instead show up as a
  // different answer below rather than agreeing by accident.
  const insert = db.prepare("INSERT INTO foodbankarticle (id, foodbank_id, published_date, title, url, featured) VALUES (?, ?, ?, ?, ?, ?)");
  for (const a of ARTICLES) insert.run(a.id, a.foodbankId, a.publishedDate, `Article ${a.id}`, `https://example.org/news/${a.id}/`, a.featured);
  return db;
}

const indexNames = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'foodbankarticle' AND name IS NOT NULL ORDER BY name").all() as { name: string }[]).map(
    (r) => r.name,
  );

const plan = (db: DatabaseSync, { sql, params }: Recorded): string =>
  (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((r) => r.detail).join(" | ");

// Every read of foodbankarticle in packages/db, called through the real
// module rather than a transcribed statement. `label` is what a failure
// prints, so a moved row names its own function.
const READERS: { label: string; run: (session: Session) => Promise<unknown[]> }[] = [
  { label: "getRecentArticles(4) -- LIMIT cuts through tie group A", run: (s) => getRecentArticles(s, 4) },
  { label: "getRecentArticles(8) -- LIMIT cuts through tie group B", run: (s) => getRecentArticles(s, 8) },
  { label: "getRecentArticles(100) -- /news/'s shape, whole table", run: (s) => getRecentArticles(s, 100) },
  { label: "getRecentArticlesForAdmin(4) -- LEFT JOIN, cut tie A", run: (s) => getRecentArticlesForAdmin(s, 4) },
  { label: "getRecentArticlesForAdmin(100) -- LEFT JOIN, whole table", run: (s) => getRecentArticlesForAdmin(s, 100) },
  { label: "getFeaturedArticles(6) -- the partial index's query", run: (s) => getFeaturedArticles(s, 6) },
  { label: "getFeaturedArticles(2) -- partial index, capped", run: (s) => getFeaturedArticles(s, 2) },
  { label: "getArticlesByFoodbankId(SALISBURY, 100)", run: (s) => getArticlesByFoodbankId(s, SALISBURY, 100) },
  { label: "getArticlesByFoodbankId(TROWBRIDGE, 2)", run: (s) => getArticlesByFoodbankId(s, TROWBRIDGE, 2) },
  { label: "getArticlesForFoodbankTab(SALISBURY, 100)", run: (s) => getArticlesForFoodbankTab(s, SALISBURY, 100) },
  { label: "getArticlesForFoodbankTab(AMESBURY, 2)", run: (s) => getArticlesForFoodbankTab(s, AMESBURY, 2) },
  { label: "getArticlesForNeedEmail(SALISBURY, cutoff) -- no LIMIT", run: (s) => getArticlesForNeedEmail(s, SALISBURY, "2026-09-02") },
  { label: "getArticlesForNeedEmail(AMESBURY, cutoff) -- no LIMIT", run: (s) => getArticlesForNeedEmail(s, AMESBURY, "2026-01-01") },
];

describe("0024_article_published_all_idx: the migration itself", () => {
  it("is declared exactly once, by one migration, and adds nothing else", () => {
    expect(declaringMigrations).toEqual(["0024_article_published_all_idx.sql"]);

    // Comments stripped, the file is ONE statement. This is the guard against
    // the follow-up the ticket explicitly forbids -- a `DROP INDEX
    // article_published_idx` appended here later would regress the homepage's
    // featured block (175 of 17,248 rows are featured) from a 10-row read to
    // a several-hundred-row one. The plan assertion below catches the
    // consequence; this catches the edit.
    const statements = readFileSync(join(MIGRATIONS_DIR, "0024_article_published_all_idx.sql"), "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);

    expect(statements).toEqual([`CREATE INDEX ${INDEX_NAME} ON foodbankarticle(published_date DESC)`]);
  });

  // DESC, not ASC, and the assertion is on the DDL because the plan cannot
  // tell them apart -- see the header, and the last describe block for the
  // rows that can.
  it("orders the index DESC, matching the ORDER BY it exists for", () => {
    const after = seed(SCHEMA_AFTER);
    const sql = (after.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(INDEX_NAME) as { sql: string }).sql;
    expect(sql).toBe(`CREATE INDEX ${INDEX_NAME} ON foodbankarticle(published_date DESC)`);
  });

  // Both halves matter. The first is the fix; the second is the ticket's
  // "keep both indexes", which an over-tidy follow-up would undo.
  it("adds the new index and leaves the two existing ones alone", () => {
    expect(indexNames(seed(SCHEMA_BEFORE))).toEqual(["article_published_idx", "article_url_uniq"]);
    expect(indexNames(seed(SCHEMA_AFTER))).toEqual(["article_published_all_idx", "article_published_idx", "article_url_uniq"]);
  });
});

describe("0024_article_published_all_idx: the output does not move", () => {
  // THE ASSERTION THE WHOLE TICKET RESTS ON. Same seed, same functions, one
  // extra index -- and every row of every reader identical, values and order.
  // Compared as full row objects rather than id lists because the index moves
  // which access path builds the projection: a join that reordered could hand
  // back the right ids carrying another food bank's name, and an id list would
  // not notice.
  //
  // WHAT THIS COMPARISON CANNOT SEE, BY CONSTRUCTION: anything that moves BOTH
  // halves the same way. Measured -- deleting `a.featured` from
  // homepage.ts's ARTICLE_SELECT leaves all 25 tests here green, because the
  // column vanishes from the before rows and the after rows alike. That is
  // homepage.test.ts's job (its "coerces featured to false" block pins the
  // column), not this file's, and the pinned-rows test below is the only
  // defence here against a shared move.
  it.each(READERS)("returns identical rows before and after the migration: $label", async ({ run }) => {
    const before = seed(SCHEMA_BEFORE);
    const after = seed(SCHEMA_AFTER);

    const rowsBefore = await run(d1Session(before, []));
    const rowsAfter = await run(d1Session(after, []));

    expect(rowsAfter).toEqual(rowsBefore);
    // Fixtures that return nothing agree with each other perfectly. Every
    // reader above is seeded to return rows, so an empty result is a broken
    // fixture, not a passing test.
    expect(rowsBefore.length).toBeGreaterThan(0);
  });

  // The literal answers, pinned. The test above proves the two schemas agree;
  // it cannot prove they agree on the RIGHT rows -- a change that moved both
  // halves the same way would sail through it. These are the values the live
  // plan produces today.
  it("pins the rows themselves, so a change that moves both halves is still caught", async () => {
    const after = seed(SCHEMA_AFTER);
    const session = d1Session(after, []);
    const ids = async (rows: Promise<{ id: number }[]>) => (await rows).map((r) => r.id);

    // published_date DESC, ties broken by rowid ASC: 7/33/41 then 3/18/60.
    expect(await ids(getRecentArticles(session, 100))).toEqual([50, 12, 7, 33, 41, 25, 3, 18, 60, 44, 9, 5]);
    // LIMIT 4 lands mid-tie-A: 7 and 33 in, 41 out.
    expect(await ids(getRecentArticles(session, 4))).toEqual([50, 12, 7, 33]);
    // LIMIT 8 lands mid-tie-B: 3 and 18 in, 60 out.
    expect(await ids(getRecentArticles(session, 8))).toEqual([50, 12, 7, 33, 41, 25, 3, 18]);
    // The LEFT JOIN keeps article 71, whose food bank is gone; the INNER JOIN
    // above drops it. One index, two join semantics, both preserved.
    expect(await ids(getRecentArticlesForAdmin(session, 100))).toEqual([50, 12, 7, 33, 41, 25, 3, 18, 60, 44, 9, 71, 5]);
    expect(await ids(getFeaturedArticles(session, 6))).toEqual([50, 7, 18, 5]);
    expect(await ids(getArticlesByFoodbankId(session, SALISBURY, 100))).toEqual([50, 41, 25, 3, 9]);
    expect(await ids(getArticlesForFoodbankTab(session, SALISBURY, 100))).toEqual([50, 41, 25, 3, 9]);
    expect(await ids(getArticlesForNeedEmail(session, SALISBURY, "2026-09-02"))).toEqual([50, 41, 25, 3]);
  });
});

describe("0024_article_published_all_idx: the plan actually changes", () => {
  // Identity is only half the claim. A migration that created the index on
  // the wrong column, or on a column the planner declines to use, would pass
  // every assertion above -- it moves nothing because it does nothing.
  const planFor = async (schema: string, run: (session: Session) => Promise<unknown[]>): Promise<string> => {
    const db = seed(schema);
    const recorded: Recorded[] = [];
    await run(d1Session(db, recorded));
    expect(recorded).toHaveLength(1);
    return plan(db, recorded[0]!);
  };

  it("puts the unfiltered /news/ ordering on the index and drops the sort", async () => {
    const before = await planFor(SCHEMA_BEFORE, (s) => getRecentArticles(s, 100));
    expect(before).toContain("SCAN a");
    expect(before).toContain("USE TEMP B-TREE FOR ORDER BY");
    expect(before).not.toContain(INDEX_NAME);

    const after = await planFor(SCHEMA_AFTER, (s) => getRecentArticles(s, 100));
    expect(after).toContain(`SCAN a USING INDEX ${INDEX_NAME}`);
    // The temp b-tree is the 51,744 rows_read. Its absence IS the fix.
    expect(after).not.toContain("USE TEMP B-TREE FOR ORDER BY");
  });

  // The four queries the ticket did not ask about. Their plans change too, so
  // they are stated here rather than discovered in production; the identity
  // block above is what says the change is safe.
  it.each([
    { label: "getRecentArticlesForAdmin", run: (s: Session) => getRecentArticlesForAdmin(s, 200) },
    { label: "getArticlesByFoodbankId", run: (s: Session) => getArticlesByFoodbankId(s, SALISBURY, 100) },
    { label: "getArticlesForFoodbankTab", run: (s: Session) => getArticlesForFoodbankTab(s, SALISBURY, 100) },
    { label: "getArticlesForNeedEmail", run: (s: Session) => getArticlesForNeedEmail(s, SALISBURY, "2026-09-02") },
  ])("also moves $label off its sort", async ({ run }) => {
    expect(await planFor(SCHEMA_BEFORE, run)).toContain("USE TEMP B-TREE FOR ORDER BY");

    const after = await planFor(SCHEMA_AFTER, run);
    expect(after).toContain(`USING INDEX ${INDEX_NAME}`);
    expect(after).not.toContain("USE TEMP B-TREE FOR ORDER BY");
  });

  // The ticket's explicit "do NOT drop article_published_idx". 175 of 17,248
  // production rows are featured, so the partial index is ~1% of the size of
  // the new one for this query and the planner knows it. Delete
  // article_published_idx from the migrations and this fails: the featured
  // query falls onto article_published_all_idx and walks ~99 non-featured
  // entries per featured row it finds.
  it("leaves the featured query on the partial index, which stays the better one", async () => {
    const before = await planFor(SCHEMA_BEFORE, (s) => getFeaturedArticles(s, 6));
    const after = await planFor(SCHEMA_AFTER, (s) => getFeaturedArticles(s, 6));

    expect(before).toContain("SCAN a USING INDEX article_published_idx");
    expect(after).toBe(before);
    expect(after).not.toContain(INDEX_NAME);
  });
});

describe("0024_article_published_all_idx: DESC is load-bearing", () => {
  // The mutant: the same index without `DESC`. It is built here, in a
  // throwaway in-memory database, from the real pre-migration schema -- the
  // migration on disk is never touched.
  const ASC_MUTANT = `CREATE INDEX ${INDEX_NAME} ON foodbankarticle(published_date);`;

  // First, why the mutant is dangerous: it is invisible to every plan
  // assertion in this file. If a reviewer only ever checked plans, ASC would
  // ship.
  it("is invisible in the query plan, which is why the rows have to be checked", async () => {
    const mutant = seed(SCHEMA_BEFORE, ASC_MUTANT);
    const real = seed(SCHEMA_AFTER);
    const recorded: Recorded[] = [];
    await getRecentArticles(d1Session(real, recorded), 100);

    expect(plan(mutant, recorded[0]!)).toBe(plan(real, recorded[0]!));
    expect(plan(mutant, recorded[0]!)).toContain(`SCAN a USING INDEX ${INDEX_NAME}`);
  });

  // And then what it actually costs: reversed tie order, which reverses
  // membership too once a LIMIT lands inside a tie group. On production's
  // data today that is two adjacent rows at ranks 182/183 of
  // /dashboard/articles/ -- harmless this week, and a silently reordered
  // /news/ the first week two articles land on the same timestamp near the
  // 100-row cut.
  it("would reorder tied rows, and change which of them a LIMIT keeps", async () => {
    const before = seed(SCHEMA_BEFORE);
    const mutant = seed(SCHEMA_BEFORE, ASC_MUTANT);

    const asIs = (await getRecentArticles(d1Session(before, []), 100)).map((r) => r.id);
    const asc = (await getRecentArticles(d1Session(mutant, []), 100)).map((r) => r.id);

    expect(asIs).toEqual([50, 12, 7, 33, 41, 25, 3, 18, 60, 44, 9, 5]);
    expect(asc).toEqual([50, 12, 41, 33, 7, 25, 60, 18, 3, 44, 9, 5]);

    // Same rows, different order -- so a set comparison would have passed the
    // mutant. At a LIMIT inside a tie it is not even the same rows.
    expect([...asc].sort((a, b) => a - b)).toEqual([...asIs].sort((a, b) => a - b));
    expect((await getRecentArticles(d1Session(mutant, []), 4)).map((r) => r.id)).toEqual([50, 12, 41, 33]);
  });
});
