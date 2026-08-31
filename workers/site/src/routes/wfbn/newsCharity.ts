import type { Context } from "hono";
import { getArticlesByFoodbankId, getFoodbankBySlug } from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { elapsedMs } from "../../middleware/serverTiming";
import { CHARITY_DETAIL_COUNTRIES, fullNameLocaleAware, mapArticleRow } from "../../lib/fields";
import { formatCharityRegDate, openCharitiesUrl, pythonSplitlines } from "./md/newsCharity";

// gfwfbn `foodbank_news` (GET /needs/at/<slug>/news/, i18n-patterned).
// Ported from gfwfbn/views.py:620-635. Same guard/query as
// md/newsCharity.ts's mdFoodbankNews (getArticlesByFoodbankId) -- see that
// file's KNOWN DATA-SCOPE GAP comment: D1's foodbankarticle table only
// holds the ~168 featured-article rows out of production's ~17k, so this
// page's list can only ever show that featured subset until a fuller
// article ETL lands.
export async function wfbnFoodbankNews(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const session = dbSession(c);
  const foodbank = await getFoodbankBySlug(session, slug);
  if (!foodbank) return c.notFound();
  if (!foodbank.rss_url && !foodbank.news_url) return c.notFound();

  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";
  const fullName = fullNameLocaleAware(foodbank.name, foodbank.alt_name, locale);

  // FoodbankArticle.url_with_ref() is the same PreparedRequest merge as
  // Foodbank.url_with_ref() (no querystring stripping) -- mapArticleRow
  // already ports exactly this shape (public.ts/news.ts's own article
  // rows), reused here rather than re-derived.
  const rawArticles = await getArticlesByFoodbankId(session, foodbank.id, 20);
  const articles = rawArticles.map(mapArticleRow);

  const context = buildPageContext({
    path: c.req.path,
    appName: "gfwfbn",
    pageTranslatable: true,
    locale,
    unprefixedPath: c.get("pathAfterPrefix"),
  });

  const html = await render(
    "wfbn/foodbank/news.njk",
    {
      ...context,
      render_time_ms: elapsedMs(c),
      section: "news",
      foodbank,
      full_name: fullName,
      has_charity_details: CHARITY_DETAIL_COUNTRIES.has(foodbank.country),
      articles,
    },
    locale,
  );
  return c.html(html);
}

// gfwfbn `foodbank_charity` (GET /needs/at/<slug>/charity/, i18n-patterned).
// Ported from gfwfbn/views.py:638-656. Same guard/computed-field logic as
// md/newsCharity.ts's mdFoodbankCharity (open_charities_url/
// formatCharityRegDate/charity_purpose_list), imported from there rather
// than re-derived.
export async function wfbnFoodbankCharity(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const session = dbSession(c);
  const foodbank = await getFoodbankBySlug(session, slug);
  if (!foodbank) return c.notFound();
  if (!foodbank.charity_name || !CHARITY_DETAIL_COUNTRIES.has(foodbank.country)) return c.notFound();

  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";
  const fullName = fullNameLocaleAware(foodbank.name, foodbank.alt_name, locale);

  const charityPurposeList = foodbank.charity_purpose ? pythonSplitlines(foodbank.charity_purpose) : [];

  const context = buildPageContext({
    path: c.req.path,
    appName: "gfwfbn",
    pageTranslatable: true,
    locale,
    unprefixedPath: c.get("pathAfterPrefix"),
  });

  const html = await render(
    "wfbn/foodbank/charity.njk",
    {
      ...context,
      render_time_ms: elapsedMs(c),
      section: "charity",
      foodbank,
      full_name: fullName,
      has_charity_details: true, // guard above already confirms this for the page currently rendering
      open_charities_url: openCharitiesUrl(foodbank.charity_number, foodbank.country),
      charity_reg_date: foodbank.charity_reg_date ? formatCharityRegDate(foodbank.charity_reg_date) : null,
      charity_purpose_list: charityPurposeList,
      // No `charityyear` table in D1 yet (packages/db/migrations/*.sql) --
      // the Income & Expenditure table is permanently absent until a
      // future migration adds one; a known, deliberate gap, not a bug.
      charity_years: [],
    },
    locale,
  );
  return c.html(html);
}
