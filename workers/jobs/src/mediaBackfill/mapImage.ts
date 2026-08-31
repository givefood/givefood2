import { getDonationPointsByFoodbankId, getFoodbankBySlug, getFoodbankLocationBySlugs, getLocationLatLngsByFoodbankId } from "@givefood/db";
import type { Env } from "../../worker-configuration";

// gfwfbn `foodbank_map`/`foodbank_map_size`/`foodbank_location_map`/
// `foodbank_location_map_size` (gfwfbn/views.py:400-487, 866-928). PLAN.md
// §3.7: this logic runs ONCE per R2 miss here, in the backfill queue
// consumer -- never inline in a user's request (routes/media.ts in
// workers/site just enqueues a "media-backfill" message and 404s
// immediately on a miss). Both real Django views proxy
// maps.googleapis.com/maps/api/staticmap live on every request with zero
// persistence; this is the fix PLAN.md's own cost analysis (§10.7,
// "eliminated from the request path") calls for.
//
// gfwfbn/views.py:400-408 MAP_SIZE_CONFIG / get_map_dimensions_and_scale.
const MAP_SIZE_CONFIG: Record<string, { dimensions: string; scale: number }> = {
  "300": { dimensions: "150x150", scale: 2 },
  "600": { dimensions: "600x400", scale: 1 },
  "1080": { dimensions: "540x360", scale: 2 },
};

const STATIC_MAP_BASE_URL = "https://maps.googleapis.com/maps/api/staticmap";
const CACHE_CONTROL_WEEK = "public, max-age=604800"; // PLAN.md §3.7's httpMetadata example, matching @cache_page(SECONDS_IN_WEEK)

// media/needs/at/<slug>/map.png
// media/needs/at/<slug>/maps/<size>.png
// media/needs/at/<slug>/<locslug>/map.png
// media/needs/at/<slug>/<locslug>/maps/<size>.png
const FOODBANK_MAP_RE = /^media\/needs\/at\/([^/]+)\/(?:maps\/(\d+)\.png|map\.png)$/;
const LOCATION_MAP_RE = /^media\/needs\/at\/([^/]+)\/([^/]+)\/(?:maps\/(\d+)\.png|map\.png)$/;

export function isMapImageKey(key: string): boolean {
  return FOODBANK_MAP_RE.test(key) || LOCATION_MAP_RE.test(key);
}

// GeoJSON coordinates are [lng, lat]; Google Static Maps path points are
// "lat,lng". Simplifies to at most 100 points (Google's URL-length limit
// is the reason, not visual fidelity) and rounds to 4dp (~11m accuracy) --
// gfwfbn/views.py:895-919's exact step-sampling/always-keep-the-last-point
// (closes the polygon) algorithm.
function simplifiedPathParam(coordinates: readonly [number, number][]): string {
  const maxPoints = 100;
  let points = coordinates;
  if (points.length > maxPoints) {
    const step = Math.max(2, Math.floor(points.length / maxPoints));
    const simplified = points.filter((_, i) => i % step === 0);
    const last = points[points.length - 1]!;
    if (!simplified.some(([lng, lat]) => lng === last[0] && lat === last[1])) simplified.push(last);
    points = simplified;
  }
  let path = "fillcolor:0xf7a72333|color:0xf7a723ff|weight:1";
  for (const [lng, lat] of points) path += `|${lat.toFixed(4)},${lng.toFixed(4)}`;
  return path;
}

// FoodbankLocation.boundary_geojson_dict() -> geojson_dict()
// (givefood/utils/geo.py:179-187): strips ONE trailing comma after
// .strip() before json.loads -- a real production data shape
// (givefood/tests/test_utils.py:218-222's own trailing-comma test),
// because boundary_geojson is a raw, unvalidated Textarea field admins
// paste GeoJSON into by hand.
function parseBoundaryGeojson(raw: string): { geometry?: { type?: string; coordinates?: [number, number][][] } } | null {
  const trimmed = raw.trim().replace(/,\s*$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

async function fetchStaticMapPng(params: URLSearchParams): Promise<ArrayBuffer> {
  const response = await fetch(`${STATIC_MAP_BASE_URL}?${params.toString()}`);
  if (!response.ok) throw new Error(`staticmap: upstream ${response.status} for ${params.get("center")}`);
  return response.arrayBuffer();
}

async function backfillFoodbankMap(env: Env, key: string, slug: string, sizeParam: string | undefined): Promise<void> {
  const size = sizeParam ?? "600";
  const sizeConfig = MAP_SIZE_CONFIG[size];
  if (!sizeConfig) throw new Error(`media-backfill: invalid map size ${size} for ${key}`);

  const session = env.DB.withSession("first-unconstrained");
  const foodbank = await getFoodbankBySlug(session, slug);
  if (!foodbank) throw new Error(`media-backfill: no foodbank for slug ${slug} (${key})`);

  let mainMarkers = `icon:https://www.givefood.org.uk/static/img/mapmarkers/32/red.png|${foodbank.lat_lng}`;
  if (foodbank.delivery_address && foodbank.delivery_lat_lng) mainMarkers += `|${foodbank.delivery_lat_lng}`;

  const params = new URLSearchParams();
  params.set("center", foodbank.lat_lng);
  params.set("size", sizeConfig.dimensions);
  params.set("scale", String(sizeConfig.scale));
  params.set("maptype", "roadmap");
  params.set("format", "png");
  params.set("language", "en"); // backfilled once, shared across every locale -- not per-request
  params.set("key", env.GMAP_STATIC_KEY);

  // Django appends dp_markers, then loc_markers, then main_markers, in
  // that order -- `markers` is repeatable, and Google draws later-appended
  // sets on top, so this ordering is what puts the food bank's own red pin
  // above the blue/yellow ones.
  if (foodbank.no_donation_points) {
    const donationPoints = await getDonationPointsByFoodbankId(session, foodbank.id);
    if (donationPoints.length > 0) {
      params.append("markers", `icon:https://www.givefood.org.uk/static/img/mapmarkers/16/blue.png|${donationPoints.map((dp) => dp.lat_lng).join("|")}|`);
    }
  }
  if (foodbank.no_locations !== 0) {
    const locationLatLngs = await getLocationLatLngsByFoodbankId(session, foodbank.id);
    if (locationLatLngs.length > 0) {
      params.append("markers", `icon:https://www.givefood.org.uk/static/img/mapmarkers/16/yellow.png|${locationLatLngs.join("|")}|`);
    }
  }
  params.append("markers", mainMarkers);

  const png = await fetchStaticMapPng(params);
  await env.MEDIA.put(key, png, { httpMetadata: { contentType: "image/png", cacheControl: CACHE_CONTROL_WEEK } });
}

async function backfillLocationMap(env: Env, key: string, slug: string, locslug: string, sizeParam: string | undefined): Promise<void> {
  const size = sizeParam ?? "600";
  const sizeConfig = MAP_SIZE_CONFIG[size];
  if (!sizeConfig) throw new Error(`media-backfill: invalid map size ${size} for ${key}`);

  const session = env.DB.withSession("first-unconstrained");
  const foodbank = await getFoodbankBySlug(session, slug);
  if (!foodbank) throw new Error(`media-backfill: no foodbank for slug ${slug} (${key})`);
  const location = await getFoodbankLocationBySlugs(session, foodbank.slug, locslug);
  if (!location) throw new Error(`media-backfill: no location for ${slug}/${locslug} (${key})`);

  const zoom = location.boundary_geojson ? 11 : 15;
  const params = new URLSearchParams();
  params.set("center", location.lat_lng);
  params.set("zoom", String(zoom));
  params.set("size", sizeConfig.dimensions);
  params.set("scale", String(sizeConfig.scale));
  params.set("maptype", "roadmap");
  params.set("format", "png");
  params.set("visual_refresh", "true");
  params.set("language", "en");
  params.set("key", env.GMAP_STATIC_KEY);

  if (location.boundary_geojson) {
    const boundary = parseBoundaryGeojson(location.boundary_geojson);
    if (boundary?.geometry?.type === "Polygon" && boundary.geometry.coordinates?.[0]) {
      params.set("path", simplifiedPathParam(boundary.geometry.coordinates[0]));
    }
  }

  const png = await fetchStaticMapPng(params);
  await env.MEDIA.put(key, png, { httpMetadata: { contentType: "image/png", cacheControl: CACHE_CONTROL_WEEK } });
}

// Entry point for handleMediaBackfill (queues/jobs.ts) once it recognises
// `key` as a map.png-shaped path. Throws for anything else -- the caller
// only invokes this after isMapImageKey() confirms the shape.
export async function backfillMapImage(env: Env, key: string): Promise<void> {
  const locationMatch = LOCATION_MAP_RE.exec(key);
  if (locationMatch) {
    const [, slug, locslug, sizeFromMaps] = locationMatch;
    await backfillLocationMap(env, key, slug!, locslug!, sizeFromMaps);
    return;
  }
  const foodbankMatch = FOODBANK_MAP_RE.exec(key);
  if (foodbankMatch) {
    const [, slug, sizeFromMaps] = foodbankMatch;
    await backfillFoodbankMap(env, key, slug!, sizeFromMaps);
    return;
  }
  throw new Error(`backfillMapImage: key doesn't look like a map path: ${key}`);
}
