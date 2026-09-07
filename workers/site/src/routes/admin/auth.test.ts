import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminAuthReceiver, adminAuthStart, adminSignIn, adminSignOut } from "./auth";
import { requireAdminAuth } from "../../middleware/adminAuth";
import { noStore } from "../../middleware/noStore";
import { hmacSha256Hex } from "../../lib/hmac";
import type { AppEnv } from "../../types";

// The four /auth/ routes (index.ts:632-635), driven as a browser drives them:
// a real Hono app registered at the real paths, the real handlers, the real
// lib/adminAuth mechanics, the real Nunjucks templates, and a real (in-memory)
// KV namespace that stores what it is given and hands it back. Nothing about
// the flow is stubbed except the two things that genuinely leave the machine:
// Google's token endpoint and Google's JWKS. The ID tokens below are signed by
// an RSA key this file generates and publishes through that fake JWKS, so
// verifyGoogleIdToken() does the real RS256 verification against real key
// material -- the alternative (mocking the verifier) would assert nothing,
// since "does the signature check work" is most of what /auth/receiver/ is.
//
// WHY THIS FILE EXISTS AT ALL. TESTING.md lists lib/adminAuth.ts among the
// modules with no coverage ("OAuth flow"), and these four routes are the only
// thing standing between the open internet and every write in the admin. They
// are also where the class of bug this codebase keeps finding lives: a flow
// that redirects exactly as though it worked while having stored nothing (or,
// worse, having stored something it should have refused). So every assertion
// here about a successful sign-in also reads the session back out of KV, and
// every assertion about a refused one asserts that KV is empty -- a 302 to
// /admin/ is not evidence that anybody was signed in.
//
// SESSIONS is a real Map-backed KVNamespace rather than a vi.fn() for the same
// reason the neighbouring form suites run real SQLite: the interesting claims
// ("the session that comes back is the one that went in", "sign-out really
// removed the key", "a GET does not rewrite a fresh session") are claims about
// storage, and a mock that returns canned values cannot make them.
//
// MUTATION-TESTED, 2026-09-07. 43 deliberate breakages were applied to
// lib/adminAuth.ts, routes/admin/auth.ts, lib/hmac.ts and lib/cookies.ts in
// turn (each in a copy of the tree outside the repo, the file restored after
// every run) and the suite re-run against each: the CSRF state check deleted,
// the RSA signature result ignored, the hosted-domain gate removed, a field
// dropped from the stored session, bind values swapped, redirect targets and
// status codes changed. Thirty-three died against the suite as it stood; ten
// survived, and nine of those are killed by tests added afterwards, each
// naming its mutant in a comment -- that annotation is the evidence a test is
// load-bearing rather than decorative. The tenth is left alive deliberately
// because it is EQUIVALENT, not uncaught: see the note above the "carries a
// safe next into the cookie" test.

const ORIGIN = "https://www.givefood.org.uk";
const HOST = "www.givefood.org.uk";
// The real client id from wrangler.jsonc:178 -- and byte for byte the one
// hardcoded in gfauth/views.py's verify_oauth2_token() call. Same Google OAuth
// client as Django used, which is exactly why /auth/receiver/ cannot be
// renamed: it is a redirect URI registered against this client.
const CLIENT_ID = "927281004707-tboi1tsphl4bgtqn72e76rmc7r2q22tk.apps.googleusercontent.com";
const CLIENT_SECRET = "test-google-client-secret";
const HMAC_KEY = "test-session-hmac-key";
const KID = "test-signing-key";

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";
const SESSION_COOKIE = "__Host-gfsession";
const OAUTH_COOKIE = "__Host-oauth";
const SESSION_TTL_SECONDS = 12 * 60 * 60;

// ===================== forging what Google would send =====================

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeBase64UrlJson<T>(value: string): T {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

const RSA_PARAMS = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };

// The key Google "publishes" through the JWKS below, and a second one it never
// published -- the difference between the two is the whole point of the
// signature check, so both are real 2048-bit RSA keys rather than a flag.
const googleKeys = (await crypto.subtle.generateKey(RSA_PARAMS, true, ["sign", "verify"])) as CryptoKeyPair;
const impostorKeys = (await crypto.subtle.generateKey(RSA_PARAMS, true, ["sign", "verify"])) as CryptoKeyPair;
// exportKey is typed as ArrayBuffer | JsonWebKey across all its formats; the
// "jwk" format returns the object half, and only its RSA modulus/exponent are
// wanted here.
const googlePublicJwk = (await crypto.subtle.exportKey("jwk", googleKeys.publicKey)) as JsonWebKey;

// Shaped like Google's real https://www.googleapis.com/oauth2/v3/certs
// document. Always contains the good key, in every test: lib/adminAuth.ts
// caches this map at MODULE scope keyed by kid, so a fetch that returned a
// document without it would poison the cache for every later test in this
// file. The "kid nobody published" case below therefore uses an unknown kid
// against this same complete document, which is also what really happens.
const JWKS_DOCUMENT = {
  keys: [{ kid: KID, kty: "RSA", alg: "RS256", use: "sig", n: googlePublicJwk.n, e: googlePublicJwk.e }],
};

interface IdTokenOptions {
  sub?: string;
  email?: string;
  emailVerified?: boolean;
  hd?: string | undefined;
  name?: string;
  givenName?: string;
  picture?: string;
  aud?: string;
  iss?: string;
  expiresInSeconds?: number;
  alg?: string;
  kid?: string;
  key?: CryptoKey;
}

// An OPTIONAL claim: present with its default unless the caller named it, and
// genuinely absent from the JSON when they named it as undefined. Google omits
// hd for personal accounts and name/given_name/picture for some Workspace
// ones, and "absent" is a different token from "empty string" -- the two take
// different branches in createSession(), so the tests need to say which.
function claim(options: IdTokenOptions, key: "hd" | "name" | "givenName" | "picture", fallback: string): string | undefined {
  return key in options ? options[key] : fallback;
}

async function signIdToken(options: IdTokenOptions = {}): Promise<string> {
  const header = { alg: options.alg ?? "RS256", kid: options.kid ?? KID, typ: "JWT" };
  const payload: Record<string, unknown> = {
    sub: options.sub ?? "104729000000000000001",
    email: options.email ?? "jason@givefood.org.uk",
    email_verified: options.emailVerified ?? true,
    aud: options.aud ?? CLIENT_ID,
    iss: options.iss ?? "https://accounts.google.com",
    exp: Math.floor(Date.now() / 1000) + (options.expiresInSeconds ?? 3600),
  };
  const optional = {
    hd: claim(options, "hd", "givefood.org.uk"),
    name: claim(options, "name", "Jason Cartwright"),
    given_name: claim(options, "givenName", "Jason"),
    picture: claim(options, "picture", "https://lh3.googleusercontent.com/a/test-picture"),
  };
  for (const [key, value] of Object.entries(optional)) if (value !== undefined) payload[key] = value;

  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", options.key ?? googleKeys.privateKey, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

// ===================== the bindings =====================

interface KvPut {
  key: string;
  value: string;
  expirationTtl: number | undefined;
}

// Enough of KVNamespace for lib/adminAuth.ts: get/put/delete, plus a record of
// what was written so "this GET did not rewrite the session" is assertable.
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

// Google's two endpoints, and only those. Anything else reaching the network
// from this flow is a bug in its own right, so the stub throws rather than
// quietly answering. Both are overridable per test: the token endpoint because
// half the refusals below are things Google says, and the JWKS endpoint
// because "Google is unreachable" has to be distinguishable from "your account
// was refused" (see the outage test).
let tokenResponse: () => Response;
let jwksResponse: () => Response;
let tokenRequests: URLSearchParams[];
let jwksFetches: number;

const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function sessionKey(sessionId: string): string {
  return `admin-session:${sessionId}`;
}

interface StoredSession {
  email: string;
  name: string;
  givenName: string;
  picture: string;
  expiresAt: number;
}

function storedSessions(): [string, StoredSession][] {
  return [...kv.store.entries()].map(([key, value]) => [key, JSON.parse(value) as StoredSession]);
}

interface GetOptions {
  cookie?: string;
  host?: string;
  method?: string;
}

async function request(path: string, options: GetOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { Host: options.host ?? HOST };
  if (options.cookie) headers.Cookie = options.cookie;
  return await app.fetch(new Request(`${ORIGIN}${path}`, { method: options.method ?? "GET", headers }), env, execCtx);
}

function setCookieNamed(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
}

// The cookie value a browser would send back, from the Set-Cookie the response
// carries -- the flow tests below hand the real cookie to the real parser
// rather than reconstructing one, so a change to how it is written is caught
// by the tests that read it.
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

// Verifies the __Host-oauth cookie the way lib/adminAuth.ts does -- with the
// real HMAC primitive over the real secret -- and returns its payload. If the
// signature ever stopped being a signature, this throws rather than silently
// letting the state/PKCE assertions pass on an unsigned blob.
async function readOAuthCookie(res: Response): Promise<OAuthCookiePayload> {
  const value = cookieHeaderFrom(res, OAUTH_COOKIE).slice(OAUTH_COOKIE.length + 1);
  const dot = value.indexOf(".");
  const json = value.slice(0, dot);
  expect(value.slice(dot + 1)).toBe(await hmacSha256Hex(HMAC_KEY, json));
  return decodeBase64UrlJson<OAuthCookiePayload>(json);
}

interface StartedFlow {
  res: Response;
  cookie: string;
  payload: OAuthCookiePayload;
  authorizeUrl: URL;
}

async function startFlow(next?: string, host = HOST): Promise<StartedFlow> {
  const query = next === undefined ? "" : `?next=${encodeURIComponent(next)}`;
  const res = await request(`/auth/start/${query}`, { host });
  expect(res.status).toBe(302);
  return {
    res,
    cookie: cookieHeaderFrom(res, OAUTH_COOKIE),
    payload: await readOAuthCookie(res),
    authorizeUrl: new URL(res.headers.get("Location")!),
  };
}

// `host` matters on the receiver as much as on the start hop: Google sends the
// browser back to whichever host the flow began on, and the token exchange
// recomputes redirect_uri from that request. See the beta-host test.
function receiver(params: Record<string, string>, cookie?: string, host?: string): Promise<Response> {
  return request(`/auth/receiver/?${new URLSearchParams(params).toString()}`, { cookie, host });
}

// Start to finish, the way a real sign-in runs: /auth/start/ mints the state
// and the PKCE verifier into the cookie, Google "redirects back" with the code
// and that same state, and the receiver exchanges it. Returns everything a
// follow-up request needs, including the session cookie a browser would then
// send on every admin page.
async function completeSignIn(next?: string, token?: IdTokenOptions): Promise<{ res: Response; sessionCookie: string; flow: StartedFlow }> {
  const flow = await startFlow(next);
  const idToken = await signIdToken(token ?? {});
  tokenResponse = () => new Response(JSON.stringify({ id_token: idToken, access_token: "ya29.test" }), { status: 200 });
  const res = await receiver({ code: "4/0AeanS0-test-authorization-code", state: flow.payload.state }, flow.cookie);
  return { res, sessionCookie: cookieHeaderFrom(res, SESSION_COOKIE), flow };
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

  // Registered exactly as index.ts:632-635 registers them: four separate GET
  // routes on the ROOT app, outside adminApp and therefore outside
  // requireAdminAuth. Both halves of that matter -- see the "reachable while
  // signed out" and "GET only" tests below.
  app = new Hono<AppEnv>();
  app.get("/auth/", adminSignIn);
  app.get("/auth/start/", adminAuthStart);
  app.get("/auth/receiver/", adminAuthReceiver);
  app.get("/auth/sign-out/", adminSignOut);

  tokenRequests = [];
  jwksFetches = 0;
  tokenResponse = () => new Response("{}", { status: 200 });
  jwksResponse = () => new Response(JSON.stringify(JWKS_DOCUMENT), { status: 200 });

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
});

// ===================== GET /auth/ =====================

describe("adminSignIn -- GET /auth/", () => {
  // THE 2026-09-03 BUG, IN ONE ASSERTION. This route used to 302 straight to
  // Google whenever `next` was present, and requireAdminAuth's gate puts a
  // `next` on every unauthenticated /admin/* visit -- so the branded page and
  // its button were skipped entirely and Google's own still-live session
  // signed the admin back in with no click. Sign Out therefore looked like it
  // did nothing. A 200 carrying the button, WITH a next present, is the fix.
  it("renders the sign-in page instead of bouncing to Google, even with ?next=", async () => {
    const res = await request("/auth/?next=%2Fadmin%2Ffoodbank%2Fsalisbury%2F");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
    expect(html).not.toContain("accounts.google.com");
    expect(html).toContain('<a href="/auth/start/?next=%2Fadmin%2Ffoodbank%2Fsalisbury%2F" class="button is-link">Sign in with Google</a>');
    // Nothing was written on the way past: a GET that mints a session would be
    // the same bug wearing a different hat.
    expect(kv.puts).toEqual([]);
  });

  it("defaults the button's next to /admin/ when the visitor arrived with none", async () => {
    const html = await (await request("/auth/")).text();

    expect(html).toContain('href="/auth/start/?next=%2Fadmin%2F"');
  });

  // TWO MUTANTS KILLED (2026-09-07 adversarial review), both of which the rest
  // of this file was blind to:
  //   * c.html(html) -> c.text(html). Every other assertion here reads
  //     res.text(), which is byte-identical for text/plain -- and a text/plain
  //     sign-in page shows the admin its own markup instead of a button.
  //   * buildPageContext({ path: c.req.path }) -> a fixed path. Nothing looked
  //     at the page context this route builds, so a canonical link pointing at
  //     the wrong URL was invisible.
  // The empty <title> is DELIBERATE PARITY, not an oversight: sign_in.html has
  // no {% block title %} either, so Django serves an empty title on this page
  // too (the template says so in its own comment, under the same
  // kept-not-fixed philosophy as the rest of WP 6.12). Asserted so that
  // "fixing" it is a visible decision rather than a drive-by.
  it("serves real HTML, canonicalised to the path it was actually requested at", async () => {
    const res = await request("/auth/");
    const html = await res.text();

    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(html).toContain('<link rel="canonical" href="https://www.givefood.org.uk/auth/">');
    expect(html).toContain("<title></title>");
  });

  // safeNextPath is Django's url_has_allowed_host_and_scheme() stand-in, and
  // this is the first of the three places its output is user-visible. An
  // off-site `next` surviving to here would be rendered into a link the admin
  // is being invited to click.
  it("replaces an off-site next with /admin/ before it reaches the page", async () => {
    for (const hostile of ["https://evil.example/", "//evil.example/", "http:/admin/"]) {
      const html = await (await request(`/auth/?next=${encodeURIComponent(hostile)}`)).text();

      expect(html).toContain('href="/auth/start/?next=%2Fadmin%2F"');
      expect(html).not.toContain("evil.example");
    }
  });

  // gfauth/templates/auth/sign_in.html's signed-in branch. Worth its own test
  // because it is the page an admin lands on after clicking Sign out, so if it
  // still showed a profile the sign-out would look like it had failed.
  it("shows the signed-in profile view, from the session actually stored in KV", async () => {
    const { sessionCookie } = await completeSignIn();

    const html = await (await request("/auth/", { cookie: sessionCookie })).text();

    expect(html).toContain("<strong>Jason</strong>");
    expect(html).toContain("jason@givefood.org.uk");
    expect(html).toContain('<img src="https://lh3.googleusercontent.com/a/test-picture" alt="User picture">');
    expect(html).toContain('<a href="/auth/sign-out/">Sign out</a>');
    expect(html).not.toContain("Sign in with Google");
  });

  // A session id from a cookie that KV has never heard of -- an expired
  // session, a cookie from a redeployed environment, or somebody guessing.
  // Must read as signed out, not as a 500: the sign-in page is the one page
  // that has to work when everything else about the session is wrong.
  it("treats an unknown session id as signed out", async () => {
    const html = await (await request("/auth/", { cookie: `${SESSION_COOKIE}=nosuchsession` })).text();

    expect(html).toContain("Sign in with Google");
    expect(kv.gets).toEqual([sessionKey("nosuchsession")]);
  });

  // A REAL BROWSER'S COOKIE JAR, which is never one cookie. An admin request
  // carries __Host-csrf as well, and a look-alike left over from a rename
  // ("__Host-gfsession-old") is exactly the kind of thing that accumulates in
  // a jar that has been through a deploy or two.
  //
  // MUTANT KILLED (2026-09-07): parseCookie's exact name match relaxed to
  // startsWith(). It survived every other test in this file because the jar
  // never held more than one cookie -- and in production it would hand the
  // look-alike's value to KV, find nothing, and sign the maintainer out with
  // no error anywhere. lib/cookies.test.ts owns the primitive's own contract;
  // what this pins is that THIS route reads its cookie out of a real jar.
  it("finds its own session cookie in a jar of others, matching the name exactly", async () => {
    const { sessionCookie } = await completeSignIn();
    const jar = `__Host-csrf=abc123.def456; __Host-gfsession-old=stale-session-id; ${sessionCookie}; _plausible=1`;

    const html = await (await request("/auth/", { cookie: jar })).text();

    expect(html).toContain("jason@givefood.org.uk");
    expect(kv.gets).not.toContain(sessionKey("stale-session-id"));
  });

  // Corrupt JSON in KV takes getAdminSession's try/catch, not the caller's.
  // Same requirement as above and a different code path to it.
  it("treats an unparseable session record as signed out rather than throwing", async () => {
    kv.store.set(sessionKey("corrupt"), "{not json");

    const res = await request("/auth/", { cookie: `${SESSION_COOKIE}=corrupt` });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Sign in with Google");
  });

  it("does not touch KV at all when there is no session cookie", async () => {
    await request("/auth/");

    expect(kv.gets).toEqual([]);
  });

  // THE ONE WRITE A GET HERE IS ALLOWED TO MAKE, pinned in both directions
  // because it is a deliberate, documented trade-off (SESSION_REFRESH_
  // THRESHOLD_SECONDS): sessions slide forward so an admin mid-session is
  // never logged out, but only past the halfway mark, because KV allows about
  // one write per second per key and re-putting on every admin page view is
  // exactly the write-per-request cost this design chose KV to avoid.
  describe("the sliding session refresh", () => {
    function seedSession(id: string, writtenMsAgo: number) {
      kv.store.set(
        sessionKey(id),
        JSON.stringify({
          email: "jason@givefood.org.uk",
          name: "Jason Cartwright",
          givenName: "Jason",
          picture: "",
          expiresAt: Date.now() - writtenMsAgo + SESSION_TTL_SECONDS * 1000,
        }),
      );
    }

    it("leaves a session written less than six hours ago alone", async () => {
      seedSession("fresh", 5 * 60 * 60 * 1000);

      await request("/auth/", { cookie: `${SESSION_COOKIE}=fresh` });

      expect(kv.puts).toEqual([]);
    });

    it("extends a session past its halfway point, keeping its identity", async () => {
      seedSession("stale", 7 * 60 * 60 * 1000);

      const html = await (await request("/auth/", { cookie: `${SESSION_COOKIE}=stale` })).text();

      expect(kv.puts).toHaveLength(1);
      expect(kv.puts[0]!.key).toBe(sessionKey("stale"));
      expect(kv.puts[0]!.expirationTtl).toBe(SESSION_TTL_SECONDS);
      const refreshed = JSON.parse(kv.puts[0]!.value) as StoredSession;
      expect(refreshed.email).toBe("jason@givefood.org.uk");
      // Slid forward to a fresh full window, not merely rewritten: a refresh
      // that kept the old expiresAt would log the admin out on schedule while
      // still paying for the write.
      expect(refreshed.expiresAt).toBeGreaterThan(Date.now() + SESSION_TTL_SECONDS * 1000 - 5000);
      expect(html).toContain("jason@givefood.org.uk");
    });
  });

  // Django's sign_in view carries @never_cache, and the port's equivalent is
  // index.ts:139-140's noStore mounts on /auth and /auth/*. Asserted here, on
  // the real page, because this URL renders two completely different documents
  // at the same address depending on a cookie -- a shared cache holding the
  // signed-in variant would serve one admin's name, email and photograph to
  // whoever asked next.
  it("is uncacheable when mounted the way index.ts mounts it", async () => {
    const wired = new Hono<AppEnv>();
    wired.use("/auth", noStore);
    wired.use("/auth/*", noStore);
    wired.get("/auth/", adminSignIn);

    const res = await wired.fetch(new Request(`${ORIGIN}/auth/`, { headers: { Host: HOST } }), env, execCtx);

    expect(res.headers.get("CDN-Cache-Control")).toBe("no-store");
    expect(res.headers.get("Vary")).toBe("Cookie");
  });
});

// ===================== GET /auth/start/ =====================

describe("adminAuthStart -- GET /auth/start/", () => {
  // The whole authorize URL, field by field. Every one of these is load-
  // bearing at Google's end: a wrong redirect_uri or client_id is a
  // "400: redirect_uri_mismatch" error page instead of a sign-in, and a
  // missing code_challenge_method silently downgrades PKCE to plain.
  it("redirects to Google's authorize endpoint with the parameters Google requires", async () => {
    const { res, authorizeUrl, payload } = await startFlow("/admin/foodbank/salisbury/");

    expect(res.status).toBe(302);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(authorizeUrl.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/receiver/`);
    expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizeUrl.searchParams.get("scope")).toBe("openid email profile");
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    // A login hint only -- it narrows Google's account chooser. The real
    // authorization check is the `hd` claim on the token that comes back, and
    // the receiver tests below prove it is not this parameter doing the work.
    expect(authorizeUrl.searchParams.get("hd")).toBe("givefood.org.uk");
    // The state on the wire is the state in the signed cookie: if these two
    // ever came from different places the CSRF check would compare a value
    // with itself and pass for anybody.
    expect(authorizeUrl.searchParams.get("state")).toBe(payload.state);
  });

  // PKCE, executed rather than assumed. code_challenge must be the base64url
  // SHA-256 of the verifier the cookie is carrying, because that is the pair
  // Google checks at the token endpoint; a challenge derived from anything
  // else fails the exchange in production and nowhere else.
  it("sends a code_challenge that is really S256 of the verifier in the cookie", async () => {
    const { authorizeUrl, payload } = await startFlow();

    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload.codeVerifier));
    expect(authorizeUrl.searchParams.get("code_challenge")).toBe(base64Url(new Uint8Array(digest)));
  });

  // A fixed state or verifier would make the CSRF and PKCE checks decorative:
  // an attacker who saw one flow could complete another. Cheap to assert,
  // impossible to notice by reading a passing test that only checks presence.
  it("mints a fresh state and verifier on every click", async () => {
    const first = await startFlow();
    const second = await startFlow();

    expect(first.payload.state).not.toBe(second.payload.state);
    expect(first.payload.codeVerifier).not.toBe(second.payload.codeVerifier);
    expect(first.payload.state.length).toBeGreaterThanOrEqual(32);
    expect(first.payload.codeVerifier.length).toBeGreaterThanOrEqual(43); // RFC 7636's minimum verifier length
  });

  // __Host- prefix rules (Secure, Path=/, no Domain) plus HttpOnly and
  // SameSite=Lax. SameSite=Lax rather than Strict is required, not incidental:
  // Google's redirect back to /auth/receiver/ is a cross-site top-level
  // navigation, and under Strict the browser would withhold this cookie and
  // every sign-in would fail the state check.
  it("stores state, verifier and next in a signed __Host- cookie", async () => {
    const { res, payload } = await startFlow("/admin/needs/");

    const cookie = setCookieNamed(res, OAUTH_COOKIE)!;
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=600");
    expect(payload.next).toBe("/admin/needs/");
  });

  // GET DOES NOT MUTATE. Clicking "Sign in with Google" must not create an
  // admin: everything this hop produces is a signed cookie in the visitor's
  // own browser, and the session does not exist until Google has said who they
  // are. A start hop that wrote to KV would be a way to mint sessions without
  // ever visiting Google -- the same shape of bug as the auto-redirect this
  // route was split out to fix.
  it("writes nothing to KV -- nobody is signed in until the receiver runs", async () => {
    await startFlow("/admin/needs/");
    await startFlow();

    expect(kv.puts).toEqual([]);
    expect(kv.store.size).toBe(0);
  });

  // Note on what this does and does not pin: adminAuthStart calls
  // safeNextPath and startGoogleOAuth calls it AGAIN on the value it is given
  // (lib/adminAuth.ts's `next: safeNextPath(next)`), so deleting the route's
  // own call leaves every assertion here green -- run as a mutant, not
  // assumed, and re-run in the 2026-09-07 review with the same result. That
  // mutant is EQUIVALENT rather than uncaught: the value reaching the cookie
  // is sanitised either way, so there is no observable behaviour left to
  // assert. The duplication is belt and braces rather than an accident, and
  // the claim below is about the value that ends up in the cookie, which is
  // the only one the receiver will ever redirect to.
  it("carries a safe next into the cookie and rewrites an unsafe one", async () => {
    expect((await startFlow("/admin/foodbank/salisbury/location/new/")).payload.next).toBe("/admin/foodbank/salisbury/location/new/");
    expect((await startFlow("https://evil.example/steal")).payload.next).toBe("/admin/");
    expect((await startFlow("//evil.example/steal")).payload.next).toBe("/admin/");
    expect((await startFlow("")).payload.next).toBe("/admin/");
    expect((await startFlow()).payload.next).toBe("/admin/");
  });

  // SUSPECT, PINNED AS-IS (reported, not fixed). safeNextPath's own comment
  // says it reproduces Django's url_has_allowed_host_and_scheme(), which
  // rejects a backslash form precisely because "Chrome treats \ completely as
  // / in paths" -- run against Django 5.2.6 in the reference checkout,
  // url_has_allowed_host_and_scheme("/\\evil.example/", allowed_hosts=None) is
  // False. This check only rejects a literal "//" prefix, so the backslash
  // form survives into the cookie and, after a genuine sign-in, into the
  // Location header (see the receiver test that follows it through). Browsers
  // normalise "/\" to "//" for http(s) URLs, so that is an off-site redirect.
  // Asserted as it behaves today so that tightening it is a visible change.
  it("keeps a backslash-prefixed next that Django's own check would have rejected", async () => {
    expect((await startFlow("/\\evil.example/")).payload.next).toBe("/\\evil.example/");
  });

  // oauthOrigin(). redirect_uri must byte-match a URI registered on the OAuth
  // client AND match the one sent to the token endpoint, so this cannot simply
  // reflect the Host header -- but beta.givefood.org.uk is a real registered
  // proving-ground host that has to work standalone.
  describe("redirect_uri, which Google matches byte for byte", () => {
    it("uses the beta host when the request really came to it", async () => {
      const { authorizeUrl } = await startFlow(undefined, "beta.givefood.org.uk");

      expect(authorizeUrl.searchParams.get("redirect_uri")).toBe("https://beta.givefood.org.uk/auth/receiver/");
    });

    it("uses a localhost host for wrangler dev", async () => {
      const { authorizeUrl } = await startFlow(undefined, "localhost:8787");

      expect(authorizeUrl.searchParams.get("redirect_uri")).toBe("https://localhost:8787/auth/receiver/");
    });

    // MUTANT KILLED (2026-09-07): deleting the `127.0.0.1:` arm of
    // oauthOrigin's allowlist survived, because only the `localhost:` spelling
    // was ever exercised. They are not interchangeable -- `wrangler dev --ip
    // 127.0.0.1` prints the numeric form, and a dev session on it would get a
    // redirect_uri pointing at PRODUCTION, sending the developer's sign-in to
    // the live site (or straight into Google's redirect_uri_mismatch page).
    it("uses the loopback IP spelling of the dev host as well as the name", async () => {
      const { authorizeUrl } = await startFlow(undefined, "127.0.0.1:8787");

      expect(authorizeUrl.searchParams.get("redirect_uri")).toBe("https://127.0.0.1:8787/auth/receiver/");
    });

    // The security half: an unrecognised Host header never becomes a
    // redirect_uri. It falls back to SITE_DOMAIN rather than reflecting
    // whatever a request claimed to be addressed to.
    it("falls back to SITE_DOMAIN for a host it does not recognise", async () => {
      const { authorizeUrl } = await startFlow(undefined, "evil.example");

      expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/receiver/`);
    });
  });

  // Fails closed and says so, rather than sending the admin to Google to come
  // back with a code nothing can verify. The cookie assertion is the point: an
  // unsigned state cookie would be worse than none.
  it("refuses to start the flow with no SESSION_HMAC_KEY, and sets no cookie", async () => {
    env = { ...env, SESSION_HMAC_KEY: "" } as AppEnv["Bindings"];

    const res = await request("/auth/start/");

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Auth not configured");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  // SUSPECT, PINNED AS-IS. Only SESSION_HMAC_KEY is guarded: an unset
  // GOOGLE_OAUTH_CLIENT_ID still redirects, with the literal string
  // "undefined" as the client_id, so the admin gets Google's own
  // "invalid_client" error page rather than this route's "Auth not
  // configured". The receiver guards its client secret; this one does not
  // guard its client id.
  it("still redirects to Google when the client id is missing", async () => {
    env = { ...env, GOOGLE_OAUTH_CLIENT_ID: undefined } as unknown as AppEnv["Bindings"];

    const res = await request("/auth/start/");

    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("Location")!).searchParams.get("client_id")).toBe("undefined");
  });
});

// ===================== GET /auth/receiver/ =====================

describe("adminAuthReceiver -- GET /auth/receiver/", () => {
  describe("a real sign-in", () => {
    // THE WRITE ACTUALLY HAPPENED. The redirect is the least interesting half:
    // what makes somebody an admin is the record in KV and the cookie pointing
    // at it, so both are read back, and the identity in the record is compared
    // against the claims in the token that produced it.
    it("stores a session in KV, sets the cookie for it, and returns to next", async () => {
      const { res, sessionCookie, flow } = await completeSignIn("/admin/foodbank/salisbury/");

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/admin/foodbank/salisbury/");

      const sessions = storedSessions();
      expect(sessions).toHaveLength(1);
      const [key, stored] = sessions[0]!;
      expect(stored).toMatchObject({
        email: "jason@givefood.org.uk",
        name: "Jason Cartwright",
        givenName: "Jason",
        picture: "https://lh3.googleusercontent.com/a/test-picture",
      });
      // The cookie has to name the key that was actually written, or the
      // admin is holding a ticket for a session nobody stored.
      expect(key).toBe(sessionKey(sessionCookie.slice(SESSION_COOKIE.length + 1)));
      expect(kv.puts[0]!.expirationTtl).toBe(SESSION_TTL_SECONDS);
      // Google's `next` never appears in the query string of this request --
      // it came out of the signed cookie the flow started with, which is why
      // it cannot be tampered with between the two hops.
      expect(flow.payload.next).toBe("/admin/foodbank/salisbury/");
    });

    it("sets a __Host- session cookie whose lifetime matches the stored TTL", async () => {
      const { res } = await completeSignIn();

      const cookie = setCookieNamed(res, SESSION_COOKIE)!;
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    });

    // "Single-use, regardless of outcome" -- the state/verifier cookie is
    // cleared on the same response that sets the session, so a code replayed
    // from a browser's history has no verifier to go with it.
    it("clears the oauth cookie on the way through", async () => {
      const { res } = await completeSignIn();

      expect(setCookieNamed(res, OAUTH_COOKIE)).toBe(`${OAUTH_COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    });

    // THE ROUND TRIP, END TO END: the cookie this flow handed the browser is
    // the cookie that opens the admin. Everything in between -- KV key
    // derivation, cookie parsing, the JSON shape -- is exercised by asserting
    // the gate lets the request through and hands the session downstream.
    it("produces a session requireAdminAuth accepts", async () => {
      const { sessionCookie } = await completeSignIn();

      const gated = new Hono<AppEnv>();
      gated.use("*", requireAdminAuth);
      gated.get("/admin/", (c) => c.text(`admin: ${c.get("adminUser")?.email}`));

      const res = await gated.fetch(new Request(`${ORIGIN}/admin/`, { headers: { Host: HOST, Cookie: sessionCookie } }), env, execCtx);

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("admin: jason@givefood.org.uk");
    });

    // What actually goes to Google, which nothing else can check: the code,
    // the client credentials, grant_type, and -- the PKCE half -- the verifier
    // matching the challenge sent at the start. redirect_uri must be identical
    // to the one used in the authorize step or Google rejects the exchange.
    it("exchanges the code with the verifier and redirect_uri the flow started with", async () => {
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

    // THE SAME CLAIM FROM THE OTHER REGISTERED HOST, which is the one that can
    // actually break. MUTANT KILLED (2026-09-07): hardcoding the exchange's
    // redirect_uri to `c.env.SITE_DOMAIN` survived the test above, because on
    // www the two strings are identical -- every assertion in this file ran on
    // www. On beta.givefood.org.uk (PLAN.md's documented proving-ground host,
    // and the one that gets tested against real infra before a launch) the
    // authorize hop would work perfectly and the token exchange would come
    // back "redirect_uri_mismatch": Google requires the two hops to name the
    // same URI byte for byte, and it has to be the host the browser is on.
    it("exchanges from the beta host with the beta redirect_uri, not the www one", async () => {
      const beta = "beta.givefood.org.uk";
      const flow = await startFlow(undefined, beta);
      const idToken = await signIdToken();
      tokenResponse = () => new Response(JSON.stringify({ id_token: idToken }), { status: 200 });

      const res = await receiver({ code: "abc", state: flow.payload.state }, flow.cookie, beta);

      // A genuine sign-in, asserted first: a refusal would never reach the
      // token endpoint and the redirect_uri claim below would be vacuous.
      expect(res.status).toBe(302);
      expect(kv.store.size).toBe(1);
      expect(flow.authorizeUrl.searchParams.get("redirect_uri")).toBe(`https://${beta}/auth/receiver/`);
      expect(tokenRequests[0]!.get("redirect_uri")).toBe(`https://${beta}/auth/receiver/`);
    });

    // Google's JWKS is cached by kid at MODULE scope for the isolate's life
    // ("cache by kid; keys rotate"), so a second sign-in verifies against keys
    // already in hand. Stated as "no fetch the second time" rather than "one
    // fetch in total", because the cache outlives a test: whether the first
    // fetch in this test is the first in the whole file depends on execution
    // order, and a test that asserted a count would be pinning that order
    // instead of the caching.
    it("reuses Google's signing keys rather than refetching them per sign-in", async () => {
      await completeSignIn();
      const fetchesAfterFirst = jwksFetches;
      await completeSignIn();

      expect(jwksFetches).toBe(fetchesAfterFirst);
      expect(jwksFetches).toBeLessThanOrEqual(1); // never once per sign-in
    });

    // Optional claims. Google omits `name`/`given_name` for some accounts, and
    // the profile view renders both -- falling back to the email keeps the
    // signed-in page from rendering a blank name.
    it("falls back to the email address when Google sends no name", async () => {
      await completeSignIn(undefined, { name: undefined, givenName: undefined, picture: undefined });

      const [, stored] = storedSessions()[0]!;
      expect(stored.name).toBe("jason@givefood.org.uk");
      expect(stored.givenName).toBe("jason@givefood.org.uk");
      expect(stored.picture).toBe("");
    });

    // SUSPECT, PINNED AS-IS. The open redirect from adminAuthStart's backslash
    // test, followed all the way to the Location header an admin's browser
    // would obey. Reaching it needs a successful sign-in against a `next` the
    // attacker chose, which is a phishing-grade nuisance rather than an
    // account takeover -- but it is the exact case Django's own helper exists
    // to block, and this port's comment claims to reproduce that helper.
    it("redirects to a backslash-prefixed next after sign-in", async () => {
      const { res } = await completeSignIn("/\\evil.example/");

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/\\evil.example/");
    });
  });

  // Every refusal below asserts the same two things as well as the status: no
  // session in KV, and (where it applies) no exchange with Google. A redirect
  // to /auth/ that had nonetheless created a session would look identical to
  // a working refusal from the outside.
  describe("refusals", () => {
    function expectNobodySignedIn(res: Response) {
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/auth/");
      expect(kv.store.size).toBe(0);
      expect(setCookieNamed(res, SESSION_COOKIE)).toBeUndefined();
    }

    // The "cancel" button on Google's consent screen, and every other
    // user-visible failure Google reports: back to the sign-in page to try
    // again, not a dead end.
    //
    // MUTANT KILLED (2026-09-07): deleting the `error ||` clause from the
    // callback's guard survived the original version of this test, because
    // that version sent no `code` either -- so the refusal it was really
    // pinning was `!code`, and the error parameter was never load-bearing in
    // any assertion. A `code` alongside an `error` is not a pair Google sends,
    // which is the point: it isolates the clause under test, and without it
    // this callback walks past a reported failure and exchanges the code.
    it("sends the admin back to the sign-in page when Google reports an error", async () => {
      const flow = await startFlow();

      const res = await receiver({ error: "access_denied", code: "4/0AeanS0-ignored", state: flow.payload.state }, flow.cookie);

      expectNobodySignedIn(res);
      expect(tokenRequests).toEqual([]);
    });

    it("refuses a callback with no code", async () => {
      const flow = await startFlow();

      expectNobodySignedIn(await receiver({ state: flow.payload.state }, flow.cookie));
      expect(tokenRequests).toEqual([]);
    });

    it("refuses a callback with no state", async () => {
      const flow = await startFlow();

      expectNobodySignedIn(await receiver({ code: "abc" }, flow.cookie));
      expect(tokenRequests).toEqual([]);
    });

    // No cookie means no flow was ever started from this browser: somebody
    // pasted a receiver URL, or a third-party site navigated to one.
    it("refuses a callback with no oauth cookie", async () => {
      const flow = await startFlow();

      expectNobodySignedIn(await receiver({ code: "abc", state: flow.payload.state }));
      expect(tokenRequests).toEqual([]);
    });

    // THE CSRF CHECK. An attacker who can make the admin's browser hit
    // /auth/receiver/ with a code from the ATTACKER'S OWN Google account would
    // otherwise log the admin into the attacker's session -- classic OAuth
    // login CSRF. The state comparison is what stops it, and nothing may reach
    // Google before it passes.
    it("refuses a state that does not match the cookie, without contacting Google", async () => {
      const flow = await startFlow();

      const res = await receiver({ code: "abc", state: `${flow.payload.state}x` }, flow.cookie);

      expectNobodySignedIn(res);
      expect(tokenRequests).toEqual([]);
    });

    // THE SAME CHECK WITH A STATE AN ATTACKER WOULD ACTUALLY PRESENT: the
    // right length, the wrong value. MUTANT KILLED (2026-09-07): reducing
    // timingSafeEqual to `return a.length === b.length` survived the test
    // above, whose wrong state is one character LONGER than the real one -- so
    // the whole login-CSRF defence would have degraded to "is it 32 characters
    // long?" with all 58 tests still green. lib/hmac.test.ts owns the
    // primitive's contract; this pins that the receiver's use of it is
    // comparing content, on a value the attacker chooses the length of.
    it("refuses a state of the right length but the wrong value", async () => {
      const flow = await startFlow();
      const real = flow.payload.state;
      const sameLength = real.slice(0, -1) + (real.endsWith("A") ? "B" : "A");
      expect(sameLength).toHaveLength(real.length);
      expect(sameLength).not.toBe(real);

      const res = await receiver({ code: "abc", state: sameLength }, flow.cookie);

      expectNobodySignedIn(res);
      expect(tokenRequests).toEqual([]);
    });

    // The signature is the only thing that makes the cookie's state and
    // verifier trustworthy. A forged cookie with a state the attacker chose
    // (and knows) would defeat the check above entirely.
    it("refuses a tampered oauth cookie even when its state matches", async () => {
      await startFlow(); // a genuine flow exists; the attacker's cookie is the one presented
      const forged = `${OAUTH_COOKIE}=${base64UrlJson({ state: "attacker-state", codeVerifier: "attacker-verifier", next: "/admin/" })}.deadbeef`;

      const res = await receiver({ code: "abc", state: "attacker-state" }, forged);

      expectNobodySignedIn(res);
      expect(tokenRequests).toEqual([]);
    });

    it("clears the oauth cookie even when it refuses", async () => {
      const flow = await startFlow();

      const res = await receiver({ code: "abc", state: "wrong" }, flow.cookie);

      expect(setCookieNamed(res, OAUTH_COOKIE)).toContain("Max-Age=0");
    });

    // A code Google will not exchange (already used, expired, or issued to a
    // different client). Distinct from every other refusal here: 403 with a
    // plain-text body rather than a redirect, because there is nothing useful
    // for the admin to retry from this state. Pinned because the difference is
    // easy to "tidy" into a redirect and it is the one status that tells the
    // maintainer the failure was Google's, not theirs.
    it("answers 403 when Google refuses the token exchange", async () => {
      const flow = await startFlow();
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      tokenResponse = () => new Response('{"error":"invalid_grant"}', { status: 400 });

      const res = await receiver({ code: "used-already", state: flow.payload.state }, flow.cookie);
      const body = await res.text();

      expect(res.status).toBe(403);
      expect(kv.store.size).toBe(0);
      // The raw Google error goes to console.error, never to the page -- an
      // OAuth error body carries request-specific detail (and, on some
      // failures, the client id) that an admin has no use for.
      expect(body).toBe("Sign-in failed");
      expect(body).not.toContain("invalid_grant");
      expect(logged).toHaveBeenCalledWith("Google token exchange failed", 400, '{"error":"invalid_grant"}');
      logged.mockRestore();
    });

    it("refuses a token response with no id_token", async () => {
      const flow = await startFlow();
      tokenResponse = () => new Response(JSON.stringify({ access_token: "ya29.test" }), { status: 200 });

      expectNobodySignedIn(await receiver({ code: "abc", state: flow.payload.state }, flow.cookie));
    });
  });

  // verifyGoogleIdToken(), reached through the route with real RSA material.
  // Each of these is a token that a browser could actually present; the
  // question in every case is whether a session is created, and the answer
  // has to be no.
  describe("ID token verification", () => {
    async function signInWith(token: IdTokenOptions): Promise<Response> {
      const flow = await startFlow();
      const idToken = await signIdToken(token);
      tokenResponse = () => new Response(JSON.stringify({ id_token: idToken }), { status: 200 });
      return receiver({ code: "abc", state: flow.payload.state }, flow.cookie);
    }

    function expectRejected(res: Response) {
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/auth/");
      expect(kv.store.size).toBe(0);
    }

    // THE ALGORITHM-CONFUSION FOOTGUN, both spellings. `alg: none` is the
    // textbook JWT forgery; HS256 is the subtler one, where a verifier that
    // trusted the header would treat Google's PUBLIC key as an HMAC secret --
    // and that key is published, so anyone could mint tokens. Google's own
    // discovery document lists RS256 as the only id_token algorithm, so
    // anything else is rejected before a key is even fetched.
    it("rejects a token whose header asks for a different algorithm", async () => {
      expectRejected(await signInWith({ alg: "none" }));
      expectRejected(await signInWith({ alg: "HS256" }));
    });

    // A key Google never published. The kid names a key that is not in the
    // JWKS, so there is nothing to verify against.
    it("rejects a token signed by a key id Google does not publish", async () => {
      expectRejected(await signInWith({ kid: "not-a-google-key", key: impostorKeys.privateKey }));
    });

    // THE SIGNATURE CHECK ITSELF, and the mutant that matters most: this token
    // is well-formed, unexpired, correctly addressed and claims the right kid
    // -- everything except being signed by Google. If crypto.subtle.verify's
    // result were ignored, this is the test that catches it, and nothing else
    // in this file would.
    it("rejects a token signed by an impostor using a real key id", async () => {
      expectRejected(await signInWith({ key: impostorKeys.privateKey }));
    });

    // Google issues one ID token per client. A token minted for somebody
    // else's OAuth client is a valid Google signature over claims that were
    // never meant for this site -- the classic confused-deputy sign-in.
    it("rejects a token issued for a different client id", async () => {
      expectRejected(await signInWith({ aud: "someone-elses-client.apps.googleusercontent.com" }));
    });

    it("rejects a token from an unexpected issuer", async () => {
      expectRejected(await signInWith({ iss: "https://accounts.evil.example" }));
    });

    // Both spellings Google documents for its own issuer are accepted -- so
    // this is the positive control for the check above, and the proof that
    // tightening it to one form would start rejecting real tokens.
    it("accepts the bare-hostname issuer Google also uses", async () => {
      const res = await signInWith({ iss: "accounts.google.com" });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/admin/");
      expect(kv.store.size).toBe(1);
    });

    it("rejects an expired token", async () => {
      expectRejected(await signInWith({ expiresInSeconds: -60 }));
    });

    it("rejects a token that is not three dot-separated parts", async () => {
      const flow = await startFlow();
      tokenResponse = () => new Response(JSON.stringify({ id_token: "not.a.jwt.at.all" }), { status: 200 });

      expectRejected(await receiver({ code: "abc", state: flow.payload.state }, flow.cookie));
    });

    // GOOGLE BEING UNREACHABLE IS NOT A REFUSED ACCOUNT, and the difference is
    // the whole diagnosis: getGoogleJwk throws, Hono turns that into a 500,
    // and the maintainer sees a server error instead of a sign-in page
    // implying (wrongly) that their own account was rejected. Pinned as it
    // behaves today. MUTANT KILLED (2026-09-07): softening that throw to
    // `return null` survived the original file -- it turns a Google outage
    // into an unbreakable "sign in again" loop, indistinguishable from being
    // locked out, with nothing in the logs to say which it was.
    //
    // Reached with a kid the isolate has never cached, because that is the
    // only thing that forces a fetch: the JWKS map is cached per isolate and
    // keyed by kid, so the good key is already in hand by this point. The
    // failing response cannot poison that cache -- getGoogleJwk throws before
    // it assigns -- which is why this test can safely run in any order.
    it("fails loudly rather than as a refusal when Google's JWKS is unreachable", async () => {
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

  // givefood/middleware.py:68's LoginRequiredAccess gate -- `email_verified &&
  // hd == "givefood.org.uk"` -- reproduced as this flow's authorization check.
  // Django applied it on every request; this port applies it once, at the only
  // moment it can: after the token is verified and before a session exists. So
  // these two tests are the entire difference between "any Google account on
  // earth can edit the site" and "the maintainer can".
  describe("the givefood.org.uk gate", () => {
    async function attempt(token: IdTokenOptions): Promise<Response> {
      const flow = await startFlow();
      const idToken = await signIdToken(token);
      tokenResponse = () => new Response(JSON.stringify({ id_token: idToken }), { status: 200 });
      return receiver({ code: "abc", state: flow.payload.state }, flow.cookie);
    }

    it("refuses a personal Google account, which carries no hd at all", async () => {
      const res = await attempt({ email: "someone@gmail.com", hd: undefined });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/auth/");
      expect(kv.store.size).toBe(0);
      expect(setCookieNamed(res, SESSION_COOKIE)).toBeUndefined();
    });

    it("refuses another Workspace domain", async () => {
      const res = await attempt({ email: "someone@example.com", hd: "example.com" });

      expect(kv.store.size).toBe(0);
      expect(res.headers.get("Location")).toBe("/auth/");
    });

    // Unverified email with the right hd: still refused. Django checked both
    // and so does this, because an unverified address is not proof of anything.
    it("refuses an unverified email even on the right domain", async () => {
      const res = await attempt({ emailVerified: false });

      expect(kv.store.size).toBe(0);
      expect(res.headers.get("Location")).toBe("/auth/");
    });

    // A rejection is a redirect back to the branded sign-in page, not a bare
    // 403: the admin may simply have picked the wrong account in Google's
    // chooser, and dead-ending them there would be worse than useless.
    it("sends a refused account to the sign-in page rather than a 403", async () => {
      const res = await attempt({ hd: "example.com" });

      expect(res.status).toBe(302);
      expect(res.status).not.toBe(403);
    });
  });

  // Both secrets, both fail-closed. The receiver cannot verify a state cookie
  // without the HMAC key, and cannot exchange a code without the client
  // secret; either missing has to stop the flow rather than half-run it.
  //
  // MUTANT KILLED (2026-09-07): deleting `|| !clientSecret` from that guard
  // survived the original version of this test, which spread each `missing`
  // onto the env its PREVIOUS iteration had already broken -- so by the time
  // the client secret was removed the HMAC key was still empty, the first half
  // of the guard was doing all the work, and the client-secret arm was in
  // truth untested. Each iteration now starts from the fully configured env.
  // Without that arm the receiver reaches Google with an empty client_secret
  // and reports the resulting failure as Google's (403 "Sign-in failed"),
  // which sends the maintainer looking at their OAuth client instead of at
  // their missing secret.
  it("refuses to run at all with either secret missing", async () => {
    const flow = await startFlow();
    const configured = env;

    for (const missing of [{ SESSION_HMAC_KEY: "" }, { GOOGLE_OAUTH_CLIENT_SECRET: "" }]) {
      env = { ...configured, ...missing } as AppEnv["Bindings"];
      const res = await receiver({ code: "abc", state: flow.payload.state }, flow.cookie);

      expect(res.status).toBe(500);
      expect(await res.text()).toBe("Auth not configured");
      expect(tokenRequests).toEqual([]);
      expect(kv.store.size).toBe(0);
    }
  });

  // A DELIBERATE DIVERGENCE FROM DJANGO, pinned where it is visible.
  // gfauth/views.py's auth_receiver is a @csrf_exempt POST handler reading
  // request.POST['credential'] -- Google Identity Services' client-driven
  // ID-token hand-off. This port replaced that with a server-side
  // Authorization Code + PKCE exchange, so the same URL is now GET-only and a
  // POST does not reach the handler at all. Worth an assertion because the URL
  // is a registered redirect URI that outlived the flow behind it: if Google
  // is ever reconfigured back to the button, this 404 is what the symptom
  // would look like.
  it("is registered GET-only, unlike Django's POST receiver", async () => {
    const res = await request("/auth/receiver/?code=abc&state=abc", { method: "POST" });

    expect(res.status).toBe(404);
    expect(tokenRequests).toEqual([]);
  });
});

// ===================== GET /auth/sign-out/ =====================

describe("adminSignOut -- GET /auth/sign-out/", () => {
  // The deletion is the assertion. Clearing the cookie alone would leave a
  // usable session sitting in KV for twelve hours, retrievable by anyone who
  // had captured the cookie value.
  it("deletes the session from KV and clears the cookie", async () => {
    const { sessionCookie } = await completeSignIn();
    const id = sessionCookie.slice(SESSION_COOKIE.length + 1);
    expect(kv.store.has(sessionKey(id))).toBe(true);

    const res = await request("/auth/sign-out/", { cookie: sessionCookie });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/");
    expect(kv.deletes).toContain(sessionKey(id));
    expect(kv.store.has(sessionKey(id))).toBe(false);
    expect(setCookieNamed(res, SESSION_COOKIE)).toBe(`${SESSION_COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  });

  // The other half of the same claim: the cookie is dead server-side too, so
  // replaying it after sign-out gets the signed-out page. This is what makes
  // the deletion above meaningful rather than merely tidy.
  it("makes the old cookie useless even if the browser keeps sending it", async () => {
    const { sessionCookie } = await completeSignIn();
    await request("/auth/sign-out/", { cookie: sessionCookie });

    const html = await (await request("/auth/", { cookie: sessionCookie })).text();

    expect(html).toContain("Sign in with Google");
    expect(html).not.toContain("jason@givefood.org.uk");
  });

  // Django's sign_out pops a key that may not be there and redirects
  // regardless. Same here: a sign-out with no session is a no-op with a
  // redirect, not an error page.
  it("redirects without touching KV when nobody was signed in", async () => {
    const res = await request("/auth/sign-out/");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/");
    expect(kv.deletes).toEqual([]);
    // The clear-cookie header goes out anyway, which is what removes a cookie
    // whose KV record has already expired.
    expect(setCookieNamed(res, SESSION_COOKIE)).toContain("Max-Age=0");
  });

  it("tolerates a session id KV has never held", async () => {
    const res = await request("/auth/sign-out/", { cookie: `${SESSION_COOKIE}=nosuchsession` });

    expect(res.status).toBe(302);
    expect(kv.deletes).toEqual([sessionKey("nosuchsession")]);
  });
});

// ===================== the whole reason /auth/start/ exists =====================

// THE REGRESSION OF 2026-09-03, REPRODUCED END TO END. Signing out cannot sign
// the admin out of Google -- that is a different site -- so before this split
// the next /admin/* visit went: gate 302 -> /auth/?next=... -> (auto) 302 to
// Google -> Google's live session answers instantly -> back in, no click, no
// visible page. Sign Out did nothing you could see. This test walks the exact
// sequence with the real gate and the real routes and asserts the chain now
// STOPS at a rendered page with a button on it. Every step is a real response;
// nothing here is a stand-in.
describe("signing out, then visiting the admin again", () => {
  it("stops at the sign-in page instead of silently re-authenticating", async () => {
    const { sessionCookie } = await completeSignIn();
    await request("/auth/sign-out/", { cookie: sessionCookie });

    const gated = new Hono<AppEnv>();
    gated.use("*", requireAdminAuth);
    gated.get("/admin/foodbank/salisbury/", (c) => c.text("the admin"));
    const blocked = await gated.fetch(
      new Request(`${ORIGIN}/admin/foodbank/salisbury/`, { headers: { Host: HOST, Cookie: sessionCookie } }),
      env,
      execCtx,
    );

    expect(blocked.status).toBe(302);
    expect(blocked.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Ffoodbank%2Fsalisbury%2F");

    // ...and following that redirect is where the old bug lived.
    const signIn = await request(blocked.headers.get("Location")!, { cookie: sessionCookie });
    const html = await signIn.text();

    expect(signIn.status).toBe(200);
    expect(signIn.headers.get("Location")).toBeNull();
    expect(html).toContain('href="/auth/start/?next=%2Fadmin%2Ffoodbank%2Fsalisbury%2F"');
    expect(tokenRequests).toHaveLength(1); // still just the one from the original sign-in

    // Only the explicit click on that link talks to Google, and it carries the
    // page the admin was originally trying to reach all the way through.
    const started = await request("/auth/start/?next=%2Fadmin%2Ffoodbank%2Fsalisbury%2F");
    expect(started.status).toBe(302);
    expect(started.headers.get("Location")).toContain("https://accounts.google.com/o/oauth2/v2/auth");
    expect((await readOAuthCookie(started)).next).toBe("/admin/foodbank/salisbury/");
  });

  // The four /auth/ routes are registered on the ROOT app, outside adminApp
  // and therefore outside requireAdminAuth. If they were ever moved under the
  // gate the site would be unrecoverable: the gate would redirect to a page
  // that redirects to the gate.
  it("serves every /auth/ route to a signed-out visitor", async () => {
    expect((await request("/auth/")).status).toBe(200);
    expect((await request("/auth/start/")).status).toBe(302);
    expect((await request("/auth/sign-out/")).status).toBe(302);
    expect((await request("/auth/receiver/")).status).toBe(302); // no code/state -> back to /auth/
  });
});
