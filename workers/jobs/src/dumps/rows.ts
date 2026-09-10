import { charityRegisterUrl, fsaUrl, slugify, phoneOrFoodbankPhone, emailOrFoodbankEmail } from "@givefood/models";
import { formatFloat } from "@givefood/serialise";
import { toDashedUuid } from "@givefood/db";
import type {
  DumpArticleRow, DumpDonationPointRow, DumpFoodbankRow, DumpItemRow, DumpLocationRow,
} from "@givefood/db";

// dump.py's build_*_row functions. Each returns values already in field
// order, because the only consumer is formatCsvRow -- Django built a dict and
// then re-read it through row_to_csv_values(row, FIELDS) (dump.py:394-396),
// which is the same thing with a lookup in the middle.
//
// TYPE COERCION IS THE WHOLE JOB. Python's csv.writer stringifies with str(),
// so `None` becomes an empty field, `True`/`False` become the words "True"
// and "False", and a float keeps its repr. formatCsvRow already reproduces
// that (verified against unicodecsv 0.14.1), which leaves this module
// responsible for handing it values of the RIGHT PYTHON TYPE:
//
//   * D1 stores booleans as 0/1 integers. Passed straight through they would
//     render "0"/"1" where Django wrote "True"/"False", so every boolean
//     column goes through pyBool().
//   * D1 stores bounds_* as REAL. JavaScript cannot tell 51.0 from 51, so a
//     whole-numbered bound would render "51" where Python's str(51.0) gives
//     "51.0". formatFloat() is Python's repr and settles it. No production
//     row is whole-numbered today (checked: 0 of 1,070), so this is a latent
//     divergence closed on purpose rather than an observed one.
//   * Everything else is already a string in D1 in Django's own rendering --
//     timestamps included, because the port writes pyNow() format.
//
// UUIDs ARE THE EXCEPTION, and were caught only by diffing against the real
// 2026-08-30 objects. Django's `str(foodbank.uuid)` renders the DASHED form
// (61f14919-1d98-4405-967a-362c11793dcd) and every `id`/`organisation_id`
// column in all four dumps carries it that way. D1 stores UUIDs dashless --
// all 1,070 rows, verified -- so passing the column straight through would
// have silently changed the primary identifier of a public dataset. Every
// uuid therefore goes through toDashedUuid().

/** D1's 0/1 (or NULL) as the Python bool csv.writer saw. */
function pyBool(v: number | null | undefined): boolean | null {
  return v === null || v === undefined ? null : v !== 0;
}

/** A REAL column as Python's str(float), never JavaScript's integer collapse. */
function pyFloat(v: number | null): string | null {
  return v === null || v === undefined ? null : formatFloat(v);
}

/**
 * charity_reg_date as Django's `str(datetime)`.
 *
 * Django declares this a DateTimeField, so str() ALWAYS renders a time --
 * "2021-07-14 00:00:00" -- and omits microseconds only when they are zero.
 * D1 holds it three ways: 801 bare dates, 3 with an explicit
 * " 00:00:00.000000", and 266 NULL. Left alone the bare ones would lose the
 * time half and the explicit ones would gain a ".000000" Django never wrote.
 * Caught by diffing against the real 2026-08-30 dump, where it was the single
 * most common difference (6 of 9 sampled rows).
 */
function pyCharityRegDate(v: string | null): string | null {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v} 00:00:00`;
  return v.replace(/\.0+$/, "");
}

/** build_foodbank_row(foodbank) -- the parent row, location=None. */
export function foodbankRow(f: DumpFoodbankRow): unknown[] {
  return [
    toDashedUuid(f.uuid), f.name, f.alt_name, f.slug,
    "", "", // location_name / location_slug: "" for the parent, not None
    f.url, f.shopping_list_url, f.rss_url, f.news_url, f.donation_points_url, f.locations_url,
    f.contacts_url, f.phone_number, f.secondary_phone_number, f.contact_email, f.address,
    f.postcode, f.country, f.lat_lng, f.place_id, f.plus_code_compound, f.plus_code_global,
    f.lsoa, f.msoa, f.parliamentary_constituency_name, f.mp_parl_id, f.mp, f.mp_party, f.ward,
    f.district, f.charity_number, charityRegisterUrl(f.charity_number, f.country), f.charity_name,
    f.charity_type, pyCharityRegDate(f.charity_reg_date), f.charity_postcode, f.charity_website, f.charity_objectives,
    f.charity_purpose, f.fsa_id, fsaUrl(f.fsa_id), f.network, f.network_id, pyBool(f.is_school),
    null, null, null, // is_mobile / is_area / boundary: None on the parent row
    pyFloat(f.bounds_north), pyFloat(f.bounds_south), pyFloat(f.bounds_east), pyFloat(f.bounds_west),
    f.created, f.modified, f.edited,
    f.need_id ? toDashedUuid(f.need_id) : null, f.needed_items, f.excess_items, f.need_found,
    f.footprint,
  ];
}

/** build_foodbank_row(foodbank, location) -- the location row. */
export function foodbankLocationRow(f: DumpFoodbankRow, l: DumpLocationRow): unknown[] {
  return [
    toDashedUuid(l.uuid), f.name, f.alt_name, f.slug, l.name, l.slug,
    f.url, f.shopping_list_url, f.rss_url, f.news_url, f.donation_points_url, f.locations_url,
    f.contacts_url,
    phoneOrFoodbankPhone(l.phone_number, f.phone_number),
    "", // secondary_phone_number: "" on a location, not None
    emailOrFoodbankEmail(l.email, f.contact_email),
    l.address, l.postcode, f.country, l.lat_lng, l.place_id, l.plus_code_compound,
    l.plus_code_global, l.lsoa, l.msoa, l.parliamentary_constituency_name, l.mp_parl_id, l.mp,
    l.mp_party, l.ward, l.district, f.charity_number,
    charityRegisterUrl(f.charity_number, f.country), f.charity_name, f.charity_type,
    pyCharityRegDate(f.charity_reg_date), f.charity_postcode, f.charity_website, f.charity_objectives,
    f.charity_purpose,
    null, null, // food_standards_agency_id / _url: None on a location
    f.network, f.network_id, pyBool(f.is_school), pyBool(l.is_mobile),
    Boolean(l.boundary_geojson), // is_area() == bool(boundary_geojson) (foodbank.py:926-927)
    l.boundary_geojson,
    null, null, null, null, // bounds_*: None on a location
    f.created, // created is the FOOD BANK's, even on a location row
    l.modified, l.edited,
    f.need_id ? toDashedUuid(f.need_id) : null, f.needed_items, f.excess_items, f.need_found,
    f.footprint,
  ];
}

/** build_item_row. */
export function itemRow(i: DumpItemRow): unknown[] {
  return [toDashedUuid(i.uuid), i.name, i.alt_name, i.slug, i.network, i.country, i.lat_lng,
    i.type, i.item, i.category, i.group_name, i.created];
}

/** build_donationpoint_row(dp, is_location=False). */
export function donationPointRow(d: DumpDonationPointRow): unknown[] {
  return [
    toDashedUuid(d.uuid), d.name, d.slug, d.address, d.postcode, d.lat_lng, d.phone_number, d.opening_hours,
    pyBool(d.wheelchair_accessible), d.url, pyBool(d.in_store_only), d.company, d.store_id,
    d.place_id, d.plus_code_compound, d.plus_code_global, d.lsoa, d.msoa,
    d.parliamentary_constituency_name, d.mp_parl_id, d.mp, d.mp_party, d.ward, d.district,
    toDashedUuid(d.fb_uuid), d.fb_name, d.fb_alt_name, d.fb_slug, d.fb_network, d.fb_country, d.fb_lat_lng,
  ];
}

type DpLocation = DumpLocationRow & {
  fb_uuid: string; fb_name: string; fb_alt_name: string | null; fb_slug: string;
  fb_network: string | null; fb_country: string; fb_lat_lng: string;
};

/**
 * build_donationpoint_row(location, is_location=True).
 *
 * The seven columns a location has no equivalent for -- opening_hours,
 * wheelchair_accessible, url, in_store_only, company, store_id -- are None,
 * not "", exactly as dump.py:324-340 writes them.
 */
export function donationPointLocationRow(l: DpLocation): unknown[] {
  return [
    toDashedUuid(l.uuid), l.name, l.slug, l.address, l.postcode, l.lat_lng, l.phone_number,
    null, null, null, null, null, null,
    l.place_id, l.plus_code_compound, l.plus_code_global, l.lsoa, l.msoa,
    l.parliamentary_constituency_name, l.mp_parl_id, l.mp, l.mp_party, l.ward, l.district,
    toDashedUuid(l.fb_uuid), l.fb_name, l.fb_alt_name, l.fb_slug, l.fb_network, l.fb_country, l.fb_lat_lng,
  ];
}

/**
 * build_article_row.
 *
 * organisation_slug is `slugify(foodbank_name)` -- Django's
 * foodbank_name_slug(). Both it and organisation_name are None when the
 * article has no food bank, matching dump.py:401-408's guards.
 */
export function articleRow(a: DumpArticleRow): unknown[] {
  return [a.title, a.url, a.published_date, a.fb_uuid ? toDashedUuid(a.fb_uuid) : null, a.fb_name, a.fb_name ? slugify(a.fb_name) : null];
}
