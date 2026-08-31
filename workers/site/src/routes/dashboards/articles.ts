import type { Context } from "hono";
import { getRecentArticles } from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { elapsedMs } from "../../middleware/serverTiming";
import { mapArticleRow } from "../../lib/fields";

const LIMIT = 200;

function pageContext(c: Context<AppEnv>) {
  return { ...buildPageContext({ path: c.req.path, appName: "gfdash" }), render_time_ms: elapsedMs(c) };
}

// gfdash `articles` (views.py:234-241) -- the 200 most recently published
// FoodbankArticle rows. mapArticleRow() links to the REAL joined
// foodbank.slug getRecentArticles already carries (homepage.ts), not
// Django's own `article.foodbank_name_slug` slugify-guess -- same
// deliberate upgrade already made for public/news.njk and the beautybanks
// dashboard.
export async function gfdashArticles(c: Context<AppEnv>): Promise<Response> {
  const session = dbSession(c);
  const rows = await getRecentArticles(session, LIMIT);

  const articles = rows.map(mapArticleRow);

  return c.html(await render("dash/articles.njk", { ...pageContext(c), articles }));
}
