import type { Context } from "hono";
import { render, intcomma, djangoDate } from "@givefood/templates";
import { getQuarterStats, getEditStats, getOrderStats, getSubscriberStats, getSubscriberSignupRows, getNeedStats } from "@givefood/db";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { weekKey } from "../../lib/isoWeek";
import { adminPageContext } from "./pageContext";

// gfadmin/urls/stats.py:6-11 -- the six stats pages hung off the Settings
// page (gfadmin/views.py:2339-2535). All six are read-only GETs; none of
// them mutates anything, so there is no POST route and no CSRF check here.
//
// Django passes section="stats" to every one of them, which matches NO nav
// item in gfadmin/templates/admin/page.html:35-41, so nothing ever
// highlights. The port passes "settings" instead: these pages are reachable
// only from Settings (admin/settings.njk:18-33), so highlighting Settings
// says where you are rather than saying nothing.

const PACKAGING_WEIGHT_PC = 1.18; // givefood/const/general.py:136 -- same constant as routes/admin/order.ts and lists.ts

// The contract admin/stats.njk consumes. Django passed a dict and used
// `{% if value.year %}` (stats.html:18) as a duck-type test for "is this a
// datetime?", to skip |intcomma on it. An ordered ARRAY makes the row order
// explicit instead of depending on JS key-insertion order surviving
// nunjucks, and `raw` names the real intent: "already a display string,
// don't thousands-group it again".
interface StatRow {
  label: string;
  value: string | number;
  raw?: boolean;
}

// Django writes money as `"£%s" % round(cost / 100, 2)` and then pipes it
// through |intcomma, whose regex (^(-?\d+)(\d{3})) cannot match past a
// leading "£" -- so the Cost line is never thousands-grouped, and Python's
// str(float) leaves a whole-pound total rendering as "£1.0". Grouping the
// number BEFORE prefixing the symbol, at a fixed 2dp, is both correct and
// this port's existing house style for exactly these quantities
// (order.ts:34, lists.ts:363). The underlying numbers are unchanged.
const money = (pence: number) => `£${intcomma((pence / 100).toFixed(2))}`;
const kg = (grams: number) => `${intcomma((grams / 1000).toFixed(2))} kg`;

// The Order Stats page is different, and must NOT be given the same fixed
// 2dp: Django hands stats.html:21 bare Python floats there and |intcomma
// with USE_L10N=True (settings.py:212) routes them through
// number_format(force_grouping=True) -> numberformat.format with
// decimal_pos=None, which is str(value) with the integer part grouped.
// views.py:2433 `total_weight = total_weight / 1000` and :2437
// `total_cost = float(total_cost) / 100` are unrounded true division, so
// Django prints "200,123.456" and "12,345.6" where a .toFixed(2) prints
// "200,123.46" (third decimal silently gone) and "12,345.60". JS String()
// and Python repr() both emit the shortest round-tripping decimal, so they
// produce the same digits for the same double.
const pythonFloat = (value: number) => intcomma(String(value));

// views.py:2434-2435 -- the one figure on that page Django DOES round
// before str()ing it, so its trailing zeros drop too ("236,145.6").
const roundedTo2dp = (value: number) => Number(value.toFixed(2));

// lib/isoWeek.ts's parseD1Timestamp() appends a "Z" unconditionally, so a
// value that already ends in "Z" becomes "...ZZ" -> Invalid Date -> a
// "NaN-NaN" week key. Every subscriber row the port writes IS Z-suffixed
// (packages/db/src/subscribers.ts:80/160/279 all use
// new Date().toISOString()), while the pg-to-D1 import wrote the
// space-separated, unsuffixed shape (tools/pg-to-d1/extract_core.py:313) --
// this handles both. Kept local because lib/isoWeek.ts is shared with the
// gfdash weekly dashboards (which carry the same latent bug against
// port-written foodbankchange rows) and fixing it there belongs in its own
// change; see this WP's wiring notes.
function parseStatsTimestamp(value: string): Date {
  return new Date(`${value.replace(" ", "T").replace(/Z$/, "")}Z`);
}

// Accepts only a real calendar date in YYYY-MM-DD. The round-trip through
// Date.UTC is what rejects "2026-02-31", which the regex alone would pass.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function parseIsoDate(value: string | undefined): Date | null {
  if (!value || !ISO_DATE_RE.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toISOString().slice(0, 10) === value ? date : null;
}

// gfadmin/views.py:2339-2386 quarter_stats() -- the report behind the
// Settings page's "Dated Stats" form (settings.njk:20-27), which prefills
// the current calendar quarter.
export async function adminQuarterStats(c: Context<AppEnv>): Promise<Response> {
  const startParam = c.req.query("start");
  const endParam = c.req.query("end");
  const start = parseIsoDate(startParam);
  const end = parseIsoDate(endParam);
  // views.py:2343-2344 passes whatever arrived (including None) straight
  // into datetime.strptime, so a bookmarked or hand-edited URL 500s with a
  // TypeError/ValueError. A 400 says what is actually wrong instead.
  if (!start || !end) {
    return c.text("start and end query parameters are required, in YYYY-MM-DD format", 400);
  }

  // DELIBERATE DIVERGENCE. Django filters `created__lte=end_date` where
  // end_date is that day at 00:00:00, so every row ON the end date is
  // excluded -- and because the Settings form prefills `end` with the LAST
  // DAY of the quarter (views.py:2752-2757, ported at settings.ts:10-21),
  // the final day of every quarterly report Django has ever produced is
  // silently missing. A half-open [start, end+1day) range makes the end
  // date inclusive of its whole day. Figures here will read slightly higher
  // than Django's for the same dates.
  const startDate = start.toISOString().slice(0, 10); // identical to startParam by construction -- parseIsoDate only accepts a value that round-trips
  const endDate = end.toISOString().slice(0, 10);
  const endExclusive = new Date(end.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const db = dbSession(c);
  const stats = await getQuarterStats(db, startDate, endExclusive);

  // Labels verbatim from views.py:2367-2378, in the same order.
  const rows: StatRow[] = [
    // Django renders these two through DATETIME_FORMAT (strptime produced a
    // midnight datetime), so they print as "Sept. 1, 2026, midnight". The
    // user typed dates, so the meaningless time is dropped here.
    { label: "Start Date", value: djangoDate(startDate, "N j, Y"), raw: true },
    { label: "End Date", value: djangoDate(endDate, "N j, Y"), raw: true },
    { label: "Deliveries", value: stats.deliveries },
    { label: "Items", value: stats.items },
    { label: "Weight", value: kg(stats.weightGrams), raw: true },
    { label: "Calories", value: stats.calories },
    { label: "Cost", value: money(stats.costPence), raw: true },
    { label: "Edits", value: stats.edits },
    { label: "Subscriptions", value: stats.newSubscribers },
    { label: "Items Found", value: stats.itemsFound },
  ];

  const html = await render("admin/stats.njk", {
    ...(await adminPageContext(c, "settings")),
    title: "Quarter",
    stats: rows,
  });
  return c.html(html);
}

// gfadmin/views.py:2389-2422 edit_stats() -- how big the data estate is and
// how fresh its edits are.
export async function adminEditStats(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const stats = await getEditStats(db);

  // views.py:2410-2413 counts these three statuses individually;
  // DISCREPANCY_STATUSES = ["New", "Done", "Invalid"]
  // (givefood/const/general.py:55-59). "Total" is the sum of every group
  // returned, so an unexpected status can never make the parts disagree
  // with the whole.
  const byStatus = stats.discrepanciesByStatus;
  const totalDiscrepancies = Object.values(byStatus).reduce((sum, n) => sum + n, 0);

  // Labels verbatim from views.py:2401-2414, in the same order.
  const rows: StatRow[] = [
    { label: "Total Food Banks", value: stats.foodbanks },
    { label: "Total Locations", value: stats.locations },
    { label: "Headline Locations", value: stats.locations + stats.foodbanks }, // views.py:2393
    { label: "Donation Points", value: stats.donationPoints },
    // views.py:2396. Reads LOWER than Django's: see getEditStats' comment on
    // .exclude(delivery_address="") counting every NULL delivery address as
    // a donation point.
    { label: "Headline DP", value: stats.donationPoints + stats.nonAdminAddress + stats.withDeliveryAddress + stats.locationDonationPoints },
    { label: "FB With DP", value: stats.fbWithDonationPoints },
    // Django's bare `{{ datetime }}` is DATETIME_FORMAT, i.e. "N j, Y, P" --
    // same conversion as lists.ts:100-107 and admin/index.njk:70. Never a
    // raw D1 timestamp.
    { label: "Newest Edit", value: stats.newestEdit ? djangoDate(stats.newestEdit, "N j, Y, P") : "", raw: true },
    { label: "Oldest Edit", value: stats.oldestEdit ? djangoDate(stats.oldestEdit, "N j, Y, P") : "", raw: true },
    { label: "Total Discrepancies", value: totalDiscrepancies },
    { label: "Discrepancies Outstanding", value: byStatus["New"] ?? 0 },
    { label: "Discrepancies Invalid", value: byStatus["Invalid"] ?? 0 },
    { label: "Discrepancies Done", value: byStatus["Done"] ?? 0 },
  ];

  const html = await render("admin/stats.njk", {
    ...(await adminPageContext(c, "settings")),
    title: "Edit",
    stats: rows,
  });
  return c.html(html);
}

// gfadmin/views.py:2425-2454 order_stats() -- all-time delivery totals.
export async function adminOrderStats(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const stats = await getOrderStats(db);
  const weightKg = stats.weightGrams / 1000;

  // Labels verbatim from views.py:2439-2446, in the same order, INCLUDING
  // Django's missing units: "Total Weight" is kilograms and "Total Cost" is
  // pounds, and neither the label nor the value says so. Left exactly as
  // the maintainer wrote them rather than quietly relabelled.
  const rows: StatRow[] = [
    { label: "Total Weight", value: pythonFloat(weightKg), raw: true },
    { label: "Total Calories", value: stats.calories },
    { label: "Total Items", value: stats.items },
    { label: "Total Orders", value: stats.totalOrders },
    { label: "Total Cost", value: pythonFloat(stats.costPence / 100), raw: true },
    { label: "Total Weight (inc. packaging)", value: pythonFloat(roundedTo2dp(weightKg * PACKAGING_WEIGHT_PC)), raw: true }, // views.py:2434-2435
  ];

  const html = await render("admin/stats.njk", {
    ...(await adminPageContext(c, "settings")),
    title: "Order",
    stats: rows,
  });
  return c.html(html);
}

// gfadmin/views.py:2457-2470 subscriber_stats() -- confirmed vs unconfirmed
// email subscribers, the only channel this page has ever covered.
export async function adminSubscriberStats(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const stats = await getSubscriberStats(db);

  const rows: StatRow[] = [
    { label: "Confirmed", value: stats.confirmed },
    { label: "Unconfirmed", value: stats.unconfirmed },
  ];

  const html = await render("admin/stats.njk", {
    ...(await adminPageContext(c, "settings")),
    title: "Subscriber",
    stats: rows,
  });
  return c.html(html);
}

interface WeekBucket {
  week_key: string;
  email: number;
  whatsapp: number;
  webpush: number;
  mobile: number;
  total: number;
}

// gfadmin/views.py:2473-2517 subscriber_graph() -- new subscriptions per
// ISO week, stacked by channel. The one stats view with its own template.
export async function adminSubscriberGraph(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const signups = await getSubscriberSignupRows(db);

  // A Map keyed by Django's week key ("calendar year"-"ISO week", quirk
  // included -- see lib/isoWeek.ts). Because the query returns every
  // channel's rows in one global `ORDER BY created`, insertion order is
  // chronological by first occurrence.
  //
  // DELIBERATE DIVERGENCE (fix). Django fills its week_keys OrderedDict
  // email-first (views.py:2482-2500), so a week in which only a web-push or
  // app subscription happened is appended AFTER every email week -- it
  // lands at the far right of the chart and the bottom of the table no
  // matter what its date is. Ordering in SQL makes that defect disappear
  // without an explicit sort, and it also keeps the year-boundary keys
  // right: a "2021-53" bucket holding 1-3 Jan 2021 sorts BEFORE "2021-1",
  // which a naive numeric (year, week) sort would get wrong.
  const buckets = new Map<string, WeekBucket>();
  for (const row of signups) {
    const key = weekKey(parseStatsTimestamp(row.created));
    let bucket = buckets.get(key);
    if (!bucket) {
      // `whatsapp` stays 0 for every week: there is no whatsappsubscriber
      // D1 table (PLAN.md §10.2.6's WP 4.8 note -- inbound messages queue,
      // but the subscribe/unsubscribe command flow that would populate one
      // is unbuilt). The column and the chart series are kept so the shape
      // matches Django's and the gap is visible rather than silently
      // dropped -- same handling as packages/db/src/needAdmin.ts:127-131.
      bucket = { week_key: key, email: 0, whatsapp: 0, webpush: 0, mobile: 0, total: 0 };
      buckets.set(key, bucket);
    }
    bucket[row.channel] += 1;
    bucket.total += 1;
  }

  const html = await render("admin/sub_graph.njk", {
    ...(await adminPageContext(c, "settings")),
    week_subs: [...buckets.values()],
  });
  return c.html(html);
}

// gfadmin/views.py:2520-2535 need_stats().
export async function adminNeedStats(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const stats = await getNeedStats(db);
  // "Items" is the sum of every type group rather than its own COUNT(*),
  // so the total can never disagree with the two lines below it.
  const totalLines = Object.values(stats.linesByType).reduce((sum, n) => sum + n, 0);

  // Labels verbatim from views.py:2522-2527, in the same order.
  const rows: StatRow[] = [
    { label: "Needs", value: stats.needs },
    { label: "Items", value: totalLines },
    { label: "Needed Items", value: stats.linesByType["need"] ?? 0 },
    { label: "Excess Items", value: stats.linesByType["excess"] ?? 0 },
  ];

  const html = await render("admin/stats.njk", {
    ...(await adminPageContext(c, "settings")),
    title: "Need",
    stats: rows,
  });
  return c.html(html);
}
