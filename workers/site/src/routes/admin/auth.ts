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
// (a "Sign in with Google" button when signed out, a profile/sign-out view
// when already signed in). This used to 302 straight to Google whenever
// `?next=` was present -- which requireAdminAuth's own gate redirect sets
// on EVERY unauthenticated visit to any /admin/* URL -- with no page and
// no click in between. Found 2026-09-03 as the cause of a real bug: Google
// itself doesn't get signed out when /auth/sign-out/ clears our session
// (it can't -- that's a different site), so the very next /admin/* visit
// silently and instantly re-authenticated through Google's own still-active
// session, making Sign Out visibly do nothing. Django's real gate
// (middleware.py's LoginRequiredAccess) never has this problem: it always
// redirects to the bare sign-in page, which needs an explicit click before
// anything talks to Google. This route now matches that -- `next` is
// carried into the rendered page's own link (adminAuthStart below), not
// auto-redirected on.
export async function adminSignIn(c: Context<AppEnv>): Promise<Response> {
  const next = safeNextPath(c.req.query("next"));

  const session = await getAdminSession(c);
  const html = await render("admin/sign_in.njk", {
    ...buildPageContext({ path: c.req.path, appName: "gfadmin" }),
    admin_user: session,
    next,
  });
  return c.html(html);
}

// GET /auth/start/ -- the actual "Sign in with Google" click target,
// split out of adminSignIn above so a bare /admin/* redirect through
// /auth/?next=... can no longer reach Google without a real click landing
// here first.
export async function adminAuthStart(c: Context<AppEnv>): Promise<Response> {
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
