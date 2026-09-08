import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminFoodbankForceCheck, adminFoodbankForceArticleCrawl, adminFoodbankForceCharityCrawl } from "./foodbankForceCrawl";
import { requireAdminAuth } from "../../middleware/adminAuth";
import { hmacSha256Hex } from "../../lib/hmac";
import type { AppEnv } from "../../types";

// The three "Force ..." buttons on admin/foodbank_detail.njk -- Force Check
// (line 155), Force Article Crawl (166) and Force Charity Crawl (91). Each is
// a one-button POST form whose entire visible outcome is a 302 back to the
// page it was pressed on, which is exactly the shape GitHub issue #34 was:
// a redirect is not evidence that anything was written.
//
// So every assertion below that expects work to have happened READS THE ROW
// BACK OUT OF SQLITE and reads the queue message that was actually sent. And
// every assertion that expects NOTHING to have happened asserts the crawlset
// table is still empty and no queue was touched -- because all three handlers
// have guarded paths that redirect identically whether they enqueued a crawl
// or silently did nothing at all. The two are indistinguishable to the admin
// pressing the button, which is what makes them worth pinning here.
//
// REAL EVERYTHING except the five queues. The router is a real Hono app
// registered at the production paths (routes/admin/index.ts:135-137), the
// auth gate is the real requireAdminAuth, the CSRF check is the real
// verifyCsrf over a real HMAC-signed __Host-csrf cookie, and
// getFoodbankBySlug / insertCrawlSet / setCrawlSetExpected are the shipped
// implementations running their real SQL against a real in-memory SQLite.
// Only Queue.send() is a fake, because that is the one thing here that leaves
// the machine.
//
// MUTATION-TESTED (TESTING.md's convention: a copy of the module, broken on
// purpose in a scratchpad outside the repo, with this file re-run against it).
// Every one of these was run, and the count is the number of tests that went
// red: routing Scotland to CHARITY_NI_Q (1), dropping setCrawlSetExpected (8),
// widening the article guard to `rss_url || news_url` (1), skipping the CSRF
// check (18), hoisting insertCrawlSet out of the charity `if (queue)` block
// (3), dropping shoppingListUrl from the render message (1), dropping the
// charity_number guard (2), defaulting an unknown country to CHARITY_EW_Q (3),
// replacing the 404 with a redirect (3), and moving setCrawlSetExpected after
// the send (2).
//
// A SECOND, ADVERSARIAL SWEEP (61 mutants) then found nine survivors, and the
// tests that kill them are named after them where they sit: transposing
// setCrawlSetExpected's two arguments on each of the three routes (invisible
// while the only crawl set's id is 1, hence the three second-press tests),
// transposing crawlSetId and foodbankId in the ArticlesMessage (invisible
// while Salisbury's foodbank id is also 1, hence Cardiff), `void`-ing the
// article and charity queue sends instead of awaiting them (hence a
// queue-failure test per route), moving setCrawlSetExpected after the send on
// the article and charity routes (the check route already had that test, the
// other two did not), spelling the charity guard `!== null` (hence the
// empty-string charity number), a non-null run_id on the charity crawl set,
// and accepting the CSRF token from the query string. Nothing else survived.
//
// Two mutants are EQUIVALENT and deliberately not chased: taking the message
// `slug` (and the redirect target) from `c.req.param("slug")` rather than from
// the row. `foodbank.slug` is looked up with a case-sensitive `=` against a
// plain TEXT column, so a request that finds a row always carries that row's
// slug byte for byte, and no test could tell the two apart.

// crawlset verbatim from migrations/0008_needcheck.sql, INDEX INCLUDED. The
// index is not decoration in this file: it is partial (`WHERE run_id IS NOT
// NULL`), and these handlers deliberately pass run_id = null so that pressing
// a button twice opens two independent crawl sets instead of colliding with
// the cron's dedup. Transcribe it as a plain UNIQUE index and the second
// click 500s -- see "a second click opens a second crawl set" below.
//
// The foodbank table is the subset of migrations/0001_core.sql:10-46 these
// handlers read (plus the columns getFoodbankBySlug's `SELECT *` maps),
// rather than all 80: an unused column here would be noise, and the ones that
// matter -- rss_url, charity_number, country, is_closed -- are the guards
// every silent no-op below turns on. latest_need_id is present but always
// NULL: nothing here reads the need. That no longer spares the fixture the
// foodbankchange table -- since github #51 getFoodbankBySlug batches that
// lookup and sends it either way -- so the table and its view are appended to
// SCHEMA below.
const SCHEMA = `
CREATE TABLE foodbank (
  id INTEGER PRIMARY KEY,
  uuid TEXT NOT NULL,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  country TEXT NOT NULL,
  url TEXT NOT NULL, shopping_list_url TEXT NOT NULL,
  rss_url TEXT, news_url TEXT,
  facebook_page TEXT,
  charity_number TEXT,
  is_closed INTEGER NOT NULL,
  latest_need_id INTEGER
);
CREATE UNIQUE INDEX foodbank_slug_uniq ON foodbank(slug);
CREATE TABLE crawlset (
  id INTEGER PRIMARY KEY,
  crawl_type TEXT NOT NULL,
  run_id TEXT,
  start TEXT NOT NULL,
  finish TEXT,
  expected INTEGER,
  remaining INTEGER
);
CREATE UNIQUE INDEX crawlset_runid_uniq ON crawlset(run_id) WHERE run_id IS NOT NULL;
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

type Bindable = null | number | bigint | string | Uint8Array;

// The D1DatabaseSession surface packages/db uses, over node:sqlite. Same shim
// as donationPoint.test.ts's with ONE addition that matters here:
// `meta.last_row_id`. insertCrawlSet returns `result.meta.last_row_id` and
// every message body below carries that id as its crawlSetId, so a shim that
// returned `meta: {}` (as the location suite's does -- it never inserts
// through a path that reads it) would hand the queue `undefined` and the
// consumer's crawlitem bookkeeping would have nothing to attach to. D1 spells
// it last_row_id; node:sqlite spells it lastInsertRowid.
function d1Session(db: DatabaseSync): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      const result = db.prepare(sql).run(...params);
      return { success: true, meta: { last_row_id: Number(result.lastInsertRowid), changes: Number(result.changes) } };
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
const SESSION_ID = "test-admin-session-id";

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

interface FoodbankFixture {
  id: number;
  name: string;
  slug: string;
  country: string;
  url: string;
  shopping_list_url: string;
  rss_url: string | null;
  news_url: string | null;
  facebook_page: string | null;
  charity_number: string | null;
  is_closed: number;
}

const SALISBURY: FoodbankFixture = {
  id: 1,
  name: "Salisbury",
  slug: "salisbury",
  country: "England",
  url: "https://salisbury.foodbank.org.uk/",
  shopping_list_url: "https://salisbury.foodbank.org.uk/give-help/donate-food/",
  rss_url: "https://salisbury.foodbank.org.uk/feed/",
  news_url: null,
  facebook_page: "salisburyfoodbank",
  charity_number: "1130190",
  is_closed: 0,
};

// News page but no feed. The template renders the Force Article Crawl button
// for `foodbank.rss_url or foodbank.news_url` (foodbank_detail.njk:163) while
// the handler acts only on rss_url -- this row is the gap between those two
// conditions, and the reason the "does nothing, silently" test exists.
const SID_VALLEY: FoodbankFixture = {
  ...SALISBURY,
  id: 2,
  name: "Sid Valley",
  slug: "sid-valley",
  url: "https://sidvalleyfoodbank.org.uk/",
  shopping_list_url: "https://sidvalleyfoodbank.org.uk/donate/",
  rss_url: null,
  news_url: "https://sidvalleyfoodbank.org.uk/news/",
  facebook_page: null,
};

const EDINBURGH: FoodbankFixture = { ...SALISBURY, id: 3, name: "Edinburgh NW", slug: "edinburgh-nw", country: "Scotland", charity_number: "SC044168" };
const BELFAST: FoodbankFixture = { ...SALISBURY, id: 4, name: "Belfast South", slug: "belfast-south", country: "Northern Ireland", charity_number: "NIC101010" };
const CARDIFF: FoodbankFixture = { ...SALISBURY, id: 5, name: "Cardiff", slug: "cardiff", country: "Wales", charity_number: "1146130" };
// A charity number in a country with no register queue. charityRegisterUrl()
// (foodbankDetail.ts:41-56) has an explicit "Isle of Man" case, so the detail
// page DOES render this row's Force Charity Crawl button.
const ISLE_OF_MAN: FoodbankFixture = { ...SALISBURY, id: 6, name: "Isle of Man", slug: "isle-of-man", country: "Isle of Man", charity_number: "1234" };
const UNREGISTERED: FoodbankFixture = { ...SALISBURY, id: 7, name: "Unregistered", slug: "unregistered", charity_number: null };
const CLOSED: FoodbankFixture = { ...SALISBURY, id: 8, name: "Closed Down", slug: "closed-down", is_closed: 1 };

const QUEUE_NAMES = ["RENDER_Q", "ARTICLES_Q", "CHARITY_EW_Q", "CHARITY_SCOTLAND_Q", "CHARITY_NI_Q"] as const;
type QueueName = (typeof QUEUE_NAMES)[number];

interface CrawlSetRow {
  id: number;
  crawl_type: string;
  run_id: string | null;
  start: string;
  finish: string | null;
  expected: number | null;
  remaining: number | null;
}

interface SentMessage {
  queue: QueueName;
  body: unknown;
  // The crawlset table as it stood at the instant send() was called. The
  // consumer can start the moment the message lands, so "expected was already
  // set" is a claim about ordering, not about the end state -- see the
  // countdown test.
  crawlSetsAtSendTime: CrawlSetRow[];
}

let db: DatabaseSync;
let sent: SentMessage[];
let queues: Record<QueueName, { send: ReturnType<typeof vi.fn> }>;
let sessions: Map<string, string>;

function crawlSets(): CrawlSetRow[] {
  return db.prepare("SELECT id, crawl_type, run_id, start, finish, expected, remaining FROM crawlset ORDER BY id").all() as never;
}

function seed(fb: FoodbankFixture): void {
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, slug, country, url, shopping_list_url, rss_url, news_url, facebook_page, charity_number, is_closed, latest_need_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    fb.id,
    `uuid-${fb.slug}`,
    fb.name,
    fb.slug,
    fb.country,
    fb.url,
    fb.shopping_list_url,
    fb.rss_url,
    fb.news_url,
    fb.facebook_page,
    fb.charity_number,
    fb.is_closed,
  );
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  for (const fb of [SALISBURY, SID_VALLEY, EDINBURGH, BELFAST, CARDIFF, ISLE_OF_MAN, UNREGISTERED, CLOSED]) seed(fb);

  sent = [];
  queues = Object.fromEntries(
    QUEUE_NAMES.map((name) => [
      name,
      { send: vi.fn(async (body: unknown) => void sent.push({ queue: name, body, crawlSetsAtSendTime: crawlSets() })) },
    ]),
  ) as Record<QueueName, { send: ReturnType<typeof vi.fn> }>;

  // getAdminSession reads the session id out of __Host-gfsession and looks it
  // up in KV; a Map is enough for both. expiresAt is a full window away so the
  // sliding-refresh put() (adminAuth.ts:287-293) never fires and cannot be
  // mistaken for one of the writes under test.
  sessions = new Map([
    [
      `admin-session:${SESSION_ID}`,
      JSON.stringify({ email: "someone@givefood.org.uk", name: "Some One", givenName: "Some", picture: "", expiresAt: Date.now() + 12 * 60 * 60 * 1000 }),
    ],
  ]);
});

function buildEnv(overrides: Partial<Record<string, unknown>> = {}): AppEnv["Bindings"] {
  return {
    DB: { withSession: () => d1Session(db) },
    SESSIONS: {
      get: async (key: string) => sessions.get(key) ?? null,
      put: async (key: string, value: string) => void sessions.set(key, value),
      delete: async (key: string) => void sessions.delete(key),
    },
    CSRF_SECRET,
    ...queues,
    ...overrides,
  } as unknown as AppEnv["Bindings"];
}

// The production registration, with one deliberate difference: `all` rather
// than `post` (routes/admin/index.ts:135-137 registers these POST-only). That
// is what lets the GET tests below reach the handler at all and assert what it
// does with a request carrying no form body -- defence in depth behind the
// router, which is the half that survives someone adding a GET registration
// later. requireAdminAuth is mounted the way adminApp mounts it: on "*",
// ahead of every route.
function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireAdminAuth);
  app.all("/admin/foodbank/:slug/needcheck/", adminFoodbankForceCheck);
  app.all("/admin/foodbank/:slug/crawl/", adminFoodbankForceArticleCrawl);
  app.all("/admin/foodbank/:slug/charity-crawl/", adminFoodbankForceCharityCrawl);
  // A throw from any of these reaches app.onError in production and renders
  // the 500 page. Labelled here so a regression reads as "expected 302, got
  // 500: <message>" rather than as a vitest crash.
  app.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));
  return app;
}

interface CallOptions {
  method?: string;
  /** The `csrf_token` form field. null omits it entirely. */
  formToken?: string | null;
  /** Full Cookie header. Defaults to a valid signed CSRF cookie + a live session. */
  cookies?: string[] | null;
  origin?: string | null;
  secFetchSite?: string | null;
  env?: AppEnv["Bindings"];
}

async function call(path: string, options: CallOptions = {}): Promise<Response> {
  const { method = "POST", formToken = CSRF_RAW } = options;
  const signature = await hmacSha256Hex(CSRF_SECRET, CSRF_RAW);
  const cookies = options.cookies === undefined ? [`__Host-csrf=${CSRF_RAW}.${signature}`, `__Host-gfsession=${SESSION_ID}`] : (options.cookies ?? []);

  const headers: Record<string, string> = {};
  if (cookies.length > 0) headers.Cookie = cookies.join("; ");
  if (options.origin !== null) headers.Origin = options.origin ?? ORIGIN;
  if (options.secFetchSite !== null) headers["Sec-Fetch-Site"] = options.secFetchSite ?? "same-origin";

  let body: string | undefined;
  if (method !== "GET") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(formToken === null ? {} : { csrf_token: formToken }).toString();
  }

  return buildApp().fetch(new Request(`${ORIGIN}${path}`, { method, headers, body }), options.env ?? buildEnv(), execCtx);
}

/** Nothing was written and nothing was enqueued -- the shape of every refusal and every silent no-op. */
function expectNothingHappened(): void {
  expect(crawlSets()).toEqual([]);
  expect(sent).toEqual([]);
}

// Django's str(datetime) -- pyDatetime's `YYYY-MM-DD HH:MM:SS.ffffff`, not
// an ISO "T". Asserted rather than assumed because `start` is half of the
// crawl-set duration the admin reads (getCrawlSetJson's time_taken) and
// because crawlset rows written by this Worker sit alongside rows written by
// every other write site: a space sorts before "T", so one route spelling it
// the other way would quietly reorder /admin/crawlsets/.
const PY_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;

describe("adminFoodbankForceCheck -- the dashboard's Force Check button", () => {
  // Ported from gfoffline's foodbank_need_check, which ran the whole check
  // INLINE and rendered need_check.html with the result. This port enqueues
  // instead and shows the admin nothing, so the crawl set and the message are
  // the only evidence the press did anything -- there is no rendered result
  // to notice the absence of.
  it("opens a one-row crawl set and enqueues the message the render consumer expects", async () => {
    const res = await call("/admin/foodbank/salisbury/needcheck/");

    expect(res.status).toBe(302);
    // Django's `redirect("admin:foodbank", slug=...)` -- gfadmin/urls/
    // foodbanks.py:13 under the "admin/" include, i.e. the detail page the
    // button was pressed on.
    expect(res.headers.get("Location")).toBe("/admin/foodbank/salisbury/");

    const sets = crawlSets();
    expect(sets).toHaveLength(1);
    const set = sets[0]!;
    expect(set.crawl_type).toBe("need");
    // NULL, not a cron-style run id: admin-triggered presses are not deduped
    // (the module comment says so, and the next test proves it).
    expect(set.run_id).toBeNull();
    expect(set.start).toMatch(PY_DATETIME);
    expect(set.finish).toBeNull();
    // Both set, by setCrawlSetExpected's `expected = ?1, remaining = ?1`.
    // remaining is what decrementCrawlSetRemaining counts down and it refuses
    // to move unless `remaining > 0`, so a crawl set left with remaining NULL
    // never gets its `finish` stamped and shows as still running for ever on
    // /admin/crawlsets/. One food bank, one message, one expected.
    expect(set.expected).toBe(1);
    expect(set.remaining).toBe(1);

    // The message the SAME jobs-Worker consumer the nightly cron feeds will
    // read (workers/jobs/src/queues/needcheckRender.ts's
    // NeedcheckRenderMessage -- duplicated by hand, per this module's own
    // "keep in sync" note, which is exactly why the shape is pinned here).
    // toEqual, not toMatchObject: an extra or renamed key is the failure.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.queue).toBe("RENDER_Q");
    expect(sent[0]!.body).toEqual({
      crawlSetId: set.id,
      foodbankId: SALISBURY.id,
      slug: "salisbury",
      name: "Salisbury",
      url: SALISBURY.url,
      shoppingListUrl: SALISBURY.shopping_list_url,
      facebookPage: "salisburyfoodbank",
    });
  });

  // The countdown has to be armed BEFORE the message can be picked up.
  // Cloudflare Queues can deliver to a consumer while this handler is still
  // running, and decrementCrawlSetRemaining's `AND remaining > 0` silently
  // matches no row when remaining is still NULL -- the consumer would return
  // null, `finish` would never be stamped, and the run would look stalled for
  // ever. Reading the table from inside send() is the only way to assert the
  // order rather than the end state.
  it("arms the countdown before the message is sent, not after", async () => {
    await call("/admin/foodbank/salisbury/needcheck/");

    const atSend = sent[0]!.crawlSetsAtSendTime;
    expect(atSend).toHaveLength(1);
    expect(atSend[0]!.expected).toBe(1);
    expect(atSend[0]!.remaining).toBe(1);
  });

  it("leaves the other four queues alone", async () => {
    await call("/admin/foodbank/salisbury/needcheck/");

    expect(queues.RENDER_Q.send).toHaveBeenCalledTimes(1);
    expect(queues.ARTICLES_Q.send).not.toHaveBeenCalled();
    expect(queues.CHARITY_EW_Q.send).not.toHaveBeenCalled();
    expect(queues.CHARITY_SCOTLAND_Q.send).not.toHaveBeenCalled();
    expect(queues.CHARITY_NI_Q.send).not.toHaveBeenCalled();
  });

  // NULL has to survive as null. The consumer branches on it
  // (scrapeTypeFor/scrapeFacebook), and "" is a truthy-looking absence in
  // some of the places a facebook page gets used -- so a shim that coerced
  // the column would change which scraper runs for a third of the estate.
  it("passes a missing Facebook page through as null", async () => {
    await call("/admin/foodbank/sid-valley/needcheck/");

    expect(sent[0]!.body).toMatchObject({ slug: "sid-valley", facebookPage: null });
  });

  // crawlset_runid_uniq is PARTIAL (`WHERE run_id IS NOT NULL`), which is the
  // whole reason these handlers can pass null: the cron's dedup must not make
  // the admin's second press of the button a 500. Two presses, two runs.
  //
  // The per-row expected/remaining assertions are here for a second reason,
  // and it is the reason this test is repeated for the other two buttons
  // below. setCrawlSetExpected(session, crawlSetId, expected) takes two
  // numbers in a row, and on a FIRST press both of them are 1 -- the new
  // crawl set's id and the count -- so transposing the arguments
  // (`setCrawlSetExpected(db, 1, crawlSetId)`) updates exactly the right row
  // by accident and every single-press assertion in this file stays green.
  // MUTANT check-swap-setCrawlSetExpected-args survived the whole suite until
  // this test read both rows: on the second press the transposed call re-arms
  // crawl set 1 with expected = 2 and leaves crawl set 2 with expected NULL,
  // and a crawl set with remaining NULL is one decrementCrawlSetRemaining
  // will never move, so it shows as running for ever on /admin/crawlsets/.
  it("opens a second, independent crawl set on a second press, and arms that one", async () => {
    await call("/admin/foodbank/salisbury/needcheck/");
    await call("/admin/foodbank/salisbury/needcheck/");

    const sets = crawlSets();
    expect(sets).toHaveLength(2);
    expect(sets.map((s) => s.crawl_type)).toEqual(["need", "need"]);
    expect(sets.map((s) => [s.run_id, s.expected, s.remaining])).toEqual([
      [null, 1, 1],
      [null, 1, 1],
    ]);
    expect(sent.map((m) => (m.body as { crawlSetId: number }).crawlSetId)).toEqual([sets[0]!.id, sets[1]!.id]);
  });

  // The nightly fan-out reads getOpenFoodbanksForNeedCheck, which is
  // `WHERE is_closed = 0`; getFoodbankBySlug has no such filter and neither
  // does this handler (nor did Django's view). A closed food bank is still
  // checkable by hand, which is what an admin re-opening one would want.
  it("still fires for a closed food bank, which the nightly cron skips", async () => {
    const res = await call("/admin/foodbank/closed-down/needcheck/");

    expect(res.status).toBe(302);
    expect(crawlSets()).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("404s an unknown slug without opening a crawl set", async () => {
    const res = await call("/admin/foodbank/not-a-food-bank/needcheck/");

    expect(res.status).toBe(404);
    expectNothingHappened();
  });

  // SUSPECT, pinned as-is. The crawl set is inserted and armed BEFORE the
  // send, and nothing rolls it back: a queue failure leaves a row with
  // remaining = 1 that no consumer will ever decrement, so it sits on
  // /admin/crawlsets/ as a run that started and never finished. The admin
  // sees the 500 and can press the button again, so no work is lost -- but
  // the orphan is indistinguishable from a genuinely stalled crawl, which is
  // the signal that page exists to give. Reported, not fixed.
  it("leaves an un-finishable crawl set behind when the queue send fails", async () => {
    queues.RENDER_Q.send.mockImplementationOnce(async () => {
      throw new Error("queue unavailable");
    });

    const res = await call("/admin/foodbank/salisbury/needcheck/");

    expect(res.status).toBe(500);
    expect(crawlSets()).toHaveLength(1);
    expect(crawlSets()[0]!.remaining).toBe(1);
    expect(crawlSets()[0]!.finish).toBeNull();
  });
});

describe("adminFoodbankForceArticleCrawl -- gfadmin/views.py:1242-1247 foodbank_crawl", () => {
  it("opens an article crawl set and enqueues the three-field message", async () => {
    const res = await call("/admin/foodbank/salisbury/crawl/");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/foodbank/salisbury/");

    const sets = crawlSets();
    expect(sets).toHaveLength(1);
    expect(sets[0]!.crawl_type).toBe("article");
    expect(sets[0]!.run_id).toBeNull();
    expect(sets[0]!.expected).toBe(1);
    expect(sets[0]!.remaining).toBe(1);

    // workers/jobs/src/queues/articles.ts's ArticlesMessage: exactly three
    // fields, because the consumer re-reads the food bank by id rather than
    // trusting the enqueue-time snapshot.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.queue).toBe("ARTICLES_Q");
    expect(sent[0]!.body).toEqual({ crawlSetId: sets[0]!.id, foodbankId: SALISBURY.id, slug: "salisbury" });

    // The same ordering claim the Force Check suite makes in its own test, and
    // it has to be made per route because each of the three arms its countdown
    // in its own two lines: the consumer can pick this message up immediately,
    // and decrementCrawlSetRemaining's `AND remaining > 0` matches nothing
    // while remaining is still NULL. MUTANT article-expected-after-send (the
    // two lines transposed) survived until this assertion existed.
    expect(sent[0]!.crawlSetsAtSendTime.map((s) => [s.expected, s.remaining])).toEqual([[1, 1]]);
  });

  // As the Force Check suite's second-press test, and for the same mutant:
  // both arguments to setCrawlSetExpected are 1 on a first press, so a
  // transposition is invisible until a second crawl set exists. MUTANT
  // article-swap-setCrawlSetExpected-args survived until this test. It also
  // kills article-run-id-no-longer-null -- a non-null run_id would make the
  // second press collide on crawlset_runid_uniq and 500 rather than open a
  // second run, which is precisely what the partial index exists to avoid.
  it("opens a second, independent crawl set on a second press, and arms that one", async () => {
    await call("/admin/foodbank/salisbury/crawl/");
    await call("/admin/foodbank/salisbury/crawl/");

    const sets = crawlSets();
    expect(sets).toHaveLength(2);
    expect(sets.map((s) => [s.crawl_type, s.run_id, s.expected, s.remaining])).toEqual([
      ["article", null, 1, 1],
      ["article", null, 1, 1],
    ]);
    expect(sent.map((m) => (m.body as { crawlSetId: number }).crawlSetId)).toEqual([sets[0]!.id, sets[1]!.id]);
  });

  // THE #34 SHAPE AT FIELD LEVEL. crawlSetId and foodbankId are two numbers
  // side by side in one object literal, and the Salisbury fixture cannot tell
  // them apart: its foodbank id is 1 and the first crawl set of a fresh
  // database is also id 1. MUTANT article-swap-crawlSetId-and-foodbankId --
  // `{ crawlSetId: foodbank.id, foodbankId: crawlSetId }` -- survived every
  // other assertion in this file for exactly that reason. Cardiff (id 5) is
  // pressed here instead, so the two numbers differ; a transposition would
  // send the consumer off to re-read food bank 1 and file its crawl item
  // against crawl set 5, which does not exist, and the article crawl would
  // silently do the wrong food bank.
  it("puts the crawl set's id and the food bank's id in the fields they belong in", async () => {
    await call("/admin/foodbank/cardiff/crawl/");

    const sets = crawlSets();
    expect(sets).toHaveLength(1);
    // The guard on the guard: if a schema change ever made these two equal,
    // the test below would silently stop proving anything.
    expect(sets[0]!.id).not.toBe(CARDIFF.id);
    expect(sent[0]!.body).toEqual({ crawlSetId: sets[0]!.id, foodbankId: CARDIFF.id, slug: "cardiff" });
  });

  // SUSPECT, pinned as-is, and the same orphan the Force Check suite pins:
  // the crawl set is opened and armed before the send, nothing rolls it back,
  // so a queue failure leaves a run that no consumer will ever finish.
  // Pinning it per route is not duplication -- this is the assertion that
  // proves the send is AWAITED. MUTANT article-send-not-awaited (`void
  // c.env.ARTICLES_Q.send(...)`) returns a cheerful 302 here instead of a
  // 500, and in the real runtime a send that is not awaited can be cancelled
  // when the response returns, i.e. a crawl the admin was told had started
  // and that never did.
  it("leaves an un-finishable crawl set behind when the queue send fails", async () => {
    queues.ARTICLES_Q.send.mockImplementationOnce(async () => {
      throw new Error("queue unavailable");
    });

    const res = await call("/admin/foodbank/salisbury/crawl/");

    expect(res.status).toBe(500);
    expect(crawlSets()).toHaveLength(1);
    expect(crawlSets()[0]!.remaining).toBe(1);
    expect(crawlSets()[0]!.finish).toBeNull();
  });

  // THE SILENT NO-OP, and the one most likely to be pressed. The button is
  // rendered whenever `foodbank.rss_url or foodbank.news_url`
  // (foodbank_detail.njk:163, and Django's own foodbank.html:274 does the
  // same), but both this handler and Django's view act only `if
  // foodbank.rss_url`. A food bank with a news page and no feed therefore
  // shows the admin a Force Article Crawl button that opens no crawl set,
  // sends no message, and redirects exactly as a successful press does.
  // Faithful to Django, so pinned rather than "fixed" -- but it is the #34
  // shape (a redirect that means nothing happened) and is reported as such.
  it("does nothing, and says nothing, for a food bank with a news page but no feed", async () => {
    const res = await call("/admin/foodbank/sid-valley/crawl/");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/foodbank/sid-valley/");
    expectNothingHappened();
  });

  // Same guard, reached through the other spelling of "no feed". The column
  // is nullable and the admin form writes "" for an emptied box on some
  // forms, so both falsy shapes have to no-op identically -- an empty-string
  // rss_url that got past the guard would enqueue a crawl of "".
  it("treats an empty-string feed URL as no feed", async () => {
    db.prepare("UPDATE foodbank SET rss_url = '' WHERE slug = ?").run("salisbury");

    const res = await call("/admin/foodbank/salisbury/crawl/");

    expect(res.status).toBe(302);
    expectNothingHappened();
  });

  it("404s an unknown slug without opening a crawl set", async () => {
    const res = await call("/admin/foodbank/not-a-food-bank/crawl/");

    expect(res.status).toBe(404);
    expectNothingHappened();
  });
});

describe("adminFoodbankForceCharityCrawl -- gfadmin/views.py:1250-1257 foodbank_charity_crawl", () => {
  // The country -> regulator split, which is the whole content of this
  // handler. It reproduces scheduled/index.ts's charityInfo() fan-out
  // (England+Wales -> EW, Scotland -> Scotland, Northern Ireland -> NI) and
  // Django's own crawlers.py:92-101 branch. Each case asserts the OTHER
  // queues stayed empty, because a mis-routed message does not fail: the
  // wrong regulator's API simply returns nothing for the number, the crawl
  // item closes cleanly, and the food bank's charity data silently stops
  // updating.
  const ROUTING: Array<[FoodbankFixture, QueueName]> = [
    [SALISBURY, "CHARITY_EW_Q"],
    [CARDIFF, "CHARITY_EW_Q"],
    [EDINBURGH, "CHARITY_SCOTLAND_Q"],
    [BELFAST, "CHARITY_NI_Q"],
  ];

  for (const [fb, expectedQueue] of ROUTING) {
    it(`sends ${fb.country} to ${expectedQueue}, and to nothing else`, async () => {
      const res = await call(`/admin/foodbank/${fb.slug}/charity-crawl/`);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(`/admin/foodbank/${fb.slug}/`);

      const sets = crawlSets();
      expect(sets).toHaveLength(1);
      expect(sets[0]!.crawl_type).toBe("charity");
      expect(sets[0]!.expected).toBe(1);
      expect(sets[0]!.remaining).toBe(1);
      // Null like the other two buttons' crawl sets, and asserted here rather
      // than assumed: MUTANT charity-run-id-no-longer-null passed every other
      // charity assertion in this file, and a non-null run_id turns the second
      // press of this button into a crawlset_runid_uniq violation -- a 500 on
      // the admin's second click.
      expect(sets[0]!.run_id).toBeNull();

      // workers/jobs/src/queues/charity.ts's CharityMessage.
      expect(sent).toHaveLength(1);
      expect(sent[0]!.queue).toBe(expectedQueue);
      expect(sent[0]!.body).toEqual({ crawlSetId: sets[0]!.id, foodbankId: fb.id, slug: fb.slug });

      // Armed before the send, per route -- MUTANT charity-expected-after-send
      // (the two lines transposed) survived until this assertion existed. See
      // the Force Check suite's own ordering test for why the countdown has to
      // be in place before the consumer can pick the message up.
      expect(sent[0]!.crawlSetsAtSendTime.map((s) => [s.expected, s.remaining])).toEqual([[1, 1]]);

      for (const name of QUEUE_NAMES) {
        if (name !== expectedQueue) expect(queues[name].send).not.toHaveBeenCalled();
      }
    });
  }

  // The third copy of the second-press test, for the third pair of
  // transposable arguments. MUTANT charity-swap-setCrawlSetExpected-args
  // survived the suite until this test read both rows: with the arguments
  // swapped the second press re-arms crawl set 1 with expected = 2 and leaves
  // crawl set 2 with expected NULL, so the charity crawl the admin just
  // triggered never reaches finish and sits on /admin/crawlsets/ as a stalled
  // run. Edinburgh (id 3) rather than Salisbury, so that the message ids
  // cannot coincide with the food bank id either.
  it("opens a second, independent crawl set on a second press, and arms that one", async () => {
    await call("/admin/foodbank/edinburgh-nw/charity-crawl/");
    await call("/admin/foodbank/edinburgh-nw/charity-crawl/");

    const sets = crawlSets();
    expect(sets).toHaveLength(2);
    expect(sets.map((s) => [s.crawl_type, s.run_id, s.expected, s.remaining])).toEqual([
      ["charity", null, 1, 1],
      ["charity", null, 1, 1],
    ]);
    expect(sent.map((m) => m.body)).toEqual([
      { crawlSetId: sets[0]!.id, foodbankId: EDINBURGH.id, slug: "edinburgh-nw" },
      { crawlSetId: sets[1]!.id, foodbankId: EDINBURGH.id, slug: "edinburgh-nw" },
    ]);
  });

  it("does nothing for a food bank with no charity number", async () => {
    const res = await call("/admin/foodbank/unregistered/charity-crawl/");

    expect(res.status).toBe(302);
    expectNothingHappened();
  });

  // The other falsy spelling of "no charity number", exactly as the article
  // suite pins the empty-string feed URL: the column is nullable AND the admin
  // form writes "" for an emptied box, so both shapes have to no-op. MUTANT
  // charity-guard-nullish-not-truthy (`if (foodbank.charity_number !== null)`)
  // survived until this test, and it is not a hypothetical distinction --
  // it would open a charity crawl set and ask the Charity Commission API for
  // charity number "", burning a crawl and filing a discrepancy against a
  // food bank that simply has not been given a number yet.
  it("treats an empty-string charity number as no charity number", async () => {
    db.prepare("UPDATE foodbank SET charity_number = '' WHERE slug = ?").run("salisbury");

    const res = await call("/admin/foodbank/salisbury/charity-crawl/");

    expect(res.status).toBe(302);
    expectNothingHappened();
  });

  // Per-route proof that the send is AWAITED, and the same orphaned crawl set
  // the other two suites pin. MUTANT charity-send-not-awaited (`void
  // queue.send(...)`) answers 302 here instead of 500; in the real runtime an
  // un-awaited send can be cancelled the moment the response returns, so the
  // admin would be redirected back to a page reporting a charity crawl that
  // was never enqueued.
  it("leaves an un-finishable crawl set behind when the queue send fails", async () => {
    queues.CHARITY_EW_Q.send.mockImplementationOnce(async () => {
      throw new Error("queue unavailable");
    });

    const res = await call("/admin/foodbank/salisbury/charity-crawl/");

    expect(res.status).toBe(500);
    expect(crawlSets()).toHaveLength(1);
    expect(crawlSets()[0]!.remaining).toBe(1);
    expect(crawlSets()[0]!.finish).toBeNull();
  });

  // THE OTHER SILENT NO-OP, and this one is reachable from the UI:
  // charityRegisterUrl() (foodbankDetail.ts:41-56) has an explicit
  // "Isle of Man" case, so the detail page renders the Force Charity Crawl
  // button inside that block -- and pressing it opens no crawl set, sends no
  // message, and redirects like a success. Django did the same thing
  // (crawlers.py:100-101 `else: return False`), so this is ported behaviour,
  // not a port bug; the handler's own comment says it would rather no-op than
  // guess a queue. Pinned so that "no queue" stays a deliberate silence and
  // not, say, a default to England.
  it("silently no-ops for a country with no register queue, even with a charity number", async () => {
    const res = await call("/admin/foodbank/isle-of-man/charity-crawl/");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/foodbank/isle-of-man/");
    expectNothingHappened();
  });

  // NO CRAWL SET WITHOUT A MESSAGE. The insert sits INSIDE the `if (queue)`
  // block, which is what keeps the two no-ops above from littering
  // /admin/crawlsets/ with `charity` runs stuck at remaining = 1 for ever.
  // Hoisting insertCrawlSet out of that block -- an easy tidy-up -- is
  // exactly the mutant this kills.
  it("never opens a crawl set it has no queue to feed", async () => {
    await call("/admin/foodbank/isle-of-man/charity-crawl/");
    await call("/admin/foodbank/unregistered/charity-crawl/");

    expect(crawlSets()).toEqual([]);
  });

  // Byte-exact country matching, like Django's `country in ["England",
  // "Wales"]`. The column is written from geocoding, so a lower-cased value
  // is a data problem rather than a legal alternative spelling -- and the
  // silent outcome is what makes it worth pinning: "england" gets a redirect
  // and no crawl, indistinguishable from a successful press.
  it("matches the country byte-for-byte", async () => {
    db.prepare("UPDATE foodbank SET country = 'england' WHERE slug = ?").run("salisbury");

    const res = await call("/admin/foodbank/salisbury/charity-crawl/");

    expect(res.status).toBe(302);
    expectNothingHappened();
  });

  it("404s an unknown slug without opening a crawl set", async () => {
    const res = await call("/admin/foodbank/not-a-food-bank/charity-crawl/");

    expect(res.status).toBe(404);
    expectNothingHappened();
  });
});

// PLAN.md §6.9 R3: Django's CsrfViewMiddleware is commented out in production,
// so these three forms' tokens were decorative there and are load-bearing
// here. All three handlers call verifyPostCsrf FIRST -- before the food bank
// is even looked up -- so every refusal below must also leave the database
// untouched, which is the assertion that distinguishes "refused" from
// "refused after doing the work".
const ROUTES: Array<[string, string]> = [
  ["Force Check", "/admin/foodbank/salisbury/needcheck/"],
  ["Force Article Crawl", "/admin/foodbank/salisbury/crawl/"],
  ["Force Charity Crawl", "/admin/foodbank/salisbury/charity-crawl/"],
];

describe("CSRF", () => {
  for (const [label, path] of ROUTES) {
    describe(label, () => {
      // The control. Without it every 403 below could be passing for the
      // wrong reason -- a mis-signed fixture cookie would make the whole
      // block green while proving nothing.
      it("accepts the token the form was rendered with", async () => {
        const res = await call(path);

        expect(res.status).toBe(302);
        expect(crawlSets()).toHaveLength(1);
      });

      it("refuses a POST with no token", async () => {
        const res = await call(path, { formToken: null });

        expect(res.status).toBe(403);
        expect(await res.text()).toBe("Forbidden");
        expectNothingHappened();
      });

      // A token of the right shape but not the one in the cookie -- the
      // double-submit half of the check.
      it("refuses a token that does not match the cookie", async () => {
        const res = await call(path, { formToken: "c".repeat(64) });

        expect(res.status).toBe(403);
        expectNothingHappened();
      });

      // THE TOKEN COMES FROM THE FORM BODY, NOWHERE ELSE. verifyPostCsrf reads
      // `body.csrf_token` and nothing falls back to the query string, which is
      // load-bearing rather than incidental: a token in a URL is copied into
      // browser history, Referer headers, the Cloudflare request log and every
      // "share this admin page" paste, and the redirect these handlers answer
      // with would carry it no further only by luck. MUTANT
      // csrf-token-also-accepted-from-query-string (`? body.csrf_token :
      // c.req.query("csrf_token")`) is a one-line "be helpful" edit that the
      // whole CSRF block above missed, because every test in it supplies the
      // token the intended way or not at all.
      it("ignores a real token supplied in the query string instead of the form", async () => {
        const res = await call(`${path}?csrf_token=${CSRF_RAW}`, { formToken: null });

        expect(res.status).toBe(403);
        expectNothingHappened();
      });

      it("refuses a request with no CSRF cookie at all", async () => {
        const res = await call(path, { cookies: [`__Host-gfsession=${SESSION_ID}`] });

        expect(res.status).toBe(403);
        expectNothingHappened();
      });

      // The cross-site press this whole mechanism exists for: a form on
      // another origin can carry a stolen token, but not a same-origin
      // Origin header.
      it("refuses a cross-origin submission", async () => {
        const res = await call(path, { origin: "https://evil.example/", secFetchSite: "cross-site" });

        expect(res.status).toBe(403);
        expectNothingHappened();
      });

      // verifyCsrf fails closed on a missing secret (its own comment: an
      // unset secret must never be indistinguishable from "working"). Worth
      // one route's worth of proof that the failure is a refusal and not an
      // exception that would reach the 500 page.
      it("refuses everything when CSRF_SECRET is unset", async () => {
        const res = await call(path, { env: buildEnv({ CSRF_SECRET: undefined }) });

        expect(res.status).toBe(403);
        expectNothingHappened();
      });
    });
  }
});

describe("auth", () => {
  for (const [label, path] of ROUTES) {
    // requireAdminAuth redirects rather than 403s, and it redirects with a
    // 302 -- the SAME status a successful press returns. Only the Location
    // tells the two apart, so both are asserted: a regression that let an
    // anonymous POST through would otherwise look identical to a success in
    // a status-only test.
    it(`sends an unauthenticated ${label} to sign-in without reaching the handler`, async () => {
      const res = await call(path, { cookies: [`__Host-csrf=${CSRF_RAW}.${await hmacSha256Hex(CSRF_SECRET, CSRF_RAW)}`] });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(`/auth/?next=${encodeURIComponent(path)}`);
      expectNothingHappened();
    });

    // A cookie whose session KV entry is gone -- an expired or signed-out
    // admin, which is the common case rather than the exotic one. Reaching
    // the handler here would mean a stale cookie was as good as a session.
    it(`sends a ${label} with a revoked session to sign-in`, async () => {
      sessions.clear();

      const res = await call(path);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(`/auth/?next=${encodeURIComponent(path)}`);
      expectNothingHappened();
    });
  }
});

describe("GET", () => {
  // Django guards two of these three with @require_POST and the port
  // registers all three POST-only, so a GET normally never gets this far.
  // These assert the handler itself is safe when it does: parseBody returns
  // {} for a request with no form content type, the token is therefore
  // missing, and the request is refused before getFoodbankBySlug is even
  // called. A crawl triggered by a prefetch, a link, or a crawler following
  // the URL out of a log would be a real (if minor) way to burn a needcheck
  // budget; this is the assertion that says it cannot happen.
  for (const [label, path] of ROUTES) {
    it(`refuses a GET to ${label} and writes nothing`, async () => {
      const res = await call(path, { method: "GET" });

      expect(res.status).toBe(403);
      expectNothingHappened();
    });

    // The GET that a token in a URL would make dangerous, and the reason the
    // query-string test above is in the CSRF block too. A signed-in admin's
    // browser prefetching this link, or anything replaying a URL out of a log,
    // would trigger a real crawl if the handler ever accepted the token from
    // anywhere but the form body -- the request carries the admin's own
    // session and CSRF cookies, so nothing else stands in the way. Kills
    // csrf-token-also-accepted-from-query-string on the GET path, where
    // MUTANT csrf-skipped-on-GET's cousin would otherwise hide.
    it(`refuses a GET to ${label} even when the URL carries the real token`, async () => {
      const res = await call(`${path}?csrf_token=${CSRF_RAW}`, { method: "GET" });

      expect(res.status).toBe(403);
      expectNothingHappened();
    });
  }
});
