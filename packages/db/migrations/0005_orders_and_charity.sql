-- ==================== 0005_orders_and_charity.sql =========================
-- WP 4.5's gfdash dashboards: deliveries, price_per_kg, price_per_calorie,
-- price_per_item_category (Order/OrderLine) and charity_income_expenditure
-- (CharityYear). None of these three tables existed in D1 before -- the
-- write side (order creation/editing, Order.save()'s two Gemini calls) is
-- Phase 6 (gfadmin) scope, not this one. This is a read-only one-time
-- snapshot for the dashboards; tools/pg-to-d1/extract_core.py's
-- DASHBOARD_TABLES loads it, and Phase 6 will own keeping it in sync
-- (and adding the write path) when the Orders admin screens are ported.
--
-- `order` is a SQL reserved word (collides with ORDER BY) -- named `orders`
-- here to avoid needing to quote it in every query, same reasoning as
-- foodbankchangeline's `group` -> `group_name` rename below.
--
-- No foreign keys (PLAN.md §4.5): foodbank_id/need_id/order_id/order_group_id
-- are plain integers, validity enforced at read time same as every other
-- table.

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  order_id TEXT NOT NULL,
  items_text TEXT NOT NULL,
  country TEXT NOT NULL,
  created TEXT NOT NULL, modified TEXT NOT NULL,
  notification_email_sent TEXT,
  source_url TEXT,
  delivery_date TEXT NOT NULL, delivery_hour INTEGER NOT NULL, delivery_datetime TEXT NOT NULL,
  delivery_provider TEXT, delivery_provider_id TEXT,
  weight INTEGER NOT NULL, calories INTEGER NOT NULL,
  cost INTEGER NOT NULL, actual_cost INTEGER,
  no_lines INTEGER NOT NULL, no_items INTEGER NOT NULL,
  foodbank_id INTEGER, need_id INTEGER, order_group_id INTEGER
);
CREATE INDEX order_foodbank_delivery_idx ON orders(foodbank_id, delivery_datetime DESC);
CREATE INDEX order_delivery_datetime_idx ON orders(delivery_datetime);

CREATE TABLE orderline (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL, item_cost INTEGER NOT NULL, line_cost INTEGER NOT NULL,
  weight INTEGER, calories INTEGER,
  order_id INTEGER NOT NULL,
  delivery_date TEXT,
  category TEXT, group_name TEXT
);
CREATE INDEX orderline_order_idx ON orderline(order_id);
CREATE INDEX orderline_delivery_date_idx ON orderline(delivery_date);
CREATE INDEX orderline_category_idx ON orderline(category) WHERE category IS NOT NULL;

CREATE TABLE charityyear (
  id INTEGER PRIMARY KEY,
  foodbank_id INTEGER,
  created TEXT, date TEXT,
  income INTEGER, expenditure INTEGER
);
CREATE INDEX charityyear_foodbank_date_idx ON charityyear(foodbank_id, date DESC);
CREATE INDEX charityyear_date_idx ON charityyear(date);
