import type { Context } from "hono";
import { getPublishedNeedsForWeeklyCount } from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { elapsedMs } from "../../middleware/serverTiming";
import { noItems } from "@givefood/models";
import { parseD1Timestamp, weekKey } from "../../lib/isoWeek";

function pageContext(c: Context<AppEnv>) {
  return { ...buildPageContext({ path: c.req.path }), render_time_ms: elapsedMs(c) };
}

interface WeekCount {
  week: string;
  count: number;
}

interface WeekYearRow {
  week: number;
  years: { year: number; count: number }[];
}

const START_YEAR = 2020;
const MAX_WEEK = 53; // views.py:56 -- `weeks = range(1,54)`

// gfdash `weekly_itemcount_year` (views.py:46-80) -- same `week_needs`
// build as `weekly_itemcount` (see weeklyItemcount.ts's own comment), plus
// `week_year_needs`: for week 1..53, for each year from 2020 to the
// current UTC year (Workers run in UTC, same reasoning as env.ts's now()
// global and charityIncomeExpenditure.ts's five-years-ago cutoff),
// `week_needs.get("${year}-${week}", 0)`. Nunjucks has no Python
// dict.items(), so both this file and its template restructure the nested
// dict-of-dicts into arrays of {week, years: [{year, count}]} objects --
// the chart <script> block's inline JS arrays are rebuilt from that same
// shape rather than Django's `week.0`/`week.1.items` dict access.
export async function gfdashWeeklyItemcountYear(c: Context<AppEnv>): Promise<Response> {
  const session = dbSession(c);
  const rows = await getPublishedNeedsForWeeklyCount(session);

  const weekNeeds = new Map<string, number>();
  for (const row of rows) {
    const key = weekKey(parseD1Timestamp(row.created));
    // An unreadable timestamp is skipped, not bucketed: see weekKey().
    if (key === null) continue;
    weekNeeds.set(key, (weekNeeds.get(key) ?? 0) + noItems(row.change_text));
  }

  const weekNeedsItems: WeekCount[] = Array.from(weekNeeds, ([week, count]) => ({ week, count }));

  const currentYear = new Date().getUTCFullYear();
  const years: number[] = [];
  for (let year = START_YEAR; year <= currentYear; year++) years.push(year);

  const weekYearNeeds: WeekYearRow[] = [];
  for (let week = 1; week <= MAX_WEEK; week++) {
    weekYearNeeds.push({
      week,
      years: years.map((year) => ({ year, count: weekNeeds.get(`${year}-${week}`) ?? 0 })),
    });
  }

  return c.html(
    await render("dash/weekly_itemcount_year.njk", {
      ...pageContext(c),
      years,
      week_year_needs: weekYearNeeds,
      week_needs_items_desc: weekNeedsItems.slice().reverse(),
    }),
  );
}
