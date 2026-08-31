import type { Env } from "../../worker-configuration";
import { FRAG_KV_KEY_LAST_UPDATED, FRAG_KV_KEY_NEED_HITS, getLastModifiedFoodbank, getRecentHitsTotal } from "@givefood/db";

// One handler per cron in wrangler.jsonc's triggers.crons, dispatched by
// the exact cron expression. None of these are implemented yet -- see
// PLAN.md §10 (delivery plan) and §3.10/§8 (needcheck as a Workflow) for
// what each becomes. This file exists so the Worker's scheduled() export
// has somewhere real to route to as each job is built.
const HANDLERS: Record<string, (env: Env) => Promise<void>> = {
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
  ctx.waitUntil(handler(env));
}

// PLAN.md §3.10/§8: the needcheck pipeline (fetch/render food bank pages via
// Browser Rendering, OpenRouter extraction, the "material change?" gate) is
// the single highest-stakes piece of the jobs Worker and is not built yet.
async function needcheck(env: Env): Promise<void> {
  throw new Error("needcheck: not implemented");
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
