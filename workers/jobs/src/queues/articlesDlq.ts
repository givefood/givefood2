import type { Env } from "../../worker-configuration";
import { decrementCrawlSetRemaining } from "@givefood/db";
import type { ArticlesMessage } from "./articles";

// A message lands here only after exhausting ARTICLES_Q's max_retries.
// Articles has no FoodbankDiscrepancy concept in Django at all (crawlers.py
// never writes one for this job), so this consumer's only job is the one
// every DLQ in this Worker exists for regardless of the job's own
// semantics: without it, the CrawlSet's `remaining` counter never reaches
// 0 for a permanently-failing food bank, and crawlset.finish is never
// stamped. A log line is the closest equivalent to "nothing happens,
// try again tomorrow" this job already has.
export async function handleArticlesDlq(batch: MessageBatch<ArticlesMessage>, env: Env): Promise<void> {
  const session = env.DB.withSession("first-unconstrained");
  for (const message of batch.messages) {
    console.error(`articles-dlq: foodbank ${message.body.foodbankId} (${message.body.slug}) exhausted retries`);
    try {
      await decrementCrawlSetRemaining(session, message.body.crawlSetId);
    } catch (err) {
      console.error(`articles-dlq: failed to decrement crawlset remaining for foodbank ${message.body.foodbankId} (${message.body.slug})`, err);
    }
    message.ack();
  }
}
