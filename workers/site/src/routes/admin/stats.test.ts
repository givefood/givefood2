import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../types";

// routes/admin/stats.ts -- the six Settings-page stats reports
// (gfadmin/views.py:2339-2535). Every one of them is a page whose entire
// output is NUMBERS, which makes this the tier where a wrong answer is
// completely invisible: a dropped term in "Headline DP", a "Total Weight"
// that quietly lost its third decimal place, an "Items" total that no longer
// matches the two lines under it, a subscriber week silently missing from the
// chart -- none of those throw, none of them log, and every one renders a
// plausible figure the maintainer will believe.
//
// SO THIS FILE DRIVES THE PRODUCTION ROUTER OVER A REAL DATABASE, the same
// shape clearCache.test.ts uses: routes/admin/index.ts's OWN `adminApp` --
// the object that carries requireAdminAuth and the six registrations -- is
// imported and mounted at /admin, over an in-memory SQLite seeded from the
// migrations' own DDL. packages/db's queries, dbSession, adminPageContext,
// issueCsrfToken, lib/isoWeek's weekKey and the module's own money/kg/
// pythonFloat formatters are all the shipped implementations.
//
// The earlier draft of this file hand-built a Hono with six routes COPIED
// out of index.ts, which quietly made the wiring untestable. Mutating the
// real index.ts proved it: pointing /stats/needs/ at adminOrderStats,
// renaming /stats/editing/ to /stats/edits/, and adding a .post() beside the
// graph page's .get() all survived the whole suite. All three fail now.
//
// TWO THINGS ARE FAKED, BOTH BECAUSE THEY LEAVE THE MACHINE:
//   - the SESSIONS KV namespace requireAdminAuth reads, so "signed out" is a
//     reachable state that can be asserted rather than assumed;
//   - `render`, which is captured rather than executed. The context handed to
//     admin/stats.njk IS the handler's output -- an ordered array of
//     {label, value, raw} -- so asserting it directly says "this row, this
//     value, this exact string" instead of hunting through markup the
//     template owns. djangoDate and intcomma stay REAL (importOriginal), because
//     every formatted figure on these pages is formatted by the HANDLER, not
//     by the template: "£1,234.57", "1,234.57 kg" and "Sept. 5, 2026,
//     12:30 p.m." are this module's output, and a test that recomputed them
//     with the same helpers would assert nothing.
//
// WHAT THIS FILE IS NOT. packages/db/src/adminStats.test.ts already runs all
// six queries against a real engine and asserts the raw counts, grams and
// pence they return. This file does not repeat that. It asserts what the
// ROUTE does with them: the unit conversion, the currency and date
// formatting, the derived rows Django computed in Python (Headline
// Locations, Headline DP, Total Discrepancies, Items), the row ORDER and
// LABELS the template iterates, the query-parameter validation the Django
// view has none of, and the week bucketing the graph does in JS. Where the
// two overlap it is deliberate: a filter tested only through the layer that
// implements it is untested from the layer that could stop asking for it.

const captured: { template: string; context: Record<string, unknown> }[] = [];

vi.mock("@givefood/templates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@givefood/templates")>();
  return {
    ...actual,
    render: async (template: string, context: Record<string, unknown>) => {
      captured.push({ template, context });
      return `<html data-template="${template}"></html>`;
    },
  };
});

// The production admin router, with its own requireAdminAuth and its own six
// registrations. Imported after the mock only for readability -- vitest hoists
// vi.mock above every import regardless.
import { adminApp } from "./index";

// ===========================================================================
// SCHEMA
// ===========================================================================
// The tables these six views read, transcribed from packages/db/migrations/
// (0001_core.sql / 0004_subscribers.sql / 0005_orders_and_charity.sql /
// 0020_whatsappsubscriber.sql as amended by 0019_drop_foodbank_cache.sql),
// narrowed to the columns the queries touch plus every NOT NULL the inserts
// have to satisfy. Narrowed, but not simplified: the NULLABLE/NOT NULL split
// is carried over exactly, because three of the numbers on the Edit Stats
// page exist only because of it --
//
//   * `foodbank.delivery_address` NULLABLE is the whole of the "Headline DP"
//     divergence from Django (a NULL counts as "no delivery donation point"
//     here and as "yes" in Django);
//   * `foodbank.no_donation_points` NULLABLE is why "FB With DP" is a
//     COALESCE and not a bare `!= 0`;
//   * `foodbank.edited` NULLABLE is why Newest/Oldest Edit are MIN/MAX
//     aggregates rather than Django's ORDER BY ... [:1][0].
//
// A fixture that declared any of those NOT NULL would make all three tests
// below pass against an implementation that is wrong in production.
//
// foodbanklocation_full is here as the real VIEW rather than as a stand-in
// table because getEditStats counts locations THROUGH it -- a view that
// dropped or multiplied a row is one of the things that can be wrong, and a
// hand-built substitute could not catch it (migration 0019 broke four
// queries in exactly that way).
const SCHEMA = `
CREATE TABLE foodbank (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  network TEXT, phone_number TEXT, contact_email TEXT,
  delivery_address TEXT,
  address_is_administrative INTEGER NOT NULL,
  is_closed INTEGER NOT NULL,
  no_donation_points INTEGER,
  created TEXT NOT NULL, modified TEXT NOT NULL, edited TEXT
);
CREATE UNIQUE INDEX foodbank_slug_uniq ON foodbank(slug);
CREATE INDEX foodbank_edited_idx       ON foodbank(edited);

CREATE TABLE foodbanklocation (
  id INTEGER PRIMARY KEY,
  foodbank_id INTEGER NOT NULL,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  is_closed INTEGER NOT NULL,
  is_donation_point INTEGER,
  modified TEXT NOT NULL, edited TEXT
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

CREATE TABLE foodbankdonationpoint (
  id INTEGER PRIMARY KEY,
  foodbank_id INTEGER NOT NULL,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  is_closed INTEGER NOT NULL,
  modified TEXT NOT NULL
);

CREATE TABLE foodbankdiscrepancy (
  id INTEGER PRIMARY KEY,
  foodbank_id INTEGER,
  discrepancy_type TEXT NOT NULL, discrepancy_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'New',
  created TEXT NOT NULL, modified TEXT NOT NULL
);
CREATE INDEX discrepancy_status_created_idx ON foodbankdiscrepancy(status, created DESC);

CREATE TABLE foodbankchange (
  id INTEGER PRIMARY KEY,
  need_id TEXT NOT NULL, foodbank_id INTEGER,
  change_text TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 0, nonpertinent INTEGER,
  input_method TEXT NOT NULL,
  created TEXT NOT NULL, modified TEXT NOT NULL
);

CREATE TABLE foodbankchangeline (
  id INTEGER PRIMARY KEY,
  need_id INTEGER NOT NULL, foodbank_id INTEGER NOT NULL,
  item TEXT NOT NULL, type TEXT NOT NULL, category TEXT NOT NULL, group_name TEXT NOT NULL,
  created TEXT NOT NULL
);
CREATE INDEX fcl_type_idx ON foodbankchangeline(type);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  order_id TEXT NOT NULL, items_text TEXT NOT NULL, country TEXT NOT NULL,
  created TEXT NOT NULL, modified TEXT NOT NULL,
  delivery_date TEXT NOT NULL, delivery_hour INTEGER NOT NULL, delivery_datetime TEXT NOT NULL,
  weight INTEGER NOT NULL, calories INTEGER NOT NULL,
  cost INTEGER NOT NULL, actual_cost INTEGER,
  no_lines INTEGER NOT NULL, no_items INTEGER NOT NULL,
  foodbank_id INTEGER
);

CREATE TABLE foodbanksubscriber (
  id INTEGER PRIMARY KEY,
  created TEXT NOT NULL,
  foodbank_id INTEGER NOT NULL,
  email TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0,
  sub_key TEXT NOT NULL, unsub_key TEXT NOT NULL
);

CREATE TABLE webpushsubscription (
  id INTEGER PRIMARY KEY,
  created TEXT NOT NULL,
  foodbank_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, browser TEXT
);

CREATE TABLE mobilesubscriber (
  id INTEGER PRIMARY KEY,
  created TEXT NOT NULL,
  device_id TEXT NOT NULL, platform TEXT NOT NULL,
  foodbank_id INTEGER NOT NULL, donationpoint_id INTEGER
);

CREATE TABLE whatsappsubscriber (
  id INTEGER PRIMARY KEY,
  phone_number TEXT NOT NULL, foodbank_id INTEGER,
  created TEXT, last_notified TEXT
);
`;

// Every table the six views read, in one list, so "a GET mutated something"
// is a claim about the WHOLE database rather than about whichever table the
// test author happened to think of.
const ALL_TABLES = [
  "foodbank",
  "foodbanklocation",
  "foodbankdonationpoint",
  "foodbankdiscrepancy",
  "foodbankchange",
  "foodbankchangeline",
  "orders",
  "foodbanksubscriber",
  "webpushsubscription",
  "mobilesubscriber",
  "whatsappsubscriber",
] as const;

// ---------------------------------------------------------------------------
// The D1 Sessions API surface these handlers use, over node:sqlite. Copied
// from foodbankLocation.test.ts's d1Session with adminStats.test.ts's
// addition of `batch`, which three of these six views go through.
//
// batch() RUNS THE STATEMENTS IN ORDER AND RETURNS ONE RESULT PER INPUT, in
// that order, because getQuarterStats/getEditStats/getNeedStats index straight
// into the returned array (`results[2]!.results[0]`). Sequential rather than
// Promise.all so that ordering is a property of the harness rather than of the
// scheduler: a batch that reordered its results would hand the subscriber
// count to "Items Found" without erroring anywhere.
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
  return {
    prepare: (sql: string) => statement(sql, []),
    batch: async (statements: Array<{ all: () => Promise<unknown> }>) => {
      const out: unknown[] = [];
      for (const each of statements) out.push(await each.all());
      return out;
    },
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

const ORIGIN = "https://www.givefood.org.uk";
const CSRF_SECRET = "test-csrf-secret-not-a-real-one";
const SESSION_COOKIE = "__Host-gfsession=test-session-id";

let db: DatabaseSync;
let signedIn: boolean;
// Every `DB.withSession(mode)` the request made. Two separate claims read
// this: that the 400 short-circuit in adminQuarterStats happens BEFORE any
// database work (an empty array), and that every view opens its session
// "first-unconstrained" -- the read-replica mode lib/session.ts documents, and
// the one that makes these read-only pages cheap.
let withSessionModes: string[];

function insert(table: string, values: Record<string, Bindable>): void {
  const cols = Object.keys(values);
  db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((col) => values[col] ?? null));
}

// A single monotonic id across EVERY table, so no two seeded rows anywhere
// share one. Several of these numbers are sums of counts from different
// tables ("Headline Locations", "Headline DP"); an accidental id collision
// with a join that should not exist would otherwise be invisible.
let nextId = 0;
const id = () => (nextId += 1);

// TIMESTAMPS ARE IN DJANGO'S SHAPE -- "YYYY-MM-DD HH:MM:SS.ffffff", what
// str(datetime) produces and what migration 0022 normalised the whole
// database to. D1 stores these as TEXT and SQLite compares them
// lexicographically, so the shape is load-bearing rather than cosmetic: the
// quarter bounds are bare dates compared against these strings, and the
// signup graph's chronological ordering is a lexicographic ORDER BY. The two
// places a deliberately ISO/Z-suffixed literal appears are marked where they
// are used, and they are the only ones.
function seedFoodbank(row: Partial<Record<string, Bindable>> = {}): number {
  const n = id();
  insert("foodbank", {
    id: n,
    name: `Food Bank ${n}`,
    slug: `food-bank-${n}`,
    contact_email: `fb${n}@example.org`,
    delivery_address: null,
    address_is_administrative: 0,
    is_closed: 0,
    no_donation_points: 0,
    created: "2020-01-01 00:00:00.000000",
    modified: "2020-01-01 00:00:00.000000",
    edited: null,
    ...row,
  });
  return n;
}

function seedLocation(row: Partial<Record<string, Bindable>> = {}): number {
  const n = id();
  insert("foodbanklocation", {
    id: n,
    foodbank_id: 1,
    name: `Location ${n}`,
    slug: `location-${n}`,
    is_closed: 0,
    is_donation_point: null,
    modified: "2020-01-01 00:00:00.000000",
    ...row,
  });
  return n;
}

function seedDonationPoint(row: Partial<Record<string, Bindable>> = {}): number {
  const n = id();
  insert("foodbankdonationpoint", {
    id: n,
    foodbank_id: 1,
    name: `Donation Point ${n}`,
    slug: `donation-point-${n}`,
    is_closed: 0,
    modified: "2020-01-01 00:00:00.000000",
    ...row,
  });
  return n;
}

function seedDiscrepancy(status: string): void {
  const n = id();
  insert("foodbankdiscrepancy", {
    id: n,
    foodbank_id: 1,
    discrepancy_type: "phone",
    discrepancy_text: "mismatch",
    status,
    created: "2026-01-01 00:00:00.000000",
    modified: "2026-01-01 00:00:00.000000",
  });
}

function seedNeed(): void {
  const n = id();
  insert("foodbankchange", {
    id: n,
    need_id: `need-${n}`,
    foodbank_id: 1,
    change_text: "Pasta",
    published: 1,
    input_method: "typed",
    created: "2026-01-01 00:00:00.000000",
    modified: "2026-01-01 00:00:00.000000",
  });
}

function seedNeedLine(type: string, created = "2026-01-01 00:00:00.000000"): void {
  const n = id();
  insert("foodbankchangeline", {
    id: n,
    need_id: 1,
    foodbank_id: 1,
    item: `Item ${n}`,
    type,
    category: "food",
    group_name: "Ambient",
    created,
  });
}

function seedOrder(row: Partial<Record<string, Bindable>> = {}): void {
  const n = id();
  insert("orders", {
    id: n,
    order_id: `order-${n}`,
    items_text: "1 x Pasta",
    country: "England",
    created: "2026-08-01 12:00:00.000000",
    modified: "2026-08-01 12:00:00.000000",
    delivery_date: "2026-08-02",
    delivery_hour: 10,
    delivery_datetime: "2026-08-02 10:00:00.000000",
    weight: 0,
    calories: 0,
    cost: 0,
    no_lines: 1,
    no_items: 0,
    foodbank_id: 1,
    ...row,
  });
}

function seedEmailSubscriber(created: string, confirmed: number): void {
  const n = id();
  insert("foodbanksubscriber", {
    id: n,
    created,
    foodbank_id: 1,
    email: `sub${n}@example.org`,
    confirmed,
    sub_key: `sub-${n}`,
    unsub_key: `unsub-${n}`,
  });
}

function seedWebpush(created: string): void {
  const n = id();
  insert("webpushsubscription", { id: n, created, foodbank_id: 1, endpoint: `https://push.example/${n}`, p256dh: "p", auth: "a", browser: "Firefox" });
}

function seedMobile(created: string): void {
  const n = id();
  insert("mobilesubscriber", { id: n, created, device_id: `device-${n}`, platform: "iOS", foodbank_id: 1, donationpoint_id: null });
}

function seedWhatsapp(created: string): void {
  const n = id();
  insert("whatsappsubscriber", { id: n, phone_number: `+4477000000${n}`, foodbank_id: 1, created, last_notified: null });
}

// ---------------------------------------------------------------------------
// The app under test: routes/admin/index.ts's REAL adminApp, mounted at the
// same /admin prefix index.ts:637 mounts it at, wrapped only in the
// requestStartTime middleware that adminPageContext's render_time_ms needs
// (middleware/serverTiming.ts sets it in production).
//
// Nothing here re-declares a route. index.ts:83-84 creates adminApp and gates
// it once with requireAdminAuth; :233-238 register these six with .get() and
// nothing else, at the exact paths gfadmin/urls/stats.py:6-11 uses. Both of
// those facts are stats.ts's own contract ("all six are read-only GETs; there
// is no POST route and no CSRF check here") and neither is checkable from a
// router the test built for itself.
//
// Signed-in-ness is decided per REQUEST (the SESSIONS fake below reads the
// `signedIn` flag when the middleware asks it), so one app instance is enough
// and a test can still flip the flag between calls.
// ---------------------------------------------------------------------------
const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  c.set("requestStartTime", performance.now());
  await next();
});
app.route("/admin", adminApp);
// Labelled rather than left to become an unhandled rejection, so a
// regression reads as "expected 200, got 500: no such column" instead of a
// vitest crash with no route in it.
app.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));

// The six URLs gfadmin/urls/stats.py:6-11 declares, spelled exactly as Django
// spells them, trailing slash included -- these are live links off
// admin/settings.njk:18-33 and a renamed one is a dead button rather than an
// error anybody sees.
const STATS_PATHS = [
  "/admin/stats/quarter/",
  "/admin/stats/orders/",
  "/admin/stats/editing/",
  "/admin/stats/subscribers/",
  "/admin/stats/subscribers/graph/",
  "/admin/stats/needs/",
] as const;

function env(): AppEnv["Bindings"] {
  return {
    DB: {
      withSession: (mode: string) => {
        withSessionModes.push(mode);
        return d1Session(db);
      },
    },
    CSRF_SECRET,
    GMAP_STATIC_KEY: "static-key",
    GMAP_GEOCODE_KEY: "geocode-key",
    D1_DATABASE_NAME: "givefood-test",
    // getAdminSession hashes the cookie's session id into the KV key; this
    // fake answers on ANY key, so no test has to reproduce that derivation --
    // there is only ever one session in play. `signedIn` is the switch the
    // auth tests flip. expiresAt is a full TTL ahead of now so the sliding
    // refresh (adminAuth.ts:286-293) never fires.
    SESSIONS: {
      get: async () => (signedIn ? JSON.stringify({ email: "someone@givefood.org.uk", name: "Some One", givenName: "Some", picture: "", expiresAt: Date.now() + 12 * 60 * 60 * 1000 }) : null),
      put: async () => {},
      delete: async () => {},
    },
  } as unknown as AppEnv["Bindings"];
}

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

async function fetchPath(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (signedIn) headers.set("Cookie", SESSION_COOKIE);
  return app.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), env(), execCtx);
}

// The contract admin/stats.njk consumes, and therefore what the admin is
// about to be shown. Five of the six views render this.
interface StatRow {
  label: string;
  value: string | number;
  raw?: boolean;
}
interface StatsContext {
  title: string;
  section: string;
  csrf_token: string;
  d1_database: string;
  stats: StatRow[];
}

function lastRender(): { template: string; context: Record<string, unknown> } {
  const call = captured.at(-1);
  if (!call) throw new Error("render() was never called");
  return call;
}

// The body the mocked render() produces, so "the page the handler rendered is
// the page it returned" is assertable without owning any markup.
const renderedBody = (template: string) => `<html data-template="${template}"></html>`;

// Fetches a stats page and hands back both the response and the template
// context. The 200 assertion lives here so that every caller below is asserting
// numbers rather than re-checking that the page loaded at all.
async function getStats(path: string): Promise<{ res: Response; ctx: StatsContext }> {
  const res = await fetchPath(path);
  expect(res.status).toBe(200);
  // THE RENDERED PAGE IS THE RESPONSE, not merely something the handler built
  // on its way to a 200. Two mutants survived every status-and-context
  // assertion in this file before these two lines existed: one that rendered
  // the report and then returned `c.html("")` (a blank page behind a 200), and
  // one that swapped `c.html` for `c.text`, which reaches the browser as
  // text/plain and shows the admin the raw markup of their own report.
  expect(res.headers.get("Content-Type")).toMatch(/^text\/html/);
  expect(await res.clone().text()).toBe(renderedBody("admin/stats.njk"));
  const { template, context } = lastRender();
  expect(template).toBe("admin/stats.njk");
  return { res, ctx: context as unknown as StatsContext };
}

const labels = (ctx: StatsContext) => ctx.stats.map((row) => row.label);

// Reads one row by label. Throws rather than returning undefined, so a
// renamed or dropped label fails as "no such stat row" instead of quietly
// comparing undefined to undefined and passing.
function row(ctx: StatsContext, label: string): StatRow {
  const found = ctx.stats.find((each) => each.label === label);
  if (!found) throw new Error(`no stat row labelled ${label} -- have: ${labels(ctx).join(", ")}`);
  return found;
}
const valueOf = (ctx: StatsContext, label: string) => row(ctx, label).value;

function snapshotDatabase(): string {
  return JSON.stringify(ALL_TABLES.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()));
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  captured.length = 0;
  withSessionModes = [];
  nextId = 0;
  signedIn = true;
});

// ===========================================================================
// AUTH
// ===========================================================================
// Six pages that count everything the charity holds, mounted behind one
// middleware. The claim worth checking is not the status code but that the
// handler never ran: a gate that redirected AFTER querying would still bill
// the read and still leak the shape of the data through timing.
describe("the admin auth gate", () => {
  const PATHS = [
    ["/admin/stats/quarter/?start=2026-07-01&end=2026-09-30", "%2Fadmin%2Fstats%2Fquarter%2F"],
    ["/admin/stats/orders/", "%2Fadmin%2Fstats%2Forders%2F"],
    ["/admin/stats/editing/", "%2Fadmin%2Fstats%2Fediting%2F"],
    ["/admin/stats/subscribers/", "%2Fadmin%2Fstats%2Fsubscribers%2F"],
    ["/admin/stats/subscribers/graph/", "%2Fadmin%2Fstats%2Fsubscribers%2Fgraph%2F"],
    ["/admin/stats/needs/", "%2Fadmin%2Fstats%2Fneeds%2F"],
  ] as const;

  it.each(PATHS)("redirects %s to sign-in without touching the database", async (path, encoded) => {
    signedIn = false;

    const res = await fetchPath(path);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/auth/?next=${encoded}`);
    expect(captured).toHaveLength(0);
    expect(withSessionModes).toEqual([]);
  });

  // The quarter report's 400 is raised before the auth-protected work, so it
  // would be an easy thing to reach ahead of the gate. It must not be: an
  // anonymous caller learns nothing about the shape of the query string,
  // including whether it was well formed.
  it("gates the quarter report's own 400 behind sign-in too", async () => {
    signedIn = false;

    const res = await fetchPath("/admin/stats/quarter/");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fstats%2Fquarter%2F");
  });
});

// ===========================================================================
// READ-ONLY
// ===========================================================================
// stats.ts's own header: "All six are read-only GETs; none of them mutates
// anything, so there is no POST route and no CSRF check here." Both halves of
// that sentence are asserted here, because both are things a later change
// could break silently -- a POST route added without a CSRF check is a
// cross-site write, and a GET that started writing would be a mutation with
// no token protecting it at all.
describe("the read-only contract", () => {
  it("leaves every row in the database exactly as it found it", async () => {
    seedFoodbank({ id: 1, edited: "2026-09-05 12:30:00.000000" });
    seedLocation({ is_donation_point: 1 });
    seedDonationPoint();
    seedDiscrepancy("New");
    seedNeed();
    seedNeedLine("need");
    seedOrder({ weight: 1000, calories: 10, cost: 100, no_items: 2 });
    seedEmailSubscriber("2026-02-02 10:00:00.000000", 1);
    seedWebpush("2026-02-03 10:00:00.000000");
    seedMobile("2026-02-04 10:00:00.000000");
    seedWhatsapp("2026-02-05 10:00:00.000000");
    const before = snapshotDatabase();

    for (const path of [
      "/admin/stats/quarter/?start=2026-01-01&end=2026-12-31",
      "/admin/stats/orders/",
      "/admin/stats/editing/",
      "/admin/stats/subscribers/",
      "/admin/stats/subscribers/graph/",
      "/admin/stats/needs/",
    ]) {
      expect((await fetchPath(path)).status).toBe(200);
    }

    expect(snapshotDatabase()).toBe(before);
  });

  // index.ts:233-238 registers these six with .get() alone. A POST therefore
  // finds no route -- and because there IS no route, there is nothing that
  // could write without a CSRF token. This test is the tripwire on that: the
  // day someone adds a POST here it turns red, and the fix is to add the
  // verifyCsrf call stats.ts currently has no need of.
  //
  // It is a claim about the PRODUCTION registration, not about a router this
  // file wrote: adding `adminApp.post("/stats/subscribers/graph/", ...)` to
  // index.ts fails here, and used to fail nothing.
  //
  // The POST runs WITH a valid session, so the 404 proves the route is absent
  // rather than that the gate fired first and hid it.
  it("has no POST route on any of the six", async () => {
    for (const path of STATS_PATHS) {
      const res = await fetchPath(path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "start=2026-07-01" });
      expect(res.status).toBe(404);
    }
    expect(captured).toHaveLength(0);
  });

  // And signed OUT, the same POST is turned away by the gate BEFORE Hono gets
  // as far as deciding there is no route -- 302, not 404. Worth pinning
  // separately because it is the ordering that would matter on the day a POST
  // IS added here: an anonymous caller must not be able to tell a registered
  // admin route from an unregistered one, and adminApp.use("*", ...) running
  // ahead of routing is what guarantees that.
  it("turns an anonymous POST away at the gate rather than at the router", async () => {
    signedIn = false;

    for (const path of STATS_PATHS) {
      const res = await fetchPath(path, { method: "POST", body: "start=2026-07-01" });
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toContain("/auth/?next=");
    }
    expect(withSessionModes).toEqual([]);
  });

  // lib/session.ts's mode, asserted at the route rather than taken on trust.
  // These pages are anonymous, read-only aggregates over a replicated
  // database, which is exactly what "first-unconstrained" is for; a change to
  // "first-primary" would silently drop every one of them onto the primary.
  it("opens each session against a read replica", async () => {
    await fetchPath("/admin/stats/orders/");
    await fetchPath("/admin/stats/editing/");
    await fetchPath("/admin/stats/needs/");

    expect(withSessionModes).toEqual(["first-unconstrained", "first-unconstrained", "first-unconstrained"]);
  });
});

// ===========================================================================
// THE SHARED PAGE CONTEXT
// ===========================================================================
describe("the page context every stats view renders with", () => {
  // DELIBERATE DIVERGENCE, recorded so that "fixing" it back to Django's
  // value is a visible decision. Django passes section="stats", which matches
  // no nav item in gfadmin/templates/admin/page.html:35-41, so nothing ever
  // highlights. The port passes "settings" -- these pages are reachable only
  // from /admin/settings/ (admin/settings.njk:18-33), so the nav says where
  // you came from rather than saying nothing.
  it.each([
    ["/admin/stats/quarter/?start=2026-07-01&end=2026-09-30", "Quarter"],
    ["/admin/stats/orders/", "Order"],
    ["/admin/stats/editing/", "Edit"],
    ["/admin/stats/subscribers/", "Subscriber"],
    ["/admin/stats/needs/", "Need"],
  ])("highlights Settings and titles %s as %s", async (path, title) => {
    const { ctx } = await getStats(path);

    expect(ctx.section).toBe("settings");
    expect(ctx.title).toBe(title);
    expect(ctx.d1_database).toBe("givefood-test");
  });

  it("gives the graph page the same Settings highlight, on its own template", async () => {
    const res = await fetchPath("/admin/stats/subscribers/graph/");

    expect(res.status).toBe(200);
    expect(lastRender().template).toBe("admin/sub_graph.njk");
    expect(lastRender().context.section).toBe("settings");
  });

  // adminPageContext issues a CSRF token on EVERY admin page, including the
  // six here that have no form to submit. That is not free: issueCsrfToken
  // sets a __Host-csrf cookie, which makes the response per-visitor and
  // therefore uncacheable in any shared cache. Pinned because a stats page
  // that lost its Set-Cookie would look identical and be a different
  // caching object -- and because a token that stopped being 64 hex
  // characters would break every OTHER admin form that shares the cookie.
  it("issues a CSRF token and cookie even though these pages have no form", async () => {
    const { res, ctx } = await getStats("/admin/stats/subscribers/");

    expect(ctx.csrf_token).toMatch(/^[0-9a-f]{64}$/);
    expect(res.headers.get("Set-Cookie")).toContain("__Host-csrf=");
  });
});

// ===========================================================================
// adminQuarterStats -- gfadmin/views.py:2339-2386
// ===========================================================================
// The Dated Stats form on /admin/settings/, and the one stats view that takes
// input. Django hands request.GET.get("start") -- which may be None -- straight
// to datetime.strptime, so a bookmarked or hand-edited URL raises a TypeError
// and 500s. The port answers 400 with a sentence saying what is wrong.
describe("adminQuarterStats: the query parameters", () => {
  const REJECTION = "start and end query parameters are required, in YYYY-MM-DD format";

  // Each of these is a URL a human can actually produce: a bookmark from
  // before the form existed, a hand-edited quarter, a copy-paste of a
  // timestamp, and a date that looks fine until you count the days in
  // February. All four reach the same sentence rather than a stack trace.
  it.each([
    ["neither parameter", "/admin/stats/quarter/"],
    ["only a start", "/admin/stats/quarter/?start=2026-07-01"],
    ["only an end", "/admin/stats/quarter/?end=2026-09-30"],
    ["an empty start", "/admin/stats/quarter/?start=&end=2026-09-30"],
    ["an unpadded month", "/admin/stats/quarter/?start=2026-7-1&end=2026-09-30"],
    ["a full timestamp", "/admin/stats/quarter/?start=2026-07-01T00:00:00Z&end=2026-09-30"],
    ["a British-order date", "/admin/stats/quarter/?start=01-07-2026&end=2026-09-30"],
    ["a day February does not have", "/admin/stats/quarter/?start=2026-02-31&end=2026-09-30"],
    ["a thirteenth month", "/admin/stats/quarter/?start=2026-13-01&end=2026-09-30"],
    ["a two-digit year that JS would map to the 1900s", "/admin/stats/quarter/?start=0050-01-01&end=2026-09-30"],
  ])("refuses %s with a 400 and no query", async (_name, path) => {
    seedOrder({ created: "2026-08-01 12:00:00.000000", weight: 1000 });

    const res = await fetchPath(path);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe(REJECTION);
    // THE POINT: refused BEFORE any database work, so a malformed bookmark
    // costs nothing, and refused as text rather than as a rendered page, so
    // there is no half-populated report to misread.
    expect(withSessionModes).toEqual([]);
    expect(captured).toHaveLength(0);
  });

  // The date the round-trip check is FOR. `2026-02-31` passes the regex; only
  // re-serialising Date.UTC(2026, 1, 31) and comparing it back to the input
  // catches that JS rolled it forward to 3 March. Without that the report
  // would run silently over the wrong window.
  it("does not silently roll an impossible date forward into a real one", async () => {
    const res = await fetchPath("/admin/stats/quarter/?start=2026-02-31&end=2026-03-31");

    expect(res.status).toBe(400);
  });

  it("accepts a leap day in a leap year", async () => {
    const { ctx } = await getStats("/admin/stats/quarter/?start=2024-02-29&end=2024-02-29");

    expect(valueOf(ctx, "Start Date")).toBe("Feb. 29, 2024");
  });

  it("rejects the same day in a non-leap year", async () => {
    expect((await fetchPath("/admin/stats/quarter/?start=2025-02-29&end=2025-03-31")).status).toBe(400);
  });

  // SUSPECT, pinned rather than fixed. An end before the start is not
  // rejected: the range is empty, so every figure comes back 0 and the page
  // renders as though the quarter genuinely had no activity. Django does not
  // validate this either (views.py:2343-2344 only strptimes), so this is
  // faithful -- but a mistyped year is indistinguishable from a quiet quarter.
  it("renders an inverted date range as a quarter in which nothing happened", async () => {
    seedOrder({ created: "2026-08-01 12:00:00.000000", weight: 5000, cost: 1000, no_items: 3, calories: 99 });

    const { ctx } = await getStats("/admin/stats/quarter/?start=2026-09-30&end=2026-07-01");

    expect(valueOf(ctx, "Deliveries")).toBe(0);
    expect(valueOf(ctx, "Weight")).toBe("0.00 kg");
    expect(valueOf(ctx, "Cost")).toBe("£0.00");
  });
});

describe("adminQuarterStats: the report", () => {
  // One seeding function used by every test in this block, so the boundary
  // rows are present whether or not the test is about them. Two orders sit
  // exactly on the bounds and two sit exactly outside: without the outside
  // pair, a query that dropped its WHERE clause entirely would pass every
  // assertion here.
  function seedQuarter(): void {
    // ON the start date, at midnight -- the inclusive lower bound.
    seedOrder({ created: "2026-07-01 00:00:00.000000", weight: 1000000, calories: 500000, cost: 100000, no_items: 100 });
    seedOrder({ created: "2026-08-15 12:00:00.000000", weight: 234567, calories: 123456, cost: 23456, no_items: 23 });
    // THE DELIBERATE DIVERGENCE, seeded as its own row: the last instant of
    // the END date. Django filters `created__lte=end_date` where end_date is
    // that day at 00:00:00, so this order -- and every order on the last day
    // of every quarterly report Django has ever produced -- is missing from
    // its figures. The port's half-open [start, end+1day) range includes it.
    seedOrder({ created: "2026-09-30 23:59:59.999999", weight: 1, calories: 1, cost: 1, no_items: 1 });
    // Outside, by one second either way.
    seedOrder({ created: "2026-06-30 23:59:59.999999", weight: 9_000_000, calories: 9_000_000, cost: 9_000_000, no_items: 9000 });
    seedOrder({ created: "2026-10-01 00:00:00.000000", weight: 9_000_000, calories: 9_000_000, cost: 9_000_000, no_items: 9000 });

    seedFoodbank({ edited: "2026-07-01 00:00:00.000000" });
    seedFoodbank({ edited: "2026-09-30 18:00:00.000000" });
    seedFoodbank({ edited: "2026-06-30 23:59:59.999999" });
    seedFoodbank({ edited: "2026-10-01 00:00:01.000000" });
    seedFoodbank({ edited: null });

    // FOUR in the window, deliberately not the same number as any other count
    // on this page. Every figure here comes out of a different table filtered
    // by the SAME pair of bounds, so a row wired to its neighbour's batch slot
    // is invisible the moment two of them happen to be equal -- which is
    // exactly what a first draft of this fixture did (Edits and Subscriptions
    // were both 2, and "Edits reads the subscriber count" survived mutation).
    seedEmailSubscriber("2026-07-15 09:00:00.000000", 1);
    seedEmailSubscriber("2026-08-20 09:00:00.000000", 0);
    seedEmailSubscriber("2026-08-21 09:00:00.000000", 1);
    seedEmailSubscriber("2026-09-30 09:00:00.000000", 1);
    seedEmailSubscriber("2026-06-01 09:00:00.000000", 1);

    // FIVE in the window, for the same reason.
    seedNeedLine("need", "2026-07-02 09:00:00.000000");
    seedNeedLine("excess", "2026-08-02 09:00:00.000000");
    seedNeedLine("need", "2026-08-03 09:00:00.000000");
    seedNeedLine("need", "2026-08-04 09:00:00.000000");
    seedNeedLine("need", "2026-09-30 09:00:00.000000");
    seedNeedLine("need", "2026-10-02 09:00:00.000000");
  }

  const QUARTER = "/admin/stats/quarter/?start=2026-07-01&end=2026-09-30";

  // The row ORDER is the page: admin/stats.njk iterates the array and prints
  // it, so a reordered array is a reordered report. Labels are verbatim from
  // views.py:2367-2378 and a renamed one is a change the maintainer would
  // notice on the page but nothing else would.
  it("prints the ten rows Django prints, in Django's order", async () => {
    seedQuarter();

    const { ctx } = await getStats(QUARTER);

    expect(labels(ctx)).toEqual(["Start Date", "End Date", "Deliveries", "Items", "Weight", "Calories", "Cost", "Edits", "Subscriptions", "Items Found"]);
  });

  // Django renders the two dates through DATETIME_FORMAT, because strptime
  // produced a midnight datetime -- so its report says "Sept. 30, 2026,
  // midnight". The user typed a date, so the meaningless time is dropped.
  // "Sept." rather than "Sep." is Django's MONTHS_AP, not an abbreviation.
  it("echoes the dates back in Django's date format, without the phantom midnight", async () => {
    seedQuarter();

    const { ctx } = await getStats(QUARTER);

    expect(valueOf(ctx, "Start Date")).toBe("July 1, 2026");
    expect(valueOf(ctx, "End Date")).toBe("Sept. 30, 2026");
    expect(row(ctx, "Start Date").raw).toBe(true);
    expect(row(ctx, "End Date").raw).toBe(true);
  });

  // The whole window, counted. Every number here includes the boundary rows
  // and excludes the two just outside; three separate tables are filtered by
  // the same pair of bounds, and a bound bound to the wrong slot in any of
  // them shows up as one of these five numbers moving.
  //
  // WHAT "INCLUSIVE AT THE LOWER END" IS AND IS NOT. It is a claim about the
  // BOUND STRING -- "2026-07-01", the bare date -- not about the `>=`
  // operator: turning that into `>` survives this file, measured rather than
  // assumed, because every stored `created` carries a time component and
  // "2026-07-01 00:00:00.000000" sorts above the bare date either way. The
  // operator only becomes load-bearing if a caller ever passes a full
  // timestamp as the lower bound, which is why getQuarterStats' signature
  // documents both bounds as "YYYY-MM-DD".
  it("counts the window inclusively at both ends and stops at both", async () => {
    seedQuarter();

    const { ctx } = await getStats(QUARTER);

    // 3 of the 5 orders: both boundary rows in, both outside rows out.
    expect(valueOf(ctx, "Deliveries")).toBe(3);
    expect(valueOf(ctx, "Items")).toBe(124);
    expect(valueOf(ctx, "Calories")).toBe(623457);
    // 2 of the 5 food banks -- and NOT the one whose `edited` is NULL, which
    // is the row Django's own ORDER BY handling trips over elsewhere.
    expect(valueOf(ctx, "Edits")).toBe(2);
    // All four in-window sign-ups, CONFIRMED OR NOT. views.py:2364 has no
    // confirmed filter either: this is "how many people started subscribing",
    // not "how many finished". Seeding one unconfirmed among them is what
    // makes that a checked claim rather than a coincidence.
    expect(valueOf(ctx, "Subscriptions")).toBe(4);
    expect(valueOf(ctx, "Items Found")).toBe(5);
  });

  // The two unit conversions, which live in the ROUTE and not in the SQL --
  // grams and pence come out of D1 whole, precisely so that SQLite's
  // integer-truncating `/` never sees them.
  //
  // Django writes money as `"£%s" % round(cost / 100, 2)` and then pipes it
  // through |intcomma, whose regex cannot match past a leading "£" -- so the
  // Cost line is never thousands-grouped in Django, and a whole-pound total
  // renders as "£1.0". Grouping the number BEFORE prefixing the symbol, at a
  // fixed 2dp, is this port's house style for money and is what these two
  // strings pin.
  it("converts grams to kilograms and pence to pounds, grouped and to 2dp", async () => {
    seedQuarter();

    const { ctx } = await getStats(QUARTER);

    // 1,000,000 + 234,567 + 1 = 1,234,568 g -> 1234.568 kg, rounded for display.
    expect(valueOf(ctx, "Weight")).toBe("1,234.57 kg");
    // 100,000 + 23,456 + 1 = 123,457p -> £1,234.57.
    expect(valueOf(ctx, "Cost")).toBe("£1,234.57");
    // Both are already display strings; `raw` is what stops admin/stats.njk
    // running |intcomma over them a second time. Without it "1,234.57 kg"
    // would be re-grouped and "£1,234.57" would be left alone only by luck.
    expect(row(ctx, "Weight").raw).toBe(true);
    expect(row(ctx, "Cost").raw).toBe(true);
  });

  // The counts are handed over as NUMBERS with no `raw` flag, because
  // admin/stats.njk applies |intcomma to exactly those. Pinned as types
  // rather than strings: a handler that started pre-formatting them would
  // double-group them in the template.
  it("hands the counts over unformatted, for the template to group", async () => {
    seedQuarter();

    const { ctx } = await getStats(QUARTER);

    for (const label of ["Deliveries", "Items", "Calories", "Edits", "Subscriptions", "Items Found"]) {
      expect(typeof valueOf(ctx, label)).toBe("number");
      expect(row(ctx, label).raw).toBeUndefined();
    }
  });

  // A single day is a legal range: start === end covers exactly that day,
  // because the exclusive bound is start + 1 day. The Settings form cannot
  // produce this, but a hand-edited URL can, and "one day" reading as "no
  // days" would be a silent zero.
  it("treats start === end as that one whole day", async () => {
    seedOrder({ created: "2026-08-15 00:00:00.000000", weight: 2000, cost: 500, no_items: 4, calories: 40 });
    seedOrder({ created: "2026-08-15 23:59:59.999999", weight: 3000, cost: 700, no_items: 6, calories: 60 });
    seedOrder({ created: "2026-08-16 00:00:00.000000", weight: 9000, cost: 900, no_items: 9, calories: 90 });

    const { ctx } = await getStats("/admin/stats/quarter/?start=2026-08-15&end=2026-08-15");

    expect(valueOf(ctx, "Deliveries")).toBe(2);
    expect(valueOf(ctx, "Weight")).toBe("5.00 kg");
  });

  // The end bound crosses a month AND a year here: 31 Dec is in, 1 Jan is out.
  //
  // AN EARLIER VERSION OF THIS COMMENT CLAIMED MORE THAN THE TEST DELIVERS,
  // and the mutant was run rather than imagined. It said an `endExclusive`
  // built by incrementing the day component would produce "2026-12-32" and
  // match nothing; that mutant SURVIVES. The bounds are compared against TEXT
  // timestamps lexicographically, and "2026-12-32" sits above every
  // "2026-12-31 ..." row and below every "2027-..." one, so it behaves
  // identically to the real +24h roll for every value this column can hold.
  // What this test does pin is that the upper bound is EXCLUSIVE and lands on
  // the right day: making it inclusive-of-midnight (Django's own off-by-a-day)
  // or dropping the roll entirely both fail here.
  it("rolls the exclusive end bound over a year boundary", async () => {
    seedOrder({ created: "2026-12-31 23:00:00.000000", weight: 4000, cost: 400, no_items: 4, calories: 40 });
    seedOrder({ created: "2027-01-01 00:00:00.000000", weight: 8000, cost: 800, no_items: 8, calories: 80 });

    const { ctx } = await getStats("/admin/stats/quarter/?start=2026-10-01&end=2026-12-31");

    expect(valueOf(ctx, "Deliveries")).toBe(1);
    expect(valueOf(ctx, "Weight")).toBe("4.00 kg");
  });

  // An empty quarter must render as a page of zeros, not as a 500. Django's
  // own view divides Sum()'s None by 1000 and raises a TypeError here
  // (views.py:2433 is the same shape); the COALESCEs in getQuarterStats are
  // what make this a report saying "nothing happened".
  it("renders an empty quarter as zeros rather than raising", async () => {
    const { ctx } = await getStats(QUARTER);

    expect(valueOf(ctx, "Deliveries")).toBe(0);
    expect(valueOf(ctx, "Items")).toBe(0);
    expect(valueOf(ctx, "Weight")).toBe("0.00 kg");
    expect(valueOf(ctx, "Cost")).toBe("£0.00");
    expect(valueOf(ctx, "Items Found")).toBe(0);
  });

  // The rows the port itself writes are ISO/Z-suffixed (pyNow()), while the
  // pg-to-D1 import wrote the space-separated shape. The bounds are bare
  // date strings precisely so a TEXT comparison sorts identically against
  // both -- 'T' (0x54) and ' ' (0x20) only differ once you are past the date.
  it("filters both stored timestamp shapes with the same bare-date bounds", async () => {
    seedOrder({ created: "2026-08-15T09:00:00.000Z", weight: 1000, cost: 100, no_items: 1, calories: 10 });
    seedOrder({ created: "2026-08-15 09:00:00.000000", weight: 1000, cost: 100, no_items: 1, calories: 10 });

    const { ctx } = await getStats(QUARTER);

    expect(valueOf(ctx, "Deliveries")).toBe(2);
    expect(valueOf(ctx, "Weight")).toBe("2.00 kg");
  });
});

// ===========================================================================
// adminEditStats -- gfadmin/views.py:2389-2422
// ===========================================================================
describe("adminEditStats", () => {
  // ONE FIXTURE, BUILT SO EVERY TERM IS A DIFFERENT SIZE. "Headline DP" is a
  // sum of four independent counts (5 + 3 + 2 + 1); if any two were equal, a
  // dropped or duplicated term could still add up. They are not, so it
  // cannot.
  function seedEstate(): void {
    // fb1: ordinary. Non-administrative address, a real delivery address, 3
    // donation points, and the NEWEST edit.
    seedFoodbank({ id: 1, delivery_address: "1 Depot Road", address_is_administrative: 0, no_donation_points: 3, edited: "2026-09-05 12:30:00.000000" });
    // fb2: administrative address, NULL delivery address, NULL donation
    // point count. The row that exists to prove all three NULL rules.
    seedFoodbank({ id: 2, delivery_address: null, address_is_administrative: 1, no_donation_points: null, edited: "2020-03-01 09:00:00.000000" });
    // fb3: empty-string delivery address and a zero count -- the "no" answers
    // spelled the other way.
    seedFoodbank({ id: 3, delivery_address: "", address_is_administrative: 0, no_donation_points: 0, edited: null });
    // fb4: CLOSED. Django counts closed food banks here and so does the port:
    // this page is "how big is the data estate", not "how much is live".
    // Without this row a stray is_closed filter would pass every assertion.
    seedFoodbank({ id: 4, delivery_address: "2 Other Road", address_is_administrative: 0, no_donation_points: 1, is_closed: 1, edited: "2024-06-06 06:06:00.000000" });

    seedLocation({ foodbank_id: 1, is_donation_point: 1 });
    seedLocation({ foodbank_id: 1, is_donation_point: null });
    seedLocation({ foodbank_id: 4, is_donation_point: 0, is_closed: 1 });

    seedDonationPoint({ foodbank_id: 1 });
    seedDonationPoint({ foodbank_id: 1 });
    seedDonationPoint({ foodbank_id: 2 });
    seedDonationPoint({ foodbank_id: 3 });
    seedDonationPoint({ foodbank_id: 4, is_closed: 1 });

    seedDiscrepancy("New");
    seedDiscrepancy("New");
    seedDiscrepancy("New");
    seedDiscrepancy("Done");
    seedDiscrepancy("Done");
    seedDiscrepancy("Invalid");
    // A status outside DISCREPANCY_STATUSES. Nothing produces one today, but
    // the sum-the-groups design exists so that if one ever appears the Total
    // still equals what the three lines below it are drawn from.
    seedDiscrepancy("Superseded");
  }

  it("prints the thirteen rows Django prints, in Django's order", async () => {
    seedEstate();

    const { ctx } = await getStats("/admin/stats/editing/");

    expect(labels(ctx)).toEqual([
      "Total Food Banks",
      "Total Locations",
      "Headline Locations",
      "Donation Points",
      "Headline DP",
      "FB With DP",
      "Newest Edit",
      "Oldest Edit",
      "Total Discrepancies",
      "Discrepancies Outstanding",
      "Discrepancies Invalid",
      "Discrepancies Done",
    ]);
  });

  // Closed rows counted, in all three tables at once. Seeded as its own claim
  // because the DEFAULT for a list page in this admin is to exclude them
  // (lists.ts does, adminDashboardStats.ts does) -- so "no is_closed filter"
  // is the surprising choice, and the one worth a test that fails if someone
  // "tidies" it.
  it("counts closed food banks, locations and donation points", async () => {
    seedEstate();

    const { ctx } = await getStats("/admin/stats/editing/");

    expect(valueOf(ctx, "Total Food Banks")).toBe(4);
    expect(valueOf(ctx, "Total Locations")).toBe(3);
    expect(valueOf(ctx, "Donation Points")).toBe(5);
  });

  // views.py:2393 -- a Python addition, ported as a Python addition. It is
  // "headline" because the public site counts a food bank's own address as a
  // location alongside its named ones.
  it("adds the food banks into Headline Locations", async () => {
    seedEstate();

    const { ctx } = await getStats("/admin/stats/editing/");

    expect(valueOf(ctx, "Headline Locations")).toBe(7); // 3 locations + 4 food banks
  });

  // views.py:2396, the four-term sum, with every term a different size:
  //   5 donation points
  // + 3 food banks with a non-administrative address (fb1, fb3, fb4)
  // + 2 food banks with a real delivery address (fb1, fb4)
  // + 1 location flagged is_donation_point
  // = 11.
  //
  // DELIBERATE DIVERGENCE, and this is the row it lands on. Django's
  // `.exclude(delivery_address="")` compiles to
  // NOT (delivery_address = '' AND delivery_address IS NOT NULL), which is
  // TRUE for NULL -- so Django counts fb2's NULL delivery address as HAVING a
  // delivery donation point and reports 12. The port follows the model's own
  // per-row rule (foodbank.py:514, `if self.delivery_address:`), which treats
  // NULL and "" alike, and reports 11.
  //
  // WHAT THIS CANNOT SEE, said out loud rather than left to be discovered:
  // the four terms are only ever ADDED, so swapping two of them inside
  // getEditStats' return object leaves 11 as 11. That mutant was run and it
  // survives here; it dies in packages/db/src/adminStats.test.ts:798-799,
  // which asserts nonAdminAddress and withDeliveryAddress as separate
  // numbers. The route's job is the arithmetic, and the arithmetic is what is
  // pinned: drop a term, duplicate a term, or reorder the row and this fails.
  it("sums the four Headline DP terms, counting a NULL delivery address as none", async () => {
    seedEstate();

    const { ctx } = await getStats("/admin/stats/editing/");

    expect(valueOf(ctx, "Headline DP")).toBe(11);
  });

  // views.py:2406's .exclude(no_donation_points=0). The column is NULLABLE in
  // D1 though Django's model declares it not, and getEditStats writes
  // COALESCE(no_donation_points, 0) != 0 to restore default=0 semantics.
  //
  // MEASURED: deleting that COALESCE survives this test, and it is right that
  // it does. adminStats.ts's comment says a bare `!= 0` "would silently drop
  // the NULL rows", which is true of the WHERE clause Django compiles but NOT
  // of the CASE expression the port actually uses -- `CASE WHEN NULL != 0
  // THEN 1 ELSE 0 END` already yields 0, the same answer the COALESCE gives.
  // The COALESCE is therefore belt-and-braces rather than the load-bearing
  // part, and this test pins the ANSWER (a NULL is not a food bank with
  // donation points), which is the thing that must not change if the query is
  // ever rewritten into the WHERE form where it does matter.
  it("treats a NULL donation-point count as zero for FB With DP", async () => {
    seedEstate();

    const { ctx } = await getStats("/admin/stats/editing/");

    expect(valueOf(ctx, "FB With DP")).toBe(2); // fb1 (3) and fb4 (1); fb2 NULL and fb3 0 are not
  });

  // Django's bare `{{ datetime }}` is DATETIME_FORMAT, "N j, Y, P" -- never a
  // raw D1 timestamp. The two values here are deliberately at 12:30 and 09:00
  // so that both halves of Django's P format are exercised: the 12-hour clock
  // AND the dropped ":00".
  it("renders the newest and oldest edits in Django's datetime format", async () => {
    seedEstate();

    const { ctx } = await getStats("/admin/stats/editing/");

    expect(valueOf(ctx, "Newest Edit")).toBe("Sept. 5, 2026, 12:30 p.m.");
    expect(valueOf(ctx, "Oldest Edit")).toBe("March 1, 2020, 9 a.m.");
    expect(row(ctx, "Newest Edit").raw).toBe(true);
    expect(row(ctx, "Oldest Edit").raw).toBe(true);
  });

  // fb3 has never been edited, and its NULL is why these are MIN/MAX
  // aggregates rather than Django's `order_by("-edited")[:1][0]`. Under
  // Postgres, DESC defaults to NULLS FIRST, so Django's "Newest Edit" prints
  // "None" the moment ONE food bank has never been edited; under SQLite the
  // same construct would break "Oldest Edit" instead. MIN/MAX ignore NULLs on
  // both engines, which is why fb3 changes neither number.
  it("ignores a never-edited food bank at both ends", async () => {
    seedEstate();

    const { ctx } = await getStats("/admin/stats/editing/");

    expect(valueOf(ctx, "Oldest Edit")).not.toBe("");
    expect(valueOf(ctx, "Newest Edit")).toBe("Sept. 5, 2026, 12:30 p.m.");
  });

  // Total is the SUM OF EVERY GROUP, not its own COUNT(*), so the "Superseded"
  // row is inside it: 3 New + 2 Done + 1 Invalid + 1 Superseded = 7, while the
  // three lines under it only account for 6. That is the design -- the total
  // can never be smaller than its parts -- and a total of 6 here would mean
  // someone had narrowed it to the three known statuses and made a row
  // disappear from the page entirely.
  it("counts a status nobody expected into the Total, not out of it", async () => {
    seedEstate();

    const { ctx } = await getStats("/admin/stats/editing/");

    expect(valueOf(ctx, "Total Discrepancies")).toBe(7);
    expect(valueOf(ctx, "Discrepancies Outstanding")).toBe(3);
    expect(valueOf(ctx, "Discrepancies Done")).toBe(2);
    expect(valueOf(ctx, "Discrepancies Invalid")).toBe(1);
  });

  // The three named statuses are read out of a Record by key. A status with
  // no rows is absent from the GROUP BY entirely, and `?? 0` is what turns
  // that absence into a zero instead of an `undefined` rendering as empty.
  it("prints zero for a status with no rows, not a blank", async () => {
    seedDiscrepancy("New");

    const { ctx } = await getStats("/admin/stats/editing/");

    expect(valueOf(ctx, "Discrepancies Done")).toBe(0);
    expect(valueOf(ctx, "Discrepancies Invalid")).toBe(0);
    expect(valueOf(ctx, "Total Discrepancies")).toBe(1);
  });

  // An empty database renders a page of zeros and two EMPTY date cells.
  // Django raises IndexError here -- `order_by("edited")[:1][0]` on an empty
  // queryset -- so this whole page 500s on a fresh install. The empty string
  // is deliberate: djangoDate's own contract for a null is "", so the row
  // stays on the page saying "we have never edited anything".
  it("renders an empty estate as zeros and blank dates rather than raising", async () => {
    const { ctx } = await getStats("/admin/stats/editing/");

    expect(valueOf(ctx, "Total Food Banks")).toBe(0);
    expect(valueOf(ctx, "Headline Locations")).toBe(0);
    expect(valueOf(ctx, "Headline DP")).toBe(0);
    expect(valueOf(ctx, "Newest Edit")).toBe("");
    expect(valueOf(ctx, "Oldest Edit")).toBe("");
    expect(valueOf(ctx, "Total Discrepancies")).toBe(0);
  });

  // The locations count comes through the foodbanklocation_full VIEW, whose
  // LEFT JOIN is the thing migration 0019 introduced. An orphaned location --
  // a foodbank_id pointing at nothing, which the schema does not forbid --
  // must still be counted: an INNER JOIN here would silently shrink the
  // estate, which is exactly the class of breakage 0019 caused elsewhere.
  it("counts a location whose food bank is missing, because the view LEFT JOINs", async () => {
    seedFoodbank({ id: 1 });
    seedLocation({ foodbank_id: 1, is_donation_point: 1 });
    seedLocation({ foodbank_id: 999, is_donation_point: 1 });

    const { ctx } = await getStats("/admin/stats/editing/");

    expect(valueOf(ctx, "Total Locations")).toBe(2);
    expect(valueOf(ctx, "Headline Locations")).toBe(3);
    // ...and the orphan's donation-point flag still counts towards Headline DP.
    expect(valueOf(ctx, "Headline DP")).toBe(2 + 1); // 0 DPs + 1 non-admin address + 0 delivery + 2 flagged locations
  });
});

// ===========================================================================
// adminOrderStats -- gfadmin/views.py:2425-2454
// ===========================================================================
// The one page whose numbers must NOT be rounded to 2dp. Django hands
// stats.html bare Python floats here, and |intcomma under USE_L10N routes them
// through numberformat.format with decimal_pos=None -- which is str(value)
// with the integer part grouped. So Django prints "200,123.456" where a
// .toFixed(2) would print "200,123.46" and silently drop a decimal place off
// the charity's all-time delivered weight.
describe("adminOrderStats", () => {
  function seedAllTime(): void {
    // 200,123,456 g total -> 200,123.456 kg. Chosen because the third decimal
    // place is the one a .toFixed(2) would eat.
    seedOrder({ created: "2020-01-01 00:00:00.000000", weight: 200_000_000, calories: 1_000_000, cost: 1_000_000, no_items: 5000 });
    seedOrder({ created: "2026-08-01 00:00:00.000000", weight: 123_456, calories: 234_567, cost: 234_560, no_items: 678 });
  }

  it("prints the six rows Django prints, in Django's order", async () => {
    seedAllTime();

    const { ctx } = await getStats("/admin/stats/orders/");

    // Django's own missing units are kept: "Total Weight" is kilograms and
    // "Total Cost" is pounds, and neither the label nor the value says so.
    // Left exactly as the maintainer wrote them rather than quietly
    // relabelled -- a renamed label here is a change to a page someone reads.
    expect(labels(ctx)).toEqual(["Total Weight", "Total Calories", "Total Items", "Total Orders", "Total Cost", "Total Weight (inc. packaging)"]);
  });

  // THE ASSERTION THIS WHOLE BLOCK EXISTS FOR. 200,123.456 kg, all three
  // decimals intact. A .toFixed(2) anywhere on this path prints
  // "200,123.46"; a `/1000` done in SQL prints "200,123" (SQLite truncates
  // integer division). Both are wrong and both look completely plausible.
  it("keeps every decimal place of the all-time weight, grouped but not rounded", async () => {
    seedAllTime();

    const { ctx } = await getStats("/admin/stats/orders/");

    expect(valueOf(ctx, "Total Weight")).toBe("200,123.456");
    expect(row(ctx, "Total Weight").raw).toBe(true);
  });

  // 1,234,560p -> 12,345.6. The trailing zero DROPS, because Python's
  // str(12345.6) is "12345.6" and JS's String() agrees; a .toFixed(2) would
  // print "12,345.60" and diverge from every figure Django has published.
  it("prints the all-time cost the way Python's str() would, trailing zero dropped", async () => {
    seedAllTime();

    const { ctx } = await getStats("/admin/stats/orders/");

    expect(valueOf(ctx, "Total Cost")).toBe("12,345.6");
    expect(row(ctx, "Total Cost").raw).toBe(true);
  });

  // views.py:2434-2435 -- the ONE figure on this page Django does round
  // before str()ing it, and the only place PACKAGING_WEIGHT_PC (1.18,
  // givefood/const/general.py:136) appears. 200,123.456 * 1.18 = 236,145.67808,
  // rounded to 236,145.68. If the rounding were dropped this would read
  // "236,145.67808000001" or similar; if it were applied to the wrong figure
  // the plain Total Weight above would lose its third decimal instead.
  it("rounds only the packaging figure, and only to 2dp", async () => {
    seedAllTime();

    const { ctx } = await getStats("/admin/stats/orders/");

    expect(valueOf(ctx, "Total Weight (inc. packaging)")).toBe("236,145.68");
    expect(valueOf(ctx, "Total Weight")).toBe("200,123.456");
  });

  it("counts orders and sums calories and items", async () => {
    seedAllTime();

    const { ctx } = await getStats("/admin/stats/orders/");

    expect(valueOf(ctx, "Total Orders")).toBe(2);
    expect(valueOf(ctx, "Total Calories")).toBe(1_234_567);
    expect(valueOf(ctx, "Total Items")).toBe(5678);
    // Counts, so no `raw` -- admin/stats.njk groups these itself.
    expect(row(ctx, "Total Calories").raw).toBeUndefined();
  });

  // SUSPECT, pinned rather than fixed. Python's `/` and `float()` always
  // produce a float, and str() of a whole float keeps its ".0" -- so Django's
  // page reads "2,000.0" and "10.0" where this one reads "2,000" and "10".
  // JS numbers carry no int/float distinction and String() drops the point,
  // which pythonFloat's comment does not mention. Cosmetic, and only reachable
  // when a total lands exactly on a whole unit, but it IS a divergence from
  // the module's stated "same digits for the same double" claim.
  it("drops the .0 Python's str() would keep on a whole-number total", async () => {
    seedOrder({ weight: 2_000_000, cost: 1000, calories: 5, no_items: 1 });

    const { ctx } = await getStats("/admin/stats/orders/");

    expect(valueOf(ctx, "Total Weight")).toBe("2,000"); // Django: "2,000.0"
    expect(valueOf(ctx, "Total Cost")).toBe("10"); // Django: "10.0"
    expect(valueOf(ctx, "Total Weight (inc. packaging)")).toBe("2,360"); // Django: "2360.0"
  });

  // An empty orders table is Django's actual crash site: views.py:2433 divides
  // Sum()'s None by 1000 and raises TypeError, so /admin/stats/orders/ 500s on
  // a database with no deliveries yet. The COALESCEs make it a page of zeros.
  //
  // MEASURED, and the reason this test asserts the RENDERED FIGURES rather
  // than the SQL's shape: removing a COALESCE from getOrderStats survives,
  // because the query's caller already ends `?? 0` on every field, so a NULL
  // sum becomes 0 one layer later. Two independent defences, one asserted
  // outcome -- which is the right way round, since either could be dropped
  // without this page changing and neither may be dropped without a test
  // noticing if both go.
  it("renders zeros on an empty orders table rather than raising", async () => {
    const { ctx } = await getStats("/admin/stats/orders/");

    expect(valueOf(ctx, "Total Weight")).toBe("0");
    expect(valueOf(ctx, "Total Orders")).toBe(0);
    expect(valueOf(ctx, "Total Cost")).toBe("0");
    expect(valueOf(ctx, "Total Weight (inc. packaging)")).toBe("0");
  });
});

// ===========================================================================
// adminSubscriberStats -- gfadmin/views.py:2457-2470
// ===========================================================================
describe("adminSubscriberStats", () => {
  // Two rows, and the only thing that can go wrong is the two counts swapping
  // -- which is why the fixture uses DIFFERENT numbers of each. Three
  // confirmed and three unconfirmed would pass either way round.
  it("splits email subscribers by confirmation, with the confirmed count first", async () => {
    seedEmailSubscriber("2026-01-01 00:00:00.000000", 1);
    seedEmailSubscriber("2026-01-02 00:00:00.000000", 1);
    seedEmailSubscriber("2026-01-03 00:00:00.000000", 1);
    seedEmailSubscriber("2026-01-04 00:00:00.000000", 0);
    seedEmailSubscriber("2026-01-05 00:00:00.000000", 0);

    const { ctx } = await getStats("/admin/stats/subscribers/");

    expect(labels(ctx)).toEqual(["Confirmed", "Unconfirmed"]);
    expect(valueOf(ctx, "Confirmed")).toBe(3);
    expect(valueOf(ctx, "Unconfirmed")).toBe(2);
  });

  // EMAIL ONLY, exactly as Django's page is. The other three channels have
  // their own tables and none of them appears here -- seeded so that a
  // "helpful" widening of this page would fail rather than pass unnoticed.
  it("ignores the web-push, mobile and WhatsApp channels entirely", async () => {
    seedEmailSubscriber("2026-01-01 00:00:00.000000", 1);
    seedWebpush("2026-01-02 00:00:00.000000");
    seedMobile("2026-01-03 00:00:00.000000");
    seedWhatsapp("2026-01-04 00:00:00.000000");

    const { ctx } = await getStats("/admin/stats/subscribers/");

    expect(ctx.stats).toHaveLength(2);
    expect(valueOf(ctx, "Confirmed")).toBe(1);
    expect(valueOf(ctx, "Unconfirmed")).toBe(0);
  });

  it("renders zeros with no subscribers at all", async () => {
    const { ctx } = await getStats("/admin/stats/subscribers/");

    expect(valueOf(ctx, "Confirmed")).toBe(0);
    expect(valueOf(ctx, "Unconfirmed")).toBe(0);
  });
});

// ===========================================================================
// adminSubscriberGraph -- gfadmin/views.py:2473-2517
// ===========================================================================
// The one stats view with its own template, and the one whose output is a
// SHAPE rather than a number: an array of week buckets that admin/sub_graph.njk
// reads forward for the chart and reversed for the table. Every failure it can
// have is a missing or misplaced bar on a chart nobody cross-checks.
describe("adminSubscriberGraph", () => {
  async function getWeeks(): Promise<Array<Record<string, unknown>>> {
    const res = await fetchPath("/admin/stats/subscribers/graph/");
    expect(res.status).toBe(200);
    // Same claim getStats() makes for the other five: the rendered page, as
    // text/html, IS the response. This page is the one where losing that
    // matters most -- admin/sub_graph.njk carries an inline ECharts block, and
    // a text/plain response would display the script rather than run it.
    expect(res.headers.get("Content-Type")).toMatch(/^text\/html/);
    expect(await res.clone().text()).toBe(renderedBody("admin/sub_graph.njk"));
    expect(lastRender().template).toBe("admin/sub_graph.njk");
    return lastRender().context.week_subs as Array<Record<string, unknown>>;
  }

  // DELIBERATE DIVERGENCE (a fix), and the reason the SQL carries a global
  // ORDER BY. Django fills its week_keys OrderedDict email-first
  // (views.py:2482-2500), so a week in which ONLY a web-push subscription
  // happened is appended AFTER every email week -- it lands at the far right
  // of the chart and the bottom of the table however early it actually was.
  // The webpush week here is a month EARLIER than the email week, so under
  // Django's ordering it would come second; here it comes first.
  it("orders the weeks chronologically even when the earliest had no email sign-up", async () => {
    seedWebpush("2026-01-05 10:00:00.000000");
    seedEmailSubscriber("2026-02-02 10:00:00.000000", 1);

    const weeks = await getWeeks();

    expect(weeks.map((week) => week.week_key)).toEqual(["2026-2", "2026-6"]);
    expect(weeks[0]).toEqual({ week_key: "2026-2", email: 0, whatsapp: 0, webpush: 1, mobile: 0, total: 1 });
  });

  // One week, three channels, three DIFFERENT counts -- so a bucket that
  // credited a sign-up to the wrong channel changes two numbers rather than
  // none. `total` is accumulated alongside them, not derived at the end, so
  // it is asserted as its own claim.
  it("splits one week by channel and totals it", async () => {
    seedEmailSubscriber("2026-02-02 09:00:00.000000", 1);
    seedEmailSubscriber("2026-02-03 09:00:00.000000", 1);
    seedWebpush("2026-02-04 09:00:00.000000");
    seedMobile("2026-02-05 09:00:00.000000");
    seedMobile("2026-02-06 09:00:00.000000");
    seedMobile("2026-02-07 09:00:00.000000");

    const weeks = await getWeeks();

    expect(weeks).toEqual([{ week_key: "2026-6", email: 2, whatsapp: 0, webpush: 1, mobile: 3, total: 6 }]);
  });

  // views.py:2482's `.filter(confirmed = True)`. The unconfirmed sign-up is
  // seeded in a week OF ITS OWN, so a lost filter does not merely bump a
  // count -- it adds a whole bar to the chart, which is what makes the
  // absence assertable.
  it("leaves an unconfirmed email sign-up out of the chart entirely", async () => {
    seedEmailSubscriber("2026-01-05 10:00:00.000000", 0);
    seedEmailSubscriber("2026-02-02 10:00:00.000000", 1);

    const weeks = await getWeeks();

    expect(weeks.map((week) => week.week_key)).toEqual(["2026-6"]);
  });

  // SUSPECT -- pinned as current behaviour, reported rather than fixed.
  //
  // stats.ts:264-269 and packages/db/src/adminStats.ts:265-269 both say the
  // WhatsApp series is 0 "because there is no whatsappsubscriber D1 table".
  // That was true when they were written and is not true now: migration
  // 0020_whatsappsubscriber.sql created the table, and
  // packages/db/src/notifySubscribers.ts:136 INSERTs into it from the live
  // inbound-message flow (workers/jobs/src/queues/whatsappHook.ts), which is
  // why needAdmin.ts:142 already counts it. getSubscriberSignupRows' UNION
  // ALL still has only three arms, so every WhatsApp sign-up is missing from
  // this chart -- and a week in which ONLY WhatsApp sign-ups happened has no
  // bar at all, as the second assertion here shows. Django's own chart has a
  // WhatsApp series with real numbers in it.
  it("reports zero WhatsApp sign-ups even when the table has rows", async () => {
    seedWhatsapp("2026-01-05 10:00:00.000000");
    seedWhatsapp("2026-01-06 10:00:00.000000");
    seedEmailSubscriber("2026-02-02 10:00:00.000000", 1);

    const weeks = await getWeeks();

    // The WhatsApp-only week is absent from the chart altogether...
    expect(weeks.map((week) => week.week_key)).toEqual(["2026-6"]);
    // ...and the column is kept, pinned at 0, so the gap is visible in the
    // table rather than silently dropped from the shape.
    expect(weeks[0]?.whatsapp).toBe(0);
  });

  // THE CALENDAR-YEAR/ISO-WEEK QUIRK, reproduced verbatim from Django's
  // `"%s-%s" % (created.year, created.isocalendar()[1])`. Those two are not
  // from the same calendar system: 2020-12-28 and 2021-01-01 are the SAME ISO
  // week (2020-W53) but different calendar years, so they land in DIFFERENT
  // buckets, "2020-53" and "2021-53" -- and "2021-53" precedes "2021-1" by
  // three days. Ordering in SQL is what gets that right; a naive numeric
  // (year, week) sort would put "2021-1" first and misdate the chart's x-axis
  // at every year boundary.
  it("reproduces Django's split of one ISO week across two calendar years, in date order", async () => {
    seedMobile("2020-12-28 12:00:00.000000");
    seedMobile("2021-01-01 12:00:00.000000");
    seedMobile("2021-01-04 12:00:00.000000");

    const weeks = await getWeeks();

    expect(weeks.map((week) => week.week_key)).toEqual(["2020-53", "2021-53", "2021-1"]);
    expect(weeks.map((week) => week.mobile)).toEqual([1, 1, 1]);
  });

  // TICKET #7's BUG CLASS, at this handler's own copy of the parser. Every
  // subscriber row the port writes is Z-suffixed (subscribers.ts uses
  // pyNow()); appending a second "Z" makes an Invalid Date, whose week key
  // formats as the literal string "NaN-NaN" and renders itself onto the
  // chart. parseStatsTimestamp strips a trailing Z before appending one, so
  // both stored shapes parse to the same instant and the same bucket.
  //
  // A MEASUREMENT RATHER THAN AN OVERCLAIM: replacing parseStatsTimestamp
  // with a bare `new Date(row.created)` SURVIVES this whole file, and that
  // mutant was run rather than imagined. It survives because vitest.config
  // .mts pins TZ=UTC, and V8's non-ISO parse path reads the space-separated
  // shape as LOCAL time -- identical to UTC only because the clock is pinned.
  // Under BST every one of those rows would land an hour early, which moves a
  // Monday-morning sign-up into the previous week's bucket. No test in this
  // repo can distinguish the two, and the pinned TZ is deliberate (see
  // vitest.config.mts's own comment), so the guarantee here is the Z-strip,
  // not the choice of parser.
  it("parses the port's own Z-suffixed timestamps into the right week, not NaN-NaN", async () => {
    seedWebpush("2026-03-02T10:00:00.000Z");

    const weeks = await getWeeks();

    expect(weeks.map((week) => week.week_key)).toEqual(["2026-10"]);
  });

  it("puts a Z-suffixed row and a space-separated row in the same week", async () => {
    seedWebpush("2026-03-02T10:00:00.000Z");
    seedMobile("2026-03-02 10:00:00.000000");

    const weeks = await getWeeks();

    expect(weeks).toEqual([{ week_key: "2026-10", email: 0, whatsapp: 0, webpush: 1, mobile: 1, total: 2 }]);
  });

  // weekKey() returns null for an unreadable date and the loop skips it, so
  // one corrupt row costs that row rather than the credibility of the chart.
  // The alternative -- which is what shipped before ticket #7 -- was a
  // "NaN-NaN" bucket sitting on the axis.
  it("drops a row with an unreadable timestamp instead of bucketing it under NaN-NaN", async () => {
    seedEmailSubscriber("2026-02-02 10:00:00.000000", 1);
    seedWebpush("not a timestamp");

    const weeks = await getWeeks();

    expect(weeks).toEqual([{ week_key: "2026-6", email: 1, whatsapp: 0, webpush: 0, mobile: 0, total: 1 }]);
  });

  // An empty array, not a null and not a missing key: admin/sub_graph.njk's
  // `{% for ... %}{% else %}` renders the "None" row off exactly this, and
  // the ECharts block below it iterates the same array.
  it("hands the template an empty array when nobody has ever subscribed", async () => {
    const weeks = await getWeeks();

    expect(weeks).toEqual([]);
  });
});

// ===========================================================================
// adminNeedStats -- gfadmin/views.py:2520-2535
// ===========================================================================
describe("adminNeedStats", () => {
  function seedNeeds(): void {
    seedNeed();
    seedNeed();
    seedNeed();
    seedNeed();
    for (let i = 0; i < 5; i += 1) seedNeedLine("need");
    for (let i = 0; i < 3; i += 1) seedNeedLine("excess");
    // A type outside NEED_LINE_TYPES (givefood/const/general.py:31-34).
    // Nothing writes one today; the sum-the-groups design is what keeps
    // "Items" honest if one ever appears.
    seedNeedLine("unknown");
    seedNeedLine("unknown");
  }

  it("prints the four rows Django prints, in Django's order", async () => {
    seedNeeds();

    const { ctx } = await getStats("/admin/stats/needs/");

    expect(labels(ctx)).toEqual(["Needs", "Items", "Needed Items", "Excess Items"]);
  });

  // "Items" is the sum of EVERY type group rather than its own COUNT(*), so
  // the two unexpected lines are inside the 10 while "Needed" + "Excess" only
  // account for 8. A total that read 8 would mean two rows had vanished from
  // the page with nothing to say so; a total from a separate COUNT(*) could
  // drift from the parts for a different reason. Distinct counts (5/3/2) so a
  // swapped pair of groups fails.
  it("makes Items the sum of every line type, including ones it has no row for", async () => {
    seedNeeds();

    const { ctx } = await getStats("/admin/stats/needs/");

    expect(valueOf(ctx, "Needs")).toBe(4);
    expect(valueOf(ctx, "Items")).toBe(10);
    expect(valueOf(ctx, "Needed Items")).toBe(5);
    expect(valueOf(ctx, "Excess Items")).toBe(3);
  });

  // views.py:2523 has no published/nonpertinent filter, and neither does the
  // port. Seeded explicitly because every OTHER need query in this codebase
  // does filter on published -- so "counts them all" is the surprising
  // choice, and the one a later change could quietly reverse.
  it("counts unpublished and non-pertinent needs too", async () => {
    seedNeed();
    const n = id();
    insert("foodbankchange", {
      id: n,
      need_id: `need-${n}`,
      foodbank_id: 1,
      change_text: "Unpublished",
      published: 0,
      nonpertinent: 1,
      input_method: "typed",
      created: "2026-01-01 00:00:00.000000",
      modified: "2026-01-01 00:00:00.000000",
    });

    const { ctx } = await getStats("/admin/stats/needs/");

    expect(valueOf(ctx, "Needs")).toBe(2);
  });

  // A type with no rows is absent from the GROUP BY, and `?? 0` turns that
  // absence into a zero. Without it the row renders empty and reads as
  // "unknown" rather than "none".
  it("prints zero for a line type with no rows", async () => {
    seedNeed();
    seedNeedLine("need");

    const { ctx } = await getStats("/admin/stats/needs/");

    expect(valueOf(ctx, "Items")).toBe(1);
    expect(valueOf(ctx, "Needed Items")).toBe(1);
    expect(valueOf(ctx, "Excess Items")).toBe(0);
  });

  it("renders zeros with no needs at all", async () => {
    const { ctx } = await getStats("/admin/stats/needs/");

    expect(labels(ctx)).toEqual(["Needs", "Items", "Needed Items", "Excess Items"]);
    expect(ctx.stats.map((each) => each.value)).toEqual([0, 0, 0, 0]);
  });
});
