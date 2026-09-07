import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "./schema.testkit";
import { describe, expect, it } from "vitest";
import { CRAWL_TYPE_OPTIONS, isCrawlTypeOption, getCrawlSets, getOrphanedCrawlItems, getRunningCrawlSets, getCrawlTypeLastRuns } from "./crawlSets";
import type { Session } from "./types";

// gfadmin/views.py:3228-3280 crawl_sets()/crawl_set(), plus the two queries
// /admin/jobs/ adds on top of them (WP: "all the jobs that are running").
//
// WHY A REAL DATABASE, NOT A MOCK. Every function here is a SELECT and
// nothing else, so a mocked session that hands back canned rows tests only
// that JavaScript can spread an object -- it agrees with any SQL at all. The
// failures this module can actually have are silent ones: a correlated count
// that quietly becomes an inner join and drops every crawl set that found
// nothing; a `crawl_set_id IS NULL` that decays to `= NULL` and empties the
// Ad Hoc list; a LEFT JOIN to foodbankchange turned inner, which hides
// exactly the crawl items whose need has since been deleted. None of those
// throws, none logs, and each renders a plausible page. This package already
// carries that scar -- migration 0019 dropped six tables' cached parent
// columns and four queries went on naming them until /dashboard/beautybanks/
// was measured and found to be a live 500. So the statements below are run,
// by SQLite, against the real schema.
//
// MUTATION-TESTED TWICE (TESTING.md's convention: the evidence a test is
// load-bearing rather than decoration). The module was copied into a
// scratchpad, broken 38 ways, and this file re-run against each. 37 died,
// including: ORDER BY start swapped for id and for ASC on all four queries;
// the correlated counts rewritten as the "obvious" JOIN + GROUP BY; each
// count's correlation dropped; object_count's `need_id IS NOT NULL` deleted
// and swapped for `finish IS NOT NULL`; both type filters dropped and the
// ad-hoc one turned into an OR; getCrawlSets' binds transposed; `IS NULL`
// changed to `= NULL` and to `IS NOT NULL`; the LEFT JOIN to foodbankchange
// made inner, and re-pointed at foodbank_id so it fans out; `need_uuid` read
// off the crawl item's integer instead; `done` inverted, ??-coalesced, and
// its && loosened to ||; running_for's subtraction inverted and its parse
// given the double-"Z" that produces a silent NaN; the last-run MAX taken
// over id, over MIN, and uncorrelated; and isCrawlTypeOption rewritten as an
// object lookup that inherits Object.prototype.
//
// A SECOND, ADVERSARIAL ROUND then re-ran 96 mutants against the file as it
// stood, and found four holes the first round had missed. All four are now
// closed, and each is named in the comment on the test that closes it:
//   * DELETING THE ORDER BY ENTIRELY survived on getOrphanedCrawlItems. The
//     test had seeded ids ascending against descending starts -- which makes
//     the expected answer [1,2,3,4] -- and SQLite with no ORDER BY hands back
//     rowid order, so the assertion agreed with a statement promising no order
//     at all. The seeds in all three ordering tests are now SCRAMBLED, so each
//     expected sequence is start DESC and nothing else. (The same mutant on
//     getRunningCrawlSets survives for an unrelated reason -- see below.)
//   * `crawl_type = ?` swapped for `crawl_type LIKE ?` survived on both type
//     filters: SQLite's LIKE is case-insensitive for ASCII, and every test
//     had seeded one casing. Differently-cased rows are now seeded and
//     asserted absent.
//   * ADDING `AND ci.crawl_type = cs.crawl_type` to either count subquery
//     survived, because no test seeded a set holding an item of another type.
//     Pinned now, with the reasoning, on "counts every item in the set".
//   * `ORDER BY start DESC` swapped for `ORDER BY expected DESC` survived on
//     getRunningCrawlSets, whose ordering test had left expected/remaining
//     NULL on every row -- so every row tied and any sort key passed. Those
//     columns now carry values that sort into a different sequence again.
//
// THE FOUR SURVIVORS THAT REMAIN, stated rather than hidden. None is a hole
// that a stronger assertion would close -- each is a mutant no honest test can
// tell apart from the original:
//   * replacing parseD1Timestamp with a bare `new Date(r.start)` -- dropping
//     the "Z" that forces UTC -- passes everything here, because
//     vitest.config.mts pins TZ=UTC and a naive local parse is then identical
//     to a UTC one. That half of parseD1Timestamp is not observable from this
//     suite by construction, and the TZ pin is not negotiable (it is what
//     keeps pyDatetime's own tests honest). Its guard is foodbankTabs.ts's own
//     tests, not these.
//   * getCrawlTypeLastRuns' `WHERE cs.start = (SELECT MAX(...))` rewritten as
//     `>=`. That one is EQUIVALENT, not uncaught: start is NOT NULL, and a
//     row can only be >= the maximum of its own type by being equal to it.
//     No test can distinguish them, and none should pretend to.
//   * deleting getRunningCrawlSets' ORDER BY, which is equivalent under THIS
//     schema for the reason set out on that suite's ordering test: migration
//     0023's partial index is itself `(start DESC) WHERE finish IS NULL`, so
//     the scan that satisfies the WHERE already emits start DESC. No
//     assertion on rows can see the difference; what can be seen -- that the
//     index is what answers the query -- is pinned by its own test.
//   * appending `, cs.id ASC` to getCrawlSets' ORDER BY as a tie-break. It
//     differs from the original only for two crawl sets sharing a `start` to
//     the microsecond, and there the original's order is whatever the plan
//     happens to produce -- unspecified, so there is nothing to assert. Left
//     unpinned deliberately: a test that froze today's tie order would be
//     pinning the query planner, not the query.
//
// NO CHUNKING TO TEST. D1 caps a statement at 100 bound parameters, which is
// the boundary every variable-length IN list in this package has to be tested
// at; nothing here builds one. The largest statement below binds two values
// (a crawl type and a LIMIT), and both filters are single equalities, so the
// count is fixed no matter how much data exists.
//
// THE FIXTURE IS THE MIGRATION FILES THEMSELVES, applied in order, for the
// same reason: a CREATE TABLE transcribed into a test file is a second copy
// of the truth and drifts from the first. Three facts it supplies that a
// hand-written schema would probably have got wrong, and that tests below
// depend on:
//   * crawlitem.crawl_set_id is NULLABLE (0008_needcheck.sql) -- that is what
//     an ad-hoc crawl IS, so getOrphanedCrawlItems has something to find.
//   * crawlitem_crawlset_foodbank_uniq is UNIQUE(crawl_set_id, foodbank_id),
//     so a crawl set holds at most one item per food bank; every multi-item
//     set seeded here therefore spans several food banks, as production's do.
//     NULLs compare distinct in a SQLite unique index, which is why a food
//     bank can still have many ad-hoc items.
//   * foodbankchange lost its `foodbank_name` copy in 0019, so the parent's
//     name can only come from the join.

type Bindable = null | number | bigint | string | Uint8Array;

// The slice of the D1 Sessions API this package is handed, backed by
// node:sqlite. Copied from adminDashboardStats.test.ts (itself copied from
// workers/site/src/routes/admin/foodbankLocation.test.ts) so every tier drives
// the real code through one adapter. Deliberately dumb -- it forwards the SQL
// untouched and interprets nothing, so the engine decides which rows come
// back, not this file.
function d1Session(db: DatabaseSync): Session {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return { prepare: (sql: string) => statement(sql, []), getBookmark: () => null } as unknown as Session;
}

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return db;
}

// EVERY TIMESTAMP IN THIS FILE IS DJANGO'S FORMAT: "YYYY-MM-DD HH:MM:SS.ffffff",
// which is what pyDatetime() writes and what migration 0022 rewrote the
// imported Postgres rows into. That is not decoration. These columns are TEXT
// and every ORDER BY / MAX over them is a byte-wise string comparison, so the
// format is load-bearing twice over: a toISOString() value ("2026-09-05T...Z")
// sorts ABOVE every space-separated one because 'T' (0x54) beats ' ' (0x20),
// and parseD1Timestamp has already been bitten once by a double-"Z" producing
// a silent NaN (see foodbankTabs.ts's header). Seeding ISO here would test a
// database this app does not have.
function seedFoodbank(db: DatabaseSync, id: number, name: string, slug: string): void {
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

// `needId` is the 32-char dashless UUID, NOT the row's integer primary key --
// they are different columns and the module hands back the former under the
// name `need_uuid`. Seeded as visibly different values (id 41, uuid
// "aaaa...") so a query that returned the wrong one could not accidentally
// look right.
function seedNeed(db: DatabaseSync, id: number, needId: string, foodbankId: number): void {
  db.prepare(
    `INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, published, nonpertinent, input_method, created, modified)
     VALUES (?, ?, ?, 'Beans, Rice', 1, 0, 'scrape', '2026-09-05 15:00:00.000000', '2026-09-05 15:00:00.000000')`,
  ).run(id, needId, foodbankId);
}

interface CrawlSetSeed {
  id: number;
  crawl_type: string;
  start: string;
  finish?: string | null;
  expected?: number | null;
  remaining?: number | null;
}

function seedCrawlSet(db: DatabaseSync, cs: CrawlSetSeed): void {
  db.prepare(`INSERT INTO crawlset (id, crawl_type, run_id, start, finish, expected, remaining) VALUES (?, ?, NULL, ?, ?, ?, ?)`).run(
    cs.id,
    cs.crawl_type,
    cs.start,
    cs.finish ?? null,
    cs.expected ?? null,
    cs.remaining ?? null,
  );
}

interface CrawlItemSeed {
  id: number;
  crawl_set_id: number | null;
  crawl_type: string;
  start: string;
  finish?: string | null;
  foodbank_id: number;
  url?: string | null;
  need_id?: number | null;
}

function seedCrawlItem(db: DatabaseSync, ci: CrawlItemSeed): void {
  db.prepare(`INSERT INTO crawlitem (id, crawl_set_id, crawl_type, start, finish, foodbank_id, url, need_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    ci.id,
    ci.crawl_set_id,
    ci.crawl_type,
    ci.start,
    ci.finish ?? null,
    ci.foodbank_id,
    ci.url ?? null,
    ci.need_id ?? null,
  );
}

describe("CRAWL_TYPE_OPTIONS", () => {
  // gfadmin/views.py:3230's literal list, in its order. The order is not
  // cosmetic: crawlSets.ts hands this array straight to the template as
  // `crawl_type_options`, so it is the order of the filter dropdown the admin
  // reads. Pinned as a whole rather than by membership so that adding a
  // seventh type is a deliberate edit here, not a silent one.
  it("is Django's six types, in Django's order", () => {
    expect([...CRAWL_TYPE_OPTIONS]).toEqual(["need", "article", "charity", "discrepancy", "check", "urls"]);
  });
});

describe("isCrawlTypeOption", () => {
  it("accepts every option in the list", () => {
    for (const option of CRAWL_TYPE_OPTIONS) expect(isCrawlTypeOption(option)).toBe(true);
  });

  // This predicate is a GATE, not a fallback: routes/admin/crawlSets.ts turns
  // a false into a 403, exactly as Django does, because silently showing every
  // crawl type when the caller asked for one is a wrong answer rather than a
  // differently-ordered one. Anything it wrongly accepts reaches the SQL as a
  // crawl_type value; anything it wrongly rejects 403s a legitimate link.
  it("rejects near-misses that would otherwise reach the WHERE clause", () => {
    expect(isCrawlTypeOption("")).toBe(false);
    expect(isCrawlTypeOption("Need")).toBe(false); // crawl_type is stored lower-case; SQLite's = is case-sensitive
    expect(isCrawlTypeOption("needs")).toBe(false);
    expect(isCrawlTypeOption("url")).toBe(false); // the option is the plural "urls"
    expect(isCrawlTypeOption("need ")).toBe(false);
    expect(isCrawlTypeOption("need' OR 1=1 --")).toBe(false);
  });

  // Array.includes, not a lookup on an object. A `Record<string, true>` written
  // as the obvious alternative inherits Object.prototype, so "constructor" and
  // "toString" would test truthy and be bound into `cs.crawl_type = ?` -- a
  // filter that matches nothing, presented to the admin as an empty crawl
  // history rather than as the 403 Django would have returned.
  it("rejects inherited Object.prototype keys", () => {
    expect(isCrawlTypeOption("constructor")).toBe(false);
    expect(isCrawlTypeOption("toString")).toBe(false);
    expect(isCrawlTypeOption("__proto__")).toBe(false);
  });
});

describe("getCrawlSets", () => {
  // Django is `.order_by("-start")[:50]` -- newest first, capped.
  //
  // THE SEED ORDER IS SCRAMBLED, and that is the whole test. In production id
  // order and start order agree (rows are only ever appended), so the obvious
  // seeding -- ids 1..5 with starts descending -- produces an expectation of
  // [1,2,3,4,5], which is ALSO what `ORDER BY cs.id`, and what deleting the
  // ORDER BY altogether, hand back: SQLite with no ordering returns rows in
  // rowid order, so the assertion agrees with a statement that promises no
  // order at all. Scrambling the ids breaks that coincidence, and the expected
  // sequence below now matches start DESC and nothing else -- not id ASC, not
  // id DESC, not insertion order, not start ASC.
  it("orders by start DESC -- not by id, not by insertion order -- and applies LIMIT after the sort", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 1, crawl_type: "article", start: "2026-09-05 16:20:00.000000" });
    seedCrawlSet(db, { id: 2, crawl_type: "article", start: "2026-09-05 22:20:00.000000" });
    seedCrawlSet(db, { id: 3, crawl_type: "article", start: "2026-09-05 14:20:00.000000" });
    seedCrawlSet(db, { id: 4, crawl_type: "article", start: "2026-09-05 20:20:00.000000" });
    seedCrawlSet(db, { id: 5, crawl_type: "article", start: "2026-09-05 18:20:00.000000" });

    expect((await getCrawlSets(d1Session(db), null, 50)).map((r) => r.id)).toEqual([2, 4, 5, 1, 3]);
    // The cap keeps the NEWEST three. A LIMIT that ran before the sort -- or
    // an ASC ordering -- would hand back the three OLDEST, which is the same
    // row count and the wrong page.
    expect((await getCrawlSets(d1Session(db), null, 3)).map((r) => r.id)).toEqual([2, 4, 5]);
  });

  // These columns are TEXT and the comparison is byte-wise, so the sort is only
  // chronological because the format is fixed-width and zero-padded. Crossing a
  // month boundary and a day boundary at once is where a format that dropped
  // its leading zeros ("2026-9-9" > "2026-10-01") would come apart, and the
  // sub-second pair is the resolution two crawl sets of the same type actually
  // land at when a duplicate cron delivery fires.
  it("sorts Django-format timestamps chronologically across month and sub-second boundaries", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 1, crawl_type: "need", start: "2026-09-09 15:00:00.000000" });
    seedCrawlSet(db, { id: 2, crawl_type: "need", start: "2026-10-01 15:00:00.000000" });
    seedCrawlSet(db, { id: 3, crawl_type: "need", start: "2026-09-09 15:00:00.001000" });

    expect((await getCrawlSets(d1Session(db), null, 50)).map((r) => r.id)).toEqual([2, 3, 1]);
  });

  // THE INNER-JOIN MUTANT. Django annotates with Count('crawlitem'), which is a
  // LEFT JOIN plus GROUP BY, so a crawl set that produced no items still
  // appears with a count of 0. The port's correlated subqueries have the same
  // property -- but rewriting them as the "obvious" `JOIN crawlitem ... GROUP
  // BY cs.id` drops the childless set entirely, and a crawl set with no items
  // is precisely the failure an admin opens this page to see. The set with
  // zero items is therefore seeded FIRST in the expectations below.
  it("keeps a crawl set that produced no items at all, counting it as 0/0", async () => {
    const db = freshDb();
    seedFoodbank(db, 1, "Salisbury", "salisbury");
    seedFoodbank(db, 2, "Amesbury", "amesbury");
    seedNeed(db, 41, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1);
    seedCrawlSet(db, { id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });
    seedCrawlSet(db, { id: 11, crawl_type: "need", start: "2026-09-04 15:00:00.000000" });
    // One item per (set, food bank): crawlitem_crawlset_foodbank_uniq.
    seedCrawlItem(db, { id: 100, crawl_set_id: 10, crawl_type: "need", start: "2026-09-05 15:00:01.000000", foodbank_id: 1, need_id: 41 });
    seedCrawlItem(db, { id: 101, crawl_set_id: 10, crawl_type: "need", start: "2026-09-05 15:00:02.000000", foodbank_id: 2, need_id: null });

    const rows = await getCrawlSets(d1Session(db), null, 50);
    expect(rows.map((r) => [r.id, r.item_count, r.object_count])).toEqual([
      [10, 2, 1],
      [11, 0, 0],
    ]);
  });

  // object_count is Count('crawlitem', filter=Q(object_id__isnull=False)) --
  // "items that produced a need", not "items that finished". The two numbers
  // are printed side by side, so a filter that did nothing would make every
  // crawl look 100% productive; one that inverted would make every crawl look
  // barren. Seeded 3 items / 1 need so neither count can be mistaken for the
  // other, and a finished-but-fruitless item is included to prove `finish` is
  // not what is being counted.
  it("counts only items with a need as object_count, ignoring whether they finished", async () => {
    const db = freshDb();
    for (const id of [1, 2, 3]) seedFoodbank(db, id, `FB ${id}`, `fb-${id}`);
    seedNeed(db, 41, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1);
    seedCrawlSet(db, { id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });
    seedCrawlItem(db, { id: 100, crawl_set_id: 10, crawl_type: "need", start: "2026-09-05 15:00:01.000000", finish: "2026-09-05 15:00:03.000000", foodbank_id: 1, need_id: 41 });
    seedCrawlItem(db, { id: 101, crawl_set_id: 10, crawl_type: "need", start: "2026-09-05 15:00:02.000000", finish: "2026-09-05 15:00:04.000000", foodbank_id: 2, need_id: null });
    seedCrawlItem(db, { id: 102, crawl_set_id: 10, crawl_type: "need", start: "2026-09-05 15:00:03.000000", finish: null, foodbank_id: 3, need_id: null });

    const [row] = await getCrawlSets(d1Session(db), null, 50);
    expect(row!.item_count).toBe(3);
    expect(row!.object_count).toBe(1);
  });

  // The correlation itself. Drop `ci.crawl_set_id = cs.id` from either
  // subquery and every row on the page shows the same two numbers -- the
  // whole-table totals -- which look entirely reasonable and are wrong for
  // all but one row. Ad-hoc items (crawl_set_id NULL) belong to no set and
  // must count towards none: `ci.crawl_set_id = cs.id` is never true for a
  // NULL, which is the behaviour being pinned here as much as the isolation.
  it("counts only its own items -- not another set's, and not the ad-hoc ones", async () => {
    const db = freshDb();
    for (const id of [1, 2, 3]) seedFoodbank(db, id, `FB ${id}`, `fb-${id}`);
    seedNeed(db, 41, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1);
    seedNeed(db, 42, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 2);
    seedCrawlSet(db, { id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });
    seedCrawlSet(db, { id: 11, crawl_type: "need", start: "2026-09-04 15:00:00.000000" });
    seedCrawlItem(db, { id: 100, crawl_set_id: 10, crawl_type: "need", start: "2026-09-05 15:00:01.000000", foodbank_id: 1, need_id: 41 });
    seedCrawlItem(db, { id: 101, crawl_set_id: 11, crawl_type: "need", start: "2026-09-04 15:00:01.000000", foodbank_id: 1, need_id: 42 });
    seedCrawlItem(db, { id: 102, crawl_set_id: 11, crawl_type: "need", start: "2026-09-04 15:00:02.000000", foodbank_id: 2, need_id: null });
    // Ad-hoc: a "Force Check" from the food bank detail page. Belongs to the
    // Ad Hoc Crawls table further down the same page, not to any set's count.
    seedCrawlItem(db, { id: 103, crawl_set_id: null, crawl_type: "need", start: "2026-09-05 16:00:00.000000", foodbank_id: 3, need_id: 41 });

    const rows = await getCrawlSets(d1Session(db), null, 50);
    expect(rows.map((r) => [r.id, r.item_count, r.object_count])).toEqual([
      [10, 1, 1],
      [11, 2, 1],
    ]);
  });

  // MEMBERSHIP IS THE ONLY CONDITION. Django's Count('crawlitem') and its
  // filtered sibling join on the FK and nothing else, so the port's subqueries
  // correlate on `ci.crawl_set_id = cs.id` alone -- deliberately NOT on
  // `ci.crawl_type = cs.crawl_type` as well.
  //
  // The mixed-type set below does not occur today: every producer hard-codes
  // its item's type to its set's ("need" in needcheckRender.ts, "article" in
  // articles.ts, "charity" in charity.ts), which is exactly why adding a type
  // condition to these counts passes every other test in this file -- it did
  // survive the first mutation run. It is pinned rather than dismissed because
  // the counts are the page's only evidence that a sweep did any work: a
  // fourth producer that reused an existing set for a second kind of item
  // would, under that mutant, report a crawl of 400 items as having done 0,
  // with nothing anywhere to say so. Asserted as behaviour, not endorsed as a
  // shape to write.
  it("counts every item in the set, whatever its own crawl_type says", async () => {
    const db = freshDb();
    for (const id of [1, 2]) seedFoodbank(db, id, `FB ${id}`, `fb-${id}`);
    seedNeed(db, 41, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1);
    seedCrawlSet(db, { id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });
    seedCrawlItem(db, { id: 100, crawl_set_id: 10, crawl_type: "need", start: "2026-09-05 15:00:01.000000", foodbank_id: 1, need_id: 41 });
    seedCrawlItem(db, { id: 101, crawl_set_id: 10, crawl_type: "article", start: "2026-09-05 15:00:02.000000", foodbank_id: 2, need_id: 41 });

    const [row] = await getCrawlSets(d1Session(db), null, 50);
    expect([row!.item_count, row!.object_count]).toEqual([2, 2]);
  });

  // A filter is the one thing that passes every test written only from rows it
  // is supposed to keep, so the excluded types are seeded first and outnumber
  // the kept one. The kept result is asserted NON-EMPTY on purpose: the binds
  // are built as [crawlType, limit] against `WHERE ... = ? ... LIMIT ?`, and
  // transposing them binds "need" to LIMIT, which SQLite coerces to 0 and
  // answers with an empty page rather than an error.
  it("filters to one crawl type and excludes every other", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 1, crawl_type: "article", start: "2026-09-05 22:20:00.000000" });
    seedCrawlSet(db, { id: 2, crawl_type: "charity", start: "2026-09-05 21:20:00.000000" });
    seedCrawlSet(db, { id: 3, crawl_type: "need", start: "2026-09-05 20:20:00.000000" });
    seedCrawlSet(db, { id: 4, crawl_type: "discrepancy", start: "2026-09-05 19:20:00.000000" });
    seedCrawlSet(db, { id: 5, crawl_type: "need", start: "2026-09-04 15:00:00.000000" });

    const filtered = await getCrawlSets(d1Session(db), "need", 50);
    expect(filtered.map((r) => r.id)).toEqual([3, 5]);
    expect(filtered.every((r) => r.crawl_type === "need")).toBe(true);

    // The unfiltered call is the same statement without the WHERE. If the
    // `where` fragment were ever built unconditionally the bind count would
    // stop matching and this would throw rather than quietly over-filter.
    expect((await getCrawlSets(d1Session(db), null, 50)).map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
  });

  // `=`, not LIKE. crawl_type is a free TEXT column with no CHECK constraint
  // (0008_needcheck.sql) and every writer hard-codes a lower-case literal, so
  // a differently-cased value is only reachable by hand -- but SQLite's LIKE
  // is case-INSENSITIVE for ASCII while `=` is not, and a maintainer reaching
  // for LIKE (to be "forgiving" about a ?type= the gate has already
  // validated) would silently widen this filter. That mutant survived this
  // file's first mutation run, because every other test here seeds one casing.
  // isCrawlTypeOption's own test asserts the gate rejects "Need"; this is the
  // other half of the same claim, made against the SQL rather than the
  // predicate.
  it("matches crawl_type case-sensitively, so a differently-cased row is not swept in", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 1, crawl_type: "need", start: "2026-09-05 20:20:00.000000" });
    seedCrawlSet(db, { id: 2, crawl_type: "Need", start: "2026-09-05 19:20:00.000000" });
    seedCrawlSet(db, { id: 3, crawl_type: "NEED", start: "2026-09-05 18:20:00.000000" });

    expect((await getCrawlSets(d1Session(db), "need", 50)).map((r) => r.id)).toEqual([1]);
  });

  // CrawlSet.time_taken() (givefood/models/analytics.py:43-47) returns None
  // while a crawl is still going, and Django renders that as an empty cell.
  // The port must not turn it into "0:00:00", which would tell an admin that
  // a sweep still in flight finished instantly.
  it("leaves time_taken null while a crawl set is unfinished", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 1, crawl_type: "need", start: "2026-09-05 15:00:00.000000", finish: null });

    expect((await getCrawlSets(d1Session(db), null, 50))[0]!.time_taken).toBeNull();
  });

  // str(timedelta), not seconds. This is the format Django prints in both
  // templates AND in the JSON the detail page polls, so an SSR row and the
  // poll that overwrites it are indistinguishable; a raw "8047.219 s" made
  // the admin do the conversion in their head. The multi-day case is a real
  // shape here -- a `need` sweep whose consumer died keeps a NULL finish
  // until maintenance.ts backfills it from the last crawl item, days later.
  it("formats time_taken as Python's str(timedelta), including the day-carrying form", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 1, crawl_type: "need", start: "2026-09-05 15:00:00.000000", finish: "2026-09-05 17:14:07.000000" });
    seedCrawlSet(db, { id: 2, crawl_type: "article", start: "2026-09-03 08:20:00.000000", finish: "2026-09-04 10:23:04.000000" });
    seedCrawlSet(db, { id: 3, crawl_type: "charity", start: "2026-09-01 05:30:00.000000", finish: "2026-09-04 09:35:06.000000" });

    const byId = new Map((await getCrawlSets(d1Session(db), null, 50)).map((r) => [r.id, r.time_taken]));
    expect(byId.get(1)).toBe("2:14:07");
    expect(byId.get(2)).toBe("1 day, 2:03:04"); // singular for exactly one day
    expect(byId.get(3)).toBe("3 days, 4:05:06");
  });

  // The microseconds Django writes are not decoration -- parseD1Timestamp
  // reads them through `new Date()`, and the two halves of this test are the
  // only place the sub-second digits can change the printed answer. If the
  // trailing ".ffffff" were ever dropped or mangled on the way in, both of
  // these would come back "0:00:00" together and neither would look wrong on
  // its own.
  it("rounds the sub-second remainder to whole seconds, as Django's time_taken() does", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 1, crawl_type: "need", start: "2026-09-05 15:00:00.000000", finish: "2026-09-05 15:00:00.500000" });
    seedCrawlSet(db, { id: 2, crawl_type: "need", start: "2026-09-04 15:00:00.000000", finish: "2026-09-04 15:00:00.499000" });

    const byId = new Map((await getCrawlSets(d1Session(db), null, 50)).map((r) => [r.id, r.time_taken]));
    expect(byId.get(1)).toBe("0:00:01");
    expect(byId.get(2)).toBe("0:00:00");
  });

  // The template contract, pinned as a set. crawl_sets.njk reads each of these
  // by name and Nunjucks renders a missing one as the empty string -- so a
  // column dropped from the SELECT shows up as a blank column, never as an
  // error. (That is migration 0019's failure mode exactly.) An EXTRA key is
  // asserted against too, because it means the row grew a field nothing
  // renders and the next reader has to work out which are live.
  it("returns exactly the seven keys the template reads", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 1, crawl_type: "need", start: "2026-09-05 15:00:00.000000", finish: "2026-09-05 15:04:32.000000" });

    const [row] = await getCrawlSets(d1Session(db), null, 50);
    expect(Object.keys(row!).sort()).toEqual(["crawl_type", "finish", "id", "item_count", "object_count", "start", "time_taken"]);
    expect(row).toEqual({
      id: 1,
      crawl_type: "need",
      start: "2026-09-05 15:00:00.000000",
      finish: "2026-09-05 15:04:32.000000",
      item_count: 0,
      object_count: 0,
      time_taken: "0:04:32",
    });
  });
});

describe("getOrphanedCrawlItems", () => {
  // The definition of "ad hoc": a CrawlItem with no CrawlSet, which is what
  // the food bank detail page's Force Check / Force Article Crawl buttons
  // create. `IS NULL`, never `= NULL` -- the latter is never true in SQLite
  // and would empty this table permanently, with no error anywhere.
  // Set-owned items are seeded here so a predicate that did nothing fails.
  it("returns only items with no crawl set", async () => {
    const db = freshDb();
    seedFoodbank(db, 1, "Salisbury", "salisbury");
    seedFoodbank(db, 2, "Amesbury", "amesbury");
    seedCrawlSet(db, { id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });
    seedCrawlItem(db, { id: 100, crawl_set_id: 10, crawl_type: "need", start: "2026-09-05 15:00:01.000000", foodbank_id: 1 });
    seedCrawlItem(db, { id: 101, crawl_set_id: 10, crawl_type: "need", start: "2026-09-05 15:00:02.000000", foodbank_id: 2 });
    seedCrawlItem(db, { id: 102, crawl_set_id: null, crawl_type: "need", start: "2026-09-05 16:00:00.000000", foodbank_id: 1 });

    expect((await getOrphanedCrawlItems(d1Session(db), null, 50)).map((r) => r.id)).toEqual([102]);
  });

  // Django is `.order_by("-start")[:50]` on this list too, and the seed order
  // is scrambled here for the same reason as the crawl-set ordering test: ids
  // ascending against descending starts makes the right answer [1,2,3,4],
  // which is indistinguishable from rowid order -- so it would pass a query
  // with the ORDER BY DELETED as readily as the real one. (That mutant did
  // survive this file's first mutation run; this seeding is what kills it.)
  // The sequence below is produced by start DESC alone.
  it("orders by start DESC -- not by id, not by insertion order -- and applies LIMIT after the sort", async () => {
    const db = freshDb();
    seedFoodbank(db, 1, "Salisbury", "salisbury");
    seedCrawlItem(db, { id: 1, crawl_set_id: null, crawl_type: "need", start: "2026-09-05 14:00:00.000000", foodbank_id: 1 });
    seedCrawlItem(db, { id: 2, crawl_set_id: null, crawl_type: "need", start: "2026-09-05 18:00:00.000000", foodbank_id: 1 });
    seedCrawlItem(db, { id: 3, crawl_set_id: null, crawl_type: "need", start: "2026-09-05 12:00:00.000000", foodbank_id: 1 });
    seedCrawlItem(db, { id: 4, crawl_set_id: null, crawl_type: "need", start: "2026-09-05 16:00:00.000000", foodbank_id: 1 });

    expect((await getOrphanedCrawlItems(d1Session(db), null, 50)).map((r) => r.id)).toEqual([2, 4, 1, 3]);
    expect((await getOrphanedCrawlItems(d1Session(db), null, 2)).map((r) => r.id)).toEqual([2, 4]);
  });

  // Two predicates, ANDed. `?adhoc_type=` is a SEPARATE filter from the crawl
  // sets table's `?type=` (Django keeps them apart too), and the type clause is
  // appended to the crawl_set_id one -- so an item of the right type that
  // belongs to a set must still be excluded. Seeded here precisely because a
  // clause accidentally written as `OR` would pass a test that only checked
  // the type.
  it("filters by crawl type without losing the no-crawl-set requirement", async () => {
    const db = freshDb();
    seedFoodbank(db, 1, "Salisbury", "salisbury");
    seedFoodbank(db, 2, "Amesbury", "amesbury");
    seedCrawlSet(db, { id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });
    seedCrawlItem(db, { id: 100, crawl_set_id: null, crawl_type: "need", start: "2026-09-05 18:00:00.000000", foodbank_id: 1 });
    seedCrawlItem(db, { id: 101, crawl_set_id: null, crawl_type: "article", start: "2026-09-05 17:00:00.000000", foodbank_id: 1 });
    seedCrawlItem(db, { id: 102, crawl_set_id: null, crawl_type: "need", start: "2026-09-05 16:00:00.000000", foodbank_id: 2 });
    // Right type, WRONG list -- this one belongs to a sweep.
    seedCrawlItem(db, { id: 103, crawl_set_id: 10, crawl_type: "need", start: "2026-09-05 19:00:00.000000", foodbank_id: 1 });
    // Differently-cased, and excluded: this clause is `=`, and SQLite's `=` is
    // case-sensitive where its LIKE is not. Seeded here so swapping the one
    // for the other -- the "be forgiving about ?adhoc_type=" edit -- fails,
    // rather than silently widening a filter the 403 gate has already narrowed.
    seedCrawlItem(db, { id: 104, crawl_set_id: null, crawl_type: "Need", start: "2026-09-05 15:00:00.000000", foodbank_id: 2 });

    expect((await getOrphanedCrawlItems(d1Session(db), "need", 50)).map((r) => r.id)).toEqual([100, 102]);
    expect((await getOrphanedCrawlItems(d1Session(db), "article", 50)).map((r) => r.id)).toEqual([101]);
    expect((await getOrphanedCrawlItems(d1Session(db), "charity", 50)).map((r) => r.id)).toEqual([]);
  });

  // THE LEFT-JOIN MUTANT, and the reason this test exists at all. Most ad-hoc
  // crawl items find nothing and carry a NULL need_id; a handful point at a
  // FoodbankChange that has since been deleted by hand from the needs admin
  // (D1 declares no foreign keys -- PLAN.md §4.5 -- so nothing cleans the
  // pointer up). Turn `LEFT JOIN foodbankchange` into a plain JOIN and BOTH
  // groups vanish: the Ad Hoc Crawls table silently shrinks to the one row in
  // three that produced a surviving need, which still looks like a populated
  // page. All three shapes are seeded so the swap cannot pass.
  it("keeps items whose need is missing or was never set, via the LEFT JOIN", async () => {
    const db = freshDb();
    seedFoodbank(db, 1, "Salisbury", "salisbury");
    seedNeed(db, 41, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1);
    seedCrawlItem(db, { id: 100, crawl_set_id: null, crawl_type: "need", start: "2026-09-05 18:00:00.000000", foodbank_id: 1, need_id: 41 });
    seedCrawlItem(db, { id: 101, crawl_set_id: null, crawl_type: "need", start: "2026-09-05 17:00:00.000000", foodbank_id: 1, need_id: null });
    // Points at a foodbankchange row that no longer exists.
    seedCrawlItem(db, { id: 102, crawl_set_id: null, crawl_type: "need", start: "2026-09-05 16:00:00.000000", foodbank_id: 1, need_id: 999 });

    const rows = await getOrphanedCrawlItems(d1Session(db), null, 50);
    expect(rows.map((r) => [r.id, r.need_uuid])).toEqual([
      // The 32-char dashless UUID from foodbankchange.need_id -- NOT the
      // crawl item's integer need_id (41). Both are called "need_id" in their
      // own tables, and the template builds /admin/need/<uuid>/ out of this
      // value, so returning the integer would produce a link to nowhere.
      [100, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      [101, null],
      [102, null],
    ]);
  });

  // Cardinality. The join is to a primary key, so one crawl item can only ever
  // produce one row -- but this list is read as "one line per ad-hoc crawl",
  // and a join that fanned out (to foodbankchange.foodbank_id, say, which is
  // NOT unique) would duplicate lines rather than fail. Two needs for the same
  // food bank is exactly the seed that would expose it.
  it("returns one row per crawl item even when the food bank has several needs", async () => {
    const db = freshDb();
    seedFoodbank(db, 1, "Salisbury", "salisbury");
    seedNeed(db, 41, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1);
    seedNeed(db, 42, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 1);
    seedCrawlItem(db, { id: 100, crawl_set_id: null, crawl_type: "need", start: "2026-09-05 18:00:00.000000", foodbank_id: 1, need_id: 41 });

    // Asserted by CONTENT, not by length. A bare toHaveLength(1) would also be
    // satisfied by a join that returned one row carrying the WRONG need -- the
    // other need belonging to the same food bank -- which is the same mistake
    // dressed as the right row count.
    expect((await getOrphanedCrawlItems(d1Session(db), null, 50)).map((r) => [r.id, r.need_uuid])).toEqual([[100, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]]);
  });

  // MIGRATION 0019'S SCAR, tested rather than described. crawlitem never had a
  // cached foodbank_name, but its sibling tables did and this query is the
  // shape that replaced them: the parent's name and slug come off the join,
  // live. Renaming the food bank and re-reading proves it -- a denormalised
  // copy would still say "Salisbury" here, which is how 24 production rows
  // came to disagree with their parent's slug and 404 their own pages.
  it("reads foodbank_name and foodbank_slug live from the parent, never from a copy", async () => {
    const db = freshDb();
    seedFoodbank(db, 1, "Salisbury", "salisbury");
    seedCrawlItem(db, { id: 100, crawl_set_id: null, crawl_type: "need", start: "2026-09-05 18:00:00.000000", foodbank_id: 1, url: "https://example.org/need/" });

    const before = await getOrphanedCrawlItems(d1Session(db), null, 50);
    expect([before[0]!.foodbank_name, before[0]!.foodbank_slug]).toEqual(["Salisbury", "salisbury"]);

    db.prepare("UPDATE foodbank SET name = 'Salisbury Foodbank', slug = 'salisbury-foodbank' WHERE id = 1").run();
    const after = await getOrphanedCrawlItems(d1Session(db), null, 50);
    expect([after[0]!.foodbank_name, after[0]!.foodbank_slug]).toEqual(["Salisbury Foodbank", "salisbury-foodbank"]);
  });

  // Pinned, not endorsed. The food bank join is INNER, matching Django's
  // select_related('foodbank') over a non-nullable FK -- and in Postgres that
  // FK is enforced, so a crawl item without a parent cannot exist. D1 declares
  // no foreign keys, so it can: delete a food bank row and its ad-hoc crawl
  // items stop appearing on this page while still occupying the table. That is
  // a divergence the schema permits and the query cannot see, recorded here so
  // the next person to find an item "missing" from Ad Hoc Crawls knows where
  // it went.
  it("silently drops an item whose food bank row no longer exists", async () => {
    const db = freshDb();
    seedFoodbank(db, 1, "Salisbury", "salisbury");
    seedCrawlItem(db, { id: 100, crawl_set_id: null, crawl_type: "need", start: "2026-09-05 18:00:00.000000", foodbank_id: 1 });
    seedCrawlItem(db, { id: 101, crawl_set_id: null, crawl_type: "need", start: "2026-09-05 17:00:00.000000", foodbank_id: 404 });

    expect((await getOrphanedCrawlItems(d1Session(db), null, 50)).map((r) => r.id)).toEqual([100]);
  });

  it("returns exactly the seven keys the template reads", async () => {
    const db = freshDb();
    seedFoodbank(db, 1, "Salisbury", "salisbury");
    seedNeed(db, 41, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1);
    seedCrawlItem(db, { id: 100, crawl_set_id: null, crawl_type: "check", start: "2026-09-05 18:00:00.000000", foodbank_id: 1, url: "https://example.org/need/", need_id: 41 });

    const [row] = await getOrphanedCrawlItems(d1Session(db), null, 50);
    expect(Object.keys(row!).sort()).toEqual(["crawl_type", "foodbank_name", "foodbank_slug", "id", "need_uuid", "start", "url"]);
    expect({ ...row! }).toEqual({
      id: 100,
      crawl_type: "check",
      start: "2026-09-05 18:00:00.000000",
      url: "https://example.org/need/",
      foodbank_name: "Salisbury",
      foodbank_slug: "salisbury",
      need_uuid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
  });
});

// /admin/jobs/'s "Running Now" panel. There is no Django ancestor for this
// page, so the only specification is the module's own comment -- which makes
// pinning the behaviour more important here, not less.
describe("getRunningCrawlSets", () => {
  const NOW = Date.parse("2026-09-05T19:14:07.000Z");

  // A crawl set is running exactly when finish IS NULL. The finished rows are
  // the overwhelming majority of this table (roughly 4,000 a year accumulate
  // and none is ever deleted before the 30-day prune), so a predicate that
  // stopped filtering would fill the "Running Now" panel with history and
  // report a running_count in the thousands.
  it("returns only crawl sets with no finish", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 1, crawl_type: "need", start: "2026-09-05 19:00:00.000000", finish: null });
    seedCrawlSet(db, { id: 2, crawl_type: "article", start: "2026-09-05 18:20:00.000000", finish: "2026-09-05 18:24:00.000000" });
    seedCrawlSet(db, { id: 3, crawl_type: "charity", start: "2026-09-05 05:30:00.000000", finish: "2026-09-05 05:44:00.000000" });

    expect((await getRunningCrawlSets(d1Session(db), NOW)).map((r) => r.id)).toEqual([1]);
  });

  // No LIMIT, deliberately: the answer is normally nought-to-two rows, and
  // capping it would hide the pile-up that is the only reason to look. Five
  // unfinished rows means something is stuck, and all five must show.
  //
  // Ids scrambled against the starts, as in the two ordering tests above, and
  // `expected`/`remaining` given values whose own descending order is a THIRD
  // sequence again -- so the answer below is start DESC and not any other
  // column's sort. (`ORDER BY expected DESC` survived a mutation run against
  // an earlier version of this test, which left both columns NULL and so made
  // every row tie.)
  //
  // ONE MUTANT THIS CANNOT KILL, and the reason is worth knowing: deleting the
  // ORDER BY altogether still returns these rows in this order, because
  // migration 0023 added `crawlset_running_idx ON crawlset(start DESC) WHERE
  // finish IS NULL` and SQLite scans that partial index to satisfy the WHERE,
  // handing back index order for free. That is a query-plan accident, not a
  // guarantee -- a plan is chosen per statement, and the ORDER BY is what
  // makes the result deterministic if the index is ever dropped or the WHERE
  // widened past its predicate. The test below pins that the index is in fact
  // what answers this query, which is the half of it that CAN be observed.
  it("returns every unfinished set, newest first, with no cap and no reliance on rowid order", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 1, crawl_type: "article", start: "2026-09-05 16:20:00.000000", expected: 300, remaining: 150 });
    seedCrawlSet(db, { id: 2, crawl_type: "need", start: "2026-09-05 19:00:00.000000", expected: 100, remaining: 50 });
    seedCrawlSet(db, { id: 3, crawl_type: "charity", start: "2026-09-05 05:30:00.000000", expected: 500, remaining: 250 });
    seedCrawlSet(db, { id: 4, crawl_type: "article", start: "2026-09-05 18:20:00.000000", expected: 200, remaining: 100 });
    seedCrawlSet(db, { id: 5, crawl_type: "article", start: "2026-09-05 14:20:00.000000", expected: 400, remaining: 200 });

    expect((await getRunningCrawlSets(d1Session(db), NOW)).map((r) => r.id)).toEqual([2, 4, 1, 5, 3]);
  });

  // 0023_crawlset_running_idx.sql exists for exactly this statement, and says
  // so: the panel is loaded by a human waiting for it, crawlset gains roughly
  // 4,000 rows a year and loses none, and the answer is almost always the
  // empty set -- the worst shape a full scan can have, since the whole cost is
  // paid to return nothing.
  //
  // A PARTIAL index only applies while the query's predicate still matches the
  // index's own. Widen `finish IS NULL` by a hair -- `OR finish = ''`, a
  // `crawl_type` condition, `date(finish) IS NULL` -- and SQLite silently
  // stops using it and scans the table instead. Nothing fails, nothing logs;
  // the page just gets slower every year. So the plan is asserted, against the
  // SQL the module itself issued rather than a copy of it retyped here (which
  // would only prove that a string this test wrote can use an index).
  it("is answered from 0023's partial index rather than a scan of the whole crawl history", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 1, crawl_type: "need", start: "2026-09-05 19:00:00.000000" });
    seedCrawlSet(db, { id: 2, crawl_type: "article", start: "2026-09-05 18:20:00.000000", finish: "2026-09-05 18:24:00.000000" });

    let issued = "";
    const recording = { prepare: (sql: string) => ((issued = sql), d1Session(db).prepare(sql)) } as unknown as Session;
    await getRunningCrawlSets(recording, NOW);

    const steps = (db.prepare(`EXPLAIN QUERY PLAN ${issued}`).all() as unknown as { detail: string }[]).map((step) => step.detail);
    expect(steps.join(" | ")).toContain("crawlset_running_idx");
    // A step reading exactly "SCAN crawlset", with no index named, is the
    // regression this guards -- and a temp B-tree would mean the index served
    // the WHERE but not the sort, which is the same page paid for twice.
    expect(steps).not.toContain("SCAN crawlset");
    expect(steps.join(" | ")).not.toContain("TEMP B-TREE");
  });

  // `done` is derived, never stored -- there is no third column to drift out
  // of step with the queue's own countdown. The subtraction is the progress
  // bar's numerator, so getting it backwards (remaining - expected) shows a
  // sweep going backwards from zero. Both endpoints are covered: nothing done
  // yet, and everything done but `finish` not yet stamped (the moment before
  // the consumer closes the set).
  it("derives done as expected minus remaining", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 1, crawl_type: "need", start: "2026-09-05 19:00:00.000000", expected: 1071, remaining: 400 });
    seedCrawlSet(db, { id: 2, crawl_type: "need", start: "2026-09-05 18:00:00.000000", expected: 1071, remaining: 1071 });
    seedCrawlSet(db, { id: 3, crawl_type: "need", start: "2026-09-05 17:00:00.000000", expected: 1071, remaining: 0 });

    const byId = new Map((await getRunningCrawlSets(d1Session(db), NOW)).map((r) => [r.id, r.done]));
    expect(byId.get(1)).toBe(671);
    expect(byId.get(2)).toBe(0);
    expect(byId.get(3)).toBe(1071);
  });

  // expected/remaining are NULLABLE (0008_needcheck.sql) and are NULL for
  // every crawl type that does not run through the render queue -- article and
  // charity sweeps never set them. `done` must stay null there, because the
  // template prints a dash for null and a real number for 0: coercing the NULL
  // to 0 would tell the admin an article crawl had completed no work, which is
  // a claim, where a dash is the truth ("this crawl type does not count").
  // The half-populated row is the one that catches an `??` written where the
  // `&&` belongs.
  it("leaves done null when either expected or remaining is missing", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 1, crawl_type: "article", start: "2026-09-05 19:00:00.000000", expected: null, remaining: null });
    seedCrawlSet(db, { id: 2, crawl_type: "need", start: "2026-09-05 18:00:00.000000", expected: 1071, remaining: null });
    seedCrawlSet(db, { id: 3, crawl_type: "need", start: "2026-09-05 17:00:00.000000", expected: null, remaining: 400 });

    const byId = new Map((await getRunningCrawlSets(d1Session(db), NOW)).map((r) => [r.id, r.done]));
    expect(byId.get(1)).toBeNull();
    expect(byId.get(2)).toBeNull();
    expect(byId.get(3)).toBeNull();
  });

  // running_for is measured from a Django-format TEXT start against a `now` in
  // epoch milliseconds -- two different representations of time, joined by
  // parseD1Timestamp, which is the exact seam where the double-"Z" NaN bug
  // lived in this file's sibling. A NaN here renders as "NaN:NaN:NaN", so it
  // would be visible -- but only to whoever happened to load the page.
  //
  // The second row is the point of the whole panel: an unfinished crawl set is
  // NOT the same thing as a busy one. A row whose consumer died keeps finish
  // NULL forever, and nothing cleans it up, so "3 days, 4:05:06" is how a
  // stuck sweep announces itself.
  it("measures running_for from the stored start, and shows a stuck crawl as days", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 1, crawl_type: "need", start: "2026-09-05 17:00:00.000000" });
    seedCrawlSet(db, { id: 2, crawl_type: "article", start: "2026-09-02 15:09:01.000000" });

    const byId = new Map((await getRunningCrawlSets(d1Session(db), NOW)).map((r) => [r.id, r.running_for]));
    expect(byId.get(1)).toBe("2:14:07");
    expect(byId.get(2)).toBe("3 days, 4:05:06");
  });

  // SUSPECT, PINNED AS-IS. A start in the future -- clock skew between a
  // Worker and whatever wrote the row, or a hand-edited row -- gives a
  // negative duration, and formatTimedelta faithfully reproduces Python's
  // timedelta borrow: one second in the future prints as "-1 day, 23:59:59",
  // not "-0:00:01". That is correct as a port of str(timedelta) and alarming
  // as a "Running for" cell. Asserted rather than fixed because the format is
  // shared with the crawl-set pages, where the same string is Django's own
  // output; changing it here alone would make the two disagree.
  it("prints a future start as timedelta's borrowed negative, not a small negative clock", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 1, crawl_type: "need", start: "2026-09-05 19:14:08.000000" }); // one second after NOW

    expect((await getRunningCrawlSets(d1Session(db), NOW))[0]!.running_for).toBe("-1 day, 23:59:59");
  });

  // `now` defaults to Date.now() so the jobs route can pass one clock into all
  // of its queries; the default has to work anyway, because it is what any
  // future caller that forgets will get. A freshly-started crawl is under a
  // second old, which is "0:00:00" -- and, crucially, not a NaN.
  it("falls back to the current clock when no now is given", async () => {
    const db = freshDb();
    const nowIso = new Date().toISOString();
    // pyDatetime's shape, built from the real clock: space separator, six
    // fractional digits.
    seedCrawlSet(db, { id: 1, crawl_type: "need", start: `${nowIso.slice(0, 10)} ${nowIso.slice(11, 23)}000` });

    expect((await getRunningCrawlSets(d1Session(db)))[0]!.running_for).toBe("0:00:00");
  });

  it("returns exactly the seven keys the template reads", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 1, crawl_type: "need", start: "2026-09-05 17:00:00.000000", expected: 1071, remaining: 400 });

    const [row] = await getRunningCrawlSets(d1Session(db), NOW);
    expect(Object.keys(row!).sort()).toEqual(["crawl_type", "done", "expected", "id", "remaining", "running_for", "start"]);
    expect(row).toEqual({
      id: 1,
      crawl_type: "need",
      start: "2026-09-05 17:00:00.000000",
      expected: 1071,
      remaining: 400,
      done: 671,
      running_for: "2:14:07",
    });
    // `finish` is deliberately NOT selected -- every row this query returns has
    // finish IS NULL by construction, so carrying the column would be a field
    // that is always null pretending to be information.
    expect(row).not.toHaveProperty("finish");
  });
});

// The other half of /admin/jobs/: each cron trigger paired with the last crawl
// set it actually produced. The route builds `new Map(rows.map(r =>
// [r.crawl_type, r]))` from this, so "one row per crawl type" is a contract,
// not an observation.
describe("getCrawlTypeLastRuns", () => {
  // The correlated MAX picks the row with the greatest `start` -- not the
  // greatest id, and not simply the last row inserted. Seeded so the two
  // disagree: within each type the NEWEST run has the LOWEST id. In production
  // they always agree, so a test that did not invert them would happily bless
  // `MAX(c2.id)`.
  it("returns the run with the latest start per type, not the highest id", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 1, crawl_type: "need", start: "2026-09-05 15:00:00.000000", finish: "2026-09-05 17:14:07.000000" });
    seedCrawlSet(db, { id: 7, crawl_type: "need", start: "2026-09-04 15:00:00.000000", finish: "2026-09-04 16:00:00.000000" });
    seedCrawlSet(db, { id: 9, crawl_type: "need", start: "2026-09-03 15:00:00.000000", finish: "2026-09-03 16:00:00.000000" });
    seedCrawlSet(db, { id: 2, crawl_type: "article", start: "2026-09-05 20:20:00.000000", finish: "2026-09-05 20:24:00.000000" });
    seedCrawlSet(db, { id: 8, crawl_type: "article", start: "2026-09-05 18:20:00.000000", finish: "2026-09-05 18:24:00.000000" });

    const rows = await getCrawlTypeLastRuns(d1Session(db));
    expect(rows.map((r) => [r.crawl_type, r.last_set_id])).toEqual([
      ["article", 2],
      ["need", 1],
    ]);
  });

  // One row per type. Six types share this table and every one of them has
  // many rows; drop the correlation (`c2.crawl_type = cs.crawl_type`) and the
  // subquery becomes the whole table's MAX, so only the single most recent
  // crawl set in the database survives and five of the six cron rows on the
  // page lose their "last run" entirely -- rendered as a blank, not an error.
  it("returns exactly one row per crawl type, ordered newest run first", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 1, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });
    seedCrawlSet(db, { id: 2, crawl_type: "need", start: "2026-09-04 15:00:00.000000" });
    seedCrawlSet(db, { id: 3, crawl_type: "article", start: "2026-09-05 20:20:00.000000" });
    seedCrawlSet(db, { id: 4, crawl_type: "article", start: "2026-09-05 18:20:00.000000" });
    seedCrawlSet(db, { id: 5, crawl_type: "charity", start: "2026-09-05 05:30:00.000000" });
    seedCrawlSet(db, { id: 6, crawl_type: "charity", start: "2026-09-04 05:30:00.000000" });

    const rows = await getCrawlTypeLastRuns(d1Session(db));
    expect(rows.map((r) => r.crawl_type)).toEqual(["article", "need", "charity"]);
  });

  // A type that has never run is ABSENT, not a row of nulls -- jobs.ts's
  // lastByType.get() returns undefined and the page shows the schedule with no
  // last run against it. `discrepancy`, `check` and `urls` are all in
  // CRAWL_TYPE_OPTIONS and none of them writes a crawl set today, so this is
  // the normal state of half the allowlist rather than an edge case.
  it("omits crawl types that have never produced a set", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 1, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });

    const rows = await getCrawlTypeLastRuns(d1Session(db));
    expect(rows.map((r) => r.crawl_type)).toEqual(["need"]);
    expect(await getCrawlTypeLastRuns(d1Session(freshDb()))).toEqual([]);
  });

  // The row chosen is the latest STARTED, regardless of whether it finished --
  // so a sweep that is running (or stuck) right now reports last_finish null
  // even though an older run of the same type has a perfectly good finish
  // sitting next to it. That is the intended reading: the pairing is "the last
  // thing this cron did", and the answer is "it started and has not come
  // back". A query that fell back to the newest FINISHED row would show a
  // reassuring completion time for a crawl that is currently stuck.
  it("reports last_finish as null when the newest run of a type is unfinished", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 1, crawl_type: "need", start: "2026-09-05 15:00:00.000000", finish: null });
    seedCrawlSet(db, { id: 2, crawl_type: "need", start: "2026-09-04 15:00:00.000000", finish: "2026-09-04 16:04:32.000000" });

    expect(await getCrawlTypeLastRuns(d1Session(db))).toEqual([
      { crawl_type: "need", last_start: "2026-09-05 15:00:00.000000", last_finish: null, last_set_id: 1 },
    ]);
  });

  // SUSPECT, PINNED AS-IS. `WHERE cs.start = (SELECT MAX(...))` is an equality
  // against a value, not a pick of one row, so two crawl sets of the same type
  // sharing a start to the microsecond both come back -- and the "one row per
  // type" contract quietly stops holding. jobs.ts feeds these into a Map keyed
  // by crawl_type, so the SECOND one wins, and which one that is depends on
  // the ORDER BY resolving a tie it cannot resolve.
  //
  // Reachable but unlikely: crawlset.start is pyNow() at millisecond
  // resolution, and crawlset_runid_uniq already stops the duplicate-cron case
  // for the types that set a run_id. Recorded rather than fixed because a fix
  // (MIN(id) as a tie-break, or a window function) is a behaviour change, and
  // this file pins behaviour.
  it("returns BOTH rows when two sets of a type share an identical start", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 1, crawl_type: "article", start: "2026-09-05 20:20:00.000000", finish: "2026-09-05 20:24:00.000000" });
    seedCrawlSet(db, { id: 2, crawl_type: "article", start: "2026-09-05 20:20:00.000000", finish: null });

    const rows = await getCrawlTypeLastRuns(d1Session(db));
    expect(rows.map((r) => r.last_set_id).sort()).toEqual([1, 2]);
    expect(rows.map((r) => r.crawl_type)).toEqual(["article", "article"]);
  });

  it("returns exactly the four keys the jobs page reads", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 3, crawl_type: "charity", start: "2026-09-05 05:30:00.000000", finish: "2026-09-05 05:34:32.000000" });

    const [row] = await getCrawlTypeLastRuns(d1Session(db));
    expect(Object.keys(row!).sort()).toEqual(["crawl_type", "last_finish", "last_set_id", "last_start"]);
    expect({ ...row! }).toEqual({
      crawl_type: "charity",
      last_start: "2026-09-05 05:30:00.000000",
      last_finish: "2026-09-05 05:34:32.000000",
      last_set_id: 3,
    });
  });
});
