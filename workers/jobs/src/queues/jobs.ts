import type { Env } from "../../worker-configuration";
import { backfillMapImage, isMapImageKey } from "../mediaBackfill/mapImage";
import { backfillPlacePhoto, isPlacePhotoKey } from "../mediaBackfill/placePhoto";
import { handleTranslateNeed, type TranslateNeedMessage } from "./translateNeed";
import { handleFoodbankCheckJob } from "../adminJobs/foodbankCheck";
import { handleOrderLinesJob } from "../adminJobs/orderLines";
import { handleNotifyNeedEmail, type NotifyNeedEmailMessage } from "../notify/needEmail";
import { handleNotifyNeedFirebase, type NotifyNeedFirebaseMessage } from "../notify/needFirebase";
import { handleNotifyNeedWebPush, type NotifyNeedWebPushMessage } from "../notify/needWebPush";
import { handleNotifyNeedWhatsApp, type NotifyNeedWhatsAppMessage } from "../notify/needWhatsApp";

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
      console.error(`givefood2-jobs: "jobs" message failed`, message.body, err);
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
    case "notify-need-email": {
      // gfadmin/views.py:1993-1997's per-subscriber notification send.
      // Self-paging: each message handles one page and enqueues the next,
      // so a food bank with hundreds of subscribers is many small messages
      // rather than one that cannot finish. See notify/needEmail.ts.
      return handleNotifyNeedEmail(body as unknown as NotifyNeedEmailMessage, env);
    }
    // gfadmin/views.py:1999-2006's other three channels. Each self-pages
    // the same way the email one does, except Firebase -- which addresses
    // a topic, so it is one call with no subscriber list to walk.
    //
    // Each handler catches its own send failures and returns, so a channel
    // whose credentials are missing or whose upstream is down does not
    // retry the message and does not take the other channels down with
    // it. That is Django's behaviour too: all four are separate tasks.
    case "notify-need-firebase":
      return handleNotifyNeedFirebase(body as unknown as NotifyNeedFirebaseMessage, env);
    case "notify-need-webpush":
      return handleNotifyNeedWebPush(body as unknown as NotifyNeedWebPushMessage, env);
    case "notify-need-whatsapp":
      return handleNotifyNeedWhatsApp(body as unknown as NotifyNeedWhatsAppMessage, env);
    default:
      throw new Error(`unknown job type: ${body.type}`);
  }
}

// PLAN.md §3.7: on an R2 miss, fetch/generate the object (Google Places
// photo, Static Maps, s2 favicon, or a Browser Rendering screenshot
// depending on which route the key came from) and PUT it into MEDIA with
// the httpMetadata/customMetadata shape §3.7 specifies.
//
// map.png and photo.jpg are implemented. favicon.png never will be from
// here -- routes/wfbn/favicon.ts fetches Google's keyless favicon service
// live and caches the response, because there is no billed-API-call reason
// to keep it out of the request path (see that file). screenshots/*.png
// still throws.
//
// A photo.jpg miss is expected to be RARE: Django's existing 7,122 photos
// were bulk-loaded into R2 from its own PlacePhoto table by
// tools/pg-to-r2/load_photos.py, so this path is for places created since.
async function handleMediaBackfill(
  message: { type: "media-backfill"; key: string },
  env: Env,
): Promise<void> {
  if (isMapImageKey(message.key)) {
    await backfillMapImage(env, message.key);
    return;
  }
  if (isPlacePhotoKey(message.key)) {
    await backfillPlacePhoto(env, message.key);
    return;
  }
  throw new Error(`media-backfill: not implemented (key=${message.key})`);
}
