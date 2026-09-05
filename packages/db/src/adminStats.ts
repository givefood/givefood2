import type { Session } from "./types";

// gfadmin/urls/stats.py:6-11 -- the six Settings-page stats views
// (gfadmin/views.py:2339-2535). Everything here returns RAW counts, grams
// and pence: no division, no rounding, no currency symbols. Unit conversion
// and display formatting live in workers/site/src/routes/admin/stats.ts,
// same split as the rest of packages/db.
//
// Django computes most of these with a query per number (and, in
// quarter_stats, a Python loop over the whole Order queryset). D1 meters
// rows scanned and bills round trips, so each view here is one batch of
// aggregates instead -- identical numbers, far fewer rows on the wire. Each
// rewrite that changes SQL SEMANTICS rather than just shape is called out
// individually below.

export interface QuarterStats {
  deliveries: number;
  weightGrams: number;
  items: number;
  calories: number;
  costPence: number;
  edits: number;
  newSubscribers: number;
  itemsFound: number;
}

// gfadmin/views.py:2339-2386 quarter_stats(). `startDate` and
// `endExclusiveDate` are both "YYYY-MM-DD"; the caller has already turned
// the user's inclusive end date into an exclusive upper bound (see
// routes/admin/stats.ts for why that differs from Django).
//
// The bounds are date-only strings, which makes the TEXT comparison safe
// across BOTH stored timestamp shapes in this database -- the pg-to-D1
// import wrote "YYYY-MM-DD HH:MM:SS.ffffff" (tools/pg-to-d1/
// extract_core.py:313) while every row the port writes is
// `new Date().toISOString()` ("YYYY-MM-DDTHH:MM:SS.sssZ"). Both sort
// identically against a bare date prefix.
//
// The four SUMs replace views.py:2349-2358's Python accumulation over the
// whole queryset. COALESCE covers SQLite's SUM-over-zero-rows = NULL, which
// is also the exact crash Django has at views.py:2433 on an empty table.
// Nothing is divided in SQL: SQLite's `/` on two INTEGERs truncates, so
// grams and pence come back whole and the route does the true division
// Python 3 does at views.py:2360-2361.
export async function getQuarterStats(session: Session, startDate: string, endExclusiveDate: string): Promise<QuarterStats> {
  const results = await session.batch([
    session
      .prepare(
        `SELECT COUNT(*) AS deliveries,
                COALESCE(SUM(weight), 0)   AS weight_g,
                COALESCE(SUM(no_items), 0) AS items,
                COALESCE(SUM(calories), 0) AS calories,
                COALESCE(SUM(cost), 0)     AS cost_pence
         FROM orders
         WHERE created >= ?1 AND created < ?2`,
      )
      .bind(startDate, endExclusiveDate),
    session.prepare("SELECT COUNT(*) AS n FROM foodbank WHERE edited >= ?1 AND edited < ?2").bind(startDate, endExclusiveDate),
    // NOT filtered on `confirmed` -- views.py:2364 isn't either. This counts
    // sign-ups in the window whether or not the double-opt-in completed.
    session.prepare("SELECT COUNT(*) AS n FROM foodbanksubscriber WHERE created >= ?1 AND created < ?2").bind(startDate, endExclusiveDate),
    session.prepare("SELECT COUNT(*) AS n FROM foodbankchangeline WHERE created >= ?1 AND created < ?2").bind(startDate, endExclusiveDate),
  ]);

  // batch() returns one result per input statement, in order -- exactly 4
  // here, so these indexes are never out of range despite
  // noUncheckedIndexedAccess flagging them as possibly so (same note as
  // foodbankDetail.ts's own batch).
  const orders = results[0]!.results[0] as { deliveries: number; weight_g: number; items: number; calories: number; cost_pence: number } | undefined;
  const edits = results[1]!.results[0] as { n: number } | undefined;
  const subscribers = results[2]!.results[0] as { n: number } | undefined;
  const itemsFound = results[3]!.results[0] as { n: number } | undefined;

  return {
    deliveries: orders?.deliveries ?? 0,
    weightGrams: orders?.weight_g ?? 0,
    items: orders?.items ?? 0,
    calories: orders?.calories ?? 0,
    costPence: orders?.cost_pence ?? 0,
    edits: edits?.n ?? 0,
    newSubscribers: subscribers?.n ?? 0,
    itemsFound: itemsFound?.n ?? 0,
  };
}

export interface EditStats {
  foodbanks: number;
  locations: number;
  donationPoints: number;
  nonAdminAddress: number;
  withDeliveryAddress: number;
  locationDonationPoints: number;
  fbWithDonationPoints: number;
  oldestEdit: string | null;
  newestEdit: string | null;
  discrepanciesByStatus: Record<string, number>;
}

// gfadmin/views.py:2389-2422 edit_stats(). Eight COUNT queries plus two
// ORDER BY ... LIMIT 1 lookups collapse into four statements in one batch.
// No `is_closed` filter anywhere -- Django counts open and closed food
// banks, locations and donation points alike, and this page is "how big is
// the data estate", not "how much is live". Deliberate parity (unlike
// adminDashboardStats.ts, which does filter is_closed for the dashboard's
// edit-age numbers).
export async function getEditStats(session: Session): Promise<EditStats> {
  const results = await session.batch([
    session.prepare(
      `SELECT COUNT(*) AS foodbanks,
              -- views.py:2396's .exclude(address_is_administrative=True).
              -- Column is INTEGER NOT NULL, so Postgres's NOT (col = TRUE)
              -- and SQLite's col = 0 agree exactly.
              SUM(CASE WHEN address_is_administrative = 0 THEN 1 ELSE 0 END) AS non_admin_address,
              -- DELIBERATE DIVERGENCE from views.py:2396's
              -- .exclude(delivery_address=""). Django compiles that to
              -- NOT (delivery_address = '' AND delivery_address IS NOT NULL),
              -- which is TRUE for NULL -- so today every food bank with a
              -- NULL delivery address is counted as HAVING a delivery
              -- donation point. The model's own per-row rule
              -- (givefood/models/foodbank.py:514, "if self.delivery_address:")
              -- treats NULL and "" identically as "no". The port follows the
              -- model, so "Headline DP" comes out LOWER than Django's.
              SUM(CASE WHEN delivery_address IS NOT NULL AND delivery_address != '' THEN 1 ELSE 0 END) AS with_delivery_address,
              -- views.py:2406's .exclude(no_donation_points=0). Django's model
              -- declares the column non-nullable so its SQL is a bare
              -- NOT (col = 0); D1 declares it NULLABLE (0001_core.sql:38),
              -- where a bare != 0 would silently drop the NULL rows. COALESCE
              -- restores the model's default=0 semantics.
              SUM(CASE WHEN COALESCE(no_donation_points, 0) != 0 THEN 1 ELSE 0 END) AS fb_with_dp,
              -- views.py:2398-2399 uses order_by("-edited")[:1][0] /
              -- order_by("edited")[:1][0]. "edited" is nullable
              -- (givefood/models/base.py:34) and Postgres defaults to NULLS
              -- FIRST for DESC, so Django's "Newest Edit" prints "None" the
              -- moment one food bank has never been edited; SQLite's opposite
              -- defaults would break "Oldest Edit" instead. Aggregate
              -- MIN/MAX ignore NULLs on both engines, so one construct is
              -- correct everywhere -- and it also removes Django's [:1][0]
              -- IndexError on an empty table.
              MIN(edited) AS oldest_edit,
              MAX(edited) AS newest_edit
       FROM foodbank`,
    ),
    // views.py:2392/2396. is_donation_point is NULLABLE (0001_core.sql:71);
    // `= 1` excludes NULLs, exactly as Django's filter(is_donation_point=True)
    // does under Postgres three-valued logic.
    session.prepare(
      `SELECT COUNT(*) AS locations,
              SUM(CASE WHEN is_donation_point = 1 THEN 1 ELSE 0 END) AS location_donation_points
       FROM foodbanklocation_full`,
    ),
    session.prepare("SELECT COUNT(*) AS donation_points FROM foodbankdonationpoint"),
    // views.py:2409-2413's four separate COUNTs over 95k rows become one
    // index-only scan of discrepancy_status_created_idx. The caller derives
    // "Total Discrepancies" by summing the groups, so the total can never
    // disagree with the parts if an unexpected status value exists.
    session.prepare("SELECT status, COUNT(*) AS n FROM foodbankdiscrepancy GROUP BY status"),
  ]);

  const fb = results[0]!.results[0] as
    | { foodbanks: number; non_admin_address: number | null; with_delivery_address: number | null; fb_with_dp: number | null; oldest_edit: string | null; newest_edit: string | null }
    | undefined;
  const loc = results[1]!.results[0] as { locations: number; location_donation_points: number | null } | undefined;
  const dp = results[2]!.results[0] as { donation_points: number } | undefined;
  const discrepancyRows = results[3]!.results as Array<{ status: string; n: number }>;

  const discrepanciesByStatus: Record<string, number> = {};
  for (const row of discrepancyRows) discrepanciesByStatus[row.status] = row.n;

  return {
    foodbanks: fb?.foodbanks ?? 0,
    locations: loc?.locations ?? 0,
    donationPoints: dp?.donation_points ?? 0,
    nonAdminAddress: fb?.non_admin_address ?? 0,
    withDeliveryAddress: fb?.with_delivery_address ?? 0,
    locationDonationPoints: loc?.location_donation_points ?? 0,
    fbWithDonationPoints: fb?.fb_with_dp ?? 0,
    oldestEdit: fb?.oldest_edit ?? null,
    newestEdit: fb?.newest_edit ?? null,
    discrepanciesByStatus,
  };
}

export interface OrderStats {
  totalOrders: number;
  weightGrams: number;
  calories: number;
  items: number;
  costPence: number;
}

// gfadmin/views.py:2425-2454 order_stats() -- five queries (four separate
// aggregate() calls plus a count()) become one. COALESCE fixes Django's
// TypeError at views.py:2433, where Sum() returns None on an empty table
// and the very next line divides it by 1000.
export async function getOrderStats(session: Session): Promise<OrderStats> {
  const row = await session
    .prepare(
      `SELECT COUNT(*) AS total_orders,
              COALESCE(SUM(weight), 0)   AS weight_g,
              COALESCE(SUM(calories), 0) AS calories,
              COALESCE(SUM(no_items), 0) AS items,
              COALESCE(SUM(cost), 0)     AS cost_pence
       FROM orders`,
    )
    .first<{ total_orders: number; weight_g: number; calories: number; items: number; cost_pence: number }>();

  return {
    totalOrders: row?.total_orders ?? 0,
    weightGrams: row?.weight_g ?? 0,
    calories: row?.calories ?? 0,
    items: row?.items ?? 0,
    costPence: row?.cost_pence ?? 0,
  };
}

export interface SubscriberStats {
  confirmed: number;
  unconfirmed: number;
}

// gfadmin/views.py:2457-2470 subscriber_stats(). Email subscribers only --
// the other three channels aren't represented on this page in Django
// either. `confirmed` is INTEGER NOT NULL DEFAULT 0
// (0004_subscribers.sql:22), so 0/1 is exhaustive and one pass over the
// table answers both halves.
export async function getSubscriberStats(session: Session): Promise<SubscriberStats> {
  const row = await session
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN confirmed = 1 THEN 1 ELSE 0 END), 0) AS confirmed,
              COALESCE(SUM(CASE WHEN confirmed = 0 THEN 1 ELSE 0 END), 0) AS unconfirmed
       FROM foodbanksubscriber`,
    )
    .first<{ confirmed: number; unconfirmed: number }>();

  return { confirmed: row?.confirmed ?? 0, unconfirmed: row?.unconfirmed ?? 0 };
}

export type SubscriberChannel = "email" | "webpush" | "mobile";

export interface SubscriberSignupRow {
  channel: SubscriberChannel;
  created: string;
}

// gfadmin/views.py:2473-2517 subscriber_graph(). Django materialises four
// whole querysets in Python; this is one UNION ALL of two narrow columns
// (~5,950 rows today: 5,855 + 49 + 47).
//
// No week-bucketing in SQL, deliberately. Django's key is
// `"%s-%s" % (created.year, created.isocalendar()[1])` -- a CALENDAR year
// glued to an ISO week number. SQLite's strftime('%W') is a Sunday-start
// week-of-year, not ISO 8601, and nothing built in reproduces Python's
// isocalendar(). Same finding as dashboards.ts:6-10 for the two gfdash
// weekly dashboards, same resolution: fetch narrow, bucket in JS with
// lib/isoWeek.ts's weekKey(), which reproduces the calendar-year/ISO-week
// mismatch verbatim.
//
// The global ORDER BY created is load-bearing: it is what makes the
// caller's Map insertion order chronological, which is the fix for Django's
// email-first x-axis ordering (views.py:2482-2500). On a compound SELECT
// the ORDER BY resolves against the left-most SELECT's output column name,
// which is valid SQLite.
//
// WhatsApp is absent because there is no `whatsappsubscriber` D1 table
// (PLAN.md §10.2.6's WP 4.8 note: inbound messages already queue, but the
// subscribe/unsubscribe command flow that would populate a table like this
// is still unbuilt) -- same gap, and same handling, as
// needAdmin.ts:127-138. The caller keeps the column pinned at 0.
//
// This is the one unbounded read in this file, and it stays unbounded on
// purpose: the page IS the whole history, so there is nothing to paginate.
// Two narrow columns over ~5,950 rows is a cheap scan today. If
// foodbanksubscriber ever grows past ~100k, pre-aggregate instead --
// SELECT channel, date(created) AS day, COUNT(*) AS n ... GROUP BY channel,
// day ORDER BY day -- and bucket days into weeks in JS; date() copes with
// both stored timestamp shapes.
export async function getSubscriberSignupRows(session: Session): Promise<SubscriberSignupRow[]> {
  const result = await session
    .prepare(
      `SELECT 'email'   AS channel, created FROM foodbanksubscriber WHERE confirmed = 1
       UNION ALL
       SELECT 'webpush' AS channel, created FROM webpushsubscription
       UNION ALL
       SELECT 'mobile'  AS channel, created FROM mobilesubscriber
       ORDER BY created`,
    )
    .all<SubscriberSignupRow>();
  return result.results;
}

export interface NeedStats {
  needs: number;
  linesByType: Record<string, number>;
}

// gfadmin/views.py:2520-2535 need_stats(). views.py:2524-2526's three full
// scans of the 332k-row foodbankchangeline become one index-only scan of
// fcl_type_idx; the caller sums the groups for "Items" so the total and the
// parts can never disagree. NEED_LINE_TYPES = ["need", "excess"]
// (givefood/const/general.py:31-34). No published/nonpertinent filter on
// the FoodbankChange count -- views.py:2523 has none either.
export async function getNeedStats(session: Session): Promise<NeedStats> {
  const results = await session.batch([
    session.prepare("SELECT COUNT(*) AS needs FROM foodbankchange"),
    session.prepare("SELECT type, COUNT(*) AS n FROM foodbankchangeline GROUP BY type"),
  ]);

  const needs = results[0]!.results[0] as { needs: number } | undefined;
  const typeRows = results[1]!.results as Array<{ type: string; n: number }>;

  const linesByType: Record<string, number> = {};
  for (const row of typeRows) linesByType[row.type] = row.n;

  return { needs: needs?.needs ?? 0, linesByType };
}
