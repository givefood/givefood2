import type { Session } from "./types";

// gfadmin/views.py:445-452 order() -- a plain read-only GET view/template
// (admin/order.html). The edit/delete/send-notification actions this comment
// used to list as deferred have since been ported (routes/admin/index.ts
// registers them all), and the `ordergroup` table now exists (migration
// 0015), so the Order group row of admin/order.html:45-48 is joined below.
export interface OrderDetailRow {
  id: number;
  order_id: string;
  foodbank_id: number | null;
  foodbank_name: string | null;
  foodbank_slug: string | null;
  need_id: number | null;
  need_id_str: string | null;
  need_change_text: string | null;
  need_created: string | null;
  need_uri: string | null;
  delivery_date: string;
  delivery_hour: number;
  no_items: number;
  no_lines: number;
  weight: number;
  calories: number;
  cost: number;
  actual_cost: number | null;
  source_url: string | null;
  delivery_provider: string | null;
  delivery_provider_id: string | null;
  notification_email_sent: string | null;
  // admin/order.html:45-48 renders {{ order.order_group }}, i.e.
  // OrderGroup.__str__ = name (givefood/models/orders.py:329-330).
  order_group_name: string | null;
  order_group_slug: string | null;
  created: string;
  modified: string;
}

export async function getOrderDetail(session: Session, orderId: string): Promise<OrderDetailRow | null> {
  return session
    .prepare(
      `SELECT o.id, o.order_id, o.foodbank_id, f.name AS foodbank_name, f.slug AS foodbank_slug,
              o.need_id, n.need_id AS need_id_str, n.change_text AS need_change_text, n.created AS need_created, n.uri AS need_uri,
              o.delivery_date, o.delivery_hour, o.no_items, o.no_lines, o.weight, o.calories, o.cost, o.actual_cost,
              o.source_url, o.delivery_provider, o.delivery_provider_id, o.notification_email_sent,
              og.name AS order_group_name, og.slug AS order_group_slug,
              o.created, o.modified
       FROM orders o
       LEFT JOIN foodbank f ON f.id = o.foodbank_id
       LEFT JOIN foodbankchange n ON n.id = o.need_id
       LEFT JOIN ordergroup og ON og.id = o.order_group_id
       WHERE o.order_id = ?`,
    )
    .bind(orderId)
    .first<OrderDetailRow>();
}

export interface OrderLineRow {
  name: string;
  quantity: number;
  weight: number | null;
  calories: number | null;
}

// Order.lines() is `OrderLine.objects.filter(order=self).order_by("-weight")`
// (givefood/models/orders.py:227-228), which is what admin/order.html:119
// iterates -- heaviest first, the same ordering orderWrite.ts's
// getOrderLinesByWeight uses for the notification email. `id` is a stable
// tiebreak so two equal weights don't reorder between renders.
export async function getOrderLines(session: Session, orderRowId: number): Promise<OrderLineRow[]> {
  const result = await session
    .prepare("SELECT name, quantity, weight, calories FROM orderline WHERE order_id = ? ORDER BY weight DESC, id")
    .bind(orderRowId)
    .all<OrderLineRow>();
  return result.results;
}
