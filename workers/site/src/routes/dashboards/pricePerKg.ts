import type { Context } from "hono";
import { getPricePerKgByMonth, getOrderWeightTotals } from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { elapsedMs } from "../../middleware/serverTiming";

function pageContext(c: Context<AppEnv>) {
  return { ...buildPageContext({ path: c.req.path, appName: "gfdash" }), render_time_ms: elapsedMs(c) };
}

// Django's `|date:"F"` full month name lookup -- MonthPriceRow.month is
// already a plain 1-12 number (not Django's nested TruncMonth date-object
// shape), so the name lookup happens here instead of in the template.
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

// gfdash `price_per_kg` (views.py:449-464) -- GET /dashboard/price-per/kg/.
export async function gfdashPricePerKg(c: Context<AppEnv>): Promise<Response> {
  const session = dbSession(c);
  const months = await getPricePerKgByMonth(session);
  const totals = await getOrderWeightTotals(session);
  const firstMonth = months[0];

  return c.html(
    await render("dash/price_per_kg.njk", {
      ...pageContext(c),
      months,
      items: totals.items,
      // Django's `{{ weight|floatformat:2|intcomma }}` -- toFixed(2) here
      // (no floatformat filter equivalent), the resulting string still goes
      // through the template's own `|intcomma` filter, matching the
      // two-filter pipeline exactly (intcomma's regex only ever touches the
      // digits before a decimal point, so a "1234.50"-shaped string comes
      // out "1,234.50", same as Django's).
      weight_tonnes: totals.weightTonnes.toFixed(2),
      number_foodbanks: totals.numberFoodbanks,
      first_month_name: firstMonth ? MONTH_NAMES[firstMonth.month - 1] : "",
      first_month_year: firstMonth ? firstMonth.year : "",
    }),
  );
}
