import type { Context } from "hono";
import { getFoodbankBySlug } from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import { urlForLocale } from "@givefood/urls";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { elapsedMs } from "../../middleware/serverTiming";
import { findLocations } from "../../lib/findLocations";
import { CHARITY_DETAIL_COUNTRIES, fullNameLocaleAware } from "../../lib/fields";

// gfwfbn `foodbank_nearby` (GET /needs/at/<slug>/nearby/, i18n-patterned).
// Ported from gfwfbn/views.py:661-685, which calls
// find_locations(foodbank.lat_lng, 20, True) -- skip_first=True, dropping
// the food bank itself (always index 0, distance 0) from its own nearby
// list. Same dbSession/buildPageContext/render shape as foodbank.ts
// (this file's primary style reference).
//
// Known divergence (PLAN.md §4.8.4, 2026-08-30 Postgres measurement):
// @givefood/geo's nearest() does a single global scan over the combined
// food-bank+location candidate set (see nearest.ts's own comment and
// findLocations.ts's), not Python's two-independently-capped-then-merged
// querysets. PLAN.md §7.5.2 proves those are contract-exact for every
// skip_first=False search, but skip_first=True (this page) is the one
// documented exception: the food bank being dropped can itself have
// been each leg's 20th (last) item, so which *other* item backfills that
// slot can disagree between the two strategies. This is only reachable
// for a handful of unusually dense food banks -- the only ones with
// enough same-type neighbours for a global-scan reshuffle to reach as
// far as the 20th result:
//   - 6393797369921536 (~596 open locations, almost certainly Salvation
//     Army)
//   - 5382244910759936 (26)
//   - 6295884044173312 (22)
//   - 5712046691713024 (21)
// Every other food bank's /nearby/ page is contract-exact. Documentation
// only -- no runtime branch keys off this list.
export async function wfbnFoodbankNearby(c: Context<AppEnv>): Promise<Response> {
  // Guaranteed present -- see foodbank.ts's identical comment on its own
  // `slug` param.
  const slug = c.req.param("slug")!;
  const session = dbSession(c);
  const foodbank = await getFoodbankBySlug(session, slug);
  if (!foodbank) return c.notFound();

  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";
  const fullName = fullNameLocaleAware(foodbank.name, foodbank.alt_name, locale);

  const [latStr, lngStr] = foodbank.lat_lng.split(",");
  const lat = Number(latStr);
  const lng = Number(lngStr);

  const rawNearby = await findLocations(session, lat, lng, 20, true);
  // Nunjucks truthiness gotcha (see wfbn/index.ts's identical comment):
  // an empty array is truthy in Nunjucks, unlike Django's `if nearby:`.
  // Convert here, at the data boundary, so nearby.njk's `{% if nearby %}`
  // guard hides correctly when the list is empty.
  const nearby = rawNearby.length > 0 ? rawNearby : null;

  const mapConfig = JSON.stringify({
    geojson: urlForLocale(locale, "wfbn:geojson"),
    lat,
    lng,
    zoom: 12,
    location_marker: false,
  });

  const context = buildPageContext({
    path: c.req.path,
    pageTranslatable: true,
    locale,
    unprefixedPath: c.get("pathAfterPrefix"),
  });

  const html = await render(
    "wfbn/foodbank/nearby.njk",
    {
      ...context,
      render_time_ms: elapsedMs(c),
      section: "nearby",
      foodbank,
      full_name: fullName,
      has_charity_details: CHARITY_DETAIL_COUNTRIES.has(foodbank.country),
      nearby,
      latt: Number(latStr),
      long: Number(lngStr),
      map_config: mapConfig,
    },
    locale,
  );
  return c.html(html);
}
