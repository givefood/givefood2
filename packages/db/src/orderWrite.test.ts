// @ts-ignore -- node:sqlite has no types under this package's tsconfig, whose
// `"types": ["@cloudflare/workers-types"]` deliberately excludes @types/node
// (orderGroupAdmin.test.ts and foodbankAdmin.test.ts carry the same note). The
// import works at runtime -- vitest runs this file in a node environment --
// and the SqliteDb type below is the whole cost of getting a real SQL engine
// in here. `@ts-ignore` rather than `@ts-expect-error`: if someone later adds
// @types/node to this package, an expect-error directive would itself become
// the error and break `pnpm typecheck` for everyone.
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "./schema.testkit";
// @ts-ignore -- same reason.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  d1Timestamp,
  deleteOrder,
  deleteOrderLines,
  deliveryDatetime,
  findConflictingOrder,
  getFoodbankOptionById,
  getLatestNeedLineCategory,
  getLatestOrderLineCategory,
  getNeedOptionsForFoodbank,
  getOpenFoodbankOptions,
  getOrderForEdit,
  getOrderForLineParse,
  getOrderGroupForOrder,
  getOrderGroupOptions,
  getOrderItemCalories,
  getOrderLinesByWeight,
  insertOrderLines,
  recomputeFoodbankLastOrder,
  setOrderAggregates,
  setOrderId,
  setOrderNotificationSent,
  slugifyProvider,
  upsertOrder,
} from "./orderWrite";
import type { Session } from "./types";

// orderWrite.ts is the WRITE half of the Orders admin: the form's option
// lists, the unique_together pre-flight, the `orders` row itself, and the six
// queries the "order-lines" queue job owns. Twenty exported symbols, of which
// seventeen are a SQL statement and nothing else.
//
// WHY A REAL DATABASE. Nothing in this module can throw on a wrong query. A
// dropped `WHERE is_closed = 0` still returns food banks. A `LIMIT` bound in
// the wrong position still returns needs. An INSERT whose column list and
// VALUES tuple have drifted apart by one still writes a row -- with the
// address in the place_id column, which is github #34 in this package's own
// history. And a session that hands back canned rows agrees with all of it.
// Migration 0019 is the scar: four queries went on naming columns it had
// dropped and /dashboard/beautybanks/ was a live 500 nobody noticed until it
// was measured.
//
// The failures this file is built to catch, each of them silent:
//
//   * getOpenFoodbankOptions losing `WHERE is_closed = 0` -- a closed food
//     bank back in the <select>, and orderForm.ts only rejects the choice
//     when it is NOT the order's existing one.
//   * sortByName replaced by a SQL `ORDER BY name` -- D1's byte-wise
//     collation puts every capital before every lowercase, so "bermondsey"
//     lands after "Zebedee" in a list an admin scans by eye.
//   * getNeedOptionsForFoodbank binding (limit, foodbankId) instead of
//     (foodbankId, limit) -- a form full of some other food bank's needs.
//   * upsertOrder's UPDATE naming `created` -- every edit silently restamps
//     the order's creation date, and the deliveries dashboard's history moves.
//   * insertOrderLines writing to `group` instead of `group_name` -- the
//     column 0005 renamed because `group` is a SQL keyword.
//   * getLatestOrderLineCategory dropping the NULL guard -- `category != ''`
//     alone already excludes NULL under SQLite's three-valued logic, so the
//     mutation is invisible until someone "simplifies" the other way.
//
// THE FIXTURE IS THE MIGRATION FILES THEMSELVES, applied in order, exactly as
// orderAdmin.test.ts does -- a hand-transcribed CREATE TABLE is a second copy
// of the truth that drifts from the first. It is also the only honest way to
// test getNeedOptionsForFoodbank, which reads the VIEW
// `foodbankchange_full`: that view is created by 0019_drop_foodbank_cache.sql
// and its `foodbank_name` is a LEFT JOIN onto `foodbank`, not the column of
// the same name 0019 dropped from `foodbankchange`. A hand-built stand-in
// table with a literal foodbank_name column would make every assertion about
// it circular and would agree with the pre-0019 query that broke production.
//
// MUTATION-TESTED, in two passes. The module was copied into a scratchpad,
// broken 157 different ways across every one of its 23 exported symbols, and
// this file re-run against each -- the evidence that these tests are
// load-bearing rather than decoration. Caught: the dropped `is_closed` filter,
// sortByName replaced by a SQL ORDER BY, the (foodbankId, limit)
// transposition, `ORDER BY created` losing its DESC, the unconditional
// `id != ?` on a create, the conflict check without its provider clause,
// `WHERE order_id = ?` where `WHERE id = ?` belongs and vice versa, an UPDATE
// that restamps `created`, clears `notification_email_sent` or stops
// re-zeroing the aggregates, setOrderId growing a `modified`, deleteOrder
// split back into two round trips, MAX becoming MIN, `edited` stamped by the
// recompute, item_cost and line_cost swapped, insertOrderLines folded into a
// multi-row VALUES (the D1 100-parameter mutant), a `LIKE` on the calories
// lookup, both category fallbacks reordered or losing their empty-string
// guard, d1Timestamp returning an ISO string or three fractional digits, an
// unpadded delivery hour, slugify(null) yielding "" instead of "none", and
// every widened SELECT list.
//
// THE SECOND PASS WAS ADVERSARIAL, and five mutants survived the first. Four
// of them survived because SQLITE'S CHOSEN QUERY PLAN HAPPENED TO PRODUCE THE
// RIGHT ANSWER ANYWAY -- the most dangerous shape a hole can take, because
// every row assertion goes on passing while the statement stops asking for
// what it needs:
//
//   * `ORDER BY created DESC` -> `ORDER BY id DESC` on the need list. Every
//     fixture inserted needs whose ids ascended in step with created.
//   * the same ORDER BY deleted outright: change_foodbank_created_idx is
//     (foodbank_id, created DESC), so the index walk supplies the order.
//   * `MAX(delivery_date)` -> a bare `SELECT delivery_date`:
//     order_foodbank_delivery_idx is (foodbank_id, delivery_datetime DESC),
//     so the first row reached is already the latest.
//   * `ORDER BY weight DESC, id` losing its tiebreak: id is the rowid and
//     SQLite's temp-B-tree left equal weights in arrival order.
//
//   The fifth was `getUTCHours()` -> `getHours()`, invisible while
//   vitest.config.mts pins TZ=UTC.
//
// Each is now killed -- by a fixture where the two orderings genuinely differ
// where one exists, and otherwise by pinning the clause on the statement
// itself, which is where the guarantee lives when the plan is free to change.
// Three mutants remain alive and are EQUIVALENT, not holes: `is_closed = 0` ->
// `IS NOT 1` (the column is INTEGER NOT NULL), `ORDER BY id` -> `id DESC` on
// the calories lookup (orderitem_name_uniq forbids a second row), and dropping
// `category IS NOT NULL` from the first category fallback (`NULL != ''` is
// UNKNOWN, so the != alone already excludes it). All three are pinned and
// explained where they occur below.
//
// Facts the real DDL supplies that a transcription would plausibly get wrong:
//   * the table is `orders`, not `order` (`order` collides with ORDER BY).
//   * `orderline.order_id` is the INTEGER `orders.id`; `orders.order_id` is
//     the TEXT human id. Two columns, one name, two tables.
//   * `orderline.category` is NULLABLE (0005) while
//     `foodbankchangeline.category` is NOT NULL (0003) -- which is why the
//     two category fallbacks below are spelt differently.
//   * `orderitem_name_uniq` exists (0014), which is what makes
//     getOrderItemCalories's `ORDER BY id LIMIT 1` unreachable today.
//   * `orders.country` is NOT NULL, so an unassigned order stores "" -- not
//     NULL, which the column would reject.
// @ts-ignore -- `ImportMeta` here is @cloudflare/workers-types', which
// declares no `url`. vitest runs this file as an ES module in node, where it
// is real; same reason as the node:sqlite import above.

// ---------------------------------------------------------------------------
// The slice of the D1 Sessions API this module uses, over node:sqlite.
// Deliberately dumb -- it forwards the SQL untouched and interprets nothing,
// so the engine decides which rows come back, not this file.
//
// batch() RUNS ITS STATEMENTS IN A TRANSACTION, because D1's does. That is
// the entire stated reason deleteOrder builds one ("so a half-delete --
// orphaned orderline rows pointing at a vanished order -- is not reachable"),
// and modelling the transaction is what turns that sentence into something
// assertable.
//
// Every statement is also RECORDED, because two claims in this module are
// about the statements rather than the rows: that findConflictingOrder issues
// none at all for an unassigned order, and that insertOrderLines binds a
// fixed ten parameters per statement however long the order is.
// ---------------------------------------------------------------------------
type SqliteDb = {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number | bigint };
  };
};

interface Recorded {
  sql: string;
  params: unknown[];
}

interface FakeStatement extends Recorded {
  bind(...values: unknown[]): FakeStatement;
  first<T>(): Promise<T | null>;
  all(): Promise<{ results: unknown[]; success: boolean; meta: Record<string, unknown> }>;
  run(): Promise<{ success: boolean; meta: Record<string, unknown> }>;
}

function d1Session(db: SqliteDb): { session: Session; sent: Recorded[]; batches: Recorded[][] } {
  const sent: Recorded[] = [];
  const batches: Recorded[][] = [];

  // bind() returns a NEW statement rather than mutating this one, matching
  // D1's immutable prepared statements. A harness that mutated in place would
  // let the last line of an order quietly overwrite every earlier line's
  // bindings and turn a 40-item batch into 40 copies of item 40.
  const statement = (sql: string, params: unknown[]): FakeStatement => ({
    sql,
    params,
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => {
      sent.push({ sql, params });
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    all: async () => {
      sent.push({ sql, params });
      return { results: db.prepare(sql).all(...params), success: true, meta: {} };
    },
    run: async () => {
      sent.push({ sql, params });
      const info = db.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(info.changes) } };
    },
  });

  const session = {
    prepare: (sql: string) => statement(sql, []),
    async batch(statements: FakeStatement[]) {
      batches.push(statements.map((s) => ({ sql: s.sql, params: s.params })));
      for (const s of statements) sent.push({ sql: s.sql, params: s.params });
      db.exec("BEGIN");
      try {
        const results = statements.map((s) => {
          const info = db.prepare(s.sql).run(...s.params);
          return { success: true, results: [], meta: { changes: Number(info.changes) } };
        });
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    getBookmark: () => null,
  };

  return { session: session as unknown as Session, sent, batches };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Ids chosen so no bind can match the wrong column by coincidence: the food
// banks, the needs, the groups and the order rows all live in different
// numeric ranges and none of them is 1. A query with two arguments transposed
// has to fail rather than happen to agree.
const SALISBURY = 7;
const BRIXTON = 8;
const CLOSED = 9;
const NEED_ROW = 41;
const OTHER_NEED_ROW = 42;
const CHRISTMAS = 3;
const HARVEST = 4;
const ORDER_ROW = 1201;
const OTHER_ORDER_ROW = 1202;

// EVERY TIMESTAMP IN THIS FILE IS DJANGO'S FORMAT: "YYYY-MM-DD HH:MM:SS.ffffff".
// These columns are TEXT and SQLite compares TEXT byte-wise, so the format is
// load-bearing: 'T' (0x54) beats ' ' (0x20), which is how a JavaScript
// toISOString() value sorts above every same-day Django one. That is not a
// hypothetical -- it is migration 0022_normalise_timestamps.sql, written after
// `ORDER BY created DESC LIMIT 1` returned the wrong latest need in production.
// getNeedOptionsForFoodbank and getLatestNeedLineCategory both order on such a
// column, so both are tested against it below.
const EARLIER = "2026-08-30 09:14:22.117000";
const LATER = "2026-09-01 11:02:03.400000";

// The instant every write in this file is frozen at, and its d1Timestamp form.
// Spelt out rather than computed, so a change to d1Timestamp's shape fails
// here loudly instead of agreeing with itself.
const NOW_INSTANT = "2026-09-07T11:22:33.456Z";
const NOW_D1 = "2026-09-07 11:22:33.456000";

let db: SqliteDb;
let session: Session;
let sent: Recorded[];
let batches: Recorded[][];

beforeEach(() => {
  // @ts-ignore -- see the import comment.
  db = new DatabaseSync(":memory:") as SqliteDb;
  db.exec(SCHEMA);
  ({ session, sent, batches } = d1Session(db));
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
});

// Date only, so the awaits in these tests still resolve on a real event loop.
function freezeClock(instant: string = NOW_INSTANT): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(instant));
}

// A generic INSERT built from the object's own keys, so each seed names only
// the columns a test cares about and the NOT NULL filler lives in one place
// per table. Bound, not interpolated, so an apostrophe in a food bank name is
// not a syntax error waiting to happen.
function insert(table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...columns.map((c) => row[c] ?? null));
}

function readRow(table: string, id: number): Record<string, unknown> {
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown>;
}

// Every NOT NULL column 0001_core.sql declares on `foodbank`. Spelt out rather
// than trimmed to the interesting few because the real DDL is what the fixture
// applies, and a shorter INSERT simply will not run.
function seedFoodbank(row: { id: number; name: string; slug: string; country?: string; is_closed?: number; last_order?: string | null; edited?: string | null }): void {
  insert("foodbank", {
    id: row.id,
    uuid: `uuid-${row.id}`,
    name: row.name,
    slug: row.slug,
    address: "1 Test Street",
    postcode: "SP2 9DY",
    country: row.country ?? "England",
    lat_lng: "51.0812,-1.8231",
    charity_just_foodbank: 1,
    contact_email: "info@example.org",
    url: "https://example.org/",
    shopping_list_url: "https://example.org/list/",
    address_is_administrative: 0,
    is_closed: row.is_closed ?? 0,
    no_locations: 0,
    days_between_needs: 7,
    last_order: row.last_order ?? null,
    created: EARLIER,
    modified: EARLIER,
    edited: row.edited ?? null,
  });
}

function seedNeed(row: { id: number; need_id: string; foodbank_id: number | null; created: string }): void {
  insert("foodbankchange", {
    id: row.id,
    need_id: row.need_id,
    foodbank_id: row.foodbank_id,
    change_text: "Tinned Tomatoes",
    published: 1,
    input_method: "scrape",
    created: row.created,
    modified: row.created,
  });
}

function seedOrderGroup(row: { id: number; name: string; slug: string; public?: number }): void {
  insert("ordergroup", { id: row.id, name: row.name, slug: row.slug, public: row.public ?? 1, key: `key${row.id}`, created: EARLIER, modified: EARLIER });
}

interface OrderSeed {
  id: number;
  order_id: string;
  foodbank_id?: number | null;
  need_id?: number | null;
  order_group_id?: number | null;
  items_text?: string;
  country?: string;
  delivery_date?: string;
  delivery_hour?: number;
  delivery_provider?: string | null;
  delivery_provider_id?: string | null;
  source_url?: string | null;
  actual_cost?: number | null;
  notification_email_sent?: string | null;
  created?: string;
  modified?: string;
  weight?: number;
  calories?: number;
  cost?: number;
  no_lines?: number;
  no_items?: number;
}

function seedOrder(row: OrderSeed): void {
  const deliveryDate = row.delivery_date ?? "2026-09-05";
  const deliveryHour = row.delivery_hour ?? 14;
  insert("orders", {
    id: row.id,
    order_id: row.order_id,
    items_text: row.items_text ?? "4 x Tinned Tomatoes",
    country: row.country ?? "England",
    created: row.created ?? LATER,
    modified: row.modified ?? LATER,
    notification_email_sent: row.notification_email_sent ?? null,
    source_url: row.source_url ?? null,
    delivery_date: deliveryDate,
    delivery_hour: deliveryHour,
    delivery_datetime: deliveryDatetime(deliveryDate, deliveryHour),
    delivery_provider: row.delivery_provider ?? null,
    delivery_provider_id: row.delivery_provider_id ?? null,
    weight: row.weight ?? 21450,
    calories: row.calories ?? 48200,
    cost: row.cost ?? 12345,
    actual_cost: row.actual_cost ?? null,
    no_lines: row.no_lines ?? 4,
    no_items: row.no_items ?? 8,
    foodbank_id: row.foodbank_id ?? null,
    need_id: row.need_id ?? null,
    order_group_id: row.order_group_id ?? null,
  });
}

function seedLine(row: { id: number; order_id: number; name: string; quantity?: number; weight?: number | null; category?: string | null; delivery_date?: string }): void {
  insert("orderline", {
    id: row.id,
    name: row.name,
    quantity: row.quantity ?? 1,
    item_cost: 89,
    line_cost: 356,
    weight: row.weight === undefined ? 900 : row.weight,
    calories: 1200,
    order_id: row.order_id,
    delivery_date: row.delivery_date ?? "2026-09-05",
    category: row.category === undefined ? "Tinned Vegetables" : row.category,
    group_name: "Meal Food",
  });
}

function seedNeedLine(row: { id: number; item: string; category: string; created: string; type?: string }): void {
  insert("foodbankchangeline", {
    id: row.id,
    need_id: NEED_ROW,
    foodbank_id: SALISBURY,
    item: row.item,
    type: row.type ?? "need",
    category: row.category,
    group_name: "Meal Food",
    created: row.created,
  });
}

// ===========================================================================
// d1Timestamp -- the format, and the reason this module has its own instead of
// using pyNow() like every other admin write path in the package.
// ===========================================================================
describe("d1Timestamp", () => {
  // The exact shape tools/pg-to-d1/extract_core.py wrote for every migrated
  // row: space-separated, six fractional digits, UTC. `orders.created` and
  // `orders.delivery_datetime` are both sorted on directly against those
  // migrated rows (adminLists.ts's getOrdersPage, order_delivery_datetime_idx),
  // and SQLite compares TEXT byte-wise, so anything else sorts inconsistently
  // with the neighbours it was written beside.
  it("writes the migrated Django shape, not an ISO string", () => {
    expect(d1Timestamp(new Date("2026-09-05T19:28:08.853Z"))).toBe("2026-09-05 19:28:08.853000");
    expect(d1Timestamp(new Date("2026-09-05T19:28:08.853Z"))).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
  });

  // THE BUG THIS FUNCTION EXISTS TO PREVENT, executed rather than asserted.
  // Migration 0022's own worked example: within a single day EVERY ISO value
  // sorts after EVERY Django value no matter the real time, because 'T' is
  // 0x54 and ' ' is 0x20. Measured consequences before 0022 ran: the wrong
  // "latest published need" from an `ORDER BY created DESC LIMIT 1`, and 31 of
  // 46 same-day rows dropped by a `WHERE created >= <threshold>`.
  it("sorts correctly against migrated rows where toISOString() does not", () => {
    const morning = new Date("2026-09-05T08:00:00.000Z");
    const migratedEvening = "2026-09-05 20:00:00.000000";

    expect(d1Timestamp(morning) < migratedEvening).toBe(true);
    // The mutant: the same instant as an ISO string sorts ABOVE an evening
    // that really happened twelve hours later.
    expect(morning.toISOString() > migratedEvening).toBe(true);

    // And the engine agrees -- this is a TEXT comparison in SQLite, not a
    // JavaScript one.
    expect(db.prepare("SELECT (? < ?) AS lt, (? < ?) AS iso_lt").get(d1Timestamp(morning), migratedEvening, morning.toISOString(), migratedEvening)).toEqual({
      lt: 1,
      iso_lt: 0,
    });
  });

  // JavaScript has millisecond resolution and Python has microsecond, so the
  // last three digits are always zeroes. Padding them rather than leaving three
  // digits is what keeps every value the SAME LENGTH, which is what makes
  // lexicographic order and chronological order agree exactly (0022's own
  // reasoning for its `|| '000'`).
  it("pads milliseconds to six digits so every value is the same length", () => {
    expect(d1Timestamp(new Date("2026-09-05T19:28:08.007Z"))).toBe("2026-09-05 19:28:08.007000");
    expect(d1Timestamp(new Date("2026-09-05T19:28:08.000Z"))).toBe("2026-09-05 19:28:08.000000");
    expect(d1Timestamp(new Date("2026-09-05T19:28:08.070Z"))).toBe("2026-09-05 19:28:08.070000");
    const lengths = new Set(
      [0, 7, 70, 700].map((ms) => d1Timestamp(new Date(Date.UTC(2026, 8, 5, 19, 28, 8, ms))).length),
    );
    expect(lengths).toEqual(new Set([26]));
  });

  // Single-digit month, day, hour, minute and second all zero-padded. An
  // unpadded "2026-9-5 9:2:3" is nine bytes shorter and sorts nowhere near the
  // rows beside it.
  it("zero-pads every field", () => {
    expect(d1Timestamp(new Date("2026-01-02T03:04:05.006Z"))).toBe("2026-01-02 03:04:05.006000");
  });

  // UTC, read through getUTC*, not the local calendar. vitest.config.mts pins
  // TZ=UTC so this cannot fail here today -- it is asserted anyway because the
  // Workers runtime is UTC and a getHours() slip would only show up on a
  // developer's machine, which is exactly where nobody runs the suite before
  // pushing.
  it("reads the date in UTC", () => {
    expect(d1Timestamp(new Date(Date.UTC(2026, 11, 31, 23, 59, 59, 999)))).toBe("2026-12-31 23:59:59.999000");
  });

  // THE SAME CLAIM, PROVED SOMEWHERE THAT IS NOT UTC -- because the test above
  // cannot fail. While vitest.config.mts pins TZ=UTC, getHours() and
  // getUTCHours() agree on every input, so swapping the whole function to the
  // local-calendar getters passes the entire suite. The Workers runtime is UTC
  // too, so the exposure is the tools/ scripts and any local run of this code
  // by hand -- and the day somebody edits that one config line, at which point
  // every timestamp this module writes silently shifts and starts sorting
  // wrongly against the migrated rows d1Timestamp exists to sit beside.
  //
  // Kiritimati is UTC+14, so 19:28 on the 5th is 09:28 on the SIXTH there: a
  // different hour and a different date, which catches getHours() and
  // getDate() as separate mutations. node re-reads process.env.TZ per Date
  // operation, so the restore is in a finally -- leaking it would silently
  // move every later test in this file.
  it("stays on UTC even when the process is not", () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Kiritimati";
      const instant = new Date("2026-09-05T19:28:08.853Z");
      // The local calendar really has moved, so the assertion below is not a
      // no-op dressed up as one.
      expect([instant.getHours(), instant.getDate()]).toEqual([9, 6]);

      expect(d1Timestamp(instant)).toBe("2026-09-05 19:28:08.853000");
    } finally {
      process.env.TZ = original;
    }
  });

  it("defaults to now", () => {
    freezeClock();
    expect(d1Timestamp()).toBe(NOW_D1);
  });
});

// ===========================================================================
// deliveryDatetime -- Django's naive `datetime(y, m, d, hour, 0)` as a string
// build, because USE_TZ=False / TIME_ZONE="UTC" means there is no conversion
// to make and a Date round trip could only introduce one.
// ===========================================================================
describe("deliveryDatetime", () => {
  it("builds the delivery datetime in the same shape as every other stored timestamp", () => {
    expect(deliveryDatetime("2026-09-05", 14)).toBe("2026-09-05 14:00:00.000000");
    expect(deliveryDatetime("2026-09-05", 14)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
  });

  // 6 is the first entry in DELIVERY_HOURS (const/general.py:1) and the one an
  // unpadded build gets wrong. "2026-09-05 6:00:00.000000" is a byte longer
  // than nothing and sorts after "2026-09-05 22:00..." -- on a column with its
  // own index (order_delivery_datetime_idx) that adminLists.ts sorts the
  // deliveries list by.
  it("zero-pads a single-digit hour", () => {
    expect(deliveryDatetime("2026-09-05", 6)).toBe("2026-09-05 06:00:00.000000");
    expect(deliveryDatetime("2026-09-05", 9)).toBe("2026-09-05 09:00:00.000000");
    expect(deliveryDatetime("2026-09-05", 22)).toBe("2026-09-05 22:00:00.000000");
  });

  // The padding, proved where it matters: through the engine, on the real
  // column, in the order the deliveries list is drawn in.
  it("orders the way the delivery hours actually run", () => {
    seedOrder({ id: ORDER_ROW, order_id: "gf-a-tesco-2026-09-05", delivery_hour: 6 });
    seedOrder({ id: OTHER_ORDER_ROW, order_id: "gf-b-tesco-2026-09-05", delivery_hour: 22 });
    seedOrder({ id: 1203, order_id: "gf-c-tesco-2026-09-05", delivery_hour: 14 });

    const hours = (db.prepare("SELECT delivery_hour FROM orders ORDER BY delivery_datetime").all() as { delivery_hour: number }[]).map((r) => r.delivery_hour);
    expect(hours).toEqual([6, 14, 22]);
  });

  // Django's datetime() zeroes the minute explicitly (orders.py:110-116); the
  // seconds and microseconds are simply absent from the constructor call and
  // default to zero. All four are constants here, so a delivery is always on
  // the hour.
  it("always lands on the hour", () => {
    expect(deliveryDatetime("2026-02-28", 0)).toBe("2026-02-28 00:00:00.000000");
    // Everything after the hour is constant, whatever the hour.
    expect(deliveryDatetime("2026-09-05", 21).slice(14)).toBe("00:00.000000");
  });
});

// ===========================================================================
// slugifyProvider -- Django's django.utils.text.slugify, applied to
// delivery_provider to build the order_id. Every expectation below was RUN
// through the project's own Django (foodcharity/.venv, django.utils.text
// .slugify), not reasoned about -- TESTING.md's rule.
// ===========================================================================
describe("slugifyProvider", () => {
  // The four values orderForm.ts will ever hand it
  // (const/general.py:15-20 DELIVERY_PROVIDER_CHOICES). "Sainsbury's" is the
  // only one with anything to strip, and it is the reason this is a slugify
  // rather than a toLowerCase.
  it("matches Django for every delivery provider the form offers", () => {
    expect(slugifyProvider("Tesco")).toBe("tesco");
    expect(slugifyProvider("Sainsbury's")).toBe("sainsburys");
    expect(slugifyProvider("Costco")).toBe("costco");
    expect(slugifyProvider("Pedal Me")).toBe("pedal-me");
  });

  // THE CASE THE `?? "None"` EXISTS FOR. Django's slugify() str()s its
  // argument first, so slugify(None) is slugify("None") is "none" -- a literal
  // four-letter segment in the order_id, not an empty one. Confirmed against
  // CPython: slugify(None) -> 'none'.
  //
  // Delete the fallback and a null provider yields "", so the id collapses
  // from "gf-salisbury-none-2026-09-05" to "gf-salisbury--2026-09-05". That id
  // is the order's admin URL and appears in the notification email's subject,
  // so the two forms are not interchangeable.
  it("turns a null provider into the literal 'none', as Django's str(None) does", () => {
    expect(slugifyProvider(null)).toBe("none");
    // And the string "None" is indistinguishable from the null, which is the
    // point -- Django cannot tell them apart either.
    expect(slugifyProvider("None")).toBe("none");
  });

  // Django strips accents to ASCII before slugifying (NFKD + encode("ascii",
  // "ignore")). Confirmed: slugify('Café Provider') -> 'cafe-provider'.
  it("strips accents to ASCII the way Django does", () => {
    expect(slugifyProvider("Café Provider")).toBe("cafe-provider");
  });

  // The three tail behaviours of Django's implementation, each confirmed
  // against CPython: runs of dashes and whitespace collapse to one dash,
  // leading/trailing dashes and UNDERSCORES are stripped, and surrounding
  // whitespace goes with them.
  it("collapses runs and strips leading and trailing dashes and underscores", () => {
    expect(slugifyProvider("Ocado--Zoom")).toBe("ocado-zoom");
    expect(slugifyProvider("  Tesco  ")).toBe("tesco");
    expect(slugifyProvider("___x___")).toBe("x");
  });

  // Documented, not endorsed, and a faithful port: a value with no ASCII word
  // characters slugifies to the empty string, which produces the double-dash
  // order_id described above. Django does exactly this, so it is pinned rather
  // than guarded against.
  it("returns an empty string for a provider with no ASCII word characters", () => {
    expect(slugifyProvider("北京")).toBe("");
  });
});

// ===========================================================================
// getOpenFoodbankOptions -- forms.py:190,
// Foodbank.objects.filter(is_closed=False).order_by('name')
// ===========================================================================
describe("getOpenFoodbankOptions", () => {
  // THE FILTER, tested with a row that MUST be absent. A filter that does
  // nothing passes every test that only seeds matching rows. This one matters
  // because orderForm.ts:294 lets a closed food bank through when it is the
  // one the order already had -- so a closed food bank appearing in the list
  // is not caught downstream, it is simply selectable.
  it("excludes closed food banks", async () => {
    seedFoodbank({ id: SALISBURY, name: "Salisbury Foodbank", slug: "salisbury" });
    seedFoodbank({ id: CLOSED, name: "Andover Foodbank", slug: "andover", is_closed: 1 });

    const options = await getOpenFoodbankOptions(session);
    expect(options.map((o) => o.slug)).toEqual(["salisbury"]);
    expect(options.map((o) => o.name)).not.toContain("Andover Foodbank");
  });

  // THE COLLATION DIVERGENCE types.ts:28-37 exists for, executed. D1's default
  // TEXT collation is byte-wise -- every capital sorts before every lowercase
  // and every non-ASCII byte after both -- while the source Postgres sorts
  // under en_US.utf8. These four names are chosen so the two orders are
  // completely different:
  //
  //   byte-wise (a SQL `ORDER BY name`)  Ashford, Ynys Môn, Zebedee, bermondsey
  //   collator  (sortByName)             Ashford, bermondsey, Ynys Môn, Zebedee
  //
  // Replace sortByName with an `ORDER BY name` in the SQL -- the obvious
  // "simplification" -- and the admin's <select> puts a lowercase-initial food
  // bank after Z, where nobody scanning alphabetically will look for it.
  it("sorts by name with the locale-aware collator, not byte-wise", async () => {
    seedFoodbank({ id: SALISBURY, name: "Zebedee Trust Foodbank", slug: "zebedee" });
    seedFoodbank({ id: BRIXTON, name: "bermondsey Foodbank", slug: "bermondsey" });
    seedFoodbank({ id: 10, name: "Ashford Foodbank", slug: "ashford" });
    seedFoodbank({ id: 11, name: "Ynys Môn Foodbank", slug: "ynys-mon" });

    const names = (await getOpenFoodbankOptions(session)).map((o) => o.name);
    expect(names).toEqual(["Ashford Foodbank", "bermondsey Foodbank", "Ynys Môn Foodbank", "Zebedee Trust Foodbank"]);
    // The order the engine would have produced, so the assertion above is
    // demonstrably not just "whatever SQLite did".
    expect((db.prepare("SELECT name FROM foodbank ORDER BY name").all() as { name: string }[]).map((r) => r.name)).toEqual([
      "Ashford Foodbank",
      "Ynys Môn Foodbank",
      "Zebedee Trust Foodbank",
      "bermondsey Foodbank",
    ]);
  });

  // Exactly the five columns the form needs. `foodbank` has 70-odd columns
  // including charity_objectives and boundary data; `SELECT *` here would pull
  // all of them into the template context for every open food bank on every
  // render of the order form.
  it("selects only the five columns the form uses", async () => {
    seedFoodbank({ id: SALISBURY, name: "Salisbury Foodbank", slug: "salisbury", country: "England" });

    const options = await getOpenFoodbankOptions(session);
    expect(options).toEqual([{ id: SALISBURY, name: "Salisbury Foodbank", slug: "salisbury", country: "England", is_closed: 0 }]);
  });

  // `country` is on the row because orderForm.ts:306 denormalises it onto the
  // order (orders.py:125-128). Losing it from this SELECT would store "" as
  // every assigned order's country -- silently, because the column is NOT NULL
  // and "" satisfies it.
  it("carries the country the order will denormalise", async () => {
    seedFoodbank({ id: SALISBURY, name: "Salisbury Foodbank", slug: "salisbury", country: "England" });
    seedFoodbank({ id: BRIXTON, name: "Aberdeen Foodbank", slug: "aberdeen", country: "Scotland" });

    expect((await getOpenFoodbankOptions(session)).map((o) => o.country)).toEqual(["Scotland", "England"]);
  });

  it("returns an empty array when every food bank is closed", async () => {
    seedFoodbank({ id: CLOSED, name: "Andover Foodbank", slug: "andover", is_closed: 1 });
    expect(await getOpenFoodbankOptions(session)).toEqual([]);
  });
});

// ===========================================================================
// getFoodbankOptionById -- NOT a port, a fix. See the module comment: without
// it, editing an order whose food bank has since closed renders a <select>
// with no matching option, the browser submits the empty one, and the save
// silently UNASSIGNS the order and renames it.
// ===========================================================================
describe("getFoodbankOptionById", () => {
  // The whole reason the function is separate from getOpenFoodbankOptions.
  // Add `AND is_closed = 0` here -- which looks like a consistency fix -- and
  // the bug the function was written to close comes straight back.
  it("returns a CLOSED food bank, which is the entire point of it", async () => {
    seedFoodbank({ id: CLOSED, name: "Andover Foodbank", slug: "andover", is_closed: 1 });

    expect(await getFoodbankOptionById(session, CLOSED)).toEqual({ id: CLOSED, name: "Andover Foodbank", slug: "andover", country: "England", is_closed: 1 });
  });

  // is_closed has to arrive as the number, not a boolean and not coerced away:
  // orderForm.ts:294 branches on it to reject a NEWLY chosen closed food bank
  // while allowing the order's existing one.
  it("returns is_closed as the raw 0/1 the branch reads", async () => {
    seedFoodbank({ id: SALISBURY, name: "Salisbury Foodbank", slug: "salisbury" });
    expect((await getFoodbankOptionById(session, SALISBURY))!.is_closed).toBe(0);
  });

  it("selects by id, and returns null for an id nothing holds", async () => {
    seedFoodbank({ id: SALISBURY, name: "Salisbury Foodbank", slug: "salisbury" });
    seedFoodbank({ id: BRIXTON, name: "Brixton Foodbank", slug: "brixton" });

    expect((await getFoodbankOptionById(session, BRIXTON))!.slug).toBe("brixton");
    // A client-supplied FK that no longer exists -- orderForm.ts:289 turns
    // this null into "Unknown food bank." rather than a 500.
    expect(await getFoodbankOptionById(session, 999)).toBeNull();
  });
});

// ===========================================================================
// getNeedOptionsForFoodbank -- forms.py:191/207-210, FoodbankChange ordered by
// -created, filtered to the selected food bank. Reads the VIEW
// foodbankchange_full (0019), so `foodbank_name` is a join, not a column.
// ===========================================================================
describe("getNeedOptionsForFoodbank", () => {
  function seedThreeSalisburyNeeds(): void {
    seedFoodbank({ id: SALISBURY, name: "Salisbury Foodbank", slug: "salisbury" });
    // Inserted oldest-first with ASCENDING ids, so rowid order is the exact
    // reverse of the answer -- the one arrangement a missing ORDER BY cannot
    // fake.
    seedNeed({ id: NEED_ROW, need_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", foodbank_id: SALISBURY, created: "2026-09-01 08:00:00.000000" });
    seedNeed({ id: NEED_ROW + 1, need_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", foodbank_id: SALISBURY, created: "2026-09-02 08:00:00.000000" });
    seedNeed({ id: NEED_ROW + 2, need_id: "cccccccccccccccccccccccccccccccc", foodbank_id: SALISBURY, created: "2026-09-03 08:00:00.000000" });
  }

  it("returns a food bank's needs newest first", async () => {
    seedThreeSalisburyNeeds();

    const needs = await getNeedOptionsForFoodbank(session, SALISBURY);
    expect(needs.map((n) => n.id)).toEqual([NEED_ROW + 2, NEED_ROW + 1, NEED_ROW]);
    expect(needs.map((n) => n.created)).toEqual(["2026-09-03 08:00:00.000000", "2026-09-02 08:00:00.000000", "2026-09-01 08:00:00.000000"]);
  });

  // THE COPY-PASTE MUTANT: `ORDER BY id DESC`, which is what
  // getLatestOrderLineCategory further down this same file genuinely says --
  // one word away from this query and a plausible slip between two adjacent
  // "give me the newest one" statements.
  //
  // It survives every OTHER test in this block, including the one directly
  // above. seedThreeSalisburyNeeds and every ad-hoc fixture here insert needs
  // whose ids ascend in step with their `created`, so the two columns give the
  // same answer and the wrong one is invisible. The columns genuinely diverge
  // in production: foodbankchange rows are imported and backfilled (0022
  // rewrote 25 of them), so a row written today can carry last week's
  // `created`. Django's queryset is order_by('-created') (forms.py:207-210)
  // and the <option> label the admin picks from is that date, so ordering by
  // id renders a list whose visible dates are out of sequence.
  //
  // Ids inverted against created here, and asserted on BOTH branches, because
  // they are two separately written statements.
  it("orders by created and not by id, which every other fixture here agrees with", async () => {
    seedFoodbank({ id: SALISBURY, name: "Salisbury Foodbank", slug: "salisbury" });
    seedNeed({ id: NEED_ROW, need_id: "a".repeat(32), foodbank_id: SALISBURY, created: "2026-09-03 08:00:00.000000" });
    seedNeed({ id: NEED_ROW + 1, need_id: "b".repeat(32), foodbank_id: SALISBURY, created: "2026-09-01 08:00:00.000000" });
    seedNeed({ id: NEED_ROW + 2, need_id: "c".repeat(32), foodbank_id: SALISBURY, created: "2026-09-02 08:00:00.000000" });

    const byCreated = [NEED_ROW, NEED_ROW + 2, NEED_ROW + 1];
    expect((await getNeedOptionsForFoodbank(session, SALISBURY)).map((n) => n.id)).toEqual(byCreated);
    expect((await getNeedOptionsForFoodbank(session, null)).map((n) => n.id)).toEqual(byCreated);
    // And the cap keeps the two newest by CREATED, not the two highest ids --
    // which is the difference an admin actually meets, because the list is
    // truncated far more often than it is short.
    expect((await getNeedOptionsForFoodbank(session, SALISBURY, 2)).map((n) => n.id)).toEqual([NEED_ROW, NEED_ROW + 2]);
  });

  // THE ONE MUTATION THE ROWS CANNOT SEE: deleting the ORDER BY from the
  // filtered branch outright. 0001_core.sql's change_foodbank_created_idx is
  // `(foodbank_id, created DESC)`, so SQLite answers `WHERE foodbank_id = ?`
  // by walking that index and hands back exactly the order the ORDER BY would
  // have asked for -- every row assertion above passes against a statement
  // that requests no order at all. That is a property of today's query plan,
  // not a guarantee: the planner is free to choose differently at another row
  // count, after an ANALYZE, or once another index exists, and D1 is the same
  // engine making the same choices. The guarantee lives in the statement, so
  // that is where it is pinned -- the same technique as findConflictingOrder's
  // `id != ?` assertion below.
  it("asks the engine for the order rather than relying on the index to supply it", async () => {
    seedThreeSalisburyNeeds();
    sent.length = 0;

    await getNeedOptionsForFoodbank(session, SALISBURY);
    await getNeedOptionsForFoodbank(session, null);

    expect(sent).toHaveLength(2);
    expect(sent.map((s) => s.sql.includes("ORDER BY created DESC"))).toEqual([true, true]);
  });

  // THE FILTER, with rows that must be excluded. An order form that offered
  // another food bank's needs would let an admin attach a Salisbury delivery
  // to a Brixton need -- and nothing downstream checks the pair, because
  // orderForm.ts:296 only asks whether the need EXISTS.
  it("excludes other food banks' needs, and unassigned ones", async () => {
    seedThreeSalisburyNeeds();
    seedFoodbank({ id: BRIXTON, name: "Brixton Foodbank", slug: "brixton" });
    seedNeed({ id: 90, need_id: "dddddddddddddddddddddddddddddddd", foodbank_id: BRIXTON, created: "2026-09-09 08:00:00.000000" });
    // An unassigned need. `WHERE foodbank_id = ?` never matches NULL under
    // SQLite's three-valued logic, so this is excluded by the comparison
    // itself -- pinned because the same shape written as `IS NOT DISTINCT
    // FROM` or with a COALESCE would quietly include it.
    seedNeed({ id: 91, need_id: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", foodbank_id: null, created: "2026-09-10 08:00:00.000000" });

    const needs = await getNeedOptionsForFoodbank(session, SALISBURY);
    // Both intruders are NEWER than everything in the answer, so a dropped or
    // widened filter puts them at the TOP of the list rather than somewhere a
    // truncated assertion would miss.
    expect(needs.map((n) => n.id)).toEqual([NEED_ROW + 2, NEED_ROW + 1, NEED_ROW]);
  });

  // The no-food-bank-selected branch: a genuinely different statement, with
  // no WHERE at all. Django renders every FoodbankChange row here (33,931 in
  // production); this port caps it, which is why the two branches exist.
  it("returns every food bank's needs, unassigned included, when no food bank is selected", async () => {
    seedThreeSalisburyNeeds();
    seedFoodbank({ id: BRIXTON, name: "Brixton Foodbank", slug: "brixton" });
    seedNeed({ id: 90, need_id: "dddddddddddddddddddddddddddddddd", foodbank_id: BRIXTON, created: "2026-09-09 08:00:00.000000" });
    seedNeed({ id: 91, need_id: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", foodbank_id: null, created: "2026-09-10 08:00:00.000000" });

    const needs = await getNeedOptionsForFoodbank(session, null);
    expect(needs.map((n) => n.id)).toEqual([91, 90, NEED_ROW + 2, NEED_ROW + 1, NEED_ROW]);
  });

  // POST-0019: `foodbank_name` comes from the view's LEFT JOIN onto foodbank,
  // not from the column of the same name that 0019 DROPPED from
  // foodbankchange. This is the exact failure that made
  // /dashboard/beautybanks/ a live 500. The route renders it as the option
  // label (orderForm.ts:79), so a query still naming the dropped column would
  // be a 500 on the order form itself.
  it("joins foodbank_name from the parent rather than reading a dropped column", async () => {
    seedThreeSalisburyNeeds();

    expect((await getNeedOptionsForFoodbank(session, SALISBURY))[0]!.foodbank_name).toBe("Salisbury Foodbank");
    // The dropped column really is gone, so the join is the only source it
    // could have come from.
    expect(() => db.prepare("SELECT foodbank_name FROM foodbankchange").all()).toThrow();
  });

  // LEFT JOIN, not JOIN, which is what 0019's own comment says the view is
  // for. An unassigned need has no parent to resolve, and an inner join would
  // erase it from the unfiltered list entirely -- a need the admin can see on
  // /admin/needs/ but cannot attach an order to, with nothing to explain why.
  // orderForm.ts:79 renders the null as "None".
  it("returns a null foodbank_name for an unassigned need rather than dropping the row", async () => {
    seedNeed({ id: 91, need_id: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", foodbank_id: null, created: "2026-09-10 08:00:00.000000" });
    // And for a DANGLING id, which this schema allows outright: PLAN.md 4.5
    // declares no foreign keys, and foodbankAdmin.ts's deleteFoodbankCascade
    // really does leave needs pointing at a food bank that no longer exists.
    seedNeed({ id: 92, need_id: "ffffffffffffffffffffffffffffffff", foodbank_id: 999, created: "2026-09-11 08:00:00.000000" });

    const needs = await getNeedOptionsForFoodbank(session, null);
    expect(needs.map((n) => n.id)).toEqual([92, 91]);
    expect(needs.map((n) => n.foodbank_name)).toEqual([null, null]);
  });

  // The cap, and the reason orderForm.ts:210 can say "the list was capped":
  // it compares `needs.length >= NEED_OPTION_LIMIT`, so an off-by-one or an
  // unbound LIMIT changes what the help text claims as well as what is shown.
  it("caps the list at `limit`, keeping the newest", async () => {
    seedThreeSalisburyNeeds();

    expect((await getNeedOptionsForFoodbank(session, SALISBURY, 2)).map((n) => n.id)).toEqual([NEED_ROW + 2, NEED_ROW + 1]);
    expect((await getNeedOptionsForFoodbank(session, SALISBURY, 1)).map((n) => n.id)).toEqual([NEED_ROW + 2]);
    // The unfiltered branch is a separate statement with its own LIMIT bind.
    expect(await getNeedOptionsForFoodbank(session, null, 2)).toHaveLength(2);
  });

  // THE BIND-ORDER MUTANT. The filtered branch binds (foodbankId, limit);
  // transpose them and the query becomes `WHERE foodbank_id = 3 LIMIT 7`,
  // which returns rows, in a plausible order, belonging to a food bank the
  // admin did not choose. Seeded so that food bank 3 exists and has needs of
  // its own, because a transposition against an empty id would fail this test
  // for the wrong reason (an empty list, not the wrong list).
  it("binds the food bank and the limit in that order", async () => {
    seedThreeSalisburyNeeds();
    seedFoodbank({ id: 3, name: "Aberdeen Foodbank", slug: "aberdeen" });
    for (let i = 0; i < 5; i += 1) {
      seedNeed({ id: 300 + i, need_id: `3${String(i).repeat(31)}`, foodbank_id: 3, created: `2026-09-0${i + 1} 12:00:00.000000` });
    }

    const needs = await getNeedOptionsForFoodbank(session, SALISBURY, 3);
    expect(needs.map((n) => n.id)).toEqual([NEED_ROW + 2, NEED_ROW + 1, NEED_ROW]);
    expect(needs.every((n) => n.foodbank_name === "Salisbury Foodbank")).toBe(true);
  });

  // The default the route does NOT pass on every call path. 201 rows is one
  // more than the documented cap, so an unbound query or a different default
  // fails here rather than agreeing by having too few rows to notice.
  it("defaults to 200", async () => {
    seedFoodbank({ id: SALISBURY, name: "Salisbury Foodbank", slug: "salisbury" });
    for (let i = 0; i < 201; i += 1) {
      seedNeed({ id: 1000 + i, need_id: `n${String(i).padStart(31, "0")}`, foodbank_id: SALISBURY, created: `2026-09-05 ${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000000` });
    }

    expect(await getNeedOptionsForFoodbank(session, SALISBURY)).toHaveLength(200);
    expect(await getNeedOptionsForFoodbank(session, null)).toHaveLength(200);
  });

  // THE 0022 SCAR, pinned rather than fixed. `created` is TEXT compared
  // byte-wise, so a row written by the port's old `toISOString()` sorts above
  // EVERY same-day Django row no matter the real time -- 'T' is 0x54 and ' '
  // is 0x20. Migration 0022 rewrote the rows that existed; nothing prevents a
  // future writer from reintroducing the shape, and this is what it would do
  // to the order form's need list.
  //
  // Asserted as current behaviour, not as a wish: the fix belongs at the write
  // site (packages/models's pyNow()), which is where 0022 put it.
  it("sorts an ISO-shaped created above every same-day Django one", async () => {
    seedFoodbank({ id: SALISBURY, name: "Salisbury Foodbank", slug: "salisbury" });
    seedNeed({ id: NEED_ROW, need_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", foodbank_id: SALISBURY, created: "2026-09-05 20:00:00.000000" });
    seedNeed({ id: OTHER_NEED_ROW, need_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", foodbank_id: SALISBURY, created: "2026-09-05T08:00:00.000Z" });

    // The 08:00 row comes FIRST, twelve hours before the 20:00 row it beats.
    expect((await getNeedOptionsForFoodbank(session, SALISBURY)).map((n) => n.id)).toEqual([OTHER_NEED_ROW, NEED_ROW]);
  });

  // Exactly the four columns the <option> needs. foodbankchange_full is
  // `SELECT c.*` plus two joined columns -- eighteen in all, including
  // change_text and change_text_original, the entire text of every need. A
  // `SELECT *` here would put 200 copies of that into the form's context.
  it("selects only the four columns the option label uses", async () => {
    seedThreeSalisburyNeeds();

    const [need] = await getNeedOptionsForFoodbank(session, SALISBURY);
    expect(Object.keys(need!).sort()).toEqual(["created", "foodbank_name", "id", "need_id"]);
  });

  it("returns an empty array for a food bank with no needs", async () => {
    seedThreeSalisburyNeeds();
    seedFoodbank({ id: BRIXTON, name: "Brixton Foodbank", slug: "brixton" });
    expect(await getNeedOptionsForFoodbank(session, BRIXTON)).toEqual([]);
  });
});

// ===========================================================================
// getOrderGroupOptions -- OrderGroup's auto-generated ModelChoiceField, whose
// queryset is unfiltered (orders.py:314-333).
// ===========================================================================
describe("getOrderGroupOptions", () => {
  // UNFILTERED is the behaviour, and the easy mutation is to "tidy" it with
  // `WHERE public = 1`. `public` gates the donor-facing
  // /donate/managed/<slug>-<key>/ pages, not the admin's own dropdown -- a
  // private group is exactly the kind an admin assigns an order to.
  it("includes private groups as well as public ones", async () => {
    seedOrderGroup({ id: CHRISTMAS, name: "Christmas 2026", slug: "christmas-2026", public: 1 });
    seedOrderGroup({ id: HARVEST, name: "Harvest 2026", slug: "harvest-2026", public: 0 });

    expect((await getOrderGroupOptions(session)).map((g) => g.slug)).toEqual(["christmas-2026", "harvest-2026"]);
  });

  // Same collation reason as the food bank list: sorted in JS, not in SQL.
  // Byte-wise these come back Advent, Zero Waste, harvest; the collator puts
  // harvest in the middle where an admin will look for it.
  it("sorts by name with the collator, not byte-wise", async () => {
    seedOrderGroup({ id: CHRISTMAS, name: "Zero Waste 2026", slug: "zero-waste" });
    seedOrderGroup({ id: HARVEST, name: "harvest 2026", slug: "harvest" });
    seedOrderGroup({ id: 5, name: "Advent 2026", slug: "advent" });

    expect((await getOrderGroupOptions(session)).map((g) => g.name)).toEqual(["Advent 2026", "harvest 2026", "Zero Waste 2026"]);
  });

  // Three columns, not five. `key` is an 8-char capability token that appears
  // in donor-facing URLs (0015's own comment: "never regenerate an existing
  // one"), so it has no business in a template context rendered to an admin
  // page that gets screenshotted into tickets.
  it("selects only id, name and slug -- never the capability key", async () => {
    seedOrderGroup({ id: CHRISTMAS, name: "Christmas 2026", slug: "christmas-2026" });

    const [group] = await getOrderGroupOptions(session);
    expect(group).toEqual({ id: CHRISTMAS, name: "Christmas 2026", slug: "christmas-2026" });
    expect(Object.keys(group!)).not.toContain("key");
  });

  it("returns an empty array when there are no groups", async () => {
    expect(await getOrderGroupOptions(session)).toEqual([]);
  });
});

// ===========================================================================
// findConflictingOrder -- Order.Meta.unique_together
// ('foodbank','delivery_date','delivery_provider'), which Django's ModelForm
// enforced for free and this port has to ask for.
// ===========================================================================
describe("findConflictingOrder", () => {
  const CONFLICT = { foodbankId: SALISBURY, deliveryDate: "2026-09-05", deliveryProvider: "Tesco" as string | null };

  beforeEach(() => {
    seedFoodbank({ id: SALISBURY, name: "Salisbury Foodbank", slug: "salisbury" });
    seedFoodbank({ id: BRIXTON, name: "Brixton Foodbank", slug: "brixton" });
  });

  it("finds the order that already holds this food bank, date and provider", async () => {
    seedOrder({ id: ORDER_ROW, order_id: "gf-salisbury-tesco-2026-09-05", foodbank_id: SALISBURY, delivery_date: "2026-09-05", delivery_provider: "Tesco" });

    expect(await findConflictingOrder(session, CONFLICT)).toEqual({ id: ORDER_ROW, order_id: "gf-salisbury-tesco-2026-09-05" });
  });

  // All three columns, one at a time. A check missing any one of them refuses
  // saves that are perfectly legal -- and Django allows all three of these:
  // two food banks can both take a Tesco delivery on the same day, one food
  // bank can take deliveries on consecutive days, and one food bank can take
  // a Tesco AND a Costco delivery on the same day.
  it("matches on all three columns and no fewer", async () => {
    seedOrder({ id: ORDER_ROW, order_id: "gf-salisbury-tesco-2026-09-05", foodbank_id: SALISBURY, delivery_date: "2026-09-05", delivery_provider: "Tesco" });

    expect(await findConflictingOrder(session, { ...CONFLICT, foodbankId: BRIXTON })).toBeNull();
    expect(await findConflictingOrder(session, { ...CONFLICT, deliveryDate: "2026-09-06" })).toBeNull();
    expect(await findConflictingOrder(session, { ...CONFLICT, deliveryProvider: "Costco" })).toBeNull();
  });

  // THE EDIT PATH. Every save re-posts the order's own unchanged food bank,
  // date and provider, so without the self-exclusion an admin could never
  // change an order's items text again -- the form would refuse it as a
  // duplicate of itself, forever.
  it("excludes the row being edited", async () => {
    seedOrder({ id: ORDER_ROW, order_id: "gf-salisbury-tesco-2026-09-05", foodbank_id: SALISBURY, delivery_date: "2026-09-05", delivery_provider: "Tesco" });

    expect(await findConflictingOrder(session, { ...CONFLICT, excludeId: ORDER_ROW })).toBeNull();
  });

  // The exclusion is by id, so ANOTHER row still counts -- an excludeId that
  // suppressed the whole check would leave the edit path silently unguarded
  // and let an admin move an order onto a date the food bank already has.
  it("still reports a DIFFERENT row on an edit", async () => {
    seedOrder({ id: ORDER_ROW, order_id: "gf-salisbury-tesco-2026-09-05", foodbank_id: SALISBURY, delivery_date: "2026-09-05", delivery_provider: "Tesco" });
    seedOrder({ id: OTHER_ORDER_ROW, order_id: "gf-salisbury-costco-2026-09-05", foodbank_id: SALISBURY, delivery_date: "2026-09-05", delivery_provider: "Costco" });

    expect(await findConflictingOrder(session, { ...CONFLICT, excludeId: OTHER_ORDER_ROW })).toEqual({ id: ORDER_ROW, order_id: "gf-salisbury-tesco-2026-09-05" });
  });

  // WHY `id != ?` IS SAFE HERE, where locationsAdmin.ts needed `id IS NOT ?`.
  // SQLite's `id != NULL` is UNKNOWN rather than true, so it filters out every
  // row and turns a check into a no-op -- github #12's whole failure mode.
  // This function dodges it by OMITTING the clause instead of binding NULL,
  // and orderForm.ts:300 passes `order?.id`, which is `undefined` (not null)
  // on a create. Pinned so that "make this consistent with the other checks"
  // cannot quietly become `id != NULL` on the create path.
  it("omits the exclusion entirely on a create, rather than binding NULL to `id != ?`", async () => {
    seedOrder({ id: ORDER_ROW, order_id: "gf-salisbury-tesco-2026-09-05", foodbank_id: SALISBURY, delivery_date: "2026-09-05", delivery_provider: "Tesco" });

    sent.length = 0;
    expect(await findConflictingOrder(session, { ...CONFLICT, excludeId: undefined })).not.toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.sql).not.toContain("id != ?");
    expect(sent[0]!.params).toEqual([SALISBURY, "2026-09-05", "Tesco"]);

    // And the semantics that make the omission necessary, executed rather
    // than asserted: `id != NULL` matches nothing at all.
    expect(db.prepare("SELECT id FROM orders WHERE delivery_provider = 'Tesco' AND id != NULL").all()).toEqual([]);
    expect(db.prepare("SELECT id FROM orders WHERE delivery_provider = 'Tesco' AND id IS NOT NULL").all()).toEqual([{ id: ORDER_ROW }]);
  });

  // No query at all for an unassigned order. Matches Django, which skips the
  // whole unique check when any field in the unique_together is None
  // (django/db/models/base.py:1556-1568, "no value, skip the lookup" -- read,
  // not guessed), and matches orders.py:54-56's stated intent that "multiple
  // unassigned orders with the same delivery_date and delivery_provider are
  // permitted". Asserted on the statement log because "returns null" alone
  // would also pass for a query that ran and found nothing.
  it("issues no statement at all for an unassigned order", async () => {
    seedOrder({ id: ORDER_ROW, order_id: "gf-unassigned-1201-tesco-2026-09-05", foodbank_id: null, delivery_date: "2026-09-05", delivery_provider: "Tesco" });

    sent.length = 0;
    expect(await findConflictingOrder(session, { foodbankId: null, deliveryDate: "2026-09-05", deliveryProvider: "Tesco" })).toBeNull();
    expect(sent).toEqual([]);
  });

  // SUSPECT, pinned rather than fixed (TESTING.md's rule). This port is
  // STRICTER than Django for an assigned order with NO provider.
  //
  // Django skips the entire unique_together check when any of its fields is
  // None -- base.py:1556-1568 again -- so an admin may legally create two
  // Salisbury orders for 2026-09-05 with the provider left blank. The port
  // builds `delivery_provider IS NULL`, which MATCHES the existing row, and
  // orderForm.ts:301 refuses the save with "Order with this Foodbank,
  // Delivery date and Delivery provider already exists."
  //
  // The module's own comment says "SQL treats NULLs as distinct, so this can
  // only ever fire for an ASSIGNED order" -- true of the food bank (the early
  // return), but NOT of the provider, because `IS NULL` is deliberately not a
  // NULL-distinct comparison. Reachable: `delivery_provider` is null=True
  // (orders.py:43) and order_form.njk renders a blank first option for it.
  it("SUSPECT: reports a conflict on a NULL provider, where Django skips the check entirely", async () => {
    seedOrder({ id: ORDER_ROW, order_id: "gf-salisbury-none-2026-09-05", foodbank_id: SALISBURY, delivery_date: "2026-09-05", delivery_provider: null });

    expect(await findConflictingOrder(session, { ...CONFLICT, deliveryProvider: null })).toEqual({ id: ORDER_ROW, order_id: "gf-salisbury-none-2026-09-05" });
  });

  // The other half of the NULL handling, and this one is right: `= ?` never
  // matches NULL, so an order with no provider is not a conflict for a Tesco
  // one and vice versa. Both directions, because a query that got this wrong
  // in one direction only would still pass a single-direction test.
  it("keeps a NULL provider and a named one apart", async () => {
    seedOrder({ id: ORDER_ROW, order_id: "gf-salisbury-none-2026-09-05", foodbank_id: SALISBURY, delivery_date: "2026-09-05", delivery_provider: null });
    seedOrder({ id: OTHER_ORDER_ROW, order_id: "gf-brixton-tesco-2026-09-05", foodbank_id: BRIXTON, delivery_date: "2026-09-05", delivery_provider: "Tesco" });

    // Named provider, NULL row: `delivery_provider = 'Tesco'` is UNKNOWN
    // against NULL, so no match.
    expect(await findConflictingOrder(session, CONFLICT)).toBeNull();
    // NULL provider, named row: `IS NULL` is false against 'Tesco'.
    expect(await findConflictingOrder(session, { foodbankId: BRIXTON, deliveryDate: "2026-09-05", deliveryProvider: null })).toBeNull();
  });

  // Two columns, not the whole row. The caller only needs to know THAT there
  // is a clash; `SELECT *` would pull the conflicting order's entire items
  // text into a code path that discards it.
  it("returns only the id and the human order_id", async () => {
    seedOrder({ id: ORDER_ROW, order_id: "gf-salisbury-tesco-2026-09-05", foodbank_id: SALISBURY, delivery_date: "2026-09-05", delivery_provider: "Tesco" });

    expect(Object.keys((await findConflictingOrder(session, CONFLICT))!).sort()).toEqual(["id", "order_id"]);
  });

  // THE LIMIT THE ROWS CANNOT SEE. Delete it and every test in this describe
  // block still passes: .first() takes the head of whatever came back, so one
  // row or four hundred is the same answer. It is not the same COST. `orders`
  // has no index on (foodbank_id, delivery_date, delivery_provider) -- 0005
  // declares order_foodbank_delivery_idx and order_delivery_datetime_idx, and
  // neither answers this predicate -- so the statement is a scan, D1 bills on
  // rows read, and without the cap the whole matching set is serialised back
  // to the isolate for first() to throw away. This runs on the critical path
  // of every order save, twice on an edit.
  it("caps the pre-flight at a single row", async () => {
    seedOrder({ id: ORDER_ROW, order_id: "gf-salisbury-tesco-2026-09-05", foodbank_id: SALISBURY, delivery_date: "2026-09-05", delivery_provider: "Tesco" });
    sent.length = 0;

    await findConflictingOrder(session, CONFLICT);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.sql.endsWith("LIMIT 1")).toBe(true);
  });

  // `orders` has no unique index on the triple (0005 declares three indexes,
  // none of them unique), so production really can hold a duplicate pair that
  // predates this check. LIMIT 1 means the caller gets one of them and the
  // save is refused either way -- the assertion is deliberately weak on WHICH,
  // because the query has no ORDER BY and that is the engine's choice.
  it("returns one row when two orders already conflict with each other", async () => {
    seedOrder({ id: ORDER_ROW, order_id: "gf-salisbury-tesco-2026-09-05", foodbank_id: SALISBURY, delivery_date: "2026-09-05", delivery_provider: "Tesco" });
    seedOrder({ id: OTHER_ORDER_ROW, order_id: "gf-salisbury-tesco-2026-09-05", foodbank_id: SALISBURY, delivery_date: "2026-09-05", delivery_provider: "Tesco" });

    expect([ORDER_ROW, OTHER_ORDER_ROW]).toContain((await findConflictingOrder(session, CONFLICT))!.id);
  });
});

// ===========================================================================
// getOrderForEdit -- the form's own read: the editable columns of OrderForm
// plus the row id, looked up by the HUMAN order_id (views.py:464).
// ===========================================================================
describe("getOrderForEdit", () => {
  // Every column, asserted value by value, so the test fails on a column that
  // APPEARS as well as one that vanishes. This is the read that seeds every
  // field of the edit form -- a column silently missing here is a field that
  // renders blank and is then saved blank, destroying the value.
  it("returns every column of OrderEditRow, and only those", async () => {
    seedFoodbank({ id: SALISBURY, name: "Salisbury Foodbank", slug: "salisbury" });
    seedNeed({ id: NEED_ROW, need_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", foodbank_id: SALISBURY, created: EARLIER });
    seedOrderGroup({ id: CHRISTMAS, name: "Christmas 2026", slug: "christmas-2026" });
    seedOrder({
      id: ORDER_ROW,
      order_id: "gf-salisbury-tesco-2026-09-05",
      foodbank_id: SALISBURY,
      need_id: NEED_ROW,
      order_group_id: CHRISTMAS,
      items_text: "4 x Tinned Tomatoes\r\n2 x Long Grain Rice",
      source_url: "https://twitter.com/salisburyfb/status/1",
      delivery_provider: "Tesco",
      delivery_provider_id: "123456789",
      actual_cost: 11987,
    });

    expect(await getOrderForEdit(session, "gf-salisbury-tesco-2026-09-05")).toEqual({
      id: ORDER_ROW,
      order_id: "gf-salisbury-tesco-2026-09-05",
      foodbank_id: SALISBURY,
      items_text: "4 x Tinned Tomatoes\r\n2 x Long Grain Rice",
      need_id: NEED_ROW,
      order_group_id: CHRISTMAS,
      source_url: "https://twitter.com/salisburyfb/status/1",
      delivery_date: "2026-09-05",
      delivery_hour: 14,
      delivery_provider: "Tesco",
      delivery_provider_id: "123456789",
      actual_cost: 11987,
    });
  });

  // The two columns that are the whole reason this read exists rather than
  // reusing orderAdmin.ts's getOrderDetail: items_text (the entire content of
  // the form's main field) and order_group_id. getOrderDetail carries
  // neither, and a form rendered from it would post an empty items_text back.
  it("carries items_text and order_group_id, which getOrderDetail does not", async () => {
    seedOrderGroup({ id: HARVEST, name: "Harvest 2026", slug: "harvest-2026" });
    seedOrder({ id: ORDER_ROW, order_id: "gf-unassigned-1201-none-2026-09-05", items_text: "1 x Nappies", order_group_id: HARVEST });

    const order = (await getOrderForEdit(session, "gf-unassigned-1201-none-2026-09-05"))!;
    expect(order.items_text).toBe("1 x Nappies");
    expect(order.order_group_id).toBe(HARVEST);
  });

  // By the human id, not the pk -- Django's own order_form does
  // get_object_or_404(Order, order_id=id) (views.py:464). `orders.order_id` is
  // TEXT, so the integer pk as a string cannot match it unless the query is
  // reading the wrong column.
  it("selects by order_id and not by row id", async () => {
    seedOrder({ id: ORDER_ROW, order_id: "gf-salisbury-tesco-2026-09-05" });
    seedOrder({ id: OTHER_ORDER_ROW, order_id: "gf-brixton-costco-2026-09-06" });

    expect((await getOrderForEdit(session, "gf-brixton-costco-2026-09-06"))!.id).toBe(OTHER_ORDER_ROW);
    expect(await getOrderForEdit(session, String(ORDER_ROW))).toBeNull();
  });

  // orderForm.ts:113 turns the null into c.notFound(). An exact match, no
  // prefix and no case folding: admins reach these pages from pasted links,
  // and a loose match would open the wrong order's form -- whose save
  // overwrites it.
  it("returns null for an unknown order_id, and does not match loosely", async () => {
    seedOrder({ id: ORDER_ROW, order_id: "gf-salisbury-tesco-2026-09-05" });

    expect(await getOrderForEdit(session, "gf-salisbury-tesco-2026-09-04")).toBeNull();
    expect(await getOrderForEdit(session, "gf-salisbury-tesco")).toBeNull();
    expect(await getOrderForEdit(session, "GF-SALISBURY-TESCO-2026-09-05")).toBeNull();
    expect(await getOrderForEdit(session, "")).toBeNull();
  });

  // The nullable columns the form branches on. NULL has to stay NULL: "" in
  // source_url would render a blank-but-present URL that fails isValidUrl on
  // the next save, and 0 in actual_cost would show "£0.00" delivered on an
  // order nobody has been billed for.
  it("returns nulls, not zeroes or empty strings", async () => {
    seedOrder({ id: ORDER_ROW, order_id: "gf-unassigned-1201-none-2026-09-05" });

    const order = (await getOrderForEdit(session, "gf-unassigned-1201-none-2026-09-05"))!;
    expect(order.foodbank_id).toBeNull();
    expect(order.need_id).toBeNull();
    expect(order.order_group_id).toBeNull();
    expect(order.source_url).toBeNull();
    expect(order.delivery_provider).toBeNull();
    expect(order.delivery_provider_id).toBeNull();
    expect(order.actual_cost).toBeNull();
  });
});

// ===========================================================================
// upsertOrder -- everything models/orders.py:97-130 does before its first
// super().save(): the id, the denormalised country, the derived
// delivery_datetime, and the five zeroed aggregates.
// ===========================================================================
describe("upsertOrder", () => {
  const PARAMS = {
    orderId: "gf-salisbury-tesco-2026-09-05",
    foodbankId: SALISBURY,
    itemsText: "4 x Tinned Tomatoes\r\n2 x Long Grain Rice",
    needId: NEED_ROW,
    orderGroupId: CHRISTMAS,
    country: "England",
    sourceUrl: "https://twitter.com/salisburyfb/status/1",
    deliveryDate: "2026-09-05",
    deliveryHour: 14,
    deliveryDatetime: "2026-09-05 14:00:00.000000",
    deliveryProvider: "Tesco",
    deliveryProviderId: "123456789",
    actualCost: 11987,
  };

  // COLUMN-BY-COLUMN, on the row the statement actually wrote. The INSERT
  // names 21 columns against a VALUES tuple of 21 slots, six of which are
  // literals; add a column without adding its slot (or add the two in
  // different positions) and every column from there on shifts by one --
  // an items_text written into `country`, a source_url written into
  // `delivery_date`. SQLite would accept most of that without complaint,
  // because these columns are almost all TEXT. github #34 in
  // locationsAdmin.ts is this exact failure, one table over.
  it("writes every column of a new order, each into its own column", async () => {
    freezeClock();
    const created = await upsertOrder(session, PARAMS);

    expect(created.order_id).toBe("gf-salisbury-tesco-2026-09-05");
    expect(readRow("orders", created.id)).toEqual({
      id: created.id,
      order_id: "gf-salisbury-tesco-2026-09-05",
      items_text: "4 x Tinned Tomatoes\r\n2 x Long Grain Rice",
      country: "England",
      created: NOW_D1,
      modified: NOW_D1,
      notification_email_sent: null,
      source_url: "https://twitter.com/salisburyfb/status/1",
      delivery_date: "2026-09-05",
      delivery_hour: 14,
      delivery_datetime: "2026-09-05 14:00:00.000000",
      delivery_provider: "Tesco",
      delivery_provider_id: "123456789",
      weight: 0,
      calories: 0,
      cost: 0,
      actual_cost: 11987,
      no_lines: 0,
      no_items: 0,
      foodbank_id: SALISBURY,
      need_id: NEED_ROW,
      order_group_id: CHRISTMAS,
    });
  });

  // RETURNING, not a follow-up SELECT. The primary key is what
  // orderForm.ts:361 needs to build a new unassigned order's real order_id,
  // and what the queue message carries -- an insert that could not report its
  // own id would need a second round trip on the request's critical path.
  it("returns the id SQLite assigned, via RETURNING", async () => {
    seedOrder({ id: 5000, order_id: "gf-existing-tesco-2026-01-01" });

    const created = await upsertOrder(session, { ...PARAMS, deliveryDate: "2026-09-06" });
    expect(created.id).toBe(5001);
    expect(readRow("orders", 5001).order_id).toBe("gf-salisbury-tesco-2026-09-05");
  });

  // orders.py:118-122 re-zeroes the five aggregates on EVERY save, before the
  // AI reparse regenerates them; the queue job fills them back in through
  // setOrderAggregates. Between the redirect and the job finishing, an order
  // legitimately reads as 0 items / 0g / £0.00 -- the order page's job banner
  // says so. Pinned on the UPDATE path specifically, because that is where the
  // re-zeroing looks like a bug and is not.
  it("re-zeroes the five aggregates on an edit as well as an insert", async () => {
    freezeClock();
    seedOrder({ id: ORDER_ROW, order_id: "gf-salisbury-tesco-2026-09-05", weight: 21450, calories: 48200, cost: 12345, no_lines: 4, no_items: 8 });

    await upsertOrder(session, PARAMS, ORDER_ROW);

    const row = readRow("orders", ORDER_ROW);
    expect([row.weight, row.calories, row.cost, row.no_lines, row.no_items]).toEqual([0, 0, 0, 0, 0]);
    // actual_cost is NOT one of them -- it is the delivered cost an admin
    // typed, not a value the AI recomputes, so it is bound rather than zeroed.
    expect(row.actual_cost).toBe(11987);
  });

  // The columns the UPDATE deliberately does NOT name. `created` is the
  // order's own history -- adminLists.ts's getOrdersPage sorts on it and the
  // deliveries dashboard buckets by it, so restamping it on every edit would
  // silently move orders through time. `notification_email_sent` is worse: it
  // is what orderActions.ts uses to decide whether the food bank has already
  // been told, and clearing it would send a duplicate notification.
  it("preserves created and notification_email_sent across an edit", async () => {
    freezeClock();
    seedOrder({
      id: ORDER_ROW,
      order_id: "gf-salisbury-tesco-2026-09-05",
      created: "2026-08-01 09:00:00.000000",
      modified: "2026-08-02 09:00:00.000000",
      notification_email_sent: "2026-08-03 17:45:10.905000",
    });

    await upsertOrder(session, PARAMS, ORDER_ROW);

    const row = readRow("orders", ORDER_ROW);
    expect(row.created).toBe("2026-08-01 09:00:00.000000");
    expect(row.notification_email_sent).toBe("2026-08-03 17:45:10.905000");
    // `modified` IS restamped -- Django's auto_now does the same on every
    // save, and this genuinely is a later write to the row.
    expect(row.modified).toBe(NOW_D1);
  });

  // The other half of the same statement: everything it DOES name really does
  // change, including the three foreign keys back to null. An UPDATE that
  // silently kept the old foodbank_id would leave an order attached to a food
  // bank the admin has just detached it from.
  it("moves an order to a different food bank, need and group, and back to none", async () => {
    freezeClock();
    seedOrder({ id: ORDER_ROW, order_id: "gf-salisbury-tesco-2026-09-05", foodbank_id: SALISBURY, need_id: NEED_ROW, order_group_id: CHRISTMAS });

    await upsertOrder(
      session,
      { ...PARAMS, orderId: "gf-brixton-costco-2026-09-07", foodbankId: BRIXTON, needId: OTHER_NEED_ROW, orderGroupId: HARVEST, deliveryProvider: "Costco", deliveryDate: "2026-09-07" },
      ORDER_ROW,
    );
    expect(readRow("orders", ORDER_ROW)).toMatchObject({
      order_id: "gf-brixton-costco-2026-09-07",
      foodbank_id: BRIXTON,
      need_id: OTHER_NEED_ROW,
      order_group_id: HARVEST,
      delivery_provider: "Costco",
      delivery_date: "2026-09-07",
    });

    await upsertOrder(session, { ...PARAMS, foodbankId: null, needId: null, orderGroupId: null, deliveryProvider: null, deliveryProviderId: null, sourceUrl: null, actualCost: null, country: "" }, ORDER_ROW);
    expect(readRow("orders", ORDER_ROW)).toMatchObject({
      foodbank_id: null,
      need_id: null,
      order_group_id: null,
      delivery_provider: null,
      delivery_provider_id: null,
      source_url: null,
      actual_cost: null,
    });
  });

  // orders.py:125-128 -- the country is "" for an unassigned order, and the
  // column is NOT NULL, so it cannot be NULL. Both statements have to accept
  // the empty string; a bind that coalesced "" to null would fail the
  // constraint outright on insert and, worse, be a plausible "fix" someone
  // makes to the UPDATE alone.
  it("stores the empty-string country of an unassigned order", async () => {
    freezeClock();
    const created = await upsertOrder(session, { ...PARAMS, foodbankId: null, country: "", orderId: "temp-order-abc" });
    expect(readRow("orders", created.id).country).toBe("");

    await upsertOrder(session, { ...PARAMS, foodbankId: null, country: "", orderId: "temp-order-abc" }, created.id);
    expect(readRow("orders", created.id).country).toBe("");
  });

  // The WHERE, tested with a row that must NOT change. An UPDATE whose
  // predicate drifted (to `order_id = ?`, say, which is not unique) would
  // rewrite somebody else's delivery with this order's items text.
  it("updates only the targeted row", async () => {
    freezeClock();
    seedOrder({ id: ORDER_ROW, order_id: "gf-salisbury-tesco-2026-09-05", items_text: "mine" });
    seedOrder({ id: OTHER_ORDER_ROW, order_id: "gf-salisbury-tesco-2026-09-05", items_text: "not mine", weight: 999 });

    await upsertOrder(session, PARAMS, ORDER_ROW);

    expect(readRow("orders", OTHER_ORDER_ROW)).toMatchObject({ items_text: "not mine", weight: 999, modified: LATER });
  });

  // Both timestamps in the migrated Django shape, and equal on an insert --
  // the same value is bound twice on purpose. A `new Date().toISOString()`
  // here would sort above every migrated same-day row on the two columns the
  // deliveries list and getAllOrdersForCsv order by. This is the module's
  // stated reason for having d1Timestamp at all rather than using pyNow().
  it("stamps created and modified in the migrated Django shape", async () => {
    freezeClock();
    const created = await upsertOrder(session, PARAMS);

    const row = readRow("orders", created.id) as { created: string; modified: string };
    expect(row.created).toBe(row.modified);
    expect(row.created).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
    expect(row.created).not.toContain("T");
    expect(row.created).not.toContain("Z");
  });

  // SUSPECT, pinned rather than fixed. The UPDATE branch neither checks nor
  // reports how many rows it changed, so an existingId that no longer exists
  // is a silent no-op: the caller gets `{id, order_id}` back, orderForm.ts:381
  // redirects to /admin/order/<order_id>/, and THAT page 404s. Reachable --
  // orderActions.ts's delete and this form's save are two tabs on the same
  // order -- though narrow. Contrast the INSERT branch, which does throw when
  // RETURNING yields nothing.
  it("SUSPECT: silently does nothing when the row being edited has been deleted", async () => {
    freezeClock();

    const result = await upsertOrder(session, PARAMS, 9999);

    expect(result).toEqual({ id: 9999, order_id: "gf-salisbury-tesco-2026-09-05" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM orders").get()).toEqual({ n: 0 });
  });
});

// ===========================================================================
// setOrderId -- orders.py:207-211's second statement, an .update() chosen
// specifically to dodge recursing back into save().
// ===========================================================================
describe("setOrderId", () => {
  it("rewrites just the order_id of just that row", async () => {
    seedOrder({ id: ORDER_ROW, order_id: "temp-order-6a3f", foodbank_id: null });
    seedOrder({ id: OTHER_ORDER_ROW, order_id: "temp-order-9b12", foodbank_id: null });

    await setOrderId(session, ORDER_ROW, "gf-unassigned-1201-tesco-2026-09-05");

    expect(readRow("orders", ORDER_ROW).order_id).toBe("gf-unassigned-1201-tesco-2026-09-05");
    expect(readRow("orders", OTHER_ORDER_ROW).order_id).toBe("temp-order-9b12");
  });

  // `modified` is deliberately untouched, and this is a PARITY claim, not an
  // oversight: Django reaches for `Order.objects.filter(pk=...).update(...)`
  // here, and a queryset .update() bypasses save() -- so auto_now never fires
  // and `modified` keeps the value the save two lines earlier gave it.
  it("does not restamp modified, matching Django's queryset .update()", async () => {
    seedOrder({ id: ORDER_ROW, order_id: "temp-order-6a3f", modified: "2026-08-02 09:00:00.000000" });

    await setOrderId(session, ORDER_ROW, "gf-unassigned-1201-tesco-2026-09-05");

    expect(readRow("orders", ORDER_ROW)).toMatchObject({ modified: "2026-08-02 09:00:00.000000", created: LATER });
  });

  // The `temp-order-<uuid4>` placeholder orderForm.ts:321 writes exists only
  // because the real id embeds the primary key, which the insert has to
  // produce first. If this statement ever silently missed, the placeholder
  // would be the order's permanent public id -- so the round trip is pinned
  // end to end rather than only on the UPDATE.
  it("replaces the temp-order placeholder a new unassigned order was inserted with", async () => {
    freezeClock();
    const created = await upsertOrder(session, {
      orderId: "temp-order-6a3f9c2e-0000-4000-8000-000000000000",
      foodbankId: null,
      itemsText: "1 x Nappies",
      needId: null,
      orderGroupId: null,
      country: "",
      sourceUrl: null,
      deliveryDate: "2026-09-05",
      deliveryHour: 14,
      deliveryDatetime: "2026-09-05 14:00:00.000000",
      deliveryProvider: null,
      deliveryProviderId: null,
      actualCost: null,
    });

    // orderForm.ts:361, with slugifyProvider(null) supplying the "none".
    await setOrderId(session, created.id, `gf-unassigned-${created.id}-${slugifyProvider(null)}-2026-09-05`);

    expect(readRow("orders", created.id).order_id).toBe(`gf-unassigned-${created.id}-none-2026-09-05`);
    expect(await getOrderForEdit(session, "temp-order-6a3f9c2e-0000-4000-8000-000000000000")).toBeNull();
  });
});

// ===========================================================================
// deleteOrderLines / deleteOrder
// ===========================================================================
describe("deleteOrderLines", () => {
  // The filter, with rows that must survive. `orderline.order_id` is the
  // INTEGER orders.id, and there is no foreign key to stop a wrong value
  // deleting a different delivery's entire shopping list -- silently, since
  // DELETE reports no error for matching nothing OR for matching too much.
  it("deletes only the given order's lines", async () => {
    seedLine({ id: 501, order_id: ORDER_ROW, name: "Tinned Tomatoes" });
    seedLine({ id: 502, order_id: ORDER_ROW, name: "Long Grain Rice" });
    seedLine({ id: 601, order_id: OTHER_ORDER_ROW, name: "Pallet Of Beans" });

    await deleteOrderLines(session, ORDER_ROW);

    expect(db.prepare("SELECT id FROM orderline ORDER BY id").all()).toEqual([{ id: 601 }]);
  });

  // The queue job runs this before every insert, including the first time an
  // order is parsed. No rows to delete is the normal case, not an error.
  it("is a no-op for an order with no lines", async () => {
    seedLine({ id: 601, order_id: OTHER_ORDER_ROW, name: "Pallet Of Beans" });
    await deleteOrderLines(session, ORDER_ROW);
    expect(db.prepare("SELECT COUNT(*) AS n FROM orderline").get()).toEqual({ n: 1 });
  });
});

describe("deleteOrder", () => {
  // orders.py:89-95 -- lines first, then the order.
  it("deletes the order and its lines, and nothing else", async () => {
    seedOrder({ id: ORDER_ROW, order_id: "gf-salisbury-tesco-2026-09-05" });
    seedOrder({ id: OTHER_ORDER_ROW, order_id: "gf-brixton-costco-2026-09-06" });
    seedLine({ id: 501, order_id: ORDER_ROW, name: "Tinned Tomatoes" });
    seedLine({ id: 502, order_id: ORDER_ROW, name: "Long Grain Rice" });
    seedLine({ id: 601, order_id: OTHER_ORDER_ROW, name: "Pallet Of Beans" });

    await deleteOrder(session, ORDER_ROW);

    expect(db.prepare("SELECT id FROM orders ORDER BY id").all()).toEqual([{ id: OTHER_ORDER_ROW }]);
    expect(db.prepare("SELECT id FROM orderline ORDER BY id").all()).toEqual([{ id: 601 }]);
  });

  // ONE batch, not two round trips -- the module's stated reason ("so a
  // half-delete, orphaned orderline rows pointing at a vanished order, is not
  // reachable"). D1 applies a batch atomically; two awaited statements are two
  // transactions, and an isolate that dies between them leaves exactly the
  // orphan state the batch exists to prevent. Asserted on the batch log,
  // because the resulting ROWS are identical either way -- which is precisely
  // why this would never be noticed without a test.
  it("sends both statements in a single batch, lines before the order", async () => {
    seedOrder({ id: ORDER_ROW, order_id: "gf-salisbury-tesco-2026-09-05" });
    seedLine({ id: 501, order_id: ORDER_ROW, name: "Tinned Tomatoes" });

    await deleteOrder(session, ORDER_ROW);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    expect(batches[0]![0]!.sql).toContain("DELETE FROM orderline");
    expect(batches[0]![1]!.sql).toContain("DELETE FROM orders");
    expect(batches[0]!.map((s) => s.params)).toEqual([[ORDER_ROW], [ORDER_ROW]]);
  });

  // An order the queue job never parsed -- no lines, and the delete still has
  // to remove the order itself. A batch whose first statement matched nothing
  // must not abandon the second.
  it("deletes an order that has no lines", async () => {
    seedOrder({ id: ORDER_ROW, order_id: "gf-salisbury-tesco-2026-09-05" });
    await deleteOrder(session, ORDER_ROW);
    expect(db.prepare("SELECT COUNT(*) AS n FROM orders").get()).toEqual({ n: 0 });
  });
});

// ===========================================================================
// recomputeFoodbankLastOrder -- orders.py:214-216's
// `Order.objects.filter(foodbank=fb).order_by("-delivery_date")[0]
// .delivery_date`, i.e. MAX(delivery_date), plus two calls Django never makes.
// ===========================================================================
describe("recomputeFoodbankLastOrder", () => {
  beforeEach(() => {
    seedFoodbank({ id: SALISBURY, name: "Salisbury Foodbank", slug: "salisbury", last_order: "2020-01-01" });
    seedFoodbank({ id: BRIXTON, name: "Brixton Foodbank", slug: "brixton", last_order: "2019-01-01" });
  });

  // MAX over a TEXT column of "YYYY-MM-DD" -- lexicographic and chronological
  // order coincide for that shape, which is the only reason a string MAX is
  // correct here.
  //
  // THE ANSWER IS THE MIDDLE ROW BY ROWID, deliberately: neither the first nor
  // the last order written is the latest one, so a subquery reaching for the
  // wrong end of the table gives a visibly wrong date rather than the right
  // one by luck.
  it("sets last_order to the food bank's latest delivery date", async () => {
    seedOrder({ id: ORDER_ROW, order_id: "a", foodbank_id: SALISBURY, delivery_date: "2026-02-28" });
    seedOrder({ id: OTHER_ORDER_ROW, order_id: "b", foodbank_id: SALISBURY, delivery_date: "2026-12-01" });
    seedOrder({ id: 1203, order_id: "c", foodbank_id: SALISBURY, delivery_date: "2026-09-05" });

    await recomputeFoodbankLastOrder(session, SALISBURY);

    expect(readRow("foodbank", SALISBURY).last_order).toBe("2026-12-01");
    // MIN() gives the earliest and `ORDER BY id DESC LIMIT 1` the last row
    // written -- two different wrong dates, and neither is the answer.
    expect(db.prepare("SELECT MIN(delivery_date) AS d FROM orders WHERE foodbank_id = ?").get(SALISBURY)).toEqual({ d: "2026-02-28" });
    expect(db.prepare("SELECT delivery_date AS d FROM orders WHERE foodbank_id = ? ORDER BY id DESC LIMIT 1").get(SALISBURY)).toEqual({ d: "2026-09-05" });
  });

  // THE MAX() THE ROWS CANNOT SEE. Drop the aggregate and leave a bare
  // `SELECT delivery_date FROM orders WHERE foodbank_id = ?` -- still legal
  // SQL, still one scalar, no error, and an ordinary slip while editing the
  // UPDATE around it -- and every row assertion above still passes. Not
  // because a scalar subquery is an aggregate, but because 0005's
  // order_foodbank_delivery_idx is `(foodbank_id, delivery_datetime DESC)`:
  // SQLite answers the predicate by walking that index, so the FIRST row it
  // reaches is the latest delivery, and delivery_datetime is derived from
  // delivery_date by the same write. Confirmed with EXPLAIN QUERY PLAN, not
  // assumed -- the plan below names the index.
  //
  // No arrangement of rows can separate the two while the columns agree, and
  // making them disagree would be a fixture production cannot produce. So the
  // aggregate is pinned on the statement, where the guarantee actually is: the
  // moment the planner picks a different path -- another index, a scan, a
  // future ANALYZE -- the mutant starts writing an arbitrary row's date onto
  // every food bank's page.
  it("asks for MAX() rather than leaning on the index to return the latest row first", async () => {
    seedOrder({ id: ORDER_ROW, order_id: "a", foodbank_id: SALISBURY, delivery_date: "2026-02-28" });
    seedOrder({ id: OTHER_ORDER_ROW, order_id: "b", foodbank_id: SALISBURY, delivery_date: "2026-12-01" });
    sent.length = 0;

    await recomputeFoodbankLastOrder(session, SALISBURY);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.sql).toContain("SELECT MAX(delivery_date) FROM orders WHERE foodbank_id = ?");
    // The plan that hides the mutation, named rather than described.
    expect((db.prepare("EXPLAIN QUERY PLAN SELECT delivery_date FROM orders WHERE foodbank_id = ?").all(SALISBURY) as { detail: string }[])[0]!.detail).toContain(
      "order_foodbank_delivery_idx",
    );
  });

  // The subquery's filter, with rows that must be excluded. Both binds are the
  // same food bank id, so a transposition is invisible -- what is NOT
  // invisible is a subquery that lost its WHERE and started reporting the
  // whole site's latest delivery on every food bank's page.
  it("ignores other food banks' orders, and leaves their last_order alone", async () => {
    seedOrder({ id: ORDER_ROW, order_id: "a", foodbank_id: SALISBURY, delivery_date: "2026-02-28" });
    seedOrder({ id: OTHER_ORDER_ROW, order_id: "b", foodbank_id: BRIXTON, delivery_date: "2026-12-01" });
    // An unassigned order, which belongs to nobody's last_order.
    seedOrder({ id: 1203, order_id: "c", foodbank_id: null, delivery_date: "2027-01-01" });

    await recomputeFoodbankLastOrder(session, SALISBURY);

    expect(readRow("foodbank", SALISBURY).last_order).toBe("2026-02-28");
    expect(readRow("foodbank", BRIXTON).last_order).toBe("2019-01-01");
  });

  // THE FIX THE MODULE COMMENT CLAIMS, executed. Django's Order.delete()
  // (orders.py:89-95) never touches last_order, so deleting a food bank's only
  // order left it advertising a delivery that no longer exists. MAX() over no
  // rows is NULL, and the column is nullable, so the stale date is cleared
  // rather than frozen.
  it("clears last_order to NULL when the food bank has no orders left", async () => {
    seedOrder({ id: ORDER_ROW, order_id: "a", foodbank_id: SALISBURY, delivery_date: "2026-02-28" });
    await deleteOrder(session, ORDER_ROW);

    await recomputeFoodbankLastOrder(session, SALISBURY);

    expect(readRow("foodbank", SALISBURY).last_order).toBeNull();
  });

  // `modified` is stamped, `edited` is NOT -- the module comment's own
  // distinction, and one this codebase enforces elsewhere (foodbankAdmin.ts's
  // updateFoodbankFields takes an explicit stampEdited flag). `edited` means
  // "a human edited this food bank" and drives foodbank_edited_idx and the
  // admin's recently-edited list; a derived recompute writing it would fill
  // that list with food banks nobody has touched.
  it("stamps modified but never edited", async () => {
    freezeClock();
    seedOrder({ id: ORDER_ROW, order_id: "a", foodbank_id: SALISBURY, delivery_date: "2026-02-28" });

    await recomputeFoodbankLastOrder(session, SALISBURY);

    expect(readRow("foodbank", SALISBURY)).toMatchObject({ modified: NOW_D1, edited: null });
  });

  // An edit that moved an order between food banks calls this twice, once per
  // side (orderForm.ts:368-369) -- Django does neither, leaving the PREVIOUS
  // food bank advertising a delivery it no longer has. Both halves in one
  // test, because the fix is only a fix if both run.
  it("brings both sides of a moved order up to date", async () => {
    seedOrder({ id: ORDER_ROW, order_id: "a", foodbank_id: SALISBURY, delivery_date: "2026-12-01" });
    seedOrder({ id: OTHER_ORDER_ROW, order_id: "b", foodbank_id: SALISBURY, delivery_date: "2026-02-28" });
    await recomputeFoodbankLastOrder(session, SALISBURY);
    expect(readRow("foodbank", SALISBURY).last_order).toBe("2026-12-01");

    // The December order moves to Brixton.
    db.prepare("UPDATE orders SET foodbank_id = ? WHERE id = ?").run(BRIXTON, ORDER_ROW);
    await recomputeFoodbankLastOrder(session, BRIXTON);
    await recomputeFoodbankLastOrder(session, SALISBURY);

    expect(readRow("foodbank", BRIXTON).last_order).toBe("2026-12-01");
    expect(readRow("foodbank", SALISBURY).last_order).toBe("2026-02-28");
  });

  // A food bank id that no longer exists (deleteFoodbankCascade nulls
  // `orders.foodbank_id` but the job may still be holding the old value). No
  // rows updated, no error -- pinned so a future guard clause does not turn
  // this into a throw inside a queue consumer.
  it("is a silent no-op for a food bank that no longer exists", async () => {
    await recomputeFoodbankLastOrder(session, 999);
    expect(readRow("foodbank", SALISBURY).last_order).toBe("2020-01-01");
  });
});

// ===========================================================================
// setOrderNotificationSent -- gfadmin/views.py:518-519's stamp, WITHOUT the
// full order.save() Django wraps it in.
// ===========================================================================
describe("setOrderNotificationSent", () => {
  // The whole point of the function. Django's views.py:518-519 calls
  // order.save() to write one timestamp, which re-runs the entire paid Gemini
  // parse and deletes and recreates every OrderLine -- at temperature=1, so it
  // can legitimately produce different lines than the ones actually ordered.
  // This statement names two columns. If it ever grew to re-zero the
  // aggregates like upsertOrder does, an admin clicking "Send Notification"
  // would blank the order's weight and cost on the page they are looking at.
  it("stamps the timestamp without disturbing anything else on the row", async () => {
    freezeClock();
    seedLine({ id: 501, order_id: ORDER_ROW, name: "Tinned Tomatoes" });
    seedOrder({ id: ORDER_ROW, order_id: "gf-salisbury-tesco-2026-09-05", weight: 21450, calories: 48200, cost: 12345, no_lines: 4, no_items: 8, created: LATER });

    await setOrderNotificationSent(session, ORDER_ROW, "2026-09-03 17:45:10.905000");

    expect(readRow("orders", ORDER_ROW)).toMatchObject({
      notification_email_sent: "2026-09-03 17:45:10.905000",
      weight: 21450,
      calories: 48200,
      cost: 12345,
      no_lines: 4,
      no_items: 8,
      created: LATER,
      order_id: "gf-salisbury-tesco-2026-09-05",
    });
    // The lines survive too -- Django's version destroyed and regenerated them.
    expect(db.prepare("SELECT COUNT(*) AS n FROM orderline").get()).toEqual({ n: 1 });
  });

  // Two different timestamps in one statement: the CALLER's `sentAt` for the
  // notification and the function's own `d1Timestamp()` for `modified`. They
  // are bound in that order, and swapping them would put the row's
  // modification time in the column routes/admin/order.ts hands to timesince()
  // -- close enough to look right and wrong by however long the send took.
  it("binds the caller's sentAt to notification_email_sent and its own now to modified", async () => {
    freezeClock();
    seedOrder({ id: ORDER_ROW, order_id: "gf-salisbury-tesco-2026-09-05", modified: "2026-08-02 09:00:00.000000" });

    await setOrderNotificationSent(session, ORDER_ROW, "2026-09-03 17:45:10.905000");

    expect(readRow("orders", ORDER_ROW)).toMatchObject({ notification_email_sent: "2026-09-03 17:45:10.905000", modified: NOW_D1 });
  });

  it("stamps only the targeted order", async () => {
    freezeClock();
    seedOrder({ id: ORDER_ROW, order_id: "a" });
    seedOrder({ id: OTHER_ORDER_ROW, order_id: "b" });

    await setOrderNotificationSent(session, ORDER_ROW, "2026-09-03 17:45:10.905000");

    expect(readRow("orders", OTHER_ORDER_ROW).notification_email_sent).toBeNull();
  });
});

// ===========================================================================
// getOrderLinesByWeight -- Order.lines() (orders.py:227-228), the list that
// goes out in the notification EMAIL. orderAdmin.ts's getOrderLines uses the
// identical ordering for the admin page, so the two must agree.
// ===========================================================================
describe("getOrderLinesByWeight", () => {
  // Four lines whose weight order, id order and insertion order all differ, so
  // no wrong ORDER BY can pass by coincidence. 1000 vs 900 is also the numeric
  // comparison: lexicographically "1000" sorts BELOW "900", so a TEXT
  // comparison would put Tinned Tomatoes first.
  function seedFourLines(): void {
    seedLine({ id: 501, order_id: ORDER_ROW, name: "Tinned Tomatoes", quantity: 4, weight: 900 });
    seedLine({ id: 502, order_id: ORDER_ROW, name: "Long Grain Rice", quantity: 2, weight: 1000 });
    seedLine({ id: 503, order_id: ORDER_ROW, name: "Teabags", quantity: 1, weight: 900 });
    seedLine({ id: 504, order_id: ORDER_ROW, name: "Nappies", quantity: 1, weight: null });
  }

  it("returns the lines heaviest first, with id as the tiebreak", async () => {
    seedFourLines();

    expect((await getOrderLinesByWeight(session, ORDER_ROW)).map((l) => l.name)).toEqual(["Long Grain Rice", "Tinned Tomatoes", "Teabags", "Nappies"]);
  });

  // The tiebreak on its own. The module comment's reason for it is that "two
  // equal weights don't reorder between renders" -- and the render that
  // matters is an EMAIL, which is sent once and archived. Ten equal weights
  // with ids out of insertion order is enough that an unstable sort or a
  // `, id DESC` shows.
  it("breaks a run of equal weights by ascending id", async () => {
    const ids = [808, 801, 806, 803, 809, 802, 807, 804, 800, 805];
    for (const id of ids) seedLine({ id, order_id: ORDER_ROW, name: `Line ${id}`, weight: 500 });

    expect((await getOrderLinesByWeight(session, ORDER_ROW)).map((l) => l.name)).toEqual([...ids].sort((a, b) => a - b).map((id) => `Line ${id}`));
  });

  // THE TIEBREAK THE ROWS CANNOT SEE. The test directly above seeds ten equal
  // weights with ids out of insertion order and STILL PASSES when `, id` is
  // deleted from the statement: orderline.id is the rowid, SQLite reaches the
  // rows through orderline_order_idx in rowid order, and its temp-B-tree sort
  // happens to leave equal keys in the order they arrived -- so ascending id
  // comes back either way. Verified, not assumed: with `ORDER BY weight DESC`
  // alone, ten rows of weight 500 come out 800..809 exactly as they do with
  // the tiebreak.
  //
  // SQLite promises no such thing for equal sort keys, and this is the query
  // behind a notification EMAIL, which is sent once and cannot be re-rendered.
  // The guarantee is the clause, so the clause is what is pinned. It also has
  // to stay byte-identical to orderAdmin.ts's getOrderLines -- that identity
  // is the module comment's stated reason the admin page and the email agree
  // about the order of an order.
  it("asks for the id tiebreak in the statement, not only in the comment", async () => {
    seedFourLines();
    sent.length = 0;

    await getOrderLinesByWeight(session, ORDER_ROW);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.sql).toContain("ORDER BY weight DESC, id");
  });

  // DIVERGENCE FROM DJANGO, pinned rather than fixed. `order_by("-weight")` on
  // Postgres puts NULLs FIRST for a DESC sort; SQLite treats NULL as the
  // smallest value and puts them LAST. So a line whose weight is unknown heads
  // Django's list and tails this one -- and this is the query behind the
  // notification email, so the reordering goes out to the food bank.
  //
  // Reachable only for rows with a NULL weight: insertOrderLines always binds
  // a number, so it is the imported Postgres rows and anything predating that
  // writer. The same divergence is pinned in orderAdmin.test.ts for the admin
  // page's copy of this ordering; both are here so the pair cannot drift apart
  // unnoticed.
  it("sorts a line with no weight last, where Django sorted it first", async () => {
    seedFourLines();

    const lines = await getOrderLinesByWeight(session, ORDER_ROW);
    expect(lines[lines.length - 1]).toEqual({ name: "Nappies", quantity: 1, weight: null });
  });

  // The filter, with an intruder seeded HEAVIER than anything in the real
  // order, so a dropped or widened WHERE puts it at the top of the email --
  // an item from another food bank's delivery, first in the list, with nothing
  // to mark it as foreign. Both directions, so a hard-coded id cannot pass.
  it("excludes another order's lines", async () => {
    seedFourLines();
    seedLine({ id: 601, order_id: OTHER_ORDER_ROW, name: "Pallet Of Beans", quantity: 100, weight: 99999 });

    expect((await getOrderLinesByWeight(session, ORDER_ROW)).map((l) => l.name)).not.toContain("Pallet Of Beans");
    expect((await getOrderLinesByWeight(session, OTHER_ORDER_ROW)).map((l) => l.name)).toEqual(["Pallet Of Beans"]);
  });

  // Three columns, and specifically NOT `calories`, `item_cost`, `line_cost`,
  // `category` or `group_name`. The email template iterates whatever it is
  // given, and category/group_name are AI-assigned values no admin has
  // reviewed -- they should not reach a food bank's inbox by accident.
  it("selects only name, quantity and weight", async () => {
    seedFourLines();

    const lines = await getOrderLinesByWeight(session, ORDER_ROW);
    expect(Object.keys(lines[0]!).sort()).toEqual(["name", "quantity", "weight"]);
    expect(lines[0]).toEqual({ name: "Long Grain Rice", quantity: 2, weight: 1000 });
  });

  // An order whose queue job has not run yet -- an empty array, not null and
  // not a throw, because orderActions.ts renders it into the email template.
  it("returns an empty array for an order with no lines", async () => {
    seedFourLines();
    expect(await getOrderLinesByWeight(session, OTHER_ORDER_ROW)).toEqual([]);
  });
});

// ===========================================================================
// getOrderGroupForOrder
// ===========================================================================
describe("getOrderGroupForOrder", () => {
  it("returns the group's id, name and slug", async () => {
    seedOrderGroup({ id: CHRISTMAS, name: "Christmas 2026", slug: "christmas-2026" });
    seedOrderGroup({ id: HARVEST, name: "Harvest 2026", slug: "harvest-2026" });

    expect(await getOrderGroupForOrder(session, HARVEST)).toEqual({ id: HARVEST, name: "Harvest 2026", slug: "harvest-2026" });
  });

  // A dangling order_group_id, which this schema allows outright (PLAN.md 4.5,
  // no foreign keys) -- orderGroupAdmin can delete a group without touching
  // the orders pointing at it. Null, not a throw: the caller is expected to
  // treat the group as absent.
  it("returns null for a group id that no longer exists", async () => {
    seedOrderGroup({ id: CHRISTMAS, name: "Christmas 2026", slug: "christmas-2026" });
    expect(await getOrderGroupForOrder(session, 998)).toBeNull();
  });

  // `key` stays out, same reason as getOrderGroupOptions: it is the
  // capability token in the donor-facing URL.
  it("never selects the capability key", async () => {
    seedOrderGroup({ id: CHRISTMAS, name: "Christmas 2026", slug: "christmas-2026" });
    expect(Object.keys((await getOrderGroupForOrder(session, CHRISTMAS))!).sort()).toEqual(["id", "name", "slug"]);
  });
});

// ===========================================================================
// getOrderForLineParse -- the queue job's own read of the order it is about to
// parse (workers/jobs/src/adminJobs/orderLines.ts).
// ===========================================================================
describe("getOrderForLineParse", () => {
  // Exactly five columns, and each of them is used: `items_text` is the AI
  // prompt, `delivery_date` is denormalised onto every line it writes,
  // `foodbank_id` decides whether last_order is recomputed, `order_id` goes
  // into the job's done payload, and `id` is what the writes target.
  it("returns the five columns the job consumes, and only those", async () => {
    seedOrder({ id: ORDER_ROW, order_id: "gf-salisbury-tesco-2026-09-05", foodbank_id: SALISBURY, items_text: "4 x Tinned Tomatoes", delivery_date: "2026-09-05" });

    expect(await getOrderForLineParse(session, ORDER_ROW)).toEqual({
      id: ORDER_ROW,
      order_id: "gf-salisbury-tesco-2026-09-05",
      items_text: "4 x Tinned Tomatoes",
      delivery_date: "2026-09-05",
      foodbank_id: SALISBURY,
    });
  });

  // BY ROW ID, not by the human order_id -- the queue message carries
  // `saved.id` (orderForm.ts:376) precisely so a save that regenerated the
  // order_id cannot leave the job looking for a string that no longer exists.
  // `orders.id` has INTEGER affinity, so a bound numeric STRING is converted
  // and still matches; it is only a non-numeric order_id that returns nothing.
  it("takes the row id, not the human order_id", async () => {
    seedOrder({ id: ORDER_ROW, order_id: "gf-salisbury-tesco-2026-09-05" });

    expect(await getOrderForLineParse(session, "gf-salisbury-tesco-2026-09-05" as unknown as number)).toBeNull();
    expect((await getOrderForLineParse(session, String(ORDER_ROW) as unknown as number))!.id).toBe(ORDER_ROW);
  });

  // orderLines.ts:105-108 turns the null into markAdminJobFailed("Order row N
  // no longer exists") rather than a throw, which is what makes a queue
  // message for a since-deleted order harmless.
  it("returns null for an order that has been deleted", async () => {
    expect(await getOrderForLineParse(session, ORDER_ROW)).toBeNull();
  });

  // An unassigned order still gets parsed -- the job just skips the
  // last_order recompute (orderLines.ts:188). The null has to survive the read
  // as null, because `if (order.foodbank_id !== null)` is what guards that.
  it("returns a null foodbank_id rather than dropping the order", async () => {
    seedOrder({ id: ORDER_ROW, order_id: "gf-unassigned-1201-none-2026-09-05", foodbank_id: null });

    expect((await getOrderForLineParse(session, ORDER_ROW))!.foodbank_id).toBeNull();
  });
});

// ===========================================================================
// insertOrderLines
// ===========================================================================
describe("insertOrderLines", () => {
  const LINE = { name: "Tinned Tomatoes", quantity: 4, itemCost: 89, lineCost: 356, weight: 1520, calories: 1216, category: "Tinned Vegetables", group: "Meal Food" };

  // COLUMN BY COLUMN, because every one of these is a plausible transposition
  // and none of them would raise: item_cost and line_cost are both INTEGER
  // pence, weight and calories are both INTEGER, category and group_name are
  // both TEXT. Swap either pair and the order page shows numbers -- wrong
  // ones -- and the price-per-kg dashboard silently reports them.
  it("writes each field to its own column", async () => {
    await insertOrderLines(session, ORDER_ROW, "2026-09-05", [LINE]);

    expect(db.prepare("SELECT * FROM orderline").get()).toEqual({
      id: 1,
      name: "Tinned Tomatoes",
      quantity: 4,
      item_cost: 89,
      line_cost: 356,
      weight: 1520,
      calories: 1216,
      order_id: ORDER_ROW,
      delivery_date: "2026-09-05",
      category: "Tinned Vegetables",
      group_name: "Meal Food",
    });
  });

  // THE COLUMN RENAME. 0005_orders_and_charity.sql calls it `group_name`
  // because `group` is a SQL keyword -- the same rename foodbankchangeline
  // needed. The NewOrderLine field is still `group`, so the mapping happens in
  // this statement and nowhere else, and a `group` in the column list is a
  // syntax error rather than a silent miss. Pinned on the stored row so that a
  // future schema change adding a real `group` column cannot make the write
  // land in the wrong one.
  it("maps the `group` field onto the `group_name` column", async () => {
    await insertOrderLines(session, ORDER_ROW, "2026-09-05", [{ ...LINE, group: "Non Food" }]);

    expect(db.prepare("SELECT group_name FROM orderline").get()).toEqual({ group_name: "Non Food" });
  });

  // delivery_date is the FUNCTION's argument, denormalised onto every line --
  // OrderLine.save():249 copies it off the parent order. orderline_delivery_
  // date_idx and the price-per-kg dashboard both read it from the line, not
  // from a join, so a line carrying the wrong date is a delivery counted in
  // the wrong month.
  it("denormalises one delivery_date onto every line", async () => {
    await insertOrderLines(session, ORDER_ROW, "2026-09-05", [LINE, { ...LINE, name: "Long Grain Rice" }, { ...LINE, name: "Teabags" }]);

    expect(db.prepare("SELECT DISTINCT delivery_date FROM orderline").all()).toEqual([{ delivery_date: "2026-09-05" }]);
  });

  // ONE batch for N lines, not N round trips -- the module says so, and D1
  // applies a batch atomically, so a half-written order (some lines present,
  // aggregates about to be computed from all of them) is not reachable.
  it("sends every line in a single batch", async () => {
    const lines = Array.from({ length: 12 }, (_, i) => ({ ...LINE, name: `Item ${String(i).padStart(2, "0")}` }));

    await insertOrderLines(session, ORDER_ROW, "2026-09-05", lines);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(12);
    expect(db.prepare("SELECT COUNT(*) AS n FROM orderline").get()).toEqual({ n: 12 });
  });

  // D1'S 100-BOUND-PARAMETER LIMIT, which is per STATEMENT, not per batch.
  // Each INSERT here binds a fixed ten values however long the order is, so
  // the limit is unreachable -- and that is a property of the shape, not an
  // accident. The obvious optimisation, folding N lines into one multi-row
  // `VALUES (...), (...)` INSERT, would bind 10*N and start failing on D1 at
  // eleven lines while passing locally on SQLite, which has no such cap. A
  // real order is 20-40 lines, so it would fail on the first order after the
  // change. This test is what stops that landing.
  it("binds exactly ten parameters per statement, whatever the size of the order", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => ({ ...LINE, name: `Item ${String(i).padStart(2, "0")}` }));

    await insertOrderLines(session, ORDER_ROW, "2026-09-05", lines);

    expect(batches[0]).toHaveLength(40);
    expect(new Set(batches[0]!.map((s) => s.params.length))).toEqual(new Set([10]));
    // One statement text, reused -- not 40 different ones.
    expect(new Set(batches[0]!.map((s) => s.sql)).size).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM orderline").get()).toEqual({ n: 40 });
  });

  // A parse that returned nothing -- an empty items_text, or a model that
  // produced an empty array. `session.batch([])` is a statement list D1 has no
  // use for, so the guard saves a round trip; asserted on the batch log
  // because "no rows were written" would also be true of a batch that ran.
  it("sends no batch at all for an empty line list", async () => {
    await insertOrderLines(session, ORDER_ROW, "2026-09-05", []);

    expect(batches).toEqual([]);
    expect(sent).toEqual([]);
  });

  // Duplicate names are legal and expected -- Gemini can return the same SKU
  // twice at temperature=1, and there is no unique index on orderline.name.
  // Both rows have to land, or the aggregates the job computed in JavaScript
  // stop matching the lines the page shows.
  it("writes both of two lines that share a name", async () => {
    await insertOrderLines(session, ORDER_ROW, "2026-09-05", [LINE, { ...LINE, quantity: 1, lineCost: 89 }]);

    expect(db.prepare("SELECT COUNT(*) AS n FROM orderline WHERE name = 'Tinned Tomatoes'").get()).toEqual({ n: 2 });
  });

  // The empty-string category orderLines.ts writes when neither fallback found
  // one (`(await getLatestOrderLineCategory(db, name)) ?? ""`). It must be
  // stored as "" and not as NULL: getLatestOrderLineCategory excludes BOTH, so
  // either would be skipped by the next lookup, but 0005's
  // orderline_category_idx is `WHERE category IS NOT NULL`, so the two forms
  // index differently.
  it("stores an uncategorised line's empty strings verbatim", async () => {
    await insertOrderLines(session, ORDER_ROW, "2026-09-05", [{ ...LINE, category: "", group: "" }]);

    expect(db.prepare("SELECT category, group_name FROM orderline").get()).toEqual({ category: "", group_name: "" });
  });
});

// ===========================================================================
// setOrderAggregates -- orders.py:198-204's second super().save(), the five
// aggregates only.
// ===========================================================================
describe("setOrderAggregates", () => {
  // Five values into five columns. They are all INTEGERs of similar magnitude,
  // so any transposition is silent -- and each one is displayed: weight drives
  // the kg figure and the price-per-kg dashboard, cost drives price-per-calorie,
  // no_items and no_lines are the counts on the order page.
  it("writes each aggregate to its own column", async () => {
    freezeClock();
    seedOrder({ id: ORDER_ROW, order_id: "gf-salisbury-tesco-2026-09-05", weight: 0, calories: 0, cost: 0, no_lines: 0, no_items: 0 });

    await setOrderAggregates(session, ORDER_ROW, { weight: 21450, calories: 48200, cost: 12345, noLines: 4, noItems: 8 });

    expect(readRow("orders", ORDER_ROW)).toMatchObject({ weight: 21450, calories: 48200, cost: 12345, no_lines: 4, no_items: 8 });
  });

  // `modified` is stamped because this genuinely is a later write to the row
  // (Django's own second save() updates auto_now for the same reason), and
  // `created` is not -- the order was created when the form was submitted, not
  // when the queue job finished with it.
  it("stamps modified but leaves created alone", async () => {
    freezeClock();
    seedOrder({ id: ORDER_ROW, order_id: "gf-salisbury-tesco-2026-09-05", created: "2026-08-01 09:00:00.000000", modified: "2026-08-01 09:00:00.000000" });

    await setOrderAggregates(session, ORDER_ROW, { weight: 1, calories: 2, cost: 3, noLines: 4, noItems: 5 });

    expect(readRow("orders", ORDER_ROW)).toMatchObject({ created: "2026-08-01 09:00:00.000000", modified: NOW_D1 });
  });

  // The columns it must NOT touch. This runs minutes after the admin
  // submitted the form and possibly after they sent the notification, so a
  // statement that also rewrote order_id or cleared notification_email_sent
  // would undo work that has already happened.
  it("leaves the order's identity and notification state untouched", async () => {
    freezeClock();
    seedOrder({
      id: ORDER_ROW,
      order_id: "gf-salisbury-tesco-2026-09-05",
      foodbank_id: SALISBURY,
      items_text: "4 x Tinned Tomatoes",
      notification_email_sent: "2026-09-03 17:45:10.905000",
      actual_cost: 11987,
    });

    await setOrderAggregates(session, ORDER_ROW, { weight: 1, calories: 2, cost: 3, noLines: 4, noItems: 5 });

    expect(readRow("orders", ORDER_ROW)).toMatchObject({
      order_id: "gf-salisbury-tesco-2026-09-05",
      foodbank_id: SALISBURY,
      items_text: "4 x Tinned Tomatoes",
      notification_email_sent: "2026-09-03 17:45:10.905000",
      actual_cost: 11987,
    });
  });

  // An order with no parsed lines at all: five zeroes, written explicitly
  // rather than skipped, so the row leaves the "not yet parsed" state even
  // when the answer is nothing.
  it("writes zeroes for an order the model returned no lines for", async () => {
    freezeClock();
    seedOrder({ id: ORDER_ROW, order_id: "gf-salisbury-tesco-2026-09-05", weight: 21450, no_lines: 4 });

    await setOrderAggregates(session, ORDER_ROW, { weight: 0, calories: 0, cost: 0, noLines: 0, noItems: 0 });

    expect(readRow("orders", ORDER_ROW)).toMatchObject({ weight: 0, no_lines: 0 });
  });

  it("updates only the targeted order", async () => {
    freezeClock();
    seedOrder({ id: ORDER_ROW, order_id: "a", weight: 0 });
    seedOrder({ id: OTHER_ORDER_ROW, order_id: "b", weight: 777 });

    await setOrderAggregates(session, ORDER_ROW, { weight: 1, calories: 2, cost: 3, noLines: 4, noItems: 5 });

    expect(readRow("orders", OTHER_ORDER_ROW).weight).toBe(777);
  });
});

// ===========================================================================
// getOrderItemCalories -- utils/text.py:118-130 get_calories(), an
// OrderItem.objects.get(name=text) whose DoesNotExist is swallowed.
// ===========================================================================
describe("getOrderItemCalories", () => {
  beforeEach(() => {
    insert("orderitem", { id: 11, name: "Tinned Tomatoes 400g", slug: "tinned-tomatoes-400g", calories: 32 });
    insert("orderitem", { id: 12, name: "Long Grain Rice 1kg", slug: "long-grain-rice-1kg", calories: 349 });
    insert("orderitem", { id: 13, name: "Nappies Size 4", slug: "nappies-size-4", calories: 0 });
  });

  it("returns the per-100g calories for the item with that exact name", async () => {
    expect(await getOrderItemCalories(session, "Tinned Tomatoes 400g")).toBe(32);
    expect(await getOrderItemCalories(session, "Long Grain Rice 1kg")).toBe(349);
  });

  // THE JOIN IS ON THE NAME, BYTE FOR BYTE -- there is no id and no fuzzy
  // match (0014's own comment: "get_calories joins orderline to orderitem on
  // NAME TEXT ... and that string join is the whole read path"). A name the
  // model phrased differently simply scores no calories, which is why the
  // admin's item form exists. Pinned in all four near-miss shapes, because a
  // LIKE or a COLLATE NOCASE would look like an improvement and would silently
  // start attributing one product's calories to another's.
  it("does not match on case, prefix, suffix or surrounding whitespace", async () => {
    expect(await getOrderItemCalories(session, "tinned tomatoes 400g")).toBeNull();
    expect(await getOrderItemCalories(session, "Tinned Tomatoes")).toBeNull();
    expect(await getOrderItemCalories(session, "Tinned Tomatoes 400g ")).toBeNull();
    expect(await getOrderItemCalories(session, "%Tomatoes%")).toBeNull();
  });

  // NULL means "no such item", 0 means "an item with no calories". The caller
  // maps both to 0 today (orderLines.ts:155), so this distinction is the
  // function's contract rather than an observable difference -- and it is
  // exactly the contract a `?? 0` inside the query would destroy, leaving no
  // way for any future caller to tell an unknown item from a zero-calorie one.
  it("keeps a stored zero distinct from a missing item", async () => {
    expect(await getOrderItemCalories(session, "Nappies Size 4")).toBe(0);
    expect(await getOrderItemCalories(session, "Bin Bags")).toBeNull();
  });

  // The `ORDER BY id LIMIT 1` the module calls a deterministic read that
  // "costs nothing" is unreachable today, and this is why: orderitem_name_uniq
  // (0014) refuses the second row. Asserted so that if a future migration
  // relaxes that index -- 0014's comment contemplates the reverse, promoting
  // orderitem_slug_idx to unique -- the assumption is visibly recorded here.
  it("cannot see two items with one name, because orderitem_name_uniq forbids it", () => {
    expect(() => insert("orderitem", { id: 14, name: "Tinned Tomatoes 400g", slug: "dupe", calories: 999 })).toThrow(/UNIQUE/);
  });

  it("returns null when the table is empty", async () => {
    db.exec("DELETE FROM orderitem");
    expect(await getOrderItemCalories(session, "Tinned Tomatoes 400g")).toBeNull();
  });
});

// ===========================================================================
// getLatestOrderLineCategory -- OrderLine.save()'s first category fallback,
// orders.py:255:
//   OrderLine.objects.filter(name=self.name).exclude(category="").latest("id")
// ===========================================================================
describe("getLatestOrderLineCategory", () => {
  // `.latest("id")` is ORDER BY id DESC LIMIT 1 -- the most recently created
  // line, since orderline.id is an autoincrementing rowid. Seeded so the
  // newest row is neither first nor last in insertion order, and so the
  // answer differs from what `ORDER BY id` (ascending, the one-character
  // mutant) would give.
  it("returns the category of the highest-id line with that name", async () => {
    seedLine({ id: 501, order_id: ORDER_ROW, name: "Tinned Tomatoes", category: "Tinned Fruit" });
    seedLine({ id: 503, order_id: ORDER_ROW, name: "Tinned Tomatoes", category: "Tinned Vegetables" });
    seedLine({ id: 502, order_id: ORDER_ROW, name: "Tinned Tomatoes", category: "Sauces" });

    expect(await getLatestOrderLineCategory(session, "Tinned Tomatoes")).toBe("Tinned Vegetables");
  });

  // Django's `.exclude(category="")`. The empty string is what
  // insertOrderLines writes when NEITHER fallback found a category, so
  // without this guard the very first uncategorised line would become the
  // authoritative answer for that name forever -- every later line inheriting
  // "" and the AI categorisation never running again.
  it("skips a newer line whose category is the empty string", async () => {
    seedLine({ id: 501, order_id: ORDER_ROW, name: "Tinned Tomatoes", category: "Tinned Vegetables" });
    seedLine({ id: 502, order_id: ORDER_ROW, name: "Tinned Tomatoes", category: "" });

    expect(await getLatestOrderLineCategory(session, "Tinned Tomatoes")).toBe("Tinned Vegetables");
  });

  // The NULL half, which Django's own column could not express: this schema's
  // `orderline.category` is nullable (0005) while Django's is a non-null
  // CharField where "" IS the empty sentinel. Both the migrated Postgres rows
  // and any hand-written row can be NULL.
  //
  // Worth its own test because the explicit `category IS NOT NULL` looks
  // redundant -- `NULL != ''` is UNKNOWN, so the != alone already drops the
  // row -- and a reviewer removing it as dead weight would be RIGHT today and
  // wrong the moment the comparison is rewritten (a COALESCE, an `<> ''`
  // against a NULL-safe operator). Both spellings are pinned, so the pair
  // cannot be half-changed.
  it("skips a newer line whose category is NULL", async () => {
    seedLine({ id: 501, order_id: ORDER_ROW, name: "Tinned Tomatoes", category: "Tinned Vegetables" });
    seedLine({ id: 502, order_id: ORDER_ROW, name: "Tinned Tomatoes", category: null });

    expect(await getLatestOrderLineCategory(session, "Tinned Tomatoes")).toBe("Tinned Vegetables");
    // And the SQLite semantic the guard is doubled up against, executed.
    expect(db.prepare("SELECT (NULL != '') AS a, (NULL IS NOT NULL) AS b").get()).toEqual({ a: null, b: 0 });
  });

  it("returns null when every line with that name is uncategorised", async () => {
    seedLine({ id: 501, order_id: ORDER_ROW, name: "Tinned Tomatoes", category: "" });
    seedLine({ id: 502, order_id: ORDER_ROW, name: "Tinned Tomatoes", category: null });

    expect(await getLatestOrderLineCategory(session, "Tinned Tomatoes")).toBeNull();
    expect(await getLatestOrderLineCategory(session, "Never Ordered")).toBeNull();
  });

  // NOT scoped to an order -- Django's filter is on `name` alone, across every
  // order ever placed. That is the whole value of the fallback: it is how a
  // category assigned once, on one food bank's delivery, is reused for every
  // later delivery of the same product without paying for another AI call.
  // A `WHERE order_id = ?` added here "for consistency" would make the
  // fallback almost always miss and quietly triple the categorisation spend.
  it("looks across every order, not just one", async () => {
    seedLine({ id: 601, order_id: OTHER_ORDER_ROW, name: "Tinned Tomatoes", category: "Tinned Vegetables" });

    expect(await getLatestOrderLineCategory(session, "Tinned Tomatoes")).toBe("Tinned Vegetables");
  });

  // Exact name match, like the calories lookup: the name is the join key.
  it("matches the name exactly", async () => {
    seedLine({ id: 501, order_id: ORDER_ROW, name: "Tinned Tomatoes 400g", category: "Tinned Vegetables" });

    expect(await getLatestOrderLineCategory(session, "tinned tomatoes 400g")).toBeNull();
    expect(await getLatestOrderLineCategory(session, "Tinned Tomatoes")).toBeNull();
  });
});

// ===========================================================================
// getLatestNeedLineCategory -- the second fallback, orders.py:259:
//   FoodbankChangeLine.objects.filter(item=self.name).exclude(category="")
//                             .latest("created")
// ===========================================================================
describe("getLatestNeedLineCategory", () => {
  // `.latest("created")`, NOT `.latest("id")` -- a different column from the
  // fallback above, and the two disagree here on purpose: ids ascend in
  // insertion order while `created` is the need's own timestamp, which is
  // backfilled and imported out of order. Seeded so `ORDER BY id DESC` (the
  // copy-paste mutant from the function directly above it in the file) gives a
  // different answer.
  it("returns the category of the most recently CREATED need line, not the highest id", async () => {
    seedNeedLine({ id: 701, item: "Tinned Tomatoes", category: "Tinned Vegetables", created: "2026-09-03 08:00:00.000000" });
    seedNeedLine({ id: 702, item: "Tinned Tomatoes", category: "Sauces", created: "2026-08-01 08:00:00.000000" });

    expect(await getLatestNeedLineCategory(session, "Tinned Tomatoes")).toBe("Tinned Vegetables");
  });

  // `.exclude(category="")`. Unlike orderline, foodbankchangeline.category is
  // NOT NULL (0003), which is why this query has no NULL guard and the one
  // above does -- the asymmetry is deliberate and matches the two schemas.
  it("skips a newer need line whose category is the empty string", async () => {
    seedNeedLine({ id: 701, item: "Tinned Tomatoes", category: "Tinned Vegetables", created: "2026-08-01 08:00:00.000000" });
    seedNeedLine({ id: 702, item: "Tinned Tomatoes", category: "", created: "2026-09-03 08:00:00.000000" });

    expect(await getLatestNeedLineCategory(session, "Tinned Tomatoes")).toBe("Tinned Vegetables");
  });

  // The column really is NOT NULL, so the missing guard is a fact about the
  // schema rather than an omission. Recorded here so that a migration making
  // it nullable fails a test instead of silently letting NULLs through --
  // where `category != ''` would drop them anyway, but a rewritten comparison
  // might not.
  it("cannot see a NULL category, because the column forbids one", () => {
    expect(() => seedNeedLine({ id: 703, item: "Tinned Tomatoes", category: null as unknown as string, created: LATER })).toThrow(/NOT NULL/);
  });

  // No filter on `type`, matching Django -- FoodbankChangeLine rows are
  // 'need' or 'excess' and the queryset filters on `item` alone. An 'excess'
  // line is still evidence of what category that product belongs to, so the
  // newest one wins whichever it is.
  it("counts an excess line as well as a need line", async () => {
    seedNeedLine({ id: 701, item: "Tinned Tomatoes", category: "Sauces", created: "2026-08-01 08:00:00.000000" });
    seedNeedLine({ id: 702, item: "Tinned Tomatoes", category: "Tinned Vegetables", created: "2026-09-03 08:00:00.000000", type: "excess" });

    expect(await getLatestNeedLineCategory(session, "Tinned Tomatoes")).toBe("Tinned Vegetables");
  });

  // THE 0022 SCAR AGAIN, on the column this function orders by. `created` is
  // TEXT compared byte-wise, so a row written in JavaScript's ISO shape beats
  // every same-day Django row regardless of the real time -- and
  // foodbankchangeline.created is one of the columns 0022 had to rewrite (25
  // rows). Pinned as current behaviour: the fix is at the write site, and a
  // test asserting the wish would sit red forever.
  it("sorts an ISO-shaped created above every same-day Django one", async () => {
    seedNeedLine({ id: 701, item: "Tinned Tomatoes", category: "Tinned Vegetables", created: "2026-09-05 20:00:00.000000" });
    seedNeedLine({ id: 702, item: "Tinned Tomatoes", category: "Sauces", created: "2026-09-05T08:00:00.000Z" });

    // The 08:00 row wins over the 20:00 row twelve hours after it.
    expect(await getLatestNeedLineCategory(session, "Tinned Tomatoes")).toBe("Sauces");
  });

  // The column is `item` here and `name` on orderline -- two different spellings
  // of the same product string, which is exactly the kind of thing a
  // copy-paste between these two adjacent functions gets wrong. The match is
  // exact, and a line for a different product must not answer.
  it("matches on `item` exactly, and does not answer for another product", async () => {
    seedNeedLine({ id: 701, item: "Tinned Tomatoes", category: "Tinned Vegetables", created: LATER });

    expect(await getLatestNeedLineCategory(session, "tinned tomatoes")).toBeNull();
    expect(await getLatestNeedLineCategory(session, "Long Grain Rice")).toBeNull();
  });

  it("returns null when nothing has ever been categorised under that item", async () => {
    expect(await getLatestNeedLineCategory(session, "Tinned Tomatoes")).toBeNull();
  });
});

// ===========================================================================
// The two paths end to end, because the module's whole design is a split that
// no single function can demonstrate: the site Worker writes the row with
// zeroed aggregates and the jobs Worker fills them in later. A regression in
// how those halves meet -- the job reading a different row than the form
// wrote, the aggregates landing on the wrong order -- would pass every test
// above.
// ===========================================================================
describe("the site-then-jobs split, end to end", () => {
  it("carries a new assigned order from the form through the queue job", async () => {
    freezeClock();
    seedFoodbank({ id: SALISBURY, name: "Salisbury Foodbank", slug: "salisbury", last_order: null });
    insert("orderitem", { id: 11, name: "Tinned Tomatoes 400g", slug: "tinned-tomatoes-400g", calories: 32 });

    // --- site Worker (orderForm.ts) ---
    const orderId = `gf-salisbury-${slugifyProvider("Sainsbury's")}-2026-09-05`;
    expect(orderId).toBe("gf-salisbury-sainsburys-2026-09-05");
    expect(await findConflictingOrder(session, { foodbankId: SALISBURY, deliveryDate: "2026-09-05", deliveryProvider: "Sainsbury's" })).toBeNull();

    const saved = await upsertOrder(session, {
      orderId,
      foodbankId: SALISBURY,
      itemsText: "4 x Tinned Tomatoes 400g",
      needId: null,
      orderGroupId: null,
      country: "England",
      sourceUrl: null,
      deliveryDate: "2026-09-05",
      deliveryHour: 14,
      deliveryDatetime: deliveryDatetime("2026-09-05", 14),
      deliveryProvider: "Sainsbury's",
      deliveryProviderId: null,
      actualCost: null,
    });
    await recomputeFoodbankLastOrder(session, SALISBURY);

    // The window the order page's job banner exists for: a real order that
    // legitimately reads as zero of everything.
    expect(readRow("orders", saved.id)).toMatchObject({ weight: 0, calories: 0, cost: 0, no_lines: 0, no_items: 0 });
    expect(readRow("foodbank", SALISBURY).last_order).toBe("2026-09-05");

    // --- jobs Worker (adminJobs/orderLines.ts) ---
    const order = (await getOrderForLineParse(session, saved.id))!;
    expect(order.items_text).toBe("4 x Tinned Tomatoes 400g");

    const per100g = await getOrderItemCalories(session, "Tinned Tomatoes 400g");
    const calories = Math.trunc((per100g ?? 0) * (400 / 100) * 4);
    const category = (await getLatestOrderLineCategory(session, "Tinned Tomatoes 400g")) ?? (await getLatestNeedLineCategory(session, "Tinned Tomatoes 400g")) ?? "";

    await deleteOrderLines(session, order.id);
    await insertOrderLines(session, order.id, order.delivery_date, [
      { name: "Tinned Tomatoes 400g", quantity: 4, itemCost: 89, lineCost: 356, weight: 1600, calories, category, group: "" },
    ]);
    await setOrderAggregates(session, order.id, { weight: 1600, calories, cost: 356, noLines: 1, noItems: 4 });

    expect(readRow("orders", saved.id)).toMatchObject({ weight: 1600, calories: 512, cost: 356, no_lines: 1, no_items: 4 });
    expect(await getOrderLinesByWeight(session, saved.id)).toEqual([{ name: "Tinned Tomatoes 400g", quantity: 4, weight: 1600 }]);
    // The line the job just wrote is now the answer the NEXT order's category
    // fallback finds -- which is the whole point of the fallback, and only
    // works because insertOrderLines wrote "" rather than skipping the column.
    expect(await getLatestOrderLineCategory(session, "Tinned Tomatoes 400g")).toBeNull();
  });

  // The unassigned path, whose order_id cannot be built until the insert has
  // produced a primary key -- and which, per orders.py:207's `is_new` gate,
  // keeps that id forever afterwards.
  it("stamps a new unassigned order's real id from its primary key, and freezes it on edit", async () => {
    freezeClock();

    const created = await upsertOrder(session, {
      orderId: "temp-order-6a3f9c2e-0000-4000-8000-000000000000",
      foodbankId: null,
      itemsText: "1 x Nappies",
      needId: null,
      orderGroupId: null,
      country: "",
      sourceUrl: null,
      deliveryDate: "2026-09-05",
      deliveryHour: 14,
      deliveryDatetime: deliveryDatetime("2026-09-05", 14),
      deliveryProvider: "Tesco",
      deliveryProviderId: null,
      actualCost: null,
    });
    const realId = `gf-unassigned-${created.id}-${slugifyProvider("Tesco")}-2026-09-05`;
    await setOrderId(session, created.id, realId);

    const reloaded = (await getOrderForEdit(session, realId))!;
    expect(reloaded.id).toBe(created.id);

    // The edit. orderForm.ts:322-326: neither the assigned branch nor the
    // temp-order branch fires, so the id it saves under is the one it already
    // has -- and the admin URL survives.
    await upsertOrder(
      session,
      {
        orderId: reloaded.order_id,
        foodbankId: null,
        itemsText: "2 x Nappies",
        needId: null,
        orderGroupId: null,
        country: "",
        sourceUrl: null,
        deliveryDate: "2026-09-05",
        deliveryHour: 14,
        deliveryDatetime: deliveryDatetime("2026-09-05", 14),
        deliveryProvider: "Tesco",
        deliveryProviderId: null,
        actualCost: null,
      },
      reloaded.id,
    );

    expect((await getOrderForEdit(session, realId))!.items_text).toBe("2 x Nappies");
  });
});
