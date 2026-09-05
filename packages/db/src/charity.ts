import type { Session } from "./types";
import { pyNow } from "@givefood/models";

// WP 5.5 (PLAN.md §8.7): charityinfo's own D1 access -- the cron handler
// (enqueueing one message per charity-numbered food bank, split by
// country into three independent queues -- CHARITY_EW_Q/CHARITY_SCOTLAND_Q/
// CHARITY_NI_Q) and each regulator's crawler (a targeted patch of only the
// fields that regulator's API actually returned, plus a full
// delete-and-reinsert of that food bank's CharityYear rows).

export interface CharityFoodbankRow {
  id: number;
  slug: string;
}

// crawlers.py:79-101's `foodbank_charity_crawl` country branch, applied at
// the SQL level instead of in application code -- one query per regulator
// queue rather than one shared query filtered in JS, so each cron handler
// only ever touches the food banks it's actually responsible for.
export async function getFoodbanksByCountryForCharityCrawl(session: Session, countries: string[]): Promise<CharityFoodbankRow[]> {
  const placeholders = countries.map((_, i) => `?${i + 1}`).join(", ");
  const result = await session
    .prepare(
      `SELECT id, slug FROM foodbank
       WHERE charity_number IS NOT NULL AND charity_number != '' AND is_closed = 0 AND country IN (${placeholders})
       ORDER BY slug`,
    )
    .bind(...countries)
    .all<CharityFoodbankRow>();
  return result.results;
}

export interface CharityCrawlFoodbankRow {
  id: number;
  slug: string;
  name: string;
  country: string;
  charity_number: string;
  charity_id: string | null; // Scotland's crawler needs the EXISTING value: crawlers.py:207 builds its second request from `foodbank.charity_id`, an in-memory attribute that keeps its prior DB value if the first fetch this run failed to refresh it
}

// Re-fetched fresh at dequeue time, same rationale as needcheck's and
// getarticles' own equivalents (crawlers.py:579-590's pattern; the cron's
// enqueue-time snapshot can go stale in the drain window).
export async function getFoodbankForCharityCrawl(session: Session, foodbankId: number): Promise<CharityCrawlFoodbankRow | null> {
  return session
    .prepare("SELECT id, slug, name, country, charity_number, charity_id FROM foodbank WHERE id = ?1")
    .bind(foodbankId)
    .first<CharityCrawlFoodbankRow>();
}

const CHARITY_COLUMNS = [
  "charity_id",
  "charity_name",
  "charity_type",
  "charity_reg_date",
  "charity_postcode",
  "charity_website",
  "charity_objectives",
  "charity_purpose",
] as const;
type CharityColumn = (typeof CHARITY_COLUMNS)[number];

// crawlers.py sets each `foodbank.charity_X = data[...]` only inside its
// own `if response.status_code == 200:` block, then calls `foodbank.save()`
// once at the end -- so a field a regulator's API didn't return this run
// (a failed sub-request, or NI's endpoint simply not carrying charity_id/
// charity_type/charity_postcode at all) is left exactly as it already was
// in D1, never nulled. `patch` therefore only ever contains the columns
// this particular crawl actually has fresh values for; `last_charity_check`
// is unconditional -- crawlers.py stamps it regardless of which individual
// sub-fetches succeeded.
export async function patchFoodbankCharity(session: Session, foodbankId: number, patch: Partial<Record<CharityColumn, string | null>>, timestamp: string): Promise<void> {
  const columns = (Object.keys(patch) as CharityColumn[]).filter((c) => CHARITY_COLUMNS.includes(c));
  const setClauses = columns.map((col, i) => `${col} = ?${i + 1}`);
  const values = columns.map((col) => patch[col] ?? null);
  setClauses.push(`last_charity_check = ?${columns.length + 1}`);
  values.push(timestamp);
  await session
    .prepare(`UPDATE foodbank SET ${setClauses.join(", ")} WHERE id = ?${columns.length + 2}`)
    .bind(...values, foodbankId)
    .run();
}

export interface CharityYearInput {
  date: string;
  income: number;
  expenditure: number;
}

// PLAN.md §8.7.1's fix for the delete-then-reinsert hazard: crawlers.py
// deletes CharityYear rows BEFORE fetching the replacement financial
// history, so a failed fetch (or a retry starting mid-way) leaves the food
// bank with zero years until the next successful run, and -- since
// CharityYear has no `modified` column to key an incremental catch-up on --
// a launch catch-up gap would leave phantom duplicate rows forever. Both
// fixed by fetching first (the caller only calls this once the years are
// already in hand) and replacing atomically via one D1 batch.
export async function replaceCharityYears(session: Session, foodbankId: number, years: CharityYearInput[]): Promise<void> {
  const now = pyNow();
  await session.batch([
    session.prepare("DELETE FROM charityyear WHERE foodbank_id = ?1").bind(foodbankId),
    ...years.map((y) =>
      session
        .prepare("INSERT INTO charityyear (foodbank_id, date, income, expenditure, created) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(foodbankId, y.date, y.income, y.expenditure, now),
    ),
  ]);
}
