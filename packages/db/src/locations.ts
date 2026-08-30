import { coerceBooleans, sortByName, type Session } from "./types";

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

function mapLocationRow(raw: Record<string, unknown>): FoodbankLocationRow {
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

// gfapi2 `locations`, and the candidate set for `location_search`.
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
