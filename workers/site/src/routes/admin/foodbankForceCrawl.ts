import type { Context } from "hono";
import { getFoodbankBySlug, insertCrawlSet, setCrawlSetExpected } from "@givefood/db";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { verifyCsrf } from "../../lib/csrf";

// Admin-triggered single-foodbank crawls (foodbank_detail.njk's "Force
// Check"/"Force Article Crawl"/"Force Charity Crawl" buttons; gfadmin/
// views.py:1242-1257 foodbank_crawl/foodbank_charity_crawl, and the
// dashboard's "Force Check" -> gfoffline's foodbank_need_check, moved
// here per PLAN.md §8.12's own "keep the capability, move the door").
// Django ran these synchronously inline; this Worker instead does exactly
// what givefood2-jobs's own cron fan-out does for the whole table
// (scheduled/index.ts's needcheck/getArticles/charityInfo) but for one
// foodbank: a one-row CrawlSet (no run_id -- admin-triggered, not a cron
// needing dedup) plus a single queue message, consumed by the SAME
// givefood2-jobs handlers the cron path uses. These three message shapes
// are duplicated from workers/jobs/src/queues/{needcheckRender,articles,
// charity}.ts rather than imported -- the two Workers never share src/,
// same as every other cross-Worker duplication already in this codebase
// (BOT_USER_AGENT, slugify). Keep in sync by hand if those shapes change.
interface NeedcheckRenderMessage {
  crawlSetId: number;
  foodbankId: number;
  slug: string;
  name: string;
  url: string;
  shoppingListUrl: string;
  facebookPage: string | null;
}

interface ArticlesMessage {
  crawlSetId: number;
  foodbankId: number;
  slug: string;
}

interface CharityMessage {
  crawlSetId: number;
  foodbankId: number;
  slug: string;
}

async function verifyPostCsrf(c: Context<AppEnv>): Promise<{ csrfOk: true } | Response> {
  const body = await c.req.parseBody();
  const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
  if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);
  return { csrfOk: true };
}

// gfoffline foodbank_need_check -- the admin dashboard/detail "Force
// Check" button. Always allowed (Django's own view has no guard).
export async function adminFoodbankForceCheck(c: Context<AppEnv>): Promise<Response> {
  const verified = await verifyPostCsrf(c);
  if (verified instanceof Response) return verified;

  const db = dbSession(c);
  const foodbank = await getFoodbankBySlug(db, c.req.param("slug")!);
  if (!foodbank) return c.notFound();

  const crawlSetId = await insertCrawlSet(db, "need", null);
  await setCrawlSetExpected(db, crawlSetId, 1);
  await c.env.RENDER_Q.send({
    crawlSetId,
    foodbankId: foodbank.id,
    slug: foodbank.slug,
    name: foodbank.name,
    url: foodbank.url,
    shoppingListUrl: foodbank.shopping_list_url,
    facebookPage: foodbank.facebook_page,
  } satisfies NeedcheckRenderMessage);

  return c.redirect(`/admin/foodbank/${foodbank.slug}/`, 302);
}

// gfadmin/views.py:1242-1247 foodbank_crawl -- guarded on rss_url, matching
// Django (`if foodbank.rss_url:`) and the template's own conditional
// button (only shown when foodbank.rss_url or foodbank.news_url is set).
export async function adminFoodbankForceArticleCrawl(c: Context<AppEnv>): Promise<Response> {
  const verified = await verifyPostCsrf(c);
  if (verified instanceof Response) return verified;

  const db = dbSession(c);
  const foodbank = await getFoodbankBySlug(db, c.req.param("slug")!);
  if (!foodbank) return c.notFound();

  if (foodbank.rss_url) {
    const crawlSetId = await insertCrawlSet(db, "article", null);
    await setCrawlSetExpected(db, crawlSetId, 1);
    await c.env.ARTICLES_Q.send({ crawlSetId, foodbankId: foodbank.id, slug: foodbank.slug } satisfies ArticlesMessage);
  }

  return c.redirect(`/admin/foodbank/${foodbank.slug}/`, 302);
}

// gfadmin/views.py:1250-1257 foodbank_charity_crawl -- guarded on
// charity_number, same as Django. Routes to the same one-queue-per-
// regulator split scheduled/index.ts's charityInfo() cron uses; a country
// outside those three groups (e.g. Isle of Man) has no crawl queue at all
// -- same as the cron fan-out, which never enqueues one either -- so this
// silently no-ops rather than guessing a queue.
export async function adminFoodbankForceCharityCrawl(c: Context<AppEnv>): Promise<Response> {
  const verified = await verifyPostCsrf(c);
  if (verified instanceof Response) return verified;

  const db = dbSession(c);
  const foodbank = await getFoodbankBySlug(db, c.req.param("slug")!);
  if (!foodbank) return c.notFound();

  if (foodbank.charity_number) {
    const queue = foodbank.country === "Scotland" ? c.env.CHARITY_SCOTLAND_Q : foodbank.country === "Northern Ireland" ? c.env.CHARITY_NI_Q : foodbank.country === "England" || foodbank.country === "Wales" ? c.env.CHARITY_EW_Q : null;
    if (queue) {
      const crawlSetId = await insertCrawlSet(db, "charity", null);
      await setCrawlSetExpected(db, crawlSetId, 1);
      await queue.send({ crawlSetId, foodbankId: foodbank.id, slug: foodbank.slug } satisfies CharityMessage);
    }
  }

  return c.redirect(`/admin/foodbank/${foodbank.slug}/`, 302);
}
