import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";

// Port of givefood/middleware.py's GeoJSONPreload. Runs after routing (it
// wraps `next()`), and reads Hono's matched route template via
// `c.req.routePath` -- the equivalent of Django's `resolve(request.path).url_name`.
// Route templates below must stay in sync with routes/wfbn.ts as that file
// is built out; this middleware is inert (adds no header) for any route it
// does not recognise, which is the same fail-open behaviour as the Django
// original's try/except around resolve().
export const geoJsonPreload: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();

  if (c.res.status !== 200 || !(c.res.headers.get("Content-Type") ?? "").includes("text/html")) {
    return;
  }

  // THE LOCALE PREFIX IS STRIPPED BEFORE MATCHING AND PUT BACK AFTER (github
  // #30). index.ts registers every page twice -- once bare and once per
  // locale, `app.get("/" + locale + "/needs/at/:slug/", ...)` -- so a Welsh
  // request matches the route template "/cy/needs/at/:slug/", which equalled
  // none of the literals below. Every /cy/, /ga/ and /gd/ page therefore lost
  // the preload on all six map pages, worst on /cy/needs/ where the payload
  // is the ~8,800-feature all-food-banks geo.json. Django loses nothing:
  // LocaleMiddleware sits outside GeoJSONPreload, so `resolve()` has already
  // stripped the i18n prefix by the time the header is built, and `reverse()`
  // puts it back.
  //
  // TAKEN FROM `lang`, NOT FROM A SECOND LIST OF LOCALES. resolveLanguage
  // (registered immediately before this middleware) has already decided the
  // language from the same @givefood/templates LOCALES that index.ts's
  // registration loop uses; reading its answer means a fifth language needs
  // no edit here. Defaulting to "en" covers a caller that mounts this
  // middleware without resolveLanguage in front of it -- which the test suite
  // does, and which must keep behaving like an unprefixed request.
  const lang = c.get("lang") ?? "en";
  const prefix = lang === "en" ? "" : `/${lang}`;
  const routePath = prefix && c.req.routePath.startsWith(`${prefix}/`) ? c.req.routePath.slice(prefix.length) : c.req.routePath;
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
    // Prefixed back on, matching what the PAGE actually fetches: routes/wfbn's
    // handlers build map_config.geojson with urlForLocale(), so a Welsh page
    // requests /cy/needs/at/x/geo.json. Preloading the unprefixed URL would be
    // worse than preloading nothing -- a wasted request that also warms a
    // cache entry the page never reads.
    c.res.headers.set("Link", `<${prefix}${geojsonUrl}>; rel=preload; as=fetch; crossorigin=anonymous`);
  }
};
