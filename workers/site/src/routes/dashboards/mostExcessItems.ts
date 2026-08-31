import type { Context } from "hono";
import { getLatestExcessTextsSince } from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { elapsedMs } from "../../middleware/serverTiming";

function pageContext(c: Context<AppEnv>) {
  return { ...buildPageContext({ path: c.req.path, appName: "gfdash" }), render_time_ms: elapsedMs(c) };
}

// gfdash `most_excess_items` (views.py:146-195) -- same allowed-days gate
// as most_requested_items, but no trusselltrust variant and no
// invalid-text exclusion list: a row only counts at all when
// excess_change_text is truthy (Python's `if excess_text:`), everything
// else that comes through is counted, no keyword special-casing.
const ALLOWED_DAYS = [7, 30, 60, 90, 120, 365];
const DEFAULT_DAYS = 30;
const MS_PER_DAY = 86_400_000;

interface ItemCount {
  item: string;
  count: number;
}

// Same D1 text-timestamp comparison as mostRequestedItems.ts's sinceIso --
// see that file's comment for why the fractional-second width doesn't
// need to match.
function sinceIso(days: number, now: Date): string {
  return new Date(now.getTime() - days * MS_PER_DAY).toISOString().slice(0, 19).replace("T", " ");
}

// GET /dashboard/most-excess-items/
export async function gfdashMostExcessItems(c: Context<AppEnv>): Promise<Response> {
  const daysParam = c.req.query("days") ?? String(DEFAULT_DAYS);
  const days = Number(daysParam);
  if (!ALLOWED_DAYS.includes(days)) {
    return new Response("", { status: 403 });
  }

  const session = dbSession(c);
  const rows = await getLatestExcessTextsSince(session, sinceIso(days, new Date()));

  const items: string[] = [];
  let numberFoodbanks = 0;

  for (const row of rows) {
    if (row.excess_change_text) {
      items.push(...row.excess_change_text.split("\n"));
      numberFoodbanks += 1;
    }
  }

  // group_list() -- see mostRequestedItems.ts's identical comment on the
  // Map + stable-sort pairing reproducing Python's Counter + sorted(reverse=True).
  const itemsFreq = new Map<string, number>();
  for (const item of items) {
    itemsFreq.set(item, (itemsFreq.get(item) ?? 0) + 1);
  }
  const itemsSorted: ItemCount[] = Array.from(itemsFreq.entries())
    .map(([item, count]) => ({ item, count }))
    .sort((a, b) => b.count - a.count);

  return c.html(
    await render("dash/most_excess_items.njk", {
      ...pageContext(c),
      items_sorted: itemsSorted,
      allowed_days: ALLOWED_DAYS,
      days,
      number_foodbanks: numberFoodbanks,
      number_items: itemsFreq.size,
    }),
  );
}
