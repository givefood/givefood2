import type { Session } from "./types";

// WP 6.5: FoodbankLocationForm's write path (givefood/forms.py:150-164).
// Django's own form.save() is just a 6-line `edited = now()` stamp on top
// of the plain ModelForm default -- confirmed by reading fblocation_form
// (gfadmin/views.py:1614-1644) too: neither the form nor the view ever
// sets `foodbank_name`/`foodbank_slug`/`foodbank_network`/
// `foodbank_phone_number`/`foodbank_email`/`slug` (all `editable=False`,
// so POST data can never reach them either), and no signal/mixin save()
// override does it elsewhere in the model hierarchy (checked
// EditableModel/UUIDModel/PhysicalPlace -- none). Left as-is, a new or
// edited D1 row here would be a location the public site's own
// `getFoodbankLocationBySlugs` (slug + foodbank_slug lookup) could never
// find. Populated here from the parent Foodbank row instead of ported
// blank -- not a judgement call about admin *behaviour* the way WP 6.5's
// partial-forms/politics-stamp decisions were, just what "create a
// location that's actually reachable" requires. `latitude`/`longitude`
// are parsed from the `lat_lng` text field the same way for the same
// reason. `country` is NOT NULL in D1 (unlike Django's own `editable=False`
// declaration, which never blocks NULL at the DB level) -- defaulted to
// the parent food bank's own country on create, a location's country
// diverging from its food bank's being vanishingly rare in practice. The
// remaining geocoding-derived fields (`county`/`district`/`ward`/`lsoa`/
// `msoa`, `parliamentary_constituency*`, `mp*`) are genuinely NOT
// touched -- deriving those needs real boundary-lookup infrastructure
// this port doesn't have yet, so they stay NULL on create, matching
// Django's own observed gap there.
export interface FoodbankLocationParentFields {
  name: string;
  slug: string;
  network: string | null;
  phone_number: string | null;
  contact_email: string;
  country: string;
}

function parseLatLng(latLng: string): { latitude: number | null; longitude: number | null } {
  const [latStr, lngStr] = latLng.split(",");
  const latitude = latStr ? Number.parseFloat(latStr) : NaN;
  const longitude = lngStr ? Number.parseFloat(lngStr) : NaN;
  return { latitude: Number.isFinite(latitude) ? latitude : null, longitude: Number.isFinite(longitude) ? longitude : null };
}

// Same algorithm as @givefood/templates's slugify (filters.ts) --
// duplicated rather than imported, matching this package's existing rule
// that packages/db stays free of a templates dependency (needTranslations
// .ts's own comment states the same convention for its Locale union).
// The combining-diacritical-marks range (U+0300-U+036F, what NFKD splits
// an accented character into) is built from code points rather than
// written as a literal \u escape -- this file has been round-tripped
// through a pipeline that decodes \uXXXX in plain source text, which
// silently corrupted a literal escape here once already.
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

export interface UpsertLocationParams {
  foodbankId: number;
  foodbank: FoodbankLocationParentFields;
  name: string;
  address: string | null;
  postcode: string | null;
  isDonationPoint: number;
  isMobile: number;
  latLng: string;
  boundaryGeojson: string | null;
  placeId: string | null;
  phoneNumber: string | null;
  email: string | null;
}

// Create (existingId undefined) or update (existingId given) -- one
// function, matching Django's single create+edit form/view for this
// model. Returns the row's slug so the caller can redirect to it.
export async function upsertLocation(session: Session, params: UpsertLocationParams, existingId: number | undefined): Promise<string> {
  const slug = slugify(params.name);
  const { latitude, longitude } = parseLatLng(params.latLng);
  const now = new Date().toISOString();

  if (existingId === undefined) {
    await session
      .prepare(
        `INSERT INTO foodbanklocation
           (uuid, foodbank_id, foodbank_name, foodbank_slug, foodbank_network, foodbank_phone_number, foodbank_email,
            name, slug, address, postcode, country, lat_lng, latitude, longitude,
            is_closed, is_donation_point, is_mobile, boundary_geojson, phone_number, email, modified, edited)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID().replace(/-/g, ""),
        params.foodbankId,
        params.foodbank.name,
        params.foodbank.slug,
        params.foodbank.network,
        params.foodbank.phone_number,
        params.foodbank.contact_email,
        params.name,
        slug,
        params.address,
        params.postcode,
        params.foodbank.country,
        params.latLng,
        latitude,
        longitude,
        params.isDonationPoint,
        params.isMobile,
        params.boundaryGeojson,
        params.phoneNumber,
        params.email,
        now,
        now,
      )
      .run();
  } else {
    await session
      .prepare(
        `UPDATE foodbanklocation SET
           name = ?, slug = ?, address = ?, postcode = ?, lat_lng = ?, latitude = ?, longitude = ?,
           is_donation_point = ?, is_mobile = ?, boundary_geojson = ?, phone_number = ?, email = ?,
           modified = ?, edited = ?
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
        params.isDonationPoint,
        params.isMobile,
        params.boundaryGeojson,
        params.phoneNumber,
        params.email,
        now,
        now,
        existingId,
      )
      .run();
  }
  return slug;
}
