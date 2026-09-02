-- PLAN.md §6.9 R7: "Do not reimplement slugify... Replace derive-then-
-- redirect with a D1 lookup on the ONS PCON24CD code (present in both
-- parlcon.json properties and the 2024 constituencies CSV)."
--
-- Genuinely new data, not carried from Postgres: neither
-- givefood.models.political.ParliamentaryConstituency nor D1's own
-- migration 0001 has ever stored the ONS geography code -- confirmed
-- directly against the real Django model. Backfilled here from
-- workers/site/dist/static/static/geojson/parlcon.json (the same file
-- the /write/ map already serves client-side; its 650 features carry both
-- PCON24CD and PCON24NM together, so no external CSV is needed).
ALTER TABLE parliamentaryconstituency ADD COLUMN pcon24cd TEXT;
CREATE UNIQUE INDEX parlcon_pcon24cd_uniq ON parliamentaryconstituency(pcon24cd) WHERE pcon24cd IS NOT NULL;
