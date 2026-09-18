import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { adminOrderForm } from "./orderForm";
import { requireAdminAuth } from "../../middleware/adminAuth";
import { hmacSha256Hex } from "../../lib/hmac";
import type { AppEnv } from "../../types";

// gfadmin/views.py:455-491 order_form + givefood/forms.py:189-210 OrderForm,
// as ported to routes/admin/orderForm.ts.
//
// WHY THIS FILE IS SHAPED THE WAY IT IS. Two admin bugs found in this port
// were both invisible from the outside:
//
//   #12 -- a duplicate reached D1, SQLite raised, and the 500 page threw away
//          everything the admin had typed.
//   #34 -- the location form's Place ID was parsed, threaded all the way down,
//          and then written by no SQL at all. It redirected as if it had
//          saved.
//
// Neither shows up in a test that stops at the status code, so nothing here
// stops there. Every save asserts the ROW BACK OUT OF SQLITE column by
// column, and the round-trip block below saves a fully populated order and
// then re-opens the edit form to prove each of the ten editable fields comes
// back on screen -- which is the single test that would have caught #34 on
// day one. Every rejection asserts that the admin's own values are still in
// the re-rendered form AND that the orders table is byte-for-byte unchanged.
//
// NOTHING IN packages/db IS MOCKED, and neither is the router, the templates
// or the CSRF check. upsertOrder, setOrderId, findConflictingOrder,
// recomputeFoodbankLastOrder, insertAdminJob, getOpenFoodbankOptions,
// getNeedOptionsForFoodbank, getOrderGroupOptions and getOrderForEdit all run
// their real SQL against a real in-memory SQLite seeded from the real
// migrations' DDL, behind a real Hono app at the production paths
// (routes/admin/index.ts:179-180, :259-260). The only stub is `fetch`, for
// the Gemini call that parses items_text -- the one thing in this handler
// that leaves the machine. The parse itself (packages/ai's runOrderLinesJob)
// runs for real against the same database; its arithmetic is covered in
// depth by workers/jobs/src/adminJobs/orderLines.test.ts, so this suite only
// asserts the handoff: that a save parses, against the right row, and that a
// failed parse still lands on the saved order.
//
// This handler is also where an admin's typing is most expensive to lose:
// items_text is a pasted supermarket order of dozens of lines, and losing it
// means re-pasting from a receipt.
//
// MUTATION-TESTED, per TESTING.md's convention -- the module was copied to a
// scratchpad, broken fifteen ways, and the suite re-run against each. The
// counts below are what actually failed, run rather than estimated, and they
// are the evidence these assertions are load-bearing rather than decorative:
//
//   drop the setOrderId call on a new unassigned order   2
//   never write actual_cost                              5
//   drop renderForm's out-of-window need append          2
//   drop excludeId from the conflict check               5
//   compute the CSRF verdict and ignore it               8
//   skip the previous food bank's last_order recompute   1
//   accept a newly chosen CLOSED food bank               3
//   stop filtering the need list by food bank            2
//   re-render a REJECTED form from EMPTY_FORM_DATA       4
//   leave `country` blank for an assigned order          3
//   validate delivery_date by regex shape alone          2
//   parse the order_id instead of the pk                 1
//   build delivery_datetime at midnight                  2
//   drop renderForm's since-closed food bank append      2
//   drop isValidUrl's http/https protocol check          4
//
// The two mutants only ONE test catches are both deliberate: each is a
// single-line deviation from Django that exists for one reason, and the test
// that names that reason is the whole point of the line being there.
//
// SECOND, ADVERSARIAL PASS. 118 further mutants were then run, against this
// handler AND against packages/db/src/orderWrite.ts -- because the SQL that
// #34 was missing lives in the db package, not in the route, and a route test
// that never reaches the statement cannot see a column dropped from it. 105
// died on the spot and one was equivalent (a bind rewritten to itself). The
// TWELVE that survived are each closed by a test below that names the mutant:
//
//   the UPDATE never writes delivery_hour                 (edit path only)
//   the UPDATE never writes delivery_provider             (edit path only)
//   the UPDATE swaps the need_id / order_group_id binds   (edit path only)
//   the UPDATE swaps the source_url / provider_id binds   (edit path only)
//   an EDIT records no admin_job
//   an EDIT never parses its items text
//   the admin_job is stamped with the order's PRE-save id
//   an assigned order's id uses "" for a null provider, not "none"
//   a rejected save re-renders the delivery hour unselected
//   a rejected save re-renders an EMPTY csrf_token
//   items_text is entity-escaped on the way IN, corrupting the column
//   the admin navbar's active section is not "orders"
//
// Seven of the twelve are one structural gap: every column was read back on
// the CREATE path and two or three on the EDIT path, so an UPDATE that had
// lost a column or transposed a pair of binds was invisible -- #34's exact
// shape, one statement over. "rewrites every column on an edit" below is the
// fix, and the three edit-side parse tests are the same omission in the
// handoff that follows the write.
//
// The csrf_token survivor is #12's failure mode wearing a different hat: the
// admin's values were all asserted back onto the page, and nothing asked
// whether that page could still be SUBMITTED. A recovery form whose token is
// empty preserves the typing exactly as well as the 500 page did.

// ---------------------------------------------------------------------------
// Fixture schema -- the tables this handler's queries actually name, with the
// column sets of the real migrations. Reduced (the production `foodbank` has
// ~90 columns) but never RESHAPED: `foodbankchange` deliberately has no
// foodbank_name column, because 0019_drop_foodbank_cache.sql:57 dropped it and
// moved it into the foodbankchange_full view -- and getNeedOptionsForFoodbank
// plus renderForm's inline "current need" lookup both read the VIEW. A fixture
// that kept the denormalised column would let a query that had drifted back
// onto the table pass here and fail in production.
//
// `orders` is transcribed complete from 0005_orders_and_charity.sql:19-33,
// NOT NULLs included, because the NOT NULL on `country` is exactly what
// orderForm.ts's `country = foodbank ? foodbank.country : ""` comment is
// about: writing null there has to be an error, not a silently accepted NULL.
//
// NOTE what is NOT here, faithfully: `orders` has NO unique index backing
// Order.Meta.unique_together (0005 declares none). The duplicate-order check
// is the application query in findConflictingOrder and nothing else -- there
// is no database backstop the way dp_fb_name_uniq is one for donation points.
// That is the production schema, so it is the schema tested against.
const SCHEMA = `
CREATE TABLE foodbank (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  country TEXT NOT NULL,
  is_closed INTEGER NOT NULL,
  latest_need_id INTEGER,
  last_order TEXT,
  modified TEXT NOT NULL
);
CREATE UNIQUE INDEX foodbank_slug_uniq ON foodbank(slug);

CREATE TABLE foodbankchange (
  id INTEGER PRIMARY KEY,
  need_id TEXT NOT NULL,
  foodbank_id INTEGER,
  created TEXT NOT NULL
);
CREATE UNIQUE INDEX need_need_id_uniq ON foodbankchange(need_id);

CREATE VIEW foodbankchange_full AS
  SELECT c.*, f.name AS foodbank_name, f.slug AS foodbank_slug
    FROM foodbankchange c
    LEFT JOIN foodbank f ON f.id = c.foodbank_id;

CREATE TABLE ordergroup (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL
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

CREATE TABLE admin_job (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  target TEXT,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT,
  created TEXT NOT NULL,
  finished TEXT
);
` + schemaFor("orderline", "orderitem");

type Bindable = null | number | bigint | string | Uint8Array;

// The D1PreparedStatement surface packages/db uses, over node:sqlite. Same
// adapter as donationPoint.test.ts / foodbankLocation.test.ts -- D1 is async
// and node:sqlite is synchronous, and that is the only difference that
// matters: the SQL text, the parameter binding, the NULL semantics and the
// NOT NULL enforcement are SQLite's on both sides. Cast rather than
// implemented in full, because stubbing the unused half of D1DatabaseSession
// would only add ways to be wrong.
function d1Session(db: DatabaseSync): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
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
  } as unknown as D1DatabaseSession;
}

const ORIGIN = "https://www.givefood.org.uk";
const CSRF_SECRET = "test-csrf-secret-not-a-real-one";
const CSRF_RAW = "b".repeat(64);

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

// Three food banks: two open in different countries (so the denormalised
// `country` column has something to be wrong about), one closed.
const SALISBURY = { id: 1, name: "Salisbury Food Bank", slug: "salisbury", country: "England" };
const ABERDEEN = { id: 2, name: "Aberdeen Food Bank", slug: "aberdeen", country: "Scotland" };
const SHUTTERED = { id: 3, name: "Shuttered Food Bank", slug: "shuttered", country: "Wales" };

// Needs on two different food banks, so "the need list is filtered" is a
// claim about a row that must be ABSENT, not just about the rows that happen
// to be present. A filter that does nothing passes every test that only seeds
// matching rows.
const NEED_SALISBURY = { id: 10, need_id: "1a2b3c4d5e6f708192a3b4c5d6e7f809", foodbankId: SALISBURY.id, created: "2026-01-02 09:30:00.000000" };
const NEED_ABERDEEN = { id: 11, need_id: "99887766554433221100aabbccddeeff", foodbankId: ABERDEEN.id, created: "2026-01-03 14:05:00.000000" };
const NEED_ORPHAN = { id: 12, need_id: "deadbeefdeadbeefdeadbeefdeadbeef", foodbankId: null, created: "2026-01-04 08:00:00.000000" };

const GROUP_WINTER = { id: 20, name: "Winter Appeal", slug: "winter-appeal" };
const GROUP_ALPHA = { id: 21, name: "Alpha Trial", slug: "alpha-trial" };

// A complete, valid submission. Every value is distinctive so that "it came
// back" is an assertion about THIS value and not about form boilerplate that
// would be on screen for an empty form too.
const TYPED: Record<string, string> = {
  foodbank: String(SALISBURY.id),
  items_text: "2 x Baked Beans 400g\n1 x Long Grain Rice 1kg\n6 x UHT Milk 1l",
  need: String(NEED_SALISBURY.id),
  order_group: String(GROUP_WINTER.id),
  source_url: "https://example.invalid/status/17734",
  delivery_date: "2026-03-04",
  delivery_hour: "14",
  delivery_provider: "Sainsbury's",
  delivery_provider_id: "SB-99881-XZ",
  actual_cost: "4325",
};

// models/orders.py:105-107 -- "gf-<foodbank slug>-<slugify(provider)>-<date>".
// slugify("Sainsbury's") drops the apostrophe rather than hyphenating it.
const TYPED_ORDER_ID = "gf-salisbury-sainsburys-2026-03-04";

let db: DatabaseSync;
let geminiFetch: ReturnType<typeof vi.fn>;

// What the stubbed model "returns" for TYPED.items_text -- per-item cost and
// weight, as the prompt asks for. Line totals: 800 g + 1000 g + 6000 g, and
// 110p + 120p + 570p.
const AI_LINES = [
  { name: "Baked Beans 400g", quantity: 2, item_cost: 55, weight: 400 },
  { name: "Long Grain Rice 1kg", quantity: 1, item_cost: 120, weight: 1000 },
  { name: "UHT Milk 1l", quantity: 6, item_cost: 95, weight: 1000 },
];

// Gemini's success envelope: the JSON arrives as a STRING in the first part.
function geminiEnvelope(payload: unknown): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }), { status: 200 });
}

function orderLines(): { order_id: number; name: string; quantity: number; weight: number; line_cost: number }[] {
  return db.prepare("SELECT order_id, name, quantity, weight, line_cost FROM orderline ORDER BY id").all() as never;
}

interface OrderRow {
  id: number;
  order_id: string;
  items_text: string;
  country: string;
  created: string;
  modified: string;
  notification_email_sent: string | null;
  source_url: string | null;
  delivery_date: string;
  delivery_hour: number;
  delivery_datetime: string;
  delivery_provider: string | null;
  delivery_provider_id: string | null;
  weight: number;
  calories: number;
  cost: number;
  actual_cost: number | null;
  no_lines: number;
  no_items: number;
  foodbank_id: number | null;
  need_id: number | null;
  order_group_id: number | null;
}

function orders(): OrderRow[] {
  return db.prepare("SELECT * FROM orders ORDER BY id").all() as never;
}

function onlyOrder(): OrderRow {
  const all = orders();
  if (all.length !== 1) throw new Error(`expected exactly one order, found ${all.length}`);
  return all[0]!;
}

function adminJobs(): { id: string; kind: string; target: string | null; status: string; created: string }[] {
  return db.prepare("SELECT id, kind, target, status, created FROM admin_job ORDER BY created, id").all() as never;
}

function foodbankRow(id: number): { last_order: string | null; modified: string } {
  return db.prepare("SELECT last_order, modified FROM foodbank WHERE id = ?").get(id) as never;
}

function seedFoodbank(fb: { id: number; name: string; slug: string; country: string }, isClosed = 0, lastOrder: string | null = null) {
  db.prepare("INSERT INTO foodbank (id, name, slug, country, is_closed, latest_need_id, last_order, modified) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)").run(
    fb.id,
    fb.name,
    fb.slug,
    fb.country,
    isClosed,
    lastOrder,
    "2026-01-01 00:00:00.000000",
  );
}

function seedNeed(need: { id: number; need_id: string; foodbankId: number | null; created: string }) {
  db.prepare("INSERT INTO foodbankchange (id, need_id, foodbank_id, created) VALUES (?, ?, ?, ?)").run(
    need.id,
    need.need_id,
    need.foodbankId,
    need.created,
  );
}

// Everything the `orders` table needs, so that a seeded order differs from a
// saved one only in the columns a test is actually about.
function seedOrder(overrides: Partial<OrderRow> & { id: number; order_id: string }) {
  const row: Omit<OrderRow, "id"> & { id: number } = {
    items_text: "1 x Seeded Item",
    country: "England",
    created: "2026-02-01 10:00:00.000000",
    modified: "2026-02-01 10:00:00.000000",
    notification_email_sent: null,
    source_url: null,
    delivery_date: "2026-02-10",
    delivery_hour: 9,
    delivery_datetime: "2026-02-10 09:00:00.000000",
    delivery_provider: "Tesco",
    delivery_provider_id: null,
    weight: 0,
    calories: 0,
    cost: 0,
    actual_cost: null,
    no_lines: 0,
    no_items: 0,
    foodbank_id: SALISBURY.id,
    need_id: null,
    order_group_id: null,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO orders
       (id, order_id, items_text, country, created, modified, notification_email_sent, source_url,
        delivery_date, delivery_hour, delivery_datetime, delivery_provider, delivery_provider_id,
        weight, calories, cost, actual_cost, no_lines, no_items, foodbank_id, need_id, order_group_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.order_id,
    row.items_text,
    row.country,
    row.created,
    row.modified,
    row.notification_email_sent,
    row.source_url,
    row.delivery_date,
    row.delivery_hour,
    row.delivery_datetime,
    row.delivery_provider,
    row.delivery_provider_id,
    row.weight,
    row.calories,
    row.cost,
    row.actual_cost,
    row.no_lines,
    row.no_items,
    row.foodbank_id,
    row.need_id,
    row.order_group_id,
  );
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  seedFoodbank(SALISBURY);
  seedFoodbank(ABERDEEN);
  seedFoodbank(SHUTTERED, 1);
  seedNeed(NEED_SALISBURY);
  seedNeed(NEED_ABERDEEN);
  seedNeed(NEED_ORPHAN);
  db.prepare("INSERT INTO ordergroup (id, name, slug) VALUES (?, ?, ?)").run(GROUP_WINTER.id, GROUP_WINTER.name, GROUP_WINTER.slug);
  db.prepare("INSERT INTO ordergroup (id, name, slug) VALUES (?, ?, ?)").run(GROUP_ALPHA.id, GROUP_ALPHA.name, GROUP_ALPHA.slug);
  // Any URL other than Gemini's throws, so an outbound call this handler
  // grows later fails here instead of being absorbed by a permissive stub.
  geminiFetch = vi.fn(async (url: string) => {
    if (!url.startsWith("https://generativelanguage.googleapis.com/")) throw new Error(`unmodelled fetch: ${url}`);
    return geminiEnvelope(AI_LINES);
  });
  vi.stubGlobal("fetch", geminiFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function env(): AppEnv["Bindings"] {
  return {
    DB: { withSession: () => d1Session(db) },
    CSRF_SECRET,
    GEMINI_API_KEY: "test-gemini-key",
    SESSIONS: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    },
    GMAP_STATIC_KEY: "",
    GMAP_GEOCODE_KEY: "",
  } as unknown as AppEnv["Bindings"];
}

// The production registrations, verbatim from routes/admin/index.ts:179-180
// and :259-260 -- create and edit are the SAME exported handler distinguished
// only by whether :orderId matched, so a hand-built Context would let a change
// in how that distinction is drawn slip through unnoticed.
function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("requestStartTime", performance.now());
    c.set("adminUser", { email: "someone@givefood.org.uk", name: "Some One", givenName: "Some", picture: "" });
    await next();
  });
  app.get("/admin/order/new/", adminOrderForm);
  app.post("/admin/order/new/", adminOrderForm);
  app.get("/admin/order/:orderId/edit/", adminOrderForm);
  app.post("/admin/order/:orderId/edit/", adminOrderForm);
  // Labelled rather than left to become an unhandled rejection, so a
  // regression reads as "expected 200, got 500: NOT NULL constraint failed"
  // instead of a vitest crash with no SQL in it.
  app.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));
  return app;
}

interface Result {
  res: Response;
  html: string;
}

async function get(path: string): Promise<Result> {
  const res = await buildApp().fetch(new Request(`${ORIGIN}${path}`), env(), execCtx);
  return { res, html: res.status === 302 ? "" : await res.text() };
}

// A valid, same-origin, signed double-submit POST. Individual tests override
// the pieces of this they are about (lib/csrf.ts's four rejection paths each
// have their own test below).
async function post(
  path: string,
  fields: Record<string, string>,
  opts: { csrfToken?: string | null; cookie?: string | null; origin?: string | null; secFetchSite?: string } = {},
): Promise<Result> {
  const signature = await hmacSha256Hex(CSRF_SECRET, CSRF_RAW);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  const cookie = opts.cookie === undefined ? `__Host-csrf=${CSRF_RAW}.${signature}` : opts.cookie;
  if (cookie !== null) headers.Cookie = cookie;
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin !== null) headers.Origin = origin;
  headers["Sec-Fetch-Site"] = opts.secFetchSite ?? "same-origin";

  const body: Record<string, string> = { ...fields };
  const token = opts.csrfToken === undefined ? CSRF_RAW : opts.csrfToken;
  if (token !== null) body.csrf_token = token;

  const res = await buildApp().fetch(
    new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: new URLSearchParams(body).toString() }),
    env(),
    execCtx,
  );
  return { res, html: res.status === 302 ? "" : await res.text() };
}

// Nunjucks autoescapes every interpolation, so one of the four delivery
// providers -- "Sainsbury's", which is also the one in TYPED -- reaches the
// markup as `Sainsbury&#39;s` in its option value, its selected attribute and
// its error messages. Decoded in ONE place so every reader below sees the page
// the way the browser does. Doing it per-helper is how this file first went
// wrong: three of the six readers decoded and three did not, so "the provider
// came back" was an assertion about the escaping rather than about the value,
// and each helper was a separate opportunity to write down the escaped form
// and have the test go green for the wrong reason.
//
// `&amp;` is decoded LAST, deliberately: a literal `&amp;#39;` on the page
// (an ampersand the admin typed, followed by a numeric entity) must not be
// unescaped twice into an apostrophe.
function decodeEntities(value: string): string {
  return value
    .replace(/&#34;|&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// order_form.njk:38's banner, read the way the admin reads it -- the WHOLE
// banner, so a message that grew a second sentence is a failure rather than a
// still-passing substring match.
function errorBanner(html: string): string | null {
  const match = html.match(/<div class="notification is-danger is-light">([\s\S]*?)<\/div>/);
  if (!match) return null;
  return decodeEntities(match[1]!.trim());
}

// The value attribute of one <input>, as rendered. Returns null when the
// input is absent entirely, which is a different failure from "present but
// empty" and must not be conflated with it.
function inputValue(html: string, id: string): string | null {
  const match = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
  if (!match) return null;
  const value = match[0].match(/ value="([^"]*)"/);
  return value ? decodeEntities(value[1]!) : "";
}

// The textarea's contents -- items_text is the only one, and it is the field
// whose loss actually costs the admin a re-paste.
function textareaValue(html: string, id: string): string | null {
  const match = html.match(new RegExp(`<textarea[^>]*id="${id}"[^>]*>([\\s\\S]*?)</textarea>`));
  return match ? decodeEntities(match[1]!) : null;
}

// The `value` of whichever <option> in a named <select> carries `selected`.
// This is the assertion a bare `html.toContain(...)` cannot make: a select's
// chosen value never appears as text, so a round-trip test that only greps
// the page passes even when every dropdown has silently reverted to its
// blank first option.
function selectedOption(html: string, id: string): string | null {
  const block = html.match(new RegExp(`<select[^>]*id="${id}"[^>]*>([\\s\\S]*?)</select>`));
  if (!block) return null;
  const selected = block[1]!.match(/<option value="([^"]*)" selected>/);
  return selected ? decodeEntities(selected[1]!) : null;
}

// Every option value a named <select> offers, in render order -- for the
// filter/exclusion assertions, where the point is which rows are ABSENT.
function optionValues(html: string, id: string): string[] {
  const block = html.match(new RegExp(`<select[^>]*id="${id}"[^>]*>([\\s\\S]*?)</select>`));
  if (!block) throw new Error(`no <select id="${id}"> in the rendered page`);
  return [...block[1]!.matchAll(/<option value="([^"]*)"/g)].map((m) => decodeEntities(m[1]!));
}

function optionLabels(html: string, id: string): string[] {
  const block = html.match(new RegExp(`<select[^>]*id="${id}"[^>]*>([\\s\\S]*?)</select>`));
  if (!block) throw new Error(`no <select id="${id}"> in the rendered page`);
  return [...block[1]!.matchAll(/<option value="[^"]*"(?: selected)?>([^<]*)<\/option>/g)].map((m) => decodeEntities(m[1]!));
}

// ---------------------------------------------------------------------------
// GET -- the blank form
// ---------------------------------------------------------------------------

describe("adminOrderForm GET /admin/order/new/", () => {
  it("renders an empty form under views.py:484's 'New Order' title", async () => {
    const { res, html } = await get("/admin/order/new/");

    expect(res.status).toBe(200);
    expect(html).toContain("<h2>New Order</h2>");
    expect(errorBanner(html)).toBeNull();
    expect(textareaValue(html, "id_items_text")).toBe("");
    expect(inputValue(html, "id_delivery_date")).toBe("");
    // EMPTY_FORM_DATA leaves every select on its own blank option, including
    // delivery_hour -- order_form.njk:129-134 and orderForm.ts's
    // "Delivery hour is required" check exist together precisely so a new
    // order cannot silently book the 06:00 slot the browser would otherwise
    // preselect.
    expect(selectedOption(html, "id_foodbank")).toBeNull();
    expect(selectedOption(html, "id_need")).toBeNull();
    expect(selectedOption(html, "id_order_group")).toBeNull();
    expect(selectedOption(html, "id_delivery_hour")).toBe("");
    expect(selectedOption(html, "id_delivery_provider")).toBeNull();
  });

  // A GET and a POST share one exported function here, selected on
  // c.req.method. Django's own view is the same shape and picks its save
  // branch on `if request.POST:`. If that branch ever moved, a GET would start
  // writing -- so the absence of writes is asserted, not assumed.
  it("writes nothing at all", async () => {
    await get("/admin/order/new/");
    await get("/admin/order/new/?foodbank=salisbury");

    expect(orders()).toHaveLength(0);
    expect(adminJobs()).toHaveLength(0);
    expect(geminiFetch).not.toHaveBeenCalled();
  });

  // KILLS THE MUTANT: adminPageContext(c, "orders") -> adminPageContext(c,
  // "needs"). page.njk:43-50 renders the admin navbar's active item from that
  // one string and nothing else, so getting it wrong lights up the wrong tab
  // on every render of this form -- create, edit and rejected-save alike --
  // and no assertion in this file could see it. Cheap to state, and it is the
  // only thing tying this handler to the section it belongs to.
  it("marks Orders as the active admin section", async () => {
    const { html } = await get("/admin/order/new/");

    expect(html).toContain('<a class="navbar-item is-active" href="/admin/orders/">Orders</a>');
    expect(html).toContain('<a class="navbar-item" href="/admin/needs/">Needs</a>');
  });

  it("offers the delivery hours and providers of const/general.py:1 and :15-20", async () => {
    const { html } = await get("/admin/order/new/");

    // The blank choice first, then 6..22 -- no 23, no 5.
    expect(optionValues(html, "id_delivery_hour")).toEqual([
      "",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
      "12",
      "13",
      "14",
      "15",
      "16",
      "17",
      "18",
      "19",
      "20",
      "21",
      "22",
    ]);
    expect(optionValues(html, "id_delivery_provider")).toEqual(["", "Tesco", "Sainsbury's", "Costco", "Pedal Me"]);
  });

  // forms.py:190's queryset is Foodbank.objects.filter(is_closed=False).
  // Seeded WITH a closed food bank so this is a claim about a row that must be
  // absent; a query that dropped the `WHERE is_closed = 0` passes every test
  // that only seeds open ones.
  it("excludes closed food banks, and sorts the rest by name", async () => {
    const { html } = await get("/admin/order/new/");

    expect(optionValues(html, "id_foodbank")).toEqual(["", String(ABERDEEN.id), String(SALISBURY.id)]);
    expect(optionLabels(html, "id_foodbank")).toEqual(["-- none --", "Aberdeen Food Bank", "Salisbury Food Bank"]);
  });

  // sortByName, not SQL ORDER BY -- types.ts's collation note. Winter Appeal
  // was seeded first and must still render second.
  it("sorts order groups by name rather than by insertion order", async () => {
    const { html } = await get("/admin/order/new/");

    expect(optionLabels(html, "id_order_group")).toEqual(["-- none --", "Alpha Trial", "Winter Appeal"]);
  });

  // FoodbankChange.__str__ (models/needs.py:84-85) is
  //   "%s - %s (%s)" % (name, created.strftime("%b %d %Y %H:%M:%S"), str(need_id)[:7])
  // and %d/%H are ZERO-PADDED in Python. needOptionLabel's comment says the
  // equivalent Django format string is therefore "M d Y H:i:s" and not
  // "M j Y G:i:s"; this asserts the padding actually survives, on a need whose
  // day and hour are both single-digit, which is the only input where the two
  // format strings differ.
  it("labels needs exactly as FoodbankChange.__str__ does, zero-padding included", async () => {
    const { html } = await get("/admin/order/new/");

    expect(optionLabels(html, "id_need")).toContain("Salisbury Food Bank - Jan 02 2026 09:30:00 (1a2b3c4)");
  });

  // needs.py:84's "%s" over a null foodbank renders Python's "None";
  // needOptionLabel's `?? "None"` is that, and an orphaned need row is the
  // only thing that reaches it.
  it("labels a need with no food bank 'None', as Python's %s does", async () => {
    const { html } = await get("/admin/order/new/");

    expect(optionLabels(html, "id_need")).toContain("None - Jan 04 2026 08:00:00 (deadbee)");
  });

  // getNeedOptionsForFoodbank with a null food bank id -- unfiltered, newest
  // first. The order matters: it is what makes the LIMIT a "most recent"
  // window rather than an arbitrary one.
  it("lists every need newest-first when no food bank is selected", async () => {
    const { html } = await get("/admin/order/new/");

    expect(optionValues(html, "id_need")).toEqual(["", String(NEED_ORPHAN.id), String(NEED_ABERDEEN.id), String(NEED_SALISBURY.id)]);
  });

  it("says nothing about a capped need list when the cap did not bite", async () => {
    const { html } = await get("/admin/order/new/");

    expect(html).not.toContain("Showing the most recent needs only");
  });

  // NEED_OPTION_LIMIT is 200 and needs_capped is `needs.length >= 200`, so 200
  // rows is the boundary the help text turns on at. Django's own queryset is
  // unbounded (33,931 rows in production, PLAN.md 2974); the cap is a
  // documented deviation, and the sentence under the select is the only thing
  // on screen that admits the list is incomplete.
  it("warns that the need list was capped once 200 needs exist", async () => {
    for (let i = 0; i < 200; i++) {
      seedNeed({ id: 100 + i, need_id: `pad${String(i).padStart(29, "0")}`, foodbankId: SALISBURY.id, created: `2026-06-${String((i % 28) + 1).padStart(2, "0")} 12:00:00.000000` });
    }
    const { html } = await get("/admin/order/new/");

    expect(html).toContain("Showing the most recent needs only");
    expect(optionValues(html, "id_need")).toHaveLength(201); // the blank option plus the 200 capped rows
  });
});

// ---------------------------------------------------------------------------
// GET ?foodbank=<slug> -- forms.py:207-210's initial + narrowed need queryset
// ---------------------------------------------------------------------------

describe("adminOrderForm GET /admin/order/new/?foodbank=<slug>", () => {
  it("preselects the food bank and titles the page after it", async () => {
    const { res, html } = await get("/admin/order/new/?foodbank=salisbury");

    expect(res.status).toBe(200);
    // views.py:482, with Foodbank.__str__ = self.name (foodbank.py:142-143).
    expect(html).toContain("<h2>New Order for Salisbury Food Bank</h2>");
    expect(selectedOption(html, "id_foodbank")).toBe(String(SALISBURY.id));
  });

  // forms.py:207-210 narrows the need queryset to the selected food bank's own
  // needs. The Aberdeen need and the orphan need must BOTH be gone -- a filter
  // asserted only against the rows that should survive is a filter that can be
  // deleted with every test still green.
  it("narrows the need list to that food bank's own needs", async () => {
    const { html } = await get("/admin/order/new/?foodbank=salisbury");

    expect(optionValues(html, "id_need")).toEqual(["", String(NEED_SALISBURY.id)]);
    expect(html).not.toContain("99887766"); // the Aberdeen need's id prefix
  });

  // views.py:459-461 uses Foodbank.objects.get(slug=...), which raises
  // DoesNotExist and 500s. The port 404s instead and says so in its own
  // comment -- a deliberate fix, pinned here so it stays one.
  it("404s an unknown ?foodbank slug where Django 500s", async () => {
    const { res } = await get("/admin/order/new/?foodbank=no-such-food-bank");

    expect(res.status).toBe(404);
  });

  // SUSPECT, pinned as-is. The lookup is unfiltered by is_closed, so a closed
  // food bank can be preselected on a NEW order -- and then getFoodbankOptionById
  // appends it to the <select> so the selection renders. But handlePost rejects
  // exactly this with "That food bank is closed." (the `order?.foodbank_id`
  // guard only forgives a food bank the order ALREADY had, and a new order has
  // none). So the form offers a choice it will refuse to save: the admin fills
  // in the whole order and loses the round trip. Django reaches the same
  // rejection but never renders the option as chosen, because forms.py:190's
  // queryset does not contain it.
  it("preselects a CLOSED food bank on a new order, which the POST will then refuse", async () => {
    const { res, html } = await get("/admin/order/new/?foodbank=shuttered");

    expect(res.status).toBe(200);
    expect(selectedOption(html, "id_foodbank")).toBe(String(SHUTTERED.id));
    expect(optionLabels(html, "id_foodbank")).toContain("Shuttered Food Bank");

    const { res: postRes, html: postHtml } = await post("/admin/order/new/?foodbank=shuttered", { ...TYPED, foodbank: String(SHUTTERED.id) });
    expect(postRes.status).toBe(200);
    expect(errorBanner(postHtml)).toBe("That food bank is closed.");
    expect(orders()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GET the edit form -- every stored field back on screen
// ---------------------------------------------------------------------------

describe("adminOrderForm GET /admin/order/:orderId/edit/", () => {
  it("404s an order_id nothing holds", async () => {
    const { res } = await get("/admin/order/gf-nothing-here-2026-01-01/edit/");

    expect(res.status).toBe(404);
  });

  // views.py:464's get_object_or_404(Order, order_id=id) -- the HUMAN-READABLE
  // order_id, never the primary key. Looking up by `id` instead would resolve
  // the wrong row for every order whose pk happens to match another's, and
  // would 404 the real URLs the admin follows from the orders list.
  it("looks the order up by order_id, not by primary key", async () => {
    seedOrder({ id: 55, order_id: "gf-salisbury-tesco-2026-02-10" });

    expect((await get("/admin/order/gf-salisbury-tesco-2026-02-10/edit/")).res.status).toBe(200);
    expect((await get("/admin/order/55/edit/")).res.status).toBe(404);
  });

  it("titles the page 'Edit <order_id>', as views.py:479 does", async () => {
    seedOrder({ id: 55, order_id: "gf-salisbury-tesco-2026-02-10" });
    const { html } = await get("/admin/order/gf-salisbury-tesco-2026-02-10/edit/");

    expect(html).toContain("<h2>Edit gf-salisbury-tesco-2026-02-10</h2>");
  });

  // THE #34-CLASS TEST, on the read half. Every one of the ten editable fields
  // OrderForm declares (forms.py:192-194's `fields = "__all__"` over
  // models/orders.py:30-49) is set to a distinctive stored value and asserted
  // back off the rendered page -- the three <select>s through their `selected`
  // attribute, which is the only way to see them: a chosen option's value never
  // appears as page text, so grepping the HTML would pass with every dropdown
  // silently reset to blank.
  it("brings all ten editable fields back onto the form", async () => {
    seedOrder({
      id: 55,
      order_id: "gf-salisbury-sainsburys-2026-02-10",
      items_text: "3 x Tinned Tomatoes\n2 x Pasta 500g",
      foodbank_id: SALISBURY.id,
      need_id: NEED_SALISBURY.id,
      order_group_id: GROUP_WINTER.id,
      source_url: "https://example.invalid/status/4242",
      delivery_date: "2026-02-10",
      delivery_hour: 17,
      delivery_provider: "Sainsbury's",
      delivery_provider_id: "SB-STORED-01",
      actual_cost: 1999,
    });
    const { html } = await get("/admin/order/gf-salisbury-sainsburys-2026-02-10/edit/");

    expect(selectedOption(html, "id_foodbank")).toBe(String(SALISBURY.id));
    expect(textareaValue(html, "id_items_text")).toBe("3 x Tinned Tomatoes\n2 x Pasta 500g");
    expect(selectedOption(html, "id_need")).toBe(String(NEED_SALISBURY.id));
    expect(selectedOption(html, "id_order_group")).toBe(String(GROUP_WINTER.id));
    expect(inputValue(html, "id_source_url")).toBe("https://example.invalid/status/4242");
    expect(inputValue(html, "id_delivery_date")).toBe("2026-02-10");
    expect(selectedOption(html, "id_delivery_hour")).toBe("17");
    expect(selectedOption(html, "id_delivery_provider")).toBe("Sainsbury's");
    expect(inputValue(html, "id_delivery_provider_id")).toBe("SB-STORED-01");
    expect(inputValue(html, "id_actual_cost")).toBe("1999");
  });

  // `{{ data.actual_cost if data.actual_cost != null else "" }}` -- a stored
  // zero is a real value (a free delivery) and must render as "0", not as the
  // empty box a plain truthiness test would give. Saving that empty box back
  // would silently turn a known £0.00 into "cost unknown".
  it("renders a stored actual_cost of 0 as 0, not as an empty box", async () => {
    seedOrder({ id: 55, order_id: "gf-salisbury-tesco-2026-02-10", actual_cost: 0 });
    const { html } = await get("/admin/order/gf-salisbury-tesco-2026-02-10/edit/");

    expect(inputValue(html, "id_actual_cost")).toBe("0");
  });

  it("leaves the optional fields blank when the stored order has none", async () => {
    seedOrder({ id: 55, order_id: "gf-salisbury-tesco-2026-02-10", source_url: null, delivery_provider_id: null, actual_cost: null });
    const { html } = await get("/admin/order/gf-salisbury-tesco-2026-02-10/edit/");

    // `or ""` in the template, not the string "null" -- which is what a bare
    // `{{ data.source_url }}` would print for a NULL column.
    expect(inputValue(html, "id_source_url")).toBe("");
    expect(inputValue(html, "id_delivery_provider_id")).toBe("");
    expect(inputValue(html, "id_actual_cost")).toBe("");
  });

  // getFoodbankOptionById's whole reason for existing. Django's queryset
  // excludes closed food banks, so opening this form would render a <select>
  // with no matching option, the browser would submit the blank one, and the
  // next save would silently UNASSIGN the order -- and, via orders.py:102-107,
  // rename it. Assert both halves: the option is there AND it is the chosen one.
  it("keeps a since-closed food bank on the form so the selection survives", async () => {
    seedOrder({ id: 55, order_id: "gf-shuttered-tesco-2026-02-10", foodbank_id: SHUTTERED.id, country: "Wales" });
    const { html } = await get("/admin/order/gf-shuttered-tesco-2026-02-10/edit/");

    expect(optionValues(html, "id_foodbank")).toContain(String(SHUTTERED.id));
    expect(selectedOption(html, "id_foodbank")).toBe(String(SHUTTERED.id));
  });

  // The same hole one field over, and the worse one: an order's need can fall
  // outside the 200-row window or belong to a food bank other than the one now
  // selected. Without renderForm's append the <select> has no matching option,
  // the browser submits the blank one, and the save NULLs need_id -- severing
  // the order from the need it was placed against with nothing on screen to
  // say so. Here the order sits on Salisbury but its need is Aberdeen's, so the
  // food-bank filter alone would hide it.
  it("keeps a need from outside the filtered window so the selection survives", async () => {
    seedOrder({ id: 55, order_id: "gf-salisbury-tesco-2026-02-10", foodbank_id: SALISBURY.id, need_id: NEED_ABERDEEN.id });
    const { html } = await get("/admin/order/gf-salisbury-tesco-2026-02-10/edit/");

    // Only Salisbury's own need passes the filter; Aberdeen's is appended.
    expect(optionValues(html, "id_need")).toEqual(["", String(NEED_SALISBURY.id), String(NEED_ABERDEEN.id)]);
    expect(selectedOption(html, "id_need")).toBe(String(NEED_ABERDEEN.id));
  });

  it("writes nothing when the edit form is merely opened", async () => {
    seedOrder({ id: 55, order_id: "gf-salisbury-tesco-2026-02-10" });
    const before = onlyOrder();

    await get("/admin/order/gf-salisbury-tesco-2026-02-10/edit/");

    expect(onlyOrder()).toEqual(before);
    expect(adminJobs()).toHaveLength(0);
    expect(geminiFetch).not.toHaveBeenCalled();
  });

  // SUSPECT, pinned as-is: the ?foodbank= lookup runs before the method branch
  // and before the order is used, so a stray query string on an EDIT url 404s
  // a form that would otherwise render perfectly well -- even though nothing
  // on the edit path consumes `preselected` at all. Harmless today because
  // nothing links there with a query string, but it is a 404 with no cause the
  // admin can see.
  it("404s an edit URL carrying an unknown ?foodbank, though it ignores a known one", async () => {
    seedOrder({ id: 55, order_id: "gf-salisbury-tesco-2026-02-10" });

    expect((await get("/admin/order/gf-salisbury-tesco-2026-02-10/edit/?foodbank=nope")).res.status).toBe(404);
    // A known slug is looked up and then discarded -- the title still comes
    // from the order, not from views.py:482's "New Order for %s" branch.
    const { res, html } = await get("/admin/order/gf-salisbury-tesco-2026-02-10/edit/?foodbank=aberdeen");
    expect(res.status).toBe(200);
    expect(html).toContain("<h2>Edit gf-salisbury-tesco-2026-02-10</h2>");
  });
});

// ---------------------------------------------------------------------------
// POST -- the save actually happening
// ---------------------------------------------------------------------------

describe("adminOrderForm POST /admin/order/new/ -- a successful create", () => {
  // A redirect is not evidence of a save. #34 redirected too. Every column
  // upsertOrder names is read back out of SQLite here, including the ones the
  // handler derives rather than the admin types.
  it("writes every column of the row, derived ones included", async () => {
    const { res } = await post("/admin/order/new/", TYPED);
    expect(res.status).toBe(302);

    const row = onlyOrder();
    expect(row.order_id).toBe(TYPED_ORDER_ID);
    expect(row.foodbank_id).toBe(SALISBURY.id);
    expect(row.items_text).toBe(TYPED.items_text);
    expect(row.need_id).toBe(NEED_SALISBURY.id);
    expect(row.order_group_id).toBe(GROUP_WINTER.id);
    expect(row.source_url).toBe(TYPED.source_url);
    expect(row.delivery_date).toBe("2026-03-04");
    expect(row.delivery_hour).toBe(14);
    expect(row.delivery_provider).toBe("Sainsbury's");
    expect(row.delivery_provider_id).toBe("SB-99881-XZ");
    expect(row.actual_cost).toBe(4325);
    // orders.py:125-128 -- the denormalised country comes from the food bank,
    // never from the form.
    expect(row.country).toBe("England");
    // orders.py:110-116's naive datetime, written in the migrated
    // "YYYY-MM-DD HH:MM:SS.ffffff" shape order_delivery_datetime_idx sorts on.
    expect(row.delivery_datetime).toBe("2026-03-04 14:00:00.000000");
    // orders.py:118-122 zeroes all five and the parse that follows fills
    // them in -- within this same request now. Calories are 0 because no
    // orderitem row carries these names.
    expect([row.weight, row.calories, row.cost, row.no_lines, row.no_items]).toEqual([7800, 0, 800, 3, 9]);
    expect(row.notification_email_sent).toBeNull();
    // The parse restamps `modified` when it writes the aggregates, a moment
    // after the INSERT stamped both -- as Django's second save() does.
    expect(row.created).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
    expect(row.modified >= row.created).toBe(true);
  });

  // orderWrite.ts's d1Timestamp, and the reason it exists rather than the
  // pyNow() every other admin write path uses: `orders.created` and
  // `orders.delivery_datetime` are sorted on DIRECTLY against rows the
  // Postgres migration wrote as "YYYY-MM-DD HH:MM:SS.ffffff"
  // (adminLists.ts's getOrdersPage, getAllOrdersForCsv, and
  // order_delivery_datetime_idx). An ISO value differs at byte 11 -- "T"
  // (0x54) against " " (0x20) -- so under SQLite's byte-wise comparison every
  // new order would sort AFTER every migrated order sharing its date, and the
  // admin's "newest first" order list would interleave wrongly with the
  // 20-odd years of history underneath it. Asserted as a SHAPE because the
  // clock cannot be asserted as a value.
  it("stamps created and modified in the migrated timestamp shape, not ISO", async () => {
    await post("/admin/order/new/", TYPED);

    const row = onlyOrder();
    expect(row.created).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
    expect(row.modified).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
    expect(row.created).not.toContain("T");
    // delivery_datetime is built by deliveryDatetime() rather than the clock,
    // and shares the index -- so it has to agree byte for byte.
    expect(row.delivery_datetime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
  });

  // A zero delivered cost is a REAL value -- a free or donated delivery --
  // and `actualCostRaw === "" ? null : Number(...)` is the only thing keeping
  // it out of the NULL branch a truthiness test would put it in. Stored as
  // NULL it stops meaning "£0.00" and starts meaning "we never found out",
  // which is what the order page and the cost reporting then say.
  it("stores a delivered cost of 0 as 0, not as NULL", async () => {
    await post("/admin/order/new/", { ...TYPED, actual_cost: "0" });

    expect(onlyOrder().actual_cost).toBe(0);
  });

  // views.py:472 redirects to admin:order with the order_id. `?job=` is the
  // port's own addition so the page can say how the AI parse went -- and the
  // id in it must be the id of the admin_job row that was actually written,
  // or the page has no outcome to show.
  it("redirects to the new order with the id of the job that parsed it", async () => {
    const { res } = await post("/admin/order/new/", TYPED);

    const jobs = adminJobs();
    expect(jobs).toHaveLength(1);
    expect(res.headers.get("Location")).toBe(`/admin/order/${TYPED_ORDER_ID}/?job=${jobs[0]!.id}`);
  });

  // The AI half of Django's Order.save() (orders.py:130-216) runs during the
  // save, as Django's does. It used to be a queue job, and the `jobs` queue's
  // 30 s batch timeout meant the admin landed on an empty order and waited.
  // By the time the redirect goes out the lines must exist, against the ROW
  // id (orderline.order_id is the integer pk, not the human-readable id), and
  // the job must already say `done`.
  it("parses the items text into lines before it redirects", async () => {
    await post("/admin/order/new/", TYPED);

    const job = adminJobs()[0]!;
    expect(job.kind).toBe("order-lines");
    expect(job.target).toBe(TYPED_ORDER_ID);
    expect(job.status).toBe("done");
    expect(geminiFetch).toHaveBeenCalledTimes(1);
    expect(String(geminiFetch.mock.calls[0]![0])).toContain("/models/gemini-2.5-flash:generateContent");
    expect(orderLines()).toEqual([
      { order_id: onlyOrder().id, name: "Baked Beans 400g", quantity: 2, weight: 800, line_cost: 110 },
      { order_id: onlyOrder().id, name: "Long Grain Rice 1kg", quantity: 1, weight: 1000, line_cost: 120 },
      { order_id: onlyOrder().id, name: "UHT Milk 1l", quantity: 6, weight: 6000, line_cost: 570 },
    ]);
    expect(onlyOrder()).toMatchObject({ no_lines: 3, no_items: 9, weight: 7800, cost: 800 });
  });

  // orders.py:214-216 -- MAX(delivery_date) over that food bank's orders. The
  // food bank's public pages advertise it, so a save that skipped it would
  // leave the site claiming a delivery that had not been recorded.
  it("recomputes the food bank's last_order", async () => {
    expect(foodbankRow(SALISBURY.id).last_order).toBeNull();

    await post("/admin/order/new/", TYPED);

    expect(foodbankRow(SALISBURY.id).last_order).toBe("2026-03-04");
    expect(foodbankRow(ABERDEEN.id).last_order).toBeNull();
  });

  // MAX, not "the one just saved": back-filling an older order must not drag
  // last_order backwards past a newer one.
  it("keeps last_order at the newest delivery when an older order is added", async () => {
    seedOrder({ id: 55, order_id: "gf-salisbury-tesco-2026-09-01", delivery_date: "2026-09-01", delivery_datetime: "2026-09-01 09:00:00.000000" });
    db.prepare("UPDATE foodbank SET last_order = ? WHERE id = ?").run("2026-09-01", SALISBURY.id);

    await post("/admin/order/new/", TYPED); // delivery_date 2026-03-04, older

    expect(foodbankRow(SALISBURY.id).last_order).toBe("2026-09-01");
  });

  // THE #34 TEST. Save everything, then re-open the edit form and read each
  // field back off the page. A field parsed, threaded down and written by no
  // SQL -- or written but never re-read -- shows up here and nowhere else,
  // because the redirect looks identical either way.
  it("round-trips every field: save it, re-open the form, get it back", async () => {
    await post("/admin/order/new/", TYPED);
    const { html } = await get(`/admin/order/${TYPED_ORDER_ID}/edit/`);

    expect(selectedOption(html, "id_foodbank")).toBe(TYPED.foodbank);
    expect(textareaValue(html, "id_items_text")).toBe(TYPED.items_text);
    expect(selectedOption(html, "id_need")).toBe(TYPED.need);
    expect(selectedOption(html, "id_order_group")).toBe(TYPED.order_group);
    expect(inputValue(html, "id_source_url")).toBe(TYPED.source_url);
    expect(inputValue(html, "id_delivery_date")).toBe(TYPED.delivery_date);
    expect(selectedOption(html, "id_delivery_hour")).toBe(TYPED.delivery_hour);
    expect(selectedOption(html, "id_delivery_provider")).toBe(TYPED.delivery_provider);
    expect(inputValue(html, "id_delivery_provider_id")).toBe(TYPED.delivery_provider_id);
    expect(inputValue(html, "id_actual_cost")).toBe(TYPED.actual_cost);
  });

  // The three optional foreign keys are the ones that can be silently dropped
  // without anything on the page looking wrong, so each is saved on its own
  // with the others blank -- an INSERT with two binds transposed would still
  // pass a test that set all three to the same kind of value.
  it("stores a null for each optional selection left blank", async () => {
    await post("/admin/order/new/", { ...TYPED, need: "", order_group: "" });

    const row = onlyOrder();
    expect(row.need_id).toBeNull();
    expect(row.order_group_id).toBeNull();
    expect(row.foodbank_id).toBe(SALISBURY.id);
  });

  // formValue() trims every scalar, so a delivery_provider_id of spaces is an
  // empty selection and stores NULL rather than "   ". items_text is the one
  // exception -- see its own test below.
  it("trims scalars and stores an all-whitespace optional as NULL", async () => {
    await post("/admin/order/new/", { ...TYPED, delivery_provider_id: "   SB-7  ", source_url: "   " });

    const row = onlyOrder();
    expect(row.delivery_provider_id).toBe("SB-7");
    expect(row.source_url).toBeNull();
  });

  // items_text is read raw (`typeof body.items_text === "string" ? ... : ""`),
  // only its emptiness check trims. So indentation and trailing newlines in a
  // pasted order survive into the column the AI parse reads -- which is the
  // behaviour the parse wants, since line structure is what it keys on.
  it("stores items_text verbatim, whitespace and all", async () => {
    await post("/admin/order/new/", { ...TYPED, items_text: "  2 x Beans\n\n  1 x Rice\n" });

    expect(onlyOrder().items_text).toBe("  2 x Beans\n\n  1 x Rice\n");
  });

  // KILLS THE MUTANT: entity-escape items_text on the way IN (`.replace(/&/g,
  // "&amp;")` in handlePost) -- which every other test in this file survives,
  // because not one of them pastes a character HTML cares about. A real
  // supermarket paste is full of them: "Heinz" quotes, "Beans & Sauce",
  // "<400g>". Escaping on the way in is the classic wrong fix for the
  // way-out escaping the template already does, and it corrupts the column
  // the AI parse reads AND compounds on every re-save (&amp; -> &amp;amp;).
  //
  // So: the row holds exactly what was typed, the PAGE holds the escaped form
  // (a pasted <script> must not become one), and the decoded page equals the
  // paste again on the way back.
  it("stores markup-ish items_text byte for byte, and escapes it only on the page", async () => {
    const pasted = '2 x "Heinz" Beans & Sauce <400g>\n1 x O\'Brien Rice';
    await post("/admin/order/new/", { ...TYPED, items_text: pasted });

    expect(onlyOrder().items_text).toBe(pasted);

    const { html } = await get(`/admin/order/${TYPED_ORDER_ID}/edit/`);
    expect(html).toContain("&amp;");
    expect(html).not.toContain("<400g>");
    expect(textareaValue(html, "id_items_text")).toBe(pasted);
  });
});

describe("adminOrderForm POST /admin/order/new/ -- order_id derivation", () => {
  // orders.py:102-104 stamps a `temp-order-<uuid4>` placeholder, then :207-211
  // replaces it once the INSERT has produced a primary key. Both steps happen
  // here, so what must be asserted is that the SECOND one landed: a row still
  // holding a temp id means setOrderId never ran, and the admin's redirect
  // would 404.
  it("names a new unassigned order after its primary key, not the temp uuid", async () => {
    const { res } = await post("/admin/order/new/", { ...TYPED, foodbank: "" });

    const row = onlyOrder();
    expect(row.order_id).toBe(`gf-unassigned-${row.id}-sainsburys-2026-03-04`);
    expect(row.order_id).not.toContain("temp-order-");
    expect(res.headers.get("Location")).toContain(`/admin/order/${row.order_id}/?job=`);
    // orders.py:125-128 -- "" for unassigned, and the column is NOT NULL, so
    // this must be the empty string and not a NULL that SQLite would reject.
    expect(row.country).toBe("");
  });

  // Django's slugify() str()s its argument first, so slugify(None) is
  // "none" -- the literal word, not an empty segment. A "gf-unassigned-7--"
  // id would be a different URL from every one already in circulation.
  it("puts the literal 'none' in the id when no provider was chosen", async () => {
    await post("/admin/order/new/", { ...TYPED, foodbank: "", delivery_provider: "" });

    const row = onlyOrder();
    expect(row.order_id).toBe(`gf-unassigned-${row.id}-none-2026-03-04`);
    expect(row.delivery_provider).toBeNull();
  });

  // The whole reason slugifyProvider exists: an apostrophe is stripped, not
  // hyphenated, so "Sainsbury's" is "sainsburys" and not "sainsbury-s".
  it("slugifies each provider the way Django's slugify does", async () => {
    await post("/admin/order/new/", { ...TYPED, delivery_provider: "Pedal Me" });
    expect(onlyOrder().order_id).toBe("gf-salisbury-pedal-me-2026-03-04");
  });

  // KILLS THE MUTANT: `slugifyProvider(data.delivery_provider)` ->
  // `slugifyProvider(deliveryProviderRaw)` in the ASSIGNED branch
  // (orderForm.ts:317). The two differ in exactly one case -- an assigned
  // order with no provider chosen -- because data.delivery_provider is null
  // there and the raw field is "", and slugifyProvider(null) is Python's
  // slugify(None) -> "none" while slugify("") is "". Every other test picks a
  // provider, so the swap was invisible: the id became "gf-salisbury--
  // 2026-03-04", a URL with an empty segment that matches nothing already in
  // circulation and reads as a typo. The unassigned branch two lines down has
  // its own test for the same "none"; this is the assigned half of it.
  it("puts the literal 'none' in an ASSIGNED order's id when no provider was chosen", async () => {
    const { res } = await post("/admin/order/new/", { ...TYPED, delivery_provider: "" });

    const row = onlyOrder();
    expect(row.order_id).toBe("gf-salisbury-none-2026-03-04");
    expect(row.delivery_provider).toBeNull();
    expect(res.headers.get("Location")).toContain("/admin/order/gf-salisbury-none-2026-03-04/?job=");
  });

  it("names an assigned order gf-<slug>-<provider>-<date>", async () => {
    await post("/admin/order/new/", { ...TYPED, foodbank: String(ABERDEEN.id), delivery_provider: "Costco" });
    expect(onlyOrder().order_id).toBe("gf-aberdeen-costco-2026-03-04");
    expect(onlyOrder().country).toBe("Scotland");
  });
});

// ---------------------------------------------------------------------------
// POST -- editing
// ---------------------------------------------------------------------------

describe("adminOrderForm POST /admin/order/:orderId/edit/", () => {
  // An UPDATE, not a second INSERT. A create/edit split that fell through to
  // the insert branch would leave two orders where the admin sees one, and the
  // old one would keep whatever the food bank pages already point at.
  it("updates the existing row in place", async () => {
    seedOrder({ id: 55, order_id: "gf-salisbury-tesco-2026-02-10" });

    const { res } = await post("/admin/order/gf-salisbury-tesco-2026-02-10/edit/", { ...TYPED, delivery_provider: "Tesco", delivery_date: "2026-02-10" });

    expect(res.status).toBe(302);
    expect(orders()).toHaveLength(1);
    expect(onlyOrder().id).toBe(55);
    expect(onlyOrder().items_text).toBe(TYPED.items_text);
    expect(onlyOrder().actual_cost).toBe(4325);
  });

  // KILLS FOUR MUTANTS, all of them in orderWrite.ts's UPDATE and all of them
  // #34's own shape one statement over:
  //
  //   drop `delivery_hour = ?` from the SET list
  //   drop `delivery_provider = ?` from the SET list
  //   swap the need_id / order_group_id binds
  //   swap the source_url / delivery_provider_id binds
  //
  // Every one of those survived the whole of the rest of this file, because
  // "writes every column of the row" reads all twelve back on the CREATE path
  // and the edit tests each read back two or three. An UPDATE that had quietly
  // stopped writing delivery_hour would leave an order delivering at 09:00
  // while its delivery_datetime, its order_id and the form all said 14:00 --
  // and the admin would have pressed Save and been redirected.
  //
  // So this is the create path's column-by-column read-back, done again
  // against an UPDATE: the seeded row differs from the submitted one in EVERY
  // editable column (different food bank, need, group, url, date, hour,
  // provider, provider id, cost, items), so a column the UPDATE forgot keeps a
  // visibly stale value and a transposed pair of binds lands in the wrong one.
  it("rewrites every column on an edit, not just the ones a create proves", async () => {
    seedOrder({
      id: 55,
      order_id: "gf-aberdeen-tesco-2026-02-10",
      items_text: "1 x Seeded Item",
      country: "Scotland",
      foodbank_id: ABERDEEN.id,
      need_id: NEED_ABERDEEN.id,
      order_group_id: GROUP_ALPHA.id,
      source_url: "https://example.invalid/seeded",
      delivery_date: "2026-02-10",
      delivery_hour: 9,
      delivery_datetime: "2026-02-10 09:00:00.000000",
      delivery_provider: "Tesco",
      delivery_provider_id: "TS-SEEDED",
      actual_cost: 111,
    });

    const { res } = await post("/admin/order/gf-aberdeen-tesco-2026-02-10/edit/", TYPED);
    expect(res.status).toBe(302);

    const row = onlyOrder();
    expect(row.id).toBe(55); // the same row, not a second one
    expect(row.order_id).toBe(TYPED_ORDER_ID);
    expect(row.foodbank_id).toBe(SALISBURY.id);
    expect(row.country).toBe("England"); // re-derived from the new food bank
    expect(row.items_text).toBe(TYPED.items_text);
    expect(row.need_id).toBe(NEED_SALISBURY.id);
    expect(row.order_group_id).toBe(GROUP_WINTER.id);
    expect(row.source_url).toBe(TYPED.source_url);
    expect(row.delivery_date).toBe("2026-03-04");
    expect(row.delivery_hour).toBe(14);
    expect(row.delivery_datetime).toBe("2026-03-04 14:00:00.000000");
    expect(row.delivery_provider).toBe("Sainsbury's");
    expect(row.delivery_provider_id).toBe("SB-99881-XZ");
    expect(row.actual_cost).toBe(4325);

    // ...and the edit form at the order's NEW url shows all ten of them, which
    // is the half of the round trip a column-by-column row read cannot make:
    // a value written to the right column and then read back through the wrong
    // one looks identical in SQLite and wrong on screen.
    const { html } = await get(`/admin/order/${TYPED_ORDER_ID}/edit/`);
    expect(selectedOption(html, "id_foodbank")).toBe(TYPED.foodbank);
    expect(textareaValue(html, "id_items_text")).toBe(TYPED.items_text);
    expect(selectedOption(html, "id_need")).toBe(TYPED.need);
    expect(selectedOption(html, "id_order_group")).toBe(TYPED.order_group);
    expect(inputValue(html, "id_source_url")).toBe(TYPED.source_url);
    expect(inputValue(html, "id_delivery_date")).toBe(TYPED.delivery_date);
    expect(selectedOption(html, "id_delivery_hour")).toBe(TYPED.delivery_hour);
    expect(selectedOption(html, "id_delivery_provider")).toBe(TYPED.delivery_provider);
    expect(inputValue(html, "id_delivery_provider_id")).toBe(TYPED.delivery_provider_id);
    expect(inputValue(html, "id_actual_cost")).toBe(TYPED.actual_cost);
  });

  // KILLS TWO MUTANTS: `if (isNew)` in front of insertAdminJob, and the same
  // in front of the parse. Both survived everything else here, because the
  // job assertions all lived on the create path -- and an edit is the save
  // that MOST needs the parse, since editing items_text is the whole reason to
  // reopen the form. Without the row the redirect's `?job=` names a job that
  // does not exist; without the parse the lines keep describing the previous
  // paste.
  //
  // The parse must also target the ROW id on this path -- it re-reads the
  // order by primary key, and on an edit the pk is the seeded one rather than
  // a freshly inserted one.
  it("parses on an edit too, against the existing row's pk", async () => {
    seedOrder({ id: 55, order_id: "gf-salisbury-tesco-2026-02-10" });

    const { res } = await post("/admin/order/gf-salisbury-tesco-2026-02-10/edit/", { ...TYPED, delivery_provider: "Tesco", delivery_date: "2026-02-10" });

    const jobs = adminJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.kind).toBe("order-lines");
    expect(jobs[0]!.target).toBe("gf-salisbury-tesco-2026-02-10");
    expect(jobs[0]!.status).toBe("done");
    expect(geminiFetch).toHaveBeenCalledTimes(1);
    expect(orderLines().map((line) => line.order_id)).toEqual([55, 55, 55]);
    expect(res.headers.get("Location")).toBe(`/admin/order/gf-salisbury-tesco-2026-02-10/?job=${jobs[0]!.id}`);
  });

  // KILLS THE MUTANT: `target: finalOrderId` -> `target: order?.order_id ??
  // finalOrderId`. orders.py:105-107 regenerates order_id on every save of an
  // assigned order, so the id the form was SUBMITTED to is routinely not the
  // id the row ends up with -- and adminJobs.ts's getLatestAdminJob finds a
  // job by (kind, target) while admin/jobs.njk:120 prints that target as the
  // only clue to which order a queued parse belongs. Stamped with the
  // pre-save id, the job names an order_id nothing holds any more: orphaned in
  // the jobs list, unfindable by the lookup, and pointing the maintainer at a
  // 404 when a parse fails. The parse test above cannot see it, because that
  // edit deliberately keeps the id the same.
  it("stamps the job with the order's NEW id when the save renames it", async () => {
    seedOrder({ id: 55, order_id: "gf-salisbury-tesco-2026-02-10" });

    const { res } = await post("/admin/order/gf-salisbury-tesco-2026-02-10/edit/", { ...TYPED, delivery_date: "2026-02-10" });

    const job = adminJobs()[0]!;
    expect(job.target).toBe("gf-salisbury-sainsburys-2026-02-10");
    expect(res.headers.get("Location")).toBe(`/admin/order/gf-salisbury-sainsburys-2026-02-10/?job=${job.id}`);
  });

  // orders.py:105-107 regenerates order_id on EVERY save of an assigned order,
  // so changing the provider changes the order's admin URL and the old one
  // 404s afterwards. Django behaves exactly this way (views.py:472 redirects
  // to the new id) and the port says it is deliberate -- so it is pinned,
  // including the fact that the old URL stops resolving.
  it("regenerates order_id when the provider changes, and the old URL stops working", async () => {
    seedOrder({ id: 55, order_id: "gf-salisbury-tesco-2026-02-10" });

    const { res } = await post("/admin/order/gf-salisbury-tesco-2026-02-10/edit/", { ...TYPED, delivery_date: "2026-02-10" });

    expect(onlyOrder().order_id).toBe("gf-salisbury-sainsburys-2026-02-10");
    expect(res.headers.get("Location")).toContain("/admin/order/gf-salisbury-sainsburys-2026-02-10/?job=");
    expect((await get("/admin/order/gf-salisbury-tesco-2026-02-10/edit/")).res.status).toBe(404);
  });

  it("regenerates order_id when the delivery date changes", async () => {
    seedOrder({ id: 55, order_id: "gf-salisbury-tesco-2026-02-10" });

    await post("/admin/order/gf-salisbury-tesco-2026-02-10/edit/", { ...TYPED, delivery_provider: "Tesco" });

    expect(onlyOrder().order_id).toBe("gf-salisbury-tesco-2026-03-04");
    expect(onlyOrder().delivery_datetime).toBe("2026-03-04 14:00:00.000000");
  });

  // Neither orders.py:102 (is_new) nor :105 (foodbank) fires when editing an
  // UNASSIGNED order, so its order_id -- and therefore its admin URL -- is
  // frozen forever. Regenerating it here would break every link to it.
  it("freezes an existing unassigned order's id, even when its date changes", async () => {
    seedOrder({ id: 55, order_id: "gf-unassigned-55-none-2026-02-10", foodbank_id: null, country: "", delivery_provider: null });

    const { res } = await post("/admin/order/gf-unassigned-55-none-2026-02-10/edit/", { ...TYPED, foodbank: "", delivery_provider: "" });

    expect(onlyOrder().order_id).toBe("gf-unassigned-55-none-2026-02-10");
    expect(onlyOrder().delivery_date).toBe("2026-03-04");
    expect(res.headers.get("Location")).toContain("/admin/order/gf-unassigned-55-none-2026-02-10/?job=");
  });

  // Unassigning an order that HAD a food bank: is_new is false and foodbank is
  // null, so neither branch fires and the id keeps its old "gf-salisbury-..."
  // shape even though the order no longer belongs to Salisbury. Faithful to
  // Django, and confusing in exactly the same way -- pinned so it stays a
  // known quantity rather than becoming a surprise.
  it("keeps the old food bank's name in the id when an order is unassigned", async () => {
    seedOrder({ id: 55, order_id: "gf-salisbury-tesco-2026-02-10" });

    await post("/admin/order/gf-salisbury-tesco-2026-02-10/edit/", { ...TYPED, foodbank: "" });

    expect(onlyOrder().foodbank_id).toBeNull();
    expect(onlyOrder().country).toBe("");
    expect(onlyOrder().order_id).toBe("gf-salisbury-tesco-2026-02-10");
  });

  // orders.py:118-122 re-zeroes the five aggregates before the AI reparse
  // regenerates them. Asserted from non-zero seeds so that "they were
  // replaced" is a real observation rather than a column that was never
  // written.
  it("replaces the five derived aggregates on every save", async () => {
    seedOrder({ id: 55, order_id: "gf-salisbury-tesco-2026-02-10", weight: 12400, calories: 33100, cost: 2750, no_lines: 8, no_items: 19 });

    await post("/admin/order/gf-salisbury-tesco-2026-02-10/edit/", { ...TYPED, delivery_provider: "Tesco", delivery_date: "2026-02-10" });

    const row = onlyOrder();
    expect([row.weight, row.calories, row.cost, row.no_lines, row.no_items]).toEqual([7800, 0, 800, 3, 9]);
    // actual_cost is the admin's own field, not an aggregate -- it must NOT be
    // caught up in the recompute.
    expect(row.actual_cost).toBe(4325);
  });

  // notification_email_sent is editable=False and Django's save() never
  // touches it; the UPDATE deliberately omits it. Clearing it would let the
  // same food bank be emailed about the same order twice.
  it("leaves notification_email_sent and created alone", async () => {
    seedOrder({ id: 55, order_id: "gf-salisbury-tesco-2026-02-10", notification_email_sent: "2026-02-11 08:00:00.000000" });

    await post("/admin/order/gf-salisbury-tesco-2026-02-10/edit/", { ...TYPED, delivery_provider: "Tesco", delivery_date: "2026-02-10" });

    const row = onlyOrder();
    expect(row.notification_email_sent).toBe("2026-02-11 08:00:00.000000");
    expect(row.created).toBe("2026-02-01 10:00:00.000000");
    expect(row.modified).not.toBe("2026-02-01 10:00:00.000000");
  });

  // NOT IN DJANGO, and the reason it is here: Django recomputes last_order on
  // the NEW food bank only, so moving an order leaves the PREVIOUS one
  // advertising a delivery it no longer has. Both sides are asserted, and the
  // previous side is the half that would silently rot.
  it("recomputes last_order on BOTH food banks when an order moves between them", async () => {
    seedOrder({ id: 55, order_id: "gf-salisbury-tesco-2026-02-10", delivery_date: "2026-02-10", delivery_datetime: "2026-02-10 09:00:00.000000" });
    db.prepare("UPDATE foodbank SET last_order = ? WHERE id = ?").run("2026-02-10", SALISBURY.id);

    await post("/admin/order/gf-salisbury-tesco-2026-02-10/edit/", { ...TYPED, foodbank: String(ABERDEEN.id), need: "" });

    expect(foodbankRow(ABERDEEN.id).last_order).toBe("2026-03-04");
    // Salisbury has no orders left at all, so MAX() is NULL -- not the stale
    // 2026-02-10 Django would leave behind.
    expect(foodbankRow(SALISBURY.id).last_order).toBeNull();
  });

  // THE MIRROR OF #34, and the failure mode an "it saved" test cannot see:
  // #34 was a field the form parsed and no SQL wrote, so the value never
  // arrived; this is a field the form CLEARS and no SQL writes, so the old
  // value never leaves. An UPDATE that skipped its NULL binds -- or an upsert
  // written as "only set what was supplied" -- redirects, re-renders with the
  // stale values still in the boxes, and leaves the admin pressing Save at a
  // field that will not clear. Every optional column is cleared at once here
  // and read straight back out of SQLite, because that is the only place the
  // difference shows.
  it("clears every optional field that the admin blanked", async () => {
    seedOrder({
      id: 55,
      order_id: "gf-salisbury-tesco-2026-02-10",
      need_id: NEED_SALISBURY.id,
      order_group_id: GROUP_WINTER.id,
      source_url: "https://example.invalid/status/1",
      delivery_provider_id: "TS-0001",
      actual_cost: 3300,
    });

    const { res } = await post("/admin/order/gf-salisbury-tesco-2026-02-10/edit/", {
      ...TYPED,
      delivery_provider: "Tesco",
      delivery_date: "2026-02-10",
      need: "",
      order_group: "",
      source_url: "",
      delivery_provider_id: "",
      actual_cost: "",
    });

    expect(res.status).toBe(302);
    const row = onlyOrder();
    expect(row.need_id).toBeNull();
    expect(row.order_group_id).toBeNull();
    expect(row.source_url).toBeNull();
    expect(row.delivery_provider_id).toBeNull();
    expect(row.actual_cost).toBeNull();
    // ...and the cleared form is what comes back on the next visit, not the
    // values the admin thought they had just removed.
    const { html } = await get("/admin/order/gf-salisbury-tesco-2026-02-10/edit/");
    expect(selectedOption(html, "id_need")).toBeNull();
    expect(selectedOption(html, "id_order_group")).toBeNull();
    expect(inputValue(html, "id_source_url")).toBe("");
    expect(inputValue(html, "id_delivery_provider_id")).toBe("");
    expect(inputValue(html, "id_actual_cost")).toBe("");
  });

  // A closed food bank is rejected outright ONLY when it is a NEW choice.
  // Re-saving an order that already sits on a since-closed food bank has to
  // keep working, or the order becomes permanently uneditable.
  it("lets an order keep the closed food bank it already had", async () => {
    seedOrder({ id: 55, order_id: "gf-shuttered-tesco-2026-02-10", foodbank_id: SHUTTERED.id, country: "Wales" });

    const { res } = await post("/admin/order/gf-shuttered-tesco-2026-02-10/edit/", { ...TYPED, foodbank: String(SHUTTERED.id), need: "" });

    expect(res.status).toBe(302);
    expect(onlyOrder().foodbank_id).toBe(SHUTTERED.id);
    expect(onlyOrder().country).toBe("Wales");
  });
});

// ---------------------------------------------------------------------------
// POST -- Order.Meta.unique_together (orders.py:57)
// ---------------------------------------------------------------------------

describe("adminOrderForm POST -- the duplicate-order check", () => {
  // Django's ModelForm reports this as a non-field error and re-renders the
  // BOUND form. There is no unique index on `orders` in D1 (0005 declares
  // none), so findConflictingOrder is the only thing standing between the
  // admin and two orders on the same food bank, date and provider -- there is
  // no SQLITE_CONSTRAINT backstop the way there is for donation points.
  it("refuses a second order on the same food bank, date and provider", async () => {
    seedOrder({ id: 55, order_id: "gf-salisbury-sainsburys-2026-03-04", delivery_date: "2026-03-04", delivery_provider: "Sainsbury's" });

    const { res, html } = await post("/admin/order/new/", TYPED);

    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
    expect(errorBanner(html)).toBe("Order with this Foodbank, Delivery date and Delivery provider already exists.");
    expect(orders()).toHaveLength(1);
    expect(onlyOrder().items_text).toBe("1 x Seeded Item");
  });

  // Each of the three columns on its own -- a check that had dropped one of
  // them would still pass a test that only varied all three together.
  it("allows the same date and provider on a different food bank", async () => {
    seedOrder({ id: 55, order_id: "gf-salisbury-sainsburys-2026-03-04", delivery_date: "2026-03-04", delivery_provider: "Sainsbury's" });

    const { res } = await post("/admin/order/new/", { ...TYPED, foodbank: String(ABERDEEN.id), need: "" });

    expect(res.status).toBe(302);
    expect(orders()).toHaveLength(2);
  });

  it("allows the same food bank and provider on a different date", async () => {
    seedOrder({ id: 55, order_id: "gf-salisbury-sainsburys-2026-03-04", delivery_date: "2026-03-04", delivery_provider: "Sainsbury's" });

    const { res } = await post("/admin/order/new/", { ...TYPED, delivery_date: "2026-03-05" });

    expect(res.status).toBe(302);
    expect(orders()).toHaveLength(2);
  });

  it("allows the same food bank and date with a different provider", async () => {
    seedOrder({ id: 55, order_id: "gf-salisbury-sainsburys-2026-03-04", delivery_date: "2026-03-04", delivery_provider: "Sainsbury's" });

    const { res } = await post("/admin/order/new/", { ...TYPED, delivery_provider: "Costco" });

    expect(res.status).toBe(302);
    expect(orders()).toHaveLength(2);
  });

  // orders.py:54-56 says this is intentional: SQL treats NULLs as distinct, so
  // unassigned orders never collide and are told apart by their order_id.
  // findConflictingOrder returns null immediately for a null foodbankId rather
  // than writing a query whose NULL comparisons could never match.
  it("permits two unassigned orders on the same date and provider, as Django does", async () => {
    await post("/admin/order/new/", { ...TYPED, foodbank: "" });
    const { res } = await post("/admin/order/new/", { ...TYPED, foodbank: "" });

    expect(res.status).toBe(302);
    expect(orders()).toHaveLength(2);
  });

  // excludeId. Without it, re-saving an order without changing its key columns
  // would collide with itself and the order would become permanently
  // unsavable -- the same class of regression exceptId exists to prevent on
  // the donation point form.
  it("does not let an order collide with itself on re-save", async () => {
    seedOrder({ id: 55, order_id: "gf-salisbury-sainsburys-2026-03-04", delivery_date: "2026-03-04", delivery_provider: "Sainsbury's" });

    const { res } = await post("/admin/order/gf-salisbury-sainsburys-2026-03-04/edit/", TYPED);

    expect(res.status).toBe(302);
    expect(orders()).toHaveLength(1);
    expect(onlyOrder().items_text).toBe(TYPED.items_text);
  });

  // ...but self-exclusion must be BY ID, not "some row with these values", or
  // an edit that moves one order onto another's slot goes unreported.
  it("still refuses an edit that moves one order onto another's slot", async () => {
    seedOrder({ id: 55, order_id: "gf-salisbury-sainsburys-2026-03-04", delivery_date: "2026-03-04", delivery_provider: "Sainsbury's" });
    seedOrder({ id: 56, order_id: "gf-salisbury-costco-2026-03-04", delivery_date: "2026-03-04", delivery_provider: "Costco" });

    const { res, html } = await post("/admin/order/gf-salisbury-costco-2026-03-04/edit/", TYPED);

    expect(res.status).toBe(200);
    expect(errorBanner(html)).toBe("Order with this Foodbank, Delivery date and Delivery provider already exists.");
    expect(orders().map((o) => o.order_id)).toEqual(["gf-salisbury-sainsburys-2026-03-04", "gf-salisbury-costco-2026-03-04"]);
  });

  // A conflict on a NULL provider can only be found by `delivery_provider IS
  // NULL`; spelled `= ?` with a null bind it matches nothing and the duplicate
  // is written.
  it("finds a conflict when both orders have no provider at all", async () => {
    seedOrder({ id: 55, order_id: "gf-salisbury-none-2026-03-04", delivery_date: "2026-03-04", delivery_provider: null });

    const { res, html } = await post("/admin/order/new/", { ...TYPED, delivery_provider: "" });

    expect(res.status).toBe(200);
    expect(errorBanner(html)).toBe("Order with this Foodbank, Delivery date and Delivery provider already exists.");
    expect(orders()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// POST -- validation failures preserve what the admin typed
// ---------------------------------------------------------------------------

// Every rejection below goes through the same three questions, because #12 was
// about the third one and a status-code assertion cannot see it:
//   1. is it the form again (not a 500, not a redirect)?
//   2. is the right message on it?
//   3. are the admin's own values still in the boxes, and is the database
//      untouched?
describe("adminOrderForm POST -- validation failures", () => {
  const cases: { label: string; fields: Record<string, string>; message: string }[] = [
    // orders.py:31, a TextField with no blank=True.
    { label: "items_text empty", fields: { items_text: "" }, message: "Items text is required." },
    { label: "items_text only whitespace", fields: { items_text: "   \n\t " }, message: "Items text is required." },
    { label: "delivery_date missing", fields: { delivery_date: "" }, message: "Delivery date is required and must be a real date." },
    // isValidDate's own comment: "2026-02-31" matches the regex and is not a
    // date, and Django's DateField rejects it. A shape-only check would let it
    // through and SQLite would happily store the string.
    { label: "delivery_date is 31 February", fields: { delivery_date: "2026-02-31" }, message: "Delivery date is required and must be a real date." },
    { label: "delivery_date is a UK-format date", fields: { delivery_date: "04/03/2026" }, message: "Delivery date is required and must be a real date." },
    // orders.py:40 is blank=False with no default; Django reports "This field
    // is required." for the blank choice.
    { label: "delivery_hour not chosen", fields: { delivery_hour: "" }, message: "Delivery hour is required." },
    { label: "delivery_hour outside the choices", fields: { delivery_hour: "23" }, message: "Delivery hour must be one of the listed hours." },
    { label: "delivery_hour before the first choice", fields: { delivery_hour: "5" }, message: "Delivery hour must be one of the listed hours." },
    { label: "delivery_hour not a number", fields: { delivery_hour: "elevenish" }, message: "Delivery hour must be one of the listed hours." },
    { label: "delivery_provider off the list", fields: { delivery_provider: "Ocado" }, message: "Unknown delivery provider." },
    // The choices are exact strings, not a case-insensitive match -- the value
    // ends up in the order_id and in the notification email.
    { label: "delivery_provider in the wrong case", fields: { delivery_provider: "tesco" }, message: "Unknown delivery provider." },
    { label: "source_url is not a URL", fields: { source_url: "not a url at all" }, message: "Source URL must be a valid http(s) URL." },
    // isValidUrl restricts the protocol as well as the shape -- URLField's
    // default validator allows only http/https too.
    { label: "source_url is a javascript: URL", fields: { source_url: "javascript:alert(1)" }, message: "Source URL must be a valid http(s) URL." },
    { label: "source_url is an ftp: URL", fields: { source_url: "ftp://example.invalid/x" }, message: "Source URL must be a valid http(s) URL." },
    // PositiveIntegerField, in pence -- so "43.25" is the mistake this catches,
    // and it is the one an admin actually makes.
    { label: "actual_cost given in pounds", fields: { actual_cost: "43.25" }, message: "Delivered cost must be a whole number of pence." },
    { label: "actual_cost negative", fields: { actual_cost: "-100" }, message: "Delivered cost must be a whole number of pence." },
    { label: "actual_cost not a number", fields: { actual_cost: "free" }, message: "Delivered cost must be a whole number of pence." },
    // parseFk's `undefined` branch -- "present but not a usable id", distinct
    // from the legitimate empty selection.
    { label: "foodbank id is not a number", fields: { foodbank: "salisbury" }, message: "Invalid selection." },
    { label: "need id is zero", fields: { need: "0" }, message: "Invalid selection." },
    { label: "order_group id is negative", fields: { order_group: "-1" }, message: "Invalid selection." },
    { label: "foodbank id is fractional", fields: { foodbank: "1.5" }, message: "Invalid selection." },
    // A client-supplied FK is never trusted to exist; Django's
    // ModelChoiceField resolves each against its queryset.
    { label: "foodbank id does not exist", fields: { foodbank: "9999" }, message: "Unknown food bank." },
    { label: "need id does not exist", fields: { need: "9999" }, message: "Unknown need." },
    { label: "order_group id does not exist", fields: { order_group: "9999" }, message: "Unknown order group." },
    // forms.py:190's queryset excludes closed food banks outright.
    { label: "food bank is closed", fields: { foodbank: String(SHUTTERED.id), need: "" }, message: "That food bank is closed." },
  ];

  for (const { label, fields, message } of cases) {
    it(`refuses and re-renders when ${label}`, async () => {
      const { res, html } = await post("/admin/order/new/", { ...TYPED, ...fields });

      // Not a 500 (issue #12's report) and not a 302 (a save silently
      // discarded, the one outcome worse than the 500). 200 rather than a 4xx
      // matches Django, whose bound invalid form re-renders through the same
      // render() call at views.py:486-491.
      expect(res.status).toBe(200);
      expect(res.headers.get("Location")).toBeNull();
      expect(errorBanner(html)).toBe(message);
    });

    it(`writes nothing and enqueues nothing when ${label}`, async () => {
      const { res } = await post("/admin/order/new/", { ...TYPED, ...fields });

      expect(res.status).toBe(200);
      expect(orders()).toHaveLength(0);
      expect(adminJobs()).toHaveLength(0);
      // A paid Gemini parse for an order that was never saved would burn
      // money on lines with nowhere to go.
      expect(geminiFetch).not.toHaveBeenCalled();
    });
  }

  // The point of the whole exercise. items_text here is dozens of lines pasted
  // out of a supermarket receipt; losing it to a rejected save is the same
  // loss #12 was reported for, just without a stack trace to explain it.
  it("gives the admin back every value they typed, selects included", async () => {
    const { html } = await post("/admin/order/new/", { ...TYPED, delivery_hour: "23" });

    expect(textareaValue(html, "id_items_text")).toBe(TYPED.items_text);
    expect(inputValue(html, "id_source_url")).toBe(TYPED.source_url);
    expect(inputValue(html, "id_delivery_date")).toBe(TYPED.delivery_date);
    expect(inputValue(html, "id_delivery_provider_id")).toBe(TYPED.delivery_provider_id);
    expect(inputValue(html, "id_actual_cost")).toBe(TYPED.actual_cost);
    // The three selects, which a `toContain` over the raw HTML cannot see:
    // their submitted value never appears as page text, so a re-render that
    // reset every dropdown to blank would pass every assertion above.
    expect(selectedOption(html, "id_foodbank")).toBe(TYPED.foodbank);
    expect(selectedOption(html, "id_need")).toBe(TYPED.need);
    expect(selectedOption(html, "id_order_group")).toBe(TYPED.order_group);
    expect(selectedOption(html, "id_delivery_provider")).toBe(TYPED.delivery_provider);
    // Values preserved somewhere the admin cannot press Save from would be
    // preserved nowhere.
    expect(html).toContain('name="csrf_token"');
    expect(html).toContain(">Submit</button>");
  });

  // KILLS THE MUTANT: `delivery_hour: deliveryHourRaw === "" ? null :
  // Number(deliveryHourRaw)` -> `delivery_hour: null`. The test above cannot
  // make this assertion, because the rejection it uses IS a bad hour (23),
  // which has no option to be selected either way -- so the one field whose
  // re-render nothing checked was the one the tests kept breaking on purpose.
  // A valid hour lost on an unrelated rejection sends the form back with
  // "---------" chosen; press Save again without noticing and the next error
  // is "Delivery hour is required.", or worse the admin re-picks and gets it
  // wrong. order_form.njk:129-134's blank option is what makes it silent.
  it("keeps the chosen delivery hour when something else is rejected", async () => {
    const { html } = await post("/admin/order/new/", { ...TYPED, actual_cost: "43.25" });

    expect(errorBanner(html)).toBe("Delivered cost must be a whole number of pence.");
    expect(selectedOption(html, "id_delivery_hour")).toBe(TYPED.delivery_hour);
  });

  // KILLS THE MUTANT: render the rejected form with `csrf_token: ""`.
  //
  // Every other test here asks whether the admin's VALUES came back. This one
  // asks the question those cannot: can the form that came back actually be
  // SUBMITTED? A recovery page whose hidden csrf_token is empty (an unset
  // CSRF_SECRET, a pageContext that stopped issuing one, a template that
  // stopped rendering it) 403s on the next press and loses the paste for the
  // second time -- issue #12's outcome reached by a different road, and one
  // that a `toContain('name="csrf_token"')` check passes straight through.
  //
  // So the loop is closed end to end: reject a save, take the token the page
  // itself offers, fix the field, submit again with that token, and require
  // the order to actually land in SQLite.
  it("hands back a form that can really be resubmitted, token and all", async () => {
    const { html } = await post("/admin/order/new/", { ...TYPED, items_text: "" });

    const recovered = html.match(/name="csrf_token" value="([^"]*)"/)?.[1];
    expect(recovered).toBeTruthy();

    const { res } = await post("/admin/order/new/", TYPED, { csrfToken: recovered });

    expect(res.status).toBe(302);
    expect(onlyOrder().items_text).toBe(TYPED.items_text);
  });

  // The port's own header comment notes that Django selects its save branch on
  // `if request.POST:` -- the truthiness of a QueryDict -- so a genuinely
  // empty body re-renders instead of validating, while Hono routes the methods
  // explicitly and always validates. No browser can actually send that body
  // from this form (the CSRF field alone makes Django's QueryDict truthy), but
  // curl can, and the port must answer it the way it answers any other
  // incomplete submission: the form back, one banner, nothing written.
  it("validates a POST carrying nothing but its CSRF token", async () => {
    const { res, html } = await post("/admin/order/new/", {});

    expect(res.status).toBe(200);
    expect(errorBanner(html)).toBe("Items text is required.");
    expect(orders()).toHaveLength(0);
    expect(geminiFetch).not.toHaveBeenCalled();
  });

  // The rejected value itself has to come back too, not be blanked "helpfully"
  // -- the admin needs to see WHAT they typed in order to correct it.
  it("gives back the offending value, not an empty box", async () => {
    const { html } = await post("/admin/order/new/", { ...TYPED, actual_cost: "43.25" });

    expect(inputValue(html, "id_actual_cost")).toBe("43.25");
  });

  // A rejected EDIT must re-render the EDIT form -- still knowing which order
  // it is editing, and with the order's own title -- not a create form that
  // happens to be full of the right values.
  it("re-renders the edit form, still titled after the order", async () => {
    seedOrder({ id: 55, order_id: "gf-salisbury-tesco-2026-02-10" });

    const { res, html } = await post("/admin/order/gf-salisbury-tesco-2026-02-10/edit/", { ...TYPED, items_text: "" });

    expect(res.status).toBe(200);
    expect(html).toContain("<h2>Edit gf-salisbury-tesco-2026-02-10</h2>");
    expect(errorBanner(html)).toBe("Items text is required.");
    expect(onlyOrder().items_text).toBe("1 x Seeded Item");
  });

  // A rejected save must not lose the need selection either -- the need list
  // is filtered to the submitted food bank, and the append guard has to run on
  // the failure path as well as the success one. Here the submitted need
  // belongs to Aberdeen while the submitted food bank is Salisbury, so without
  // the append the option would be gone and the admin's next Save would NULL
  // it silently.
  it("keeps an out-of-window need selected on the re-rendered form", async () => {
    const { html } = await post("/admin/order/new/", { ...TYPED, need: String(NEED_ABERDEEN.id), delivery_hour: "23" });

    expect(optionValues(html, "id_need")).toContain(String(NEED_ABERDEEN.id));
    expect(selectedOption(html, "id_need")).toBe(String(NEED_ABERDEEN.id));
  });

  // SUSPECT, pinned as-is: handlePost calls renderForm with a null
  // preselectedFoodbankName, so a rejected save on /admin/order/new/
  // ?foodbank=salisbury loses the "New Order for Salisbury Food Bank" heading
  // and falls back to the bare "New Order". Django recomputes page_title from
  // the still-present query string on the POST too (views.py:479-485 runs
  // after the branch), so it keeps the food bank's name. Cosmetic, and the
  // food bank itself is still selected in the dropdown -- but it is a real
  // divergence from the view this was ported from.
  it("drops the food bank from the heading when a preselected create is rejected", async () => {
    const { html } = await post("/admin/order/new/?foodbank=salisbury", { ...TYPED, items_text: "" });

    expect(html).toContain("<h2>New Order</h2>");
    expect(html).not.toContain("New Order for Salisbury Food Bank");
    // The selection itself does survive, which is why this is cosmetic.
    expect(selectedOption(html, "id_foodbank")).toBe(String(SALISBURY.id));
  });

  // Ordering between checks. Validation must not report "Unknown food bank."
  // for a submission whose delivery date is nonsense -- the cheap format
  // checks come first, exactly as Django's field-level clean runs before the
  // ModelChoiceField queryset lookups it depends on.
  it("reports the field-level failure before the foreign key lookups", async () => {
    const { html } = await post("/admin/order/new/", { ...TYPED, items_text: "", foodbank: "9999" });

    expect(errorBanner(html)).toBe("Items text is required.");
  });

  // ...and the existence checks come before the uniqueness check, so a
  // submission that is both a duplicate and points at a missing need reports
  // the missing need.
  it("reports an unknown need before the duplicate-order check", async () => {
    seedOrder({ id: 55, order_id: "gf-salisbury-sainsburys-2026-03-04", delivery_date: "2026-03-04", delivery_provider: "Sainsbury's" });

    const { html } = await post("/admin/order/new/", { ...TYPED, need: "9999" });

    expect(errorBanner(html)).toBe("Unknown need.");
    expect(html).not.toContain("already exists");
  });

  // The other direction: the checks must not refuse saves the model would have
  // accepted. Every optional field empty at once is the shape of a
  // just-arrived order the admin has not costed yet.
  it("accepts a submission with every optional field empty", async () => {
    const { res } = await post("/admin/order/new/", {
      foodbank: "",
      items_text: "1 x Beans",
      need: "",
      order_group: "",
      source_url: "",
      delivery_date: "2026-03-04",
      delivery_hour: "6",
      delivery_provider: "",
      delivery_provider_id: "",
      actual_cost: "",
    });

    expect(res.status).toBe(302);
    const row = onlyOrder();
    expect(row.source_url).toBeNull();
    expect(row.delivery_provider).toBeNull();
    expect(row.delivery_provider_id).toBeNull();
    expect(row.actual_cost).toBeNull();
    expect(row.delivery_hour).toBe(6);
  });

  // SUSPECT, pinned as-is, and the one rejection in this handler that does
  // NOT preserve anything. Both 404s are decided at the TOP of adminOrderForm,
  // before the method branch -- so a POST with a stale or mistyped ?foodbank=
  // slug, or to an order that was renamed by someone else's save in another
  // tab (which orders.py:105-107 does on every save of an assigned order),
  // gets a bare 404 page and the whole submission is gone. That is the #12
  // loss with a different status code on it: no form, no banner, no
  // items_text. Django reaches DoesNotExist -> 500 at the same point for the
  // slug case and get_object_or_404 for the other, so the port is no worse --
  // but it is worth knowing this is the one path where a rejected save
  // discards the admin's typing.
  it("404s a POST carrying an unknown ?foodbank slug, discarding the submission", async () => {
    const { res, html } = await post("/admin/order/new/?foodbank=no-such-food-bank", TYPED);

    expect(res.status).toBe(404);
    expect(html).not.toContain(TYPED.items_text);
    expect(orders()).toHaveLength(0);
    expect(geminiFetch).not.toHaveBeenCalled();
  });

  // The same guard on the edit path, and the ORDER it runs in: the row lookup
  // precedes verifyCsrf, so an unknown order_id is a 404 whether or not the
  // request carried a token. Pinned because the two ways of getting a 404 here
  // must both leave the database alone, and because a future reshuffle that
  // moved the CSRF check first would change these status codes.
  it("404s a POST to an order_id nothing holds, token or no token", async () => {
    expect((await post("/admin/order/gf-nothing-here-2026-01-01/edit/", TYPED)).res.status).toBe(404);
    expect((await post("/admin/order/gf-nothing-here-2026-01-01/edit/", TYPED, { csrfToken: null })).res.status).toBe(404);

    expect(orders()).toHaveLength(0);
    expect(adminJobs()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CSRF and authentication
// ---------------------------------------------------------------------------

// lib/csrf.ts's verifyCsrf has five ways to say no, and every one of them has
// to stop the write. The status alone is not the assertion that matters: a
// handler that 403s AFTER writing the row would pass a status check and still
// have let a cross-site POST create an order.
describe("adminOrderForm POST -- CSRF", () => {
  it("refuses a POST with no csrf_token field", async () => {
    const { res, html } = await post("/admin/order/new/", TYPED, { csrfToken: null });

    expect(res.status).toBe(403);
    expect(html).toBe("Forbidden");
    expect(orders()).toHaveLength(0);
    expect(geminiFetch).not.toHaveBeenCalled();
  });

  it("refuses a POST whose token does not match the cookie", async () => {
    const { res } = await post("/admin/order/new/", TYPED, { csrfToken: "c".repeat(64) });

    expect(res.status).toBe(403);
    expect(orders()).toHaveLength(0);
  });

  it("refuses a POST with no __Host-csrf cookie", async () => {
    const { res } = await post("/admin/order/new/", TYPED, { cookie: null });

    expect(res.status).toBe(403);
    expect(orders()).toHaveLength(0);
  });

  // The signature is what makes this a SIGNED double-submit: a cookie tossed
  // from a sibling subdomain carries a raw token the attacker also puts in the
  // form field, and only the HMAC tells the two apart.
  it("refuses a cookie whose signature does not verify", async () => {
    const { res } = await post("/admin/order/new/", TYPED, { cookie: `__Host-csrf=${CSRF_RAW}.${"0".repeat(64)}` });

    expect(res.status).toBe(403);
    expect(orders()).toHaveLength(0);
  });

  it("refuses a cross-origin POST even with a valid token pair", async () => {
    const { res } = await post("/admin/order/new/", TYPED, { origin: "https://evil.invalid" });

    expect(res.status).toBe(403);
    expect(orders()).toHaveLength(0);
  });

  it("refuses a cross-site POST on Sec-Fetch-Site alone", async () => {
    const { res } = await post("/admin/order/new/", TYPED, { secFetchSite: "cross-site" });

    expect(res.status).toBe(403);
    expect(orders()).toHaveLength(0);
  });

  // The edit path must be guarded too -- it is the one that can overwrite an
  // existing order rather than only add one.
  it("refuses an unsigned edit and leaves the stored order untouched", async () => {
    seedOrder({ id: 55, order_id: "gf-salisbury-tesco-2026-02-10" });
    const before = onlyOrder();

    const { res } = await post("/admin/order/gf-salisbury-tesco-2026-02-10/edit/", TYPED, { csrfToken: null });

    expect(res.status).toBe(403);
    expect(onlyOrder()).toEqual(before);
  });

  // lib/csrf.ts fails CLOSED on an unset secret, rather than letting a
  // missing binding be silently indistinguishable from a working one.
  it("refuses every POST when CSRF_SECRET is unset", async () => {
    const app = buildApp();
    const bindings = { ...env(), CSRF_SECRET: undefined } as unknown as AppEnv["Bindings"];
    const signature = await hmacSha256Hex(CSRF_SECRET, CSRF_RAW);
    const res = await app.fetch(
      new Request(`${ORIGIN}/admin/order/new/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `__Host-csrf=${CSRF_RAW}.${signature}`,
          Origin: ORIGIN,
          "Sec-Fetch-Site": "same-origin",
        },
        body: new URLSearchParams({ ...TYPED, csrf_token: CSRF_RAW }).toString(),
      }),
      bindings,
      execCtx,
    );

    expect(res.status).toBe(403);
    expect(orders()).toHaveLength(0);
  });
});

// The gate is routes/admin/index.ts:83's `adminApp.use("*", requireAdminAuth)`,
// not anything inside this handler -- so the real middleware is mounted here
// rather than trusted. givefood/middleware.py's LoginRequiredAccess is what it
// ports.
describe("adminOrderForm -- authentication", () => {
  function unauthenticatedApp(): Hono<AppEnv> {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("requestStartTime", performance.now());
      await next();
    });
    app.use("*", requireAdminAuth);
    app.get("/admin/order/new/", adminOrderForm);
    app.post("/admin/order/new/", adminOrderForm);
    app.post("/admin/order/:orderId/edit/", adminOrderForm);
    return app;
  }

  it("bounces an unauthenticated GET to the sign-in flow", async () => {
    const res = await unauthenticatedApp().fetch(new Request(`${ORIGIN}/admin/order/new/`), env(), execCtx);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Forder%2Fnew%2F");
  });

  // The assertion that matters: a valid CSRF pair is not a substitute for a
  // session, and the request must not reach the handler at all.
  it("bounces an unauthenticated POST without writing anything", async () => {
    seedOrder({ id: 55, order_id: "gf-salisbury-tesco-2026-02-10" });
    const before = onlyOrder();
    const signature = await hmacSha256Hex(CSRF_SECRET, CSRF_RAW);

    const res = await unauthenticatedApp().fetch(
      new Request(`${ORIGIN}/admin/order/gf-salisbury-tesco-2026-02-10/edit/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `__Host-csrf=${CSRF_RAW}.${signature}`,
          Origin: ORIGIN,
          "Sec-Fetch-Site": "same-origin",
        },
        body: new URLSearchParams({ ...TYPED, csrf_token: CSRF_RAW }).toString(),
      }),
      env(),
      execCtx,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Forder%2Fgf-salisbury-tesco-2026-02-10%2Fedit%2F");
    expect(onlyOrder()).toEqual(before);
    expect(adminJobs()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// When the parse fails
// ---------------------------------------------------------------------------

describe("adminOrderForm POST -- when the parse fails", () => {
  // The parse records its failure on the admin_job row and does not throw, so
  // the save still redirects to the order it DID write, and the banner there
  // carries the reason. A 500 here would invite a second press of Save, which
  // on an UNASSIGNED order creates a duplicate (orders.py:54-56's
  // unique_together cannot fire with a null food bank).
  it("still redirects to the saved order, with the error on the job", async () => {
    // Every attempt, not Once: geminiJsonCall retries a failed call.
    geminiFetch.mockImplementation(async () => new Response('{"error":{"message":"model not found"}}', { status: 404 }));

    const { res } = await post("/admin/order/new/", TYPED);

    expect(res.status).toBe(302);
    const job = db.prepare("SELECT id, status, error FROM admin_job").get() as { id: string; status: string; error: string };
    expect(res.headers.get("Location")).toBe(`/admin/order/${TYPED_ORDER_ID}/?job=${job.id}`);
    expect(job.status).toBe("failed");
    expect(job.error).toContain("model not found");
    expect(onlyOrder().items_text).toBe(TYPED.items_text);
    expect(orderLines()).toHaveLength(0);
    expect(foodbankRow(SALISBURY.id).last_order).toBe("2026-03-04");
  });

  // Delete-then-insert happens only once the model has answered, so a failed
  // re-parse leaves the previous lines rather than an empty order.
  it("keeps an edited order's previous lines when the re-parse fails", async () => {
    seedOrder({ id: 55, order_id: "gf-salisbury-tesco-2026-02-10" });
    db.prepare("INSERT INTO orderline (order_id, name, quantity, item_cost, line_cost, weight, calories, category, group_name, delivery_date) VALUES (55, 'Old Line', 1, 10, 10, 100, 0, '', '', '2026-02-10')").run();
    geminiFetch.mockImplementation(async () => new Response("bad request", { status: 400 }));

    await post("/admin/order/gf-salisbury-tesco-2026-02-10/edit/", { ...TYPED, delivery_provider: "Tesco", delivery_date: "2026-02-10" });

    expect(orderLines().map((line) => line.name)).toEqual(["Old Line"]);
    expect(adminJobs()[0]!.status).toBe("failed");
  });
});
