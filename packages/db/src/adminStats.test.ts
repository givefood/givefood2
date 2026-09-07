import { beforeEach, describe, expect, it } from "vitest";
import { getQuarterStats, getEditStats, getOrderStats, getSubscriberStats, getSubscriberSignupRows, getNeedStats } from "./adminStats";
import type { Session } from "./types";

// The six Settings-page stats views (gfadmin/views.py:2339-2535), and the one
// tier in this codebase where a wrong answer is COMPLETELY SILENT. Every
// function here returns a number. A dropped predicate, a swapped column, a
// `>` where a `>=` belongs, an INNER where the view has a LEFT -- none of them
// raises, none of them logs, and the admin page renders a plausible figure
// that is simply wrong. Migration 0019 broke four queries in exactly this way
// and nobody noticed until /dashboard/beautybanks/ was measured.
//
// So this file runs the REAL SQL against a REAL in-memory SQLite seeded from
// the REAL DDL in packages/db/migrations/, including the foodbanklocation_full
// VIEW that getEditStats reads. A fake session answering canned rows would
// test nothing at all: SQL is the entire content of this module, and a
// hand-built stand-in row for a view makes the test circular -- the view's own
// join is one of the things that can be wrong.
//
// MUTATION-TESTED (TESTING.md's convention), twice. SEVENTY-NINE deliberate
// breakages were applied to a scratchpad copy of adminStats.ts and the suite
// re-run against each: swapped batch slots, an INNER JOIN in place of the
// view, a dropped `confirmed` filter, a misspelt channel label, a stray
// is_closed predicate, MIN/MAX transposed, `= 1` loosened to `IS NOT 0`,
// COUNT(*) narrowed to COUNT(<nullable column>), each of the four date bounds
// bound to its neighbour's slot in turn, each WHERE clause dropped on its own,
// a first-row-only return in place of every row, a widened SELECT, a stray
// DISTINCT, and so on. Seventy-two failed as they should.
//
// EIGHT SURVIVED, and the split between them is the useful part:
//
//   * SEVEN are EQUIVALENT mutants -- rewrites this engine genuinely cannot
//     tell apart, not gaps. `>=`/`>` and `<`/`<=` against a bare-date bound;
//     dropping any or all of the COALESCEs (the `?? 0` mapping zeroes it
//     anyway); `MAX(edited)` rewritten as `ORDER BY edited DESC LIMIT 1`
//     (SQLite sorts NULLs last on DESC, so only Postgres shows the
//     difference); and reading `foodbanklocation` in place of
//     `foodbanklocation_full` (the view LEFT JOINs on an INTEGER PRIMARY KEY,
//     so it can neither drop a row nor multiply one, and the COUNT is
//     identical). Each is written into the test it turned up in, as a
//     measurement rather than a comment that overclaims -- see the
//     boundary-operator note in getQuarterStats, the COALESCE notes on both
//     empty-table tests, and the NULL-sort and base-table notes in
//     getEditStats.
//
//   * ONE was a REAL HOLE, found by the adversarial re-review and now closed:
//     every signup-graph test had seeded rows whose (channel, created) pairs
//     were all distinct, so `UNION ALL` -> `UNION` passed the lot. See
//     getSubscriberSignupRows' duplicate-sign-ups test.
//
// WHY THE SUPPRESSED IMPORT. packages/db typechecks with
// `"types": ["@cloudflare/workers-types"]` and has no @types/node, so tsc
// reports TS2591 on the `node:sqlite` specifier (locationsAdmin.test.ts:26-30
// records that as the reason its own engine-level half was pushed out to
// workers/site, where the types exist). `@ts-ignore` rather than
// `@ts-expect-error` deliberately: if @types/node is ever added to this
// package, an @ts-expect-error would then itself be the error, and a suite
// that breaks when the tooling is FIXED is worse than one line of suppression.
// Nothing else in this file is unchecked -- SqliteDatabase below gives the
// handful of methods used here real types.
// @ts-ignore -- no @types/node under this package's tsconfig; vitest runs in node, where this module is real
import { DatabaseSync } from "node:sqlite";

// The D1 100-bound-parameter statement limit has nothing to bite on in this
// module and there is deliberately no boundary test for it: every statement
// here binds either nothing or exactly two date strings, and none of them
// builds a variable-length IN list. If one ever does, that is the moment to
// add the at-and-over-100 cases the rest of the package needs.

// ===========================================================================
// SCHEMA
// ===========================================================================
// Column-for-column from packages/db/migrations/, at the CURRENT migration
// state -- 0001_core.sql / 0003_homepage_data.sql / 0004_subscribers.sql /
// 0005_orders_and_charity.sql / 0008_needcheck.sql / 0020_whatsappsubscriber
// .sql, each as amended by 0019_drop_foodbank_cache.sql (which dropped the
// `foodbank_*` cached copies from the child tables and replaced them with the
// views).
//
// Transcribed from the migrations rather than from the TypeScript types on
// purpose: a disagreement between the two is precisely what this file is meant
// to catch, and a schema derived from the interfaces could not catch it. The
// NOT NULL / NULLABLE split is load-bearing and carried over exactly --
// `foodbank.no_donation_points` and `foodbanklocation.is_donation_point` are
// NULLABLE in D1 though the Django model declares otherwise (0001_core.sql:38,
// :71), and the two SUM(CASE WHEN ...) expressions in getEditStats exist
// entirely because of that.
//
// The indexes are here because the module's comments claim particular queries
// are index-only scans of them (adminStats.ts:154-156 for
// discrepancy_status_created_idx, :297-299 for fcl_type_idx). They cost
// nothing at this size and a migration that renamed one would show up here.
const SCHEMA = `
CREATE TABLE foodbank (
  id INTEGER PRIMARY KEY,
  uuid TEXT NOT NULL,
  name TEXT NOT NULL, alt_name TEXT, slug TEXT NOT NULL,
  address TEXT NOT NULL,
  postcode TEXT NOT NULL, country TEXT NOT NULL,
  lat_lng TEXT NOT NULL,
  latitude REAL, longitude REAL,
  delivery_address TEXT, delivery_lat_lng TEXT,
  network TEXT, network_id TEXT, notes TEXT,
  charity_number TEXT, charity_just_foodbank INTEGER NOT NULL,
  charity_id TEXT, charity_name TEXT, charity_type TEXT,
  charity_reg_date TEXT, charity_postcode TEXT, charity_website TEXT,
  charity_objectives TEXT, charity_purpose TEXT,
  facebook_page TEXT, bankuet_slug TEXT, fsa_id TEXT,
  contact_email TEXT NOT NULL, notification_email TEXT,
  phone_number TEXT, secondary_phone_number TEXT, delivery_phone_number TEXT,
  url TEXT NOT NULL, shopping_list_url TEXT NOT NULL,
  rss_url TEXT, news_url TEXT, donation_points_url TEXT,
  locations_url TEXT, contacts_url TEXT,
  place_id TEXT, plus_code_compound TEXT, plus_code_global TEXT,
  place_has_photo INTEGER,
  county TEXT, district TEXT, ward TEXT, lsoa TEXT, msoa TEXT,
  parliamentary_constituency_id INTEGER,
  parliamentary_constituency_name TEXT, parliamentary_constituency_slug TEXT,
  mp TEXT, mp_party TEXT, mp_parl_id INTEGER,
  address_is_administrative INTEGER NOT NULL,
  is_closed INTEGER NOT NULL, is_school INTEGER,
  no_locations INTEGER NOT NULL, no_donation_points INTEGER,
  days_between_needs INTEGER NOT NULL, footprint INTEGER,
  bounds_north REAL, bounds_south REAL, bounds_east REAL, bounds_west REAL,
  latest_need_id INTEGER,
  last_order TEXT, last_need TEXT, last_rfi TEXT, last_crawl TEXT,
  last_social_media_check TEXT, last_discrepancy_check TEXT,
  last_need_check TEXT, last_charity_check TEXT,
  created TEXT NOT NULL, modified TEXT NOT NULL, edited TEXT
);
CREATE UNIQUE INDEX foodbank_name_uniq  ON foodbank(name);
CREATE UNIQUE INDEX foodbank_slug_uniq  ON foodbank(slug);
CREATE INDEX foodbank_edited_idx        ON foodbank(edited);

CREATE TABLE foodbanklocation (
  id INTEGER PRIMARY KEY, uuid TEXT NOT NULL,
  foodbank_id INTEGER NOT NULL,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  address TEXT, postcode TEXT,
  country TEXT NOT NULL, lat_lng TEXT NOT NULL, latitude REAL, longitude REAL,
  place_id TEXT, plus_code_compound TEXT, plus_code_global TEXT, place_has_photo INTEGER,
  county TEXT, district TEXT, ward TEXT, lsoa TEXT, msoa TEXT,
  parliamentary_constituency_id INTEGER,
  parliamentary_constituency_name TEXT, parliamentary_constituency_slug TEXT,
  mp TEXT, mp_party TEXT, mp_parl_id INTEGER,
  is_closed INTEGER NOT NULL,
  is_donation_point INTEGER, is_mobile INTEGER,
  boundary_geojson TEXT,
  phone_number TEXT, email TEXT,
  modified TEXT NOT NULL, edited TEXT
);
CREATE UNIQUE INDEX loc_fb_name_uniq ON foodbanklocation(foodbank_id, name);

CREATE TABLE foodbankdonationpoint (
  id INTEGER PRIMARY KEY, uuid TEXT NOT NULL,
  foodbank_id INTEGER NOT NULL,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  address TEXT NOT NULL, postcode TEXT NOT NULL, country TEXT,
  lat_lng TEXT NOT NULL, latitude REAL, longitude REAL,
  place_id TEXT, plus_code_compound TEXT, plus_code_global TEXT, place_has_photo INTEGER,
  county TEXT, district TEXT, ward TEXT, lsoa TEXT, msoa TEXT,
  parliamentary_constituency_id INTEGER,
  parliamentary_constituency_name TEXT, parliamentary_constituency_slug TEXT,
  mp TEXT, mp_party TEXT, mp_parl_id INTEGER,
  is_closed INTEGER NOT NULL, in_store_only INTEGER NOT NULL,
  phone_number TEXT, url TEXT, opening_hours TEXT,
  wheelchair_accessible INTEGER,
  company TEXT, company_slug TEXT, store_id TEXT, notes TEXT,
  modified TEXT NOT NULL, edited TEXT
);
CREATE UNIQUE INDEX dp_fb_name_uniq ON foodbankdonationpoint(foodbank_id, name);

CREATE TABLE foodbankchange (
  id INTEGER PRIMARY KEY,
  need_id TEXT NOT NULL,
  foodbank_id INTEGER,
  distill_id TEXT, name TEXT, uri TEXT,
  change_text TEXT NOT NULL,
  change_text_original TEXT,
  excess_change_text TEXT, excess_change_text_original TEXT,
  published INTEGER NOT NULL DEFAULT 0,
  nonpertinent INTEGER,
  is_categorised INTEGER,
  notified TEXT, input_method TEXT NOT NULL,
  created TEXT NOT NULL, modified TEXT NOT NULL
);
CREATE UNIQUE INDEX need_need_id_uniq ON foodbankchange(need_id);

CREATE TABLE foodbankchangeline (
  id INTEGER PRIMARY KEY,
  need_id INTEGER NOT NULL, foodbank_id INTEGER NOT NULL,
  item TEXT NOT NULL, type TEXT NOT NULL, category TEXT NOT NULL, group_name TEXT NOT NULL,
  created TEXT NOT NULL
);
CREATE INDEX fcl_type_idx    ON foodbankchangeline(type);
CREATE INDEX fcl_created_idx ON foodbankchangeline(created);

CREATE TABLE foodbankdiscrepancy (
  id INTEGER PRIMARY KEY,
  foodbank_id INTEGER,
  need_id INTEGER,
  url TEXT,
  discrepancy_type TEXT NOT NULL,
  discrepancy_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'New',
  created TEXT NOT NULL,
  modified TEXT NOT NULL
);
CREATE INDEX discrepancy_status_created_idx ON foodbankdiscrepancy(status, created DESC);

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

CREATE TABLE foodbanksubscriber (
  id INTEGER PRIMARY KEY,
  created TEXT NOT NULL, last_contacted TEXT,
  foodbank_id INTEGER NOT NULL,
  email TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0,
  sub_key TEXT NOT NULL, unsub_key TEXT NOT NULL
);
CREATE UNIQUE INDEX sub_email_fb_uniq ON foodbanksubscriber(email, foodbank_id);
CREATE UNIQUE INDEX sub_key_idx       ON foodbanksubscriber(sub_key);
CREATE UNIQUE INDEX unsub_key_idx     ON foodbanksubscriber(unsub_key);

CREATE TABLE webpushsubscription (
  id INTEGER PRIMARY KEY,
  created TEXT NOT NULL,
  foodbank_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
  browser TEXT
);
CREATE UNIQUE INDEX webpush_fb_endpoint_uniq ON webpushsubscription(foodbank_id, endpoint);

CREATE TABLE mobilesubscriber (
  id INTEGER PRIMARY KEY,
  created TEXT NOT NULL,
  device_id TEXT NOT NULL, platform TEXT NOT NULL,
  timezone TEXT, locale TEXT, app_version TEXT, os_version TEXT,
  device_model TEXT, sub_type TEXT,
  foodbank_id INTEGER NOT NULL, donationpoint_id INTEGER
);

CREATE TABLE whatsappsubscriber (
  id            INTEGER PRIMARY KEY,
  phone_number  TEXT NOT NULL,
  foodbank_id   INTEGER,
  created       TEXT,
  last_notified TEXT
);

CREATE VIEW foodbanklocation_full AS
  SELECT l.*,
         f.name          AS foodbank_name,
         f.slug          AS foodbank_slug,
         f.network       AS foodbank_network,
         f.phone_number  AS foodbank_phone_number,
         f.contact_email AS foodbank_email
    FROM foodbanklocation l
    LEFT JOIN foodbank f ON f.id = l.foodbank_id;
`;

// ===========================================================================
// HARNESS
// ===========================================================================

type Bindable = null | number | bigint | string;

interface SqliteStatement {
  run(...params: Bindable[]): unknown;
  all(...params: Bindable[]): Array<Record<string, unknown>>;
  get(...params: Bindable[]): Record<string, unknown> | undefined;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

// The same adapter shape as workers/site/src/routes/admin/foodbankLocation
// .test.ts, plus the `batch` this module needs and that one does not. Nothing
// here interprets the SQL -- it hands the statement straight to SQLite, which
// is the whole point.
//
// batch() RUNS THE STATEMENTS IN ORDER AND RETURNS ONE RESULT PER INPUT, in
// that order, because getQuarterStats/getEditStats/getNeedStats index straight
// into the returned array (`results[2]!.results[0]`). That indexing is the
// contract, and a batch that reordered or coalesced results would hand the
// subscriber count to `itemsFound` without erroring. Sequential rather than
// Promise.all so the ordering is a property of the harness, not of the
// scheduler.
function d1Session(database: SqliteDatabase): Session {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (database.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: database.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      database.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return {
    prepare: (sql: string) => statement(sql, []),
    batch: async (statements: Array<{ all: () => Promise<unknown> }>) => {
      const out: unknown[] = [];
      for (const each of statements) out.push(await each.all());
      return out;
    },
    getBookmark: () => null,
  } as unknown as Session;
}

let db: SqliteDatabase;
let session: Session;
// One counter across every table, so no two seeded rows anywhere share an id.
// A query that joined on the wrong column would otherwise stand a good chance
// of accidentally matching.
let nextId = 0;

beforeEach(() => {
  db = new DatabaseSync(":memory:") as SqliteDatabase;
  db.exec(SCHEMA);
  session = d1Session(db);
  nextId = 0;
});

function insert(table: string, row: Record<string, Bindable>): number {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(
    ...columns.map((column) => row[column] as Bindable),
  );
  return row.id as number;
}

// A NO-OP THAT EARNS ITS KEEP. Every timestamp in these fixtures is in
// DJANGO'S shape -- "YYYY-MM-DD HH:MM:SS.ffffff", what str(datetime) produces
// and what migration 0022 normalised the whole database to. D1 stores these
// as TEXT and SQLite compares them lexicographically, so the shape is not
// cosmetic: 'T' is 0x54 and ' ' is 0x20, and mixing the two shapes in one
// column is what 0022 exists to undo.
//
// Wrapping the normal shape means the handful of literals deliberately left
// in the OLD `toISOString()` form are the ONLY bare timestamps in the
// fixtures -- they stand out as the anomalies they are, rather than being one
// punctuation mark different from their neighbours. Four of them pin that
// date-only bounds cope with both shapes; the other two pin the hazard of
// mixing them under an ORDER BY and a MAX.
const PY = (value: string) => value;

function seedFoodbank(row: Partial<Record<string, Bindable>> = {}): number {
  const n = (nextId += 1);
  return insert("foodbank", {
    id: n,
    uuid: `fb${n}uuid`,
    name: `Food Bank ${n}`,
    slug: `food-bank-${n}`,
    address: "1 High Street",
    postcode: "SP1 1AA",
    country: "England",
    lat_lng: "51.0688,-1.7945",
    charity_just_foodbank: 0,
    contact_email: `fb${n}@example.org`,
    url: `https://example.org/${n}/`,
    shopping_list_url: `https://example.org/${n}/list/`,
    address_is_administrative: 0,
    is_closed: 0,
    no_locations: 0,
    days_between_needs: 14,
    created: PY("2020-01-01 00:00:00.000000"),
    modified: PY("2020-01-01 00:00:00.000000"),
    ...row,
  });
}

function seedLocation(row: Partial<Record<string, Bindable>> = {}): number {
  const n = (nextId += 1);
  return insert("foodbanklocation", {
    id: n,
    uuid: `loc${n}uuid`,
    foodbank_id: 0,
    name: `Location ${n}`,
    slug: `location-${n}`,
    country: "England",
    lat_lng: "51.0688,-1.7945",
    is_closed: 0,
    modified: PY("2020-01-01 00:00:00.000000"),
    ...row,
  });
}

function seedDonationPoint(row: Partial<Record<string, Bindable>> = {}): number {
  const n = (nextId += 1);
  return insert("foodbankdonationpoint", {
    id: n,
    uuid: `dp${n}uuid`,
    foodbank_id: 0,
    name: `Donation Point ${n}`,
    slug: `donation-point-${n}`,
    address: "2 Low Street",
    postcode: "SP2 2BB",
    lat_lng: "51.0688,-1.7945",
    is_closed: 0,
    in_store_only: 0,
    modified: PY("2020-01-01 00:00:00.000000"),
    ...row,
  });
}

function seedOrder(row: Partial<Record<string, Bindable>> = {}): number {
  const n = (nextId += 1);
  return insert("orders", {
    id: n,
    order_id: `order-${n}`,
    items_text: "Tinned soup",
    country: "England",
    created: PY("2026-01-01 00:00:00.000000"),
    modified: PY("2026-01-01 00:00:00.000000"),
    delivery_date: "2026-01-02",
    delivery_hour: 9,
    delivery_datetime: PY("2026-01-02 09:00:00.000000"),
    weight: 0,
    calories: 0,
    cost: 0,
    no_lines: 1,
    no_items: 0,
    ...row,
  });
}

function seedSubscriber(row: Partial<Record<string, Bindable>> = {}): number {
  const n = (nextId += 1);
  return insert("foodbanksubscriber", {
    id: n,
    created: PY("2026-01-01 00:00:00.000000"),
    foodbank_id: 1,
    email: `subscriber${n}@example.org`,
    confirmed: 1,
    sub_key: `sub${n}`,
    unsub_key: `unsub${n}`,
    ...row,
  });
}

function seedWebPush(row: Partial<Record<string, Bindable>> = {}): number {
  const n = (nextId += 1);
  return insert("webpushsubscription", {
    id: n,
    created: PY("2026-01-01 00:00:00.000000"),
    foodbank_id: 1,
    endpoint: `https://push.example.org/${n}`,
    p256dh: "key",
    auth: "auth",
    ...row,
  });
}

function seedMobile(row: Partial<Record<string, Bindable>> = {}): number {
  const n = (nextId += 1);
  return insert("mobilesubscriber", {
    id: n,
    created: PY("2026-01-01 00:00:00.000000"),
    device_id: `device-${n}`,
    platform: "ios",
    foodbank_id: 1,
    ...row,
  });
}

function seedChange(row: Partial<Record<string, Bindable>> = {}): number {
  const n = (nextId += 1);
  return insert("foodbankchange", {
    id: n,
    need_id: `need${n}`,
    foodbank_id: 1,
    change_text: "Beans",
    published: 1,
    input_method: "scrape",
    created: PY("2026-01-01 00:00:00.000000"),
    modified: PY("2026-01-01 00:00:00.000000"),
    ...row,
  });
}

function seedChangeLine(row: Partial<Record<string, Bindable>> = {}): number {
  const n = (nextId += 1);
  return insert("foodbankchangeline", {
    id: n,
    need_id: 1,
    foodbank_id: 1,
    item: `Item ${n}`,
    type: "need",
    category: "Tinned Food",
    group_name: "Food",
    created: PY("2026-01-01 00:00:00.000000"),
    ...row,
  });
}

function seedDiscrepancy(status: string, count: number): void {
  for (let i = 0; i < count; i += 1) {
    const n = (nextId += 1);
    insert("foodbankdiscrepancy", {
      id: n,
      foodbank_id: 1,
      discrepancy_type: "Phone number",
      discrepancy_text: "Mismatch",
      status,
      created: PY("2026-01-01 00:00:00.000000"),
      modified: PY("2026-01-01 00:00:00.000000"),
    });
  }
}

// ===========================================================================
// getQuarterStats
// ===========================================================================
// gfadmin/views.py:2339-2386. Q1 2026 as the route builds it: the admin typed
// 2026-01-01 to 2026-03-31, and routes/admin/stats.ts:110 turned the inclusive
// end date into the exclusive bound below.
const Q1_START = "2026-01-01";
const Q1_END_EXCLUSIVE = "2026-04-01";

describe("getQuarterStats", () => {
  // Five orders, three of them inside the window, and the two outside it are
  // one MILLISECOND out on either side. The out-of-range pair carry
  // deliberately huge values, so that if they ever do leak in, every figure on
  // the page moves by an amount no one could mistake for a rounding
  // difference.
  function seedQuarterOrders(): void {
    seedOrder({ created: PY("2025-12-31 23:59:59.999000"), weight: 900000, no_items: 900, calories: 900000, cost: 900000 });
    seedOrder({ created: PY("2026-01-01 00:00:00.000000"), weight: 1000, no_items: 7, calories: 2500, cost: 1234 });
    seedOrder({ created: PY("2026-02-15 12:34:56.789000"), weight: 2000, no_items: 11, calories: 5000, cost: 2345 });
    seedOrder({ created: PY("2026-03-31 23:59:59.999000"), weight: 4000, no_items: 13, calories: 9000, cost: 3456 });
    seedOrder({ created: PY("2026-04-01 00:00:00.000000"), weight: 500000, no_items: 500, calories: 500000, cost: 500000 });
  }

  // The window is half-open on WHOLE DAYS: everything dated on the start date
  // counts, nothing dated on the exclusive end date does. The route builds
  // that upper bound itself by adding 24 hours to the date the admin typed
  // (stats.ts:110), so a day's slip in either bound is a live possibility and
  // it moves every figure on the page.
  //
  // WHAT THIS TEST CANNOT CATCH, measured rather than assumed: rewriting
  // `>=` to `>` and `<` to `<=` leaves it green, and no fixture could change
  // that. The bounds are BARE DATES and every stored value is a full
  // timestamp, so "2026-01-01 00:00:00.000000" is strictly greater than
  // "2026-01-01" (a prefix sorts first) and "2026-04-01 00:00:00.000000" is
  // strictly greater than "2026-04-01" whichever operator is used -- the two
  // spellings are indistinguishable for any row a writer can produce. The
  // second assertion runs that equivalence instead of claiming it. The
  // mutants this DOES kill were also run: a dropped predicate, and the two
  // dates bound to each other's slot.
  it("counts the whole of the start date and none of the exclusive end date", async () => {
    seedQuarterOrders();

    const stats = await getQuarterStats(session, Q1_START, Q1_END_EXCLUSIVE);

    expect(stats.deliveries).toBe(3);
    // Named individually rather than as a total, so that "the boundary row
    // leaked in" and "a column is being summed twice" fail differently.
    expect(stats.weightGrams).toBe(7000);
    expect(stats.items).toBe(31);
    expect(stats.calories).toBe(16500);
    expect(stats.costPence).toBe(7035);

    const strictBounds = db
      .prepare("SELECT COUNT(*) AS n FROM orders WHERE created > ?1 AND created <= ?2")
      .get(Q1_START, Q1_END_EXCLUSIVE) as { n: number };
    expect(strictBounds.n).toBe(3); // same three rows: the operators do not distinguish anything here
  });

  // Four different columns, four different magnitudes, so that no swap between
  // them can survive. `weight` and `calories` are the pair most at risk --
  // adjacent in the SELECT, adjacent in the interface, and both large -- and
  // the route divides one by 1000 and prints the other bare, so crossing them
  // would produce a Weight of "16.5 kg" for a quarter and nothing would look
  // obviously broken.
  it("sums each order column into its own field", async () => {
    seedOrder({ created: PY("2026-02-01 00:00:00.000000"), weight: 100000, no_items: 3, calories: 250000, cost: 4321 });

    const stats = await getQuarterStats(session, Q1_START, Q1_END_EXCLUSIVE);

    expect(stats).toMatchObject({ deliveries: 1, weightGrams: 100000, items: 3, calories: 250000, costPence: 4321 });
  });

  // SUM over zero rows is NULL in SQLite, and Django's own order_stats()
  // crashes on exactly that (views.py:2433 divides the None by 1000). An
  // empty quarter must render "0.00 kg", not "NaN kg".
  //
  // WHICH LAYER ACTUALLY DELIVERS THAT, measured: BOTH, independently.
  // adminStats.ts:41-45 credits the COALESCE, but stripping every COALESCE
  // out of the statement leaves this test green, because the mapping's
  // `orders?.weight_g ?? 0` catches a null sum on its own. The COALESCE is
  // not redundant for that reason -- it is what keeps the DECLARED row type
  // (`weight_g: number`) from being a lie at runtime, which is a real thing to
  // preserve -- but it is not load-bearing for the number. So this test pins
  // the CONTRACT, deliberately, rather than either mechanism: whichever way a
  // future rewrite moves the zeroing, an empty quarter must still be zeros.
  it("returns zeros, never nulls, for a quarter with no orders at all", async () => {
    seedQuarterOrders();

    const stats = await getQuarterStats(session, "2027-01-01", "2027-04-01");

    expect(stats).toEqual({
      deliveries: 0,
      weightGrams: 0,
      items: 0,
      calories: 0,
      costPence: 0,
      edits: 0,
      newSubscribers: 0,
      itemsFound: 0,
    });
  });

  // THE BATCH-ORDER TEST. The four statements go out as one batch and the
  // module reads them back by INDEX (results[0..3]); swap two and nothing
  // throws -- the Edits row simply shows the subscriber count. Four different
  // counts from four different tables is the only way that fails.
  it("takes each count from its own table", async () => {
    seedOrder({ created: PY("2026-02-01 00:00:00.000000") });
    seedOrder({ created: PY("2026-02-02 00:00:00.000000") });
    seedOrder({ created: PY("2026-02-03 00:00:00.000000") });
    seedFoodbank({ edited: PY("2026-01-15 10:00:00.000000") });
    seedFoodbank({ edited: PY("2026-03-02 11:11:11.111000") });
    for (let i = 0; i < 5; i += 1) seedSubscriber({ created: PY("2026-02-10 08:00:00.000000") });
    for (let i = 0; i < 4; i += 1) seedChangeLine({ created: PY("2026-02-11 08:00:00.000000") });

    const stats = await getQuarterStats(session, Q1_START, Q1_END_EXCLUSIVE);

    expect(stats.deliveries).toBe(3);
    expect(stats.edits).toBe(2);
    expect(stats.newSubscribers).toBe(5);
    expect(stats.itemsFound).toBe(4);
  });

  // The same window applies to all four tables, and each one has rows outside
  // it. A statement that lost its WHERE clause (or bound the dates to the
  // wrong statement) would report the whole table and read as a very busy
  // quarter.
  it("applies the window to the edits, subscriber and change-line counts too", async () => {
    seedFoodbank({ edited: PY("2025-11-01 10:00:00.000000") });
    seedFoodbank({ edited: PY("2026-02-01 10:00:00.000000") });
    seedFoodbank({ edited: PY("2026-04-01 00:00:00.000000") });
    seedSubscriber({ created: PY("2025-12-31 23:59:59.999000") });
    seedSubscriber({ created: PY("2026-01-01 00:00:00.000000") });
    seedChangeLine({ created: PY("2026-04-01 00:00:00.000000") });
    seedChangeLine({ created: PY("2026-03-31 23:59:59.999000") });

    const stats = await getQuarterStats(session, Q1_START, Q1_END_EXCLUSIVE);

    expect(stats.edits).toBe(1);
    expect(stats.newSubscribers).toBe(1);
    expect(stats.itemsFound).toBe(1);
  });

  // `foodbank.edited` is NULLABLE (0001_core.sql:45) and 0 of 1,071 rows is
  // not a safe assumption -- getEditStats' own comment says Django's "Newest
  // Edit" prints None the moment one food bank has never been edited. A NULL
  // fails `>= ?` under SQLite's three-valued logic, so it is silently absent
  // from Edits, which matches Django's `edited__gte` exactly. Pinned because
  // "count the never-edited ones as 0" is a tempting-looking COALESCE that
  // would quietly inflate every quarter's Edits figure.
  it("does not count a food bank that has never been edited", async () => {
    seedFoodbank({ edited: null });
    seedFoodbank({ edited: PY("2026-02-01 10:00:00.000000") });

    expect((await getQuarterStats(session, Q1_START, Q1_END_EXCLUSIVE)).edits).toBe(1);
  });

  // adminStats.ts:60-61: views.py:2364 has no `confirmed` filter, so this
  // counts sign-ups whether or not the double-opt-in email was ever clicked.
  // getSubscriberStats on the very same table DOES split on confirmed, so the
  // difference between the two is easy to "tidy up" into a bug -- the
  // Subscriptions figure would then only ever count completed opt-ins and
  // every historic quarter's number would change.
  it("counts an unconfirmed sign-up, exactly as Django's unfiltered queryset does", async () => {
    seedSubscriber({ created: PY("2026-02-01 09:00:00.000000"), confirmed: 0 });
    seedSubscriber({ created: PY("2026-02-01 09:00:01.000000"), confirmed: 1 });

    expect((await getQuarterStats(session, Q1_START, Q1_END_EXCLUSIVE)).newSubscribers).toBe(2);
  });

  // adminStats.ts:33-38's claim, executed rather than reasoned about. This
  // database holds two timestamp shapes -- the pg-to-D1 import wrote Django's
  // "YYYY-MM-DD HH:MM:SS.ffffff", and rows the port wrote before migration
  // 0022 hold JavaScript's "YYYY-MM-DDTHH:MM:SS.sssZ". Against a BARE DATE
  // bound both sort the same way, because the date prefix is identical and
  // everything after it only ever makes the string longer (and a prefix sorts
  // first). That is what makes a date-only bound the safe choice here, and it
  // is why the same threshold built with toISOString() would NOT be -- see
  // migration 0022, where an ISO threshold dropped 31 of 46 same-day rows.
  it("bounds both stored timestamp shapes identically, because the bounds are date-only", async () => {
    seedOrder({ created: "2026-01-01T00:00:00.000Z", no_items: 1 }); // first instant, ISO shape
    seedOrder({ created: "2026-03-31T23:00:00.000Z", no_items: 1 }); // last day, ISO shape
    seedOrder({ created: "2025-12-31T23:59:59.999Z", no_items: 1 }); // day before, must not count
    seedOrder({ created: "2026-04-01T00:00:00.000Z", no_items: 1 }); // day after, must not count

    expect((await getQuarterStats(session, Q1_START, Q1_END_EXCLUSIVE)).deliveries).toBe(2);
  });
});

// ===========================================================================
// getEditStats
// ===========================================================================
// gfadmin/views.py:2389-2422. Seven counts, two extremes and a GROUP BY, from
// four tables in one batch.
describe("getEditStats", () => {
  // Six food banks whose three flag columns vary INDEPENDENTLY, so that the
  // seven numbers this function returns are seven DIFFERENT numbers:
  // foodbanks 6, nonAdminAddress 2, withDeliveryAddress 3,
  // fbWithDonationPoints 4, locationDonationPoints 5, donationPoints 7,
  // locations 8. Any two of them crossing wires is then a failure, which a
  // fixture where several counts happened to coincide could never show.
  //
  //  fb | address_is_administrative | delivery_address | no_donation_points
  //   1 |            0              |   "1 High St"    |        3
  //   2 |            0              |       ""         |        5
  //   3 |            1              |   "3 Mid St"     |        7
  //   4 |            1              |   "4 Low St"     |        9
  //   5 |            1              |      NULL        |        0
  //   6 |            1              |       ""         |      NULL
  function seedEstate(): { fb1: number; fb2: number; fb3: number; fb5: number } {
    const fb1 = seedFoodbank({
      address_is_administrative: 0,
      delivery_address: "1 High St",
      no_donation_points: 3,
      edited: PY("2026-01-15 10:00:00.000000"),
    });
    const fb2 = seedFoodbank({ address_is_administrative: 0, delivery_address: "", no_donation_points: 5, edited: null });
    const fb3 = seedFoodbank({
      address_is_administrative: 1,
      delivery_address: "3 Mid St",
      no_donation_points: 7,
      edited: PY("2024-06-01 08:30:00.000000"),
    });
    seedFoodbank({
      address_is_administrative: 1,
      delivery_address: "4 Low St",
      no_donation_points: 9,
      edited: PY("2026-03-02 11:11:11.111000"),
    });
    const fb5 = seedFoodbank({
      address_is_administrative: 1,
      delivery_address: null,
      no_donation_points: 0,
      edited: PY("2025-07-19 23:59:59.999000"),
    });
    // Closed, and still counted -- see the is_closed test below.
    seedFoodbank({ address_is_administrative: 1, delivery_address: "", no_donation_points: null, edited: null, is_closed: 1 });

    // Eight locations, five of them donation points. loc7/loc8 are ORPHANS:
    // foodbank_id 999 has no parent row.
    seedLocation({ foodbank_id: fb1, is_donation_point: 1 });
    seedLocation({ foodbank_id: fb1, is_donation_point: 1 });
    seedLocation({ foodbank_id: fb1, is_donation_point: 0 });
    seedLocation({ foodbank_id: fb2, is_donation_point: null });
    seedLocation({ foodbank_id: fb2, is_donation_point: 1 });
    seedLocation({ foodbank_id: fb3, is_donation_point: 1, is_closed: 1 });
    seedLocation({ foodbank_id: 999, is_donation_point: 1 });
    seedLocation({ foodbank_id: 999, is_donation_point: 0 });

    // Seven donation points, one closed, one orphaned.
    seedDonationPoint({ foodbank_id: fb1 });
    seedDonationPoint({ foodbank_id: fb1 });
    seedDonationPoint({ foodbank_id: fb1 });
    seedDonationPoint({ foodbank_id: fb1 });
    seedDonationPoint({ foodbank_id: fb2, is_closed: 1 });
    seedDonationPoint({ foodbank_id: fb3 });
    seedDonationPoint({ foodbank_id: 999 });

    seedDiscrepancy("New", 4);
    seedDiscrepancy("Done", 2);
    seedDiscrepancy("Invalid", 1);

    return { fb1, fb2, fb3, fb5 };
  }

  it("returns each of the seven counts from its own column", async () => {
    seedEstate();

    const stats = await getEditStats(session);

    expect(stats).toMatchObject({
      foodbanks: 6,
      nonAdminAddress: 2,
      withDeliveryAddress: 3,
      fbWithDonationPoints: 4,
      locationDonationPoints: 5,
      donationPoints: 7,
      locations: 8,
    });
  });

  // THE INNER-VS-LEFT KILLER, and the exact shape of the migration-0019
  // regression this whole tier exists for. getEditStats counts locations
  // through the foodbanklocation_full VIEW, which is a LEFT JOIN (0019's own
  // comment: "a LEFT JOIN cannot lose a row either way", and D1 has no foreign
  // keys, so nothing enforces that the parent exists). Two of the eight
  // seeded locations point at a food bank id that is not there; an INNER JOIN
  // in the view would report 6 and never say why.
  //
  // The raw comparison is here rather than only asserted, so the test states
  // the size of the silent loss rather than just a number that happens to be
  // right.
  //
  // WHAT THIS DELIBERATELY DOES NOT CLAIM, measured: swapping
  // `foodbanklocation_full` for the bare `foodbanklocation` table is an
  // EQUIVALENT mutant and survives -- correctly. The view LEFT JOINs on
  // `foodbank.id`, an INTEGER PRIMARY KEY, so it can neither drop a location
  // nor duplicate one, and both counts are identical by construction. It is
  // the JOIN DIRECTION inside the view that can lose rows, which is what the
  // INNER-JOIN comparison below pins; nobody should spend a pass trying to
  // write a fixture that distinguishes the view from its base table.
  it("counts orphaned locations, because the view LEFT JOINs its parent", async () => {
    seedEstate();

    const stats = await getEditStats(session);
    const innerJoin = db
      .prepare("SELECT COUNT(*) AS n FROM foodbanklocation l JOIN foodbank f ON f.id = l.foodbank_id")
      .get() as { n: number };

    expect(stats.locations).toBe(8);
    expect(innerJoin.n).toBe(6); // what an INNER JOIN in the view would silently report
  });

  // The join must not multiply either. Three of the eight locations hang off
  // fb1, and four food banks have no locations at all -- so a view joining in
  // the other direction, or against a non-unique key, changes this number.
  it("counts one row per location, not one per parent", async () => {
    seedEstate();

    const stats = await getEditStats(session);

    expect(stats.locations).toBe(db.prepare("SELECT COUNT(*) AS n FROM foodbanklocation").get()!.n);
    expect(stats.foodbanks).toBe(6);
  });

  // adminStats.ts:100-106, the DELIBERATE PARITY. There is no is_closed filter
  // anywhere in this function: Django counts open and closed alike, because
  // this page answers "how big is the data estate", not "how much is live".
  // adminDashboardStats.ts DOES filter is_closed for the dashboard's edit-age
  // numbers, so the two functions look like each other and must not be made
  // to agree. The fixture has one closed food bank, one closed location and
  // one closed donation point; adding a filter drops all three counts by one.
  it("counts closed food banks, locations and donation points -- Django parity, not an oversight", async () => {
    seedEstate();

    const stats = await getEditStats(session);
    const closed = db.prepare("SELECT COUNT(*) AS n FROM foodbank WHERE is_closed = 1").get() as { n: number };

    expect(closed.n).toBe(1);
    expect(stats.foodbanks).toBe(6);
    expect(stats.locations).toBe(8);
    expect(stats.donationPoints).toBe(7);
    // The closed location is also one of the five donation-point locations, so
    // a filter would move this number too.
    expect(stats.locationDonationPoints).toBe(5);
  });

  // THE DOCUMENTED DIVERGENCE FROM DJANGO, pinned by running BOTH queries.
  // Django's .exclude(delivery_address="") compiles to
  // NOT (delivery_address = '' AND delivery_address IS NOT NULL), which is
  // TRUE for a NULL -- so Django counts every food bank with no delivery
  // address at all as HAVING a delivery donation point. The port follows the
  // model's own per-row rule instead (models/foodbank.py:514, "if
  // self.delivery_address:"), which treats NULL and "" identically as "no".
  // Headline DP therefore reads LOWER here than in Django, deliberately.
  it("treats a NULL delivery address as absent, where Django counted it as present", async () => {
    seedEstate();

    const stats = await getEditStats(session);
    const django = db
      .prepare("SELECT COUNT(*) AS n FROM foodbank WHERE NOT (delivery_address = '' AND delivery_address IS NOT NULL)")
      .get() as { n: number };

    expect(stats.withDeliveryAddress).toBe(3); // "1 High St", "3 Mid St", "4 Low St"
    expect(django.n).toBe(4); // the same three, plus the one holding NULL
  });

  // `is_donation_point` is NULLABLE (0001_core.sql:71 -- 567 of 1,972 rows are
  // NULL in production, contrary to the model), so `= 1` and `!= 0` are NOT
  // the same query here: the second would still exclude NULLs under
  // three-valued logic, but `IS NOT 0` would sweep all 567 in. Django's
  // filter(is_donation_point=True) excludes NULL, and so does this.
  it("counts a location as a donation point only when the flag is exactly 1", async () => {
    seedEstate();

    const stats = await getEditStats(session);
    const nulls = db.prepare("SELECT COUNT(*) AS n FROM foodbanklocation WHERE is_donation_point IS NULL").get() as { n: number };

    expect(nulls.n).toBe(1);
    expect(stats.locationDonationPoints).toBe(5); // not 6
  });

  // adminStats.ts:126-130 says the COALESCE "restores the model's default=0
  // semantics" where a bare `!= 0` "would silently drop the NULL rows".
  // RUN AGAINST THE ENGINE, the two spellings agree exactly: inside a
  // SUM(CASE WHEN ...), `NULL != 0` is UNKNOWN and takes the ELSE branch,
  // while `COALESCE(NULL, 0) != 0` is FALSE and takes the same one. The
  // COALESCE is harmless and defensive, not load-bearing, and the comment
  // overstates it -- pinned here so the next person to read that comment can
  // see the measurement rather than trusting the claim. (It WOULD matter in a
  // WHERE clause that also had to survive a NOT, which is where the habit
  // comes from.)
  it("gives the same answer with or without the COALESCE the comment credits", async () => {
    seedEstate();

    const stats = await getEditStats(session);
    const bare = db.prepare("SELECT SUM(CASE WHEN no_donation_points != 0 THEN 1 ELSE 0 END) AS n FROM foodbank").get() as { n: number };

    expect(stats.fbWithDonationPoints).toBe(4);
    expect(bare.n).toBe(4);
  });

  // adminStats.ts:131-139. Django uses order_by("-edited")[:1][0], and
  // Postgres sorts NULLS FIRST on DESC -- so the moment one food bank has
  // never been edited, Django's "Newest Edit" prints None. SQLite's opposite
  // NULL defaults would break "Oldest Edit" instead. Aggregate MIN/MAX ignore
  // NULLs on both engines, which is why one construct is right everywhere.
  //
  // THE ASYMMETRY, MEASURED. Two of the six seeded food banks have edited
  // NULL, and the two possible sort-based rewrites behave differently on this
  // engine: `MAX(edited)` -> `ORDER BY edited DESC LIMIT 1` does NOT fail
  // here, because SQLite sorts NULLs LAST on DESC -- it is Postgres's NULLS
  // FIRST that makes Django print None, which is the defect the module's
  // comment describes and which no SQLite fixture can reproduce.
  // `MIN(edited)` -> `ORDER BY edited LIMIT 1` DOES fail, because SQLite sorts
  // NULLs first on ASC. So a sort is wrong on one engine or the other
  // depending on which end you take, and MIN/MAX is right on both; this test
  // catches the half of that a SQLite harness can catch, and the last
  // assertion shows the Postgres half explicitly.
  it("ignores never-edited food banks when finding the oldest and newest edit", async () => {
    seedEstate();

    const stats = await getEditStats(session);

    expect(stats.oldestEdit).toBe("2024-06-01 08:30:00.000000");
    expect(stats.newestEdit).toBe("2026-03-02 11:11:11.111000");
    // What Django's order_by("-edited")[:1][0] returns on Postgres, spelled
    // out with the NULLS FIRST that engine defaults to: "Newest Edit" is
    // None, on a table where two food banks have simply never been edited.
    const djangoNewest = db.prepare("SELECT edited FROM foodbank ORDER BY edited DESC NULLS FIRST LIMIT 1").get() as { edited: string | null };
    expect(djangoNewest.edited).toBeNull();
  });

  // THE HAZARD MIGRATION 0022 EXISTS FOR, on the one pair of values on this
  // page that is chosen by comparison rather than counted. These are TEXT
  // columns compared byte-wise: 'T' is 0x54 and ' ' is 0x20, so an
  // ISO-shaped value beats EVERY same-day Django-shaped one regardless of the
  // real time. The row added here is three hours EARLIER than the true newest
  // edit and still wins.
  //
  // Nothing in the database should be in this shape any more -- 0022
  // rewrote them and pyNow() now writes Django's form -- so this is a pin on
  // what would happen if a write site regressed to toISOString(), not a
  // description of today's data. It is also why "Newest Edit" is worth a test
  // at all: the wrong answer here is a plausible timestamp, not an error.
  it("compares edit timestamps lexicographically, so a stray ISO-shaped value wins the MAX", async () => {
    seedEstate();
    seedFoodbank({ edited: "2026-03-02T08:00:00.000Z" });

    const stats = await getEditStats(session);

    expect(stats.newestEdit).toBe("2026-03-02T08:00:00.000Z");
  });

  // views.py:2409-2413's four COUNTs collapse into one GROUP BY, and the
  // route sums the groups for "Total Discrepancies" (stats.ts:152) so the
  // total can never disagree with the parts. DISCREPANCY_STATUSES is an
  // app-level allowlist, not a DB constraint (0008_needcheck.sql:53-56), so
  // an unexpected status is possible -- it must appear in the map, or the
  // total would quietly stop matching the sum of the rows.
  it("groups discrepancies by status, including a status the allowlist does not name", async () => {
    seedEstate();
    seedDiscrepancy("Wontfix", 3);

    const stats = await getEditStats(session);

    expect(stats.discrepanciesByStatus).toEqual({ New: 4, Done: 2, Invalid: 1, Wontfix: 3 });
    expect(Object.values(stats.discrepanciesByStatus).reduce((sum, n) => sum + n, 0)).toBe(
      (db.prepare("SELECT COUNT(*) AS n FROM foodbankdiscrepancy").get() as { n: number }).n,
    );
  });

  // adminStats.ts:136-139: Django's own edit_stats() raises IndexError on an
  // empty foodbank table, because order_by("-edited")[:1][0] indexes an empty
  // slice. The aggregate form returns a single row of NULLs instead, and the
  // `?? 0` mapping turns it into a page of zeros. Worth a test because an
  // empty table is exactly the state a fresh D1 database is in, which is when
  // someone is most likely to open this page.
  it("survives a completely empty database, where Django's own view raises IndexError", async () => {
    const stats = await getEditStats(session);

    expect(stats).toEqual({
      foodbanks: 0,
      locations: 0,
      donationPoints: 0,
      nonAdminAddress: 0,
      withDeliveryAddress: 0,
      locationDonationPoints: 0,
      fbWithDonationPoints: 0,
      oldestEdit: null,
      newestEdit: null,
      discrepanciesByStatus: {},
    });
  });
});

// ===========================================================================
// getOrderStats
// ===========================================================================
// gfadmin/views.py:2425-2454. All-time totals, no window of any kind.
describe("getOrderStats", () => {
  // Deliberately spread across seven years and on both sides of any plausible
  // "recent" cutoff. This function is the ONLY one in the file with no date
  // predicate, and it sits directly beneath getQuarterStats' near-identical
  // SELECT -- copying that statement's WHERE clause across would turn an
  // all-time total into a quarterly one, and the page would still render.
  function seedAllTime(): void {
    seedOrder({ created: PY("2019-04-01 00:00:00.000000"), weight: 1000, no_items: 7, calories: 2500, cost: 1234 });
    seedOrder({ created: PY("2023-08-15 12:00:00.000000"), weight: 2000, no_items: 11, calories: 5000, cost: 2345 });
    seedOrder({ created: PY("2027-12-31 23:59:59.999000"), weight: 4000, no_items: 13, calories: 9000, cost: 3456 });
  }

  it("sums every order ever placed, with no date filter", async () => {
    seedAllTime();

    const stats = await getOrderStats(session);

    expect(stats).toEqual({ totalOrders: 3, weightGrams: 7000, calories: 16500, items: 31, costPence: 7035 });
  });

  // adminStats.ts:192-195. This is the literal Django crash: views.py:2427-2433
  // asks for Sum("weight"), gets None back on an empty table, and divides it
  // by 1000 on the very next line. The port renders a page of zeros instead.
  // As with the quarter's empty-window test, the COALESCE and the mapping's
  // `?? 0` each produce that zero on their own (measured -- dropping all four
  // COALESCEs leaves this green); the contract is what is pinned.
  it("returns zeros on an empty table, where Django raises a TypeError", async () => {
    const stats = await getOrderStats(session);

    expect(stats).toEqual({ totalOrders: 0, weightGrams: 0, calories: 0, items: 0, costPence: 0 });
  });

  // The route prints Weight and Cost through unit conversions and Calories and
  // Items bare (stats.ts:194-201), so a swap between the pairs is a plausible
  // number in the wrong row. Four distinct magnitudes make it fail here.
  it("maps weight, calories, items and cost to their own fields", async () => {
    seedOrder({ weight: 123000, no_items: 45, calories: 678000, cost: 9012 });

    expect(await getOrderStats(session)).toEqual({
      totalOrders: 1,
      weightGrams: 123000,
      calories: 678000,
      items: 45,
      costPence: 9012,
    });
  });
});

// ===========================================================================
// getSubscriberStats
// ===========================================================================
// gfadmin/views.py:2457-2470.
describe("getSubscriberStats", () => {
  it("splits the table on confirmed in a single pass", async () => {
    for (let i = 0; i < 4; i += 1) seedSubscriber({ confirmed: 1 });
    for (let i = 0; i < 3; i += 1) seedSubscriber({ confirmed: 0 });

    expect(await getSubscriberStats(session)).toEqual({ confirmed: 4, unconfirmed: 3 });
  });

  it("returns zeros rather than nulls when nobody has ever subscribed", async () => {
    expect(await getSubscriberStats(session)).toEqual({ confirmed: 0, unconfirmed: 0 });
  });

  // adminStats.ts:222-226 justifies the two-branch single pass with "confirmed
  // is INTEGER NOT NULL DEFAULT 0, so 0/1 is exhaustive". True of the schema,
  // but NOT ENFORCED by it -- there is no CHECK constraint (0004_subscribers
  // .sql:22) -- and the consequence is that any other value is counted in
  // NEITHER branch, so the two figures silently stop summing to the table.
  // Pinned rather than fixed: this is what the code does today, the
  // assumption holds for every row production has, and the day it stops
  // holding this test says where to look.
  it("counts a value outside 0/1 in neither column, so the two figures stop summing to the table", async () => {
    seedSubscriber({ confirmed: 1 });
    seedSubscriber({ confirmed: 0 });
    seedSubscriber({ confirmed: 2 });

    const stats = await getSubscriberStats(session);

    expect(stats).toEqual({ confirmed: 1, unconfirmed: 1 });
    expect(stats.confirmed + stats.unconfirmed).not.toBe(
      (db.prepare("SELECT COUNT(*) AS n FROM foodbanksubscriber").get() as { n: number }).n,
    );
  });
});

// ===========================================================================
// getSubscriberSignupRows
// ===========================================================================
// gfadmin/views.py:2473-2517. One UNION ALL of two narrow columns replacing
// four materialised Django querysets.
describe("getSubscriberSignupRows", () => {
  const narrow = (rows: Array<{ channel: string; created: string }>) => rows.map((row) => ({ channel: row.channel, created: row.created }));

  // THE ORDER BY IS THE POINT OF THIS QUERY. adminStats.ts:258-263: the global
  // sort is what makes the caller's Map insertion order chronological, which
  // is the FIX for Django's defect at views.py:2482-2500 -- Django fills its
  // OrderedDict email-first, so a week in which only a web-push or app
  // subscription happened is appended after every email week and lands at the
  // far right of the chart no matter its date.
  //
  // The rows are seeded in an order that is neither chronological nor
  // channel-grouped, so three separate mutants fail here: dropping the ORDER
  // BY (rows come back email-first, in insert order), sorting inside each arm
  // of the UNION instead of globally, and ordering by anything but `created`.
  it("returns every channel in one global chronological order", async () => {
    seedSubscriber({ created: PY("2026-01-05 09:00:00.000000"), confirmed: 1 });
    seedMobile({ created: PY("2026-01-03 12:00:00.000000") });
    seedWebPush({ created: PY("2026-01-04 18:30:00.000000") });
    seedSubscriber({ created: PY("2026-02-10 08:00:00.000000"), confirmed: 1 });
    seedMobile({ created: PY("2026-01-20 07:15:00.000000") });
    seedWebPush({ created: PY("2026-03-01 23:59:59.999000") });

    expect(narrow(await getSubscriberSignupRows(session))).toEqual([
      { channel: "mobile", created: "2026-01-03 12:00:00.000000" },
      { channel: "webpush", created: "2026-01-04 18:30:00.000000" },
      { channel: "email", created: "2026-01-05 09:00:00.000000" },
      { channel: "mobile", created: "2026-01-20 07:15:00.000000" },
      { channel: "email", created: "2026-02-10 08:00:00.000000" },
      { channel: "webpush", created: "2026-03-01 23:59:59.999000" },
    ]);
  });

  // views.py:2482 filters FoodbankSubscriber on confirmed=True and the other
  // three querysets on nothing. The asymmetry is easy to lose in a UNION ALL,
  // and losing it in either direction is invisible: too many rows just makes
  // the email series taller. An unconfirmed sign-up is someone who never
  // clicked the opt-in link, so it does not belong on a graph of subscribers.
  it("filters email sign-ups on confirmed, and filters the other two channels on nothing", async () => {
    seedSubscriber({ created: PY("2026-01-01 00:00:00.000000"), confirmed: 0 });
    seedSubscriber({ created: PY("2026-01-02 00:00:00.000000"), confirmed: 1 });
    seedWebPush({ created: PY("2026-01-03 00:00:00.000000") });
    seedMobile({ created: PY("2026-01-04 00:00:00.000000") });

    expect(narrow(await getSubscriberSignupRows(session))).toEqual([
      { channel: "email", created: "2026-01-02 00:00:00.000000" },
      { channel: "webpush", created: "2026-01-03 00:00:00.000000" },
      { channel: "mobile", created: "2026-01-04 00:00:00.000000" },
    ]);
  });

  // The channel literal is a bucket key in the caller (stats.ts:273 does
  // `bucket[row.channel] += 1` against a WeekBucket with exactly these three
  // names). Misspell one in the SQL and the graph gains an undefined series
  // instead of raising -- so the exact strings are asserted, not just their
  // presence.
  it("labels each arm of the union with the exact channel key the caller buckets on", async () => {
    seedSubscriber({ created: PY("2026-01-01 00:00:00.000000"), confirmed: 1 });
    seedWebPush({ created: PY("2026-01-02 00:00:00.000000") });
    seedMobile({ created: PY("2026-01-03 00:00:00.000000") });

    const rows = await getSubscriberSignupRows(session);

    expect(rows.map((row) => row.channel)).toEqual(["email", "webpush", "mobile"]);
    // TWO COLUMNS, AND ONLY TWO. adminStats.ts:246-248 sells this query on
    // being "one UNION ALL of two narrow columns" over ~5,950 rows, and
    // :270-277 makes that width the reason the read is allowed to stay
    // unbounded at all. A widened SELECT -- somebody reaching for foodbank_id
    // on the way to a filter they never finished -- multiplies the bytes on
    // the wire without moving a single number on the page, so no other
    // assertion in this file could ever notice it.
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(["channel", "created"]);
  });

  // THE `UNION ALL` -> `UNION` MUTANT, and the one hole the first mutation
  // pass left open. Every other test in this block seeds rows whose
  // (channel, created) pairs are all distinct, so dropping the three `ALL`s --
  // a one-word edit, and the spelling a careless hand reaches for first --
  // passed the entire suite. A compound UNION deduplicates WHOLE ROWS, and a
  // row here is only those two narrow columns, so two genuine sign-ups on the
  // same channel at the same instant collapse into one. The graph is nothing
  // but counts; it would simply draw a shorter bar.
  //
  // IDENTICAL TIMESTAMPS ARE REACHABLE, not hypothetical. pyNow()
  // (packages/models/src/pyDatetime.ts:47-52) writes MILLISECOND resolution --
  // JavaScript supplies three fractional digits and the helper pads the other
  // three with literal zeros -- so a write has only a thousand distinct values
  // per second to land on, and a Worker's clock does not advance at all
  // between I/O operations, so any two rows written while handling one request
  // carry byte-identical `created`.
  //
  // DUPLICATED IN ALL THREE CHANNELS deliberately. SQLite evaluates a compound
  // SELECT left to right, so a `UNION` in the first position alone dedupes
  // email against webpush, and one in the second position alone dedupes
  // webpush against mobile. A fixture that duplicated a single channel would
  // kill one spelling of this mutant and let the other two through -- which is
  // exactly the mistake that left the hole in the first place.
  it("keeps duplicate sign-ups, because a UNION would silently collapse two people into one", async () => {
    seedSubscriber({ created: PY("2026-01-06 10:00:00.000000"), confirmed: 1 });
    seedSubscriber({ created: PY("2026-01-06 10:00:00.000000"), confirmed: 1 });
    seedWebPush({ created: PY("2026-01-07 11:00:00.000000") });
    seedWebPush({ created: PY("2026-01-07 11:00:00.000000") });
    seedMobile({ created: PY("2026-01-08 12:00:00.000000") });
    seedMobile({ created: PY("2026-01-08 12:00:00.000000") });

    const rows = await getSubscriberSignupRows(session);

    expect(narrow(rows)).toEqual([
      { channel: "email", created: "2026-01-06 10:00:00.000000" },
      { channel: "email", created: "2026-01-06 10:00:00.000000" },
      { channel: "webpush", created: "2026-01-07 11:00:00.000000" },
      { channel: "webpush", created: "2026-01-07 11:00:00.000000" },
      { channel: "mobile", created: "2026-01-08 12:00:00.000000" },
      { channel: "mobile", created: "2026-01-08 12:00:00.000000" },
    ]);
    // Stated against the stored totals as well, because the failure is a
    // COUNT: the query must hand back one row per subscription record, and a
    // deduping compound select returns three here while every row it dropped
    // was a real person.
    const stored =
      (db.prepare("SELECT COUNT(*) AS n FROM foodbanksubscriber WHERE confirmed = 1").get() as { n: number }).n +
      (db.prepare("SELECT COUNT(*) AS n FROM webpushsubscription").get() as { n: number }).n +
      (db.prepare("SELECT COUNT(*) AS n FROM mobilesubscriber").get() as { n: number }).n;
    expect(rows).toHaveLength(stored); // 6; a UNION returns 3, and nothing anywhere says so
  });

  // SUSPECTED BUG, PINNED AS-IS RATHER THAN FIXED. adminStats.ts:265-269 says
  // WhatsApp is absent "because there is no `whatsappsubscriber` D1 table".
  // There is one now: migration 0020_whatsappsubscriber.sql created it (same
  // day as this module was written), noting that Postgres holds 49 rows that
  // would otherwise have been silently dropped. Django's subscriber_graph
  // DOES count them (views.py:2487-2490), so the ported graph currently
  // under-reports that channel -- and the caller keeps the `whatsapp` series
  // pinned at 0, so the gap renders as a legend entry that never has a bar.
  //
  // This test asserts what the code DOES: the seeded WhatsApp sign-up does not
  // appear. If a fourth UNION ALL arm is added, this test fails -- which is
  // the correct outcome, and the moment to delete it.
  it("omits WhatsApp sign-ups even though the whatsappsubscriber table now exists", async () => {
    seedSubscriber({ created: PY("2026-01-02 00:00:00.000000"), confirmed: 1 });
    insert("whatsappsubscriber", { id: (nextId += 1), phone_number: "+447700900000", foodbank_id: 1, created: PY("2026-01-01 00:00:00.000000") });

    const rows = await getSubscriberSignupRows(session);

    expect(rows.map((row) => row.channel)).toEqual(["email"]);
    // The row really is there to be read -- this is a missing arm, not a
    // missing table.
    expect((db.prepare("SELECT COUNT(*) AS n FROM whatsappsubscriber").get() as { n: number }).n).toBe(1);
  });

  it("returns an empty array when no channel has ever been subscribed to", async () => {
    expect(await getSubscriberSignupRows(session)).toEqual([]);
  });

  // The same lexicographic hazard as getEditStats' MAX, on the column this
  // query sorts by. Every subscriber row in the database is Django-shaped
  // after migration 0022, and pyNow() keeps it that way -- but if a write site
  // regressed to toISOString(), the row would sort after EVERY same-day
  // Django row (0x54 vs 0x20) and land in the wrong week bucket at the wrong
  // end of the chart. The route's parseStatsTimestamp (stats.ts:71-73) copes
  // with reading both shapes; nothing copes with sorting them together.
  it("sorts a stray ISO-shaped timestamp after every same-day Django-shaped one", async () => {
    seedWebPush({ created: "2026-01-05T08:00:00.000Z" }); // 08:00 -- chronologically first
    seedMobile({ created: PY("2026-01-05 20:00:00.000000") }); // 20:00 -- chronologically last

    expect((await getSubscriberSignupRows(session)).map((row) => row.channel)).toEqual(["mobile", "webpush"]);
  });
});

// ===========================================================================
// getNeedStats
// ===========================================================================
// gfadmin/views.py:2520-2535.
describe("getNeedStats", () => {
  // views.py:2523 has no published/nonpertinent filter, and neither does this.
  // Every one of those columns is a live filter SOMEWHERE else in the codebase
  // (change_pub_created_idx exists for exactly that), so adding one here would
  // look like a correction; it would silently drop rows from a figure that has
  // always meant "every need record we hold".
  it("counts every need record, published or not, pertinent or not, assigned or not", async () => {
    seedChange({ published: 1, nonpertinent: 0 });
    seedChange({ published: 0, nonpertinent: 0 });
    seedChange({ published: 1, nonpertinent: 1 });
    seedChange({ published: 0, nonpertinent: null });
    seedChange({ published: 1, foodbank_id: null }); // an unassigned need

    expect((await getNeedStats(session)).needs).toBe(5);
  });

  // views.py:2524-2526's three full scans of a 332k-row table become one
  // GROUP BY, and the route derives "Items" by summing the groups (stats.ts:290)
  // rather than issuing its own COUNT(*). That is only safe if EVERY type
  // comes back, including one NEED_LINE_TYPES does not name
  // (const/general.py:31-34 lists just "need" and "excess") -- otherwise the
  // total silently stops matching the table.
  it("groups change lines by type, including a type the constant does not name", async () => {
    for (let i = 0; i < 6; i += 1) seedChangeLine({ type: "need" });
    for (let i = 0; i < 2; i += 1) seedChangeLine({ type: "excess" });
    for (let i = 0; i < 3; i += 1) seedChangeLine({ type: "unknown" });

    const stats = await getNeedStats(session);

    expect(stats.linesByType).toEqual({ need: 6, excess: 2, unknown: 3 });
    expect(Object.values(stats.linesByType).reduce((sum, n) => sum + n, 0)).toBe(
      (db.prepare("SELECT COUNT(*) AS n FROM foodbankchangeline").get() as { n: number }).n,
    );
  });

  // The two statements go out as one batch and are read back by index. Needs
  // and lines are different tables with different counts here, so a swap
  // between results[0] and results[1] cannot pass.
  it("keeps the need count and the line groups in their own batch slots", async () => {
    seedChange();
    seedChange();
    for (let i = 0; i < 7; i += 1) seedChangeLine({ type: "need" });

    const stats = await getNeedStats(session);

    expect(stats.needs).toBe(2);
    expect(stats.linesByType).toEqual({ need: 7 });
  });

  it("returns zero needs and an empty group map on an empty database", async () => {
    expect(await getNeedStats(session)).toEqual({ needs: 0, linesByType: {} });
  });
});
