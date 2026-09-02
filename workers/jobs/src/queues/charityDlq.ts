import type { Env } from "../../worker-configuration";
import { decrementCrawlSetRemaining } from "@givefood/db";
import type { CharityMessage } from "./charity";

// Same shape as articles-dlq.ts: charityinfo has no FoodbankDiscrepancy
// concept in Django either, so the only job here is keeping the CrawlSet
// counter from getting permanently stuck for a food bank whose crawl keeps
// failing at the D1-write level (an external-API failure never reaches
// here at all -- each regulator's crawler swallows those itself).
function makeCharityDlqHandler(queueLabel: string) {
  return async function handle(batch: MessageBatch<CharityMessage>, env: Env): Promise<void> {
    const session = env.DB.withSession("first-unconstrained");
    for (const message of batch.messages) {
      console.error(`${queueLabel}: foodbank ${message.body.foodbankId} (${message.body.slug}) exhausted retries`);
      try {
        await decrementCrawlSetRemaining(session, message.body.crawlSetId);
      } catch (err) {
        console.error(`${queueLabel}: failed to decrement crawlset remaining for foodbank ${message.body.foodbankId} (${message.body.slug})`, err);
      }
      message.ack();
    }
  };
}

export const handleCharityEwDlq = makeCharityDlqHandler("charity-ew-dlq");
export const handleCharityScotlandDlq = makeCharityDlqHandler("charity-scotland-dlq");
export const handleCharityNiDlq = makeCharityDlqHandler("charity-ni-dlq");
