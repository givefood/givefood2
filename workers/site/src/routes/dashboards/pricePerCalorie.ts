import type { Context } from "hono";
import { getPricePerCalorieByMonth, getOrderCalorieTotals } from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { elapsedMs } from "../../middleware/serverTiming";

function pageContext(c: Context<AppEnv>) {
  return { ...buildPageContext({ path: c.req.path }), render_time_ms: elapsedMs(c) };
}

// Django's `|date:"F"` full month name lookup -- same reasoning as
// pricePerKg.ts's own copy (MonthCaloriePriceRow.month is a plain 1-12
// number, no nested date object to call .strftime-ish filters on).
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// gfdash `price_per_calorie` (views.py:531-558) -- GET /dashboard/price-per/calorie/.
export async function gfdashPricePerCalorie(c: Context<AppEnv>): Promise<Response> {
  const session = dbSession(c);
  const months = await getPricePerCalorieByMonth(session);
  const totals = await getOrderCalorieTotals(session);
  const firstMonth = months[0];

  return c.html(
    await render("dash/price_per_calorie.njk", {
      ...pageContext(c),
      months,
      items: totals.items,
      calories: totals.calories,
      number_foodbanks: totals.numberFoodbanks,
      first_month_name: firstMonth ? MONTH_NAMES[firstMonth.month - 1] : "",
      first_month_year: firstMonth ? firstMonth.year : "",
    }),
  );
}
