import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../worker-configuration";
import { extractNeed, type NeedExtraction, type OpenRouterOutcome } from "./openrouter";

// The extraction call at the centre of the needcheck pipeline, and the single
// place where an OpenRouter reply is turned into one of three fates for the
// message that triggered it.
//
// WHY THIS FILE EARNS ITS KEEP. extractNeed never throws for a failure it
// recognises and never logs: it returns a discriminated union, and
// queues/needcheckRender.ts:161-178 converts that union into ack / retry /
// dead-letter. So every misclassification here is silent by construction, and
// each of the three has a different way of being expensive:
//
//   "ok" on a reply that was not really an extraction is the S5 misreading --
//        a prose answer read as {needed: [], excess: []}. Downstream that is
//        an EMPTY extraction, and the only thing standing between it and a
//        wiped published shopping list for a real food bank is the S6 guard
//        in decision.ts. This function is the first of those two locks.
//   "retryable" on an account-wide failure is the WP 5.4 storm: the
//        needcheck-render consumer (wrangler.jsonc:126-138) has max_retries 3
//        and a DLQ, and the daily sweep is ~1,024 messages, so one 402
//        classified as transient becomes ~4,096 identical failing requests
//        and a full dead-letter queue. That cost production two days in
//        Aug 2026, per the module's own comment.
//   "permanent" on something transient acks a message whose food bank then
//        silently goes unchecked for the day, with only a discrepancy row to
//        say so.
//
// THE DJANGO ANCESTOR WAS READ, NOT ASSUMED. /Users/jasoncartwright/Sites/
// foodcharity, givefood/utils/ai.py:86-151 (openrouter(), which the module's
// header cites) and givefood/utils/crawlers.py:439-474 (the need_check_kwargs
// block and the two-attempt loop it feeds). Every "Django does X" claim below
// names the line it came from, and every one of those line numbers was
// re-opened during review rather than trusted: six in the first draft pointed
// two or three lines off their subject (the endpoint, the headers dict, the
// response_format and json_object branches, the seed conditional, and the
// json_object rationale) and are corrected in place. The CLAIMS all held --
// it was only the citations that had drifted -- but a line number nobody can
// follow is worth less than no citation at all.
//
// MUTATION-TESTED, TWICE. The repo was copied to a scratchpad OUTSIDE it and
// openrouter.ts broken there: the endpoint path, GET for POST, the Bearer
// prefix, a dropped Content-Type, an added HTTP-Referer, gpt-oss-20b for
// 120b, temperature 0.2 and `0 || 1`, seed 2 and no seed, strict false, the
// schema renamed, the provider block dropped and require_parameters false,
// the schema descriptions reworded and swapped between the two properties,
// the two property keys swapped, `required` narrowed and reordered, the item
// type dropped, the abort budget cut to 60s and removed entirely,
// `attempt < 1` and `attempt < 3`, both `continue`s turned into
// fall-throughs, the permanent set narrowed to 402 alone / widened to 429 /
// widened to every 4xx / widened to every failure, the permanent check
// restricted to the first attempt and reordered below the retry, permanent
// reclassified as retryable and as ok and stripped of its reason,
// slice(0, 200) / (0, 499) / (0, 501) / (500, 0) and no slice, the status and
// the body each dropped from the reason, statusText for text(), `!res.ok`
// narrowed to `!== 200` / widened to `>= 500` / inverted, choices[1] and
// choices.at(-1), role "system", a trimmed prompt, an attempt counter stamped
// into the body, the guard's Array.isArray checks replaced by `in`, its `&&`
// turned into `||`, its excess check made a duplicate of its needed check,
// its null check removed, the guard short-circuited to `true`, the guard
// applied to the envelope instead of the content, the parse skipped
// altogether, an empty extraction rejected as unusable, the ok result rebuilt
// field by field / with its two lists swapped / truncated to its first item,
// the final retryable turned into an empty extraction (the S5 catastrophe)
// and into a permanent, and Django's sleep(60) reintroduced between attempts.
//
// FIVE SURVIVED THE FIRST DRAFT OF THIS FILE, all of them the same hole: the
// SECOND request was never asserted. Each is an `attempt === 0 ? right :
// wrong` edit -- the retry sending no Authorization, no Content-Type, an
// extra HTTP-Referer, GET, or a 1 second abort budget -- and the draft
// compared only body and url between the two calls, which none of them
// change. They are killed now by the two retry tests in THE REQUEST, and
// named in their comments.
//
// THREE ARE EQUIVALENT MUTANTS and are deliberately NOT chased: `catch {
// continue; }` in place of the catch's guarded continue, `attempt + 1 <= 2`
// in place of `< 2`, and dropping the `content ?` guard so JSON.parse gets
// undefined. Each merely routes the last failure through the loop's exit
// instead of an early return, or through the try/catch instead of the
// ternary, and produces the identical outcome after the identical number of
// requests. No test can distinguish them, and one written to try would be
// asserting the module's control flow rather than its behaviour.
//
// Three of the killed mutants -- the reworded description, the extra
// HTTP-Referer header and the rebuilt ok result -- are the reason the schema
// is transcribed from Django by hand, the headers are asserted with toEqual
// rather than by key, and the extra-keys test exists.
//
// WHAT IS MOCKED, AND WHY ONLY THAT. `fetch`, and nothing else. openrouter.ai
// is a live metered endpoint behind a credential this machine does not have,
// so it is stubbed; the URL, the payload, the status classification, the
// double JSON decode and the retry arithmetic are all the real module.
// Replies are REAL `Response` objects, because `res.ok`, `res.status`,
// `res.text()` and `res.json()` are what the module actually reads and an
// object literal would just be this file asserting its own idea of HTTP.
//
// NOT VERIFIED AGAINST A LIVE OPENROUTER CALL. There is no OPENROUTER_KEY on
// this machine. What is pinned is that the port sends what it means to send
// and classifies what comes back the way it says it does; whether
// openai/gpt-oss-120b still honours this schema is a question only a real
// call can answer.

const KEY = "sk-or-v1-fake-key-for-tests";

// Spelled out rather than imported. The URL is a string literal inside
// extractNeed with no exported constant, which is the point: composing the
// expected URL the way the module composes it would assert nothing at all.
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// A realistic prompt, complete with the trailing newline a rendered template
// leaves behind (buildNeedPrompt in needcheck/prompt.ts), so the
// sends-it-verbatim test below is exercising the real shape.
const PROMPT = 'Extract the needs from this page.\n\n- Tinned Tomatoes\n- Nappies (size 4)\n\nAnswer with JSON.\n';

// givefood/utils/crawlers.py:378-397, transcribed by hand from the Django
// source rather than re-derived from the module's own NEED_SCHEMA (which is
// private to openrouter.ts anyway). The DESCRIPTIONS are the load-bearing
// part: with `strict: true` they are the only instruction the model gets
// about Title Case and de-duplication, so they are effectively prompt text.
// A silent rewording here changes every extraction the site publishes, and
// changes nothing that any other test in this repo can see.
const DJANGO_NEED_SCHEMA = {
  type: "object",
  properties: {
    needed: {
      type: "array",
      description: "A list of food items the food bank is requesting or has low stock of. Items should be in Title Case and not repeated.",
      items: { type: "string" },
    },
    excess: {
      type: "array",
      description: "A list of food items the food bank has an excess of. Items should be in Title Case and not repeated.",
      items: { type: "string" },
    },
  },
  required: ["needed", "excess"],
};

/** Only the secret this module reads. Env carries D1, KV, three R2 buckets,
 *  the browser binding and seven queue producers; handing over a real one
 *  would say nothing extra and would break the day someone adds a binding. */
function envWith(key: string = KEY): Env {
  return { OPENROUTER_KEY: key } as unknown as Env;
}

/** A secret that was never deployed: the property is ABSENT, which is what an
 *  unset `wrangler secret` looks like at runtime -- not an OPENROUTER_KEY key
 *  holding undefined. Env types it as a plain `string`, so this shape cannot
 *  be built without the cast. */
function envMissingKey(): Env {
  return {} as unknown as Env;
}

type Reply = (init: RequestInit) => Promise<Response>;

/** A real Response, so ok/status/text()/json() behave as the runtime does. */
const raw = (body: string | null, status: number): Reply => async () => new Response(body, { status });

/** A 200 shaped like OpenRouter's chat/completions success. The model's JSON
 *  arrives as a STRING inside choices[0].message.content, which is why the
 *  module has to JSON.parse a second time -- response_format constrains the
 *  model's output, not the transport. */
const says = (content: unknown): Reply =>
  raw(JSON.stringify({ id: "gen-1", model: "openai/gpt-oss-120b", choices: [{ index: 0, message: { role: "assistant", content } }] }), 200);

/** The happy shape: a content string that decodes to the need object. */
const extracts = (needed: unknown[], excess: unknown[]): Reply => says(JSON.stringify({ needed, excess }));

const rejects = (err: unknown): Reply => async () => {
  throw err;
};

/**
 * Scripts one reply per attempt. The module makes at most two requests, so a
 * one-element script answers both the same way, and a two-element script
 * gives the first attempt one fate and the retry another -- the only way to
 * test "the re-route rescued it" and "a 402 on the second attempt still
 * classifies permanent".
 */
function stubFetch(...replies: Reply[]) {
  let n = 0;
  const fetchMock = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    // The url is recorded, not matched on. A stub that 404d an unexpected URL
    // would turn "posted to the wrong host" into a retryable classification
    // -- i.e. into exactly the shape of a legitimate transient failure, which
    // is the distinction this file exists to make.
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

/** The chat/completions request body, as OpenRouter would see it. */
type SentBody = {
  model: string;
  messages: { role: string; content: string }[];
  temperature: number;
  seed: number;
  response_format: { type: string; json_schema: { name: string; strict: boolean; schema: unknown } };
  provider: { require_parameters: boolean };
};
const sentBody = (m: FetchMock, i = 0): SentBody => JSON.parse(String(requestInit(m, i).body)) as SentBody;

/**
 * Narrows an outcome to its extraction, typed through the EXPORTED
 * `OpenRouterOutcome` / `NeedExtraction` pair on purpose: those two types are
 * two thirds of this module's public surface and have no runtime existence at
 * all, so a renamed member or a dropped field has to fail `pnpm typecheck`
 * here or it fails nowhere.
 */
function needOf(outcome: OpenRouterOutcome): NeedExtraction {
  if (outcome.kind !== "ok") throw new Error(`expected an ok outcome, got "${outcome.kind}"`);
  return outcome.need;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ===========================================================================
// THE REQUEST
// ===========================================================================
describe("the request that goes to OpenRouter", () => {
  it("posts to the chat/completions endpoint", async () => {
    // ai.py:142, the URL literal inside the requests.post at ai.py:141-149.
    // (Re-checked line by line during review; the first draft cited :145,
    // which is the Content-Type line.) Nothing else in this Worker talks to
    // openrouter.ai, so a
    // mistyped host is not a 404 anyone sees -- it is a rejected fetch, which
    // this module classifies as retryable, which the consumer retries three
    // times and then dead-letters. The whole sweep would fail looking exactly
    // like an OpenRouter outage.
    const fetchMock = stubFetch(extracts(["Rice"], []));
    await extractNeed(envWith(), PROMPT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestUrl(fetchMock)).toBe(OPENROUTER_URL);
    expect(requestInit(fetchMock).method).toBe("POST");
  });

  it("authenticates with a Bearer header and sends no other header", async () => {
    // ai.py:143-146, both headers. Pinned in both directions: a missing
    // Content-Type makes OpenRouter reject the body, and an EXTRA header
    // (an HTTP-Referer / X-Title pair is the usual addition, for OpenRouter's
    // public app rankings) would put this site's identity on a leaderboard
    // nobody asked to be on.
    const fetchMock = stubFetch(extracts([], []));
    await extractNeed(envWith("sk-or-v1-secret-9"), PROMPT);

    expect(headers(fetchMock)).toEqual({ Authorization: "Bearer sk-or-v1-secret-9", "Content-Type": "application/json" });
  });

  it("sends 'Bearer undefined' when the secret was never deployed, rather than refusing to call", async () => {
    // SUSPECT, PINNED NOT FIXED. Unlike notify/whatsappClient.ts, which gates
    // on its token and returns early, this module interpolates whatever is on
    // the Env and calls anyway -- so an OPENROUTER_KEY that failed to deploy
    // sends a literal "Bearer undefined" to a paid API.
    //
    // The saving grace, and the reason this is a note rather than an alarm:
    // OpenRouter answers that with a 401, and the 401 branch below classifies
    // permanent, so the sweep acks instead of storming. The failure surfaces
    // as ~1,024 discrepancy rows saying "OpenRouter 401" -- loud, in the
    // place the maintainer already reads. A gate here would be cheaper, but
    // the current behaviour is at least not silent.
    const fetchMock = stubFetch(raw("No auth credentials found", 401));
    const outcome = await extractNeed(envMissingKey(), PROMPT);

    expect(headers(fetchMock).Authorization).toBe("Bearer undefined");
    expect(outcome).toStrictEqual({ kind: "permanent", reason: "OpenRouter 401: No auth credentials found" });
  });

  it("sends the exact payload, field for field", async () => {
    // The WHOLE object, not a spot check, because every field in it is a
    // documented decision (the module's own header calls temperature/seed/
    // model/require_parameters "load-bearing ... do not change any of them
    // without re-benchmarking"):
    //
    //   model            crawlers.py:442. gpt-oss-120b was benchmarked against
    //                    deepseek-v4-flash on this exact prompt and schema.
    //   temperature 0    crawlers.py:441. Reproducibility: at anything higher
    //                    the same unchanged page yields a different item list
    //                    run to run, and every one of those becomes a
    //                    "change" for a human to review.
    //   seed 1           crawlers.py:445. Pins the sampling AND makes
    //                    OpenRouter route stickily to one provider, so the
    //                    quantisation does not drift between calls.
    //   response_format  ai.py:115-123, with the literal name "response" and
    //                    strict: true.
    //   provider         ai.py:136-139, under the comment at :129-135. See
    //                    its own test below.
    //
    // A dropped or misspelled key here is not an error: OpenRouter ignores
    // unknown fields and answers anyway, so the only symptom is a worse
    // extraction, arriving as ordinary-looking review-queue churn.
    const fetchMock = stubFetch(extracts([], []));
    await extractNeed(envWith(), PROMPT);

    expect(sentBody(fetchMock)).toStrictEqual({
      model: "openai/gpt-oss-120b",
      messages: [{ role: "user", content: PROMPT }],
      temperature: 0,
      seed: 1,
      response_format: { type: "json_schema", json_schema: { name: "response", strict: true, schema: DJANGO_NEED_SCHEMA } },
      provider: { require_parameters: true },
    });
  });

  it("sends temperature 0 as 0, not as a falsy value swapped for a default", async () => {
    // THE MUTANT THIS KILLS: `temperature: t || 0.2`, or a `??` written where
    // the author reached for `||`. crawlers.py:441 passes 0 precisely so the
    // need check is reproducible; a silent default makes the same food bank
    // page produce a different shopping list each afternoon, and the reviewer
    // sees phantom changes with nothing to attribute them to. Asserted
    // separately from the whole-body test because -0 and 0 are toStrictEqual
    // to each other and JSON.stringify writes -0 as "0".
    const fetchMock = stubFetch(extracts([], []));
    await extractNeed(envWith(), PROMPT);

    expect(sentBody(fetchMock).temperature).toBe(0);
    expect(String(requestInit(fetchMock).body)).toContain('"temperature":0');
  });

  it("always sends the seed, where Django only sends it when one was passed", async () => {
    // ai.py:109-110 makes `seed` conditional (`if seed is not None`), because
    // that helper serves several callers. The port is scoped to this one call
    // and hard-codes it, which is the same wire result for the need check --
    // and worth recording, because "the port sends a field Django's helper
    // sometimes omits" is otherwise a diff nobody can explain.
    const fetchMock = stubFetch(extracts([], []));
    await extractNeed(envWith(), PROMPT);

    expect(sentBody(fetchMock).seed).toBe(1);
  });

  it("restricts routing with provider.require_parameters", async () => {
    // ai.py:129-139, quoted in the module as NON-NEGOTIABLE. Without it
    // OpenRouter routes freely to providers that accept response_format and
    // then ignore it, answering in prose -- a 200 with unparseable content,
    // measured in Django at roughly 1 call in 10. That is not an error
    // anywhere: it is the S5 misreading, i.e. a food bank's published needs
    // being held at their old contents while a discrepancy blames its
    // website. This one boolean is the difference.
    const fetchMock = stubFetch(extracts([], []));
    await extractNeed(envWith(), PROMPT);

    expect(sentBody(fetchMock).provider).toStrictEqual({ require_parameters: true });
  });

  it("asks for a strict json_schema named 'response', not a bare json_object", async () => {
    // ai.py:115-123 vs the json_object branch at :124-127 that this port does
    // NOT use. crawlers.py:434-438 spells out why: json_object alone does not
    // guarantee the `needed`/`excess` keys the caller indexes, and at least
    // one provider (Alibaba, for qwen3.5-flash) silently downgrades
    // json_schema to json_object and then 400s any prompt without the literal
    // word "json" in it. `strict: false` would be the same class of quiet
    // downgrade.
    const fetchMock = stubFetch(extracts([], []));
    await extractNeed(envWith(), PROMPT);

    expect(sentBody(fetchMock).response_format.type).toBe("json_schema");
    expect(sentBody(fetchMock).response_format.json_schema.name).toBe("response");
    expect(sentBody(fetchMock).response_format.json_schema.strict).toBe(true);
  });

  it("sends the schema with Django's descriptions intact", async () => {
    // Asserted on its own as well as inside the whole-body test, because this
    // is the assertion that a reviewer diffing against crawlers.py:378-397
    // will look for. The two descriptions are the model's only instruction
    // about Title Case and repetition; "Items should be in Title Case and not
    // repeated" softened to "items should be in title case" would change the
    // stored text of every need on the site.
    const fetchMock = stubFetch(extracts([], []));
    await extractNeed(envWith(), PROMPT);

    expect(sentBody(fetchMock).response_format.json_schema.schema).toStrictEqual(DJANGO_NEED_SCHEMA);
  });

  it("sends the prompt verbatim, whitespace and non-ASCII included", async () => {
    // There is no encoder in this path but JSON.stringify. The real prompt is
    // a rendered template carrying scraped markdown, Welsh place names and
    // whatever punctuation a food bank's CMS emitted, and the LEADING AND
    // TRAILING NEWLINES ARE THE POINT: a `.trim()` added for tidiness would
    // change the exact bytes the model is scored on for every call while
    // passing any test written with a tidy literal.
    const prompt = "\nFoodbank: Caffi Wcw, Aberdâr\n\n- Beans — 2 tins\n\nDon't guess.\n";
    const fetchMock = stubFetch(extracts([], []));
    await extractNeed(envWith(), prompt);

    expect(sentBody(fetchMock).messages).toStrictEqual([{ role: "user", content: prompt }]);
  });

  it("gives each attempt a fresh 65 second abort budget", async () => {
    // A DELIBERATE DIVERGENCE, pinned as such: ai.py:148 passes
    // `timeout = 60` to requests, and this port uses 65 seconds. Both numbers
    // are guesses about a slow provider, and 65 is the one that ships.
    //
    // The budget existing at all is what matters most. This runs inside a
    // queue consumer with max_batch_size 5 (wrangler.jsonc:127) walking its
    // batch; an unbounded fetch against a hung provider does not slow one
    // food bank down, it kills the whole invocation with nothing acked.
    // Asserted through the AbortSignal.timeout spy, because the only other
    // way to observe 65_000 is to sit through it.
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = stubFetch(extracts([], []));
    await extractNeed(envWith(), PROMPT);

    expect(timeout).toHaveBeenCalledWith(65_000);
    const signal = requestInit(fetchMock).signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    // Not already aborted when handed to fetch: a signal built from
    // AbortSignal.abort() would be, and would fail every call instantly while
    // looking exactly like a network problem.
    expect(signal.aborted).toBe(false);
  });

  it("builds a NEW abort signal for the retry, on the same full 65 second budget", async () => {
    // The signal is constructed inside the loop. Hoisted out, the retry would
    // inherit a budget that had already been ticking for 65 seconds -- so the
    // second attempt would abort instantly and the re-route that the whole
    // two-attempt design exists for would never happen, on precisely the
    // occasions it is needed.
    //
    // THE MUTANT THIS NOW KILLS, and did not before this review:
    // `AbortSignal.timeout(attempt === 0 ? 65_000 : 1_000)` -- a "the retry
    // should not hold the invocation open as long" edit. It SURVIVED
    // `toHaveBeenCalledTimes(2)`, because a count says two budgets were built
    // and nothing about how long either one was. Every argument of every call
    // is asserted here instead: a short retry budget aborts the second attempt
    // before a slow provider can answer, which turns the re-route into an
    // extra billed request that can only fail, and reports it as an ordinary
    // transient failure.
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = stubFetch(raw("upstream", 503), extracts(["Rice"], []));
    await extractNeed(envWith(), PROMPT);

    expect(timeout.mock.calls).toEqual([[65_000], [65_000]]);
    expect(requestInit(fetchMock, 0).signal).not.toBe(requestInit(fetchMock, 1).signal);
    expect((requestInit(fetchMock, 1).signal as AbortSignal).aborted).toBe(false);
  });

  it("sends the retry as the same request again -- url, method, headers and body", async () => {
    // The payload is built once, outside the loop. That has to stay true:
    // a retry that rebuilt the prompt, or that stamped an attempt counter
    // into the shared object, would ask a different question the second time
    // and make a bad extraction irreproducible. It is also what makes the
    // re-route meaningful -- the same question, a different provider.
    //
    // FOUR MUTANTS THIS NOW KILLS, ALL OF WHICH SURVIVED THIS FILE'S FIRST
    // DRAFT. Every one of them is `attempt === 0 ? <correct> : <wrong>`, the
    // shape any "do something different on the retry" edit takes:
    //   - the retry sends no Authorization header
    //   - the retry sends no Content-Type
    //   - the retry adds an HTTP-Referer
    //   - the retry uses GET
    // The whole first draft asserted the request properly ONCE, on call 0,
    // and then compared only body and url across the two -- so the second
    // request, which is the one that runs on every transient failure and
    // every prose answer, was effectively untested. A retry that 401s or 405s
    // is invisible: the module classifies it retryable (or, for a dropped
    // Bearer, PERMANENT -- an ack) and nothing distinguishes it from the
    // upstream failure that caused the retry in the first place.
    //
    // Asserted against literals rather than against call 0, because
    // `headers(m, 1)).toEqual(headers(m, 0))` passes just as happily when
    // both requests are wrong.
    const fetchMock = stubFetch(raw("upstream", 500), extracts(["Rice"], []));
    await extractNeed(envWith(), PROMPT);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestUrl(fetchMock, 1)).toBe(OPENROUTER_URL);
    expect(requestInit(fetchMock, 1).method).toBe("POST");
    expect(headers(fetchMock, 1)).toEqual({ Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" });
    expect(sentBody(fetchMock, 1)).toStrictEqual(sentBody(fetchMock, 0));
    expect(String(requestInit(fetchMock, 1).body)).toBe(String(requestInit(fetchMock, 0).body));
    expect(requestUrl(fetchMock, 1)).toBe(requestUrl(fetchMock, 0));
  });

  it("sends an identical payload on a later, independent call", async () => {
    // NEED_SCHEMA is a module-level constant shared by every call in the
    // isolate, and `as const` is a compile-time assertion, not Object.freeze.
    // Anything that mutated it -- a "normalise the schema" helper, a
    // per-call annotation -- would poison every subsequent food bank in the
    // same Worker instance, and only the second one onward. A single-call
    // test cannot see that.
    const fetchMock = stubFetch(extracts([], []));
    await extractNeed(envWith(), PROMPT);
    await extractNeed(envWith(), PROMPT);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(requestInit(fetchMock, 1).body)).toBe(String(requestInit(fetchMock, 0).body));
  });
});

// ===========================================================================
// SUCCESSFUL EXTRACTIONS
// ===========================================================================
describe("a reply that parses", () => {
  it("returns the two lists exactly as the model wrote them", async () => {
    // The values, not the shape. These strings go through
    // cleanFoodbankNeedText and straight into foodbankchange.change_text
    // (needcheckRender.ts:181-182), which is what the public site renders and
    // what the email/WhatsApp/push notifications quote.
    const fetchMock = stubFetch(extracts(["Tinned Tomatoes", "Nappies (Size 4)"], ["Baked Beans"]));

    expect(await extractNeed(envWith(), PROMPT)).toStrictEqual({
      kind: "ok",
      need: { needed: ["Tinned Tomatoes", "Nappies (Size 4)"], excess: ["Baked Beans"] },
    });
    // One paid call for one usable answer -- no speculative second request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats two empty lists as a SUCCESS, not as a failure", async () => {
    // THE MOST IMPORTANT DISTINCTION IN THIS MODULE, and the boundary between
    // S5 and S6. An empty extraction is a legitimate answer -- a food bank
    // whose page genuinely lists nothing today -- so it must come back as
    // "ok" and be decided on by decision.ts, which has the published need in
    // front of it and can refuse to wipe a real list (S6).
    //
    // If this returned "retryable" instead, every genuinely-empty page would
    // burn three retries and dead-letter, and every such food bank would get
    // a discrepancy row every single day. The inverse error -- returning "ok"
    // for an unparseable reply -- is what every test in the next block is
    // about.
    const fetchMock = stubFetch(extracts([], []));

    expect(await extractNeed(envWith(), PROMPT)).toStrictEqual({ kind: "ok", need: { needed: [], excess: [] } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes extra keys through untouched instead of stripping to the schema", async () => {
    // Pinned as current behaviour. isNeedExtraction is a shape GUARD, not a
    // filter: whatever the model returned is what the caller gets, extra keys
    // and all. Harmless today (needcheckRender.ts reads only .needed and
    // .excess) and worth recording, because a reasoning model that started
    // emitting a "reasoning" key would put it into the returned object with
    // nothing to notice.
    stubFetch(says(JSON.stringify({ needed: ["Rice"], excess: [], reasoning: "The page lists rice." })));

    expect(needOf(await extractNeed(envWith(), PROMPT))).toStrictEqual({ needed: ["Rice"], excess: [], reasoning: "The page lists rice." });
  });

  it("does not validate the element type, so non-strings reach the caller", async () => {
    // SUSPECT, PINNED NOT FIXED. isNeedExtraction checks Array.isArray and
    // stops there, so `{"needed": [1, 2]}` is a successful extraction.
    // needcheckRender.ts:181 then does `.join("\n")`, which stringifies
    // numbers happily, and a food bank's published need becomes "1\n2".
    // Unreachable while `strict: true` holds and the provider honours it --
    // which is exactly the assumption require_parameters exists because
    // OpenRouter does NOT always honour. Django's check (crawlers.py:467) is
    // no stronger: it tests key presence only.
    stubFetch(says(JSON.stringify({ needed: [1, { item: "Rice" }], excess: [null] })));

    expect(needOf(await extractNeed(envWith(), PROMPT))).toStrictEqual({ needed: [1, { item: "Rice" }], excess: [null] });
  });

  it("reads only the FIRST choice", async () => {
    // `choices?.[0]`. OpenRouter returns one choice for an n=1 request, so
    // this is worth recording rather than defending: if a provider ever
    // returned a reasoning choice ahead of the answer, the port would parse
    // the reasoning -- silently, and only for that provider.
    stubFetch(
      raw(
        JSON.stringify({
          choices: [
            { message: { content: JSON.stringify({ needed: ["First Choice"], excess: [] }) } },
            { message: { content: JSON.stringify({ needed: ["Second Choice"], excess: [] }) } },
          ],
        }),
        200,
      ),
    );

    expect(needOf(await extractNeed(envWith(), PROMPT)).needed).toStrictEqual(["First Choice"]);
  });

  it("accepts any 2xx, where Django accepts only 200", async () => {
    // A REAL DIVERGENCE, pinned so nobody "makes the clients consistent"
    // without knowing. crawlers.py:456 is `if api_response.status_code != 200`
    // -- a 201 or a 202 would have been retried and then raised. `res.ok`
    // here spans 200-299. Nothing in OpenRouter's API returns a 2xx other
    // than 200 today, so this is latent rather than live; the reason to pin
    // it is the 204 case in the next block, which res.ok lets through into a
    // JSON parse that throws out of the function entirely.
    stubFetch(raw(JSON.stringify({ choices: [{ message: { content: '{"needed":["Rice"],"excess":[]}' } }] }), 299));

    expect(needOf(await extractNeed(envWith(), PROMPT)).needed).toStrictEqual(["Rice"]);
  });

  it("recovers on the second attempt after an unusable first", async () => {
    // The entire justification for the two-attempt loop (crawlers.py:447-450,
    // "Retry immediately: a repeat call is re-routed, so it lands somewhere
    // else"): a
    // repeat call is re-routed by OpenRouter, so a provider that answered in
    // prose is usually not the provider that answers the retry. Asserted as a
    // RECOVERY -- on the returned value, not just the call count -- because a
    // loop that returned the first attempt's (absent) result would also make
    // exactly two requests.
    const fetchMock = stubFetch(says("Sure! The food bank needs rice and pasta."), extracts(["Rice", "Pasta"], []));

    expect(await extractNeed(envWith(), PROMPT)).toStrictEqual({ kind: "ok", need: { needed: ["Rice", "Pasta"], excess: [] } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ===========================================================================
// S5 -- AN UNUSABLE REPLY IS A FAILURE, NEVER AN EMPTY SHOPPING LIST
// ===========================================================================
describe("replies that do not parse", () => {
  // Every case here is a 200. The danger is uniform and is the one
  // crawlers.py:447-450 spells out: reading any of them as "this food bank
  // needs nothing" blames the food bank's website for what was really a bad
  // provider, and quietly holds the published need at its old contents. The
  // module must answer "retryable" for all of them, and must NOT answer
  // { kind: "ok", need: { needed: [], excess: [] } }.

  const unusable: [string, Reply][] = [
    // The measured 1-in-10 failure: a provider that ignored response_format.
    ["prose instead of JSON", says("The food bank is currently asking for rice, pasta and nappies.")],
    // A fenced code block -- the other common shape of the same failure.
    ["JSON wrapped in a markdown fence", says('```json\n{"needed":["Rice"],"excess":[]}\n```')],
    // JSON.parse succeeds, isNeedExtraction rejects. This is the shape that
    // most looks like a success, and the one queues/needcheckRender.test.ts
    // calls "the dangerous shape".
    ["a JSON object with the wrong keys", says(JSON.stringify({ items: ["Rice"] }))],
    ["a JSON object missing `excess`", says(JSON.stringify({ needed: ["Rice"] }))],
    ["a JSON object missing `needed`", says(JSON.stringify({ excess: ["Rice"] }))],
    // A DIVERGENCE FROM DJANGO, and the port is the stricter one.
    // crawlers.py:467 tests `"needed" in parsed_response` only, so Django
    // would have ACCEPTED this and then run '\n'.join("Rice"), publishing
    // "R\ni\nc\ne" as a food bank's needs. The port's Array.isArray check
    // rejects it and retries instead.
    ["strings where the schema promises arrays", says(JSON.stringify({ needed: "Rice", excess: "None" }))],
    ["nulls where the schema promises arrays", says(JSON.stringify({ needed: null, excess: null }))],
    // typeof null is "object", hence the explicit !== null in the guard.
    ["a bare JSON null", says("null")],
    ["a JSON array", says(JSON.stringify([{ needed: [], excess: [] }]))],
    ["a JSON string", says('"needed: rice"')],
    // `content ? ... : null` -- an empty string is falsy, so it never reaches
    // JSON.parse (which would have thrown a less legible SyntaxError anyway).
    ["an empty content string", says("")],
    ["a content field that is absent", raw(JSON.stringify({ choices: [{ message: { role: "assistant" } }] }), 200)],
    ["a choice with no message", raw(JSON.stringify({ choices: [{ index: 0 }] }), 200)],
    ["an empty choices array", raw(JSON.stringify({ choices: [] }), 200)],
    // OpenRouter really does answer 200 with an error envelope for some
    // upstream failures -- a moderation block or a provider timeout. There is
    // no `choices` key at all, and the optional chaining is what keeps this a
    // classification rather than a TypeError.
    ["an OpenRouter error envelope served with a 200", raw(JSON.stringify({ error: { code: 502, message: "Provider returned error" } }), 200)],
    // An array has no `choices` property, so this classifies cleanly. The
    // `null` envelope does NOT -- see the dedicated test below.
    ["a JSON envelope that is an array", raw("[]", 200)],
    // Structured content parts: some providers return content as an array of
    // {type,text} blocks rather than a string. String([{...}]) is
    // "[object Object]", JSON.parse throws, and the catch turns it into null.
    ["content returned as structured parts", says([{ type: "text", text: '{"needed":["Rice"],"excess":[]}' }])],
  ];

  for (const [label, reply] of unusable) {
    it(`retries and then reports retryable for ${label}`, async () => {
      const fetchMock = stubFetch(reply);
      const outcome = await extractNeed(envWith(), PROMPT);

      expect(outcome).toStrictEqual({ kind: "retryable" });
      // Both attempts are spent, because the re-route is the only fix
      // available for this class of failure.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  }

  it("never reports an unusable reply as an empty extraction", async () => {
    // The S5 assertion stated directly rather than by implication, because
    // this is the regression that would be catastrophic and invisible: an
    // "ok" with two empty lists here is indistinguishable downstream from a
    // food bank whose page really is empty, and the S6 guard in decision.ts
    // only protects food banks that already have a PUBLISHED need. A food
    // bank whose need is still awaiting review has no second lock.
    stubFetch(says("I'm sorry, I can't help with that."));
    const outcome = await extractNeed(envWith(), PROMPT);

    expect(outcome.kind).not.toBe("ok");
    expect(outcome).not.toHaveProperty("need");
  });

  it("throws a SyntaxError out of the function on a 200 that is not JSON at all", async () => {
    // SUSPECT, PINNED NOT FIXED (and already noted in
    // queues/needcheckRender.test.ts). `await res.json()` is the one call on
    // the 2xx path with no try/catch around it, so a proxy's HTML error page
    // or a truncated body served with a 200 escapes as a SyntaxError instead
    // of being classified.
    //
    // Two consequences, both invisible: the second attempt that this whole
    // loop exists for never happens, and the consumer's catch logs a parser
    // message rather than the S5 one -- so the DLQ record says "Unexpected
    // token <" and names neither OpenRouter nor the food bank's problem.
    const fetchMock = stubFetch(raw("<html>502 Bad Gateway</html>", 200));

    await expect(extractNeed(envWith(), PROMPT)).rejects.toThrow(SyntaxError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws a TypeError out of the function on a 200 whose whole body is `null`", async () => {
    // SUSPECT, PINNED NOT FIXED, and found by writing this test rather than
    // by reading the line. The optional chaining in
    // `json.choices?.[0]?.message?.content` guards `choices`, not `json`, so
    // a body of literal `null` -- valid JSON, and what some proxies emit for
    // an empty upstream response -- dereferences null and throws
    // "Cannot read properties of null (reading 'choices')".
    //
    // Same shape of hole as the non-JSON 200 above: no second attempt, and a
    // DLQ record that names a null dereference instead of OpenRouter. The
    // one-character fix (`json?.choices`) is deliberately NOT made here.
    const fetchMock = stubFetch(raw("null", 200));

    await expect(extractNeed(envWith(), PROMPT)).rejects.toThrow(TypeError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws rather than classifying when a 2xx has an empty body", async () => {
    // The same crack, reached the other way: `res.ok` is true for a 204, so
    // the module gets as far as res.json() and dies there. Django would have
    // treated a 204 as a non-200, slept and retried. Worth pinning because
    // "Unexpected end of JSON input" gives no hint that the response was
    // empty, let alone that it was a 204.
    stubFetch(raw(null, 204));

    await expect(extractNeed(envWith(), PROMPT)).rejects.toThrow(SyntaxError);
  });
});

// ===========================================================================
// HTTP FAILURES THAT MUST BE RETRIED
// ===========================================================================
describe("transient HTTP failures", () => {
  it("retries a 503 and returns the retry's extraction", async () => {
    const fetchMock = stubFetch(raw("Service Unavailable", 503), extracts(["Rice"], []));

    expect(await extractNeed(envWith(), PROMPT)).toStrictEqual({ kind: "ok", need: { needed: ["Rice"], excess: [] } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports retryable after two failures, with no detail at all", async () => {
    // A DIAGNOSABILITY GAP, pinned not fixed. Django raises
    // `RuntimeError("OpenRouter need check failed: HTTP %s %s")` with the
    // status and the first 500 bytes of the body (crawlers.py:473). The port
    // returns a bare { kind: "retryable" }, and needcheckRender.ts:177 turns
    // it into the fixed string "OpenRouter need extraction failed or returned
    // unusable content" -- so a rate limit, a provider outage and a prose
    // answer are indistinguishable in the DLQ discrepancy that a human
    // eventually reads. The body was fetched and discarded.
    const fetchMock = stubFetch(raw('{"error":{"message":"Rate limit exceeded"}}', 429));
    const outcome = await extractNeed(envWith(), PROMPT);

    expect(outcome).toStrictEqual({ kind: "retryable" });
    expect(Object.keys(outcome)).toEqual(["kind"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // The rows that MUST be excluded from the permanent classification. Without
  // these, a guard widened to `res.status >= 400` -- or one that simply
  // returned permanent for every !res.ok -- would pass every test in the WP
  // 5.4 block below while acking the whole day's sweep on a single provider
  // wobble, leaving ~1,024 food banks unchecked and nothing retried.
  it.each([
    [400, "a malformed request"],
    [404, "a retired model id"],
    [408, "an upstream request timeout"],
    [429, "a rate limit -- transient by definition"],
    [500, "an OpenRouter internal error"],
    [502, "a bad gateway in front of the provider"],
    [503, "an overloaded provider"],
    [529, "OpenRouter's own overload code"],
  ])("classifies %i (%s) as retryable, not permanent", async (status) => {
    const fetchMock = stubFetch(raw("upstream body", status));

    expect(await extractNeed(envWith(), PROMPT)).toStrictEqual({ kind: "retryable" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats a 3xx as a failure rather than following it", async () => {
    // `res.ok` is 200-299, so a 301 lands in the !res.ok branch. Unreachable
    // in practice (fetch follows redirects itself) and pinned because if it
    // ever IS reached the answer is "retryable", not "permanent" -- a
    // relocated endpoint would therefore storm the queue rather than ack.
    const fetchMock = stubFetch(raw("Moved", 301));

    expect(await extractNeed(envWith(), PROMPT)).toStrictEqual({ kind: "retryable" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ===========================================================================
// WP 5.4 -- THE ACCOUNT-WIDE FAILURES THAT MUST NOT STORM
// ===========================================================================
describe("permanent failures", () => {
  // 402 (no OpenRouter balance), 401 (a rotated or never-deployed key) and
  // 403 (a permissions change) all fail identically for every one of the
  // day's ~1,024 messages and on every retry of each. The consumer's
  // max_retries is 3, so classifying one of these as transient turns a single
  // account-level fact into ~4,096 identical paid-API failures and a full
  // dead-letter queue -- which is what cost production two days in Aug 2026.

  it.each([402, 401, 403])("classifies %i as permanent on the FIRST attempt", async (status) => {
    const fetchMock = stubFetch(raw("Insufficient credits", status));

    expect(await extractNeed(envWith(), PROMPT)).toStrictEqual({ kind: "permanent", reason: `OpenRouter ${status}: Insufficient credits` });
    // The single most load-bearing number in this file. A second attempt here
    // is not merely wasteful: multiplied across the sweep it is the storm
    // itself, at max_concurrency 25.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still classifies permanent when the 402 arrives on the second attempt", async () => {
    // THE MUTANT THIS KILLS: hoisting the status check outside the loop, or
    // guarding it with `attempt === 0`. A 502 followed by a 402 is exactly
    // what a balance running out mid-sweep looks like, and it must ack, not
    // retry. Nothing else here would notice.
    const fetchMock = stubFetch(raw("Bad gateway", 502), raw("Insufficient credits", 402));

    expect(await extractNeed(envWith(), PROMPT)).toStrictEqual({ kind: "permanent", reason: "OpenRouter 402: Insufficient credits" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("classifies permanent after a first-attempt network failure too", async () => {
    // The other route to the second attempt: the catch's `continue`. A key
    // rotated halfway through a sweep, with one dropped connection in front
    // of it, must still ack.
    stubFetch(rejects(new TypeError("Network connection lost.")), raw("Invalid API key", 401));

    expect(await extractNeed(envWith(), PROMPT)).toStrictEqual({ kind: "permanent", reason: "OpenRouter 401: Invalid API key" });
  });

  it("quotes the status and the body, because the discrepancy row is the only record", async () => {
    // needcheckRender.ts wraps this reason in a PermanentOpenRouterFailure and
    // the catch writes it to a FoodbankDiscrepancy -- the queue the maintainer
    // reads daily. The status alone is not actionable: OpenRouter distinguishes
    // "insufficient credits" from "this key has no access to this model" in the
    // BODY, and those need different people to fix them.
    stubFetch(raw('{"error":{"code":402,"message":"Insufficient credits. Add more using https://openrouter.ai/credits"}}', 402));
    const outcome = await extractNeed(envWith(), PROMPT);

    expect(outcome).toStrictEqual({
      kind: "permanent",
      reason: 'OpenRouter 402: {"error":{"code":402,"message":"Insufficient credits. Add more using https://openrouter.ai/credits"}}',
    });
  });

  it("truncates the quoted body at 500 characters", async () => {
    // crawlers.py:473's `api_response.text[:500]`, ported. The cap matters
    // because the reason string is written into discrepancy_text: an HTML
    // error page from a proxy is tens of kilobytes, and an untruncated one
    // would be written once per food bank into a table a human scrolls.
    // Boundary asserted exactly -- an off-by-one here is invisible.
    stubFetch(raw("y".repeat(600), 403));
    const outcome = await extractNeed(envWith(), PROMPT);

    expect(outcome).toStrictEqual({ kind: "permanent", reason: `OpenRouter 403: ${"y".repeat(500)}` });
  });

  it("leaves a body of exactly 500 characters intact", async () => {
    stubFetch(raw("z".repeat(500), 402));

    expect(await extractNeed(envWith(), PROMPT)).toStrictEqual({ kind: "permanent", reason: `OpenRouter 402: ${"z".repeat(500)}` });
  });

  it("still reports permanent when the body is empty", async () => {
    // A 402 with no body leaves a reason ending in a bare colon. Ugly, and
    // pinned rather than tidied: the classification is what the consumer acts
    // on, and it must not depend on there being anything to quote.
    stubFetch(raw("", 402));

    expect(await extractNeed(envWith(), PROMPT)).toStrictEqual({ kind: "permanent", reason: "OpenRouter 402: " });
  });

  it("throws instead of classifying when the failed body cannot be read", async () => {
    // SUSPECT, PINNED NOT FIXED. `await res.text()` is evaluated inside the
    // template literal with no try/catch, so a body stream that errors
    // mid-read turns the ONE classification that must not storm into a thrown
    // error -- which the consumer treats as a retry. The exact failure mode
    // WP 5.4 exists to prevent, reachable through a torn connection on the
    // error response itself. Same trap as lib/gemini.ts, pinned here so the
    // two stay consistent.
    stubFetch(async () => {
      const res = new Response("x", { status: 402 });
      Object.defineProperty(res, "text", {
        value: async () => {
          throw new Error("body stream errored");
        },
      });
      return res;
    });

    await expect(extractNeed(envWith(), PROMPT)).rejects.toThrow("body stream errored");
  });
});

// ===========================================================================
// NETWORK FAILURES
// ===========================================================================
describe("a fetch that never returns a Response", () => {
  it("retries a rejected fetch and reports retryable after the second", async () => {
    // Worker subrequest limits, DNS and TLS failures all arrive as a
    // rejection rather than a Response. The classification must be retryable
    // -- a dropped connection is the textbook transient failure -- and it
    // must NOT escape as a throw, because the module's contract with
    // needcheckRender.ts is a returned union.
    const fetchMock = stubFetch(rejects(new TypeError("Network connection lost.")));

    expect(await extractNeed(envWith(), PROMPT)).toStrictEqual({ kind: "retryable" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers when only the first fetch was dropped", async () => {
    const fetchMock = stubFetch(rejects(new TypeError("Network connection lost.")), extracts(["Rice"], ["Pasta"]));

    expect(await extractNeed(envWith(), PROMPT)).toStrictEqual({ kind: "ok", need: { needed: ["Rice"], excess: ["Pasta"] } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("swallows the error rather than surfacing which failure it was", async () => {
    // Pinned as a deliberate consequence of the union: the TypeError, its
    // message and its stack are all discarded, so a systematic failure
    // (say every subrequest being refused because the Worker hit its limit)
    // is reported identically to a single dropped socket. The consumer's
    // fixed error string is all that reaches the DLQ.
    const boom = new TypeError("Network connection lost.");
    stubFetch(rejects(boom));
    const outcome = await extractNeed(envWith(), PROMPT);

    expect(outcome).toStrictEqual({ kind: "retryable" });
    expect(JSON.stringify(outcome)).not.toContain("Network connection lost");
  });

  it("reports an abort as retryable, not as a permanent failure", async () => {
    // The other half of the 65 second budget. A provider that hangs must
    // leave the message on the queue: the next attempt re-routes, and a
    // needcheck that is merely late is worth far more than one that is acked.
    // Each attempt builds its own signal, so each is aborted separately --
    // a shared controller leaves the retry hanging forever, because an
    // already-aborted signal never dispatches a second `abort` event.
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
          budgets[budgets.length - 1]!.abort();
        }),
    );

    expect(await extractNeed(envWith(), PROMPT)).toStrictEqual({ kind: "retryable" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(budgets).toHaveLength(2);
  });

  it("handles a non-Error rejection without letting it escape", async () => {
    // The catch is bare (`catch {`), so it does not care what was thrown. A
    // string, a plain object or an undefined all classify the same way --
    // worth pinning because a `catch (e)` that later grew an `e.message`
    // read would throw a TypeError here instead of classifying.
    for (const thrown of ["a bare string", { code: "ECONNRESET" }, undefined]) {
      stubFetch(rejects(thrown));
      expect(await extractNeed(envWith(), PROMPT)).toStrictEqual({ kind: "retryable" });
    }
  });
});

// ===========================================================================
// ATTEMPT AND WALL-CLOCK ACCOUNTING
// ===========================================================================
describe("attempt accounting", () => {
  it("never makes a third request, whatever the failure", async () => {
    // `attempt < 2`. Every extra attempt is another paid call multiplied by
    // ~1,024 messages a day, and another 65 second budget inside a consumer
    // walking a batch of five. Asserted across all three failure branches,
    // since each takes a different route around the loop.
    for (const reply of [raw("500 body", 500), says("prose, not JSON"), rejects(new Error("boom"))]) {
      const fetchMock = stubFetch(reply);
      await extractNeed(envWith(), PROMPT).catch(() => {});
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it("does not sleep between attempts, unlike Django", async () => {
    // THE PORT'S SHARPEST DIVERGENCE FROM crawlers.py:457-459, which does
    // `sleep(60)` between attempts. A Worker must not block wall clock: the
    // consumer walks up to five messages per invocation, so a 60 second sleep
    // per message is five minutes of an invocation that does not have five
    // minutes -- and it is not needed, because the retry's value is the
    // RE-ROUTE, not the wait. The delay Django bought with sleep() is bought
    // here by the queue instead (needcheckRender.ts retries with
    // delaySeconds 60).
    //
    // Measured by spying on setTimeout rather than by fake timers, because
    // AbortSignal.timeout does NOT go through globalThis.setTimeout (probed
    // on node v24.15.0 on this machine: zero calls) -- so anything long
    // scheduled here is a sleep the module put there. lib/gemini.ts, in this
    // same Worker, DOES sleep 60 seconds between its attempts, which makes
    // "copy the retry loop from gemini.ts" a realistic way to introduce one.
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    stubFetch(raw("Service Unavailable", 503));

    expect(await extractNeed(envWith(), PROMPT)).toStrictEqual({ kind: "retryable" });
    const longWaits = setTimeoutSpy.mock.calls.filter((call) => typeof call[1] === "number" && call[1] >= 1_000);
    expect(longWaits).toEqual([]);
  });

  it("holds no state between calls, so a repeated tick is a clean repeat", async () => {
    // Cloudflare queue deliveries are at-least-once, and the same message can
    // reach the same isolate twice. A module-level attempt counter or a
    // cached outcome would make the second delivery behave differently from
    // the first -- here it does not: two independent calls, two independent
    // two-attempt budgets, the same classification both times.
    const fetchMock = stubFetch(raw("Service Unavailable", 503));

    expect(await extractNeed(envWith(), PROMPT)).toStrictEqual({ kind: "retryable" });
    expect(await extractNeed(envWith(), PROMPT)).toStrictEqual({ kind: "retryable" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("routes each of the five failure shapes to its own specific kind", async () => {
    // The union is the module's entire contract with needcheckRender.ts,
    // which switches on `kind` and falls through to the ok branch. A fourth
    // kind, or an undefined return from some unhandled path, would be read as
    // a successful extraction -- with `outcome.need.needed` throwing a
    // TypeError inside the consumer rather than classifying anything.
    //
    // STRENGTHENED DURING REVIEW. This was
    // `expect(["ok","retryable","permanent"]).toContain(outcome.kind)`, which
    // is true of a module that returns { kind: "retryable" } and nothing else
    // -- i.e. it passed for every one of the five inputs while asserting that
    // the five are distinguishable at all, which is the single thing this
    // module is for. The EXPECTED kind for each is named instead, in one
    // place, so that the three-way branch is pinned as a whole and not only
    // one route at a time in the blocks above.
    const scripts: [string, Reply[], OpenRouterOutcome["kind"]][] = [
      ["a clean extraction", [extracts([], [])], "ok"],
      ["an OpenRouter 500", [raw("nope", 500)], "retryable"],
      ["an out-of-credit 402", [raw("nope", 402)], "permanent"],
      ["a rejected fetch", [rejects(new Error("boom"))], "retryable"],
      ["a prose answer", [says("prose")], "retryable"],
    ];
    for (const [label, script, kind] of scripts) {
      stubFetch(...script);
      const outcome = await extractNeed(envWith(), PROMPT);
      expect(outcome.kind, label).toBe(kind);
    }
  });
});
