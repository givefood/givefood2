import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireAdminAuth } from "../../middleware/adminAuth";
import { hmacSha256Hex } from "../../lib/hmac";
import type { AppEnv } from "../../types";

// routes/admin/lists.ts -- the eleven read-only admin list pages, the four CSV
// exports and the one mutating route (/admin/subscriptions/delete/) that sits
// among them. Every one of these is a page the maintainer opens daily, and
// every failure they can have is silent: a filter that stopped filtering shows
// MORE rows, a sort applied to the wrong column shows the SAME rows in the
// wrong order, an escaped cell that stopped being escaped renders someone's
// apostrophe as markup, and a delete that deleted nothing still 302s back to a
// page that looks right. None of that throws, and none of it is visible in a
// green `pnpm test` unless somebody asserts the rows.
//
// SO THIS FILE DRIVES THE REAL ROUTER OVER A REAL DATABASE. A Hono app is
// assembled with the same relative paths and the same requireAdminAuth
// middleware routes/admin/index.ts:85-192 uses, mounted at /admin exactly as
// index.ts:637 mounts it, over an in-memory SQLite seeded from the migrations'
// own DDL. Nothing on the read path is mocked: packages/db's queries, the
// pagination arithmetic, parseSort/parsePage, the cell builders, the CSV
// writer, issueCsrfToken and verifyCsrf are all the shipped implementations.
//
// TWO THINGS ARE FAKED, BOTH BECAUSE THEY LEAVE THE MACHINE:
//   - the SESSIONS KV namespace requireAdminAuth reads (so that "signed in"
//     and "signed out" are both reachable, and the signed-out case can be
//     asserted rather than assumed);
//   - `render`, which is captured rather than executed. The context handed to
//     admin/list.njk IS the handler's output -- `columns`, `rows[].cells`,
//     `sort_options`, `filter_options`, the paginator's four numbers -- and
//     asserting it directly says "this row, this cell, this string" instead of
//     hunting for substrings in markup the template owns. It also keeps the
//     suite runnable on a fresh checkout: packages/templates/src/generated/ is
//     a gitignored build artefact (the same reasoning foodbankLocation.test.ts
//     gives for mocking it). djangoDate/intcomma/translate stay REAL, because
//     the date and number cells are formatted by the handler, not the
//     template.
//
// WHAT THIS FILE IS NOT. packages/db/src/adminLists.test.ts already runs every
// query in packages/db/src/adminLists.ts against a real engine and asserts the
// rows they return. This file does not repeat that; it asserts what the ROUTE
// does with them -- which `?sort=` reaches the query, what a cell reads as,
// which response comes back, and what a POST changes. Where the two overlap
// (the closed-foodbank exclusion, the confirmed-subscriber filter) it is
// deliberate: those are exclusions, and an exclusion tested only through the
// layer that implements it is untested from the layer that could stop asking
// for it.

const captured = vi.hoisted(() => ({ calls: [] as { template: string; context: Record<string, unknown> }[] }));

vi.mock("@givefood/templates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@givefood/templates")>();
  return {
    ...actual,
    render: async (template: string, context: Record<string, unknown>) => {
      captured.calls.push({ template, context });
      return `<html data-template="${template}"></html>`;
    },
  };
});

import {
  adminDeleteSubscription,
  adminDonationPointsList,
  adminFoodbanksCsv,
  adminFoodbanksList,
  adminFoodbanksNext,
  adminFoodbanksWithoutNeedList,
  adminLocationsList,
  adminNeedsCsv,
  adminNeedsList,
  adminOrdersCsv,
  adminOrdersList,
  adminParlconsCsv,
  adminParlconsList,
  adminPlacesList,
  adminSubscriptionsList,
} from "./lists";

// ---------------------------------------------------------------------------
// Schema. Copied from packages/db/migrations (via the identical transcription
// in packages/db/src/adminLists.test.ts and adminSearch.test.ts), NOT from the
// TypeScript interfaces -- the point of a real engine is to catch the two
// disagreeing. Post-0019, so the cached foodbank_* columns are gone from the
// child tables and the three _full views are where the denormalised
// foodbank_name/foodbank_slug come from. The UNIQUE indexes are here so a
// fixture cannot construct a state production would have refused.
// ---------------------------------------------------------------------------
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

CREATE TABLE parliamentaryconstituency (
  id INTEGER PRIMARY KEY,
  name TEXT, slug TEXT NOT NULL, country TEXT,
  mp TEXT, mp_party TEXT, mp_parl_id INTEGER NOT NULL, mp_display_name TEXT, email TEXT,
  centroid TEXT NOT NULL,
  latitude REAL, longitude REAL,
  boundary_geojson TEXT,
  pcon24cd TEXT
);

CREATE TABLE foodbankhit (
  foodbank_id INTEGER NOT NULL, day TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (foodbank_id, day)
) WITHOUT ROWID;

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

CREATE TABLE place (
  id INTEGER PRIMARY KEY, gbpnid INTEGER NOT NULL,
  name TEXT,
  name_upper TEXT,
  lat_lng TEXT, county TEXT, county_slug TEXT NOT NULL,
  name_slug TEXT NOT NULL, population INTEGER
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

// ---------------------------------------------------------------------------
// The D1 Sessions API surface these handlers use, over node:sqlite. Copied
// from foodbankLocation.test.ts's d1Session with adminLists.test.ts's addition
// of `meta.changes`, which deleteSubscription reads to decide its return
// value -- a run() reporting a constant would make every delete test pass
// whether or not a row actually went.
// ---------------------------------------------------------------------------
type Bindable = null | number | bigint | string | Uint8Array;

function d1Session(database: DatabaseSync): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (database.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: database.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      const info = database.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(info.changes) } };
    },
  });
  return { prepare: (sql: string) => statement(sql, []), getBookmark: () => null } as unknown as D1DatabaseSession;
}

const ORIGIN = "https://www.givefood.org.uk";
const CSRF_SECRET = "test-csrf-secret-not-a-real-one";
const CSRF_RAW = "a".repeat(64);
const SESSION_COOKIE = "__Host-gfsession=test-session-id";

// A pinned "now". The foodbanks page's hits window is `Date.now() - 28 days`
// truncated to a date, and every dateCell carries a timesince() string, so
// both are functions of the clock -- computing the expectations from the same
// clock the handler reads would assert nothing. Only Date is faked:
// performance.now() (serverTiming's elapsedMs) and crypto (the CSRF HMAC) must
// stay real.
const NOW = new Date("2026-09-05T12:00:00Z");
// Date.now() - 28d = 2026-08-08T12:00:00Z, sliced to "2026-08-08". A hit
// stamped that day is INCLUDED (the SQL says `day >= ?1`); 2026-08-07 is not.
const HITS_CUTOFF_DAY = "2026-08-08";

let db: DatabaseSync;
let kvGets: string[];
let kvPuts: string[];
let signedIn: boolean;

function insert(table: string, values: Record<string, Bindable>): void {
  const cols = Object.keys(values);
  db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(
    ...cols.map((col) => values[col] ?? null),
  );
}

// Every NOT NULL column the foodbank table declares, so a test only has to
// name the columns it is actually about.
const FOODBANK_DEFAULTS: Record<string, Bindable> = {
  uuid: "fb-uuid",
  name: "Some Food Bank",
  slug: "some-food-bank",
  address: "1 Test Street",
  postcode: "SW1A 1AA",
  country: "England",
  lat_lng: "51.5,-0.1",
  charity_just_foodbank: 0,
  charity_number: null,
  contact_email: "info@example.org",
  url: "https://example.org/",
  shopping_list_url: "https://example.org/list/",
  network: "Trussell",
  address_is_administrative: 0,
  is_closed: 0,
  no_locations: 0,
  no_donation_points: 0,
  days_between_needs: 7,
  last_order: null,
  last_need: null,
  last_need_check: null,
  parliamentary_constituency_name: null,
  mp: null,
  mp_party: null,
  mp_parl_id: null,
  created: "2026-01-01 00:00:00",
  modified: "2026-01-01 00:00:00",
  edited: "2026-01-01 00:00:00",
};

function seedFoodbank(over: Record<string, Bindable> = {}): void {
  insert("foodbank", { ...FOODBANK_DEFAULTS, ...over });
}

function seedLocation(over: Record<string, Bindable> = {}): void {
  insert("foodbanklocation", {
    uuid: "loc-uuid",
    foodbank_id: 1,
    name: "A Location",
    slug: "a-location",
    address: "2 Test Street",
    postcode: "SW1A 2AA",
    country: "England",
    lat_lng: "51.5,-0.1",
    is_closed: 0,
    parliamentary_constituency_name: null,
    mp: null,
    mp_parl_id: null,
    modified: "2026-02-01 00:00:00",
    edited: "2026-02-01 00:00:00",
    ...over,
  });
}

function seedDonationPoint(over: Record<string, Bindable> = {}): void {
  insert("foodbankdonationpoint", {
    uuid: "dp-uuid",
    foodbank_id: 1,
    name: "A Donation Point",
    slug: "a-donation-point",
    address: "3 Test Street",
    postcode: "SW1A 3AA",
    country: "England",
    lat_lng: "51.5,-0.1",
    is_closed: 0,
    in_store_only: 0,
    company: null,
    company_slug: null,
    store_id: null,
    modified: "2026-02-01 00:00:00",
    edited: "2026-02-01 00:00:00",
    ...over,
  });
}

function seedNeed(over: Record<string, Bindable> = {}): void {
  insert("foodbankchange", {
    need_id: "11111111-1111-1111-1111-111111111111",
    foodbank_id: 1,
    change_text: "Beans",
    excess_change_text: null,
    published: 1,
    is_categorised: null,
    input_method: "scrape",
    created: "2026-03-01 09:00:00",
    modified: "2026-03-01 09:00:00",
    ...over,
  });
}

function seedOrder(over: Record<string, Bindable> = {}): void {
  insert("orders", {
    order_id: "ORD-1",
    items_text: "beans",
    country: "England",
    created: "2026-04-01 09:00:00",
    modified: "2026-04-01 09:00:00",
    delivery_date: "2026-04-03",
    delivery_hour: 9,
    delivery_datetime: "2026-04-03 09:00:00",
    delivery_provider: "Tesco",
    delivery_provider_id: "TESCO-1",
    weight: 100000,
    calories: 250000,
    cost: 12345,
    actual_cost: null,
    no_lines: 3,
    no_items: 42,
    foodbank_id: 1,
    ...over,
  });
}

function seedParlcon(over: Record<string, Bindable> = {}): void {
  insert("parliamentaryconstituency", {
    name: "Cities of London and Westminster",
    slug: "cities-of-london-and-westminster",
    country: "England",
    mp: "Rachel Blake",
    mp_party: "Labour",
    mp_parl_id: 5000,
    email: "rachel.blake.mp@parliament.uk",
    centroid: "51.5,-0.1",
    boundary_geojson: null,
    ...over,
  });
}

function seedPlace(over: Record<string, Bindable> = {}): void {
  insert("place", {
    gbpnid: 1,
    name: "Salisbury",
    name_upper: "SALISBURY",
    lat_lng: "51.0688,-1.7945",
    county: "Wiltshire",
    county_slug: "wiltshire",
    name_slug: "salisbury",
    population: 40302,
    ...over,
  });
}

// ---------------------------------------------------------------------------
// The app under test: the same relative paths routes/admin/index.ts registers,
// behind the same requireAdminAuth, mounted at the same /admin prefix. Built
// per request rather than once so that a test can flip `signedIn` and get a
// genuinely unauthenticated request rather than a cached decision.
// ---------------------------------------------------------------------------
function buildApp(): Hono<AppEnv> {
  const admin = new Hono<AppEnv>();
  admin.use("*", requireAdminAuth);
  admin.get("/foodbanks/", adminFoodbanksList);
  admin.get("/foodbanks/csv/", adminFoodbanksCsv);
  admin.get("/foodbanks/next/", adminFoodbanksNext);
  admin.get("/locations/", adminLocationsList);
  admin.get("/donationpoints/", adminDonationPointsList);
  admin.get("/politics/", adminParlconsList);
  admin.get("/politics/csv/", adminParlconsCsv);
  admin.get("/orders/", adminOrdersList);
  admin.get("/orders/csv/", adminOrdersCsv);
  admin.get("/needs/csv/", adminNeedsCsv);
  admin.get("/places/", adminPlacesList);
  admin.get("/subscriptions/", adminSubscriptionsList);
  admin.post("/subscriptions/delete/", adminDeleteSubscription);
  admin.get("/foodbanks/without_need/", adminFoodbanksWithoutNeedList);
  admin.get("/needs/", adminNeedsList);

  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("requestStartTime", performance.now());
    await next();
  });
  app.route("/admin", admin);
  // Labelled rather than left to become an unhandled rejection, so a
  // regression reads as "expected 200, got 500: no such column" instead of a
  // vitest crash with no route in it.
  app.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));
  return app;
}

function env(): AppEnv["Bindings"] {
  return {
    DB: { withSession: () => d1Session(db) },
    CSRF_SECRET,
    GMAP_STATIC_KEY: "",
    GMAP_GEOCODE_KEY: "",
    D1_DATABASE_NAME: "givefood-test",
    // getAdminSession hashes the cookie's session id into the KV key; this
    // fake answers on ANY key so the tests never have to reproduce that
    // derivation -- there is only ever one session in play. `signedIn` is the
    // switch the auth tests flip. expiresAt is a full TTL ahead of the faked
    // clock so the sliding-window refresh (adminAuth.ts:286-293) never fires
    // and `kvPuts` staying empty means what it says.
    SESSIONS: {
      get: async (key: string) => {
        kvGets.push(key);
        if (!signedIn) return null;
        return JSON.stringify({
          email: "someone@givefood.org.uk",
          name: "Some One",
          givenName: "Some",
          picture: "",
          expiresAt: Date.now() + 12 * 60 * 60 * 1000,
        });
      },
      put: async (key: string) => {
        kvPuts.push(key);
      },
      delete: async () => {},
    },
  } as unknown as AppEnv["Bindings"];
}

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

async function fetchPath(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (signedIn) headers.set("Cookie", [headers.get("Cookie"), SESSION_COOKIE].filter(Boolean).join("; "));
  return buildApp().fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), env(), execCtx);
}

// The context handed to admin/list.njk -- i.e. exactly what the admin's
// browser is about to be shown. Every list assertion below reads through here.
interface ListContext {
  title: string;
  section: string;
  csrf_token: string;
  total: number;
  page: number;
  total_pages: number;
  has_next: boolean;
  sort?: string;
  sort_options?: { value: string; label: string; selected: boolean }[];
  columns: { label: string; sort?: string; active?: boolean; desc?: boolean }[];
  rows: { cells: string[]; actions: string }[];
  row_actions: boolean;
  new_url?: string;
  new_label?: string;
  csv_url?: string;
  extra_query?: string;
  filter_options?: { value: string; label: string; selected: boolean }[];
}

async function getList(path: string): Promise<{ res: Response; ctx: ListContext }> {
  const res = await fetchPath(path);
  const call = captured.calls.at(-1);
  if (!call) throw new Error(`the handler for ${path} rendered nothing (status ${res.status})`);
  expect(call.template).toBe("admin/list.njk");
  return { res, ctx: call.context as unknown as ListContext };
}

// The cells of one row, or of every row's Nth column -- the two shapes almost
// every assertion below wants.
function cells(ctx: ListContext, index: number): string[] {
  const row = ctx.rows[index];
  if (!row) throw new Error(`no row at index ${index} (${ctx.rows.length} rendered)`);
  return row.cells;
}

function column(ctx: ListContext, index: number): string[] {
  return ctx.rows.map((row) => row.cells[index] ?? "");
}

// CSV bodies are CRLF-terminated (packages/serialise/src/csv.ts:31); split on
// that, not on \n, or every field ends in a stray \r and the failure message
// is unreadable.
function csvLines(body: string): string[] {
  const lines = body.split("\r\n");
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}

async function post(path: string, fields: Record<string, string>, opts: { cookie?: string; origin?: string } = {}): Promise<Response> {
  const signature = await hmacSha256Hex(CSRF_SECRET, CSRF_RAW);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    "Sec-Fetch-Site": "same-origin",
  };
  const cookie = opts.cookie === undefined ? `__Host-csrf=${CSRF_RAW}.${signature}` : opts.cookie;
  if (cookie) headers.Cookie = cookie;
  headers.Origin = opts.origin ?? ORIGIN;
  return fetchPath(path, { method: "POST", headers, body: new URLSearchParams(fields).toString() });
}

function subscriberCount(table: "foodbanksubscriber" | "mobilesubscriber" | "webpushsubscription"): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  captured.calls.length = 0;
  kvGets = [];
  kvPuts = [];
  signedIn = true;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

// ===========================================================================
// Auth. Every route in this file sits behind requireAdminAuth, and the one
// that matters is the POST: an unauthenticated delete must not reach the
// handler at all, which is a claim about the ROW, not about the status code.
// ===========================================================================
describe("the admin auth gate", () => {
  it("redirects an unauthenticated list request to /auth/ with the path to come back to", async () => {
    signedIn = false;
    const res = await fetchPath("/admin/foodbanks/");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Ffoodbanks%2F");
    // The handler never ran, so nothing was rendered and no D1 session was
    // opened. A gate that redirected AFTER querying would still leak timing
    // and still cost the read.
    expect(captured.calls).toHaveLength(0);
  });

  it("refuses an unauthenticated subscription delete and leaves the row alone", async () => {
    seedFoodbank({ id: 1 });
    insert("mobilesubscriber", { id: 9, created: "2026-05-01 00:00:00", device_id: "dev-9", platform: "iOS", foodbank_id: 1 });
    signedIn = false;

    const res = await post("/admin/subscriptions/delete/", { csrf_token: CSRF_RAW, type: "mobile", row_id: "9" });

    // Redirected to sign in, NOT 403 -- the auth gate runs before the CSRF
    // check, so the admin gets the sign-in page rather than a bare Forbidden.
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fsubscriptions%2Fdelete%2F");
    expect(subscriberCount("mobilesubscriber")).toBe(1);
  });
});

// ===========================================================================
// /admin/foodbanks/
// ===========================================================================
describe("adminFoodbanksList", () => {
  // The exclusion Django's view makes (gfadmin/views.py:234-314,
  // `.exclude(is_closed=True)`), seeded so that a query which stopped
  // excluding has a row to show. A test that only seeds open food banks passes
  // whether or not the filter exists.
  it("hides closed food banks, and counts only the open ones", async () => {
    seedFoodbank({ id: 1, name: "Open Bank", slug: "open-bank" });
    seedFoodbank({ id: 2, name: "Closed Bank", slug: "closed-bank", is_closed: 1 });

    const { ctx } = await getList("/admin/foodbanks/");

    expect(ctx.rows).toHaveLength(1);
    expect(cells(ctx, 0)[0]).toBe('<a href="/admin/foodbank/open-bank/">Open Bank</a>');
    // `total` drives the "Foodbanks (N)" heading and the paginator; a count
    // that forgot the filter would say 2 above a list of 1.
    expect(ctx.total).toBe(1);
  });

  // The "Closed" column therefore has nothing to show, ever. It is here
  // because Django's foodbanks.html has it (over the same excluded queryset),
  // so it is parity, not an oversight -- pinned so that removing it reads as a
  // deliberate divergence rather than a tidy-up.
  //
  // A MUTANT SURVIVES HERE AND CANNOT BE KILLED FROM THIS ROUTE, stated
  // rather than papered over: replacing the cell's whole
  // `fb.is_closed ? "<span style=color:red>X</span>" : ""` with a bare "" is
  // undetectable, because the query above guarantees no row reaching the cell
  // has is_closed set. The truthy half of that ternary is unreachable code on
  // this page by construction; the only test that could exercise it would
  // have to break the exclusion this suite exists to protect.
  it("renders an always-empty Closed column, as Django's template does", async () => {
    seedFoodbank({ id: 1 });
    const { ctx } = await getList("/admin/foodbanks/");

    expect(ctx.columns[3]).toEqual({ label: "Closed" });
    expect(cells(ctx, 0)[3]).toBe("");
  });

  // views.py:258 `request.GET.get("sort", "edited")` applied raw at :303, so
  // the default is edited ASCENDING: this page is the triage queue, opened
  // least-recently-edited first. Sorting it newest-first would bury exactly
  // the rows an admin came for, and nothing about the page would look wrong.
  it("opens least-recently-edited first", async () => {
    seedFoodbank({ id: 1, name: "Recent", slug: "recent", edited: "2026-09-01 00:00:00" });
    seedFoodbank({ id: 2, name: "Stale", slug: "stale", edited: "2024-01-01 00:00:00" });
    seedFoodbank({ id: 3, name: "Middling", slug: "middling", edited: "2026-05-01 00:00:00" });

    const { ctx } = await getList("/admin/foodbanks/");

    expect(column(ctx, 0)).toEqual([
      '<a href="/admin/foodbank/stale/">Stale</a>',
      '<a href="/admin/foodbank/middling/">Middling</a>',
      '<a href="/admin/foodbank/recent/">Recent</a>',
    ]);
    expect(ctx.sort).toBe("edited");
  });

  it("sorts ascending on a bare key and descending on a signed one", async () => {
    seedFoodbank({ id: 1, name: "Alpha", slug: "alpha" });
    seedFoodbank({ id: 2, name: "Beta", slug: "beta" });

    expect(column((await getList("/admin/foodbanks/?sort=name")).ctx, 0)).toEqual([
      '<a href="/admin/foodbank/alpha/">Alpha</a>',
      '<a href="/admin/foodbank/beta/">Beta</a>',
    ]);
    expect(column((await getList("/admin/foodbanks/?sort=-name")).ctx, 0)).toEqual([
      '<a href="/admin/foodbank/beta/">Beta</a>',
      '<a href="/admin/foodbank/alpha/">Alpha</a>',
    ]);
  });

  // Django 403s an unrecognised sort key (views.py:259-260). The port falls
  // back to the page's own default instead -- an admin following a stale
  // bookmark gets the list, not a Forbidden. The allowlist is what keeps that
  // safe: `sort` is interpolated straight into the ORDER BY, so a key that
  // reached the SQL unchecked would be an injection point.
  it("falls back to the default sort instead of Django's 403, for an unknown key", async () => {
    seedFoodbank({ id: 1, name: "Recent", slug: "recent", edited: "2026-09-01 00:00:00" });
    seedFoodbank({ id: 2, name: "Stale", slug: "stale", edited: "2024-01-01 00:00:00" });

    const { res, ctx } = await getList("/admin/foodbanks/?sort=id;DROP TABLE foodbank");

    expect(res.status).toBe(200);
    expect(ctx.sort).toBe("edited");
    expect(column(ctx, 0)[0]).toBe('<a href="/admin/foodbank/stale/">Stale</a>');
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbank").get()).toEqual({ n: 2 });
  });

  // parseSort's `field === sort && wantsDesc` guard, spelled out: the minus
  // sign is only honoured when the field it prefixes survived the allowlist.
  // `?sort=-nope` therefore lands on the default ASCENDING, not descending --
  // worth pinning because "the sort key was rejected" and "the direction was
  // rejected too" are separable decisions and this one keeps the pair
  // together.
  it("drops the descending marker along with an unrecognised field", async () => {
    seedFoodbank({ id: 1, name: "Recent", slug: "recent", edited: "2026-09-01 00:00:00" });
    seedFoodbank({ id: 2, name: "Stale", slug: "stale", edited: "2024-01-01 00:00:00" });

    const { ctx } = await getList("/admin/foodbanks/?sort=-nope");

    expect(ctx.sort).toBe("edited");
    expect(column(ctx, 0)[0]).toBe('<a href="/admin/foodbank/stale/">Stale</a>');
  });

  // ListColumn's own comment: `sort` is the NEXT sort, not the current one, so
  // the arrow must be driven by active/desc. Getting this backwards produces a
  // header that claims the opposite of the order on screen, and a click that
  // does nothing because it re-requests the sort already applied.
  it("gives the active column a link that flips it, and a fresh one a link that starts ascending", async () => {
    seedFoodbank({ id: 1 });

    const ascending = (await getList("/admin/foodbanks/?sort=name")).ctx;
    expect(ascending.columns[0]).toEqual({ label: "Name", sort: "-name", active: true, desc: false });
    expect(ascending.columns[1]).toEqual({ label: "Postcode", sort: "postcode", active: false, desc: false });

    const descending = (await getList("/admin/foodbanks/?sort=-name")).ctx;
    expect(descending.columns[0]).toEqual({ label: "Name", sort: "name", active: true, desc: true });
    // MUTANT KILLED (run, not imagined): `const desc = active && direction
    // === "desc"` -> `const desc = direction === "desc"`. Every inactive
    // header then inherits the active column's direction, so a list sorted
    // Name (Desc) draws a down-arrow on all fourteen columns and the admin
    // can no longer see which one the rows are actually ordered by. The
    // ascending half of this test cannot catch it -- with direction "asc" the
    // mutant and the original agree -- so the inactive column has to be
    // asserted HERE, under a descending sort.
    expect(descending.columns[1]).toEqual({ label: "Postcode", sort: "postcode", active: false, desc: false });
  });

  // gfadmin/views.py:236-257 builds both directions of every field into the
  // select, and :261-270 labels them "_" -> " ", str.title(), " (Desc)" on the
  // signed half.
  it("offers both directions of every sortable field, labelled Django's way", async () => {
    seedFoodbank({ id: 1 });
    const { ctx } = await getList("/admin/foodbanks/?sort=-hits_last_28_days");

    expect(ctx.sort_options).toHaveLength(26); // 13 fields x 2 directions
    expect(ctx.sort_options?.slice(0, 4)).toEqual([
      { value: "name", label: "Name", selected: false },
      { value: "-name", label: "Name (Desc)", selected: false },
      { value: "last_order", label: "Last Order", selected: false },
      { value: "-last_order", label: "Last Order (Desc)", selected: false },
    ]);
    // The digits in "28" must not swallow the capital that follows them --
    // Python's str.title() gives "Hits Last 28 Days" and so must the regex
    // that stands in for it.
    expect(ctx.sort_options?.find((o) => o.value === "-hits_last_28_days")).toEqual({
      value: "-hits_last_28_days",
      label: "Hits Last 28 Days (Desc)",
      selected: true,
    });
  });

  // views.py:275-292's annotation, as a correlated subquery over a 28-day
  // window. The window is the whole point: without it the column reads
  // "all-time hits" and every food bank looks equally busy forever.
  it("sums only the last 28 days of hits, inclusive of the cutoff day", async () => {
    seedFoodbank({ id: 1 });
    insert("foodbankhit", { foodbank_id: 1, day: HITS_CUTOFF_DAY, hits: 5 });
    insert("foodbankhit", { foodbank_id: 1, day: "2026-08-07", hits: 100000 }); // one day too old
    insert("foodbankhit", { foodbank_id: 1, day: "2026-09-01", hits: 7 });

    const { ctx } = await getList("/admin/foodbanks/");

    expect(cells(ctx, 0)[7]).toBe("12");
  });

  it("shows a food bank with no recent hits as 0, not blank", async () => {
    seedFoodbank({ id: 1 });
    const { ctx } = await getList("/admin/foodbanks/");

    expect(cells(ctx, 0)[7]).toBe("0");
  });

  // foodbanks.html:56 `{{ foodbank.hits_last_28_days|intcomma }}`.
  it("thousand-separates the hits column", async () => {
    seedFoodbank({ id: 1 });
    insert("foodbankhit", { foodbank_id: 1, day: "2026-09-01", hits: 1234567 });

    expect(cells((await getList("/admin/foodbanks/")).ctx, 0)[7]).toBe("1,234,567");
  });

  // dateCell: Django's default DATETIME_FORMAT on the first line, a timesince
  // line beneath, exactly as every gfadmin list template writes it by hand.
  // The NBSP is Django's avoid_wrapping and is load-bearing -- a plain space
  // here means the port stopped matching django.utils.timesince.
  it("renders a date cell as Django's DATETIME_FORMAT plus a timesince line", async () => {
    seedFoodbank({ id: 1, last_need: "2026-09-02 15:34:00" });

    expect(cells((await getList("/admin/foodbanks/")).ctx, 0)[9]).toBe(
      'Sept. 2, 2026, 3:34 p.m.<br><span class="is-size-7">2 days, 20 hours ago</span>',
    );
  });

  it("leaves a null date cell completely empty, not '' ago", async () => {
    seedFoodbank({ id: 1, last_order: null });

    expect(cells((await getList("/admin/foodbanks/")).ctx, 0)[8]).toBe("");
  });

  // Cells go through the template as `| safe` (admin/list.njk's `{{ cell |
  // safe }}`), so escaping is the HANDLER's job and nothing downstream will
  // catch a miss. A food bank called "Ben & Jerry's" is not hypothetical --
  // ampersands and apostrophes are ordinary in these names.
  it("escapes the values it interpolates into a cell", async () => {
    seedFoodbank({ id: 1, name: `Ben & Jerry's <b>Food</b> "Bank"`, slug: "bens", postcode: "SW1 <1AA" });

    const rendered = cells((await getList("/admin/foodbanks/")).ctx, 0);
    expect(rendered[0]).toBe('<a href="/admin/foodbank/bens/">Ben &amp; Jerry&#39;s &lt;b&gt;Food&lt;/b&gt; &quot;Bank&quot;</a>');
    expect(rendered[1]).toBe("SW1 &lt;1AA");
  });

  // SUSPECT, pinned as-is. The slug is interpolated into the href WITHOUT
  // escaping (lists.ts:237), so a stored slug containing a quote breaks out of
  // the attribute. Not reachable through the admin's own writers --
  // foodbankSlugForName strips everything but word characters and hyphens --
  // but the column has no constraint saying so, and this is the only defence
  // the cell has. Asserted as it behaves today; see this suite's report.
  it("does NOT escape the slug half of a row link", async () => {
    seedFoodbank({ id: 1, name: "Odd", slug: 'x" onmouseover="alert(1)' });

    expect(cells((await getList("/admin/foodbanks/")).ctx, 0)[0]).toBe('<a href="/admin/foodbank/x" onmouseover="alert(1)/">Odd</a>');
  });

  it("falls back to 0 donation points when the column is NULL", async () => {
    seedFoodbank({ id: 1, no_locations: 4, no_donation_points: null });

    const rendered = cells((await getList("/admin/foodbanks/")).ctx, 0);
    expect(rendered[4]).toBe("4");
    expect(rendered[5]).toBe("0");
  });

  it("names the New button and points at the CSV export", async () => {
    seedFoodbank({ id: 1 });
    const { ctx } = await getList("/admin/foodbanks/");

    // foodbanks.html:14 -- Django names the thing being created; a bare "New"
    // is the template's fallback for a caller that supplies no label.
    expect(ctx.new_label).toBe("New Foodbank");
    expect(ctx.new_url).toBe("/admin/foodbank/new/");
    expect(ctx.csv_url).toBe("/admin/foodbanks/csv/");
    expect(ctx.section).toBe("foodbanks");
    expect(ctx.title).toBe("Foodbanks");
    expect(ctx.row_actions).toBe(false);
  });

  describe("pagination", () => {
    // 101 open rows over a PAGE_SIZE of 100, so page 2 is a real page with a
    // real row on it. Page 1 must NOT contain that row: a LIMIT without its
    // OFFSET renders the first 100 rows on every page, and every "page 2
    // works" test that only checks the status code passes anyway.
    beforeEach(() => {
      for (let i = 1; i <= 101; i++) {
        const n = String(i).padStart(3, "0");
        seedFoodbank({ id: i, name: `FB ${n}`, slug: `fb-${n}`, edited: `2026-01-01 00:00:${n.slice(1)}` });
      }
      seedFoodbank({ id: 999, name: "Closed Bank", slug: "closed-bank", is_closed: 1 });
    });

    it("fills page one and reports that there is more", async () => {
      const { ctx } = await getList("/admin/foodbanks/?sort=name");

      expect(ctx.rows).toHaveLength(100);
      expect(ctx.page).toBe(1);
      expect(ctx.total).toBe(101);
      expect(ctx.total_pages).toBe(2);
      expect(ctx.has_next).toBe(true);
      expect(column(ctx, 0)[0]).toBe('<a href="/admin/foodbank/fb-001/">FB 001</a>');
      expect(column(ctx, 0)).not.toContain('<a href="/admin/foodbank/fb-101/">FB 101</a>');
    });

    it("offsets page two and reports that there is no more", async () => {
      const { ctx } = await getList("/admin/foodbanks/?sort=name&page=2");

      expect(ctx.rows).toHaveLength(1);
      expect(ctx.page).toBe(2);
      expect(ctx.has_next).toBe(false);
      expect(column(ctx, 0)).toEqual(['<a href="/admin/foodbank/fb-101/">FB 101</a>']);
    });

    // Every one of these is a URL a person can type or a crawler can invent.
    // Django's Paginator swallows them into page 1; parsePage does the same
    // rather than 500ing on a NaN OFFSET.
    it.each([
      ["?page=0", 1],
      ["?page=-4", 1],
      ["?page=abc", 1],
      ["?page=", 1],
      ["?page=2.9", 2], // parseInt stops at the "."
      ["?page=2abc", 2],
      ["?page=1e3", 1], // ...and at the "e", so this is page 1, not page 1000
    ])("treats %s as page %i", async (query, expected) => {
      const { ctx } = await getList(`/admin/foodbanks/${query}`);
      expect(ctx.page).toBe(expected);
    });

    // Past the end SQLite simply returns nothing. The template renders its
    // "None" row; the important part is that it is a 200 with an honest
    // has_next, not a 500 and not a silent bounce back to page 1 (which would
    // look like data loss to anyone deep-linking).
    it("renders an empty page beyond the end rather than failing", async () => {
      const { res, ctx } = await getList("/admin/foodbanks/?page=99");

      expect(res.status).toBe(200);
      expect(ctx.rows).toHaveLength(0);
      expect(ctx.total).toBe(101);
      expect(ctx.has_next).toBe(false);
    });
  });
});

// ===========================================================================
// /admin/foodbanks/csv/
// ===========================================================================
describe("adminFoodbanksCsv", () => {
  // THE divergence from the list page above, and the one an export is most
  // likely to lose in a refactor that "shares the query": views.py:326-337
  // exports ALL food banks, closed included.
  it("exports closed food banks too, unlike the list page", async () => {
    seedFoodbank({ id: 1, name: "Open Bank", slug: "open-bank", created: "2026-01-02 00:00:00" });
    seedFoodbank({ id: 2, name: "Closed Bank", slug: "closed-bank", is_closed: 1, created: "2026-01-03 00:00:00" });

    const body = await (await fetchPath("/admin/foodbanks/csv/")).text();
    const lines = csvLines(body);

    expect(lines).toHaveLength(3);
    // Ordered created DESC (views.py:329), so the newer row is first.
    expect(lines[1]).toContain("Closed Bank");
    expect(lines[2]).toContain("Open Bank");
  });

  // A frozen column contract: real people paste this into spreadsheets, so a
  // reordering is a silent break in someone else's workbook.
  it("writes Django's twelve columns in Django's order", async () => {
    seedFoodbank({
      id: 1,
      name: "Open Bank",
      slug: "open-bank",
      postcode: "SW1A 1AA",
      charity_number: "1188404",
      country: "England",
      last_order: "2026-08-01 00:00:00",
      last_need: "2026-08-02 00:00:00",
      no_locations: 3,
      network: "Trussell",
      url: "https://example.org/",
      created: "2026-01-02 00:00:00",
      modified: "2026-01-04 00:00:00",
    });

    const lines = csvLines(await (await fetchPath("/admin/foodbanks/csv/")).text());

    expect(lines[0]).toBe(
      "name,postcode,charity_number,country,last_order,last_need,no_locations,network,closed,url,created,modified",
    );
    expect(lines[1]).toBe(
      "Open Bank,SW1A 1AA,1188404,England,2026-08-01 00:00:00,2026-08-02 00:00:00,3,Trussell,False,https://example.org/,2026-01-02 00:00:00,2026-01-04 00:00:00",
    );
  });

  // mapFoodbankRow coerces is_closed to a JS boolean and formatCsvRow writes a
  // boolean as "True"/"False" -- which is what Python's csv writer produced
  // for a Django BooleanField. Losing the coercion would write 1/0 instead and
  // silently change the export's meaning.
  it("writes the closed flag as Python's True/False", async () => {
    seedFoodbank({ id: 1, name: "Closed Bank", slug: "closed-bank", is_closed: 1 });

    expect(csvLines(await (await fetchPath("/admin/foodbanks/csv/")).text())[1]).toContain(",True,");
  });

  it("quotes a value containing a comma", async () => {
    seedFoodbank({ id: 1, name: "Bath, Wiltshire Food Bank", slug: "bath" });

    expect(csvLines(await (await fetchPath("/admin/foodbanks/csv/")).text())[1]).toContain('"Bath, Wiltshire Food Bank"');
  });

  it("offers itself as a download, not as a page", async () => {
    seedFoodbank({ id: 1 });
    const res = await fetchPath("/admin/foodbanks/csv/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="foodbanks.csv"');
  });

  it("still writes the header row when there is nothing to export", async () => {
    const lines = csvLines(await (await fetchPath("/admin/foodbanks/csv/")).text());

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("name,postcode");
  });
});

// ===========================================================================
// /admin/foodbanks/next/ -- the check page's "Next" button.
// ===========================================================================
describe("adminFoodbanksNext", () => {
  it("sends the admin to the open food bank edited longest ago", async () => {
    seedFoodbank({ id: 1, name: "Recent", slug: "recent", edited: "2026-09-01 00:00:00" });
    seedFoodbank({ id: 2, name: "Stale", slug: "stale", edited: "2024-01-01 00:00:00" });

    const res = await fetchPath("/admin/foodbanks/next/");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/foodbank/stale/");
  });

  // The queue is a queue of work to do, and a closed food bank has none. Its
  // `edited` is usually ancient, so a missing filter would park the Next
  // button on the same dead row forever.
  it("skips closed food banks however stale they are", async () => {
    seedFoodbank({ id: 1, name: "Ancient Closed", slug: "ancient-closed", is_closed: 1, edited: "2019-01-01 00:00:00" });
    seedFoodbank({ id: 2, name: "Open", slug: "open", edited: "2026-01-01 00:00:00" });

    expect((await fetchPath("/admin/foodbanks/next/")).headers.get("Location")).toBe("/admin/foodbank/open/");
  });

  // views.py:361-366's own fallback. Only reachable with an empty table, which
  // is not a production state -- but a redirect to "/admin/foodbank/null/" is
  // the alternative, so it is worth having.
  it("falls back to the list when there is nothing to review", async () => {
    const res = await fetchPath("/admin/foodbanks/next/");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/foodbanks/");
  });

  // It is a GET, and it is the one route in this file whose name sounds like
  // it advances something. It must not: "Next" picks the next row to look at,
  // it does not mark the current one done.
  it("writes nothing on the way past", async () => {
    seedFoodbank({ id: 1, name: "Stale", slug: "stale", edited: "2024-01-01 00:00:00" });
    const before = db.prepare("SELECT * FROM foodbank").all();

    await fetchPath("/admin/foodbanks/next/");

    expect(db.prepare("SELECT * FROM foodbank").all()).toEqual(before);
  });
});

// ===========================================================================
// /admin/locations/
// ===========================================================================
describe("adminLocationsList", () => {
  it("opens A->Z by food bank name, as Django's raw sort key does", async () => {
    seedFoodbank({ id: 1, name: "Zebra Food Bank", slug: "zebra" });
    seedFoodbank({ id: 2, name: "Apple Food Bank", slug: "apple" });
    seedLocation({ id: 1, foodbank_id: 1, name: "Zebra Loc", slug: "zebra-loc" });
    seedLocation({ id: 2, foodbank_id: 2, name: "Apple Loc", slug: "apple-loc" });

    const { ctx } = await getList("/admin/locations/");

    expect(ctx.sort).toBe("foodbank_name");
    expect(column(ctx, 1)).toEqual([
      '<a href="/admin/foodbank/apple/location/apple-loc/edit/">Apple Loc</a>',
      '<a href="/admin/foodbank/zebra/location/zebra-loc/edit/">Zebra Loc</a>',
    ]);
  });

  // The one sort key on this page whose name is not its column: Django exposes
  // "parliamentary_constituency" (its model's FK name) while the only column
  // this schema kept is the denormalised parliamentary_constituency_name. The
  // rows are seeded so that constituency order and food-bank order DISAGREE --
  // a mapping that silently fell back to the default would otherwise produce
  // the same list and pass.
  it("sorts by the constituency NAME column when asked for parliamentary_constituency", async () => {
    seedFoodbank({ id: 1, name: "Apple Food Bank", slug: "apple" });
    seedFoodbank({ id: 2, name: "Zebra Food Bank", slug: "zebra" });
    seedLocation({ id: 1, foodbank_id: 1, name: "Apple Loc", slug: "apple-loc", parliamentary_constituency_name: "Yeovil" });
    seedLocation({ id: 2, foodbank_id: 2, name: "Zebra Loc", slug: "zebra-loc", parliamentary_constituency_name: "Aberdeen North" });

    const { ctx } = await getList("/admin/locations/?sort=parliamentary_constituency");

    expect(column(ctx, 3)).toEqual(["Aberdeen North", "Yeovil"]);
    expect(ctx.sort).toBe("parliamentary_constituency");
    // ...and the header still links by the key Django exposes, not by the
    // column it is translated into.
    expect(ctx.columns[3]).toEqual({
      label: "Parliamentary Constituency",
      sort: "-parliamentary_constituency",
      active: true,
      desc: false,
    });
  });

  // locations.html:51's bare `{{ location.is_closed }}` on a BooleanField:
  // Django stringifies the Python bool, so this column genuinely reads
  // True/False rather than a tick. Both branches asserted, because a cell that
  // always says "False" passes a test that only seeds open locations.
  it("prints the closed flag as Django's stringified bool, both ways", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    seedLocation({ id: 1, name: "Open Loc", slug: "open-loc", is_closed: 0 });
    seedLocation({ id: 2, name: "Shut Loc", slug: "shut-loc", is_closed: 1 });

    const { ctx } = await getList("/admin/locations/?sort=name");

    expect(column(ctx, 8)).toEqual(["False", "True"]); // "Open Loc" < "Shut Loc", so the closed one is second
    expect(column(ctx, 1)).toEqual([
      '<a href="/admin/foodbank/fb/location/open-loc/edit/">Open Loc</a>',
      '<a href="/admin/foodbank/fb/location/shut-loc/edit/">Shut Loc</a>',
    ]);
  });

  it("joins address and postcode into one cell, dropping whichever is missing", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    seedLocation({ id: 1, name: "Both", slug: "both", address: "1 High St", postcode: "SP1 1AA" });
    seedLocation({ id: 2, name: "No postcode", slug: "no-postcode", address: "2 High St", postcode: null });
    seedLocation({ id: 3, name: "Neither", slug: "neither", address: null, postcode: null });

    const { ctx } = await getList("/admin/locations/?sort=name");

    // Sorted by name: "Both", then "Neither" ("Ne" < "No"), then "No postcode".
    expect(column(ctx, 2)).toEqual(["1 High St SP1 1AA", "", "2 High St"]);
  });

  // `loc.mp_parl_id !== null ? String(...)` -- a `?:` on truthiness would
  // print an empty cell for MP id 0, and "0 is falsy" is exactly the sort of
  // thing that survives review.
  it("prints an MP id of 0 rather than blanking it", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    seedLocation({ id: 1, name: "Zero", slug: "zero", mp: "Nobody", mp_parl_id: 0 });
    seedLocation({ id: 2, name: "None", slug: "none", mp: null, mp_parl_id: null });

    const { ctx } = await getList("/admin/locations/?sort=name");

    expect(column(ctx, 5)).toEqual(["", "0"]); // "None" sorts before "Zero"
    expect(column(ctx, 4)).toEqual(["", "Nobody"]);
  });

  // MUTANT KILLED: `${direction === "desc" ? "DESC" : "ASC"}` in
  // getLocationsPage's ORDER BY pinned to a literal ASC. Every other test in
  // this describe asks for an ascending order -- Django's own sort_options on
  // this page are ascending-only (views.py:2146-2150) -- so nothing asserted
  // that the descending half the ported column headers now link to ever
  // reaches the query. The failure is silent: the header draws its
  // down-arrow, the URL says `-foodbank_name`, and the rows do not move.
  it("reverses the list when the header's descending link is followed", async () => {
    seedFoodbank({ id: 1, name: "Apple Food Bank", slug: "apple" });
    seedFoodbank({ id: 2, name: "Zebra Food Bank", slug: "zebra" });
    seedLocation({ id: 1, foodbank_id: 1, name: "Apple Loc", slug: "apple-loc" });
    seedLocation({ id: 2, foodbank_id: 2, name: "Zebra Loc", slug: "zebra-loc" });

    const { ctx } = await getList("/admin/locations/?sort=-foodbank_name");

    expect(ctx.sort).toBe("-foodbank_name");
    expect(column(ctx, 0)).toEqual([
      '<a href="/admin/foodbank/zebra/">Zebra Food Bank</a>',
      '<a href="/admin/foodbank/apple/">Apple Food Bank</a>',
    ]);
  });

  // locations.html/donationpoints.html print `{{ location.modified }}` with no
  // timesince line, unlike foodbanks.html's own date columns. Pinned so the
  // two do not get "harmonised" into one helper by accident.
  it("uses a plain date cell here, with no timesince line", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    seedLocation({ id: 1, modified: "2026-09-02 15:34:00", edited: null });

    const rendered = cells((await getList("/admin/locations/")).ctx, 0);
    expect(rendered[9]).toBe("Sept. 2, 2026, 3:34 p.m.");
    expect(rendered[9]).not.toContain("ago");
    expect(rendered[10]).toBe("");
  });

  it("lists no New button and no CSV export", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    seedLocation({ id: 1 });
    const { ctx } = await getList("/admin/locations/");

    expect(ctx.title).toBe("Locations");
    expect(ctx.section).toBe("locations");
    expect(ctx.new_url).toBeUndefined();
    expect(ctx.csv_url).toBeUndefined();
    expect(ctx.row_actions).toBe(false);
    // locations.html:18-21's four labels, in both directions.
    expect(ctx.sort_options?.map((o) => o.value)).toEqual([
      "foodbank_name",
      "-foodbank_name",
      "name",
      "-name",
      "parliamentary_constituency",
      "-parliamentary_constituency",
      "edited",
      "-edited",
    ]);
  });
});

// ===========================================================================
// /admin/donationpoints/
// ===========================================================================
describe("adminDonationPointsList", () => {
  it("opens A->Z by donation point name", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    seedDonationPoint({ id: 1, name: "Zebra Stores", slug: "zebra-stores" });
    seedDonationPoint({ id: 2, name: "Apple Stores", slug: "apple-stores" });

    const { ctx } = await getList("/admin/donationpoints/");

    expect(ctx.sort).toBe("name");
    expect(column(ctx, 1)).toEqual([
      '<a href="/admin/foodbank/fb/donationpoint/apple-stores/edit/">Apple Stores</a>',
      '<a href="/admin/foodbank/fb/donationpoint/zebra-stores/edit/">Zebra Stores</a>',
    ]);
  });

  // MUTANT KILLED: getDonationPointsPage's `ORDER BY ${sort} ${direction}`
  // replaced by a hardcoded `ORDER BY name ASC`. Every other test on this
  // page asks for `name` ascending -- the page's own default -- so a sort
  // argument that never reached the SQL produced exactly the right answer
  // every time. Three rows in three orders, because two rows only have two
  // permutations between them and the two sorts below would have been
  // indistinguishable.
  it("honours a sort key that is not its default, in both directions", async () => {
    seedFoodbank({ id: 1, name: "Apple Food Bank", slug: "apple" });
    seedFoodbank({ id: 2, name: "Medlar Food Bank", slug: "medlar" });
    seedFoodbank({ id: 3, name: "Zebra Food Bank", slug: "zebra" });
    seedDonationPoint({ id: 1, foodbank_id: 2, name: "Alpha Stores", slug: "alpha" });
    seedDonationPoint({ id: 2, foodbank_id: 1, name: "Beta Stores", slug: "beta" });
    seedDonationPoint({ id: 3, foodbank_id: 3, name: "Gamma Stores", slug: "gamma" });

    const names = (ctx: ListContext) => column(ctx, 1).map((cell) => /">([^<]*)<\/a>/.exec(cell)?.[1]);

    // The default: A->Z by donation point name.
    expect(names((await getList("/admin/donationpoints/")).ctx)).toEqual(["Alpha Stores", "Beta Stores", "Gamma Stores"]);
    // By food bank instead -- a different order, so a query that ignored the
    // key would fail here rather than coincide with the line above.
    expect(names((await getList("/admin/donationpoints/?sort=foodbank_name")).ctx)).toEqual(["Beta Stores", "Alpha Stores", "Gamma Stores"]);
    // ...and the descending direction the column headers link to, which no
    // Django sort_option on this page offers and nothing else here asserted.
    expect(names((await getList("/admin/donationpoints/?sort=-name")).ctx)).toEqual(["Gamma Stores", "Beta Stores", "Alpha Stores"]);
  });

  // The company cell is the only one on any of these pages that emits an
  // <img>, and its src is built from company_slug while its alt is the
  // escaped company name -- one escaped, one not, which is worth showing
  // side by side.
  it("renders the company logo and name together, and nothing at all without a company", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    seedDonationPoint({ id: 1, name: "A", slug: "a", company: "Sainsbury's", company_slug: "sainsburys", store_id: "STORE-1" });
    seedDonationPoint({ id: 2, name: "B", slug: "b", company: null, company_slug: null, store_id: null });

    const { ctx } = await getList("/admin/donationpoints/?sort=name");

    expect(column(ctx, 3)).toEqual([
      '<img src="/static/img/co/sainsburys.png" alt="Sainsbury&#39;s" class="companyicon"> Sainsbury&#39;s',
      "",
    ]);
    expect(column(ctx, 4)).toEqual(["STORE-1", ""]);
  });

  it("prints the closed flag as Django's stringified bool", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    seedDonationPoint({ id: 1, name: "Open DP", slug: "open-dp", is_closed: 0 });
    seedDonationPoint({ id: 2, name: "Shut DP", slug: "shut-dp", is_closed: 1 });

    // "Open DP" sorts before "Shut DP", so the closed one is the second row.
    expect(column((await getList("/admin/donationpoints/?sort=name")).ctx, 7)).toEqual(["False", "True"]);
  });

  it("offers donationpoints.html's three sort keys in both directions", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    seedDonationPoint({ id: 1 });
    const { ctx } = await getList("/admin/donationpoints/");

    expect(ctx.title).toBe("Donation Points");
    expect(ctx.section).toBe("donationpoints");
    expect(ctx.sort_options?.map((o) => o.value)).toEqual(["name", "-name", "foodbank_name", "-foodbank_name", "edited", "-edited"]);
    expect(ctx.sort_options?.[0]).toEqual({ value: "name", label: "Name", selected: true });
  });

  // The page is unfiltered: a closed donation point still appears (Django's
  // donationpoints() has no exclude()). Seeded so that adding a filter here
  // "for tidiness" fails rather than quietly hiding rows an admin needs to
  // find in order to reopen them.
  it("includes closed donation points", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    seedDonationPoint({ id: 1, name: "Shut DP", slug: "shut-dp", is_closed: 1 });

    const { ctx } = await getList("/admin/donationpoints/");
    expect(ctx.total).toBe(1);
    expect(ctx.rows).toHaveLength(1);
  });
});

// ===========================================================================
// /admin/politics/ and its CSV
// ===========================================================================
describe("adminParlconsList", () => {
  it("lists constituencies by name with the MP's photo and details", async () => {
    seedParlcon({ id: 1, name: "Yeovil", slug: "yeovil", mp: "Adam Dance", mp_party: "Liberal Democrat", mp_parl_id: 5087 });
    seedParlcon({ id: 2, name: "Aberdeen North", slug: "aberdeen-north", country: "Scotland", mp: "Kirsty Blackman", mp_party: "SNP", mp_parl_id: 4357 });

    const { ctx } = await getList("/admin/politics/");

    expect(column(ctx, 0)).toEqual(["Aberdeen North", "Yeovil"]);
    expect(cells(ctx, 0)[5]).toBe('<img src="https://photos.givefood.org.uk/2024-mp/4357.jpg" alt="Kirsty Blackman" width="50" loading="lazy">');
    expect(cells(ctx, 0).slice(1, 5)).toEqual(["Scotland", "Kirsty Blackman", "SNP", "4357"]);
  });

  // getParlconsPage deliberately does not SELECT boundary_geojson (rows reach
  // 1.5 MB) -- only whether it is set. So the map glyph is the only evidence
  // on this page that a boundary exists, and both states must be reachable.
  it("shows the map glyph only for a constituency that has a boundary", async () => {
    seedParlcon({ id: 1, name: "With", slug: "with", mp_parl_id: 1, boundary_geojson: '{"type":"Polygon"}' });
    seedParlcon({ id: 2, name: "Without", slug: "without", mp_parl_id: 2, boundary_geojson: null });

    expect(column((await getList("/admin/politics/")).ctx, 7)).toEqual(["\u{1F5FA}\u{FE0F}", ""]);
  });

  // This page has no sort control at all (Django's politics() hardcodes
  // order_by("name")). A `?sort=` that silently did something would be a
  // divergence; a `?sort=` that silently did nothing while the select claimed
  // otherwise would be worse. Neither: there is no select, and the order does
  // not move.
  it("ignores ?sort= entirely", async () => {
    seedParlcon({ id: 1, name: "Yeovil", slug: "yeovil", mp_parl_id: 1 });
    seedParlcon({ id: 2, name: "Aberdeen North", slug: "aberdeen-north", mp_parl_id: 2 });

    const { ctx } = await getList("/admin/politics/?sort=-name");

    expect(ctx.sort).toBeUndefined();
    expect(ctx.sort_options).toBeUndefined();
    expect(column(ctx, 0)).toEqual(["Aberdeen North", "Yeovil"]);
    expect(ctx.columns.every((col) => col.sort === undefined)).toBe(true);
  });

  it("gives every row an Edit button and the page a New ParlCon button", async () => {
    seedParlcon({ id: 1, name: "Yeovil", slug: "yeovil", mp_parl_id: 1 });
    const { ctx } = await getList("/admin/politics/");

    expect(ctx.row_actions).toBe(true);
    expect(cells(ctx, 0).length).toBe(8);
    expect(ctx.rows[0]!.actions).toBe('<a href="/admin/parlcon/yeovil/edit/" class="button is-small is-light">Edit</a>');
    expect(ctx.new_url).toBe("/admin/parlcon/new/");
    expect(ctx.new_label).toBe("New ParlCon"); // politics.html:14
    expect(ctx.csv_url).toBe("/admin/politics/csv/");
    // Django's politics() sets section "politics"; this port files the page
    // under "settings", which is what highlights in the port's own nav.
    expect(ctx.section).toBe("settings");
  });

  it("handles a constituency with no name, MP or email without blowing up", async () => {
    seedParlcon({ id: 1, name: null, slug: "unnamed", country: null, mp: null, mp_party: null, mp_parl_id: 7, email: null });

    const rendered = cells((await getList("/admin/politics/")).ctx, 0);
    expect(rendered.slice(0, 5)).toEqual(["", "", "", "", "7"]);
    expect(rendered[5]).toBe('<img src="https://photos.givefood.org.uk/2024-mp/7.jpg" alt="" width="50" loading="lazy">');
    expect(rendered[6]).toBe("");
  });
});

describe("adminParlconsCsv", () => {
  // views.py:2322-2336 exports the DENORMALISED political fields cached on
  // Foodbank and FoodbankLocation -- not the ParliamentaryConstituency table
  // this page otherwise shows. Both querysets, back to back, with no dedup.
  // Seeding a parlcon row that must NOT appear is the point: an export
  // "corrected" to read the obvious table would look more sensible and break
  // every spreadsheet built on it.
  it("exports the food bank and location rows, not the constituency table", async () => {
    seedParlcon({ id: 1, name: "Never Exported", slug: "never-exported", mp: "Nobody", mp_party: "None", mp_parl_id: 99 });
    seedFoodbank({
      id: 1,
      name: "FB",
      slug: "fb",
      parliamentary_constituency_name: "Yeovil",
      mp: "Adam Dance",
      mp_party: "Liberal Democrat",
      mp_parl_id: 5087,
    });
    seedLocation({
      id: 1,
      foodbank_id: 1,
      parliamentary_constituency_name: "Glastonbury and Somerton",
      mp: "Sarah Dyke",
      mp_party: "Liberal Democrat",
      mp_parl_id: 5077,
    });

    const lines = csvLines(await (await fetchPath("/admin/politics/csv/")).text());

    expect(lines).toEqual([
      "constituency,mp,mp_party,mp_parl_id",
      "Yeovil,Adam Dance,Liberal Democrat,5087",
      "Glastonbury and Somerton,Sarah Dyke,Liberal Democrat,5077",
    ]);
    expect(lines.join("\n")).not.toContain("Never Exported");
  });

  it("emits an empty-celled row for a food bank with no constituency, rather than skipping it", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });

    expect(csvLines(await (await fetchPath("/admin/politics/csv/")).text())[1]).toBe(",,,");
  });

  it("offers itself as politics.csv", async () => {
    const res = await fetchPath("/admin/politics/csv/");

    expect(res.headers.get("Content-Type")).toBe("text/csv");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="politics.csv"');
  });
});

// ===========================================================================
// /admin/orders/ and its CSV
// ===========================================================================
describe("adminOrdersList", () => {
  it("defaults to newest delivery first and always sorts descending", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    seedOrder({ id: 1, order_id: "OLD", delivery_datetime: "2026-01-01 09:00:00" });
    seedOrder({ id: 2, order_id: "NEW", delivery_datetime: "2026-06-01 09:00:00" });

    const { ctx } = await getList("/admin/orders/");

    expect(ctx.sort).toBe("delivery_datetime");
    expect(column(ctx, 0)).toEqual(['<a href="/admin/order/NEW/">NEW</a>', '<a href="/admin/order/OLD/">OLD</a>']);
  });

  // views.py:382-383 does `sort = "-%s" % (sort)`, so EVERY option on this one
  // page is descending -- there is no ascending order to reach. The other list
  // pages carry the direction separately; this one must not grow one by
  // accident.
  it("sorts descending even when the admin picks a different key", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    seedOrder({ id: 1, order_id: "LIGHT", weight: 1000 });
    seedOrder({ id: 2, order_id: "HEAVY", weight: 900000 });

    expect(column((await getList("/admin/orders/?sort=weight")).ctx, 0)).toEqual([
      '<a href="/admin/order/HEAVY/">HEAVY</a>',
      '<a href="/admin/order/LIGHT/">LIGHT</a>',
    ]);
  });

  // Consequence of the above: this page's allowlist takes the BARE key only,
  // so a signed key -- which every other list page here accepts -- is not
  // recognised and falls back to the default. Pinned because the inconsistency
  // is deliberate (it matches Django) and looks like a bug otherwise.
  it("does not understand a signed sort key, and falls back to delivery_datetime", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    seedOrder({ id: 1, order_id: "OLD", delivery_datetime: "2026-01-01 09:00:00", weight: 900000 });
    seedOrder({ id: 2, order_id: "NEW", delivery_datetime: "2026-06-01 09:00:00", weight: 1000 });

    const { ctx } = await getList("/admin/orders/?sort=-weight");

    expect(ctx.sort).toBe("delivery_datetime");
    expect(column(ctx, 0)[0]).toBe('<a href="/admin/order/NEW/">NEW</a>');
  });

  it("falls back for an unknown key too, without 403ing", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    seedOrder({ id: 1 });

    const { res, ctx } = await getList("/admin/orders/?sort=nonsense");
    expect(res.status).toBe(200);
    expect(ctx.sort).toBe("delivery_datetime");
  });

  // descOnlyColumn: the link is the bare field (the same value orders.html's
  // own <select> offers) and `desc` is true on every sortable header, active
  // or not -- the template only draws the arrow for the active one, so the
  // flag is only ever read there.
  it("links its sortable headers by bare field name, always marked descending", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    seedOrder({ id: 1 });
    const { ctx } = await getList("/admin/orders/?sort=cost");

    expect(ctx.columns[8]).toEqual({ label: "Cost", sort: "cost", active: true, desc: true });
    expect(ctx.columns[4]).toEqual({ label: "Delivery", sort: "delivery_datetime", active: false, desc: true });
    // Four of the eleven headers are not sortable at all on this page.
    expect(ctx.columns.filter((col) => col.sort === undefined).map((col) => col.label)).toEqual([
      "ID",
      "Foodbank",
      "Del. Prov. ID",
      "Country",
      "Delivered Cost",
    ]);
  });

  it("prices an order in pounds and blanks an unknown delivered cost", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    seedOrder({ id: 1, order_id: "A", cost: 12345, actual_cost: 13000 });
    seedOrder({ id: 2, order_id: "B", cost: 500, actual_cost: null, delivery_datetime: "2026-01-01 09:00:00" });

    const { ctx } = await getList("/admin/orders/");

    expect(column(ctx, 8)).toEqual(["£123.45", "£5.00"]);
    expect(column(ctx, 9)).toEqual(["£130.00", ""]);
  });

  // A DELIBERATE DIVERGENCE, pinned so nobody "fixes" it back. orders.html:57
  // chains |intcomma|floatformat:2, and once intcomma has inserted a separator
  // floatformat can parse neither Decimal("1,180.00") nor float("1,180.00") --
  // so Django BLANKS the Weight cell of every order of 1000 kg or more. This
  // port formats first and separates second, which is the order
  // order_group.njk already uses for the same value, so the same order reads
  // the same on both pages.
  it("shows a weight Django's own template would have blanked", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    seedOrder({ id: 1, order_id: "BIG", weight: 1000000 }); // 1000 kg, x1.18 packaging

    expect(cells((await getList("/admin/orders/")).ctx, 0)[6]).toBe("1,180.00");
  });

  it("applies the 1.18 packaging factor to a sub-tonne order", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    seedOrder({ id: 1, weight: 100000 }); // 100 kg

    expect(cells((await getList("/admin/orders/")).ctx, 0)[6]).toBe("118.00");
  });

  // A null foodbank_id is real: orders arrive before they are matched. Django
  // writes "Unassigned" inline, and this cell must not become a link to
  // /admin/foodbank/null/.
  it("marks an unassigned order rather than linking it to nothing", async () => {
    seedOrder({ id: 1, foodbank_id: null });

    expect(cells((await getList("/admin/orders/")).ctx, 0)[1]).toBe("<em>Unassigned</em>");
  });

  it("percent-encodes the order id in its link but escapes it in the label", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    seedOrder({ id: 1, order_id: "A/B & C" });

    expect(cells((await getList("/admin/orders/")).ctx, 0)[0]).toBe('<a href="/admin/order/A%2FB%20%26%20C/">A/B &amp; C</a>');
  });

  it("thousand-separates calories and prints the raw item count", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    seedOrder({ id: 1, calories: 1234567, no_items: 42 });

    const rendered = cells((await getList("/admin/orders/")).ctx, 0);
    expect(rendered[5]).toBe("42");
    expect(rendered[7]).toBe("1,234,567");
  });

  it("offers orders.html's six one-directional sort options and no New button", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    seedOrder({ id: 1 });
    const { ctx } = await getList("/admin/orders/");

    expect(ctx.sort_options).toEqual([
      { value: "delivery_datetime", label: "Delivery Date", selected: true },
      { value: "created", label: "Created", selected: false },
      { value: "no_items", label: "Items", selected: false },
      { value: "weight", label: "Weight", selected: false },
      { value: "calories", label: "Calories", selected: false },
      { value: "cost", label: "Cost", selected: false },
    ]);
    // Order CREATE/EDIT is deferred (WP 6.5b), so this page is read-only --
    // no New button, and no per-row Edit.
    expect(ctx.new_url).toBeUndefined();
    expect(ctx.row_actions).toBe(false);
    expect(ctx.csv_url).toBe("/admin/orders/csv/");
    expect(ctx.section).toBe("orders");
  });
});

describe("adminOrdersCsv", () => {
  // Another frozen column contract, and one whose units differ from the list
  // page above on purpose: the CSV writes raw grams and raw pence, which is
  // what Django's writer put there.
  it("writes Django's eleven columns, in raw units", async () => {
    seedFoodbank({ id: 1, name: "Salisbury Food Bank", slug: "salisbury" });
    seedOrder({
      id: 1,
      order_id: "ORD-9",
      created: "2026-04-01 09:00:00",
      delivery_datetime: "2026-04-03 09:00:00",
      delivery_provider: "Tesco",
      country: "England",
      weight: 100000,
      calories: 250000,
      no_items: 42,
      cost: 12345,
      actual_cost: 13000,
    });

    const lines = csvLines(await (await fetchPath("/admin/orders/csv/")).text());

    expect(lines[0]).toBe("id,created,delivery,delivery_provider,foodbank,country,weight,calories,items,cost,delivered_cost");
    expect(lines[1]).toBe("ORD-9,2026-04-01 09:00:00,2026-04-03 09:00:00,Tesco,Salisbury Food Bank,England,100000,250000,42,12345,13000");
  });

  it("writes Unassigned for an order with no food bank", async () => {
    seedOrder({ id: 1, order_id: "ORD-9", foodbank_id: null });

    expect(csvLines(await (await fetchPath("/admin/orders/csv/")).text())[1]).toContain(",Unassigned,");
  });

  it("orders the export by creation date, newest first", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    seedOrder({ id: 1, order_id: "FIRST", created: "2026-01-01 09:00:00" });
    seedOrder({ id: 2, order_id: "SECOND", created: "2026-02-01 09:00:00" });

    const lines = csvLines(await (await fetchPath("/admin/orders/csv/")).text());
    expect(lines[1]?.startsWith("SECOND,")).toBe(true);
    expect(lines[2]?.startsWith("FIRST,")).toBe(true);
  });

  it("offers itself as orders.csv", async () => {
    const res = await fetchPath("/admin/orders/csv/");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="orders.csv"');
  });
});

// ===========================================================================
// /admin/needs/csv/
// ===========================================================================
describe("adminNeedsCsv", () => {
  // views.py:431-442 exports EVERY need, published or not -- unlike the review
  // queue and unlike /admin/needs/'s own 200-row cap. Seeding an unpublished
  // need is how "unfiltered" gets tested at all.
  it("exports unpublished needs as well as published ones, newest first", async () => {
    seedFoodbank({ id: 1, name: "Salisbury Food Bank", slug: "salisbury" });
    seedNeed({ id: 1, need_id: "aaaaaaaa-0000-0000-0000-000000000001", change_text: "Beans", published: 1, created: "2026-03-01 09:00:00" });
    seedNeed({ id: 2, need_id: "bbbbbbbb-0000-0000-0000-000000000002", change_text: "Pasta", published: 0, created: "2026-03-02 09:00:00" });

    const lines = csvLines(await (await fetchPath("/admin/needs/csv/")).text());

    expect(lines[0]).toBe("id,created,foodbank,needs,excess,input_method");
    expect(lines[1]).toBe("bbbbbbbb-0000-0000-0000-000000000002,2026-03-02 09:00:00,Salisbury Food Bank,Pasta,,scrape");
    expect(lines[2]).toBe("aaaaaaaa-0000-0000-0000-000000000001,2026-03-01 09:00:00,Salisbury Food Bank,Beans,,scrape");
  });

  // Need text is multi-line by nature ("Beans\nPasta\nRice"), and a CSV cell
  // containing a newline MUST be quoted or the row splits in two in every
  // spreadsheet that opens it.
  it("quotes a need whose text spans several lines", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    seedNeed({ id: 1, change_text: "Beans\nPasta", excess_change_text: "Baked beans, tinned" });

    const body = await (await fetchPath("/admin/needs/csv/")).text();
    expect(body).toContain('"Beans\nPasta"');
    expect(body).toContain('"Baked beans, tinned"');
  });

  // The food bank name comes from foodbankchange_full's LEFT JOIN, so a need
  // with no food bank exports an empty cell rather than failing the join away.
  it("keeps an unassigned need in the export", async () => {
    seedNeed({ id: 1, foodbank_id: null, change_text: "Beans" });

    expect(csvLines(await (await fetchPath("/admin/needs/csv/")).text())[1]).toBe(
      "11111111-1111-1111-1111-111111111111,2026-03-01 09:00:00,,Beans,,scrape",
    );
  });

  it("offers itself as needs.csv", async () => {
    const res = await fetchPath("/admin/needs/csv/");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="needs.csv"');
  });
});

// ===========================================================================
// /admin/places/
// ===========================================================================
describe("adminPlacesList", () => {
  it("opens A->Z by place name and separates the population", async () => {
    seedPlace({ id: 1, gbpnid: 1, name: "Yeovil", name_slug: "yeovil", county: "Somerset", population: 45784 });
    seedPlace({ id: 2, gbpnid: 2, name: "Aberdeen", name_slug: "aberdeen", county: "Aberdeen City", population: 198590 });

    const { ctx } = await getList("/admin/places/");

    expect(ctx.sort).toBe("name");
    expect(column(ctx, 0)).toEqual(["Aberdeen", "Yeovil"]);
    expect(column(ctx, 3)).toEqual(["198,590", "45,784"]);
  });

  // The names DISAGREE with the populations on purpose. This test used to
  // seed "Small" (100) and "Big" (900000), and A->Z on those names is Big
  // then Small -- the same order sorting by population descending produces.
  // MUTANT KILLED with the fixture below: getPlacesPage's
  // `ORDER BY ${sort} ${direction}` replaced by a hardcoded `ORDER BY name
  // ASC`, i.e. the sort key never reaching the query at all. The old fixture
  // let that mutant pass; alphabetically-first-but-smallest catches it.
  it("sorts descending by population when asked, not alphabetically", async () => {
    seedPlace({ id: 1, gbpnid: 1, name: "Aberystwyth", name_slug: "aberystwyth", population: 13000 });
    seedPlace({ id: 2, gbpnid: 2, name: "Birmingham", name_slug: "birmingham", population: 1144000 });

    const { ctx } = await getList("/admin/places/?sort=-population");

    expect(ctx.sort).toBe("-population");
    expect(column(ctx, 0)).toEqual(["Birmingham", "Aberystwyth"]);
    // ...and the same two rows the other way up under the page's default,
    // which is what makes the line above evidence of anything.
    expect(column((await getList("/admin/places/")).ctx, 0)).toEqual(["Aberystwyth", "Birmingham"]);
  });

  // `p.population !== null` rather than a truthiness test: a genuinely
  // zero-population place would otherwise show an empty cell that reads as
  // "unknown".
  it("prints a zero population but blanks a null one", async () => {
    seedPlace({ id: 1, gbpnid: 1, name: "Empty", name_slug: "empty", population: 0 });
    seedPlace({ id: 2, gbpnid: 2, name: "Unknown", name_slug: "unknown", population: null });

    expect(column((await getList("/admin/places/?sort=name")).ctx, 3)).toEqual(["0", ""]);
  });

  // Two deliberate omissions from places.html's six columns, both documented
  // in lists.ts: Django's "Type" cell has no D1 column after the §4.8.7 trim,
  // and there is no Edit button because PlaceForm is deferred and the route it
  // would point at does not exist. Pinned so a later "the columns don't match
  // Django" report can be closed by reading this rather than by adding a
  // column with nothing behind it.
  it("renders four columns and no per-row Edit button", async () => {
    seedPlace({ id: 1, gbpnid: 1 });
    const { ctx } = await getList("/admin/places/");

    expect(ctx.columns.map((col) => col.label)).toEqual(["Name", "Lat,Lng", "County", "Population"]);
    expect(ctx.row_actions).toBe(false);
    expect(ctx.new_url).toBeUndefined();
    expect(ctx.csv_url).toBeUndefined();
    expect(ctx.section).toBe("settings");
    // "Lat,Lng" is places.html:30's own column and is not one of the view's
    // sort options, so it carries no link.
    expect(ctx.columns[1]).toEqual({ label: "Lat,Lng" });
  });

  it("offers views.py:3030-3037's own six options", async () => {
    seedPlace({ id: 1, gbpnid: 1 });
    const { ctx } = await getList("/admin/places/?sort=-county");

    expect(ctx.sort_options).toEqual([
      { value: "name", label: "Name", selected: false },
      { value: "-name", label: "Name (Desc)", selected: false },
      { value: "county", label: "County", selected: false },
      { value: "-county", label: "County (Desc)", selected: true },
      { value: "population", label: "Population", selected: false },
      { value: "-population", label: "Population (Desc)", selected: false },
    ]);
  });
});

// ===========================================================================
// /admin/subscriptions/
// ===========================================================================
describe("adminSubscriptionsList", () => {
  // One of each kind, plus the two rows that must NEVER appear.
  function seedEveryKind(): void {
    seedFoodbank({ id: 1, name: "Salisbury Food Bank", slug: "salisbury" });
    insert("foodbanksubscriber", {
      id: 1,
      created: "2026-05-01 09:00:00",
      foodbank_id: 1,
      email: "confirmed@example.org",
      confirmed: 1,
      sub_key: "s1",
      unsub_key: "u1",
    });
    // views.py:2895 filters confirmed=True. An unconfirmed address is somebody
    // who has not agreed to be emailed; showing it here would be the admin
    // reading a list of people it must not contact.
    insert("foodbanksubscriber", {
      id: 2,
      created: "2026-05-02 09:00:00",
      foodbank_id: 1,
      email: "unconfirmed@example.org",
      confirmed: 0,
      sub_key: "s2",
      unsub_key: "u2",
    });
    insert("mobilesubscriber", { id: 3, created: "2026-05-03 09:00:00", device_id: "device-3", platform: "iOS", foodbank_id: 1 });
    insert("webpushsubscription", {
      id: 4,
      created: "2026-05-04 09:00:00",
      foodbank_id: 1,
      endpoint: "https://push.example.org/4",
      p256dh: "p",
      auth: "a",
      browser: "Firefox",
    });
    // A subscription whose food bank no longer exists: the UNION's JOIN is an
    // INNER JOIN, so it is dropped. Seeded so that a JOIN degraded to LEFT
    // starts rendering a row whose Foodbank cell links to /admin/foodbank//.
    insert("mobilesubscriber", { id: 5, created: "2026-05-05 09:00:00", device_id: "orphan", platform: "Android", foodbank_id: 404 });
  }

  it("shows one row per confirmed subscription, newest first, across all three kinds", async () => {
    seedEveryKind();
    const { ctx } = await getList("/admin/subscriptions/");

    expect(ctx.total).toBe(3);
    expect(column(ctx, 1)).toEqual(["Firefox - https://push.example.org/4", "iOS - device-3", "confirmed@example.org"]);
    expect(column(ctx, 0)).toEqual([
      '<span class="mdi mdi-bell"></span> Webpush',
      '<span class="mdi mdi-cellphone"></span> Mobile',
      '<span class="mdi mdi-email"></span> Email',
    ]);
  });

  it("leaves out the unconfirmed email subscriber and the orphaned device", async () => {
    seedEveryKind();
    const { ctx } = await getList("/admin/subscriptions/");

    expect(column(ctx, 1).join("|")).not.toContain("unconfirmed@example.org");
    expect(column(ctx, 1).join("|")).not.toContain("orphan");
  });

  // The filter test that matters: every ?type= is asserted against a database
  // that holds all three kinds, so a branch that stopped filtering shows rows
  // it should not rather than passing on an empty table.
  it.each([
    ["email", ["confirmed@example.org"]],
    ["mobile", ["iOS - device-3"]],
    ["webpush", ["Firefox - https://push.example.org/4"]],
  ])("shows only %s subscriptions when filtered to that type", async (type, expected) => {
    seedEveryKind();
    const { ctx } = await getList(`/admin/subscriptions/?type=${type}`);

    expect(column(ctx, 1)).toEqual(expected);
    expect(ctx.total).toBe(1);
  });

  // "whatsapp" is a valid type in Django (views.py:3002) but there is no
  // whatsappsubscriber row source in getSubscriptionsPage, so it is not
  // offered here -- and an unrecognised value must not produce an empty page
  // that looks like "no subscriptions".
  it("falls back to all for an unrecognised type, including whatsapp", async () => {
    seedEveryKind();
    const { ctx } = await getList("/admin/subscriptions/?type=whatsapp");

    expect(ctx.total).toBe(3);
    expect(ctx.extra_query).toBe("&type=all");
    expect(ctx.filter_options?.find((opt) => opt.selected)).toEqual({ value: "?type=all", label: "All", selected: true });
  });

  it("marks the current type in the filter select and carries it into the paginator", async () => {
    seedEveryKind();
    const { ctx } = await getList("/admin/subscriptions/?type=mobile");

    expect(ctx.filter_options).toEqual([
      { value: "?type=all", label: "All", selected: false },
      { value: "?type=email", label: "\u{1F4E7} Email", selected: false },
      { value: "?type=mobile", label: "\u{1F4F1} Mobile", selected: true },
      { value: "?type=webpush", label: "\u{1F514} WebPush", selected: false },
    ]);
    // Without this the Next link drops the filter and page 2 of "mobile" is
    // page 2 of everything.
    expect(ctx.extra_query).toBe("&type=mobile");
  });

  // views.py:2940/2960's truncation, with the "..." only when something was
  // actually cut -- otherwise a whole endpoint reads as if it had been
  // clipped, on the page whose job is identifying a row before deleting it.
  it("truncates a long device id and endpoint, and leaves a short one alone", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    insert("mobilesubscriber", { id: 1, created: "2026-05-01 09:00:00", device_id: "x".repeat(20), platform: "iOS", foodbank_id: 1 });
    insert("mobilesubscriber", { id: 2, created: "2026-05-02 09:00:00", device_id: "y".repeat(21), platform: "iOS", foodbank_id: 1 });
    insert("webpushsubscription", {
      id: 3,
      created: "2026-05-03 09:00:00",
      foodbank_id: 1,
      endpoint: "z".repeat(31),
      p256dh: "p",
      auth: "a",
      browser: "Chrome",
    });

    const { ctx } = await getList("/admin/subscriptions/");

    expect(column(ctx, 1)).toEqual([
      `Chrome - ${"z".repeat(30)}...`,
      `iOS - ${"y".repeat(20)}...`,
      `iOS - ${"x".repeat(20)}`, // exactly 20: not cut, so no ellipsis
    ]);
  });

  // views.py:2964's `sub.browser or 'Unknown'` is Python truthiness, so an
  // EMPTY STRING is 'Unknown' too. A plain COALESCE would render " - endpoint"
  // with nothing in front of it.
  it("calls a browserless webpush subscription Unknown, for NULL and for empty string alike", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    insert("webpushsubscription", { id: 1, created: "2026-05-01 09:00:00", foodbank_id: 1, endpoint: "https://a/", p256dh: "p", auth: "a", browser: null });
    insert("webpushsubscription", { id: 2, created: "2026-05-02 09:00:00", foodbank_id: 1, endpoint: "https://b/", p256dh: "p", auth: "a", browser: "" });

    expect(column((await getList("/admin/subscriptions/")).ctx, 1)).toEqual(["Unknown - https://b/", "Unknown - https://a/"]);
  });

  // The delete button's identity: an email subscription has no single id, so
  // the row key is the (email, foodbank slug) pair the DELETE actually needs.
  it("keys an email row by email|slug and the others by their row id", async () => {
    seedEveryKind();
    const { ctx } = await getList("/admin/subscriptions/");

    expect(ctx.row_actions).toBe(true);
    expect(ctx.rows.map((row) => /name="row_id" value="([^"]*)"/.exec(row.actions)?.[1])).toEqual([
      "4",
      "3",
      "confirmed@example.org|salisbury",
    ]);
    expect(ctx.rows.map((row) => /name="type" value="([^"]*)"/.exec(row.actions)?.[1])).toEqual(["webpush", "mobile", "email"]);
  });

  // renderList builds the token ONCE and hands the same string to every row.
  // issueCsrfToken mints a fresh token+cookie pair per call, so a version that
  // called it per row would leave every button but the last carrying a token
  // that no longer matches the cookie -- and every Delete but one would 403.
  it("gives every row the same CSRF token the page itself was issued", async () => {
    seedEveryKind();
    const { ctx } = await getList("/admin/subscriptions/");

    const tokens = ctx.rows.map((row) => /name="csrf_token" value="([^"]*)"/.exec(row.actions)?.[1]);
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).toBe(ctx.csrf_token);
    expect(ctx.csrf_token).toMatch(/^[0-9a-f]{64}$/);
  });

  // subscriptions.html:50 names the row in the confirm dialog. The identifier
  // travels as a data attribute read back through this.dataset -- never
  // interpolated into the JS string literal -- because an apostrophe in an
  // address (o'brien@) would otherwise terminate it and break the button.
  it("carries an apostrophe in the confirm dialog without breaking the script", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    insert("foodbanksubscriber", {
      id: 1,
      created: "2026-05-01 09:00:00",
      foodbank_id: 1,
      email: "o'brien@example.org",
      confirmed: 1,
      sub_key: "s1",
      unsub_key: "u1",
    });

    const actions = (await getList("/admin/subscriptions/")).ctx.rows[0]!.actions;

    expect(actions).toContain(`data-identifier="o&#39;brien@example.org"`);
    expect(actions).toContain("confirm('Delete ' + this.dataset.identifier + '?')");
    expect(actions).not.toContain("confirm('Delete o'brien");
  });

  // MUTANTS KILLED, three of them, all of the same shape: escapeHtml()
  // dropped from the identifier cell, from the food bank cell, and from the
  // row_id hidden field. list.njk renders every cell with `{{ cell | safe }}`
  // so escaping is the handler's job and nothing downstream re-checks it --
  // and on THIS page the value is not a food bank name an admin typed, it is
  // whatever the public entered in the subscribe form. The row_id case is the
  // worst of the three and the least visible: a quote in the address ends the
  // value attribute early, so the Delete button silently posts a TRUNCATED
  // key, which either deletes nothing or (with the "|slug" half gone) is a
  // different row's key entirely.
  it("escapes the identifier, the food bank name and the delete key", async () => {
    seedFoodbank({ id: 1, name: `Ben & Jerry's <b>Bank</b>`, slug: "bens" });
    insert("foodbanksubscriber", {
      id: 1,
      created: "2026-05-01 09:00:00",
      foodbank_id: 1,
      email: `a"<b>&'@example.org`,
      confirmed: 1,
      sub_key: "s1",
      unsub_key: "u1",
    });

    const { ctx } = await getList("/admin/subscriptions/");
    const rendered = cells(ctx, 0);

    expect(rendered[1]).toBe("a&quot;&lt;b&gt;&amp;&#39;@example.org");
    expect(rendered[2]).toBe('<a href="/admin/foodbank/bens/">Ben &amp; Jerry&#39;s &lt;b&gt;Bank&lt;/b&gt;</a>');
    expect(ctx.rows[0]!.actions).toContain('name="row_id" value="a&quot;&lt;b&gt;&amp;&#39;@example.org|bens"');
  });

  // MUTANTS KILLED: the form's action changed to /admin/subscriptions/remove/
  // (a route nothing registers, so the button 404s and the row stays), and
  // its method flipped to GET (which the POST-only route also 404s, after
  // putting a subscriber's email address in a URL). Both render a page that
  // looks exactly right, and the existing tests here only read the form's
  // INPUTS -- the token, the type, the row id -- never where it submits them.
  it("posts its Delete form at the route that handles it", async () => {
    seedEveryKind();

    const actions = (await getList("/admin/subscriptions/")).ctx.rows[0]!.actions;

    expect(actions).toContain('<form method="post" action="/admin/subscriptions/delete/"');
  });

  it("has no New button, no CSV export and no sort control", async () => {
    seedEveryKind();
    const { ctx } = await getList("/admin/subscriptions/");

    expect(ctx.title).toBe("Subscriptions");
    expect(ctx.section).toBe("settings");
    expect(ctx.columns.map((col) => col.label)).toEqual(["Type", "Identifier", "Foodbank", "Created"]);
    expect(ctx.new_url).toBeUndefined();
    expect(ctx.csv_url).toBeUndefined();
    expect(ctx.sort).toBeUndefined();
    expect(ctx.sort_options).toBeUndefined();
  });

  it("does not delete anything just by being looked at", async () => {
    seedEveryKind();
    await fetchPath("/admin/subscriptions/");

    expect(subscriberCount("foodbanksubscriber")).toBe(2);
    expect(subscriberCount("mobilesubscriber")).toBe(2);
    expect(subscriberCount("webpushsubscription")).toBe(1);
  });
});

// ===========================================================================
// POST /admin/subscriptions/delete/ -- the one write in this module.
// ===========================================================================
describe("adminDeleteSubscription", () => {
  beforeEach(() => {
    seedFoodbank({ id: 1, name: "Salisbury Food Bank", slug: "salisbury" });
    seedFoodbank({ id: 2, name: "Yeovil Food Bank", slug: "yeovil" });
    insert("foodbanksubscriber", { id: 1, created: "2026-05-01 09:00:00", foodbank_id: 1, email: "a@example.org", confirmed: 1, sub_key: "s1", unsub_key: "u1" });
    // The SAME address subscribed to a DIFFERENT food bank. The delete key is
    // the pair, and a DELETE that dropped the foodbank_id predicate would
    // unsubscribe this person from everything with one click.
    insert("foodbanksubscriber", { id: 2, created: "2026-05-02 09:00:00", foodbank_id: 2, email: "a@example.org", confirmed: 1, sub_key: "s2", unsub_key: "u2" });
    insert("mobilesubscriber", { id: 3, created: "2026-05-03 09:00:00", device_id: "device-3", platform: "iOS", foodbank_id: 1 });
    insert("webpushsubscription", { id: 4, created: "2026-05-04 09:00:00", foodbank_id: 1, endpoint: "https://push/4", p256dh: "p", auth: "a", browser: "Firefox" });
  });

  function emails(): { id: number; foodbank_id: number }[] {
    return db.prepare("SELECT id, foodbank_id FROM foodbanksubscriber ORDER BY id").all() as never;
  }

  it("deletes exactly the (email, food bank) pair it was given", async () => {
    const res = await post("/admin/subscriptions/delete/", { csrf_token: CSRF_RAW, type: "email", row_id: "a@example.org|salisbury" });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/subscriptions/");
    // The row went, and only that row: the same address on Yeovil survives.
    expect(emails()).toEqual([{ id: 2, foodbank_id: 2 }]);
  });

  it("deletes a mobile subscription by id and leaves everything else alone", async () => {
    const res = await post("/admin/subscriptions/delete/", { csrf_token: CSRF_RAW, type: "mobile", row_id: "3" });

    expect(res.status).toBe(302);
    expect(subscriberCount("mobilesubscriber")).toBe(0);
    expect(subscriberCount("foodbanksubscriber")).toBe(2);
    expect(subscriberCount("webpushsubscription")).toBe(1);
  });

  it("deletes a webpush subscription by id", async () => {
    await post("/admin/subscriptions/delete/", { csrf_token: CSRF_RAW, type: "webpush", row_id: "4" });

    expect(subscriberCount("webpushsubscription")).toBe(0);
    expect(subscriberCount("mobilesubscriber")).toBe(1);
  });

  describe("CSRF", () => {
    // WP 6.2's double-submit design. Each of these is a request an attacker's
    // page can actually make; the assertion that matters in every one is that
    // the ROW IS STILL THERE, not that the status is 403 -- a handler that
    // 403'd after deleting would pass a status-only test.
    it("refuses a POST with no token at all", async () => {
      const res = await post("/admin/subscriptions/delete/", { type: "mobile", row_id: "3" });

      expect(res.status).toBe(403);
      expect(await res.text()).toBe("Forbidden");
      expect(subscriberCount("mobilesubscriber")).toBe(1);
    });

    it("refuses a POST whose token does not match the cookie", async () => {
      const res = await post("/admin/subscriptions/delete/", { csrf_token: "b".repeat(64), type: "mobile", row_id: "3" });

      expect(res.status).toBe(403);
      expect(subscriberCount("mobilesubscriber")).toBe(1);
    });

    it("refuses a POST with a token but no cookie to check it against", async () => {
      const res = await post("/admin/subscriptions/delete/", { csrf_token: CSRF_RAW, type: "mobile", row_id: "3" }, { cookie: "" });

      expect(res.status).toBe(403);
      expect(subscriberCount("mobilesubscriber")).toBe(1);
    });

    it("refuses a cookie whose signature was not minted by this server", async () => {
      // A sibling subdomain can plant a cookie; it cannot sign one.
      const res = await post(
        "/admin/subscriptions/delete/",
        { csrf_token: CSRF_RAW, type: "mobile", row_id: "3" },
        { cookie: `__Host-csrf=${CSRF_RAW}.${"0".repeat(64)}` },
      );

      expect(res.status).toBe(403);
      expect(subscriberCount("mobilesubscriber")).toBe(1);
    });

    it("refuses a valid token submitted from another origin", async () => {
      const res = await post(
        "/admin/subscriptions/delete/",
        { csrf_token: CSRF_RAW, type: "mobile", row_id: "3" },
        { origin: "https://evil.example" },
      );

      expect(res.status).toBe(403);
      expect(subscriberCount("mobilesubscriber")).toBe(1);
    });
  });

  describe("input validation", () => {
    // Django returns 403 "Invalid subscription type" (views.py:3002-3004); the
    // port answers 400, which is the more accurate code for a malformed body.
    // Pinned because it is a visible divergence, not an accident.
    it.each(["whatsapp", "", "EMAIL", "sql"])("rejects the type %o with a 400 and no delete", async (type) => {
      const res = await post("/admin/subscriptions/delete/", { csrf_token: CSRF_RAW, type, row_id: "3" });

      expect(res.status).toBe(400);
      expect(await res.text()).toBe("Bad request");
      expect(subscriberCount("mobilesubscriber")).toBe(1);
      expect(subscriberCount("foodbanksubscriber")).toBe(2);
    });

    it("rejects a POST with no row_id", async () => {
      const res = await post("/admin/subscriptions/delete/", { csrf_token: CSRF_RAW, type: "mobile" });

      expect(res.status).toBe(400);
      expect(subscriberCount("mobilesubscriber")).toBe(1);
    });

    // The type check runs BEFORE the row is touched, so a bad type cannot
    // delete a row that a good one would have. Ordering, not just outcome:
    // validating after the DELETE would still return 400 here.
    //
    // THE ROW_ID MUST BE ONE THAT WOULD ACTUALLY DELETE SOMETHING. This test
    // used to post row_id "a@example.org|salisbury", and the mutant it is
    // written to catch -- moving the type check below the
    // `await deleteSubscription(...)` -- SURVIVED that: an unrecognised type
    // falls through deleteSubscription's `type === "mobile" ? ... :
    // "webpushsubscription"` to the webpush table, where
    // Number("a@example.org|salisbury") is NaN and matches nothing. The 400
    // came back, no row moved, and the test passed over a handler that had
    // already run the delete. "4" is the seeded webpush row, so the reordered
    // handler now destroys it before answering 400, and all three tables are
    // counted below rather than just the email one.
    it("checks the type before it touches the database", async () => {
      const res = await post("/admin/subscriptions/delete/", { csrf_token: CSRF_RAW, type: "whatsapp", row_id: "4" });

      expect(res.status).toBe(400);
      expect(emails()).toHaveLength(2);
      expect(subscriberCount("mobilesubscriber")).toBe(1);
      expect(subscriberCount("webpushsubscription")).toBe(1);
    });

    it("deletes nothing for an email row_id that is not a pair", async () => {
      const res = await post("/admin/subscriptions/delete/", { csrf_token: CSRF_RAW, type: "email", row_id: "a@example.org" });

      expect(res.status).toBe(302);
      expect(emails()).toHaveLength(2);
    });

    it("deletes nothing for an email row_id naming a food bank that does not exist", async () => {
      const res = await post("/admin/subscriptions/delete/", { csrf_token: CSRF_RAW, type: "email", row_id: "a@example.org|nowhere" });

      expect(res.status).toBe(302);
      expect(emails()).toHaveLength(2);
    });

    // SUSPECT, pinned as-is. Django's delete_subscription uses
    // get_object_or_404, so a stale Delete button -- the row already gone in
    // another tab, or a hand-typed id -- answered 404. This port redirects 302
    // to a list that still looks correct, so "deleted" and "there was nothing
    // to delete" are indistinguishable to the admin. deleteSubscription
    // returns a boolean saying which happened and the handler discards it.
    // Same shape as issue #34: the redirect is not evidence of a write.
    it("redirects as though it worked when the row does not exist", async () => {
      const res = await post("/admin/subscriptions/delete/", { csrf_token: CSRF_RAW, type: "mobile", row_id: "99999" });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/admin/subscriptions/");
      expect(subscriberCount("mobilesubscriber")).toBe(1);
    });

    // Number("12abc") is NaN, so the guard holds and no DELETE runs. Worth
    // pinning because parseInt would have made this "12" and deleted a real
    // row on a malformed id.
    //
    // A MUTANT SURVIVES THIS ONE FROM HERE, and the kill lives one layer
    // down: deleting deleteSubscription's `Number.isInteger(id)` guard
    // entirely leaves this test green, because node:sqlite binds NaN happily,
    // matches nothing and reports 0 changes -- the same 302 and the same
    // surviving row. D1 does NOT do that (a NaN binding is a type error, i.e.
    // a 500 in production), so the guard's real contract is "issue no
    // statement at all", which cannot be observed through an HTTP response.
    // packages/db/src/adminLists.test.ts asserts it directly by watching what
    // the session is asked to prepare; this test pins the route's half.
    it("deletes nothing for a non-numeric id", async () => {
      const res = await post("/admin/subscriptions/delete/", { csrf_token: CSRF_RAW, type: "mobile", row_id: "3abc" });

      expect(res.status).toBe(302);
      expect(subscriberCount("mobilesubscriber")).toBe(1);
    });
  });

  // The route is registered POST-only (routes/admin/index.ts:190), matching
  // Django's @require_POST. A GET that deleted would be triggerable by any
  // <img src> on any page an admin has open.
  it("is not reachable by GET", async () => {
    const res = await fetchPath("/admin/subscriptions/delete/?type=mobile&row_id=3");

    expect(res.status).toBe(404);
    expect(subscriberCount("mobilesubscriber")).toBe(1);
  });
});

// ===========================================================================
// /admin/foodbanks/without_need/
// ===========================================================================
describe("adminFoodbanksWithoutNeedList", () => {
  // Django's foodbanks_without_need iterates `Foodbank.objects.all()` and
  // annotates each with its latest published need -- so the page named "without
  // a need" in fact lists EVERY food bank, and the Need column is how you tell
  // them apart. Counter-intuitive, and exactly the kind of thing a later
  // "obviously this should filter" change would break, so it is pinned.
  it("lists every food bank, not only the ones missing a need", async () => {
    seedFoodbank({ id: 1, name: "Has Need", slug: "has-need" });
    seedFoodbank({ id: 2, name: "No Need", slug: "no-need" });
    seedNeed({ id: 1, foodbank_id: 1, need_id: "abcdef01-2345-6789-abcd-ef0123456789", published: 1 });

    const { ctx } = await getList("/admin/foodbanks/without_need/");

    expect(ctx.total).toBe(2);
    expect(column(ctx, 0)).toEqual([
      '<a href="/admin/foodbank/has-need/">Has Need</a>',
      '<a href="/admin/foodbank/no-need/">No Need</a>',
    ]);
  });

  // foodbanks_without_need.html:22 renders `need.need_id_short`
  // (needs.py:81-82, `str(self.need_id)[:7]`), the same 7 characters
  // /admin/needs/ shows in its own ID column.
  it("shows the latest published need's first seven characters, linked", async () => {
    seedFoodbank({ id: 1, name: "Has Need", slug: "has-need" });
    seedNeed({ id: 1, foodbank_id: 1, need_id: "abcdef01-2345-6789-abcd-ef0123456789", published: 1, created: "2026-03-01 09:00:00" });
    seedNeed({ id: 2, foodbank_id: 1, need_id: "99999999-2345-6789-abcd-ef0123456789", published: 1, created: "2026-04-01 09:00:00" });

    // The LATEST of the two, by created -- a window function partitioned or
    // ordered wrongly would show the older need and nothing would look amiss.
    expect(cells((await getList("/admin/foodbanks/without_need/")).ctx, 0)[1]).toBe(
      '<a href="/admin/need/99999999-2345-6789-abcd-ef0123456789/">9999999</a>',
    );
  });

  // The WHERE published = 1 inside the window, tested from the outside: a food
  // bank whose only need is unpublished belongs in this list as one WITHOUT a
  // need. Django's `None.need_id_short` falls through to the unset
  // string_if_invalid, i.e. "".
  it("ignores an unpublished need, leaving the cell empty", async () => {
    seedFoodbank({ id: 1, name: "Draft Only", slug: "draft-only" });
    seedNeed({ id: 1, foodbank_id: 1, published: 0 });

    expect(cells((await getList("/admin/foodbanks/without_need/")).ctx, 0)[1]).toBe("");
  });

  // Migration 0019 dropped foodbankchange.foodbank_name, and the join moved to
  // the FK. Django's own name-join silently missed every renamed food bank; a
  // regression back to a name-based join would fail here, because this need's
  // stored `name` is the OLD one.
  it("matches a need to its food bank by id, not by the need's stored name", async () => {
    seedFoodbank({ id: 1, name: "Renamed Food Bank", slug: "renamed" });
    seedNeed({ id: 1, foodbank_id: 1, name: "Old Name Food Bank", need_id: "abcdef01-2345-6789-abcd-ef0123456789", published: 1 });

    expect(cells((await getList("/admin/foodbanks/without_need/")).ctx, 0)[1]).toContain("abcdef0");
  });

  it("includes closed food banks, unlike /admin/foodbanks/", async () => {
    seedFoodbank({ id: 1, name: "Closed Bank", slug: "closed-bank", is_closed: 1 });

    const { ctx } = await getList("/admin/foodbanks/without_need/");
    expect(ctx.total).toBe(1);
    expect(ctx.rows).toHaveLength(1);
  });

  it("is a two-column page with no buttons of its own", async () => {
    seedFoodbank({ id: 1 });
    const { ctx } = await getList("/admin/foodbanks/without_need/");

    expect(ctx.title).toBe("Foodbanks without a need");
    expect(ctx.section).toBe("settings");
    expect(ctx.columns).toEqual([{ label: "Foodbank" }, { label: "Need" }]);
    expect(ctx.row_actions).toBe(false);
    expect(ctx.new_url).toBeUndefined();
    expect(ctx.csv_url).toBeUndefined();
    expect(ctx.sort).toBeUndefined();
  });
});

// ===========================================================================
// /admin/needs/
// ===========================================================================
describe("adminNeedsList", () => {
  it("lists needs newest first with the nine columns Django's template has", async () => {
    seedFoodbank({ id: 1, name: "Salisbury Food Bank", slug: "salisbury" });
    seedNeed({ id: 1, need_id: "aaaaaaaa-1111-1111-1111-111111111111", change_text: "Beans", created: "2026-03-01 09:00:00" });
    seedNeed({ id: 2, need_id: "bbbbbbbb-1111-1111-1111-111111111111", change_text: "Pasta", created: "2026-03-02 09:00:00" });

    const { ctx } = await getList("/admin/needs/");

    expect(ctx.title).toBe("Needs");
    expect(ctx.section).toBe("needs");
    expect(ctx.columns.map((col) => col.label)).toEqual([
      "Published?",
      "Input",
      "Cat?",
      "ID",
      "Foodbank",
      "Need",
      "Excess",
      "Created",
      "Modified",
    ]);
    expect(column(ctx, 3)).toEqual([
      '<a href="/admin/need/bbbbbbbb-1111-1111-1111-111111111111/">bbbbbbb</a>',
      '<a href="/admin/need/aaaaaaaa-1111-1111-1111-111111111111/">aaaaaaa</a>',
    ]);
    expect(ctx.csv_url).toBe("/admin/needs/csv/");
  });

  // Both states, because a tick that never becomes a cross is the same bug as
  // a filter that never filters -- and this column is how an admin sees at a
  // glance which needs are live.
  it("ticks a published need in green and crosses an unpublished one in red", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    seedNeed({ id: 1, need_id: "aaaaaaaa-1111-1111-1111-111111111111", published: 1, created: "2026-03-02 09:00:00" });
    seedNeed({ id: 2, need_id: "bbbbbbbb-1111-1111-1111-111111111111", published: 0, created: "2026-03-01 09:00:00" });

    expect(column((await getList("/admin/needs/")).ctx, 0)).toEqual([
      '<span style="color:green">&#10003;</span>',
      '<span style="color:red">x</span>',
    ]);
  });

  // needs.py:124-132 returns MDI markup, not emoji, despite the name -- and
  // an unrecognised method falls off the end and renders as nothing.
  it("renders the input method as MDI markup, and an unknown one as nothing", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    seedNeed({ id: 1, need_id: "aaaaaaaa-1111-1111-1111-111111111111", input_method: "ai", created: "2026-03-04 09:00:00" });
    seedNeed({ id: 2, need_id: "bbbbbbbb-1111-1111-1111-111111111111", input_method: "typed", created: "2026-03-03 09:00:00" });
    seedNeed({ id: 3, need_id: "cccccccc-1111-1111-1111-111111111111", input_method: "martian", created: "2026-03-02 09:00:00" });

    expect(column((await getList("/admin/needs/")).ctx, 1)).toEqual([
      '<span class="mdi mdi-robot"></span>',
      '<span class="mdi mdi-keyboard"></span>',
      "",
    ]);
  });

  it("shows the bucket only for a categorised need", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    seedNeed({ id: 1, need_id: "aaaaaaaa-1111-1111-1111-111111111111", is_categorised: 1, created: "2026-03-03 09:00:00" });
    seedNeed({ id: 2, need_id: "bbbbbbbb-1111-1111-1111-111111111111", is_categorised: 0, created: "2026-03-02 09:00:00" });
    seedNeed({ id: 3, need_id: "cccccccc-1111-1111-1111-111111111111", is_categorised: null, created: "2026-03-01 09:00:00" });

    expect(column((await getList("/admin/needs/")).ctx, 2)).toEqual(["\u{1FAA3}", "", ""]);
  });

  // Django's |linebreaksbr on an autoescaped value: ESCAPE FIRST, then turn
  // the newlines into <br>. In the other order the <br> tags get escaped and
  // the admin reads "&lt;br&gt;" down the column; worse, escaping second would
  // never happen at all and the need text would be live markup, since
  // list.njk renders these cells with `| safe`.
  it("escapes need text before turning its newlines into <br>", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    seedNeed({
      id: 1,
      change_text: "Beans & pasta\n<script>alert(1)</script>\r\nRice\rSugar",
      excess_change_text: "Nothing\nthanks",
    });

    const rendered = cells((await getList("/admin/needs/")).ctx, 0);
    expect(rendered[5]).toBe(
      '<span class="is-size-7">Beans &amp; pasta<br>&lt;script&gt;alert(1)&lt;/script&gt;<br>Rice<br>Sugar</span>',
    );
    expect(rendered[6]).toBe('<span class="is-size-7">Nothing<br>thanks</span>');
  });

  it("leaves an absent excess cell empty rather than printing an empty span's worth of nothing", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    seedNeed({ id: 1, excess_change_text: null });

    expect(cells((await getList("/admin/needs/")).ctx, 0)[6]).toBe('<span class="is-size-7"></span>');
  });

  // The food bank cell links through the REAL slug from the FK join. Django's
  // template slugified the need's cached name instead, which is not reliably
  // the food bank's slug -- and for an unassigned need it produced a link to
  // nowhere. Here an orphan is plain text.
  it("links an assigned need to its food bank and leaves an unassigned one as text", async () => {
    seedFoodbank({ id: 1, name: "Salisbury Food Bank", slug: "salisbury" });
    seedNeed({ id: 1, need_id: "aaaaaaaa-1111-1111-1111-111111111111", foodbank_id: 1, created: "2026-03-02 09:00:00" });
    seedNeed({ id: 2, need_id: "bbbbbbbb-1111-1111-1111-111111111111", foodbank_id: null, created: "2026-03-01 09:00:00" });

    expect(column((await getList("/admin/needs/")).ctx, 4)).toEqual([
      '<a href="/admin/foodbank/salisbury/">Salisbury Food Bank</a>',
      "Unknown",
    ]);
  });

  it("uses plain dates in the created and modified columns", async () => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    seedNeed({ id: 1, created: "2026-09-02 15:34:00", modified: "2026-09-03 09:00:00" });

    const rendered = cells((await getList("/admin/needs/")).ctx, 0);
    expect(rendered[7]).toBe("Sept. 2, 2026, 3:34 p.m.");
    expect(rendered[8]).toBe("Sept. 3, 2026, 9 a.m.");
  });
});

// ===========================================================================
// Cross-cutting: every list page pages, and counts its OWN table.
//
// Two whole classes of silent failure had nothing asserting them before this
// block, because /admin/foodbanks/ was the only page with a pagination test
// and every other page's `total` went unread:
//
//   1. `parsePage(c)` replaced by a literal 1 in any of the other eight
//      handlers, or the OFFSET dropped from the query behind it. Page 2 then
//      renders page 1's rows under a paginator that says "page 2", which
//      reads as "there is nothing past row 100" to anyone deep-linking -- on
//      /admin/needs/ and /admin/subscriptions/, the two tables that will
//      actually exceed a page.
//   2. a COUNT() aimed at the wrong table. `total` drives the "(N)" heading
//      and the paginator, so a locations page that counts `foodbank` looks
//      completely normal until the two numbers happen to differ.
//
// Both are killed by the same fixture, which is why they share a test: the
// row counts per table are DELIBERATELY ALL DIFFERENT (2/4/5/6/7/8/9/10/3),
// so a count against any other table is a wrong number rather than a
// coincidence, and every count above is under PAGE_SIZE, so page 2 must be
// empty rather than a repeat of page 1.
// ===========================================================================
describe("every list page pages and counts its own table", () => {
  function seedEveryTable(): void {
    // 2 open + 1 closed: /admin/foodbanks/ excludes the closed one and
    // /admin/foodbanks/without_need/ does not, so the two pages must disagree
    // (2 vs 3) over the same table.
    seedFoodbank({ id: 1, name: "FB One", slug: "fb-one" });
    seedFoodbank({ id: 2, name: "FB Two", slug: "fb-two" });
    seedFoodbank({ id: 3, name: "FB Closed", slug: "fb-closed", is_closed: 1 });
    for (let i = 1; i <= 4; i++) seedLocation({ id: i, foodbank_id: 1, name: `Loc ${i}`, slug: `loc-${i}` });
    for (let i = 1; i <= 5; i++) seedDonationPoint({ id: i, foodbank_id: 1, name: `DP ${i}`, slug: `dp-${i}` });
    for (let i = 1; i <= 6; i++) {
      seedNeed({ id: i, foodbank_id: 1, need_id: `0000000${i}-1111-1111-1111-111111111111`, created: `2026-03-0${i} 09:00:00` });
    }
    for (let i = 1; i <= 7; i++) seedParlcon({ id: i, name: `PC ${i}`, slug: `pc-${i}`, mp_parl_id: i });
    for (let i = 1; i <= 8; i++) seedPlace({ id: i, gbpnid: i, name: `Place ${i}`, name_slug: `place-${i}` });
    for (let i = 1; i <= 9; i++) seedOrder({ id: i, order_id: `ORD-${i}` });
    // 2 + 3 + 5 = 10 subscriptions, across all three of the UNION's arms.
    for (let i = 1; i <= 2; i++) {
      insert("foodbanksubscriber", {
        id: i,
        created: "2026-05-01 09:00:00",
        foodbank_id: 1,
        email: `sub${i}@example.org`,
        confirmed: 1,
        sub_key: `s${i}`,
        unsub_key: `u${i}`,
      });
    }
    for (let i = 1; i <= 3; i++) {
      insert("mobilesubscriber", { id: i, created: "2026-05-02 09:00:00", device_id: `device-${i}`, platform: "iOS", foodbank_id: 1 });
    }
    for (let i = 1; i <= 5; i++) {
      insert("webpushsubscription", {
        id: i,
        created: "2026-05-03 09:00:00",
        foodbank_id: 1,
        endpoint: `https://push.example.org/${i}`,
        p256dh: "p",
        auth: "a",
        browser: "Firefox",
      });
    }
  }

  it.each([
    ["/admin/foodbanks/", 2],
    ["/admin/locations/", 4],
    ["/admin/donationpoints/", 5],
    ["/admin/needs/", 6],
    ["/admin/politics/", 7],
    ["/admin/places/", 8],
    ["/admin/orders/", 9],
    ["/admin/subscriptions/", 10],
    ["/admin/foodbanks/without_need/", 3],
  ])("%s reports %i rows and offsets past them on page 2", async (path, expected) => {
    seedEveryTable();

    const first = (await getList(path)).ctx;
    expect(first.total).toBe(expected);
    expect(first.rows).toHaveLength(expected);
    expect(first.page).toBe(1);
    expect(first.total_pages).toBe(1);
    expect(first.has_next).toBe(false);

    const second = (await getList(`${path}?page=2`)).ctx;
    expect(second.page).toBe(2);
    expect(second.rows).toEqual([]);
    // The count is a property of the table, not of the page being looked at,
    // so it must not move when the rows run out.
    expect(second.total).toBe(expected);
    expect(second.has_next).toBe(false);
  });
});

// ===========================================================================
// Cross-cutting: none of these pages is allowed to write.
// ===========================================================================
describe("every list route is read-only", () => {
  // Eleven GETs over a fully populated database, with the whole thing
  // fingerprinted before and after. A handler that "touched" a row's `edited`
  // on the way past -- the sort key /admin/foodbanks/ is ordered by -- would
  // reshuffle the triage queue every time someone opened it, and nothing else
  // in this suite would notice.
  it.each([
    "/admin/foodbanks/",
    "/admin/foodbanks/csv/",
    "/admin/foodbanks/next/",
    "/admin/locations/",
    "/admin/donationpoints/",
    "/admin/politics/",
    "/admin/politics/csv/",
    "/admin/orders/",
    "/admin/orders/csv/",
    "/admin/needs/csv/",
    "/admin/places/",
    "/admin/subscriptions/",
    "/admin/foodbanks/without_need/",
    "/admin/needs/",
  ])("GET %s changes nothing", async (path) => {
    seedFoodbank({ id: 1, name: "FB", slug: "fb" });
    seedLocation({ id: 1 });
    seedDonationPoint({ id: 1 });
    seedNeed({ id: 1 });
    seedOrder({ id: 1 });
    seedParlcon({ id: 1 });
    seedPlace({ id: 1, gbpnid: 1 });
    insert("foodbanksubscriber", { id: 1, created: "2026-05-01 09:00:00", foodbank_id: 1, email: "a@example.org", confirmed: 1, sub_key: "s", unsub_key: "u" });
    // MOBILE AND WEBPUSH ROWS, and both tables in the fingerprint below. They
    // were missing from both, and a mutant proved what that cost: a
    // `DELETE FROM webpushsubscription` planted in adminNeedsList -- a page
    // with no connection to subscriptions at all -- emptied the table on
    // every render and this suite stayed green. These two tables are the only
    // ones any route in this module deletes from, so they are precisely the
    // ones a stray write is most likely to reach.
    insert("mobilesubscriber", { id: 1, created: "2026-05-02 09:00:00", device_id: "device-1", platform: "iOS", foodbank_id: 1 });
    insert("webpushsubscription", { id: 1, created: "2026-05-03 09:00:00", foodbank_id: 1, endpoint: "https://push.example.org/1", p256dh: "p", auth: "a", browser: "Firefox" });
    insert("foodbankhit", { foodbank_id: 1, day: "2026-09-01", hits: 3 });

    const tables = ["foodbank", "foodbanklocation", "foodbankdonationpoint", "foodbankchange", "orders", "parliamentaryconstituency", "place", "foodbanksubscriber", "mobilesubscriber", "webpushsubscription", "foodbankhit"];
    const before = tables.map((table) => JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()));

    const res = await fetchPath(path);
    expect(res.status).toBeLessThan(400);

    expect(tables.map((table) => JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()))).toEqual(before);
  });

  // ...and none of them slides the admin's KV session forward either. The
  // refresh path exists (adminAuth.ts:286-293) but only past the half-way
  // mark, so an ordinary page view must read the session and write nothing.
  it("reads the session without rewriting it", async () => {
    seedFoodbank({ id: 1 });
    await fetchPath("/admin/foodbanks/");

    expect(kvGets).toHaveLength(1);
    expect(kvPuts).toHaveLength(0);
  });
});
