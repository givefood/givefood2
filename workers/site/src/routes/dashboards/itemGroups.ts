import type { Context } from "hono";
import { getNeedItemGroupCounts } from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { elapsedMs } from "../../middleware/serverTiming";

function pageContext(c: Context<AppEnv>) {
  return { ...buildPageContext({ path: c.req.path }), render_time_ms: elapsedMs(c) };
}

// gfdash `item_groups` (views.py:209-217) -- getNeedItemGroupCounts already
// returns [{group_name, count}] grouped/sorted by count desc. Same
// server-side JSON.stringify chart_data_json as itemCategories.ts (see its
// comment) -- avoids the unescaped-JS-string-literal issue the Django
// template's own `|safe` pattern has.
// GET /dashboard/item-groups/
export async function gfdashItemGroups(c: Context<AppEnv>): Promise<Response> {
  const session = dbSession(c);
  const groups = await getNeedItemGroupCounts(session);
  const chartData = groups.map((row) => ({ value: row.count, name: row.group_name }));
  return c.html(
    await render("dash/item_groups.njk", { ...pageContext(c), groups, chart_data_json: JSON.stringify(chartData) }),
  );
}
