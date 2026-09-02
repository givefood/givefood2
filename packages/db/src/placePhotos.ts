import type { Session } from "./types";

// gfadmin/views.py:730-775 foodbank_photos_tab and :1877-1913 photo_delete.
// Both were deferred by PLAN.md:10767 for exactly one reason -- "this port's
// photo architecture has no D1-backed photo metadata at all" -- which
// migration 0018_placephoto.sql (PLAN.md's own DDL from :2505-2515)
// discharges.
//
// STANDING CAVEAT, true at the time of writing: nothing writes to
// `placephoto` yet. workers/jobs/src/queues/jobs.ts:60 throws
// "media-backfill: not implemented" for every key that isn't a map image, so
// a photo.jpg miss never inserts a row. Every function here is therefore
// correct but currently returns nothing -- the admin tab is gated on a
// non-zero count so it simply doesn't appear until the backfill consumer
// starts recording rows.

export type PlaceKind = "foodbank" | "location" | "donationpoint";

export interface FoodbankPhotoRow {
  photo_id: number;
  place_id: string;
  r2_key: string;
  place_name: string;
  place_type: PlaceKind;
  photo_url: string;
}

interface PhotoQueryRow {
  photo_id: number;
  place_id: string;
  r2_key: string;
  place_name: string;
  place_type: PlaceKind;
  ord: number;
  foodbank_slug: string;
  own_slug: string | null;
}

// The three-way union both reads below need: every place_id this food bank
// owns -- its own, its locations', its donation points'. views.py:1887-1902
// builds exactly this set (`valid_place_ids`) with three ORM queries; one
// UNION ALL is the same set in one round trip.
const OWNED_PLACE_IDS_SQL = `
  SELECT place_id FROM foodbank              WHERE id = ?1          AND place_id IS NOT NULL
  UNION ALL
  SELECT place_id FROM foodbanklocation      WHERE foodbank_id = ?1 AND place_id IS NOT NULL
  UNION ALL
  SELECT place_id FROM foodbankdonationpoint WHERE foodbank_id = ?1 AND place_id IS NOT NULL
`;

// views.py:730-775 foodbank_photos_tab. The `place_has_photo = 1` predicate
// is views.py:573-576's place_ids_with_photos() -- "of the given food bank,
// locations and donation points, those with a photo", i.e. `place.place_id
// and place.place_has_photo`. Ordering matches views.py:744-771 exactly: the
// food bank itself first, then its locations by name, then its donation
// points by name (foodbank_donation_points(), views.py:778-788, is
// .order_by("name")).
//
// `place_has_photo` is INTEGER 0/1/NULL in D1 (0001_core.sql:31,:65,:91) --
// `= 1` excludes NULL under SQLite's own comparison rules, matching Python's
// truthiness test on the same column.
export async function getPhotosForFoodbankTab(session: Session, foodbankId: number): Promise<FoodbankPhotoRow[]> {
  const sql = `
    SELECT pp.id AS photo_id, pp.place_id, pp.r2_key, f.name AS place_name,
           'foodbank' AS place_type, 0 AS ord, f.slug AS foodbank_slug, NULL AS own_slug
      FROM foodbank f JOIN placephoto pp ON pp.place_id = f.place_id
     WHERE f.id = ?1 AND f.place_id IS NOT NULL AND f.place_has_photo = 1
    UNION ALL
    SELECT pp.id, pp.place_id, pp.r2_key, l.name,
           'location', 1, l.foodbank_slug, l.slug
      FROM foodbanklocation l JOIN placephoto pp ON pp.place_id = l.place_id
     WHERE l.foodbank_id = ?1 AND l.place_id IS NOT NULL AND l.place_has_photo = 1
    UNION ALL
    SELECT pp.id, pp.place_id, pp.r2_key, d.name,
           'donationpoint', 2, d.foodbank_slug, d.slug
      FROM foodbankdonationpoint d JOIN placephoto pp ON pp.place_id = d.place_id
     WHERE d.foodbank_id = ?1 AND d.place_id IS NOT NULL AND d.place_has_photo = 1
    ORDER BY ord, place_name
  `;
  const { results } = await session.prepare(sql).bind(foodbankId).all<PhotoQueryRow>();

  return results.map((row) => ({
    photo_id: row.photo_id,
    place_id: row.place_id,
    r2_key: row.r2_key,
    place_name: row.place_name,
    place_type: row.place_type,
    // views.py:750, :760, :770 verbatim.
    photo_url:
      row.place_type === "foodbank"
        ? `/needs/at/${row.foodbank_slug}/photo.jpg`
        : row.place_type === "location"
          ? `/needs/at/${row.foodbank_slug}/${row.own_slug}/photo.jpg`
          : `/needs/at/${row.foodbank_slug}/donationpoint/${row.own_slug}/photo.jpg`,
  }));
}

// The table a photo's place_id belongs to, so the delete route can clear the
// right row's place_has_photo. A fixed three-value union -- never user
// input, because SQLite cannot bind a table name.
export type PlaceOwnerTable = "foodbank" | "foodbanklocation" | "foodbankdonationpoint";

export interface OwnedPhoto {
  id: number;
  place_id: string;
  r2_key: string;
  owner_table: PlaceOwnerTable;
}

// views.py:1880-1906's ownership check, which IS the whole point of that
// view: collect every place_id this food bank owns and refuse if the photo's
// place_id is not among them.
//
// One deliberate divergence: Django's get_object_or_404 on the photo
// (views.py:1881) runs BEFORE the ownership check, so a nonexistent id gives
// 404 while someone else's photo gives 403 -- an existence oracle. Returning
// null for both collapses that. Low severity on an admin-only page, but
// there is no reason to keep it.
export async function getOwnedPhoto(session: Session, foodbankId: number, photoId: number): Promise<OwnedPhoto | null> {
  const sql = `
    SELECT pp.id, pp.place_id, pp.r2_key,
           CASE
             WHEN EXISTS (SELECT 1 FROM foodbank              WHERE id = ?1          AND place_id = pp.place_id) THEN 'foodbank'
             WHEN EXISTS (SELECT 1 FROM foodbanklocation      WHERE foodbank_id = ?1 AND place_id = pp.place_id) THEN 'foodbanklocation'
             ELSE 'foodbankdonationpoint'
           END AS owner_table
      FROM placephoto pp
     WHERE pp.id = ?2 AND pp.place_id IN (${OWNED_PLACE_IDS_SQL})
  `;
  const row = await session.prepare(sql).bind(foodbankId, photoId).first<OwnedPhoto>();
  return row ?? null;
}

// views.py:1908 photo.delete().
export async function deletePlacePhoto(session: Session, photoId: number): Promise<void> {
  await session.prepare("DELETE FROM placephoto WHERE id = ?").bind(photoId).run();
}

// NOT in Django, and the difference matters. Django's photo.delete() leaves
// place_has_photo = 1 on the owning row; gfwfbn/views.py:501-504 gates the
// public photo route on that flag and givefood/utils/geo.py:107-141 catches
// the resulting DoesNotExist by RE-FETCHING from Google Places (two billed
// calls) and re-inserting an identical row. So Django's "Delete" button is a
// cache bust, not a delete -- the photo is back on the next page view.
//
// Clearing the flag is half of making it a real delete. The other half is
// the media-backfill queue consumer honouring it: serveMedia
// (workers/site/src/routes/media.ts:58-64) currently enqueues a backfill on
// ANY R2 miss with no such check. Until that consumer exists and skips a
// backfill when place_has_photo is 0, this is still a refresh, and the
// admin UI says so rather than promising otherwise.
//
// `table` comes from getOwnedPhoto's own CASE expression (a fixed
// three-value literal), never from a request -- SQLite cannot bind a table
// name, so this is the only safe source for it.
export async function clearPlaceHasPhoto(session: Session, table: PlaceOwnerTable, placeId: string): Promise<void> {
  await session.prepare(`UPDATE ${table} SET place_has_photo = 0 WHERE place_id = ?`).bind(placeId).run();
}

// The photos tab trigger in foodbank_detail.njk is rendered only when this
// is non-zero, exactly as gfadmin/templates/admin/foodbank.html:51 gates on
// `{% if counts.photos %}`. Kept here rather than folded into
// foodbankAdmin.ts's getFoodbankAdminTotals() so that this whole feature --
// table, queries, count -- lands as one addable unit; see this WP's report
// for the one-line change that merges it into that query instead.
export async function getFoodbankPhotoCount(session: Session, foodbankId: number): Promise<number> {
  const sql = `
    SELECT COUNT(*) AS n FROM placephoto pp
     WHERE pp.place_id IN (${OWNED_PLACE_IDS_SQL})
  `;
  const row = await session.prepare(sql).bind(foodbankId).first<{ n: number }>();
  return row?.n ?? 0;
}
