-- ========================= 0018_placephoto.sql =============================
-- (Numbered 0018, not 0014: 0014-0017 were taken by the parallel
-- orderitem/ordergroup/slugredirect work landing in the same phase.)
-- The photo metadata table gfadmin's photos tab (views.py:730-775
-- foodbank_photos_tab) and photo_delete (views.py:1877-1913) both need.
-- Schema copied VERBATIM from PLAN.md's own design at lines 2505-2515
-- (repeated at :3350-3358) -- this is the first migration to actually need
-- it, not a new design. PLAN.md:10767 defers both the tab and the delete
-- route for exactly one reason ("this port's photo architecture has no
-- D1-backed photo metadata at all"); this table is what discharges that.
--
-- No foreign keys (PLAN.md §4.5, same convention as every other table).
--
-- `blob` is NOT carried over. The bytes live in R2 (givefood_placephoto is
-- 1,776 MB in Postgres, ~4 MB without it) under the key
-- workers/site/src/routes/media.ts:44 derives from the URL path
-- ("media" + url.pathname); `r2_key` records exactly that key so a delete
-- can remove the object without re-deriving it, and so a future backfill
-- can tell which object a row describes.
--
-- photo_ref has 26 NULLs in production (PLAN.md:945). SQLite treats every
-- NULL as distinct from every other NULL, so a UNIQUE INDEX still accepts
-- all 26 -- matching Postgres, which is why PLAN.md specifies UNIQUE here
-- despite them.
--
-- html_attributions is the EMPTY STRING in all 7,117 production rows
-- (PLAN.md:946). The column is carried because it costs nothing. Do NOT
-- describe this as preserving a Google Places attribution behaviour: there
-- is no such behaviour today, and whether there should be is a separate
-- compliance question PLAN.md already flags for the maintainer.
--
-- NOTE FOR WHOEVER LANDS THE PHOTO BACKFILL: nothing writes to this table
-- yet. workers/jobs/src/queues/jobs.ts:60 still throws
-- "media-backfill: not implemented" for every key that is not a map image,
-- so photo.jpg misses never produce a row here. Until that consumer is
-- built and inserts one row per fetched photo, this table stays empty and
-- the admin photos tab renders nothing -- which is why foodbank_detail.njk
-- gates the tab trigger on `counts.photos` rather than showing an empty tab.
CREATE TABLE placephoto (
  id                INTEGER PRIMARY KEY,
  place_id          TEXT,            -- the lookup key; 0 NULLs in production
  photo_ref         TEXT,            -- 26 NULLs; UNIQUE is NULL-distinct in SQLite
  html_attributions TEXT,            -- '' in all 7,117 rows today
  r2_key            TEXT NOT NULL,   -- e.g. 'media/needs/at/<slug>/photo.jpg'
  bytes             INTEGER NOT NULL,
  md5               TEXT NOT NULL,
  created  TEXT,
  modified TEXT
);
CREATE UNIQUE INDEX placephoto_place_id_uniq  ON placephoto(place_id);
CREATE UNIQUE INDEX placephoto_photo_ref_uniq ON placephoto(photo_ref);
