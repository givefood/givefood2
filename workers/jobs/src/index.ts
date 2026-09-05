import type { Env } from "../worker-configuration";
import { handleScheduled } from "./scheduled";
import { handleJobsQueue } from "./queues/jobs";
import { handleNeedcheckRenderQueue } from "./queues/needcheckRender";
import { handleNeedcheckRenderDlq } from "./queues/needcheckRenderDlq";
import { handleArticlesQueue } from "./queues/articles";
import { handleArticlesDlq } from "./queues/articlesDlq";
import { handleCharityEwQueue } from "./queues/charityEw";
import { handleCharityScotlandQueue } from "./queues/charityScotland";
import { handleCharityNiQueue } from "./queues/charityNi";
import { handleCharityEwDlq, handleCharityNiDlq, handleCharityScotlandDlq } from "./queues/charityDlq";
import { handleCachePurgeQueue } from "./queues/cachePurge";
import { handleJobsDlq } from "./queues/jobsDlq";
import { handleWhatsappHookQueue } from "./queues/whatsappHook";

// No routes, no assets -- see PLAN.md §3.1 "Why the second Worker is
// genuinely required" (secret blast radius, different limits, deploy
// isolation from the public site).
export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    return handleScheduled(event, env, ctx);
  },

  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext) {
    switch (batch.queue) {
      case "jobs":
        return handleJobsQueue(batch as MessageBatch<any>, env);
      case "needcheck-render":
        return handleNeedcheckRenderQueue(batch as MessageBatch<any>, env);
      case "needcheck-render-dlq":
        return handleNeedcheckRenderDlq(batch as MessageBatch<any>, env);
      case "articles":
        return handleArticlesQueue(batch as MessageBatch<any>, env);
      case "articles-dlq":
        return handleArticlesDlq(batch as MessageBatch<any>, env);
      case "charity-ew":
        return handleCharityEwQueue(batch as MessageBatch<any>, env);
      case "charity-ew-dlq":
        return handleCharityEwDlq(batch as MessageBatch<any>, env);
      case "charity-scotland":
        return handleCharityScotlandQueue(batch as MessageBatch<any>, env);
      case "charity-scotland-dlq":
        return handleCharityScotlandDlq(batch as MessageBatch<any>, env);
      case "charity-ni":
        return handleCharityNiQueue(batch as MessageBatch<any>, env);
      case "charity-ni-dlq":
        return handleCharityNiDlq(batch as MessageBatch<any>, env);
      case "cache-purge":
        return handleCachePurgeQueue(batch as MessageBatch<any>, env);
      // Both dead-letter queues that previously had no case here. See
      // queues/jobsDlq.ts -- jobs-dlq was reaching `default` and logging its
      // own name rather than the message that failed.
      // workers/site enqueues verified inbound WhatsApp messages here and
      // has done since WP 4.8; nothing consumed them until 2026-09-05, so
      // every subscribe/unsubscribe command was acked to Meta and dropped.
      case "whatsapp-hook":
        return handleWhatsappHookQueue(batch, env);
      case "jobs-dlq":
      case "cache-purge-dlq":
      case "whatsapp-hook-dlq":
        return handleJobsDlq(batch as MessageBatch<any>, env);
      default:
        console.error(`givefood2-jobs: unhandled queue "${batch.queue}"`);
    }
  },
} satisfies ExportedHandler<Env>;
