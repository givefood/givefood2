import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";

// SECURITY. Marks a response uncacheable. Applied to every /admin/* and /auth/*
// response, and to the handful of PUBLIC routes that are equally unsafe to cache
// (see index.ts) -- anything that mutates on a GET, or renders one visitor's own
// data back to them.
//
// Without this, Cloudflare cached authenticated admin pages at the edge and
// served them to anonymous visitors -- found on beta 2026-09-02, where
// /admin/, /admin/foodbank/<slug>/ and its tab fragments all returned 200 with
// no cookie and `cf-cache-status: HIT`. The subscribers tab leaks subscriber
// identifiers, so this was a real data exposure, not just a wrong page.
//
// It is worse than an ordinary cache bug because wrangler.jsonc sets
// `"cache": { "enabled": true }`, and a cache HIT is served WITHOUT EXECUTING
// THE WORKER AT ALL (that is the documented point of it -- a hit costs 0
// CPU-ms). So requireAdminAuth never ran: no amount of correctness in the auth
// middleware could have stopped it, because the request never reached the
// middleware. The only fix is to keep these responses out of the cache.
//
// Applied to responses, not requests -- the header has to be on the way out,
// including on the 302 that requireAdminAuth itself returns (a cached redirect
// would be its own, milder bug).
//
// The same reasoning covers two PUBLIC routes, which are not an access-control
// problem but are the same root cause. GET /needs/at/<slug>/updates/confirm/
// and .../unsubscribe/ MUTATE (confirm a subscriber, delete a subscriber) and
// send mail; a cache HIT would return the success page WITHOUT running the
// Worker, so someone clicking Unsubscribe would be told it worked while the
// row survived. And /write/to/<slug>/email/done/?email=... renders the
// visitor's own address back to them, which should not sit in a shared cache.
//
// `private` bars shared caches; `no-store` bars storing it anywhere at all;
// `max-age=0` and `must-revalidate` cover intermediaries that honour only the
// older directives. `Vary: Cookie` is belt-and-braces: it is NOT sufficient on
// its own (Cloudflare does not vary on Cookie by default, which is exactly how
// this happened), but it is correct and costs nothing.
export const noStore: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store, max-age=0, must-revalidate");
  c.header("Vary", "Cookie", { append: true });
  // Cloudflare's own edge honours this on the response path and skips caching.
  c.header("CDN-Cache-Control", "no-store");
};
