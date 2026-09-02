-- ========================= 0014_orderitem.sql =============================
-- WP 6.x (PLAN.md §4.2.1: `orderitem`, 1,200 rows, 424 kB, "Straight"):
-- backing store for /admin/items/ and the item form (gfadmin/views.py:2241-
-- 2273), and for the calorie lookup WP 6.5b's Order.save() port will need
-- (givefood/utils/text.py:118-130 get_calories, the model's only non-admin
-- consumer). Columns are a straight copy of givefood/models/orders.py:291-
-- 311 -- three fields and no more. OrderItem inherits plain models.Model,
-- NOT TimestampedModel, so there is deliberately no created/modified here.
--
-- No foreign keys (§4.5, same as every other table). There is no FK to add
-- anyway: get_calories joins orderline to orderitem on NAME TEXT, not on an
-- id, and that string join is the whole read path.
--
-- orderitem_name_uniq carries Django's `unique=True` on `name`
-- (models/orders.py:293) AND is the index the only hot query uses
-- (`WHERE name = ?`). One index, both jobs.
--
-- orderitem_slug_idx is deliberately NON-unique. Django never declared
-- slug unique and OrderItem.save() (:305-308) does not uniquify it, so two
-- legal names can slugify to one slug -- in Django that makes
-- get_object_or_404(OrderItem, slug=slug) raise MultipleObjectsReturned
-- (a 500). Whether production actually contains a collision could not be
-- checked before writing this migration, so a UNIQUE index here could make
-- the 1,200-row load itself fail. The port instead reads with
-- `ORDER BY id LIMIT 1` (deterministic even if a legacy pair exists) and
-- uniquifies on every write it makes. AFTER the load, run
--   SELECT slug, COUNT(*) FROM orderitem GROUP BY slug HAVING COUNT(*) > 1;
-- and if it returns nothing, promote this to a UNIQUE index in a follow-up
-- migration -- the same verify-then-constrain sequence 0010_article_url_
-- unique.sql used.
CREATE TABLE orderitem (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  calories INTEGER NOT NULL          -- kcal per 100g (help_text "Per 100g")
);
CREATE UNIQUE INDEX orderitem_name_uniq ON orderitem(name);
CREATE INDEX orderitem_slug_idx ON orderitem(slug);
