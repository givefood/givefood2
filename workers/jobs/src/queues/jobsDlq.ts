import type { Env } from "../../worker-configuration";

// jobs-dlq and cache-purge-dlq, the two dead-letter queues that had no
// handler.
//
// jobs-dlq WAS DECLARED AS A CONSUMER (wrangler.jsonc) but had no `case` in
// index.ts, so every message that reached it fell through to the default
// branch, logged `unhandled queue "jobs-dlq"`, went unacked, was retried
// once (max_retries: 1) and was then dropped. Self-draining, so there was
// never a growing backlog -- but the log line named the QUEUE and not the
// message, so months of failed photo backfills produced no record of WHICH
// key had failed. That is the thing worth fixing: a dead-letter queue whose
// only output is its own name is a dead letter office that burns the post.
//
// cache-purge-dlq was not declared as a consumer at all, so anything
// arriving sat until the retention period expired. It is declared now.
//
// NEITHER RETRIES. A message is here because it already exhausted its
// retries on the real queue; retrying it a fourth time is how a poison
// message becomes an infinite loop. They are logged and acked.
//
// A DLQ handler is not the place to fix anything. The pattern the other DLQ
// consumers follow (articlesDlq.ts, charityDlq.ts) is: undo whatever
// bookkeeping the failed job would have completed -- a CrawlSet's
// `remaining` counter that would otherwise never reach 0 -- and log. These
// two jobs have no such bookkeeping, so logging is all there is.

interface UnknownJob {
  type?: string;
  key?: string;
  jobId?: string;
  needId?: number;
  tags?: string[];
}

// Enough to identify the failure without dumping a whole message body into
// the log: the job type, plus whichever identifying field that type carries.
function describe(body: UnknownJob | undefined): string {
  if (!body) return "(empty body)";
  const parts = [body.type ?? "(no type)"];
  if (body.key) parts.push(`key=${body.key}`);
  if (body.jobId) parts.push(`jobId=${body.jobId}`);
  if (body.needId !== undefined) parts.push(`needId=${body.needId}`);
  if (body.tags?.length) parts.push(`tags=${body.tags.join(",")}`);
  return parts.join(" ");
}

export async function handleJobsDlq(batch: MessageBatch<UnknownJob>, _env: Env): Promise<void> {
  for (const message of batch.messages) {
    console.error(`${batch.queue}: gave up on ${describe(message.body)}`);
    message.ack();
  }
}
