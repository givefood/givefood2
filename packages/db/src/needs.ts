import { coerceBooleans, type Session } from "./types";
import { normalizeUuid } from "./uuid";

const BOOLEAN_COLUMNS = ["published", "nonpertinent", "is_categorised"] as const;

export interface FoodbankChangeRow {
  id: number;
  need_id: string; // 32-char dashless; need_id_str is computed at read time, not stored (0001_core.sql)
  foodbank_id: number | null;
  foodbank_name: string | null;
  distill_id: string | null;
  name: string | null;
  uri: string | null;
  change_text: string; // sentinels 'Nothing' / 'Unknown' / 'Facebook' are contract, see PLAN.md §7
  change_text_original: string | null;
  excess_change_text: string | null;
  excess_change_text_original: string | null;
  published: boolean;
  nonpertinent: boolean | null; // NULLABLE: NULL is not the same as false, see PLAN.md §4.4
  is_categorised: boolean | null;
  notified: string | null;
  input_method: string;
  created: string;
  modified: string;
}

// Exported for needcheck.ts (WP 5.2), which reads FoodbankChange rows
// (last published / last unpublished need) as part of the change-detection
// pipeline, rather than duplicating this same boolean-coercion mapping.
export function mapNeedRow(raw: Record<string, unknown>): FoodbankChangeRow {
  return coerceBooleans<FoodbankChangeRow>(raw, BOOLEAN_COLUMNS);
}

// gfapi1 `api_needs` (caller-supplied limit, validated by the handler --
// see frozen bug B4, PLAN.md §7.3: `?limit=abc` is a 500 there, not a 400)
// and gfapi2 `needs` (hardcoded limit=100).
export async function getPublishedNeeds(session: Session, limit: number): Promise<FoodbankChangeRow[]> {
  const result = await session
    .prepare("SELECT * FROM foodbankchange_full WHERE published = 1 ORDER BY created DESC LIMIT ?")
    .bind(limit)
    .all();
  return result.results.map(mapNeedRow);
}

export interface RssNeedRow {
  id: number; // foodbankchange.id -- the numeric FK getNeedTranslationsByIds needs, not the need_id UUID below
  need_id: string;
  change_text: string;
  created: string;
  foodbank_slug: string;
  foodbank_name: string;
  foodbank_alt_name: string | null;
}

// gfwfbn `rss` (givefood/views.py:132-189) -- `FoodbankChange.objects
// .filter(published=True).exclude(change_text__in=("Nothing","Facebook",
// "Unknown")).select_related('foodbank').order_by("-created")[:limit]`,
// optionally further filtered to one food bank. The real joined
// foodbank.slug/name/alt_name (not a slugify() guess -- unlike
// getRecentlyUpdated's homepage use, this needs `reverse("wfbn:foodbank",
// args=[need.foodbank.slug])` and `need.foodbank.full_name()` for real).
export async function getRecentPublishedNeedsForRss(session: Session, limit: number, foodbankId?: number): Promise<RssNeedRow[]> {
  const foodbankFilter = foodbankId !== undefined ? "AND fc.foodbank_id = ? " : "";
  const result = await session
    .prepare(
      "SELECT fc.id, fc.need_id, fc.change_text, fc.created, f.slug AS foodbank_slug, f.name AS foodbank_name, f.alt_name AS foodbank_alt_name " +
        "FROM foodbankchange fc JOIN foodbank f ON f.id = fc.foodbank_id " +
        `WHERE fc.published = 1 AND fc.change_text NOT IN ('Unknown', 'Facebook', 'Nothing') ${foodbankFilter}` +
        "ORDER BY fc.created DESC LIMIT ?",
    )
    .bind(...(foodbankId !== undefined ? [foodbankId, limit] : [limit]))
    .all();
  return result.results as unknown as RssNeedRow[];
}

// gfapi1 `api_need` / gfapi2 `need` -- both look up by the `need_id` UUID,
// accepting either dashed or dashless input.
export async function getNeedByUuid(session: Session, needId: string): Promise<FoodbankChangeRow | null> {
  const row = await session
    .prepare("SELECT * FROM foodbankchange_full WHERE need_id = ?")
    .bind(normalizeUuid(needId))
    .first();
  return row ? mapNeedRow(row as Record<string, unknown>) : null;
}

// Internal: used by foodbank.ts to resolve a single foodbank's
// `latest_need_id` -- two small PK/indexed lookups instead of a
// ~95-column JOIN alias list. D1 meters rows scanned, not returned
// (PLAN.md §4.3); a PK lookup scans exactly one row either way, so this
// costs nothing extra over a JOIN.
export async function getNeedById(session: Session, id: number): Promise<FoodbankChangeRow | null> {
  const row = await session.prepare("SELECT * FROM foodbankchange_full WHERE id = ?").bind(id).first();
  return row ? mapNeedRow(row as Record<string, unknown>) : null;
}

// Internal: used by foodbank.ts to resolve `latest_need_id` for a BATCH of
// foodbank rows -- e.g. every search/list endpoint that ranks or filters
// multiple food banks then needs each one's latest_need. Calling
// getNeedById once per row (even fired concurrently via Promise.all) is
// still N separate D1 round trips; one `WHERE id IN (...)` query is one
// round trip regardless of N. Found via real cache-busted timing
// comparisons against production (WP 2.5 follow-up) -- endpoints doing
// this per-row were the slowest ones, by a wide margin, once the WP 2.5
// covering-index fix landed.
export async function getNeedsByIds(session: Session, ids: readonly number[]): Promise<Map<number, FoodbankChangeRow>> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => "?").join(", ");
  const result = await session
    .prepare(`SELECT * FROM foodbankchange_full WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all();
  const rows = result.results.map((r) => mapNeedRow(r as Record<string, unknown>));
  return new Map(rows.map((row) => [row.id, row]));
}

// gfwfbn `index` view's "by item" category filter -- the food-bank half of
// givefood/utils/geo.py's find_locations_by_category() (:304-404), which
// builds `foodbank_ids_with_category` from
// `Exists(FoodbankChangeLine.objects.filter(need=OuterRef('latest_need'),
// category=category, type='need'))` and then feeds it into
// `FoodbankLocation.objects.filter(foodbank_id__in=foodbank_ids_with_category)`
// -- an unbounded id list that hits D1's 100-bound-parameter cap for any
// common category (PLAN.md §4.8.5 flags this and sketches a
// categories.json-to-R2 precompute; findLocationsByCategory.ts takes a
// simpler route instead -- see that file's own comment).
//
// This query reproduces the `OuterRef('latest_need')` join directly:
// foodbankchangeline is a verbatim mirror of every historical need's line
// items (332,478 rows, migrations/0003_homepage_data.sql), not just each
// food bank's current one, so matching on category+type alone (without
// this join) would also match a food bank whose *past* need had this
// category but whose current one doesn't. Joining on
// `foodbank.latest_need_id = foodbankchangeline.need_id` restricts to
// only each food bank's live need, and `is_closed = 0` mirrors
// find_locations_by_category's own `Foodbank.objects.filter(is_closed=False, ...)`
// on the same queryset. Only ever 2 bound params (category, the literal
// 'need') -- no per-id IN() list, so no D1 bound-parameter ceiling to hit.
export async function getFoodbankIdsByCategory(session: Session, category: string): Promise<number[]> {
  const result = await session
    .prepare(
      `SELECT DISTINCT foodbankchangeline.foodbank_id
       FROM foodbankchangeline
       JOIN foodbank ON foodbank.latest_need_id = foodbankchangeline.need_id AND foodbank.is_closed = 0
       WHERE foodbankchangeline.category = ? AND foodbankchangeline.type = 'need'`,
    )
    .bind(category)
    .all();
  return result.results.map((row) => (row as { foodbank_id: number }).foodbank_id);
}
