import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_SEARCH_MIN_QUERY_LENGTH, type AdminSearchResults } from "@givefood/db";
import { serverTiming } from "../../middleware/serverTiming";
import { noStore } from "../../middleware/noStore";
import type { AppEnv } from "../../types";

// /admin/search/ -- gfadmin/views.py:111-231 search_results(), registered
// gfadmin/urls/core.py:15. The navbar search box on every admin page
// (admin/page.njk:54-56), so it is the most-reached page in the admin after
// the index, and the only one whose entire input is a raw string from the
// address bar.
//
// WHY THIS FILE EXISTS, given packages/db/src/adminSearch.test.ts already runs
// all eight statements through a real engine row by row: everything the ROUTE
// can get wrong is invisible to that suite, and none of it throws.
// routes/admin/search.ts is one expression and four booleans, and each of the
// four decides what the maintainer is told:
//
//   - `searched`, which separates "you have not searched yet" from "your
//     search found nothing". Django has no such state at all: views.py:117
//     hands `query = None` straight to .filter(slug__icontains=None) and 500s
//     on a bare /admin/search/, which the navbar makes a one-click path, while
//     an empty `?q=` compiles to LIKE '%%' and dumps ~600 arbitrary rows. Both
//     are fixed here (F1/F2) and neither fix is visible in packages/db.
//   - `too_short` and `too_long`, which are two DIFFERENT messages
//     (admin/search.njk:37-44) derived from one null. Get the arithmetic
//     wrong and a one-letter search is answered with "That search is too
//     long, try something shorter".
//   - `q`, which is echoed back into BOTH search boxes (search.njk:17 and
//     page.njk:56). Drop it and every result page clears the box the
//     maintainer just typed into.
//
// And the query has to survive being URL-decoded, trimmed, and passed down --
// the same "parsed, passed down, then dropped" shape as issue #34, where a
// Place ID reached the handler and no SQL ever wrote it. A rendered page is
// no more evidence that the query reached D1 than a redirect was evidence of
// a save, so every assertion below about results is made against rows read
// out of a real SQLite, and every group is seeded with a row that must NOT
// come back.
//
// REAL EVERYTHING except the template compiler: real SQLite (node:sqlite,
// seeded from the migration DDL), the real searchAdmin, the real dbSession,
// the real requireAdminAuth over a real KV-shaped store, the real
// issueCsrfToken, the real adminPageContext, and the REAL adminApp router
// from ./index -- so the path, the method and the auth gate under test are
// the shipped ones, not an ad-hoc route this file invented. Only
// @givefood/templates is stubbed: `render` so the context handed to the
// template is inspectable, and because importing it for real pulls in
// packages/templates/src/generated/precompiled.js, a gitignored build
// artifact `vitest run` alone never produces (dupePostcodes.test.ts and both
// form suites stub it for the same reason).
//
// MUTATION-TESTED in a throwaway copy outside the repo (TESTING.md's
// no-scratch-files rule), by aliasing this route's module -- and packages/db's
// adminSearch -- to a mutated copy and re-running. 26 mutants applied, 25
// dead. The ones worth naming because each is a plausible edit: the trim
// dropped, `searched` hard-coded either way, `too_short` hard-coded false, `too_short`
// widened to `<=` (the one that survived the first draft -- see the
// minimum-length test), `too_long` hard-coded false, `too_long` losing its
// length guard, `q` passed as "", the page context no longer spread in,
// `results: null`, min_query_length hard-coded, the template name changed,
// c.html("") for the rendered page, section changed to "foodbanks", the
// empty-query ternary removed so D1 is asked anyway, query("q") reading the
// LAST value instead of the first, requireAdminAuth replaced by a
// pass-through, and -- down in packages/db -- escapeLike made the identity,
// MAX_PATTERN_BYTES raised so instr() never runs, the length bounds moved by
// one at both ends, `confirmed = 1` dropped, the needs ORDER BY reversed, the
// is_closed sort dropped from the child groups, the subscription groups
// reordered, and need_id_short sliced at 8.
//
// SECOND, ADVERSARIAL PASS: 71 further mutants, same method. It found ONE
// genuine hole, since closed -- the results ternary measuring the RAW query
// instead of the trimmed one, which opens a D1 session for a whitespace-only
// search while every assertion in the file still read the same (see the
// whitespace test). It also added the cacheability group below, which nothing
// here covered: the file asserted the csrfIssued FLAG and stopped, so no test
// said this page's response is actually uncacheable.
//
// Six survivors were left alone on purpose. Two are equivalent mutants, not
// holes: `too_long`'s `>=` narrowed to `>` (at exactly the minimum length
// searchAdmin never returns null, so the state is unreachable), and
// searchAdmin's own trim (the route trims first, so the second one cannot
// change this caller's answer). Four belong to packages/db and are asserted
// there by name -- the location search's `slug` column, the donation point
// search NOT having one, and two ORDER BY clauses that, like the food bank
// one below, only decide which 100 rows survive the LIMIT.
//
// One mutant is deliberately NOT killed here: the food bank statement's
// `ORDER BY match_rank, is_closed, name` reduced to `ORDER BY name`. That
// clause decides only WHICH 100 rows survive the LIMIT (adminSearch.ts:210-214
// says so); the displayed order comes from the JS re-sort, so it is
// unobservable below 101 matching food banks. Seeding 101 belongs in
// packages/db/src/adminSearch.test.ts, not in a route test.

const mocks = vi.hoisted(() => ({
  renderCalls: [] as { template: string; context: Record<string, unknown> }[],
  pageContextCalls: [] as { path: string }[],
}));

vi.mock("@givefood/templates", () => ({
  render: async (template: string, context: Record<string, unknown>) => {
    mocks.renderCalls.push({ template, context });
    return `<html data-template="${template}"></html>`;
  },
  // Stubbed rather than dropped: adminPageContext spreads this into every
  // admin render and admin/page.njk reads canonical_path and the rest out of
  // it. Returning a marker is what makes "the shared page context is still in
  // there" assertable without loading the real templates.
  buildPageContext: (options: { path: string }) => {
    mocks.pageContextCalls.push(options);
    return { canonical_path: options.path, page_context_present: true };
  },
}));

// Imported after the mock factory, following dupePostcodes.test.ts. This is
// the REAL admin route table -- every registration in ./index -- so a route
// deleted, retyped, or registered as .post shows up here as a 404.
const { adminApp } = await import("./index");

// ---------------------------------------------------------------------------
// Schema. Transcribed from packages/db/migrations (0001_core.sql,
// 0004_subscribers.sql, 0011, with 0019's DROP COLUMNs applied and its three
// CREATE VIEWs verbatim), NOT from the TypeScript interfaces -- the point is
// to catch the two disagreeing. Reduced to the columns these eight statements
// name plus the NOT NULLs that constrain a fixture, following the
// workers/site convention rather than packages/db's full transcription.
//
// The three _full views are the real ones. adminSearch reads locations,
// donation points and needs THROUGH them, and their LEFT JOIN is load-bearing
// for the unassigned need below -- a hand-flattened table with foodbank_name
// already on it would make that untestable.
//
// The UNIQUE indexes are here so a fixture cannot set up a state production
// would have refused (same reasoning as foodbankAdmin.test.ts): two food
// banks with one name, or an unconfirmed duplicate of a confirmed subscriber.
// ---------------------------------------------------------------------------
const SCHEMA = `
CREATE TABLE foodbank (
  id INTEGER PRIMARY KEY, uuid TEXT NOT NULL,
  name TEXT NOT NULL, alt_name TEXT, slug TEXT NOT NULL,
  address TEXT NOT NULL, postcode TEXT NOT NULL, country TEXT NOT NULL,
  lat_lng TEXT NOT NULL,
  network TEXT, charity_just_foodbank INTEGER NOT NULL, charity_name TEXT,
  contact_email TEXT NOT NULL, phone_number TEXT,
  url TEXT NOT NULL, shopping_list_url TEXT NOT NULL,
  rss_url TEXT, news_url TEXT, donation_points_url TEXT,
  locations_url TEXT, contacts_url TEXT,
  address_is_administrative INTEGER NOT NULL,
  is_closed INTEGER NOT NULL,
  no_locations INTEGER NOT NULL, days_between_needs INTEGER NOT NULL,
  created TEXT NOT NULL, modified TEXT NOT NULL
);
CREATE UNIQUE INDEX foodbank_name_uniq ON foodbank(name);
CREATE UNIQUE INDEX foodbank_slug_uniq ON foodbank(slug);

CREATE TABLE foodbanklocation (
  id INTEGER PRIMARY KEY, uuid TEXT NOT NULL,
  foodbank_id INTEGER NOT NULL,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  address TEXT, postcode TEXT,
  country TEXT NOT NULL, lat_lng TEXT NOT NULL,
  is_closed INTEGER NOT NULL,
  modified TEXT NOT NULL
);
CREATE UNIQUE INDEX loc_fb_name_uniq ON foodbanklocation(foodbank_id, name);

CREATE TABLE foodbankdonationpoint (
  id INTEGER PRIMARY KEY, uuid TEXT NOT NULL,
  foodbank_id INTEGER NOT NULL,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  address TEXT NOT NULL, postcode TEXT NOT NULL,
  lat_lng TEXT NOT NULL,
  is_closed INTEGER NOT NULL, in_store_only INTEGER NOT NULL,
  modified TEXT NOT NULL
);
CREATE UNIQUE INDEX dp_fb_name_uniq ON foodbankdonationpoint(foodbank_id, name);

CREATE TABLE foodbankchange (
  id INTEGER PRIMARY KEY,
  need_id TEXT NOT NULL,
  foodbank_id INTEGER,
  change_text TEXT NOT NULL, excess_change_text TEXT,
  published INTEGER NOT NULL DEFAULT 0,
  nonpertinent INTEGER,
  input_method TEXT NOT NULL,
  created TEXT NOT NULL, modified TEXT NOT NULL
);
CREATE UNIQUE INDEX need_need_id_uniq ON foodbankchange(need_id);

CREATE TABLE parliamentaryconstituency (
  id INTEGER PRIMARY KEY,
  name TEXT, slug TEXT NOT NULL, country TEXT,
  mp TEXT, mp_parl_id INTEGER NOT NULL,
  centroid TEXT NOT NULL,
  boundary_geojson TEXT
);
CREATE INDEX parlcon_slug_idx ON parliamentaryconstituency(slug);

CREATE TABLE foodbanksubscriber (
  id INTEGER PRIMARY KEY,
  created TEXT NOT NULL, last_contacted TEXT,
  foodbank_id INTEGER NOT NULL,
  email TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0,
  sub_key TEXT NOT NULL, unsub_key TEXT NOT NULL
);
CREATE UNIQUE INDEX sub_email_fb_uniq ON foodbanksubscriber(email, foodbank_id);

CREATE TABLE mobilesubscriber (
  id INTEGER PRIMARY KEY,
  created TEXT NOT NULL,
  device_id TEXT NOT NULL, platform TEXT NOT NULL,
  foodbank_id INTEGER NOT NULL, donationpoint_id INTEGER
);

CREATE TABLE webpushsubscription (
  id INTEGER PRIMARY KEY,
  created TEXT NOT NULL,
  foodbank_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
  browser TEXT
);
CREATE UNIQUE INDEX webpush_fb_endpoint_uniq ON webpushsubscription(foodbank_id, endpoint);

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

type Bindable = null | number | bigint | string;

// Every statement the request issues, in order, plus how many batches carried
// them. The batch count is the page's whole cost story: adminSearch.ts:270
// promises "one round trip for all eight statements" against a 29.4 MB
// foodbankchange, and the two guard states below promise ZERO. A statement log
// is also the only way to assert that a guard state is free rather than merely
// quiet -- an empty result set and an unrun query render identically.
let statements: { sql: string; params: Bindable[] }[];
let batches: number;

// THE ONE THING THIS HARNESS ADDS TO SQLITE, lifted from
// packages/db/src/adminSearch.test.ts:206-230 with its reasoning intact: D1
// caps LIKE/GLOB patterns at 50 BYTES and rejects the statement outright over
// it, while stock SQLite allows 50,000 and node:sqlite exposes no way to lower
// it. It matters HERE, not just in packages/db, because the two route-level
// tests that paste a real URL and a real push endpoint into the box are
// claiming those searches WORK -- and they only work because an over-cap
// pattern switches to instr(). Without this the pages would render either way
// and the tests would prove nothing about production.
const D1_LIKE_PATTERN_BYTES = 50;

function enforceD1PatternLimit(sql: string, params: Bindable[]): void {
  for (const [slot, index] of [
    ["?1", 0],
    ["?3", 2],
  ] as const) {
    const value = params[index];
    if (!sql.includes(`LIKE ${slot}`) || typeof value !== "string") continue;
    if (new TextEncoder().encode(value).length > D1_LIKE_PATTERN_BYTES) {
      throw new Error("D1_ERROR: LIKE or GLOB pattern too complex");
    }
  }
}

// The slice of the D1 Sessions API this route reaches, over real SQLite.
// `batch` is what searchAdmin uses; first/all/run are implemented anyway so
// that a mutation which added a write would actually EXECUTE rather than
// throw -- a test proving this GET writes nothing must not be leaning on
// writes being impossible in the fixture.
function d1Session(db: DatabaseSync) {
  const statement = (sql: string, params: Bindable[]) => ({
    sql,
    params,
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => {
      statements.push({ sql, params });
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    all: async () => {
      statements.push({ sql, params });
      return { results: db.prepare(sql).all(...params), success: true, meta: {} };
    },
    run: async () => {
      statements.push({ sql, params });
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  type FakeStatement = ReturnType<typeof statement>;
  return {
    prepare: (sql: string) => statement(sql, []),
    batch: async (batched: FakeStatement[]) => {
      batches += 1;
      return batched.map((one) => {
        statements.push({ sql: one.sql, params: one.params });
        enforceD1PatternLimit(one.sql, one.params);
        return { results: db.prepare(one.sql).all(...one.params), success: true, meta: {} };
      });
    },
    getBookmark: () => null,
  };
}

// KV, in memory. Not a mock of logic: getAdminSession's contract is "the
// session id in the __Host-gfsession cookie names a JSON blob in SESSIONS",
// and this is that store, so lib/adminAuth.ts's cookie parsing, key naming,
// JSON handling and expiry maths all run for real.
function kvStore(entries: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(entries));
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  };
}

// lib/adminAuth.ts:61,250 -- the cookie name and the KV key prefix, spelled
// out here so a change to either fails this file rather than silently
// un-authenticating the admin.
const SESSION_COOKIE = "__Host-gfsession";
const SESSION_ID = "test-session-id";
const ADMIN = {
  email: "me@jasoncartwright.com",
  name: "Jason Cartwright",
  givenName: "Jason",
  picture: "https://example.org/avatar.png",
};

const SEARCH_PATH = "/admin/search/";

// Python's str(datetime) -- what Django and the ETL write, and what migration
// 0022 normalised every JavaScript-written value into. These columns are TEXT
// and SQLite compares TEXT byte by byte, so the needs group's ORDER BY created
// DESC is only meaningful if the fixture stores the production format.
const PY_NOW = "2026-09-05 19:28:08.853000";

// A food bank's real shopping list URL: 60 characters, so the escaped LIKE
// pattern is 62 bytes and over D1's cap. Pasting one of these into the search
// box is an ordinary thing to do on this page and it used to be answered with
// "That search is too long, try something shorter" (adminSearch.ts:44-56).
const LIST_URL = "https://salisburyfoodbank.org.uk/what-we-need/shopping-list/";

// A real-shaped FCM endpoint, ~130 characters. adminSearch.ts:66-68 names this
// as the longest thing anyone legitimately searches for here.
const PUSH_ENDPOINT = `https://fcm.googleapis.com/fcm/send/salisbury-${"eKz9Qv".repeat(14)}`;

const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let env: AppEnv["Bindings"];
let app: Hono<AppEnv>;
let sessionModes: string[];
let csrfIssued: boolean | undefined;
let nextId: number;

function insert(table: string, row: Record<string, Bindable>): void {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(
    ...columns.map((column) => row[column] as Bindable),
  );
}

// Every NOT NULL column filled with something that cannot accidentally satisfy
// a search, so that a match in a fixture row is always deliberate. Anything a
// test searches on is passed in explicitly.
function seedFoodbank(over: Record<string, Bindable>): number {
  const id = (nextId += 1);
  insert("foodbank", {
    id,
    uuid: `fb-uuid-${id}`,
    address: "1 Market Place\r\nTown",
    postcode: "ZZ1 1ZZ",
    country: "England",
    lat_lng: "51.0688,-1.7945",
    network: "Trussell",
    charity_just_foodbank: 0,
    contact_email: `info-${id}@example.org`,
    phone_number: "01722 349556",
    url: `https://example.org/fb/${id}/`,
    shopping_list_url: `https://example.org/fb/${id}/list/`,
    address_is_administrative: 0,
    is_closed: 0,
    no_locations: 0,
    days_between_needs: 7,
    created: PY_NOW,
    modified: PY_NOW,
    ...over,
  });
  return id;
}

function seedLocation(over: Record<string, Bindable>): number {
  const id = (nextId += 1);
  insert("foodbanklocation", {
    id,
    uuid: `loc-uuid-${id}`,
    address: "2 Back Lane",
    postcode: "ZZ1 1ZZ",
    country: "England",
    lat_lng: "51.0688,-1.7945",
    is_closed: 0,
    modified: PY_NOW,
    ...over,
  });
  return id;
}

function seedDonationPoint(over: Record<string, Bindable>): number {
  const id = (nextId += 1);
  insert("foodbankdonationpoint", {
    id,
    uuid: `dp-uuid-${id}`,
    address: "3 Retail Park",
    postcode: "ZZ1 1ZZ",
    lat_lng: "51.0688,-1.7945",
    is_closed: 0,
    in_store_only: 0,
    modified: PY_NOW,
    ...over,
  });
  return id;
}

function seedNeed(over: Record<string, Bindable>): number {
  const id = (nextId += 1);
  insert("foodbankchange", {
    id,
    change_text: "Pasta, Rice",
    published: 1,
    input_method: "scrape",
    created: PY_NOW,
    modified: PY_NOW,
    ...over,
  });
  return id;
}

function seedConstituency(over: Record<string, Bindable>): number {
  const id = (nextId += 1);
  insert("parliamentaryconstituency", {
    id,
    country: "England",
    mp_parl_id: 4000 + id,
    centroid: "51.0688,-1.7945",
    ...over,
  });
  return id;
}

// ---------------------------------------------------------------------------
// The fixture world, seeded once for every test. Six groups that must match
// "salisbury" and, in every one of them, at least one row that must NOT --
// because a handler (or a query) that ignored the search term and rendered
// everything would pass every assertion built only from matching rows. That is
// the same trap the two live bugs fell into: a page that looked right.
// ---------------------------------------------------------------------------
function seedWorld(): void {
  // Rank 0 (exact name), and the food bank everything else hangs off.
  const salisbury = seedFoodbank({ name: "Salisbury", slug: "salisbury", charity_name: "Trussell Trust", url: "https://salisburyfoodbank.org.uk/", shopping_list_url: LIST_URL });
  // Rank 1 (prefix), open.
  seedFoodbank({ name: "Salisbury Plain", slug: "salisbury-plain" });
  // Rank 1 (prefix), CLOSED -- open sorts before closed inside a rank band.
  seedFoodbank({ name: "Salisbury Market", slug: "salisbury-market", is_closed: 1 });
  // Rank 2: matches on `address`, not on name or slug.
  seedFoodbank({ name: "Old Sarum", slug: "old-sarum", address: "Portway\r\nSalisbury" });
  // THE ROW THAT MUST NOT COME BACK. Nothing about it contains "salisbury".
  const exeter = seedFoodbank({ name: "Exeter", slug: "exeter", postcode: "EX1 1AA" });

  // Locations. Alphabetically the CLOSED one sorts first and is displayed
  // second, which is what makes the is_closed sort observable.
  seedLocation({ foodbank_id: salisbury, name: "Ayleswade Road Hall", slug: "ayleswade-road-hall", address: "Ayleswade Road, Salisbury", is_closed: 1 });
  seedLocation({ foodbank_id: salisbury, name: "Bemerton Heath Centre", slug: "bemerton-heath-centre", address: "Pembroke Road, Salisbury" });
  seedLocation({ foodbank_id: exeter, name: "Exeter Hall", slug: "exeter-hall" });

  seedDonationPoint({ foodbank_id: salisbury, name: "Tesco Salisbury", slug: "tesco-salisbury" });
  seedDonationPoint({ foodbank_id: exeter, name: "Sainsbury's Exeter", slug: "sainsburys-exeter" });

  seedConstituency({ name: "Salisbury", slug: "salisbury", mp: "John Glen" });
  // Matches on `mp`, which is searched and never displayed, AND has a NULL
  // name (0001_core.sql:131 allows it) -- the row Django's own
  // `{{ constituency }}` would raise TypeError on.
  seedConstituency({ name: null, slug: "unnamed-boundary", mp: "Pat Salisbury" });
  seedConstituency({ name: "Exeter", slug: "exeter", mp: "Steve Race" });

  // Needs. The newer one is UNASSIGNED (foodbank_id NULL) and matches on
  // excess_change_text; the older matches on change_text.
  seedNeed({ need_id: "b2c3d4e5f60000000000000000000002", foodbank_id: null, change_text: "Pasta, Rice", excess_change_text: "Excess Salisbury steak", created: "2026-09-03 09:00:00.000000", modified: "2026-09-03 10:00:00.000000" });
  seedNeed({ need_id: "a1b2c3d4e50000000000000000000001", foodbank_id: salisbury, change_text: "Tinned tomatoes, Salisbury steak", created: "2026-09-01 09:00:00.000000", modified: "2026-09-01 10:00:00.000000" });
  seedNeed({ need_id: "c3d4e5f6a70000000000000000000003", foodbank_id: exeter, change_text: "Nappies, Coffee" });

  insert("foodbanksubscriber", { id: (nextId += 1), created: PY_NOW, foodbank_id: salisbury, email: "helper@salisbury.example.org", confirmed: 1, sub_key: "sub-1", unsub_key: "unsub-1" });
  // CONFIRMED ONLY -- Django filters on it (views.py:159-161) and an admin
  // searching for a subscriber must not be shown someone who never clicked
  // the confirmation link as though they were subscribed.
  insert("foodbanksubscriber", { id: (nextId += 1), created: PY_NOW, foodbank_id: salisbury, email: "pending@salisbury.example.org", confirmed: 0, sub_key: "sub-2", unsub_key: "unsub-2" });
  insert("foodbanksubscriber", { id: (nextId += 1), created: PY_NOW, foodbank_id: exeter, email: "helper@exeter.example.org", confirmed: 1, sub_key: "sub-3", unsub_key: "unsub-3" });

  insert("mobilesubscriber", { id: (nextId += 1), created: PY_NOW, device_id: "salisbury-device-0123456789abcdef", platform: "iOS", foodbank_id: salisbury });
  insert("mobilesubscriber", { id: (nextId += 1), created: PY_NOW, device_id: "exeter-device-0123456789abcdef", platform: "Android", foodbank_id: exeter });

  // browser is the EMPTY STRING, not NULL: Django's `sub.browser or 'Unknown'`
  // is Python truthiness, so "" is also 'Unknown' and a plain COALESCE would
  // have rendered a blank.
  insert("webpushsubscription", { id: (nextId += 1), created: PY_NOW, foodbank_id: salisbury, endpoint: PUSH_ENDPOINT, p256dh: "p", auth: "a", browser: "" });
  insert("webpushsubscription", { id: (nextId += 1), created: PY_NOW, foodbank_id: exeter, endpoint: "https://fcm.googleapis.com/fcm/send/exeter-abc123", p256dh: "p", auth: "a", browser: "Firefox" });
}

// A signed-in GET, i.e. what the maintainer's browser sends after typing in
// the navbar box. `async` rather than a bare return because Hono types
// app.request() as `Response | Promise<Response>`.
async function get(path = SEARCH_PATH): Promise<Response> {
  return app.request(path, { headers: { Cookie: `${SESSION_COOKIE}=${SESSION_ID}` } }, env, execCtx);
}

function lastRender(): { template: string; context: Record<string, unknown> } {
  const call = mocks.renderCalls.at(-1);
  if (!call) throw new Error("the handler rendered nothing");
  return call;
}

// The four booleans and the query echo -- everything admin/search.njk branches
// on. Read as a group because they are only correct as a group: exactly one of
// the four states may be true at a time.
function guards(): Record<string, unknown> {
  const context = lastRender().context;
  return {
    q: context.q,
    searched: context.searched,
    too_short: context.too_short,
    too_long: context.too_long,
    results_null: context.results === null,
  };
}

function results(): AdminSearchResults {
  const value = lastRender().context.results as AdminSearchResults | null;
  if (value === null) throw new Error("the handler rendered a guard state, not results");
  return value;
}

const rowCount = (table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const COUNTED_TABLES = ["foodbank", "foodbanklocation", "foodbankdonationpoint", "foodbankchange", "parliamentaryconstituency", "foodbanksubscriber", "mobilesubscriber", "webpushsubscription"] as const;

const allRowCounts = (): Record<string, number> => Object.fromEntries(COUNTED_TABLES.map((table) => [table, rowCount(table)]));

beforeEach(() => {
  mocks.renderCalls.length = 0;
  mocks.pageContextCalls.length = 0;
  statements = [];
  batches = 0;
  sessionModes = [];
  csrfIssued = undefined;
  nextId = 0;

  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  seedWorld();
  const session = d1Session(db);

  env = {
    // Recorded rather than ignored: dbSession(c) asks for
    // "first-unconstrained" (lib/session.ts), and the number of calls is how
    // this file knows whether a guard state opened a session at all.
    DB: {
      withSession: (mode: string) => {
        sessionModes.push(mode);
        return session;
      },
    },
    SESSIONS: kvStore({
      [`admin-session:${SESSION_ID}`]: JSON.stringify({ ...ADMIN, expiresAt: Date.now() + 12 * 60 * 60 * 1000 }),
    }),
    CSRF_SECRET: "test-secret",
    GMAP_STATIC_KEY: "static-key",
    GMAP_GEOCODE_KEY: "geocode-key",
    D1_DATABASE_NAME: "givefood-test",
  } as unknown as AppEnv["Bindings"];

  // The production mount: index.ts:637 routes /admin at adminApp, and
  // index.ts:112 puts serverTiming in front of everything. serverTiming is
  // here rather than omitted because adminPageContext reads the request-start
  // time it records -- without it `render_time_ms` is the string "NaN" on
  // every page, and a fixture should not be the reason a claim is untrue.
  app = new Hono<AppEnv>();
  app.use("*", serverTiming);
  // Reads back the context variable lib/csrf.ts sets. It dies with the
  // request, and middleware/pageCacheControl.ts is its only production reader.
  app.use("*", async (c, next) => {
    await next();
    csrfIssued = c.get("csrfIssued");
  });
  // index.ts:137-138, both mounts verbatim. Present for the same reason
  // serverTiming is: this page's whole result set is subscriber email
  // addresses, device ids and push endpoints, and whether it is cacheable is
  // decided by a PATTERN MATCH against this route's path, which only a real
  // request through the real router can settle. Omitting it would leave the
  // cacheability assertions below untestable and the fixture quietly kinder
  // to the route than production is.
  app.use("/admin", noStore);
  app.use("/admin/*", noStore);
  app.route("/admin", adminApp);
});

describe("the route registration", () => {
  // The href admin/page.njk:55 ships on EVERY admin page, asked of the real
  // router. Hard-coded rather than built from a constant so the string here
  // and the string in the template are two independent copies -- a rename
  // that updated only one of them is the failure being guarded against, and
  // this form is submitted from every page in the admin.
  it("answers the /admin/search/ action the navbar form posts to", async () => {
    const res = await get(`${SEARCH_PATH}?q=salisbury`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(lastRender().template).toBe("admin/search.njk");
    // The rendered HTML is what comes back, not discarded and re-derived:
    // c.html(html), not c.html("").
    expect(await res.text()).toBe('<html data-template="admin/search.njk"></html>');
  });

  // GET ONLY. ./index:213 registers `adminApp.get(...)` and nothing else, so
  // Hono answers a POST with a 404.
  //
  // A DIVERGENCE FROM DJANGO, deliberate: Django's view is a plain function
  // with no method guard, so a POST there renders the same page with a 200.
  // Both are harmless because neither writes anything -- what is asserted is
  // that the port's answer to a POST is a refusal that costs no query. This
  // is also why search.ts has no CSRF check: there is no accepted mutating
  // method to protect, and adding a token to a search box would put the
  // maintainer's query in the browser history and the token with it.
  it("refuses a POST, and runs no query on the way to refusing it", async () => {
    const res = await app.request(SEARCH_PATH, { method: "POST", body: new URLSearchParams({ q: "salisbury" }), headers: { Cookie: `${SESSION_COOKIE}=${SESSION_ID}` } }, env, execCtx);

    expect(res.status).toBe(404);
    expect(mocks.renderCalls).toEqual([]);
    expect(statements).toEqual([]);
  });
});

describe("auth", () => {
  // adminApp.use("*", requireAdminAuth) (./index:85) is the only thing gating
  // this page -- search.ts has no auth code of its own, exactly as Django
  // inherits the gate from LoginRequiredAccess rather than a decorator. So
  // the only way to know the page is gated is to drive the real chain.
  //
  // The last assertion is the one that matters. This page's results include
  // subscriber email addresses, device ids and push endpoints, and answering
  // it costs eight full table scans -- one of them over foodbankchange, 29.4 MB
  // in production. A handler that ran before the auth check would hand both
  // away to anyone who could spell the URL.
  it("redirects a request with no session cookie, and never touches the database", async () => {
    const res = await app.request(`${SEARCH_PATH}?q=salisbury`, {}, env, execCtx);

    expect(res.status).toBe(302);
    // PINNED AS-IS, AND SUSPECT. middleware/adminAuth.ts:21 builds ?next= from
    // c.req.path, which drops the query string: Django's LoginRequiredAccess
    // (givefood/middleware.py:65,69) stashes request.get_full_path(), which
    // keeps it. So a session that expires mid-search sends the maintainer back
    // to an empty search box here and back to their results in Django. Not
    // fixed here (this file adds no behaviour), and not this handler's code --
    // but /admin/search/ is the route where the divergence actually costs
    // something, since the query string IS the page.
    expect(res.headers.get("location")).toBe("/auth/?next=%2Fadmin%2Fsearch%2F");
    expect(mocks.renderCalls).toEqual([]);
    expect(statements).toEqual([]);
    expect(sessionModes).toEqual([]);
  });

  // A cookie is not a session. An expired or evicted KV entry, or a forged
  // value, must fail the same way rather than falling through to a rendered
  // page -- getAdminSession returns null on a KV miss and the middleware
  // cannot tell the two cases apart, which is the intended shape.
  it("redirects a cookie whose session is not in KV", async () => {
    const res = await app.request(`${SEARCH_PATH}?q=salisbury`, { headers: { Cookie: `${SESSION_COOKIE}=not-a-real-session` } }, env, execCtx);

    expect(res.status).toBe(302);
    expect(mocks.renderCalls).toEqual([]);
    expect(statements).toEqual([]);
  });
});

describe("the prompt state (F1/F2)", () => {
  // F1, THE ONE-CLICK 500. The navbar input has no `required` attribute and
  // no default value, so a bare Enter -- or clicking Search on an empty box --
  // sends /admin/search/ with no `q` at all. In Django `query` is then None,
  // and views.py:117's .filter(slug__icontains=None) raises
  // ValueError("Cannot use None as a query value") before anything renders.
  //
  // Here it is a prompt. All four booleans are asserted together because they
  // are only right together: `searched` false is what selects search.njk:36's
  // prompt over the "No results, have another go" line, and a `too_short`
  // that leaked true would answer a page nobody searched from with "Search for
  // at least 2 characters."
  it("renders the prompt for a bare /admin/search/ rather than 500ing as Django does", async () => {
    const res = await get();

    expect(res.status).toBe(200);
    expect(guards()).toEqual({ q: "", searched: false, too_short: false, too_long: false, results_null: true });
  });

  // F2, THE WORSE HALF. `?q=` is what the navbar's own form submits on an
  // empty box, and in Django `icontains=""` compiles to LIKE '%%', which
  // matches every non-NULL value -- ~600 arbitrary rows plus up to 300
  // subscriptions, i.e. a page of real subscriber email addresses returned for
  // a search nobody typed.
  it("renders the prompt for ?q= rather than dumping every row, as Django does", async () => {
    await get(`${SEARCH_PATH}?q=`);

    expect(guards()).toEqual({ q: "", searched: false, too_short: false, too_long: false, results_null: true });
  });

  // Neither guard state may cost a query. This is the assertion that separates
  // "the page renders nothing" from "the page IS free" -- an empty result set
  // and an unrun query look identical from the outside, and search.ts:30 is
  // written the way it is (dbSession INSIDE the ternary) so that not even a D1
  // session is opened.
  it("opens no D1 session and issues no statement for either empty query", async () => {
    await get();
    await get(`${SEARCH_PATH}?q=`);

    expect(mocks.renderCalls).toHaveLength(2);
    expect(sessionModes).toEqual([]);
    expect(statements).toEqual([]);
    expect(batches).toBe(0);
  });

  // Whitespace is not a search. `?q=+` is what a browser sends for a space
  // typed into the box (HTML form encoding turns a space into +), and
  // `?q=%20%20` is what a hand-built URL or a paste produces. Both trim to
  // empty and land on the prompt -- NOT on "too short", which would tell the
  // maintainer to type more when what they typed was nothing.
  it("treats a whitespace-only query as no query at all", async () => {
    await get(`${SEARCH_PATH}?q=+`);
    expect(guards()).toEqual({ q: "", searched: false, too_short: false, too_long: false, results_null: true });

    await get(`${SEARCH_PATH}?q=%20%20%09`);
    expect(guards()).toEqual({ q: "", searched: false, too_short: false, too_long: false, results_null: true });

    // AND IT IS FREE, which the statement log alone does not prove.
    // SURVIVED MUTANT, now killed: the ternary's guard measuring the RAW
    // query rather than the trimmed one --
    // `(c.req.query("q") ?? "").length > 0 ? await searchAdmin(...) : null`.
    // Every assertion above still reads identically, because searchAdmin
    // trims again and declines at the floor before issuing anything, so no
    // statement ever runs. What changes is invisible without sessionModes: a
    // D1 session gets opened for a query that is nothing but spaces, which is
    // the same "costs nothing" claim the two empty-query states make and the
    // only reason search.ts puts dbSession(c) INSIDE the ternary.
    expect(statements).toEqual([]);
    expect(sessionModes).toEqual([]);
    expect(batches).toBe(0);
  });
});

describe("the two refusal messages", () => {
  // F3's floor, at the route level. Django has no minimum: a single character
  // there scans every one of these tables -- foodbankchange included -- to
  // return 600 rows of noise.
  it("answers a one-character query with too_short, and runs nothing", async () => {
    await get(`${SEARCH_PATH}?q=s`);

    expect(guards()).toEqual({ q: "s", searched: true, too_short: true, too_long: false, results_null: true });
    // The number is rendered into the message ("Search for at least
    // {{ min_query_length }} characters", search.njk:38), so it is
    // user-visible text, not an internal detail -- and it comes from the
    // constant packages/db exports rather than a second copy of "2".
    expect(lastRender().context.min_query_length).toBe(ADMIN_SEARCH_MIN_QUERY_LENGTH);
    expect(ADMIN_SEARCH_MIN_QUERY_LENGTH).toBe(2);
    expect(statements).toEqual([]);
  });

  // THE MUTANT THE TRIM EXISTS TO KILL, and the reason search.ts trims before
  // measuring rather than leaving it to searchAdmin. " s " is three characters
  // long; searchAdmin trims it to one and returns null. With the route's own
  // trim removed, `too_short` is computed on length 3 and comes out FALSE,
  // `too_long` is computed as "length >= 2 and results are null" and comes out
  // TRUE -- so a maintainer who typed one letter with a trailing space is told
  // "That search is too long, try something shorter". Both the state and the
  // echoed value have to be the trimmed ones.
  it("trims before measuring, so a padded one-letter query is short and not long", async () => {
    await get(`${SEARCH_PATH}?q=%20s%20`);

    expect(guards()).toEqual({ q: "s", searched: true, too_short: true, too_long: false, results_null: true });
  });

  // THE FLOOR FROM THE INSIDE, and a survived mutant is why it is here: with
  // `<` widened to `<=` in search.ts, every test above still passed, because
  // none of them searched at exactly the minimum. A two-character query would
  // then have been answered with "Search for at least 2 characters." next to
  // the results it did find -- and two characters is what a postcode-district
  // or initials search looks like. "ol" matches "Old Sarum" and nothing else
  // in the fixture, so this also proves the search ran rather than merely
  // failing to be refused.
  it("searches at exactly the minimum length instead of refusing it", async () => {
    await get(`${SEARCH_PATH}?q=ol`);

    expect(guards()).toEqual({ q: "ol", searched: true, too_short: false, too_long: false, results_null: false });
    expect(results().foodbanks).toEqual([{ name: "Old Sarum", slug: "old-sarum", is_closed: 0 }]);
    expect(results().total).toBe(1);
    expect(statements).toHaveLength(8);
  });

  // The other end. adminSearch.ts:69's 500-character ceiling exists only so a
  // pathological paste -- a whole document into the search box -- lands on an
  // existing message instead of being scanned for; nothing in D1 requires it,
  // because instr() has no pattern limit.
  it("answers a 501-character paste with too_long, and runs nothing", async () => {
    await get(`${SEARCH_PATH}?q=${"x".repeat(501)}`);

    expect(guards()).toEqual({ q: "x".repeat(501), searched: true, too_short: false, too_long: true, results_null: true });
    expect(statements).toEqual([]);
    // A session IS opened before searchAdmin declines -- search.ts calls
    // dbSession(c) as the argument. Harmless (withSession is a local object,
    // not a round trip) and pinned so the zero-statement claim above is not
    // mistaken for a zero-session one.
    expect(sessionModes).toEqual(["first-unconstrained"]);
  });

  // The boundary itself, from the inside: 500 characters is `> MAX_QUERY_LENGTH`
  // false, so the search RUNS. Off-by-one here is invisible on the page --
  // both sides render something plausible -- and the only way to tell them
  // apart is whether the statements ran.
  it("still searches at exactly 500 characters", async () => {
    await get(`${SEARCH_PATH}?q=${"x".repeat(500)}`);

    expect(guards()).toEqual({ q: "x".repeat(500), searched: true, too_short: false, too_long: false, results_null: false });
    expect(results().total).toBe(0);
    expect(statements).toHaveLength(8);
  });
});

describe("what reaches the template", () => {
  // THE WHOLE PAYLOAD, group by group, against rows read back out of SQLite.
  // Every group here also has a seeded row that must be ABSENT: Exeter's food
  // bank, location, donation point, constituency, need, email subscriber,
  // mobile subscriber and push subscription all exist in the fixture and none
  // of them contains "salisbury". A search that ignored `q` -- the "parsed,
  // passed down, then dropped" shape of issue #34 -- renders a full-looking
  // page, and only the absences catch it.
  it("hands each group's matching rows to the template, and none of the others", async () => {
    await get(`${SEARCH_PATH}?q=salisbury`);

    // F5's ranking, which Django does not have at all (no order_by, so which
    // 100 of 1,071 rows its slice returns is plan-dependent): exact name,
    // then prefix, then anything else, open before closed inside each band.
    // "Salisbury Market" is closed and sorts after "Salisbury Plain" despite
    // sorting before it alphabetically, and "Old Sarum" is here on its
    // ADDRESS alone -- the two facts that make this an ordering assertion
    // rather than a set one.
    expect(results().foodbanks).toEqual([
      { name: "Salisbury", slug: "salisbury", is_closed: 0 },
      { name: "Salisbury Plain", slug: "salisbury-plain", is_closed: 0 },
      { name: "Salisbury Market", slug: "salisbury-market", is_closed: 1 },
      { name: "Old Sarum", slug: "old-sarum", is_closed: 0 },
    ]);

    // foodbank_name/foodbank_slug come from the _full view's join, not from a
    // stale denormalised copy (0019). Both build links on this page
    // (search.njk:77-78), and transposed they would render a location under a
    // food bank named "salisbury" linking to /admin/foodbank/Salisbury/.
    // Ayleswade is closed, so it is displayed second though it sorts first.
    expect(results().locations).toEqual([
      { name: "Bemerton Heath Centre", slug: "bemerton-heath-centre", foodbank_name: "Salisbury", foodbank_slug: "salisbury", is_closed: 0 },
      { name: "Ayleswade Road Hall", slug: "ayleswade-road-hall", foodbank_name: "Salisbury", foodbank_slug: "salisbury", is_closed: 1 },
    ]);

    expect(results().donationpoints).toEqual([
      { name: "Tesco Salisbury", slug: "tesco-salisbury", foodbank_name: "Salisbury", foodbank_slug: "salisbury", is_closed: 0 },
    ]);

    // The second row matches on `mp` -- searched, never displayed, exactly as
    // in Django -- and carries a NULL name, which search.njk:114 falls back
    // from to the slug. It reaches the template as null rather than being
    // coalesced, which is what lets the template make that choice.
    expect(results().constituencies).toEqual([
      { name: "Salisbury", slug: "salisbury" },
      { name: null, slug: "unnamed-boundary" },
    ]);

    // ORDER BY created DESC (Django's own, views.py:150-153) while the page
    // displays `modified` -- both kept. need_id_short is the first 7
    // characters, which is the link text on search.njk:128. The newer need is
    // UNASSIGNED (foodbank_id NULL) and matched on excess_change_text: an
    // INNER JOIN in place of the view's LEFT JOIN would drop it silently, and
    // an orphaned need is precisely the thing an admin comes here to find.
    expect(results().needs).toEqual([
      { need_id: "b2c3d4e5f60000000000000000000002", need_id_short: "b2c3d4e", foodbank_name: null, modified: "2026-09-03 10:00:00.000000" },
      { need_id: "a1b2c3d4e50000000000000000000001", need_id_short: "a1b2c3d", foodbank_name: "Salisbury", modified: "2026-09-01 10:00:00.000000" },
    ]);

    // Django appends the subscriber types in a fixed order and never re-sorts
    // across them, so neither does this -- email, then mobile, then webpush.
    // The unconfirmed subscriber is absent (Django's confirmed=True filter),
    // the mobile identifier is Python's `device_id[:20] + "..."`, and the
    // webpush row has browser = "" which Python truthiness renders as
    // 'Unknown' -- a COALESCE would have left it blank.
    expect(results().subscriptions).toEqual([
      { type: "email", icon: "email", identifier: "helper@salisbury.example.org", foodbank_name: "Salisbury", foodbank_slug: "salisbury" },
      { type: "mobile", icon: "cellphone", identifier: "iOS - salisbury-device-012...", foodbank_name: "Salisbury", foodbank_slug: "salisbury" },
      { type: "webpush", icon: "bell", identifier: "Unknown - https://fcm.googleapis.com/fcm...", foodbank_name: "Salisbury", foodbank_slug: "salisbury" },
    ]);

    // `total` is not rendered as a number anywhere -- search.njk:45 branches
    // on `results.total == 0` to choose the "No results" line -- so a total
    // that disagreed with the groups would show "No results, have another go"
    // above a page full of results.
    expect(results().total).toBe(14);
  });

  // The empty-handed search, which is a DIFFERENT page from the prompt and
  // from both refusals: search.njk:45-47 shows "No results, have another go"
  // only when all four guards are false and total is 0. A `searched` that
  // stayed false here would send the maintainer back to the prompt as though
  // they had never typed anything.
  it("distinguishes a search that found nothing from a search nobody made", async () => {
    await get(`${SEARCH_PATH}?q=llanfairpwllgwyngyll`);

    expect(guards()).toEqual({ q: "llanfairpwllgwyngyll", searched: true, too_short: false, too_long: false, results_null: false });
    expect(results()).toEqual({ foodbanks: [], locations: [], donationpoints: [], constituencies: [], needs: [], subscriptions: [], total: 0 });
  });

  // `q` feeds BOTH boxes -- search.njk:17's in-page form and page.njk:56's
  // navbar echo, which every other admin page leaves undefined so the box
  // renders empty. Dropped, every result page silently clears the query the
  // maintainer just ran, and refining a search means retyping it.
  //
  // It is also the only attacker-controlled string this page reflects into
  // admin HTML. Nothing is escaped here on purpose: env.ts:44 renders with
  // `autoescape: true` and search.njk uses no `|safe`, so escaping is the
  // template layer's job and stays assertable there rather than being
  // half-done in a handler.
  it("echoes the trimmed query back for both search boxes", async () => {
    await get(`${SEARCH_PATH}?q=%20Salisbury%20Plain%20`);

    expect(lastRender().context.q).toBe("Salisbury Plain");
    expect(results().foodbanks.map((row) => row.slug)).toEqual(["salisbury-plain"]);
  });

  // section = "search" matches no navbar item, so nothing highlights -- same
  // as Django, whose page.html has no search nav item either. Pinned because
  // it is invisible in every other assertion: the page looks identical with
  // the wrong section apart from which nav item is lit, and "foodbanks" would
  // be a plausible-looking wrong answer.
  it("marks the page as a section no navbar item claims", async () => {
    await get(`${SEARCH_PATH}?q=salisbury`);

    expect(lastRender().context.section).toBe("search");
  });

  // The shared admin page context has to be SPREAD IN, not replaced: without
  // it admin/page.njk has no signed-in user, no canonical path and no Google
  // keys, and admin.js throws ReferenceError on the first button click
  // (pageContext.ts:30-37 documents that failure). admin_user in particular
  // travels from the KV session through requireAdminAuth's c.set("adminUser")
  // into the render context -- three hops only a real middleware chain
  // exercises.
  it("spreads the shared admin page context in, including the signed-in user", async () => {
    await get(`${SEARCH_PATH}?q=salisbury`);

    const context = lastRender().context;
    expect(context.admin_user).toEqual(ADMIN);
    expect(context.page_context_present).toBe(true);
    expect(context.canonical_path).toBe(SEARCH_PATH);
    expect(mocks.pageContextCalls).toEqual([{ path: SEARCH_PATH }]);
    expect(context.d1_database).toBe("givefood-test");
    // pageContext.ts:39-57: `places` and the Maps JS key are deliberately
    // blanked, the static and geocode keys published. Asserted on this page
    // because a search results page is one an unauthenticated visitor must
    // never reach, and a regression that leaked keys would do it through this
    // same context object.
    expect(context.gmap_key).toBe("");
    expect(context.gmap_places_key).toBe("");
    expect(context.gmap_static_key).toBe("static-key");
  });

  // A CSRF token is issued even though this page's only form is a GET --
  // pageContext.ts:12-16 chose that deliberately. The consequence is what
  // matters here: `csrfIssued` is the flag middleware/pageCacheControl.ts
  // keys on to keep a page out of a shared cache, and this page renders
  // subscriber email addresses and push endpoints for whatever the maintainer
  // typed. A token-bearing page reaching the shared cache is a bug this repo
  // has already had in production (lib/csrf.ts's own account of it).
  it("issues a CSRF cookie and flags the response per-visitor", async () => {
    const res = await get(`${SEARCH_PATH}?q=salisbury`);

    expect(res.headers.get("set-cookie")).toContain("__Host-csrf=");
    expect(String(lastRender().context.csrf_token)).toMatch(/^[0-9a-f]{64}$/);
    // The flag, not the Set-Cookie header: a returning visitor's token is
    // REUSED and sends no cookie, which is exactly how a token-bearing page
    // reached the shared cache once already.
    expect(csrfIssued).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE GAP THE CSRF TEST ABOVE ONLY HALF-CLOSES. `csrfIssued` proves the flag
// pageCacheControl keys on is set; it does not prove this response actually
// comes back uncacheable, and the two are different claims made by different
// middleware. middleware/noStore.ts records why it matters here specifically:
// on beta 2026-09-02 Cloudflare was serving authenticated admin pages to
// anonymous visitors, and because wrangler.jsonc sets `"cache": {"enabled":
// true}` a HIT is served WITHOUT EXECUTING THE WORKER -- so requireAdminAuth
// never ran at all. No amount of correctness in the auth middleware can stop
// that; only keeping the response out of the cache can. The suite's own auth
// tests are worth exactly as much as these two.
//
// Named in that middleware's comment as the leak that was found: "the
// subscribers tab leaks subscriber identifiers". This page returns the same
// identifiers, for an arbitrary substring, across all three subscriber types
// at once.
// ---------------------------------------------------------------------------
describe("the response must never be cached", () => {
  // Read off the real response through the real chain rather than trusted
  // from noStore.ts's own suite, which exercises the middleware in isolation
  // and so cannot say what a /admin/search/ response actually carries.
  // MUTANTS KILLED: the header weakened to `public, max-age=300`; `no-store`
  // dropped for a bare `private`; the CDN-Cache-Control line deleted, which
  // is the only one Cloudflare's own edge honours on the response path and
  // so the one that actually stopped the beta leak; and Vary: Cookie deleted.
  it("comes back uncacheable, because a cache HIT would skip requireAdminAuth entirely", async () => {
    const res = await get(`${SEARCH_PATH}?q=salisbury`);

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store, max-age=0, must-revalidate");
    // The one Cloudflare's own edge honours on the response path. `private`
    // alone was not enough to stop the beta leak.
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
    expect(res.headers.get("vary")).toContain("Cookie");
    // And the page really is the PII one: asserted here rather than assumed,
    // so this test cannot pass on a page that renders nothing.
    expect(results().subscriptions.map((row) => row.identifier)).toEqual([
      "helper@salisbury.example.org",
      "iOS - salisbury-device-012...",
      "Unknown - https://fcm.googleapis.com/fcm...",
    ]);
  });

  // noStore.ts:22-24 is explicit that the header goes on the way OUT, "including
  // on the 302 that requireAdminAuth itself returns (a cached redirect would be
  // its own, milder bug)". A cached 302 would send a signed-in maintainer to
  // the sign-in page from a URL they are entitled to.
  //
  // MUTANT KILLED: noStore narrowed with an `if (c.res.status !== 200) return;`
  // -- the plausible edit, since it is what pageCacheControl.ts:127 legitimately
  // does one mount above. The 200 above stays green through it; only this fails.
  it("marks the auth redirect uncacheable too", async () => {
    const res = await app.request(`${SEARCH_PATH}?q=salisbury`, {}, env, execCtx);

    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("private, no-store, max-age=0, must-revalidate");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
  });
});

describe("the query string itself", () => {
  // The route's input is a URL-encoded string, and c.req.query() is what
  // decodes it. A handler reading the raw query string would search for the
  // literal "%25%25" and find nothing; one that dropped escapeLike would turn
  // "%%" into the wildcard pattern '%%%%' and return EVERY row in the
  // database -- the same ~600-row dump F2 exists to prevent, reachable by
  // typing two characters. Both mutants are caught by this one assertion,
  // which is why the fixture holds a row with a literal double percent in it.
  it("decodes percent-encoding and then searches for the percent literally", async () => {
    seedFoodbank({ name: "Discount 100%% Store", slug: "discount-100-store" });

    await get(`${SEARCH_PATH}?q=%25%25`);

    expect(results().foodbanks).toEqual([{ name: "Discount 100%% Store", slug: "discount-100-store", is_closed: 0 }]);
    expect(results().total).toBe(1);
  });

  // A malformed percent sequence is what a broken link or a crawler produces,
  // and decodeURIComponent throws URIError on it. Hono hands back the raw text
  // instead, so the page searches for the literal "%zz" -- pinned because a
  // 500 on a malformed URL would be an admin page that breaks on a bad
  // bookmark, and because the `%` in it still has to be escaped rather than
  // treated as a wildcard.
  it("does not 500 on a malformed percent-encoding", async () => {
    const res = await get(`${SEARCH_PATH}?q=%zz`);

    expect(res.status).toBe(200);
    expect(guards()).toEqual({ q: "%zz", searched: true, too_short: false, too_long: false, results_null: false });
    expect(results().total).toBe(0);
  });

  // Hono's query() returns the FIRST value for a repeated parameter. Worth
  // pinning because the navbar form and the in-page form both submit `q`, and
  // a hand-edited or double-submitted URL carrying two is not exotic -- the
  // failure to avoid is silently searching for the wrong one of them.
  it("searches the first q when the URL carries two", async () => {
    await get(`${SEARCH_PATH}?q=salisbury&q=exeter`);

    expect(lastRender().context.q).toBe("salisbury");
    expect(results().foodbanks.map((row) => row.slug)).not.toContain("exeter");
    expect(results().foodbanks).toHaveLength(4);
  });

  // THE PASTE THAT USED TO BE REFUSED, half one. Seven of the twelve columns
  // Django searches are URLs, so pasting a food bank's shopping list URL into
  // this box is an ordinary thing to do -- and at 60 characters its escaped
  // LIKE pattern is 62 bytes, over D1's 50-byte cap, which this harness
  // enforces. The page used to answer "That search is too long, try something
  // shorter" for a query Django searched fine; it now runs in instr() mode.
  //
  // If the instr() fallback were removed, the harness would raise D1's own
  // "LIKE or GLOB pattern too complex" and this test would 500 rather than
  // fail quietly -- which is the point of enforcing the cap here.
  it("searches a pasted shopping-list URL instead of calling it too long", async () => {
    await get(`${SEARCH_PATH}?q=${encodeURIComponent(LIST_URL)}`);

    expect(guards()).toEqual({ q: LIST_URL, searched: true, too_short: false, too_long: false, results_null: false });
    expect(results().foodbanks).toEqual([{ name: "Salisbury", slug: "salisbury", is_closed: 0 }]);
  });

  // Half two, and the longer one: a push endpoint is ~130 characters here and
  // ~190 in production, so it is over the cap by construction --
  // adminSearch.ts:66-68 names it as the longest thing anyone legitimately
  // searches for. Finding which food bank an endpoint belongs to is how a
  // failing push subscription gets traced, and it is only possible because
  // WebPushSubscription.endpoint is searched (views.py:206-207) AND the
  // over-cap query still runs.
  it("finds a push subscription from its full endpoint", async () => {
    await get(`${SEARCH_PATH}?q=${encodeURIComponent(PUSH_ENDPOINT)}`);

    expect(lastRender().context.too_long).toBe(false);
    expect(results().subscriptions).toEqual([
      { type: "webpush", icon: "bell", identifier: "Unknown - https://fcm.googleapis.com/fcm...", foodbank_name: "Salisbury", foodbank_slug: "salisbury" },
    ]);
  });
});

describe("a GET must not mutate", () => {
  // search.ts's own header: "GET only: no mutation, so no POST branch and no
  // CSRF check." The interesting failure is not a visible write but an
  // accidental one -- a search-term log table, a "recently searched" counter,
  // a cache-warming UPDATE bolted on. Any of those would also make the page's
  // one claim about its own cost untrue.
  //
  // The statement log proves both at once: eight statements, all reads, in a
  // SINGLE batch. Eight separate round trips against a replicated D1 would be
  // the same page, the same rows and eight times the latency, and nothing
  // else in the codebase would notice.
  it("issues exactly eight read statements, in one batch, over one D1 session", async () => {
    const before = allRowCounts();

    await get(`${SEARCH_PATH}?q=salisbury`);

    expect(statements).toHaveLength(8);
    expect(batches).toBe(1);
    for (const { sql } of statements) {
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE)\b/i);
      expect(sql.trimStart()).toMatch(/^SELECT\b/);
    }
    expect(allRowCounts()).toEqual(before);
    // lib/session.ts's mode, and one session per request: a second
    // withSession() call would mean a second, separately-consistent read, so
    // the six groups could disagree with each other about what the database
    // holds.
    expect(sessionModes).toEqual(["first-unconstrained"]);
  });

  // Two identical searches must return identical pages at identical cost.
  // This is the assertion a "let me just cache the answer in a table" change
  // trips over, and it matches the actual workflow: search, open a result in
  // a new tab, come back, search again.
  it("is idempotent across repeated searches", async () => {
    await get(`${SEARCH_PATH}?q=salisbury`);
    const first = results();
    statements = [];
    batches = 0;

    await get(`${SEARCH_PATH}?q=salisbury`);

    expect(results()).toEqual(first);
    expect(statements).toHaveLength(8);
    expect(batches).toBe(1);
  });
});

describe("when the query fails", () => {
  // search.ts has no try/catch, which is the right call and is worth pinning
  // as such: the defensive-looking alternative -- catching and rendering with
  // an empty result set -- would show the maintainer "No results, have
  // another go" when what actually happened is that D1 was unavailable. On a
  // page whose whole purpose is answering "does this record exist", a false
  // negative is worse than an error page, because the next thing the
  // maintainer does is create the duplicate.
  //
  // In production index.ts turns this into the rendered 500 page; this fixture
  // has no onError, so Hono's default 500 is what comes back. Either way the
  // page is not rendered, which is the assertion.
  it("lets the error surface instead of rendering an empty results page", async () => {
    env = {
      ...env,
      DB: {
        withSession: () => ({
          prepare: () => {
            throw new Error("D1_ERROR: no such table: foodbankchange_full");
          },
        }),
      },
    } as unknown as AppEnv["Bindings"];

    const res = await get(`${SEARCH_PATH}?q=salisbury`);

    expect(res.status).toBe(500);
    expect(mocks.renderCalls).toEqual([]);
  });
});
