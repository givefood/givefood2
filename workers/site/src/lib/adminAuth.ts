import type { Context } from "hono";
import type { AppEnv } from "../types";
import { hmacSha256Hex, timingSafeEqual } from "./hmac";
import { parseCookie } from "./cookies";

// WP 6.1/6.2 (PLAN.md §10.2.7, "per the maintainer's decision"). This is
// NOT a port of gfauth/views.py -- that view accepts a Google Identity
// Services "Sign In With Google" button POST (a client-driven ID-token
// hand-off, `data-ux_mode="redirect"` in auth/sign_in.html, no PKCE/state,
// `@csrf_exempt`, and no verification of Google's own g_csrf_token
// cookie/body pair, which Google's own docs recommend checking for that
// flow). The maintainer's decision replaces it with a standard server-
// driven Authorization Code + PKCE exchange instead: this Worker redirects
// to Google, Google redirects back with a `code`, and the token exchange
// (and the `state`/PKCE checks that protect it) happens server-to-server.
// `/auth/receiver/` keeps its exact path -- it's a registered redirect URI
// -- but the flow behind it is genuinely different from Django's, by
// design, not by accident. Per the user's own scoping note: auth exists
// solely to gate the admin, so this lives under lib/ for routes/admin/ to
// use, not as a standalone top-level feature.
//
// givefood/middleware.py's LoginRequiredAccess gate (`email_verified &&
// hd == "givefood.org.uk"`) is reproduced verbatim as this flow's own
// authorization check, at the one place that check can now happen: right
// after the ID token is verified, before a session is ever created.

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";
// Verified directly against Google's real discovery document
// (https://accounts.google.com/.well-known/openid-configuration):
// issuer "https://accounts.google.com", id_token_signing_alg_values_supported
// is RS256-only, jwks_uri as above. `iss` is documented to appear as either
// form below across Google's token issuers, so both are accepted.
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const HOSTED_DOMAIN = "givefood.org.uk";

// `redirect_uri` must be identical between the initial authorize redirect
// and the token exchange (Google rejects a mismatch), and must exactly
// match one of the URIs registered on the OAuth client -- so this can't
// just reflect an arbitrary incoming Host header. `beta.givefood.org.uk`
// is PLAN.md's own documented "proving-ground host" (§10.1.1a) -- a real
// custom domain used to test against real infra before the single
// production launch, distinct from the live `www` zone -- so it needs to
// work standalone, not only redirect back to www. Falls back to
// SITE_DOMAIN for any host not on this list (never trusts an unrecognised
// Host header into a redirect_uri Google would reject anyway).
const OAUTH_HOSTS = ["www.givefood.org.uk", "beta.givefood.org.uk"];

function oauthOrigin(c: Context<AppEnv>): string {
  const host = c.req.header("Host");
  if (host && (OAUTH_HOSTS.includes(host) || host.startsWith("localhost:") || host.startsWith("127.0.0.1:"))) {
    return `${new URL(c.req.url).protocol}//${host}`;
  }
  return c.env.SITE_DOMAIN;
}

const OAUTH_COOKIE_NAME = "__Host-oauth";
const OAUTH_COOKIE_MAX_AGE_SECONDS = 600; // 10 minutes -- long enough for a real sign-in, short enough that a stale cookie isn't a lingering replay surface

const SESSION_COOKIE_NAME = "__Host-gfsession";
const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12h
// Sliding, but not re-extended on every read: KV enforces roughly one
// write/sec per key, and re-putting on every admin page view would turn
// exactly the write-per-request cost this design chose KV over D1 to
// avoid (PLAN.md's own reasoning: "KV's read path is the cheapest and D1
// would make a write-per-request out of every admin page") into a KV
// write-per-request instead. Only re-extended once the session is past
// its halfway point, bounding writes to roughly once per 6h of continued
// use per admin, while still never expiring under active use.
const SESSION_REFRESH_THRESHOLD_SECONDS = SESSION_TTL_SECONDS / 2;

// ===================== base64url + PKCE =====================

function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const b of arr) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(digest);
}

// Django's url_has_allowed_host_and_scheme(), the check LoginRequiredAccess
// applies to `next_url` before honouring it: only a same-origin relative
// path is safe to redirect to. Reject an absolute URL and a
// protocol-relative one ("//evil.com", which browsers treat as absolute)
// the same way Django's check would.
function safeNextPath(value: string | undefined | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/admin/";
  return value;
}

// ===================== the __Host-oauth cookie =====================

interface OAuthCookiePayload {
  state: string;
  codeVerifier: string;
  next: string;
}

async function signOAuthCookie(secret: string, payload: OAuthCookiePayload): Promise<string> {
  const json = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmacSha256Hex(secret, json);
  return `${json}.${signature}`;
}

async function verifyOAuthCookie(secret: string, cookieValue: string): Promise<OAuthCookiePayload | null> {
  const dot = cookieValue.indexOf(".");
  if (dot === -1) return null;
  const json = cookieValue.slice(0, dot);
  const signature = cookieValue.slice(dot + 1);
  const expected = await hmacSha256Hex(secret, json);
  if (!timingSafeEqual(signature, expected)) return null;
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(json))) as OAuthCookiePayload;
  } catch {
    return null;
  }
}

function clearOAuthCookie(c: Context<AppEnv>): void {
  c.header("Set-Cookie", `${OAUTH_COOKIE_NAME}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`, { append: true });
}

// ===================== Google JWKS, cached by kid =====================
//
// Module-level, per-isolate -- a fresh isolate just fetches on first use.
// Google rotates signing keys infrequently (on the order of days), so a
// generous cache window is safe; a `kid` this isolate hasn't seen yet
// forces one re-fetch, which is what "cache by kid; keys rotate" (PLAN.md
// §10.2.7) means in practice.

interface GoogleJwk {
  kid: string;
  n: string;
  e: string;
  kty: string;
}

let cachedJwks: Map<string, GoogleJwk> | null = null;
let cachedJwksAt = 0;
const JWKS_CACHE_MS = 6 * 60 * 60 * 1000;

async function getGoogleJwk(kid: string): Promise<GoogleJwk | null> {
  const stale = !cachedJwks || Date.now() - cachedJwksAt > JWKS_CACHE_MS;
  let jwks = cachedJwks;
  if (stale || !jwks || !jwks.has(kid)) {
    const res = await fetch(GOOGLE_JWKS_URI);
    if (!res.ok) throw new Error(`Google JWKS fetch failed: ${res.status}`);
    const data = (await res.json()) as { keys: GoogleJwk[] };
    jwks = new Map(data.keys.map((k) => [k.kid, k]));
    cachedJwks = jwks;
    cachedJwksAt = Date.now();
  }
  return jwks.get(kid) ?? null;
}

// ===================== ID token verification =====================

export interface GoogleIdTokenClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  hd?: string;
  name?: string;
  given_name?: string;
  picture?: string;
  aud: string;
  iss: string;
  exp: number;
}

// Verifies signature (RS256 against Google's own published JWKS), issuer,
// audience, and expiry. Does NOT check email_verified/hd -- that's the
// LoginRequiredAccess-equivalent authorization gate, applied by the caller
// once it has verified claims it can trust.
async function verifyGoogleIdToken(idToken: string, clientId: string): Promise<GoogleIdTokenClaims | null> {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  let payload: GoogleIdTokenClaims;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64)));
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
  } catch {
    return null;
  }

  // Google's own discovery document lists RS256 as the only supported
  // id_token signing algorithm -- reject anything else outright rather
  // than trust the token's own header (the classic "alg: none" /
  // algorithm-confusion JWT footgun starts with trusting this field).
  if (header.alg !== "RS256" || !header.kid) return null;

  const jwk = await getGoogleJwk(header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlDecode(signatureB64), signedData);
  if (!valid) return null;

  if (!GOOGLE_ISSUERS.includes(payload.iss)) return null;
  if (payload.aud !== clientId) return null;
  if (payload.exp * 1000 < Date.now()) return null;

  return payload;
}

// ===================== sessions (KV) =====================

export interface AdminSessionData {
  email: string;
  name: string;
  givenName: string;
  picture: string;
}

interface StoredSession extends AdminSessionData {
  expiresAt: number; // epoch ms -- when this session's KV TTL was last extended to
}

function sessionKvKey(sessionId: string): string {
  return `admin-session:${sessionId}`;
}

async function createSession(env: AppEnv["Bindings"], claims: GoogleIdTokenClaims): Promise<string> {
  const sessionId = randomBase64Url(32);
  const stored: StoredSession = {
    email: claims.email,
    name: claims.name ?? claims.email,
    givenName: claims.given_name ?? claims.email,
    picture: claims.picture ?? "",
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
  };
  await env.SESSIONS.put(sessionKvKey(sessionId), JSON.stringify(stored), { expirationTtl: SESSION_TTL_SECONDS });
  return sessionId;
}

// Known cost, accepted (PLAN.md §10.2.7): KV's ~60s eventual consistency
// means a session created or revoked in one colo can take up to a minute
// to be visible from another -- a logout may not take effect everywhere
// instantly.
export async function getAdminSession(c: Context<AppEnv>): Promise<AdminSessionData | null> {
  const sessionId = parseCookie(c.req.header("Cookie"), SESSION_COOKIE_NAME);
  if (!sessionId) return null;

  const key = sessionKvKey(sessionId);
  const raw = await c.env.SESSIONS.get(key);
  if (!raw) return null;

  let stored: StoredSession;
  try {
    stored = JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }

  const writtenAt = stored.expiresAt - SESSION_TTL_SECONDS * 1000;
  if (Date.now() - writtenAt > SESSION_REFRESH_THRESHOLD_SECONDS * 1000) {
    // More than half the window has elapsed since the last extension --
    // slide it forward. See SESSION_REFRESH_THRESHOLD_SECONDS's own
    // comment for why this isn't done on every read.
    const refreshed: StoredSession = { ...stored, expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000 };
    await c.env.SESSIONS.put(key, JSON.stringify(refreshed), { expirationTtl: SESSION_TTL_SECONDS });
  }

  return { email: stored.email, name: stored.name, givenName: stored.givenName, picture: stored.picture };
}

export async function revokeAdminSession(c: Context<AppEnv>): Promise<void> {
  const sessionId = parseCookie(c.req.header("Cookie"), SESSION_COOKIE_NAME);
  if (sessionId) await c.env.SESSIONS.delete(sessionKvKey(sessionId));
  c.header("Set-Cookie", `${SESSION_COOKIE_NAME}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`, { append: true });
}

function setSessionCookie(c: Context<AppEnv>, sessionId: string): void {
  c.header("Set-Cookie", `${SESSION_COOKIE_NAME}=${sessionId}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}`, {
    append: true,
  });
}

// ===================== the OAuth flow itself =====================

// GET /auth/ -- starts the Authorization Code + PKCE flow. `next` should
// be the path to return to on success (already validated by the caller
// via safeNextPath, or left undefined to land on /admin/).
export async function startGoogleOAuth(c: Context<AppEnv>, next: string | undefined): Promise<Response> {
  const secret = c.env.SESSION_HMAC_KEY;
  if (!secret) return c.text("Auth not configured", 500);

  const state = randomBase64Url(24);
  const codeVerifier = randomBase64Url(32);
  const challenge = await codeChallengeS256(codeVerifier);

  const cookieValue = await signOAuthCookie(secret, { state, codeVerifier, next: safeNextPath(next) });
  c.header("Set-Cookie", `${OAUTH_COOKIE_NAME}=${cookieValue}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${OAUTH_COOKIE_MAX_AGE_SECONDS}`, {
    append: true,
  });

  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: `${oauthOrigin(c)}/auth/receiver/`,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    hd: HOSTED_DOMAIN, // login-hint only -- narrows Google's account chooser to the Workspace; the real authorization check is the hd claim check below, on the token Google actually returns
  });
  return c.redirect(`${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`, 302);
}

// GET /auth/receiver/ -- Google's redirect back, carrying ?code&state.
export async function handleGoogleOAuthCallback(c: Context<AppEnv>): Promise<Response> {
  const secret = c.env.SESSION_HMAC_KEY;
  const clientSecret = c.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!secret || !clientSecret) return c.text("Auth not configured", 500);

  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");

  const oauthCookieValue = parseCookie(c.req.header("Cookie"), OAUTH_COOKIE_NAME);
  clearOAuthCookie(c); // single-use, regardless of outcome below

  if (error || !code || !state || !oauthCookieValue) return c.redirect("/auth/", 302);

  const oauthPayload = await verifyOAuthCookie(secret, oauthCookieValue);
  if (!oauthPayload || !timingSafeEqual(oauthPayload.state, state)) return c.redirect("/auth/", 302);

  const tokenRes = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: clientSecret,
      redirect_uri: `${oauthOrigin(c)}/auth/receiver/`,
      grant_type: "authorization_code",
      code_verifier: oauthPayload.codeVerifier,
    }).toString(),
  });
  if (!tokenRes.ok) {
    console.error("Google token exchange failed", tokenRes.status, await tokenRes.text());
    return c.text("Sign-in failed", 403);
  }
  const tokenJson = (await tokenRes.json()) as { id_token?: string };
  if (!tokenJson.id_token) return c.text("Sign-in failed", 403);

  const claims = await verifyGoogleIdToken(tokenJson.id_token, c.env.GOOGLE_OAUTH_CLIENT_ID);
  if (!claims) return c.text("Sign-in failed", 403);

  // givefood/middleware.py:68's LoginRequiredAccess gate, verbatim.
  if (!claims.email_verified || claims.hd !== HOSTED_DOMAIN) return c.text("Forbidden", 403);

  const sessionId = await createSession(c.env, claims);
  setSessionCookie(c, sessionId);

  return c.redirect(oauthPayload.next, 302);
}

// GET /auth/sign-out/
export async function handleSignOut(c: Context<AppEnv>): Promise<Response> {
  await revokeAdminSession(c);
  return c.redirect("/auth/", 302);
}

export { safeNextPath };
