-- WP: /aac/ (address autocomplete), PLAN.md §4.8.6-§4.8.7.
--
-- place_county_name_slug_idx / idx_place_pop_name from PLAN.md's full
-- `place` DDL (§4.6) are deliberately NOT carried here: both exist only to
-- serve the /needs/at/place/<county>/<place>/ browse page (G8), which is a
-- confirmed-out-of-scope permanent 404 (see workers/site/src/index.ts's
-- comment on that route) with no other reader. Building indexes for a page
-- that will never exist is pure write/storage cost with zero consumers.
-- place_gbpnid_uniq and place_name_upper_idx are kept: the former mirrors
-- Postgres's own unique=True constraint, the latter serves /aac/'s prefix
-- pass directly.
CREATE TABLE place (
  id INTEGER PRIMARY KEY, gbpnid INTEGER NOT NULL,
  name TEXT,
  name_upper TEXT,                        -- computed BY POSTGRES at export (§4.8.6b) -- never call upper() in D1, it's ASCII-only
  lat_lng TEXT, county TEXT, county_slug TEXT NOT NULL,
  name_slug TEXT NOT NULL, population INTEGER
);
CREATE UNIQUE INDEX place_gbpnid_uniq   ON place(gbpnid);
CREATE INDEX place_name_upper_idx       ON place(name_upper);   -- prefix pass; replaces text_pattern_ops
-- the pg_trgm gin_trgm_ops replacement. Substring pass only. §4.8.6.
CREATE VIRTUAL TABLE place_fts USING fts5(
  name_upper, content='place', content_rowid='id', tokenize='trigram');

-- Trimmed column set per §4.8.7: postcode/lat_lng/county are the only
-- columns any production code path reads. `postcode` is reconstructed as a
-- generated column rather than stored (verified reconstructable for
-- 1,795,944 / 1,795,944 rows).
CREATE TABLE postcode (
  id INTEGER PRIMARY KEY,
  pcn TEXT NOT NULL,                      -- postcode_normalized, e.g. 'SW1A1AA'
  postcode TEXT GENERATED ALWAYS AS
      (substr(pcn, 1, length(pcn) - 3) || ' ' || substr(pcn, -3)) VIRTUAL,
  lat_lng TEXT NOT NULL, county TEXT
);
-- SQLite's BINARY collation serves LIKE/range 'X%' natively -- no text_pattern_ops equivalent needed.
CREATE INDEX postcode_pcn_idx ON postcode(pcn);
