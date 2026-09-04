import type { Env } from "../../worker-configuration";
import {
  finishStaleCrawlSets,
  FRAG_KV_KEY_LAST_UPDATED,
  FRAG_KV_KEY_NEED_HITS,
  findCrawlSetByRunId,
  getFoodbanksByCountryForCharityCrawl,
  getFoodbanksWithRss,
  getLastModifiedFoodbank,
  getOpenFoodbanksForNeedCheck,
  getRecentHitsTotal,
  insertCrawlSet,
  insertFoodbankDiscrepancy,
  pruneCrawlItems,
  pruneCrawlSets,
  setCrawlSetExpected,
  updateDaysBetweenNeeds,
  type Session,
} from "@givefood/db";
import type { NeedcheckRenderMessage } from "../queues/needcheckRender";
import type { ArticlesMessage } from "../queues/articles";
import type { CharityMessage } from "../queues/charity";

// One handler per cron in wrangler.jsonc's triggers.crons, dispatched by
// the exact cron expression. See PLAN.md §10 (delivery plan) and §8.5
// (needcheck, in forensic detail) for what each becomes.
const HANDLERS: Record<string, (env: Env, scheduledTime: number) => Promise<void>> = {
  "0 15 * * *": needcheck,
  "20 8-22/2 * * *": getArticles,
  "30 5 * * *": charityInfo,
  // dump's "30 4 * * *" slot deliberately gone, not repurposed -- WP 5.6,
  // maintainer decision 2026-09-02: PLAN.md §8.8.
  "30 3 * * 0": daysBetweenNeeds,
  "10 3 * * *": crawlItemPrune,
  "*/5 * * * *": fragRefresh,
};

export async function handleScheduled(
  event: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const handler = HANDLERS[event.cron];
  if (!handler) {
    console.error(`givefood2-jobs: no handler registered for cron "${event.cron}"`);
    return;
  }
  ctx.waitUntil(handler(env, event.scheduledTime));
}

// Idempotent CrawlSet creation, shared by every fan-out cron (needcheck,
// getarticles, charityinfo): find-by-run_id first (the common case --
// PLAN.md §8.5.2/§8.5.5), and on the rare genuinely-concurrent duplicate
// Cron Trigger delivery (documented at-least-once), treat the loser's
// UNIQUE-constraint throw on crawlset_runid_uniq as the same harmless
// "already exists" outcome rather than an unhandled rejection inside
// ctx.waitUntil -- nothing has been enqueued yet at this point either way.
// Returns null when this invocation should no-op (a duplicate delivery).
async function getOrCreateCrawlSet(session: Session, crawlType: string, runId: string, label: string): Promise<number | null> {
  const existing = await findCrawlSetByRunId(session, runId);
  if (existing) {
    console.log(`${label}: crawlset for ${runId} already exists (id ${existing.id}) -- duplicate cron delivery, skipping`);
    return null;
  }
  try {
    return await insertCrawlSet(session, crawlType, runId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("UNIQUE constraint failed")) {
      console.log(`${label}: crawlset for ${runId} was just created by a concurrent invocation -- lost the race, skipping`);
      return null;
    }
    throw err;
  }
}

// sendBatch caps at 100 messages / 256 KB per call. Each chunk is
// independent, so one chunk's transient failure (a Queues blip) doesn't
// abort the rest -- letting a single failure stop the whole loop is worse
// than it looks: the CrawlSet row already committed by the time this
// runs, so any later invocation for the same run_id takes the "already
// exists, skipping" early return in getOrCreateCrawlSet and never resumes
// the un-enqueued remainder. Returns the counts so the caller can record
// a discrepancy on partial failure instead of the gap vanishing silently.
async function enqueueChunked<T>(queue: Queue<unknown>, items: T[], toBody: (item: T) => unknown, label: string): Promise<{ enqueuedCount: number; failedChunks: number }> {
  const BATCH_SIZE = 100;
  let enqueuedCount = 0;
  let failedChunks = 0;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk = items.slice(i, i + BATCH_SIZE);
    try {
      await queue.sendBatch(chunk.map((item) => ({ body: toBody(item) })));
      enqueuedCount += chunk.length;
    } catch (err) {
      failedChunks++;
      console.error(`${label}: sendBatch failed for chunk starting at index ${i} (${chunk.length} items)`, err);
    }
  }
  return { enqueuedCount, failedChunks };
}

async function recordEnqueueFailure(session: Session, label: string, missed: number, failedChunks: number): Promise<void> {
  await insertFoodbankDiscrepancy(session, {
    foodbankId: null,
    foodbankName: null,
    url: null,
    discrepancyType: "website",
    discrepancyText: `${label}: ${missed} food bank(s) across ${failedChunks} chunk(s) failed to enqueue and were not crawled today`,
  }).catch((discErr) => console.error(`${label}: also failed to write the enqueue-failure discrepancy`, discErr));
}

// PLAN.md §8.5.2: three lines of real work, deliberately -- a scheduled()
// handler on a >=1-hour interval gets 15 minutes of CPU, but there is no
// reason to spend any of it here. Create the CrawlSet, enqueue one
// message per open food bank, return; needcheckRender.ts's consumer does
// everything else.
async function needcheck(env: Env, scheduledTime: number): Promise<void> {
  const session = env.DB.withSession("first-unconstrained");
  const runId = `needcheck-${new Date(scheduledTime).toISOString().slice(0, 10)}`;
  const crawlSetId = await getOrCreateCrawlSet(session, "need", runId, "needcheck");
  if (crawlSetId === null) return;

  const foodbanks = await getOpenFoodbanksForNeedCheck(session);

  // Set expected/remaining BEFORE sending a single message: the queue
  // consumer can start processing (and decrementing `remaining`) as soon
  // as the first sendBatch call lands, which can easily be before this
  // function itself would otherwise get around to initialising the
  // counter. decrementCrawlSetRemaining()'s guard (`remaining > 0`)
  // matches nothing while `remaining` is still NULL, so an early message
  // finishing before that update landed would silently fail to
  // decrement -- permanently under-counting this run.
  await setCrawlSetExpected(session, crawlSetId, foodbanks.length);

  const { enqueuedCount, failedChunks } = await enqueueChunked(
    env.RENDER_Q,
    foodbanks,
    (fb) =>
      ({
        crawlSetId,
        foodbankId: fb.id,
        slug: fb.slug,
        name: fb.name,
        url: fb.url,
        shoppingListUrl: fb.shopping_list_url,
        facebookPage: fb.facebook_page,
      }) satisfies NeedcheckRenderMessage,
    "needcheck",
  );

  if (failedChunks > 0) await recordEnqueueFailure(session, `needcheck ${runId}`, foodbanks.length - enqueuedCount, failedChunks);

  console.log(`needcheck: enqueued ${enqueuedCount}/${foodbanks.length} food banks for ${runId} (crawlset ${crawlSetId})`);
}

// PLAN.md §8.6: same shape as needcheck's cron -- CrawlSet, expected/
// remaining, chunked enqueue -- targeting every food bank with an RSS feed.
async function getArticles(env: Env, scheduledTime: number): Promise<void> {
  const session = env.DB.withSession("first-unconstrained");
  const runId = `articles-${new Date(scheduledTime).toISOString().slice(0, 10)}`;
  const crawlSetId = await getOrCreateCrawlSet(session, "article", runId, "articles");
  if (crawlSetId === null) return;

  const foodbanks = await getFoodbanksWithRss(session);
  await setCrawlSetExpected(session, crawlSetId, foodbanks.length);

  const { enqueuedCount, failedChunks } = await enqueueChunked(
    env.ARTICLES_Q,
    foodbanks,
    (fb) => ({ crawlSetId, foodbankId: fb.id, slug: fb.slug }) satisfies ArticlesMessage,
    "articles",
  );

  if (failedChunks > 0) await recordEnqueueFailure(session, `articles ${runId}`, foodbanks.length - enqueuedCount, failedChunks);

  console.log(`articles: enqueued ${enqueuedCount}/${foodbanks.length} food banks for ${runId} (crawlset ${crawlSetId})`);
}

// PLAN.md §8.7: ONE CrawlSet (matching crawlers.py's single daily
// crawl_type='charity' run across all countries), fanned out across
// THREE queues -- one per regulator, "so each regulator gets independent
// concurrency and can be backed off without stalling the others" -- all
// three sets of messages carrying the same crawlSetId, so
// decrementCrawlSetRemaining still closes the one CrawlSet out correctly
// regardless of which queue actually processed a given food bank.
async function charityInfo(env: Env, scheduledTime: number): Promise<void> {
  const session = env.DB.withSession("first-unconstrained");
  const runId = `charity-${new Date(scheduledTime).toISOString().slice(0, 10)}`;
  const crawlSetId = await getOrCreateCrawlSet(session, "charity", runId, "charityinfo");
  if (crawlSetId === null) return;

  const [ewFoodbanks, scotlandFoodbanks, niFoodbanks] = await Promise.all([
    getFoodbanksByCountryForCharityCrawl(session, ["England", "Wales"]),
    getFoodbanksByCountryForCharityCrawl(session, ["Scotland"]),
    getFoodbanksByCountryForCharityCrawl(session, ["Northern Ireland"]),
  ]);
  const total = ewFoodbanks.length + scotlandFoodbanks.length + niFoodbanks.length;
  await setCrawlSetExpected(session, crawlSetId, total);

  const toBody = (fb: { id: number; slug: string }) => ({ crawlSetId, foodbankId: fb.id, slug: fb.slug }) satisfies CharityMessage;
  const results = await Promise.all([
    enqueueChunked(env.CHARITY_EW_Q, ewFoodbanks, toBody, "charity-ew"),
    enqueueChunked(env.CHARITY_SCOTLAND_Q, scotlandFoodbanks, toBody, "charity-scotland"),
    enqueueChunked(env.CHARITY_NI_Q, niFoodbanks, toBody, "charity-ni"),
  ]);

  const enqueuedCount = results.reduce((sum, r) => sum + r.enqueuedCount, 0);
  const failedChunks = results.reduce((sum, r) => sum + r.failedChunks, 0);
  if (failedChunks > 0) await recordEnqueueFailure(session, `charityinfo ${runId}`, total - enqueuedCount, failedChunks);

  console.log(`charityinfo: enqueued ${enqueuedCount}/${total} food banks for ${runId} (crawlset ${crawlSetId})`);
}

// PLAN.md §8.9: replaces days_between_needs.py's per-food-bank N+1
// (~4,000 queries + 1,024 full model saves) with the one window-function
// statement in updateDaysBetweenNeeds -- weekly, ≥1-hour interval, so this
// handler has 15 minutes of CPU for a statement that takes milliseconds.
async function daysBetweenNeeds(env: Env): Promise<void> {
  const session = env.DB.withSession("first-unconstrained");
  await updateDaysBetweenNeeds(session);
  console.log("daysBetweenNeeds: done");
}

// PLAN.md §8.10.2: prune_db_task_results's old slot, repointed at
// crawlitem -- no retention policy existed at all in Django, and it grows
// ~5,845 rows/day forever. Order matches PLAN's own: prune items, then
// sets, then backstop-stamp any crawlset the expected/remaining mechanism
// (needcheck.ts) didn't reach 0 for -- see finishStaleCrawlSets's own
// comment on why that's a backstop, not the primary mechanism, here.
//
// No R2 archival of pruned history yet (PLAN.md §8.10.2 also calls for
// "crawlitem/YYYY-MM.ndjson.gz before the first prune") -- deliberately
// deferred, not forgotten: crawlitem is confirmed empty on production D1
// today (verified directly), since no cron that writes to it has run
// there yet. There is nothing to lose by pruning now; the archival step
// only matters once real rows start accumulating, which is closer to
// launch than to this WP.
async function crawlItemPrune(env: Env): Promise<void> {
  const session = env.DB.withSession("first-unconstrained");
  const itemsDeleted = await pruneCrawlItems(session);
  const setsDeleted = await pruneCrawlSets(session);
  await finishStaleCrawlSets(session);
  console.log(`crawlItemPrune: deleted ${itemsDeleted} crawlitem(s), ${setsDeleted} crawlset(s)`);
}

// WP 4.4: precomputes the two expensive /frag/ values (last-updated,
// need-hits) into DATA KV so workers/site's frag handler does zero
// database work on the hot path -- see that file
// (workers/site/src/routes/public/frag.ts) for the read side and the
// read-through-then-write-back fallback it uses on a cache miss. Key
// names live in packages/db/src/frag.ts (FRAG_KV_KEY_*), not duplicated
// as literals here -- both this Worker and workers/site already depend
// on @givefood/db, so there's a real shared home for them despite the two
// Workers being deliberately separate, independently-deployable units
// otherwise (PLAN.md §3.1).
//
// Same D1 Sessions API rule as workers/site (packages/db/src/session.ts's
// own comment: never a bare env.DB.prepare(), this database has read
// replication enabled) -- this is the first D1 access in this Worker, so
// there's no existing local helper to reuse; inlined here rather than
// adding one function for a single call site.
const SEVEN_DAYS_MS = 60 * 60 * 24 * 7 * 1000;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Each half refreshed independently -- a failure writing one value (a
// transient KV error, say) shouldn't skip the other, unrelated one for
// this tick; both are retried again on the next tick regardless.
async function fragRefresh(env: Env): Promise<void> {
  const session = env.DB.withSession("first-unconstrained");

  const results = await Promise.allSettled([
    (async () => {
      const modified = await getLastModifiedFoodbank(session);
      if (modified) await env.DATA.put(FRAG_KV_KEY_LAST_UPDATED, modified);
    })(),
    (async () => {
      const since = isoDate(new Date(Date.now() - SEVEN_DAYS_MS));
      const total = await getRecentHitsTotal(session, since);
      if (total !== null) await env.DATA.put(FRAG_KV_KEY_NEED_HITS, String(total));
    })(),
  ]);
  for (const result of results) {
    if (result.status === "rejected") console.error("fragRefresh: one of the two refreshes failed", result.reason);
  }
}
