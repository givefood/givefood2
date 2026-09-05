import type { Context } from "hono";
import { getNeedItemCategoryCounts } from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { elapsedMs } from "../../middleware/serverTiming";

function pageContext(c: Context<AppEnv>) {
  return { ...buildPageContext({ path: c.req.path }), render_time_ms: elapsedMs(c) };
}

// gfdash `item_categories` (views.py:198-206) -- getNeedItemCategoryCounts
// already returns [{category, count}] grouped/sorted by count desc.
// chart_data_json is built server-side (JSON.stringify) rather than
// interpolating category names into a hand-built JS array literal in the
// template -- the Django template's own `name: "{{ x|safe }}"` pattern
// only skips HTML-escaping, not JS-string escaping, so a category
// containing a `"` or `</script>` would break or inject into the page;
// JSON.stringify escapes correctly for both.
// GET /dashboard/item-categories/
export async function gfdashItemCategories(c: Context<AppEnv>): Promise<Response> {
  const session = dbSession(c);
  const categories = await getNeedItemCategoryCounts(session);
  const chartData = categories.map((row) => ({ value: row.count, name: row.category }));
  return c.html(
    await render("dash/item_categories.njk", { ...pageContext(c), categories, chart_data_json: JSON.stringify(chartData) }),
  );
}
