import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../types";
import { hmacSha256Hex } from "../../lib/hmac";
import { requireAdminAuth } from "../../middleware/adminAuth";
import { serverTiming } from "../../middleware/serverTiming";

// The food bank detail page, its six lazy tabs and the Touch button, driven
// end to end: the real Hono routes at the paths routes/admin/index.ts:132-134
// registers, the real requireAdminAuth, the real issueCsrfToken/verifyCsrf,
// the real packages/db reads and the real touchFoodbank, all against an
// in-memory SQLite carrying the migrations' own tables and views.
//
// THE TWO FAILURE CLASSES THIS ADMIN HAS ACTUALLY SHIPPED, applied to a page
// that is mostly read-only:
//
//   * github #34's class -- "the redirect said it saved". adminFoodbankTouch
//     answers a plain POST with a 302 and an htmx POST with a fixed string of
//     markup; neither carries one byte of evidence that a row changed. So
//     every touch test below READS THE ROW BACK, and every refusal test
//     asserts the whole row is unchanged column for column. A test that
//     stopped at `expect(res.status).toBe(302)` would pass against a handler
//     that never called touchFoodbank at all -- which is exactly the shape of
//     the bug that shipped in the location form.
//
//   * the counting equivalent of #12's class -- "the page quietly showed the
//     wrong thing". Nothing on this page throws when a `WHERE foodbank_id = ?`
//     is dropped, a LIMIT is applied to the wrong sort key, or a tab lists
//     another food bank's rows: it renders a full, plausible page of the wrong
//     data. So every count, every tab and every list here is seeded with rows
//     that MUST BE EXCLUDED -- a second food bank holding one row in each of
//     the ten child tables -- because a filter that does nothing passes any
//     test that only seeds matching rows.
//
//   * #34's class ON THE READ SIDE, found by mutation-testing this file after
//     it was first written: a COLUMN DROPPED FROM A PROJECTION. Six of the
//     fifteen queries behind this page name their columns explicitly, and
//     deleting `cost` from the orders tab's SELECT, `url` from the articles
//     tab's, `url` or `need_id` from the crawls tab's, or `photo_id` from the
//     photo row all left the whole suite green -- because the tests asserted
//     row COUNTS, row ORDER and the two or three DERIVED fields, and never
//     the row itself. Every one of those renders a complete table with one
//     empty cell or one link pointing at /admin/order/undefined/. So each tab
//     now asserts a WHOLE ROW against the cells its fragment actually prints,
//     and the templates -- not the interfaces -- are the list of what counts.
//
// MUTANTS THIS FILE HAS BEEN RUN AGAINST: 125, in a hardlinked copy of the
// repo outside it, covering the handler, the packages/db queries it composes,
// lib/csrf.ts, routes/admin/pageContext.ts and middleware/adminAuth.ts --
// deleted CSRF and auth checks, deleted 404 guards, a dropped `WHERE
// foodbank_id = ?` on every query that carries one, swapped same-typed binds,
// changed redirect targets and status codes, wrong LIMITs, a GET falling
// through into a write, and a dropped column from every projection. 120 of
// the 125 fail this file; the five that do not are listed below. Tests that a
// mutant walked past were strengthened or added, and where a test's comment
// names a specific mutant, that mutant was run and that is why the test
// exists.
//
// FIVE SURVIVORS LEFT ALIVE ON PURPOSE, none of them holes -- each was run,
// and each is either unobservable or another module's contract:
//   - deleting getFoodbankAdminTotals' `COALESCE(SUM(x), 0)` is invisible
//     because that function's own `row?.total_weight ?? 0` already turns
//     SQLite's NULL-over-no-rows into 0. A test written to "catch" it would
//     be pinning which of two redundant guards does the work.
//   - deleting `AND place_id IS NOT NULL` from the photo count's UNION is
//     invisible because a NULL in the list cannot match: `SELECT ('X' IN
//     (SELECT NULL))` is NULL under node:sqlite, which WHERE treats as false
//     (checked, not reasoned -- and `'X' IN (SELECT NULL UNION ALL SELECT
//     'X')` is still 1, so a real place_id alongside it still matches).
//   - deleting `place_name` from the photos query's ORDER BY is invisible
//     while the (foodbank_id, name) unique indexes exist; see the photos
//     ordering test, which measures exactly that and says so.
//   - dropping `admin_user` from adminPageContext breaks the admin nav's
//     "signed in as", not this page: pageContext.test.ts owns that claim and
//     already pins it.
//   - blanking a donation point row's `uuid` changes nothing here --
//     donationpoints.njk builds both its Edit link and its delete form's
//     action from `slug`, and this page never reads the uuid.
//
// WHAT IS FAKED, AND WHY ONLY THIS. `render` is stubbed because the templates
// are precompiled into packages/templates/src/generated/, a gitignored build
// artefact -- importing the real one makes this suite fail on a fresh checkout
// for reasons that have nothing to do with food banks. Asserting on the
// CONTEXT handed to the template is also the more direct claim: "the Photos
// tab is offered" is a statement about `counts.photos`, not about markup.
// `buildPageContext` comes through the same module and is stubbed with it;
// nothing here is about the footer's version string. Everything else --
// middleware, router, session, CSRF, SQL -- is the shipped code.

const mocks = vi.hoisted(() => ({
  render: vi.fn(async (_template: string, _context: Record<string, unknown>) => "<html>foodbank</html>"),
}));

vi.mock("@givefood/templates", () => ({
  render: mocks.render,
  // adminPageContext spreads this in; the real one reads per-isolate runtime
  // identity that has nothing to do with this page.
  buildPageContext: (opts: { path: string }) => ({ canonical_path: opts.path }),
}));

const { adminFoodbankDetail, adminFoodbankTab, adminFoodbankTouch } = await import("./foodbankDetail");

// migrations/0001_core.sql:10-46 verbatim for `foodbank` -- the whole table,
// not a reduction, because getFoodbankBySlug is a `SELECT *` and the template
// reads about forty of these columns off the row it hands back. A trimmed
// fixture would make "the page was given the food bank" agree with whatever it
// happened to include.
//
// Every other table is 0001/0003/0004/0005/0008/0018/0020 as amended by
// 0019_drop_foodbank_cache.sql, which dropped the cached `foodbank_name` /
// `foodbank_slug` / `foodbank_network` columns from the child tables and
// replaced them with the three `_full` VIEWS below. The views are not
// optional scenery: getFoodbankBySlug's latest-need lookup, the locations
// list and the donation points tab all read THROUGH a view, and a column
// dropped from one is exactly how /dashboard/beautybanks/ became a live 500
// nobody noticed (0019's own note).
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
CREATE UNIQUE INDEX foodbank_name_uniq ON foodbank(name);
CREATE UNIQUE INDEX foodbank_slug_uniq ON foodbank(slug);

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

CREATE TABLE foodbankarticle (
  id INTEGER PRIMARY KEY,
  foodbank_id INTEGER,
  published_date TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
  featured INTEGER NOT NULL
);

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

CREATE TABLE webpushsubscription (
  id INTEGER PRIMARY KEY,
  created TEXT NOT NULL,
  foodbank_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
  browser TEXT
);

CREATE TABLE mobilesubscriber (
  id INTEGER PRIMARY KEY,
  created TEXT NOT NULL,
  device_id TEXT NOT NULL, platform TEXT NOT NULL,
  timezone TEXT, locale TEXT, app_version TEXT, os_version TEXT,
  device_model TEXT, sub_type TEXT,
  foodbank_id INTEGER NOT NULL, donationpoint_id INTEGER
);

CREATE TABLE whatsappsubscriber (
  id INTEGER PRIMARY KEY,
  phone_number TEXT NOT NULL,
  foodbank_id INTEGER,
  created TEXT,
  last_notified TEXT
);

CREATE TABLE crawlitem (
  id INTEGER PRIMARY KEY,
  crawl_set_id INTEGER,
  crawl_type TEXT NOT NULL,
  start TEXT NOT NULL,
  finish TEXT,
  foodbank_id INTEGER NOT NULL,
  url TEXT,
  need_id INTEGER
);

CREATE TABLE placephoto (
  id INTEGER PRIMARY KEY,
  place_id TEXT,
  photo_ref TEXT,
  html_attributions TEXT,
  r2_key TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  md5 TEXT NOT NULL,
  created TEXT,
  modified TEXT
);
CREATE UNIQUE INDEX placephoto_place_id_uniq ON placephoto(place_id);

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

CREATE VIEW foodbankchange_full AS
  SELECT c.*, f.name AS foodbank_name, f.slug AS foodbank_slug
    FROM foodbankchange c
    LEFT JOIN foodbank f ON f.id = c.foodbank_id;
`;

type Bindable = null | number | bigint | string | Uint8Array;

// Statements the handlers actually ran, so "a GET wrote nothing" is asserted
// at the statement level as well as by re-reading the row -- a write that
// happened and was then overwritten by a later seed would otherwise be
// invisible.
const writes: { sql: string; params: Bindable[] }[] = [];

// The D1DatabaseSession surface packages/db uses, over node:sqlite -- the same
// shape as donationPoint.test.ts / foodbankLocation.test.ts /
// discrepancies.test.ts use. D1 is async and node:sqlite is synchronous; the
// SQL text, the parameter binding, the LIMIT handling and the NULL semantics
// are SQLite's in both.
function d1Session(db: DatabaseSync) {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      writes.push({ sql, params });
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return {
    prepare: (sql: string) => statement(sql, []),
    // getFoodbankBySlug sends its food bank row and its latest-need row as ONE
    // batch() rather than two sequential awaits (packages/db/src/foodbank.ts).
    // The same adapter as packages/db/src/foodbankDetail.test.ts: statements
    // run in order and there is one result per input statement, in that order,
    // because the caller indexes straight into the array -- a batch that
    // reordered or coalesced results would hand back the wrong row without
    // erroring anywhere.
    batch: async (statements: Array<{ all: () => Promise<unknown> }>) => {
      const out: unknown[] = [];
      for (const each of statements) out.push(await each.all());
      return out;
    },
    getBookmark: () => null,
  };
}

const ORIGIN = "https://www.givefood.org.uk";
const CSRF_SECRET = "test-csrf-secret-not-a-real-one";
const CSRF_RAW = "c".repeat(64);
const SESSION_ID = "test-session-id";

const SALISBURY = 1;
const AMESBURY = 2; // the decoy: one row in every child table, none of which may appear

const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let env: AppEnv["Bindings"];
let app: Hono<AppEnv>;

// A generic INSERT built from the object's own keys, so each seed names only
// the columns its test cares about and the NOT NULL filler lives in one place
// per table. Bound, not interpolated -- an apostrophe in a food bank name is
// not a syntax error waiting to happen.
function insert(table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(
    ...columns.map((c) => (row[c] === undefined ? null : (row[c] as Bindable))),
  );
}

// Every NOT NULL column the table declares, so an override only has to name
// what the test is about. Values are deliberately distinctive: "the page was
// given the food bank's notes" must not pass because two columns happen to
// hold the same string.
function seedFoodbank(id: number, name: string, slug: string, overrides: Record<string, unknown> = {}): void {
  insert("foodbank", {
    id,
    uuid: `${slug.replace(/-/g, "")}0000000000000000000000000000`.slice(0, 32),
    name,
    slug,
    address: `Unit 3\r\n${name} Industrial Estate`,
    postcode: "SP2 9DY",
    country: "England",
    lat_lng: "51.0812,-1.8231",
    charity_just_foodbank: 0,
    contact_email: `info@${slug}.example.org`,
    url: `https://${slug}.example.org/`,
    shopping_list_url: `https://${slug}.example.org/list/`,
    address_is_administrative: 0,
    is_closed: 0,
    no_locations: 0,
    days_between_needs: 7,
    created: "2019-04-01 09:00:00.000000",
    modified: "2026-09-01 09:00:00.000000",
    ...overrides,
  });
}

function seedLocation(id: number, foodbankId: number, name: string, overrides: Record<string, unknown> = {}): void {
  insert("foodbanklocation", {
    id,
    uuid: `loc${id}`.padEnd(32, "0"),
    foodbank_id: foodbankId,
    name,
    slug: name.toLowerCase().replace(/[^\w]+/g, "-"),
    country: "England",
    lat_lng: "51.0700,-1.8000",
    is_closed: 0,
    modified: "2026-09-01 09:00:00.000000",
    ...overrides,
  });
}

function seedDonationPoint(id: number, foodbankId: number, name: string, overrides: Record<string, unknown> = {}): void {
  insert("foodbankdonationpoint", {
    id,
    uuid: `dp${id}`.padEnd(32, "0"),
    foodbank_id: foodbankId,
    name,
    slug: name.toLowerCase().replace(/[^\w]+/g, "-"),
    address: "17 Acre Lane",
    postcode: "SP1 1AA",
    lat_lng: "51.0650,-1.7900",
    is_closed: 0,
    in_store_only: 0,
    modified: "2026-09-01 09:00:00.000000",
    ...overrides,
  });
}

function seedNeed(id: number, foodbankId: number, overrides: Record<string, unknown> = {}): void {
  insert("foodbankchange", {
    id,
    need_id: `${id}`.padStart(32, "a"),
    foodbank_id: foodbankId,
    change_text: "Pasta, Tinned tomatoes",
    published: 1,
    input_method: "scrape",
    created: "2026-09-01 09:00:00.000000",
    modified: "2026-09-01 09:00:00.000000",
    ...overrides,
  });
}

function seedOrder(id: number, foodbankId: number, overrides: Record<string, unknown> = {}): void {
  insert("orders", {
    id,
    order_id: `ORD-${id}`,
    items_text: "Pasta x 10",
    country: "England",
    created: "2026-08-01 09:00:00.000000",
    modified: "2026-08-01 09:00:00.000000",
    delivery_date: "2026-08-10",
    delivery_hour: 9,
    delivery_datetime: "2026-08-10 09:00:00.000000",
    weight: 1000,
    calories: 5000,
    cost: 1000,
    no_lines: 1,
    no_items: 10,
    foodbank_id: foodbankId,
    ...overrides,
  });
}

function seedArticle(id: number, foodbankId: number, overrides: Record<string, unknown> = {}): void {
  insert("foodbankarticle", {
    id,
    foodbank_id: foodbankId,
    published_date: "2026-09-01 09:00:00.000000",
    title: "we need pasta",
    url: `https://example.org/article/${id}/`,
    featured: 0,
    ...overrides,
  });
}

function seedEmailSubscriber(id: number, foodbankId: number, overrides: Record<string, unknown> = {}): void {
  insert("foodbanksubscriber", {
    id,
    created: "2026-09-01 09:00:00.000000",
    foodbank_id: foodbankId,
    email: `subscriber${id}@example.org`,
    confirmed: 1,
    sub_key: `sub${id}`,
    unsub_key: `unsub${id}`,
    ...overrides,
  });
}

function seedWebpush(id: number, foodbankId: number, overrides: Record<string, unknown> = {}): void {
  insert("webpushsubscription", {
    id,
    created: "2026-09-01 09:00:00.000000",
    foodbank_id: foodbankId,
    endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
    p256dh: "p256dh",
    auth: "auth",
    browser: "Chrome",
    ...overrides,
  });
}

function seedMobile(id: number, foodbankId: number, overrides: Record<string, unknown> = {}): void {
  insert("mobilesubscriber", {
    id,
    created: "2026-09-01 09:00:00.000000",
    device_id: `device-${id}`,
    platform: "iOS",
    foodbank_id: foodbankId,
    ...overrides,
  });
}

function seedCrawlItem(id: number, foodbankId: number, overrides: Record<string, unknown> = {}): void {
  insert("crawlitem", {
    id,
    crawl_type: "need",
    start: "2026-09-01 09:00:00.000000",
    finish: "2026-09-01 09:00:04.000000",
    foodbank_id: foodbankId,
    url: "https://example.org/give-help/food/",
    ...overrides,
  });
}

function seedPhoto(id: number, placeId: string): void {
  insert("placephoto", {
    id,
    place_id: placeId,
    photo_ref: `ref-${id}`,
    html_attributions: "",
    r2_key: `media/photo/${id}.jpg`,
    bytes: 1234,
    md5: "d41d8cd98f00b204e9800998ecf8427e",
  });
}

// One row in every child table, all of it belonging to the OTHER food bank.
// Nothing this seeds may ever appear in a count, a list or a tab for
// Salisbury: each of the fifteen queries behind this page carries its own
// `WHERE foodbank_id = ?`, and a filter that does nothing passes every test
// that only seeds matching rows.
function seedDecoyFoodbankRows(): void {
  seedLocation(900, AMESBURY, "Amesbury Hall");
  seedDonationPoint(900, AMESBURY, "Amesbury Co-op");
  seedNeed(900, AMESBURY, { change_text: "AMESBURY NEED" });
  seedOrder(900, AMESBURY, { weight: 999_999, cost: 999_999, no_items: 999 });
  seedArticle(900, AMESBURY, { title: "amesbury article" });
  seedEmailSubscriber(900, AMESBURY);
  seedWebpush(900, AMESBURY);
  seedMobile(900, AMESBURY);
  seedCrawlItem(900, AMESBURY, { url: "https://amesbury.example.org/" });
  insert("whatsappsubscriber", { id: 900, phone_number: "+447700900900", foodbank_id: AMESBURY, created: "2026-09-01 09:00:00.000000" });
}

function lastRender(): { template: string; context: Record<string, unknown> } {
  const call = mocks.render.mock.calls.at(-1);
  if (!call) throw new Error("the handler rendered nothing");
  return { template: call[0], context: call[1] };
}

function renderContext<T = Record<string, unknown>>(key: string): T {
  return lastRender().context[key] as T;
}

// The whole stored row, for the before/after comparisons every touch test
// makes. `SELECT *` deliberately: "only edited and modified changed" is a
// claim about all 78 columns, not about the two the assertion names.
function storedFoodbank(id: number = SALISBURY): Record<string, unknown> {
  return db.prepare("SELECT * FROM foodbank WHERE id = ?").get(id) as Record<string, unknown>;
}

async function csrfCookie(raw: string = CSRF_RAW): Promise<string> {
  return `__Host-csrf=${raw}.${await hmacSha256Hex(CSRF_SECRET, raw)}`;
}

interface RequestOptions {
  cookies?: string[]; // replaces the default session + csrf pair entirely
  headers?: Record<string, string>;
  form?: Record<string, string>;
  method?: "GET" | "POST";
}

// One helper for all three routes. The default cookie jar carries a valid
// admin session AND a valid CSRF cookie, so a test that wants to prove a
// refusal has to take one away explicitly -- the opposite arrangement (opt in
// to auth) makes it far too easy to write a passing test against a handler
// that is not actually reachable.
async function request(path: string, opts: RequestOptions = {}): Promise<Response> {
  const method = opts.method ?? (opts.form ? "POST" : "GET");
  const cookies = opts.cookies ?? [`__Host-gfsession=${SESSION_ID}`, await csrfCookie()];
  const headers: Record<string, string> = {
    Cookie: cookies.join("; "),
    Origin: ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    ...opts.headers,
  };
  let body: string | undefined;
  if (opts.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(opts.form).toString();
  }
  return app.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body }), env, execCtx);
}

// Date only, so the awaits in these tests still resolve on a real event loop.
// Used by the timesince assertions and by the touch tests, where the exact
// string pyNow() writes is the assertion.
const NOW_INSTANT = "2026-09-07T12:00:00.000Z";
const NOW_PY = "2026-09-07 12:00:00.000000"; // pyDatetime(NOW_INSTANT)

function freezeClock(instant: string = NOW_INSTANT): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(instant));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.render.mockResolvedValue("<html>foodbank</html>");
  writes.length = 0;

  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  seedFoodbank(SALISBURY, "Salisbury", "salisbury", {
    notes: "Private scratch notes, expensive to retype",
    network: "Trussell",
    place_id: "ChIJVXealLU_xkcRja_At0z9AGY",
  });
  seedFoodbank(AMESBURY, "Amesbury", "amesbury");

  // A real admin session in a Map-backed KV, so requireAdminAuth's own
  // getAdminSession lookup succeeds for the reason it does in production
  // rather than because the middleware was replaced. expiresAt is a full TTL
  // away, which keeps getAdminSession off its sliding-refresh write path.
  const sessions = new Map([
    [
      `admin-session:${SESSION_ID}`,
      JSON.stringify({
        email: "someone@givefood.org.uk",
        name: "Some One",
        givenName: "Some",
        picture: "",
        expiresAt: Date.now() + 12 * 60 * 60 * 1000,
      }),
    ],
  ]);

  env = {
    DB: { withSession: () => d1Session(db) },
    SESSIONS: {
      get: async (key: string) => sessions.get(key) ?? null,
      put: async (key: string, value: string) => void sessions.set(key, value),
      delete: async (key: string) => void sessions.delete(key),
    },
    CSRF_SECRET,
    GMAP_STATIC_KEY: "static-key",
    GMAP_GEOCODE_KEY: "geocode-key",
    D1_DATABASE_NAME: "givefood-test",
  } as unknown as AppEnv["Bindings"];

  // The production registration, verbatim from routes/admin/index.ts:132-134,
  // behind the same auth middleware adminApp applies -- so "a GET on the touch
  // URL is not routed" and "an unauthenticated request never reaches the
  // handler" are claims about the real wiring, not about this file's.
  app = new Hono<AppEnv>();
  app.use("*", serverTiming);
  app.use("/admin/*", requireAdminAuth);
  app.get("/admin/foodbank/:slug/", adminFoodbankDetail);
  app.get("/admin/foodbank/:slug/tab/:tab/", adminFoodbankTab);
  app.post("/admin/foodbank/:slug/touch/", adminFoodbankTouch);
  // The 500 page github #12 was actually about. Labelled rather than left to
  // surface as an unhandled rejection, so a regression reads as "expected 200,
  // got 500: no such column" instead of a vitest crash.
  app.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe("adminFoodbankDetail", () => {
  it("renders the detail template for a food bank that exists", async () => {
    const res = await request("/admin/foodbank/salisbury/");

    expect(res.status).toBe(200);
    expect(lastRender().template).toBe("admin/foodbank_detail.njk");
    // adminPageContext's `section`, which drives admin/page.njk's nav
    // highlight.
    expect(lastRender().context.section).toBe("foodbanks");
  });

  it("404s a slug no food bank has, and renders nothing", async () => {
    const res = await request("/admin/foodbank/andover/");

    expect(res.status).toBe(404);
    expect(mocks.render).not.toHaveBeenCalled();
  });

  // getFoodbankBySlug is a `SELECT *` and foodbank_detail.njk reads about
  // forty columns off the row -- the URLs block, the contacts block, the
  // politics block, the main-address row. A projection narrowed to "the
  // columns the page seemed to need" would blank whichever ones it missed,
  // silently, on every food bank.
  it("hands the template the stored row itself, not a projection of it", async () => {
    await request("/admin/foodbank/salisbury/");

    expect(renderContext("foodbank")).toMatchObject({
      id: SALISBURY,
      name: "Salisbury",
      slug: "salisbury",
      address: "Unit 3\r\nSalisbury Industrial Estate",
      postcode: "SP2 9DY",
      country: "England",
      lat_lng: "51.0812,-1.8231",
      notes: "Private scratch notes, expensive to retype",
      network: "Trussell",
      place_id: "ChIJVXealLU_xkcRja_At0z9AGY",
      contact_email: "info@salisbury.example.org",
      url: "https://salisbury.example.org/",
      shopping_list_url: "https://salisbury.example.org/list/",
      created: "2019-04-01 09:00:00.000000",
    });
  });

  // givefood/models/foodbank.py:326-330 full_name(), which the Delete button's
  // label uses. Not the raw name: "Delete Salisbury" reads as a location.
  it("passes full_name for the delete button's label", async () => {
    await request("/admin/foodbank/salisbury/");

    expect(lastRender().context.full_name).toBe("Salisbury Foodbank");
  });

  // A page load must never write. This one has three forms on it, all POSTing
  // elsewhere, so a stray UPDATE here would be invisible until an admin
  // noticed `edited` moving every time they opened the page -- which is
  // exactly what the foodbanks list sorts on (foodbank_closed_edited_idx).
  it("writes nothing", async () => {
    const before = storedFoodbank();

    await request("/admin/foodbank/salisbury/");

    expect(writes).toEqual([]);
    expect(storedFoodbank()).toEqual(before);
  });

  // The gate on every /admin/* route. Asserted through the real middleware
  // rather than a stand-in: the claim is that an anonymous request never
  // reaches this handler, which is a claim about routes/admin/index.ts:85's
  // wiring.
  it("never reaches the handler without an admin session", async () => {
    const res = await request("/admin/foodbank/salisbury/", { cookies: [await csrfCookie()] });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/?next=%2Fadmin%2Ffoodbank%2Fsalisbury%2F");
    expect(mocks.render).not.toHaveBeenCalled();
  });
});

describe("adminFoodbankDetail -- the counts every tab strip label is drawn from", () => {
  // gfadmin/views.py:597-608's `counts` dict, every entry of it, with a
  // decoy row of each kind sitting in the same tables. Asserted as one object
  // rather than key by key so that a count that starts returning `undefined`
  // -- which the template renders as an empty tag rather than an error --
  // fails here.
  it("counts this food bank's rows and none of the neighbouring food bank's", async () => {
    seedDecoyFoodbankRows();
    seedLocation(10, SALISBURY, "Bemerton Heath");
    seedLocation(11, SALISBURY, "Wilton");
    seedDonationPoint(10, SALISBURY, "Waitrose");
    seedNeed(10, SALISBURY);
    seedNeed(11, SALISBURY);
    seedNeed(12, SALISBURY);
    seedOrder(10, SALISBURY);
    seedArticle(10, SALISBURY);
    seedArticle(11, SALISBURY);
    seedEmailSubscriber(10, SALISBURY);
    seedWebpush(10, SALISBURY);
    seedWebpush(11, SALISBURY);
    seedMobile(10, SALISBURY);
    seedCrawlItem(10, SALISBURY);

    await request("/admin/foodbank/salisbury/");

    expect(renderContext("counts")).toEqual({
      locations: 2,
      needs: 3,
      orders: 1,
      donation_points: 1,
      articles: 2,
      subscribers: 4, // 1 email + 2 web push + 1 mobile
      crawls: 1,
      photos: 0,
    });
  });

  it("shows zeroes, not undefined, for a food bank with no children at all", async () => {
    seedDecoyFoodbankRows();

    await request("/admin/foodbank/salisbury/");

    expect(renderContext("counts")).toEqual({
      locations: 0,
      needs: 0,
      orders: 0,
      donation_points: 0,
      articles: 0,
      subscribers: 0,
      crawls: 0,
      photos: 0,
    });
  });

  // `counts.locations` is len(locations) -- the rows actually fetched --
  // NOT the food bank's own denormalised `no_locations` column, which is a
  // cached count maintained by the ETL and can be stale. Seeded deliberately
  // inconsistent so a handler that reached for the cheaper column fails.
  it("takes the locations count from the rows it fetched, not from the cached no_locations column", async () => {
    seedFoodbank(3, "Andover", "andover", { no_locations: 99 });
    seedLocation(20, 3, "Andover Central");

    await request("/admin/foodbank/andover/");

    expect(renderContext<{ locations: number }>("counts").locations).toBe(1);
  });

  // KNOWN DIVERGENCE, PINNED AS-IS. Django's counts["subscribers"]
  // (gfadmin/views.py:604) adds FOUR numbers -- email, web push, mobile AND
  // whatsapp. getFoodbankAdminTotals never queries whatsappsubscriber, and its
  // comment explains why: "no whatsappsubscriber D1 table exists yet". One
  // does now -- migration 0020_whatsappsubscriber.sql created it on 2026-09-05
  // and loaded Postgres's 49 rows into it -- so the omission is no longer
  // "there is nothing to count". The tab strip under-reports by exactly the
  // number of WhatsApp subscribers, and the Subscribers tab it opens onto
  // reports the same 0 (packages/db/src/foodbankTabs.test.ts pins that half).
  // Seeded rows prove the absence is a missing query and not an empty table.
  it("omits WhatsApp subscribers from the tab-strip count even though the table now holds rows", async () => {
    seedEmailSubscriber(10, SALISBURY);
    insert("whatsappsubscriber", { id: 10, phone_number: "+447700900001", foodbank_id: SALISBURY, created: "2026-09-01 09:00:00.000000" });
    insert("whatsappsubscriber", { id: 11, phone_number: "+447700900002", foodbank_id: SALISBURY, created: "2026-09-01 09:00:00.000000" });

    await request("/admin/foodbank/salisbury/");

    expect(renderContext<{ subscribers: number }>("counts").subscribers).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM whatsappsubscriber WHERE foodbank_id = ?").get(SALISBURY) as { n: number }).n).toBe(2);
  });

  // FAITHFUL INCONSISTENCY, pinned so it is not "tidied" in one place only.
  // The Stats block's "Subscribers" is totals["email_subscribers"], a bare
  // COUNT(*) over foodbanksubscriber; the Subscribers TAB's Email count is
  // confirmed-only (gfadmin/views.py:672-676 increments its counter inside
  // `if sub.confirmed`). Django has exactly this pair of numbers on the same
  // page and so does the port, which is why the unconfirmed row below is
  // counted in one place and not the other.
  it("counts unconfirmed email subscribers in the Stats block, the way Django's does", async () => {
    seedEmailSubscriber(10, SALISBURY, { confirmed: 1 });
    seedEmailSubscriber(11, SALISBURY, { confirmed: 0 });

    await request("/admin/foodbank/salisbury/");
    expect(lastRender().context.number_subscribers).toBe(2);

    await request("/admin/foodbank/salisbury/tab/subscribers/");
    expect(renderContext<{ subscription_counts: { email: number } }>("subscribers").subscription_counts.email).toBe(1);
  });

  // foodbank_detail.njk:61 hides the "New Order" shortcut when this is
  // non-zero, and :133 prints it as the Orders stat. Same number as
  // counts.orders (Django's `no_orders: counts["orders"]`), passed separately
  // because the template reads both names.
  it("passes no_orders as the same number the Orders tab label carries", async () => {
    seedOrder(10, SALISBURY);
    seedOrder(11, SALISBURY);

    await request("/admin/foodbank/salisbury/");

    expect(lastRender().context.no_orders).toBe(2);
    expect(renderContext<{ orders: number }>("counts").orders).toBe(2);
  });
});

describe("adminFoodbankDetail -- the order totals in the Stats block", () => {
  // gfadmin/views.py:630-635. Grams to kilograms, pence to pounds, and the
  // item count straight through -- summed only over THIS food bank's orders,
  // which is what the decoy order's 999,999g is here to prove.
  it("converts the SUMs to the units the template prints", async () => {
    seedDecoyFoodbankRows();
    seedOrder(10, SALISBURY, { weight: 20_000_000, cost: 45_000, no_items: 1_200 });
    seedOrder(11, SALISBURY, { weight: 3_415_600, cost: 5_000, no_items: 300 });

    await request("/admin/foodbank/salisbury/");

    expect(lastRender().context.total_weight_kg).toBe(23415.6);
    expect(lastRender().context.total_cost).toBe(500);
    expect(lastRender().context.total_items).toBe(1500);
  });

  // THE RAW PRODUCT, TAIL AND ALL -- the handler's own comment says the port
  // previously rounded this to 2dp and that the divergence was visible on the
  // page. Django prints `total_weight_kg * PACKAGING_WEIGHT_PC` through
  // |intcomma with no floatformat, and Python and JS share IEEE754 doubles
  // and shortest-round-trip repr, so 23415.6 * 1.18 is byte-for-byte
  // 27630.407999999996 in both. A reinstated Math.round(x * 100) / 100 fails
  // here rather than being noticed by a maintainer reading the page.
  it("multiplies by the packaging factor without rounding", async () => {
    seedOrder(10, SALISBURY, { weight: 23_415_600 });

    await request("/admin/foodbank/salisbury/");

    expect(lastRender().context.total_weight_kg_pkg).toBe(27630.407999999996);
  });

  // SQLite's SUM() over no rows is NULL, and Django's Sum() defaults to 0 --
  // getFoodbankAdminTotals coalesces for exactly that reason. Without it the
  // template prints "null kg" and, worse, total_weight_kg_pkg becomes NaN.
  it("shows 0, not null, for a food bank that has never had an order", async () => {
    await request("/admin/foodbank/salisbury/");

    expect(lastRender().context.total_weight_kg).toBe(0);
    expect(lastRender().context.total_weight_kg_pkg).toBe(0);
    expect(lastRender().context.total_items).toBe(0);
    expect(lastRender().context.total_cost).toBe(0);
  });
});

describe("adminFoodbankDetail -- the locations column", () => {
  // `Foodbank.locations()` is `.order_by("name")` at the Postgres end, under
  // the en_US.utf8 collation. sortByName reproduces that with an
  // Intl.Collator because D1's own byte-wise ORDER BY would put every
  // uppercase name before every lowercase one -- this seed is chosen so the
  // two orders genuinely differ: byte-wise gives Bemerton, Wilton, amesbury;
  // linguistic gives amesbury, Bemerton, Wilton.
  it("sorts locations the way the source collation does, not the way SQLite would", async () => {
    seedLocation(10, SALISBURY, "Wilton");
    seedLocation(11, SALISBURY, "amesbury road");
    seedLocation(12, SALISBURY, "Bemerton Heath");

    await request("/admin/foodbank/salisbury/");

    expect(renderContext<{ name: string }[]>("locations").map((l) => l.name)).toEqual(["amesbury road", "Bemerton Heath", "Wilton"]);
  });

  it("lists no other food bank's locations", async () => {
    seedDecoyFoodbankRows();
    seedLocation(10, SALISBURY, "Bemerton Heath");

    await request("/admin/foodbank/salisbury/");

    expect(renderContext<{ name: string }[]>("locations").map((l) => l.name)).toEqual(["Bemerton Heath"]);
  });

  // Deliberately NOT filtered on is_closed: a food bank's location list
  // includes closed locations, and the admin is the one place that has to see
  // them (PLAN.md §7.2, and getLocationsByFoodbankId's own comment).
  it("includes closed locations", async () => {
    seedLocation(10, SALISBURY, "Closed Hall", { is_closed: 1 });

    await request("/admin/foodbank/salisbury/");

    expect(renderContext<{ name: string }[]>("locations")).toHaveLength(1);
  });

  // The row comes through foodbanklocation_full, whose join is what supplies
  // foodbank_name/foodbank_slug since 0019 dropped the cached columns. The
  // template does not print them here, but the read is shared with the public
  // location pages -- a base-table read that "worked" for this page would
  // break those.
  it("reads locations through the view, and coerces its 0/1 columns to booleans", async () => {
    seedLocation(10, SALISBURY, "Bemerton Heath", { is_donation_point: 1, is_closed: 0, place_has_photo: null });

    await request("/admin/foodbank/salisbury/");

    expect(renderContext<Record<string, unknown>[]>("locations")[0]).toMatchObject({
      foodbank_name: "Salisbury",
      foodbank_slug: "salisbury",
      is_donation_point: true,
      is_closed: false,
      place_has_photo: null, // tri-state: NULL is not false
    });
  });
});

describe("adminFoodbankDetail -- the latest need panel", () => {
  it("shapes the latest need the way the panel prints it", async () => {
    freezeClock();
    seedNeed(10, SALISBURY, {
      need_id: "ab12cd34ef56789012345678901234ab",
      input_method: "typed",
      created: "2026-09-05 12:00:00.000000",
      change_text: "Pasta, Tinned tomatoes",
      excess_change_text: "Baked beans",
    });
    db.prepare("UPDATE foodbank SET latest_need_id = 10 WHERE id = ?").run(SALISBURY);

    await request("/admin/foodbank/salisbury/");

    const latestNeed = renderContext<{ latestNeed: Record<string, unknown> }>("foodbank").latestNeed;
    // need_id_short is Django's FoodbankChange.need_id_short -- the first 7
    // characters of the UUID, the link text on this panel.
    expect(latestNeed.need_id_short).toBe("ab12cd3");
    expect(latestNeed.input_method_emoji).toBe('<span class="mdi mdi-keyboard"></span>');
    // foodbank.html:402's `{{ ...created|timesince }} ago`. The space inside
    // "2 days" is U+00A0 -- Django's timesince applies avoid_wrapping() to
    // each unit and the port copies it -- while the one before "ago" is an
    // ordinary space, because that word is appended by the template. Written
    // out here rather than left as a literal space so the difference cannot be
    // "corrected" by accident.
    expect(latestNeed.created_timesince).toBe("2 days ago");
    expect(latestNeed.change_text).toBe("Pasta, Tinned tomatoes");
    expect(latestNeed.excess_change_text).toBe("Baked beans");
  });

  // An unrecognised input_method returns "" rather than throwing -- Django's
  // own method falls off the end and returns None, which `|safe` renders as
  // nothing. Worth pinning because the value is rendered through `| safe`:
  // whatever this returns is injected into the page unescaped.
  it("renders no emoji for an input method neither codebase knows", async () => {
    seedNeed(10, SALISBURY, { input_method: "carrier-pigeon" });
    db.prepare("UPDATE foodbank SET latest_need_id = 10 WHERE id = ?").run(SALISBURY);

    await request("/admin/foodbank/salisbury/");

    expect(renderContext<{ latestNeed: { input_method_emoji: string } }>("foodbank").latestNeed.input_method_emoji).toBe("");
  });

  // foodbank_detail.njk:277 branches on this being null to print "No needs
  // yet". The shaping block above would throw on a null need, so this is the
  // guard as much as the empty state.
  it("passes null when the food bank has no latest need", async () => {
    await request("/admin/foodbank/salisbury/");

    expect(renderContext<{ latestNeed: unknown }>("foodbank").latestNeed).toBeNull();
  });

  // latest_need_id is a plain integer with no FK behind it (PLAN.md §4.5), so
  // it can point at a need that has been deleted. getNeedById returns null and
  // the page must still render -- before D1 this was a select_related() that
  // Django resolved to None the same way.
  it("survives a latest_need_id pointing at a need that no longer exists", async () => {
    db.prepare("UPDATE foodbank SET latest_need_id = 4242 WHERE id = ?").run(SALISBURY);

    const res = await request("/admin/foodbank/salisbury/");

    expect(res.status).toBe(200);
    expect(renderContext<{ latestNeed: unknown }>("foodbank").latestNeed).toBeNull();
  });
});

describe("adminFoodbankDetail -- the external register links", () => {
  // givefood/models/foodbank.py:349-353 fsa_url().
  it("builds the FSA link from the id, and passes null without one", async () => {
    seedFoodbank(3, "Andover", "andover", { fsa_id: "FSA-991" });

    await request("/admin/foodbank/andover/");
    expect(lastRender().context.fsa_url).toBe("https://ratings.food.gov.uk/business/FSA-991");

    await request("/admin/foodbank/salisbury/");
    expect(lastRender().context.fsa_url).toBeNull();
  });

  // givefood/models/foodbank.py:325-336 charity_register_url(), branch for
  // branch. Northern Ireland is the one that does real work: the register's
  // search takes the number WITHOUT the "NIC" prefix the charity number
  // carries, so a link built from the raw value 404s.
  it("sends each country to its own register, stripping NIC for Northern Ireland", async () => {
    const cases: [string, string, string | null][] = [
      ["England", "1104521", "https://register-of-charities.charitycommission.gov.uk/charity-details/?regid=1104521&subid=0"],
      ["Wales", "1104522", "https://register-of-charities.charitycommission.gov.uk/charity-details/?regid=1104522&subid=0"],
      ["Scotland", "SC012345", "https://www.oscr.org.uk/about-charities/search-the-register/charity-details?number=SC012345"],
      ["Northern Ireland", "NIC104523", "https://www.charitycommissionni.org.uk/charity-details/?regId=104523"],
      [
        "Isle of Man",
        "1234",
        "https://www.gov.im/about-the-government/offices/attorney-generals-chambers/crown-office/charities/index-of-charities-registered-in-the-isle-of-man/",
      ],
      // Django's method has no else branch and falls off the end returning
      // None, so an unlisted country gets no link rather than a wrong one.
      ["Jersey", "1234", null],
    ];

    for (const [index, [country, charityNumber, expected]] of cases.entries()) {
      const slug = `fb-${index}`;
      seedFoodbank(100 + index, `Foodbank ${index}`, slug, { country, charity_number: charityNumber });

      await request(`/admin/foodbank/${slug}/`);

      expect(lastRender().context.charity_register_url, `${country} / ${charityNumber}`).toBe(expected);
    }
  });

  // The `if (!foodbank.charity_number) return null` guard, which is what stops
  // the England branch rendering a link to ".../?regid=&subid=0".
  it("passes null when there is no charity number, whatever the country", async () => {
    await request("/admin/foodbank/salisbury/");

    expect(lastRender().context.charity_register_url).toBeNull();
  });
});

describe("adminFoodbankTab -- the dispatch", () => {
  // gfadmin/views.py:801-814 foodbank_tab: the allowlist is the whole view,
  // and anything outside it is a 404 rather than an empty fragment. htmx would
  // swap an empty 200 into the panel and leave the admin looking at a blank
  // tab with no clue why.
  it("404s a tab name that is not in the allowlist", async () => {
    const res = await request("/admin/foodbank/salisbury/tab/discrepancies/");

    expect(res.status).toBe(404);
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it("404s a slug no food bank has, even for a valid tab name", async () => {
    const res = await request("/admin/foodbank/andover/tab/needsorders/");

    expect(res.status).toBe(404);
    expect(mocks.render).not.toHaveBeenCalled();
  });

  // ORDERING DIVERGENCE, pinned because it is invisible from outside: Django
  // raises Http404 for an unknown tab BEFORE get_object_or_404 on the slug,
  // and this port looks the food bank up first. Both answers are 404, so
  // nothing observable differs -- but the port does one D1 read Django does
  // not, and if either 404 ever becomes a distinguishable response this test
  // is where that shows up.
  it("404s a bad slug and a bad tab together", async () => {
    const res = await request("/admin/foodbank/andover/tab/discrepancies/");

    expect(res.status).toBe(404);
  });

  it("never reaches the handler without an admin session", async () => {
    const res = await request("/admin/foodbank/salisbury/tab/needsorders/", { cookies: [await csrfCookie()] });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/?next=%2Fadmin%2Ffoodbank%2Fsalisbury%2Ftab%2Fneedsorders%2F");
    expect(mocks.render).not.toHaveBeenCalled();
  });

  // Six fragments, all reached by GET, none of which may write. Asserted for
  // every tab rather than one, because they are six independent code paths
  // and only two of them (donationpoints, photos) even touch the CSRF machinery
  // that could plausibly set something.
  it("writes nothing, on any tab", async () => {
    seedNeed(10, SALISBURY);
    seedLocation(10, SALISBURY, "Bemerton Heath");
    const before = storedFoodbank();

    for (const tab of ["needsorders", "donationpoints", "articles", "subscribers", "photos", "crawls"]) {
      const res = await request(`/admin/foodbank/salisbury/tab/${tab}/`);
      expect(res.status, tab).toBe(200);
    }

    expect(writes).toEqual([]);
    expect(storedFoodbank()).toEqual(before);
  });
});

describe("adminFoodbankTab -- needsorders", () => {
  it("renders the fragment with both halves and the slug its buttons need", async () => {
    seedDecoyFoodbankRows();
    seedNeed(10, SALISBURY, { need_id: "ab12cd34ef56789012345678901234ab", input_method: "ai" });
    seedOrder(10, SALISBURY);

    const res = await request("/admin/foodbank/salisbury/tab/needsorders/");

    expect(res.status).toBe(200);
    expect(lastRender().template).toBe("admin/foodbank_tabs/needsorders.njk");
    // foodbank.html:461 and :509 head each column with a New Need / New Order
    // button carrying ?foodbank=<slug>; the fragment has no page context to
    // take that from, so the handler must pass it.
    expect(lastRender().context.foodbank_slug).toBe("salisbury");
    expect(renderContext<Record<string, unknown>[]>("needs")).toHaveLength(1);
    expect(renderContext<Record<string, unknown>[]>("orders")).toHaveLength(1);
  });

  it("lists neither another food bank's needs nor its orders", async () => {
    seedDecoyFoodbankRows();

    await request("/admin/foodbank/salisbury/tab/needsorders/");

    expect(renderContext<unknown[]>("needs")).toEqual([]);
    expect(renderContext<unknown[]>("orders")).toEqual([]);
  });

  // EVERY CELL needsorders.njk:20-29 prints, not just the two derived ones.
  // The row reaches the template as a spread of the query's own columns, so a
  // narrowed projection or a `...n` that stopped spreading loses a cell
  // silently -- and `need_id` in particular is the href of the link whose
  // TEXT is need_id_short, so dropping it leaves a perfectly rendered link
  // pointing at /admin/need/undefined/ while every assertion about
  // need_id_short still passes. Mutant that survived before this: needs rows
  // mapped with `need_id: undefined`.
  it("shapes each need the way the table's cells read it", async () => {
    seedNeed(10, SALISBURY, {
      need_id: "ab12cd34ef56789012345678901234ab",
      input_method: "scrape",
      published: 1,
      nonpertinent: null,
      change_text: "Pasta\r\nTinned tomatoes",
      excess_change_text: "Baked beans",
      created: "2026-09-01 09:00:00.000000",
      modified: "2026-09-02 10:00:00.000000",
    });

    await request("/admin/foodbank/salisbury/tab/needsorders/");

    expect(renderContext<Record<string, unknown>[]>("needs")[0]).toMatchObject({
      need_id: "ab12cd34ef56789012345678901234ab",
      need_id_short: "ab12cd3",
      input_method_emoji: '<span class="mdi mdi-spider"></span>',
      published: true,
      nonpertinent: null,
      change_text: "Pasta\r\nTinned tomatoes",
      excess_change_text: "Baked beans",
      created: "2026-09-01 09:00:00.000000",
      modified: "2026-09-02 10:00:00.000000",
    });
  });

  // THE ORDERS HALF IS AN EXPLICIT PROJECTION (getOrdersForFoodbankTab names
  // its eight columns), which is exactly where #34's class lives: drop one
  // from the SELECT list and the cell renders empty with no error anywhere.
  // Before this test, `cost` and `order_id` could both be deleted from that
  // list and all 64 tests still passed -- meaning the Cost column would print
  // "£" and every Date link would point at /admin/order/undefined/. Asserted
  // as the WHOLE row so an added column is caught too: `actual_cost` is
  // deliberately not selected here (it belongs to the order detail page's
  // natural_actual_cost(), givefood/models/orders.py:77-81), and a helpful
  // future addition of it would be a divergence, not an improvement.
  it("hands each order row exactly the columns the table prints", async () => {
    seedOrder(10, SALISBURY, {
      order_id: "ORD-2026-0001",
      created: "2026-08-01 09:00:00.000000",
      delivery_datetime: "2026-08-10 09:00:00.000000",
      delivery_provider: "Tesco",
      no_items: 42,
      cost: 12_345,
      actual_cost: 999,
      notification_email_sent: "2026-08-11 09:00:00.000000",
    });

    await request("/admin/foodbank/salisbury/tab/needsorders/");

    expect(renderContext<Record<string, unknown>[]>("orders")).toEqual([
      {
        id: 10,
        order_id: "ORD-2026-0001",
        created: "2026-08-01 09:00:00.000000",
        delivery_datetime: "2026-08-10 09:00:00.000000",
        delivery_provider: "Tesco",
        delivery_provider_slug: "tesco",
        no_items: 42,
        // Pence, not pounds: needsorders.njk:70 divides by 100 itself
        // (Order.natural_cost()). A handler that "helpfully" converted here
        // would print £1.23 for a £123.45 delivery.
        cost: 12_345,
        notification_email_sent: "2026-08-11 09:00:00.000000",
      },
    ]);
  });

  // THE TWO HALVES SORT ON DIFFERENT KEYS, and foodbankTabs.ts's comment says
  // in as many words not to copy one onto the other: needs by -created, orders
  // by -delivery_datetime. Seeded so the two orderings genuinely disagree --
  // the order created LAST is delivered FIRST -- which is the only arrangement
  // in which sorting orders by `created` fails.
  it("sorts needs by created and orders by delivery date, newest first", async () => {
    seedNeed(10, SALISBURY, { created: "2026-09-01 09:00:00.000000" });
    seedNeed(11, SALISBURY, { created: "2026-09-03 09:00:00.000000" });
    seedNeed(12, SALISBURY, { created: "2026-09-02 09:00:00.000000" });
    seedOrder(10, SALISBURY, { created: "2026-08-01 09:00:00.000000", delivery_datetime: "2026-08-20 09:00:00.000000" });
    seedOrder(11, SALISBURY, { created: "2026-08-03 09:00:00.000000", delivery_datetime: "2026-08-10 09:00:00.000000" });
    seedOrder(12, SALISBURY, { created: "2026-08-02 09:00:00.000000", delivery_datetime: "2026-08-30 09:00:00.000000" });

    await request("/admin/foodbank/salisbury/tab/needsorders/");

    expect(renderContext<{ id: number }[]>("needs").map((n) => n.id)).toEqual([11, 12, 10]);
    expect(renderContext<{ id: number }[]>("orders").map((o) => o.id)).toEqual([12, 10, 11]);
  });

  // gfadmin/views.py:644-645's `[:200]`, on both querysets. The 201st row is
  // the point: a cap applied in JavaScript after the fact, or a cap of 100
  // copied from the crawls tab, both fail here -- and the excluded row is the
  // OLDEST, which is what makes this a claim about the ORDER BY as well as the
  // LIMIT.
  it("caps each half at 200 rows, dropping the oldest", async () => {
    for (let i = 0; i < 201; i += 1) {
      const stamp = `2026-09-01 09:00:00.${String(i).padStart(6, "0")}`;
      seedNeed(1000 + i, SALISBURY, { created: stamp });
      seedOrder(1000 + i, SALISBURY, { delivery_datetime: stamp });
    }

    await request("/admin/foodbank/salisbury/tab/needsorders/");

    const needs = renderContext<{ id: number }[]>("needs");
    const orders = renderContext<{ id: number }[]>("orders");
    expect(needs).toHaveLength(200);
    expect(orders).toHaveLength(200);
    expect(needs[0]!.id).toBe(1200);
    expect(orders[0]!.id).toBe(1200);
    expect(needs.map((n) => n.id)).not.toContain(1000);
    expect(orders.map((o) => o.id)).not.toContain(1000);
  });

  // The icon filename, and the reason this handler carries its own slugify()
  // instead of importing @givefood/models'. Django's slugify STRIPS
  // punctuation, so "Sainsbury's" becomes "sainsburys" and matches the real
  // /static/img/delivery_provider/icon/sainsburys.png; the exported slugify
  // turns each punctuation run into a "-" and would produce "sainsbury-s",
  // which 404s and leaves a broken image in every order row.
  it("slugifies the delivery provider Django's way, not the URL-slug way", async () => {
    seedOrder(10, SALISBURY, { delivery_provider: "Sainsbury's", delivery_datetime: "2026-08-30 09:00:00.000000" });
    seedOrder(11, SALISBURY, { delivery_provider: "Tesco Direct", delivery_datetime: "2026-08-20 09:00:00.000000" });
    seedOrder(12, SALISBURY, { delivery_provider: null, delivery_datetime: "2026-08-10 09:00:00.000000" });

    await request("/admin/foodbank/salisbury/tab/needsorders/");

    expect(renderContext<{ delivery_provider_slug: string | null }[]>("orders").map((o) => o.delivery_provider_slug)).toEqual([
      "sainsburys",
      "tesco-direct",
      // null, not "" -- needsorders.njk:52 branches on it to decide whether to
      // render an <img> at all, and "" would render src=".../.png".
      null,
    ]);
  });
});

describe("adminFoodbankTab -- donationpoints", () => {
  it("renders this food bank's donation points, name-sorted, with a CSRF token for the delete forms", async () => {
    seedDecoyFoodbankRows();
    seedDonationPoint(10, SALISBURY, "Waitrose");
    seedDonationPoint(11, SALISBURY, "Co-op");

    const res = await request("/admin/foodbank/salisbury/tab/donationpoints/");

    expect(res.status).toBe(200);
    expect(lastRender().template).toBe("admin/foodbank_tabs/donationpoints.njk");
    expect(renderContext<{ name: string }[]>("donation_points").map((d) => d.name)).toEqual(["Co-op", "Waitrose"]);
    expect(lastRender().context.foodbank_slug).toBe("salisbury");
    // Unlike the read-only tabs, every row here carries a delete form -- with
    // no token in the fragment those POSTs are all 403s, which is a tab that
    // renders perfectly and does nothing.
    expect(lastRender().context.csrf_token).toBe(CSRF_RAW);
  });

  it("renders an empty list rather than another food bank's rows", async () => {
    seedDecoyFoodbankRows();

    await request("/admin/foodbank/salisbury/tab/donationpoints/");

    expect(renderContext<unknown[]>("donation_points")).toEqual([]);
  });

  // The mirror of "includes closed locations" above, and it was missing:
  // getDonationPointsByFoodbankId carries no `is_closed` filter either (its
  // own comment cites PLAN.md §7.2 for both), and adding one survived the
  // whole suite. A closed donation point that vanishes from this tab is one
  // the admin can no longer reopen, edit or delete -- the row still exists,
  // it is just unreachable from the only page that lists it.
  it("includes closed donation points", async () => {
    seedDonationPoint(10, SALISBURY, "Closed Co-op", { is_closed: 1 });

    await request("/admin/foodbank/salisbury/tab/donationpoints/");

    expect(renderContext<{ name: string; is_closed: boolean }[]>("donation_points")).toEqual([expect.objectContaining({ name: "Closed Co-op", is_closed: true })]);
  });

  // Every cell donationpoints.njk:22-39 prints, plus the `slug` its Edit link
  // and its delete form's action are both built from. Nothing here asserted
  // the shape of a donation point row before -- only its name and its sort
  // order -- so a row arriving without `company_slug` (the store-logo <img>
  // src), without `in_store_only` (the Y column) or without `slug` (both
  // buttons) rendered a full, plausible table that did the wrong thing on
  // click. `in_store_only` is asserted as a BOOLEAN because mapDonationPointRow
  // coerces it: the template's `{% if dp.in_store_only %}` would print Y for
  // the integer 0 if that coercion were dropped.
  it("hands each donation point row every cell the table prints and the slug both its buttons need", async () => {
    seedDonationPoint(10, SALISBURY, "Waitrose", {
      address: "17 Acre Lane\r\nSalisbury",
      postcode: "SP1 1AA",
      lat_lng: "51.0650,-1.7900",
      place_id: "ChIJwaitroseplaceid",
      company: "Waitrose",
      company_slug: "waitrose",
      store_id: "W-1234",
      in_store_only: 1,
      notes: "Basket by the tills",
    });

    await request("/admin/foodbank/salisbury/tab/donationpoints/");

    expect(renderContext<Record<string, unknown>[]>("donation_points")[0]).toMatchObject({
      name: "Waitrose",
      slug: "waitrose",
      address: "17 Acre Lane\r\nSalisbury",
      postcode: "SP1 1AA",
      lat_lng: "51.0650,-1.7900",
      place_id: "ChIJwaitroseplaceid",
      company: "Waitrose",
      company_slug: "waitrose",
      store_id: "W-1234",
      in_store_only: true,
      notes: "Basket by the tills",
    });
  });

  // ISSUANCE, not just validation. The two tabs that carry delete forms mint
  // their own token through issueCsrfToken, whose reuse path adopts the raw
  // half of an EXISTING cookie -- but only after checking that cookie's
  // signature. Drop that check and the fragment happily echoes back a token
  // an attacker planted from a sibling subdomain, which is the entire
  // difference between a signed double-submit and a plain one. The suite's
  // other CSRF tests all exercise verifyCsrf, the far end; this one survived
  // every one of them.
  it("mints a fresh token rather than echoing back an unsigned cookie's", async () => {
    const forgedRaw = "f".repeat(64);

    const res = await request("/admin/foodbank/salisbury/tab/donationpoints/", {
      cookies: [`__Host-gfsession=${SESSION_ID}`, `__Host-csrf=${forgedRaw}.deadbeef`],
    });

    expect(res.status).toBe(200);
    expect(lastRender().context.csrf_token).not.toBe(forgedRaw);
    expect(lastRender().context.csrf_token).toMatch(/^[0-9a-f]{64}$/);
    // And the freshly minted one is actually sent to the browser -- a token
    // in the page with no matching cookie is a delete button that 403s.
    expect(res.headers.get("set-cookie")).toContain(`__Host-csrf=${lastRender().context.csrf_token as string}.`);
  });
});

describe("adminFoodbankTab -- articles", () => {
  it("applies Django's own misspelled title method and the timesince the cell prints", async () => {
    freezeClock();
    seedArticle(10, SALISBURY, { title: "we need pasta this week", published_date: "2026-09-06 12:00:00.000000" });

    const res = await request("/admin/foodbank/salisbury/tab/articles/");

    expect(res.status).toBe(200);
    // `title_captialised`, sic -- FoodbankArticle's own method name
    // (articles.py:34-52), and the key articles.njk reads. Spelling it
    // correctly here renders an empty link.
    //
    // Whole row, because `url` is the href that title hangs on and it comes
    // from a four-column projection (getArticlesForFoodbankTab names its
    // columns): dropping `url` from that SELECT list left every assertion
    // here passing while the tab rendered a table of links to nowhere. Same
    // #34 shape as the orders row above.
    expect(renderContext<Record<string, unknown>[]>("articles")).toEqual([
      {
        id: 10,
        title: "we need pasta this week",
        title_captialised: "We Need Pasta This Week",
        url: "https://example.org/article/10/",
        published_date: "2026-09-06 12:00:00.000000",
        published_date_timesince: "1 day ago",
      },
    ]);
  });

  it("lists no other food bank's articles", async () => {
    seedDecoyFoodbankRows();

    await request("/admin/foodbank/salisbury/tab/articles/");

    expect(renderContext<unknown[]>("articles")).toEqual([]);
  });

  // gfadmin/views.py:659's `[:20]` -- a different cap from the needs/orders
  // 200 and the crawls 100, which is exactly why each needs its own test: one
  // shared constant applied to all three would pass any test that only checked
  // one of them.
  it("caps at 20 articles, newest published first", async () => {
    for (let i = 0; i < 21; i += 1) {
      seedArticle(1000 + i, SALISBURY, { published_date: `2026-09-01 09:00:00.${String(i).padStart(6, "0")}` });
    }

    await request("/admin/foodbank/salisbury/tab/articles/");

    const articles = renderContext<{ id: number }[]>("articles");
    expect(articles).toHaveLength(20);
    expect(articles[0]!.id).toBe(1020);
    expect(articles.map((a) => a.id)).not.toContain(1000);
  });
});

describe("adminFoodbankTab -- subscribers", () => {
  it("returns the four counts and one merged, newest-first list", async () => {
    seedDecoyFoodbankRows();
    seedEmailSubscriber(10, SALISBURY, { email: "sub@example.org", created: "2026-09-01 09:00:00.000000" });
    seedMobile(10, SALISBURY, { device_id: "device-abc", platform: "iOS", created: "2026-09-03 09:00:00.000000" });
    seedWebpush(10, SALISBURY, { endpoint: "https://fcm.googleapis.com/x", browser: "Chrome", created: "2026-09-02 09:00:00.000000" });

    const res = await request("/admin/foodbank/salisbury/tab/subscribers/");

    expect(res.status).toBe(200);
    const subscribers = renderContext<{
      subscription_counts: Record<string, number>;
      all_subscriptions: { type: string; identifier: string }[];
    }>("subscribers");
    expect(subscribers.subscription_counts).toEqual({ email: 1, whatsapp: 0, mobile: 1, webpush: 1 });
    // Whole rows, not just their types and identifiers. subscribers.njk:31
    // prints `{{ s.type_emoji | safe }}` beside every Type cell and
    // `{{ s.created|date(...) }}` as the third column; blanking type_emoji on
    // one channel's rows survived every other assertion in this file, and the
    // Type column would have silently lost its icon for that channel alone --
    // the one place a reader distinguishes the three at a glance.
    expect(subscribers.all_subscriptions).toEqual([
      { type: "mobile", type_emoji: '<span class="mdi mdi-cellphone"></span>', identifier: "iOS - device-abc", created: "2026-09-03 09:00:00.000000" },
      {
        type: "webpush",
        type_emoji: '<span class="mdi mdi-bell"></span>',
        identifier: "Chrome - https://fcm.googleapis.com/x",
        created: "2026-09-02 09:00:00.000000",
      },
      { type: "email", type_emoji: '<span class="mdi mdi-email"></span>', identifier: "sub@example.org", created: "2026-09-01 09:00:00.000000" },
    ]);
    // subscribers.njk links to /admin/foodbank/<slug>/addsub/ -- the page
    // Django leaves reachable from nowhere at all.
    expect(lastRender().context.foodbank_slug).toBe("salisbury");
  });

  // gfadmin/views.py:675's `if sub.confirmed` -- an unconfirmed email address
  // is somebody who clicked subscribe and never clicked the link, and listing
  // it as a subscriber overstates the list.
  it("leaves an unconfirmed email subscriber out of both the count and the list", async () => {
    seedEmailSubscriber(10, SALISBURY, { confirmed: 0 });

    await request("/admin/foodbank/salisbury/tab/subscribers/");

    expect(renderContext<{ subscription_counts: { email: number }; all_subscriptions: unknown[] }>("subscribers")).toMatchObject({
      subscription_counts: { email: 0 },
      all_subscriptions: [],
    });
  });
});

describe("adminFoodbankTab -- crawls", () => {
  // Whole row, for the same reason the orders and articles rows are asserted
  // whole: crawls.njk prints five cells off a six-column projection, and
  // `url` (the "URL" cell's href AND its truncated link text) and `need_id`
  // could each be deleted from getCrawlItemsForFoodbankTab's SELECT list with
  // all 64 of the original tests still green. `crawl_type` is here as well as
  // `crawl_type_icon`: the cell prints both, side by side.
  it("renders each row with its type icon, elapsed time and every other cell the table prints", async () => {
    seedCrawlItem(10, SALISBURY, {
      crawl_type: "need",
      start: "2026-09-01 09:00:00.000000",
      finish: "2026-09-01 09:00:04.500000",
      url: "https://salisbury.example.org/give-help/food/",
      need_id: 77,
    });

    const res = await request("/admin/foodbank/salisbury/tab/crawls/");

    expect(res.status).toBe(200);
    expect(renderContext<Record<string, unknown>[]>("crawl_items")).toEqual([
      {
        id: 10,
        crawl_type: "need",
        crawl_type_icon: '<span class="mdi mdi-cart"></span>',
        start: "2026-09-01 09:00:00.000000",
        finish: "2026-09-01 09:00:04.500000",
        time_taken_ms: 4500,
        url: "https://salisbury.example.org/give-help/food/",
        need_id: 77,
      },
    ]);
  });

  // givefood/const/general.py:70's CRAWL_TYPE_ICON_DEFAULT. crawl_type is free
  // TEXT with no constraint, so an unrecognised value is reachable -- and the
  // icon is rendered through `| safe`, so returning undefined would print the
  // literal word "undefined" into the cell.
  it("falls back to the default icon for an unknown crawl type", async () => {
    seedCrawlItem(10, SALISBURY, { crawl_type: "somethingnew" });

    await request("/admin/foodbank/salisbury/tab/crawls/");

    expect(renderContext<{ crawl_type_icon: string }[]>("crawl_items")[0]!.crawl_type_icon).toBe('<span class="mdi mdi-help-circle"></span>');
  });

  // A row with finish NULL is how a stalled or crashed run is detected
  // (0008_needcheck.sql's own comment); the template prints "Unfinished" and
  // no duration. Subtracting from NULL would give NaN and print "NaN ms".
  it("passes a null duration for an unfinished crawl instead of NaN", async () => {
    seedCrawlItem(10, SALISBURY, { finish: null });

    await request("/admin/foodbank/salisbury/tab/crawls/");

    expect(renderContext<{ time_taken_ms: number | null }[]>("crawl_items")[0]!.time_taken_ms).toBeNull();
  });

  it("lists no other food bank's crawl items", async () => {
    seedDecoyFoodbankRows();

    await request("/admin/foodbank/salisbury/tab/crawls/");

    expect(renderContext<unknown[]>("crawl_items")).toEqual([]);
  });

  // gfadmin/views.py:723's `[:100]`, and the crawl tables are the ones where
  // it matters: a `need` crawl set writes one row per food bank per run, so
  // this table grows faster than any other on the page.
  it("caps at 100 crawl items, most recently started first", async () => {
    for (let i = 0; i < 101; i += 1) {
      seedCrawlItem(1000 + i, SALISBURY, { start: `2026-09-01 09:00:00.${String(i).padStart(6, "0")}` });
    }

    await request("/admin/foodbank/salisbury/tab/crawls/");

    const items = renderContext<{ id: number }[]>("crawl_items");
    expect(items).toHaveLength(100);
    expect(items[0]!.id).toBe(1100);
    expect(items.map((i) => i.id)).not.toContain(1000);
  });
});

describe("adminFoodbankTab -- photos", () => {
  const FB_PLACE = "ChIJfoodbankplaceid";
  const LOC_PLACE = "ChIJlocationplaceid";
  const DP_PLACE = "ChIJdonationpointplaceid";
  const LOC_PLACE_2 = "ChIJlocationplaceid2";
  const DP_PLACE_2 = "ChIJdonationpointplaceid2";
  const AMESBURY_FB_PLACE = "ChIJamesburyfoodbankplaceid";

  // views.py:744-771's order and its three URL shapes -- the food bank itself
  // first, then locations by name, then donation points by name, each linking
  // at the public photo route its own place type is served from. A photo_url
  // built with the wrong shape gives the admin a grid of broken images and a
  // delete button whose row they cannot identify.
  it("lists the food bank, then its locations, then its donation points, each in name order and with its own photo URL", async () => {
    // TWO of each kind, seeded alphabetically LAST first and given the lower
    // placephoto id, so neither table's rowid order nor the photo join order
    // can hand back this expected list by accident. views.py:744-771 walks
    // `foodbank_locations()` and `foodbank_donation_points()`, both
    // `.order_by("name")`, and an alphabetical list is how an admin finds one
    // place among a food bank's thirty.
    //
    // WHAT THIS CANNOT PIN, stated rather than implied: deleting `place_name`
    // from that query's `ORDER BY ord, place_name` survives, and no seeding
    // kills it. With the schema's real `loc_fb_name_uniq` /`dp_fb_name_uniq`
    // indexes in place -- migration 0001's, reproduced verbatim in this
    // file's fixture -- SQLite answers `WHERE l.foodbank_id = ?1` by walking
    // (foodbank_id, name), so the rows already arrive name-ordered and the
    // sort key is redundant for that plan. Measured, not assumed: with those
    // two indexes dropped the same query returns Wilton before Bemerton
    // Heath, and with them present it does not. So the name half of the sort
    // is belt and braces the planner currently makes invisible; the ORDINAL
    // half is genuinely pinned here -- swapping the location and donation
    // point ordinals fails this test.
    seedLocation(10, SALISBURY, "Wilton", { place_id: LOC_PLACE_2, place_has_photo: 1 });
    seedLocation(11, SALISBURY, "Bemerton Heath", { place_id: LOC_PLACE, place_has_photo: 1 });
    seedDonationPoint(10, SALISBURY, "Waitrose", { place_id: DP_PLACE_2, place_has_photo: 1 });
    seedDonationPoint(11, SALISBURY, "Co-op", { place_id: DP_PLACE, place_has_photo: 1 });
    db.prepare("UPDATE foodbank SET place_id = ?, place_has_photo = 1 WHERE id = ?").run(FB_PLACE, SALISBURY);
    seedPhoto(1, FB_PLACE);
    seedPhoto(2, LOC_PLACE_2); // Wilton, ahead of Bemerton Heath by id
    seedPhoto(3, DP_PLACE_2); // Waitrose, ahead of Co-op by id
    seedPhoto(4, LOC_PLACE);
    seedPhoto(5, DP_PLACE);

    const res = await request("/admin/foodbank/salisbury/tab/photos/");

    expect(res.status).toBe(200);
    expect(renderContext<{ place_type: string; photo_url: string }[]>("photos")).toEqual([
      expect.objectContaining({ place_type: "foodbank", photo_url: "/needs/at/salisbury/photo.jpg" }),
      expect.objectContaining({ place_type: "location", photo_url: "/needs/at/salisbury/bemerton-heath/photo.jpg" }),
      expect.objectContaining({ place_type: "location", photo_url: "/needs/at/salisbury/wilton/photo.jpg" }),
      expect.objectContaining({ place_type: "donationpoint", photo_url: "/needs/at/salisbury/donationpoint/co-op/photo.jpg" }),
      expect.objectContaining({ place_type: "donationpoint", photo_url: "/needs/at/salisbury/donationpoint/waitrose/photo.jpg" }),
    ]);
    // Every row carries a delete form (routes/admin/photoDelete.ts), so this
    // fragment needs its own token exactly as the donation points one does.
    expect(lastRender().context.csrf_token).toBe(CSRF_RAW);
    expect(lastRender().context.foodbank_slug).toBe("salisbury");
  });

  // ALL THREE BRANCHES OF THE UNION, not just the middle one. The query is
  // three SELECTs stapled together and each carries its OWN ownership
  // predicate (`f.id = ?1`, `l.foodbank_id = ?1`, `d.foodbank_id = ?1`);
  // seeding only a decoy LOCATION -- which is what this test did before --
  // left the other two unproven, and mutants that deleted the food bank
  // branch's `f.id = ?1` or the donation point branch's `d.foodbank_id = ?1`
  // both survived the whole suite. Either one hands the admin another food
  // bank's photos with a delete button under each.
  it("shows no photo belonging to another food bank's places, of any kind", async () => {
    db.prepare("UPDATE foodbank SET place_id = ?, place_has_photo = 1 WHERE id = ?").run(AMESBURY_FB_PLACE, AMESBURY);
    seedLocation(900, AMESBURY, "Amesbury Hall", { place_id: LOC_PLACE, place_has_photo: 1 });
    seedDonationPoint(900, AMESBURY, "Amesbury Co-op", { place_id: DP_PLACE, place_has_photo: 1 });
    seedPhoto(1, AMESBURY_FB_PLACE);
    seedPhoto(2, LOC_PLACE);
    seedPhoto(3, DP_PLACE);

    await request("/admin/foodbank/salisbury/tab/photos/");

    expect(renderContext<unknown[]>("photos")).toEqual([]);
    // The rows really are in the table -- an empty placephoto table would
    // make the assertion above pass whatever the query did.
    expect((db.prepare("SELECT COUNT(*) AS n FROM placephoto").get() as { n: number }).n).toBe(3);
  });

  // THE COUNT IS A SECOND, SEPARATE QUERY (getFoodbankPhotoCount's own
  // three-branch UNION in OWNED_PLACE_IDS_SQL) and it was untested for
  // ownership entirely: the tab test above proves the LIST is scoped, and
  // nothing proved the COUNT was. Mutants deleting any one of that union's
  // three ownership predicates survived. The visible result is the tab strip
  // offering a Photos tab -- foodbank_detail.njk:33 renders it only
  // `{% if counts.photos %}` -- for a food bank with no photos of its own,
  // which opens onto the empty grid the tab query correctly returns.
  it("counts no photo belonging to another food bank's places, of any kind", async () => {
    db.prepare("UPDATE foodbank SET place_id = ?, place_has_photo = 1 WHERE id = ?").run(AMESBURY_FB_PLACE, AMESBURY);
    seedLocation(900, AMESBURY, "Amesbury Hall", { place_id: LOC_PLACE, place_has_photo: 1 });
    seedDonationPoint(900, AMESBURY, "Amesbury Co-op", { place_id: DP_PLACE, place_has_photo: 1 });
    seedPhoto(1, AMESBURY_FB_PLACE);
    seedPhoto(2, LOC_PLACE);
    seedPhoto(3, DP_PLACE);

    await request("/admin/foodbank/salisbury/");

    expect(renderContext<{ photos: number }>("counts").photos).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM placephoto").get() as { n: number }).n).toBe(3);
  });

  // The `place_has_photo = 1` predicate on the LOCATION and DONATION POINT
  // branches, which the divergence test below only ever exercised on the food
  // bank branch -- deleting either one survived the suite. The flag is what
  // routes/admin/photoDelete.ts clears to make Delete a real delete (rather
  // than the cache-bust Django's is), so a branch that ignores it re-lists
  // every photo the admin has already deleted, and offers to delete each of
  // them again.
  it("lists no location or donation point whose place_has_photo has been cleared", async () => {
    seedLocation(10, SALISBURY, "Bemerton Heath", { place_id: LOC_PLACE, place_has_photo: 0 });
    seedDonationPoint(10, SALISBURY, "Waitrose", { place_id: DP_PLACE, place_has_photo: 0 });
    seedPhoto(2, LOC_PLACE);
    seedPhoto(3, DP_PLACE);

    await request("/admin/foodbank/salisbury/tab/photos/");

    expect(renderContext<unknown[]>("photos")).toEqual([]);
  });

  // EVERY FIELD THE FRAGMENT READS, as one whole-object claim: photos.njk
  // hangs the row id, the tag, the Place ID cell, the thumbnail and the
  // delete form's hx-post URL off five different keys of this row, and the
  // row is BUILT by hand in placePhotos.ts rather than passed through from a
  // `SELECT *`. Dropping `photo_id` (the delete form's target and the
  // hx-swap row id) or `r2_key` from that object survived every other test
  // here, because nothing asserted the shape of a photo row at all -- only
  // its order and its URL. This is #34's class on the read side: the tab
  // renders, the grid looks right, and the delete button posts to
  // /photo/undefined/delete/.
  it("hands each photo row every field the fragment's cells, thumbnail and delete form read", async () => {
    db.prepare("UPDATE foodbank SET place_id = ?, place_has_photo = 1 WHERE id = ?").run(FB_PLACE, SALISBURY);
    seedPhoto(7, FB_PLACE);

    await request("/admin/foodbank/salisbury/tab/photos/");

    expect(renderContext<Record<string, unknown>[]>("photos")).toEqual([
      {
        photo_id: 7,
        place_id: FB_PLACE,
        r2_key: "media/photo/7.jpg",
        place_name: "Salisbury",
        place_type: "foodbank",
        photo_url: "/needs/at/salisbury/photo.jpg",
      },
    ]);
  });

  // SUSPECT, PINNED AS-IS, at the level the admin actually meets it.
  // foodbank_detail.njk:33 renders the Photos tab only `{% if counts.photos %}`
  // -- and counts.photos comes from getFoodbankPhotoCount, which has no
  // `place_has_photo` predicate, while the tab's own query has one. So a place
  // whose flag is 0 or NULL but whose placephoto row still exists offers a tab
  // that opens onto an empty grid. packages/db/src/placePhotos.test.ts pins the
  // two queries disagreeing; this pins the consequence -- the count says one,
  // the tab says none, on the same request pair. Django counts through
  // place_ids_with_photos() for both (views.py:600-603) and would offer no tab
  // at all here.
  it("offers a Photos tab whose own fragment is empty when place_has_photo is cleared", async () => {
    db.prepare("UPDATE foodbank SET place_id = ?, place_has_photo = 0 WHERE id = ?").run(FB_PLACE, SALISBURY);
    seedPhoto(1, FB_PLACE);

    await request("/admin/foodbank/salisbury/");
    expect(renderContext<{ photos: number }>("counts").photos).toBe(1);

    await request("/admin/foodbank/salisbury/tab/photos/");
    expect(renderContext<unknown[]>("photos")).toEqual([]);
  });
});

describe("adminFoodbankTouch", () => {
  // gfadmin/views.py:1300-1310 foodbank_touch. THE WHOLE POINT OF THE ROUTE is
  // the column it moves: the foodbanks list and the "next food bank to check"
  // queue both sort on `edited` (foodbank_closed_edited_idx), so a Touch that
  // redirected without writing would look exactly like a Touch that worked and
  // silently leave the food bank at the front of the maintainer's queue
  // forever. Neither response body carries any evidence, so the row is read
  // back -- and read back whole, because "only these two columns moved" is the
  // other half of the claim.
  it("stamps edited and modified, and changes nothing else", async () => {
    freezeClock();
    const before = storedFoodbank();

    const res = await request("/admin/foodbank/salisbury/touch/", { form: { csrf_token: CSRF_RAW } });

    expect(res.status).toBe(302);
    const after = storedFoodbank();
    expect(after.edited).toBe(NOW_PY);
    expect(after.modified).toBe(NOW_PY);
    expect({ ...after, edited: before.edited, modified: before.modified }).toEqual(before);
    // ONE statement, and the tracker proving it -- which is also what gives
    // every `expect(writes).toEqual([])` above its teeth: a write recorder that
    // silently recorded nothing would make all of them pass vacuously.
    expect(writes).toHaveLength(1);
    expect(writes[0]!.sql).toBe("UPDATE foodbank SET edited = ?, modified = ? WHERE id = ?");
    expect(writes[0]!.params).toEqual([NOW_PY, NOW_PY, SALISBURY]);
  });

  // Django's `redirect("admin:foodbanks")` -- the LIST, not back to the page
  // the button is on. Surprising enough that the handler's own comment says
  // "confirmed test-pinned"; this is that pin. The workflow it matches is
  // touching a run of food banks from the list, one after another.
  it("redirects to the food banks list, not to the food bank", async () => {
    const res = await request("/admin/foodbank/salisbury/touch/", { form: { csrf_token: CSRF_RAW } });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/foodbanks/");
  });

  // views.py:1307-1309. The button posts through htmx with
  // hx-swap="outerHTML", so this fragment REPLACES the button -- a redirect
  // here would be followed by htmx and the whole foodbanks list page would be
  // swapped into the button's place.
  it("answers an htmx POST with the disabled button, still having written the row", async () => {
    freezeClock();

    const res = await request("/admin/foodbank/salisbury/touch/", {
      form: { csrf_token: CSRF_RAW },
      headers: { "HX-Request": "true" },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<button type="button" class="button is-link is-light" disabled>Touched</button>');
    expect(storedFoodbank().edited).toBe(NOW_PY);
  });

  it("404s a slug no food bank has, and writes nothing", async () => {
    const res = await request("/admin/foodbank/andover/touch/", { form: { csrf_token: CSRF_RAW } });

    expect(res.status).toBe(404);
    expect(writes).toEqual([]);
  });

  // ORDER OF CHECKS, pinned deliberately: the food bank is resolved BEFORE the
  // CSRF token is verified, so a forged POST at a nonexistent slug is answered
  // 404 and one at a real slug 403 -- a (very mild) existence oracle on an
  // admin-only route whose slugs are public anyway. Django's own view has no
  // CSRF middleware enabled at all (settings.py:97), so there is no original
  // behaviour to match here; this records what the port does.
  it("resolves the food bank before it checks the token", async () => {
    const res = await request("/admin/foodbank/andover/touch/", { form: { csrf_token: "wrong-token" } });

    expect(res.status).toBe(404);
  });
});

describe("adminFoodbankTouch -- the CSRF gate", () => {
  // Each refusal asserts the STATUS AND THE ROW. A handler that 403s after
  // writing would pass a status check and still be the bug -- and this is the
  // one route on the page that writes at all.
  async function expectRefused(res: Response, before: Record<string, unknown>): Promise<void> {
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden");
    expect(writes).toEqual([]);
    expect(storedFoodbank()).toEqual(before);
  }

  // THE POSITIVE HALF OF THE GATE, end to end, because every other test in
  // this describe proves only that the door is shut. The Touch button's
  // hidden field is filled from the detail page's OWN context.csrf_token
  // (adminPageContext -> issueCsrfToken), and nothing asserted that key
  // existed: deleting it left all 64 tests green while every Touch button in
  // the admin posted an empty token and came back 403 -- the button visibly
  // doing nothing, no error anywhere, which is precisely how #34 shipped.
  // Driven as a fresh visitor with no CSRF cookie so the MINT path runs and
  // the cookie the token is validated against has to actually reach the
  // browser.
  it("hands the page's own Touch form a token the Touch route then accepts", async () => {
    freezeClock();

    const page = await request("/admin/foodbank/salisbury/", { cookies: [`__Host-gfsession=${SESSION_ID}`] });
    const token = lastRender().context.csrf_token as string;
    const cookie = /__Host-csrf=[^;]+/.exec(page.headers.get("set-cookie") ?? "")?.[0];
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(cookie).toBeDefined();
    expect(writes).toEqual([]); // rendering the form still wrote nothing

    const res = await request("/admin/foodbank/salisbury/touch/", {
      cookies: [`__Host-gfsession=${SESSION_ID}`, cookie!],
      form: { csrf_token: token },
    });

    expect(res.status).toBe(302);
    expect(storedFoodbank().edited).toBe(NOW_PY);
  });

  it("refuses a POST with no token at all", async () => {
    const before = storedFoodbank();

    await expectRefused(await request("/admin/foodbank/salisbury/touch/", { form: {} }), before);
  });

  it("refuses a token that does not match the cookie", async () => {
    const before = storedFoodbank();

    await expectRefused(await request("/admin/foodbank/salisbury/touch/", { form: { csrf_token: "d".repeat(64) } }), before);
  });

  // The signature is what makes this a SIGNED double-submit rather than a
  // plain one: an attacker who can set a cookie from a sibling subdomain can
  // make the cookie and the field agree, but not produce a signature over the
  // value without CSRF_SECRET.
  it("refuses a cookie whose signature does not verify, even when the field matches it", async () => {
    const before = storedFoodbank();
    const forged = `__Host-csrf=${"e".repeat(64)}.deadbeef`;

    await expectRefused(
      await request("/admin/foodbank/salisbury/touch/", {
        cookies: [`__Host-gfsession=${SESSION_ID}`, forged],
        form: { csrf_token: "e".repeat(64) },
      }),
      before,
    );
  });

  it("refuses a cross-origin POST that carries a valid token", async () => {
    const before = storedFoodbank();

    await expectRefused(
      await request("/admin/foodbank/salisbury/touch/", {
        form: { csrf_token: CSRF_RAW },
        headers: { Origin: "https://evil.example.com" },
      }),
      before,
    );
  });

  it("refuses a POST the browser labels cross-site", async () => {
    const before = storedFoodbank();

    await expectRefused(
      await request("/admin/foodbank/salisbury/touch/", {
        form: { csrf_token: CSRF_RAW },
        headers: { "Sec-Fetch-Site": "cross-site" },
      }),
      before,
    );
  });

  it("never reaches the handler without an admin session, and writes nothing", async () => {
    const before = storedFoodbank();

    const res = await request("/admin/foodbank/salisbury/touch/", {
      cookies: [await csrfCookie()],
      form: { csrf_token: CSRF_RAW },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/?next=%2Fadmin%2Ffoodbank%2Fsalisbury%2Ftouch%2F");
    expect(writes).toEqual([]);
    expect(storedFoodbank()).toEqual(before);
  });

  // routes/admin/index.ts:134 registers this URL for POST only, mirroring
  // Django's @require_POST. A GET must not be routed to it -- otherwise a
  // crawler, a prefetch or a mistyped link bumps `edited` on a food bank
  // nobody touched.
  it("is not reachable by GET", async () => {
    const before = storedFoodbank();

    const res = await request("/admin/foodbank/salisbury/touch/", { method: "GET" });

    expect(res.status).toBe(404);
    expect(writes).toEqual([]);
    expect(storedFoodbank()).toEqual(before);
  });
});
