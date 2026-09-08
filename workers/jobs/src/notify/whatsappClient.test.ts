import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../worker-configuration";
import { buildNeedTemplate, sendWhatsappTemplate, sendWhatsappText } from "./whatsappClient";

// The WhatsApp send path, and the only code in the port that talks to Meta.
//
// WHY THIS FILE EARNS ITS KEEP. Both exported senders return a boolean and
// swallow every failure into console. Nothing upstream re-raises: the queue
// consumer in notify/needWhatsApp.ts treats `false` as "this subscriber did
// not get a message" and carries on to the next one, then enqueues the next
// page regardless. So a client that silently sends nothing -- wrong URL,
// wrong header, a payload Meta rejects with a 400 -- produces a completely
// normal-looking cron run, a completely normal-looking queue, and 51 people
// who never hear that their food bank needs nappies. There is no alarm to
// trip. These tests are the alarm.
//
// The Django ancestor was read, not assumed: givefood/utils/notifications.py
// in /Users/jasoncartwright/Sites/foodcharity -- line 20
// (WHATSAPP_PHONE_NUMBER_ID), send_whatsapp_message at :475-520 and
// send_whatsapp_template_notification at :523-624. Every "Django" claim
// below names the lines it came from, and those line numbers were re-checked
// against the file on this machine rather than copied from the port's own
// header, which is a handful of lines out in both directions.
//
// MUTATION-TESTED. The module is copied to a scratch directory outside the
// repo, broken there, and the suite re-run; nothing is ever edited in src/.
// Eighty-three distinct mutants have been executed against this file over
// four passes, and every one of them now fails at least one test below --
// `!res.ok` and `>= 400` for `!== 200`, an outright inverted status guard, an
// inverted token gate, a bumped Graph version, a changed sender digit,
// version and sender id transposed in the URL, /message for
// /messages, a global /\+/g in the phone strip, an lstrip-style /^\++/, no
// strip at all, a `to.trim()`, a removed token gate, a gate moved below the
// fetch, a gate that only catches `undefined`, a gate returning true, a gate
// logging through console.log, a shortened abort budget, a module-level
// shared signal, no signal at all, a catch returning true, a catch narrowed
// to TypeError, a failure path returning undefined, a dropped response body
// in the log, console.warn for console.error, an interpolated error object,
// a dropped Content-Type, GET for POST, a Bearer-less Authorization, a
// missing messaging_product, a `post` that merges into the caller's object,
// senders that discard `post`'s answer, an internal retry, the original
// `foodbankneed` template, a numeric button index, a quick_reply sub_type, a
// "cy" language, name and item1 swapped, items rotated by one, a dropped
// third item, a dropped name parameter, empty items filtered out, slug and
// name transposed in the header and in the button, the two parameters swapped
// in the signature, header and body components swapped, a dropped
// `type: "template"`, a dropped `type: "text"`, an unwrapped text body, a
// nested rather than spread template, a singleton template object, a
// hard-coded log prefix, and both senders skipping normalisation.
//
// FIVE OF THEM SURVIVED an earlier version of this suite, and are what the
// five tests marked "MUTANT THIS KILLS" below exist for: a log prefix
// hard-coded on the two ERROR lines (only the warning was ever checked with a
// second prefix), `message.trim()`, a 1,024-character cap on the message
// body, `t.trim()` inside the template's `text()` helper, and hoisting
// `await res.text()` above the status check. Each is a plausible tidy-up
// rather than a typo, which is why each got a test naming it.
//
// WHAT IS MOCKED, AND WHY ONLY THAT. `fetch` is the one thing here that
// leaves the machine; graph.facebook.com is a live production endpoint
// behind a real credential, so it is stubbed and everything else -- the URL
// construction, the payload, the status rule, the logging -- is the real
// module. Responses are REAL `Response` objects rather than object literals,
// because `res.status` and `res.text()` are what the module actually reads
// and a literal would be the test asserting its own idea of HTTP.

const TOKEN = "EAAG-fake-graph-token";
const LOG = "notify-need-whatsapp";

// The endpoint spelled out in full rather than rebuilt from the module's
// constants. Both halves are private to whatsappClient.ts, so composing the
// expected URL the same way the module composes it would assert nothing: a
// bumped Graph version or a mistyped sender id would change both sides
// together and this file would stay green while every message went nowhere.
// These exact digits are notifications.py:20; "v24.0" is notifications.py:491.
const MESSAGES_URL = "https://graph.facebook.com/v24.0/890504590819478/messages";

// Only the binding this module reads. Env carries D1, KV, R2, six queue
// producers and a dozen other secrets; handing over a real one would say
// nothing extra and would break the day someone adds a binding.
function envWith(token: string = TOKEN): Env {
  return { WHATSAPP_TOKEN: token } as unknown as Env;
}

/** A secret that was never deployed: the property is absent from the env
 *  object entirely, which is what an unset `wrangler secret` looks like at
 *  runtime -- NOT a WHATSAPP_TOKEN key holding undefined. Worth modelling as
 *  the real shape, since the Env interface types it as a plain `string` and
 *  so a `.length` check would typecheck and then throw here. */
function envMissingToken(): Env {
  return {} as unknown as Env;
}

type Reply = (init: RequestInit) => Promise<Response>;

/** A real Response, so `status` and `text()` behave as the runtime does. */
const replies = (body: string, status: number): Reply => async () => new Response(body, { status });
const ok = (): Reply => replies("{\"messages\":[{\"id\":\"wamid.123\"}]}", 200);
const rejects = (err: unknown): Reply => async () => {
  throw err;
};

function stubFetch(reply: Reply = ok()) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    // The url is recorded rather than matched on: every test here wants to
    // assert WHICH url was called, and a stub that 404s an unexpected one
    // would turn "posted to the wrong host" into a thrown error caught by
    // the module's own try/catch -- i.e. into a plain `false`, which is the
    // exact symptom this file exists to distinguish from a real send.
    void url;
    return reply(init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

type FetchMock = ReturnType<typeof stubFetch>;

const requestUrl = (m: FetchMock, i = 0): string => m.mock.calls[i]![0];
const requestInit = (m: FetchMock, i = 0): RequestInit => m.mock.calls[i]![1];
const headers = (m: FetchMock, i = 0): Record<string, string> =>
  requestInit(m, i).headers as Record<string, string>;
const sentBody = (m: FetchMock, i = 0): Record<string, unknown> =>
  JSON.parse(String(requestInit(m, i).body)) as Record<string, unknown>;

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Silenced by default -- half these tests are failure paths and the log is
  // the module's only output -- but kept as spies, because the log line IS
  // the product here. A Worker tail is the only place a broken send is
  // visible, so its wording is asserted rather than discarded.
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sendWhatsappText: the request that goes to Meta", () => {
  it("posts to the exact Graph endpoint, sender id and version included", async () => {
    // notifications.py:491 builds
    // f"https://graph.facebook.com/v24.0/{WHATSAPP_PHONE_NUMBER_ID}/messages"
    // with WHATSAPP_PHONE_NUMBER_ID = "890504590819478" (notifications.py:20).
    // A wrong sender id is a 400 from Meta, not a DNS error, so it looks
    // exactly like a send that simply failed -- and every subscriber on the
    // page is skipped in silence.
    const fetchMock = stubFetch();
    await sendWhatsappText(envWith(), "+447700900123", "hello", LOG);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestUrl(fetchMock)).toBe(MESSAGES_URL);
  });

  it("sends exactly Django's plain-text payload, field for field", async () => {
    // notifications.py:501-509. The whole object, not a spot check: an extra
    // top-level key is a Meta 400 and a missing `messaging_product` is a
    // Meta 400, and both arrive here as a bare `false`.
    const fetchMock = stubFetch();
    await sendWhatsappText(envWith(), "+447700900123", "You've been unsubscribed.", LOG);

    expect(sentBody(fetchMock)).toEqual({
      messaging_product: "whatsapp",
      to: "447700900123",
      type: "text",
      text: { body: "You've been unsubscribed." },
    });
  });

  it("bearer-authenticates with WHATSAPP_TOKEN and declares a JSON body", async () => {
    // notifications.py:493-496. Meta answers 401 for a missing bearer and
    // 400 for a form-encoded body; both are indistinguishable from "the
    // message failed" downstream. The token is also the only secret on this
    // path -- the sender id is public in every message the account has sent.
    const fetchMock = stubFetch();
    await sendWhatsappText(envWith("secret-token-9"), "+447700900123", "hi", LOG);

    expect(requestInit(fetchMock).method).toBe("POST");
    expect(headers(fetchMock).Authorization).toBe("Bearer secret-token-9");
    expect(headers(fetchMock)["Content-Type"]).toBe("application/json");
  });

  it("gives the request a 15 second abort budget", async () => {
    // Django's requests.post (notifications.py:511) passes NO timeout at
    // all, so this is a deliberate addition rather than a port. It matters
    // more here than it did there: needWhatsApp.ts sends up to 25 of these
    // in sequence inside one queue consumer invocation, so an unbounded
    // hang is not a slow message, it is a consumer that never acks and a
    // page of subscribers that eventually lands in a dead letter queue.
    //
    // Asserted through the AbortSignal.timeout spy rather than by waiting,
    // because the only other way to observe 15_000 is to sit through it.
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = stubFetch();
    await sendWhatsappText(envWith(), "+447700900123", "hi", LOG);

    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(requestInit(fetchMock).signal).toBeInstanceOf(AbortSignal);
    // Not already aborted when handed to fetch -- a signal built from
    // AbortSignal.abort() would be, and would fail every send instantly.
    expect((requestInit(fetchMock).signal as AbortSignal).aborted).toBe(false);
  });

  it("reports a send that the abort signal cuts short as a failure, not a success", async () => {
    // The other half of the budget: when the signal does fire, fetch
    // rejects, and that rejection must become `false` rather than an
    // escaping exception. needWhatsApp.ts has no try/catch around the send,
    // so a throw here would abandon the remaining subscribers on the page
    // AND skip the setWhatsappLastNotified write for the ones already sent.
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    stubFetch(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(new Error("The operation was aborted")));
        }),
    );

    const pending = sendWhatsappText(envWith(), "+447700900123", "hi", LOG);
    controller.abort();

    expect(await pending).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toBe("notify-need-whatsapp: send failed for 447700900123");
  });

  it("makes one request per call and does not retry internally", async () => {
    // Retrying inside the client would double-message a subscriber whenever
    // Meta answered slowly, and the queue consumer already provides the only
    // retry this path should have. Pinned so a "helpful" loop is visible.
    const fetchMock = stubFetch(replies("rate limited", 429));
    expect(await sendWhatsappText(envWith(), "+447700900123", "hi", LOG)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("sendWhatsappText: phone normalisation", () => {
  // notifications.py:499 -- `to_phone.lstrip('+')`. Every number in D1 is
  // stored with a leading "+" (queues/whatsappHook.ts:85-87 adds one back to
  // Meta's plus-less inbound `from`), and the Graph API wants it without.
  // Get this wrong and every send is a 400.

  it("strips the leading plus the database stores", async () => {
    const fetchMock = stubFetch();
    await sendWhatsappText(envWith(), "+447700900123", "hi", LOG);
    expect(sentBody(fetchMock).to).toBe("447700900123");
  });

  it("leaves a number that already has no plus alone", async () => {
    const fetchMock = stubFetch();
    await sendWhatsappText(envWith(), "447700900123", "hi", LOG);
    expect(sentBody(fetchMock).to).toBe("447700900123");
  });

  it("does not touch a plus anywhere but the front", async () => {
    // The regex is anchored, which is what stops a naive .replace("+", "")
    // -- or worse, a global one -- from mangling an extension-style number.
    const fetchMock = stubFetch();
    await sendWhatsappText(envWith(), "+44770+0900123", "hi", LOG);
    expect(sentBody(fetchMock).to).toBe("44770+0900123");
  });

  it("keeps a plus that is preceded by whitespace, exactly as Django does", async () => {
    // Parity check, both directions. CPython 3.13.0 on this machine:
    // ' +447'.lstrip('+') == ' +447' -- lstrip only removes characters from
    // the set it is given, and a space is not in that set, so the plus
    // survives there too. Neither implementation trims. Actually run, not
    // reasoned about.
    const fetchMock = stubFetch();
    await sendWhatsappText(envWith(), " +447700900123", "hi", LOG);
    expect(sentBody(fetchMock).to).toBe(" +447700900123");
  });

  it("strips only ONE plus from a doubled prefix, where Django strips both", async () => {
    // A REAL DIVERGENCE, pinned as current behaviour rather than fixed.
    // CPython 3.13.0 on this machine: '++447700900123'.lstrip('+') is
    // '447700900123' -- lstrip removes every leading character in the set.
    // The port's /^\+/ removes exactly one, leaving "+447700900123", which
    // Meta rejects with a 400 and which surfaces as a silent non-send.
    //
    // Unreachable today: whatsappHook.ts:85-87 only ever prepends a plus to
    // a number that lacks one, so a doubled prefix would have to arrive
    // through a hand-edited row. Recorded so that if one ever does, the
    // difference is documented rather than discovered.
    const fetchMock = stubFetch();
    await sendWhatsappText(envWith(), "++447700900123", "hi", LOG);
    expect(sentBody(fetchMock).to).toBe("+447700900123");
  });

  it("normalises before logging, so the log shows the number Meta was given", async () => {
    // Not cosmetic. When a send fails the log line is the only record of
    // which number it was, and matching it back to a whatsappsubscriber row
    // (which stores the plus) is a manual job either way -- so the log must
    // at least be honest about what went on the wire.
    stubFetch(replies("bad request", 400));
    await sendWhatsappText(envWith(), "+447700900123", "hi", LOG);
    expect(String(error.mock.calls[0]![0])).toContain("for 447700900123:");
  });
});

describe("sendWhatsappText: the token gate", () => {
  it("refuses to send, and says so, when WHATSAPP_TOKEN is unset", async () => {
    // notifications.py:486-489 does the same check against get_cred and
    // returns False. The important half is the SHORT CIRCUIT: without it the
    // request goes out as "Bearer undefined", Meta answers 401, and the
    // log says "Graph API 401" -- which reads as a revoked credential and
    // sends someone off to rotate a token that was simply never deployed.
    const fetchMock = stubFetch();
    expect(await sendWhatsappText(envMissingToken(), "+447700900123", "hi", LOG)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual([
      "notify-need-whatsapp: WHATSAPP_TOKEN not set, not sending to 447700900123",
    ]);
  });

  it("treats an empty-string secret the same as a missing one", async () => {
    // `wrangler secret put` with an empty value, and a secrets-file entry
    // with a blank right-hand side, both produce "" rather than undefined.
    // A `=== undefined` check would sail past and send "Bearer ".
    const fetchMock = stubFetch();
    expect(await sendWhatsappText(envWith(""), "+447700900123", "hi", LOG)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("carries the caller's log prefix into the warning", async () => {
    // The two callers pass different prefixes -- "notify-need-whatsapp" from
    // the notification consumer, "whatsapp-hook" from the inbound reply
    // path. A Worker tail is one undifferentiated stream, so the prefix is
    // how anyone tells "nobody got notified" from "nobody's STOP worked".
    stubFetch();
    await sendWhatsappText(envWith(""), "+447700900123", "hi", "whatsapp-hook");
    expect(warn.mock.calls[0]![0]).toBe("whatsapp-hook: WHATSAPP_TOKEN not set, not sending to 447700900123");
  });
});

describe("sendWhatsappText: what counts as a successful send", () => {
  it("returns true on a 200 and logs nothing", async () => {
    const fetchMock = stubFetch(ok());
    expect(await sendWhatsappText(envWith(), "+447700900123", "hi", LOG)).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns FALSE on a 201 and a 202, matching Django's exact == 200", async () => {
    // The module's own comment: "Django checks `== 200` exactly, on both
    // send paths. Matched, not widened." notifications.py:512 and :616 are
    // both `if response.status_code == 200`.
    //
    // This is the mutation that matters most in the whole file. Rewriting
    // the guard as `if (!res.ok)` -- the idiomatic thing to reach for --
    // passes every other test here, because every other test uses a 200 or
    // a 4xx. A 2xx-that-is-not-200 from this endpoint would then be counted
    // as a delivered message and stamped into whatsappsubscriber.last_
    // notified, and nobody would ever look again.
    for (const status of [201, 202, 204]) {
      const fetchMock = stubFetch(replies("{}", status));
      expect(await sendWhatsappText(envWith(), "+447700900123", "hi", LOG)).toBe(false);
      expect(requestUrl(fetchMock)).toBe(MESSAGES_URL);
    }
    expect(error).toHaveBeenCalledTimes(3);
  });

  it("returns true on a 200 without ever reading the response body", async () => {
    // MUTANT THIS KILLS (survived the suite as originally written):
    // hoisting the body read out of the error branch -- `const bodyText =
    // await res.text()` above the status check, then logging `bodyText`. It
    // is the tidy-looking "read it once" refactor, the failure log still gets
    // its body, and every other test in this file still passes.
    //
    // What it changes is the SUCCESS path. Today a 200 whose body cannot be
    // read -- a stream truncated between Meta's edge and the isolate -- still
    // returns true, because the module never touches the body at all. After
    // the hoist the read throws into the catch and the answer becomes false,
    // so a message Meta has already accepted and delivered is recorded as
    // unsent: needWhatsApp.ts:76 leaves that subscriber out of the
    // setWhatsappLastNotified write, and the next need re-sends to someone
    // who was messaged perfectly well the first time.
    const textSpy = vi.fn(async () => "{\"messages\":[{\"id\":\"wamid.123\"}]}");
    stubFetch(async () => {
      const res = new Response("{}", { status: 200 });
      Object.defineProperty(res, "text", { value: textSpy });
      return res;
    });

    expect(await sendWhatsappText(envWith(), "+447700900123", "hi", LOG)).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("logs the status AND Meta's body on a rejection, because the body is the only diagnosis", async () => {
    // notifications.py:516 logs status_code and response.text for the
    // same reason. Meta answers 400 with a code and a message ("Template
    // name does not exist in the translation", 132001) that is the entire
    // difference between "our payload is wrong" and "Meta is down"; dropping
    // it leaves a bare number in the log and nothing to act on.
    const body = "{\"error\":{\"message\":\"Template name does not exist\",\"code\":132001}}";
    stubFetch(replies(body, 400));

    expect(await sendWhatsappText(envWith(), "+447700900123", "hi", LOG)).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]).toEqual([
      `notify-need-whatsapp: Graph API 400 for 447700900123: ${body}`,
    ]);
  });

  it("carries the caller's log prefix into BOTH error lines, not only the warning", async () => {
    // MUTANT THIS KILLS (survived the suite as originally written):
    // hard-coding "notify-need-whatsapp" into the two console.error templates
    // while leaving the console.warn interpolated. Every other failure-path
    // test in this file passes LOG, whose value IS "notify-need-whatsapp", so
    // that mutation was completely invisible -- only the token-gate warning
    // was ever checked with a second prefix.
    //
    // It matters because the other caller is the inbound reply path:
    // queues/whatsappHook.ts:89 sets LOG = "whatsapp-hook" and passes it to
    // sendWhatsappText for every subscribe/unsubscribe answer. A Worker tail
    // is one undifferentiated stream, so a mislabelled error line sends
    // whoever is reading it to the notification cron -- which is working
    // perfectly -- while the thing actually broken is that nobody's
    // "unsubscribe" is being acknowledged.
    stubFetch(replies("bad request", 400));
    await sendWhatsappText(envWith(), "+447700900123", "hi", "whatsapp-hook");
    expect(error.mock.calls[0]).toEqual(["whatsapp-hook: Graph API 400 for 447700900123: bad request"]);

    error.mockClear();
    const boom = new Error("network down");
    stubFetch(rejects(boom));
    await sendWhatsappText(envWith(), "+447700900123", "hi", "whatsapp-hook");
    expect(error.mock.calls[0]).toEqual(["whatsapp-hook: send failed for 447700900123", boom]);
  });

  it("returns false and logs the error object when fetch itself rejects", async () => {
    // notifications.py:518-520's `except Exception`. DNS failure, TLS
    // failure, a Worker subrequest limit -- all of them have to become a
    // boolean here, because neither caller catches anything.
    const boom = new TypeError("network error");
    stubFetch(rejects(boom));

    expect(await sendWhatsappText(envWith(), "+447700900123", "hi", LOG)).toBe(false);
    // Two arguments, not an interpolated string: the error object keeps its
    // stack in a Worker tail, and `${err}` would throw that away.
    expect(error.mock.calls[0]).toEqual(["notify-need-whatsapp: send failed for 447700900123", boom]);
  });

  it("survives a non-2xx whose body cannot be read, logging once rather than twice", async () => {
    // `await res.text()` is evaluated INSIDE the console.error template
    // literal, which is itself inside the try. So a body stream that errors
    // mid-read on an already-failed response skips the "Graph API 502" log
    // entirely and lands in the catch instead. One log line, not two, and
    // it names the read failure rather than the status -- which is worth
    // knowing when reading a tail, since the status is then lost for good.
    stubFetch(async () => {
      const res = new Response("x", { status: 502 });
      Object.defineProperty(res, "text", {
        value: async () => {
          throw new Error("body stream errored");
        },
      });
      return res;
    });

    expect(await sendWhatsappText(envWith(), "+447700900123", "hi", LOG)).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toBe("notify-need-whatsapp: send failed for 447700900123");
    expect(String(error.mock.calls[0]![1])).toContain("body stream errored");
  });

  it("sends the message text verbatim, newlines and apostrophes and all", async () => {
    // The reply copy in queues/whatsappHook.ts:129-131 is "word for word"
    // from views.py and includes typographic apostrophes and a quoted
    // command. JSON.stringify is the only encoder in the path; any attempt
    // to "sanitise" the body here would alter product copy people have been
    // reading for months.
    const message = "You've been unsubscribed from Ely Foodbank.\nTo subscribe again, send 'subscribe ely'.";
    const fetchMock = stubFetch();
    await sendWhatsappText(envWith(), "+447700900123", message, LOG);
    expect((sentBody(fetchMock).text as { body: string }).body).toBe(message);
  });

  it("does not trim the body, and does not cap its length", async () => {
    // MUTANTS THIS KILLS (both survived the suite as originally written):
    // `message.trim()` and `message.slice(0, 1024)`. The verbatim test above
    // uses an 85-character message with no surrounding whitespace, so neither
    // "defensive" edit changed a single assertion in this file.
    //
    // Django puts `message` into the payload untouched
    // (notifications.py:501-509), and both edits are the sort of thing added
    // in passing to "be safe with user input". A cap is the worse of the two:
    // it is invisible until a message is long, and what it cuts off is the
    // end -- which in the subscribe reply is the instruction telling someone
    // how to stop.
    const long = `\n  ${"Tinned tomatoes, nappies, UHT milk. ".repeat(200)}  \n`;
    const fetchMock = stubFetch();
    await sendWhatsappText(envWith(), "+447700900123", long, LOG);

    const sent = (sentBody(fetchMock).text as { body: string }).body;
    expect(sent).toBe(long);
    // Stated separately so the failure reads as "truncated" rather than as an
    // unreadable 7,000-character diff.
    expect(sent.length).toBe(7206);
  });

  it("sends an empty message body rather than skipping the call", async () => {
    // Nothing guards against "". Meta rejects it, so the observable result
    // is a 400 and a false -- pinned so that a future early-return shows up
    // as a deliberate change rather than a silent one.
    const fetchMock = stubFetch(replies("{\"error\":{\"code\":100}}", 400));
    expect(await sendWhatsappText(envWith(), "+447700900123", "", LOG)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBody(fetchMock).text).toEqual({ body: "" });
  });
});

describe("buildNeedTemplate", () => {
  it("builds Django's approved-template payload component for component", async () => {
    // notifications.py:559-612, transcribed. This is the single assertion
    // that matters in this describe block: Meta validates an approved
    // template's structure exactly, so a renamed component type, a dropped
    // parameter or a reordered pair is a 132000-family error and a silent
    // non-send for every one of that food bank's subscribers.
    //
    // The ORDER inside `body.parameters` is the contract with the template
    // Meta approved: {{1}} is the food bank name, {{2}}..{{4}} are the three
    // items. Swapping name and item1 would still be a valid API call and
    // would still deliver -- it would just tell people that "Baked Beans
    // needs Ely Foodbank".
    expect(buildNeedTemplate("Ely Foodbank", "ely", ["Tinned Tomatoes", "Nappies", "UHT Milk"])).toEqual({
      type: "template",
      template: {
        name: "foodbankneed2",
        language: { code: "en" },
        components: [
          { type: "header", parameters: [{ type: "text", text: "Ely Foodbank" }] },
          {
            type: "body",
            parameters: [
              { type: "text", text: "Ely Foodbank" },
              { type: "text", text: "Tinned Tomatoes" },
              { type: "text", text: "Nappies" },
              { type: "text", text: "UHT Milk" },
            ],
          },
          { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "ely" }] },
        ],
      },
    });
  });

  it("names the SECOND template, foodbankneed2, not the original", async () => {
    // notifications.py:564. The docstring at :526 still says
    // "Uses the 'foodbankneed' template" while the payload says
    // "foodbankneed2" -- the docstring is the stale half, and the port
    // follows the payload. Both templates exist at Meta's end with
    // different parameter counts, so picking the wrong name is not a
    // not-found error, it is a parameter-count mismatch.
    const template = buildNeedTemplate("Ely Foodbank", "ely", ["a", "b", "c"]);
    expect(template.template.name).toBe("foodbankneed2");
    expect(template.template.language).toEqual({ code: "en" });
  });

  it("sends the button index as the STRING \"0\"", async () => {
    // notifications.py:602 -- `"index": "0"`, quoted, in Python too. Meta's
    // API rejects a numeric index on a button component, and TypeScript
    // would happily have let this be a number. The button carries the food
    // bank slug as the URL suffix, so getting it rejected costs the message
    // its link.
    const button = buildNeedTemplate("Ely Foodbank", "ely", ["a", "b", "c"]).template.components[2]!;
    expect(button.index).toBe("0");
    expect(typeof button.index).toBe("string");
    expect(button.sub_type).toBe("url");
  });

  it("keeps all three item slots when a food bank needs fewer than three things", async () => {
    // notifications.py:552-554 pads with "" and needWhatsApp.ts:65 does the
    // same with `items[n] ?? ""`. The padding must reach the payload as
    // present-but-empty parameters: Meta counts them, and a template
    // expecting four body parameters that receives two is a 132000 error --
    // so a food bank that needs one thing would notify nobody at all.
    const params = buildNeedTemplate("Ely Foodbank", "ely", ["Nappies", "", ""]).template.components[1]!.parameters;
    expect(params).toHaveLength(4);
    expect(params.map((p) => p.text)).toEqual(["Ely Foodbank", "Nappies", "", ""]);
    // Still typed as text parameters, not silently omitted or nulled.
    expect(params.every((p) => p.type === "text")).toBe(true);
  });

  it("passes names and slugs through with no escaping or truncation of its own", async () => {
    // Food bank names in this database carry apostrophes, ampersands and
    // accents ("St Vincent de Paul", "Caffi Wcw"). JSON.stringify at send
    // time is the only encoder; adding another here would double-escape
    // them into the message a subscriber reads.
    const name = "St. Peter's & Caffi Wcw Foodbank — Aberdâr";
    const template = buildNeedTemplate(name, "aberdare-caffi-wcw", ["Coffee & Tea", "", ""]);
    expect(template.template.components[0]!.parameters[0]!.text).toBe(name);
    expect(template.template.components[1]!.parameters[1]!.text).toBe("Coffee & Tea");
    expect(template.template.components[2]!.parameters[0]!.text).toBe("aberdare-caffi-wcw");
  });

  it("does not trim whitespace off a name or an item either", async () => {
    // MUTANT THIS KILLS (survived the suite as originally written):
    // `t.trim()` inside the one-line `text()` helper. The escaping test above
    // uses values with no surrounding whitespace, so it changed nothing.
    //
    // Not hypothetical, and this is the reason it is worth its own test. The
    // items come from changeList (packages/models/src/index.ts:206-208), a
    // bare `change_text.split("\n")` that mirrors Django's change_list
    // (givefood/models/needs.py:134-135) exactly -- neither side strips. So a
    // change_text stored with CRLF line endings yields items ending in "\r"
    // in BOTH implementations, and Django hands those to Meta untouched.
    // Trimming here would be a real divergence in what a subscriber reads,
    // introduced by a helper that looks like pure formatting.
    const padded = buildNeedTemplate(" Ely Foodbank ", "ely", ["Tinned Tomatoes\r", "  ", ""]);
    expect(padded.template.components[0]!.parameters[0]!.text).toBe(" Ely Foodbank ");
    expect(padded.template.components[1]!.parameters.map((p) => p.text)).toEqual([
      " Ely Foodbank ",
      "Tinned Tomatoes\r",
      "  ",
      "",
    ]);
  });

  it("returns a fresh object every call, sharing nothing between them", async () => {
    // needWhatsApp.ts:65 builds ONE template and reuses it for a page of up
    // to 25 subscribers. That is only safe while nothing downstream mutates
    // it -- and it would be quietly unsafe if this function returned a
    // module-level singleton, because two food banks' notifications running
    // in the same isolate would then overwrite each other's item lists.
    const a = buildNeedTemplate("Ely Foodbank", "ely", ["Beans", "", ""]);
    const b = buildNeedTemplate("Hull Foodbank", "hull", ["Rice", "", ""]);
    expect(a).not.toBe(b);
    expect(a.template.components).not.toBe(b.template.components);
    expect(a.template.components[0]!.parameters[0]!.text).toBe("Ely Foodbank");
  });
});

describe("sendWhatsappTemplate", () => {
  const template = () => buildNeedTemplate("Ely Foodbank", "ely", ["Tinned Tomatoes", "Nappies", "UHT Milk"]);

  it("puts the whole Django payload on the wire, envelope and template together", async () => {
    // notifications.py:559-612 as one object. The template is SPREAD, not
    // nested: `type: "template"` has to sit beside `messaging_product` at
    // the top level, and a payload of {messaging_product, to, template:{...}}
    // with no `type` is a Meta 400. That is exactly what a well-meaning
    // `{...envelope, template}` refactor would produce.
    const fetchMock = stubFetch();
    expect(await sendWhatsappTemplate(envWith(), "+447700900123", template(), LOG)).toBe(true);

    expect(requestUrl(fetchMock)).toBe(MESSAGES_URL);
    expect(sentBody(fetchMock)).toEqual({
      messaging_product: "whatsapp",
      to: "447700900123",
      type: "template",
      template: {
        name: "foodbankneed2",
        language: { code: "en" },
        components: [
          { type: "header", parameters: [{ type: "text", text: "Ely Foodbank" }] },
          {
            type: "body",
            parameters: [
              { type: "text", text: "Ely Foodbank" },
              { type: "text", text: "Tinned Tomatoes" },
              { type: "text", text: "Nappies" },
              { type: "text", text: "UHT Milk" },
            ],
          },
          { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "ely" }] },
        ],
      },
    });
    // The same headers and budget as the text path -- both go through the
    // one `post`, and a divergence here would mean templates authenticating
    // differently from replies.
    expect(headers(fetchMock).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(requestInit(fetchMock).method).toBe("POST");
  });

  it("normalises the subscriber's stored +44 number", async () => {
    // whatsappsubscriber.phone_number is stored with the plus
    // (whatsappHook.ts:85-87 puts it back on Meta's plus-less inbound
    // `from`), and needWhatsApp.ts:70 hands that column straight to here.
    const fetchMock = stubFetch();
    await sendWhatsappTemplate(envWith(), "+447700900123", template(), LOG);
    expect(sentBody(fetchMock).to).toBe("447700900123");
  });

  it("does not mutate the template it was handed, so a page of 25 all get the same one", async () => {
    // The precise failure this prevents: needWhatsApp.ts builds the template
    // once and loops 25 subscribers through it. If `post` merged `to` INTO
    // the caller's object rather than into a copy, subscriber 2 would be
    // sent to subscriber 1's number -- or, with the spread the other way
    // round, every send after the first would carry a stale `to`. Both
    // deliver a 200 and both look like a perfectly successful run.
    const shared = template();
    const before = JSON.stringify(shared);
    const fetchMock = stubFetch();

    await sendWhatsappTemplate(envWith(), "+447700900123", shared, LOG);
    await sendWhatsappTemplate(envWith(), "+447700900456", shared, LOG);

    expect(JSON.stringify(shared)).toBe(before);
    expect(shared).not.toHaveProperty("to");
    expect(sentBody(fetchMock, 0).to).toBe("447700900123");
    expect(sentBody(fetchMock, 1).to).toBe("447700900456");
    // Identical templates, different recipients: the body content is
    // unaffected by having been sent once already.
    expect(sentBody(fetchMock, 0).template).toEqual(sentBody(fetchMock, 1).template);
  });

  it("refuses to send with no token, and names the subscriber it skipped", async () => {
    // needWhatsApp.ts:36-39 checks WHATSAPP_TOKEN itself and returns early,
    // so in the notification path this gate is belt and braces. It is not
    // redundant: this warning is what a caller that forgets that check would
    // leave in the tail, and it is the only trace that a subscriber was
    // skipped rather than sent.
    const fetchMock = stubFetch();
    expect(await sendWhatsappTemplate(envWith(""), "+447700900123", template(), LOG)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn.mock.calls[0]![0]).toBe("notify-need-whatsapp: WHATSAPP_TOKEN not set, not sending to 447700900123");
  });

  it("returns false and logs Meta's rejection body on a 400", async () => {
    // The one that actually happens: an approved template can be paused or
    // its parameter count changed at Meta's end, and every notification then
    // fails with a 132-series code while the cron run reports success. The
    // log body is the only place that code appears.
    const body = "{\"error\":{\"message\":\"(#132000) Number of parameters does not match\",\"code\":132000}}";
    stubFetch(replies(body, 400));

    expect(await sendWhatsappTemplate(envWith(), "+447700900123", template(), LOG)).toBe(false);
    expect(error.mock.calls[0]).toEqual([`notify-need-whatsapp: Graph API 400 for 447700900123: ${body}`]);
  });

  it("returns false on a 201, exactly as the text path does", async () => {
    // Both senders go through the one `post`, so the "== 200 exactly" rule
    // is asserted on both sides -- a widened check would be introduced in
    // one place and silently change both.
    stubFetch(replies("{}", 201));
    expect(await sendWhatsappTemplate(envWith(), "+447700900123", template(), LOG)).toBe(false);
  });

  it("returns false when the request throws rather than propagating it", async () => {
    // needWhatsApp.ts:70 calls this bare inside a for loop with no
    // try/catch. A throw would abandon the rest of the page AND skip the
    // setWhatsappLastNotified write for the subscribers already sent to,
    // which on the queue's retry would message them a second time.
    stubFetch(rejects(new Error("subrequest limit exceeded")));
    expect(await sendWhatsappTemplate(envWith(), "+447700900123", template(), LOG)).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
