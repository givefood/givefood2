import type { Session } from "./types";

// gfadmin/views.py:445-452 order() -- a plain read-only GET view/template
// (admin/order.html). Django's page also links to order_edit/order_delete/
// order_send_notification, all left out here: those are real mutations on
// an object whose own save() is Gemini-driven for edits (WP 6.5b's already-
// disclosed reason for deferring Order/OrderItem/OrderGroup forms
// entirely), and delete/notification-send are the same category of new
// write surface this pass isn't adding. order_group is also skipped: no
// `ordergroup` D1 table exists yet (same WP 6.5b gap).
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
  created: string;
  modified: string;
}

export async function getOrderDetail(session: Session, orderId: string): Promise<OrderDetailRow | null> {
  return session
    .prepare(
      `SELECT o.id, o.order_id, o.foodbank_id, f.name AS foodbank_name, f.slug AS foodbank_slug,
              o.need_id, n.need_id AS need_id_str, n.change_text AS need_change_text, n.created AS need_created, n.uri AS need_uri,
              o.delivery_date, o.delivery_hour, o.no_items, o.no_lines, o.weight, o.calories, o.cost, o.actual_cost,
              o.source_url, o.delivery_provider, o.delivery_provider_id, o.notification_email_sent, o.created, o.modified
       FROM orders o
       LEFT JOIN foodbank f ON f.id = o.foodbank_id
       LEFT JOIN foodbankchange n ON n.id = o.need_id
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

export async function getOrderLines(session: Session, orderRowId: number): Promise<OrderLineRow[]> {
  const result = await session.prepare("SELECT name, quantity, weight, calories FROM orderline WHERE order_id = ? ORDER BY id").bind(orderRowId).all<OrderLineRow>();
  return result.results;
}
