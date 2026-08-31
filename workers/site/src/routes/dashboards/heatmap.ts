import type { Context } from "hono";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { elapsedMs } from "../../middleware/serverTiming";

function pageContext(c: Context<AppEnv>) {
  return { ...buildPageContext({ path: c.req.path, appName: "gfdash" }), render_time_ms: elapsedMs(c) };
}

// gfdash `heatmap` (views.py:467-469) -- GET /dashboard/heatmap/. Fully
// static: no DB reads, the map's data comes from a client-side fetch of
// /needs/geo.json (unrelated existing endpoint, unchanged here).
export async function gfdashHeatmap(c: Context<AppEnv>): Promise<Response> {
  return c.html(await render("dash/heatmap.njk", pageContext(c)));
}
