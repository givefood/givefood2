-- ============================ 0007_write.sql ==============================
-- gfwrite (WP 4.6, PLAN.md §6.9): ConstituencySubscriber. Write-only --
-- "Written by gfwrite/views.py:80-85, read by nothing, ever. No send path,
-- no admin view, no cron. Port the table; do not invent a channel."
-- (PLAN.md §9256). No FK (§4.5, same as every other table).

CREATE TABLE constituencysubscriber (
  id INTEGER PRIMARY KEY,
  created TEXT NOT NULL, last_contacted TEXT,
  email TEXT NOT NULL, name TEXT,
  parliamentary_constituency_id INTEGER NOT NULL,
  parliamentary_constituency_name TEXT
);
CREATE INDEX consub_parlcon_idx ON constituencysubscriber(parliamentary_constituency_id);
