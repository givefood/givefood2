-- ================= 0017_order_line_category_indexes.sql ===================
-- WP 6.5b (order create/edit/delete). The two tables this work package
-- originally needed -- `ordergroup` and `orderitem` -- are already created
-- by 0015_ordergroup.sql and 0014_orderitem.sql, so nothing is added here.
-- What is still missing is the two indexes OrderLine.save()'s category
-- fallback chain sits on (givefood/models/orders.py:253-262), which the
-- ported line-parse job (workers/jobs/src/adminJobs/orderLines.ts) runs
-- once per DISTINCT parsed item name on every order save.
--
-- No foreign keys, no new tables (PLAN.md 4.5) -- indexes only.

-- First-tier fallback, models/orders.py:255:
--   OrderLine.objects.filter(name=self.name).exclude(category="").latest("id")
-- 0005_orders_and_charity.sql indexed orderline by order_id, delivery_date
-- and category, but never by `name` -- and `name` is the only column this
-- lookup filters on. D1 bills rows scanned, so an unindexed equality probe
-- run once per item name against the whole orderline table is a billing
-- problem as much as a latency one (PLAN.md 11204 makes exactly this point
-- about unindexed lookups). Not partial: rows with an empty/NULL category
-- still have to be skipped by the query, and a partial index on
-- `category != ''` would not be usable for the plain `name = ?` probe if
-- the planner ever wants it for anything else.
CREATE INDEX orderline_name_idx ON orderline(name);

-- Second-tier fallback, models/orders.py:259:
--   FoodbankChangeLine.objects.filter(item=self.name).exclude(category="")
--                             .latest("created")
-- against foodbankchangeline, 332,440 rows in production (PLAN.md 5521).
-- Unindexed this is a full scan of a third of a million rows per unseen
-- item name. `item` is the equality column; `created DESC` is the ordering
-- the `latest("created")` needs, so both go in one composite index and the
-- lookup is answered without a sort.
CREATE INDEX foodbankchangeline_item_created_idx ON foodbankchangeline(item, created DESC);
