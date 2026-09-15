import type { Context } from "hono";
import {
  getRunningCrawlSets,
  getCrawlTypeLastRuns,
  getRecentAdminJobs,
  getAdminJobCounts,
  crawlTypeIcon,
} from "@givefood/db";
import { render } from "@givefood/templates";
import { pyDatetime } from "@givefood/models";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { adminPageContext } from "./pageContext";
import { getQueueBacklog } from "../../lib/queueBacklog";

// "All the jobs that are running" -- maintainer request, 2026-09-06. This
// page has no Django ancestor: gfadmin showed two NUMBERS on its index
// (tasks_24h and tasks_outstanding, gfadmin/views.py:75-80) read from
// django-tasks' own DBTaskResult history table, and the port dropped both
// because Cloudflare Queues keeps no such table. So this is a deliberate
// divergence rather than a port, and it is assembled from the three places
// the work actually leaves a trace:
//
//   1. crawlset       -- D1. Sweeps in flight, and stuck ones.
//   2. admin_job      -- D1. Button-triggered work; had no list view at all.
//   3. queue backlog  -- Cloudflare's API. The only sighting of a DLQ.
//
// None of the three sees the other two, which is exactly why they belong on
// one page.
const ADMIN_JOB_LIMIT = 25;

// workers/jobs/wrangler.jsonc's "triggers.crons", kept in the same order and
// paired with the crawl_type each one writes (null where a job records no
// crawl set, so the page shows the schedule and says so rather than
// implying a missing run).
//
// DUPLICATED FROM THAT FILE ON PURPOSE, and the risk is real: a schedule
// changed there and not here shows the admin a stale promise. It is
// duplicated anyway because wrangler.jsonc is deploy-time config for a
// DIFFERENT Worker -- workers/site cannot import it, and there is no runtime
// API that asks "what are givefood2-jobs' triggers". A wrong schedule here
// is cosmetic; the alternative was not showing the schedule at all.
//
// ALL TIMES ARE UTC. Cloudflare's cron scheduler has no timezone setting, so
// the 15:00 needcheck is 16:00 during British Summer Time -- the single most
// confusing thing about this system, and the reason the column is labelled.
const CRON_JOBS: { schedule: string; name: string; description: string; crawl_type: string | null }[] = [
  { schedule: "0 15 * * *", name: "needcheck", description: "Full sweep of every food bank's needs page", crawl_type: "need" },
  { schedule: "20 8-22/2 * * *", name: "getarticles", description: "News/article feeds, every 2 hours", crawl_type: "article" },
  { schedule: "30 5 * * *", name: "charityinfo", description: "Charity register details", crawl_type: "charity" },
  { schedule: "30 3 * * SUN", name: "days_between_needs", description: "Weekly recompute (one SQL statement)", crawl_type: null },
  { schedule: "10 3 * * *", name: "crawlitem prune", description: "Crawl item retention prune", crawl_type: null },
  { schedule: "*/5 * * * *", name: "frag refresh", description: "/frag/ payload refresh into KV", crawl_type: null },
  { schedule: "30 4 * * *", name: "dump", description: "Daily CSV dumps to R2 (github #59)", crawl_type: null },
  { schedule: "7 * * * *", name: "hit rollup", description: "Analytics Engine hits into foodbankhit, hourly", crawl_type: null },
  { schedule: "37 * * * *", name: "site stats", description: "Homepage totals recomputed into site_stats, hourly", crawl_type: null },
];

export async function adminJobsList(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const now = Date.now();
  const since = pyDatetime(new Date(now - 86_400_000));

  // The three sources are independent, so they go out together -- the
  // Cloudflare call is the slow one and there is no reason for D1 to wait
  // behind it. getQueueBacklog resolves rather than rejects on failure, so
  // one dead API cannot take the page down with it.
  const [running, lastRuns, adminJobs, counts, backlog] = await Promise.all([
    getRunningCrawlSets(db, now),
    getCrawlTypeLastRuns(db),
    getRecentAdminJobs(db, ADMIN_JOB_LIMIT),
    getAdminJobCounts(db, since),
    getQueueBacklog(c.env, now),
  ]);

  const lastByType = new Map(lastRuns.map((r) => [r.crawl_type, r]));
  const crons = CRON_JOBS.map((job) => {
    const last = job.crawl_type ? lastByType.get(job.crawl_type) : undefined;
    return {
      ...job,
      crawl_type_icon: job.crawl_type ? crawlTypeIcon(job.crawl_type) : "",
      last_start: last?.last_start ?? null,
      last_finish: last?.last_finish ?? null,
      last_set_id: last?.last_set_id ?? null,
    };
  });

  // null messages means "depth unknown", which must not total as zero -- the
  // counters go null so the page shows a dash rather than a reassuring 0.
  const haveDepths = backlog.queues.some((q) => q.messages !== null);
  const queuedMessages = haveDepths ? backlog.queues.reduce((n, q) => n + (q.messages ?? 0), 0) : null;
  const dlqMessages = haveDepths ? backlog.queues.reduce((n, q) => n + (q.is_dlq ? (q.messages ?? 0) : 0), 0) : null;

  const html = await render("admin/jobs.njk", {
    ...(await adminPageContext(c, "jobs")),
    running_crawl_sets: running.map((cs) => ({ ...cs, crawl_type_icon: crawlTypeIcon(cs.crawl_type) })),
    crons,
    admin_jobs: adminJobs,
    queue_backlog: backlog.queues,
    queue_error: backlog.error,
    stats: {
      running_count: running.length,
      queued_messages: queuedMessages,
      // Broken out from queued_messages rather than added to it: a message
      // in a DLQ is not work in progress, it is work that has already failed
      // every retry it is going to get.
      dlq_messages: dlqMessages,
      admin_jobs_outstanding: counts.outstanding,
      admin_jobs_24h: counts.finished_24h,
    },
  });
  return c.html(html);
}
