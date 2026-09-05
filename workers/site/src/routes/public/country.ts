import type { Context } from "hono";
import { getMostViewedByCountry, getRecentlyUpdatedByCountry } from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import { urlForLocale } from "@givefood/urls";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { elapsedMs } from "../../middleware/serverTiming";
import { ENABLE_WRITE, isoDate, slugify } from "../../lib/fields";
import { buildGeojsonResponse } from "../../lib/buildGeojson";
import { COUNTRY_MAP_CONFIG, COUNTRY_MAPPING, COUNTRY_PLACEHOLDERS } from "../../lib/countries";

// givefood/views.py:213-281 country() -- givefood/urls.py:33,
// `re_path(r"^(?P<country_slug>(scotland|england|wales|northern-ireland))/$", ...)`,
// inside i18n_patterns. Routing itself constrains `:countrySlug` to these
// 4 values (index.ts's `{scotland|england|wales|northern-ireland}` route
// param), same precedent as wfbn/updates.ts's `:action`.

const RECENTLY_UPDATED_FETCH_LIMIT = 50; // "Fetch more to ensure we have 10 unique" (givefood/views.py:230)
const RECENTLY_UPDATED_TARGET = 10;
const MOST_VIEWED_LIMIT = 10;
const MOST_VIEWED_DAYS = 7;

export async function publicCountry(c: Context<AppEnv>): Promise<Response> {
  const countrySlug = c.req.param("countrySlug")!;
  const countryName = COUNTRY_MAPPING[countrySlug];
  // Unreachable given the route's own {scotland|england|wales|
  // northern-ireland} constraint -- kept as a defensive fallback rather
  // than a non-null assertion, same spirit as buildGeojsonResponse's
  // identical check for the geojson twin of this handler below.
  if (!countryName) return c.notFound();

  const session = dbSession(c);
  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";

  const today = new Date();
  const sinceDay = new Date(today);
  sinceDay.setUTCDate(sinceDay.getUTCDate() - MOST_VIEWED_DAYS);

  const [recentChangeRows, mostViewed] = await Promise.all([
    getRecentlyUpdatedByCountry(session, countryName, RECENTLY_UPDATED_FETCH_LIMIT),
    getMostViewedByCountry(session, isoDate(sinceDay), isoDate(today), countryName, MOST_VIEWED_LIMIT),
  ]);

  // country()'s own dedup loop (givefood/views.py:233-241): walk
  // `recent_changes` in its `-created` order, keeping the first row for
  // each not-yet-seen foodbank_name, until 10 uniques are collected (or
  // the fetched 50 run out). Same slugify()-not-a-real-slug reasoning as
  // public.ts's own recentlyUpdated mapping (FoodbankChange.foodbank_name_slug()).
  const seenFoodbankNames = new Set<string>();
  const recentlyUpdated: Array<{ name: string; slug: string }> = [];
  for (const row of recentChangeRows) {
    if (seenFoodbankNames.has(row.foodbank_name)) continue;
    seenFoodbankNames.add(row.foodbank_name);
    recentlyUpdated.push({ name: row.foodbank_name, slug: slugify(row.foodbank_name) });
    if (recentlyUpdated.length >= RECENTLY_UPDATED_TARGET) break;
  }

  const mapSettings = COUNTRY_MAP_CONFIG[countryName]!;
  const mapConfig = JSON.stringify({
    geojson: urlForLocale(locale, "country_geojson", countrySlug),
    lat: mapSettings.lat,
    lng: mapSettings.lng,
    zoom: mapSettings.zoom,
    location_marker: false,
  });

  const context = buildPageContext({
    path: c.req.path,
    pageTranslatable: true,
    locale,
    unprefixedPath: c.get("pathAfterPrefix"),
  });

  const html = await render(
    "public/country.njk",
    {
      ...context,
      render_time_ms: elapsedMs(c),
      country_name: countryName,
      country_slug: countrySlug,
      // The literal English msgid country.njk passes to `_()` at render
      // time -- NOT translated here (see countries.ts's own comment, and
      // wfbn/index.njk's `{{ _(cat_label) }}` for the same dynamic-msgid
      // pattern already used elsewhere in this port).
      placeholder: COUNTRY_PLACEHOLDERS[countryName],
      recently_updated: recentlyUpdated,
      most_viewed: mostViewed,
      enable_write: ENABLE_WRITE,
      address: "",
      map_config: mapConfig,
    },
    locale,
  );
  return c.html(html);
}

// givefood/views.py:285-427 country_geojson() -- givefood/urls.py:34,
// same i18n-patterned country_slug regex as country() above, `geo\.json$`
// instead of `$`. @cache_page(SECONDS_IN_HOUR) in the Python source (NOT
// the wfbn geojson feeds' SECONDS_IN_WEEK) -- verified directly against a
// live /england/geo.json response's `Cache-Control: max-age=3600` header,
// same "explicit header, bare max-age only" convention as
// routes/wfbn/geojson.ts (that file's own comment explains why `public`/
// `s-maxage` are deliberately absent).
const SECONDS_IN_HOUR = 3600;

function jsonResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `max-age=${SECONDS_IN_HOUR}`,
    },
  });
}

export async function publicCountryGeojson(c: Context<AppEnv>): Promise<Response> {
  const countrySlug = c.req.param("countrySlug")!;
  const locale = c.get("lang");
  const session = dbSession(c);
  const body = await buildGeojsonResponse(session, locale, { kind: "country", countrySlug });
  if (body === null) return c.notFound();
  return jsonResponse(body);
}
