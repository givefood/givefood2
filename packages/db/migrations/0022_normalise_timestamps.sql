-- ==================== 0022_normalise_timestamps.sql =======================
-- Ticket #9. Rewrites every timestamp the port wrote in JavaScript's ISO
-- form into the form Django and the ETL write, so that one column holds one
-- format.
--
--   before   2026-09-05T19:28:08.639Z      (new Date().toISOString())
--   after    2026-09-05 19:28:08.639000    (Python's str(datetime))
--
-- WHY IT MATTERS. D1 stores these as TEXT and SQLite compares TEXT
-- lexicographically. `T` is 0x54, `space` is 0x20, so within a single day
-- EVERY ISO value sorted after EVERY Django value no matter the real time:
--
--   SELECT '2026-09-05T08:00:00.000Z' > '2026-09-05 20:00:00.000000';  -- 1
--
-- Two live consequences, both measured before this ran:
--   * `ORDER BY created DESC LIMIT 1` returned the wrong "latest published
--     need" -- hit during the 2026-09-05 migration, worked around by hand.
--   * `WHERE created >= <threshold>` dropped every same-day row when the
--     threshold was ISO: 31 of 46 on foodbankchange.
--
-- The write sites are fixed in code (packages/models/src/pyDatetime.ts,
-- pyNow()/pyDatetime()); this migration repairs what they already wrote.
--
-- IDEMPOTENT. Each statement is guarded on the ISO shape, so re-running
-- matches nothing. The `|| '000'` pads JavaScript's 3 fractional digits to
-- Python's 6, which keeps every value the same length so lexicographic
-- order and chronological order agree exactly.
--
-- Includes port-only tables (crawlset, crawlitem, foodbankdiscrepancy,
-- admin_job) even though those are internally consistent: getAdminDashboard
-- Stats compares crawlitem.finish against a threshold that is now written
-- in Django format, so leaving them ISO would break that comparison the
-- other way round.
--
-- Column list discovered from the live data rather than the schema, by
-- scanning every TEXT column of every table for ISO-shaped values.

-- foodbank.last_need (3 rows)
UPDATE "foodbank" SET "last_need" = replace(replace("last_need", 'T', ' '), 'Z', '') || '000'
 WHERE "last_need" LIKE '____-__-__%Z';

-- foodbank.last_crawl (470 rows)
UPDATE "foodbank" SET "last_crawl" = replace(replace("last_crawl", 'T', ' '), 'Z', '') || '000'
 WHERE "last_crawl" LIKE '____-__-__%Z';

-- foodbankchange.notified (2 rows)
UPDATE "foodbankchange" SET "notified" = replace(replace("notified", 'T', ' '), 'Z', '') || '000'
 WHERE "notified" LIKE '____-__-__%Z';

-- foodbankchange.created (7 rows)
UPDATE "foodbankchange" SET "created" = replace(replace("created", 'T', ' '), 'Z', '') || '000'
 WHERE "created" LIKE '____-__-__%Z';

-- foodbankchange.modified (7 rows)
UPDATE "foodbankchange" SET "modified" = replace(replace("modified", 'T', ' '), 'Z', '') || '000'
 WHERE "modified" LIKE '____-__-__%Z';

-- foodbankchangeline.created (25 rows)
UPDATE "foodbankchangeline" SET "created" = replace(replace("created", 'T', ' '), 'Z', '') || '000'
 WHERE "created" LIKE '____-__-__%Z';

-- foodbankarticle.published_date (9 rows)
UPDATE "foodbankarticle" SET "published_date" = replace(replace("published_date", 'T', ' '), 'Z', '') || '000'
 WHERE "published_date" LIKE '____-__-__%Z';

-- foodbanksubscriber.created (2 rows)
UPDATE "foodbanksubscriber" SET "created" = replace(replace("created", 'T', ' '), 'Z', '') || '000'
 WHERE "created" LIKE '____-__-__%Z';

-- webpushsubscription.created (1 rows)
UPDATE "webpushsubscription" SET "created" = replace(replace("created", 'T', ' '), 'Z', '') || '000'
 WHERE "created" LIKE '____-__-__%Z';

-- charityyear.created (4180 rows)
UPDATE "charityyear" SET "created" = replace(replace("created", 'T', ' '), 'Z', '') || '000'
 WHERE "created" LIKE '____-__-__%Z';

-- crawlset.start (8 rows)
UPDATE "crawlset" SET "start" = replace(replace("start", 'T', ' '), 'Z', '') || '000'
 WHERE "start" LIKE '____-__-__%Z';

-- crawlset.finish (8 rows)
UPDATE "crawlset" SET "finish" = replace(replace("finish", 'T', ' '), 'Z', '') || '000'
 WHERE "finish" LIKE '____-__-__%Z';

-- crawlitem.start (4268 rows)
UPDATE "crawlitem" SET "start" = replace(replace("start", 'T', ' '), 'Z', '') || '000'
 WHERE "start" LIKE '____-__-__%Z';

-- crawlitem.finish (4268 rows)
UPDATE "crawlitem" SET "finish" = replace(replace("finish", 'T', ' '), 'Z', '') || '000'
 WHERE "finish" LIKE '____-__-__%Z';

-- foodbankdiscrepancy.created (776 rows)
UPDATE "foodbankdiscrepancy" SET "created" = replace(replace("created", 'T', ' '), 'Z', '') || '000'
 WHERE "created" LIKE '____-__-__%Z';

-- foodbankdiscrepancy.modified (776 rows)
UPDATE "foodbankdiscrepancy" SET "modified" = replace(replace("modified", 'T', ' '), 'Z', '') || '000'
 WHERE "modified" LIKE '____-__-__%Z';

-- admin_job.created (2 rows)
UPDATE "admin_job" SET "created" = replace(replace("created", 'T', ' '), 'Z', '') || '000'
 WHERE "created" LIKE '____-__-__%Z';

-- admin_job.finished (2 rows)
UPDATE "admin_job" SET "finished" = replace(replace("finished", 'T', ' '), 'Z', '') || '000'
 WHERE "finished" LIKE '____-__-__%Z';

-- whatsappsubscriber.created (1 rows)
UPDATE "whatsappsubscriber" SET "created" = replace(replace("created", 'T', ' '), 'Z', '') || '000'
 WHERE "created" LIKE '____-__-__%Z';

-- whatsappsubscriber.last_notified (2 rows)
UPDATE "whatsappsubscriber" SET "last_notified" = replace(replace("last_notified", 'T', ' '), 'Z', '') || '000'
 WHERE "last_notified" LIKE '____-__-__%Z';
