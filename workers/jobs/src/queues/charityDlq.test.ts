import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import type { Env } from "../../worker-configuration";
import { handleCharityEwDlq, handleCharityNiDlq, handleCharityScotlandDlq } from "./charityDlq";
import type { CharityMessage } from "./charity";
import jobsWorker from "../index";
// @ts-ignore -- this Worker's tsconfig lists only @cloudflare/workers-types, so
// node:sqlite has no declarations here. It is real under vitest's node
// environment, and adding "node" to workers/jobs/tsconfig.json would be a
// config change rather than a test change. Same suppression, same reasoning,
// as packages/db/src/schema.testkit.ts:35 and adminJobs/foodbankCheck.test.ts:11.
import { DatabaseSync } from "node:sqlite";

// queues/charityDlq.ts -- the dead-letter consumers for charity-ew-dlq,
// charity-scotland-dlq and charity-ni-dlq.
//
// WHY THIS FILE EXISTS. Everything here runs unattended, on the failure path,
// for a job nobody looks at. A message only reaches these handlers after
// charity-ew/-scotland/-ni have already burned their three retries
// (wrangler.jsonc: max_retries 3 on each producer queue), which means every
// single invocation is already an incident nobody was told about. What the
// handler then does decides whether the incident stays small (one food bank's
// charity details are a day stale) or becomes structural (crawlset.remaining
// never reaches 0, `finish` is never stamped, and /admin/jobs/ shows a charity
// crawl that has been "running" since March).
//
// The whole module is three exports off one factory, and the ONLY difference
// between the three is a label string that appears in a log line. That is
// precisely the kind of code where a copy-paste error -- handleCharityNiDlq
// built with "charity-scotland-dlq" -- is invisible forever: the decrement
// still happens, the counter still lands on 0, and the only casualty is the
// log line a human reads at 2am when trying to work out which regulator's API
// went down. So the log lines are asserted here as exact strings, per export.
//
// WHAT THE PORT IS PORTING. gfoffline/management/commands/charityinfo.py at
// /Users/jasoncartwright/Sites/foodcharity (read directly, 2026-09-08) is a
// single synchronous loop: one CrawlSet, `for foodbank in foodbanks:
// foodbank_charity_crawl(foodbank, crawl_set)`, then `crawl_set.finish =
// timezone.now()`. There is no counter, no queue and no failure path at all --
// an exception out of the crawl kills the command and leaves `finish` NULL.
// The `expected`/`remaining` columns are the port's own addition
// (0008_needcheck.sql:11-16), and they only exist because the port fanned that
// loop out over three queues. This module is the fan-out's cleanup crew, and
// it has no Django counterpart to be compared against.
//
// Also verified in Django rather than assumed: the module's header comment
// claims "charityinfo has no FoodbankDiscrepancy concept in Django either".
// givefood/utils/crawlers.py:79-101's foodbank_charity_crawl and
// _crawl_charity_ew (:104-) were read; they write CharityYear and CrawlItem
// rows and patch the Foodbank, and construct no FoodbankDiscrepancy anywhere.
// So the comment is accurate, and this DLQ genuinely has nothing to record
// beyond the counter -- unlike needcheckRenderDlq.ts, which does write one.
//
// REAL THINGS, NOT MOCKS. node:sqlite carrying the real DDL for crawlset and
// crawlitem (schemaFor, so the fixture is the migrations rather than a second
// copy of them), and the real decrementCrawlSetRemaining from @givefood/db --
// the atomic `UPDATE ... WHERE remaining > 0 RETURNING remaining` plus its
// `finish` stamp is the entire behaviour under test, and a session handing
// back canned rows would agree with any SQL at all. The only fakes are the
// Queues message objects (ack/retry are recorded, because whether a message is
// acked is the thing being asserted) and, in two tests, a session rigged to
// throw on one specific statement -- D1 outages are the one input this handler
// explicitly catches and cannot otherwise be given.
//
// MUTATION-TESTED (TESTING.md's convention: the evidence a test is
// load-bearing rather than decoration). The repo was copied into the
// scratchpad, broken 32 ways across two passes over three files, and this
// file re-run against each. Killed, among others: each of the three handlers
// relabelled with another regulator's queue name; the decrement removed, given
// foodbankId instead of crawlSetId, and left un-awaited; ack turned into
// retry, moved inside the try, and hoisted to once-per-batch; the loop cut to
// the first message only; the try/catch deleted; the failure log stripped of
// its error argument and of its queue label; the success line moved to
// console.log and stripped of its slug; the batch's session opened per-message
// and switched to first-primary; index.ts's three dlq cases cross-wired,
// deleted, and pointed at the producer-queue consumer, and its `default:` made
// to drop a batch silently. In packages/db's decrementCrawlSetRemaining (the
// one shared function this handler calls): the `remaining > 0` floor dropped,
// the subtraction inverted, `expected` clobbered alongside `remaining`, both
// statements' `WHERE id` dropped, and `finish` stamped one item early, on
// every call, never, and with toISOString() instead of pyNow().
//
// ONE MUTANT SURVIVED THE DRAFT: the `finish` stamp's own `WHERE id = ?2`
// removed, so tipping one crawl set to zero would stamp EVERY running crawl in
// the table -- articles and needcheck included. The draft's exclusion test used
// a crawl set that never reached zero, so the stamp statement never ran in the
// presence of a second row. That is why the finish test below seeds crawl set 8
// as well and asserts it is still unfinished; a later tidy-up that deletes the
// "unnecessary" second seed puts the mutant back.
//
// ADVERSARIAL REVIEW PASS re-ran all of the above independently plus 13 new
// mutants. 43 of 44 died; the one survivor (the "exhausted retries" log moved
// inside the try) was shown by differential run to be an EQUIVALENT mutant --
// see the null-body test for why it cannot be killed. The pass found and closed
// one real hole, the discrepancy write described on the test that now covers
// it, and tightened one `toContain` to a whole-log `toEqual`.
//
// A TRAP FOR THE NEXT REVIEWER, because it silently invalidates a whole class
// of result: pnpm links @givefood/db as a RELATIVE symlink
// (workers/jobs/node_modules/@givefood/db -> ../../../../packages/db). Copy the
// repo to a scratchpad but symlink node_modules back at the real tree and that
// relative link resolves to the REAL packages/db -- so every mutant applied to
// the copy's needcheck.ts is loaded from the unmutated original and appears to
// survive. All eleven decrementCrawlSetRemaining mutants looked like survivors
// that way until the workspace was fixed by copying each package's own
// node_modules (they are symlink farms, so the relative links then resolve
// inside the copy). Once they genuinely applied, all eleven died.
//
// NOT VERIFIED: nothing here has been run against a real Cloudflare queue. The
// claims below about redelivery are read off the documented at-least-once
// guarantee and wrangler.jsonc's consumer settings, not measured.

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

/**
 * The slice of the D1 Sessions API packages/db is handed, over the real
 * engine. It forwards SQL untouched and interprets nothing, so SQLite decides
 * what comes back.
 *
 * The two failure hooks are the only embellishment, and each exists for a
 * failure this handler explicitly catches and cannot otherwise be given:
 *
 *   `failOn`   -- by SQL text. decrementCrawlSetRemaining issues TWO
 *                 statements (the atomic decrement, then the `finish` stamp
 *                 when it hits zero) and the handler's try/catch wraps both
 *                 together. Breaking one and not the other separates "the
 *                 decrement failed and nothing happened" from the much nastier
 *                 "the decrement committed, the stamp did not, and the counter
 *                 is now 0 so nothing will ever stamp it".
 *   `failForId` -- by BOUND VALUE. Every message in a batch runs byte-identical
 *                 SQL, so poisoning exactly one of them is only possible by the
 *                 crawl set id it binds. That is what the per-message
 *                 isolation test needs.
 */
interface SessionHooks {
  failOn?: RegExp;
  failForId?: number;
  failWith?: unknown;
}

function d1Session(hooks: SessionHooks): unknown {
  function statement(sql: string, params: Bindable[]): unknown {
    const guard = (): void => {
      const matches = (hooks.failOn?.test(sql) ?? false) || (hooks.failForId !== undefined && params[0] === hooks.failForId);
      if (matches) throw hooks.failWith ?? new Error("D1_ERROR: Network connection lost");
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
  return { prepare: (sql: string) => statement(sql, []), getBookmark: () => null };
}

// Every withSession() call this Worker makes, in order, with the mode string
// it asked for. The handler opens exactly one session per BATCH (outside the
// message loop), which is what chains D1's session bookmarks across the ten
// messages a charity-*-dlq batch can carry; a session opened per message would
// break that chain silently.
let sessionModes: string[] = [];

function buildEnv(hooks: SessionHooks = {}): Env {
  return {
    DB: {
      withSession: (mode: string) => {
        sessionModes.push(mode);
        return d1Session(hooks);
      },
    },
  } as unknown as Env;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

interface BatchProbe {
  batch: MessageBatch<CharityMessage>;
  acks: string[];
  retries: string[];
}

/**
 * A MessageBatch whose ack()/retry() are recorded rather than performed.
 *
 * The recording is by message id, not by count: "it acked something three
 * times" and "it acked all three messages" are different claims, and only the
 * second one means the batch drained. The first is what a handler that acked
 * the same message in a loop would produce.
 */
function batchOf(queue: string, bodies: unknown[]): BatchProbe {
  const acks: string[] = [];
  const retries: string[] = [];
  const messages = bodies.map((body, index) => ({
    id: `msg-${index}`,
    timestamp: new Date(),
    body,
    attempts: 4, // a DLQ message has already used the producer queue's max_retries 3
    ack: () => void acks.push(`msg-${index}`),
    retry: () => void retries.push(`msg-${index}`),
  }));
  return {
    batch: { queue, messages, ackAll: () => {}, retryAll: () => {} } as unknown as MessageBatch<CharityMessage>,
    acks,
    retries,
  };
}

function charityMessage(crawlSetId: number, foodbankId: number, slug: string): CharityMessage {
  return { crawlSetId, foodbankId, slug };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Frozen so the `finish` stamp is a value this file can assert as a LITERAL
// rather than by calling pyNow() and agreeing with the implementation. The
// expected string below is hand-written in Django's format on purpose: these
// columns are TEXT and every ORDER BY over them is a byte comparison, so a
// toISOString() stamp ("2026-09-08T10:11:12.345Z") would sort above every
// space-separated timestamp of the same day and quietly reorder /admin/jobs/.
const NOW = new Date("2026-09-08T10:11:12.345Z");
const NOW_PY = "2026-09-08 10:11:12.345000";

// A crawl set that already exists when the DLQ message arrives -- which is
// always the case in production: the cron created it and setCrawlSetExpected
// stamped `expected`/`remaining` before a single message was sent.
function seedCrawlSet(id: number, remaining: number | null, opts: { runId?: string | null; finish?: string | null } = {}): void {
  db.prepare(
    "INSERT INTO crawlset (id, crawl_type, run_id, start, finish, expected, remaining) VALUES (?, 'charity', ?, '2026-09-08 05:30:00.000000', ?, ?, ?)",
  ).run(id, opts.runId ?? `charity-2026-09-08-${id}`, opts.finish ?? null, remaining === null ? null : 12, remaining);
}

interface CrawlSetRow {
  id: number;
  crawl_type: string;
  run_id: string | null;
  start: string;
  finish: string | null;
  expected: number | null;
  remaining: number | null;
}

function crawlSet(id: number): CrawlSetRow {
  return db.prepare("SELECT * FROM crawlset WHERE id = ?").get(id) as unknown as CrawlSetRow;
}

// The crawlitem charity.ts's processOne opened before the fetcher threw. It is
// still open when the message lands here; see the test that reads it back.
function seedOpenCrawlItem(id: number, crawlSetId: number, foodbankId: number): void {
  db.prepare(
    "INSERT INTO crawlitem (id, crawl_set_id, crawl_type, start, finish, foodbank_id, url, need_id) VALUES (?, ?, 'charity', '2026-09-08 05:31:00.000000', NULL, ?, NULL, NULL)",
  ).run(id, crawlSetId, foodbankId);
}

interface CrawlItemRow {
  id: number;
  crawl_set_id: number | null;
  crawl_type: string;
  start: string;
  finish: string | null;
  foodbank_id: number;
}

function crawlItem(id: number): CrawlItemRow {
  return db.prepare("SELECT * FROM crawlitem WHERE id = ?").get(id) as unknown as CrawlItemRow;
}

// Every foodbankdiscrepancy row there is. Returned whole rather than counted so
// a failure prints what got written and for which food bank, instead of
// "expected 1 to be 0".
function discrepancies(): Record<string, unknown>[] {
  return db.prepare("SELECT * FROM foodbankdiscrepancy").all();
}

// console.error is this module's ONLY output besides the counter, so it is
// captured argument-by-argument rather than joined: the failure path logs a
// message AND the caught error object, and "it logged the error too" is the
// difference between a debuggable outage and a line that says something failed
// without saying what.
let errorCalls: unknown[][] = [];

function errorLines(): string[] {
  return errorCalls.map((args) => String(args[0]));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);

  db = new DatabaseSync(":memory:") as unknown as SqliteDatabase;
  // crawlset is the only table decrementCrawlSetRemaining touches; crawlitem
  // is here so the "what this handler does NOT clean up" test has something
  // real to read back. schemaFor rather than a hand-written CREATE TABLE:
  // a transcribed schema is a second copy of the truth, and if a shared
  // packages/db function ever starts reading a third object this fixture
  // fails loudly with "no such table" instead of quietly disagreeing.
  //
  // foodbankdiscrepancy is here for the OPPOSITE reason to the other two: this
  // handler must never write to it, and a table the fixture lacks cannot be
  // asserted empty. See "records no discrepancy row" below -- leaving it out
  // is what made that mutant survivable.
  db.exec(schemaFor("crawlset", "crawlitem", "foodbankdiscrepancy"));

  sessionModes = [];
  errorCalls = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errorCalls.push(args));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  db.close();
});

// ===========================================================================
// THE COUNTER -- the only durable thing this handler writes
// ===========================================================================
describe("the crawlset counter", () => {
  // The one claim the module makes about itself: "keeping the CrawlSet counter
  // from getting permanently stuck for a food bank whose crawl keeps failing".
  // Read back from the row, not from a return value -- the handler discards
  // decrementCrawlSetRemaining's answer entirely, so the row is the only
  // evidence that anything happened at all.
  it("decrements remaining for the crawl set the message names", async () => {
    seedCrawlSet(7, 3);

    await handleCharityEwDlq(batchOf("charity-ew-dlq", [charityMessage(7, 42, "salisbury")]).batch, buildEnv());

    expect(crawlSet(7).remaining).toBe(2);
    // `expected` is the denominator /admin/jobs/ renders the progress bar
    // against; a decrement that touched it would make the bar go nowhere.
    expect(crawlSet(7).expected).toBe(12);
  });

  // Seeded to be excluded. A decrement that lost its `WHERE id = ?1` would
  // close out every open charity crawl in the table at once, and a suite that
  // seeded only the target row would never see it.
  it("leaves every other crawl set alone", async () => {
    seedCrawlSet(7, 3);
    seedCrawlSet(8, 3);
    seedCrawlSet(9, 3);

    await handleCharityEwDlq(batchOf("charity-ew-dlq", [charityMessage(7, 42, "salisbury")]).batch, buildEnv());

    expect(crawlSet(7).remaining).toBe(2);
    expect(crawlSet(8).remaining).toBe(3);
    expect(crawlSet(9).remaining).toBe(3);
  });

  // The message carries THREE numbers and only one of them addresses the row.
  // Crawl set 42 exists here purely so that a handler passing foodbankId (or
  // the whole message body) to decrementCrawlSetRemaining would hit a real row
  // and look like it worked. Every id in this file is deliberately distinct
  // for the same reason -- while crawl set 1 crawls food bank 1, a transposed
  // bind is indistinguishable from a correct one.
  it("decrements by crawlSetId, not by foodbankId", async () => {
    seedCrawlSet(7, 3);
    seedCrawlSet(42, 3);

    await handleCharityEwDlq(batchOf("charity-ew-dlq", [charityMessage(7, 42, "salisbury")]).batch, buildEnv());

    expect(crawlSet(7).remaining).toBe(2);
    expect(crawlSet(42).remaining).toBe(3);
  });

  // Each message is its own decrement. A handler that decremented once per
  // batch would look correct on every single-message test in this file and
  // then leave the counter 9 short on a full charity-*-dlq batch
  // (max_batch_size 10), which is exactly the "permanently stuck" state the
  // module exists to prevent.
  it("decrements once per message in the batch, not once per batch", async () => {
    seedCrawlSet(7, 10);
    const bodies = ["ashford", "bath", "corby", "dover", "exeter"].map((slug, i) => charityMessage(7, 100 + i, slug));

    await handleCharityEwDlq(batchOf("charity-ew-dlq", bodies).batch, buildEnv());

    expect(crawlSet(7).remaining).toBe(5);
  });

  // The reason the counter exists at all: nothing else in the port ever stamps
  // `finish` for a fanned-out crawl (0008_needcheck.sql:11-16 -- Django's
  // needcheck never stamps one either, which is the confirmed production bug
  // that column was added to fix). So a DLQ that decrements but never reaches
  // 0 is no better than one that does nothing.
  //
  // The literal is Django's format, hand-written rather than pyNow(): see
  // NOW_PY above for why a 'T' here would be a real ordering bug.
  //
  // Crawl set 8 is seeded to be excluded, and specifically excluded from the
  // STAMP rather than from the decrement: the two are different statements
  // with their own WHERE clause, and the exclusion test above never reaches
  // the second one. A `finish` stamp that lost its `WHERE id = ?2` would close
  // out every running crawl in the table -- articles, needcheck and all -- the
  // moment one charity DLQ message tipped its own counter to zero, and would
  // survive every other assertion in this file.
  it("stamps finish, in Django's timestamp format, when the last message drives remaining to 0", async () => {
    seedCrawlSet(7, 1);
    seedCrawlSet(8, 4);

    await handleCharityEwDlq(batchOf("charity-ew-dlq", [charityMessage(7, 42, "salisbury")]).batch, buildEnv());

    expect(crawlSet(7).remaining).toBe(0);
    expect(crawlSet(7).finish).toBe(NOW_PY);
    expect(crawlSet(8).finish).toBeNull();
    expect(crawlSet(8).remaining).toBe(4);
  });

  // The other half of the same claim: `finish` must NOT be stamped early. A
  // crawl set marked finished while nine food banks are still being crawled
  // reads as a completed run on /admin/jobs/ and hides the ones still going.
  it("does not stamp finish while messages remain outstanding", async () => {
    seedCrawlSet(7, 3);

    await handleCharityEwDlq(batchOf("charity-ew-dlq", [charityMessage(7, 42, "salisbury")]).batch, buildEnv());

    expect(crawlSet(7).remaining).toBe(2);
    expect(crawlSet(7).finish).toBeNull();
  });

  // PLAN.md §8.7 and scheduled/index.ts:207-213: charityinfo creates ONE
  // CrawlSet and fans it across three queues, "all three sets of messages
  // carrying the same crawlSetId". So the three DLQ handlers are not
  // independent -- they are three writers to one counter, and the run only
  // closes if all three decrement the same row. This is the test that would
  // catch a future "each regulator gets its own crawl set" change made in the
  // cron without a matching change here.
  it("has all three regulators' DLQs closing out the one shared crawl set", async () => {
    seedCrawlSet(7, 3);
    const env = buildEnv();

    await handleCharityEwDlq(batchOf("charity-ew-dlq", [charityMessage(7, 42, "salisbury")]).batch, env);
    expect(crawlSet(7).finish).toBeNull();

    await handleCharityScotlandDlq(batchOf("charity-scotland-dlq", [charityMessage(7, 43, "dundee")]).batch, env);
    expect(crawlSet(7).finish).toBeNull();

    await handleCharityNiDlq(batchOf("charity-ni-dlq", [charityMessage(7, 44, "belfast")]).batch, env);

    expect(crawlSet(7).remaining).toBe(0);
    expect(crawlSet(7).finish).toBe(NOW_PY);
  });

  // What this handler deliberately does NOT do. charity.ts's processOne opens
  // a crawlitem before it calls the fetcher, and only finishCrawlItem closes
  // it; when the fetcher throws three times the message comes here and the
  // crawlitem is simply abandoned. So a completed charity run can carry rows
  // with `finish IS NULL` -- which 0008_needcheck.sql:32-34 documents as
  // "exactly how a stalled/crashed run is detected". That is arguably the
  // right outcome (the item really did stall) but it means "crawl set finished
  // + open crawl items" is a normal, expected state rather than a corrupt one,
  // and anything reading crawlitem for stalls has to know that.
  it("leaves the abandoned crawlitem open rather than closing it", async () => {
    seedCrawlSet(7, 1);
    seedOpenCrawlItem(500, 7, 42);

    await handleCharityEwDlq(batchOf("charity-ew-dlq", [charityMessage(7, 42, "salisbury")]).batch, buildEnv());

    expect(crawlSet(7).finish).toBe(NOW_PY);
    expect(crawlItem(500).finish).toBeNull();
  });

  // The other half of "what this handler does NOT do", and the one the module
  // header makes an explicit claim about: "charityinfo has no
  // FoodbankDiscrepancy concept in Django either". Its sibling one directory
  // over, needcheckRenderDlq.ts, DOES write one per dead-lettered message (its
  // own comment quotes WP 5.4: "Every queue gets a DLQ whose consumer writes a
  // FoodbankDiscrepancy"). Two DLQ consumers, near-identical shape, deliberately
  // different behaviour -- which is the exact shape of a copy-paste nobody
  // reviews, because the counter still lands on 0 and the logs still read right.
  //
  // KILLS the mutant that pastes needcheckRenderDlq.ts's insertFoodbankDiscrepancy
  // block (plus its import) into this handler. The suite DID already kill that
  // mutant before this test existed -- but only by accident: foodbankdiscrepancy
  // was absent from the fixture, so the insert died with "no such table", the
  // module's own catch logged an extra line, and the log assertions tripped over
  // it. Measured in a scratchpad copy: add the table to schemaFor and that same
  // mutant passes all 29 tests. Protection that evaporates when the fixture
  // grows a table is not protection, so the emptiness is now asserted directly.
  //
  // Both a succeeding and a failing message, because needcheckRenderDlq.ts
  // writes its discrepancy on the failure path too -- asserting only the happy
  // path would leave half the paste uncovered.
  //
  // NOT covered here, and worth knowing: `foodbank` is still absent from the
  // fixture, so a handler that started stamping foodbank.last_crawl would be
  // caught the same accidental way this one used to be. Closing that needs a
  // seeded foodbank row, which is real setup; it is a gap, not an oversight.
  it("records no discrepancy row, on either the succeeding or the failing path", async () => {
    seedCrawlSet(7, 10);
    seedCrawlSet(8, 10);

    await handleCharityEwDlq(
      batchOf("charity-ew-dlq", [charityMessage(7, 42, "salisbury"), charityMessage(8, 43, "bath")]).batch,
      buildEnv({ failForId: 8 }),
    );

    // Both paths genuinely ran -- 7 decremented, 8 threw -- so the empty table
    // below is a statement about the handler and not about a batch that did
    // nothing at all.
    expect(crawlSet(7).remaining).toBe(9);
    expect(crawlSet(8).remaining).toBe(10);
    expect(discrepancies()).toEqual([]);
  });
});

// ===========================================================================
// THE ACK CONTRACT
//
// wrangler.jsonc gives each charity-*-dlq consumer `max_batch_size 10,
// max_retries 1` and -- unlike the producer queues -- NO dead_letter_queue of
// its own. So there is nowhere further for a message to go: ack drops it,
// retry gets it one more attempt and then Cloudflare discards it silently.
// Every test below is about which of those two happens.
// ===========================================================================
describe("what it does with the message", () => {
  it("acks every message in the batch, by id", async () => {
    seedCrawlSet(7, 10);
    const probe = batchOf("charity-ew-dlq", [charityMessage(7, 42, "salisbury"), charityMessage(7, 43, "bath"), charityMessage(7, 44, "corby")]);

    await handleCharityEwDlq(probe.batch, buildEnv());

    expect(probe.acks).toEqual(["msg-0", "msg-1", "msg-2"]);
    expect(probe.retries).toEqual([]);
  });

  // THE DELIBERATE HOLE, pinned so a future reader sees it is a decision and
  // not an oversight. A D1 outage during the decrement is caught, logged and
  // ACKED: the counter is now permanently one short, the crawl set will never
  // stamp `finish`, and because this queue has no dead-letter queue of its own
  // the message is gone. Retrying instead would be free (max_retries 1) and
  // would fix the transient case. It does not, and this test says so.
  it("acks -- never retries -- when the decrement itself fails", async () => {
    seedCrawlSet(7, 3);
    const probe = batchOf("charity-ew-dlq", [charityMessage(7, 42, "salisbury")]);

    await handleCharityEwDlq(probe.batch, buildEnv({ failOn: /UPDATE crawlset SET remaining/ }));

    expect(probe.acks).toEqual(["msg-0"]);
    expect(probe.retries).toEqual([]);
    expect(crawlSet(7).remaining).toBe(3);
    expect(crawlSet(7).finish).toBeNull();
  });

  // One poisoned message must not cost the other nine their decrement. The
  // try/catch is inside the loop, so message 1 fails and messages 0 and 2
  // still land -- assert the counter moved by exactly 2, not 0 and not 3.
  it("keeps processing the rest of the batch after one message's write fails", async () => {
    seedCrawlSet(7, 10);
    seedCrawlSet(8, 10);
    const probe = batchOf("charity-ew-dlq", [charityMessage(7, 42, "salisbury"), charityMessage(8, 43, "bath"), charityMessage(7, 44, "corby")]);

    // Bind-value matching, not statement matching: the SQL text is identical
    // for all three messages, so the only way to poison exactly one of them is
    // by the value it binds. This session throws only for crawl set 8.
    await handleCharityEwDlq(probe.batch, buildEnv({ failForId: 8 }));

    // Crawl set 7 lost two ticks -- one from message 0, one from message 2,
    // which is the message BEHIND the failure. A `catch` that broke the loop
    // (or a try/catch around the loop rather than inside it) would leave this
    // at 9.
    expect(crawlSet(7).remaining).toBe(8);
    expect(crawlSet(8).remaining).toBe(10);
    expect(probe.acks).toEqual(["msg-0", "msg-1", "msg-2"]);
    // toEqual on the WHOLE log, not toContain on the one interesting line. The
    // ordering is the assertion that carries weight: the failure line sits
    // between bath's own "exhausted retries" and corby's, which is what proves
    // the loop carried on THROUGH the failure rather than logging the failure
    // last after some retry pass. toContain would also have accepted a handler
    // that emitted spurious extra lines, or that logged bath's failure twice.
    expect(errorLines()).toEqual([
      "charity-ew-dlq: foodbank 42 (salisbury) exhausted retries",
      "charity-ew-dlq: foodbank 43 (bath) exhausted retries",
      "charity-ew-dlq: failed to decrement crawlset remaining for foodbank 43 (bath)",
      "charity-ew-dlq: foodbank 44 (corby) exhausted retries",
    ]);
  });

  // A message whose crawl set has been deleted -- 0008_needcheck.sql declares
  // no FK constraints (§4.5's convention), and the crawlitem retention prune
  // cron exists, so a crawl set vanishing under an in-flight message is not
  // hypothetical. decrementCrawlSetRemaining answers null and this handler
  // discards it, so the message is acked as if it had worked.
  it("acks a message for a crawl set that no longer exists, and writes nothing", async () => {
    seedCrawlSet(8, 3);
    const probe = batchOf("charity-ew-dlq", [charityMessage(404, 42, "salisbury")]);

    await handleCharityEwDlq(probe.batch, buildEnv());

    expect(probe.acks).toEqual(["msg-0"]);
    expect(crawlSet(404)).toBeUndefined();
    expect(crawlSet(8).remaining).toBe(3);
    // Nothing distinguishes this from a successful decrement in the log. The
    // only line emitted is the unconditional "exhausted retries" one.
    expect(errorLines()).toEqual(["charity-ew-dlq: foodbank 42 (salisbury) exhausted retries"]);
  });

  it("opens exactly one D1 session per batch, in first-unconstrained mode", async () => {
    seedCrawlSet(7, 10);
    const probe = batchOf("charity-ew-dlq", [charityMessage(7, 42, "salisbury"), charityMessage(7, 43, "bath"), charityMessage(7, 44, "corby")]);

    await handleCharityEwDlq(probe.batch, buildEnv());

    // One entry, not three: the session (and therefore D1's bookmark chain) is
    // shared by every message in the batch. "first-unconstrained" lets the
    // first query go to any replica, which is safe here only because this
    // handler reads nothing it then makes a decision on -- the decrement is a
    // single atomic UPDATE...RETURNING on the primary.
    expect(sessionModes).toEqual(["first-unconstrained"]);
  });
});

// ===========================================================================
// AT-LEAST-ONCE
//
// Cloudflare Queues delivers at least once, at both hops: the producer queue
// can redeliver into this DLQ, and the DLQ consumer's own batch can be
// redelivered after a partial success. Neither is rare enough to leave
// untested, because the failure mode is a counter that no longer means what
// /admin/jobs/ says it means.
// ===========================================================================
describe("under redelivery", () => {
  // THE FLOOR. `WHERE remaining > 0` is what stops a redelivered message
  // driving the counter negative -- a negative counter never equals 0, so
  // `finish` would never be stamped and the run would show as running forever.
  // The guard holds and the extra messages are silent no-ops.
  it("floors remaining at 0 rather than going negative", async () => {
    seedCrawlSet(7, 2);
    const probe = batchOf("charity-ew-dlq", [
      charityMessage(7, 42, "salisbury"),
      charityMessage(7, 43, "bath"),
      charityMessage(7, 44, "corby"),
      charityMessage(7, 45, "dover"),
    ]);

    await handleCharityEwDlq(probe.batch, buildEnv());

    expect(crawlSet(7).remaining).toBe(0);
    expect(probe.acks).toEqual(["msg-0", "msg-1", "msg-2", "msg-3"]);
  });

  // ... and the stamp is written once, by the message that actually reached 0.
  // A stamp written on every call would move `finish` forward with each
  // surplus message and make a run's duration a function of how many
  // duplicates arrived.
  it("stamps finish once, at the crossing, and not again for the surplus messages", async () => {
    seedCrawlSet(7, 1);

    await handleCharityEwDlq(batchOf("charity-ew-dlq", [charityMessage(7, 42, "salisbury")]).batch, buildEnv());
    expect(crawlSet(7).finish).toBe(NOW_PY);

    vi.setSystemTime(new Date(NOW.getTime() + 3_600_000));
    await handleCharityEwDlq(batchOf("charity-ew-dlq", [charityMessage(7, 42, "salisbury")]).batch, buildEnv());

    expect(crawlSet(7).finish).toBe(NOW_PY);
    expect(crawlSet(7).remaining).toBe(0);
  });

  // NOT IDEMPOTENT, and this is the honest record of it. charity.ts guards its
  // own decrement behind finishCrawlItem's `changes > 0` (needcheck.ts:104-110
  // spells out why: "so a message redelivered post-commit can't
  // double-decrement crawlset.remaining"). This handler has no such guard --
  // it decrements unconditionally, every delivery. Redeliver the same DLQ
  // batch and the counter loses 3 instead of 1.
  //
  // The consequence is not a negative counter (the floor above prevents that)
  // but an EARLY `finish`: the crawl set closes while food banks are still
  // being crawled, and their later decrements are the silent no-ops. Asserted
  // as it behaves, reported as suspect; a test asserting the wish would just
  // be permanently red.
  it("double-counts a redelivered message -- the decrement has no dedup guard", async () => {
    seedCrawlSet(7, 5);
    const body = charityMessage(7, 42, "salisbury");

    await handleCharityEwDlq(batchOf("charity-ew-dlq", [body]).batch, buildEnv());
    await handleCharityEwDlq(batchOf("charity-ew-dlq", [body]).batch, buildEnv());
    await handleCharityEwDlq(batchOf("charity-ew-dlq", [body]).batch, buildEnv());

    // 2, not 4: one food bank's failure was counted three times.
    expect(crawlSet(7).remaining).toBe(2);
  });

  // The nastiest reachable state, and the reason `failOn` exists. The
  // decrement commits, the `finish` stamp is the statement that fails, and the
  // handler acks. remaining is now 0, so every subsequent call takes the
  // `WHERE remaining > 0` branch and returns null WITHOUT stamping -- there is
  // no code path anywhere that stamps `finish` for a crawl set already at 0.
  // The run is permanently "running" and no retry will ever fix it.
  it("can leave a crawl set at remaining 0 with finish never stamped", async () => {
    seedCrawlSet(7, 1);
    const probe = batchOf("charity-ew-dlq", [charityMessage(7, 42, "salisbury")]);

    await handleCharityEwDlq(probe.batch, buildEnv({ failOn: /UPDATE crawlset SET finish/ }));

    expect(crawlSet(7).remaining).toBe(0);
    expect(crawlSet(7).finish).toBeNull();
    expect(probe.acks).toEqual(["msg-0"]);

    // And a later, healthy delivery does not repair it.
    await handleCharityEwDlq(batchOf("charity-ew-dlq", [charityMessage(7, 43, "bath")]).batch, buildEnv());
    expect(crawlSet(7).finish).toBeNull();
  });
});

// ===========================================================================
// MALFORMED BODIES
//
// A DLQ only ever receives what the producer sent, and scheduled/index.ts:228
// builds every charity message from one `satisfies CharityMessage` literal, so
// none of the shapes below can be produced today. They are pinned anyway
// because a DLQ is where a message ends up when everything else about it has
// already gone wrong, and because the two shapes behave COMPLETELY differently
// -- one is swallowed, the other takes the whole batch down.
// ===========================================================================
describe("with a malformed message body", () => {
  // Missing fields are survivable: the log line prints "undefined", the
  // decrement never reaches a row, and the message is acked. Nothing is
  // written and nothing is lost except one counter tick.
  //
  // Only the ack, the untouched row and the first log line are asserted,
  // deliberately. WHAT the database does with an undefined id is the engine's
  // business and differs between them -- node:sqlite here throws
  // `TypeError: Provided value cannot be bound to SQLite parameter 1`
  // (measured, node 24.15.0), so the handler's catch also fires and logs a
  // second line; whether real D1 rejects the bind the same way is NOT
  // verified, and a test that asserted the second line would be asserting
  // node:sqlite rather than this handler. Either way the handler swallows it
  // and acks, which is the claim that matters.
  it("acks a body with no crawlSetId, having written nothing", async () => {
    seedCrawlSet(7, 3);
    const probe = batchOf("charity-ew-dlq", [{}]);

    await handleCharityEwDlq(probe.batch, buildEnv());

    expect(probe.acks).toEqual(["msg-0"]);
    expect(probe.retries).toEqual([]);
    expect(crawlSet(7).remaining).toBe(3);
    // The identifying half of the log line is useless here, which is itself
    // worth seeing: "foodbank undefined (undefined)" is all an operator gets.
    expect(errorLines()[0]).toBe("charity-ew-dlq: foodbank undefined (undefined) exhausted retries");
  });

  // A NULL body is NOT survivable, and this is the sharp edge of the module.
  // The console.error on charityDlq.ts:14 dereferences message.body BEFORE the
  // try block opens, so a null body throws a TypeError out of the whole
  // handler. The batch's promise rejects, nothing after that message in the
  // batch is touched, and with max_retries 1 and no onward DLQ, all ten
  // messages in that batch are retried once and then discarded -- nine
  // innocent food banks' counters lost to one bad body.
  //
  // A note for whoever tries to "fix" this by moving that console.error inside
  // the try block: it does not help, and no test here will tell you so. The
  // catch block dereferences message.body too, so a null body throws out of the
  // catch instead of out of the try and the batch still rejects. Measured, not
  // reasoned: both versions were run against null, undefined, {} and a good
  // body in a scratchpad copy, and the thrown error, the acks, the retries and
  // the log lines were identical in all four. It is an equivalent mutant. The
  // fix that WOULD change behaviour is making the catch stop touching
  // message.body -- and that variant IS killed, by the log assertions.
  it("rejects the entire batch on a null body, abandoning the messages behind it", async () => {
    seedCrawlSet(7, 3);
    const probe = batchOf("charity-ew-dlq", [null, charityMessage(7, 42, "salisbury")]);

    await expect(handleCharityEwDlq(probe.batch, buildEnv())).rejects.toThrow(TypeError);

    // Neither message acked -- not even the well-formed one behind the bad one.
    expect(probe.acks).toEqual([]);
    expect(probe.retries).toEqual([]);
    expect(crawlSet(7).remaining).toBe(3);
  });
});

// ===========================================================================
// THE LABELS
//
// The three exports differ in exactly one respect: the string baked into their
// two log lines. Nothing else observable distinguishes them, so if these
// assertions are weakened there is no test in the repo that can tell
// handleCharityNiDlq from handleCharityScotlandDlq -- and a DLQ log line
// naming the wrong regulator is worse than no log line, because it sends
// whoever is debugging at the wrong API.
// ===========================================================================
describe("the log lines", () => {
  it("names its own queue, the food bank id and the slug, on charity-ew-dlq", async () => {
    seedCrawlSet(7, 3);

    await handleCharityEwDlq(batchOf("charity-ew-dlq", [charityMessage(7, 42, "salisbury")]).batch, buildEnv());

    expect(errorLines()).toEqual(["charity-ew-dlq: foodbank 42 (salisbury) exhausted retries"]);
  });

  it("names charity-scotland-dlq from the Scotland export", async () => {
    seedCrawlSet(7, 3);

    await handleCharityScotlandDlq(batchOf("charity-scotland-dlq", [charityMessage(7, 43, "dundee")]).batch, buildEnv());

    expect(errorLines()).toEqual(["charity-scotland-dlq: foodbank 43 (dundee) exhausted retries"]);
  });

  it("names charity-ni-dlq from the Northern Ireland export", async () => {
    seedCrawlSet(7, 3);

    await handleCharityNiDlq(batchOf("charity-ni-dlq", [charityMessage(7, 44, "belfast")]).batch, buildEnv());

    expect(errorLines()).toEqual(["charity-ni-dlq: foodbank 44 (belfast) exhausted retries"]);
  });

  // One line per message, every message, whether or not the decrement worked.
  // This log IS the alerting for a food bank whose charity crawl has failed
  // four times: there is no discrepancy row, no email, and nothing on
  // /admin/. A handler that logged once per batch would hide which food bank.
  it("logs one line per message, naming each food bank", async () => {
    seedCrawlSet(7, 10);

    await handleCharityEwDlq(
      batchOf("charity-ew-dlq", [charityMessage(7, 42, "salisbury"), charityMessage(7, 43, "bath")]).batch,
      buildEnv(),
    );

    expect(errorLines()).toEqual([
      "charity-ew-dlq: foodbank 42 (salisbury) exhausted retries",
      "charity-ew-dlq: foodbank 43 (bath) exhausted retries",
    ]);
  });

  // The second, conditional line. It carries the caught error as a SEPARATE
  // console.error argument rather than interpolating it, which is what puts a
  // real stack into the Workers log rather than the string "[object Object]".
  it("logs the caught error object alongside its own message when the decrement fails", async () => {
    seedCrawlSet(7, 3);
    const boom = new Error("D1_ERROR: Network connection lost");

    await handleCharityEwDlq(batchOf("charity-ew-dlq", [charityMessage(7, 42, "salisbury")]).batch, buildEnv({ failOn: /UPDATE crawlset/, failWith: boom }));

    expect(errorLines()).toEqual([
      "charity-ew-dlq: foodbank 42 (salisbury) exhausted retries",
      "charity-ew-dlq: failed to decrement crawlset remaining for foodbank 42 (salisbury)",
    ]);
    // toBe, not toEqual: the identity of the thrown value is what makes the
    // log actionable, and a handler that logged `String(err)` or a fresh
    // Error would pass an equality check on the message alone.
    expect(errorCalls[1]?.[1]).toBe(boom);
  });

  // Each regulator's failure line carries its own label too. The success line
  // and the failure line are separate template strings in the source, so
  // getting one right proves nothing about the other.
  it("names its own queue on the failure line as well, per regulator", async () => {
    seedCrawlSet(7, 3);
    const env = buildEnv({ failOn: /UPDATE crawlset/ });

    await handleCharityScotlandDlq(batchOf("charity-scotland-dlq", [charityMessage(7, 43, "dundee")]).batch, env);
    await handleCharityNiDlq(batchOf("charity-ni-dlq", [charityMessage(7, 44, "belfast")]).batch, env);

    expect(errorLines()).toEqual([
      "charity-scotland-dlq: foodbank 43 (dundee) exhausted retries",
      "charity-scotland-dlq: failed to decrement crawlset remaining for foodbank 43 (dundee)",
      "charity-ni-dlq: foodbank 44 (belfast) exhausted retries",
      "charity-ni-dlq: failed to decrement crawlset remaining for foodbank 44 (belfast)",
    ]);
  });
});

// ===========================================================================
// DISPATCH
//
// Through the REAL default export in workers/jobs/src/index.ts, not a
// hand-copied switch. The queue NAME is the wiring: `batch.queue` is the only
// thing that decides which of the eleven handlers runs, and the strings in
// index.ts:36-47 have to match wrangler.jsonc's consumer list exactly. A typo
// in either falls through to `default:`, which logs "unhandled queue" and
// silently drops the batch -- which is how jobs-dlq and cache-purge-dlq sat
// unconsumed (see index.ts:50-55). Nothing but running the real switch can
// catch that.
// ===========================================================================
describe("as the Worker's queue() dispatches it", () => {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

  it("routes charity-ew-dlq to the England & Wales handler", async () => {
    seedCrawlSet(7, 3);
    const probe = batchOf("charity-ew-dlq", [charityMessage(7, 42, "salisbury")]);

    await jobsWorker.queue(probe.batch, buildEnv(), ctx);

    expect(crawlSet(7).remaining).toBe(2);
    expect(probe.acks).toEqual(["msg-0"]);
    expect(errorLines()).toEqual(["charity-ew-dlq: foodbank 42 (salisbury) exhausted retries"]);
  });

  it("routes charity-scotland-dlq to the Scotland handler", async () => {
    seedCrawlSet(7, 3);
    const probe = batchOf("charity-scotland-dlq", [charityMessage(7, 43, "dundee")]);

    await jobsWorker.queue(probe.batch, buildEnv(), ctx);

    expect(crawlSet(7).remaining).toBe(2);
    expect(errorLines()).toEqual(["charity-scotland-dlq: foodbank 43 (dundee) exhausted retries"]);
  });

  it("routes charity-ni-dlq to the Northern Ireland handler", async () => {
    seedCrawlSet(7, 3);
    const probe = batchOf("charity-ni-dlq", [charityMessage(7, 44, "belfast")]);

    await jobsWorker.queue(probe.batch, buildEnv(), ctx);

    expect(crawlSet(7).remaining).toBe(2);
    expect(errorLines()).toEqual(["charity-ni-dlq: foodbank 44 (belfast) exhausted retries"]);
  });

  // The negative case that makes the three above mean something: a name that
  // is NOT in the switch reaches `default:` and the batch is dropped, unacked
  // and undecremented, with one log line. Seeded with a plausible near-miss
  // rather than nonsense -- "charity-ew-dlq" pluralised or renamed in
  // wrangler.jsonc without touching index.ts is the realistic way this breaks.
  it("drops a batch whose queue name is not in the switch, without acking it", async () => {
    seedCrawlSet(7, 3);
    const probe = batchOf("charity-ew-dlqs", [charityMessage(7, 42, "salisbury")]);

    await jobsWorker.queue(probe.batch, buildEnv(), ctx);

    expect(crawlSet(7).remaining).toBe(3);
    expect(probe.acks).toEqual([]);
    expect(errorLines()).toEqual(['givefood2-jobs: unhandled queue "charity-ew-dlqs"']);
  });
});
