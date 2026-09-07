// @ts-ignore -- node:sqlite has no types under this package's tsconfig, whose
// `"types": ["@cloudflare/workers-types"]` deliberately excludes @types/node
// (foodbankAdmin.test.ts's header explains the same constraint). The import
// works at runtime -- vitest runs this file in a node environment -- and the
// two casts below are the whole cost of getting a real SQL engine in here.
// `@ts-ignore` rather than `@ts-expect-error`: if someone later adds
// @types/node to this package, an expect-error directive would itself become
// the error and break `pnpm typecheck` for everyone, which is the exact
// outcome this comment exists to avoid.
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DONATION_POINT_LIST_SORTS,
  FOODBANK_LIST_SORTS,
  LOCATION_LIST_SORTS,
  ORDER_LIST_SORTS,
  PLACE_LIST_SORTS,
  deleteSubscription,
  getAllFoodbanksForCsv,
  getAllOrdersForCsv,
  getDonationPointsPage,
  getFoodbanksPage,
  getFoodbanksWithoutNeedPage,
  getLocationsPage,
  getNeedsPage,
  getOrdersPage,
  getParlconCsvRows,
  getParlconsPage,
  getPlacesPage,
  getRecentArticlesForAdmin,
  getSubscriptionsPage,
  toggleArticleFeatured,
  totalPages,
} from "./adminLists";
import type { Session } from "./types";

// adminLists.ts is nothing but SQL. Every function here is a COUNT plus a
// sorted, LIMIT/OFFSET page, and the failure mode of a wrong query is not an
// exception -- it is a page that renders, looks fine, and shows the wrong
// rows. Migration 0019 is this repo's own scar: it dropped the cached
// `foodbank_name` columns, four queries kept referencing them, and nothing
// went red until /dashboard/beautybanks/ was measured and found to be a
// silent 500. So this file runs the real statements against a real SQLite
// database built from packages/db/migrations, and asserts ROWS -- which
// slugs, in which order, with which values -- not shapes.
//
// WHY A REAL ENGINE, NOT A RECORDING FAKE. locationsAdmin.test.ts pins the
// SHAPE of its queries with a fake session, and says in its own header why
// that is all it can do. That works there because those functions are
// one-row existence checks. It would prove nothing here: an ORDER BY that
// sorts the wrong way, a LEFT JOIN silently degraded to INNER, a `WHERE
// is_closed = 0` that was deleted, a window function partitioned on the
// wrong column -- none of those change the shape of anything. They change
// which rows come back, and only an engine can tell you that.
//
// THE VIEWS ARE THE REAL VIEWS. getLocationsPage/getDonationPointsPage read
// `foodbanklocation_full`/`foodbankdonationpoint_full`, so those are created
// here verbatim from 0019_drop_foodbank_cache.sql:68-84. Substituting a
// hand-built table with the joined columns already flattened in would make
// the test circular -- the join direction IS the thing under test.
//
// THE D1 100-PARAMETER LIMIT does not apply to this module: no function here
// builds a variable-length IN list or chunks its bindings. The most any
// statement binds is three (getFoodbanksPage's cutoff/limit/offset).
// subscriptionUnionSql varies the SQL text by `?type=`, never the parameter
// count. If a future change adds an IN list, it needs a test at 100 and 101.

// ---------------------------------------------------------------------------
// The schema, as it stands after every migration in packages/db/migrations.
// Column definitions are copied from the migrations, not inferred from the
// TypeScript interfaces -- catching a disagreement between the two is half
// the point of running real SQL. Post-0019 means the six `foodbank_*` cache
// columns are GONE from the child tables; a query that still names one dies
// here with "no such column", which is precisely the 0019 regression.
// ---------------------------------------------------------------------------
const SCHEMA = `
-- 0001_core.sql:10-55
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
CREATE UNIQUE INDEX foodbank_name_uniq ON foodbank(name);
CREATE UNIQUE INDEX foodbank_slug_uniq ON foodbank(slug);

-- 0001_core.sql:57-75, less the five columns 0019 dropped
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

-- 0001_core.sql:84-101, less the three columns 0019 dropped
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

-- 0001_core.sql:109-122, less foodbank_name (0019)
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

-- 0001_core.sql:129-136 plus 0011_constituency_pcon24cd.sql:12
CREATE TABLE parliamentaryconstituency (
  id INTEGER PRIMARY KEY,
  name TEXT, slug TEXT NOT NULL, country TEXT,
  mp TEXT, mp_party TEXT, mp_parl_id INTEGER NOT NULL, mp_display_name TEXT, email TEXT,
  centroid TEXT NOT NULL,
  latitude REAL, longitude REAL,
  boundary_geojson TEXT,
  pcon24cd TEXT
);

-- 0003_homepage_data.sql:40-53, less foodbankarticle.foodbank_name (0019),
-- plus 0010_article_url_unique.sql:8
CREATE TABLE foodbankhit (
  foodbank_id INTEGER NOT NULL, day TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (foodbank_id, day)
) WITHOUT ROWID;
CREATE TABLE foodbankarticle (
  id INTEGER PRIMARY KEY,
  foodbank_id INTEGER,
  published_date TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
  featured INTEGER NOT NULL
);
CREATE UNIQUE INDEX article_url_uniq ON foodbankarticle(url);

-- 0004_subscribers.sql, less foodbanksubscriber.foodbank_name (0019)
CREATE TABLE foodbanksubscriber (
  id INTEGER PRIMARY KEY,
  created TEXT NOT NULL, last_contacted TEXT,
  foodbank_id INTEGER NOT NULL,
  email TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0,
  sub_key TEXT NOT NULL, unsub_key TEXT NOT NULL
);
CREATE UNIQUE INDEX sub_email_fb_uniq ON foodbanksubscriber(email, foodbank_id);
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

-- 0005_orders_and_charity.sql:19-33
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

-- 0009_aac.sql:12-18 (the place_fts virtual table is irrelevant here)
CREATE TABLE place (
  id INTEGER PRIMARY KEY, gbpnid INTEGER NOT NULL,
  name TEXT,
  name_upper TEXT,
  lat_lng TEXT, county TEXT, county_slug TEXT NOT NULL,
  name_slug TEXT NOT NULL, population INTEGER
);

-- 0019_drop_foodbank_cache.sql:68-84, verbatim
CREATE VIEW foodbanklocation_full AS
  SELECT l.*,
         f.name          AS foodbank_name,
         f.slug          AS foodbank_slug,
         f.network       AS foodbank_network,
         f.phone_number  AS foodbank_phone_number,
         f.contact_email AS foodbank_email
    FROM foodbanklocation l
    LEFT JOIN foodbank f ON f.id = l.foodbank_id;
CREATE VIEW foodbankdonationpoint_full AS
  SELECT d.*,
         f.name    AS foodbank_name,
         f.slug    AS foodbank_slug,
         f.network AS foodbank_network
    FROM foodbankdonationpoint d
    LEFT JOIN foodbank f ON f.id = d.foodbank_id;
`;

// ---------------------------------------------------------------------------
// The D1 Sessions API surface adminLists.ts actually uses, over node:sqlite.
// Copied from workers/site/src/routes/admin/foodbankLocation.test.ts's
// d1Session, with one addition: `meta.changes`, which deleteSubscription
// reads to decide its return value. A `run()` that reported a constant would
// make every delete test pass whether or not a row went.
// ---------------------------------------------------------------------------
type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number | bigint };
  };
};

function d1Session(db: SqliteDb) {
  const statement = (sql: string, params: unknown[]) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      const info = db.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(info.changes) } };
    },
  });
  return { prepare: (sql: string) => statement(sql, []), getBookmark: () => null } as unknown as Session;
}

// A pass-through wrapper that records the SQL a function asks for while still
// running it. Needed exactly once, for deleteSubscription's guard: "returns
// false" is satisfied by a statement that ran and matched nothing as well as
// by no statement at all, and only the second is the behaviour the guard
// exists for. Everything else in this file asserts on rows, which is stronger.
function watchStatements(inner: Session, sink: string[]): Session {
  const real = inner as unknown as { prepare(sql: string): unknown };
  return { prepare: (sql: string) => (sink.push(sql), real.prepare(sql)), getBookmark: () => null } as unknown as Session;
}

let db: SqliteDb;
let session: Session;

beforeEach(() => {
  // @ts-ignore -- see the import comment
  db = new DatabaseSync(":memory:") as SqliteDb;
  db.exec(SCHEMA);
  session = d1Session(db);
});

// A generic INSERT built from the object's own keys, so a seed helper names
// only the columns a test cares about and the NOT NULL filler lives in one
// place per table. Values are inlined as SQL literals rather than bound
// because the seeds are all test-authored constants.
function insert(table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  const values = columns.map((c) => {
    const v = row[c];
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number") return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  });
  db.exec(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${values.join(", ")})`);
}

// Django-format timestamps throughout: "YYYY-MM-DD HH:MM:SS.ffffff", the
// form 0022_normalise_timestamps.sql settled on and packages/models's
// pyNow()/pyDatetime() now write. These columns are TEXT and SQLite compares
// TEXT bytewise, so the format is load-bearing for every ORDER BY in this
// file -- an ISO "2026-09-05T08:00:00.000Z" sorts AFTER a Django
// "2026-09-05 20:00:00.000000" because 'T' (0x54) > ' ' (0x20). Ticket #9
// measured that returning the wrong "latest published need" in production.
// Wherever ordering matters below, two values share a date and differ only
// in the time, so a comparison that only looked at the date would fail.

let uuidCounter = 0;
const nextUuid = () => `${(uuidCounter += 1)}`.padStart(32, "0");

function seedFoodbank(row: Record<string, unknown>): void {
  insert("foodbank", {
    uuid: nextUuid(),
    address: "1 Test Street",
    postcode: "SP1 1AA",
    country: "England",
    lat_lng: "51.0,-1.8",
    charity_just_foodbank: 0,
    contact_email: "info@example.org",
    url: "https://example.org/",
    shopping_list_url: "https://example.org/list/",
    address_is_administrative: 0,
    is_closed: 0,
    no_locations: 0,
    days_between_needs: 7,
    created: "2020-01-01 00:00:00.000000",
    modified: "2020-01-01 00:00:00.000000",
    ...row,
  });
}

function seedLocation(row: Record<string, unknown>): void {
  insert("foodbanklocation", {
    uuid: nextUuid(),
    country: "England",
    lat_lng: "51.0,-1.8",
    is_closed: 0,
    modified: "2020-01-01 00:00:00.000000",
    ...row,
  });
}

function seedDonationPoint(row: Record<string, unknown>): void {
  insert("foodbankdonationpoint", {
    uuid: nextUuid(),
    address: "1 Shop Street",
    postcode: "SP1 1AA",
    country: "England",
    lat_lng: "51.0,-1.8",
    is_closed: 0,
    in_store_only: 0,
    modified: "2020-01-01 00:00:00.000000",
    ...row,
  });
}

function seedNeed(row: Record<string, unknown>): void {
  insert("foodbankchange", {
    change_text: "Beans",
    input_method: "typed",
    modified: "2020-01-01 00:00:00.000000",
    ...row,
  });
}

function seedOrder(row: Record<string, unknown>): void {
  insert("orders", {
    items_text: "beans",
    country: "England",
    created: "2020-01-01 00:00:00.000000",
    modified: "2020-01-01 00:00:00.000000",
    delivery_date: "2020-01-02",
    delivery_hour: 9,
    delivery_datetime: "2020-01-02 09:00:00.000000",
    weight: 1000,
    calories: 2000,
    cost: 5000,
    no_lines: 1,
    no_items: 10,
    ...row,
  });
}

function seedParlcon(row: Record<string, unknown>): void {
  insert("parliamentaryconstituency", { mp_parl_id: 1, centroid: "51.0,-1.8", ...row });
}

function seedArticle(row: Record<string, unknown>): void {
  insert("foodbankarticle", { featured: 0, ...row });
}

function seedPlace(row: Record<string, unknown>): void {
  insert("place", { gbpnid: Math.floor(Math.random() * 1e9), county_slug: "wiltshire", name_slug: "x", ...row });
}

function seedEmailSub(row: Record<string, unknown>): void {
  insert("foodbanksubscriber", { confirmed: 1, sub_key: nextUuid(), unsub_key: nextUuid(), ...row });
}

function seedMobileSub(row: Record<string, unknown>): void {
  insert("mobilesubscriber", { platform: "iOS", ...row });
}

function seedWebpushSub(row: Record<string, unknown>): void {
  insert("webpushsubscription", { p256dh: "p", auth: "a", ...row });
}

// ===========================================================================
describe("totalPages", () => {
  // An empty table must still render "page 1 of 1", not "of 0" -- the admin
  // list template prints this next to the pager on every one of these pages.
  it("never returns fewer than one page, even for an empty table", () => {
    expect(totalPages(0, 100)).toBe(1);
  });

  it("does not round an exact multiple up to a spare empty page", () => {
    expect(totalPages(200, 100)).toBe(2);
    expect(totalPages(201, 100)).toBe(3);
    expect(totalPages(1, 100)).toBe(1);
  });
});

// ===========================================================================
describe("getFoodbanksPage", () => {
  // gfadmin/views.py:293's `.exclude(is_closed=True)`. A filter that does
  // nothing passes every test that seeds only matching rows, so the closed
  // food bank here is the entire point: it must be absent from the ROWS and
  // absent from the TOTAL, because the pager is built from the total and a
  // count that disagrees with the rows produces a last page that is empty.
  it("excludes closed food banks from both the rows and the total", async () => {
    seedFoodbank({ id: 1, name: "Open A", slug: "open-a", is_closed: 0 });
    seedFoodbank({ id: 2, name: "Closed B", slug: "closed-b", is_closed: 1 });
    seedFoodbank({ id: 3, name: "Open C", slug: "open-c", is_closed: 0 });

    const page = await getFoodbanksPage(session, "name", "asc", 1, 100);
    expect(page.rows.map((r) => r.slug)).toEqual(["open-a", "open-c"]);
    expect(page.total).toBe(2);
  });

  // Django's default sort is `edited` ASCENDING (views.py:258 -- "edited" is
  // in sort_options, "-edited" is a separate entry), and adminLists.ts's own
  // comment says why: this page is the triage queue that foodbanks_next
  // (`.order_by("edited").first()`) points into. Flipping it to DESC would
  // bury exactly the rows an admin opened the page for, and would not throw.
  //
  // The two 2026-09-05 values differ only in time-of-day, so a comparison
  // that truncated to the date -- or an ISO-formatted value sneaking in --
  // would order them wrongly. See the timestamp note above.
  it("puts the least-recently-edited food bank first under the default `edited` sort", async () => {
    seedFoodbank({ id: 1, name: "Recent", slug: "recent", edited: "2026-09-05 19:28:08.853000" });
    seedFoodbank({ id: 2, name: "Stale", slug: "stale", edited: "2024-02-11 06:00:00.000000" });
    seedFoodbank({ id: 3, name: "Middle", slug: "middle", edited: "2026-09-05 08:00:00.000000" });

    const page = await getFoodbanksPage(session, "edited", "asc", 1, 100);
    expect(page.rows.map((r) => r.slug)).toEqual(["stale", "middle", "recent"]);
  });

  // `edited` is nullable, and SQLite sorts NULL first ascending -- so a food
  // bank nobody has ever edited heads the triage queue. That is the right
  // answer for this page and it is a property of the SQL, not of any code,
  // which is exactly why it needs pinning: swapping to DESC (or adding a
  // `WHERE edited IS NOT NULL`) would hide the most neglected rows on the
  // site behind the last page.
  it("sorts a never-edited food bank to the top of the queue", async () => {
    seedFoodbank({ id: 1, name: "Edited", slug: "edited", edited: "2020-01-01 00:00:00.000000" });
    seedFoodbank({ id: 2, name: "Never", slug: "never", edited: null });

    const page = await getFoodbanksPage(session, "edited", "asc", 1, 100);
    expect(page.rows.map((r) => r.slug)).toEqual(["never", "edited"]);
  });

  it("reverses under `desc`", async () => {
    seedFoodbank({ id: 1, name: "Alpha", slug: "alpha" });
    seedFoodbank({ id: 2, name: "Beta", slug: "beta" });

    expect((await getFoodbanksPage(session, "name", "desc", 1, 100)).rows.map((r) => r.slug)).toEqual(["beta", "alpha"]);
  });

  // THE 0019 REGRESSION, GENERALISED. `sort` is interpolated straight into
  // the statement, so a sort key naming a column that no longer exists is a
  // runtime "no such column" on that one sort only -- invisible until an
  // admin clicks that particular header. Every declared key is executed here
  // so a migration that drops or renames a column fails in this file rather
  // than in production. `hits_last_28_days` is in the list too: it is not a
  // foodbank column at all, and only resolves because the ORDER BY is
  // unqualified and SQLite matches it against the SELECT's output aliases --
  // adding an `f.` prefix would be valid-looking SQL that breaks this one.
  it("can sort by every key in FOODBANK_LIST_SORTS", async () => {
    seedFoodbank({ id: 1, name: "Alpha", slug: "alpha" });
    seedFoodbank({ id: 2, name: "Beta", slug: "beta" });

    for (const sort of FOODBANK_LIST_SORTS) {
      const page = await getFoodbanksPage(session, sort, "asc", 1, 100);
      expect(page.rows, `sort=${sort}`).toHaveLength(2);
    }
  });

  // views.py:275-292's annotation, ported as a correlated subquery. Three
  // things could go wrong silently and all three are seeded against here:
  // a join instead of a subquery would double-count Salisbury's two rows
  // into the food bank row itself; a missing `foodbank_id = f.id` would give
  // every food bank the site-wide total; and a missing COALESCE would give
  // NULL rather than 0 for a food bank with no recent hits, which sorts and
  // renders differently.
  it("sums a food bank's own recent hits, coalescing a food bank with none to 0", async () => {
    seedFoodbank({ id: 1, name: "Salisbury", slug: "salisbury" });
    seedFoodbank({ id: 2, name: "Durham", slug: "durham" });
    const today = new Date().toISOString().slice(0, 10);
    insert("foodbankhit", { foodbank_id: 1, day: today, hits: 7 });
    insert("foodbankhit", { foodbank_id: 1, day: "2026-01-01", hits: 500 }); // outside the window
    insert("foodbankhit", { foodbank_id: 2, day: today, hits: 3 });

    const page = await getFoodbanksPage(session, "name", "asc", 1, 100);
    const hits = Object.fromEntries(page.rows.map((r) => [r.slug, r.hits_last_28_days]));
    expect(hits).toEqual({ durham: 3, salisbury: 7 });
  });

  it("returns 0, not null, for a food bank with no hit rows at all", async () => {
    seedFoodbank({ id: 1, name: "Quiet", slug: "quiet" });

    const page = await getFoodbanksPage(session, "name", "asc", 1, 100);
    expect(page.rows[0]!.hits_last_28_days).toBe(0);
  });

  // The window boundary. Django is `day__gte=date.today() - timedelta(days=28)`
  // and the port is `Date.now() - 28 days`, sliced to a date -- so the day
  // exactly 28 days ago is INSIDE the window and 29 days ago is outside. An
  // off-by-one here changes every number in the Hits column by a day's worth
  // of traffic and nothing else.
  it("includes the day exactly 28 days ago and excludes the day before it", async () => {
    seedFoodbank({ id: 1, name: "Edge", slug: "edge" });
    const day = (ago: number) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);
    insert("foodbankhit", { foodbank_id: 1, day: day(28), hits: 11 });
    insert("foodbankhit", { foodbank_id: 1, day: day(29), hits: 400 });

    const page = await getFoodbanksPage(session, "name", "asc", 1, 100);
    expect(page.rows[0]!.hits_last_28_days).toBe(11);
  });

  it("orders by the computed hits column when asked to", async () => {
    seedFoodbank({ id: 1, name: "Alpha", slug: "alpha" });
    seedFoodbank({ id: 2, name: "Beta", slug: "beta" });
    seedFoodbank({ id: 3, name: "Gamma", slug: "gamma" });
    const today = new Date().toISOString().slice(0, 10);
    insert("foodbankhit", { foodbank_id: 1, day: today, hits: 5 });
    insert("foodbankhit", { foodbank_id: 3, day: today, hits: 50 });

    const page = await getFoodbanksPage(session, "hits_last_28_days", "desc", 1, 100);
    expect(page.rows.map((r) => r.slug)).toEqual(["gamma", "alpha", "beta"]);
  });

  // Pagination is real behaviour, not decoration: five rows over pages of
  // two, so an off-by-one in the OFFSET, a LIMIT applied before the sort, or
  // a hasNext computed from the page's own length instead of the total all
  // change the answer here.
  it("pages with a stable order and reports hasNext from the total, not the page", async () => {
    for (let i = 1; i <= 5; i += 1) seedFoodbank({ id: i, name: `Bank ${i}`, slug: `bank-${i}` });

    const first = await getFoodbanksPage(session, "name", "asc", 1, 2);
    expect(first.rows.map((r) => r.slug)).toEqual(["bank-1", "bank-2"]);
    expect({ total: first.total, page: first.page, pageSize: first.pageSize, hasNext: first.hasNext }).toEqual({ total: 5, page: 1, pageSize: 2, hasNext: true });

    expect((await getFoodbanksPage(session, "name", "asc", 2, 2)).rows.map((r) => r.slug)).toEqual(["bank-3", "bank-4"]);

    const last = await getFoodbanksPage(session, "name", "asc", 3, 2);
    expect(last.rows.map((r) => r.slug)).toEqual(["bank-5"]);
    expect(last.hasNext).toBe(false);
  });

  // THE MUTANT THIS KILLS, run not imagined: `hasNext: result.results.length
  // === pageSize`. That is the obvious-looking rewrite -- "a full page means
  // there is probably another" -- and it survives every other pagination test
  // in this file, because they all end on a SHORT last page where the two
  // formulas agree. Four rows over pages of two is the case where they do
  // not: page 2 is full and is also the end, so the pager would offer a Next
  // link to an empty page. hasNext must come from the total, and the total
  // must come from the COUNT.
  //
  // The overshoot below is the same claim from the other side: page 9 of a
  // 4-row table returns nothing and must not promise more.
  it("reports hasNext false on a last page that happens to be exactly full", async () => {
    for (let i = 1; i <= 4; i += 1) seedFoodbank({ id: i, name: `Bank ${i}`, slug: `bank-${i}` });

    const full = await getFoodbanksPage(session, "name", "asc", 2, 2);
    expect(full.rows.map((r) => r.slug)).toEqual(["bank-3", "bank-4"]);
    expect(full.hasNext).toBe(false);

    const past = await getFoodbanksPage(session, "name", "asc", 9, 2);
    expect(past.rows).toEqual([]);
    expect({ total: past.total, hasNext: past.hasNext }).toEqual({ total: 4, hasNext: false });
  });

  // mapFoodbankRow runs over the raw row, so the D1 0/1 integers become real
  // booleans before a template ever sees them. Skipping the mapper -- a
  // plausible "simplification", since this query already selects f.* -- would
  // make `{% if foodbank.is_closed %}` true for the 0 case in some engines
  // and would change the JSON shape of anything reusing these rows.
  it("hands back mapped rows: is_closed is a boolean, hits is a number", async () => {
    seedFoodbank({ id: 1, name: "Open", slug: "open", is_closed: 0, is_school: null });

    const row = (await getFoodbanksPage(session, "name", "asc", 1, 100)).rows[0]!;
    expect(row.is_closed).toBe(false);
    expect(row.is_school).toBeNull();
    expect(row.hits_last_28_days).toBe(0);
  });

  // DOCUMENTED, NOT ENDORSED. types.ts's sortByName exists because D1's
  // default text collation is BINARY -- every uppercase letter sorts before
  // every lowercase one -- while the source Postgres sorted under en_US.utf8.
  // These admin lists sort in SQL, so they get the byte order, and a food
  // bank called "de Beauvoir" lands after "Zebra". That is a real divergence
  // from what production showed; it is pinned here so the next person to
  // notice it knows it is known, not new.
  it("sorts by raw byte order, so lowercase initials sort after every capital", async () => {
    seedFoodbank({ id: 1, name: "de Beauvoir", slug: "de-beauvoir" });
    seedFoodbank({ id: 2, name: "Zebra", slug: "zebra" });

    expect((await getFoodbanksPage(session, "name", "asc", 1, 100)).rows.map((r) => r.slug)).toEqual(["zebra", "de-beauvoir"]);
  });
});

// ===========================================================================
describe("getAllFoodbanksForCsv", () => {
  // views.py:328 is `Foodbank.objects.all().order_by("-created")` -- ALL,
  // where the list view above excludes closed. The two live three lines apart
  // in adminLists.ts and the filter is one clause; copying it across would
  // quietly drop every closed food bank from an export real people paste into
  // spreadsheets.
  it("includes closed food banks, unlike the list view", async () => {
    seedFoodbank({ id: 1, name: "Open", slug: "open", is_closed: 0, created: "2021-01-01 00:00:00.000000" });
    seedFoodbank({ id: 2, name: "Closed", slug: "closed", is_closed: 1, created: "2022-01-01 00:00:00.000000" });

    expect((await getAllFoodbanksForCsv(session)).map((r) => r.slug)).toEqual(["closed", "open"]);
  });

  // `-created`, newest first, and the two same-day values are the ticket #9
  // case: bytewise TEXT comparison only gets this right because both are in
  // Django's "YYYY-MM-DD HH:MM:SS.ffffff" form.
  it("sorts newest-created first, discriminating within a single day", async () => {
    seedFoodbank({ id: 1, name: "Morning", slug: "morning", created: "2026-09-05 08:00:00.000000" });
    seedFoodbank({ id: 2, name: "Evening", slug: "evening", created: "2026-09-05 19:28:08.853000" });
    seedFoodbank({ id: 3, name: "Yesterday", slug: "yesterday", created: "2026-09-04 23:59:59.999999" });

    expect((await getAllFoodbanksForCsv(session)).map((r) => r.slug)).toEqual(["evening", "morning", "yesterday"]);
  });
});

// ===========================================================================
describe("getLocationsPage", () => {
  // 0019's whole point. The five foodbank_* columns are gone from the base
  // table; the view supplies them live from the parent. If a future change
  // reverted this query to `SELECT * FROM foodbanklocation`, it would still
  // run -- and every location would render with an undefined food bank name
  // and a link to /undefined/.
  it("reads the parent's live name/slug/network/phone/email through the view", async () => {
    seedFoodbank({ id: 9, name: "Salisbury", slug: "salisbury", network: "Trussell", phone_number: "01722 349556", contact_email: "info@salisbury.foodbank.org.uk" });
    seedLocation({ id: 1, foodbank_id: 9, name: "Bemerton Heath", slug: "bemerton-heath" });

    const row = (await getLocationsPage(session, "name", "asc", 1, 100)).rows[0]!;
    expect({
      foodbank_name: row.foodbank_name,
      foodbank_slug: row.foodbank_slug,
      foodbank_network: row.foodbank_network,
      foodbank_phone_number: row.foodbank_phone_number,
      foodbank_email: row.foodbank_email,
    }).toEqual({
      foodbank_name: "Salisbury",
      foodbank_slug: "salisbury",
      foodbank_network: "Trussell",
      foodbank_phone_number: "01722 349556",
      foodbank_email: "info@salisbury.foodbank.org.uk",
    });
  });

  // LEFT JOIN, not JOIN -- 0019_drop_foodbank_cache.sql:28-32 says so
  // explicitly, because D1 declares no foreign keys and nothing stops a
  // location outliving its parent. The count comes from the BASE table while
  // the rows come from the view, so an INNER join here would make total say 2
  // while rows returned 1: a pager promising a row the page cannot show.
  // Seeded with a parented location AND an orphan so the two must agree.
  it("keeps an orphaned location, and its count agrees with its rows", async () => {
    seedFoodbank({ id: 9, name: "Salisbury", slug: "salisbury" });
    seedLocation({ id: 1, foodbank_id: 9, name: "Adopted", slug: "adopted" });
    seedLocation({ id: 2, foodbank_id: 404, name: "Orphan", slug: "orphan" });

    const page = await getLocationsPage(session, "name", "asc", 1, 100);
    expect(page.rows.map((r) => r.slug)).toEqual(["adopted", "orphan"]);
    expect(page.total).toBe(2);
    // Typed `foodbank_name: string` on FoodbankLocationRow, but the LEFT JOIN
    // yields NULL here -- see this file's suspected-bugs note.
    expect(page.rows[1]!.foodbank_name).toBeNull();
  });

  // Django's own sort_options at views.py:2140-2145, and the one entry that
  // is not a column: "parliamentary_constituency" is the key the URL carries,
  // but this schema only ever kept the denormalised NAME column, so the
  // module maps it. Seeding constituency names in the opposite order to the
  // location names is what makes a dropped mapping visible -- sorting by
  // `name` instead would give the other answer.
  it("maps the `parliamentary_constituency` sort key onto the _name column", async () => {
    seedFoodbank({ id: 9, name: "Salisbury", slug: "salisbury" });
    seedLocation({ id: 1, foodbank_id: 9, name: "Alpha", slug: "alpha", parliamentary_constituency_name: "Zebra Vale" });
    seedLocation({ id: 2, foodbank_id: 9, name: "Zulu", slug: "zulu", parliamentary_constituency_name: "Amesbury" });

    expect((await getLocationsPage(session, "parliamentary_constituency", "asc", 1, 100)).rows.map((r) => r.slug)).toEqual(["zulu", "alpha"]);
  });

  // A COLUMN-EXISTENCE probe, not an ordering one -- `sortColumn` is
  // interpolated straight into the statement, so a key naming a column a
  // migration dropped is a runtime "no such column" on that header alone, and
  // 0019 is this repo's proof that happens. Which rows come back in which
  // order is pinned by the four tests around it (foodbank_name,
  // parliamentary_constituency, name asc and name desc), so a `sort` that was
  // accepted and ignored fails there rather than here.
  it("can sort by every key in LOCATION_LIST_SORTS, including the view's foodbank_name", async () => {
    seedFoodbank({ id: 9, name: "Salisbury", slug: "salisbury" });
    seedLocation({ id: 1, foodbank_id: 9, name: "Alpha", slug: "alpha" });
    seedLocation({ id: 2, foodbank_id: 9, name: "Beta", slug: "beta" });

    for (const sort of LOCATION_LIST_SORTS) {
      expect((await getLocationsPage(session, sort, "asc", 1, 100)).rows, `sort=${sort}`).toHaveLength(2);
    }
  });

  // Locations open A->Z by food bank name in Django (views.py:2147's raw
  // `.order_by(sort)` with the default "foodbank_name"), which only works
  // because the sort reaches through the join to the parent.
  it("sorts by the PARENT's name when asked for foodbank_name", async () => {
    seedFoodbank({ id: 1, name: "Zebra Foodbank", slug: "zebra" });
    seedFoodbank({ id: 2, name: "Amesbury Foodbank", slug: "amesbury" });
    seedLocation({ id: 1, foodbank_id: 1, name: "Aaa", slug: "aaa" });
    seedLocation({ id: 2, foodbank_id: 2, name: "Zzz", slug: "zzz" });

    expect((await getLocationsPage(session, "foodbank_name", "asc", 1, 100)).rows.map((r) => r.slug)).toEqual(["zzz", "aaa"]);
  });

  // 0001_core.sql:71 records that is_donation_point/is_mobile are NULL for
  // hundreds of production rows despite the model declaring them NOT NULL.
  // mapLocationRow must preserve that NULL rather than coalescing it to
  // false -- "we do not know" and "no" are different answers on this column.
  it("coerces the 0/1 columns to booleans and leaves a NULL as null", async () => {
    seedFoodbank({ id: 9, name: "Salisbury", slug: "salisbury" });
    seedLocation({ id: 1, foodbank_id: 9, name: "Loc", slug: "loc", is_closed: 0, is_donation_point: 1, is_mobile: null });

    const row = (await getLocationsPage(session, "name", "asc", 1, 100)).rows[0]!;
    expect({ is_closed: row.is_closed, is_donation_point: row.is_donation_point, is_mobile: row.is_mobile }).toEqual({
      is_closed: false,
      is_donation_point: true,
      is_mobile: null,
    });
  });

  // Deliberately NO is_closed filter, unlike getFoodbanksPage: Django's
  // locations() is a bare `FoodbankLocation.objects.all()`. Adding the filter
  // "for consistency" would hide closed locations from the only screen an
  // admin can reopen them from.
  it("does not filter closed locations", async () => {
    seedFoodbank({ id: 9, name: "Salisbury", slug: "salisbury" });
    seedLocation({ id: 1, foodbank_id: 9, name: "Open", slug: "open", is_closed: 0 });
    seedLocation({ id: 2, foodbank_id: 9, name: "Shut", slug: "shut", is_closed: 1 });

    const page = await getLocationsPage(session, "name", "asc", 1, 100);
    expect(page.rows.map((r) => r.slug)).toEqual(["open", "shut"]);
    expect(page.total).toBe(2);
  });

  // THE MUTANT THIS KILLS, run not imagined: `${direction === "desc" ?
  // "DESC" : "ASC"}` collapsed to a bare `ASC`. Every other test in this
  // describe asks for "asc", so a direction argument that was accepted and
  // then ignored passed all of them -- the column headers would simply stop
  // reversing, on a page where nothing else looks wrong. Django's own
  // sort_options for this view carries no "-" variant (views.py:2140-2145,
  // and adminLists.ts's comment says so), so descending exists ONLY because
  // this port added it; there is no upstream behaviour to notice its loss.
  it("reverses under `desc`", async () => {
    seedFoodbank({ id: 9, name: "Salisbury", slug: "salisbury" });
    seedLocation({ id: 1, foodbank_id: 9, name: "Alpha", slug: "alpha" });
    seedLocation({ id: 2, foodbank_id: 9, name: "Zulu", slug: "zulu" });

    expect((await getLocationsPage(session, "name", "desc", 1, 100)).rows.map((r) => r.slug)).toEqual(["zulu", "alpha"]);
    expect((await getLocationsPage(session, "name", "asc", 1, 100)).rows.map((r) => r.slug)).toEqual(["alpha", "zulu"]);
  });

  // Pagination, ending on an exactly-full LAST page. THE MUTANT THIS KILLS,
  // run not imagined: `hasNext: result.results.length === pageSize`. Three
  // rows over pages of two ends on a SHORT page, where that rewrite and the
  // real formula agree, so the earlier version of this test passed it. Four
  // rows makes page 2 both full and final, and the mutant offers a Next link
  // into nothing. getFoodbanksPage pins the same claim, but the formula is
  // written out separately in all nine paginated functions here, so killing
  // it in one proves nothing about the other eight -- hence the same shape
  // repeated in each describe below.
  it("pages, and reports hasNext false on a full final page", async () => {
    seedFoodbank({ id: 9, name: "Salisbury", slug: "salisbury" });
    for (let i = 1; i <= 4; i += 1) seedLocation({ id: i, foodbank_id: 9, name: `Loc ${i}`, slug: `loc-${i}` });

    const first = await getLocationsPage(session, "name", "asc", 1, 2);
    expect(first.rows.map((r) => r.slug)).toEqual(["loc-1", "loc-2"]);
    expect({ total: first.total, hasNext: first.hasNext }).toEqual({ total: 4, hasNext: true });

    const last = await getLocationsPage(session, "name", "asc", 2, 2);
    expect(last.rows.map((r) => r.slug)).toEqual(["loc-3", "loc-4"]);
    expect({ total: last.total, hasNext: last.hasNext }).toEqual({ total: 4, hasNext: false });
  });
});

// ===========================================================================
describe("getDonationPointsPage", () => {
  it("reads the parent's live name/slug/network through the view", async () => {
    seedFoodbank({ id: 9, name: "Salisbury", slug: "salisbury", network: "Trussell" });
    seedDonationPoint({ id: 1, foodbank_id: 9, name: "Tesco Southampton Road", slug: "tesco-southampton-road" });

    const row = (await getDonationPointsPage(session, "name", "asc", 1, 100)).rows[0]!;
    expect({ n: row.foodbank_name, s: row.foodbank_slug, w: row.foodbank_network }).toEqual({ n: "Salisbury", s: "salisbury", w: "Trussell" });
  });

  // Same LEFT-vs-INNER trap as locations: the count is on the base table, so
  // an inner join would over-promise on the pager.
  it("keeps an orphaned donation point, and its count agrees with its rows", async () => {
    seedFoodbank({ id: 9, name: "Salisbury", slug: "salisbury" });
    seedDonationPoint({ id: 1, foodbank_id: 9, name: "Adopted", slug: "adopted" });
    seedDonationPoint({ id: 2, foodbank_id: 404, name: "Orphan", slug: "orphan" });

    const page = await getDonationPointsPage(session, "name", "asc", 1, 100);
    expect(page.rows.map((r) => r.slug)).toEqual(["adopted", "orphan"]);
    expect(page.total).toBe(2);
    expect(page.rows[1]!.foodbank_name).toBeNull();
  });

  // THE MUTANTS THIS KILLS, run not imagined: `ORDER BY ${sort}` hardcoded to
  // `ORDER BY name`, and to `ORDER BY edited`. A length-only version of this
  // test -- which is what it used to be -- caught neither, because every other
  // test in this describe sorts by `name` under a single parent, so a query
  // that ignored `sort` entirely still returned the rows those tests expected.
  // Two of this page's three column headers would silently stop working.
  //
  // The three rows are arranged so that all three keys give three DIFFERENT
  // orders: name is A/B/G, the parents sort G/A/B, and `edited` sorts B/G/A.
  // Any one key standing in for another therefore fails. Executing every
  // declared key also re-runs the 0019 check -- a sort naming a column that a
  // migration dropped is a runtime "no such column" on that header alone.
  it("sorts by each key in DONATION_POINT_LIST_SORTS, and the three keys disagree", async () => {
    seedFoodbank({ id: 1, name: "Mid Foodbank", slug: "mid" });
    seedFoodbank({ id: 2, name: "Zebra Foodbank", slug: "zebra" });
    seedFoodbank({ id: 3, name: "Amesbury Foodbank", slug: "amesbury" });
    seedDonationPoint({ id: 1, foodbank_id: 1, name: "Alpha", slug: "alpha", edited: "2026-03-01 00:00:00.000000" });
    seedDonationPoint({ id: 2, foodbank_id: 2, name: "Beta", slug: "beta", edited: "2026-01-01 00:00:00.000000" });
    seedDonationPoint({ id: 3, foodbank_id: 3, name: "Gamma", slug: "gamma", edited: "2026-02-01 00:00:00.000000" });

    const expected: Record<(typeof DONATION_POINT_LIST_SORTS)[number], string[]> = {
      name: ["alpha", "beta", "gamma"],
      foodbank_name: ["gamma", "alpha", "beta"],
      edited: ["beta", "gamma", "alpha"],
    };
    for (const sort of DONATION_POINT_LIST_SORTS) {
      expect((await getDonationPointsPage(session, sort, "asc", 1, 100)).rows.map((r) => r.slug), `sort=${sort}`).toEqual(expected[sort]);
    }
  });

  // Same collapsed-ternary mutant as getLocationsPage's `desc` test: this
  // page's descending headers exist only in this port (Django's sort_options
  // at views.py:2222-2226 carries no "-" variant and views.py:2231 applies
  // the raw key), so nothing upstream would notice a direction argument that
  // stopped being used.
  it("reverses under `desc`", async () => {
    seedFoodbank({ id: 9, name: "Salisbury", slug: "salisbury" });
    seedDonationPoint({ id: 1, foodbank_id: 9, name: "Alpha", slug: "alpha" });
    seedDonationPoint({ id: 2, foodbank_id: 9, name: "Zulu", slug: "zulu" });

    expect((await getDonationPointsPage(session, "name", "desc", 1, 100)).rows.map((r) => r.slug)).toEqual(["zulu", "alpha"]);
    expect((await getDonationPointsPage(session, "name", "asc", 1, 100)).rows.map((r) => r.slug)).toEqual(["alpha", "zulu"]);
  });

  // 0001_core.sql:98 -- "TRI-STATE: NULL/0/1, do not coalesce". A wheelchair
  // accessibility this site does not know about must not be published as
  // "not accessible".
  it("preserves wheelchair_accessible's tri-state through the mapper", async () => {
    seedFoodbank({ id: 9, name: "Salisbury", slug: "salisbury" });
    seedDonationPoint({ id: 1, foodbank_id: 9, name: "Unknown", slug: "unknown", wheelchair_accessible: null });
    seedDonationPoint({ id: 2, foodbank_id: 9, name: "No", slug: "no", wheelchair_accessible: 0 });
    seedDonationPoint({ id: 3, foodbank_id: 9, name: "Yes", slug: "yes", wheelchair_accessible: 1 });

    const rows = (await getDonationPointsPage(session, "name", "asc", 1, 100)).rows;
    expect(rows.map((r) => [r.slug, r.wheelchair_accessible])).toEqual([
      ["no", false],
      ["unknown", null],
      ["yes", true],
    ]);
  });

  // Four rows over pages of two, so the final page is exactly full -- the
  // `hasNext: result.results.length === pageSize` mutant described in
  // getLocationsPage's paging test, which a three-row seed cannot catch.
  // The closed donation point is in here too: Django's donationpoints() is a
  // bare `.all()`, and adding an is_closed filter "for consistency" with the
  // food bank list would hide the rows an admin came to reopen.
  it("pages to a full final page, and does not filter closed donation points", async () => {
    seedFoodbank({ id: 9, name: "Salisbury", slug: "salisbury" });
    seedDonationPoint({ id: 1, foodbank_id: 9, name: "A", slug: "a", is_closed: 1 });
    seedDonationPoint({ id: 2, foodbank_id: 9, name: "B", slug: "b" });
    seedDonationPoint({ id: 3, foodbank_id: 9, name: "C", slug: "c" });
    seedDonationPoint({ id: 4, foodbank_id: 9, name: "D", slug: "d" });

    const first = await getDonationPointsPage(session, "name", "asc", 1, 2);
    expect(first.rows.map((r) => r.slug)).toEqual(["a", "b"]);
    expect({ total: first.total, hasNext: first.hasNext }).toEqual({ total: 4, hasNext: true });

    const last = await getDonationPointsPage(session, "name", "asc", 2, 2);
    expect(last.rows.map((r) => r.slug)).toEqual(["c", "d"]);
    expect({ total: last.total, hasNext: last.hasNext }).toEqual({ total: 4, hasNext: false });
  });
});

// ===========================================================================
describe("getParlconsPage", () => {
  // views.py:2313 is `.order_by("name")`, and name is nullable here
  // (0001_core.sql:131), so the unnamed row heads the list. Pinned because
  // the ordering is otherwise invisible: 650 constituencies all render.
  it("orders by name ascending, with a NULL name first", async () => {
    seedParlcon({ id: 1, name: "Salisbury", slug: "salisbury" });
    seedParlcon({ id: 2, name: "Amesbury", slug: "amesbury" });
    seedParlcon({ id: 3, name: null, slug: "unnamed" });

    expect((await getParlconsPage(session, 1, 100)).rows.map((r) => r.slug)).toEqual(["unnamed", "amesbury", "salisbury"]);
  });

  // The projection IS the feature. PLAN.md §4.6 records boundary_geojson rows
  // up to 1,568 kB; selecting it for a 650-row list to render a tick would
  // move roughly a gigabyte to render nothing. A `SELECT *` here would still
  // pass every ordering test in this describe, so the absent key is asserted
  // directly.
  it("reports geojson presence without ever selecting the geojson", async () => {
    seedParlcon({ id: 1, name: "Has", slug: "has", boundary_geojson: '{"type":"Polygon"}' });
    seedParlcon({ id: 2, name: "Not", slug: "not", boundary_geojson: null });

    const rows = (await getParlconsPage(session, 1, 100)).rows;
    expect(rows.map((r) => [r.slug, r.has_geojson])).toEqual([
      ["has", 1],
      ["not", 0],
    ]);
    expect(Object.keys(rows[0]!)).not.toContain("boundary_geojson");
  });

  // `IS NOT NULL`, not truthiness: an empty string is a stored-but-useless
  // boundary, and the indicator says "there is a value here", which is what
  // an admin needs to know before deciding to re-fetch it.
  it("counts an empty-string boundary as present", async () => {
    seedParlcon({ id: 1, name: "Empty", slug: "empty", boundary_geojson: "" });

    expect((await getParlconsPage(session, 1, 100)).rows[0]!.has_geojson).toBe(1);
  });

  // THE MUTANTS THESE KILL, run not imagined: dropping `email` from the
  // projection, and aliasing `mp_party AS mp, mp AS mp_party`. Both survive
  // every ordering and geojson test above -- the page still renders, with a
  // blank Email column or with every MP's name and party the wrong way round,
  // which on a list of 650 unfamiliar names nobody would spot. Asserting the
  // WHOLE row with toEqual, rather than the fields the test happens to care
  // about, is what makes a silently dropped or swapped column fail: the key
  // set is pinned as well as the values, so an added column fails too.
  it("returns exactly the nine projected columns, with each value on its own field", async () => {
    seedParlcon({
      id: 7,
      name: "Salisbury",
      slug: "salisbury",
      country: "England",
      mp: "John Glen",
      mp_party: "Conservative",
      mp_parl_id: 4051,
      email: "john.glen.mp@parliament.uk",
      centroid: "51.06,-1.79",
      boundary_geojson: '{"type":"Polygon"}',
      pcon24cd: "E14001434",
    });

    expect({ ...(await getParlconsPage(session, 1, 100)).rows[0]! }).toEqual({
      id: 7,
      name: "Salisbury",
      slug: "salisbury",
      country: "England",
      mp: "John Glen",
      mp_party: "Conservative",
      mp_parl_id: 4051,
      email: "john.glen.mp@parliament.uk",
      has_geojson: 1,
    });
  });

  // Four rows over pages of two: the exactly-full final page that the
  // `hasNext: result.results.length === pageSize` mutant gets wrong. See
  // getLocationsPage's paging test for why this is repeated per function.
  it("pages, and reports hasNext false on a full final page", async () => {
    for (let i = 1; i <= 4; i += 1) seedParlcon({ id: i, name: `Con ${i}`, slug: `con-${i}` });

    const first = await getParlconsPage(session, 1, 2);
    expect(first.rows.map((r) => r.slug)).toEqual(["con-1", "con-2"]);
    expect({ total: first.total, hasNext: first.hasNext }).toEqual({ total: 4, hasNext: true });

    const last = await getParlconsPage(session, 2, 2);
    expect(last.rows.map((r) => r.slug)).toEqual(["con-3", "con-4"]);
    expect({ total: last.total, hasNext: last.hasNext }).toEqual({ total: 4, hasNext: false });
  });
});

// ===========================================================================
describe("getParlconCsvRows", () => {
  // views.py:2322-2336 politics_csv() reads the DENORMALISED political fields
  // cached on Foodbank and FoodbankLocation -- NOT the
  // ParliamentaryConstituency table the page above lists. Two querysets
  // appended back to back, no dedup, no ordering. The seeded constituency row
  // is here to fail a "fix" that switched this to the obvious-looking table:
  // it would produce one tidy row where the contract is four untidy ones.
  it("concatenates foodbank rows then location rows, with no dedup and no constituency table", async () => {
    seedParlcon({ id: 1, name: "Salisbury", slug: "salisbury", mp: "Someone Else" });
    seedFoodbank({ id: 1, name: "Salisbury FB", slug: "salisbury-fb", parliamentary_constituency_name: "Salisbury", mp: "John Glen", mp_party: "Conservative", mp_parl_id: 4051 });
    seedFoodbank({ id: 2, name: "Durham FB", slug: "durham-fb", parliamentary_constituency_name: "City of Durham", mp: "Mary Foy", mp_party: "Labour", mp_parl_id: 4753 });
    seedLocation({ id: 1, foodbank_id: 1, name: "Loc A", slug: "loc-a", parliamentary_constituency_name: "Salisbury", mp: "John Glen", mp_party: "Conservative", mp_parl_id: 4051 });

    const rows = await getParlconCsvRows(session);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.constituency)).toEqual(["Salisbury", "City of Durham", "Salisbury"]);
    expect({ ...rows[0]! }).toEqual({ constituency: "Salisbury", mp: "John Glen", mp_party: "Conservative", mp_parl_id: 4051 });
  });

  // No WHERE clause on either half: `get_all_foodbanks()` is
  // `Foodbank.objects.all()` (givefood/utils/cache.py:37-45) and locations is
  // a bare `.all()`. A closed food bank, and a row whose lookup never ran,
  // both still occupy a line in the export -- real people diff this file
  // between exports, so a row silently disappearing is worse than a blank.
  it("includes closed food banks and rows whose constituency was never looked up", async () => {
    seedFoodbank({ id: 1, name: "Closed", slug: "closed", is_closed: 1, parliamentary_constituency_name: "Somewhere", mp_parl_id: 1 });
    seedFoodbank({ id: 2, name: "Unlooked", slug: "unlooked", parliamentary_constituency_name: null, mp: null, mp_party: null, mp_parl_id: null });

    const rows = await getParlconCsvRows(session);
    expect(rows).toHaveLength(2);
    expect({ ...rows[1]! }).toEqual({ constituency: null, mp: null, mp_party: null, mp_parl_id: null });
  });
});

// ===========================================================================
describe("getOrdersPage", () => {
  // views.py:382-383 does `sort_string = sort` then `sort = "-%s" % (sort)`.
  // This is the ONE list Django always sorts descending, which is why
  // getOrdersPage has no direction argument at all. An "asc" default copied
  // over from its neighbours would put the oldest delivery in 2018 at the top
  // of the orders screen.
  it("always sorts descending, whichever key is chosen", async () => {
    seedFoodbank({ id: 1, name: "Salisbury", slug: "salisbury" });
    seedOrder({ id: 1, order_id: "small", foodbank_id: 1, no_items: 5, delivery_datetime: "2026-01-01 09:00:00.000000" });
    seedOrder({ id: 2, order_id: "large", foodbank_id: 1, no_items: 500, delivery_datetime: "2020-01-01 09:00:00.000000" });

    expect((await getOrdersPage(session, "no_items", 1, 100)).rows.map((r) => r.order_id)).toEqual(["large", "small"]);
    expect((await getOrdersPage(session, "delivery_datetime", 1, 100)).rows.map((r) => r.order_id)).toEqual(["small", "large"]);
  });

  // Another column-existence probe: every key is prefixed `o.` and dropped
  // into the statement, so one naming a column `orders` does not have is a
  // "no such column" on that header alone. The ordering itself is pinned by
  // the descending test above, which is what fails if `sort` stops reaching
  // the ORDER BY.
  it("can sort by every key in ORDER_LIST_SORTS", async () => {
    seedOrder({ id: 1, order_id: "a" });
    seedOrder({ id: 2, order_id: "b" });

    for (const sort of ORDER_LIST_SORTS) {
      expect((await getOrdersPage(session, sort, 1, 100)).rows, `sort=${sort}`).toHaveLength(2);
    }
  });

  // orders.foodbank_id is nullable (0005_orders_and_charity.sql:32) and
  // Django renders "Unassigned" for it (views.py:404). An INNER join would
  // make unassigned orders unreachable from the admin -- the exact rows an
  // admin most needs to find, since assigning them is the job.
  it("keeps an unassigned order, with a null foodbank name and slug", async () => {
    seedFoodbank({ id: 1, name: "Salisbury", slug: "salisbury" });
    seedOrder({ id: 1, order_id: "assigned", foodbank_id: 1, created: "2026-01-02 00:00:00.000000" });
    seedOrder({ id: 2, order_id: "unassigned", foodbank_id: null, created: "2026-01-01 00:00:00.000000" });

    const page = await getOrdersPage(session, "created", 1, 100);
    expect(page.rows.map((r) => [r.order_id, r.foodbank_name, r.foodbank_slug])).toEqual([
      ["assigned", "Salisbury", "salisbury"],
      ["unassigned", null, null],
    ]);
    expect(page.total).toBe(2);
  });

  // `ORDER BY o.${sort}` -- the `o.` matters. Both `orders` and `foodbank`
  // have a `created` column, and the food bank here is deliberately created
  // in the opposite order to its orders, so an unqualified or f-qualified
  // sort would return the reverse of this.
  it("sorts by the ORDER's created, not the joined food bank's", async () => {
    seedFoodbank({ id: 1, name: "Older Parent", slug: "older", created: "2001-01-01 00:00:00.000000" });
    seedFoodbank({ id: 2, name: "Newer Parent", slug: "newer", created: "2020-01-01 00:00:00.000000" });
    seedOrder({ id: 1, order_id: "from-older-parent", foodbank_id: 1, created: "2026-09-05 20:00:00.000000" });
    seedOrder({ id: 2, order_id: "from-newer-parent", foodbank_id: 2, created: "2026-09-05 08:00:00.000000" });

    expect((await getOrdersPage(session, "created", 1, 100)).rows.map((r) => r.order_id)).toEqual(["from-older-parent", "from-newer-parent"]);
  });

  // THE MUTANTS THIS KILLS, run not imagined: dropping `o.delivery_provider_id`
  // from the projection, and aliasing `o.calories AS weight, o.weight AS
  // calories` (or the delivery_provider pair) the wrong way round. None of
  // them throws, none changes the row count, and every other test in this
  // describe reads only order_id and foodbank_name -- so the orders screen
  // would render a full table of transposed numbers. The values are
  // deliberately all different so a swap cannot coincide, and the assertion
  // pins the KEY SET as well, which is the only thing that catches a column
  // that stopped being selected.
  it("returns exactly the fourteen projected columns, with each value on its own field", async () => {
    seedFoodbank({ id: 1, name: "Salisbury", slug: "salisbury" });
    seedOrder({
      id: 42,
      order_id: "GF-2026-0042",
      foodbank_id: 1,
      created: "2026-09-05 19:28:08.853000",
      delivery_date: "2026-09-08",
      delivery_hour: 11,
      delivery_datetime: "2026-09-08 11:00:00.000000",
      delivery_provider: "Bankuet",
      delivery_provider_id: "BK-7781",
      country: "England",
      weight: 1234,
      calories: 56789,
      no_items: 37,
      cost: 4321,
      actual_cost: 4100,
    });

    expect({ ...(await getOrdersPage(session, "created", 1, 100)).rows[0]! }).toEqual({
      id: 42,
      order_id: "GF-2026-0042",
      created: "2026-09-05 19:28:08.853000",
      delivery_datetime: "2026-09-08 11:00:00.000000",
      delivery_provider: "Bankuet",
      delivery_provider_id: "BK-7781",
      foodbank_name: "Salisbury",
      foodbank_slug: "salisbury",
      country: "England",
      weight: 1234,
      calories: 56789,
      no_items: 37,
      cost: 4321,
      actual_cost: 4100,
    });
  });

  // Four rows over pages of two: the exactly-full final page the
  // `hasNext: result.results.length === pageSize` mutant gets wrong. See
  // getLocationsPage's paging test for why this is repeated per function.
  it("pages, and reports hasNext false on a full final page", async () => {
    for (let i = 1; i <= 4; i += 1) seedOrder({ id: i, order_id: `o${i}`, created: `2026-01-0${i} 00:00:00.000000` });

    const first = await getOrdersPage(session, "created", 1, 2);
    expect(first.rows.map((r) => r.order_id)).toEqual(["o4", "o3"]);
    expect({ total: first.total, hasNext: first.hasNext }).toEqual({ total: 4, hasNext: true });

    const last = await getOrdersPage(session, "created", 2, 2);
    expect(last.rows.map((r) => r.order_id)).toEqual(["o2", "o1"]);
    expect({ total: last.total, hasNext: last.hasNext }).toEqual({ total: 4, hasNext: false });
  });
});

// ===========================================================================
describe("getAllOrdersForCsv", () => {
  it("returns every order newest-created first, unassigned included", async () => {
    seedFoodbank({ id: 1, name: "Salisbury", slug: "salisbury" });
    seedOrder({ id: 1, order_id: "old", foodbank_id: 1, created: "2026-09-05 08:00:00.000000" });
    seedOrder({ id: 2, order_id: "new", foodbank_id: null, created: "2026-09-05 19:28:08.853000" });

    const rows = await getAllOrdersForCsv(session);
    expect(rows.map((r) => [r.order_id, r.foodbank_name])).toEqual([
      ["new", null],
      ["old", "Salisbury"],
    ]);
  });

  // SUSPECT, PINNED AS-IS. The return type is OrderListRow, which declares
  // `delivery_provider_id` and `foodbank_slug`, but this statement selects
  // neither -- so both are `undefined` on every row, with no error anywhere.
  // Harmless today because adminOrdersCsv (lists.ts:502-508) reads only the
  // eleven columns Django's frozen header names, but the type says otherwise
  // and the next caller to trust it gets "undefined" in a CSV cell. Asserted
  // as absent rather than "fixed" here: see TESTING.md's rule about pinning
  // what the code does.
  //
  // Asserted as a WHOLE-ROW toEqual rather than two `not.toContain` checks,
  // because that also kills the mutant a key-set assertion cannot see:
  // aliasing `o.actual_cost AS cost, o.cost AS actual_cost`. The export's
  // header is a frozen contract (views.py:396-408 -- real people diff this
  // file between runs), so swapping the ordered cost and the delivered cost
  // would change every row of a spreadsheet somebody is reconciling against
  // invoices, with no key missing to give it away.
  //
  // Twelve fields for eleven CSV cells, because adminOrdersCsv (lists.ts:
  // 502-508) writes `order_id` under the header "id" and never reads the
  // numeric `o.id` this query also selects. That is Django's own choice --
  // the public order reference is what belongs in an export -- so `id` is
  // pinned here as SELECTED-BUT-UNUSED rather than trimmed.
  it("omits delivery_provider_id and foodbank_slug despite declaring them, and keeps cost and actual_cost apart", async () => {
    seedFoodbank({ id: 1, name: "Salisbury", slug: "salisbury" });
    seedOrder({
      id: 1,
      order_id: "o1",
      foodbank_id: 1,
      delivery_provider: "Bankuet",
      delivery_provider_id: "DPD-123",
      created: "2026-09-05 19:28:08.853000",
      delivery_datetime: "2026-09-08 11:00:00.000000",
      country: "England",
      weight: 1234,
      calories: 56789,
      no_items: 37,
      cost: 4321,
      actual_cost: 4100,
    });

    expect({ ...(await getAllOrdersForCsv(session))[0]! }).toEqual({
      id: 1,
      order_id: "o1",
      created: "2026-09-05 19:28:08.853000",
      delivery_datetime: "2026-09-08 11:00:00.000000",
      delivery_provider: "Bankuet",
      foodbank_name: "Salisbury",
      country: "England",
      weight: 1234,
      calories: 56789,
      no_items: 37,
      cost: 4321,
      actual_cost: 4100,
    });
  });
});

// ===========================================================================
describe("getRecentArticlesForAdmin", () => {
  // The dashboard panel the featured-article toggle lives on. The two
  // 2026-09-05 values differ only in time, so a comparison that fell back to
  // dates -- or a mixed ISO value -- would swap them; the LIMIT then hides
  // the mistake by cutting the list before an admin can see it.
  it("returns the most recently published articles first, up to the limit", async () => {
    seedFoodbank({ id: 1, name: "Salisbury", slug: "salisbury" });
    seedArticle({ id: 1, foodbank_id: 1, title: "Morning", url: "https://x/1", published_date: "2026-09-05 08:00:00.000000" });
    seedArticle({ id: 2, foodbank_id: 1, title: "Evening", url: "https://x/2", published_date: "2026-09-05 19:28:08.853000" });
    seedArticle({ id: 3, foodbank_id: 1, title: "Last week", url: "https://x/3", published_date: "2026-08-29 12:00:00.000000" });

    expect((await getRecentArticlesForAdmin(session, 2)).map((r) => r.title)).toEqual(["Evening", "Morning"]);
  });

  it("returns everything when the limit exceeds the table", async () => {
    seedArticle({ id: 1, foodbank_id: null, title: "Only", url: "https://x/1", published_date: "2026-09-05 08:00:00.000000" });

    expect(await getRecentArticlesForAdmin(session, 50)).toHaveLength(1);
  });

  // THE MUTANT THIS KILLS, run not imagined: `a.url` dropped from the
  // projection. The panel's whole job is a list of headlines an admin clicks
  // through to before deciding whether to feature one, and every other test
  // here reads title/featured/foodbank_name -- so the link would go to
  // `undefined` and the suite would stay green. The key set is pinned too,
  // which is the only assertion a dropped column cannot pass.
  it("returns exactly the seven projected columns, with each value on its own field", async () => {
    seedFoodbank({ id: 3, name: "Salisbury", slug: "salisbury" });
    seedArticle({ id: 8, foodbank_id: 3, title: "Christmas appeal opens", url: "https://example.org/news/xmas", published_date: "2026-09-05 19:28:08.853000", featured: 1 });

    expect({ ...(await getRecentArticlesForAdmin(session, 10))[0]! }).toEqual({
      id: 8,
      foodbank_name: "Salisbury",
      foodbank_slug: "salisbury",
      title: "Christmas appeal opens",
      url: "https://example.org/news/xmas",
      published_date: "2026-09-05 19:28:08.853000",
      featured: true,
    });
  });

  // `featured` is an INTEGER in D1 and a boolean in the template's
  // `{% if %}`. The mapper is a one-liner and the panel renders either way,
  // so nothing would go red if it were dropped -- except that the star button
  // would show the wrong state for every article.
  it("maps featured to a real boolean", async () => {
    seedArticle({ id: 1, foodbank_id: null, title: "Starred", url: "https://x/1", published_date: "2026-09-02 00:00:00.000000", featured: 1 });
    seedArticle({ id: 2, foodbank_id: null, title: "Plain", url: "https://x/2", published_date: "2026-09-01 00:00:00.000000", featured: 0 });

    expect((await getRecentArticlesForAdmin(session, 10)).map((r) => [r.title, r.featured])).toEqual([
      ["Starred", true],
      ["Plain", false],
    ]);
  });

  // foodbankarticle.foodbank_id is nullable (0003_homepage_data.sql:49), and
  // this panel is on the dashboard -- an inner join would drop unattached
  // articles from the only screen that can feature them.
  it("keeps an article with no food bank, with null name and slug", async () => {
    seedFoodbank({ id: 1, name: "Salisbury", slug: "salisbury" });
    seedArticle({ id: 1, foodbank_id: 1, title: "Attached", url: "https://x/1", published_date: "2026-09-02 00:00:00.000000" });
    seedArticle({ id: 2, foodbank_id: null, title: "Loose", url: "https://x/2", published_date: "2026-09-01 00:00:00.000000" });

    expect((await getRecentArticlesForAdmin(session, 10)).map((r) => [r.title, r.foodbank_name, r.foodbank_slug])).toEqual([
      ["Attached", "Salisbury", "salisbury"],
      ["Loose", null, null],
    ]);
  });
});

// ===========================================================================
describe("toggleArticleFeatured", () => {
  // views.py:3402 is `article.featured = not article.featured` -- a FLIP.
  // `SET featured = 1` would look right in every screenshot of an unfeatured
  // article and make the button impossible to un-press.
  it("flips rather than sets, in both directions, and persists", async () => {
    seedArticle({ id: 1, foodbank_id: null, title: "A", url: "https://x/1", published_date: "2026-09-01 00:00:00.000000", featured: 0 });

    expect(await toggleArticleFeatured(session, 1)).toBe(true);
    expect(db.prepare("SELECT featured FROM foodbankarticle WHERE id = 1").get()).toMatchObject({ featured: 1 });

    expect(await toggleArticleFeatured(session, 1)).toBe(false);
    expect(db.prepare("SELECT featured FROM foodbankarticle WHERE id = 1").get()).toMatchObject({ featured: 0 });
  });

  // Django's get_object_or_404. The RETURNING clause is what lets this
  // distinguish "flipped to off" (false) from "no such article" (null) in one
  // round trip -- collapsing the two would make the route render a
  // not-featured star for an id that does not exist.
  it("returns null for an unknown article and touches nothing", async () => {
    seedArticle({ id: 1, foodbank_id: null, title: "A", url: "https://x/1", published_date: "2026-09-01 00:00:00.000000", featured: 1 });

    expect(await toggleArticleFeatured(session, 999)).toBeNull();
    expect(db.prepare("SELECT featured FROM foodbankarticle WHERE id = 1").get()).toMatchObject({ featured: 1 });
  });

  // The WHERE clause, seeded so its absence is visible: an UPDATE without it
  // would toggle every article on the site from one button press.
  it("toggles only the named article", async () => {
    seedArticle({ id: 1, foodbank_id: null, title: "A", url: "https://x/1", published_date: "2026-09-01 00:00:00.000000", featured: 0 });
    seedArticle({ id: 2, foodbank_id: null, title: "B", url: "https://x/2", published_date: "2026-09-01 00:00:00.000000", featured: 0 });

    await toggleArticleFeatured(session, 1);
    expect(db.prepare("SELECT id, featured FROM foodbankarticle ORDER BY id").all()).toMatchObject([
      { id: 1, featured: 1 },
      { id: 2, featured: 0 },
    ]);
  });
});

// ===========================================================================
describe("getPlacesPage", () => {
  // THE MUTANT THIS KILLS, run not imagined: `ORDER BY ${sort}` hardcoded to
  // `ORDER BY population`. A length-only version of this test -- which is what
  // it used to be -- did not catch it, and neither did the NULL-population
  // test below, because that one happens to sort by population anyway. Two of
  // this page's three column headers would stop working with nothing to show
  // for it.
  //
  // The three rows are arranged so all three keys give three DIFFERENT
  // orders: by name A/B/C, by county C/B/A, by population A/C/B. Descending is
  // asserted as the exact reverse rather than by length, which is what pins
  // the direction argument as actually reaching the SQL.
  it("sorts by each key in PLACE_LIST_SORTS in both directions, and the three keys disagree", async () => {
    seedPlace({ id: 1, name: "Amesbury", county: "Wiltshire", population: 10000 });
    seedPlace({ id: 2, name: "Bath", county: "Somerset", population: 94000 });
    seedPlace({ id: 3, name: "Corsham", county: "Avon", population: 13000 });

    const expected: Record<(typeof PLACE_LIST_SORTS)[number], string[]> = {
      name: ["Amesbury", "Bath", "Corsham"],
      county: ["Corsham", "Bath", "Amesbury"],
      population: ["Amesbury", "Corsham", "Bath"],
    };
    for (const sort of PLACE_LIST_SORTS) {
      expect((await getPlacesPage(session, sort, "asc", 1, 100)).rows.map((r) => r.name), `sort=${sort}`).toEqual(expected[sort]);
      expect((await getPlacesPage(session, sort, "desc", 1, 100)).rows.map((r) => r.name), `sort=${sort} desc`).toEqual([...expected[sort]].reverse());
    }
  });

  // population is nullable (0009_aac.sql:17). SQLite sorts NULL first
  // ascending and last descending, so the places with no figure cluster at
  // one end -- worth pinning because an admin sorting by population to find
  // the biggest towns gets a screenful of blanks under "asc" and would
  // reasonably file that as a bug rather than as SQL.
  it("clusters NULL populations first ascending and last descending", async () => {
    seedPlace({ id: 1, name: "Known", population: 1000 });
    seedPlace({ id: 2, name: "Unknown", population: null });

    expect((await getPlacesPage(session, "population", "asc", 1, 100)).rows.map((r) => r.name)).toEqual(["Unknown", "Known"]);
    expect((await getPlacesPage(session, "population", "desc", 1, 100)).rows.map((r) => r.name)).toEqual(["Known", "Unknown"]);
  });

  // §4.8.7 trimmed `place` to read-only columns, and this list projects five
  // of them. name_upper in particular is a Postgres-computed shadow of `name`
  // (0009_aac.sql:15) that must never reach a template -- a `SELECT *` here
  // would still pass every other test in this describe.
  it("projects only the five columns the page renders", async () => {
    seedPlace({ id: 1, name: "Amesbury", name_upper: "AMESBURY", lat_lng: "51.17,-1.78", county: "Wiltshire", population: 10000 });

    const row = (await getPlacesPage(session, "name", "asc", 1, 100)).rows[0]!;
    expect({ ...row }).toEqual({ id: 1, name: "Amesbury", lat_lng: "51.17,-1.78", county: "Wiltshire", population: 10000 });
  });

  // Four rows over pages of two: the exactly-full final page the
  // `hasNext: result.results.length === pageSize` mutant gets wrong. See
  // getLocationsPage's paging test for why this is repeated per function.
  // It matters most here -- `place` is the biggest table in the schema, so
  // this is the pager an admin actually clicks through.
  it("pages, and reports hasNext false on a full final page", async () => {
    for (let i = 1; i <= 4; i += 1) seedPlace({ id: i, name: `Place ${i}` });

    const first = await getPlacesPage(session, "name", "asc", 1, 2);
    expect(first.rows.map((r) => r.name)).toEqual(["Place 1", "Place 2"]);
    expect({ total: first.total, hasNext: first.hasNext }).toEqual({ total: 4, hasNext: true });

    const last = await getPlacesPage(session, "name", "asc", 2, 2);
    expect(last.rows.map((r) => r.name)).toEqual(["Place 3", "Place 4"]);
    expect({ total: last.total, hasNext: last.hasNext }).toEqual({ total: 4, hasNext: false });
  });
});

// ===========================================================================
// ONE MUTANT IS DELIBERATELY NOT TESTED HERE, because it is equivalent:
// `branches.join(" UNION ALL ")` changed to `" UNION "`. Every row this union
// emits carries a row_id that is unique by construction -- the food bank's
// own primary key for mobile/webpush, and the (email, foodbank) pair that
// sub_email_fb_uniq already enforces for email -- so there is never a
// duplicate for UNION to collapse, and the two spellings return identical
// rows in identical order. It was run against the whole file and no test
// failed, which is the correct outcome, not a hole: the difference is that
// UNION makes D1 sort and dedup for nothing. Asserting it would need a test
// that cannot fail, so there isn't one, and this comment is here so the next
// person to notice the gap knows it was measured.
describe("getSubscriptionsPage", () => {
  function seedThreeTypes(): void {
    seedFoodbank({ id: 1, name: "Salisbury", slug: "salisbury" });
    seedEmailSub({ id: 1, foodbank_id: 1, email: "a@example.org", created: "2026-09-05 08:00:00.000000" });
    seedMobileSub({ id: 1, foodbank_id: 1, device_id: "abc", platform: "iOS", created: "2026-09-05 12:00:00.000000" });
    seedWebpushSub({ id: 1, foodbank_id: 1, endpoint: "https://push/1", browser: "Firefox", created: "2026-09-05 19:28:08.853000" });
  }

  // The UNION ALL exists so D1 does the sort and the page, instead of the
  // Worker materialising three tables into memory the way Django does
  // (views.py:2896-2977, described in WP 6.6's own research as "a real
  // scaling risk"). All three timestamps share a date and differ only in
  // time, so the interleaving is a genuine cross-table sort and not three
  // blocks that happen to be in the right order.
  it("interleaves all three tables in one created-descending order", async () => {
    seedThreeTypes();

    const page = await getSubscriptionsPage(session, "all", 1, 100);
    expect(page.rows.map((r) => r.type)).toEqual(["webpush", "mobile", "email"]);
    expect(page.total).toBe(3);
  });

  it("returns only the requested type, with a total to match", async () => {
    seedThreeTypes();

    for (const [type, expected] of [
      ["email", ["email"]],
      ["mobile", ["mobile"]],
      ["webpush", ["webpush"]],
    ] as const) {
      const page = await getSubscriptionsPage(session, type, 1, 100);
      expect(page.rows.map((r) => r.type), type).toEqual(expected);
      expect(page.total, type).toBe(1);
    }
  });

  // views.py:2899's `.filter(confirmed=True)` -- and ONLY the email branch
  // has it. An unconfirmed subscriber has not agreed to anything yet and must
  // not appear on a page whose purpose is managing live subscriptions. The
  // count runs over the same union, so it has to drop the row too.
  it("hides an unconfirmed email subscriber from both the rows and the total", async () => {
    seedFoodbank({ id: 1, name: "Salisbury", slug: "salisbury" });
    seedEmailSub({ id: 1, foodbank_id: 1, email: "yes@example.org", confirmed: 1, created: "2026-09-01 00:00:00.000000" });
    seedEmailSub({ id: 2, foodbank_id: 1, email: "no@example.org", confirmed: 0, created: "2026-09-02 00:00:00.000000" });

    const page = await getSubscriptionsPage(session, "email", 1, 100);
    expect(page.rows.map((r) => r.identifier)).toEqual(["yes@example.org"]);
    expect(page.total).toBe(1);
  });

  // DEVICE_ID_TRUNCATE_LENGTH = 20 (views.py:42) and Django's
  // `sub.device_id[:20] + "..." if len(...) > 20 else sub.device_id`. The
  // conditional is the point: without it a 20-character device id would
  // render with a trailing "..." implying it had been cut, on the page whose
  // whole job is identifying a row before deleting it.
  it("truncates a device id only when it was actually cut", async () => {
    seedFoodbank({ id: 1, name: "Salisbury", slug: "salisbury" });
    seedMobileSub({ id: 1, foodbank_id: 1, platform: "iOS", device_id: "a".repeat(20), created: "2026-09-02 00:00:00.000000" });
    seedMobileSub({ id: 2, foodbank_id: 1, platform: "Android", device_id: "b".repeat(21), created: "2026-09-01 00:00:00.000000" });

    expect((await getSubscriptionsPage(session, "mobile", 1, 100)).rows.map((r) => r.identifier)).toEqual([
      `iOS - ${"a".repeat(20)}`,
      `Android - ${"b".repeat(20)}...`,
    ]);
  });

  // ENDPOINT_TRUNCATE_LENGTH = 30 (views.py:43), same conditional.
  it("truncates a push endpoint only when it was actually cut", async () => {
    seedFoodbank({ id: 1, name: "Salisbury", slug: "salisbury" });
    seedWebpushSub({ id: 1, foodbank_id: 1, endpoint: "e".repeat(30), browser: "Chrome", created: "2026-09-02 00:00:00.000000" });
    seedWebpushSub({ id: 2, foodbank_id: 1, endpoint: "f".repeat(31), browser: "Chrome", created: "2026-09-01 00:00:00.000000" });

    expect((await getSubscriptionsPage(session, "webpush", 1, 100)).rows.map((r) => r.identifier)).toEqual([
      `Chrome - ${"e".repeat(30)}`,
      `Chrome - ${"f".repeat(30)}...`,
    ]);
  });

  // adminLists.ts claims "SQLite's length()/substr() count characters,
  // matching Python's len()/[:20]". Checked by RUNNING both, per TESTING.md,
  // not by reasoning: a 21-character string of astral emoji gives
  // length() = 21 and substr(...,1,20) = 20 characters in SQLite 3.51, and
  // len() = 21 with s[:20] = 20 code points in CPython 3. JavaScript's own
  // .length would have said 42 for the same string, which is why the
  // truncation lives in SQL rather than in the Worker.
  it("counts code points, not bytes or UTF-16 units, when truncating", async () => {
    seedFoodbank({ id: 1, name: "Salisbury", slug: "salisbury" });
    seedMobileSub({ id: 1, foodbank_id: 1, platform: "iOS", device_id: "\u{1F34E}".repeat(21), created: "2026-09-01 00:00:00.000000" });

    expect((await getSubscriptionsPage(session, "mobile", 1, 100)).rows[0]!.identifier).toBe(`iOS - ${"\u{1F34E}".repeat(20)}...`);
  });

  // views.py:2964's `sub.browser or 'Unknown'` is PYTHON TRUTHINESS, so an
  // empty string is 'Unknown' too. A COALESCE would be the obvious
  // translation and would render "` - https://...`" with a blank where the
  // browser goes.
  it("renders both a NULL and an empty browser as Unknown", async () => {
    seedFoodbank({ id: 1, name: "Salisbury", slug: "salisbury" });
    seedWebpushSub({ id: 1, foodbank_id: 1, endpoint: "https://push/1", browser: null, created: "2026-09-03 00:00:00.000000" });
    seedWebpushSub({ id: 2, foodbank_id: 1, endpoint: "https://push/2", browser: "", created: "2026-09-02 00:00:00.000000" });
    seedWebpushSub({ id: 3, foodbank_id: 1, endpoint: "https://push/3", browser: "Safari", created: "2026-09-01 00:00:00.000000" });

    expect((await getSubscriptionsPage(session, "webpush", 1, 100)).rows.map((r) => r.identifier)).toEqual([
      "Unknown - https://push/1",
      "Unknown - https://push/2",
      "Safari - https://push/3",
    ]);
  });

  // row_id is the delete key, and it is NOT uniform. An email subscription
  // has no single id the delete form can carry -- deleteSubscription resolves
  // the pair -- while mobile and webpush use their own row id, CAST to TEXT
  // so the union's column has one type. Getting this wrong sends a delete to
  // the wrong row or to none.
  it("builds email row_ids as email|slug and the other two as their own id", async () => {
    seedThreeTypes();

    const byType = Object.fromEntries((await getSubscriptionsPage(session, "all", 1, 100)).rows.map((r) => [r.type, r.row_id]));
    expect(byType).toEqual({ email: "a@example.org|salisbury", mobile: "1", webpush: "1" });
  });

  // INNER JOIN on foodbank, in all three branches -- matching Django's
  // select_related over a non-nullable FK. D1 declares no foreign keys
  // (PLAN.md §4.5), so an orphan is possible, and it vanishes from this page
  // entirely. Pinned because it is a real consequence: an admin cannot delete
  // a subscription they cannot see. The count uses the same union, so at
  // least the pager stays honest about it.
  // ALL THREE BRANCHES, not just email. THE MUTANTS THIS KILLS, run not
  // imagined: `JOIN foodbank` softened to `LEFT JOIN` in the mobile branch,
  // and in the webpush branch. An email-only version of this test caught
  // neither, because the union's other two arms were never seeded with an
  // orphan -- and a LEFT JOIN there admits rows whose foodbank_slug is NULL,
  // which is half of an email row_id and the whole of a working delete link.
  // The inner join is Django's own select_related over a non-nullable FK, but
  // D1 declares no foreign keys (PLAN.md §4.5) so orphans are possible; they
  // vanish from this page entirely, which is pinned here because it is a real
  // consequence -- an admin cannot delete a subscription they cannot see. The
  // count runs over the same union, so at least the pager stays honest.
  it("drops a subscription whose food bank is missing, in all three branches, from the rows and the total alike", async () => {
    seedFoodbank({ id: 1, name: "Salisbury", slug: "salisbury" });
    seedEmailSub({ id: 1, foodbank_id: 1, email: "kept@example.org", created: "2026-09-02 00:00:00.000000" });
    seedEmailSub({ id: 2, foodbank_id: 404, email: "orphan@example.org", created: "2026-09-01 00:00:00.000000" });
    seedMobileSub({ id: 1, foodbank_id: 1, device_id: "kept-device", created: "2026-09-04 00:00:00.000000" });
    seedMobileSub({ id: 2, foodbank_id: 404, device_id: "orphan-device", created: "2026-09-03 00:00:00.000000" });
    seedWebpushSub({ id: 1, foodbank_id: 1, endpoint: "https://push/kept", browser: "Chrome", created: "2026-09-06 00:00:00.000000" });
    seedWebpushSub({ id: 2, foodbank_id: 404, endpoint: "https://push/orphan", browser: "Chrome", created: "2026-09-05 00:00:00.000000" });

    const page = await getSubscriptionsPage(session, "all", 1, 100);
    expect(page.rows.map((r) => r.identifier)).toEqual(["Chrome - https://push/kept", "iOS - kept-device", "kept@example.org"]);
    expect(page.total).toBe(3);

    for (const [type, expected] of [
      ["email", 1],
      ["mobile", 1],
      ["webpush", 1],
    ] as const) {
      expect((await getSubscriptionsPage(session, type, 1, 100)).total, type).toBe(expected);
    }
  });

  // Replaces an `expect(rows.every(...)).toBe(true)`, which was two mistakes
  // at once: `every` on an EMPTY array is true, so a query that returned
  // nothing would have passed it, and a boolean assertion says nothing about
  // which row carried which value. A whole-row toEqual pins the key set and
  // every field -- including `created`, which nothing else here reads, so a
  // branch selecting the wrong timestamp column (foodbanksubscriber also has
  // `last_contacted`) would reorder the page and go unnoticed.
  it("carries the parent's name and slug, the raw created timestamp and the row_id onto every row", async () => {
    seedThreeTypes();

    expect((await getSubscriptionsPage(session, "all", 1, 100)).rows.map((r) => ({ ...r }))).toEqual([
      { type: "webpush", identifier: "Firefox - https://push/1", foodbank_name: "Salisbury", foodbank_slug: "salisbury", created: "2026-09-05 19:28:08.853000", row_id: "1" },
      { type: "mobile", identifier: "iOS - abc", foodbank_name: "Salisbury", foodbank_slug: "salisbury", created: "2026-09-05 12:00:00.000000", row_id: "1" },
      { type: "email", identifier: "a@example.org", foodbank_name: "Salisbury", foodbank_slug: "salisbury", created: "2026-09-05 08:00:00.000000", row_id: "a@example.org|salisbury" },
    ]);
  });

  // LIMIT/OFFSET applied to the COMBINED result, not per branch -- the whole
  // reason the ORDER BY sits outside the union. Paging each table separately
  // and stitching would put three rows on page 1 here instead of two.
  it("pages across the union rather than within each table", async () => {
    seedThreeTypes();

    const first = await getSubscriptionsPage(session, "all", 1, 2);
    expect(first.rows.map((r) => r.type)).toEqual(["webpush", "mobile"]);
    expect(first.hasNext).toBe(true);

    const second = await getSubscriptionsPage(session, "all", 2, 2);
    expect(second.rows.map((r) => r.type)).toEqual(["email"]);
    expect(second.hasNext).toBe(false);
  });

  // The exactly-full-last-page case again, on the one list whose total comes
  // from a COUNT over the union rather than over a table -- so that a
  // `hasNext` rewritten from the page's own length is caught here too, not
  // only in getFoodbanksPage. Four rows, pages of two.
  it("reports hasNext false on a full final page of the union", async () => {
    seedFoodbank({ id: 1, name: "Salisbury", slug: "salisbury" });
    for (let i = 1; i <= 4; i += 1) seedWebpushSub({ id: i, foodbank_id: 1, endpoint: `https://push/${i}`, created: `2026-09-0${i} 00:00:00.000000` });

    const page = await getSubscriptionsPage(session, "webpush", 2, 2);
    expect(page.rows.map((r) => r.row_id)).toEqual(["2", "1"]);
    expect({ total: page.total, hasNext: page.hasNext }).toEqual({ total: 4, hasNext: false });
  });

  it("returns an empty page and a zero total when nothing is subscribed", async () => {
    const page = await getSubscriptionsPage(session, "all", 1, 100);
    expect({ rows: page.rows, total: page.total, hasNext: page.hasNext }).toEqual({ rows: [], total: 0, hasNext: false });
  });
});

// ===========================================================================
describe("deleteSubscription", () => {
  // views.py:2997-3020's email branch keys on the PAIR, because one address
  // legitimately subscribes to several food banks. Dropping the foodbank_id
  // predicate would unsubscribe someone from every food bank they follow
  // from a single Delete click, and would report success either way.
  it("deletes only the (email, food bank) pair, leaving the same address's other subscriptions", async () => {
    seedFoodbank({ id: 1, name: "Salisbury", slug: "salisbury" });
    seedFoodbank({ id: 2, name: "Durham", slug: "durham" });
    seedEmailSub({ id: 1, foodbank_id: 1, email: "both@example.org", created: "2026-09-01 00:00:00.000000" });
    seedEmailSub({ id: 2, foodbank_id: 2, email: "both@example.org", created: "2026-09-01 00:00:00.000000" });

    expect(await deleteSubscription(session, "email", "both@example.org|salisbury")).toBe(true);
    expect(db.prepare("SELECT foodbank_id FROM foodbanksubscriber").all()).toMatchObject([{ foodbank_id: 2 }]);
  });

  it("reports false and deletes nothing when the slug names no food bank", async () => {
    seedFoodbank({ id: 1, name: "Salisbury", slug: "salisbury" });
    seedEmailSub({ id: 1, foodbank_id: 1, email: "a@example.org", created: "2026-09-01 00:00:00.000000" });

    expect(await deleteSubscription(session, "email", "a@example.org|no-such-foodbank")).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbanksubscriber").get()).toMatchObject({ n: 1 });
  });

  it("reports false when the address is subscribed to a different food bank", async () => {
    seedFoodbank({ id: 1, name: "Salisbury", slug: "salisbury" });
    seedFoodbank({ id: 2, name: "Durham", slug: "durham" });
    seedEmailSub({ id: 1, foodbank_id: 1, email: "a@example.org", created: "2026-09-01 00:00:00.000000" });

    expect(await deleteSubscription(session, "email", "a@example.org|durham")).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbanksubscriber").get()).toMatchObject({ n: 1 });
  });

  // The row_id arrives from a posted form field, so a malformed one is
  // reachable from outside. Both halves must be present: "a@example.org" with
  // no pipe leaves the slug undefined, and "|salisbury" leaves the email an
  // empty string -- which, without the guard, would DELETE every subscriber
  // of that food bank whose email happened to be "".
  it("refuses a row_id missing either half, before issuing any statement", async () => {
    seedFoodbank({ id: 1, name: "Salisbury", slug: "salisbury" });
    seedEmailSub({ id: 1, foodbank_id: 1, email: "a@example.org", created: "2026-09-01 00:00:00.000000" });

    expect(await deleteSubscription(session, "email", "a@example.org")).toBe(false);
    expect(await deleteSubscription(session, "email", "|salisbury")).toBe(false);
    expect(await deleteSubscription(session, "email", "")).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbanksubscriber").get()).toMatchObject({ n: 1 });
  });

  // A confirmed=0 row never appears in getSubscriptionsPage, but the delete
  // path has no such filter -- so an unsubscribe link's row_id still works.
  // Pinned so a "consistency" fix that added `AND confirmed = 1` here is
  // recognised as a behaviour change rather than tidying.
  it("deletes an unconfirmed subscriber even though the list never shows one", async () => {
    seedFoodbank({ id: 1, name: "Salisbury", slug: "salisbury" });
    seedEmailSub({ id: 1, foodbank_id: 1, email: "pending@example.org", confirmed: 0, created: "2026-09-01 00:00:00.000000" });

    expect(await deleteSubscription(session, "email", "pending@example.org|salisbury")).toBe(true);
  });

  // The two id-keyed tables share an id space, so "delete mobile 1" must not
  // reach webpush 1. Both are seeded with id 1 for exactly that reason: a
  // table name computed from the wrong branch of the ternary would pass any
  // test that seeded only one of them.
  it("deletes from the table the type names, not its neighbour", async () => {
    seedFoodbank({ id: 1, name: "Salisbury", slug: "salisbury" });
    seedMobileSub({ id: 1, foodbank_id: 1, device_id: "d", created: "2026-09-01 00:00:00.000000" });
    seedWebpushSub({ id: 1, foodbank_id: 1, endpoint: "https://push/1", created: "2026-09-01 00:00:00.000000" });

    expect(await deleteSubscription(session, "mobile", "1")).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM mobilesubscriber").get()).toMatchObject({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM webpushsubscription").get()).toMatchObject({ n: 1 });

    expect(await deleteSubscription(session, "webpush", "1")).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM webpushsubscription").get()).toMatchObject({ n: 0 });
  });

  it("reports false for an id-keyed row that is not there", async () => {
    expect(await deleteSubscription(session, "mobile", "999")).toBe(false);
  });

  // THE MUTANT THIS KILLS, run not imagined: deleting the
  // `Number.isInteger(id)` guard entirely. Asserting only "returns false"
  // does NOT catch that -- node:sqlite happily binds NaN and 1.5, matches no
  // row, and reports 0 changes, so the mutant stays green. But D1 is not
  // node:sqlite: a NaN binding comes back as a D1 type error, which reaches
  // app.onError as a 500 over the subscriptions page instead of a redirect.
  // The guard's job is therefore to ISSUE NO STATEMENT AT ALL, so that is
  // what is asserted, by watching what the session was asked to prepare.
  it("refuses a non-integer id without issuing a statement at all", async () => {
    seedFoodbank({ id: 1, name: "Salisbury", slug: "salisbury" });
    seedMobileSub({ id: 1, foodbank_id: 1, device_id: "d", created: "2026-09-01 00:00:00.000000" });

    const prepared: string[] = [];
    const watched = watchStatements(session, prepared);

    expect(await deleteSubscription(watched, "mobile", "abc")).toBe(false);
    expect(await deleteSubscription(watched, "mobile", "1.5")).toBe(false);
    expect(prepared).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM mobilesubscriber").get()).toMatchObject({ n: 1 });
  });

  // The other half of that guard, pinned because it is the surprising half:
  // `Number("")` is 0, not NaN, so an EMPTY row_id passes Number.isInteger
  // and a real `DELETE ... WHERE id = 0` goes to D1. Harmless -- SQLite
  // INTEGER PRIMARY KEY never allocates 0 -- but it is a round trip made on
  // an input the function had every chance to reject, and the empty-string
  // case for the `email` type IS refused three lines earlier in the same
  // function. Asserted, not fixed.
  it("still issues a statement for an empty id-keyed row_id, because Number(\"\") is 0", async () => {
    const prepared: string[] = [];

    expect(await deleteSubscription(watchStatements(session, prepared), "webpush", "")).toBe(false);
    expect(prepared).toEqual(["DELETE FROM webpushsubscription WHERE id = ?"]);
  });

  // SUSPECT, PINNED AS-IS. The guard is `Number.isInteger(Number(rowId))`,
  // and Number() accepts far more than decimal digits: "0x10" is 16, " 1 "
  // is 1, "1e0" is 1. So a posted row_id of "0x10" deletes subscription 16.
  // It is not exploitable beyond what the form already allows -- the value
  // comes from an authenticated admin's own page and any plain "16" would do
  // the same -- so this is asserted, not fixed. A stricter guard
  // (/^\d+$/.test(rowId)) would be the real answer.
  it("accepts hexadecimal, exponent and whitespace-padded row ids", async () => {
    seedFoodbank({ id: 1, name: "Salisbury", slug: "salisbury" });
    seedMobileSub({ id: 16, foodbank_id: 1, device_id: "d", created: "2026-09-01 00:00:00.000000" });

    expect(await deleteSubscription(session, "mobile", "0x10")).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM mobilesubscriber").get()).toMatchObject({ n: 0 });
  });
});

// ===========================================================================
describe("getFoodbanksWithoutNeedPage", () => {
  // WP 6.9's DISTINCT ON -> ROW_NUMBER() rewrite. Two published needs for one
  // food bank on the SAME DAY, four hours apart: rn = 1 must pick the later
  // one. This is ticket #9's exact shape -- `ORDER BY created DESC LIMIT 1`
  // returning the wrong "latest published need" was measured in production
  // when an ISO-formatted value was compared against Django-formatted ones.
  it("attaches the newest published need, discriminating within a single day", async () => {
    seedFoodbank({ id: 1, name: "Salisbury", slug: "salisbury" });
    seedNeed({ id: 1, need_id: "old", foodbank_id: 1, published: 1, created: "2026-09-05 08:00:00.000000" });
    seedNeed({ id: 2, need_id: "new", foodbank_id: 1, published: 1, created: "2026-09-05 19:28:08.853000" });

    const page = await getFoodbanksWithoutNeedPage(session, 1, 100);
    expect(page.rows.map((r) => [r.slug, r.latest_need_id, r.latest_need_created])).toEqual([["salisbury", "new", "2026-09-05 19:28:08.853000"]]);
  });

  // rn = 1 is also a CARDINALITY guard. Drop it and this food bank returns
  // three rows -- the same food bank three times on one page, with a total
  // that says one. Seeded with three needs so that failure is visible.
  it("returns one row per food bank however many needs it has", async () => {
    seedFoodbank({ id: 1, name: "Salisbury", slug: "salisbury" });
    for (let i = 1; i <= 3; i += 1) seedNeed({ id: i, need_id: `n${i}`, foodbank_id: 1, published: 1, created: `2026-09-0${i} 00:00:00.000000` });

    const page = await getFoodbanksWithoutNeedPage(session, 1, 100);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.latest_need_id).toBe("n3");
    expect(page.total).toBe(1);
  });

  // `WHERE published = 1` sits INSIDE the subquery, before ROW_NUMBER runs.
  // Moved outside -- an easy-looking simplification -- an unpublished draft
  // would win rn = 1 and then be filtered away, leaving the food bank looking
  // as if it had no need at all. Which is the opposite of what this page,
  // whose entire job is finding food banks without one, should say.
  it("ignores an unpublished need even when it is the newest", async () => {
    seedFoodbank({ id: 1, name: "Salisbury", slug: "salisbury" });
    seedNeed({ id: 1, need_id: "published", foodbank_id: 1, published: 1, created: "2026-09-01 00:00:00.000000" });
    seedNeed({ id: 2, need_id: "draft", foodbank_id: 1, published: 0, created: "2026-09-09 00:00:00.000000" });

    expect((await getFoodbanksWithoutNeedPage(session, 1, 100)).rows[0]!.latest_need_id).toBe("published");
  });

  // LEFT JOIN. The food bank with nothing to attach is the ONLY row this page
  // exists to show; an inner join would produce a screen that is empty
  // exactly when it matters.
  it("keeps a food bank that has never had a published need, with nulls", async () => {
    seedFoodbank({ id: 1, name: "Has need", slug: "has-need" });
    seedFoodbank({ id: 2, name: "Never", slug: "never" });
    seedNeed({ id: 1, need_id: "n1", foodbank_id: 1, published: 1, created: "2026-09-01 00:00:00.000000" });

    const page = await getFoodbanksWithoutNeedPage(session, 1, 100);
    expect(page.rows.map((r) => [r.slug, r.latest_need_id])).toEqual([
      ["has-need", "n1"],
      ["never", null],
    ]);
  });

  // PARTITION BY foodbank_id -- each food bank gets its own latest, not the
  // site's latest. A partition on the wrong column (or none) would give every
  // food bank the same need id, which reads perfectly plausibly on a page
  // full of short uuids.
  it("gives each food bank its own latest need, not the site's", async () => {
    seedFoodbank({ id: 1, name: "Alpha", slug: "alpha" });
    seedFoodbank({ id: 2, name: "Beta", slug: "beta" });
    seedNeed({ id: 1, need_id: "alpha-old", foodbank_id: 1, published: 1, created: "2026-01-01 00:00:00.000000" });
    seedNeed({ id: 2, need_id: "alpha-new", foodbank_id: 1, published: 1, created: "2026-02-01 00:00:00.000000" });
    seedNeed({ id: 3, need_id: "beta-only", foodbank_id: 2, published: 1, created: "2026-03-01 00:00:00.000000" });

    expect((await getFoodbanksWithoutNeedPage(session, 1, 100)).rows.map((r) => [r.slug, r.latest_need_id])).toEqual([
      ["alpha", "alpha-new"],
      ["beta", "beta-only"],
    ]);
  });

  // foodbankchange.foodbank_id is nullable -- an unassigned need. Those rows
  // form their own ROW_NUMBER partition, and `latest.foodbank_id = f.id`
  // never matches NULL, so they attach to nobody. Worth pinning: an
  // unassigned need is by definition the newest one nobody has triaged, so a
  // join that let it through would attach the same stray need to whichever
  // food bank the plan happened to reach first.
  it("never attaches an unassigned need to anyone", async () => {
    seedFoodbank({ id: 1, name: "Salisbury", slug: "salisbury" });
    seedNeed({ id: 1, need_id: "stray", foodbank_id: null, published: 1, created: "2026-09-09 00:00:00.000000" });

    expect((await getFoodbanksWithoutNeedPage(session, 1, 100)).rows[0]!.latest_need_id).toBeNull();
  });

  // Django's `Foodbank.objects.all()` (views.py:3099) -- no is_closed filter,
  // unlike getFoodbanksPage twenty lines up the page. A closed food bank with
  // no need is not a problem to chase, but the port matches Django rather
  // than improving on it, and the total has to agree.
  it("includes closed food banks", async () => {
    seedFoodbank({ id: 1, name: "Open", slug: "open", is_closed: 0 });
    seedFoodbank({ id: 2, name: "Shut", slug: "shut", is_closed: 1 });

    const page = await getFoodbanksWithoutNeedPage(session, 1, 100);
    expect(page.rows.map((r) => r.slug)).toEqual(["open", "shut"]);
    expect(page.total).toBe(2);
  });

  // Ordering, plus the exactly-full final page that the `hasNext:
  // result.results.length === pageSize` mutant gets wrong -- four rows over
  // pages of two rather than three, which is what the earlier version of this
  // test used and which that mutant survives. See getLocationsPage's paging
  // test for why the same shape is repeated in every describe.
  it("orders by food bank name and pages, reporting hasNext false on a full final page", async () => {
    seedFoodbank({ id: 1, name: "Charlie", slug: "charlie" });
    seedFoodbank({ id: 2, name: "Alpha", slug: "alpha" });
    seedFoodbank({ id: 3, name: "Bravo", slug: "bravo" });
    seedFoodbank({ id: 4, name: "Delta", slug: "delta" });

    const first = await getFoodbanksWithoutNeedPage(session, 1, 2);
    expect(first.rows.map((r) => r.slug)).toEqual(["alpha", "bravo"]);
    expect({ total: first.total, hasNext: first.hasNext }).toEqual({ total: 4, hasNext: true });

    const last = await getFoodbanksWithoutNeedPage(session, 2, 2);
    expect(last.rows.map((r) => r.slug)).toEqual(["charlie", "delta"]);
    expect({ total: last.total, hasNext: last.hasNext }).toEqual({ total: 4, hasNext: false });
  });

  // The whole row, key set included: this list is five columns wide and the
  // four tests above read only slug and latest_need_id, so a projection that
  // stopped selecting `latest.created AS latest_need_created` would leave the
  // "last need" column blank on the page whose entire purpose is showing how
  // stale each food bank's need is.
  it("returns exactly the five projected columns", async () => {
    seedFoodbank({ id: 5, name: "Salisbury", slug: "salisbury" });
    seedNeed({ id: 1, need_id: "b8f3c0d2", foodbank_id: 5, published: 1, created: "2026-09-05 19:28:08.853000" });

    expect({ ...(await getFoodbanksWithoutNeedPage(session, 1, 100)).rows[0]! }).toEqual({
      id: 5,
      name: "Salisbury",
      slug: "salisbury",
      latest_need_id: "b8f3c0d2",
      latest_need_created: "2026-09-05 19:28:08.853000",
    });
  });
});

// ===========================================================================
describe("getNeedsPage", () => {
  // Django's needs() is `.order_by("-created")[:200]` -- a hard cap with no
  // way to reach need 201. Paginated here, which makes the whole table
  // reachable; the ordering is Django's. Same-day values again, because a
  // needs queue that shows yesterday evening above this morning is wrong in a
  // way nobody notices from a screenshot.
  it("returns the newest needs first, discriminating within a single day", async () => {
    seedNeed({ id: 1, need_id: "morning", foodbank_id: null, created: "2026-09-05 08:00:00.000000" });
    seedNeed({ id: 2, need_id: "evening", foodbank_id: null, created: "2026-09-05 19:28:08.853000" });
    seedNeed({ id: 3, need_id: "yesterday", foodbank_id: null, created: "2026-09-04 23:59:59.999999" });

    expect((await getNeedsPage(session, 1, 100)).rows.map((r) => r.need_id)).toEqual(["evening", "morning", "yesterday"]);
  });

  // adminLists.ts's own comment: foodbank_slug is LEFT JOINed from the real
  // FK rather than taken from a slugified name, because needs.html links the
  // food bank cell and a slugified name is not reliably the food bank's slug.
  // This food bank proves the difference exists -- slugify("St Mary's
  // Foodbank") is "st-marys-foodbank", and its actual slug is not that.
  it("links via the parent's real slug, not one derived from its name", async () => {
    seedFoodbank({ id: 1, name: "St Mary's Foodbank", slug: "salisbury-st-marys" });
    seedNeed({ id: 1, need_id: "n1", foodbank_id: 1, created: "2026-09-01 00:00:00.000000" });

    const row = (await getNeedsPage(session, 1, 100)).rows[0]!;
    expect({ name: row.foodbank_name, slug: row.foodbank_slug }).toEqual({ name: "St Mary's Foodbank", slug: "salisbury-st-marys" });
  });

  // foodbankchange.foodbank_id is nullable and an unassigned need is the one
  // an admin most needs to find. An inner join would hide it, and the pager
  // -- counting the base table -- would still claim it was there.
  it("keeps an unassigned need, with a null name and slug", async () => {
    seedFoodbank({ id: 1, name: "Salisbury", slug: "salisbury" });
    seedNeed({ id: 1, need_id: "assigned", foodbank_id: 1, created: "2026-09-02 00:00:00.000000" });
    seedNeed({ id: 2, need_id: "unassigned", foodbank_id: null, created: "2026-09-01 00:00:00.000000" });

    const page = await getNeedsPage(session, 1, 100);
    expect(page.rows.map((r) => [r.need_id, r.foodbank_name, r.foodbank_slug])).toEqual([
      ["assigned", "Salisbury", "salisbury"],
      ["unassigned", null, null],
    ]);
    expect(page.total).toBe(2);
  });

  // DELIBERATE DIVERGENCE FROM ITS NEIGHBOURS, PINNED. Every other list in
  // this file runs its rows through a mapper that turns 0/1 into booleans;
  // NeedListRow declares `published: number` and `is_categorised: number |
  // null` and getNeedsPage returns the raw D1 integers. A template writing
  // `{% if need.published %}` works either way, so nothing would go red if
  // someone "harmonised" this -- but anything comparing `=== 1`, or
  // serialising these rows, would change behaviour silently.
  it("returns published and is_categorised as raw integers, not booleans", async () => {
    seedNeed({ id: 1, need_id: "n1", foodbank_id: null, published: 1, is_categorised: 0, created: "2026-09-02 00:00:00.000000" });
    seedNeed({ id: 2, need_id: "n2", foodbank_id: null, published: 0, is_categorised: null, created: "2026-09-01 00:00:00.000000" });

    const rows = (await getNeedsPage(session, 1, 100)).rows;
    expect(rows.map((r) => [r.published, r.is_categorised])).toEqual([
      [1, 0],
      [0, null],
    ]);
  });

  // Unlike the food bank list, needs are NOT filtered by published -- the
  // review queue is where unpublished needs get published from.
  it("does not filter unpublished needs", async () => {
    seedNeed({ id: 1, need_id: "draft", foodbank_id: null, published: 0, created: "2026-09-01 00:00:00.000000" });

    expect((await getNeedsPage(session, 1, 100)).total).toBe(1);
  });

  // THE MUTANTS THIS KILLS, run not imagined: `n.excess_change_text` and
  // `n.input_method` dropped from the projection, and `n.modified AS created,
  // n.created AS modified` transposed. All three survive every other test in
  // this describe, which reads need_id, foodbank_name/slug and the two
  // integer flags and nothing else. The transposition is the nastiest: the
  // needs queue is ORDERED by created, so the column an admin scans for
  // staleness would show the modification time instead, ordered by something
  // else entirely, and every value would still look like a plausible date.
  // The seed gives created and modified different values for that reason.
  it("returns exactly the eleven projected columns, with each value on its own field", async () => {
    seedFoodbank({ id: 2, name: "Salisbury", slug: "salisbury" });
    seedNeed({
      id: 77,
      need_id: "3f9c1a44",
      foodbank_id: 2,
      change_text: "Tinned tomatoes\nRice",
      excess_change_text: "Baked beans",
      published: 1,
      is_categorised: 1,
      input_method: "typed",
      created: "2026-09-05 08:00:00.000000",
      modified: "2026-09-05 19:28:08.853000",
    });

    expect({ ...(await getNeedsPage(session, 1, 100)).rows[0]! }).toEqual({
      id: 77,
      need_id: "3f9c1a44",
      foodbank_name: "Salisbury",
      foodbank_slug: "salisbury",
      change_text: "Tinned tomatoes\nRice",
      excess_change_text: "Baked beans",
      published: 1,
      is_categorised: 1,
      input_method: "typed",
      created: "2026-09-05 08:00:00.000000",
      modified: "2026-09-05 19:28:08.853000",
    });
  });

  // Four rows over pages of two: the exactly-full final page the
  // `hasNext: result.results.length === pageSize` mutant gets wrong. See
  // getLocationsPage's paging test for why this is repeated per function.
  it("pages, and reports hasNext false on a full final page", async () => {
    for (let i = 1; i <= 4; i += 1) seedNeed({ id: i, need_id: `n${i}`, foodbank_id: null, created: `2026-09-0${i} 00:00:00.000000` });

    const first = await getNeedsPage(session, 1, 2);
    expect(first.rows.map((r) => r.need_id)).toEqual(["n4", "n3"]);
    expect({ total: first.total, hasNext: first.hasNext }).toEqual({ total: 4, hasNext: true });

    const last = await getNeedsPage(session, 2, 2);
    expect(last.rows.map((r) => r.need_id)).toEqual(["n2", "n1"]);
    expect({ total: last.total, hasNext: last.hasNext }).toEqual({ total: 4, hasNext: false });
  });
});
