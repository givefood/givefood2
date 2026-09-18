import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS_SQL as SCHEMA } from "@givefood/db/src/schema.testkit";
import type { Env } from "../../worker-configuration";
import { handleOrderLinesJob } from "./orderLines";
// @ts-ignore -- this Worker's tsconfig lists only @cloudflare/workers-types, so
// node:sqlite has no declarations here. It is real under vitest's node
// environment, and adding "node" to workers/jobs/tsconfig.json would be a
// config change rather than a test change. Same suppression, same reasoning, as
// packages/db/src/schema.testkit.ts:35 and notify/needEmail.test.ts:5.
import { DatabaseSync } from "node:sqlite";

// adminJobs/orderLines.ts -- the queue half of Order.save(). The admin's order
// form writes the `orders` row and enqueues this; everything after Django's
// `super().save()` (givefood/models/orders.py:126-215) happens here: ask Gemini
// to parse items_text into lines, price and weigh them, look up calories and a
// category per line, delete the old lines, write the new ones, set the five
// aggregates on the order, and restamp the food bank's last_order.
//
// WHY THIS FILE IS WORTH THE LENGTH. Nobody watches this run. It is triggered
// by a form POST that has already returned 200 to the admin, and its ONLY
// visible output is a row in `admin_job` that a polling page renders. Every
// failure mode it has is therefore quiet, and three of them are quiet in a way
// that looks like success:
//
//   * it catches everything and records it on the job row, so queues/jobs.ts
//     ACKS the message -- no retry, no dead-letter entry, no error in the
//     Workers dashboard. A permanently invalid GEMINI_API_KEY produces one
//     `admin_job.error` string per order and nothing else anywhere. That is
//     the exact shape of the Browser Rendering credential that broke silently
//     for a day.
//   * the model can return two lines for a nine-line order and the handler
//     will happily write two, zero the rest of the aggregates, and mark the
//     job `done`. Nothing compares the parse against the input.
//   * a line whose shape does not match is dropped SILENTLY by isAiOrderLine,
//     so a single stringly-typed quantity removes an item from the order and
//     from every downstream total (the deliveries dashboard, the order
//     notification email, /api/2/orders/) with no trace at all.
//
// The numbers this writes are the numbers the public site reports as food
// donated: `orders.weight`, `.calories`, `.cost`, `.no_lines`, `.no_items`.
// An arithmetic slip here is a wrong figure on a correct-looking page, which
// is the failure this whole tier exists for.
//
// REAL THINGS, NOT MOCKS. node:sqlite carrying the whole real migration set,
// the real @givefood/db queries (getOrderForLineParse, getOrderItemCalories,
// getLatestOrderLineCategory, deleteOrderLines, insertOrderLines,
// setOrderAggregates, recomputeFoodbankLastOrder, markAdminJob*), and the REAL
// geminiJsonCall from ../lib/gemini. Only `fetch` is stubbed -- which is the
// only thing here that leaves the machine -- so the request body asserted below
// is the request body Google would really have received, prompt and schema and
// temperature included, and the retry/timeout behaviour under test is the
// module's own rather than a stand-in's.
//
// THE SCHEMA COMES FROM THE MIGRATIONS. MIGRATIONS_SQL rather than
// schemaFor(...) because this handler reaches five tables through nine shared
// packages/db functions, and the whole point of the shared testkit is that a
// query which starts reading one more object does not silently break a suite
// whose fixture predates it (github #51). The full schema cannot have that gap.
//
// MUTATION-TESTED, in four passes: two by the author and two more by an
// adversarial review that re-ran the author's own list before adding to it. The
// repo was copied to a scratch directory OUTSIDE it, orderLines.ts,
// lib/gemini.ts and the packages/db queries this handler drives were broken 119
// different ways in that copy, and this file re-run against each -- the
// evidence that these tests are load-bearing rather than decoration. 117 died;
// the two that survived are equivalent and are named at the bottom of this
// comment.
//
// THE REVIEW PASS FOUND SIX REAL HOLES, all now closed, and each is named in
// the comment of the test that closes it so the next reader knows what that
// test is for:
//   * `void markAdminJobDone(...)` and `void setOrderAggregates(...)` -- a
//     dropped `await` on a write. Invisible to a harness whose statements
//     answered synchronously; see tick() below, which is why every statement
//     now takes several turns to land.
//   * `void deleteOrderLines(...)` -- same class, killed by making the DELETE
//     fail rather than by timing.
//   * `markAdminJobRunning(db, jobId + "x")` -- nothing looked at the job row
//     mid-flight, only at the shape of the statement that wrote it.
//   * markAdminJobRunning matched on `kind` instead of `id` -- nothing seeded a
//     second admin_job row that had to be left alone.
//   * markAdminJobDone clearing `error` -- no test drove a failure and a
//     recovery through the same job row.
// The review also added the malformed-message section (no `orderRowId`, NaN, a
// stringly id, and an admin_job row that does not exist), which nothing
// covered: queues/jobs.ts hands this handler whatever the message contains.
//
// Killed across the four passes: the per-item/per-line weight
// and cost confusions in both directions, item_cost and line_cost swapped,
// calories multiplied by the line weight instead of the per-item weight,
// calories rounded instead of truncated, the calorie and category lookups done
// on the encoded name, `&amp;` decoded first, `&#039;` and `&apos;` dropped from
// the entity table, `&nbsp;` decoded to U+00A0, the whole unescape removed, the
// delete moved back before the loop (Django's own order) or removed entirely,
// lines inserted against the TEXT order_id, the delivery date not denormalised,
// group_name filled from the category, every aggregate transposed or summed
// from the wrong variable, the food bank guard dropped or tested against
// undefined, the restamp removed, the array guard removed, a non-array reply
// marked done, the missing-order return dropped, both failure messages
// reworded, every field dropped from isAiOrderLine (and the whole guard
// short-circuited to `true`), Math.trunc replaced by Math.round on both
// quantity and calories, markAdminJobRunning and markAdminJobDone removed, the
// session mode changed to first-primary, the aggregates written before the
// lines, the empty-key guard weakened to `=== undefined`, errors rethrown out
// of the catch, temperature 0, a different model, two prompt paragraphs
// deleted, the prompt html-escaped the way Django's template engine does it,
// the response schema's `required` removed, the safety settings emptied, the
// thinking budget raised, the API key left unencoded, and the 5xx retry removed.
//
// The review pass added, and killed: the loop reduced to `aiLines.slice(0, 1)`
// and `slice(0, -1)`, the filter bypassed entirely, both per-line lookups
// hoisted onto the first line's name or swapped in order, every remaining
// dropped `await`, the job marked done before the restamp, insert before
// delete, the key checked before the order read, the running write moved after
// it, `String(err)` instead of `err.message`, the catch silently swallowing,
// the result payload's keys renamed or its item count replaced by the line
// count, an early return for an empty parse, and -- in the packages/db queries
// this handler drives -- the DELETE's WHERE dropped, the category backfill
// reordered ASC or its emptiness filter removed, the calorie lookup turned into
// a LIKE, MAX(delivery_date) turned into MIN or unscoped from the food bank,
// `edited` stamped alongside `modified`, insertOrderLines' item_cost/line_cost
// binds transposed and its delivery_date nulled, setOrderAggregates'
// noLines/noItems binds transposed and its `modified` stamp dropped,
// getOrderForLineParse ignoring its argument or dropping delivery_date from its
// projection, markAdminJobDone dropping `finished` or clearing `error`,
// markAdminJobRunning matched on `kind`, and markAdminJobFailed writing an ISO
// timestamp where Django's spelling is what sorts correctly in TEXT.
//
// TWO MUTANTS SURVIVE AND ARE EQUIVALENT, not holes, and both are stated where
// they occur below rather than quietly omitted:
//   * `noLines: lines.length` -> `aiLines.length`. `lines` gets exactly one
//     push per `aiLine` with no early continue, so the two lengths are equal by
//     construction and no fixture can separate them.
//   * `per100g === null ? 0 : ...` -> a falsy check. Zero times any finite
//     weight and quantity is zero, so both spellings store 0 for a
//     zero-calorie item.
//
// PARITY CLAIMS WERE EXECUTED, not remembered. Against the Django actually
// installed at /Users/jasoncartwright/Sites/foodcharity (5.2.6, printed by
// django.get_version()):
//   * `html.unescape` was run on every string the port's htmlUnescape claims to
//     handle, plus the ones it does not -- see the entity block below.
//   * `render_to_string("admin/prompts/orderline_prompt.txt", ...)` was run and
//     its output compared with buildOrderLinePrompt's, which is how the
//     autoescape divergence below is stated as fact rather than as a guess.
//   * `IntegerField.get_prep_value` was read out of the installed package
//     (`inspect.getsource`) to confirm it is `int(value)`, i.e. truncation
//     toward zero, which is what the calories assertions rest on.
// All three were RE-RUN during the review pass rather than taken on trust:
// django.get_version() prints 5.2.6, html.unescape answers exactly what the
// entity block below says it does (`a&nbsp;b` -> `'a\xa0b'` included),
// render_to_string over the real template produces the prompt asserted below
// byte for byte and escapes it to "Sainsbury&#x27;s Tea &amp; Coffee
// &lt;500g&gt;" when the items text contains markup, and get_prep_value's body
// really is `int(value)` (django/db/models/fields/__init__.py in the installed
// 3.13 site-packages). Nothing else here cites Django behaviour that was not
// read directly out of models/orders.py or utils/text.py.

// ===========================================================================
// HARNESS
// ===========================================================================

type Bindable = null | number | bigint | string;

interface SqliteDatabase {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): {
    get(...params: Bindable[]): Record<string, unknown> | undefined;
    all(...params: Bindable[]): Record<string, unknown>[];
    run(...params: Bindable[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  };
}

interface FakeStatement {
  sql: string;
  params: Bindable[];
  bind(...values: unknown[]): FakeStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }>;
  run(): Promise<{ success: boolean; meta: Record<string, unknown> }>;
}

/** One outbound Gemini call, decoded. */
interface GeminiCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: {
    contents: Array<{ parts: Array<{ text: string }> }>;
    generationConfig: {
      temperature: number;
      responseMimeType: string;
      responseSchema: unknown;
      thinkingConfig: { thinkingBudget: number };
    };
    safetySettings: Array<{ category: string; threshold: string }>;
  };
}

/** What a run of the handler did to the outside world. */
interface Harness {
  env: Env;
  /** Every SQL statement issued, in order, raw. */
  sql: string[];
  /** The same statements classified, interleaved with the Gemini calls -- see shape(). */
  steps: string[];
  fetches: GeminiCall[];
  /** The mode string passed to DB.withSession(), per call. */
  sessionModes: string[];
}

let db: SqliteDatabase;

// NO STATEMENT RESOLVES IN THE TURN IT WAS ISSUED IN. Every method on the fake
// session below yields a few times before it touches SQLite, because a real D1
// statement is a network round trip and cannot answer synchronously either.
//
// This is what makes a DROPPED `await` visible, and it is the reason the delay
// is here rather than in any one test. With a harness that answered
// synchronously, changing `await markAdminJobDone(...)` to a bare call left the
// row updated anyway and every assertion in this file still passed: both
// mutants -- `void markAdminJobDone(...)` and `void setOrderAggregates(...)` --
// survived a full mutation run for exactly that reason. In the Workers runtime
// a floating write from a queue consumer can be discarded the moment the
// handler returns, which here means an order whose aggregates never land and a
// job row stuck on `running` while the admin's page polls it forever.
//
// MICROTASKS, not setTimeout or setImmediate. freezeClock(true) fakes
// setTimeout for the retry tests, and those tests drive the handler by
// advancing fake time: a real macrotask hop between statements would not be
// flushed by advanceTimersByTimeAsync, so the handler would never reach the
// fetch whose 60-second sleep the advance is meant to skip, and the test would
// hang. Microtasks are drained by every await, faked timers included. Three
// hops is one more than the two an awaiting caller consumes, which is what
// puts a floating write strictly after the handler's own resolution.
async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// The D1 Sessions API surface packages/db uses, over the real engine. It
// carries SQL to node:sqlite and records it, and interprets nothing: a session
// that answered canned rows would be a second implementation of the very
// queries under test, and the calorie/category lookups below are entirely
// about which row SQLite picks.
//
// bind() returns a NEW statement rather than mutating, matching D1's immutable
// prepared statements -- a harness that mutated in place would let the last
// line of an order quietly overwrite every earlier line's bindings and turn a
// 40-item batch into 40 copies of item 40.
//
// batch() runs inside a transaction, because D1's does; insertOrderLines is
// built as one batch precisely so a half-written order is unreachable.
//
// first() answers null, never undefined: getOrderForLineParse's caller tests
// `if (!order)`, and getOrderItemCalories distinguishes null (no such item)
// from 0 (an item with no calories).
function d1Session(h: { sql: string[]; steps: string[] }, failOn: RegExp | null): unknown {
  const record = (sql: string): void => {
    h.sql.push(sql);
    h.steps.push(shape(sql));
    if (failOn?.test(sql)) throw new Error("D1_ERROR: Network connection lost");
  };

  const statement = (sql: string, params: Bindable[]): FakeStatement => ({
    sql,
    params,
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T,>() => {
      await tick();
      record(sql);
      return (db.prepare(sql).get(...params) ?? null) as T | null;
    },
    all: async <T,>() => {
      await tick();
      record(sql);
      return { results: db.prepare(sql).all(...params) as T[], success: true, meta: {} };
    },
    run: async () => {
      await tick();
      record(sql);
      const info = db.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    },
  });

  return {
    prepare: (sql: string) => statement(sql, []),
    async batch(statements: FakeStatement[]) {
      await tick();
      for (const s of statements) record(s.sql);
      db.exec("BEGIN");
      try {
        const results = statements.map((s) => {
          const info = db.prepare(s.sql).run(...s.params);
          return { success: true, results: [], meta: { changes: Number(info.changes) } };
        });
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    getBookmark: () => null,
  };
}

// Every statement this handler can issue, classified. An assertion on the
// classified sequence is readable AND total: a statement nobody anticipated
// comes back as "UNCLASSIFIED: ..." and fails the ordering tests loudly rather
// than slipping past a `toContain`.
const STATEMENT_SHAPES: Array<[RegExp, string]> = [
  [/^UPDATE admin_job SET status = 'running'/, "job:running"],
  [/^UPDATE admin_job SET status = 'done'/, "job:done"],
  [/^UPDATE admin_job SET status = 'failed'/, "job:failed"],
  [/^SELECT id, order_id, items_text/, "read:order"],
  [/^SELECT calories FROM orderitem/, "read:calories"],
  [/^SELECT category FROM orderline/, "read:category"],
  [/^DELETE FROM orderline/, "write:delete-lines"],
  [/^INSERT INTO orderline/, "write:insert-line"],
  [/^UPDATE orders SET weight/, "write:aggregates"],
  [/^UPDATE foodbank SET last_order/, "write:last-order"],
];

function shape(sql: string): string {
  const flat = sql.replace(/\s+/g, " ").trim();
  for (const [pattern, label] of STATEMENT_SHAPES) if (pattern.test(flat)) return label;
  return `UNCLASSIFIED: ${flat}`;
}

interface HarnessOptions {
  /** Defaults to a key containing characters encodeURIComponent must escape. */
  apiKey?: string;
  /** The JSON value the model "returns". Ignored when `reply` is given. */
  lines?: unknown;
  /** The raw HTTP reply, for the failure shapes `lines` cannot express. */
  reply?: (call: GeminiCall) => Response | Promise<Response>;
  /** Make every D1 statement matching this throw, standing in for a replica blip. */
  failSql?: RegExp;
}

// Gemini's real success envelope: the JSON lives as a STRING inside
// candidates[0].content.parts[0].text, which is why geminiJsonCall does its own
// JSON.parse of the part rather than reading a structured field.
function geminiEnvelope(payload: unknown): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }), { status: 200 });
}

function harness(options: HarnessOptions = {}): Harness {
  const sql: string[] = [];
  const steps: string[] = [];
  const fetches: GeminiCall[] = [];
  const sessionModes: string[] = [];

  // Any URL other than Gemini's throws rather than returning a default: an
  // outbound call this handler grows later must fail loudly here, not be
  // absorbed by a permissive stub.
  vi.stubGlobal("fetch", async (url: string, init: RequestInit): Promise<Response> => {
    if (!url.startsWith("https://generativelanguage.googleapis.com/")) throw new Error(`unmodelled fetch: ${url}`);
    const call: GeminiCall = { url, method: init.method, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
    fetches.push(call);
    steps.push("fetch:gemini");
    if (options.reply) return await options.reply(call);
    return geminiEnvelope(options.lines ?? DEFAULT_AI_LINES);
  });

  const env = {
    DB: {
      withSession: (mode: string) => {
        sessionModes.push(mode);
        return d1Session({ sql, steps }, options.failSql ?? null);
      },
    },
    GEMINI_API_KEY: options.apiKey ?? API_KEY,
  } as unknown as Env;

  return { env, sql, steps, fetches, sessionModes };
}

// ===========================================================================
// FIXTURES
// ===========================================================================

// The spelling Django and the ETL write: a SPACE separator and six fractional
// digits, never a "T" and never a "Z". These columns are TEXT and SQLite
// compares TEXT bytewise, which is why migration 0022 had to go back and
// rewrite the ISO-spelled rows. Seeding toISOString() here would be testing a
// database this Worker does not have.
const EARLIER = "2026-08-30 09:14:22.117000";

// The instant every write in this file is frozen at, and its stored form.
// Spelt out rather than computed, so a change to d1Timestamp/pyDatetime's shape
// fails here loudly instead of agreeing with itself. Both helpers -- pyNow()
// for admin_job.finished, d1Timestamp() for orders.modified -- render this
// instant identically, so one constant covers both columns.
const NOW_INSTANT = "2026-09-07T11:22:33.456Z";
const NOW_STORED = "2026-09-07 11:22:33.456000";

// A key with characters encodeURIComponent must escape. A raw "+" in a query
// string decodes to a space at the far end, so an unencoded key is a 401 that
// arrives 60 seconds later as an admin_job error nobody attributes to the URL.
const API_KEY = "AIza+test/key";
const ENCODED_KEY = "AIza%2Btest%2Fkey";

// Ids deliberately not in insertion, name or slug order, and none of them 1, so
// a query with two arguments transposed has to fail rather than happen to
// agree. ORDER_ROW is `orders.id` (the integer orderline.order_id points at);
// ORDER_ID is `orders.order_id`, the TEXT human id. Two columns, one name, two
// tables -- and getting them the wrong way round is a delete that hits nothing.
const SALISBURY = 7;
const BRIXTON = 8;
const ORDER_ROW = 1201;
const OTHER_ORDER_ROW = 1202;
const ORDER_ID = "gf-salisbury-tesco-2026-09-05";
const DELIVERY_DATE = "2026-09-05";
const JOB = "9f8e7d6c-order-lines";

const ITEMS_TEXT = "2 x Tesco Baked Beans 400g\n1 x Yorkshire Tea 250g";

// Two lines whose per-item and line totals differ in both directions, so a
// handler that stored the per-item weight or multiplied the cost twice cannot
// produce the same rows.
const DEFAULT_AI_LINES = [
  { name: "Tesco Baked Beans 400g", quantity: 2, item_cost: 45, weight: 400 },
  { name: "Yorkshire Tea 250g", quantity: 1, item_cost: 320, weight: 250 },
];

function insert(table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...(columns.map((c) => row[c] ?? null) as Bindable[]));
}

// Every NOT NULL column 0001_core.sql declares on `foodbank`. Spelt out rather
// than trimmed to the interesting few because the real DDL is what the fixture
// applies, and a shorter INSERT simply will not run.
function seedFoodbank(row: { id: number; name: string; slug: string; last_order?: string | null; edited?: string | null }): void {
  insert("foodbank", {
    id: row.id,
    uuid: `uuid-${row.id}`,
    name: row.name,
    slug: row.slug,
    address: "1 Test Street",
    postcode: "SP2 9DY",
    country: "England",
    lat_lng: "51.0812,-1.8231",
    charity_just_foodbank: 1,
    contact_email: "info@example.org",
    url: "https://example.org/",
    shopping_list_url: "https://example.org/list/",
    address_is_administrative: 0,
    is_closed: 0,
    no_locations: 0,
    days_between_needs: 7,
    last_order: row.last_order ?? null,
    created: EARLIER,
    modified: EARLIER,
    edited: row.edited ?? null,
  });
}

interface OrderSeed {
  id?: number;
  order_id?: string;
  foodbank_id?: number | null;
  items_text?: string;
  delivery_date?: string;
  weight?: number;
  calories?: number;
  cost?: number;
  no_lines?: number;
  no_items?: number;
}

// The state orderForm.ts leaves behind: the row written, the aggregates zeroed
// (orderWrite.ts's upsertOrder re-zeroes them on every save, matching
// orders.py:116-120), and this job enqueued to fill them in.
function seedOrder(row: OrderSeed = {}): void {
  const deliveryDate = row.delivery_date ?? DELIVERY_DATE;
  insert("orders", {
    id: row.id ?? ORDER_ROW,
    order_id: row.order_id ?? ORDER_ID,
    items_text: row.items_text ?? ITEMS_TEXT,
    country: "England",
    created: EARLIER,
    modified: EARLIER,
    delivery_date: deliveryDate,
    delivery_hour: 14,
    delivery_datetime: `${deliveryDate} 14:00:00.000000`,
    delivery_provider: "Tesco",
    weight: row.weight ?? 0,
    calories: row.calories ?? 0,
    cost: row.cost ?? 0,
    no_lines: row.no_lines ?? 0,
    no_items: row.no_items ?? 0,
    foodbank_id: row.foodbank_id === undefined ? SALISBURY : row.foodbank_id,
  });
}

function seedOrderLine(row: { id: number; order_id: number; name: string; category?: string | null; quantity?: number; item_cost?: number; line_cost?: number; weight?: number; calories?: number }): void {
  insert("orderline", {
    id: row.id,
    name: row.name,
    quantity: row.quantity ?? 1,
    item_cost: row.item_cost ?? 100,
    line_cost: row.line_cost ?? 100,
    weight: row.weight ?? 500,
    calories: row.calories ?? 0,
    order_id: row.order_id,
    delivery_date: DELIVERY_DATE,
    category: row.category === undefined ? "Tinned Goods" : row.category,
    group_name: "",
  });
}

function seedOrderItem(row: { id: number; name: string; calories: number }): void {
  insert("orderitem", { id: row.id, name: row.name, slug: `slug-${row.id}`, calories: row.calories });
}

function seedJob(status = "queued"): void {
  insert("admin_job", { id: JOB, kind: "order-lines", target: ORDER_ID, status, created: EARLIER });
}

// --- read-back helpers ------------------------------------------------------

function jobRow(id = JOB): Record<string, unknown> {
  return db.prepare("SELECT * FROM admin_job WHERE id = ?").get(id) as Record<string, unknown>;
}

function orderRow(id = ORDER_ROW): Record<string, unknown> {
  return db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as Record<string, unknown>;
}

function foodbankRow(id: number): Record<string, unknown> {
  return db.prepare("SELECT * FROM foodbank WHERE id = ?").get(id) as Record<string, unknown>;
}

/** Every line of an order, oldest row first. */
function lineRows(orderRowId = ORDER_ROW): Record<string, unknown>[] {
  return db.prepare("SELECT * FROM orderline WHERE order_id = ? ORDER BY id").all(orderRowId);
}

/** The five aggregates, as one comparable object. */
function aggregates(id = ORDER_ROW): Record<string, unknown> {
  const row = orderRow(id);
  return { weight: row.weight, calories: row.calories, cost: row.cost, no_lines: row.no_lines, no_items: row.no_items };
}

// Date only by default, so the awaits in these tests still resolve on a real
// event loop. `withTimers` additionally fakes setTimeout, which is the only way
// to reach geminiJsonCall's 60-second retry sleep inside a test.
function freezeClock(withTimers = false): void {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: withTimers ? ["Date", "setTimeout", "clearTimeout"] : ["Date"] });
  vi.setSystemTime(new Date(NOW_INSTANT));
}

beforeEach(() => {
  freezeClock();
  // @ts-ignore -- see the node:sqlite import comment.
  db = new DatabaseSync(":memory:") as SqliteDatabase;
  db.exec(SCHEMA);
  seedFoodbank({ id: SALISBURY, name: "Salisbury", slug: "salisbury" });
  seedOrder();
  seedJob();
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ===========================================================================
// THE ADMIN_JOB ROW -- the only thing anyone ever sees
// ===========================================================================

describe("handleOrderLinesJob -- the job row", () => {
  // The order page polls this row and nothing else. `running` has to be
  // written FIRST -- before the read, before the model call -- or a job that
  // dies mid-Gemini stays `queued` forever and the page shows "waiting to
  // start" for a parse that has already been attempted and lost.
  it("marks the job running before it reads anything, and done with the parse summary", async () => {
    const h = harness();

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(h.steps[0]).toBe("job:running");
    expect(h.steps[h.steps.length - 1]).toBe("job:done");
    const row = jobRow();
    expect(row.status).toBe("done");
    expect(row.error).toBeNull();
    expect(row.finished).toBe(NOW_STORED);
    // The payload the order page renders. `order_id` is the TEXT human id, not
    // the row id -- the page has the row id already and shows the human one.
    expect(JSON.parse(row.result as string)).toEqual({ order_id: ORDER_ID, no_lines: 2, no_items: 3 });
  });

  // ...and the row the page polls really does say `running` WHILE the model is
  // being called, which the step log above cannot show: `job:running` there is
  // only evidence that a statement of that SHAPE was issued. Marking a
  // different id running (`markAdminJobRunning(db, jobId + "x")`) leaves this
  // job on `queued` for however long Gemini takes -- up to lib/gemini.ts's
  // 120-second abort budget -- and then flips it straight to `done`, a mutant
  // that survived the first mutation run,
  // because the final state is identical and nothing else looked mid-flight.
  // The admin's page would show "waiting to start" throughout a parse that is
  // already running, which is the same confusion the `running` write exists to
  // prevent. Observed from inside the fetch stub, the one point in the run
  // where the handler is genuinely suspended.
  // The decoy job is a second order's parse, queued behind this one -- the
  // normal state of this table when an admin saves two orders in a row. It is
  // seeded because every admin_job write here is an UPDATE matched on id, and
  // a query matched on `kind` instead (or on nothing at all) would drag every
  // other pending parse to `running`, then `done`, with a result payload
  // describing an order they have nothing to do with.
  it("has the job row reading running, with no result or finish time, while Gemini is being called", async () => {
    insert("admin_job", { id: "another-order-lines-job", kind: "order-lines", target: "gf-other", status: "queued", created: EARLIER });
    let inFlight: Record<string, unknown> | null = null;
    const h = harness({
      reply: () => {
        inFlight = { ...jobRow() };
        return geminiEnvelope(DEFAULT_AI_LINES);
      },
    });

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(inFlight).toEqual({
      id: JOB,
      kind: "order-lines",
      target: ORDER_ID,
      status: "running",
      result: null,
      error: null,
      created: EARLIER,
      finished: null,
    });
    expect(jobRow().status).toBe("done");
    expect(jobRow("another-order-lines-job")).toEqual({
      id: "another-order-lines-job",
      kind: "order-lines",
      target: "gf-other",
      status: "queued",
      result: null,
      error: null,
      created: EARLIER,
      finished: null,
    });
  });

  // D1 declares no foreign keys (PLAN.md §4.5) and Cloudflare Queues are
  // at-least-once, so a message for an order the admin has since deleted is a
  // real delivery, not a hypothetical. The only correct answer is to stop: the
  // paid Gemini call must not happen and nothing must be written.
  it("stops on a deleted order without calling Gemini or touching any other table", async () => {
    const h = harness();

    await handleOrderLinesJob(h.env, JOB, 999999);

    expect(jobRow().status).toBe("failed");
    expect(jobRow().error).toBe("Order row 999999 no longer exists");
    expect(h.fetches).toEqual([]);
    expect(h.steps).toEqual(["job:running", "read:order", "job:failed"]);
  });

  // THE INCIDENT THIS TIER EXISTS FOR, in this handler's shape. An unset
  // GEMINI_API_KEY is not a crash and not a retry: the job is marked failed
  // with a sentence, the queue acks, and the order sits with zeroed aggregates
  // and whatever lines it already had. The message is asserted verbatim
  // because it is the ENTIRE diagnostic -- there is no log line, no exception
  // and no dashboard entry anywhere else.
  it("records the missing credential as a job failure and never calls Gemini", async () => {
    const h = harness({ apiKey: "" });

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(h.fetches).toEqual([]);
    expect(jobRow().status).toBe("failed");
    expect(jobRow().error).toBe("GEMINI_API_KEY is not configured, so the items text could not be parsed into order lines.");
    expect(jobRow().finished).toBe(NOW_STORED);
  });

  // ...and the guard sits AFTER the order read, so a missing key still costs a
  // D1 round trip per queued order. Pinned because the reverse -- checking the
  // key first -- would report "not configured" for an order that no longer
  // exists, which is the less useful of the two messages.
  it("reads the order before it checks for the key, so the deleted-order message wins", async () => {
    const h = harness({ apiKey: "" });

    await handleOrderLinesJob(h.env, JOB, 999999);

    expect(jobRow().error).toBe("Order row 999999 no longer exists");
  });

  // queues/jobs.ts:20-28 acks on return and retries on throw, and its comment
  // says this handler deliberately never throws so a failed parse is not
  // re-run against the same paid Gemini call. That contract is the reason
  // every failure above is a `failed` row rather than an exception, so it is
  // asserted directly: resolves, not rejects.
  it("resolves rather than throwing when the model call fails, so the queue acks", async () => {
    const h = harness({ reply: () => new Response("go away", { status: 403 }) });
    freezeClock(true);

    const running = handleOrderLinesJob(h.env, JOB, ORDER_ROW);
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(running).resolves.toBeUndefined();
    expect(jobRow().status).toBe("failed");
    expect(jobRow().error).toContain("Gemini API error: 403");
  });

  // The ONE failure that does escape: if the admin_job write itself fails, the
  // catch's own markAdminJobFailed fails the same way and the error propagates
  // to queues/jobs.ts, which retries. That is the right shape (there is
  // nowhere to record the failure, so retrying is all that is left) and it is
  // worth pinning, because "the handler never throws" is otherwise easy to
  // over-generalise into a catch-all that would swallow this too.
  it("lets a failure writing the job row escape, so the queue retries the message", async () => {
    const h = harness({ failSql: /admin_job/ });

    await expect(handleOrderLinesJob(h.env, JOB, ORDER_ROW)).rejects.toThrow("D1_ERROR: Network connection lost");

    expect(jobRow().status).toBe("queued");
  });

  // A transient replica error on any OTHER statement is caught and written
  // down as a permanent failure -- no retry, no DLQ. So a one-second D1 blip
  // and a genuinely unparseable order are indistinguishable to the admin, and
  // the fix for the blip is to press the button again. Pinned as behaviour and
  // reported, not corrected: the module's comment justifies not retrying by
  // the cost of the Gemini call, and this failure happens before that call.
  it("turns a transient database error into a permanent job failure", async () => {
    const h = harness({ failSql: /FROM orders WHERE id/ });

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(jobRow().status).toBe("failed");
    expect(jobRow().error).toBe("D1_ERROR: Network connection lost");
    expect(h.fetches).toEqual([]);
  });

  // This D1 database has read replication enabled, so every read must go
  // through the Sessions API or it can land on a replica that has not caught
  // up with the order the form wrote milliseconds ago -- which is precisely
  // this handler's situation, since the enqueue happens in the same request as
  // the INSERT. One session for the whole job, opened once.
  it("opens exactly one first-unconstrained session for the whole job", async () => {
    const h = harness();

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(h.sessionModes).toEqual(["first-unconstrained"]);
  });
});

// ===========================================================================
// MALFORMED AND ORPHANED MESSAGES -- what a queue actually delivers
// ===========================================================================
//
// queues/jobs.ts:47-52 casts the message body straight to
// `{ jobId: string; orderRowId: number }` and calls this handler with it. There
// is no validation anywhere on that path, so whatever is in the queue is what
// these two arguments are: the producer (routes/admin/orderForm.ts:376) is the
// only thing keeping them well-formed, and a message written by an older
// deployment, a hand-retried DLQ entry or a half-finished refactor is not.
// None of these shapes was covered before this section existed.

describe("handleOrderLinesJob -- malformed and orphaned messages", () => {
  // A message with no `orderRowId` at all -- an older producer, or a
  // hand-requeued body. The bind throws, the catch records it, and the queue
  // ACKS: no Gemini call, no writes, and a job row that at least says
  // something. Asserted as the failure SHAPE plus a substring, not the whole
  // sentence: the wording here is node:sqlite's, and real D1 raises its own
  // D1_TYPE_ERROR text for the same condition, so pinning the exact string
  // would be pinning the test driver rather than the handler.
  it("fails the job on a message with no order row id, without calling Gemini", async () => {
    const h = harness();

    await handleOrderLinesJob(h.env, JOB, undefined as unknown as number);

    expect(jobRow().status).toBe("failed");
    expect(jobRow().error as string).toContain("cannot be bound");
    expect(h.fetches).toEqual([]);
    expect(h.steps).toEqual(["job:running", "read:order", "job:failed"]);
    expect(lineRows()).toEqual([]);
    expect(aggregates()).toEqual({ weight: 0, calories: 0, cost: 0, no_lines: 0, no_items: 0 });
  });

  // NaN binds as NULL rather than throwing, so `WHERE id = NULL` matches
  // nothing and this arrives as the deleted-order message with "NaN" spliced
  // into it. Worth pinning because the message is the whole diagnostic: an
  // admin reading "Order row NaN no longer exists" is looking at a broken
  // producer, not a deleted order, and those want different fixes.
  it("reports a NaN order row id as a missing order, NaN and all", async () => {
    const h = harness();

    await handleOrderLinesJob(h.env, JOB, Number.NaN);

    expect(jobRow().error).toBe("Order row NaN no longer exists");
    expect(h.fetches).toEqual([]);
  });

  // A stringly id -- `{"orderRowId": "1201"}` -- runs to completion, because
  // SQLite applies column affinity to the comparison and to the INSERT. The
  // lines land with an INTEGER order_id, so the order is not subtly
  // half-broken. Pinned rather than treated as an error case: this is the one
  // malformed shape that silently works, and a future "validate the message"
  // change would alter it.
  it("still parses an order whose row id arrives as a string, storing an integer order_id", async () => {
    const h = harness();

    await handleOrderLinesJob(h.env, JOB, String(ORDER_ROW) as unknown as number);

    expect(lineRows().map((row) => ({ name: row.name, order_id: row.order_id }))).toEqual([
      { name: "Tesco Baked Beans 400g", order_id: ORDER_ROW },
      { name: "Yorkshire Tea 250g", order_id: ORDER_ROW },
    ]);
    expect(aggregates()).toEqual({ weight: 1050, calories: 0, cost: 410, no_lines: 2, no_items: 3 });
    expect(jobRow().status).toBe("done");
  });

  // THE INVISIBLE RUN. The admin_job row is the only place this handler
  // reports anything, and every write to it is an UPDATE matched on id -- so a
  // job row that was never inserted, or deleted while the message sat in the
  // queue, updates nothing three times over and the whole paid parse happens
  // with no trace anywhere. The order IS rewritten; nobody is told. Pinned as
  // behaviour: there is no guard to assert, and adding one is a source change.
  it("parses and rewrites the order even when the job row it reports to does not exist", async () => {
    db.prepare("DELETE FROM admin_job").run();
    const h = harness();

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(db.prepare("SELECT COUNT(*) AS c FROM admin_job").get()).toEqual({ c: 0 });
    expect(lineRows().map((row) => row.name)).toEqual(["Tesco Baked Beans 400g", "Yorkshire Tea 250g"]);
    expect(aggregates()).toEqual({ weight: 1050, calories: 0, cost: 410, no_lines: 2, no_items: 3 });
    expect(foodbankRow(SALISBURY).last_order).toBe(DELIVERY_DATE);
  });
});

// ===========================================================================
// THE GEMINI REQUEST -- built by the real geminiJsonCall, over a stubbed fetch
// ===========================================================================

describe("handleOrderLinesJob -- the request that leaves the machine", () => {
  it("posts to the gemini-2.5-flash generateContent endpoint with the key percent-encoded", async () => {
    const h = harness();

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(h.fetches).toHaveLength(1);
    expect(h.fetches[0]!.url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${ENCODED_KEY}`);
    expect(h.fetches[0]!.method).toBe("POST");
    expect(h.fetches[0]!.headers).toEqual({ "Content-Type": "application/json" });
  });

  // gfadmin/templates/admin/prompts/orderline_prompt.txt, compared byte for
  // byte with the file at /Users/jasoncartwright/Sites/foodcharity (read, and
  // rendered through Django 5.2.6's render_to_string). Asserted in full rather
  // than by a `toContain`, because a prompt is the input to a paid
  // nondeterministic call: a dropped line ("the weight is part of the name
  // too") does not fail, it just quietly changes what the model returns for
  // every order from then on, and the only symptom is worse data.
  it("sends the Django prompt verbatim, with the order's items text appended", async () => {
    const h = harness();

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(h.fetches[0]!.body.contents).toEqual([
      {
        parts: [
          {
            text:
              "This is a list of items, the SKU name, quantity, individual weight in grams (one litre is 1000g), and unit price in pence. The weight is part of the name too.\n" +
              "\n" +
              'E.g. name of "Fray Bentos Meatballs In Tomato Sauce 380g" is "Fray Bentos Meatballs In Tomato Sauce 380g" and the weight is 380\n' +
              "\n" +
              "Here is the order text...\n" +
              "\n" +
              ITEMS_TEXT,
          },
        ],
      },
    ]);
  });

  // A GENUINE DIVERGENCE, verified by running Django 5.2.6's render_to_string
  // over the real template: DjangoTemplates autoescapes by default (settings.py
  // :118-135 sets no autoescape option), so Django's prompt contains
  // "Sainsbury&#x27;s Tea &amp; Coffee &lt;500g&gt;" where this port sends the
  // raw text. That is almost certainly WHY orders.py:175 calls html.unescape on
  // the model's reply at all -- the escaped text goes in, escaped names come
  // back. The port sends raw text, so the same model should return raw names.
  // Pinned as the port's behaviour, reported as a divergence, not "fixed":
  // making it match would mean escaping the prompt on purpose.
  it("does NOT html-escape the items text the way Django's template engine does", async () => {
    seedOrder({ id: 1300, order_id: "gf-2", items_text: "Sainsbury's Tea & Coffee <500g>" });
    const h = harness();

    await handleOrderLinesJob(h.env, JOB, 1300);

    const prompt = h.fetches[0]!.body.contents[0]!.parts[0]!.text;
    expect(prompt.endsWith("Sainsbury's Tea & Coffee <500g>")).toBe(true);
    expect(prompt).not.toContain("&#x27;");
    expect(prompt).not.toContain("&amp;");
  });

  // models/orders.py:117-134, field for field. temperature=1 on a parsing task
  // is the original's choice and is preserved deliberately: it is also why
  // re-running the same order can produce different lines, which the
  // idempotency tests below depend on.
  it("carries orders.py's temperature, JSON mime type and response schema", async () => {
    const h = harness();

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(h.fetches[0]!.body.generationConfig).toEqual({
      temperature: 1,
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: 0 },
      responseSchema: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            quantity: { type: "integer" },
            item_cost: { type: "integer" },
            weight: { type: "integer" },
          },
          required: ["name", "quantity", "item_cost", "weight"],
        },
      },
    });
  });

  // ai.py's four HarmCategory entries at BLOCK_NONE. A shopping list is not
  // harmful content, but Gemini's default thresholds have blocked innocuous
  // text before, and a blocked response arrives as a candidate with no text
  // part -- i.e. as "Gemini response had no text part", 60 seconds and two
  // paid calls later, on an order about baked beans.
  it("disables all four safety categories, as givefood/utils/ai.py does", async () => {
    const h = harness();

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(h.fetches[0]!.body.safetySettings).toEqual([
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ]);
  });

  // ai.py:59-65's one retry after a 60-second sleep, reproduced by
  // geminiJsonCall and reached here for real. Worth pinning from this side
  // because the sleep happens INSIDE a queue consumer: the message is held for
  // a full minute, and Cloudflare's own visibility timeout is what decides
  // whether that is survivable.
  it("retries a 5xx once, a minute later, then records the failure", async () => {
    freezeClock(true);
    const h = harness({ reply: () => new Response("backend unavailable", { status: 503 }) });

    const running = handleOrderLinesJob(h.env, JOB, ORDER_ROW);
    await vi.advanceTimersByTimeAsync(60_000);
    await running;

    expect(h.fetches).toHaveLength(2);
    expect(jobRow().status).toBe("failed");
    expect(jobRow().error).toContain("Gemini server error: 503");
    // The body is read into the message: without it the admin sees a bare 503
    // and cannot tell a quota problem from an outage.
    expect(jobRow().error).toContain("backend unavailable");
  });

  // A 4xx is retried too, because geminiJsonCall throws it from INSIDE its own
  // try/catch. So a permanently wrong key costs 60 seconds of held queue
  // message and two billed-as-rejected calls per order before it reports
  // anything. Suspect, pinned rather than fixed -- it is the credential
  // incident's shape with a minute of latency bolted on.
  it("also sleeps sixty seconds and retries a 400, which no retry can fix", async () => {
    freezeClock(true);
    const h = harness({ reply: () => new Response("API key not valid", { status: 400 }) });

    const running = handleOrderLinesJob(h.env, JOB, ORDER_ROW);
    await vi.advanceTimersByTimeAsync(60_000);
    await running;

    expect(h.fetches).toHaveLength(2);
    expect(jobRow().error).toContain("Gemini API error: 400");
    expect(jobRow().error).toContain("API key not valid");
  });

  // The model answering prose instead of JSON is the failure mode a
  // responseSchema is supposed to prevent and does not always. It surfaces as
  // the JSON.parse error, recorded on the job row.
  it("records a model reply that is not JSON as the parse error", async () => {
    freezeClock(true);
    const h = harness({ reply: () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Sorry, I can't help with that." }] } }] }), { status: 200 }) });

    const running = handleOrderLinesJob(h.env, JOB, ORDER_ROW);
    await vi.advanceTimersByTimeAsync(60_000);
    await running;

    expect(jobRow().status).toBe("failed");
    expect(jobRow().error).toMatch(/JSON/);
    expect(lineRows()).toEqual([]);
  });

  // A safety block or a truncated candidate arrives as an envelope with no
  // text part at all -- not as an error status -- so this is the message an
  // admin sees for "the model refused".
  it("records an empty candidate envelope as 'no text part'", async () => {
    freezeClock(true);
    const h = harness({ reply: () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }) });

    const running = handleOrderLinesJob(h.env, JOB, ORDER_ROW);
    await vi.advanceTimersByTimeAsync(60_000);
    await running;

    expect(jobRow().error).toBe("Gemini response had no text part");
  });

  // The schema says "array"; a model that returns `{"lines": [...]}` instead
  // is a shape mismatch the handler names explicitly rather than crashing on
  // `.filter`. The distinct message matters: it tells whoever is looking that
  // the model answered, which "no text part" does not.
  it("names a non-array reply specifically, and writes nothing", async () => {
    const h = harness({ lines: { lines: DEFAULT_AI_LINES } });

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(jobRow().status).toBe("failed");
    expect(jobRow().error).toBe("The model did not return a list of order lines.");
    expect(h.steps).toEqual(["job:running", "read:order", "fetch:gemini", "job:failed"]);
  });
});

// ===========================================================================
// THE LINES -- what actually lands in `orderline`
// ===========================================================================

describe("handleOrderLinesJob -- the order lines", () => {
  // orders.py:169-195. THE THREE COLUMNS THAT ARE EASY TO SWAP: `weight` and
  // `line_cost` are LINE totals (per-item x quantity) while `item_cost` stays
  // the per-item value the model returned. Getting weight per-item instead of
  // per-line halves the tonnage the site reports for a two-of-everything
  // order, on a page that still renders perfectly.
  it("stores line totals for weight and line_cost while item_cost stays per item", async () => {
    const h = harness();

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(lineRows().map((row) => ({ name: row.name, quantity: row.quantity, item_cost: row.item_cost, line_cost: row.line_cost, weight: row.weight }))).toEqual([
      { name: "Tesco Baked Beans 400g", quantity: 2, item_cost: 45, line_cost: 90, weight: 800 },
      { name: "Yorkshire Tea 250g", quantity: 1, item_cost: 320, line_cost: 320, weight: 250 },
    ]);
  });

  // OrderLine.save()'s denormalisation (orders.py:249-250): the line carries
  // its order's delivery date, which is what orderline_delivery_date_idx and
  // every "what was delivered in September" dashboard query read instead of
  // joining. The FK is the INTEGER `orders.id`, never the TEXT `order_id` --
  // binding the wrong one writes lines nothing will ever find.
  it("denormalises the order's delivery date and points at the integer order id", async () => {
    seedOrder({ id: 1300, order_id: "gf-elsewhere", delivery_date: "2026-12-24" });
    const h = harness();

    await handleOrderLinesJob(h.env, JOB, 1300);

    expect(lineRows(1300).map((row) => row.delivery_date)).toEqual(["2026-12-24", "2026-12-24"]);
    expect(lineRows(1300).map((row) => row.order_id)).toEqual([1300, 1300]);
  });

  // `group_name` -- the column 0005 renamed because `group` is a SQL keyword.
  // Written as the empty string, not NULL, matching Django's non-null
  // CharField. Nothing in the port ever fills it in; ITEM_GROUPS is a Django
  // admin concern that has no port yet, and an empty string is what the
  // /admin/items/ grouping reads as "ungrouped".
  //
  // The category is seeded NON-EMPTY on purpose. With both columns blank, a
  // handler that wrote `group: category` -- the obvious slip, since the two
  // sit adjacent in the same object literal and are both backfilled the same
  // way in Django -- produced identical rows and survived an earlier version
  // of this test.
  it("writes an empty group_name rather than leaving it NULL, even when the category is set", async () => {
    seedOrderLine({ id: 720, order_id: OTHER_ORDER_ROW, name: "Tesco Baked Beans 400g", category: "Tinned Goods" });
    const h = harness();

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(lineRows().map((row) => ({ category: row.category, group_name: row.group_name }))).toEqual([
      { category: "Tinned Goods", group_name: "" },
      { category: "", group_name: "" },
    ]);
  });

  // Delete-then-insert, scoped to THIS order. The other order's line is seeded
  // precisely because a delete missing its WHERE, or scoped by name instead of
  // order, would pass every assertion that only looks at this order's rows --
  // and would silently empty an unrelated delivery.
  it("replaces only this order's lines, leaving another order's alone", async () => {
    seedOrder({ id: OTHER_ORDER_ROW, order_id: "gf-other", foodbank_id: BRIXTON });
    seedFoodbank({ id: BRIXTON, name: "Brixton", slug: "brixton" });
    seedOrderLine({ id: 900, order_id: ORDER_ROW, name: "Stale Line" });
    seedOrderLine({ id: 901, order_id: OTHER_ORDER_ROW, name: "Someone Else's Line" });
    const h = harness();

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(lineRows().map((row) => row.name)).toEqual(["Tesco Baked Beans 400g", "Yorkshire Tea 250g"]);
    expect(lineRows(OTHER_ORDER_ROW).map((row) => row.name)).toEqual(["Someone Else's Line"]);
  });

  // THE ORDERING THAT DIVERGES FROM DJANGO, and the module's stated reason for
  // existing in this shape: Django deletes the lines BEFORE it calls Gemini
  // (orders.py:132-134) and loses them all if the call raises. Here the delete
  // happens after the model has answered and after every per-line lookup, so a
  // failed parse leaves the previous lines intact. The interleaved step log is
  // the only way to state that as a fact rather than a hope.
  it("calls Gemini and both per-line lookups BEFORE it deletes anything", async () => {
    const h = harness();

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(h.steps).toEqual([
      "job:running",
      "read:order",
      "fetch:gemini",
      "read:calories",
      "read:category",
      "read:calories",
      "read:category",
      "write:delete-lines",
      "write:insert-line",
      "write:insert-line",
      "write:aggregates",
      "write:last-order",
      "job:done",
    ]);
  });

  // ...and the consequence, asserted from the rows: a model failure leaves the
  // order exactly as it was. This is the single behavioural improvement the
  // port makes over Django's Order.save(), so it is worth a test that does not
  // depend on reading the step log correctly.
  it("leaves the previous lines and aggregates untouched when the parse fails", async () => {
    seedOrder({ id: 1300, order_id: "gf-3", weight: 8000, calories: 12000, cost: 999, no_lines: 1, no_items: 4 });
    seedOrderLine({ id: 910, order_id: 1300, name: "Previously Parsed Line" });
    const h = harness({ lines: "not a list at all" });

    await handleOrderLinesJob(h.env, JOB, 1300);

    expect(lineRows(1300).map((row) => row.name)).toEqual(["Previously Parsed Line"]);
    expect(aggregates(1300)).toEqual({ weight: 8000, calories: 12000, cost: 999, no_lines: 1, no_items: 4 });
  });

  // An empty array is a SUCCESS, not a failure: the job goes `done`, the old
  // lines are gone and the aggregates are zeroed. So a model that shrugs at an
  // unusual receipt silently converts a real delivery into a 0kg one, and the
  // order page shows a green tick. Pinned as behaviour and reported -- Django
  // does exactly the same thing, and nothing in either version compares the
  // parse against the input.
  it("treats an empty parse as success: lines deleted, aggregates zeroed, job done", async () => {
    seedOrderLine({ id: 920, order_id: ORDER_ROW, name: "Previously Parsed Line" });
    const h = harness({ lines: [] });

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(lineRows()).toEqual([]);
    expect(aggregates()).toEqual({ weight: 0, calories: 0, cost: 0, no_lines: 0, no_items: 0 });
    expect(jobRow().status).toBe("done");
    expect(JSON.parse(jobRow().result as string)).toEqual({ order_id: ORDER_ID, no_lines: 0, no_items: 0 });
    // insertOrderLines returns early on an empty list rather than issuing an
    // empty batch, which D1 rejects.
    expect(h.steps).not.toContain("write:insert-line");
  });

  // isAiOrderLine's filter, and the quietest failure in this file. The schema
  // asks for integers; a model that answers `"2"` for one line of a nine-line
  // order has that line DROPPED -- not rejected, not logged, not counted. The
  // order simply reports eight items and the ninth never existed. Every
  // rejected shape here is one a real model reply has room to produce.
  it("silently drops a line whose fields are the wrong shape, and does not count it", async () => {
    const h = harness({
      lines: [
        { name: "Kept", quantity: 1, item_cost: 100, weight: 500 },
        { name: "Stringly quantity", quantity: "2", item_cost: 100, weight: 500 },
        { name: "Missing weight", quantity: 1, item_cost: 100 },
        { name: 42, quantity: 1, item_cost: 100, weight: 500 },
        { name: "Null cost", quantity: 1, item_cost: null, weight: 500 },
        { name: "NaN weight", quantity: 1, item_cost: 100, weight: Number.NaN },
        "not an object at all",
        null,
        { name: "Also kept", quantity: 3, item_cost: 10, weight: 100 },
      ],
    });

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(lineRows().map((row) => row.name)).toEqual(["Kept", "Also kept"]);
    expect(jobRow().status).toBe("done");
    // The order's own numbers agree with the two surviving lines, so nothing
    // downstream can tell that seven were thrown away -- there is no "7 lines
    // rejected" in the aggregates, in the result payload, or in a log line.
    expect(aggregates()).toEqual({ weight: 800, calories: 0, cost: 130, no_lines: 2, no_items: 4 });
    expect(JSON.parse(jobRow().result as string)).toEqual({ order_id: ORDER_ID, no_lines: 2, no_items: 4 });
  });

  // JSON has no integers, so `quantity: 2.6` is a legal reply to an "integer"
  // schema. Math.trunc, not Math.round: 2.6 items becomes 2. Django would have
  // reached the same place by a different road (IntegerField.get_prep_value
  // calls int(), read out of the installed Django 5.2.6), but the LINE TOTALS
  // here are computed from the truncated values, where Django multiplies the
  // raw floats first and truncates at save. That difference is real, and for
  // THIS fixture's own numbers (quantity 2.6, weight 400.7, item_cost 45.9) it
  // is: this port stores weight 2 x 400 = 800 and line_cost 2 x 45 = 90, where
  // Django stores int(2.6 x 400.7) = 1041 and int(45.9 x 2.6) = 119 -- run in
  // CPython, not reasoned about. Django's item_cost is then recomputed as
  // line_cost // quantity (models/orders.py:251-252) and lands on 45 too, so
  // that one column agrees by coincidence rather than by construction.
  it("truncates fractional quantities and weights before it multiplies", async () => {
    const h = harness({ lines: [{ name: "Fractional", quantity: 2.6, item_cost: 45.9, weight: 400.7 }] });

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(lineRows().map((row) => ({ quantity: row.quantity, item_cost: row.item_cost, line_cost: row.line_cost, weight: row.weight }))).toEqual([
      { quantity: 2, item_cost: 45, line_cost: 90, weight: 800 },
    ]);
  });

  // Nothing rejects a negative. `orderline.quantity` is a plain INTEGER with no
  // CHECK, where Django's PositiveIntegerField has a database constraint that
  // would have raised. So a model that emits a refund line writes negative
  // weight and cost straight into the aggregates the public site reports.
  // Pinned as behaviour, reported: this is data corruption with no exception.
  it("stores negative quantities and weights unchallenged, unlike Django's PositiveIntegerField", async () => {
    const h = harness({ lines: [{ name: "Refunded Item", quantity: -1, item_cost: 45, weight: 400 }] });

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(lineRows().map((row) => ({ quantity: row.quantity, line_cost: row.line_cost, weight: row.weight }))).toEqual([{ quantity: -1, line_cost: -45, weight: -400 }]);
    expect(aggregates()).toEqual({ weight: -400, calories: 0, cost: -45, no_lines: 1, no_items: -1 });
    expect(jobRow().status).toBe("done");
  });
});

// ===========================================================================
// CALORIES -- utils/text.py:118-130's get_calories, over the real orderitem row
// ===========================================================================

describe("handleOrderLinesJob -- calories", () => {
  // get_calories is `orderitem.calories * (weight/100) * quantity`, where
  // `weight` is the PER-ITEM weight -- not the line total the same loop just
  // computed. Multiplying by the line weight instead would multiply by
  // quantity twice, so this fixture uses quantity 3 to make the two answers
  // differ by a factor of three.
  it("multiplies per-100g calories by the PER-ITEM weight and the quantity", async () => {
    seedOrderItem({ id: 501, name: "Tesco Baked Beans 400g", calories: 78 });
    const h = harness({ lines: [{ name: "Tesco Baked Beans 400g", quantity: 3, item_cost: 45, weight: 400 }] });

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    // 78 kcal/100g x 4 hundred-gram units x 3 tins = 936.
    expect(lineRows()[0]!.calories).toBe(936);
    expect(orderRow().calories).toBe(936);
  });

  // Django's get_calories returns a float and OrderLine.calories is a
  // PositiveIntegerField, so the ORM truncates on save -- IntegerField
  // .get_prep_value is `int(value)`, read out of the Django 5.2.6 installed at
  // foodcharity. Math.trunc reproduces that. Rounding instead would be off by
  // one on roughly half of all lines, which is invisible per line and adds up
  // across 1,200 items into a headline calorie figure nobody can reconcile.
  it("truncates the calorie product toward zero rather than rounding it", async () => {
    seedOrderItem({ id: 502, name: "Half Portion", calories: 350 });
    const h = harness({ lines: [{ name: "Half Portion", quantity: 1, item_cost: 100, weight: 125 }] });

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    // 350 x 1.25 x 1 = 437.5 -> 437, not 438.
    expect(lineRows()[0]!.calories).toBe(437);
  });

  // orders.py:177-180 swallows OrderItem.DoesNotExist and scores 0. The join is
  // on the item NAME byte for byte, and the model phrases names freely, so a
  // miss is the COMMON case rather than the exceptional one -- the line must
  // still be written, with everything except its calories.
  it("scores an unknown item as zero calories and still writes the line", async () => {
    const h = harness({ lines: [{ name: "Some Own-Brand Thing 500g", quantity: 2, item_cost: 100, weight: 500 }] });

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(lineRows()).toHaveLength(1);
    expect(lineRows()[0]!.calories).toBe(0);
    expect(lineRows()[0]!.weight).toBe(1000);
  });

  // A zero-calorie item is a real row (bottled water), and it must not be an
  // error: the line is written, its calories are 0, and only ONE lookup is
  // issued -- no "try again without the calories" second pass.
  //
  // HONEST NOTE ON THE `=== null` GUARD: replacing it with a falsy check is an
  // EQUIVALENT mutant, and the mutation run confirmed it survives this test.
  // It has to: 0 x anything finite is 0, so both spellings store 0 here. The
  // guard is still the right one -- it is the spelling that stays correct if a
  // calorie default ever becomes non-zero -- but no test can prove that today,
  // and pretending otherwise would be worse than saying so.
  it("treats a zero-calorie item as a normal line rather than a lookup miss", async () => {
    seedOrderItem({ id: 503, name: "Still Water 2L", calories: 0 });
    const h = harness({ lines: [{ name: "Still Water 2L", quantity: 6, item_cost: 45, weight: 2000 }] });

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(lineRows()[0]!.calories).toBe(0);
    expect(h.steps.filter((step) => step === "read:calories")).toHaveLength(1);
  });

  // The lookup is an exact match, and the near-miss rows here are the ones a
  // `LIKE` or a case-insensitive collation would wrongly return. A wrong
  // calorie row is worse than no row: it is a plausible number.
  it("matches the item name exactly, not by prefix or case", async () => {
    seedOrderItem({ id: 504, name: "Tesco Baked Beans", calories: 999 });
    seedOrderItem({ id: 505, name: "tesco baked beans 400g", calories: 888 });
    seedOrderItem({ id: 506, name: "Tesco Baked Beans 400g Value", calories: 777 });
    const h = harness({ lines: [{ name: "Tesco Baked Beans 400g", quantity: 1, item_cost: 45, weight: 400 }] });

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(lineRows()[0]!.calories).toBe(0);
  });
});

// ===========================================================================
// html.unescape -- orders.py:175, and the entity table this port actually has
// ===========================================================================

describe("handleOrderLinesJob -- decoding the model's item names", () => {
  // Every one of these was run through CPython's html.unescape at
  // /Users/jasoncartwright/Sites/foodcharity to confirm the port agrees:
  //   html.unescape("Sainsbury&#39;s")  -> "Sainsbury's"
  //   html.unescape("Sainsbury&#039;s") -> "Sainsbury's"
  //   html.unescape("&apos;")           -> "'"
  //   html.unescape("&quot;x&quot;")    -> '"x"'
  //   html.unescape("Tea &amp; Coffee") -> "Tea & Coffee"
  it("decodes the entities orders.py's html.unescape would, on the stored name", async () => {
    const h = harness({
      lines: [
        { name: "Sainsbury&#39;s Beans", quantity: 1, item_cost: 1, weight: 1 },
        { name: "Sainsbury&#039;s Peas", quantity: 1, item_cost: 1, weight: 1 },
        { name: "Bob&apos;s Soup", quantity: 1, item_cost: 1, weight: 1 },
        { name: "Tea &amp; Coffee", quantity: 1, item_cost: 1, weight: 1 },
        { name: "&quot;Value&quot; Rice", quantity: 1, item_cost: 1, weight: 1 },
        { name: "Under &lt;500g&gt;", quantity: 1, item_cost: 1, weight: 1 },
      ],
    });

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(lineRows().map((row) => row.name)).toEqual([
      "Sainsbury's Beans",
      "Sainsbury's Peas",
      "Bob's Soup",
      "Tea & Coffee",
      '"Value" Rice',
      "Under <500g>",
    ]);
  });

  // The `&amp;` replacement is LAST for a reason the module states in a
  // comment: decoding it first would turn "&amp;lt;" into "&lt;" and then into
  // "<", inventing markup the model never sent. CPython agrees --
  // html.unescape("&amp;lt;") is "&lt;", run and checked.
  it("decodes &amp; last, so &amp;lt; stays &lt; rather than becoming <", async () => {
    const h = harness({ lines: [{ name: "Literal &amp;lt; entity", quantity: 1, item_cost: 1, weight: 1 }] });

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(lineRows()[0]!.name).toBe("Literal &lt; entity");
  });

  // TWO DIVERGENCES FROM html.unescape, both verified by running CPython:
  //   * html.unescape("Caf&eacute; Nero") -> "Café Nero"; this port leaves the
  //     entity literal, because it carries seven replacements rather than the
  //     full HTML5 table.
  //   * html.unescape("&#233;") -> "é"; this port decodes only &#39; and
  //     &#039;, so every other numeric reference survives intact.
  // The cost is not cosmetic: the decoded name is the join key for calories and
  // category, so an accented product simply never matches its orderitem row.
  // Pinned as behaviour and reported, not fixed.
  it("leaves accented and other numeric entities literal, where html.unescape would decode them", async () => {
    const h = harness({
      lines: [
        { name: "Caf&eacute; Nero Beans", quantity: 1, item_cost: 1, weight: 1 },
        { name: "Caf&#233; Nero Peas", quantity: 1, item_cost: 1, weight: 1 },
      ],
    });

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(lineRows().map((row) => row.name)).toEqual(["Caf&eacute; Nero Beans", "Caf&#233; Nero Peas"]);
  });

  // A THIRD DIVERGENCE, and the subtlest: html.unescape("a&nbsp;b") is
  // "a\xa0b" -- U+00A0, NO-BREAK SPACE -- where this port substitutes an
  // ordinary U+0020. Run and checked against CPython. Any orderitem row Django
  // wrote through the same path therefore holds the no-break character, and
  // the exact-match join below cannot reach it from here. Asserted on the code
  // point, not by eye, because the two are indistinguishable in a diff.
  it("turns &nbsp; into an ordinary space where Python produces U+00A0", async () => {
    const h = harness({ lines: [{ name: "Beans&nbsp;400g", quantity: 1, item_cost: 1, weight: 1 }] });

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    const name = lineRows()[0]!.name as string;
    expect(name).toBe("Beans 400g");
    expect(name.charCodeAt(5)).toBe(0x20);
  });

  // THE POINT of decoding at all (orders.py:175's own reason): the decoded name
  // is what the calorie and category lookups join on. The encoded row is seeded
  // deliberately -- it is exactly what a lookup done BEFORE the decode would
  // match, and it would then return the wrong calories rather than none, which
  // no assertion about the stored name alone would catch.
  it("looks calories up under the DECODED name, never the encoded one", async () => {
    seedOrderItem({ id: 601, name: "Sainsbury's Beans 400g", calories: 78 });
    seedOrderItem({ id: 602, name: "Sainsbury&#39;s Beans 400g", calories: 1 });
    const h = harness({ lines: [{ name: "Sainsbury&#39;s Beans 400g", quantity: 1, item_cost: 45, weight: 400 }] });

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(lineRows()[0]!.calories).toBe(312); // 78 x 4 x 1, from the decoded row
  });

  it("looks the category up under the DECODED name too", async () => {
    seedOrderLine({ id: 930, order_id: OTHER_ORDER_ROW, name: "Sainsbury's Beans 400g", category: "Tinned Goods" });
    seedOrderLine({ id: 931, order_id: OTHER_ORDER_ROW, name: "Sainsbury&#39;s Beans 400g", category: "Wrong Category" });
    const h = harness({ lines: [{ name: "Sainsbury&#39;s Beans 400g", quantity: 1, item_cost: 45, weight: 400 }] });

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(lineRows()[0]!.category).toBe("Tinned Goods");
  });
});

// ===========================================================================
// CATEGORY BACKFILL -- OrderLine.save()'s first fallback, orders.py:253-256
// ===========================================================================

describe("handleOrderLinesJob -- the category backfill", () => {
  // `.filter(name=...).exclude(category="").latest("id")`. Four of the five
  // rows seeded here MUST be excluded, and each is a different exclusion: the
  // empty string, NULL (which this schema allows and Django's CharField does
  // not), a different item entirely, and an older row for the same item. A
  // lookup that dropped its ORDER BY, or its emptiness guard, would return one
  // of them and mis-categorise the item everywhere it appears.
  it("takes the most recent non-empty category for the same name, ignoring blanks and other items", async () => {
    seedOrderLine({ id: 700, order_id: OTHER_ORDER_ROW, name: "Yorkshire Tea 250g", category: "Ancient Category" });
    seedOrderLine({ id: 701, order_id: OTHER_ORDER_ROW, name: "Yorkshire Tea 250g", category: "Drinks" });
    seedOrderLine({ id: 702, order_id: OTHER_ORDER_ROW, name: "Yorkshire Tea 250g", category: "" });
    seedOrderLine({ id: 703, order_id: OTHER_ORDER_ROW, name: "Yorkshire Tea 250g", category: null });
    seedOrderLine({ id: 704, order_id: OTHER_ORDER_ROW, name: "Something Else", category: "Not This One" });
    const h = harness({ lines: [{ name: "Yorkshire Tea 250g", quantity: 1, item_cost: 320, weight: 250 }] });

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(lineRows()[0]!.category).toBe("Drinks");
  });

  // An item nobody has ever categorised gets the empty string -- NOT NULL, so
  // that it is itself excluded from future lookups by the same query, and so
  // that the admin's category <select> renders "---------" rather than crashing
  // on a null.
  it("writes an empty category when the item has never been categorised", async () => {
    const h = harness({ lines: [{ name: "Brand New Product", quantity: 1, item_cost: 1, weight: 1 }] });

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(lineRows()[0]!.category).toBe("");
  });

  // A REAL GAP AGAINST DJANGO, pinned rather than filled. OrderLine.save() has
  // THREE fallbacks (orders.py:253-270): the previous order line, then
  // FoodbankChangeLine by item name, then a Gemini categorisation call. This
  // port implements only the first. packages/db even exports
  // getLatestNeedLineCategory for the second -- it is simply not called from
  // here. The seeded need line is the exact row Django would have used, and
  // the assertion is that this port ignores it.
  it("does NOT fall back to foodbankchangeline the way Django does", async () => {
    insert("foodbankchangeline", {
      id: 800,
      need_id: 1,
      foodbank_id: SALISBURY,
      item: "Yorkshire Tea 250g",
      type: "need",
      category: "Drinks",
      group_name: "",
      created: EARLIER,
    });
    const h = harness({ lines: [{ name: "Yorkshire Tea 250g", quantity: 1, item_cost: 320, weight: 250 }] });

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(lineRows()[0]!.category).toBe("");
    // And no second AI call for the third fallback either: exactly one fetch.
    expect(h.fetches).toHaveLength(1);
  });

  // A CONSEQUENCE OF THE DELETE MOVING LATER, worth stating on its own because
  // it is an improvement nobody designed: the lookup runs while this order's
  // OWN previous lines still exist, so re-parsing an order preserves the
  // categories an admin set on it. Django, deleting first, cannot see them and
  // would fall through to its next fallback. If the delete is ever moved back
  // before the loop "to match Django", this test is what notices.
  it("can take the category from this order's own previous lines, because they are still there", async () => {
    seedOrderLine({ id: 710, order_id: ORDER_ROW, name: "Yorkshire Tea 250g", category: "Hot Drinks" });
    const h = harness({ lines: [{ name: "Yorkshire Tea 250g", quantity: 1, item_cost: 320, weight: 250 }] });

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(lineRows()).toHaveLength(1);
    expect(lineRows()[0]!.category).toBe("Hot Drinks");
  });

  // Two lookups per line, sequentially, on a database with read replication.
  // A 40-item Tesco order is 80 round trips inside one queue message, plus the
  // model call. Pinned as a fact about the shape rather than a complaint: it
  // is what a per-line `latest("id")` costs when it is not batched, and it is
  // the number to check first if this job ever starts timing out.
  it("issues two lookups per parsed line, not one per order", async () => {
    const h = harness({
      lines: [
        { name: "A", quantity: 1, item_cost: 1, weight: 1 },
        { name: "B", quantity: 1, item_cost: 1, weight: 1 },
        { name: "C", quantity: 1, item_cost: 1, weight: 1 },
      ],
    });

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(h.steps.filter((step) => step === "read:calories")).toHaveLength(3);
    expect(h.steps.filter((step) => step === "read:category")).toHaveLength(3);
  });
});

// ===========================================================================
// THE AGGREGATES -- the five numbers the public site reports
// ===========================================================================

describe("handleOrderLinesJob -- the order aggregates", () => {
  // orders.py:198-204. These five are what /api/2/orders/, the deliveries
  // dashboard and every "we have delivered N tonnes" figure read; nothing
  // recomputes them from the lines afterwards, so a wrong sum here is a wrong
  // public number until someone re-parses the order by hand. The fixture uses
  // three different quantities so that no two of the five can be confused with
  // each other by coincidence.
  it("sums weight, calories and cost across the lines and counts lines and items separately", async () => {
    seedOrderItem({ id: 510, name: "Beans", calories: 78 });
    seedOrderItem({ id: 511, name: "Rice", calories: 350 });
    const h = harness({
      lines: [
        { name: "Beans", quantity: 2, item_cost: 45, weight: 400 },
        { name: "Rice", quantity: 3, item_cost: 120, weight: 500 },
        { name: "Uncatalogued", quantity: 4, item_cost: 15, weight: 100 },
      ],
    });

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(aggregates()).toEqual({
      weight: 800 + 1500 + 400, // line totals, not per-item weights
      calories: 624 + 5250 + 0, // 78x4x2, 350x5x3, unknown item scores 0
      cost: 90 + 360 + 60,
      no_lines: 3, // lines, not items
      no_items: 9, // items, not lines
    });
    // no_lines is `lines.length`; `aiLines.length` would be the same number by
    // construction (one push per parsed line), so that particular substitution
    // is an equivalent mutant and this assertion cannot -- and does not claim
    // to -- catch it. See the file header.
  });

  // `modified` is restamped because this genuinely is a later write to the row
  // (Django's own second super().save() updates auto_now `modified` for the
  // same reason). `created` must NOT move: /admin/orders/ sorts on it, and a
  // restamped creation date reshuffles the admin's own history.
  it("restamps modified without disturbing created", async () => {
    const h = harness();

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(orderRow().modified).toBe(NOW_STORED);
    expect(orderRow().created).toBe(EARLIER);
  });

  // The aggregates are written even when nothing else is, and they are written
  // ONCE -- one UPDATE for the whole order rather than one per line. A
  // per-line update would leave a partly-summed order visible to any read that
  // landed between them.
  it("writes the aggregates in a single statement", async () => {
    const h = harness();

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(h.steps.filter((step) => step === "write:aggregates")).toHaveLength(1);
  });
});

// ===========================================================================
// THE FOOD BANK'S last_order -- orders.py:213-215
// ===========================================================================

describe("handleOrderLinesJob -- the food bank restamp", () => {
  // MAX(delivery_date) over that food bank's orders, RECOMPUTED rather than
  // assumed to be this one. The later order is seeded precisely so that
  // "assume it is this order" gives a different (wrong, earlier) answer: an
  // admin re-parsing an old order would otherwise wind the food bank's
  // last_order backwards, and /needs/at/<slug>/ would start advertising a
  // delivery that has already been superseded.
  it("sets last_order to the food bank's LATEST delivery date, not this order's", async () => {
    seedOrder({ id: 1310, order_id: "gf-later", delivery_date: "2026-10-01" });
    const h = harness();

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(foodbankRow(SALISBURY).last_order).toBe("2026-10-01");
    expect(foodbankRow(SALISBURY).modified).toBe(NOW_STORED);
  });

  // ...scoped to this food bank. Another charity's later order must not leak
  // into the answer -- a dropped WHERE would give every food bank the same
  // last_order, which looks entirely plausible on a page showing one of them.
  it("ignores another food bank's orders when recomputing", async () => {
    seedFoodbank({ id: BRIXTON, name: "Brixton", slug: "brixton" });
    seedOrder({ id: 1320, order_id: "gf-brixton", foodbank_id: BRIXTON, delivery_date: "2026-11-11" });
    const h = harness();

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(foodbankRow(SALISBURY).last_order).toBe(DELIVERY_DATE);
    expect(foodbankRow(BRIXTON).last_order).toBeNull();
  });

  // `edited` means "a human edited this food bank" and is what the admin's
  // stale-data views sort on. last_order is derived, so a background job
  // restamping `edited` would push every food bank that ever received a
  // delivery to the top of a list meant to surface neglected ones.
  it("does not stamp the food bank's edited column", async () => {
    seedFoodbank({ id: 55, name: "Untouched", slug: "untouched", edited: EARLIER });
    seedOrder({ id: 1330, order_id: "gf-untouched", foodbank_id: 55 });
    const h = harness();

    await handleOrderLinesJob(h.env, JOB, 1330);

    expect(foodbankRow(55).edited).toBe(EARLIER);
  });

  // orders.py:213's `if ... self.foodbank` guard. `orders.foodbank_id` is
  // nullable -- the admin creates unassigned orders and attaches them later --
  // and recomputeFoodbankLastOrder with a null id would run
  // `UPDATE foodbank SET last_order = ... WHERE id IS NULL`, which is a no-op
  // today and a very bad statement to leave lying around.
  it("skips the food bank update entirely for an unassigned order", async () => {
    seedOrder({ id: 1340, order_id: "gf-unassigned", foodbank_id: null });
    const h = harness();

    await handleOrderLinesJob(h.env, JOB, 1340);

    expect(h.steps).not.toContain("write:last-order");
    expect(jobRow().status).toBe("done");
    // The lines and totals are written in full: skipping the food bank is the
    // ONLY difference an unassigned order makes. A length check alone passed
    // here even when the rows were wrong, so the values are spelt out.
    expect(lineRows(1340).map((row) => ({ name: row.name, quantity: row.quantity, weight: row.weight, line_cost: row.line_cost }))).toEqual([
      { name: "Tesco Baked Beans 400g", quantity: 2, weight: 800, line_cost: 90 },
      { name: "Yorkshire Tea 250g", quantity: 1, weight: 250, line_cost: 320 },
    ]);
    expect(aggregates(1340)).toEqual({ weight: 1050, calories: 0, cost: 410, no_lines: 2, no_items: 3 });
    expect(foodbankRow(SALISBURY).modified).toBe(EARLIER);
  });
});

// ===========================================================================
// AT-LEAST-ONCE DELIVERY -- the same message, twice
// ===========================================================================

describe("handleOrderLinesJob -- redelivery", () => {
  // Cloudflare Queues are at-least-once, so the same message genuinely arrives
  // twice. The delete-then-insert shape is what makes that survivable: the
  // second run replaces the first run's lines rather than appending to them.
  // Without the DELETE, a redelivered message would double every line, every
  // aggregate, and the tonnage the site reports -- with no error anywhere.
  it("is idempotent: a redelivered message replaces the lines rather than duplicating them", async () => {
    const h = harness();

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);
    const first = { lines: lineRows().map((row) => ({ ...row, id: undefined })), totals: aggregates() };

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);
    const second = { lines: lineRows().map((row) => ({ ...row, id: undefined })), totals: aggregates() };

    expect(lineRows()).toHaveLength(2);
    expect(second).toEqual(first);
    expect(aggregates()).toEqual({ weight: 1050, calories: 0, cost: 410, no_lines: 2, no_items: 3 });
  });

  // The job row is re-driven too: `done` goes back to `running` and then to
  // `done` again, with a fresh `finished`. Nothing guards on the current
  // status, so a redelivery of an already-completed job re-runs the whole
  // thing -- including the paid model call.
  it("re-runs a job that is already done, and pays for a second model call", async () => {
    const h = harness();

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);
    expect(jobRow().status).toBe("done");

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(h.fetches).toHaveLength(2);
    expect(jobRow().status).toBe("done");
  });

  // temperature=1 means the second call can legitimately return DIFFERENT
  // lines for identical input, so idempotency here is structural (no
  // duplicates) rather than semantic (the same answer). This is the case where
  // a redelivery quietly rewrites a correct order into a different one, and it
  // is why the aggregates are recomputed from the new lines rather than added
  // to the old ones.
  it("replaces the whole order when a redelivery's parse disagrees with the first", async () => {
    let call = 0;
    const h = harness({
      reply: () => {
        call += 1;
        return geminiEnvelope(call === 1 ? DEFAULT_AI_LINES : [{ name: "Completely Different", quantity: 1, item_cost: 500, weight: 100 }]);
      },
    });

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);
    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(lineRows().map((row) => row.name)).toEqual(["Completely Different"]);
    expect(aggregates()).toEqual({ weight: 100, calories: 0, cost: 500, no_lines: 1, no_items: 1 });
  });

  // The lines are gone BEFORE the inserts run, and they are not restored if
  // the inserts fail. So a D1 failure in the write half leaves the order with
  // zero lines and its previous aggregates -- an order that renders as empty
  // and reports a weight. Narrow (the delete and the batch are consecutive
  // statements) but real, and the job row does at least say so.
  it("leaves the order with no lines at all when the insert fails after the delete", async () => {
    seedOrderLine({ id: 940, order_id: ORDER_ROW, name: "Previously Parsed Line" });
    const h = harness({ failSql: /INSERT INTO orderline/ });

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(lineRows()).toEqual([]);
    expect(jobRow().status).toBe("failed");
    expect(jobRow().error).toBe("D1_ERROR: Network connection lost");
    // The aggregates were never reached, so the order still advertises the
    // previous parse's numbers over no lines at all.
    expect(aggregates()).toEqual({ weight: 0, calories: 0, cost: 0, no_lines: 0, no_items: 0 });
  });

  // One statement EARLIER than the insert failure above, and the one place
  // where stopping is unambiguously right: if the delete fails, the previous
  // parse's lines are still there, so inserting the new ones on top would give
  // the order both sets at once -- every item counted twice on a page that
  // still renders perfectly, with aggregates that agree with neither.
  //
  // It also kills `void deleteOrderLines(...)`. That dropped await is
  // invisible in the rows (the floating delete still lands before the insert
  // batch in a test, and the step log still reads delete-then-insert) but
  // guarantees nothing in the real runtime, where the delete could land AFTER
  // the insert and empty the order it just filled. The failing statement is
  // what separates them: awaited, this is a `failed` job; floating, the
  // rejection is lost and the job reports `done` over duplicated lines.
  it("stops on a failed delete rather than inserting the new lines on top of the old ones", async () => {
    seedOrderLine({ id: 960, order_id: ORDER_ROW, name: "Previously Parsed Line", weight: 4321 });
    const h = harness({ failSql: /DELETE FROM orderline/ });

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(jobRow().status).toBe("failed");
    expect(jobRow().error).toBe("D1_ERROR: Network connection lost");
    expect(lineRows().map((row) => ({ name: row.name, weight: row.weight }))).toEqual([{ name: "Previously Parsed Line", weight: 4321 }]);
    expect(aggregates()).toEqual({ weight: 0, calories: 0, cost: 0, no_lines: 0, no_items: 0 });
    expect(h.steps).not.toContain("write:insert-line");
  });

  // The mirror image, one statement later, and the worst of the partial
  // states: the LINES are written and the ORDER still reports the zeroes
  // orderForm.ts left behind. /api/2/orders/ and the deliveries dashboard read
  // those five columns, so this order contributes 0kg and 0 items to the
  // public totals while its own page lists two items -- wrong data on a
  // correct-looking page, with only the job row saying so.
  //
  // It also kills `void setOrderAggregates(...)`, the last surviving
  // dropped-await mutant: with the await gone the rejection floats away, the
  // handler runs on and marks the job DONE, and this order's zeroes are then
  // reported as a successful parse with nothing anywhere to contradict them.
  it("fails the job when the aggregate write fails, leaving lines written over zeroed totals", async () => {
    const h = harness({ failSql: /UPDATE orders SET weight/ });

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(jobRow().status).toBe("failed");
    expect(jobRow().error).toBe("D1_ERROR: Network connection lost");
    expect(lineRows().map((row) => row.name)).toEqual(["Tesco Baked Beans 400g", "Yorkshire Tea 250g"]);
    expect(aggregates()).toEqual({ weight: 0, calories: 0, cost: 0, no_lines: 0, no_items: 0 });
    // ...and the restamp after it never ran either.
    expect(foodbankRow(SALISBURY).last_order).toBeNull();
  });

  // The last write of all. Everything the order needs is already correct and
  // committed, yet the job reports `failed` with no result payload -- so the
  // admin's only signal says the parse did not work when it did, and pressing
  // the button again spends another paid Gemini call (at temperature 1, on
  // input that may now parse differently) to fix a stale food bank date.
  it("reports failure for a parse that fully succeeded when only the last_order restamp fails", async () => {
    const h = harness({ failSql: /UPDATE foodbank SET last_order/ });

    await handleOrderLinesJob(h.env, JOB, ORDER_ROW);

    expect(jobRow().status).toBe("failed");
    expect(jobRow().result).toBeNull();
    expect(aggregates()).toEqual({ weight: 1050, calories: 0, cost: 410, no_lines: 2, no_items: 3 });
    expect(foodbankRow(SALISBURY).last_order).toBeNull();
  });

  // THE RECOVERY PATH the transient-error test above says is the only fix
  // available ("press the button again"), driven end to end: a first delivery
  // fails on a 400, a second succeeds, and the order comes out correct.
  //
  // The stale `error` is the point. markAdminJobDone (packages/db/src/
  // adminJobs.ts:36-41) writes status, result and finished and does NOT clear
  // `error`, so the row ends up `done` and carrying the previous failure's
  // sentence at the same time. Harmless TODAY only because both renderers gate
  // on status -- templates/admin/order.njk:13-19 shows the danger banner for
  // `failed` and a plain "Order lines parsed." for `done`, and
  // routes/admin/foodbankCheck.ts:140-147 redirects rather than rendering the
  // error. Anything that starts showing `job.error` whenever it is present
  // would report a succeeded parse as a failed one. Pinned, and reported.
  it("recovers on a redelivery after a failure, but leaves the old error text on the done row", async () => {
    freezeClock(true);
    const failing = harness({ reply: () => new Response("API key not valid", { status: 400 }) });
    const firstRun = handleOrderLinesJob(failing.env, JOB, ORDER_ROW);
    await vi.advanceTimersByTimeAsync(60_000);
    await firstRun;
    expect(jobRow().status).toBe("failed");

    const succeeding = harness();
    await handleOrderLinesJob(succeeding.env, JOB, ORDER_ROW);

    expect(jobRow().status).toBe("done");
    expect(JSON.parse(jobRow().result as string)).toEqual({ order_id: ORDER_ID, no_lines: 2, no_items: 3 });
    expect(lineRows().map((row) => row.name)).toEqual(["Tesco Baked Beans 400g", "Yorkshire Tea 250g"]);
    expect(aggregates()).toEqual({ weight: 1050, calories: 0, cost: 410, no_lines: 2, no_items: 3 });
    // The suspect part: a `done` row that still says why it once failed.
    expect(jobRow().error).toBe("Gemini API error: 400 API key not valid");
  });
});
