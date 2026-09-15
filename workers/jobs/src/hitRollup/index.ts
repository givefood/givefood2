import type { Env } from "../../worker-configuration";
import { HIT_ROLLUP_FIRST_DAY, upsertFoodbankHitsForDay } from "@givefood/db";
import { isoDate } from "@givefood/models";

// PLAN.md §10.7.3's rollup: Analytics Engine -> D1 `foodbankhit`. The hit
// beacon (workers/site/src/routes/wfbn/hit.ts) writes AE only, and AE keeps
// three months, so this is what keeps "most viewed this week" (homepage,
// country pages, /md/), the footer's /frag/need-hits/ and the admin's 28-day
// hits alive. It was planned from the start and never built; everything
// reading foodbankhit ran on the ETL's last load until that aged out of the
// 7-day window. See packages/db/src/hits.ts.
//
// HOURLY, over yesterday AND today (UTC, the same days the homepage window
// counts in). The plan said nightly for yesterday; that leaves "today" empty
// until tomorrow in a window that includes today. Re-reading yesterday on
// every run also settles it: the 00:xx run is the first after it closed, and
// AE ingestion lag is seconds. Two days of ~1,000 food banks is two D1
// statements, since each day is a single upsert.
const AE_SQL_ENDPOINT = "https://api.cloudflare.com/client/v4/accounts";

// SUM(_sample_interval), NEVER COUNT(): AE samples busy index values, and
// COUNT under-reports exactly the food banks at the top of the list.
// `index1` is the slug (hit.ts writes it as indexes[0]). The day bounds are
// generated below from a Date, never from input.
function dayQuery(day: string): string {
  return (
    "SELECT index1 AS slug, SUM(_sample_interval) AS hits FROM foodbank_hits " +
    `WHERE timestamp >= toDateTime('${day} 00:00:00') AND timestamp < toDateTime('${day} 00:00:00') + INTERVAL '1' DAY ` +
    "GROUP BY slug FORMAT JSON"
  );
}

// Exported for the test. Throws on anything but a clean answer: a partial or
// empty result written as SET would wipe that day's counts.
export async function readDayFromAnalyticsEngine(env: Env, day: string): Promise<Record<string, number>> {
  const res = await fetch(`${AE_SQL_ENDPOINT}/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_API_KEY}` },
    body: dayQuery(day),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `hitRollup: Analytics Engine SQL API returned ${res.status} -- CF_API_KEY needs the ` +
        `"Account Analytics: Read" permission on account ${env.CF_ACCOUNT_ID}. ${await res.text()}`,
    );
  }
  if (!res.ok) throw new Error(`hitRollup: Analytics Engine SQL API returned ${res.status} for ${day}: ${await res.text()}`);

  // UInt64 columns come back as JSON strings ("hits": "179").
  const payload = (await res.json()) as { data?: { slug: string; hits: string | number }[] };
  if (!Array.isArray(payload.data)) throw new Error(`hitRollup: no data array in the AE response for ${day}`);
  const hitsBySlug: Record<string, number> = {};
  for (const row of payload.data) {
    const hits = Number(row.hits);
    if (row.slug && Number.isFinite(hits) && hits > 0) hitsBySlug[row.slug] = hits;
  }
  return hitsBySlug;
}

export async function hitRollup(env: Env, scheduledTime: number): Promise<void> {
  const today = new Date(scheduledTime);
  const yesterday = new Date(scheduledTime);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const days = [isoDate(yesterday), isoDate(today)].filter((day) => day >= HIT_ROLLUP_FIRST_DAY);

  const session = env.DB.withSession("first-unconstrained");
  // Sequential and independent: one day failing still rolls up the other,
  // and the next hourly run retries both.
  for (const day of days) {
    try {
      const hitsBySlug = await readDayFromAnalyticsEngine(env, day);
      const slugs = Object.keys(hitsBySlug).length;
      const written = await upsertFoodbankHitsForDay(session, day, hitsBySlug);
      console.log(`hitRollup: ${day} -- ${written} food bank(s) written from ${slugs} slug(s) in Analytics Engine`);
    } catch (err) {
      console.error(`hitRollup: ${day} failed --`, err);
    }
  }
}
