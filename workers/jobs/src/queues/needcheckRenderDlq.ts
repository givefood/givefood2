import type { Env } from "../../worker-configuration";
import { decrementCrawlSetRemaining, insertFoodbankDiscrepancy } from "@givefood/db";
import type { NeedcheckRenderMessage } from "./needcheckRender";

// WP 5.4: "Every queue gets a DLQ whose consumer writes a
// FoodbankDiscrepancy. Without one, repeatedly failing messages 'will
// eventually be discarded' -- silently." A message lands here only after
// exhausting needcheck-render's max_retries (3, wrangler.jsonc) -- the
// permanent-failure case (OpenRouter 402 etc.) is handled directly in
// needcheckRender.ts's own catch block via an ack, so it never reaches
// this queue at all.
export async function handleNeedcheckRenderDlq(batch: MessageBatch<NeedcheckRenderMessage>, env: Env): Promise<void> {
  const session = env.DB.withSession("first-unconstrained");
  for (const message of batch.messages) {
    // The discrepancy write and the counter decrement are independent,
    // non-transactional D1 writes -- each in its own try/catch so a
    // transient failure in one (e.g. a D1 write blip) can't also silently
    // drop the other. They used to share one try block: a failure in the
    // discrepancy write skipped the decrement too, and since this queue's
    // own max_retries is 1 with no further DLQ behind it, both were lost
    // for good behind nothing but a console.error line.
    try {
      await insertFoodbankDiscrepancy(session, {
        foodbankId: message.body.foodbankId,
        foodbankName: message.body.name,
        url: message.body.url,
        discrepancyType: "website",
        discrepancyText: `Need check repeatedly failed for ${message.body.url} and was dead-lettered after exhausting retries`,
      });
    } catch (err) {
      console.error(`needcheck-render-dlq: failed to record discrepancy for foodbank ${message.body.foodbankId} (${message.body.slug})`, err);
    }
    try {
      // Every other exit path from needcheckRender.ts's processOne()
      // decrements `remaining` (via finish()), and a message that ends up
      // here instead must still count down, or a single
      // permanently-failing food bank leaves that day's CrawlSet.finish
      // stamped never.
      await decrementCrawlSetRemaining(session, message.body.crawlSetId);
    } catch (err) {
      console.error(`needcheck-render-dlq: failed to decrement crawlset remaining for foodbank ${message.body.foodbankId} (${message.body.slug})`, err);
    }
    // Always ack -- this is already the dead-letter queue with its own
    // max_retries: 1 (wrangler.jsonc); retrying here just risks an
    // infinite loop if D1 itself is the thing failing.
    message.ack();
  }
}
