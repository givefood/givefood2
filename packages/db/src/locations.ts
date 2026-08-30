import { coerceBooleans, queryCoordinates, sortByName, type CoordinateRow, type Session } from "./types";

const BOOLEAN_COLUMNS = ["place_has_photo", "is_closed", "is_donation_point", "is_mobile"] as const;

export interface FoodbankLocationRow {
  id: number;
  uuid: string;
  foodbank_id: number;
  foodbank_name: string;
  foodbank_slug: string;
  foodbank_network: string;
  foodbank_phone_number: string | null;
  foodbank_email: string;
  name: string;
  slug: string;
  address: string | null;
  postcode: string | null;
  country: string;
  lat_lng: string;
  latitude: number | null;
  longitude: number | null;
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
  is_closed: boolean;
  is_donation_point: boolean | null; // NULLABLE in production despite the model's declared NOT NULL, see 0001_core.sql
  is_mobile: boolean | null; // same
  boundary_geojson: string | null;
  phone_number: string | null;
  email: string | null;
  modified: string;
  edited: string | null;
}

export function mapLocationRow(raw: Record<string, unknown>): FoodbankLocationRow {
  return coerceBooleans<FoodbankLocationRow>(raw, BOOLEAN_COLUMNS);
}

// `Foodbank.locations()` -- used by `api_foodbank`/`foodbank(slug)`.
// Deliberately no `is_closed` filter: a food bank's location list can, and
// does, include closed locations even when the food bank itself is open.
// Sorted in JS, not SQL -- see sortByName's comment in types.ts.
export async function getLocationsByFoodbankId(session: Session, foodbankId: number): Promise<FoodbankLocationRow[]> {
  const result = await session
    .prepare("SELECT * FROM foodbanklocation WHERE foodbank_id = ?")
    .bind(foodbankId)
    .all();
  return sortByName(result.results.map(mapLocationRow));
}

// gfapi2 `locations`, and the full-detail source for `location_search`'s
// surviving winners (see getOpenLocationCoordinates for the cheap
// candidate-set version ranking actually runs against).
export async function getAllOpenLocations(session: Session): Promise<FoodbankLocationRow[]> {
  const result = await session.prepare("SELECT * FROM foodbanklocation WHERE is_closed = 0").all();
  return result.results.map(mapLocationRow);
}

// Candidate set for the location branch of `donationpoint_search`
// (`FoodbankLocation.objects.filter(is_closed=False, is_donation_point=True)`).
// `is_donation_point = 1` naturally excludes NULL rows under D1's
// three-valued WHERE logic, matching Django's `is_donation_point=True`.
export async function getOpenDonationPointLocations(session: Session): Promise<FoodbankLocationRow[]> {
  const result = await session
    .prepare("SELECT * FROM foodbanklocation WHERE is_closed = 0 AND is_donation_point = 1")
    .all();
  return result.results.map(mapLocationRow);
}

// WP 2.5 perf: the id+coordinate candidate set for ranking `location_search`
// -- see queryCoordinates's own comment in types.ts. Covered entirely by
// `loc_open_latlng_idx`.
export async function getOpenLocationCoordinates(session: Session): Promise<CoordinateRow[]> {
  return queryCoordinates(session, "SELECT id, latitude, longitude FROM foodbanklocation WHERE is_closed = 0");
}

// Same, for the location branch of `donationpoint_search` -- covered by
// `loc_open_dp_latlng_idx`.
export async function getOpenDonationPointLocationCoordinates(session: Session): Promise<CoordinateRow[]> {
  return queryCoordinates(
    session,
    "SELECT id, latitude, longitude FROM foodbanklocation WHERE is_closed = 0 AND is_donation_point = 1",
  );
}

// Foodbank.has_service_area() -- a live count, not a cached field (the
// Python source queries FoodbankLocation fresh on every call, no
// annotation/cache column exists to read instead).
export async function hasServiceArea(session: Session, foodbankId: number): Promise<boolean> {
  const row = await session
    .prepare(
      "SELECT COUNT(*) AS n FROM foodbanklocation WHERE foodbank_id = ? AND boundary_geojson IS NOT NULL AND boundary_geojson != ''",
    )
    .bind(foodbankId)
    .first();
  return ((row as { n: number } | null)?.n ?? 0) > 0;
}

// Full rows for a small, already-ranked set of location ids -- the
// location-typed winners of `location_search`/`donationpoint_search`,
// fetched after ranking against the cheap coordinate-only candidate set
// above. Same order-preservation reasoning as `getFoodbanksByIds`: a bare
// `WHERE id IN (...)` gives no ordering guarantee, so the result is
// re-sorted back into the caller's `ids` order.
export async function getLocationsByIds(session: Session, ids: readonly number[]): Promise<FoodbankLocationRow[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const result = await session
    .prepare(`SELECT * FROM foodbanklocation WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all();
  const rows = result.results.map((r) => mapLocationRow(r as Record<string, unknown>));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter((row): row is FoodbankLocationRow => row !== undefined);
}

// `ParliamentaryConstituency.location_obj()` -- the location half of
// `constituency.foodbanks()`.
export async function getOpenLocationsByConstituencyId(
  session: Session,
  constituencyId: number,
): Promise<FoodbankLocationRow[]> {
  const result = await session
    .prepare("SELECT * FROM foodbanklocation WHERE parliamentary_constituency_id = ? AND is_closed = 0")
    .bind(constituencyId)
    .all();
  return result.results.map(mapLocationRow);
}
