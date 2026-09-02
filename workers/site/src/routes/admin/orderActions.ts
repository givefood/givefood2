import type { Context } from "hono";
import {
  d1Timestamp,
  deleteOrder,
  getFoodbankBySlug,
  getOrderDetail,
  getOrderLinesByWeight,
  recomputeFoodbankLastOrder,
  setOrderNotificationSent,
  type OrderEmailLineRow,
} from "@givefood/db";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { verifyCsrf } from "../../lib/csrf";
import { sendEmail } from "../../lib/email";

// gfadmin/views.py's three remaining Order mutations/views:
// order_delete (:524-528), order_send_notification (:494-521) and
// order_email (:2537-2551). The create/edit form lives in orderForm.ts.
//
// Three of Django's defects are FIXED here rather than ported, each noted
// at its own handler: order_delete has no @require_POST at all (a bare GET
// to the URL destroys an order); order_send_notification calls the full
// Order.save() just to stamp one timestamp, re-running the entire paid
// Gemini parse and regenerating every OrderLine; and order_email renders a
// template path that cannot resolve, so it 500s on every request.

const PACKAGING_WEIGHT_PC = 1.18; // givefood/const/general.py:136 -- same constant order.ts already uses

// Django's `|date:"l"` -- the full weekday name. packages/templates'
// DATE_FORMAT_TOKENS has D (abbreviated) but no `l`, so it is computed
// here and passed in as a plain string rather than widening a filter every
// other template shares.
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type OrderRow = NonNullable<Awaited<ReturnType<typeof getOrderDetail>>>;
type FoodbankRow = NonNullable<Awaited<ReturnType<typeof getFoodbankBySlug>>>;

// One shared context builder for the real send and the browser preview, so
// what the preview shows is byte-identical to what actually goes out --
// Django builds them in two places (views.py:503-504 and :2551) with the
// same context dict, which is the same idea expressed twice.
//
// Field sources, all from gfadmin/templates/admin/emails/order.txt|html:
//   phone   -> foodbank.delivery_phone_number or foodbank.phone_number  (:34/:45)
//   address -> foodbank.delivery_address, else address + postcode       (:38-39/:49-54)
function buildOrderEmailContext(order: OrderRow, foodbank: FoodbankRow, lines: OrderEmailLineRow[]): Record<string, unknown> {
  const deliveryDay = new Date(`${order.delivery_date}T00:00:00Z`);
  return {
    order: {
      order_id: order.order_id,
      delivery_provider: order.delivery_provider,
      delivery_provider_id: order.delivery_provider_id,
      source_url: order.source_url,
      delivery_date: order.delivery_date,
      delivery_hour: order.delivery_hour,
      // Order.delivery_hour_end() (models/orders.py:71-72) -- plain +1, so
      // a 22:00 slot renders as "22:00 and 23:00".
      delivery_hour_end: order.delivery_hour + 1,
      no_items: order.no_items,
      calories: order.calories,
      foodbank_name: foodbank.name,
      foodbank_slug: foodbank.slug,
      foodbank_shopping_list_url: foodbank.shopping_list_url,
      foodbank_phone_number: foodbank.delivery_phone_number || foodbank.phone_number,
      foodbank_delivery_address: foodbank.delivery_address,
      foodbank_address: foodbank.address,
      foodbank_postcode: foodbank.postcode,
    },
    delivery_day_name: Number.isNaN(deliveryDay.getTime()) ? "" : WEEKDAY_NAMES[deliveryDay.getUTCDay()],
    // `{{ order.weight_kg_pkg|floatformat:"0" }}` -- weight/1000 * 1.18,
    // zero decimal places.
    weight_kg_pkg_0dp: ((order.weight / 1000) * PACKAGING_WEIGHT_PC).toFixed(0),
    // The HTML table's `{{ line.weight_kg|floatformat:2 }}`. The text
    // version deliberately shows no weight at all -- the two bodies differ
    // in Django too, and both are kept as they are.
    lines: lines.map((line) => ({ name: line.name, quantity: line.quantity, weight_kg: ((line.weight ?? 0) / 1000).toFixed(2) })),
  };
}

async function loadOrderForEmail(c: Context<AppEnv>, db: ReturnType<typeof dbSession>): Promise<{ order: OrderRow; foodbank: FoodbankRow; lines: OrderEmailLineRow[] } | Response> {
  const orderId = c.req.param("orderId")!;
  const order = await getOrderDetail(db, orderId);
  if (!order) return c.notFound();
  // Every line of both email templates dereferences order.foodbank, so an
  // unassigned order has nothing to render. views.py:500-501 guards this
  // for the SEND path (a silent redirect, no message); order_email has no
  // guard at all and would raise an AttributeError chain -> 500.
  if (!order.foodbank_id || !order.foodbank_slug) return c.redirect(`/admin/order/${encodeURIComponent(order.order_id)}/`, 302);
  const foodbank = await getFoodbankBySlug(db, order.foodbank_slug);
  if (!foodbank) return c.notFound();
  const lines = await getOrderLinesByWeight(db, order.id);
  return { order, foodbank, lines };
}

// gfadmin/views.py:494-521 order_send_notification.
export async function adminOrderSendNotification(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);

  const body = await c.req.parseBody();
  const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
  if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

  const loaded = await loadOrderForEmail(c, db);
  if (loaded instanceof Response) return loaded;
  const { order, foodbank, lines } = loaded;

  const context = buildOrderEmailContext(order, foodbank, lines);
  const [textBody, htmlBody] = await Promise.all([render("admin/emails/order_text.njk", context), render("admin/emails/order.njk", context)]);

  const sent = await sendEmail(c, {
    to: foodbank.notification_email || foodbank.contact_email, // views.py:506-508
    cc: "deliveries@givefood.org.uk", // views.py:512
    subject: `Food donation from Give Food (${order.order_id})`, // views.py:513
    textBody,
    htmlBody,
  });

  // Django DISCARDS send_email()'s return value (views.py:510-516) and
  // stamps notification_email_sent regardless, so a Postmark outage leaves
  // a green "Sent" tick on an email that never left. lib/email.ts returns
  // the boolean specifically so callers can check it -- checked here, and
  // the stamp is skipped on a failure so the button can simply be pressed
  // again.
  if (!sent) return c.redirect(`/admin/order/${encodeURIComponent(order.order_id)}/?notificationfailed=true`, 302);

  // views.py:518-519 stamps the timestamp and then calls the FULL
  // order.save(), which re-runs the whole Gemini parse and deletes and
  // recreates every OrderLine -- a paid AI call and a data-churn risk on
  // every click of a button whose only job is to send an email, and at
  // temperature=1 the regenerated lines can differ from what was actually
  // ordered. A targeted UPDATE instead (setOrderNotificationSent), the
  // same fix already made for needAdmin's double-save.
  await setOrderNotificationSent(db, order.id, d1Timestamp());

  // views.py:520-521's `?donenotification=true`. Nothing reads that param
  // (grep confirms views.py:520 is its only mention anywhere); kept for
  // URL parity.
  return c.redirect(`/admin/order/${encodeURIComponent(order.order_id)}/?donenotification=true`, 302);
}

// gfadmin/views.py:2537-2551 order_email -- a browser preview of the
// notification bodies.
//
// BROKEN IN DJANGO: it renders "emails/order.%s", but the settings have
// TEMPLATES DIRS=[] with APP_DIRS=True and the only order email templates
// on disk are gfadmin/templates/admin/emails/order.txt|.html -- i.e. only
// resolvable as "admin/emails/order.*". Every request raises
// TemplateDoesNotExist -> 500. It is also linked from nowhere (grepping
// `order_email` across all .py/.html hits only views.py:2537 and
// urls/orders.py:11). Pointed at the real templates here so the preview
// works, and linked from the order page.
export async function adminOrderEmailPreview(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const loaded = await loadOrderForEmail(c, db);
  if (loaded instanceof Response) return loaded;
  const { order, foodbank, lines } = loaded;

  const context = buildOrderEmailContext(order, foodbank, lines);
  // views.py:2541-2549 -- "html" gets text/html, ANY other value (or none)
  // gets text/plain.
  if (c.req.query("format") === "html") return c.html(await render("admin/emails/order.njk", context));
  return c.text(await render("admin/emails/order_text.njk", context));
}

// gfadmin/views.py:524-528 order_delete.
//
// POST-ONLY and CSRF-verified, a deliberate fix: Django's view has no
// @require_POST (contrast order_send_notification at :494) and
// CsrfViewMiddleware is commented out in production (settings.py:97, see
// lib/csrf.ts:6-8), so a bare GET to /admin/order/<id>/delete/ -- a
// prefetching browser, a link checker, an <img src> on any page an admin
// visits -- destroys the order and all its lines.
export async function adminOrderDelete(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const orderId = c.req.param("orderId")!;

  const body = await c.req.parseBody();
  const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
  if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

  const order = await getOrderDetail(db, orderId);
  if (!order) return c.notFound();

  await deleteOrder(db, order.id); // orders.py:89-95 -- lines, then the order

  // NOT in Django: Order.delete() never recomputes foodbank.last_order, so
  // deleting a food bank's most recent order leaves it advertising a
  // delivery date it no longer has. See recomputeFoodbankLastOrder's own
  // comment.
  if (order.foodbank_id) await recomputeFoodbankLastOrder(db, order.foodbank_id);

  return c.redirect("/admin/", 302); // views.py:528 redirects to admin:index
}
