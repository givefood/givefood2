import type { MiddlewareHandler } from "hono";

// Port of givefood/middleware.py's GeoJSONPreload. Runs after routing (it
// wraps `next()`), and reads Hono's matched route template via
// `c.req.routePath` -- the equivalent of Django's `resolve(request.path).url_name`.
// Route templates below must stay in sync with routes/wfbn.ts as that file
// is built out; this middleware is inert (adds no header) for any route it
// does not recognise, which is the same fail-open behaviour as the Django
// original's try/except around resolve().
export const geoJsonPreload: MiddlewareHandler = async (c, next) => {
  await next();

  if (c.res.status !== 200 || !(c.res.headers.get("Content-Type") ?? "").includes("text/html")) {
    return;
  }

  const routePath = c.req.routePath;
  let geojsonUrl: string | null = null;

  if (routePath === "/needs/") {
    geojsonUrl = "/needs/geo.json";
  } else if (
    routePath === "/needs/at/:slug/" ||
    routePath === "/needs/at/:slug/locations/" ||
    routePath === "/needs/at/:slug/donationpoints/" ||
    routePath === "/needs/at/:slug/:locslug/"
  ) {
    const slug = c.req.param("slug");
    if (slug) geojsonUrl = `/needs/at/${slug}/geo.json`;
  } else if (routePath === "/needs/at/:slug/nearby/") {
    geojsonUrl = "/needs/geo.json";
    // `/needs/in/constituency/:slug/`, WITH the prefix (github #29). This
    // literal was the only one of the five missing `/needs`, so the branch
    // below could never be entered: index.ts registers the page at
    // `/needs/in/constituency/:slug/` and nothing in workers/ is registered
    // at `/in/constituency/...` at all. ~650 constituency pages therefore
    // sent no Link header, where Django's middleware.py:135 sends one --
    // and PLAN.md's own G3 acceptance criterion lists `constituency` among
    // the seven route names this must cover.
  } else if (routePath === "/needs/in/constituency/:slug/") {
    const slug = c.req.param("slug");
    if (slug) geojsonUrl = `/needs/in/constituency/${slug}/geo.json`;
  }

  if (geojsonUrl) {
    c.res.headers.set("Link", `<${geojsonUrl}>; rel=preload; as=fetch; crossorigin=anonymous`);
  }
};
