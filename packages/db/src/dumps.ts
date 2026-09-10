import type { Session } from "./types";

// gfdumps/management/commands/dump.py's four querysets, as keyset-paginated
// readers (WP 5.6, github #59).
//
// PAGINATED, NOT `.all()`: `items` is 333,874 rows on production and the CSV
// it produces is ~63 MB. Django streams that with `.iterator()` against a
// server-side cursor; a Worker has neither, so each reader yields fixed-size
// pages and the caller writes them straight into an R2 multipart upload. At
// no point does a whole dump exist in the isolate.
//
// KEYSET, NOT OFFSET: `LIMIT n OFFSET m` re-scans m rows every page, so the
// items dump alone would read ~55 BILLION rows over its 334 pages. Every
// reader therefore carries the last row's sort key forward. D1 bills rows
// read, and this is the difference between ~360k and a bill.
//
// Every ORDER BY ends in `id` -- Django's own orderings (`name`, `created`,
// `-published_date`) are not unique, so Postgres was free to break ties
// however it liked and the dumps were never stable between runs. A keyset
// cursor REQUIRES a total order to be correct at all: without the tiebreak,
// rows sharing a sort value straddle a page boundary and are silently
// dropped or repeated. So this is a fidelity improvement forced by the
// mechanism, not a stylistic one.
const PAGE = 1000;

/**
 * One page of rows.
 *
 * Extracted so the cursor and the statement do not infer through each other:
 * inlining `const stmt = cursor ? prepare(sql).bind(...) : prepare(sql)` makes
 * `stmt` depend on `cursor`, which is assigned from `stmt`'s own results, and
 * TypeScript gives up (TS7022) and silently types the whole read `any`.
 */
async function page<T>(session: Session, sql: string, binds: unknown[]): Promise<T[]> {
  const prepared = session.prepare(sql);
  const stmt = binds.length > 0 ? prepared.bind(...binds) : prepared;
  const { results } = await stmt.all<T>();
  return results;
}

export interface DumpFoodbankRow {
  id: number; uuid: string; name: string; alt_name: string | null; slug: string;
  url: string; shopping_list_url: string | null; rss_url: string | null; news_url: string | null;
  donation_points_url: string | null; locations_url: string | null; contacts_url: string | null;
  phone_number: string | null; secondary_phone_number: string | null; contact_email: string;
  address: string; postcode: string; country: string; lat_lng: string;
  place_id: string | null; plus_code_compound: string | null; plus_code_global: string | null;
  lsoa: string | null; msoa: string | null; parliamentary_constituency_name: string | null;
  mp_parl_id: number | null; mp: string | null; mp_party: string | null; ward: string | null; district: string | null;
  charity_number: string | null; charity_name: string | null; charity_type: string | null;
  charity_reg_date: string | null; charity_postcode: string | null; charity_website: string | null;
  charity_objectives: string | null; charity_purpose: string | null;
  fsa_id: string | null; network: string | null; network_id: string | null;
  is_school: number | null; footprint: number | null;
  bounds_north: number | null; bounds_south: number | null; bounds_east: number | null; bounds_west: number | null;
  created: string; modified: string; edited: string | null;
  need_id: string | null; needed_items: string | null; excess_items: string | null; need_found: string | null;
}

export interface DumpLocationRow {
  foodbank_id: number; uuid: string; name: string; slug: string;
  address: string | null; postcode: string | null; lat_lng: string;
  phone_number: string | null; email: string | null;
  place_id: string | null; plus_code_compound: string | null; plus_code_global: string | null;
  lsoa: string | null; msoa: string | null; parliamentary_constituency_name: string | null;
  mp_parl_id: number | null; mp: string | null; mp_party: string | null; ward: string | null; district: string | null;
  is_mobile: number | null; boundary_geojson: string | null; modified: string; edited: string | null;
}

const FOODBANK_COLS = `f.id, f.uuid, f.name, f.alt_name, f.slug, f.url, f.shopping_list_url, f.rss_url,
  f.news_url, f.donation_points_url, f.locations_url, f.contacts_url, f.phone_number,
  f.secondary_phone_number, f.contact_email, f.address, f.postcode, f.country, f.lat_lng, f.place_id,
  f.plus_code_compound, f.plus_code_global, f.lsoa, f.msoa, f.parliamentary_constituency_name,
  f.mp_parl_id, f.mp, f.mp_party, f.ward, f.district, f.charity_number, f.charity_name,
  f.charity_type, f.charity_reg_date, f.charity_postcode, f.charity_website, f.charity_objectives,
  f.charity_purpose, f.fsa_id, f.network, f.network_id, f.is_school, f.footprint, f.bounds_north,
  f.bounds_south, f.bounds_east, f.bounds_west, f.created, f.modified, f.edited,
  n.need_id AS need_id, n.change_text AS needed_items, n.excess_change_text AS excess_items,
  n.created AS need_found`;

/**
 * `Foodbank.objects.select_related("latest_need").filter(is_closed=False).order_by("name")`,
 * a page at a time.
 */
export async function* dumpFoodbanks(session: Session): AsyncGenerator<DumpFoodbankRow[]> {
  let cursor: { name: string; id: number } | null = null;
  for (;;) {
    const sql: string =
      `SELECT ${FOODBANK_COLS} FROM foodbank f LEFT JOIN foodbankchange n ON n.id = f.latest_need_id
       WHERE f.is_closed = 0` +
      (cursor ? ` AND (f.name > ?1 OR (f.name = ?1 AND f.id > ?2))` : "") +
      ` ORDER BY f.name ASC, f.id ASC LIMIT ${PAGE}`;
    const results: DumpFoodbankRow[] = await page<DumpFoodbankRow>(session, sql, cursor ? [cursor.name, cursor.id] : []);
    if (results.length === 0) return;
    yield results;
    if (results.length < PAGE) return;
    const last = results[results.length - 1]!;
    cursor = { name: last.name, id: last.id };
  }
}

/**
 * `foodbank.locations()` for a page of food banks, in one query.
 *
 * NO is_closed FILTER, matching foodbank.py:545-546 -- `locations()` returns
 * every location of the food bank. Only the PARENT is filtered.
 */
export async function locationsForFoodbanks(session: Session, foodbankIds: number[]): Promise<Map<number, DumpLocationRow[]>> {
  const out = new Map<number, DumpLocationRow[]>();
  if (foodbankIds.length === 0) return out;
  const placeholders = foodbankIds.map((_, i) => `?${i + 1}`).join(", ");
  const { results } = await session
    .prepare(
      `SELECT foodbank_id, uuid, name, slug, address, postcode, lat_lng, phone_number, email,
              place_id, plus_code_compound, plus_code_global, lsoa, msoa,
              parliamentary_constituency_name, mp_parl_id, mp, mp_party, ward, district,
              is_mobile, boundary_geojson, modified, edited
       FROM foodbanklocation WHERE foodbank_id IN (${placeholders}) ORDER BY name ASC, id ASC`,
    )
    .bind(...foodbankIds)
    .all<DumpLocationRow>();
  for (const row of results) {
    const list = out.get(row.foodbank_id);
    if (list) list.push(row);
    else out.set(row.foodbank_id, [row]);
  }
  return out;
}

export interface DumpItemRow {
  id: number; item: string | null; type: string | null; category: string | null;
  group_name: string | null; created: string;
  uuid: string; name: string; alt_name: string | null; slug: string;
  network: string | null; country: string; lat_lng: string;
}

/** `FoodbankChangeLine.objects.select_related("foodbank").all().order_by("created")` -- 333,874 rows. */
export async function* dumpItems(session: Session): AsyncGenerator<DumpItemRow[]> {
  let cursor: { created: string; id: number } | null = null;
  for (;;) {
    const sql: string =
      `SELECT l.id, l.item, l.type, l.category, l.group_name, l.created,
              f.uuid, f.name, f.alt_name, f.slug, f.network, f.country, f.lat_lng
       FROM foodbankchangeline l JOIN foodbank f ON f.id = l.foodbank_id` +
      (cursor ? ` WHERE (l.created > ?1 OR (l.created = ?1 AND l.id > ?2))` : "") +
      ` ORDER BY l.created ASC, l.id ASC LIMIT ${PAGE}`;
    const results: DumpItemRow[] = await page<DumpItemRow>(session, sql, cursor ? [cursor.created, cursor.id] : []);
    if (results.length === 0) return;
    yield results;
    if (results.length < PAGE) return;
    const last = results[results.length - 1]!;
    cursor = { created: last.created, id: last.id };
  }
}

export interface DumpDonationPointRow {
  id: number; uuid: string; name: string; slug: string; address: string | null; postcode: string | null;
  lat_lng: string; phone_number: string | null; opening_hours: string | null;
  wheelchair_accessible: number | null; url: string | null; in_store_only: number | null;
  company: string | null; store_id: string | null; place_id: string | null;
  plus_code_compound: string | null; plus_code_global: string | null; lsoa: string | null; msoa: string | null;
  parliamentary_constituency_name: string | null; mp_parl_id: number | null; mp: string | null;
  mp_party: string | null; ward: string | null; district: string | null;
  fb_uuid: string; fb_name: string; fb_alt_name: string | null; fb_slug: string;
  fb_network: string | null; fb_country: string; fb_lat_lng: string;
}

const FB_JOIN_COLS = `f.uuid AS fb_uuid, f.name AS fb_name, f.alt_name AS fb_alt_name, f.slug AS fb_slug,
  f.network AS fb_network, f.country AS fb_country, f.lat_lng AS fb_lat_lng`;

/** `FoodbankDonationPoint.objects...filter(is_closed=False).order_by("name")`. */
export async function* dumpDonationPoints(session: Session): AsyncGenerator<DumpDonationPointRow[]> {
  let cursor: { name: string; id: number } | null = null;
  for (;;) {
    const sql: string =
      `SELECT d.id, d.uuid, d.name, d.slug, d.address, d.postcode, d.lat_lng, d.phone_number,
              d.opening_hours, d.wheelchair_accessible, d.url, d.in_store_only, d.company, d.store_id,
              d.place_id, d.plus_code_compound, d.plus_code_global, d.lsoa, d.msoa,
              d.parliamentary_constituency_name, d.mp_parl_id, d.mp, d.mp_party, d.ward, d.district,
              ${FB_JOIN_COLS}
       FROM foodbankdonationpoint d JOIN foodbank f ON f.id = d.foodbank_id
       WHERE d.is_closed = 0` +
      (cursor ? ` AND (d.name > ?1 OR (d.name = ?1 AND d.id > ?2))` : "") +
      ` ORDER BY d.name ASC, d.id ASC LIMIT ${PAGE}`;
    const results: DumpDonationPointRow[] = await page<DumpDonationPointRow>(session, sql, cursor ? [cursor.name, cursor.id] : []);
    if (results.length === 0) return;
    yield results;
    if (results.length < PAGE) return;
    const last = results[results.length - 1]!;
    cursor = { name: last.name, id: last.id };
  }
}

export interface DumpDpLocationRow extends DumpLocationRow {
  id: number;
}

/** A donation-point location with its parent food bank's columns joined on. */
export interface DumpDpLocationJoinedRow extends DumpDpLocationRow {
  fb_uuid: string; fb_name: string; fb_alt_name: string | null; fb_slug: string;
  fb_network: string | null; fb_country: string; fb_lat_lng: string;
}

/** `FoodbankLocation.objects...filter(is_closed=False, is_donation_point=True).order_by("name")`. */
export async function* dumpDonationPointLocations(session: Session): AsyncGenerator<DumpDpLocationJoinedRow[]> {
  let cursor: { name: string; id: number } | null = null;
  for (;;) {
    const sql: string =
      `SELECT l.id, l.foodbank_id, l.uuid, l.name, l.slug, l.address, l.postcode, l.lat_lng,
              l.phone_number, l.email, l.place_id, l.plus_code_compound, l.plus_code_global,
              l.lsoa, l.msoa, l.parliamentary_constituency_name, l.mp_parl_id, l.mp, l.mp_party,
              l.ward, l.district, l.is_mobile, l.boundary_geojson, l.modified, l.edited,
              ${FB_JOIN_COLS}
       FROM foodbanklocation l JOIN foodbank f ON f.id = l.foodbank_id
       WHERE l.is_closed = 0 AND l.is_donation_point = 1` +
      (cursor ? ` AND (l.name > ?1 OR (l.name = ?1 AND l.id > ?2))` : "") +
      ` ORDER BY l.name ASC, l.id ASC LIMIT ${PAGE}`;
    const results: DumpDpLocationJoinedRow[] = await page<DumpDpLocationJoinedRow>(session, sql, cursor ? [cursor.name, cursor.id] : []);
    if (results.length === 0) return;
    yield results;
    if (results.length < PAGE) return;
    const last = results[results.length - 1]!;
    cursor = { name: last.name, id: last.id };
  }
}

export interface DumpArticleRow {
  id: number; title: string; url: string; published_date: string;
  fb_uuid: string | null; fb_name: string | null;
}

/**
 * `FoodbankArticle.objects.select_related("foodbank").all().order_by("-published_date")`.
 *
 * organisation_name is JOINED here, where Django read its own denormalised
 * `FoodbankArticle.foodbank_name` (articles.py:22). That column was not
 * ported, so the join is the only source -- and it means a renamed food bank
 * now shows its CURRENT name where Django showed the name captured when the
 * article was crawled. Recorded rather than hidden: it is the one place this
 * dump cannot be byte-identical to Django's by construction.
 */
export async function* dumpArticles(session: Session): AsyncGenerator<DumpArticleRow[]> {
  let cursor: { published_date: string; id: number } | null = null;
  for (;;) {
    const sql: string =
      `SELECT a.id, a.title, a.url, a.published_date, f.uuid AS fb_uuid, f.name AS fb_name
       FROM foodbankarticle a LEFT JOIN foodbank f ON f.id = a.foodbank_id` +
      (cursor ? ` WHERE (a.published_date < ?1 OR (a.published_date = ?1 AND a.id > ?2))` : "") +
      ` ORDER BY a.published_date DESC, a.id ASC LIMIT ${PAGE}`;
    const results: DumpArticleRow[] = await page<DumpArticleRow>(session, sql, cursor ? [cursor.published_date, cursor.id] : []);
    if (results.length === 0) return;
    yield results;
    if (results.length < PAGE) return;
    const last = results[results.length - 1]!;
    cursor = { published_date: last.published_date, id: last.id };
  }
}
