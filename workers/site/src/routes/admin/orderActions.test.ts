import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { Hono } from "hono";
import type { ExecutionContext } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../types";
import { requireAdminAuth } from "../../middleware/adminAuth";
import { tryAppendSlashRedirect } from "../../lib/appendSlash";
import { hmacSha256Hex } from "../../lib/hmac";
import { adminApp } from "./index";
import { adminOrderSendNotification, adminOrderEmailPreview, adminOrderDelete } from "./orderActions";

// routes/admin/orderActions.ts -- gfadmin/views.py's three remaining Order
// actions: order_send_notification (:494-521), order_email (:2537-2551) and
// order_delete (:524-528).
//
// WHY THIS FILE IS SHAPED THE WAY IT IS. Every one of these three handlers
// fails SILENTLY when it fails at all, and the repo has two logged instances
// of exactly that: #34 (a form field parsed, threaded through the handler,
// then written by no SQL -- and redirected as though it had worked) and #12
// (a write that raised, and a 500 page that threw away everything the admin
// had typed). Neither showed up as an error anybody saw. So nothing below
// treats a 302 as evidence of anything: every test that expects a write reads
// the row back out of SQLite and asserts its columns, and every test that
// expects a REFUSAL asserts that the columns are still what they were.
//
// The three specific silent failures this file is built to catch:
//
//   * SEND NOTIFICATION STAMPING A SEND THAT NEVER HAPPENED. Django discards
//     send_email()'s return value (views.py:510-516) and stamps
//     notification_email_sent regardless, so a Postmark outage leaves a green
//     "Sent" tick on an email nobody received and the button looks done. This
//     port checks the boolean; the two tests in "when Postmark refuses it"
//     are the whole value of that decision, and both assert the column is
//     still NULL rather than merely that the URL carries a different param.
//
//   * SEND NOTIFICATION CHURNING THE ORDER. views.py:518-519 calls the FULL
//     order.save() to write one timestamp, which re-runs the paid Gemini
//     parse and deletes and recreates every OrderLine at temperature=1 -- so
//     pressing "send email" could change what the order says was ordered.
//     setOrderNotificationSent is a targeted UPDATE instead, and
//     "leaves the order's lines and aggregates completely alone" is that
//     claim asserted against the actual rows, not against the SQL text.
//
//   * DELETE REACHABLE BY GET. Django's order_delete has no @require_POST
//     (contrast :494) and CsrfViewMiddleware is commented out in production
//     (settings.py:97), so a prefetching browser or an <img src> destroys an
//     order. The fix is POST-only + CSRF, and both halves are asserted with
//     the row read back afterwards.
//
// REAL EVERYTHING. A real Hono app wired the way routes/admin/index.ts wires
// it (sub-app, real requireAdminAuth, real registration paths, the parent's
// APPEND_SLASH-probing notFound), the real CSRF verifier over a real HMAC,
// the real Nunjucks templates, the real packages/db functions, and a real
// SQLite database underneath. The only stand-ins are the things that leave
// the machine or are not a database: the D1 binding (node:sqlite behind the
// slice of the Sessions API packages/db is handed), the SESSIONS KV the
// admin session lives in, and global fetch, which is Postmark.
//
// MUTATION-TESTED, per TESTING.md's convention, from a transpiled copy in a
// scratchpad outside the repo. Two rounds: fifteen mutants while the file was
// written, then an adversarial round of fifty-two, including one applied to
// routes/admin/index.ts rather than to this module. All fifty-two are now
// caught. The ones worth naming because they are the mistakes an ordinary
// refactor makes: stamping notification_email_sent even when Postmark refused
// (3 tests), never writing the stamp at all -- issue #34's exact shape, a
// handler that redirects as though it worked (3), dropping either CSRF check
// (3 and 4), never recomputing last_order (3), recomputing it for an
// unassigned order (1), recomputing it BEFORE the delete so it recomputes to
// the date being deleted (2), `??` where the code says `||` (1), and handing
// getOrderLinesByWeight the wrong id (4). Three mutants are EQUIVALENT rather
// than caught: deleting the `?? 0` from the per-line weight (recorded as such
// at the test that would have caught a real one), and -- equivalent by policy
// rather than by luck -- `getUTCDay()` -> `getDay()` and dropping the "Z" from
// the parsed delivery date, neither of which can change anything while TZ is
// UTC, which vitest.config.mts pins and the Workers runtime guarantees.
//
// The adversarial round found SEVEN survivors, and each is named at the test
// written to kill it. Four were context fields the email carries that no
// assertion ever read back (#34's shape, moved inside the email body); two
// were the ORDER of the CSRF check against the order lookup, which turns
// these URLs into an existence oracle for order ids; and one was the
// registration in routes/admin/index.ts itself, which this file had only ever
// hand-copied and therefore could not see change.
//
// The templates come out of packages/templates/src/generated/, a gitignored
// build artefact -- the same dependency donationPoint.test.ts already takes,
// and taken deliberately here: the email BODY is what these handlers exist to
// produce, so asserting on a mocked render()'s context would assert the
// handler agrees with itself. `pnpm typecheck` (and `pnpm test`) precompile
// it, so a fresh checkout that has run either has it.

// ---------------------------------------------------------------------------
// Fixture schema
// ---------------------------------------------------------------------------

// Only the tables these three handlers' queries actually name, transcribed
// from migrations/0005_orders_and_charity.sql:19-48 (orders, orderline),
// 0001_core.sql:109-122 (foodbankchange) and 0015_ordergroup.sql:41-49
// (ordergroup), plus the columns of `foodbank` that the order email reads.
// A column no query names cannot be the thing that breaks, and transcribing
// the other seventy columns of `foodbank` would be a second copy of the truth
// waiting to drift from the first.
//
// `foodbankchange` and `ordergroup` are here with no test of their own
// because getOrderDetail LEFT JOINs all three: an order whose need or group
// is absent must still load, which is the state every fixture below is in.
const SCHEMA = `
CREATE TABLE foodbank (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  address TEXT NOT NULL, postcode TEXT NOT NULL,
  delivery_address TEXT,
  contact_email TEXT NOT NULL, notification_email TEXT,
  phone_number TEXT, delivery_phone_number TEXT,
  shopping_list_url TEXT NOT NULL,
  is_closed INTEGER NOT NULL DEFAULT 0,
  latest_need_id INTEGER,
  last_order TEXT,
  modified TEXT NOT NULL, edited TEXT
);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  order_id TEXT NOT NULL,
  items_text TEXT NOT NULL, country TEXT NOT NULL,
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
CREATE TABLE orderline (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL, item_cost INTEGER NOT NULL, line_cost INTEGER NOT NULL,
  weight INTEGER, calories INTEGER,
  order_id INTEGER NOT NULL,
  delivery_date TEXT, category TEXT, group_name TEXT
);
CREATE INDEX orderline_order_idx ON orderline(order_id);
CREATE TABLE ordergroup (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  public INTEGER NOT NULL DEFAULT 0, key TEXT,
  created TEXT NOT NULL, modified TEXT NOT NULL
);
-- github #51: getFoodbankBySlug reads the food bank row and its latest need in
-- ONE batch(), so the need side is sent even when latest_need_id is NULL: the
-- scalar subquery yields NULL and the comparison matches nothing. Every route
-- below reaches that function, so this narrow fixture now needs the table and
-- the view.
--
-- TAKEN FROM THE MIGRATIONS, NOT TRANSCRIBED. 0019 drops a column off
-- foodbankchange long after 0001 creates it and recreates the view around it,
-- so a hand-copied CREATE TABLE here would have been wrong on the day it was
-- pasted -- which is the drift schema.testkit.ts exists to stop.
${schemaFor("foodbankchange", "foodbankchange_full")}
`;

// ---------------------------------------------------------------------------
// The slice of the D1 Sessions API packages/db is handed, over node:sqlite
// ---------------------------------------------------------------------------

type Bindable = null | number | bigint | string | Uint8Array;

interface Recorded {
  sql: string;
  params: unknown[];
}

// Copied from foodbankLocation.test.ts / donationPoint.test.ts so every tier
// drives the real SQL through one adapter, with two additions this file needs:
//
//   batch(), because deleteOrder is the only write here that uses one, and it
//   uses one deliberately -- "so a half-delete (orphaned orderline rows
//   pointing at a vanished order) is not reachable" (orderWrite.ts:339). Run
//   inside a real BEGIN/COMMIT so that sentence is something the tests can
//   actually rely on rather than a comment.
//
//   a STATEMENT LOG, because two of the claims below are about the absence of
//   SQL rather than the presence of rows: that the email preview's GET writes
//   nothing at all (a GET and a POST share loadOrderForEmail, and a GET that
//   mutates is the classic way that arrangement goes wrong), and that deleting
//   an UNASSIGNED order issues no `UPDATE foodbank` whatsoever. Both are
//   invisible to a row count -- an UPDATE that happens to write back the value
//   already there changes nothing an assertion on columns could see.
function d1Session(db: DatabaseSync, log: { ran: Recorded[] }): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    sql,
    params,
    // A NEW statement rather than a mutated one, matching D1's immutable
    // prepared statements -- a harness that mutated in place would let the
    // last statement of a batch overwrite the bindings of every earlier one.
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      log.ran.push({ sql, params });
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return {
    prepare: (sql: string) => statement(sql, []),
    batch: async (statements: ReturnType<typeof statement>[]) => {
      for (const s of statements) log.ran.push({ sql: s.sql, params: s.params });
      db.exec("BEGIN");
      try {
        const results = statements.map((s) => {
          // all(), not run(): getFoodbankBySlug now batches its food bank row
          // and its latest-need row into one round trip
          // (packages/db/src/foodbank.ts), and run() would execute both SELECTs
          // and throw the rows away. node:sqlite runs deleteOrder's DELETEs
          // through all() just as happily -- no rows, same write, same
          // BEGIN/COMMIT.
          const rows = db.prepare(s.sql).all(...s.params);
          return { success: true, results: rows, meta: {} };
        });
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Ids chosen so no bind can match the wrong column by coincidence: the food
// banks, the orders and the lines all live in different numeric ranges and
// none of them is 1. `orders.id` (INTEGER) and `orders.order_id` (TEXT) are
// two different keys with confusingly similar names -- orderline.order_id is
// the INTEGER one -- so a handler that passed the wrong one has to fail here
// rather than happen to agree.
const SALISBURY = 7;
const BRIXTON = 8;
const ORDER_ROW = 1201;
const OTHER_ORDER_ROW = 1202;
const ORDER_ID = "salisbury-2026-09-05";
const OTHER_ORDER_ID = "salisbury-2026-08-22";

// EVERY TIMESTAMP HERE IS DJANGO'S FORMAT: "YYYY-MM-DD HH:MM:SS.ffffff", which
// is what d1Timestamp() writes and what migration 0022 rewrote the imported
// Postgres rows into. These columns are TEXT and every comparison over them is
// byte-wise, so seeding toISOString() values would test a database this app
// does not have.
const CREATED = "2026-09-01 09:14:22.117000";
const MODIFIED = "2026-09-02 11:02:00.000000";

// 2026-09-05 is a SATURDAY (verified with a real Date, not counted on
// fingers) -- the `|date:"l"` full weekday name the port computes in
// JavaScript because packages/templates has D but no `l`.
const DELIVERY_DATE = "2026-09-05";
// Deliberately the last hour of the day, because delivery_hour_end is a plain
// +1 (models/orders.py:71-72) with no wrap: 23 renders as "24:00", which is
// what Django does too and is therefore what this port must keep doing.
const DELIVERY_HOUR = 23;
// 25000g * 1.18 / 1000 = 29.5 exactly, the one input class where a rounding
// mode is observable at all. Django's floatformat uses ROUND_HALF_UP and
// JavaScript's toFixed rounds half away from zero, so both give "30" -- and
// that is not reasoning: Django 5.2.6's real floatformat was run against
// this formula over 28,572 weights and disagreed with toFixed(0) nowhere.
const WEIGHT_G = 25000;

interface FoodbankSeed {
  id: number;
  name: string;
  slug: string;
  address?: string;
  postcode?: string;
  deliveryAddress?: string | null;
  contactEmail?: string;
  notificationEmail?: string | null;
  phoneNumber?: string | null;
  deliveryPhoneNumber?: string | null;
  lastOrder?: string | null;
}

function seedFoodbank(db: DatabaseSync, seed: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank
       (id, name, slug, address, postcode, delivery_address, contact_email, notification_email,
        phone_number, delivery_phone_number, shopping_list_url, is_closed, latest_need_id, last_order, modified, edited)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)`,
  ).run(
    seed.id,
    seed.name,
    seed.slug,
    seed.address ?? "Unit 1\nChurchfields Road",
    seed.postcode ?? "SP2 7NP",
    seed.deliveryAddress ?? null,
    seed.contactEmail ?? "info@salisburyfoodbank.org.uk",
    seed.notificationEmail ?? null,
    seed.phoneNumber ?? "01722 349556",
    seed.deliveryPhoneNumber ?? null,
    `https://${seed.slug}.foodbank.org.uk/give-help/donate-food/`,
    seed.lastOrder ?? null,
    MODIFIED,
    // A human-edited stamp, present so that "the recompute did not touch
    // `edited`" is a claim about a value that exists rather than about NULL
    // staying NULL. `edited` means "a human edited this food bank" and
    // last_order is a derived value -- see recomputeFoodbankLastOrder.
    "2026-08-14 08:00:00.000000",
  );
}

interface OrderSeed {
  id: number;
  orderId: string;
  foodbankId: number | null;
  deliveryDate?: string;
  deliveryHour?: number;
  weight?: number;
  calories?: number;
  notificationEmailSent?: string | null;
  sourceUrl?: string | null;
  deliveryProvider?: string | null;
}

function seedOrder(db: DatabaseSync, seed: OrderSeed): void {
  const deliveryDate = seed.deliveryDate ?? DELIVERY_DATE;
  const deliveryHour = seed.deliveryHour ?? DELIVERY_HOUR;
  db.prepare(
    `INSERT INTO orders
       (id, order_id, items_text, country, created, modified, notification_email_sent, source_url,
        delivery_date, delivery_hour, delivery_datetime, delivery_provider, delivery_provider_id,
        weight, calories, cost, actual_cost, no_lines, no_items, foodbank_id, need_id, order_group_id)
     VALUES (?, ?, '2x Baked Beans', 'England', ?, ?, ?, ?, ?, ?, ?, ?, 'TESCO-99887', ?, ?, 4212, NULL, 3, 42, ?, NULL, NULL)`,
  ).run(
    seed.id,
    seed.orderId,
    CREATED,
    MODIFIED,
    seed.notificationEmailSent ?? null,
    seed.sourceUrl === undefined ? "https://example.invalid/shopping-list" : seed.sourceUrl,
    deliveryDate,
    deliveryHour,
    `${deliveryDate} ${String(deliveryHour).padStart(2, "0")}:00:00`,
    seed.deliveryProvider === undefined ? "Tesco" : seed.deliveryProvider,
    seed.weight ?? WEIGHT_G,
    seed.calories ?? 123456,
    seed.foodbankId,
  );
}

function seedLine(db: DatabaseSync, id: number, orderRowId: number, name: string, quantity: number, weight: number | null): void {
  db.prepare(
    "INSERT INTO orderline (id, name, quantity, item_cost, line_cost, weight, calories, order_id, delivery_date) VALUES (?, ?, ?, 100, 200, ?, 500, ?, ?)",
  ).run(id, name, quantity, weight, orderRowId, DELIVERY_DATE);
}

// The whole order row, for the "nothing else moved" assertions. Read as one
// object rather than column by column so that a handler which quietly
// restamped `created`, re-zeroed the aggregates or moved the order to another
// food bank fails a test that was not written about any of those.
function orderRow(db: DatabaseSync, orderRowId = ORDER_ROW): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM orders WHERE id = ?").get(orderRowId) as Record<string, unknown> | undefined;
}

function orderLines(db: DatabaseSync, orderRowId = ORDER_ROW): Record<string, unknown>[] {
  return db.prepare("SELECT * FROM orderline WHERE order_id = ? ORDER BY id").all(orderRowId) as Record<string, unknown>[];
}

function foodbankRow(db: DatabaseSync, id = SALISBURY): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM foodbank WHERE id = ?").get(id) as Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// The app, wired as routes/admin/index.ts wires it
// ---------------------------------------------------------------------------

const ORIGIN = "https://www.givefood.org.uk";
const CSRF_SECRET = "test-csrf-secret-not-a-real-one";
const CSRF_RAW = "a".repeat(64);
const POSTMARK_TOKEN = "test-postmark-token";
const SESSION_ID = "order-actions-session";
const SESSION_COOKIE = `__Host-gfsession=${SESSION_ID}`;
const SESSION_KV_KEY = `admin-session:${SESSION_ID}`; // lib/adminAuth.ts:250 sessionKvKey()

let db: DatabaseSync;
let sqlLog: { ran: Recorded[] };

// The statements that WRITE. Since github #51 getFoodbankBySlug is a batch()
// too -- its food bank row and its latest-need row in one round trip -- and
// batched statements land in this log alongside deleteOrder's DELETEs, which is
// what the log is for. Filtering here rather than in the harness: D1 gives a
// batch no way to say which of its statements write, and an adapter that
// decided for itself which statements "count" could hide the write these
// assertions exist to catch. Same spirit as the `/UPDATE\s+foodbank/i` filter
// further down, which already reads the SQL text in an assertion.
const writes = (): Recorded[] => sqlLog.ran.filter((s) => !/^\s*SELECT\b/i.test(s.sql));
let fetchMock: ReturnType<typeof vi.fn>;
let postmarkStatus: number;
let env: AppEnv["Bindings"];

interface PostmarkPayload {
  From: string;
  To: string;
  Cc: string | null;
  Bcc: string | null;
  Subject: string;
  TextBody: string;
  HtmlBody: string | null;
  ReplyTo: string | null;
  MessageStream: string;
}

// Every Postmark send this file made, decoded. lib/email.ts is the REAL
// implementation throughout -- only the fetch it makes is stubbed, which is
// the one thing that leaves the machine -- so these are the exact bodies
// Postmark would have received.
function postmarkSends(): PostmarkPayload[] {
  return fetchMock.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string) as PostmarkPayload);
}

function makeCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } satisfies ExecutionContext;
}

// The registration from routes/admin/index.ts:261-263, on a sub-app gated by
// the real requireAdminAuth (index.ts:85) and grafted onto a parent with
// app.route("/admin", ...) (index.ts:637), whose notFound is the real
// APPEND_SLASH probe (index.ts:650-654).
//
// All four are load-bearing and a flat app reproduces none of them:
// c.notFound() -- which loadOrderForEmail and adminOrderDelete both reach for
// a missing order -- does NOT stop at the sub-app, it resolves to the
// PARENT's handler, and that handler re-dispatches the request through this
// same router. It is also what makes "a GET to the delete URL is not a route"
// answerable at all: without the parent, an unregistered method would produce
// Hono's bare default rather than the site's 404.
//
// Registered with the METHODS index.ts registers, which is the point of the
// GET-to-delete test below -- adminOrderDelete exists on POST only.
//
// `real: true` swaps the replica for the IMPORTED adminApp -- the router that
// actually ships, mounted the same way. The replica stays the default because
// it is what makes the c.notFound() counterfactual expressible without
// dragging in every other admin page's module graph; the real router is used
// where the question is "and is that what the application does?", which a
// hand-copy of three lines can never answer about itself. Seven sibling
// suites (crawlSet.test.ts, articles.test.ts, jobs.test.ts and friends)
// import adminApp the same way, so this is the house pattern.
//
// THE PRICE, stated rather than discovered: adminApp's module graph reaches
// @givefood/templates' env.ts and src/generated/precompiled, a gitignored
// build artefact. This file already depended on that (it renders the real
// email templates), so nothing new is owed -- `pnpm typecheck` and `pnpm test`
// both run the precompile.
function buildApp(options: { real?: boolean } = {}) {
  const replica = new Hono<AppEnv>();
  replica.use("*", requireAdminAuth);
  replica.get("/order/:orderId/email/", adminOrderEmailPreview);
  replica.post("/order/:orderId/sendnotification/", adminOrderSendNotification);
  replica.post("/order/:orderId/delete/", adminOrderDelete);

  const app = new Hono<AppEnv>();
  app.route("/admin", options.real ? adminApp : replica);
  app.notFound(async (c) => {
    const redirect = await tryAppendSlashRedirect(c, app);
    return redirect ?? c.html("<html>the real 404 page</html>", 404);
  });
  // Surfaced and labelled rather than left to become an unhandled rejection,
  // so a regression reads as "expected 302, got 500: <message>" instead of a
  // vitest crash. Nothing in this file expects a 500.
  app.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));
  return app;
}

interface Options {
  signedIn?: boolean;
  /** The value of the hidden csrf_token form field; omit the key for none. */
  csrfToken?: string | null;
  /** The __Host-csrf cookie's raw half, before it is signed. */
  csrfCookieRaw?: string | null;
  origin?: string | null;
  /** Dispatch through the imported adminApp instead of the replica. */
  realRouter?: boolean;
}

async function csrfCookie(raw: string): Promise<string> {
  return `__Host-csrf=${raw}.${await hmacSha256Hex(CSRF_SECRET, raw)}`;
}

async function headersFor(options: Options): Promise<Record<string, string>> {
  const { signedIn = true, csrfCookieRaw = CSRF_RAW } = options;
  const cookies: string[] = [];
  if (signedIn) cookies.push(SESSION_COOKIE);
  if (csrfCookieRaw !== null) cookies.push(await csrfCookie(csrfCookieRaw));
  const headers: Record<string, string> = { "Sec-Fetch-Site": "same-origin" };
  if (cookies.length > 0) headers.Cookie = cookies.join("; ");
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin !== null) headers.Origin = origin;
  return headers;
}

async function post(path: string, options: Options = {}): Promise<Response> {
  const { csrfToken = CSRF_RAW } = options;
  const body = new URLSearchParams(csrfToken === null ? {} : { csrf_token: csrfToken });
  return buildApp({ real: options.realRouter }).fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { ...(await headersFor(options)), "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }),
    env,
    makeCtx(),
  );
}

async function get(path: string, options: Options = {}): Promise<Response> {
  return buildApp({ real: options.realRouter }).fetch(new Request(`${ORIGIN}${path}`, { headers: await headersFor(options) }), env, makeCtx());
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  sqlLog = { ran: [] };
  postmarkStatus = 200;

  // Postmark, and nothing else -- lib/email.ts's fetch is the only outbound
  // call any of these three handlers makes. Asserted on rather than merely
  // silenced: what reaches Postmark IS the deliverable of
  // adminOrderSendNotification, so a handler that redirected with
  // ?donenotification=true having sent an empty body would otherwise pass.
  fetchMock = vi.fn(async (input: unknown) => {
    const url = typeof input === "string" ? input : String((input as Request).url);
    if (!url.startsWith("https://api.postmarkapp.com/")) throw new Error(`unexpected outbound fetch to ${url}`);
    return new Response(postmarkStatus === 200 ? JSON.stringify({ ErrorCode: 0, Message: "OK" }) : "Inactive recipient", {
      status: postmarkStatus,
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  env = {
    DB: { withSession: () => d1Session(db, sqlLog) },
    // The shape lib/adminAuth.ts's getAdminSession reads back out of KV.
    // expiresAt is a full TTL ahead of now, which puts the session at the
    // START of its window -- getAdminSession only slides the TTL forward past
    // the halfway point, and a KV write on every request here would be noise
    // in the "this GET wrote nothing" assertions.
    SESSIONS: {
      get: async (key: string) =>
        key === SESSION_KV_KEY
          ? JSON.stringify({
              email: "someone@givefood.org.uk",
              name: "Some One",
              givenName: "Some",
              picture: "",
              expiresAt: Date.now() + 12 * 60 * 60 * 1000,
            })
          : null,
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    },
    CSRF_SECRET,
    POSTMARK_TOKEN,
  } as unknown as AppEnv["Bindings"];
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});

// The standard scenario, seeded once per test that wants it: one food bank,
// one order with three lines, and a SECOND order on the same food bank with a
// line of its own. The second order exists only to be left alone -- a DELETE
// that dropped its `WHERE order_id = ?` and a lines query that dropped its
// own would both pass every test that seeds a single order.
function seedStandard(): void {
  seedFoodbank(db, { id: SALISBURY, name: "Salisbury", slug: "salisbury", lastOrder: DELIVERY_DATE });
  seedOrder(db, { id: ORDER_ROW, orderId: ORDER_ID, foodbankId: SALISBURY });
  seedOrder(db, { id: OTHER_ORDER_ROW, orderId: OTHER_ORDER_ID, foodbankId: SALISBURY, deliveryDate: "2026-08-22" });
  // Inserted lightest-first on purpose: `ORDER BY weight DESC, id` has to do
  // the reordering, and a fixture already in the right order would let a
  // dropped ORDER BY pass.
  seedLine(db, 501, ORDER_ROW, "Tea Bags", 1, 250);
  seedLine(db, 502, ORDER_ROW, "Baked Beans", 2, 830);
  seedLine(db, 503, ORDER_ROW, "Long Life Milk", 6, 6000);
  seedLine(db, 599, OTHER_ORDER_ROW, "Should Never Appear", 9, 9999);
}

// ===========================================================================
// The registration in routes/admin/index.ts:261-263 -- checked, not copied
// ===========================================================================

// buildApp() above is a HAND-COPY of three lines of routes/admin/index.ts,
// and a hand-copy is a second truth: every other assertion in this file is
// about a router this file built, so every one of them stays green while the
// application that actually ships registers these handlers on other methods,
// at other paths, or behind no auth at all.
//
// One edit in particular matters, because it is the exact defect this port
// was written to fix. Django's order_delete has no @require_POST (contrast
// order_send_notification at views.py:494) and CsrfViewMiddleware is
// commented out in production, so a bare GET destroys an order -- a
// prefetching browser, a link checker, an <img src>. "has no GET route: a
// bare GET destroys nothing" below asserts that of the REPLICA. Adding
// `adminApp.get("/order/:orderId/delete/", adminOrderDelete)` to index.ts
// reintroduces the whole defect in one line, in a file this suite otherwise
// never loads, and was run as a mutant: every other test in this file passed.
// The five below assert it of the app that ships.
describe("the routes routes/admin/index.ts really registers", () => {
  // Hono keeps its registration table on `app.routes`, in registration order.
  const orderActionRoutes = () => adminApp.routes.filter((route) => route.path.startsWith("/order/:orderId/"));

  it("mounts each of the three handlers on exactly one method and one path", () => {
    const mounted = (handler: unknown) =>
      orderActionRoutes()
        .filter((route) => (route.handler as unknown) === handler)
        .map((route) => `${route.method} ${route.path}`);

    expect(mounted(adminOrderDelete)).toEqual(["POST /order/:orderId/delete/"]);
    expect(mounted(adminOrderSendNotification)).toEqual(["POST /order/:orderId/sendnotification/"]);
    expect(mounted(adminOrderEmailPreview)).toEqual(["GET /order/:orderId/email/"]);
  });

  // The other direction, which the assertion above cannot make: that nothing
  // ELSE answers at these two URLs. A GET registered at the delete path
  // pointing at some other handler -- a "confirm delete?" page that grew a
  // side effect, say -- would leave the list above untouched.
  it("answers the two mutating URLs on POST and nothing else", () => {
    const methodsAt = (path: string) =>
      adminApp.routes
        .filter((route) => route.path === path)
        .map((route) => route.method)
        .sort();

    expect(methodsAt("/order/:orderId/delete/")).toEqual(["POST"]);
    expect(methodsAt("/order/:orderId/sendnotification/")).toEqual(["POST"]);
    expect(methodsAt("/order/:orderId/email/")).toEqual(["GET"]);
  });

  // Django's LoginRequiredAccess, and the reason every "without a session"
  // test below is worth anything: the gate is a single `use("*", ...)` at the
  // top of the sub-app (index.ts:85), so it covers routes registered after it
  // -- which is all of them -- and only if it is genuinely FIRST. Asserted
  // positionally for that reason, not merely as "present somewhere".
  it("gates the whole admin sub-app on requireAdminAuth, before any route", () => {
    const [first] = adminApp.routes;

    expect(first!.method).toBe("ALL");
    expect(first!.path).toBe("/*");
    expect((first!.handler as unknown) === requireAdminAuth).toBe(true);
  });

  // The registration table says which handler is mounted where; DISPATCHING
  // says what the running application does with a request, which is not the
  // same claim. An `adminApp.all("/order/*", ...)` or a `use()` registered
  // above these three -- a confirm-page, a rate limiter, an audit shim --
  // would leave every assertion above true and still take the request. So the
  // delete is driven end to end through the shipped router once, with the row
  // read back out of SQLite, exactly as the replica tests do it.
  it("deletes through the shipped router, not just through the replica", async () => {
    seedStandard();
    const res = await post(`/admin/order/${ORDER_ID}/delete/`, { realRouter: true });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/");
    expect(orderRow(db)).toBeUndefined();
    expect(orderLines(db)).toEqual([]);
    expect(orderRow(db, OTHER_ORDER_ROW)).toBeDefined();
  });

  // And the counterfactual, through the same router: the GET that destroys an
  // order in Django. Not 404 here -- the real app's own notFound (which this
  // parent does not install) is not in play -- but nothing is deleted, which
  // is the whole claim.
  it("destroys nothing on a GET to the delete URL through the shipped router", async () => {
    seedStandard();
    const res = await get(`/admin/order/${ORDER_ID}/delete/`, { realRouter: true });

    expect(res.status).toBe(404);
    expect(orderRow(db)).toBeDefined();
    expect(orderLines(db)).toHaveLength(3);
    expect(writes()).toEqual([]);
  });
});

// ===========================================================================
// adminOrderSendNotification -- POST /admin/order/:orderId/sendnotification/
// gfadmin/views.py:494-521
// ===========================================================================

describe("adminOrderSendNotification", () => {
  const PATH = `/admin/order/${ORDER_ID}/sendnotification/`;

  describe("the gates in front of it", () => {
    // requireAdminAuth (middleware/adminAuth.ts), Django's LoginRequiredAccess.
    // The status is the half that is easy to get right; that NOTHING HAPPENED
    // is the half worth asserting, because a handler reached before the gate
    // would have sent the email and stamped the row before returning the 302.
    it("does not reach the handler at all without a session", async () => {
      seedStandard();
      const res = await post(PATH, { signedIn: false });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(`/auth/?next=${encodeURIComponent(PATH)}`);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(orderRow(db)!.notification_email_sent).toBeNull();
    });

    // CSRF is checked BEFORE the order is even looked up (orderActions.ts:
    // 101-103), which is the correct order: a forged cross-site POST should
    // not get to probe which order ids exist by the shape of the response.
    it("refuses a POST with no CSRF field, and sends nothing", async () => {
      seedStandard();
      const res = await post(PATH, { csrfToken: null });

      expect(res.status).toBe(403);
      expect(await res.text()).toBe("Forbidden");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(orderRow(db)!.notification_email_sent).toBeNull();
      expect(orderRow(db)!.modified).toBe(MODIFIED);
    });

    it("refuses a CSRF field that does not match the cookie", async () => {
      seedStandard();
      const res = await post(PATH, { csrfToken: "b".repeat(64) });

      expect(res.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(orderRow(db)!.notification_email_sent).toBeNull();
    });

    // The signed half of the double-submit: a token an attacker planted from a
    // sibling subdomain carries no HMAC this secret produces, so echoing it in
    // both cookie and field must still fail.
    it("refuses a cookie whose signature does not verify", async () => {
      seedStandard();
      const forged = "c".repeat(64);
      const res = await buildApp().fetch(
        new Request(`${ORIGIN}${PATH}`, {
          method: "POST",
          headers: {
            Cookie: `${SESSION_COOKIE}; __Host-csrf=${forged}.${"0".repeat(64)}`,
            Origin: ORIGIN,
            "Sec-Fetch-Site": "same-origin",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ csrf_token: forged }).toString(),
        }),
        env,
        makeCtx(),
      );

      expect(res.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(orderRow(db)!.notification_email_sent).toBeNull();
    });

    it("refuses a cross-origin POST even with a valid token pair", async () => {
      seedStandard();
      const res = await post(PATH, { origin: "https://evil.invalid" });

      expect(res.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(orderRow(db)!.notification_email_sent).toBeNull();
    });

    // THE ORDER OF TWO LINES, asserted. The comment above says CSRF is checked
    // before the order is looked up; nothing proved it, because a forgery at
    // an order that EXISTS is refused either way. The proof has to use an id
    // that does not: check-then-load answers 403 for every id, load-then-check
    // answers 404 for the ones that are absent and 403 for the ones that are
    // present -- which turns a URL anyone's browser can be made to POST into
    // an oracle for "does this order id exist?", answered with no token at
    // all, and (order ids being `<foodbank-slug>-<date>`) for "did this food
    // bank get a delivery that day?".
    //
    // MUTANT: moving the three CSRF lines below the loadOrderForEmail call
    // survived all 59 tests -- the forgery was still refused, so every other
    // gate test passed. This is the one that fails.
    it("refuses a forged POST at a nonexistent order with 403, never a 404 that reveals it is absent", async () => {
      seedStandard();
      const res = await post("/admin/order/no-such-order/sendnotification/", { csrfToken: null });

      expect(res.status).toBe(403);
      expect(await res.text()).toBe("Forbidden");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    // The same URL with no method registered on it. adminOrderSendNotification
    // is POST-only in both the replica and index.ts (asserted above), so a GET
    // -- a prefetch, a link checker, an admin pasting the URL -- must not mail
    // a food bank a delivery notification.
    it("has no GET route: a bare GET mails nobody", async () => {
      seedStandard();
      const res = await get(PATH);

      expect(res.status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(orderRow(db)!.notification_email_sent).toBeNull();
      expect(writes()).toEqual([]);
    });
  });

  describe("orders it declines to email", () => {
    it("404s an order id that does not exist, without sending", async () => {
      seedStandard();
      const res = await post(`/admin/order/no-such-order/sendnotification/`);

      expect(res.status).toBe(404);
      expect(res.headers.get("Location")).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    // views.py:500-501's silent redirect, with no message -- every line of
    // both email templates dereferences the food bank, so an unassigned order
    // has nothing to render. Note the ABSENCE of a query param: this is not
    // the ?donenotification=true success redirect wearing a disguise, and a
    // handler that fell through to it would look identical in the browser.
    it("redirects an unassigned order back to itself, sending nothing", async () => {
      seedOrder(db, { id: ORDER_ROW, orderId: "gf-unassigned-1201-tesco-2026-09-05", foodbankId: null });
      const res = await post(`/admin/order/gf-unassigned-1201-tesco-2026-09-05/sendnotification/`);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/admin/order/gf-unassigned-1201-tesco-2026-09-05/");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(orderRow(db)!.notification_email_sent).toBeNull();
    });

    // An order whose foodbank_id points at a row that is no longer there.
    // getOrderDetail LEFT JOINs, so foodbank_slug comes back NULL and the
    // handler takes the SAME "unassigned" branch -- it never reaches the
    // getFoodbankBySlug miss its own `if (!foodbank) return c.notFound()`
    // line is written for. Pinned as the behaviour it has (a redirect, not a
    // 404, and no email) rather than as the behaviour the code reads like.
    it("treats a dangling foodbank_id as unassigned rather than 404ing", async () => {
      seedOrder(db, { id: ORDER_ROW, orderId: ORDER_ID, foodbankId: 999 });
      const res = await post(PATH);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(`/admin/order/${ORDER_ID}/`);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("the send itself", () => {
    it("redirects to the order with views.py:520's ?donenotification=true", async () => {
      seedStandard();
      const res = await post(PATH);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(`/admin/order/${ORDER_ID}/?donenotification=true`);
    });

    // views.py:506-508 and :512-513, as one assertion so a payload that got
    // half of it right cannot pass. The Cc is a real address that receives
    // every one of these: dropping it silently stops the deliveries inbox
    // seeing what went out.
    it("hands Postmark the recipient, Cc and subject Django built", async () => {
      seedStandard();
      await post(PATH);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [sent] = postmarkSends();
      expect(sent!.To).toBe("info@salisburyfoodbank.org.uk");
      expect(sent!.Cc).toBe("deliveries@givefood.org.uk");
      expect(sent!.Subject).toBe(`Food donation from Give Food (${ORDER_ID})`);
      expect(sent!.From).toBe("mail@givefood.org.uk");
    });

    // views.py:506-508 is `to = contact_email` then `if notification_email:
    // to = notification_email` -- so notification_email WINS when it has a
    // value. A food bank that has set one has done so specifically to keep
    // delivery mail out of its general inbox.
    it("prefers notification_email over contact_email", async () => {
      seedFoodbank(db, {
        id: SALISBURY,
        name: "Salisbury",
        slug: "salisbury",
        contactEmail: "info@salisburyfoodbank.org.uk",
        notificationEmail: "deliveries@salisburyfoodbank.org.uk",
      });
      seedOrder(db, { id: ORDER_ROW, orderId: ORDER_ID, foodbankId: SALISBURY });
      await post(PATH);

      expect(postmarkSends()[0]!.To).toBe("deliveries@salisburyfoodbank.org.uk");
    });

    // The port spells that as `notification_email || contact_email`, and ||
    // is falsy-based where Django's `if` is truthiness on a string: both fall
    // back for "" as well as for NULL, which is what an admin who cleared the
    // field expects. Asserted because a `??` here would send delivery mail to
    // the empty string instead.
    it("falls back to contact_email when notification_email is blank, not just null", async () => {
      seedFoodbank(db, { id: SALISBURY, name: "Salisbury", slug: "salisbury", notificationEmail: "" });
      seedOrder(db, { id: ORDER_ROW, orderId: ORDER_ID, foodbankId: SALISBURY });
      await post(PATH);

      expect(postmarkSends()[0]!.To).toBe("info@salisburyfoodbank.org.uk");
    });

    // THE WRITE ACTUALLY HAPPENED. #34 was a form field parsed, threaded
    // through the handler and written by no SQL at all, redirecting as though
    // it had worked -- the redirect above proves nothing on its own, so the
    // row is read back here.
    it("stamps notification_email_sent, in the migrated timestamp format", async () => {
      seedStandard();
      await post(PATH);

      const stamped = orderRow(db)!.notification_email_sent as string;
      const modified = orderRow(db)!.modified as string;
      // d1Timestamp's shape, not toISOString's: `orders` timestamps are
      // sorted against migrated Postgres rows byte-wise, and "T" (0x54) sorts
      // above " " (0x20), so an ISO value would order inconsistently with
      // every row beside it. See orderWrite.ts:33-46.
      expect(stamped).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
      expect(modified).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
      expect(modified).not.toBe(MODIFIED);
      // NOT asserted equal to each other, deliberately, and this is not
      // fussiness: the handler reads the clock once (orderActions.ts:135's
      // `d1Timestamp()`) and setOrderNotificationSent reads it AGAIN for
      // `modified` (orderWrite.ts:377), so the two columns come from two
      // separate `new Date()` calls and land a millisecond apart often
      // enough to fail a `toBe`. `modified` is therefore the later of the
      // two, never the earlier -- byte-wise string order is chronological
      // for this format, which is the entire reason the format exists.
      expect(modified >= stamped).toBe(true);
    });

    // THE REASON setOrderNotificationSent EXISTS. Django's views.py:518-519
    // stamps the timestamp and then calls the full order.save(), which
    // re-runs the paid Gemini parse and DELETES AND RECREATES every OrderLine
    // -- at temperature=1, so the regenerated lines can differ from what was
    // actually ordered. Pressing "send email" could therefore rewrite the
    // order's contents. This is that not happening, asserted against the rows
    // rather than against the SQL text, so it survives any rewrite of the
    // statement that keeps the effect.
    it("leaves the order's lines and aggregates completely alone", async () => {
      seedStandard();
      const linesBefore = orderLines(db);
      const before = orderRow(db)!;
      await post(PATH);
      const after = orderRow(db)!;

      expect(orderLines(db)).toEqual(linesBefore);
      expect(after.weight).toBe(before.weight);
      expect(after.calories).toBe(before.calories);
      expect(after.no_items).toBe(before.no_items);
      expect(after.no_lines).toBe(before.no_lines);
      expect(after.cost).toBe(before.cost);
      expect(after.items_text).toBe(before.items_text);
      expect(after.created).toBe(CREATED); // an edit that restamped this moves the deliveries dashboard's history
      expect(after.foodbank_id).toBe(SALISBURY);
    });

    // Sending a notification must not touch the food bank either: Django's
    // order.save() also recomputes and re-saves foodbank.last_order
    // (orders.py:213-216) as a side effect of the same save() call.
    it("leaves the food bank row alone", async () => {
      seedStandard();
      const before = foodbankRow(db)!;
      await post(PATH);

      expect(foodbankRow(db)).toEqual(before);
    });

    // The rest of the outbound payload, which no other assertion here looks
    // at. MessageStream decides which Postmark stream is billed and rate
    // limited, and "broadcast" mail to a food bank's own inbox would be the
    // wrong one; ReplyTo has to stay null specifically because lib/email.ts
    // DIVERTS the whole send to mail+testemail@givefood.org.uk when replyTo is
    // "test@example.com" (email.ts:52-57, kept deliberately for the public
    // /write/ form), so a future caller threading a food bank's own address
    // through replyTo would open that diversion on delivery notifications.
    it("sends on the outbound stream, with no Bcc and no Reply-To", async () => {
      seedStandard();
      await post(PATH);

      const [sent] = postmarkSends();
      expect(sent!.MessageStream).toBe("outbound");
      expect(sent!.Bcc).toBeNull();
      expect(sent!.ReplyTo).toBeNull();
    });

    // NO ALREADY-SENT GUARD, pinned because the button gives no hint of one.
    // Django has none either (views.py:518 stamps unconditionally), so this
    // is parity rather than a defect -- but the consequence is worth writing
    // down: pressing "Send Notification" on an order whose page already shows
    // the green "Sent" tick mails the food bank a SECOND copy and overwrites
    // the timestamp, so the record of when they were first told is gone. The
    // confirm() dialog on order.njk:104 is the only thing standing in front
    // of it.
    it("sends again and overwrites the stamp when pressed twice", async () => {
      seedStandard();
      await post(PATH);
      const first = orderRow(db)!.notification_email_sent as string;

      const res = await post(PATH);

      expect(res.status).toBe(302);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const second = orderRow(db)!.notification_email_sent as string;
      expect(second >= first).toBe(true);
      expect(orderRow(db)!.notification_email_sent).not.toBeNull();
    });

    // SUSPECT, pinned rather than fixed, and the sharpest thing in this file:
    // an order with no lines yet is emailed as an EMPTY DELIVERY. This window
    // exists only in the port. Django parsed the items synchronously inside
    // Order.save() (models/orders.py:97-225), so an order always had its lines
    // by the time the admin saw the page; here upsertOrder re-zeroes
    // weight/calories/cost/no_lines/no_items on every save (orderWrite.ts:
    // 292-297) and an "order-lines" queue job fills them back in afterwards.
    // order.njk:92-107 renders the Send Notification button whenever the order
    // has a food bank, with no reference to job_status -- so an admin who
    // saves an order and immediately presses Send mails the food bank "It
    // contains 0 items, weighs about 0 kg, and contains 0 calories" over an
    // empty item list, and the green tick then says it was notified.
    //
    // Asserted as the behaviour it HAS: the send goes through, Postmark is
    // called, and the row is stamped. If a job-status guard is ever added this
    // test fails, which is the correct outcome -- it is the record that the
    // hole was known, not an endorsement of it.
    it("cheerfully emails an order whose lines have not been parsed yet", async () => {
      seedFoodbank(db, { id: SALISBURY, name: "Salisbury", slug: "salisbury" });
      // Exactly the row upsertOrder leaves behind between the redirect and the
      // queue job finishing: aggregates zeroed, not one orderline.
      seedOrder(db, { id: ORDER_ROW, orderId: ORDER_ID, foodbankId: SALISBURY, weight: 0, calories: 0 });
      db.prepare("UPDATE orders SET no_items = 0, no_lines = 0 WHERE id = ?").run(ORDER_ROW);

      const res = await post(PATH);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(`/admin/order/${ORDER_ID}/?donenotification=true`);
      const [sent] = postmarkSends();
      expect(sent!.TextBody).toContain("It contains 0 items, weighs about 0 kg, and contains 0 calories");
      expect(sent!.TextBody).toContain("Items:\n\n");
      expect(orderRow(db)!.notification_email_sent).not.toBeNull();
    });

    // order_id is interpolated straight into the redirect, so it is encoded.
    // Today's generator produces slug-safe ids (models/orders.py:209), but
    // the ids in the database are 15 years of imported data and the admin can
    // type one by hand in the order form.
    it("percent-encodes an order id with characters a URL would swallow", async () => {
      seedFoodbank(db, { id: SALISBURY, name: "Salisbury", slug: "salisbury" });
      seedOrder(db, { id: ORDER_ROW, orderId: "odd order/id?x", foodbankId: SALISBURY });
      const res = await post(`/admin/order/${encodeURIComponent("odd order/id?x")}/sendnotification/`);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/admin/order/odd%20order%2Fid%3Fx/?donenotification=true");
    });
  });

  // The deliberate divergence from Django, and the whole reason lib/email.ts
  // returns a boolean at all. Django discards send_email()'s result and
  // stamps regardless, so a Postmark outage leaves a green "Sent" tick on an
  // email that never left -- and nobody ever presses the button again,
  // because it looks done.
  describe("when Postmark refuses it", () => {
    // SUSPECT, pinned rather than fixed: `notificationfailed` is written here
    // and read NOWHERE -- grep finds the string only at orderActions.ts:126,
    // and admin/order.njk's banner block (lines 13-25) keys off job_status
    // alone. So the admin presses Send, the page comes back with the red
    // "x Not Sent" it already had, and nothing anywhere says the send was
    // attempted and refused. The half this port genuinely fixed is that the
    // order is NOT stamped, so the button can be pressed again and the food
    // bank is not recorded as told when it was not; the signal that it needs
    // pressing again is still missing. Asserted on the Location so that the
    // param survives to be rendered the day something renders it.
    it("redirects with ?notificationfailed=true and does NOT stamp the order", async () => {
      seedStandard();
      postmarkStatus = 422;
      const res = await post(PATH);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(`/admin/order/${ORDER_ID}/?notificationfailed=true`);
      // The whole point: the button can simply be pressed again.
      expect(orderRow(db)!.notification_email_sent).toBeNull();
      expect(orderRow(db)!.modified).toBe(MODIFIED);
    });

    // lib/email.ts returns false without calling fetch when the token is
    // missing, so an unconfigured environment takes the identical path. Worth
    // its own test because it is the state a fresh preview deployment is in,
    // and "the email silently did not send but the tick is green" is exactly
    // what would be shipped if the boolean were ignored.
    it("takes the same path when POSTMARK_TOKEN is unset, without an outbound call", async () => {
      seedStandard();
      env = { ...env, POSTMARK_TOKEN: "" } as unknown as AppEnv["Bindings"];
      const res = await post(PATH);

      expect(res.headers.get("Location")).toBe(`/admin/order/${ORDER_ID}/?notificationfailed=true`);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(orderRow(db)!.notification_email_sent).toBeNull();
    });

    // Postmark's own definition of success is "any 2xx"; Django's
    // send_email() checks `status_code == 200` exactly, which lib/email.ts
    // matched rather than "improved". A 202 is therefore a FAILURE here.
    // Pinned because it is a divergence from the API being called, not from
    // the code being ported, and reads like a bug until you know that.
    it("counts a 202 as a failure, matching Django's exact-200 check", async () => {
      seedStandard();
      postmarkStatus = 202;
      const res = await post(PATH);

      expect(res.headers.get("Location")).toBe(`/admin/order/${ORDER_ID}/?notificationfailed=true`);
      expect(orderRow(db)!.notification_email_sent).toBeNull();
    });
  });
});

// ===========================================================================
// adminOrderEmailPreview -- GET /admin/order/:orderId/email/
// gfadmin/views.py:2537-2551, which 500s on every request in Django (it
// renders "emails/order.%s", and the only templates on disk resolve as
// "admin/emails/order.*"). Pointed at the real templates here, so everything
// below is behaviour Django never actually served -- the parity claim is
// against the TEMPLATES, which are ported line for line, not against the view.
// ===========================================================================

// The complete text body seedStandard() produces, transcribed from a real
// render rather than composed by hand. Nineteen context values, the two
// templates' literal prose, and the exact whitespace of an email body -- the
// blank lines are part of what a food bank receives, so they are part of what
// is pinned. Used by "renders the whole text body, byte for byte" below; the
// HTML half is not goldened the same way because it is asserted against the
// SEND's HtmlBody instead ("previews exactly what the send would put in the
// email"), which is the claim that half exists to support.
const GOLDEN_TEXT_BODY = `Hello Salisbury Food Bank,

Give Food are sending you an internet shopping delivery via Tesco. The delivery information is below. In the meantime, if you have any suggestions for how we can improve our deliveries do contact us via the following...

Web: https://www.givefood.org.uk
Twitter: https://twitter.com/GiveFoodCharity
Facebook: https://www.facebook.com/GiveFoodOrgUK
Email: mail@givefood.org.uk


Your Information
================

We're automatically monitoring your shopping list for changes at:
https://salisbury.foodbank.org.uk/give-help/donate-food/

We also used the information provided here to help with picking items for the order:
https://example.invalid/shopping-list

The details we have for your food bank are over here:
https://www.givefood.org.uk/needs/at/salisbury/


Delivery Details
================

Our order ID: salisbury-2026-09-05
Tesco order ID: TESCO-99887

The delivery is scheduled for Saturday, Sept. 5, 2026 between 23:00 and 24:00.

It contains 42 items, weighs about 30 kg, and contains 123,456 calories - although this may vary based on availability.

We've given Tesco your phone number 01722 349556.

To:
Salisbury Food Bank
Unit 1
Churchfields Road
SP2 7NP

Items:
6x Long Life Milk
2x Baked Beans
1x Tea Bags



Give Food is charity number 1188192, registered in England & Wales.`;

describe("adminOrderEmailPreview", () => {
  const PATH = `/admin/order/${ORDER_ID}/email/`;

  it("does not reach the handler at all without a session", async () => {
    seedStandard();
    const res = await get(PATH, { signedIn: false });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/auth/?next=${encodeURIComponent(PATH)}`);
  });

  // THE GET THAT SHARES A CODE PATH WITH A POST. loadOrderForEmail and
  // buildOrderEmailContext are called by both this handler and the send, and
  // the send stamps a timestamp -- so a refactor that hoisted the stamp into
  // the shared helper would turn every preview, every link-checker hit and
  // every browser prefetch of this URL into a write that says the food bank
  // was notified. Asserted as the ABSENCE OF STATEMENTS, not as unchanged
  // rows: an UPDATE writing back the value already there changes no column an
  // assertion could see.
  it("issues no writes at all", async () => {
    seedStandard();
    const before = orderRow(db)!;
    const beforeLines = orderLines(db);
    await get(PATH);

    expect(writes()).toEqual([]);
    expect(orderRow(db)).toEqual(before);
    expect(orderLines(db)).toEqual(beforeLines);
    expect(foodbankRow(db)!.modified).toBe(MODIFIED);
  });

  describe("format selection (views.py:2541-2549)", () => {
    it("serves text/plain with no format param", async () => {
      seedStandard();
      const res = await get(PATH);

      expect(res.status).toBe(200);
      // Hono's c.text() spells this WITHOUT a space after the semicolon
      // while c.html() spells it WITH one (see the ?format=html test below) --
      // both legal per RFC 9110 and both what Hono emits today. Asserted
      // exactly rather than loosely so that the thing being pinned is the
      // BRANCH: views.py:2541-2549 gives "html" text/html and everything else
      // text/plain, and a `toContain("text/plain")` would also pass on
      // "text/plain" arriving where text/html was meant.
      expect(res.headers.get("Content-Type")).toBe("text/plain;charset=UTF-8");
      const body = await res.text();
      expect(body).toContain("Hello Salisbury Food Bank,");
      expect(body).not.toContain("<html>");
    });

    it("serves text/html for ?format=html", async () => {
      seedStandard();
      const res = await get(`${PATH}?format=html`);

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
      const body = await res.text();
      expect(body).toContain("<p>Hello Salisbury Food Bank,</p>");
      // The shared email shell (templates/emails/page.njk) really is wrapped
      // around it -- the HTML half `{% extends %}`es it, and a body block
      // rendered on its own would still contain the paragraph above.
      expect(body).toContain("<!doctype html>");
    });

    // "html" EXACTLY, or text/plain. Django compares the string, so every
    // other value -- including the plausible "HTML" and the plausible "txt"
    // -- falls to the else branch. Pinned so that "helpfully" case-folding it
    // later is a visible decision rather than a quiet one.
    it.each(["txt", "HTML", "", "json"])("serves text/plain for ?format=%s", async (format) => {
      seedStandard();
      const res = await get(`${PATH}?format=${format}`);

      expect(res.headers.get("Content-Type")).toBe("text/plain;charset=UTF-8");
      expect(await res.text()).not.toContain("<!doctype html>");
    });
  });

  describe("the same two branches the send takes", () => {
    it("404s an order id that does not exist", async () => {
      seedStandard();
      const res = await get("/admin/order/no-such-order/email/");

      expect(res.status).toBe(404);
      // A Location here would mean the parent's APPEND_SLASH probe had fired
      // and 301'd a miss into a redirect loop; the path already ends in "/",
      // so it must not.
      expect(res.headers.get("Location")).toBeNull();
    });

    // Django's order_email has NO unassigned guard at all -- it would raise
    // an AttributeError chain and 500. This port borrows the send's guard.
    it("redirects an unassigned order back to itself", async () => {
      seedOrder(db, { id: ORDER_ROW, orderId: "gf-unassigned-1201-tesco-2026-09-05", foodbankId: null });
      const res = await get("/admin/order/gf-unassigned-1201-tesco-2026-09-05/email/");

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/admin/order/gf-unassigned-1201-tesco-2026-09-05/");
    });
  });

  // buildOrderEmailContext is not exported, so these drive it through the
  // route -- which is the more useful claim anyway: the values a food bank
  // reads in its inbox, not the shape of a dictionary.
  describe("the values the food bank actually reads", () => {
    it("names the delivery day, date, hour window and quantities", async () => {
      seedStandard();
      const body = await (await get(PATH)).text();

      // `|date:"l"`, computed in JS because DATE_FORMAT_TOKENS has D
      // (abbreviated) but no `l` -- 2026-09-05 is a Saturday.
      // `|date:"N j, Y"` is Django's AP-style month: "Sept.", not "Sep.".
      // 23 + 1 = 24 with NO WRAP, which is Order.delivery_hour_end()'s plain
      // `+ 1` (models/orders.py:71-72) reproduced rather than corrected.
      expect(body).toContain("The delivery is scheduled for Saturday, Sept. 5, 2026 between 23:00 and 24:00.");
      // weight: 25000g -> 25 * 1.18 = 29.5 -> floatformat:"0" -> "30".
      // calories: |intcomma.
      expect(body).toContain("It contains 42 items, weighs about 30 kg, and contains 123,456 calories");
    });

    it("uses delivery_phone_number when there is one, and the main number when there is not", async () => {
      seedFoodbank(db, { id: SALISBURY, name: "Salisbury", slug: "salisbury", phoneNumber: "01722 349556" });
      seedOrder(db, { id: ORDER_ROW, orderId: ORDER_ID, foodbankId: SALISBURY });
      expect(await (await get(PATH)).text()).toContain("We've given Tesco your phone number 01722 349556.");

      db.exec("DELETE FROM foodbank");
      seedFoodbank(db, {
        id: SALISBURY,
        name: "Salisbury",
        slug: "salisbury",
        phoneNumber: "01722 349556",
        deliveryPhoneNumber: "07700 900123",
      });
      expect(await (await get(PATH)).text()).toContain("We've given Tesco your phone number 07700 900123.");
    });

    // order.txt:38-39 -- delivery_address REPLACES the address+postcode pair
    // rather than being appended to it. A food bank with a separate delivery
    // address has one because the registered address is not where a van can
    // go; printing both would send the driver to the wrong place.
    it("prints the delivery address instead of the postal one when set", async () => {
      seedFoodbank(db, {
        id: SALISBURY,
        name: "Salisbury",
        slug: "salisbury",
        address: "Unit 1\nChurchfields Road",
        postcode: "SP2 7NP",
        deliveryAddress: "Rear entrance, 14 Estate Way",
      });
      seedOrder(db, { id: ORDER_ROW, orderId: ORDER_ID, foodbankId: SALISBURY });
      const body = await (await get(PATH)).text();

      expect(body).toContain("Rear entrance, 14 Estate Way");
      expect(body).not.toContain("Churchfields Road");
      expect(body).not.toContain("SP2 7NP");
    });

    it("falls back to address and postcode when there is no delivery address", async () => {
      seedStandard();
      const body = await (await get(PATH)).text();

      expect(body).toContain("Unit 1\nChurchfields Road\nSP2 7NP");
    });

    // order.txt:36-39's `{% if order.source_url %}` -- an order picked from a
    // food bank's own posted list cites it, one picked from the shopping list
    // alone must not carry a dangling "We also used the information provided
    // here" with nothing after it.
    it("cites source_url only when the order has one", async () => {
      seedStandard();
      expect(await (await get(PATH)).text()).toContain("We also used the information provided here");

      db.exec("DELETE FROM orders");
      seedOrder(db, { id: ORDER_ROW, orderId: ORDER_ID, foodbankId: SALISBURY, sourceUrl: null });
      expect(await (await get(PATH)).text()).not.toContain("We also used the information provided here");
    });

    // getOrderLinesByWeight is `ORDER BY weight DESC, id` -- Order.lines()'s
    // `order_by("-weight")` (models/orders.py:227-228). The fixture is
    // inserted lightest-first, so a dropped ORDER BY reverses this list.
    it("lists the items heaviest first, and only this order's", async () => {
      seedStandard();
      const body = await (await get(PATH)).text();

      expect(body).toContain("6x Long Life Milk\n2x Baked Beans\n1x Tea Bags\n");
      // Seeded on the OTHER order. A lines query that lost its
      // `WHERE order_id = ?` puts another delivery's items in this email.
      expect(body).not.toContain("Should Never Appear");
    });

    // The two bodies genuinely differ, in Django too, and both are kept as
    // they are: the HTML table has a Kg column (`|floatformat:2`) and the
    // text version shows no weight at all. Asserted together so that
    // "helpfully" harmonising them is a decision someone has to make.
    it("shows per-line weights in the HTML body and none in the text one", async () => {
      seedStandard();
      const html = await (await get(`${PATH}?format=html`)).text();
      const text = await (await get(PATH)).text();

      expect(html).toContain("<td>Long Life Milk</td><td>6</td><td>6.00</td>");
      expect(html).toContain("<td>Tea Bags</td><td>1</td><td>0.25</td>");
      expect(text).toContain("6x Long Life Milk");
      expect(text).not.toContain("6.00");
    });

    // The text body is text/plain, so it is wrapped in
    // {% autoescape false %}: a food bank called "Ann's & Sons" must not
    // arrive in a human's inbox as "Ann&#39;s &amp; Sons". The HTML sibling
    // keeps autoescaping on, deliberately dropping Django's `|safe` -- a
    // stray "<" in a food-bank-supplied name would otherwise break the mail.
    // Both directions asserted, because each is the other's bug.
    it("leaves ampersands and apostrophes literal in text and escapes them in HTML", async () => {
      seedFoodbank(db, { id: SALISBURY, name: "Ann's & Sons", slug: "salisbury" });
      seedOrder(db, { id: ORDER_ROW, orderId: ORDER_ID, foodbankId: SALISBURY });

      expect(await (await get(PATH)).text()).toContain("Hello Ann's & Sons Food Bank,");
      const html = await (await get(`${PATH}?format=html`)).text();
      expect(html).toContain("Hello Ann&#39;s &amp; Sons Food Bank,");
      expect(html).not.toContain("Hello Ann's & Sons Food Bank,");
    });

    // orderline.weight is nullable and really is NULL on old imported rows,
    // so this is what a food bank sees for one. Pinned as the RENDERED
    // OUTPUT, not as the `?? 0` in orderActions.ts:78 -- that coalesce is
    // belt-and-braces rather than load-bearing, because JavaScript's own
    // `null / 1000` is already 0 and `.toFixed(2)` already "0.00" (removing
    // the `??` was run as a mutant and killed nothing, which is the honest
    // reason this comment does not claim it prevents a NaN). What the test
    // does catch is the column changing meaning: a "?" placeholder, a blank
    // cell, or the row being dropped from the table altogether.
    it("renders a line with no recorded weight as 0.00", async () => {
      seedFoodbank(db, { id: SALISBURY, name: "Salisbury", slug: "salisbury" });
      seedOrder(db, { id: ORDER_ROW, orderId: ORDER_ID, foodbankId: SALISBURY });
      seedLine(db, 501, ORDER_ROW, "Mystery Item", 3, null);

      const html = await (await get(`${PATH}?format=html`)).text();
      expect(html).toContain("<td>Mystery Item</td><td>3</td><td>0.00</td>");
      expect(html).not.toContain("NaN");
      expect(await (await get(PATH)).text()).toContain("3x Mystery Item");
    });

    // orderActions.ts:71's `Number.isNaN(deliveryDay.getTime()) ? "" : ...`
    // guard, which nothing else reaches. `orders.delivery_date` is TEXT, and
    // while the order form validates what it writes, fifteen years of
    // imported rows are not covered by that form. The guard turns a value
    // Date cannot parse into an empty weekday instead of the literal
    // "Invalid Date", and the template's own date filter independently
    // renders the date itself as empty -- so the email goes out at 200 with a
    // gap in the sentence rather than 500ing or naming a day that is not the
    // delivery day. Ugly and preferable to both alternatives; pinned so a
    // future "tidy-up" of the guard has to face what it is standing in for.
    it("leaves the weekday blank for a delivery date Date cannot parse, rather than 500ing", async () => {
      seedFoodbank(db, { id: SALISBURY, name: "Salisbury", slug: "salisbury" });
      seedOrder(db, { id: ORDER_ROW, orderId: ORDER_ID, foodbankId: SALISBURY, deliveryDate: "not-a-date" });

      const res = await get(PATH);
      const body = await res.text();

      expect(res.status).toBe(200);
      expect(body).toContain("The delivery is scheduled for ,  between 23:00 and 24:00.");
      expect(body).not.toContain("Invalid Date");
      expect(body).not.toContain("NaN");
    });

    // EVERY VALUE THE TEMPLATE READS, IN ONE BODY -- and the reason it is
    // here rather than as four more fragments above.
    //
    // buildOrderEmailContext hands the two templates nineteen values --
    // sixteen under `order`, three beside it (orderActions.ts:50-79). The
    // tests above name the ones with an obvious consequence (the slot, the
    // weight, the address, the items) and, before this test existed, FOUR of
    // the others could be deleted or swapped for each other with the whole
    // file still green. That is #34's shape moved inside the email: a value
    // parsed, threaded through the handler, and read back by no assertion
    // anywhere. Every one of these was run as a mutant and survived:
    //
    //   foodbank_shopping_list_url -> "" : the "we're monitoring your shopping
    //     list at" line goes out blank, and the food bank cannot tell which
    //     list we are watching or correct it.
    //   foodbank_slug -> order.order_id : "the details we have for your food
    //     bank are over here" points at /needs/at/salisbury-2026-09-05/, a
    //     404, on every notification.
    //   order_id <-> delivery_provider_id : the food bank quotes Give Food's
    //     reference at Tesco and Tesco's at Give Food -- the two ids in the
    //     email exist precisely so a missing delivery can be chased.
    //   delivery_provider_id -> "" : "Tesco order ID:" with nothing after it.
    //
    // Asserted as the whole body, byte for byte, so the NEXT field added to
    // the context is covered by construction rather than by someone
    // remembering to add a fragment. The cost is that any deliberate change
    // to order_text.njk fails here once and has to be re-approved, which is
    // the correct price for the only email these handlers exist to send.
    it("renders the whole text body, byte for byte, over every field the context carries", async () => {
      seedStandard();
      const body = await (await get(PATH)).text();

      expect(body).toBe(GOLDEN_TEXT_BODY);
    });

    // The HTML half builds three of those same values into ANCHORS -- href
    // and link text, from one context value each. The text golden above
    // cannot see the href: order.njk could lose it (or point every link at
    // the shopping list) and the plain-text body would be untouched. These
    // are the three links a food bank actually clicks.
    it("builds the food-bank-specific links as anchors in the HTML body", async () => {
      seedStandard();
      const html = await (await get(`${PATH}?format=html`)).text();

      expect(html).toContain(
        '<a href="https://salisbury.foodbank.org.uk/give-help/donate-food/">https://salisbury.foodbank.org.uk/give-help/donate-food/</a>',
      );
      expect(html).toContain('<a href="https://example.invalid/shopping-list">https://example.invalid/shopping-list</a>');
      expect(html).toContain(
        '<a href="https://www.givefood.org.uk/needs/at/salisbury/">https://www.givefood.org.uk/needs/at/salisbury/</a>',
      );
      // The two references, which the HTML body carries in prose rather than
      // in a link -- same swap the golden body pins for the text half.
      expect(html).toContain(`<p>Our order ID: ${ORDER_ID}<br>`);
      expect(html).toContain("Tesco order ID: TESCO-99887</p>");
    });

    // "One shared context builder for the real send and the browser preview,
    // so what the preview shows is byte-identical to what actually goes out"
    // (orderActions.ts:40-43). That is the entire justification for
    // buildOrderEmailContext existing as a function, and it is a claim about
    // two different handlers producing the same bytes -- so it is asserted by
    // running both and comparing, not by observing that they call the same
    // helper. A preview that quietly diverges is worse than no preview: it is
    // what the maintainer checks before pressing send.
    it("previews exactly what the send would put in the email", async () => {
      seedStandard();
      const previewText = await (await get(PATH)).text();
      const previewHtml = await (await get(`${PATH}?format=html`)).text();
      await post(`/admin/order/${ORDER_ID}/sendnotification/`);
      const [sent] = postmarkSends();

      expect(sent!.TextBody).toBe(previewText);
      expect(sent!.HtmlBody).toBe(previewHtml);
    });
  });
});

// ===========================================================================
// adminOrderDelete -- POST /admin/order/:orderId/delete/
// gfadmin/views.py:524-528
// ===========================================================================

describe("adminOrderDelete", () => {
  const PATH = `/admin/order/${ORDER_ID}/delete/`;

  describe("the gates Django does not have", () => {
    // THE DEFECT THIS HANDLER WAS PORTED TO FIX. Django's order_delete has no
    // @require_POST (contrast order_send_notification at views.py:494) and
    // CsrfViewMiddleware is commented out in production (settings.py:97), so
    // a bare GET to this URL destroys an order and all its lines -- a
    // prefetching browser, a link checker, or an <img src="..."> on any page
    // an admin happens to visit. Here there is no GET route at all, so the
    // request falls through to the site's 404 with the order still there.
    it("has no GET route: a bare GET destroys nothing", async () => {
      seedStandard();
      const res = await get(PATH);

      expect(res.status).toBe(404);
      expect(orderRow(db)).toBeDefined();
      expect(orderLines(db)).toHaveLength(3);
    });

    // THE SLASHLESS SPELLING, which is the shape a link checker or a
    // hand-typed URL actually arrives in. app.notFound() runs
    // tryAppendSlashRedirect, which re-dispatches the URL plus a slash as a
    // HEAD through this same router and 301s if the probe is anything but
    // 404/501 -- so the question this test answers is whether a GET to the
    // delete URL can destroy an order by any route at all. It cannot: the
    // 301 carries no body anywhere, and following it lands on the slashed
    // URL, which has no GET route and 404s with the order still there.
    //
    // SUSPECT, pinned rather than fixed, because it is a 301 and not a
    // deletion. The probe is built as a bare Request with no cookies
    // (appendSlash.ts:27), so requireAdminAuth answers it with the 302 to
    // /auth/ BEFORE the router ever decides whether the path exists -- and
    // 302 is not 404, so the redirect fires. Every slashless URL under
    // /admin/ therefore 301s, whether or not anything is registered at it:
    // the third assertion here is a path invented on the spot, and it
    // redirects too. The admin 404 page is unreachable without a trailing
    // slash. Harmless for this handler; noted because a future reader will
    // otherwise read the 301 below as evidence that a GET delete route
    // exists.
    it("301s the slashless URL to a slashed one that deletes nothing", async () => {
      seedStandard();
      const res = await get(`/admin/order/${ORDER_ID}/delete`);

      expect(res.status).toBe(301);
      expect(res.headers.get("Location")).toBe(`${ORIGIN}${PATH}`);
      expect(orderRow(db)).toBeDefined();
      expect(orderLines(db)).toHaveLength(3);

      // Following it by hand, which is what the browser does next.
      const followed = await get(PATH);
      expect(followed.status).toBe(404);
      expect(orderRow(db)).toBeDefined();
      expect(orderLines(db)).toHaveLength(3);

      // The probe cannot distinguish "registered" from "gated", so this
      // made-up sibling of the same URL redirects identically.
      expect((await get(`/admin/order/${ORDER_ID}/nosuchaction`)).status).toBe(301);
    });

    it("does not reach the handler at all without a session", async () => {
      seedStandard();
      const res = await post(PATH, { signedIn: false });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(`/auth/?next=${encodeURIComponent(PATH)}`);
      expect(orderRow(db)).toBeDefined();
      expect(orderLines(db)).toHaveLength(3);
    });

    it("refuses a POST with no CSRF field, and deletes nothing", async () => {
      seedStandard();
      const res = await post(PATH, { csrfToken: null });

      expect(res.status).toBe(403);
      expect(await res.text()).toBe("Forbidden");
      expect(orderRow(db)).toBeDefined();
      expect(orderLines(db)).toHaveLength(3);
      // Not even the food bank's derived last_order was recomputed.
      expect(writes()).toEqual([]);
    });

    it("refuses a CSRF field that does not match the cookie", async () => {
      seedStandard();
      const res = await post(PATH, { csrfToken: "b".repeat(64) });

      expect(res.status).toBe(403);
      expect(orderRow(db)).toBeDefined();
      expect(writes()).toEqual([]);
    });

    it("refuses a cross-origin POST even with a valid token pair", async () => {
      seedStandard();
      const res = await post(PATH, { origin: "https://evil.invalid" });

      expect(res.status).toBe(403);
      expect(orderRow(db)).toBeDefined();
    });

    // As on the send: the CSRF check sits ABOVE the getOrderDetail call
    // (orderActions.ts:179-184), and only an id that does not exist can tell
    // the two orderings apart. Load-then-check leaves a delete URL that
    // answers 404 for an absent order and 403 for a real one, to a request
    // carrying no token whatsoever -- an existence oracle on the whole orders
    // table for anyone who can make a logged-in admin's browser POST.
    //
    // MUTANT: moving the CSRF lines below `getOrderDetail` + `if (!order)`
    // survived all 59 tests. Nothing is deleted either way, which is why the
    // rest of this block could not see it.
    it("refuses a forged POST at a nonexistent order with 403, never a 404 that reveals it is absent", async () => {
      seedStandard();
      const res = await post("/admin/order/no-such-order/delete/", { csrfToken: null });

      expect(res.status).toBe(403);
      expect(await res.text()).toBe("Forbidden");
      expect(writes()).toEqual([]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM orders").get()).toEqual({ n: 2 });
    });
  });

  it("404s an order id that does not exist, deleting nothing", async () => {
    seedStandard();
    const res = await post("/admin/order/no-such-order/delete/");

    expect(res.status).toBe(404);
    expect(res.headers.get("Location")).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM orders").get()).toEqual({ n: 2 });
    expect(writes()).toEqual([]);
  });

  describe("the delete itself", () => {
    it("redirects to admin:index, as views.py:528 does", async () => {
      seedStandard();
      const res = await post(PATH);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/admin/");
    });

    // models/orders.py:89-95 Order.delete() -- lines first, then the order.
    // Read back rather than inferred from the 302: a redirect is not evidence
    // of a delete any more than it was evidence of a save in #34. The other
    // order's line is the control: a DELETE that lost its `WHERE order_id = ?`
    // empties the whole table and every assertion about THIS order still
    // passes.
    it("removes the order and its lines, and only its lines", async () => {
      seedStandard();
      await post(PATH);

      expect(orderRow(db)).toBeUndefined();
      expect(orderLines(db)).toEqual([]);
      expect(orderRow(db, OTHER_ORDER_ROW)).toBeDefined();
      expect(orderLines(db, OTHER_ORDER_ROW)).toHaveLength(1);
    });

    // orderline.order_id is the INTEGER orders.id, while orders.order_id is
    // the TEXT human id -- two columns, one name, two tables. A handler that
    // passed the URL's order_id where the row id belongs deletes no lines at
    // all and leaves them orphaned, pointing at an order that no longer
    // exists. The assertion above cannot tell those apart if the lines happen
    // to be gone for another reason, so the whole table is counted here.
    it("leaves no orphaned lines behind", async () => {
      seedStandard();
      await post(PATH);

      expect(db.prepare("SELECT id, order_id FROM orderline ORDER BY id").all()).toEqual([{ id: 599, order_id: OTHER_ORDER_ROW }]);
    });

    // SUSPECT, pinned rather than fixed, and found while reviewing this file
    // rather than while writing it. `orders.order_id` is the TEXT human id all
    // three handlers look an order up by, and NOTHING makes it unique:
    // migrations/0005_orders_and_charity.sql:20 declares it `TEXT NOT NULL`
    // with no unique constraint and no index of its own, and Django's field is
    // a bare `CharField(max_length=100)` (models/orders.py:29). The generator
    // really can collide -- `gf-<slug>-<provider>-<date>` (models/orders.py:107)
    // is the same string for two orders placed with the same provider, for the
    // same food bank, for the same delivery day, which is what a split
    // delivery is.
    //
    // Django and this port then diverge. `get_object_or_404(Order, order_id=id)`
    // (views.py:525) raises MultipleObjectsReturned on a collision -- a 500,
    // loud and impossible to miss. getOrderDetail ends in `.first()` over an
    // unordered SELECT, so this handler silently takes whichever row SQLite
    // hands back: the admin presses Delete on the order they are looking at,
    // one of the two disappears, and nothing tells them which. The send path
    // has the identical shape -- it mails and stamps an arbitrary one of them.
    //
    // Asserted as COUNTS, never identities: which row `.first()` returns is
    // implementation-defined, and pinning that would pin SQLite rather than
    // this handler. What is pinned is the divergence -- a 302 and exactly one
    // dead order where Django gives a 500 and none.
    it("deletes exactly one of two orders sharing an order_id, rather than 500ing on the collision", async () => {
      seedFoodbank(db, { id: SALISBURY, name: "Salisbury", slug: "salisbury", lastOrder: DELIVERY_DATE });
      seedOrder(db, { id: ORDER_ROW, orderId: ORDER_ID, foodbankId: SALISBURY });
      seedOrder(db, { id: OTHER_ORDER_ROW, orderId: ORDER_ID, foodbankId: SALISBURY });
      seedLine(db, 501, ORDER_ROW, "Tea Bags", 1, 250);
      seedLine(db, 599, OTHER_ORDER_ROW, "Baked Beans", 2, 830);

      const res = await post(PATH);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/admin/");
      // One dies, one survives -- and the survivor keeps its own line, which
      // is the part that would break if the DELETE were keyed on the TEXT
      // order_id both rows share instead of the INTEGER row id.
      expect(db.prepare("SELECT COUNT(*) AS n FROM orders").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM orderline").get()).toEqual({ n: 1 });
    });
  });

  // NOT IN DJANGO. Order.delete() (orders.py:89-95) never touches
  // last_order, so deleting a food bank's most recent order leaves it
  // advertising a delivery date it no longer has -- on its public page, in
  // the API, and in every "when did this food bank last get a delivery"
  // report. This port recomputes it.
  describe("foodbank.last_order, which Django leaves stale", () => {
    it("falls back to the next most recent delivery date", async () => {
      seedStandard();
      expect(foodbankRow(db)!.last_order).toBe(DELIVERY_DATE);
      await post(PATH);

      // MAX(delivery_date) over what remains -- the other order's date.
      expect(foodbankRow(db)!.last_order).toBe("2026-08-22");
    });

    // A recompute that took "the first remaining row" rather than the MAX
    // would pass the test above by luck, because the surviving order happens
    // to be the only one. Deleting a NON-latest order must leave last_order
    // exactly where it was.
    it("is unchanged when the deleted order was not the latest", async () => {
      seedStandard();
      const res = await post(`/admin/order/${OTHER_ORDER_ID}/delete/`);

      expect(res.status).toBe(302);
      expect(foodbankRow(db)!.last_order).toBe(DELIVERY_DATE);
    });

    it("becomes NULL when the food bank has no orders left", async () => {
      seedFoodbank(db, { id: SALISBURY, name: "Salisbury", slug: "salisbury", lastOrder: DELIVERY_DATE });
      seedOrder(db, { id: ORDER_ROW, orderId: ORDER_ID, foodbankId: SALISBURY });
      await post(PATH);

      expect(foodbankRow(db)!.last_order).toBeNull();
    });

    // The recompute is `WHERE id = ?` on one food bank and MAX over that food
    // bank's orders. A dropped predicate on either side rewrites every food
    // bank's last_order from one delete -- 3,000+ rows, silently, with no
    // error and nothing to compare against afterwards.
    it("touches no other food bank", async () => {
      seedStandard();
      seedFoodbank(db, { id: BRIXTON, name: "Brixton", slug: "brixton", lastOrder: "2026-07-01" });
      const before = foodbankRow(db, BRIXTON)!;
      await post(PATH);

      expect(foodbankRow(db, BRIXTON)).toEqual(before);
    });

    // `modified` moves because the row changed; `edited` must NOT, because it
    // means "a human edited this food bank" and last_order is derived. The
    // admin's own "oldest edited food bank" queue is driven off `edited`, so
    // stamping it here would quietly reorder that queue on every delete.
    it("restamps modified but not edited", async () => {
      seedStandard();
      const before = foodbankRow(db)!;
      await post(PATH);
      const after = foodbankRow(db)!;

      expect(after.modified).not.toBe(before.modified);
      expect(after.modified).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
      expect(after.edited).toBe(before.edited);
    });

    // `if (order.foodbank_id)` guards the recompute. An unassigned order has
    // no food bank to recompute, and this asserts the STATEMENT is never
    // issued rather than that no column changed -- an `UPDATE foodbank SET
    // last_order = (SELECT MAX(...) WHERE foodbank_id = NULL)` would write
    // NULL over a real date on whichever row it matched, or none, and either
    // way a row-count assertion sees nothing.
    it("issues no foodbank UPDATE at all for an unassigned order", async () => {
      seedFoodbank(db, { id: SALISBURY, name: "Salisbury", slug: "salisbury", lastOrder: DELIVERY_DATE });
      seedOrder(db, { id: ORDER_ROW, orderId: "gf-unassigned-1201-tesco-2026-09-05", foodbankId: null });
      seedLine(db, 501, ORDER_ROW, "Tea Bags", 1, 250);
      const res = await post("/admin/order/gf-unassigned-1201-tesco-2026-09-05/delete/");

      expect(res.status).toBe(302);
      expect(orderRow(db)).toBeUndefined();
      expect(orderLines(db)).toEqual([]);
      expect(sqlLog.ran.some((s) => /UPDATE\s+foodbank/i.test(s.sql))).toBe(false);
      expect(foodbankRow(db)!.last_order).toBe(DELIVERY_DATE);
    });
  });
});

