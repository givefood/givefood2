import { Hono } from "hono";
import type { Context } from "hono";
import { LOCALES } from "@givefood/templates";
import type { AppEnv } from "./types";
import { noStore } from "./middleware/noStore";
import { pageCacheControl } from "./middleware/pageCacheControl";
import { serverTiming } from "./middleware/serverTiming";
import { cacheTag } from "./middleware/cacheTag";
import { runtimeIdentity } from "./middleware/runtimeIdentity";
import { securityHeaders } from "./middleware/securityHeaders";
import { slugRedirect } from "./middleware/slugRedirect";
import { resolveLanguage } from "./middleware/resolveLanguage";
import { geoJsonPreload } from "./middleware/geoJsonPreload";
import { mediaApp } from "./routes/media";
import { staticMediaApp } from "./routes/staticMedia";
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
import { wfbnRss, wfbnFoodbankRss } from "./routes/wfbn/rss";
import { wfbnGetLocation } from "./routes/wfbn/getLocation";
import { wfbnFoodbankDonationpoints, wfbnFoodbankLocations } from "./routes/wfbn/locations";
import { wfbnFoodbankDonationpoint, wfbnFoodbankDonationpointOpeninghours, wfbnFoodbankLocation } from "./routes/wfbn/locationDetail";
import { wfbnFoodbankCharity, wfbnFoodbankNews } from "./routes/wfbn/newsCharity";
import { wfbnConstituencyGeojson, wfbnFoodbankGeojson, wfbnFoodbankLocationGeojson, wfbnGeojson } from "./routes/wfbn/geojson";
import { wfbnConstituencies, wfbnConstituency, wfbnMpPhotoRedirect } from "./routes/wfbn/constituencies";
import { wfbnFoodbankUpdates } from "./routes/wfbn/updates";
import { wfbnFoodbankHit } from "./routes/wfbn/hit";
import { wfbnFoodbankDonationpointFavicon, wfbnFoodbankFavicon } from "./routes/wfbn/favicon";
import { wfbnFoodbankScreenshot } from "./routes/wfbn/screenshot";
import { wfbnWebpushConfig, wfbnWebpushSubscribe, wfbnWebpushUnsubscribe } from "./routes/wfbn/webpush";
import { wfbnMobsub, wfbnDeleteMobsub } from "./routes/wfbn/mobsub";
import { humanRelay } from "./routes/human";
import { whatsappHook } from "./routes/whatsappHook";
import { publicIndex } from "./routes/public";
import { publicAboutUs, publicApps, publicBot } from "./routes/public/contentPages";
import { publicServices } from "./routes/public/services";
import { publicPrivacy } from "./routes/public/privacy";
import { publicDonate } from "./routes/public/donate";
import { publicNews } from "./routes/public/news";
import { publicRegisterFoodbank } from "./routes/public/registerFoodbank";
import { publicFlag } from "./routes/public/flag";
import { publicCountry, publicCountryGeojson } from "./routes/public/country";
import { annualReport, annualReportIndex } from "./routes/public/annualReport";
import { robotsTxt } from "./routes/public/robots";
import { manifestJson } from "./routes/public/manifest";
import { sitemapXml } from "./routes/public/sitemaps";
import { llmsTxt, securityTxt } from "./routes/public/textFiles";
import { frag } from "./routes/public/frag";
import { mdIndex, mdSitemapMd, mdSitemapXml } from "./routes/public/md";
import { addressAutocomplete, addressAutocompleteNext } from "./routes/public/aac";
import { mdFoodbank, mdFoodbankNearby } from "./routes/wfbn/md/foodbank";
import { mdFoodbankLocation, mdFoodbankLocations } from "./routes/wfbn/md/locations";
import { mdFoodbankDonationpoint, mdFoodbankDonationpoints } from "./routes/wfbn/md/donationpoints";
import { mdFoodbankCharity, mdFoodbankNews } from "./routes/wfbn/md/newsCharity";
import { gfdashIndex } from "./routes/dashboards/index";
import { gfdashWeeklyItemcount } from "./routes/dashboards/weeklyItemcount";
import { gfdashWeeklyItemcountYear } from "./routes/dashboards/weeklyItemcountYear";
import { gfdashMostRequestedItems, gfdashTtMostRequestedItems } from "./routes/dashboards/mostRequestedItems";
import { gfdashMostExcessItems } from "./routes/dashboards/mostExcessItems";
import { gfdashItemCategories } from "./routes/dashboards/itemCategories";
import { gfdashItemGroups } from "./routes/dashboards/itemGroups";
import { gfdashTtOldData } from "./routes/dashboards/ttOldData";
import { gfdashArticles } from "./routes/dashboards/articles";
import { gfdashBeautybanks } from "./routes/dashboards/beautybanks";
import { gfdashExcess } from "./routes/dashboards/excess";
import { gfdashFoodbanksFound } from "./routes/dashboards/foodbanksFound";
import { gfdashBeanPastaIndex } from "./routes/dashboards/beanPastaIndex";
import { gfdashDeliveries } from "./routes/dashboards/deliveries";
import { gfdashSupermarkets } from "./routes/dashboards/supermarkets";
import { gfdashCharityIncomeExpenditure } from "./routes/dashboards/charityIncomeExpenditure";
import { gfdashPricePerKg } from "./routes/dashboards/pricePerKg";
import { gfdashHeatmap } from "./routes/dashboards/heatmap";
import { gfdashPricePerCalorie } from "./routes/dashboards/pricePerCalorie";
import { gfdashPricePerItemCategory } from "./routes/dashboards/pricePerItemCategory";
import { writeIndex, writeConstituency, writeConstituencyByCode, writeEmail, writeSend, writeDone } from "./routes/write";
import { adminSignIn, adminAuthStart, adminAuthReceiver, adminSignOut } from "./routes/admin/auth";
import { adminApp, adminIndex } from "./routes/admin";
import { gone } from "./routes/notPortedYet";
import { tryAppendSlashRedirect } from "./lib/appendSlash";
import { render404 } from "./render404";
import { render500 } from "./render500";

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
app.use("*", securityHeaders); // was SecurityMiddleware's nosniff + Referrer-Policy
app.use("*", cacheTag);     // PLAN.md §3.6 -- what queues/cachePurge.ts purges by
app.use("*", runtimeIdentity); // was context_processors.py's instance_id/version env reads
app.use("*", slugRedirect); // was SlugRedirectMiddleware
app.use("*", resolveLanguage); // was LocaleMiddleware + i18n_patterns
app.use("*", geoJsonPreload); // was GeoJSONPreload (runs after routing)
// Restores the header half of Django's 75 @cache_page decorators for HTML,
// RSS and Markdown. Registered HERE, above the noStore mounts below, on
// purpose: Hono unwinds post-response middleware in reverse registration
// order, so this one runs LAST and sees every header the admin's no-store
// and each route's own Cache-Control have already set -- which is exactly
// what its "never override" guard needs. See middleware/pageCacheControl.ts.
app.use("*", pageCacheControl);

// SECURITY, registered before any /admin or /auth route so it wraps every one
// of them (including the auth redirects and 404s): mark the whole admin
// uncacheable. See middleware/noStore.ts -- Cloudflare was caching
// authenticated admin pages and serving them anonymously, and because
// wrangler.jsonc enables the Workers Cache a HIT never executes the Worker,
// so requireAdminAuth could not have caught it.
//
// Four patterns, not one: Hono matches "/admin/*" against the SUBPATHS only,
// so the bare mount points "/admin" and "/auth" need their own entries or the
// dashboard itself goes uncovered.
app.use("/admin", noStore);
app.use("/admin/*", noStore);
app.use("/auth", noStore);
app.use("/auth/*", noStore);
// Same root cause, public routes: two GET endpoints that mutate and one that
// echoes a visitor's own email address. See middleware/noStore.ts.
app.use("/needs/at/*/updates/*", noStore);
app.use("/write/to/*/email/done/*", noStore);

// EVERY PUBLIC PAGE THAT RENDERS A CSRF TOKEN. These templates embed a
// csrf_token in a form (public/register_foodbank.njk, write/constituency.njk,
// write/email.njk), which makes the response per-visitor and unshareable.
//
// public/flag.njk USED TO BE ON THIS LIST and no longer is (issue #40).
// routes/public/flag.ts stopped issuing a token at all -- Django's flag()
// never had one, its form is unauthenticated, and Turnstile is what actually
// guards it -- so the page is now identical for every visitor and goes back
// to the edge. It was 16.94% of the zone's 200s (13,117/day) held at
// cf-cache-status BYPASS by the mount that stood here. THE TWO EDITS ARE ONE
// CHANGE: re-adding this mount without re-adding the token merely wastes the
// cache, but removing the token while this mount stands, or vice versa, is
// how the failure below gets reproduced.
//
// WHY noStore AND NOT JUST WITHHOLDING Cache-Control. Removing the header is
// not sufficient, and believing it was is what left this live: the zone
// Cache Rule gives HTML an EDGE TTL of its own, so the edge caches a page
// whether or not the Worker sends Cache-Control -- that is exactly how HTML
// was being served at cf-cache-status HIT with age=3092 and no header at
// all, before any of this middleware existed. Confirmed again after the
// first attempt at this fix: /flag/ still came back HIT, age=47, header
// gone. Only CDN-Cache-Control: no-store, which noStore sets, actually
// stops it -- the same mechanism that keeps /admin at BYPASS.
//
// Cloudflare's own "do not cache a response with Set-Cookie" rule masked
// this for first-time visitors, which is why it survived review: a visitor
// with no cookie gets a Set-Cookie and a BYPASS, and only a RETURNING
// visitor (issueCsrfToken reuses their cookie and emits no Set-Cookie)
// produces a cacheable token-bearing page.
// TRAILING SLASHES ARE LOAD-BEARING. Hono matches a middleware pattern
// against the full path, and "/flag" does NOT match "/flag/" -- verified
// directly, not assumed. Every route here is registered WITH the slash
// (Django's APPEND_SLASH shape), so the mounts must carry it too; getting
// this wrong fails open, silently, into exactly the bug above.
app.use("/register-foodbank/", noStore);
app.use("/write/to/*", noStore);
for (const locale of LOCALES) {
  if (locale === "en") continue;
  app.use(`/${locale}/register-foodbank/`, noStore);
}

// Media routes are registered at givefood/urls.py:14 -> gfwfbn/urls/generic.py,
// OUTSIDE i18n_patterns -- one URL each, never language-prefixed. This is
// the one route group fully built out in this pass; see PLAN.md §3.7.
app.route("/needs", mediaApp);

// img/ar/** and img/appscreenshots/** -- everything else under /static/* is
// served by Workers Static Assets (asset-first, never reaches this Worker);
// only these two excluded families fall through to here. See PLAN.md WP 1.6.
app.route("/static", staticMediaApp);

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
// The same index/docs pull-out above applies to the bare /api/ dual-mount
// too (givefood/urls.py:96's `path('api/', include('gfapi2.urls'))` is a
// second, unnamespaced include of the exact same urlconf as /api/2/'s --
// index and docs are both defined ON that urlconf, gfapi2/urls.py:7-8, so
// both are live at the bare prefix in production, not just the versioned
// one). Missing until now -- these two lines were never added when the
// pull-out was done for /api/2/ itself; api2App's own data endpoints
// (foodbanks/, search/, etc.) were already correctly dual-mounted via the
// app.route() line above, only the two sub-app-root-matching pages were
// still falling through to the catch-all below.
app.get("/api/", api2Index);
app.get("/api/docs/", api2Docs);

// No /api catch-all. Every route gfapi1/gfapi2/gfapi3 register is covered
// above -- verified 2026-09-05 by probing /api/, /api/1/, /api/2/,
// /api/3/, /api/2/foodbanks/ and /api/2/needs/ against beta, all 200 --
// so the "defensive fallback" that used to sit here only ever caught URLs
// that do not exist, and answered 501 where 404 is the truthful answer.
// Unmatched /api/* now reaches app.notFound() like everything else.

// gfwfbn `index` -- i18n-patterned (givefood/urls.py:47, inside
// i18n_patterns), so it's registered once bare (English, no prefix) and
// once per other supported language (§2.7.1: cy/ga/gd, not Django's full
// 21) -- matching prefix_default_language=False exactly, same as
// resolveLanguage.ts's own PREFIXES set (derived from the same LOCALES).
app.get("/needs/", wfbnIndex);
app.get("/needs/at/:slug/", wfbnFoodbank);
app.get("/needs/at/:slug/nearby/", wfbnFoodbankNearby);
app.get("/needs/rss.xml", wfbnRss);
app.get("/needs/at/:slug/rss.xml", wfbnFoodbankRss);
app.get("/needs/getlocation/", wfbnGetLocation);
app.get("/needs/at/:slug/locations/", wfbnFoodbankLocations);
app.get("/needs/at/:slug/donationpoints/", wfbnFoodbankDonationpoints);
app.get("/needs/at/:slug/donationpoint/:dpslug/", wfbnFoodbankDonationpoint);
app.get("/needs/at/:slug/donationpoint/:dpslug/openinghours/", wfbnFoodbankDonationpointOpeninghours);
app.get("/needs/at/:slug/news/", wfbnFoodbankNews);
app.get("/needs/at/:slug/charity/", wfbnFoodbankCharity);
app.get("/needs/geo.json", wfbnGeojson);
app.get("/needs/at/:slug/geo.json", wfbnFoodbankGeojson);
app.get("/needs/at/:slug/:locslug/geo.json", wfbnFoodbankLocationGeojson);
app.get("/needs/in/constituency/:parlconSlug/geo.json", wfbnConstituencyGeojson);
app.get("/needs/in/constituencies/", wfbnConstituencies);
// gfwfbn/urls/i18n.py:44 -- a bare, slug-less RedirectView back to the
// plural index (an old/hand-typed singular URL), not a page of its own.
app.get("/needs/in/constituency/", (c) => c.redirect("/needs/in/constituencies/", 302));
// gfwfbn/urls/i18n.py:14 -- RedirectView to the ROOT manifest, and the one
// place in this file that is a 301 rather than a 302, because it is the
// one that passes permanent=True. Nothing generates this URL: both
// page.html and page.njk resolve the manifest by NAME
// ({% url 'manifest' %} / url('manifest')), which gives the absolute
// /manifest.json, so no browser follows a relative path into it. Ported
// anyway rather than 404'd because it costs a line and a PWA installed
// against the old URL would still be asking for it.
//
// Target is /manifest.json unprefixed even from the locale variants
// below: Django's url= is the literal string '/manifest.json', and
// RedirectView does no locale-aware reversing on it.
app.get("/needs/manifest.json", (c) => c.redirect("/manifest.json", 301));
// gfwfbn/urls/i18n.py:8 -- RedirectView to the gfdash page that now holds
// this data (gfdash/urls.py:15, ported and serving). 302, not 301: no
// permanent=True, unlike the manifest one directly above. Same literal
// unprefixed url= too, so the locale variants below also land on the
// unprefixed /dashboard/ path.
app.get("/needs/tt-old-data/", (c) => c.redirect("/dashboard/trusselltrust/old-data/", 302));
app.get("/needs/in/constituency/:slug/mp_photo_threefour.png", wfbnMpPhotoRedirect);
app.get("/needs/in/constituency/:slug/", wfbnConstituency);
// :locslug is a generic catch-all at the same path depth as every literal
// sibling above (locations/, donationpoints/, news/, charity/, nearby/,
// updates/:action/) -- Hono's router prefers a literal segment over a
// :param one at the same tree level regardless of registration order
// (already relied on by those existing routes), so this must still be
// registered after them for the same reason gfwfbn/urls/i18n.py lists
// foodbank_location dead last.
app.get("/needs/at/:slug/:locslug/", wfbnFoodbankLocation);
// gfwfbn `place` (at/place/<county>/<place>/, i18n-patterned) -- PERMANENTLY
// out of scope, not deferred: maintainer decision 2026-08-31. This is
// narrower than an earlier version of this comment implied -- confirmed
// with the maintainer 2026-09-01: only this standalone browse-by-place
// PAGE is dropped (no FK from anything else in the schema references it,
// and sitemap_places*.xml is separately, also confirmed out of scope).
// The underlying Place gazetteer DATA is NOT out of scope -- /aac/ (§4.8.6)
// still needs it migrated to D1 for its place-name search half; see
// routes/public/aac.ts. A real 404 here, not a 501 -- this
// isn't "not built yet", it's "never coming". Registered ahead of the
// generic /needs catch-all below purely so it doesn't inherit that
// placeholder's misleading "not ported yet" text; Hono resolves this by
// literal-segment-count, same as every other static-vs-:param
// disambiguation in this file.
app.get("/needs/at/place/:county/:place/", (c) => c.notFound());
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
  app.get(`/${locale}/needs/rss.xml`, wfbnRss);
  app.get(`/${locale}/needs/at/:slug/rss.xml`, wfbnFoodbankRss);
  app.get(`/${locale}/needs/getlocation/`, wfbnGetLocation);
  app.get(`/${locale}/needs/manifest.json`, (c) => c.redirect("/manifest.json", 301));
  app.get(`/${locale}/needs/tt-old-data/`, (c) => c.redirect("/dashboard/trusselltrust/old-data/", 302));
  app.get(`/${locale}/needs/at/:slug/locations/`, wfbnFoodbankLocations);
  app.get(`/${locale}/needs/at/:slug/donationpoints/`, wfbnFoodbankDonationpoints);
  app.get(`/${locale}/needs/at/:slug/donationpoint/:dpslug/`, wfbnFoodbankDonationpoint);
  app.get(`/${locale}/needs/at/:slug/donationpoint/:dpslug/openinghours/`, wfbnFoodbankDonationpointOpeninghours);
  app.get(`/${locale}/needs/at/:slug/news/`, wfbnFoodbankNews);
  app.get(`/${locale}/needs/at/:slug/charity/`, wfbnFoodbankCharity);
  app.get(`/${locale}/needs/geo.json`, wfbnGeojson);
  app.get(`/${locale}/needs/at/:slug/geo.json`, wfbnFoodbankGeojson);
  app.get(`/${locale}/needs/at/:slug/:locslug/geo.json`, wfbnFoodbankLocationGeojson);
  app.get(`/${locale}/needs/in/constituency/:parlconSlug/geo.json`, wfbnConstituencyGeojson);
  app.get(`/${locale}/needs/in/constituencies/`, wfbnConstituencies);
  app.get(`/${locale}/needs/in/constituency/`, (c) => c.redirect(`/${locale}/needs/in/constituencies/`, 302));
  app.get(`/${locale}/needs/in/constituency/:slug/mp_photo_threefour.png`, wfbnMpPhotoRedirect);
  app.get(`/${locale}/needs/in/constituency/:slug/`, wfbnConstituency);
  app.get(`/${locale}/needs/at/:slug/updates/:action{subscribe|confirm|unsubscribe}/`, wfbnFoodbankUpdates);
  app.post(`/${locale}/needs/at/:slug/updates/:action{subscribe|confirm|unsubscribe}/`, wfbnFoodbankUpdates);
  app.get(`/${locale}/needs/at/:slug/:locslug/`, wfbnFoodbankLocation);
  app.get(`/${locale}/needs/at/place/:county/:place/`, (c) => c.notFound());
}

// gfwfbn `wfbn-generic` -- registered before i18n_patterns in
// givefood/urls.py (§6.1.1), so these never carry a language prefix
// regardless of the current page's language. webpush_subscribe/
// webpush_unsubscribe have no @require_POST in Django either (the view
// checks request.method by hand and returns 400, not 404, for the wrong
// method) -- app.all() reproduces that, where app.post() would make Hono
// itself 404 a non-POST request instead.
app.post("/needs/at/:slug/hit/", wfbnFoodbankHit);
app.get("/needs/at/:slug/favicon.png", wfbnFoodbankFavicon);
// gfwfbn/urls/generic.py:14 -- the five page names are in the URL pattern
// there, so they are in the route here too rather than validated later.
// THE WHOLE SEGMENT IS THE PARAM, ".png" included. Hono matches a param
// against an entire path segment, so `:page{...}.png` -- a param followed
// by literal text in the same segment -- never fires and the route 404s
// silently. Same trap the sitemap_places patterns hit; the handler strips
// the extension.
app.get("/needs/at/:slug/screenshots/:page{(?:homepage|shoppinglist|donationpoints|contacts|locations)\\.png}", wfbnFoodbankScreenshot);
app.get("/needs/at/:slug/donationpoint/:dpslug/favicon.png", wfbnFoodbankDonationpointFavicon);
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
// i18n_patterns). @require_POST in Django (views.py:1072) -- POST only.
//
// app.all + an explicit 405, not app.post: registering POST alone leaves
// Hono answering a GET with whatever the fallthrough is (a 404, or worse
// a 501 while the not-ported catch-all still existed), where @require_POST
// answers 405. Same shape whatsappHook.ts:58 uses for the same reason.
const humanMethodGate = async (c: Context<AppEnv>) =>
  c.req.method === "POST" ? humanRelay(c) : new Response(null, { status: 405 });
app.all("/human/", humanMethodGate);
for (const locale of LOCALES) {
  if (locale === "en") continue;
  app.all(`/${locale}/human/`, humanMethodGate);
}

// WP 4.1: the givefood root app's content pages -- all i18n-patterned
// (givefood/urls.py's "Translated pages" block) except services/privacy,
// which sit in the "Untranslated pages" block and so get no locale loop.
app.get("/about-us/", publicAboutUs);
app.get("/apps/", publicApps);
app.get("/bot/", publicBot);
app.get("/donate/", publicDonate);
app.get("/news/", publicNews);
app.get("/services/", publicServices);
app.get("/privacy/", publicPrivacy);
app.get("/aac/", addressAutocomplete);
// Ticket 8: the speculative half of the autocomplete -- results for the
// typed prefix plus each possible next character, so the next keystroke
// renders with no round trip. Separate from /aac/ on purpose; see the
// handler for why bundling them would slow down the request that matters.
app.get("/aac/next/", addressAutocompleteNext);
app.get("/annual-reports/", annualReportIndex);
for (const locale of LOCALES) {
  if (locale === "en") continue;
  app.get(`/${locale}/about-us/`, publicAboutUs);
  app.get(`/${locale}/apps/`, publicApps);
  app.get(`/${locale}/bot/`, publicBot);
  app.get(`/${locale}/donate/`, publicDonate);
  app.get(`/${locale}/news/`, publicNews);
  app.get(`/${locale}/annual-reports/`, annualReportIndex);
}

// WP 4.7: register_foodbank/flag (givefood/urls.py:22,30, both inside
// i18n_patterns). One handler per route for both GET (render) and POST
// (process, reached only via the POST /human/ relay's auto-submit) --
// matching Django's own single-view-both-methods shape.
app.get("/register-foodbank/", publicRegisterFoodbank);
app.post("/register-foodbank/", publicRegisterFoodbank);
app.get("/flag/", publicFlag);
app.post("/flag/", publicFlag);
for (const locale of LOCALES) {
  if (locale === "en") continue;
  app.get(`/${locale}/register-foodbank/`, publicRegisterFoodbank);
  app.post(`/${locale}/register-foodbank/`, publicRegisterFoodbank);
  app.get(`/${locale}/flag/`, publicFlag);
  app.post(`/${locale}/flag/`, publicFlag);
}

// givefood `country`/`country_geojson` and `annual_report` -- both single
// dynamic path segments off the root, registered AFTER every static
// single-segment page above (matching givefood/urls.py's own comment,
// "Country pages -- must be before generic slug patterns", i.e. relative
// order matters in Django's sequential regex matching; Hono's router
// prioritises static segments over param ones at the same tree level
// regardless of order, but this keeps the two in visible agreement).
// :year is regex-constrained to the same fixed year alternation Django's
// own re_path uses -- "the only guard against template-path injection" in
// the original app; annualReport()'s own template lookup is a second,
// belt-and-braces guard.
app.get("/:countrySlug{scotland|england|wales|northern-ireland}/", publicCountry);
app.get("/:countrySlug{scotland|england|wales|northern-ireland}/geo.json", publicCountryGeojson);
app.get("/:year{2019|2020|2021|2022|2023|2024|2025}/", annualReport);
for (const locale of LOCALES) {
  if (locale === "en") continue;
  app.get(`/${locale}/:countrySlug{scotland|england|wales|northern-ireland}/`, publicCountry);
  app.get(`/${locale}/:countrySlug{scotland|england|wales|northern-ireland}/geo.json`, publicCountryGeojson);
  app.get(`/${locale}/:year{2019|2020|2021|2022|2023|2024|2025}/`, annualReport);
}

// WP 4.2. robots.txt/manifest.json/sitemap.xml are i18n-patterned in
// Django (givefood/urls.py:51-53) but none of their handlers actually
// vary by the requesting locale except manifest.json's lang/description
// and sitemap.xml's <loc> prefixes -- registered under all 4 locale
// prefixes regardless, matching Django's own routing exactly.
app.get("/robots.txt", robotsTxt);
app.get("/manifest.json", manifestJson);
app.get("/sitemap.xml", sitemapXml);
for (const locale of LOCALES) {
  if (locale === "en") continue;
  app.get(`/${locale}/robots.txt`, robotsTxt);
  app.get(`/${locale}/manifest.json`, manifestJson);
  app.get(`/${locale}/sitemap.xml`, sitemapXml);
}
// Untranslated (givefood/urls.py's "Untranslated pages" block) -- no
// locale loop. sitemap_places_index.xml/sitemap_places*.xml,
// sitemap_external.xml, and firebase-messaging-sw.js are deliberately NOT
// built: sitemap_external.xml and sitemap_places* per explicit maintainer
// decisions (not needed -- see robots.ts's own comment on the latter, and
// the /needs/at/place/ registration above for the page they'd advertise);
// firebase-messaging-sw.js because it's confirmed dead -- no client
// anywhere registers it, only /sw.js is, and that's served as a real
// static file at dist/static/sw.js instead of a Worker route, per
// PLAN.md's own recommendation since its content is 100% static.
app.get("/llms.txt", llmsTxt);
app.get("/.well-known/security.txt", securityTxt);

// WP 4.8: givefood/urls.py:70, in the same untranslated block as the two
// lines above -- no locale loop. GET/POST both reach whatsappHook, which
// branches on method itself (matching Django's own GET/POST/405 shape in
// one view) -- app.all so any other method reaches that same 405 branch
// too, rather than a bare Hono 404.
app.all("/whatsapp_hook/", whatsappHook);

// WP 4.4: givefood/urls.py:27, inside i18n_patterns. :frag is
// regex-constrained to the exact 4-value whitelist -- Django's own
// `if frag not in allowed_frags: raise Http404()` becomes a plain 404 for
// any other value via this route simply not matching, same convention as
// every other constrained path segment in this file.
app.get("/frag/:frag{ip-address|last-updated|need-hits|news}/", frag);
for (const locale of LOCALES) {
  if (locale === "en") continue;
  app.get(`/${locale}/frag/:frag{ip-address|last-updated|need-hits|news}/`, frag);
}

// WP 4.3: the "/md/" markdown mirror -- givefood/urls.py's "Markdown
// versions" block, entirely outside i18n_patterns (no locale loop, same
// as llms.txt/security.txt above). Registered in the same relative order
// as gfwfbn/urls/md.py itself: every literal-segment sub-page before the
// generic :locslug catch-all, so news/charity/nearby/etc. aren't captured
// by it.
app.get("/md/", mdIndex);
app.get("/md/sitemap.xml", mdSitemapXml);
app.get("/md/sitemap.md", mdSitemapMd);
app.get("/md/needs/at/:slug/", mdFoodbank);
app.get("/md/needs/at/:slug/locations/", mdFoodbankLocations);
app.get("/md/needs/at/:slug/donationpoints/", mdFoodbankDonationpoints);
app.get("/md/needs/at/:slug/donationpoint/:dpslug/", mdFoodbankDonationpoint);
app.get("/md/needs/at/:slug/news/", mdFoodbankNews);
app.get("/md/needs/at/:slug/charity/", mdFoodbankCharity);
app.get("/md/needs/at/:slug/nearby/", mdFoodbankNearby);
app.get("/md/needs/at/:slug/:locslug/", mdFoodbankLocation);

// gfdash (WP 4.5) -- entirely outside Django's i18n_patterns
// (givefood/urls.py's "Untranslated apps" block, same as /needs/), so no
// locale loop, matching gfdash/urls.py exactly.
app.get("/dashboard/", gfdashIndex);
app.get("/dashboard/items-requested-weekly/", gfdashWeeklyItemcount);
app.get("/dashboard/items-requested-weekly/by-year/", gfdashWeeklyItemcountYear);
app.get("/dashboard/most-requested-items/", gfdashMostRequestedItems);
app.get("/dashboard/most-excess-items/", gfdashMostExcessItems);
app.get("/dashboard/item-categories/", gfdashItemCategories);
app.get("/dashboard/item-groups/", gfdashItemGroups);
app.get("/dashboard/trusselltrust/old-data/", gfdashTtOldData);
app.get("/dashboard/trusselltrust/most-requested-items/", gfdashTtMostRequestedItems);
app.get("/dashboard/articles/", gfdashArticles);
app.get("/dashboard/beautybanks/", gfdashBeautybanks);
app.get("/dashboard/excess/", gfdashExcess);
app.get("/dashboard/foodbanks-found/", gfdashFoodbanksFound);
app.get("/dashboard/bean-pasta-index/", gfdashBeanPastaIndex);
app.get("/dashboard/deliveries/:metric/", gfdashDeliveries);
app.get("/dashboard/donationpoints/supermarkets/", gfdashSupermarkets);
app.get("/dashboard/charity-income-expenditure/", gfdashCharityIncomeExpenditure);
app.get("/dashboard/price-per/kg/", gfdashPricePerKg);
app.get("/dashboard/heatmap/", gfdashHeatmap);
app.get("/dashboard/price-per/calorie/", gfdashPricePerCalorie);
app.get("/dashboard/price-per/item-category/", gfdashPricePerItemCategory);
// gfdash/urls.py's old-URL redirect: RedirectView.as_view(url='/dashboard/price-per/kg/', permanent=True).
app.get("/dashboard/price-per-kg/", (c) => c.redirect("/dashboard/price-per/kg/", 301));

// gfwrite (WP 4.6) -- entirely outside i18n_patterns, same as gfdash, so
// no locale loop, matching gfwrite/urls.py exactly.
app.get("/write/", writeIndex);
app.get("/write/to-by-code/:pcon24cd/", writeConstituencyByCode); // no Django equivalent -- PLAN.md §6.9 R7, see routes/write/index.ts's own comment
app.get("/write/to/:slug/", writeConstituency);
app.all("/write/to/:slug/email/", writeEmail); // writeEmail itself 404s anything but POST, matching Django's HttpResponseNotFound()
app.all("/write/to/:slug/email/send/", writeSend); // writeSend itself 405s anything but POST (R5)
app.get("/write/to/:slug/email/done/", writeDone);

// givefood/urls.py:78,81 -- two bare RedirectViews. 302, not 301: neither
// passes permanent=True, and RedirectView.permanent has defaulted to False
// since Django 1.9. (The 301 at /dashboard/price-per-kg/ above is a
// permanent one, hence the difference.) The Rick Astley target is
// givefood/const/general.py:147's RICK_ASTLEY, inlined rather than given a
// consts module of its own for a single use.
app.get("/what-food-banks-need/", (c) => c.redirect("/needs/", 302));
app.get("/wp-login.php", (c) => c.redirect("https://www.youtube.com/watch?v=dQw4w9WgXcQ", 302));

// OUT OF SCOPE -- 404, not 501, for the same reason /needs/at/place/ and
// /dumps are: nothing is coming, so "not implemented" would be a standing
// lie to every crawler that asks.
//
// The places sitemaps go with the browse-by-place page they index (see
// that route's comment above: maintainer decision 2026-08-31, confirmed
// 2026-09-01, which named sitemap_places*.xml as separately out of scope
// too). PLAN.md §Q6 is the sizing behind it -- 5.58M URLs. The external
// sitemap is a maintainer decision 2026-09-05. The place gazetteer DATA
// stays either way: 253,584 rows plus the place_fts index, feeding /aac/.
// /colophon/ was here. Removed 2026-09-05, maintainer decision -- the page
// itself, its route, its template, its entry in the footer nav and in
// /llms.txt. Django still has it (views.py:987-1008); this port does not,
// which is a deliberate content decision rather than an unported gap, so it
// is NOT in OUT_OF_SCOPE below -- there is nothing to answer for the path
// that app.notFound() does not already answer.
const OUT_OF_SCOPE = [
  // A dev scratch page (givefood/urls.py:75 -> views.maplibre_test), never
  // part of the public site. Dropped rather than ported, maintainer
  // decision 2026-09-05. Listed rather than just left to fall through so
  // the next person to diff this file against Django's urls.py sees a
  // decision instead of an oversight -- which is the whole reason this
  // block exists. Worth deleting its Django view and template too.
  "/tests/maplibre/",
  // givefood/urls.py:68 -> views.service_worker. Dead in Django, not just
  // unported -- re-verified 2026-09-05 before dropping it: the only
  // serviceWorker.register() call in either repo is for /sw.js
  // (givefood/static/js/webpush.js:111), nothing anywhere references
  // firebase-messaging-sw.js, and there is no client-side Firebase
  // messaging code at all (no getMessaging, no firebase.messaging). The
  // site moved from Firebase push to VAPID -- Django's own
  // vapid_service_worker docstring says so ("This replaces Firebase-based
  // web push with standard Web Push API") -- and this view is what was
  // left behind. /sw.js, the one actually registered, is ported and served
  // static from dist/static/sw.js. Porting this would have meant six
  // Firebase web-config values for a file no browser requests.
  "/firebase-messaging-sw.js",
  "/sitemap_external.xml",
  "/sitemap_places.xml",
  "/sitemap_places_index.xml",
  // Whole-segment param: Hono will not match a param with literal text
  // around it inside one segment, so "/sitemap_places_:page{[0-9]+}.xml"
  // silently never fires -- prefix and extension both belong in the regex.
  // (A param in a LATER segment is fine: /:countrySlug{...}/geo.json.)
  "/:sitemapPage{sitemap_places_[0-9]+\\.xml}",
];
for (const path of OUT_OF_SCOPE) app.all(path, (c) => c.notFound());

// NOTHING IS 501 ANY MORE. There was a NOT_PORTED list here, and before
// that three catch-all mounts over /needs, /api and / that answered 501 to
// anything unmatched. As of 2026-09-05 every public URL in Django's own
// patterns (givefood/urls.py, gfwfbn/urls/{generic,i18n}.py,
// gfdash/urls.py) is either ported, or deliberately out of scope and 404s
// in the block above. The catch-alls had been overstating the gap badly:
// gfdash, /frag/ and all three API versions were fully ported the whole
// time, and what the mounts were really catching was *invalid* paths under
// those prefixes, reported as "unbuilt".
//
// routes/notPortedYet.ts still holds notPortedPath()/notPortedSubtree()
// for the next gap that appears -- use them rather than a catch-all, and
// only for a URL that genuinely exists in Django and is genuinely coming.
// Anything else belongs in OUT_OF_SCOPE above (404) or nowhere at all.
// gfdumps -- PERMANENTLY out of scope, not deferred: maintainer decision
// 2026-09-02 (WP 5.6's Container-based dump-generation cron, and the
// R2-served download/listing pages that depended on it, were dropped
// entirely rather than built -- see PLAN.md §8.8's own note on this
// decision). A real 404 for the whole subtree, not a 501 -- this isn't
// "not built yet", it's "never coming". A `.route()` + catch-everything
// sub-app (matching the bare mount path too, not just subpaths) rather
// than a path list, because the whole subtree is gone, not named parts
// of it -- notPortedSubtree()'s shape, returning 404 instead of 501.
app.route("/dumps", gone());
// gfauth (WP 6.1/6.2) -- kept at its exact 3 URLs (receiver in particular
// is a registered Google redirect URI) but implemented under
// routes/admin/, not as a standalone feature; see that file's own comment.
app.get("/auth/", adminSignIn);
app.get("/auth/start/", adminAuthStart);
app.get("/auth/receiver/", adminAuthReceiver);
app.get("/auth/sign-out/", adminSignOut);
app.get("/admin/", adminIndex); // same bare-mount-point quirk as api2Index/api2Docs above -- see routes/admin/index.ts's own comment
app.route("/admin", adminApp);
// No `app.route("/", ...)` catch-all any more -- that single line was what
// turned every genuinely-nonexistent URL on the site into a 501. Unmatched
// requests now fall through to app.notFound() directly below.

// PLAN.md §3.5 "APPEND_SLASH". No platform equivalent -- Workers Static
// Assets' force-trailing-slash only affects ASSET lookups, not the 3,000+
// food bank URLs that actually need this. The redirect check itself lives
// in lib/appendSlash.ts. This is now its ONLY caller: the catch-all
// mounts that also needed it (givefood/givefood2#3 -- an app.all("*")
// shadowed real routes requested without their trailing slash, so it had
// to probe for a slashed variant itself) are gone, so nothing shadows
// this handler any more and the redirect check lives in one place again.
app.notFound(async (c) => {
  const redirect = await tryAppendSlashRedirect(c, app);
  if (redirect) return redirect;
  return c.html(await render404(c), 404);
});

// Django's default 500.html (DEBUG=False) -- no equivalent existed here
// before WP 4.1 (an uncaught exception previously produced Hono's own bare
// default error response).
app.onError(async (err, c) => {
  console.error(err);
  return c.html(await render500(c), 500);
});

export default app;
