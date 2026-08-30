import { coerceBooleans, queryCoordinates, sortByName, type CoordinateRow, type Session } from "./types";

const BOOLEAN_COLUMNS = ["place_has_photo", "is_closed", "in_store_only", "wheelchair_accessible"] as const;

export interface DonationPointRow {
  id: number;
  uuid: string;
  foodbank_id: number;
  foodbank_name: string;
  foodbank_slug: string;
  foodbank_network: string;
  name: string;
  slug: string;
  address: string;
  postcode: string;
  country: string | null; // NULLABLE in production despite the model's declared NOT NULL, see 0001_core.sql
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
  in_store_only: boolean;
  phone_number: string | null;
  url: string | null;
  opening_hours: string | null;
  wheelchair_accessible: boolean | null; // TRI-STATE: null means "unknown", never coalesce to false
  company: string | null;
  company_slug: string | null;
  store_id: string | null;
  notes: string | null;
  modified: string;
  edited: string | null;
}

function mapDonationPointRow(raw: Record<string, unknown>): DonationPointRow {
  return coerceBooleans<DonationPointRow>(raw, BOOLEAN_COLUMNS);
}

// `Foodbank.donation_points()` -- used by `api_foodbank`/`foodbank(slug)`.
// No `is_closed` filter, same as `getLocationsByFoodbankId` -- see PLAN.md
// §7.2's note that a food bank's own donation-point list is not filtered
// even when the food bank itself is open. Sorted in JS, not SQL -- see
// sortByName's comment in types.ts.
export async function getDonationPointsByFoodbankId(session: Session, foodbankId: number): Promise<DonationPointRow[]> {
  const result = await session
    .prepare("SELECT * FROM foodbankdonationpoint WHERE foodbank_id = ?")
    .bind(foodbankId)
    .all();
  return sortByName(result.results.map(mapDonationPointRow));
}

// gfapi2 `donationpoints` geojson, and the full-detail source for
// `donationpoint_search`'s surviving donation-point winners (see
// getOpenDonationPointCoordinates for the cheap candidate-set version
// ranking actually runs against).
export async function getAllOpenDonationPoints(session: Session): Promise<DonationPointRow[]> {
  const result = await session.prepare("SELECT * FROM foodbankdonationpoint WHERE is_closed = 0").all();
  return result.results.map(mapDonationPointRow);
}

// WP 2.5 perf: the id+coordinate candidate set for ranking
// `donationpoint_search`'s donation-point branch -- see queryCoordinates's
// own comment in types.ts. Covered entirely by `dp_open_latlng_idx`.
export async function getOpenDonationPointCoordinates(session: Session): Promise<CoordinateRow[]> {
  return queryCoordinates(session, "SELECT id, latitude, longitude FROM foodbankdonationpoint WHERE is_closed = 0");
}

// Full rows for a small, already-ranked set of donation-point ids -- same
// order-preservation reasoning as `getFoodbanksByIds`/`getLocationsByIds`.
export async function getDonationPointsByIds(session: Session, ids: readonly number[]): Promise<DonationPointRow[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const result = await session
    .prepare(`SELECT * FROM foodbankdonationpoint WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all();
  const rows = result.results.map((r) => mapDonationPointRow(r as Record<string, unknown>));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter((row): row is DonationPointRow => row !== undefined);
}

// gfapi3 `company` -- the exact projected shape of Django's `.only(...)`
// (PLAN.md §7.2), joining in the parent food bank and its latest need so
// the handler needs no further queries per row.
export interface CompanyDonationPointRow {
  uuid: string;
  name: string;
  address: string;
  postcode: string;
  country: string | null;
  lat_lng: string;
  place_id: string | null;
  store_id: string | null;
  foodbank: {
    uuid: string;
    name: string;
    alt_name: string | null;
    slug: string;
    url: string;
    shopping_list_url: string;
    phone_number: string | null;
    secondary_phone_number: string | null;
    contact_email: string;
    address: string;
    postcode: string;
    country: string;
    lat_lng: string;
    charity_number: string | null;
    network: string | null;
    latestNeed: {
      need_id: string;
      change_text: string;
      excess_change_text: string | null;
      created: string;
    } | null;
  };
}

const COMPANY_QUERY = `
  SELECT
    dp.uuid AS dp_uuid, dp.name AS dp_name, dp.address AS dp_address, dp.postcode AS dp_postcode,
    dp.country AS dp_country, dp.lat_lng AS dp_lat_lng, dp.place_id AS dp_place_id, dp.store_id AS dp_store_id,
    f.uuid AS fb_uuid, f.name AS fb_name, f.alt_name AS fb_alt_name, f.slug AS fb_slug,
    f.url AS fb_url, f.shopping_list_url AS fb_shopping_list_url, f.phone_number AS fb_phone_number,
    f.secondary_phone_number AS fb_secondary_phone_number, f.contact_email AS fb_contact_email,
    f.address AS fb_address, f.postcode AS fb_postcode, f.country AS fb_country,
    f.lat_lng AS fb_lat_lng, f.charity_number AS fb_charity_number, f.network AS fb_network,
    n.need_id AS need_need_id, n.change_text AS need_change_text,
    n.excess_change_text AS need_excess_change_text, n.created AS need_created
  FROM foodbankdonationpoint dp
  JOIN foodbank f ON dp.foodbank_id = f.id
  LEFT JOIN foodbankchange n ON f.latest_need_id = n.id
  WHERE dp.company_slug = ?
`;

function mapCompanyRow(raw: Record<string, unknown>): CompanyDonationPointRow {
  return {
    uuid: raw.dp_uuid as string,
    name: raw.dp_name as string,
    address: raw.dp_address as string,
    postcode: raw.dp_postcode as string,
    country: raw.dp_country as string | null,
    lat_lng: raw.dp_lat_lng as string,
    place_id: raw.dp_place_id as string | null,
    store_id: raw.dp_store_id as string | null,
    foodbank: {
      uuid: raw.fb_uuid as string,
      name: raw.fb_name as string,
      alt_name: raw.fb_alt_name as string | null,
      slug: raw.fb_slug as string,
      url: raw.fb_url as string,
      shopping_list_url: raw.fb_shopping_list_url as string,
      phone_number: raw.fb_phone_number as string | null,
      secondary_phone_number: raw.fb_secondary_phone_number as string | null,
      contact_email: raw.fb_contact_email as string,
      address: raw.fb_address as string,
      postcode: raw.fb_postcode as string,
      country: raw.fb_country as string,
      lat_lng: raw.fb_lat_lng as string,
      charity_number: raw.fb_charity_number as string | null,
      network: raw.fb_network as string | null,
      latestNeed:
        raw.need_need_id === null
          ? null
          : {
              need_id: raw.need_need_id as string,
              change_text: raw.need_change_text as string,
              excess_change_text: raw.need_excess_change_text as string | null,
              created: raw.need_created as string,
            },
    },
  };
}

// `dp_company_slug_name` (company_slug, name) covers the filter -- see
// 0001_core.sql. The name part of that composite index goes unused now
// that ordering happens in JS (see sortByName's comment in types.ts), but
// it's still the right index for the equality lookup itself.
export async function companyDonationPointsExist(session: Session, companySlug: string): Promise<boolean> {
  const row = await session
    .prepare("SELECT 1 FROM foodbankdonationpoint WHERE company_slug = ? LIMIT 1")
    .bind(companySlug)
    .first();
  return row !== null;
}

export async function getDonationPointsByCompanySlug(
  session: Session,
  companySlug: string,
): Promise<CompanyDonationPointRow[]> {
  const result = await session.prepare(COMPANY_QUERY).bind(companySlug).all();
  return sortByName(result.results.map((r) => mapCompanyRow(r as Record<string, unknown>)));
}
