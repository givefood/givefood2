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
import { wfbnWebpushConfig, wfbnWebpushSubscribe, wfbnWebpushUnsubscribe } from "./routes/wfbn/webpush";
import { wfbnMobsub, wfbnDeleteMobsub } from "./routes/wfbn/mobsub";
import { humanRelay } from "./routes/human";
import { whatsappHook } from "./routes/whatsappHook";
import { publicIndex } from "./routes/public";
import { publicAboutUs, publicApps, publicBot } from "./routes/public/contentPages";
import { publicColophon } from "./routes/public/colophon";
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
import { addressAutocomplete } from "./routes/public/aac";
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
import { notPortedYet } from "./routes/notPortedYet";
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

// Genuinely unmatched /api/* paths -- nothing should reach this now that
// the above covers every route gfapi2/gfapi1/gfapi3 actually register,
// but kept as a defensive fallback rather than a bare 404.
app.route("/api", notPortedYet("unmatched /api/* path"));

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
// routes/public/aac.ts. A real 404 here, not notPortedYet's 501 -- this
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
// i18n_patterns). @require_POST in Django -- POST only.
app.post("/human/", humanRelay);
for (const locale of LOCALES) {
  if (locale === "en") continue;
  app.post(`/${locale}/human/`, humanRelay);
}

// WP 4.1: the givefood root app's content pages -- all i18n-patterned
// (givefood/urls.py's "Translated pages" block) except services/privacy,
// which sit in the "Untranslated pages" block and so get no locale loop.
app.get("/about-us/", publicAboutUs);
app.get("/apps/", publicApps);
app.get("/bot/", publicBot);
app.get("/colophon/", publicColophon);
app.get("/donate/", publicDonate);
app.get("/news/", publicNews);
app.get("/services/", publicServices);
app.get("/privacy/", publicPrivacy);
app.get("/aac/", addressAutocomplete);
app.get("/annual-reports/", annualReportIndex);
for (const locale of LOCALES) {
  if (locale === "en") continue;
  app.get(`/${locale}/about-us/`, publicAboutUs);
  app.get(`/${locale}/apps/`, publicApps);
  app.get(`/${locale}/bot/`, publicBot);
  app.get(`/${locale}/colophon/`, publicColophon);
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

// Everything below is specified in PLAN.md but not yet built. Each returns
// 501 so the gap is loud during development. Build order follows PLAN.md
// §10's phases: wfbn (translated pages) and the APIs next, admin last.
app.route("/needs", notPortedYet("gfwfbn (translated pages)"));
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

// Django's default 500.html (DEBUG=False) -- no equivalent existed here
// before WP 4.1 (an uncaught exception previously produced Hono's own bare
// default error response).
app.onError(async (err, c) => {
  console.error(err);
  return c.html(await render500(c), 500);
});

export default app;
