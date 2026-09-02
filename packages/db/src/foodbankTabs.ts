import type { Session } from "./types";
import { mapNeedRow, type FoodbankChangeRow } from "./needs";

// WP 6.7: the foodbank detail page's lazy tabs (gfadmin/views.py's
// foodbank_needsorders_tab/foodbank_articles_tab/foodbank_subscribers_tab/
// foodbank_crawls_tab data-builders, plus the crawl-set JSON polling
// endpoint). Small, capped reads -- each tab shows recent history, not a
// full paginated archive (matching Django, which caps each tab's queryset
// too).

export interface OrderTabRow {
  id: number;
  order_id: string;
  created: string;
  delivery_datetime: string;
  delivery_provider: string | null;
  cost: number;
  actual_cost: number | null;
}

export async function getNeedsForFoodbankTab(session: Session, foodbankId: number, limit: number): Promise<FoodbankChangeRow[]> {
  const result = await session.prepare("SELECT * FROM foodbankchange WHERE foodbank_id = ? ORDER BY created DESC LIMIT ?").bind(foodbankId, limit).all();
  return result.results.map((r) => mapNeedRow(r as Record<string, unknown>));
}

export async function getOrdersForFoodbankTab(session: Session, foodbankId: number, limit: number): Promise<OrderTabRow[]> {
  const result = await session
    .prepare("SELECT id, order_id, created, delivery_datetime, delivery_provider, cost, actual_cost FROM orders WHERE foodbank_id = ? ORDER BY created DESC LIMIT ?")
    .bind(foodbankId, limit)
    .all<OrderTabRow>();
  return result.results;
}

export interface ArticleTabRow {
  id: number;
  published_date: string;
  title: string;
  url: string;
  featured: boolean;
}

export async function getArticlesForFoodbankTab(session: Session, foodbankId: number, limit: number): Promise<ArticleTabRow[]> {
  const result = await session
    .prepare("SELECT id, published_date, title, url, featured FROM foodbankarticle WHERE foodbank_id = ? ORDER BY published_date DESC LIMIT ?")
    .bind(foodbankId, limit)
    .all<{ id: number; published_date: string; title: string; url: string; featured: number }>();
  return result.results.map((r) => ({ ...r, featured: r.featured === 1 }));
}

export interface SubscribersTabData {
  email: { id: number; email: string; created: string; confirmed: boolean }[];
  webpush: { id: number; created: string; browser: string | null }[];
  mobile: { id: number; created: string; platform: string; device_model: string | null }[];
}

export async function getSubscribersForFoodbankTab(session: Session, foodbankId: number, limit: number): Promise<SubscribersTabData> {
  const [email, webpush, mobile] = await Promise.all([
    session
      .prepare("SELECT id, email, created, confirmed FROM foodbanksubscriber WHERE foodbank_id = ? AND confirmed = 1 ORDER BY created DESC LIMIT ?")
      .bind(foodbankId, limit)
      .all<{ id: number; email: string; created: string; confirmed: number }>(),
    session
      .prepare("SELECT id, created, browser FROM webpushsubscription WHERE foodbank_id = ? ORDER BY created DESC LIMIT ?")
      .bind(foodbankId, limit)
      .all<{ id: number; created: string; browser: string | null }>(),
    session
      .prepare("SELECT id, created, platform, device_model FROM mobilesubscriber WHERE foodbank_id = ? ORDER BY created DESC LIMIT ?")
      .bind(foodbankId, limit)
      .all<{ id: number; created: string; platform: string; device_model: string | null }>(),
  ]);
  return {
    email: email.results.map((r) => ({ ...r, confirmed: r.confirmed === 1 })),
    webpush: webpush.results,
    mobile: mobile.results,
  };
}

export interface CrawlItemTabRow {
  id: number;
  crawl_type: string;
  start: string;
  finish: string | null;
  url: string | null;
  need_id: number | null;
}

export async function getCrawlItemsForFoodbankTab(session: Session, foodbankId: number, limit: number): Promise<CrawlItemTabRow[]> {
  const result = await session
    .prepare("SELECT id, crawl_type, start, finish, url, need_id FROM crawlitem WHERE foodbank_id = ? ORDER BY start DESC LIMIT ?")
    .bind(foodbankId, limit)
    .all<CrawlItemTabRow>();
  return result.results;
}

// gfadmin/views.py:3283-3323 crawl_set_json() -- exact shape test-pinned
// (test_crawl_set_json.py). `items` ordered by (need_id via crawlitem's
// own object_id-equivalent, -start) -- this port's crawlitem.need_id
// already collapses Django's generic FK to FoodbankChange down to a plain
// column (0008_needcheck.sql's own comment), so "object_id" here is just
// need_id.
export interface CrawlSetJson {
  crawl_type: string;
  start: string;
  finish: string | null;
  time_taken: string | null;
  item_count: number;
  object_count: number;
  items: {
    foodbank_name: string;
    foodbank_slug: string;
    start: string;
    finish: string | null;
    time_taken_ms: number | null;
    url: string | null;
    object: null | { status: "deleted" } | { url: string; class_name: "FoodbankChange"; need_id_short: string; nonpertinent: boolean; published: boolean };
  }[];
}

export async function getCrawlSetJson(session: Session, crawlSetId: number): Promise<CrawlSetJson | null> {
  const crawlSet = await session.prepare("SELECT crawl_type, start, finish FROM crawlset WHERE id = ?").bind(crawlSetId).first<{ crawl_type: string; start: string; finish: string | null }>();
  if (!crawlSet) return null;

  const items = await session
    .prepare(
      `SELECT ci.id, ci.start, ci.finish, ci.url, ci.need_id, f.name AS foodbank_name, f.slug AS foodbank_slug,
              fc.need_id AS need_uuid, fc.nonpertinent, fc.published
       FROM crawlitem ci
       JOIN foodbank f ON f.id = ci.foodbank_id
       LEFT JOIN foodbankchange fc ON fc.id = ci.need_id
       WHERE ci.crawl_set_id = ?
       ORDER BY ci.need_id, ci.start DESC`,
    )
    .bind(crawlSetId)
    .all<{
      id: number;
      start: string;
      finish: string | null;
      url: string | null;
      need_id: number | null;
      foodbank_name: string;
      foodbank_slug: string;
      need_uuid: string | null;
      nonpertinent: number | null;
      published: number | null;
    }>();

  const rows = items.results.map((item) => {
    const timeTakenMs = item.finish ? new Date(item.finish + "Z").getTime() - new Date(item.start + "Z").getTime() : null;
    let object: CrawlSetJson["items"][number]["object"] = null;
    if (item.need_id !== null) {
      object =
        item.need_uuid !== null
          ? {
              url: `/admin/need/${item.need_uuid}/`,
              class_name: "FoodbankChange",
              need_id_short: item.need_uuid.slice(0, 7),
              nonpertinent: item.nonpertinent === 1,
              published: item.published === 1,
            }
          : { status: "deleted" };
    }
    return {
      foodbank_name: item.foodbank_name,
      foodbank_slug: item.foodbank_slug,
      start: item.start,
      finish: item.finish,
      time_taken_ms: timeTakenMs,
      url: item.url,
      object,
    };
  });

  // `object_count` mirrors CrawlSet.object_count() -- items that actually
  // produced a linked object (a need), not merely items that finished
  // running; `item_count` is every item regardless of outcome.
  const objectCount = items.results.filter((i) => i.need_id !== null).length;
  const timeTaken = crawlSet.finish ? String((new Date(crawlSet.finish + "Z").getTime() - new Date(crawlSet.start + "Z").getTime()) / 1000) : null;

  return {
    crawl_type: crawlSet.crawl_type,
    start: crawlSet.start,
    finish: crawlSet.finish,
    time_taken: timeTaken,
    item_count: items.results.length,
    object_count: objectCount,
    items: rows,
  };
}
