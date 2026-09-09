import type { Context } from "hono";
import { getNeedTranslationsByIds } from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import { isUk } from "@givefood/geo";
import { urlForLocale } from "@givefood/urls";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { geocode } from "../../lib/geocode";
import { elapsedMs } from "../../middleware/serverTiming";
import { findLocations } from "../../lib/findLocations";
import { findDonationpoints } from "../../lib/findDonationpoints";
import { findLocationsByCategory } from "../../lib/findLocationsByCategory";
import { ITEM_CATEGORIES } from "../../lib/itemCategories";
import { resolveNeedText } from "@givefood/models";

// gfwfbn `index` (GET /needs/, i18n-patterned -- mounted at /needs/,
// /cy/needs/, /ga/needs/, /gd/needs/ in index.ts). The `place` view
// (`at/place/<county>/<place>/`, which delegates to this same view with a
// resolved lat_lng/page_title) is not built yet -- a separate URL pattern
// backed by the Place model, out of scope for this pass.
//
// ITEM_CATEGORIES_CHOICES (the "by item" tab's category dropdown) and
// find_locations_by_category() are now ported (WP 3.5) -- itemCategories.ts
// and findLocationsByCategory.ts respectively. foodbankchangeline (the
// table the category filter needs) is now populated in D1
// (migrations/0003_homepage_data.sql, 332,478 rows) -- the earlier "not
// populated yet" blocker this comment used to describe is resolved.
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

  // gfwfbn/views.py:89-93 -- `item_category` is validated against
  // ITEM_CATEGORIES_CHOICES before find_locations_by_category() runs at
  // all; an unrecognised value (typo, stale link, tampered query string)
  // is silently ignored rather than erroring, same as Django.
  const itemCategoryIsValid = itemCategory !== "" && ITEM_CATEGORIES.includes(itemCategory);

  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";
  const session = dbSession(c);
  const [rawLocations, rawDonationpoints, rawLocationsByCategory] = latLngIsUk
    ? await Promise.all([
        findLocations(session, lat, lng, 20),
        findDonationpoints(session, lat, lng, 20),
        itemCategoryIsValid ? findLocationsByCategory(session, lat, lng, itemCategory, 20) : Promise.resolve(null),
      ])
    : [null, null, null];
  // Nunjucks' {% if %} uses JS truthiness -- an empty array is truthy,
  // unlike Django's `if locations:`, which is false for an empty list
  // (verified directly: env.renderString with items=[] renders the
  // truthy branch). index.njk's several `{% if locations %}` guards need
  // Python's semantics to hide an empty results section instead of
  // showing one with no rows -- convert here, at the data boundary, not
  // by changing nunjucks' global truthiness (which every other template
  // also relies on behaving like JS). Watch for this with any future
  // ported template that gates on a possibly-empty list.
  const filteredLocations = rawLocations && rawLocations.length > 0 ? rawLocations : null;
  const filteredDonationpoints = rawDonationpoints && rawDonationpoints.length > 0 ? rawDonationpoints : null;
  const filteredLocationsByCategory = rawLocationsByCategory && rawLocationsByCategory.length > 0 ? rawLocationsByCategory : null;

  // FoodbankChangeTranslation batch lookup (needs.py:216-259) -- ONE D1
  // round trip covering every result across all three lists (a food bank
  // can legitimately appear in more than one), not one per row.
  // findLocations()/findDonationpoints()/findLocationsByCategory() have no
  // locale context of their own (see findDonationpoints.ts's own comment
  // on why) and only ever carry the raw English latest_need_change_text;
  // this route knows the locale, so it resolves the translated DISPLAY
  // text here and overlays it as a parallel field. Unlike foodbank.ts
  // (whose Nothing/Unknown gate stays on the raw field, only the inner
  // Facebook/display split uses the translated one), index.njk's own
  // Nothing/Unknown/Facebook branch checks for all three sections
  // (locations, donationpoints, locations_by_category) check the
  // TRANSLATED latest_need_get_change_text field for every branch --
  // matching Django's real wfbn/index.html, which resolves
  // `change_text=location.latest_need.get_change_text` FIRST via
  // `{% with %}` and only then branches on it.
  // NULLS FILTERED OUT, not passed down (github #13). A result whose food
  // bank has no published need now carries `latest_need_id: null` instead of
  // 500ing the page, and a null in this list would become a `WHERE id IN
  // (..., NULL)` bind that matches nothing and costs a round trip to find
  // that out -- and, on a search where EVERY result lacked a need, would turn
  // the "no ids, skip the query" guard below into a query for [null].
  const allNeedIds = Array.from(
    new Set(
      [
        ...(filteredLocations ?? []).map((r) => r.latest_need_id),
        ...(filteredDonationpoints ?? []).map((r) => r.latest_need_id),
        ...(filteredLocationsByCategory ?? []).map((r) => r.latest_need_id),
      ].filter((id): id is number => id !== null),
    ),
  );
  const needTranslations = locale !== "en" && allNeedIds.length > 0 ? await getNeedTranslationsByIds(session, allNeedIds, locale) : null;
  // `latest_need_id` is nullable since github #13. resolveNeedText("") is ""
  // -- the same empty string Django's template produces when it resolves
  // `latest_need.get_change_text` on None -- so index.njk falls through its
  // Nothing/Unknown/Facebook branches to `{{ ...|linebreaks }}` exactly as
  // Django does, and the row renders blank instead of taking the page down.
  const withTranslatedText = <T extends { latest_need_change_text: string; latest_need_id: number | null }>(rows: T[] | null) =>
    rows === null
      ? null
      : rows.map((row) => ({
          ...row,
          latest_need_get_change_text: resolveNeedText(
            row.latest_need_change_text,
            row.latest_need_id === null ? undefined : needTranslations?.get(row.latest_need_id)?.change_text,
            locale,
          ),
        }));
  const locations = withTranslatedText(filteredLocations);
  const donationpoints = withTranslatedText(filteredDonationpoints);
  const locationsByCategory = withTranslatedText(filteredLocationsByCategory);
  const mapConfig = JSON.stringify({
    geojson: urlForLocale(locale, "wfbn:geojson"),
    lat: latStr,
    lng: lngStr,
    zoom: 13,
    location_marker: true,
  });

  const context = buildPageContext({
    path: c.req.path,
    querystring: new URL(c.req.url).search.slice(1),
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
      locations_by_category: locationsByCategory,
      item_category: itemCategory,
      // wfbn/index.njk destructures each entry as `cat_value, cat_label`
      // (Django's ITEM_CATEGORIES_CHOICES is a tuple of (category,
      // category) pairs -- see itemCategories.ts) -- pair up the flat
      // string list the same way here, at the template boundary.
      item_categories: ITEM_CATEGORIES.map((category) => [category, category]),
      is_uk: latLngIsUk,
      map_config: mapConfig,
      page_title: null,
    },
    locale,
  );
  return c.html(html);
}
