import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { geminiJsonCall, type GeminiJsonCallParams } from "./gemini";

// The whole of this port's Gemini surface: one function, called from exactly
// two places (adminJobs/foodbankCheck.ts:179 and adminJobs/orderLines.ts:120),
// both of which run inside the "jobs" queue consumer.
//
// WHY THIS FILE EARNS ITS KEEP. Nothing about a broken call here is visible.
// queues/jobs.ts:37-53 routes both callers to handlers that CATCH THEIR OWN
// ERRORS and write the message onto an admin_job row rather than throwing --
// deliberately, so a failed AI check does not burn a second paid Gemini call
// on a queue retry. The consequence is that a wrong request shape produces no
// exception, no retry, no dead letter queue and no alarming: it produces an
// admin_job row saying "failed", on a page nobody visits unless they happened
// to press the button. A misspelled field name in generationConfig, a dropped
// safetySettings block, a temperature quietly coerced to a default -- every
// one of those is a 400 from Google that surfaces as one grey row in
// /admin/jobs/ and nothing else. These tests are the only thing standing
// between "the check is wrong" and "the check silently stopped working".
//
// The second half of the stakes is the 60 SECOND SLEEP on line 47. The "jobs"
// consumer (wrangler.jsonc:148-151) has max_batch_size 10 and
// handleJobsQueue (queues/jobs.ts:20-28) walks the batch SERIALLY with an
// await. One message that fails twice costs 120s + 60s + 120s of the
// invocation's wall clock; ten of them in one batch cost fifty minutes,
// against a queue consumer that does not get fifty minutes. So "does it sleep
// at all", "does it sleep only between attempts" and "how many attempts are
// there, ever" are load-bearing facts, and each is asserted below off the
// FAKE CLOCK rather than by waiting.
//
// THE DJANGO ANCESTOR WAS READ, NOT ASSUMED: givefood/utils/ai.py:17-83 in
// /Users/jasoncartwright/Sites/foodcharity, which the module's own header
// cites. Its call sites were read too, because two of the port's constants
// are not in ai.py at all and had to come from somewhere:
// gfadmin/views.py:1143 and :1230 (foodbank_check, temperature 0,
// gemini-2.5-flash, FOODBANK_CHECK_RESPONSE_SCHEMA) and
// givefood/models/orders.py:142-159 (order lines, temperature 1, the array
// schema reproduced below). NONE of the four Django call sites passes
// `timeout`, so ai.py:32 leaves http_options None and the SDK's request is
// unbounded -- the 120s AbortSignal here is an addition, flagged as such.
//
// NOT VERIFIED AGAINST A LIVE GEMINI API CALL, and this file does not pretend
// otherwise -- the module's own header says the request shape is transcribed
// from Google's REST documentation and never exercised end to end, and there
// is no key on this machine to change that. What is tested here is that the
// port sends what it means to send and handles what comes back the way it
// says it does; whether Google accepts it is still an open question that only
// a real first call can close.
//
// MUTATION-TESTED TWICE, by the author and then adversarially.
//
// THE AUTHOR'S ROUND. The module was copied into a scratchpad OUTSIDE the repo
// and broken 41 ways: the sleep moved onto the happy path, the sleep set to
// 60ms / 6s / 10min / removed, `attempt < 1` and `attempt < 3`, temperature
// defaulted through `||`, thinkingConfig dropped and thinkingBudget raised to
// 1024, one safety category dropped and BLOCK_NONE weakened to
// BLOCK_ONLY_HIGH, responseMimeType and responseSchema dropped, the key
// unencoded and the key moved out of the query string, the model hard-coded,
// v1beta downgraded to v1, the 5xx boundary moved to 400 and to 501, `res.ok`
// narrowed to `=== 200`, the abort budget cut to 30s and removed entirely,
// the signal hoisted out of the loop, candidates[1] and parts[1], the raw
// envelope and the unparsed text returned, `!text` narrowed to
// `=== undefined`, the non-Error wrap removed, the FIRST error kept instead
// of the last, the response body dropped from both error messages, POST
// changed to GET, Content-Type dropped, the parts wrapper flattened, the
// prompt trimmed and trimEnd-ed, and the 5xx `continue` turned into a `break`
// and into a fall-through. All 41 were caught. Two of them were NOT caught by
// the first version of this file -- the 60ms sleep and the trimmed prompt --
// and the tests and helper that now kill them say so at the point of the fix,
// because a test that only passes is not evidence of anything.
//
// THE REVIEW ROUND, which is why "all 41 were caught" is not the end of the
// story: a later adversarial pass ran 92 mutants (a superset of the 41) the
// same way, in an isolated copy of the repo under the scratchpad, and FIFTEEN
// survived. Five were genuinely equivalent mutants -- the body object rebuilt
// per attempt, `60_000 * attempt`, `attempt % 2 === 1`, the 4xx throw
// rewritten as lastError+continue, and the two status branches reordered
// without changing which one wins -- and are left alone deliberately, because
// a test that pins an equivalent rewrite is a test that punishes tidying.
// The other TEN were real gaps, all now closed, each named at the test that
// closes it:
//   * the retry's abort budget was never asserted, only the first attempt's;
//   * a client status quietly rerouted into the 5xx branch (429, 404, 403)
//     changed nothing any test looked at;
//   * so did a 401/403 short-circuit that skipped the retry entirely;
//   * two DIFFERENT 5xx replies were never scripted, so keeping the first
//     error's body instead of the second's was invisible;
//   * `parts[0]` and `candidates[0]` had no test proving there is no
//     fallback to a later one;
//   * `!text` narrowed to `!text?.trim()` changed which message a
//     whitespace-only part produces, unwatched;
//   * and any extra key added to the fetch init went unnoticed.
//
// WHAT IS MOCKED, AND WHY ONLY THAT. `fetch`, because
// generativelanguage.googleapis.com is a live metered endpoint behind a
// credential this build does not have. Everything else is the real module --
// the URL construction, the body, the retry arithmetic, the response walk.
// Replies are REAL `Response` objects, because `res.status`, `res.ok`,
// `res.text()` and `res.json()` are what the module actually reads and an
// object literal would just be this file asserting its own idea of HTTP.

const API_KEY = "AIzaSy-fake-key-for-tests";

// Spelled out in full rather than rebuilt from the module's own constant.
// GEMINI_ENDPOINT is private to gemini.ts, so composing the expected URL the
// way the module composes it would assert nothing at all: a bumped API
// version or a mistyped host would change both sides together and this file
// would stay green while every AI job failed. "v1beta" is the version
// Google's generateContent documentation uses and is what the module ships.
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

// givefood/models/orders.py:146-158, transcribed. Used as the responseSchema
// in most tests because a realistic nested object is the only way to catch a
// pass-through that flattens, clones-with-loss, or JSON-round-trips its input.
const ORDER_LINE_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      name: { type: "string" },
      quantity: { type: "integer" },
      item_cost: { type: "integer" },
      weight: { type: "integer" },
    },
    required: ["name", "quantity", "item_cost", "weight"],
  },
};

/** The parameter object as the two real callers build it. Typed through the
 *  EXPORTED interface on purpose: `GeminiJsonCallParams` is half this
 *  module's public surface and is otherwise untestable at runtime, so a
 *  renamed or removed field has to fail `pnpm typecheck` here. */
function params(overrides: Partial<GeminiJsonCallParams> = {}): GeminiJsonCallParams {
  const base: GeminiJsonCallParams = {
    apiKey: API_KEY,
    model: "gemini-2.5-flash",
    prompt: "Check this food bank's details.",
    temperature: 0,
    responseSchema: ORDER_LINE_SCHEMA,
  };
  return { ...base, ...overrides };
}

type Reply = (init: RequestInit) => Promise<Response>;

/** A real Response, so status/ok/text()/json() behave as the runtime does. */
const raw = (body: string | null, status: number): Reply => async () => new Response(body, { status });

/** A 200 shaped like Google's generateContent success: the model's JSON comes
 *  back as a STRING inside candidates[0].content.parts[0].text, which is why
 *  the module has to JSON.parse it a second time. */
const answers = (text: string): Reply =>
  raw(JSON.stringify({ candidates: [{ content: { parts: [{ text }], role: "model" }, finishReason: "STOP" }] }), 200);

const rejects = (err: unknown): Reply => async () => {
  throw err;
};

/**
 * Scripts one reply per attempt. The module makes at most two requests, so a
 * one-element script answers both the same way and a two-element script gives
 * the first attempt one fate and the retry another -- which is the only way
 * to test "recovers on the second try" and "the LAST error is the one thrown".
 */
function stubFetch(...replies: Reply[]) {
  let n = 0;
  const fetchMock = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    // The url is recorded, not matched on. A stub that 404s an unexpected URL
    // would turn "posted to the wrong host" into a rejection, which this
    // module catches, retries and rethrows as a generic error -- i.e. into
    // exactly the shape of a legitimate upstream failure, which is the
    // distinction this file exists to make.
    void url;
    const reply = replies[Math.min(n, replies.length - 1)]!;
    n += 1;
    return reply(init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

type FetchMock = ReturnType<typeof stubFetch>;

const requestUrl = (m: FetchMock, i = 0): string => m.mock.calls[i]![0];
const requestInit = (m: FetchMock, i = 0): RequestInit => m.mock.calls[i]![1];
const headers = (m: FetchMock, i = 0): Record<string, string> => requestInit(m, i).headers as Record<string, string>;
/** The generateContent request body, as Google would see it. generationConfig
 *  is deliberately left as an open record rather than a named shape: the
 *  tests that read individual keys out of it are testing that the key is
 *  spelled the way Google spells it, and a typed accessor would just be this
 *  file agreeing with itself about the spelling. */
type SentBody = {
  contents: { parts: { text: string }[] }[];
  generationConfig: Record<string, unknown>;
  safetySettings: { category: string; threshold: string }[];
};
const sentBody = (m: FetchMock, i = 0): SentBody => JSON.parse(String(requestInit(m, i).body)) as SentBody;

const FROZEN = new Date("2026-09-05T19:28:08.853Z");

beforeEach(() => {
  // Only setTimeout/clearTimeout/Date are faked. AbortSignal.timeout is
  // deliberately left real, and that is safe rather than lucky: MEASURED, in
  // a throwaway probe run against a scratchpad copy of this repo on Node
  // v24.15.0 (vitest 5). With this exact toFake list,
  // AbortSignal.timeout(120_000) leaves vi.getTimerCount() at 0 where a plain
  // setTimeout(fn, 60_000) takes it to 1, and advancing the fake clock ten
  // minutes leaves signal.aborted false. So the 120s budget never fires
  // during these tests and every abort here is one a test injected, rather
  // than a surprise arriving 120 seconds into a scripted reply.
  //
  // The earlier version of this comment cited an "adminJobs/__probe.test.ts"
  // as its evidence. NO SUCH FILE EXISTS, in the tree or in git. The claim
  // happened to be true, but it was not checkable, which is the same as not
  // being evidence -- hence the numbers above, which were actually run.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(FROZEN);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Runs a geminiJsonCall to completion under fake timers, firing the module's
 * 60s sleep when (and only when) the module actually schedules one.
 *
 * advanceTimersToNextTimerAsync, NOT advanceTimersByTimeAsync(60_000). This
 * is the difference between a helper that measures the sleep and one that
 * dictates it: "advance by 60 seconds" moves the clock 60 seconds whatever
 * the module actually asked for, so `sleptMs()` would read 60_000 even
 * against a module that had written `setTimeout(resolve, 60)` -- the classic
 * seconds-for-milliseconds slip, ported straight from Django's `sleep(60)`,
 * and the single likeliest mistake in this file. Advancing to the NEXT timer
 * moves the clock to exactly where that timer was scheduled, so sleptMs()
 * reports the module's own number. (Caught by mutation testing: the 60ms
 * mutant survived the first version of this helper.)
 *
 * The guard on getTimerCount matters too: advancing unconditionally would
 * move the clock even on the success path and destroy the "a call that
 * succeeds first time does not sleep" assertion. advanceTimersByTimeAsync(0)
 * yields a REAL macrotask without moving the clock, which is what lets the
 * pending fetch/Response promises settle so the module can get as far as
 * scheduling its sleep in the first place.
 */
async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  const outcome = promise.then(
    (value) => {
      done = true;
      return { ok: true as const, value };
    },
    (error: unknown) => {
      done = true;
      return { ok: false as const, error };
    },
  );
  for (let i = 0; i < 200 && !done; i++) {
    if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
    else await vi.advanceTimersByTimeAsync(0);
  }
  if (!done) throw new Error("geminiJsonCall never settled: it is waiting on something this helper does not drive");
  const result = await outcome;
  if (result.ok) return result.value;
  throw result.error;
}

/** How far the module moved the clock -- i.e. how much of a queue consumer's
 *  wall-clock budget one call spent asleep. */
const sleptMs = () => Date.now() - FROZEN.getTime();

describe("the request that goes to Google", () => {
  it("posts to v1beta generateContent for the model it was given", async () => {
    // The model is the caller's choice. Both callers currently ask for
    // gemini-2.5-flash, so this uses a different one: a hard-coded model here
    // would otherwise pass unnoticed. (The order parse used to ask for
    // gemini-2.0-flash; Google retired it and every parse failed.)
    const fetchMock = stubFetch(answers("[]"));
    await settle(geminiJsonCall(params({ model: "gemini-2.5-flash-lite" })));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestUrl(fetchMock)).toBe(`${ENDPOINT}/gemini-2.5-flash-lite:generateContent?key=${API_KEY}`);
  });

  it("authenticates with a ?key= query parameter and no auth header", async () => {
    // Google's REST API accepts either ?key= or an x-goog-api-key header;
    // this port chose the query parameter. Pinned in both directions, because
    // "moved the key to a header" and "left the key in the URL and ALSO added
    // a header" are both silent changes -- the first is a 403 on every call,
    // the second leaks the credential twice over.
    const fetchMock = stubFetch(answers("[]"));
    await settle(geminiJsonCall(params({ apiKey: "secret-key-9" })));

    expect(requestUrl(fetchMock)).toContain("?key=secret-key-9");
    expect(headers(fetchMock)).toEqual({ "Content-Type": "application/json" });
    expect(headers(fetchMock)).not.toHaveProperty("Authorization");
    expect(headers(fetchMock)).not.toHaveProperty("x-goog-api-key");
  });

  it("percent-encodes the key, so a key with URL metacharacters is not truncated", async () => {
    // encodeURIComponent, gemini.ts:49. Not theoretical: a key containing a
    // "+" or a "&" pasted into `wrangler secret put` would, unencoded, be
    // read by Google as a space or as the start of another query parameter,
    // and the failure is a 403 that looks exactly like a revoked credential
    // -- sending someone to rotate a key that was fine.
    const fetchMock = stubFetch(answers("[]"));
    await settle(geminiJsonCall(params({ apiKey: "a+b&c=d/e" })));

    expect(requestUrl(fetchMock)).toBe(`${ENDPOINT}/gemini-2.5-flash:generateContent?key=a%2Bb%26c%3Dd%2Fe`);
  });

  it("does NOT encode the model, splicing it into the path verbatim", async () => {
    // Pinned as current behaviour, not endorsed. Only the key gets
    // encodeURIComponent; the model is interpolated raw, so a model name
    // carrying a "/" or a "?" would rewrite the path rather than 404.
    // Harmless today -- both callers pass a string literal -- and recorded so
    // that if a model name ever becomes configurable the gap is documented
    // rather than discovered.
    const fetchMock = stubFetch(answers("[]"));
    await settle(geminiJsonCall(params({ model: "models/x?y" })));

    expect(requestUrl(fetchMock)).toBe(`${ENDPOINT}/models/x?y:generateContent?key=${API_KEY}`);
  });

  it("sends the exact generateContent body, field for field", async () => {
    // The whole object, not a spot check. Google validates generationConfig
    // strictly: an unknown key, a misspelled `responseMimeType`, or contents
    // in the wrong shape is a 400 INVALID_ARGUMENT, which queues/jobs.ts
    // turns into one failed admin_job row and no other signal anywhere.
    //
    // The four safety categories at BLOCK_NONE are ai.py:33-50 and the
    // thinkingConfig is ai.py:31's ThinkingConfig(thinking_budget=0). Both
    // are the module's stated reason for existing at all: without
    // thinkingBudget 0 a 2.5-series model spends (billed) thinking tokens on
    // a structured extraction that does not need them, and without the safety
    // overrides a food bank page mentioning domestic abuse or addiction
    // support gets its check silently blocked.
    //
    // The ORDER below is the PORT's, not Django's: ai.py lists HATE_SPEECH
    // first and HARASSMENT second, gemini.ts:24 has them the other way round.
    // Google does not care, so this is a harmless divergence -- pinned in the
    // port's order rather than Django's so that nobody reads this array as a
    // parity assertion and "corrects" the module to match ai.py.
    const fetchMock = stubFetch(answers("[]"));
    await settle(geminiJsonCall(params({ prompt: "Parse these order lines.", temperature: 1 })));

    expect(sentBody(fetchMock)).toStrictEqual({
      contents: [{ parts: [{ text: "Parse these order lines." }] }],
      generationConfig: {
        temperature: 1,
        responseMimeType: "application/json",
        responseSchema: ORDER_LINE_SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
      },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
      ],
    });
    expect(requestInit(fetchMock).method).toBe("POST");
  });

  it("sends temperature 0 as 0, not as a falsy value replaced by a default", async () => {
    // THE MUTANT THIS KILLS: `temperature: params.temperature || 1`, or a
    // `?? ` written where the author meant a nullish guard but reached for
    // `||`. gfadmin/views.py:1145 passes 0 for the foodbank check precisely
    // because that check must be reproducible -- a silent 1 makes the same
    // food bank produce different "found" values on consecutive runs, and the
    // reviewer sees phantom discrepancies with nothing to attribute them to.
    // Every other test in this file uses a truthy temperature, so without
    // this one that mutant survives the entire suite.
    const fetchMock = stubFetch(answers("[]"));
    await settle(geminiJsonCall(params({ temperature: 0 })));

    expect(sentBody(fetchMock).generationConfig.temperature).toBe(0);
    expect(Object.is(sentBody(fetchMock).generationConfig.temperature, -0)).toBe(false);
  });

  it("passes the response schema through untouched, nesting and all", async () => {
    // orderLines.ts and foodbankCheck.ts each hand over a large literal
    // schema. Anything that rebuilds it -- a shallow clone, a key filter, a
    // "normalise the schema" helper -- would drop the nested `items` or the
    // `required` array, and Google answers a schema it does not understand
    // with free-form JSON rather than an error. The order parse then gets
    // objects with the wrong keys, the isAiOrderLine filter (orderLines.ts:132,
    // predicate at :90) drops every one of them, and the order silently ends
    // up with zero lines.
    const fetchMock = stubFetch(answers("[]"));
    await settle(geminiJsonCall(params()));

    expect(sentBody(fetchMock).generationConfig.responseSchema).toStrictEqual(ORDER_LINE_SCHEMA);
  });

  it("omits responseSchema entirely when the caller passes undefined", async () => {
    // `responseSchema: unknown` accepts undefined, and JSON.stringify then
    // drops the key rather than sending null -- which is the correct wire
    // shape for "no schema" and matches ai.py's response_schema = None
    // default. Asserted through Object.keys because toEqual treats a missing
    // key and an undefined one as the same thing, so a mutant that sent
    // `"responseSchema": null` (which Google rejects) would slip past.
    const fetchMock = stubFetch(answers("[]"));
    await settle(geminiJsonCall(params({ responseSchema: undefined })));

    expect(Object.keys(sentBody(fetchMock).generationConfig)).toEqual(["temperature", "responseMimeType", "thinkingConfig"]);
  });

  it("sends the prompt verbatim, surrounding whitespace included", async () => {
    // Both prompts are rendered templates carrying JSON, markdown scraped off
    // food bank websites, apostrophes and accented Welsh place names. There
    // is no encoder in this path but JSON.stringify; anything that trimmed or
    // "sanitised" the prompt here would change what the model was asked
    // without changing anything visible.
    //
    // THE LEADING AND TRAILING NEWLINES ARE THE POINT, not decoration. Django
    // builds both prompts with render_to_string (orders.py:136, and
    // gfadmin/views.py:1002 inside _build_foodbank_check_data at :861), and a
    // Django template file almost always ends in a newline, so prompts arrive
    // with whitespace on both ends. A `.trim()` added "for tidiness" would
    // therefore change the exact bytes the model is scored on for every
    // single call while passing a test that used a tidy literal -- which is
    // precisely what happened: the trim mutant survived until this test
    // grew its newlines.
    const prompt = '\nFoodbank: Caffi Wcw, Aberdâr\n\n{"url": "https://x/y?a=1&b=2"}\n\nDon\'t guess.\n';
    const fetchMock = stubFetch(answers("[]"));
    await settle(geminiJsonCall(params({ prompt })));

    expect(sentBody(fetchMock).contents[0]!.parts[0]!.text).toBe(prompt);
  });

  it("gives each request a fresh 120 second abort budget", async () => {
    // NOT A PORT. None of Django's four call sites passes `timeout`, so
    // ai.py:31 leaves http_options None and the SDK request is unbounded.
    // Unbounded is survivable in a Django request thread and is not
    // survivable here: this runs inside a serial loop over a batch of up to
    // ten messages (queues/jobs.ts:20), so one stalled socket is not a slow
    // job, it is nine other jobs that never run and a consumer invocation
    // that dies without acking any of them.
    //
    // Asserted through the AbortSignal.timeout spy, because the only other
    // way to observe 120_000 is to sit through it.
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = stubFetch(answers("[]"));
    await settle(geminiJsonCall(params()));

    expect(timeout).toHaveBeenCalledWith(120_000);
    const signal = requestInit(fetchMock).signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    // Not already aborted when handed to fetch -- a signal built from
    // AbortSignal.abort() would be, and would fail every call instantly while
    // looking like a network problem.
    expect(signal.aborted).toBe(false);
  });

  it("builds a NEW abort signal for the retry rather than reusing the first", async () => {
    // The signal is constructed inside the loop (gemini.ts:53). If it were
    // hoisted out, the retry would inherit a budget that had already been
    // ticking for two minutes -- so the second attempt would abort
    // immediately and the recovery path would never work, on the exact
    // occasions it exists for.
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = stubFetch(raw("upstream", 503), answers("[]"));
    await settle(geminiJsonCall(params()));

    expect(timeout).toHaveBeenCalledTimes(2);
    expect(requestInit(fetchMock, 0).signal).not.toBe(requestInit(fetchMock, 1).signal);
    // BOTH budgets are 120s, asserted per call. THE MUTANT THIS KILLS:
    // `AbortSignal.timeout(120_000 * (attempt + 1))` -- the "add some backoff
    // while I'm here" edit, which hands the retry four minutes instead of two.
    // The test above uses toHaveBeenCalledWith(120_000), which passes on the
    // FIRST call and therefore cannot see it; nothing in the suite could, and
    // it survived the whole file until these two lines. It matters for the
    // same reason the 120s budget exists at all: this loop is inside a serial
    // walk of a ten-message batch, so a doubled retry budget doubles the
    // worst case for every other message queued behind it.
    expect(timeout).toHaveBeenNthCalledWith(1, 120_000);
    expect(timeout).toHaveBeenNthCalledWith(2, 120_000);
  });

  it("passes fetch exactly the four request options, and no fifth", async () => {
    // THE MUTANT THIS KILLS: any extra key added to the init object --
    // `redirect`, `cache`, `credentials`, `keepalive`. Each is a one-word
    // edit, and none of them disturbs a single assertion above, because every
    // other test in this file reaches into the init for a named key rather
    // than looking at the whole of it. `redirect: "manual"` in particular
    // changes how a 3xx from Google is handled, which is the one case the
    // suite already documents as unreachable-but-pinned below -- exactly the
    // kind of behaviour that gets changed by accident and noticed by nobody.
    const fetchMock = stubFetch(answers("[]"));
    await settle(geminiJsonCall(params()));

    expect(Object.keys(requestInit(fetchMock)).sort()).toEqual(["body", "headers", "method", "signal"]);
  });

  it("sends a byte-identical body on the retry", async () => {
    // The body object is built once, outside the loop. That has to stay true:
    // a retry that re-derived the prompt, or that mutated the shared object
    // (say by stamping an attempt counter into it), would ask a different
    // question the second time round and make failures irreproducible.
    const fetchMock = stubFetch(raw("upstream", 500), answers("[]"));
    await settle(geminiJsonCall(params()));

    expect(String(requestInit(fetchMock, 1).body)).toBe(String(requestInit(fetchMock, 0).body));
    expect(requestUrl(fetchMock, 1)).toBe(requestUrl(fetchMock, 0));
  });
});

describe("a successful response", () => {
  it("returns the JSON parsed out of the text part, not the envelope", async () => {
    // The double decode is the whole trick of this function: Google returns
    // JSON whose `text` field is ITSELF a JSON document, because
    // responseMimeType only constrains the model's output, not the transport.
    // A version that returned res.json() directly would hand orderLines.ts
    // the candidates envelope, `Array.isArray` would be false, and every
    // order would fail with "The model did not return a list of order lines"
    // -- a message that blames the model for a bug in the client.
    stubFetch(answers(JSON.stringify([{ name: "Baked Beans", quantity: 4, item_cost: 55, weight: 400 }])));

    expect(await settle(geminiJsonCall(params()))).toStrictEqual([{ name: "Baked Beans", quantity: 4, item_cost: 55, weight: 400 }]);
  });

  it("returns a nested object result whole, matching the foodbank check's shape", async () => {
    // foodbankCheck.ts:179-185 casts the return straight to
    // FoodbankCheckAiResponse and then iterates `aiResponse.details`. A
    // return that lost a level of nesting would throw a TypeError inside that
    // loop, be caught by the handler's own try/catch, and be written onto the
    // admin_job row as "Cannot read properties of undefined" -- which reads
    // like a database problem, not a client one.
    const result = {
      details: { phone_number: "01353 555555", email: "info@example.org", network: "Trussell" },
      locations: [{ name: "Ely", address: "1 High St", postcode: "CB7 4AA" }],
      donation_points: [],
    };
    stubFetch(answers(JSON.stringify(result)));

    expect(await settle(geminiJsonCall(params()))).toStrictEqual(result);
  });

  it("makes exactly one request and does not sleep when the first attempt works", async () => {
    // THE MOST IMPORTANT TIMING ASSERTION HERE. `if (attempt > 0)` is the only
    // thing keeping the 60 second sleep off the happy path. Move that sleep
    // above the guard -- or write `attempt >= 0` -- and every AI job still
    // works, still returns the right answer, and still passes every other
    // test in this file, while a batch of ten costs ten extra minutes of a
    // queue consumer that gets fifteen.
    const fetchMock = stubFetch(answers("[]"));
    await settle(geminiJsonCall(params()));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleptMs()).toBe(0);
  });

  it("accepts any 2xx, not only 200", async () => {
    // Pinned as a real difference from the port's other HTTP clients:
    // notify/whatsappClient.ts checks `=== 200` exactly because Django does,
    // and this module checks `res.ok`. Both are deliberate, and knowing which
    // is which matters when someone "makes the clients consistent".
    stubFetch(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }), { status: 202 }));

    expect(await settle(geminiJsonCall(params()))).toStrictEqual({ ok: true });
  });

  it("returns JSON scalars and null as themselves", async () => {
    // `return JSON.parse(text)` means the return is whatever the model's text
    // decoded to, not necessarily an object. Worth pinning because the
    // truthiness guard sits on the TEXT, not on the parsed value: the string
    // "null" is truthy, so a model that answers `null` produces a successful
    // call returning null -- and orderLines.ts:128's Array.isArray check is
    // the only thing that catches it. `false` and `0` behave the same way.
    for (const [text, expected] of [
      ["null", null],
      ["false", false],
      ["0", 0],
      ['"just a string"', "just a string"],
    ] as const) {
      stubFetch(answers(text));
      expect(await settle(geminiJsonCall(params()))).toStrictEqual(expected);
    }
  });

  it("reads only the FIRST candidate and only its FIRST part", async () => {
    // gemini.ts:62 is a chain of [0]s. With thinkingBudget 0 there should
    // only ever be one part, which is exactly why this is worth recording:
    // if that config were ever dropped, a 2.5-series model would return a
    // thought part first and the client would parse the model's reasoning
    // instead of its answer -- silently, and only for some prompts.
    stubFetch(
      raw(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: '{"chosen":"first part"}' }, { text: '{"chosen":"second part"}' }] } },
            { content: { parts: [{ text: '{"chosen":"second candidate"}' }] } },
          ],
        }),
        200,
      ),
    );

    expect(await settle(geminiJsonCall(params()))).toStrictEqual({ chosen: "first part" });
  });
});

describe("responses that carry no usable text", () => {
  // Every case in this block ends up at gemini.ts:63's "Gemini response had
  // no text part", which is thrown INSIDE the try -- so each of them costs a
  // 60 second sleep and a second billed request before it gives up. That is
  // asserted once here rather than in every case.

  const noTextCases: [string, string][] = [
    // A safety or recitation block: Google returns a candidate with a
    // finishReason and NO content at all. Reachable despite all four
    // categories being BLOCK_NONE, because RECITATION and MAX_TOKENS are not
    // safety filters and cannot be switched off.
    ["a candidate blocked before it produced content", JSON.stringify({ candidates: [{ finishReason: "RECITATION", index: 0 }] })],
    // promptFeedback with no candidates: the prompt itself was rejected.
    ["a prompt rejected outright, with only promptFeedback", JSON.stringify({ promptFeedback: { blockReason: "OTHER" } })],
    ["an empty candidates array", JSON.stringify({ candidates: [] })],
    ["a candidate whose parts array is empty", JSON.stringify({ candidates: [{ content: { parts: [], role: "model" } }] })],
    ["a part with no text field", JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: {} }] } }] })],
    // THE TWO ROWS BELOW EXIST TO PROVE THERE IS NO FALLBACK. gemini.ts:62 is
    // a chain of [0]s that STOPS at [0]: a first part or first candidate that
    // carries no text ends the call, even when a later one does carry text.
    // THE MUTANTS THEY KILL: `parts?.[0]?.text ?? parts?.[1]?.text` and
    // `candidates?.[0]?...  ?? candidates?.[1]?...`, both of which are the
    // obvious "helpful" repair for someone who has just watched a thought
    // part or an empty candidate come back first. Both survived every other
    // test here, because every other no-text case has exactly one part and
    // exactly one candidate -- a fallback had nothing to fall back TO.
    [
      "a first part with no text followed by a second that has one",
      JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: {} }, { text: '{"reached":"the second part"}' }] } }] }),
    ],
    [
      "a first candidate with no content followed by a second that has text",
      JSON.stringify({
        candidates: [{ finishReason: "SAFETY", index: 0 }, { content: { parts: [{ text: '{"reached":"the second candidate"}' }] } }],
      }),
    ],
    // The falsy-string case. `if (!text)` rejects "" as well as undefined, so
    // a model that answered with nothing is reported the same way as a
    // malformed envelope -- both are equally unusable, and JSON.parse("")
    // would throw a less legible SyntaxError anyway.
    ["a text part that is the empty string", JSON.stringify({ candidates: [{ content: { parts: [{ text: "" }] } }] })],
  ];

  for (const [label, body] of noTextCases) {
    it(`rejects ${label} with the no-text-part message`, async () => {
      stubFetch(raw(body, 200));
      await expect(settle(geminiJsonCall(params()))).rejects.toThrow("Gemini response had no text part");
    });
  }

  it("burns a retry and a 60 second sleep before giving up on a no-text response", async () => {
    // SUSPECT, PINNED NOT FIXED. A safety block or an empty candidates array
    // is deterministic: asking the identical prompt sixty seconds later gets
    // the identical refusal. So this path pays for a second billed Gemini
    // call and a minute of the queue consumer's wall clock to learn nothing.
    // Django never did this -- ai.py:59 retries ONLY on ServerError, and a
    // response with no text is not an exception there at all (ai.py:67-77
    // returns response.text, or None).
    const fetchMock = stubFetch(raw(JSON.stringify({ candidates: [{ finishReason: "SAFETY" }] }), 200));

    await expect(settle(geminiJsonCall(params()))).rejects.toThrow("Gemini response had no text part");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleptMs()).toBe(60_000);
  });

  it("throws away Google's blockReason and finishReason, leaving nothing to diagnose with", async () => {
    // SUSPECT, PINNED NOT FIXED. The message is a fixed string: the
    // finishReason ("SAFETY", "RECITATION", "MAX_TOKENS") and any
    // promptFeedback.blockReason are dropped on the floor. Since
    // orderLines.ts:193 and foodbankCheck.ts write `err.message` onto the
    // admin_job row and that row is the ONLY record of the failure, the
    // difference between "the model refused" and "the answer was truncated"
    // is unrecoverable after the fact -- the response body is gone.
    stubFetch(raw(JSON.stringify({ candidates: [{ finishReason: "MAX_TOKENS" }], promptFeedback: { blockReason: "OTHER" } }), 200));

    const err = await settle(geminiJsonCall(params())).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err!.message).toBe("Gemini response had no text part");
    expect(err!.message).not.toContain("MAX_TOKENS");
    expect(err!.message).not.toContain("OTHER");
  });
});

describe("server errors: the one retry Django actually has", () => {
  // ai.py:59-65 -- `except ServerError: sleep(60); <retry once>`. google-genai
  // raises ServerError for 5xx and ClientError for 4xx, so this branch, and
  // only this branch, is the ported one.

  it("retries a 503 once after sixty seconds and returns the retry's answer", async () => {
    // The whole point of the work package: a 503 from Google is common and
    // transient, and this runs in a queue consumer that can afford to wait it
    // out where a request-scoped handler could not.
    const fetchMock = stubFetch(raw("The service is currently unavailable.", 503), answers('{"recovered":true}'));

    expect(await settle(geminiJsonCall(params()))).toStrictEqual({ recovered: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Exactly sixty seconds, measured off the fake clock. A mutant with
    // 60 (milliseconds, the classic setTimeout/sleep unit confusion) or
    // 600_000 passes every other test here.
    expect(sleptMs()).toBe(60_000);
  });

  it("gives up after the second 5xx, quoting the status and Google's body", async () => {
    // TWO attempts total, not three and not a loop that keeps going. The
    // status alone is not enough to act on: Google distinguishes an
    // overloaded model (503 UNAVAILABLE) from an internal failure (500) in
    // the body, and this string is all that reaches the admin_job row.
    const fetchMock = stubFetch(raw('{"error":{"code":503,"message":"The model is overloaded."}}', 503));

    await expect(settle(geminiJsonCall(params()))).rejects.toThrow(
      'Gemini server error: 503 {"error":{"code":503,"message":"The model is overloaded."}}',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleptMs()).toBe(60_000);
  });

  it("reports the SECOND server error, discarding the first attempt's body", async () => {
    // THE MUTANT THIS KILLS: `lastError = lastError ?? new Error(...)` in the
    // 5xx branch -- the "keep the first error" slip, which is the same family
    // as the one already pinned for the catch block below but is a SEPARATE
    // assignment and was covered by nothing. It survived the whole suite
    // because every other 5xx test scripts the identical reply twice, so
    // first and second are indistinguishable by construction.
    //
    // It is worth distinguishing. A 503 "the model is overloaded" followed by
    // a 500 "internal error" is a different story from two 503s, and the
    // admin_job row gets exactly one of them -- whichever this line picked.
    const fetchMock = stubFetch(raw("first: the model is overloaded", 503), raw("second: internal error", 500));

    await expect(settle(geminiJsonCall(params()))).rejects.toThrow("Gemini server error: 500 second: internal error");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats 500 and 599 as server errors and 499 as a client error", async () => {
    // The boundary of `res.status >= 500`. Both sides retry, so the ONLY
    // observable difference is the wording of the thrown message -- which is
    // also the only thing written onto the admin_job row, and therefore the
    // only clue whether to chase Google or to chase our own request.
    for (const [status, wording] of [
      [500, "Gemini server error: 500"],
      [599, "Gemini server error: 599"],
      [499, "Gemini API error: 499"],
    ] as const) {
      stubFetch(raw("body text", status));
      await expect(settle(geminiJsonCall(params()))).rejects.toThrow(`${wording} body text`);
    }
  });

  it("loses the status when a failed response's body cannot be read", async () => {
    // `await res.text()` is evaluated INSIDE the template literal, which is
    // inside the try. A body stream that errors mid-read on an already-failed
    // response therefore never produces the "Gemini server error: 502"
    // string at all -- the read failure becomes the error instead, and the
    // status is lost for good. Same trap as notify/whatsappClient.ts, pinned
    // here so the two stay consistent.
    stubFetch(async () => {
      const res = new Response("x", { status: 502 });
      Object.defineProperty(res, "text", {
        value: async () => {
          throw new Error("body stream errored");
        },
      });
      return res;
    });

    await expect(settle(geminiJsonCall(params()))).rejects.toThrow("body stream errored");
  });
});

describe("client errors: retried too, which Django does not do", () => {
  it("retries a 400 after a full sixty second sleep before giving up", async () => {
    // SUSPECT, PINNED NOT FIXED. `if (!res.ok) throw` throws INSIDE the try,
    // so the catch on gemini.ts:65 swallows it and the loop runs a second
    // attempt -- meaning every 4xx costs two billed requests and sixty
    // seconds of a serial queue consumer. Django does not: ai.py:59 catches
    // ServerError only, so a ClientError propagates on the first attempt.
    //
    // It matters most for the failures that are certain to repeat. A 400
    // INVALID_ARGUMENT (a schema Google will not accept), a 403 (a key that
    // was never deployed -- wrangler.jsonc:246 says GEMINI_API_KEY is not set
    // on the real account) and a 404 (a retired model id) are all permanent,
    // and all now take 60+ seconds each to fail. A batch of ten order-line
    // jobs against an undeployed key spends ten minutes of the invocation
    // discovering the same thing ten times.
    const fetchMock = stubFetch(raw('{"error":{"code":400,"message":"Invalid JSON payload"}}', 400));

    await expect(settle(geminiJsonCall(params()))).rejects.toThrow('Gemini API error: 400 {"error":{"code":400,"message":"Invalid JSON payload"}}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleptMs()).toBe(60_000);
  });

  it("retries a 429, which is the one client error where waiting helps", async () => {
    // The redeeming case for the behaviour above: RESOURCE_EXHAUSTED really
    // does clear, and free-tier Gemini quotas are per-minute, so a sixty
    // second wait is very close to the right thing. Asserted as a recovery,
    // not just a retry, so the success-after-4xx path is genuinely exercised.
    const fetchMock = stubFetch(raw('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}', 429), answers("[]"));

    expect(await settle(geminiJsonCall(params()))).toStrictEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleptMs()).toBe(60_000);
  });

  it("gives each of Google's real client errors two attempts and the client wording", async () => {
    // THE MUTANTS THIS KILLS, three of which survived everything else in this
    // file:
    //   * `if (res.status >= 500 || res.status === 429)`, and the same edit
    //     for 403 or 404 -- moving one client status across the branch
    //     boundary. Before this test the ONLY 4xx statuses whose final
    //     message was pinned were 400 and 499, so a status rerouted into the
    //     server-error branch changed the admin_job row's wording from
    //     "our request is wrong" to "Google is down" with nothing watching.
    //     The 429 test above could not see it either: it asserts a RECOVERY,
    //     and a rerouted 429 recovers identically.
    //   * `if (res.status === 401 || res.status === 403) { ...; break; }` --
    //     the "don't retry a permanent auth failure" edit. Arguably an
    //     improvement, definitely not what this module does today, and it
    //     halves how long a batch takes to fail, which is the sort of change
    //     that should be made on purpose.
    //
    // The statuses are the ones Google actually returns: 400 INVALID_ARGUMENT
    // (a schema it will not accept), 403 PERMISSION_DENIED (the state
    // GEMINI_API_KEY is in on the real account -- wrangler.jsonc:236-246 says
    // in as many words that it is not set), 404 NOT_FOUND (a retired model
    // id), 429 RESOURCE_EXHAUSTED.
    for (const status of [400, 403, 404, 429]) {
      const fetchMock = stubFetch(raw(`refused ${status}`, status));

      await expect(settle(geminiJsonCall(params()))).rejects.toThrow(`Gemini API error: ${status} refused ${status}`);
      expect(fetchMock, `status ${status} should cost two attempts`).toHaveBeenCalledTimes(2);
    }
  });

  it("treats a 3xx as a client error rather than following it", async () => {
    // `res.ok` is 200-299, so a 301 lands in the `!res.ok` branch. In
    // practice fetch follows redirects itself and this is unreachable; pinned
    // because if it ever IS reached, the message says "Gemini API error: 301"
    // and not "redirect", and someone will need to know that.
    stubFetch(raw("Moved", 301));
    await expect(settle(geminiJsonCall(params()))).rejects.toThrow("Gemini API error: 301 Moved");
  });
});

describe("malformed successes", () => {
  it("fails when a 2xx body is not JSON at all", async () => {
    // A Cloudflare or Google edge error page served with a 200 -- rarer than
    // it used to be, but the reason `await res.json()` sits inside the try.
    // The message is whatever the JSON parser said, so it will not mention
    // Gemini at all; that is what the admin_job row will show.
    const fetchMock = stubFetch(raw("<html>upstream said no</html>", 200));

    await expect(settle(geminiJsonCall(params()))).rejects.toThrow(SyntaxError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails when a 2xx has an empty body", async () => {
    // A 204, or a 200 with nothing in it. `res.ok` is true, so the module
    // gets as far as res.json() and dies there rather than at the status
    // check -- worth knowing, because the resulting message ("Unexpected end
    // of JSON input") gives no hint that the response was empty.
    stubFetch(raw(null, 204));
    await expect(settle(geminiJsonCall(params()))).rejects.toThrow(SyntaxError);
  });

  it("fails when the text part is prose rather than the JSON it asked for", async () => {
    // The model ignoring responseMimeType. THE ERROR IS MISLEADING AND IS
    // PINNED AS SUCH: what reaches the admin_job row is a raw JSON parser
    // message with no indication that Gemini was involved or that the model
    // is the thing that misbehaved. Django's ai.py:71-75 handled this case
    // instead of failing -- on a JSONDecodeError it returns `text.strip()`,
    // so a Django caller got the prose back. The port throws. That divergence
    // is invisible to both current callers (both need structured data and
    // would fail on prose anyway), which is exactly why it is written down.
    const fetchMock = stubFetch(answers("I'm sorry, I can't help with that request."));

    await expect(settle(geminiJsonCall(params()))).rejects.toThrow(SyntaxError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleptMs()).toBe(60_000);
  });

  it("sends a whitespace-only text part to the JSON parser, not to the no-text guard", async () => {
    // The guard on gemini.ts:63 tests FALSINESS, not blankness: "   " is a
    // truthy string, so it sails past `!text` and dies in JSON.parse with a
    // SyntaxError instead of "Gemini response had no text part".
    //
    // THE MUTANT THIS KILLS: `if (!text?.trim())`. It reads like a tidying
    // no-op, it is one character short of the code that is here, and it
    // swaps which of the two messages lands on the admin_job row -- i.e.
    // whether the person reading it goes looking at the model or at the
    // client. Nothing else in the file distinguishes the two, because every
    // other no-text case uses "" or a missing key, where both spellings of
    // the guard agree.
    const fetchMock = stubFetch(answers("   \n  "));

    const err = await settle(geminiJsonCall(params())).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(SyntaxError);
    expect(err!.message).not.toContain("no text part");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers when only the first attempt's text is unparseable", async () => {
    // The flip side, and the one case where retrying a non-5xx genuinely
    // earns its sleep: at temperature 1 (orderLines.ts:123, orders.py:144)
    // the model's output really is non-deterministic, so a second roll of
    // the dice can succeed where the first produced a stray prefix.
    const fetchMock = stubFetch(answers("```json\n[]\n```"), answers('[{"name":"Rice","quantity":1,"item_cost":90,"weight":500}]'));

    expect(await settle(geminiJsonCall(params({ temperature: 1 })))).toStrictEqual([{ name: "Rice", quantity: 1, item_cost: 90, weight: 500 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("network failures", () => {
  it("retries a rejected fetch once and rethrows the same Error object", async () => {
    // Worker subrequest limits, DNS and TLS failures all arrive as a
    // rejection rather than a Response. The IDENTITY check matters: the
    // original error carries the stack, and a rethrow that wrapped it in a
    // new Error (or interpolated it into a string) would leave the admin_job
    // row holding "[object Object]" or a message with no origin.
    const boom = new TypeError("Network connection lost.");
    const fetchMock = stubFetch(rejects(boom));

    const thrown = await settle(geminiJsonCall(params())).then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toBe(boom);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleptMs()).toBe(60_000);
  });

  it("surfaces an abort as the abort error, not as a generic failure", async () => {
    // The other half of the 120 second budget. When the signal fires, fetch
    // rejects with a TimeoutError and that has to be what escapes -- a
    // consumer that hit its abort twice is a different problem (Google is
    // hanging) from one that got a 400 (our request is wrong), and the
    // admin_job row is where that gets distinguished.
    const budgets: AbortController[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController();
      budgets.push(controller);
      return controller.signal;
    });
    const fetchMock = stubFetch(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")));
          // Fire THIS attempt's budget. Each attempt builds its own signal
          // (gemini.ts:53), so each has to be aborted separately -- writing
          // this test with one shared controller left the retry hanging
          // forever, because an already-aborted signal never dispatches a
          // second `abort` event. Worth recording: it is also what would
          // happen in production if the signal were ever hoisted out of the
          // loop, and the symptom would be a queue consumer that stops.
          budgets[budgets.length - 1]!.abort();
        }),
    );

    await expect(settle(geminiJsonCall(params()))).rejects.toThrow("The operation was aborted due to timeout");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(budgets).toHaveLength(2);
  });

  it("wraps a non-Error rejection with String() instead of throwing the raw value", async () => {
    // gemini.ts:69's `lastError instanceof Error ? ... : new Error(String(...))`.
    // A thrown string or object would otherwise reach orderLines.ts:196's
    // `err instanceof Error ? err.message : String(err)` and be stringified
    // there anyway -- but foodbankCheck's own handler and any future caller
    // are entitled to assume an Error, and "throws whatever it was given"
    // is the kind of thing that only bites in production.
    stubFetch(rejects("just a string, thrown"));

    const thrown = await settle(geminiJsonCall(params())).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown!.message).toBe("just a string, thrown");
  });

  it("stringifies a thrown object rather than letting it escape, warts and all", async () => {
    // Pinned as current behaviour, not endorsed: String({}) is
    // "[object Object]", so an upstream that rejects with a plain object
    // leaves an admin_job row saying nothing whatsoever. Recorded because
    // "[object Object]" in the jobs list is otherwise a mystery with no
    // traceable source.
    stubFetch(rejects({ code: "ECONNRESET" }));

    const thrown = await settle(geminiJsonCall(params())).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(thrown!.message).toBe("[object Object]");
  });
});

describe("attempt accounting", () => {
  it("never makes a third attempt, whatever the failure", async () => {
    // `attempt < 2`. An off-by-one here is expensive in a way nothing else
    // in this Worker is: each extra attempt is another 60 second sleep,
    // another 120 second budget and another billed Gemini call, multiplied
    // by however many messages are in the batch. Asserted across the three
    // different failure branches, since each takes a different route out of
    // the try.
    for (const reply of [raw("500 body", 500), raw("400 body", 400), rejects(new Error("boom"))]) {
      const fetchMock = stubFetch(reply);
      await settle(geminiJsonCall(params())).catch(() => {});
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it("throws the SECOND failure and discards the first", async () => {
    // `lastError` is overwritten, not accumulated. So a call that got a 503
    // and then a 400 reports only the 400 -- and whoever reads the admin_job
    // row will conclude the request shape is wrong when the first symptom
    // was Google being down. Pinned because it is genuinely surprising, and
    // because a "helpful" change to report both would be a behaviour change
    // worth noticing.
    stubFetch(raw("overloaded", 503), raw("bad request", 400));

    await expect(settle(geminiJsonCall(params()))).rejects.toThrow("Gemini API error: 400 bad request");
  });

  it("sleeps exactly once across two attempts, before the second and not after it", async () => {
    // Both halves matter. A sleep after the final attempt would add sixty
    // seconds to every permanent failure for no benefit at all, and would be
    // completely invisible: the call still throws the same error, just a
    // minute later, on a path that already looks slow.
    stubFetch(raw("overloaded", 503));

    await expect(settle(geminiJsonCall(params()))).rejects.toThrow("Gemini server error: 503");
    expect(sleptMs()).toBe(60_000);
    // Nothing left pending: a leaked timer would keep a Worker's event loop
    // alive past the point the consumer thinks it is done.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers on the retry after a 5xx and returns without a third request", async () => {
    // The success-after-failure path end to end, asserted on the VALUE rather
    // than on the call count alone: a retry that returned the first attempt's
    // (absent) result, or that returned undefined, would still make exactly
    // two requests.
    const fetchMock = stubFetch(raw("temporarily unavailable", 503), answers('{"details":{"phone_number":"01353 555555"}}'));

    expect(await settle(geminiJsonCall(params()))).toStrictEqual({ details: { phone_number: "01353 555555" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
