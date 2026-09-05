import { Hono } from "hono";
import {
  getAllOpenDonationPoints,
  getDonationPointsByIds,
  getFoodbanksByIds,
  getLocationsByIds,
  getOpenDonationPointCoordinates,
  getOpenDonationPointLocationCoordinates,
  getOpenFoodbanksWithDeliveryAddress,
  toDashedUuid,
  type CoordinateRow,
  type DonationPointRow,
  type FoodbankChangeRow,
  type FoodbankLocationRow,
  type FoodbankWithLatestNeed,
} from "@givefood/db";
import { R_EARTHDISTANCE, isUk, miles, nearest, type Ranked } from "@givefood/geo";
import { round2, type SerialisableValue } from "@givefood/serialise";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { geocode } from "../../lib/geocode";
import { apiResponse, SECONDS_IN_DAY, SECONDS_IN_WEEK } from "../../lib/apiResponse";
import {
  emailOrFoodbankEmail,
  fullAddressNullable,
  fullAddressUnconditional,
  noItems,
  phoneOrFoodbankPhone,
  urlWithRefDonationPoint,
  urlWithRefFoodbank,
} from "@givefood/models";

// gfapi2 `donationpoints` / `donationpoint_search` -- givefood/urls.py:
// /donationpoints/, /donationpoints/search/. Ported straight from
// gfapi2/views.py, verbatim. `donationpoints`/`donationpoints/search` are
// live but undocumented on the real API (PLAN.md §7.6) -- ported as-is,
// not treated as a new feature.
export const api2DonationpointsApp = new Hono<AppEnv>();

// Every "self"/"html" URL below is a literal "https://www.givefood.org.uk"
// prefix, not derived from the request (see task point 12) -- reproduced
// as a hardcoded string here, same as the sibling api2 route files.
const SITE_DOMAIN = "https://www.givefood.org.uk";

// DonationPointRow.lat_lng / FoodbankLocationRow.lat_lng /
// FoodbankRow.delivery_lat_lng are trusted, always well-formed "lat,lng"
// strings written by our own ingestion, not user input -- plain
// split+parseFloat, no validation, matching the sibling
// api2/foodbanks.ts's parseLatLng exactly.
function parseLatLng(latLng: string): [number, number] {
  const parts = latLng.split(",");
  return [parseFloat(parts[0] as string), parseFloat(parts[1] as string)];
}

// Django's `is_uk(lat_lng)` does a bare `float(lat_lng.split(",")[0])` /
// `[1]` with NO format pre-validation before it here (frozen bug B5,
// PLAN.md §7.5.4 / §4.8.2: only `foodbank_search` has the `.isdigit()`
// guard seen in the sibling foodbanks.ts -- this endpoint relies on
// float() raising instead). Python's float() raises ValueError on
// non-numeric input, and unpacking two values from a comma count != 1
// raises too -- both uncaught, surfacing as a 500. JS's Number()/
// parseFloat() never throw (they silently return NaN), which would make
// `isUk(NaN, NaN) === true` instead -- a worse divergence than not
// matching Python's exact exception type, since it would let a garbage
// lat_lng return a 200 instead of erroring. This throws in the same
// situations Python's does, so the same uncaught-exception behaviour
// (not a clean 400) reaches the client. Deliberately called with NO
// try/catch around it -- the real Django try/except only wraps the
// find_donationpoints() call further down, not is_uk().
function parseQueryLatLng(latLng: string): [number, number] {
  const parts = latLng.split(",");
  if (parts.length !== 2) throw new Error(`not enough values to unpack: '${latLng}'`);
  const [latStr, lngStr] = parts as [string, string];
  const lat = Number(latStr);
  const lng = Number(lngStr);
  if (latStr.trim() === "" || lngStr.trim() === "" || Number.isNaN(lat) || Number.isNaN(lng)) {
    throw new Error(`could not convert string to float: '${latLng}'`);
  }
  return [lat, lng];
}

// --- donationpoints (GET /donationpoints/) ---------------------------------
// format defaults to "geojson" here (unlike every other gfapi2 endpoint,
// which defaults to "json"), and any other format is a bare 400 -- the
// view hard-fails before ApiResponse's own (wider) ALLOWED_FORMATS table
// for this objName is ever reached, so format is effectively fixed.
api2DonationpointsApp.get("/donationpoints/", async (c) => {
  const format = c.req.query("format") ?? "geojson";
  if (format !== "geojson") {
    return new Response("", { status: 400 });
  }

  const session = dbSession(c);
  const [donationPoints, deliveryAddresses] = await Promise.all([
    getAllOpenDonationPoints(session),
    getOpenFoodbanksWithDeliveryAddress(session),
  ]);

  const features: SerialisableValue[] = [];

  for (const dp of donationPoints) {
    const [lat, lng] = parseLatLng(dp.lat_lng);
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lng, lat] },
      properties: {
        name: dp.name,
        slug: dp.slug,
        address: fullAddressUnconditional(dp.address, dp.postcode),
        url: `${SITE_DOMAIN}/needs/at/${dp.foodbank_slug}/donationpoint/${dp.slug}/`,
        network: dp.foodbank_network,
        telephone: dp.phone_number,
        // Returns `false` (not null) when there's no url -- reproduced
        // verbatim by urlWithRefDonationPoint, matching Python's
        // `return False`.
        web: urlWithRefDonationPoint(dp.url),
        foodbank: dp.foodbank_name,
        foodbank_slug: dp.foodbank_slug,
        foodbank_url: `${SITE_DOMAIN}/needs/at/${dp.foodbank_slug}/`,
        parliamentary_constituency: dp.parliamentary_constituency_name,
      },
    });
  }

  for (const fb of deliveryAddresses) {
    // getOpenFoodbanksWithDeliveryAddress only filters on
    // delivery_address != '' -- delivery_lat_lng itself is still nullable
    // at the schema level. Django's Foodbank.delivery_long()/
    // delivery_latt() dereference it unguarded too, so a genuinely-null
    // value here crashes exactly like the source does; not a case this
    // handler adds a guard for.
    const [lat, lng] = parseLatLng(fb.delivery_lat_lng!);
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lng, lat] },
      properties: {
        name: `${fb.name} delivery address`,
        slug: fb.slug,
        address: fullAddressUnconditional(fb.address, fb.postcode),
        url: `${SITE_DOMAIN}/needs/at/${fb.slug}/`,
        network: fb.network,
        telephone: fb.phone_number,
        web: urlWithRefFoodbank(fb.url),
        // Self-referential, matching Django's odd copy-onto-self for
        // template uniformity: a delivery-address entry's "foodbank" and
        // "foodbank_url" are its own.
        foodbank: fb.name,
        foodbank_slug: fb.slug,
        foodbank_url: `${SITE_DOMAIN}/needs/at/${fb.slug}/`,
        parliamentary_constituency: fb.parliamentary_constituency_name,
      },
    });
  }

  const responseData: SerialisableValue = { type: "FeatureCollection", features };
  return apiResponse(responseData, "donationpoints", format, SECONDS_IN_WEEK);
});

// find_donationpoints(lat_lng, 20)'s two chained candidate querysets --
// open donation points tagged "donationpoint", open is_donation_point
// locations tagged "location". PLAN.md §7.5.2 proves a single global
// nearest() call over the combined array is contract-exact for every
// skip_first=False search (every one of these), so the two sources are
// concatenated before ranking once, not independently capped at 20 first.
//
// WP 2.5 perf: ranking runs against the cheap id+coordinate candidate set
// (a covering-index scan), not the full open-donation-point/open-location
// row sets -- full rows for only the 20 survivors are fetched afterward,
// by id.
type DonationpointSearchCandidate = { kind: "donationpoint" | "location"; coord: CoordinateRow };

// --- donationpoint_search (GET /donationpoints/search/) --------------------
// geocoding, matching the sibling foodbanks.ts's foodbank_search: the real
// view falls back to Google Maps Geocoding when only `?address=` is given
// -- ported via lib/geocode.ts. A failed/misconfigured geocode falls back
// to "0,0", which the isUk() check below then correctly rejects as a 400.
api2DonationpointsApp.get("/donationpoints/search/", async (c) => {
  const format = c.req.query("format") ?? "json";
  let latLngParam = c.req.query("lat_lng");
  const addressParam = c.req.query("address");

  if (format === "geojson") {
    return new Response("", { status: 400 });
  }
  if (!latLngParam && !addressParam) {
    return new Response("", { status: 400 });
  }
  if (addressParam && !latLngParam) {
    latLngParam = await geocode(c, addressParam);
  }

  // latLngParam is guaranteed defined here: the only ways to reach this
  // point without it are covered by the two early returns above (or it was
  // just set by geocode()).
  // B5: no digit-format pre-validation and no try/catch here -- see
  // parseQueryLatLng's own comment.
  const [lat, lng] = parseQueryLatLng(latLngParam as string);
  if (!isUk(lat, lng)) {
    return new Response("", { status: 400 });
  }

  const session = dbSession(c);

  // The real `except Exception: return HttpResponseBadRequest()` wraps
  // only `find_donationpoints()` -- i.e. the candidate fetch, the ranking,
  // and the `latest_need` enrichment fetch below. It does NOT wrap the
  // per-item response-building loop further down, so a null `latest_need`
  // there (frozen bug B12) still surfaces as an uncaught 500, distinct
  // from the clean 400 this catch returns.
  let ranked: Ranked<DonationpointSearchCandidate>[];
  let donationPointById: Map<number, DonationPointRow>;
  let locationById: Map<number, FoodbankLocationRow>;
  let foodbankById: Map<number, FoodbankWithLatestNeed>;
  try {
    const [donationPointCoords, locationCoords] = await Promise.all([
      getOpenDonationPointCoordinates(session),
      getOpenDonationPointLocationCoordinates(session),
    ]);

    const candidates: DonationpointSearchCandidate[] = [
      ...donationPointCoords.map((coord): DonationpointSearchCandidate => ({ kind: "donationpoint", coord })),
      ...locationCoords.map((coord): DonationpointSearchCandidate => ({ kind: "location", coord })),
    ];

    ranked = nearest(
      candidates,
      lat,
      lng,
      (candidate) => [candidate.coord.latitude, candidate.coord.longitude],
      20,
      R_EARTHDISTANCE,
      false,
    );

    // Full rows for only the 20 survivors -- donationpoint ids fetch their
    // own donation-point row; location ids fetch their own location row.
    const donationPointIds = ranked.filter((r) => r.item.kind === "donationpoint").map((r) => r.item.coord.id);
    const locationIds = ranked.filter((r) => r.item.kind === "location").map((r) => r.item.coord.id);
    const [donationPoints, locations] = await Promise.all([
      getDonationPointsByIds(session, donationPointIds),
      getLocationsByIds(session, locationIds),
    ]);
    donationPointById = new Map(donationPoints.map((dp) => [dp.id, dp]));
    locationById = new Map(locations.map((loc) => [loc.id, loc]));

    // Enrich with the PARENT food bank's `latest_need` -- both branches
    // read it (`donationpoint.foodbank.latest_need` in Django), mirroring
    // the per-row access the source does only after slicing (PLAN.md
    // §7.2's N+1 note).
    const foodbankIds = Array.from(
      new Set([...donationPoints.map((dp) => dp.foodbank_id), ...locations.map((loc) => loc.foodbank_id)]),
    );
    const foodbanksWithNeed = await getFoodbanksByIds(session, foodbankIds);
    foodbankById = new Map(foodbanksWithNeed.map((fb) => [fb.id, fb]));
  } catch {
    return new Response("", { status: 400 });
  }

  const responseList = ranked.map(({ item, distanceM }) => {
    const dp = item.kind === "donationpoint" ? donationPointById.get(item.coord.id)! : null;
    const loc = item.kind === "location" ? locationById.get(item.coord.id)! : null;
    const row = (dp ?? loc)! as { foodbank_id: number; uuid: string; slug: string; name: string; lat_lng: string };
    const parentFoodbank = foodbankById.get(row.foodbank_id)!;
    // Frozen bug B12: latest_need dereferenced unguarded in the source --
    // if it's null this throws here exactly as it 500s in Django. This
    // is OUTSIDE the try/catch above, matching the source's scope.
    const latestNeed: FoodbankChangeRow = parentFoodbank.latestNeed!;
    const common = dp ?? loc!;

    const result: Record<string, SerialisableValue> = {
      id: toDashedUuid(row.uuid),
      type: item.kind,
      slug: row.slug,
      name: row.name,
      lat_lng: row.lat_lng,
      distance_m: Math.trunc(distanceM),
      distance_mi: round2(miles(distanceM)),
      address: dp ? fullAddressUnconditional(dp.address, dp.postcode) : fullAddressNullable(loc!.address, loc!.postcode),
      postcode: common.postcode,
      politics: {
        parliamentary_constituency: common.parliamentary_constituency_name,
        mp: common.mp,
        mp_party: common.mp_party,
        mp_parl_id: common.mp_parl_id,
        ward: common.ward,
        district: common.district,
        urls: {
          self: `${SITE_DOMAIN}/api/2/constituency/${common.parliamentary_constituency_slug}/`,
          html: `${SITE_DOMAIN}/needs/in/constituency/${common.parliamentary_constituency_slug}/`,
        },
      },
      needs: {
        id: toDashedUuid(latestNeed.need_id),
        needs: latestNeed.change_text,
        excess: latestNeed.excess_change_text,
        number: noItems(latestNeed.change_text),
        found: { __datetime: latestNeed.created },
      },
      foodbank: {
        name: common.foodbank_name,
        slug: common.foodbank_slug,
        network: common.foodbank_network,
        urls: {
          self: `${SITE_DOMAIN}/api/2/foodbank/${common.foodbank_slug}/`,
          html: `${SITE_DOMAIN}/needs/at/${common.foodbank_slug}/`,
        },
      },
    };

    // "urls" (and "phone"/"email") are added AFTER the base dict in the
    // source -- a later-inserted key than the fields above, and the two
    // branches diverge in which keys they add at all (donationpoint gets
    // no "email"; location gets no conditional "homepage"). Assigned here
    // rather than interleaved into the object literal, to preserve that
    // exact insertion order.
    if (dp) {
      result.phone = dp.phone_number;
      const urls: Record<string, SerialisableValue> = {
        html: `${SITE_DOMAIN}/needs/at/${dp.foodbank_slug}/donationpoint/${dp.slug}/`,
      };
      if (dp.url) urls.homepage = dp.url;
      result.urls = urls;
    } else {
      result.phone = phoneOrFoodbankPhone(loc!.phone_number, loc!.foodbank_phone_number);
      result.email = emailOrFoodbankEmail(loc!.email, loc!.foodbank_email);
      result.urls = { html: `${SITE_DOMAIN}/needs/at/${loc!.foodbank_slug}/${loc!.slug}/` };
    }

    return result;
  });

  return apiResponse(responseList, "donationpoints", format, SECONDS_IN_DAY);
});
