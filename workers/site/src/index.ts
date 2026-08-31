import { Hono } from "hono";
import { LOCALES } from "@givefood/templates";
import type { AppEnv } from "./types";
import { serverTiming } from "./middleware/serverTiming";
import { slugRedirect } from "./middleware/slugRedirect";
import { resolveLanguage } from "./middleware/resolveLanguage";
import { geoJsonPreload } from "./middleware/geoJsonPreload";
import { mediaApp } from "./routes/media";
import { staticMediaApp } from "./routes/staticMedia";
import { dumpsApp } from "./routes/dumps";
import { api1App } from "./routes/api1";
import { api2FoodbanksApp } from "./routes/api2/foodbanks";
import { api2LocationsApp } from "./routes/api2/locations";
import { api2DonationpointsApp } from "./routes/api2/donationpoints";
import { api2NeedsApp } from "./routes/api2/needs";
import { api2ConstituenciesApp } from "./routes/api2/constituencies";
import { api3App } from "./routes/api3";
import { api1Index, api2Docs, api2Index } from "./routes/apiDocs";
import { wfbnIndex } from "./routes/wfbn";
import { wfbnFoodbank } from "./routes/wfbn/foodbank";
import { wfbnFoodbankNearby } from "./routes/wfbn/nearby";
import { wfbnConstituencyGeojson, wfbnFoodbankGeojson, wfbnFoodbankLocationGeojson, wfbnGeojson } from "./routes/wfbn/geojson";
import { wfbnFoodbankUpdates } from "./routes/wfbn/updates";
import { wfbnFoodbankHit } from "./routes/wfbn/hit";
import { wfbnWebpushConfig, wfbnWebpushSubscribe, wfbnWebpushUnsubscribe } from "./routes/wfbn/webpush";
import { wfbnMobsub, wfbnDeleteMobsub } from "./routes/wfbn/mobsub";
import { humanRelay } from "./routes/human";
import { publicIndex } from "./routes/public";
import { notPortedYet } from "./routes/notPortedYet";
import { render404 } from "./render404";

// gfapi2 (WP 2.4) split across 5 files by concern during the build; every
// "self"/"urls" field each one emits is hardcoded to /api/2/... regardless
// of which mount point actually served the request (verified against the
// Python source -- it never derives these from the current request path
// either), so the combined app below is safe to mount at both /api/2 and
// /api.
const api2App = new Hono<AppEnv>();
api2App.route("/", api2FoodbanksApp);
api2App.route("/", api2LocationsApp);
api2App.route("/", api2DonationpointsApp);
api2App.route("/", api2NeedsApp);
api2App.route("/", api2ConstituenciesApp);

// PLAN.md §3.5 "Request lifecycle". Hono's onion middleware model maps 1:1
// onto Django's MIDDLEWARE list, in the same order -- see the table in that
// section for which Django middleware became which piece here, and which
// were deleted outright (GZipMiddleware -> Cloudflare edge, automatic;
// OfflineKeyCheck -> /offline/ ceases to be an HTTP surface;
// RedirectToWWW -> a zone Redirect Rule).
const app = new Hono<AppEnv>();

app.use("*", serverTiming); // was RenderTime
app.use("*", slugRedirect); // was SlugRedirectMiddleware
app.use("*", resolveLanguage); // was LocaleMiddleware + i18n_patterns
app.use("*", geoJsonPreload); // was GeoJSONPreload (runs after routing)

// Media routes are registered at givefood/urls.py:14 -> gfwfbn/urls/generic.py,
// OUTSIDE i18n_patterns -- one URL each, never language-prefixed. This is
// the one route group fully built out in this pass; see PLAN.md §3.7.
app.route("/needs", mediaApp);

// img/ar/** and img/appscreenshots/** -- everything else under /static/* is
// served by Workers Static Assets (asset-first, never reaches this Worker);
// only these two excluded families fall through to here. See PLAN.md WP 1.6.
app.route("/static", staticMediaApp);

// The two download URL shapes redirect to dumps.givefood.org.uk (R2 custom
// domain, no Worker in that request path). See PLAN.md WP 1.4/1.5.
app.route("/dumps", dumpsApp);

// WP 2.4: the 20 JSON/XML/YAML/CSV/geojson API endpoints. gfapi2 is
// dual-mounted at /api/2/* AND /api/* per PLAN.md §10.2.2 -- "every gfapi2
// route is live at both; only the /api/2/ forms are in the current purge
// list, so the /api/ aliases have been going stale to TTL". Mount the
// specific /api/1, /api/2, /api/3 prefixes before the bare /api dual-mount
// so e.g. /api/1/foodbanks/ resolves via api1App, not by falling through
// to api2App's own /foodbanks/ path (Hono's router disambiguates these
// fine on path structure alone, but the order keeps intent obvious).
app.route("/api/1", api1App);
app.route("/api/2", api2App);
// Mounting a sub-app whose own root route is registered as .get("/", ...)
// matches the bare mount prefix ("/api/3") but NOT the prefix with a
// trailing slash ("/api/3/") -- the same Hono quirk found and documented
// during WP 1.x's diagnostic testing. Applies equally to gfapi1's and
// gfapi2's index/docs pages below, so each is registered directly on `app`
// rather than as a "/" (or "docs/") route on a mounted sub-app.
app.get("/api/1/", api1Index); // gfapi1 `api` (WP 2.7)
app.get("/api/2/", api2Index); // gfapi2 `index` (WP 2.7)
app.get("/api/2/docs/", api2Docs); // gfapi2 `docs` (WP 2.7)
app.get("/api/3/", (c) => c.text("Give Food API 3"));
app.route("/api/3", api3App);
app.route("/api", api2App);

// Anything WP 2.4/2.7 didn't mount above -- genuinely unmatched /api/* paths.
app.route("/api", notPortedYet("gfapi3 docs page"));

// gfwfbn `index` -- i18n-patterned (givefood/urls.py:47, inside
// i18n_patterns), so it's registered once bare (English, no prefix) and
// once per other supported language (§2.7.1: cy/ga/gd, not Django's full
// 21) -- matching prefix_default_language=False exactly, same as
// resolveLanguage.ts's own PREFIXES set (derived from the same LOCALES).
app.get("/needs/", wfbnIndex);
app.get("/needs/at/:slug/", wfbnFoodbank);
app.get("/needs/at/:slug/nearby/", wfbnFoodbankNearby);
app.get("/needs/geo.json", wfbnGeojson);
app.get("/needs/at/:slug/geo.json", wfbnFoodbankGeojson);
app.get("/needs/at/:slug/:locslug/geo.json", wfbnFoodbankLocationGeojson);
app.get("/needs/in/constituency/:parlconSlug/geo.json", wfbnConstituencyGeojson);
// Django's `updates` view has no method-restricting decorator (only
// @csrf_exempt) -- reachable via GET (render a page) or POST (the actions
// themselves, including the RFC 8058 bare-200 one-click unsubscribe case
// the handler itself branches on). :action is regex-constrained the same
// way media.ts/api2/donationpoints.ts already constrain a path segment.
app.get("/needs/at/:slug/updates/:action{subscribe|confirm|unsubscribe}/", wfbnFoodbankUpdates);
app.post("/needs/at/:slug/updates/:action{subscribe|confirm|unsubscribe}/", wfbnFoodbankUpdates);
for (const locale of LOCALES) {
  if (locale === "en") continue;
  app.get(`/${locale}/needs/`, wfbnIndex);
  app.get(`/${locale}/needs/at/:slug/`, wfbnFoodbank);
  app.get(`/${locale}/needs/at/:slug/nearby/`, wfbnFoodbankNearby);
  app.get(`/${locale}/needs/geo.json`, wfbnGeojson);
  app.get(`/${locale}/needs/at/:slug/geo.json`, wfbnFoodbankGeojson);
  app.get(`/${locale}/needs/at/:slug/:locslug/geo.json`, wfbnFoodbankLocationGeojson);
  app.get(`/${locale}/needs/in/constituency/:parlconSlug/geo.json`, wfbnConstituencyGeojson);
  app.get(`/${locale}/needs/at/:slug/updates/:action{subscribe|confirm|unsubscribe}/`, wfbnFoodbankUpdates);
  app.post(`/${locale}/needs/at/:slug/updates/:action{subscribe|confirm|unsubscribe}/`, wfbnFoodbankUpdates);
}

// gfwfbn `wfbn-generic` -- registered before i18n_patterns in
// givefood/urls.py (§6.1.1), so these never carry a language prefix
// regardless of the current page's language. webpush_subscribe/
// webpush_unsubscribe have no @require_POST in Django either (the view
// checks request.method by hand and returns 400, not 404, for the wrong
// method) -- app.all() reproduces that, where app.post() would make Hono
// itself 404 a non-POST request instead.
app.post("/needs/at/:slug/hit/", wfbnFoodbankHit);
app.get("/needs/webpush/config/", wfbnWebpushConfig);
app.all("/needs/webpush/subscribe/:slug/", wfbnWebpushSubscribe);
app.all("/needs/webpush/unsubscribe/:slug/", wfbnWebpushUnsubscribe);
app.post("/needs/mobsub/", wfbnMobsub);
app.post("/needs/mobsub/delete/", wfbnDeleteMobsub);

// givefood `index` (GET /, i18n-patterned same as wfbn:index above).
app.get("/", publicIndex);
for (const locale of LOCALES) {
  if (locale === "en") continue;
  app.get(`/${locale}/`, publicIndex);
}

// givefood `human` -- the Turnstile honeypot relay the subscribe form
// posts through before its real target (givefood/urls.py:28, inside
// i18n_patterns). @require_POST in Django -- POST only.
app.post("/human/", humanRelay);
for (const locale of LOCALES) {
  if (locale === "en") continue;
  app.post(`/${locale}/human/`, humanRelay);
}

// Everything below is specified in PLAN.md but not yet built. Each returns
// 501 so the gap is loud during development. Build order follows PLAN.md
// §10's phases: wfbn (translated pages) and the APIs next, admin last.
app.route("/needs", notPortedYet("gfwfbn (translated pages)"));
app.route("/dashboard", notPortedYet("gfdash"));
app.route("/write", notPortedYet("gfwrite"));
// The three listing pages (dump_index, dump_type, dump_format) -- unmatched
// by dumpsApp above, so they fall through to here.
app.route("/dumps", notPortedYet("gfdumps listing pages"));
app.route("/auth", notPortedYet("gfauth (Google OAuth)"));
app.route("/admin", notPortedYet("gfadmin"));
app.route("/", notPortedYet("public site"));

// PLAN.md §3.5 "APPEND_SLASH". No platform equivalent -- Workers Static
// Assets' force-trailing-slash only affects ASSET lookups, not the 3,000+
// food bank URLs that actually need this. Reproduce Django's real behaviour
// (a 301 to the slashed URL, not serving content in place) with a bounded
// re-dispatch, restricted to GET/HEAD to avoid re-running a mutating request.
app.notFound(async (c) => {
  const url = new URL(c.req.url);
  const method = c.req.method;

  if ((method === "GET" || method === "HEAD") && !url.pathname.endsWith("/")) {
    const slashed = new URL(url.toString());
    slashed.pathname += "/";
    const probe = await app.fetch(new Request(slashed, { method: "HEAD" }), c.env, c.executionCtx);
    if (probe.status !== 404 && probe.status !== 501) {
      return c.redirect(slashed.toString(), 301); // Django's APPEND_SLASH is a 301
    }
  }

  return c.html(await render404(c), 404);
});

export default app;
