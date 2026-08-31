-- ======================= 0003_homepage_data.sql ==========================
-- The tables the root homepage (givefood/views.py's index()) needs beyond
-- the original 5-table WP 2.2a copy -- get_site_stats(), "most viewed"
-- and "featured articles" each read something WP 2.2a's scoping (traced
-- through gfapi1/2/3 only) correctly left out.
--
-- foodbankchangeline / foodbankhit: faithful 1:1 mirrors, DDL copied
-- verbatim from PLAN.md §4.6 (already fully specced there -- these are
-- real, general-purpose tables, not homepage-specific: foodbankchangeline
-- also backs the /needs/ index page's still-deferred "by item" category
-- filter, and foodbankhit is the general per-foodbank-per-day hit-count
-- table, not just a "most viewed this week" input).
--
-- foodbankarticle: NOT a full mirror -- only `featured = true` rows are
-- copied (168 of 17,194 in production). The homepage only ever reads the
-- 5 most recent featured articles; copying the other 17k for a query that
-- never runs isn't worth it. Revisit if a future /news/ page needs the
-- rest.
--
-- site_stats: NOT a Django table at all. get_site_stats()'s `meals` figure
-- is `Order.calories` summed across every order ever placed -- one
-- aggregate number, from a model cluster (Order/OrderLine/OrderItem/
-- OrderGroup) with no D1 DDL drafted anywhere and no other current reader.
-- Modelling four tables to reproduce one SUM wasn't worth it either; this
-- is a single precomputed row instead, refreshed by re-running the
-- extraction tool (tools/pg-to-d1/extract_core.py), same idempotent
-- re-run story as every other WP 2.2a-style copy.

CREATE TABLE foodbankchangeline (
  id INTEGER PRIMARY KEY,
  need_id INTEGER NOT NULL, foodbank_id INTEGER NOT NULL,
  item TEXT NOT NULL, type TEXT NOT NULL, category TEXT NOT NULL, group_name TEXT NOT NULL,
  created TEXT NOT NULL
);
CREATE INDEX fcl_need_cat_type ON foodbankchangeline(need_id, category, type);
CREATE INDEX fcl_type_idx      ON foodbankchangeline(type);
CREATE INDEX fcl_created_idx   ON foodbankchangeline(created);
CREATE INDEX fcl_cat_need_idx  ON foodbankchangeline(category, need_id) WHERE type = 'need';

CREATE TABLE foodbankhit (
  foodbank_id INTEGER NOT NULL, day TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (foodbank_id, day)
) WITHOUT ROWID;
CREATE INDEX hit_day_foodbank_idx ON foodbankhit(day, foodbank_id, hits);

CREATE TABLE foodbankarticle (
  id INTEGER PRIMARY KEY,
  foodbank_id INTEGER, foodbank_name TEXT,
  published_date TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
  featured INTEGER NOT NULL
);
CREATE INDEX article_published_idx ON foodbankarticle(published_date DESC) WHERE featured = 1;

CREATE TABLE site_stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- single row, enforced
  foodbanks INTEGER NOT NULL, donationpoints INTEGER NOT NULL,
  items INTEGER NOT NULL, meals INTEGER NOT NULL,
  computed_at TEXT NOT NULL
);
