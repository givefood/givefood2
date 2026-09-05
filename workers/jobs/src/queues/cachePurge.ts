import type { Env } from "../../worker-configuration";

// givefood/utils/cache.py:149-197 decache_async/decache -- the per-object
// purge Django fires from Foodbank.save() (models/foodbank.py:717-758) with
// the specific URLs and prefixes that food bank owns.
//
// PURGES BY TAG, per PLAN.md §3.6. workers/site/src/middleware/cacheTag.ts
// stamps every cacheable response with what it depends on -- fb-<slug> for
// one food bank's pages and API representations, pc-<slug> for a
// constituency, fb-all for the aggregates -- and this turns a message
// naming those tags into a purge of exactly them.
//
// Checked before building it: purge by tag is NOT Enterprise-only. Free,
// Pro, Business and Enterprise all support URL, hostname, tag and prefix
// purging; only the rate limits differ. givefood.org.uk is Business.
//
// purge_everything remains, as the fallback for a message with no tags.
// That is what the previous version of this consumer did for every message.
//
// This consumer used to be a `message.retry()` stub in index.ts -- every
// purge message retried forever and then went to cache-purge-dlq, which has
// no consumer of its own. So the one producer that exists
// (queues/articles.ts:86, on finding a new article) has never purged
// anything.
//
// WHY IT MATTERS AT CUTOVER SPECIFICALLY. While the zone route is commented
// out, this Worker serves from its beta custom domain with no zone cache in
// front of it, so a purge of givefood.org.uk hits the cache in front of live
// Django -- correct during the strangler period, and the same zone Django's
// own decache() targets. The moment www moves to the Worker, the Worker's
// responses become the thing being cached, and a missing purge becomes a
// visibly stale food bank page.
//
// COALESCED PER BATCH, still. Cloudflare caps a tag purge at 30 tags per
// request, and a batch of messages naming overlapping tags (every food bank
// save carries fb-all) would otherwise purge the same tag repeatedly. The
// batch's tags are unioned, then sent in chunks of 30.

export interface CachePurgeMessage {
  // Tag names come from @givefood/urls' cacheTags module, which is also what
  // workers/site stamps responses with -- a tag invented independently on
  // either side is a purge that silently does nothing.
  tags?: string[];
}

// Cloudflare's cap for a tag purge. Exceeding it is a 400, not a partial
// purge, so the union is chunked rather than truncated.
const TAGS_PER_REQUEST = 30;

async function purge(env: Env, body: Record<string, unknown>): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch(`https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/purge_cache`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CF_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    console.error("cache-purge: Cloudflare purge_cache could not be reached", err);
    return false;
  }

  // The v4 API answers 200 with {"success": false} for a token missing
  // Zone.Cache Purge, so res.ok alone would report a lie -- the same trap
  // routes/admin/clearCache.ts documents. Django checks neither
  // (cache.py:172/196 throws the response away).
  let payload: { success?: boolean; errors?: unknown } | null = null;
  try {
    payload = (await res.json()) as { success?: boolean; errors?: unknown };
  } catch {
    payload = null;
  }
  if (!res.ok || payload?.success !== true) {
    console.error(`cache-purge: purge_cache failed (HTTP ${res.status})`, payload?.errors);
    return false;
  }
  return true;
}

export async function handleCachePurgeQueue(batch: MessageBatch<CachePurgeMessage>, env: Env): Promise<void> {
  if (!env.CF_ZONE_ID || !env.CF_API_KEY) {
    // Acked, not retried: the secrets are either set or they are not, and
    // retrying a batch every 60s until the DLQ will not make one appear.
    console.error("cache-purge: CF_ZONE_ID/CF_API_KEY unset, nothing purged");
    for (const message of batch.messages) message.ack();
    return;
  }

  const tags = new Set<string>();
  let purgeAll = false;
  for (const message of batch.messages) {
    const t = message.body?.tags;
    if (t?.length) t.forEach((tag) => tags.add(tag));
    // A message that names no tags cannot be satisfied by a tag purge, and
    // guessing would be worse than the blunt instrument.
    else purgeAll = true;
  }

  let ok: boolean;
  if (purgeAll) {
    ok = await purge(env, { purge_everything: true });
    if (ok) console.log(`cache-purge: purged everything for ${batch.messages.length} message(s)`);
  } else {
    const list = [...tags];
    ok = true;
    for (let i = 0; i < list.length && ok; i += TAGS_PER_REQUEST) {
      ok = await purge(env, { tags: list.slice(i, i + TAGS_PER_REQUEST) });
    }
    if (ok) console.log(`cache-purge: purged ${list.length} tag(s) for ${batch.messages.length} message(s): ${list.slice(0, 8).join(", ")}`);
  }

  for (const message of batch.messages) {
    if (ok) message.ack();
    else message.retry({ delaySeconds: 60 });
  }
}
