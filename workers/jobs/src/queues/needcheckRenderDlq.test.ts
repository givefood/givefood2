import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import type { Env } from "../../worker-configuration";
import { handleNeedcheckRenderDlq } from "./needcheckRenderDlq";
import type { NeedcheckRenderMessage } from "./needcheckRender";
import jobsWorker from "../index";
// @ts-ignore -- this Worker's tsconfig lists only @cloudflare/workers-types, so
// node:sqlite has no declarations here. It is real under vitest's node
// environment, and adding "node" to workers/jobs/tsconfig.json would be a
// config change rather than a test change. Same suppression, same reasoning,
// as packages/db/src/schema.testkit.ts:35 and the sibling articlesDlq.test.ts:11.
import { DatabaseSync } from "node:sqlite";

// queues/needcheckRenderDlq.ts -- the needcheck-render-dlq consumer, and the
// last thing that happens to a food bank whose need check could not be made to
// work at all.
//
// WHERE A MESSAGE HAS BEEN BEFORE IT GETS HERE. needcheck's cron (0 15 * * *)
// enqueues one message per open food bank onto needcheck-render, which is
// `max_retries: 3` with `dead_letter_queue: "needcheck-render-dlq"`
// (wrangler.jsonc). needcheckRender.ts's consumer retries with a 60s delay on
// any ordinary failure, and ACKS outright on a PermanentOpenRouterFailure --
// so the messages that reach THIS handler are specifically the ones that
// failed three times in three different deliveries, minutes apart: a food
// bank's site that will not render, a scrape that times out every time, a D1
// error that keeps recurring. This queue is itself `max_retries: 1` with NO
// dead_letter_queue behind it, so it is genuinely the end of the line.
//
// WHY THIS FILE IS WORTH THE LENGTH. This handler is the only code in the
// needcheck pipeline that runs after everything else has given up, and nothing
// watches it -- there is no fetch handler on this Worker, no alert, and (as
// asserted below) not even a log line on its success path. It makes exactly
// two durable writes, and each one is the sole defence against a different
// silent failure:
//
//   * the FoodbankDiscrepancy is the ONLY way a human ever finds out this food
//     bank was dropped. wrangler.jsonc's own comment calls the DLQ
//     "NON-NEGOTIABLE" for that reason: without it, "messages that repeatedly
//     fail processing will eventually be discarded -- silently".
//   * the crawlset decrement is what lets `remaining` reach 0 so `finish` gets
//     stamped. Every other exit from needcheckRender.ts's processOne()
//     decrements via finish(); a dead-lettered message is the one path that
//     does not, and the module's own comment at lines 33-37 says so.
//
// So every test below reads the DATABASE back. Asserting that the handler
// resolved, or that it acked, would pass against a body reduced to
// `for (const m of batch.messages) m.ack()` -- which is what "the message is
// dead, just drain the queue" looks like as a diff, and which loses both
// writes at once.
//
// THE SPLIT try/catch IS THE POINT OF THE MODULE'S OWN HISTORY. Its header
// records that the two writes "used to share one try block: a failure in the
// discrepancy write skipped the decrement too", and that both were then lost
// for good behind a console.error. The "the two writes are independent"
// describe block below is that regression, pinned from both directions.
//
// PARITY WITH DJANGO -- READ, NOT ASSUMED. Django has no dead-letter concept
// at all: `grep -rn "dead.letter\|dead_letter" --include="*.py"` over
// /Users/jasoncartwright/Sites/foodcharity returns nothing, and
// do_foodbank_need_check (givefood/utils/crawlers.py:281-575) is a synchronous
// function whose exceptions simply propagate out of the management command.
// So this consumer has no Django counterpart to be compared against as a
// whole. The SHAPE of the row it writes does, and that was checked:
//
//   * discrepancy_type "website" is one of the seven names in
//     givefood/const/general.py:44-52 (DISCREPANCY_TYPES), and is the value
//     BOTH of the need crawler's own FoodbankDiscrepancy writes use
//     (crawlers.py:312 render failure, :490 empty-extraction guard -- the only
//     two in that file).
//   * status "New" is FoodbankDiscrepancy.status's model default
//     (givefood/models/needs.py:37).
//   * `need` is left unset by both Django call sites, which is why the SQL
//     writes need_id NULL.
//   * Django's model ALSO denormalises foodbank_name on save()
//     (needs.py:42-47). The port does not, because migration 0019 dropped that
//     column and replaced it with the foodbankdiscrepancy_full view. The
//     column list is asserted below so a well-meaning "restore parity" edit
//     fails here rather than at INSERT time in production.
//
// REAL THINGS, NOT MOCKS. The database is node:sqlite carrying the REAL DDL
// for `crawlset` and `foodbankdiscrepancy` via schemaFor (schema.testkit.ts,
// which runs the actual migrations and asks the engine), and both writes are
// the real insertFoodbankDiscrepancy / decrementCrawlSetRemaining from
// @givefood/db reached through the real import. A session handing back canned
// rows would agree with any SQL at all -- including SQL that had lost
// decrementCrawlSetRemaining's `remaining > 0` floor, or stopped stamping
// `finish`, or written the discrepancy against the wrong food bank -- and
// those are exactly the failures that leave a plausible-looking database
// behind. The dispatch block at the bottom runs the REAL default export from
// workers/jobs/src/index.ts, because the queue NAME is the wiring.
//
// schemaFor("crawlset", "foodbankdiscrepancy"), not MIGRATIONS_SQL: those two
// tables are this consumer's entire D1 surface, and naming them makes that a
// checked claim rather than a comment. A write to any third object -- the
// `foodbank` row's last_need_check, a crawlitem -- would throw "no such table"
// INTO THIS HANDLER'S OWN CATCH and leave no trace in the rows, which is why
// the prepared-SQL log below exists as well as the row assertions.
//
// MOCKED, and only this: nothing that leaves the machine, because this handler
// makes no network call, sends no queue message and touches no KV or R2. The
// only doubles are the Queues message objects (ack/retry are recorded, since
// whether a message is acked is half of what is under test) and, in the
// failure tests, a session rigged to throw on one named statement -- a D1
// outage is the one input this handler explicitly catches and cannot otherwise
// be given.
//
// MUTATION-TESTED (TESTING.md's convention: the evidence a test is
// load-bearing rather than decoration). The repo was rsync'd to a scratchpad
// OUTSIDE it -- no file in the repo was edited at any point -- and 40 mutants
// were injected across needcheckRenderDlq.ts, index.ts and the two
// packages/db functions it calls, then this file re-run against each. All 40
// were killed; none survived. To be exact about what that is worth: the
// mutants were chosen while writing these tests, so this is confirmation that
// the tests do what they were written to do, not a discovery that they caught
// something unexpected. The list, in full: the discrepancy write deleted; its
// url taken from `shoppingListUrl` instead of `url`; its foodbankId taken from
// crawlSetId; its discrepancy_type changed to "need"; its text stripped of the
// url and pointed at the shopping-list url; the decrement deleted, run once
// per batch instead of once per message, given foodbankId as its crawl set,
// and given a literal 1; THE TWO try/catch BLOCKS MERGED BACK INTO ONE (the
// module's own documented regression); the discrepancy catch given a bare
// `throw`; both catch bodies silenced; the error argument dropped from each
// log call; the decrement log's id and slug transposed; its queue label taken
// from batch.queue; the ack deleted, turned into retry(), replaced by
// batch.ackAll(), and MOVED AHEAD OF BOTH WRITES; the two writes swapped; the
// session opened per-message and in "first-primary"; index.ts's
// needcheck-render-dlq case pointed at handleArticlesDlq and at the
// producer-queue consumer, its case string typo'd, and its `default:` made to
// drop a batch silently; and in packages/db, the `remaining > 0` floor
// dropped, the subtraction inverted, `expected` dragged down with `remaining`,
// `finish` stamped never / every time / one item early / with toISOString() /
// without its `WHERE id`, insertFoodbankDiscrepancy's `created`/`modified`
// written from toISOString(), its status written 'Done', and its need_id bound
// to the food bank.
//
// MUTATION-TESTED AGAIN, ADVERSARIALLY, BY A SECOND PAIR OF HANDS, because
// the paragraph above is a self-report: the mutants were chosen by the person
// writing the tests, so of course they died. That review re-ran the 40 above
// and added 38 more that had NOT been picked while writing this file --
// including every one the reviewer could think of that leaves the two rows
// and the per-message ack counts untouched, which is the only place a hole
// could still be hiding. 78 mutants, injected in a copy of the repo outside
// the working tree (no file in the repo was edited at any point), across
// needcheckRenderDlq.ts, index.ts and packages/db/src/needcheck.ts.
//
// FOUR SURVIVED, all of them the same hole, and the tests below are the fix:
// `batch.retryAll()` and `batch.ackAll()`, each added inside either of the two
// catch blocks. `batchWide` was asserted only in the all-succeeded disposal
// test, and the failure path -- the ONLY place either call would ever be
// written -- checked neither. See "never retries and never reaches for the
// batch-wide hatches, even when both writes fail".
//
// The same pass also replaced three assertions that could not fail for the
// right reason: an `errorLines().every(...)` prefix check (vacuously true on
// the empty array a silenced catch produces) and two bare `toHaveLength(1)`s
// on branches where the discrepancy is the handler's only output. And it
// added the one fixture nothing else in the file had -- a discrepancy row
// that was ALREADY in the admin queue before the batch arrived, which every
// other test's empty table gave an update-in-place edit nothing to damage.
//
// The other 74 mutants died, including all 40 above re-run. Notable ones that
// were NOT in the original list and died anyway: the batch iterated in
// reverse; the last message of the batch skipped; the first message skipped;
// `await` dropped from either write (turning a caught failure into an
// unhandled rejection); the ack moved inside the decrement's try; the two
// writes' object fields transposed; a whole-loop outer try/catch that
// swallows; `console.error` downgraded to `console.warn`; the handler growing
// an `UPDATE foodbank SET last_need_check`; `insertFoodbankDiscrepancy`'s url
// column bound from the text; `decrementCrawlSetRemaining` returning
// `expected` instead of `remaining`, or throwing instead of returning null for
// a crawl set that is gone; and index.ts folding this queue in with the
// generic jobs-dlq handler.
//
// TWO OF THOSE ARE WHY PARTICULAR TESTS BELOW LOOK OVER-SPECIFIED, and the
// kills were traced to the individual assertions rather than assumed:
//   * `message.ack()` hoisted above the two writes leaves exactly the same
//     rows and the same ack count, so no row assertion sees it. It is caught
//     by the two `events` ordering tests and, incidentally, by the two
//     malformed-body tests that assert acks of 0.
//   * the `finish` stamp's `WHERE id = ?2` removed, so tipping ONE crawl set
//     to zero stamps every unfinished crawl in the table -- marking today's
//     articles run complete because a needcheck food bank failed. The
//     still-running second crawl set seeded in the zero-transition test is
//     what catches that as BEHAVIOUR; without it the only thing left is the
//     prepared-SQL assertion, which notices any change to the statement's text
//     and so cannot distinguish this bug from a harmless reformat.
//
// NOT VERIFIED: nothing here has been run against a real Cloudflare queue. The
// at-least-once redelivery this file pins as non-idempotent is read off the
// documented guarantee and wrangler.jsonc's consumer settings, not measured.

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

let db: SqliteDatabase;

/** Every consistency mode handed to env.DB.withSession(), in order. */
let sessionModes: string[];
/** Every SQL string prepared through the session, in order, across the batch. */
let preparedSql: string[];

/**
 * Every observable event -- a log line, a statement, an ack -- in the order it
 * happened, tagged by kind.
 *
 * WHY ONE INTERLEAVED LOG rather than separate counters. The three things this
 * handler does per message have an ORDER that no count can see. Acking BEFORE
 * the two writes still acks exactly once and still leaves exactly the same two
 * rows, so every other assertion in this file passes -- but it tells the queue
 * the message is consumed before the writes that consuming it was for, and an
 * invocation evicted in that window loses both, with no message left to
 * redeliver and no DLQ behind this one to catch it. No row assertion in this
 * file can see that mutant -- the rows are identical either way -- so this log
 * and the two tests that read it are the ones that kill it.
 *
 * It also pins that the discrepancy comes before the decrement. That ordering
 * matters for the same reason: the decrement is what can stamp `finish` and
 * make the run look complete, and doing it before the record of WHY a food
 * bank is missing would mean a crash in between leaves a finished-looking run
 * with no explanation in it.
 */
let events: string[];

/**
 * The D1 Sessions API surface packages/db uses, over the real engine -- the
 * same adapter shape as the sibling articlesDlq.test.ts's, plus a log of the
 * SQL prepared.
 *
 * THE SQL LOG IS NOT DECORATION. "This consumer writes the discrepancy and the
 * counter and nothing else" is a claim about the statements ISSUED, not only
 * about the rows left behind: a write to a table this fixture does not have --
 * `foodbank.last_need_check`, a crawlitem -- would throw "no such table" and
 * be swallowed by the handler's own catch, leaving a database snapshot
 * identical to a handler that never tried. The log sees the attempt.
 *
 * `first()` answers null, never undefined -- decrementCrawlSetRemaining's
 * `if (!row) return null` happens to treat them alike, but D1 returns null and
 * a double that returned undefined would be modelling a different API.
 */
function d1Session(hooks: { failOn?: RegExp; failWith?: unknown }): unknown {
  function statement(sql: string, params: Bindable[]): unknown {
    const guard = (): void => {
      // The default is D1's real message for a connection lost mid-statement,
      // which is the failure both of this handler's inner catches exist for.
      if (hooks.failOn?.test(sql)) throw hooks.failWith ?? new Error("D1_ERROR: Network connection lost");
    };
    return {
      bind: (...values: unknown[]) => statement(sql, values as Bindable[]),
      first: async <T>() => {
        guard();
        return (db.prepare(sql).get(...params) ?? null) as T | null;
      },
      all: async <T>() => {
        guard();
        return { results: db.prepare(sql).all(...params) as T[] };
      },
      run: async () => {
        guard();
        const result = db.prepare(sql).run(...params);
        return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
    };
  }
  return {
    prepare: (sql: string) => {
      preparedSql.push(sql);
      // Named, not truncated: an unrecognised statement goes into the sequence
      // in full, so a write this consumer grows later shows up as itself
      // rather than as a prefix that happens to match something known.
      const label = /INSERT INTO foodbankdiscrepancy/.test(sql)
        ? "discrepancy"
        : /SET remaining = remaining - 1/.test(sql)
          ? "decrement"
          : /SET finish =/.test(sql)
            ? "stamp-finish"
            : sql.replace(/\s+/g, " ").trim();
      events.push(`sql:${label}`);
      return statement(sql, []);
    },
    getBookmark: () => null,
  };
}

/** Prepared SQL with runs of whitespace collapsed -- the db package's INSERTs are templates. */
function sqlIssued(): string[] {
  return preparedSql.map((sql) => sql.replace(/\s+/g, " ").trim());
}

const DISCREPANCY_INSERT =
  "INSERT INTO foodbankdiscrepancy (foodbank_id, need_id, url, discrepancy_type, discrepancy_text, status, created, modified) VALUES (?1, NULL, ?2, ?3, ?4, 'New', ?5, ?5)";
const DECREMENT = "UPDATE crawlset SET remaining = remaining - 1 WHERE id = ?1 AND remaining > 0 RETURNING remaining";
const STAMP_FINISH = "UPDATE crawlset SET finish = ?1 WHERE id = ?2";

/** What one message in the batch recorded about how the handler disposed of it. */
interface Disposal {
  acks: number;
  /** One entry per retry() call, holding whatever options were passed. */
  retries: unknown[];
}

interface FakeBatch {
  batch: MessageBatch<NeedcheckRenderMessage>;
  /** Parallel to the message bodies handed to makeBatch. */
  disposals: Disposal[];
  /** Counts for the batch-wide escape hatches, which this handler must never use. */
  batchWide: { ackAll: number; retryAll: number };
}

/**
 * A MessageBatch double.
 *
 * `ackAll`/`retryAll` are present and counted rather than omitted: a handler
 * that called `batch.ackAll()` once instead of acking per message would leave
 * every per-message counter at zero, and without these the failure would read
 * as a missing method rather than as the behaviour change it is. Likewise
 * every message carries a real `retry`, so "this consumer never retries" is
 * measured rather than inferred from the absence of a call site.
 *
 * `attempts: 4` because a message reaches THIS queue only after
 * needcheck-render burned its `max_retries: 3` (wrangler.jsonc); a 1 here
 * would be a shape no real delivery to a DLQ has.
 */
function makeBatch(bodies: unknown[], queue = "needcheck-render-dlq"): FakeBatch {
  const disposals: Disposal[] = [];
  const batchWide = { ackAll: 0, retryAll: 0 };
  const messages = bodies.map((body, index) => {
    const disposal: Disposal = { acks: 0, retries: [] };
    disposals.push(disposal);
    return {
      id: `msg-${index + 1}`,
      timestamp: new Date("2026-09-05T15:00:12.000Z"),
      attempts: 4,
      body: body as NeedcheckRenderMessage,
      ack: () => {
        disposal.acks += 1;
        events.push(`ack:msg-${index + 1}`);
      },
      retry: (options?: unknown) => {
        disposal.retries.push(options);
        events.push(`retry:msg-${index + 1}`);
      },
    };
  });
  const batch = {
    queue,
    messages,
    ackAll: () => void (batchWide.ackAll += 1),
    retryAll: () => void (batchWide.retryAll += 1),
  } as unknown as MessageBatch<NeedcheckRenderMessage>;
  return { batch, disposals, batchWide };
}

/**
 * The body shape the needcheck cron publishes (scheduled/index.ts:167-175),
 * with test defaults.
 *
 * `url` and `shoppingListUrl` are DELIBERATELY DIFFERENT here. The cron sends
 * `url: fb.url` (the food bank's home page, line 172) and `shoppingListUrl:
 * fb.shopping_list_url` (line 173 -- the page the render actually failed on), and this
 * handler uses the former for both the discrepancy's `url` column and its
 * text. Give them the same value in the fixture and a mutant that swaps them
 * is invisible.
 */
function needcheckMessage(over: Partial<NeedcheckRenderMessage> = {}): NeedcheckRenderMessage {
  return {
    crawlSetId: 1,
    foodbankId: 331,
    slug: "salisbury",
    name: "Salisbury",
    url: "https://www.salisburyfoodbank.org.uk/",
    shoppingListUrl: "https://www.salisburyfoodbank.org.uk/give-help/donate-food/",
    facebookPage: null,
    ...over,
  };
}

// ===========================================================================
// FIXTURES
// ===========================================================================

// The spelling Django and the ETL write into these TEXT columns: a SPACE
// separator, six fractional digits, never a "T" and never a "Z". SQLite
// compares TEXT bytewise, so this is not cosmetic -- see
// packages/models/src/pyDatetime.ts's header for the two production incidents
// that came of writing toISOString() into a column shaped like this.
const NOW = new Date("2026-09-05T15:41:22.070Z");
const DJANGO_NOW = "2026-09-05 15:41:22.070000";

interface CrawlSetRow {
  id: number;
  crawl_type: string;
  run_id: string | null;
  start: string;
  finish: string | null;
  expected: number | null;
  remaining: number | null;
}

/**
 * One crawl set, as the needcheck cron writes it: insertCrawlSet stamps
 * crawl_type/run_id/start, then setCrawlSetExpected sets expected = remaining
 * = the number of open food banks enqueued. `start` is an EARLIER
 * Django-format timestamp than NOW so the finish-stamp tests compare two real
 * values -- the single daily 15:00 sweep (`0 15 * * *`, wrangler.jsonc),
 * dead-lettered at 15:41 after needcheck-render burned three retries with a
 * 60s delay between each.
 */
function seedCrawlSet(over: Partial<CrawlSetRow> = {}): number {
  const row: CrawlSetRow = {
    id: 1,
    crawl_type: "need",
    run_id: "needcheck-2026-09-05-15",
    start: "2026-09-05 15:00:03.284000",
    finish: null,
    expected: 3,
    remaining: 3,
    ...over,
  };
  db.prepare("INSERT INTO crawlset (id, crawl_type, run_id, start, finish, expected, remaining) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    row.id,
    row.crawl_type,
    row.run_id,
    row.start,
    row.finish,
    row.expected,
    row.remaining,
  );
  return row.id;
}

function crawlSet(id: number): CrawlSetRow | undefined {
  return db.prepare("SELECT * FROM crawlset WHERE id = ?").get(id) as unknown as CrawlSetRow | undefined;
}

function crawlSets(): CrawlSetRow[] {
  return db.prepare("SELECT * FROM crawlset ORDER BY id").all() as unknown as CrawlSetRow[];
}

interface DiscrepancyRow {
  id: number;
  foodbank_id: number | null;
  need_id: number | null;
  url: string | null;
  discrepancy_type: string;
  discrepancy_text: string;
  status: string;
  created: string;
  modified: string;
}

function discrepancies(): DiscrepancyRow[] {
  return db.prepare("SELECT * FROM foodbankdiscrepancy ORDER BY id").all() as unknown as DiscrepancyRow[];
}

/**
 * A discrepancy already sitting in /admin/discrepancies/ before this batch
 * arrives -- the row that MUST come back out unchanged.
 *
 * The admin queue accumulates: a food bank whose site has been broken for a
 * week has one open row per day's sweep, and the maintainer triages them by
 * hand. Every test in this file that only seeds an empty table would pass
 * against a handler that reached for an existing row instead of appending
 * one, so there needs to be a row present that has something to lose.
 */
function seedDiscrepancy(over: Partial<DiscrepancyRow> = {}): DiscrepancyRow {
  const row: DiscrepancyRow = {
    id: 1,
    foodbank_id: 331,
    need_id: null,
    url: "https://www.salisburyfoodbank.org.uk/",
    discrepancy_type: "website",
    discrepancy_text: "Need check repeatedly failed for https://www.salisburyfoodbank.org.uk/ and was dead-lettered after exhausting retries",
    // Yesterday's sweep, already looked at: `modified` is later than
    // `created` because a human moved it, which is exactly the edit a
    // re-touch from this consumer would destroy.
    status: "New",
    created: "2026-09-04 15:41:02.118000",
    modified: "2026-09-04 16:02:11.904000",
    ...over,
  };
  db.prepare(
    "INSERT INTO foodbankdiscrepancy (id, foodbank_id, need_id, url, discrepancy_type, discrepancy_text, status, created, modified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(row.id, row.foodbank_id, row.need_id, row.url, row.discrepancy_type, row.discrepancy_text, row.status, row.created, row.modified);
  return row;
}

/** Every console.error call, as [firstArg, ...rest]. */
let errors: unknown[][];

/** Just the message strings, which is what the log lines' format is asserted on. */
function errorLines(): string[] {
  return errors.map((args) => String(args[0]));
}

let env: Env;

beforeEach(() => {
  // Date only: this handler has no timers, and faking setTimeout would be
  // faking something nothing under test uses. Frozen so `created`, `modified`
  // and `finish` have one predictable value each rather than regex-shaped
  // assertions that could not tell the three apart.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);

  db = new DatabaseSync(":memory:") as unknown as SqliteDatabase;
  db.exec(schemaFor("crawlset", "foodbankdiscrepancy"));

  sessionModes = [];
  preparedSql = [];
  errors = [];
  events = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args);
    events.push(`log:${String(args[0]).replace(/^needcheck-render-dlq: /, "")}`);
  });

  env = {
    DB: {
      withSession: (mode: string) => {
        sessionModes.push(mode);
        return d1Session({});
      },
    },
  } as unknown as Env;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  db.close();
});

/** Rebuilds `env` with a session that throws for statements matching `failOn`. */
function envFailing(failOn: RegExp, failWith?: unknown): Env {
  return {
    DB: {
      withSession: (mode: string) => {
        sessionModes.push(mode);
        return d1Session({ failOn, failWith });
      },
    },
  } as unknown as Env;
}

// ===========================================================================
// THE DISCREPANCY -- the only thing that tells a human this happened
// ===========================================================================
describe("the discrepancy it records", () => {
  // wrangler.jsonc calls the DLQ "NON-NEGOTIABLE" precisely because of this
  // row: it is the entire reason a dead-lettered food bank is not invisible.
  // The maintainer reads /admin/discrepancies/ every morning; nothing else in
  // this Worker surfaces a needcheck that failed four times.
  //
  // Every column is asserted, not just "a row exists". foodbank_id decides
  // which food bank the admin queue attributes the failure to, `url` is the
  // link in that row, and `status` decides whether it appears in the default
  // (New) filter at all -- a row written 'Done' would be filed straight into
  // the archive nobody opens.
  it("writes exactly one row, with every column the admin queue reads", async () => {
    const id = seedCrawlSet({ expected: 4, remaining: 4 });

    const { batch } = makeBatch([
      needcheckMessage({
        crawlSetId: id,
        foodbankId: 331,
        slug: "salisbury",
        url: "https://www.salisburyfoodbank.org.uk/",
        shoppingListUrl: "https://www.salisburyfoodbank.org.uk/give-help/donate-food/",
      }),
    ]);
    await handleNeedcheckRenderDlq(batch, env);

    const rows = discrepancies();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: 1,
      foodbank_id: 331,
      // NULL: neither Django call site attaches a discrepancy to a
      // FoodbankChange (crawlers.py:312, :490 both leave `need` unset), and
      // this one has no need row to attach to in any case.
      need_id: null,
      url: "https://www.salisburyfoodbank.org.uk/",
      // One of DISCREPANCY_TYPES (const/general.py:44-52), and the same value
      // both of Django's own needcheck discrepancy writes use. A type outside
      // that list still INSERTs -- the column is free TEXT, not an enum
      // (0008_needcheck.sql:53-56 says so deliberately) -- and would simply
      // render as an unknown filter option in the admin.
      discrepancy_type: "website",
      discrepancy_text: "Need check repeatedly failed for https://www.salisburyfoodbank.org.uk/ and was dead-lettered after exhausting retries",
      // The model default in Django (needs.py:37) and the DEFAULT on the
      // column; written explicitly by insertFoodbankDiscrepancy so the row
      // lands in the queue's default view.
      status: "New",
      created: DJANGO_NOW,
      modified: DJANGO_NOW,
    });
  });

  // THE URL IS THE HOME PAGE, NOT THE PAGE THAT FAILED. The message carries
  // both, and this handler uses `url` (fb.url) for the column and for the
  // text, while the page whose render actually failed is `shoppingListUrl`
  // (scheduled/index.ts:174-175). That matches Django, whose own render-
  // failure discrepancy is likewise "Website %s render failed" % foodbank.url
  // with url=foodbank.url (crawlers.py:312-317) -- so it is a faithful port,
  // not an accident -- but it does mean the discrepancy links a maintainer to
  // a page that is probably fine. PINNED, NOT FIXED; noted in suspectedBugs.
  //
  // Also the mutation guard: with the two URLs distinct in the fixture, a
  // handler that reached for `shoppingListUrl` fails here and nowhere else.
  it("names the food bank's home page, never the shopping-list URL that actually failed", async () => {
    const id = seedCrawlSet();

    const { batch } = makeBatch([
      needcheckMessage({
        crawlSetId: id,
        url: "https://example-foodbank.org/",
        shoppingListUrl: "https://example-foodbank.org/what-we-need",
      }),
    ]);
    await handleNeedcheckRenderDlq(batch, env);

    expect(discrepancies()[0]!.url).toBe("https://example-foodbank.org/");
    expect(discrepancies()[0]!.discrepancy_text).toBe(
      "Need check repeatedly failed for https://example-foodbank.org/ and was dead-lettered after exhausting retries",
    );
    expect(discrepancies()[0]!.discrepancy_text).not.toContain("what-we-need");
  });

  // Ticket #9 at this write site. `created` is what /admin/discrepancies/
  // orders by (discrepancy_status_created_idx is on (status, created DESC)),
  // and the column is TEXT, so an ISO value would sort above every same-day
  // Django row regardless of its actual time -- putting a stale row at the
  // top of the queue the maintainer works from.
  it("stamps created and modified in Django's format, not toISOString's", async () => {
    const id = seedCrawlSet();

    const { batch } = makeBatch([needcheckMessage({ crawlSetId: id })]);
    await handleNeedcheckRenderDlq(batch, env);

    const row = discrepancies()[0]!;
    expect(row.created).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
    expect(row.created).not.toContain("T");
    expect(row.created).not.toContain("Z");
    // Both from the same pyNow() call, so a row's "last touched" never
    // predates its own creation.
    expect(row.modified).toBe(row.created);
    // The demonstration of why the format matters, run by the same engine on
    // the same TEXT column: the ISO spelling of this very instant sorts ABOVE
    // an evening Django value it precedes by more than six hours, because 'T'
    // (0x54) beats ' ' (0x20).
    const iso = db.prepare("SELECT ? > ? AS after").get(NOW.toISOString(), "2026-09-05 22:00:00.000000") as unknown as { after: number };
    expect(iso.after).toBe(1);
  });

  // ONE ROW PER MESSAGE. needcheck-render-dlq's max_batch_size is 10
  // (wrangler.jsonc), and a batch of several failures is the NORMAL case on a
  // bad night -- an OpenRouter wobble or a D1 blip dead-letters food banks in
  // groups. A write hoisted out of the loop would record the first and lose
  // the rest, and the maintainer would fix one site and think they were done.
  it("records each food bank in the batch separately, in batch order", async () => {
    const id = seedCrawlSet({ expected: 10, remaining: 10 });

    const { batch } = makeBatch([
      needcheckMessage({ crawlSetId: id, foodbankId: 1, slug: "aberdeen", url: "https://aberdeen.example/" }),
      needcheckMessage({ crawlSetId: id, foodbankId: 2, slug: "bath", url: "https://bath.example/" }),
      needcheckMessage({ crawlSetId: id, foodbankId: 3, slug: "cardiff", url: "https://cardiff.example/" }),
    ]);
    await handleNeedcheckRenderDlq(batch, env);

    expect(discrepancies().map((row) => [row.foodbank_id, row.url])).toEqual([
      [1, "https://aberdeen.example/"],
      [2, "https://bath.example/"],
      [3, "https://cardiff.example/"],
    ]);
  });

  // IT APPENDS; IT NEVER REACHES FOR THE ROW THAT IS ALREADY THERE. A food
  // bank whose site has been failing for days already has an open, possibly
  // already-triaged discrepancy when tonight's sweep dead-letters it again.
  // Rewriting that row instead of adding one would destroy the maintainer's
  // own edits, and bumping its `modified` would reorder the queue they work
  // from; collapsing the two into one row would also hide that this has now
  // happened twice, which is the signal that the site is not coming back.
  //
  // WHY THIS AS WELL AS THE SQL ASSERTION, which is the same argument the
  // second crawl set in the finish-stamp test is there for. An `INSERT OR
  // REPLACE`, an `ON CONFLICT DO UPDATE`, or an extra
  // `UPDATE foodbankdiscrepancy SET modified = ...` alongside the insert (a
  // plausible "keep the queue fresh" edit) do all change the statement text,
  // so "issues the discrepancy insert and the decrement, and nothing else"
  // does fire -- but a text comparison cannot tell any of them from a
  // reformat, and it says nothing about what was damaged. Every other test in
  // this block starts from an EMPTY table, where an update-in-place matches no
  // rows and is indistinguishable from an append. This is the only test in the
  // file where an existing admin row has anything to lose.
  it("appends a second row, leaving an earlier discrepancy for the same food bank exactly as it was", async () => {
    const id = seedCrawlSet({ expected: 4, remaining: 4 });
    const yesterday = seedDiscrepancy();

    const { batch } = makeBatch([needcheckMessage({ crawlSetId: id, foodbankId: 331, slug: "salisbury" })]);
    await handleNeedcheckRenderDlq(batch, env);

    const rows = discrepancies();
    expect(rows).toHaveLength(2);
    // Byte for byte, including `modified`: the whole point is that nothing
    // about the older row moved.
    expect(rows[0]).toEqual(yesterday);
    // And the new one is genuinely new -- today's timestamps, its own id.
    expect(rows[1]!.id).toBe(2);
    expect(rows[1]!.created).toBe(DJANGO_NOW);
    expect(rows[1]!.modified).toBe(DJANGO_NOW);
    expect(rows[1]!.foodbank_id).toBe(331);
  });

  // The dangling-reference case. There is no foreign key on
  // foodbankdiscrepancy.foodbank_id (0008_needcheck.sql declares it as a bare
  // `foodbank_id INTEGER`), so a food bank deleted between the 15:00 enqueue
  // and the dead-letter still gets a row -- it just joins to nothing through
  // foodbankdiscrepancy_full and renders with a blank name. Pinned because
  // the alternative (an integrity error swallowed by the catch) would mean
  // the deletion silently ate the only record of the failure.
  it("still records a food bank that no longer exists, rather than erroring", async () => {
    const id = seedCrawlSet();

    const { batch, disposals } = makeBatch([needcheckMessage({ crawlSetId: id, foodbankId: 99999, slug: "deleted-between-enqueue-and-dlq" })]);
    await handleNeedcheckRenderDlq(batch, env);

    expect(discrepancies().map((row) => row.foodbank_id)).toEqual([99999]);
    expect(disposals[0]!.acks).toBe(1);
    expect(errorLines()).toEqual([]);
  });

  it("writes nothing at all for an empty batch", async () => {
    const id = seedCrawlSet({ remaining: 3 });

    const { batch } = makeBatch([]);
    await handleNeedcheckRenderDlq(batch, env);

    expect(discrepancies()).toEqual([]);
    expect(crawlSet(id)!.remaining).toBe(3);
    expect(preparedSql).toEqual([]);
    expect(errorLines()).toEqual([]);
  });
});

// ===========================================================================
// THE COUNTER -- what keeps the run from hanging for ever
// ===========================================================================
describe("the crawlset countdown", () => {
  // The module's own comment (lines 33-37): every other exit from
  // needcheckRender.ts's processOne() decrements via finish(), "and a message
  // that ends up here instead must still count down, or a single
  // permanently-failing food bank leaves that day's CrawlSet.finish stamped
  // never." A handler reduced to writing the discrepancy and acking passes
  // every assertion in the block above and fails only here.
  it("decrements remaining for the crawl set named in the message body", async () => {
    const id = seedCrawlSet({ expected: 3, remaining: 3 });

    const { batch } = makeBatch([needcheckMessage({ crawlSetId: id })]);
    await handleNeedcheckRenderDlq(batch, env);

    expect(crawlSet(id)!.remaining).toBe(2);
    // `expected` is the run's denominator on /admin/crawls/ and must survive
    // untouched: a decrement that moved both would make every run read 100%
    // complete no matter how many food banks actually failed.
    expect(crawlSet(id)!.expected).toBe(3);
  });

  // Kills the mutant that decrements a hardcoded crawl set, or the first row,
  // or binds foodbankId instead. Invisible while only one crawl set exists,
  // and several are open on any given day: needcheck at 15:00, getarticles
  // eight times a day, charityinfo at 05:30 (wrangler.jsonc's crons).
  it("touches only the crawl set named, leaving other open runs alone", async () => {
    seedCrawlSet({ id: 41, run_id: "needcheck-2026-09-04-15", remaining: 5, expected: 5 });
    seedCrawlSet({ id: 42, run_id: "needcheck-2026-09-05-15", remaining: 7, expected: 7 });
    seedCrawlSet({ id: 43, run_id: "articles-2026-09-05-14", crawl_type: "article", remaining: 9, expected: 9 });

    const { batch } = makeBatch([needcheckMessage({ crawlSetId: 42 })]);
    await handleNeedcheckRenderDlq(batch, env);

    expect(crawlSets().map((row) => [row.id, row.remaining])).toEqual([
      [41, 5],
      [42, 6],
      [43, 9],
    ]);
  });

  it("decrements once per message when several messages share a crawl set", async () => {
    const id = seedCrawlSet({ expected: 10, remaining: 10 });

    const { batch } = makeBatch([
      needcheckMessage({ crawlSetId: id, foodbankId: 1, slug: "aberdeen" }),
      needcheckMessage({ crawlSetId: id, foodbankId: 2, slug: "bath" }),
      needcheckMessage({ crawlSetId: id, foodbankId: 3, slug: "cardiff" }),
    ]);
    await handleNeedcheckRenderDlq(batch, env);

    expect(crawlSet(id)!.remaining).toBe(7);
  });

  // One batch can legitimately span two runs: a message dead-lettered from
  // yesterday's sweep can be delivered alongside today's, since the DLQ has
  // its own retention independent of when the crawl set was created.
  it("decrements each named set independently when one batch spans several", async () => {
    seedCrawlSet({ id: 41, run_id: "needcheck-2026-09-04-15", remaining: 4, expected: 4 });
    seedCrawlSet({ id: 42, run_id: "needcheck-2026-09-05-15", remaining: 4, expected: 4 });

    const { batch } = makeBatch([
      needcheckMessage({ crawlSetId: 41, foodbankId: 1, slug: "aberdeen" }),
      needcheckMessage({ crawlSetId: 42, foodbankId: 2, slug: "bath" }),
      needcheckMessage({ crawlSetId: 42, foodbankId: 3, slug: "cardiff" }),
    ]);
    await handleNeedcheckRenderDlq(batch, env);

    expect(crawlSets().map((row) => [row.id, row.remaining])).toEqual([
      [41, 3],
      [42, 2],
    ]);
  });
});

// ===========================================================================
// FINISHING THE RUN -- what the counter reaching zero is FOR
// ===========================================================================
describe("stamping crawlset.finish", () => {
  // The payoff, and the likeliest real shape of it. decrementCrawlSetRemaining
  // stamps `finish` itself the moment remaining hits 0 (needcheck.ts:73-75),
  // and a dead-lettered food bank is very often the LAST one outstanding: it
  // is by definition the slowest, having burned three retries with a 60s delay
  // between each (needcheckRender.ts:69) before landing here. Without this
  // consumer's decrement the stamp never happens and /admin/crawls/ shows the
  // 15:00 sweep as still running, for ever.
  it("stamps finish when the dead-lettered food bank is the last one outstanding", async () => {
    const id = seedCrawlSet({ id: 7, expected: 4, remaining: 1 });
    // A SECOND, STILL-RUNNING CRAWL SET, and not decoration: the `finish`
    // stamp's own `WHERE id = ?2` is otherwise untested here as behaviour, and
    // a mutant that drops it stamps every unfinished crawl in the table --
    // marking today's articles run complete because a needcheck food bank
    // failed. Delete this seed and the only thing left watching that clause is
    // the prepared-SQL assertion in "the D1 session", which sees the statement
    // text change but cannot tell this bug from a reformat.
    seedCrawlSet({ id: 8, run_id: "articles-2026-09-05-14", crawl_type: "article", expected: 6, remaining: 6 });

    const { batch } = makeBatch([needcheckMessage({ crawlSetId: id })]);
    await handleNeedcheckRenderDlq(batch, env);

    expect(crawlSet(7)!.remaining).toBe(0);
    expect(crawlSet(7)!.finish).toBe(DJANGO_NOW);
    expect(crawlSet(8)!.finish).toBeNull();
  });

  // Ticket #9 again, on the other TEXT timestamp this consumer can reach.
  // /admin/crawls/ computes "time taken" by comparing `finish` against
  // `start`; a toISOString() value sorts after every same-day Django `start`
  // regardless of the real elapsed time, and a mixed column makes ORDER BY
  // meaningless.
  it("writes finish in Django's format, so it still compares against start", async () => {
    const id = seedCrawlSet({ expected: 1, remaining: 1, start: "2026-09-05 15:00:03.284000" });

    const { batch } = makeBatch([needcheckMessage({ crawlSetId: id })]);
    await handleNeedcheckRenderDlq(batch, env);

    const finish = crawlSet(id)!.finish!;
    expect(finish).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
    expect(finish).not.toContain("T");
    // The comparison /admin/crawls/ actually makes, run by the same engine on
    // the same TEXT columns.
    const ordered = db.prepare("SELECT finish > start AS after FROM crawlset WHERE id = ?").get(id) as unknown as { after: number };
    expect(ordered.after).toBe(1);
  });

  // At EXACTLY zero, not at "one left". A run stamped finished while food
  // banks are still being crawled is worse than one never stamped: it looks
  // correct, so nobody investigates.
  it("does not stamp finish while other food banks are still outstanding", async () => {
    const id = seedCrawlSet({ expected: 4, remaining: 2 });

    const { batch } = makeBatch([needcheckMessage({ crawlSetId: id })]);
    await handleNeedcheckRenderDlq(batch, env);

    expect(crawlSet(id)!.remaining).toBe(1);
    expect(crawlSet(id)!.finish).toBeNull();
  });

  // The floor. Without decrementCrawlSetRemaining's `remaining > 0` guard an
  // extra delivery drives the counter negative and `=== 0` never matches
  // again -- the run becomes unfinishable. This consumer is a likely source
  // of that extra delivery (see the redelivery block below), so the guard is
  // asserted from here as well as from packages/db's own suite.
  it("leaves an already-finished crawl set at zero rather than going negative", async () => {
    const id = seedCrawlSet({ expected: 4, remaining: 0, finish: "2026-09-05 15:38:00.000000" });

    const { batch, disposals } = makeBatch([needcheckMessage({ crawlSetId: id })]);
    await handleNeedcheckRenderDlq(batch, env);

    expect(crawlSet(id)!.remaining).toBe(0);
    // The original finish stands: no re-stamp with NOW, which would silently
    // rewrite how long the run took.
    expect(crawlSet(id)!.finish).toBe("2026-09-05 15:38:00.000000");
    // And the discrepancy is written anyway -- the run being closed is no
    // reason to lose the record of which food bank failed. Asserted on the
    // row's content rather than on a count of 1, since "a discrepancy exists"
    // is true of a row written against the wrong food bank too, and this is
    // the branch where the counter has told the handler nothing happened.
    expect(discrepancies().map((row) => [row.foodbank_id, row.discrepancy_type, row.status])).toEqual([[331, "website", "New"]]);
    expect(disposals[0]!.acks).toBe(1);
  });
});

// ===========================================================================
// THE SPLIT try/catch -- this module's own documented regression
// ===========================================================================
describe("the two writes are independent", () => {
  // needcheckRenderDlq.ts:15-21 verbatim: "They used to share one try block: a
  // failure in the discrepancy write skipped the decrement too, and since this
  // queue's own max_retries is 1 with no further DLQ behind it, both were lost
  // for good behind nothing but a console.error line."
  //
  // This is the first direction: the discrepancy write is unavailable and the
  // countdown must still happen, or one bad night's D1 wobble leaves the whole
  // 15:00 sweep permanently unfinished on /admin/crawls/.
  it("still decrements when the discrepancy write fails", async () => {
    const id = seedCrawlSet({ expected: 4, remaining: 4 });

    const { batch, disposals, batchWide } = makeBatch([needcheckMessage({ crawlSetId: id, foodbankId: 1, slug: "aberdeen" })]);
    await handleNeedcheckRenderDlq(batch, envFailing(/INSERT INTO foodbankdiscrepancy/));

    expect(discrepancies()).toEqual([]);
    expect(crawlSet(id)!.remaining).toBe(3);
    expect(disposals[0]!.acks).toBe(1);
    expect(errorLines()).toEqual(["needcheck-render-dlq: failed to record discrepancy for foodbank 1 (aberdeen)"]);
    // Per catch, so a survivor names WHICH one grew the hatch -- see the
    // disposal block's "never retries and never reaches for the batch-wide
    // hatches" for why the failure path is where this matters.
    expect(batchWide).toEqual({ ackAll: 0, retryAll: 0 });
  });

  // The other direction, which the merged-try version would also have got
  // right -- included so the pair is symmetrical and so a "simplification"
  // that reorders the two blocks cannot quietly make the SECOND one
  // conditional on the first.
  it("still records the discrepancy when the decrement fails", async () => {
    const id = seedCrawlSet({ expected: 4, remaining: 4 });

    const { batch, disposals, batchWide } = makeBatch([needcheckMessage({ crawlSetId: id, foodbankId: 1, slug: "aberdeen" })]);
    await handleNeedcheckRenderDlq(batch, envFailing(/UPDATE crawlset/));

    // The whole row, not a count: the record of WHICH food bank was lost is
    // the more important of the two writes, so when the other one has failed
    // it is worth checking this one is not merely present but correct.
    expect(discrepancies().map((row) => [row.foodbank_id, row.url, row.discrepancy_type, row.status])).toEqual([
      [1, "https://www.salisburyfoodbank.org.uk/", "website", "New"],
    ]);
    expect(crawlSet(id)!.remaining).toBe(4);
    expect(disposals[0]!.acks).toBe(1);
    expect(errorLines()).toEqual(["needcheck-render-dlq: failed to decrement crawlset remaining for foodbank 1 (aberdeen)"]);
    expect(batchWide).toEqual({ ackAll: 0, retryAll: 0 });
  });

  // Both dependencies gone at once -- D1 itself down, which is the realistic
  // way this happens rather than one statement failing in isolation. Two
  // distinct log lines, the message still acked, and the handler still
  // resolving: the queue is drained and the trace is the log, which is the
  // documented trade wrangler.jsonc's `max_retries: 1` makes.
  it("logs both failures separately and still acks when D1 is down entirely", async () => {
    const id = seedCrawlSet({ expected: 4, remaining: 4 });

    const { batch, disposals } = makeBatch([needcheckMessage({ crawlSetId: id, foodbankId: 1, slug: "aberdeen" })]);
    await expect(handleNeedcheckRenderDlq(batch, envFailing(/INSERT INTO foodbankdiscrepancy|UPDATE crawlset/))).resolves.toBeUndefined();

    expect(discrepancies()).toEqual([]);
    expect(crawlSet(id)!.remaining).toBe(4);
    expect(errorLines()).toEqual([
      "needcheck-render-dlq: failed to record discrepancy for foodbank 1 (aberdeen)",
      "needcheck-render-dlq: failed to decrement crawlset remaining for foodbank 1 (aberdeen)",
    ]);
    expect(disposals[0]!.acks).toBe(1);
  });
});

// ===========================================================================
// DISPOSAL -- ack, retry, and what the queue config makes of each
// ===========================================================================
describe("message disposal", () => {
  it("acks each message exactly once, per message rather than batch-wide", async () => {
    const id = seedCrawlSet({ expected: 3, remaining: 3 });

    const { batch, disposals, batchWide } = makeBatch([
      needcheckMessage({ crawlSetId: id, foodbankId: 1, slug: "aberdeen" }),
      needcheckMessage({ crawlSetId: id, foodbankId: 2, slug: "bath" }),
    ]);
    await handleNeedcheckRenderDlq(batch, env);

    expect(disposals.map((d) => d.acks)).toEqual([1, 1]);
    // ackAll() would look identical from the queue's side today but would also
    // ack a message the loop had not reached, which is how a partial batch
    // silently loses work.
    expect(batchWide).toEqual({ ackAll: 0, retryAll: 0 });
  });

  // needcheckRenderDlq.ts:42-45's own reasoning, pinned: "Always ack -- this is
  // already the dead-letter queue with its own max_retries: 1
  // (wrangler.jsonc); retrying here just risks an infinite loop if D1 itself
  // is the thing failing." Note the asymmetry with needcheckRender.ts's own
  // consumer, which DOES retry (with a 60s delay); "make the two consistent"
  // is a plausible and wrong edit.
  //
  // `batchWide` IS ASSERTED HERE, ON THE FAILURE PATH, and not only in the
  // all-succeeded test above -- which is where the original version of this
  // file checked it, and where it caught nothing. The failure path is where
  // the wrong edit actually gets written: "the write failed, so put the batch
  // back" is one `batch.retryAll()` inside a catch block, and on a queue with
  // `max_retries: 1` and nothing behind it that is precisely the loop the
  // module's comment warns about. `batch.ackAll()` in a catch is the mirror
  // image: it acks the messages the loop has NOT reached yet, so a D1 wobble
  // on the first food bank silently discards the rest of the batch unwritten.
  //
  // Four mutants survived the suite before this: `batch.retryAll()` and
  // `batch.ackAll()`, each in either of the two catches. All four leave every
  // row, every log line, every per-message ack count and the handler's own
  // resolution completely unchanged -- these three lines are the only thing
  // that can see them. Two messages rather than one because that is what makes
  // the batch-wide hatches differ from the per-message calls at all.
  it("never retries and never reaches for the batch-wide hatches, even when both writes fail", async () => {
    const id = seedCrawlSet({ expected: 3, remaining: 3 });

    const { batch, disposals, batchWide } = makeBatch([
      needcheckMessage({ crawlSetId: id, foodbankId: 1, slug: "aberdeen" }),
      needcheckMessage({ crawlSetId: id, foodbankId: 2, slug: "bath" }),
    ]);
    await handleNeedcheckRenderDlq(batch, envFailing(/INSERT INTO foodbankdiscrepancy|UPDATE crawlset/));

    expect(disposals.map((d) => d.retries)).toEqual([[], []]);
    expect(disposals.map((d) => d.acks)).toEqual([1, 1]);
    expect(batchWide).toEqual({ ackAll: 0, retryAll: 0 });
  });

  // ORDER, not just count -- see the `events` comment. An ack tells the queue
  // the message is consumed, so it must come AFTER both writes: an invocation
  // evicted between an early ack and the writes loses them with no message
  // left to redeliver, which is the silent drop this whole consumer exists to
  // prevent, arrived at by a different road. No assertion about rows or ack
  // counts can see it: both are identical either way.
  //
  // The interleaving also pins that the three steps run PER MESSAGE rather
  // than as three passes over the batch: all-discrepancies-then-all-decrements
  // would read discrepancy,discrepancy,decrement,decrement here.
  it("records, then decrements, then acks -- in that order, per message", async () => {
    const id = seedCrawlSet({ expected: 10, remaining: 10 });

    const { batch } = makeBatch([
      needcheckMessage({ crawlSetId: id, foodbankId: 1, slug: "aberdeen" }),
      needcheckMessage({ crawlSetId: id, foodbankId: 2, slug: "bath" }),
    ]);
    await handleNeedcheckRenderDlq(batch, env);

    expect(events).toEqual([
      "sql:discrepancy",
      "sql:decrement",
      "ack:msg-1",
      "sql:discrepancy",
      "sql:decrement",
      "ack:msg-2",
    ]);
  });

  // The same ordering claim on the failure path: each error is logged where it
  // happened, before the ack, so the trace is on disk before the message stops
  // existing -- and the two log lines are not batched to the end of the loop,
  // where a crash mid-message would lose the first one.
  it("interleaves each failure's log with the write that failed, before the ack", async () => {
    seedCrawlSet({ expected: 3, remaining: 3 });

    const { batch } = makeBatch([needcheckMessage({ foodbankId: 1, slug: "aberdeen" })]);
    await handleNeedcheckRenderDlq(batch, envFailing(/INSERT INTO foodbankdiscrepancy|UPDATE crawlset/));

    expect(events).toEqual([
      "sql:discrepancy",
      "log:failed to record discrepancy for foodbank 1 (aberdeen)",
      "sql:decrement",
      "log:failed to decrement crawlset remaining for foodbank 1 (aberdeen)",
      "ack:msg-1",
    ]);
  });
});

// ===========================================================================
// A DOWNSTREAM FAILURE -- D1 erroring underneath either write
// ===========================================================================
describe("when D1 fails", () => {
  // The handler resolves rather than rejecting. If it threw, the whole batch
  // would be redelivered -- including messages already acked, already recorded
  // and already decremented, double-counting the counter it exists to protect
  // and duplicating rows in the discrepancy queue.
  it("resolves rather than propagating the error out of the consumer", async () => {
    seedCrawlSet({ expected: 3, remaining: 3 });

    const { batch } = makeBatch([needcheckMessage()]);
    await expect(handleNeedcheckRenderDlq(batch, envFailing(/UPDATE crawlset/))).resolves.toBeUndefined();
  });

  // A failure for ONE food bank must not cost the others their writes. The
  // failing message is in the MIDDLE deliberately: a handler whose try/catch
  // sat outside the loop, or which returned early, leaves remaining at 9
  // instead of 8 and only one discrepancy row instead of three.
  it("keeps processing the rest of the batch after one message's decrement fails", async () => {
    const id = seedCrawlSet({ expected: 10, remaining: 10 });
    // Only the SECOND message's decrement is unreachable, modelled by counting
    // calls rather than by matching statement text -- the SQL is identical for
    // all three.
    let calls = 0;
    const failingEnv = {
      DB: {
        withSession: (mode: string) => {
          sessionModes.push(mode);
          const inner = d1Session({}) as { prepare: (sql: string) => unknown };
          return {
            prepare: (sql: string) => {
              if (/UPDATE crawlset SET remaining/.test(sql)) {
                calls += 1;
                if (calls === 2) {
                  return {
                    bind: () => ({
                      first: async () => {
                        throw new Error("D1_ERROR: Network connection lost");
                      },
                    }),
                  };
                }
              }
              return inner.prepare(sql);
            },
            getBookmark: () => null,
          };
        },
      },
    } as unknown as Env;

    const { batch, disposals } = makeBatch([
      needcheckMessage({ crawlSetId: id, foodbankId: 1, slug: "aberdeen" }),
      needcheckMessage({ crawlSetId: id, foodbankId: 2, slug: "bath" }),
      needcheckMessage({ crawlSetId: id, foodbankId: 3, slug: "cardiff" }),
    ]);
    await handleNeedcheckRenderDlq(batch, failingEnv);

    expect(crawlSet(id)!.remaining).toBe(8);
    // All three discrepancies still landed: the failure was in the counter,
    // and the record of WHICH food banks failed is the more important of the
    // two writes to preserve.
    expect(discrepancies().map((row) => row.foodbank_id)).toEqual([1, 2, 3]);
    expect(disposals.map((d) => d.acks)).toEqual([1, 1, 1]);
  });

  // A thrown non-Error (a string, or a D1 rejection that is a plain object)
  // must not turn the catch itself into a second, uncaught failure -- the
  // catch only interpolates the message body, never the error, so it is safe,
  // and this pins that it stays so.
  it("survives a rejection that is not an Error", async () => {
    const id = seedCrawlSet({ expected: 3, remaining: 3 });

    const { batch, disposals } = makeBatch([needcheckMessage({ crawlSetId: id })]);
    await handleNeedcheckRenderDlq(batch, envFailing(/INSERT INTO foodbankdiscrepancy/, "sqlite exploded"));

    expect(disposals[0]!.acks).toBe(1);
    expect(errors[0]![1]).toBe("sqlite exploded");
    // The other write was unaffected, which is the split-catch property again.
    expect(crawlSet(id)!.remaining).toBe(2);
  });
});

// ===========================================================================
// A MESSAGE FOR A ROW THAT NO LONGER EXISTS
// ===========================================================================
describe("when the crawl set is gone", () => {
  // There is no foreign key on crawlitem.crawl_set_id or on anything else
  // pointing at crawlset (0008_needcheck.sql declares the columns with no
  // REFERENCES clause), and crawl sets are pruned independently of queue
  // retention -- so a missing crawl set is a plain no-match, not an integrity
  // error.
  it("records the discrepancy, no-ops the decrement, and acks", async () => {
    seedCrawlSet({ id: 41, remaining: 3, expected: 3 });

    const { batch, disposals } = makeBatch([needcheckMessage({ crawlSetId: 404 })]);
    await handleNeedcheckRenderDlq(batch, env);

    expect(disposals[0]!.acks).toBe(1);
    // The row is checked, not counted: this is the branch where the counter
    // write is a no-op, so the discrepancy is the ONLY output the handler
    // produces, and "there is one row" would hold for a row naming crawl set
    // 404 as the food bank just as happily.
    expect(discrepancies().map((row) => [row.foodbank_id, row.url, row.discrepancy_type])).toEqual([
      [331, "https://www.salisburyfoodbank.org.uk/", "website"],
    ]);
    expect(crawlSets().map((row) => [row.id, row.remaining])).toEqual([[41, 3]]);
    // SUSPECT, pinned rather than fixed. decrementCrawlSetRemaining returns
    // null for "no such crawl set" and for "already at zero" alike, and this
    // consumer discards the return value entirely -- so a message that could
    // not be accounted for logs NOTHING, on a handler whose success path also
    // logs nothing. Contrast the catch branches, which do log. The discrepancy
    // row is the only reason this is survivable at all. Reported in
    // suspectedBugs.
    expect(errorLines()).toEqual([]);
  });
});

// ===========================================================================
// MALFORMED MESSAGES
// ===========================================================================
describe("malformed messages", () => {
  // A null body takes the WHOLE consumer down, and the mechanism is worth
  // naming because it is not the obvious one: the discrepancy write's
  // `message.body.foodbankId` throws inside the try, and then the CATCH's own
  // template literal dereferences `message.body.foodbankId` again and throws a
  // second TypeError -- this time with nothing to catch it. The promise
  // rejects, the Workers runtime marks the invocation failed, and every
  // message the loop had not reached is redelivered. With needcheck-render-
  // dlq's `max_retries: 1` and no DLQ behind it, one more failed delivery
  // discards them silently.
  //
  // PINNED, NOT FIXED (TESTING.md's rule). Reported in suspectedBugs.
  it("throws out of the consumer when a body is null, before any ack", async () => {
    seedCrawlSet({ expected: 3, remaining: 3 });

    const { batch, disposals } = makeBatch([null]);
    await expect(handleNeedcheckRenderDlq(batch, env)).rejects.toThrow(TypeError);
    expect(disposals[0]!.acks).toBe(0);
    expect(discrepancies()).toEqual([]);
  });

  // The consequence spelled out, because "it throws" understates it: a VALID
  // message sitting behind a malformed one is never acked, never recorded and
  // never decremented, while the valid message AHEAD of it was already
  // recorded and decremented and will be again on redelivery -- so one bad
  // body produces both a lost food bank and a duplicated one.
  it("abandons the rest of the batch, having already written for the messages ahead of it", async () => {
    const id = seedCrawlSet({ expected: 10, remaining: 10 });

    const { batch, disposals } = makeBatch([
      needcheckMessage({ crawlSetId: id, foodbankId: 1, slug: "aberdeen" }),
      undefined,
      needcheckMessage({ crawlSetId: id, foodbankId: 3, slug: "cardiff" }),
    ]);
    await expect(handleNeedcheckRenderDlq(batch, env)).rejects.toThrow(TypeError);

    expect(crawlSet(id)!.remaining).toBe(9);
    expect(discrepancies().map((row) => row.foodbank_id)).toEqual([1]);
    expect(disposals.map((d) => d.acks)).toEqual([1, 0, 0]);
  });

  // A body that IS an object but lacks the fields -- a producer change, or a
  // message enqueued by an older deploy and dead-lettered days later. This one
  // does NOT take the consumer down: both catches interpolate "undefined"
  // successfully and both bind failures are caught.
  //
  // The two writes fail at the BIND, not in SQL: node:sqlite refuses an
  // `undefined` parameter with a TypeError (observed in this run -- it is what
  // produces the two log lines asserted below). D1 rejects an undefined bind
  // too, with its own error class; NOT VERIFIED here, since nothing in this
  // suite talks to D1. Either way both throw and both land in the same catch,
  // so the assertions are on the handler's behaviour -- log, ack, no
  // rejection -- and never on the exception's message text.
  it("logs twice, acks and carries on when a body is missing its fields", async () => {
    const id = seedCrawlSet({ expected: 3, remaining: 3 });

    const { batch, disposals } = makeBatch([{}, needcheckMessage({ crawlSetId: id, foodbankId: 9, slug: "york" })]);
    await expect(handleNeedcheckRenderDlq(batch, env)).resolves.toBeUndefined();

    expect(disposals.map((d) => d.acks)).toEqual([1, 1]);
    expect(errorLines()).toEqual([
      "needcheck-render-dlq: failed to record discrepancy for foodbank undefined (undefined)",
      "needcheck-render-dlq: failed to decrement crawlset remaining for foodbank undefined (undefined)",
    ]);
    // The good message behind it was fully processed.
    expect(crawlSet(id)!.remaining).toBe(2);
    expect(discrepancies().map((row) => row.foodbank_id)).toEqual([9]);
  });
});

// ===========================================================================
// IDEMPOTENCY -- Cloudflare Queues is at-least-once
// ===========================================================================
describe("redelivery", () => {
  // NOT IDEMPOTENT, and this block exists to say so rather than to wish
  // otherwise. needcheckRender.ts's own consumer is protected twice over:
  // insertCrawlItem is an upsert keyed on (crawl_set_id, foodbank_id), and
  // finishCrawlItem's `finish IS NULL` gate makes the decrement conditional on
  // this attempt actually having closed the item (needcheck.ts:104-117). This
  // DLQ consumer has NEITHER gate -- it inserts and decrements
  // unconditionally -- so the same message delivered twice writes two
  // discrepancy rows and counts down twice.
  //
  // Reachable in practice: the ack is per message and the invocation can die
  // between the writes and the ack (CPU limit, eviction), and this queue is
  // itself `max_retries: 1`.
  //
  // PINNED, NOT FIXED. Reported in suspectedBugs.
  it("writes a second discrepancy and decrements again on a redelivered message", async () => {
    const id = seedCrawlSet({ expected: 4, remaining: 3 });
    const body = needcheckMessage({ crawlSetId: id });

    await handleNeedcheckRenderDlq(makeBatch([body]).batch, env);
    expect(crawlSet(id)!.remaining).toBe(2);
    expect(discrepancies()).toHaveLength(1);

    // The same logical message, delivered a second time.
    await handleNeedcheckRenderDlq(makeBatch([body]).batch, env);
    expect(crawlSet(id)!.remaining).toBe(1);
    // Two identical rows in the queue the maintainer reads, for one food bank.
    expect(discrepancies()).toHaveLength(2);
    expect(discrepancies()[0]!.discrepancy_text).toBe(discrepancies()[1]!.discrepancy_text);
  });

  // The counter consequence, which is the mirror image of the stall this
  // consumer prevents: two food banks outstanding, only ONE accounted for, and
  // the run reads as finished. /admin/crawls/ then reports a complete sweep
  // that never happened.
  it("can stamp finish early when a redelivery consumes the last of the countdown", async () => {
    const id = seedCrawlSet({ expected: 4, remaining: 2 });
    const body = needcheckMessage({ crawlSetId: id });

    await handleNeedcheckRenderDlq(makeBatch([body]).batch, env);
    await handleNeedcheckRenderDlq(makeBatch([body]).batch, env);

    expect(crawlSet(id)!.remaining).toBe(0);
    expect(crawlSet(id)!.finish).toBe(DJANGO_NOW);
  });
});

// ===========================================================================
// LOGGING -- and the deliberate silence on the success path
// ===========================================================================
describe("logging", () => {
  // THE SUCCESS PATH LOGS NOTHING. This is a real difference from every
  // sibling DLQ in this Worker: articlesDlq.ts and charityDlq.ts both open
  // with an unconditional `console.error(... exhausted retries)` per message,
  // and this one does not, because its FoodbankDiscrepancy is the durable
  // equivalent and lands somewhere a human actually looks. Pinned so a
  // "consistency" refactor that adds the line has to come here and decide
  // deliberately -- and so the failure-path assertions above mean something,
  // since with a success line every one of them would be off by one.
  it("logs nothing at all when both writes succeed", async () => {
    const id = seedCrawlSet({ expected: 3, remaining: 3 });

    const { batch } = makeBatch([
      needcheckMessage({ crawlSetId: id, foodbankId: 1, slug: "aberdeen" }),
      needcheckMessage({ crawlSetId: id, foodbankId: 2, slug: "bath" }),
    ]);
    await handleNeedcheckRenderDlq(batch, env);

    expect(errors).toEqual([]);
  });

  // foodbankId and slug appear in the log and NOWHERE else that identifies the
  // message: `slug` is bound into no SQL at all, so on the failure path the
  // log string is the only thing distinguishing "food bank 331 was lost" from
  // "food bank 44 was lost". A transposition or a dropped field is invisible
  // to every other assertion in this file, which is why these are asserted as
  // whole strings with the error object attached.
  it("names the queue, the food bank and its slug, and attaches the underlying error", async () => {
    seedCrawlSet({ expected: 3, remaining: 3 });

    const { batch } = makeBatch([needcheckMessage({ foodbankId: 44, slug: "leeds-north-and-west" })]);
    await handleNeedcheckRenderDlq(batch, envFailing(/INSERT INTO foodbankdiscrepancy|UPDATE crawlset/));

    expect(errorLines()).toEqual([
      "needcheck-render-dlq: failed to record discrepancy for foodbank 44 (leeds-north-and-west)",
      "needcheck-render-dlq: failed to decrement crawlset remaining for foodbank 44 (leeds-north-and-west)",
    ]);
    // Without the error object the log says a write failed and not why, which
    // for a consumer with no other observable is the difference between a
    // debuggable incident and a mystery.
    expect(errors[0]).toHaveLength(2);
    expect((errors[0]![1] as Error).message).toBe("D1_ERROR: Network connection lost");
    expect(errors[1]).toHaveLength(2);
    expect((errors[1]![1] as Error).message).toBe("D1_ERROR: Network connection lost");
  });

  // The queue label is a literal in both lines, not derived from batch.queue.
  // Pinned because index.ts:50-55 records what happens when a DLQ logs the
  // wrong name -- jobs-dlq "logging its own name rather than the message that
  // failed" is exactly how those queues sat unconsumed unnoticed.
  it("labels both lines needcheck-render-dlq regardless of the batch's queue name", async () => {
    seedCrawlSet({ expected: 3, remaining: 3 });

    const { batch } = makeBatch([needcheckMessage()], "some-other-queue");
    await handleNeedcheckRenderDlq(batch, envFailing(/INSERT INTO foodbankdiscrepancy|UPDATE crawlset/));

    // Whole lines, not `.every(line => line.startsWith(...))`, which is what
    // this originally asserted: `[].every(...)` is TRUE, so the version that
    // deleted both console.error calls outright passed it. Anything that
    // checks a prefix over a list the code controls the length of is checking
    // nothing when that list comes back empty.
    expect(errorLines()).toEqual([
      "needcheck-render-dlq: failed to record discrepancy for foodbank 331 (salisbury)",
      "needcheck-render-dlq: failed to decrement crawlset remaining for foodbank 331 (salisbury)",
    ]);
  });
});

// ===========================================================================
// THE D1 SESSION AND THE SQL SURFACE
// ===========================================================================
describe("the D1 session", () => {
  // "first-unconstrained" is the mode packages/db/src/types.ts requires every
  // caller to use on this replicated database. Both statements here are
  // writes, which go to the primary regardless, but it is the convention every
  // other consumer in this Worker follows and the one the read-replication
  // note in types.ts is written against.
  it("opens one first-unconstrained session for the whole batch", async () => {
    const id = seedCrawlSet({ expected: 10, remaining: 10 });

    const { batch } = makeBatch([
      needcheckMessage({ crawlSetId: id, foodbankId: 1, slug: "aberdeen" }),
      needcheckMessage({ crawlSetId: id, foodbankId: 2, slug: "bath" }),
    ]);
    await handleNeedcheckRenderDlq(batch, env);

    // ONE session, not one per message: it is created outside the loop, which
    // is what lets the second message's statements travel on the same
    // bookmark as the first's.
    expect(sessionModes).toEqual(["first-unconstrained"]);
  });

  // Created before the loop, so an empty batch still opens one. Recorded
  // because it is a real (if cheap) behaviour and because the empty-batch test
  // above asserts the complement -- no SQL.
  it("opens the session even for an empty batch", async () => {
    const { batch } = makeBatch([]);
    await handleNeedcheckRenderDlq(batch, env);

    expect(sessionModes).toEqual(["first-unconstrained"]);
  });

  // TWO STATEMENTS PER MESSAGE, AND NO OTHERS, asserted as whole SQL strings.
  //
  // The column list is the parity claim made checkable: Django's
  // FoodbankDiscrepancy.save() denormalises foodbank_name (needs.py:43-46),
  // and migration 0019 dropped that column in favour of the
  // foodbankdiscrepancy_full view -- so a "restore Django parity" edit that
  // added it back would throw "no such column" INTO THIS HANDLER'S OWN CATCH
  // and leave no row, indistinguishable in the database from a D1 outage.
  //
  // The absence is the other half. This consumer must NOT do what
  // needcheckRender.ts's finish() does: no crawlitem close (there may be no
  // crawlitem row at all if the failure was early) and no
  // `UPDATE foodbank SET last_need_check` -- leaving that stale is what keeps
  // the food bank at the top of /admin/'s "oldest need check" stat
  // (adminDashboardStats.ts:59) instead of pretending it was checked today.
  // Neither table is in this fixture, so such a write throws and is swallowed;
  // only this log can see it.
  it("issues the discrepancy insert and the decrement, and nothing else", async () => {
    const id = seedCrawlSet({ expected: 4, remaining: 4 });

    const { batch } = makeBatch([needcheckMessage({ crawlSetId: id })]);
    await handleNeedcheckRenderDlq(batch, env);

    expect(sqlIssued()).toEqual([DISCREPANCY_INSERT, DECREMENT]);
  });

  // Three statements once the counter hits zero, with the finish stamp last --
  // a version that tried to stamp inside the decrement would have to compute
  // the new value in SQL, which is a different and unasserted thing.
  it("issues the finish stamp as a third statement on the zero transition", async () => {
    const id = seedCrawlSet({ expected: 4, remaining: 1 });

    const { batch } = makeBatch([needcheckMessage({ crawlSetId: id })]);
    await handleNeedcheckRenderDlq(batch, env);

    expect(sqlIssued()).toEqual([DISCREPANCY_INSERT, DECREMENT, STAMP_FINISH]);
  });
});

// ===========================================================================
// DISPATCH
//
// Through the REAL default export in workers/jobs/src/index.ts, not a
// hand-copied switch. The queue NAME is the wiring: `batch.queue` is the only
// thing that decides which of the fourteen handlers runs, and the strings in
// index.ts have to match wrangler.jsonc's consumer list exactly. A mismatch in
// either falls through to `default:`, which logs "unhandled queue" and
// silently drops the batch -- which is precisely how jobs-dlq and
// cache-purge-dlq sat unconsumed for weeks (index.ts:50-55). Nothing but
// running the real switch can catch that.
// ===========================================================================
describe("as the Worker's queue() dispatches it", () => {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

  it("routes needcheck-render-dlq to this handler", async () => {
    const id = seedCrawlSet({ expected: 4, remaining: 4 });
    const { batch, disposals } = makeBatch([needcheckMessage({ crawlSetId: id, foodbankId: 331, slug: "salisbury" })]);

    await jobsWorker.queue(batch as MessageBatch<unknown>, env, ctx);

    // Asserted on the rows, not on "it did not throw": mis-wiring this case to
    // handleArticlesDlq would still ack and still decrement -- and would
    // silently drop the discrepancy that is the whole point of this queue
    // having its own consumer.
    expect(discrepancies().map((row) => [row.foodbank_id, row.discrepancy_type])).toEqual([[331, "website"]]);
    expect(crawlSet(id)!.remaining).toBe(3);
    expect(disposals[0]!.acks).toBe(1);
  });

  // The negative case that makes the one above mean something. Seeded with a
  // plausible near-miss rather than nonsense -- the queue renamed in
  // wrangler.jsonc without touching index.ts is the realistic way this breaks,
  // and the batch is then dropped unacked and unrecorded with a single line.
  it("drops a batch whose queue name is not in the switch, without acking or recording it", async () => {
    const id = seedCrawlSet({ expected: 4, remaining: 4 });
    const { batch, disposals } = makeBatch([needcheckMessage({ crawlSetId: id })], "needcheck-render-dl");

    await jobsWorker.queue(batch as MessageBatch<unknown>, env, ctx);

    expect(discrepancies()).toEqual([]);
    expect(crawlSet(id)!.remaining).toBe(4);
    expect(disposals[0]!.acks).toBe(0);
    expect(errorLines()).toEqual(['givefood2-jobs: unhandled queue "needcheck-render-dl"']);
  });
});
