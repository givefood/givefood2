-- ========================= 0004_subscribers.sql ============================
-- WP 3.7: hit beacon writes to Analytics Engine, not D1 (see
-- workers/site/src/routes/wfbn/hit.ts) -- foodbankhit already exists
-- (0003_homepage_data.sql). This migration adds the three D1 tables WP 3.7's
-- subscribe/confirm/unsubscribe, webpush, and mobsub endpoints read and
-- write directly: foodbanksubscriber, webpushsubscription, mobilesubscriber.
--
-- All three are on PLAN.md §10.8.1's "full reload every cycle" list (no
-- `modified` watermark column, unlike the WP 2.2a core tables) -- this
-- migration only creates the tables; population from production is a
-- separate one-off copy (tools/pg-to-d1/extract_core.py-shaped), same as
-- every other D1 table so far. Column list and index DDL match PLAN.md §4.6
-- verbatim, extended with sub_key/unsub_key indexes PLAN.md's snippet didn't
-- show but confirm()/unsubscribe() both do a bare `WHERE sub_key = ?` /
-- `WHERE unsub_key = ?` lookup with no other predicate -- a full table scan
-- without one.

CREATE TABLE foodbanksubscriber (
  id INTEGER PRIMARY KEY,
  created TEXT NOT NULL, last_contacted TEXT,
  foodbank_id INTEGER NOT NULL, foodbank_name TEXT,
  email TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0,
  sub_key TEXT NOT NULL, unsub_key TEXT NOT NULL
);
CREATE UNIQUE INDEX sub_email_fb_uniq ON foodbanksubscriber(email, foodbank_id);
CREATE INDEX sub_fb_confirmed_idx ON foodbanksubscriber(foodbank_id, confirmed);
CREATE UNIQUE INDEX sub_key_idx ON foodbanksubscriber(sub_key);
CREATE UNIQUE INDEX unsub_key_idx ON foodbanksubscriber(unsub_key);

CREATE TABLE webpushsubscription (
  id INTEGER PRIMARY KEY,
  created TEXT NOT NULL,
  foodbank_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
  browser TEXT
);
CREATE UNIQUE INDEX webpush_fb_endpoint_uniq ON webpushsubscription(foodbank_id, endpoint);

-- No unique constraint on (device_id, foodbank_id, donationpoint_id):
-- Django's mobsub view dedupes via update_or_create()'s own
-- read-then-write, not a DB constraint (givefood/models has none either) --
-- a D1 UNIQUE INDEX here would enforce different NULL semantics (SQLite
-- treats each NULL as distinct, so it wouldn't even help) and diverge from
-- what production actually guarantees. The Workers handler reproduces the
-- same select-then-insert/update instead; see packages/db/src/subscribers.ts.
CREATE TABLE mobilesubscriber (
  id INTEGER PRIMARY KEY,
  created TEXT NOT NULL,
  device_id TEXT NOT NULL, platform TEXT NOT NULL,
  timezone TEXT, locale TEXT, app_version TEXT, os_version TEXT,
  device_model TEXT, sub_type TEXT,
  foodbank_id INTEGER NOT NULL, donationpoint_id INTEGER
);
CREATE INDEX mobsub_fb_created_idx ON mobilesubscriber(foodbank_id, created DESC);
CREATE INDEX mobsub_device_fb_idx ON mobilesubscriber(device_id, foodbank_id, donationpoint_id);
