import type { Env } from "../worker-configuration";
import { handleScheduled } from "./scheduled";
import { handleJobsQueue } from "./queues/jobs";

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
      case "needcheck-render-dlq":
      case "cache-purge":
        // TODO: build out per PLAN.md §3.10/§8 and §3.6 "Purge: cache tags,
        // not URLs". Not implemented -- retry everything rather than
        // silently drop while these are unbuilt.
        for (const message of batch.messages) message.retry();
        return;
      default:
        console.error(`givefood-jobs: unhandled queue "${batch.queue}"`);
    }
  },
} satisfies ExportedHandler<Env>;
