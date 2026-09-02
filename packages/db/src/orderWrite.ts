import type { Session } from "./types";
import { sortByName } from "./types";

// WP 6.5b: the WRITE side of Order/OrderLine -- everything orderAdmin.ts's
// own header comment deferred ("real mutations on an object whose own
// save() is Gemini-driven"). That reason no longer holds: WP 6.8 built the
// admin_job enqueue/poll machinery (migrations/0013_admin_jobs.sql,
// adminJobs.ts, workers/jobs' "jobs" queue consumer) precisely so
// AI-driven admin work can run OUTSIDE a request, and 0014_orderitem.sql /
// 0015_ordergroup.sql created the two tables that were missing. So the
// split here is:
//
//   site Worker  -> validates the form, writes the `orders` row, enqueues
//                   an "order-lines" admin_job (this file)
//   jobs Worker  -> Gemini-parses items_text into orderline rows and
//                   writes back the five aggregates (this file too --
//                   getOrderForLineParse/insertOrderLines/
//                   setOrderAggregates/getOrderItemCalories/
//                   getLatest*Category are the job's own queries)
//
// Django does all of it inside one synchronous Order.save()
// (givefood/models/orders.py:97-225): 1 Gemini JSON call + up to N Gemini
// text calls + two order writes + N line writes, with the admin's browser
// tab holding the connection open throughout. That does not fit a
// request-scoped Worker and does not need to.
//
// GEMINI_API_KEY is bound ONLY to workers/jobs (workers/jobs/
// wrangler.jsonc), never to workers/site -- PLAN.md 3.1's secret-blast-
// radius reason for having two Workers at all. Nothing in this file's
// site-side half calls an AI.

// D1 timestamp format. tools/pg-to-d1/extract_core.py:307-315 wrote every
// migrated datetime as "YYYY-MM-DD HH:MM:SS.ffffff" (space-separated, six
// fractional digits, UTC), and `orders.created` and `orders.delivery_
// datetime` are both sorted on directly against those migrated rows
// (adminLists.ts's getOrdersPage `ORDER BY o.<sort> DESC` and
// getAllOrdersForCsv's `ORDER BY o.created DESC`, plus
// order_delivery_datetime_idx). A `new Date().toISOString()` value --
// which is what every other admin write path in this package uses, and
// correctly so for columns nothing sorts against migrated data -- differs
// from that at byte 11 ("T" 0x54 vs " " 0x20) and in its fractional
// precision, so a new row would sort inconsistently with the migrated ones
// it sits next to. Written in the migrated shape here instead. Both forms
// parse fine on the read side (workers/site/src/lib/timesince.ts's
// parseUtc and templates' djangoDate both accept either).
export function d1Timestamp(date: Date = new Date()): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const micros = pad(date.getUTCMilliseconds(), 3) + "000";
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${micros}`
  );
}

// Django's `datetime(delivery_date.year, .month, .day, delivery_hour, 0)`
// (models/orders.py:110-116), naive under USE_TZ=False / TIME_ZONE="UTC" --
// so a plain string build, not a Date round-trip.
export function deliveryDatetime(deliveryDate: string, deliveryHour: number): string {
  return `${deliveryDate} ${String(deliveryHour).padStart(2, "0")}:00:00.000000`;
}

// Django's django.utils.text.slugify, same local copy as
// donationPointsAdmin.ts:14-26 (duplicated rather than shared, matching
// this package's established small-helper precedent). Order.save() calls
// it on delivery_provider, so the two cases that matter here are
// "Sainsbury's" -> "sainsburys" and Python's slugify(None) -> str(None) ->
// "none".
const COMBINING_MARKS_RE = new RegExp(`[${String.fromCodePoint(0x0300)}-${String.fromCodePoint(0x036f)}]`, "g");

export function slugifyProvider(value: string | null): string {
  // models/orders.py:107 passes delivery_provider straight to slugify(),
  // and Django's slugify() str()s its argument first -- so a NULL provider
  // becomes the literal "none" in the order_id, not an empty segment.
  const raw = value ?? "None";
  const ascii = raw.normalize("NFKD").replace(COMBINING_MARKS_RE, "").replace(/[^\x00-\x7F]/g, "");
  return ascii
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/[-\s]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

// ---------------------------------------------------------------------------
// Form option sources
// ---------------------------------------------------------------------------

export interface FoodbankOptionRow {
  id: number;
  name: string;
  slug: string;
  country: string;
  is_closed: number;
}

// givefood/forms.py:190 -- OrderForm.foodbank's queryset is
// Foodbank.objects.filter(is_closed=False).order_by('name'). Ordered in JS
// via sortByName rather than in SQL, per types.ts's collation note (D1's
// byte-wise default collation reorders mixed-case names against the source
// Postgres en_US.utf8 ordering).
export async function getOpenFoodbankOptions(session: Session): Promise<FoodbankOptionRow[]> {
  const result = await session.prepare("SELECT id, name, slug, country, is_closed FROM foodbank WHERE is_closed = 0").all<FoodbankOptionRow>();
  return sortByName(result.results);
}

// NOT a port -- a fix. Django's queryset above EXCLUDES closed food banks,
// so opening the edit form for an order whose food bank has since closed
// renders a <select> that doesn't contain the current selection; the
// browser then submits the empty option and re-saving silently UNASSIGNS
// the order (and, via Order.save():102-107, renames it). Fetched
// separately here and appended to the option list so the existing choice
// survives a round trip. A *newly chosen* closed food bank is still
// rejected -- see routes/admin/orderForm.ts's POST validation.
export async function getFoodbankOptionById(session: Session, id: number): Promise<FoodbankOptionRow | null> {
  return session.prepare("SELECT id, name, slug, country, is_closed FROM foodbank WHERE id = ?").bind(id).first<FoodbankOptionRow>();
}

export interface NeedOptionRow {
  id: number;
  need_id: string;
  foodbank_name: string | null;
  created: string;
}

// givefood/forms.py:191/207-210 -- OrderForm.need's queryset is
// FoodbankChange filtered to the selected food bank, ordered by -created;
// with no food bank selected Django renders EVERY FoodbankChange row
// (33,931 in production, PLAN.md 2974) into one <select>. Capped at
// `limit` here -- a documented deviation, not a port: a megabyte of
// <option> tags helps nobody and D1 meters rows scanned. The form tells
// the user when the list was capped.
export async function getNeedOptionsForFoodbank(session: Session, foodbankId: number | null, limit = 200): Promise<NeedOptionRow[]> {
  const sql =
    foodbankId === null
      ? "SELECT id, need_id, foodbank_name, created FROM foodbankchange ORDER BY created DESC LIMIT ?"
      : "SELECT id, need_id, foodbank_name, created FROM foodbankchange WHERE foodbank_id = ? ORDER BY created DESC LIMIT ?";
  const statement = foodbankId === null ? session.prepare(sql).bind(limit) : session.prepare(sql).bind(foodbankId, limit);
  const result = await statement.all<NeedOptionRow>();
  return result.results;
}

export interface OrderGroupOptionRow {
  id: number;
  name: string;
  slug: string;
}

// givefood/models/orders.py:314-333 OrderGroup, table created by
// 0015_ordergroup.sql. Django's auto-generated ModelChoiceField uses the
// full unfiltered queryset in the model's default (unordered) order and
// labels each option with OrderGroup.__str__ = name (orders.py:329-330);
// sorted by name here for the same collation reason as the food bank list.
export async function getOrderGroupOptions(session: Session): Promise<OrderGroupOptionRow[]> {
  const result = await session.prepare("SELECT id, name, slug FROM ordergroup").all<OrderGroupOptionRow>();
  return sortByName(result.results);
}

// Order.Meta.unique_together = ('foodbank','delivery_date',
// 'delivery_provider') (models/orders.py:57). Django's ModelForm enforces
// this and reports "Order with this Foodbank, Delivery date and Delivery
// provider already exists." as a non-field error; there is no ModelForm
// here, so it is an explicit query.
//
// SQL treats NULLs as distinct, so this can only ever fire for an ASSIGNED
// order -- which orders.py:54-56 says is intentional ("multiple unassigned
// orders with the same delivery_date and delivery_provider are
// permitted"). Returns null immediately for a null foodbankId rather than
// writing a query whose NULL comparisons would never match anyway.
export async function findConflictingOrder(
  session: Session,
  params: { foodbankId: number | null; deliveryDate: string; deliveryProvider: string | null; excludeId?: number },
): Promise<{ id: number; order_id: string } | null> {
  if (params.foodbankId === null) return null;
  const providerClause = params.deliveryProvider === null ? "delivery_provider IS NULL" : "delivery_provider = ?";
  const binds: (string | number)[] = [params.foodbankId, params.deliveryDate];
  if (params.deliveryProvider !== null) binds.push(params.deliveryProvider);
  let sql = `SELECT id, order_id FROM orders WHERE foodbank_id = ? AND delivery_date = ? AND ${providerClause}`;
  if (params.excludeId !== undefined) {
    sql += " AND id != ?";
    binds.push(params.excludeId);
  }
  return session
    .prepare(`${sql} LIMIT 1`)
    .bind(...binds)
    .first<{ id: number; order_id: string }>();
}

// ---------------------------------------------------------------------------
// The order row itself
// ---------------------------------------------------------------------------

// orderAdmin.ts's getOrderDetail is shaped for the read-only detail page
// and carries neither `items_text` (the whole content of the form's main
// field) nor `order_group_id`. This is the form's own read: exactly the
// editable columns of givefood/forms.py's OrderForm, plus the row id.
// `id` is the primary key; `order_id` is the human-readable string the URL
// uses (models/orders.py:29) -- Django's own order_form looks the row up
// by the latter (views.py:464).
export interface OrderEditRow {
  id: number;
  order_id: string;
  foodbank_id: number | null;
  items_text: string;
  need_id: number | null;
  order_group_id: number | null;
  source_url: string | null;
  delivery_date: string;
  delivery_hour: number;
  delivery_provider: string | null;
  delivery_provider_id: string | null;
  actual_cost: number | null;
}

export async function getOrderForEdit(session: Session, orderId: string): Promise<OrderEditRow | null> {
  return session
    .prepare(
      `SELECT id, order_id, foodbank_id, items_text, need_id, order_group_id, source_url,
              delivery_date, delivery_hour, delivery_provider, delivery_provider_id, actual_cost
       FROM orders WHERE order_id = ?`,
    )
    .bind(orderId)
    .first<OrderEditRow>();
}

export interface UpsertOrderParams {
  orderId: string;
  foodbankId: number | null;
  itemsText: string;
  needId: number | null;
  orderGroupId: number | null;
  country: string;
  sourceUrl: string | null;
  deliveryDate: string;
  deliveryHour: number;
  deliveryDatetime: string;
  deliveryProvider: string | null;
  deliveryProviderId: string | null;
  actualCost: number | null;
}

// Everything models/orders.py:97-130 does BEFORE its first super().save():
// the order_id, the denormalised country, the derived delivery_datetime
// and the five zeroed aggregates. The caller computes order_id/country/
// delivery_datetime (they need the Foodbank row and the slugify rules);
// this writes them.
//
// weight/calories/cost/no_lines/no_items are written as 0 on BOTH insert
// and update -- orders.py:118-122 re-zeroes them on every save, before the
// AI reparse regenerates them. The "order-lines" queue job fills them in
// via setOrderAggregates below, so between the redirect and the job
// finishing an order legitimately reads as 0 items / 0g / £0.00. That
// window is the visible cost of moving the parse off the request; the
// order page's job banner says so rather than leaving it looking broken.
export async function upsertOrder(session: Session, params: UpsertOrderParams, existingId?: number): Promise<{ id: number; order_id: string }> {
  const now = d1Timestamp();

  if (existingId === undefined) {
    const row = await session
      .prepare(
        `INSERT INTO orders
           (order_id, items_text, country, created, modified, notification_email_sent, source_url,
            delivery_date, delivery_hour, delivery_datetime, delivery_provider, delivery_provider_id,
            weight, calories, cost, actual_cost, no_lines, no_items,
            foodbank_id, need_id, order_group_id)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, 0, 0, ?, ?, ?)
         RETURNING id, order_id`,
      )
      .bind(
        params.orderId,
        params.itemsText,
        params.country,
        now,
        now,
        params.sourceUrl,
        params.deliveryDate,
        params.deliveryHour,
        params.deliveryDatetime,
        params.deliveryProvider,
        params.deliveryProviderId,
        params.actualCost,
        params.foodbankId,
        params.needId,
        params.orderGroupId,
      )
      .first<{ id: number; order_id: string }>();
    if (!row) throw new Error("order insert returned no row");
    return row;
  }

  await session
    .prepare(
      `UPDATE orders SET
         order_id = ?, items_text = ?, country = ?, modified = ?, source_url = ?,
         delivery_date = ?, delivery_hour = ?, delivery_datetime = ?,
         delivery_provider = ?, delivery_provider_id = ?,
         weight = 0, calories = 0, cost = 0, actual_cost = ?, no_lines = 0, no_items = 0,
         foodbank_id = ?, need_id = ?, order_group_id = ?
       WHERE id = ?`,
    )
    .bind(
      params.orderId,
      params.itemsText,
      params.country,
      now,
      params.sourceUrl,
      params.deliveryDate,
      params.deliveryHour,
      params.deliveryDatetime,
      params.deliveryProvider,
      params.deliveryProviderId,
      params.actualCost,
      params.foodbankId,
      params.needId,
      params.orderGroupId,
      existingId,
    )
    .run();
  return { id: existingId, order_id: params.orderId };
}

// models/orders.py:207-211 -- a NEW unassigned order's real order_id needs
// the primary key, which only exists after the insert, so Django stamps it
// in a second statement (an .update() specifically to dodge recursing back
// into save()). Deliberately NOT applied on edit: orders.py:207 gates on
// `is_new`, so an existing unassigned order keeps its order_id -- and
// therefore its admin URL -- forever.
export async function setOrderId(session: Session, rowId: number, orderId: string): Promise<void> {
  await session.prepare("UPDATE orders SET order_id = ? WHERE id = ?").bind(orderId, rowId).run();
}

// models/orders.py:132-133 -- every existing line is destroyed on every
// save, before the AI regenerates them.
export async function deleteOrderLines(session: Session, orderRowId: number): Promise<void> {
  await session.prepare("DELETE FROM orderline WHERE order_id = ?").bind(orderRowId).run();
}

// models/orders.py:89-95 Order.delete() -- lines first, then the order.
// One session.batch() rather than two round trips, so a half-delete
// (orphaned orderline rows pointing at a vanished order) is not reachable.
export async function deleteOrder(session: Session, orderRowId: number): Promise<void> {
  await session.batch([
    session.prepare("DELETE FROM orderline WHERE order_id = ?").bind(orderRowId),
    session.prepare("DELETE FROM orders WHERE id = ?").bind(orderRowId),
  ]);
}

// models/orders.py:214-216:
//   self.foodbank.last_order = Order.objects.filter(foodbank=fb)
//                                   .order_by("-delivery_date")[0].delivery_date
// i.e. MAX(delivery_date) over that food bank's orders.
//
// This port ALSO calls it after a delete and after an edit that moved an
// order between food banks. Django does neither: Order.delete()
// (orders.py:89-95) never touches last_order, so removing a food bank's
// most recent order leaves a stale date on it, and moving an order leaves
// the PREVIOUS food bank advertising a delivery it no longer has. Same
// class of fix as needAdmin.ts's recomputeFoodbankNeedFields.
//
// `edited` is deliberately NOT stamped: that column means "a human edited
// this food bank" (contrast foodbankAdmin.ts's updateFoodbankFields
// stampEdited flag), and this is a derived value.
export async function recomputeFoodbankLastOrder(session: Session, foodbankId: number): Promise<void> {
  await session
    .prepare("UPDATE foodbank SET last_order = (SELECT MAX(delivery_date) FROM orders WHERE foodbank_id = ?), modified = ? WHERE id = ?")
    .bind(foodbankId, d1Timestamp(), foodbankId)
    .run();
}

// gfadmin/views.py:518-519 stamps notification_email_sent and then calls
// the FULL order.save() -- which re-runs the entire paid Gemini parse and
// deletes/recreates every OrderLine just to write one timestamp, and at
// temperature=1 can legitimately produce different lines than the ones
// actually ordered. A targeted UPDATE instead; the same fix already made
// at needAdmin.ts's double-save and recommended by PLAN.md for
// `need.save()`.
export async function setOrderNotificationSent(session: Session, orderRowId: number, sentAt: string): Promise<void> {
  await session.prepare("UPDATE orders SET notification_email_sent = ?, modified = ? WHERE id = ?").bind(sentAt, d1Timestamp(), orderRowId).run();
}

export interface OrderEmailLineRow {
  name: string;
  quantity: number;
  weight: number | null;
}

// Order.lines() is `OrderLine.objects.filter(order=self).order_by("-weight")`
// (models/orders.py:227-228) -- heaviest first, which is the order both the
// admin order page's table and the notification email's item list are
// meant to show. orderAdmin.ts's getOrderLines currently sorts by `id`
// instead; this is the faithful ordering, used by the email builders here.
// `id` is a stable tiebreak so two equal weights don't reorder between
// renders. (The detail page's own getOrderLines should get the same fix --
// flagged rather than changed, since that function is shared.)
export async function getOrderLinesByWeight(session: Session, orderRowId: number): Promise<OrderEmailLineRow[]> {
  const result = await session
    .prepare("SELECT name, quantity, weight FROM orderline WHERE order_id = ? ORDER BY weight DESC, id")
    .bind(orderRowId)
    .all<OrderEmailLineRow>();
  return result.results;
}

// The `ordergroup` join orderAdmin.ts's getOrderDetail doesn't do (that
// function predates the table). One extra small lookup rather than an edit
// to a query several other pages share.
export async function getOrderGroupForOrder(session: Session, orderGroupId: number): Promise<OrderGroupOptionRow | null> {
  return session.prepare("SELECT id, name, slug FROM ordergroup WHERE id = ?").bind(orderGroupId).first<OrderGroupOptionRow>();
}

// ---------------------------------------------------------------------------
// Queries the "order-lines" queue job owns (workers/jobs)
// ---------------------------------------------------------------------------

export interface OrderLineParseRow {
  id: number;
  order_id: string;
  items_text: string;
  delivery_date: string;
  foodbank_id: number | null;
}

export async function getOrderForLineParse(session: Session, orderRowId: number): Promise<OrderLineParseRow | null> {
  return session.prepare("SELECT id, order_id, items_text, delivery_date, foodbank_id FROM orders WHERE id = ?").bind(orderRowId).first<OrderLineParseRow>();
}

export interface NewOrderLine {
  name: string;
  quantity: number;
  itemCost: number;
  lineCost: number;
  weight: number;
  calories: number;
  category: string;
  group: string;
}

// One OrderLine row per parsed line (models/orders.py:184-195 + the
// denormalisation OrderLine.save():250-252 does). Written as a single
// session.batch() rather than N round trips.
//
// NOTE the column is `group_name`, not `group` -- 0005_orders_and_charity
// .sql renamed it because `group` is a SQL keyword, same as
// foodbankchangeline's.
//
// `item_cost` is the FLOOR of line_cost/quantity (orders.py:251-252),
// recomputed by Django on save rather than echoing back what the AI
// returned; `weight` and `line_cost` are LINE TOTALS (per-item value x
// quantity) while the AI's own weight/item_cost are per item. The caller
// does that arithmetic -- see orderLines.ts.
export async function insertOrderLines(session: Session, orderRowId: number, deliveryDate: string, lines: NewOrderLine[]): Promise<void> {
  if (lines.length === 0) return;
  await session.batch(
    lines.map((line) =>
      session
        .prepare(
          `INSERT INTO orderline (name, quantity, item_cost, line_cost, weight, calories, order_id, delivery_date, category, group_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(line.name, line.quantity, line.itemCost, line.lineCost, line.weight, line.calories, orderRowId, deliveryDate, line.category, line.group),
    ),
  );
}

// models/orders.py:198-204's second super().save() -- the five aggregates
// only. `modified` is stamped too because this genuinely is a later write
// to the row (Django's own second save() updates auto_now `modified` for
// the same reason).
export async function setOrderAggregates(
  session: Session,
  orderRowId: number,
  aggregates: { weight: number; calories: number; cost: number; noLines: number; noItems: number },
): Promise<void> {
  await session
    .prepare("UPDATE orders SET weight = ?, calories = ?, cost = ?, no_lines = ?, no_items = ?, modified = ? WHERE id = ?")
    .bind(aggregates.weight, aggregates.calories, aggregates.cost, aggregates.noLines, aggregates.noItems, d1Timestamp(), orderRowId)
    .run();
}

// givefood/utils/text.py:118-130 get_calories() --
// OrderItem.objects.get(name=text).calories, per 100g, with
// OrderItem.DoesNotExist swallowed and treated as 0. The join is on the
// item NAME, byte for byte, so a name the AI phrased differently simply
// gets no calories. `ORDER BY id LIMIT 1` rather than a bare .get():
// orderitem_name_uniq (0014_orderitem.sql) makes a duplicate impossible
// today, but a deterministic read costs nothing.
export async function getOrderItemCalories(session: Session, name: string): Promise<number | null> {
  const row = await session.prepare("SELECT calories FROM orderitem WHERE name = ? ORDER BY id LIMIT 1").bind(name).first<{ calories: number }>();
  return row ? row.calories : null;
}

// OrderLine.save()'s first category fallback, models/orders.py:255:
//   OrderLine.objects.filter(name=self.name).exclude(category="").latest("id")
// `.exclude(category="")` excludes the empty string only, but this schema's
// `category` column is nullable (0005), so NULL is excluded here too --
// Django's own column is a non-null CharField where "" IS the empty
// sentinel, so the two forms mean the same thing.
export async function getLatestOrderLineCategory(session: Session, name: string): Promise<string | null> {
  const row = await session
    .prepare("SELECT category FROM orderline WHERE name = ? AND category IS NOT NULL AND category != '' ORDER BY id DESC LIMIT 1")
    .bind(name)
    .first<{ category: string }>();
  return row ? row.category : null;
}

// Second fallback, models/orders.py:259:
//   FoodbankChangeLine.objects.filter(item=self.name).exclude(category="")
//                             .latest("created")
export async function getLatestNeedLineCategory(session: Session, item: string): Promise<string | null> {
  const row = await session
    .prepare("SELECT category FROM foodbankchangeline WHERE item = ? AND category != '' ORDER BY created DESC LIMIT 1")
    .bind(item)
    .first<{ category: string }>();
  return row ? row.category : null;
}
