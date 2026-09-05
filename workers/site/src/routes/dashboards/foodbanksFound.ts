import type { Context } from "hono";
import { getFoodbankCreatedDates } from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { elapsedMs } from "../../middleware/serverTiming";

function pageContext(c: Context<AppEnv>) {
  return { ...buildPageContext({ path: c.req.path }), render_time_ms: elapsedMs(c) };
}

interface MonthCount {
  month: string;
  count: number;
}

// gfdash `foodbanks_found` (views.py:347-362) -- `created_months[date.
// strftime("%Y-%m")] = created_dates.index(date) + 1` for each date in the
// (already sorted-ascending) list: a later date in the same month
// overwrites the earlier entry, so each month key ends up holding the
// CUMULATIVE count as of the last food bank found that month.
// getFoodbankCreatedDates(session) returns D1's `created` ("YYYY-MM-DD
// HH:MM:SS...") already sorted ascending by SQL, so the month key is just
// the first 7 characters and the "index" is the loop position (1-based) --
// a JS Map reproduces the OrderedDict overwrite-on-same-key behaviour the
// same way.
export async function gfdashFoodbanksFound(c: Context<AppEnv>): Promise<Response> {
  const session = dbSession(c);
  const createdDates = await getFoodbankCreatedDates(session);

  const createdMonths = new Map<string, number>();
  createdDates.forEach((created, index) => {
    createdMonths.set(created.slice(0, 7), index + 1);
  });

  const createdMonthsItems: MonthCount[] = Array.from(createdMonths, ([month, count]) => ({ month, count }));

  return c.html(
    await render("dash/foodbanks_found.njk", {
      ...pageContext(c),
      created_months_items: createdMonthsItems,
      created_months_items_desc: createdMonthsItems.slice().reverse(),
    }),
  );
}
