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
    //
    // Path AND query, matching what middleware.py actually stores:
    // request.get_full_path(), which appends "?" + the raw QUERY_STRING when
    // there is one. Nineteen admin routes read query params -- ?page=, ?sort=,
    // ?q=, and the prefilled /admin/need/new/?foodbank=<slug> -- and capturing
    // the path alone bounced the admin back to a defaulted version of the page
    // they asked for.
    //
    // `c.req.path` and NOT `new URL(c.req.url).pathname`: Hono decodeURI()s the
    // path once it contains a "%", so c.req.path is the decoded form, which is
    // what every existing pinned case expects (caff%C3%A8 arrives at /auth/ as
    // caffè). `.search` is the opposite -- URL leaves the query percent-encoded
    // exactly as it arrived -- and that is right too, because Django's
    // iri_to_uri(QUERY_STRING) likewise passes an already-escaped query through
    // untouched. encodeURIComponent then escapes those "%"s a second time, so
    // the single decode at /auth/ hands back the original query byte for byte.
    // Parity stops at the path, then: get_full_path() re-escapes it and this
    // does not. That predates this line and is deliberately kept -- see the
    // "still decodes the path" test for what Django gives for the same URL.
    const nextPath = encodeURIComponent(c.req.path + new URL(c.req.url).search);
    return c.redirect(`/auth/?next=${nextPath}`, 302);
  }
  c.set("adminUser", session);
  await next();
};
