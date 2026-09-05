import type { Context } from "hono";
import { getDeliveryMonthCounts } from "@givefood/db";
import type { DeliveryMetric } from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { elapsedMs } from "../../middleware/serverTiming";

function pageContext(c: Context<AppEnv>) {
  return { ...buildPageContext({ path: c.req.path }), render_time_ms: elapsedMs(c) };
}

// gfdash/urls.py's `re_path(r'^deliveries/(count|items|weight|calories)/$',
// ...)` -- the regex enum 404s automatically for anything else; matched
// here with an explicit allowlist check before the metric ever reaches
// getDeliveryMonthCounts (which trusts it as a fixed-string SQL lookup).
const DELIVERY_METRICS: readonly DeliveryMetric[] = ["count", "items", "weight", "calories"];

// views.py:394-421 -- metric_text strings verbatim.
const METRIC_TEXT: Record<DeliveryMetric, string> = {
  count: "Number of deliveries",
  items: "Items",
  weight: "Weight kg",
  calories: "Calories",
};

function isDeliveryMetric(value: string): value is DeliveryMetric {
  return (DELIVERY_METRICS as readonly string[]).includes(value);
}

// gfdash `deliveries` (views.py:394-421).
export async function gfdashDeliveries(c: Context<AppEnv>): Promise<Response> {
  const metric = c.req.param("metric") ?? "";
  if (!isDeliveryMetric(metric)) {
    return c.notFound();
  }

  const session = dbSession(c);
  const months = await getDeliveryMonthCounts(session, metric);
  const metricText = METRIC_TEXT[metric];

  return c.html(
    await render("dash/deliveries.njk", {
      ...pageContext(c),
      metric,
      metric_text: metricText,
      months,
    }),
  );
}
