import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "./schema.testkit";
import { describe, expect, it } from "vitest";
import { getAdminDashboardStats, getOldestEditedFoodbankSlug } from "./adminDashboardStats";
import type { Session } from "./types";

// gfadmin/views.py:46-95 index()'s "stats" dict -- the seven queries behind
// the admin dashboard's Metrics panel, plus the one behind the check page's
// "Next" button.
//
// WHY A REAL DATABASE. Every failure this module can have is silent. A wrong
// ORDER BY, a filter that matches nothing, a threshold that sorts wrongly
// against stored TEXT: each returns rows, none raises, and the dashboard
// renders a plausible number that is simply not true. Two of those have
// already happened here and are pinned below by name -- ticket #9's ISO
// threshold (measured at 31 of 46 rows silently dropped) and migration
// 0019's column drops, which broke four queries elsewhere without a single
// log line. A mocked session handing back canned rows would have agreed with
// both bugs, because the bug was in the SQL and the mock does not run SQL.
// So the tests below run the module's real statements against real SQLite
// with the real schema, and assert the actual rows that come back.
//
// MUTATION-TESTED TWICE (TESTING.md's convention: the evidence that a test is
// load-bearing rather than decoration). The module was transpiled into a
// scratchpad, broken 89 ways, and this file re-run against each. 74 died on
// the first pass, including: `is_closed = 0` deleted from each of the five
// queries that carry it, one at a time; ASC/DESC flipped on each of the four
// ordered queries, and each ORDER BY deleted outright; pyDatetime() reverted
// to toISOString(); `>=` narrowed to `>` on both thresholds; crawlitem's
// `finish` swapped for `start`; the crawl set query ordered by id instead of
// start, and its crawl_type filter dropped; the Facebook pattern loosened to
// '%facebook%'; the parentheses dropped from the Facebook OR-group (AND binds
// tighter than OR, so closed food banks leak straight back in); the crawl
// counts re-grouped Django-style through an INNER JOIN to crawlset;
// Math.floor swapped for Math.round; and articleCheck24h reading the need
// bucket.
//
// Of the fifteen that lived, five were real holes in three families, and a
// SECOND, ADVERSARIAL PASS closed them. Each is now killed by a test that
// names it, because a mutant that survives is the only honest measure of what
// a suite does not cover. The battery now stands at 79 killed of 89, with
// every remaining survivor equivalent by construction (listed below):
//
//   * COUNT(*) -> COUNT(DISTINCT foodbank_id) on the crawl counts -- every
//     fixture gave each item its own food bank, so the two agreed everywhere.
//   * the threshold truncated to whole seconds -- every clock here sat on an
//     exact second, so pyDatetime's six fractional digits never mattered.
//   * `crawl_type = 'need'` loosened to LIKE -- only 'article' and 'charity'
//     were seeded against it, and neither is a case- or substring-match for
//     "need".
//
// Chasing the second of those turned up a fourth gap, which no mutant would
// have found because it is a hole in the FIXTURE rather than in the SQL:
// every timestamp seeded here had six fractional digits, and the database
// holds values with none at all (Python omits the fraction when microsecond
// is 0). That is now covered, and it exposed a real divergence -- see the
// needCount24h block's last test.
//
// Ten survivors are equivalent BY CONSTRUCTION, recorded here so the next
// reader does not re-derive them: `IS NULL` -> `= NULL` and `is_closed = 0`
// -> `!= 1` (both columns are NOT NULL -- see the last test in the
// oldestNeedCheck block); every LIMIT change, because `.first()` takes row
// one whatever the LIMIT says, so it is the ORDER BY tests and not any LIMIT
// test that hold those five queries; `?? 0` on needCount24h, because
// `SELECT COUNT(*)` always returns a row and the fallback is unreachable;
// `SELECT id` -> `rowid AS id` (`id INTEGER PRIMARY KEY` is a rowid alias);
// a LEFT JOIN added to the crawl counts (crawlset.id is a primary key, so it
// is 1:1 -- the INNER version is the one that changes the answer, and it
// dies); COUNT(*) -> SUM(1); and the threshold truncated to MILLISECOND
// precision, which brackets an identical set of rows for every value this
// column can hold (fractions here are six digits or none, never three), even
// though truncating one digit further does not and is killed below.
//
// THE FIXTURE IS THE MIGRATION FILES THEMSELVES, applied in order, rather
// than a CREATE TABLE transcribed into this file. That is deliberate, and it
// is this package's own scar: migration 0019 dropped the cached parent
// columns (`foodbank_name` and its siblings) off six tables, and queries
// elsewhere went on naming columns that no longer existed -- silently, until
// /dashboard/beautybanks/ was measured and found to be a live 500. A hand-copied schema in a test file is a second
// copy of the truth, and it drifts in exactly the same way: the tests stay
// green against a database production no longer has.
//
// Applying the real files instead means every column, every NOT NULL and
// every index here is the one D1 holds. Two of those are load-bearing below:
// `foodbank.edited` and `foodbank.last_need_check` are NULLABLE (0001_core
// .sql:44-45), which is what makes the NULL-ordering tests reachable at all,
// and `foodbank.shopping_list_url` is NOT NULL (0001_core.sql:27), which is
// what makes half of the oldestNeedCheck predicate unreachable.
//
// Read once at module load, exec'd per test -- 23 small files, so this costs
// nothing measurable next to running them for each of the cases below.

type Bindable = null | number | bigint | string | Uint8Array;

// The D1 Sessions API surface this package is handed, backed by node:sqlite.
// Copied from workers/site/src/routes/admin/foodbankLocation.test.ts so both
// tiers drive the real code through one adapter rather than two. Deliberately
// dumb: it forwards the SQL untouched, so the engine -- not JavaScript -- is
// what decides which rows come back.
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

interface FoodbankSeed {
  id: number;
  name: string;
  slug: string;
  edited?: string | null;
  last_need_check?: string | null;
  shopping_list_url?: string;
  is_closed?: number;
}

// Fills in the fifteen NOT NULL columns nothing in this module reads, so a
// test can say what it is actually about. The four that DO matter -- edited,
// last_need_check, shopping_list_url, is_closed -- are always explicit at the
// call site.
function seedFoodbank(db: DatabaseSync, fb: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank (
       id, uuid, name, slug, address, postcode, country, lat_lng,
       charity_just_foodbank, contact_email, url, shopping_list_url,
       address_is_administrative, is_closed, no_locations, days_between_needs,
       created, modified, edited, last_need_check
     ) VALUES (?, ?, ?, ?, 'Address', 'SP2 9DY', 'England', '51.06,-1.79',
       0, 'info@example.org', 'https://example.org/', ?,
       0, ?, 0, 7,
       '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000', ?, ?)`,
  ).run(
    fb.id,
    `uuid-${fb.id}`,
    fb.name,
    fb.slug,
    fb.shopping_list_url ?? "https://example.org/shopping-list/",
    fb.is_closed ?? 0,
    fb.edited === undefined ? null : fb.edited,
    fb.last_need_check === undefined ? null : fb.last_need_check,
  );
}

function seedChangeLine(db: DatabaseSync, id: number, created: string, foodbankId = 1): void {
  db.prepare(
    `INSERT INTO foodbankchangeline (id, need_id, foodbank_id, item, type, category, group_name, created)
     VALUES (?, 1, ?, 'Tinned Tomatoes', 'need', 'Food', 'Tins', ?)`,
  ).run(id, foodbankId, created);
}

function seedCrawlSet(db: DatabaseSync, id: number, crawlType: string, start: string, finish: string | null = null): void {
  db.prepare("INSERT INTO crawlset (id, crawl_type, run_id, start, finish) VALUES (?, ?, ?, ?, ?)").run(id, crawlType, `run-${id}`, start, finish);
}

function seedCrawlItem(db: DatabaseSync, id: number, crawlType: string, finish: string | null, opts: { crawlSetId?: number | null; foodbankId?: number } = {}): void {
  db.prepare("INSERT INTO crawlitem (id, crawl_set_id, crawl_type, start, finish, foodbank_id) VALUES (?, ?, ?, '2026-09-04 00:00:00.000000', ?, ?)").run(
    id,
    opts.crawlSetId === undefined ? 1 : opts.crawlSetId,
    crawlType,
    finish,
    opts.foodbankId ?? id,
  );
}

// Fixed clock. Every expectation below is written against this instant, and
// the 24-hour threshold the module derives from it is exactly:
//
//   pyDatetime(NOW - 24h) === "2026-09-04 12:00:00.000000"
//
// Written out rather than recomputed, because a test that rebuilds the
// threshold with the same helper the module uses proves only that the helper
// is deterministic.
const NOW = new Date("2026-09-05T12:00:00.000Z");
const THRESHOLD = "2026-09-04 12:00:00.000000";

describe("getAdminDashboardStats: oldest and latest edit", () => {
  // The panel's headline pair. Django is
  // `Foodbank.objects.exclude(is_closed=True).order_by("edited").first()` and
  // its `-edited` twin (views.py:62, :85). Three open rows, so a reversed
  // ORDER BY cannot pass by picking the same row twice, and a closed row at
  // each end so a dropped `is_closed = 0` shows up on both queries at once.
  function seedEdits(db: DatabaseSync): void {
    seedFoodbank(db, { id: 1, name: "Salisbury", slug: "salisbury", edited: "2026-08-01 09:00:00.000000" });
    seedFoodbank(db, { id: 2, name: "Bath", slug: "bath", edited: "2026-09-01 09:00:00.000000" });
    seedFoodbank(db, { id: 3, name: "Wilton", slug: "wilton", edited: "2026-09-04 23:00:00.000000" });
    seedFoodbank(db, { id: 4, name: "Closed Oldest", slug: "closed-oldest", edited: "2019-01-01 09:00:00.000000", is_closed: 1 });
    seedFoodbank(db, { id: 5, name: "Closed Newest", slug: "closed-newest", edited: "2030-01-01 09:00:00.000000", is_closed: 1 });
  }

  it("returns the open food bank edited longest ago, whole row", async () => {
    const db = freshDb();
    seedEdits(db);

    const stats = await getAdminDashboardStats(d1Session(db), NOW);
    // The whole row, not just the slug: the dashboard prints the name and the
    // date, and a query selecting the wrong columns is as broken as one
    // ordering the wrong way.
    expect(stats.oldestEdit).toEqual({ name: "Salisbury", slug: "salisbury", edited: "2026-08-01 09:00:00.000000" });
  });

  it("returns the open food bank edited most recently", async () => {
    const db = freshDb();
    seedEdits(db);

    const stats = await getAdminDashboardStats(d1Session(db), NOW);
    expect(stats.latestEdit).toEqual({ name: "Wilton", slug: "wilton", edited: "2026-09-04 23:00:00.000000" });
  });

  // Closed food banks are not part of the review queue -- they are never
  // edited again, so leaving them in means the dashboard's "oldest edit"
  // permanently reads 2019 and the whole metric stops moving. Both ends are
  // asserted because the two statements carry the filter independently.
  it("excludes closed food banks from BOTH ends", async () => {
    const db = freshDb();
    seedEdits(db);

    const stats = await getAdminDashboardStats(d1Session(db), NOW);
    expect(stats.oldestEdit?.slug).not.toBe("closed-oldest");
    expect(stats.latestEdit?.slug).not.toBe("closed-newest");
  });

  // Timestamps are TEXT and SQLite compares TEXT byte by byte, so the whole
  // ordering rests on the stored format being fixed-width. These four values
  // differ only inside one day -- and one pair only in the microseconds -- so
  // a column holding a mix of formats, or a value written with three
  // fractional digits instead of six, would reorder them.
  it("orders Django-format timestamps chronologically within a single day", async () => {
    const db = freshDb();
    seedFoodbank(db, { id: 1, name: "Nine AM", slug: "nine-am", edited: "2026-09-04 09:00:00.000000" });
    seedFoodbank(db, { id: 2, name: "Nine Oh One", slug: "nine-oh-one", edited: "2026-09-04 09:01:00.000000" });
    seedFoodbank(db, { id: 3, name: "Late", slug: "late", edited: "2026-09-04 23:59:59.999998" });
    seedFoodbank(db, { id: 4, name: "Latest", slug: "latest", edited: "2026-09-04 23:59:59.999999" });

    const stats = await getAdminDashboardStats(d1Session(db), NOW);
    expect(stats.oldestEdit?.slug).toBe("nine-am");
    expect(stats.latestEdit?.slug).toBe("latest");
  });

  // SUSPECTED DIVERGENCE, pinned as-is (TESTING.md: assert what the code
  // does). `edited` is nullable -- givefood/models/base.py:34 declares
  // `DateTimeField(editable=False, null=True)` -- and the two engines sort
  // NULLs at opposite ends: SQLite puts them FIRST in ASC, Postgres puts them
  // LAST. So a food bank that has never been edited wins "oldest edit" here
  // and does not in Django, and because the row's `edited` is null the panel
  // then shows no age beside it. Django would have shown the oldest food bank
  // that has actually been edited.
  //
  // Executed, not reasoned about -- the two assertions below ARE the proof of
  // SQLite's ordering, run against the real engine.
  it("lets a never-edited food bank win 'oldest', because SQLite sorts NULL first in ASC", async () => {
    const db = freshDb();
    seedFoodbank(db, { id: 1, name: "Salisbury", slug: "salisbury", edited: "2026-08-01 09:00:00.000000" });
    seedFoodbank(db, { id: 2, name: "Never Edited", slug: "never-edited", edited: null });

    const stats = await getAdminDashboardStats(d1Session(db), NOW);
    expect(stats.oldestEdit?.slug).toBe("never-edited");
    expect(stats.oldestEditDays).toBeNull();
    // The mirror image, and the reason latestEdit needs no `IS NOT NULL`
    // guard while latestNeedCheck has one: DESC puts those same NULLs last.
    expect(stats.latestEdit?.slug).toBe("salisbury");
  });

  it("returns nulls, not a throw, against an empty foodbank table", async () => {
    const stats = await getAdminDashboardStats(d1Session(freshDb()), NOW);
    expect(stats.oldestEdit).toBeNull();
    expect(stats.latestEdit).toBeNull();
    expect(stats.oldestEditDays).toBeNull();
  });
});

describe("getAdminDashboardStats: oldestEditDays", () => {
  async function daysFor(edited: string | null): Promise<number | null> {
    const db = freshDb();
    seedFoodbank(db, { id: 1, name: "Salisbury", slug: "salisbury", edited });
    return (await getAdminDashboardStats(d1Session(db), NOW)).oldestEditDays;
  }

  // Django is `(timezone.now() - oldest_edit.edited).days` (views.py:63), and
  // Python's timedelta.days truncates toward the past. Each expectation below
  // was produced by running CPython against the same values rather than
  // reasoned about (TESTING.md's rule):
  //
  //   >>> now = datetime(2026,9,5,12,0,0)
  //   >>> (now - datetime.fromisoformat("2026-09-02 11:00:00.853000")).days  -> 3
  //   >>> (now - datetime.fromisoformat("2026-09-04 12:00:00.000000")).days  -> 1
  //   >>> (now - datetime.fromisoformat("2026-09-04 12:00:00.001000")).days  -> 0
  //   >>> (now - datetime.fromisoformat("2026-09-05 13:00:00.000000")).days  -> -1
  it("floors the age in whole days, matching Python's timedelta.days", async () => {
    expect(await daysFor("2026-09-02 11:00:00.853000")).toBe(3);
    expect(await daysFor("2026-09-04 12:00:00.000000")).toBe(1);
    // One millisecond short of 24 hours. Math.round() here would say 1 and the
    // panel would claim a day had passed when it had not.
    expect(await daysFor("2026-09-04 12:00:00.001000")).toBe(0);
  });

  // A timestamp in the future is not hypothetical -- an admin edit stamped by
  // one machine and read by another with a skewed clock produces exactly this.
  // Math.floor and Python both round toward the past, so both say -1; this
  // pins that the port did not "helpfully" clamp at zero.
  it("goes negative the same way Python does when the edit is in the future", async () => {
    expect(await daysFor("2026-09-05 13:00:00.000000")).toBe(-1);
  });

  // The six-digit fraction is the format Django and the ETL write. JavaScript's
  // Date accepts it (truncating to milliseconds) -- but if it ever stopped,
  // the failure is NaN rather than an exception, and the dashboard would
  // quietly print "NaN days" beside the food bank's name. Asserting a number
  // rather than "not null" is what catches that.
  it("parses Django's six-digit microseconds rather than yielding NaN", async () => {
    const days = await daysFor("2026-09-04 11:59:59.999999");
    expect(days).toBe(1);
    expect(Number.isNaN(days)).toBe(false);
  });

  it("is null when the oldest row has never been edited", async () => {
    expect(await daysFor(null)).toBeNull();
  });
});

describe("getAdminDashboardStats: needCount24h", () => {
  // TICKET #9, THE REGRESSION THIS WHOLE MODULE'S THRESHOLD EXISTS FOR.
  // `created` is TEXT compared lexicographically, `' '` is 0x20 and `'T'` is
  // 0x54, so an ISO threshold ("2026-09-04T12:00:00.000Z") sorts after every
  // Django-format value from the same day and silently drops them all --
  // measured at 31 of 46 rows on foodbankchange. The counts just read low;
  // nothing errored.
  //
  // The control query at the end of this test is the proof: the same rows,
  // the same statement, the only difference being the threshold's format.
  it("counts same-day rows an ISO threshold would silently drop", async () => {
    const db = freshDb();
    seedChangeLine(db, 1, "2026-09-04 11:59:59.999999"); // just before the window
    seedChangeLine(db, 2, THRESHOLD); // exactly on it -- `>=` must include this
    seedChangeLine(db, 3, "2026-09-04 20:00:00.000000"); // same day, later: the dropped class
    seedChangeLine(db, 4, "2026-09-05 11:59:00.000000"); // today
    seedChangeLine(db, 5, "2026-08-30 09:00:00.000000"); // last week

    const stats = await getAdminDashboardStats(d1Session(db), NOW);
    expect(stats.needCount24h).toBe(3);

    // What the pre-#9 code did, run rather than described. Two of the three
    // rows inside the window vanish, including the one sitting exactly on the
    // boundary, and the number that reaches the page is 1.
    const iso = new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const withIsoThreshold = db.prepare("SELECT COUNT(*) AS c FROM foodbankchangeline WHERE created >= ?").get(iso) as { c: number };
    expect(withIsoThreshold.c).toBe(1);
  });

  // The window has to move with the clock the CALLER passes, not with the
  // wall clock: workers/site/src/routes/admin/index.ts:308 takes one `now`
  // and shares it across every panel so they agree with each other. A mutant
  // that reached for `new Date()` inside this function would pass every other
  // test in this file, because every other test uses a `now` near enough to
  // the seeded rows -- these two do not.
  it("derives the window from the `now` argument, not from the current time", async () => {
    const db = freshDb();
    seedChangeLine(db, 1, "2026-09-04 11:59:59.999999");
    seedChangeLine(db, 2, THRESHOLD);
    seedChangeLine(db, 3, "2026-09-04 20:00:00.000000");
    seedChangeLine(db, 4, "2026-09-05 11:59:00.000000");
    seedChangeLine(db, 5, "2026-08-30 09:00:00.000000");

    const aDayLater = await getAdminDashboardStats(d1Session(db), new Date("2026-09-06T12:00:00.000Z"));
    expect(aDayLater.needCount24h).toBe(0);

    // THE WINDOW IS HALF-OPEN: `created >= ?` and nothing else, matching
    // Django's `filter(created__gte=yesterday)` (views.py:86) exactly. Moving
    // `now` back a day therefore ADMITS rows rather than trading one end for
    // the other -- all five here except the one from last week -- and, in
    // production, a row stamped ahead of the clock by a skewed writer counts
    // toward "the last 24 hours" forever. Pinned because "24h" reads like a
    // bounded range and is not one.
    const aDayEarlier = await getAdminDashboardStats(d1Session(db), new Date("2026-09-04T12:00:00.000Z"));
    expect(aDayEarlier.needCount24h).toBe(4);
  });

  // SURVIVING MUTANT, now killed: the threshold truncated to whole seconds
  // (`pyDatetime(...).slice(0, 19)`). It lived through the whole first pass
  // because NOW, and every other clock in this file, sits on an exact second
  // -- so the threshold's fraction was always ".000000", and a value ending
  // ".000000" brackets exactly the same rows as one ending nothing at all (a
  // shorter string that is a prefix of a longer one sorts first). The six
  // digits pyDatetime pads were therefore never load-bearing in any test.
  //
  // Production never has that clock. `now` there is a `new Date()` taken
  // inside the request (workers/site/src/routes/admin/index.ts:308), so the
  // threshold always carries a real millisecond value, and a truncated one
  // widens the window by up to a second. So this case uses a clock shaped
  // like the timestamps Django actually writes -- the ".853000" from ticket
  // #9's own note -- rather than a laboratory one.
  //
  // Both thresholds in this module are the same `yesterday` string, so this
  // covers the crawlitem comparison too.
  it("compares to microsecond precision, on a clock that is not on a whole second", async () => {
    const db = freshDb();
    const now = new Date("2026-09-05T12:00:00.853Z"); // threshold: 2026-09-04 12:00:00.853000
    seedChangeLine(db, 1, "2026-09-04 12:00:00.500000"); // inside a second-truncated window, outside the real one
    seedChangeLine(db, 2, "2026-09-04 12:00:00.853000"); // exactly on the boundary: `>=` keeps it
    seedChangeLine(db, 3, "2026-09-04 12:00:00.900000"); // just inside

    const stats = await getAdminDashboardStats(d1Session(db), now);
    expect(stats.needCount24h).toBe(2);
  });

  // SUSPECTED DIVERGENCE, pinned as-is, and the reason every OTHER timestamp
  // in this file carries six fractional digits: not all of them do in the
  // database. Python's `str(datetime)` OMITS the fraction entirely when
  // microsecond is 0 -- pyDatetime.ts's own header says so, and CPython
  // confirms it (TESTING.md's rule -- someone ran this):
  //
  //   >>> str(datetime(2026,9,4,12,0,0))        -> '2026-09-04 12:00:00'
  //   >>> str(datetime(2026,9,4,12,0,0,853000)) -> '2026-09-04 12:00:00.853000'
  //
  // So the column holds both shapes, and against a threshold that always has
  // six digits the shorter one loses the byte comparison: SQLite says
  // `'2026-09-04 12:00:00' >= '2026-09-04 12:00:00.000000'` is FALSE, because
  // a string that is a prefix of another sorts before it. A row stamped at
  // exactly the threshold instant with no microseconds is therefore dropped
  // from a window Django's `created__gte` -- comparing real timestamps on
  // Postgres, not text -- would have included.
  //
  // Narrow: it needs a whole-second stamp landing on the threshold's own
  // second. But it is the same lexicographic-TEXT family ticket #9 came from,
  // and it was entirely untested, so it is recorded rather than assumed away.
  // The second assertion is the reassuring half: away from that one boundary
  // a fraction-less value still sorts chronologically, because the fixed-width
  // date-and-time prefix decides the comparison before the fraction is
  // reached. Only exact equality on the prefix exposes the difference.
  it("drops a fraction-less row sitting exactly on the threshold (Django would keep it)", async () => {
    const db = freshDb();
    seedChangeLine(db, 1, "2026-09-04 12:00:00"); // the same instant as THRESHOLD, written by Python with microsecond=0
    seedChangeLine(db, 2, "2026-09-04 12:00:01"); // one second later, no fraction: comfortably inside
    seedChangeLine(db, 3, "2026-09-05 09:00:00.000000");

    const stats = await getAdminDashboardStats(d1Session(db), NOW);
    expect(stats.needCount24h).toBe(2);

    // The ordering half, on the same mixed formats: a fraction-less value is
    // still placed correctly against six-digit ones either side of it.
    const ordered = db.prepare("SELECT created FROM foodbankchangeline ORDER BY created ASC").all() as { created: string }[];
    expect(ordered.map((r) => r.created)).toEqual(["2026-09-04 12:00:00", "2026-09-04 12:00:01", "2026-09-05 09:00:00.000000"]);
  });

  // Django is `FoodbankChangeLine.objects.filter(created__gte=yesterday)
  // .count()` (views.py:86) -- every line in the window, with no join to the
  // food bank and no type/category predicate. A future "improvement" that
  // scoped this to open food banks or to type='need' would change a number
  // nobody double-checks, so the closed food bank's line is here to fail it.
  it("counts every line in the window, including a closed food bank's", async () => {
    const db = freshDb();
    seedFoodbank(db, { id: 9, name: "Closed", slug: "closed", is_closed: 1 });
    seedChangeLine(db, 1, "2026-09-05 09:00:00.000000", 9);
    seedChangeLine(db, 2, "2026-09-05 09:00:01.000000", 9);

    const stats = await getAdminDashboardStats(d1Session(db), NOW);
    expect(stats.needCount24h).toBe(2);
  });

  it("is 0 on an empty table", async () => {
    expect((await getAdminDashboardStats(d1Session(freshDb()), NOW)).needCount24h).toBe(0);
  });
});

describe("getAdminDashboardStats: the three crawl counts", () => {
  it("counts finished crawl items in the window, split by type", async () => {
    const db = freshDb();
    seedCrawlSet(db, 1, "need", "2026-09-05 00:00:00.000000");
    seedCrawlItem(db, 1, "need", "2026-09-05 09:00:00.000000");
    seedCrawlItem(db, 2, "need", "2026-09-05 09:01:00.000000");
    seedCrawlItem(db, 3, "article", "2026-09-05 09:02:00.000000");
    seedCrawlItem(db, 4, "charity", "2026-09-05 09:03:00.000000");
    seedCrawlItem(db, 5, "charity", "2026-09-05 09:04:00.000000");
    seedCrawlItem(db, 6, "charity", "2026-09-05 09:05:00.000000");

    const stats = await getAdminDashboardStats(d1Session(db), NOW);
    // Three different numbers, so a GROUP BY that collapsed everything into
    // one bucket -- or a Map keyed off the wrong column -- cannot pass.
    expect(stats.needCheck24h).toBe(2);
    expect(stats.articleCheck24h).toBe(1);
    expect(stats.charityCheck24h).toBe(3);
  });

  // SURVIVING MUTANT, now killed: COUNT(*) -> COUNT(DISTINCT foodbank_id).
  // It lived through the whole first pass because every other fixture in this
  // file gives each crawl item its own food bank (seedCrawlItem defaults
  // foodbank_id to the item's id), so "checks" and "food banks checked" were
  // the same number everywhere and nothing could tell the two apart.
  //
  // They are not the same number in production. crawlitem is UNIQUE on
  // (crawl_set_id, foodbank_id) (0008_needcheck.sql:52) -- so a food bank
  // cannot appear twice in ONE run, but appears once per run, and
  // 0023_crawlset_running_idx.sql:14 records the real cadence: eight article
  // runs a day, plus a needcheck and a charity run. Every food bank the
  // article pipeline touches is therefore counted eight times a day by
  // design, and a deduplicating COUNT would divide this tile by eight without
  // erroring. The panel says "checks in the last 24 hours" and that is what
  // is asserted: three checks across two food banks reads 3, not 2.
  it("counts every check, not every food bank checked", async () => {
    const db = freshDb();
    // Two article sweeps in the window, both reaching food bank 7 -- the
    // ordinary daily shape, not a failure case.
    seedCrawlSet(db, 1, "article", "2026-09-05 08:00:00.000000");
    seedCrawlSet(db, 2, "article", "2026-09-05 11:00:00.000000");
    seedCrawlItem(db, 1, "article", "2026-09-05 08:30:00.000000", { crawlSetId: 1, foodbankId: 7 });
    seedCrawlItem(db, 2, "article", "2026-09-05 11:30:00.000000", { crawlSetId: 2, foodbankId: 7 });
    seedCrawlItem(db, 3, "article", "2026-09-05 11:31:00.000000", { crawlSetId: 2, foodbankId: 8 });
    // And the same again on the need tile, which is the one an admin reads to
    // decide whether the need pipeline ran at all.
    seedCrawlSet(db, 3, "need", "2026-09-05 09:00:00.000000");
    seedCrawlSet(db, 4, "need", "2026-09-05 10:00:00.000000");
    seedCrawlItem(db, 4, "need", "2026-09-05 09:30:00.000000", { crawlSetId: 3, foodbankId: 7 });
    seedCrawlItem(db, 5, "need", "2026-09-05 10:30:00.000000", { crawlSetId: 4, foodbankId: 7 });

    const stats = await getAdminDashboardStats(d1Session(db), NOW);
    expect(stats.articleCheck24h).toBe(3); // COUNT(DISTINCT foodbank_id) would say 2
    expect(stats.needCheck24h).toBe(2); // ...and 1 here, for a food bank checked twice
  });

  // `finish IS NULL` is how a stalled or in-flight crawl looks
  // (migrations/0008_needcheck.sql:30-34). `finish >= ?` is never true for
  // NULL, so those rows drop out -- which is the intended reading of "checks
  // completed in the last 24 hours", and worth pinning because a well-meaning
  // COALESCE(finish, start) would change the metric's meaning silently.
  it("ignores items still running and items that finished before the window", async () => {
    const db = freshDb();
    seedCrawlItem(db, 1, "need", null); // started, never finished
    seedCrawlItem(db, 2, "need", "2026-09-04 11:59:59.999999"); // one microsecond too old
    seedCrawlItem(db, 3, "need", THRESHOLD); // exactly on the boundary: `>=` keeps it
    seedCrawlItem(db, 4, "need", "2026-08-01 09:00:00.000000"); // last month

    const stats = await getAdminDashboardStats(d1Session(db), NOW);
    expect(stats.needCheck24h).toBe(1);
  });

  // Same lexicographic trap as needCount24h, on a different table.
  // migrations/0022_normalise_timestamps.sql:29-33 calls this out by name:
  // crawlitem was internally consistent in ISO, and normalising it was
  // required precisely because THIS comparison moved to Django format.
  it("keeps same-day finishes that an ISO threshold would drop", async () => {
    const db = freshDb();
    seedCrawlItem(db, 1, "need", "2026-09-04 20:00:00.000000");

    const stats = await getAdminDashboardStats(d1Session(db), NOW);
    expect(stats.needCheck24h).toBe(1);

    const iso = new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const withIsoThreshold = db.prepare("SELECT COUNT(*) AS c FROM crawlitem WHERE finish >= ?").get(iso) as { c: number };
    expect(withIsoThreshold.c).toBe(0);
  });

  // A type the dashboard has no tile for must not leak into one that does.
  // crawl_type is free TEXT, and 'discrepancy' is a real value the pipeline
  // writes, so `countByType.get("need")` must be a lookup and not "the first
  // group that came back".
  it("does not fold an unrecognised crawl type into one of the three tiles", async () => {
    const db = freshDb();
    seedCrawlItem(db, 1, "discrepancy", "2026-09-05 09:00:00.000000");
    seedCrawlItem(db, 2, "discrepancy", "2026-09-05 09:01:00.000000");
    seedCrawlItem(db, 3, "need", "2026-09-05 09:02:00.000000");

    const stats = await getAdminDashboardStats(d1Session(db), NOW);
    expect(stats.needCheck24h).toBe(1);
    expect(stats.articleCheck24h).toBe(0);
    expect(stats.charityCheck24h).toBe(0);
  });

  // KNOWN DIVERGENCE FROM DJANGO, pinned as-is. Django groups by the SET's
  // type -- `values('crawl_set__crawl_type')` (views.py:67-72) -- and this
  // port groups by the ITEM's own `crawl_type` column. Two consequences,
  // both exercised here:
  //
  //   * an item whose own type disagrees with its set's is counted under its
  //     own type here and under its set's in Django;
  //   * an item with no crawl set at all (crawl_set_id is nullable, see
  //     0008_needcheck.sql:37) is counted here, and in Django lands in a
  //     `None` group that `crawl_counts.get("need", 0)` never reads.
  //
  // The port's version is one table instead of a join and gives the same
  // answer whenever the two columns agree, which is every row the pipeline
  // writes today. It is recorded here so that if the two ever diverge in
  // production, this test says which behaviour is the current one.
  it("groups by the item's own crawl_type, not the crawl set's (diverges from Django)", async () => {
    const db = freshDb();
    seedCrawlSet(db, 1, "article", "2026-09-05 00:00:00.000000");
    seedCrawlItem(db, 1, "need", "2026-09-05 09:00:00.000000", { crawlSetId: 1 });
    seedCrawlItem(db, 2, "need", "2026-09-05 09:01:00.000000", { crawlSetId: null });

    const stats = await getAdminDashboardStats(d1Session(db), NOW);
    expect(stats.needCheck24h).toBe(2);
    expect(stats.articleCheck24h).toBe(0);
  });

  it("reports 0 for every type when nothing finished in the window", async () => {
    const stats = await getAdminDashboardStats(d1Session(freshDb()), NOW);
    expect(stats.needCheck24h).toBe(0);
    expect(stats.articleCheck24h).toBe(0);
    expect(stats.charityCheck24h).toBe(0);
  });
});

describe("getAdminDashboardStats: oldestNeedCheck", () => {
  // views.py:88's Facebook exclusion. Those food banks publish their shopping
  // list on a Facebook page the crawler cannot read, so their last_need_check
  // never advances and they would squat the top of this metric forever -- the
  // panel would show the same three names every day and the real oldest check
  // would never surface. Seeding ONLY excluded rows at the top is what makes
  // this test fail if the predicate is dropped: without it, the Facebook row
  // wins on both NULL-first ordering and on date.
  it("excludes Facebook shopping lists, wherever the string appears in the URL", async () => {
    const db = freshDb();
    seedFoodbank(db, {
      id: 1,
      name: "Facebook Never Checked",
      slug: "fb-never",
      last_need_check: null,
      shopping_list_url: "https://www.facebook.com/somefoodbank/posts/123",
    });
    seedFoodbank(db, {
      id: 2,
      name: "Facebook Group",
      slug: "fb-group",
      last_need_check: "2019-01-01 09:00:00.000000",
      shopping_list_url: "https://m.facebook.com/groups/4321/permalink/99/",
    });
    seedFoodbank(db, { id: 3, name: "Salisbury", slug: "salisbury", last_need_check: "2026-09-01 09:00:00.000000" });
    seedFoodbank(db, { id: 4, name: "Bath", slug: "bath", last_need_check: "2026-09-02 09:00:00.000000" });

    const stats = await getAdminDashboardStats(d1Session(db), NOW);
    expect(stats.oldestNeedCheck).toEqual({ name: "Salisbury", slug: "salisbury", last_need_check: "2026-09-01 09:00:00.000000" });
  });

  // SUSPECTED DIVERGENCE, pinned as-is. SQLite sorts NULL first in ASC, so a
  // food bank that has never been checked wins here; Postgres sorts NULLS
  // LAST, so Django's `order_by("last_need_check").first()` returns the
  // earliest CHECKED one and never shows the never-checked bank at all.
  // Arguably the port's answer is the more useful of the two -- a food bank
  // the crawler has never reached is exactly what this metric is for -- but
  // it is a difference in what the page shows, so it is asserted rather than
  // assumed either way.
  it("puts a never-checked food bank first, because SQLite sorts NULL first in ASC", async () => {
    const db = freshDb();
    seedFoodbank(db, { id: 1, name: "Salisbury", slug: "salisbury", last_need_check: "2020-01-01 09:00:00.000000" });
    seedFoodbank(db, { id: 2, name: "Never Checked", slug: "never-checked", last_need_check: null });

    const stats = await getAdminDashboardStats(d1Session(db), NOW);
    expect(stats.oldestNeedCheck?.slug).toBe("never-checked");
    expect(stats.oldestNeedCheck?.last_need_check).toBeNull();
  });

  it("excludes closed food banks", async () => {
    const db = freshDb();
    seedFoodbank(db, { id: 1, name: "Closed", slug: "closed", last_need_check: "2010-01-01 09:00:00.000000", is_closed: 1 });
    seedFoodbank(db, { id: 2, name: "Salisbury", slug: "salisbury", last_need_check: "2026-09-01 09:00:00.000000" });

    const stats = await getAdminDashboardStats(d1Session(db), NOW);
    expect(stats.oldestNeedCheck?.slug).toBe("salisbury");
  });

  // SUSPECTED DIVERGENCE, pinned as-is. SQLite's LIKE is case-insensitive for
  // ASCII by default; Django's `__contains` compiles to a case-SENSITIVE LIKE
  // on Postgres (`icontains` is the insensitive one). So a URL stored as
  // "FACEBOOK.COM" is excluded by this port and kept by Django. Both
  // behaviours are defensible -- the port's is arguably the intended one --
  // but only one of them is what the code does, and this is it.
  it("also excludes an upper-cased facebook.com, unlike Django's case-sensitive __contains", async () => {
    const db = freshDb();
    seedFoodbank(db, { id: 1, name: "Shouty", slug: "shouty", last_need_check: "2019-01-01 09:00:00.000000", shopping_list_url: "HTTPS://WWW.FACEBOOK.COM/SHOUTY" });
    seedFoodbank(db, { id: 2, name: "Salisbury", slug: "salisbury", last_need_check: "2026-09-01 09:00:00.000000" });

    const stats = await getAdminDashboardStats(d1Session(db), NOW);
    expect(stats.oldestNeedCheck?.slug).toBe("salisbury");
  });

  // A URL that merely mentions the word must still be crawled: the pattern is
  // '%facebook.com%', not '%facebook%'. Pinned because tightening or loosening
  // that pattern silently changes which food banks are visible in the queue.
  it("keeps a non-Facebook URL that happens to contain the word", async () => {
    const db = freshDb();
    seedFoodbank(db, { id: 1, name: "Notts", slug: "notts", last_need_check: "2026-09-01 09:00:00.000000", shopping_list_url: "https://example.org/our-facebook-page/" });

    const stats = await getAdminDashboardStats(d1Session(db), NOW);
    expect(stats.oldestNeedCheck?.slug).toBe("notts");
  });

  // Two ways to have no candidate, both of which must give the template a
  // null to skip over rather than an undefined it would render as a blank
  // row: nothing in the table at all, and nothing the filters allow through.
  it("is null when no food bank survives the filters", async () => {
    const facebookOnly = freshDb();
    seedFoodbank(facebookOnly, { id: 1, name: "FB", slug: "fb", last_need_check: null, shopping_list_url: "https://facebook.com/fb" });

    expect((await getAdminDashboardStats(d1Session(freshDb()), NOW)).oldestNeedCheck).toBeNull();
    expect((await getAdminDashboardStats(d1Session(facebookOnly), NOW)).oldestNeedCheck).toBeNull();
  });

  // The `shopping_list_url IS NULL OR ...` half of that predicate can never
  // match: the column is NOT NULL in 0001_core.sql:27 (Django's URLField at
  // models/foodbank.py:107 declares no null=True either). It is defensive
  // rather than dead-in-error -- SQLite's NOT LIKE against NULL yields NULL,
  // which would drop the row -- so the guard is right to be there and this
  // test records WHY it never fires, by proving the schema refuses the value.
  //
  // It is also the answer to a mutant that CANNOT be killed and should not be
  // chased: rewriting that guard as `shopping_list_url = NULL` (the classic
  // SQLite trap, always NULL and so never true) changes nothing, because
  // neither form can ever match a row this table is able to hold. The
  // constraint below is the proof, and it is a stronger one than any query
  // assertion would be.
  it("cannot see a NULL shopping_list_url, because the column forbids one", () => {
    const db = freshDb();
    // Straight at the table rather than through seedFoodbank, which would
    // substitute its default for a null.
    const insert = () =>
      db
        .prepare(
          `INSERT INTO foodbank (id, uuid, name, slug, address, postcode, country, lat_lng,
             charity_just_foodbank, contact_email, url, shopping_list_url,
             address_is_administrative, is_closed, no_locations, days_between_needs, created, modified)
           VALUES (1, 'u', 'No List', 'no-list', 'Address', 'SP2 9DY', 'England', '51.06,-1.79',
             0, 'info@example.org', 'https://example.org/', NULL,
             0, 0, 0, 7, '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
        )
        .run();
    expect(insert).toThrow(/NOT NULL constraint failed: foodbank\.shopping_list_url/);
  });
});

describe("getAdminDashboardStats: latestNeedCheck", () => {
  it("returns the most recently checked open food bank", async () => {
    const db = freshDb();
    seedFoodbank(db, { id: 1, name: "Salisbury", slug: "salisbury", last_need_check: "2026-09-05 09:00:00.000000" });
    seedFoodbank(db, { id: 2, name: "Bath", slug: "bath", last_need_check: "2026-09-05 11:00:00.000000" });
    seedFoodbank(db, { id: 3, name: "Wilton", slug: "wilton", last_need_check: "2026-09-05 10:00:00.000000" });

    const stats = await getAdminDashboardStats(d1Session(db), NOW);
    expect(stats.latestNeedCheck).toEqual({ name: "Bath", slug: "bath", last_need_check: "2026-09-05 11:00:00.000000" });
  });

  it("excludes closed food banks even when theirs is the newest check", async () => {
    const db = freshDb();
    seedFoodbank(db, { id: 1, name: "Closed", slug: "closed", last_need_check: "2030-01-01 09:00:00.000000", is_closed: 1 });
    seedFoodbank(db, { id: 2, name: "Salisbury", slug: "salisbury", last_need_check: "2026-09-05 09:00:00.000000" });

    const stats = await getAdminDashboardStats(d1Session(db), NOW);
    expect(stats.latestNeedCheck?.slug).toBe("salisbury");
  });

  // The `last_need_check IS NOT NULL` predicate is belt and braces on this
  // engine -- SQLite already sorts NULLs last under DESC -- but it is what
  // Django's `.exclude(last_need_check__isnull=True)` (views.py:89) says, and
  // it is the reason the port does NOT rely on engine-specific NULL placement
  // here the way the ASC queries above accidentally do. Seeded so that the
  // only row without a check would otherwise be a candidate.
  it("never returns a food bank that has never been checked", async () => {
    const db = freshDb();
    seedFoodbank(db, { id: 1, name: "Never Checked", slug: "never-checked", last_need_check: null });

    const stats = await getAdminDashboardStats(d1Session(db), NOW);
    expect(stats.latestNeedCheck).toBeNull();
  });

  // The Facebook exclusion is on the OLDEST query only, in Django
  // (views.py:88 vs :89) and therefore here. A Facebook food bank whose list
  // did get checked is legitimately the latest check; the asymmetry is
  // deliberate, and copying the filter onto both queries "for consistency"
  // would be a silent behaviour change.
  it("does NOT apply the Facebook exclusion, matching Django's asymmetry", async () => {
    const db = freshDb();
    seedFoodbank(db, { id: 1, name: "FB", slug: "fb", last_need_check: "2026-09-05 11:00:00.000000", shopping_list_url: "https://www.facebook.com/fb" });
    seedFoodbank(db, { id: 2, name: "Salisbury", slug: "salisbury", last_need_check: "2026-09-05 09:00:00.000000" });

    const stats = await getAdminDashboardStats(d1Session(db), NOW);
    expect(stats.latestNeedCheck?.slug).toBe("fb");
  });
});

describe("getAdminDashboardStats: latestNeedCrawlSetId", () => {
  // Django is `CrawlSet.objects.filter(crawl_type="need").order_by("-start")
  // .first()` (views.py:59). The dashboard links this id straight through to
  // the crawl set's own page, so the wrong id is a page about the wrong run,
  // rendered without complaint.
  //
  // The ids here run BACKWARDS against the starts on purpose: the newest run
  // is id 1 and the oldest is id 3, so an `ORDER BY id DESC` -- the shape a
  // "latest row" query drifts into -- returns 3 and fails.
  it("picks the need crawl set with the newest start, not the highest id", async () => {
    const db = freshDb();
    seedCrawlSet(db, 1, "need", "2026-09-05 09:00:00.000000");
    seedCrawlSet(db, 2, "need", "2026-09-04 09:00:00.000000");
    seedCrawlSet(db, 3, "need", "2026-09-03 09:00:00.000000");

    const stats = await getAdminDashboardStats(d1Session(db), NOW);
    expect(stats.latestNeedCrawlSetId).toBe(1);
  });

  // crawl_type is the only thing separating the four pipelines that share
  // this table. An article run happens far more often than a need run, so a
  // dropped filter would leave this pointing at an article set almost always
  // -- which is why the article row here has the newest start of all.
  it("ignores crawl sets of other types, however recent", async () => {
    const db = freshDb();
    seedCrawlSet(db, 1, "need", "2026-09-04 09:00:00.000000");
    seedCrawlSet(db, 2, "article", "2026-09-05 11:00:00.000000");
    seedCrawlSet(db, 3, "charity", "2026-09-05 10:00:00.000000");

    const stats = await getAdminDashboardStats(d1Session(db), NOW);
    expect(stats.latestNeedCrawlSetId).toBe(1);
  });

  // SURVIVING MUTANTS, now killed: `crawl_type = 'need'` rewritten as
  // `LIKE 'need'`, as `LIKE '%need%'`, or as `lower(crawl_type) = 'need'`.
  // All three lived through the first pass, because the only other types ever
  // seeded against this query were 'article' and 'charity' -- neither of which
  // is a case-variant or a superstring of "need", so nothing distinguished an
  // exact match from a loose one.
  //
  // That gap matters more here than it looks, because this very file proves
  // two blocks below that SQLite's LIKE ignores ASCII case -- so a reader who
  // has just learnt that could reasonably assume `=` does too, and it does
  // not. Both decoys below have a NEWER start than the real need run, so any
  // loosening returns one of them and the dashboard's link opens a page about
  // the wrong pipeline's run.
  it("matches crawl_type exactly, and case-sensitively", async () => {
    const db = freshDb();
    seedCrawlSet(db, 1, "need", "2026-09-04 09:00:00.000000");
    // 'needcheck' is the shape of this pipeline's own run_id
    // ("needcheck-2026-09-01", 0008_needcheck.sql:20), so writing it into the
    // type column is a realistic slip rather than a contrived one -- and
    // crawl_type is free TEXT with no CHECK constraint to catch it.
    seedCrawlSet(db, 2, "needcheck", "2026-09-05 10:00:00.000000");
    seedCrawlSet(db, 3, "Need", "2026-09-05 11:00:00.000000");

    const stats = await getAdminDashboardStats(d1Session(db), NOW);
    expect(stats.latestNeedCrawlSetId).toBe(1);
  });

  // A need crawl set's `finish` is stamped by the consumer when `remaining`
  // reaches zero (0008_needcheck.sql:11-16), so the run in progress -- the
  // one an admin looking at this panel most wants -- has finish IS NULL.
  // Ordering by `start` rather than `finish` is what makes it visible.
  it("returns a still-running set when it is the most recent", async () => {
    const db = freshDb();
    seedCrawlSet(db, 1, "need", "2026-09-04 09:00:00.000000", "2026-09-04 10:00:00.000000");
    seedCrawlSet(db, 2, "need", "2026-09-05 09:00:00.000000", null);

    const stats = await getAdminDashboardStats(d1Session(db), NOW);
    expect(stats.latestNeedCrawlSetId).toBe(2);
  });

  // Unlike every other stat in this module, this one is NOT windowed to 24
  // hours -- Django's version is not either. A pipeline that stopped running
  // a week ago still shows its last set rather than an empty tile, which is
  // how an admin notices it stopped.
  it("is not limited to the last 24 hours", async () => {
    const db = freshDb();
    seedCrawlSet(db, 1, "need", "2025-01-01 09:00:00.000000");

    const stats = await getAdminDashboardStats(d1Session(db), NOW);
    expect(stats.latestNeedCrawlSetId).toBe(1);
  });

  it("is null when no need crawl set has ever run", async () => {
    const db = freshDb();
    seedCrawlSet(db, 1, "article", "2026-09-05 09:00:00.000000");

    expect((await getAdminDashboardStats(d1Session(db), NOW)).latestNeedCrawlSetId).toBeNull();
  });
});

describe("getOldestEditedFoodbankSlug", () => {
  // gfadmin/views.py:361-366 foodbanks_next(). The module's own comment says
  // this is the "same query" as the oldestEdit stat, and the two are written
  // out separately -- so nothing but this test stops them drifting apart and
  // sending the "Next" button to a food bank other than the one the dashboard
  // says is oldest. Both are run against one fixture and compared.
  it("agrees with the dashboard's own oldestEdit stat", async () => {
    const db = freshDb();
    seedFoodbank(db, { id: 1, name: "Salisbury", slug: "salisbury", edited: "2026-08-01 09:00:00.000000" });
    seedFoodbank(db, { id: 2, name: "Bath", slug: "bath", edited: "2026-09-01 09:00:00.000000" });
    seedFoodbank(db, { id: 3, name: "Closed Oldest", slug: "closed-oldest", edited: "2019-01-01 09:00:00.000000", is_closed: 1 });

    const stats = await getAdminDashboardStats(d1Session(db), NOW);
    const slug = await getOldestEditedFoodbankSlug(d1Session(db));

    expect(slug).toBe("salisbury");
    expect(slug).toBe(stats.oldestEdit?.slug);
  });

  // Same NULL-first ordering as the stat, and the reason it matters here is
  // sharper: this is a redirect target. A never-edited food bank is what the
  // review queue should reach first, and it does -- but note that the button
  // will keep returning to it until someone saves that row, because saving is
  // what stamps `edited`.
  it("sends the reviewer to a never-edited food bank first", async () => {
    const db = freshDb();
    seedFoodbank(db, { id: 1, name: "Salisbury", slug: "salisbury", edited: "2026-08-01 09:00:00.000000" });
    seedFoodbank(db, { id: 2, name: "Never Edited", slug: "never-edited", edited: null });

    expect(await getOldestEditedFoodbankSlug(d1Session(db))).toBe("never-edited");
  });

  it("skips closed food banks", async () => {
    const db = freshDb();
    seedFoodbank(db, { id: 1, name: "Closed", slug: "closed", edited: "2010-01-01 09:00:00.000000", is_closed: 1 });
    seedFoodbank(db, { id: 2, name: "Salisbury", slug: "salisbury", edited: "2026-08-01 09:00:00.000000" });

    expect(await getOldestEditedFoodbankSlug(d1Session(db))).toBe("salisbury");
  });

  // The caller redirects to /admin/foodbanks/ instead of a food bank page
  // when this is null (workers/site/src/routes/admin/lists.ts:275-278), so
  // null has to actually come back rather than `undefined` reaching a
  // template literal and producing /admin/foodbank/undefined/.
  it("returns null, not undefined, when there is no open food bank at all", async () => {
    const db = freshDb();
    seedFoodbank(db, { id: 1, name: "Closed", slug: "closed", edited: "2026-08-01 09:00:00.000000", is_closed: 1 });

    const slug = await getOldestEditedFoodbankSlug(d1Session(db));
    expect(slug).toBeNull();
    expect(slug).not.toBeUndefined();
  });
});
