import type { Session } from "@givefood/db";
import { getSlugRedirectMap } from "@givefood/db";
import type { Env } from "../../worker-configuration";

// The write-side counterpart of middleware/slugRedirect.ts. D1 is the
// editable source of truth for slug redirects (PLAN.md:3010); the
// middleware's hot path reads a single JSON blob out of DATA KV instead,
// because it runs on EVERY request to the site and cannot afford a D1
// round trip. This module is what keeps the blob in step with the table.
//
// THIS IS A FIX FOR A REAL DJANGO DEFECT, NOT A PORT OF ONE.
// givefood/utils/cache.py:12-32 get_slug_redirects() caches the old->new
// dict for 3600s under the key `slug_redirects_dict`, and NOTHING
// invalidates it on save -- that string appears in exactly two files in
// the whole Django tree (cache.py:16 and tests/test_slug_redirect.py:94),
// neither of which deletes it. So in production today a redirect added in
// the admin does not take effect for up to an hour unless somebody
// remembers to hit /admin/clearcache/ (gfadmin/views.py:3116-3122). Here
// the KV write happens synchronously inside the POST that saved the row.

// Must match middleware/slugRedirect.ts's own `KV_KEY` (line 18). Declared
// here rather than imported because that constant is private to the
// middleware today -- see this work package's wiring notes: exporting it
// there and importing it here is a one-line improvement that removes the
// chance of the two drifting.
const SLUG_REDIRECT_KV_KEY = "slug_redirects";

// Rebuilds the blob FROM D1, in full. Deliberately a rebuild and not an
// incremental patch: an edit can change `old_slug` itself, which has to
// REMOVE the previous key -- patching the blob in place would leave the
// retired key 301ing forever. At 57 rows the whole map is ~2 kB, so a full
// rebuild is the cheap option as well as the correct one.
//
// PROPAGATION IS ~5 MINUTES, NOT INSTANT, and the three delays compose:
//   1. KV write -> read global convergence: usually seconds, up to ~60s.
//   2. env.DATA.get()'s default per-colo cacheTtl: 60s.
//   3. middleware/slugRedirect.ts's module-scope memo: MEMO_TTL_MS =
//      300_000 (5 min) per warm isolate.
// Worst case ~5-6 minutes. Do NOT shorten MEMO_TTL_MS to paper over this:
// it sits on the hot path of every single request to the site, and the
// Django behaviour being replaced is up to 60 minutes with no
// invalidation at all. The admin list page says so on the page, so nobody
// has to guess whether a save "worked".
export async function syncSlugRedirectsToKv(env: Env, session: Session): Promise<number> {
  const map = await getSlugRedirectMap(session);
  await env.DATA.put(SLUG_REDIRECT_KV_KEY, JSON.stringify(map));
  return Object.keys(map).length;
}

// Read side, for the admin list page's drift indicator only. The blob is a
// port-only artefact with no Django analogue, and it CAN drift out of step
// with D1 -- from the initial one-off seed, a hand edit via /admin/query/,
// or a `put` that failed after the row was written -- so the page shows
// both counts and offers a "Rebuild KV blob" button.
export async function readSlugRedirectKvCount(env: Env): Promise<number> {
  const raw = (await env.DATA.get(SLUG_REDIRECT_KV_KEY, "json")) as Record<string, string> | null;
  return raw ? Object.keys(raw).length : 0;
}
