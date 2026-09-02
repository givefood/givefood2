import { Hono } from "hono";
import type { Context } from "hono";
import { getOpenDiscrepancies, getPublishedNeeds, getUnpublishedNeeds, getRecentArticlesForAdmin, type FoodbankChangeRow } from "@givefood/db";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { requireAdminAuth } from "../../middleware/adminAuth";
import { getAdminSession } from "../../lib/adminAuth";
import { dbSession } from "../../lib/session";
import { inputMethodEmoji } from "../../lib/needAdminDisplay";
import { adminPageContext } from "./pageContext";
import { adminProxy } from "./proxy";
import { adminNeedDetail, adminNeedPublish, adminNeedUnpublish, adminNeedNonpertinent, adminNeedDelete, adminNeedsDeleteAll, adminNeedCategorise, adminNeedTranslations, adminNeedEditForm } from "./needs";
import { adminDiscrepancyDetail, adminDiscrepancyAction } from "./discrepancies";
import { adminFoodbankEdit, adminFoodbankPoliticsEdit, adminFoodbankPartialEdit, adminFoodbankNew, adminFoodbankDelete } from "./foodbank";
import { adminFoodbankUrlsEdit } from "./foodbankUrls";
import { adminFoodbankLocationForm, adminFoodbankLocationDelete } from "./foodbankLocation";
import { adminDonationPointForm, adminDonationPointDelete } from "./donationPoint";
import { adminParlconForm } from "./parlcon";
import { adminFoodbankDetail, adminFoodbankTab, adminFoodbankTouch } from "./foodbankDetail";
import { adminArticleToggleFeatured } from "./articles";
import { adminCrawlSetJson } from "./crawlSet";
import {
  adminFoodbanksList,
  adminFoodbanksCsv,
  adminLocationsList,
  adminDonationPointsList,
  adminParlconsList,
  adminParlconsCsv,
  adminOrdersList,
  adminOrdersCsv,
  adminNeedsCsv,
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
adminApp.get("/foodbank/new/", adminFoodbankNew);
adminApp.post("/foodbank/new/", adminFoodbankNew);
adminApp.post("/foodbank/:slug/delete/", adminFoodbankDelete);
adminApp.get("/foodbank/:slug/", adminFoodbankDetail);
adminApp.get("/foodbank/:slug/tab/:tab/", adminFoodbankTab);
adminApp.post("/foodbank/:slug/touch/", adminFoodbankTouch);
adminApp.get("/foodbank/:slug/edit/", adminFoodbankEdit);
adminApp.post("/foodbank/:slug/edit/", adminFoodbankEdit);
adminApp.get("/foodbank/:slug/politics/edit/", adminFoodbankPoliticsEdit);
adminApp.post("/foodbank/:slug/politics/edit/", adminFoodbankPoliticsEdit);
adminApp.get("/foodbank/:slug/edit/urls/", adminFoodbankUrlsEdit);
adminApp.post("/foodbank/:slug/edit/urls/", adminFoodbankUrlsEdit);
adminApp.get("/foodbank/:slug/edit/:form/", adminFoodbankPartialEdit);
adminApp.post("/foodbank/:slug/edit/:form/", adminFoodbankPartialEdit);

adminApp.get("/foodbank/:slug/location/new/", adminFoodbankLocationForm);
adminApp.post("/foodbank/:slug/location/new/", adminFoodbankLocationForm);
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
adminApp.get("/orders/csv/", adminOrdersCsv);

adminApp.get("/needs/csv/", adminNeedsCsv);

adminApp.post("/article/:id/toggle-featured/", adminArticleToggleFeatured);

// Hono route params: a regex constraint must cover the WHOLE remaining
// segment including any literal suffix (media.ts's `:page{.+\\.png}` is
// the established precedent) -- ".json" can't trail a `{regex}` block as
// separate literal text, so the id+suffix is captured together and split
// in the handler instead.
adminApp.get("/crawl-set/:idJson{[0-9]+\\.json}", adminCrawlSetJson);

function enrichNeedRow(row: FoodbankChangeRow): FoodbankChangeRow & { input_method_emoji: string } {
  return { ...row, input_method_emoji: inputMethodEmoji(row.input_method) };
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
  const [unpublishedNeeds, publishedNeeds, discrepancies, articles] = await Promise.all([
    getUnpublishedNeeds(db),
    getPublishedNeeds(db, 20),
    getOpenDiscrepancies(db, 20),
    getRecentArticlesForAdmin(db, 20),
  ]);

  const html = await render("admin/index.njk", {
    ...(await adminPageContext(c, "needs")),
    unpublished_needs: unpublishedNeeds.map(enrichNeedRow),
    published_needs: publishedNeeds.map(enrichNeedRow),
    discrepancies,
    articles,
  });
  return c.html(html);
}
