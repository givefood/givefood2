import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import type { Env } from "../../worker-configuration";
import { handleArticlesDlq } from "./articlesDlq";
import type { ArticlesMessage } from "./articles";
// @ts-ignore -- this Worker's tsconfig lists only @cloudflare/workers-types, so
// node:sqlite has no declarations here. It is real under vitest's node
// environment, and adding "node" to workers/jobs/tsconfig.json would be a
// config change rather than a test change. Same suppression, same reasoning,
// as packages/db/src/schema.testkit.ts:35 and adminJobs/foodbankCheck.test.ts:6.
import { DatabaseSync } from "node:sqlite";

// queues/articlesDlq.ts -- the articles-dlq consumer. A message reaches it
// only after exhausting articles' max_retries (3, wrangler.jsonc), and
// articles-dlq is itself the end of the line: `max_retries: 1` with NO
// dead_letter_queue behind it, so anything this handler drops is gone for
// good behind at most a console line.
//
// WHY THIS FILE IS WORTH THE LENGTH. Nothing watches a dead-letter queue.
// This handler makes exactly one durable write -- one decrement of
// `crawlset.remaining` -- and that write is the entire reason the consumer
// exists: the module's own header says so, and needcheckRenderDlq.ts:33-37
// says the same thing at more length. Every OTHER exit from the articles
// pipeline decrements (articles.ts:93, via finishCrawlItem), so a food bank
// whose feed crawl fails permanently is the one case where the countdown can
// stall. A stalled countdown is silent in a specific and nasty way: the
// CrawlSet's `finish` is never stamped, /admin/crawls/ shows the run as still
// in progress for ever, and nothing throws, logs, alerts or 500s. That is
// exactly the shape of the incident this tier exists for.
//
// So the tests below read `crawlset` BACK after the call. Asserting that
// handleArticlesDlq resolved would pass against a handler whose body is
// `for (const m of batch.messages) m.ack()`, which is a real and tempting
// mutant -- it is what an "it already logged, that's enough" simplification
// looks like, and it loses the only write this consumer makes.
//
// PARITY WITH DJANGO: the module claims "Articles has no FoodbankDiscrepancy
// concept in Django at all (crawlers.py never writes one for this job)".
// VERIFIED by reading /Users/jasoncartwright/Sites/foodcharity/givefood/utils/
// crawlers.py: `foodbank_article_crawl` (lines 25-67 -- re-checked in review,
// `def` on 25 and `return True` on 67) opens a CrawlItem, parses the feed,
// saves the food bank and stamps `crawl_item.finish` -- and the file's only
// two FoodbankDiscrepancy constructions (lines 312 and 490; line 283 is the
// import that brings the model into scope, corrected in review from an
// earlier comment here that counted it as a third write) are inside the NEED
// crawler, not this one. So the absence of a discrepancy write here is a
// deliberate port of Django's own silence, not an omission, and the test
// named for it below pins that the DLQ writes nothing but the counter.
//
// The `remaining` counter itself has no Django counterpart at all (grepped:
// `remaining` appears nowhere in the Django models package), which is why
// there is no Django behaviour to compare the decrement against -- it is the
// port's own bookkeeping for a fan-out Django did serially. Stated rather
// than left implied, so nobody goes looking for the Django line this test
// "should" cite.
//
// REAL THINGS, NOT MOCKS. The database is node:sqlite carrying the REAL
// `crawlset` DDL via schemaFor (schema.testkit.ts), and the decrement is the
// real decrementCrawlSetRemaining from @givefood/db reached through the real
// import -- not a stub. A session handing back canned rows would agree with
// any SQL at all, including SQL that had lost its `remaining > 0` guard or
// stopped stamping `finish`, and those are precisely the failures that leave
// a plausible-looking database behind.
//
// schemaFor("crawlset"), not MIGRATIONS_SQL, on purpose: this consumer's
// entire D1 surface is one table, and a fixture that names it makes that a
// checked claim rather than a comment. If decrementCrawlSetRemaining ever
// grows a read of a second object, this suite fails loudly with "no such
// table" -- which is the github #51 outcome the testkit was extracted to
// produce, and better than a fixture broad enough to hide the change.
//
// MOCKED, and only this: nothing. This handler makes no network call, sends
// no queue message, touches no KV or R2. `console.error` is spied on rather
// than mocked away, because for the failure paths it is the ONLY observable
// the production system has.
//
// MUTATION-TESTED (TESTING.md's convention: the evidence a test is
// load-bearing rather than decoration). The repo was rsync'd to a scratchpad
// outside it -- no file in the repo was edited at any point -- and 26 mutants
// were injected across articlesDlq.ts and the decrementCrawlSetRemaining it
// calls, then this file re-run against each. All 26 are now killed: the
// decrement deleted, hoisted out of the loop, and given foodbankId as its
// crawl set; the session opened per message and opened in the wrong
// consistency mode; the ack deleted, turned into a retry, replaced by
// batch.ackAll(), and MOVED AHEAD OF THE WRITE; the log line's two fields
// transposed, its slug dropped, and its queue label taken from batch.queue;
// the try/catch deleted, its log silenced, its error argument dropped, and a
// `return` added so one failure abandons the batch; a FoodbankDiscrepancy
// write bolted on; and in packages/db, the `remaining > 0` guard dropped, the
// subtraction inverted, `expected` dragged down with `remaining`, `finish`
// never stamped, stamped every time, stamped one item early, stamped with
// toISOString(), stamped with its binds transposed, and the crawl set id
// replaced by a literal 1.
//
// ONE SURVIVED THE FIRST PASS and is the reason the `events` log below exists
// rather than three independent counters: `message.ack()` moved from after the
// decrement to before it. It still acks exactly once, still writes exactly one
// row, and every count-based and row-based assertion in the draft passed. See
// that variable's own comment for why the ordering is a real property and not
// a stylistic one.
//
// ---------------------------------------------------------------------------
// ADVERSARIAL REVIEW PASS, 2026-09-08. The suite above was re-mutation-tested
// from scratch in a fresh rsync of the repo into the scratchpad, and the first
// finding was about the HARNESS rather than the tests: linking the copy's
// node_modules straight at the real tree makes `@givefood/db` resolve OUT of
// the copy, so every mutant of decrementCrawlSetRemaining runs against
// unmutated source and is scored "survived" by a suite that never saw it.
// Anyone repeating this must copy the per-package node_modules symlink farms
// (they are relative, and re-point themselves at the copy) and link only the
// root. Re-run that way, the packages/db mutants genuinely die.
//
// The final pass ran 57 mutants against this file as it now stands: 38 in
// articlesDlq.ts and 19 in the decrementCrawlSetRemaining it calls. 56 die.
// TWO had survived before the edits below, and both are addressed:
//
//  1. The catch branch's identity taken from `batch.messages[0].body` instead
//     of `message.body`. Every failure-path assertion in the draft used a
//     one-message batch, so the two spellings produced identical strings.
//     Closed by the log assertion added to "keeps decrementing the rest of the
//     batch after one message's write fails", which is the only test whose
//     failing message is not index 0.
//
//  2. `await` dropped from the `finish` stamp inside decrementCrawlSetRemaining
//     (packages/db) -- a floating write, which the Workers runtime may cancel
//     when the invocation ends. It survived here AND against
//     packages/db/src/needcheck.test.ts's own 76 tests, because node:sqlite
//     writes synchronously: an unawaited promise still lands before the
//     assertion reads the row. Closed by making the session double's
//     statements resolve on a MACROTASK (see d1Session), which is what a D1
//     round trip actually is; an unawaited write now has not happened when the
//     handler returns, which is the truth on the real platform.
//
// Mutants confirmed killed in this pass, beyond the list above: the whole
// batch run through Promise.all; the body wrapped in an outer try/catch (which
// would "fix" the malformed-message crash and is pinned against); the ack made
// conditional on the write succeeding, with a retry on failure; the decrement
// skipped for `attempts > 1`; the decrement narrowed by an ADDED predicate
// (`crawl_type = 'need'`, `finish IS NULL`); `remaining > 0` loosened to
// `>= 0`; `RETURNING remaining` reduced to `RETURNING id`; `.first()` swapped
// for `.run()` so the zero transition is never seen; `.bind()` dropped from the
// decrement; the decrement's arguments transposed; console.error downgraded to
// console.log and to console.warn; the loop reversed; the ack duplicated; the
// log's wording reworded; and `finish` stamped from `toISOString().replace()`,
// which is space-separated and still wrong (three fractional digits, not six).
//
// THE ONE STILL UNKILLED, deliberately: `if (!row) return null` changed to
// `return 0` in decrementCrawlSetRemaining. This consumer discards the return
// value entirely, so no test here can see it -- that is the suspected bug
// recorded at "no-ops and acks rather than erroring" below, not a gap in these
// tests. packages/db/src/needcheck.test.ts owns that assertion and makes it.

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
 * WHY A SINGLE INTERLEAVED LOG rather than three separate counters. The three
 * things this handler does per message have an ORDER that matters and that no
 * count can see. Acking before the decrement, rather than after, still acks
 * exactly once and still writes exactly one row, so every other assertion in
 * this file passes -- but it tells the queue the message is consumed before the
 * write that consuming it was for, and an invocation that dies in that window
 * loses the decrement with no message left to redeliver. That mutant survived
 * the first mutation pass on this file; this is what kills it.
 */
let events: string[];

/**
 * The D1 Sessions API surface packages/db uses, over the real engine -- the
 * same adapter shape as adminJobs/foodbankCheck.test.ts's, plus a log of the
 * SQL prepared.
 *
 * THE LOG IS NOT DECORATION. "The DLQ writes nothing but the counter" is a
 * claim about the statements ISSUED, not only about the rows left behind: an
 * INSERT into a table this fixture does not have would throw and be swallowed
 * by the handler's own catch, leaving a snapshot identical to a handler that
 * never tried. The log sees the attempt; a row count cannot.
 *
 * `first()` answers null, never undefined -- decrementCrawlSetRemaining's
 * `if (!row) return null` happens to treat them alike, but D1 returns null and
 * a double that returned undefined would be modelling a different API.
 */
function d1Session(hooks: { failOn?: RegExp; failWith?: unknown }): unknown {
  function statement(sql: string, params: Bindable[]): unknown {
    const guard = (): void => {
      // The default is D1's real message for a lost connection mid-statement,
      // which is the failure this handler's inner try/catch was written for.
      if (hooks.failOn?.test(sql)) throw hooks.failWith ?? new Error("D1_ERROR: Network connection lost");
    };
    // EVERY STATEMENT COSTS A MACROTASK, not a microtask. D1 is a network
    // round trip: a `.run()` whose promise is never awaited has NOT touched
    // the database by the time the handler returns, and the Workers runtime
    // is free to cancel it when the invocation ends -- the floating-write bug
    // class. node:sqlite writes synchronously, so a double that resolved on a
    // microtask would let an unawaited write land anyway and report a green
    // suite; ADDED IN REVIEW because it does, see the survivor noted at the
    // top of this file.
    const roundTrip = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    return {
      bind: (...values: unknown[]) => statement(sql, values as Bindable[]),
      first: async <T>() => {
        await roundTrip();
        guard();
        return (db.prepare(sql).get(...params) ?? null) as T | null;
      },
      all: async <T>() => {
        await roundTrip();
        guard();
        return { results: db.prepare(sql).all(...params) as T[] };
      },
      run: async () => {
        await roundTrip();
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
      // in full, so a write this consumer grows later shows up as itself rather
      // than as a prefix that happens to match.
      const label = /SET remaining = remaining - 1/.test(sql) ? "decrement" : /SET finish =/.test(sql) ? "stamp-finish" : sql;
      events.push(`sql:${label}`);
      return statement(sql, []);
    },
    getBookmark: () => null,
  };
}

/** What one message in the batch recorded about how the handler disposed of it. */
interface Disposal {
  acks: number;
  /** One entry per retry() call, holding whatever options were passed. */
  retries: unknown[];
}

interface FakeBatch {
  batch: MessageBatch<ArticlesMessage>;
  /** Parallel to the message bodies handed to makeBatch. */
  disposals: Disposal[];
  /** Counts for the batch-wide escape hatches, which this handler must never use. */
  batchWide: { ackAll: number; retryAll: number };
}

/**
 * A MessageBatch double.
 *
 * `retryAll`/`ackAll` are present and counted, not omitted: a handler that
 * called `batch.ackAll()` once instead of acking per message would leave every
 * per-message counter at zero, and without these the failure would read as a
 * missing method rather than as the behaviour change it is. Likewise every
 * message carries a real `retry`, so "this consumer never retries" is measured
 * rather than assumed from the absence of a call site.
 *
 * `attempts: 2` because a message only reaches a dead-letter queue after the
 * source queue exhausted its own retries; a `1` here would be a shape no real
 * delivery has.
 */
function makeBatch(bodies: unknown[], queue = "articles-dlq"): FakeBatch {
  const disposals: Disposal[] = [];
  const batchWide = { ackAll: 0, retryAll: 0 };
  const messages = bodies.map((body, index) => {
    const disposal: Disposal = { acks: 0, retries: [] };
    disposals.push(disposal);
    return {
      id: `msg-${index + 1}`,
      timestamp: new Date("2026-09-05T19:20:00.000Z"),
      attempts: 2,
      body: body as ArticlesMessage,
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
  } as unknown as MessageBatch<ArticlesMessage>;
  return { batch, disposals, batchWide };
}

/** The body shape articles.ts publishes (ArticlesMessage), with test defaults. */
function articlesMessage(over: Partial<ArticlesMessage> = {}): ArticlesMessage {
  return { crawlSetId: 1, foodbankId: 22, slug: "salisbury", ...over };
}

// ===========================================================================
// FIXTURES
// ===========================================================================

// The spelling Django and the ETL write into these TEXT columns: a SPACE
// separator, six fractional digits, never a "T" and never a "Z". SQLite
// compares TEXT bytewise, so this is not cosmetic -- see
// packages/models/src/pyDatetime.ts's header for the two production incidents
// that came of writing toISOString() into a column shaped like this.
const NOW = new Date("2026-09-05T19:28:08.853Z");
const DJANGO_NOW = "2026-09-05 19:28:08.853000";

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
 * One crawl set, as the getarticles cron writes it: insertCrawlSet stamps
 * crawl_type/run_id/start, then setCrawlSetExpected sets expected = remaining
 * = the number of food banks enqueued. `start` is an EARLIER Django-format
 * timestamp than NOW so the finish-stamp tests compare two real values -- the
 * 18:20 slot of `20 8-22/2 * * *` (wrangler.jsonc), dead-lettered at 19:28
 * after the source queue burned its three retries.
 */
function seedCrawlSet(over: Partial<CrawlSetRow> = {}): number {
  const row: CrawlSetRow = {
    id: 1,
    crawl_type: "article",
    run_id: "getarticles-2026-09-05-18",
    start: "2026-09-05 18:20:04.109000",
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

/** Every console.error call, as [firstArg, ...rest]. */
let errors: unknown[][];

/** Just the message strings, which is what the log line's format is asserted on. */
function errorLines(): string[] {
  return errors.map((args) => String(args[0]));
}

let env: Env;

beforeEach(() => {
  // Date only: this handler has no timers, and faking setTimeout would be
  // faking something nothing under test uses. Frozen so `finish` has one
  // predictable value rather than a regex-shaped assertion.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);

  db = new DatabaseSync(":memory:") as unknown as SqliteDatabase;
  db.exec(schemaFor("crawlset"));

  sessionModes = [];
  preparedSql = [];
  errors = [];
  events = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args);
    events.push(`log:${String(args[0]).replace(/^articles-dlq: /, "")}`);
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
// THE COUNTER -- the only durable thing this consumer does
// ===========================================================================
describe("the crawlset countdown", () => {
  // The whole reason the consumer exists. A handler reduced to `m.ack()` --
  // the tempting "it already logged, what else is there" simplification --
  // passes every assertion about acking and logging and fails only here.
  it("decrements remaining for the crawl set named in the message body", async () => {
    const id = seedCrawlSet({ expected: 3, remaining: 3 });

    const { batch } = makeBatch([articlesMessage({ crawlSetId: id })]);
    await handleArticlesDlq(batch, env);

    expect(crawlSet(id)!.remaining).toBe(2);
    // `expected` is the run's denominator on /admin/crawls/ and must survive
    // untouched: a decrement that moved both would make every run read 100%
    // complete regardless of how many food banks actually failed.
    expect(crawlSet(id)!.expected).toBe(3);
  });

  // Kills the mutant that decrements a hardcoded crawl set, or the first row,
  // or ignores the bind entirely -- invisible while only one crawl set exists,
  // and the getarticles cron runs 8 times a day (20 8-22/2 * * *,
  // wrangler.jsonc), so several sets are open on any given day.
  it("touches only the crawl set named, leaving other open sets alone", async () => {
    seedCrawlSet({ id: 41, run_id: "getarticles-2026-09-05-18", remaining: 5, expected: 5 });
    seedCrawlSet({ id: 42, run_id: "getarticles-2026-09-05-20", remaining: 7, expected: 7 });
    seedCrawlSet({ id: 43, run_id: "needcheck-2026-09-05", crawl_type: "need", remaining: 9, expected: 9 });

    const { batch } = makeBatch([articlesMessage({ crawlSetId: 42 })]);
    await handleArticlesDlq(batch, env);

    expect(crawlSets().map((row) => [row.id, row.remaining])).toEqual([
      [41, 5],
      [42, 6],
      [43, 9],
    ]);
  });

  // One decrement PER MESSAGE, not one per batch. articles-dlq's
  // max_batch_size is 10 (wrangler.jsonc), so a batch of several failures for
  // the SAME crawl set is the normal case on a bad night, not an edge case --
  // a handler that decremented once outside the loop would leave the counter
  // stuck at 7 with the run permanently unfinished.
  it("decrements once per message when several messages share a crawl set", async () => {
    const id = seedCrawlSet({ expected: 10, remaining: 10 });

    const { batch } = makeBatch([
      articlesMessage({ crawlSetId: id, foodbankId: 1, slug: "aberdeen" }),
      articlesMessage({ crawlSetId: id, foodbankId: 2, slug: "bath" }),
      articlesMessage({ crawlSetId: id, foodbankId: 3, slug: "cardiff" }),
    ]);
    await handleArticlesDlq(batch, env);

    expect(crawlSet(id)!.remaining).toBe(7);
  });

  it("decrements each named set independently when one batch spans several", async () => {
    seedCrawlSet({ id: 41, run_id: "a", remaining: 4, expected: 4 });
    seedCrawlSet({ id: 42, run_id: "b", remaining: 4, expected: 4 });

    const { batch } = makeBatch([
      articlesMessage({ crawlSetId: 41, foodbankId: 1, slug: "aberdeen" }),
      articlesMessage({ crawlSetId: 42, foodbankId: 2, slug: "bath" }),
      articlesMessage({ crawlSetId: 42, foodbankId: 3, slug: "cardiff" }),
    ]);
    await handleArticlesDlq(batch, env);

    expect(crawlSets().map((row) => [row.id, row.remaining])).toEqual([
      [41, 3],
      [42, 2],
    ]);
  });

  it("makes no write at all for an empty batch", async () => {
    const id = seedCrawlSet({ remaining: 3 });

    const { batch } = makeBatch([]);
    await handleArticlesDlq(batch, env);

    expect(crawlSet(id)!.remaining).toBe(3);
    expect(preparedSql).toEqual([]);
    expect(errorLines()).toEqual([]);
  });
});

// ===========================================================================
// FINISHING THE RUN -- what the counter reaching zero is FOR
// ===========================================================================
describe("stamping crawlset.finish", () => {
  // The payoff. decrementCrawlSetRemaining stamps `finish` itself the moment
  // remaining hits 0 (needcheck.ts:73-75), and a DLQ'd food bank is often the
  // LAST one outstanding -- it is by definition the slowest, having burned
  // three retries first. If this consumer did not decrement, this stamp would
  // never happen and /admin/crawls/ would show the run as still running for
  // ever.
  it("stamps finish when the dead-lettered food bank is the last one outstanding", async () => {
    const id = seedCrawlSet({ expected: 4, remaining: 1 });

    const { batch } = makeBatch([articlesMessage({ crawlSetId: id })]);
    await handleArticlesDlq(batch, env);

    expect(crawlSet(id)!.remaining).toBe(0);
    expect(crawlSet(id)!.finish).toBe(DJANGO_NOW);
  });

  // ONE stamp for the batch, from the message that actually took the counter
  // to zero -- not one per message and not one at the top. ADDED IN REVIEW:
  // every other stamp test sends a single message, so nothing pinned what a
  // batch that consumes the whole remaining countdown does -- and with
  // articles-dlq's max_batch_size of 10 (wrangler.jsonc), the last few
  // stragglers of a run arriving together is an ordinary delivery, not a
  // contrived one. The interleaving is asserted, not just the row: a stamp
  // issued before the last decrement would leave the same final row behind.
  it("stamps finish exactly once when one batch consumes the whole countdown", async () => {
    const id = seedCrawlSet({ expected: 3, remaining: 3 });

    const { batch } = makeBatch([
      articlesMessage({ crawlSetId: id, foodbankId: 1, slug: "aberdeen" }),
      articlesMessage({ crawlSetId: id, foodbankId: 2, slug: "bath" }),
      articlesMessage({ crawlSetId: id, foodbankId: 3, slug: "cardiff" }),
    ]);
    await handleArticlesDlq(batch, env);

    expect(crawlSet(id)!.remaining).toBe(0);
    expect(crawlSet(id)!.finish).toBe(DJANGO_NOW);
    expect(preparedSql).toEqual([
      "UPDATE crawlset SET remaining = remaining - 1 WHERE id = ?1 AND remaining > 0 RETURNING remaining",
      "UPDATE crawlset SET remaining = remaining - 1 WHERE id = ?1 AND remaining > 0 RETURNING remaining",
      "UPDATE crawlset SET remaining = remaining - 1 WHERE id = ?1 AND remaining > 0 RETURNING remaining",
      "UPDATE crawlset SET finish = ?1 WHERE id = ?2",
    ]);
    expect(events).toEqual([
      "log:foodbank 1 (aberdeen) exhausted retries",
      "sql:decrement",
      "ack:msg-1",
      "log:foodbank 2 (bath) exhausted retries",
      "sql:decrement",
      "ack:msg-2",
      "log:foodbank 3 (cardiff) exhausted retries",
      "sql:decrement",
      "sql:stamp-finish",
      "ack:msg-3",
    ]);
  });

  // Ticket #9, at the one write this consumer can reach. `finish` is TEXT and
  // /admin/crawls/ computes "time taken" by comparing it against `start`; a
  // toISOString() value would sort before every same-day Django `start`
  // ("2026-09-05T..." vs "2026-09-05 ..." -- 'T' is 0x54, ' ' is 0x20, so ISO
  // sorts AFTER, and a mixed column makes ORDER BY meaningless). Asserted as a
  // property of the stored string, not just as equality above, because that is
  // the form the bug actually takes.
  it("writes finish in Django's format, not toISOString's", async () => {
    const id = seedCrawlSet({ expected: 1, remaining: 1, start: "2026-09-05 18:20:04.109000" });

    const { batch } = makeBatch([articlesMessage({ crawlSetId: id })]);
    await handleArticlesDlq(batch, env);

    const finish = crawlSet(id)!.finish!;
    expect(finish).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
    expect(finish).not.toContain("T");
    expect(finish).not.toContain("Z");
    // The comparison /admin/crawls/ actually makes for "time taken", run by
    // the same engine on the same TEXT columns. `finish > start` must hold.
    const ordered = db.prepare("SELECT finish > start AS after FROM crawlset WHERE id = ?").get(id) as unknown as { after: number };
    expect(ordered.after).toBe(1);
    // And the demonstration of WHY the format matters: the ISO spelling of the
    // very same instant sorts AFTER an evening Django value it precedes by
    // more than three hours, because 'T' (0x54) beats ' ' (0x20).
    const iso = db.prepare("SELECT ? > ? AS after").get(NOW.toISOString(), "2026-09-05 22:20:04.109000") as unknown as { after: number };
    expect(iso.after).toBe(1);
  });

  // The stamp is at EXACTLY zero, not at "one left". A run stamped finished
  // while a food bank is still being crawled is worse than one never stamped:
  // it looks correct.
  it("does not stamp finish while other food banks are still outstanding", async () => {
    const id = seedCrawlSet({ expected: 4, remaining: 2 });

    const { batch } = makeBatch([articlesMessage({ crawlSetId: id })]);
    await handleArticlesDlq(batch, env);

    expect(crawlSet(id)!.remaining).toBe(1);
    expect(crawlSet(id)!.finish).toBeNull();
  });

  // The floor. Without decrementCrawlSetRemaining's `remaining > 0` guard an
  // extra delivery would drive the counter negative and `=== 0` would never
  // match again -- the run would be unfinishable. This consumer is the most
  // likely source of that extra delivery (see the redelivery test below), so
  // the guard is asserted from here as well as from packages/db.
  it("leaves an already-finished crawl set untouched rather than going negative", async () => {
    const id = seedCrawlSet({ expected: 4, remaining: 0, finish: "2026-09-05 18:41:00.000000" });

    const { batch, disposals } = makeBatch([articlesMessage({ crawlSetId: id })]);
    await handleArticlesDlq(batch, env);

    expect(crawlSet(id)!.remaining).toBe(0);
    // The original finish stands: no re-stamp with NOW, which would silently
    // rewrite how long the run took.
    expect(crawlSet(id)!.finish).toBe("2026-09-05 18:41:00.000000");
    expect(disposals[0]!.acks).toBe(1);
  });
});

// ===========================================================================
// DISPOSAL -- ack, retry, and what the queue config makes of each
// ===========================================================================
describe("message disposal", () => {
  it("acks each message exactly once", async () => {
    const id = seedCrawlSet({ expected: 3, remaining: 3 });

    const { batch, disposals, batchWide } = makeBatch([
      articlesMessage({ crawlSetId: id, foodbankId: 1, slug: "aberdeen" }),
      articlesMessage({ crawlSetId: id, foodbankId: 2, slug: "bath" }),
    ]);
    await handleArticlesDlq(batch, env);

    expect(disposals.map((d) => d.acks)).toEqual([1, 1]);
    // Per message, not batch-wide: ackAll() would look identical from the
    // queue's side today but would also ack a message the loop had not
    // reached, which is how a partial batch silently loses work.
    expect(batchWide).toEqual({ ackAll: 0, retryAll: 0 });
  });

  // ORDER, not just count. An ack tells the queue the message is consumed, so
  // it must come AFTER the write it was consumed for: an invocation evicted
  // between an early ack and the decrement loses the decrement with no message
  // left to redeliver it, which is the permanent stall this consumer exists to
  // prevent, arrived at by a different road. Nothing else in this file can see
  // that -- an early ack still acks exactly once and still writes exactly one
  // row -- and it survived the first mutation pass on this module.
  //
  // The interleaving also pins that the three steps are per message rather than
  // three passes over the batch: all-decrements-then-all-acks would read
  // sql,sql,ack,ack here.
  it("logs, then writes, then acks -- in that order, per message", async () => {
    const id = seedCrawlSet({ expected: 10, remaining: 10 });

    const { batch } = makeBatch([
      articlesMessage({ crawlSetId: id, foodbankId: 1, slug: "aberdeen" }),
      articlesMessage({ crawlSetId: id, foodbankId: 2, slug: "bath" }),
    ]);
    await handleArticlesDlq(batch, env);

    expect(events).toEqual([
      "log:foodbank 1 (aberdeen) exhausted retries",
      "sql:decrement",
      "ack:msg-1",
      "log:foodbank 2 (bath) exhausted retries",
      "sql:decrement",
      "ack:msg-2",
    ]);
  });

  // Same ordering claim on the failure path: the error is logged before the
  // ack, so the trace is on disk before the message stops existing.
  it("logs the failure before acking it away", async () => {
    seedCrawlSet({ expected: 3, remaining: 3 });

    const { batch } = makeBatch([articlesMessage({ foodbankId: 1, slug: "aberdeen" })]);
    await handleArticlesDlq(batch, envFailing(/UPDATE crawlset/));

    expect(events).toEqual([
      "log:foodbank 1 (aberdeen) exhausted retries",
      "sql:decrement",
      "log:failed to decrement crawlset remaining for foodbank 1 (aberdeen)",
      "ack:msg-1",
    ]);
  });

  // articles-dlq is `max_retries: 1` with NO dead_letter_queue behind it
  // (wrangler.jsonc), so a retry here buys one more attempt and then silent
  // discard -- and if D1 itself is the thing failing, retrying is an infinite
  // loop against a broken dependency. needcheckRenderDlq.ts:42-45 states that
  // reasoning explicitly for the sibling queue; this consumer follows it.
  it("never retries, even when the decrement fails", async () => {
    seedCrawlSet({ expected: 3, remaining: 3 });

    const { batch, disposals } = makeBatch([articlesMessage()]);
    await handleArticlesDlq(batch, envFailing(/UPDATE crawlset/));

    expect(disposals[0]!.retries).toEqual([]);
    expect(disposals[0]!.acks).toBe(1);
  });
});

// ===========================================================================
// A DOWNSTREAM FAILURE -- D1 erroring underneath the decrement
// ===========================================================================
describe("when D1 fails", () => {
  it("acks anyway, so a D1 blip cannot wedge the queue", async () => {
    const id = seedCrawlSet({ expected: 3, remaining: 3 });

    const { batch, disposals } = makeBatch([articlesMessage({ crawlSetId: id })]);
    await handleArticlesDlq(batch, envFailing(/UPDATE crawlset/));

    expect(disposals[0]!.acks).toBe(1);
    // Nothing was written: the counter is still stuck, which is the cost of
    // that ack and is why the log line below is the only trace left.
    expect(crawlSet(id)!.remaining).toBe(3);
  });

  // The handler resolves rather than rejecting. If it threw, the whole batch
  // would be redelivered -- including messages already acked and already
  // decremented, double-counting the counter it exists to protect.
  it("resolves rather than propagating the error out of the consumer", async () => {
    seedCrawlSet({ expected: 3, remaining: 3 });

    const { batch } = makeBatch([articlesMessage()]);
    await expect(handleArticlesDlq(batch, envFailing(/UPDATE crawlset/))).resolves.toBeUndefined();
  });

  // A failure for ONE food bank must not cost the others their decrement.
  // Seeding all three against the same crawl set is deliberate: the failing
  // one is in the MIDDLE, so a handler whose try/catch sat outside the loop
  // (or which returned early) leaves remaining at 9 instead of 8.
  it("keeps decrementing the rest of the batch after one message's write fails", async () => {
    const id = seedCrawlSet({ expected: 10, remaining: 10 });
    // Only the second message's crawl set is unreachable, modelled by failing
    // on the bind value rather than the statement text -- the SQL is identical
    // for all three.
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
      articlesMessage({ crawlSetId: id, foodbankId: 1, slug: "aberdeen" }),
      articlesMessage({ crawlSetId: id, foodbankId: 2, slug: "bath" }),
      articlesMessage({ crawlSetId: id, foodbankId: 3, slug: "cardiff" }),
    ]);
    await handleArticlesDlq(batch, failingEnv);

    expect(crawlSet(id)!.remaining).toBe(8);
    expect(disposals.map((d) => d.acks)).toEqual([1, 1, 1]);
    // AND THE FAILURE LINE NAMES THE MESSAGE THAT FAILED, not the first one in
    // the batch. ADDED IN REVIEW: a mutant that read the catch's identity from
    // `batch.messages[0].body` instead of `message.body` survived the whole
    // original suite, because every other failure test sends a ONE-message
    // batch (or fails message 0), where the two are the same string. This is
    // the only test where the failing message is not index 0, and
    // articles-dlq's max_batch_size is 10, so a real bad night is a batch of
    // ten -- with the wrong name logged, the one observable this consumer has
    // would blame aberdeen for bath's stuck counter, and there is nothing else
    // anywhere to contradict it.
    expect(errorLines()).toEqual([
      "articles-dlq: foodbank 1 (aberdeen) exhausted retries",
      "articles-dlq: foodbank 2 (bath) exhausted retries",
      "articles-dlq: failed to decrement crawlset remaining for foodbank 2 (bath)",
      "articles-dlq: foodbank 3 (cardiff) exhausted retries",
    ]);
  });

  // A thrown non-Error (a string, a D1 rejection that is a plain object) must
  // not turn the catch itself into a second, uncaught failure.
  it("survives a rejection that is not an Error", async () => {
    const id = seedCrawlSet({ expected: 3, remaining: 3 });

    const { batch, disposals } = makeBatch([articlesMessage({ crawlSetId: id })]);
    await handleArticlesDlq(batch, envFailing(/UPDATE crawlset/, "sqlite exploded"));

    expect(disposals[0]!.acks).toBe(1);
    expect(errors[1]![1]).toBe("sqlite exploded");
  });
});

// ===========================================================================
// A MESSAGE FOR A ROW THAT NO LONGER EXISTS
// ===========================================================================
describe("when the crawl set is gone", () => {
  // crawlitem rows are pruned by a nightly cron and crawl sets outlive the
  // messages that reference them only by convention -- there is no FK on
  // crawlitem.crawl_set_id (0008_needcheck.sql declares the column with no
  // REFERENCES clause), so a missing crawl set is a plain no-match, not an
  // integrity error.
  it("no-ops and acks rather than erroring", async () => {
    seedCrawlSet({ id: 41, remaining: 3, expected: 3 });

    const { batch, disposals } = makeBatch([articlesMessage({ crawlSetId: 404 })]);
    await handleArticlesDlq(batch, env);

    expect(disposals[0]!.acks).toBe(1);
    expect(crawlSets().map((row) => [row.id, row.remaining])).toEqual([[41, 3]]);
    // SUSPECT, pinned rather than fixed: decrementCrawlSetRemaining returns
    // null for "no such crawl set" and for "already at zero" alike, and this
    // consumer discards the return value entirely. So the one case a DLQ
    // exists to make visible -- a message that could not be accounted for --
    // logs nothing beyond the generic "exhausted retries" line every message
    // gets. Contrast the catch branch, which does log. Reported in
    // suspectedBugs.
    expect(errorLines()).toEqual(["articles-dlq: foodbank 22 (salisbury) exhausted retries"]);
  });
});

// ===========================================================================
// MALFORMED MESSAGES
// ===========================================================================
describe("malformed messages", () => {
  // The log line dereferences message.body BEFORE the try block, so a body
  // that is not an object takes the whole consumer down: the promise rejects,
  // the Workers runtime marks the invocation failed, and every message the
  // loop had not yet reached is redelivered. With articles-dlq's
  // `max_retries: 1` and no DLQ behind it, one more failed delivery discards
  // them silently.
  //
  // PINNED, NOT FIXED (TESTING.md's rule). Reported in suspectedBugs.
  it("throws out of the consumer when a body is null, before any ack", async () => {
    seedCrawlSet({ expected: 3, remaining: 3 });

    const { batch, disposals } = makeBatch([null]);
    await expect(handleArticlesDlq(batch, env)).rejects.toThrow(TypeError);
    expect(disposals[0]!.acks).toBe(0);
  });

  // The consequence spelled out, because "it throws" understates it: a VALID
  // message sitting behind a malformed one in the same batch is never acked
  // and never decremented, while the valid message AHEAD of it was already
  // decremented and will be decremented again on redelivery.
  it("abandons the rest of the batch, having already decremented the messages ahead of it", async () => {
    const id = seedCrawlSet({ expected: 10, remaining: 10 });

    const { batch, disposals } = makeBatch([
      articlesMessage({ crawlSetId: id, foodbankId: 1, slug: "aberdeen" }),
      undefined,
      articlesMessage({ crawlSetId: id, foodbankId: 3, slug: "cardiff" }),
    ]);
    await expect(handleArticlesDlq(batch, env)).rejects.toThrow(TypeError);

    expect(crawlSet(id)!.remaining).toBe(9);
    expect(disposals.map((d) => d.acks)).toEqual([1, 0, 0]);
  });

  // A body that IS an object but lacks the fields -- a producer change, or a
  // message enqueued by an older deploy. This one does NOT take the consumer
  // down: the log interpolates "undefined" and the decrement's bind failure is
  // caught by the handler's own try/catch.
  //
  // The engines disagree on the exception, and that disagreement is stated
  // rather than hidden: node:sqlite throws `TypeError: Provided value cannot
  // be bound to SQLite parameter 1.` (measured in this scratchpad, 2026-09-08)
  // where D1 raises a D1_TYPE_ERROR. Both throw, both land in the same catch,
  // so the assertions below are on the handler's behaviour -- log, ack, no
  // rejection -- and never on the message text.
  it("logs, acks and carries on when a body is missing its fields", async () => {
    const id = seedCrawlSet({ expected: 3, remaining: 3 });

    const { batch, disposals } = makeBatch([{}, articlesMessage({ crawlSetId: id, foodbankId: 9, slug: "york" })]);
    await expect(handleArticlesDlq(batch, env)).resolves.toBeUndefined();

    expect(disposals.map((d) => d.acks)).toEqual([1, 1]);
    expect(errorLines()[0]).toBe("articles-dlq: foodbank undefined (undefined) exhausted retries");
    expect(errorLines()[1]).toBe("articles-dlq: failed to decrement crawlset remaining for foodbank undefined (undefined)");
    // The good message behind it still counted down.
    expect(crawlSet(id)!.remaining).toBe(2);
  });
});

// ===========================================================================
// IDEMPOTENCY -- Cloudflare Queues is at-least-once
// ===========================================================================
describe("redelivery", () => {
  // NOT IDEMPOTENT, and this test exists to say so rather than to wish
  // otherwise. articles.ts's own consumer is protected: finishCrawlItem's
  // `finish IS NULL` gate (needcheck.ts:111-117) makes the decrement
  // conditional on this attempt actually having closed the crawl item, so a
  // redelivered message decrements nothing. This DLQ consumer has no such
  // gate -- it decrements unconditionally -- so the SAME message delivered
  // twice counts down twice.
  //
  // Reachable in practice: acks are per message and the invocation can die
  // between the decrement and the ack (CPU limit, eviction), and articles-dlq
  // is itself configured `max_retries: 1`. The consequence is the mirror of
  // the stall this consumer prevents -- `finish` stamped while food banks are
  // still outstanding, so /admin/crawls/ reports a run complete that is not.
  //
  // PINNED, NOT FIXED. Reported in suspectedBugs.
  it("decrements again on a redelivered message", async () => {
    const id = seedCrawlSet({ expected: 4, remaining: 3 });
    const body = articlesMessage({ crawlSetId: id });

    await handleArticlesDlq(makeBatch([body]).batch, env);
    expect(crawlSet(id)!.remaining).toBe(2);

    // The same logical message, delivered a second time.
    await handleArticlesDlq(makeBatch([body]).batch, env);
    expect(crawlSet(id)!.remaining).toBe(1);
  });

  it("can stamp finish early when a redelivery consumes the last of the countdown", async () => {
    const id = seedCrawlSet({ expected: 4, remaining: 2 });
    const body = articlesMessage({ crawlSetId: id });

    await handleArticlesDlq(makeBatch([body]).batch, env);
    await handleArticlesDlq(makeBatch([body]).batch, env);

    // Two food banks were outstanding and only ONE was accounted for, yet the
    // run now reads as finished.
    expect(crawlSet(id)!.remaining).toBe(0);
    expect(crawlSet(id)!.finish).toBe(DJANGO_NOW);
  });
});

// ===========================================================================
// THE LOG LINE -- the only trace a dead-lettered food bank leaves anywhere
// ===========================================================================
describe("logging", () => {
  // foodbankId and slug appear NOWHERE else in this module: they are not
  // bound into any SQL and not returned. So the log string is the only thing
  // that can distinguish "food bank 22 failed" from "food bank 33 failed",
  // and a transposition or a dropped field is invisible to every other
  // assertion in this file. Asserted as whole strings for that reason.
  it("names the food bank, its slug, and the queue, in that format", async () => {
    seedCrawlSet({ expected: 3, remaining: 3 });

    const { batch } = makeBatch([articlesMessage({ crawlSetId: 1, foodbankId: 331, slug: "trussell-trust-salisbury" })]);
    await handleArticlesDlq(batch, env);

    expect(errorLines()).toEqual(["articles-dlq: foodbank 331 (trussell-trust-salisbury) exhausted retries"]);
  });

  // The queue label is a literal here, not derived from batch.queue -- unlike
  // charityDlq.ts, which parameterises it. Pinned so a future refactor that
  // "unifies" the two consumers cannot silently make articles-dlq log under
  // the wrong name, which is what jobsDlq.ts's own header records happening
  // (jobs-dlq "logging its own name rather than the message that failed").
  it("labels the line articles-dlq regardless of the batch's queue name", async () => {
    seedCrawlSet({ expected: 3, remaining: 3 });

    const { batch } = makeBatch([articlesMessage()], "some-other-queue");
    await handleArticlesDlq(batch, env);

    expect(errorLines()[0]).toMatch(/^articles-dlq: /);
  });

  it("logs one line per message, in batch order", async () => {
    const id = seedCrawlSet({ expected: 10, remaining: 10 });

    const { batch } = makeBatch([
      articlesMessage({ crawlSetId: id, foodbankId: 1, slug: "aberdeen" }),
      articlesMessage({ crawlSetId: id, foodbankId: 2, slug: "bath" }),
      articlesMessage({ crawlSetId: id, foodbankId: 3, slug: "cardiff" }),
    ]);
    await handleArticlesDlq(batch, env);

    expect(errorLines()).toEqual([
      "articles-dlq: foodbank 1 (aberdeen) exhausted retries",
      "articles-dlq: foodbank 2 (bath) exhausted retries",
      "articles-dlq: foodbank 3 (cardiff) exhausted retries",
    ]);
  });

  // Two lines for a failed decrement, and the error object attached to the
  // second. Without the object the log says a write failed and not why, which
  // for a consumer with no other observable is the difference between a
  // debuggable incident and a mystery.
  it("adds a second line carrying the underlying error when the decrement fails", async () => {
    seedCrawlSet({ expected: 3, remaining: 3 });

    const { batch } = makeBatch([articlesMessage({ foodbankId: 44, slug: "leeds-north-and-west" })]);
    await handleArticlesDlq(batch, envFailing(/UPDATE crawlset/));

    expect(errorLines()).toEqual([
      "articles-dlq: foodbank 44 (leeds-north-and-west) exhausted retries",
      "articles-dlq: failed to decrement crawlset remaining for foodbank 44 (leeds-north-and-west)",
    ]);
    expect(errors[1]).toHaveLength(2);
    expect((errors[1]![1] as Error).message).toBe("D1_ERROR: Network connection lost");
  });

  // The success path logs exactly one line. A second line on success would
  // make "did this food bank fail to be accounted for?" unanswerable from the
  // log, which is the only place it can be answered.
  //
  // Asserted as the whole array rather than as a length: a count of 1 is also
  // satisfied by one line of entirely different text, and "the log holds
  // exactly this and nothing else" is the claim being made.
  it("logs nothing beyond the one line when the decrement succeeds", async () => {
    seedCrawlSet({ expected: 3, remaining: 3 });

    const { batch } = makeBatch([articlesMessage()]);
    await handleArticlesDlq(batch, env);

    expect(errors).toEqual([["articles-dlq: foodbank 22 (salisbury) exhausted retries"]]);
  });
});

// ===========================================================================
// THE D1 SESSION AND THE SQL SURFACE
// ===========================================================================
describe("the D1 session", () => {
  // "first-unconstrained" is the mode packages/db/src/types.ts requires every
  // caller to use on this replicated database. A bare env.DB.prepare(), or a
  // session opened in a mode that pins the primary, is not a correctness bug
  // here -- the decrement is a write and writes go to the primary anyway --
  // but it is the convention every other consumer follows and the one the
  // read-replication note in types.ts is written against.
  it("opens one first-unconstrained session for the whole batch", async () => {
    const id = seedCrawlSet({ expected: 10, remaining: 10 });

    const { batch } = makeBatch([
      articlesMessage({ crawlSetId: id, foodbankId: 1, slug: "aberdeen" }),
      articlesMessage({ crawlSetId: id, foodbankId: 2, slug: "bath" }),
    ]);
    await handleArticlesDlq(batch, env);

    // ONE session, not one per message: it is created outside the loop, which
    // is what lets the second message's read see the first message's write
    // through the same bookmark.
    expect(sessionModes).toEqual(["first-unconstrained"]);
  });

  // Created before the loop runs, so an empty batch still opens one. Recorded
  // because it is a real (if cheap) behaviour and because the empty-batch test
  // above asserts the complement -- no SQL.
  it("opens the session even for an empty batch", async () => {
    const { batch } = makeBatch([]);
    await handleArticlesDlq(batch, env);

    expect(sessionModes).toEqual(["first-unconstrained"]);
  });

  // The parity claim at the top of this file, made checkable. Django's
  // foodbank_article_crawl writes no FoodbankDiscrepancy (crawlers.py:25-67 --
  // the file's only three are in the NEED crawler), and this consumer must not
  // invent one: needcheckRenderDlq.ts DOES write one, so "make the two DLQs
  // consistent" is a plausible and wrong edit. The fixture has no
  // foodbankdiscrepancy table at all, so such a write would throw -- and be
  // swallowed by the handler's own catch, leaving no trace except in this log.
  it("issues the decrement and nothing else -- no discrepancy, no crawlitem write", async () => {
    const id = seedCrawlSet({ expected: 4, remaining: 4 });

    const { batch } = makeBatch([articlesMessage({ crawlSetId: id })]);
    await handleArticlesDlq(batch, env);

    expect(preparedSql).toEqual(["UPDATE crawlset SET remaining = remaining - 1 WHERE id = ?1 AND remaining > 0 RETURNING remaining"]);
  });

  // Two statements once the counter hits zero, and the finish stamp is the
  // second -- a single-statement version that tried to stamp inside the
  // decrement would have to compute the new value in SQL, which is a different
  // and unasserted thing.
  it("issues the finish stamp as a second statement on the zero transition", async () => {
    const id = seedCrawlSet({ expected: 4, remaining: 1 });

    const { batch } = makeBatch([articlesMessage({ crawlSetId: id })]);
    await handleArticlesDlq(batch, env);

    expect(preparedSql).toEqual([
      "UPDATE crawlset SET remaining = remaining - 1 WHERE id = ?1 AND remaining > 0 RETURNING remaining",
      "UPDATE crawlset SET finish = ?1 WHERE id = ?2",
    ]);
  });
});
