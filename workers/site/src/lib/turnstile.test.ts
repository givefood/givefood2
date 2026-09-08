import { afterEach, describe, expect, it, vi } from "vitest";
import { validateTurnstile } from "./turnstile";

// lib/turnstile.ts is twenty lines and one fetch, which is exactly why it is
// worth pinning: it is the only thing standing between the four public POST
// forms (/register-foodbank/, /flag/, and gfwrite's two write endpoints) and a
// scripted flood, and every one of its failure modes is silent. A visitor who
// trips it is redirected to ?turnstilefail=true; the Workers log gets one line
// only when the secret is missing, and nothing at all when Cloudflare is
// unreachable or answers junk. Nobody watches a form that still renders, so a
// regression here is discovered when someone eventually reports that they
// cannot register their food bank.
//
// WHAT THIS FILE OWNS, AND WHAT IT DOES NOT. humanGate.test.ts and flag.test.ts
// already drive this function through real routes in the real app, and both
// assert the composition around it (CSRF first, the short-circuit, the redirect
// it produces). Repeating that here would only create a second copy to keep in
// step. What no other suite pins is the WIRE FORMAT and the exact decision
// boundary of the function itself -- what is POSTed, to whom, how the token is
// encoded, and precisely which response bodies count as a pass -- so that is
// what this file is about. Global fetch is the only thing stubbed, because
// siteverify is the only thing that leaves the machine; the stub builds a REAL
// Request out of the arguments it is handed, so every body and header asserted
// below is what the runtime would genuinely have put on the wire rather than a
// restatement of the source.
//
// MUTATION-TESTED, in a copy of the module outside the repo: sixteen mutants
// were tried and all sixteen were caught -- a JSON body, a template-string body
// (the field-smuggling one below), an added Authorization header, http:// for
// https://, GET for POST, "token" for "response", the two fields crossed,
// `!!data.success` for `=== true`, a substring match for a JSON parse,
// `secret === undefined` for `!secret`, the log line deleted, the early return
// deleted, a module-scope secret cache, a retry, an empty-token short-circuit,
// and `catch { return true }`.
//
// DJANGO PROVENANCE, read rather than assumed:
// givefood/utils/general.py:15-24 (foodcharity, this machine) is
//
//     turnstile_fields = {"secret": turnstile_secret, "response": turnstile_response}
//     turnstile_result = requests.post("https://challenges.cloudflare.com/turnstile/v0/siteverify", turnstile_fields)
//     return turnstile_result.json()["success"]
//
// A dict passed positionally to requests.post is form-encoded, so the two
// fields, their names, the method and the URL all match the port exactly. Three
// things differ, and each is asserted below as CURRENT PORT BEHAVIOUR:
//   1. Django reads the secret from get_cred("turnstile_secret") inside the
//      function; the port takes it as a parameter, because Workers forbid
//      reading bindings at module scope. There is no Django equivalent of the
//      unset-secret branch -- get_cred returning None would POST "None" as the
//      secret and get an ordinary false back.
//   2. `["success"]` raises KeyError on a body without the key (a 500 for the
//      visitor); `data.success === true` returns false (a redirect).
//   3. Django lets a truthy non-boolean through (`1`, `"true"`); the port
//      requires the JSON boolean.

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// Shaped like the real things: Turnstile secret keys are "0x" + hex-ish, and a
// widget response is a long dotted token full of the URL-unsafe characters that
// make the encoding assertions below meaningful.
const SECRET = "0x4AAAAAAAB1cdEfGhIjKlMn0pQrStUvWx";
const TOKEN = `0.${"Xk9d-_1aZ".repeat(12)}.1757097288.abcdef`;

interface Sent {
  /** The first argument exactly as the module passed it, before any normalisation. */
  rawUrl: string;
  method: string;
  headerNames: string[];
  contentType: string | null;
  /** The serialised request body -- what Cloudflare would actually receive. */
  body: string;
}

let sent: Sent[] = [];

type Responder = (form: URLSearchParams) => Response | Promise<Response>;

/**
 * Replaces global fetch with a recorder that materialises a real Request from
 * the (input, init) pair before answering.
 *
 * Going through `new Request(...)` rather than inspecting `init.body` directly
 * is the point of this helper: the module hands fetch a URLSearchParams object,
 * and it is the platform -- not the module -- that turns that into
 * `secret=...&response=...` with a form Content-Type. Asserting on the
 * materialised request is therefore the only way to test the thing Cloudflare
 * sees, and it is what catches a "harmless" switch to a JSON body or a
 * hand-built query string.
 */
function stubFetch(responder: Responder): void {
  sent = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const request = new Request(input as RequestInfo, init);
    const body = await request.text();
    sent.push({
      rawUrl,
      method: request.method,
      headerNames: [...request.headers.keys()],
      contentType: request.headers.get("Content-Type"),
      body,
    });
    // A subrequest to anywhere else is a bug of the most serious kind here --
    // this body carries a live secret -- so it fails the test rather than being
    // quietly answered.
    if (rawUrl !== SITEVERIFY) throw new Error(`unexpected fetch to ${rawUrl}`);
    return await responder(new URLSearchParams(body));
  });
}

/** siteverify's own success shape, complete with the fields it really returns. */
function verified(extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      success: true,
      // A Django-written timestamp sorts differently from toISOString(), and
      // Cloudflare sends the ISO form -- neither is read here, which is the
      // point: nothing but `success` is looked at.
      challenge_ts: "2026-09-05T19:28:08.853Z",
      hostname: "www.givefood.org.uk",
      ...extra,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** siteverify's refusal shape, with the error code it really sends. */
function refused(code = "invalid-input-response"): Response {
  return new Response(JSON.stringify({ success: false, "error-codes": [code] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The default stub: behaves like the real endpoint to the extent that matters
 * -- a non-empty token passes, an empty one is refused as
 * `missing-input-response`. A stub that waved everything through would let
 * "the fetch was deleted and the function returns true" look green.
 */
function stubRealistic(): void {
  stubFetch((form) => ((form.get("response") ?? "").length > 0 ? verified() : refused("missing-input-response")));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the request it puts on the wire", () => {
  it("form-POSTs exactly secret and response to Cloudflare's siteverify URL", async () => {
    // The whole contract in one assertion set. Every part of it has a way to go
    // wrong that nothing else would notice: a URL typo sends this deployment's
    // Turnstile secret to a host somebody else can register; a GET returns
    // Cloudflare's 405 page, which is not JSON, so every submission fails
    // closed and looks exactly like a site-wide bot attack; a JSON body gets
    // the same treatment. The exact body string is pinned because the field
    // NAMES are Cloudflare's ("response", not "token") and a rename is a
    // silent, permanent false.
    stubRealistic();
    expect(await validateTurnstile(SECRET, TOKEN)).toBe(true);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.rawUrl).toBe(SITEVERIFY);
    expect(sent[0]!.method).toBe("POST");
    expect(sent[0]!.body).toBe(`secret=${SECRET}&response=${encodeURIComponent(TOKEN)}`);
    const form = new URLSearchParams(sent[0]!.body);
    expect([...form.keys()]).toEqual(["secret", "response"]);
    expect(form.get("secret")).toBe(SECRET);
    expect(form.get("response")).toBe(TOKEN);
  });

  it("sends a form Content-Type and no other header at all", async () => {
    // siteverify accepts form or JSON and decides by Content-Type, so this
    // header is load-bearing even though the module never writes it -- it comes
    // from handing fetch a URLSearchParams. Django's requests.post with a dict
    // sends the same media type without the charset parameter
    // (givefood/utils/general.py:23); the parameter is ignored by the endpoint
    // and the difference is harmless, but it is written down here so that
    // "Django sends X, we send Y" is a recorded fact rather than a discovery.
    //
    // The header LIST is asserted because nothing else guards it: a future
    // "let's add an Authorization header" would put a Cloudflare API token on a
    // request that already carries the Turnstile secret, doubling the blast
    // radius of a wrong URL.
    stubRealistic();
    await validateTurnstile(SECRET, TOKEN);
    expect(sent[0]!.contentType).toBe("application/x-www-form-urlencoded;charset=UTF-8");
    expect(sent[0]!.headerNames).toEqual(["content-type"]);
  });

  it("percent-encodes a token, so no extra field can be smuggled into the body", async () => {
    // The reason URLSearchParams is the right tool and a template string is
    // not. `cf-turnstile-response` is an attacker-chosen field on a public
    // form; with `body: \`secret=${secret}&response=${token}\`` this token would
    // append a SECOND secret parameter. Cloudflare would then be validating
    // against whichever one its parser prefers -- an attacker-supplied secret
    // whose sitekey they control, which is a total bypass of the widget. The
    // assertions are on what arrives after form-decoding: one secret, ours, and
    // a response that is the entire hostile string taken literally.
    stubFetch(() => refused());
    const hostile = "0.token&secret=0xATTACKERKEY&response=solved";
    expect(await validateTurnstile(SECRET, hostile)).toBe(false);

    const form = new URLSearchParams(sent[0]!.body);
    expect(form.getAll("secret")).toEqual([SECRET]);
    expect(form.getAll("response")).toEqual([hostile]);
    expect(sent[0]!.body).toContain("%26secret%3D0xATTACKERKEY");
    expect(sent[0]!.body).not.toContain("&secret=0xATTACKERKEY");
  });

  it("round-trips separators and non-ASCII in either field", async () => {
    // The same encoding guarantee from the other side, and for the secret too:
    // a secret containing "+" that reached Cloudflare hand-encoded would arrive
    // as a space and fail every validation, with nothing but ?turnstilefail=true
    // to show for it. The emoji case guards the UTF-8 path -- a switch to
    // escape() or a hand-rolled encoder mangles astral characters silently.
    stubFetch(() => verified());
    const oddSecret = "0x+secret/with=odd&chars";
    const oddToken = "café 🍞/token+with=odd&chars";
    expect(await validateTurnstile(oddSecret, oddToken)).toBe(true);

    const form = new URLSearchParams(sent[0]!.body);
    expect(form.get("secret")).toBe(oddSecret);
    expect(form.get("response")).toBe(oddToken);
    // Form encoding, specifically: space is "+" here, not "%20".
    expect(sent[0]!.body).toContain("caf%C3%A9+%F0%9F%8D%9E");
  });

  it("relays an empty token to Cloudflare rather than short-circuiting it", async () => {
    // Deliberate, and documented as such by routes/public/flag.ts, whose header
    // comment cites this round-trip as a known cost of reusing this function:
    // a POST with no cf-turnstile-response at all still spends one subrequest.
    // A local `if (!token) return false` would be a defensible optimisation and
    // would also quietly falsify that note, so the current behaviour is pinned
    // rather than assumed.
    stubRealistic();
    expect(await validateTurnstile(SECRET, "")).toBe(false);
    expect(sent).toHaveLength(1);
    expect(new URLSearchParams(sent[0]!.body).get("response")).toBe("");
    expect(sent[0]!.body).toBe(`secret=${SECRET}&response=`);
  });

  it("asks exactly once per call and retries nothing", async () => {
    // Both directions of a would-be "just retry it" change. Turnstile tokens
    // are single-use: Cloudflare rejects a second siteverify for the same
    // token, so a retry on a refusal cannot turn a false into a true -- it can
    // only double the subrequest bill on precisely the traffic (bots) that is
    // already flooding the form.
    stubFetch(() => refused());
    expect(await validateTurnstile(SECRET, TOKEN)).toBe(false);
    expect(sent).toHaveLength(1);

    stubFetch(() => verified());
    expect(await validateTurnstile(SECRET, TOKEN)).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("uses the secret it was handed on every call, never a captured one", async () => {
    // The parameter exists because Workers forbid reading bindings at module
    // scope, and because production, the workers.dev preview and local dev each
    // run this same code with a different TURNSTILE_SECRET. A memoised
    // `let cached ??= secret` would work perfectly in dev and validate against
    // the wrong sitekey in exactly one environment -- so two calls with
    // different arguments must produce two different bodies.
    stubFetch(() => verified());
    await validateTurnstile("0xFIRST_DEPLOYMENT_SECRET", "token-one");
    await validateTurnstile("0xSECOND_DEPLOYMENT_SECRET", "token-two");

    expect(sent).toHaveLength(2);
    expect(sent[0]!.body).toBe("secret=0xFIRST_DEPLOYMENT_SECRET&response=token-one");
    expect(sent[1]!.body).toBe("secret=0xSECOND_DEPLOYMENT_SECRET&response=token-two");
  });

  it("keeps concurrent validations apart", async () => {
    // Two visitors submitting at the same instant share this module. Anything
    // held between the fetch and the parse -- a module-level "last token", a
    // cached Response -- would cross their answers, and the failure would be
    // load-dependent and unreproducible. Resolved out of order on purpose so a
    // shared slot would hand back the other visitor's verdict.
    const gates: Array<() => void> = [];
    stubFetch(async (form) => {
      const token = form.get("response") ?? "";
      await new Promise<void>((resolve) => gates.push(resolve));
      return token === "good-token" ? verified() : refused();
    });

    const good = validateTurnstile(SECRET, "good-token");
    const bad = validateTurnstile(SECRET, "bad-token");
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates[1]!(); // the second caller's siteverify answers first
    gates[0]!();

    expect(await good).toBe(true);
    expect(await bad).toBe(false);
  });
});

describe("what counts as a pass", () => {
  it("accepts the boolean true, whatever else the body carries", async () => {
    // Cloudflare adds fields to this response over time (challenge_ts,
    // hostname, action, cdata, metadata). Reading only `success` is what keeps
    // that from breaking the site, and this pins it -- including the perverse
    // case of a body carrying both success:true and error-codes, which the
    // module ignores.
    stubFetch(() => verified());
    expect(await validateTurnstile(SECRET, TOKEN)).toBe(true);

    stubFetch(() => verified({ action: "register", cdata: "abc", "error-codes": [] }));
    expect(await validateTurnstile(SECRET, TOKEN)).toBe(true);

    stubFetch(() => verified({ "error-codes": ["invalid-input-response"] }));
    expect(await validateTurnstile(SECRET, TOKEN)).toBe(true);

    // The minimum: nothing but the flag.
    stubFetch(() => new Response('{"success":true}'));
    expect(await validateTurnstile(SECRET, TOKEN)).toBe(true);
  });

  it("requires the JSON boolean true, not merely something truthy", async () => {
    // `data.success === true`, and this is where the port DIVERGES from Django,
    // which returns `turnstile_result.json()["success"]` raw
    // (givefood/utils/general.py:24): under Django a JSON 1 or "true" would
    // pass, and a body with no `success` key would raise KeyError and 500 the
    // visitor instead of redirecting them. Cloudflare sends a real boolean, so
    // no live response is affected either way -- the strictness matters if the
    // endpoint is ever proxied, mocked in a staging environment, or answered by
    // an interception page. Pinned as the port's behaviour, and asserted to
    // still cost exactly one subrequest so a "reject before asking" shortcut
    // cannot creep in through this door.
    for (const body of [
      '{"success":"true"}', // a string, which is truthy in both languages
      '{"success":1}', // Django would pass this
      '{"success":"TRUE"}',
      '{"success":[true]}',
      '{"success":{"value":true}}',
      '{"success":null}',
      '{"success":false}',
      "{}", // Django raises KeyError here; the port returns false
      '{"Success":true}', // case matters
      '{"succeeded":true}',
      "[]",
      '[{"success":true}]', // the flag one level down is not read
      '"success"',
      "123",
      "true", // a bare true is not an object with a success property
      // Proof that the body is JSON-PARSED rather than substring-matched: this
      // one contains the exact characters "success":true and must still fail.
      '{"detail":"\\"success\\":true"}',
    ]) {
      stubFetch(() => new Response(body));
      expect(await validateTurnstile(SECRET, TOKEN), body).toBe(false);
      expect(sent, body).toHaveLength(1);
    }
  });

  it("looks only at the parsed body -- not the HTTP status, not the Content-Type", async () => {
    // Documented, not endorsed. `response.ok` is never checked, so a 500 or a
    // 403 carrying {"success":true} is accepted, and a JSON body labelled
    // text/html is parsed anyway. lib/email.ts takes the opposite line for
    // Postmark (an exact status === 200 check, following Django), so the
    // inconsistency between the two outbound calls is worth having written
    // down. Cloudflare does not currently answer 500 with a success body; if it
    // ever did, this is the line that would decide whether bots get in.
    for (const status of [200, 201, 400, 403, 429, 500, 502]) {
      stubFetch(() => new Response('{"success":true}', { status }));
      expect(await validateTurnstile(SECRET, TOKEN), `status ${status}`).toBe(true);
    }

    stubFetch(() => new Response('{"success":true}', { headers: { "Content-Type": "text/html; charset=utf-8" } }));
    expect(await validateTurnstile(SECRET, TOKEN)).toBe(true);

    // ...and the converse, so the loop above cannot be satisfied by a function
    // that just returns true: a perfectly healthy 200 that says no is a no.
    stubFetch(() => refused());
    expect(await validateTurnstile(SECRET, TOKEN)).toBe(false);
  });
});

describe("failing closed when Cloudflare cannot answer", () => {
  it("returns false for a network error, a junk body, or a body it cannot parse", async () => {
    // The `catch { return false }`. Each of these is a real incident shape: a
    // subrequest-limit or DNS failure (fetch rejects), an edge error page
    // (HTML, not JSON), a truncated response, an empty 204. All of them mean
    // "no visitor can submit any of the four protected forms until Cloudflare
    // recovers", and the only visible symptom is ?turnstilefail=true, which
    // reads to a user as "you failed the CAPTCHA". Failing closed is the right
    // call for a bot gate; the point of pinning it is that the choice stays
    // deliberate.
    const cases: Array<[string, Responder]> = [
      [
        "fetch rejects",
        () => {
          throw new TypeError("Network connection lost.");
        },
      ],
      [
        "the subrequest limit is hit",
        () => {
          throw new Error("Too many subrequests.");
        },
      ],
      ["an HTML edge error page", () => new Response("<!DOCTYPE html><title>502 Bad Gateway</title>", { status: 502 })],
      ["an empty 200 body", () => new Response("", { status: 200 })],
      ["a 204 with no body at all", () => new Response(null, { status: 204 })],
      ["a plain-text body", () => new Response("not json at all")],
      ["truncated JSON", () => new Response('{"success":true')],
      // json() resolves to null, and reading .success off it throws a
      // TypeError inside the try -- so this lands in the same catch rather than
      // becoming a 500 on a public form.
      ["a bare JSON null", () => new Response("null")],
    ];

    for (const [label, responder] of cases) {
      stubFetch(responder);
      expect(await validateTurnstile(SECRET, TOKEN), label).toBe(false);
      expect(sent, label).toHaveLength(1);
    }
  });

  it("logs NOTHING when siteverify fails, which is how an outage stays invisible", async () => {
    // Current behaviour, pinned because it is the exact failure class this
    // port keeps being bitten by: the bare `catch` swallows the error object
    // entirely, so a Cloudflare outage, a bad TLS handshake or a body change
    // produces no log line, no metric and no difference from a bot being turned
    // away. The unset-secret branch below logs precisely because someone
    // decided that particular silence was unacceptable; this branch was left
    // silent. Reported as suspect rather than fixed.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      stubFetch(() => {
        throw new TypeError("Network connection lost.");
      });
      expect(await validateTurnstile(SECRET, TOKEN)).toBe(false);
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();

      // Nor on an ordinary refusal, which is correct -- a bot being blocked is
      // not an event worth a log line per attempt.
      stubFetch(() => refused());
      expect(await validateTurnstile(SECRET, TOKEN)).toBe(false);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it("never rejects, whatever the token is", async () => {
    // Every caller does `if (!turnstileOk) return c.redirect(...)` with no
    // try/catch anywhere. A thrown error would therefore become an
    // attacker-triggerable 500 on a public form, from input the attacker fully
    // controls -- so "always resolves to a boolean" is the property the routes
    // actually depend on. The oversized token is the interesting one: it is a
    // megabyte of body that the module will happily try to POST.
    stubFetch(() => refused());
    for (const token of [
      "",
      " ",
      "\0",
      "\r\n",
      "%%%",
      "🍞".repeat(100),
      "z".repeat(1_000_000),
      "-".repeat(64),
    ]) {
      const result = await validateTurnstile(SECRET, token);
      expect(typeof result, JSON.stringify(token.slice(0, 20))).toBe("boolean");
      expect(result, JSON.stringify(token.slice(0, 20))).toBe(false);
    }
  });
});

describe("the unset secret", () => {
  it("fails closed without a subrequest, and says so in the log", async () => {
    // The one failure this module refuses to keep quiet about, and the reason
    // is in its own comment: without the log line an unset TURNSTILE_SECRET is
    // indistinguishable in the Workers dashboard from real visitors submitting
    // bad tokens, so the site looks like it is under attack while actually
    // being misconfigured. That is not hypothetical here -- this deployment's
    // secrets are pushed from Django's GfCredential table by a script, so a
    // missed name is exactly how this branch gets taken.
    //
    // Both falsy shapes are covered: an absent binding (undefined) and an empty
    // one, which is what `wrangler secret put` with an empty value or a bare
    // `TURNSTILE_SECRET=` line in .dev.vars produces. `!secret` treats them the
    // same; a switch to `secret === undefined` would POST an empty secret to
    // Cloudflare instead, turning a logged misconfiguration into a silent one.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      for (const missing of [undefined, ""]) {
        stubRealistic();
        log.mockClear();
        expect(await validateTurnstile(missing, TOKEN)).toBe(false);
        // No secret means no possible pass, so paying Cloudflare for an answer
        // nobody can act on would be pure waste -- and on a form under attack
        // it would be a subrequest per hostile POST.
        expect(sent).toEqual([]);
        expect(log).toHaveBeenCalledTimes(1);
        // The exact string, because its value is being greppable: the message
        // has to name the binding a human then has to go and set. "Turnstile
        // validation failed" would be true and useless.
        expect(log.mock.calls[0]).toEqual(["TURNSTILE_SECRET not set -- failing validation closed"]);
      }
    } finally {
      log.mockRestore();
    }
  });

  it("treats a whitespace-only secret as set and sends it", async () => {
    // A gap in `!secret`, pinned as current behaviour and flagged as suspect: a
    // secret of " " (a stray space in a secrets file) is truthy, so it takes
    // the normal path, gets POSTed, and comes back as an ordinary
    // invalid-input-secret refusal with no log line -- i.e. the precise
    // invisible misconfiguration the branch above exists to prevent, reachable
    // by a single typo.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      stubFetch(() => new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-secret"] })));
      expect(await validateTurnstile("   ", TOKEN)).toBe(false);
      expect(sent).toHaveLength(1);
      expect(new URLSearchParams(sent[0]!.body).get("secret")).toBe("   ");
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("checks the secret before touching the token, so nothing about the token matters", async () => {
    // The early return is unconditional on the token: a valid widget response
    // still fails when the binding is missing. Worth its own case because the
    // support report is always "the CAPTCHA is broken for everyone", and this
    // is the assertion that says the token was never even looked at.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      stubFetch(() => verified());
      expect(await validateTurnstile(undefined, TOKEN)).toBe(false);
      expect(await validateTurnstile(undefined, "")).toBe(false);
      expect(sent).toEqual([]);
      expect(log).toHaveBeenCalledTimes(2);
    } finally {
      log.mockRestore();
    }
  });

  it("does not leak the secret anywhere but the siteverify body", async () => {
    // The secret appears in exactly one place: the POST body to
    // challenges.cloudflare.com. Not in the URL (query strings end up in logs
    // and in Cloudflare's own analytics), and not in the log line -- the
    // unset-secret message names the BINDING, never a value, so it stays safe
    // to read in a shared dashboard.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      stubFetch(() => verified());
      await validateTurnstile(SECRET, TOKEN);
      expect(sent[0]!.rawUrl).not.toContain(SECRET);
      expect(sent[0]!.rawUrl).toBe(SITEVERIFY); // no query string at all
      expect(log).not.toHaveBeenCalled();

      log.mockClear();
      await validateTurnstile(undefined, TOKEN);
      expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
    } finally {
      log.mockRestore();
    }
  });
});
