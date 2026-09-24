import type { Session } from "./types";

// Shared by workers/site's frag route (the reader, and the writer on a
// cache-miss self-heal) and workers/jobs' fragRefresh cron (the regular
// writer) -- both already depend on this package, so the key names live
// here once rather than as hand-synced literals in two separate,
// independently-deployable Workers (PLAN.md §3.1).
export const FRAG_KV_KEY_LAST_UPDATED = "frag:last-updated";
export const FRAG_KV_KEY_NEED_HITS = "frag:need-hits";

// givefood/views.py's frag() -- "last-updated": `Foodbank.objects.latest
// ("modified").modified`. MAX() over the already-migrated
// foodbank_modified_idx index is the same answer as ORDER BY modified DESC
// LIMIT 1, without needing a row shape back.
//
// Only as fresh as the writes that stamp foodbank.modified: the food bank
// forms, orders, and -- the one that moves daily -- any change to a
// published need (needAdmin.ts's recomputeFoodbankNeedFields). A write that
// updates a food bank's needs without stamping it leaves this footer days
// behind the site.
export async function getLastModifiedFoodbank(session: Session): Promise<string | null> {
  const row = await session.prepare("SELECT MAX(modified) AS modified FROM foodbank").first<{ modified: string | null }>();
  return row?.modified ?? null;
}

// frag()'s "need-hits": SUM(hits) over the trailing 7 days, day >=
// sinceDay with NO upper bound (matching Django's day__gte with no
// day__lte -- a future-dated row, if one ever existed, would count too).
// Returns null when there are zero matching rows (SQLite's SUM() over an
// empty set is NULL, same as Postgres's), matching Django's own
// aggregate()['hits__sum'] being None in that case.
export async function getRecentHitsTotal(session: Session, sinceDay: string): Promise<number | null> {
  const row = await session.prepare("SELECT SUM(hits) AS total FROM foodbankhit WHERE day >= ?").bind(sinceDay).first<{ total: number | null }>();
  return row?.total ?? null;
}
