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
  title: string;
  url: string;
  published_date: string;
  featured: boolean;
}

export async function getRecentArticlesForAdmin(session: Session, limit: number): Promise<DashboardArticleRow[]> {
  const result = await session
    .prepare("SELECT id, foodbank_name, title, url, published_date, featured FROM foodbankarticle ORDER BY published_date DESC LIMIT ?")
    .bind(limit)
    .all<{ id: number; foodbank_name: string | null; title: string; url: string; published_date: string; featured: number }>();
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

export { totalPages };
