import type { Session } from "./types";

// WP 5.5 (PLAN.md §8.6): getarticles' own D1 access -- the cron handler
// (enqueueing one message per RSS-carrying food bank) and the ARTICLES_Q
// consumer (crawlitem bookkeeping, the article dedup insert, last_crawl).

export interface RssFoodbankRow {
  id: number;
  slug: string;
}

// getarticles.py:21's `Foodbank.objects.filter(rss_url__isnull=False)
// .order_by("?")`. Ordered by slug, not randomised -- same deliberate
// change as needcheck's own cron query (PLAN.md §8.5.2): a Queue makes
// enqueue order irrelevant, and a deterministic order makes a partial run
// easy to reason about. Only id/slug are read here -- the consumer
// re-fetches the full row fresh at dequeue time (getFoodbankForArticleCrawl
// below), not from this snapshot, so nothing else needs selecting.
export async function getFoodbanksWithRss(session: Session): Promise<RssFoodbankRow[]> {
  const result = await session
    .prepare("SELECT id, slug FROM foodbank WHERE rss_url IS NOT NULL AND rss_url != '' AND is_closed = 0 ORDER BY slug")
    .all<RssFoodbankRow>();
  return result.results;
}

export interface ArticleCrawlFoodbankRow {
  id: number;
  slug: string;
  name: string;
  rss_url: string;
}

// crawlers.py:579-590's re-fetch-at-execution pattern (needcheck's own
// getFoodbankForNeedCheck carries the same rationale): the cron's
// enqueue-time snapshot can go stale during the enqueue-to-dequeue window,
// so the queue consumer reads the food bank fresh rather than trusting the
// message body.
export async function getFoodbankForArticleCrawl(session: Session, foodbankId: number): Promise<ArticleCrawlFoodbankRow | null> {
  return session
    .prepare("SELECT id, slug, name, rss_url FROM foodbank WHERE id = ?1")
    .bind(foodbankId)
    .first<ArticleCrawlFoodbankRow>();
}

export interface InsertArticleParams {
  foodbankId: number;
  title: string;
  url: string;
  publishedDate: string;
}

// crawlers.py:44-54's SELECT-then-INSERT collapses into one `INSERT OR
// IGNORE` against `article_url_uniq` (0010_article_url_unique.sql) --
// PLAN.md §8.6's own design: "url is UNIQUE -- dedup is the DB's job", and
// what makes a Cloudflare Queues redelivery of the same message a no-op
// rather than a duplicate row. `featured` has no DB default (matches
// Django's model default of False) -- every new row from the crawler is
// unfeatured until an admin curates it. Returns whether this call actually
// inserted a new row, for the caller's `foundNew` (-> decache) decision.
export async function insertArticleIfNew(session: Session, params: InsertArticleParams): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await session
    .prepare(
      `INSERT OR IGNORE INTO foodbankarticle
         (foodbank_id, title, url, published_date, featured)
       VALUES (?1, ?2, ?3, ?4, 0)`,
    )
    .bind(params.foodbankId, params.title, params.url, params.publishedDate)
    .run();
  return result.meta.changes > 0;
}

export async function updateFoodbankLastCrawl(session: Session, foodbankId: number, timestamp: string): Promise<void> {
  await session.prepare("UPDATE foodbank SET last_crawl = ?1 WHERE id = ?2").bind(timestamp, foodbankId).run();
}
