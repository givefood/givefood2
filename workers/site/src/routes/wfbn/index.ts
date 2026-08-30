import type { Context } from "hono";
import { buildPageContext, render } from "@givefood/templates";
import { isUk } from "@givefood/geo";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { geocode } from "../../lib/geocode";
import { elapsedMs } from "../../middleware/serverTiming";
import { findLocations } from "../../lib/findLocations";
import { findDonationpoints } from "../../lib/findDonationpoints";

// gfwfbn `index` (GET /needs/, i18n-patterned -- mounted at /needs/,
// /cy/needs/, /ga/needs/, /gd/needs/ in index.ts). The `place` view
// (`at/place/<county>/<place>/`, which delegates to this same view with a
// resolved lat_lng/page_title) is not built yet -- a separate URL pattern
// backed by the Place model, out of scope for this pass.
//
// ITEM_CATEGORIES_CHOICES (the "by item" tab's category dropdown) and
// find_locations_by_category() are not ported yet either -- the category
// filter needs FoodbankChangeLine, one of the tables PLAN.md's WP 2.2a
// scoping confirmed isn't copied to D1 (the 5 API-read tables don't
// include it). The tab still renders, just with an empty category list --
// a real, honest "not populated yet" state, not a broken one.
// A plain handler, registered directly at each of the 4 language-variant
// paths in index.ts (bare + /cy//ga//gd/) -- not a mounted sub-app.
// Mounting a sub-app whose own route is a bare .get("/") matches the
// mount prefix WITHOUT a trailing slash, not with (the Hono quirk already
// documented for /api/3/ and the WP 2.7 doc pages); registering directly
// on `app` sidesteps it entirely, same as those.
export async function wfbnIndex(c: Context<AppEnv>): Promise<Response> {
  // Legacy misspelt query param -- permanent redirect, same as Django.
  const lattlong = c.req.query("lattlong");
  if (lattlong) {
    const target = new URL(c.req.url);
    target.search = `?lat_lng=${encodeURIComponent(lattlong)}`;
    return c.redirect(target.toString(), 301);
  }

  const address = c.req.query("address") ?? "";
  const itemCategory = c.req.query("item") ?? "";
  let latLng = c.req.query("lat_lng") ?? "";

  if (address && !latLng) {
    latLng = await geocode(c, address);
  }

  // No location signal at all -- Django redirects to the root homepage
  // (reverse("index"), the givefood app's own index, NOT wfbn:index).
  // That page is Phase 4 scope and not built yet, but the redirect itself
  // is correct behaviour to reproduce now.
  if (!latLng) {
    return c.redirect("/", 301);
  }

  const parts = latLng.split(",");
  if (parts.length !== 2) {
    return new Response("", { status: 400 });
  }
  const [latStr, lngStr] = parts as [string, string];
  const lat = Number(latStr);
  const lng = Number(lngStr);

  const latLngIsUk = !Number.isNaN(lat) && !Number.isNaN(lng) && isUk(lat, lng);

  const session = dbSession(c);
  const [rawLocations, rawDonationpoints] = latLngIsUk
    ? await Promise.all([findLocations(session, lat, lng, 20), findDonationpoints(session, lat, lng, 20)])
    : [null, null];
  // Nunjucks' {% if %} uses JS truthiness -- an empty array is truthy,
  // unlike Django's `if locations:`, which is false for an empty list
  // (verified directly: env.renderString with items=[] renders the
  // truthy branch). index.njk's several `{% if locations %}` guards need
  // Python's semantics to hide an empty results section instead of
  // showing one with no rows -- convert here, at the data boundary, not
  // by changing nunjucks' global truthiness (which every other template
  // also relies on behaving like JS). Watch for this with any future
  // ported template that gates on a possibly-empty list.
  const locations = rawLocations && rawLocations.length > 0 ? rawLocations : null;
  const donationpoints = rawDonationpoints && rawDonationpoints.length > 0 ? rawDonationpoints : null;

  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";
  const geojsonPath = "/needs/geo.json"; // WP 3.6, not built yet
  const mapConfig = JSON.stringify({
    geojson: locale === "en" ? geojsonPath : `/${locale}${geojsonPath}`,
    lat: latStr,
    lng: lngStr,
    zoom: 13,
    location_marker: true,
  });

  const context = buildPageContext({
    path: c.req.path,
    querystring: new URL(c.req.url).search.slice(1),
    appName: "gfwfbn",
    pageTranslatable: true,
    locale,
    unprefixedPath: c.get("pathAfterPrefix"),
  });

  const html = await render(
    "wfbn/index.njk",
    {
      ...context,
      render_time_ms: elapsedMs(c),
      address,
      lat: Number.isNaN(lat) ? "" : latStr,
      lng: Number.isNaN(lng) ? "" : lngStr,
      locations,
      donationpoints,
      locations_by_category: null,
      item_category: itemCategory,
      item_categories: [],
      is_uk: latLngIsUk,
      map_config: mapConfig,
      page_title: null,
    },
    locale,
  );
  return c.html(html);
}
