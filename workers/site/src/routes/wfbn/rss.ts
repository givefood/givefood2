import type { Context } from "hono";
import { getFoodbankBySlug, getRecentArticles, getArticlesByFoodbankId, getRecentPublishedNeedsForRss, getNeedTranslationsByIds, toDashedUuid } from "@givefood/db";
import { buildPageContext, loadCatalogue, render, translate } from "@givefood/templates";
import { urlForLocale } from "@givefood/urls";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { elapsedMs } from "../../middleware/serverTiming";
import { fullNameLocaleAware, noItems, resolveNeedText } from "../../lib/fields";

const ITEMS_LIMIT = 10;

interface RssItem {
  title: string;
  url: string;
  date: string;
  description?: string;
}

// gfwfbn `rss` (GET /needs/rss.xml and /needs/at/<slug>/rss.xml,
// i18n-patterned, one view handles both -- givefood/views.py:132-189).
// Merges the last 10 published needs (excluding the Unknown/Facebook/
// Nothing sentinels) and the last 10 articles, site-wide or scoped to one
// food bank, sorted together by date descending.
async function rss(c: Context<AppEnv>, slug: string | undefined): Promise<Response> {
  const session = dbSession(c);
  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";

  let foodbank = null;
  if (slug) {
    foodbank = await getFoodbankBySlug(session, slug);
    if (!foodbank) return c.notFound();
  }

  const [needs, articles, catalogue] = await Promise.all([
    getRecentPublishedNeedsForRss(session, ITEMS_LIMIT, foodbank?.id),
    foodbank ? getArticlesByFoodbankId(session, foodbank.id, ITEMS_LIMIT) : getRecentArticles(session, ITEMS_LIMIT),
    loadCatalogue(locale),
  ]);

  // FoodbankChangeTranslation batch lookup (needs.py:216-259) -- one D1
  // round trip for every need on this feed, not one per row.
  // getRecentPublishedNeedsForRss's own query already excludes the
  // Unknown/Facebook/Nothing sentinels, so unlike foodbank.ts/
  // locationDetail.ts there's no "is this a real need" gate needed here --
  // every row is real. noItems() (the item count in the title) stays
  // against the RAW change_text -- FoodbankChange.no_items() (needs.py:93)
  // is not locale-aware either.
  const translations = locale !== "en" && needs.length > 0 ? await getNeedTranslationsByIds(session, needs.map((need) => need.id), locale) : null;

  const itemsRequestedAt = translate(catalogue, "items requested at");
  const items: RssItem[] = [];
  for (const need of needs) {
    const needFullName = fullNameLocaleAware(need.foodbank_name, need.foodbank_alt_name, locale);
    items.push({
      title: `${noItems(need.change_text)} ${itemsRequestedAt} ${needFullName}`,
      url: `${c.env.SITE_DOMAIN}${urlForLocale(locale, "wfbn:foodbank", need.foodbank_slug)}#need-${toDashedUuid(need.need_id)}`,
      date: need.created,
      description: resolveNeedText(need.change_text, translations?.get(need.id)?.change_text, locale),
    });
  }
  for (const article of articles) {
    items.push({ title: article.title, url: article.url, date: article.published_date });
  }
  items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const selfUrl = foodbank
    ? `${c.env.SITE_DOMAIN}${urlForLocale(locale, "wfbn:foodbank_rss", foodbank.slug)}`
    : `${c.env.SITE_DOMAIN}${urlForLocale(locale, "wfbn:rss")}`;

  const context = buildPageContext({
    path: c.req.path,
    appName: "gfwfbn",
    pageTranslatable: true,
    locale,
    unprefixedPath: c.get("pathAfterPrefix"),
  });

  const fullName = foodbank ? fullNameLocaleAware(foodbank.name, foodbank.alt_name, locale) : null;
  const xml = await render(
    "wfbn/rss.njk",
    {
      ...context,
      render_time_ms: elapsedMs(c),
      SITE_DOMAIN: c.env.SITE_DOMAIN,
      items,
      self_url: selfUrl,
      foodbank: foodbank ? { ...foodbank, full_name: fullName } : null,
    },
    locale,
  );
  return c.body(xml, 200, { "Content-Type": "application/rss+xml" });
}

export async function wfbnRss(c: Context<AppEnv>): Promise<Response> {
  return rss(c, undefined);
}

export async function wfbnFoodbankRss(c: Context<AppEnv>): Promise<Response> {
  return rss(c, c.req.param("slug")!);
}
