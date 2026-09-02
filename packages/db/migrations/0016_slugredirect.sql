-- ========================= 0016_slugredirect.sql ===========================
-- givefood/models/operations.py:44-53 SlugRedirect (a TimestampedModel).
-- PLAN.md:3010: "slugredirect | 57 | D1 is the editable source of truth;
-- the read path is a KV blob (read on every 404)." This migration builds
-- the editable half. workers/site/src/middleware/slugRedirect.ts already
-- reads the KV half; workers/site/src/lib/slugRedirectKv.ts (added with
-- this migration) is what keeps the two in step on every admin write.
--
-- No foreign keys (PLAN.md §4.5, same convention as every other table).
-- `created`/`modified` are ISO-8601 TEXT, same as every other timestamp in
-- this schema -- Django's auto_now_add/auto_now have no SQLite equivalent,
-- so both are stamped explicitly by packages/db/src/slugRedirects.ts.
CREATE TABLE slugredirect (
  id INTEGER PRIMARY KEY,
  old_slug TEXT NOT NULL,            -- CharField(max_length=200, unique=True)
  new_slug TEXT NOT NULL,            -- CharField(max_length=200)
  created TEXT NOT NULL,
  modified TEXT NOT NULL
);

-- Django's unique=True on old_slug (operations.py:46) -- a real integrity
-- constraint, not an access-path index: two rows with the same old_slug
-- would make the KV blob's old->new map silently non-deterministic (last
-- writer wins when the dict is built), so the database has to refuse it.
CREATE UNIQUE INDEX slugredirect_old_slug_uniq ON slugredirect(old_slug);

-- Django also declares db_index=True on new_slug (operations.py:47). NOT
-- ported: nothing in either codebase ever filters or joins on new_slug --
-- the only two reads are `SlugRedirect.objects.all().order_by("-created")`
-- for the admin list (gfadmin/views.py:2278) and
-- `.values_list("old_slug","new_slug")` for the cache blob
-- (givefood/utils/cache.py:25) -- and at 57 rows an unused index is pure
-- write cost.

-- The admin list's only ordering (gfadmin/views.py:2278's `-created`).
-- Cheap at 57 rows, but D1 meters rows scanned and this is the sole
-- access path the list view has.
CREATE INDEX slugredirect_created_idx ON slugredirect(created DESC);
