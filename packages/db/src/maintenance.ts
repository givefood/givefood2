import type { Session } from "./types";

// WP 5.7 (PLAN.md §8.9): days_between_needs.py's N+1 (~4,000 queries +
// 1,024 full model saves, weekly) collapsed into one window-function
// statement -- deliberately not fanned onto a Queue ("faithfully
// reproduces a design mistake in a more expensive place").
//
// Verified directly against all 1,023 real open food banks on production
// Postgres (0 mismatches) that this exactly reproduces Django's formula --
// `needs = latest 5 FoodbankChange; if len==5:
// int(-((needs[4].created - now()).days) / 5)` -- including its
// truncation semantics, which PLAN.md itself flags as needing verification:
// Python's `.days` on a negative timedelta floors (toward -infinity)
// *before* the /5 division, then `int()` truncates toward zero. A naive
// `CAST(julianday_diff / 5 AS INTEGER)` skips that floor step and gets it
// wrong right at 5-day boundaries -- confirmed empirically: an elapsed
// time of 9.99 days must give 2 (Django: floor(-9.99)=-10, int(10/5)=2),
// not 1 (raw 9.99/5=1.998, truncated). Fixed by ceiling the elapsed real-
// number-of-days FIRST (`CAST(x AS INTEGER) + (CAST(x AS INTEGER) < x)` --
// SQLite's CAST truncates toward zero, which equals floor for this always-
// non-negative x, so this is floor(-x) negated, i.e. ceil(x)), matching
// Django's floor-of-the-negative-difference exactly, THEN dividing by 5
// and truncating. Verified against real D1 too, including this exact
// 9.99-day edge case.
export async function updateDaysBetweenNeeds(session: Session): Promise<void> {
  await session
    .prepare(
      `WITH ranked AS (
         SELECT foodbank_id, created,
                ROW_NUMBER() OVER (PARTITION BY foodbank_id ORDER BY created DESC) AS rn,
                COUNT(*)    OVER (PARTITION BY foodbank_id)                       AS n
         FROM foodbankchange
       ),
       fifth AS (
         SELECT foodbank_id,
                julianday('now') - julianday(created) AS elapsed
         FROM ranked WHERE rn = 5 AND n >= 5
       )
       UPDATE foodbank
          SET days_between_needs = COALESCE(
            (SELECT CAST((CAST(f.elapsed AS INTEGER) + (CAST(f.elapsed AS INTEGER) < f.elapsed)) / 5 AS INTEGER)
               FROM fifth f WHERE f.foodbank_id = foodbank.id), 0)
        WHERE is_closed = 0`,
    )
    .run();
}

// WP 5.7 (PLAN.md §8.10.2): prune_db_task_results's old cron slot,
// repointed at the real growth problem -- crawlitem has no retention
// policy at all in Django and grows ~5,845 rows/day forever. Chunked
// (LIMIT 5000/statement, capped at 50 iterations = 250,000 rows/run) so no
// single DELETE approaches D1's 30s query limit; stops as soon as a batch
// deletes nothing.
export async function pruneCrawlItems(session: Session): Promise<number> {
  let totalDeleted = 0;
  for (let i = 0; i < 50; i++) {
    const result = await session
      .prepare(`DELETE FROM crawlitem WHERE id IN (SELECT id FROM crawlitem WHERE start < datetime('now', '-30 days') LIMIT 5000)`)
      .run();
    const deleted = result.meta.changes;
    totalDeleted += deleted;
    if (deleted === 0) break;
  }
  return totalDeleted;
}

export async function pruneCrawlSets(session: Session): Promise<number> {
  const result = await session.prepare(`DELETE FROM crawlset WHERE start < datetime('now', '-30 days')`).run();
  return result.meta.changes;
}

// Backstop, not the primary mechanism -- every WP 5.2/5.5 cron (needcheck/
// articles/charityinfo) already self-stamps crawlset.finish the instant
// its expected/remaining counter reaches 0 (decrementCrawlSetRemaining,
// needcheck.ts), which PLAN.md's own §8.10.2 design predates. This only
// catches a CrawlSet whose counter never reached 0 -- e.g. a food bank
// deleted mid-run, whose message was never processed to decrement against
// -- which would otherwise leave finish NULL forever, the same
// "confirmed on production" bug this whole mechanism exists to fix.
// Restricted to runs at least a day old so an in-progress run's still-
// legitimately-NULL finish is never stamped early.
export async function finishStaleCrawlSets(session: Session): Promise<void> {
  await session
    .prepare(
      `UPDATE crawlset SET finish = (SELECT max(finish) FROM crawlitem WHERE crawl_set_id = crawlset.id)
        WHERE finish IS NULL AND start < datetime('now', '-1 day')`,
    )
    .run();
}
