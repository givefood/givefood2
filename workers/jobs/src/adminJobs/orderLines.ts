import type { Env } from "../../worker-configuration";
import { runOrderLinesJob } from "@givefood/ai";

// The queue half of the order-lines parse, now only for messages that were
// already on the `jobs` queue when the order form started running the parse
// inline (workers/site/src/routes/admin/orderForm.ts). The parse itself is
// packages/ai/src/orderLines.ts; this wrapper keeps the queue-consumer
// timings (geminiJsonCall's defaults), which a queue can afford.
export async function handleOrderLinesJob(env: Env, jobId: string, orderRowId: number): Promise<void> {
  // Same Sessions-API entry point as the rest of this Worker -- this D1
  // database has read replication enabled, so every read must go through
  // withSession() rather than env.DB.prepare() directly.
  await runOrderLinesJob(env.DB.withSession("first-unconstrained"), env.GEMINI_API_KEY, jobId, orderRowId);
}
