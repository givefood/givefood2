import type { Session } from "./types";
import { mapFoodbankRow, type FoodbankRow } from "./foodbank";
import { mapLocationRow, type FoodbankLocationRow } from "./locations";
import { mapDonationPointRow, type DonationPointRow } from "./donationpoints";

// WP 6.6: the admin's list-view read paths (gfadmin/views.py's `foodbanks`/
// `locations`/`donationpoints`/`orders`/`items`/`order_groups`/`politics`
// views). Kept in one file since every one of these is the same shape --
// COUNT + a sorted, LIMIT/OFFSET page -- unlike foodbank.ts/locations.ts/
// donationpoints.ts's own read functions, which are the PUBLIC API's
// unpaginated full-table or single-row reads.
//
// Real pagination everywhere, including where Django's own view has none
// at all (orders/locations/donationpoints/items/order_groups/politics all
// render their FULL table into one page, confirmed by WP 6.6 research) --
// not ported, since D1 meters rows scanned (PLAN.md §4.3) and an
// unbounded admin list is exactly the "will exceed 128 MB" risk PLAN.md's
// WP 6.9 already names for /admin/subscriptions/ and /admin/places/.
// Building every list page paginated from the start avoids building the
// antipattern once just to redo it in WP 6.9.

export interface PageResult<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
}

function totalPages(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

// gfadmin/views.py:234-314 foodbanks() -- `exclude(is_closed=True)`
// matches Django's default view exactly. Sort allowlist trimmed from
// Django's 20 options to the ones an admin actually triages by; anything
// outside this list falls back to `edited` rather than Django's 403 --
// an unrecognised `?sort=` shouldn't break the page.
export const FOODBANK_LIST_SORTS = ["name", "postcode", "country", "network", "edited", "created"] as const;
export type FoodbankListSort = (typeof FOODBANK_LIST_SORTS)[number];

export async function getFoodbanksPage(session: Session, sort: FoodbankListSort, page: number, pageSize: number): Promise<PageResult<FoodbankRow>> {
  const offset = (page - 1) * pageSize;
  const [countRow, result] = await Promise.all([
    session.prepare("SELECT COUNT(*) AS n FROM foodbank WHERE is_closed = 0").first<{ n: number }>(),
    session
      .prepare(`SELECT * FROM foodbank WHERE is_closed = 0 ORDER BY ${sort} DESC LIMIT ? OFFSET ?`)
      .bind(pageSize, offset)
      .all(),
  ]);
  const total = countRow?.n ?? 0;
  return { rows: result.results.map((r) => mapFoodbankRow(r as Record<string, unknown>)), total, page, pageSize, hasNext: offset + pageSize < total };
}

// gfadmin/views.py:326-337 foodbanks_csv() -- ALL foodbanks (closed
// included, unlike the list view above), sorted -created. Frozen column
// order: name, postcode, charity_number, country, last_order, last_need,
// no_locations, network, closed, url, created, modified.
export async function getAllFoodbanksForCsv(session: Session): Promise<FoodbankRow[]> {
  const result = await session.prepare("SELECT * FROM foodbank ORDER BY created DESC").all();
  return result.results.map((r) => mapFoodbankRow(r as Record<string, unknown>));
}

// gfadmin/views.py:2138-2220 locations()/donationpoints() -- no filter,
// full table in Django; sort allowlist trimmed the same way as foodbanks.
export const LOCATION_LIST_SORTS = ["foodbank_name", "name", "postcode", "modified"] as const;
export type LocationListSort = (typeof LOCATION_LIST_SORTS)[number];

export async function getLocationsPage(session: Session, sort: LocationListSort, page: number, pageSize: number): Promise<PageResult<FoodbankLocationRow>> {
  const offset = (page - 1) * pageSize;
  const [countRow, result] = await Promise.all([
    session.prepare("SELECT COUNT(*) AS n FROM foodbanklocation").first<{ n: number }>(),
    session.prepare(`SELECT * FROM foodbanklocation ORDER BY ${sort} DESC LIMIT ? OFFSET ?`).bind(pageSize, offset).all(),
  ]);
  const total = countRow?.n ?? 0;
  return { rows: result.results.map((r) => mapLocationRow(r as Record<string, unknown>)), total, page, pageSize, hasNext: offset + pageSize < total };
}

export const DONATION_POINT_LIST_SORTS = ["foodbank_name", "name", "company"] as const;
export type DonationPointListSort = (typeof DONATION_POINT_LIST_SORTS)[number];

export async function getDonationPointsPage(session: Session, sort: DonationPointListSort, page: number, pageSize: number): Promise<PageResult<DonationPointRow>> {
  const offset = (page - 1) * pageSize;
  const [countRow, result] = await Promise.all([
    session.prepare("SELECT COUNT(*) AS n FROM foodbankdonationpoint").first<{ n: number }>(),
    session.prepare(`SELECT * FROM foodbankdonationpoint ORDER BY ${sort} DESC LIMIT ? OFFSET ?`).bind(pageSize, offset).all(),
  ]);
  const total = countRow?.n ?? 0;
  return { rows: result.results.map((r) => mapDonationPointRow(r as Record<string, unknown>)), total, page, pageSize, hasNext: offset + pageSize < total };
}

// gfadmin/views.py:2311-2321 politics().
export interface ParlconListRow {
  id: number;
  name: string | null;
  slug: string;
  mp: string | null;
  mp_party: string | null;
}

export async function getParlconsPage(session: Session, page: number, pageSize: number): Promise<PageResult<ParlconListRow>> {
  const offset = (page - 1) * pageSize;
  const [countRow, result] = await Promise.all([
    session.prepare("SELECT COUNT(*) AS n FROM parliamentaryconstituency").first<{ n: number }>(),
    session
      .prepare("SELECT id, name, slug, mp, mp_party FROM parliamentaryconstituency ORDER BY name LIMIT ? OFFSET ?")
      .bind(pageSize, offset)
      .all<ParlconListRow>(),
  ]);
  const total = countRow?.n ?? 0;
  return { rows: result.results, total, page, pageSize, hasNext: offset + pageSize < total };
}

// gfadmin/views.py:2322-2336 politics_csv() -- exports the DENORMALIZED
// political-lookup fields cached on Foodbank/FoodbankLocation, not the
// ParliamentaryConstituency model itself -- both querysets back to back,
// no dedup, matching Django exactly (frozen column contract, WP 6.6
// research: real people paste this into spreadsheets).
export interface ParlconCsvRow {
  constituency: string | null;
  mp: string | null;
  mp_party: string | null;
  mp_parl_id: number | null;
}

export async function getParlconCsvRows(session: Session): Promise<ParlconCsvRow[]> {
  const [foodbankRows, locationRows] = await Promise.all([
    session
      .prepare("SELECT parliamentary_constituency_name AS constituency, mp, mp_party, mp_parl_id FROM foodbank")
      .all<ParlconCsvRow>(),
    session
      .prepare("SELECT parliamentary_constituency_name AS constituency, mp, mp_party, mp_parl_id FROM foodbanklocation")
      .all<ParlconCsvRow>(),
  ]);
  return [...foodbankRows.results, ...locationRows.results];
}

// gfadmin/views.py:369-408 orders()/orders_csv() -- Order/OrderItem/
// OrderGroup CREATE+EDIT are deferred (WP 6.5b: Order.save()'s Gemini-
// based line regeneration, no ordergroup/orderitem D1 table). Reading
// existing orders has neither blocker -- `orders`/`orderline`
// (migrations/0005_orders_and_charity.sql) already carry real data --
// so the read-only list + CSV export are built here regardless.
export interface OrderListRow {
  id: number;
  order_id: string;
  created: string;
  delivery_datetime: string;
  delivery_provider: string | null;
  foodbank_name: string | null;
  country: string;
  weight: number;
  calories: number;
  no_items: number;
  cost: number;
  actual_cost: number | null;
}

export async function getOrdersPage(session: Session, page: number, pageSize: number): Promise<PageResult<OrderListRow>> {
  const offset = (page - 1) * pageSize;
  const [countRow, result] = await Promise.all([
    session.prepare("SELECT COUNT(*) AS n FROM orders").first<{ n: number }>(),
    session
      .prepare(
        `SELECT o.id, o.order_id, o.created, o.delivery_datetime, o.delivery_provider, f.name AS foodbank_name,
                o.country, o.weight, o.calories, o.no_items, o.cost, o.actual_cost
         FROM orders o LEFT JOIN foodbank f ON f.id = o.foodbank_id
         ORDER BY o.created DESC LIMIT ? OFFSET ?`,
      )
      .bind(pageSize, offset)
      .all<OrderListRow>(),
  ]);
  const total = countRow?.n ?? 0;
  return { rows: result.results, total, page, pageSize, hasNext: offset + pageSize < total };
}

// gfadmin/views.py:396-408 orders_csv() -- frozen column order: id,
// created, delivery, delivery_provider, foodbank, country, weight,
// calories, items, cost, delivered_cost. `foodbank` is "Unassigned" for
// a NULL foodbank_id, matching Django's inline `if order.foodbank else
// "Unassigned"`.
export async function getAllOrdersForCsv(session: Session): Promise<OrderListRow[]> {
  const result = await session
    .prepare(
      `SELECT o.id, o.order_id, o.created, o.delivery_datetime, o.delivery_provider, f.name AS foodbank_name,
              o.country, o.weight, o.calories, o.no_items, o.cost, o.actual_cost
       FROM orders o LEFT JOIN foodbank f ON f.id = o.foodbank_id
       ORDER BY o.created DESC`,
    )
    .all<OrderListRow>();
  return result.results;
}

// WP 6.7: gfadmin/views.py's admin index -- the featured-article toggle
// (article_toggle_featured) needs a recent-articles panel on the
// dashboard to toggle from; this app's dashboard (WP 6.4's adminIndex)
// didn't have one yet.
export interface DashboardArticleRow {
  id: number;
  foodbank_name: string | null;
  foodbank_slug: string | null;
  title: string;
  url: string;
  published_date: string;
  featured: boolean;
}

export async function getRecentArticlesForAdmin(session: Session, limit: number): Promise<DashboardArticleRow[]> {
  const result = await session
    .prepare(
      "SELECT a.id, a.foodbank_name, f.slug AS foodbank_slug, a.title, a.url, a.published_date, a.featured " +
        "FROM foodbankarticle a LEFT JOIN foodbank f ON f.id = a.foodbank_id ORDER BY a.published_date DESC LIMIT ?",
    )
    .bind(limit)
    .all<{ id: number; foodbank_name: string | null; foodbank_slug: string | null; title: string; url: string; published_date: string; featured: number }>();
  return result.results.map((r) => ({ ...r, featured: r.featured === 1 }));
}

// gfadmin/views.py:3399-3417 article_toggle_featured -- flip, don't set,
// matching Django's `article.featured = not article.featured`. Returns
// the new value so the route handler can build the right response
// fragment without a second read.
export async function toggleArticleFeatured(session: Session, articleId: number): Promise<boolean | null> {
  const row = await session.prepare("UPDATE foodbankarticle SET featured = 1 - featured WHERE id = ? RETURNING featured").bind(articleId).first<{ featured: number }>();
  return row ? row.featured === 1 : null;
}

// WP 6.9: gfadmin/views.py:3028-3062 places() -- Django's own `Paginator
// (all_places, 20000)` defeats the point of paginating at all (a 20,000-
// row page is "load them all" with extra steps); real LIMIT/OFFSET here.
// `place` (migrations/0009_aac.sql) was deliberately trimmed to read-only
// columns per §4.8.7 (WP 6.5b's own note on why PlaceForm is deferred),
// but `name`/`county`/`population` -- the 3 sortable fields -- all
// survived the trim, so a read-only paginated list needs nothing new.
export const PLACE_LIST_SORTS = ["name", "county", "population"] as const;
export type PlaceListSort = (typeof PLACE_LIST_SORTS)[number];

export interface PlaceListRow {
  id: number;
  name: string | null;
  county: string | null;
  population: number | null;
}

export async function getPlacesPage(session: Session, sort: PlaceListSort, direction: "asc" | "desc", page: number, pageSize: number): Promise<PageResult<PlaceListRow>> {
  const offset = (page - 1) * pageSize;
  const [countRow, result] = await Promise.all([
    session.prepare("SELECT COUNT(*) AS n FROM place").first<{ n: number }>(),
    session
      .prepare(`SELECT id, name, county, population FROM place ORDER BY ${sort} ${direction === "desc" ? "DESC" : "ASC"} LIMIT ? OFFSET ?`)
      .bind(pageSize, offset)
      .all<PlaceListRow>(),
  ]);
  const total = countRow?.n ?? 0;
  return { rows: result.results, total, page, pageSize, hasNext: offset + pageSize < total };
}

// WP 6.9: gfadmin/views.py:2890-2980 subscriptions() -- Django fully
// materializes and Python-sorts FoodbankSubscriber/WhatsappSubscriber/
// MobileSubscriber/WebPushSubscription into one list before paginating
// the in-memory result, on every page view regardless of which page is
// requested (WP 6.6 research's own description: "a real scaling risk").
// A single `?type=` filter is a plain LIMIT/OFFSET SELECT on that one
// table; "all" is a UNION ALL across the 3 tables this D1 schema has
// (WhatsappSubscriber has no table here yet -- same gap WP 6.4's
// getNeedSubscriberCounts already disclosed) with the ORDER BY/LIMIT
// applied to the combined result, so D1 does the sort+page, not the
// Worker's own memory.
export type SubscriptionType = "all" | "email" | "mobile" | "webpush";

export interface SubscriptionListRow {
  type: "email" | "mobile" | "webpush";
  identifier: string;
  foodbank_name: string;
  foodbank_slug: string;
  created: string;
  row_id: string; // email: "<email>|<foodbank_slug>" (delete key is the pair, no single id); mobile/webpush: the row's own id
}

function subscriptionUnionSql(subType: SubscriptionType): string {
  const branches: string[] = [];
  if (subType === "all" || subType === "email") {
    branches.push(
      `SELECT 'email' AS type, s.email AS identifier, f.name AS foodbank_name, f.slug AS foodbank_slug, s.created AS created, (s.email || '|' || f.slug) AS row_id
       FROM foodbanksubscriber s JOIN foodbank f ON f.id = s.foodbank_id WHERE s.confirmed = 1`,
    );
  }
  if (subType === "all" || subType === "mobile") {
    branches.push(
      `SELECT 'mobile' AS type, (s.platform || ' - ' || substr(s.device_id, 1, 20)) AS identifier, f.name AS foodbank_name, f.slug AS foodbank_slug, s.created AS created, CAST(s.id AS TEXT) AS row_id
       FROM mobilesubscriber s JOIN foodbank f ON f.id = s.foodbank_id`,
    );
  }
  if (subType === "all" || subType === "webpush") {
    branches.push(
      `SELECT 'webpush' AS type, (COALESCE(s.browser, 'Unknown') || ' - ' || substr(s.endpoint, 1, 30)) AS identifier, f.name AS foodbank_name, f.slug AS foodbank_slug, s.created AS created, CAST(s.id AS TEXT) AS row_id
       FROM webpushsubscription s JOIN foodbank f ON f.id = s.foodbank_id`,
    );
  }
  return branches.join(" UNION ALL ");
}

export async function getSubscriptionsPage(session: Session, subType: SubscriptionType, page: number, pageSize: number): Promise<PageResult<SubscriptionListRow>> {
  const offset = (page - 1) * pageSize;
  const unionSql = subscriptionUnionSql(subType);
  const [countRow, result] = await Promise.all([
    session.prepare(`SELECT COUNT(*) AS n FROM (${unionSql})`).first<{ n: number }>(),
    session.prepare(`SELECT * FROM (${unionSql}) ORDER BY created DESC LIMIT ? OFFSET ?`).bind(pageSize, offset).all<SubscriptionListRow>(),
  ]);
  const total = countRow?.n ?? 0;
  return { rows: result.results, total, page, pageSize, hasNext: offset + pageSize < total };
}

// gfadmin/views.py:2997-3020 delete_subscription, @require_POST --
// "whatsapp" omitted, same missing-table reason as above.
export async function deleteSubscription(session: Session, type: "email" | "mobile" | "webpush", rowId: string): Promise<boolean> {
  if (type === "email") {
    const [email, foodbankSlug] = rowId.split("|");
    if (!email || !foodbankSlug) return false;
    const foodbank = await session.prepare("SELECT id FROM foodbank WHERE slug = ?").bind(foodbankSlug).first<{ id: number }>();
    if (!foodbank) return false;
    const result = await session.prepare("DELETE FROM foodbanksubscriber WHERE email = ? AND foodbank_id = ?").bind(email, foodbank.id).run();
    return result.meta.changes > 0;
  }
  const table = type === "mobile" ? "mobilesubscriber" : "webpushsubscription";
  const id = Number(rowId);
  if (!Number.isInteger(id)) return false;
  const result = await session.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
  return result.meta.changes > 0;
}

// WP 6.9: gfadmin/views.py:3090-3111 foodbanks_without_need -- Django's
// own comment explains the DISTINCT ON's purpose ("one query for the
// latest published need per food bank name, rather than a .latest() per
// food bank"). D1/SQLite has no DISTINCT ON; ROW_NUMBER() OVER (PARTITION
// BY ...) is the named-in-this-WP portable equivalent -- one query, same
// result shape (latest published need per foodbank_name, joined by name
// not id, matching Django's own join key exactly). `Foodbank.objects
// .all()` is also unbounded in Django (open and closed); paginated here
// like every other list this phase has built.
export interface FoodbankWithoutNeedRow {
  id: number;
  name: string;
  slug: string;
  latest_need_id: string | null; // foodbankchange.need_id (the public uuid), null if this foodbank has never had a published need
  latest_need_created: string | null;
}

export async function getFoodbanksWithoutNeedPage(session: Session, page: number, pageSize: number): Promise<PageResult<FoodbankWithoutNeedRow>> {
  const offset = (page - 1) * pageSize;
  const sql = `
    SELECT f.id, f.name, f.slug, latest.need_id AS latest_need_id, latest.created AS latest_need_created
    FROM foodbank f
    LEFT JOIN (
      SELECT foodbank_name, need_id, created,
             ROW_NUMBER() OVER (PARTITION BY foodbank_name ORDER BY created DESC) AS rn
      FROM foodbankchange
      WHERE published = 1
    ) latest ON latest.foodbank_name = f.name AND latest.rn = 1
  `;
  const [countRow, result] = await Promise.all([
    session.prepare("SELECT COUNT(*) AS n FROM foodbank").first<{ n: number }>(),
    session.prepare(`${sql} ORDER BY f.name LIMIT ? OFFSET ?`).bind(pageSize, offset).all<FoodbankWithoutNeedRow>(),
  ]);
  const total = countRow?.n ?? 0;
  return { rows: result.results, total, page, pageSize, hasNext: offset + pageSize < total };
}

export { totalPages };
