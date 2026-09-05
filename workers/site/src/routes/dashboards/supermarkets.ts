import type { Context } from "hono";
import { getSupermarketDonationPointCounts, getSupermarketDonationPointTotal } from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { elapsedMs } from "../../middleware/serverTiming";

function pageContext(c: Context<AppEnv>) {
  return { ...buildPageContext({ path: c.req.path }), render_time_ms: elapsedMs(c) };
}

// gfdash `supermarkets` (views.py:424-434) -- donation point counts grouped
// by company, plus the unfiltered-grouping total.
export async function gfdashSupermarkets(c: Context<AppEnv>): Promise<Response> {
  const session = dbSession(c);

  const [supermarkets, supermarketTotal] = await Promise.all([
    getSupermarketDonationPointCounts(session),
    getSupermarketDonationPointTotal(session),
  ]);
  // Server-side JSON.stringify chart_data_json, same as itemCategories.ts/
  // itemGroups.ts -- avoids the unescaped-JS-string-literal issue the
  // Django template's own `name: "{{ x|safe }}"` pattern has.
  const chartData = supermarkets.map((row) => ({ value: row.count, name: row.company }));

  return c.html(
    await render("dash/supermarkets.njk", {
      ...pageContext(c),
      supermarkets,
      supermarket_total: supermarketTotal,
      chart_data_json: JSON.stringify(chartData),
    }),
  );
}
