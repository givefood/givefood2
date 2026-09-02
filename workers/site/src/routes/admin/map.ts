import type { Context } from "hono";
import { render } from "@givefood/templates";
import { url } from "@givefood/urls";
import type { AppEnv } from "../../types";
import { adminPageContext } from "./pageContext";

// gfadmin/views.py:2730-2743 admin_map() -- the entire view. No ORM access
// at all: it builds a five-key config object, JSON-encodes it, and the
// browser's MapLibre fetches the data itself from the PUBLIC
// /needs/geo.json feed this Worker already serves (index.ts:178 ->
// routes/wfbn/geojson.ts). ~8,700 point features: every open food bank,
// location and donation point.
//
// `url("wfbn:geojson")` rather than urlForLocale(): gfadmin is mounted
// OUTSIDE i18n_patterns in Django (givefood/urls.py:97 vs :18/:58), so
// reverse() there always yields the unprefixed "/needs/geo.json" too.
//
// NO API KEY OF ANY KIND is involved. static/js/wfbn.js:112 hard-codes
// `style: "https://maptiles.opencommons.uk/styles/bright"` -- MapLibre GL
// JS against a keyless third-party tile server, self-hosted from
// /static/js/maplibre-gl.js. The four Google keys admin/page.njk exposes
// are for admin.js's geocode/place-lookup buttons and are not read by the
// map at all.
//
// Django gives this view no `section`, so no nav item highlights there.
// "settings" here instead, because the port's own admin/settings.njk:45 is
// the only thing that links /admin/map/ -- in Django the URL is an orphan
// reachable only by typing it (`grep -rn "admin:map"` across the Django
// tree hits nothing but gfadmin/tests/test_map_view.py).
export async function adminMap(c: Context<AppEnv>): Promise<Response> {
  const mapConfig = JSON.stringify({
    geojson: url("wfbn:geojson"), // views.py:2733 -> "/needs/geo.json"
    lat: 55.4, // views.py:2734
    lng: -4, // views.py:2735
    zoom: 5, // views.py:2736
    // wfbn.js:246 -- false means no blue "you are here" dot.
    location_marker: false, // views.py:2737
  });

  const html = await render("admin/map.njk", {
    ...(await adminPageContext(c, "settings")),
    map_config: mapConfig,
  });
  return c.html(html);
}
