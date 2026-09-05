import type { Env } from "../../worker-configuration";
import {
  decrementCrawlSetRemaining,
  finishCrawlItem,
  getFoodbankForArticleCrawl,
  insertArticleIfNew,
  insertCrawlItem,
  updateFoodbankLastCrawl,
} from "@givefood/db";
import { parseFeed } from "../articles/feedParser";

// PLAN.md §8.6: the getarticles ARTICLES_Q consumer, ported from
// crawlers.py:25-67 (foodbank_article_crawl). Unlike needcheck, Django has
// no safety guard or discrepancy concept here at all -- a feed that's
// unreachable, malformed, or 404s just silently produces zero items that
// day (feedparser never throws; it sets a "bozo" flag and returns what it
// could, which is often nothing) and the next day's cron tries again. That
// behaviour is reproduced deliberately: a feed-level failure below closes
// the CrawlItem cleanly with foundNew=false rather than retrying or
// erroring, exactly matching "nothing happens today, try again tomorrow".
// Only a genuine infrastructure failure (a D1 write erroring) is left
// uncaught, to retry via the outer handler below.

export interface ArticlesMessage {
  crawlSetId: number;
  foodbankId: number;
  slug: string;
}

const BOT_USER_AGENT = "Mozilla/5.0 (compatible; GiveFoodBot/1.0; +https://www.givefood.org.uk/bot/)";

export async function handleArticlesQueue(batch: MessageBatch<ArticlesMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processOne(env, message.body);
      message.ack();
    } catch (err) {
      console.error(`articles: message failed for foodbank ${message.body.foodbankId} (${message.body.slug})`, err);
      message.retry({ delaySeconds: 60 });
    }
  }
}

async function processOne(env: Env, msg: ArticlesMessage): Promise<void> {
  const session = env.DB.withSession("first-unconstrained");

  const foodbank = await getFoodbankForArticleCrawl(session, msg.foodbankId);
  if (!foodbank) {
    throw new Error(`articles: foodbank ${msg.foodbankId} (${msg.slug}) no longer exists`);
  }

  const crawlItemId = await insertCrawlItem(session, {
    crawlSetId: msg.crawlSetId,
    crawlType: "article",
    foodbankId: msg.foodbankId,
    url: foodbank.rss_url,
  });

  let foundNew = false;
  try {
    // 20s timeout -- the one Django never had (feedparser's own fetch is
    // unbounded; PLAN.md §8.6 measured a real 148s hang this permits).
    const res = await fetch(foodbank.rss_url, { headers: { "User-Agent": BOT_USER_AGENT }, signal: AbortSignal.timeout(20_000) });
    if (res.ok) {
      const items = parseFeed(await res.text());
      for (const item of items) {
        const inserted = await insertArticleIfNew(session, {
          foodbankId: msg.foodbankId,
          title: item.title.slice(0, 250), // crawlers.py:50's item.title[0:250]
          url: item.link,
          publishedDate: item.publishedDate!.toISOString(), // parseFeed already filters out dateless items
        });
        if (inserted) foundNew = true;
      }
    }
    // A non-ok response is treated exactly like an empty/unparseable feed
    // (see module comment) -- no error, no retry, just zero items.
  } catch (err) {
    // Network failure or fetch timeout -- same "nothing today" outcome,
    // not a D1/infrastructure error, so not rethrown for a queue retry.
    console.error(`articles: fetch failed for ${foodbank.rss_url}`, err);
  }

  const now = new Date().toISOString();
  await updateFoodbankLastCrawl(session, msg.foodbankId, now); // crawlers.py:58 stamps this unconditionally
  if (foundNew) await env.PURGE_Q.send({ tags: [`fb-${foodbank.slug}`] }); // crawlers.py:60's do_decache=True

  const closed = await finishCrawlItem(session, crawlItemId, null);
  if (closed) await decrementCrawlSetRemaining(session, msg.crawlSetId);
}
