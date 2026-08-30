-- ============================ 0002_dump.sql =============================
-- The `dump` metadata table for /api/2/'s daily-dumps listing (WP 2.7).
-- `the_dump` (the actual file content, up to 143 MB in one Postgres text
-- column) does NOT come to D1 -- see PLAN.md §5.8: dumps move to R2, this
-- table is metadata only (1,474 MB -> ~50 kB). Real data population is
-- Phase 5 (tools/dumps_to_r2.py); this migration only creates the shape.
--
-- Copied from PLAN.md §7.6.

CREATE TABLE dump (
  id INTEGER PRIMARY KEY, dump_type TEXT NOT NULL, dump_format TEXT NOT NULL,
  row_count INTEGER, size INTEGER, r2_key TEXT NOT NULL, created TEXT NOT NULL
);
CREATE INDEX dump_type_format_created_idx ON dump(dump_type, dump_format, created DESC);
