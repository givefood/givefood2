-- WP 5.6, maintainer decision 2026-09-02: dropped entirely, not built.
-- The Container-based dump-generation cron (PLAN.md §8.8) and the R2-
-- served download/listing pages that depended on this table's metadata
-- were removed from scope rather than shipped. Table was never populated
-- (0 rows on production D1, confirmed directly before dropping) -- Phase 5
-- was always the first point real data would have landed here.
DROP TABLE dump;
