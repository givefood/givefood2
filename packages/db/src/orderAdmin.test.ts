import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "./schema.testkit";
import { beforeEach, describe, expect, it } from "vitest";
import { getOrderDetail, getOrderLines } from "./orderAdmin";
import type { Session } from "./types";

// The two reads behind /admin/order/<order_id>/ -- gfadmin/views.py:445-452
// order(), which hands admin/order.html a single Order object and lets the
// Django template walk `order.foodbank`, `order.need`, `order.order_group` and
// `order.lines` for itself. This module is those four relation walks flattened
// into one SELECT plus one, and workers/site/src/routes/admin/order.ts is the
// view.
//
// WHY A REAL DATABASE, NOT A MOCK. Both functions are a statement and nothing
// else. A session that hands back canned rows agrees with every possible
// statement including the wrong ones, and every wrong one here is SILENT:
//
//   * LEFT JOIN -> JOIN on `foodbank`. Order.foodbank is null=True and the
//     port creates unassigned orders on purpose (models/orders.py:104-109
//     names them "gf-unassigned-<pk>-..."), so an inner join turns every
//     unassigned order's admin page into a 404. No error, no log -- the row
//     is simply not there.
//   * a dropped `AS` on any of the six aliases. `n.created` unaliased collides
//     with `o.created`, and a result set with two columns of one name collapses
//     to whichever the driver keeps -- so `need_created` is quietly undefined
//     and the "Found" line disappears from the page. Same for `n.need_id`,
//     which would overwrite the order's own integer `need_id` with the need's
//     32-char text uuid and break the link `href` instead.
//   * `ORDER BY weight DESC` dropped from the lines query. The table still
//     renders, in rowid order, and looks entirely plausible.
//   * `WHERE order_id = ?` on the lines query pointed at the wrong order.
//     Someone else's shopping list, rendered without complaint.
//
// None of those throws. This package already carries that exact scar:
// migration 0019 dropped six tables' cached parent columns and four queries
// went on naming them until /dashboard/beautybanks/ was measured and found to
// be a live 500. `f.name AS foodbank_name` below is the post-0019 shape -- the
// column it replaced, foodbankchange.foodbank_name, is dropped at
// 0019_drop_foodbank_cache.sql:57 and would still parse as a real identifier
// in this query if anyone reinstated it against the `foodbank` table alias.
//
// THE FIXTURE IS THE MIGRATION FILES THEMSELVES, applied in order, for the
// same reason a hand-written CREATE TABLE is a second copy of the truth that
// drifts from the first. Facts it supplies that this file depends on and a
// transcription would plausibly have got wrong:
//   * the table is `orders`, not `order` -- `order` collides with ORDER BY
//     (0005_orders_and_charity.sql:11-13).
//   * `orderline.order_id` is an INTEGER holding `orders.id`, while
//     `orders.order_id` is the TEXT human id. Two columns, one name, two
//     tables. See the affinity test at the bottom.
//   * `orderline.weight` and `.calories` are NULLABLE, which is the whole of
//     the NULL-ordering divergence pinned below.
//   * `ordergroup` only exists from migration 0015, which is why this module's
//     header comment says the join was added later.
//
// NO CHUNKING TO TEST. D1 caps a statement at 100 bound parameters, the
// boundary every variable-length IN list in this package has to be tested at.
// Neither function here builds one: getOrderDetail binds exactly one value and
// getOrderLines exactly one, whatever the size of the order. A future edit that
// grew either into an IN list would need that boundary test added.
//
// MUTATION-TESTED (TESTING.md's convention: the evidence a test is
// load-bearing rather than decoration). The module was copied into a
// scratchpad, broken 56 ways, and this file re-run against each. Killed, among
// others: each of the three LEFT JOINs narrowed to an inner join; each of the
// six column aliases dropped; the detail lookup re-pointed at `o.id`, loosened
// to a LIKE prefix, to `lower()`, to `trim()` and to `COLLATE NOCASE`, and
// neutered to `WHERE ? IS NOT NULL`; `foodbank` and `ordergroup` joined on
// `o.need_id`; `need_id` and `need_change_text` read off the wrong side of
// their join; `no_items`/`no_lines`, `cost`/`actual_cost`, `weight`/`calories`,
// `delivery_provider`/`delivery_provider_id`, `delivery_date`/`delivery_hour`
// and `created`/`modified` each transposed; the lines ORDER BY dropped,
// reversed, tiebroken descending, tiebroken by `name`, replaced with
// `ORDER BY name` and with `ORDER BY id`, "corrected" to Django's NULLS FIRST,
// and given a text collation; a LIMIT 20 bolted on; the lines filter dropped
// and re-pointed at `id`; the lines SELECT widened to `*`; `name`/`quantity`
// and `weight`/`calories` transposed within it; `calories` coalesced to 0;
// `quantity` hard-coded; and the results sliced to one row and reversed.
//
// NONE SURVIVE NOW, but four of them survived a first pass and the tests that
// close them are the four most easily deleted in this file:
//   * the need join rewritten as `n.foodbank_id = o.foodbank_id`, and the
//     group join as the tautology `og.id = og.id`. Both fan one order out into
//     several rows, and `.first()` hands back the same object either way. The
//     cardinality test that was supposed to catch this typed the query out a
//     SECOND TIME and counted rows from that copy, which is circular -- a copy
//     agrees with itself however the original is broken. It now recovers the
//     module's own statement from `prepared` and re-runs it, and the seed
//     grew the extra need and second order the fan-out needs to be visible.
//   * `o.foodbank_id` taken off the join as `f.id AS foodbank_id`, invisible
//     while every seeded order's food bank exists. Pinned by its own test.
//   * `, id` deleted from `ORDER BY weight DESC, id`, which changes NO ROWS
//     this file can see -- not for want of seeding, it was measured at up to
//     20,000 equal-weight rows and the two orderings agreed byte for byte. The
//     tiebreak is a GUARANTEE, not an observed behaviour, so the last test in
//     the file asserts the clause still reaches D1; the argument and the
//     measurement are written out there.

type Bindable = null | number | bigint | string | Uint8Array;
interface Prepared {
  sql: string;
  params: Bindable[];
}

// The slice of the D1 Sessions API this package is handed, backed by
// node:sqlite. Copied from needLines.test.ts (itself copied from
// crawlSets.test.ts, itself from adminDashboardStats.test.ts, itself from
// workers/site/src/routes/admin/foodbankLocation.test.ts) so every tier drives
// the real code through one adapter. Deliberately dumb -- it forwards the SQL
// untouched and interprets nothing, so the engine decides which rows come
// back, not this file.
//
// `prepared` is dashboards.test.ts:276's addition to that adapter, taken
// verbatim: each statement is recorded AS IT EXECUTES, so what lands in the
// array is the SQL and the binds the module really sent, never a copy of them
// typed into this file. Two tests below need it, and both would otherwise be
// circular or impossible -- see the cardinality test and the last test in the
// file. It is not a licence to assert on SQL text anywhere else here; every
// other test in this file goes through rows.
function d1Session(db: DatabaseSync, prepared: Prepared[]): Session {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => {
      prepared.push({ sql, params });
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    all: async () => {
      prepared.push({ sql, params });
      return { results: db.prepare(sql).all(...params), success: true, meta: {} };
    },
    run: async () => {
      prepared.push({ sql, params });
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return { prepare: (sql: string) => statement(sql, []), getBookmark: () => null } as unknown as Session;
}

// Ids chosen so that no bind can match the wrong column by coincidence: the
// food bank, the need, the group and the order row all have different numeric
// ids, and none of them is 1. A query with `o.foodbank_id = o.need_id`
// transposed, or `WHERE o.id = ?` where `WHERE o.order_id = ?` belongs, has to
// fail rather than happen to agree.
const SALISBURY = 7;
const BRIXTON = 8;
const NEED_ROW = 41;
const CHRISTMAS = 3;
const ORDER_ROW = 1201;
const OTHER_ORDER_ROW = 1202;

// The real shape models/orders.py:107 writes: "gf-<foodbank slug>-<provider
// slug>-<delivery date>". Deliberately not a bare number -- see the affinity
// test at the bottom, where the difference matters.
const ORDER_ID = "gf-salisbury-tesco-2026-09-05";

// EVERY TIMESTAMP IN THIS FILE IS DJANGO'S FORMAT: "YYYY-MM-DD HH:MM:SS.ffffff",
// which is what pyDatetime() writes and what migration 0022 rewrote the
// imported rows into. These columns are TEXT and SQLite compares TEXT
// byte-wise, so the format is load-bearing across this package -- 'T' (0x54)
// beats ' ' (0x20), which is how an ISO value sorts above every same-day
// Django one (0022_normalise_timestamps.sql:13). Neither function here orders
// or thresholds on a timestamp, so the format is not what these two are
// getting wrong; the tests below instead pin that the values arrive VERBATIM,
// because timesince() in routes/admin/order.ts parses
// `notification_email_sent` itself and a query that reformatted on the way out
// would hand it something it cannot read.
const ORDER_CREATED = "2026-09-01 11:02:03.400000";
const ORDER_MODIFIED = "2026-09-02 08:00:00.000000";
const NOTIFIED = "2026-09-03 17:45:10.905000";
// Deliberately a DIFFERENT day from ORDER_CREATED. `n.created AS need_created`
// and `o.created` are the alias collision described in the header, and two
// equal timestamps would let a collapsed result set pass this file unnoticed.
const NEED_CREATED = "2026-08-30 09:14:22.117000";

// 32-char dashless lowercase, per 0001_core.sql's comment on the column. The
// route slices this to 7 characters for the heading's link text
// (need_id_short, models/needs.py:81-82), so it has to survive the query as
// TEXT and not as the order's integer need_id.
const NEED_UUID = "8f14e45fceea167a5a36dedd4bea2543";

let db: DatabaseSync;
let session: Session;
let prepared: Prepared[];

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  prepared = [];
  session = d1Session(db, prepared);
});

// Only the NOT NULL columns plus the three the query actually reads. A wider
// seed would say nothing extra and would rot the next time the table changes.
function seedFoodbank(id: number, name: string, slug: string): void {
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, slug, address, postcode, country, lat_lng,
                           charity_just_foodbank, contact_email, url, shopping_list_url,
                           address_is_administrative, is_closed, no_locations, days_between_needs,
                           created, modified)
     VALUES (?, ?, ?, ?, '1 Test Street', 'SP2 9DY', 'England', '51.0812,-1.8231',
             1, 'info@example.org', 'https://example.org/', 'https://example.org/list/',
             0, 0, 0, 7, ?, ?)`,
  ).run(id, `uuid-${id}`, name, slug, ORDER_CREATED, ORDER_MODIFIED);
}

function seedNeed(id: number, needId: string, changeText: string, uri: string | null, created: string): void {
  db.prepare(
    `INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, uri, published, input_method, created, modified)
     VALUES (?, ?, ?, ?, ?, 1, 'scrape', ?, ?)`,
  ).run(id, needId, SALISBURY, changeText, uri, created, created);
}

function seedOrderGroup(id: number, name: string, slug: string): void {
  db.prepare(
    `INSERT INTO ordergroup (id, name, slug, public, key, created, modified)
     VALUES (?, ?, ?, 1, 'abcd1234', ?, ?)`,
  ).run(id, name, slug, ORDER_CREATED, ORDER_MODIFIED);
}

interface OrderSeed {
  id: number;
  order_id: string;
  foodbank_id?: number | null;
  need_id?: number | null;
  order_group_id?: number | null;
  notification_email_sent?: string | null;
  source_url?: string | null;
  actual_cost?: number | null;
  delivery_provider?: string | null;
  delivery_provider_id?: string | null;
}

function seedOrder(order: OrderSeed): void {
  db.prepare(
    `INSERT INTO orders (id, order_id, items_text, country, created, modified,
                         notification_email_sent, source_url,
                         delivery_date, delivery_hour, delivery_datetime,
                         delivery_provider, delivery_provider_id,
                         weight, calories, cost, actual_cost, no_lines, no_items,
                         foodbank_id, need_id, order_group_id)
     VALUES (?, ?, '4 x Tinned Tomatoes', 'England', ?, ?,
             ?, ?,
             '2026-09-05', 14, '2026-09-05 14:00:00.000000',
             ?, ?,
             21450, 48200, 12345, ?, 4, 8,
             ?, ?, ?)`,
  ).run(
    order.id,
    order.order_id,
    ORDER_CREATED,
    ORDER_MODIFIED,
    order.notification_email_sent ?? null,
    order.source_url ?? null,
    order.delivery_provider ?? null,
    order.delivery_provider_id ?? null,
    order.actual_cost ?? null,
    order.foodbank_id ?? null,
    order.need_id ?? null,
    order.order_group_id ?? null,
  );
}

interface LineSeed {
  id: number;
  order_id: number;
  name: string;
  quantity?: number;
  weight?: number | null;
  calories?: number | null;
}

function seedLine(line: LineSeed): void {
  db.prepare(
    `INSERT INTO orderline (id, name, quantity, item_cost, line_cost, weight, calories, order_id, delivery_date, category, group_name)
     VALUES (?, ?, ?, 89, 356, ?, ?, ?, '2026-09-05', 'Tinned Vegetables', 'Meal Food')`,
  ).run(line.id, line.name, line.quantity ?? 1, line.weight ?? null, line.calories ?? null, line.order_id);
}

// The order every relation resolves for -- a food bank, a need, a group, a
// notification already sent, a delivered cost. Every string value below is
// distinct from every other, which is what makes the alias assertions real: if
// `f.name` and `og.name` collapsed into one result column, "Salisbury Foodbank"
// and "Christmas 2026" could not both survive.
function seedFullyJoinedOrder(): void {
  seedFoodbank(SALISBURY, "Salisbury Foodbank", "salisbury");
  seedNeed(NEED_ROW, NEED_UUID, "Tinned Tomatoes\r\nLong Grain Rice", "https://salisbury.foodbank.org.uk/need/", NEED_CREATED);
  seedOrderGroup(CHRISTMAS, "Christmas 2026", "christmas-2026");
  seedOrder({
    id: ORDER_ROW,
    order_id: ORDER_ID,
    foodbank_id: SALISBURY,
    need_id: NEED_ROW,
    order_group_id: CHRISTMAS,
    notification_email_sent: NOTIFIED,
    source_url: "https://twitter.com/salisburyfb/status/1",
    actual_cost: 11987,
    delivery_provider: "Tesco",
    delivery_provider_id: "123456789",
  });
}

describe("getOrderDetail", () => {
  // The whole row, asserted value by value rather than field by field, so the
  // test fails on a column that appears as well as one that vanishes. Every
  // alias is checked here at once: `foodbank_name` is the food bank's and not
  // the group's, `need_created` is the need's timestamp and not the order's,
  // `need_id` stays the integer while `need_id_str` carries the uuid.
  //
  // It also pins what is NOT selected. `items_text` (the entire multi-line
  // shopping list), `country`, `delivery_datetime` and `order_group_id` all
  // exist on the row and are deliberately absent -- they belong to the edit
  // form's own read, orderWrite.ts's getOrderForEdit. `SELECT o.*` here would
  // widen the template context silently and put the raw order text into a
  // page that never asks for it.
  it("returns every column of OrderDetailRow, and only those", async () => {
    seedFullyJoinedOrder();

    expect(await getOrderDetail(session, ORDER_ID)).toEqual({
      id: ORDER_ROW,
      order_id: ORDER_ID,
      foodbank_id: SALISBURY,
      foodbank_name: "Salisbury Foodbank",
      foodbank_slug: "salisbury",
      need_id: NEED_ROW,
      need_id_str: NEED_UUID,
      need_change_text: "Tinned Tomatoes\r\nLong Grain Rice",
      need_created: NEED_CREATED,
      need_uri: "https://salisbury.foodbank.org.uk/need/",
      delivery_date: "2026-09-05",
      delivery_hour: 14,
      no_items: 8,
      no_lines: 4,
      weight: 21450,
      calories: 48200,
      cost: 12345,
      actual_cost: 11987,
      source_url: "https://twitter.com/salisburyfb/status/1",
      delivery_provider: "Tesco",
      delivery_provider_id: "123456789",
      notification_email_sent: NOTIFIED,
      order_group_name: "Christmas 2026",
      order_group_slug: "christmas-2026",
      created: ORDER_CREATED,
      modified: ORDER_MODIFIED,
    });
  });

  // Stated on its own because it is the assertion a future reader is most
  // likely to delete as redundant. `n.created AS need_created` sits four
  // columns before `o.created` in the same SELECT; drop the alias and SQLite
  // happily returns two columns both called `created`, of which node:sqlite
  // (and D1) keep exactly one. The page then shows the need's "Found" date as
  // blank while the order's Created line still looks right, so the failure is
  // invisible unless something compares the two.
  it("keeps the need's timestamp and the order's apart", async () => {
    seedFullyJoinedOrder();
    const order = (await getOrderDetail(session, ORDER_ID))!;

    expect(order.need_created).toBe(NEED_CREATED);
    expect(order.created).toBe(ORDER_CREATED);
    expect(order.need_created).not.toBe(order.created);
  });

  // The same trap on the other pair, and the more damaging of the two:
  // `o.need_id` is the integer row id, `n.need_id AS need_id_str` is the
  // 32-char uuid the URL uses. Un-aliased they share a name, one wins, and
  // routes/admin/order.ts:38 (`order.need_id_str.slice(0, 7)`) quietly yields
  // null -- the "Need" heading and its link vanish from a page that otherwise
  // renders perfectly.
  it("keeps the need's row id and its uuid apart", async () => {
    seedFullyJoinedOrder();
    const order = (await getOrderDetail(session, ORDER_ID))!;

    expect(order.need_id).toBe(NEED_ROW);
    expect(order.need_id_str).toBe(NEED_UUID);
    // What the route slices for the heading. Asserted here rather than only in
    // the route's own tests because it is the reason the alias exists at all.
    expect(order.need_id_str!.slice(0, 7)).toBe("8f14e45");
  });

  // THE INNER-JOIN MUTANT, and the reason this file seeds a childless parent
  // at all. models/orders.py:29-34 makes foodbank, need and order_group all
  // null=True, and the port creates orders with none of the three: an
  // unassigned order is "gf-unassigned-<pk>-<provider>-<date>"
  // (models/orders.py:209). Swap any LEFT JOIN for an inner one and this
  // order's admin page becomes a 404 -- c.notFound() on a null row, with
  // nothing logged and nothing to distinguish it from a bad URL.
  it("returns an order that has no food bank, no need and no group", async () => {
    seedOrder({ id: ORDER_ROW, order_id: "gf-unassigned-1201-tesco-2026-09-05" });

    const order = await getOrderDetail(session, "gf-unassigned-1201-tesco-2026-09-05");
    expect(order).not.toBeNull();
    expect(order!.id).toBe(ORDER_ROW);
    expect(order!.foodbank_id).toBeNull();
    expect(order!.foodbank_name).toBeNull();
    expect(order!.foodbank_slug).toBeNull();
    expect(order!.need_id).toBeNull();
    expect(order!.need_id_str).toBeNull();
    expect(order!.need_change_text).toBeNull();
    expect(order!.need_created).toBeNull();
    expect(order!.need_uri).toBeNull();
    expect(order!.order_group_name).toBeNull();
    expect(order!.order_group_slug).toBeNull();
    // The order's own columns are untouched by the missing relations -- the
    // page still has a delivery, a cost and a weight to show.
    expect(order!.delivery_date).toBe("2026-09-05");
    expect(order!.cost).toBe(12345);
  });

  // The same LEFT JOIN doing its second job: surviving a DANGLING id, which
  // this schema allows outright. PLAN.md §4.5 declares no foreign keys, and
  // two live code paths produce exactly this state -- needAdmin.ts:263
  // deleteNeedByUuid removes a foodbankchange row without touching the orders
  // that point at it, and foodbankAdmin.ts:20-28 deleteFoodbankCascade deletes
  // a food bank's needs while only nulling `orders.foodbank_id`. Every order
  // ever placed against one of those needs is left pointing at nothing. An
  // inner join would erase those orders from the admin entirely; the numbers
  // on the deliveries dashboard would still count them.
  it("returns an order whose need and group ids point at rows that no longer exist", async () => {
    seedFoodbank(SALISBURY, "Salisbury Foodbank", "salisbury");
    seedOrder({ id: ORDER_ROW, order_id: ORDER_ID, foodbank_id: SALISBURY, need_id: 999, order_group_id: 998 });

    const order = (await getOrderDetail(session, ORDER_ID))!;
    // The order's own foreign key columns are returned verbatim -- they come
    // from `orders`, not from the join, so a dangling id stays visible rather
    // than being silently nulled.
    expect(order.need_id).toBe(999);
    expect(order.need_id_str).toBeNull();
    expect(order.need_created).toBeNull();
    expect(order.order_group_name).toBeNull();
    // And the half that does resolve still resolves.
    expect(order.foodbank_name).toBe("Salisbury Foodbank");
  });

  // The same claim for `foodbank_id`, which the test above cannot make because
  // it seeds a food bank that exists. Stated separately and honestly: unlike
  // the dangling need above, NO live path produces a dangling foodbank_id --
  // foodbankAdmin.ts:29's cascade runs `UPDATE orders SET foodbank_id = NULL`
  // in the same atomic batch as the DELETE, so the port nulls rather than
  // orphans. The schema permits it anyway (PLAN.md §4.5, no foreign keys), and
  // the column is a template branch, not decoration: admin/order.njk:92 gates
  // the entire Notification block -- the Sent/Not Sent line, the Send
  // Notification button and the email preview -- on `{% if order.foodbank_id %}`.
  //
  // Kills `o.foodbank_id` rewritten as `f.id AS foodbank_id`, which is
  // invisible in every other test in this file because the two are equal
  // whenever the food bank exists. Take the value off the join instead of off
  // the order and the column stops meaning "this order is assigned" and starts
  // meaning "this order's food bank row is still present" -- so the day
  // something does orphan a row, or the day someone narrows that LEFT JOIN,
  // the food bank's delivery notification quietly loses its button.
  it("reads foodbank_id off the order, not off the joined food bank", async () => {
    seedOrder({ id: ORDER_ROW, order_id: ORDER_ID, foodbank_id: 997 });

    const order = (await getOrderDetail(session, ORDER_ID))!;
    expect(order.foodbank_id).toBe(997);
    expect(order.foodbank_name).toBeNull();
    expect(order.foodbank_slug).toBeNull();
  });

  // Each join is independent: a missing group must not cost the page its need,
  // and a missing need must not cost it its group. One LEFT JOIN accidentally
  // written as an inner one is caught by the test above; this catches the
  // subtler version where the three joins are chained through the wrong table
  // alias and one missing row takes another's columns down with it.
  it("resolves the relations that exist when only one is missing", async () => {
    seedFoodbank(SALISBURY, "Salisbury Foodbank", "salisbury");
    seedNeed(NEED_ROW, NEED_UUID, "Tinned Tomatoes", null, NEED_CREATED);
    seedOrder({ id: ORDER_ROW, order_id: ORDER_ID, foodbank_id: SALISBURY, need_id: NEED_ROW, order_group_id: null });

    const order = (await getOrderDetail(session, ORDER_ID))!;
    expect(order.need_id_str).toBe(NEED_UUID);
    expect(order.foodbank_name).toBe("Salisbury Foodbank");
    expect(order.order_group_name).toBeNull();
    // `uri` is nullable on foodbankchange and the template guards on it
    // (admin/order.html:79). NULL from the row, not from a failed join.
    expect(order.need_uri).toBeNull();
  });

  // The lookup is by the HUMAN order id, which is what Django's own view does
  // -- get_object_or_404(Order, order_id=id), views.py:447, not by pk. Two
  // orders, and the one that comes back is the one asked for.
  it("selects by order_id and not by row id", async () => {
    seedFoodbank(SALISBURY, "Salisbury Foodbank", "salisbury");
    seedFoodbank(BRIXTON, "Brixton Foodbank", "brixton");
    seedOrder({ id: ORDER_ROW, order_id: ORDER_ID, foodbank_id: SALISBURY });
    seedOrder({ id: OTHER_ORDER_ROW, order_id: "gf-brixton-sainsburys-2026-09-06", foodbank_id: BRIXTON });

    expect((await getOrderDetail(session, ORDER_ID))!.foodbank_name).toBe("Salisbury Foodbank");
    expect((await getOrderDetail(session, "gf-brixton-sainsburys-2026-09-06"))!.foodbank_name).toBe("Brixton Foodbank");
    // `WHERE o.id = ?` instead of `WHERE o.order_id = ?` would answer this.
    // orders.order_id is TEXT, so "1201" cannot match the integer pk under
    // SQLite's comparison rules unless the query is reading the wrong column.
    expect(await getOrderDetail(session, String(ORDER_ROW))).toBeNull();
  });

  // routes/admin/order.ts:23 turns a null into c.notFound(), matching
  // get_object_or_404. Trivial to assert and the reason the return type is
  // nullable -- a query that threw instead would be a 500 on every mistyped
  // admin URL.
  it("returns null for an order_id nothing holds", async () => {
    seedFullyJoinedOrder();
    expect(await getOrderDetail(session, "gf-salisbury-tesco-2026-09-04")).toBeNull();
    expect(await getOrderDetail(session, "")).toBeNull();
  });

  // Exact string match, no LIKE and no case folding. `order_id` embeds a slug
  // and a date and admins reach these pages from pasted links, so a query that
  // matched loosely would open the wrong order's Cancel and Send Notification
  // buttons -- both destructive, both one click away on this page.
  it("matches the order_id exactly, not by prefix or case", async () => {
    seedFullyJoinedOrder();
    expect(await getOrderDetail(session, "gf-salisbury-tesco")).toBeNull();
    expect(await getOrderDetail(session, "GF-SALISBURY-TESCO-2026-09-05")).toBeNull();
    expect(await getOrderDetail(session, `${ORDER_ID} `)).toBeNull();
  });

  // Nullable columns the template branches on: `{% if order.actual_cost %}`
  // for the delivered cost, `{% if order.source_url %}`, and the
  // Sent/Not Sent split on `notification_email_sent`. NULL has to arrive as
  // null and not as 0 or "" -- routes/admin/order.ts:44 divides actual_cost by
  // 100 behind a truthiness check, and an empty string would render "£0.00" on
  // an order nobody has been billed for yet.
  it("returns nulls, not zeroes or empty strings, for the columns the page branches on", async () => {
    seedFoodbank(SALISBURY, "Salisbury Foodbank", "salisbury");
    seedOrder({ id: ORDER_ROW, order_id: ORDER_ID, foodbank_id: SALISBURY });

    const order = (await getOrderDetail(session, ORDER_ID))!;
    expect(order.actual_cost).toBeNull();
    expect(order.source_url).toBeNull();
    expect(order.notification_email_sent).toBeNull();
    expect(order.delivery_provider).toBeNull();
    expect(order.delivery_provider_id).toBeNull();
  });

  // Numbers as numbers. `cost` and `actual_cost` are pence and the route
  // divides both by 100; `weight` is grams, divided by 1000 and then
  // multiplied by the packaging constant. TEXT coming back for any of them
  // would still produce a plausible number for `/` and then NaN the moment
  // anything multiplies -- weight_kg_pkg is exactly that multiplication.
  it("returns the money and weight columns as numbers", async () => {
    seedFullyJoinedOrder();
    const order = (await getOrderDetail(session, ORDER_ID))!;

    expect(typeof order.cost).toBe("number");
    expect(typeof order.actual_cost).toBe("number");
    expect(typeof order.weight).toBe("number");
    expect(typeof order.calories).toBe("number");
    expect(typeof order.delivery_hour).toBe("number");
    expect(((order.weight / 1000) * 1.18).toFixed(2)).toBe("25.31");
  });

  // Timestamps out verbatim, in Django's format. routes/admin/order.ts:46
  // hands `notification_email_sent` straight to timesince(), which parses the
  // string itself -- so a query that reformatted (or a fixture that wrote
  // toISOString()) would be a silent "NaN ago" on the page. This also pins
  // that the port does not coerce these to any date type on the way out: they
  // are TEXT in, TEXT out.
  it("passes Django-format timestamps through untouched", async () => {
    seedFullyJoinedOrder();
    const order = (await getOrderDetail(session, ORDER_ID))!;

    expect(order.notification_email_sent).toBe("2026-09-03 17:45:10.905000");
    expect(order.created).toBe("2026-09-01 11:02:03.400000");
    expect(order.modified).toBe("2026-09-02 08:00:00.000000");
    expect(order.need_created).toBe("2026-08-30 09:14:22.117000");
    // Space-separated, not 'T'-separated: the distinction migration 0022
    // exists to enforce, and the one every byte-wise comparison in this
    // package depends on.
    for (const value of [order.created, order.modified, order.notification_email_sent!, order.need_created!]) {
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
    }
  });

  // SUSPECT, pinned rather than fixed. `orders.order_id` has no unique index
  // (0005_orders_and_charity.sql declares three indexes, none on it) and
  // Django's own unique_together is ('foodbank', 'delivery_date',
  // 'delivery_provider'), not order_id -- so duplicates are storable. Django
  // then raised MultipleObjectsReturned, a 500 an admin would see and report;
  // `.first()` silently picks one and shows a page whose Cancel button may
  // delete the other. The assertion is deliberately weak on WHICH row comes
  // back: the query has no ORDER BY, so that is the engine's choice and not
  // this module's behaviour to pin.
  it("silently returns one row when two orders share an order_id", async () => {
    seedFoodbank(SALISBURY, "Salisbury Foodbank", "salisbury");
    seedOrder({ id: ORDER_ROW, order_id: ORDER_ID, foodbank_id: SALISBURY });
    seedOrder({ id: OTHER_ORDER_ROW, order_id: ORDER_ID, foodbank_id: SALISBURY });

    const order = await getOrderDetail(session, ORDER_ID);
    expect(order).not.toBeNull();
    expect(order!.order_id).toBe(ORDER_ID);
    expect([ORDER_ROW, OTHER_ORDER_ROW]).toContain(order!.id);
  });

  // Cardinality. Every join is on a primary key, so one order can only ever
  // produce one row -- but that is a property of the ON clauses, not an
  // accident, and `.first()` HIDES a violation completely: a query that fans
  // out to three rows returns the same single object as one that fans out to
  // none, and the page renders identically. Counting is the only way to see it.
  //
  // THE STATEMENT UNDER TEST IS THE MODULE'S OWN, recovered from `prepared`
  // and re-run through .all(). An earlier version of this test typed the four
  // lines of SQL out again and counted the rows THAT returned, which asserted
  // nothing about orderAdmin.ts at all -- a copy of a query agrees with itself
  // however the original is broken. Two mutants proved it: rewriting the need
  // join as `n.foodbank_id = o.foodbank_id` and the group join as
  // `og.id = og.id` both left this file green. They fail here.
  //
  // The seed is what makes the ON clauses observable, and every row of it is
  // load-bearing:
  //   * a SECOND need owned by the SAME food bank, so a join that resolves the
  //     need through `foodbank_id` matches two rows instead of one;
  //   * two extra groups, so a group join that is missing, tautological or
  //     hung off the wrong column fans out across all three;
  //   * a second order, so a dropped WHERE shows up as a count too.
  // Seed only the joined-to rows the order actually points at and every one of
  // those mutants matches exactly one row by luck.
  it("produces exactly one row per order however many groups and needs exist", async () => {
    seedFullyJoinedOrder();
    seedOrderGroup(4, "Harvest 2026", "harvest-2026");
    seedOrderGroup(5, "Easter 2027", "easter-2027");
    seedNeed(42, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "Rice", null, NEED_CREATED);
    seedFoodbank(BRIXTON, "Brixton Foodbank", "brixton");
    seedOrder({
      id: OTHER_ORDER_ROW,
      order_id: "gf-brixton-sainsburys-2026-09-06",
      foodbank_id: BRIXTON,
      need_id: 42,
      order_group_id: 4,
    });

    expect(await getOrderDetail(session, ORDER_ID)).not.toBeNull();
    const statement = prepared[0]!;
    expect(db.prepare(statement.sql).all(...statement.params)).toHaveLength(1);
  });

  // The header's "NO CHUNKING TO TEST" claim, made executable rather than left
  // as prose. D1 refuses a statement with more than 100 bound parameters, and
  // every variable-length IN list in this package has to be tested at that
  // boundary; neither function here builds one, so neither has such a test.
  // That is only true while both queries stay at one bind. Grow either into
  // `WHERE order_id IN (...)` -- the obvious way to make the admin's order
  // list fetch its lines in one round trip -- and this fails, which is the
  // prompt to add the boundary test rather than to discover the 100-parameter
  // ceiling in production.
  //
  // BOTH SIDES ARE COUNTED, and the placeholder count is not redundant: a
  // statement widened to `IN (?, ?)` while still binding one value survived an
  // assertion on `params.length` alone. It survives because node:sqlite does
  // not raise on the mismatch -- run directly, `SELECT id FROM orders WHERE
  // order_id IN (?, ?)` given a single bind returns the row, the second
  // placeholder silently NULL. Whether D1 is as forgiving was not tested and is
  // not claimed; the point is that this harness is, so counting binds alone
  // would let a half-written IN list through the one test that exists to notice
  // one.
  it("binds exactly one parameter per statement, so there is no chunking boundary to test", async () => {
    seedFullyJoinedOrder();
    seedLine({ id: 501, order_id: ORDER_ROW, name: "Tinned Tomatoes", weight: 900 });

    await getOrderDetail(session, ORDER_ID);
    await getOrderLines(session, ORDER_ROW);
    expect(prepared.map((statement) => statement.params.length)).toEqual([1, 1]);
    expect(prepared.map((statement) => statement.sql.split("?").length - 1)).toEqual([1, 1]);
  });
});

// The lines table on the right of admin/order.html:112-135, and the same
// ordering orderWrite.ts's getOrderLinesByWeight uses for the notification
// email -- the module comment says the two agree, so a change to one that
// misses the other shows the food bank a different list from the one the admin
// approved.
describe("getOrderLines", () => {
  // Four lines whose weight order, id order and insertion order all differ, so
  // that no wrong ORDER BY can pass by coincidence:
  //   * rowid order (no ORDER BY at all) is Tomatoes, Rice, Teabags, Nappies
  //   * `weight ASC` is the reverse of the expected order
  //   * `weight DESC, id DESC` swaps Tomatoes and Teabags
  //   * 1000 vs 900 is the numeric comparison: lexicographically "1000" sorts
  //     BELOW "900", so a text comparison would put Tinned Tomatoes first.
  function seedFourLines(): void {
    seedLine({ id: 501, order_id: ORDER_ROW, name: "Tinned Tomatoes", quantity: 4, weight: 900, calories: 1200 });
    seedLine({ id: 502, order_id: ORDER_ROW, name: "Long Grain Rice", quantity: 2, weight: 1000, calories: 3500 });
    seedLine({ id: 503, order_id: ORDER_ROW, name: "Teabags", quantity: 1, weight: 900, calories: 0 });
    seedLine({ id: 504, order_id: ORDER_ROW, name: "Nappies", quantity: 1, weight: null, calories: null });
  }

  it("returns the lines heaviest first, with id as the tiebreak", async () => {
    seedFourLines();

    const lines = await getOrderLines(session, ORDER_ROW);
    expect(lines.map((line) => line.name)).toEqual(["Long Grain Rice", "Tinned Tomatoes", "Teabags", "Nappies"]);
  });

  // DIVERGENCE FROM DJANGO, pinned rather than fixed (TESTING.md's rule), and
  // the reason the ordering test above lists Nappies last.
  //
  // Order.lines() is `order_by("-weight")` on Postgres, where NULLs sort as
  // larger than any non-null value and NULLS FIRST is the default for DESC. On
  // SQLite NULL is the smallest value, so DESC puts it last. A line whose
  // weight is unknown therefore appears at the TOP of Django's table and at the
  // BOTTOM of this one. Both engines were run, not reasoned about:
  //
  //   sqlite> SELECT name FROM t ORDER BY weight DESC, id;   -- c,a,d,b  (NULL last)
  //   postgres=# SELECT name FROM (VALUES ...) ORDER BY weight DESC, name;
  //                                                          -- b,c,a,d  (NULL first)
  //
  // Reachable only for rows with a NULL weight: orderWrite.ts's
  // insertOrderLines always binds a number, so this is the imported Postgres
  // rows and anything that predates that writer. Cosmetic on this page -- but
  // getOrderLinesByWeight orders identically for the notification EMAIL, where
  // the same reordering goes out to the food bank.
  it("sorts a line with no weight last, where Django sorted it first", async () => {
    seedFourLines();

    const lines = await getOrderLines(session, ORDER_ROW);
    expect(lines[lines.length - 1]).toEqual({ name: "Nappies", quantity: 1, weight: null, calories: null });
  });

  // The filter, tested with rows that MUST be excluded rather than only with
  // rows that must be included. The intruder is seeded heavier than anything in
  // the real order, so a dropped or widened WHERE puts it at the TOP of the
  // table -- an item from a completely different food bank's delivery, first in
  // the list, with nothing to mark it as foreign.
  it("excludes another order's lines", async () => {
    seedFourLines();
    seedLine({ id: 601, order_id: OTHER_ORDER_ROW, name: "Pallet Of Beans", quantity: 100, weight: 99999, calories: 500000 });

    const lines = await getOrderLines(session, ORDER_ROW);
    expect(lines.map((line) => line.name)).toEqual(["Long Grain Rice", "Tinned Tomatoes", "Teabags", "Nappies"]);
    expect(lines.map((line) => line.name)).not.toContain("Pallet Of Beans");

    // And the other order gets its own line and only its own -- a filter
    // pinned in one direction only would pass the assertion above with
    // `WHERE order_id = 1201` hard-coded.
    expect((await getOrderLines(session, OTHER_ORDER_ROW)).map((line) => line.name)).toEqual(["Pallet Of Beans"]);
  });

  // An order whose queue job has not run yet, which is the state
  // routes/admin/order.ts:47-55 renders the job banner for. Empty array, not
  // null and not a throw -- the template iterates it.
  it("returns an empty array for an order with no lines", async () => {
    seedFourLines();
    expect(await getOrderLines(session, OTHER_ORDER_ROW)).toEqual([]);
  });

  // Exactly the four columns the table needs. `orderline` also holds
  // item_cost, line_cost, delivery_date, category and group_name; `SELECT *`
  // would push all five into the template context, and category/group_name are
  // the AI-assigned values the admin has never reviewed on this page.
  it("selects only name, quantity, weight and calories", async () => {
    seedFourLines();

    const lines = await getOrderLines(session, ORDER_ROW);
    expect(Object.keys(lines[0]!).sort()).toEqual(["calories", "name", "quantity", "weight"]);
    expect(lines[0]).toEqual({ name: "Long Grain Rice", quantity: 2, weight: 1000, calories: 3500 });
  });

  // NULL and 0 calories are different rows to this page and must stay
  // different: admin/order.html:127-133 renders an "Add" button beside a line
  // whose calories are 0, so that an admin can create the missing OrderItem.
  // Coalescing NULL to 0 in the query would put that button on every line
  // whose calories were merely unknown; coalescing 0 to NULL would hide it on
  // the lines that need it.
  it("keeps a zero calorie count distinct from an unknown one", async () => {
    seedFourLines();

    const byName = new Map((await getOrderLines(session, ORDER_ROW)).map((line) => [line.name, line]));
    expect(byName.get("Teabags")!.calories).toBe(0);
    expect(byName.get("Nappies")!.calories).toBeNull();
  });

  // The two-columns-one-name trap named in this file's header, executed.
  // `orderline.order_id` is the INTEGER `orders.id`; `orders.order_id` is the
  // TEXT human id. The route passes `order.id` (routes/admin/order.ts:25) and
  // TypeScript is the first guard, but the failure mode if it ever stopped
  // being is an empty items table on a page that otherwise renders -- no
  // error, and indistinguishable from a queue job that has not run.
  //
  // Worth pinning because SQLite's column affinity makes the near-miss
  // survivable: INTEGER affinity converts a bindable numeric STRING, so
  // `WHERE order_id = '1201'` really does match row 1201. It is only the
  // non-numeric shape of a real order_id that makes this return nothing.
  it("takes the row id, not the human order_id", async () => {
    seedFourLines();

    expect(await getOrderLines(session, ORDER_ID as unknown as number)).toEqual([]);
    // The affinity conversion, so the reason for the line above is on the
    // record rather than inferred.
    expect((await getOrderLines(session, String(ORDER_ROW) as unknown as number)).map((line) => line.name)).toEqual([
      "Long Grain Rice",
      "Tinned Tomatoes",
      "Teabags",
      "Nappies",
    ]);
  });

  // A real order is 20-40 lines and the ordering has to hold across all of
  // them, not just across four. Seeded with descending ids against ascending
  // weights so that rowid order is the exact reverse of the answer -- the one
  // arrangement a missing ORDER BY cannot fake.
  it("orders a full-sized order, not just a handful of lines", async () => {
    for (let i = 0; i < 40; i += 1) {
      seedLine({ id: 700 + (39 - i), order_id: ORDER_ROW, name: `Item ${String(i).padStart(2, "0")}`, weight: 100 + i * 10 });
    }

    const lines = await getOrderLines(session, ORDER_ROW);
    expect(lines).toHaveLength(40);
    expect(lines[0]!.name).toBe("Item 39");
    expect(lines[0]!.weight).toBe(490);
    expect(lines[39]!.name).toBe("Item 00");
    expect(lines[39]!.weight).toBe(100);
    // Monotonically non-increasing throughout, which is the claim the two
    // endpoints alone do not make.
    for (let i = 1; i < lines.length; i += 1) {
      expect(lines[i]!.weight!).toBeLessThanOrEqual(lines[i - 1]!.weight!);
    }
  });

  // Every equal-weight run is ordered by id ascending -- the module comment's
  // stated reason for the tiebreak ("so two equal weights don't reorder between
  // renders"). Ten lines of one weight, inserted with ids out of order, is
  // enough that an unstable sort or a `, id DESC` would show.
  it("breaks a run of equal weights by ascending id", async () => {
    const ids = [808, 801, 806, 803, 809, 802, 807, 804, 800, 805];
    for (const id of ids) seedLine({ id, order_id: ORDER_ROW, name: `Line ${id}`, weight: 500 });

    const lines = await getOrderLines(session, ORDER_ROW);
    expect(lines.map((line) => line.name)).toEqual([...ids].sort((a, b) => a - b).map((id) => `Line ${id}`));
  });

  // THE MUTANT NO FIXTURE IN THIS FILE CAN CATCH, and the reason this one
  // assertion is on the statement rather than on the rows. Deleting `, id`
  // from `ORDER BY weight DESC, id` leaves every test above green, including
  // the ten-equal-weights one directly overhead. That is not a gap in the
  // seeds -- it was measured, not assumed:
  //
  //   node:sqlite, 10 / 100 / 1,000 / 5,000 / 20,000 rows all of one weight,
  //   inserted with their ids deliberately shuffled so insertion order and id
  //   order differ, `WHERE order_id = ?` served through orderline_order_idx:
  //   `ORDER BY weight DESC` and `ORDER BY weight DESC, id` returned byte-for
  //   -byte identical id sequences at every size.
  //
  // They agree because SQLite's sorter happens to preserve scan order for rows
  // it cannot distinguish, and scan order here is rowid order, which IS id
  // order -- `id INTEGER PRIMARY KEY` is the rowid (0005_orders_and_charity
  // .sql:38). None of that is promised. SQLite documents no stable sort, and
  // the agreement is a property of this engine, this planner and this table
  // shape; D1 is a different build meeting different cardinalities, and an
  // added index or a widened ORDER BY is enough to change the plan.
  //
  // What the tiebreak buys is therefore a GUARANTEE, and a guarantee that
  // currently holds by luck cannot be observed by asking for rows. The failure
  // it prevents is real and would be near-impossible to diagnose: two
  // equal-weight lines swapping places between two renders of the same order,
  // and -- because orderWrite.ts's getOrderLinesByWeight sorts identically for
  // the notification email -- an email whose item list does not match the page
  // the admin approved it from. Following dashboards.test.ts:2052's precedent
  // for exactly this situation, and on the same terms: this is the last test
  // in the file, and it is not a licence to assert on SQL text anywhere else.
  it("keeps the id tiebreak in the statement that reaches D1", async () => {
    seedFourLines();

    await getOrderLines(session, ORDER_ROW);
    expect(prepared[0]!.sql).toMatch(/ORDER BY weight DESC, id$/);
  });
});
