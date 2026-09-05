import type { Env } from "../../worker-configuration";

// givefood/utils/cache.py:149-197 decache_async/decache -- the per-object
// purge Django fires from Foodbank.save() (models/foodbank.py:717-758) with
// the specific URLs and prefixes that food bank owns.
//
// THIS IS THE BLUNT VERSION, ON PURPOSE. It ignores the tags in the message
// and purges the whole zone. PLAN.md §3.6 specifies purging by Cache-Tag,
// which is the right design and is not built: nothing in workers/site emits
// a Cache-Tag header except routes/media.ts, so there is no tag set to purge
// against. Until that lands, the choice for a queue consumer is
// purge_everything or nothing, and nothing means a food bank edited in the
// admin keeps serving its old page until someone remembers the Clear Cache
// button.
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
// COALESCED PER BATCH. purge_everything is the most expensive operation
// available against a zone's cache and Cloudflare rate-limits it; a batch of
// 30 messages must not become 30 purges. One call, then every message in the
// batch is acked or retried on its outcome.
//
// WHEN THE TAG DESIGN LANDS: keep this file, replace the body of
// purgeZone() with a `files`/`tags` payload built from the batch, and delete
// the coalescing -- purging by tag is cheap enough to do per message.

export interface CachePurgeMessage {
  // Written by producers today, ignored here. Kept in the type so a producer
  // that starts tagging does not silently disagree with the consumer.
  tags?: string[];
  urls?: string[];
}

async function purgeZone(env: Env): Promise<boolean> {
  if (!env.CF_ZONE_ID || !env.CF_API_KEY) {
    // Not a failure worth retrying: the secrets are either set or they are
    // not, and retrying a batch every 60s until the DLQ will not change that.
    console.error("cache-purge: CF_ZONE_ID/CF_API_KEY unset, nothing purged");
    return true;
  }

  let res: Response;
  try {
    res = await fetch(`https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/purge_cache`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CF_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ purge_everything: true }),
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
  const ok = await purgeZone(env);
  for (const message of batch.messages) {
    if (ok) message.ack();
    else message.retry({ delaySeconds: 60 });
  }
  if (ok) console.log(`cache-purge: purged the zone for ${batch.messages.length} message(s)`);
}
