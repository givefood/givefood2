import type { Session } from "./types";

// gfadmin/views.py:46-95 index()'s "stats" dict -- the dashboard's third
// (Metrics) panel. tasks_24h/tasks_outstanding are NOT ported: Django reads
// them from django_tasks_db.DBTaskResult, a Postgres-backed history table
// django-tasks maintains for every background task it runs -- Cloudflare
// Queues has no equivalent (no queryable log of recent/outstanding
// messages a consumer can read back). Disclosed gap, not silently dropped;
// see PLAN.md's WP 6.4 dashboard note.

export interface FoodbankEditRow {
  name: string;
  slug: string;
  edited: string | null;
}

export interface FoodbankNeedCheckRow {
  name: string;
  slug: string;
  last_need_check: string | null;
}

export interface AdminDashboardStats {
  oldestEdit: FoodbankEditRow | null;
  oldestEditDays: number | null;
  latestEdit: FoodbankEditRow | null;
  needCount24h: number;
  needCheck24h: number;
  articleCheck24h: number;
  charityCheck24h: number;
  oldestNeedCheck: FoodbankNeedCheckRow | null;
  latestNeedCheck: FoodbankNeedCheckRow | null;
  latestNeedCrawlSetId: number | null;
}

export async function getAdminDashboardStats(session: Session, now: Date): Promise<AdminDashboardStats> {
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const [oldestEdit, latestEdit, needCount24h, crawlCounts, oldestNeedCheck, latestNeedCheck, latestNeedCrawlSet] = await Promise.all([
    session.prepare("SELECT name, slug, edited FROM foodbank WHERE is_closed = 0 ORDER BY edited ASC LIMIT 1").first<FoodbankEditRow>(),
    session.prepare("SELECT name, slug, edited FROM foodbank WHERE is_closed = 0 ORDER BY edited DESC LIMIT 1").first<FoodbankEditRow>(),
    session.prepare("SELECT COUNT(*) AS c FROM foodbankchangeline WHERE created >= ?").bind(yesterday).first<{ c: number }>(),
    session
      .prepare("SELECT crawl_type, COUNT(*) AS c FROM crawlitem WHERE finish >= ? GROUP BY crawl_type")
      .bind(yesterday)
      .all<{ crawl_type: string; c: number }>(),
    // gfadmin/views.py:88's Facebook-shopping-list exclusion: those food
    // banks are known never to have a real need-check URL, so they'd
    // permanently squat "oldest" otherwise.
    session
      .prepare("SELECT name, slug, last_need_check FROM foodbank WHERE is_closed = 0 AND (shopping_list_url IS NULL OR shopping_list_url NOT LIKE '%facebook.com%') ORDER BY last_need_check ASC LIMIT 1")
      .first<FoodbankNeedCheckRow>(),
    session
      .prepare("SELECT name, slug, last_need_check FROM foodbank WHERE is_closed = 0 AND last_need_check IS NOT NULL ORDER BY last_need_check DESC LIMIT 1")
      .first<FoodbankNeedCheckRow>(),
    session.prepare("SELECT id FROM crawlset WHERE crawl_type = 'need' ORDER BY start DESC LIMIT 1").first<{ id: number }>(),
  ]);

  const countByType = new Map(crawlCounts.results.map((r) => [r.crawl_type, r.c]));
  const oldestEditDays = oldestEdit?.edited ? Math.floor((now.getTime() - new Date(oldestEdit.edited).getTime()) / (24 * 60 * 60 * 1000)) : null;

  return {
    oldestEdit: oldestEdit ?? null,
    oldestEditDays,
    latestEdit: latestEdit ?? null,
    needCount24h: needCount24h?.c ?? 0,
    needCheck24h: countByType.get("need") ?? 0,
    articleCheck24h: countByType.get("article") ?? 0,
    charityCheck24h: countByType.get("charity") ?? 0,
    oldestNeedCheck: oldestNeedCheck ?? null,
    latestNeedCheck: latestNeedCheck ?? null,
    latestNeedCrawlSetId: latestNeedCrawlSet?.id ?? null,
  };
}

// gfadmin/views.py:361-366 foodbanks_next() -- the check page's "Next"
// button, working through the review queue oldest-edited-first. Same
// query as this file's own oldestEdit stat, standalone since that one is
// read-only display and this needs just the slug to redirect with.
export async function getOldestEditedFoodbankSlug(session: Session): Promise<string | null> {
  const row = await session.prepare("SELECT slug FROM foodbank WHERE is_closed = 0 ORDER BY edited ASC LIMIT 1").first<{ slug: string }>();
  return row?.slug ?? null;
}
