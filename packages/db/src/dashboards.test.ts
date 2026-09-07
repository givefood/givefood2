import { beforeEach, describe, expect, it } from "vitest";
import {
  BEAUTYBANKS_PRODUCTS,
  getBeanPastaMonthCounts,
  getBeautyBankProductNeeds,
  getCharityYearAggregates,
  getDeliveryMonthCounts,
  getFoodbankCreatedDates,
  getLatestExcessTextsSince,
  getLatestNeedTextsSince,
  getNeedItemCategoryCounts,
  getNeedItemGroupCounts,
  getOrderCalorieTotals,
  getOrderLineCategoryMonthPrices,
  getOrderLineCategoryTotals,
  getOrderWeightTotals,
  getPricePerCalorieByMonth,
  getPricePerKgByMonth,
  getPublishedNeedsForWeeklyCount,
  getRecentPublishedChanges,
  getSupermarketDonationPointCounts,
  getSupermarketDonationPointTotal,
  getTrussellFoodbanksByLastNeed,
} from "./dashboards";
import type { Session } from "./types";

// gfdash's twenty public dashboards, at the SQL tier (gfdash/views.py, ported
// in packages/db/src/dashboards.ts).
//
// THIS IS THE TIER WHERE BEING WRONG IS SILENT. Every function in the module
// is one SELECT and a `return result.results` -- there is no logic to throw.
// A dropped `published = 1`, an INNER JOIN where the view has a LEFT, an
// ORDER BY on the wrong column, an integer division that truncates: none of
// them raise, none of them log, and the dashboard renders a plausible chart
// that is simply wrong. This repo already has the scar -- migration 0019
// dropped foodbankchange.foodbank_name and four queries went on naming it;
// /dashboard/beautybanks/ was a live 500 nobody noticed until it was measured
// on 2026-09-05.
//
// So the tests below run the REAL SQL against a REAL in-memory SQLite seeded
// from the REAL DDL in packages/db/migrations/, including the
// foodbankchange_full VIEW that getRecentPublishedChanges reads and the
// `ALTER TABLE ... DROP COLUMN` that 0019 actually performed. A fake session
// answering canned rows would test a second implementation of the query
// rather than the query, and a hand-built stand-in row for the view would be
// circular -- the view's own LEFT JOIN is one of the things that can be
// wrong.
//
// Two whole families of behaviour get particular attention, because both have
// already cost this project a live defect:
//
//   * TIMESTAMPS ARE TEXT, COMPARED LEXICOGRAPHICALLY. Django writes
//     "2026-09-05 19:28:08.853000"; toISOString() writes
//     "2026-09-05T19:28:08.639Z", and 'T' (0x54) sorts after ' ' (0x20), so
//     an ISO value beats every same-day Django value regardless of the real
//     time. Migration 0022 exists to undo exactly that. Every threshold and
//     every ORDER BY over a datetime here is tested with Django-shaped
//     values, and the hazard itself is pinned where it can still bite.
//
//   * D1 CAPS A STATEMENT AT 100 BOUND PARAMETERS. Two functions here build
//     a variable-length list: getBeautyBankProductNeeds (39 LIKE terms, fixed
//     and safe) and getOrderLineCategoryMonthPrices (one placeholder per
//     qualifying category, caller-supplied and unchunked). Both are tested at
//     and over the boundary -- see the last describe block, and the note
//     recorded there about what production would do that node:sqlite will
//     not.
//
// WHY THE SUPPRESSED IMPORT. packages/db typechecks with
// `"types": ["@cloudflare/workers-types"]` and has no @types/node, so tsc
// reports TS2591 on the `node:sqlite` specifier. `@ts-ignore` rather than
// `@ts-expect-error`, following adminStats.test.ts: if @types/node is ever
// added to this package an @ts-expect-error would itself become the error,
// and a suite that breaks when the tooling is FIXED is worse than one line of
// suppression.
// @ts-ignore -- no @types/node under this package's tsconfig; vitest runs in node, where this module is real
import { DatabaseSync } from "node:sqlite";

// ===========================================================================
// SCHEMA
// ===========================================================================
// Column-for-column from packages/db/migrations/, at the CURRENT migration
// state: 0001_core.sql (foodbank, foodbankdonationpoint, foodbankchange),
// 0003_homepage_data.sql (foodbankchangeline), 0005_orders_and_charity.sql
// (orders, orderline, charityyear), each as amended by
// 0019_drop_foodbank_cache.sql.
//
// Transcribed from the migrations, NOT derived from the TypeScript interfaces
// in dashboards.ts -- a disagreement between those two is one of the things
// this file exists to catch, and a schema reverse-engineered from the
// interfaces could not catch it by construction. (One such disagreement is
// found: BeautyBankNeedRow declares `foodbank_name: string | null`, but the
// query INNER JOINs a NOT NULL column, so it can never be null -- see
// "cannot return a null foodbank_name" below.)
//
// 0019's DROP COLUMNs are REPLAYED rather than the tables simply being
// declared without the cached parent columns. That is deliberate: 0019 is
// this repo's scar, and a fixture declaring the post-migration shape directly
// could not fail for a query that still named `fc.foodbank_name`. Replayed,
// SQLite says "no such column: fc.foodbank_name", which is what D1 said on
// 2026-09-05.
//
// The indexes come along because the module's comments claim particular
// queries sit on them (dashboards.ts:103 names fcl_cat_need_idx). They cost
// nothing at this size, and a migration that renamed one shows up here.
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
CREATE INDEX foodbank_last_need_idx     ON foodbank(last_need);

CREATE TABLE foodbankdonationpoint (
  id INTEGER PRIMARY KEY, uuid TEXT NOT NULL,
  foodbank_id INTEGER NOT NULL,
  foodbank_name TEXT NOT NULL, foodbank_slug TEXT NOT NULL, foodbank_network TEXT NOT NULL,
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
CREATE UNIQUE INDEX dp_fb_name_uniq  ON foodbankdonationpoint(foodbank_id, name);
CREATE INDEX dp_company_slug_name    ON foodbankdonationpoint(company_slug, name);

CREATE TABLE foodbankchange (
  id INTEGER PRIMARY KEY,
  need_id TEXT NOT NULL,
  foodbank_id INTEGER, foodbank_name TEXT,
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
CREATE UNIQUE INDEX need_need_id_uniq      ON foodbankchange(need_id);
CREATE INDEX change_pub_created_idx        ON foodbankchange(published, created DESC) WHERE published = 1;

CREATE TABLE foodbankchangeline (
  id INTEGER PRIMARY KEY,
  need_id INTEGER NOT NULL, foodbank_id INTEGER NOT NULL,
  item TEXT NOT NULL, type TEXT NOT NULL, category TEXT NOT NULL, group_name TEXT NOT NULL,
  created TEXT NOT NULL
);
CREATE INDEX fcl_type_idx      ON foodbankchangeline(type);
CREATE INDEX fcl_cat_need_idx  ON foodbankchangeline(category, need_id) WHERE type = 'need';

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
CREATE INDEX orderline_delivery_date_idx ON orderline(delivery_date);
CREATE INDEX orderline_category_idx ON orderline(category) WHERE category IS NOT NULL;

CREATE TABLE charityyear (
  id INTEGER PRIMARY KEY,
  foodbank_id INTEGER,
  created TEXT, date TEXT,
  income INTEGER, expenditure INTEGER
);
CREATE INDEX charityyear_date_idx ON charityyear(date);

-- 0019_drop_foodbank_cache.sql, replayed on the two tables this module reads.
ALTER TABLE foodbankchange DROP COLUMN foodbank_name;
ALTER TABLE foodbankdonationpoint DROP COLUMN foodbank_name;
ALTER TABLE foodbankdonationpoint DROP COLUMN foodbank_slug;
ALTER TABLE foodbankdonationpoint DROP COLUMN foodbank_network;

CREATE VIEW foodbankchange_full AS
  SELECT c.*, f.name AS foodbank_name, f.slug AS foodbank_slug
    FROM foodbankchange c
    LEFT JOIN foodbank f ON f.id = c.foodbank_id;
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

interface Prepared {
  sql: string;
  params: Bindable[];
}

// The same adapter as adminStats.test.ts / foodbankLocation.test.ts: it hands
// the statement straight to SQLite and interprets nothing, which is the whole
// point of running a real engine.
//
// It ALSO records every statement that reaches .all()/.first(), which is not
// decoration: two functions here build a variable-length parameter list, and
// D1's 100-bound-parameter cap is a property of the STATEMENT, not of the
// rows that come back. node:sqlite's own limit is 32,766, so a statement that
// D1 would reject outright runs perfectly here -- the only way to test the
// cap is to count the bindings. `prepared` is how the boundary tests at the
// bottom of this file do it.
function d1Session(database: SqliteDatabase, prepared: Prepared[]): Session {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => {
      prepared.push({ sql, params });
      return (database.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    all: async () => {
      prepared.push({ sql, params });
      return { results: database.prepare(sql).all(...params), success: true, meta: {} };
    },
    run: async () => {
      prepared.push({ sql, params });
      database.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return { prepare: (sql: string) => statement(sql, []), getBookmark: () => null } as unknown as Session;
}

let db: SqliteDatabase;
let session: Session;
let prepared: Prepared[];
// One id counter across every table, so no two seeded rows anywhere share an
// id. A query joining on the wrong column would otherwise stand a good chance
// of accidentally matching and looking correct.
let nextId = 0;

beforeEach(() => {
  db = new DatabaseSync(":memory:") as SqliteDatabase;
  db.exec(SCHEMA);
  prepared = [];
  session = d1Session(db, prepared);
  nextId = 0;
});

function insert(table: string, row: Record<string, Bindable>): number {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(
    ...columns.map((column) => row[column] as Bindable),
  );
  return row.id as number;
}

// A NO-OP THAT EARNS ITS KEEP, borrowed from adminStats.test.ts. Every
// timestamp in these fixtures is in DJANGO'S shape --
// "YYYY-MM-DD HH:MM:SS.ffffff", what str(datetime) produces and what
// migration 0022 normalised the whole database to. Wrapping the normal shape
// means the handful of literals deliberately left in the OLD toISOString()
// form stand out as the anomalies they are, rather than being one punctuation
// mark different from their neighbours.
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

function seedChange(row: Partial<Record<string, Bindable>> = {}): number {
  const n = (nextId += 1);
  return insert("foodbankchange", {
    id: n,
    need_id: `need${n}`,
    foodbank_id: null,
    change_text: "Beans",
    published: 1,
    input_method: "scrape",
    created: PY("2024-01-01 12:00:00.000000"),
    modified: PY("2024-01-01 12:00:00.000000"),
    ...row,
  });
}

function seedChangeLine(row: Partial<Record<string, Bindable>> = {}): number {
  const n = (nextId += 1);
  return insert("foodbankchangeline", {
    id: n,
    need_id: 0,
    foodbank_id: 0,
    item: `Item ${n}`,
    type: "need",
    category: "Tinned Goods",
    group_name: "Food",
    created: PY("2024-01-01 12:00:00.000000"),
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
    order_id: `order${n}`,
    items_text: "2 x Beans",
    country: "England",
    created: PY("2024-01-01 12:00:00.000000"),
    modified: PY("2024-01-01 12:00:00.000000"),
    delivery_date: "2024-01-02",
    delivery_hour: 9,
    delivery_datetime: PY("2024-01-02 09:00:00.000000"),
    weight: 1000,
    calories: 1000,
    cost: 1000,
    no_lines: 1,
    no_items: 1,
    foodbank_id: null,
    ...row,
  });
}

function seedOrderLine(row: Partial<Record<string, Bindable>> = {}): number {
  const n = (nextId += 1);
  return insert("orderline", {
    id: n,
    name: `Line ${n}`,
    quantity: 1,
    item_cost: 100,
    line_cost: 100,
    weight: 400,
    calories: 400,
    order_id: 0,
    delivery_date: "2024-01-02",
    category: "Tinned Goods",
    group_name: "Food",
    ...row,
  });
}

function seedCharityYear(row: Partial<Record<string, Bindable>> = {}): number {
  const n = (nextId += 1);
  return insert("charityyear", {
    id: n,
    foodbank_id: 0,
    created: PY("2024-01-01 12:00:00.000000"),
    date: "2024-03-31",
    income: 1000,
    expenditure: 900,
    ...row,
  });
}

// ===========================================================================
// The 0019 scar itself
// ===========================================================================

// Not a test of dashboards.ts -- a test of the FIXTURE, and the reason every
// other test in this file can be believed. getBeautyBankProductNeeds reads
// `f.name AS foodbank_name` precisely because 0019 dropped the denormalised
// copy from foodbankchange; if this fixture still had that column, the
// pre-fix query would pass every test below and the 2026-09-05 500 would be
// invisible here.
describe("the fixture reproduces migration 0019, not the pre-0019 schema", () => {
  it("has no foodbankchange.foodbank_name to fall back on", () => {
    expect(() => db.prepare("SELECT foodbank_name FROM foodbankchange").all()).toThrow(/no such column/i);
  });

  it("exposes the parent's name only through the foodbankchange_full view", () => {
    const foodbank = seedFoodbank({ name: "Salisbury" });
    seedChange({ foodbank_id: foodbank });

    expect(db.prepare("SELECT foodbank_name FROM foodbankchange_full").all()).toEqual([{ foodbank_name: "Salisbury" }]);
  });
});

// ===========================================================================
// getPublishedNeedsForWeeklyCount -- weekly_itemcount / weekly_itemcount_year
// ===========================================================================

describe("getPublishedNeedsForWeeklyCount", () => {
  it("returns published needs after 2020, oldest first", async () => {
    seedChange({ change_text: "Third", created: PY("2024-06-01 09:00:00.000000") });
    seedChange({ change_text: "First", created: PY("2021-02-03 08:00:00.000000") });
    seedChange({ change_text: "Second", created: PY("2023-11-30 23:59:59.999999") });

    const rows = await getPublishedNeedsForWeeklyCount(session);

    // Seeded deliberately out of order. `ORDER BY created` is not cosmetic
    // here: the caller (workers/site's isoWeek grouping) folds these into an
    // OrderedDict keyed by ISO week, and Django's template renders that dict
    // in insertion order -- so a lost ORDER BY silently scrambles the x-axis
    // of the chart rather than failing.
    expect(rows.map((r) => r.change_text)).toEqual(["First", "Second", "Third"]);
  });

  it("excludes unpublished needs", async () => {
    seedChange({ change_text: "Visible", published: 1 });
    seedChange({ change_text: "Draft", published: 0 });

    const rows = await getPublishedNeedsForWeeklyCount(session);

    // A filter that only ever sees matching rows passes every test. This one
    // seeds the row that MUST be absent: needcheck writes unpublished needs
    // continuously, and counting them would inflate every week on the chart.
    expect(rows.map((r) => r.change_text)).toEqual(["Visible"]);
  });

  it("excludes needs from before 2020 and keeps the ones just after", async () => {
    seedChange({ change_text: "2019", created: PY("2019-12-31 23:59:59.999999") });
    seedChange({ change_text: "2020", created: PY("2020-01-02 00:00:00.000000") });

    const rows = await getPublishedNeedsForWeeklyCount(session);

    expect(rows.map((r) => r.change_text)).toEqual(["2020"]);
  });

  // PINNED, NOT ENDORSED. Django's `created__gt=date(2020,1,1)` becomes
  // `created > '2020-01-01 00:00:00'`, which EXCLUDES a need stamped exactly
  // midnight. The port compares against the bare date string '2020-01-01',
  // and '2020-01-01 00:00:00.000000' is that string plus more characters, so
  // it sorts greater and the row is INCLUDED. One instant's worth of
  // divergence, on a boundary six years in the past, recorded here so that
  // whoever finds it knows it was seen rather than missed.
  //
  // `>` versus `>=` is not distinguishable at all in this query and no test
  // here pretends otherwise (that mutant survives, deliberately): the literal
  // is a bare date and every stored `created` carries a time, so no value can
  // ever be byte-equal to it.
  it("includes a need stamped exactly 2020-01-01 00:00:00, which Django excluded", async () => {
    seedChange({ change_text: "Midnight", created: PY("2020-01-01 00:00:00.000000") });

    const rows = await getPublishedNeedsForWeeklyCount(session);

    expect(rows.map((r) => r.change_text)).toEqual(["Midnight"]);
  });

  it("returns only the two columns the week loop reads", async () => {
    seedChange({ change_text: "Beans\nPasta" });

    const rows = await getPublishedNeedsForWeeklyCount(session);

    // A `SELECT *` here would still satisfy every assertion above while
    // pulling 17 columns of every published need ever written across the
    // wire. D1 bills rows read, and this query has no LIMIT.
    expect(Object.keys(rows[0]!)).toEqual(["change_text", "created"]);
  });
});

// ===========================================================================
// getLatestNeedTextsSince -- most_requested_items / tt_most_requested_items
// ===========================================================================

// The threshold shape workers/site actually sends: `toISOString().slice(0,19)
// .replace("T", " ")`, i.e. "YYYY-MM-DD HH:MM:SS" with no fractional part
// (routes/dashboards/mostRequestedItems.ts:35-37).
const THRESHOLD = "2026-08-01 00:00:00";

describe("getLatestNeedTextsSince", () => {
  it("joins each food bank to its own latest_need row and orders by last_need DESC", async () => {
    const oldest = seedChange({ change_text: "Oldest need" });
    const middle = seedChange({ change_text: "Middle need" });
    const newest = seedChange({ change_text: "Newest need" });
    seedFoodbank({ latest_need_id: middle, last_need: PY("2026-08-20 09:00:00.000000") });
    seedFoodbank({ latest_need_id: oldest, last_need: PY("2026-08-02 09:00:00.000000") });
    seedFoodbank({ latest_need_id: newest, last_need: PY("2026-08-30 09:00:00.000000") });

    const rows = await getLatestNeedTextsSince(session, THRESHOLD, false);

    // The ORDER BY is load-bearing for the dashboard's own output: the
    // caller builds a first-seen-ordered Map and sorts by count with a
    // STABLE sort, so ties between equally-common items are broken by which
    // food bank updated most recently. Scramble this and the tie order
    // changes with no other visible symptom.
    expect(rows.map((r) => r.change_text)).toEqual(["Newest need", "Middle need", "Oldest need"]);
  });

  it("drops a food bank whose last_need is older than the threshold, or NULL", async () => {
    const recent = seedChange({ change_text: "Recent" });
    const stale = seedChange({ change_text: "Stale" });
    const never = seedChange({ change_text: "Never" });
    seedFoodbank({ latest_need_id: recent, last_need: PY("2026-08-15 09:00:00.000000") });
    seedFoodbank({ latest_need_id: stale, last_need: PY("2026-07-15 09:00:00.000000") });
    // NULL last_need is the case a `>` cannot express as an exclusion by
    // accident: `NULL > '2026-08-01...'` is NULL, not false, and a WHERE
    // clause drops it either way -- but only because it is a WHERE. The same
    // comparison written as a CASE or moved into a JOIN condition behaves
    // differently, so it is pinned rather than assumed.
    seedFoodbank({ latest_need_id: never, last_need: null });

    const rows = await getLatestNeedTextsSince(session, THRESHOLD, false);

    expect(rows.map((r) => r.change_text)).toEqual(["Recent"]);
  });

  // The threshold carries no ".ffffff" and the stored value does. Text
  // comparison makes that safe in one direction only, and this is the
  // direction: "…08:00:00.853000" is "…08:00:00" plus characters, so it
  // sorts greater and a need written in the same second as the threshold is
  // KEPT. If mostRequestedItems.ts ever starts sending a fractional
  // threshold, or dashboards.ts starts trimming the stored value, this test
  // is the one that notices.
  it("keeps a need whose stored last_need differs from the threshold only by its fractional seconds", async () => {
    const need = seedChange({ change_text: "Same second" });
    seedFoodbank({ latest_need_id: need, last_need: PY("2026-08-01 00:00:00.000001") });

    const rows = await getLatestNeedTextsSince(session, THRESHOLD, false);

    expect(rows).toHaveLength(1);
  });

  // The comparison is `>`, matching Django's `last_need__gt=day_threshold`,
  // so a value EQUAL to the threshold is excluded. Byte-equal last_need
  // values are vanishingly rare against a clock-derived threshold, which is
  // exactly why this needs pinning: `>=` passes every other test in this
  // file (measured -- that mutant survived until this case was added), and
  // the operator is one character.
  it("excludes a last_need exactly equal to the threshold", async () => {
    const equal = seedChange({ change_text: "Exactly on the boundary", excess_change_text: "Excess on the boundary" });
    const after = seedChange({ change_text: "One microsecond later", excess_change_text: "Excess after the boundary" });
    seedFoodbank({ latest_need_id: equal, last_need: THRESHOLD });
    seedFoodbank({ latest_need_id: after, last_need: `${THRESHOLD}.000001` });

    // Both sibling queries, because they carry the same predicate and the
    // same Django `__gt` behind it.
    expect((await getLatestNeedTextsSince(session, THRESHOLD, false)).map((r) => r.change_text)).toEqual(["One microsecond later"]);
    expect((await getLatestExcessTextsSince(session, THRESHOLD)).map((r) => r.excess_change_text)).toEqual(["Excess after the boundary"]);
  });

  // MIGRATION 0022'S HAZARD, RUN RATHER THAN ARGUED. `T` is 0x54 and space is
  // 0x20, so WITHIN A SINGLE DAY an ISO-shaped last_need beats every
  // Django-shaped value and every Django-shaped threshold, no matter what the
  // real instant was. (Across days the date prefix still decides, which is
  // why this needs a same-day threshold to demonstrate -- and why the bug was
  // subtle enough to survive to production.) 0022 rewrote the three
  // foodbank.last_need rows that were in this shape and pyNow() stops new
  // ones being written; this test is what fails if either protection is
  // undone, because the symptom is a food bank silently appearing in -- or
  // vanishing from -- a 7-day window with nothing logged.
  it("is fooled by a last_need still stored in JavaScript's ISO shape", async () => {
    const iso = seedChange({ change_text: "ISO stamped, 08:00" });
    const django = seedChange({ change_text: "Django stamped, 16:00" });
    seedFoodbank({ latest_need_id: iso, last_need: "2026-08-15T08:00:00.000Z" });
    seedFoodbank({ latest_need_id: django, last_need: PY("2026-08-15 16:00:00.000000") });

    // Eight hours BEFORE the threshold, and it comes back anyway -- while
    // the food bank that really did update after the threshold is, in this
    // case, correctly kept.
    const rows = await getLatestNeedTextsSince(session, "2026-08-15 12:00:00", false);
    expect(rows.map((r) => r.change_text)).toEqual(["ISO stamped, 08:00", "Django stamped, 16:00"]);

    // And the ordering is inverted with it: 08:00 sorts ahead of 16:00.
    const comparison = db.prepare("SELECT ('2026-08-15T08:00:00.000Z' > '2026-08-15 16:00:00.000000') AS inverted").get() as { inverted: number };
    expect(comparison.inverted).toBe(1);
  });

  // THREE networks besides Trussell, not one. With only "Independent" and NULL
  // on the other side, `f.network = 'Trussell'` and `f.network != 'Independent'`
  // return the identical row -- NULL fails both, so the second spelling looks
  // right while quietly admitting every Salvation Army and IFAN food bank on
  // the site (measured: that mutant survived until "Salvation Army" was
  // seeded). The equality has to be pinned against a network that is neither
  // Trussell, nor the one a negation would name, nor NULL.
  it("applies the Trussell filter only when asked, and excludes a NULL network either way", async () => {
    const trussell = seedChange({ change_text: "Trussell need" });
    const independent = seedChange({ change_text: "Independent need" });
    const salvation = seedChange({ change_text: "Salvation Army need" });
    const unknown = seedChange({ change_text: "Unknown network need" });
    seedFoodbank({ network: "Trussell", latest_need_id: trussell, last_need: PY("2026-08-30 09:00:00.000000") });
    seedFoodbank({ network: "Independent", latest_need_id: independent, last_need: PY("2026-08-29 09:00:00.000000") });
    seedFoodbank({ network: "Salvation Army", latest_need_id: salvation, last_need: PY("2026-08-28 09:00:00.000000") });
    seedFoodbank({ network: null, latest_need_id: unknown, last_need: PY("2026-08-27 09:00:00.000000") });

    // /dashboard/trusselltrust/most-requested-items/ -- the network clause is
    // string-concatenated into the SQL, so "the flag is wired to the clause"
    // is a claim worth checking in both directions.
    expect((await getLatestNeedTextsSince(session, THRESHOLD, true)).map((r) => r.change_text)).toEqual(["Trussell need"]);
    expect((await getLatestNeedTextsSince(session, THRESHOLD, false)).map((r) => r.change_text)).toEqual([
      "Trussell need",
      "Independent need",
      "Salvation Army need",
      "Unknown network need",
    ]);
  });

  // JOIN DIRECTION AND CARDINALITY. The FROM side is foodbank and the join
  // key is f.latest_need_id, so the result is one row PER FOOD BANK, not one
  // per need: two food banks that somehow share a latest_need row produce two
  // rows, and a need nothing points at produces none. The caller counts these
  // rows as `number_foodbanks`, so a query that returned one row per need
  // would undercount the dashboard's headline figure.
  it("returns one row per food bank, not one per need", async () => {
    const shared = seedChange({ change_text: "Shared need" });
    seedChange({ change_text: "Orphan need" });
    seedFoodbank({ latest_need_id: shared, last_need: PY("2026-08-30 09:00:00.000000") });
    seedFoodbank({ latest_need_id: shared, last_need: PY("2026-08-29 09:00:00.000000") });

    const rows = await getLatestNeedTextsSince(session, THRESHOLD, false);

    expect(rows.map((r) => r.change_text)).toEqual(["Shared need", "Shared need"]);
  });

  // SUSPECT, PINNED AS-IS. This is an INNER JOIN; Django's
  // `select_related("latest_need")` on a nullable FK is a LEFT OUTER JOIN.
  // A food bank with last_need set but latest_need_id NULL (or pointing at a
  // deleted need) is therefore INVISIBLE here, where Django would have
  // reached `recent_foodbank.latest_need.change_text` and raised
  // AttributeError. Not crashing is an improvement; silently shrinking
  // `number_foodbanks` -- the "N food banks asked for these items" figure on
  // the dashboard -- is the part that is worth knowing about.
  it("silently drops a food bank whose latest_need_id is NULL or dangling", async () => {
    const real = seedChange({ change_text: "Has a need" });
    seedFoodbank({ latest_need_id: real, last_need: PY("2026-08-30 09:00:00.000000") });
    seedFoodbank({ latest_need_id: null, last_need: PY("2026-08-29 09:00:00.000000") });
    seedFoodbank({ latest_need_id: 999_999, last_need: PY("2026-08-28 09:00:00.000000") });

    const rows = await getLatestNeedTextsSince(session, THRESHOLD, false);

    expect(rows.map((r) => r.change_text)).toEqual(["Has a need"]);
  });
});

// ===========================================================================
// getLatestExcessTextsSince -- most_excess_items
// ===========================================================================

describe("getLatestExcessTextsSince", () => {
  it("reads excess_change_text, not change_text, and never filters by network", async () => {
    const trussell = seedChange({ change_text: "NEED not excess", excess_change_text: "Trussell excess" });
    const independent = seedChange({ change_text: "NEED not excess", excess_change_text: "Independent excess" });
    seedFoodbank({ network: "Trussell", latest_need_id: trussell, last_need: PY("2026-08-30 09:00:00.000000") });
    seedFoodbank({ network: "Independent", latest_need_id: independent, last_need: PY("2026-08-29 09:00:00.000000") });

    const rows = await getLatestExcessTextsSince(session, THRESHOLD);

    // most_excess_items has no /trusselltrust/ variant (views.py:146-195), so
    // a copy-paste of getLatestNeedTextsSince that kept the network clause
    // would halve this dashboard without erroring.
    expect(rows.map((r) => r.excess_change_text)).toEqual(["Trussell excess", "Independent excess"]);
  });

  // The NULL is the normal case, not the edge case: most needs carry no
  // excess text at all. Django's loop skips falsy values in Python
  // (`if excess_text:`) and workers/site does the same in JS, so the query's
  // job is to hand the NULLs over untouched. A `WHERE excess_change_text IS
  // NOT NULL` added here would look like a tidy-up and would change the
  // dashboard's `number_foodbanks` denominator.
  it("returns rows whose excess text is NULL rather than filtering them out", async () => {
    const withExcess = seedChange({ excess_change_text: "Tinned tomatoes" });
    const without = seedChange({ excess_change_text: null });
    seedFoodbank({ latest_need_id: withExcess, last_need: PY("2026-08-30 09:00:00.000000") });
    seedFoodbank({ latest_need_id: without, last_need: PY("2026-08-29 09:00:00.000000") });

    const rows = await getLatestExcessTextsSince(session, THRESHOLD);

    expect(rows).toEqual([{ excess_change_text: "Tinned tomatoes" }, { excess_change_text: null }]);
  });

  it("applies the same threshold and last_need DESC ordering", async () => {
    const newer = seedChange({ excess_change_text: "Newer" });
    const older = seedChange({ excess_change_text: "Older" });
    const stale = seedChange({ excess_change_text: "Stale" });
    seedFoodbank({ latest_need_id: older, last_need: PY("2026-08-10 09:00:00.000000") });
    seedFoodbank({ latest_need_id: newer, last_need: PY("2026-08-25 09:00:00.000000") });
    seedFoodbank({ latest_need_id: stale, last_need: PY("2026-07-25 09:00:00.000000") });

    const rows = await getLatestExcessTextsSince(session, THRESHOLD);

    expect(rows.map((r) => r.excess_change_text)).toEqual(["Newer", "Older"]);
  });

  // THE SAME INNER JOIN AS ITS SIBLING, PINNED SEPARATELY. This is a
  // copy-paste of getLatestNeedTextsSince's query with one column changed, and
  // it needs its own copy of the join test: with the NULL/dangling case only
  // ever seeded against the need query, changing THIS `JOIN` to a `LEFT JOIN`
  // passed the entire file (measured -- that mutant survived until this case
  // existed). Under the mutant a food bank with last_need set but
  // latest_need_id NULL arrives as a row of NULLs, and the excess dashboard
  // counts it in the "N food banks" denominator while contributing no items.
  it("silently drops a food bank whose latest_need_id is NULL or dangling", async () => {
    const real = seedChange({ excess_change_text: "Has a need" });
    seedFoodbank({ latest_need_id: real, last_need: PY("2026-08-30 09:00:00.000000") });
    seedFoodbank({ latest_need_id: null, last_need: PY("2026-08-29 09:00:00.000000") });
    seedFoodbank({ latest_need_id: 999_999, last_need: PY("2026-08-28 09:00:00.000000") });

    const rows = await getLatestExcessTextsSince(session, THRESHOLD);

    // One row, and it is the real one -- not "one row" alone, because a LEFT
    // JOIN's phantom rows are indistinguishable from a genuinely NULL
    // excess_change_text by length.
    expect(rows).toEqual([{ excess_change_text: "Has a need" }]);
  });
});

// ===========================================================================
// getNeedItemCategoryCounts / getNeedItemGroupCounts -- item_categories / item_groups
// ===========================================================================

describe("getNeedItemCategoryCounts", () => {
  it("counts need lines per category, most common first", async () => {
    seedChangeLine({ category: "Tinned Goods" });
    seedChangeLine({ category: "Tinned Goods" });
    seedChangeLine({ category: "Tinned Goods" });
    seedChangeLine({ category: "Toiletries" });
    seedChangeLine({ category: "Toiletries" });
    seedChangeLine({ category: "Baby" });

    const rows = await getNeedItemCategoryCounts(session);

    // Three distinct counts, deliberately: with ties, SQLite's row order is
    // unspecified and an assertion on it would be testing the engine's mood.
    // With 3/2/1 a lost `DESC` -- or an ORDER BY on `category` -- fails here.
    expect(rows).toEqual([
      { category: "Tinned Goods", count: 3 },
      { category: "Toiletries", count: 2 },
      { category: "Baby", count: 1 },
    ]);
  });

  it("counts only type = 'need' lines, never excess lines", async () => {
    seedChangeLine({ category: "Tinned Goods", type: "need" });
    seedChangeLine({ category: "Tinned Goods", type: "excess" });
    seedChangeLine({ category: "Tinned Goods", type: "excess" });

    const rows = await getNeedItemCategoryCounts(session);

    // The excess rows outnumber the need row here on purpose: a dropped
    // `type = 'need'` would give 3, which is still a plausible-looking bar on
    // a chart with no other symptom. This dashboard and item_groups are the
    // only readers of fcl_cat_need_idx, which is itself partial on
    // `WHERE type = 'need'` (0003_homepage_data.sql:38).
    expect(rows).toEqual([{ category: "Tinned Goods", count: 1 }]);
  });

  it("returns an empty list rather than a zero row for an empty table", async () => {
    expect(await getNeedItemCategoryCounts(session)).toEqual([]);
  });
});

describe("getNeedItemGroupCounts", () => {
  // "Non-food" IS THE BIGGER GROUP ON PURPOSE, and it sorts after "Food"
  // alphabetically. SQLite answers a GROUP BY through a temp b-tree keyed on
  // the group column, so the rows come back in group-NAME order whether or not
  // the query asks for one -- meaning a fixture whose largest group also
  // happens to be alphabetically first cannot see the `ORDER BY count DESC` at
  // all (measured: with Food=2/Non-food=1, deleting the ORDER BY passed).
  // Inverted, the two orders disagree and the clause becomes observable.
  it("groups by group_name -- Postgres's reserved `group`, renamed in the D1 DDL", async () => {
    seedChangeLine({ group_name: "Non-food", category: "Toiletries" });
    seedChangeLine({ group_name: "Non-food", category: "Baby" });
    seedChangeLine({ group_name: "Food", category: "Tinned Goods" });

    const rows = await getNeedItemGroupCounts(session);

    // The key matters as much as the numbers: Django's queryset says
    // `.values("group")`, the D1 column is `group_name` (0003_homepage_data
    // .sql:32 renamed it to avoid quoting a reserved word in every query),
    // and dash/item_groups.njk indexes the returned object by name. A query
    // that aliased it back to `group` would render an empty table.
    expect(rows).toEqual([
      { group_name: "Non-food", count: 2 },
      { group_name: "Food", count: 1 },
    ]);
  });

  it("counts only type = 'need' lines", async () => {
    seedChangeLine({ group_name: "Food", type: "need" });
    seedChangeLine({ group_name: "Food", type: "excess" });

    expect(await getNeedItemGroupCounts(session)).toEqual([{ group_name: "Food", count: 1 }]);
  });
});

// ===========================================================================
// getTrussellFoodbanksByLastNeed -- tt_old_data
// ===========================================================================

describe("getTrussellFoodbanksByLastNeed", () => {
  function seedTrussell(name: string, lastNeed: string | null): void {
    seedFoodbank({ name, slug: name.toLowerCase().replace(/ /g, "-"), network: "Trussell", last_need: lastNeed, url: `https://${name}.example.org/` });
  }

  it("returns the two opposite slices of one filter", async () => {
    seedTrussell("Alpha", PY("2026-01-05 09:00:00.000000"));
    seedTrussell("Bravo", PY("2026-06-05 09:00:00.000000"));
    seedTrussell("Charlie", PY("2025-03-05 09:00:00.000000"));

    // tt_old_data renders both lists on one page: "recently updated" and
    // "longest since an update". The direction is interpolated into the SQL
    // rather than bound, so both spellings are exercised.
    expect((await getTrussellFoodbanksByLastNeed(session, "DESC", 100)).map((r) => r.name)).toEqual(["Bravo", "Alpha", "Charlie"]);
    expect((await getTrussellFoodbanksByLastNeed(session, "ASC", 100)).map((r) => r.name)).toEqual(["Charlie", "Alpha", "Bravo"]);
  });

  it("excludes closed food banks and other networks", async () => {
    seedTrussell("Open Trussell", PY("2026-06-05 09:00:00.000000"));
    seedFoodbank({ name: "Closed Trussell", slug: "closed", network: "Trussell", is_closed: 1, last_need: PY("2026-06-06 09:00:00.000000") });
    seedFoodbank({ name: "Independent", slug: "independent", network: "Independent", last_need: PY("2026-06-07 09:00:00.000000") });
    seedFoodbank({ name: "No network", slug: "no-network", network: null, last_need: PY("2026-06-08 09:00:00.000000") });

    const rows = await getTrussellFoodbanksByLastNeed(session, "DESC", 100);

    // All three excluded rows have a LATER last_need than the one that
    // survives, so any of the three filters going missing puts a wrong name
    // at the top of the page rather than merely lengthening the list.
    expect(rows.map((r) => r.name)).toEqual(["Open Trussell"]);
  });

  it("honours the limit, keeping the extreme end of the ordering", async () => {
    seedTrussell("Alpha", PY("2026-01-05 09:00:00.000000"));
    seedTrussell("Bravo", PY("2026-06-05 09:00:00.000000"));
    seedTrussell("Charlie", PY("2025-03-05 09:00:00.000000"));

    // LIMIT is a bound parameter, and the route passes 100 (views.py:222-223
    // slices [:100]). A LIMIT applied before the sort -- or a limit bound
    // into the wrong slot -- would return an arbitrary two rows that still
    // happen to be sorted.
    expect((await getTrussellFoodbanksByLastNeed(session, "DESC", 2)).map((r) => r.name)).toEqual(["Bravo", "Alpha"]);
    expect((await getTrussellFoodbanksByLastNeed(session, "ASC", 2)).map((r) => r.name)).toEqual(["Charlie", "Alpha"]);
  });

  // SUSPECT, PINNED AS-IS. SQLite sorts NULL as SMALLER than every value;
  // Postgres sorts it as LARGER (ASC NULLS LAST / DESC NULLS FIRST is its
  // default). This page's whole subject is which Trussell food banks have
  // stale need data, so the inversion lands exactly where it is least
  // welcome: a food bank that has NEVER had a need recorded heads the "oldest
  // data" list here, and headed the "most recent" list in Django. Nothing
  // errors, and both outputs look reasonable at a glance.
  it("puts a NULL last_need first ascending and last descending -- the opposite of Postgres", async () => {
    seedTrussell("Never", null);
    seedTrussell("Old", PY("2025-03-05 09:00:00.000000"));
    seedTrussell("Recent", PY("2026-06-05 09:00:00.000000"));

    expect((await getTrussellFoodbanksByLastNeed(session, "ASC", 100)).map((r) => r.name)).toEqual(["Never", "Old", "Recent"]);
    expect((await getTrussellFoodbanksByLastNeed(session, "DESC", 100)).map((r) => r.name)).toEqual(["Recent", "Old", "Never"]);
  });

  it("returns only the three columns the template reads, each from its own column", async () => {
    seedTrussell("Alpha", PY("2026-01-05 09:00:00.000000"));

    const rows = await getTrussellFoodbanksByLastNeed(session, "DESC", 100);

    // The VALUES as well as the keys: tt_old_data.html turns `url` into the
    // outbound link for each row, and a `name AS url` slip would render a
    // page of links to "Alpha" that all 404 -- while every key-shape
    // assertion still passed (measured: that mutant survived until this
    // asserted the value).
    expect(rows).toEqual([{ name: "Alpha", url: "https://Alpha.example.org/", last_need: "2026-01-05 09:00:00.000000" }]);
    expect(Object.keys(rows[0]!)).toEqual(["name", "url", "last_need"]);
  });
});

// ===========================================================================
// BEAUTYBANKS_PRODUCTS / getBeautyBankProductNeeds -- beautybanks
// ===========================================================================

// Transcribed independently from the Django source
// (foodcharity/gfdash/views.py:247-288) rather than derived from the export
// under test, which would make the comparison circular. The list is what the
// dashboard means by "a beauty product": it drives both the SQL LIKE chain
// and the per-line filter_change_text() highlight in the template, so a
// silent drift between the port and Django changes which needs appear AND
// which lines of them are shown.
const DJANGO_PRODUCTS = [
  "Soap",
  "Shampoo",
  "Shower Gel",
  "Toothpaste",
  "Toothbrush",
  "Tooth brush",
  "Deodorant",
  "Razor",
  "Shaving Gel",
  "Shaving Foam",
  "Conditioner",
  "Sanitary Pad",
  "Sanitary Towel",
  "Tampon",
  "Toiletries",
  "Toiletry",
  "Bubble Bath",
  "Face Wash",
  "Facewash",
  "Moisturiser",
  "SPF",
  "Lip Balm",
  "Lipbalm",
  "Hand Cream",
  "Handcream",
  "Body Wash",
  "Bodywash",
  "Body Lotion",
  "Baby wash",
  "Babywash",
  "Baby lotion",
  "Baby soap",
  "Baby shampoo",
  "Baby oil",
  "Baby powder",
  "Baby cream",
  "Baby wipes",
  "Skin Care",
  "Make Up",
  "Makeup",
];

describe("BEAUTYBANKS_PRODUCTS", () => {
  it("matches gfdash's hardcoded list exactly, in order", () => {
    expect([...BEAUTYBANKS_PRODUCTS]).toEqual(DJANGO_PRODUCTS);
  });

  // FORTY, NOT THIRTY-NINE. dashboards.ts says "39 hardcoded product
  // keywords" at :171, "39 product keywords" at :16 and "the 39-term product
  // keyword chain" at :183; beautybanks.ts:65 repeats it. The array holds 40,
  // and so does Django's -- counted in CPython over gfdash/views.py rather
  // than by eye, because that is the only way anyone was ever going to notice
  // (`len(products)` is 40; the list is 40 lines long and reads as 39 because
  // "Make Up"/"Makeup" and "Toothbrush"/"Tooth brush" look like duplicates).
  // The DATA is a faithful port; the COMMENTS are off by one. Pinned the way
  // textClean.test.ts pins its 173-of-252 entity count: the test states what
  // is true, not what the header claims.
  //
  // The count matters beyond pedantry. dashboards.ts justifies keeping this
  // OR-chain in SQL -- unlike the 254-term London postcode chain and the
  // dynamic foodbank-id chain, both moved to JS -- on the grounds that it is
  // "safely small", and that is only true while the list stays under D1's
  // 100-bound-parameter statement cap. This is exactly the sort of list
  // somebody extends by hand.
  it("holds 40 products, well under D1's 100-bound-parameter statement cap", () => {
    expect(BEAUTYBANKS_PRODUCTS).toHaveLength(40);
    expect(DJANGO_PRODUCTS).toHaveLength(40);
    expect(BEAUTYBANKS_PRODUCTS.length).toBeLessThan(100);
  });
});

describe("getBeautyBankProductNeeds", () => {
  it("binds exactly one LIKE parameter per product, wrapped in wildcards", async () => {
    await getBeautyBankProductNeeds(session);

    const statement = prepared[0]!;
    expect(statement.params).toHaveLength(BEAUTYBANKS_PRODUCTS.length);
    expect(statement.params[0]).toBe("%Soap%");
    expect(statement.params).toContain("%Makeup%");
    // The cap, measured on the statement that actually reaches D1 rather
    // than on the constant. node:sqlite allows 32,766 bindings, so nothing
    // else in this file would ever notice the difference.
    expect(statement.params.length).toBeLessThan(100);
  });

  it("returns the parent's live name and slug from the join, which is what 0019 broke", async () => {
    const foodbank = seedFoodbank({ name: "Salisbury", slug: "salisbury", postcode: "SP2 7RJ", lat_lng: "51.0688,-1.7945" });
    seedChange({ foodbank_id: foodbank, change_text: "Shampoo\nBeans" });

    const rows = await getBeautyBankProductNeeds(session);

    // THE 2026-09-05 500, in test form. This query used to select
    // fc.foodbank_name; 0019 dropped that column and the page returned a 500
    // to every visitor until somebody measured it. Selecting the joined
    // f.name also fixes a second, quieter defect: the cached copy went stale
    // whenever a food bank was renamed.
    expect(rows).toEqual([
      {
        foodbank_id: foodbank,
        foodbank_name: "Salisbury",
        foodbank_slug: "salisbury",
        postcode: "SP2 7RJ",
        lat_lng: "51.0688,-1.7945",
        change_text: "Shampoo\nBeans",
        created: "2024-01-01 12:00:00.000000",
      },
    ]);
  });

  it("matches a product anywhere in the change text and returns each need once", async () => {
    const foodbank = seedFoodbank();
    seedChange({ foodbank_id: foodbank, change_text: "Tinned tomatoes\nBar of soap for the hampers", created: PY("2024-03-03 09:00:00.000000") });
    seedChange({ foodbank_id: foodbank, change_text: "Shampoo\nConditioner\nToothpaste", created: PY("2024-02-02 09:00:00.000000") });
    seedChange({ foodbank_id: foodbank, change_text: "Beans, pasta, rice", created: PY("2024-01-01 09:00:00.000000") });

    const rows = await getBeautyBankProductNeeds(session);

    // Three products match the middle need. The chain is `OR`ed inside one
    // WHERE, not joined -- built as a join against a products table it would
    // return that need three times and the dashboard would list it three
    // times.
    expect(rows.map((r) => r.change_text)).toEqual(["Tinned tomatoes\nBar of soap for the hampers", "Shampoo\nConditioner\nToothpaste"]);
  });

  // PINNED, NOT ENDORSED. Django's `change_text__contains` is Postgres LIKE,
  // which is CASE SENSITIVE; SQLite's LIKE case-folds ASCII by default, so
  // "bar of soap" matches '%Soap%' here and did not in Django. The port is
  // strictly more generous, which for this dashboard is arguably the intent
  // (the highlight step in the template, filteredChangeLines(), is still
  // case-SENSITIVE, so such a need can appear with no highlighted lines at
  // all). Recorded because it is a real behavioural difference between the
  // two systems on a live public page.
  it("matches case-insensitively, unlike Django's case-sensitive contains", async () => {
    const foodbank = seedFoodbank();
    seedChange({ foodbank_id: foodbank, change_text: "bar of soap" });

    expect((await getBeautyBankProductNeeds(session)).map((r) => r.change_text)).toEqual(["bar of soap"]);
  });

  it("excludes unpublished needs and needs mentioning nothing on the list", async () => {
    const foodbank = seedFoodbank();
    seedChange({ foodbank_id: foodbank, change_text: "Shampoo", published: 1, created: PY("2024-03-03 09:00:00.000000") });
    seedChange({ foodbank_id: foodbank, change_text: "Shampoo", published: 0, created: PY("2024-04-04 09:00:00.000000") });
    seedChange({ foodbank_id: foodbank, change_text: "Beans and pasta", published: 1, created: PY("2024-05-05 09:00:00.000000") });

    const rows = await getBeautyBankProductNeeds(session);

    // Both excluded rows are NEWER than the surviving one, so a dropped
    // filter shows up at the top of the page, not at the bottom of it.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.created).toBe("2024-03-03 09:00:00.000000");
  });

  it("orders most recent first across food banks", async () => {
    const a = seedFoodbank({ name: "Alpha", slug: "alpha" });
    const b = seedFoodbank({ name: "Bravo", slug: "bravo" });
    seedChange({ foodbank_id: a, change_text: "Soap", created: PY("2024-02-02 09:00:00.000000") });
    seedChange({ foodbank_id: b, change_text: "Shampoo", created: PY("2024-05-05 09:00:00.000000") });
    seedChange({ foodbank_id: a, change_text: "Razor", created: PY("2024-03-03 09:00:00.000000") });

    const rows = await getBeautyBankProductNeeds(session);

    // The route slices [:50] for all_needs and [:50] again for the London
    // subset with no further sorting, so "most recent 50" is entirely this
    // ORDER BY's responsibility.
    expect(rows.map((r) => r.change_text)).toEqual(["Shampoo", "Razor", "Soap"]);
  });

  // JOIN DIRECTION, and the one place an INNER JOIN is load-bearing rather
  // than incidental. beautybanks.ts calls `n.postcode.startsWith(...)` and
  // `n.lat_lng.split(",")` on every row; both columns are NOT NULL on
  // foodbank, so the INNER JOIN is what guarantees they arrive non-null. A
  // LEFT JOIN "fix" here would hand the route a null postcode and throw a
  // TypeError on the London filter.
  it("drops a need whose foodbank_id is NULL or points at nothing", async () => {
    const foodbank = seedFoodbank();
    seedChange({ foodbank_id: foodbank, change_text: "Soap" });
    seedChange({ foodbank_id: null, change_text: "Shampoo" });
    seedChange({ foodbank_id: 999_999, change_text: "Deodorant" });

    expect((await getBeautyBankProductNeeds(session)).map((r) => r.change_text)).toEqual(["Soap"]);
  });

  // A note on the TypeScript, not on the SQL: BeautyBankNeedRow declares
  // `foodbank_name: string | null`, and the query cannot produce a null
  // there -- foodbank.name is NOT NULL and the join is INNER. The interface
  // is one migration behind the query it describes. Harmless (the route
  // handles null anyway), pinned so the next person to widen the join knows
  // the type is already permissive enough.
  it("cannot return a null foodbank_name, whatever the interface says", async () => {
    const foodbank = seedFoodbank({ name: "Salisbury", slug: "salisbury" });
    seedChange({ foodbank_id: foodbank, change_text: "Soap" });

    expect((await getBeautyBankProductNeeds(session)).every((r) => r.foodbank_name !== null)).toBe(true);
  });
});

// ===========================================================================
// getRecentPublishedChanges -- excess
// ===========================================================================

describe("getRecentPublishedChanges", () => {
  it("reads the foodbankchange_full view and takes foodbank_name from its LEFT JOIN", async () => {
    const foodbank = seedFoodbank({ name: "Salisbury", slug: "salisbury" });
    seedChange({ foodbank_id: foodbank, excess_change_text: "Beans" });

    const rows = await getRecentPublishedChanges(session, 200);

    expect(rows).toEqual([{ foodbank_name: "Salisbury", excess_change_text: "Beans", created: "2024-01-01 12:00:00.000000" }]);
  });

  // THE INNER-VS-LEFT SWAP, made to fail. foodbankchange.foodbank_id is
  // NULLABLE (0001_core.sql:112 -- it is the only one of the six `_full`
  // views whose base column is), and needs submitted before a food bank is
  // attached really do sit there with a NULL parent. If the view were ever
  // rebuilt with a plain JOIN, those rows would vanish from the excess
  // dashboard with no error anywhere -- which is precisely the class of
  // failure 0019 introduced.
  it("keeps a change whose foodbank_id is NULL, with a NULL name", async () => {
    seedChange({ foodbank_id: null, excess_change_text: "Orphan excess" });

    expect(await getRecentPublishedChanges(session, 200)).toEqual([
      { foodbank_name: null, excess_change_text: "Orphan excess", created: "2024-01-01 12:00:00.000000" },
    ]);
  });

  it("excludes unpublished changes", async () => {
    seedChange({ excess_change_text: "Published", published: 1, created: PY("2024-01-01 09:00:00.000000") });
    seedChange({ excess_change_text: "Draft", published: 0, created: PY("2024-09-09 09:00:00.000000") });

    expect((await getRecentPublishedChanges(session, 200)).map((r) => r.excess_change_text)).toEqual(["Published"]);
  });

  // `modified` RUNS BACKWARDS AGAINST `created` HERE, deliberately. Every
  // other fixture in this file leaves the two equal, which makes
  // `ORDER BY modified DESC` -- the other datetime column on the same row, one
  // word away in the query -- indistinguishable from the real thing (measured:
  // that mutant survived the whole file). needcheck rewrites `modified` every
  // time it re-crawls a need, so the two columns genuinely diverge in
  // production and the page would silently reorder itself around edits rather
  // than around when the excess was offered.
  it("orders newest first and applies the limit to that ordering", async () => {
    seedChange({ excess_change_text: "Middle", created: PY("2024-05-05 09:00:00.000000"), modified: PY("2024-05-05 09:00:00.000000") });
    seedChange({ excess_change_text: "Newest", created: PY("2024-09-09 09:00:00.000000"), modified: PY("2024-01-01 09:00:00.000000") });
    seedChange({ excess_change_text: "Oldest", created: PY("2024-01-01 09:00:00.000000"), modified: PY("2024-09-09 09:00:00.000000") });

    expect((await getRecentPublishedChanges(session, 200)).map((r) => r.excess_change_text)).toEqual(["Newest", "Middle", "Oldest"]);
    // views.py:340 slices [:200]; the LIMIT has to bite AFTER the sort or the
    // page shows an arbitrary 200 of the archive instead of the latest 200.
    expect((await getRecentPublishedChanges(session, 2)).map((r) => r.excess_change_text)).toEqual(["Newest", "Middle"]);
  });

  it("returns only the three columns excess.html reads", async () => {
    seedChange({ excess_change_text: "Beans" });

    // The view is `SELECT c.*` plus two joined columns -- 18 columns per row,
    // 200 rows, on a page that renders three of them. Naming the three is the
    // difference between 600 values and 3,600 crossing the wire.
    expect(Object.keys((await getRecentPublishedChanges(session, 200))[0]!)).toEqual(["foodbank_name", "excess_change_text", "created"]);
  });
});

// ===========================================================================
// getFoodbankCreatedDates -- foodbanks_found
// ===========================================================================

describe("getFoodbankCreatedDates", () => {
  it("returns every food bank's created date, oldest first, as plain strings", async () => {
    seedFoodbank({ name: "Second", slug: "second", created: PY("2021-06-06 09:00:00.000000") });
    seedFoodbank({ name: "Third", slug: "third", created: PY("2023-07-07 09:00:00.000000") });
    seedFoodbank({ name: "First", slug: "first", created: PY("2020-05-05 09:00:00.000000") });

    const dates = await getFoodbankCreatedDates(session);

    // The caller builds a CUMULATIVE count -- "how many food banks did we
    // know about at the end of each month" -- so an unsorted result does not
    // produce a wrong total, it produces a monotonic line that goes
    // backwards. Sorted here, in SQL, exactly as Django sorted it in Python
    // (views.py:349-350's `created_dates.sort()`).
    expect(dates).toEqual(["2020-05-05 09:00:00.000000", "2021-06-06 09:00:00.000000", "2023-07-07 09:00:00.000000"]);
  });

  // get_all_foodbanks() is `Foodbank.objects.all()` (utils/cache.py:43) --
  // NOT get_all_open_foodbanks(). A food bank that has since closed was still
  // discovered on its created date, and dropping it would rewrite history:
  // the chart's earlier months would fall every time a food bank closed
  // today.
  it("includes closed food banks", async () => {
    seedFoodbank({ name: "Open", slug: "open", created: PY("2020-05-05 09:00:00.000000"), is_closed: 0 });
    seedFoodbank({ name: "Closed", slug: "closed", created: PY("2021-06-06 09:00:00.000000"), is_closed: 1 });

    expect(await getFoodbankCreatedDates(session)).toHaveLength(2);
  });

  it("returns an empty array for an empty table", async () => {
    expect(await getFoodbankCreatedDates(session)).toEqual([]);
  });
});

// ===========================================================================
// getBeanPastaMonthCounts -- bean_pasta_index
// ===========================================================================

describe("getBeanPastaMonthCounts", () => {
  it("groups by month and counts needs, oldest month first", async () => {
    seedChange({ change_text: "Beans", created: PY("2024-03-01 09:00:00.000000") });
    seedChange({ change_text: "Pasta", created: PY("2024-01-31 23:59:59.999999") });
    seedChange({ change_text: "Beans and pasta", created: PY("2024-03-31 23:59:59.999999") });
    seedChange({ change_text: "Pasta", created: PY("2024-02-15 09:00:00.000000") });

    const rows = await getBeanPastaMonthCounts(session);

    // Two things at once: strftime really does parse Django's six-digit
    // fractional seconds (a format SQLite documents as three digits), and the
    // month boundary falls where the calendar says rather than where a
    // substring of the text would put it.
    expect(rows).toEqual([
      { the_month: "2024-01", count: 1 },
      { the_month: "2024-02", count: 1 },
      { the_month: "2024-03", count: 2 },
    ]);
  });

  it("counts a need mentioning both beans and pasta exactly once", async () => {
    seedChange({ change_text: "Beans\nPasta\nMore beans" });

    // The two LIKEs are OR'd in one WHERE. Written as a UNION ALL, or as two
    // queries summed, this index would double-count every need that asks for
    // both -- which is most of them.
    expect(await getBeanPastaMonthCounts(session)).toEqual([{ the_month: "2024-01", count: 1 }]);
  });

  // Django ran `change_text ~* 'beans'` -- Postgres's case-INSENSITIVE regex.
  // The port uses plain LIKE, relying on SQLite folding ASCII case by
  // default, and dashboards.ts:249-252 says so explicitly. This is the test
  // that checks the claim instead of trusting it: if SQLite's behaviour ever
  // changed (or a `PRAGMA case_sensitive_like` crept in), the index would
  // quietly lose every need that spells the word with a capital.
  it("matches regardless of case, as Postgres's ~* did", async () => {
    seedChange({ change_text: "BEANS", created: PY("2024-01-05 09:00:00.000000") });
    seedChange({ change_text: "Pasta", created: PY("2024-01-06 09:00:00.000000") });
    seedChange({ change_text: "beans", created: PY("2024-01-07 09:00:00.000000") });

    expect(await getBeanPastaMonthCounts(session)).toEqual([{ the_month: "2024-01", count: 3 }]);
  });

  // `~*` is a regex SEARCH, not an anchored match, so Django counted
  // "baked beans" and "pastaghetti" too. LIKE '%beans%' has the same reach --
  // this is parity, not an accident, and an "improvement" to word-boundary
  // matching would silently step away from the Django series this chart is
  // meant to continue.
  it("matches the words inside longer words, exactly as the regex did", async () => {
    seedChange({ change_text: "Baked beans (large)", created: PY("2024-01-05 09:00:00.000000") });
    seedChange({ change_text: "Pastasauce", created: PY("2024-01-06 09:00:00.000000") });

    expect(await getBeanPastaMonthCounts(session)).toEqual([{ the_month: "2024-01", count: 2 }]);
  });

  // ONE UNPUBLISHED ROW PER KEYWORD, WHICH IS NOT PEDANTRY. The predicate is
  // `published = 1 AND (beans OR pasta)`, and SQL binds AND tighter than OR --
  // so losing the parentheses gives `(published = 1 AND beans) OR pasta`,
  // under which every unpublished need mentioning PASTA is counted and every
  // unpublished need mentioning BEANS is not. With only a beans row on the
  // unpublished side that mutant passed (measured); the pasta row is what sees
  // it. needcheck writes unpublished needs continuously, so the mutant would
  // roughly double this index for the current month and leave history alone --
  // a chart that bends upward at the right-hand edge and looks like news.
  it("excludes unpublished needs and needs mentioning neither word", async () => {
    seedChange({ change_text: "Beans", published: 1 });
    seedChange({ change_text: "Beans", published: 0 });
    seedChange({ change_text: "Pasta please", published: 0 });
    seedChange({ change_text: "Nappies and toothpaste", published: 1 });

    expect(await getBeanPastaMonthCounts(session)).toEqual([{ the_month: "2024-01", count: 1 }]);
  });
});

// ===========================================================================
// getDeliveryMonthCounts -- deliveries
// ===========================================================================

describe("getDeliveryMonthCounts", () => {
  beforeEach(() => {
    seedOrder({ delivery_datetime: PY("2024-01-10 09:00:00.000000"), no_items: 10, weight: 1500, calories: 5000 });
    seedOrder({ delivery_datetime: PY("2024-01-20 09:00:00.000000"), no_items: 20, weight: 2400, calories: 7000 });
    seedOrder({ delivery_datetime: PY("2024-02-10 09:00:00.000000"), no_items: 5, weight: 800, calories: 1000 });
  });

  it("counts deliveries per month", async () => {
    expect(await getDeliveryMonthCounts(session, "count")).toEqual([
      { the_month: "2024-01", count: 2 },
      { the_month: "2024-02", count: 1 },
    ]);
  });

  it("sums items per month", async () => {
    expect(await getDeliveryMonthCounts(session, "items")).toEqual([
      { the_month: "2024-01", count: 30 },
      { the_month: "2024-02", count: 5 },
    ]);
  });

  // INTEGER DIVISION, PINNED. weight is INTEGER grams, and `SUM(weight)/1000`
  // truncates in SQLite exactly as it did in the Postgres raw SQL this is
  // ported from (views.py:406) -- 3,900 g is charted as 3 kg, not 3.9. That
  // is faithful, and it is also the single most tempting line in this file to
  // "fix" with a `/ 1000.0`, which would step the whole series away from the
  // numbers Django published.
  it("truncates weight to whole kilograms, matching the Postgres integer division", async () => {
    expect(await getDeliveryMonthCounts(session, "weight")).toEqual([
      { the_month: "2024-01", count: 3 },
      { the_month: "2024-02", count: 0 },
    ]);
  });

  it("sums calories per month", async () => {
    expect(await getDeliveryMonthCounts(session, "calories")).toEqual([
      { the_month: "2024-01", count: 12_000 },
      { the_month: "2024-02", count: 1000 },
    ]);
  });

  it("orders months ascending across a year boundary", async () => {
    seedOrder({ delivery_datetime: PY("2023-12-31 23:00:00.000000") });
    seedOrder({ delivery_datetime: PY("2025-01-01 00:00:00.000000") });

    const rows = await getDeliveryMonthCounts(session, "count");

    // "YYYY-MM" text sorts chronologically only because the month is
    // zero-padded; grouping on a %-m key ("2024-1") would put October before
    // February. The x-axis is rendered straight from this order.
    expect(rows.map((r) => r.the_month)).toEqual(["2023-12", "2024-01", "2024-02", "2025-01"]);
  });

  // The metric is a fixed-string substitution from an allowlist, chosen by
  // the route from a four-value enum (dashboards.ts:276-280). All four are
  // exercised above; this pins that they really are four DIFFERENT
  // aggregates and not, say, three aliases of COUNT(*) -- a copy-paste in
  // that table would give every chart the same shape with no error at all.
  it("gives each metric a distinct aggregate", async () => {
    const [count, items, weight, calories] = await Promise.all([
      getDeliveryMonthCounts(session, "count"),
      getDeliveryMonthCounts(session, "items"),
      getDeliveryMonthCounts(session, "weight"),
      getDeliveryMonthCounts(session, "calories"),
    ]);
    const january = [count[0]!.count, items[0]!.count, weight[0]!.count, calories[0]!.count];

    expect(new Set(january).size).toBe(4);
  });
});

// ===========================================================================
// getSupermarketDonationPointCounts / Total -- supermarkets
// ===========================================================================

describe("getSupermarketDonationPointCounts", () => {
  it("counts donation points per company, most first", async () => {
    seedDonationPoint({ company: "Tesco" });
    seedDonationPoint({ company: "Tesco" });
    seedDonationPoint({ company: "Tesco" });
    seedDonationPoint({ company: "Sainsbury's" });
    seedDonationPoint({ company: "Sainsbury's" });
    seedDonationPoint({ company: "Co-op" });

    expect(await getSupermarketDonationPointCounts(session)).toEqual([
      { company: "Tesco", count: 3 },
      { company: "Sainsbury's", count: 2 },
      { company: "Co-op", count: 1 },
    ]);
  });

  it("excludes donation points with no company at all", async () => {
    seedDonationPoint({ company: "Tesco" });
    seedDonationPoint({ company: null });
    seedDonationPoint({ company: null });

    // Most donation points are church halls and community centres with a
    // NULL company; they outnumber the supermarkets. A dropped
    // `company IS NOT NULL` would put a giant unlabelled bar at the top of
    // this chart rather than failing.
    expect(await getSupermarketDonationPointCounts(session)).toEqual([{ company: "Tesco", count: 1 }]);
  });

  // Pinned because `IS NOT NULL` and "has a company" are not the same claim,
  // and Django's `company__isnull=False` drew the line in exactly the same
  // place. An empty-string company is a data-entry artefact that both
  // systems count and chart under a blank label.
  it("counts an empty-string company, which is not NULL", async () => {
    seedDonationPoint({ company: "" });

    expect(await getSupermarketDonationPointCounts(session)).toEqual([{ company: "", count: 1 }]);
  });

  // Django applied no is_closed filter here either (views.py:427), so this is
  // parity and not an oversight -- the chart is "how many supermarket
  // donation points have we ever recorded", not "how many are open today".
  it("counts closed donation points", async () => {
    seedDonationPoint({ company: "Tesco", is_closed: 1 });

    expect(await getSupermarketDonationPointCounts(session)).toEqual([{ company: "Tesco", count: 1 }]);
  });
});

describe("getSupermarketDonationPointTotal", () => {
  it("counts rows, not distinct companies, under the same filter", async () => {
    seedDonationPoint({ company: "Tesco" });
    seedDonationPoint({ company: "Tesco" });
    seedDonationPoint({ company: "Co-op" });
    seedDonationPoint({ company: null });

    // The page reads this as the denominator for each company's share, so
    // COUNT(DISTINCT company) here -- 2 instead of 3 -- would show every
    // supermarket with an inflated percentage and still add up to something
    // that looks like a chart.
    expect(await getSupermarketDonationPointTotal(session)).toBe(3);
  });

  it("returns 0 rather than null for an empty table", async () => {
    // COUNT(*) always returns exactly one row holding a number, so the `?? 0`
    // fallback is genuinely unreachable -- changing it to `?? -1` breaks no
    // test here, and that was measured rather than assumed. It stays because
    // the function's declared return type is `number` and `.first()` is typed
    // as nullable; the assertion below is about the query, not the fallback.
    expect(await getSupermarketDonationPointTotal(session)).toBe(0);
  });
});

// ===========================================================================
// getCharityYearAggregates -- charity_income_expenditure
// ===========================================================================

describe("getCharityYearAggregates", () => {
  it("sums income and expenditure per year, newest year first", async () => {
    const foodbank = seedFoodbank({ charity_just_foodbank: 1 });
    seedCharityYear({ foodbank_id: foodbank, date: "2023-03-31", income: 100, expenditure: 90 });
    seedCharityYear({ foodbank_id: foodbank, date: "2025-03-31", income: 300, expenditure: 250 });
    seedCharityYear({ foodbank_id: foodbank, date: "2024-03-31", income: 200, expenditure: 150 });

    const rows = await getCharityYearAggregates(session, 2021);

    // `year` comes back as the TEXT strftime produced, not an integer --
    // the template prints it, so a change to CAST(... AS INTEGER) in the
    // SELECT list would be invisible here but visible on the page.
    expect(rows).toEqual([
      { year: "2025", income: 300, expenditure: 250 },
      { year: "2024", income: 200, expenditure: 150 },
      { year: "2023", income: 100, expenditure: 90 },
    ]);
  });

  it("sums across food banks within a year", async () => {
    const a = seedFoodbank({ name: "Alpha", slug: "alpha", charity_just_foodbank: 1 });
    const b = seedFoodbank({ name: "Bravo", slug: "bravo", charity_just_foodbank: 1 });
    seedCharityYear({ foodbank_id: a, date: "2024-03-31", income: 100, expenditure: 90 });
    seedCharityYear({ foodbank_id: b, date: "2024-12-31", income: 200, expenditure: 150 });

    // Two different year-end dates inside one calendar year: the GROUP BY is
    // on the year extracted from the date, not on the date itself. Grouped by
    // the raw date, this chart would sprout one bar per charity year-end.
    expect(await getCharityYearAggregates(session, 2021)).toEqual([{ year: "2024", income: 300, expenditure: 240 }]);
  });

  it("counts only food banks whose charity is JUST the food bank", async () => {
    const just = seedFoodbank({ name: "Just", slug: "just", charity_just_foodbank: 1 });
    const notJust = seedFoodbank({ name: "Church", slug: "church", charity_just_foodbank: 0 });
    seedCharityYear({ foodbank_id: just, date: "2024-03-31", income: 100, expenditure: 90 });
    seedCharityYear({ foodbank_id: notJust, date: "2024-03-31", income: 5_000_000, expenditure: 4_000_000 });

    // The excluded row is a parent church or trust whose accounts dwarf the
    // food bank's. That is the entire point of the filter, and a chart with
    // it missing looks like a chart -- just one about a different subject.
    expect(await getCharityYearAggregates(session, 2021)).toEqual([{ year: "2024", income: 100, expenditure: 90 }]);
  });

  it("includes the sinceYear itself and excludes the year before it", async () => {
    const foodbank = seedFoodbank({ charity_just_foodbank: 1 });
    seedCharityYear({ foodbank_id: foodbank, date: "2020-12-31", income: 1, expenditure: 1 });
    seedCharityYear({ foodbank_id: foodbank, date: "2021-01-01", income: 2, expenditure: 2 });

    // Django's `date__year__gte=five_years_ago` is inclusive; `>` instead of
    // `>=` here would silently drop the oldest of the five bars.
    expect(await getCharityYearAggregates(session, 2021)).toEqual([{ year: "2021", income: 2, expenditure: 2 }]);
  });

  it("drops a charity year whose foodbank_id points at nothing", async () => {
    const foodbank = seedFoodbank({ charity_just_foodbank: 1 });
    seedCharityYear({ foodbank_id: foodbank, date: "2024-03-31", income: 100, expenditure: 90 });
    seedCharityYear({ foodbank_id: 999_999, date: "2024-03-31", income: 500, expenditure: 400 });
    seedCharityYear({ foodbank_id: null, date: "2024-03-31", income: 700, expenditure: 600 });

    // D1 declares no foreign keys (PLAN.md §4.5), so orphan charityyear rows
    // are possible in a way Postgres would not have allowed. Note WHICH part
    // of the query excludes them: not the join type but the WHERE clause --
    // an orphan's `f.charity_just_foodbank` is NULL, `NULL = 1` is NULL, and
    // a WHERE drops it. Swapping this JOIN for a LEFT JOIN changes nothing
    // here (measured: that mutant survives this whole file, and it should).
    // The predicate is the load-bearing part, and it is the one that must not
    // move into the JOIN's ON clause, where a LEFT JOIN would then keep every
    // orphan row with a NULL year.
    expect(await getCharityYearAggregates(session, 2021)).toEqual([{ year: "2024", income: 100, expenditure: 90 }]);
  });

  // NULL handling in the WHERE clause, which is where this file's sibling
  // suites keep finding live bugs. `strftime('%Y', NULL)` is NULL,
  // `CAST(NULL AS INTEGER)` is NULL, and `NULL >= 2021` is NULL -- so the row
  // is dropped, silently and correctly. Worth pinning because charityyear
  // .date IS nullable (0005_orders_and_charity.sql:53) and the obvious
  // alternative spelling, a COALESCE to 0, would keep the row and add a
  // phantom "0" bar.
  it("drops a charity year with no date at all", async () => {
    const foodbank = seedFoodbank({ charity_just_foodbank: 1 });
    seedCharityYear({ foodbank_id: foodbank, date: null, income: 100, expenditure: 90 });

    expect(await getCharityYearAggregates(session, 2021)).toEqual([]);
  });

  it("ignores NULL income within a year rather than nulling the whole sum", async () => {
    const foodbank = seedFoodbank({ charity_just_foodbank: 1 });
    seedCharityYear({ foodbank_id: foodbank, date: "2024-03-31", income: null, expenditure: 90 });
    seedCharityYear({ foodbank_id: foodbank, date: "2024-06-30", income: 100, expenditure: null });

    // SQL SUM skips NULLs, matching Django's Sum(). A charity that filed
    // expenditure but not income does not wipe out the other food banks in
    // its year.
    expect(await getCharityYearAggregates(session, 2021)).toEqual([{ year: "2024", income: 100, expenditure: 90 }]);
  });
});

// ===========================================================================
// getOrderWeightTotals / getOrderCalorieTotals -- price_per_kg / price_per_calorie
// ===========================================================================

describe("getOrderWeightTotals", () => {
  it("sums items, converts grams to tonnes as a float, and counts distinct food banks", async () => {
    const a = seedFoodbank({ name: "Alpha", slug: "alpha" });
    const b = seedFoodbank({ name: "Bravo", slug: "bravo" });
    seedOrder({ foodbank_id: a, no_items: 10, weight: 1_500_000 });
    seedOrder({ foodbank_id: a, no_items: 20, weight: 2_500_000 });
    seedOrder({ foodbank_id: b, no_items: 5, weight: 1_000_000 });

    // `/ 1000000.0`, with the decimal point, is what keeps this one a float
    // where the deliveries chart's `/ 1000` is deliberately integer. 5
    // tonnes, not 5.0 rounded from an int -- change the literal to 1000000
    // and every headline weight on the site rounds down to whole tonnes.
    expect(await getOrderWeightTotals(session)).toEqual({ items: 35, weightTonnes: 5, numberFoodbanks: 2 });
  });

  it("keeps the fractional part of the tonnage", async () => {
    seedOrder({ weight: 1_500_000, foodbank_id: seedFoodbank() });

    expect((await getOrderWeightTotals(session)).weightTonnes).toBeCloseTo(1.5, 10);
  });

  // SUSPECT, PINNED AS-IS. COUNT(DISTINCT foodbank_id) skips NULLs; Django's
  // `Order.objects.values('foodbank').distinct().count()` treated NULL as a
  // group of its own and counted it. So an order with no food bank attached
  // moved this figure by one in Django and moves it by nothing here. Both
  // numbers are defensible; they are not the same number, and the page says
  // "delivered to N food banks".
  it("does not count orders with no food bank, unlike Django's distinct()", async () => {
    const a = seedFoodbank();
    seedOrder({ foodbank_id: a });
    seedOrder({ foodbank_id: null });
    seedOrder({ foodbank_id: null });

    expect((await getOrderWeightTotals(session)).numberFoodbanks).toBe(1);
  });

  // The `?? 0` on every field, exercised. SUM over no rows is NULL, not 0 --
  // and this shape is a real state, not a hypothetical: the orders table is a
  // one-time read-only snapshot (0005's header) and an environment loaded
  // without it renders this page rather than 500ing. `null / 1000000.0` would
  // reach the template as NaN.
  it("returns zeros, not nulls, when there are no orders", async () => {
    expect(await getOrderWeightTotals(session)).toEqual({ items: 0, weightTonnes: 0, numberFoodbanks: 0 });
  });
});

describe("getOrderCalorieTotals", () => {
  // TWO ORDERS FOR ONE FOOD BANK AND ONE ORPHAN ORDER, matching what the
  // weight sibling seeds. One order per food bank plus nothing else -- the
  // shape this test had -- makes COUNT(DISTINCT foodbank_id), COUNT(foodbank_id)
  // and COUNT(*) all return the same 2, so neither dropping the DISTINCT nor
  // widening it to COUNT(*) failed anything (both measured as survivors). The
  // page renders this as "delivered to N food banks", and the real orders table
  // holds many orders per food bank and a tail of unattached ones, so both
  // mutants would inflate that headline against a fixture that could not see
  // them.
  it("sums items and calories and counts distinct food banks", async () => {
    const a = seedFoodbank({ name: "Alpha", slug: "alpha" });
    const b = seedFoodbank({ name: "Bravo", slug: "bravo" });
    seedOrder({ foodbank_id: a, no_items: 10, calories: 1000 });
    seedOrder({ foodbank_id: a, no_items: 5, calories: 500 });
    seedOrder({ foodbank_id: b, no_items: 20, calories: 2000 });
    seedOrder({ foodbank_id: null, no_items: 1, calories: 100 });

    // Calories are NOT divided by anything here, where the weight sibling
    // divides by a million. Two near-identical queries, one difference; a
    // copy-paste that carried the divisor across would under-report by six
    // orders of magnitude and still render.
    //
    // The orphan order's items and calories DO count -- only the food bank
    // tally skips it, exactly as in getOrderWeightTotals.
    expect(await getOrderCalorieTotals(session)).toEqual({ items: 36, calories: 3600, numberFoodbanks: 2 });
  });

  it("returns zeros, not nulls, when there are no orders", async () => {
    expect(await getOrderCalorieTotals(session)).toEqual({ items: 0, calories: 0, numberFoodbanks: 0 });
  });
});

// ===========================================================================
// getPricePerKgByMonth -- price_per_kg
// ===========================================================================

describe("getPricePerKgByMonth", () => {
  it("returns year and month as integers with the price per kg", async () => {
    seedOrder({ delivery_datetime: PY("2024-03-10 09:00:00.000000"), cost: 5000, weight: 10_000 });

    // Django handed the template TruncMonth/TruncYear date objects; the
    // ported template indexes plain numbers instead (dashboards.ts:385-386),
    // so the CASTs are part of the contract. Without them these come back as
    // the strings "2024" and "03", and `{{ row.month }}` renders "03" while
    // any arithmetic on it silently changes meaning.
    expect(await getPricePerKgByMonth(session)).toEqual([{ year: 2024, month: 3, price: 500 }]);
  });

  it("groups by year AND month, so the same month in two years stays apart", async () => {
    seedOrder({ delivery_datetime: PY("2024-01-10 09:00:00.000000"), cost: 1000, weight: 1000 });
    seedOrder({ delivery_datetime: PY("2025-01-10 09:00:00.000000"), cost: 4000, weight: 1000 });
    seedOrder({ delivery_datetime: PY("2024-02-10 09:00:00.000000"), cost: 2000, weight: 1000 });

    const rows = await getPricePerKgByMonth(session);

    // GROUP BY month alone would fold January 2024 and January 2025 into one
    // point and halve the length of the series -- a chart that still draws,
    // with a shorter x-axis nobody counts.
    expect(rows).toEqual([
      { year: 2024, month: 1, price: 1000 },
      { year: 2024, month: 2, price: 2000 },
      { year: 2025, month: 1, price: 4000 },
    ]);
  });

  // THE TWO ORDERS MUST HAVE DIFFERENT PRICES PER KILO, or this test is
  // measuring nothing. It previously seeded 1000p/1000g and 3000p/3000g --
  // both exactly 1000p/kg -- so `AVG((cost * 1000) / weight)`, the natural
  // wrong way to write this, produced the identical 1000 and survived
  // (measured). Its own comment claimed the uneven truncation case below
  // covered the gap; that case has a single order, where a mean and a ratio of
  // sums always agree, so nothing covered it.
  //
  // A cheap 333p/kg order and a dear 1000p/kg one now disagree by design: the
  // ratio of sums is 400p/kg, the mean of the two prices is 666p/kg. Weighting
  // is the whole point of the figure -- one enormous cheap pallet has to move
  // the month more than one small expensive delivery, which is what Django's
  // Sum('cost')*1000/Sum('weight') did.
  it("sums cost and weight across the month before dividing", async () => {
    seedOrder({ delivery_datetime: PY("2024-03-01 09:00:00.000000"), cost: 1000, weight: 1000 });
    seedOrder({ delivery_datetime: PY("2024-03-02 09:00:00.000000"), cost: 3000, weight: 9000 });

    expect(await getPricePerKgByMonth(session)).toEqual([{ year: 2024, month: 3, price: 400 }]);
  });

  // INTEGER DIVISION AGAIN, and this one is faithful: Postgres divided two
  // integer sums here too (views.py:452's `Sum('cost')*1000/Sum('weight')`).
  // 3000 * 1000 / 7000 is 428.57p and both engines chart 428.
  it("truncates the price rather than rounding it", async () => {
    seedOrder({ delivery_datetime: PY("2024-03-01 09:00:00.000000"), cost: 3000, weight: 7000 });

    expect(await getPricePerKgByMonth(session)).toEqual([{ year: 2024, month: 3, price: 428 }]);
  });

  // SQLite returns NULL for division by zero where Postgres raises. So a
  // month of zero-weight orders charts as a gap here and 500'd in Django.
  // Pinned rather than guarded: the fix, if it is ever wanted, belongs in the
  // template, and a NULLIF added here would change nothing visible while
  // making this test fail for the wrong reason.
  it("returns a null price for a month whose orders weigh nothing", async () => {
    seedOrder({ delivery_datetime: PY("2024-03-01 09:00:00.000000"), cost: 1000, weight: 0 });

    expect(await getPricePerKgByMonth(session)).toEqual([{ year: 2024, month: 3, price: null }]);
  });
});

// ===========================================================================
// getPricePerCalorieByMonth -- price_per_calorie
// ===========================================================================

describe("getPricePerCalorieByMonth", () => {
  it("returns year, month and price from orderline, oldest month first", async () => {
    seedOrderLine({ delivery_date: "2024-03-10", line_cost: 500, calories: 1000 });
    seedOrderLine({ delivery_date: "2024-01-10", line_cost: 100, calories: 1000 });

    // Over OrderLine, not Order -- the sibling query above reads `orders`.
    // Both name a delivery column and both come back as {year, month, price},
    // so a table swap here is invisible in the shape of the result and
    // visible only in the numbers.
    expect(await getPricePerCalorieByMonth(session)).toEqual([
      { year: 2024, month: 1, price: 200 },
      { year: 2024, month: 3, price: 1000 },
    ]);
  });

  it("excludes lines with no calories, or with zero", async () => {
    seedOrderLine({ delivery_date: "2024-03-10", line_cost: 500, calories: 1000 });
    seedOrderLine({ delivery_date: "2024-03-11", line_cost: 900, calories: 0 });
    seedOrderLine({ delivery_date: "2024-03-12", line_cost: 900, calories: null });

    // `calories > 0` is Django's `calories__gt=0`, and it is doing two jobs:
    // keeping non-food lines out of a food price index, and keeping the
    // denominator away from zero. Both excluded lines carry a large cost, so
    // if either slipped in the March price would nearly triple.
    expect(await getPricePerCalorieByMonth(session)).toEqual([{ year: 2024, month: 3, price: 1000 }]);
  });

  // The port adds `delivery_date IS NOT NULL`, which Django did not have.
  // Django's TruncMonth(NULL) produced a None month and views.py:507's
  // `row['month'].strftime(...)` would have raised AttributeError on it; the
  // filter is how the port declines to crash. Without it the CAST produces a
  // NULL year/month pair that sorts to the front of the series and renders as
  // an unlabelled first bar.
  it("excludes lines that have no delivery date", async () => {
    seedOrderLine({ delivery_date: null, line_cost: 900, calories: 1000 });
    seedOrderLine({ delivery_date: "2024-03-10", line_cost: 500, calories: 1000 });

    expect(await getPricePerCalorieByMonth(session)).toEqual([{ year: 2024, month: 3, price: 1000 }]);
  });

  it("sums the whole month before dividing, and truncates", async () => {
    seedOrderLine({ delivery_date: "2024-03-01", line_cost: 100, calories: 300 });
    seedOrderLine({ delivery_date: "2024-03-02", line_cost: 200, calories: 400 });

    // (100+200) * 2000 / (300+400) = 857.14 -> 857.
    expect(await getPricePerCalorieByMonth(session)).toEqual([{ year: 2024, month: 3, price: 857 }]);
  });

  it("keeps the same month of different years apart", async () => {
    seedOrderLine({ delivery_date: "2024-03-01", line_cost: 100, calories: 1000 });
    seedOrderLine({ delivery_date: "2025-03-01", line_cost: 300, calories: 1000 });

    expect(await getPricePerCalorieByMonth(session)).toEqual([
      { year: 2024, month: 3, price: 200 },
      { year: 2025, month: 3, price: 600 },
    ]);
  });
});

// ===========================================================================
// getOrderLineCategoryTotals -- price_per_item_category, stage 1
// ===========================================================================

function seedLines(count: number, row: Partial<Record<string, Bindable>>): void {
  for (let i = 0; i < count; i += 1) seedOrderLine(row);
}

describe("getOrderLineCategoryTotals", () => {
  // THE BOUNDARY IS THE WHOLE FUNCTION. MIN_ITEMS_FOR_CATEGORY is 100
  // (views.py:475) and the comparison is `>=`, so a category with exactly 100
  // lines qualifies and one with 99 does not. `>` instead of `>=` would drop
  // whichever categories sit exactly on the line -- a silent, plausible,
  // one-category-shorter chart. Seeding 100 and 99 rows is cheap and is the
  // only way to test a HAVING threshold honestly.
  //
  // THE QUANTITIES ARE NOT 1, and that is the second half of this test.
  // Django counts LINES (`Count('id')`, views.py:479) -- a line ordering 500
  // tins is one line. With every fixture line carrying the default quantity of
  // 1, `COUNT(*)` and `SUM(quantity)` are the same number everywhere and the
  // swap survived the whole file (measured). Here the 99-line category orders
  // five at a time: 99 lines is below the threshold, 495 items is not, so the
  // mutant admits a category the real query rejects -- and the 100-line
  // category's own total_count would read 200 rather than 100.
  it("keeps a category with exactly 100 lines and drops one with 99", async () => {
    seedLines(100, { category: "Tinned Goods", quantity: 2 });
    seedLines(99, { category: "Toiletries", quantity: 5 });

    expect(await getOrderLineCategoryTotals(session)).toEqual([{ category: "Tinned Goods", total_count: 100 }]);
  });

  it("orders qualifying categories by count, largest first", async () => {
    seedLines(150, { category: "Tinned Goods" });
    seedLines(100, { category: "Dry Goods" });
    seedLines(120, { category: "Toiletries" });

    const rows = await getOrderLineCategoryTotals(session);

    // The route passes these names straight to the template as
    // `category_names`, which is the chart's legend order.
    expect(rows).toEqual([
      { category: "Tinned Goods", total_count: 150 },
      { category: "Toiletries", total_count: 120 },
      { category: "Dry Goods", total_count: 100 },
    ]);
  });

  // A DELIBERATE DIVERGENCE FROM DJANGO, pinned so it is not mistaken for an
  // accident. views.py:478-484 groups uncategorised lines too, so a NULL
  // category with 100+ lines qualified, was passed into stage 2 as a NULL
  // inside an `IN (...)` list -- which matches nothing in SQL -- and appeared
  // in the legend as an empty label with no data. The port's
  // `category IS NOT NULL` removes the phantom entry at source.
  it("excludes uncategorised lines entirely, however many there are", async () => {
    seedLines(500, { category: null });
    seedLines(100, { category: "Tinned Goods" });

    expect(await getOrderLineCategoryTotals(session)).toEqual([{ category: "Tinned Goods", total_count: 100 }]);
  });

  it("counts lines with no delivery date, unlike stage 2", async () => {
    seedLines(100, { category: "Tinned Goods", delivery_date: null });

    // Stage 1 has no delivery_date filter and stage 2 does. That asymmetry is
    // real and deliberate -- a category can qualify on undated lines and then
    // contribute no monthly points -- and it is pinned here so that "make the
    // two stages consistent" is a decision someone takes on purpose.
    expect(await getOrderLineCategoryTotals(session)).toEqual([{ category: "Tinned Goods", total_count: 100 }]);
  });

  it("returns an empty list when nothing reaches the threshold", async () => {
    seedLines(99, { category: "Tinned Goods" });

    expect(await getOrderLineCategoryTotals(session)).toEqual([]);
  });
});

// ===========================================================================
// getOrderLineCategoryMonthPrices -- price_per_item_category, stage 2
// ===========================================================================

describe("getOrderLineCategoryMonthPrices", () => {
  it("returns one price point per month per requested category, month then category", async () => {
    seedOrderLine({ delivery_date: "2024-01-10", category: "Tinned Goods", item_cost: 100 });
    seedOrderLine({ delivery_date: "2024-01-11", category: "Tinned Goods", item_cost: 300 });
    seedOrderLine({ delivery_date: "2024-01-12", category: "Dry Goods", item_cost: 500 });
    seedOrderLine({ delivery_date: "2024-02-10", category: "Tinned Goods", item_cost: 250 });
    seedOrderLine({ delivery_date: "2024-02-11", category: "Dry Goods", item_cost: 700 });

    const rows = await getOrderLineCategoryMonthPrices(session, ["Tinned Goods", "Dry Goods"]);

    // ORDER BY the_month, category -- month FIRST. Both categories appear in
    // both months on purpose: with a sparser fixture, `ORDER BY category,
    // the_month` produces the identical sequence and the test proves nothing
    // (measured -- that mutant survived the three-row version of this case).
    // The route folds these rows into one array per category aligned against
    // a sorted month list, so the ordering is what keeps a category's series
    // aligned with its own months rather than with someone else's.
    expect(rows).toEqual([
      { the_month: "2024-01", category: "Dry Goods", price_per_item: 500 },
      { the_month: "2024-01", category: "Tinned Goods", price_per_item: 200 },
      { the_month: "2024-02", category: "Dry Goods", price_per_item: 700 },
      { the_month: "2024-02", category: "Tinned Goods", price_per_item: 250 },
    ]);
  });

  it("ignores categories that were not asked for", async () => {
    seedOrderLine({ delivery_date: "2024-01-10", category: "Tinned Goods", item_cost: 100 });
    seedOrderLine({ delivery_date: "2024-01-10", category: "Household", item_cost: 900 });

    // The IN list is the only thing tying stage 2 to stage 1's qualifying
    // set. Lost, this chart would sprout a line for every category in the
    // database including the ones with three items in them.
    expect(await getOrderLineCategoryMonthPrices(session, ["Tinned Goods"])).toEqual([
      { the_month: "2024-01", category: "Tinned Goods", price_per_item: 100 },
    ]);
  });

  it("excludes lines with no delivery date", async () => {
    seedOrderLine({ delivery_date: null, category: "Tinned Goods", item_cost: 900 });
    seedOrderLine({ delivery_date: "2024-01-10", category: "Tinned Goods", item_cost: 100 });

    // Without the filter, `strftime('%Y-%m', NULL)` is NULL, which becomes
    // its own group and reaches the route as `the_month: null` -- pushed
    // through JSON.stringify into the chart's month axis as a null label.
    expect(await getOrderLineCategoryMonthPrices(session, ["Tinned Goods"])).toEqual([
      { the_month: "2024-01", category: "Tinned Goods", price_per_item: 100 },
    ]);
  });

  it("divides the month's total cost by the LINE count and truncates", async () => {
    seedOrderLine({ delivery_date: "2024-01-10", category: "Tinned Goods", item_cost: 100, quantity: 5 });
    seedOrderLine({ delivery_date: "2024-01-11", category: "Tinned Goods", item_cost: 101, quantity: 1 });

    // COUNT(*), matching Django's Count('id') -- lines, not items. A
    // SUM(quantity) denominator would look more like a per-item price and
    // would not be the series Django published. 201/2 = 100.5 -> 100.
    expect(await getOrderLineCategoryMonthPrices(session, ["Tinned Goods"])).toEqual([
      { the_month: "2024-01", category: "Tinned Goods", price_per_item: 100 },
    ]);
  });

  it("goes nowhere near the database for an empty category list", async () => {
    const rows = await getOrderLineCategoryMonthPrices(session, []);

    // The early return is not just an optimisation: `IN ()` is a syntax error
    // in SQLite, so without it a database with no qualifying category at all
    // would 500 the whole page rather than drawing an empty chart.
    expect(rows).toEqual([]);
    expect(prepared).toEqual([]);
  });

  // ==========================================================================
  // D1's 100-bound-parameter cap
  // ==========================================================================
  // This is the only variable-length parameter list in the module, and it is
  // NOT chunked -- unlike needAdmin.ts:307-330, which slices its id lists at
  // 90 for exactly this reason, and unlike needs.ts:122 and
  // findLocationsByCategory.ts:24, which both restructured their queries to
  // avoid an unbounded list.
  //
  // node:sqlite allows 32,766 bindings, so an over-cap statement runs
  // perfectly here and fails only on D1. The tests therefore assert on the
  // BINDING COUNT, which is the thing D1 actually rejects, rather than on
  // whether rows come back.

  it("binds exactly one parameter per category name", async () => {
    const names = Array.from({ length: 12 }, (_, i) => `Category ${i}`);

    await getOrderLineCategoryMonthPrices(session, names);

    const statement = prepared[0]!;
    expect(statement.params).toEqual(names);
    // Placeholders and bindings have to agree, or SQLite rejects the
    // statement outright -- counted from the SQL rather than trusted.
    expect(statement.sql.match(/\?/g)).toHaveLength(names.length);
  });

  it("still fits inside D1's cap at exactly 100 categories", async () => {
    const names = Array.from({ length: 100 }, (_, i) => `Category ${i}`);

    await getOrderLineCategoryMonthPrices(session, names);

    expect(prepared[0]!.params).toHaveLength(100);
  });

  // SUSPECT, PINNED AS-IS PER TESTING.md -- this asserts what the code DOES,
  // which is to build a 101-parameter statement. On D1 that statement is
  // rejected ("too many SQL variables"), taking
  // /dashboard/price-per/item-category/ down completely; here it simply runs.
  // Reaching 101 needs 101 distinct orderline categories with 100+ lines
  // each, which today's data is nowhere near -- so this is a latent cliff
  // rather than a live outage, and the test exists to make sure the next
  // person to look at it does not have to rediscover the cap from a
  // production error.
  it("builds an over-cap statement at 101 categories instead of chunking", async () => {
    const names = Array.from({ length: 101 }, (_, i) => `Category ${i}`);

    await getOrderLineCategoryMonthPrices(session, names);

    expect(prepared).toHaveLength(1);
    expect(prepared[0]!.params).toHaveLength(101);
    expect(prepared[0]!.params.length).toBeGreaterThan(100);
  });
});

// ===========================================================================
// The seven ORDER BY clauses SQLite answers correctly without
// ===========================================================================
// EVERY OTHER ORDERING IN THIS FILE IS PINNED BY ITS ROWS, and should be --
// asserting SQL text instead of results is normally how a test stops testing
// anything. These seven are the measured exception: delete the ORDER BY and
// the rows come back in the right order anyway, so no fixture of any size can
// see the clause. Two separate mechanisms, both verified with EXPLAIN QUERY
// PLAN against this file's schema rather than assumed:
//
//   * getBeautyBankProductNeeds and getRecentPublishedChanges both filter on
//     `published = 1`, and 0001_core.sql gives foodbankchange the partial
//     index change_pub_created_idx (published, created DESC) WHERE published
//     = 1. SQLite picks it either way -- the plan is byte-identical with and
//     without the clause -- and walking it hands back created-DESC rows for
//     free. On D1 the same index exists, so today the mutant is genuinely
//     invisible; it stops being invisible the moment a migration drops or
//     renames that index, or the planner meets real cardinalities and
//     chooses a scan. At that point the excess dashboard and beautybanks
//     silently start showing an arbitrary 200 and an arbitrary 50 needs.
//
//   * The other five restate their GROUP BY key ("GROUP BY the_month ORDER BY
//     the_month"). SQLite groups through a temp b-tree, so the output already
//     arrives in key order. Here the clause is insurance against the GROUP BY
//     changing underneath it -- add a column to the grouping, or an aggregate
//     the planner satisfies from an index, and the ORDER BY becomes the only
//     thing still holding the x-axis in date order.
//
// So this block asserts the one thing that remains observable: that the
// statement reaching D1 still carries the clause. It is deliberately the last
// thing in the file, and it is not a licence to test any other query this way.
describe("ORDER BY clauses that no fixture can observe", () => {
  it("keeps created DESC on the two queries the published-needs index would order anyway", async () => {
    await getBeautyBankProductNeeds(session);
    expect(prepared[0]!.sql).toMatch(/ORDER BY fc\.created DESC$/);

    await getRecentPublishedChanges(session, 200);
    expect(prepared[1]!.sql).toMatch(/ORDER BY created DESC LIMIT \?$/);
  });

  it("keeps the ORDER BY on the five queries whose GROUP BY already sorts them", async () => {
    await getBeanPastaMonthCounts(session);
    await getDeliveryMonthCounts(session, "count");
    await getPricePerKgByMonth(session);
    await getPricePerCalorieByMonth(session);
    await getOrderLineCategoryMonthPrices(session, ["Tinned Goods"]);

    expect(prepared.map((statement) => statement.sql.replace(/^.*?(GROUP BY )/s, "$1"))).toEqual([
      "GROUP BY the_month ORDER BY the_month",
      "GROUP BY the_month ORDER BY the_month",
      "GROUP BY year, month ORDER BY year, month",
      "GROUP BY year, month ORDER BY year, month",
      "GROUP BY the_month, category ORDER BY the_month, category",
    ]);
  });
});
