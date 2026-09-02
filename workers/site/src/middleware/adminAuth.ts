import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";
import { getAdminSession } from "../lib/adminAuth";

// givefood/middleware.py's LoginRequiredAccess, WP 6.1/6.2. Applied to
// every /admin/* route except the /auth/* ones themselves (auth.ts) --
// same shape as Django's `login_apps = ["gfadmin"]` check, just expressed
// as a Hono sub-app middleware instead of a global app-name check.
//
// On success, the resolved session is set on the context (`adminUser`) so
// every downstream handler can read it without a second KV lookup.
export const requireAdminAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = await getAdminSession(c);
  if (!session) {
    // Django stashes `next_url` in the Django session before redirecting;
    // there's no session yet at this point here, so it travels as a query
    // param instead, into the signed __Host-oauth cookie the sign-in step
    // sets up (see lib/adminAuth.ts's startGoogleOAuth). Named nextPath,
    // not `next`, so it can't be confused with (or accidentally shadow)
    // this middleware's own `next` continuation below.
    const nextPath = encodeURIComponent(c.req.path);
    return c.redirect(`/auth/?next=${nextPath}`, 302);
  }
  c.set("adminUser", session);
  await next();
};
