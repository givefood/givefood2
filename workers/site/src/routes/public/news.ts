import type { Context } from "hono";
import { getRecentArticles } from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { elapsedMs } from "../../middleware/serverTiming";
import { mapArticleRow } from "../../lib/fields";

const ARTICLES_LIMIT = 100;

// givefood/views.py:582-590 news() -- the last 100 FoodbankArticle rows,
// ordered by published_date, WITHOUT the featured=true filter the
// homepage's own "featured news" section applies (see routes/public.ts's
// ARTICLES_LIMIT=5 call to getFeaturedArticles()). Row shaping mirrors
// that same file's `articles` map exactly (foodbank sub-object for
// slug/name, url_with_ref, title_captialised) since public/frags/news.njk
// is reused unchanged for both pages.
//
// KNOWN DATA-SCOPE GAP: see packages/db/src/homepage.ts's
// getRecentArticles() comment -- the D1 `foodbankarticle` table currently
// holds only the featured=true rows an earlier work package copied (168 of
// 17,194 in production, per migrations/0003_homepage_data.sql), so this
// page's "last 100 articles" can only surface that featured subset today.
// The query itself is written correctly (no featured filter) and will
// start returning the full set as soon as a fuller extraction lands --
// this is a pre-existing data-scope gap from that earlier pass, not
// something introduced here, and not something this route can fix on its
// own.
export async function publicNews(c: Context<AppEnv>): Promise<Response> {
  const session = dbSession(c);
  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";

  const articleRows = await getRecentArticles(session, ARTICLES_LIMIT);

  const articles = articleRows.map(mapArticleRow);

  const context = buildPageContext({
    path: c.req.path,
    appName: "givefood",
    pageTranslatable: true,
    locale,
    unprefixedPath: c.get("pathAfterPrefix"),
  });

  const html = await render(
    "public/news.njk",
    {
      ...context,
      render_time_ms: elapsedMs(c),
      articles,
    },
    locale,
  );
  return c.html(html);
}
