import { Hono } from "hono";
import type { Context } from "hono";
import { getOpenDiscrepancies, getPublishedNeedsForAdmin, getUnpublishedNeeds, getRecentArticlesForAdmin, getAdminDashboardStats, type AdminNeedRow, type DiscrepancyRow } from "@givefood/db";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { requireAdminAuth } from "../../middleware/adminAuth";
import { getAdminSession } from "../../lib/adminAuth";
import { dbSession } from "../../lib/session";
import { inputMethodEmoji } from "../../lib/needAdminDisplay";
import { titleCapitalised, urlWithRefFoodbank } from "../../lib/fields";
import { timesince } from "../../lib/timesince";
import { adminPageContext } from "./pageContext";
import { adminProxy } from "./proxy";
import { adminGmapProxy } from "./gmapProxy";
import { adminSettings } from "./settings";
import { adminNeedDetail, adminNeedPublish, adminNeedUnpublish, adminNeedNonpertinent, adminNeedDelete, adminNeedsDeleteAll, adminNeedCategorise, adminNeedTranslations, adminNeedEditForm } from "./needs";
import { adminDiscrepancyDetail, adminDiscrepancyAction } from "./discrepancies";
import { adminFoodbankEdit, adminFoodbankPoliticsEdit, adminFoodbankPartialEdit, adminFoodbankNew, adminFoodbankDelete } from "./foodbank";
import { adminFoodbankUrlsEdit } from "./foodbankUrls";
import { adminFoodbankLocationForm, adminFoodbankLocationDelete } from "./foodbankLocation";
import { adminFoodbankLocationAreaForm } from "./foodbankLocationArea";
import { adminDonationPointForm, adminDonationPointDelete } from "./donationPoint";
import { adminParlconForm } from "./parlcon";
import { adminFoodbankDetail, adminFoodbankTab, adminFoodbankTouch } from "./foodbankDetail";
import { adminArticleToggleFeatured } from "./articles";
import { adminCrawlSetJson } from "./crawlSet";
import { adminCrawlSetsList, adminCrawlSetDetail } from "./crawlSets";
import { adminFoodbankCheck, adminJobStatus } from "./foodbankCheck";
import { adminFoodbankUseAiDetail } from "./useAi";
import { adminQueryConsole } from "./query";
import { adminFoodbankForceCheck, adminFoodbankForceArticleCrawl, adminFoodbankForceCharityCrawl } from "./foodbankForceCrawl";
import { adminOrderDetail } from "./order";
import { adminSearch } from "./search";
import { adminQuarterStats, adminEditStats, adminOrderStats, adminSubscriberStats, adminSubscriberGraph, adminNeedStats } from "./stats";
import { adminItemsList, adminItemForm } from "./items";
import { adminOrderGroupsList, adminOrderGroupDetail, adminOrderGroupForm } from "./orderGroup";
import { adminSlugRedirectsList, adminSlugRedirectForm } from "./slugRedirect";
import { adminMap } from "./map";
import { adminClearCache } from "./clearCache";
import { adminOrderForm } from "./orderForm";
import { adminOrderSendNotification, adminOrderEmailPreview, adminOrderDelete } from "./orderActions";
import { adminNeedNew } from "./needNew";
import { adminNeedEmail } from "./needEmail";
import { adminFoodbanksDupePostcodes } from "./dupePostcodes";
import { adminFoodbankAddSub } from "./foodbankAddSub";
import { adminPhotoDelete } from "./photoDelete";
import {
  adminFoodbanksList,
  adminFoodbanksCsv,
  adminFoodbanksNext,
  adminLocationsList,
  adminDonationPointsList,
  adminParlconsList,
  adminParlconsCsv,
  adminOrdersList,
  adminOrdersCsv,
  adminNeedsCsv,
  adminPlacesList,
  adminSubscriptionsList,
  adminDeleteSubscription,
  adminFoodbanksWithoutNeedList,
  adminNeedsList,
} from "./lists";

// gfadmin (WP 6.1/6.2 scaffolding only -- the real index page, need-review
// queue etc. are WP 6.4+). `adminApp` is where every actual admin feature
// mounts as its own WP lands, gated once here by requireAdminAuth -- same
// shape as api2App (routes/api2/*). The bare index route is the one
// exception: same Hono quirk already documented for api2Index/api2Docs in
// index.ts (a mounted sub-app's own "" route doesn't match the bare mount
// prefix, verified directly -- a session-bearing request to /admin/ fell
// straight through to the site-wide catch-all instead of reaching
// adminApp.get("/", ...)) -- `adminIndex` below is exported for an
// explicit top-level registration instead, checking auth inline rather
// than going through adminApp's middleware chain.
//
// WP 6.3 (PLAN.md §10.2.7): `GET /admin/credential/<name>/`
// (gfadmin/views.py:2866, returns any secret as text/plain) is not ported
// at all -- secrets live in Cloudflare Secrets Store / `wrangler secret`
// now, so there is no D1-backed credential value left for a view like that
// to leak. Nothing to delete here because nothing was ever built.
export const adminApp = new Hono<AppEnv>();

adminApp.use("*", requireAdminAuth);
adminApp.get("/proxy/", adminProxy);
// gfadmin/urls/core.py's re_path(r'^proxy/gmaps/(textsearch|placedetails)/$')
// -- the CORS shim admin.js's lookup buttons call. adminGmapProxy 404s any
// other :type, so the union is enforced in the handler rather than the route.
adminApp.get("/proxy/gmaps/:type/", adminGmapProxy);
adminApp.get("/settings/", adminSettings);

// gfadmin/urls/needs.py:10 need_form. MUST precede /need/:id/ below: Hono
// matches in registration order, so a later literal route loses to an earlier
// param one and /need/new/ would resolve as need id "new" (a 404). Django is
// insulated from this because its own /need/<uuid:id>/ converter rejects
// "new"; Hono's :id matches anything. Registered with and without the
// trailing slash because Django's URL uniquely omits it there, so both
// spellings are in circulation.
adminApp.get("/need/new/", adminNeedNew);
adminApp.post("/need/new/", adminNeedNew);
adminApp.get("/need/new", adminNeedNew);
adminApp.post("/need/new", adminNeedNew);
adminApp.get("/need/:id/", adminNeedDetail);
adminApp.post("/need/:id/publish/", adminNeedPublish);
adminApp.post("/need/:id/unpublish/", adminNeedUnpublish);
adminApp.post("/need/:id/nonpertinent/", adminNeedNonpertinent);
adminApp.post("/need/:id/delete/", adminNeedDelete);
adminApp.post("/needs/delete-all/", adminNeedsDeleteAll);
adminApp.get("/need/:id/categorise/", adminNeedCategorise);
adminApp.post("/need/:id/categorise/", adminNeedCategorise);
adminApp.get("/need/:id/translations/", adminNeedTranslations);

adminApp.get("/discrepancy/:id/", adminDiscrepancyDetail);
adminApp.post("/discrepancy/:id/action/", adminDiscrepancyAction);

adminApp.get("/need/:id/edit/", adminNeedEditForm);
adminApp.post("/need/:id/edit/", adminNeedEditForm);

// WP 6.5: Foodbank forms. /edit/:form/ is the 4 collapsed partials
// (address/phone/email/fsa-id -- lib/adminFormFields.ts's
// FOODBANK_PARTIAL_FORMS); /edit/urls/ stays its own route since it isn't
// one of the 4 (routes/admin/foodbankUrls.ts's own comment).
adminApp.get("/foodbanks/", adminFoodbanksList);
adminApp.get("/foodbanks/csv/", adminFoodbanksCsv);
adminApp.get("/foodbanks/next/", adminFoodbanksNext);
adminApp.get("/foodbank/new/", adminFoodbankNew);
adminApp.post("/foodbank/new/", adminFoodbankNew);
adminApp.post("/foodbank/:slug/delete/", adminFoodbankDelete);
adminApp.get("/foodbank/:slug/", adminFoodbankDetail);
adminApp.get("/foodbank/:slug/tab/:tab/", adminFoodbankTab);
adminApp.post("/foodbank/:slug/touch/", adminFoodbankTouch);
adminApp.post("/foodbank/:slug/needcheck/", adminFoodbankForceCheck);
adminApp.post("/foodbank/:slug/crawl/", adminFoodbankForceArticleCrawl);
adminApp.post("/foodbank/:slug/charity-crawl/", adminFoodbankForceCharityCrawl);
adminApp.get("/foodbank/:slug/edit/", adminFoodbankEdit);
adminApp.post("/foodbank/:slug/edit/", adminFoodbankEdit);
adminApp.get("/foodbank/:slug/politics/edit/", adminFoodbankPoliticsEdit);
adminApp.post("/foodbank/:slug/politics/edit/", adminFoodbankPoliticsEdit);
adminApp.get("/foodbank/:slug/edit/urls/", adminFoodbankUrlsEdit);
adminApp.post("/foodbank/:slug/edit/urls/", adminFoodbankUrlsEdit);
adminApp.get("/foodbank/:slug/edit/:form/", adminFoodbankPartialEdit);
adminApp.post("/foodbank/:slug/edit/:form/", adminFoodbankPartialEdit);

// WP 6.8: enqueue-and-poll check flow.
adminApp.get("/foodbank/:slug/check/", adminFoodbankCheck);
adminApp.post("/foodbank/:slug/check/", adminFoodbankCheck);
adminApp.post("/foodbank/:slug/use-ai/:field/", adminFoodbankUseAiDetail);

adminApp.get("/foodbank/:slug/location/new/", adminFoodbankLocationForm);
adminApp.post("/foodbank/:slug/location/new/", adminFoodbankLocationForm);
adminApp.get("/foodbank/:slug/location/new/area/", adminFoodbankLocationAreaForm);
adminApp.post("/foodbank/:slug/location/new/area/", adminFoodbankLocationAreaForm);
adminApp.get("/foodbank/:slug/location/:locSlug/edit/", adminFoodbankLocationForm);
adminApp.post("/foodbank/:slug/location/:locSlug/edit/", adminFoodbankLocationForm);
adminApp.post("/foodbank/:slug/location/:locSlug/delete/", adminFoodbankLocationDelete);

adminApp.get("/foodbank/:slug/donationpoint/new/", adminDonationPointForm);
adminApp.post("/foodbank/:slug/donationpoint/new/", adminDonationPointForm);
adminApp.get("/foodbank/:slug/donationpoint/:dpSlug/edit/", adminDonationPointForm);
adminApp.post("/foodbank/:slug/donationpoint/:dpSlug/edit/", adminDonationPointForm);
adminApp.post("/foodbank/:slug/donationpoint/:dpSlug/delete/", adminDonationPointDelete);

adminApp.get("/locations/", adminLocationsList);
adminApp.get("/donationpoints/", adminDonationPointsList);

adminApp.get("/parlcon/new/", adminParlconForm);
adminApp.post("/parlcon/new/", adminParlconForm);
adminApp.get("/parlcon/:slug/edit/", adminParlconForm);
adminApp.post("/parlcon/:slug/edit/", adminParlconForm);
adminApp.get("/politics/", adminParlconsList);
adminApp.get("/politics/csv/", adminParlconsCsv);

adminApp.get("/orders/", adminOrdersList);
// Same ordering rule as /need/new/ above -- the literal must come first or
// /order/new/ resolves as order id "new".
adminApp.get("/order/new/", adminOrderForm);
adminApp.post("/order/new/", adminOrderForm);
adminApp.get("/order/:orderId/", adminOrderDetail);
adminApp.get("/orders/csv/", adminOrdersCsv);

adminApp.get("/needs/csv/", adminNeedsCsv);

// WP 6.9: real SQL pagination for the two views PLAN.md names as a
// scaling risk, plus the DISTINCT ON -> ROW_NUMBER() rewrite.
adminApp.get("/places/", adminPlacesList);
adminApp.get("/subscriptions/", adminSubscriptionsList);
adminApp.post("/subscriptions/delete/", adminDeleteSubscription);
adminApp.get("/foodbanks/without_need/", adminFoodbanksWithoutNeedList);
adminApp.get("/needs/", adminNeedsList);
adminApp.get("/crawl-sets/", adminCrawlSetsList);
adminApp.get("/crawl-set/:id{[0-9]+}/", adminCrawlSetDetail);

// WP 6.10 (PLAN.md §8.13.1 Tier 3): the guarded query console -- the
// direct replacement for `manage.py shell` against live data. GET renders
// the empty form; POST is the only way a query actually runs (never via a
// URL query string, so a stray link/image-tag can't trigger one and raw
// SQL never lands in access logs).
adminApp.get("/query/", adminQueryConsole);
adminApp.post("/query/", adminQueryConsole);


// ---------------------------------------------------------------------
// gfadmin URLs that had no port at all until this fidelity pass.
// Grouped by the Django urls/ submodule each came from.
// ---------------------------------------------------------------------

// urls/core.py:15 search_results -- the navbar search box on every admin
// page (admin/page.njk). GET only, no mutation, no CSRF.
adminApp.get("/search/", adminSearch);
// urls/core.py:13 admin_map -- MapLibre against the existing public
// /needs/geo.json; no Google key of any kind (see routes/admin/map.ts).
adminApp.get("/map/", adminMap);
// urls/core.py:17 clearcache. POST-only here, unlike Django's plain <a href>
// GET -- a cache purge is a mutation and a prefetch shouldn't trigger one.
adminApp.post("/clearcache/", adminClearCache);

// urls/core.py:8-10 slug_redirects / slug_redirect_new / slug_redirect_form,
// plus one port-only route: the manual D1 -> KV blob rebuild. The literal
// /slug-redirect/new/ must precede /slug-redirect/:id/edit/ (Hono matches in
// registration order), same shape as the parlcon/location blocks above.
adminApp.get("/slug-redirects/", adminSlugRedirectsList);
adminApp.get("/slug-redirect/new/", adminSlugRedirectForm);
adminApp.post("/slug-redirect/new/", adminSlugRedirectForm);
adminApp.get("/slug-redirect/:id/edit/", adminSlugRedirectForm);
adminApp.post("/slug-redirect/:id/edit/", adminSlugRedirectForm);

// urls/stats.py:6-11 -- all six are read-only GETs, reached only from
// /admin/settings/.
adminApp.get("/stats/quarter/", adminQuarterStats);
adminApp.get("/stats/orders/", adminOrderStats);
adminApp.get("/stats/editing/", adminEditStats);
adminApp.get("/stats/subscribers/", adminSubscriberStats);
adminApp.get("/stats/subscribers/graph/", adminSubscriberGraph);
adminApp.get("/stats/needs/", adminNeedStats);

// urls/items.py -- the OrderItem list plus the shared new/edit form.
// No delete route: Django has none.
adminApp.get("/items/", adminItemsList);
adminApp.get("/item/new/", adminItemForm);
adminApp.post("/item/new/", adminItemForm);
adminApp.get("/item/:slug/edit/", adminItemForm);
adminApp.post("/item/:slug/edit/", adminItemForm);

// urls/orders.py:16-19 order groups.
adminApp.get("/order-groups/", adminOrderGroupsList);
adminApp.get("/order-groups/new/", adminOrderGroupForm);
adminApp.post("/order-groups/new/", adminOrderGroupForm);
adminApp.get("/order-group/:slug/", adminOrderGroupDetail);
adminApp.get("/order-group/:slug/edit/", adminOrderGroupForm);
adminApp.post("/order-group/:slug/edit/", adminOrderGroupForm);

// urls/orders.py:6-11 order create/edit/delete/notify/email. GET+POST
// /order/new/ is registered further up, immediately before the
// /order/:orderId/ detail route -- see the note there.
adminApp.get("/order/:orderId/edit/", adminOrderForm);
adminApp.post("/order/:orderId/edit/", adminOrderForm);
adminApp.get("/order/:orderId/email/", adminOrderEmailPreview);
adminApp.post("/order/:orderId/sendnotification/", adminOrderSendNotification);
adminApp.post("/order/:orderId/delete/", adminOrderDelete);

// urls/needs.py:10 need_form (creation) is registered further up, next to
// the /need/:id/ detail route -- see the note there.
adminApp.get("/need/:id/email/", adminNeedEmail);

// urls/foodbanks.py:8,24,37 -- the three small food-bank-scoped pages.
adminApp.get("/foodbanks/dupe_postcodes/", adminFoodbanksDupePostcodes);
adminApp.get("/foodbank/:slug/addsub/", adminFoodbankAddSub);
adminApp.post("/foodbank/:slug/addsub/", adminFoodbankAddSub);
adminApp.post("/foodbank/:slug/photo/:photoId/delete/", adminPhotoDelete);

adminApp.post("/article/:id/toggle-featured/", adminArticleToggleFeatured);

// Hono route params: a regex constraint must cover the WHOLE remaining
// segment including any literal suffix (media.ts's `:page{.+\\.png}` is
// the established precedent) -- ".json" can't trail a `{regex}` block as
// separate literal text, so the id+suffix is captured together and split
// in the handler instead.
adminApp.get("/crawl-set/:idJson{[0-9]+\\.json}", adminCrawlSetJson);

// WP 6.8 (PLAN.md §9.4.4): the generic admin_job poll endpoint -- kind-
// agnostic, any enqueued job type polls through here.
adminApp.get("/job/:id/", adminJobStatus);

function enrichNeedRow(row: AdminNeedRow, now: Date): AdminNeedRow & { input_method_emoji: string; timesince_ago: string } {
  return { ...row, input_method_emoji: inputMethodEmoji(row.input_method), timesince_ago: `${timesince(row.created, now)} ago` };
}

function enrichDiscrepancyRow(row: DiscrepancyRow, now: Date): DiscrepancyRow & { timesince_ago: string } {
  return { ...row, timesince_ago: `${timesince(row.created, now)} ago` };
}

// gfadmin/views.py:46-53 index() -- the real queue. Registered at the top
// level rather than inside adminApp (see this file's own top comment for
// why), so its own inline auth check also sets `adminUser` on the context
// itself -- adminPageContext() (and every downstream admin*.njk render)
// reads it from there, same as every route reached through adminApp's
// requireAdminAuth middleware does.
export async function adminIndex(c: Context<AppEnv>): Promise<Response> {
  const session = await getAdminSession(c);
  if (!session) return c.redirect(`/auth/?next=${encodeURIComponent(c.req.path)}`, 302);
  c.set("adminUser", session);

  const db = dbSession(c);
  const now = new Date();
  const [unpublishedNeeds, publishedNeeds, discrepancies, articles, stats] = await Promise.all([
    getUnpublishedNeeds(db),
    getPublishedNeedsForAdmin(db, 20),
    getOpenDiscrepancies(db, 20),
    getRecentArticlesForAdmin(db, 20),
    getAdminDashboardStats(db, now),
  ]);

  const html = await render("admin/index.njk", {
    // Django index() sets section "home" (gfadmin/views.py:106), a value
    // that deliberately matches NO nav item -- the dashboard is reached only
    // from the logo. Passing "needs" here lit the Needs tab, which now points
    // at /admin/needs/, a different page.
    ...(await adminPageContext(c, "home")),
    unpublished_needs: unpublishedNeeds.map((n) => enrichNeedRow(n, now)),
    published_needs: publishedNeeds.map((n) => enrichNeedRow(n, now)),
    discrepancies: discrepancies.map((d) => enrichDiscrepancyRow(d, now)),
    // admin/index.html:126 -- {{ article.title_captialised|truncatewords:10 }}
    // linked via {{ article.url_with_ref }} (givefood/models/articles.py:29-33,
    // :34-52). Both helpers were already ported in lib/fields.ts and applied on
    // every other article surface; the dashboard was the one that never used them.
    articles: articles.map((a) => ({ ...a, title_captialised: titleCapitalised(a.title), url_with_ref: urlWithRefFoodbank(a.url) })),
    stats: {
      oldest_edit: stats.oldestEdit,
      oldest_edit_timesince: stats.oldestEdit?.edited ? `${timesince(stats.oldestEdit.edited, now)} ago` : null,
      oldest_edit_days: stats.oldestEditDays,
      latest_edit: stats.latestEdit,
      latest_edit_timesince: stats.latestEdit?.edited ? `${timesince(stats.latestEdit.edited, now)} ago` : null,
      need_count_24h: stats.needCount24h,
      need_check_24h: stats.needCheck24h,
      article_check_24h: stats.articleCheck24h,
      charity_check_24h: stats.charityCheck24h,
      oldest_need_check: stats.oldestNeedCheck,
      oldest_need_check_timesince: stats.oldestNeedCheck?.last_need_check ? `${timesince(stats.oldestNeedCheck.last_need_check, now)} ago` : null,
      latest_need_check: stats.latestNeedCheck,
      latest_need_check_timesince: stats.latestNeedCheck?.last_need_check ? `${timesince(stats.latestNeedCheck.last_need_check, now)} ago` : null,
      latest_need_crawlset_id: stats.latestNeedCrawlSetId,
    },
  });
  return c.html(html);
}
