import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGGREGATE_TAG, foodbankTag } from "@givefood/urls";
import type { AppEnv } from "../../types";
import { hmacSha256Hex } from "../../lib/hmac";
import { requireAdminAuth } from "../../middleware/adminAuth";

// The need-review queue is where the maintainer spends his day: every need
// the crawlers find arrives here and is published, rejected or deleted from
// one of these ten handlers. Nothing in the repo tested any of them, and the
// two bugs found on 2026-09-05 were both of the kind this file exists to
// catch:
//
//   #12 -- a refusal that 500'd and threw away the form.
//   #34 -- a field that was parsed, passed down, and written by no SQL at
//          all. It redirected as though it had worked.
//
// Neither showed an error to anyone. So the assertions below are almost never
// about the status code alone: EVERY successful write is read back out of
// SQLite and its columns checked, every refusal asserts that the row is
// untouched, and every queue send is checked for its exact payload. A 302 is
// not evidence that anything was saved -- that is precisely the shape #34
// had.
//
// REAL EVERYTHING BELOW THE HANDLER. A real Hono app registered at the
// production paths (routes/admin/index.ts:104-120), the real handlers, the
// real packages/db functions, the real parseBody, the real verifyCsrf with a
// real HMAC-signed cookie, and a real in-memory SQLite carrying the real
// migration DDL for the tables these routes touch. The only things faked are
// the ones that leave the machine: the three queues, and the template
// renderer.
//
// WHY render() IS MOCKED. packages/templates/src/generated/ is a build
// artefact and gitignored, so importing the real render() would make this
// suite fail on a fresh checkout for reasons that have nothing to do with
// needs. Asserting on the CONTEXT handed to the template is also the more
// direct claim -- "the edit form came back holding what the admin typed" is a
// statement about `need.change_text`, not about markup. adminPageContext
// itself is NOT mocked: it runs for real (over a stubbed buildPageContext),
// so the csrf token in every render context is the one issueCsrfToken minted.

const mocks = vi.hoisted(() => ({
  render: vi.fn(async (_template: string, _context: Record<string, unknown>) => "<html>rendered</html>"),
}));

// Only `render` is under test here. The other three names exist because
// something in this import graph imports them and an ESM named import of a
// missing export throws at link time, not because any assertion touches
// them: buildPageContext (routes/admin/pageContext.ts:2), translate
// (lib/timesince.ts:1, used only by timesinceAgo which these routes never
// call) and djangoDate (packages/db/src/needEmailContext.ts:1, reached
// because @givefood/db's index re-exports that module).
vi.mock("@givefood/templates", () => ({
  render: mocks.render,
  buildPageContext: () => ({}),
  translate: (_catalogue: Record<string, string>, msgid: string) => msgid,
  djangoDate: (value: unknown) => String(value),
}));

const {
  adminNeedDetail,
  adminNeedPublish,
  adminNeedUnpublish,
  adminNeedNotify,
  adminNeedNonpertinent,
  adminNeedDelete,
  adminNeedsDeleteAll,
  adminNeedCategorise,
  adminNeedTranslations,
  adminNeedEditForm,
} = await import("./needs");

// ============================ the fixture schema ============================
//
// Transcribed from the migrations, not from memory, and reduced to the tables
// these ten handlers actually read or write -- the same approach
// foodbankLocation.test.ts and donationPoint.test.ts take (packages/db's
// suites share schema.testkit.ts instead; workers/site's do not import across
// that boundary).
//
//   foodbank                    0001_core.sql:10-46, reduced to the seven
//                               columns these routes read or write. Every
//                               query against it here is `SELECT *` or names
//                               a column explicitly, and coerceBooleans
//                               spreads unknown columns through untouched, so
//                               a narrower table behaves identically.
//   foodbankchange              0001_core.sql:109-123 VERBATIM. Not reduced:
//                               getNeedByUuid selects * and the edit form's
//                               whole job is that every column survives a
//                               round trip, so a missing column here would
//                               hide exactly the bug this file hunts.
//   foodbankchange_full         0019_drop_foodbank_cache.sql:86-89 verbatim.
//   foodbankchangeline          0003_homepage_data.sql:29-34
//   foodbankchangetranslation   0006_need_translations.sql:21-27
//   crawlset / crawlitem        0008_needcheck.sql:17-44
//   foodbanksubscriber          0004_subscribers.sql:18-26
//   webpushsubscription         0004_subscribers.sql:30-36
//   mobilesubscriber            0004_subscribers.sql:46-53
//   whatsappsubscriber          0020_whatsappsubscriber.sql:31-37
//
// A NOTE ON THE VIEW'S DUPLICATE COLUMN. foodbankchange has its own
// denormalised `foodbank_name`, and foodbankchange_full adds `f.name AS
// foodbank_name` on top of it -- two output columns with one name, in the
// real migration. node:sqlite disambiguates the second as "foodbank_name:1",
// so the value a test would read here is the BASE column's, which may not be
// what D1 returns. Rather than assert on either reading, every seeded need
// below carries a foodbank_name equal to its food bank's real name, so the
// two agree and nothing in this file depends on which one wins.
const SCHEMA = `
CREATE TABLE foodbank (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  url TEXT NOT NULL, shopping_list_url TEXT NOT NULL, rss_url TEXT,
  latest_need_id INTEGER, last_need TEXT
);
CREATE UNIQUE INDEX foodbank_slug_uniq ON foodbank(slug);

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
CREATE UNIQUE INDEX need_need_id_uniq    ON foodbankchange(need_id);
CREATE INDEX change_foodbank_created_idx ON foodbankchange(foodbank_id, created DESC);

CREATE VIEW foodbankchange_full AS
  SELECT c.*, f.name AS foodbank_name, f.slug AS foodbank_slug
    FROM foodbankchange c
    LEFT JOIN foodbank f ON f.id = c.foodbank_id;

CREATE TABLE foodbankchangeline (
  id INTEGER PRIMARY KEY,
  need_id INTEGER NOT NULL, foodbank_id INTEGER NOT NULL,
  item TEXT NOT NULL, type TEXT NOT NULL, category TEXT NOT NULL, group_name TEXT NOT NULL,
  created TEXT NOT NULL
);

CREATE TABLE foodbankchangetranslation (
  id INTEGER PRIMARY KEY,
  need_id INTEGER NOT NULL, foodbank_id INTEGER,
  language TEXT NOT NULL, change_text TEXT, excess_change_text TEXT
);

CREATE TABLE crawlset (
  id INTEGER PRIMARY KEY,
  crawl_type TEXT NOT NULL, run_id TEXT,
  start TEXT NOT NULL, finish TEXT, expected INTEGER, remaining INTEGER
);
CREATE TABLE crawlitem (
  id INTEGER PRIMARY KEY,
  crawl_set_id INTEGER, crawl_type TEXT NOT NULL,
  start TEXT NOT NULL, finish TEXT,
  foodbank_id INTEGER NOT NULL, url TEXT, need_id INTEGER
);

CREATE TABLE foodbanksubscriber (
  id INTEGER PRIMARY KEY,
  created TEXT NOT NULL, last_contacted TEXT,
  foodbank_id INTEGER NOT NULL, foodbank_name TEXT,
  email TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0,
  sub_key TEXT NOT NULL, unsub_key TEXT NOT NULL
);
CREATE TABLE webpushsubscription (
  id INTEGER PRIMARY KEY,
  created TEXT NOT NULL, foodbank_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, browser TEXT
);
CREATE TABLE mobilesubscriber (
  id INTEGER PRIMARY KEY,
  created TEXT NOT NULL, device_id TEXT NOT NULL, platform TEXT NOT NULL,
  timezone TEXT, locale TEXT, app_version TEXT, os_version TEXT,
  device_model TEXT, sub_type TEXT,
  foodbank_id INTEGER NOT NULL, donationpoint_id INTEGER
);
CREATE TABLE whatsappsubscriber (
  id INTEGER PRIMARY KEY,
  phone_number TEXT NOT NULL, foodbank_id INTEGER,
  created TEXT, last_notified TEXT
);
`;

// ============================ the D1 shim ============================

type Bindable = null | number | bigint | string | Uint8Array;

// The D1DatabaseSession surface packages/db actually uses, over node:sqlite.
// D1 is async and node:sqlite is synchronous; the SQL text, the parameter
// binding and the NULL semantics are SQLite's in both.
//
// `meta.last_row_id` is not decoration: packages/db's insertCrawlSet
// (needcheck.ts:48-55) returns `result.meta.last_row_id` and adminNeedNotify
// hands that straight to setCrawlSetExpected and to the ARTICLES_Q message.
// A shim that returned an empty `meta` -- as the neighbouring suites' shims
// do, having no insert to make -- would quietly bind `undefined` there and
// the article-crawl assertions below would be testing nothing.
function d1Session(db: DatabaseSync) {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      const result = db.prepare(sql).run(...params);
      return { success: true, meta: { last_row_id: Number(result.lastInsertRowid), changes: result.changes } };
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

// ============================ fixture data ============================

const SALISBURY = {
  id: 1,
  name: "Salisbury",
  slug: "salisbury",
  url: "https://salisbury.foodbank.org.uk/",
  shopping_list_url: "https://salisbury.foodbank.org.uk/give-help/donate-food/",
  rss_url: "https://salisbury.foodbank.org.uk/feed/",
};

// Deliberately a food bank whose `url` and `shopping_list_url` are on
// DIFFERENT origins, and with rss_url NULL. Both facts are load-bearing:
// the first is the only way to tell computeNeedProxySrc's two-field search
// order apart, and the second is the guard adminNeedNotify's article crawl
// hangs on.
const AMESBURY = {
  id: 2,
  name: "Amesbury",
  slug: "amesbury",
  url: "https://amesbury.foodbank.org.uk/",
  shopping_list_url: "https://donate.amesbury.example/shopping-list/",
  rss_url: null,
};

// 32-char dashless, as stored (PLAN.md §4.4 / packages/db/src/uuid.ts).
function needUuid(n: number): string {
  return `abcdef${String(n).padStart(4, "0")}`.padEnd(32, "0").slice(0, 32);
}

// 8-4-4-4-12, spelled out here rather than imported from packages/db so that
// the input this test feeds the handler is not built by the code it is
// testing.
function dashed(dashless: string): string {
  return `${dashless.slice(0, 8)}-${dashless.slice(8, 12)}-${dashless.slice(12, 16)}-${dashless.slice(16, 20)}-${dashless.slice(20)}`;
}

const REVIEW = needUuid(10); // the unreviewed need most tests act on
const PREV_PUB = needUuid(11);
const OLDER_PUB = needUuid(12);
const LATER_PUB = needUuid(13);
const OTHER_FB_PUB = needUuid(14);
const UNPUB = needUuid(15);
const PREV_NONPERT = needUuid(16);
const OTHER_FB_NONPERT = needUuid(17);
const ORPHAN = needUuid(18); // foodbank_id IS NULL -- the "needs-foodbank" paths
const PUBLISHED = needUuid(19); // the notify/translations subject

const SEED_MODIFIED = "2026-01-01 00:00:00.000000";
// pyDatetime's exact shape (packages/models/src/pyDatetime.ts:44-53): a
// space, six fractional digits, no "Z". Asserted rather than eyeballed
// because a route writing toISOString() here silently breaks every
// `ORDER BY created DESC` on this table -- ticket #9's whole subject.
const PY_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;

interface SeedNeed {
  id: number;
  needId: string;
  foodbankId: number | null;
  changeText: string;
  excessChangeText?: string | null;
  published?: boolean;
  nonpertinent?: number | null;
  isCategorised?: number | null;
  uri?: string | null;
  inputMethod?: string;
  created: string;
  notified?: string | null;
}

const ORIGIN = "https://www.givefood.org.uk";
const CSRF_SECRET = "test-csrf-secret-not-a-real-one";
const CSRF_RAW = "b".repeat(64);
const ADMIN_USER = { email: "someone@givefood.org.uk", name: "Some One", givenName: "Some", picture: "" };

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let env: AppEnv["Bindings"];
let app: Hono<AppEnv>;
let purgeSend: ReturnType<typeof vi.fn>;
let jobsSendBatch: ReturnType<typeof vi.fn>;
let articlesSend: ReturnType<typeof vi.fn>;

function seedFoodbank(fb: typeof SALISBURY | typeof AMESBURY, latestNeedId: number | null, lastNeed: string | null): void {
  db.prepare("INSERT INTO foodbank (id, name, slug, url, shopping_list_url, rss_url, latest_need_id, last_need) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    fb.id,
    fb.name,
    fb.slug,
    fb.url,
    fb.shopping_list_url,
    fb.rss_url,
    latestNeedId,
    lastNeed,
  );
}

function seedNeed(need: SeedNeed): void {
  const foodbankName = need.foodbankId === SALISBURY.id ? SALISBURY.name : need.foodbankId === AMESBURY.id ? AMESBURY.name : null;
  db.prepare(
    `INSERT INTO foodbankchange
       (id, need_id, foodbank_id, foodbank_name, uri, change_text, excess_change_text,
        published, nonpertinent, is_categorised, notified, input_method, created, modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    need.id,
    need.needId,
    need.foodbankId,
    foodbankName,
    need.uri ?? null,
    need.changeText,
    need.excessChangeText ?? null,
    need.published ? 1 : 0,
    need.nonpertinent ?? 0,
    need.isCategorised ?? null,
    need.notified ?? null,
    need.inputMethod ?? "scrape",
    need.created,
    SEED_MODIFIED,
  );
}

// ---- read-back helpers. Every "the write happened" assertion goes through
// one of these, straight to the base table -- never through the handler that
// wrote it, and never through a mock.

function storedNeed(needId: string): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM foodbankchange WHERE need_id = ?").get(needId) as Record<string, unknown> | undefined;
}

function storedFoodbank(id: number): { latest_need_id: number | null; last_need: string | null } {
  return db.prepare("SELECT latest_need_id, last_need FROM foodbank WHERE id = ?").get(id) as never;
}

function storedLines(needId: number): { item: string; type: string; category: string; group_name: string; foodbank_id: number; created: string }[] {
  return db.prepare("SELECT item, type, category, group_name, foodbank_id, created FROM foodbankchangeline WHERE need_id = ? ORDER BY id").all(needId) as never;
}

function needIdsInTable(): string[] {
  return (db.prepare("SELECT need_id FROM foodbankchange ORDER BY id").all() as { need_id: string }[]).map((r) => r.need_id);
}

function lastRender(): { template: string; context: Record<string, unknown> } {
  const call = mocks.render.mock.calls.at(-1);
  if (!call) throw new Error("render() was never called");
  return { template: call[0], context: call[1] };
}

function renderedNeed(): Record<string, unknown> {
  return lastRender().context.need as Record<string, unknown>;
}

// ---- a frozen wall clock, for the "N months ago" strings.
//
// The detail page and the translations viewer both build their relative
// times from `new Date()` inside the handler (two separate copies of the same
// header), so an assertion made against the real clock would either drift
// (right today, wrong next month) or have to be loose enough to assert
// nothing. Freezing Date -- and ONLY Date, so nothing that awaits a timer
// hangs -- lets them be literals. Added on review: without them, mutants that
// swapped created_timesince for modified_timesince, dropped
// prev_published's entirely, dropped the crawl set's, or computed all four
// against `need.created` instead of `now` all survived the whole file.
const FROZEN_NOW = new Date("2026-04-01T00:00:00.000Z");
// timesince joins the count to its unit with U+00A0, not a space
// (lib/timesince.ts's avoid_wrapping, ported from Django). The " ago" the
// handlers append is an ordinary space.
const NB = "\u00a0"; // as an escape: an invisible literal here would be unreviewable

async function atFrozenClock<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"], now: FROZEN_NOW });
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.render.mockResolvedValue("<html>rendered</html>");

  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);

  // latest_need_id starts pointing at LATER_PUB (id 13), which is what
  // recomputeFoodbankNeedFields would have left it as -- so a test that
  // expects a recompute is asserting a CHANGE, not an initial value that
  // happened to be right.
  seedFoodbank(SALISBURY, 13, "2026-04-01 00:00:00.000000");
  seedFoodbank(AMESBURY, 14, "2026-02-25 00:00:00.000000");

  seedNeed({ id: 10, needId: REVIEW, foodbankId: 1, changeText: "Tea\nCoffee", excessChangeText: "Pasta", uri: SALISBURY.shopping_list_url, created: "2026-03-01 00:00:00.000000" });
  seedNeed({ id: 11, needId: PREV_PUB, foodbankId: 1, changeText: "Tea\nSugar", published: true, created: "2026-02-01 00:00:00.000000" });
  seedNeed({ id: 12, needId: OLDER_PUB, foodbankId: 1, changeText: "Beans", published: true, created: "2026-01-01 00:00:00.000000" });
  seedNeed({ id: 13, needId: LATER_PUB, foodbankId: 1, changeText: "Rice", published: true, created: "2026-04-01 00:00:00.000000" });
  seedNeed({ id: 14, needId: OTHER_FB_PUB, foodbankId: 2, changeText: "Soup", published: true, created: "2026-02-20 00:00:00.000000" });
  seedNeed({ id: 15, needId: UNPUB, foodbankId: 1, changeText: "Squash", created: "2026-02-15 00:00:00.000000" });
  seedNeed({ id: 16, needId: PREV_NONPERT, foodbankId: 1, changeText: "Tea", nonpertinent: 1, created: "2026-02-10 00:00:00.000000" });
  seedNeed({ id: 17, needId: OTHER_FB_NONPERT, foodbankId: 2, changeText: "Milk", nonpertinent: 1, created: "2026-02-25 00:00:00.000000" });
  seedNeed({ id: 18, needId: ORPHAN, foodbankId: null, changeText: "Beans", created: "2026-03-02 00:00:00.000000" });
  seedNeed({ id: 19, needId: PUBLISHED, foodbankId: 1, changeText: "Tea\nCoffee", published: true, created: "2026-03-03 00:00:00.000000" });

  // Subscriber rows for the per-channel counts in the "Food Bank Subs" row.
  // (They used to feed the Notify button's confirm() dialog as well; github
  // #37 removed that, and the row on the page is now the only place a
  // reviewer sees the audience -- so these counts matter MORE than before,
  // not less.) Each channel gets at
  // least one row that MUST be excluded -- an unconfirmed email address and a
  // subscriber belonging to the other food bank -- because a count query with
  // its predicate dropped passes every test that only seeds matching rows.
  const sub = db.prepare("INSERT INTO foodbanksubscriber (created, foodbank_id, email, confirmed, sub_key, unsub_key) VALUES (?, ?, ?, ?, ?, ?)");
  sub.run(SEED_MODIFIED, 1, "one@example.invalid", 1, "s1", "u1");
  sub.run(SEED_MODIFIED, 1, "two@example.invalid", 1, "s2", "u2");
  sub.run(SEED_MODIFIED, 1, "unconfirmed@example.invalid", 0, "s3", "u3");
  sub.run(SEED_MODIFIED, 2, "other@example.invalid", 1, "s4", "u4");

  const push = db.prepare("INSERT INTO webpushsubscription (created, foodbank_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?)");
  push.run(SEED_MODIFIED, 1, "https://push.example/1", "p", "a");
  push.run(SEED_MODIFIED, 1, "https://push.example/2", "p", "a");
  push.run(SEED_MODIFIED, 1, "https://push.example/3", "p", "a");
  push.run(SEED_MODIFIED, 2, "https://push.example/4", "p", "a");

  const mob = db.prepare("INSERT INTO mobilesubscriber (created, device_id, platform, foodbank_id) VALUES (?, ?, ?, ?)");
  mob.run(SEED_MODIFIED, "device-1", "ios", 1);
  mob.run(SEED_MODIFIED, "device-2", "android", 2);

  const wa = db.prepare("INSERT INTO whatsappsubscriber (phone_number, foodbank_id, created) VALUES (?, ?, ?)");
  wa.run("+447700900001", 1, SEED_MODIFIED);
  wa.run("+447700900002", 1, SEED_MODIFIED);
  wa.run("+447700900003", 2, SEED_MODIFIED);

  // The crawl that produced REVIEW -- crawlitem.need_id is foodbankchange.id
  // (0008_needcheck.sql collapsed Django's generic FK), so 10, not the uuid.
  db.prepare("INSERT INTO crawlset (id, crawl_type, run_id, start, finish) VALUES (?, ?, ?, ?, ?)").run(5, "need", "needcheck-2026-03-01", "2026-03-01 00:00:00.000000", null);
  db.prepare("INSERT INTO crawlitem (crawl_set_id, crawl_type, start, foodbank_id, need_id) VALUES (?, ?, ?, ?, ?)").run(5, "need", "2026-03-01 00:00:00.000000", 1, 10);

  // Three translations on an UNPUBLISHED need and one on a published need:
  // the detail page gates its count on `need.published`, the translations
  // viewer does not, and one fixture proves both.
  const trans = db.prepare("INSERT INTO foodbankchangetranslation (need_id, foodbank_id, language, change_text, excess_change_text) VALUES (?, ?, ?, ?, ?)");
  trans.run(10, 1, "gd", "Ti\nCofaidh", null);
  trans.run(10, 1, "cy", "Te\nCoffi", "Pasta");
  trans.run(10, 1, "ga", "Tae\nCaife", null);
  trans.run(19, 1, "cy", "Te\nCoffi", null);

  purgeSend = vi.fn(async () => {});
  jobsSendBatch = vi.fn(async () => {});
  articlesSend = vi.fn(async () => {});

  env = {
    DB: { withSession: () => d1Session(db) },
    CSRF_SECRET,
    PURGE_Q: { send: purgeSend },
    JOBS_Q: { sendBatch: jobsSendBatch },
    ARTICLES_Q: { send: articlesSend },
    GMAP_STATIC_KEY: "",
    GMAP_GEOCODE_KEY: "",
    D1_DATABASE_NAME: "givefood-test",
  } as unknown as AppEnv["Bindings"];

  app = buildApp();
});

// Registered at the production paths and with the production methods
// (routes/admin/index.ts:104-120) rather than invoking the handlers
// directly: three of them read `c.req.method` to decide between rendering
// and writing, and all of them read `c.req.param("id")`, so a hand-built
// Context would let a change in either slip through.
function buildApp(options: { auth?: boolean } = {}): Hono<AppEnv> {
  const built = new Hono<AppEnv>();
  built.use("*", async (c, next) => {
    c.set("requestStartTime", performance.now());
    if (!options.auth) c.set("adminUser", ADMIN_USER);
    await next();
  });
  if (options.auth) built.use("*", requireAdminAuth);

  built.get("/admin/need/:id/", adminNeedDetail);
  built.post("/admin/need/:id/publish/", adminNeedPublish);
  built.post("/admin/need/:id/unpublish/", adminNeedUnpublish);
  built.post("/admin/need/:id/notify/", adminNeedNotify);
  built.post("/admin/need/:id/nonpertinent/", adminNeedNonpertinent);
  built.post("/admin/need/:id/delete/", adminNeedDelete);
  built.post("/admin/needs/delete-all/", adminNeedsDeleteAll);
  built.get("/admin/need/:id/categorise/", adminNeedCategorise);
  built.post("/admin/need/:id/categorise/", adminNeedCategorise);
  built.get("/admin/need/:id/translations/", adminNeedTranslations);
  built.get("/admin/need/:id/edit/", adminNeedEditForm);
  built.post("/admin/need/:id/edit/", adminNeedEditForm);

  // Labelled rather than left to become an unhandled rejection, so a
  // regression reads as "expected 302, got 500: ..." instead of a vitest
  // crash -- and so the two tests that deliberately provoke a throw can
  // assert on it.
  built.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));
  return built;
}

interface PostOptions {
  token?: string | null; // the hidden csrf_token form field; null omits it
  cookie?: string | null; // the __Host-csrf cookie value; null omits it
  origin?: string | null;
  app?: Hono<AppEnv>;
}

async function post(path: string, fields: Record<string, string> | URLSearchParams, options: PostOptions = {}): Promise<Response> {
  const signature = await hmacSha256Hex(CSRF_SECRET, CSRF_RAW);
  const body = fields instanceof URLSearchParams ? fields : new URLSearchParams(fields);
  const token = options.token === undefined ? CSRF_RAW : options.token;
  if (token !== null) body.set("csrf_token", token);

  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  const cookie = options.cookie === undefined ? `${CSRF_RAW}.${signature}` : options.cookie;
  if (cookie !== null) headers.Cookie = `__Host-csrf=${cookie}`;
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin !== null) {
    headers.Origin = origin;
    headers["Sec-Fetch-Site"] = origin === ORIGIN ? "same-origin" : "cross-site";
  }

  return (options.app ?? app).fetch(new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: body.toString() }), env, execCtx);
}

// `async`, not a bare `return`, for the same reason `post` above is: Hono's
// own `fetch` is typed `Response | Promise<Response>` (it stays synchronous
// when every matched handler does), so returning it straight out of a
// `Promise<Response>` function is a type error. `tsc` catches that; vitest
// transpiles without typechecking and would not.
async function get(path: string, options: { app?: Hono<AppEnv> } = {}): Promise<Response> {
  return (options.app ?? app).fetch(new Request(`${ORIGIN}${path}`), env, execCtx);
}

// =============================================================================
// adminNeedDetail -- gfadmin/views.py:1753-1831 need()
// =============================================================================

describe("adminNeedDetail", () => {
  it("404s an id no need has, rather than rendering an empty page", async () => {
    const res = await get(`/admin/need/${needUuid(999)}/`);

    expect(res.status).toBe(404);
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it("renders the need, its 7-char id and its food bank's slug", async () => {
    const res = await get(`/admin/need/${REVIEW}/`);

    expect(res.status).toBe(200);
    expect(lastRender().template).toBe("admin/need.njk");
    const need = renderedNeed();
    expect(need.need_id).toBe(REVIEW);
    // models/needs.py:81-82's need_id_short, which titles the page and is the
    // only thing distinguishing several needs open in tabs.
    expect(need.need_id_short).toBe(REVIEW.slice(0, 7));
    expect(need.change_text).toBe("Tea\nCoffee");
    expect(need.input_method_human).toBe("Scraped");
    expect(need.input_method_emoji).toBe('<span class="mdi mdi-spider"></span>');
    expect(lastRender().context.foodbank_slug).toBe("salisbury");
  });

  // packages/db/src/uuid.ts's normalizeUuid: the stored form is dashless, but
  // Django's own URL converter is `<uuid:id>`, which matches the DASHED
  // spelling -- so every link anyone has ever copied out of the Django admin
  // is dashed. This route accepts both.
  it("finds the need from a dashed uuid, the form every Django-era link uses", async () => {
    const res = await get(`/admin/need/${dashed(REVIEW)}/`);

    expect(res.status).toBe(200);
    expect(renderedNeed().need_id).toBe(REVIEW);
  });

  // THE FILTER TEST. Four of the five needs seeded against Salisbury are
  // wrong answers here -- one published LATER, one published but belonging to
  // another food bank, one unpublished, and one older published -- and the
  // query has to reject all four. Seeding only the row that should match
  // would let `WHERE published = 1` alone (no food bank, no created bound)
  // pass.
  it("picks the latest STRICTLY EARLIER published need of the SAME food bank", async () => {
    await get(`/admin/need/${REVIEW}/`);

    const context = lastRender().context;
    expect((context.prev_published as { need_id: string }).need_id).toBe(PREV_PUB);
    expect((context.prev_published as { need_id_short: string }).need_id_short).toBe(PREV_PUB.slice(0, 7));
    // Same shape for the nonpertinent side: 2026-02-25's row belongs to
    // Amesbury and must not be offered as Salisbury's last rejection.
    expect((context.prev_nonpert as { need_id: string }).need_id).toBe(PREV_NONPERT);
  });

  // ONE PREDECESSOR, NOT BOTH. Every other case here has either both panels
  // or neither, and a handler that guarded `prev_published` on whether the
  // NONPERTINENT one exists (and vice versa) renders those identically. Added
  // on review because that mutant survived: Amesbury's rejected need
  // (2026-02-25) has a published predecessor (2026-02-20) and no rejected one,
  // so the swapped guard would blank the one panel that has something in it
  // while the diff below it still rendered.
  it("shows the published predecessor on a need that has no rejected one", async () => {
    await get(`/admin/need/${OTHER_FB_NONPERT}/`);

    const context = lastRender().context;
    expect((context.prev_published as { need_id: string }).need_id).toBe(OTHER_FB_PUB);
    expect(context.prev_nonpert).toBeNull();
    // The panel and its diff have to agree -- "Soup" became "Milk".
    expect(context.diff_from_pub).toBe("<del>Soup</del><br><ins>Milk</ins>");
    expect(context.diff_from_nonpert).toBe("");
  });

  it("diffs the current shopping list against both predecessors", async () => {
    await get(`/admin/need/${REVIEW}/`);

    const context = lastRender().context;
    // PREV_PUB is "Tea\nSugar", REVIEW is "Tea\nCoffee": Tea unchanged, Sugar
    // gone, Coffee new.
    expect(context.diff_from_pub).toBe("Tea<br><del>Sugar</del><br><ins>Coffee</ins>");
    // PREV_NONPERT has no excess text at all, REVIEW has "Pasta".
    expect(context.diff_from_pub_excess).toBe("<ins>Pasta</ins>");
    expect(context.diff_from_nonpert).toBe("Tea<br><ins>Coffee</ins>");
  });

  // THE FOURTH DIFF, added on review because nothing asserted it and two
  // separate mutants therefore survived: `diff_from_nonpert_excess: ""` and
  // "diff the excess against the PUBLISHED predecessor instead". With the
  // fixture as originally seeded, both predecessors had an empty excess list,
  // so all three implementations agreed by accident. Giving the rejected need
  // an excess list of its own is what separates them -- and it is the real
  // case, since the excess ("we have too much of this") list is exactly what
  // a reviewer checks a rejected need against.
  it("diffs the excess list against the NONPERTINENT predecessor's own excess list", async () => {
    db.prepare("UPDATE foodbankchange SET excess_change_text = ? WHERE need_id = ?").run("Rice", PREV_NONPERT);

    await get(`/admin/need/${REVIEW}/`);

    const context = lastRender().context;
    expect(context.diff_from_nonpert_excess).toBe("<del>Rice</del><br><ins>Pasta</ins>");
    // The published side is unmoved: PREV_PUB still has no excess list, so
    // the two panels must not show the same thing.
    expect(context.diff_from_pub_excess).toBe("<ins>Pasta</ins>");
  });

  it("leaves the diffs empty when there is no predecessor to diff against", async () => {
    // OLDER_PUB is Salisbury's earliest need, so nothing precedes it.
    await get(`/admin/need/${OLDER_PUB}/`);

    const context = lastRender().context;
    expect(context.prev_published).toBeNull();
    expect(context.diff_from_pub).toBe("");
    expect(context.diff_from_pub_excess).toBe("");
  });

  it("counts only this food bank's confirmed subscribers, across all four channels", async () => {
    await get(`/admin/need/${REVIEW}/`);

    const context = lastRender().context;
    // 2 of 3 Salisbury email rows are confirmed; the third address and every
    // Amesbury row are excluded.
    expect(context.subscriber_counts).toEqual({ email: 2, webpush: 3, mobile: 1, whatsapp: 2 });
    // The single total beside "Food Bank Subs". Summed in the handler, so a
    // channel dropped from the sum would show the admin a smaller audience
    // than the one about to be messaged -- and since github #37 took away the
    // confirm() dialog, this row is the ONLY place that audience is shown
    // before the send.
    expect(context.subscriber_count).toBe(8);
  });

  it("finds the crawl set the need came out of, through crawlitem.need_id", async () => {
    await get(`/admin/need/${REVIEW}/`);

    const crawlSet = lastRender().context.crawl_set as { crawl_set_id: number; crawl_type: string; finish: string | null };
    expect(crawlSet.crawl_set_id).toBe(5);
    expect(crawlSet.crawl_type).toBe("need");
    expect(crawlSet.finish).toBeNull();
  });

  // EVERY RELATIVE TIME ON THE PAGE, against one frozen clock. Added on
  // review: nothing asserted these, so four separate careless edits survived
  // the file untouched -- created_timesince and modified_timesince swapped for
  // each other, prev_published's dropped, the crawl set's dropped, and `now`
  // computed from `need.created` so that every need on every page read "0
  // minutes ago". This page exists to tell the reviewer how stale a need is,
  // and every one of those mutants answers that question wrongly while
  // rendering a perfectly healthy 200.
  //
  // The fixture's created (2026-03-01) and modified (2026-01-01) are
  // deliberately different values: equal ones cannot tell a swap apart.
  it("stamps the need, its predecessor and its crawl set against one clock", async () => {
    await atFrozenClock(() => get(`/admin/need/${REVIEW}/`));

    const need = renderedNeed();
    expect(need.created_timesince).toBe(`1${NB}month ago`);
    expect(need.modified_timesince).toBe(`3${NB}months ago`);
    // PREV_PUB, created 2026-02-01 -- the "you last published this long ago"
    // line beside the diff.
    expect((lastRender().context.prev_published as { created_timesince: string }).created_timesince).toBe(`2${NB}months ago`);
    // crawlset 5, started 2026-03-01. A crawl set with no finish is how a
    // stalled needcheck run is spotted, and this is the only cell that says
    // how long it has been stalled for.
    expect((lastRender().context.crawl_set as { start_timesince: string }).start_timesince).toBe(`1${NB}month ago`);
  });

  it("shows no crawl set for a need no crawl produced", async () => {
    await get(`/admin/need/${PUBLISHED}/`);

    expect(lastRender().context.crawl_set).toBeNull();
  });

  // THE GATE, pinned in both directions. `need.published ? ... : 0` means an
  // unpublished need reports 0 translations even when rows exist -- which is
  // right (nothing has been translated FOR it yet; these are leftovers) but
  // is exactly the kind of conditional that gets "simplified" away.
  it("reports 0 translations for an unpublished need even though rows exist", async () => {
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbankchangetranslation WHERE need_id = 10").get()).toEqual({ n: 3 });

    await get(`/admin/need/${REVIEW}/`);

    expect(lastRender().context.translation_count).toBe(0);
  });

  it("counts translations for a published need", async () => {
    await get(`/admin/need/${PUBLISHED}/`);

    expect(lastRender().context.translation_count).toBe(1);
  });

  it("renders a need with no food bank at all, rather than 500ing on the null", async () => {
    const res = await get(`/admin/need/${ORPHAN}/`);

    expect(res.status).toBe(200);
    const context = lastRender().context;
    expect(context.foodbank_slug).toBeNull();
    expect(context.prev_published).toBeNull();
    expect(context.prev_nonpert).toBeNull();
    expect(context.subscriber_counts).toEqual({ email: 0, webpush: 0, mobile: 0, whatsapp: 0 });
  });

  // GET MUST NOT WRITE. This route is read-only in its entirety, and the
  // cheapest way for that to stop being true is for someone to move a
  // "mark as seen" or a recompute into it.
  it("writes nothing", async () => {
    const before = db.prepare("SELECT * FROM foodbankchange ORDER BY id").all();
    const foodbanksBefore = db.prepare("SELECT * FROM foodbank ORDER BY id").all();

    await get(`/admin/need/${REVIEW}/`);

    expect(db.prepare("SELECT * FROM foodbankchange ORDER BY id").all()).toEqual(before);
    expect(db.prepare("SELECT * FROM foodbank ORDER BY id").all()).toEqual(foodbanksBefore);
  });
});

// =============================================================================
// computeNeedProxySrc, through the two routes that render a preview
// =============================================================================
//
// WP 6.3 removed Django's `?url=<anything>` proxy (an SSRF) and replaced it
// with "name a food bank FIELD, and pin the exact page with target=, which
// proxy.ts only honours when its origin matches that field's". So the
// preview only appears when the need's crawl-time `uri` shares an origin with
// one of the food bank's own URL fields -- and shows NOTHING rather than the
// wrong page when it does not. Both halves matter: a missing preview is an
// inconvenience, a preview of a different page silently compares the
// extraction to the wrong source.

describe("the need preview pane", () => {
  it("proxies through shopping_list_url when the need's uri shares its origin", async () => {
    await get(`/admin/need/${REVIEW}/`);

    const context = lastRender().context;
    expect(context.show_proxy).toBe(true);
    expect(context.proxy_src).toBe(
      `/admin/proxy/?foodbank=salisbury&field=shopping_list_url&target=${encodeURIComponent(SALISBURY.shopping_list_url)}`,
    );
  });

  // NEED_URI_PROXY_FIELDS is searched in order, shopping_list_url first.
  // Amesbury is the fixture whose two fields are on different origins, so
  // this is the only way to see the second entry get used at all.
  it("falls back to the url field when only that origin matches", async () => {
    db.prepare("UPDATE foodbankchange SET uri = ? WHERE need_id = ?").run("https://amesbury.foodbank.org.uk/news/were-short-of-tea/", OTHER_FB_PUB);

    await get(`/admin/need/${OTHER_FB_PUB}/`);

    expect(lastRender().context.proxy_src).toBe(
      `/admin/proxy/?foodbank=amesbury&field=url&target=${encodeURIComponent("https://amesbury.foodbank.org.uk/news/were-short-of-tea/")}`,
    );
  });

  it("shows nothing for a uri on an origin no field of the food bank uses", async () => {
    // A Distill-era uri, or one left behind after the food bank's URL was
    // edited. Django would still have framed it; here it is dropped.
    db.prepare("UPDATE foodbankchange SET uri = ? WHERE need_id = ?").run("https://old-host.example/shopping-list", REVIEW);

    await get(`/admin/need/${REVIEW}/`);

    expect(lastRender().context.show_proxy).toBe(false);
    expect(lastRender().context.proxy_src).toBeNull();
  });

  // THE GUARD, with a fixture that makes it load-bearing. Written first as
  // "a facebook.com uri on a food bank whose url fields are ordinary", which
  // proved nothing: no field's origin matched, so the search below returned
  // null anyway and DELETING the facebook/bankthefood check outright left
  // every assertion passing. It survived mutation for that reason.
  //
  // So the food bank's own `url` is set to the Facebook page here -- which is
  // the real shape, dozens of the smaller food banks having no site but a
  // Facebook one, and the reason the check exists at all. The origin now
  // matches, the field search finds it, and the literal check is the only
  // thing left standing between the reviewer and an <iframe> that can only
  // ever render a login wall or an X-Frame-Options refusal.
  it.each([
    ["facebook.com", "https://www.facebook.com/salisburyfoodbank", "https://www.facebook.com/salisburyfoodbank/posts/12345"],
    ["bankthefood.org", "https://bankthefood.org/foodbank/salisbury", "https://bankthefood.org/foodbank/salisbury/"],
  ])("refuses to frame a %s need even when the food bank's own url field is that page", async (_host, fieldUrl, needUri) => {
    db.prepare("UPDATE foodbank SET url = ? WHERE id = ?").run(fieldUrl, SALISBURY.id);
    db.prepare("UPDATE foodbankchange SET uri = ? WHERE need_id = ?").run(needUri, REVIEW);

    await get(`/admin/need/${REVIEW}/`);

    expect(lastRender().context.show_proxy).toBe(false);
    expect(lastRender().context.proxy_src).toBeNull();
  });

  // The control the two above are worthless without: the identical shape --
  // uri sharing an origin with the `url` field, shopping_list_url elsewhere --
  // on a host neither name matches DOES get a preview. Without this, a
  // handler that had stopped previewing anything at all would pass both.
  it("frames that same shape on a host neither name matches", async () => {
    db.prepare("UPDATE foodbank SET url = ? WHERE id = ?").run("https://mirror.example/salisburyfoodbank", SALISBURY.id);
    db.prepare("UPDATE foodbankchange SET uri = ? WHERE need_id = ?").run("https://mirror.example/salisburyfoodbank/posts/12345", REVIEW);

    await get(`/admin/need/${REVIEW}/`);

    expect(lastRender().context.show_proxy).toBe(true);
    expect(lastRender().context.proxy_src).toBe(
      `/admin/proxy/?foodbank=salisbury&field=url&target=${encodeURIComponent("https://mirror.example/salisburyfoodbank/posts/12345")}`,
    );
  });

  it("shows nothing for a need with no uri", async () => {
    db.prepare("UPDATE foodbankchange SET uri = NULL WHERE need_id = ?").run(REVIEW);

    await get(`/admin/need/${REVIEW}/`);

    expect(lastRender().context.show_proxy).toBe(false);
  });

  // The consequence the module comment discloses rather than works around:
  // a field-based proxy has no field to name when there is no food bank.
  it("shows nothing for a need with no food bank, however good its uri", async () => {
    db.prepare("UPDATE foodbankchange SET uri = ? WHERE need_id = ?").run(SALISBURY.shopping_list_url, ORPHAN);

    await get(`/admin/need/${ORPHAN}/`);

    expect(lastRender().context.show_proxy).toBe(false);
  });

  it("offers the same preview on the edit form as on the detail page", async () => {
    await get(`/admin/need/${REVIEW}/edit/`);

    expect(lastRender().template).toBe("admin/need_form.njk");
    expect(lastRender().context.proxy_src).toBe(
      `/admin/proxy/?foodbank=salisbury&field=shopping_list_url&target=${encodeURIComponent(SALISBURY.shopping_list_url)}`,
    );
  });
});

// =============================================================================
// CSRF and auth, across every mutating route
// =============================================================================
//
// Django's CsrfViewMiddleware is commented out in production (settings.py:97),
// so `{% csrf_token %}` is decorative there and every one of these POSTs is
// forgeable in the reference app. This port validates for real, and the
// assertion that matters is not the 403 but the row: a refusal that still
// deleted the need would return the same status.

const MUTATING_ROUTES: [name: string, path: string, fields: Record<string, string>][] = [
  ["publish", `/admin/need/${REVIEW}/publish/`, {}],
  ["unpublish", `/admin/need/${PUBLISHED}/unpublish/`, {}],
  ["notify", `/admin/need/${PUBLISHED}/notify/`, {}],
  ["nonpertinent", `/admin/need/${REVIEW}/nonpertinent/`, {}],
  ["delete", `/admin/need/${REVIEW}/delete/`, {}],
  ["delete-all", "/admin/needs/delete-all/", { need_id: REVIEW }],
  ["categorise", `/admin/need/${REVIEW}/categorise/`, { orig_item_0: "Tea", item_0: "Tea", type_0: "need", category_0: "Tea" }],
  ["edit", `/admin/need/${REVIEW}/edit/`, { change_text: "Rewritten" }],
];

describe("CSRF", () => {
  // A snapshot of everything a rejected request could plausibly have touched.
  // Compared whole rather than field by field, so a refusal that wrote
  // something nobody thought to check still fails.
  function everything(): unknown {
    return JSON.stringify({
      needs: db.prepare("SELECT * FROM foodbankchange ORDER BY id").all(),
      foodbanks: db.prepare("SELECT * FROM foodbank ORDER BY id").all(),
      lines: db.prepare("SELECT * FROM foodbankchangeline ORDER BY id").all(),
      crawlsets: db.prepare("SELECT * FROM crawlset ORDER BY id").all(),
    });
  }

  it.each(MUTATING_ROUTES)("refuses %s with no token, and changes nothing", async (_name, path, fields) => {
    const before = everything();

    const res = await post(path, fields, { token: null });

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden");
    expect(everything()).toBe(before);
    expect(jobsSendBatch).not.toHaveBeenCalled();
    expect(articlesSend).not.toHaveBeenCalled();
    expect(purgeSend).not.toHaveBeenCalled();
  });

  it.each(MUTATING_ROUTES)("refuses %s with a token that does not match the cookie", async (_name, path, fields) => {
    const before = everything();

    const res = await post(path, fields, { token: "c".repeat(64) });

    expect(res.status).toBe(403);
    expect(everything()).toBe(before);
  });

  it.each(MUTATING_ROUTES)("refuses %s with no cookie at all", async (_name, path, fields) => {
    const before = everything();

    const res = await post(path, fields, { cookie: null });

    expect(res.status).toBe(403);
    expect(everything()).toBe(before);
  });

  // The signature is what makes this a SIGNED double-submit rather than a
  // plain one: an attacker who can plant a cookie from a sibling subdomain
  // still cannot produce one that verifies without CSRF_SECRET. A raw token
  // echoed into both halves must not be enough.
  it("refuses a cookie whose HMAC does not verify, even when the form field matches it", async () => {
    const before = everything();

    const res = await post(`/admin/need/${REVIEW}/delete/`, {}, { cookie: `${CSRF_RAW}.${"0".repeat(64)}` });

    expect(res.status).toBe(403);
    expect(everything()).toBe(before);
  });

  it("refuses a cross-origin POST that otherwise carries a valid token pair", async () => {
    const before = everything();

    const res = await post(`/admin/need/${REVIEW}/delete/`, {}, { origin: "https://evil.example" });

    expect(res.status).toBe(403);
    expect(everything()).toBe(before);
  });
});

describe("auth", () => {
  // requireAdminAuth is mounted once for the whole sub-app
  // (routes/admin/index.ts:85), so none of these handlers checks for itself.
  // Mounted here for real: getAdminSession returns null on a request with no
  // session cookie without ever touching KV, so the redirect is the genuine
  // one Django's LoginRequiredAccess produces.
  it("redirects an unauthenticated GET to sign-in instead of rendering", async () => {
    const guarded = buildApp({ auth: true });

    const res = await get(`/admin/need/${REVIEW}/`, { app: guarded });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/auth/?next=${encodeURIComponent(`/admin/need/${REVIEW}/`)}`);
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it.each(MUTATING_ROUTES)("stops an unauthenticated %s before it reaches the handler", async (_name, path, fields) => {
    const guarded = buildApp({ auth: true });
    const before = needIdsInTable();

    const res = await post(path, fields, { app: guarded });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/auth/?next=${encodeURIComponent(path)}`);
    // The row is the assertion. A valid CSRF pair travelled with this
    // request, so nothing but the auth gate stood between it and the delete.
    expect(needIdsInTable()).toEqual(before);
    expect(jobsSendBatch).not.toHaveBeenCalled();
  });
});

// =============================================================================
// adminNeedPublish / adminNeedUnpublish -- gfadmin/views.py:1966-1976
// =============================================================================

describe("adminNeedPublish", () => {
  it("writes published = 1, stamps modified, and redirects back to the need", async () => {
    const res = await post(`/admin/need/${REVIEW}/publish/`, {});

    expect(res.status).toBe(302);
    // views.py:1975 `redirect("admin:need", id=need.need_id)` -- publish is
    // the one need action that returns you to the need it acted on.
    expect(res.headers.get("location")).toBe(`/admin/need/${REVIEW}/`);

    const row = storedNeed(REVIEW)!;
    expect(row.published).toBe(1);
    expect(row.modified).not.toBe(SEED_MODIFIED);
    expect(String(row.modified)).toMatch(PY_TIMESTAMP);
  });

  it("recomputes the food bank's latest_need_id and last_need", async () => {
    // REVIEW (2026-03-01) is newer than PREV_PUB but older than LATER_PUB, so
    // publishing it must NOT steal latest_need_id -- the recompute has to
    // re-derive it, not just assign the need it was handed.
    await post(`/admin/need/${REVIEW}/publish/`, {});
    expect(storedFoodbank(1).latest_need_id).toBe(13);

    // Publishing the newest unreviewed need does move it.
    db.prepare("UPDATE foodbankchange SET created = ? WHERE need_id = ?").run("2026-05-01 00:00:00.000000", UNPUB);
    await post(`/admin/need/${UNPUB}/publish/`, {});
    expect(storedFoodbank(1).latest_need_id).toBe(15);
    expect(storedFoodbank(1).last_need).toBe("2026-05-01 00:00:00.000000");
  });

  // needs.py:305-317's `do_translate = self.published`. Django enqueued these
  // TWICE (views.py:1973-1974 calls .save() then .save() again, WP 6.4
  // research): 38 tasks instead of 19. Exactly one batch here, and exactly
  // the three languages this app serves -- packages/db/migrations/
  // 0006_need_translations.sql has the 19-vs-3 accounting.
  it("enqueues exactly one translate batch, cy/ga/gd, keyed on the numeric need id", async () => {
    await post(`/admin/need/${REVIEW}/publish/`, {});

    expect(jobsSendBatch).toHaveBeenCalledTimes(1);
    expect(jobsSendBatch.mock.calls[0]?.[0]).toEqual([
      { body: { type: "translate-need", needId: 10, language: "cy" } },
      { body: { type: "translate-need", needId: 10, language: "ga" } },
      { body: { type: "translate-need", needId: 10, language: "gd" } },
    ]);
  });

  // Django's need_publish saves the food bank with do_decache=False, so
  // publishing a need has never purged anything there -- the food bank's own
  // next save eventually does it. Corrected in this port, and this is where
  // that correction is pinned.
  it("purges both the aggregate tag and this food bank's tag", async () => {
    await post(`/admin/need/${REVIEW}/publish/`, {});

    expect(purgeSend).toHaveBeenCalledTimes(1);
    expect(purgeSend.mock.calls[0]?.[0]).toEqual({ tags: [AGGREGATE_TAG, foodbankTag("salisbury")] });
  });

  // FoodbankChange.clean() (needs.py:77-79) declares this invalid, but
  // Django's need_publish never calls clean(), so its own Publish button
  // silently publishes a food-bank-less need onto no page at all. Refused
  // here.
  it("refuses to publish a need with no food bank, and leaves it unpublished", async () => {
    const res = await post(`/admin/need/${ORPHAN}/publish/`, {});

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Cannot publish a need with no food bank set");
    expect(storedNeed(ORPHAN)!.published).toBe(0);
    expect(storedNeed(ORPHAN)!.modified).toBe(SEED_MODIFIED);
    expect(jobsSendBatch).not.toHaveBeenCalled();
    expect(purgeSend).not.toHaveBeenCalled();
  });

  it("404s an unknown need without enqueueing anything", async () => {
    const res = await post(`/admin/need/${needUuid(999)}/publish/`, {});

    expect(res.status).toBe(404);
    expect(jobsSendBatch).not.toHaveBeenCalled();
  });

  // WORTH KNOWING, and pinned because it is a real asymmetry rather than an
  // oversight in this test: adminNeedDetail normalises a dashed uuid before
  // looking the need up, but setNeedPublished binds whatever the URL carried
  // straight into `WHERE need_id = ?`. So the detail page loads at a dashed
  // URL and a POST to the dashed publish URL 404s. It fails CLOSED, which is
  // the safe direction -- see adminNeedNotify below for the same asymmetry
  // failing open.
  it("404s a dashed uuid, where the detail page would have accepted it", async () => {
    expect((await get(`/admin/need/${dashed(REVIEW)}/`)).status).toBe(200);

    const res = await post(`/admin/need/${dashed(REVIEW)}/publish/`, {});

    expect(res.status).toBe(404);
    expect(storedNeed(REVIEW)!.published).toBe(0);
  });
});

describe("adminNeedUnpublish", () => {
  it("writes published = 0 and redirects back to the need", async () => {
    const res = await post(`/admin/need/${PUBLISHED}/unpublish/`, {});

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/admin/need/${PUBLISHED}/`);
    expect(storedNeed(PUBLISHED)!.published).toBe(0);
  });

  // `do_translate = self.published` resolves to false on unpublish, so Django
  // never re-translates there either. The purge, however, still fires: an
  // unpublish changes the public page just as much as a publish does.
  it("enqueues no translations but still purges", async () => {
    await post(`/admin/need/${PUBLISHED}/unpublish/`, {});

    expect(jobsSendBatch).not.toHaveBeenCalled();
    expect(purgeSend).toHaveBeenCalledTimes(1);
    expect(purgeSend.mock.calls[0]?.[0]).toEqual({ tags: [AGGREGATE_TAG, foodbankTag("salisbury")] });
  });

  // Django's need_publish only recomputes on publish (`if self.foodbank and
  // self.published and do_foodbank_save`), so unpublishing a food bank's
  // current latest_need leaves latest_need_id pointing at a need that is no
  // longer published. Fixed in this port -- the food bank drops back to the
  // one before it.
  it("moves latest_need_id back to the previous published need", async () => {
    // LATER_PUB (id 13) is the food bank's latest; PUBLISHED (id 19) is
    // dated 2026-03-03, so after 13 goes the answer is 19.
    await post(`/admin/need/${LATER_PUB}/unpublish/`, {});

    expect(storedFoodbank(1).latest_need_id).toBe(19);
    // last_need is every need's created, published or not, so the newest
    // remaining row wins -- 13 still exists, just unpublished.
    expect(storedFoodbank(1).last_need).toBe("2026-04-01 00:00:00.000000");
  });

  // setNeedPublished's "needs-foodbank" guard is on the PUBLISH direction
  // only, and it should be: an orphan need that somehow got published must
  // still be retractable.
  it("lets a need with no food bank be unpublished", async () => {
    db.prepare("UPDATE foodbankchange SET published = 1 WHERE need_id = ?").run(ORPHAN);

    const res = await post(`/admin/need/${ORPHAN}/unpublish/`, {});

    expect(res.status).toBe(302);
    expect(storedNeed(ORPHAN)!.published).toBe(0);
    // purgeFoodbank returns early on a null id -- nothing to name a tag for.
    expect(purgeSend).not.toHaveBeenCalled();
  });
});

// =============================================================================
// adminNeedNotify -- gfadmin/views.py:1993-2006 need_notifications
// =============================================================================

describe("adminNeedNotify", () => {
  it("stamps notified, enqueues one message per channel, and redirects back", async () => {
    const res = await post(`/admin/need/${PUBLISHED}/notify/`, {});

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/admin/need/${PUBLISHED}/`);

    // THE WRITE, read back. views.py:1988-1990 sets need.notified and saves;
    // without this column the admin has no way to tell an already-notified
    // need from one waiting, and would send twice.
    const row = storedNeed(PUBLISHED)!;
    expect(String(row.notified)).toMatch(PY_TIMESTAMP);
    expect(row.modified).toBe(row.notified);
  });

  // FOUR SEPARATE MESSAGES, not one that fans out: Django's four tasks fail
  // independently and so must these. An expired WhatsApp token must not stop
  // the emails. afterId is the paging cursor the jobs Worker resumes from --
  // absent on firebase, which addresses a topic and has nothing to page.
  it("enqueues all four channels in one batch with their paging cursors", async () => {
    await post(`/admin/need/${PUBLISHED}/notify/`, {});

    expect(jobsSendBatch).toHaveBeenCalledTimes(1);
    expect(jobsSendBatch.mock.calls[0]?.[0]).toEqual([
      { body: { type: "notify-need-email", needId: 19, afterId: 0 } },
      { body: { type: "notify-need-firebase", needId: 19 } },
      { body: { type: "notify-need-webpush", needId: 19, afterId: 0 } },
      { body: { type: "notify-need-whatsapp", needId: 19, afterId: 0 } },
    ]);
  });

  // views.py:1984-1986: the part of this action that is not a notification at
  // all. A crawl set is OPENED here, so this is one of the two places in
  // these routes that inserts a row rather than updating one -- and its id
  // has to reach both setCrawlSetExpected and the queue message.
  it("opens an article crawl set and hands its id to the articles queue", async () => {
    await post(`/admin/need/${PUBLISHED}/notify/`, {});

    const crawlSets = db.prepare("SELECT * FROM crawlset WHERE crawl_type = 'article'").all() as {
      id: number;
      run_id: string | null;
      expected: number;
      remaining: number;
      start: string;
    }[];
    expect(crawlSets).toHaveLength(1);
    const crawlSet = crawlSets[0]!;
    expect(crawlSet.run_id).toBeNull();
    // setCrawlSetExpected writes `expected = ?1, remaining = ?1` -- one food
    // bank to crawl, one still outstanding.
    expect(crawlSet.expected).toBe(1);
    expect(crawlSet.remaining).toBe(1);
    expect(crawlSet.start).toMatch(PY_TIMESTAMP);

    expect(articlesSend).toHaveBeenCalledTimes(1);
    expect(articlesSend.mock.calls[0]?.[0]).toEqual({ crawlSetId: crawlSet.id, foodbankId: 1, slug: "salisbury" });
  });

  // THE GUARD, tested from the side that must do nothing. Django's `if
  // foodbank.rss_url` is the same check; a version that dropped it would open
  // an article crawl set for every food bank with no feed, each one stuck at
  // remaining = 1 forever (a crawl set with finish IS NULL is exactly how a
  // stalled run is detected -- 0008_needcheck.sql).
  it("opens no crawl set for a food bank with no RSS feed", async () => {
    db.prepare("UPDATE foodbankchange SET foodbank_id = 2, published = 1 WHERE need_id = ?").run(REVIEW);

    const res = await post(`/admin/need/${REVIEW}/notify/`, {});

    expect(res.status).toBe(302);
    expect(db.prepare("SELECT * FROM crawlset WHERE crawl_type = 'article'").all()).toHaveLength(0);
    expect(articlesSend).not.toHaveBeenCalled();
    // The notifications themselves still went.
    expect(jobsSendBatch).toHaveBeenCalledTimes(1);
  });

  // views.py only offers Notify on a published need (need.html:123-124 wraps
  // the button in `{% if need.published %}`), and an unpublished need's page
  // is not one to send 5,855 people to.
  it("refuses to notify about an unpublished need, and stamps nothing", async () => {
    const res = await post(`/admin/need/${REVIEW}/notify/`, {});

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Cannot notify subscribers about an unpublished need");
    expect(storedNeed(REVIEW)!.notified).toBeNull();
    expect(storedNeed(REVIEW)!.modified).toBe(SEED_MODIFIED);
    expect(jobsSendBatch).not.toHaveBeenCalled();
    expect(articlesSend).not.toHaveBeenCalled();
  });

  it("refuses to notify about a need with no food bank", async () => {
    db.prepare("UPDATE foodbankchange SET published = 1 WHERE need_id = ?").run(ORPHAN);

    const res = await post(`/admin/need/${ORPHAN}/notify/`, {});

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Cannot notify: this need has no food bank");
    expect(storedNeed(ORPHAN)!.notified).toBeNull();
    expect(jobsSendBatch).not.toHaveBeenCalled();
  });

  it("404s an unknown need", async () => {
    const res = await post(`/admin/need/${needUuid(999)}/notify/`, {});

    expect(res.status).toBe(404);
    expect(jobsSendBatch).not.toHaveBeenCalled();
  });

  // SUSPECT -- pinned as it behaves today, not as it should.
  //
  // This handler looks the need up with getNeedByUuid (which normalises a
  // dashed uuid) and then writes it with setNeedNotified(db, needId), where
  // needId is the RAW URL parameter -- packages/db/src/needAdmin.ts:248-251
  // does no normalising of its own. So a dashed uuid finds the need, sends
  // every notification to every subscriber, redirects 302 as though it
  // worked, and updates ZERO rows: `notified` stays NULL and the Notify
  // button stays armed. That is #34's exact shape -- a redirect standing in
  // for a write that no SQL performed -- and it is the only handler in this
  // file that mixes a normalised read with an un-normalised write. Every
  // other route either normalises both (categorise, edit, which pass
  // need.need_id back) or fails closed with a 404 (publish, nonpertinent,
  // delete).
  //
  // Not reachable from the admin as it stands -- need.njk:124 builds the form
  // action from `need.need_id`, which is the dashless value off the row -- so
  // it needs a hand-built POST or a future template that forwards the URL's
  // own spelling. Reported, not fixed.
  it("SUSPECT: notifies everyone but never stamps `notified` when the URL is dashed", async () => {
    const res = await post(`/admin/need/${dashed(PUBLISHED)}/notify/`, {});

    expect(res.status).toBe(302);
    // Everything that leaves the building happened.
    expect(jobsSendBatch).toHaveBeenCalledTimes(1);
    expect(articlesSend).toHaveBeenCalledTimes(1);
    // The write did not.
    expect(storedNeed(PUBLISHED)!.notified).toBeNull();
    expect(storedNeed(PUBLISHED)!.modified).toBe(SEED_MODIFIED);
  });
});

// =============================================================================
// adminNeedNonpertinent -- gfadmin/views.py:1949-1955
// =============================================================================

describe("adminNeedNonpertinent", () => {
  it("flags the need and returns the reviewer to the queue, not to the need", async () => {
    const res = await post(`/admin/need/${REVIEW}/nonpertinent/`, {});

    expect(res.status).toBe(302);
    // views.py:1955 `redirect("admin:index")`. Rejecting is the last thing a
    // reviewer does with a need, so this is deliberately NOT the need's page
    // -- unlike publish, which returns there.
    expect(res.headers.get("location")).toBe("/admin/");

    const row = storedNeed(REVIEW)!;
    expect(row.nonpertinent).toBe(1);
    expect(String(row.modified)).toMatch(PY_TIMESTAMP);
    expect(row.modified).not.toBe(SEED_MODIFIED);
  });

  // Rejection is not un-publication: Django's need_nonpertinent sets one flag
  // and saves. A row can legitimately be both, and the review queue
  // (`published = 0 AND nonpertinent = 0`) excludes it either way.
  it("does not unpublish a published need it rejects", async () => {
    await post(`/admin/need/${PUBLISHED}/nonpertinent/`, {});

    const row = storedNeed(PUBLISHED)!;
    expect(row.nonpertinent).toBe(1);
    expect(row.published).toBe(1);
  });

  it("recomputes the food bank's cached need fields", async () => {
    db.prepare("UPDATE foodbank SET latest_need_id = NULL, last_need = NULL WHERE id = 1").run();

    await post(`/admin/need/${REVIEW}/nonpertinent/`, {});

    expect(storedFoodbank(1).latest_need_id).toBe(13);
    expect(storedFoodbank(1).last_need).toBe("2026-04-01 00:00:00.000000");
  });

  // Pinned because it is a real difference from the publish path rather than
  // an omission in this test: rejecting a need cannot change any public page
  // (it was never on one), so there is nothing to purge.
  it("purges nothing", async () => {
    await post(`/admin/need/${REVIEW}/nonpertinent/`, {});

    expect(purgeSend).not.toHaveBeenCalled();
  });

  it("404s an unknown need", async () => {
    const res = await post(`/admin/need/${needUuid(999)}/nonpertinent/`, {});

    expect(res.status).toBe(404);
  });

  it("404s a dashed uuid rather than silently flagging nothing", async () => {
    const res = await post(`/admin/need/${dashed(REVIEW)}/nonpertinent/`, {});

    expect(res.status).toBe(404);
    expect(storedNeed(REVIEW)!.nonpertinent).toBe(0);
  });
});

// =============================================================================
// adminNeedDelete -- gfadmin/views.py:1929-1935
// =============================================================================

describe("adminNeedDelete", () => {
  it("deletes the row and returns to the queue", async () => {
    const res = await post(`/admin/need/${REVIEW}/delete/`, {});

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/");
    expect(storedNeed(REVIEW)).toBeUndefined();
    // Only that one.
    expect(needIdsInTable()).toHaveLength(9);
  });

  // FoodbankChange.delete() (needs.py:319-328) always recomputes, regardless
  // of whether the deleted need was published -- unlike need_publish's
  // unpublish path, this one Django gets right.
  it("recomputes the food bank after deleting its latest published need", async () => {
    await post(`/admin/need/${LATER_PUB}/delete/`, {});

    expect(storedFoodbank(1).latest_need_id).toBe(19);
    // 2026-04-01's row is gone, so the newest remaining Salisbury need is
    // ORPHAN's sibling PUBLISHED at 2026-03-03.
    expect(storedFoodbank(1).last_need).toBe("2026-03-03 00:00:00.000000");
  });

  it("clears the cached fields when the last need of a food bank goes", async () => {
    for (const needId of [PREV_PUB, OLDER_PUB, LATER_PUB, UNPUB, PREV_NONPERT, PUBLISHED, REVIEW]) {
      await post(`/admin/need/${needId}/delete/`, {});
    }

    expect(storedFoodbank(1)).toEqual({ latest_need_id: null, last_need: null });
  });

  // Existing, accepted behaviour rather than something this port introduces:
  // Django's model delete() doesn't touch these either, and §4.5's
  // no-FK-constraints convention means D1 would not cascade anyway. Pinned so
  // that a future ON DELETE CASCADE is a deliberate decision with a failing
  // test attached, not a silent change to what an "orphaned line" means.
  it("leaves the need's lines and translations behind as orphans", async () => {
    db.prepare("INSERT INTO foodbankchangeline (need_id, foodbank_id, item, type, category, group_name, created) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      10,
      1,
      "Tea",
      "need",
      "Tea",
      "Drink",
      "2026-03-01 00:00:00.000000",
    );

    await post(`/admin/need/${REVIEW}/delete/`, {});

    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbankchangeline WHERE need_id = 10").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbankchangetranslation WHERE need_id = 10").get()).toEqual({ n: 3 });
  });

  it("404s an unknown need", async () => {
    const res = await post(`/admin/need/${needUuid(999)}/delete/`, {});

    expect(res.status).toBe(404);
    expect(needIdsInTable()).toHaveLength(10);
  });

  it("404s a dashed uuid rather than reporting a delete that did not happen", async () => {
    const res = await post(`/admin/need/${dashed(REVIEW)}/delete/`, {});

    expect(res.status).toBe(404);
    expect(storedNeed(REVIEW)).toBeDefined();
  });
});

// =============================================================================
// adminNeedsDeleteAll -- gfadmin/views.py:423-428 needs_deleteall
// =============================================================================

describe("adminNeedsDeleteAll", () => {
  it("deletes every posted need and leaves every unposted one alone", async () => {
    const body = new URLSearchParams();
    body.append("need_id", REVIEW);
    body.append("need_id", UNPUB);

    const res = await post("/admin/needs/delete-all/", body);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/");
    // THE EXCLUSION HALF. A handler that ignored the list and deleted the
    // whole review queue would pass a test that only checked the two rows it
    // was told about.
    expect(needIdsInTable()).toEqual([PREV_PUB, OLDER_PUB, LATER_PUB, OTHER_FB_PUB, PREV_NONPERT, OTHER_FB_NONPERT, ORPHAN, PUBLISHED]);
  });

  // parseBody({ all: true }) is what makes the repeated field name work.
  // Without it Hono returns only the LAST value, so a "Delete all" on a
  // 116-need backlog would delete one need and report success -- which is
  // why the flag is asserted through its effect on two rows, not one.
  it("deletes both values of a repeated field name, not just the last", async () => {
    const body = new URLSearchParams();
    body.append("need_id", PREV_PUB);
    body.append("need_id", OLDER_PUB);

    await post("/admin/needs/delete-all/", body);

    expect(storedNeed(PREV_PUB)).toBeUndefined();
    expect(storedNeed(OLDER_PUB)).toBeUndefined();
  });

  it("handles a single need_id, where parseBody returns a bare string", async () => {
    await post("/admin/needs/delete-all/", { need_id: REVIEW });

    expect(storedNeed(REVIEW)).toBeUndefined();
    expect(needIdsInTable()).toHaveLength(9);
  });

  it("does nothing, successfully, when the form posts no ids at all", async () => {
    const res = await post("/admin/needs/delete-all/", {});

    expect(res.status).toBe(302);
    expect(needIdsInTable()).toHaveLength(10);
  });

  // Reported 2026-09-05 with 116 unreviewed needs on the dashboard: the whole
  // list used to go into one `need_id IN (?, ?, ...)`, which is fine until
  // D1's 100-bound-parameter cap and then 500s -- precisely when the queue is
  // big enough for anyone to want the button. Chunked at 90 now. node:sqlite
  // has no such cap, so what this proves is the CHUNKED LOOP: that every
  // chunk's DELETE runs and none is dropped by an off-by-one in the slicing.
  it("deletes a backlog larger than one chunk, every row of it", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) {
      const id = needUuid(1000 + i);
      ids.push(id);
      seedNeed({ id: 1000 + i, needId: id, foodbankId: 1, changeText: "Tea", created: "2026-06-01 00:00:00.000000" });
    }
    const body = new URLSearchParams();
    for (const id of ids) body.append("need_id", id);

    const res = await post("/admin/needs/delete-all/", body);

    expect(res.status).toBe(302);
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbankchange WHERE id >= 1000").get()).toEqual({ n: 0 });
    // The ten original rows are untouched.
    expect(needIdsInTable()).toHaveLength(10);
  });

  // Django's QuerySet .delete() bypasses the model's delete() override
  // entirely, so no food bank is recomputed there at all (WP 6.4 research).
  // Fixed here -- and a stale latest_need_id pointing at a deleted row is a
  // 500 on the public food bank page, not a cosmetic problem.
  it("recomputes every food bank the deleted needs belonged to", async () => {
    const body = new URLSearchParams();
    body.append("need_id", LATER_PUB); // Salisbury's latest
    body.append("need_id", OTHER_FB_PUB); // Amesbury's latest

    await post("/admin/needs/delete-all/", body);

    expect(storedFoodbank(1).latest_need_id).toBe(19);
    expect(storedFoodbank(2)).toEqual({ latest_need_id: null, last_need: "2026-02-25 00:00:00.000000" });
  });

  // Django reads `request.POST.getlist("need")`; this port reads `need_id`,
  // matching its own dashboard form (admin/index.njk:14). Pinned because the
  // divergence is invisible: a stale bookmarked form posting Django's name
  // deletes nothing and still redirects as though it had worked. It fails
  // SAFE, which is why it is recorded rather than "fixed" by accepting both.
  it("ignores Django's `need` field name entirely", async () => {
    const body = new URLSearchParams();
    body.append("need", REVIEW);

    const res = await post("/admin/needs/delete-all/", body);

    expect(res.status).toBe(302);
    expect(needIdsInTable()).toHaveLength(10);
  });
});

// =============================================================================
// adminNeedCategorise -- gfadmin/views.py:2041-2135
// =============================================================================

function seedLine(id: number, needId: number, item: string, category: string, group: string, type = "need"): void {
  db.prepare("INSERT INTO foodbankchangeline (id, need_id, foodbank_id, item, type, category, group_name, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    needId,
    1,
    item,
    type,
    category,
    group,
    "2026-01-01 00:00:00.000000",
  );
}

describe("adminNeedCategorise -- GET", () => {
  it("404s an unknown need", async () => {
    const res = await get(`/admin/need/${needUuid(999)}/categorise/`);

    expect(res.status).toBe(404);
  });

  it("builds one row per shopping-list line, then one per excess line", async () => {
    const res = await get(`/admin/need/${REVIEW}/categorise/`);

    expect(res.status).toBe(200);
    expect(lastRender().template).toBe("admin/need_categorise.njk");
    expect(lastRender().context.lines).toEqual([
      { item: "Tea", type: "need", category: null },
      { item: "Coffee", type: "need", category: null },
      { item: "Pasta", type: "excess", category: null },
    ]);
    expect(renderedNeed().need_id_short).toBe(REVIEW.slice(0, 7));
    // The <select>'s options: the 50 keys of ITEM_CATEGORY_GROUPS, sorted.
    expect(lastRender().context.categories).toContain("Tinned Tomatoes");
  });

  it("omits the excess rows entirely when the need has no excess text", async () => {
    await get(`/admin/need/${PUBLISHED}/categorise/`);

    expect(lastRender().context.lines).toEqual([
      { item: "Tea", type: "need", category: null },
      { item: "Coffee", type: "need", category: null },
    ]);
  });

  // views.py:2062-2067's `.annotate(latest_id=Max('id'))` -- the suggestion
  // is the most recently created line ANYWHERE with this exact item text, so
  // that a category corrected last week is the one offered this week. Ordered
  // by id, NOT created: created is copied from the need, so it ties across
  // every line of one need and cannot break the tie.
  it("suggests the newest category anyone has given this item text before", async () => {
    seedLine(1, 99, "Tea", "Coffee", "Drink"); // an older, wrong guess
    seedLine(2, 98, "Tea", "Tea", "Drink"); // corrected later -- higher id wins

    await get(`/admin/need/${REVIEW}/categorise/`);

    expect((lastRender().context.lines as { item: string; category: string | null }[])[0]).toEqual({ item: "Tea", type: "need", category: "Tea" });
  });

  // views.py:2071-2074's `instance=existing_need_lines.get(line)`: a line
  // already categorised for THIS need is not a suggestion, it is the answer,
  // and it must beat a newer line elsewhere. Seeded with a LOWER id than the
  // competing suggestion so that "newest wins" alone would give the wrong one.
  it("prefers this need's own existing line over any suggestion", async () => {
    seedLine(1, 10, "Tea", "Other", "Other"); // this need's own, id 1
    seedLine(2, 98, "Tea", "Tea", "Drink"); // newer, elsewhere

    await get(`/admin/need/${REVIEW}/categorise/`);

    expect((lastRender().context.lines as { category: string | null }[])[0]?.category).toBe("Other");
  });

  it("writes nothing", async () => {
    seedLine(1, 98, "Tea", "Tea", "Drink");
    const linesBefore = db.prepare("SELECT * FROM foodbankchangeline ORDER BY id").all();

    await get(`/admin/need/${REVIEW}/categorise/`);

    expect(db.prepare("SELECT * FROM foodbankchangeline ORDER BY id").all()).toEqual(linesBefore);
    expect(storedNeed(REVIEW)!.is_categorised).toBeNull();
    expect(storedNeed(REVIEW)!.modified).toBe(SEED_MODIFIED);
  });
});

describe("adminNeedCategorise -- POST", () => {
  // The body need_categorise.njk actually submits: item_N (the editable box),
  // orig_item_N and type_N (hidden), category_N (the <select>).
  function row(i: number, item: string, type: string, category: string, edited?: string): Record<string, string> {
    return {
      [`item_${i}`]: edited ?? item,
      [`orig_item_${i}`]: item,
      [`type_${i}`]: type,
      [`category_${i}`]: category,
    };
  }

  it("inserts one line per row, with the group and created date derived not submitted", async () => {
    const res = await post(`/admin/need/${REVIEW}/categorise/`, {
      ...row(0, "Tea", "need", "Tea"),
      ...row(1, "Coffee", "need", "Coffee"),
      ...row(2, "Pasta", "excess", "Pasta"),
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/admin/need/${REVIEW}/`);
    expect(storedLines(10)).toEqual([
      // group_name comes from ITEM_CATEGORY_GROUPS, never from the form, and
      // created is copied from the NEED (needs.py:374), not now() -- the
      // category-history queries order by it.
      { item: "Tea", type: "need", category: "Tea", group_name: "Drink", foodbank_id: 1, created: "2026-03-01 00:00:00.000000" },
      { item: "Coffee", type: "need", category: "Coffee", group_name: "Drink", foodbank_id: 1, created: "2026-03-01 00:00:00.000000" },
      { item: "Pasta", type: "excess", category: "Pasta", group_name: "Meal Food", foodbank_id: 1, created: "2026-03-01 00:00:00.000000" },
    ]);
  });

  it("flags the need categorised and stamps modified", async () => {
    await post(`/admin/need/${REVIEW}/categorise/`, row(0, "Tea", "need", "Tea"));

    const stored = storedNeed(REVIEW)!;
    expect(stored.is_categorised).toBe(1);
    expect(String(stored.modified)).toMatch(PY_TIMESTAMP);
  });

  it("updates an existing line in place rather than adding a second", async () => {
    seedLine(1, 10, "Tea", "Other", "Other");

    await post(`/admin/need/${REVIEW}/categorise/`, row(0, "Tea", "need", "Tea"));

    expect(storedLines(10)).toEqual([
      { item: "Tea", type: "need", category: "Tea", group_name: "Drink", foodbank_id: 1, created: "2026-01-01 00:00:00.000000" },
    ]);
  });

  // The loop is `for (let i = 0; ; i++)` with a break on the first missing
  // index, so a body with a hole in it stops there. Pinned because the
  // template only ever renders a contiguous run -- if that ever stops being
  // true, everything past the gap is dropped silently.
  it("stops at the first missing index, dropping everything past the gap", async () => {
    await post(`/admin/need/${REVIEW}/categorise/`, {
      ...row(0, "Tea", "need", "Tea"),
      ...row(2, "Pasta", "excess", "Pasta"),
    });

    expect(storedLines(10).map((line) => line.item)).toEqual(["Tea"]);
  });

  // `continue`, not `break`: leaving one row's <select> on "-- choose --"
  // must not silently discard every row after it. This is the difference
  // between "I forgot one" and "only the first three saved".
  it("skips a row with no category chosen and keeps going", async () => {
    await post(`/admin/need/${REVIEW}/categorise/`, {
      ...row(0, "Tea", "need", ""),
      ...row(1, "Coffee", "need", "Coffee"),
    });

    expect(storedLines(10).map((line) => line.item)).toEqual(["Coffee"]);
    // The need is still flagged categorised even with a row left blank --
    // Django's `form.is_valid()` loop behaves the same way.
    expect(storedNeed(REVIEW)!.is_categorised).toBe(1);
  });

  it("skips a row whose type is neither need nor excess", async () => {
    await post(`/admin/need/${REVIEW}/categorise/`, {
      ...row(0, "Tea", "surplus", "Tea"),
      ...row(1, "Coffee", "need", "Coffee"),
    });

    expect(storedLines(10).map((line) => line.item)).toEqual(["Coffee"]);
  });

  // A cleared box is not a rename. Without this fallback an admin who
  // selected the item text and deleted it would store a line with an empty
  // item -- which no future need would ever match for a suggestion.
  it("keeps the rendered text when the item box is submitted empty", async () => {
    await post(`/admin/need/${REVIEW}/categorise/`, row(0, "Tea", "need", "Tea", ""));

    expect(storedLines(10)[0]?.item).toBe("Tea");
  });

  // The fallback for a page served before orig_item_N existed: without it,
  // `origItem` would be undefined at i=0, the loop would break immediately
  // and a submitted form would categorise nothing while still redirecting.
  it("falls back to item_N when the page had no orig_item_N", async () => {
    await post(`/admin/need/${REVIEW}/categorise/`, { item_0: "Tea", type_0: "need", category_0: "Tea" });

    expect(storedLines(10).map((line) => line.item)).toEqual(["Tea"]);
  });

  // KNOWN GAP, documented in the handler and pinned here so it is a decision
  // rather than a surprise. upsertNeedLine matches on `item`, not on the
  // original, so correcting a line's text on a SECOND pass inserts a new row
  // beside the old one instead of renaming it the way Django's
  // `instance=need_line` does. First-time categorisation is unaffected.
  it("SUSPECT: leaves a stale duplicate behind when a line's text is corrected", async () => {
    await post(`/admin/need/${REVIEW}/categorise/`, row(0, "Tinned Tomatos", "need", "Tinned Tomatoes"));
    expect(storedLines(10)).toHaveLength(1);

    // Same rendered row, text corrected in the box.
    await post(`/admin/need/${REVIEW}/categorise/`, row(0, "Tinned Tomatos", "need", "Tinned Tomatoes", "Tinned Tomatoes"));

    expect(storedLines(10).map((line) => line.item)).toEqual(["Tinned Tomatos", "Tinned Tomatoes"]);
  });

  // FoodbankChange.clean()'s invariant again: a line carries foodbank_id NOT
  // NULL (0003_homepage_data.sql:31), so there is nothing to write it as.
  it("refuses to categorise a need with no food bank, and writes no lines", async () => {
    const res = await post(`/admin/need/${ORPHAN}/categorise/`, row(0, "Beans", "need", "Baked Beans"));

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Cannot categorise a need with no food bank set");
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbankchangeline").get()).toEqual({ n: 0 });
    expect(storedNeed(ORPHAN)!.is_categorised).toBeNull();
  });

  it("404s an unknown need", async () => {
    const res = await post(`/admin/need/${needUuid(999)}/categorise/`, row(0, "Tea", "need", "Tea"));

    expect(res.status).toBe(404);
  });

  // SUSPECT, and pinned exactly as it behaves. upsertNeedLine throws on a
  // category outside ITEM_CATEGORY_GROUPS (needLines.ts:123-124), which
  // reaches app.onError as a 500 -- and because the throw happens INSIDE the
  // per-row loop, the rows before it are already written while
  // setNeedCategorised never runs. So a hand-posted or stale category leaves
  // the need half-categorised, unflagged, and on an error page.
  //
  // Not reachable from the rendered form (need_categorise.njk:67-68 emits
  // only ITEM_CATEGORIES), but a page left open across a deploy that renamed
  // a category would post the old name.
  it("SUSPECT: 500s on an unknown category, after writing the rows before it", async () => {
    const res = await post(`/admin/need/${REVIEW}/categorise/`, {
      ...row(0, "Tea", "need", "Tea"),
      ...row(1, "Coffee", "need", "Hot Drinks"), // not an ITEM_CATEGORY_GROUPS key
    });

    expect(res.status).toBe(500);
    expect(await res.text()).toContain("unknown item category: Hot Drinks");
    // The partial write, and the flag that never got set.
    expect(storedLines(10).map((line) => line.item)).toEqual(["Tea"]);
    expect(storedNeed(REVIEW)!.is_categorised).toBeNull();
  });

  // The categorise route is one function serving GET and POST, and the GET
  // half renders. A method mix-up would show as this redirect becoming a 200.
  it("redirects rather than rendering, so the POST half is definitely the POST half", async () => {
    await post(`/admin/need/${REVIEW}/categorise/`, row(0, "Tea", "need", "Tea"));

    expect(mocks.render).not.toHaveBeenCalled();
  });
});

// =============================================================================
// adminNeedTranslations -- gfadmin/views.py:2011-2020
// =============================================================================

describe("adminNeedTranslations", () => {
  it("404s an unknown need", async () => {
    const res = await get(`/admin/need/${needUuid(999)}/translations/`);

    expect(res.status).toBe(404);
  });

  // Ordered by language, and scoped to this need: the fixture seeds them out
  // of order (gd, cy, ga) precisely so an unordered query cannot pass, and
  // seeds a fourth row on a different need so a missing WHERE cannot either.
  it("lists this need's translations, ordered by language", async () => {
    const res = await get(`/admin/need/${REVIEW}/translations/`);

    expect(res.status).toBe(200);
    expect(lastRender().template).toBe("admin/need_translations.njk");
    expect(lastRender().context.translations).toEqual([
      { language: "cy", change_text: "Te\nCoffi", excess_change_text: "Pasta" },
      { language: "ga", change_text: "Tae\nCaife", excess_change_text: null },
      { language: "gd", change_text: "Ti\nCofaidh", excess_change_text: null },
    ]);
  });

  // The detail page hides the count behind `need.published`; this viewer does
  // not, and should not -- it is the page you open to find out why a
  // translation looks wrong, including on a need you have just unpublished.
  it("shows an unpublished need's translations, unlike the detail page's count", async () => {
    expect(storedNeed(REVIEW)!.published).toBe(0);

    await get(`/admin/need/${REVIEW}/translations/`);

    expect(lastRender().context.translations).toHaveLength(3);
  });

  it("renders an empty list rather than 404ing when nothing is translated", async () => {
    const res = await get(`/admin/need/${LATER_PUB}/translations/`);

    expect(res.status).toBe(200);
    expect(lastRender().context.translations).toEqual([]);
  });

  it("carries the same need header the detail page builds", async () => {
    await get(`/admin/need/${REVIEW}/translations/`);

    const need = renderedNeed();
    expect(need.need_id_short).toBe(REVIEW.slice(0, 7));
    expect(need.input_method_human).toBe("Scraped");
    expect(lastRender().context.foodbank_slug).toBe("salisbury");
  });

  // This viewer builds its OWN copy of the header's relative times rather
  // than sharing the detail page's, so the same swap is a separate mutant
  // here and the detail page's test cannot catch it. Frozen clock, same
  // reasoning as there.
  it("stamps its header's relative times the same way the detail page does", async () => {
    await atFrozenClock(() => get(`/admin/need/${REVIEW}/translations/`));

    const need = renderedNeed();
    expect(need.created_timesince).toBe(`1${NB}month ago`);
    expect(need.modified_timesince).toBe(`3${NB}months ago`);
  });

  it("renders a need with no food bank", async () => {
    const res = await get(`/admin/need/${ORPHAN}/translations/`);

    expect(res.status).toBe(200);
    expect(lastRender().context.foodbank_slug).toBeNull();
  });

  it("writes nothing", async () => {
    const before = db.prepare("SELECT * FROM foodbankchange ORDER BY id").all();

    await get(`/admin/need/${REVIEW}/translations/`);

    expect(db.prepare("SELECT * FROM foodbankchange ORDER BY id").all()).toEqual(before);
  });
});

// =============================================================================
// adminNeedEditForm -- gfadmin/views.py:1916-1946 need_form, edit half
// =============================================================================
//
// Three editable fields survive NeedForm's `exclude` and FoodbankChange's
// editable=False columns: change_text, excess_change_text, published. (Django
// has a fourth, `foodbank`; this form dropped it -- maintainer decision
// 2026-09-05, need_form.njk:37-47.) Every one of the three is written by the
// same UPDATE, so the round-trip tests below are what stand between this form
// and #34: a field the form renders, the browser posts, and no SQL stores.

describe("adminNeedEditForm -- GET", () => {
  it("404s an unknown need", async () => {
    const res = await get(`/admin/need/${needUuid(999)}/edit/`);

    expect(res.status).toBe(404);
  });

  it("renders the form holding the stored values, with no error", async () => {
    const res = await get(`/admin/need/${REVIEW}/edit/`);

    expect(res.status).toBe(200);
    expect(lastRender().template).toBe("admin/need_form.njk");
    const need = renderedNeed();
    expect(need.change_text).toBe("Tea\nCoffee");
    expect(need.excess_change_text).toBe("Pasta");
    expect(need.published).toBe(false);
    expect(lastRender().context.error).toBeNull();
  });

  it("writes nothing", async () => {
    const before = db.prepare("SELECT * FROM foodbankchange ORDER BY id").all();

    await get(`/admin/need/${REVIEW}/edit/`);

    expect(db.prepare("SELECT * FROM foodbankchange ORDER BY id").all()).toEqual(before);
  });
});

describe("adminNeedEditForm -- POST", () => {
  // What need_form.njk actually submits, built from the context the handler
  // just handed the template rather than from the database row -- a value
  // only comes back on a POST if the form was given it AND renders a field
  // for it, and that is the link being tested.
  function browserWouldSubmit(need: Record<string, unknown>, edits: Record<string, string> = {}): Record<string, string> {
    const body: Record<string, string> = {
      change_text: String(need.change_text ?? ""),
      // nunjucks renders null into a textarea as "" (env.ts pins
      // throwOnUndefined: false for exactly that).
      excess_change_text: need.excess_change_text === null || need.excess_change_text === undefined ? "" : String(need.excess_change_text),
    };
    // An unchecked checkbox is ABSENT from the body; that absence is its
    // false state.
    if (need.published) body.published = "1";
    return { ...body, ...edits };
  }

  async function openEditForm(needId: string): Promise<Record<string, unknown>> {
    const res = await get(`/admin/need/${needId}/edit/`);
    expect(res.status).toBe(200);
    return renderedNeed();
  }

  // THE #34 TEST, first half: every field the form declares actually changes
  // the row when the admin changes it. A field parsed and then written by no
  // SQL passes every test that only checks the redirect.
  it("writes all three fields, and redirects to the need", async () => {
    const res = await post(`/admin/need/${REVIEW}/edit/`, {
      change_text: "Rice\nTinned Fish",
      excess_change_text: "Squash\nBiscuits",
      published: "1",
    });

    expect(res.status).toBe(302);
    // views.py:1932 `redirect("admin:need", id=need.need_id)` -- the STORED
    // need_id, so a dashed URL is redirected to the canonical dashless page.
    expect(res.headers.get("location")).toBe(`/admin/need/${REVIEW}/`);

    const row = storedNeed(REVIEW)!;
    expect(row.change_text).toBe("Rice\nTinned Fish");
    expect(row.excess_change_text).toBe("Squash\nBiscuits");
    expect(row.published).toBe(1);
    expect(String(row.modified)).toMatch(PY_TIMESTAMP);
    expect(row.modified).not.toBe(SEED_MODIFIED);
  });

  // THE #34 TEST, second half, and the one the first is not safe without.
  // The UPDATE names all three columns unconditionally, so an edit that
  // changes one field only is safe exactly as long as the form round-trips
  // the other two. Nothing here mentions the excess list or the published
  // flag; both must survive an edit to the shopping list alone.
  it("preserves the fields an edit does not touch, through form and back", async () => {
    db.prepare("UPDATE foodbankchange SET published = 1 WHERE need_id = ?").run(REVIEW);
    const data = await openEditForm(REVIEW);

    const res = await post(`/admin/need/${REVIEW}/edit/`, browserWouldSubmit(data, { change_text: "Tea\nCoffee\nSugar" }));

    expect(res.status).toBe(302);
    const row = storedNeed(REVIEW)!;
    expect(row.change_text).toBe("Tea\nCoffee\nSugar");
    expect(row.excess_change_text).toBe("Pasta");
    expect(row.published).toBe(1);
    expect(row.foodbank_id).toBe(1);
  });

  it("round-trips a saved need back into the form unchanged", async () => {
    await post(`/admin/need/${REVIEW}/edit/`, { change_text: "Rice\nTinned Fish", excess_change_text: "Squash", published: "1" });

    const reopened = await openEditForm(REVIEW);

    expect(reopened.change_text).toBe("Rice\nTinned Fish");
    expect(reopened.excess_change_text).toBe("Squash");
    expect(reopened.published).toBe(true);
  });

  it("unpublishes when the checkbox comes back unticked", async () => {
    db.prepare("UPDATE foodbankchange SET published = 1 WHERE need_id = ?").run(REVIEW);
    const data = await openEditForm(REVIEW);
    const body = browserWouldSubmit(data);
    delete body.published;

    await post(`/admin/need/${REVIEW}/edit/`, body);

    expect(storedNeed(REVIEW)!.published).toBe(0);
  });

  // CharField(null=True) semantics, and not merely tidy: NULL and "" sort and
  // compare differently, and `need.excess_change_text ? ... : []` in the
  // detail handler treats both as absent only by luck of falsiness.
  it("stores NULL, not an empty string, for an emptied excess list", async () => {
    await post(`/admin/need/${REVIEW}/edit/`, { change_text: "Tea", excess_change_text: "" });

    expect(storedNeed(REVIEW)!.excess_change_text).toBeNull();
  });

  it("treats a whitespace-only excess list as cleared", async () => {
    await post(`/admin/need/${REVIEW}/edit/`, { change_text: "Tea", excess_change_text: "   \n  " });

    expect(storedNeed(REVIEW)!.excess_change_text).toBeNull();
  });

  // clean_foodbank_need_text (givefood/utils/text.py:91-115) on the way in,
  // the same as the create path and the same as Django's
  // FoodbankChange.save(). Skipping it is ticket #6: a <textarea> posts CRLF,
  // foodbankchangeline.item never contains CR, and every category suggestion
  // for the need then missed.
  it("cleans the submitted text the way the model's save() does", async () => {
    await post(`/admin/need/${REVIEW}/edit/`, {
      change_text: "  Tea &amp; Coffee\r\n\r\n   Uht  Milk  ",
      excess_change_text: "Pasta\r\n\r\nRice",
    });

    const row = storedNeed(REVIEW)!;
    // Entities decoded, blank lines dropped, each line trimmed, CR gone,
    // double spaces collapsed once, "Uht" corrected.
    expect(row.change_text).toBe("Tea & Coffee\nUHT Milk");
    expect(row.excess_change_text).toBe("Pasta\nRice");
  });

  // givefood/models/needs.py:64 -- change_text has no blank=True, so
  // NeedForm's is_valid() rejects an empty shopping list. The STATUS is the
  // deliberate part: a Django ModelForm that fails validation re-renders the
  // same bound page at 200, it does not return a 4xx, and this route follows
  // that rather than the plain `c.text(error, 400)` other ported forms use.
  it("re-renders at 200 with the error and the typed values when the list is empty", async () => {
    const res = await post(`/admin/need/${REVIEW}/edit/`, { change_text: "", excess_change_text: "Squash\nBiscuits" });

    expect(res.status).toBe(200);
    expect(lastRender().context.error).toBe("This field is required.");
    // THE POINT. Not "it was refused" but "it was refused and the admin's
    // excess list is still on the screen".
    expect(renderedNeed().excess_change_text).toBe("Squash\nBiscuits");
    expect(renderedNeed().change_text).toBe("");
    // And nothing was written.
    expect(storedNeed(REVIEW)!.change_text).toBe("Tea\nCoffee");
    expect(storedNeed(REVIEW)!.modified).toBe(SEED_MODIFIED);
  });

  it("rejects a shopping list that cleans down to nothing but whitespace", async () => {
    const res = await post(`/admin/need/${REVIEW}/edit/`, { change_text: "   \n \n  " });

    expect(res.status).toBe(200);
    expect(lastRender().context.error).toBe("This field is required.");
    expect(storedNeed(REVIEW)!.change_text).toBe("Tea\nCoffee");
  });

  // FoodbankChange.clean() (needs.py:77-79), enforced by full_clean() on this
  // path. Same message as the create half (needNew.ts:135-137).
  it("refuses to publish a food-bank-less need, keeping what was typed", async () => {
    const res = await post(`/admin/need/${ORPHAN}/edit/`, { change_text: "Beans\nRice", excess_change_text: "Tea", published: "1" });

    expect(res.status).toBe(200);
    expect(lastRender().context.error).toBe("Need to set a food bank to publish need");
    expect(renderedNeed().change_text).toBe("Beans\nRice");
    expect(renderedNeed().excess_change_text).toBe("Tea");
    expect(renderedNeed().published).toBe(true);
    expect(storedNeed(ORPHAN)!.change_text).toBe("Beans");
    expect(storedNeed(ORPHAN)!.published).toBe(0);
  });

  it("saves an unpublished food-bank-less need, since only publishing is barred", async () => {
    const res = await post(`/admin/need/${ORPHAN}/edit/`, { change_text: "Beans\nRice" });

    expect(res.status).toBe(302);
    expect(storedNeed(ORPHAN)!.change_text).toBe("Beans\nRice");
  });

  // THE FOOD BANK IS NOT EDITABLE HERE (need_form.njk:37-47). The route used
  // to read a slug back off the body; it now keeps whatever the need has and
  // trusts nothing from the form. A POST that still carries the old field
  // names must not move the need to another food bank -- which would move it
  // off one public page and onto another, silently.
  it("ignores any food bank the body tries to submit", async () => {
    const res = await post(`/admin/need/${REVIEW}/edit/`, {
      change_text: "Tea",
      foodbank: "amesbury",
      foodbank_slug: "amesbury",
      foodbank_id: "2",
    });

    expect(res.status).toBe(302);
    expect(storedNeed(REVIEW)!.foodbank_id).toBe(1);
  });

  // needs.py:305-317's `do_translate = self.published` fires on EVERY save
  // while published is true, not only the first -- the model's own comment
  // says so. This is the third and last place a need's published flag can
  // become or stay true.
  it("enqueues cy/ga/gd on every save that leaves the need published", async () => {
    await post(`/admin/need/${REVIEW}/edit/`, { change_text: "Tea", published: "1" });
    expect(jobsSendBatch).toHaveBeenCalledTimes(1);

    // Already published, saved again: still enqueues.
    await post(`/admin/need/${REVIEW}/edit/`, { change_text: "Tea\nCoffee", published: "1" });
    expect(jobsSendBatch).toHaveBeenCalledTimes(2);
    expect(jobsSendBatch.mock.calls[1]?.[0]).toEqual([
      { body: { type: "translate-need", needId: 10, language: "cy" } },
      { body: { type: "translate-need", needId: 10, language: "ga" } },
      { body: { type: "translate-need", needId: 10, language: "gd" } },
    ]);
  });

  it("enqueues nothing for a save that leaves the need unpublished", async () => {
    await post(`/admin/need/${REVIEW}/edit/`, { change_text: "Tea" });

    expect(jobsSendBatch).not.toHaveBeenCalled();
  });

  it("recomputes the food bank when a save changes which need is latest", async () => {
    db.prepare("UPDATE foodbankchange SET created = ? WHERE need_id = ?").run("2026-05-01 00:00:00.000000", REVIEW);

    await post(`/admin/need/${REVIEW}/edit/`, { change_text: "Tea", published: "1" });

    expect(storedFoodbank(1).latest_need_id).toBe(10);
    expect(storedFoodbank(1).last_need).toBe("2026-05-01 00:00:00.000000");
  });

  it("finds the need from a dashed uuid and redirects to the dashless page", async () => {
    const res = await post(`/admin/need/${dashed(REVIEW)}/edit/`, { change_text: "Rice" });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/admin/need/${REVIEW}/`);
    // Unlike publish/notify, the write here goes through need.need_id -- the
    // value read off the row -- so it lands.
    expect(storedNeed(REVIEW)!.change_text).toBe("Rice");
  });

  it("404s a POST to an unknown need", async () => {
    const res = await post(`/admin/need/${needUuid(999)}/edit/`, { change_text: "Tea" });

    expect(res.status).toBe(404);
  });

  // SUSPECT -- pinned as it behaves, reported rather than fixed.
  //
  // handlePublishTransition purges AGGREGATE_TAG plus this food bank's tag on
  // both transitions, with a comment explaining that publishing a need is the
  // most frequent reason a cached page goes stale. This route can publish or
  // unpublish the very same need, from the very same admin, and purges
  // nothing -- so ticking Published on the edit form leaves the food bank's
  // page serving the old shopping list until the next unrelated purge or the
  // TTL. It also rewrites change_text, which changes the page even when
  // `published` never moves.
  it("SUSPECT: publishing from the edit form purges no cached page", async () => {
    await post(`/admin/need/${REVIEW}/edit/`, { change_text: "Rice\nTinned Fish", published: "1" });

    expect(storedNeed(REVIEW)!.published).toBe(1);
    expect(purgeSend).not.toHaveBeenCalled();
  });
});
