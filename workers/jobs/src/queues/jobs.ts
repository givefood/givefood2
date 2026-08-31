import type { Env } from "../../worker-configuration";
import { backfillMapImage, isMapImageKey } from "../mediaBackfill/mapImage";

// Consumer for the "jobs" queue (binding JOBS_Q) -- admin-triggered and
// on-miss work, per PLAN.md §3.3's binding map: "article crawl,
// notifications, photo backfill". This is the other end of the message
// routes/media.ts sends when a media request misses R2.
type JobMessage = { type: "media-backfill"; key: string } | { type: string; [k: string]: unknown };

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
