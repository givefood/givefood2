import type { Session } from "./types";
import { mapNeedRow, type FoodbankChangeRow } from "./needs";
import { pyNow } from "@givefood/models";

// D1 timestamps written by this app's own code are always
// pyNow() -- already "Z"-suffixed -- but this file's
// duration math used to unconditionally append another "Z" before
// parsing ("...Z" + "Z" = "...ZZ"), which `new Date()` silently turns
// into an Invalid Date (getTime() = NaN) rather than throwing. Found
// 2026-09-02 alongside the identical class of bug already fixed in
// workers/site/src/lib/timesince.ts's parseUtc() -- same root cause
// (blind "+ Z"), different file. Strips a trailing "Z" first so it's
// safe to re-append regardless of whether the input already has one.
export function parseD1Timestamp(value: string): number {
  return new Date(`${value.replace(/Z$/, "")}Z`).getTime();
}

// Python's str(timedelta) -- what Django actually prints for
// CrawlSet.time_taken() (givefood/models/analytics.py:43-47, which already
// rounds to whole seconds) in BOTH templates
// (admin/crawl_sets.html:57, admin/crawl_set.html:30) and in the JSON the
// detail page polls (gfadmin/views.py:3317
// `"time_taken": str(crawl_set.time_taken())`). That is "0:04:32" /
// "2:14:07" / "1 day, 2:03:04", never raw fractional seconds -- a
// multi-hour `need` crawl printed as "8047.219 s" made the admin do the
// conversion in their head. One helper for all three call sites so the SSR
// row and the poll that overwrites it can never disagree.
//
// Math.floor is Python's floor division, so a negative duration borrows a
// day the way timedelta does ("-1 day, 23:59:59") instead of printing
// "-0:00:01". Math.round is half-up where Python's round() is half-to-even;
// they differ only on an exact .5 of a second.
export function formatTimedelta(milliseconds: number): string {
  const totalSeconds = Math.round(milliseconds / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const rest = totalSeconds - days * 86400;
  const clock = `${Math.floor(rest / 3600)}:${String(Math.floor((rest % 3600) / 60)).padStart(2, "0")}:${String(rest % 60).padStart(2, "0")}`;
  if (days === 0) return clock;
  // timedelta uses the singular for exactly one day, either sign.
  return `${days} day${Math.abs(days) === 1 ? "" : "s"}, ${clock}`;
}

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
  no_items: number;
  cost: number;
  notification_email_sent: string | null;
}

// The two halves of the needs/orders tab sort on deliberately DIFFERENT
// keys -- gfadmin/views.py:644-645 is
//   "needs":  ...order_by("-created")[:200]
//   "orders": ...order_by("-delivery_datetime")[:200]
// Don't copy one onto the other: the orders table renders
// delivery_datetime as its Date column (foodbank.html:522), so sorting it
// by `created` shows a Date column out of date order, and applying the
// 200-row cap to the wrong key hands back a different 200 rows entirely.
export async function getNeedsForFoodbankTab(session: Session, foodbankId: number, limit: number): Promise<FoodbankChangeRow[]> {
  const result = await session.prepare("SELECT * FROM foodbankchange_full WHERE foodbank_id = ? ORDER BY created DESC LIMIT ?").bind(foodbankId, limit).all();
  return result.results.map((r) => mapNeedRow(r as Record<string, unknown>));
}

// `actual_cost` is deliberately NOT selected: Django's Cost column here is
// Order.natural_cost() (givefood/models/orders.py:74-75), a bare
// float(cost/100) with no actual_cost branch. The separate
// natural_actual_cost() at :77-81 belongs to the order DETAIL page only
// (admin/order.njk:49-51). Ordering by delivery_datetime also lets this
// use order_foodbank_delivery_idx (0005_orders_and_charity.sql:34).
export async function getOrdersForFoodbankTab(session: Session, foodbankId: number, limit: number): Promise<OrderTabRow[]> {
  const result = await session
    .prepare(
      "SELECT id, order_id, created, delivery_datetime, delivery_provider, no_items, cost, notification_email_sent FROM orders WHERE foodbank_id = ? ORDER BY delivery_datetime DESC LIMIT ?",
    )
    .bind(foodbankId, limit)
    .all<OrderTabRow>();
  return result.results;
}

export interface ArticleTabRow {
  id: number;
  published_date: string;
  title: string;
  url: string;
}

// `featured` is deliberately NOT selected. Django's articles partial
// (gfadmin/templates/admin/foodbank.html:591-604) is two cells -- title,
// then timesince -- with no featured column at all. The featured toggle
// lives only on the admin dashboard (admin/index.html:131-133, ported at
// routes/admin/articles.ts); a static star here would be a column Django
// does not have.
export async function getArticlesForFoodbankTab(session: Session, foodbankId: number, limit: number): Promise<ArticleTabRow[]> {
  const result = await session
    .prepare("SELECT id, published_date, title, url FROM foodbankarticle WHERE foodbank_id = ? ORDER BY published_date DESC LIMIT ?")
    .bind(foodbankId, limit)
    .all<ArticleTabRow>();
  return result.results;
}

export interface SubscriptionCounts {
  email: number;
  whatsapp: number; // always 0 -- no whatsappsubscriber D1 table exists yet, same gap WP 6.4/6.9 already disclosed
  mobile: number;
  webpush: number;
}

export interface AllSubscriptionRow {
  type: "email" | "mobile" | "webpush";
  type_emoji: string;
  identifier: string;
  created: string;
}

export interface SubscribersTabData {
  subscription_counts: SubscriptionCounts;
  all_subscriptions: AllSubscriptionRow[];
}

const DEVICE_ID_TRUNCATE_LENGTH = 20; // gfadmin/views.py:42
const ENDPOINT_TRUNCATE_LENGTH = 30; // gfadmin/views.py:43

function truncateWithEllipsis(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}...` : value;
}

// gfadmin/views.py:663-720 foodbank_subscribers_tab -- one combined,
// chronologically-sorted list across every channel (matching
// /admin/subscriptions/'s own shape), not three separate per-type tables.
// Unbounded, matching Django exactly -- per-foodbank subscriber counts are
// small (PLAN.md's own count: the busiest food bank has 98), nothing like
// the whole-table risk WP 6.9's admin-wide subscriptions list guards
// against.
export async function getSubscribersForFoodbankTab(session: Session, foodbankId: number): Promise<SubscribersTabData> {
  const [email, webpush, mobile] = await Promise.all([
    session.prepare("SELECT email, created FROM foodbanksubscriber WHERE foodbank_id = ? AND confirmed = 1").bind(foodbankId).all<{ email: string; created: string }>(),
    session.prepare("SELECT endpoint, browser, created FROM webpushsubscription WHERE foodbank_id = ?").bind(foodbankId).all<{ endpoint: string; browser: string | null; created: string }>(),
    session.prepare("SELECT device_id, platform, created FROM mobilesubscriber WHERE foodbank_id = ?").bind(foodbankId).all<{ device_id: string; platform: string; created: string }>(),
  ]);

  const all: AllSubscriptionRow[] = [
    ...email.results.map((r) => ({ type: "email" as const, type_emoji: '<span class="mdi mdi-email"></span>', identifier: r.email, created: r.created })),
    ...mobile.results.map((r) => ({
      type: "mobile" as const,
      type_emoji: '<span class="mdi mdi-cellphone"></span>',
      identifier: `${r.platform} - ${truncateWithEllipsis(r.device_id, DEVICE_ID_TRUNCATE_LENGTH)}`,
      created: r.created,
    })),
    ...webpush.results.map((r) => ({
      type: "webpush" as const,
      type_emoji: '<span class="mdi mdi-bell"></span>',
      identifier: `${r.browser ?? "Unknown"} - ${truncateWithEllipsis(r.endpoint, ENDPOINT_TRUNCATE_LENGTH)}`,
      created: r.created,
    })),
  ];
  all.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));

  return {
    subscription_counts: { email: email.results.length, whatsapp: 0, mobile: mobile.results.length, webpush: webpush.results.length },
    all_subscriptions: all,
  };
}

export interface CrawlItemTabRow {
  id: number;
  crawl_type: string;
  start: string;
  finish: string | null;
  url: string | null;
  need_id: number | null;
  time_taken_ms: number | null;
}

// givefood/const/general.py:62-70 CRAWL_TYPE_ICONS/CRAWL_TYPE_ICON_DEFAULT.
const CRAWL_TYPE_ICONS: Record<string, string> = {
  need: '<span class="mdi mdi-cart"></span>',
  article: '<span class="mdi mdi-newspaper"></span>',
  charity: '<span class="mdi mdi-bank"></span>',
  discrepancy: '<span class="mdi mdi-alert"></span>',
  check: '<span class="mdi mdi-clipboard-check"></span>',
  urls: '<span class="mdi mdi-link"></span>',
};
const CRAWL_TYPE_ICON_DEFAULT = '<span class="mdi mdi-help-circle"></span>';

export function crawlTypeIcon(crawlType: string): string {
  return CRAWL_TYPE_ICONS[crawlType] ?? CRAWL_TYPE_ICON_DEFAULT;
}

export async function getCrawlItemsForFoodbankTab(session: Session, foodbankId: number, limit: number): Promise<CrawlItemTabRow[]> {
  const result = await session
    .prepare("SELECT id, crawl_type, start, finish, url, need_id FROM crawlitem WHERE foodbank_id = ? ORDER BY start DESC LIMIT ?")
    .bind(foodbankId, limit)
    .all<Omit<CrawlItemTabRow, "time_taken_ms">>();
  return result.results.map((r) => ({
    ...r,
    time_taken_ms: r.finish ? parseD1Timestamp(r.finish) - parseD1Timestamp(r.start) : null,
  }));
}

// gfadmin/views.py:3283-3323 crawl_set_json() -- exact shape test-pinned
// (test_crawl_set_json.py). `items` ordered by (need_id via crawlitem's
// own object_id-equivalent, -start) -- this port's crawlitem.need_id
// already collapses Django's generic FK to FoodbankChange down to a plain
// column (0008_needcheck.sql's own comment), so "object_id" here is just
// need_id.
//
// The `(ci.need_id IS NULL)` leading key emulates Postgres, NOT a
// re-ordering. Django runs on Postgres (givefood/settings.py:141), where an
// ASC sort puts NULLs LAST, so views.py:3273's order_by("object_id",
// "-start") floats the crawl items that actually produced a need to the TOP
// of the table and leaves the (far more numerous) items that found nothing
// below them. SQLite sorts NULLs FIRST, which buried the only interesting
// rows on a several-hundred-row `need` crawl past the end of the first
// screenful -- in the SSR table and, identically, in the poll that
// re-renders it.
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
       ORDER BY (ci.need_id IS NULL), ci.need_id, ci.start DESC`,
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
    const timeTakenMs = item.finish ? parseD1Timestamp(item.finish) - parseD1Timestamp(item.start) : null;
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
  // views.py:3317 -- str(timedelta), the SAME string the two templates
  // render, so the value the poll writes into the Time Taken row is
  // indistinguishable from a server-rendered one.
  const timeTaken = crawlSet.finish ? formatTimedelta(parseD1Timestamp(crawlSet.finish) - parseD1Timestamp(crawlSet.start)) : null;

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
