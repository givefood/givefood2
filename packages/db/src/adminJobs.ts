import type { Session } from "./types";

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
  const now = new Date().toISOString();
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
    .bind(JSON.stringify(result), new Date().toISOString(), id)
    .run();
}

export async function markAdminJobFailed(session: Session, id: string, error: string): Promise<void> {
  await session
    .prepare("UPDATE admin_job SET status = 'failed', error = ?, finished = ? WHERE id = ?")
    .bind(error, new Date().toISOString(), id)
    .run();
}

// Most recent job of a given kind for a target -- the check page's own
// "has this food bank got a check running/already done" lookup, so a
// GET with no `?job=` can still show the latest result rather than
// forcing a fresh run every visit.
export async function getLatestAdminJob(session: Session, kind: string, target: string): Promise<AdminJobRow | null> {
  return session.prepare("SELECT * FROM admin_job WHERE kind = ? AND target = ? ORDER BY created DESC LIMIT 1").bind(kind, target).first<AdminJobRow>();
}
