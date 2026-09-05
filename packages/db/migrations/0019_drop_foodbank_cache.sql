-- ==================== 0019_drop_foodbank_cache.sql =======================
-- Removes the copies of Foodbank fields that six tables each kept their own
-- version of. Django's own comment for the block that writes them is "Cache
-- foodbank details" (givefood/models/foodbank.py:948-954 for
-- FoodbankLocation, :1292-1296 for FoodbankDonationPoint); it is an artifact
-- of the site's original Google App Engine datastore, where there were no
-- joins to make. Both Postgres and D1 have joins.
--
-- WHY, CONCRETELY. The copy is refreshed only in the CHILD's save().
-- Foodbank.save() does not cascade, so renaming a food bank left every one
-- of its locations and donation points holding the old value until each was
-- next saved by hand -- and because getDonationPointBySlugs (and Django's
-- own equivalent) FINDS a child by its cached foodbank_slug, a stale copy
-- 404s the child's real page. Measured against production before this
-- landed: 24 rows disagreed with their parent's slug and name, 44 with its
-- phone number, 38 with its email.
--
-- THE VIEWS ARE WHAT MAKE THIS A SMALL CHANGE. Roughly 18 call sites issue
-- `SELECT * FROM foodbanklocation`/`foodbankdonationpoint` and feed the row
-- straight into mapLocationRow/mapDonationPointRow, whose types include
-- these fields; a dozen more filter on `foodbank_slug`. Reading from a view
-- instead means those queries change by table name alone -- no qualifying
-- every column in every WHERE against ambiguity, and no touching the ~160
-- references in workers/site or the ~110 in the templates, because the
-- output column names are identical. The public API's JSON shape is
-- therefore unchanged, which is the thing this must not break.
--
-- LEFT JOIN, not JOIN. foodbankchange.foodbank_id is nullable (an
-- unassigned need), and an inner join would silently drop those rows.
-- foodbanklocation/foodbankdonationpoint declare theirs NOT NULL, but D1
-- has no foreign keys (PLAN.md §4.5) so nothing enforces that a parent
-- exists -- and a LEFT JOIN cannot lose a row either way.
--
-- Writes still go to the base tables; only reads that want the parent's
-- fields use a view. See tools/pg-to-d1/extract_core.py, whose
-- resync_foodbank_cache() this retires, and foodbankAdmin.ts, whose
-- cascadeFoodbankCache() it retires too.

DROP VIEW IF EXISTS foodbanklocation_full;
DROP VIEW IF EXISTS foodbankdonationpoint_full;
DROP VIEW IF EXISTS foodbankchange_full;
DROP VIEW IF EXISTS foodbankarticle_full;
DROP VIEW IF EXISTS foodbankdiscrepancy_full;
DROP VIEW IF EXISTS foodbanksubscriber_full;

ALTER TABLE foodbanklocation DROP COLUMN foodbank_name;
ALTER TABLE foodbanklocation DROP COLUMN foodbank_slug;
ALTER TABLE foodbanklocation DROP COLUMN foodbank_network;
ALTER TABLE foodbanklocation DROP COLUMN foodbank_phone_number;
ALTER TABLE foodbanklocation DROP COLUMN foodbank_email;

ALTER TABLE foodbankdonationpoint DROP COLUMN foodbank_name;
ALTER TABLE foodbankdonationpoint DROP COLUMN foodbank_slug;
ALTER TABLE foodbankdonationpoint DROP COLUMN foodbank_network;

ALTER TABLE foodbankarticle      DROP COLUMN foodbank_name;
ALTER TABLE foodbankchange       DROP COLUMN foodbank_name;
ALTER TABLE foodbankdiscrepancy  DROP COLUMN foodbank_name;
ALTER TABLE foodbanksubscriber   DROP COLUMN foodbank_name;

-- `is_closed` is NOT dropped. It is copied from the parent the same way
-- (models/foodbank.py:954, :1295) and the ETL now derives it, but unlike
-- the others it is filtered on constantly (`WHERE is_closed = 0` on the
-- hottest queries this site has) and an indexable local column is worth
-- keeping. It is also the one field a future maintainer might legitimately
-- want to set per-location.

CREATE VIEW foodbanklocation_full AS
  SELECT l.*,
         f.name          AS foodbank_name,
         f.slug          AS foodbank_slug,
         f.network       AS foodbank_network,
         f.phone_number  AS foodbank_phone_number,
         f.contact_email AS foodbank_email
    FROM foodbanklocation l
    LEFT JOIN foodbank f ON f.id = l.foodbank_id;

CREATE VIEW foodbankdonationpoint_full AS
  SELECT d.*,
         f.name    AS foodbank_name,
         f.slug    AS foodbank_slug,
         f.network AS foodbank_network
    FROM foodbankdonationpoint d
    LEFT JOIN foodbank f ON f.id = d.foodbank_id;

CREATE VIEW foodbankchange_full AS
  SELECT c.*, f.name AS foodbank_name, f.slug AS foodbank_slug
    FROM foodbankchange c
    LEFT JOIN foodbank f ON f.id = c.foodbank_id;

CREATE VIEW foodbankarticle_full AS
  SELECT a.*, f.name AS foodbank_name, f.slug AS foodbank_slug
    FROM foodbankarticle a
    LEFT JOIN foodbank f ON f.id = a.foodbank_id;

CREATE VIEW foodbankdiscrepancy_full AS
  SELECT d.*, f.name AS foodbank_name, f.slug AS foodbank_slug
    FROM foodbankdiscrepancy d
    LEFT JOIN foodbank f ON f.id = d.foodbank_id;

CREATE VIEW foodbanksubscriber_full AS
  SELECT s.*, f.name AS foodbank_name, f.slug AS foodbank_slug
    FROM foodbanksubscriber s
    LEFT JOIN foodbank f ON f.id = s.foodbank_id;
