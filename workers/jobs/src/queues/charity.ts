import type { Env } from "../../worker-configuration";
import { decrementCrawlSetRemaining, finishCrawlItem, getFoodbankForCharityCrawl, insertCrawlItem, type CharityCrawlFoodbankRow, type Session } from "@givefood/db";

// PLAN.md §8.7: shared CrawlItem/CrawlSet bookkeeping for all three
// regulator queues (CHARITY_EW_Q/CHARITY_SCOTLAND_Q/CHARITY_NI_Q) --
// identical across all three; only the fetch-and-patch logic differs
// (crawlEw.ts/crawlScotland.ts/crawlNi.ts). Each regulator's own crawler
// never throws for an external-API-level failure (see their own module
// comments) -- only a genuine D1 write failure propagates here to retry.

export interface CharityMessage {
  crawlSetId: number;
  foodbankId: number;
  slug: string;
}

export type CharityFetcher = (env: Env, session: Session, foodbank: CharityCrawlFoodbankRow) => Promise<void>;

export function makeCharityQueueHandler(queueLabel: string, fetcher: CharityFetcher) {
  return async function handle(batch: MessageBatch<CharityMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processOne(env, message.body, fetcher);
        message.ack();
      } catch (err) {
        console.error(`${queueLabel}: message failed for foodbank ${message.body.foodbankId} (${message.body.slug})`, err);
        message.retry({ delaySeconds: 60 });
      }
    }
  };
}

async function processOne(env: Env, msg: CharityMessage, fetcher: CharityFetcher): Promise<void> {
  const session = env.DB.withSession("first-unconstrained");

  const foodbank = await getFoodbankForCharityCrawl(session, msg.foodbankId);
  if (!foodbank) {
    throw new Error(`charity: foodbank ${msg.foodbankId} (${msg.slug}) no longer exists`);
  }

  const crawlItemId = await insertCrawlItem(session, {
    crawlSetId: msg.crawlSetId,
    crawlType: "charity",
    foodbankId: msg.foodbankId,
    url: null,
  });

  await fetcher(env, session, foodbank);

  const closed = await finishCrawlItem(session, crawlItemId, null);
  if (closed) await decrementCrawlSetRemaining(session, msg.crawlSetId);
}
