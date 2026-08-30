import type { Env } from "../../worker-configuration";

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

async function fragRefresh(env: Env): Promise<void> {
  throw new Error("fragRefresh: not implemented");
}
