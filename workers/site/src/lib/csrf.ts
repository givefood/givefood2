import type { Context } from "hono";
import type { AppEnv } from "../types";
import { hmacSha256Hex, timingSafeEqual } from "./hmac";
import { parseCookie } from "./cookies";

// New for gfwrite (WP 4.6, PLAN.md §6.9 R3): Django's CsrfViewMiddleware is
// commented out in production (settings.py:97), so the `{% csrf_token %}`
// tags on the write forms are decorative today -- nothing validates them.
// PLAN.md's explicit recommendation: "Signed double-submit token in a
// __Host- cookie, SameSite=Lax, validated on every mutating request, plus
// an Origin/Sec-Fetch-Site check."
//
// The server mints the raw token and embeds it directly in the rendered
// HTML (a hidden form field) -- unlike a classic double-submit cookie
// (where client JS reads the cookie to populate the field), this lets the
// cookie stay HttpOnly, so an XSS on this page can't read it back out.
// The signature (HMAC-SHA256 over the raw token) is what makes it "signed"
// rather than a plain double-submit: even if an attacker tosses an
// arbitrary cookie via a sibling subdomain, they can't produce one that
// verifies without CSRF_SECRET, and they still can't set the matching
// hidden form field on the real page.
const COOKIE_NAME = "__Host-csrf";
const RAW_TOKEN_BYTES = 32;

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Mints a fresh raw token + its HMAC, and sets the signed value as a
// `__Host-csrf` cookie on the response. Returns the RAW token for the
// caller to embed as a hidden `csrf_token` form field. A missing
// CSRF_SECRET fails closed (empty token, no cookie set) -- same convention
// as lib/turnstile.ts's validateTurnstile(): an unset secret must never be
// silently indistinguishable from "working", or every submission fails
// with no signal pointing at the actual cause.
export async function issueCsrfToken(c: Context<AppEnv>, secret: string | undefined): Promise<string> {
  if (!secret) {
    console.log("CSRF_SECRET not set -- issuing no token (every mutating submission will be rejected)");
    return "";
  }

  // REUSE a still-valid cookie rather than minting on every render. Minting
  // unconditionally was a real bug, not just churn: the cookie name and path
  // are constant, so each render REPLACED the previous cookie, and
  // verifyCsrf() below requires the submitted field to equal the cookie's raw
  // token exactly. That meant only the most recently rendered admin page
  // could ever submit -- open a food bank in a second tab, go back to the
  // first, press Save, get a 403. Every admin page calls this (via
  // adminPageContext), so any two-tab workflow broke, as did submitting a
  // form left open while an htmx tab-load refreshed the cookie underneath it.
  //
  // Reusing costs nothing in strength: the signature still proves the server
  // minted the token, and the double-submit still binds the form to the
  // cookie. It is also what Django's own CsrfViewMiddleware does -- one
  // stable token per session, rotated on login, not per response.
  // MARK THE RESPONSE AS PER-VISITOR BEFORE ANY RETURN PATH. The raw token
  // ends up rendered into the page as a hidden field, so a response that
  // reaches this function must never be stored in a shared cache.
  //
  // This flag exists because Set-Cookie was NOT a sufficient signal for
  // that. middleware/pageCacheControl.ts originally keyed its per-visitor
  // guard on Set-Cookie, on the strength of PLAN.md:10836's description of
  // this function as minting "a fresh raw token plus a new signed cookie on
  // *every* call". The reuse path below made that untrue on 2026-09-02 and
  // the middleware was written against the stale invariant on 2026-09-06:
  // a returning visitor takes the early return at the end of this block,
  // sends no Set-Cookie, and their page -- token and all -- was stamped
  // `public, s-maxage=86400` and served to everyone else, whose POSTs then
  // failed CSRF validation and discarded everything they had typed.
  // Reproduced on production before the fix.
  //
  // Set here rather than at the mint site so that it cannot be missed by a
  // future third return path, and so the guard is CAUSAL ("this response
  // contains a token") rather than incidental ("this response happens to
  // set a cookie").
  c.set("csrfIssued", true);

  const existing = parseCookie(c.req.header("Cookie"), COOKIE_NAME);
  if (existing) {
    const dot = existing.indexOf(".");
    if (dot !== -1) {
      const existingRaw = existing.slice(0, dot);
      const expected = await hmacSha256Hex(secret, existingRaw);
      // Signature must verify -- an attacker-planted cookie from a sibling
      // subdomain must not be adopted and echoed back into the page as a
      // valid-looking field.
      if (timingSafeEqual(existing.slice(dot + 1), expected)) return existingRaw;
    }
  }

  const raw = randomHex(RAW_TOKEN_BYTES);
  const signature = await hmacSha256Hex(secret, raw);
  // __Host- requires Secure + Path=/ + no Domain attribute (browser-enforced).
  c.header("Set-Cookie", `${COOKIE_NAME}=${raw}.${signature}; Secure; HttpOnly; SameSite=Lax; Path=/`, { append: true });
  return raw;
}

// Validates a mutating request: the cookie's signature must verify (proves
// the server minted it), the cookie's raw token must match the submitted
// form field (double-submit), and Origin/Sec-Fetch-Site (when present --
// older browsers omit both) must agree this is a same-origin request.
export async function verifyCsrf(c: Context<AppEnv>, secret: string | undefined, formToken: string | undefined): Promise<boolean> {
  if (!secret) {
    console.log("CSRF_SECRET not set -- failing validation closed");
    return false;
  }
  if (!formToken) return false;

  const cookieValue = parseCookie(c.req.header("Cookie"), COOKIE_NAME);
  if (!cookieValue) return false;
  const dot = cookieValue.indexOf(".");
  if (dot === -1) return false;
  const cookieRaw = cookieValue.slice(0, dot);
  const cookieSignature = cookieValue.slice(dot + 1);

  const expectedSignature = await hmacSha256Hex(secret, cookieRaw);
  if (!timingSafeEqual(cookieSignature, expectedSignature)) return false;
  if (!timingSafeEqual(cookieRaw, formToken)) return false;

  const secFetchSite = c.req.header("Sec-Fetch-Site");
  if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") return false;

  const origin = c.req.header("Origin");
  if (origin) {
    const requestOrigin = new URL(c.req.url).origin;
    if (origin !== requestOrigin) return false;
  }

  return true;
}
