import type { Context } from "hono";
import { getCharityYearAggregates } from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { elapsedMs } from "../../middleware/serverTiming";

function pageContext(c: Context<AppEnv>) {
  return { ...buildPageContext({ path: c.req.path }), render_time_ms: elapsedMs(c) };
}

// gfdash `charity_income_expenditure` (views.py:437-446) -- `five_years_ago
// = date.today().year - 5`; Workers run in UTC (same reasoning as env.ts's
// `now()` global), so getUTCFullYear() matches Django's server-local
// date.today() closely enough for this "since year N" filter.
export async function gfdashCharityIncomeExpenditure(c: Context<AppEnv>): Promise<Response> {
  const sinceYear = new Date().getUTCFullYear() - 5;

  const session = dbSession(c);
  const years = await getCharityYearAggregates(session, sinceYear);

  return c.html(await render("dash/charity_income_expenditure.njk", { ...pageContext(c), years }));
}
