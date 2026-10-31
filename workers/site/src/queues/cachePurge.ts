// The cache-purge queue consumer. Producers (routes/admin/* on a food bank,
// need or location save, and givefood2-jobs' article crawler) send a message
// naming the Cache-Tag values that changed; this turns a batch of them into
// purges of exactly those tags. middleware/cacheTag.ts stamps the tags on
// every cacheable response -- fb-<slug> for one food bank's pages and API
// representations, pc-<slug> for a constituency, fb-all for the aggregates.
//
// WHY IT LIVES IN THIS WORKER AND NOT IN givefood2-jobs. wrangler.jsonc turns
// on Workers Caching, and that cache belongs to this Worker alone. Cloudflare
// is explicit that no zone-level purge -- dashboard, purge_cache API or
// Terraform -- touches it, and that ctx.cache.purge() only reaches the cache
// of the Worker (and the entrypoint) that calls it
// (developers.cloudflare.com/workers/cache/purge/). This consumer used to run
// in givefood2-jobs and POST to the zone's purge_cache API, so every purge
// reported success while the food bank's cached page stayed exactly as it was
// until its TTL ran out. A queue handler on this Worker's default export runs
// in the same default entrypoint every eyeball request is cached under, so a
// purge from here is a purge of the cache the site actually serves from.
//
// RATE LIMITS. Workers Caching always gets the Free-plan purge limits, per
// account, whatever the zone's plan: 5 tag/prefix/everything purges a minute,
// a bucket of 25, and at most 100 tags in one call. Hence coalescing the
// whole batch (every food bank save carries fb-all, so a busy batch names the
// same tag many times) and chunking at 100. A rate-limited purge resolves
// with success:false, and the batch is retried a minute later.
//
// purgeEverything remains, as the fallback for a message with no tags --
// guessing which tags it meant would be worse than the blunt instrument.

export interface CachePurgeMessage {
  // Tag names come from @givefood/urls' cacheTags module, which is also what
  // middleware/cacheTag.ts stamps responses with -- a tag invented
  // independently on either side is a purge that silently does nothing.
  tags?: string[];
}

// Cloudflare's cap for one tag purge. Exceeding it is a rejected call, not a
// partial purge, so the union is chunked rather than truncated.
export const TAGS_PER_PURGE = 100;

async function purge(cache: CacheContext, options: CachePurgeOptions): Promise<boolean> {
  try {
    const result = await cache.purge(options);
    // Strict equality: only a real boolean true is a success.
    if (result?.success === true) return true;
    console.error("cache-purge: Workers Cache purge failed", result?.errors);
    return false;
  } catch (err) {
    console.error("cache-purge: Workers Cache purge threw", err);
    return false;
  }
}

export async function handleCachePurgeQueue(batch: MessageBatch<CachePurgeMessage>, ctx: ExecutionContext): Promise<void> {
  const cache = ctx.cache;
  if (!cache) {
    // No Workers Cache on this invocation (a local runner, or "cache" turned
    // off in wrangler.jsonc). There is then nothing cached to purge, so ack
    // rather than retrying the batch into the dead-letter queue.
    console.error("cache-purge: no Workers Cache on this invocation, nothing purged");
    for (const message of batch.messages) message.ack();
    return;
  }

  const tags = new Set<string>();
  let purgeAll = false;
  for (const message of batch.messages) {
    const t = message.body?.tags;
    if (t?.length) t.forEach((tag) => tags.add(tag));
    else purgeAll = true;
  }

  let ok: boolean;
  if (purgeAll) {
    ok = await purge(cache, { purgeEverything: true });
    if (ok) console.log(`cache-purge: purged everything for ${batch.messages.length} message(s)`);
  } else {
    const list = [...tags];
    ok = true;
    for (let i = 0; i < list.length && ok; i += TAGS_PER_PURGE) {
      ok = await purge(cache, { tags: list.slice(i, i + TAGS_PER_PURGE) });
    }
    if (ok) console.log(`cache-purge: purged ${list.length} tag(s) for ${batch.messages.length} message(s): ${list.slice(0, 8).join(", ")}`);
  }

  for (const message of batch.messages) {
    if (ok) message.ack();
    else message.retry({ delaySeconds: 60 });
  }
}
