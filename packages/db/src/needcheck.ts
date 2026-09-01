import { type Session } from "./types";
import { mapNeedRow, type FoodbankChangeRow } from "./needs";

// WP 5.2 (PLAN.md §8.5): the needcheck pipeline's own D1 access -- the
// cron handler (enqueueing one message per open food bank) and the
// RENDER_Q consumer (crawlset/crawlitem bookkeeping, the change-detection
// reads, the foodbankchange/foodbankdiscrepancy writes). Kept separate
// from needs.ts, which is the public-API read path.

export interface OpenFoodbankRow {
  id: number;
  slug: string;
  name: string;
  url: string;
  shopping_list_url: string;
  facebook_page: string | null;
}

// needcheck.py:20's `Foodbank.objects.exclude(is_closed = True).order_by("?")`.
// Ordered by slug, not randomised (PLAN.md §8.5.2's own deliberate change --
// a Queue makes enqueue order irrelevant, and a deterministic order makes a
// partial run easy to reason about).
export async function getOpenFoodbanksForNeedCheck(session: Session): Promise<OpenFoodbankRow[]> {
  const result = await session
    .prepare("SELECT id, slug, name, url, shopping_list_url, facebook_page FROM foodbank WHERE is_closed = 0 ORDER BY slug")
    .all<OpenFoodbankRow>();
  return result.results;
}

// crawlers.py:579-590's do_foodbank_need_check_async fetches
// Foodbank.objects.get(slug=...) fresh immediately before scraping, every
// time -- the cron enqueue's own snapshot (getOpenFoodbanksForNeedCheck)
// can go stale during the enqueue-to-dequeue window (multi-minute at
// max_concurrency 25 over ~1,024 messages), so the queue consumer re-reads
// this by id at the top of processOne rather than trusting the message body.
export async function getFoodbankForNeedCheck(session: Session, foodbankId: number): Promise<OpenFoodbankRow | null> {
  return session
    .prepare("SELECT id, slug, name, url, shopping_list_url, facebook_page FROM foodbank WHERE id = ?1")
    .bind(foodbankId)
    .first<OpenFoodbankRow>();
}

export async function findCrawlSetByRunId(session: Session, runId: string): Promise<{ id: number } | null> {
  return session.prepare("SELECT id FROM crawlset WHERE run_id = ?1").bind(runId).first<{ id: number }>();
}

export async function insertCrawlSet(session: Session, crawlType: string, runId: string | null): Promise<number> {
  const now = new Date().toISOString();
  const result = await session
    .prepare("INSERT INTO crawlset (crawl_type, run_id, start) VALUES (?1, ?2, ?3)")
    .bind(crawlType, runId, now)
    .run();
  return result.meta.last_row_id;
}

export async function setCrawlSetExpected(session: Session, crawlSetId: number, expected: number): Promise<void> {
  await session.prepare("UPDATE crawlset SET expected = ?1, remaining = ?1 WHERE id = ?2").bind(expected, crawlSetId).run();
}

// Atomic decrement-and-read: D1/SQLite supports UPDATE...RETURNING, so the
// new value is available in the same round trip -- no separate read-then-
// write race between concurrent consumer invocations finishing at once.
// Stamps `finish` itself the moment remaining reaches 0, since nothing in
// Django's needcheck.py ever does (confirmed on production: every 'need'
// CrawlSet has finish IS NULL -- PLAN.md §8.5.2).
export async function decrementCrawlSetRemaining(session: Session, crawlSetId: number): Promise<number | null> {
  const row = await session
    .prepare("UPDATE crawlset SET remaining = remaining - 1 WHERE id = ?1 AND remaining > 0 RETURNING remaining")
    .bind(crawlSetId)
    .first<{ remaining: number }>();
  if (!row) return null;
  if (row.remaining === 0) {
    await session.prepare("UPDATE crawlset SET finish = ?1 WHERE id = ?2").bind(new Date().toISOString(), crawlSetId).run();
  }
  return row.remaining;
}

// Upsert, not a plain INSERT: Cloudflare Queues is at-least-once, so a
// transient failure between here and finish() can redeliver the same
// logical message, re-entering processOne from scratch. A plain INSERT
// would create a second, orphaned crawlitem row for the same food bank
// whose `finish` never gets stamped (indistinguishable from a genuine
// stall) -- crawlitem_crawlset_foodbank_uniq (0008_needcheck.sql) plus
// this upsert make re-opening the SAME row on retry return its existing
// id instead. `SET crawl_set_id = crawl_set_id` is a deliberate no-op
// assignment -- SQLite's ON CONFLICT requires a SET clause, and this one
// exists only so RETURNING can hand back the existing row's id without
// touching its `start`/`finish`.
export async function insertCrawlItem(session: Session, params: { crawlSetId: number; crawlType: string; foodbankId: number; url: string | null }): Promise<number> {
  const now = new Date().toISOString();
  const row = await session
    .prepare(
      `INSERT INTO crawlitem (crawl_set_id, crawl_type, start, foodbank_id, url)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(crawl_set_id, foodbank_id) DO UPDATE SET crawl_set_id = crawl_set_id
       RETURNING id`,
    )
    .bind(params.crawlSetId, params.crawlType, now, params.foodbankId, params.url)
    .first<{ id: number }>();
  return row!.id;
}

// Returns whether this call actually closed the item (false when a prior
// attempt -- see insertCrawlItem's comment -- already stamped `finish`).
// The caller (needcheckRender.ts's finish()) uses this to skip
// updateFoodbankLastNeedCheck/decrementCrawlSetRemaining on a retry that
// lands after the original attempt's writes already committed, so a
// message redelivered post-commit can't double-decrement
// crawlset.remaining.
export async function finishCrawlItem(session: Session, crawlItemId: number, needId: number | null): Promise<boolean> {
  const result = await session
    .prepare("UPDATE crawlitem SET finish = ?1, need_id = ?2 WHERE id = ?3 AND finish IS NULL")
    .bind(new Date().toISOString(), needId, crawlItemId)
    .run();
  return result.meta.changes > 0;
}

// crawlers.py:404-407's `FoodbankChange.objects.filter(foodbank=foodbank,
// published=True).latest("created")`.
export async function getLastPublishedNeed(session: Session, foodbankId: number): Promise<FoodbankChangeRow | null> {
  const row = await session
    .prepare("SELECT * FROM foodbankchange WHERE foodbank_id = ?1 AND published = 1 ORDER BY created DESC LIMIT 1")
    .bind(foodbankId)
    .first();
  return row ? mapNeedRow(row as Record<string, unknown>) : null;
}

// crawlers.py:484's `FoodbankChange.objects.filter(foodbank=foodbank,
// published=False).order_by("-created")[:10]` -- the nonpertinent-
// suppression window (§8.5.3 stage 9 / §8.5.5's dedup mechanism).
export async function getLastUnpublishedNeeds(session: Session, foodbankId: number, limit: number): Promise<FoodbankChangeRow[]> {
  const result = await session
    .prepare("SELECT * FROM foodbankchange WHERE foodbank_id = ?1 AND published = 0 ORDER BY created DESC LIMIT ?2")
    .bind(foodbankId, limit)
    .all();
  return result.results.map((r) => mapNeedRow(r as Record<string, unknown>));
}

export interface InsertFoodbankChangeParams {
  foodbankId: number;
  foodbankName: string;
  uri: string;
  changeText: string;
  excessChangeText: string;
}

// crawlers.py:540-549's FoodbankChange(...) construction, reached only when
// `is_change and not is_nonpertinent` (§8.5.3 stage 10). need_id is a
// random 32-char dashless UUID (needs.py:287's model default), matching
// the shape getNeedByUuid() elsewhere in this package already expects.
// published/nonpertinent/is_categorised are written explicitly as 0, not
// left to a column default -- `nonpertinent = 0 IN SQL excludes NULL`
// (PLAN.md §8.5.3's own warning), so an explicit 0 is what actually lands
// new rows in the review queue, matching Django's model default of False
// exactly (the 18,943 NULL rows are pre-existing production data, not
// something new rows should ever produce).
export async function insertFoodbankChange(session: Session, params: InsertFoodbankChangeParams): Promise<number> {
  const now = new Date().toISOString();
  const needId = crypto.randomUUID().replace(/-/g, "");
  const result = await session
    .prepare(
      `INSERT INTO foodbankchange
         (need_id, foodbank_id, foodbank_name, uri,
          change_text, change_text_original, excess_change_text, excess_change_text_original,
          input_method, published, nonpertinent, is_categorised, created, modified)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?6, 'ai', 0, 0, 0, ?7, ?7)`,
    )
    .bind(needId, params.foodbankId, params.foodbankName, params.uri, params.changeText, params.excessChangeText, now)
    .run();
  return result.meta.last_row_id;
}

export interface InsertFoodbankDiscrepancyParams {
  foodbankId: number | null; // NULL for a cron-level discrepancy not tied to one food bank (e.g. a partial enqueue failure)
  foodbankName: string | null;
  url: string | null;
  discrepancyType: string;
  discrepancyText: string;
}

// needs.py:28-47's FoodbankDiscrepancy(...) -- both needcheck call sites
// (crawlers.py:311-333 render failure, :486-514 empty-extraction guard)
// use discrepancy_type="website" and leave `need` unset (PLAN.md doesn't
// attach a discrepancy to a specific FoodbankChange row for either of
// these two cases, so need_id stays NULL here).
export async function insertFoodbankDiscrepancy(session: Session, params: InsertFoodbankDiscrepancyParams): Promise<number> {
  const now = new Date().toISOString();
  const result = await session
    .prepare(
      `INSERT INTO foodbankdiscrepancy
         (foodbank_id, foodbank_name, need_id, url, discrepancy_type, discrepancy_text, status, created, modified)
       VALUES (?1, ?2, NULL, ?3, ?4, ?5, 'New', ?6, ?6)`,
    )
    .bind(params.foodbankId, params.foodbankName, params.url, params.discrepancyType, params.discrepancyText, now)
    .run();
  return result.meta.last_row_id;
}

export async function updateFoodbankLastNeedCheck(session: Session, foodbankId: number, timestamp: string): Promise<void> {
  await session.prepare("UPDATE foodbank SET last_need_check = ?1 WHERE id = ?2").bind(timestamp, foodbankId).run();
}
