import type { Session } from "./types";

// gfdash's 20 public analytics dashboards (WP 4.5, gfdash/views.py). Two
// families of query design decisions run through this whole file:
//
// 1. ISO week grouping (weekly_itemcount/weekly_itemcount_year) has no
//    SQLite equivalent -- strftime('%W', ...) is week-of-year Sun-start,
//    not ISO 8601 Mon-start-with-year-boundary-carry the way Python's
//    date.isocalendar() is. Fetched narrow and grouped in JS instead (see
//    lib/isoWeek.ts in workers/site).
// 2. beautybanks' three Django OR-chains (254 London postcode prefixes x
//    39 product keywords x a dynamic foodbank-id list) are the query
//    PLAN.md flags as likely to hit D1's statement-depth limit. Rewritten
//    as one SQL query carrying only the 39-term product keyword chain
//    (safely small) plus a join for foodbank name/slug/postcode/lat_lng;
//    the London postcode-prefix match and the three needs slices (all/
//    London/recent) are all plain JS over that one result set -- see
//    getBeautyBankProductNeeds below.

// ---------------------------------------------------------------------------
// weekly_itemcount / weekly_itemcount_year

export interface NeedForWeeklyCountRow {
  change_text: string;
  created: string;
}

// gfdash `weekly_itemcount`/`weekly_itemcount_year` (views.py:27-80) --
// `FoodbankChange.objects.filter(created__gt=date(2020,1,1),
// published=True).order_by("created")`, narrowed to the two columns the
// per-need loop actually reads (`no_items()` needs change_text; the week
// key needs created).
export async function getPublishedNeedsForWeeklyCount(session: Session): Promise<NeedForWeeklyCountRow[]> {
  const result = await session
    .prepare("SELECT change_text, created FROM foodbankchange WHERE published = 1 AND created > '2020-01-01' ORDER BY created")
    .all<NeedForWeeklyCountRow>();
  return result.results;
}

// ---------------------------------------------------------------------------
// most_requested_items / tt_most_requested_items

export interface LatestNeedTextRow {
  change_text: string;
}

// gfdash `most_requested_items` (views.py:83-143) --
// `Foodbank.objects.select_related("latest_need").filter([network=
// "Trussell",] last_need__gt=threshold).order_by("-last_need")`, read as a
// single join instead of Django's per-row `.latest_need` access (N+1 there
// -- select_related avoids it in the ORM, but the equivalent D1 shape is
// the join itself, not N follow-up queries).
export async function getLatestNeedTextsSince(
  session: Session,
  sinceIso: string,
  trusselltrust: boolean,
): Promise<LatestNeedTextRow[]> {
  const networkFilter = trusselltrust ? "AND f.network = 'Trussell' " : "";
  const result = await session
    .prepare(
      `SELECT fc.change_text AS change_text FROM foodbank f ` +
        `JOIN foodbankchange fc ON fc.id = f.latest_need_id ` +
        `WHERE f.last_need > ? ${networkFilter}ORDER BY f.last_need DESC`,
    )
    .bind(sinceIso)
    .all<LatestNeedTextRow>();
  return result.results;
}

// ---------------------------------------------------------------------------
// most_excess_items

export interface LatestExcessTextRow {
  excess_change_text: string | null;
}

// gfdash `most_excess_items` (views.py:146-195) -- same join shape as
// getLatestNeedTextsSince, reading excess_change_text instead, no network
// filter.
export async function getLatestExcessTextsSince(session: Session, sinceIso: string): Promise<LatestExcessTextRow[]> {
  const result = await session
    .prepare(
      "SELECT fc.excess_change_text AS excess_change_text FROM foodbank f " +
        "JOIN foodbankchange fc ON fc.id = f.latest_need_id " +
        "WHERE f.last_need > ? ORDER BY f.last_need DESC",
    )
    .bind(sinceIso)
    .all<LatestExcessTextRow>();
  return result.results;
}

// ---------------------------------------------------------------------------
// item_categories / item_groups

export interface CategoryCountRow {
  category: string;
  count: number;
}

// gfdash `item_categories` (views.py:199-206) --
// `FoodbankChangeLine.objects.filter(type="need").values("category")
// .annotate(count=Count("category")).order_by("-count")`. Covered by
// fcl_cat_need_idx (category, need_id) WHERE type = 'need'.
export async function getNeedItemCategoryCounts(session: Session): Promise<CategoryCountRow[]> {
  const result = await session
    .prepare("SELECT category, COUNT(*) AS count FROM foodbankchangeline WHERE type = 'need' GROUP BY category ORDER BY count DESC")
    .all<CategoryCountRow>();
  return result.results;
}

export interface GroupCountRow {
  group_name: string;
  count: number;
}

// gfdash `item_groups` (views.py:210-217) -- same shape, grouped by
// group_name (Postgres's `group`, renamed -- see foodbankchangeline's DDL
// comment).
export async function getNeedItemGroupCounts(session: Session): Promise<GroupCountRow[]> {
  const result = await session
    .prepare("SELECT group_name, COUNT(*) AS count FROM foodbankchangeline WHERE type = 'need' GROUP BY group_name ORDER BY count DESC")
    .all<GroupCountRow>();
  return result.results;
}

// ---------------------------------------------------------------------------
// tt_old_data

export interface TrussellFoodbankRow {
  name: string;
  url: string;
  last_need: string | null;
}

// gfdash `tt_old_data` (views.py:220-230) -- two opposite-ordered slices of
// the same filter, narrowed to the three columns the template reads.
export async function getTrussellFoodbanksByLastNeed(
  session: Session,
  direction: "ASC" | "DESC",
  limit: number,
): Promise<TrussellFoodbankRow[]> {
  const result = await session
    .prepare(`SELECT name, url, last_need FROM foodbank WHERE network = 'Trussell' AND is_closed = 0 ORDER BY last_need ${direction} LIMIT ?`)
    .bind(limit)
    .all<TrussellFoodbankRow>();
  return result.results;
}

// ---------------------------------------------------------------------------
// articles
//
// gfdash `articles` (views.py:234-241) --
// `FoodbankArticle.objects.all().order_by("-published_date")[:200]`. Uses
// homepage.ts's existing getRecentArticles(session, limit) -- same query
// shape (unfiltered, published_date DESC, joined for the real foodbank
// slug), no need for a second copy here.

// ---------------------------------------------------------------------------
// beautybanks

export interface BeautyBankNeedRow {
  foodbank_id: number;
  foodbank_name: string | null;
  foodbank_slug: string;
  postcode: string;
  lat_lng: string;
  change_text: string;
  created: string;
}

// gfdash's 39 hardcoded product keywords (views.py:247-288), verbatim.
export const BEAUTYBANKS_PRODUCTS = [
  "Soap", "Shampoo", "Shower Gel", "Toothpaste", "Toothbrush", "Tooth brush", "Deodorant", "Razor",
  "Shaving Gel", "Shaving Foam", "Conditioner", "Sanitary Pad", "Sanitary Towel", "Tampon", "Toiletries",
  "Toiletry", "Bubble Bath", "Face Wash", "Facewash", "Moisturiser", "SPF", "Lip Balm", "Lipbalm",
  "Hand Cream", "Handcream", "Body Wash", "Bodywash", "Body Lotion", "Baby wash", "Babywash",
  "Baby lotion", "Baby soap", "Baby shampoo", "Baby oil", "Baby powder", "Baby cream", "Baby wipes",
  "Skin Care", "Make Up", "Makeup",
] as const;

// gfdash `beautybanks` (views.py:245-335). Django ORs `change_text__
// contains=product` for all 39 products into one Q() chain -- safely small
// (well under any real limit), unlike the 254-term postcode chain and the
// dynamic foodbank-id chain this rewrite drops entirely (see this file's
// header comment). One join gets everything all three template slices
// (all_needs, london_needs, time_since_needs) need: foodbank name/slug/
// postcode/lat_lng plus the need's own change_text/created. published-only,
// most recent first -- callers slice/filter in JS.
export async function getBeautyBankProductNeeds(session: Session): Promise<BeautyBankNeedRow[]> {
  const likeClauses = BEAUTYBANKS_PRODUCTS.map(() => "fc.change_text LIKE ?").join(" OR ");
  const likeParams = BEAUTYBANKS_PRODUCTS.map((product) => `%${product}%`);
  const result = await session
    .prepare(
      `SELECT fc.foodbank_id AS foodbank_id, fc.foodbank_name AS foodbank_name, f.slug AS foodbank_slug, ` +
        `f.postcode AS postcode, f.lat_lng AS lat_lng, fc.change_text AS change_text, fc.created AS created ` +
        `FROM foodbankchange fc JOIN foodbank f ON f.id = fc.foodbank_id ` +
        `WHERE fc.published = 1 AND (${likeClauses}) ORDER BY fc.created DESC`,
    )
    .bind(...likeParams)
    .all<BeautyBankNeedRow>();
  return result.results;
}

// ---------------------------------------------------------------------------
// excess

export interface ExcessNeedRow {
  foodbank_name: string | null;
  excess_change_text: string | null;
  created: string;
}

// gfdash `excess` (views.py:338-344) --
// `FoodbankChange.objects.filter(published=True).order_by("-created")[:200]`,
// narrowed to the three columns excess.html reads.
export async function getRecentPublishedChanges(session: Session, limit: number): Promise<ExcessNeedRow[]> {
  const result = await session
    .prepare("SELECT foodbank_name, excess_change_text, created FROM foodbankchange_full WHERE published = 1 ORDER BY created DESC LIMIT ?")
    .bind(limit)
    .all<ExcessNeedRow>();
  return result.results;
}

// ---------------------------------------------------------------------------
// foodbanks_found

// gfdash `foodbanks_found` (views.py:347-362) -- `get_all_foodbanks()`
// (open and closed both -- a since-closed food bank was still discovered
// on its `created` date), narrowed to the one column the cumulative-count
// loop reads.
export async function getFoodbankCreatedDates(session: Session): Promise<string[]> {
  const result = await session.prepare("SELECT created FROM foodbank ORDER BY created").all<{ created: string }>();
  return result.results.map((r) => r.created);
}

// ---------------------------------------------------------------------------
// bean_pasta_index

export interface MonthCountRow {
  the_month: string;
  count: number;
}

// gfdash `bean_pasta_index` (views.py:382-391) -- Postgres raw SQL
// (`to_char(created, 'YYYY-MM')`, `~*` case-insensitive regex) rewritten
// for SQLite: strftime for the month key, and plain LIKE for the keyword
// match -- SQLite's LIKE case-folds ASCII by default, so it's already
// case-insensitive for these two plain-ASCII words with no LOWER()
// needed.
export async function getBeanPastaMonthCounts(session: Session): Promise<MonthCountRow[]> {
  const result = await session
    .prepare(
      "SELECT strftime('%Y-%m', created) AS the_month, COUNT(*) AS count FROM foodbankchange " +
        "WHERE published = 1 AND (change_text LIKE '%beans%' OR change_text LIKE '%pasta%') " +
        "GROUP BY the_month ORDER BY the_month",
    )
    .all<MonthCountRow>();
  return result.results;
}

// ---------------------------------------------------------------------------
// deliveries

export type DeliveryMetric = "count" | "items" | "weight" | "calories";

const DELIVERY_METRIC_SQL: Record<DeliveryMetric, string> = {
  count: "COUNT(*)",
  items: "SUM(no_items)",
  weight: "SUM(weight) / 1000",
  calories: "SUM(calories)",
};

// gfdash `deliveries` (views.py:394-421) -- Postgres raw SQL
// (`to_char(delivery_datetime, 'YYYY-MM')`) rewritten with strftime.
// `metric` is validated against DeliveryMetric by the route (matching
// Django's `re_path` enum) before this ever builds SQL, so the lookup is a
// fixed-string substitution from an allowlist, never user input.
export async function getDeliveryMonthCounts(session: Session, metric: DeliveryMetric): Promise<MonthCountRow[]> {
  const metricSql = DELIVERY_METRIC_SQL[metric];
  const result = await session
    .prepare(`SELECT strftime('%Y-%m', delivery_datetime) AS the_month, ${metricSql} AS count FROM orders GROUP BY the_month ORDER BY the_month`)
    .all<MonthCountRow>();
  return result.results;
}

// ---------------------------------------------------------------------------
// supermarkets

export interface CompanyCountRow {
  company: string;
  count: number;
}

// gfdash `supermarkets` (views.py:424-434) --
// `FoodbankDonationPoint.objects.filter(company__isnull=False)
// .values("company").annotate(count=Count("company")).order_by("-count")`
// plus the unfiltered-grouping total count.
export async function getSupermarketDonationPointCounts(session: Session): Promise<CompanyCountRow[]> {
  const result = await session
    .prepare("SELECT company, COUNT(*) AS count FROM foodbankdonationpoint WHERE company IS NOT NULL GROUP BY company ORDER BY count DESC")
    .all<CompanyCountRow>();
  return result.results;
}

export async function getSupermarketDonationPointTotal(session: Session): Promise<number> {
  const row = await session
    .prepare("SELECT COUNT(*) AS total FROM foodbankdonationpoint WHERE company IS NOT NULL")
    .first<{ total: number }>();
  return row?.total ?? 0;
}

// ---------------------------------------------------------------------------
// charity_income_expenditure

export interface CharityYearAggregateRow {
  year: string;
  income: number;
  expenditure: number;
}

// gfdash `charity_income_expenditure` (views.py:438-446) --
// `CharityYear.objects.filter(foodbank__charity_just_foodbank=True,
// date__year__gte=five_years_ago).values("date__year")
// .annotate(income=Sum("income"), expenditure=Sum("expenditure"))
// .order_by("-date__year")`.
export async function getCharityYearAggregates(session: Session, sinceYear: number): Promise<CharityYearAggregateRow[]> {
  const result = await session
    .prepare(
      "SELECT strftime('%Y', cy.date) AS year, SUM(cy.income) AS income, SUM(cy.expenditure) AS expenditure " +
        "FROM charityyear cy JOIN foodbank f ON f.id = cy.foodbank_id " +
        "WHERE f.charity_just_foodbank = 1 AND CAST(strftime('%Y', cy.date) AS INTEGER) >= ? " +
        "GROUP BY year ORDER BY year DESC",
    )
    .bind(sinceYear)
    .all<CharityYearAggregateRow>();
  return result.results;
}

// ---------------------------------------------------------------------------
// price_per_kg / price_per_calorie shared order aggregates

export interface OrderTotalsRow {
  items: number;
  weightTonnes: number;
  numberFoodbanks: number;
}

export async function getOrderWeightTotals(session: Session): Promise<OrderTotalsRow> {
  const row = await session
    .prepare("SELECT SUM(no_items) AS items, SUM(weight) / 1000000.0 AS weight_tonnes, COUNT(DISTINCT foodbank_id) AS number_foodbanks FROM orders")
    .first<{ items: number; weight_tonnes: number; number_foodbanks: number }>();
  return { items: row?.items ?? 0, weightTonnes: row?.weight_tonnes ?? 0, numberFoodbanks: row?.number_foodbanks ?? 0 };
}

export interface OrderCalorieTotalsRow {
  items: number;
  calories: number;
  numberFoodbanks: number;
}

export async function getOrderCalorieTotals(session: Session): Promise<OrderCalorieTotalsRow> {
  const row = await session
    .prepare("SELECT SUM(no_items) AS items, SUM(calories) AS calories, COUNT(DISTINCT foodbank_id) AS number_foodbanks FROM orders")
    .first<{ items: number; calories: number; number_foodbanks: number }>();
  return { items: row?.items ?? 0, calories: row?.calories ?? 0, numberFoodbanks: row?.number_foodbanks ?? 0 };
}

// ---------------------------------------------------------------------------
// price_per_kg

export interface MonthPriceRow {
  year: number;
  month: number; // 1-12
  price: number;
}

// gfdash `price_per_kg` (views.py:449-464) --
// `Order.objects.annotate(month=TruncMonth('delivery_datetime'),
// year=TruncYear('delivery_datetime')).values('month','year')
// .annotate(total_weight=Sum('weight'), total_cost=Sum('cost')/100,
// price_per_kg=Sum('cost')*1000/Sum('weight')).order_by('month')`.
// year/month come back as plain numbers here rather than Django's nested
// date-object shape -- the ported template indexes them directly.
export async function getPricePerKgByMonth(session: Session): Promise<MonthPriceRow[]> {
  const result = await session
    .prepare(
      "SELECT CAST(strftime('%Y', delivery_datetime) AS INTEGER) AS year, " +
        "CAST(strftime('%m', delivery_datetime) AS INTEGER) AS month, " +
        "(SUM(cost) * 1000) / SUM(weight) AS price " +
        "FROM orders GROUP BY year, month ORDER BY year, month",
    )
    .all<MonthPriceRow>();
  return result.results;
}

// ---------------------------------------------------------------------------
// price_per_calorie

export interface MonthCaloriePriceRow {
  year: number;
  month: number; // 1-12
  price: number;
}

// gfdash `price_per_calorie` (views.py:531-558) -- same TruncMonth/
// TruncYear shape as price_per_kg, over OrderLine instead of Order, only
// lines with calories > 0.
export async function getPricePerCalorieByMonth(session: Session): Promise<MonthCaloriePriceRow[]> {
  const result = await session
    .prepare(
      "SELECT CAST(strftime('%Y', delivery_date) AS INTEGER) AS year, " +
        "CAST(strftime('%m', delivery_date) AS INTEGER) AS month, " +
        "(SUM(line_cost) * 2000) / SUM(calories) AS price " +
        "FROM orderline WHERE calories > 0 AND delivery_date IS NOT NULL " +
        "GROUP BY year, month ORDER BY year, month",
    )
    .all<MonthCaloriePriceRow>();
  return result.results;
}

// ---------------------------------------------------------------------------
// price_per_item_category

export interface CategoryTotalRow {
  category: string;
  total_count: number;
}

const MIN_ITEMS_FOR_CATEGORY = 100;

// gfdash `price_per_item_category` (views.py:472-528), stage 1: qualifying
// categories.
export async function getOrderLineCategoryTotals(session: Session): Promise<CategoryTotalRow[]> {
  const result = await session
    .prepare(
      "SELECT category, COUNT(*) AS total_count FROM orderline WHERE category IS NOT NULL " +
        "GROUP BY category HAVING total_count >= ? ORDER BY total_count DESC",
    )
    .bind(MIN_ITEMS_FOR_CATEGORY)
    .all<CategoryTotalRow>();
  return result.results;
}

export interface CategoryMonthPriceRow {
  the_month: string; // "YYYY-MM"
  category: string;
  price_per_item: number;
}

// Stage 2: monthly average price-per-item for the qualifying categories
// only (categoryNames from getOrderLineCategoryTotals above).
export async function getOrderLineCategoryMonthPrices(session: Session, categoryNames: readonly string[]): Promise<CategoryMonthPriceRow[]> {
  if (categoryNames.length === 0) return [];
  const placeholders = categoryNames.map(() => "?").join(", ");
  const result = await session
    .prepare(
      `SELECT strftime('%Y-%m', delivery_date) AS the_month, category, ` +
        `SUM(item_cost) / COUNT(*) AS price_per_item ` +
        `FROM orderline WHERE category IN (${placeholders}) AND delivery_date IS NOT NULL ` +
        `GROUP BY the_month, category ORDER BY the_month, category`,
    )
    .bind(...categoryNames)
    .all<CategoryMonthPriceRow>();
  return result.results;
}
