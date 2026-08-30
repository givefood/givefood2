import { Hono } from "hono";
import {
  getAllOpenFoodbanks,
  getAllOpenLocations,
  getFoodbanksByIds,
  toDashedUuid,
  type FoodbankChangeRow,
  type FoodbankLocationRow,
  type FoodbankRow,
} from "@givefood/db";
import { R_EARTHDISTANCE, isUk, miles, nearest, type Ranked } from "@givefood/geo";
import { round2, type SerialisableValue } from "@givefood/serialise";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { apiResponse, SECONDS_IN_DAY, SECONDS_IN_MONTH } from "../../lib/apiResponse";
import {
  emailOrFoodbankEmail,
  fullAddressNullable,
  fullAddressUnconditional,
  fullNameLocation,
  noItems,
  phoneOrFoodbankPhone,
  urlWithRefFoodbank,
} from "../../lib/fields";

// gfapi2 `locations` / `location_search` -- givefood/urls.py: /locations/,
// /locations/search/. Ported straight from gfapi2/views.py, verbatim.
export const api2LocationsApp = new Hono<AppEnv>();

// Every "self"/"html" URL below is a literal "https://www.givefood.org.uk"
// prefix, not derived from the request (see task point 12) -- reproduced
// as a hardcoded string here, same as the sibling api2 route files.
const SITE_DOMAIN = "https://www.givefood.org.uk";

// FoodbankRow.lat_lng / FoodbankLocationRow.lat_lng are trusted, always
// well-formed "lat,lng" strings written by our own ingestion, not user
// input -- plain split+parseFloat, no validation, matching the sibling
// api2/foodbanks.ts's parseLatLng exactly (same column shape, same
// unguarded read the Django model methods do).
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
// (not a clean 400) reaches the client. Deliberately NOT wrapped in a
// try/catch at either call site below.
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

// --- locations (GET /locations/) ------------------------------------------
api2LocationsApp.get("/locations/", async (c) => {
  const format = c.req.query("format") ?? "json";
  const session = dbSession(c);

  const locations = await getAllOpenLocations(session);

  let responseData: SerialisableValue;
  if (format !== "geojson") {
    responseData = locations.map((location) => ({
      id: toDashedUuid(location.uuid),
      name: location.name,
      slug: location.slug,
      phone: phoneOrFoodbankPhone(location.phone_number, location.foodbank_phone_number),
      email: emailOrFoodbankEmail(location.email, location.foodbank_email),
      address: fullAddressNullable(location.address, location.postcode),
      postcode: location.postcode,
      lat_lng: location.lat_lng,
      urls: { html: `${SITE_DOMAIN}/needs/at/${location.foodbank_slug}/${location.slug}/` },
      foodbank: {
        name: location.foodbank_name,
        slug: location.foodbank_slug,
        network: location.foodbank_network,
        urls: {
          self: `${SITE_DOMAIN}/api/2/foodbank/${location.foodbank_slug}/`,
          html: `${SITE_DOMAIN}/needs/at/${location.foodbank_slug}/`,
        },
      },
      politics: {
        parliamentary_constituency: location.parliamentary_constituency_name,
        // This endpoint is NOT affected by frozen bug B2 (the PARENT
        // food bank's mp_parl_id substitution is specific to the
        // foodbank() detail endpoint's location loop) -- the location's
        // own mp_parl_id column is used here, verbatim.
        mp: location.mp,
        mp_party: location.mp_party,
        mp_parl_id: location.mp_parl_id,
        ward: location.ward,
        district: location.district,
        urls: {
          self: `${SITE_DOMAIN}/api/2/constituency/${location.parliamentary_constituency_slug}/`,
          html: `${SITE_DOMAIN}/needs/in/constituency/${location.parliamentary_constituency_slug}/`,
        },
      },
    }));
  } else {
    const features = locations.map((location) => {
      const [lat, lng] = parseLatLng(location.lat_lng);
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [lng, lat] },
        properties: {
          name: fullNameLocation(location.name, location.foodbank_name),
          slug: location.slug,
          address: fullAddressNullable(location.address, location.postcode),
          url: `${SITE_DOMAIN}/needs/at/${location.foodbank_slug}/${location.slug}/`,
          network: location.foodbank_network,
          email: emailOrFoodbankEmail(location.email, location.foodbank_email),
          telephone: phoneOrFoodbankPhone(location.phone_number, location.foodbank_phone_number),
          foodbank: location.foodbank_name,
          foodbank_slug: location.foodbank_slug,
          foodbank_url: `${SITE_DOMAIN}/needs/at/${location.foodbank_slug}/`,
          parliamentary_constituency: location.parliamentary_constituency_name,
        },
      };
    });
    responseData = { type: "FeatureCollection", features };
  }

  return apiResponse(responseData, "locations", format, SECONDS_IN_MONTH);
});

// find_locations(lat_lng, 20, False)'s two chained candidate querysets --
// open food banks tagged "organisation", open locations tagged "location".
// PLAN.md §7.5.2 proves a single global nearest() call over the combined
// array is contract-exact for every skip_first=False search (every one of
// these), so the two sources are concatenated before ranking once, not
// independently capped at 20 first.
type LocationSearchCandidate =
  | { kind: "organisation"; row: FoodbankRow }
  | { kind: "location"; row: FoodbankLocationRow };

// --- location_search (GET /locations/search/) ------------------------------
// geocoding judgment call, matching the sibling foodbanks.ts's
// foodbank_search: the real view falls back to Google Maps Geocoding when
// only `?address=` is given. That geocoder isn't ported in this work
// package (no shared geocoding infra exists yet), so an address-only
// request returns a bare 501 instead of silently 400ing or pretending to
// geocode -- flagged here and in the final report rather than guessed at.
api2LocationsApp.get("/locations/search/", async (c) => {
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
  const [foodbanks, locationRows] = await Promise.all([getAllOpenFoodbanks(session), getAllOpenLocations(session)]);

  const candidates: LocationSearchCandidate[] = [
    ...foodbanks.map((row): LocationSearchCandidate => ({ kind: "organisation", row })),
    ...locationRows.map((row): LocationSearchCandidate => ({ kind: "location", row })),
  ];

  const ranked: Ranked<LocationSearchCandidate>[] = nearest(
    candidates,
    lat,
    lng,
    (candidate) => parseLatLng(candidate.row.lat_lng),
    20,
    R_EARTHDISTANCE,
    false,
  );

  // Enrich only the top-20 survivors with `latest_need` -- mirrors the
  // per-row `.latest_need` access the Django view does only after
  // slicing (see the sibling foodbank_search's identical comment / PLAN.md
  // §7.2's N+1 note), not a join over the full open set. One call covers
  // both organisation ids (the row's own id) and the parent food bank ids
  // of the location-type results.
  const foodbankIds = Array.from(
    new Set(ranked.map((r) => (r.item.kind === "organisation" ? r.item.row.id : r.item.row.foodbank_id))),
  );
  const foodbanksWithNeed = await getFoodbanksByIds(session, foodbankIds);
  const foodbankById = new Map(foodbanksWithNeed.map((fb) => [fb.id, fb]));

  const responseList = ranked.map(({ item, distanceM }) => {
    const commonRow = item.row; // fields shared by both branches below

    let address: string;
    let phone: string | null;
    let email: string;
    let foodbankName: string;
    let foodbankSlug: string;
    let foodbankNetwork: string | null;
    let facebookPage: string | null;
    let htmlUrl: string;
    let homepage: string;
    let latestNeed: FoodbankChangeRow;

    if (item.kind === "organisation") {
      const row = item.row;
      const enriched = foodbankById.get(row.id)!;
      address = fullAddressUnconditional(row.address, row.postcode);
      phone = row.phone_number;
      email = row.contact_email;
      // Self-referential, matching Django's odd copy-onto-self for
      // template uniformity: an organisation entry's "foodbank" is
      // itself.
      foodbankName = row.name;
      foodbankSlug = row.slug;
      foodbankNetwork = row.network;
      facebookPage = row.facebook_page;
      htmlUrl = `${SITE_DOMAIN}/needs/at/${row.slug}/`;
      homepage = urlWithRefFoodbank(row.url);
      // Frozen bug B12: latest_need dereferenced unguarded in the source
      // -- if it's null this throws here exactly as it 500s in Django.
      latestNeed = enriched.latestNeed!;
    } else {
      const row = item.row;
      const parentFoodbank = foodbankById.get(row.foodbank_id)!;
      address = fullAddressNullable(row.address, row.postcode);
      phone = phoneOrFoodbankPhone(row.phone_number, row.foodbank_phone_number);
      email = emailOrFoodbankEmail(row.email, row.foodbank_email);
      foodbankName = row.foodbank_name;
      foodbankSlug = row.foodbank_slug;
      foodbankNetwork = row.foodbank_network;
      facebookPage = parentFoodbank.facebook_page;
      // Approximated: the real URL is Django's `wfbn:foodbank_location`
      // route, which this Worker hasn't built yet (Phase 3). This is the
      // same shape every other location URL in this file uses and is
      // expected to be exactly right, but flagged here since it's the one
      // URL in this response not built from a route already verified
      // elsewhere in this pass -- see final report.
      htmlUrl = `${SITE_DOMAIN}/needs/at/${row.foodbank_slug}/${row.slug}/`;
      homepage = urlWithRefFoodbank(parentFoodbank.url);
      latestNeed = parentFoodbank.latestNeed!;
    }

    return {
      id: toDashedUuid(commonRow.uuid),
      type: item.kind,
      slug: commonRow.slug,
      name: commonRow.name,
      lat_lng: commonRow.lat_lng,
      distance_m: Math.trunc(distanceM),
      distance_mi: round2(miles(distanceM)),
      address,
      postcode: commonRow.postcode,
      politics: {
        parliamentary_constituency: commonRow.parliamentary_constituency_name,
        mp: commonRow.mp,
        mp_party: commonRow.mp_party,
        mp_parl_id: commonRow.mp_parl_id,
        ward: commonRow.ward,
        district: commonRow.district,
        urls: {
          self: `${SITE_DOMAIN}/api/2/constituency/${commonRow.parliamentary_constituency_slug}/`,
          html: `${SITE_DOMAIN}/needs/in/constituency/${commonRow.parliamentary_constituency_slug}/`,
        },
      },
      phone,
      email,
      needs: {
        id: toDashedUuid(latestNeed.need_id),
        needs: latestNeed.change_text,
        excess: latestNeed.excess_change_text,
        number: noItems(latestNeed.change_text),
        found: { __datetime: latestNeed.created },
      },
      foodbank: {
        name: foodbankName,
        slug: foodbankSlug,
        network: foodbankNetwork,
        facebook_page: facebookPage,
        urls: {
          self: `${SITE_DOMAIN}/api/2/foodbank/${foodbankSlug}/`,
          html: `${SITE_DOMAIN}/needs/at/${foodbankSlug}/`,
        },
      },
      urls: { html: htmlUrl, homepage },
    };
  });

  return apiResponse(responseList, "locations", format, SECONDS_IN_DAY);
});
