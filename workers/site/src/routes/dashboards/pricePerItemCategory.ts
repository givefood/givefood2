import type { Context } from "hono";
import { getOrderLineCategoryMonthPrices, getOrderLineCategoryTotals } from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { elapsedMs } from "../../middleware/serverTiming";

function pageContext(c: Context<AppEnv>) {
  return { ...buildPageContext({ path: c.req.path }), render_time_ms: elapsedMs(c) };
}

// Mirrors @givefood/db's MIN_ITEMS_FOR_CATEGORY (dashboards.ts) -- only
// used here for the intro paragraph's "more than N items" text, matching
// views.py:475's local MIN_ITEMS_FOR_CATEGORY = 100. Keep in sync with the
// db package's own constant if that ever changes.
const MIN_ITEMS_FOR_CATEGORY = 100;

// gfdash `price_per_item_category` (views.py:472-528) -- GET
// /dashboard/price-per/item-category/. Two-stage query: stage 1 gets the
// qualifying category names (>=100 items, sorted desc); stage 2 gets every
// (month, category) price point for just those categories. The reshape
// below -- collect all months seen, then build one aligned, 0-filled price
// array per category -- is a direct port of views.py:500-517's Python loop.
export async function gfdashPricePerItemCategory(c: Context<AppEnv>): Promise<Response> {
  const session = dbSession(c);
  const categoryTotals = await getOrderLineCategoryTotals(session);
  const categoryNames = categoryTotals.map((row) => row.category);
  const monthPrices = await getOrderLineCategoryMonthPrices(session, categoryNames);

  const allMonths = new Set<string>();
  const categoriesData: Record<string, Record<string, number>> = {};
  for (const row of monthPrices) {
    allMonths.add(row.the_month);
    if (!categoriesData[row.category]) categoriesData[row.category] = {};
    categoriesData[row.category]![row.the_month] = row.price_per_item;
  }
  const allMonthsSorted = [...allMonths].sort();

  const categoriesAligned: Record<string, number[]> = {};
  for (const cat of Object.keys(categoriesData)) {
    categoriesAligned[cat] = allMonthsSorted.map((month) => categoriesData[cat]![month] ?? 0);
  }

  return c.html(
    await render("dash/price_per_item_category.njk", {
      ...pageContext(c),
      categories_data: JSON.stringify(categoriesAligned),
      months_json: JSON.stringify(allMonthsSorted),
      category_names: categoryNames,
      min_items: MIN_ITEMS_FOR_CATEGORY,
    }),
  );
}
