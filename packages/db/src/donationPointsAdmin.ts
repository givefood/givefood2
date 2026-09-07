import type { Session } from "./types";
import { pyNow } from "@givefood/models";

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

// The unique_together=('foodbank','name') check Django's ModelForm did for
// us (givefood/models/foodbank.py:1029, enforced here by dp_fb_name_uniq --
// migrations/0001_core.sql:102). FoodbankDonationPointForm declares
// `fields = "__all__"` with `widgets = {'foodbank': HiddenInput()}`
// (forms.py:172-177), so `foodbank` is IN the form, which is precisely what
// made ModelForm._post_clean() -> instance.validate_unique() run this check
// at all; had `foodbank` been excluded, Django would have skipped it too.
// Without this the INSERT/UPDATE reached SQLite, raised
// SQLITE_CONSTRAINT_UNIQUE and left app.onError rendering the 500 page --
// discarding everything the admin typed, including the eight fields the
// "Lookup Donation Point" button had just pulled from Google Places.
//
// Excludes the row being edited, exactly as Model._perform_unique_checks()
// does with `qs.exclude(pk=...)` on an instance that has a pk. That is not a
// nicety: the entire point of the Lookup button is to refresh lat_lng /
// place_id / opening_hours on an EXISTING donation point while leaving the
// Name alone, and a check without the exclusion would make that flow
// permanently unsavable.
//
// `id IS NOT ?` rather than `id != ?`, copying slugRedirectOldSlugTaken
// (slugRedirects.ts:62-69): on a create exceptId is null, and SQLite's `!=`
// against NULL yields NULL rather than true, which would filter out every
// row and make the check silently always pass -- reintroducing the very
// 500 this exists to prevent, behind a check that looks present.
export async function donationPointNameTaken(
  session: Session,
  foodbankId: number,
  name: string,
  exceptId: number | undefined,
): Promise<boolean> {
  const row = await session
    .prepare("SELECT id FROM foodbankdonationpoint WHERE foodbank_id = ? AND name = ? AND id IS NOT ?")
    .bind(foodbankId, name, exceptId ?? null)
    .first<{ id: number }>();
  return !!row;
}

export async function upsertDonationPoint(session: Session, params: UpsertDonationPointParams, existingId: number | undefined): Promise<string> {
  const slug = slugify(params.name);
  const companySlug = params.company ? slugify(params.company) : null;
  const { latitude, longitude } = parseLatLng(params.latLng);
  const now = pyNow();

  if (existingId === undefined) {
    await session
      .prepare(
        `INSERT INTO foodbankdonationpoint
           (uuid, foodbank_id,
            name, slug, address, postcode, country, lat_lng, latitude, longitude,
            is_closed, in_store_only, phone_number, url, opening_hours, wheelchair_accessible,
            company, company_slug, store_id, notes, place_id, modified, edited)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID().replace(/-/g, ""),
        params.foodbankId,
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
