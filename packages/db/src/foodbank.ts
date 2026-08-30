import { coerceBooleans, queryCoordinates, type CoordinateRow, type Session } from "./types";
import { normalizeUuid } from "./uuid";
import { getNeedById, getNeedsByIds, type FoodbankChangeRow } from "./needs";

const BOOLEAN_COLUMNS = [
  "charity_just_foodbank",
  "place_has_photo",
  "address_is_administrative",
  "is_closed",
  "is_school",
] as const;

export interface FoodbankRow {
  id: number;
  uuid: string; // 32-char dashless
  name: string;
  alt_name: string | null;
  slug: string;
  address: string;
  postcode: string;
  country: string;
  lat_lng: string; // "lat,lng" -- the API emits this verbatim, do not reformat
  latitude: number | null;
  longitude: number | null;
  delivery_address: string | null;
  delivery_lat_lng: string | null;
  network: string | null;
  network_id: string | null;
  notes: string | null;
  charity_number: string | null;
  charity_just_foodbank: boolean;
  charity_id: string | null;
  charity_name: string | null;
  charity_type: string | null;
  charity_reg_date: string | null;
  charity_postcode: string | null;
  charity_website: string | null;
  charity_objectives: string | null;
  charity_purpose: string | null;
  facebook_page: string | null;
  bankuet_slug: string | null;
  fsa_id: string | null;
  contact_email: string;
  notification_email: string | null;
  phone_number: string | null;
  secondary_phone_number: string | null;
  delivery_phone_number: string | null;
  url: string;
  shopping_list_url: string;
  rss_url: string | null;
  news_url: string | null;
  donation_points_url: string | null;
  locations_url: string | null;
  contacts_url: string | null;
  place_id: string | null;
  plus_code_compound: string | null;
  plus_code_global: string | null;
  place_has_photo: boolean | null;
  county: string | null;
  district: string | null;
  ward: string | null;
  lsoa: string | null;
  msoa: string | null;
  parliamentary_constituency_id: number | null;
  parliamentary_constituency_name: string | null;
  parliamentary_constituency_slug: string | null;
  mp: string | null;
  mp_party: string | null;
  mp_parl_id: number | null;
  address_is_administrative: boolean;
  is_closed: boolean;
  is_school: boolean | null;
  no_locations: number;
  no_donation_points: number | null;
  days_between_needs: number;
  footprint: number | null;
  bounds_north: number | null;
  bounds_south: number | null;
  bounds_east: number | null;
  bounds_west: number | null;
  latest_need_id: number | null;
  last_order: string | null;
  last_need: string | null;
  last_rfi: string | null;
  last_crawl: string | null;
  last_social_media_check: string | null;
  last_discrepancy_check: string | null;
  last_need_check: string | null;
  last_charity_check: string | null;
  created: string;
  modified: string;
  edited: string | null;
}

export interface FoodbankWithLatestNeed extends FoodbankRow {
  latestNeed: FoodbankChangeRow | null;
}

function mapFoodbankRow(raw: Record<string, unknown>): FoodbankRow {
  return coerceBooleans<FoodbankRow>(raw, BOOLEAN_COLUMNS);
}

async function attachLatestNeed(session: Session, foodbank: FoodbankRow): Promise<FoodbankWithLatestNeed> {
  const latestNeed = foodbank.latest_need_id === null ? null : await getNeedById(session, foodbank.latest_need_id);
  return { ...foodbank, latestNeed };
}

// gfapi1 `api_foodbanks` -- every row, open or closed (frozen bug B8,
// PLAN.md §7.3: v1 includes closed food banks, v2 does not -- do not
// "harmonise" the two).
export async function getAllFoodbanks(session: Session): Promise<FoodbankRow[]> {
  const result = await session.prepare("SELECT * FROM foodbank").all();
  return result.results.map(mapFoodbankRow);
}

// gfapi2 `foodbanks`, and the candidate set for every nearest-food-bank
// search (gfapi1 `api_foodbank_search`, gfapi2 `foodbank_search`,
// `Foodbank.nearby()`) -- ranking and top-N selection is WP 2.5's job, this
// just returns the full open set the way `get_all_open_foodbanks()` does.
export async function getAllOpenFoodbanks(session: Session): Promise<FoodbankRow[]> {
  const result = await session.prepare("SELECT * FROM foodbank WHERE is_closed = 0").all();
  return result.results.map(mapFoodbankRow);
}

// WP 2.5 perf: the id+coordinate candidate set for ranking a nearest-N
// food bank search (gfapi1 `api_foodbank_search`, gfapi2 `foodbank_search`,
// `Foodbank.nearby()`) -- see queryCoordinates's own comment in types.ts.
// Covered entirely by `foodbank_open_latlng_idx`.
export async function getOpenFoodbankCoordinates(session: Session): Promise<CoordinateRow[]> {
  return queryCoordinates(session, "SELECT id, latitude, longitude FROM foodbank WHERE is_closed = 0");
}

// gfapi1 `api_foodbank` / gfapi2 `foodbank` detail endpoints -- both use
// `select_related("latest_need")` and neither filters `is_closed` (a
// closed food bank is still servable by slug).
export async function getFoodbankBySlug(session: Session, slug: string): Promise<FoodbankWithLatestNeed | null> {
  const row = await session.prepare("SELECT * FROM foodbank WHERE slug = ?").bind(slug).first();
  if (!row) return null;
  return attachLatestNeed(session, mapFoodbankRow(row as Record<string, unknown>));
}

// For enriching a small, already-ranked set of ids with `latest_need` --
// e.g. the top 10/20 results of a nearest-food-bank search, mirroring the
// per-row `foodbank.latest_need` access the Django views do only *after*
// slicing (see PLAN.md §7.2's N+1 note on `foodbank_search`: this is
// deliberate existing behaviour, not something to "fix" into a single join
// over the full open set). `WHERE id IN (...)` gives no ordering guarantee,
// so the result is re-sorted back into the caller's `ids` order -- a caller
// ranking by distance must see that ranking preserved, not D1's rowid order.
//
// The `latest_need` fetch batches all distinct latest_need_ids into ONE
// `WHERE id IN (...)` query rather than one getNeedById() call per row --
// found via real timing comparisons against production (a follow-up to WP
// 2.5): every list/search endpoint calling this with N results was making
// N+1 D1 round trips, and was the slowest thing in the whole API for it.
export async function getFoodbanksByIds(session: Session, ids: readonly number[]): Promise<FoodbankWithLatestNeed[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const result = await session
    .prepare(`SELECT * FROM foodbank WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all();
  const rows = result.results.map((r) => mapFoodbankRow(r as Record<string, unknown>));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = ids.map((id) => byId.get(id)).filter((row): row is FoodbankRow => row !== undefined);

  const needIds = Array.from(
    new Set(ordered.map((row) => row.latest_need_id).filter((id): id is number => id !== null)),
  );
  const needsById = await getNeedsByIds(session, needIds);
  return ordered.map((row) => ({
    ...row,
    latestNeed: row.latest_need_id === null ? null : (needsById.get(row.latest_need_id) ?? null),
  }));
}

// gfapi3 `slugfromid` -- projected to just `slug`, matching Django's
// `.only("slug")`.
export async function getFoodbankSlugByUuid(session: Session, uuid: string): Promise<string | null> {
  const row = await session
    .prepare("SELECT slug FROM foodbank WHERE uuid = ?")
    .bind(normalizeUuid(uuid))
    .first<{ slug: string }>();
  return row ? row.slug : null;
}

// `ParliamentaryConstituency.foodbank_obj()` -- the food-bank half of
// `constituency.foodbanks()`.
export async function getFoodbanksByConstituencyId(session: Session, constituencyId: number): Promise<FoodbankRow[]> {
  const result = await session
    .prepare("SELECT * FROM foodbank WHERE parliamentary_constituency_id = ? AND is_closed = 0")
    .bind(constituencyId)
    .all();
  return result.results.map(mapFoodbankRow);
}

// gfapi2 `donationpoints` -- open food banks with a delivery address,
// surfaced as synthetic donation-point-like features. Matches Django's
// `.exclude(delivery_address__exact='')`: both Postgres and SQLite exclude
// NULL here too (`NULL = ''` is NULL, not true, under either engine's
// three-valued WHERE logic), so no separate `IS NOT NULL` guard is needed.
export async function getOpenFoodbanksWithDeliveryAddress(session: Session): Promise<FoodbankRow[]> {
  const result = await session
    .prepare("SELECT * FROM foodbank WHERE is_closed = 0 AND delivery_address != ''")
    .all();
  return result.results.map(mapFoodbankRow);
}
