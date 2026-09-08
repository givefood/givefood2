import { coerceBooleans, queryCoordinates, sortByName, type CoordinateRow, type Session } from "./types";
import { normalizeUuid } from "./uuid";

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

export function mapDonationPointRow(raw: Record<string, unknown>): DonationPointRow {
  return coerceBooleans<DonationPointRow>(raw, BOOLEAN_COLUMNS);
}

// `Foodbank.donation_points()` -- used by `api_foodbank`/`foodbank(slug)`
// AND by gfwfbn `geojson`'s slug-only branch (WP 3.6). That model method
// is `FoodbankDonationPoint.objects.filter(foodbank =
// self).order_by("name")` (givefood/models/foodbank.py:552) -- explicitly
// sorted at the Postgres end. No `is_closed` filter, same as
// `getLocationsByFoodbankId` -- see PLAN.md §7.2's note that a food
// bank's own donation-point list is not filtered even when the food bank
// itself is open. Sorted in JS, not SQL -- see sortByName's comment in
// types.ts.
//
// The geojson view (gfwfbn/views.py:239) actually builds its own
// `FoodbankDonationPoint.objects.filter(foodbank__slug = slug)` directly,
// NOT via this model method, and has no `.order_by()` of its own --
// unlike locations (see getLocationsByFoodbankIdUnsorted in
// locations.ts), this function is still the right one to reuse for it.
// Checked against 4 live per-foodbank geo.json responses (3, 5, 5, and 31
// donation points) -- every one came back in exact alphabetical order,
// unlike their SAME food banks' locations, which mostly didn't. Most
// likely donation points get bulk-imported from partner store-locator
// data that's already alphabetised, so Postgres's un-ordered scan just
// happens to preserve that -- but whatever the cause, the sorted query
// is the empirically closer match, not the unsorted one this table's
// data would otherwise suggest reaching for.
export async function getDonationPointsByFoodbankId(session: Session, foodbankId: number): Promise<DonationPointRow[]> {
  const result = await session
    .prepare("SELECT * FROM foodbankdonationpoint_full WHERE foodbank_id = ?")
    .bind(foodbankId)
    .all();
  return sortByName(result.results.map(mapDonationPointRow));
}

// wfbn-generic `mobsub`/`delete_mobsub` -- the optional `donationpoint`
// UUID in the mobile app's POST body, scoped to the already-resolved
// food bank exactly like Django's `get_object_or_404(FoodbankDonationPoint,
// foodbank=foodbank, uuid=donationpoint_uuid)` (gfwfbn/views.py:1371/1406):
// a donation point UUID that exists but belongs to a DIFFERENT food bank
// must 404 too, not silently resolve.
export async function getDonationPointIdByUuid(session: Session, uuid: string, foodbankId: number): Promise<number | null> {
  const row = await session
    .prepare("SELECT id FROM foodbankdonationpoint WHERE uuid = ? AND foodbank_id = ?")
    .bind(normalizeUuid(uuid), foodbankId)
    .first<{ id: number }>();
  return row ? row.id : null;
}

// gfwfbn-md `md_foodbank_donationpoint` -- single donation point scoped to
// its parent food bank's slug, mirroring getFoodbankLocationBySlugs in
// locations.ts exactly. foodbank_slug is the denormalised column already
// on this table (see DonationPointRow), so this is a single-table lookup,
// no join needed to reproduce Django's
// `get_object_or_404(FoodbankDonationPoint, slug=dpslug, foodbank=foodbank)`.
export async function getDonationPointBySlugs(
  session: Session,
  foodbankSlug: string,
  donationPointSlug: string,
): Promise<DonationPointRow | null> {
  const row = await session
    .prepare("SELECT * FROM foodbankdonationpoint_full WHERE slug = ? AND foodbank_slug = ?")
    .bind(donationPointSlug, foodbankSlug)
    .first();
  return row ? mapDonationPointRow(row as Record<string, unknown>) : null;
}

// gfapi2 `donationpoints` geojson (/api/2/donationpoints/) and the all-items
// /needs/geo.json feed -- its only two callers, and between them they read
// eleven columns of a ~41-column view.
//
// NOT `donationpoint_search`. This function's comment used to claim it was
// also "the full-detail source for donationpoint_search's surviving
// winners"; it never was. That path runs getOpenDonationPointCoordinates and
// then getDonationPointsByIds (api2/donationpoints.ts:212-241), both of which
// are unaffected by anything here -- the stale claim made the blast radius of
// a change to this query look several routes wider than it is.
//
// PROJECTED, NOT `SELECT *`. api2/donationpoints.ts:99-124 builds an explicit
// properties object out of name, slug, address, postcode, lat_lng,
// phone_number, url, parliamentary_constituency_name, foodbank_name,
// foodbank_slug and foodbank_network; buildGeojson.ts's donationPointFeature
// reads a subset of that same eleven (and its address/postcode only when
// `includeAddress`, which the all-items scope sets false). `id` is the
// twelfth column here: an integer that costs almost nothing and is the only
// stable handle a caller or a test has on a row. Nothing reads
// opening_hours, notes, plus_code_*, place_id, county, district, ward, lsoa,
// msoa, company, company_slug, store_id, mp*, uuid, country, latitude,
// longitude, modified, edited, or any of the four flag columns.
//
// Measured against production D1 over the 5,727 open rows: 10,643,021 bytes
// of `wrangler --remote --json` output -> 3,316,250, the same measurement
// getAllOpenDonationPointSlugs' note below uses for this same `SELECT *`
// (7.89 MB -> 2.55 MB if the results array alone is re-serialised compactly
// -- quote one convention or the other, not a third), and a server-reported
// duration of ~300 ms -> ~79 ms (n=4 each: 598/305/258/291 against
// 82/79/69/119; `SELECT COUNT(*)` over the same view and filter is 13-15 ms,
// so that is the scan floor and effectively all of the difference was column
// materialisation, not extra scanning). rows_read is UNCHANGED at 11,454 --
// D1 bills rows read, so this is wire bytes, encode time and Worker CPU, not
// money. Same reasoning, and the same measured shape, as
// getAllOpenLocationsFlagged in locations.ts. Timed through the D1 REST API
// (`wrangler --remote`, D1's own server-side meta.duration) rather than from
// inside the Worker, same caveat that function carries: the byte figures are
// hard, the millisecond ones indicative, and the split between D1-side encode
// and service-to-Worker transport is not visible from there.
//
// NO `.map(mapDonationPointRow)`, deliberately: none of the four
// BOOLEAN_COLUMNS survive the projection, so the coercion has nothing to
// coerce and would only invent four null keys neither caller reads (see
// mapDonationPointRow's "invents the four flag keys as null" test).
//
// The narrow type is derived with Pick, never cast into existence: a future
// caller reaching for a column that is no longer fetched gets a type error
// rather than `undefined` at runtime.
export type DonationPointRowNarrow = Pick<
  DonationPointRow,
  | "id"
  | "name"
  | "slug"
  | "address"
  | "postcode"
  | "lat_lng"
  | "phone_number"
  | "url"
  | "parliamentary_constituency_name"
  | "foodbank_name"
  | "foodbank_slug"
  | "foodbank_network"
>;

const DONATION_POINT_COLUMNS_NARROW =
  "id, name, slug, address, postcode, lat_lng, phone_number, url, " +
  "parliamentary_constituency_name, foodbank_name, foodbank_slug, foodbank_network";

export async function getAllOpenDonationPoints(session: Session): Promise<DonationPointRowNarrow[]> {
  const result = await session
    .prepare(`SELECT ${DONATION_POINT_COLUMNS_NARROW} FROM foodbankdonationpoint_full WHERE is_closed = 0`)
    .all();
  return result.results as unknown as DonationPointRowNarrow[];
}

// sitemap.xml/md_sitemap's donation-point loops only ever need
// foodbank_slug/slug, exactly as Django narrows the same queryset
// (`FoodbankDonationPoint.objects.all().exclude(is_closed=True)
// .only('foodbank_slug', 'slug')`, givefood/views.py:759-763). Same
// narrow-column reasoning as locations.ts's getAllOpenLocationSlugs, but
// the pressure here is row COUNT x row WIDTH rather than one large blob:
// measured against production D1, `SELECT *` over the 5,727 open donation
// points serialises 10,643,022 bytes in a median 320 ms (264-424, n=5) where
// these two columns are 554,510 bytes in a median 40 ms (31-50). rows_read
// is UNCHANGED at 11,454 either way, so
// this is wire bytes and latency, not D1 billing. It was the slowest of
// the four queries the sitemap runs in parallel, i.e. the whole critical
// path.
export async function getAllOpenDonationPointSlugs(
  session: Session,
): Promise<Array<{ foodbank_slug: string; slug: string }>> {
  const result = await session.prepare("SELECT foodbank_slug, slug FROM foodbankdonationpoint_full WHERE is_closed = 0").all();
  return result.results as unknown as Array<{ foodbank_slug: string; slug: string }>;
}

// sitemap.md's variant of the above -- same narrow-column reasoning, plus
// `name` for the link text (the XML sitemaps have no link text, only
// <loc>), mirroring getAllOpenLocationSlugsWithNames in locations.ts.
export async function getAllOpenDonationPointSlugsWithNames(
  session: Session,
): Promise<Array<{ foodbank_slug: string; slug: string; name: string }>> {
  const result = await session
    .prepare("SELECT foodbank_slug, slug, name FROM foodbankdonationpoint_full WHERE is_closed = 0")
    .all();
  return result.results as unknown as Array<{ foodbank_slug: string; slug: string; name: string }>;
}

// WP 2.5 perf: the id+coordinate candidate set for ranking
// `donationpoint_search`'s donation-point branch -- see queryCoordinates's
// own comment in types.ts. Covered entirely by `dp_open_latlng_idx`.
export async function getOpenDonationPointCoordinates(session: Session): Promise<CoordinateRow[]> {
  return queryCoordinates(session, "SELECT id, latitude, longitude FROM foodbankdonationpoint WHERE is_closed = 0");
}

// gfwfbn `geojson`'s parlcon_slug branch (WP 3.6) -- the donation-point
// half of the constituency-scoped feed, same pattern as
// `getOpenLocationsByConstituencyId` in locations.ts:
// `FoodbankDonationPoint.objects.filter(parliamentary_constituency_slug =
// parlcon_slug, is_closed=False)`, joined here by the FK id (resolved from
// the slug by the caller) rather than the denormalised slug column --
// same equivalence reasoning as that function's own use for the
// food-bank/location halves of the same view.
export async function getOpenDonationPointsByConstituencyId(
  session: Session,
  constituencyId: number,
): Promise<DonationPointRow[]> {
  const result = await session
    .prepare("SELECT * FROM foodbankdonationpoint_full WHERE parliamentary_constituency_id = ? AND is_closed = 0")
    .bind(constituencyId)
    .all();
  return result.results.map(mapDonationPointRow);
}

// givefood `country_geojson` (givefood/views.py:285-427) -- the
// donation-point half of a country-scoped feed, same shape as
// `getOpenDonationPointsByConstituencyId` above
// (`FoodbankDonationPoint.objects.filter(country = country_name,
// is_closed=False)`), just filtered by the denormalised `country` column
// instead of a constituency id.
export async function getOpenDonationPointsByCountry(session: Session, countryName: string): Promise<DonationPointRow[]> {
  const result = await session
    .prepare("SELECT * FROM foodbankdonationpoint_full WHERE country = ? AND is_closed = 0")
    .bind(countryName)
    .all();
  return result.results.map(mapDonationPointRow);
}

// Full rows for a small, already-ranked set of donation-point ids -- same
// order-preservation reasoning as `getFoodbanksByIds`/`getLocationsByIds`.
export async function getDonationPointsByIds(session: Session, ids: readonly number[]): Promise<DonationPointRow[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const result = await session
    .prepare(`SELECT * FROM foodbankdonationpoint_full WHERE id IN (${placeholders})`)
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
  FROM foodbankdonationpoint_full dp
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
