import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../worker-configuration";
import { handleJobsDlq } from "./jobsDlq";
import worker from "../index";

// queues/jobsDlq.ts -- the shared consumer for THREE dead-letter queues:
// jobs-dlq, cache-purge-dlq and whatsapp-hook-dlq (index.ts:58-61).
//
// WHY THIS FILE IS WORTH THE LENGTH. This handler makes no durable write at
// all. Its entire output is a line on stderr, so the log line IS the
// contract -- there is no row to read back afterwards, no counter to check,
// nothing that would go visibly wrong if the line were wrong. Every other
// consumer in this directory can be caught out by its database; this one can
// only be caught out here.
//
// The module's own header says what that costs when it goes wrong: jobs-dlq
// was declared as a consumer in wrangler.jsonc but had no `case` in
// index.ts, so every message fell through to the default branch, which
// logged the QUEUE NAME and not the message. "months of failed photo
// backfills produced no record of WHICH key had failed". A test that only
// asserted "console.error was called" would pass against exactly that bug --
// the old default branch called console.error too. So the tests below assert
// the WHOLE STRING, character for character, including which identifying
// field came out of the body and in which order.
//
// PARITY WITH DJANGO: none, and deliberately so. There is no Django source
// to port here. VERIFIED by grepping /Users/jasoncartwright/Sites/foodcharity
// for dead.letter/dead_letter/dlq, case-insensitively, across the whole tree
// (.git excluded): zero hits. Django ran this work through django_tasks /
// django_tasks_db (uv.lock:359-375), a database-backed task queue with no
// dead-letter concept to port. The module cites no Django view or function
// in its header for the same reason. Stated rather than left implied, so
// nobody goes hunting for the Django line these tests "should" cite.
//
// WHAT THE CONFIG EXPECTS OF IT, from workers/jobs/wrangler.jsonc (read, not
// remembered): all three of these queues are declared
// `{ max_batch_size: 10, max_retries: 1 }` with NO dead_letter_queue of
// their own. That makes three properties below load-bearing rather than
// stylistic:
//   * a message this handler does not ack is redelivered exactly once and
//     then dropped for ever, behind nothing at all;
//   * a batch is up to 10 messages, so "one line per message" is the normal
//     case on a bad night, not an edge case;
//   * the module's "NEITHER RETRIES" is the difference between a poison
//     message being logged once and it being logged twice before vanishing.
//
// REAL THINGS, NOT MOCKS. There is nothing here to fake: the handler opens
// no D1 session, touches no KV, R2 or queue binding, and makes no fetch. The
// tests prove that rather than assuming it -- `env` is handed in as a Proxy
// that throws on ANY property access, and `fetch` is spied on, so a future
// "while we're here, let's record a FoodbankDiscrepancy" fails loudly
// instead of quietly adding a D1 dependency to the one consumer that is
// supposed to survive D1 being down.
//
// The dispatch tests at the bottom mount the REAL default export from
// index.ts rather than a hand-copied switch. The original bug was a missing
// `case`, which is invisible to any test that calls the handler directly --
// the handler was always correct; nothing reached it.
//
// MOCKED, and only this: `console.error`/`console.log`/`console.warn`, which
// are spied rather than replaced, because for this consumer they are the
// only observable the production system has.
//
// MUTATION-TESTED (TESTING.md's convention: the evidence a test is
// load-bearing rather than decoration). The repo was copied to a scratchpad
// outside it -- no file in the repo was edited at any point -- and 38 mutants
// injected one at a time across jobsDlq.ts and the index.ts dispatch, with
// this file re-run against each. All 38 are killed: the ack deleted, doubled,
// turned into a retry, replaced by batch.ackAll(), and MOVED AHEAD OF THE
// LOG; the loop cut to its first message and given an early return; the
// queue label hardcoded; the body appended to the log line; the level dropped
// to log and to warn; the prefix reworded; both placeholders reworded; `??`
// swapped for `||`; the needId guard turned into a truthiness test and into
// `!= undefined`; the key guard turned into `!== undefined`; the tags guard
// stripped of its `.length`; each of the four identifying fields deleted in
// turn; the field separator and the tag separator each given an extra
// character; the tag list reduced to its first entry; needId hoisted ahead of
// key; the empty-body guard narrowed to `=== undefined`, to `=== null`, and
// deleted; the whole line reduced to the type; a D1 session opened and a
// fetch bolted on; and in index.ts each of the three `case` labels deleted,
// the default branch silenced, and the default branch made to ackAll().
//
// ONE SURVIVED THE FIRST PASS: `batch.ackAll()` added to index.ts's default
// branch. The unwired-queue test asserted only that the message's own `ack`
// was never called, which ackAll leaves untouched -- so the batch-wide
// counters are asserted there too now. See that test's own comment.
//
// MUTATION-TESTED AGAIN ON REVIEW, independently and from scratch: 77
// mutants, run one at a time against a source-only copy of the repo outside
// the working tree (node_modules symlinked back to it; nothing in the repo
// was edited at any point). The list overlaps the one above and adds, among
// others: the tags guard made `Array.isArray`-safe (which FIXES the crash
// two blocks up, and must therefore fail -- this file pins the crash);
// `describe()` wrapped in a try/catch that logs a fallback; the per-message
// log replaced by one joined summary line per batch; a module-level dedupe
// cache suppressing a redelivered message's second line; `if
// (message.attempts > 1) message.ack()`; the handler de-`async`ed;
// `if (body.key)` swapped for `"key" in body` (which throws on the primitive
// bodies two blocks up); `parts.filter(Boolean).join(" ")` (which tidies
// away the empty-type double space); `needId=${Number(body.needId)}`; the
// loop sliced short at each end; and, in index.ts, jobs-dlq rerouted to
// handleArticlesDlq and the default branch replaced by a fall-through into
// this handler.
//
// TWO OF THE 77 WERE EQUIVALENT MUTANTS, not survivors, and are recorded
// here because the distinction matters to whoever reads this next: adding
// `case "articles-dlq":` to this handler's fall-through group changes
// nothing at all, because index.ts already has that label EARLIER in the
// same switch and the first matching label wins -- the added one is dead
// code, and a mutation run that scored it as a survivor would be reporting
// its own mistake. The form that bites is the queue MOVED: its own case
// deleted and its name added to this group.
//
// TEN MUTANTS OF THAT MOVED FORM SURVIVED THE WHOLE FILE -- every consumer
// index.ts routes elsewhere, live queues and dead-letter queues alike, run
// one at a time with the last test in this file deleted, all ten green. With
// it, all ten fail. That test is the one genuine hole this review found.
//
// FIVE TESTS SURVIVED AN EMPTY HANDLER BODY when the whole loop was deleted,
// which is the other half of what a mutation run is for. Two legitimately
// assert an absence (the empty batch, and the unwired queue, where nothing
// happening IS the behaviour). The other three -- "never retries a message",
// "never uses ackAll or retryAll" and "makes no network call" -- counted
// only what did not happen, so each now also asserts the lines and the acks
// that did. The "does not answer for %s" family is an absence assertion by
// construction and stays one: what it pins is index.ts's routing, not this
// handler's work.

// ===========================================================================
// HARNESS
// ===========================================================================

/**
 * The handler's own parameter types, taken from the function rather than
 * re-declared. `UnknownJob` is deliberately NOT exported by the module and
 * must stay that way (exporting a type purely to reach it from a test is how
 * a test starts constraining a module's public surface), so this is how the
 * batch gets its type without touching the source.
 */
type DlqBatch = Parameters<typeof handleJobsDlq>[0];

/**
 * Every observable event -- a log line, an ack, a retry -- in the order it
 * happened.
 *
 * WHY AN INTERLEAVED LOG rather than separate counters. The two things this
 * handler does per message have an ORDER that no count can see, and the
 * order is the whole point of the module: acking first and logging second
 * still logs exactly once and acks exactly once, so every count-based
 * assertion passes -- but an invocation that dies in that window has told
 * the queue the message is consumed and left no record of what it was, which
 * is precisely the "dead letter office that burns the post" the module's
 * header was written against.
 */
let events: string[];

/** What one message recorded about how the handler disposed of it. */
interface Disposal {
  acks: number;
  /** One entry per retry() call, holding whatever options were passed. */
  retries: unknown[];
}

interface FakeBatch {
  batch: DlqBatch;
  /** Parallel to the bodies handed to makeBatch. */
  disposals: Disposal[];
  /** The batch-wide escape hatches, which this handler must never use. */
  batchWide: { ackAll: number; retryAll: number };
}

/**
 * A MessageBatch double.
 *
 * `ackAll`/`retryAll` are present and counted rather than omitted: a handler
 * that called `batch.ackAll()` once instead of acking per message would
 * leave every per-message counter at zero, and without these the failure
 * would read as "ackAll is not a function" rather than as the behaviour
 * change it is. Every message carries a real `retry` for the same reason --
 * "this consumer never retries" is then measured, not inferred from the
 * absence of a call site.
 *
 * `attempts` is 1 and nothing asserts on it. The handler never reads it (it
 * has no backoff and no give-up threshold of its own), so any value would
 * do; it is here because Message requires it, and this comment exists so
 * that 1 is not later mistaken for a checked claim about how Cloudflare
 * numbers attempts on a redelivery into a dead-letter queue.
 */
function makeBatch(bodies: unknown[], queue = "jobs-dlq"): FakeBatch {
  const disposals: Disposal[] = [];
  const batchWide = { ackAll: 0, retryAll: 0 };
  const messages = bodies.map((body, index) => {
    const disposal: Disposal = { acks: 0, retries: [] };
    disposals.push(disposal);
    return {
      id: `msg-${index + 1}`,
      timestamp: new Date("2026-09-05T19:28:08.853Z"),
      attempts: 1,
      body,
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
  } as unknown as DlqBatch;
  return { batch, disposals, batchWide };
}

/** Every console.error call, as [firstArg, ...rest]. */
let errors: unknown[][];
/** console.log / console.warn, which this consumer must never reach for. */
let logs: unknown[][];
let warns: unknown[][];

/** Just the message strings -- what the log line's exact format is asserted on. */
function errorLines(): string[] {
  return errors.map((args) => String(args[0]));
}

/**
 * Runs one body through the handler and hands back the single line it
 * produced. Most of the tests below are about which characters come out of a
 * message body, and this keeps that visible instead of buried in setup.
 */
async function lineFor(body: unknown, queue = "jobs-dlq"): Promise<string> {
  const { batch } = makeBatch([body], queue);
  await handleJobsDlq(batch, hostileEnv());
  expect(errorLines()).toHaveLength(1);
  return errorLines()[0]!;
}

/**
 * An Env that throws on ANY property read.
 *
 * This is the strongest available statement of "the handler touches no
 * binding", and it is not hypothetical: the sibling DLQ consumers
 * (articlesDlq.ts, charityDlq.ts) both open `env.DB.withSession(...)` on
 * entry, so "do what the other DLQ handlers do" is a plausible edit to make
 * to this file. It must not be made here. These three queues have no
 * bookkeeping to undo -- the module says so -- and a D1 read added on this
 * path would mean a dead-letter queue that cannot record failures during
 * precisely the D1 outage that filled it.
 */
function hostileEnv(): Env {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`jobsDlq must not read env.${String(property)}`);
      },
    },
  ) as Env;
}

beforeEach(() => {
  events = [];
  errors = [];
  logs = [];
  warns = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args);
    events.push(`log:${String(args[0])}`);
  });
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(args));
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warns.push(args));
  // Not a stub for anything the handler calls -- there is no network call to
  // stand in for. It is here so that a fetch appearing on this path (a
  // "let's post the failure to Slack" edit, say) fails as an assertion
  // rather than as a real request from a test run.
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("jobsDlq must not make a network call");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// THE LOG LINE -- the only thing this consumer produces
// ===========================================================================
describe("the log line", () => {
  // The exact string, because the exact string is the deliverable. The bug
  // this module fixed produced `unhandled queue "jobs-dlq"` -- a line that
  // was logged, was at error level, and named the right queue, and was still
  // useless because it did not name the message. Any assertion weaker than
  // the whole string would have passed against it.
  //
  // The key is a real one: routes/media.ts:115 sends `{ type:
  // "media-backfill", key }` and mediaBackfill/placePhoto.ts's
  // FOODBANK_PHOTO_RE is `^media/needs/at/([^/]+)/photo\.jpg$`.
  it("names the queue, the job type and the failing key", async () => {
    const line = await lineFor({ type: "media-backfill", key: "media/needs/at/salisbury/photo.jpg" });

    expect(line).toBe("jobs-dlq: gave up on media-backfill key=media/needs/at/salisbury/photo.jpg");
  });

  // One argument, and that argument a string. `console.error(msg,
  // message.body)` is the obvious "why not just log the whole thing"
  // simplification and the module's own comment rejects it ("Enough to
  // identify the failure without dumping a whole message body into the
  // log"). It matters most for the queue that carries no identifying fields
  // at all: a whatsapp-hook body is Meta's raw webhook payload, whose
  // `messages[].from` is a subscriber's PHONE NUMBER, and observability is
  // on with head_sampling_rate 1 (wrangler.jsonc), so a body dumped here is
  // a phone number in the log stream of every failure.
  it("logs exactly one argument, a string, never the body object", async () => {
    const body = { type: "media-backfill", key: "media/needs/at/salisbury/photo.jpg" };
    const { batch } = makeBatch([body]);

    await handleJobsDlq(batch, hostileEnv());

    expect(errors).toHaveLength(1);
    expect(errors[0]).toHaveLength(1);
    expect(typeof errors[0]![0]).toBe("string");
  });

  // max_batch_size is 10 on all three of these queues (wrangler.jsonc), so a
  // batch of several failures is the ordinary case. A handler that logged
  // once per batch -- a summary line, or a log hoisted out of the loop --
  // would lose every key but one, which is the same information loss the
  // module was written to end.
  it("logs one line per message, in batch order", async () => {
    const { batch } = makeBatch([
      { type: "media-backfill", key: "media/needs/at/salisbury/photo.jpg" },
      { type: "media-backfill", key: "media/needs/at/trussell/map-500x300.png" },
      { type: "order-lines", jobId: "job-3" },
    ]);

    await handleJobsDlq(batch, hostileEnv());

    expect(errorLines()).toEqual([
      "jobs-dlq: gave up on media-backfill key=media/needs/at/salisbury/photo.jpg",
      "jobs-dlq: gave up on media-backfill key=media/needs/at/trussell/map-500x300.png",
      "jobs-dlq: gave up on order-lines jobId=job-3",
    ]);
  });

  // At error level, and at error level only. cachePurge.ts uses console.log
  // for its successes and console.error for its failures, so the levels
  // carry meaning in this Worker: everything reaching a dead-letter queue is
  // a failure, and a line demoted to console.log would drop out of an
  // error-filtered log view -- which is the only view anyone opens.
  it("says nothing at log or warn level", async () => {
    const { batch } = makeBatch([{ type: "media-backfill", key: "media/needs/at/salisbury/photo.jpg" }]);

    await handleJobsDlq(batch, hostileEnv());

    expect(logs).toEqual([]);
    expect(warns).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

// ===========================================================================
// WHICH FIELD IDENTIFIES THE FAILURE
//
// describe() in the module picks one identifying field per job type. These
// tests use the bodies the REAL producers send -- each one read from its
// producer, cited inline -- because a field name that drifted from its
// producer would render as a line with the type and nothing after it, which
// still looks like a working log line.
// ===========================================================================
describe("the identifying field, per job type", () => {
  // routes/media.ts:115. The photo-backfill case the module header names.
  it("media-backfill: the R2 key", async () => {
    expect(await lineFor({ type: "media-backfill", key: "media/needs/at/salisbury/donationpoint/tesco/photo.jpg" })).toBe(
      "jobs-dlq: gave up on media-backfill key=media/needs/at/salisbury/donationpoint/tesco/photo.jpg",
    );
  });

  // routes/admin/foodbankCheck.ts:94 sends `{ type, jobId, foodbankSlug }`.
  // The slug does NOT survive: it is not one of the five fields describe()
  // knows. So a dead-lettered AI check is identified only by a uuid that
  // exists in the admin_job table, and finding out WHICH food bank it was
  // needs a database lookup. Asserted as-is because it is what the code
  // does; reported as a suspect, because foodbankSlug is right there in the
  // body and the whole purpose of the line is to say what failed.
  it("foodbank-check: the jobId, and not the food bank slug beside it", async () => {
    const line = await lineFor({ type: "foodbank-check", jobId: "7a1f0c2e-0b3d-4a11-9f52-2c9b1d0e4a77", foodbankSlug: "salisbury" });

    expect(line).toBe("jobs-dlq: gave up on foodbank-check jobId=7a1f0c2e-0b3d-4a11-9f52-2c9b1d0e4a77");
    expect(line).not.toContain("salisbury");
  });

  // routes/admin/orderForm.ts:376 sends `{ type, jobId, orderRowId }`.
  // Same shape of loss as foodbank-check: the row id is dropped.
  it("order-lines: the jobId, and not the order row id beside it", async () => {
    const line = await lineFor({ type: "order-lines", jobId: "b2c3d4e5-1111-2222-3333-444455556666", orderRowId: 918 });

    expect(line).toBe("jobs-dlq: gave up on order-lines jobId=b2c3d4e5-1111-2222-3333-444455556666");
    expect(line).not.toContain("918");
  });

  // routes/admin/needs.ts:195 sends ONE MESSAGE PER LANGUAGE for a single
  // need (`TRANSLATE_LANGUAGES.map(...)` over cy/ga/gd). `language` is not a
  // field describe() knows, so three dead-lettered translations of one need
  // produce three IDENTICAL lines -- and a maintainer reading them cannot
  // tell one permanently-broken language from all three being down. Pinned
  // rather than fixed, and reported.
  it("translate-need: the needId only, so all three languages log the same line", async () => {
    const { batch } = makeBatch([
      { type: "translate-need", needId: 40122, language: "cy" },
      { type: "translate-need", needId: 40122, language: "ga" },
      { type: "translate-need", needId: 40122, language: "gd" },
    ]);

    await handleJobsDlq(batch, hostileEnv());

    expect(errorLines()).toEqual([
      "jobs-dlq: gave up on translate-need needId=40122",
      "jobs-dlq: gave up on translate-need needId=40122",
      "jobs-dlq: gave up on translate-need needId=40122",
    ]);
  });

  // routes/admin/needs.ts:246-250. needEmail.ts's messages self-page on
  // `afterId` (a keyset cursor over subscriber ids), and afterId is dropped
  // here too -- so the line says a notification run died but not how far
  // through 5,855 subscribers it got.
  it("notify-need-email: the needId, and not the paging cursor", async () => {
    expect(await lineFor({ type: "notify-need-email", needId: 40122, afterId: 3175 })).toBe("jobs-dlq: gave up on notify-need-email needId=40122");
  });

  // cachePurge.ts's CachePurgeMessage is `{ tags?: string[] }` -- there is no
  // `type` field on it at all, so every cache-purge-dlq line opens with the
  // placeholder. The tags are the useful half and they do survive.
  // Tag spellings from packages/urls/src/cacheTags.ts (fb-<slug>, pc-<slug>,
  // AGGREGATE_TAG = "fb-all").
  it("cache-purge: the tag list, with no type to name", async () => {
    expect(await lineFor({ tags: ["fb-salisbury", "pc-salisbury", "fb-all"] }, "cache-purge-dlq")).toBe(
      "cache-purge-dlq: gave up on (no type) tags=fb-salisbury,pc-salisbury,fb-all",
    );
  });

  // THE WORST CASE, and the reason this test exists as its own case rather
  // than as a footnote. whatsapp-hook carries Meta's raw webhook body
  // (whatsappHook.ts:30-32: "The site Worker enqueues what it received,
  // unparsed"), which has none of the five fields describe() looks for. So
  // every message dead-lettered from whatsapp-hook logs the same eleven
  // characters and nothing else -- no phone number, no command, no message
  // id -- which is EXACTLY the failure mode the module was written to end,
  // still present for one of the three queues it was wired to.
  //
  // A dropped `unsubscribe` is not bookkeeping: whatsappHook.ts's header
  // calls an unexercisable opt-out "worse than a channel that never sends".
  // Pinned as-is and reported; asserting the wish would leave a red suite.
  it("whatsapp-hook: nothing at all beyond the placeholder", async () => {
    const metaPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "102290129340398",
          changes: [
            {
              field: "messages",
              value: { messages: [{ from: "447700900123", id: "wamid.HBgLNDQ3NzAwOTAwMTIz", type: "text", text: { body: "unsubscribe salisbury" } }] },
            },
          ],
        },
      ],
    };

    const line = await lineFor(metaPayload, "whatsapp-hook-dlq");

    expect(line).toBe("whatsapp-hook-dlq: gave up on (no type)");
    expect(line).not.toContain("447700900123");
    expect(line).not.toContain("unsubscribe");
  });

  // The order is fixed by describe()'s own sequence of pushes, not by the
  // body's key order. Worth pinning because these lines are grepped: a line
  // whose field order followed whatever JSON.parse handed back would defeat
  // any grep more specific than the type name.
  it("emits type, key, jobId, needId, tags in that order whatever order the body has them", async () => {
    const line = await lineFor({ tags: ["fb-all"], needId: 7, jobId: "job-9", key: "media/needs/at/x/photo.jpg", type: "kitchen-sink" });

    expect(line).toBe("jobs-dlq: gave up on kitchen-sink key=media/needs/at/x/photo.jpg jobId=job-9 needId=7 tags=fb-all");
  });

  // Multiple tags join on a bare comma, no space. Pinned because the
  // separator is what makes the line greppable for a single tag.
  it("joins tags with a comma and no space", async () => {
    expect(await lineFor({ tags: ["fb-a", "fb-b", "fb-c"] })).toBe("jobs-dlq: gave up on (no type) tags=fb-a,fb-b,fb-c");
  });
});

// ===========================================================================
// FIELD SELECTION AT THE EDGES
//
// describe() uses three different emptiness tests -- truthiness for key and
// jobId, `!== undefined` for needId, `?.length` for tags -- and each one
// behaves differently for the falsy value of its own type. These are the
// mutants that a happy-path body cannot catch.
// ===========================================================================
describe("which fields are considered present", () => {
  // `body.needId !== undefined`, not `if (body.needId)`. Django's own ids
  // start at 1 so a real needId is never 0 today, but the distinction is
  // free to keep and a truthiness check here would silently drop the id from
  // exactly one message in the corpus if it ever were.
  it("keeps needId when it is 0", async () => {
    expect(await lineFor({ type: "translate-need", needId: 0 })).toBe("jobs-dlq: gave up on translate-need needId=0");
  });

  // Same test, the other way: an explicit `undefined` is indistinguishable
  // from an absent key and is omitted.
  it("drops needId when it is explicitly undefined", async () => {
    expect(await lineFor({ type: "translate-need", needId: undefined })).toBe("jobs-dlq: gave up on translate-need");
  });

  // `!== undefined` lets null through, and `needId=null` reaches the log.
  // Suspect -- it is a value no producer sends and it reads like a real id
  // until you look twice -- but pinned as what the code does.
  it("prints needId=null for a null needId, because the guard only excludes undefined", async () => {
    expect(await lineFor({ type: "translate-need", needId: null as unknown as number })).toBe("jobs-dlq: gave up on translate-need needId=null");
  });

  // `if (body.key)` -- an empty string is dropped rather than printed as
  // `key=`. This is the case that tells the two guards apart: a media
  // backfill enqueued with an empty key logs as a bare type, and the line
  // gives no hint that a key field was even present.
  it("drops key and jobId when they are empty strings", async () => {
    expect(await lineFor({ type: "media-backfill", key: "" })).toBe("jobs-dlq: gave up on media-backfill");
    errors = [];
    expect(await lineFor({ type: "order-lines", jobId: "" })).toBe("jobs-dlq: gave up on order-lines");
  });

  // `body.tags?.length` -- an empty array is omitted entirely rather than
  // printed as `tags=`. That matters for cache-purge specifically:
  // cachePurge.ts:92-97 treats a message with no tags as a purge_everything,
  // so `tags: []` and no tags at all mean the same thing there, and the log
  // agrees with it.
  it("drops tags when the array is empty", async () => {
    expect(await lineFor({ tags: [] })).toBe("jobs-dlq: gave up on (no type)");
  });

  // `join` renders null and undefined entries as empty strings, so a tag
  // list with a hole logs a trailing comma and one tag fewer than it had.
  // Nothing produces such a list today (cacheTags.ts only ever returns
  // template strings); pinned so that a producer that starts mapping over
  // possibly-missing slugs shows up here rather than as a quietly short line.
  it("renders a null inside the tag list as an empty segment", async () => {
    expect(await lineFor({ tags: ["fb-a", null as unknown as string] })).toBe("jobs-dlq: gave up on (no type) tags=fb-a,");
  });

  // `body.type ?? "(no type)"`, not `||`. An empty-string type is therefore
  // KEPT, and joining it with the rest leaves a double space after "on":
  //   "jobs-dlq: gave up on  key=..."
  // Suspect and reported -- `||` would read better here and nothing wants a
  // literal empty type -- but this is what the code does, and the assertion
  // is written with the two spaces visible so nobody "tidies" them away.
  it("keeps an empty-string type, leaving a double space where the type should be", async () => {
    expect(await lineFor({ type: "", key: "media/needs/at/x/photo.jpg" })).toBe("jobs-dlq: gave up on  key=media/needs/at/x/photo.jpg");
  });

  // A null type falls to the placeholder (`??` catches null as well as
  // undefined), which is the half of `??` that behaves as anyone would want.
  it("falls back to the placeholder for a null type", async () => {
    expect(await lineFor({ type: null as unknown as string, jobId: "job-1" })).toBe("jobs-dlq: gave up on (no type) jobId=job-1");
  });
});

// ===========================================================================
// THE QUEUE LABEL
// ===========================================================================
describe("the queue label", () => {
  // `${batch.queue}`, not a hardcoded "jobs-dlq". This is the property that
  // lets ONE handler serve three queues (index.ts:58-61), and it is the
  // opposite choice from articlesDlq.ts, which hardcodes its own label. A
  // mutant that hardcoded "jobs-dlq" here would file every failed cache
  // purge and every dropped WhatsApp opt-out under the wrong queue name --
  // and since the line is the only record, it would be the wrong name for
  // ever.
  it("uses the queue the batch actually arrived on, for each of the three", async () => {
    for (const queue of ["jobs-dlq", "cache-purge-dlq", "whatsapp-hook-dlq"]) {
      errors = [];
      expect(await lineFor({ type: "media-backfill", key: "media/needs/at/x/photo.jpg" }, queue)).toBe(
        `${queue}: gave up on media-backfill key=media/needs/at/x/photo.jpg`,
      );
    }
  });

  // Read from the batch per invocation rather than captured once at module
  // load. Belt and braces against a refactor that hoisted the label into a
  // module-level constant "since it never changes" -- it changes three ways.
  it("relabels between invocations rather than remembering the first queue it saw", async () => {
    const first = makeBatch([{ type: "order-lines", jobId: "job-1" }], "jobs-dlq");
    const second = makeBatch([{ tags: ["fb-all"] }], "cache-purge-dlq");

    await handleJobsDlq(first.batch, hostileEnv());
    await handleJobsDlq(second.batch, hostileEnv());

    expect(errorLines()).toEqual([
      "jobs-dlq: gave up on order-lines jobId=job-1",
      "cache-purge-dlq: gave up on (no type) tags=fb-all",
    ]);
  });
});

// ===========================================================================
// MESSAGE DISPOSAL
// ===========================================================================
describe("message disposal", () => {
  it("acks every message exactly once", async () => {
    const { batch, disposals } = makeBatch([
      { type: "media-backfill", key: "media/needs/at/a/photo.jpg" },
      { type: "media-backfill", key: "media/needs/at/b/photo.jpg" },
      { type: "media-backfill", key: "media/needs/at/c/photo.jpg" },
    ]);

    await handleJobsDlq(batch, hostileEnv());

    expect(disposals.map((d) => d.acks)).toEqual([1, 1, 1]);
  });

  // LOGS FIRST, THEN ACKS. Swapping the two still logs once and acks once,
  // so every counting assertion above survives it -- this is the only test
  // that sees the difference. It is a real property, not a stylistic one: an
  // ack is a promise to the queue that the message is dealt with, and on
  // these queues (max_retries 1, no dead_letter_queue behind them,
  // wrangler.jsonc) a message acked before its line is written and then lost
  // to an eviction is gone with no record anywhere. The record is the entire
  // product of this consumer.
  it("logs each message before acking it, message by message", async () => {
    const { batch } = makeBatch([
      { type: "order-lines", jobId: "job-1" },
      { type: "order-lines", jobId: "job-2" },
    ]);

    await handleJobsDlq(batch, hostileEnv());

    expect(events).toEqual([
      "log:jobs-dlq: gave up on order-lines jobId=job-1",
      "ack:msg-1",
      "log:jobs-dlq: gave up on order-lines jobId=job-2",
      "ack:msg-2",
    ]);
  });

  // "NEITHER RETRIES. A message is here because it already exhausted its
  // retries on the real queue; retrying it a fourth time is how a poison
  // message becomes an infinite loop." (module header). With max_retries 1
  // on all three queues a retry is not actually infinite -- it is one more
  // delivery and then a permanent drop -- but it is one more paid invocation
  // and one more duplicate line for every message, for nothing.
  it("never retries a message", async () => {
    const { batch, disposals } = makeBatch([{ type: "media-backfill", key: "media/needs/at/a/photo.jpg" }, undefined, { tags: ["fb-all"] }]);

    await handleJobsDlq(batch, hostileEnv());

    expect(disposals.flatMap((d) => d.retries)).toEqual([]);
    expect(events.filter((e) => e.startsWith("retry:"))).toEqual([]);
    // The positive half, and not decoration: an assertion that only counts
    // what did NOT happen passes against an EMPTY handler body, which is the
    // one implementation that also never retries. Measured, not assumed --
    // the loop was replaced with nothing in a copy of the repo and this test
    // was one of only five in the file that survived it.
    expect(errorLines()).toEqual([
      "jobs-dlq: gave up on media-backfill key=media/needs/at/a/photo.jpg",
      "jobs-dlq: gave up on (empty body)",
      "jobs-dlq: gave up on (no type) tags=fb-all",
    ]);
    expect(disposals.map((d) => d.acks)).toEqual([1, 1, 1]);
  });

  // Per-message ack, never the batch-wide shortcut. `batch.ackAll()` would
  // be behaviourally equivalent TODAY -- every message is acked -- and that
  // is exactly why it needs pinning: it stops being equivalent the moment
  // anything in the loop can throw (see the malformed-tags case below),
  // where ackAll before the loop would swallow the message that crashed it.
  it("never uses ackAll or retryAll", async () => {
    const { batch, batchWide, disposals } = makeBatch([{ type: "order-lines", jobId: "job-1" }, { type: "order-lines", jobId: "job-2" }]);

    await handleJobsDlq(batch, hostileEnv());

    expect(batchWide).toEqual({ ackAll: 0, retryAll: 0 });
    // Same reason as the retry test above: "used neither shortcut" is also
    // true of a handler that does nothing whatsoever, so the per-message
    // acks and the lines are asserted here too. Without them this test
    // survived the empty-implementation mutant.
    expect(disposals.map((d) => d.acks)).toEqual([1, 1]);
    expect(errorLines()).toEqual([
      "jobs-dlq: gave up on order-lines jobId=job-1",
      "jobs-dlq: gave up on order-lines jobId=job-2",
    ]);
  });

  // A full batch at the configured ceiling. Nothing here is per-message
  // expensive, so this is really a check that the loop has no accidental
  // early `return` -- a `return` in place of a `continue` is a one-character
  // edit that drops nine of ten failures and logs the first one perfectly.
  it("handles a full batch of 10, the configured max_batch_size", async () => {
    const bodies = Array.from({ length: 10 }, (_, i) => ({ type: "media-backfill", key: `media/needs/at/fb-${i}/photo.jpg` }));
    const { batch, disposals } = makeBatch(bodies);

    await handleJobsDlq(batch, hostileEnv());

    // All ten lines, not a count and a spot check on the last one: a count
    // plus one sampled element is satisfied by a middle line rendered from
    // the wrong message, and the whole reason this test seeds ten DISTINCT
    // keys is that the tenth failure of a bad night must be as identifiable
    // as the first.
    expect(errorLines()).toEqual(bodies.map((b) => `jobs-dlq: gave up on media-backfill key=${b.key}`));
    expect(disposals.map((d) => d.acks)).toEqual(Array.from({ length: 10 }, () => 1));
  });

  it("does nothing at all, quietly, for an empty batch", async () => {
    const { batch, batchWide } = makeBatch([]);

    await expect(handleJobsDlq(batch, hostileEnv())).resolves.toBeUndefined();

    expect(errors).toEqual([]);
    expect(batchWide).toEqual({ ackAll: 0, retryAll: 0 });
  });
});

// ===========================================================================
// MALFORMED MESSAGES
//
// Everything here is a body no producer in this repo sends. They are tested
// because a dead-letter queue is where malformed messages END UP -- a body
// that a consumer could not parse is a common reason for one to have
// exhausted its retries in the first place, so this handler sees the worst
// bodies in the system by construction.
// ===========================================================================
describe("malformed messages", () => {
  // Cloudflare delivers `undefined` for a message published with no body.
  // Contrast articlesDlq.ts, which dereferences `message.body.foodbankId`
  // and throws on this input -- the `if (!body)` guard here is what makes
  // this consumer the one that survives it.
  it("logs a placeholder and acks when the body is undefined", async () => {
    const { batch, disposals } = makeBatch([undefined]);

    await handleJobsDlq(batch, hostileEnv());

    expect(errorLines()).toEqual(["jobs-dlq: gave up on (empty body)"]);
    expect(disposals[0]!.acks).toBe(1);
  });

  it("logs a placeholder and acks when the body is null", async () => {
    const { batch, disposals } = makeBatch([null]);

    await handleJobsDlq(batch, hostileEnv());

    expect(errorLines()).toEqual(["jobs-dlq: gave up on (empty body)"]);
    expect(disposals[0]!.acks).toBe(1);
  });

  // The `!body` guard is a TRUTHINESS test, not a null check, so every falsy
  // primitive reads as "(empty body)" -- including a body that is the number
  // 0 or an empty string, which are not empty at all, merely falsy. Pinned
  // because the alternative is a crash: `(0).type` is fine, but the guard is
  // what stops the line reading "(no type)" and pretending it saw an object.
  it("calls falsy primitive bodies empty", async () => {
    for (const body of [0, "", false, Number.NaN]) {
      errors = [];
      expect(await lineFor(body)).toBe("jobs-dlq: gave up on (empty body)");
    }
  });

  // Truthy non-objects have no fields to find, so they degrade to the
  // placeholder rather than throwing. A JSON body of a bare string is what a
  // producer sending `JSON.stringify(x)` instead of `x` would leave behind.
  it("survives truthy non-object bodies", async () => {
    for (const body of ["media-backfill", 42, true, []]) {
      errors = [];
      expect(await lineFor(body)).toBe("jobs-dlq: gave up on (no type)");
    }
  });

  // THE ONE INPUT THAT CRASHES THIS HANDLER, and the reason this block is
  // not just belt-and-braces. `tags` is guarded with `body.tags?.length`,
  // which a STRING also satisfies, and the next line calls `.join(",")` on
  // it. A cache-purge message published as `{ tags: "fb-all" }` rather than
  // `{ tags: ["fb-all"] }` therefore throws a TypeError out of the consumer.
  //
  // Consequence, which is why it is worth a test rather than a shrug: the
  // throw happens INSIDE the console.error argument, so the message that
  // caused it is never logged and never acked. Cloudflare redelivers the
  // batch, the same body throws again, max_retries is 1 and there is no
  // dead-letter queue behind cache-purge-dlq -- so the batch is dropped, and
  // with it the log lines for every message BEHIND the bad one. One
  // malformed body silently erases up to nine unrelated failure records.
  //
  // Asserted, not fixed, per this repo's convention; reported as a suspect.
  it("throws out of the consumer when tags is a string rather than an array", async () => {
    const { batch, disposals } = makeBatch([
      { type: "order-lines", jobId: "job-1" },
      { tags: "fb-all" },
      { type: "order-lines", jobId: "job-3" },
    ]);

    await expect(handleJobsDlq(batch, hostileEnv())).rejects.toThrow(TypeError);

    // The messages ahead of it are logged and acked; the bad one and
    // everything behind it are neither.
    expect(errorLines()).toEqual(["jobs-dlq: gave up on order-lines jobId=job-1"]);
    expect(disposals.map((d) => d.acks)).toEqual([1, 0, 0]);
  });

  // Extra fields are ignored rather than dumped. Pinned alongside the
  // information-loss cases above so the trade-off is visible in one place:
  // the line is deliberately a fixed five-field summary, which is what keeps
  // a body carrying an entire Meta webhook (or a Postmark error payload)
  // from reaching the log stream.
  it("ignores fields it does not know about", async () => {
    expect(await lineFor({ type: "media-backfill", key: "media/needs/at/x/photo.jpg", error: "HTTP 429 from Google Places", attempts: 4 })).toBe(
      "jobs-dlq: gave up on media-backfill key=media/needs/at/x/photo.jpg",
    );
  });
});

// ===========================================================================
// WHAT IT MUST NOT TOUCH
// ===========================================================================
describe("bindings and network", () => {
  // The hostileEnv() Proxy throws on any property read, so this passing
  // means the handler read NOTHING off env -- no DB, no DATA, no MEDIA, no
  // JOBS_Q. That is the property that makes this the DLQ consumer which
  // still works when the thing that filled it is what is broken.
  it("reads nothing off env", async () => {
    const { batch, disposals } = makeBatch([{ type: "media-backfill", key: "media/needs/at/x/photo.jpg" }]);

    await expect(handleJobsDlq(batch, hostileEnv())).resolves.toBeUndefined();

    expect(disposals[0]!.acks).toBe(1);
  });

  // Stronger still, and honest about why: the parameter is named `_env` and
  // is genuinely unused, so the handler works with no env at all. Asserted
  // so that adding a binding read becomes a failing test rather than a
  // silent new dependency on a Worker's configuration.
  it("works with no env at all", async () => {
    const { batch, disposals } = makeBatch([{ tags: ["fb-all"] }], "cache-purge-dlq");

    await expect(handleJobsDlq(batch, undefined as unknown as Env)).resolves.toBeUndefined();

    expect(errorLines()).toEqual(["cache-purge-dlq: gave up on (no type) tags=fb-all"]);
    expect(disposals[0]!.acks).toBe(1);
  });

  it("makes no network call", async () => {
    const { batch, disposals } = makeBatch([{ type: "media-backfill", key: "media/needs/at/x/photo.jpg" }, { tags: ["fb-all"] }]);

    await handleJobsDlq(batch, hostileEnv());

    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    // And it did the work while not calling fetch -- otherwise this passes
    // against a handler that does nothing at all, which is trivially also a
    // handler that makes no network call.
    expect(errorLines()).toEqual([
      "jobs-dlq: gave up on media-backfill key=media/needs/at/x/photo.jpg",
      "jobs-dlq: gave up on (no type) tags=fb-all",
    ]);
    expect(disposals.map((d) => d.acks)).toEqual([1, 1]);
  });
});

// ===========================================================================
// REDELIVERY
//
// Cloudflare Queues is at-least-once, so the same tick can arrive twice.
// ===========================================================================
describe("redelivery", () => {
  // Idempotent in the only sense available to a handler with no state: a
  // redelivered message logs a second identical line and acks again. Worth
  // stating explicitly because "idempotent" for the other consumers in this
  // directory means "does not double-decrement", and here it means "has
  // nothing to double". A duplicate line in a dead-letter log is harmless;
  // a suppression cache to avoid it would be state this handler must not
  // have.
  it("logs and acks again on a redelivered message, holding no state between batches", async () => {
    const body = { type: "media-backfill", key: "media/needs/at/salisbury/photo.jpg" };

    const first = makeBatch([body]);
    await handleJobsDlq(first.batch, hostileEnv());
    const second = makeBatch([body]);
    await handleJobsDlq(second.batch, hostileEnv());

    expect(errorLines()).toEqual([
      "jobs-dlq: gave up on media-backfill key=media/needs/at/salisbury/photo.jpg",
      "jobs-dlq: gave up on media-backfill key=media/needs/at/salisbury/photo.jpg",
    ]);
    expect(first.disposals[0]!.acks).toBe(1);
    expect(second.disposals[0]!.acks).toBe(1);
  });
});

// ===========================================================================
// REACHABILITY THROUGH THE REAL WORKER ENTRYPOINT
//
// The bug this module fixed was NOT in the handler -- there was no handler.
// jobs-dlq was declared as a consumer in wrangler.jsonc with no matching
// `case` in index.ts, so messages fell to the default branch. Every test
// above would have passed throughout that period, because they call the
// handler directly and nothing was calling it.
//
// So these mount the REAL default export from src/index.ts. They are the
// only tests here that can fail if someone deletes a `case`.
// ===========================================================================
describe("dispatch from the real Worker entrypoint", () => {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

  // All three queue names in index.ts:58-61 fall through to this one
  // handler. Asserted by the LINE, not by a spy: a `case` that routed
  // cache-purge-dlq to some other consumer would still call something.
  it.each(["jobs-dlq", "cache-purge-dlq", "whatsapp-hook-dlq"])("routes %s to this handler", async (queue) => {
    const { batch, disposals } = makeBatch([{ type: "media-backfill", key: "media/needs/at/salisbury/photo.jpg" }], queue);

    await worker.queue(batch as unknown as MessageBatch<unknown>, hostileEnv(), ctx);

    expect(errorLines()).toEqual([`${queue}: gave up on media-backfill key=media/needs/at/salisbury/photo.jpg`]);
    expect(disposals[0]!.acks).toBe(1);
  });

  // THE GROUP IS THREE QUEUES, AND NOTHING ELSE MAY JOIN IT.
  //
  // Ten mutants survived the whole file until this test existed: each of the
  // ten other queues this Worker consumes, MOVED into index.ts's three-name
  // fall-through group -- its own `case` deleted and its name added to this
  // handler's. Nothing else here ever sends a batch on a queue that has a
  // consumer of its own, so a queue quietly swallowed by this group was
  // invisible; the "routes %s to this handler" cases above check only that
  // the three named queues arrive, never that a fourth does not.
  //
  // It is the plausible kind of edit, not the contrived kind. This handler's
  // header says its whole job is "log and ack, there is no bookkeeping to
  // undo", which reads as an invitation to file any other DLQ under it --
  // and articles-dlq is two lines away in the same switch. The live queues
  // are in the list for a worse reason: "whatsapp-hook" is one suffix away
  // from "whatsapp-hook-dlq", and a fall-through that swallowed it would ack
  // every inbound subscribe and unsubscribe with a "gave up on" line and no
  // reply -- precisely the silent opt-out drop (WP 4.8 until 2026-09-05, per
  // index.ts's own comment) that wiring whatsapp-hook up was meant to end.
  //
  // The list is every OTHER queue wrangler.jsonc declares this Worker a
  // consumer of, rather than a sample of them, so a name added later to that
  // file and misrouted here is caught by whichever of these it displaces.
  //
  // The assertion is on the LOG, not on acks: the real consumers behind
  // these names behave differently from each other under hostileEnv() --
  // handleArticlesDlq opens `env.DB.withSession` on its first line and
  // rejects, while handleWhatsappHookQueue finds no `entry[]` in the body,
  // acks and returns silently -- and neither of those is this file's
  // business. What IS this file's business is that "gave up on" never
  // appears -- and grepping workers/ and packages/ for that string, tests
  // excluded, returns exactly one line: jobsDlq.ts:50. So its presence in
  // the log means this handler ran, and nothing else can produce it.
  it.each([
    "needcheck-render",
    "needcheck-render-dlq",
    "cache-purge",
    "jobs",
    "whatsapp-hook",
    "articles",
    "articles-dlq",
    "charity-ew",
    "charity-ew-dlq",
    "charity-scotland",
    "charity-scotland-dlq",
    "charity-ni",
    "charity-ni-dlq",
  ])("does not answer for %s, which has a consumer of its own", async (queue) => {
    const { batch } = makeBatch([{ type: "media-backfill", key: "media/needs/at/salisbury/photo.jpg" }], queue);

    // Swallowed deliberately -- the sibling consumers touch bindings that
    // hostileEnv() refuses, and their failure mode is their own suite's
    // subject, not this one's.
    await worker.queue(batch as unknown as MessageBatch<unknown>, hostileEnv(), ctx).catch(() => {});

    expect(errorLines().filter((line) => line.includes("gave up on"))).toEqual([]);
  });

  // The default branch still exists and still behaves the old way for
  // anything unwired -- names the queue, names no message, acks nothing.
  // This is what jobs-dlq used to get, kept here as the direct contrast: it
  // is the difference the module was written to make, in two assertions.
  it("still drops an unwired queue on the default branch, naming only the queue", async () => {
    const { batch, disposals, batchWide } = makeBatch([{ type: "media-backfill", key: "media/needs/at/salisbury/photo.jpg" }], "some-future-dlq");

    await worker.queue(batch as unknown as MessageBatch<unknown>, hostileEnv(), ctx);

    expect(errorLines()).toEqual(['givefood2-jobs: unhandled queue "some-future-dlq"']);
    // Nothing is acked -- not per message, and not through the batch-wide
    // shortcut either. Both halves are asserted because they are separately
    // reachable: an `ackAll()` added to the default branch leaves every
    // per-message counter at zero and would otherwise look identical to the
    // current behaviour. It is not identical -- an unacked batch is
    // redelivered once (max_retries 1) and logged twice, which is the only
    // trace an unwired queue leaves anywhere.
    expect(disposals[0]!.acks).toBe(0);
    expect(batchWide).toEqual({ ackAll: 0, retryAll: 0 });
  });
});
