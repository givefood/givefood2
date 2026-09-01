-- ========================== 0008_needcheck.sql =============================
-- WP 5.2 (PLAN.md §8.5): the needcheck pipeline's own tables. None of these
-- exist in D1 yet -- CrawlSet/CrawlItem/FoodbankDiscrepancy are new here.
-- No FK constraints (§4.5, same convention as every other table).

-- CrawlSet (givefood/models/analytics.py:34-53). Two columns beyond the
-- Django model, both added deliberately (PLAN.md §8.5.2):
--   run_id    -- free cron dedup: a duplicate Cron Trigger delivery (at-least-
--                once) finds the existing row for today's run_id and no-ops,
--                rather than double-enqueueing every food bank.
--   expected / remaining -- fixes a real, confirmed-on-production bug: nothing
--                in Django ever stamps `finish` for crawl_type='need' (every
--                such row has finish IS NULL, so CrawlSet.time_taken() always
--                returns None). The consumer decrements `remaining` per
--                finished CrawlItem (via an atomic UPDATE...RETURNING) and
--                stamps `finish` itself when it reaches 0.
CREATE TABLE crawlset (
  id INTEGER PRIMARY KEY,
  crawl_type TEXT NOT NULL,             -- need, article, charity, discrepancy
  run_id TEXT,                          -- e.g. "needcheck-2026-09-01"; NULL for crawl types with no dedup need yet
  start TEXT NOT NULL,
  finish TEXT,
  expected INTEGER,
  remaining INTEGER
);
CREATE UNIQUE INDEX crawlset_runid_uniq ON crawlset(run_id) WHERE run_id IS NOT NULL;

-- CrawlItem (givefood/models/analytics.py:56-86). Django's
-- content_type/object_id GenericForeignKey collapses to a single nullable
-- need_id FK -- verified against crawlers.py that FoodbankChange is the only
-- content type ever attached to a 'need' CrawlItem (§8.5.3 stage 1 note).
-- Opened immediately on stage 1, closed (finish stamped) at the end of every
-- code path -- so a row with finish IS NULL is exactly how a stalled/crashed
-- run is detected.
CREATE TABLE crawlitem (
  id INTEGER PRIMARY KEY,
  crawl_set_id INTEGER,
  crawl_type TEXT NOT NULL,
  start TEXT NOT NULL,
  finish TEXT,
  foodbank_id INTEGER NOT NULL,
  url TEXT,
  need_id INTEGER                       -- foodbankchange.id, set only when this run inserted a change
);
CREATE INDEX crawlitem_foodbank_finish_idx ON crawlitem(foodbank_id, finish DESC);
CREATE INDEX crawlitem_crawlset_idx ON crawlitem(crawl_set_id);
-- Backs insertCrawlItem's upsert (packages/db/src/needcheck.ts): Cloudflare
-- Queues redelivering the same logical message after a transient failure
-- must reopen the SAME row, not create an orphaned one that never gets
-- finish stamped.
CREATE UNIQUE INDEX crawlitem_crawlset_foodbank_uniq ON crawlitem(crawl_set_id, foodbank_id);

-- FoodbankDiscrepancy (givefood/models/needs.py:28-47). discrepancy_type is
-- a free TEXT, not an enum -- DISCREPANCY_TYPES (const/general.py:44-52) is
-- an app-level allowlist, not a DB constraint, matching every other choices
-- field in this schema.
CREATE TABLE foodbankdiscrepancy (
  id INTEGER PRIMARY KEY,
  foodbank_id INTEGER,
  foodbank_name TEXT,                   -- denormalised from foodbank.name at write time
  need_id INTEGER,                      -- foodbankchange.id, when a discrepancy is about one
  url TEXT,
  discrepancy_type TEXT NOT NULL,
  discrepancy_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'New',   -- New, Done, Invalid (DISCREPANCY_STATUSES)
  created TEXT NOT NULL,
  modified TEXT NOT NULL
);
CREATE INDEX discrepancy_status_created_idx ON foodbankdiscrepancy(status, created DESC);
