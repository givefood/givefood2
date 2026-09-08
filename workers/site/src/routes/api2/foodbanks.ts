import { Hono } from "hono";
import {
  getAllOpenFoodbanks,
  getFoodbankBySlugWithOpenCoordinates,
  getFoodbanksByIds,
  getLocationsDonationPointsAndNearbyFoodbanks,
  getOpenFoodbankCoordinates,
  toDashedUuid,
} from "@givefood/db";
import { R_EARTHDISTANCE, R_PYTHON, isUk, miles, nearest } from "@givefood/geo";
import { round2, type SerialisableValue } from "@givefood/serialise";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { geocode } from "../../lib/geocode";
import { apiResponse, SECONDS_IN_DAY, SECONDS_IN_HOUR } from "../../lib/apiResponse";
import {
  charityRegisterUrl,
  emailOrFoodbankEmail,
  fullAddressNullable,
  fullAddressUnconditional,
  fullNameFoodbank,
  noItems,
  phoneOrFoodbankPhone,
} from "@givefood/models";

// gfapi2 `foodbanks` / `foodbank` / `foodbank_search` -- givefood/urls.py:
// /foodbanks/, /foodbank/<slug:slug>/, /foodbanks/search/. Ported straight
// from gfapi2/views.py, verbatim. This app is mounted at both /api/2 and
// /api by the caller (WP 2.4's task brief) -- nothing here needs to know
// that.
export const api2FoodbanksApp = new Hono<AppEnv>();

// Every "self"/"html"/"homepage"/"map"/"json" URL below is a literal
// "https://www.givefood.org.uk" prefix, not derived from the request (see
// task point 12) -- reproduced as a hardcoded string here, same as the
// sibling api2 route files.
const SITE_DOMAIN = "https://www.givefood.org.uk";

// FoodbankRow.lat_lng (and the identically-shaped column on locations and
// donation points) is a "lat,lng" string -- Foodbank.latt()/long() (and
// find_foodbanks()'s ranking) split it this way rather than using the
// latitude/longitude columns, which can and do disagree (PLAN.md §7.2's
// geojson-coordinates note). Reused for geojson coordinate order
// ([lng, lat]) and for every nearest() ranking call in this file.
function parseLatLng(latLng: string): [number, number] {
  const parts = latLng.split(",");
  return [parseFloat(parts[0] as string), parseFloat(parts[1] as string)];
}

// --- foodbanks (GET /foodbanks/) ------------------------------------------
api2FoodbanksApp.get("/foodbanks/", async (c) => {
  const format = c.req.query("format") ?? "json";
  const session = dbSession(c);

  const foodbanks = await getAllOpenFoodbanks(session);

  let responseData: SerialisableValue;
  if (format !== "geojson") {
    responseData = foodbanks.map((foodbank) => ({
      id: toDashedUuid(foodbank.uuid),
      name: fullNameFoodbank(foodbank.name),
      alt_name: foodbank.alt_name,
      slug: foodbank.slug,
      phone: foodbank.phone_number,
      secondary_phone: foodbank.secondary_phone_number,
      email: foodbank.contact_email,
      address: fullAddressUnconditional(foodbank.address, foodbank.postcode),
      postcode: foodbank.postcode,
      closed: foodbank.is_closed,
      country: foodbank.country,
      lat_lng: foodbank.lat_lng,
      network: foodbank.network,
      created: { __datetime: foodbank.created },
      urls: {
        self: `${SITE_DOMAIN}/api/2/foodbank/${foodbank.slug}/`,
        html: `${SITE_DOMAIN}/needs/at/${foodbank.slug}/`,
        homepage: foodbank.url,
        shopping_list: foodbank.shopping_list_url,
      },
      charity: {
        registration_id: foodbank.charity_number,
        register_url: charityRegisterUrl(foodbank.charity_number, foodbank.country),
      },
      politics: {
        parliamentary_constituency: foodbank.parliamentary_constituency_name,
        mp: foodbank.mp,
        mp_party: foodbank.mp_party,
        mp_parl_id: foodbank.mp_parl_id,
        ward: foodbank.ward,
        district: foodbank.district,
        urls: {
          self: `${SITE_DOMAIN}/api/2/constituency/${foodbank.parliamentary_constituency_slug}/`,
          html: `${SITE_DOMAIN}/needs/in/constituency/${foodbank.parliamentary_constituency_slug}/`,
        },
      },
    }));
  } else {
    const features = foodbanks.map((foodbank) => {
      const [lat, lng] = parseLatLng(foodbank.lat_lng);
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [lng, lat] },
        properties: {
          // Deliberately foodbank.name here, NOT full_name() -- differs
          // from the non-geojson branch above, matching the source.
          name: foodbank.name,
          slug: foodbank.slug,
          address: fullAddressUnconditional(foodbank.address, foodbank.postcode),
          country: foodbank.country,
          url: `${SITE_DOMAIN}/needs/at/${foodbank.slug}/`,
          json: `${SITE_DOMAIN}/api/2/foodbank/${foodbank.slug}/`,
          network: foodbank.network,
          email: foodbank.contact_email,
          telephone: foodbank.phone_number,
          parliamentary_constituency: foodbank.parliamentary_constituency_name,
        },
      };
    });
    responseData = { type: "FeatureCollection", features };
  }

  return apiResponse(responseData, "foodbanks", format, SECONDS_IN_HOUR);
});

// --- foodbank (GET /foodbank/<slug:slug>/) --------------------------------
api2FoodbanksApp.get("/foodbank/:slug/", async (c) => {
  const format = c.req.query("format") ?? "json";
  const slug = c.req.param("slug");
  const session = dbSession(c);

  // THREE D1 ROUND TRIPS, NOT FIVE (github #49). Everything this endpoint
  // reads falls into three dependency levels, and it used to await each query
  // separately even where nothing connected them:
  //
  //   1. the food bank by slug, its latest need, and -- for nearby_foodbanks
  //      only -- the id+coordinate candidate set of every open food bank.
  //      None of the three depends on the others.
  //   2. its locations, its donation points, and full rows for the ten
  //      neighbours ranked out of (1). All three need only ids from (1).
  //   3. those ten neighbours' latest needs, which are columns of (2).
  //
  // Each level is one `session.batch()`. At the 23-28 ms per round trip
  // measured against production (interleaved cache-busted requests, reading
  // this Worker's own Server-Timing `render` header, which on Workers only
  // advances at I/O boundaries) that is ~50 ms off a 138-192 ms request.
  //
  // The candidate scan is gated on the format rather than hoisted: the
  // geojson branch below has no nearby_foodbanks and would pay a 1,024-row
  // scan for nothing. See getFoodbankBySlugWithOpenCoordinates.
  const isGeojson = format === "geojson";
  const { foodbank, openCoordinates } = await getFoodbankBySlugWithOpenCoordinates(session, slug, !isGeojson);
  if (!foodbank) return c.notFound();

  // Foodbank.nearby() = find_foodbanks(self.lat_lng, 10, True): ALL open
  // food banks (this one included, if open), ranked by haversine from
  // THIS food bank's own lat_lng using v1's radius (R_PYTHON, not
  // R_EARTHDISTANCE -- verified against foodbank.py:305), then
  // skip_first=True drops index 0 (presumed to be this food bank itself
  // at distance 0). If this food bank is closed it is absent from the
  // candidate set and skip_first instead drops the true nearest other
  // food bank -- a frozen quirk, not special-cased away.
  // WP 2.5 perf: rank against the cheap id+coordinate candidate set (a
  // covering-index scan over ~1000 rows), not the full open-foodbank
  // row set -- full rows for only the 10 survivors are fetched below.
  const [selfLat, selfLng] = parseLatLng(foodbank.lat_lng);
  const nearbyRanked = isGeojson
    ? []
    : nearest(openCoordinates, selfLat, selfLng, (c) => [c.latitude, c.longitude], 10, R_PYTHON, true);

  // One D1 round trip for all three, not three sequential ones -- found via
  // real timing comparisons against production (a WP 2.5 follow-up, extended
  // for #49). getLocationsDonationPointsAndNearbyFoodbanks preserves the
  // ranked id order in nearbyFoodbanks; an empty id list sends no third
  // statement, which is what the geojson branch relies on.
  const { locations, donationPoints, nearbyFoodbanks } = await getLocationsDonationPointsAndNearbyFoodbanks(
    session,
    foodbank.id,
    nearbyRanked.map((r) => r.item.id),
  );

  let responseData: SerialisableValue;
  if (format !== "geojson") {
    const locationList = locations.map((location) => ({
      id: toDashedUuid(location.uuid),
      name: location.name,
      slug: location.slug,
      address: fullAddressNullable(location.address, location.postcode),
      postcode: location.postcode,
      lat_lng: location.lat_lng,
      phone: location.phone_number,
      is_donation_point: location.is_donation_point,
      politics: {
        parliamentary_constituency: location.parliamentary_constituency_name,
        mp: location.mp,
        mp_party: location.mp_party,
        // Frozen bug B2: the PARENT food bank's mp_parl_id, not the
        // location's own column -- gfapi2/views.py:170. Reproduce exactly.
        mp_parl_id: foodbank.mp_parl_id,
        ward: location.ward,
        district: location.district,
        urls: {
          self: `${SITE_DOMAIN}/api/2/constituency/${location.parliamentary_constituency_slug}/`,
          html: `${SITE_DOMAIN}/needs/in/constituency/${location.parliamentary_constituency_slug}/`,
        },
      },
    }));

    const donationPointList = donationPoints.map((donationPoint) => ({
      id: toDashedUuid(donationPoint.uuid),
      name: donationPoint.name,
      slug: donationPoint.slug,
      address: fullAddressUnconditional(donationPoint.address, donationPoint.postcode),
      postcode: donationPoint.postcode,
      lat_lng: donationPoint.lat_lng,
      phone: donationPoint.phone_number,
      url: donationPoint.url,
      opening_hours: donationPoint.opening_hours,
      // Tri-state: true/false/null. Never coalesce.
      wheelchair_accessible: donationPoint.wheelchair_accessible,
      politics: {
        parliamentary_constituency: donationPoint.parliamentary_constituency_name,
        mp: donationPoint.mp,
        mp_party: donationPoint.mp_party,
        // NOT the B2 bug here -- donation points use their own mp_parl_id.
        mp_parl_id: donationPoint.mp_parl_id,
        ward: donationPoint.ward,
        district: donationPoint.district,
        urls: {
          self: `${SITE_DOMAIN}/api/2/constituency/${donationPoint.parliamentary_constituency_slug}/`,
          html: `${SITE_DOMAIN}/needs/in/constituency/${donationPoint.parliamentary_constituency_slug}/`,
        },
      },
    }));

    // Ranked and fetched above, before the locations batch, so that the
    // neighbours' SELECT rides in it -- see the round-trip note at the top of
    // this handler. The shaping below is unchanged.
    const nearbyFoodbankList = nearbyFoodbanks.map((nearbyFoodbank) => ({
      name: nearbyFoodbank.name,
      slug: nearbyFoodbank.slug,
      urls: {
        self: `${SITE_DOMAIN}/api/2/foodbank/${nearbyFoodbank.slug}/`,
        html: `${SITE_DOMAIN}/needs/at/${nearbyFoodbank.slug}/`,
        homepage: nearbyFoodbank.url,
        shopping_list: nearbyFoodbank.shopping_list_url,
      },
      address: fullAddressUnconditional(nearbyFoodbank.address, nearbyFoodbank.postcode),
      lat_lng: nearbyFoodbank.lat_lng,
    }));

    // Frozen bug B12: latest_need is dereferenced unguarded in the source
    // (gfapi2/views.py:401-ish region for this endpoint's `need` block).
    // If it's null this throws here exactly as it 500s in Django -- no
    // null guard added.
    const need = foodbank.latestNeed!;
    const needIdStr = toDashedUuid(need.need_id);

    responseData = {
      id: toDashedUuid(foodbank.uuid),
      // Deliberately foodbank.name here, NOT full_name() -- differs from
      // the foodbanks() list endpoint above (frozen inconsistency, verified
      // directly against gfapi2/views.py).
      name: foodbank.name,
      alt_name: foodbank.alt_name,
      slug: foodbank.slug,
      phone: foodbank.phone_number,
      secondary_phone: foodbank.secondary_phone_number,
      email: foodbank.contact_email,
      address: fullAddressUnconditional(foodbank.address, foodbank.postcode),
      postcode: foodbank.postcode,
      closed: foodbank.is_closed,
      // No top-level "country" here -- frozen bug B9: the detail endpoint
      // omits it even though the list endpoint includes it. Do not add it.
      lat_lng: foodbank.lat_lng,
      network: foodbank.network,
      created: { __datetime: foodbank.created },
      urls: {
        self: `${SITE_DOMAIN}/api/2/foodbank/${foodbank.slug}/`,
        html: `${SITE_DOMAIN}/needs/at/${foodbank.slug}/`,
        homepage: foodbank.url,
        shopping_list: foodbank.shopping_list_url,
        map: `${SITE_DOMAIN}/needs/at/${foodbank.slug}/map.png`,
      },
      charity: {
        registration_id: foodbank.charity_number,
        register_url: charityRegisterUrl(foodbank.charity_number, foodbank.country),
      },
      delivery_address: foodbank.delivery_address,
      delivery_lat_lng: foodbank.delivery_lat_lng,
      locations: locationList,
      donationpoints: donationPointList,
      politics: {
        parliamentary_constituency: foodbank.parliamentary_constituency_name,
        mp: foodbank.mp,
        mp_party: foodbank.mp_party,
        // No mp_parl_id here either -- also part of frozen bug B9.
        ward: foodbank.ward,
        district: foodbank.district,
        urls: {
          self: `${SITE_DOMAIN}/api/2/constituency/${foodbank.parliamentary_constituency_slug}/`,
          html: `${SITE_DOMAIN}/needs/in/constituency/${foodbank.parliamentary_constituency_slug}/`,
        },
      },
      need: {
        id: needIdStr,
        needs: need.change_text,
        excess: need.excess_change_text,
        // Frozen bug B10: keyed "created" here, but "found" on the search
        // endpoint below -- do not harmonise the two key names.
        created: { __datetime: need.created },
        self: `${SITE_DOMAIN}/api/2/need/${needIdStr}/`,
      },
      nearby_foodbanks: nearbyFoodbankList,
    };
  } else {
    const [fbLat, fbLng] = parseLatLng(foodbank.lat_lng);
    const features: SerialisableValue[] = [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [fbLng, fbLat] },
        properties: {
          name: foodbank.name,
          slug: foodbank.slug,
          address: fullAddressUnconditional(foodbank.address, foodbank.postcode),
          url: `${SITE_DOMAIN}/needs/at/${foodbank.slug}/`,
          network: foodbank.network,
          email: foodbank.contact_email,
          telephone: foodbank.phone_number,
          parliamentary_constituency: foodbank.parliamentary_constituency_name,
        },
      },
    ];
    for (const location of locations) {
      const [locLat, locLng] = parseLatLng(location.lat_lng);
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [locLng, locLat] },
        properties: {
          name: location.name,
          slug: location.slug,
          address: fullAddressNullable(location.address, location.postcode),
          url: `${SITE_DOMAIN}/needs/at/${location.foodbank_slug}/${location.slug}/`,
          network: location.foodbank_network,
          email: emailOrFoodbankEmail(location.email, location.foodbank_email),
          telephone: phoneOrFoodbankPhone(location.phone_number, location.foodbank_phone_number),
          parliamentary_constituency: location.parliamentary_constituency_name,
          is_donation_point: location.is_donation_point,
        },
      });
    }
    for (const donationPoint of donationPoints) {
      const [dpLat, dpLng] = parseLatLng(donationPoint.lat_lng);
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [dpLng, dpLat] },
        properties: {
          name: donationPoint.name,
          slug: donationPoint.slug,
          address: fullAddressUnconditional(donationPoint.address, donationPoint.postcode),
          url: `${SITE_DOMAIN}/needs/at/${donationPoint.foodbank_slug}/donationpoint/${donationPoint.slug}/`,
          web: donationPoint.url,
          network: donationPoint.foodbank_network,
          telephone: donationPoint.phone_number,
          opening_hours: donationPoint.opening_hours,
          wheelchair_accessible: donationPoint.wheelchair_accessible,
          parliamentary_constituency: donationPoint.parliamentary_constituency_name,
          is_donation_point: true,
        },
      });
    }
    responseData = { type: "FeatureCollection", features };
  }

  return apiResponse(responseData, "foodbank", format, SECONDS_IN_DAY);
});

// --- foodbank_search (GET /foodbanks/search/) -----------------------------
// The real view falls back to Google Maps Geocoding when only `?address=`
// is given (no `?lat_lng=`), turning the address into a lat_lng before
// proceeding -- ported via lib/geocode.ts. A failed/misconfigured geocode
// falls back to "0,0", which the isUk() check below then correctly rejects
// as a 400, same as any other out-of-UK coordinate.
api2FoodbanksApp.get("/foodbanks/search/", async (c) => {
  const format = c.req.query("format") ?? "json";
  let latLngParam = c.req.query("lat_lng");
  const addressParam = c.req.query("address");

  if (format === "geojson") {
    return new Response("", { status: 400 });
  }
  if (!latLngParam && !addressParam) {
    return new Response("", { status: 400 });
  }
  if (latLngParam) {
    if (!latLngParam.includes(",")) {
      return new Response("", { status: 400 });
    }
    const stripped = latLngParam.replace(/,/g, "").replace(/-/g, "").replace(/\./g, "");
    if (!/^\d+$/.test(stripped)) {
      return new Response("", { status: 400 });
    }
  }
  if (addressParam && !latLngParam) {
    latLngParam = await geocode(c, addressParam);
  }

  // latLngParam is guaranteed defined here: the only ways to reach this
  // point without it are covered by the two early returns above (or it was
  // just set by geocode(), which always returns a "lat,lng" string).
  const [lat, lng] = parseLatLng(latLngParam!);
  if (!isUk(lat, lng)) {
    return new Response("", { status: 400 });
  }

  const session = dbSession(c);
  // WP 2.5 perf: rank against the cheap id+coordinate candidate set, not
  // the full open-foodbank row set -- see the sibling nearby_foodbanks
  // comment above for the same reasoning.
  const candidates = await getOpenFoodbankCoordinates(session);
  const ranked = nearest(candidates, lat, lng, (c) => [c.latitude, c.longitude], 10, R_EARTHDISTANCE);
  const rankedIds = ranked.map((r) => r.item.id);
  const foodbanksWithNeed = await getFoodbanksByIds(session, rankedIds);

  // KEYED BY id, NOT BY POSITION (github #48). The comment this replaced said
  // getFoodbanksByIds preserves rankedIds's order "so index i lines up" --
  // true of the order, false of the LENGTH. mapFoodbanksByIds drops any id it
  // cannot find (`.filter(row => row !== undefined)`), so one missing row
  // shifts every distance after it onto the wrong food bank: a 200 with wrong
  // distances, which nothing downstream can detect. See api1.ts's fuller note
  // on the window that makes an id go missing between the two reads.
  //
  // Total in this direction: every row in `foodbanksWithNeed` was asked for by
  // id, so its id is necessarily a key here.
  const distanceById = new Map(ranked.map((r) => [r.item.id, r.distanceM]));

  const responseList: SerialisableValue[] = foodbanksWithNeed.map((foodbank) => {
    const distanceM = distanceById.get(foodbank.id)!;
    // Frozen bug B12: latest_need dereferenced unguarded in the source
    // (gfapi1/views.py:143, gfapi2/views.py:401) -- if it's null this
    // throws here exactly as it 500s in Django.
    const need = foodbank.latestNeed!;
    return {
      id: toDashedUuid(foodbank.uuid),
      name: foodbank.name,
      alt_name: foodbank.alt_name,
      slug: foodbank.slug,
      phone: foodbank.phone_number,
      secondary_phone: foodbank.secondary_phone_number,
      email: foodbank.contact_email,
      address: fullAddressUnconditional(foodbank.address, foodbank.postcode),
      postcode: foodbank.postcode,
      lat_lng: foodbank.lat_lng,
      distance_m: Math.trunc(distanceM),
      distance_mi: round2(miles(distanceM)),
      needs: {
        id: toDashedUuid(need.need_id),
        needs: need.change_text,
        excess: need.excess_change_text,
        // Frozen bug B10: keyed "found" here, but "created" on the detail
        // endpoint above -- do not harmonise the two key names.
        found: { __datetime: need.created },
        number: noItems(need.change_text),
      },
      urls: {
        self: `${SITE_DOMAIN}/api/2/foodbank/${foodbank.slug}/`,
        html: `${SITE_DOMAIN}/needs/at/${foodbank.slug}/`,
        homepage: foodbank.url,
        shopping_list: foodbank.shopping_list_url,
        map: `${SITE_DOMAIN}/needs/at/${foodbank.slug}/map.png`,
      },
      charity: {
        registration_id: foodbank.charity_number,
        register_url: charityRegisterUrl(foodbank.charity_number, foodbank.country),
      },
      politics: {
        parliamentary_constituency: foodbank.parliamentary_constituency_name,
        mp: foodbank.mp,
        mp_party: foodbank.mp_party,
        mp_parl_id: foodbank.mp_parl_id,
        ward: foodbank.ward,
        district: foodbank.district,
        urls: {
          self: `${SITE_DOMAIN}/api/2/constituency/${foodbank.parliamentary_constituency_slug}/`,
          html: `${SITE_DOMAIN}/needs/in/constituency/${foodbank.parliamentary_constituency_slug}/`,
        },
      },
    };
  });

  return apiResponse(responseList, "foodbanks", format, SECONDS_IN_DAY);
});
