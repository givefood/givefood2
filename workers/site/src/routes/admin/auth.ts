import type { Context } from "hono";
import type { AppEnv } from "../../types";
import { handleGoogleOAuthCallback, handleSignOut, safeNextPath, startGoogleOAuth } from "../../lib/adminAuth";

// gfauth (WP 6.1/6.2). Kept at its exact URLs (/auth/, /auth/receiver/,
// /auth/sign-out/ -- receiver in particular is a registered Google
// redirect URI, unchangeable) but implemented here under routes/admin/,
// not as a standalone top-level feature: auth exists solely to gate the
// admin, per the maintainer's own scoping note. See lib/adminAuth.ts for
// the actual OAuth/session mechanics and why this flow is a deliberate
// redesign of gfauth/views.py, not a port of it.

// GET /auth/ -- starts sign-in. ?next= is the path to return to.
export async function adminSignIn(c: Context<AppEnv>): Promise<Response> {
  return startGoogleOAuth(c, safeNextPath(c.req.query("next")));
}

// GET /auth/receiver/
export async function adminAuthReceiver(c: Context<AppEnv>): Promise<Response> {
  return handleGoogleOAuthCallback(c);
}

// GET /auth/sign-out/
export async function adminSignOut(c: Context<AppEnv>): Promise<Response> {
  return handleSignOut(c);
}
