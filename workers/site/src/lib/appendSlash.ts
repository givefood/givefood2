import type { Context, Hono } from "hono";
import type { AppEnv } from "../types";

// "Does the slashed URL actually resolve?", asked by index.ts's
// app.notFound() before it falls back to the 404 page. Reproduces Django's
// APPEND_SLASH (a 301, not serving content in place; see PLAN.md §6.1.5).
// Restricted to GET/HEAD to avoid re-running a mutating request -- a
// deliberate deviation from Django, which redirects POST/PUT/PATCH/DELETE
// too and loses the body.
//
// app.notFound() is now the ONLY caller. It briefly was not: the
// notPortedYet() sub-apps needed their own copy, because their
// `app.all("*", ...)` is a matched route as far as Hono's router is
// concerned, so they answered with a placeholder 501 before the router
// ever reached the "nothing matched" state app.notFound() depends on --
// which shadowed this redirect for every already-ported route on the site
// requested without its trailing slash (givefood/givefood2#3). Those
// catch-all mounts are gone (see notPortedYet.ts), so nothing shadows
// app.notFound() any more and the check lives in one place again.
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
