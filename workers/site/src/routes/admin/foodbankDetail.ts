import type { Context } from "hono";
import {
  getFoodbankBySlug,
  getLocationsByFoodbankId,
  getDonationPointsByFoodbankId,
  getNeedsForFoodbankTab,
  getOrdersForFoodbankTab,
  getArticlesForFoodbankTab,
  getSubscribersForFoodbankTab,
  getCrawlItemsForFoodbankTab,
  touchFoodbank,
} from "@givefood/db";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { verifyCsrf } from "../../lib/csrf";
import { adminPageContext } from "./pageContext";

const TAB_LIMIT = 20;

// gfadmin/views.py:579-638 foodbank() -- the tabbed detail page. Three
// panels render eagerly (general info, locations, latest need -- all
// toggled together under one "generallocations" class in Django, WP 6.7
// research); the rest are lazy `hx-get` fragments wired up exactly like
// need.njk's diff tabs (WP 6.4) already reuse tabber.js for.
export async function adminFoodbankDetail(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const foodbank = await getFoodbankBySlug(db, c.req.param("slug")!);
  if (!foodbank) return c.notFound();

  const [locations, hasArticles] = await Promise.all([getLocationsByFoodbankId(db, foodbank.id), getArticlesForFoodbankTab(db, foodbank.id, 1)]);

  const html = await render("admin/foodbank_detail.njk", {
    ...(await adminPageContext(c, "foodbanks")),
    foodbank,
    locations,
    counts: { articles: hasArticles.length > 0 },
  });
  return c.html(html);
}

// gfadmin/views.py:801-814 foodbank_tab -- one URL, one view, dispatched
// by an allowlist; unknown tab -> 404, matching Django exactly.
export async function adminFoodbankTab(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const slug = c.req.param("slug")!;
  const tab = c.req.param("tab")!;

  const foodbank = await getFoodbankBySlug(db, slug);
  if (!foodbank) return c.notFound();

  switch (tab) {
    case "needsorders": {
      const [needs, orders] = await Promise.all([getNeedsForFoodbankTab(db, foodbank.id, TAB_LIMIT), getOrdersForFoodbankTab(db, foodbank.id, TAB_LIMIT)]);
      return c.html(await render("admin/foodbank_tabs/needsorders.njk", { needs, orders }));
    }
    case "donationpoints": {
      const donationPoints = await getDonationPointsByFoodbankId(db, foodbank.id);
      return c.html(await render("admin/foodbank_tabs/donationpoints.njk", { donation_points: donationPoints, foodbank_slug: foodbank.slug }));
    }
    case "articles": {
      const articles = await getArticlesForFoodbankTab(db, foodbank.id, TAB_LIMIT);
      return c.html(await render("admin/foodbank_tabs/articles.njk", { articles }));
    }
    case "subscribers": {
      const subscribers = await getSubscribersForFoodbankTab(db, foodbank.id, TAB_LIMIT);
      return c.html(await render("admin/foodbank_tabs/subscribers.njk", { subscribers }));
    }
    case "crawls": {
      const crawlItems = await getCrawlItemsForFoodbankTab(db, foodbank.id, TAB_LIMIT);
      return c.html(await render("admin/foodbank_tabs/crawls.njk", { crawl_items: crawlItems }));
    }
    default:
      return c.notFound();
  }
}

// gfadmin/views.py:1300-1310 foodbank_touch, @require_POST. htmx ->
// literal disabled-button fragment; plain POST -> redirect to the
// foodbanks LIST (not back to the detail page -- matches Django exactly,
// confirmed test-pinned).
export async function adminFoodbankTouch(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const foodbank = await getFoodbankBySlug(db, c.req.param("slug")!);
  if (!foodbank) return c.notFound();

  const body = await c.req.parseBody();
  const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
  if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

  await touchFoodbank(db, foodbank.id);

  if (c.req.header("HX-Request")) {
    return c.html('<button type="button" class="button is-link is-light" disabled>Touched</button>');
  }
  return c.redirect("/admin/foodbanks/", 302);
}
