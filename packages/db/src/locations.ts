import { coerceBooleans, queryCoordinates, sortByName, type CoordinateRow, type Session } from "./types";

// Exported so other narrow, boundary_geojson-excluding row shapes (e.g.
// constituencies.ts's getFoodbanksForConstituency) can coerce the same
// boolean columns without a second copy of this list.
export const LOCATION_BOOLEAN_COLUMNS = ["place_has_photo", "is_closed", "is_donation_point", "is_mobile"] as const;
const BOOLEAN_COLUMNS = LOCATION_BOOLEAN_COLUMNS;

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

// `Foodbank.locations()` -- used by `api_foodbank`/`foodbank(slug)`. That
// model method is `FoodbankLocation.objects.filter(foodbank =
// self).order_by("name")` (givefood/models/foodbank.py:546) -- explicitly
// sorted at the Postgres end. Deliberately no `is_closed` filter: a food
// bank's location list can, and does, include closed locations even when
// the food bank itself is open. Sorted in JS, not SQL -- see sortByName's
// comment in types.ts.
export async function getLocationsByFoodbankId(session: Session, foodbankId: number): Promise<FoodbankLocationRow[]> {
  const result = await session
    .prepare("SELECT * FROM foodbanklocation_full WHERE foodbank_id = ?")
    .bind(foodbankId)
    .all();
  return sortByName(result.results.map(mapLocationRow));
}

// workers/jobs' map.png backfill (mediaBackfill/mapImage.ts) only ever
// needs each location's lat_lng for a marker list -- PLAN.md's hard rule
// again, see getAllOpenLocationSlugs's own comment. No name-sort needed
// either (Google draws markers in whatever order the list arrives in).
export async function getLocationLatLngsByFoodbankId(session: Session, foodbankId: number): Promise<string[]> {
  const result = await session.prepare("SELECT lat_lng FROM foodbanklocation WHERE foodbank_id = ?").bind(foodbankId).all();
  return result.results.map((r) => (r as { lat_lng: string }).lat_lng);
}

// gfwfbn `geojson`'s slug-only branch (WP 3.6): builds its OWN
// `FoodbankLocation.objects.filter(foodbank__slug = slug)` directly
// (gfwfbn/views.py:238) rather than calling `foodbank.locations()` above
// -- no `.order_by("name")`, so unlike getLocationsByFoodbankId this must
// NOT be name-sorted. Confirmed against a live per-foodbank geo.json
// response for a food bank with 6 locations: feature order there is
// neither alphabetical nor foodbank id order, but it DOES match Postgres
// physical (ctid) scan order exactly for that row -- i.e. genuinely "no
// ORDER BY", not a hidden sort. D1's own un-ORDER-BY'd row order is the
// closest available match, but "no ORDER BY" is formally undefined SQL:
// Postgres's query planner can pick a different physical strategy per
// table (a live donation-points response for the SAME food bank came
// back in an order this ctid theory does NOT explain -- see
// getDonationPointsByFoodbankIdUnsorted's own comment), and neither is
// reproducible byte-for-byte from a different engine's query planner.
// This is the best faithful choice available, not a guaranteed-exact one.
// Same "no is_closed filter" behaviour as getLocationsByFoodbankId.
export async function getLocationsByFoodbankIdUnsorted(session: Session, foodbankId: number): Promise<FoodbankLocationRow[]> {
  const result = await session
    .prepare("SELECT * FROM foodbanklocation_full WHERE foodbank_id = ?")
    .bind(foodbankId)
    .all();
  return result.results.map(mapLocationRow);
}

// gfapi2 `locations`, and the full-detail source for `location_search`'s
// surviving winners (see getOpenLocationCoordinates for the cheap
// candidate-set version ranking actually runs against).
export async function getAllOpenLocations(session: Session): Promise<FoodbankLocationRow[]> {
  const result = await session.prepare("SELECT * FROM foodbanklocation_full WHERE is_closed = 0").all();
  return result.results.map(mapLocationRow);
}

// Every column of `foodbanklocation_full` EXCEPT boundary_geojson, for the
// projected variants below. constituencies.ts holds a second copy of this
// same list (LOCATION_COLUMNS_NARROW there, for getFoodbanksForConstituency)
// -- deliberately not shared, because importing it from there would close an
// import cycle (constituencies.ts already imports FoodbankLocationRow and
// LOCATION_BOOLEAN_COLUMNS from this file). Both copies are guarded the same
// way, by a pragma-driven drift test that reads the view's real columns and
// fails when a migration adds one: see locations.test.ts and
// constituencies.test.ts:961-969.
//
// EXPORTED for foodbankDetail.ts (github #49), which imports from this file
// already and so adds no third copy. That direction is the one that does not
// cycle; the constituencies.ts copy stays where it is.
export const LOCATION_COLUMNS_NARROW =
  "id, uuid, foodbank_id, foodbank_name, foodbank_slug, foodbank_network, foodbank_phone_number, foodbank_email, " +
  "name, slug, address, postcode, country, lat_lng, latitude, longitude, place_id, plus_code_compound, plus_code_global, " +
  "place_has_photo, county, district, ward, lsoa, msoa, parliamentary_constituency_id, parliamentary_constituency_name, " +
  "parliamentary_constituency_slug, mp, mp_party, mp_parl_id, is_closed, is_donation_point, is_mobile, phone_number, " +
  "email, modified, edited";

// The row LOCATION_COLUMNS_NARROW yields, and its mapper. Declared here
// rather than beside either of its callers because there are now two of them
// -- constituencies.ts's getFoodbanksForConstituency and foodbankDetail.ts's
// getLocationsDonationPointsAndNearbyFoodbanks -- and both are describing the
// same thing: a location row with the ~1.6 MB boundary blob left in D1.
export type FoodbankLocationRowNarrow = Omit<FoodbankLocationRow, "boundary_geojson">;

export function mapLocationRowNarrow(raw: Record<string, unknown>): FoodbankLocationRowNarrow {
  return coerceBooleans<FoodbankLocationRowNarrow>(raw, BOOLEAN_COLUMNS);
}

// The full row with the blob replaced by a 0/1 flag. `has_boundary` is
// deliberately NOT run through coerceBooleans: 0/1 is what the SQL yields,
// it is falsy/truthy in both JS and Nunjucks exactly as the raw string was,
// and the three sites that test the original column
// (public/wfbn/locations.njk, location.njk, wfbn/locationDetail.ts) are a
// Nunjucks `not`, a Nunjucks `and` and a JS ternary -- all correct on 0/1.
//
// `(x IS NOT NULL AND x != '')` yields 0 or 1 and never NULL: `NULL IS NOT
// NULL` is 0 and `0 AND ...` short-circuits. It matches JS/Nunjucks
// truthiness of the raw string for every stored value, whitespace-only
// included ('  ' is truthy in both, and '  ' != '' is 1).
export type FoodbankLocationRowFlagged = Omit<FoodbankLocationRow, "boundary_geojson"> & { has_boundary: 0 | 1 };

// getAllOpenLocations, minus the blob. /api/2/locations/ (the site's largest
// payload) and the all-items /needs/geo.json feed both read this whole row
// and neither emits boundary_geojson -- buildGeojson.ts's `includeBoundary`
// is false for the all-items scope, and api2/locations.ts names its fields
// explicitly in both the json and geojson branches.
//
// PLAN.md:2982's hard rule -- the one that justifies keeping boundaries in
// D1 at all, "nothing in the codebase issues SELECT * on
// parliamentaryconstituency or foodbanklocation" -- is what this restores.
// Measured against production D1: 6,504,107 -> 3,037,895 bytes of result
// payload (-3,466,212, -53%) and, over 7 interleaved runs of each, a median
// D1-reported duration of 161 ms (115-219) -> 99 ms (84-128). 1,962 rows, of
// which only 40 carry a boundary at all. rows_read is UNCHANGED at 3,924 --
// D1 bills rows read, so this is wire bytes and latency, not money. Timed
// through the D1 REST API from a laptop, not inside the Worker: the byte
// figures are hard, the millisecond ones are indicative.
export async function getAllOpenLocationsFlagged(session: Session): Promise<FoodbankLocationRowFlagged[]> {
  const result = await session
    .prepare(
      `SELECT ${LOCATION_COLUMNS_NARROW}, (boundary_geojson IS NOT NULL AND boundary_geojson != '') AS has_boundary ` +
        "FROM foodbanklocation_full WHERE is_closed = 0",
    )
    .all();
  return result.results.map((r) => coerceBooleans<FoodbankLocationRowFlagged>(r as Record<string, unknown>, BOOLEAN_COLUMNS));
}

// sitemap.xml only ever needs foodbank_slug/slug -- PLAN.md's hard rule
// ("nothing in the codebase issues SELECT * on parliamentaryconstituency
// or foodbanklocation") exists specifically because boundary_geojson is a
// large TEXT blob on this table; getAllOpenLocations() above would pull
// ~2,000 of those just to read two string columns off each row.
export async function getAllOpenLocationSlugs(session: Session): Promise<Array<{ foodbank_slug: string; slug: string }>> {
  const result = await session.prepare("SELECT foodbank_slug, slug FROM foodbanklocation_full WHERE is_closed = 0").all();
  return result.results as unknown as Array<{ foodbank_slug: string; slug: string }>;
}

// sitemap.md's variant of the above -- same narrow-column reasoning, plus
// `name` for the link text (the XML sitemap has no link text, only <loc>).
export async function getAllOpenLocationSlugsWithNames(
  session: Session,
): Promise<Array<{ foodbank_slug: string; slug: string; name: string }>> {
  const result = await session.prepare("SELECT foodbank_slug, slug, name FROM foodbanklocation_full WHERE is_closed = 0").all();
  return result.results as unknown as Array<{ foodbank_slug: string; slug: string; name: string }>;
}

// Candidate set for the location branch of `donationpoint_search`
// (`FoodbankLocation.objects.filter(is_closed=False, is_donation_point=True)`).
// `is_donation_point = 1` naturally excludes NULL rows under D1's
// three-valued WHERE logic, matching Django's `is_donation_point=True`.
export async function getOpenDonationPointLocations(session: Session): Promise<FoodbankLocationRow[]> {
  const result = await session
    .prepare("SELECT * FROM foodbanklocation_full WHERE is_closed = 0 AND is_donation_point = 1")
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

// Candidate set for the location branch of `find_locations_by_category`
// (findLocationsByCategory.ts) -- the plain `getOpenLocationCoordinates`
// candidate set plus `foodbank_id`, needed there because "does this
// location's food bank need this category" can only be tested against the
// location's *parent*, not the location row itself (PLAN.md §4.8.5: "the
// category is a property of the parent food bank's latest_need, but the
// points being ranked are food banks and locations"). Not a covering-index
// scan the way the plain coordinate query is (`foodbank_id` isn't in
// `loc_open_latlng_idx`), but still id+3-columns, nowhere near the cost of
// a full row.
export interface LocationCoordinateRow extends CoordinateRow {
  foodbank_id: number;
}

export async function getOpenLocationCoordinatesWithFoodbankId(session: Session): Promise<LocationCoordinateRow[]> {
  const result = await session
    .prepare("SELECT id, latitude, longitude, foodbank_id FROM foodbanklocation WHERE is_closed = 0")
    .all();
  return result.results as unknown as LocationCoordinateRow[];
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
    .prepare(`SELECT * FROM foodbanklocation_full WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all();
  const rows = result.results.map((r) => mapLocationRow(r as Record<string, unknown>));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter((row): row is FoodbankLocationRow => row !== undefined);
}

// gfwfbn `geojson`'s locslug branch (WP 3.6):
// `FoodbankLocation.objects.filter(slug=locslug, foodbank__slug=slug)` --
// a single row, or none. `foodbank_slug` is the denormalised column
// already on this table (see FoodbankLocationRow), so this is a
// single-table lookup, no join needed to reproduce Django's
// `foodbank__slug` filter.
export async function getFoodbankLocationBySlugs(
  session: Session,
  foodbankSlug: string,
  locationSlug: string,
): Promise<FoodbankLocationRow | null> {
  const row = await session
    .prepare("SELECT * FROM foodbanklocation_full WHERE slug = ? AND foodbank_slug = ?")
    .bind(locationSlug, foodbankSlug)
    .first();
  return row ? mapLocationRow(row as Record<string, unknown>) : null;
}

// `ParliamentaryConstituency.location_obj()` -- the location half of
// `constituency.foodbanks()`.
export async function getOpenLocationsByConstituencyId(
  session: Session,
  constituencyId: number,
): Promise<FoodbankLocationRow[]> {
  const result = await session
    .prepare("SELECT * FROM foodbanklocation_full WHERE parliamentary_constituency_id = ? AND is_closed = 0")
    .bind(constituencyId)
    .all();
  return result.results.map(mapLocationRow);
}

// givefood `country_geojson` (givefood/views.py:285-427) -- the location
// half of a country-scoped feed, same shape as
// `getOpenLocationsByConstituencyId` above
// (`FoodbankLocation.objects.filter(country = country_name,
// is_closed=False)`), just filtered by the denormalised `country` column
// instead of a constituency id.
export async function getOpenLocationsByCountry(session: Session, countryName: string): Promise<FoodbankLocationRow[]> {
  const result = await session
    .prepare("SELECT * FROM foodbanklocation_full WHERE country = ? AND is_closed = 0")
    .bind(countryName)
    .all();
  return result.results.map(mapLocationRow);
}
