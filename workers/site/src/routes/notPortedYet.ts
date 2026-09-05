import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../types";

// A single path PLAN.md specifies that this build pass has not implemented
// yet. 501 rather than 404 so a real gap stays unmistakably "not built"
// rather than looking like a missing page.
//
// EXACT PATHS ONLY, deliberately. This used to be a `notPortedYet()` that
// mounted `app.all("*")` over a whole prefix -- including `/`, the entire
// site -- which meant every URL that matched nothing real answered 501,
// including URLs that simply do not exist in Django either. That is the
// wrong answer on a live domain: crawlers read 501 as "the server is
// broken, come back later" and keep retrying, where 404 tells them the
// page is gone and to stop. It also outlived its usefulness -- when those
// mounts were written most of the public site was unbuilt; by 2026-09-05
// the only genuine gaps were the ten paths listed at index.ts's own
// NOT_PORTED block, and the catch-alls were mostly just mislabelling
// 404s.
//
// Registering exact paths also removes the reason the old helper needed a
// reference to the root app: an `app.all("*")` mount shadowed real routes
// requested without their trailing slash, so it had to probe the root app
// for a slashed variant before answering (givefood/givefood2#3). Nothing
// shadows anything now, so unmatched requests reach index.ts's
// `app.notFound()`, which already does the append-slash probe and then
// renders the real 404 page.
export function notPortedPath(what: string) {
  return (c: Context<AppEnv>) => c.text(`givefood: ${what} is not ported yet (see PLAN.md)`, 501);
}

// Same 501 signal for a route group that needs its whole subtree covered
// rather than a path at a time. Nothing uses this today -- kept because
// the next unported feature that arrives as a subtree will want it, and
// it is three lines. Prefer notPortedPath() where the paths are known:
// a subtree mount cannot tell "unbuilt" from "does not exist" either.
export function notPortedSubtree(what: string) {
  const app = new Hono<AppEnv>();
  app.all("*", notPortedPath(what));
  return app;
}

// For a route group PLAN.md once specified but a later maintainer decision
// dropped entirely -- a real 404 rather than the 501 "still coming"
// signal, since nothing is coming. Call sites should say why (a
// maintainer-decision comment), same as every other permanently
// out-of-scope route in this codebase.
export function gone() {
  const app = new Hono<AppEnv>();
  app.all("*", (c) => c.notFound());
  return app;
}
