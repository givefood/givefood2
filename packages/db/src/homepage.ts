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
      "SELECT foodbank_name FROM foodbankchange_full " +
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
//
// AGGREGATE FIRST, JOIN SECOND (issue #43). The obvious spelling --
// `FROM foodbankhit h JOIN foodbank f ... GROUP BY h.foodbank_id` -- makes
// SQLite look `foodbank` up once per HIT ROW, before grouping, and then throw
// almost all of those lookups away: measured on production D1 (2026-09-07,
// window 2026-08-31..2026-09-07) that is 6,177 index rows counted twice (range
// scan + GROUP BY b-tree) + 6,177 rowid lookups + 1,051 groups + 8 = 19,582
// rows_read for eight names. Doing the SUM in a subquery and joining only the
// `limit` survivors reads 13,413 and halves the SQL time (medians over five
// interleaved runs: 18.1ms -> 8.3ms). The result set was byte-identical.
//
// ONE BEHAVIOURAL DIFFERENCE, and it is not cosmetic: the join that drops hit
// rows whose food bank has been deleted now happens AFTER the LIMIT, so an
// orphaned hit ranking inside the top `limit` consumes a slot and this can
// return FEWER than `limit` rows where the pre-#43 query returned `limit`.
// D1 has no foreign keys (PLAN.md §4.5) and `foodbankhit` is ETL-loaded, so
// that is reachable in principle; on production all 1,051 grouped foodbank_ids
// resolve today. homepage.test.ts pins it rather than leaving it to be
// rediscovered. Do NOT "fix" it by moving the join back inside -- that is the
// 6,000 rows this exists to avoid.
export async function getMostViewed(session: Session, sinceDay: string, untilDay: string, limit: number): Promise<MostViewedRow[]> {
  const result = await session
    .prepare(
      "SELECT f.name, f.slug FROM (" +
        "SELECT foodbank_id, SUM(hits) AS total_hits FROM foodbankhit " +
        "WHERE day >= ? AND day <= ? " +
        "GROUP BY foodbank_id " +
        "ORDER BY total_hits DESC LIMIT ?" +
        ") t JOIN foodbank f ON f.id = t.foodbank_id " +
        "ORDER BY t.total_hits DESC",
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
  "SELECT a.id, a.foodbank_id, f.name AS foodbank_name, f.slug AS foodbank_slug, a.published_date, a.title, a.url, a.featured " +
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
// FeaturedArticleRow rather than a near-duplicate interface. Also backs
// gfdash's `articles` dashboard (WP 4.5), unfiltered with a 200-row limit.
//
// 0003_homepage_data.sql originally seeded featured=true rows only (168 of
// 17,194 in production) -- WP 4.5's dashboard needed the rest, so
// tools/pg-to-d1/extract_core.py's DASHBOARD_TABLES now backfills the full
// table (2026-08-31). `article_published_idx` (`WHERE featured = 1`) still
// only covers getFeaturedArticles() above; this unfiltered query has never
// used it.
export async function getRecentArticles(session: Session, limit: number): Promise<FeaturedArticleRow[]> {
  const result = await session
    .prepare(`${ARTICLE_SELECT}ORDER BY a.published_date DESC LIMIT ?`)
    .bind(limit)
    .all();
  return result.results.map((r) => coerceBooleans<FeaturedArticleRow>(r as Record<string, unknown>, ["featured"]));
}

// Foodbank.articles() (givefood/models/foodbank.py:307-309) -- md_foodbank_news's
// `foodbank.articles`, same row shape/join as getFeaturedArticles above,
// scoped to one food bank instead of the featured=1 filter. Backed by the
// full table since the 2026-08-31 backfill -- see getRecentArticles above.
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
      "SELECT f.name AS foodbank_name FROM foodbankchange fc " +
        "JOIN foodbank f ON f.id = fc.foodbank_id " +
        "WHERE fc.published = 1 AND fc.change_text NOT IN ('Unknown', 'Facebook', 'Nothing') " +
        "AND f.name IS NOT NULL AND f.country = ? " +
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
//
// Same aggregate-then-join shape as getMostViewed (issue #43), but the inner
// join STAYS INSIDE: `country` lives on `foodbank`, so the filter cannot be
// applied without it and the pre-group lookups cannot be avoided. rows_read is
// therefore unchanged bar the outer join's `limit` extra lookups (England
// 18,047 -> 18,057, measured), and only the ranking gets cheaper -- SQLite
// sorts and truncates two integer columns instead of dragging name/slug
// through the temp b-tree. Medians over five interleaved production runs:
// 12.5ms -> 10.6ms for England, with the new shape faster in 4 of 5 pairs and
// a tie in the fifth. A smaller win than getMostViewed's, and it is kept for
// the ranking cost and for the two statements staying legible as a pair.
//
// Unlike getMostViewed, this one has no orphaned-hit caveat: the inner join is
// still inside the LIMIT, so a hit row with no food bank never reaches the
// ranking and the row count cannot move.
export async function getMostViewedByCountry(
  session: Session,
  sinceDay: string,
  untilDay: string,
  countryName: string,
  limit: number,
): Promise<MostViewedRow[]> {
  const result = await session
    .prepare(
      "SELECT f.name, f.slug FROM (" +
        "SELECT h.foodbank_id AS foodbank_id, SUM(h.hits) AS total_hits " +
        "FROM foodbankhit h JOIN foodbank fb ON fb.id = h.foodbank_id " +
        "WHERE h.day >= ? AND h.day <= ? AND fb.country = ? " +
        "GROUP BY h.foodbank_id " +
        "ORDER BY total_hits DESC LIMIT ?" +
        ") t JOIN foodbank f ON f.id = t.foodbank_id " +
        "ORDER BY t.total_hits DESC",
    )
    .bind(sinceDay, untilDay, countryName, limit)
    .all();
  return result.results as unknown as MostViewedRow[];
}
