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
  getFoodbankAdminTotals,
  getPhotosForFoodbankTab,
  getFoodbankPhotoCount,
  crawlTypeIcon,
  touchFoodbank,
  type FoodbankRow,
} from "@givefood/db";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { verifyCsrf, issueCsrfToken } from "../../lib/csrf";
import { adminPageContext } from "./pageContext";
import { fullNameFoodbank, titleCapitalised } from "@givefood/models";
import { inputMethodEmoji } from "../../lib/needAdminDisplay";
import { timesince } from "../../lib/timesince";

// gfadmin/views.py:644-645 (needs/orders: 200), :723 (crawls: 100) --
// subscribers has no limit at all (foodbank_subscribers_tab), see
// foodbankTabs.ts's own comment on getSubscribersForFoodbankTab.
const NEEDS_ORDERS_TAB_LIMIT = 200;
const ARTICLES_TAB_LIMIT = 20;
const CRAWLS_TAB_LIMIT = 100;

// givefood/models/foodbank.py:326-354 -- small computed properties Django
// derives on the model rather than storing, not raw D1 columns. English/UK
// registers only; no other country values appear in this schema.
function fsaUrl(foodbank: FoodbankRow): string | null {
  return foodbank.fsa_id ? `https://ratings.food.gov.uk/business/${foodbank.fsa_id}` : null;
}

function charityRegisterUrl(foodbank: FoodbankRow): string | null {
  if (!foodbank.charity_number) return null;
  switch (foodbank.country) {
    case "Scotland":
      return `https://www.oscr.org.uk/about-charities/search-the-register/charity-details?number=${foodbank.charity_number}`;
    case "Northern Ireland":
      return `https://www.charitycommissionni.org.uk/charity-details/?regId=${foodbank.charity_number.replace("NIC", "")}`;
    case "Wales":
    case "England":
      return `https://register-of-charities.charitycommission.gov.uk/charity-details/?regid=${foodbank.charity_number}&subid=0`;
    case "Isle of Man":
      return "https://www.gov.im/about-the-government/offices/attorney-generals-chambers/crown-office/charities/index-of-charities-registered-in-the-isle-of-man/";
    default:
      return null;
  }
}

// Django's slugify() strips punctuation rather than hyphenating it (e.g.
// "Sainsbury's" -> "sainsburys", matching the real
// /static/img/delivery_provider/icon/sainsburys.png filename) --
// lib/fields.ts's own exported slugify() instead turns each punctuation
// run into a "-" (for URL slugs, a different job), which would produce
// "sainsbury-s" here and 404 the icon. Matches packages/db/src/
// foodbankAdmin.ts's own local slugify(), used for the same
// image-filename-matching reason (company_slug).
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/[-\s]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

// givefood/const/general.py:136 -- packaging adds a fixed 18% to a
// delivery's raw item weight; kept as a literal here (same precedent as
// SESSION_TTL_SECONDS-style small constants elsewhere in this codebase)
// rather than a shared constants module for one admin-only display field.
const PACKAGING_WEIGHT_PC = 1.18;

// gfadmin/views.py:579-638 foodbank() -- the tabbed detail page. Three
// panels render eagerly (general info, locations, latest need -- all
// toggled together under one "generallocations" class in Django, WP 6.7
// research); the rest are lazy `hx-get` fragments wired up exactly like
// need.njk's diff tabs (WP 6.4) already reuse tabber.js for.
export async function adminFoodbankDetail(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const foodbank = await getFoodbankBySlug(db, c.req.param("slug")!);
  if (!foodbank) return c.notFound();

  const [locations, totals, photoCount] = await Promise.all([
    getLocationsByFoodbankId(db, foodbank.id),
    getFoodbankAdminTotals(db, foodbank.id),
    getFoodbankPhotoCount(db, foodbank.id),
  ]);

  const totalWeightKg = totals.totalWeightGrams / 1000;

  const html = await render("admin/foodbank_detail.njk", {
    ...(await adminPageContext(c, "foodbanks")),
    foodbank: {
      ...foodbank,
      latestNeed: foodbank.latestNeed
        ? {
            ...foodbank.latestNeed,
            need_id_short: foodbank.latestNeed.need_id.slice(0, 7),
            input_method_emoji: inputMethodEmoji(foodbank.latestNeed.input_method),
            created_timesince: `${timesince(foodbank.latestNeed.created)} ago`,
          }
        : null,
    },
    full_name: fullNameFoodbank(foodbank.name),
    fsa_url: fsaUrl(foodbank),
    charity_register_url: charityRegisterUrl(foodbank),
    locations,
    counts: {
      locations: locations.length,
      needs: totals.needs,
      orders: totals.orders,
      donation_points: totals.donationPoints,
      articles: totals.articles,
      subscribers: totals.emailSubscribers + totals.webpushSubscribers + totals.mobileSubscribers,
      crawls: totals.crawls,
      // gfadmin/templates/admin/foodbank.html:51 gates the Photos tab on this
      // being non-zero; the tab is hidden entirely for a food bank with none.
      photos: photoCount,
    },
    no_orders: totals.orders,
    number_subscribers: totals.emailSubscribers,
    total_weight_kg: totalWeightKg,
    // gfadmin/views.py:632 -- `total_weight_kg * PACKAGING_WEIGHT_PC`, no
    // rounding: the template's |intcomma renders the float as-is, tail and
    // all. The port previously rounded to 2dp here, a visible divergence
    // (23415.6 kg raw renders "27,630.41" rounded vs Django's
    // "27,630.407999999996"). Python and JS share IEEE754 doubles and both
    // stringify via shortest-round-trip repr -- 23415.6 * 1.18 gives the
    // identical 27630.407999999996 in each -- so the raw product reproduces
    // Django byte for byte.
    total_weight_kg_pkg: totalWeightKg * PACKAGING_WEIGHT_PC,
    total_items: totals.totalItems,
    total_cost: totals.totalCostPence / 100,
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
      const [needs, orders] = await Promise.all([getNeedsForFoodbankTab(db, foodbank.id, NEEDS_ORDERS_TAB_LIMIT), getOrdersForFoodbankTab(db, foodbank.id, NEEDS_ORDERS_TAB_LIMIT)]);
      return c.html(
        await render("admin/foodbank_tabs/needsorders.njk", {
          // gfadmin/templates/admin/foodbank.html:461 and :509 head each of
          // this fragment's two columns with a New Need / New Order button
          // carrying ?foodbank=<slug>; the template needs the slug for those.
          foodbank_slug: foodbank.slug,
          needs: needs.map((n) => ({ ...n, input_method_emoji: inputMethodEmoji(n.input_method), need_id_short: n.need_id.slice(0, 7) })),
          orders: orders.map((o) => ({ ...o, delivery_provider_slug: o.delivery_provider ? slugify(o.delivery_provider) : null })),
        }),
      );
    }
    case "donationpoints": {
      const [donationPoints, csrfToken] = await Promise.all([getDonationPointsByFoodbankId(db, foodbank.id), issueCsrfToken(c, c.env.CSRF_SECRET)]);
      return c.html(await render("admin/foodbank_tabs/donationpoints.njk", { donation_points: donationPoints, foodbank_slug: foodbank.slug, csrf_token: csrfToken }));
    }
    case "articles": {
      const articles = await getArticlesForFoodbankTab(db, foodbank.id, ARTICLES_TAB_LIMIT);
      return c.html(
        await render("admin/foodbank_tabs/articles.njk", {
          // title_captialised is Django's own (misspelled) FoodbankArticle method,
          // articles.py:34-52 -- already ported as lib/fields.ts's titleCapitalised
          // and applied on every other article surface, just never on this tab.
          articles: articles.map((a) => ({ ...a, title_captialised: titleCapitalised(a.title), published_date_timesince: `${timesince(a.published_date)} ago` })),
        }),
      );
    }
    case "subscribers": {
      const subscribers = await getSubscribersForFoodbankTab(db, foodbank.id);
      return c.html(await render("admin/foodbank_tabs/subscribers.njk", { subscribers, foodbank_slug: foodbank.slug }));
    }
    case "photos": {
      // gfadmin/views.py:730-775 foodbank_photos_tab. Needs a CSRF token of
      // its own: unlike the other read-only tabs, each row carries a delete
      // form (routes/admin/photoDelete.ts).
      const [photos, csrfToken] = await Promise.all([getPhotosForFoodbankTab(db, foodbank.id), issueCsrfToken(c, c.env.CSRF_SECRET)]);
      return c.html(await render("admin/foodbank_tabs/photos.njk", { photos, foodbank_slug: foodbank.slug, csrf_token: csrfToken }));
    }
    case "crawls": {
      const crawlItems = await getCrawlItemsForFoodbankTab(db, foodbank.id, CRAWLS_TAB_LIMIT);
      return c.html(await render("admin/foodbank_tabs/crawls.njk", { crawl_items: crawlItems.map((i) => ({ ...i, crawl_type_icon: crawlTypeIcon(i.crawl_type) })) }));
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
