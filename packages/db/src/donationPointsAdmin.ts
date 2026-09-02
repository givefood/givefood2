import type { Session } from "./types";

// WP 6.5: FoodbankDonationPointForm's write path (forms.py:172-186) --
// same shape and same gap as locationsAdmin.ts's own comment: Django's
// form/view never sets `foodbank_name`/`foodbank_slug`/`foodbank_network`/
// `slug`/`company_slug` (all `editable=False`), so this port populates
// them from the parent Foodbank row (and slugifies `company` for
// `company_slug`) rather than leaving a newly created donation point
// unreachable by its own detail URL. `latitude`/`longitude` are parsed
// from `lat_lng` for the same reason. Geocoding-derived fields (country,
// county/district/ward/lsoa/msoa, parliamentary_constituency*, mp*) are
// left untouched -- same disclosed gap as locations, no boundary-lookup
// infrastructure built yet.
const COMBINING_MARKS_RE = new RegExp(`[${String.fromCodePoint(0x0300)}-${String.fromCodePoint(0x036f)}]`, "g");

function slugify(value: string): string {
  const ascii = value
    .normalize("NFKD")
    .replace(COMBINING_MARKS_RE, "")
    .replace(/[^\x00-\x7F]/g, "");
  return ascii
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/[-\s]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

function parseLatLng(latLng: string): { latitude: number | null; longitude: number | null } {
  const [latStr, lngStr] = latLng.split(",");
  const latitude = latStr ? Number.parseFloat(latStr) : NaN;
  const longitude = lngStr ? Number.parseFloat(lngStr) : NaN;
  return { latitude: Number.isFinite(latitude) ? latitude : null, longitude: Number.isFinite(longitude) ? longitude : null };
}

export interface DonationPointParentFields {
  name: string;
  slug: string;
  network: string | null;
}

export interface UpsertDonationPointParams {
  foodbankId: number;
  foodbank: DonationPointParentFields;
  name: string;
  address: string;
  postcode: string;
  phoneNumber: string | null;
  openingHours: string | null;
  wheelchairAccessible: number | null;
  url: string | null;
  inStoreOnly: number;
  company: string | null;
  storeId: string | null;
  notes: string | null;
  latLng: string;
  placeId: string | null;
}

// gfadmin/views.py:1865 donationpoint_delete -- no @require_POST in
// Django (WP 6.6 research flagged this), but this route is POST-only
// regardless, matching WP 6.3's carried-forward requirement.
export async function deleteDonationPoint(session: Session, id: number): Promise<void> {
  await session.prepare("DELETE FROM foodbankdonationpoint WHERE id = ?").bind(id).run();
}

export async function upsertDonationPoint(session: Session, params: UpsertDonationPointParams, existingId: number | undefined): Promise<string> {
  const slug = slugify(params.name);
  const companySlug = params.company ? slugify(params.company) : null;
  const { latitude, longitude } = parseLatLng(params.latLng);
  const now = new Date().toISOString();

  if (existingId === undefined) {
    await session
      .prepare(
        `INSERT INTO foodbankdonationpoint
           (uuid, foodbank_id, foodbank_name, foodbank_slug, foodbank_network,
            name, slug, address, postcode, country, lat_lng, latitude, longitude,
            is_closed, in_store_only, phone_number, url, opening_hours, wheelchair_accessible,
            company, company_slug, store_id, notes, place_id, modified, edited)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID().replace(/-/g, ""),
        params.foodbankId,
        params.foodbank.name,
        params.foodbank.slug,
        params.foodbank.network,
        params.name,
        slug,
        params.address,
        params.postcode,
        params.latLng,
        latitude,
        longitude,
        params.inStoreOnly,
        params.phoneNumber,
        params.url,
        params.openingHours,
        params.wheelchairAccessible,
        params.company,
        companySlug,
        params.storeId,
        params.notes,
        params.placeId,
        now,
        now,
      )
      .run();
  } else {
    await session
      .prepare(
        `UPDATE foodbankdonationpoint SET
           name = ?, slug = ?, address = ?, postcode = ?, lat_lng = ?, latitude = ?, longitude = ?,
           in_store_only = ?, phone_number = ?, url = ?, opening_hours = ?, wheelchair_accessible = ?,
           company = ?, company_slug = ?, store_id = ?, notes = ?, place_id = ?, modified = ?, edited = ?
         WHERE id = ?`,
      )
      .bind(
        params.name,
        slug,
        params.address,
        params.postcode,
        params.latLng,
        latitude,
        longitude,
        params.inStoreOnly,
        params.phoneNumber,
        params.url,
        params.openingHours,
        params.wheelchairAccessible,
        params.company,
        companySlug,
        params.storeId,
        params.notes,
        params.placeId,
        now,
        now,
        existingId,
      )
      .run();
  }
  return slug;
}
