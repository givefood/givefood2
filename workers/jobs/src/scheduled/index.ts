import type { Env } from "../../worker-configuration";
import {
  FRAG_KV_KEY_LAST_UPDATED,
  FRAG_KV_KEY_NEED_HITS,
  findCrawlSetByRunId,
  getLastModifiedFoodbank,
  getOpenFoodbanksForNeedCheck,
  getRecentHitsTotal,
  insertCrawlSet,
  insertFoodbankDiscrepancy,
  setCrawlSetExpected,
} from "@givefood/db";
import type { NeedcheckRenderMessage } from "../queues/needcheckRender";

// One handler per cron in wrangler.jsonc's triggers.crons, dispatched by
// the exact cron expression. See PLAN.md §10 (delivery plan) and §8.5
// (needcheck, in forensic detail) for what each becomes.
const HANDLERS: Record<string, (env: Env, scheduledTime: number) => Promise<void>> = {
  "0 15 * * *": needcheck,
  "20 8-22/2 * * *": getArticles,
  "30 5 * * *": charityInfo,
  "30 4 * * *": dump,
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
    console.error(`givefood-jobs: no handler registered for cron "${event.cron}"`);
    return;
  }
  ctx.waitUntil(handler(env, event.scheduledTime));
}

// PLAN.md §8.5.2: three lines of real work, deliberately -- a scheduled()
// handler on a >=1-hour interval gets 15 minutes of CPU, but there is no
// reason to spend any of it here. Create the CrawlSet, enqueue one
// message per open food bank, return; needcheckRender.ts's consumer does
// everything else.
async function needcheck(env: Env, scheduledTime: number): Promise<void> {
  const session = env.DB.withSession("first-unconstrained");

  // Idempotency: the run id is derived from the scheduled date. Cron
  // Triggers are at-least-once, so a duplicate delivery finds the
  // existing row and does nothing (PLAN.md §8.5.2, §8.5.5).
  const runId = `needcheck-${new Date(scheduledTime).toISOString().slice(0, 10)}`;
  const existing = await findCrawlSetByRunId(session, runId);
  if (existing) {
    console.log(`needcheck: crawlset for ${runId} already exists (id ${existing.id}) -- duplicate cron delivery, skipping`);
    return;
  }

  let crawlSetId: number;
  try {
    crawlSetId = await insertCrawlSet(session, "need", runId);
  } catch (err) {
    // The findCrawlSetByRunId check above is check-then-insert, not
    // transactional -- two genuinely concurrent duplicate Cron Trigger
    // deliveries (documented at-least-once) can both pass it and race to
    // insert. crawlset_runid_uniq (0008_needcheck.sql) then makes the
    // loser's INSERT throw; treat that exactly like the read-side
    // "already exists" case above (harmless, nothing has been enqueued
    // yet) rather than letting it surface as an unhandled rejection
    // inside ctx.waitUntil, indistinguishable from a genuine failure.
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("UNIQUE constraint failed")) {
      console.log(`needcheck: crawlset for ${runId} was just created by a concurrent invocation -- lost the race, skipping`);
      return;
    }
    throw err;
  }
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

  // sendBatch caps at 100 messages / 256 KB per call. Each chunk is
  // independent, so one chunk's transient failure (a Queues blip) doesn't
  // abort the other ~10 -- letting a single failure stop the whole loop
  // used to be worse than it looks: the CrawlSet row above already
  // committed, so any later invocation for the same runId takes the
  // "already exists, skipping" early return and never resumes the
  // un-enqueued remainder. Un-enqueued food banks are recorded as one
  // discrepancy below instead of vanishing silently.
  const BATCH_SIZE = 100;
  let enqueuedCount = 0;
  let failedChunks = 0;
  for (let i = 0; i < foodbanks.length; i += BATCH_SIZE) {
    const chunk = foodbanks.slice(i, i + BATCH_SIZE);
    try {
      await env.RENDER_Q.sendBatch(
        chunk.map((fb) => ({
          body: {
            crawlSetId,
            foodbankId: fb.id,
            slug: fb.slug,
            name: fb.name,
            url: fb.url,
            shoppingListUrl: fb.shopping_list_url,
            facebookPage: fb.facebook_page,
          } satisfies NeedcheckRenderMessage,
        })),
      );
      enqueuedCount += chunk.length;
    } catch (err) {
      failedChunks++;
      console.error(`needcheck: sendBatch failed for chunk starting at index ${i} (${chunk.length} food banks) in run ${runId}`, err);
    }
  }

  if (failedChunks > 0) {
    const missed = foodbanks.length - enqueuedCount;
    await insertFoodbankDiscrepancy(session, {
      foodbankId: null,
      foodbankName: null,
      url: null,
      discrepancyType: "website",
      discrepancyText: `needcheck ${runId}: ${missed} food bank(s) across ${failedChunks} chunk(s) failed to enqueue and were not need-checked today`,
    }).catch((discErr) => console.error("needcheck: also failed to write the enqueue-failure discrepancy", discErr));
  }

  console.log(`needcheck: enqueued ${enqueuedCount}/${foodbanks.length} food banks for ${runId} (crawlset ${crawlSetId})`);
}

async function getArticles(env: Env): Promise<void> {
  throw new Error("getArticles: not implemented");
}

async function charityInfo(env: Env): Promise<void> {
  throw new Error("charityInfo: not implemented");
}

async function dump(env: Env): Promise<void> {
  throw new Error("dump: not implemented");
}

async function daysBetweenNeeds(env: Env): Promise<void> {
  throw new Error("daysBetweenNeeds: not implemented");
}

async function crawlItemPrune(env: Env): Promise<void> {
  throw new Error("crawlItemPrune: not implemented");
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
