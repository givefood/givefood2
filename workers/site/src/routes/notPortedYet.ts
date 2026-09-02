import { Hono } from "hono";
import type { AppEnv } from "../types";
import { tryAppendSlashRedirect } from "../lib/appendSlash";

// Placeholder for a route group PLAN.md specifies but this build pass has
// not implemented yet. Returns 501 rather than 404 so it is unmistakably
// "not built" during development, never a silent gap that looks like a
// missing page. Replace with the real router as each phase lands -- see
// PLAN.md §10 (the delivery plan) for the phase each of these belongs to.
//
// `rootApp` is the top-level Hono app (index.ts's `app`) -- needed to probe
// whether a slashed variant of the request would resolve to a REAL route
// registered elsewhere in the app before answering with this placeholder.
// Without that check, this mount's own `app.all("*", ...)` -- a matched
// route as far as Hono's router is concerned -- shadows every already-built
// route under this prefix that gets requested without its trailing slash,
// since Hono's router never reaches the "nothing matched" state
// app.notFound()'s own redirect logic depends on (givefood/givefood2#3).
export function notPortedYet(name: string, rootApp: Hono<AppEnv>) {
  const app = new Hono<AppEnv>();
  app.all("*", async (c) => {
    const redirect = await tryAppendSlashRedirect(c, rootApp);
    if (redirect) return redirect;
    return c.text(`givefood: ${name} is not ported yet (see PLAN.md)`, 501);
  });
  return app;
}

// Same shape as notPortedYet() above, for a route group PLAN.md once
// specified but a later maintainer decision dropped entirely -- a real
// 404 rather than the 501 "still coming" signal, since nothing is coming.
// Call sites should say why (a maintainer-decision comment), same as
// every other permanently-out-of-scope route in this codebase.
export function gone() {
  const app = new Hono<AppEnv>();
  app.all("*", (c) => c.notFound());
  return app;
}
