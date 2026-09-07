import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS_SQL as SCHEMA } from "./schema.testkit";
import { getFoodbanksByCountryForCharityCrawl, getFoodbankForCharityCrawl, patchFoodbankCharity, replaceCharityYears } from "./charity";
import { pyNow } from "@givefood/models";
import type { Session } from "./types";

// pyNow() SPIED, NOT STUBBED -- the real implementation still runs, so every
// timestamp assertion below is against a genuine pyNow() value and this changes
// no behaviour. The spy exists for exactly one claim that is otherwise
// unprovable: replaceCharityYears reads the clock ONCE, before the map, and
// gives every row in the batch that same `created` value. Moving `pyNow()`
// inside the map produces byte-identical strings -- the whole batch is built in
// one synchronous pass, so no clock can advance between rows, and under fake
// timers it certainly cannot -- which makes the call COUNT the only observable
// difference. See "reads the clock once for the whole batch" below.
vi.mock("@givefood/models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@givefood/models")>();
  return { ...actual, pyNow: vi.fn(actual.pyNow) };
});

// WP 5.5 / PLAN.md §8.7 -- charityinfo's own D1 access. Four functions, and
// all four are nothing but SQL: the cron's per-regulator enqueue query, the
// dequeue-time re-fetch, a dynamically-assembled UPDATE, and a
// delete-and-reinsert batch. The Django originals are
// gfoffline/management/commands/charityinfo.py:19 (the queryset) and
// givefood/utils/crawlers.py:79-278 (`foodbank_charity_crawl` and its three
// per-regulator branches).
//
// EVERY FAILURE MODE IN THIS MODULE IS SILENT, and most of them are silent in
// the direction of WRITING THE WRONG THING rather than reading it:
//
//   * A dropped `charity_number != ''` predicate enqueues the food banks whose
//     number is the empty string, and crawlOpenCharities then fetches
//     `https://opencharities.uk/ew/.json` for each of them. No error, just a
//     daily pile of 404s and a CrawlSet that never matches its expected count.
//   * A dropped `is_closed = 0` re-crawls closed food banks forever.
//   * A misaligned placeholder in patchFoodbankCharity writes the charity's
//     postcode into charity_website. Both are TEXT; nothing raises; the food
//     bank page renders a link to "SP2 9DY".
//   * A whitelist that stopped filtering would let any key in `patch` become a
//     SET clause -- `name`, `slug`, or a whole second assignment.
//   * A DELETE that lost its WHERE would empty charityyear for all 831 food
//     banks with a charity number, on the first message of the next cron run.
//
// None of that is visible as a 500 or a log line, which is why this file runs
// the real statements against a real engine rather than a session that hands
// back canned rows. A canned row proves only that the D1 result object has a
// `.results` on it.
//
// MUTATION-TESTED (TESTING.md's convention), in three rounds, FIFTY-FOUR
// deliberate breakages in total. The module's source was rewritten at import
// time by a vitest `load` hook driven from the scratchpad, so nothing in the
// repo was ever edited, and this file re-run against each: every predicate
// dropped in turn and `is_closed = 0` inverted, ORDER BY removed, reversed and
// swapped for both ORDER BY id and ORDER BY name, a LIMIT added, `IN` narrowed
// to `=` and negated to `NOT IN`, `SELECT *` in place of both column lists,
// charity_id dropped from the re-fetch, its WHERE removed, filtered on
// is_closed, and its `=` swapped for `IS NOT`, first() swapped for all()[0],
// the patch whitelist deleted and replaced by a `startsWith("charity_")` prefix
// test, charity_number added to the whitelist, present-but-undefined keys
// filtered out, the patch's values AND its SET clauses each re-ordered into the
// canonical column order, all three placeholder expressions shifted by one and
// made zero-based, its `?? null` dropped and turned into empty strings, its
// WHERE removed and negated, its bind order reversed, its unconditional stamp
// made conditional, the DELETE's WHERE removed, made null-inclusive, negated
// and bound to a constant, `created` dropped from the INSERT, the INSERT's
// foodbank_id shifted by one, income and expenditure transposed, date and
// income transposed, income coalesced to null, the batch unrolled into
// sequential awaits, the DELETE moved after the INSERTs, an early return added
// for an empty year list, pyNow() replaced by toISOString() and moved inside
// the map. FIFTY-ONE FAILED.
//
// The three that SURVIVED are written into the file rather than left as a
// comment that overclaims, because all three are EQUIVALENT mutants -- they
// change the source without changing what it does, so no assertion can tell:
//
//   * `charity_number IS NOT NULL` deleted, and `!= ''` rewritten as `IS NOT
//     ''` -- individually both select exactly the same rows under SQLite's
//     three-valued logic. See the note on that below; the PAIR is not
//     equivalent, and breaking both at once is caught.
//   * the country list bound in reverse -- `IN` is a set test.
//
// Four mutants that survived an EARLIER round were real gaps, and each is now
// closed by a test written for it, named in that test's own comment so a future
// reader knows what deleting it would give back: the prefix-shaped whitelist
// and the extra whitelist entry (see "accepts exactly the eight whitelisted
// charity_ columns"), `ORDER BY slug` swapped for `ORDER BY name` (see "orders
// by slug, not by the name the slug is derived from"), and pyNow() moved inside
// the map (see "reads the clock once for the whole batch").
//
// THE SCHEMA IS THE MIGRATION FILES THEMSELVES, applied in order, exactly as
// adminSubscribers.test.ts does it and for the same reason: migration 0019
// dropped `foodbank_name` off five tables and four queries elsewhere went on
// naming a column that no longer existed, silently, until somebody measured
// /dashboard/beautybanks/. A hand-transcribed CREATE TABLE in a test file is a
// second copy of the truth, and second copies drift. Reading the migrations
// means this file fails the day a migration and this module disagree.
//
// WHY THE SUPPRESSED IMPORTS. packages/db typechecks with
// `"types": ["@cloudflare/workers-types"]` and no @types/node, so tsc reports
// TS2591 on the `node:sqlite` and `node:fs` specifiers and TS2339 on
// `import.meta.url`. `@ts-ignore` rather than the expect-error form,
// following adminStats.test.ts:31-40: if @types/node is ever added to this
// package, an unused expect-error directive would itself become an error, and
// a suite that breaks when the tooling is FIXED is worse than three lines of
// suppression. The wording of this paragraph matters as much as the choice --
// tsc reads any comment LINE STARTING with that directive's name as the
// directive itself, prose or not, which is a TS2578 of its own. Everything
// else in this file is checked -- SqliteDatabase below re-narrows what the
// suppression widened.
// @ts-ignore -- no @types/node under this package's tsconfig; vitest runs in node, where this module is real
import { DatabaseSync } from "node:sqlite";
// @ts-ignore -- as above

// @ts-ignore -- import.meta.url is real under vitest's node environment

// ===========================================================================
// HARNESS
// ===========================================================================

type Bindable = null | number | bigint | string | Uint8Array;

interface SqliteStatement {
  all(...params: Bindable[]): Record<string, unknown>[];
  get(...params: Bindable[]): Record<string, unknown> | undefined;
  run(...params: Bindable[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface Sent {
  sql: string;
  params: Bindable[];
}

interface FakeStatement extends Sent {
  bind(...values: unknown[]): FakeStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean }>;
}

// The D1 Sessions API surface charity.ts uses, over node:sqlite. Deliberately
// thin: it must not interpret the SQL, only carry it to a real engine, or
// these tests would be asserting against a second implementation of the thing
// under test.
//
// Two things it does model on purpose.
//
// bind() RETURNS A NEW STATEMENT rather than mutating this one, matching D1's
// immutable prepared statements. replaceCharityYears builds N statements from
// N separate prepare() calls and hands them to batch() together; a harness
// that mutated in place would let the last year's bindings overwrite every
// earlier one's and turn twelve financial years into twelve copies of the
// most recent -- a mutant no assertion about row COUNT would ever catch.
//
// batch() RUNS THE STATEMENTS IN ORDER, IN ONE TRANSACTION, because D1's does.
// That is the entire reason replaceCharityYears builds a batch instead of
// awaiting a DELETE and then N INSERTs (PLAN.md §8.7.1), so "the old rows are
// still there when an insert fails" has to be an executable claim here rather
// than a paragraph of prose in the module header.
function d1Session(db: SqliteDatabase): { session: Session; calls: Sent[]; batches: Sent[][] } {
  const calls: Sent[] = [];
  const batches: Sent[][] = [];

  function statement(sql: string, params: Bindable[]): FakeStatement {
    return {
      sql,
      params,
      bind: (...values: unknown[]) => statement(sql, values as Bindable[]),
      first: async <T,>() => {
        calls.push({ sql, params });
        return (db.prepare(sql).get(...params) ?? null) as T | null;
      },
      all: async <T,>() => {
        calls.push({ sql, params });
        return { results: db.prepare(sql).all(...params) as T[] };
      },
      run: async () => {
        calls.push({ sql, params });
        db.prepare(sql).run(...params);
        return { success: true };
      },
    };
  }

  const session = {
    prepare: (sql: string) => statement(sql, []),
    async batch(statements: FakeStatement[]) {
      batches.push(statements.map((s) => ({ sql: s.sql, params: s.params })));
      db.exec("BEGIN");
      try {
        const results = statements.map((s) => {
          const { changes, lastInsertRowid } = db.prepare(s.sql).run(...s.params);
          return { success: true, results: [], meta: { changes: Number(changes), last_row_id: Number(lastInsertRowid) } };
        });
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    getBookmark: () => null,
  };

  return { session: session as unknown as Session, calls, batches };
}

// ===========================================================================
// FIXTURES
// ===========================================================================

// Every column 0001_core.sql declares NOT NULL on `foodbank`, plus the nine
// charity_* / last_charity_check columns this module reads and writes. Spelt
// out in full rather than trimmed to the interesting few because the real DDL
// is what the fixture applies and a shorter INSERT simply will not run -- and
// because that is the property worth having: a migration that adds a NOT NULL
// column breaks this file loudly instead of leaving it green against a schema
// production no longer has.
interface FoodbankSeed {
  id: number;
  slug: string;
  name?: string;
  country?: string;
  charityNumber?: string | null;
  isClosed?: number;
  charityId?: string | null;
  charityName?: string | null;
  charityType?: string | null;
  charityRegDate?: string | null;
  charityPostcode?: string | null;
  charityWebsite?: string | null;
  charityObjectives?: string | null;
  charityPurpose?: string | null;
  lastCharityCheck?: string | null;
  modified?: string;
}

// The Postgres-shaped timestamps the ETL wrote (tools/pg-to-d1), which is what
// every ordering and comparison in this database is against. Django's
// `str(datetime)`: a SPACE separator and six fractional digits, never a 'T'
// and never a 'Z' -- see @givefood/models' pyDatetime header for what happens
// when the two formats meet in a TEXT column.
const DJANGO_NOW = "2026-09-05 19:28:08.853000";
const DJANGO_EARLIER = "2026-09-04 05:30:00.000000";

let db: SqliteDatabase;
let session: Session;
let calls: Sent[];
let batches: Sent[][];

function seedFoodbank(seed: FoodbankSeed): void {
  db.prepare(
    "INSERT INTO foodbank (id, uuid, name, slug, address, postcode, country, lat_lng, charity_just_foodbank, " +
      "contact_email, url, shopping_list_url, address_is_administrative, is_closed, no_locations, days_between_needs, " +
      "created, modified, charity_number, charity_id, charity_name, charity_type, charity_reg_date, charity_postcode, " +
      "charity_website, charity_objectives, charity_purpose, last_charity_check) " +
      "VALUES (?, ?, ?, ?, '1 Test Street', 'SP2 9DY', ?, '51.0688,-1.7945', 1, 'info@example.org', " +
      "'https://example.org/', 'https://example.org/list/', 0, ?, 0, 7, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    seed.id,
    `uuid-${seed.slug}`,
    seed.name ?? `${seed.slug} Food Bank`,
    seed.slug,
    seed.country ?? "England",
    seed.isClosed ?? 0,
    DJANGO_EARLIER,
    seed.modified ?? DJANGO_EARLIER,
    seed.charityNumber === undefined ? "1130612" : seed.charityNumber,
    seed.charityId ?? null,
    seed.charityName ?? null,
    seed.charityType ?? null,
    seed.charityRegDate ?? null,
    seed.charityPostcode ?? null,
    seed.charityWebsite ?? null,
    seed.charityObjectives ?? null,
    seed.charityPurpose ?? null,
    seed.lastCharityCheck ?? null,
  );
}

function seedCharityYear(row: { foodbankId: number | null; date: string; income?: number | null; expenditure?: number | null; created?: string }): void {
  db.prepare("INSERT INTO charityyear (foodbank_id, date, income, expenditure, created) VALUES (?, ?, ?, ?, ?)").run(
    row.foodbankId,
    row.date,
    row.income ?? 100,
    row.expenditure ?? 90,
    row.created ?? DJANGO_EARLIER,
  );
}

// Spread into a plain object: node:sqlite hands back null-prototype rows, and
// the assertions read better against ordinary ones.
function foodbankRow(id: number): Record<string, unknown> {
  return { ...(db.prepare("SELECT * FROM foodbank WHERE id = ?").get(id) as Record<string, unknown>) };
}

function charityYears(foodbankId: number | null): Record<string, unknown>[] {
  const sql = foodbankId === null ? "SELECT * FROM charityyear WHERE foodbank_id IS NULL ORDER BY id" : "SELECT * FROM charityyear WHERE foodbank_id = ? ORDER BY id";
  const rows = foodbankId === null ? db.prepare(sql).all() : db.prepare(sql).all(foodbankId);
  return rows.map((row) => ({ ...row }));
}

beforeEach(() => {
  db = new DatabaseSync(":memory:") as SqliteDatabase;
  db.exec(SCHEMA);
  ({ session, calls, batches } = d1Session(db));
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
});

// ===========================================================================
// getFoodbanksByCountryForCharityCrawl
// ===========================================================================
//
// The cron's enqueue query. Django ran ONE query --
// `Foodbank.objects.filter(charity_number__isnull=False, is_closed=False)
// .order_by("?")` (charityinfo.py:19) -- and branched on country inside
// `foodbank_charity_crawl` (crawlers.py:89-101), returning False for anything
// that matched no regulator. This port pushes the branch into the WHERE clause
// so each of the three queues only ever sees the food banks it is responsible
// for. The rows a country filter must NOT return are therefore the whole point
// of the function, and every one of them is seeded below.

// Ids run backwards through the alphabet on purpose: if ORDER BY slug were
// dropped, SQLite would return these in rowid order, which is the reverse.
// Seeding them in slug order would make a missing ORDER BY invisible.
function seedCrawlPopulation(): void {
  seedFoodbank({ id: 1, slug: "wandsworth", country: "England", charityNumber: "1140123" });
  seedFoodbank({ id: 2, slug: "salisbury", country: "England", charityNumber: "1130612" });
  seedFoodbank({ id: 3, slug: "belfast", country: "Northern Ireland", charityNumber: "NIC101010" });
  seedFoodbank({ id: 4, slug: "bangor", country: "Wales", charityNumber: "1122334" });
  seedFoodbank({ id: 5, slug: "aberdeen", country: "Scotland", charityNumber: "SC012345" });
  // The four that must never be enqueued, one per predicate.
  seedFoodbank({ id: 6, slug: "douglas", country: "Isle of Man", charityNumber: "IOM0001" });
  seedFoodbank({ id: 7, slug: "closed-town", country: "England", charityNumber: "1150000", isClosed: 1 });
  seedFoodbank({ id: 8, slug: "no-number", country: "England", charityNumber: null });
  seedFoodbank({ id: 9, slug: "blank-number", country: "England", charityNumber: "" });
}

const slugs = (rows: { slug: string }[]): string[] => rows.map((row) => row.slug);

describe("getFoodbanksByCountryForCharityCrawl", () => {
  it("returns the England and Wales food banks, in slug order, and nothing else", async () => {
    seedCrawlPopulation();

    const rows = await getFoodbanksByCountryForCharityCrawl(session, ["England", "Wales"]);

    // Exact list, exact order. "Returns an array" would pass against a query
    // with no WHERE clause at all; this fails against a dropped predicate, a
    // dropped ORDER BY, or a country list bound in the wrong slot.
    expect(slugs(rows)).toEqual(["bangor", "salisbury", "wandsworth"]);
    expect(rows.map((row) => row.id)).toEqual([4, 2, 1]);
  });

  // The two single-country queues. scheduled/index.ts:221-223 issues all three
  // of these and sums their lengths into the CrawlSet's expected count, so the
  // three result sets must PARTITION the eligible rows -- no overlap, nothing
  // dropped. An `IN` bound with the wrong list would still return plausible
  // rows; only checking all three together catches it.
  it("partitions the eligible food banks across the three regulator queues", async () => {
    seedCrawlPopulation();

    const ew = await getFoodbanksByCountryForCharityCrawl(session, ["England", "Wales"]);
    const scotland = await getFoodbanksByCountryForCharityCrawl(session, ["Scotland"]);
    const ni = await getFoodbanksByCountryForCharityCrawl(session, ["Northern Ireland"]);

    expect(slugs(scotland)).toEqual(["aberdeen"]);
    expect(slugs(ni)).toEqual(["belfast"]);

    const all = [...slugs(ew), ...slugs(scotland), ...slugs(ni)];
    expect(all.slice().sort()).toEqual(["aberdeen", "bangor", "belfast", "salisbury", "wandsworth"]);
    expect(new Set(all).size).toBe(all.length);
  });

  // crawlers.py:99-100's `else: return False`. The Isle of Man food bank
  // matched no branch in Django and gets no register here either
  // (crawlOpenCharities.ts:66-74 says so in as many words). It must appear in
  // none of the three queues -- an enqueued message for it would burn a
  // CrawlItem and a fetch on a URL that cannot exist.
  it("never enqueues a country with no regulator", async () => {
    seedCrawlPopulation();

    for (const countries of [["England", "Wales"], ["Scotland"], ["Northern Ireland"]]) {
      expect(slugs(await getFoodbanksByCountryForCharityCrawl(session, countries))).not.toContain("douglas");
    }
    expect(slugs(await getFoodbanksByCountryForCharityCrawl(session, ["Isle of Man"]))).toEqual(["douglas"]);
  });

  it("excludes a closed food bank", async () => {
    seedCrawlPopulation();

    // charityinfo.py:19's `is_closed=False`. A closed food bank keeps its
    // charity number forever, so without this predicate the daily crawl grows
    // monotonically and never shrinks.
    expect(slugs(await getFoodbanksByCountryForCharityCrawl(session, ["England", "Wales"]))).not.toContain("closed-town");
  });

  // THE TWO charity_number PREDICATES ARE NOT INDEPENDENT, and this test says
  // so rather than implying otherwise. `charity_number IS NOT NULL` is
  // redundant: the `!= ''` beside it already drops a NULL row, because SQLite's
  // three-valued logic makes `NULL != ''` evaluate to NULL and a WHERE clause
  // keeps a row only when its expression is TRUE. Run, not reasoned about:
  //
  //   SELECT (NULL != '') IS NULL, ('' != ''), ('1130612' != '');  -- 1, 0, 1
  //
  // Confirmed by mutation as well -- deleting `charity_number IS NOT NULL`
  // from the query leaves every test in this file green, and no behavioural
  // test can be written that would catch it, because the two forms select
  // exactly the same rows. The predicate is belt-and-braces (and reads as
  // intent, which is worth something); the one actually holding both cases up
  // is `!= ''`. Deleting THAT would let both the NULL and the empty-string
  // food banks into the queue.
  //
  // Rewriting `!= ''` as the null-safe `IS NOT ''` is equivalent too, for the
  // same reason in reverse: the redundant `IS NOT NULL` in front of it already
  // rejects the NULL row that `IS NOT ''` would otherwise admit. So the two
  // predicates are each individually removable and TOGETHER load-bearing --
  // breaking BOTH at once (drop `IS NOT NULL`, make the other null-safe) puts
  // `no-number` back in the queue and is caught by this test.
  it("excludes a NULL charity number", async () => {
    seedCrawlPopulation();

    expect(slugs(await getFoodbanksByCountryForCharityCrawl(session, ["England", "Wales"]))).not.toContain("no-number");
  });

  // A DELIBERATE DIVERGENCE FROM DJANGO, and the reason it is separated from
  // the NULL case above. `charity_number` is a CharField(null=True, blank=True)
  // (models/foodbank.py:76), so an admin who clears the field in the form
  // stores '' rather than NULL, and Django's `charity_number__isnull=False`
  // KEEPS that row -- `foodbank_charity_crawl` then falls through its own
  // `if not foodbank.charity_number: return False` guard and the crawl is a
  // no-op. This port has no such guard downstream: crawlOpenCharities.ts:173
  // would build `https://opencharities.uk/ew/.json` from the empty string and
  // fetch it. The `!= ''` predicate is what stands in for Django's truthiness
  // check, and deleting it would produce a daily run of 404s and a CrawlSet
  // whose expected count never reconciles.
  it("excludes an EMPTY-STRING charity number, which Django's isnull filter kept", async () => {
    seedCrawlPopulation();

    expect(slugs(await getFoodbanksByCountryForCharityCrawl(session, ["England", "Wales"]))).not.toContain("blank-number");
  });

  // SQLite compares TEXT with BINARY collation, so `IN ('England')` is
  // case-sensitive. Production values come from COUNTRIES_CHOICES and are
  // always capitalised, so this is documentation of an exact-match contract
  // rather than a live hazard -- but it is the reason a hand-typed country in
  // a future admin form would silently drop that food bank out of the crawl
  // altogether rather than landing it in some default queue.
  it("matches the country exactly, case included", async () => {
    seedFoodbank({ id: 1, slug: "lowercase-england", country: "england" });
    seedFoodbank({ id: 2, slug: "proper-england", country: "England" });

    expect(slugs(await getFoodbanksByCountryForCharityCrawl(session, ["England"]))).toEqual(["proper-england"]);
  });

  // ORDERED BY slug, NOT BY THE COLUMN IT IS DERIVED FROM. Django sets
  // `self.slug = slugify(self.name)` on every save (models/foodbank.py:634), so
  // name and slug are near-copies of each other -- and seedCrawlPopulation's
  // names are literally its slugs with a suffix, which means the exact-order
  // assertion at the top of this describe cannot tell `ORDER BY slug` from
  // `ORDER BY name`. Swapping one for the other left every other test in this
  // file green.
  //
  // They are not the same order. slugify() lowercases, and SQLite compares TEXT
  // with BINARY collation, where every uppercase letter sorts before every
  // lowercase one -- so a single internal capital inverts a pair. Both rows here
  // are slugify-consistent, i.e. exactly what Django's own save() would have
  // written; this is a divergence the real table can contain, not a contrived
  // one.
  it("orders by slug, not by the name the slug is derived from", async () => {
    seedFoodbank({ id: 1, slug: "macmillan-way", name: "MacMillan Way" });
    seedFoodbank({ id: 2, slug: "machin-road", name: "Machin Road" });

    // By name, "MacMillan Way" comes FIRST -- at index 3 it has 'M' (0x4D)
    // against "Machin Road"'s 'h' (0x68). By slug, "machin-road" comes first:
    // 'h' (0x68) against "macmillan-way"'s 'm' (0x6D). Exactly inverted.
    expect(slugs(await getFoodbanksByCountryForCharityCrawl(session, ["England"]))).toEqual(["machin-road", "macmillan-way"]);
  });

  it("returns only id and slug, which is all the queue message carries", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });

    const [row] = await getFoodbanksByCountryForCharityCrawl(session, ["England"]);

    // scheduled/index.ts:227 builds `{ crawlSetId, foodbankId, slug }` from
    // this row and nothing else. A `SELECT *` here would put ~79 columns of
    // every food bank in the country through three queue enqueues for no
    // reason; pinning the shape keeps that from creeping back in.
    expect(Object.keys(row as object).sort()).toEqual(["id", "slug"]);
  });

  it("returns no rows when nothing matches, rather than throwing", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", country: "England" });

    expect(await getFoodbanksByCountryForCharityCrawl(session, ["Scotland"])).toEqual([]);
  });

  // PINNED, NOT ENDORSED. An empty list produces `country IN ()`, which SQLite
  // accepts (it is explicitly permitted where most engines reject it) and
  // which is always false, so the call returns [] rather than raising. No
  // caller does this today -- scheduled/index.ts passes three hard-coded lists
  // -- but a future caller computing the list from config would get a silent
  // empty crawl rather than an error. Verified against node:sqlite, not
  // reasoned about; D1 is SQLite, but this is the one assertion in this file
  // that rests on the two parsers agreeing.
  it("issues a statement with an empty IN list, and gets nothing back", async () => {
    seedCrawlPopulation();

    expect(await getFoodbanksByCountryForCharityCrawl(session, [])).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("country IN ()");
    expect(calls[0]!.params).toEqual([]);
  });

  // THE D1 BOUND-PARAMETER CAP. This is the only variable-length statement in
  // the module -- one placeholder per country, no chunking anywhere -- and D1
  // caps a statement at 100 bound parameters (PLAN.md:9653; needAdmin.ts:307
  // chunks at 90 for exactly this reason). At 100 the statement is legal.
  it("binds one parameter per country, and 100 countries is exactly the D1 limit", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", country: "England" });
    const countries = [...Array.from({ length: 99 }, (_, i) => `Country ${i}`), "England"];

    expect(slugs(await getFoodbanksByCountryForCharityCrawl(session, countries))).toEqual(["salisbury"]);
    expect(calls[0]!.params).toHaveLength(100);
    expect(calls[0]!.sql).toContain("?100");
  });

  // AND OVER IT. node:sqlite has no such cap (its limit is 32,766), so this
  // runs here and would be rejected by D1 with a bound-parameter error. The
  // test pins the parameter count rather than an outcome, because the outcome
  // differs between the two engines and asserting the local one would be
  // asserting a lie about production. Not reachable today -- the longest list
  // any caller passes is two -- but it is what makes "this function does not
  // chunk" a fact on the record rather than an omission.
  it("goes over the 100-parameter cap without chunking, which D1 would reject", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", country: "England" });
    const countries = [...Array.from({ length: 100 }, (_, i) => `Country ${i}`), "England"];

    await getFoodbanksByCountryForCharityCrawl(session, countries);

    expect(calls[0]!.params).toHaveLength(101);
    expect(calls[0]!.sql).toContain("?101");
  });
});

// ===========================================================================
// getFoodbankForCharityCrawl
// ===========================================================================
//
// The dequeue-time re-fetch (queues/charity.ts:43). The cron's enqueue-time
// snapshot can be hours stale by the time a message drains, so the row is read
// again -- crawlers.py:579-590's pattern, and the same one needcheck and
// getarticles use.

describe("getFoodbankForCharityCrawl", () => {
  it("returns exactly the six columns the crawler needs, for the requested id", async () => {
    seedFoodbank({ id: 7, slug: "salisbury", name: "Salisbury Food Bank", country: "England", charityNumber: "1130612", charityId: "3054916" });
    seedFoodbank({ id: 8, slug: "devizes", name: "Devizes Food Bank", country: "England", charityNumber: "1160000" });

    const row = await getFoodbankForCharityCrawl(session, 7);

    // The column list is pinned, not just the values. crawlOpenCharities.ts
    // reads country / charity_number / slug / id off this row; a `SELECT *`
    // would hide a rename behind a still-passing test, which is precisely how
    // 0019 went unnoticed for as long as it did.
    expect({ ...(row as object) }).toEqual({
      id: 7,
      slug: "salisbury",
      name: "Salisbury Food Bank",
      country: "England",
      charity_number: "1130612",
      charity_id: "3054916",
    });
  });

  it("binds the id, not the slug or the row's position", async () => {
    seedFoodbank({ id: 7, slug: "salisbury" });
    seedFoodbank({ id: 8, slug: "devizes" });

    // Two rows, and the SECOND one asked for: a statement that bound nothing
    // (or bound into the wrong slot) would hand back Salisbury and crawl the
    // wrong charity's number into Devizes' record.
    expect((await getFoodbankForCharityCrawl(session, 8))?.slug).toBe("devizes");
  });

  // queues/charity.ts:44-46 turns null into a thrown Error, which retries the
  // message. That only works if a missing row is null rather than undefined or
  // a zero-length result object -- D1's first() returns null, and the module
  // passes it straight through.
  it("returns null for an id that no longer exists", async () => {
    seedFoodbank({ id: 7, slug: "salisbury" });

    expect(await getFoodbankForCharityCrawl(session, 999)).toBeNull();
  });

  // PINNED, AND WORTH KNOWING. Neither predicate from the enqueue query is
  // repeated here: a food bank CLOSED during the drain window, or one whose
  // charity number was cleared in the admin between enqueue and dequeue, is
  // still handed to the crawler. Django behaved the same way -- the filter
  // lived on the queryset (charityinfo.py:19) and `foodbank_charity_crawl`
  // re-checked only the charity number, not is_closed -- so this matches the
  // original for closure and diverges for the number: crawlOpenCharities.ts
  // has no equivalent of crawlers.py:89's `if not foodbank.charity_number:
  // return False`, and would fetch `/ew/.json`.
  it("applies no filters of its own -- a closed food bank still comes back", async () => {
    seedFoodbank({ id: 7, slug: "closed-town", isClosed: 1 });

    expect((await getFoodbankForCharityCrawl(session, 7))?.slug).toBe("closed-town");
  });

  it("applies no charity_number filter either -- an empty number still comes back", async () => {
    seedFoodbank({ id: 7, slug: "blank-number", charityNumber: "" });

    expect((await getFoodbankForCharityCrawl(session, 7))?.charity_number).toBe("");
  });

  // charity_id is the one column here that is read for its EXISTING value
  // rather than to identify the row (charity.ts:39). It is nullable and, since
  // givefood/givefood2#1 moved every register to opencharities, no longer
  // written by anything -- so most rows have whatever the old OSCR/Charity
  // Commission crawlers last put there, and plenty have nothing. The type says
  // `string | null`; this is that claim, executed.
  it("hands back a NULL charity_id as null", async () => {
    seedFoodbank({ id: 7, slug: "salisbury", charityId: null });

    expect(await getFoodbankForCharityCrawl(session, 7)).toMatchObject({ charity_id: null });
  });
});

// ===========================================================================
// patchFoodbankCharity
// ===========================================================================
//
// The only dynamically-assembled statement in this module: a SET clause built
// from the caller's object keys, filtered through CHARITY_COLUMNS. Two
// separate things can go wrong -- the wrong columns can be written, or the
// right columns can be written with each other's values -- and neither one
// raises.

const ALL_CHARITY_FIELDS = {
  charity_id: "3054916",
  charity_name: "Trussell Trust Salisbury",
  charity_type: "CIO",
  charity_reg_date: "2005-03-14",
  charity_postcode: "SP2 9DY",
  charity_website: "https://www.salisburyfoodbank.org.uk/",
  charity_objectives: "The relief of poverty",
  charity_purpose: "Prevention or relief of poverty\n",
} as const;

describe("patchFoodbankCharity", () => {
  beforeEach(() => {
    // Salisbury arrives with every charity column already populated -- that is
    // the state the "never nulled" claim is about. Devizes is the control: no
    // statement in this module should ever touch a second row.
    seedFoodbank({
      id: 7,
      slug: "salisbury",
      name: "Salisbury Food Bank",
      charityId: "OLD-ID",
      charityName: "Old Name",
      charityType: "Old Type",
      charityRegDate: "1999-01-01",
      charityPostcode: "OLD 1AA",
      charityWebsite: "https://old.example.org/",
      charityObjectives: "Old objectives",
      charityPurpose: "Old purpose",
      lastCharityCheck: DJANGO_EARLIER,
    });
    seedFoodbank({ id: 8, slug: "devizes", name: "Devizes Food Bank", charityName: "Devizes Charity", lastCharityCheck: DJANGO_EARLIER });
  });

  // crawlers.py's structure, which the module header spells out: each
  // `foodbank.charity_X = ...` happens only inside its own
  // `if response.status_code == 200:` block, and `save()` runs once at the
  // end, so a sub-request that failed leaves its columns exactly as they were.
  // Reproducing that here means a key ABSENT from `patch` must not appear in
  // the SET clause at all.
  it("writes only the columns present in the patch, leaving the rest of the row alone", async () => {
    await patchFoodbankCharity(session, 7, { charity_name: "New Name", charity_postcode: "SP2 7QD" }, DJANGO_NOW);

    const row = foodbankRow(7);
    expect(row.charity_name).toBe("New Name");
    expect(row.charity_postcode).toBe("SP2 7QD");
    expect(row.charity_website).toBe("https://old.example.org/");
    expect(row.charity_objectives).toBe("Old objectives");
    expect(row.charity_id).toBe("OLD-ID");
  });

  // The header calls last_charity_check "unconditional", matching
  // crawlers.py:163 -- it is stamped regardless of which individual sub-fetches
  // succeeded, because it means "we looked", not "we found something". An
  // empty patch is therefore still a statement, not a no-op: without it a food
  // bank whose register entry has been deleted would look permanently
  // un-checked in the admin.
  it("stamps last_charity_check even when the patch is empty", async () => {
    await patchFoodbankCharity(session, 7, {}, DJANGO_NOW);

    expect(foodbankRow(7).last_charity_check).toBe(DJANGO_NOW);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toBe("UPDATE foodbank SET last_charity_check = ?1 WHERE id = ?2");
  });

  // The timestamp is stored EXACTLY as handed over -- no re-derivation, no
  // normalisation. That is what makes the caller's choice of pyNow() load-
  // bearing rather than cosmetic: this column is TEXT, SQLite compares TEXT
  // lexicographically, and 'T' (0x54) sorts after ' ' (0x20), so a
  // toISOString() value written here would sort after every Django-format
  // value in the table regardless of the actual time. getAdminDashboardStats
  // shipped that exact bug against foodbankchange and silently dropped 31 of
  // 46 rows.
  it("stores the caller's timestamp verbatim, in Django's format", async () => {
    await patchFoodbankCharity(session, 7, { charity_name: "New Name" }, DJANGO_NOW);

    const stored = foodbankRow(7).last_charity_check as string;
    expect(stored).toBe(DJANGO_NOW);
    expect(stored).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
    expect(stored > DJANGO_EARLIER).toBe(true);
  });

  // THE PLACEHOLDER-ALIGNMENT TEST, and the reason this file exists at all.
  // `values` is built by mapping over the FILTERED column list, not over
  // CHARITY_COLUMNS and not over Object.keys -- a mutant that mapped over the
  // canonical order instead would still bind eight strings into eight TEXT
  // columns, still succeed, and put the postcode in the website. Handing the
  // keys over in an order deliberately unlike the declared one is what makes
  // that mutant fail.
  it("keeps each value with its own column when the keys arrive out of declared order", async () => {
    await patchFoodbankCharity(
      session,
      7,
      {
        charity_website: ALL_CHARITY_FIELDS.charity_website,
        charity_purpose: ALL_CHARITY_FIELDS.charity_purpose,
        charity_name: ALL_CHARITY_FIELDS.charity_name,
        charity_postcode: ALL_CHARITY_FIELDS.charity_postcode,
      },
      DJANGO_NOW,
    );

    const row = foodbankRow(7);
    expect(row.charity_website).toBe(ALL_CHARITY_FIELDS.charity_website);
    expect(row.charity_purpose).toBe(ALL_CHARITY_FIELDS.charity_purpose);
    expect(row.charity_name).toBe(ALL_CHARITY_FIELDS.charity_name);
    expect(row.charity_postcode).toBe(ALL_CHARITY_FIELDS.charity_postcode);
  });

  it("writes all eight charity columns in one statement, ten bound parameters", async () => {
    await patchFoodbankCharity(session, 7, { ...ALL_CHARITY_FIELDS }, DJANGO_NOW);

    const row = foodbankRow(7);
    for (const [column, value] of Object.entries(ALL_CHARITY_FIELDS)) expect(row[column]).toBe(value);
    // Eight columns, the timestamp and the id. Recorded because D1 caps a
    // statement at 100 bound parameters and this is the module's widest
    // UPDATE: 90 spare, so a future column is free, but the number is on the
    // record rather than assumed.
    expect(calls[0]!.params).toHaveLength(10);
  });

  // THE WHITELIST. `columns` is filtered against CHARITY_COLUMNS before any of
  // it reaches the SQL string, and `name` is the sharpest test of that: it is a
  // real column on this table, it is UNIQUE, and it is the food bank's public
  // identity. If the filter were dropped, a patch key of `name` would rename a
  // food bank from a charity-register response -- or collide with another
  // food bank's name and raise SQLITE_CONSTRAINT_UNIQUE mid-crawl.
  it("ignores a key that is a real column but not a charity column", async () => {
    await patchFoodbankCharity(session, 7, { name: "Renamed By The Crawler" } as never, DJANGO_NOW);

    expect(foodbankRow(7).name).toBe("Salisbury Food Bank");
    expect(calls[0]!.sql).toBe("UPDATE foodbank SET last_charity_check = ?1 WHERE id = ?2");
  });

  // THE WHITELIST IS A LIST, NOT A PREFIX, and this is the test that says so.
  // The two tests either side of it are weaker than they look: `name` is caught
  // by any guard whatsoever, and the injection key below happens to begin
  // "charity_name = ", so a `c.startsWith("charity_")` check would pass both.
  // Neither notices the two REAL charity_-prefixed columns on this table that
  // are deliberately NOT in CHARITY_COLUMNS:
  //
  //   charity_number        -- the crawl's own INPUT. crawlOpenCharities.ts:177
  //                            builds the register URL out of it, so a response
  //                            that overwrote it would silently point every
  //                            future crawl of this food bank at a different
  //                            charity, and nothing downstream reconciles it
  //                            back. It is also the column the enqueue query at
  //                            the top of this file filters on, so a value
  //                            written to '' would drop the food bank out of
  //                            the crawl for good.
  //   charity_just_foodbank -- an admin-set flag (INTEGER NOT NULL,
  //                            0001_core.sql:20) that gfdash/views.py:441's
  //                            income/expenditure dashboard filters on. Not a
  //                            register field at all; nothing external may set
  //                            it.
  //
  // TWO MUTANTS SURVIVED EVERY OTHER TEST IN THIS FILE until this one existed:
  // swapping `CHARITY_COLUMNS.includes(c)` for a prefix test, and simply adding
  // "charity_number" to CHARITY_COLUMNS -- which is the edit somebody makes
  // precisely because opencharities does return a charity number.
  //
  // The allowed and forbidden lists are read off the APPLIED SCHEMA rather than
  // retyped here, so a migration that adds a charity_-prefixed column fails this
  // test until someone decides deliberately whether the crawler may write it.
  it("accepts exactly the eight whitelisted charity_ columns, not every charity_ column on the table", async () => {
    const prefixed = (db.prepare("SELECT name FROM pragma_table_info('foodbank')").all() as { name: string }[])
      .map((column) => column.name)
      .filter((name) => name.startsWith("charity_"))
      .sort();
    expect(prefixed).toEqual([
      "charity_id",
      "charity_just_foodbank",
      "charity_name",
      "charity_number",
      "charity_objectives",
      "charity_postcode",
      "charity_purpose",
      "charity_reg_date",
      "charity_type",
      "charity_website",
    ]);

    // Every one of them offered at once, so the test distinguishes "filtered"
    // from "the statement failed" rather than assuming.
    await patchFoodbankCharity(session, 7, Object.fromEntries(prefixed.map((name) => [name, "OVERWRITTEN"])) as never, DJANGO_NOW);

    const row = foodbankRow(7);
    expect(row.charity_number).toBe("1130612");
    expect(row.charity_just_foodbank).toBe(1);
    expect(calls[0]!.sql).not.toContain("charity_number");
    expect(calls[0]!.sql).not.toContain("charity_just_foodbank");
    // And the eight that ARE whitelisted all went through: this is not passing
    // because the whole patch was thrown away.
    for (const column of Object.keys(ALL_CHARITY_FIELDS)) expect(row[column]).toBe("OVERWRITTEN");
  });

  // The same filter as injection defence. Nothing today builds a patch from
  // untrusted input -- crawlOpenCharities.ts:201-209 uses eight literal keys --
  // but the key is interpolated into the SQL string rather than bound, so the
  // whitelist is the only thing between a future caller's `Object.fromEntries`
  // over an API response and arbitrary SQL.
  it("drops a key shaped like a second assignment rather than interpolating it", async () => {
    await patchFoodbankCharity(session, 7, { "charity_name = 'x', slug": "hacked" } as never, DJANGO_NOW);

    const row = foodbankRow(7);
    expect(row.slug).toBe("salisbury");
    expect(row.charity_name).toBe("Old Name");
    expect(calls[0]!.sql).not.toContain("slug");
  });

  // SUSPECT, PINNED AS-IS. The module header says a field the register did not
  // return "is left exactly as it already was in D1, never nulled" -- true of
  // this function, whose SET clause only ever names keys the caller supplied.
  // But its only caller builds all seven keys unconditionally with `?? null`
  // (crawlOpenCharities.ts:201-209), so a field opencharities omits arrives
  // here as an explicit null and DOES null the column. That is a real
  // divergence from crawlers.py, where an absent field was never assigned at
  // all. It is recorded rather than fixed because the crawler's own header
  // documents a verification run over 80 food banks in which no populated
  // field came back empty, so the two are a deliberate pair -- but the
  // safety net is the caller's, not this function's. Reported in suspectedBugs.
  it("writes an explicit null as NULL, overwriting whatever was there", async () => {
    await patchFoodbankCharity(session, 7, { charity_website: null }, DJANGO_NOW);

    expect(foodbankRow(7).charity_website).toBeNull();
  });

  // SUSPECT, PINNED AS-IS. `Partial<Record<CharityColumn, string | null>>` lets
  // a key be present with an undefined value, and `Object.keys` cannot tell
  // that from a real one -- so `{ charity_name: undefined }` nulls the column
  // while `{}` leaves it alone, from two objects TypeScript treats as the same
  // type. The `?? null` is nonetheless load-bearing: D1 rejects an undefined
  // binding outright, so removing it would turn this into a runtime throw
  // rather than a no-op. Reported in suspectedBugs.
  it("treats a present-but-undefined key as a null, not as an absent key", async () => {
    await patchFoodbankCharity(session, 7, { charity_name: undefined }, DJANGO_NOW);

    expect(foodbankRow(7).charity_name).toBeNull();
  });

  it("updates only the requested food bank", async () => {
    await patchFoodbankCharity(session, 7, { charity_name: "New Name" }, DJANGO_NOW);

    // The control row. A WHERE clause lost from this statement would rewrite
    // the charity details of all 831 food banks with a charity number, one
    // queue message at a time, and nothing anywhere would raise.
    const devizes = foodbankRow(8);
    expect(devizes.charity_name).toBe("Devizes Charity");
    expect(devizes.last_charity_check).toBe(DJANGO_EARLIER);
  });

  it("changes nothing when the id matches no row", async () => {
    await patchFoodbankCharity(session, 999, { charity_name: "New Name" }, DJANGO_NOW);

    expect(foodbankRow(7).charity_name).toBe("Old Name");
    expect(foodbankRow(8).charity_name).toBe("Devizes Charity");
  });

  // A DIVERGENCE FROM DJANGO, pinned deliberately. `Foodbank` extends
  // TimestampedModel, whose `modified` is auto_now=True (models/base.py:16),
  // so crawlers.py:164's `foodbank.save()` bumped it on every charity crawl --
  // 831 rows a day whose only change was a register field. This port leaves
  // `modified` alone, consistently with needcheck.ts:199 and the rest of the
  // crawler write paths. It matters because `modified` is what an incremental
  // sync keys on (PLAN.md's B2/B3) and what foodbank_modified_idx exists for;
  // whether the port or Django is right, the behaviour should not change by
  // accident.
  it("does not bump `modified`, though Django's auto_now field did", async () => {
    await patchFoodbankCharity(session, 7, { charity_name: "New Name" }, DJANGO_NOW);

    expect(foodbankRow(7).modified).toBe(DJANGO_EARLIER);
  });
});

// ===========================================================================
// replaceCharityYears
// ===========================================================================
//
// PLAN.md §8.7.1. crawlers.py:147 and :206 run
// `CharityYear.objects.filter(foodbank=foodbank).delete()` BEFORE fetching the
// replacement financial history, so a failed fetch leaves the food bank with
// zero years until the next successful run -- and because CharityYear is a
// CreatedModel with no `modified` column, PLAN.md's risk B2 puts the same
// pattern at ~4,198 duplicate rows per day of a launch catch-up window. Both
// are fixed by fetching first (the caller only calls this with the years
// already in hand) and replacing atomically in one D1 batch.

describe("replaceCharityYears", () => {
  beforeEach(() => {
    seedFoodbank({ id: 7, slug: "salisbury" });
    seedFoodbank({ id: 8, slug: "devizes" });
  });

  it("replaces the food bank's years -- the old rows are gone, the new ones are in order", async () => {
    seedCharityYear({ foodbankId: 7, date: "2021-03-31", income: 1, expenditure: 2 });
    seedCharityYear({ foodbankId: 7, date: "2022-03-31", income: 3, expenditure: 4 });
    seedCharityYear({ foodbankId: 7, date: "2023-03-31", income: 5, expenditure: 6 });

    await replaceCharityYears(session, 7, [
      { date: "2024-03-31", income: 120_000, expenditure: 110_000 },
      { date: "2025-03-31", income: 130_000, expenditure: 125_000 },
    ]);

    // Exact rows, in the order supplied, with income and expenditure on their
    // own sides. Two INTEGER columns bound one slot apart is the easiest
    // transposition in the module to make and the hardest to see: every
    // charity would simply appear to break even less often than it does.
    expect(charityYears(7).map((row) => [row.date, row.income, row.expenditure])).toEqual([
      ["2024-03-31", 120_000, 110_000],
      ["2025-03-31", 130_000, 125_000],
    ]);
  });

  it("leaves another food bank's years untouched", async () => {
    seedCharityYear({ foodbankId: 8, date: "2023-03-31", income: 99, expenditure: 98 });

    await replaceCharityYears(session, 7, [{ date: "2024-03-31", income: 1, expenditure: 2 }]);

    // The DELETE is scoped by foodbank_id. Without it, one message from one of
    // the three charity queues would wipe the financial history of every food
    // bank in the country before inserting its own two rows, and
    // /dashboard/charity_income_expenditure/ would just render a smaller
    // number.
    expect(charityYears(8).map((row) => row.date)).toEqual(["2023-03-31"]);
  });

  // NULL IN A WHERE CLAUSE. charityyear.foodbank_id is nullable
  // (0005_orders_and_charity.sql:52) and D1 has no foreign keys (PLAN.md
  // §4.5), so orphan rows are possible -- and `foodbank_id = ?1` is never true
  // for one, because SQLite's `=` against NULL evaluates to NULL rather than
  // false. Pinned so that a future rewrite to a null-safe `IS` (the fix
  // slugRedirects.ts:62-69 and locationsAdmin.ts needed for the OPPOSITE
  // reason) does not quietly start deleting rows that belong to nobody along
  // with the ones that do.
  it("cannot touch an orphan year whose foodbank_id is NULL", async () => {
    seedCharityYear({ foodbankId: null, date: "2020-03-31" });

    await replaceCharityYears(session, 7, [{ date: "2024-03-31", income: 1, expenditure: 2 }]);

    expect(charityYears(null).map((row) => row.date)).toEqual(["2020-03-31"]);
  });

  // THE §8.7.1 CLAIM, executed. One batch -- so one transaction -- with the
  // DELETE first and one INSERT per year after it, and nothing issued outside
  // it. A rewrite to `await delete(); for (...) await insert();` would pass
  // every row-level assertion above and lose the only property this design
  // exists for.
  it("sends the delete and every insert as one batch, delete first", async () => {
    await replaceCharityYears(session, 7, [
      { date: "2024-03-31", income: 1, expenditure: 2 },
      { date: "2025-03-31", income: 3, expenditure: 4 },
    ]);

    expect(batches).toHaveLength(1);
    expect(calls).toEqual([]);
    const [batch] = batches;
    expect(batch).toHaveLength(3);
    expect(batch![0]!.sql).toBe("DELETE FROM charityyear WHERE foodbank_id = ?1");
    expect(batch![0]!.params).toEqual([7]);
    expect(batch!.slice(1).map((statement) => statement.sql)).toEqual([
      "INSERT INTO charityyear (foodbank_id, date, income, expenditure, created) VALUES (?1, ?2, ?3, ?4, ?5)",
      "INSERT INTO charityyear (foodbank_id, date, income, expenditure, created) VALUES (?1, ?2, ?3, ?4, ?5)",
    ]);
  });

  // ATOMICITY, which is what the batch buys. A statement failing part-way
  // through must leave the food bank with the years it already had, not with
  // none -- that is precisely the state crawlers.py's delete-then-fetch could
  // leave behind for a day.
  //
  // The failure is forced by binding a value SQLite cannot accept, because
  // charityyear declares no constraint to violate (no NOT NULL, no UNIQUE) and
  // this file may not add one. D1 rejects an unsupported binding too, so the
  // observable outcome -- old rows intact, no new rows -- is the same there,
  // though D1 would refuse before running the DELETE rather than rolling it
  // back. What this proves is the property that matters: no code path in this
  // function can leave the table half-replaced.
  it("leaves the existing years in place when a statement in the batch fails", async () => {
    seedCharityYear({ foodbankId: 7, date: "2023-03-31", income: 5, expenditure: 6 });

    await expect(
      replaceCharityYears(session, 7, [
        { date: "2024-03-31", income: 1, expenditure: 2 },
        { date: "2025-03-31", income: { not: "a number" } as unknown as number, expenditure: 4 },
      ]),
    ).rejects.toThrow();

    expect(charityYears(7).map((row) => [row.date, row.income])).toEqual([["2023-03-31", 5]]);
  });

  // PLAN.md's risk B2, from the other side: the launch catch-up could not see
  // deletes, so a re-run had to be safe. Running the same years twice must
  // produce the same table, not two copies of every year -- the failure mode
  // B2 describes as "every /needs/at/<slug>/charity/ page rendering each
  // financial year three or four times". A queue message that retries after a
  // successful write is the live version of the same thing.
  it("is idempotent -- running the same years twice leaves one copy of each", async () => {
    const years = [
      { date: "2024-03-31", income: 120_000, expenditure: 110_000 },
      { date: "2025-03-31", income: 130_000, expenditure: 125_000 },
    ];

    await replaceCharityYears(session, 7, years);
    await replaceCharityYears(session, 7, years);

    expect(charityYears(7).map((row) => row.date)).toEqual(["2024-03-31", "2025-03-31"]);
  });

  // SUSPECT, PINNED AS-IS. An empty list still sends the DELETE, so calling
  // this with no years wipes the food bank's financial history -- the exact
  // outcome §8.7.1 says the design prevents. What actually prevents it is the
  // CALLER: crawlOpenCharities.ts:219 guards with `if (years.length)`. That
  // guard is one line in one file, and nothing in this function's signature or
  // types says it is required. Recorded, not fixed, because an early return
  // here would also make "this food bank genuinely has no years any more"
  // unexpressible. Reported in suspectedBugs.
  it("deletes everything and inserts nothing when handed an empty list", async () => {
    seedCharityYear({ foodbankId: 7, date: "2023-03-31" });

    await replaceCharityYears(session, 7, []);

    expect(charityYears(7)).toEqual([]);
    expect(batches[0]).toHaveLength(1);
  });

  // THE FORMAT IS WHAT THIS TEST IS FOR. Django's `str(datetime)` -- a space
  // separator and six fractional digits, never a 'T' and never a 'Z'.
  // CharityYear is a CreatedModel whose existing 4,180 rows arrived from
  // Postgres in that shape (0022_normalise_timestamps.sql:74-75 rewrote the
  // stragglers), and `created` is TEXT, so a toISOString() value written
  // beside them would sort after every one of them regardless of the real time
  // -- see @givefood/models/pyDatetime, and the two live bugs its header
  // records. Swapping pyNow() for toISOString() fails this test.
  //
  // The shared-stamp half is asserted but not PROVEN by this test, and the one
  // below is the reason it does not have to be: moving `pyNow()` inside the map
  // produces byte-identical strings anyway -- the whole batch is built in one
  // synchronous pass, so no clock can advance between rows -- which makes the
  // values indistinguishable and the call count the only observable difference.
  it("stamps every row with one shared Django-format created timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T19:28:08.853Z"));

    await replaceCharityYears(session, 7, [
      { date: "2024-03-31", income: 1, expenditure: 2 },
      { date: "2025-03-31", income: 3, expenditure: 4 },
    ]);

    const created = charityYears(7).map((row) => row.created);
    expect(created).toEqual([DJANGO_NOW, DJANGO_NOW]);
    expect(created[0] as string).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
    // Lexicographic order is chronological order against the ETL's own values,
    // which is the whole point of the format.
    expect((created[0] as string) > DJANGO_EARLIER).toBe(true);
  });

  // THE MUTANT THE TEST ABOVE CANNOT KILL. `const now = pyNow()` sits outside
  // the map deliberately: one clock read, one `created` value for the whole
  // replacement. Move it inside and every assertion in this file still passes,
  // because two Date.now() calls in the same synchronous pass return the same
  // millisecond -- so the count of clock reads is the only thing left to assert,
  // and this asserts it. It matters beyond tidiness: `created` is what pairs a
  // food bank's years together as one crawl, and PLAN.md's risk B2 turns on
  // being able to tell one replacement's rows from another's. It also pins the
  // dependency itself -- swapping pyNow() for `new Date().toISOString()` (a live
  // bug class here; see the format note above) drops this to zero calls.
  it("reads the clock once for the whole batch, not once per year", async () => {
    const clock = vi.mocked(pyNow);
    clock.mockClear();

    await replaceCharityYears(session, 7, [
      { date: "2023-03-31", income: 1, expenditure: 2 },
      { date: "2024-03-31", income: 3, expenditure: 4 },
      { date: "2025-03-31", income: 5, expenditure: 6 },
    ]);

    expect(clock).toHaveBeenCalledTimes(1);
  });

  // The caller coalesces a missing income to 0 (crawlOpenCharities.ts:218), so
  // 0 must survive as 0. A `|| null` anywhere on this path would turn a
  // charity that genuinely reported nothing into a charity with no data, and
  // getCharityYearAggregates' SUM would silently exclude it.
  it("stores a zero income and expenditure as 0, not NULL", async () => {
    await replaceCharityYears(session, 7, [{ date: "2024-03-31", income: 0, expenditure: 0 }]);

    expect(charityYears(7).map((row) => [row.income, row.expenditure])).toEqual([[0, 0]]);
  });

  // `date` is written exactly as handed over -- no parsing, no normalisation.
  // Django's CharityYear.date is a DateField, so crawlers.py had to strip the
  // "T00:00:00" the Charity Commission API appends (crawlers.py:132, :157)
  // before the ORM would accept it; nothing here would object. It matters
  // because the only reader is dashboards.ts:332's
  // `strftime('%Y', cy.date)`, which returns NULL for anything outside
  // SQLite's own time formats and would drop the row from the aggregate
  // without a word. ISO-with-time is one of those formats, so today's values
  // are safe; a register that started sending "31/03/2024" would not be.
  it("stores the date string verbatim, including a time suffix Django stripped", async () => {
    await replaceCharityYears(session, 7, [{ date: "2024-03-31T00:00:00", income: 1, expenditure: 2 }]);

    expect(charityYears(7)[0]!.date).toBe("2024-03-31T00:00:00");
  });

  // SQLite's INTEGER affinity converts a REAL to an INTEGER only when the
  // conversion is lossless, so a non-integral figure from the register is
  // stored as a REAL in an INTEGER column rather than rejected or rounded.
  // Django's IntegerField would have raised. Pinned because it is invisible
  // until the API renders `income: 120000.5` for one food bank among 831.
  it("keeps a non-integral income as a float, which Django's IntegerField would have refused", async () => {
    await replaceCharityYears(session, 7, [{ date: "2024-03-31", income: 120_000.5, expenditure: 2 }]);

    expect(charityYears(7)[0]!.income).toBe(120_000.5);
  });

  // Financial histories run to a couple of dozen years. The batch grows a
  // statement per year, but each statement keeps exactly five bound parameters
  // however long the history is -- so D1's 100-parameter-per-statement cap
  // (PLAN.md:9653) has nothing to bite on here, unlike the IN list at the top
  // of this file. Order still has to survive the round trip.
  it("keeps order and a five-parameter statement shape across a long history", async () => {
    const years = Array.from({ length: 40 }, (_, i) => ({ date: `${1986 + i}-03-31`, income: i, expenditure: i * 2 }));

    await replaceCharityYears(session, 7, years);

    expect(charityYears(7).map((row) => row.date)).toEqual(years.map((year) => year.date));
    expect(batches[0]).toHaveLength(41);
    expect(new Set(batches[0]!.slice(1).map((statement) => statement.params.length))).toEqual(new Set([5]));
  });
});
