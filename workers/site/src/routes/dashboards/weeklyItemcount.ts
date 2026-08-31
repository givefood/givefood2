import type { Context } from "hono";
import { getPublishedNeedsForWeeklyCount } from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { elapsedMs } from "../../middleware/serverTiming";
import { noItems } from "../../lib/fields";
import { parseD1Timestamp, weekKey } from "../../lib/isoWeek";

function pageContext(c: Context<AppEnv>) {
  return { ...buildPageContext({ path: c.req.path, appName: "gfdash" }), render_time_ms: elapsedMs(c) };
}

interface WeekCount {
  week: string;
  count: number;
}

// gfdash `weekly_itemcount` (views.py:26-43) -- `week_needs` is an
// OrderedDict keyed by "year-week" (Django's `need.created.isocalendar()[1]`
// week number and `need.created.year` plain calendar year -- see
// lib/isoWeek.ts's weekKey() for the deliberate quirk near year
// boundaries), accumulating `no_items()` per published need in
// created-ascending order. getPublishedNeedsForWeeklyCount(session) already
// returns rows ordered by created ascending, and a JS Map preserves
// insertion order the same way an OrderedDict does.
export async function gfdashWeeklyItemcount(c: Context<AppEnv>): Promise<Response> {
  const session = dbSession(c);
  const rows = await getPublishedNeedsForWeeklyCount(session);

  const weekNeeds = new Map<string, number>();
  for (const row of rows) {
    const key = weekKey(parseD1Timestamp(row.created));
    weekNeeds.set(key, (weekNeeds.get(key) ?? 0) + noItems(row.change_text));
  }

  const weekNeedsItems: WeekCount[] = Array.from(weekNeeds, ([week, count]) => ({ week, count }));

  return c.html(
    await render("dash/weekly_itemcount.njk", {
      ...pageContext(c),
      week_needs_items: weekNeedsItems,
      week_needs_items_desc: weekNeedsItems.slice().reverse(),
    }),
  );
}
