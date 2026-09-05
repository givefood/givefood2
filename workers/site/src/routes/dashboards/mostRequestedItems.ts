import type { Context } from "hono";
import { getLatestNeedTextsSince } from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { elapsedMs } from "../../middleware/serverTiming";

function pageContext(c: Context<AppEnv>) {
  return { ...buildPageContext({ path: c.req.path }), render_time_ms: elapsedMs(c) };
}

// gfdash `most_requested_items`/`tt_most_requested_items` (views.py:83-143)
// -- the same allowed-days gate as most_excess_items.
const ALLOWED_DAYS = [7, 30, 60, 90, 120, 365];
const DEFAULT_DAYS = 30;
const MS_PER_DAY = 86_400_000;

// The three keyword sentinels views.py's `invalid_text` list excludes --
// exact-string match, not substring, and NOT the same two-item list
// no_items() in @givefood/models checks (that one deliberately omits
// "Facebook" -- see its own comment), so this is spelled out inline
// rather than reusing that helper.
const INVALID_TEXT = new Set(["Nothing", "Unknown", "Facebook"]);

interface ItemCount {
  item: string;
  count: number;
}

// D1's `created`/`last_need` columns sort correctly as plain text against
// any zero-padded "YYYY-MM-DD HH:MM:SS" prefix, even without matching the
// stored value's ".ffffff" fractional-second width -- see
// packages/db/src/dashboards.ts's getLatestNeedTextsSince for the query
// this feeds.
function sinceIso(days: number, now: Date): string {
  return new Date(now.getTime() - days * MS_PER_DAY).toISOString().slice(0, 19).replace("T", " ");
}

// Shared by both public entry points below -- `trusselltrust` is passed in
// explicitly by the caller (derived from which route matched) rather than
// re-derived from the request path here, so this function's behaviour
// never depends on how it happens to have been reached.
async function renderMostRequestedItems(c: Context<AppEnv>, trusselltrust: boolean): Promise<Response> {
  const daysParam = c.req.query("days") ?? String(DEFAULT_DAYS);
  const days = Number(daysParam);
  if (!ALLOWED_DAYS.includes(days)) {
    return new Response("", { status: 403 });
  }

  const session = dbSession(c);
  const rows = await getLatestNeedTextsSince(session, sinceIso(days, new Date()), trusselltrust);

  const items: string[] = [];
  let numberFoodbanks = 0;

  for (const row of rows) {
    if (!INVALID_TEXT.has(row.change_text)) {
      items.push(...row.change_text.split("\n"));
    }
    numberFoodbanks += 1;
  }

  // group_list() (givefood/utils/text.py:133-135) -- a Counter over the
  // flat items list, first-seen order preserved (JS's Map iterates in
  // insertion order, same as Python's Counter). Array.prototype.sort is
  // stable (ES2019+), matching Python's sorted(reverse=True)'s tie
  // behaviour -- equal counts keep this same first-seen order.
  const itemsFreq = new Map<string, number>();
  for (const item of items) {
    itemsFreq.set(item, (itemsFreq.get(item) ?? 0) + 1);
  }
  const itemsSorted: ItemCount[] = Array.from(itemsFreq.entries())
    .map(([item, count]) => ({ item, count }))
    .sort((a, b) => b.count - a.count);

  return c.html(
    await render("dash/most_requested_items.njk", {
      ...pageContext(c),
      items_sorted: itemsSorted,
      allowed_days: ALLOWED_DAYS,
      days,
      number_foodbanks: numberFoodbanks,
      number_items: itemsFreq.size,
      trusselltrust,
    }),
  );
}

// GET /dashboard/most-requested-items/
export async function gfdashMostRequestedItems(c: Context<AppEnv>): Promise<Response> {
  return renderMostRequestedItems(c, false);
}

// GET /dashboard/trusselltrust/most-requested-items/
export async function gfdashTtMostRequestedItems(c: Context<AppEnv>): Promise<Response> {
  return renderMostRequestedItems(c, true);
}
