import type { Session } from "./types";
import { pyNow } from "@givefood/models";

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

// Exported because the admin routes need the SAME slug upsertLocation is
// about to write, in order to check it for a collision before writing it
// (see locationSlugTaken below). Deriving it a second time in the route
// would be two implementations of one rule, and the only interesting
// failures here are precisely the ones where the two would disagree.
export function locationSlug(value: string): string {
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

// GitHub issue #12's actual repro. This is the `unique_together =
// ('foodbank', 'name')` check (givefood/models/foodbank.py:794-795) that
// Django's FoodbankLocationForm ran inside is_valid(), via
// ModelForm._post_clean() -> Model.validate_unique(), and that this port
// dropped: without it a duplicate name goes straight to D1, SQLite raises
// `UNIQUE constraint failed: foodbanklocation.foodbank_id,
// foodbanklocation.name` against loc_fb_name_uniq
// (migrations/0001_core.sql:76), and app.onError renders the 500 page over
// everything the admin had typed.
//
// exceptId excludes the row being edited, mirroring what Django's
// Model._perform_unique_checks does with `qs.exclude(pk=...)` on an
// instance that already has a pk. Not a nicety: admin.js injects a "Lookup"
// button onto this form whose whole job is to refill lat_lng / address /
// postcode on an EXISTING location while leaving the Name alone, and a
// check without the exclusion would make that flow permanently unsavable --
// a worse bug than the one being fixed, because it would have no
// workaround.
//
// `id IS NOT ?` rather than `id != ?`, copying slugRedirectOldSlugTaken
// (slugRedirects.ts:62-69): on a create exceptId is null, and SQLite's `!=`
// against NULL yields NULL rather than true, which would filter out every
// row and make the check silently always pass -- reintroducing the very 500
// this exists to prevent, behind a check that looks present.
export async function locationNameTaken(
  session: Session,
  foodbankId: number,
  name: string,
  exceptId: number | undefined,
): Promise<boolean> {
  const row = await session
    .prepare("SELECT id FROM foodbanklocation WHERE foodbank_id = ? AND name = ? AND id IS NOT ?")
    .bind(foodbankId, name, exceptId ?? null)
    .first<{ id: number }>();
  return !!row;
}

// (foodbank_id, slug) is NOT a unique index, deliberately, on both sides:
// loc_foodbank_slug_idx (migrations/0001_core.sql:77) and Django's own
// `models.Index(fields=['foodbank','slug'])` (foodbank.py:800) are plain
// indexes, and `slug` carries no unique=True. A slug collision therefore
// cannot raise and was never part of issue #12's 500 -- this check is an
// improvement on Django rather than a restoration of it, and it is here
// because what a collision does instead is the one thing worse than a 500:
// it saves, and then loses the row quietly.
//
// `slug` is derived from `name` (locationSlug above), never typed, and the
// derivation is lossy: "St Mary's Hall" and "St Marys Hall" both give
// "st-marys-hall", as do "Barrow-in-Furness" and "Barrow in Furness". Two
// such names pass loc_fb_name_uniq cleanly and both rows insert. From then
// on getFoodbankLocationBySlugs (locations.ts:216-226) is a `.first()` on
// (slug, foodbank_slug), so the second row is shadowed -- it disappears
// from the public site, and its own admin edit URL opens, and on save
// overwrites, the first row instead.
//
// Same exceptId contract and the same `id IS NOT ?` reasoning as
// locationNameTaken above.
export async function locationSlugTaken(
  session: Session,
  foodbankId: number,
  slug: string,
  exceptId: number | undefined,
): Promise<boolean> {
  const row = await session
    .prepare("SELECT id FROM foodbanklocation WHERE foodbank_id = ? AND slug = ? AND id IS NOT ?")
    .bind(foodbankId, slug, exceptId ?? null)
    .first<{ id: number }>();
  return !!row;
}

// Create (existingId undefined) or update (existingId given) -- one
// function, matching Django's single create+edit form/view for this
// model. Returns the row's slug so the caller can redirect to it.
//
// GitHub issue #34. `place_id` was declared on UpsertLocationParams, was on
// the form (lib/adminFormFields.ts:148), was filled by admin.js's "Lookup
// Location" button straight out of Google Places, and was passed in by the
// handler (routes/admin/foodbankLocation.ts:144) -- and then named by
// NEITHER statement below, so it was accepted and silently dropped on every
// save. The sibling upsertDonationPoint has always written it
// (donationPointsAdmin.ts:117, :150); this is that same one column, in both
// statements, in the migration's own column position.
//
// Not cosmetic. `place_id` is the key the Google Places photo backfill runs
// on: workers/jobs/src/mediaBackfill/placePhoto.ts:136 logs "media-backfill:
// place has no place_id for <key>" and returns quietly, so a location
// created through this admin could never acquire a photograph and nothing
// anywhere said why.
//
// THE UPDATE IS THE DANGEROUS HALF, and it is only safe because the edit
// form round-trips the stored value. `place_id = ?` means every ordinary
// edit -- a rename, a postcode fix -- rewrites the column with whatever the
// form posted, so a form that did NOT render the current value would blank
// the 1,938 of 1,973 production rows that hold one (counted on live D1), all
// of them written by the Django ETL and none recoverable from anything else
// in the row. It does render it: getFoodbankLocationBySlugs selects * from
// foodbanklocation_full (whose body is `l.*` plus the parent's columns,
// migrations/0019), the handler spreads that row into the template's `data`,
// and admin/includes/formfields.njk emits it as the text input's value.
// That whole chain is EXECUTED rather than asserted, in routes/admin/
// foodbankLocation.test.ts's "place_id" block -- real read, real render
// context, real POST body, this UPDATE, row read back -- because one broken
// link in it turns this fix into a data-loss bug.
//
// AN EMPTY PLACE ID FIELD STORES NULL, never "". Three reasons, all checked
// rather than assumed:
//   - Consistency with the fields beside it. parseAdminFields
//     (lib/adminFormFields.ts:316) maps every empty text field to null, so
//     `address`/`postcode`/`boundary_geojson`/`phone_number`/`email` already
//     arrive here as null from the same POST. Passing params.placeId through
//     unchanged keeps this column on the same rule; special-casing it would
//     be the inconsistency.
//   - It is what Django stored. `place_id` is CharField(max_length=1024,
//     null=True, blank=True) (models/base.py:76), and Django's
//     CharField.formfield() sets `empty_value=None` when the field is null
//     and the backend doesn't read "" as NULL. Run against the installed
//     Django 5.2.6 rather than recalled: that field's form field cleans both
//     "" and "  " to None. `address`/`boundary_geojson` are TextFields,
//     whose formfield() has no such branch and cleans "" to "" -- which is
//     exactly why the migrated data holds 8 and 218 empty strings in those
//     two columns and ZERO in this one (1,973 rows: 1,938 populated, 35
//     NULL, 0 empty).
//   - "" would be worse than absent downstream. placePhotos.ts:44-48 and
//     :67-79 gather a food bank's owned place ids with `place_id IS NOT
//     NULL`; an empty string passes that filter and is then handed to Google
//     as a place id.
export async function upsertLocation(session: Session, params: UpsertLocationParams, existingId: number | undefined): Promise<string> {
  const slug = locationSlug(params.name);
  const { latitude, longitude } = parseLatLng(params.latLng);
  const now = pyNow();

  if (existingId === undefined) {
    await session
      .prepare(
        `INSERT INTO foodbanklocation
           (uuid, foodbank_id,
            name, slug, address, postcode, country, lat_lng, latitude, longitude, place_id,
            is_closed, is_donation_point, is_mobile, boundary_geojson, phone_number, email, modified, edited)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID().replace(/-/g, ""),
        params.foodbankId,
        params.name,
        slug,
        params.address,
        params.postcode,
        params.foodbank.country,
        params.latLng,
        latitude,
        longitude,
        params.placeId,
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
           name = ?, slug = ?, address = ?, postcode = ?, lat_lng = ?, latitude = ?, longitude = ?, place_id = ?,
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
        params.placeId,
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

// gfadmin/views.py:1741 fblocation_delete, @require_POST. Django's
// FoodbankLocation.delete() override also resaves the parent Foodbank
// afterwards purely to re-trigger its decache side effect
// (foodbank.py:929-933) -- no decache consumer exists in this port yet
// (PLAN.md §3.6's own already-tracked gap, not something this WP
// introduces), so there is nothing for a resave to actually do here.
export async function deleteLocation(session: Session, id: number): Promise<void> {
  await session.prepare("DELETE FROM foodbanklocation WHERE id = ?").bind(id).run();
}
