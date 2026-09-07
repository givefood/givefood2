import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "./schema.testkit";
import { describe, expect, it } from "vitest";
import { pyDatetime } from "@givefood/models";
import { finishStaleCrawlSets, pruneCrawlItems, pruneCrawlSets, updateDaysBetweenNeeds } from "./maintenance";
import type { Session } from "./types";

// The four statements the maintenance crons run (workers/jobs/src/scheduled/
// index.ts: `daysBetweenNeeds` weekly, `crawlItemPrune` nightly). Every one of
// them is a WRITE, which makes this the one module in the package whose
// failures are worse than returning the wrong rows -- two of them DELETE, and
// a delete that takes the wrong rows leaves nothing behind to notice.
//
// WHY A REAL DATABASE, NOT A MOCK. The module is four SQL strings and one
// `for` loop. A session that hands back a canned `meta.changes` proves the
// loop can add up numbers; it says nothing about which rows the DELETE takes,
// which is the entire content of the file. The mutants that matter here are
// not "returns nothing":
//
//   * `datetime('now','-30 days')` replaced by a JS `toISOString()` bind.
//     Stored timestamps are Django-format TEXT ("2026-09-05 19:28:08.853000")
//     and the comparison is byte-wise, so an ISO threshold ("2026-09-05T...")
//     sorts ABOVE every row in the table -- 'T' is 0x54, ' ' is 0x20. The
//     prune then deletes 5,000 live crawl items per statement, fifty times a
//     night, and reports a cheerful count in the log. See pyDatetime.ts's
//     header for the two places this exact substitution has already been live.
//   * `WHERE is_closed = 0` dropped from the days_between_needs UPDATE, which
//     silently starts rewriting closed food banks' history.
//   * the ceiling-then-divide arithmetic simplified to the obvious
//     `CAST(elapsed / 5 AS INTEGER)`, which is right for most inputs and
//     wrong at every 5-day boundary -- the module's own header calls this
//     out, and four of the nine elapsed values asserted below are chosen
//     precisely because the two formulas disagree there.
//
// None of those throws. So the statements below are run, by SQLite, against
// the real schema.
//
// THE FIXTURE IS THE MIGRATION FILES THEMSELVES, applied in order (the same
// choice, for the same reason, as crawlSets.test.ts and adminDashboardStats
// .test.ts): a CREATE TABLE transcribed into a test file is a second copy of
// the truth and drifts from the first. Five facts it supplies that these
// tests depend on and a hand-written schema would likely have got wrong:
//   * `foodbank.days_between_needs` is INTEGER **NOT NULL** (0001_core.sql).
//     That constraint is why the COALESCE in the UPDATE is load-bearing
//     rather than tidy: run the same statement without it against a food bank
//     with fewer than five needs and SQLite raises "NOT NULL constraint
//     failed: foodbank.days_between_needs" (executed, not assumed). It is the
//     only part of this module that fails loudly.
//   * `foodbankchange.foodbank_id` is NULLABLE, so needs really can belong to
//     no food bank and the window function really does get a NULL partition.
//   * `foodbankchange.nonpertinent` is NULLABLE too, and 0001_core.sql spells
//     out why that matters -- "NULLABLE: NULL is NOT 0". A transcribed schema
//     would almost certainly have written NOT NULL DEFAULT 0 and hidden the
//     `nonpertinent = 0` mutant described below.
//   * `crawlitem.foodbank_id` is NOT NULL, which is why a `foodbank_id IS NOT
//     NULL` guard on the prune is an equivalent mutant rather than a hole.
//   * `crawlitem_crawlset_foodbank_uniq` is UNIQUE(crawl_set_id, foodbank_id)
//     -- one item per food bank per crawl set -- so every multi-item set
//     seeded here spans several food banks, as production's do. NULLs compare
//     distinct in a SQLite unique index, which is why the bulk seeds below can
//     put a quarter of a million items in no crawl set at all.
//
// PARITY WAS RUN, NOT REASONED ABOUT (TESTING.md's rule). Every elapsed value
// in the days_between_needs table below was put through CPython in the shape
// days_between_needs.py actually computes it --
// `int(-timedelta(days=-e).days / 5)` -- and the expected column is what
// Python printed, not what this port produced.
//
// MUTATION-TESTED (the evidence a test is load-bearing rather than
// decoration). The module was copied into a scratchpad, broken 102 ways, and
// this file re-run against each. Among the dead: the naive
// `CAST(elapsed / 5)`; `is_closed = 0` dropped and inverted; `rn = 5` moved to
// 1, to 4, to `>= 5` and to `= 5`; `ORDER BY created DESC` turned ASC and
// re-pointed at id and at modified; the PARTITION BY dropped from the
// ROW_NUMBER; the subquery's correlation dropped and re-pointed at another
// column; the COALESCE removed and its default changed; the elapsed
// subtraction reversed and measured from `modified`; `published = 1` and
// `nonpertinent = 0` filters added to the ranked CTE; a `modified` bump added
// to the UPDATE; the divisor changed to 7; both 30-day windows moved and the
// `<` flipped; both thresholds swapped for a `strftime('%Y-%m-%dT%H:%M:%fZ')`
// ISO rendering; the chunk LIMIT moved in both directions and dropped
// entirely; the `break` on an empty batch removed; the 50-iteration bound
// moved both ways and removed; `totalDeleted +=` turned into `=`; both prune
// return values stubbed; `crawl_set_id IS NOT NULL`, `finish IS NOT NULL`,
// `remaining = 0` and `run_id IS NOT NULL` added to the prunes; a cascade
// delete added to pruneCrawlSets; the stale window moved to 30 minutes, 23
// hours, 25 hours and 10 days and dropped; the stale age guard re-pointed at
// `finish`; `finish IS NULL` dropped, negated and rewritten as `= NULL`;
// `max(finish)` turned into `min(finish)`, `max(start)` and `datetime('now')`;
// the stale correlation dropped and re-pointed at foodbank_id; and a
// `remaining = 0` write added alongside the stale stamp.
//
// TWELVE of those mutants survived an earlier version of this file and were
// killed by strengthening it, not by being explained away. Nine of the twelve
// lived for the same reason -- A FIXTURE THAT ONLY EVER SEEDED ONE VALUE, so
// the filter or column that told the values apart was never exercised. That
// is the failure mode to watch for when adding to this file. Each is named in
// the comment of the test that now kills it, so deleting that test is a
// visible loss:
//   * `nonpertinent = 0` added to the CTE -- every fixture row wrote 0, and
//     the column is NULLABLE, so on production that clause drops nearly the
//     whole table.
//   * `SET modified = ..., days_between_needs = ...` -- nothing checked the
//     other columns.
//   * `ORDER BY modified`, `julianday(modified)`, and `modified AS created`
//     -- every fixture wrote modified equal to created.
//   * `AND no_locations = 0` on the UPDATE -- every fixture wrote 0.
//   * `AND crawl_type = 'need'` on both prunes and on the stale stamp --
//     every fixture wrote 'need', though four cron families write these
//     tables.
//   * `SET remaining = 0` alongside the stale stamp -- nothing checked.
//   * `SELECT foodbank_id` for `SELECT id` in the item prune's chunk
//     subquery -- every fixture set the two columns to the same number, so
//     the wrong column deleted exactly the right rows.
//   * the stale window narrowed to `'-23 hours'` -- it sat exactly on the
//     fixture's own age, so whether it was caught depended on which side of a
//     second the clock happened to fall.
//   * `(CAST(x AS INTEGER) + (... < x))` replaced by `(CAST(x AS INTEGER)
//     + 1)`, previously recorded here as unkillable. It is, for positive
//     elapsed. It is not for NEGATIVE elapsed, where CAST truncates toward
//     zero instead of flooring -- see the future-dated-need test.
//
// THE REMAINING SURVIVORS are equivalent mutants: they change the SQL without
// changing what it can ever do, so no fixture can distinguish them. Listed so
// the next reader does not spend an afternoon rediscovering them:
//   * `n >= 5` relaxed to `n >= 1`, and `COUNT(*) OVER (PARTITION BY
//     foodbank_id)` relaxed to `COUNT(*) OVER ()`. `rn = 5` cannot exist in a
//     partition of fewer than five rows, so the whole `n` clause is redundant
//     however it is computed.
//   * `WHERE foodbank_id IS NOT NULL` added to the ranked CTE. The ownerless
//     partition is already unreachable: `f.foodbank_id = foodbank.id` is NULL,
//     never true, for those rows.
//   * `=` written as `IS` in either correlation, and `is_closed = 0` as
//     `is_closed IS 0`. Identical in SQLite for operands that are never NULL,
//     which these (INTEGER PRIMARY KEY, NOT NULL) are.
//   * `id IN (...)` written as `rowid IN (...)`. crawlitem.id is INTEGER
//     PRIMARY KEY, i.e. the rowid itself.
//   * `AND foodbank_id IS NOT NULL` on the item prune. crawlitem.foodbank_id
//     is NOT NULL in 0008_needcheck.sql; no such row can exist.
//   * `julianday('now')` written as `julianday(datetime('now'))`, which
//     truncates to the second. Every elapsed value in this file is minutes or
//     more from a 5-day boundary, and no test can put one within a second of
//     it without racing the clock.
//   * an `ORDER BY` added inside the item prune's chunk SELECT. Which 250,000
//     of 250,001 rows a capped run takes is deliberately not asserted -- see
//     that test -- because the statement itself does not specify it.
//   * `start <` relaxed to `start <=` in either prune. `datetime()` renders
//     seconds with NO fractional part, and every stored timestamp is Django's
//     `.ffffff` format, so no row's `start` can ever be byte-equal to the
//     threshold -- the equality branch is unreachable by construction.
//   * `totalDeleted += deleted` moved after the `break`. The batch it would
//     skip is by definition the one that deleted 0.
//   * an `EXISTS (SELECT 1 FROM crawlitem ...)` guard added to the stale
//     UPDATE. The rows it excludes are exactly the ones the UPDATE writes
//     NULL over, which is what they already hold; only `meta.changes` differs,
//     and finishStaleCrawlSets returns void.
//   * `AND crawl_type = crawlset.crawl_type` added to the stale subquery. Not
//     provably equivalent, but unreachable in practice: insertCrawlItem
//     (needcheck.ts) is only ever called with its crawl set's own type, so no
//     item can disagree with its set.

type Bindable = null | number | bigint | string | Uint8Array;

// The slice of the D1 Sessions API this package is handed, backed by
// node:sqlite. Copied from crawlSets.test.ts (itself copied from
// workers/site/src/routes/admin/foodbankLocation.test.ts) so every tier drives
// the real code through one adapter, WITH ONE ADDITION shared with
// articles.test.ts and adminLists.test.ts: `run()` returns a real
// `meta.changes`, because this module does not just report it, it LOOPS on it.
// The copies that answer `meta: {}` would make pruneCrawlItems read
// `undefined`, add it to its total (NaN) and never reach its `=== 0` break --
// fifty statements a night and a NaN in the log. `Number()` because
// node:sqlite can answer a bigint where D1 answers a number, and
// `deleted === 0` is strict: `0n === 0` is false, so a bigint zero would spin
// the loop to its cap against an empty table every single night.
//
// `log` records the SQL of every statement prepared, which is how the chunking
// tests below count round trips. It interprets nothing -- the engine decides
// which rows come back, not this file.
function d1Session(db: DatabaseSync, log?: string[]): Session {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      const result = db.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql: string) => {
      log?.push(sql);
      return statement(sql, []);
    },
    getBookmark: () => null,
  } as unknown as Session;
}

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return db;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// A Django-format timestamp `ms` milliseconds before the real clock, built by
// the SAME helper the production write path uses (pyNow() is pyDatetime(new
// Date())), so the fixture is byte-identical in shape to what the app stores.
//
// THE CLOCK IS REAL AND THAT IS NOT NEGOTIABLE: three of the four statements
// here read SQLite's own `now`, which no test can freeze. So every boundary
// below is seeded with MINUTES of margin rather than microseconds -- a fixture
// sitting exactly on the 30-day line would flip whenever the second ticked
// between the INSERT and the DELETE, and a flaky maintenance test is worse
// than none.
function ago(ms: number): string {
  return pyDatetime(new Date(Date.now() - ms));
}

function seedFoodbank(
  db: DatabaseSync,
  id: number,
  options: { closed?: boolean; noLocations?: boolean; daysBetweenNeeds?: number } = {},
): void {
  db.prepare(
    `INSERT INTO foodbank (
       id, uuid, name, slug, address, postcode, country, lat_lng,
       charity_just_foodbank, contact_email, url, shopping_list_url,
       address_is_administrative, is_closed, no_locations, days_between_needs,
       created, modified
     ) VALUES (?, ?, ?, ?, 'Address', 'SP2 9DY', 'England', '51.06,-1.79',
       0, 'info@example.org', 'https://example.org/', 'https://example.org/list/',
       0, ?, ?, ?,
       '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run(
    id,
    `uuid-${id}`,
    `Food Bank ${id}`,
    `food-bank-${id}`,
    options.closed ? 1 : 0,
    options.noLocations ? 1 : 0,
    options.daysBetweenNeeds ?? 7,
  );
}

function daysBetweenNeedsOf(db: DatabaseSync, id: number): number {
  return (db.prepare("SELECT days_between_needs AS d FROM foodbank WHERE id = ?").get(id) as { d: number }).d;
}

// Every foodbank column EXCEPT the one this cron is allowed to write. The
// UPDATE names a single column, so the honest assertion is not "modified is
// unchanged" but "nothing else moved at all" -- which holds against any
// careless `SET x = ..., days_between_needs = ...`, not just the one mutant
// anybody happened to think of. Kills: `SET modified = <anything>, ...` added
// alongside (see the divergence note on the test that uses this).
function foodbankRowsExceptScore(db: DatabaseSync): Record<string, unknown>[] {
  return (db.prepare("SELECT * FROM foodbank ORDER BY id").all() as Record<string, unknown>[]).map((row) => {
    const copy = { ...row };
    delete copy.days_between_needs;
    return copy;
  });
}

// THE DEFAULTS ARE THE ADVERSARIAL PART OF THIS HELPER, not an afterthought.
// days_between_needs.py filters on foodbank alone
// (`FoodbankChange.objects.filter(foodbank=foodbank).order_by("-created")[:5]`)
// with no published clause, and the port must not have grown one. Nearly every
// other query over this table in the package does filter it, so the instinct
// to "fix" this statement by adding `WHERE published = 1` is a live one -- and
// so is the matching instinct for `nonpertinent`.
//
//   * `published` defaults to 0, the UNPUBLISHED shape.
//   * `nonpertinent` defaults to **NULL**, not 0, because 0001_core.sql
//     declares it `INTEGER` with the comment "NULLABLE: NULL is NOT 0" and
//     that is what production holds for most rows. A fixture that wrote 0
//     everywhere would let `WHERE nonpertinent = 0` -- which in SQLite
//     silently drops every NULL row, the `!=`-against-NULL bug class this
//     package has already been bitten by -- pass every test in the file.
//     (It did: that mutant survived the first version of this suite.)
//   * `modified` defaults to a value DIFFERENT from `created`, offset a few
//     days later, because Django reads `needs[4].created` and a fixture that
//     sets the two equal cannot tell `ORDER BY created` from `ORDER BY
//     modified`, nor `julianday(created)` from `julianday(modified)`. Three
//     such mutants survived until this default changed. Later, not earlier,
//     because a need is edited after it is scraped, never before.
function threeDaysAfter(created: string): string {
  const ms = Date.parse(`${created.replace(" ", "T")}Z`);
  // The unparseable-created test seeds a string that is not a timestamp at
  // all; keep it verbatim rather than storing "NaN-NaN-NaN" in a NOT NULL
  // column and making that test's failure mode about the fixture.
  return Number.isNaN(ms) ? created : pyDatetime(new Date(ms + 3 * DAY_MS));
}

let nextNeedRowId = 1;
function seedNeed(
  db: DatabaseSync,
  foodbankId: number | null,
  created: string,
  options: { published?: number; nonpertinent?: number | null; modified?: string } = {},
): number {
  const id = nextNeedRowId++;
  db.prepare(
    `INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, published, nonpertinent, input_method, created, modified)
     VALUES (?, ?, ?, 'Beans, Rice', ?, ?, 'scrape', ?, ?)`,
  ).run(
    id,
    `need${String(id).padStart(28, "0")}`,
    foodbankId,
    options.published ?? 0,
    options.nonpertinent ?? null,
    created,
    options.modified ?? threeDaysAfter(created),
  );
  return id;
}

// Five needs for one food bank: four clustered in the last few hours, and the
// FIFTH -- the only one Django's formula reads -- `elapsedDays` in the past.
// The four recent ones are what make this a real test of "the fifth": they sit
// where a query that picked the newest, or the mean, or the oldest would land
// on a completely different answer.
function seedFiveNeeds(db: DatabaseSync, foodbankId: number, elapsedDays: number): void {
  for (let i = 0; i < 4; i++) seedNeed(db, foodbankId, ago((i + 1) * HOUR_MS));
  seedNeed(db, foodbankId, ago(elapsedDays * DAY_MS));
}

interface CrawlSetSeed {
  id: number;
  crawl_type?: string;
  start: string;
  finish?: string | null;
}

function seedCrawlSet(db: DatabaseSync, cs: CrawlSetSeed): void {
  db.prepare(`INSERT INTO crawlset (id, crawl_type, run_id, start, finish, expected, remaining) VALUES (?, ?, NULL, ?, ?, NULL, NULL)`).run(
    cs.id,
    cs.crawl_type ?? "need",
    cs.start,
    cs.finish ?? null,
  );
}

interface CrawlItemSeed {
  id: number;
  crawl_set_id: number | null;
  crawl_type?: string;
  start: string;
  finish?: string | null;
  foodbank_id?: number;
}

// `foodbank_id` defaults to the row's own id PLUS 500, so that several items
// in one crawl set never collide on crawlitem_crawlset_foodbank_uniq and --
// the reason for the offset -- so that `id` and `foodbank_id` are never the
// same number. They are both INTEGER and both plausible things to name in
// `DELETE FROM crawlitem WHERE id IN (SELECT ? FROM crawlitem ...)`; with the
// fixture setting them equal, `SELECT foodbank_id` in place of `SELECT id`
// deleted exactly the same rows and every test passed. On production the two
// are unrelated, so that mutant would delete an arbitrary set of rows by
// coincidence of numbering -- a silent wrong-rows DELETE, which is the worst
// failure this module has. D1 declares no foreign keys (PLAN.md §4.5), so
// these ids need no foodbank row behind them and none of the three crawl
// statements joins to one.
//
// `crawl_type` is a parameter, and several tests below pass something other
// than "need", because four cron families write this table -- need
// (needcheckRender.ts), article (articles.ts), charity (charity.ts) and
// discrepancy -- and NONE of the three statements in maintenance.ts mentions
// crawl_type. A fixture that only ever seeded "need" let `AND crawl_type =
// 'need'` be added to the prune and to the stale-set stamp without a single
// test noticing; the article and charity histories would then have grown
// forever and their stalled sets never been closed.
function seedCrawlItem(db: DatabaseSync, ci: CrawlItemSeed): void {
  db.prepare(`INSERT INTO crawlitem (id, crawl_set_id, crawl_type, start, finish, foodbank_id, url, need_id) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`).run(
    ci.id,
    ci.crawl_set_id,
    ci.crawl_type ?? "need",
    ci.start,
    ci.finish ?? null,
    ci.foodbank_id ?? ci.id + 500,
  );
}

// A quarter of a million rows through a prepared INSERT would dominate the
// suite's runtime; one recursive CTE seeds them in ~150ms. That matters
// because reaching pruneCrawlItems' 50-statement cap with REAL rows -- rather
// than a stub that says "5000" fifty times -- is the only way to prove the cap
// leaves the remainder behind instead of the loop silently running short.
function seedManyCrawlItems(db: DatabaseSync, count: number, start: string): void {
  // `n + 1000000` for foodbank_id, for the same reason seedCrawlItem offsets
  // by 500: id and foodbank_id must never coincide, or a statement that reads
  // the wrong one of the two looks correct.
  db.exec(`
    WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${count})
    INSERT INTO crawlitem (id, crawl_set_id, crawl_type, start, finish, foodbank_id, url, need_id)
    SELECT n, NULL, 'need', '${start}', NULL, n + 1000000, NULL, NULL FROM seq`);
}

function seedManyCrawlSets(db: DatabaseSync, count: number, start: string): void {
  db.exec(`
    WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${count})
    INSERT INTO crawlset (id, crawl_type, run_id, start, finish, expected, remaining)
    SELECT n, 'need', NULL, '${start}', NULL, NULL, NULL FROM seq`);
}

const countRows = (db: DatabaseSync, table: string): number => (db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c;

describe("updateDaysBetweenNeeds", () => {
  // THE HEADLINE CASE, and the reason the SQL is shaped the way it is.
  // Django computes `int(-((needs[4].created - now()).days) / 5)`: Python's
  // `.days` on a NEGATIVE timedelta floors toward -infinity BEFORE the
  // division, so 9.99 elapsed days is floor(-9.99) = -10, then int(10/5) = 2.
  // The obvious SQL -- `CAST(elapsed / 5 AS INTEGER)` -- computes
  // int(9.99/5) = 1 and is wrong for the whole final day of every 5-day
  // band. One day out on a "days between needs" figure is not visible on the
  // page; it is just a slightly different number.
  //
  // Verified in CPython, not inferred: timedelta(days=-9.99).days is -10.
  it("floors the elapsed days BEFORE dividing, as Python's timedelta.days does", async () => {
    const db = freshDb();
    seedFoodbank(db, 1);
    seedFiveNeeds(db, 1, 9.99);

    await updateDaysBetweenNeeds(d1Session(db));

    expect(daysBetweenNeedsOf(db, 1)).toBe(2); // the naive CAST(elapsed / 5) mutant answers 1
  });

  // The whole curve, in one table. Each `expected` is what CPython printed
  // for `int(-timedelta(days=-elapsed).days / 5)`; the `naive` column is what
  // `CAST(elapsed / 5 AS INTEGER)` would have answered, and the four rows
  // where the two disagree are the point of seeding nine food banks instead
  // of one. 5.0001 and 35.0001 are the other half of the story -- just past a
  // whole number, where the ceiling adds a day and both formulas still agree
  // -- so a mutant that ALWAYS ceilinged an extra day fails too.
  it("matches Django's formula across the 5-day bands, including where the naive division disagrees", async () => {
    const db = freshDb();
    const cases = [
      { elapsed: 0.2, expected: 0, naive: 0 },
      { elapsed: 3.5, expected: 0, naive: 0 },
      { elapsed: 4.5, expected: 1, naive: 0 },
      { elapsed: 5.0001, expected: 1, naive: 1 },
      { elapsed: 9.99, expected: 2, naive: 1 },
      { elapsed: 10.01, expected: 2, naive: 2 },
      { elapsed: 14.2, expected: 3, naive: 2 },
      { elapsed: 19.5, expected: 4, naive: 3 },
      { elapsed: 35.0001, expected: 7, naive: 7 },
    ];
    cases.forEach((c, index) => {
      seedFoodbank(db, index + 1);
      seedFiveNeeds(db, index + 1, c.elapsed);
    });

    await updateDaysBetweenNeeds(d1Session(db));

    expect(cases.map((c, index) => daysBetweenNeedsOf(db, index + 1))).toEqual(cases.map((c) => c.expected));
    // Not decoration: if this ever stops holding, the table above has lost
    // the cases that make it worth running.
    expect(cases.filter((c) => c.expected !== c.naive)).toHaveLength(4);
  });

  // `needs[4]` -- the fifth newest, counting from the most recent. Ordering is
  // by the stored `created` TEXT, so the ids are seeded DELIBERATELY OUT OF
  // STEP with the dates here: in production rows are only ever appended and
  // the two agree, which would let an `ORDER BY id DESC` mutant live forever.
  // The sixth and seventh needs are much older and would give 80 and 160; the
  // newest would give 0. Only reading the fifth gives 4.
  it("reads the FIFTH newest need by created, not by insertion order, and ignores older ones", async () => {
    const db = freshDb();
    seedFoodbank(db, 1);
    seedNeed(db, 1, ago(800 * DAY_MS)); // id 1, the oldest row -- inserted first
    seedNeed(db, 1, ago(400 * DAY_MS)); // id 2
    seedNeed(db, 1, ago(19.5 * DAY_MS)); // id 3 -- the fifth newest
    seedNeed(db, 1, ago(2 * HOUR_MS)); // id 4
    seedNeed(db, 1, ago(1 * HOUR_MS)); // id 5 -- the newest
    seedNeed(db, 1, ago(4 * HOUR_MS)); // id 6
    seedNeed(db, 1, ago(3 * HOUR_MS)); // id 7

    await updateDaysBetweenNeeds(d1Session(db));

    expect(daysBetweenNeedsOf(db, 1)).toBe(4);
  });

  // `if len(needs) == number_of_needs` in Django, `rn = 5` here: four needs is
  // not enough evidence and the answer is 0, not "as often as the four we
  // have". The pre-seeded 7 and 9 are what makes this a test -- the value must
  // be OVERWRITTEN, because a food bank that has gone quiet keeps whatever it
  // last scored until this cron reduces it, and a stale 7 on a closed-down
  // service is exactly the wrong thing to publish.
  it("scores 0 for a food bank with fewer than five needs, overwriting whatever was there", async () => {
    const db = freshDb();
    seedFoodbank(db, 1, { daysBetweenNeeds: 7 });
    seedFoodbank(db, 2, { daysBetweenNeeds: 9 });
    for (let i = 1; i <= 4; i++) seedNeed(db, 1, ago(i * 10 * DAY_MS));
    // Food bank 2 has never had a need at all.

    await updateDaysBetweenNeeds(d1Session(db));

    expect(daysBetweenNeedsOf(db, 1)).toBe(0);
    expect(daysBetweenNeedsOf(db, 2)).toBe(0);
  });

  // `get_all_open_foodbanks()` is `Foodbank.objects.filter(is_closed=False)`
  // -- ONE clause, nothing else. So a closed food bank is never touched and
  // keeps the figure it had when it closed. Seeded with five needs that WOULD
  // score 4, and a stored 42 that no formula could produce, so dropping
  // `WHERE is_closed = 0` cannot look like a coincidence. The open food bank
  // alongside it proves the statement still does its job with the filter in
  // place -- a WHERE that matched nothing would pass an assertion made only
  // about the closed row.
  //
  // Food bank 3 is the OTHER half of "one clause": `no_locations = 1` (a food
  // bank that operates without a published location list) is open, is in
  // Django's queryset, and must be scored like any other. Until it was seeded
  // here every fixture in the file wrote no_locations = 0, so a
  // `WHERE is_closed = 0 AND no_locations = 0` mutant survived the whole
  // suite -- the classic filter that passes because nothing was seeded to
  // exclude.
  it("never touches a closed food bank, and still updates the open ones beside it", async () => {
    const db = freshDb();
    seedFoodbank(db, 1, { closed: true, daysBetweenNeeds: 42 });
    seedFoodbank(db, 2, { daysBetweenNeeds: 42 });
    seedFoodbank(db, 3, { noLocations: true, daysBetweenNeeds: 42 });
    seedFiveNeeds(db, 1, 19.5);
    seedFiveNeeds(db, 2, 19.5);
    seedFiveNeeds(db, 3, 19.5);

    await updateDaysBetweenNeeds(d1Session(db));

    expect(daysBetweenNeedsOf(db, 1)).toBe(42);
    expect(daysBetweenNeedsOf(db, 2)).toBe(4);
    expect(daysBetweenNeedsOf(db, 3)).toBe(4);
  });

  // THE DIVERGENCE FROM DJANGO, pinned rather than hidden. days_between_needs
  // .py calls `foodbank.save(...)` on all ~1,023 open food banks every week,
  // and Foodbank extends TimestampedModel, whose `modified` is
  // `auto_now=True` (givefood/models/base.py:16) -- so on Django the weekly
  // cron bumped every open food bank's `modified`, whether or not the number
  // changed. This port writes one column and leaves `modified` alone.
  //
  // That is user-visible, not cosmetic: /frag/ 's "last-updated" is
  // `MAX(modified) FROM foodbank` (getLastModifiedFoodbank, frag.ts), so on
  // Django the site advertised "last updated" as the moment this cron last
  // ran. Here it advertises the last real edit. The port's behaviour is the
  // more truthful one and is NOT proposed for change -- it is asserted so
  // that "fixing" the parity gap is a deliberate, visible decision.
  //
  // Asserted as "every column except days_between_needs is byte-identical",
  // which also kills any other stray write: `SET edited = ...`,
  // `SET footprint = ...`, a mutant that stamps `modified` with a literal.
  it("writes days_between_needs and nothing else -- unlike Django's save(), it never bumps modified", async () => {
    const db = freshDb();
    seedFoodbank(db, 1, { daysBetweenNeeds: 42 });
    seedFoodbank(db, 2, { closed: true, daysBetweenNeeds: 42 });
    seedFiveNeeds(db, 1, 19.5);
    seedFiveNeeds(db, 2, 19.5);
    const before = foodbankRowsExceptScore(db);

    await updateDaysBetweenNeeds(d1Session(db));

    expect(foodbankRowsExceptScore(db)).toEqual(before);
    // ...and the statement really did run, so the assertion above is not
    // passing because nothing happened at all.
    expect(daysBetweenNeedsOf(db, 1)).toBe(4);
  });

  // `needs[4].created` -- CREATED, not `modified`. Django orders by
  // "-created" and reads `.created`; both are the scrape time, and `modified`
  // moves whenever a need is edited afterwards in gfwrite.
  //
  // Every other test in this file would pass with `created` and `modified`
  // swapped throughout, because a need is normally written once and the two
  // agree. Here they are deliberately in OPPOSITE order: the oldest need by
  // `created` is the newest by `modified`. Three mutants died on this and no
  // other test in the file:
  //   * `ORDER BY modified DESC` in the ROW_NUMBER -- picks the 1-hour-old
  //     need as the fifth and scores 0;
  //   * `julianday(modified)` in the elapsed subtraction -- right row, wrong
  //     column, scores 0;
  //   * `SELECT foodbank_id, modified AS created` in the CTE -- both at once,
  //     scores 8.
  // The real statement scores 4.
  it("ranks and measures by created, never by modified", async () => {
    const db = freshDb();
    seedFoodbank(db, 1);
    seedNeed(db, 1, ago(1 * HOUR_MS), { modified: ago(40 * DAY_MS) });
    seedNeed(db, 1, ago(2 * HOUR_MS), { modified: ago(39 * DAY_MS) });
    seedNeed(db, 1, ago(3 * HOUR_MS), { modified: ago(38 * DAY_MS) });
    seedNeed(db, 1, ago(4 * HOUR_MS), { modified: ago(37 * DAY_MS) });
    seedNeed(db, 1, ago(19.5 * DAY_MS), { modified: ago(1 * MINUTE_MS) });

    await updateDaysBetweenNeeds(d1Session(db));

    expect(daysBetweenNeedsOf(db, 1)).toBe(4);
  });

  // The correlation, which is doing the work Django's per-food-bank loop did.
  // Drop `f.foodbank_id = foodbank.id` (or the PARTITION BY that feeds it) and
  // every food bank in the country gets whichever row the subquery happened to
  // return -- a page of plausible numbers, all wrong but one. Food bank 2 has
  // only two needs and MUST score 0; the six needs belonging to no food bank
  // at all (foodbank_id is NULLABLE in 0001_core.sql) are a partition of their
  // own, 400 days deep, which would score 80 if it ever leaked into a row.
  it("counts only its own food bank's needs, and never the ownerless ones", async () => {
    const db = freshDb();
    seedFoodbank(db, 1, { daysBetweenNeeds: 99 });
    seedFoodbank(db, 2, { daysBetweenNeeds: 99 });
    seedFiveNeeds(db, 1, 19.5);
    seedNeed(db, 2, ago(19.5 * DAY_MS));
    seedNeed(db, 2, ago(20 * DAY_MS));
    for (let i = 0; i < 6; i++) seedNeed(db, null, ago((400 + i) * DAY_MS));

    await updateDaysBetweenNeeds(d1Session(db));

    expect(daysBetweenNeedsOf(db, 1)).toBe(4);
    expect(daysBetweenNeedsOf(db, 2)).toBe(0);
  });

  // PARITY WITH THE DJANGO QUERYSET, asserted rather than assumed.
  // days_between_needs.py filters on `foodbank=foodbank` and nothing else --
  // unpublished and nonpertinent needs count towards the cadence just the same.
  // Almost every other query over foodbankchange in this package carries
  // `published = 1`, so adding one here would look like a consistency fix; it
  // would silently push this food bank from 4 to 0, because only two of its
  // five needs are published.
  //
  // `nonpertinent` is the same trap with a NULL in it, and is the reason this
  // test seeds all three of its values. The column is NULLABLE and
  // 0001_core.sql says so in as many words -- "NULLABLE: NULL is NOT 0" --
  // so the plausible "consistency fix" is `AND nonpertinent = 0`, which in
  // SQLite is not merely a filter on the flag: it drops every NULL row too,
  // silently, because NULL = 0 is NULL and NULL is not true. On production,
  // where most rows are NULL, that mutant would take almost the entire table
  // out of the CTE and score nearly every food bank 0. It survived the first
  // version of this suite, which wrote nonpertinent = 0 on every fixture row.
  // Here only the newest need is 0, so the mutant leaves one row, never
  // reaches rn = 5, and scores 0 instead of 4.
  it("counts unpublished and nonpertinent needs, exactly as the Django queryset does", async () => {
    const db = freshDb();
    seedFoodbank(db, 1);
    seedNeed(db, 1, ago(1 * HOUR_MS), { published: 1, nonpertinent: 0 });
    seedNeed(db, 1, ago(2 * HOUR_MS), { published: 0, nonpertinent: 1 });
    seedNeed(db, 1, ago(3 * HOUR_MS), { published: 0, nonpertinent: null });
    seedNeed(db, 1, ago(4 * HOUR_MS), { published: 0, nonpertinent: 1 });
    seedNeed(db, 1, ago(19.5 * DAY_MS), { published: 1, nonpertinent: null });

    await updateDaysBetweenNeeds(d1Session(db));

    expect(daysBetweenNeedsOf(db, 1)).toBe(4);
  });

  // THE NEGATIVE BRANCH, which the module's own header does not cover: it
  // reasons about the arithmetic for "this always-non-negative x", and for a
  // FUTURE-dated need x is negative. Nothing stops one: `created` is written
  // by whichever scraper or gfwrite form produced the row, and a clock-skewed
  // source or a hand-typed date puts it ahead of now. All five needs here are
  // in the future because ordering is by `created` DESC -- a single future
  // need would be the NEWEST, not the fifth, and never reach the formula.
  //
  // PARITY WAS RUN, NOT REASONED ABOUT (TESTING.md). CPython, in the shape
  // days_between_needs.py computes it, for a need 5.5 days ahead:
  // `timedelta(days=5.5).days` is 5, `int(-5 / 5)` is -1. For 10.5 days
  // ahead: `.days` is 10, `int(-10 / 5)` is -2. SQLite, on the real
  // statement, answers -1 and -2. They agree, on a branch nobody designed
  // for -- worth recording precisely because it is accidental.
  //
  // AND IT IS THE ONLY THING IN THE FILE THAT KILLS ONE PARTICULAR MUTANT.
  // `(CAST(x AS INTEGER) + (CAST(x AS INTEGER) < x))` simplified to
  // `(CAST(x AS INTEGER) + 1)` is indistinguishable for positive x, because
  // no test can make julianday('now') land on a whole number of days -- the
  // previous version of this suite declared it unkillable for that reason.
  // For negative x the two part company immediately: SQLite's CAST truncates
  // TOWARD ZERO, so for x = -5.5 the real expression is -5 (and -5/5 = -1)
  // while the mutant is -4 (and -4/5 = 0). Delete this test and that mutant
  // lives again.
  it("goes negative for a future-dated fifth need, matching CPython's int(-days/5)", async () => {
    const db = freshDb();
    seedFoodbank(db, 1, { daysBetweenNeeds: 7 });
    seedFoodbank(db, 2, { daysBetweenNeeds: 7 });
    // Negative `ago()` is the future. The four newer needs sit further ahead
    // still, so the fifth-newest is the one named in each title.
    for (const days of [9, 8, 7, 6]) seedNeed(db, 1, ago(-days * DAY_MS));
    seedNeed(db, 1, ago(-5.5 * DAY_MS));
    for (const days of [14, 13, 12, 11]) seedNeed(db, 2, ago(-days * DAY_MS));
    seedNeed(db, 2, ago(-10.5 * DAY_MS));

    await updateDaysBetweenNeeds(d1Session(db));

    expect(daysBetweenNeedsOf(db, 1)).toBe(-1); // the `+ 1` mutant answers 0
    expect(daysBetweenNeedsOf(db, 2)).toBe(-2); // the `+ 1` mutant answers -1
  });

  // Pinned, not endorsed. `julianday()` answers NULL for anything it cannot
  // parse, and the COALESCE swallows that on the way out -- so a food bank
  // whose fifth need carries a malformed `created` scores 0 (indistinguishable
  // from "has fewer than five needs") rather than failing. Migration 0022
  // normalised every imported timestamp, so this should be unreachable; it is
  // recorded because the failure it produces is a plausible-looking 0, and
  // someone chasing one needs to know this path exists.
  it("collapses an unparseable created to 0 rather than raising", async () => {
    const db = freshDb();
    seedFoodbank(db, 1, { daysBetweenNeeds: 7 });
    for (let i = 0; i < 4; i++) seedNeed(db, 1, ago((i + 1) * HOUR_MS));
    seedNeed(db, 1, "not a timestamp");

    await updateDaysBetweenNeeds(d1Session(db));

    expect(daysBetweenNeedsOf(db, 1)).toBe(0);
  });

  // One statement for the whole table -- that IS the work package (§8.9
  // replaced ~4,000 queries and 1,024 model saves with this). A refactor that
  // reintroduced a per-food-bank loop would still pass every assertion above,
  // so the round trip count is asserted directly.
  it("does the whole table in a single statement", async () => {
    const db = freshDb();
    const log: string[] = [];
    for (const id of [1, 2, 3]) {
      seedFoodbank(db, id);
      seedFiveNeeds(db, id, 19.5);
    }

    await updateDaysBetweenNeeds(d1Session(db, log));

    expect(log).toHaveLength(1);
  });
});

describe("pruneCrawlItems", () => {
  // The retention window itself. Both rows are seeded two minutes either side
  // of the 30-day line -- close enough that a 29- or 31-day threshold fails,
  // far enough that the second ticking mid-test cannot move either one across.
  //
  // The kept row is the important half. `start < datetime('now','-30 days')`
  // compares Django-format TEXT against SQLite's own space-separated rendering,
  // which is the only reason this works: swap the threshold for a JS
  // `toISOString()` bind and 'T' (0x54) beats ' ' (0x20), every row in the
  // table sorts below it, and the nightly prune quietly empties crawlitem
  // instead of trimming it.
  //
  // The crawl types are mixed on purpose. Age is the ONLY criterion -- the
  // statement never mentions crawl_type -- and article and charity items are
  // written by their own crons (articles.ts, charity.ts) into the same table.
  // With every fixture row seeded as "need", `AND crawl_type = 'need'` was an
  // invisible addition, and the articles and charity histories would then have
  // grown forever while the log still reported a healthy number of deletions.
  it("deletes only items older than 30 days, whatever their crawl type, and reports how many", async () => {
    const db = freshDb();
    seedCrawlItem(db, { id: 1, crawl_set_id: null, start: ago(30 * DAY_MS + 2 * MINUTE_MS) });
    seedCrawlItem(db, { id: 2, crawl_set_id: null, crawl_type: "article", start: ago(400 * DAY_MS) });
    seedCrawlItem(db, { id: 5, crawl_set_id: null, crawl_type: "charity", start: ago(60 * DAY_MS) });
    seedCrawlItem(db, { id: 3, crawl_set_id: null, start: ago(30 * DAY_MS - 2 * MINUTE_MS) });
    seedCrawlItem(db, { id: 4, crawl_set_id: null, crawl_type: "discrepancy", start: ago(1 * MINUTE_MS) });

    expect(await pruneCrawlItems(d1Session(db))).toBe(3);
    expect(db.prepare("SELECT id FROM crawlitem ORDER BY id").all()).toEqual([{ id: 3 }, { id: 4 }]);
  });

  // Retention is per row, by age, and nothing exempts an item that still
  // belongs to a live crawl set. Worth pinning because it is the behaviour a
  // reader would guess wrong: a sweep that has been stuck for 31 days (which
  // is precisely what finishStaleCrawlSets exists to mop up) loses its
  // evidence here first, and the crawl set is left pointing at nothing.
  it("deletes an old item even though its crawl set is still open", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 10, start: ago(31 * DAY_MS), finish: null });
    seedCrawlItem(db, { id: 1, crawl_set_id: 10, start: ago(31 * DAY_MS) });

    expect(await pruneCrawlItems(d1Session(db))).toBe(1);
    expect(countRows(db, "crawlset")).toBe(1);
  });

  // The `if (deleted === 0) break`. On a normal night the table holds far
  // fewer than 5,000 expired rows, so the loop's exit is the code path that
  // actually runs -- and a dropped break costs 49 pointless DELETEs against a
  // D1 database every single night, with nothing in the log to show for it.
  // Counting statements is the only way to see it; the return value is
  // identical either way.
  it("stops after the first empty batch instead of running its 50 statements", async () => {
    const db = freshDb();
    const log: string[] = [];
    seedCrawlItem(db, { id: 1, crawl_set_id: null, start: ago(1 * HOUR_MS) });

    expect(await pruneCrawlItems(d1Session(db, log))).toBe(0);
    expect(log).toHaveLength(1);
  });

  // LIMIT 5000 per statement, so no single DELETE approaches D1's 30-second
  // query limit -- and the loop must keep going until the batch comes back
  // empty. 5,001 expired rows is the smallest seed that distinguishes "chunks
  // and continues" from "chunks and stops after one": three statements
  // (5000 + 1 + 0), and every row gone.
  it("chunks at 5,000 rows per statement and keeps going until the table is clear", async () => {
    const db = freshDb();
    const log: string[] = [];
    seedManyCrawlItems(db, 5001, ago(40 * DAY_MS));

    expect(await pruneCrawlItems(d1Session(db, log))).toBe(5001);
    expect(log).toHaveLength(3);
    expect(countRows(db, "crawlitem")).toBe(0);
  });

  // THE CAP, with real rows. crawlitem grows ~5,845 rows/day and had no
  // retention policy at all in Django, so the first run against a table that
  // has been accumulating for years is the case this cap exists for: 50
  // statements x 5,000 = 250,000 rows, then stop and leave the rest for
  // tomorrow. The leftover row is the assertion that matters -- a loop that
  // ran to exhaustion would eventually blow the Worker's time budget, and one
  // that stopped early would never catch up. (~400ms, which is why exactly one
  // test in this file pays for it.)
  //
  // Which row survives is deliberately not asserted: the inner SELECT has no
  // ORDER BY, so the 250,000 taken are whichever the scan reaches first.
  it("stops at 50 statements, leaving the remainder for the next run", async () => {
    const db = freshDb();
    const log: string[] = [];
    seedManyCrawlItems(db, 250_001, ago(40 * DAY_MS));

    expect(await pruneCrawlItems(d1Session(db, log))).toBe(250_000);
    expect(log).toHaveLength(50);
    expect(countRows(db, "crawlitem")).toBe(1);
  });
});

describe("pruneCrawlSets", () => {
  // Same 30-day window as the items, same two-minute margins, same reason.
  // The two prunes are separate statements over separate tables with no
  // relationship between them beyond running back to back in one cron.
  //
  // Mixed crawl types again, and for the same reason as the items: crawlset
  // .crawl_type is "need, article, charity, discrepancy" (0008_needcheck.sql)
  // and this statement names none of them. Set 2 also carries a `finish` and
  // set 5 does not, so `AND finish IS NOT NULL` -- "only prune runs that
  // completed", a superficially careful addition -- cannot hide either.
  it("deletes only crawl sets older than 30 days, whatever their crawl type, and reports how many", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 1, start: ago(30 * DAY_MS + 2 * MINUTE_MS), finish: ago(30 * DAY_MS) });
    seedCrawlSet(db, { id: 2, crawl_type: "article", start: ago(400 * DAY_MS), finish: ago(400 * DAY_MS) });
    seedCrawlSet(db, { id: 5, crawl_type: "charity", start: ago(60 * DAY_MS), finish: null });
    seedCrawlSet(db, { id: 3, start: ago(30 * DAY_MS - 2 * MINUTE_MS), finish: null });
    seedCrawlSet(db, { id: 4, crawl_type: "discrepancy", start: ago(1 * MINUTE_MS), finish: null });

    expect(await pruneCrawlSets(d1Session(db))).toBe(3);
    expect(db.prepare("SELECT id FROM crawlset ORDER BY id").all()).toEqual([{ id: 3 }, { id: 4 }]);
  });

  // Age is the only criterion: a crawl set that never finished is deleted at
  // 30 days like any other. That is worth pinning because it silently bounds
  // finishStaleCrawlSets -- the backstop only ever sees sets between one and
  // thirty days old, and a sweep that stalled five weeks ago is not repaired,
  // it is forgotten. Both statements run in the same handler, this one first
  // (workers/jobs/src/scheduled/index.ts's crawlItemPrune).
  it("deletes an unfinished crawl set too, not just completed ones", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 1, start: ago(31 * DAY_MS), finish: null });

    expect(await pruneCrawlSets(d1Session(db))).toBe(1);
    expect(countRows(db, "crawlset")).toBe(0);
  });

  // No chunking here, unlike the items -- crawlset accumulates roughly 4,000
  // rows a YEAR against crawlitem's 5,845 a day, so one statement is never in
  // danger of the 30-second limit. Asserted as a single round trip so that the
  // asymmetry between the two functions stays a deliberate choice rather than
  // an oversight someone "fixes" in either direction: 5,001 expired sets, one
  // DELETE, one number.
  it("takes every expired set in one statement, with no 5,000-row cap", async () => {
    const db = freshDb();
    const log: string[] = [];
    seedManyCrawlSets(db, 5001, ago(40 * DAY_MS));

    expect(await pruneCrawlSets(d1Session(db, log))).toBe(5001);
    expect(log).toHaveLength(1);
    expect(countRows(db, "crawlset")).toBe(0);
  });

  // No cascade, because D1 declares no foreign keys (PLAN.md §4.5). A crawl
  // item whose set has been pruned keeps its now-dangling crawl_set_id -- it
  // does NOT become an ad-hoc item, because getOrphanedCrawlItems asks for
  // `crawl_set_id IS NULL`, so it simply stops appearing anywhere in the admin
  // until its own 30-day prune removes it. Pinned so that a future ON DELETE
  // CASCADE, or a "tidy up the children" addition here, is a visible change.
  it("leaves the pruned set's crawl items in place, dangling", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 10, start: ago(31 * DAY_MS), finish: null });
    seedCrawlItem(db, { id: 1, crawl_set_id: 10, start: ago(1 * HOUR_MS) });

    await pruneCrawlSets(d1Session(db));

    expect(db.prepare("SELECT id, crawl_set_id FROM crawlitem").all()).toEqual([{ id: 1, crawl_set_id: 10 }]);
  });
});

describe("finishStaleCrawlSets", () => {
  const finishOf = (db: DatabaseSync, id: number): string | null =>
    (db.prepare("SELECT finish FROM crawlset WHERE id = ?").get(id) as { finish: string | null }).finish;

  // The backstop's whole job: a crawl set whose expected/remaining counter
  // never reached 0 -- a food bank deleted mid-run, so its message was never
  // processed to decrement against -- would otherwise sit with finish NULL
  // forever, which is the "confirmed on production" bug this mechanism exists
  // to fix. It is closed with the LATEST finish among its own items, so the
  // recorded duration covers all the work actually done.
  //
  // The unfinished item is seeded because `max()` ignores NULLs: the set is
  // closed at the last item that DID finish, not left NULL because one did
  // not. And the two finished items are seeded out of order so that a `min()`
  // -- or a `max()` over the wrong column -- cannot pass.
  it("stamps a stale set with the latest finish among its own items, ignoring the unfinished one", async () => {
    const db = freshDb();
    const expected = ago(23 * HOUR_MS);
    seedCrawlSet(db, { id: 1, start: ago(25 * HOUR_MS), finish: null });
    seedCrawlItem(db, { id: 100, crawl_set_id: 1, start: ago(25 * HOUR_MS), finish: expected });
    seedCrawlItem(db, { id: 101, crawl_set_id: 1, start: ago(25 * HOUR_MS), finish: ago(24 * HOUR_MS) });
    seedCrawlItem(db, { id: 102, crawl_set_id: 1, start: ago(25 * HOUR_MS), finish: null });

    await finishStaleCrawlSets(d1Session(db));

    expect(finishOf(db, 1)).toBe(expected);
  });

  // `max()` over these columns is a byte-wise TEXT comparison, so it is only
  // chronological because Django's format is fixed-width and zero-padded.
  // Crossing midnight and a month boundary at once is where a format that had
  // lost its padding ("2026-9-1" < "2026-08-31") would come apart, and a crawl
  // set spanning midnight is the normal shape of an overnight sweep. Absolute
  // dates rather than `ago()` here on purpose -- the comparison being tested is
  // between the two stored strings, not against the clock.
  it("takes the max as a lexicographic TEXT comparison across a month boundary", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 1, start: ago(25 * HOUR_MS), finish: null });
    seedCrawlItem(db, { id: 100, crawl_set_id: 1, start: ago(25 * HOUR_MS), finish: "2026-09-01 00:00:00.000001" });
    seedCrawlItem(db, { id: 101, crawl_set_id: 1, start: ago(25 * HOUR_MS), finish: "2026-08-31 23:59:59.999999" });

    await finishStaleCrawlSets(d1Session(db));

    expect(finishOf(db, 1)).toBe("2026-09-01 00:00:00.000001");
  });

  // "Restricted to runs at least a day old so an in-progress run's still-
  // legitimately-NULL finish is never stamped early" -- the module's own
  // comment, and the reason this is a backstop rather than a race. The needcheck
  // sweep takes hours, and every one of its items finishes long before the set
  // does; stamping at 23 hours would close a sweep that is still enqueuing
  // work, and its remaining messages would then be processed against a crawl
  // set the admin has been told is complete.
  //
  // Sets 3 and 4 straddle the line with two minutes to spare either side --
  // the same margin the 30-day prunes use, and for the same reason: the clock
  // is real and cannot be frozen, but two minutes is far more than the
  // milliseconds between the INSERT and the UPDATE. Without them the window
  // was only pinned to somewhere between 23 and 25 hours, and `'-23 hours'`
  // survived (its own boundary case, decided by whether the second happened
  // to tick between seeding and running -- the flakiest kind of survivor).
  // With them, every window except a day plus or minus two minutes dies.
  it("leaves a set younger than a day alone, even with finished items waiting", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 1, start: ago(23 * HOUR_MS), finish: null });
    seedCrawlItem(db, { id: 100, crawl_set_id: 1, start: ago(23 * HOUR_MS), finish: ago(22 * HOUR_MS) });
    seedCrawlSet(db, { id: 2, start: ago(25 * HOUR_MS), finish: null });
    seedCrawlItem(db, { id: 200, crawl_set_id: 2, start: ago(25 * HOUR_MS), finish: ago(24 * HOUR_MS) });
    seedCrawlSet(db, { id: 3, start: ago(24 * HOUR_MS - 2 * MINUTE_MS), finish: null });
    seedCrawlItem(db, { id: 300, crawl_set_id: 3, start: ago(24 * HOUR_MS), finish: ago(23 * HOUR_MS) });
    seedCrawlSet(db, { id: 4, start: ago(24 * HOUR_MS + 2 * MINUTE_MS), finish: null });
    seedCrawlItem(db, { id: 400, crawl_set_id: 4, start: ago(24 * HOUR_MS), finish: ago(23 * HOUR_MS) });

    await finishStaleCrawlSets(d1Session(db));

    expect(finishOf(db, 1)).toBeNull();
    expect(finishOf(db, 3)).toBeNull();
    // The stale ones beside them prove the predicate is a date filter and not
    // a statement that matches nothing.
    expect(finishOf(db, 2)).not.toBeNull();
    expect(finishOf(db, 4)).not.toBeNull();
  });

  // `finish IS NULL` guards the real mechanism's own work.
  // decrementCrawlSetRemaining (needcheck.ts) stamps `finish` with pyNow() the
  // instant the counter hits 0, which is a moment or two AFTER the last item
  // finished. Without this predicate the backstop would come along that night
  // and rewrite it backwards to the last item's finish -- a silent edit to a
  // correct value, changing every completed sweep's recorded duration.
  it("never rewrites a set that already has a finish", async () => {
    const db = freshDb();
    const original = ago(24 * HOUR_MS);
    seedCrawlSet(db, { id: 1, start: ago(25 * HOUR_MS), finish: original });
    seedCrawlItem(db, { id: 100, crawl_set_id: 1, start: ago(25 * HOUR_MS), finish: ago(20 * HOUR_MS) });

    await finishStaleCrawlSets(d1Session(db));

    expect(finishOf(db, 1)).toBe(original);
  });

  // The correlation. `WHERE crawl_set_id = crawlset.id` is what keeps each set
  // to its own items; drop it and every stale set is stamped with the newest
  // finish in the entire table, which looks entirely plausible on the page and
  // is wrong for all but one row. Set 2's item finished much later, and the
  // ad-hoc item (crawl_set_id NULL, from a Force Check button) later still --
  // `= NULL` is never true, so it belongs to no set and must reach none.
  it("uses only its own set's items, not another set's and not the ad-hoc ones", async () => {
    const db = freshDb();
    // Captured, never recomputed: `ago()` reads the real clock, so calling it
    // twice with the same argument gives two different milliseconds.
    const ownFinish = ago(24 * HOUR_MS);
    const othersFinish = ago(2 * HOUR_MS);
    seedCrawlSet(db, { id: 1, start: ago(25 * HOUR_MS), finish: null });
    seedCrawlItem(db, { id: 100, crawl_set_id: 1, start: ago(25 * HOUR_MS), finish: ownFinish });
    seedCrawlSet(db, { id: 2, start: ago(30 * HOUR_MS), finish: null });
    seedCrawlItem(db, { id: 200, crawl_set_id: 2, start: ago(30 * HOUR_MS), finish: othersFinish });
    seedCrawlItem(db, { id: 300, crawl_set_id: null, start: ago(2 * HOUR_MS), finish: ago(1 * HOUR_MS) });

    await finishStaleCrawlSets(d1Session(db));

    expect(finishOf(db, 1)).toBe(ownFinish);
    expect(finishOf(db, 2)).toBe(othersFinish);
  });

  // SUSPECT, PINNED AS-IS -- the gap in the backstop. `max()` over no rows, or
  // over rows that all have a NULL finish, is NULL, and the UPDATE writes that
  // NULL straight back. So the two shapes where a stale crawl set is LEAST
  // able to close itself are exactly the two this mechanism cannot close:
  //
  //   * a set whose enqueue failed outright, so no crawlitem was ever opened
  //     (insertCrawlItem runs in the consumer, not the producer);
  //   * a set whose consumers all died before stamping a single finish.
  //
  // Both stay finish NULL forever, are re-matched by this UPDATE every night
  // until pruneCrawlSets deletes them at 30 days, and sit in /admin/jobs/'s
  // "Running Now" panel the whole time (getRunningCrawlSets is `finish IS
  // NULL`), reporting a running_for that grows into weeks. Recorded rather
  // than fixed because this file pins behaviour -- a fix would be a
  // COALESCE onto the set's own start, or a `WHERE EXISTS`, and that is a
  // decision, not a test.
  it("leaves a stale set with no finished items NULL, so it can never be closed", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 1, start: ago(25 * HOUR_MS), finish: null }); // no items at all
    seedCrawlSet(db, { id: 2, start: ago(25 * HOUR_MS), finish: null });
    seedCrawlItem(db, { id: 200, crawl_set_id: 2, start: ago(25 * HOUR_MS), finish: null });

    await finishStaleCrawlSets(d1Session(db));

    expect(finishOf(db, 1)).toBeNull();
    expect(finishOf(db, 2)).toBeNull();

    // And again tomorrow, and every night after: the statement re-matches both
    // rows for as long as they exist. Running it twice is how that
    // no-progress-is-possible property is stated rather than described.
    await finishStaleCrawlSets(d1Session(db));
    expect(finishOf(db, 1)).toBeNull();
    expect(finishOf(db, 2)).toBeNull();
  });

  // One statement for the whole table, like the days_between_needs UPDATE --
  // no per-set round trip, however many stale sets there are.
  //
  // The three sets are three different crawl types, because this statement
  // names none: an article or charity sweep that stalls has exactly the same
  // problem a needcheck sweep does, and `AND crawl_type = 'need'` would leave
  // both stuck in /admin/jobs/'s "Running Now" panel forever. With every
  // fixture seeded as "need" that mutant was invisible.
  //
  // And it writes ONE column. `expected`, `remaining`, `start`, `run_id` and
  // `crawl_type` are all still what they were -- asserted wholesale rather
  // than named one at a time, so a mutant that helpfully also does
  // `SET remaining = 0` (plausible: the counter never reaching 0 is the very
  // condition this backstop exists for) does not slip through. It did.
  it("closes every stale set, of every crawl type, in one statement and one column", async () => {
    const db = freshDb();
    const log: string[] = [];
    const types = ["need", "article", "charity"];
    types.forEach((crawl_type, index) => {
      const id = index + 1;
      seedCrawlSet(db, { id, crawl_type, start: ago(25 * HOUR_MS), finish: null });
      seedCrawlItem(db, { id: 100 + id, crawl_set_id: id, crawl_type, start: ago(25 * HOUR_MS), finish: ago(24 * HOUR_MS) });
    });
    const before = db.prepare("SELECT id, crawl_type, run_id, start, expected, remaining FROM crawlset ORDER BY id").all();

    await finishStaleCrawlSets(d1Session(db, log));

    expect(log).toHaveLength(1);
    expect(countRows(db, "crawlset")).toBe(3);
    expect(db.prepare("SELECT count(*) AS c FROM crawlset WHERE finish IS NULL").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT id, crawl_type, run_id, start, expected, remaining FROM crawlset ORDER BY id").all()).toEqual(before);
  });
});
