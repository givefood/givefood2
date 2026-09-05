import type { Context } from "hono";
import { getFoodbankBySlug, hasServiceArea } from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import { urlForLocale } from "@givefood/urls";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { elapsedMs } from "../../middleware/serverTiming";
import { bankuetUrl, CHARITY_DETAIL_COUNTRIES, fullNameLocaleAware, networkUrl, urlWithRefFoodbank } from "@givefood/models";
import { resolveNeedDisplay } from "../../lib/needDisplay";
import { schemaOrgStr } from "../../lib/schemaOrg";

// FB SDK locale codes -- Django's FACEBOOK_LOCALES map, ga/gd approximated
// (Facebook's own supported-locale list has neither; en_GB is the
// reasonable fallback for both, same as an unset/unknown language would
// get).
const FACEBOOK_LOCALES: Record<string, string> = { en: "en_GB", cy: "cy_GB", ga: "en_GB", gd: "en_GB" };

// gfwfbn `foodbank` (GET /needs/at/<slug>/, i18n-patterned). Ported from
// gfwfbn/views.py:363-395 -- note @cache_page is commented out there too
// (no origin cache on this page today).
export async function wfbnFoodbank(c: Context<AppEnv>): Promise<Response> {
  // Guaranteed present -- the router only invokes this handler for a path
  // matching :slug (index.ts's /needs/at/:slug/ registrations). Typed
  // optional only because this handler isn't itself bound to that literal
  // route pattern the way an inline `app.get("/x/:slug/", ...)` would be.
  const slug = c.req.param("slug")!;
  const session = dbSession(c);
  const foodbank = await getFoodbankBySlug(session, slug);
  if (!foodbank) return c.notFound();

  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";
  const fullName = fullNameLocaleAware(foodbank.name, foodbank.alt_name, locale);

  // index.njk's Unknown/Nothing exclusion checks stay against the RAW
  // latestNeedChangeText below ("" for a missing need record, not the
  // "Nothing" sentinel -- a real, distinct value -- matching Django's
  // silent-variable-failure semantics), which is Django's outer
  // `{% if foodbank.latest_need.change_text != ... %}` gate, deliberately
  // NOT locale-aware; latestNeedGetChangeText is the translated-or-English-
  // fallback DISPLAY text (Django's inner `{% with foodbank.latest_need.get_change_text as change_text %}`).
  // resolveNeedDisplay() and hasServiceArea() are independent D1 round
  // trips, run concurrently.
  const [{ changeText: latestNeedChangeText, excessChangeText: latestNeedExcessText, getChangeText: latestNeedGetChangeText, excessTextList }, hasServiceAreaValue] =
    await Promise.all([
      resolveNeedDisplay(session, foodbank, locale),
      foodbank.no_locations !== 0 ? hasServiceArea(session, foodbank.id) : Promise.resolve(false),
    ]);

  const [latStr, lngStr] = foodbank.lat_lng.split(",");

  const mapConfig: Record<string, unknown> = {
    geojson: urlForLocale(locale, "wfbn:foodbank_geojson", foodbank.slug),
    max_zoom: 14,
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
    pageTranslatable: true,
    locale,
    unprefixedPath: c.get("pathAfterPrefix"),
  });

  const html = await render(
    "wfbn/foodbank/index.njk",
    {
      ...context,
      render_time_ms: elapsedMs(c),
      section: "foodbank",
      // has_service_area also nested here (see locations.ts/
      // locationDetail.ts's identical comment) -- maplegend.njk reads
      // `foodbank.has_service_area`, a level the top-level `has_service_area`
      // key below never reaches.
      foodbank: {
        ...foodbank,
        latest_need_change_text: latestNeedChangeText,
        latest_need_get_change_text: latestNeedGetChangeText,
        latest_need_excess_text: latestNeedExcessText,
        has_service_area: hasServiceAreaValue,
      },
      full_name: fullName,
      excess_text_list: excessTextList,
      has_charity_details: CHARITY_DETAIL_COUNTRIES.has(foodbank.country),
      has_service_area: hasServiceAreaValue,
      url_with_ref: urlWithRefFoodbank(foodbank.url),
      network_url: networkUrl(foodbank.network),
      bankuet_url: bankuetUrl(foodbank.bankuet_slug),
      schema_org_str: schemaOrgStr(foodbank, fullName),
      latt: Number(latStr),
      long: Number(lngStr),
      facebook_locale: FACEBOOK_LOCALES[locale],
      map_config: JSON.stringify(mapConfig),
      turnstilefail: c.req.query("turnstilefail") ? true : false,
      email: c.req.query("email") ?? "",
      autofocus: c.req.query("turnstilefail") ? true : false,
      prefix: null,
    },
    locale,
  );
  return c.html(html);
}
