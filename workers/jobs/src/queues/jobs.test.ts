import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS_SQL } from "@givefood/db/src/schema.testkit";
import { handleJobsQueue } from "./jobs";
import type { Env } from "../../worker-configuration";
// @ts-ignore -- this Worker's tsconfig lists only @cloudflare/workers-types, so
// node:sqlite has no declarations here. It is real under vitest's node
// environment, and adding "node" to workers/jobs/tsconfig.json would be a
// config change rather than a test change. Same suppression, same reasoning, as
// packages/db/src/schema.testkit.ts:35 and queues/articles.test.ts:10.
import { DatabaseSync } from "node:sqlite";

// queues/jobs.ts -- the JOBS_Q consumer. It is a router: eight message types,
// seven downstream handlers, one `default` that throws.
//
// WHY A ROUTER NEEDS THIS MUCH TEST. Nothing watches this queue. It carries
// the admin's foodbank-check and order-lines jobs, the four need-notification
// channels, the translate fan-out and every R2 media miss, and its ONLY
// observable output on a bad day is a line in `wrangler tail` -- which is
// exactly how a Browser Rendering credential broke for a day unnoticed and how
// jobs-dlq filled with messages whose log line named the queue and not the
// message (see queues/jobsDlq.ts's own header).
//
// The interesting property of this file is not "does it call a function". It
// is WHICH SIDE OF THE ACK/RETRY LINE each job type falls on, because the two
// sides are wired to completely different outcomes:
//
//   ack   -> the message is gone. A foodbank-check that failed shows its
//            failure on the admin's polling page; a notification whose
//            upstream was down is simply not sent, and that is deliberate.
//   retry -> wrangler.jsonc's `{"queue": "jobs", "max_retries": 3,
//            "dead_letter_queue": "jobs-dlq"}`: three more attempts, then
//            jobsDlq.ts logs it and drops it.
//
// Put a paid Gemini call on the retry side and one failure becomes four. Put
// an R2 backfill on the ack side and the photo is never fetched and never
// reported. Every test below pins one job type to one side and says why.
//
// REAL THINGS, NOT MOCKS:
//   * node:sqlite carrying the WHOLE real migration set (MIGRATIONS_SQL, not
//     schemaFor(...)): this consumer reaches foodbank, foodbankchange (through
//     the foodbankchange_full VIEW), admin_job, orders, orderline, orderitem,
//     crawlitem, placephoto, foodbankchangetranslation and whatsappsubscriber
//     through ~20 shared packages/db functions. A narrow hand-built fixture
//     here would be the github #51 gap waiting to happen.
//   * ALL SEVEN downstream handlers, for real. jobs.ts imports them statically,
//     so there is no seam to stub even if stubbing them were desirable -- and
//     it is not: a router tested against seven fakes proves only that the
//     author's fakes match the author's switch statement.
//   * the real packages/db queries, running their real SQL.
//
// MOCKED, and only this: `fetch` (Google Static Maps, Places Details/Photo,
// Cloud Translation, Gemini and Meta's Graph API -- everything that leaves the
// machine and everything that is BILLED), the R2 bucket (workerd's R2 has no
// node-side double), and Queue.send.
//
// NOT EXERCISED, and deliberately: any path through `HTMLRewriter` (undefined
// in a node environment -- foodbank-check's page fetches below all answer
// non-200, which returns before the rewriter is constructed) and any path
// through `render()` from @givefood/templates (needs the gitignored
// precompiled bundle). Both belong to those modules' own suites.

// ===========================================================================
// HARNESS
// ===========================================================================

type Bindable = null | number | bigint | string | Uint8Array;

interface SqliteStatement {
  all(...params: Bindable[]): Record<string, unknown>[];
  get(...params: Bindable[]): Record<string, unknown> | undefined;
  run(...params: Bindable[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

let db: SqliteDatabase;

/** Fail the next D1 statement whose SQL this returns an Error for. */
let failIf: ((sql: string, params: Bindable[]) => Error | null) | null;

/** Ordered trace of the observable side effects, for the batch-ordering tests. */
let events: string[];

/**
 * The D1 Sessions API surface packages/db uses, over the real engine.
 *
 * `batch()` is not optional decoration: getFoodbankBySlug (reached by BOTH
 * media-backfill shapes and by foodbank-check) is implemented as a batch and
 * indexes `results[0]!.results`, and insertOrderLines writes every order line
 * in one. A session double without it fails those three job types with a
 * TypeError that the outer catch would turn into a retry -- i.e. it would look
 * exactly like the infrastructure failure these tests are trying to tell apart
 * from a working dispatch.
 *
 * `first()` answers null, never undefined, because handlers test `if (!row)`.
 */
interface BatchableStatement {
  __exec: () => { results: Record<string, unknown>[]; success: true; meta: Record<string, unknown> };
}

function d1Session(): unknown {
  function statement(sql: string, params: Bindable[]): unknown {
    const guard = (): void => {
      const err = failIf?.(sql, params);
      if (err) throw err;
    };
    return {
      bind: (...values: unknown[]) => statement(sql, values as Bindable[]),
      first: async <T>() => {
        guard();
        return (db.prepare(sql).get(...params) ?? null) as T | null;
      },
      all: async <T>() => {
        guard();
        return { results: db.prepare(sql).all(...params) as T[], success: true, meta: {} };
      },
      run: async () => {
        guard();
        const result = db.prepare(sql).run(...params);
        return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
      // node:sqlite's all() executes writes perfectly well and answers [], so
      // one code path serves both halves of a batch.
      __exec: () => {
        guard();
        return { results: db.prepare(sql).all(...params), success: true as const, meta: {} };
      },
    };
  }
  return {
    prepare: (sql: string) => statement(sql, []),
    batch: async (statements: BatchableStatement[]) => statements.map((s) => s.__exec()),
    getBookmark: () => null,
  };
}

// ---------------------------------------------------------------------------
// R2
// ---------------------------------------------------------------------------

interface StoredObject {
  key: string;
  body: Uint8Array;
  etag: string;
  httpMetadata: Record<string, unknown>;
}

let media: Map<string, StoredObject>;
/** Set to make the next MEDIA.put reject, for the "R2 is down" test. */
let mediaPutError: Error | null;
let etagCounter: number;

/**
 * An in-memory R2 bucket. R2 is the one dependency here with no local double at
 * all, so this is a stand-in rather than the real thing -- but it is a stand-in
 * with real semantics for the two operations that carry logic: `head` answers
 * null for a key that was never put (backfillPlacePhoto's idempotency guard
 * hangs off exactly that), and `put` answers an object whose `etag` is the value
 * stored as `placephoto.md5`. The etag is a counter so a test can prove the md5
 * came from the put result and not from anywhere else.
 */
function mediaBucket(): unknown {
  return {
    head: async (key: string) => media.get(key) ?? null,
    get: async (key: string) => media.get(key) ?? null,
    put: async (key: string, value: ArrayBuffer, options?: { httpMetadata?: Record<string, unknown> }) => {
      events.push(`r2put ${key}`);
      if (mediaPutError) throw mediaPutError;
      const bytes = new Uint8Array(value);
      const stored: StoredObject = { key, body: bytes, etag: `etag-${++etagCounter}`, httpMetadata: options?.httpMetadata ?? {} };
      media.set(key, stored);
      return stored;
    },
  };
}

// ---------------------------------------------------------------------------
// The network
// ---------------------------------------------------------------------------

/** A modelled reply. An Error means the fetch itself rejected (DNS, TLS, abort). */
type Reply = { status: number; body: string | Uint8Array } | Error;

interface FetchCall {
  url: string;
  method: string;
  body: string;
}

let replies: Map<string, Reply[]>;
let fetchCalls: FetchCall[];

/** origin + pathname, i.e. the URL with its query string (which carries the API keys) dropped. */
function routeKey(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

function reply(route: string, ...queue: Reply[]): void {
  replies.set(route, queue);
}

function stubFetch(): void {
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    fetchCalls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : "" });
    events.push(`fetch ${routeKey(url)}`);
    // A REAL asynchronous boundary. handleJobsQueue awaits each message in
    // turn, and the only way to tell that apart from a Promise.all over the
    // batch is to make the work actually yield -- see "processes a batch one
    // message at a time".
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queue = replies.get(routeKey(url));
    // An unmodelled URL is a test bug, never a silent default: a billed call
    // this router grows later must fail loudly here rather than be absorbed by
    // a handler's own catch-everything block.
    if (!queue || queue.length === 0) throw new Error(`unmodelled fetch: ${url}`);
    const next = queue.length === 1 ? queue[0]! : queue.shift()!;
    if (next instanceof Error) throw next;
    return new Response(next.body as BodyInit, { status: next.status });
  });
}

const GOOGLE_STATIC_MAP = "https://maps.googleapis.com/maps/api/staticmap";
const GOOGLE_PLACE_DETAILS = "https://maps.googleapis.com/maps/api/place/details/json";
const GOOGLE_PLACE_PHOTO = "https://maps.googleapis.com/maps/api/place/photo";
const GOOGLE_TRANSLATE = "https://translation.googleapis.com/language/translate/v2";
const GEMINI_FLASH_25 = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const GEMINI_FLASH_20 = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";
const GRAPH_MESSAGES = "https://graph.facebook.com/v24.0/890504590819478/messages";
const SALISBURY_HOMEPAGE = "https://salisburyfoodbank.example/";

/** Real magic bytes, so "what landed in R2" is a byte comparison rather than a length one. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

/** A Gemini generateContent success, whose single text part is the JSON the caller parses. */
function geminiReply(payload: unknown): Reply {
  return { status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }) };
}

// ---------------------------------------------------------------------------
// Queues and the env
// ---------------------------------------------------------------------------

let jobsSend: ReturnType<typeof vi.fn>;
let purgeSend: ReturnType<typeof vi.fn>;
let env: Env;

function buildEnv(): Env {
  return {
    DB: { withSession: () => d1Session() },
    MEDIA: mediaBucket(),
    JOBS_Q: { send: jobsSend },
    PURGE_Q: { send: purgeSend },
    GMAP_STATIC_KEY: "static-maps-key",
    GMAP_PLACES_KEY: "places-key",
    GCP_TRANSLATE_KEY: "translate-key",
    GEMINI_API_KEY: "gemini-key",
    SITE_DOMAIN: "https://www.givefood.org.uk",
    // The four notification credentials start EMPTY, which is the state the
    // account is actually in for three of them (PLAN.md WP 6.4b). Tests that
    // need a channel to get past its credential gate set it themselves.
    POSTMARK_TOKEN: "",
    WHATSAPP_TOKEN: "",
    FIREBASE_SERVICE_ACCOUNT: "",
    VAPID_PRIVATE_KEY: "",
    VAPID_PUBLIC_KEY: "",
    VAPID_ADMIN_EMAIL: "",
  } as unknown as Env;
}

// ---------------------------------------------------------------------------
// The batch
// ---------------------------------------------------------------------------

type JobsBatch = Parameters<typeof handleJobsQueue>[0];

interface FakeMessage {
  id: string;
  body: unknown;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
}

interface FakeBatch {
  batch: JobsBatch;
  messages: FakeMessage[];
  ackAll: ReturnType<typeof vi.fn>;
  retryAll: ReturnType<typeof vi.fn>;
}

/**
 * A MessageBatch whose per-message ack/retry are observable. `ackAll`/`retryAll`
 * are present and asserted never to be called: wrangler.jsonc gives this queue
 * `max_batch_size: 10`, and a batch of ten can easily hold one poison message
 * and nine good ones. Settling the batch as a unit would either replay nine
 * successful media backfills or discard nine live notifications.
 */
function batchOf(...bodies: unknown[]): FakeBatch {
  const messages: FakeMessage[] = bodies.map((body, index) => {
    const label = (body as { type?: unknown } | null)?.type ?? "?";
    return {
      id: `msg-${index + 1}`,
      body,
      ack: vi.fn(() => void events.push(`ack ${String(label)}`)),
      retry: vi.fn(() => void events.push(`retry ${String(label)}`)),
    };
  });
  const ackAll = vi.fn();
  const retryAll = vi.fn();
  return {
    batch: { queue: "jobs", messages, ackAll, retryAll } as unknown as JobsBatch,
    messages,
    ackAll,
    retryAll,
  };
}

async function run(...bodies: unknown[]): Promise<FakeBatch> {
  const fake = batchOf(...bodies);
  await handleJobsQueue(fake.batch, env);
  return fake;
}

/** The one-message case, which is most of this file. */
async function runOne(body: unknown): Promise<FakeMessage> {
  const fake = await run(body);
  return fake.messages[0]!;
}

// ===========================================================================
// FIXTURES
// ===========================================================================

// The clock is frozen so admin_job.finished and crawlitem.start/finish can be
// asserted as EXACT strings. Only Date is faked -- gemini.ts's 60s retry sleep
// and foodbankCheck.ts's 750ms anti-bot sleep use real setTimeout, and no test
// below takes a path that reaches either (a Gemini 5xx and a page 403/429 are
// the only two triggers, and neither is modelled).
const NOW = new Date("2026-09-08T11:04:19.512Z");
/** Django's str(datetime): a space, six fractional digits, no "T", no "Z". */
const DJANGO_NOW = "2026-09-08 11:04:19.512000";

// Deliberately unequal ids everywhere. jobId/foodbankSlug and jobId/orderRowId
// are adjacent fields in one object literal and are handed to the handlers as
// two positional arguments, so a fixture where any two coincide cannot see a
// transposition.
const SALISBURY = 22;
const DUNDEE = 41;
const NEED_ID = 6031;
const ORDER_ROW = 88;

interface FoodbankSeed {
  id: number;
  slug: string;
  name?: string;
  latLng?: string;
  placeId?: string | null;
  placeHasPhoto?: 0 | 1 | null;
  url?: string;
  shoppingListUrl?: string;
  phoneNumber?: string | null;
  noLocations?: number;
  noDonationPoints?: number | null;
}

/**
 * Fills every NOT NULL column the real foodbank table declares, so a seeded row
 * is one production would actually accept.
 */
function seedFoodbank(seed: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank (
       id, uuid, name, slug, address, postcode, country, lat_lng,
       charity_just_foodbank, contact_email, url, shopping_list_url,
       phone_number, place_id, place_has_photo,
       address_is_administrative, is_closed, no_locations, no_donation_points,
       days_between_needs, created, modified
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 14, ?, ?)`,
  ).run(
    seed.id,
    `uuid-${seed.slug}`,
    seed.name ?? seed.slug,
    seed.slug,
    "1 High Street",
    "SP1 1AA",
    "England",
    seed.latLng ?? "51.0688,-1.7945",
    `info@${seed.slug}.example`,
    seed.url ?? `https://${seed.slug}.example/`,
    seed.shoppingListUrl ?? `https://${seed.slug}.example/shopping-list/`,
    seed.phoneNumber ?? null,
    seed.placeId ?? null,
    seed.placeHasPhoto ?? null,
    seed.noLocations ?? 0,
    seed.noDonationPoints ?? 0,
    "2020-01-01 00:00:00.000000",
    "2026-08-01 09:15:22.412000",
  );
}

function seedNeed(row: { id: number; foodbankId: number | null; changeText: string; excessChangeText?: string | null }): void {
  db.prepare(
    `INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, excess_change_text, published, input_method, created, modified)
     VALUES (?, ?, ?, ?, ?, 1, 'manual', ?, ?)`,
  ).run(row.id, `need-uuid-${row.id}`, row.foodbankId, row.changeText, row.excessChangeText ?? null, DJANGO_NOW, DJANGO_NOW);
}

function seedAdminJob(row: { id: string; kind: string; target: string | null }): void {
  db.prepare("INSERT INTO admin_job (id, kind, target, status, created) VALUES (?, ?, ?, 'queued', ?)").run(
    row.id,
    row.kind,
    row.target,
    "2026-09-08 11:04:00.000000",
  );
}

function seedOrder(row: { id: number; orderId: string; itemsText: string; foodbankId: number | null; deliveryDate: string }): void {
  db.prepare(
    `INSERT INTO orders (
       id, order_id, items_text, country, created, modified,
       delivery_date, delivery_hour, delivery_datetime,
       weight, calories, cost, no_lines, no_items, foodbank_id
     ) VALUES (?, ?, ?, 'England', ?, ?, ?, 10, ?, 0, 0, 0, 0, 0, ?)`,
  ).run(row.id, row.orderId, row.itemsText, DJANGO_NOW, DJANGO_NOW, row.deliveryDate, `${row.deliveryDate} 10:00:00`, row.foodbankId);
}

function adminJob(id: string): Record<string, unknown> | undefined {
  return db.prepare("SELECT id, kind, target, status, result, error, finished FROM admin_job WHERE id = ?").get(id);
}

function rows(sql: string, ...params: Bindable[]): Record<string, unknown>[] {
  return db.prepare(sql).all(...params);
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/** Every console.error call, joined -- the queue's only visible output on a failure. */
let errors: string[];
let warns: string[];
let infos: string[];
/** The raw argument lists, because the failure log's SECOND argument is the message body itself. */
let errorArgs: unknown[][];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);

  db = new DatabaseSync(":memory:") as unknown as SqliteDatabase;
  db.exec(MIGRATIONS_SQL);
  failIf = null;

  media = new Map();
  mediaPutError = null;
  etagCounter = 0;

  replies = new Map();
  fetchCalls = [];
  events = [];
  errors = [];
  warns = [];
  infos = [];
  errorArgs = [];

  jobsSend = vi.fn(async (body: unknown) => void events.push(`jobs-q ${(body as { type?: string }).type}`));
  purgeSend = vi.fn(async () => undefined);

  stubFetch();
  env = buildEnv();

  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errorArgs.push(args);
    errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warns.push(args.map((a) => String(a)).join(" ")));
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void infos.push(args.map((a) => String(a)).join(" ")));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  db.close();
});

// ===========================================================================
// media-backfill
// ===========================================================================
//
// PLAN.md §3.7: workers/site's routes/media.ts 404s an R2 miss immediately and
// enqueues one of these, so the billed Google call never sits inside a user's
// request. That makes this the job type where an ack on failure is most
// expensive: the object stays missing, the page keeps 404ing its image, and
// nothing anywhere says so.

describe("media-backfill: map images", () => {
  beforeEach(() => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", name: "Salisbury Foodbank", latLng: "51.0688,-1.7945" });
    seedFoodbank({ id: DUNDEE, slug: "dundee", name: "Dundee Foodbank", latLng: "56.4620,-2.9707" });
    reply(GOOGLE_STATIC_MAP, { status: 200, body: PNG_BYTES });
  });

  // The whole point of the branch, asserted as BYTES IN R2 rather than as "it
  // resolved". `center` is read back out of the food bank row, so asserting it
  // proves the SLUG inside the message's `key` reached the lookup -- a router
  // that handed the handler a constant would still have made a request.
  it("routes a map.png key to the Static Maps backfill and stores the PNG under that exact key", async () => {
    const message = await runOne({ type: "media-backfill", key: "media/needs/at/salisbury/map.png" });

    const stored = media.get("media/needs/at/salisbury/map.png");
    expect(stored).toBeDefined();
    expect(Array.from(stored!.body)).toEqual(Array.from(PNG_BYTES));
    // PLAN.md §3.7's httpMetadata shape, matching Django's @cache_page(SECONDS_IN_WEEK).
    expect(stored!.httpMetadata).toEqual({ contentType: "image/png", cacheControl: "public, max-age=604800" });

    const params = new URL(fetchCalls[0]!.url).searchParams;
    expect(params.get("center")).toBe("51.0688,-1.7945"); // Salisbury's row, not Dundee's
    expect(params.get("key")).toBe("static-maps-key"); // env.GMAP_STATIC_KEY, i.e. the real env reached the handler
    expect(params.get("size")).toBe("600x400"); // the default 600 config

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    // Nothing else was written. A key naming one food bank must not touch another.
    expect([...media.keys()]).toEqual(["media/needs/at/salisbury/map.png"]);
  });

  // The sized variant, which is the same branch with the size read out of the
  // key rather than defaulted. Included because `maps/<size>.png` and
  // `map.png` are two alternations of ONE regex, and a router that only ever
  // sees the bare form cannot notice the other alternation rotting.
  it("carries the size out of a maps/<size>.png key into the Static Maps request", async () => {
    const message = await runOne({ type: "media-backfill", key: "media/needs/at/dundee/maps/300.png" });

    const params = new URL(fetchCalls[0]!.url).searchParams;
    expect(params.get("center")).toBe("56.4620,-2.9707");
    expect(params.get("size")).toBe("150x150");
    expect(params.get("scale")).toBe("2");
    expect(media.has("media/needs/at/dundee/maps/300.png")).toBe(true);
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  // GOOGLE BEING DOWN IS A RETRY, NOT AN ACK. fetchStaticMapPng throws on a
  // non-ok response, nothing in backfillMapImage catches it, so it reaches
  // handleJobsQueue's catch. That is the correct side: a 500 from Google is
  // transient, and three more attempts over the next few minutes is exactly
  // what should happen. An ack here would leave the map permanently missing.
  it("retries when Google Static Maps answers 5xx, and stores nothing", async () => {
    reply(GOOGLE_STATIC_MAP, { status: 503, body: "upstream unavailable" });

    const message = await runOne({ type: "media-backfill", key: "media/needs/at/salisbury/map.png" });

    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
    expect(media.size).toBe(0);
    expect(errors[0]).toContain(`givefood2-jobs: "jobs" message failed`);
    expect(errors[0]).toContain("staticmap: upstream 503");
  });

  // R2 itself failing. The put is the LAST thing that happens, so this is the
  // case where the billed Google call has already been made and paid for --
  // and the retry will make it again. Pinned as the cost of the current
  // ordering rather than presented as ideal.
  it("retries when the R2 put fails, having already paid for the Google call", async () => {
    mediaPutError = new Error("R2: internal error");

    const message = await runOne({ type: "media-backfill", key: "media/needs/at/salisbury/map.png" });

    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(1);
    expect(media.size).toBe(0);
  });

  // A slug deleted between the R2 miss and this dequeue. backfillFoodbankMap
  // throws rather than returning quietly, so the message retries three times
  // and reaches jobs-dlq -- where jobsDlq.ts logs `media-backfill key=...`.
  // That is the right end for it: nothing else in the system would ever
  // mention a media key that can never be satisfied.
  it("retries a map key for a food bank that no longer exists, without calling Google", async () => {
    const message = await runOne({ type: "media-backfill", key: "media/needs/at/vanished/map.png" });

    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toEqual([]);
    expect(errors[0]).toContain("media-backfill: no foodbank for slug vanished");
  });

  // AT-LEAST-ONCE, AND THE MAP BRANCH DOES NOT DEFEND AGAINST IT. Cloudflare
  // Queues can deliver the same message twice, and routes/media.ts can enqueue
  // twice for two requests racing the same 404. backfillPlacePhoto has an
  // `env.MEDIA.head(key)` guard for exactly this (see the photo block below);
  // backfillMapImage has none, so a redelivery buys a second Static Maps call
  // and overwrites the identical object.
  //
  // SUSPECT, pinned rather than fixed: this is a billed call with no
  // idempotency guard, and it is the asymmetry with the photo branch that
  // makes it look unintended rather than chosen.
  it("SUSPECT: re-fetches and re-puts a map on a redelivery, with no R2 head guard", async () => {
    const body = { type: "media-backfill", key: "media/needs/at/salisbury/map.png" };

    const fake = await run(body, body);

    expect(fetchCalls.filter((call) => routeKey(call.url) === GOOGLE_STATIC_MAP)).toHaveLength(2);
    expect(events.filter((e) => e === "r2put media/needs/at/salisbury/map.png")).toHaveLength(2);
    expect(fake.messages.every((m) => m.ack.mock.calls.length === 1)).toBe(true);
  });
});

describe("media-backfill: place photos", () => {
  beforeEach(() => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", placeId: "ChIJsalisbury", placeHasPhoto: 1 });
    // A DECOY PLACE. Every assertion below names ChIJsalisbury, and with only
    // one food bank in the table a lookup that had lost its WHERE would answer
    // the same row and pass regardless -- exactly the shape of hole the map
    // block avoids by seeding Dundee alongside Salisbury. This gives the photo
    // block the same protection.
    seedFoodbank({ id: DUNDEE, slug: "dundee", placeId: "ChIJdundee", placeHasPhoto: 1 });
    reply(GOOGLE_PLACE_DETAILS, { status: 200, body: JSON.stringify({ status: "OK", result: { photos: [{ photo_reference: "PHOTOREF-1", html_attributions: ["<a>Someone</a>"] }] } }) });
    reply(GOOGLE_PLACE_PHOTO, { status: 200, body: JPEG_BYTES });
  });

  // The other media branch, and the one with a database write of its own. The
  // placephoto row is what makes a second miss cheap for ever after, so the
  // assertion reads the ROW, not just the bucket.
  it("routes a photo.jpg key to the Places backfill, stores the JPEG and records the placephoto row", async () => {
    const message = await runOne({ type: "media-backfill", key: "media/needs/at/salisbury/photo.jpg" });

    const stored = media.get("media/needs/at/salisbury/photo.jpg");
    expect(Array.from(stored!.body)).toEqual(Array.from(JPEG_BYTES));
    expect(stored!.httpMetadata).toEqual({ contentType: "image/jpeg", cacheControl: "public, max-age=604800" });

    expect(rows("SELECT place_id, photo_ref, html_attributions, r2_key, bytes, md5 FROM placephoto")).toEqual([
      {
        place_id: "ChIJsalisbury",
        photo_ref: "PHOTOREF-1",
        html_attributions: "<a>Someone</a>",
        r2_key: "media/needs/at/salisbury/photo.jpg",
        bytes: JPEG_BYTES.byteLength,
        // The etag the put ANSWERED, proving md5 comes from the R2 result
        // rather than being recomputed or defaulted somewhere.
        md5: "etag-1",
      },
    ]);

    // Two billed calls, in order, both carrying env.GMAP_PLACES_KEY.
    expect(fetchCalls.map((c) => routeKey(c.url))).toEqual([GOOGLE_PLACE_DETAILS, GOOGLE_PLACE_PHOTO]);
    expect(new URL(fetchCalls[0]!.url).searchParams.get("place_id")).toBe("ChIJsalisbury");
    expect(new URL(fetchCalls[1]!.url).searchParams.get("key")).toBe("places-key");
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  // THE GUARD THE MAP BRANCH LACKS. Two deliveries of the same photo message
  // must buy exactly one photo: Google Place Photo is billed per call, and
  // routes/media.ts's 404-and-enqueue can genuinely fire twice for one image
  // (its own 10-second window). The second delivery still ACKS -- "already
  // there" is success, not failure.
  it("buys the photo once across a redelivery, because the R2 head guard sees it", async () => {
    const body = { type: "media-backfill", key: "media/needs/at/salisbury/photo.jpg" };

    const fake = await run(body, body);

    expect(fetchCalls.filter((c) => routeKey(c.url) === GOOGLE_PLACE_PHOTO)).toHaveLength(1);
    expect(rows("SELECT id FROM placephoto")).toHaveLength(1);
    expect(infos).toContain("media-backfill: media/needs/at/salisbury/photo.jpg already in R2");
    expect(fake.messages[1]!.ack).toHaveBeenCalledTimes(1);
    expect(fake.messages[1]!.retry).not.toHaveBeenCalled();
  });

  // "This place has no photograph" is a permanent, correct answer, so it acks
  // rather than burning three retries and a dead letter on it. Contrast the
  // Static Maps 503 above, which is transient and does retry -- the two live
  // in the same `media-backfill` case of the switch and settle differently,
  // which is the whole reason this pair is here.
  it("acks quietly when Google says the place has no photo", async () => {
    reply(GOOGLE_PLACE_DETAILS, { status: 200, body: JSON.stringify({ status: "ZERO_RESULTS" }) });

    const message = await runOne({ type: "media-backfill", key: "media/needs/at/salisbury/photo.jpg" });

    expect(media.size).toBe(0);
    expect(rows("SELECT id FROM placephoto")).toEqual([]);
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  // OVER_QUERY_LIMIT / REQUEST_DENIED, which are about US rather than about the
  // place, do retry -- and REQUEST_DENIED in particular is the shape a broken
  // or unbilled API key takes. This is the credential-broke-silently case:
  // three retries and then a jobs-dlq line naming the key.
  it("retries when Place Details answers a status that means our key is the problem", async () => {
    reply(GOOGLE_PLACE_DETAILS, { status: 200, body: JSON.stringify({ status: "REQUEST_DENIED" }) });

    const message = await runOne({ type: "media-backfill", key: "media/needs/at/salisbury/photo.jpg" });

    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
    expect(errors[0]).toContain("Place Details status REQUEST_DENIED for ChIJsalisbury");
  });
});

describe("media-backfill: keys this consumer cannot satisfy", () => {
  // The module comment is explicit that screenshots/*.png "still throws" and
  // that favicon.png "never will be" implemented here (routes/wfbn/favicon.ts
  // fetches Google's keyless service live instead). Both therefore end at
  // jobs-dlq. Pinned because the alternative -- acking an unimplemented key --
  // would make an enqueue for one of these completely invisible.
  it.each([
    ["media/needs/at/salisbury/screenshots/homepage.png", "screenshots"],
    ["media/needs/at/salisbury/favicon.png", "favicon"],
    ["media/needs/at/salisbury/", "a trailing-slash prefix"],
    ["not-a-media-key-at-all", "a key from another namespace"],
  ])("retries %s (%s) rather than acking an unsatisfiable key", async (key) => {
    const message = await runOne({ type: "media-backfill", key });

    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
    expect(errors[0]).toContain(`media-backfill: not implemented (key=${key})`);
    expect(fetchCalls).toEqual([]);
    expect(media.size).toBe(0);
  });

  // A media-backfill message with no key at all -- the shape a producer bug
  // would send. `isMapImageKey(undefined)` stringifies to "undefined" and does
  // not match, so this lands on the same not-implemented throw rather than
  // crashing differently. The log line still identifies what arrived.
  it("retries a media-backfill message with no key, naming it as undefined", async () => {
    const message = await runOne({ type: "media-backfill" });

    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(errors[0]).toContain("media-backfill: not implemented (key=undefined)");
  });
});

// ===========================================================================
// translate-need
// ===========================================================================
//
// WP 6.4: enqueued by workers/site's admin need_publish handler, one message
// per language per publish. This is the ONLY job type whose upstream failure
// retries -- Google Cloud Translation is cheap, idempotent and transient, and
// an untranslated need is a visible gap on the Welsh/Irish/Gaelic pages.

describe("translate-need", () => {
  beforeEach(() => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedNeed({ id: NEED_ID, foodbankId: SALISBURY, changeText: "Beans\nPasta\nUHT Milk" });
    reply(GOOGLE_TRANSLATE, { status: 200, body: JSON.stringify({ data: { translations: [{ translatedText: "Ffa\nPasta\nLlaeth UHT" }] } }) });
  });

  // Reading the stored row rather than the resolved promise. The message
  // carries BOTH needId and language, and both have to survive the cast at
  // jobs.ts:35 -- a router that passed a reconstructed `{needId}` would drop
  // the language and translate everything into whatever the default was.
  it("routes to the translation handler and writes the row for the language in the message", async () => {
    const message = await runOne({ type: "translate-need", needId: NEED_ID, language: "cy" });

    expect(rows("SELECT need_id, foodbank_id, language, change_text, excess_change_text FROM foodbankchangetranslation")).toEqual([
      { need_id: NEED_ID, foodbank_id: SALISBURY, language: "cy", change_text: "Ffa\nPasta\nLlaeth UHT", excess_change_text: null },
    ]);

    const sent = new URLSearchParams(fetchCalls[0]!.body);
    expect(sent.get("q")).toBe("Beans\nPasta\nUHT Milk"); // the need's own text, so needId routed
    expect(sent.get("target")).toBe("cy"); // ...and the language routed with it
    expect(sent.get("source")).toBe("en");
    expect(new URL(fetchCalls[0]!.url).searchParams.get("key")).toBe("translate-key");
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  // THE LANGUAGE IS NOT ALWAYS "cy", AND NEITHER IS THE NEED. Every other
  // translate-need test in this file uses Welsh and one seeded need, which
  // leaves two mutants alive: `handleTranslateNeed({...body, language: "cy"})`
  // (a rebuilt message rather than jobs.ts:36's whole-body cast) and a need
  // lookup that answered any row rather than the one the message names. Both
  // survived a mutation run before this test existed.
  //
  // Neither is theoretical. need_publish enqueues ONE MESSAGE PER LANGUAGE, so
  // a router that pinned the language would write the Welsh text into the Irish
  // and Gaelic rows and all three public locales would agree with each other
  // and be wrong -- the failure mode nobody who reads only English would spot.
  it("carries a language other than Welsh, and the need the message names, through the cast", async () => {
    // A second need with a LOWER id, so a lookup that lost its WHERE and took
    // whatever came first would translate this text instead of the message's.
    seedNeed({ id: NEED_ID - 1, foodbankId: SALISBURY, changeText: "Nappies\nTinned fish" });
    reply(GOOGLE_TRANSLATE, { status: 200, body: JSON.stringify({ data: { translations: [{ translatedText: "Pònair\nPasta\nBainne UHT" }] } }) });

    const message = await runOne({ type: "translate-need", needId: NEED_ID, language: "gd" });

    expect(rows("SELECT need_id, language, change_text FROM foodbankchangetranslation")).toEqual([
      { need_id: NEED_ID, language: "gd", change_text: "Pònair\nPasta\nBainne UHT" },
    ]);
    const sent = new URLSearchParams(fetchCalls[0]!.body);
    expect(sent.get("target")).toBe("gd"); // NOT "cy"
    expect(sent.get("q")).toBe("Beans\nPasta\nUHT Milk"); // NOT the decoy need's text
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  // The retry side, and the contrast that gives this whole file its shape:
  // an upstream failure here RETRIES, where the same failure in a notify
  // channel or an admin job acks. translateText throws on a non-ok response
  // and nothing catches it.
  it("retries when Google Translate fails, unlike every other upstream in this router", async () => {
    reply(GOOGLE_TRANSLATE, { status: 429, body: "rate limited" });

    const message = await runOne({ type: "translate-need", needId: NEED_ID, language: "gd" });

    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
    expect(rows("SELECT id FROM foodbankchangetranslation")).toEqual([]);
    expect(errors[0]).toContain("Google Translate API failed: 429");
  });

  // The need deleted (or re-published, then deleted) between enqueue and
  // dequeue. handleTranslateNeed returns without touching anything, which acks
  // -- correct, because there is nothing to translate and never will be.
  it("acks without calling Google when the need was deleted since enqueue", async () => {
    db.prepare("DELETE FROM foodbankchange WHERE id = ?").run(NEED_ID);

    const message = await runOne({ type: "translate-need", needId: NEED_ID, language: "ga" });

    expect(fetchCalls).toEqual([]);
    expect(rows("SELECT id FROM foodbankchangetranslation")).toEqual([]);
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  // A translate-need message with no language at all -- the shape a producer
  // deployed against an older message contract would send. Nothing defaults it:
  // URLSearchParams stringifies the missing value, so Google is asked to
  // translate into the language "undefined" rather than quietly into Welsh.
  //
  // Pinned because the tidy-looking fix -- `message.language ?? "cy"` -- is a
  // mutant that survives every other test in this block, and it would turn a
  // producer bug into three locales' worth of wrong-language text that reads
  // perfectly well to anyone who only checks the Welsh page.
  it("does not default a missing language to Welsh", async () => {
    await runOne({ type: "translate-need", needId: NEED_ID });

    expect(new URLSearchParams(fetchCalls[0]!.body).get("target")).toBe("undefined");
  });

  // At-least-once: replaceNeedTranslation is delete-then-insert, so a
  // redelivered message leaves ONE row, not two. A second row would make
  // getNeedTranslation's read non-deterministic on the public Welsh page.
  it("leaves exactly one row when the same message is delivered twice", async () => {
    const body = { type: "translate-need", needId: NEED_ID, language: "cy" };

    await run(body, body);

    expect(rows("SELECT id FROM foodbankchangetranslation")).toHaveLength(1);
  });
});

// ===========================================================================
// foodbank-check
// ===========================================================================
//
// WP 6.8. jobs.ts's own comment is the claim under test: "handleFoodbankCheckJob
// catches its own errors and records them on the admin_job row rather than
// throwing -- a failed AI check is a result the polling page shows, not
// something Cloudflare Queues should retry (a retry would just re-run the same
// paid Gemini call against the same failure)."

describe("foodbank-check", () => {
  const CHECK_AI_RESPONSE = {
    details: {
      name: "Salisbury Foodbank",
      address: "1 High Street",
      postcode: "SP1 1AA",
      country: "England",
      phone_number: "01722320266",
      contact_email: "none",
      charity_number: "",
      facebook_page: "",
      bankuet_slug: "",
      rss_url: "",
      news_url: "",
      donation_points_url: "",
      locations_url: "",
      contacts_url: "",
    },
    locations: [],
    donation_points: [],
  };

  beforeEach(() => {
    // shopping_list_url on facebook.com is skipped by the handler's own
    // candidate list, and locations/contacts/donation_points URLs are NULL, so
    // exactly ONE page is fetched. It answers 404, which returns before
    // HTMLRewriter is constructed -- see this file's header.
    seedFoodbank({
      id: SALISBURY,
      slug: "salisbury",
      name: "Salisbury Foodbank",
      url: SALISBURY_HOMEPAGE,
      shoppingListUrl: "https://www.facebook.com/salisburyfoodbank",
      phoneNumber: "01722 320266",
    });
    seedAdminJob({ id: "job-check-a", kind: "check", target: "salisbury" });
    seedAdminJob({ id: "job-check-b", kind: "check", target: "dundee" });
    reply(SALISBURY_HOMEPAGE, { status: 404, body: "not found" });
    reply(GEMINI_FLASH_25, geminiReply(CHECK_AI_RESPONSE));
  });

  // The happy path, read back off the admin_job row the polling page renders.
  // The crawlitem assertion is the one that proves the SLUG routed: the URL in
  // it comes from the food bank row that slug found.
  it("routes to the check handler, records the crawl and marks the named job done", async () => {
    const message = await runOne({ type: "foodbank-check", jobId: "job-check-a", foodbankSlug: "salisbury" });

    expect(adminJob("job-check-a")).toMatchObject({ status: "done", error: null, finished: DJANGO_NOW });
    // The OTHER job row is untouched. An UPDATE that lost its WHERE, or a
    // handler handed the wrong id, would move both and nobody would notice.
    expect(adminJob("job-check-b")).toMatchObject({ status: "queued", finished: null });

    expect(rows("SELECT crawl_set_id, crawl_type, start, finish, foodbank_id, url FROM crawlitem")).toEqual([
      { crawl_set_id: null, crawl_type: "check", start: DJANGO_NOW, finish: DJANGO_NOW, foodbank_id: SALISBURY, url: SALISBURY_HOMEPAGE },
    ]);

    const result = JSON.parse(String(adminJob("job-check-a")!.result)) as {
      fetchedPages: { name: string; url: string; found: boolean }[];
      detailChanges: Record<string, boolean>;
      aiResponse: { details: Record<string, string> };
    };
    expect(result.fetchedPages).toEqual([{ name: "homepage", url: SALISBURY_HOMEPAGE, found: false, proxyField: "url" }]);
    // The real comparison ran: phone_number is the one field Django strips
    // spaces from before comparing, so "01722 320266" held vs "01722320266"
    // found is NOT a change (gfadmin/views.py:1195).
    expect(result.detailChanges.phone_number).toBe(false);
    // ...and the AI's literal "none" was normalised to "" in place, so the
    // check page can never offer to write the string "none" into a field.
    expect(result.aiResponse.details.contact_email).toBe("");

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(new URL(fetchCalls[1]!.url).searchParams.get("key")).toBe("gemini-key");
  });

  // THE CENTRAL CLAIM. A failed check ACKS: the failure is recorded on the row
  // the admin is watching, and the message does not come back to run the same
  // paid gemini-2.5-flash call three more times. The error text carries the
  // slug, which also proves jobId and foodbankSlug did not get transposed on
  // the way into the two positional arguments.
  it("acks a failed check and records the failure on the job row instead of retrying", async () => {
    const message = await runOne({ type: "foodbank-check", jobId: "job-check-a", foodbankSlug: "no-such-foodbank" });

    expect(adminJob("job-check-a")).toMatchObject({ status: "failed", error: "no such foodbank: no-such-foodbank", finished: DJANGO_NOW });
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    // No Gemini call was made at all, so there is nothing a retry could win.
    expect(fetchCalls).toEqual([]);
  });

  // The same contract when the model itself is the thing that failed -- which
  // is the case the comment is actually about. A rejected key is recorded on
  // the job row and acked, so the admin sees "API key not valid" instead of a
  // check that never finishes.
  //
  // THE SIXTY-SECOND SLEEP IS PART OF WHAT IS BEING PINNED. lib/gemini.ts's
  // retry loop catches EVERY error, not just the 5xx ai.py:59-65 was written
  // for, so even a 400 costs `await new Promise(setTimeout, 60_000)` and a
  // second identical call before it gives up -- one minute of a queue consumer
  // held open per failed check. setTimeout is faked here (and only here)
  // because that is the only way to observe the second attempt without the
  // suite actually waiting a minute.
  it("acks and records a Gemini rejection rather than paying for it three more times", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    vi.setSystemTime(NOW);
    reply(GEMINI_FLASH_25, { status: 400, body: "API key not valid" });

    const fake = batchOf({ type: "foodbank-check", jobId: "job-check-a", foodbankSlug: "salisbury" });
    const pending = handleJobsQueue(fake.batch, env);
    await vi.advanceTimersByTimeAsync(61_000);
    await pending;

    expect(adminJob("job-check-a")).toMatchObject({ status: "failed" });
    expect(String(adminJob("job-check-a")!.error)).toContain("Gemini API error: 400");
    // TWO calls, not one: the loop treats a 400 as retryable.
    expect(fetchCalls.filter((c) => routeKey(c.url) === GEMINI_FLASH_25)).toHaveLength(2);
    expect(fake.messages[0]!.ack).toHaveBeenCalledTimes(1);
    expect(fake.messages[0]!.retry).not.toHaveBeenCalled();
  });

  // THE ONE HOLE IN THAT CLAIM, pinned rather than fixed. markAdminJobRunning
  // is called OUTSIDE handleFoodbankCheckJob's try block (foodbankCheck.ts:99
  // vs the `try` at :101), so a D1 failure on that first statement escapes the
  // handler, reaches this router's catch, and DOES retry -- with the job row
  // left on "queued" and the admin's page still spinning.
  //
  // orderLines.ts puts the identical call INSIDE its try (orderLines.ts:101-102)
  // and therefore never throws. The asymmetry is what makes this look
  // accidental. Reported, not corrected: retrying a D1 blip is arguably right,
  // and the comment claiming the handler never throws is what is wrong.
  it("SUSPECT: retries when D1 fails before the job is marked running, contradicting the module comment", async () => {
    failIf = (sql) => (/UPDATE admin_job SET status = 'running'/.test(sql) ? new Error("D1_ERROR: Network connection lost") : null);

    const message = await runOne({ type: "foodbank-check", jobId: "job-check-a", foodbankSlug: "salisbury" });

    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
    expect(adminJob("job-check-a")).toMatchObject({ status: "queued", error: null });
  });
});

// ===========================================================================
// order-lines
// ===========================================================================
//
// The second half of models/orders.py:71-215 Order.save(), moved off the admin
// form POST. Same self-recording contract as foodbank-check, and this one has
// no hole in it -- markAdminJobRunning is inside the try.

describe("order-lines", () => {
  beforeEach(() => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedAdminJob({ id: "job-lines", kind: "orderlines", target: "GF-2026-0042" });
    seedAdminJob({ id: "job-other", kind: "orderlines", target: "GF-2026-0043" });
    seedOrder({ id: ORDER_ROW, orderId: "GF-2026-0042", itemsText: "2 x Beans 400g", foodbankId: SALISBURY, deliveryDate: "2026-09-07" });
    // A decoy order that must not be touched: the message carries a row id and
    // a job id side by side, and DELETE FROM orderline WHERE order_id = ? is
    // the statement a transposed argument would run against the wrong order.
    seedOrder({ id: 99, orderId: "GF-2026-0043", itemsText: "1 x Rice 500g", foodbankId: SALISBURY, deliveryDate: "2026-09-01" });
    db.prepare("INSERT INTO orderline (id, name, quantity, item_cost, line_cost, weight, calories, order_id, delivery_date, category, group_name) VALUES (7, 'Rice 500g', 1, 100, 100, 500, 0, 99, '2026-09-01', 'Dry', '')").run();
    db.prepare("INSERT INTO orderitem (id, name, slug, calories) VALUES (1, 'Beans 400g', 'beans-400g', 81)").run();
  });

  // The whole write set for one parse, read back as rows. This is the strongest
  // routing evidence in the file: the lines land against ORDER_ROW, the
  // aggregates land on that order, and the admin_job named in the message --
  // and only that one -- moves to done.
  it("routes to the order-lines handler and writes lines, aggregates and the job row", async () => {
    reply(GEMINI_FLASH_20, geminiReply([{ name: "Beans 400g", quantity: 2, item_cost: 95, weight: 400 }]));

    const message = await runOne({ type: "order-lines", jobId: "job-lines", orderRowId: ORDER_ROW });

    expect(rows("SELECT name, quantity, item_cost, line_cost, weight, calories, order_id, delivery_date, category FROM orderline WHERE order_id = ?", ORDER_ROW)).toEqual([
      {
        name: "Beans 400g",
        quantity: 2,
        item_cost: 95, // per item, as the AI returned it
        line_cost: 190, // ...but the cost and weight columns are LINE totals
        weight: 800,
        calories: 648, // 81 kcal/100g x 4 x 2, truncated
        order_id: ORDER_ROW,
        delivery_date: "2026-09-07", // denormalised off the order, not "today"
        category: "",
      },
    ]);
    expect(rows("SELECT weight, calories, cost, no_lines, no_items FROM orders WHERE id = ?", ORDER_ROW)).toEqual([
      { weight: 800, calories: 648, cost: 190, no_lines: 1, no_items: 2 },
    ]);

    // The decoy order kept its line and its zeroed aggregates.
    expect(rows("SELECT id FROM orderline WHERE order_id = 99")).toEqual([{ id: 7 }]);
    expect(rows("SELECT no_lines FROM orders WHERE id = 99")).toEqual([{ no_lines: 0 }]);

    expect(adminJob("job-lines")).toMatchObject({ status: "done" });
    expect(JSON.parse(String(adminJob("job-lines")!.result))).toEqual({ order_id: "GF-2026-0042", no_lines: 1, no_items: 2 });
    expect(adminJob("job-other")).toMatchObject({ status: "queued" });
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  // The order deleted between the form POST and this dequeue. Recorded on the
  // job row and acked -- a retry would find the same missing row.
  it("acks and records a vanished order row rather than retrying", async () => {
    db.prepare("DELETE FROM orders WHERE id = ?").run(ORDER_ROW);

    const message = await runOne({ type: "order-lines", jobId: "job-lines", orderRowId: ORDER_ROW });

    expect(adminJob("job-lines")).toMatchObject({ status: "failed", error: `Order row ${ORDER_ROW} no longer exists` });
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toEqual([]);
  });

  // The disclosed gap: GEMINI_API_KEY is not set on the account yet. The
  // admin gets a sentence explaining it instead of an order that silently
  // looks empty, and the message acks because the next three attempts would
  // read the same unset secret.
  it("acks and explains itself when GEMINI_API_KEY is unset, without calling anything", async () => {
    env = { ...env, GEMINI_API_KEY: "" } as Env;

    const message = await runOne({ type: "order-lines", jobId: "job-lines", orderRowId: ORDER_ROW });

    expect(adminJob("job-lines")).toMatchObject({
      status: "failed",
      error: "GEMINI_API_KEY is not configured, so the items text could not be parsed into order lines.",
    });
    expect(fetchCalls).toEqual([]);
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  // The counterpart to the foodbank-check hole above: this handler's
  // markAdminJobRunning IS inside its try, so the same D1 failure is recorded
  // and acked rather than retried. Both behaviours are pinned so that a later
  // edit moving either call across its `try` shows up as a failing test rather
  // than as a change in how the admin's page behaves on a bad D1 day.
  it("acks a D1 failure marking the job running, unlike foodbank-check", async () => {
    let firstUpdate = true;
    failIf = (sql) => {
      if (/UPDATE admin_job SET status = 'running'/.test(sql) && firstUpdate) {
        firstUpdate = false;
        return new Error("D1_ERROR: Network connection lost");
      }
      return null;
    };

    const message = await runOne({ type: "order-lines", jobId: "job-lines", orderRowId: ORDER_ROW });

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    expect(adminJob("job-lines")).toMatchObject({ status: "failed", error: "D1_ERROR: Network connection lost" });
  });
});

// ===========================================================================
// THE FOUR NOTIFICATION CHANNELS
// ===========================================================================
//
// gfadmin/views.py:1993-2005 -- read at /Users/jasoncartwright/Sites/foodcharity.
// Django's need_publish sends the emails in-request (the `for subscriber in
// subscribers` loop) and enqueues three separate django-tasks for Firebase, web
// push and WhatsApp. All four are independent there, and jobs.ts's comment
// claims the port keeps that: "a channel whose credentials are missing or whose
// upstream is down does not retry the message and does not take the other
// channels down with it."
//
// Each test below identifies its channel by the LOG PREFIX the handler writes,
// because that string is unique per handler and is therefore the only evidence
// available that the switch went where it says it does when a channel's
// credentials are absent.

describe("the four notification channels", () => {
  beforeEach(() => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", name: "Salisbury Foodbank" });
    seedNeed({ id: NEED_ID, foodbankId: SALISBURY, changeText: "Beans\nPasta\nUHT Milk" });
  });

  // ONE BATCH, FOUR CHANNELS, EVERY CREDENTIAL MISSING -- the state three of
  // the four are actually in today. All four ack, none retries, and each one
  // logged under its own name. A router with two arms pointing at the same
  // handler would show one prefix twice.
  it("routes each type to its own handler and acks all four when no credentials are set", async () => {
    const fake = await run(
      { type: "notify-need-email", needId: NEED_ID, afterId: 0 },
      { type: "notify-need-firebase", needId: NEED_ID },
      { type: "notify-need-webpush", needId: NEED_ID, afterId: 0 },
      { type: "notify-need-whatsapp", needId: NEED_ID, afterId: 0 },
    );

    expect(fake.messages.map((m) => m.ack.mock.calls.length)).toEqual([1, 1, 1, 1]);
    expect(fake.messages.every((m) => m.retry.mock.calls.length === 0)).toBe(true);

    expect(warns).toEqual([
      "notify-need-firebase: FIREBASE_SERVICE_ACCOUNT not set, skipping",
      "notify-need-webpush: VAPID credentials not fully set, skipping web push notifications",
      "notify-need-whatsapp: WHATSAPP_TOKEN not set, skipping",
    ]);
    // Email has no credential gate at the top -- POSTMARK_TOKEN is checked per
    // send -- so it reaches the database and reports an empty subscriber list.
    expect(infos).toContain(`notify-need-email: need ${NEED_ID} done after id 0`);
    expect(fetchCalls).toEqual([]);
  });

  // THE afterId CURSOR SURVIVES THE CAST. jobs.ts passes `body as unknown as
  // NotifyNeedEmailMessage` -- the whole body, not a rebuilt object -- and the
  // three self-paging channels are keyset-paged on it. A router that dropped
  // afterId would restart every fan-out at 0 and re-notify everyone, for ever.
  it.each([
    ["notify-need-email", 4180, () => undefined],
    ["notify-need-webpush", 91, () => void (env = { ...env, VAPID_PRIVATE_KEY: "k", VAPID_PUBLIC_KEY: "p", VAPID_ADMIN_EMAIL: "a@b.c" } as Env)],
    ["notify-need-whatsapp", 37, () => void (env = { ...env, WHATSAPP_TOKEN: "wa-token" } as Env)],
  ])("carries afterId through to %s's keyset cursor", async (type, afterId, credentials) => {
    credentials();

    const message = await runOne({ type, needId: NEED_ID, afterId });

    expect(infos).toContain(`${type}: need ${NEED_ID} done after id ${afterId}`);
    expect(message.ack).toHaveBeenCalledTimes(1);
    // The page was empty, so the fan-out STOPS: no next-page message. A
    // consumer that enqueued unconditionally would loop this queue for ever.
    expect(jobsSend).not.toHaveBeenCalled();
  });

  // The self-paging message goes back onto the SAME queue this consumer reads,
  // so its `type` has to be one of the cases above -- otherwise the second page
  // of every WhatsApp fan-out hits `default`, throws, and dies in jobs-dlq
  // while the first page looks like it worked.
  //
  // The send itself fails here (Graph API 500) and the message STILL acks and
  // STILL pages on. That is deliberate in the handler, and it means a
  // subscriber whose send failed is skipped rather than retried -- pinned as
  // current behaviour.
  it("enqueues the next page under a type this same router recognises, even after a failed send", async () => {
    env = { ...env, WHATSAPP_TOKEN: "wa-token" } as Env;
    db.prepare("INSERT INTO whatsappsubscriber (id, phone_number, foodbank_id, created) VALUES (?, ?, ?, ?)").run(512, "+447700900123", SALISBURY, DJANGO_NOW);
    reply(GRAPH_MESSAGES, { status: 500, body: "Meta is having a moment" });

    const message = await runOne({ type: "notify-need-whatsapp", needId: NEED_ID, afterId: 0 });

    expect(jobsSend).toHaveBeenCalledTimes(1);
    expect(jobsSend).toHaveBeenCalledWith({ type: "notify-need-whatsapp", needId: NEED_ID, afterId: 512 });
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    // Nothing was stamped, because nothing was delivered.
    expect(rows("SELECT last_notified FROM whatsappsubscriber WHERE id = 512")).toEqual([{ last_notified: null }]);
    expect(errors[0]).toContain("notify-need-whatsapp: Graph API 500 for 447700900123");
  });

  // A need deleted between the reviewer pressing Notify and the message being
  // dequeued. Every channel logs and returns, so the message acks -- and
  // crucially the log names the needId, which is the only way to tell "nobody
  // is subscribed" from "the need vanished" after the fact.
  it("acks and names the need when it no longer exists", async () => {
    db.prepare("DELETE FROM foodbankchange WHERE id = ?").run(NEED_ID);
    env = { ...env, FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: "p", client_email: "e@x.iam", private_key: "-----BEGIN PRIVATE KEY-----" }) } as Env;

    const fake = await run(
      { type: "notify-need-email", needId: NEED_ID, afterId: 0 },
      { type: "notify-need-firebase", needId: NEED_ID },
    );

    expect(errors).toEqual([
      `notify-need-email: need ${NEED_ID} no longer exists`,
      `notify-need-firebase: need ${NEED_ID} is missing or has no food bank`,
    ]);
    expect(fake.messages.map((m) => m.ack.mock.calls.length)).toEqual([1, 1]);
  });

  // THE LIMIT OF "NOTIFY NEVER RETRIES". The handlers swallow SEND failures,
  // not D1 failures -- getNeedById is not inside any try -- so a database
  // error does reach this router and does retry. Worth pinning explicitly,
  // because the module comment reads as though notify messages never come
  // back, and a reader debugging a duplicate notification needs to know the
  // one path that can produce one.
  it("retries a notify message when D1 itself fails, which the handlers do not catch", async () => {
    failIf = (sql) => (/FROM foodbankchange_full/.test(sql) ? new Error("D1_ERROR: Network connection lost") : null);

    const message = await runOne({ type: "notify-need-email", needId: NEED_ID, afterId: 0 });

    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
    expect(errors[0]).toContain("D1_ERROR");
  });
});

// ===========================================================================
// UNKNOWN AND MALFORMED MESSAGES
// ===========================================================================
//
// wrangler.jsonc: `{"queue": "jobs", "max_retries": 3, "dead_letter_queue":
// "jobs-dlq"}`. Everything in this block therefore costs four attempts and one
// dead letter, and the only record is the console.error line asserted below
// plus jobsDlq.ts's own. There is no alerting on either.

describe("unknown and malformed messages", () => {
  // A type nobody handles -- a producer deployed ahead of this consumer, or a
  // job type deleted from the switch while messages for it were still in
  // flight. It throws, so it retries and eventually dead-letters, which is the
  // right end: an ack would make a whole feature silently do nothing.
  it("retries an unknown job type and names it in the log", async () => {
    const message = await runOne({ type: "rebuild-everything", scope: "all" });

    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
    expect(errors[0]).toContain("unknown job type: rebuild-everything");
  });

  // THE RETRY TAKES NO ARGUMENTS HERE. queues/articles.ts asks for
  // `{delaySeconds: 60}`; this consumer does not, so a failing jobs message is
  // re-delivered on the queue's own default backoff. Pinned because the two
  // files sit next to each other and look like they should match -- and
  // because a media-backfill retried immediately hits the same Google outage.
  it("retries with no delay argument at all, unlike the articles consumer", async () => {
    const message = await runOne({ type: "nope" });

    expect(message.retry.mock.calls).toEqual([[]]);
  });

  // The log names the queue as the literal "jobs" (jobs.ts:25), NOT
  // batch.queue -- so a message that somehow arrived on another queue bound to
  // this handler would be mislabelled. Contrast jobsDlq.ts:50, which uses
  // `batch.queue`. Asserted as an exact prefix because this string is what
  // someone greps for at 2am.
  it("logs the queue name, the whole message body and the error", async () => {
    const body = { type: "media-backfill", key: "media/needs/at/nowhere/map.png" };

    await runOne(body);

    expect(errorArgs).toHaveLength(1);
    expect(errorArgs[0]![0]).toBe('givefood2-jobs: "jobs" message failed');
    // The BODY itself, by reference -- not a stringified summary. It is the
    // only thing that says which key/job/need failed.
    expect(errorArgs[0]![1]).toBe(body);
    expect(errorArgs[0]![2]).toBeInstanceOf(Error);
  });

  // ...AND THE "jobs" IN THAT PREFIX IS A LITERAL, NOT batch.queue. The test
  // above cannot tell the two apart, because batchOf() always builds a batch
  // whose queue IS "jobs" -- so rewriting jobs.ts:25 to `${batch.queue}`
  // survived a mutation run of this file while the comment beside it claimed
  // the opposite. This is the test that makes the claim observable.
  //
  // It is not pedantry: wrangler.jsonc:148-152 binds handleJobsQueue to the
  // "jobs" queue alone, but jobs-dlq is the same Worker and jobsDlq.ts:50
  // deliberately interpolates `batch.queue`. If the two ever converged on one
  // handler, the literal here would mislabel every dead letter as a live job,
  // and the grep someone runs at 2am would return the wrong set of failures.
  it("hard-codes the queue name in the log rather than reading it off the batch", async () => {
    const fake = batchOf({ type: "nope" });
    const rebadged = { ...(fake.batch as unknown as Record<string, unknown>), queue: "jobs-dlq" } as unknown as JobsBatch;

    await handleJobsQueue(rebadged, env);

    expect(errorArgs[0]![0]).toBe('givefood2-jobs: "jobs" message failed');
    expect(fake.messages[0]!.retry).toHaveBeenCalledTimes(1);
  });

  // Shapes a malformed or truncated message can take. `dispatch` reads
  // `body.type` before anything else, so a null body is a TypeError rather
  // than the tidy "unknown job type" -- both retry, but only one of them
  // produces a log line a reader can act on, which is worth knowing.
  it("retries a null body with a TypeError rather than an unknown-type error", async () => {
    const message = await runOne(null);

    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(errorArgs[0]![2]).toBeInstanceOf(TypeError);
    expect(errors[0]).toContain("givefood2-jobs");
  });

  it.each([
    ["an object with no type", {}],
    ["a bare string", "media-backfill"],
    ["a number", 7],
    ["an array", [{ type: "media-backfill" }]],
  ])("retries %s as an unknown job type", async (_label, body) => {
    const message = await runOne(body);

    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
    expect(errors[0]).toContain("unknown job type: undefined");
  });
});

// ===========================================================================
// BATCH SEMANTICS
// ===========================================================================
//
// max_batch_size is 10. A batch of ten holds work for ten different
// subsystems, so how the batch settles matters more here than on any other
// queue in this Worker.

describe("batch semantics", () => {
  beforeEach(() => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedFoodbank({ id: DUNDEE, slug: "dundee", latLng: "56.4620,-2.9707" });
    reply(GOOGLE_STATIC_MAP, { status: 200, body: PNG_BYTES });
  });

  // ONE POISON MESSAGE MUST NOT TAKE THE BATCH WITH IT. The `try` is inside
  // the loop; a mutant that hoisted it outside would abandon every message
  // after the first failure -- they would be redelivered, so nothing is lost,
  // but a permanently-poison message at position one would stall the other
  // nine for ever behind it.
  it("settles each message individually and keeps going past a failure", async () => {
    const fake = await run(
      { type: "media-backfill", key: "media/needs/at/salisbury/map.png" },
      { type: "no-such-type" },
      { type: "media-backfill", key: "media/needs/at/dundee/map.png" },
    );

    expect(fake.messages[0]!.ack).toHaveBeenCalledTimes(1);
    expect(fake.messages[1]!.retry).toHaveBeenCalledTimes(1);
    expect(fake.messages[2]!.ack).toHaveBeenCalledTimes(1);
    // The third message's WORK actually happened -- not merely its ack.
    expect([...media.keys()].sort()).toEqual(["media/needs/at/dundee/map.png", "media/needs/at/salisbury/map.png"]);
  });

  // Never ackAll/retryAll. retryAll on a batch containing one bad message
  // would replay nine good ones -- nine more billed Google calls, or nine
  // duplicate notification pages.
  it("never settles the batch as a unit", async () => {
    const fake = await run({ type: "media-backfill", key: "media/needs/at/salisbury/map.png" }, { type: "nope" });

    expect(fake.ackAll).not.toHaveBeenCalled();
    expect(fake.retryAll).not.toHaveBeenCalled();
  });

  // Sequential, not Promise.all. The fetch stub yields for a real macrotask,
  // so a concurrent implementation would interleave the two fetches before
  // either put. It matters because this Worker's outbound calls are all
  // rate-limited or billed third parties, and a batch of ten fired at once is
  // ten simultaneous Google requests.
  it("processes a batch one message at a time, in order", async () => {
    await run(
      { type: "media-backfill", key: "media/needs/at/salisbury/map.png" },
      { type: "media-backfill", key: "media/needs/at/dundee/map.png" },
    );

    expect(events).toEqual([
      `fetch ${GOOGLE_STATIC_MAP}`,
      "r2put media/needs/at/salisbury/map.png",
      "ack media-backfill",
      `fetch ${GOOGLE_STATIC_MAP}`,
      "r2put media/needs/at/dundee/map.png",
      "ack media-backfill",
    ]);
  });

  // A batch of mixed types, every one of which routes somewhere different.
  // This is the closest thing to what a real busy minute looks like -- a
  // publish fans out four notifications and a translate, while media misses
  // arrive from the site -- and it is the case a switch statement with a
  // missing `break` (or a `return` in the wrong place) would break.
  it("routes a mixed batch to five different subsystems in one pass", async () => {
    seedNeed({ id: NEED_ID, foodbankId: SALISBURY, changeText: "Beans" });
    seedAdminJob({ id: "job-mixed", kind: "check", target: "nowhere" });
    reply(GOOGLE_TRANSLATE, { status: 200, body: JSON.stringify({ data: { translations: [{ translatedText: "Ffa" }] } }) });

    const fake = await run(
      { type: "media-backfill", key: "media/needs/at/salisbury/map.png" },
      { type: "translate-need", needId: NEED_ID, language: "cy" },
      { type: "foodbank-check", jobId: "job-mixed", foodbankSlug: "nowhere" },
      { type: "notify-need-firebase", needId: NEED_ID },
      { type: "unknown-thing" },
    );

    expect(media.has("media/needs/at/salisbury/map.png")).toBe(true);
    expect(rows("SELECT language FROM foodbankchangetranslation")).toEqual([{ language: "cy" }]);
    expect(adminJob("job-mixed")).toMatchObject({ status: "failed", error: "no such foodbank: nowhere" });
    expect(warns).toContain("notify-need-firebase: FIREBASE_SERVICE_ACCOUNT not set, skipping");
    expect(fake.messages.map((m) => (m.ack.mock.calls.length ? "ack" : "retry"))).toEqual(["ack", "ack", "ack", "ack", "retry"]);
  });
});
