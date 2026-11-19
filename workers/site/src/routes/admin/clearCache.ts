import type { Context } from "hono";
import { FRAG_KV_KEY_LAST_UPDATED, FRAG_KV_KEY_NEED_HITS } from "@givefood/db";
import type { AppEnv } from "../../types";
import { verifyCsrf } from "../../lib/csrf";
import { timedKv } from "../../lib/timings";

// gfadmin/views.py:3116-3122 clearcache(), registered gfadmin/urls/core.py:17
// -- the DANGER ZONE "Clear Cache" button
// (gfadmin/templates/admin/settings.html:59).
//
// Django's whole view is:
//     caches["default"].clear()
//     caches["data"].clear()
//     return redirect("admin:index")
// Two LocMemCache dicts (givefood/settings.py:169-185), and it NEVER contacts
// Cloudflare -- unlike decache() (givefood/utils/cache.py:156-197), which POSTs
// to the zone's purge_cache endpoint. So the button labelled "clear everything"
// today clears two in-process dictionaries on whichever single gunicorn worker
// served the request (cache.py:191-195 concedes the other workers keep theirs)
// and leaves the CDN -- where essentially all the cached HTML actually lives --
// untouched. FIXED RATHER THAN PORTED: this purges the real cache. That is a
// deliberate behaviour change, and the correct one; PLAN.md's own runbooks
// already use exactly this call for exactly this operation (PLAN.md:11436
// "Purge everything", and again in the rollback script at PLAN.md:11567).
//
// WHAT IT PURGES: this Worker's own Workers Cache, through
// c.executionCtx.cache.purge({ purgeEverything: true }). It used to POST
// purge_everything to the zone's purge_cache API, which Cloudflare documents
// as having NO effect on Workers Caching ("no zone-level purge -- via the
// dashboard, API, or Terraform -- affects Workers Caching content"; see
// developers.cloudflare.com/workers/cache/purge/). wrangler.jsonc turns
// Workers Caching on, so every HTML page, API response and map this site
// serves lives in that cache, and the button was purging a cache nothing was
// in. ctx.cache.purge() is scoped to the Worker and to the entrypoint that
// calls it; this handler runs in the default entrypoint, which is the one
// every eyeball request is cached under.
//
// purgeEverything, not Cache-Tag: this button is semantically "clear
// everything" -- the Django view's own comment (views.py:3118-3119) contrasts
// it with decache() for precisely that reason. The per-food-bank tag purge is
// queues/cachePurge.ts.
//
// NOT routed through PURGE_Q on purpose: a manual button's entire value is a
// synchronous yes/no answer, and the result object says whether Cloudflare
// accepted the purge.
//
// POST + CSRF, not Django's <a href> GET -- PLAN.md:10049 lists this as one of
// the GET-mutation holes the port closes ("clears both caches on GET" ->
// "POST + CSRF"). No GET route is registered; a GET to /admin/clearcache/ 404s
// through the normal fallthrough, and that is the fix.

const COOLDOWN_KV_KEY = "clearcache:last";
const COOLDOWN_MS = 60_000;

type Outcome = "purged" | "purged-kv-only" | "cooldown" | "failed";

async function purgeEverything(cache: CacheContext): Promise<boolean> {
  try {
    const result = await cache.purge({ purgeEverything: true });
    // A rate-limited purge resolves with success:false rather than throwing.
    // Strict equality so a truthy non-boolean is not read as success.
    if (result?.success === true) return true;
    console.error("clearcache: Workers Cache purge failed", result?.errors);
    return false;
  } catch (err) {
    console.error("clearcache: Workers Cache purge threw", err);
    return false;
  }
}

export async function adminClearCache(c: Context<AppEnv>): Promise<Response> {
  const body = await c.req.parseBody();
  const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
  if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

  // Cloudflare rate-limits purge requests, and purge_everything is the most
  // expensive thing an admin can do to the cache with one click. A 60s cooldown
  // stops an impatient double-click costing a second full cold-cache rebuild.
  // KV is eventually consistent, so this is a courtesy guard, not a lock -- and
  // for a human-driven button that is enough. A KV failure must not turn the
  // button into a 500, so a failed read just means "no cooldown known".
  let last: string | null = null;
  try {
    last = await timedKv(c, c.env.DATA).get(COOLDOWN_KV_KEY);
  } catch (err) {
    console.error("clearcache: KV read of the cooldown marker failed, proceeding", err);
  }

  let outcome: Outcome;
  if (last && Date.now() - Number(last) < COOLDOWN_MS) {
    outcome = "cooldown";
  } else {
    // The port's equivalent of Django's caches["data"]: the two frag values.
    // Safe to delete because routes/public/frag.ts's readOrCompute() recomputes
    // and rewrites either one on a miss, so the worst case is one live query.
    //
    // The "slug_redirects" KV blob this used to warn about is GONE
    // (2026-09-05): middleware/slugRedirect.ts reads the slugredirect
    // table directly now, so there is no projection to keep in step, and
    // nothing here to avoid deleting. The KV key itself was deleted with
    // `wrangler kv key delete` at the same time.
    //
    // ALSO NOT CLEARABLE, and honest about it: slugRedirect.ts:21 memoises that
    // map in module scope for 300s. No request can clear another isolate's copy
    // -- precisely the defect cache.py:191-195 concedes for LocMemCache across
    // gunicorn workers. A redeploy is the only global reset. The UI does not
    // claim otherwise.
    //
    // allSettled: one failed KV delete must not abort the Cloudflare purge,
    // which is the part that matters.
    const kv = timedKv(c, c.env.DATA);
    await Promise.allSettled([kv.delete(FRAG_KV_KEY_LAST_UPDATED), kv.delete(FRAG_KV_KEY_NEED_HITS)]);

    // ctx.cache only exists where Workers Caching does: not under every
    // local runner, and not if "cache" is ever switched off in wrangler.jsonc.
    // Degrade to a KV-only clear with an explicit warning banner rather than
    // 500ing.
    // Hono types executionCtx with its own minimal interface; the runtime
    // object is the Workers ExecutionContext, which carries `cache`.
    const cache = (c.executionCtx as unknown as ExecutionContext).cache;
    if (!cache) {
      console.log("clearcache: no Workers Cache on this invocation -- KV cleared, cache not purged");
      outcome = "purged-kv-only";
    } else {
      outcome = (await purgeEverything(cache)) ? "purged" : "failed";
    }

    // Only a real purge starts the cooldown: a failed one has to be retryable
    // immediately, and a KV-only clear never touched the rate-limited API.
    if (outcome === "purged") {
      try {
        await timedKv(c, c.env.DATA).put(COOLDOWN_KV_KEY, String(Date.now()));
      } catch (err) {
        console.error("clearcache: KV write of the cooldown marker failed", err);
      }
    }
  }

  // Django redirects to admin:index (views.py:3122). Redirecting to
  // /admin/settings/ instead, because that is where the button lives and the
  // result of a purge has to land somewhere the admin is already looking. The
  // ?cache= value is a fixed four-value enum, narrowed again by the allowlist in
  // settings.ts before it reaches the template.
  return c.redirect(`/admin/settings/?cache=${outcome}`, 302);
}
