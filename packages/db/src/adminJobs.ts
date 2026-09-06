import type { Session } from "./types";
import { pyNow } from "@givefood/models";

// WP 6.8 (PLAN.md §9.4.4): the enqueue/poll backing store for
// admin-triggered background work. See migrations/0013_admin_jobs.sql's
// own comment for the schema's origin.
export type AdminJobStatus = "queued" | "running" | "done" | "failed";

export interface AdminJobRow {
  id: string;
  kind: string;
  target: string | null;
  status: AdminJobStatus;
  result: string | null;
  error: string | null;
  created: string;
  finished: string | null;
}

export async function insertAdminJob(session: Session, params: { id: string; kind: string; target: string | null }): Promise<void> {
  const now = pyNow();
  await session
    .prepare("INSERT INTO admin_job (id, kind, target, status, created) VALUES (?, ?, ?, 'queued', ?)")
    .bind(params.id, params.kind, params.target, now)
    .run();
}

export async function getAdminJob(session: Session, id: string): Promise<AdminJobRow | null> {
  return session.prepare("SELECT * FROM admin_job WHERE id = ?").bind(id).first<AdminJobRow>();
}

export async function markAdminJobRunning(session: Session, id: string): Promise<void> {
  await session.prepare("UPDATE admin_job SET status = 'running' WHERE id = ?").bind(id).run();
}

export async function markAdminJobDone(session: Session, id: string, result: unknown): Promise<void> {
  await session
    .prepare("UPDATE admin_job SET status = 'done', result = ?, finished = ? WHERE id = ?")
    .bind(JSON.stringify(result), pyNow(), id)
    .run();
}

export async function markAdminJobFailed(session: Session, id: string, error: string): Promise<void> {
  await session
    .prepare("UPDATE admin_job SET status = 'failed', error = ?, finished = ? WHERE id = ?")
    .bind(error, pyNow(), id)
    .run();
}

// Most recent job of a given kind for a target -- the check page's own
// "has this food bank got a check running/already done" lookup, so a
// GET with no `?job=` can still show the latest result rather than
// forcing a fresh run every visit.
export async function getLatestAdminJob(session: Session, kind: string, target: string): Promise<AdminJobRow | null> {
  return session.prepare("SELECT * FROM admin_job WHERE kind = ? AND target = ? ORDER BY created DESC LIMIT 1").bind(kind, target).first<AdminJobRow>();
}

// The jobs page's list. There has never been a list view for this table --
// /admin/job/:id/ answers about ONE job whose id the caller already has,
// which is fine for the poll that follows a button press and useless for
// "what has been running". Django had no equivalent either: its admin read
// django_tasks_db.DBTaskResult, which this port has no counterpart for
// (see adminDashboardStats.ts). This is the nearest honest replacement for
// the half of it that lives in D1.
//
// `queued` and `running` first, then most recent: a stuck job matters more
// than a finished one, and a queued job whose consumer never picked it up
// sorts to the top where it can be seen rather than ageing quietly down the
// list. Within a status band it is newest-first, as everywhere else here.
export async function getRecentAdminJobs(session: Session, limit: number): Promise<AdminJobRow[]> {
  const result = await session
    .prepare(
      `SELECT * FROM admin_job
       ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, created DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<AdminJobRow>();
  return result.results;
}

// Counts for the page's header line, over the same 24h window Django's
// tasks_24h used (gfadmin/views.py:75-80). `outstanding` is the D1 half of
// what Django called tasks_outstanding -- the queue half cannot come from
// here at all, and arrives from the Cloudflare API instead.
export async function getAdminJobCounts(session: Session, since: string): Promise<{ finished_24h: number; outstanding: number }> {
  const row = await session
    .prepare(
      `SELECT
         COUNT(*) FILTER (WHERE finished >= ? AND status IN ('done','failed')) AS finished_24h,
         COUNT(*) FILTER (WHERE status IN ('queued','running'))                AS outstanding
       FROM admin_job`,
    )
    .bind(since)
    .first<{ finished_24h: number; outstanding: number }>();
  return row ?? { finished_24h: 0, outstanding: 0 };
}
