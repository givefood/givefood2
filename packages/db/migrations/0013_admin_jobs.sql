-- ========================= 0013_admin_jobs.sql =============================
-- WP 6.8 (PLAN.md §9.4.4): backing store for admin-triggered background
-- work that can't survive a request-scoped Worker (foodbank_check's 5
-- scrapes + a Gemini call). Schema copied verbatim from PLAN.md's own
-- design there -- this WP is the first to actually need it, not a new
-- design.
--
-- No foreign keys (§4.5, same convention as every other table). `target`
-- is a free TEXT identifier (a foodbank slug today) rather than an FK,
-- matching that convention. `result` is a JSON string the page/poll
-- response deserialises, not a set of typed columns -- each `kind` shapes
-- its own payload, and there is exactly one reader (the route that
-- enqueued it), so a typed column set would be pure ceremony.
CREATE TABLE admin_job (
  id TEXT PRIMARY KEY,               -- uuid
  kind TEXT NOT NULL,                -- check | needtestbed | urls-suggest | ...
  target TEXT,                       -- foodbank slug, or whatever `kind` needs
  status TEXT NOT NULL,              -- queued | running | done | failed
  result TEXT,                       -- JSON payload the page renders
  error TEXT,
  created TEXT NOT NULL,
  finished TEXT
);
CREATE INDEX admin_job_created_idx ON admin_job(created DESC);
