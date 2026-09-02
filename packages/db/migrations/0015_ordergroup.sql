-- ========================= 0015_ordergroup.sql ============================
-- WP 6.5b's named blocker, cleared: OrderGroup (givefood/models/orders.py:
-- 314-333), the model behind the admin's Order Groups list/detail/edit
-- pages and the donor-facing /donate/managed/<slug>-<key>/ family.
-- PLAN.md sizes it at 8 rows / 48 kB, "Straight".
--
-- NO COLUMN IS ADDED TO `orders`. `orders.order_group_id` ALREADY EXISTS
-- (0005_orders_and_charity.sql's last column) and is already populated
-- with the real Postgres OrderGroup ids by tools/pg-to-d1/extract_core.py's
-- DASHBOARD_TABLES, so the only thing missing on that side is the index
-- that turns "every order in this group" into a lookup instead of a scan
-- of all 1,050 rows (D1 meters rows scanned, PLAN.md 4.3). Partial,
-- matching orderline_category_idx's own precedent in 0005: the
-- overwhelming majority of orders belong to no group at all.
--
-- No foreign keys (PLAN.md 4.5, same convention as every other table):
-- order_group_id stays a plain integer, validity enforced at read time.
--
-- `key` and `public` need no quoting -- SQLite lists both as fallback
-- tokens, so they are legal identifiers in DDL, SELECT and WHERE (verified
-- directly on SQLite 3.51, not assumed), unlike `order`/`group`, which
-- this schema did have to rename to `orders`/`group_name`.
--
-- THE UNIQUE INDEX ON `slug` IS NOT IN THE DJANGO MODEL and is this
-- migration's one deliberate divergence. OrderGroup.save()
-- (models/orders.py:324-327) slugifies `name` with no uniqueness check, so
-- two groups named the same get the same slug and gfadmin/views.py:2780's
-- get_object_or_404(OrderGroup, slug=slug) then raises
-- MultipleObjectsReturned -- a 500 on both the detail page and the edit
-- form, with no way back out through the UI. The port additionally
-- pre-checks for a collision on write (orderGroupAdmin.ts's
-- upsertOrderGroup) and returns a 400 explaining the clash, so this index
-- is a backstop, not the only guard.
--
-- VERIFY BEFORE APPLYING (read-only, against production Postgres):
--   SELECT slug, COUNT(*) FROM givefood_ordergroup
--   GROUP BY slug HAVING COUNT(*) > 1;
-- must return zero rows across all 8 production rows, otherwise the data
-- load will fail on this index. If it does not, rename the colliding group
-- in Django first -- do not downgrade this to a plain index.
CREATE TABLE ordergroup (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,             -- slugify(name), recomputed on every save (models/orders.py:326)
  public INTEGER NOT NULL DEFAULT 0,
  key TEXT,                       -- 8-char capability token, appears in donor-facing URLs: never regenerate an existing one
  created TEXT NOT NULL,
  modified TEXT NOT NULL
);
CREATE UNIQUE INDEX ordergroup_slug_uniq ON ordergroup(slug);
CREATE INDEX order_ordergroup_idx ON orders(order_group_id) WHERE order_group_id IS NOT NULL;
