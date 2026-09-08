import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGGREGATE_TAG, constituencyTag, foodbankTag } from "@givefood/urls";
import { handleCachePurgeQueue, type CachePurgeMessage } from "./cachePurge";
import worker from "../index";
import type { Env } from "../../worker-configuration";

// queues/cachePurge.ts -- the cache-purge queue consumer.
//
// WHY THIS FILE IS LONG FOR A 40-LINE FUNCTION. Every single thing this
// consumer does is invisible. There is no request behind it, its only output
// is one POST to Cloudflare and a console line, and its two worst failures
// look exactly like a quiet success:
//
//   * the credential guard (`if (!env.CF_ZONE_ID || !env.CF_API_KEY)`) acks
//     the whole batch and purges nothing -- the same shape as the Browser
//     Rendering credential that broke silently for a day in this repo;
//   * a purge that Cloudflare answers `200 {"success": false}` for, which
//     `res.ok` alone would report as a success.
//
// And the consumer only started existing at all recently: it used to be a
// `message.retry()` stub in index.ts, so every purge message retried forever
// into cache-purge-dlq, which had no consumer either. The one producer that
// existed (queues/articles.ts:90) had therefore never purged anything. A test
// file that only asserted "it did not throw" would have passed against that
// stub too, so nothing below asserts absence-of-throw: every claim is about
// the request that WENT OUT (URL, zone, auth, body) and about which messages
// were acked and which were retried.
//
// REAL EVERYTHING EXCEPT CLOUDFLARE. The tag names come from the real
// @givefood/urls cacheTags module -- the same module workers/site's
// middleware/cacheTag.ts stamps responses with -- because "a tag invented
// independently on either side is a purge that silently does nothing" is this
// module's own stated failure mode, and a test with hand-typed tag strings
// could not see it. The queue routing goes through the real index.ts dispatcher
// (see the last describe block). Only `fetch` is faked, because the Cloudflare
// API is the only thing that leaves the machine.
//
// DJANGO REFERENCE, read at /Users/jasoncartwright/Sites/foodcharity:
// givefood/utils/cache.py:149-197 decache_async/decache, fired from
// Foodbank.save() (givefood/models/foodbank.py:717-758). Django enumerates the
// URLs and prefixes a food bank owns and purges those -- same endpoint
// (cache.py:166), same Bearer header (cache.py:162-165), and the same 30 per
// request, which it applies to URLs (cache.py:182-184, "We can only uncache 30
// URLs at a time") where this port applies it to tags. Where a test below
// cites either file, that file was read in the reference checkout; the port's
// own citation of "cache.py:172/196" for the discarded response is a line or
// two out against that copy, where the two requests.post calls are at 173 and
// 187 and neither result is assigned.
//
// MUTATION-TESTED per TESTING.md's convention: the repo was copied to a
// scratchpad OUTSIDE it, cachePurge.ts (and index.ts, for the dispatcher
// block) broken there on purpose, and this file re-run against each mutant.
// The number in brackets above each block is how many tests actually went red
// for that mutant.
//
// Those counts were written by the first pass, which reported 36 mutants and
// no survivors. A later adversarial pass ran 78 mutants against this file;
// every one of the first pass's that it re-ran reproduced the recorded count,
// but FIVE mutants lived, and each is now named above the test written to
// kill it:
//
//   * AbortSignal.timeout(15_000) -> timeout(150), and -> timeout(900_000):
//     nothing asserted the number, only that a signal existed and had not
//     fired;
//   * the `if (ok)` dropped from the purge_everything log (cachePurge.ts:103)
//     -- the same guard on the TAG log was covered twice, but no test made a
//     purge_everything FAIL;
//   * `!res.ok` narrowed to `res.status >= 500`, because every failing
//     response in the file also said success:false;
//   * `payload?.success !== true` relaxed to `!= true`, because `"true"` is
//     not a value that distinguishes them -- only 1 and "1" are.
//
// Four tests were added for those, two existing ones were strengthened (the
// per-chunk timeout arguments, and the log being emitted ONCE rather than per
// chunk), and the file is now clean against all 78. Both passes wrote their
// mutants as literal source substitutions in a copy of the repo under
// /private/tmp; nothing was edited in the working tree.

// ../index reaches queues/jobs.ts -> notify/needEmail.ts, which imports
// render() from a package whose src/generated/ is a gitignored build artefact.
// Nothing here renders anything; this keeps the suite working on a fresh
// checkout, which is the same reason needWhatsApp.test.ts mocks it.
vi.mock("@givefood/templates", () => ({ render: async () => "<html></html>" }));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Deliberately not the real zone. The purge endpoint is addressed by zone id,
// so a hard-coded or transposed one purges somebody else's cache and returns a
// perfectly ordinary success -- which is why the zone id is asserted inside
// the URL below rather than assumed.
const ZONE_ID = "zone-abc123-not-a-real-one";
const API_KEY = "cf-api-token-not-a-real-one";
const PURGE_URL = `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/purge_cache`;

// cachePurge.ts:48. Duplicated here on purpose: TAGS_PER_REQUEST is
// module-private, and it is not an arbitrary number -- Cloudflare answers 400
// to a tag purge naming more than 30, and a 400 is a purge that did not
// happen. Spelling it out means raising it is a visible decision.
const TAGS_PER_REQUEST = 30;

/** The real producers' message shape: routes/admin/foodbank.ts:164,
 *  routes/admin/needs.ts:177 and queues/articles.ts:90 all send exactly
 *  `{ tags: [...] }` and nothing else. */
function tagged(...tags: string[]): CachePurgeMessage {
  return { tags };
}

/** `{}` -- the message body that has no tags at all. Typed as
 *  CachePurgeMessage to pin that `tags` really is optional on the exported
 *  interface: making it required would be a compile error here, and would
 *  silently break every producer that sends a bare object. */
const NO_TAGS: CachePurgeMessage = {};

interface PurgeCall {
  url: string;
  method: string | undefined;
  authorization: string | null;
  contentType: string | null;
  signal: AbortSignal | null | undefined;
  body: { tags?: unknown; purge_everything?: unknown };
}

interface RetryRecord {
  index: number;
  options: QueueRetryOptions | undefined;
}

let purgeCalls: PurgeCall[];
/** Per-call replies, consumed in order; anything past the end is a success. */
let replies: Array<() => Promise<Response>>;
let fetchMock: ReturnType<typeof vi.fn>;
let consoleError: ReturnType<typeof vi.spyOn>;
let consoleLog: ReturnType<typeof vi.spyOn>;

/** Cloudflare's v4 success envelope for a purge. */
const purgeOk = async (): Promise<Response> => new Response(JSON.stringify({ success: true, result: { id: ZONE_ID } }), { status: 200 });

beforeEach(() => {
  purgeCalls = [];
  replies = [];
  // Records every purge request and refuses anything else: an outbound call to
  // some other host added later fails loudly here rather than in production.
  fetchMock = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    if (!url.startsWith("https://api.cloudflare.com/")) throw new Error(`unmodelled fetch: ${url}`);
    const headers = new Headers(init.headers as HeadersInit);
    purgeCalls.push({
      url,
      method: init.method,
      authorization: headers.get("Authorization"),
      contentType: headers.get("Content-Type"),
      signal: init.signal,
      body: JSON.parse(String(init.body)) as PurgeCall["body"],
    });
    return (replies.shift() ?? purgeOk)();
  });
  vi.stubGlobal("fetch", fetchMock);

  // This consumer narrates itself entirely through the console -- it is a
  // cron-shaped job with no other output -- so the spies are kept rather than
  // merely silenced: several assertions below are on the log line, because it
  // is the only signal an operator ever gets.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    CF_ZONE_ID: ZONE_ID,
    CF_API_KEY: API_KEY,
    // Present so the credential guard cannot be satisfied by some OTHER
    // secret. This Worker holds every credential at once, so in production
    // "CF_API_KEY is missing" always means "missing while the rest are set".
    CF_ACCOUNT_ID: "211195b9bf606f797a6d2dbc0bf41791",
    OPENROUTER_KEY: "test-openrouter-key",
    POSTMARK_TOKEN: "test-postmark-token",
    SITE_DOMAIN: "https://www.givefood.org.uk",
    ...overrides,
  } as Env;
}

interface Batch {
  batch: MessageBatch<CachePurgeMessage>;
  acks: number[];
  retries: RetryRecord[];
}

/** A MessageBatch whose ack/retry calls are recorded by message index.
 *  `bodies` is `unknown[]` rather than CachePurgeMessage[] because half the
 *  point of this file is what happens to bodies the type says are impossible:
 *  a queue delivers whatever JSON a producer sent. */
function batchOf(bodies: unknown[], queue = "cache-purge"): Batch {
  const acks: number[] = [];
  const retries: RetryRecord[] = [];
  const messages = bodies.map((body, index) => ({
    id: `msg-${index}`,
    timestamp: new Date("2026-09-08T12:00:00.000Z"),
    body,
    attempts: 1,
    ack: () => void acks.push(index),
    retry: (options?: QueueRetryOptions) => void retries.push({ index, options }),
  }));
  return { batch: { queue, messages, ackAll: () => {}, retryAll: () => {} } as unknown as MessageBatch<CachePurgeMessage>, acks, retries };
}

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

/** The `tags` array of each request that went out, in order. */
function tagsSent(): unknown[] {
  return purgeCalls.map((call) => call.body.tags);
}

/** N distinct tag names, shaped like real ones so a chunking bug that mangled
 *  them would still be readable in a diff. */
function manyTags(count: number): string[] {
  return Array.from({ length: count }, (_, i) => foodbankTag(`foodbank-${String(i).padStart(3, "0")}`));
}

// ---------------------------------------------------------------------------
// The credential guard
//
// MUTANTS KILLED HERE: the guard deleted entirely (4 tests -- a purge goes out
// to `zones//purge_cache` with `Authorization: Bearer undefined`); `||`
// narrowed to `&&` so one missing half falls through (3); the ack loop turned
// into a retry loop (5, and in production that is a batch retried every 60s
// three times and then parked in cache-purge-dlq for a condition that no
// amount of retrying can fix); the ack loop deleted so the branch just returns
// (5); the console.error downgraded to console.log (1).
// ---------------------------------------------------------------------------

describe("handleCachePurgeQueue -- Cloudflare credentials missing", () => {
  // The failure this repo has already lived through, in this exact shape: a
  // credential that is simply absent, a job that logs one line and returns,
  // and nothing anywhere that looks different from a working day. The
  // assertions are that NO request went out (rather than a half-formed
  // unauthenticated one) and that the messages were dropped rather than
  // retried -- both invisible without them.
  it("acks everything and purges nothing when CF_ZONE_ID is unset", async () => {
    const { batch, acks, retries } = batchOf([tagged(foodbankTag("salisbury")), tagged(AGGREGATE_TAG)]);

    await handleCachePurgeQueue(batch, buildEnv({ CF_ZONE_ID: "" }));

    expect(purgeCalls).toEqual([]);
    expect(acks).toEqual([0, 1]);
    expect(retries).toEqual([]);
    expect(consoleError).toHaveBeenCalledWith("cache-purge: CF_ZONE_ID/CF_API_KEY unset, nothing purged");
  });

  // The zone id is a plain var and the API key is a secret, so in practice
  // these two go missing for entirely different reasons. One branch covers
  // both, and this is the assertion that stops it quietly becoming a
  // zone-id-only check -- which would POST `Authorization: Bearer undefined`
  // and get back a 400 nobody reads.
  it("acks everything and purges nothing when CF_API_KEY is the missing half", async () => {
    const { batch, acks, retries } = batchOf([tagged(foodbankTag("salisbury"))]);

    await handleCachePurgeQueue(batch, buildEnv({ CF_API_KEY: "" }));

    expect(purgeCalls).toEqual([]);
    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
  });

  it("acks everything when both are unset", async () => {
    const { batch, acks } = batchOf([NO_TAGS]);

    await handleCachePurgeQueue(batch, buildEnv({ CF_ZONE_ID: "", CF_API_KEY: "" }));

    expect(purgeCalls).toEqual([]);
    expect(acks).toEqual([0]);
  });

  // The guard is falsiness, not `undefined`, so an env where the secret was
  // deleted and one where it was never set behave identically. Pinned because
  // `wrangler secret delete` and "never set" are different states of the same
  // account and neither must produce a request.
  it("treats a genuinely absent binding the same as an empty string", async () => {
    const env = buildEnv();
    delete (env as Partial<Env>).CF_API_KEY;
    const { batch, acks } = batchOf([tagged(AGGREGATE_TAG)]);

    await handleCachePurgeQueue(batch, env);

    expect(purgeCalls).toEqual([]);
    expect(acks).toEqual([0]);
  });

  // A batch of 100 (wrangler.jsonc's max_batch_size for this queue) is acked
  // in full, not just its first message. A loop that returned after the first
  // ack would leave 99 messages unacked, all redelivered, all logging the same
  // line, forever.
  it("acks every message in a full batch, not just the first", async () => {
    const { batch, acks } = batchOf(Array.from({ length: 100 }, (_, i) => tagged(foodbankTag(`fb-${i}`))));

    await handleCachePurgeQueue(batch, buildEnv({ CF_ZONE_ID: "" }));

    expect(acks).toHaveLength(100);
    expect(acks[0]).toBe(0);
    expect(acks[99]).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// The tag purge request itself
//
// MUTANTS KILLED HERE: the zone id dropped from the URL (4); the Bearer prefix
// dropped from the Authorization header (2); the method left as a default GET
// (1); the body sent as `{files: [...]}` -- Django's shape, cache.py:187-189 --
// instead of `{tags: [...]}` (13, and that mutant would get a 200 back from
// Cloudflare while purging nothing); the AbortSignal removed (2).
// ---------------------------------------------------------------------------

describe("handleCachePurgeQueue -- the request that goes to Cloudflare", () => {
  it("sends exactly the documented tag purge", async () => {
    const { batch } = batchOf([tagged(foodbankTag("salisbury"), AGGREGATE_TAG)]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(purgeCalls).toHaveLength(1);
    const call = purgeCalls[0]!;
    // givefood/utils/cache.py:166's endpoint and Bearer-token shape, with
    // tags in place of files/prefixes.
    expect(call.url).toBe(PURGE_URL);
    expect(call.method).toBe("POST");
    expect(call.authorization).toBe(`Bearer ${API_KEY}`);
    expect(call.contentType).toBe("application/json");
    expect(call.body).toEqual({ tags: ["fb-salisbury", "fb-all"] });
    // A purge that can hang forever holds a queue consumer's whole invocation
    // open and gives no answer either way. cachePurge.ts:57 caps it.
    expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(call.signal?.aborted).toBe(false);
  });

  // MUTANTS THIS KILLS, both of which survived every other test in this file:
  // `AbortSignal.timeout(15_000)` -> `timeout(150)` and -> `timeout(900_000)`.
  // The assertions above see an AbortSignal that has not fired yet, and that
  // is true of a 150ms signal too until 150ms have passed -- at which point
  // every purge in production aborts before Cloudflare can answer, the batch
  // retries three times and lands in cache-purge-dlq. The other direction is
  // as bad and quieter: a fifteen-minute signal is a consumer invocation held
  // open for fifteen minutes per chunk against a queue whose messages keep
  // arriving. Neither is visible in the signal object, so the ARGUMENT is what
  // has to be asserted; AbortSignal.timeout is spied on rather than replaced,
  // so the real signal still reaches fetch.
  it("caps each purge at fifteen seconds", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const { batch } = batchOf([tagged(AGGREGATE_TAG)]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(timeout.mock.calls).toEqual([[15_000]]);
  });

  // The zone comes from the binding, not from a constant. A purge sent to the
  // wrong zone succeeds -- it is a valid request against a zone this token can
  // reach -- and leaves givefood.org.uk entirely stale.
  it("addresses whichever zone the binding names", async () => {
    const { batch } = batchOf([tagged(AGGREGATE_TAG)]);

    await handleCachePurgeQueue(batch, buildEnv({ CF_ZONE_ID: "some-other-zone" }));

    expect(purgeCalls[0]!.url).toBe("https://api.cloudflare.com/client/v4/zones/some-other-zone/purge_cache");
  });

  // THE CROSS-WORKER CONTRACT, and the reason this test uses the real
  // @givefood/urls helpers rather than string literals. workers/site stamps
  // Cache-Tag with foodbankTag()/constituencyTag()/AGGREGATE_TAG
  // (middleware/cacheTag.ts) and workers/jobs purges whatever a producer put
  // in the message. If either side's spelling drifted -- `fb-salisbury` here
  // against `foodbank-salisbury` there -- Cloudflare would answer 200 for a
  // purge that matched nothing, and the only symptom would be a stale page.
  // This asserts the exact byte strings that go on the wire.
  it("purges the same tag names workers/site stamps responses with", async () => {
    // The message routes/admin/foodbank.ts:160-164 builds on a food bank save.
    const { batch } = batchOf([tagged(foodbankTag("salisbury"), AGGREGATE_TAG, constituencyTag("salisbury"))]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(purgeCalls[0]!.body.tags).toEqual(["fb-salisbury", "fb-all", "pc-salisbury"]);
  });

  // queues/articles.ts:90's message, verbatim -- the send is at :90 in the
  // current file, not the :86 cachePurge.ts:23 cites. On the module's own
  // account (cachePurge.ts:20-24) this is the purge that has never actually
  // happened: articles.ts was the only producer while this consumer was still
  // a retry() stub, so every new-article purge went round three times and into
  // a dead-letter queue that had no consumer either. Not independently
  // verified against production logs here.
  it("purges a new-article message from queues/articles.ts", async () => {
    const { batch, acks } = batchOf([{ tags: [foodbankTag("sid-valley"), AGGREGATE_TAG] }]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(purgeCalls[0]!.body).toEqual({ tags: ["fb-sid-valley", "fb-all"] });
    expect(acks).toEqual([0]);
  });
});

// ---------------------------------------------------------------------------
// Coalescing the batch
//
// MUTANTS KILLED HERE: the Set replaced with an array so duplicates are sent
// repeatedly (1); only the first message's tags collected (6); only the first
// message acked on success, leaving the other 99 to be redelivered (6);
// insertion order replaced by a sort (8 -- harmless to Cloudflare, but it
// makes the log line's "first 8" a different eight, and the log is the only
// record of what was purged); the log's message total counting tags (8).
// ---------------------------------------------------------------------------

describe("handleCachePurgeQueue -- one request for the whole batch", () => {
  // Every food bank save carries fb-all, so a batch of 100 saves names fb-all
  // 100 times. Without the union that is 100 purges of the same tag against a
  // rate-limited API, which is the entire reason cachePurge.ts:33-36 coalesces.
  it("unions overlapping tags into a single request", async () => {
    const { batch, acks } = batchOf([
      tagged(foodbankTag("salisbury"), AGGREGATE_TAG),
      tagged(foodbankTag("devizes"), AGGREGATE_TAG),
      tagged(foodbankTag("salisbury"), AGGREGATE_TAG),
    ]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(purgeCalls).toHaveLength(1);
    // fb-all once, fb-salisbury once, in first-seen order.
    expect(purgeCalls[0]!.body.tags).toEqual(["fb-salisbury", "fb-all", "fb-devizes"]);
    expect(acks).toEqual([0, 1, 2]);
  });

  it("keeps first-seen order across messages rather than sorting", async () => {
    const { batch } = batchOf([tagged("zzz-last"), tagged("aaa-first"), tagged("mmm-middle")]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(purgeCalls[0]!.body.tags).toEqual(["zzz-last", "aaa-first", "mmm-middle"]);
  });

  // The log line is the only durable record that a purge happened, and it is
  // truncated at 8 tags while the COUNT is the full total. Asserted exactly
  // because an operator reading it during an incident has to be able to tell
  // "9 tags, showing 8" from "8 tags".
  it("logs the full count but only the first eight tag names", async () => {
    const nine = manyTags(9);
    const { batch } = batchOf([tagged(...nine)]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(consoleLog).toHaveBeenCalledWith(`cache-purge: purged 9 tag(s) for 1 message(s): ${nine.slice(0, 8).join(", ")}`);
    // ...and the ninth really was purged, it is only the log that stops at 8.
    expect(purgeCalls[0]!.body.tags).toEqual(nine);
  });

  it("counts messages, not tags, in the log's message total", async () => {
    const { batch } = batchOf([tagged("t1", "t2"), tagged("t3")]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(consoleLog).toHaveBeenCalledWith("cache-purge: purged 3 tag(s) for 2 message(s): t1, t2, t3");
  });
});

// ---------------------------------------------------------------------------
// Chunking at 30
//
// MUTANTS KILLED HERE: TAGS_PER_REQUEST raised to 1000, i.e. no chunking (6 --
// and Cloudflare answers 400 to that, so the mutant purges NOTHING while
// looking like a tidy simplification); lowered to 29 (4); the slice written as
// `slice(i, TAGS_PER_REQUEST)` so every chunk after the first is empty (3);
// the loop step left at 1 so chunks overlap by 29 (10); the chunks walked
// backwards (3); one AbortSignal hoisted out of the loop and shared (1).
// ---------------------------------------------------------------------------

describe("handleCachePurgeQueue -- Cloudflare's 30-tag cap", () => {
  it("sends 30 tags as a single request", async () => {
    const thirty = manyTags(TAGS_PER_REQUEST);
    const { batch } = batchOf([tagged(...thirty)]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(purgeCalls).toHaveLength(1);
    expect(purgeCalls[0]!.body.tags).toEqual(thirty);
  });

  // The boundary. cachePurge.ts:46-47 is explicit that exceeding the cap is a
  // 400 and not a partial purge, so the 31st tag is the difference between
  // "one food bank stale" and "the whole batch silently unpurged".
  it("splits 31 tags into 30 + 1, losing none and duplicating none", async () => {
    const thirtyOne = manyTags(TAGS_PER_REQUEST + 1);
    const { batch, acks } = batchOf([tagged(...thirtyOne)]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(purgeCalls).toHaveLength(2);
    expect(purgeCalls[0]!.body.tags).toEqual(thirtyOne.slice(0, 30));
    expect(purgeCalls[1]!.body.tags).toEqual(thirtyOne.slice(30));
    // Reassembled, the two requests are exactly the union -- same tags, same
    // order, no repeats.
    expect(purgeCalls.flatMap((call) => call.body.tags as string[])).toEqual(thirtyOne);
    expect(acks).toEqual([0]);
  });

  it("splits 61 tags into 30 + 30 + 1", async () => {
    const many = manyTags(61);
    const { batch } = batchOf([tagged(...many)]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(purgeCalls.map((call) => (call.body.tags as string[]).length)).toEqual([30, 30, 1]);
    expect(purgeCalls.flatMap((call) => call.body.tags as string[])).toEqual(many);
    // ONE log line for the batch, not one per chunk. The count in it is the
    // union's total (61), so a log moved inside the chunk loop would print
    // "purged 61 tag(s)" three times and treble every purge in the log without
    // changing a single character of the line -- toHaveBeenCalledWith cannot
    // see that, only the call count can.
    expect(consoleLog).toHaveBeenCalledTimes(1);
  });

  // Chunking happens after the union, not per message. 40 messages of one tag
  // each is 40 distinct tags, which is two requests -- not 40.
  it("chunks the union rather than the messages", async () => {
    const { batch, acks } = batchOf(manyTags(40).map((tag) => tagged(tag)));

    await handleCachePurgeQueue(batch, buildEnv());

    expect(purgeCalls).toHaveLength(2);
    expect(acks).toHaveLength(40);
  });

  // Every chunk carries its own auth and its own timeout. A shared AbortSignal
  // built once outside the loop would abort chunks 2..n the moment the first
  // one took 15s, and those tags would never be purged at all.
  it("gives every chunk its own credentials and its own timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const { batch } = batchOf([tagged(...manyTags(61))]);

    await handleCachePurgeQueue(batch, buildEnv());

    for (const call of purgeCalls) {
      expect(call.url).toBe(PURGE_URL);
      expect(call.authorization).toBe(`Bearer ${API_KEY}`);
      expect(call.signal).toBeInstanceOf(AbortSignal);
    }
    expect(new Set(purgeCalls.map((call) => call.signal)).size).toBe(3);
    // Three fresh 15s budgets, not one 15s budget shared three ways: the
    // distinct-identity check above dies to a signal hoisted into module scope,
    // but only the arguments say that chunk 3 gets a full fifteen seconds
    // rather than whatever was left of chunk 1's.
    expect(timeout.mock.calls).toEqual([[15_000], [15_000], [15_000]]);
  });
});

// ---------------------------------------------------------------------------
// Messages with no tags -> purge_everything
//
// MUTANTS KILLED HERE: the purgeAll flag never set, so a tagless message is
// silently a no-op (9); `if (t?.length)` narrowed to `if (t)`, so `tags: []`
// becomes a tag purge of nothing (2); the purge_everything body sent as
// `{purge_everything: "true"}` (7); the fallback narrowed to
// `purgeAll && tags.size === 0`, so a tagless message travelling with tagged
// ones is quietly dropped (1); `message.body?.tags` written without the
// optional chain, so a null body throws instead (2).
// ---------------------------------------------------------------------------

describe("handleCachePurgeQueue -- a message that names no tags", () => {
  // "A message that names no tags cannot be satisfied by a tag purge, and
  // guessing would be worse than the blunt instrument" (cachePurge.ts:95-96).
  // This is also what the OLD consumer did for every message, so it is the
  // behaviour a pre-tag producer still gets.
  it("purges everything for a bare {} body", async () => {
    const { batch, acks } = batchOf([NO_TAGS]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(purgeCalls).toHaveLength(1);
    expect(purgeCalls[0]!.body).toEqual({ purge_everything: true });
    expect(purgeCalls[0]!.url).toBe(PURGE_URL);
    expect(acks).toEqual([0]);
    expect(consoleLog).toHaveBeenCalledWith("cache-purge: purged everything for 1 message(s)");
  });

  // `tags: []` is the interesting one: an empty array is a message that
  // arguably asks for nothing to be purged, and the code reads it as "purge
  // the lot". No producer can send it TODAY -- routes/admin/needs.ts:174-175
  // pushes conditionally but onto `[AGGREGATE_TAG]`, so the list always has at
  // least one member, and foodbank.ts:160 does the same. Pinned because that
  // constant seed is the only thing standing between a conditional tag list
  // and a full-zone purge, and it is one refactor away from being dropped.
  it("purges everything for an empty tags array, not nothing", async () => {
    const { batch, acks } = batchOf([{ tags: [] }]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(purgeCalls[0]!.body).toEqual({ purge_everything: true });
    expect(acks).toEqual([0]);
  });

  it("purges everything for a null body", async () => {
    const { batch, acks } = batchOf([null]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(purgeCalls[0]!.body).toEqual({ purge_everything: true });
    expect(acks).toEqual([0]);
  });

  it("purges everything for an undefined body", async () => {
    const { batch, acks } = batchOf([undefined]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(purgeCalls[0]!.body).toEqual({ purge_everything: true });
    expect(acks).toEqual([0]);
  });

  // SUSPECT, PINNED AS-IS. A message whose body arrived double-encoded -- a
  // producer calling send(JSON.stringify(msg)) instead of send(msg) -- has no
  // `.tags` property, because strings do not have one. So a producer typo
  // escalates silently to a full-zone purge rather than failing. Nothing in
  // the log says the body was a string; it reads exactly like a legitimate
  // tagless message.
  it("purges everything for a double-encoded string body", async () => {
    const { batch, acks } = batchOf([JSON.stringify({ tags: [foodbankTag("salisbury")] })]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(purgeCalls[0]!.body).toEqual({ purge_everything: true });
    expect(acks).toEqual([0]);
  });

  // SUSPECT, PINNED AS-IS, AND THE MOST CONSEQUENTIAL BEHAVIOUR IN THE FILE.
  // purgeAll is a BATCH-level flag, so ONE tagless message among 99 tagged
  // ones purges the entire zone -- and wrangler.jsonc's max_batch_size for
  // this queue is exactly 100. The collected tags are then thrown away
  // (purge_everything covers them, so nothing goes unpurged), but the cost is
  // a full cold cache for the site instead of 99 tag invalidations. The
  // module's comment justifies the fallback per MESSAGE; the code applies it
  // per BATCH, and those are not the same claim.
  it("escalates the whole batch to purge_everything for one tagless message", async () => {
    const bodies: unknown[] = manyTags(99).map((tag) => tagged(tag, AGGREGATE_TAG));
    bodies.splice(50, 0, NO_TAGS);
    const { batch, acks } = batchOf(bodies);

    await handleCachePurgeQueue(batch, buildEnv());

    // One request, and it names no tags at all -- the 99 messages' tags were
    // collected and then discarded.
    expect(purgeCalls).toHaveLength(1);
    expect(purgeCalls[0]!.body).toEqual({ purge_everything: true });
    expect(purgeCalls[0]!.body.tags).toBeUndefined();
    expect(acks).toHaveLength(100);
    expect(consoleLog).toHaveBeenCalledWith("cache-purge: purged everything for 100 message(s)");
  });

  // Many tagless messages are still ONE purge_everything, not one each. A
  // purge_everything per message would be the most expensive thing this Worker
  // can do to the zone, repeated 100 times against a rate-limited API.
  it("purges everything exactly once however many tagless messages arrive", async () => {
    const { batch, acks } = batchOf([NO_TAGS, NO_TAGS, NO_TAGS, NO_TAGS]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(purgeCalls).toHaveLength(1);
    expect(acks).toEqual([0, 1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// When Cloudflare says no
//
// MUTANTS KILLED HERE: `payload?.success !== true` dropped, trusting res.ok
// alone (4); `!res.ok` dropped, trusting the envelope alone (1); the
// try/catch around res.json() removed so a non-JSON body throws out of the
// consumer (1); the try/catch around fetch removed (2); purge() returning true
// on the failure path (10); retry() called without the delay (4); ack and
// retry swapped (26); `&& ok` dropped from the chunk loop so a failed chunk
// does not stop the rest (1); `purge_everything: false` added alongside the
// tags, which Cloudflare would reject as a malformed body (4).
// ---------------------------------------------------------------------------

describe("handleCachePurgeQueue -- a purge that fails", () => {
  // The trap this module's own comment names: the v4 API answers 200 with
  // success:false for a token missing the Zone.Cache Purge permission, so
  // res.ok alone would ack a batch that purged nothing. Django checks neither:
  // cache.py:173 and :187 both call requests.post as a bare statement and
  // discard the response entirely, so a Django decache() that Cloudflare
  // refused is indistinguishable from one it honoured. That divergence is why
  // this is a test rather than a comment.
  it("treats a 200 with success:false as a failure and retries", async () => {
    replies = [async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }))];
    const { batch, acks, retries } = batchOf([tagged(foodbankTag("salisbury"))]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(acks).toEqual([]);
    expect(retries).toEqual([{ index: 0, options: { delaySeconds: 60 } }]);
    expect(consoleError).toHaveBeenCalledWith("cache-purge: purge_cache failed (HTTP 200)", [
      { code: 10000, message: "Authentication error" },
    ]);
    // No success line: an operator grepping for "purged" must not find one.
    expect(consoleLog).not.toHaveBeenCalled();
  });

  it("retries on a non-2xx", async () => {
    replies = [async () => new Response(JSON.stringify({ success: false, errors: [] }), { status: 403 })];
    const { batch, acks, retries } = batchOf([tagged(AGGREGATE_TAG)]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(acks).toEqual([]);
    expect(retries.map((r) => r.index)).toEqual([0]);
  });

  // THE MUTANT THIS KILLS that the test above does not: dropping `!res.ok` and
  // trusting the body. Every failure Cloudflare produces today also says
  // success:false, so the body check covers for the status check and deleting
  // it looks like a safe tidy. It is not: a TLS-inspecting proxy, a captive
  // portal or a cached error page can return a 5xx whose body still parses as
  // a success envelope, and this consumer would ack a purge that never
  // reached Cloudflare at all.
  it("fails on the HTTP status alone, even when the body claims success", async () => {
    replies = [async () => new Response(JSON.stringify({ success: true, result: { id: ZONE_ID } }), { status: 503 })];
    const { batch, acks, retries } = batchOf([tagged(AGGREGATE_TAG)]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(acks).toEqual([]);
    expect(retries.map((r) => r.index)).toEqual([0]);
    expect(consoleError).toHaveBeenCalledWith("cache-purge: purge_cache failed (HTTP 503)", undefined);
  });

  // THE MUTANT THIS KILLS, which the 503 test above does NOT: narrowing
  // `!res.ok` to `res.status >= 500`, i.e. "only a 5xx is a real failure".
  // Every other failure test here carries a non-2xx AND success:false, so the
  // envelope check covers for the status check and that narrowing passes the
  // whole file -- it survived the first mutation sweep of this suite.
  // 429 is the status that matters in production: Cloudflare rate-limits
  // purge_cache per zone, which is the exact pressure a consumer that
  // coalesces 100 messages into one request is designed to sit under, and a
  // 429 acked is a purge that never happened. Constructed, not observed: no
  // real 429 body says success:true, but pairing an ok-looking envelope with a
  // sub-500 status is the only way to tell `!res.ok` from `res.status >= 500`.
  it("fails on a 429 as well as a 5xx, whatever the body says", async () => {
    replies = [async () => new Response(JSON.stringify({ success: true, result: {} }), { status: 429 })];
    const { batch, acks, retries } = batchOf([tagged(foodbankTag("salisbury"))]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(acks).toEqual([]);
    expect(retries).toEqual([{ index: 0, options: { delaySeconds: 60 } }]);
    expect(consoleError).toHaveBeenCalledWith("cache-purge: purge_cache failed (HTTP 429)", undefined);
    expect(consoleLog).not.toHaveBeenCalled();
  });

  // Cloudflare's edge serves HTML error pages often enough that this is a real
  // shape. It fails INSIDE res.json(), after the ok check, so without the
  // try/catch the consumer would throw -- which the runtime treats as a whole
  // batch failure and is nearly the same outcome, except that it bypasses the
  // 60s delay and loses the log line naming the status.
  it("treats a 200 whose body is not JSON as a failure", async () => {
    replies = [async () => new Response("<html>520 origin error</html>", { status: 200 })];
    const { batch, acks, retries } = batchOf([tagged(AGGREGATE_TAG)]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(acks).toEqual([]);
    expect(retries.map((r) => r.index)).toEqual([0]);
    expect(consoleError).toHaveBeenCalledWith("cache-purge: purge_cache failed (HTTP 200)", undefined);
  });

  // Includes the AbortSignal.timeout(15_000) case: however fetch rejects, the
  // batch is retried rather than thrown out of the consumer.
  it("treats an unreachable API as a failure, not an exception", async () => {
    replies = [
      async () => {
        throw new TypeError("network error");
      },
    ];
    const { batch, acks, retries } = batchOf([tagged(AGGREGATE_TAG)]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(acks).toEqual([]);
    expect(retries.map((r) => r.index)).toEqual([0]);
    expect(consoleError).toHaveBeenCalledWith("cache-purge: Cloudflare purge_cache could not be reached", expect.any(TypeError));
  });

  // SUSPECT, PINNED AS-IS: `payload?.success !== true` is a strict identity
  // check, so an envelope carrying the string "true" reads as a failure.
  // Cloudflare sends a real boolean, so this is right today; asserted so that
  // loosening it to `== true` has to be a deliberate decision. Same reasoning
  // as clearCache.test.ts:781 -- but note this case does NOT on its own defend
  // the `!==`, because `"true" != true` is also true (the string coerces to
  // NaN, not 1). The test below is the one that does; that wording is wrong in
  // clearCache.test.ts too, which claims " " would be accepted when
  // Number(" ") is 0.
  it("does not accept a stringly-typed success flag", async () => {
    replies = [async () => new Response(JSON.stringify({ success: "true" }))];
    const { batch, retries } = batchOf([tagged(AGGREGATE_TAG)]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(retries.map((r) => r.index)).toEqual([0]);
  });

  // THE MUTANT THIS KILLS: `payload?.success !== true` relaxed to `!= true`,
  // which survived the sweep because 1 and "1" are the only JSON values that
  // separate the two comparisons -- both are `== true`. A purge answered
  // `{"success": 1}` would then be acked as a success. That is not a shape
  // Cloudflare sends, so this is a guard on the comparison rather than an
  // observed response: an API gateway, a stub or a JSON-ifying proxy that
  // renders booleans as 0/1 is what would produce it, and acking it means a
  // food bank page stale until its TTL with a "purged" line in the log.
  it("does not accept a numeric 1 as success either", async () => {
    replies = [async () => new Response(JSON.stringify({ success: 1 }))];
    const { batch, acks, retries } = batchOf([tagged(AGGREGATE_TAG)]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(acks).toEqual([]);
    expect(retries.map((r) => r.index)).toEqual([0]);
    expect(consoleLog).not.toHaveBeenCalled();
  });

  // A 200 with no envelope at all -- `{}` -- is a failure too. Worth pinning
  // separately from success:false because an empty object is what a proxy or a
  // stubbed-out API returns, and `undefined !== true` is the only thing
  // stopping it being read as a success.
  it("treats an empty JSON object as a failure", async () => {
    replies = [async () => new Response("{}")];
    const { batch, acks, retries } = batchOf([tagged(AGGREGATE_TAG)]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(acks).toEqual([]);
    expect(retries.map((r) => r.index)).toEqual([0]);
  });

  // EVERY message is retried, including ones whose tags were purged
  // successfully in an earlier chunk. That is the right way round -- a tag
  // purge is idempotent, so re-purging costs a cache miss, whereas acking a
  // message whose tag never went out costs a permanently stale page -- but it
  // means the whole batch shares one fate. wrangler.jsonc gives this queue
  // max_retries 3 and a cache-purge-dlq, so three failures park all 100.
  it("retries the whole batch, not just the message that failed", async () => {
    replies = [async () => new Response(JSON.stringify({ success: false, errors: [] }), { status: 500 })];
    const { batch, acks, retries } = batchOf([tagged("t1"), tagged("t2"), tagged("t3")]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(acks).toEqual([]);
    expect(retries).toEqual([
      { index: 0, options: { delaySeconds: 60 } },
      { index: 1, options: { delaySeconds: 60 } },
      { index: 2, options: { delaySeconds: 60 } },
    ]);
  });

  // The 60s delay is not decoration: without it the failed batch comes
  // straight back, and a token that is missing a permission would burn all
  // three retries in under a second and reach the DLQ before anyone could
  // notice the first log line.
  it("retries with a 60 second delay", async () => {
    replies = [
      async () => {
        throw new Error("boom");
      },
    ];
    const { batch, retries } = batchOf([NO_TAGS]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(retries[0]!.options).toEqual({ delaySeconds: 60 });
  });

  // THE MUTANT THIS KILLS, and it survived the whole original suite: dropping
  // the `if (ok)` from the purge_everything log (cachePurge.ts:103). The
  // equivalent guard on the TAG log was covered twice over, but nothing
  // exercised a FAILING purge_everything, so a "cache-purge: purged everything
  // for 100 message(s)" line could be emitted for a purge Cloudflare had just
  // refused. That is the worst possible log for this Worker to be wrong about:
  // the failure is invisible by construction, the DLQ has no consumer that can
  // act, and grepping the logs for "purged everything" is the only way an
  // operator ever finds out whether the blunt instrument actually swung.
  // The 400 and its error object are a plausible shape, not a captured one --
  // no live purge_cache call was made to check the code number, and nothing
  // here depends on it beyond its being passed through to the log verbatim.
  it("logs no success line when a purge_everything is refused", async () => {
    replies = [
      async () => new Response(JSON.stringify({ success: false, errors: [{ code: 1012, message: "Invalid purge request" }] }), { status: 400 }),
    ];
    const { batch, acks, retries } = batchOf([NO_TAGS, tagged(foodbankTag("salisbury"))]);

    await handleCachePurgeQueue(batch, buildEnv());

    // The tagless message escalated the batch, so this really is the
    // purge_everything branch and not the tag branch.
    expect(purgeCalls[0]!.body).toEqual({ purge_everything: true });
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith("cache-purge: purge_cache failed (HTTP 400)", [
      { code: 1012, message: "Invalid purge request" },
    ]);
    expect(acks).toEqual([]);
    expect(retries.map((r) => r.index)).toEqual([0, 1]);
  });

  // The loop is `i < list.length && ok`, so a failed chunk stops the ones
  // after it. That saves pointless calls against an API that has just refused
  // one, and the retry re-sends the batch from the start -- so chunk 1 is
  // purged twice and chunk 3 is never orphaned. Pinned because the obvious
  // "improvement" (carry on and report failure at the end) would ALSO be
  // defensible, and the difference is visible only here.
  it("stops after the first failed chunk rather than sending the rest", async () => {
    replies = [purgeOk, async () => new Response(JSON.stringify({ success: false, errors: [] }), { status: 429 })];
    const { batch, acks, retries } = batchOf([tagged(...manyTags(90))]);

    await handleCachePurgeQueue(batch, buildEnv());

    // 90 tags is three chunks; the third is never attempted.
    expect(purgeCalls).toHaveLength(2);
    expect(acks).toEqual([]);
    expect(retries.map((r) => r.index)).toEqual([0]);
    expect(consoleLog).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// At-least-once delivery
// ---------------------------------------------------------------------------

describe("handleCachePurgeQueue -- redelivery", () => {
  // Cloudflare queues are at-least-once, so the same batch can arrive twice --
  // after a retry, or simply because delivery was duplicated. A tag purge is
  // idempotent: the second one costs a cache miss and nothing else. Asserted
  // by running the identical batch twice and comparing the two requests byte
  // for byte, so a consumer that accumulated state in module scope (a "seen
  // tags" cache, say) would show up as a second request that differs.
  it("sends the identical request when the same batch is delivered twice", async () => {
    const bodies = [tagged(foodbankTag("salisbury"), AGGREGATE_TAG), tagged(foodbankTag("devizes"))];

    const first = batchOf(bodies);
    await handleCachePurgeQueue(first.batch, buildEnv());
    const second = batchOf(bodies);
    await handleCachePurgeQueue(second.batch, buildEnv());

    expect(purgeCalls).toHaveLength(2);
    expect(purgeCalls[0]!.body).toEqual(purgeCalls[1]!.body);
    expect(purgeCalls[0]!.body).toEqual({ tags: ["fb-salisbury", "fb-all", "fb-devizes"] });
    expect(first.acks).toEqual([0, 1]);
    expect(second.acks).toEqual([0, 1]);
  });

  // The retry path re-sends everything, including the chunk that already
  // succeeded before the failure. Verified as a real second pass rather than
  // asserted from the code, because "the retry purges chunk 1 again" is the
  // fact that makes stopping at the first failed chunk safe.
  it("re-purges an already-purged chunk on the retried delivery", async () => {
    const tags = manyTags(31);
    replies = [purgeOk, async () => new Response(JSON.stringify({ success: false, errors: [] }), { status: 500 })];

    const first = batchOf([tagged(...tags)]);
    await handleCachePurgeQueue(first.batch, buildEnv());
    expect(first.retries.map((r) => r.index)).toEqual([0]);

    const second = batchOf([tagged(...tags)]);
    await handleCachePurgeQueue(second.batch, buildEnv());

    expect(second.acks).toEqual([0]);
    // Four requests in total: 30 + 1 (failed at the second) then 30 + 1 again.
    expect(purgeCalls.map((call) => (call.body.tags as string[]).length)).toEqual([30, 1, 30, 1]);
  });
});

// ---------------------------------------------------------------------------
// Malformed messages
// ---------------------------------------------------------------------------

describe("handleCachePurgeQueue -- bodies the type says are impossible", () => {
  // SUSPECT, PINNED AS-IS. `if (t?.length) t.forEach(...)` reads `.length` off
  // whatever it is given, so a producer sending `tags: "fb-salisbury"` -- a
  // string, not an array, which the queue happily delivers -- passes the guard
  // and then throws on forEach. The throw escapes the consumer, so NOTHING is
  // acked or retried explicitly: the runtime fails the whole batch, redelivers
  // it, and after max_retries 3 every message in it lands in cache-purge-dlq.
  // One malformed message therefore takes up to 99 valid purges down with it.
  // Compare the tagless path, which handles a wrong-shaped body gracefully.
  it("throws out of the consumer when tags is a string, acking nothing", async () => {
    const { batch, acks, retries } = batchOf([{ tags: foodbankTag("salisbury") }, tagged(AGGREGATE_TAG)]);

    await expect(handleCachePurgeQueue(batch, buildEnv())).rejects.toThrow(TypeError);

    expect(purgeCalls).toEqual([]);
    expect(acks).toEqual([]);
    expect(retries).toEqual([]);
  });

  // A number has no `.length`, so it takes the tagless path instead and is
  // absorbed. The two malformed shapes behave completely differently, which is
  // the point of testing both: neither outcome is a deliberate design.
  it("purges everything when tags is a number", async () => {
    const { batch, acks } = batchOf([{ tags: 5 }]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(purgeCalls[0]!.body).toEqual({ purge_everything: true });
    expect(acks).toEqual([0]);
  });

  // SUSPECT, PINNED AS-IS: nothing validates that a tag is a string, so a
  // producer bug puts nulls and numbers straight onto the wire. Cloudflare
  // answers 400 to that, which this consumer correctly treats as a failure --
  // so the batch retries three times and reaches the DLQ, with the log line
  // naming an HTTP status rather than the bad tag.
  it("forwards non-string tag values verbatim", async () => {
    const { batch } = batchOf([{ tags: [foodbankTag("salisbury"), null, 42] }]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(purgeCalls[0]!.body.tags).toEqual(["fb-salisbury", null, 42]);
  });

  // An empty batch is not something the runtime delivers, but it is what a
  // future caller passing a filtered list would produce. It must not fall into
  // the purge_everything branch: the union is empty, the chunk loop never
  // runs, and no request goes out at all. The log line then claims a purge of
  // nothing, which is odd but harmless -- pinned so a reader of the logs is
  // not surprised by it.
  it("sends no request at all for an empty batch", async () => {
    const { batch, acks, retries } = batchOf([]);

    await handleCachePurgeQueue(batch, buildEnv());

    expect(purgeCalls).toEqual([]);
    expect(acks).toEqual([]);
    expect(retries).toEqual([]);
    expect(consoleLog).toHaveBeenCalledWith("cache-purge: purged 0 tag(s) for 0 message(s): ");
  });
});

// ---------------------------------------------------------------------------
// As the real Worker delivers it
//
// Routed through the SHIPPED dispatcher (src/index.ts) rather than by calling
// the handler directly, because the routing is part of the claim. This
// consumer spent its whole life so far mis-wired -- a `message.retry()` stub
// in this very switch -- and a `case` label that no longer matches the queue
// name in wrangler.jsonc would fall through to `default:`, log one line naming
// the queue and nothing else, ack nothing, and back the queue up until the
// retention period ate it. No test that calls handleCachePurgeQueue directly
// can see that.
// ---------------------------------------------------------------------------

describe("handleCachePurgeQueue -- through the real index.ts queue dispatcher", () => {
  it('is what the "cache-purge" queue name reaches', async () => {
    const { batch, acks, retries } = batchOf([tagged(foodbankTag("salisbury"), AGGREGATE_TAG)], "cache-purge");

    await worker.queue(batch as unknown as MessageBatch<unknown>, buildEnv(), execCtx);

    expect(purgeCalls).toHaveLength(1);
    expect(purgeCalls[0]!.body).toEqual({ tags: ["fb-salisbury", "fb-all"] });
    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
  });

  it("retries through the dispatcher too when Cloudflare refuses", async () => {
    replies = [async () => new Response(JSON.stringify({ success: false, errors: [] }), { status: 403 })];
    const { batch, acks, retries } = batchOf([tagged(AGGREGATE_TAG)], "cache-purge");

    await worker.queue(batch as unknown as MessageBatch<unknown>, buildEnv(), execCtx);

    expect(acks).toEqual([]);
    expect(retries).toEqual([{ index: 0, options: { delaySeconds: 60 } }]);
  });

  // The dead-letter queue must NOT come back here. cache-purge-dlq holds
  // messages that already exhausted their three retries; sending them round
  // again would be a poison message becoming an infinite loop (jobsDlq.ts:18-20).
  // It goes to handleJobsDlq instead, which logs the tags that were lost and
  // acks. Asserted by the ABSENCE of a purge plus the DLQ's own log line,
  // because a `case "cache-purge-dlq"` accidentally added to this consumer's
  // arm would look identical from the outside otherwise.
  it("does not purge for a message arriving on cache-purge-dlq", async () => {
    const { batch, acks } = batchOf([tagged(foodbankTag("salisbury"), AGGREGATE_TAG)], "cache-purge-dlq");

    await worker.queue(batch as unknown as MessageBatch<unknown>, buildEnv(), execCtx);

    expect(purgeCalls).toEqual([]);
    expect(acks).toEqual([0]);
    expect(consoleError).toHaveBeenCalledWith("cache-purge-dlq: gave up on (no type) tags=fb-salisbury,fb-all");
  });
});
