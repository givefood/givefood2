import type { Context } from "hono";
import { buildPageContext } from "@givefood/templates";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { handleGoogleOAuthCallback, handleSignOut, safeNextPath, startGoogleOAuth, getAdminSession } from "../../lib/adminAuth";

// gfauth (WP 6.1/6.2). Kept at its exact URLs (/auth/, /auth/receiver/,
// /auth/sign-out/ -- receiver in particular is a registered Google
// redirect URI, unchangeable) but implemented here under routes/admin/,
// not as a standalone top-level feature: auth exists solely to gate the
// admin, per the maintainer's own scoping note. See lib/adminAuth.ts for
// the actual OAuth/session mechanics and why this flow is a deliberate
// redesign of gfauth/views.py, not a port of it.

// GET /auth/ -- gfauth/templates/auth/sign_in.html is a real branded page
// (a "Sign in with Google" button when signed out, a profile/sign-out
// view when already signed in); this route used to always 302 straight to
// Google with no page at all -- including when a session already existed,
// pointlessly round-tripping through OAuth again. `?next=` (only ever set
// by requireAdminAuth's own redirect when gating an unauthenticated
// request) still goes straight to Google unconditionally -- that flow is
// already tested and this change is about the page existing for a direct
// /auth/ visit, not about altering the gate's redirect-through UX.
export async function adminSignIn(c: Context<AppEnv>): Promise<Response> {
  const next = c.req.query("next");
  if (next) return startGoogleOAuth(c, safeNextPath(next));

  const session = await getAdminSession(c);
  const html = await render("admin/sign_in.njk", {
    ...buildPageContext({ path: c.req.path, appName: "gfadmin" }),
    admin_user: session,
  });
  return c.html(html);
}

// GET /auth/receiver/
export async function adminAuthReceiver(c: Context<AppEnv>): Promise<Response> {
  return handleGoogleOAuthCallback(c);
}

// GET /auth/sign-out/
export async function adminSignOut(c: Context<AppEnv>): Promise<Response> {
  return handleSignOut(c);
}
