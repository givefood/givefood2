import { AGGREGATE_TAG, foodbankTag } from "@givefood/urls";
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
import { pyDatetime, pyNow } from "@givefood/models";

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
//
// BUT IT IS NO LONGER SILENT, which is the one place this diverges. Django
// cannot tell "the feed published nothing today" from "we never got a feed",
// and neither could this: measured across all 470 live feeds, 20 answer 2xx
// with something that is not a feed at all -- 13 with an HTTP 202 and a
// 175-byte anti-bot challenge page, 7 with a full HTML page where the RSS
// should be -- and every one of them had been crawled eight times a day,
// for months, recording nothing anywhere. Black Country
// (blackcountryfoodbank.org.uk/feed/) is one: 216 articles, none newer than
// 2026-05-29.
//
// The OUTCOME is unchanged and still Django's -- zero items, close the
// CrawlItem cleanly, try again in two hours. What changes is that a body
// which is not a feed is logged as such rather than counted as "no news".
// Deliberately a log line and not a FoodbankDiscrepancy: 20 feeds x 8 crawls
// a day is 160 rows a day into a queue a human reads, which is the problem
// github #58 is already open about, not a second instance of it.

export interface ArticlesMessage {
  crawlSetId: number;
  foodbankId: number;
  slug: string;
}

/**
 * Does this body claim to be a feed at all?
 *
 * Checked on the first bytes rather than by parsing: fast-xml-parser accepts
 * an HTML page without complaint and simply finds no <item>, which is exactly
 * the ambiguity being removed. A leading BOM and leading whitespace are
 * stripped because real feeds have both.
 */
function looksLikeFeed(body: string): boolean {
  const head = body.replace(/^\uFEFF/, "").trimStart().slice(0, 512).toLowerCase();
  // ANYWHERE in the window, not just at the start: an XHTML page opens with
  // `<?xml version="1.0"?>` and only then declares its doctype, so a
  // start-anchored check would accept it as a feed on the strength of the XML
  // declaration alone. `<html` cannot appear in a feed.
  if (head.includes("<html") || head.includes("<!doctype html")) return false;
  return head.startsWith("<?xml") || head.includes("<rss") || head.includes("<feed") || head.includes("<rdf:rdf");
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
    const body = res.ok ? await res.text() : null;

    if (body === null) {
      console.error(`articles: ${foodbank.rss_url} answered ${res.status} -- no feed, treated as no news`);
    } else if (!looksLikeFeed(body)) {
      // The distinction Django never had. `res.ok` is true for 202, which is
      // what an anti-bot interstitial answers, so the challenge page was being
      // handed to the parser, producing zero items and reading exactly like a
      // quiet feed.
      console.error(
        `articles: ${foodbank.rss_url} answered ${res.status} ${res.headers.get("content-type") ?? "(no type)"} ` +
          `but the body is not a feed (${body.length} chars) -- treated as no news`,
      );
    } else {
      for (const item of parseFeed(body, foodbank.rss_url)) {
        const inserted = await insertArticleIfNew(session, {
          foodbankId: msg.foodbankId,
          title: item.title.slice(0, 250), // crawlers.py:50's item.title[0:250]
          url: item.link,
          // pyDatetime, not toISOString: this is a stored column shared with
          // 17,235 ETL rows, and mixed formats break ORDER BY (ticket #9).
          publishedDate: pyDatetime(item.publishedDate!), // parseFeed already filters out dateless items
        });
        if (inserted) foundNew = true;
      }
    }
  } catch (err) {
    // Network failure or fetch timeout -- same "nothing today" outcome,
    // not a D1/infrastructure error, so not rethrown for a queue retry.
    console.error(`articles: fetch failed for ${foodbank.rss_url}`, err);
  }

  const now = pyNow();
  await updateFoodbankLastCrawl(session, msg.foodbankId, now); // crawlers.py:58 stamps this unconditionally
  if (foundNew) await env.PURGE_Q.send({ tags: [foodbankTag(foodbank.slug), AGGREGATE_TAG] }); // crawlers.py:60's do_decache=True

  const closed = await finishCrawlItem(session, crawlItemId, null);
  if (closed) await decrementCrawlSetRemaining(session, msg.crawlSetId);
}
