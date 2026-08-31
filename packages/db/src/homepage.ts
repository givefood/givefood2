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

// index()'s `articles` -- FoodbankArticle.select_related('foodbank'),
// joined here for the real foodbank.slug (favicon/link URLs), not a
// slugify() of the denormalised name the way recently_updated is.
export async function getFeaturedArticles(session: Session, limit: number): Promise<FeaturedArticleRow[]> {
  const result = await session
    .prepare(
      "SELECT a.id, a.foodbank_id, a.foodbank_name, f.slug AS foodbank_slug, a.published_date, a.title, a.url, a.featured " +
        "FROM foodbankarticle a JOIN foodbank f ON f.id = a.foodbank_id " +
        "WHERE a.featured = 1 " +
        "ORDER BY a.published_date DESC LIMIT ?",
    )
    .bind(limit)
    .all();
  return result.results.map((r) => coerceBooleans<FeaturedArticleRow>(r as Record<string, unknown>, ["featured"]));
}
