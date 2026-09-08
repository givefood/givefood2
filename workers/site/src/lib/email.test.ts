import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { redactedKeyValueLines, sendEmail } from "./email";
import type { SendEmailParams } from "./email";
import type { AppEnv } from "../types";
import type { Env } from "../../worker-configuration";

// lib/email.ts is the single outbound mail path for the whole site Worker:
// routes/wfbn/updates.ts (subscribe + confirm), routes/public/flag.ts,
// routes/public/registerFoodbank.ts, routes/admin/orderActions.ts and
// routes/write/index.ts all funnel through the one sendEmail() here. Four of
// those five DISCARD its boolean return, so when this module is wrong the
// visible outcome is a green "we've sent you an email" page and no email --
// the exact silent-credential failure mode this tier exists to make visible.
// There is no retry, no queue and no dead letter behind it: one fetch, one
// boolean, and a console line nobody reads.
//
// It is a port of givefood/utils/notifications.py's send_email() (read at
// notifications.py:100-148 on this machine for these tests -- the module's
// own header cites :99-146, one line out either side, which is what the
// file's `def send_email` at line 100 through `return False` at 148 actually
// spans). Every parity claim below was checked by reading that function, not
// by running it: the Django app is not runnable here, so nothing in this file
// claims to have executed Python.
//
// REAL CONTEXT, REAL HONO. sendEmail() takes a Context<AppEnv> and reads
// c.env off it, so every call below is made from inside a handler on a real
// Hono app dispatched with app.fetch(). A hand-rolled `{ env }` object would
// type-check and pass, and would then keep passing if the signature moved to
// something only a genuine Context provides. Only global fetch is stubbed:
// Postmark's REST API is the one thing here that leaves the machine.
//
// MUTATION-TESTED. email.ts was copied out to a scratchpad, broken 39
// different ways and re-run against this file: response.ok for status === 200,
// the diversion keyed on `to` instead of `replyTo`, each redacted key put
// back, a substring/case-insensitive redaction, `||` for `??`, a broadcast
// stream, an Authorization header, Headers instead of a plain object, the
// catch rethrowing, the skip path falling through to fetch, and so on. 38 of
// the 39 failed at least one test here; the survivor was a token read that
// still fell back to c.env, i.e. behaviourally identical. Where a test's
// comment names a mutant, that is the specific wrong implementation it exists
// to catch.

const TOKEN = "test-postmark-token";
const POSTMARK_URL = "https://api.postmarkapp.com/email";

// Hono's fetch() wants an ExecutionContext; nothing under test touches it.
const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

// The exact JSON body Django's send_email() builds (notifications.py:119-131)
// minus the "Headers" key it adds only for unsubscribe_url, which this port
// has no parameter for. Typed as the wire shape rather than as a partial so
// that an added or renamed field shows up as a type error here too.
interface PostmarkPayload {
  From: string;
  To: string;
  Cc: string | null;
  Bcc: string | null;
  Subject: string;
  TextBody: string;
  HtmlBody: string | null;
  ReplyTo: string | null;
  MessageStream: string;
}

interface Outbound {
  url: string;
  method: unknown;
  /** Captured raw, NOT normalised -- see the headers test for why. */
  headers: unknown;
  body: unknown;
}

let outbound: Outbound[];
let fetchMock: ReturnType<typeof vi.fn>;
/** Swapped per-test to make Postmark answer 4xx, hang up, or return junk. */
let respond: () => Promise<Response>;

function payloads(): PostmarkPayload[] {
  return outbound.map((o) => JSON.parse(String(o.body)) as PostmarkPayload);
}

/**
 * Dispatch a real request through a real Hono app whose handler calls the
 * real sendEmail(), and hand back what it returned.
 *
 * Anything sendEmail() throws is captured and re-thrown out of this helper
 * rather than being swallowed by Hono's error handling, because "never
 * throws" is a load-bearing part of this module's contract: routes/write and
 * routes/admin/orderActions both `await sendEmail(...)` outside any try, so
 * an exception escaping it is a 500 on a form the visitor already filled in.
 * Every `resolves.toBe(false)` below is therefore also asserting no throw.
 */
async function send(params: SendEmailParams, envOverrides: Record<string, unknown> = {}): Promise<boolean> {
  const env = { POSTMARK_TOKEN: TOKEN, ...envOverrides } as unknown as Env;
  let returned: boolean | undefined;
  let thrown: unknown;

  const app = new Hono<AppEnv>();
  app.post("/send/", async (c) => {
    try {
      returned = await sendEmail(c, params);
    } catch (err) {
      thrown = err;
    }
    return c.text("handler finished");
  });

  const res = await app.fetch(new Request("https://www.givefood.org.uk/send/", { method: "POST" }), env, execCtx);
  // A 500 here means Hono caught something the handler above did not, which
  // would make every assertion after it meaningless.
  expect(res.status).toBe(200);
  if (thrown !== undefined) throw thrown;
  return returned as boolean;
}

beforeEach(() => {
  outbound = [];
  respond = async () => new Response(JSON.stringify({ ErrorCode: 0, Message: "OK", MessageID: "abc" }), { status: 200 });

  // Postmark and nothing else. A call to any other host is thrown rather than
  // quietly answered: this module is supposed to make exactly one subrequest
  // per send, and a stub that answered everything would hide a second one.
  fetchMock = vi.fn(async (input: unknown, init?: unknown) => {
    const url = typeof input === "string" ? input : String((input as Request).url);
    const request = (init ?? {}) as RequestInit;
    outbound.push({ url, method: request.method, headers: request.headers, body: request.body });
    if (!url.startsWith("https://api.postmarkapp.com/")) throw new Error(`unexpected outbound fetch to ${url}`);
    return respond();
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("redactedKeyValueLines", () => {
  // The body of the internal notification email sent to mail@givefood.org.uk
  // when someone flags a page or registers a food bank. Ported from
  // public/flag_email.txt and public/registration_email.txt, which are the
  // same two-line Django template:
  //     {% for key, value in form %}
  //     {{ key }}: {{ value }}{% endfor %}
  // -- i.e. a newline BEFORE each pair, not between pairs.

  it("renders one 'key: value' line per field, joined by newlines", () => {
    expect(redactedKeyValueLines({ name: "Sid Valley Foodbank", postcode: "EX10 8LS", email: "hello@example.org" })).toBe(
      "name: Sid Valley Foodbank\npostcode: EX10 8LS\nemail: hello@example.org",
    );
  });

  it("emits NO leading newline, where Django's template emits one", () => {
    // DELIBERATE, PINNED. Django's `{% for %}` puts the newline at the START
    // of the loop body, so render_to_string("public/registration_email.txt")
    // returns "\nname: ...\npostcode: ..." -- the real mail@givefood.org.uk
    // inbox has a blank first line on every one of these. join("\n") does not
    // reproduce that. Cosmetic in an internal email, but it is the difference
    // between the two implementations and it belongs written down, because
    // the next person diffing a production email against this output will
    // otherwise think one of them is broken.
    expect(redactedKeyValueLines({ name: "Sid Valley" }).startsWith("\n")).toBe(false);
  });

  it("emits no trailing newline either", () => {
    // flag.ts appends "\n\nIP Address: ..." itself; a trailing newline here
    // would give that section three blank lines instead of one.
    expect(redactedKeyValueLines({ name: "Sid Valley" })).toBe("name: Sid Valley");
  });

  it("drops csrf_token", () => {
    // The whole point of the function. An internal email that quotes a live
    // CSRF token has published a working token to an inbox, a mail relay's
    // logs, and whatever archives that inbox.
    const body = redactedKeyValueLines({ csrf_token: "abc123.deadbeef", name: "Sid Valley" });
    expect(body).toBe("name: Sid Valley");
    expect(body).not.toContain("abc123");
  });

  it("drops cf-turnstile-response", () => {
    // Same reasoning: the Turnstile response token is single-use but is still
    // a credential, and Django's flag() view pops it for exactly this reason
    // (views.py:1112-1113).
    const body = redactedKeyValueLines({ "cf-turnstile-response": "0.AAAA-token", name: "Sid Valley" });
    expect(body).toBe("name: Sid Valley");
    expect(body).not.toContain("0.AAAA-token");
  });

  it("drops both without leaving the blank lines where they were", () => {
    // The filter runs BEFORE the map, so a redacted field contributes no line
    // at all. An implementation that mapped first and blanked the value would
    // pass the two tests above and fail this one, having still leaked the key
    // ordering and left a ragged body.
    expect(
      redactedKeyValueLines({
        csrf_token: "abc123",
        name: "Sid Valley",
        "cf-turnstile-response": "0.AAAA",
        postcode: "EX10 8LS",
      }),
    ).toBe("name: Sid Valley\npostcode: EX10 8LS");
  });

  it("returns an empty string, not a newline, when every field is redacted", () => {
    // [].join("\n") is "", so the body is empty rather than whitespace. flag.ts
    // then sends "\n\nIP Address: ..." -- an email whose only content is the
    // IP. Worth pinning because "" is the value that tells a reader at a
    // glance the form was empty.
    expect(redactedKeyValueLines({ csrf_token: "abc", "cf-turnstile-response": "0.A" })).toBe("");
  });

  it("returns an empty string for no fields at all", () => {
    expect(redactedKeyValueLines({})).toBe("");
  });

  it("keeps fields whose value is empty, as 'key: '", () => {
    // Both Django templates render every submitted key including the blanks,
    // and the blanks are informative in a registration email -- "phone_number:"
    // with nothing after it says the food bank did not give one, whereas an
    // absent line says nothing at all.
    expect(redactedKeyValueLines({ name: "Sid Valley", phone_number: "", email: "" })).toBe("name: Sid Valley\nphone_number: \nemail: ");
  });

  it("matches the two redacted keys EXACTLY, so a different casing still leaks", () => {
    // SUSPECT, PINNED AS-IS. The filter is `key !== "csrf_token"`, a
    // case-sensitive identity test. Nothing in this port posts "CSRF_Token"
    // today, but the guard is one renamed form field away from doing nothing,
    // and it fails open: the email still sends, with the token in it.
    expect(redactedKeyValueLines({ CSRF_TOKEN: "abc123" })).toBe("CSRF_TOKEN: abc123");
    expect(redactedKeyValueLines({ Csrf_Token: "abc123" })).toBe("Csrf_Token: abc123");
    expect(redactedKeyValueLines({ "CF-Turnstile-Response": "0.AAAA" })).toBe("CF-Turnstile-Response: 0.AAAA");
  });

  it("does not redact keys that merely contain or extend the redacted names", () => {
    // A substring or startsWith implementation would strip these too. Seeded
    // precisely because they MUST survive: a test that only seeds rows it
    // expects to be dropped is passed by a filter that drops everything.
    expect(
      redactedKeyValueLines({
        csrf_token_2: "a",
        my_csrf_token: "b",
        "cf-turnstile-response-2": "c",
        "x-cf-turnstile-response": "d",
      }),
    ).toBe("csrf_token_2: a\nmy_csrf_token: b\ncf-turnstile-response-2: c\nx-cf-turnstile-response: d");
  });

  it("does NOT drop Django's own csrfmiddlewaretoken", () => {
    // Parity note, not a defect. Django's flag() pops "csrfmiddlewaretoken"
    // (views.py:1112) because that is what `{% csrf_token %}` names the
    // field; this port's forms name it "csrf_token" (see lib/csrf.ts), so the
    // ported filter names that instead. If a form here ever posted the Django
    // name it would sail straight into the email -- pinned so the asymmetry
    // is visible rather than assumed away.
    expect(redactedKeyValueLines({ csrfmiddlewaretoken: "django-style" })).toBe("csrfmiddlewaretoken: django-style");
  });

  it("preserves insertion order for ordinary string keys", () => {
    // The email is read by a human comparing it against the form they are
    // looking at, so the order is part of the output. Object.entries() keeps
    // insertion order for non-integer-like keys, which is what a spread of a
    // form's values gives.
    expect(redactedKeyValueLines({ zebra: "1", apple: "2", middle: "3" })).toBe("zebra: 1\napple: 2\nmiddle: 3");
  });

  it("hoists integer-like keys to the front, in ascending numeric order", () => {
    // Not a choice this module made -- it is ECMAScript's own property order
    // for array-index-like keys, inherited from Object.entries(). Pinned
    // because a form with numbered fields ("1", "2", "10") would come out
    // reordered relative to the form the visitor filled in, and someone
    // debugging that needs to find it documented rather than rediscover it.
    expect(redactedKeyValueLines({ name: "Sid", "10": "ten", "2": "two" })).toBe("2: two\n10: ten\nname: Sid");
  });

  it("copies values through verbatim, so a newline in a value forges extra lines", () => {
    // SUSPECT, PINNED AS-IS -- and inherited, not introduced: Django's
    // template renders `{{ key }}: {{ value }}` into a .txt with no autoescape
    // effect on newlines, so it forges lines in exactly the same way.
    // registerFoodbank.ts closes the gap upstream with isSingleLine() on its
    // free-text fields rather than here (see its comment at :69), which means
    // this function stays injectable and any NEW caller that forgets that
    // check inherits the hole. The `address` field is deliberately exempt
    // there, so multi-line values genuinely do reach this code path.
    expect(redactedKeyValueLines({ name: "Sid\nemail: attacker@example.com", postcode: "EX10 8LS" })).toBe(
      "name: Sid\nemail: attacker@example.com\npostcode: EX10 8LS",
    );
  });

  it("does not escape, trim or otherwise touch a value", () => {
    // No HTML escaping (this is a text/plain body), no trimming, no unicode
    // normalisation. Pinned as one assertion so a well-meaning "sanitise the
    // email body" change has to admit it changed something.
    expect(redactedKeyValueLines({ notes: "  <b>&amp;</b> café — \t ", tab: "a\tb" })).toBe(
      "notes:   <b>&amp;</b> café — \t \ntab: a\tb",
    );
  });

  it("includes an own '__proto__' key like any other field", () => {
    // Built with fromEntries rather than a literal, because `{ __proto__: x }`
    // in a literal sets the prototype instead of creating a property --
    // whereas Object.fromEntries(new URLSearchParams(body)), which is how a
    // posted form becomes this Record, creates a real own property. Confirms
    // the filter drops the two named keys and nothing else.
    const fields = Object.fromEntries(new URLSearchParams("__proto__=polluted&name=Sid")) as Record<string, string>;
    expect(redactedKeyValueLines(fields)).toBe("__proto__: polluted\nname: Sid");
  });
});

describe("sendEmail", () => {
  const BASIC: SendEmailParams = { to: "mail@givefood.org.uk", subject: "Give Food - Flagged Page", textBody: "url: /needs/\n\nIP Address: 1.2.3.4" };

  describe("the request Postmark receives", () => {
    it("POSTs once to the Postmark REST endpoint", async () => {
      await expect(send(BASIC)).resolves.toBe(true);

      expect(outbound).toHaveLength(1);
      expect(outbound[0]?.url).toBe(POSTMARK_URL);
      expect(outbound[0]?.method).toBe("POST");
    });

    it("makes exactly one subrequest per call, and none are shared or cached", async () => {
      // Workers cap subrequests per invocation (50 on the paid plan), and
      // routes/admin/orderActions.ts sends inside a loop. A retry or a
      // duplicated fetch added here multiplies against that budget, so the
      // count is asserted rather than assumed.
      await send(BASIC);
      await send(BASIC);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(outbound.map((o) => o.url)).toEqual([POSTMARK_URL, POSTMARK_URL]);
    });

    it("sends the three headers Django sends, as a plain object", async () => {
      await send(BASIC);

      // toEqual against a bare object also asserts the value is NOT a Headers
      // instance and carries no fourth header. The server token travels in
      // X-Postmark-Server-Token; if it ever moved to Authorization silently,
      // Postmark would 401 every send and four of the five call sites would
      // show the visitor a success page anyway.
      expect(outbound[0]?.headers).toEqual({
        "X-Postmark-Server-Token": TOKEN,
        Accept: "application/json",
        "Content-Type": "application/json",
      });
    });

    it("reads the token from the request's own env, not a module-level capture", async () => {
      // Bindings are per-invocation in Workers. A token hoisted to module
      // scope would be pinned to whichever isolate warmed first and would
      // survive a secret rotation until the isolate was evicted.
      await send(BASIC, { POSTMARK_TOKEN: "rotated-token" });

      expect((outbound[0]?.headers as Record<string, string>)["X-Postmark-Server-Token"]).toBe("rotated-token");
    });

    it("builds the minimal body with explicit nulls for every absent field", async () => {
      await send(BASIC);

      // Deep-equal on the whole payload, so an added, renamed or dropped key
      // fails here. Cc/Bcc/HtmlBody/ReplyTo are `?? null` rather than omitted,
      // matching Django's dict which always carries all of them with None.
      expect(payloads()[0]).toEqual({
        From: "mail@givefood.org.uk",
        To: "mail@givefood.org.uk",
        Cc: null,
        Bcc: null,
        Subject: "Give Food - Flagged Page",
        TextBody: "url: /needs/\n\nIP Address: 1.2.3.4",
        HtmlBody: null,
        ReplyTo: null,
        MessageStream: "outbound",
      });
    });

    it("threads cc, bcc, replyTo and htmlBody through when given", async () => {
      // routes/write/index.ts is the only caller that uses all four
      // (index.ts:387-393): the constituent is Cc'd, write-bcc@ gets a copy,
      // and ReplyTo is the constituent so the MP's reply reaches them and not
      // Give Food. If any of these were dropped the MP would answer into a
      // mailbox the constituent never sees.
      await expect(
        send({
          to: "mp@parliament.uk",
          subject: "Constituent enquiry",
          textBody: "Dear MP,",
          htmlBody: "<p>Dear MP,</p>",
          cc: "voter@example.org",
          bcc: "write-bcc@givefood.org.uk",
          replyTo: "voter@example.org",
        }),
      ).resolves.toBe(true);

      expect(payloads()[0]).toEqual({
        From: "mail@givefood.org.uk",
        To: "mp@parliament.uk",
        Cc: "voter@example.org",
        Bcc: "write-bcc@givefood.org.uk",
        Subject: "Constituent enquiry",
        TextBody: "Dear MP,",
        HtmlBody: "<p>Dear MP,</p>",
        ReplyTo: "voter@example.org",
        MessageStream: "outbound",
      });
    });

    it("always sends From: mail@givefood.org.uk, whatever the replyTo", async () => {
      // Hardcoded in both implementations. Postmark rejects any From that is
      // not a verified sender signature, so a From taken from user input would
      // 422 every send from /write/.
      await send({ ...BASIC, replyTo: "voter@example.org" });

      expect(payloads()[0]?.From).toBe("mail@givefood.org.uk");
    });

    it("always sends MessageStream: outbound, with no way to request broadcast", async () => {
      // notifications.py:111-114 picks "broadcast" when is_broadcast; this
      // port hardcodes "outbound" because no caller passes it. Pinned so the
      // day someone adds a bulk send, this test tells them the stream is not
      // a parameter yet -- Postmark bills and throttles the two streams
      // differently and mixing them gets a sender account suspended.
      await send({ ...BASIC, cc: "a@example.org", bcc: "b@example.org", replyTo: "c@example.org", htmlBody: "<p>x</p>" });

      expect(payloads()[0]?.MessageStream).toBe("outbound");
    });

    it("sends no Headers array, so RFC 8058 one-click unsubscribe is unavailable", async () => {
      // Divergence, pinned. Django's send_email() takes unsubscribe_url and
      // appends List-Unsubscribe / List-Unsubscribe-Post headers
      // (notifications.py:133-137); this port has no such parameter, and
      // workers/jobs/src/notify/needEmail.ts does its own Postmark POST partly
      // for that reason. Anything bulk sent through THIS function would go out
      // without the unsubscribe header Gmail and Yahoo require of bulk
      // senders. Named here rather than left as a silent absence.
      await send(BASIC);

      expect(Object.keys(payloads()[0] as object)).not.toContain("Headers");
      expect(String(outbound[0]?.body)).not.toContain("List-Unsubscribe");
    });

    it("keeps an empty-string cc as '', because the coalesce is ?? and not ||", async () => {
      // Pinned deliberately: `params.cc ?? null` treats "" as present. Django
      // behaves the same way with cc="" (its dict carries the empty string
      // straight through), so this is faithful -- but it means a caller that
      // builds `cc: someOptional ?? ""` posts Cc: "" to Postmark instead of
      // Cc: null, and the difference lives in one character of this module.
      await send({ ...BASIC, cc: "", bcc: "", htmlBody: "", replyTo: "" });

      const payload = payloads()[0];
      expect(payload?.Cc).toBe("");
      expect(payload?.Bcc).toBe("");
      expect(payload?.HtmlBody).toBe("");
      expect(payload?.ReplyTo).toBe("");
    });

    it("serialises the body as JSON, not form-encoded, and survives newlines and unicode", async () => {
      // The text body of a flag email is redactedKeyValueLines() output --
      // newlines throughout, and free text that can carry anything a UK
      // postcode field accepts.
      await send({ to: "mail@givefood.org.uk", subject: "Café — £5", textBody: "line one\nline two\r\n\"quoted\"\ttabbed" });

      const raw = String(outbound[0]?.body);
      expect(JSON.parse(raw)).toMatchObject({ Subject: "Café — £5", TextBody: 'line one\nline two\r\n"quoted"\ttabbed' });
      // Encoded, not literal -- proof the body really is JSON text.
      expect(raw).toContain("line one\\nline two");
    });
  });

  describe("the test@example.com diversion", () => {
    // notifications.py:117-118, kept on purpose (PLAN.md §6.11 decision I).
    // This is the single most surprising line in the module: a value typed
    // into a PUBLIC form at /write/ silently redirects the recipient.

    it("sends to the internal test inbox instead of the real recipient", async () => {
      await expect(send({ ...BASIC, to: "mp@parliament.uk", replyTo: "test@example.com" })).resolves.toBe(true);

      expect(payloads()[0]?.To).toBe("mail+testemail@givefood.org.uk");
      // The whole point of the diversion is that the MP does not get it, so
      // the original address must appear nowhere in the request at all.
      expect(String(outbound[0]?.body)).not.toContain("mp@parliament.uk");
    });

    it("leaves ReplyTo as the trigger address", async () => {
      // Django rewrites `to` only; reply_to is still put in the body
      // unchanged, so the test inbox shows who triggered it.
      await send({ ...BASIC, to: "mp@parliament.uk", replyTo: "test@example.com" });

      expect(payloads()[0]?.ReplyTo).toBe("test@example.com");
    });

    it("triggers on replyTo ONLY -- a `to` of test@example.com is left alone", async () => {
      // Kills the obvious mutant (`params.to === "test@example.com"`). Under
      // that mutant this send would be rewritten to the internal inbox, which
      // is invisible: both addresses are ours, both accept mail, and the
      // return value is true either way.
      await send({ ...BASIC, to: "test@example.com" });

      expect(payloads()[0]?.To).toBe("test@example.com");
    });

    it("is an exact, case-sensitive match", async () => {
      // Pinned rather than improved: === in both implementations. A
      // constituent typing "Test@Example.com" is NOT diverted and their
      // message goes to a real MP, which is the surprising half of this
      // behaviour and the half worth having written down.
      await send({ to: "mp@parliament.uk", subject: "s", textBody: "b", replyTo: "Test@Example.com" });
      await send({ to: "mp@parliament.uk", subject: "s", textBody: "b", replyTo: " test@example.com" });
      await send({ to: "mp@parliament.uk", subject: "s", textBody: "b", replyTo: "test@example.com " });
      await send({ to: "mp@parliament.uk", subject: "s", textBody: "b", replyTo: "test@example.com.evil.test" });
      await send({ to: "mp@parliament.uk", subject: "s", textBody: "b", replyTo: "nottest@example.com" });

      expect(payloads().map((p) => p.To)).toEqual([
        "mp@parliament.uk",
        "mp@parliament.uk",
        "mp@parliament.uk",
        "mp@parliament.uk",
        "mp@parliament.uk",
      ]);
    });

    it("does not fire when replyTo is absent", async () => {
      await send({ ...BASIC, to: "mp@parliament.uk" });

      expect(payloads()[0]?.To).toBe("mp@parliament.uk");
      expect(payloads()[0]?.ReplyTo).toBeNull();
    });
  });

  describe("when POSTMARK_TOKEN is missing", () => {
    it("returns false and makes no request at all", async () => {
      // The failure this whole tier is about. Django would still POST with a
      // None token and get a 401 back from Postmark; this port short-circuits,
      // so there is no HTTP status anywhere in the logs to notice -- only the
      // console line below. It is also the reason the boolean return exists.
      const logs = vi.spyOn(console, "log").mockImplementation(() => {});

      await expect(send(BASIC, { POSTMARK_TOKEN: undefined })).resolves.toBe(false);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(logs).toHaveBeenCalledTimes(1);
      expect(logs).toHaveBeenCalledWith("POSTMARK_TOKEN not set -- skipping email to mail@givefood.org.uk: Give Food - Flagged Page");
    });

    it("treats an empty-string token as missing", async () => {
      // wrangler's secret bindings surface a deleted secret as "" in some
      // paths and as undefined in others; both have to take the same branch or
      // half the deployments send a request with a blank token header.
      vi.spyOn(console, "log").mockImplementation(() => {});

      await expect(send(BASIC, { POSTMARK_TOKEN: "" })).resolves.toBe(false);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("logs at log level, not error level -- the failure is quiet by construction", async () => {
      // SUSPECT, PINNED AS-IS. Django logs this class of failure with
      // logging.error; here a missing credential is a console.log, one
      // severity below the console.error used for a rejected send. In Workers
      // observability that is the difference between showing up in an error
      // filter and not. Left alone because it is what ships, and because
      // routes/wfbn/updates.ts discards the boolean anyway -- but this is
      // precisely how a broken credential stayed invisible for a day.
      const logs = vi.spyOn(console, "log").mockImplementation(() => {});
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});

      await send(BASIC, { POSTMARK_TOKEN: undefined });

      expect(logs).toHaveBeenCalledTimes(1);
      expect(errors).not.toHaveBeenCalled();
    });

    it("names the ORIGINAL recipient in the log, not the diverted one", async () => {
      // The token check happens before the test@example.com rewrite, so the
      // skip line reports the MP's address even though a successful send would
      // have gone to the internal inbox. Asymmetric with the error path below,
      // which reports the diverted address. Pinned so anyone reading these two
      // log lines side by side knows the difference is real.
      const logs = vi.spyOn(console, "log").mockImplementation(() => {});

      await send({ ...BASIC, to: "mp@parliament.uk", replyTo: "test@example.com" }, { POSTMARK_TOKEN: undefined });

      expect(logs).toHaveBeenCalledWith("POSTMARK_TOKEN not set -- skipping email to mp@parliament.uk: Give Food - Flagged Page");
    });
  });

  describe("when Postmark rejects the send", () => {
    it("returns false on a 422 and logs the status and the body", async () => {
      // 422 is Postmark's inactive-recipient / bad-address answer and the most
      // likely real failure: the address came from a public text field.
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      respond = async () => new Response('{"ErrorCode":406,"Message":"Inactive recipient"}', { status: 422 });

      await expect(send({ ...BASIC, to: "bounced@example.org" })).resolves.toBe(false);

      // Status AND body, because the status alone does not say which of
      // Postmark's dozen ErrorCodes it was.
      expect(errors).toHaveBeenCalledWith('Failed to send email to bounced@example.org: 422 - {"ErrorCode":406,"Message":"Inactive recipient"}');
    });

    it("returns false on a 401, the shape a rotated-but-not-redeployed token takes", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      respond = async () => new Response("Unauthorized", { status: 401 });

      await expect(send(BASIC)).resolves.toBe(false);

      expect(errors).toHaveBeenCalledWith("Failed to send email to mail@givefood.org.uk: 401 - Unauthorized");
    });

    it("returns false on 2xx statuses that are not exactly 200", async () => {
      // The deliberate narrowness. Django checks `status_code == 200`, not
      // response.ok, and this port matched it rather than "improving" it, so a
      // 201 or 202 counts as a failure. Postmark answers 200 today; if it ever
      // answered 202 for a queued send, EVERY send would report false and
      // /write/ would tell every constituent their message failed while it was
      // in fact delivered. That is the risk this narrowness carries, and it is
      // asserted rather than left to be discovered.
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});

      for (const status of [201, 202, 204]) {
        respond = async () => new Response(status === 204 ? null : "queued", { status });
        await expect(send(BASIC)).resolves.toBe(false);
      }

      expect(errors).toHaveBeenCalledTimes(3);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("returns false on a 3xx redirect rather than following it anywhere useful", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      respond = async () => new Response("", { status: 302, headers: { Location: "https://elsewhere.example/" } });

      await expect(send(BASIC)).resolves.toBe(false);
      expect(errors).toHaveBeenCalledTimes(1);
    });

    it("returns false on a 500 and still makes only the one attempt", async () => {
      // No retry, no backoff, no queue. Worth pinning: someone reading
      // "returns false" could reasonably assume something retried.
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      respond = async () => new Response("upstream is unwell", { status: 500 });

      await expect(send(BASIC)).resolves.toBe(false);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(errors).toHaveBeenCalledTimes(1);
    });

    it("names the DIVERTED recipient in the error, matching Django", async () => {
      // Django's log line reads `to` after the rewrite (notifications.py:118
      // then :147), so a diverted send that fails is reported against
      // mail+testemail@. Same here.
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      respond = async () => new Response("nope", { status: 422 });

      await send({ ...BASIC, to: "mp@parliament.uk", replyTo: "test@example.com" });

      expect(errors).toHaveBeenCalledWith("Failed to send email to mail+testemail@givefood.org.uk: 422 - nope");
    });

    it("returns true on a 200 with a body that is not JSON at all", async () => {
      // Nothing parses the response. Pinned because it means an intercepting
      // proxy or a captive portal answering 200 with HTML reads as a
      // successful send -- the status is the entire success signal.
      respond = async () => new Response("<html>not postmark</html>", { status: 200 });

      await expect(send(BASIC)).resolves.toBe(true);
    });

    it("returns true on a 200 whose JSON reports an ErrorCode", async () => {
      // SUSPECT, PINNED AS-IS. Postmark can answer 200 with a per-message
      // error in a batch-ish response; both this port and Django look only at
      // the HTTP status, so such a send is reported as delivered.
      respond = async () => new Response('{"ErrorCode":300,"Message":"Invalid email request"}', { status: 200 });

      await expect(send(BASIC)).resolves.toBe(true);
    });
  });

  describe("when the request itself fails", () => {
    it("returns false instead of throwing when fetch rejects", async () => {
      // A DNS failure, a TLS error or a Workers subrequest-limit rejection all
      // land here. routes/write/index.ts awaits sendEmail() with no try around
      // it, so without this catch a network blip is a 500 on a form the
      // constituent has already typed a whole letter into.
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      respond = async () => {
        throw new TypeError("Network connection lost.");
      };

      await expect(send(BASIC)).resolves.toBe(false);

      expect(errors).toHaveBeenCalledWith("Failed to send email to mail@givefood.org.uk: TypeError: Network connection lost.");
    });

    it("stringifies a non-Error rejection rather than logging [object Object]-free nonsense", async () => {
      // String(err) on a thrown string gives the string; on a plain object it
      // gives "[object Object]". Both are pinned as the module's actual
      // behaviour, because the log line is the only artefact a failed send
      // leaves behind and its shape matters to whoever greps for it.
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});

      respond = async () => {
        throw "just a string";
      };
      await expect(send(BASIC)).resolves.toBe(false);
      expect(errors).toHaveBeenLastCalledWith("Failed to send email to mail@givefood.org.uk: just a string");

      respond = async () => {
        throw { code: 1 };
      };
      await expect(send(BASIC)).resolves.toBe(false);
      expect(errors).toHaveBeenLastCalledWith("Failed to send email to mail@givefood.org.uk: [object Object]");
    });

    it("returns false when reading the error body throws", async () => {
      // The `await response.text()` that builds the error message is INSIDE
      // the try, so a disconnected body on an already-failed response is
      // caught too and still returns false. Without that, a 422 whose body
      // could not be read would throw out of sendEmail() -- turning the
      // narrower of the two failure paths into a 500.
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      respond = async () => {
        const response = new Response("unreadable", { status: 422 });
        Object.defineProperty(response, "text", {
          value: () => Promise.reject(new Error("body stream disconnected")),
        });
        return response;
      };

      await expect(send(BASIC)).resolves.toBe(false);

      expect(errors).toHaveBeenCalledTimes(1);
      expect(errors).toHaveBeenCalledWith("Failed to send email to mail@givefood.org.uk: Error: body stream disconnected");
    });

    it("names the diverted recipient when the request fails too", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      respond = async () => {
        throw new Error("boom");
      };

      await send({ ...BASIC, to: "mp@parliament.uk", replyTo: "test@example.com" });

      expect(errors).toHaveBeenCalledWith("Failed to send email to mail+testemail@givefood.org.uk: Error: boom");
    });

    it("never rejects, whatever happens", async () => {
      // Stated once as the contract, over every failure mode this module has.
      // Four of the five call sites ignore the boolean; none of them catches.
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});

      const outcomes: boolean[] = [];
      outcomes.push(await send(BASIC, { POSTMARK_TOKEN: undefined }));
      respond = async () => {
        throw new Error("boom");
      };
      outcomes.push(await send(BASIC));
      respond = async () => new Response("nope", { status: 422 });
      outcomes.push(await send(BASIC));
      respond = async () => new Response("ok", { status: 200 });
      outcomes.push(await send(BASIC));

      expect(outcomes).toEqual([false, false, false, true]);
    });
  });
});
