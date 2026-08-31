import type { Context } from "hono";
import { getFoodbankBySlug, getLocationsByFoodbankId, getDonationPointsByFoodbankId, hasServiceArea } from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import { urlForLocale } from "@givefood/urls";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { elapsedMs } from "../../middleware/serverTiming";
import { CHARITY_DETAIL_COUNTRIES, fullNameLocaleAware } from "../../lib/fields";

// gfwfbn `foodbank_locations` (GET /needs/at/<slug>/locations/,
// i18n-patterned). Ported from gfwfbn/views.py:558-586. Same
// getLocationsByFoodbankId query/no_locations===0 guard as
// ./md/locations.ts's mdFoodbankLocations -- see that file's comment on
// why a strict === 0 check is safe (no_locations is non-nullable).
export async function wfbnFoodbankLocations(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const session = dbSession(c);
  const foodbank = await getFoodbankBySlug(session, slug);
  if (!foodbank) return c.notFound();
  if (foodbank.no_locations === 0) return c.notFound();

  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";
  const fullName = fullNameLocaleAware(foodbank.name, foodbank.alt_name, locale);
  const locations = await getLocationsByFoodbankId(session, foodbank.id);
  const hasServiceAreaValue = await hasServiceArea(session, foodbank.id);

  const [latStr, lngStr] = foodbank.lat_lng.split(",");

  const mapConfig: Record<string, unknown> = {
    geojson: urlForLocale(locale, "wfbn:foodbank_geojson", foodbank.slug),
  };
  if (foodbank.bounds_north !== null) {
    mapConfig.bounds = {
      north: foodbank.bounds_north,
      south: foodbank.bounds_south,
      east: foodbank.bounds_east,
      west: foodbank.bounds_west,
    };
  }

  const context = buildPageContext({
    path: c.req.path,
    appName: "gfwfbn",
    pageTranslatable: true,
    locale,
    unprefixedPath: c.get("pathAfterPrefix"),
  });

  const html = await render(
    "wfbn/foodbank/locations.njk",
    {
      ...context,
      render_time_ms: elapsedMs(c),
      section: "locations",
      // has_service_area also nested here (unlike foodbank.ts/nearby.ts's
      // top-level-only pass) -- includes/maplegend.njk reads
      // `foodbank.has_service_area` nested, see WIRING report finding.
      foodbank: { ...foodbank, has_service_area: hasServiceAreaValue },
      full_name: fullName,
      has_charity_details: CHARITY_DETAIL_COUNTRIES.has(foodbank.country),
      has_service_area: hasServiceAreaValue,
      locations,
      latt: Number(latStr),
      long: Number(lngStr),
      map_config: JSON.stringify(mapConfig),
    },
    locale,
  );
  return c.html(html);
}

// gfwfbn `foodbank_donationpoints` (GET /needs/at/<slug>/donationpoints/,
// i18n-patterned). Ported from gfwfbn/views.py:589-618. Same
// no_donation_points truthy-guard (nullable field) as
// ./md/donationpoints.ts's mdFoodbankDonationpoints.
export async function wfbnFoodbankDonationpoints(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const session = dbSession(c);
  const foodbank = await getFoodbankBySlug(session, slug);
  if (!foodbank) return c.notFound();
  if (!foodbank.no_donation_points) return c.notFound();

  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";
  const fullName = fullNameLocaleAware(foodbank.name, foodbank.alt_name, locale);

  // Foodbank.location_donation_points() -- locations that are ALSO
  // donation points, filtered client-side (no dedicated foodbank-scoped
  // db query exists); order preserved from getLocationsByFoodbankId's own
  // name sort, matching Django's `.order_by("name")` on that method.
  const allLocations = await getLocationsByFoodbankId(session, foodbank.id);
  const locationDonationPoints = allLocations.filter((l) => l.is_donation_point);
  const donationPoints = await getDonationPointsByFoodbankId(session, foodbank.id);
  const hasServiceAreaValue = foodbank.no_locations !== 0 ? await hasServiceArea(session, foodbank.id) : false;

  const [latStr, lngStr] = foodbank.lat_lng.split(",");

  const mapConfig: Record<string, unknown> = {
    geojson: urlForLocale(locale, "wfbn:foodbank_geojson", foodbank.slug),
  };
  if (foodbank.bounds_north !== null) {
    mapConfig.bounds = {
      north: foodbank.bounds_north,
      south: foodbank.bounds_south,
      east: foodbank.bounds_east,
      west: foodbank.bounds_west,
    };
  }

  const context = buildPageContext({
    path: c.req.path,
    appName: "gfwfbn",
    pageTranslatable: true,
    locale,
    unprefixedPath: c.get("pathAfterPrefix"),
  });

  const html = await render(
    "wfbn/foodbank/donationpoints.njk",
    {
      ...context,
      render_time_ms: elapsedMs(c),
      section: "donationpoints",
      foodbank: { ...foodbank, has_service_area: hasServiceAreaValue },
      full_name: fullName,
      has_charity_details: CHARITY_DETAIL_COUNTRIES.has(foodbank.country),
      has_service_area: hasServiceAreaValue,
      location_donation_points: locationDonationPoints,
      donation_points: donationPoints,
      latt: Number(latStr),
      long: Number(lngStr),
      map_config: JSON.stringify(mapConfig),
    },
    locale,
  );
  return c.html(html);
}
