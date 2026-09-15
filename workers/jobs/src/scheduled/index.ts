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
  refreshSiteStats,
  setCrawlSetExpected,
  updateDaysBetweenNeeds,
  type Session,
} from "@givefood/db";
import { pyNow } from "@givefood/models";
import { generateDumps, pruneDumps } from "../dumps";
import { hitRollup } from "../hitRollup";
import type { NeedcheckRenderMessage } from "../queues/needcheckRender";
import type { ArticlesMessage } from "../queues/articles";
import type { CharityMessage } from "../queues/charity";

// One handler per cron in wrangler.jsonc's triggers.crons, dispatched by
// the exact cron expression. See PLAN.md §10 (delivery plan) and §8.5
// (needcheck, in forensic detail) for what each becomes.
//
// KEYS MUST BE THE WRANGLER STRINGS CHARACTER FOR CHARACTER. Cloudflare sets
// `controller.cron` to the configured trigger text, and a miss here is only a
// console.error. days_between_needs was keyed "30 3 * * 0" after wrangler had
// moved to "30 3 * * SUN", so it never ran on Workers: on 2026-09-15 every
// quiet open food bank still held the value Django computed on 2026-08-30.
// Exported for index.test.ts, which compares these keys with wrangler.jsonc.
export const HANDLERS: Record<string, (env: Env, scheduledTime: number) => Promise<void>> = {
  "0 15 * * *": needcheck,
  "20 8-22/2 * * *": getArticles,
  "30 5 * * *": charityInfo,
  // dump's "30 4 * * *" slot deliberately gone, not repurposed -- WP 5.6,
  // maintainer decision 2026-09-02: PLAN.md §8.8.
  "30 3 * * SUN": daysBetweenNeeds,
  "10 3 * * *": crawlItemPrune,
  "*/5 * * * *": fragRefresh,
  "30 4 * * *": dumps,
  "7 * * * *": hitRollup,
  "37 * * * *": siteStatsRefresh,
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

// The idempotency key for one cron FIRING, from the scheduled time.
//
// MUST INCLUDE THE TIME, not just the date. It used to be
// `.toISOString().slice(0, 10)` -- YYYY-MM-DD -- in all three fan-out
// crons, which is correct only for a cron that fires once a day.
// getarticles fires eight times a day ("20 8-22/2 * * *"), so all eight
// firings computed the SAME runId: the first created the crawl set and
// the other seven found it, logged "duplicate cron delivery, skipping",
// and enqueued nothing at all. The article crawl therefore ran ONCE A DAY
// instead of eight times from the day this Worker went live -- confirmed
// against crawlset, which held exactly one `article` row per day
// (2026-09-04 10:20, 2026-09-05 08:20) where there should have been eight.
//
// Nothing failed loudly, because skipping is a legitimate outcome here:
// Cloudflare delivers Cron Triggers at least once, and this guard exists
// precisely so a genuine duplicate delivery no-ops. A duplicate delivery
// and the next scheduled firing were indistinguishable.
//
// Minute precision keeps that duplicate-delivery guard working -- a
// redelivery carries the SAME scheduledTime, so it still collides -- while
// making consecutive firings distinct for any cron down to once a minute.
// Applied to all three fan-out crons, not just getarticles: needcheck and
// charityinfo are daily today and were unaffected, but docs/crons.md
// records needcheck as having been "45 7,11,15,19" (four times daily), and
// restoring that would silently reintroduce exactly this bug.
function cronRunId(prefix: string, scheduledTime: number): string {
  return `${prefix}-${new Date(scheduledTime).toISOString().slice(0, 16)}`;
}

// Idempotent CrawlSet creation, shared by every fan-out cron (needcheck,
// getarticles, charityinfo): find-by-run_id first (the common case --
// PLAN.md §8.5.2/§8.5.5), and on the rare genuinely-concurrent duplicate
// Cron Trigger delivery (documented at-least-once), treat the loser's
// UNIQUE-constraint throw on crawlset_runid_uniq as the same harmless
// "already exists" outcome rather than an unhandled rejection inside
// ctx.waitUntil -- nothing has been enqueued yet at this point either way.
// Returns null when this invocation should no-op (a duplicate delivery).
//
// RETRIES THE INSERT, because on 2026-09-09 not retrying cost a whole day
// of data twice. charityinfo (05:30) and needcheck (15:00) both died here
// with "D1_ERROR: D1 DB storage operation exceeded timeout which caused
// object to be reset" -- a transient fault in D1's storage layer, on the
// primary (the find-by-run_id read just above succeeded both times, since
// withSession("first-unconstrained") lets a read serve from a replica while
// every write goes to the primary). Different script versions nine hours
// apart, so not a code regression. Cron Triggers do not retry, so one blip
// on the first statement lost the entire sweep: zero of 1,023 food banks
// crawled, and needcheck recorded 0 need updates that day against 14-32 on
// every other day.
//
// THE WRITE HAD ACTUALLY COMMITTED. Only the acknowledgement timed out, so
// crawlset kept a row for the run that never happened -- which then blocked
// its own recovery, because the find-by-run_id above would report it as a
// duplicate delivery and skip. That is why a bare `retry the INSERT` is the
// wrong fix: the retry hits crawlset_runid_uniq, takes the "lost the race"
// path, and no-ops exactly as before. The recovery has to RE-READ and adopt
// the row this invocation already wrote.
//
// Distinguishing "my write landed" from "a concurrent invocation beat me"
// is what `start` is for. It is generated once, before the first attempt,
// reused verbatim by every retry, and compared on re-read. A row carrying
// our own start is ours to continue with; any other value belongs to a
// genuine concurrent delivery and we still skip. Two distinct invocations
// would have to generate the same millisecond to confuse this, and the
// residual risk is deliberately biased the safe way round: a false "not
// mine" costs one skipped run (today's behaviour), while a false "mine"
// would double-crawl every food bank.
const CRAWLSET_INSERT_ATTEMPTS = 3;
const CRAWLSET_RETRY_BASE_MS = 1_000;

// Exported for workers/jobs/src/scheduled/index.test.ts -- this is the
// function whose un-retried failure lost 2026-09-09, so its recovery paths
// are tested directly rather than through handleScheduled's queue plumbing.
export async function getOrCreateCrawlSet(session: Session, crawlType: string, runId: string, label: string): Promise<number | null> {
  const existing = await findCrawlSetByRunId(session, runId);
  if (existing) {
    console.log(`${label}: crawlset for ${runId} already exists (id ${existing.id}) -- duplicate cron delivery, skipping`);
    return null;
  }

  // One timestamp for the whole loop -- see the ownership note above.
  const start = pyNow();

  for (let attempt = 1; attempt <= CRAWLSET_INSERT_ATTEMPTS; attempt++) {
    try {
      return await insertCrawlSet(session, crawlType, runId, start);
    } catch (err) {
      // Re-read before deciding anything, including on a UNIQUE violation:
      // after a retry, that constraint fires on OUR OWN committed-but-
      // unacknowledged row just as readily as on a competitor's.
      const landed = await findCrawlSetByRunId(session, runId).catch(() => null);
      if (landed) {
        if (landed.start === start) {
          console.log(`${label}: insert for ${runId} threw but had committed (id ${landed.id}) -- adopting it and continuing`);
          return landed.id;
        }
        console.log(`${label}: crawlset for ${runId} was created by a concurrent invocation -- lost the race, skipping`);
        return null;
      }

      // Nothing landed, so the write genuinely failed. A UNIQUE violation
      // with no row to show for it is self-contradictory -- do not retry
      // into it, and do not claim the run either.
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("UNIQUE constraint failed")) {
        console.error(`${label}: UNIQUE violation for ${runId} but no row found on re-read -- skipping`);
        return null;
      }

      if (attempt === CRAWLSET_INSERT_ATTEMPTS) {
        console.error(`${label}: crawlset insert for ${runId} failed ${attempt} times, giving up`, err);
        throw err;
      }
      console.warn(`${label}: crawlset insert for ${runId} failed (attempt ${attempt}/${CRAWLSET_INSERT_ATTEMPTS}), retrying`, err);
      await new Promise((resolve) => setTimeout(resolve, CRAWLSET_RETRY_BASE_MS * attempt));
    }
  }

  // Unreachable: the final attempt either returns or throws.
  return null;
}

// github #59. Django's `dump` management command, CSV only, straight to R2.
//
// NOT A FAN-OUT, so it takes none of the crawlset machinery above: there is
// no per-food-bank work to distribute, just four sequential streaming reads.
// It is also the only cron here that writes objects rather than rows.
//
// Runs inline rather than through ctx.waitUntil's usual pattern for the same
// reason the fan-outs do -- see handleScheduled -- but note this one is long:
// the items dump alone pages 333,874 rows. The Worker's cpu_ms is 300000.
async function dumps(env: Env, scheduledTime: number): Promise<void> {
  const session = env.DB.withSession("first-unconstrained");
  // MILLISECONDS, like cronRunId above -- not seconds. `* 1000` here put the
  // date in the year 58660, whose toISOString() starts "+058660-", and the
  // key silently became nonsense.
  const date = new Date(scheduledTime).toISOString().slice(0, 10);

  const results = await generateDumps(session, env.DUMPS, date);
  for (const r of results) console.log(`dump: wrote ${r.key} -- ${r.rows} rows, ${r.bytes} bytes`);

  // Prune AFTER writing, never before: a failed generation that had already
  // deleted the old objects would leave the bucket with a hole rather than a
  // stale-but-complete archive.
  const deleted = await pruneDumps(env.DUMPS, date);
  console.log(`dump: pruned ${deleted.length} expired object(s)`);
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
  const runId = cronRunId("needcheck", scheduledTime);
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
  const runId = cronRunId("articles", scheduledTime);
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
  const runId = cronRunId("charity", scheduledTime);
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

// The homepage, /llms.txt and /md/ totals (site_stats). Their only writer
// was the Postgres extraction tool, so they froze at 2026-09-05 -- see
// refreshSiteStats. Hourly per PLAN.md's Tier 2 table; :37 keeps it clear of
// the :07 hit rollup and the */5 frag refresh's heavier ticks.
async function siteStatsRefresh(env: Env): Promise<void> {
  const session = env.DB.withSession("first-unconstrained");
  await refreshSiteStats(session, pyNow());
  console.log("siteStatsRefresh: done");
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
