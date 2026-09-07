import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../types";
import { hmacSha256Hex } from "../../lib/hmac";
import { requireAdminAuth } from "../../middleware/adminAuth";
import { serverTiming } from "../../middleware/serverTiming";

// The order detail page (gfadmin/views.py:445-452 order()), driven end to end:
// the real route at the path routes/admin/index.ts:181 registers, the real
// requireAdminAuth, the real issueCsrfToken, the real getOrderDetail /
// getOrderLines / getAdminJob, all against an in-memory SQLite carrying the
// migrations' own `orders`, `orderline`, `ordergroup`, `foodbankchange` and
// `admin_job` definitions.
//
// THIS PAGE WRITES NOTHING, so the failure class it can ship is not github
// #34's ("the redirect said it saved") but #12's quieter cousin: IT RENDERS A
// FULL, PLAUSIBLE PAGE OF THE WRONG NUMBERS AND NOBODY SEES AN ERROR. Every
// one of the four joins, the line query and the six derived values below can
// go wrong without throwing:
//
//   * getOrderLines is keyed on `order.id`, the INTEGER row id, while the URL
//     and every other admin link carry `order.order_id`, the TEXT public id.
//     Handing the wrong one down returns zero rows -- a page reading "None"
//     under Items, next to a "Lines: 14" the same query never touched. So the
//     lines here are seeded on TWO orders and the decoy's must be absent.
//   * a dropped `WHERE`/join predicate shows another food bank's name against
//     this order's delivery. So every join is seeded with a row that must be
//     EXCLUDED -- a filter that does nothing passes any test that only seeds
//     matching rows.
//   * the money and weight are unit conversions (grams->kg, pence->pounds).
//     An off-by-1000 renders as a believable number, not as a crash.
//
// WHAT IS FAKED, AND WHY ONLY THIS. `render` is stubbed because the templates
// are precompiled into packages/templates/src/generated/, a gitignored build
// artefact -- importing the real one makes this suite fail on a fresh checkout
// for reasons that have nothing to do with orders. Asserting on the CONTEXT
// handed to the template is also the more direct claim: "the page offers a
// Tesco order link" is a statement about `delivery_provider_url`, not about
// markup. `buildPageContext` comes through the same module and is stubbed with
// it; nothing here is about the footer's version string. Everything else --
// middleware, router, session, CSRF, SQL -- is the shipped code.
//
// MUTATION-TESTED (TESTING.md's convention), against copies aliased in from a
// scratchpad rather than an edit to any source file. The first pass covered
// order.ts alone -- twenty wrong implementations, the lines query keyed on the
// public id, the packaging factor dropped, the pence left undivided, the job
// lookup no longer skipped, the provider-reference guard removed, the nav
// section changed, the lines reversed, the Tesco path shortened -- and one
// survivor (the order of the two weight operations) is why the 1,250 g test
// below exists. getOrderLines' `, id` tiebreak is NOT killed by anything here
// and its comment says so rather than claiming otherwise.
//
// A SECOND, ADVERSARIAL PASS then extended the alias set past the handler, to
// packages/db's orderAdmin.ts and adminJobs.ts, middleware/adminAuth.ts,
// lib/csrf.ts, pageContext.ts and routes/admin/index.ts's own registration
// table -- 80 mutants in all, because a page whose whole job is reading is
// only as tested as the queries behind it. Four survived, every one of them a
// "the test only seeded rows that match" hole, and each is now closed by a
// test that names it:
//
//   * the need join rewritten from `n.id = o.need_id` to
//     `n.foodbank_id = o.foodbank_id` -- invisible while each food bank owned
//     exactly one need;
//   * getAdminJob's `WHERE id = ?` deleted -- invisible while `admin_job` held
//     one row, which it never does in production;
//   * a `LIMIT 10` on the lines query (and its `lines.slice(0, 10)` twin in
//     the handler) -- invisible while no test seeded more than four lines;
//   * `SELECT DISTINCT` on the lines query -- invisible while no two lines
//     agreed on all four projected columns.
//
// The auth and CSRF mutants were all killed by the tests that were already
// here: opening the gate, reducing it to "a session cookie was sent", changing
// the redirect target, dropping the Set-Cookie on a freshly minted token and
// adopting an unverified cookie each fail at least one assertion below.
//
// The index.ts mutants -- a POST added to this path, the handler swapped, the
// /order/new/ literal moved after the id pattern, its POST dropped -- were not
// killed by anything, because every routing test here ran against the Hono app
// this FILE assembles. That is what the last describe block is for.

const mocks = vi.hoisted(() => ({
  render: vi.fn(async (_template: string, _context: Record<string, unknown>) => "<html>order</html>"),
}));

vi.mock("@givefood/templates", () => ({
  render: mocks.render,
  // adminPageContext spreads this in; the real one reads per-isolate runtime
  // identity that has nothing to do with this page.
  buildPageContext: (opts: { path: string }) => ({ canonical_path: opts.path }),
}));

const { adminOrderDetail } = await import("./order");

// `orders` and `orderline` are migrations/0005_orders_and_charity.sql:19-48
// VERBATIM, indexes included, because two claims below are claims about the
// schema rather than about the handler:
//
//   * `orders` HAS NO INDEX ON order_id, unique or otherwise -- the only three
//     indexes it carries are the ones copied here. getOrderDetail's
//     `WHERE o.order_id = ?` is therefore a full scan whose `.first()` picks
//     silently between duplicates; see the duplicate-order_id block at the end.
//   * `orderline.weight` is NULLABLE, which is what makes the ORDER BY's NULL
//     placement a real question rather than a hypothetical one.
//
// `ordergroup` is 0015_ordergroup.sql and `admin_job` is 0013_admin_jobs.sql,
// likewise verbatim. `foodbankchange` is 0001_core.sql:109-127's columns
// verbatim, but only the first of its five indexes: the other four exist for
// the needs list and the categoriser, and no plan for a single equality join
// on the primary key can reach them.
//
// `foodbank` is the ONE reduction: the real table is 78 columns and this page
// touches exactly two of them (`f.name`, `f.slug`, in getOrderDetail's SELECT
// list). A full copy would be scenery. If this page ever grows a third
// foodbank column the fixture has to grow with it, and the failure will read
// as "no such column: f.whatever" rather than as a silent blank.
const SCHEMA = `
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
CREATE INDEX order_foodbank_delivery_idx ON orders(foodbank_id, delivery_datetime DESC);
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
CREATE INDEX orderline_order_idx ON orderline(order_id);
CREATE INDEX orderline_delivery_date_idx ON orderline(delivery_date);
CREATE INDEX orderline_category_idx ON orderline(category) WHERE category IS NOT NULL;

CREATE TABLE ordergroup (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  public INTEGER NOT NULL DEFAULT 0,
  key TEXT,
  created TEXT NOT NULL,
  modified TEXT NOT NULL
);
CREATE UNIQUE INDEX ordergroup_slug_uniq ON ordergroup(slug);
CREATE INDEX order_ordergroup_idx ON orders(order_group_id) WHERE order_group_id IS NOT NULL;

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
CREATE UNIQUE INDEX need_need_id_uniq ON foodbankchange(need_id);

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
CREATE INDEX admin_job_created_idx ON admin_job(created DESC);

CREATE TABLE foodbank (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL, slug TEXT NOT NULL
);
CREATE UNIQUE INDEX foodbank_slug_uniq ON foodbank(slug);
`;

type Bindable = null | number | bigint | string | Uint8Array;

// Every statement the handler ran, split into the two questions worth asking
// of a read-only page: did anything WRITE (it must not -- this page carries
// two POST forms and a job banner, none of which may leave a mark just by
// being looked at), and was a query issued AT ALL (the `?job=` lookup is
// supposed to be skipped when there is no job id, and a skipped read is
// invisible in the rendered context because both paths end in null).
const writes: { sql: string; params: Bindable[] }[] = [];
const queries: string[] = [];

// The D1DatabaseSession surface packages/db uses, over node:sqlite -- the same
// shape as foodbankDetail.test.ts / donationPoint.test.ts /
// foodbankLocation.test.ts use. D1 is async and node:sqlite is synchronous;
// the SQL text, the parameter binding, the type affinity and the ORDER BY NULL
// placement are SQLite's in both.
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
    prepare: (sql: string) => {
      queries.push(sql);
      return statement(sql, []);
    },
    getBookmark: () => null,
  };
}

const ORIGIN = "https://www.givefood.org.uk";
const CSRF_SECRET = "test-csrf-secret-not-a-real-one";
const CSRF_RAW = "c".repeat(64);
const SESSION_ID = "test-session-id";

const SALISBURY = 1;
const AMESBURY = 2; // the decoy food bank: owns the decoy order, need and group

// The row id and the public id are DELIBERATELY DIFFERENT NUMBERS-ISH: the row
// id is 7 and the public id is the slug-shaped string orderForm.ts:317 mints.
// Every "which id was used" question below turns on their being distinguishable.
const ORDER_ROW = 7;
const ORDER_ID = "gf-salisbury-tesco-2026-08-10";
const DECOY_ROW = 8;
const DECOY_ORDER_ID = "gf-amesbury-sainsburys-2026-08-11";

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

// Values are deliberately distinctive per column -- "the page was given the
// order's calories" must not pass because two columns happen to hold the same
// number. weight 26430 g / cost 4218 p / calories 91234 are all different
// magnitudes for the same reason.
function seedOrder(id: number, orderId: string, overrides: Record<string, unknown> = {}): void {
  insert("orders", {
    id,
    order_id: orderId,
    items_text: "10 x Pasta\n4 x Tinned tomatoes",
    country: "England",
    created: "2026-08-01 09:15:00.000000",
    modified: "2026-08-02 10:20:00.000000",
    delivery_date: "2026-08-10",
    delivery_hour: 9,
    delivery_datetime: "2026-08-10 09:00:00.000000",
    weight: 26430,
    calories: 91234,
    cost: 4218,
    no_lines: 14,
    no_items: 57,
    foodbank_id: SALISBURY,
    ...overrides,
  });
}

function seedLine(id: number, orderRowId: number, name: string, overrides: Record<string, unknown> = {}): void {
  insert("orderline", {
    id,
    name,
    quantity: 2,
    item_cost: 120,
    line_cost: 240,
    weight: 500,
    calories: 1500,
    order_id: orderRowId,
    ...overrides,
  });
}

function seedNeed(id: number, needIdStr: string, overrides: Record<string, unknown> = {}): void {
  insert("foodbankchange", {
    id,
    need_id: needIdStr,
    foodbank_id: SALISBURY,
    change_text: "Pasta, Tinned tomatoes",
    published: 1,
    input_method: "scrape",
    uri: "https://salisbury.example.org/give-help/food/",
    created: "2026-07-30 08:00:00.000000",
    modified: "2026-07-30 08:00:00.000000",
    ...overrides,
  });
}

function seedGroup(id: number, name: string, slug: string): void {
  insert("ordergroup", {
    id,
    name,
    slug,
    public: 0,
    created: "2026-01-01 00:00:00.000000",
    modified: "2026-01-01 00:00:00.000000",
  });
}

function seedJob(id: string, overrides: Record<string, unknown> = {}): void {
  insert("admin_job", {
    id,
    kind: "order-lines", // orderForm.ts:375's own kind
    target: ORDER_ID,
    status: "queued",
    created: "2026-09-07 11:59:58.000000",
    ...overrides,
  });
}

function lastRender(): { template: string; context: Record<string, unknown> } {
  const call = mocks.render.mock.calls.at(-1);
  if (!call) throw new Error("the handler rendered nothing");
  return { template: call[0], context: call[1] };
}

function renderContext<T = Record<string, unknown>>(key: string): T {
  return lastRender().context[key] as T;
}

interface RenderedOrder extends Record<string, unknown> {
  id: number;
  order_id: string;
  need_id_short: string | null;
}

interface RenderedLine {
  name: string;
  quantity: number;
  weight: number | null;
  calories: number | null;
}

function renderedOrder(): RenderedOrder {
  return renderContext<RenderedOrder>("order");
}

function renderedLines(): RenderedLine[] {
  return renderContext<RenderedLine[]>("lines");
}

async function csrfCookie(raw: string = CSRF_RAW): Promise<string> {
  return `__Host-csrf=${raw}.${await hmacSha256Hex(CSRF_SECRET, raw)}`;
}

interface RequestOptions {
  cookies?: string[]; // replaces the default session + csrf pair entirely
  method?: "GET" | "POST";
}

// The default cookie jar carries a valid admin session AND a valid CSRF
// cookie, so a test that wants to prove a refusal has to take one away
// explicitly -- the opposite arrangement (opt in to auth) makes it far too
// easy to write a passing test against a handler that is not actually
// reachable.
async function request(path: string, opts: RequestOptions = {}): Promise<Response> {
  const cookies = opts.cookies ?? [`__Host-gfsession=${SESSION_ID}`, await csrfCookie()];
  return app.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: opts.method ?? "GET",
      headers: { Cookie: cookies.join("; "), Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
    }),
    env,
    execCtx,
  );
}

// Date only, so the awaits in these tests still resolve on a real event loop.
// Used by the notification timesince assertions, whose whole output is a
// function of "now".
const NOW_INSTANT = "2026-09-07T12:00:00.000Z";

function freezeClock(instant: string = NOW_INSTANT): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(instant));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.render.mockResolvedValue("<html>order</html>");
  writes.length = 0;
  queries.length = 0;

  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);

  insert("foodbank", { id: SALISBURY, name: "Salisbury", slug: "salisbury" });
  insert("foodbank", { id: AMESBURY, name: "Amesbury", slug: "amesbury" });

  seedOrder(ORDER_ROW, ORDER_ID);
  // THE DECOY, and it exists in every test in this file rather than only in
  // the ones that name it. It is a complete second order -- other food bank,
  // other need, other group, own order lines -- so that a dropped predicate
  // anywhere in getOrderDetail's four-table join or getOrderLines' single
  // `WHERE` surfaces as Amesbury's data on Salisbury's page.
  seedOrder(DECOY_ROW, DECOY_ORDER_ID, {
    foodbank_id: AMESBURY,
    weight: 999_999,
    calories: 999_999,
    cost: 999_999,
    no_items: 999,
    no_lines: 999,
    delivery_provider: "Sainsbury's",
    delivery_provider_id: "DECOY-PROVIDER-ID",
    source_url: "https://amesbury.example.org/decoy/",
  });
  seedLine(900, DECOY_ROW, "DECOY LINE", { weight: 999_999, calories: 999_999 });

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

  // The production registration, verbatim from routes/admin/index.ts:181,
  // behind the same auth middleware adminApp applies -- so "an unauthenticated
  // request never reaches the handler" and "a POST to this URL is not routed"
  // are claims about the real wiring, not about this file's.
  app = new Hono<AppEnv>();
  app.use("*", serverTiming);
  app.use("/admin/*", requireAdminAuth);
  app.get("/admin/order/:orderId/", adminOrderDetail);
  // Labelled rather than left to surface as an unhandled rejection, so a
  // regression reads as "expected 200, got 500: no such column" instead of a
  // vitest crash.
  app.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe("adminOrderDetail -- the page itself", () => {
  it("renders the order template for an order that exists", async () => {
    const res = await request(`/admin/order/${ORDER_ID}/`);

    expect(res.status).toBe(200);
    expect(lastRender().template).toBe("admin/order.njk");
    // adminPageContext's `section`, which drives admin/page.njk's nav
    // highlight. gfadmin/views.py:445-452 has no equivalent -- the port's nav
    // is data-driven where Django's was per-template markup.
    expect(lastRender().context.section).toBe("orders");
  });

  it("404s an order id nothing holds, and renders nothing", async () => {
    const res = await request("/admin/order/gf-nowhere-tesco-1999-01-01/");

    expect(res.status).toBe(404);
    expect(mocks.render).not.toHaveBeenCalled();
  });

  // THE LOOKUP KEY, pinned in both directions. Django's
  // get_object_or_404(Order, order_id = id) matches the TEXT public id, and
  // every link into this page (orderForm's redirect, the orders list, the food
  // bank tab) carries that id. A handler that matched `o.id` instead would
  // 404 every real link while quietly serving /admin/order/7/ -- a URL nothing
  // generates, so the mistake would look like "the order was deleted".
  it("matches the public order_id, never the integer row id", async () => {
    expect((await request(`/admin/order/${ORDER_ROW}/`)).status).toBe(404);
    expect(mocks.render).not.toHaveBeenCalled();

    const res = await request(`/admin/order/${ORDER_ID}/`);
    expect(res.status).toBe(200);
    expect(renderedOrder().id).toBe(ORDER_ROW);
    expect(renderedOrder().order_id).toBe(ORDER_ID);
  });

  // Exact equality, not a prefix match. Worth a test of its own because
  // orderForm.ts:317 mints ids by concatenation
  // (`gf-<slug>-<provider>-<date>`), so a `LIKE ? || '%'` would make the
  // shorter id of any pair shadow the longer -- silently serving August's
  // order under a URL meant for a different one.
  it("does not match on a prefix of the order id", async () => {
    const res = await request("/admin/order/gf-salisbury-tesco/");

    expect(res.status).toBe(404);
  });

  // getOrderDetail's SELECT list is the page's whole vocabulary: admin/order.njk
  // reads twenty-odd names off this object. A projection narrowed to "the
  // columns the page seemed to need" would blank whichever ones it missed,
  // silently, on every order -- and the decoy order seeded in beforeEach()
  // holds a 999,999 in each numeric column, so a join or filter that leaked
  // would show up here rather than as a plausible total.
  it("hands the template the joined row, column for column", async () => {
    await request(`/admin/order/${ORDER_ID}/`);

    expect(renderedOrder()).toMatchObject({
      id: ORDER_ROW,
      order_id: ORDER_ID,
      foodbank_id: SALISBURY,
      foodbank_name: "Salisbury",
      foodbank_slug: "salisbury",
      delivery_date: "2026-08-10",
      delivery_hour: 9,
      no_items: 57,
      no_lines: 14,
      weight: 26430,
      calories: 91234,
      cost: 4218,
      created: "2026-08-01 09:15:00.000000",
      modified: "2026-08-02 10:20:00.000000",
    });
  });

  // The three CONDITIONAL rows of the detail list -- Source URL
  // (admin/order.njk:59-62), Delivery (63-66) and Del. Prov. ID (67-70). Each
  // is gated on its own column, so a projection that quietly dropped one would
  // not throw and would not blank a visible field: the row would simply stop
  // appearing, on every order, and the only person who would ever notice is
  // whoever went looking for the supermarket receipt behind a delivery that
  // never turned up. They are asserted apart from the block above because the
  // main seed leaves all three NULL, which is the state in which a missing
  // column and a missing value look identical -- and the decoy order carries a
  // different value in each of the three, so a join leaking sideways surfaces
  // as Amesbury's receipt under Salisbury's heading rather than as a blank.
  it("carries the conditional receipt columns, and not the decoy's", async () => {
    db.prepare("UPDATE orders SET source_url = ?, delivery_provider = ?, delivery_provider_id = ? WHERE id = ?").run(
      "https://salisbury.example.org/orders/573384906/",
      "Tesco",
      "573384906",
      ORDER_ROW,
    );

    await request(`/admin/order/${ORDER_ID}/`);

    expect(renderedOrder()).toMatchObject({
      source_url: "https://salisbury.example.org/orders/573384906/",
      delivery_provider: "Tesco",
      delivery_provider_id: "573384906",
    });
  });

  // The page's two POST forms -- Send Notification (admin/order.njk:103-107)
  // and the Danger Zone Delete (115-119) -- each embed `csrf_token` as a
  // hidden field, and lib/csrf.ts's verifyCsrf requires the field to equal the
  // signed cookie's raw token exactly. A page rendered without one gets a 403
  // on both buttons with nothing on screen explaining why, which is why this
  // is asserted on a page that has no form of its own.
  it("issues the CSRF token both of the page's forms submit", async () => {
    await request(`/admin/order/${ORDER_ID}/`);

    expect(lastRender().context.csrf_token).toBe(CSRF_RAW);
  });

  // A page load must never write. This page shows a job banner, a notification
  // state and a delete form; a stray UPDATE here would move `modified` every
  // time an admin merely looked at an order -- and `modified` is what the
  // orders list and the CSV export both print.
  it("writes nothing", async () => {
    const before = db.prepare("SELECT * FROM orders WHERE id = ?").get(ORDER_ROW);

    await request(`/admin/order/${ORDER_ID}/`);

    expect(writes).toEqual([]);
    expect(db.prepare("SELECT * FROM orders WHERE id = ?").get(ORDER_ROW)).toEqual(before);
  });

  // The gate on every /admin/* route. Asserted through the real middleware
  // rather than a stand-in: the claim is that an anonymous request never
  // reaches this handler, which is a claim about routes/admin/index.ts's
  // wiring. An order page leaks a food bank's contact history and its need
  // text, so "the query never ran" matters as much as the status code.
  it("never reaches the handler without an admin session", async () => {
    const res = await request(`/admin/order/${ORDER_ID}/`, { cookies: [await csrfCookie()] });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/auth/?next=%2Fadmin%2Forder%2F${encodeURIComponent(ORDER_ID)}%2F`);
    expect(mocks.render).not.toHaveBeenCalled();
    expect(queries).toEqual([]);
  });

  // THE HALF THAT ACTUALLY HAPPENS. Nobody arrives here with no cookie at all
  // -- they arrive with yesterday's. lib/adminAuth.ts:277 returns null for a
  // session id KV no longer holds (signed out from another tab, expired past
  // its TTL, evicted), and the middleware has to treat that exactly like the
  // anonymous case above. It is the more dangerous of the two to get wrong:
  // the cookie is present, so a gate that checked only for its existence would
  // hand a revoked session a page carrying a food bank's need text, its
  // contact history and a working Delete button.
  it("never reaches the handler when the session cookie names a session KV has lost", async () => {
    const res = await request(`/admin/order/${ORDER_ID}/`, {
      cookies: ["__Host-gfsession=signed-out-an-hour-ago", await csrfCookie()],
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/auth/?next=%2Fadmin%2Forder%2F${encodeURIComponent(ORDER_ID)}%2F`);
    expect(mocks.render).not.toHaveBeenCalled();
    expect(queries).toEqual([]);
  });

  // The forms have to keep working when the CSRF cookie is unusable, and they
  // only do because adminPageContext issues one unconditionally rather than
  // echoing whatever arrived. A cookie whose signature does not verify -- one
  // planted from a sibling subdomain, or simply left over from a CSRF_SECRET
  // rotation -- is refused adoption (lib/csrf.ts:91) and a fresh pair is
  // minted. Were the unverified value echoed into the page instead, Send
  // Notification and Delete would both 403 with nothing on screen explaining
  // it, and the only remedy an admin could find on their own would be clearing
  // cookies for the whole site.
  it("mints a fresh CSRF token, cookie and all, when the one sent does not verify", async () => {
    const res = await request(`/admin/order/${ORDER_ID}/`, {
      cookies: [`__Host-gfsession=${SESSION_ID}`, `__Host-csrf=${CSRF_RAW}.not-a-real-signature`],
    });

    expect(res.status).toBe(200);
    const issued = lastRender().context.csrf_token as string;
    expect(issued).not.toBe(CSRF_RAW);
    expect(issued).toMatch(/^[0-9a-f]{64}$/);
    // The pair verifyCsrf compares: the hidden field the page renders and the
    // raw half of the cookie the browser will send back with it. A mint that
    // set no cookie would leave the next POST with nothing to match against.
    expect(res.headers.get("set-cookie")).toContain(`__Host-csrf=${issued}.`);
  });

  // routes/admin/index.ts registers this path for GET alone; the edit form is
  // a separate route. Pinned because the handler itself never inspects the
  // method -- if this path were ever also registered for POST, the detail view
  // would answer a submitted form with a 200 detail page and the admin would
  // read that as a successful save.
  //
  // Asserted against the app this file builds, which is why the block below
  // exists as well: this half proves the handler does nothing useful with a
  // POST, and that half proves production never sends it one.
  it("is not routed for POST", async () => {
    const res = await request(`/admin/order/${ORDER_ID}/`, { method: "POST" });

    expect(res.status).toBe(404);
    expect(mocks.render).not.toHaveBeenCalled();
  });
});

// THE PRODUCTION REGISTRATION ITSELF, read off the real adminApp rather than
// re-stated. Everything above runs against a Hono app this file assembles from
// routes/admin/index.ts:181, which makes every routing claim in it a claim
// about the fixture: a POST added to the real path, or the handler swapped for
// another, would leave all of it green. Hono keeps its registration table on
// `.routes`, so the wiring can simply be looked at -- no import of the whole
// admin app's behaviour, just its shape.
describe("adminOrderDetail -- the registration in routes/admin/index.ts", () => {
  it("is registered for GET only, on this exact path, with this handler", async () => {
    const { adminApp } = await import("./index");
    const registered = adminApp.routes.filter((r) => r.path === "/order/:orderId/");

    expect(registered.map((r) => r.method)).toEqual(["GET"]);
    expect(registered[0]?.handler).toBe(adminOrderDetail);
  });

  // THE LITERAL-BEFORE-PARAMETER ORDER index.ts:177-179 has a comment about,
  // pinned so the comment cannot outlive the code. /order/new/ is the create
  // form and takes both methods; /order/:orderId/ would happily match "new" as
  // an order id and 404 the form out of existence, since no order is ever
  // saved under that public id. Registration order is what keeps them apart,
  // and it is invisible to any test that only ever fetches a real order id.
  it("registers the /order/new/ form, both methods, ahead of the id pattern", async () => {
    const { adminApp } = await import("./index");
    const paths = adminApp.routes.map((r) => `${r.method} ${r.path}`);

    expect(paths).toContain("GET /order/new/");
    expect(paths).toContain("POST /order/new/");
    expect(paths.indexOf("GET /order/new/")).toBeLessThan(paths.indexOf("GET /order/:orderId/"));
  });
});

describe("adminOrderDetail -- the three LEFT JOINs", () => {
  // admin/order.njk:34's "Unassigned". Django reaches this through
  // `{% if order.foodbank %}` on a nullable FK; the port through a LEFT JOIN
  // that yields nulls. An INNER JOIN would have 404'd the page instead --
  // orders genuinely exist with no food bank (orderForm.ts:361 mints
  // `gf-unassigned-<id>-...` ids for exactly that case), so the difference is
  // between "Unassigned" and "this order does not exist".
  it("keeps an unassigned order visible, with null food bank fields", async () => {
    db.prepare("UPDATE orders SET foodbank_id = NULL WHERE id = ?").run(ORDER_ROW);

    const res = await request(`/admin/order/${ORDER_ID}/`);

    expect(res.status).toBe(200);
    expect(renderedOrder().foodbank_id).toBeNull();
    expect(renderedOrder().foodbank_name).toBeNull();
    expect(renderedOrder().foodbank_slug).toBeNull();
  });

  // The need panel (admin/order.njk:77-90) and its four columns, with the
  // decoy need attached to the decoy order. `n.need_id AS need_id_str` is the
  // alias that keeps the TEXT uuid distinct from `o.need_id`, the INTEGER FK;
  // the two names differ by three characters and the href in the template uses
  // one while the FK guard uses the other.
  it("joins the need the order was placed against", async () => {
    seedNeed(10, "ab12cd3456789012345678901234ef00", { change_text: "Pasta, Rice, Nappies" });
    seedNeed(11, "ffffffffffffffffffffffffffffffff", { change_text: "DECOY NEED", foodbank_id: AMESBURY });
    db.prepare("UPDATE orders SET need_id = 10 WHERE id = ?").run(ORDER_ROW);
    db.prepare("UPDATE orders SET need_id = 11 WHERE id = ?").run(DECOY_ROW);

    await request(`/admin/order/${ORDER_ID}/`);

    expect(renderedOrder()).toMatchObject({
      need_id: 10,
      need_id_str: "ab12cd3456789012345678901234ef00",
      need_change_text: "Pasta, Rice, Nappies",
      need_created: "2026-07-30 08:00:00.000000",
      need_uri: "https://salisbury.example.org/give-help/food/",
    });
  });

  it("leaves the need fields null on an order that came from no need", async () => {
    await request(`/admin/order/${ORDER_ID}/`);

    expect(renderedOrder()).toMatchObject({
      need_id: null,
      need_id_str: null,
      need_change_text: null,
      need_created: null,
      need_uri: null,
    });
  });

  // MUTANT SURVIVOR, now closed: `LEFT JOIN foodbankchange n ON n.foodbank_id
  // = o.foodbank_id`. Every need test above attached exactly ONE need to
  // Salisbury and the decoy need to Amesbury, so joining on the shared food
  // bank instead of on the foreign key produced identical output and the
  // whole join predicate could be rewritten without a single failure. That is
  // the "a filter that does nothing passes any test that only seeds matching
  // rows" hole, one table over.
  //
  // This is the deterministic half of the kill: the order's `need_id` is
  // NULL, so the correct join yields nulls no matter what else the food bank
  // owns, while the food-bank join finds Salisbury's other need and hangs it
  // off an order that was placed by hand. It is not a hypothetical -- most
  // orders in the table have a null `need_id` (orderForm.ts leaves it unset
  // unless the admin arrived from a need), while every food bank of any age
  // has dozens of foodbankchange rows. The visible damage would be a Need
  // panel, on nearly every order, quoting a shopping list nobody ordered
  // against.
  it("does not borrow one of the food bank's other needs when the order came from none", async () => {
    seedNeed(10, "ab12cd3456789012345678901234ef00", { change_text: "AN UNRELATED SALISBURY NEED" });
    // orders.need_id is deliberately left NULL: this order was typed in by hand.

    await request(`/admin/order/${ORDER_ID}/`);

    expect(renderedOrder().need_id).toBeNull();
    expect(renderedOrder().need_id_str).toBeNull();
    expect(renderedOrder().need_change_text).toBeNull();
    expect(renderedOrder().need_created).toBeNull();
    expect(renderedOrder().need_uri).toBeNull();
  });

  // The positive half of the same kill, and the one that reads like the real
  // situation: a food bank publishes a new need every fortnight, so by the
  // time an order is placed there are several rows sharing its foodbank_id
  // and only one of them is the one the shopping list came from. Both needs
  // here belong to Salisbury, so the food-bank join has two candidates and
  // `.first()` takes whichever the scan reaches first -- the superseded one,
  // as it happens, which is precisely the wrong answer that renders perfectly.
  it("joins the need by its foreign key, not by the food bank the two happen to share", async () => {
    seedNeed(10, "1111111111111111111111111111aaaa", {
      change_text: "SUPERSEDED -- last month's list",
      created: "2026-06-01 08:00:00.000000",
      uri: "https://salisbury.example.org/old/",
    });
    seedNeed(11, "2222222222222222222222222222bbbb", { change_text: "Pasta, Rice, Nappies" });
    db.prepare("UPDATE orders SET need_id = 11 WHERE id = ?").run(ORDER_ROW);

    await request(`/admin/order/${ORDER_ID}/`);

    expect(renderedOrder()).toMatchObject({
      need_id: 11,
      need_id_str: "2222222222222222222222222222bbbb",
      need_change_text: "Pasta, Rice, Nappies",
      need_created: "2026-07-30 08:00:00.000000",
      need_uri: "https://salisbury.example.org/give-help/food/",
    });
  });

  // The order group row (admin/order.njk:55-58), whose link text is
  // OrderGroup.__str__ = name and whose href is the slug. Two groups exist so
  // that a join on the wrong column shows the wrong group's name -- which is
  // exactly the kind of wrong that renders perfectly.
  it("joins the order group, name and slug", async () => {
    seedGroup(3, "Salisbury Christmas 2026", "salisbury-christmas-2026");
    seedGroup(4, "DECOY GROUP", "decoy-group");
    db.prepare("UPDATE orders SET order_group_id = 3 WHERE id = ?").run(ORDER_ROW);
    db.prepare("UPDATE orders SET order_group_id = 4 WHERE id = ?").run(DECOY_ROW);

    await request(`/admin/order/${ORDER_ID}/`);

    expect(renderedOrder().order_group_name).toBe("Salisbury Christmas 2026");
    expect(renderedOrder().order_group_slug).toBe("salisbury-christmas-2026");
  });

  it("leaves the order group fields null on an ungrouped order", async () => {
    await request(`/admin/order/${ORDER_ID}/`);

    expect(renderedOrder().order_group_name).toBeNull();
    expect(renderedOrder().order_group_slug).toBeNull();
  });

  // SUSPECT, pinned rather than fixed -- and a place where the port is the
  // gentler of the two. `orders.need_id` has no foreign key (PLAN.md §4.5:
  // this schema has none anywhere), so a deleted need leaves the id behind.
  // Django's `{% if order.need %}` would evaluate the descriptor and raise
  // FoodbankChange.DoesNotExist -> a 500 on the whole page. Here the LEFT JOIN
  // yields nulls, `need_id` stays truthy, and admin/order.njk:80 renders an
  // empty <a> pointing at /admin/need// -- a broken link where Django gave an
  // error page. Neither is right; the port at least still shows the order.
  it("renders an order whose need row has been deleted, with an empty need link", async () => {
    seedNeed(10, "ab12cd3456789012345678901234ef00");
    db.prepare("UPDATE orders SET need_id = 10 WHERE id = ?").run(ORDER_ROW);
    db.prepare("DELETE FROM foodbankchange WHERE id = 10").run();

    const res = await request(`/admin/order/${ORDER_ID}/`);

    expect(res.status).toBe(200);
    expect(renderedOrder().need_id).toBe(10); // the template's `{% if %}` still fires
    expect(renderedOrder().need_id_str).toBeNull(); // ...but the href has nothing to point at
    expect(renderedOrder().need_id_short).toBeNull();
  });
});

describe("adminOrderDetail -- the order lines table", () => {
  // THE ID CONFUSION THIS PAGE IS MOST EXPOSED TO. getOrderLines takes
  // `order.id` -- the INTEGER row id -- because `orderline.order_id` is the FK
  // to `orders.id`, NOT a copy of `orders.order_id`. The two fields share a
  // name and hold different things. Pass the public string down instead and
  // SQLite compares a TEXT value against an INTEGER column: no error, no
  // match, an empty table under a heading that still reads "Lines: 14".
  it("lists the lines of THIS order, keyed on the row id and not the public id", async () => {
    seedLine(1, ORDER_ROW, "Pasta");
    seedLine(2, ORDER_ROW, "Tinned tomatoes");

    await request(`/admin/order/${ORDER_ID}/`);

    expect(renderedLines().map((l) => l.name)).toEqual(["Pasta", "Tinned tomatoes"]);
    // The decoy's line is seeded on every run of this file; its absence is the
    // proof that `WHERE order_id = ?` is doing something.
    expect(renderedLines().map((l) => l.name)).not.toContain("DECOY LINE");
  });

  // Order.lines() is `.order_by("-weight")` (givefood/models/orders.py:227-228)
  // -- heaviest first, so the admin reads the bulk items at the top. Dropping
  // the ORDER BY altogether is what this kills: the scan then comes back in
  // rowid order (Heavy, Light, Middle A, Middle B), which is a plausible-
  // looking table with the 100g item sitting second.
  //
  // WHAT IT DOES NOT PROVE, said out loud because the assertion looks as
  // though it does. getOrderLines' trailing `, id` -- the port's addition,
  // which Django has no equivalent of -- is NOT observable here: `orderline`
  // is a rowid table, so the scan arrives in id order already and SQLite's
  // sorter is stable, and `ORDER BY weight DESC` alone returns this exact
  // sequence. Run, not reasoned about. The tiebreak still earns its place
  // against a future plan that scans in some other order (a covering index,
  // another engine), but no test written against SQLite can distinguish it,
  // and one claiming to would be decoration.
  it("sorts heaviest first, equal weights in row-id order", async () => {
    seedLine(3, ORDER_ROW, "Light", { weight: 100 });
    seedLine(1, ORDER_ROW, "Heavy", { weight: 5000 });
    seedLine(5, ORDER_ROW, "Middle B", { weight: 1000 });
    seedLine(4, ORDER_ROW, "Middle A", { weight: 1000 });

    await request(`/admin/order/${ORDER_ID}/`);

    expect(renderedLines().map((l) => l.name)).toEqual(["Heavy", "Middle A", "Middle B", "Light"]);
  });

  // SUSPECT, and a real divergence from what Django showed. `orderline.weight`
  // is nullable (0005_orders_and_charity.sql:41) -- an item the weights table
  // does not know about lands here as NULL, which is precisely the line an
  // admin wants to see, and admin/order.njk:132 prints it as "0g". SQLite
  // sorts NULL below every number, so `ORDER BY weight DESC` puts it LAST
  // (executed above this file, not assumed). Postgres documents the opposite
  // default -- nulls sort as though larger, so DESC puts them FIRST -- which
  // means the unweighed line Django floated to the top of the table now sits
  // at the bottom of it. Cosmetic, but it is the row the page exists to catch,
  // and nothing else in the codebase records the flip.
  it("puts a line with no weight last, where SQLite's NULL ordering puts it", async () => {
    seedLine(1, ORDER_ROW, "Unweighed", { weight: null });
    seedLine(2, ORDER_ROW, "Featherweight", { weight: 1 });

    await request(`/admin/order/${ORDER_ID}/`);

    expect(renderedLines().map((l) => l.name)).toEqual(["Featherweight", "Unweighed"]);
    expect(renderedLines()[0]?.weight).toBe(1);
    expect(renderedLines()[1]?.weight).toBeNull();
  });

  // The four columns admin/order.njk:130-138 renders, and no others. `calories`
  // in particular has to survive as a distinguishable 0/null rather than being
  // coalesced upstream: the template offers a one-click "Add this item" link
  // on any falsy value, which is the whole mechanism for spotting an item
  // missing from the OrderItem table.
  it("carries the four columns the table renders, zero calories included", async () => {
    seedLine(1, ORDER_ROW, "Unknown brand rice", { quantity: 3, weight: 1000, calories: 0 });

    await request(`/admin/order/${ORDER_ID}/`);

    expect(renderedLines()).toEqual([{ name: "Unknown brand rice", quantity: 3, weight: 1000, calories: 0 }]);
  });

  // MUTANT SURVIVOR, now closed: a `LIMIT 10` on getOrderLines' query, and
  // equivalently a `lines.slice(0, 10)` in the handler. Every lines test above
  // seeds at most four rows, so a cap anywhere between 5 and infinity was
  // invisible -- and a cap is the single likeliest thing to be added to this
  // query by someone tidying up a page they think is a list view.
  //
  // The seed is not arbitrary: the fixture order's own `no_lines` is 14, and
  // the heading prints that column while the table prints these rows, so a cap
  // renders as "Lines: 14" above ten rows. Nobody counts. Twenty-five rows is
  // an ordinary supermarket delivery and comfortably past the round numbers a
  // cap would use.
  it("shows every line of a long order, with no cap between the count and the table", async () => {
    for (let i = 1; i <= 25; i++) {
      seedLine(i, ORDER_ROW, `Line ${String(i).padStart(2, "0")}`, { weight: 2600 - i * 100 });
    }

    await request(`/admin/order/${ORDER_ID}/`);

    expect(renderedLines()).toHaveLength(25);
    // Heaviest first still holds across the whole set, which is the other half
    // of what a LIMIT would quietly change: it truncates the LIGHT end here,
    // and the HEAVY end the moment someone flips the sort.
    expect(renderedLines()[0]?.name).toBe("Line 01");
    expect(renderedLines().at(-1)?.name).toBe("Line 25");
  });

  // MUTANT SURVIVOR, now closed: `SELECT DISTINCT name, quantity, weight,
  // calories`. The projection drops `orderline.id`, so two genuinely separate
  // lines that agree on all four remaining columns are indistinguishable to
  // SQLite and DISTINCT would collapse them into one. That happens for real:
  // orderLines.ts parses `items_text` line by line and a delivery listed as
  // two separate 4-packs of the same tin -- a substitution split across two
  // picks -- produces exactly this pair. The page would then show half the
  // weight it charged for, under a "Lines" count that still said two.
  it("keeps two identical lines as two rows rather than collapsing them", async () => {
    seedLine(1, ORDER_ROW, "Tinned tomatoes", { quantity: 4, weight: 400, calories: 320 });
    seedLine(2, ORDER_ROW, "Tinned tomatoes", { quantity: 4, weight: 400, calories: 320 });

    await request(`/admin/order/${ORDER_ID}/`);

    expect(renderedLines()).toEqual([
      { name: "Tinned tomatoes", quantity: 4, weight: 400, calories: 320 },
      { name: "Tinned tomatoes", quantity: 4, weight: 400, calories: 320 },
    ]);
  });

  // An order whose queue job has not run yet -- which is the state the page is
  // reached in immediately after a save (orderForm.ts:381 redirects straight
  // here). The empty array is what drives admin/order.njk:141's "None" row.
  it("gives the template an empty list, not null, when the job has not run", async () => {
    await request(`/admin/order/${ORDER_ID}/`);

    expect(renderedLines()).toEqual([]);
  });
});

describe("adminOrderDetail -- the weights", () => {
  // givefood/models/orders.py:83-87. weight_kg() is weight/1000 and
  // weight_kg_pkg() is that times PACKAGING_WEIGHT_PC = 1.18
  // (givefood/const/general.py:136) -- the constant order.ts:9 copies. The
  // second value is derived from the FIRST, not from the grams: 26430 * 1.18
  // / 1000 and 26430 / 1000 * 1.18 are the same real number but not the same
  // double, and the whole point of a shipping estimate is that it matches what
  // the courier's own sum produced.
  it("converts grams to kilograms and adds the packaging percentage", async () => {
    await request(`/admin/order/${ORDER_ID}/`);

    expect(lastRender().context.weight_kg).toBe("26.43");
    expect(lastRender().context.weight_kg_pkg).toBe("31.19");
  });

  // Two decimals ALWAYS, including the trailing zeros Django's
  // `|floatformat:2` also forces. A page reading "26.4 kg" next to "31.19 kg"
  // is the tell that someone swapped toFixed for a plain division.
  it("keeps two decimals on a round number", async () => {
    db.prepare("UPDATE orders SET weight = 2500 WHERE id = ?").run(ORDER_ROW);

    await request(`/admin/order/${ORDER_ID}/`);

    expect(lastRender().context.weight_kg).toBe("2.50");
    expect(lastRender().context.weight_kg_pkg).toBe("2.95");
  });

  // THE ORDER OF THE TWO OPERATIONS, which the block above asserts nothing
  // about because at 26,430 g both orderings agree. 1,250 g is the smallest
  // weight where they do not: the shipped `weightKg * 1.18` is
  // 1.4749999999999999 and rounds to 1.47, while multiplying the GRAMS first
  // and dividing after gives exactly 1.475, which rounds to 1.48. Both were
  // executed, in node and in CPython, not reasoned about -- and Django lands
  // on 1.47 too, because weight_kg_pkg() (models/orders.py:86-87) is literally
  // `self.weight_kg() * PACKAGING_WEIGHT_PC`, the same two steps in the same
  // sequence. A penny of a kilogram either way is nothing; a shipping estimate
  // that stopped agreeing with the one the maintainer has been quoting for
  // years, on an eighth of all weights and with no version of the page saying
  // which is which, is the thing worth pinning.
  it("multiplies the kilograms, not the grams -- the one place the two agree to disagree", async () => {
    db.prepare("UPDATE orders SET weight = 1250 WHERE id = ?").run(ORDER_ROW);

    await request(`/admin/order/${ORDER_ID}/`);

    expect(lastRender().context.weight_kg).toBe("1.25");
    expect(lastRender().context.weight_kg_pkg).toBe("1.47"); // grams-first would be "1.48"
  });

  it("renders a zero-weight order as 0.00 rather than blank", async () => {
    db.prepare("UPDATE orders SET weight = 0 WHERE id = ?").run(ORDER_ROW);

    await request(`/admin/order/${ORDER_ID}/`);

    expect(lastRender().context.weight_kg).toBe("0.00");
    expect(lastRender().context.weight_kg_pkg).toBe("0.00");
  });

  // SUSPECT, pinned rather than fixed. Django rendered this through
  // `|floatformat:2`, which is Decimal(str(value)).quantize(ROUND_HALF_UP);
  // Number.prototype.toFixed rounds the DOUBLE, and 1005/1000 is stored as
  // 1.00499999999999989..., so it rounds down. Both halves were executed
  // rather than reasoned about: CPython gives "1.01" for floatformat(1.005, 2)
  // and node gives "1.00" for (1005/1000).toFixed(2). One penny-equivalent of
  // a kilogram, only on weights whose gram total ends in a 5 that lands
  // exactly on the boundary -- which is why it is recorded here instead of
  // being chased. Note the packaging figure does NOT diverge on the same
  // input: 1.005 * 1.18 is 1.1858999999999997 in both languages and both
  // round it to 1.19.
  it("rounds a half-gram boundary down where Django's floatformat rounded it up", async () => {
    db.prepare("UPDATE orders SET weight = 1005 WHERE id = ?").run(ORDER_ROW);

    await request(`/admin/order/${ORDER_ID}/`);

    expect(lastRender().context.weight_kg).toBe("1.00"); // Django: "1.01"
    expect(lastRender().context.weight_kg_pkg).toBe("1.19"); // Django: "1.19" too
  });
});

describe("adminOrderDetail -- the money", () => {
  // Pence to pounds. Django's Order.natural_cost() is float(cost/100) rendered
  // with NO floatformat at all (admin/order.html:39), so Django printed
  // "£10.5" for a £10.50 order and "£10.0" for a round one. The port always
  // gives two decimals. A deliberate improvement, recorded here so it reads as
  // a decision rather than as an accident waiting to be "fixed" back.
  it("formats the cost as pounds and pence, where Django printed a bare float", async () => {
    await request(`/admin/order/${ORDER_ID}/`);

    expect(lastRender().context.cost).toBe("42.18");

    db.prepare("UPDATE orders SET cost = 1050 WHERE id = ?").run(ORDER_ROW);
    await request(`/admin/order/${ORDER_ID}/`);

    expect(lastRender().context.cost).toBe("10.50"); // Django: "10.5"
  });

  it("formats the delivered cost when the invoice came back", async () => {
    db.prepare("UPDATE orders SET actual_cost = 4407 WHERE id = ?").run(ORDER_ROW);

    await request(`/admin/order/${ORDER_ID}/`);

    expect(lastRender().context.actual_cost).toBe("44.07");
  });

  // Null suppresses the whole "Delivered cost" row (admin/order.njk:49-52),
  // which is the ordinary state of an order that has not been invoiced.
  it("passes null for an order with no delivered cost yet", async () => {
    await request(`/admin/order/${ORDER_ID}/`);

    expect(lastRender().context.actual_cost).toBeNull();
  });

  // PARITY, not a bug, and worth pinning precisely because it looks like one.
  // A genuinely free delivery -- a donated order, actual_cost 0 -- is
  // indistinguishable on this page from one that was never invoiced: the row
  // simply does not appear. That is Django's own behaviour, not a porting
  // slip: natural_actual_cost() (models/orders.py:77-81) tests
  // `if self.actual_cost:` and returns None for 0, and the template guards on
  // the same falsy value again. Changing it here would make the port disagree
  // with the site it is replacing.
  it("hides a delivered cost of exactly zero, exactly as Django did", async () => {
    db.prepare("UPDATE orders SET actual_cost = 0 WHERE id = ?").run(ORDER_ROW);

    await request(`/admin/order/${ORDER_ID}/`);

    expect(lastRender().context.actual_cost).toBeNull();
  });
});

describe("adminOrderDetail -- the delivery provider link", () => {
  function setProvider(provider: string | null, providerId: string | null): void {
    db.prepare("UPDATE orders SET delivery_provider = ?, delivery_provider_id = ? WHERE id = ?").run(provider, providerId, ORDER_ROW);
  }

  // admin/order.html:56's inline `{% if order.delivery_provider == "Tesco" %}`
  // chain, lifted into order.ts:11-14 as a lookup table. The paths are the
  // literal strings Django built, so an admin clicking through lands on the
  // real basket rather than on a 404 inside Tesco's account area.
  it("builds the Tesco order URL", async () => {
    setProvider("Tesco", "573384906");

    await request(`/admin/order/${ORDER_ID}/`);

    expect(lastRender().context.delivery_provider_url).toBe("https://www.tesco.com/groceries/en-GB/orders/573384906");
  });

  it("builds the Sainsbury's order URL", async () => {
    setProvider("Sainsbury's", "8005551212");

    await request(`/admin/order/${ORDER_ID}/`);

    expect(lastRender().context.delivery_provider_url).toBe("https://www.sainsburys.co.uk/gol-ui/my-account/orders/8005551212");
  });

  // SUSPECT, and the reason this test does not read `toBeNull()`. Costco and
  // Pedal Me are the other two members of orderForm.ts:47's DELIVERY_PROVIDERS
  // -- both real, both saveable, neither with an order page to link to.
  // Django's `{% if %}` chain gave them an EMPTY href (`<a href="">`, a link
  // back to the current page) and the port is the better of the two:
  // admin/order.njk:65 falls through to plain text. But it gets there by
  // accident of syntax rather than by decision, and the value it gets there
  // WITH is not the one the null branch produces.
  //
  // `DELIVERY_PROVIDER_ORDER_URL[provider]?.(id)` (order.ts:29) short-circuits
  // to UNDEFINED when the lookup misses, so delivery_provider_url has three
  // states rather than two: a string; `null`, from the explicit else of the
  // surrounding ternary when either half of the provider pair is missing; and
  // `undefined`, when the provider is present but unrecognised. Harmless in
  // the template, where both are falsy and env.ts pins throwOnUndefined:false.
  // It stops being harmless the moment this context is serialised rather than
  // rendered -- JSON.stringify DROPS an undefined property and keeps a null
  // one, so an API or htmx fragment built off it would omit the key for
  // exactly the orders whose provider is unrecognised, which is the set of
  // orders someone debugging this would be looking at.
  it("yields undefined, not null, for a provider with no known order page", async () => {
    setProvider("Costco", "CS-99123");

    await request(`/admin/order/${ORDER_ID}/`);

    expect(lastRender().context.delivery_provider_url).toBeUndefined();
    // The key is present and holds undefined -- not absent. Both halves are
    // asserted because they are what the two consumers above disagree about.
    expect(Object.hasOwn(lastRender().context, "delivery_provider_url")).toBe(true);
  });

  // Both halves are required. An order can carry a provider with no reference
  // number (typed in before the confirmation email arrived), and the URL would
  // otherwise be ".../orders/" -- a link to the whole order history of a
  // shared supermarket account.
  it("returns null when the provider is known but the reference is missing", async () => {
    setProvider("Tesco", null);

    await request(`/admin/order/${ORDER_ID}/`);

    expect(lastRender().context.delivery_provider_url).toBeNull();
  });

  it("returns null when a reference exists but no provider does", async () => {
    setProvider(null, "573384906");

    await request(`/admin/order/${ORDER_ID}/`);

    expect(lastRender().context.delivery_provider_url).toBeNull();
  });

  // HAZARD, not a live bug -- recorded because the difference should be
  // written down rather than rediscovered. The reference is interpolated into
  // the URL RAW: no encodeURIComponent, so a stray "?" or "#" or "../" typed
  // into the box rewrites where the link points. It cannot reach a foreign
  // host (the scheme and authority are literal, and a leading "/" only walks
  // back to the provider's own root), and nunjucks escapes the value into the
  // href attribute, so this is a wrong link rather than an injection. Django's
  // template interpolated it just as raw. The day this field is ever populated
  // from a scraped confirmation page rather than typed by the maintainer, this
  // is the test that says the escaping was never there.
  it("interpolates the provider reference into the URL without encoding it", async () => {
    setProvider("Tesco", "../../../basket?x=1");

    await request(`/admin/order/${ORDER_ID}/`);

    expect(lastRender().context.delivery_provider_url).toBe("https://www.tesco.com/groceries/en-GB/orders/../../../basket?x=1");
  });

  // HAZARD, same category, and the sharper one. order.ts:29 indexes a plain
  // object literal by an admin-supplied string and then CALLS whatever comes
  // back: `DELIVERY_PROVIDER_ORDER_URL[provider]?.(id)`. The literal inherits
  // Object.prototype, so "toString", "valueOf", "constructor" and
  // "hasOwnProperty" all resolve to functions and all get invoked -- the
  // optional-call guard tests for null/undefined, not for "is one of mine".
  // The result is a delivery_provider_url of "[object Object]" instead of the
  // null every other unknown provider gets.
  //
  // It is unreachable today: orderForm.ts:273 rejects any provider outside
  // DELIVERY_PROVIDERS on write, and the form renders a <select>. It becomes
  // reachable the moment a provider arrives from anywhere else -- an import, a
  // scraper, a bulk edit -- which is why it is pinned rather than left to be
  // found. Object.create(null) or an own-property check would close it.
  it("calls an inherited Object.prototype method when the provider names one", async () => {
    setProvider("toString", "573384906");

    await request(`/admin/order/${ORDER_ID}/`);

    expect(lastRender().context.delivery_provider_url).toBe("[object Object]");
  });
});

describe("adminOrderDetail -- need_id_short", () => {
  // FoodbankChange.need_id_short() is str(need_id)[:7]
  // (givefood/models/needs.py:81-82), the link text on admin/order.html:75.
  // Seven characters of a 32-character dashless uuid: enough to recognise,
  // short enough for a heading. The HREF keeps the whole thing, which is the
  // half that has to keep working -- a truncated href 404s the need page.
  it("shortens the need uuid to seven characters for the heading, keeping the full id for the link", async () => {
    seedNeed(10, "ab12cd3456789012345678901234ef00");
    db.prepare("UPDATE orders SET need_id = 10 WHERE id = ?").run(ORDER_ROW);

    await request(`/admin/order/${ORDER_ID}/`);

    expect(renderedOrder().need_id_short).toBe("ab12cd3");
    expect(renderedOrder().need_id_str).toBe("ab12cd3456789012345678901234ef00");
  });

  // A need id shorter than seven characters is not truncated to a fixed width
  // or padded -- slice returns what there is. Nothing in production is this
  // short, but the guard is `need_id_str ? ... : null` and this pins that the
  // short branch is a length question, not a truthiness one.
  it("returns a short need id unchanged", async () => {
    seedNeed(10, "abc");
    db.prepare("UPDATE orders SET need_id = 10 WHERE id = ?").run(ORDER_ROW);

    await request(`/admin/order/${ORDER_ID}/`);

    expect(renderedOrder().need_id_short).toBe("abc");
  });

  it("is null on an order with no need", async () => {
    await request(`/admin/order/${ORDER_ID}/`);

    expect(renderedOrder().need_id_short).toBeNull();
  });
});

describe("adminOrderDetail -- the notification timestamp", () => {
  // admin/order.html:88's `{{ order.notification_email_sent|timesince }} ago`.
  // The space inside "2 days" is U+00A0 -- Django's timesince applies
  // avoid_wrapping() to each unit and lib/timesince.ts copies it -- while the
  // one before "ago" is an ordinary space, because that word is appended by
  // the handler. Written as an escape rather than as a literal so the
  // difference cannot be "corrected" by accident, and so a diff shows it.
  it("renders how long ago the food bank was told, with the non-breaking space Django uses", async () => {
    freezeClock();
    db.prepare("UPDATE orders SET notification_email_sent = ? WHERE id = ?").run("2026-09-05 12:00:00.000000", ORDER_ROW);

    await request(`/admin/order/${ORDER_ID}/`);

    expect(lastRender().context.notification_email_sent_timesince).toBe("2\u00A0days ago");
  });

  // The RAW column has to reach the template too, not just the friendly age.
  // admin/order.njk:95-97 switches the whole Sent/Not Sent line on
  // `order.notification_email_sent` and prints it into the <time> element's
  // datetime attribute and title. A handler that passed down only the computed
  // string would render "x Not Sent" on an order the food bank was told about
  // three days ago -- with the Send Notification button sitting underneath it,
  // looking like the thing to press, and real mail at the other end of it.
  it("passes the raw timestamp down as well as the age", async () => {
    freezeClock();
    db.prepare("UPDATE orders SET notification_email_sent = ? WHERE id = ?").run("2026-09-05 12:00:00.000000", ORDER_ROW);

    await request(`/admin/order/${ORDER_ID}/`);

    expect(renderedOrder().notification_email_sent).toBe("2026-09-05 12:00:00.000000");
  });

  // Null, not "0 minutes ago". admin/order.njk:95 switches the whole
  // Notification block on the raw column, so this value is only ever read on
  // the sent branch -- but a "0 minutes ago" leaking out of here would read as
  // "we emailed them a moment ago" on an order nobody has been told about,
  // which is the one thing this block exists to answer.
  it("is null when no notification has been sent", async () => {
    await request(`/admin/order/${ORDER_ID}/`);

    expect(lastRender().context.notification_email_sent_timesince).toBeNull();
  });

  // A timestamp in the future -- clock skew between the job that wrote it and
  // the isolate that reads it -- collapses to Django's own zero case rather
  // than producing a negative count. lib/timesince.ts returns "0 minutes" for
  // any non-positive interval, exactly as django.utils.timesince does, and the
  // handler appends "ago" regardless.
  it("says 0 minutes ago for a timestamp in the future rather than a negative age", async () => {
    freezeClock();
    db.prepare("UPDATE orders SET notification_email_sent = ? WHERE id = ?").run("2026-09-09 12:00:00.000000", ORDER_ROW);

    await request(`/admin/order/${ORDER_ID}/`);

    expect(lastRender().context.notification_email_sent_timesince).toBe("0\u00A0minutes ago");
  });
});

// THE ?job= BANNER. orderForm.ts:381 redirects here with the id of the queue
// job that parses items_text into order lines, because that work happens after
// the redirect: without the banner a just-saved order reads 0 items / £0.00
// and looks exactly like a save that threw everything away. This block is
// therefore about a piece of UI whose entire purpose is to stop an admin
// believing a data-loss bug that is not happening.
const JOB_ID = "0195f3ac-2e51-7c2f-9f4a-1d7a5f0b1c2d";
const DECOY_JOB_ID = "0195f3ac-0000-7c2f-9f4a-000000000000";

describe("adminOrderDetail -- the ?job= poll banner", () => {
  // THE DECOY JOB, and the mutant survivor it exists to close:
  // `SELECT * FROM admin_job` with the `WHERE id = ?` removed. `admin_job` is
  // the one table in this file that was only ever seeded with the row the test
  // was looking for, so getAdminJob could be reduced to "any job at all" and
  // every assertion below still passed -- the classic list-page hole, on a
  // single-row lookup.
  //
  // It is seeded FIRST, so it is the row a predicate-less scan reaches first,
  // and it carries the loudest state the banner has: a failed job with error
  // text. `admin_job` is append-only and shared by every admin background task
  // in the site (needcheck, force-crawl, order lines), so in production it is
  // never the one-row table these tests used to build -- by the time an order
  // is saved there are thousands of rows in it and the newest is almost
  // certainly somebody else's.
  beforeEach(() => {
    seedJob(DECOY_JOB_ID, {
      kind: "check",
      target: "amesbury",
      status: "failed",
      error: "DECOY JOB ERROR -- belongs to another job entirely",
      created: "2026-09-06 09:00:00.000000",
      finished: "2026-09-06 09:00:03.000000",
    });
  });

  it("passes a running job's id and status straight to the banner", async () => {
    seedJob(JOB_ID, { status: "running" });

    await request(`/admin/order/${ORDER_ID}/?job=${JOB_ID}`);

    expect(lastRender().context.job_id).toBe(JOB_ID);
    expect(lastRender().context.job_status).toBe("running");
    expect(lastRender().context.job_error).toBeNull();
  });

  // The failure branch (admin/order.njk:14-17), which is the one that matters:
  // a parse that failed leaves the order with no lines FOREVER, and this text
  // is the only place that says so. `job_error` is the raw message the queue
  // consumer stored.
  it("carries a failed job's error text through to the danger notification", async () => {
    seedJob(JOB_ID, { status: "failed", error: "Could not parse line 4: '3 x '", finished: "2026-09-07 12:00:01.000000" });

    await request(`/admin/order/${ORDER_ID}/?job=${JOB_ID}`);

    expect(lastRender().context.job_status).toBe("failed");
    expect(lastRender().context.job_error).toBe("Could not parse line 4: '3 x '");
  });

  it("reports a finished job as done", async () => {
    seedJob(JOB_ID, { status: "done", result: '{"lines":14}', finished: "2026-09-07 12:00:01.000000" });

    await request(`/admin/order/${ORDER_ID}/?job=${JOB_ID}`);

    expect(lastRender().context.job_status).toBe("done");
    expect(lastRender().context.job_error).toBeNull();
  });

  // An ordinary visit -- from the orders list, a bookmark, the food bank tab.
  // The three nulls suppress the banner, and the assertion on `queries` is the
  // only way to see that the lookup was SKIPPED rather than merely returning
  // nothing: getAdminJob(db, null) would produce the same rendered context
  // while spending a D1 read on every page view of a table with no useful row
  // to find. order.ts:47-53's comment claims the id is "only ever used to look
  // a row up by primary key"; this is that claim, executed.
  it("skips the job lookup entirely when no job id is in the query string", async () => {
    seedJob(JOB_ID);

    await request(`/admin/order/${ORDER_ID}/`);

    expect(lastRender().context.job_id).toBeNull();
    expect(lastRender().context.job_status).toBeNull();
    expect(lastRender().context.job_error).toBeNull();
    expect(queries.some((q) => q.includes("admin_job"))).toBe(false);
  });

  // A stale link -- the job row is pruned, or the id was hand-edited. The page
  // must still render the order: order.ts's own comment says an unknown or
  // malformed id simply yields null, and this is where "simply" is checked.
  // Note that `job_id` is still echoed into the template, which is harmless
  // only because the banner it feeds is behind `{% if job_status %}`.
  //
  // This is also where the decoy above does its sharpest work: the table is
  // NOT empty, so "no row matched" and "the lookup has no predicate" give
  // different answers. Without it, a getAdminJob that ignored its argument
  // would have passed this test on a table that happened to hold nothing.
  // With it, the page would sprout a red "The items text could not be parsed"
  // banner -- quoting another task's error -- over an order that parsed fine.
  it("still renders the order when the job id matches nothing, and adopts no other job", async () => {
    const res = await request(`/admin/order/${ORDER_ID}/?job=does-not-exist`);

    expect(res.status).toBe(200);
    expect(lastRender().context.job_id).toBe("does-not-exist");
    expect(lastRender().context.job_status).toBeNull();
    expect(lastRender().context.job_error).toBeNull();
    expect(renderedOrder().order_id).toBe(ORDER_ID);
  });

  // `?job=` with nothing after it. The empty string is falsy, so the lookup is
  // skipped, but `?? null` never fires and `job_id` comes through as "" rather
  // than null. Harmless today for the same reason as above -- the banner is
  // gated on `job_status`, not on `job_id` -- and pinned because the two
  // fields disagreeing is exactly the kind of thing a later template edit
  // ("show the poller whenever we have a job id") would turn into an
  // infinitely polling banner for a job that does not exist.
  it("treats an empty ?job= as no job, but echoes the empty string rather than null", async () => {
    await request(`/admin/order/${ORDER_ID}/?job=`);

    expect(lastRender().context.job_id).toBe("");
    expect(lastRender().context.job_status).toBeNull();
    expect(queries.some((q) => q.includes("admin_job"))).toBe(false);
  });

  // SUSPECT, low severity, pinned: getAdminJob looks a job up BY ID ALONE.
  // Neither `kind` nor `target` is checked, so any admin job's id pasted into
  // this URL renders the order page's "Parsing the items text into order
  // lines..." banner and starts htmx polling /admin/job/<id>/ for it. The
  // 6-hour food bank check below is a real job kind from a different page
  // entirely. Only an authenticated admin can construct this, and the worst
  // outcome is a misleading banner over a correct order -- but the page claims
  // something about the order that the job has nothing to do with.
  it("shows the order-lines banner for a job of an entirely unrelated kind", async () => {
    seedJob(JOB_ID, { kind: "check", target: "salisbury", status: "running" });

    await request(`/admin/order/${ORDER_ID}/?job=${JOB_ID}`);

    expect(lastRender().context.job_status).toBe("running");
  });
});

// SUSPECT, and the one hazard on this page with a plausible route to a wrong
// answer in production. `orders` carries no unique index on `order_id` -- see
// the SCHEMA comment; the three indexes copied there are all of them -- and
// getOrderDetail ends in `.first()`, so two rows sharing a public id yield one
// of them with nothing logged and nothing shown. orderForm.ts:317 mints ids by
// concatenation from (slug, provider, delivery date), so a collision needs
// only two orders from one food bank and one provider on one day; the form
// pre-checks with findConflictingOrder, which makes this rare rather than
// impossible, and the pre-check has the same replica-lag hole
// foodbankLocation.test.ts documents for locations.
//
// The test deliberately does NOT pin WHICH row wins -- that is SQLite's scan
// order over a table with no index to use, and pinning it would be pinning an
// implementation detail of the engine. What it pins is the shape of the
// failure: the page is internally consistent (the lines shown belong to the
// order shown) and gives the reader no way to tell that a second order with
// the same id exists at all.
describe("adminOrderDetail -- two orders sharing a public id", () => {
  it("silently serves one of them, with no sign that the other exists", async () => {
    const SHARED = "gf-salisbury-tesco-2026-09-01";
    seedOrder(30, SHARED, { cost: 1000 });
    seedOrder(31, SHARED, { cost: 2000 });
    seedLine(301, 30, "Line of order 30");
    seedLine(311, 31, "Line of order 31");

    const res = await request(`/admin/order/${SHARED}/`);

    expect(res.status).toBe(200);
    const shown = renderedOrder();
    expect([30, 31]).toContain(shown.id);
    expect(renderedLines().map((l) => l.name)).toEqual([`Line of order ${shown.id}`]);
    // Both rows are still there; the page just never mentions the other one.
    expect((db.prepare("SELECT COUNT(*) AS n FROM orders WHERE order_id = ?").get(SHARED) as { n: number }).n).toBe(2);
  });
});

