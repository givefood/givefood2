import { Hono } from "hono";
import {
  getAllOpenDonationPoints,
  getFoodbanksByIds,
  getOpenDonationPointLocations,
  getOpenFoodbanksWithDeliveryAddress,
  toDashedUuid,
  type DonationPointRow,
  type FoodbankChangeRow,
  type FoodbankLocationRow,
  type FoodbankWithLatestNeed,
} from "@givefood/db";
import { R_EARTHDISTANCE, isUk, miles, nearest, type Ranked } from "@givefood/geo";
import { round2, type SerialisableValue } from "@givefood/serialise";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { apiResponse, SECONDS_IN_DAY, SECONDS_IN_WEEK } from "../../lib/apiResponse";
import {
  emailOrFoodbankEmail,
  fullAddressNullable,
  fullAddressUnconditional,
  noItems,
  phoneOrFoodbankPhone,
  urlWithRefDonationPoint,
  urlWithRefFoodbank,
} from "../../lib/fields";

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
type DonationpointSearchCandidate =
  | { kind: "donationpoint"; row: DonationPointRow }
  | { kind: "location"; row: FoodbankLocationRow };

// --- donationpoint_search (GET /donationpoints/search/) --------------------
// geocoding judgment call, matching the sibling foodbanks.ts's
// foodbank_search: the real view falls back to Google Maps Geocoding when
// only `?address=` is given. That geocoder isn't ported in this work
// package (no shared geocoding infra exists yet), so an address-only
// request returns a bare 501 instead of silently 400ing or pretending to
// geocode -- flagged here and in the final report rather than guessed at.
api2DonationpointsApp.get("/donationpoints/search/", async (c) => {
  const format = c.req.query("format") ?? "json";
  const latLngParam = c.req.query("lat_lng");
  const addressParam = c.req.query("address");

  if (format === "geojson") {
    return new Response("", { status: 400 });
  }
  if (!latLngParam && !addressParam) {
    return new Response("", { status: 400 });
  }
  if (addressParam && !latLngParam) {
    return new Response("", { status: 501 });
  }

  // latLngParam is guaranteed defined here: the only ways to reach this
  // point without it are covered by the two early returns above.
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
  let foodbankById: Map<number, FoodbankWithLatestNeed>;
  try {
    const [donationPointRows, locationRows] = await Promise.all([
      getAllOpenDonationPoints(session),
      getOpenDonationPointLocations(session),
    ]);

    const candidates: DonationpointSearchCandidate[] = [
      ...donationPointRows.map((row): DonationpointSearchCandidate => ({ kind: "donationpoint", row })),
      ...locationRows.map((row): DonationpointSearchCandidate => ({ kind: "location", row })),
    ];

    ranked = nearest(candidates, lat, lng, (candidate) => parseLatLng(candidate.row.lat_lng), 20, R_EARTHDISTANCE, false);

    // Enrich only the top-20 survivors with the PARENT food bank's
    // `latest_need` -- both branches read it (`donationpoint.foodbank.
    // latest_need` in Django), mirroring the per-row access the source
    // does only after slicing (PLAN.md §7.2's N+1 note).
    const foodbankIds = Array.from(new Set(ranked.map((r) => r.item.row.foodbank_id)));
    const foodbanksWithNeed = await getFoodbanksByIds(session, foodbankIds);
    foodbankById = new Map(foodbanksWithNeed.map((fb) => [fb.id, fb]));
  } catch {
    return new Response("", { status: 400 });
  }

  const responseList = ranked.map(({ item, distanceM }) => {
    const row = item.row; // fields shared by both branches below
    const parentFoodbank = foodbankById.get(row.foodbank_id)!;
    // Frozen bug B12: latest_need dereferenced unguarded in the source --
    // if it's null this throws here exactly as it 500s in Django. This
    // is OUTSIDE the try/catch above, matching the source's scope.
    const latestNeed: FoodbankChangeRow = parentFoodbank.latestNeed!;

    const result: Record<string, SerialisableValue> = {
      id: toDashedUuid(row.uuid),
      type: item.kind,
      slug: row.slug,
      name: row.name,
      lat_lng: row.lat_lng,
      distance_m: Math.trunc(distanceM),
      distance_mi: round2(miles(distanceM)),
      address:
        item.kind === "donationpoint"
          ? fullAddressUnconditional(item.row.address, item.row.postcode)
          : fullAddressNullable(item.row.address, item.row.postcode),
      postcode: row.postcode,
      politics: {
        parliamentary_constituency: row.parliamentary_constituency_name,
        mp: row.mp,
        mp_party: row.mp_party,
        mp_parl_id: row.mp_parl_id,
        ward: row.ward,
        district: row.district,
        urls: {
          self: `${SITE_DOMAIN}/api/2/constituency/${row.parliamentary_constituency_slug}/`,
          html: `${SITE_DOMAIN}/needs/in/constituency/${row.parliamentary_constituency_slug}/`,
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
        name: row.foodbank_name,
        slug: row.foodbank_slug,
        network: row.foodbank_network,
        urls: {
          self: `${SITE_DOMAIN}/api/2/foodbank/${row.foodbank_slug}/`,
          html: `${SITE_DOMAIN}/needs/at/${row.foodbank_slug}/`,
        },
      },
    };

    // "urls" (and "phone"/"email") are added AFTER the base dict in the
    // source -- a later-inserted key than the fields above, and the two
    // branches diverge in which keys they add at all (donationpoint gets
    // no "email"; location gets no conditional "homepage"). Assigned here
    // rather than interleaved into the object literal, to preserve that
    // exact insertion order.
    if (item.kind === "donationpoint") {
      const dp = item.row;
      result.phone = dp.phone_number;
      const urls: Record<string, SerialisableValue> = {
        html: `${SITE_DOMAIN}/needs/at/${dp.foodbank_slug}/donationpoint/${dp.slug}/`,
      };
      if (dp.url) urls.homepage = dp.url;
      result.urls = urls;
    } else {
      const loc = item.row;
      result.phone = phoneOrFoodbankPhone(loc.phone_number, loc.foodbank_phone_number);
      result.email = emailOrFoodbankEmail(loc.email, loc.foodbank_email);
      result.urls = { html: `${SITE_DOMAIN}/needs/at/${loc.foodbank_slug}/${loc.slug}/` };
    }

    return result;
  });

  return apiResponse(responseList, "donationpoints", format, SECONDS_IN_DAY);
});
