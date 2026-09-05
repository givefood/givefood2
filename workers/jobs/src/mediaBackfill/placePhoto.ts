import {
  getDonationPointBySlugs,
  getFoodbankBySlug,
  getFoodbankLocationBySlugs,
  upsertPlacePhoto,
} from "@givefood/db";
import type { Env } from "../../worker-configuration";

// gfwfbn `foodbank_photo` / `foodbank_location_photo` /
// `foodbank_donationpoint_photo` (gfwfbn/views.py:493-505 and siblings),
// whose real work is givefood/utils/geo.py:107-141 photo_from_place_id():
// a `.get(place_id=...)` against the PlacePhoto table, and only on a miss
// two billed Google calls -- Place Details for a photo_reference, then
// Place Photo for the bytes -- whose result is saved back so it never
// happens again.
//
// Same shape here, with R2 as the store instead of a Postgres bytea and
// this queue consumer instead of the request path (PLAN.md §3.7: the
// billed call NEVER happens inside a user's request; routes/media.ts just
// enqueues and 404s).
//
// THIS IS NOT HOW THE EXISTING 7,122 PHOTOS GOT IN. Those came out of
// Django's own PlacePhoto table via tools/pg-to-r2/load_photos.py, which
// cost nothing because we already owned the bytes. This consumer exists for
// places that appear AFTER that load -- a new food bank, a new donation
// point -- where there is genuinely no photo anywhere yet. If it ever finds
// itself fetching thousands of photos, something has gone wrong with the
// bulk load rather than right with this.

const CACHE_CONTROL_WEEK = "public, max-age=604800"; // @cache_page(SECONDS_IN_WEEK) on the Django views

// givefood/utils/geo.py:107 photo_from_place_id(place_id, size=1080).
const PHOTO_MAX_WIDTH = 1080;

// media/needs/at/<slug>/photo.jpg
// media/needs/at/<slug>/donationpoint/<dpslug>/photo.jpg
// media/needs/at/<slug>/<locslug>/photo.jpg
//
// ORDER MATTERS, exactly as it does in gfwfbn/urls/generic.py:12-17 and in
// workers/site/src/routes/media.ts: the two-segment location pattern also
// matches a donation point path with locslug="donationpoint", so the
// donation point shape has to be tested first.
const FOODBANK_PHOTO_RE = /^media\/needs\/at\/([^/]+)\/photo\.jpg$/;
const DONATIONPOINT_PHOTO_RE = /^media\/needs\/at\/([^/]+)\/donationpoint\/([^/]+)\/photo\.jpg$/;
const LOCATION_PHOTO_RE = /^media\/needs\/at\/([^/]+)\/([^/]+)\/photo\.jpg$/;

export function isPlacePhotoKey(key: string): boolean {
  return FOODBANK_PHOTO_RE.test(key) || DONATIONPOINT_PHOTO_RE.test(key) || LOCATION_PHOTO_RE.test(key);
}

interface Place {
  placeId: string | null;
  hasPhoto: boolean | null;
}

async function resolvePlace(env: Env, key: string): Promise<Place | null> {
  const db = env.DB.withSession("first-unconstrained");

  const dp = DONATIONPOINT_PHOTO_RE.exec(key);
  if (dp) {
    const row = await getDonationPointBySlugs(db, dp[1]!, dp[2]!);
    return row ? { placeId: row.place_id, hasPhoto: row.place_has_photo } : null;
  }

  const fb = FOODBANK_PHOTO_RE.exec(key);
  if (fb) {
    const row = await getFoodbankBySlug(db, fb[1]!);
    return row ? { placeId: row.place_id, hasPhoto: row.place_has_photo } : null;
  }

  const loc = LOCATION_PHOTO_RE.exec(key);
  if (loc) {
    const row = await getFoodbankLocationBySlugs(db, loc[1]!, loc[2]!);
    return row ? { placeId: row.place_id, hasPhoto: row.place_has_photo } : null;
  }

  return null;
}

interface PlaceDetailsPhoto {
  photo_reference?: string;
  html_attributions?: string[];
}

// geo.py:116-119. `fields=photo` keeps this on the cheapest Place Details
// SKU; the response's first photo is the one Django takes, so it is the one
// taken here.
async function fetchPhotoReference(env: Env, placeId: string): Promise<PlaceDetailsPhoto | null> {
  const url = new URL("https://maps.googleapis.com/maps/api/place/details/json");
  url.searchParams.set("place_id", placeId);
  url.searchParams.set("fields", "photo");
  url.searchParams.set("key", env.GMAP_PLACES_KEY);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Place Details HTTP ${res.status} for ${placeId}`);

  const body = (await res.json()) as { status?: string; result?: { photos?: PlaceDetailsPhoto[] } };

  // ZERO_RESULTS / NOT_FOUND are real answers about a real place, not
  // failures to retry -- Google is saying this place has no photo. Anything
  // else (OVER_QUERY_LIMIT, REQUEST_DENIED, UNKNOWN_ERROR) is worth a retry
  // and then the DLQ, so it throws.
  if (body.status === "ZERO_RESULTS" || body.status === "NOT_FOUND") return null;
  if (body.status !== "OK") throw new Error(`Place Details status ${body.status} for ${placeId}`);

  return body.result?.photos?.[0] ?? null;
}

// geo.py:121-123. Google answers this with a redirect to the image bytes,
// which fetch() follows.
async function fetchPhotoBytes(env: Env, photoReference: string): Promise<ArrayBuffer> {
  const url = new URL("https://maps.googleapis.com/maps/api/place/photo");
  url.searchParams.set("maxwidth", String(PHOTO_MAX_WIDTH));
  url.searchParams.set("photo_reference", photoReference);
  url.searchParams.set("key", env.GMAP_PLACES_KEY);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Place Photo HTTP ${res.status}`);
  return res.arrayBuffer();
}

// Entry point for handleMediaBackfill (queues/jobs.ts) once it recognises
// `key` as a photo.jpg-shaped path.
//
// EVERY "no photo here" OUTCOME RETURNS QUIETLY rather than throwing. A
// throw is a queue retry and then the DLQ, which is right for a Google
// outage and wrong for a place that simply has no photograph -- and the
// latter is permanent, so retrying it three times per request is pure cost.
export async function backfillPlacePhoto(env: Env, key: string): Promise<void> {
  const place = await resolvePlace(env, key);
  if (!place) {
    console.log(`media-backfill: no place for ${key}`);
    return;
  }
  if (!place.placeId) {
    console.log(`media-backfill: place has no place_id for ${key}`);
    return;
  }

  // THE ADMIN'S DELETE BUTTON DEPENDS ON THIS CHECK. Django's photo_delete
  // (gfadmin/views.py:1877-1913) leaves place_has_photo = 1, so its next
  // page view re-fetches the identical photo from Google and reinserts it --
  // its "Delete" is a cache bust, not a delete. The port's
  // clearPlaceHasPhoto() sets the flag to 0 precisely so that a delete can
  // be a delete, and honouring it here is the half of that which lives on
  // this side. See packages/db/src/placePhotos.ts's own note.
  if (place.hasPhoto === false) {
    console.log(`media-backfill: place_has_photo is 0, not refetching ${key}`);
    return;
  }

  // Idempotency. A queue retry, or a second request that raced the first
  // through routes/media.ts's 10-second 404, must not buy the photo twice.
  const existing = await env.MEDIA.head(key);
  if (existing) {
    console.log(`media-backfill: ${key} already in R2`);
    return;
  }

  const photo = await fetchPhotoReference(env, place.placeId);
  if (!photo?.photo_reference) {
    console.log(`media-backfill: Google has no photo for ${place.placeId} (${key})`);
    return;
  }

  const bytes = await fetchPhotoBytes(env, photo.photo_reference);

  const put = await env.MEDIA.put(key, bytes, {
    httpMetadata: { contentType: "image/jpeg", cacheControl: CACHE_CONTROL_WEEK },
  });

  await upsertPlacePhoto(env.DB.withSession("first-unconstrained"), {
    placeId: place.placeId,
    photoRef: photo.photo_reference,
    // givefood_placephoto.html_attributions is the empty string in all 7,117
    // production rows (PLAN.md:946) because Django never stored what Google
    // returns. Stored properly here -- it costs nothing and it is the field
    // Google's terms are about -- without claiming the site does anything
    // with it yet. Whether it should be displayed is the open compliance
    // question PLAN.md already flags.
    htmlAttributions: (photo.html_attributions ?? []).join(" "),
    r2Key: key,
    bytes: bytes.byteLength,
    md5: put.etag,
  });

  console.log(`media-backfill: stored ${key} (${bytes.byteLength} bytes)`);
}
