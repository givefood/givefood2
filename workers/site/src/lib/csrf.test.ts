import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { issueCsrfToken, verifyCsrf } from "./csrf";
import type { AppEnv } from "../types";

// This module has NO Django ancestor to check against: settings.py:97 has
// `django.middleware.csrf.CsrfViewMiddleware` commented out, so the live
// site's `{% csrf_token %}` tags are decorative and nothing on the Django
// side validates anything. That makes these tests the only specification
// the scheme has -- there is no "compare it with production" fallback if
// they are wrong or thin, and a regression here is silent (forms keep
// rendering, admins keep submitting) right up until either every save 403s
// or nothing is actually being checked at all.
//
// So the two properties worth defending, both from the module's own header
// comment, are asserted as PROPERTIES rather than as string shapes:
//
//   1. "Signed", not plain double-submit -- an attacker who can write a
//      cookie (any sibling subdomain can, __Host- prefix or not, since the
//      prefix is only enforced on the *setter*) still cannot produce one
//      that verifies. Tests below plant cookies and assert they are neither
//      adopted by issueCsrfToken() nor accepted by verifyCsrf().
//   2. Reuse, not mint-per-render -- the fix for the two-tab 403 bug the
//      module comment describes at length. Asserted by checking that a
//      request arriving with a valid cookie gets NO Set-Cookie back and the
//      SAME raw token, which is the only thing that keeps a form left open
//      in tab one submittable after tab two rendered.
//
// A third property is asserted throughout by the two helpers below rather
// than by a test of its own: NEITHER function may throw. Both are reached
// with entirely attacker-chosen input (the Cookie header, the posted form
// field), and every caller treats a false as a 403; an exception would turn
// that 403 into a 500 that anyone can trigger at will.

const SECRET = "csrf-secret-under-test";
const ORIGIN = "https://www.givefood.org.uk";
const PAGE = `${ORIGIN}/admin/foodbank/sid-valley/`;

// Hono's fetch() wants an ExecutionContext; nothing under test touches it.
const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

// An INDEPENDENT HMAC-SHA256, built from the RFC 2104 construction over
// WebCrypto's SHA-256 digest rather than by importing lib/hmac.ts. Signing
// the expectations with the module's own helper would only ever prove that
// the code agrees with itself: if hmac.ts changed its key handling or its
// encoding, both sides would move together and the test would stay green
// while every already-issued cookie in the wild stopped verifying.
async function rfc2104HmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const blockSize = 64; // SHA-256's block size, in bytes
  let keyBytes = encoder.encode(secret);
  if (keyBytes.length > blockSize) keyBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", keyBytes));
  const paddedKey = new Uint8Array(blockSize);
  paddedKey.set(keyBytes);

  const innerPad = new Uint8Array(blockSize);
  const outerPad = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    innerPad[i] = (paddedKey[i] ?? 0) ^ 0x36;
    outerPad[i] = (paddedKey[i] ?? 0) ^ 0x5c;
  }

  const messageBytes = encoder.encode(message);
  const innerInput = new Uint8Array(blockSize + messageBytes.length);
  innerInput.set(innerPad);
  innerInput.set(messageBytes, blockSize);
  const innerHash = new Uint8Array(await crypto.subtle.digest("SHA-256", innerInput));

  const outerInput = new Uint8Array(blockSize + innerHash.length);
  outerInput.set(outerPad);
  outerInput.set(innerHash, blockSize);
  const mac = new Uint8Array(await crypto.subtle.digest("SHA-256", outerInput));
  return Array.from(mac)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// The oracle above is only worth anything if it is itself right, so it is
// pinned to a published known-answer vector before being used to judge the
// module. Without this, a bug in the helper would show up as a confusing
// failure in csrf.ts's tests rather than here.
it("the test's own HMAC oracle matches RFC 4231 test case 2", async () => {
  expect(await rfc2104HmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
});

// Builds the cookie value a previous response would have set, WITHOUT going
// through issueCsrfToken -- so tests can hand verifyCsrf() a cookie whose
// provenance they control exactly (right secret, wrong secret, no secret).
async function signedCookie(raw: string, secret = SECRET): Promise<string> {
  return `__Host-csrf=${raw}.${await rfc2104HmacSha256Hex(secret, raw)}`;
}

type IssueOptions = { cookie?: string; secret?: string | undefined; existingSetCookie?: string };

// Everything goes through a real Hono app rather than a hand-rolled Context
// stub: the module reads request headers and writes a response header via
// Hono's own APIs, and a stub would let a change in how it does either pass
// unnoticed. The token comes back as the response body because it is opaque
// hex, so the body is a safe carrier.
async function issue(options: IssueOptions = {}): Promise<{ token: string; setCookies: string[] }> {
  const secret = Object.hasOwn(options, "secret") ? options.secret : SECRET;
  const app = new Hono<AppEnv>();
  app.get("*", async (c) => {
    // Simulates a handler that has already set an unrelated cookie (the
    // admin session, in practice) before rendering the page.
    if (options.existingSetCookie) c.header("Set-Cookie", options.existingSetCookie, { append: true });
    return c.text(await issueCsrfToken(c, secret));
  });

  const headers = new Headers();
  if (options.cookie !== undefined) headers.set("Cookie", options.cookie);
  const res = await app.fetch(new Request(PAGE, { headers }), {} as never, execCtx);
  const token = await res.text();
  // The no-throw half of the contract, enforced on EVERY call rather than in
  // one test: Hono turns a thrown handler error into a 500, and this module
  // is called on every admin page render with a Cookie header the client
  // chose. Without this guard a throw would surface further down as a
  // baffling "expected 'Internal Server Error' to match /[0-9a-f]{64}/".
  if (res.status !== 200) throw new Error(`issueCsrfToken threw (status ${res.status}): ${token}`);
  return { token, setCookies: res.headers.getSetCookie() };
}

type VerifyOptions = {
  cookie?: string;
  formToken?: string | undefined;
  secret?: string | undefined;
  headers?: Record<string, string>;
  url?: string;
};

async function verify(options: VerifyOptions = {}): Promise<boolean> {
  const secret = Object.hasOwn(options, "secret") ? options.secret : SECRET;
  const app = new Hono<AppEnv>();
  app.post("*", async (c) => c.text(String(await verifyCsrf(c, secret, options.formToken))));

  const headers = new Headers(options.headers ?? {});
  if (options.cookie !== undefined) headers.set("Cookie", options.cookie);
  const res = await app.fetch(new Request(options.url ?? PAGE, { method: "POST", headers }), {} as never, execCtx);
  const body = await res.text();
  // Guards the "returns a boolean, never throws" half of the contract: every
  // caller is `if (!(await verifyCsrf(...))) return c.text("Forbidden", 403)`,
  // so a throw on malformed input would turn an attacker-triggerable 403 into
  // an attacker-triggerable 500.
  if (body !== "true" && body !== "false") throw new Error(`verifyCsrf did not return a boolean (status ${res.status}): ${body}`);
  return body === "true";
}

describe("issueCsrfToken", () => {
  it("returns a 32-byte token as lowercase hex for the hidden form field", async () => {
    // RAW_TOKEN_BYTES = 32, hex-encoded with padStart(2) per byte, so the
    // length is fixed at 64. Sampled REPEATEDLY on purpose: padStart only
    // matters for bytes below 0x10, so dropping it shortens the token about
    // 87% of the time -- a single draw would wave the other 13% through, and
    // an intermittently-passing test on a security primitive is worse than
    // no test. The signature half runs through the same padStart route in
    // hmac.ts's toHex and is checked with it.
    for (let i = 0; i < 20; i++) {
      const { token, setCookies } = await issue();
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(setCookies[0]).toMatch(/^__Host-csrf=[0-9a-f]{64}\.[0-9a-f]{64};/);
    }
  });

  it("draws exactly 32 bytes from the CSPRNG and hex-encodes them in order", async () => {
    // The same invariant made deterministic, which is what turns "probably
    // 64 characters" into a proof of the encoding. With the byte stream
    // pinned to 0x00..0x1f the expected token is fully determined, so this
    // fails outright if padStart(2, "0") is dropped (0x00 would render as
    // "0"), if the bytes are emitted in the wrong order, if toString(16) ever
    // produced uppercase, or if RAW_TOKEN_BYTES moves off 32.
    //
    // Stubbing also pins the SOURCE. A generator swapped to Math.random would
    // still produce 64 unique-looking hex characters and pass every other
    // test in this file, while being predictable enough for an attacker to
    // guess a victim's token and forge the form half of the double-submit --
    // so the count below is the assertion that the CSPRNG was consulted at
    // all. The real `subtle` is carried over because the module still has to
    // sign the token (and this test still has to check that signature) with
    // genuine WebCrypto.
    const sizes: number[] = [];
    const getRandomValues = vi.fn((array: Uint8Array) => {
      sizes.push(array.length);
      for (let i = 0; i < array.length; i++) array[i] = i; // 0x00 .. 0x1f
      return array;
    });
    vi.stubGlobal("crypto", { subtle: crypto.subtle, getRandomValues });
    try {
      const { token, setCookies } = await issue();
      expect(getRandomValues).toHaveBeenCalledTimes(1);
      expect(sizes).toEqual([32]);
      expect(token).toBe("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
      // ...and the cookie carries that exact token, signed -- so the hidden
      // field and the cookie cannot drift apart in the mint path either.
      expect(setCookies[0]).toContain(`__Host-csrf=${token}.${await rfc2104HmacSha256Hex(SECRET, token)};`);
    } finally {
      vi.unstubAllGlobals();
    }
    // The stub is undone: a leak here would make every later test in this
    // file mint the same token as the last, silently turning the reuse and
    // uniqueness tests into no-ops.
    expect((await issue()).token).not.toBe("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
  });

  it("signs the cookie with HMAC-SHA256 over the raw token", async () => {
    // This is what makes the scheme SIGNED double-submit. Checked against
    // the independent oracle above, so the secret, the message (the raw
    // token, nothing else) and the hex encoding are all pinned -- including
    // the argument ORDER: hmacSha256Hex(secret, message), not the reverse,
    // which would sign every token with an attacker-known "key".
    const { token, setCookies } = await issue();
    expect(setCookies).toHaveLength(1);
    expect(setCookies[0]).toContain(`__Host-csrf=${token}.${await rfc2104HmacSha256Hex(SECRET, token)};`);
    // Belt and braces on the message: signing the cookie NAME plus the token,
    // or the token twice, would also produce a plausible 64-hex signature.
    expect(setCookies[0]).not.toContain(await rfc2104HmacSha256Hex(SECRET, `__Host-csrf=${token}`));
  });

  it("sets every attribute the __Host- prefix requires, and no Domain", async () => {
    // Browser-enforced: a __Host- cookie missing Secure, missing Path=/, or
    // carrying ANY Domain attribute is silently dropped by the browser. The
    // failure mode is not a warning anywhere -- it is that the cookie never
    // arrives, so verifyCsrf() sees none and every single admin save 403s.
    const { setCookies } = await issue();
    const cookie = setCookies[0] ?? "";
    expect(cookie).toContain("; Secure");
    expect(cookie).toContain("; Path=/");
    expect(cookie).not.toContain("Domain=");
    // Path must be exactly `/`, not a prefix of it: `Path=/admin` also
    // contains "; Path=/" as a substring but scopes the cookie away from the
    // rest of the site AND breaks the __Host- prefix rule.
    expect(cookie).toMatch(/; Path=\/(;|$)/);
    // HttpOnly is the point of embedding the raw token in the HTML instead of
    // having client JS copy it out of the cookie: with it, an XSS on an admin
    // page cannot read the cookie back out.
    expect(cookie).toContain("; HttpOnly");
    // SameSite=Lax is the belt to the Origin/Sec-Fetch-Site braces -- it stops
    // the cookie riding along on a cross-site form POST at all. `None` would
    // be a substring-equal-looking regression that re-opens exactly that.
    expect(cookie).toContain("; SameSite=Lax");
    expect(cookie).not.toContain("SameSite=None");
  });

  it("mints an unpredictable token on each fresh render", async () => {
    // getRandomValues, not a counter and not a hash of anything guessable:
    // an attacker who could predict the raw token could put it in their own
    // form and only need the victim's cookie to ride along.
    //
    // Uniqueness ALONE would not notice a counter ("...0001", "...0002"),
    // which is why the leading bytes are checked for movement and the whole
    // sample for alphabet coverage. Both have enormous margins against a real
    // CSPRNG -- 16 draws colliding on their first 32 bits is ~3e-8, and a hex
    // digit missing from 1024 draws is ~1e-28 -- so neither can flake.
    const tokens: string[] = [];
    for (let i = 0; i < 16; i++) tokens.push((await issue()).token);
    expect(new Set(tokens).size).toBe(16);
    expect(new Set(tokens.map((t) => t.slice(0, 8))).size).toBe(16);
    expect(new Set(tokens.join("")).size).toBeGreaterThanOrEqual(12);
  });

  it("reuses a still-valid cookie rather than replacing it", async () => {
    // The two-tab bug the module comment describes: because the cookie name
    // and path are constant, minting on every render REPLACED the previous
    // cookie, and verifyCsrf() requires the submitted field to equal the
    // cookie's raw token exactly -- so only the most recently rendered admin
    // page could submit. Opening a second food bank in a new tab, going back
    // to the first and pressing Save gave a 403.
    //
    // Two assertions, and both matter: the same token comes back (so tab
    // one's already-rendered form still matches), and NO Set-Cookie is sent
    // (so nothing downstream can rotate it either).
    const raw = "a".repeat(64);
    const { token, setCookies } = await issue({ cookie: await signedCookie(raw) });
    expect(token).toBe(raw);
    expect(setCookies).toEqual([]);
  });

  it("survives the two-tab flow end to end, render then render then submit", async () => {
    // The same regression exercised through BOTH functions and real minted
    // values, rather than against a hand-built cookie: tab one renders and
    // receives the cookie, tab two renders on a request carrying it, and then
    // tab one's Save -- the POST that used to 403 -- has to validate. A reuse
    // path that returned the right token but re-signed it under a new cookie
    // would pass the test above and fail here.
    const first = await issue();
    const cookieValue = (first.setCookies[0] ?? "").split(";")[0] ?? "";
    const second = await issue({ cookie: cookieValue });
    expect(second.token).toBe(first.token);
    expect(second.setCookies).toEqual([]);
    expect(await verify({ cookie: cookieValue, formToken: first.token, headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" } })).toBe(true);
  });

  it("finds its cookie alongside the other cookies a browser sends", async () => {
    // Real admin requests carry the session cookie and whatever else the
    // site has set; the Cookie header is `; `-separated with leading spaces
    // on every part but the first.
    const raw = "b".repeat(64);
    const { token, setCookies } = await issue({ cookie: `gfadmin_session=abc123; ${await signedCookie(raw)}; _ga=GA1.1.99` });
    expect(token).toBe(raw);
    expect(setCookies).toEqual([]);
  });

  it("matches the cookie name exactly, never as a substring", async () => {
    // parseCookie compares the trimmed name for equality. A looser match
    // (`part.startsWith(name)`, `part.includes(name)`) would let a cookie the
    // attacker can freely name stand in for the real one -- and unlike
    // `__Host-csrf` itself, names like these carry no prefix rules for the
    // browser to enforce on whoever sets them. Cookie names are also
    // case-sensitive per RFC 6265, so the lowercase spelling is a different
    // cookie, not the same one.
    const raw = "c".repeat(64);
    const signed = await signedCookie(raw);
    for (const cookie of [
      `evil${signed}`, // `evil__Host-csrf=...`
      signed.replace("__Host-csrf", "__Host-csrf2"),
      signed.replace("__Host-csrf", "__host-csrf"),
      signed.replace("__Host-csrf", "Host-csrf"),
    ]) {
      const { token, setCookies } = await issue({ cookie });
      expect(token).not.toBe(raw);
      expect(setCookies).toHaveLength(1);
    }
  });

  it("honours the FIRST __Host-csrf in the header when a duplicate is planted", async () => {
    // The __Host- prefix is enforced on the setter, not on what arrives, so a
    // sibling subdomain can still land a cookie of that name -- and a
    // duplicate scoped to a narrower path is sent BEFORE the genuine one,
    // which lets the attacker choose which value the server reads.
    // parseCookie returns the first match, so:
    //   planted first  -> signature fails -> a fresh pair is minted, and the
    //                     genuine token behind it is never echoed into the
    //                     page (an attacker must not learn it),
    //   genuine first  -> reused untouched.
    // A refactor to "last match wins" flips both halves, so both are pinned.
    const genuine = "d".repeat(64);
    const planted = `__Host-csrf=${"e".repeat(64)}.${"0".repeat(64)}`;

    const shadowed = await issue({ cookie: `${planted}; ${await signedCookie(genuine)}` });
    expect(shadowed.token).not.toBe(genuine);
    expect(shadowed.token).toMatch(/^[0-9a-f]{64}$/);
    expect(shadowed.setCookies).toHaveLength(1);

    const ordered = await issue({ cookie: `${await signedCookie(genuine)}; ${planted}` });
    expect(ordered.token).toBe(genuine);
    expect(ordered.setCookies).toEqual([]);
  });

  it("refuses to adopt a cookie whose signature does not verify", async () => {
    // A sibling subdomain (or anything else that can write cookies for the
    // registrable domain) can plant a __Host-csrf value. If issueCsrfToken
    // echoed the planted raw token back into the page's hidden field, the
    // attacker would know both halves of the double-submit pair and the
    // scheme would be worthless. Instead the planted value is discarded and
    // a fresh, correctly signed pair replaces it.
    const planted = "c".repeat(64);
    const { token, setCookies } = await issue({ cookie: `__Host-csrf=${planted}.${"0".repeat(64)}` });
    expect(token).not.toBe(planted);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(setCookies).toHaveLength(1);
    expect(setCookies[0]).toContain(`__Host-csrf=${token}.`);
  });

  it("splits the cookie at the FIRST dot, so a suffixed cookie is not adopted", async () => {
    // `existing.indexOf(".")`: everything after the first dot is the
    // signature. Rewriting that as `const [raw, sig] = value.split(".")`
    // looks identical on every well-formed cookie in this file -- and would
    // quietly start accepting `<raw>.<sig>.<anything>`, because the trailing
    // junk lands in a third element nobody reads. That matters because a
    // planted cookie only has to be ACCEPTED to be adopted and echoed into
    // the page as the hidden field.
    const raw = "1".repeat(64);
    const { token, setCookies } = await issue({ cookie: `${await signedCookie(raw)}.extra` });
    expect(token).not.toBe(raw);
    expect(setCookies).toHaveLength(1);
  });

  it("refuses to adopt a cookie signed with a rotated-away secret", async () => {
    // Rotating CSRF_SECRET must degrade to "everyone gets a new token on
    // their next page load", not "every admin is locked out until they
    // manually clear cookies". The old cookie fails its signature check and
    // is simply replaced.
    const stale = "d".repeat(64);
    const { token, setCookies } = await issue({ cookie: await signedCookie(stale, "the-previous-secret") });
    expect(token).not.toBe(stale);
    expect(setCookies).toHaveLength(1);
  });

  it("mints afresh for a malformed cookie instead of throwing", async () => {
    // Malformed values are attacker-reachable (anyone can send any Cookie
    // header), so each of these must land on the mint path rather than an
    // exception that 500s the whole admin page. The issue() helper asserts
    // the 200 for us; what is checked here is that a usable token still comes
    // back and a replacement cookie is actually sent, so the next request can
    // recover rather than looping on the same broken cookie forever.
    for (const cookie of [
      "__Host-csrf=nodothere", // no `.` separator at all
      "__Host-csrf=", // present but empty
      `__Host-csrf=.${"0".repeat(64)}`, // empty raw half
      "__Host-csrf=..", // nothing but separators
      "__Host-csrf", // a name with no `=` at all
      "__Host-csrf==a.b", // value that itself starts with `=`
      `__Host-csrf=${"z".repeat(200_000)}.${"z".repeat(200_000)}`, // an oversized header
      "not-our-cookie=whatever", // the header exists, our cookie does not
      ";;;", // separators only
      "", // empty Cookie header
    ]) {
      const { token, setCookies } = await issue({ cookie });
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(setCookies).toHaveLength(1);
    }
  });

  it("adopts a validly-signed empty raw token, wedging the form", async () => {
    // Documents current behaviour at the degenerate edge; deliberately NOT a
    // bug report and deliberately not fixed here. The reuse path checks only
    // that the signature verifies, never that the raw half is non-empty, so a
    // cookie of `.<hmac of "">` is adopted: issueCsrfToken returns "", the
    // page renders an empty hidden field, and verifyCsrf's
    // `if (!formToken) return false` then rejects every submission forever --
    // with no Set-Cookie minted to break the loop.
    //
    // Unreachable in production, because only a holder of CSRF_SECRET can
    // sign anything and the server only ever signs randomHex's 64 characters.
    // Pinned so that if a future caller ever signs a value it did not mint,
    // the shape of the resulting wedged form is already written down.
    const { token, setCookies } = await issue({ cookie: await signedCookie("") });
    expect(token).toBe("");
    expect(setCookies).toEqual([]);
  });

  it("issues nothing, sets no cookie, and logs when CSRF_SECRET is unset", async () => {
    // Fails closed, matching lib/turnstile.ts's validateTurnstile(): with no
    // secret every submission is going to be rejected, and the log line is
    // the only thing that points at the real cause rather than at the forms.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const missing = await issue({ secret: undefined });
      expect(missing.token).toBe("");
      expect(missing.setCookies).toEqual([]);
      // An empty string is a realistic unset-secret shape too (a binding
      // present but blank), and is treated identically.
      const blank = await issue({ secret: "" });
      expect(blank.token).toBe("");
      expect(blank.setCookies).toEqual([]);
      expect(log).toHaveBeenCalledTimes(2);
      expect(log.mock.calls[0]?.[0]).toContain("CSRF_SECRET not set");
      // The secret check comes FIRST: even a perfectly valid cookie must not
      // be adopted and echoed back, which would hand out a live-looking token
      // that nothing can validate.
      const withCookie = await issue({ secret: undefined, cookie: await signedCookie("f".repeat(64)) });
      expect(withCookie.token).toBe("");
      expect(withCookie.setCookies).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });

  it("appends its Set-Cookie so a cookie the handler already set survives", async () => {
    // `{ append: true }`, not a plain set. Without it, issuing the CSRF
    // cookie would wipe any Set-Cookie the request had already produced --
    // in this codebase that is the admin session cookie, so every admin page
    // render would sign the user out.
    const { setCookies } = await issue({ existingSetCookie: "gfadmin_session=abc123; Path=/; HttpOnly" });
    expect(setCookies).toHaveLength(2);
    expect(setCookies.some((c) => c.startsWith("gfadmin_session="))).toBe(true);
    expect(setCookies.some((c) => c.startsWith("__Host-csrf="))).toBe(true);
  });

  it("mints twice, not once, when one request issues twice with no cookie yet", async () => {
    // Documents current behaviour rather than endorsing it. The reuse path
    // reads the REQUEST's Cookie header, so it cannot see a cookie this same
    // response is in the middle of setting: a first-ever admin request that
    // issues twice (a page plus an inlined fragment, say) emits two
    // Set-Cookie headers, the browser keeps the last, and anything rendered
    // with the first token submits a token that no longer matches its cookie.
    // Harmless today only because the second issue in any real flow arrives
    // on a later request, by which time the reuse path applies.
    const app = new Hono<AppEnv>();
    app.get("*", async (c) => {
      const first = await issueCsrfToken(c, SECRET);
      const second = await issueCsrfToken(c, SECRET);
      return c.text(`${first} ${second}`);
    });
    const res = await app.fetch(new Request(PAGE), {} as never, execCtx);
    const [first, second] = (await res.text()).split(" ");
    expect(first).not.toBe(second);
    const setCookies = res.headers.getSetCookie();
    expect(setCookies).toHaveLength(2);
    // Only the second token's cookie is the one the browser will keep, and
    // the first token is therefore already unusable when it is rendered.
    expect(setCookies[1]).toContain(`__Host-csrf=${second}.`);
    expect(await verify({ cookie: `__Host-csrf=${second}.${await rfc2104HmacSha256Hex(SECRET, second ?? "")}`, formToken: first })).toBe(false);
  });

  it("only reaches the browser when the handler returns through the Context", async () => {
    // Not a defect in this module, but the constraint it imposes on every
    // caller, pinned so it is discoverable: the cookie is written with
    // c.header(), which Hono merges into responses built by c.html()/c.text()
    // and DOES NOT merge into a bare `new Response()`. A route that renders
    // its own Response would embed a valid token in the HTML while sending no
    // cookie, and its form would 403 forever with nothing in the logs.
    const app = new Hono<AppEnv>();
    app.get("*", async (c) => new Response(await issueCsrfToken(c, SECRET)));
    const res = await app.fetch(new Request(PAGE), {} as never, execCtx);
    expect(await res.text()).toMatch(/^[0-9a-f]{64}$/); // a token was minted
    expect(res.headers.getSetCookie()).toEqual([]); // ...and then lost
  });
});

describe("verifyCsrf", () => {
  it("accepts the pair issueCsrfToken just handed out", async () => {
    // The whole point, end to end: what the renderer put in the hidden field
    // plus the cookie it set on the same response must validate on the POST
    // that follows. Every other test here says what is REJECTED, so without
    // this one the module could reject everything and still look green.
    const { token, setCookies } = await issue();
    const cookieValue = (setCookies[0] ?? "").split(";")[0] ?? "";
    expect(await verify({ cookie: cookieValue, formToken: token, headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" } })).toBe(true);
  });

  it("fails closed and logs when CSRF_SECRET is unset", async () => {
    // Same convention as issueCsrfToken: no secret means no validation is
    // possible, and "cannot validate" must never read as "valid".
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const raw = "e".repeat(64);
      expect(await verify({ secret: undefined, cookie: await signedCookie(raw), formToken: raw })).toBe(false);
      expect(await verify({ secret: "", cookie: await signedCookie(raw), formToken: raw })).toBe(false);
      // Both paths must log: a deployment missing the secret rejects every
      // save, and the log line is the only breadcrumb pointing at the binding
      // rather than at the form.
      expect(log).toHaveBeenCalledTimes(2);
      expect(log.mock.calls[0]?.[0]).toContain("CSRF_SECRET not set");
      expect(log.mock.calls[1]?.[0]).toContain("CSRF_SECRET not set");
    } finally {
      log.mockRestore();
    }
  });

  it("rejects a submission with no token field", async () => {
    // A form that lost its `{% csrf_token %}` equivalent, or a hand-rolled
    // fetch() from admin.js that forgot to include it.
    const raw = "f".repeat(64);
    const cookie = await signedCookie(raw);
    expect(await verify({ cookie, formToken: undefined })).toBe(false);
    expect(await verify({ cookie, formToken: "" })).toBe(false);
  });

  it("rejects an empty field even against an empty-raw cookie", async () => {
    // The empty-field check runs BEFORE the cookie is parsed, which closes
    // the degenerate pairing where an attacker plants `__Host-csrf=.<sig>`
    // and submits an empty field so that both halves are trivially "equal".
    // (They could not sign it anyway; this is the belt to that braces.) Both
    // the correctly-signed and the unsigned form of that cookie are checked,
    // because only the first would survive the HMAC step if the empty-field
    // guard were ever removed.
    expect(await verify({ cookie: await signedCookie(""), formToken: "" })).toBe(false);
    expect(await verify({ cookie: `__Host-csrf=.${"0".repeat(64)}`, formToken: "" })).toBe(false);
  });

  it("rejects when the cookie is missing or unparseable", async () => {
    // Expected in normal use -- cookies cleared, a session that outlived the
    // browser restart, a bookmarked POST -- so these must be a clean false
    // (403) rather than an exception (500).
    const raw = "1".repeat(64);
    expect(await verify({ formToken: raw })).toBe(false); // no Cookie header
    expect(await verify({ cookie: "", formToken: raw })).toBe(false); // empty Cookie header
    expect(await verify({ cookie: "gfadmin_session=abc", formToken: raw })).toBe(false); // no CSRF cookie
    expect(await verify({ cookie: "__Host-csrf=", formToken: raw })).toBe(false); // empty value
    expect(await verify({ cookie: "__Host-csrf", formToken: raw })).toBe(false); // no `=` at all
    expect(await verify({ cookie: ";;;", formToken: raw })).toBe(false); // separators only
    expect(await verify({ cookie: `__Host-csrf=${raw}`, formToken: raw })).toBe(false); // signature separator missing
    expect(await verify({ cookie: `evil__Host-csrf=${raw}.x`, formToken: raw })).toBe(false); // name matched only as a substring
    expect(await verify({ cookie: `__Host-csrf=${"z".repeat(200_000)}.${"z".repeat(200_000)}`, formToken: raw })).toBe(false); // oversized
  });

  it("rejects a cookie the server never signed, even when the field matches it", async () => {
    // The attack a plain (unsigned) double-submit cookie loses to: an
    // attacker who can write cookies for the domain sets both halves to a
    // value they chose, then cross-site-submits the matching field. Both
    // halves agree, so only the HMAC stops it.
    const chosen = "2".repeat(64);
    expect(await verify({ cookie: `__Host-csrf=${chosen}.${"0".repeat(64)}`, formToken: chosen })).toBe(false);
    // Also with a signature of a plausible length but wrong content, and one
    // made with a different secret.
    expect(await verify({ cookie: await signedCookie(chosen, "some-other-secret"), formToken: chosen })).toBe(false);
    // And with a truncated signature -- timingSafeEqual's length check.
    const good = await signedCookie(chosen);
    expect(await verify({ cookie: good.slice(0, -1), formToken: chosen })).toBe(false);
    // The right signature in the wrong case: the comparison is over hex
    // STRINGS, and hmacSha256Hex only ever emits lowercase, so an uppercase
    // rendering of the correct MAC is still a mismatch. (`chosen` is all
    // digits, so only the signature half changes here.)
    expect(await verify({ cookie: `__Host-csrf=${chosen}.${(await rfc2104HmacSha256Hex(SECRET, chosen)).toUpperCase()}`, formToken: chosen })).toBe(false);
    // Trailing junk after a genuine signature: verifyCsrf takes everything
    // after the FIRST dot as the signature, so `<raw>.<sig>.<anything>` is a
    // signature mismatch, not a valid cookie with an ignored suffix. A
    // `split(".")` rewrite would accept this.
    expect(await verify({ cookie: `${good}.extra`, formToken: chosen })).toBe(false);
    // A second, planted copy in front of the genuine cookie wins the
    // parseCookie race and must therefore fail rather than fall through to
    // the good one behind it.
    expect(await verify({ cookie: `__Host-csrf=${chosen}.${"0".repeat(64)}; ${good}`, formToken: chosen })).toBe(false);
  });

  it("rejects a valid token that belongs to a different cookie", async () => {
    // The double-submit binding itself. Both values here are genuinely
    // server-signed, so the HMAC check passes on the cookie -- what fails is
    // that the field does not match THIS cookie. This is the case that
    // catches a form rendered before a token rotation, and the case where an
    // attacker knows a token from elsewhere but cannot read the victim's
    // HttpOnly cookie.
    const cookieRaw = "3".repeat(64);
    const otherRaw = "4".repeat(64);
    expect(await verify({ cookie: await signedCookie(cookieRaw), formToken: otherRaw })).toBe(false);
    // A prefix of the real token must not pass either -- constant-time
    // comparison returns false on a length mismatch before comparing bytes.
    expect(await verify({ cookie: await signedCookie(cookieRaw), formToken: cookieRaw.slice(0, 32) })).toBe(false);
    // Nor an extension of it, which is what a `startsWith` comparison would
    // wave through.
    expect(await verify({ cookie: await signedCookie(cookieRaw), formToken: `${cookieRaw}5` })).toBe(false);
    // A single flipped character in the middle: proves the whole string is
    // compared, not a prefix or a length.
    expect(await verify({ cookie: await signedCookie(cookieRaw), formToken: `${cookieRaw.slice(0, 32)}4${cookieRaw.slice(33)}` })).toBe(false);
  });

  it("rejects hostile form-field shapes without throwing", async () => {
    // formToken arrives from `c.req.parseBody()`, so it is whatever the
    // attacker posted: any length, any code point, no trimming. Everything
    // here must be a plain false -- a 403 -- because timingSafeEqual walks the
    // string with charCodeAt and a throw here would be an
    // attacker-triggerable 500 on every admin write route.
    const cookieRaw = "6".repeat(64);
    const cookie = await signedCookie(cookieRaw);
    for (const formToken of [
      cookie.slice("__Host-csrf=".length), // the whole signed value, not just the raw half
      `${cookieRaw}\0`, // NUL byte
      `${cookieRaw} `, // trailing space: form fields are not trimmed
      ` ${cookieRaw}`, // leading space
      "café-".repeat(12) + "café", // accented characters, 64 UTF-16 units
      "\u{1F35E}".repeat(32), // surrogate pairs: 64 UTF-16 units, 32 characters
      "6".repeat(1_000_000), // a megabyte of field
    ]) {
      expect(await verify({ cookie, formToken })).toBe(false);
    }
  });

  it("accepts Sec-Fetch-Site: same-origin and none, and rejects the rest", async () => {
    // `none` means the user typed the URL or used a bookmark -- no initiator
    // at all -- which cannot be an attacker's page, so it is allowed rather
    // than treated as suspicious.
    const raw = "5".repeat(64);
    const cookie = await signedCookie(raw);
    expect(await verify({ cookie, formToken: raw, headers: { "Sec-Fetch-Site": "same-origin" } })).toBe(true);
    expect(await verify({ cookie, formToken: raw, headers: { "Sec-Fetch-Site": "none" } })).toBe(true);
    expect(await verify({ cookie, formToken: raw, headers: { "Sec-Fetch-Site": "cross-site" } })).toBe(false);
    // `same-site` is REJECTED, and deliberately: it means a different origin
    // under the same registrable domain -- exactly the sibling-subdomain
    // position the signed cookie is defending against.
    expect(await verify({ cookie, formToken: raw, headers: { "Sec-Fetch-Site": "same-site" } })).toBe(false);
    // The comparison is exact and case-sensitive (browsers send the lowercase
    // token), and it is against the WHOLE header value -- so a proxy that
    // folded a duplicated header into `a, b` fails closed rather than
    // matching on a substring.
    expect(await verify({ cookie, formToken: raw, headers: { "Sec-Fetch-Site": "Same-Origin" } })).toBe(false);
    expect(await verify({ cookie, formToken: raw, headers: { "Sec-Fetch-Site": "same-origin, cross-site" } })).toBe(false);
    expect(await verify({ cookie, formToken: raw, headers: { "Sec-Fetch-Site": "anything-else" } })).toBe(false);
    // A padded value is ACCEPTED, and for a reason that lives outside this
    // module: the Headers layer strips surrounding whitespace, so
    // `same-origin ` has already become `same-origin` by the time csrf.ts
    // reads it. Worth pinning because the exact-match comparison looks
    // whitespace-fragile at a glance, and a defensive `.trim()` added here
    // would be dead code hiding the fact that the platform already did it.
    expect(await verify({ cookie, formToken: raw, headers: { "Sec-Fetch-Site": "same-origin " } })).toBe(true);
  });

  it("accepts a request that sends neither Sec-Fetch-Site nor Origin", async () => {
    // Both checks are conditional on the header being present, because older
    // browsers send neither. Pinning this stops someone "hardening" the
    // module into rejecting header-less requests, which would lock out those
    // clients entirely -- and stops the reverse, a regression that skips the
    // checks when the headers ARE present, going unnoticed.
    const raw = "6".repeat(64);
    expect(await verify({ cookie: await signedCookie(raw), formToken: raw })).toBe(true);
  });

  it("treats a present-but-empty Origin or Sec-Fetch-Site as absent", async () => {
    // Documents current behaviour, not an endorsement of it: both checks are
    // guarded by the truthiness of the header value, so an empty string skips
    // the check entirely instead of failing it. No browser can produce this
    // -- both are forbidden header names, so page JS cannot blank them -- but
    // a proxy that normalised a missing header to an empty one would silently
    // switch both checks off, and this test is where that would be noticed.
    const raw = "7".repeat(64);
    const cookie = await signedCookie(raw);
    expect(await verify({ cookie, formToken: raw, headers: { Origin: "", "Sec-Fetch-Site": "" } })).toBe(true);
  });

  it("rejects any Origin that is not the request's own origin", async () => {
    // Scheme, host and port all count, and `null` (a sandboxed iframe or a
    // redirected cross-origin POST) is a string that matches nothing.
    const raw = "7".repeat(64);
    const cookie = await signedCookie(raw);
    const withOrigin = async (origin: string) => verify({ cookie, formToken: raw, headers: { Origin: origin } });
    expect(await withOrigin(ORIGIN)).toBe(true);
    expect(await withOrigin("https://evil.example")).toBe(false);
    expect(await withOrigin("https://admin.givefood.org.uk")).toBe(false); // sibling subdomain
    expect(await withOrigin("http://www.givefood.org.uk")).toBe(false); // scheme downgrade
    expect(await withOrigin("https://www.givefood.org.uk:8443")).toBe(false); // different port
    expect(await withOrigin("null")).toBe(false);
    // The two comparisons a careless rewrite reaches for. `startsWith` would
    // accept the suffixed domain and the port variant above; `includes` would
    // accept anything that merely mentions us.
    expect(await withOrigin("https://www.givefood.org.uk.evil.example")).toBe(false);
    expect(await withOrigin("https://evil.example/https://www.givefood.org.uk")).toBe(false);
    // Exact string equality, NOT URL normalisation: a trailing slash, an
    // explicit default port and a different case are all rejected even though
    // `new URL()` would call them the same origin. Browsers send the
    // normalised form, so this costs nothing and pins the cheap comparison.
    expect(await withOrigin(`${ORIGIN}/`)).toBe(false);
    expect(await withOrigin("https://www.givefood.org.uk:443")).toBe(false);
    expect(await withOrigin(ORIGIN.toUpperCase())).toBe(false);
  });

  it("compares Origin against the request URL, not a hardcoded hostname", async () => {
    // The Worker serves givefood.org.uk, the workers.dev preview URL and
    // local dev on http://localhost:8787 from the same code. If the origin
    // were pinned to production, the admin would be unusable everywhere else.
    const raw = "8".repeat(64);
    const cookie = await signedCookie(raw);
    const preview = "http://localhost:8787";
    expect(await verify({ cookie, formToken: raw, url: `${preview}/admin/`, headers: { Origin: preview } })).toBe(true);
    expect(await verify({ cookie, formToken: raw, url: `${preview}/admin/`, headers: { Origin: ORIGIN } })).toBe(false);
    // ...and the reverse pairing, so the test cannot pass by ignoring the URL
    // and simply accepting localhost.
    expect(await verify({ cookie, formToken: raw, url: PAGE, headers: { Origin: preview } })).toBe(false);
    // `.origin` of the request URL, so the path and query are irrelevant --
    // a deep admin URL with a query string still matches the plain origin.
    expect(await verify({ cookie, formToken: raw, url: `${ORIGIN}/admin/foodbank/x/edit/?tab=needs`, headers: { Origin: ORIGIN } })).toBe(true);
  });

  it("requires every check to pass, not just a majority", async () => {
    // Guards against a refactor that turns the chain of early returns into
    // something scoring or short-circuiting: a request with a perfect
    // cookie/field pair and a same-origin Origin is still rejected on a
    // cross-site Sec-Fetch-Site, and vice versa.
    const raw = "9".repeat(64);
    const cookie = await signedCookie(raw);
    expect(await verify({ cookie, formToken: raw, headers: { Origin: ORIGIN, "Sec-Fetch-Site": "cross-site" } })).toBe(false);
    expect(await verify({ cookie, formToken: raw, headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "same-origin" } })).toBe(false);
    // A perfect header pair does not rescue a bad cookie or a bad field
    // either -- the headers are the last checks, so a short-circuit that
    // returned true on "headers look fine" would show up only here.
    const goodHeaders = { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" };
    expect(await verify({ cookie: `__Host-csrf=${raw}.${"0".repeat(64)}`, formToken: raw, headers: goodHeaders })).toBe(false);
    expect(await verify({ cookie, formToken: "0".repeat(64), headers: goodHeaders })).toBe(false);
    expect(await verify({ cookie, formToken: raw, headers: goodHeaders })).toBe(true);
  });
});
