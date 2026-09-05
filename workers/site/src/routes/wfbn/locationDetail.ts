import type { Context } from "hono";
import { getDonationPointBySlugs, getFoodbankBySlug, getFoodbankLocationBySlugs, hasServiceArea } from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import { urlForLocale } from "@givefood/urls";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { elapsedMs } from "../../middleware/serverTiming";
import { CHARITY_DETAIL_COUNTRIES, emailOrFoodbankEmail, fullNameLocaleAware, networkUrl, phoneOrFoodbankPhone, urlWithRefDonationPoint, urlWithRefFoodbank } from "@givefood/models";
import { resolveNeedDisplay } from "../../lib/needDisplay";
import { donationPointSchemaOrgStr, locationSchemaOrgStr } from "../../lib/schemaOrg";
import { isOpen, openingHoursDays } from "../../lib/openingHours";

// FB SDK locale codes -- same map as ../foodbank.ts's own (not exported
// from there, and that file is out of this task's scope to touch).
const FACEBOOK_LOCALES: Record<string, string> = { en: "en_GB", cy: "cy_GB", ga: "en_GB", gd: "en_GB" };

// gfwfbn `foodbank_location` (GET /needs/at/<slug>/<locslug>/,
// i18n-patterned). Ported from gfwfbn/views.py:837-863 -- the real source
// has @cache_page stacked twice there, a known pre-existing Django bug
// (PLAN.md); no cache layer here to replicate it in. Same
// getFoodbankLocationBySlugs()/nonEmptyLines()-stripping/"" null-need
// fallback as ./md/locations.ts's mdFoodbankLocation.
export async function wfbnFoodbankLocation(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const locslug = c.req.param("locslug")!;
  const session = dbSession(c);
  const foodbank = await getFoodbankBySlug(session, slug);
  if (!foodbank) return c.notFound();
  const location = await getFoodbankLocationBySlugs(session, foodbank.slug, locslug);
  if (!location) return c.notFound();

  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";
  const fullName = fullNameLocaleAware(foodbank.name, foodbank.alt_name, locale);
  const locationFullName = `${location.name}, ${fullName}`;

  // "" (not "Nothing") null-latestNeed fallback -- see mdFoodbankLocation's
  // own comment for why. resolveNeedDisplay() and hasServiceArea() are
  // independent D1 round trips, run concurrently.
  const [{ changeText, excessChangeText, getChangeText, excessTextList }, hasServiceAreaValue] = await Promise.all([
    resolveNeedDisplay(session, foodbank, locale),
    hasServiceArea(session, foodbank.id),
  ]);

  // location.latitude/.longitude are nullable in production (unlike
  // lat_lng, NOT NULL) -- Django's own latt()/long() always derive from
  // lat_lng, never the raw columns, same as every other handler in this
  // codebase (foodbank.ts, locations.ts, nearby.ts, md/foodbank.ts).
  const [locationLatStr, locationLngStr] = location.lat_lng.split(",");
  const mapConfig = {
    geojson: urlForLocale(locale, "wfbn:foodbank_geojson", foodbank.slug),
    lat: Number(locationLatStr),
    lng: Number(locationLngStr),
    zoom: location.boundary_geojson ? 12 : 15,
    location_marker: false,
  };
  const locationMapUrl = urlForLocale(locale, "wfbn:foodbank_location_map", foodbank.slug, location.slug);

  const context = buildPageContext({
    path: c.req.path,
    pageTranslatable: true,
    locale,
    unprefixedPath: c.get("pathAfterPrefix"),
  });

  const html = await render(
    "wfbn/foodbank/location.njk",
    {
      ...context,
      render_time_ms: elapsedMs(c),
      section: "locations",
      // has_service_area nested here too (see ../locations.ts's identical
      // comment) -- includes/maplegend.njk and serviceareadisclaimer.njk
      // read it from different scopes (nested vs bare), see WIRING report.
      foodbank: {
        ...foodbank,
        latest_need_change_text: changeText,
        latest_need_get_change_text: getChangeText,
        latest_need_excess_text: excessChangeText,
        has_service_area: hasServiceAreaValue,
      },
      location: {
        ...location,
        phone_or_foodbank_phone: phoneOrFoodbankPhone(location.phone_number, location.foodbank_phone_number),
        email_or_foodbank_email: emailOrFoodbankEmail(location.email, location.foodbank_email),
        schema_org_str: locationSchemaOrgStr(location, foodbank, fullName, locationFullName),
      },
      full_name: fullName,
      excess_text_list: excessTextList,
      has_charity_details: CHARITY_DETAIL_COUNTRIES.has(foodbank.country),
      has_service_area: hasServiceAreaValue,
      network_url: networkUrl(foodbank.network),
      url_with_ref: urlWithRefFoodbank(foodbank.url),
      facebook_locale: FACEBOOK_LOCALES[locale],
      map_config: JSON.stringify(mapConfig),
      location_map_url: locationMapUrl,
    },
    locale,
  );
  return c.html(html);
}

// gfwfbn `foodbank_donationpoint` (GET
// /needs/at/<slug>/donationpoint/<dpslug>/, i18n-patterned). Ported from
// gfwfbn/views.py:949-987. Same getDonationPointBySlugs()/has_need/
// need-text stripping as ./md/donationpoints.ts's mdFoodbankDonationpoint.
export async function wfbnFoodbankDonationpoint(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const dpslug = c.req.param("dpslug")!;
  const session = dbSession(c);
  const foodbank = await getFoodbankBySlug(session, slug);
  if (!foodbank) return c.notFound();
  const donationpoint = await getDonationPointBySlugs(session, slug, dpslug);
  if (!donationpoint) return c.notFound();

  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";
  const fullName = fullNameLocaleAware(foodbank.name, foodbank.alt_name, locale);

  // resolveNeedDisplay() and hasServiceArea() are independent D1 round
  // trips, run concurrently. Guarded like ../locations.ts's
  // wfbnFoodbankDonationpoints sibling (this page is reachable even for a
  // food bank with no_locations === 0).
  const [{ changeText, excessChangeText, getChangeText, excessTextList }, hasServiceAreaValue] = await Promise.all([
    resolveNeedDisplay(session, foodbank, locale),
    foodbank.no_locations !== 0 ? hasServiceArea(session, foodbank.id) : Promise.resolve(false),
  ]);
  const hasNeed = changeText !== "Unknown" && changeText !== "Nothing" && changeText !== "Facebook";

  // donationpoint.latitude/.longitude are nullable in production (unlike
  // lat_lng, NOT NULL) -- same reasoning as wfbnFoodbankLocation above.
  const [dpLatStr, dpLngStr] = donationpoint.lat_lng.split(",");
  const mapConfig = {
    geojson: urlForLocale(locale, "wfbn:foodbank_geojson", foodbank.slug),
    lat: Number(dpLatStr),
    lng: Number(dpLngStr),
    zoom: 15,
    location_marker: false,
  };

  // Reused for both the Link preload header and the page's own
  // data-include src.
  const openingHoursUrl = urlForLocale(locale, "wfbn:foodbank_donationpoint_openinghours", slug, dpslug);
  if (donationpoint.opening_hours && donationpoint.opening_hours.trim()) {
    c.header("Link", `<${openingHoursUrl}>; rel=preload; as=fetch`);
  }

  const context = buildPageContext({
    path: c.req.path,
    pageTranslatable: true,
    locale,
    unprefixedPath: c.get("pathAfterPrefix"),
  });

  const html = await render(
    "wfbn/foodbank/donationpoint.njk",
    {
      ...context,
      render_time_ms: elapsedMs(c),
      section: "donationpoints",
      foodbank: {
        ...foodbank,
        latest_need_change_text: changeText,
        latest_need_get_change_text: getChangeText,
        latest_need_excess_text: excessChangeText,
        has_service_area: hasServiceAreaValue,
      },
      donationpoint: {
        ...donationpoint,
        url_with_ref: urlWithRefDonationPoint(donationpoint.url),
        schema_org_str: donationPointSchemaOrgStr(donationpoint, foodbank, fullName),
      },
      full_name: fullName,
      has_need: hasNeed,
      excess_text_list: excessTextList,
      has_charity_details: CHARITY_DETAIL_COUNTRIES.has(foodbank.country),
      has_service_area: hasServiceAreaValue,
      openinghours_url: openingHoursUrl,
      map_config: JSON.stringify(mapConfig),
    },
    locale,
  );
  return c.html(html);
}

// gfwfbn `foodbank_donationpoint_openinghours` (GET
// /needs/at/<slug>/donationpoint/<dpslug>/openinghours/, i18n-patterned).
// Ported from gfwfbn/views.py:990-1006 -- a tiny standalone fragment, not
// extending page.njk (matches donationpoint_openinghours.html having no
// {% extends %}). No /md/ twin exists for this route; opening_hours_days()/
// is_open are ported fresh in ../../lib/openingHours.ts.
export async function wfbnFoodbankDonationpointOpeninghours(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const dpslug = c.req.param("dpslug")!;
  const session = dbSession(c);
  const foodbank = await getFoodbankBySlug(session, slug);
  if (!foodbank) return c.notFound();
  const donationpoint = await getDonationPointBySlugs(session, slug, dpslug);
  if (!donationpoint) return c.notFound();
  if (!donationpoint.opening_hours) return c.notFound();

  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";
  const html = await render(
    "wfbn/foodbank/donationpoint_openinghours.njk",
    {
      donationpoint: {
        ...donationpoint,
        is_open: isOpen(donationpoint.opening_hours),
        opening_hours_days: openingHoursDays(donationpoint.opening_hours, donationpoint.country),
      },
    },
    locale,
  );
  c.header("X-Robots-Tag", "noindex");
  return c.html(html);
}
