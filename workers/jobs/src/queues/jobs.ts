import type { Env } from "../../worker-configuration";
import { backfillMapImage, isMapImageKey } from "../mediaBackfill/mapImage";
import { handleTranslateNeed, type TranslateNeedMessage } from "./translateNeed";
import { handleFoodbankCheckJob } from "../adminJobs/foodbankCheck";
import { handleOrderLinesJob } from "../adminJobs/orderLines";

// Consumer for the "jobs" queue (binding JOBS_Q) -- admin-triggered and
// on-miss work, per PLAN.md §3.3's binding map: "article crawl,
// notifications, photo backfill". This is the other end of the message
// routes/media.ts sends when a media request misses R2, and (WP 6.4) the
// other end of the admin's need_publish handler's translate enqueue.
type JobMessage = { type: "media-backfill"; key: string } | TranslateNeedMessage | { type: "foodbank-check"; jobId: string; foodbankSlug: string } | { type: "order-lines"; jobId: string; orderRowId: number } | { type: string; [k: string]: unknown };

export async function handleJobsQueue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await dispatch(message.body, env);
      message.ack();
    } catch (err) {
      console.error(`givefood-jobs: "jobs" message failed`, message.body, err);
      message.retry();
    }
  }
}

async function dispatch(body: JobMessage, env: Env): Promise<void> {
  switch (body.type) {
    case "media-backfill":
      return handleMediaBackfill(body as { type: "media-backfill"; key: string }, env);
    case "translate-need":
      return handleTranslateNeed(body as TranslateNeedMessage, env);
    case "foodbank-check": {
      const msg = body as { type: "foodbank-check"; jobId: string; foodbankSlug: string };
      // handleFoodbankCheckJob catches its own errors and records them on
      // the admin_job row rather than throwing -- a failed AI check is a
      // result the polling page shows, not something Cloudflare Queues
      // should retry (a retry would just re-run the same paid Gemini
      // call against the same failure).
      return handleFoodbankCheckJob(env, msg.jobId, msg.foodbankSlug);
    }
    case "order-lines": {
      const msg = body as { type: "order-lines"; jobId: string; orderRowId: number };
      // Same self-recording contract as foodbank-check above: the handler
      // writes success or failure onto the admin_job row and never throws, so
      // a failed parse is a result the order page shows rather than a message
      // Cloudflare Queues retries into the same paid Gemini call.
      return handleOrderLinesJob(env, msg.jobId, msg.orderRowId);
    }
    default:
      throw new Error(`unknown job type: ${body.type}`);
  }
}

// PLAN.md §3.7: on an R2 miss, fetch/generate the object (Google Places
// photo, Static Maps, s2 favicon, or a Browser Rendering screenshot
// depending on which route the key came from) and PUT it into MEDIA with
// the httpMetadata/customMetadata shape §3.7 specifies. Only the Static
// Maps family (map.png) is implemented so far -- photo.jpg/favicon.png/
// screenshots still throw, same as before, until their own fetch/generate
// logic is built.
async function handleMediaBackfill(
  message: { type: "media-backfill"; key: string },
  env: Env,
): Promise<void> {
  if (isMapImageKey(message.key)) {
    await backfillMapImage(env, message.key);
    return;
  }
  throw new Error(`media-backfill: not implemented (key=${message.key})`);
}
