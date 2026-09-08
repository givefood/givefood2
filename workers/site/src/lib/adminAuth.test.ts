import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdminSession, handleGoogleOAuthCallback, handleSignOut, revokeAdminSession, safeNextPath, startGoogleOAuth } from "./adminAuth";
import type { AdminSessionData, GoogleIdTokenClaims } from "./adminAuth";
import type { AppEnv } from "../types";

// lib/adminAuth.ts's six exported functions, driven DIRECTLY rather than
// through the four /auth/ routes that wrap them. routes/admin/auth.test.ts
// already walks the browser-visible flow end to end and is the better place to
// look for "what does a sign-in do"; this file is about the library's own
// contract, and it exists because three of the things that contract promises
// are unreachable from the route layer:
//
//   * startGoogleOAuth() sanitises the `next` it is HANDED. adminAuthStart
//     calls safeNextPath() before calling it, so from the route's side the
//     library's own call is unobservable -- routes/admin/auth.test.ts says so
//     in as many words, having run the mutant and found it equivalent. Here
//     the raw query value is passed straight in, which is the only way to pin
//     that the library does not depend on its caller for that.
//   * getAdminSession() and revokeAdminSession() have no routes at all. Their
//     callers are middleware/adminAuth.ts (the gate on every /admin/* request)
//     and routes/admin/auth.ts, and what matters about them is what they do to
//     KV -- the sliding refresh's exact threshold, and the fact that a read
//     that crosses it does not then write again on the next read.
//   * the encodings. PKCE's verifier and challenge, the session id and the
//     signed cookie payload all go through the same base64url pair, and a
//     wrong one of those fails at Google's end or in a browser's cookie jar,
//     not here.
//
// REAL, NOT MOCKED, wherever one exists: a real Hono app, the real HMAC and
// cookie primitives, real 2048-bit RSA keys signing real ID tokens that the
// module verifies for real, and a Map-backed KVNamespace that stores what it
// is given. The only stubs are the two things that genuinely leave the machine
// -- Google's token endpoint and Google's JWKS -- because "did a session get
// written" is a claim about storage and a canned session object cannot make it.
//
// EVERY REFUSAL ASSERTS THE ABSENCE OF A SESSION, never just the status code.
// A 302 to /auth/ that had nonetheless written a session to KV is
// indistinguishable from a working refusal from the outside, and that is the
// shape of bug this whole area keeps producing.
//
// DJANGO PROVENANCE, ACTUALLY CHECKED. The module cites two things. The first
// is givefood/middleware.py's LoginRequiredAccess gate, read in the reference
// checkout, where line 68 is `if not email_verified or hosted_domain !=
// "givefood.org.uk":` -- the same two conditions the receiver applies below.
// The second is django.utils.http.url_has_allowed_host_and_scheme(), for
// safeNextPath, and that one was EXECUTED rather than reasoned about: Django
// 5.2.6 in /Users/jasoncartwright/Sites/foodcharity,
// `url_has_allowed_host_and_scheme(x, allowed_hosts=None)` over the inputs
// below. Where the port and Django disagree the test says which, quotes the
// call it ran, and pins the port.
//
// MUTATION-TESTED, 2026-09-08, in a copy of the tree under /private/tmp and
// never in the repo: 59 deliberate breakages -- 57 of lib/adminAuth.ts, plus
// timingSafeEqual reduced to a length comparison in lib/hmac.ts and parseCookie
// relaxed to a prefix match in lib/cookies.ts, both of which this module's
// promises rest on. Each was applied to that copy, this file re-run against it,
// and the file restored. The state check deleted, the RSA verify result
// ignored, the hosted-domain gate removed, the JWKS kid cache made
// age-only, the sliding refresh made unconditional, a field dropped from the
// stored session, redirect targets and status codes changed: 58 died.
//
// TWO SURVIVED THE FIRST PASS, and both are recorded rather than quietly
// dropped, because a survivor is the only real evidence about a test's worth:
//   * a __Host-oauth cookie living a hundred times longer than intended.
//     `toContain("Max-Age=600")` is satisfied by "Max-Age=60000"; both cookie
//     lifetimes are anchored assertions now, and the mutant dies.
//   * verifyOAuthCookie splitting at the LAST dot rather than the first. Left
//     alive deliberately: it is EQUIVALENT, not uncaught. The payload half is
//     base64url and the signature half is hex, so neither can contain a dot,
//     and on any other value both spellings fail the signature check. The
//     rewrite that is NOT equivalent -- `const [json, signature] =
//     value.split(".")`, which starts accepting a cookie with junk appended --
//     is a different mutant, and the test that names it kills it.

const ORIGIN = "https://www.givefood.org.uk";
const HOST = "www.givefood.org.uk";
// wrangler.jsonc:178's real client id, byte for byte the one hardcoded in
// gfauth/views.py's verify_oauth2_token() call -- the same Google OAuth client
// Django used, which is why /auth/receiver/ cannot be renamed.
const CLIENT_ID = "927281004707-tboi1tsphl4bgtqn72e76rmc7r2q22tk.apps.googleusercontent.com";
const CLIENT_SECRET = "test-google-client-secret";
const HMAC_KEY = "test-session-hmac-key";
const KID = "test-signing-key";
const ROTATED_KID = "test-signing-key-2";

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";
const SESSION_COOKIE = "__Host-gfsession";
const OAUTH_COOKIE = "__Host-oauth";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const OAUTH_COOKIE_MAX_AGE_SECONDS = 600;

const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

// ===================== base64url, independently implemented =====================

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeBase64UrlJson<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlBytes(value))) as T;
}

// ===================== an independent HMAC-SHA256 =====================
//
// Lifted from lib/csrf.test.ts, and for the same reason: signing the expected
// cookie with lib/hmac.ts's own helper would only prove the module agrees with
// itself. What is being pinned here is that signOAuthCookie() signs the
// base64url payload with SESSION_HMAC_KEY and in that ARGUMENT ORDER --
// hmacSha256Hex(secret, message). Reversed, the module still round-trips
// (sign and verify move together) and every functional test in this file stays
// green, while the state/PKCE cookie is being keyed on its own attacker-visible
// payload instead of on the secret.

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

// The oracle is only worth anything if it is itself right, so it is pinned to a
// published known-answer vector before being used to judge the module.
it("the test's own HMAC oracle matches RFC 4231 test case 2", async () => {
  expect(await rfc2104HmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
});

// ===================== forging what Google would send =====================

const RSA_PARAMS = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };

// Three real key pairs: the one Google publishes, the one it publishes AFTER a
// rotation, and one it never published. The difference between the first and
// the last is the entire point of the signature check, so none of them is a
// flag -- verifyGoogleIdToken does genuine RS256 verification against genuine
// key material in every test below.
const googleKeys = (await crypto.subtle.generateKey(RSA_PARAMS, true, ["sign", "verify"])) as CryptoKeyPair;
const rotatedKeys = (await crypto.subtle.generateKey(RSA_PARAMS, true, ["sign", "verify"])) as CryptoKeyPair;
const impostorKeys = (await crypto.subtle.generateKey(RSA_PARAMS, true, ["sign", "verify"])) as CryptoKeyPair;
// exportKey is typed as ArrayBuffer | JsonWebKey across its formats; "jwk"
// returns the object half, and only the RSA modulus/exponent are wanted.
const googlePublicJwk = (await crypto.subtle.exportKey("jwk", googleKeys.publicKey)) as JsonWebKey;
const rotatedPublicJwk = (await crypto.subtle.exportKey("jwk", rotatedKeys.publicKey)) as JsonWebKey;

// Shaped like Google's real https://www.googleapis.com/oauth2/v3/certs.
const GOOGLE_KEY_ENTRY = { kid: KID, kty: "RSA", alg: "RS256", use: "sig", n: googlePublicJwk.n, e: googlePublicJwk.e };
const ROTATED_KEY_ENTRY = { kid: ROTATED_KID, kty: "RSA", alg: "RS256", use: "sig", n: rotatedPublicJwk.n, e: rotatedPublicJwk.e };

// TYPE-ONLY LOAD-BEARING USE of the exported claims interface: every ID token
// in this file is built from a value declared as GoogleIdTokenClaims, so
// renaming or dropping a field on that interface (given_name -> givenName, say,
// which is exactly the sort of tidy-up that reads as harmless) fails to compile
// here rather than silently changing what createSession() stores.
function referenceClaims(): GoogleIdTokenClaims {
  return {
    sub: "104729000000000000001",
    email: "jason@givefood.org.uk",
    email_verified: true,
    hd: "givefood.org.uk",
    name: "Jason Cartwright",
    given_name: "Jason",
    picture: "https://lh3.googleusercontent.com/a/test-picture",
    aud: CLIENT_ID,
    iss: "https://accounts.google.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

interface IdTokenOptions {
  /** Claims to override on the reference token; `undefined` REMOVES the claim, which is a different token from an empty one. */
  claims?: Partial<Record<keyof GoogleIdTokenClaims, unknown>>;
  alg?: string;
  kid?: string;
  key?: CryptoKey;
  /** Replaces the signature segment wholesale, for the malformed-token cases. */
  signature?: string;
}

async function signIdToken(options: IdTokenOptions = {}): Promise<string> {
  const header = { alg: options.alg ?? "RS256", kid: options.kid ?? KID, typ: "JWT" };
  const payload: Record<string, unknown> = { ...referenceClaims() };
  for (const [key, value] of Object.entries(options.claims ?? {})) {
    if (value === undefined) delete payload[key];
    else payload[key] = value;
  }

  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", options.key ?? googleKeys.privateKey, new TextEncoder().encode(signingInput));
  return `${signingInput}.${options.signature ?? base64Url(new Uint8Array(signature))}`;
}

// ===================== the bindings =====================

interface KvPut {
  key: string;
  value: string;
  expirationTtl: number | undefined;
}

interface StoredSession {
  email: string;
  name: string;
  givenName: string;
  picture: string;
  expiresAt: number;
}

// Enough of KVNamespace for lib/adminAuth.ts, plus a log of every call, so
// "this read did not write" and "sign-out really deleted the key" are
// assertable rather than assumed. Deliberately NOT TTL-aware: KV expiry is
// Cloudflare's job, and the tests that seed an already-expired record are
// pinning what this module does when the record is still there.
function createSessionKv() {
  const store = new Map<string, string>();
  const puts: KvPut[] = [];
  const gets: string[] = [];
  const deletes: string[] = [];
  const namespace = {
    get: async (key: string) => {
      gets.push(key);
      return store.get(key) ?? null;
    },
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
      puts.push({ key, value, expirationTtl: options?.expirationTtl });
      store.set(key, value);
    },
    delete: async (key: string) => {
      deletes.push(key);
      store.delete(key);
    },
  };
  return { namespace: namespace as unknown as KVNamespace, store, puts, gets, deletes };
}

let kv: ReturnType<typeof createSessionKv>;
let env: AppEnv["Bindings"];
let app: Hono<AppEnv>;

// getAdminSession's return value, captured inside the handler rather than
// serialised through a response body: JSON.stringify drops undefined-valued
// keys, and one of the tests below is specifically about a record that produces
// them. `undefined` here means "the probe was never reached".
let lastSession: AdminSessionData | null | undefined;

let tokenResponse: () => Response;
let jwksDocument: { keys: unknown[] };
let jwksResponse: () => Response;
let tokenRequests: URLSearchParams[];
let jwksFetches: number;

function sessionKey(sessionId: string): string {
  return `admin-session:${sessionId}`;
}

function storedSessions(): [string, StoredSession][] {
  return [...kv.store.entries()].map(([key, value]) => [key, JSON.parse(value) as StoredSession]);
}

beforeEach(() => {
  kv = createSessionKv();
  env = {
    SESSIONS: kv.namespace,
    SESSION_HMAC_KEY: HMAC_KEY,
    GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
  lastSession = undefined;

  // The library's functions mounted as their real callers mount them -- the
  // three flow handlers at the URLs index.ts:663-665 registers (the receiver
  // path is a registered Google redirect URI and cannot move), and the two
  // session helpers behind probe routes, because their real callers are
  // middleware, not routes.
  //
  // `next` is handed to startGoogleOAuth RAW, exactly as it arrived in the
  // query string. adminAuthStart passes it through safeNextPath first; this
  // file deliberately does not, so that the library's own sanitising call is
  // observable.
  app = new Hono<AppEnv>();
  app.get("/auth/start/", (c) => startGoogleOAuth(c, c.req.query("next")));
  app.get("/auth/receiver/", (c) => handleGoogleOAuthCallback(c));
  app.get("/auth/sign-out/", (c) => handleSignOut(c));
  app.get("/probe/session/", async (c) => {
    lastSession = await getAdminSession(c);
    return c.text(lastSession ? "session" : "none");
  });
  app.get("/probe/revoke/", async (c) => {
    await revokeAdminSession(c);
    return c.text("revoked");
  });
  // A handler that had already set an unrelated cookie before revoking, which
  // is what every real sign-out-adjacent response looks like.
  app.get("/probe/revoke-after-cookie/", async (c) => {
    c.header("Set-Cookie", "__Host-csrf=abc.def; Secure; HttpOnly; SameSite=Lax; Path=/", { append: true });
    await revokeAdminSession(c);
    return c.text("revoked");
  });

  tokenRequests = [];
  jwksFetches = 0;
  tokenResponse = () => new Response("{}", { status: 200 });
  jwksDocument = { keys: [GOOGLE_KEY_ENTRY] };
  jwksResponse = () => new Response(JSON.stringify(jwksDocument), { status: 200 });

  // Google's two endpoints and nothing else: anything else reaching the network
  // from this module is a bug in its own right, so the stub throws rather than
  // quietly answering.
  vi.stubGlobal("fetch", async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    if (url === GOOGLE_JWKS_URI) {
      jwksFetches += 1;
      return jwksResponse();
    }
    if (url === GOOGLE_TOKEN_ENDPOINT) {
      tokenRequests.push(new URLSearchParams(init?.body ?? ""));
      return tokenResponse();
    }
    throw new Error(`unexpected outbound fetch: ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

interface RequestOptions {
  cookie?: string;
  /** Omit the Host header entirely by passing null -- a request with no Host at all is a real case for oauthOrigin(). */
  host?: string | null;
  /** The scheme/host of the request URL itself, which is where oauthOrigin() takes the protocol from. */
  base?: string;
}

async function request(path: string, options: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.host !== null) headers.Host = options.host ?? HOST;
  if (options.cookie !== undefined) headers.Cookie = options.cookie;
  return await app.fetch(new Request(`${options.base ?? ORIGIN}${path}`, { headers }), env, execCtx);
}

function setCookieNamed(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
}

/** The `name=value` a browser would send back, taken from the response's own Set-Cookie. */
function cookieHeaderFrom(res: Response, name: string): string {
  const setCookie = setCookieNamed(res, name);
  if (!setCookie) throw new Error(`no ${name} cookie on the response`);
  return setCookie.split(";")[0]!;
}

interface OAuthCookiePayload {
  state: string;
  codeVerifier: string;
  next: string;
}

// Reads the __Host-oauth cookie the way the module writes it, verifying the
// signature with the INDEPENDENT oracle first: if the signature ever stopped
// being a signature over the payload with the secret, every state/PKCE
// assertion below would otherwise pass on an unsigned blob.
async function readOAuthCookie(res: Response): Promise<OAuthCookiePayload> {
  const value = cookieHeaderFrom(res, OAUTH_COOKIE).slice(OAUTH_COOKIE.length + 1);
  const dot = value.indexOf(".");
  const json = value.slice(0, dot);
  expect(value.slice(dot + 1)).toBe(await rfc2104HmacSha256Hex(HMAC_KEY, json));
  return decodeBase64UrlJson<OAuthCookiePayload>(json);
}

/** A __Host-oauth cookie signed with a secret of the test's choosing -- for forgeries, and for payloads startGoogleOAuth would never mint. */
async function forgedOAuthCookie(payload: unknown, secret = HMAC_KEY): Promise<string> {
  const json = base64UrlJson(payload);
  return `${OAUTH_COOKIE}=${json}.${await rfc2104HmacSha256Hex(secret, json)}`;
}

interface StartedFlow {
  res: Response;
  cookie: string;
  payload: OAuthCookiePayload;
  authorizeUrl: URL;
}

async function startFlow(next?: string, options: RequestOptions = {}): Promise<StartedFlow> {
  const query = next === undefined ? "" : `?${new URLSearchParams({ next }).toString()}`;
  const res = await request(`/auth/start/${query}`, options);
  expect(res.status).toBe(302);
  return { res, cookie: cookieHeaderFrom(res, OAUTH_COOKIE), payload: await readOAuthCookie(res), authorizeUrl: new URL(res.headers.get("Location")!) };
}

function receiver(params: Record<string, string>, cookie?: string, options: RequestOptions = {}): Promise<Response> {
  return request(`/auth/receiver/?${new URLSearchParams(params).toString()}`, { ...options, cookie });
}

/** Start to finish: the authorize hop, Google's redirect back, and the token exchange. */
async function completeSignIn(next?: string, token: IdTokenOptions = {}, options: RequestOptions = {}): Promise<{ res: Response; sessionCookie: string; flow: StartedFlow }> {
  const flow = await startFlow(next, options);
  const idToken = await signIdToken(token);
  tokenResponse = () => new Response(JSON.stringify({ id_token: idToken, access_token: "ya29.test" }), { status: 200 });
  const res = await receiver({ code: "4/0AeanS0-test-authorization-code", state: flow.payload.state }, flow.cookie, options);
  return { res, sessionCookie: cookieHeaderFrom(res, SESSION_COOKIE), flow };
}

/** Seeds KV with a session written `writtenMsAgo` milliseconds ago, which is what the sliding refresh keys off. */
function seedSession(id: string, writtenMsAgo: number, overrides: Partial<StoredSession> = {}): void {
  kv.store.set(
    sessionKey(id),
    JSON.stringify({
      email: "jason@givefood.org.uk",
      name: "Jason Cartwright",
      givenName: "Jason",
      picture: "https://lh3.googleusercontent.com/a/test-picture",
      expiresAt: Date.now() - writtenMsAgo + SESSION_TTL_SECONDS * 1000,
      ...overrides,
    }),
  );
}

// ===================== safeNextPath =====================

describe("safeNextPath", () => {
  // Django's url_has_allowed_host_and_scheme(), which gfauth/views.py applies
  // to the `next_url` it pops out of the session before honouring it. The port
  // applies the same idea at a different moment -- once, on the way IN, with
  // the result sealed into the signed __Host-oauth cookie -- so this is the
  // only place the check happens for the whole flow.
  it("returns a same-origin path unchanged, query string, fragment and accents included", () => {
    // Identity, not normalisation: the value goes into the cookie and comes
    // back out as a Location header, so anything this function rewrote would
    // silently move the admin somewhere other than where they were going.
    // Issue #31 is the query-string half -- nineteen admin routes read ?page=,
    // ?sort= and ?q=, and a `next` stripped of its query bounces the maintainer
    // to a defaulted page.
    for (const path of [
      "/",
      "/admin/",
      "/admin/foodbank/salisbury/",
      "/admin/items/?page=4&sort=-calories",
      "/admin/foodbank/caffè-food-bank/",
      "/admin/#needs",
      "/admin/foodbank/x/?q=a%20b",
      "/admin/../etc/",
    ]) {
      expect(safeNextPath(path)).toBe(path);
    }
  });

  it("falls back to /admin/ when there is no next at all", () => {
    // All three spellings a caller can produce: the query param absent
    // (undefined), a `?next=` with nothing after it (empty string), and null
    // for a caller reading from something nullable.
    expect(safeNextPath(undefined)).toBe("/admin/");
    expect(safeNextPath(null)).toBe("/admin/");
    expect(safeNextPath("")).toBe("/admin/");
  });

  it("refuses an absolute URL", () => {
    // The whole point of the check. Without it, /auth/?next=https://evil.example
    // survives into the cookie and the receiver hands the admin's browser a
    // Location header pointing off-site immediately after a real sign-in --
    // which is the moment they are most likely to trust the page they land on.
    for (const hostile of ["https://evil.example/", "http://evil.example", "https://www.givefood.org.uk/admin/", "javascript:alert(1)", "data:text/html,x"]) {
      expect(safeNextPath(hostile)).toBe("/admin/");
    }
  });

  it("refuses a protocol-relative URL, which browsers treat as absolute", () => {
    // "//evil.example/" has no scheme, so it reads as a path to anything doing
    // a naive startsWith("/") check -- and as https://evil.example/ to a
    // browser. Django's own helper calls out the same case.
    expect(safeNextPath("//evil.example/")).toBe("/admin/");
    expect(safeNextPath("//evil.example")).toBe("/admin/");
    expect(safeNextPath("///evil.example")).toBe("/admin/");
    expect(safeNextPath("//")).toBe("/admin/");
  });

  it("refuses anything that does not begin with a slash", () => {
    // Including "http:/admin/" -- one slash, so urlsplit reads a scheme with no
    // host, which Chrome would still resolve off-site. Django 5.2.6 rejects it
    // too (verified: url_has_allowed_host_and_scheme("http:/admin/",
    // allowed_hosts=None) is False).
    for (const hostile of ["admin/", "http:/admin/", "evil.example/admin/", "\\\\evil.example"]) {
      expect(safeNextPath(hostile)).toBe("/admin/");
    }
  });

  // A DIVERGENCE FROM DJANGO, IN THE SAFE DIRECTION, pinned so it is not
  // mistaken for a bug when someone diffs the two. Django strips the value
  // first (`url = url.strip()`), so " /admin/" is accepted and honoured there;
  // this check sees a leading space, fails startsWith("/") and defaults.
  // Verified against Django 5.2.6 in the reference checkout:
  // url_has_allowed_host_and_scheme(" /admin/", allowed_hosts=None) is True.
  it("defaults a leading-whitespace path that Django would have stripped and honoured", () => {
    expect(safeNextPath(" /admin/")).toBe("/admin/");
    expect(safeNextPath("\t/admin/foodbank/x/")).toBe("/admin/");
  });

  // SUSPECT, PINNED AS-IS (reported, not fixed -- a red test helps nobody).
  // This is the other direction, and it is the one that matters: Django's
  // helper checks the URL twice, once as given and once with every backslash
  // replaced by a forward slash, precisely because "Chrome treats \ completely
  // as / in paths". Verified against Django 5.2.6 in the reference checkout:
  // url_has_allowed_host_and_scheme("/\\evil.example/", allowed_hosts=None) is
  // False. This check only looks for a literal "//" prefix, so the backslash
  // spelling survives into the cookie and, after a genuine sign-in, into the
  // Location header -- see the receiver test that follows it all the way there.
  it("keeps a backslash-prefixed next that Django's own check would have rejected", () => {
    expect(safeNextPath("/\\evil.example/")).toBe("/\\evil.example/");
    expect(safeNextPath("/\\\\evil.example")).toBe("/\\\\evil.example");
  });

  // The check is a prefix test on the raw string, so an encoded or
  // mid-string "//" is untouched -- correctly, since neither is off-site.
  it("looks only at the start of the value, not for slashes anywhere in it", () => {
    expect(safeNextPath("/admin/?next=//evil.example")).toBe("/admin/?next=//evil.example");
    expect(safeNextPath("/%2f%2fevil.example")).toBe("/%2f%2fevil.example");
  });
});

// ===================== startGoogleOAuth =====================

describe("startGoogleOAuth", () => {
  it("redirects to Google's authorize endpoint with every parameter Google requires", async () => {
    const { res, authorizeUrl, payload } = await startFlow("/admin/foodbank/salisbury/");

    expect(res.status).toBe(302);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(authorizeUrl.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/receiver/`);
    expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizeUrl.searchParams.get("scope")).toBe("openid email profile");
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    // A login hint only: it narrows Google's account chooser to the Workspace.
    // The authorization decision is the `hd` claim on the token that comes
    // back, and the gate tests below prove it is not this parameter doing it.
    expect(authorizeUrl.searchParams.get("hd")).toBe("givefood.org.uk");
    // The state on the wire is the state in the signed cookie. If these came
    // from different places the receiver's CSRF check would be comparing a
    // value with itself and would pass for anybody.
    expect(authorizeUrl.searchParams.get("state")).toBe(payload.state);
    // ...and no `next` on the wire at all: it travels in the signed cookie, so
    // nothing between the two hops can rewrite where the admin lands.
    expect(authorizeUrl.searchParams.get("next")).toBeNull();
  });

  it("sends a code_challenge that really is S256 of the verifier in the cookie", async () => {
    // PKCE executed rather than assumed. Google recomputes this pair at the
    // token endpoint; a challenge derived from anything else fails the exchange
    // in production and nowhere else, because nothing local ever checks it.
    const { authorizeUrl, payload } = await startFlow();

    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload.codeVerifier));
    expect(authorizeUrl.searchParams.get("code_challenge")).toBe(base64Url(new Uint8Array(digest)));
  });

  it("draws 24 bytes of state and 32 of verifier from the CSPRNG, in that order", async () => {
    // The same invariants made deterministic, which is what turns "looks
    // random" into a proof of the encoding. With the byte stream pinned the
    // expected strings are fully determined, so this fails outright if the
    // draw sizes change, if the bytes are emitted in the wrong order, or if
    // base64UrlEncode stops being URL-safe or stops stripping its padding.
    //
    // Stubbing also pins the SOURCE. Math.random() would produce
    // equally plausible-looking strings and pass every other test here while
    // making the state guessable -- and a guessable state is a defeated
    // login-CSRF check. The real `subtle` is carried over because the module
    // still has to HMAC the cookie and SHA-256 the verifier for real.
    const sizes: number[] = [];
    const getRandomValues = vi.fn((array: Uint8Array) => {
      sizes.push(array.length);
      for (let i = 0; i < array.length; i++) array[i] = i;
      return array;
    });
    vi.stubGlobal("crypto", { subtle: crypto.subtle, getRandomValues });
    let payload: OAuthCookiePayload;
    let authorizeUrl: URL;
    try {
      const started = await startFlow("/admin/");
      payload = started.payload;
      authorizeUrl = started.authorizeUrl;
    } finally {
      vi.unstubAllGlobals();
    }

    expect(getRandomValues).toHaveBeenCalledTimes(2);
    expect(sizes).toEqual([24, 32]);
    expect(payload.state).toBe("AAECAwQFBgcICQoLDA0ODxAREhMUFRYX");
    expect(payload.codeVerifier).toBe("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
    expect(authorizeUrl.searchParams.get("code_challenge")).toBe("6oZqdX5MOLq_qBJ8vppAnT4fk6AP8UiP9zX8-Rev_9A");
  });

  it("emits a verifier RFC 7636 will accept: 43 unreserved characters, no padding", async () => {
    // RFC 7636 §4.1 constrains the verifier to 43-128 characters from
    // [A-Za-z0-9-._~]. Standard base64 would put "+" and "/" in it and leave a
    // trailing "=", all three of which are outside that set -- Google rejects
    // the exchange, and the failure appears only against the real token
    // endpoint. 32 bytes base64url-encoded is exactly the 43-character minimum.
    // Sampled repeatedly because "+" and "/" appear in only some encodings, so
    // a single draw would wave most of the failures through.
    for (let i = 0; i < 20; i++) {
      const { payload } = await startFlow();
      expect(payload.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(payload.state).toMatch(/^[A-Za-z0-9_-]{32}$/);
    }
  });

  it("mints a fresh state and verifier on every click", async () => {
    // A fixed state or verifier makes both the CSRF and the PKCE check
    // decorative: an attacker who observed one flow could complete another.
    const states = new Set<string>();
    const verifiers = new Set<string>();
    for (let i = 0; i < 16; i++) {
      const { payload } = await startFlow();
      states.add(payload.state);
      verifiers.add(payload.codeVerifier);
    }
    expect(states.size).toBe(16);
    expect(verifiers.size).toBe(16);
  });

  // THE MUTANT routes/admin/auth.test.ts CANNOT KILL. adminAuthStart sanitises
  // `next` before calling this, so from the route's side deleting
  // safeNextPath() from `next: safeNextPath(next)` changes nothing observable
  // -- that suite ran it and recorded it as equivalent. Called directly with
  // the raw query value, as here, the library either sanitises or it does not.
  // It matters because the library is the last checkpoint: whatever lands in
  // the cookie is what the receiver will redirect to, with no further checks.
  it("sanitises the next it is handed rather than trusting its caller", async () => {
    expect((await startFlow("https://evil.example/steal")).payload.next).toBe("/admin/");
    expect((await startFlow("//evil.example/steal")).payload.next).toBe("/admin/");
    expect((await startFlow("")).payload.next).toBe("/admin/");
    expect((await startFlow()).payload.next).toBe("/admin/");
    expect((await startFlow("/admin/foodbank/salisbury/location/new/")).payload.next).toBe("/admin/foodbank/salisbury/location/new/");
  });

  it("round-trips a non-ASCII next through the cookie as UTF-8", async () => {
    // Reachable in production: middleware/adminAuth.ts builds `next` from
    // c.req.path, which Hono has already percent-decoded, so an admin URL with
    // an accented slug arrives here as literal UTF-8. base64UrlEncode goes
    // through TextEncoder first for exactly this reason -- btoa() over the JSON
    // string would mangle U+0080..U+00FF and throw outright above that, which
    // is a 500 on the sign-in click rather than a sign-in.
    const path = "/admin/foodbank/caffè-食堂/?q=ü";
    expect((await startFlow(path)).payload.next).toBe(path);
  });

  it("stores state, verifier and next in one signed __Host- cookie", async () => {
    // __Host- is browser-enforced: Secure, Path=/, no Domain, or the cookie is
    // silently dropped and every sign-in fails the state check with nothing in
    // the logs. SameSite=Lax rather than Strict is required, not incidental --
    // Google's redirect back to /auth/receiver/ is a cross-site top-level
    // navigation, and Strict would withhold this cookie on exactly that hop.
    const { res, payload } = await startFlow("/admin/needs/");
    const cookie = setCookieNamed(res, OAUTH_COOKIE)!;

    expect(cookie).toContain("; Secure");
    expect(cookie).toContain("; HttpOnly");
    expect(cookie).toContain("; SameSite=Lax");
    expect(cookie).toMatch(/; Path=\/(;|$)/);
    expect(cookie).not.toContain("Domain=");
    expect(cookie).not.toContain("SameSite=None");
    // Ten minutes: long enough for a real sign-in including an account chooser
    // and a 2FA prompt, short enough that a stale cookie is not a lingering
    // replay surface. ANCHORED AT BOTH ENDS, and that is not fussiness -- a
    // toContain("Max-Age=600") is satisfied by "Max-Age=60000", so the one
    // mutant that survived the first mutation run of this file (2026-09-08) was
    // a cookie living a hundred times longer than intended.
    expect(cookie).toMatch(new RegExp(`; Max-Age=${OAUTH_COOKIE_MAX_AGE_SECONDS}(;|$)`));
    expect(res.headers.getSetCookie()).toHaveLength(1);
    expect(payload.next).toBe("/admin/needs/");
  });

  it("signs the cookie with HMAC-SHA256 over the base64url payload, keyed on the secret", async () => {
    // Checked against the independent oracle, so the key, the message and the
    // argument order are all pinned. Without the signature the receiver would
    // accept any state and verifier a visitor cared to type, which is the
    // entire login-CSRF and PKCE defence gone.
    const { res } = await startFlow("/admin/");
    const value = cookieHeaderFrom(res, OAUTH_COOKIE).slice(OAUTH_COOKIE.length + 1);
    const [json, signature] = [value.slice(0, value.indexOf(".")), value.slice(value.indexOf(".") + 1)];

    expect(signature).toBe(await rfc2104HmacSha256Hex(HMAC_KEY, json));
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    // Not signed with the payload as the key, and not over the whole cookie:
    // both are plausible-looking 64-hex signatures that would round-trip.
    expect(signature).not.toBe(await rfc2104HmacSha256Hex(json, HMAC_KEY));
    expect(signature).not.toBe(await rfc2104HmacSha256Hex(HMAC_KEY, `${OAUTH_COOKIE}=${json}`));
  });

  it("writes nothing to KV and talks to nobody -- there is no session yet", async () => {
    // Clicking "Sign in with Google" must not create an admin. A start hop that
    // wrote to KV would be a way to mint a session without ever visiting
    // Google, which is the same shape of bug as the auto-redirect this route
    // was split out to fix.
    await startFlow("/admin/needs/");
    await startFlow();

    expect(kv.puts).toEqual([]);
    expect(kv.gets).toEqual([]);
    expect(kv.store.size).toBe(0);
    expect(tokenRequests).toEqual([]);
    expect(jwksFetches).toBe(0);
  });

  // oauthOrigin(). redirect_uri has to byte-match a URI registered on the OAuth
  // client AND match the one sent to the token endpoint, so it cannot simply
  // reflect an incoming Host header -- but beta.givefood.org.uk is PLAN.md's
  // documented proving-ground host and has to work standalone.
  describe("redirect_uri, which Google matches byte for byte", () => {
    it("uses the host the request really arrived on, for both registered hosts", async () => {
      expect((await startFlow(undefined, { host: HOST })).authorizeUrl.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/receiver/`);
      expect((await startFlow(undefined, { host: "beta.givefood.org.uk" })).authorizeUrl.searchParams.get("redirect_uri")).toBe(
        "https://beta.givefood.org.uk/auth/receiver/",
      );
    });

    it("takes the scheme from the request URL, so wrangler dev gets http", async () => {
      // MUTANT KILLED (2026-09-08): hardcoding "https://" in oauthOrigin(). It
      // survives the other 86 tests in this file, which all run over https, and
      // dies only here and in the sibling test below -- and
      // `wrangler dev` serves http://localhost:8787, where an https
      // redirect_uri is a URI nobody registered and a sign-in that cannot
      // complete locally.
      const dev = await startFlow(undefined, { host: "localhost:8787", base: "http://localhost:8787" });

      expect(dev.authorizeUrl.searchParams.get("redirect_uri")).toBe("http://localhost:8787/auth/receiver/");
    });

    it("recognises both spellings of the dev host", async () => {
      // `wrangler dev --ip 127.0.0.1` prints the numeric form. They are not
      // interchangeable to a string comparison, and a dev session on the
      // spelling that is not allowed would be handed PRODUCTION's redirect_uri.
      const named = await startFlow(undefined, { host: "localhost:8787", base: "http://localhost:8787" });
      const numeric = await startFlow(undefined, { host: "127.0.0.1:8787", base: "http://127.0.0.1:8787" });

      expect(named.authorizeUrl.searchParams.get("redirect_uri")).toBe("http://localhost:8787/auth/receiver/");
      expect(numeric.authorizeUrl.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8787/auth/receiver/");
    });

    it("falls back to SITE_DOMAIN for a host it does not recognise", async () => {
      // The security half: an unrecognised Host header never becomes a
      // redirect_uri. Including the ones that look almost right -- the
      // comparison is exact and case-sensitive, and a bare "localhost" with no
      // port does not match the "localhost:" prefix test.
      for (const host of ["evil.example", "givefood.org.uk", "www.givefood.org.uk.evil.example", "WWW.GIVEFOOD.ORG.UK", "localhost", "127.0.0.1"]) {
        const { authorizeUrl } = await startFlow(undefined, { host });
        expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/receiver/`);
      }
    });

    it("falls back to SITE_DOMAIN when the request carries no Host header at all", async () => {
      const { authorizeUrl } = await startFlow(undefined, { host: null });

      expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/receiver/`);
    });

    // SUSPECT, PINNED AS-IS (reported, not fixed). The allowlist is an exact
    // match for the two production hosts but a PREFIX test for the dev ones, so
    // any Host header beginning "localhost:" or "127.0.0.1:" is reflected into
    // redirect_uri verbatim -- including one an attacker chose. The module's own
    // comment says it "never trusts an unrecognised Host header into a
    // redirect_uri", and for these two prefixes that is not quite true.
    //
    // Not an open redirect today, and that is why it is pinned rather than
    // treated as a break-glass: Google refuses any redirect_uri not registered
    // on the client, so the only reachable outcome is a redirect_uri_mismatch
    // error page. It would become one the day a wildcard or a localhost URI is
    // registered.
    it("reflects any host beginning localhost: or 127.0.0.1: into the redirect_uri", async () => {
      const spoofed = await startFlow(undefined, { host: "localhost:8787.evil.example" });

      expect(spoofed.authorizeUrl.searchParams.get("redirect_uri")).toBe("https://localhost:8787.evil.example/auth/receiver/");
    });
  });

  it("fails closed with no SESSION_HMAC_KEY, setting no cookie", async () => {
    // An unsigned state cookie would be worse than none at all, so this stops
    // before Google rather than sending the admin off to come back with a code
    // nothing can verify. Both realistic unset shapes: a missing binding and a
    // present-but-blank one.
    for (const secret of ["", undefined]) {
      env = { ...env, SESSION_HMAC_KEY: secret } as AppEnv["Bindings"];
      const res = await request("/auth/start/?next=%2Fadmin%2F");

      expect(res.status).toBe(500);
      expect(await res.text()).toBe("Auth not configured");
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(res.headers.get("Location")).toBeNull();
    }
  });

  // SUSPECT, PINNED AS-IS. Only SESSION_HMAC_KEY is guarded: an unset
  // GOOGLE_OAUTH_CLIENT_ID still redirects, with the literal string "undefined"
  // as the client_id, so the admin meets Google's own "invalid_client" page
  // rather than this module's "Auth not configured". Worth knowing when
  // diagnosing a deployment: the two failures look nothing alike.
  it("still redirects to Google when the client id binding is missing", async () => {
    env = { ...env, GOOGLE_OAUTH_CLIENT_ID: undefined } as unknown as AppEnv["Bindings"];

    const res = await request("/auth/start/");

    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("Location")!).searchParams.get("client_id")).toBe("undefined");
  });
});

// ===================== getAdminSession =====================

describe("getAdminSession", () => {
  it("returns exactly the four identity fields, and no more", async () => {
    // toEqual, not toMatchObject, and deliberately: `expiresAt` lives in the
    // stored record and must NOT come back out. Every admin page renders this
    // object into its template context (routes/admin/pageContext.ts), and a
    // fifth key appearing here is a fifth key in template scope.
    const { sessionCookie } = await completeSignIn();

    await request("/probe/session/", { cookie: sessionCookie });

    expect(lastSession).toEqual({
      email: "jason@givefood.org.uk",
      name: "Jason Cartwright",
      givenName: "Jason",
      picture: "https://lh3.googleusercontent.com/a/test-picture",
    });
  });

  it("returns null and touches KV not at all when there is no session cookie", async () => {
    // The common case -- every anonymous request to the public site that
    // happens to pass through the gate -- so it must not cost a KV read.
    await request("/probe/session/", {});
    await request("/probe/session/", { cookie: "" });
    await request("/probe/session/", { cookie: "_ga=GA1.1.99; __Host-csrf=abc.def" });

    expect(lastSession).toBeNull();
    expect(kv.gets).toEqual([]);
  });

  it("returns null for a session id KV has never held, having asked for the right key", async () => {
    // An expired session, a cookie left over from a redeployed environment, or
    // somebody guessing. Reads as signed out rather than throwing -- and the
    // key asked for is pinned, because a wrong prefix here means every session
    // lookup misses and nobody can ever stay signed in.
    await request("/probe/session/", { cookie: `${SESSION_COOKIE}=nosuchsession` });

    expect(lastSession).toBeNull();
    expect(kv.gets).toEqual(["admin-session:nosuchsession"]);
  });

  it("finds its cookie in a real browser's jar, matching the name exactly", async () => {
    // An admin request carries __Host-csrf and whatever else the site has set,
    // and a look-alike left over from a rename is exactly the thing that
    // accumulates in a jar that has been through a deploy or two. A relaxed
    // name match (startsWith/includes) hands the look-alike's value to KV,
    // finds nothing, and signs the maintainer out with no error anywhere.
    const { sessionCookie } = await completeSignIn();
    const jar = `__Host-csrf=abc123.def456; __Host-gfsession-old=stale-session-id; ${sessionCookie}; _plausible=1`;

    await request("/probe/session/", { cookie: jar });

    expect(lastSession?.email).toBe("jason@givefood.org.uk");
    expect(kv.gets).not.toContain(sessionKey("stale-session-id"));
  });

  it("treats an unparseable record as signed out rather than throwing", async () => {
    // KV is eventually consistent and has been written to by more than one
    // deploy of this code. A JSON.parse failure here must read as "not signed
    // in" -- the gate turns null into a redirect, and an exception into a 500
    // on every admin page at once.
    kv.store.set(sessionKey("corrupt"), "{not json");

    const res = await request("/probe/session/", { cookie: `${SESSION_COOKIE}=corrupt` });

    expect(res.status).toBe(200);
    expect(lastSession).toBeNull();
  });

  // SUSPECT, PINNED AS-IS (reported, not fixed). The try/catch covers JSON
  // syntax, not JSON SHAPE. A record that parses to a non-object still walks
  // through: `stored.expiresAt` is undefined, the refresh arithmetic is NaN
  // (so no write), and the function returns an object of four undefineds --
  // which is TRUTHY, so middleware/adminAuth.ts would set it as `adminUser` and
  // let the request through. A record parsing to null throws outright, because
  // null.expiresAt is a TypeError the catch above it never sees.
  //
  // Neither is reachable in production: nothing but createSession() writes
  // these keys and it always writes an object. Pinned because "the parse is
  // guarded" reads as "the shape is guarded", and it is not.
  it("lets a record that parses to a non-object through as a session of undefineds", async () => {
    kv.store.set(sessionKey("scalar"), '"a bare string"');

    await request("/probe/session/", { cookie: `${SESSION_COOKIE}=scalar` });

    expect(lastSession).not.toBeNull();
    expect(lastSession).toEqual({ email: undefined, name: undefined, givenName: undefined, picture: undefined });
    expect(kv.puts).toEqual([]); // NaN > threshold is false, so no refresh either
  });

  it("throws on a record that parses to null, where the try/catch does not reach", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    kv.store.set(sessionKey("nullish"), "null");

    const res = await request("/probe/session/", { cookie: `${SESSION_COOKIE}=nullish` });

    expect(res.status).toBe(500);
    logged.mockRestore();
  });

  // THE ONE WRITE A READ IS ALLOWED TO MAKE, pinned in both directions because
  // it is a deliberate, documented trade-off. KV allows roughly one write per
  // second per key, and re-putting on every admin page view would turn the
  // write-per-request cost this design chose KV to avoid into a KV
  // write-per-request instead. So the window slides, but only past halfway.
  describe("the sliding refresh, at its exact threshold", () => {
    // Frozen time: the boundary is `age > 6h` to the millisecond, and a test
    // that computed it from a moving Date.now() would be pinning the machine's
    // speed rather than the threshold.
    const NOW = Date.parse("2026-09-08T12:00:00.000Z");
    const SIX_HOURS = 6 * 60 * 60 * 1000;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    });

    it("leaves a session written exactly six hours ago alone", async () => {
      // The comparison is `>`, not `>=`. One millisecond either side of this is
      // the whole difference between a write and no write.
      seedSession("boundary", SIX_HOURS);

      await request("/probe/session/", { cookie: `${SESSION_COOKIE}=boundary` });

      expect(kv.puts).toEqual([]);
      expect(lastSession?.email).toBe("jason@givefood.org.uk");
    });

    it("extends a session one millisecond past six hours", async () => {
      seedSession("stale", SIX_HOURS + 1);

      await request("/probe/session/", { cookie: `${SESSION_COOKIE}=stale` });

      expect(kv.puts).toHaveLength(1);
      expect(kv.puts[0]!.key).toBe(sessionKey("stale"));
      // The TTL goes back to a full twelve hours, and the stored expiresAt is
      // slid forward to match. A refresh that rewrote the record while keeping
      // the old expiresAt would log the admin out on the original schedule
      // while still paying for the write.
      expect(kv.puts[0]!.expirationTtl).toBe(SESSION_TTL_SECONDS);
      const refreshed = JSON.parse(kv.puts[0]!.value) as StoredSession;
      expect(refreshed.expiresAt).toBe(NOW + SESSION_TTL_SECONDS * 1000);
      // ...carrying the same identity. A refresh that dropped a field would
      // blank the admin's name and photograph on their next page view.
      expect(refreshed).toEqual({
        email: "jason@givefood.org.uk",
        name: "Jason Cartwright",
        givenName: "Jason",
        picture: "https://lh3.googleusercontent.com/a/test-picture",
        expiresAt: NOW + SESSION_TTL_SECONDS * 1000,
      });
      // The caller gets the identity either way -- the refresh is invisible.
      expect(lastSession).toEqual({
        email: "jason@givefood.org.uk",
        name: "Jason Cartwright",
        givenName: "Jason",
        picture: "https://lh3.googleusercontent.com/a/test-picture",
      });
    });

    it("does not write again on the very next read, which is what bounds the write rate", async () => {
      // THE POINT OF THE WHOLE MECHANISM, and the thing a "refresh on every
      // read" regression breaks without changing a single visible behaviour:
      // an admin page pulls this several times a second across its subrequests,
      // and KV's ~1 write/sec/key limit would start dropping them. The second
      // read here sees the record the first one just wrote, so its age is zero.
      seedSession("stale", SIX_HOURS + 1);

      await request("/probe/session/", { cookie: `${SESSION_COOKIE}=stale` });
      await request("/probe/session/", { cookie: `${SESSION_COOKIE}=stale` });
      await request("/probe/session/", { cookie: `${SESSION_COOKIE}=stale` });

      expect(kv.puts).toHaveLength(1);
      expect(kv.gets).toHaveLength(3);
    });

    it("does not write for a session that has never crossed the threshold", async () => {
      seedSession("fresh", 5 * 60 * 60 * 1000);

      for (let i = 0; i < 5; i++) await request("/probe/session/", { cookie: `${SESSION_COOKIE}=fresh` });

      expect(kv.puts).toEqual([]);
    });

    // SUSPECT, PINNED AS-IS (reported, not fixed). getAdminSession has no
    // expiry check of its own -- it trusts KV's expirationTtl to have removed
    // the record. Where that trust holds this is free; where it does not (a
    // record written with no TTL by some future caller, or KV's own expiry
    // lagging) an expired session is not merely accepted, it is sliding-
    // refreshed for another twelve hours, so the record heals itself and never
    // expires while anyone keeps using it.
    it("accepts an already-expired record and extends it for another twelve hours", async () => {
      seedSession("expired", 13 * 60 * 60 * 1000); // expiresAt an hour in the past

      await request("/probe/session/", { cookie: `${SESSION_COOKIE}=expired` });

      expect(lastSession?.email).toBe("jason@givefood.org.uk");
      expect(kv.puts).toHaveLength(1);
      expect((JSON.parse(kv.puts[0]!.value) as StoredSession).expiresAt).toBe(NOW + SESSION_TTL_SECONDS * 1000);
    });

    it("never refreshes a record with no expiresAt, because the arithmetic is NaN", async () => {
      // Not reachable from createSession(), which always writes one. Pinned
      // because the failure is silent in the OTHER direction from the usual:
      // such a session works normally until KV expires it, then vanishes
      // mid-edit with no refresh ever attempted.
      kv.store.set(sessionKey("legacy"), JSON.stringify({ email: "jason@givefood.org.uk", name: "Jason", givenName: "Jason", picture: "" }));

      await request("/probe/session/", { cookie: `${SESSION_COOKIE}=legacy` });

      expect(lastSession?.email).toBe("jason@givefood.org.uk");
      expect(kv.puts).toEqual([]);
    });
  });
});

// ===================== revokeAdminSession =====================

describe("revokeAdminSession", () => {
  it("deletes the session's KV record and clears the cookie", async () => {
    // The deletion is the assertion. Clearing the cookie alone would leave a
    // usable session sitting in KV for twelve hours, openable by anyone who had
    // captured the cookie value -- which is the whole difference between
    // signing out and hiding the evidence.
    const { sessionCookie } = await completeSignIn();
    const id = sessionCookie.slice(SESSION_COOKIE.length + 1);
    expect(kv.store.has(sessionKey(id))).toBe(true);

    const res = await request("/probe/revoke/", { cookie: sessionCookie });

    expect(kv.deletes).toEqual([sessionKey(id)]);
    expect(kv.store.has(sessionKey(id))).toBe(false);
    // The exact header, because every attribute is load-bearing: a browser only
    // replaces a cookie when the name, Path and (for __Host-) Secure agree, so
    // a clear that differs in any of them leaves the old cookie in place and
    // the admin apparently still signed in.
    expect(setCookieNamed(res, SESSION_COOKIE)).toBe(`${SESSION_COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  });

  it("clears the cookie even when there was no session to delete", async () => {
    // The case that actually matters for a stuck admin: the KV record has
    // already expired, so there is nothing to delete, but the browser is still
    // sending a cookie that will never resolve. The clear is what breaks that.
    const res = await request("/probe/revoke/");

    expect(kv.deletes).toEqual([]);
    expect(setCookieNamed(res, SESSION_COOKIE)).toContain("Max-Age=0");
  });

  it("issues the delete even for an id KV has never held", async () => {
    // KV deletes are idempotent, so there is no read-before-delete. Pinned so
    // nobody adds one: it would double the cost of every sign-out to avoid a
    // no-op.
    await request("/probe/revoke/", { cookie: `${SESSION_COOKIE}=nosuchsession` });

    expect(kv.deletes).toEqual([sessionKey("nosuchsession")]);
  });

  it("appends its Set-Cookie so a cookie the handler already set survives", async () => {
    // `{ append: true }`, not a plain set. Without it, revoking would wipe any
    // Set-Cookie the response had already produced -- in this codebase that is
    // the CSRF cookie, so the page rendered after a sign-out would carry a
    // token with no cookie behind it and its form would 403 forever.
    const res = await request("/probe/revoke-after-cookie/");

    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies.some((c) => c.startsWith("__Host-csrf="))).toBe(true);
    expect(cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=;`))).toBe(true);
  });

  it("clears only the session cookie, leaving the oauth cookie alone", async () => {
    // They are cleared by different functions at different moments, and a
    // revoke that also cleared __Host-oauth would abort a sign-in that was in
    // flight in another tab.
    const res = await request("/probe/revoke/", { cookie: `${SESSION_COOKIE}=abc` });

    expect(setCookieNamed(res, OAUTH_COOKIE)).toBeUndefined();
  });
});

// ===================== handleSignOut =====================

describe("handleSignOut", () => {
  it("revokes, then sends the admin to the sign-in page", async () => {
    // Django's sign_out pops user_data and redirects to auth:sign_in. Same
    // destination here -- and /auth/ is a real branded page, so landing there
    // is the visible confirmation that the sign-out happened.
    const { sessionCookie } = await completeSignIn();
    const id = sessionCookie.slice(SESSION_COOKIE.length + 1);

    const res = await request("/auth/sign-out/", { cookie: sessionCookie });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/");
    expect(kv.deletes).toEqual([sessionKey(id)]);
    expect(setCookieNamed(res, SESSION_COOKIE)).toContain("Max-Age=0");
  });

  it("makes the old cookie useless even if the browser keeps sending it", async () => {
    // The half that makes the deletion meaningful rather than merely tidy,
    // asserted through the module's own reader against the real store: replay
    // the exact cookie after signing out and there is nothing behind it.
    const { sessionCookie } = await completeSignIn();
    await request("/auth/sign-out/", { cookie: sessionCookie });

    await request("/probe/session/", { cookie: sessionCookie });

    expect(lastSession).toBeNull();
  });

  it("redirects without touching KV when nobody was signed in", async () => {
    const res = await request("/auth/sign-out/");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/");
    expect(kv.deletes).toEqual([]);
    expect(kv.gets).toEqual([]);
  });
});

// ===================== handleGoogleOAuthCallback =====================

describe("handleGoogleOAuthCallback", () => {
  describe("a real sign-in", () => {
    it("writes the session, names it in the cookie, and returns to the cookie's next", async () => {
      // THE WRITE ACTUALLY HAPPENED. The redirect is the least interesting
      // half: what makes somebody an admin is the record in KV and the cookie
      // pointing at it, so both are read back and compared with the claims in
      // the token that produced them.
      const { res, sessionCookie, flow } = await completeSignIn("/admin/foodbank/salisbury/");

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/admin/foodbank/salisbury/");

      const sessions = storedSessions();
      expect(sessions).toHaveLength(1);
      const [key, stored] = sessions[0]!;
      expect(stored).toEqual({
        email: "jason@givefood.org.uk",
        name: "Jason Cartwright",
        givenName: "Jason",
        picture: "https://lh3.googleusercontent.com/a/test-picture",
        expiresAt: expect.any(Number),
      });
      expect(stored.expiresAt).toBeGreaterThan(Date.now() + SESSION_TTL_SECONDS * 1000 - 5000);
      expect(stored.expiresAt).toBeLessThanOrEqual(Date.now() + SESSION_TTL_SECONDS * 1000);
      // The cookie must name the key that was actually written, or the admin is
      // holding a ticket for a session nobody stored.
      expect(key).toBe(sessionKey(sessionCookie.slice(SESSION_COOKIE.length + 1)));
      expect(kv.puts).toHaveLength(1);
      expect(kv.puts[0]!.expirationTtl).toBe(SESSION_TTL_SECONDS);
      // `next` never appears in the query string of this request -- it came out
      // of the signed cookie the flow started with, which is why nothing
      // between the two hops can rewrite it.
      expect(flow.payload.next).toBe("/admin/foodbank/salisbury/");
    });

    it("mints an unguessable session id, fresh for every sign-in", async () => {
      // The session id IS the credential: anyone holding it is the maintainer
      // for the next twelve hours. 32 random bytes base64url-encoded is 43
      // characters from a URL- and cookie-safe alphabet -- no ";" or "," to
      // split the cookie header on, and nothing needing percent-encoding.
      const ids = new Set<string>();
      for (let i = 0; i < 8; i++) {
        const { sessionCookie } = await completeSignIn();
        const id = sessionCookie.slice(SESSION_COOKIE.length + 1);
        expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
        ids.add(id);
      }
      // A fixed or derived id would mean two admins sharing one KV record --
      // and a signed-in id that anyone could compute.
      expect(ids.size).toBe(8);
      expect(kv.store.size).toBe(8);
    });

    it("sets a __Host- session cookie whose lifetime matches the stored TTL", async () => {
      const { res } = await completeSignIn();
      const cookie = setCookieNamed(res, SESSION_COOKIE)!;

      expect(cookie).toContain("; Secure");
      expect(cookie).toContain("; HttpOnly"); // an XSS on an admin page must not be able to read the session id out
      expect(cookie).toContain("; SameSite=Lax");
      expect(cookie).toMatch(/; Path=\/(;|$)/);
      // Anchored, for the reason the oauth cookie's Max-Age is: an unanchored
      // match accepts a cookie ten times longer-lived than the session record
      // behind it, which is a browser holding a credential KV has already
      // dropped -- an admin who looks signed in and 302s on every click.
      expect(cookie).toMatch(new RegExp(`; Max-Age=${SESSION_TTL_SECONDS}(;|$)`));
      expect(cookie).not.toContain("Domain=");
    });

    it("clears the single-use oauth cookie on the same response", async () => {
      // Both cookies on one response, which is only possible because both are
      // written with { append: true }. Single-use matters: a code replayed from
      // the browser's history has no verifier to go with it.
      const { res } = await completeSignIn();

      expect(res.headers.getSetCookie()).toHaveLength(2);
      expect(setCookieNamed(res, OAUTH_COOKIE)).toBe(`${OAUTH_COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    });

    it("exchanges the code with the verifier and redirect_uri the flow started with", async () => {
      // What actually goes to Google, which nothing else can check. The
      // verifier is the PKCE half; redirect_uri must be byte-identical to the
      // one sent at the authorize hop or Google refuses the exchange.
      const { flow } = await completeSignIn();

      expect(tokenRequests).toHaveLength(1);
      const body = tokenRequests[0]!;
      expect(body.get("code")).toBe("4/0AeanS0-test-authorization-code");
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("client_id")).toBe(CLIENT_ID);
      expect(body.get("client_secret")).toBe(CLIENT_SECRET);
      expect(body.get("code_verifier")).toBe(flow.payload.codeVerifier);
      expect(body.get("redirect_uri")).toBe(flow.authorizeUrl.searchParams.get("redirect_uri"));
    });

    it("exchanges from the beta host with the beta redirect_uri, not the www one", async () => {
      // The claim that can actually break: on www the two strings are
      // identical, so hardcoding SITE_DOMAIN in the exchange survives every
      // assertion above. On beta.givefood.org.uk the authorize hop would work
      // and the exchange would come back redirect_uri_mismatch.
      const beta = { host: "beta.givefood.org.uk", base: "https://beta.givefood.org.uk" };
      const { res } = await completeSignIn(undefined, {}, beta);

      expect(res.status).toBe(302);
      expect(kv.store.size).toBe(1);
      expect(tokenRequests[0]!.get("redirect_uri")).toBe("https://beta.givefood.org.uk/auth/receiver/");
    });

    it("falls back to the email address when Google omits name, given_name or picture", async () => {
      // Google omits these for some Workspace accounts. The signed-in page
      // renders all three, so a missing name would render as a blank strong tag
      // rather than as anybody's name.
      await completeSignIn(undefined, { claims: { name: undefined, given_name: undefined, picture: undefined } });

      const [, stored] = storedSessions()[0]!;
      expect(stored.name).toBe("jason@givefood.org.uk");
      expect(stored.givenName).toBe("jason@givefood.org.uk");
      expect(stored.picture).toBe(""); // "" rather than the email -- a picture falls back to nothing, not to text
    });

    it("stores the email from the token, not from anywhere else", async () => {
      // The identity written is the identity Google asserted. A session that
      // stored a constant, or the hosted domain, would let the audit trail on
      // every admin write name the wrong person.
      await completeSignIn(undefined, { claims: { email: "someone-else@givefood.org.uk", name: "Someone Else", given_name: "Someone" } });

      const [, stored] = storedSessions()[0]!;
      expect(stored.email).toBe("someone-else@givefood.org.uk");
      expect(stored.name).toBe("Someone Else");
    });

    it("hands back a session getAdminSession can read", async () => {
      // The round trip through the module's own two halves and a real store:
      // key derivation, cookie name, JSON shape. Anything inconsistent between
      // createSession and getAdminSession makes a sign-in that appears to work
      // and an admin who is never signed in.
      const { sessionCookie } = await completeSignIn();

      await request("/probe/session/", { cookie: sessionCookie });

      expect(lastSession).toEqual({
        email: "jason@givefood.org.uk",
        name: "Jason Cartwright",
        givenName: "Jason",
        picture: "https://lh3.googleusercontent.com/a/test-picture",
      });
    });

    it("carries a non-ASCII next all the way to the Location header", async () => {
      // The other end of the UTF-8 round trip started at /auth/start/: an
      // accented admin URL survives the base64url payload and comes back out
      // byte for byte.
      const { res } = await completeSignIn("/admin/foodbank/caffè-food-bank/");

      expect(res.headers.get("Location")).toBe("/admin/foodbank/caffè-food-bank/");
    });

    // SUSPECT, PINNED AS-IS. The open redirect from safeNextPath's backslash
    // case, followed to the Location header an admin's browser would obey.
    // Reaching it needs a real sign-in against a `next` the attacker chose, so
    // it is a phishing-grade nuisance rather than an account takeover -- but it
    // is the exact case Django's helper exists to block.
    it("redirects to a backslash-prefixed next after a genuine sign-in", async () => {
      const { res } = await completeSignIn("/\\evil.example/");

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/\\evil.example/");
    });

    // SUSPECT, PINNED AS-IS. The callback does NOT re-run safeNextPath on the
    // value it takes out of the cookie -- the sanitising happens once, at the
    // start hop. That is sound today because only a holder of SESSION_HMAC_KEY
    // can sign a cookie and startGoogleOAuth is the only thing that signs one.
    // Pinned because it makes safeNextPath a start-hop-only guarantee: any
    // future code path that signs an oauth cookie inherits the responsibility,
    // and nothing in the callback would catch it.
    it("trusts the cookie's next verbatim, with no second sanitising pass", async () => {
      const forged = await forgedOAuthCookie({ state: "s".repeat(32), codeVerifier: "v".repeat(43), next: "https://evil.example/" });
      const idToken = await signIdToken();
      tokenResponse = () => new Response(JSON.stringify({ id_token: idToken }), { status: 200 });

      const res = await receiver({ code: "abc", state: "s".repeat(32) }, forged);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://evil.example/");
      expect(kv.store.size).toBe(1); // a real session was created; only the destination is wrong
    });
  });

  // Every refusal asserts the same two things as well as the status: nothing in
  // KV, and no session cookie. A 302 to /auth/ that had nonetheless signed
  // somebody in looks identical from the outside.
  describe("refusals", () => {
    function expectNobodySignedIn(res: Response): void {
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/auth/");
      expect(kv.store.size).toBe(0);
      expect(kv.puts).toEqual([]);
      expect(setCookieNamed(res, SESSION_COOKIE)).toBeUndefined();
    }

    it("refuses, without contacting Google, everything that fails before the exchange", async () => {
      // Each of these is a callback a browser could really make, and none of
      // them may reach Google's token endpoint -- an exchange attempted before
      // the state check is a login-CSRF hole no matter what happens afterwards.
      const flow = await startFlow();
      const state = flow.payload.state;
      const cases: [string, Record<string, string>, string | undefined][] = [
        // Google's "cancel" button, and every other failure it reports. The
        // `code` alongside it is deliberate: it isolates the `error` clause, so
        // deleting it from the guard fails here rather than passing on `!code`.
        ["Google reported an error", { error: "access_denied", code: "4/0AeanS0-ignored", state }, flow.cookie],
        ["no code", { state }, flow.cookie],
        ["no state", { code: "abc" }, flow.cookie],
        ["no code and no state", {}, flow.cookie],
        // No cookie means no flow was ever started from this browser: somebody
        // pasted a receiver URL, or a third-party page navigated to one.
        ["no oauth cookie", { code: "abc", state }, undefined],
        ["an empty oauth cookie", { code: "abc", state }, `${OAUTH_COOKIE}=`],
        // A cookie with no "." at all: verifyOAuthCookie's first guard.
        ["an unsigned oauth cookie", { code: "abc", state }, `${OAUTH_COOKIE}=notsignedatall`],
      ];

      for (const [label, params, cookie] of cases) {
        kv = createSessionKv();
        env = { ...env, SESSIONS: kv.namespace } as AppEnv["Bindings"];
        tokenRequests = [];

        const res = await receiver(params, cookie);

        expect(res.status, label).toBe(302);
        expectNobodySignedIn(res);
        expect(tokenRequests, label).toEqual([]);
      }
    });

    // THE CSRF CHECK. An attacker who can make the maintainer's browser hit
    // /auth/receiver/ with a code from the ATTACKER'S OWN Google account would
    // otherwise log the maintainer into the attacker's session -- classic OAuth
    // login CSRF, and from there everything the maintainer then typed goes into
    // the attacker's account. The state comparison is the whole defence.
    it("refuses a state that does not match the cookie's, without contacting Google", async () => {
      const flow = await startFlow();
      const real = flow.payload.state;
      // Both spellings: one character longer, and the same length with one
      // character changed. The second is what an attacker would present, and
      // it is the only one that fails if timingSafeEqual ever degrades to a
      // length comparison.
      const sameLength = real.slice(0, -1) + (real.endsWith("A") ? "B" : "A");
      expect(sameLength).toHaveLength(real.length);

      for (const state of [`${real}x`, sameLength, "", real.slice(0, -1)]) {
        const res = await receiver({ code: "abc", state }, flow.cookie);
        expect(res.status).toBe(302);
        expect(kv.store.size).toBe(0);
        expect(tokenRequests).toEqual([]);
      }
    });

    it("refuses an oauth cookie signed with the wrong secret, even when its state matches", async () => {
      // The signature is the only thing making the cookie's state and verifier
      // trustworthy. A forged cookie carrying a state the attacker chose (and
      // therefore knows) defeats the state check entirely.
      const forged = await forgedOAuthCookie({ state: "attacker-state", codeVerifier: "attacker-verifier", next: "/admin/" }, "not-the-secret");

      const res = await receiver({ code: "abc", state: "attacker-state" }, forged);

      expectNobodySignedIn(res);
      expect(tokenRequests).toEqual([]);
    });

    it("refuses a genuine oauth cookie with anything appended to it", async () => {
      // verifyOAuthCookie takes everything after the FIRST dot as the
      // signature, so `<payload>.<signature>.<junk>` is a signature mismatch
      // rather than a valid cookie with an ignored suffix. Rewriting that split
      // as `const [json, signature] = value.split(".")` looks identical on
      // every well-formed cookie -- and quietly starts ACCEPTING the suffixed
      // form, because the junk lands in a third element nobody reads. The same
      // rewrite is called out in lib/csrf.test.ts for the same reason.
      const flow = await startFlow("/admin/");

      const res = await receiver({ code: "abc", state: flow.payload.state }, `${flow.cookie}.extra`);

      expectNobodySignedIn(res);
      expect(tokenRequests).toEqual([]);
    });

    it("refuses a correctly-signed cookie whose payload is not JSON", async () => {
      // verifyOAuthCookie's try/catch: the signature verifies (this file holds
      // the secret) but the payload will not parse, so it returns null rather
      // than throwing a 500 out of the callback.
      const json = base64Url(new TextEncoder().encode("{not json"));
      const cookie = `${OAUTH_COOKIE}=${json}.${await rfc2104HmacSha256Hex(HMAC_KEY, json)}`;

      const res = await receiver({ code: "abc", state: "anything" }, cookie);

      expectNobodySignedIn(res);
      expect(tokenRequests).toEqual([]);
    });

    it("clears the oauth cookie even when it refuses", async () => {
      // "Single-use, regardless of outcome": a failed attempt must not leave a
      // live state/verifier pair in the browser for a second try.
      const flow = await startFlow();

      const res = await receiver({ code: "abc", state: "wrong" }, flow.cookie);

      expect(setCookieNamed(res, OAUTH_COOKIE)).toContain("Max-Age=0");
    });

    it("answers 403, not a redirect, when Google refuses the exchange", async () => {
      // A code Google will not exchange: already used, expired, or issued to a
      // different client. The one status in this flow that tells the maintainer
      // the failure was Google's rather than theirs, so it is easy to "tidy"
      // into a redirect and worth pinning.
      const flow = await startFlow();
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      tokenResponse = () => new Response('{"error":"invalid_grant"}', { status: 400 });

      const res = await receiver({ code: "used-already", state: flow.payload.state }, flow.cookie);
      const body = await res.text();

      expect(res.status).toBe(403);
      expect(kv.store.size).toBe(0);
      // The raw Google error goes to the log, never to the page: an OAuth error
      // body carries request-specific detail an admin has no use for.
      expect(body).toBe("Sign-in failed");
      expect(body).not.toContain("invalid_grant");
      expect(logged).toHaveBeenCalledWith("Google token exchange failed", 400, '{"error":"invalid_grant"}');
      logged.mockRestore();
    });

    it("refuses a token response carrying no id_token", async () => {
      const flow = await startFlow();
      tokenResponse = () => new Response(JSON.stringify({ access_token: "ya29.test" }), { status: 200 });

      expectNobodySignedIn(await receiver({ code: "abc", state: flow.payload.state }, flow.cookie));
    });

    // SUSPECT, PINNED AS-IS. A 200 whose body is not JSON -- a captive portal,
    // a proxy interstitial, an outage page served with the wrong status -- is
    // not handled: res.json() throws and the callback 500s instead of taking
    // any of its refusal paths. Rare, but the 500 is what the maintainer would
    // actually see, and it points nowhere near the real cause.
    it("500s rather than refusing when Google's 200 is not JSON", async () => {
      const flow = await startFlow();
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      tokenResponse = () => new Response("<html>proxy interstitial</html>", { status: 200 });

      const res = await receiver({ code: "abc", state: flow.payload.state }, flow.cookie);

      expect(res.status).toBe(500);
      expect(kv.store.size).toBe(0);
      logged.mockRestore();
    });
  });

  // verifyGoogleIdToken(), reached through the callback with real RSA material.
  // Each of these is a token that could really arrive; the question in every
  // case is whether a session is created, and the answer has to be no.
  describe("ID token verification", () => {
    async function signInWith(token: IdTokenOptions): Promise<Response> {
      const flow = await startFlow();
      const idToken = await signIdToken(token);
      tokenResponse = () => new Response(JSON.stringify({ id_token: idToken }), { status: 200 });
      return receiver({ code: "abc", state: flow.payload.state }, flow.cookie);
    }

    function expectRejected(res: Response): void {
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/auth/");
      expect(kv.store.size).toBe(0);
      expect(setCookieNamed(res, SESSION_COOKIE)).toBeUndefined();
    }

    it("rejects a token whose header asks for a different algorithm", async () => {
      // THE ALGORITHM-CONFUSION FOOTGUN, both spellings. `alg: none` is the
      // textbook JWT forgery; HS256 is the subtler one, where a verifier
      // trusting the header would use Google's PUBLIC key as an HMAC secret --
      // and that key is published, so anyone could mint tokens. Google's
      // discovery document lists RS256 as the only id_token algorithm, so
      // anything else is refused before a key is even fetched.
      expectRejected(await signInWith({ alg: "none" }));
      expectRejected(await signInWith({ alg: "HS256" }));
      expectRejected(await signInWith({ alg: "rs256" })); // case-sensitive, as JWA defines it
    });

    it("rejects a token with no kid in its header", async () => {
      // There is nothing to look up in the JWKS, and "no kid" must not fall
      // back to "try any key".
      expectRejected(await signInWith({ kid: "" }));
    });

    it("rejects a token signed by a key id Google does not publish", async () => {
      expectRejected(await signInWith({ kid: "not-a-google-key", key: impostorKeys.privateKey }));
    });

    it("rejects a token signed by an impostor using a real key id", async () => {
      // THE SIGNATURE CHECK ITSELF, and the mutant that matters most: this
      // token is well-formed, unexpired, correctly addressed and names a kid
      // Google really publishes -- everything except being signed by Google. If
      // crypto.subtle.verify's result were ignored, this is the test that
      // catches it, and nothing else here would.
      expectRejected(await signInWith({ key: impostorKeys.privateKey }));
    });

    it("rejects a token whose signature has been truncated or swapped", async () => {
      // The same check from the other side: a real Google signature over
      // different bytes, and a real signature with its last block removed.
      const real = await signIdToken();
      const other = await signIdToken({ claims: { email: "someone@givefood.org.uk" } });
      const flow = await startFlow();
      tokenResponse = () => new Response(JSON.stringify({ id_token: `${real.split(".").slice(0, 2).join(".")}.${other.split(".")[2]}` }), { status: 200 });

      expectRejected(await receiver({ code: "abc", state: flow.payload.state }, flow.cookie));
    });

    it("rejects a token issued for a different client id", async () => {
      // Google issues one ID token per client. A token minted for somebody
      // else's OAuth client is a valid Google signature over claims that were
      // never meant for this site -- the classic confused-deputy sign-in.
      expectRejected(await signInWith({ claims: { aud: "someone-elses-client.apps.googleusercontent.com" } }));
      expectRejected(await signInWith({ claims: { aud: undefined } }));
    });

    it("rejects a token from an unexpected issuer, and accepts both forms Google uses", async () => {
      expectRejected(await signInWith({ claims: { iss: "https://accounts.evil.example" } }));
      expectRejected(await signInWith({ claims: { iss: "https://accounts.google.com/" } })); // trailing slash: a different string
      expectRejected(await signInWith({ claims: { iss: undefined } }));

      // The positive control, and the reason the list has two entries: Google
      // documents both spellings across its token issuers, so tightening this
      // to one form would start refusing real tokens.
      const res = await signInWith({ claims: { iss: "accounts.google.com" } });
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/admin/");
      expect(kv.store.size).toBe(1);
    });

    it("rejects an expired token", async () => {
      expectRejected(await signInWith({ claims: { exp: Math.floor(Date.now() / 1000) - 60 } }));
    });

    // SUSPECT, PINNED AS-IS (reported, not fixed). `payload.exp * 1000 <
    // Date.now()` is NaN < now when exp is absent, and NaN comparisons are
    // false -- so a token with NO exp claim passes the expiry check rather than
    // failing it. Unreachable in practice: Google always sends exp and the
    // signature must be Google's over these exact bytes. Pinned because the
    // guard reads as "reject anything not currently valid" and is really
    // "reject anything whose exp says so".
    it("accepts a token with no exp claim at all", async () => {
      const res = await signInWith({ claims: { exp: undefined } });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/admin/");
      expect(kv.store.size).toBe(1);
    });

    it("rejects a token that is not three dot-separated parts", async () => {
      const flow = await startFlow();
      for (const idToken of ["not.a.jwt.at.all", "onlytwo.parts", "", "..."]) {
        tokenResponse = () => new Response(JSON.stringify({ id_token: idToken }), { status: 200 });
        const res = await receiver({ code: "abc", state: flow.payload.state }, flow.cookie);
        // An empty id_token takes the `!tokenJson.id_token` path instead, which
        // lands in the same place -- both are a redirect with nothing stored.
        expect(res.status).toBe(302);
        expect(kv.store.size).toBe(0);
      }
    });

    it("rejects a token whose header or payload is not base64url JSON", async () => {
      // The try/catch around the two JSON.parse calls. Both halves are
      // attacker-shaped input in the general case, and a throw here would be a
      // 500 instead of a refusal.
      const flow = await startFlow();
      const real = (await signIdToken()).split(".");
      for (const idToken of [`${base64Url(new TextEncoder().encode("{bad"))}.${real[1]}.${real[2]}`, `${real[0]}.${base64Url(new TextEncoder().encode("nope"))}.${real[2]}`]) {
        tokenResponse = () => new Response(JSON.stringify({ id_token: idToken }), { status: 200 });
        expectRejected(await receiver({ code: "abc", state: flow.payload.state }, flow.cookie));
      }
    });

    // SUSPECT, PINNED AS-IS. base64UrlDecode is called on the SIGNATURE outside
    // that try/catch, so a signature segment containing a character outside the
    // base64 alphabet throws (atob rejects it) and the callback 500s instead of
    // refusing. Not attacker-reachable -- the id_token comes from a
    // server-to-server response from Google -- but it is the difference between
    // a diagnosable refusal and an unexplained 500 if Google's response is ever
    // mangled in transit.
    it("500s on a signature segment that is not valid base64", async () => {
      const flow = await startFlow();
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const idToken = await signIdToken({ signature: "!!!not-base64!!!" });
      tokenResponse = () => new Response(JSON.stringify({ id_token: idToken }), { status: 200 });

      const res = await receiver({ code: "abc", state: flow.payload.state }, flow.cookie);

      expect(res.status).toBe(500);
      expect(kv.store.size).toBe(0);
      logged.mockRestore();
    });
  });

  // givefood/middleware.py's LoginRequiredAccess gate -- `not email_verified or
  // hosted_domain != "givefood.org.uk"` -- reproduced as this flow's own
  // authorization check. Django applied it on every request; this port applies
  // it once, at the only moment it can: after the token is verified and before
  // a session exists. These tests are therefore the entire difference between
  // "any Google account on earth can edit the site" and "the maintainer can".
  describe("the givefood.org.uk gate", () => {
    async function attempt(claims: Partial<Record<keyof GoogleIdTokenClaims, unknown>>): Promise<Response> {
      const flow = await startFlow();
      const idToken = await signIdToken({ claims });
      tokenResponse = () => new Response(JSON.stringify({ id_token: idToken }), { status: 200 });
      return receiver({ code: "abc", state: flow.payload.state }, flow.cookie);
    }

    it("refuses every account that is not a verified givefood.org.uk one", async () => {
      const cases: [string, Partial<Record<keyof GoogleIdTokenClaims, unknown>>][] = [
        // A personal Google account carries no hd claim at all.
        ["a personal account", { email: "someone@gmail.com", hd: undefined }],
        ["another Workspace domain", { email: "someone@example.com", hd: "example.com" }],
        // An unverified address is not proof of anything, even on the right
        // domain -- Django checked both, and so does this.
        ["an unverified email", { email_verified: false }],
        ["an absent email_verified", { email_verified: undefined }],
        // The comparison is exact: hd is a domain name and Google sends it
        // lowercase, but "close enough" is not a thing a security check does.
        ["the domain in the wrong case", { hd: "GIVEFOOD.ORG.UK" }],
        ["a subdomain of it", { hd: "mail.givefood.org.uk" }],
        ["a suffixed look-alike", { hd: "givefood.org.uk.evil.example" }],
        ["an empty hd", { hd: "" }],
      ];

      for (const [label, claims] of cases) {
        kv = createSessionKv();
        env = { ...env, SESSIONS: kv.namespace } as AppEnv["Bindings"];

        const res = await attempt(claims);

        // A refusal is a redirect back to the branded sign-in page, not a bare
        // 403: the admin may simply have picked the wrong account in Google's
        // chooser, and dead-ending them would be worse than useless.
        expect(res.status, label).toBe(302);
        expect(res.headers.get("Location"), label).toBe("/auth/");
        expect(kv.store.size, label).toBe(0);
        expect(setCookieNamed(res, SESSION_COOKIE), label).toBeUndefined();
      }
    });

    it("admits the account the gate exists to admit", async () => {
      // The positive control. Without it every test above would still pass on a
      // module that refused absolutely everybody.
      const res = await attempt({ email: "jason@givefood.org.uk", hd: "givefood.org.uk", email_verified: true });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/admin/");
      expect(kv.store.size).toBe(1);
    });

    it("refuses before writing anything, not after", async () => {
      // The check sits between verifyGoogleIdToken and createSession. If it
      // ever moved after the write, a refused account would still have a live
      // session record in KV -- and only the missing cookie would be stopping
      // them.
      await attempt({ hd: "example.com" });

      expect(kv.puts).toEqual([]);
    });
  });

  // Google's JWKS, cached at module scope by kid for the isolate's life
  // ("cache by kid; keys rotate"). Stated relatively -- "no fetch the second
  // time" rather than "one fetch in total" -- because the cache outlives a
  // test, so an absolute count would be pinning this file's execution order.
  describe("Google's signing keys", () => {
    it("does not refetch the JWKS for a kid it has already cached", async () => {
      await completeSignIn();
      const after = jwksFetches;

      await completeSignIn();

      expect(jwksFetches).toBe(after);
      expect(kv.store.size).toBe(2);
    });

    it("refetches when Google rotates in a kid this isolate has never seen", async () => {
      // THE OTHER HALF OF "cache by kid", and the one that breaks sign-in for
      // everybody if it regresses: Google rotates its signing keys every few
      // days, and a cache keyed only on age would refuse every token signed
      // with the new key until the window expired. The `!jwks.has(kid)` clause
      // is what turns an unknown kid into a single re-fetch.
      await completeSignIn(); // warms the cache with the current key
      const before = jwksFetches;

      jwksDocument = { keys: [GOOGLE_KEY_ENTRY, ROTATED_KEY_ENTRY] };
      const { res } = await completeSignIn(undefined, { kid: ROTATED_KID, key: rotatedKeys.privateKey });

      expect(jwksFetches).toBe(before + 1);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/admin/");
      expect(kv.store.size).toBe(2); // the rotated-key sign-in really created a session
    });

    it("fails loudly rather than as a refusal when the JWKS is unreachable", async () => {
      // GOOGLE BEING DOWN IS NOT A REFUSED ACCOUNT, and the difference is the
      // whole diagnosis: getGoogleJwk throws, Hono turns that into a 500, and
      // the maintainer sees a server error rather than a sign-in page implying
      // their account was rejected. Softening that throw to `return null` turns
      // an outage into an unbreakable "sign in again" loop with nothing in the
      // logs to say which it was.
      //
      // Reached with a kid this isolate has never cached, because that is the
      // only thing that forces a fetch. The failing response cannot poison the
      // cache -- getGoogleJwk throws before it assigns -- so this is safe to
      // run in any order.
      const flow = await startFlow();
      const idToken = await signIdToken({ kid: "rotated-key-nobody-has-cached" });
      tokenResponse = () => new Response(JSON.stringify({ id_token: idToken }), { status: 200 });
      jwksResponse = () => new Response("upstream connect error", { status: 503 });
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});

      const res = await receiver({ code: "abc", state: flow.payload.state }, flow.cookie);

      expect(res.status).toBe(500);
      expect(res.headers.get("Location")).toBeNull();
      expect(kv.store.size).toBe(0);
      expect(setCookieNamed(res, SESSION_COOKIE)).toBeUndefined();
      expect(logged).toHaveBeenCalled();
      logged.mockRestore();
    });
  });

  it("refuses to run at all with either secret missing, before clearing anything", async () => {
    // Both secrets, both fail-closed, each starting from a fully configured env
    // so that neither arm of the guard can be carried by the other. Without the
    // client-secret arm the callback reaches Google with an empty secret and
    // reports the resulting failure as Google's (403 "Sign-in failed"), which
    // sends the maintainer looking at their OAuth client instead of at their
    // own missing binding.
    //
    // The guard is the first thing in the function, so this response carries no
    // Set-Cookie at all -- not even the oauth clear, which every other exit
    // path emits.
    const flow = await startFlow();
    const configured = env;

    for (const missing of [{ SESSION_HMAC_KEY: "" }, { GOOGLE_OAUTH_CLIENT_SECRET: "" }]) {
      env = { ...configured, ...missing } as AppEnv["Bindings"];
      const res = await receiver({ code: "abc", state: flow.payload.state }, flow.cookie);

      expect(res.status).toBe(500);
      expect(await res.text()).toBe("Auth not configured");
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(tokenRequests).toEqual([]);
      expect(kv.store.size).toBe(0);
    }
  });
});
