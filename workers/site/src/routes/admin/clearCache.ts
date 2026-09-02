import type { Context } from "hono";
import { FRAG_KV_KEY_LAST_UPDATED, FRAG_KV_KEY_NEED_HITS } from "@givefood/db";
import type { AppEnv } from "../../types";
import { verifyCsrf } from "../../lib/csrf";

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
// purge_everything, not Cache-Tag: PLAN.md §3.6's tag design is for the
// AUTOMATIC per-foodbank path, and nothing in workers/site emits a Cache-Tag
// header yet except routes/media.ts, so there is no tag set to enumerate. This
// button is semantically "clear everything" -- the Django view's own comment
// (views.py:3118-3119) contrasts it with decache() for precisely that reason.
//
// NOT routed through PURGE_Q on purpose: workers/jobs/src/index.ts's cache-purge
// consumer is still a message.retry() stub, so enqueueing would show the admin a
// green banner for a purge that never happened. A manual button's entire value is
// a synchronous yes/no answer. Do not "improve" this into a queue send until that
// consumer exists.
//
// WHAT IT PURGES TODAY: the zone route is commented out in wrangler.jsonc, so
// this Worker serves from *.workers.dev and has no zone cache of its own.
// Purging the givefood.org.uk zone therefore purges the cache in front of the
// LIVE DJANGO APP -- during the strangler period exactly right, and the same
// zone Django's decache() targets. Post-cutover the same call purges this
// Worker's responses instead, including anything written via caches.default.put
// (routes/wfbn/favicon.ts). One behaviour, correct on both sides of the flip.
//
// POST + CSRF, not Django's <a href> GET -- PLAN.md:10049 lists this as one of
// the GET-mutation holes the port closes ("clears both caches on GET" ->
// "POST + CSRF"). No GET route is registered; a GET to /admin/clearcache/ 404s
// through the normal fallthrough, and that is the fix.

const COOLDOWN_KV_KEY = "clearcache:last";
const COOLDOWN_MS = 60_000;

type Outcome = "purged" | "purged-kv-only" | "cooldown" | "failed";

// givefood/utils/cache.py:166's endpoint and Bearer-token shape, with
// {"purge_everything": true} as the body instead of files/prefixes.
async function purgeEverything(zoneId: string, apiKey: string): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ purge_everything: true }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    console.error("clearcache: Cloudflare purge_cache could not be reached", err);
    return false;
  }

  // The v4 API answers 200 with {"success": false, "errors": [...]} for a token
  // that lacks Zone.Cache Purge, so res.ok on its own would report a lie. Both
  // are checked. (Django checks neither -- cache.py:172/196 throws the
  // requests.post response away entirely.)
  let payload: { success?: boolean; errors?: unknown } | null = null;
  try {
    payload = (await res.json()) as { success?: boolean; errors?: unknown };
  } catch {
    payload = null;
  }
  if (!res.ok || payload?.success !== true) {
    console.error(`clearcache: Cloudflare purge_cache failed (HTTP ${res.status})`, payload?.errors);
    return false;
  }
  return true;
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
    last = await c.env.DATA.get(COOLDOWN_KV_KEY);
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
    // DELIBERATELY NOT CLEARED: DATA's "slug_redirects" blob
    // (middleware/slugRedirect.ts:18). It is a KV-hosted PROJECTION, not a
    // cache: the middleware falls back to {} on a miss (slugRedirect.ts:27-28),
    // it is rebuilt only by lib/slugRedirectKv.ts on an admin write, and no
    // request path reads the slugredirect table (migrations/0016_slugredirect.sql)
    // directly. Deleting it would silently kill every live 301 until the next
    // slug-redirect edit. Django's own getter re-reads the table on a miss
    // (givefood/utils/cache.py:25-29), so clearing it there is harmless; here it
    // is not. If this button should ever also REFRESH that blob, the call is
    // rebuildSlugRedirectKv() from lib/slugRedirectKv.ts -- a rebuild, never a
    // bare delete.
    //
    // ALSO NOT CLEARABLE, and honest about it: slugRedirect.ts:21 memoises that
    // map in module scope for 300s. No request can clear another isolate's copy
    // -- precisely the defect cache.py:191-195 concedes for LocMemCache across
    // gunicorn workers. A redeploy is the only global reset. The UI does not
    // claim otherwise.
    //
    // allSettled: one failed KV delete must not abort the Cloudflare purge,
    // which is the part that matters.
    await Promise.allSettled([c.env.DATA.delete(FRAG_KV_KEY_LAST_UPDATED), c.env.DATA.delete(FRAG_KV_KEY_NEED_HITS)]);

    // CF_API_KEY / CF_ZONE_ID are declared in the Env interface but are not yet
    // set on this Worker (they are live production credentials -- wrangler.jsonc
    // forbids self-serving them out of the Django database). Degrade to a
    // KV-only clear with an explicit warning banner rather than 500ing, so the
    // endpoint can ship and be reviewed before the secrets exist. Do not tidy
    // this branch away.
    if (!c.env.CF_API_KEY || !c.env.CF_ZONE_ID) {
      console.log("clearcache: CF_API_KEY/CF_ZONE_ID unset -- KV cleared, CDN not purged");
      outcome = "purged-kv-only";
    } else {
      outcome = (await purgeEverything(c.env.CF_ZONE_ID, c.env.CF_API_KEY)) ? "purged" : "failed";
    }

    // Only a real purge starts the cooldown: a failed one has to be retryable
    // immediately, and a KV-only clear never touched the rate-limited API.
    if (outcome === "purged") {
      try {
        await c.env.DATA.put(COOLDOWN_KV_KEY, String(Date.now()));
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
