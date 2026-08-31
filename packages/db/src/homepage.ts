import { coerceBooleans, type Session } from "./types";

// givefood/views.py's index() (WP 2.2a follow-up, see PLAN.md's
// migrations/0003_homepage_data.sql note). Every query here reads from the
// homepage-only tables copied by tools/pg-to-d1/extract_core.py's
// HOMEPAGE_TABLES, not the original 5-table WP 2.2a scope.

export interface SiteStatsRow {
  foodbanks: number;
  donationpoints: number;
  items: number;
  meals: number;
  computed_at: string;
}

// get_site_stats() (givefood/utils/cache.py) -- precomputed by the
// extraction tool into a single row rather than aggregated at request
// time, see 0003_homepage_data.sql's comment.
export async function getSiteStats(session: Session): Promise<SiteStatsRow | null> {
  const row = await session
    .prepare("SELECT foodbanks, donationpoints, items, meals, computed_at FROM site_stats WHERE id = 1")
    .first();
  return row as SiteStatsRow | null;
}

export interface RecentlyUpdatedRow {
  foodbank_name: string;
}

// index()'s `recently_updated` -- no join to `foodbank`, matching Django's
// own `.only('foodbank_name')` (the template slugifies foodbank_name
// itself, via FoodbankChange.foodbank_name_slug(), rather than reading a
// real foodbank.slug).
export async function getRecentlyUpdated(session: Session, limit: number): Promise<RecentlyUpdatedRow[]> {
  const result = await session
    .prepare(
      "SELECT foodbank_name FROM foodbankchange " +
        "WHERE published = 1 AND change_text NOT IN ('Unknown', 'Facebook', 'Nothing') AND foodbank_name IS NOT NULL " +
        "ORDER BY created DESC LIMIT ?",
    )
    .bind(limit)
    .all();
  return result.results as unknown as RecentlyUpdatedRow[];
}

export interface MostViewedRow {
  name: string;
  slug: string;
}

// index()'s `most_viewed` -- Foodbank.objects filtered to hits in the
// trailing 7 days (today inclusive), summed and ranked. `day` is stored
// TEXT 'YYYY-MM-DD' (0003_homepage_data.sql), which sorts/compares
// correctly as plain text for ISO dates.
export async function getMostViewed(session: Session, sinceDay: string, untilDay: string, limit: number): Promise<MostViewedRow[]> {
  const result = await session
    .prepare(
      "SELECT f.name, f.slug FROM foodbankhit h " +
        "JOIN foodbank f ON f.id = h.foodbank_id " +
        "WHERE h.day >= ? AND h.day <= ? " +
        "GROUP BY h.foodbank_id " +
        "ORDER BY SUM(h.hits) DESC LIMIT ?",
    )
    .bind(sinceDay, untilDay, limit)
    .all();
  return result.results as unknown as MostViewedRow[];
}

export interface FeaturedArticleRow {
  id: number;
  foodbank_id: number | null;
  foodbank_name: string | null;
  foodbank_slug: string;
  published_date: string;
  title: string;
  url: string;
  featured: boolean;
}

// Shared SELECT/JOIN behind getFeaturedArticles/getRecentArticles/
// getArticlesByFoodbankId below -- same row shape/join (FeaturedArticleRow),
// each function differs only in its WHERE clause.
const ARTICLE_SELECT =
  "SELECT a.id, a.foodbank_id, a.foodbank_name, f.slug AS foodbank_slug, a.published_date, a.title, a.url, a.featured " +
  "FROM foodbankarticle a JOIN foodbank f ON f.id = a.foodbank_id ";

// index()'s `articles` -- FoodbankArticle.select_related('foodbank'),
// joined here for the real foodbank.slug (favicon/link URLs), not a
// slugify() of the denormalised name the way recently_updated is.
export async function getFeaturedArticles(session: Session, limit: number): Promise<FeaturedArticleRow[]> {
  const result = await session
    .prepare(`${ARTICLE_SELECT}WHERE a.featured = 1 ORDER BY a.published_date DESC LIMIT ?`)
    .bind(limit)
    .all();
  return result.results.map((r) => coerceBooleans<FeaturedArticleRow>(r as Record<string, unknown>, ["featured"]));
}

// news()'s `articles` (givefood/views.py:582-590) --
// FoodbankArticle.select_related('foodbank').order_by('-published_date')[:100],
// deliberately WITHOUT the `featured = 1` filter getFeaturedArticles() above
// applies -- the /news/ page shows every recent article, not just featured
// ones. Same row shape/join as getFeaturedArticles(), so it reuses
// FeaturedArticleRow rather than a near-duplicate interface.
//
// KNOWN DATA-SCOPE GAP: 0003_homepage_data.sql's own comment says the D1
// `foodbankarticle` table was seeded with featured=true rows ONLY (168 of
// 17,194 in production) -- "the homepage only ever reads the 5 most recent
// featured articles; copying the other 17k for a query that never runs
// isn't worth it. Revisit if a future /news/ page needs the rest." That
// future page is this one: until a fuller extraction lands, this query is
// correct but can only ever return the featured subset already present in
// D1, not a true "last 100 articles" (also note `article_published_idx` is
// a partial index `WHERE featured = 1`, so this unfiltered query doesn't
// use it -- unmeasured, but moot at the table's current ~168-row size).
export async function getRecentArticles(session: Session, limit: number): Promise<FeaturedArticleRow[]> {
  const result = await session
    .prepare(`${ARTICLE_SELECT}ORDER BY a.published_date DESC LIMIT ?`)
    .bind(limit)
    .all();
  return result.results.map((r) => coerceBooleans<FeaturedArticleRow>(r as Record<string, unknown>, ["featured"]));
}

// Foodbank.articles() (givefood/models/foodbank.py:307-309) -- md_foodbank_news's
// `foodbank.articles`, same row shape/join as getFeaturedArticles above,
// scoped to one food bank instead of the featured=1 filter. Same
// KNOWN DATA-SCOPE GAP as getRecentArticles above -- will be empty or
// near-empty for most food banks until a fuller article ETL lands.
export async function getArticlesByFoodbankId(session: Session, foodbankId: number, limit: number): Promise<FeaturedArticleRow[]> {
  const result = await session
    .prepare(`${ARTICLE_SELECT}WHERE a.foodbank_id = ? ORDER BY a.published_date DESC LIMIT ?`)
    .bind(foodbankId, limit)
    .all();
  return result.results.map((r) => coerceBooleans<FeaturedArticleRow>(r as Record<string, unknown>, ["featured"]));
}

// givefood `country()` (givefood/views.py:213-281) -- the country-scoped
// twin of index()'s `recently_updated` above: same exclusion list and
// `published = 1` filter, but additionally joined to `foodbank` to filter
// by the denormalised `country` column (Django's
// `foodbank__country=country_name`), something the homepage's own
// unscoped query never needs. The view over-fetches (LIMIT 50) and
// deduplicates by foodbank_name in Python, keeping the first 10 unique
// names; that fetch-then-dedupe step is the caller's job (D1 has no
// simple "distinct on, keep original order" primitive), so this function
// just returns the raw (still possibly-duplicate) top `limit` rows, same
// contract as the Python queryset before its dedup loop runs.
export async function getRecentlyUpdatedByCountry(
  session: Session,
  countryName: string,
  limit: number,
): Promise<RecentlyUpdatedRow[]> {
  const result = await session
    .prepare(
      "SELECT fc.foodbank_name FROM foodbankchange fc " +
        "JOIN foodbank f ON f.id = fc.foodbank_id " +
        "WHERE fc.published = 1 AND fc.change_text NOT IN ('Unknown', 'Facebook', 'Nothing') " +
        "AND fc.foodbank_name IS NOT NULL AND f.country = ? " +
        "ORDER BY fc.created DESC LIMIT ?",
    )
    .bind(countryName, limit)
    .all();
  return result.results as unknown as RecentlyUpdatedRow[];
}

// givefood `country()` (givefood/views.py:213-281) -- the country-scoped
// twin of index()'s `most_viewed` above (same trailing-7-day hit window),
// filtered by the denormalised `country` column the same way
// getRecentlyUpdatedByCountry is.
export async function getMostViewedByCountry(
  session: Session,
  sinceDay: string,
  untilDay: string,
  countryName: string,
  limit: number,
): Promise<MostViewedRow[]> {
  const result = await session
    .prepare(
      "SELECT f.name, f.slug FROM foodbankhit h " +
        "JOIN foodbank f ON f.id = h.foodbank_id " +
        "WHERE h.day >= ? AND h.day <= ? AND f.country = ? " +
        "GROUP BY h.foodbank_id " +
        "ORDER BY SUM(h.hits) DESC LIMIT ?",
    )
    .bind(sinceDay, untilDay, countryName, limit)
    .all();
  return result.results as unknown as MostViewedRow[];
}
