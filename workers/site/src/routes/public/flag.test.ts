import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import { hmacSha256Hex } from "../../lib/hmac";
import type { Env } from "../../../worker-configuration";

// Issue #40: /flag/ was 16.94% of the zone's 200s (13,117 requests/day, the
// busiest single page on the site) and permanently at cf-cache-status
// BYPASS, because the port had added a CSRF token Django never had. The
// token made every render per-visitor; index.ts therefore pinned the page
// uncacheable with middleware/noStore.ts; so all 13,117 executed the Worker
// and served 2,744 brotli bytes from origin that the edge could have
// answered.
//
// The fix is two edits that only work together -- routes/public/flag.ts stops
// issuing the token and stops requiring it, index.ts stops mounting noStore
// on /flag/ -- and BOTH failure modes of splitting them are live incidents
// this repo has already had:
//
//   token gone, gate still checking  -> every real submission fails
//     verifyCsrf, redirects to ?turnstilefail=true and DISCARDS what the
//     visitor typed. middleware/pageCacheControl.ts records reproducing
//     exactly this on production on 2026-09-07.
//   token still issued, noStore gone -> a returning visitor's page (token
//     and all) enters the shared cache and is served to everyone else,
//     whose submissions then fail the same way. Same file, same date.
//
// So these tests are written as the invariant that makes the page safe to
// cache -- TWO DIFFERENT VISITORS GET THE SAME BYTES -- rather than as a
// list of the individual lines that changed. That property is false under
// the old code in both directions and cannot be satisfied by half the fix.
//
// REAL APP, REAL MIDDLEWARE, REAL TEMPLATES. The app under test is the
// default export of workers/site/src/index.ts itself, so every request here
// goes through the real registration order (serverTiming, cacheTag,
// runtimeIdentity, slugRedirect, resolveLanguage, geoJsonPreload,
// pageCacheControl, then the noStore mounts) and renders public/flag.njk
// through the real nunjucks environment. Nothing about this route touches
// D1, KV, R2 or a queue -- slugRedirect's SLUG_PATTERN cannot match /flag/,
// which is the same reason the live page reports server-timing
// render;dur=0.000 -- so no binding is faked. Only global fetch is stubbed,
// because Turnstile siteverify and Postmark are real network calls.

const CSRF_SECRET = "test-csrf-secret";

// A binding set with the two secrets the POST path reads. CSRF_SECRET is
// present ON PURPOSE even though nothing on this route reads it any more:
// a test that only passed because the secret was missing would pass for
// lib/csrf.ts's fail-closed reason rather than because the route stopped
// asking, and would keep passing if issueCsrfToken() were put back.
const env = {
  CSRF_SECRET,
  TURNSTILE_SECRET: "test-turnstile-secret",
  POSTMARK_TOKEN: "test-postmark-token",
} as unknown as Env;

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const POSTMARK = "https://api.postmarkapp.com/email";

interface Outbound {
  url: string;
  body: string;
}

let outbound: Outbound[] = [];

/**
 * Stubs the two real network calls this route makes and records them, so a
 * test can assert on what was SENT rather than only on the status code that
 * came back. `turnstile` decides what siteverify answers for a NON-EMPTY
 * token; an empty one is always rejected, because that is what the real
 * endpoint does (`missing-input-response`) and a stub that waved it through
 * would let "the Turnstile check was deleted" pass as a green run.
 */
function stubFetch({ turnstile = true, postmarkOk = true }: { turnstile?: boolean; postmarkOk?: boolean } = {}) {
  outbound = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "";
    outbound.push({ url, body });
    if (url === SITEVERIFY) {
      const submitted = new URLSearchParams(body).get("response") ?? "";
      return new Response(JSON.stringify({ success: turnstile && submitted.length > 0 }), { status: 200 });
    }
    if (url === POSTMARK) return new Response("{}", { status: postmarkOk ? 200 : 422 });
    throw new Error(`unexpected fetch to ${url}`);
  });
}

/** A `__Host-csrf` cookie whose HMAC actually verifies -- what a RETURNING visitor sends. */
async function returningVisitorCookie(): Promise<string> {
  const raw = "a".repeat(64);
  return `__Host-csrf=${raw}.${await hmacSha256Hex(CSRF_SECRET, raw)}`;
}

function get(path: string, headers: Record<string, string> = {}) {
  return app.request(`https://www.givefood.org.uk${path}`, { headers }, env);
}

function post(path: string, fields: Record<string, string>) {
  return app.request(
    `https://www.givefood.org.uk${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    },
    env,
  );
}

// includes/debugcomment.njk puts a wall-clock timestamp and a render duration
// in an HTML comment at the top of every page. Both legitimately differ
// between two responses and neither is per-VISITOR, so they are the only
// thing normalised before the byte comparison below -- and the helper
// asserts it actually found both, so a future template change that removes
// them cannot quietly turn this into a comparison of nothing.
function withoutClockNoise(html: string): string {
  expect(html).toMatch(/🕰️ Generated at .+/);
  expect(html).toMatch(/⏱️ Took \d+ms/);
  return html.replace(/🕰️ Generated at .+/, "🕰️ Generated at <T>").replace(/⏱️ Took \d+ms/, "⏱️ Took <N>ms");
}

// The hidden field public/flag.njk renders. The template is NOT changed by
// this fix -- the field stays, carrying an empty value, and /human/ relays it
// back as an empty string that nothing reads. Written as the exact tag
// because "no token" spelt as a `not.toContain` would also pass if the whole
// form disappeared.
const EMPTY_TOKEN_FIELD = '<input type="hidden" name="csrf_token" value="">';

// A 64-hex-character run: the shape of issueCsrfToken()'s raw token
// (RAW_TOKEN_BYTES = 32, hex-encoded). Used to assert no token of any origin
// -- freshly minted or adopted from the visitor's cookie -- reaches the HTML.
const RAW_TOKEN_SHAPE = /\b[0-9a-f]{64}\b/;

beforeEach(() => {
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /flag/ is the same page for everybody", () => {
  it("serves byte-identical HTML to a first-time visitor and a returning one", async () => {
    // THE TEST THIS FILE EXISTS FOR. Under the old code these two responses
    // could not match: the cookieless visitor got a freshly minted 64-hex
    // token (plus a Set-Cookie), and the returning visitor got the token out
    // of their own cookie, adopted and echoed back into the hidden field by
    // issueCsrfToken()'s reuse path. Two visitors, two bodies, one URL --
    // which is precisely why the page could not be shared by a cache.
    //
    // Restoring issueCsrfToken() on the GET path fails this line, whichever
    // of its two branches runs.
    const first = await get("/flag/");
    const returning = await get("/flag/", { Cookie: await returningVisitorCookie() });

    expect(first.status).toBe(200);
    expect(returning.status).toBe(200);
    expect(withoutClockNoise(await returning.text())).toBe(withoutClockNoise(await first.text()));
  });

  it("mints no cookie, so Cloudflare's own Set-Cookie bypass no longer applies", async () => {
    // Cloudflare refuses to cache a response carrying Set-Cookie. That rule
    // is what masked the old bug for FIRST-TIME visitors (they got a BYPASS)
    // while a returning visitor's token-bearing page was cacheable -- the
    // asymmetry that made this hard to see. With no token issued there is no
    // cookie on either path.
    for (const res of [await get("/flag/"), await get("/flag/", { Cookie: await returningVisitorCookie() })]) {
      expect(res.headers.get("Set-Cookie")).toBeNull();
    }
  });

  it("renders the hidden field with an empty value and no token of any shape", async () => {
    // The template still emits the field (packages/templates is not touched
    // by this fix), so the correct assertion is "present and empty", not
    // "absent". RAW_TOKEN_SHAPE then catches a token arriving by any other
    // route -- a different context key, a token left in a comment, an
    // adopted cookie value rendered somewhere else on the page.
    const html = await (await get("/flag/", { Cookie: await returningVisitorCookie() })).text();

    expect(html).toContain(EMPTY_TOKEN_FIELD);
    expect(html).not.toMatch(RAW_TOKEN_SHAPE);
    // One field, not two: a re-added token as a second hidden input would
    // satisfy both assertions above.
    expect(html.match(/name="csrf_token"/g)).toHaveLength(1);
  });

  it("carries the header half of Django's @cache_page(SECONDS_IN_DAY) and none of noStore's", async () => {
    // givefood/views.py:1098 decorates flag() with @cache_page(SECONDS_IN_DAY)
    // and nothing else. middleware/pageCacheControl.ts has no rule for
    // /flag/, so it reaches the SECONDS_IN_DAY fallthrough -- which is the
    // reason issue #40's "Suggested fix" says explicitly NOT to add a
    // SHARED_TTL entry for this path: a SECONDS_IN_WEEK rule would be a
    // silent divergence from the number Django actually used.
    //
    // BROWSER_MAX_AGE is 300 rather than Django's 86400, a divergence
    // pageCacheControl.ts documents deliberately (the edge can be purged, a
    // browser cache cannot).
    const res = await get("/flag/");

    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    // The three headers middleware/noStore.ts sets. Their ABSENCE is the
    // index.ts half of the fix; CDN-Cache-Control is the load-bearing one,
    // being the only thing that actually stopped the Cloudflare edge.
    expect(res.headers.get("CDN-Cache-Control")).toBeNull();
    expect(res.headers.get("Vary")).toBeNull();
  });

  it("is equally shareable in the three prefixed locales", async () => {
    // index.ts mounted noStore per-locale in a loop, so the removal has to be
    // per-locale too. Trailing slashes are load-bearing in Hono (index.ts
    // says so at the mount site): "/cy/flag" does not match "/cy/flag/".
    for (const path of ["/cy/flag/", "/ga/flag/", "/gd/flag/"]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("Cache-Control"), path).toBe("public, max-age=300, s-maxage=86400");
      expect(res.headers.get("CDN-Cache-Control"), path).toBeNull();
      expect(res.headers.get("Set-Cookie"), path).toBeNull();
    }
  });

  it("makes ?thanks=1 and ?turnstilefail=true their own shareable cache keys", async () => {
    // Issue #40's stated residual risk: once the page is cacheable these two
    // query strings become separate cache entries. Both render no visitor
    // data -- the confirmation is a fixed sentence, the failure notice a
    // fixed warning -- so serving either from cache to someone who did not
    // submit is cosmetic. Pinned here so that stops being an assumption.
    const thanks = await get("/flag/?thanks=1");
    const fail = await get("/flag/?turnstilefail=true");

    expect(thanks.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    expect(fail.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");

    const thanksHtml = await thanks.text();
    const failHtml = await fail.text();
    expect(thanksHtml).toContain("Thanks!");
    // The confirmation page has no form at all, so no field to leak.
    expect(thanksHtml).not.toContain('name="csrf_token"');
    expect(failHtml).toContain(EMPTY_TOKEN_FIELD);
    expect(failHtml).not.toMatch(RAW_TOKEN_SHAPE);

    // And each is still the same page for two different visitors.
    const failReturning = await get("/flag/?turnstilefail=true", { Cookie: await returningVisitorCookie() });
    expect(withoutClockNoise(await failReturning.text())).toBe(withoutClockNoise(failHtml));
  });

  it("makes no request to Cloudflare or Postmark while rendering", async () => {
    // The GET path's whole value is that it is pure render: no D1, no
    // subrequest, nothing to make it slow or unshareable. Asserted on the
    // fetch stub rather than inferred, so a future "verify something on
    // render" cannot slip in unnoticed.
    await get("/flag/");
    expect(outbound).toEqual([]);
  });
});

describe("POST /flag/ -- Turnstile is the gate, and the only gate", () => {
  const VALID = {
    our_page: "https://www.givefood.org.uk/needs/at/sid-valley/",
    your_email: "reporter@example.com",
    explanation: "The opening hours are wrong",
    "cf-turnstile-response": "turnstile-token",
  };

  it("accepts a submission carrying no csrf_token at all", async () => {
    // The half of the fix that CANNOT be shipped separately. If
    // verifyHumanGate() were still called here, this submission -- exactly
    // what the form now posts, an empty or absent token -- would fail
    // verifyCsrf, redirect to ?turnstilefail=true, and throw away the
    // explanation the visitor typed.
    const res = await post("/flag/", VALID);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/flag/?thanks=1");

    // The email actually went, with the flagged page in it.
    const mail = outbound.find((o) => o.url === POSTMARK);
    expect(mail).toBeDefined();
    const payload = JSON.parse(mail!.body) as { Subject: string; TextBody: string; To: string };
    expect(payload.To).toBe("mail@givefood.org.uk");
    expect(payload.Subject).toBe("Give Food - Flagged Page");
    expect(payload.TextBody).toContain("our_page: https://www.givefood.org.uk/needs/at/sid-valley/");
    expect(payload.TextBody).toContain("explanation: The opening hours are wrong");
    // lib/email.ts's redactedKeyValueLines drops csrf_token and
    // cf-turnstile-response, matching views.py:1112-1113's own pop() calls.
    expect(payload.TextBody).not.toContain("csrf_token");
    expect(payload.TextBody).not.toContain("cf-turnstile-response");
  });

  it("accepts one carrying the empty csrf_token the relayed form now sends", async () => {
    // What actually arrives in production: flag.njk renders value="", the
    // POST /human/ relay copies every field through as a hidden input, and
    // the second POST lands here with csrf_token="". Distinct from the case
    // above (field absent) because parseBody yields "" rather than undefined,
    // and verifyCsrf treats those two differently.
    const res = await post("/flag/", { ...VALID, csrf_token: "" });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/flag/?thanks=1");
  });

  it("still refuses a submission Turnstile rejects", async () => {
    // Turnstile is the real protection and is unchanged. Deleting the check
    // along with the CSRF one would pass every test above and open the form
    // to unlimited automated abuse.
    stubFetch({ turnstile: false });
    const res = await post("/flag/", VALID);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/flag/?turnstilefail=true");
    expect(outbound.map((o) => o.url)).toEqual([SITEVERIFY]);
  });

  it("refuses a submission with no Turnstile response at all", async () => {
    // What a bot POSTing straight at /flag/ now sends. Note the cost
    // difference this fix accepts deliberately: verifyHumanGate() used to
    // reject such a request on CSRF before paying for siteverify, whereas
    // now the empty token is relayed to Cloudflare and rejected there. One
    // subrequest, no email, and the same answer -- kept identical to the
    // second half of verifyHumanGate() rather than "improved" with a local
    // empty-token shortcut that function does not have.
    const { "cf-turnstile-response": _omitted, ...withoutToken } = VALID;
    const res = await post("/flag/", withoutToken);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/flag/?turnstilefail=true");
    expect(outbound.map((o) => o.url)).toEqual([SITEVERIFY]);
    expect(new URLSearchParams(outbound[0]!.body).get("response")).toBe("");
  });

  it("checks Turnstile before doing anything else, exactly as verifyHumanGate did", async () => {
    // The old code short-circuited on CSRF so a bad request never paid for
    // the siteverify round-trip. With CSRF gone, siteverify IS the first
    // thing, and it must still run before the form is validated or any email
    // is built -- a request that fails it must cost one subrequest, not two.
    stubFetch({ turnstile: false });
    await post("/flag/", { our_page: "not-a-url", "cf-turnstile-response": "x" });

    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.url).toBe(SITEVERIFY);
    expect(outbound[0]!.body).toContain("secret=test-turnstile-secret");
    expect(outbound[0]!.body).toContain("response=x");
  });

  it("re-renders an invalid form with the empty token field and no cookie", async () => {
    // A 200 re-render, not a redirect, so the visitor keeps what they typed.
    // It must not mint a cookie either: a Set-Cookie here would be harmless
    // for caching (pageCacheControl skips non-GET) but would put a token back
    // in a browser for a route that no longer verifies one.
    const res = await post("/flag/", { ...VALID, our_page: "definitely not a url" });

    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    const html = await res.text();
    expect(html).toContain(EMPTY_TOKEN_FIELD);
    expect(html).not.toMatch(RAW_TOKEN_SHAPE);
    // The typed values survive the round trip -- issue #40's whole worry.
    expect(html).toContain('value="definitely not a url"');
    expect(html).toContain('value="reporter@example.com"');
    expect(html).toContain("The opening hours are wrong");
  });

  it("re-renders with send_failed when Postmark refuses, again with no token", async () => {
    stubFetch({ postmarkOk: false });
    const res = await post("/flag/", VALID);

    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    const html = await res.text();
    expect(html).toContain(EMPTY_TOKEN_FIELD);
    expect(html).not.toMatch(RAW_TOKEN_SHAPE);
    expect(html).toContain("something went wrong sending your report");
  });

  it("redirects to the locale's own /flag/ after a prefixed submission", async () => {
    const res = await post("/cy/flag/", VALID);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/cy/flag/?thanks=1");
  });

  it("is never given a Cache-Control by pageCacheControl", async () => {
    // A POST response is not cacheable and the middleware returns early on
    // method. Pinned because the noStore mount that used to guarantee this
    // for /flag/ is gone.
    const res = await post("/flag/", { ...VALID, our_page: "definitely not a url" });
    expect(res.headers.get("Cache-Control")).toBeNull();
  });
});

describe("the shared human gate is untouched for its other caller", () => {
  it("still requires a CSRF token on POST /register-foodbank/", async () => {
    // Issue #40's first named risk: "Drop CSRF on /flag/" implemented by
    // weakening verifyHumanGate() silently drops it from /register-foodbank/
    // too, because both routes call the same function. flag.ts therefore
    // calls validateTurnstile() directly and leaves humanGate.ts alone --
    // and this is the assertion that proves the opt-out stayed local.
    //
    // Turnstile is stubbed to SUCCEED here, so the only thing that can
    // produce a rejection is the CSRF half of the gate.
    const res = await app.request(
      "https://www.givefood.org.uk/register-foodbank/",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ name: "Test", "cf-turnstile-response": "turnstile-token" }).toString(),
      },
      env,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/register-foodbank/?turnstilefail=true");
    // And it short-circuited on CSRF, so siteverify was never called -- the
    // ordering verifyHumanGate documents, still in place.
    expect(outbound).toEqual([]);
  });

  it("still issues a token and stays uncacheable on GET /register-foodbank/", async () => {
    // The neighbour that keeps BOTH halves of the old arrangement. If a
    // future edit generalises this fix to "the register form doesn't need
    // CSRF either", that is a decision to take deliberately, and this is
    // where it gets taken rather than drifted into.
    const res = await get("/register-foodbank/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toMatch(/^__Host-csrf=[0-9a-f]{64}\.[0-9a-f]{64}; Secure; HttpOnly; SameSite=Lax; Path=\/$/);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store, max-age=0, must-revalidate");
    expect(res.headers.get("CDN-Cache-Control")).toBe("no-store");
    expect(await res.text()).toMatch(RAW_TOKEN_SHAPE);
  });
});
