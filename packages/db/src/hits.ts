import type { Session } from "./types";

// The D1 half of PLAN.md §10.7.3's hit rollup. workers/site's hit beacon
// (routes/wfbn/hit.ts) writes to Analytics Engine only; every READER --
// getMostViewed/getMostViewedByCountry (homepage, country pages, /md/),
// getRecentHitsTotal (the footer's /frag/need-hits/) and the admin's
// hits_last_28_days -- reads `foodbankhit`. Nothing joined the two until
// 2026-09-15: the table was only ever filled by the Postgres ETL, stopped at
// 2026-09-05, and "most viewed this week" went empty once its 7-day window
// slid past that date.
//
// The first day this rollup may write. 2026-09-05 is the cutover day: D1
// holds Django's partial count for it (872,477) and AE holds the Workers'
// (923), and an upsert of either would overwrite the other. Earlier days are
// Django's alone. Leaving the cutover day as Django had it undercounts it by
// about 0.1%; overwriting it would lose 99.9%.
export const HIT_ROLLUP_FIRST_DAY = "2026-09-06";

// Replaces `day`'s rows with `hitsBySlug` (Analytics Engine keys hits by
// slug; foodbankhit by id). ONE statement however many food banks there are:
// the counts travel as a single JSON object and are resolved to ids inside
// SQLite, which keeps the whole day under D1's per-statement bound-parameter
// cap and its per-invocation query cap alike.
//
// SET, not ADD. The cron re-reads the whole day from AE each run, so the
// upsert must be idempotent -- `hits = hits + excluded.hits` would double
// every count the second time a day is rolled up.
//
// A slug with no food bank (deleted, or renamed since the hit) is dropped by
// the join; the return value is the number of rows written, so the caller
// can log the gap.
//
// `WHERE true` is not decoration: SQLite cannot otherwise tell whether ON
// CONFLICT belongs to the upsert or to the SELECT's join, and rejects the
// statement ("parser ambiguity", sqlite.org/lang_upsert.html).
export async function upsertFoodbankHitsForDay(
  session: Session,
  day: string,
  hitsBySlug: Record<string, number>,
): Promise<number> {
  if (day < HIT_ROLLUP_FIRST_DAY) throw new Error(`upsertFoodbankHitsForDay: ${day} is before ${HIT_ROLLUP_FIRST_DAY}, Django's data`);
  const result = await session
    .prepare(
      "INSERT INTO foodbankhit (foodbank_id, day, hits) " +
        "SELECT f.id, ?1, j.value FROM json_each(?2) j JOIN foodbank f ON f.slug = j.key WHERE true " +
        "ON CONFLICT (foodbank_id, day) DO UPDATE SET hits = excluded.hits",
    )
    .bind(day, JSON.stringify(hitsBySlug))
    .run();
  return result.meta.changes;
}
