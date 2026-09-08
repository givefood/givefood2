import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import { verifyHumanGate } from "./humanGate";
import { hmacSha256Hex } from "../../lib/hmac";
import type { AppEnv } from "../../types";
import type { Env } from "../../../worker-configuration";

// humanGate.ts is five lines long and owns no logic of its own -- which is
// exactly why it needs its own suite. Everything that can go wrong here is a
// property of the COMPOSITION rather than of either half:
//
//   1. IT IS AN AND. Both checks must pass. A refactor that returns the
//      Turnstile result regardless of CSRF, or vice versa, leaves both
//      imported functions untouched and every one of their own tests green.
//   2. THE ORDER IS LOAD-BEARING, and the module's header comment says why:
//      verifyCsrf() is local HMAC arithmetic, validateTurnstile() is a real
//      subrequest to Cloudflare. A stale tab, a replay, or a bot POSTing
//      straight at /register-foodbank/ without going through /human/ must be
//      rejected without paying for that round-trip. Swapping the two lines
//      changes no answer -- only the bill and the latency -- so nothing but a
//      "siteverify was never called" assertion can catch it. Most of the
//      rejection tests below therefore assert `outbound` is EMPTY, not merely
//      that the gate said false.
//   3. THE TWO SECRETS MUST NOT BE CROSSED. c.env.CSRF_SECRET goes to
//      verifyCsrf, c.env.TURNSTILE_SECRET to validateTurnstile. Passing the
//      wrong one still typechecks (both are `string | undefined`) and still
//      returns a boolean; it just means every submission fails, or -- worse --
//      that the CSRF secret is POSTed to a third party.
//
// REAL EVERYTHING BUT THE NETWORK. The gate runs inside a real Hono app on a
// real Request, so `body` is what `c.req.parseBody()` genuinely produces
// (including a File for a multipart part), and both halves are the real
// lib/csrf.ts and lib/turnstile.ts. Only global fetch is stubbed, because
// siteverify and Postmark are the only things that leave the machine. That
// matters twice over: lib/turnstile.ts has NO test file of its own (TESTING.md
// lists it as excluded), so this suite is currently the only place its
// behaviour -- the `success === true` strictness, the fail-closed catch, the
// unset-secret log -- is exercised at all.
//
// DJANGO PROVENANCE, checked rather than assumed. The Turnstile half is a
// faithful port of givefood/utils/general.py:15-24's validate_turnstile().
// The CSRF half has no upstream: register_foodbank (givefood/views.py:451) is
// decorated @anonymous_csrf, and the vendored copy of that decorator
// (.venv/lib/python3.12/site-packages/session_csrf/__init__.py:144-166) only
// ISSUES a token -- it sets an anon cookie and stashes request.csrf_token, and
// nothing in it validates anything. Validation lives in
// session_csrf.CsrfMiddleware, which is NOT in settings.py's MIDDLEWARE (the
// project's own givefood/checks.py:7 raises a system check complaining about
// precisely that, and Django's CsrfViewMiddleware is commented out at
// settings.py:97). So the live site validates no CSRF token on this form at
// all. humanGate.ts's own header ("this port's own addition") is right;
// registerFoodbank.ts:17-19's "Django's real view already has real CSRF
// (@anonymous_csrf) ... ported as-is" overstates it. There is therefore no
// production behaviour to compare the CSRF half against, and these tests are
// its only specification.

const CSRF_SECRET = "human-gate-csrf-secret";
const TURNSTILE_SECRET = "human-gate-turnstile-secret";
const ORIGIN = "https://www.givefood.org.uk";
const PAGE = `${ORIGIN}/register-foodbank/`;
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const POSTMARK = "https://api.postmarkapp.com/email";

// The shape issueCsrfToken() actually mints: randomHex(32), so 64 lowercase
// hex characters. Using a realistic value rather than "a".repeat(64) keeps the
// duplicate-field and prefix cases below honest about what they are comparing.
const RAW = "3f8c1d2e".repeat(8);

// Hono's fetch() wants an ExecutionContext; nothing under test touches it.
const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function envWith(overrides: Record<string, string | undefined> = {}): Env {
  return { CSRF_SECRET, TURNSTILE_SECRET, POSTMARK_TOKEN: "test-postmark-token", ...overrides } as unknown as Env;
}

// Cookies here are signed with the module's own hmacSha256Hex, deliberately:
// this suite is about how the gate composes its two halves, and
// lib/csrf.test.ts already pins the signature itself against an independent
// RFC 4231 vector. Duplicating that oracle here would only add a second copy
// to keep in step.
async function signedCookie(raw: string, secret = CSRF_SECRET): Promise<string> {
  return `__Host-csrf=${raw}.${await hmacSha256Hex(secret, raw)}`;
}

interface Outbound {
  url: string;
  method: string;
  body: string;
}

let outbound: Outbound[] = [];

/**
 * Stubs the network and records every request, so tests can assert on what
 * was SENT -- and, more often, on what was NOT sent, which is the only way to
 * see the CSRF-before-Turnstile ordering.
 *
 * An empty token is always rejected regardless of `success`, because that is
 * what the real endpoint does (`missing-input-response`). A stub that waved
 * an empty token through would let "the Turnstile check was deleted
 * altogether" pass as a green run.
 */
function stubFetch(options: { success?: boolean; rawBody?: string; status?: number; networkError?: boolean; postmarkOk?: boolean } = {}) {
  outbound = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "";
    outbound.push({ url, method: init?.method ?? "GET", body });
    if (url === POSTMARK) return new Response("{}", { status: options.postmarkOk === false ? 422 : 200 });
    // Anything else is a subrequest this module has no business making, and
    // must fail the test loudly rather than being silently answered.
    if (url !== SITEVERIFY) throw new Error(`unexpected fetch to ${url}`);
    if (options.networkError) throw new TypeError("Network connection lost.");
    if (options.rawBody !== undefined) return new Response(options.rawBody, { status: options.status ?? 200 });
    const submitted = new URLSearchParams(body).get("response") ?? "";
    if ((options.success ?? true) && submitted.length > 0) return new Response(JSON.stringify({ success: true }), { status: 200 });
    return new Response(JSON.stringify({ success: false, "error-codes": [submitted ? "invalid-input-response" : "missing-input-response"] }), { status: 200 });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

interface GateOptions {
  fields?: Record<string, string>;
  formData?: FormData;
  cookie?: string;
  headers?: Record<string, string>;
  env?: Env;
  url?: string;
}

/**
 * Runs verifyHumanGate() the way registerFoodbank.ts does -- on the result of
 * a real `c.req.parseBody()` inside a real Hono app -- and returns its answer.
 *
 * The boolean travels back as the response body, and anything else is turned
 * into a thrown error: the gate is reached with entirely attacker-chosen input
 * (the Cookie header, every posted field), and its only caller treats a false
 * as a redirect. A throw would turn that into an attacker-triggerable 500, so
 * "returns a boolean, never throws" is enforced on EVERY call in this file
 * rather than in one test of its own.
 */
async function gate(options: GateOptions = {}): Promise<boolean> {
  const local = new Hono<AppEnv>();
  local.post("*", async (c) => {
    const body = await c.req.parseBody();
    return c.text(String(await verifyHumanGate(c, body)));
  });

  const headers = new Headers(options.headers ?? {});
  if (options.cookie !== undefined) headers.set("Cookie", options.cookie);
  let body: BodyInit;
  if (options.formData) {
    body = options.formData; // Request sets the multipart boundary itself
  } else {
    headers.set("Content-Type", "application/x-www-form-urlencoded");
    body = new URLSearchParams(options.fields ?? {}).toString();
  }

  const res = await local.fetch(new Request(options.url ?? PAGE, { method: "POST", headers, body }), options.env ?? envWith(), execCtx);
  const text = await res.text();
  if (text !== "true" && text !== "false") throw new Error(`verifyHumanGate did not return a boolean (status ${res.status}): ${text}`);
  return text === "true";
}

/**
 * A submission in exactly the shape the site produces: the visitor's form
 * POSTs to /human/, which re-emits every field as a hidden input (csrf_token
 * included) and auto-submits at the real target once the Turnstile widget
 * fires -- so the second POST carries the form's own fields, the csrf_token
 * minted when the page rendered, and cf-turnstile-response, with the
 * __Host-csrf cookie riding along and same-origin fetch metadata.
 */
async function relayed(overrides: GateOptions = {}): Promise<boolean> {
  return gate({
    cookie: await signedCookie(RAW),
    fields: { csrf_token: RAW, "cf-turnstile-response": "widget-token", name: "Sid Valley Food Bank" },
    headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
    ...overrides,
  });
}

describe("verifyHumanGate -- the submission the relay actually produces", () => {
  it("passes it, and asks Cloudflare exactly once with the right secret", async () => {
    // The positive direction, which every other test here is silent about: a
    // gate that rejected everything would satisfy all the rejection tests and
    // simply make the food bank registration form unusable, with the visitor
    // sent to ?turnstilefail=true and everything they typed discarded.
    stubFetch();
    expect(await relayed()).toBe(true);

    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.url).toBe(SITEVERIFY);
    expect(outbound[0]!.method).toBe("POST");
    const sent = new URLSearchParams(outbound[0]!.body);
    // The secret is the TURNSTILE one and the response is the widget's token
    // -- the argument order of validateTurnstile(secret, token). Both
    // parameters are `string | undefined`, so crossing them typechecks
    // cleanly, returns a perfectly ordinary false, and POSTs this
    // deployment's CSRF secret to a third party.
    expect(sent.get("secret")).toBe(TURNSTILE_SECRET);
    expect(sent.get("response")).toBe("widget-token");
    expect(outbound[0]!.body).not.toContain(CSRF_SECRET);
    // Nothing else from the form is forwarded to Cloudflare -- the registrant's
    // name and address are not Cloudflare's business.
    expect(sent.get("name")).toBeNull();
    expect([...sent.keys()].sort()).toEqual(["response", "secret"]);
  });

  it("reads both secrets from this request's env rather than a captured value", async () => {
    // The Worker runs the same code for production, the workers.dev preview
    // and local dev, each with its own secrets, and Workers forbid reading
    // bindings at module scope anyway. A hoisted `const secret = env.X` would
    // work in dev and fail in exactly one environment.
    stubFetch();
    const other = envWith({ CSRF_SECRET: "second-deployment-csrf", TURNSTILE_SECRET: "second-deployment-turnstile" });

    // The cookie is signed with the DEFAULT env's secret, so under `other` the
    // CSRF half must fail -- and fail before siteverify, as ever.
    expect(await relayed({ env: other })).toBe(false);
    expect(outbound).toEqual([]);

    // Re-signed for `other`, the same submission passes, and Cloudflare is
    // handed that env's Turnstile secret and not the default one.
    expect(await relayed({ env: other, cookie: await signedCookie(RAW, "second-deployment-csrf") })).toBe(true);
    expect(outbound).toHaveLength(1);
    expect(new URLSearchParams(outbound[0]!.body).get("secret")).toBe("second-deployment-turnstile");
  });

  it("verifies without minting, so a form open in another tab keeps working", async () => {
    // The gate must never call issueCsrfToken(). Doing so would rotate the
    // __Host-csrf cookie on a POST, invalidating the token already rendered
    // into every other open admin/registration page -- the two-tab 403 that
    // lib/csrf.ts's header comment describes at length, reintroduced from the
    // verification side. `csrfIssued` is checked too because that is the flag
    // middleware/pageCacheControl.ts reads: a response wrongly carrying it is
    // pushed out of the shared cache for no reason.
    stubFetch();
    const local = new Hono<AppEnv>();
    local.post("*", async (c) => {
      const body = await c.req.parseBody();
      const passed = await verifyHumanGate(c, body);
      return c.text(`${passed} ${String(c.get("csrfIssued"))}`);
    });
    const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded", Cookie: await signedCookie(RAW) });
    const res = await local.fetch(
      new Request(PAGE, { method: "POST", headers, body: new URLSearchParams({ csrf_token: RAW, "cf-turnstile-response": "widget-token" }).toString() }),
      envWith(),
      execCtx,
    );

    expect(await res.text()).toBe("true undefined");
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe("the CSRF half runs first, and its failures cost no subrequest", () => {
  it("rejects every shape of CSRF failure without calling siteverify", async () => {
    // Each case carries a VALID Turnstile token, so the only thing that can
    // produce a false is the CSRF half -- and the empty `outbound` is what
    // proves the short-circuit the module's header comment promises. Without
    // it, a bot posting straight at /register-foodbank/ in a loop would spend
    // one Cloudflare subrequest per attempt, and the gate would still answer
    // false, so nothing else in this file would notice.
    const cases: Array<[string, GateOptions]> = [
      // A bot POSTing directly, never having loaded the page: no cookie.
      ["no cookie at all", { cookie: undefined }],
      // CSRF_SECRET rotated between the render and the submit.
      ["cookie signed with a rotated-away secret", { cookie: await signedCookie(RAW, "the-previous-secret") }],
      // A sibling subdomain can write a __Host-csrf-named cookie (the prefix
      // binds the setter, not what arrives) but cannot sign one.
      ["cookie with a forged signature", { cookie: `__Host-csrf=${RAW}.${"0".repeat(64)}` }],
      ["cookie with no signature separator", { cookie: `__Host-csrf=${RAW}` }],
      ["cookie name matched only as a substring", { cookie: `evil__Host-csrf=${RAW}.${"0".repeat(64)}` }],
      // The relay dropped the field, or the form never had one.
      ["no csrf_token field", { fields: { "cf-turnstile-response": "widget-token" } }],
      // What /flag/'s template now sends after issue #40 -- and the reason
      // flag.ts had to stop calling this function rather than relax it.
      ["an empty csrf_token field", { fields: { csrf_token: "", "cf-turnstile-response": "widget-token" } }],
      // A token from a different session: the double-submit binding.
      ["a csrf_token belonging to a different cookie", { fields: { csrf_token: "9e".repeat(32), "cf-turnstile-response": "widget-token" } }],
      ["a truncated csrf_token", { fields: { csrf_token: RAW.slice(0, 63), "cf-turnstile-response": "widget-token" } }],
      // The classic cross-site POST, with the cookie riding along.
      ["a cross-site Origin", { headers: { Origin: "https://evil.example" } }],
      ["Sec-Fetch-Site: cross-site", { headers: { "Sec-Fetch-Site": "cross-site" } }],
      // `same-site` is a sibling subdomain -- exactly the position the signed
      // cookie exists to defend against, so it is rejected too.
      ["Sec-Fetch-Site: same-site", { headers: { "Sec-Fetch-Site": "same-site" } }],
    ];

    for (const [label, options] of cases) {
      stubFetch();
      expect(await relayed(options), label).toBe(false);
      expect(outbound, `${label} must not reach siteverify`).toEqual([]);
    }
  });

  it("rejects a multipart submission whose csrf_token is a File", async () => {
    // `typeof body.csrf_token === "string"` is the guard. parseBody yields a
    // File for a multipart file part, and anyone can post multipart at this
    // route, so this is attacker-reachable input: it has to come back as a
    // plain false (a redirect) and not as a 500 from something calling
    // .length or charCodeAt on a File. It also stays on the cheap side of the
    // gate -- no subrequest.
    //
    // Honest note on what this test can and cannot catch: replacing the guard
    // with `body.csrf_token as string` was mutation-tested and SURVIVED, and
    // it survives for a real reason rather than a gap here -- a File has no
    // .length, so timingSafeEqual's length check rejects it one step later and
    // the answer is identical. The guard is defence in depth (nothing
    // non-string ever reaches charCodeAt), so this test pins the OUTCOME the
    // route depends on and does not pretend to pin the line that produces it.
    stubFetch();
    const form = new FormData();
    form.set("csrf_token", new File([RAW], "token.txt", { type: "text/plain" }));
    form.set("cf-turnstile-response", "widget-token");
    expect(await gate({ formData: form, cookie: await signedCookie(RAW) })).toBe(false);
    expect(outbound).toEqual([]);
  });

  it("takes the LAST csrf_token when a field arrives twice", async () => {
    // Reachable in production: /human/ re-emits every posted field as a hidden
    // input, so a form that already carried csrf_token can arrive with two.
    // Hono's parseBody keeps the last occurrence (measured here, not assumed
    // -- swap the pair and the answers swap with it), which means an injected
    // duplicate can only REPLACE the token with one that then has to match the
    // victim's HttpOnly cookie. Pinned because a Hono change to first-wins
    // would silently flip both answers, and one of those directions is the
    // one that fails open.
    stubFetch();
    const valid = `csrf_token=${RAW}`;
    const junk = `csrf_token=${"9e".repeat(32)}`;
    const cookie = await signedCookie(RAW);
    const turnstile = "cf-turnstile-response=widget-token";

    const localApp = new Hono<AppEnv>();
    localApp.post("*", async (c) => c.text(String(await verifyHumanGate(c, await c.req.parseBody()))));
    const send = async (rawBody: string) => {
      const res = await localApp.fetch(
        new Request(PAGE, { method: "POST", headers: new Headers({ "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie }), body: rawBody }),
        envWith(),
        execCtx,
      );
      return (await res.text()) === "true";
    };

    expect(await send(`${valid}&${junk}&${turnstile}`)).toBe(false); // junk last wins
    expect(await send(`${junk}&${valid}&${turnstile}`)).toBe(true); // genuine last wins
  });
});

describe("the Turnstile half, once CSRF has passed", () => {
  it("rejects a token Cloudflare refuses, having genuinely asked", async () => {
    // The mirror of the ordering tests above: here the subrequest MUST have
    // happened. A "clever" refactor that trusted the CSRF token as proof of
    // humanity would pass every rejection test in the file above and reopen
    // the form to unlimited automated abuse -- Turnstile is the only thing
    // standing between /register-foodbank/ and a scripted flood, because the
    // CSRF token is handed out freely to anyone who loads the page.
    stubFetch({ success: false });
    expect(await relayed()).toBe(false);
    expect(outbound).toHaveLength(1);
    expect(new URLSearchParams(outbound[0]!.body).get("response")).toBe("widget-token");
  });

  it("relays a missing token to Cloudflare rather than short-circuiting it", async () => {
    // `typeof ... === "string" ? ... : ""`, then straight to siteverify: the
    // gate has no local empty-token shortcut, so an absent field costs one
    // subrequest and is refused by Cloudflare (missing-input-response). Worth
    // pinning because routes/public/flag.ts's header comment cites this exact
    // cost as a known, deliberately-kept property of this function, and a
    // local shortcut added here would quietly falsify that note.
    stubFetch();
    expect(await relayed({ fields: { csrf_token: RAW } })).toBe(false);
    expect(outbound).toHaveLength(1);
    expect(new URLSearchParams(outbound[0]!.body).get("response")).toBe("");

    // A File-valued part takes the same route: coerced to "", not stringified
    // into something like "[object File]" that Cloudflare would see as a real
    // (invalid) token.
    stubFetch();
    const form = new FormData();
    form.set("csrf_token", RAW);
    form.set("cf-turnstile-response", new File(["widget-token"], "t.txt", { type: "text/plain" }));
    expect(await gate({ formData: form, cookie: await signedCookie(RAW) })).toBe(false);
    expect(outbound).toHaveLength(1);
    expect(new URLSearchParams(outbound[0]!.body).get("response")).toBe("");
  });

  it("requires success to be the boolean true, not merely truthy", async () => {
    // `data.success === true`. Cloudflare only ever sends a JSON boolean, so
    // no real response is affected -- but this is where the port diverges from
    // Django, which returns `turnstile_result.json()["success"]` raw
    // (givefood/utils/general.py:24) and would therefore treat a JSON 1 or
    // "true" as a pass and raise KeyError on a body with no `success` key.
    // Strict equality is the safer of the two and is what is pinned.
    for (const rawBody of ['{"success":"true"}', '{"success":1}', '{"success":null}', "{}", '{"success":false}', "[]", '{"Success":true}']) {
      stubFetch({ rawBody });
      expect(await relayed(), rawBody).toBe(false);
      expect(outbound, rawBody).toHaveLength(1);
    }
    // ...and the one body that does pass, so the loop above cannot be
    // satisfied by a gate that rejects unconditionally.
    stubFetch({ rawBody: '{"success":true,"challenge_ts":"2026-09-05T19:28:08.853Z","hostname":"www.givefood.org.uk"}' });
    expect(await relayed()).toBe(true);
  });

  it("fails closed when siteverify errors, times out, or answers with junk", async () => {
    // validateTurnstile()'s bare `catch { return false }` plus a non-JSON
    // body. Every one of these means "no registration can be submitted, site
    // wide, until Cloudflare recovers", with the visitor told only
    // ?turnstilefail=true -- the invisible-failure class this port keeps
    // running into. Pinned as CURRENT BEHAVIOUR, not endorsed: failing closed
    // on an outage is the right call for a CAPTCHA, but the silence around it
    // is why an incident here is measured in hours.
    for (const options of [
      { networkError: true }, // fetch() rejects: DNS, TLS, subrequest limit
      { rawBody: "<!DOCTYPE html><title>502 Bad Gateway</title>", status: 502 }, // an edge error page, not JSON
      { rawBody: "", status: 200 }, // empty body: response.json() throws
      { rawBody: "not json at all", status: 200 },
      { rawBody: '{"success":true', status: 200 }, // truncated JSON
    ]) {
      stubFetch(options);
      expect(await relayed(), JSON.stringify(options)).toBe(false);
      expect(outbound, JSON.stringify(options)).toHaveLength(1);
    }
  });

  it("ignores the HTTP status when the body parses and says success", async () => {
    // Documents current behaviour rather than approving of it: validateTurnstile
    // never looks at response.ok, so a 500 carrying `{"success":true}` is
    // accepted. Cloudflare does not do this, and lib/email.ts's sendEmail
    // takes the opposite line (an exact `status === 200` check, following
    // Django), so the inconsistency is worth having written down somewhere.
    stubFetch({ rawBody: '{"success":true}', status: 500 });
    expect(await relayed()).toBe(true);
  });
});

describe("unset secrets", () => {
  it("rejects and logs when CSRF_SECRET is unset, before any subrequest", async () => {
    // Fail-closed with a breadcrumb. A deployment missing this binding rejects
    // every registration, and the log line is the only thing that points at
    // the secret rather than at the form or at Turnstile -- which is the whole
    // reason lib/csrf.ts and lib/turnstile.ts both log rather than returning a
    // quiet false.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      for (const missing of [undefined, ""]) {
        stubFetch();
        log.mockClear();
        expect(await relayed({ env: envWith({ CSRF_SECRET: missing }) })).toBe(false);
        expect(log).toHaveBeenCalledTimes(1);
        expect(log.mock.calls[0]?.[0]).toContain("CSRF_SECRET not set");
        // The failure is free: no secret means no possible pass, so paying
        // Cloudflare for an answer nobody will read would be pure waste.
        expect(outbound).toEqual([]);
      }
    } finally {
      log.mockRestore();
    }
  });

  it("rejects and logs when TURNSTILE_SECRET is unset, without a subrequest either", async () => {
    // The CSRF half passes here, so this is purely validateTurnstile's own
    // early return. This is the failure the brief calls invisible by
    // construction: the form still renders, the widget still solves, the
    // visitor still gets ?turnstilefail=true, and only this log line
    // distinguishes "our secret is missing" from "a bot tried it on".
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      for (const missing of [undefined, ""]) {
        stubFetch();
        log.mockClear();
        expect(await relayed({ env: envWith({ TURNSTILE_SECRET: missing }) })).toBe(false);
        expect(log).toHaveBeenCalledTimes(1);
        expect(log.mock.calls[0]?.[0]).toContain("TURNSTILE_SECRET not set");
        expect(outbound).toEqual([]);
      }
    } finally {
      log.mockRestore();
    }
  });

  it("logs only the CSRF line when both secrets are missing", async () => {
    // The ordering, visible from the outside a second way: if the two calls
    // were swapped, the surviving log line would be the Turnstile one. This is
    // the assertion that would still catch the swap if a future refactor made
    // the CSRF half cost a subrequest of its own (a KV lookup, say) and the
    // `outbound` assertions above stopped being decisive.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      stubFetch();
      expect(await relayed({ env: envWith({ CSRF_SECRET: undefined, TURNSTILE_SECRET: undefined }) })).toBe(false);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]?.[0]).toContain("CSRF_SECRET not set");
      expect(outbound).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });
});

describe("the gate is an AND", () => {
  it("lets neither half rescue the other", async () => {
    // Guards the refactor that turns two sequential checks into something
    // combining them wrongly -- `csrfOk || turnstileOk`, or a version that
    // forgets to return the second result. Both single-failure directions and
    // the both-good control are here, so the test cannot be satisfied by a
    // function that always answers the same thing.
    stubFetch({ success: false });
    expect(await relayed()).toBe(false); // CSRF fine, Turnstile refuses

    stubFetch();
    expect(await relayed({ cookie: undefined })).toBe(false); // Turnstile fine, no CSRF cookie

    stubFetch({ success: false });
    expect(await relayed({ cookie: undefined })).toBe(false); // neither

    stubFetch();
    expect(await relayed()).toBe(true); // both
  });

  it("answers false rather than throwing, whatever hostile input it is handed", async () => {
    // Everything the gate reads is attacker-chosen: the Cookie header and
    // every posted field. The gate() helper turns a non-boolean response into
    // a thrown error, so each of these is an assertion that a 403 stayed a 403
    // rather than becoming an attacker-triggerable 500 on the public
    // registration form.
    const oversized = "z".repeat(200_000);
    const cases: Array<[string, GateOptions]> = [
      ["an oversized cookie", { cookie: `__Host-csrf=${oversized}.${oversized}` }],
      ["a cookie header of separators only", { cookie: ";;;" }],
      ["an empty cookie header", { cookie: "" }],
      ["a cookie with no '=' at all", { cookie: "__Host-csrf" }],
      ["a NUL byte in the token field", { fields: { csrf_token: `${RAW}\0`, "cf-turnstile-response": "widget-token" } }],
      ["astral-plane characters in the token field", { fields: { csrf_token: "\u{1F35E}".repeat(32), "cf-turnstile-response": "widget-token" } }],
      ["a megabyte of token field", { fields: { csrf_token: "6".repeat(1_000_000), "cf-turnstile-response": "widget-token" } }],
      ["an entirely empty body", { fields: {} }],
      ["a null-origin submission from a sandboxed iframe", { headers: { Origin: "null" } }],
    ];

    for (const [label, options] of cases) {
      stubFetch();
      expect(await relayed(options), label).toBe(false);
      expect(outbound, `${label} must not reach siteverify`).toEqual([]);
    }
  });
});

describe("wired into POST /register-foodbank/ in the real app", () => {
  // The gate above is exercised through a throwaway Hono app; these two run it
  // where it actually lives, through the real index.ts with its real
  // middleware stack and the real register_foodbank.njk render. Nothing here
  // touches D1, KV, R2 or a queue -- slugRedirect's SLUG_PATTERN cannot match
  // /register-foodbank/ -- so no binding is faked.
  const env = envWith();

  const VALID_REGISTRATION = {
    name: "Sid Valley Food Bank",
    address: "1 High Street\nSidmouth",
    postcode: "EX10 8LS",
    country: "England",
    network: "Independent",
    email: "hello@example.org",
    phone_number: "01395 123456",
    charity_number: "1234567",
    website: "https://example.org/",
    shopping_list_link: "",
    facebook: "",
  };

  it("passes a genuine round trip: render the page, submit what it rendered", async () => {
    // The end-to-end positive path, and the one thing no other suite covers:
    // flag.test.ts asserts that /register-foodbank/ still REJECTS a
    // token-less POST, which a permanently-broken gate would also satisfy.
    // Here the cookie and the hidden field are whatever issueCsrfToken()
    // actually minted on the GET, so a mismatch anywhere in the chain --
    // cookie attributes, field name, the HMAC, parseBody -- surfaces as a
    // registration nobody can submit.
    stubFetch();
    const page = await app.request(PAGE, {}, env);
    expect(page.status).toBe(200);
    const cookie = (page.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
    expect(cookie).toMatch(/^__Host-csrf=[0-9a-f]{64}\.[0-9a-f]{64}$/);
    const token = /name="csrf_token" value="([0-9a-f]{64})"/.exec(await page.text())?.[1] ?? "";
    expect(cookie).toContain(`=${token}.`);

    const res = await app.request(
      PAGE,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie, Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
        body: new URLSearchParams({ ...VALID_REGISTRATION, csrf_token: token, "cf-turnstile-response": "widget-token" }).toString(),
      },
      env,
    );

    // Past the gate, past validateRegistration, and the notification email
    // actually went out -- assert the effect, not the status code alone.
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/register-foodbank/?thanks=1");
    expect(outbound.map((o) => o.url)).toEqual([SITEVERIFY, POSTMARK]);
    const payload = JSON.parse(outbound[1]!.body) as { To: string; Subject: string; TextBody: string };
    expect(payload.To).toBe("mail@givefood.org.uk");
    expect(payload.Subject).toBe("New Food Bank Registration - Sid Valley Food Bank");
    expect(payload.TextBody).toContain("postcode: EX10 8LS");
    // redactedKeyValueLines drops both gate fields, matching views.py's own
    // pop() calls -- a live CSRF token must not be mailed to an inbox.
    expect(payload.TextBody).not.toContain("csrf_token");
    expect(payload.TextBody).not.toContain("widget-token");
  });

  it("gives the same ?turnstilefail=true whichever half of the gate failed", async () => {
    // Both halves collapse into one redirect, so the page cannot tell a bot
    // from a stale tab from a missing secret -- deliberate (registerFoodbank.ts
    // documents the redirect as the site's convention), but it is why the two
    // console.log lines above are the only diagnosis available when this
    // starts happening to real people. Pinned so that a future change that
    // distinguishes them is a decision rather than a surprise.
    const submit = (fields: Record<string, string>, cookie: string) =>
      app.request(
        PAGE,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie, Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
          body: new URLSearchParams(fields).toString(),
        },
        env,
      );

    // CSRF good, Turnstile refuses.
    stubFetch({ success: false });
    const cookie = await signedCookie(RAW);
    const refused = await submit({ ...VALID_REGISTRATION, csrf_token: RAW, "cf-turnstile-response": "widget-token" }, cookie);
    expect(refused.status).toBe(302);
    expect(refused.headers.get("Location")).toBe("/register-foodbank/?turnstilefail=true");
    expect(outbound.map((o) => o.url)).toEqual([SITEVERIFY]); // asked, and no email sent

    // Turnstile would pass, but the CSRF token is a stale tab's.
    stubFetch();
    const stale = await submit({ ...VALID_REGISTRATION, csrf_token: "9e".repeat(32), "cf-turnstile-response": "widget-token" }, cookie);
    expect(stale.status).toBe(302);
    expect(stale.headers.get("Location")).toBe("/register-foodbank/?turnstilefail=true");
    // ...and the short-circuit holds in the real app too: no subrequest at
    // all, so a scripted flood of tokenless POSTs costs nothing per attempt.
    expect(outbound).toEqual([]);
  });
});
