import type { Context, Hono } from "hono";
import type { AppEnv } from "../types";

// Shared by index.ts's app.notFound() and notPortedYet() -- both need to
// answer "does the slashed URL actually resolve?" before falling back to a
// placeholder/not-found response. Reproduces Django's APPEND_SLASH (a 301,
// not serving content in place; see PLAN.md §6.1.5). Restricted to GET/HEAD
// to avoid re-running a mutating request -- a deliberate deviation from
// Django, which redirects POST/PUT/PATCH/DELETE too and loses the body.
//
// Originally lived only in app.notFound(), which never ran for a path
// under a notPortedYet() mount: notPortedYet()'s own `app.all("*", ...)`
// is a matched route as far as Hono's router is concerned, so it answered
// with its placeholder 501 before Hono's router ever reached the "nothing
// matched" state app.notFound() depends on. That shadowed the redirect for
// every already-ported route requested without its trailing slash, across
// the whole site (givefood/givefood2#3).
export async function tryAppendSlashRedirect(c: Context<AppEnv>, app: Hono<AppEnv>): Promise<Response | null> {
  const url = new URL(c.req.url);
  const method = c.req.method;
  if ((method !== "GET" && method !== "HEAD") || url.pathname.endsWith("/")) return null;

  const slashed = new URL(url.toString());
  slashed.pathname += "/";
  const probe = await app.fetch(new Request(slashed, { method: "HEAD" }), c.env, c.executionCtx);
  if (probe.status !== 404 && probe.status !== 501) {
    return c.redirect(slashed.toString(), 301); // Django's APPEND_SLASH is a 301
  }
  return null;
}
