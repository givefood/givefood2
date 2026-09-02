import type { Context } from "hono";
import { getOrderDetail, getOrderLines } from "@givefood/db";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { adminPageContext } from "./pageContext";

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
  });
  return c.html(html);
}
