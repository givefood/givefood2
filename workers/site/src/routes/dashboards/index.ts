import type { Context } from "hono";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { elapsedMs } from "../../middleware/serverTiming";

function pageContext(c: Context<AppEnv>) {
  return { ...buildPageContext({ path: c.req.path, appName: "gfdash" }), render_time_ms: elapsedMs(c) };
}

// gfdash `index` (views.py:21-23) -- fully static, no DB reads at all: a
// list of links to every other dashboard.
export async function gfdashIndex(c: Context<AppEnv>): Promise<Response> {
  return c.html(await render("dash/index.njk", pageContext(c)));
}
