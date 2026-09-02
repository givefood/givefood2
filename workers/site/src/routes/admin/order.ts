import type { Context } from "hono";
import { getOrderDetail, getOrderLines, getAdminJob } from "@givefood/db";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { adminPageContext } from "./pageContext";
import { timesince } from "../../lib/timesince";

const PACKAGING_WEIGHT_PC = 1.18; // givefood/const/general.py:136 -- same constant used elsewhere in this admin

const DELIVERY_PROVIDER_ORDER_URL: Record<string, (id: string) => string> = {
  Tesco: (id) => `https://www.tesco.com/groceries/en-GB/orders/${id}`,
  "Sainsbury's": (id) => `https://www.sainsburys.co.uk/gol-ui/my-account/orders/${id}`,
};

// gfadmin/views.py:445-452 order() -- see orderAdmin.ts's own comment for
// exactly what's deliberately left out (edit/delete/send-notification/
// order-group).
export async function adminOrderDetail(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const orderId = c.req.param("orderId")!;
  const order = await getOrderDetail(db, orderId);
  if (!order) return c.notFound();

  const lines = await getOrderLines(db, order.id);
  const jobId = c.req.query("job") ?? null;
  const job = jobId ? await getAdminJob(db, jobId) : null;
  const weightKg = order.weight / 1000;
  const deliveryProviderUrl = order.delivery_provider && order.delivery_provider_id ? DELIVERY_PROVIDER_ORDER_URL[order.delivery_provider]?.(order.delivery_provider_id) : null;

  const html = await render("admin/order.njk", {
    ...(await adminPageContext(c, "orders")),
    order,
    lines,
    weight_kg: weightKg.toFixed(2),
    weight_kg_pkg: (weightKg * PACKAGING_WEIGHT_PC).toFixed(2),
    cost: (order.cost / 100).toFixed(2),
    actual_cost: order.actual_cost ? (order.actual_cost / 100).toFixed(2) : null,
    delivery_provider_url: deliveryProviderUrl,
    notification_email_sent_timesince: order.notification_email_sent ? `${timesince(order.notification_email_sent)} ago` : null,
    // routes/admin/orderForm.ts redirects here with ?job=<id> after a save.
    // The order's lines and aggregates are produced by a queue job
    // (workers/jobs/src/adminJobs/orderLines.ts), so without this the page
    // shows a just-saved order as 0 items / £0.00 and looks like the save
    // threw the data away. The id is only ever used to look a row up by
    // primary key, so an unknown or malformed one simply yields null.
    job_id: jobId,
    job_status: job?.status ?? null,
    job_error: job?.error ?? null,
  });
  return c.html(html);
}
