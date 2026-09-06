import type { Session } from "./types";
import { formatTimedelta, parseD1Timestamp } from "./foodbankTabs";

// gfadmin/views.py:3228-3280 crawl_sets() / crawl_set() -- the two HTML
// pages behind the admin navbar's "Crawls" item. The JSON endpoint they poll
// (crawl_set_json) already lives in foodbankTabs.ts alongside the food bank
// detail page's own crawls tab; only these two read paths were missing.

// gfadmin/views.py:3230 -- the allowlist is the view's own literal list, and
// Django 403s an unrecognised value rather than ignoring it. Kept as a 403
// here too: unlike the list-sort allowlists elsewhere in this admin (where an
// unknown ?sort= silently falls back), this one is a filter, and silently
// showing ALL crawl sets when the caller asked for one type would be a wrong
// answer rather than a differently-ordered one.
export const CRAWL_TYPE_OPTIONS = ["need", "article", "charity", "discrepancy", "check", "urls"] as const;
export type CrawlTypeOption = (typeof CRAWL_TYPE_OPTIONS)[number];

export function isCrawlTypeOption(value: string): value is CrawlTypeOption {
  return (CRAWL_TYPE_OPTIONS as readonly string[]).includes(value);
}

export interface CrawlSetListRow {
  id: number;
  crawl_type: string;
  start: string;
  finish: string | null;
  time_taken: string | null;
  item_count: number;
  object_count: number;
}

// Django annotates with Count('crawlitem') and a filtered
// Count('crawlitem', filter=Q(object_id__isnull=False)). Both become
// correlated aggregate subqueries here rather than a GROUP BY join, because
// the outer query is already LIMITed to 50 -- so the subqueries run 50 times
// against crawlitem_crawlset_idx, instead of grouping the whole table and
// throwing nearly all of it away. object_id is this port's crawlitem.need_id
// (0008_needcheck.sql collapses Django's generic FK to the one content type
// it ever holds).
const CRAWL_SET_LIST_SQL = `
  SELECT cs.id, cs.crawl_type, cs.start, cs.finish,
         (SELECT COUNT(*) FROM crawlitem ci WHERE ci.crawl_set_id = cs.id) AS item_count,
         (SELECT COUNT(*) FROM crawlitem ci WHERE ci.crawl_set_id = cs.id AND ci.need_id IS NOT NULL) AS object_count
  FROM crawlset cs
`;

export async function getCrawlSets(session: Session, crawlType: CrawlTypeOption | null, limit: number): Promise<CrawlSetListRow[]> {
  const where = crawlType ? "WHERE cs.crawl_type = ?" : "";
  const binds = crawlType ? [crawlType, limit] : [limit];
  const result = await session
    .prepare(`${CRAWL_SET_LIST_SQL} ${where} ORDER BY cs.start DESC LIMIT ?`)
    .bind(...binds)
    .all<Omit<CrawlSetListRow, "time_taken">>();
  return result.results.map((r) => ({
    ...r,
    // CrawlSet.time_taken() is a timedelta Django renders as its str()
    // ("0:04:32"), so it is formatted here rather than handed to the route
    // as a number -- one helper shared with the JSON endpoint's own
    // `time_taken`, which is the same string in Django too.
    time_taken: r.finish ? formatTimedelta(parseD1Timestamp(r.finish) - parseD1Timestamp(r.start)) : null,
  }));
}

export interface OrphanedCrawlItemRow {
  id: number;
  crawl_type: string;
  start: string;
  url: string | null;
  foodbank_name: string;
  foodbank_slug: string;
  need_uuid: string | null;
}

// gfadmin/views.py:3251-3257 -- "Ad Hoc Crawls": CrawlItems with no CrawlSet,
// i.e. a single food bank crawled on its own (the "Force Check" / "Force
// Article Crawl" buttons on the food bank detail page create exactly these).
export async function getOrphanedCrawlItems(session: Session, crawlType: CrawlTypeOption | null, limit: number): Promise<OrphanedCrawlItemRow[]> {
  const typeClause = crawlType ? "AND ci.crawl_type = ?" : "";
  const binds = crawlType ? [crawlType, limit] : [limit];
  const result = await session
    .prepare(
      `SELECT ci.id, ci.crawl_type, ci.start, ci.url, f.name AS foodbank_name, f.slug AS foodbank_slug,
              fc.need_id AS need_uuid
       FROM crawlitem ci
       JOIN foodbank f ON f.id = ci.foodbank_id
       LEFT JOIN foodbankchange fc ON fc.id = ci.need_id
       WHERE ci.crawl_set_id IS NULL ${typeClause}
       ORDER BY ci.start DESC LIMIT ?`,
    )
    .bind(...binds)
    .all<OrphanedCrawlItemRow>();
  return result.results;
}

export interface RunningCrawlSetRow {
  id: number;
  crawl_type: string;
  start: string;
  expected: number | null;
  remaining: number | null;
  done: number | null;
  running_for: string;
}

// The "is anything crawling right now" half of the jobs page. A crawl set is
// running exactly when it has no finish -- the same test crawl_sets.njk
// already renders as a red "Unfinished", but read here as its own query so
// the jobs page does not have to pull 50 rows to find the nought-to-two that
// matter.
//
// NOT the same thing as "unfinished". A row whose consumer died keeps
// finish NULL forever, so an old start here is a STUCK crawl, not a busy
// one -- which is precisely why running_for is computed and shown. The page
// is what makes that visible; nothing cleans these up.
export async function getRunningCrawlSets(session: Session, now: number = Date.now()): Promise<RunningCrawlSetRow[]> {
  const result = await session
    .prepare(
      `SELECT id, crawl_type, start, expected, remaining
       FROM crawlset WHERE finish IS NULL ORDER BY start DESC`,
    )
    .all<Omit<RunningCrawlSetRow, "done" | "running_for">>();
  return result.results.map((r) => ({
    ...r,
    // expected/remaining are the queue's own countdown (scheduled/index.ts
    // decrements remaining as each render lands), so done is derived rather
    // than stored -- there is no third column to drift out of step.
    done: r.expected !== null && r.remaining !== null ? r.expected - r.remaining : null,
    running_for: formatTimedelta(now - parseD1Timestamp(r.start)),
  }));
}

export interface CrawlTypeLastRun {
  crawl_type: string;
  last_start: string;
  last_finish: string | null;
  last_set_id: number;
}

// Last run per crawl type, for pairing each cron trigger with the last thing
// it actually did. One row per type via a correlated MAX rather than a window
// function: there are six types and a few dozen rows, and this keeps to the
// same plain-SQL vocabulary as the rest of this file.
export async function getCrawlTypeLastRuns(session: Session): Promise<CrawlTypeLastRun[]> {
  const result = await session
    .prepare(
      `SELECT cs.crawl_type, cs.start AS last_start, cs.finish AS last_finish, cs.id AS last_set_id
       FROM crawlset cs
       WHERE cs.start = (SELECT MAX(c2.start) FROM crawlset c2 WHERE c2.crawl_type = cs.crawl_type)
       ORDER BY cs.start DESC`,
    )
    .all<CrawlTypeLastRun>();
  return result.results;
}
