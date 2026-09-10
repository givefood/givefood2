import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../types";
import { adminApp } from "./index";

// /admin/jobs/ -- "all the jobs that are running", the one page in the port
// with NO Django ancestor (jobs.ts:16-29 explains why: gfadmin read
// django-tasks' DBTaskResult history table, which Cloudflare Queues has no
// equivalent of). It is assembled from three sources that cannot see each
// other -- crawlset in D1, admin_job in D1, and the queue backlog from
// Cloudflare's own API -- and every one of them is a place where a wrong
// answer looks exactly like a right one.
//
// THIS PAGE IS READ-ONLY, WHICH DOES NOT MAKE IT SAFE. Issue #34's shape
// (a value parsed, threaded through the handler, then used by nothing, with
// a response that looks like success) has several read-side twins here, and
// they are worse than a bad table because the page's whole job is to be
// BELIEVED:
//
//   * "Crawls Running" counts crawl sets with finish IS NULL. A query that
//     dropped that predicate reports the whole history as in flight; one
//     that inverted it reports an idle site during a sweep. Both render.
//   * Each cron row is paired with the last run OF ITS OWN crawl type
//     through a Map. Hand every row the same last run, or the wrong type's,
//     and the table still fills in -- with times that are plausible because
//     they are real, just not this job's.
//   * "Queued Messages" and "Dead Letter" must go NULL, not zero, when the
//     depths could not be fetched (jobs.ts:85-89). A zero here is a lie
//     that says a dead letter queue is empty, and the DLQ panel is the only
//     sighting of a DLQ anywhere in this port.
//   * The 24-hour window is a string comparison against Django-format
//     timestamps. A window that matched everything, or nothing, is a number
//     on a dashboard either way.
//
// So the tests below seed rows that MUST BE EXCLUDED -- a finished crawl
// set, an older run of the same crawl type, a crawl type with no cron, an
// admin job past the limit, a job finished 24h + 1s ago -- because a filter
// that does nothing passes every test written only from rows it is meant to
// show.
//
// REAL ROUTER, REAL AUTH, REAL TEMPLATES, REAL SQLITE, same harness as
// crawlSets.test.ts: `adminApp` is mounted at /admin exactly as
// workers/site/src/index.ts mounts it, so requests go through the real route
// registration and the real requireAdminAuth. D1 is node:sqlite behind the
// Sessions surface, SESSIONS is a Map, and the ONLY thing mocked is global
// fetch -- the one thing that leaves the machine (api.cloudflare.com). The
// real getQueueBacklog runs against it, because its null-vs-zero contract is
// half of what this page's stats mean.
//
// Assertions are on the RENDERED HTML rather than the render() context,
// because half of what silently breaks here lives in the template: jobs.njk
// prints a dash for a null count and a number for a zero, hides the Done
// cell when `done` is null, reds a non-empty DLQ, and prints "not recorded"
// for a cron that writes no crawl set. A context-level assertion cannot tell
// a dash from a nought.
//
// MUTATION-TESTED (TESTING.md's convention: the evidence a test is
// load-bearing rather than decoration). Thirty-eight mutants were injected by
// editing the real sources in a working copy -- jobs.ts, packages/db's
// crawlSets/adminJobs/foodbankTabs, lib/queueBacklog, lib/adminAuth,
// routes/admin/index.ts and admin/jobs.njk -- running this file, and reverting.
// A sample of what died, and where:
//   * getRunningCrawlSets without its `finish IS NULL`      -> 3 failures
//   * getRunningCrawlSets ordered ASC                       -> 1
//   * getCrawlTypeLastRuns without its correlated MAX(start)-> 1
//   * getRecentAdminJobs ignoring its LIMIT                 -> 1
//   * getRecentAdminJobs ordered by `created` alone         -> 2
//   * getAdminJobCounts ignoring the 24h window             -> 37
//   * `since` built with toISOString() instead of pyDatetime-> 1
//   * last_finish dropped from the cron row (issue #34)     -> 1
//   * last_start/last_finish swapped                        -> 5
//   * last_set_id dropped (Scheduled loses its links)       -> 2
//   * queued_messages/dlq_messages swapped                  -> 3
//   * the DLQ reduce losing its `is_dlq` filter             -> 2
//   * `haveDepths` forced true, and `some` -> `every`       -> 2, 1
//   * crawlTypeIcon returning "" / always the default       -> 3, 2
//   * the queue ordering reversed, is_dlq forced false      -> 2, 3
//   * queueBacklog's credential guard deleted               -> 1
//   * /jobs/ registered with .all(), and registered ABOVE
//     requireAdminAuth (Hono runs the handler first)        -> 1, 2
//
// FIVE SURVIVORS WERE FOUND AND ARE NOW CLOSED, each named on the test that
// kills it: `c.html` -> `c.text`; the Done and Remaining cell guards widened
// from `!= null` to truthiness; the DLQ red widened to every busy queue; and
// getAdminSession accepting a cookie with no KV session behind it. Four of
// the five are ZERO-VERSUS-NULL or ALARM-VERSUS-NOISE bugs -- the same two
// families this file's own preamble calls the page's most load-bearing
// contract, which the tiles were tested for and the table cells were not.
//
// Two mutants cannot be reached by editing a module at all -- CRON_JOBS'
// schedules drifting from wrangler.jsonc, and `section` changed -- and are
// each named on the test that kills them.
//
// NOTE FOR ANYONE REPEATING THIS: admin/jobs.njk is PRECOMPILED into
// packages/templates/src/generated/precompiled.js. Editing the .njk alone
// changes nothing at test time, and every template mutant will look like a
// survivor; `pnpm --filter @givefood/templates precompile` has to run in
// between.

// Reduced from migrations/0008_needcheck.sql (crawlset) and
// 0013_admin_jobs.sql (admin_job) -- the two tables this page's four
// statements name, and nothing else, following the convention of the other
// workers/site suites rather than packages/db's shared migration loader.
// crawlset_running_idx (0023) is deliberately NOT transcribed: it is a
// partial index over the exact predicate getRunningCrawlSets uses, so it
// changes the plan and not the answer, and a fixture that needed it to be
// correct would be testing the planner.
const SCHEMA = `
CREATE TABLE crawlset (
  id INTEGER PRIMARY KEY, crawl_type TEXT NOT NULL, run_id TEXT,
  start TEXT NOT NULL, finish TEXT, expected INTEGER, remaining INTEGER
);
CREATE TABLE admin_job (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT, status TEXT NOT NULL,
  result TEXT, error TEXT, created TEXT NOT NULL, finished TEXT
);
CREATE INDEX admin_job_created_idx ON admin_job(created DESC);

-- NOT THIS PAGE'S TABLES. Every row on /admin/jobs/ that names a crawl set
-- links to /admin/crawl-set/<id>/, and the only way to prove that link lands
-- on a real page is to follow it through the same router -- which puts
-- adminCrawlSetDetail's own three tables in the fixture. They are never read
-- or written by adminJobsList; from its point of view they are not here.
CREATE TABLE crawlitem (
  id INTEGER PRIMARY KEY, crawl_set_id INTEGER, crawl_type TEXT NOT NULL,
  start TEXT NOT NULL, finish TEXT, foodbank_id INTEGER NOT NULL,
  url TEXT, need_id INTEGER
);
CREATE TABLE foodbank (id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL);
CREATE TABLE foodbankchange (
  id INTEGER PRIMARY KEY, need_id TEXT NOT NULL, foodbank_id INTEGER NOT NULL,
  nonpertinent INTEGER, published INTEGER
);
`;

type Bindable = null | number | bigint | string | Uint8Array;

// The D1DatabaseSession surface packages/db uses, over node:sqlite, with a
// `log` of every statement prepared -- the log is how "a GET never writes"
// is a claim about the SQL ISSUED and not only about the rows left behind.
// An UPDATE that happened to match no fixture row leaves the snapshot
// identical and is still a mutation against production data.
function d1Session(db: DatabaseSync, log: string[]): D1DatabaseSession {
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
    prepare: (sql: string) => {
      log.push(sql);
      return statement(sql, []);
    },
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

const ORIGIN = "https://www.givefood.org.uk";
const SESSION_ID = "test-session-id";
const ADMIN_EMAIL = "someone@givefood.org.uk";
const ACCOUNT = "acct-1";
const KEY = "cf-token";
const QUEUES_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/queues`;
const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

// A FIXED CLOCK, because two of this page's numbers are differences against
// `now`: running_for (Date.now() - crawlset.start) and the 24-hour window
// (pyDatetime(now - 86_400_000)). Neither is injectable at the route -- the
// handler reads Date.now() itself -- so the clock is faked instead, and
// every seeded timestamp below is written relative to this instant.
// vitest's fake timers do not touch performance.now(), which is what
// adminPageContext's "Rendered in N ms" uses, so the page still renders.
const NOW = Date.parse("2026-09-06T12:00:00.000Z");
/** pyDatetime(NOW - 24h) -- the exact `since` the handler binds. */
const SINCE = "2026-09-05 12:00:00.000000";

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let sessionStore: Map<string, string>;
/** Every URL global fetch was called with, in order. Empty means the page made no outbound call. */
let outbound: string[];

type Reply = (init: RequestInit) => Promise<Response>;

// A REAL Response, not an object literal with a hand-computed `ok`:
// getQueueBacklog's whole guard is `if (!res.ok)`, and a stub that decides
// for itself which statuses are ok asserts the test's opinion of HTTP.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Answers only the two endpoints queueBacklog.ts documents and throws on
// anything else, so a third outbound call added to a page render fails
// loudly here rather than in production.
function stubFetch(replies: { queues?: Reply; graphql?: Reply }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
      outbound.push(url);
      if (url === QUEUES_URL && replies.queues) return replies.queues(init);
      if (url === GRAPHQL_URL && replies.graphql) return replies.graphql(init);
      throw new Error(`unmodelled fetch: ${url}`);
    }),
  );
}

/** The Queues REST list, `success` envelope included. */
function queueList(...pairs: [id: string, name: string][]) {
  return { success: true, result: pairs.map(([queue_id, queue_name]) => ({ queue_id, queue_name })) };
}

/** queueBacklogAdaptiveGroups, nested exactly as deeply as the real response. */
function backlog(...samples: [id: string, messages: number, minute: string][]) {
  return {
    data: {
      viewer: {
        accounts: [
          {
            queueBacklogAdaptiveGroups: samples.map(([queueId, messages, datetimeMinute]) => ({
              avg: { messages },
              dimensions: { queueId, datetimeMinute },
            })),
          },
        ],
      },
    },
  };
}

/** One live queue, empty, sampled a minute ago -- the boring production shape. */
function stubHealthyQueues(): void {
  stubFetch({
    queues: async () => jsonResponse(queueList(["q1", "givefood2-purge"])),
    graphql: async () => jsonResponse(backlog(["q1", 0, "2026-09-06T11:59:00Z"])),
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  outbound = [];
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  // The shape lib/adminAuth.ts's getAdminSession reads back out of KV.
  // expiresAt a full TTL ahead so the sliding-refresh branch (past the
  // halfway point) does not fire and put() noise into these tests.
  sessionStore = new Map([
    [
      `admin-session:${SESSION_ID}`,
      JSON.stringify({ email: ADMIN_EMAIL, name: "Some One", givenName: "Some", picture: "", expiresAt: Date.now() + 12 * 60 * 60 * 1000 }),
    ],
  ]);
  stubHealthyQueues();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function buildEnv(log: string[], creds: boolean): AppEnv["Bindings"] {
  return {
    DB: { withSession: () => d1Session(db, log) },
    SESSIONS: {
      get: async (key: string) => sessionStore.get(key) ?? null,
      put: async (key: string, value: string) => void sessionStore.set(key, value),
      delete: async (key: string) => void sessionStore.delete(key),
    },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    GMAP_STATIC_KEY: "",
    GMAP_GEOCODE_KEY: "",
    // Both or neither: getQueueBacklog degrades on either being unset, and
    // `creds: false` is the state this Worker was actually deployed in
    // before CF_API_KEY was set as a secret.
    ...(creds ? { CF_ACCOUNT_ID: ACCOUNT, CF_API_KEY: KEY } : {}),
  } as unknown as AppEnv["Bindings"];
}

interface Fetched {
  res: Response;
  html: string;
  /** Every SQL statement the request prepared, in order. Empty means the handler never ran. */
  sql: string[];
}

// A real Hono app with adminApp mounted at the production prefix. onError is
// caught and labelled rather than left to become an unhandled rejection, so
// a regression reads as "expected 200, got 500: <message>".
function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // index.ts sets this globally (middleware/serverTiming.ts); adminPageContext
  // reads it for the footer's "Rendered in N ms", and without it every page
  // would say "NaN ms" -- true of the real app too.
  app.use("*", async (c, next) => {
    c.set("requestStartTime", performance.now());
    await next();
  });
  app.route("/admin", adminApp);
  app.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));
  return app;
}

async function request(path: string, opts: { signedIn?: boolean; creds?: boolean; method?: string; sessionId?: string } = {}): Promise<Fetched> {
  const sql: string[] = [];
  const headers: Record<string, string> = {};
  // `sessionId` is how the REVOKED-session case is reached: a cookie that is
  // present and well-formed but names a KV key that is no longer there.
  // `signedIn: false` only exercises the no-cookie branch, which is a
  // different early return inside getAdminSession.
  if (opts.signedIn !== false) headers.Cookie = `__Host-gfsession=${opts.sessionId ?? SESSION_ID}`;
  const res = await buildApp().fetch(
    new Request(`${ORIGIN}${path}`, { headers, method: opts.method ?? "GET" }),
    buildEnv(sql, opts.creds !== false),
    execCtx,
  );
  // Read the body once, here: several assertions want it and a Response body
  // can only be consumed once.
  const html = res.status === 302 ? "" : await res.text();
  return { res, html, sql };
}

/** GET /admin/jobs/ as a signed-in admin, unless told otherwise. */
function getJobs(opts: { signedIn?: boolean; creds?: boolean; sessionId?: string } = {}): Promise<Fetched> {
  return request("/admin/jobs/", opts);
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

// EVERY TIMESTAMP IN THIS FILE IS DJANGO'S FORMAT, "YYYY-MM-DD HH:MM:SS.ffffff"
// -- what pyDatetime() writes and what migration 0022 rewrote the imported
// Postgres rows into. These columns are TEXT, so `finished >= ?` and every
// ORDER BY over them is a byte-wise string comparison: an ISO
// "2026-09-06T11:00:00Z" value sorts above every space-separated one because
// 'T' (0x54) beats ' ' (0x20). Seeding ISO here would test a database this
// app does not have.
function seedCrawlSet(cs: {
  id: number;
  crawl_type: string;
  start: string;
  finish?: string | null;
  expected?: number | null;
  remaining?: number | null;
}): void {
  db.prepare("INSERT INTO crawlset (id, crawl_type, start, finish, expected, remaining) VALUES (?, ?, ?, ?, ?, ?)").run(
    cs.id,
    cs.crawl_type,
    cs.start,
    cs.finish ?? null,
    cs.expected ?? null,
    cs.remaining ?? null,
  );
}

function seedAdminJob(job: {
  id: string;
  kind: string;
  target?: string | null;
  status: string;
  created: string;
  finished?: string | null;
  error?: string | null;
  result?: string | null;
}): void {
  db.prepare("INSERT INTO admin_job (id, kind, target, status, result, error, created, finished) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    job.id,
    job.kind,
    job.target ?? null,
    job.status,
    job.result ?? null,
    job.error ?? null,
    job.created,
    job.finished ?? null,
  );
}

// ---------------------------------------------------------------------------
// Reading the rendered page
// ---------------------------------------------------------------------------

// jobs.njk lays its four tables out under four <h3> headings, and the Queues
// one is CONDITIONAL (`{% if queue_backlog %}`) -- so tables are addressed by
// their heading rather than by index, or every assertion about the Scheduled
// table would silently shift by one whenever the queue panel disappeared.
// admin/page.njk's chrome contains no <h3> at all, so the lookahead is safe.
function section(html: string, heading: string): string {
  const match = new RegExp(`<h3[^>]*>${heading}</h3>([\\s\\S]*?)(?=<h3|$)`).exec(html);
  if (!match) throw new Error(`no <h3>${heading}</h3> section in the rendered page`);
  return match[1]!;
}

// One array of cell texts per row of that section's table, tags stripped,
// HTML ENTITIES LEFT AS THEY ARE (`&mdash;`, `&#39;`) -- the template emits
// those and the expectations should read like the markup, not like a decoded
// approximation of it. Whole rows are compared against whole expected rows so
// that a column dropped between the query and the template fails here;
// nunjucks renders a missing variable as "" (env.ts pins throwOnUndefined:
// false, matching Django), so a dropped column is a blank cell, never an error.
function cells(html: string, heading: string): string[][] {
  const body = /<tbody[^>]*>([\s\S]*?)<\/tbody>/.exec(section(html, heading));
  if (!body) throw new Error(`the ${heading} section has no <tbody>`);
  return [...body[1]!.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((tr) =>
    [...tr[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((td) =>
      td[1]!
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    ),
  );
}

/** The five headline counters, by their heading, with whether the value is
 *  rendered red (jobs.njk:25 reds a non-empty dead letter queue and nothing
 *  else). `value` keeps its entities, so a dash arrives as `&mdash;` and can
 *  never be confused with a nought. */
function statTiles(html: string): Record<string, { value: string; red: boolean }> {
  const tiles: Record<string, { value: string; red: boolean }> = {};
  for (const m of html.matchAll(/<p class="heading">([^<]+)<\/p>\s*<p class="title"([^>]*)>([\s\S]*?)<\/p>/g)) {
    tiles[m[1]!.trim()] = { value: m[3]!.replace(/<[^>]*>/g, "").trim(), red: /color:red/.test(m[2]!) };
  }
  return tiles;
}

/** Every row of every table, as one comparable value. Snapshotted either side
 *  of a GET so "a read page wrote nothing" covers columns no assertion names,
 *  and tables this page has no business touching at all. */
function snapshot(): string {
  return JSON.stringify({
    crawlset: db.prepare("SELECT * FROM crawlset ORDER BY id").all(),
    admin_job: db.prepare("SELECT * FROM admin_job ORDER BY id").all(),
    crawlitem: db.prepare("SELECT * FROM crawlitem ORDER BY id").all(),
    foodbank: db.prepare("SELECT * FROM foodbank ORDER BY id").all(),
    foodbankchange: db.prepare("SELECT * FROM foodbankchange ORDER BY id").all(),
  });
}

function writeStatements(sql: string[]): string[] {
  return sql.filter((s) => /\b(insert|update|delete|drop|create|replace)\b/i.test(s));
}

/** Silences (and returns) the console.error getQueueBacklog writes on every
 *  degradation -- a degraded panel is the normal case in half the queue tests
 *  below, and the log itself is queueBacklog.test.ts's business, not this
 *  file's. */
function silenceDegradationLog() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe("auth and method", () => {
  // requireAdminAuth (middleware/adminAuth.ts, Django's LoginRequiredAccess)
  // is registered on adminApp with use("*"), so it must run before this
  // handler. Asserted through the SQL log AND the outbound-fetch log rather
  // than through the status alone: this is the one admin page that spends an
  // account-scoped Cloudflare API token on a render, so an anonymous request
  // reaching the handler would not merely leak the page, it would let an
  // unauthenticated caller drive traffic against api.cloudflare.com with our
  // credentials.
  it("redirects a signed-out caller to sign-in without querying D1 or calling Cloudflare", async () => {
    seedCrawlSet({ id: 1, crawl_type: "need", start: "2026-09-06 11:58:30.000000" });

    const { res, sql } = await getJobs({ signedIn: false });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fjobs%2F");
    expect(sql).toEqual([]);
    expect(outbound).toEqual([]);
  });

  // routes/admin/index.ts:193 registers this path with .get() and nothing
  // else, which is the whole of its method policy -- there is no POST handler
  // to CSRF-protect because there is no POST. Pinned so that a later
  // "add a Retry button here" arrives as a failing test rather than as a
  // mutating endpoint reachable without a token: a POST must not reach the
  // handler at all, and must leave the database exactly as it found it.
  it("does not answer a POST, and a POST changes nothing", async () => {
    seedAdminJob({ id: "job-1", kind: "check", target: "salisbury", status: "queued", created: "2026-09-06 11:00:00.000000" });
    const before = snapshot();

    const { res, sql } = await request("/admin/jobs/", { method: "POST" });

    expect(res.status).toBe(404);
    expect(sql).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  // THE OTHER HALF OF THE GATE, and the half with a precedent: commit
  // 1d02cf1 fixed "Sign Out doing nothing" -- the auth gate silently
  // re-authenticating through Google on every /admin/ visit. Signing out
  // deletes the KV entry and leaves the cookie in the browser, so a revoked
  // admin arrives here with a well-formed __Host-gfsession naming a key that
  // is gone. That is a DIFFERENT early return in getAdminSession from the
  // no-cookie one above (`!raw` rather than `!sessionId`), and until this
  // test the suite only ever exercised the no-cookie branch -- so a gate that
  // accepted any cookie whose id merely parsed would have passed the whole
  // file. Same proof as above: not the status alone, but that no SQL ran and
  // that the account-scoped Cloudflare token was not spent on the render.
  it("turns away a cookie whose session has been revoked, without touching D1 or Cloudflare", async () => {
    seedCrawlSet({ id: 1, crawl_type: "need", start: "2026-09-06 11:58:30.000000" });

    const { res, sql } = await getJobs({ sessionId: "signed-out-an-hour-ago" });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fjobs%2F");
    expect(sql).toEqual([]);
    expect(outbound).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The response, as opposed to what is in it
// ---------------------------------------------------------------------------

describe("the response itself", () => {
  // MUTANT KILLED: `c.html(html)` -> `c.text(html)`. The body is
  // BYTE-IDENTICAL, so every other assertion in this file -- forty of them,
  // all parsing that same body -- passes either way; only the header decides
  // whether a browser renders the page or shows the admin its raw markup.
  // The suite survived this mutant before this test existed. It is asserted
  // here for the same reason crawlSet.test.ts asserts it on its own detail
  // page: a one-word edit, invisible to content assertions, that breaks the
  // page completely.
  it("answers as HTML, so a browser renders the page rather than printing its markup", async () => {
    seedCrawlSet({ id: 1, crawl_type: "need", start: "2026-09-06 11:58:30.000000" });

    const { res } = await getJobs();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });
});

// ---------------------------------------------------------------------------
// The headline counters
// ---------------------------------------------------------------------------

describe("the five stat tiles", () => {
  // All five at once, from five DIFFERENT numbers, so no tile can be mistaken
  // for its neighbour -- the failure this guards against is not a missing
  // value but a value from the wrong source, which renders perfectly.
  it("reports every counter from its own source", async () => {
    stubFetch({
      queues: async () => jsonResponse(queueList(["q1", "givefood2-purge"], ["q2", "givefood2-needcheck-dlq"])),
      graphql: async () => jsonResponse(backlog(["q1", 7, "2026-09-06T11:59:00Z"], ["q2", 4, "2026-09-06T11:58:00Z"])),
    });
    // Two crawl sets running, one finished (which must not be counted).
    seedCrawlSet({ id: 1, crawl_type: "need", start: "2026-09-06 11:58:30.000000" });
    seedCrawlSet({ id: 2, crawl_type: "article", start: "2026-09-06 11:00:00.000000" });
    seedCrawlSet({ id: 3, crawl_type: "charity", start: "2026-09-06 05:30:00.000000", finish: "2026-09-06 05:31:00.000000" });
    // Three outstanding (queued + running), three finished inside the window.
    seedAdminJob({ id: "a", kind: "check", status: "queued", created: "2026-09-06 11:50:00.000000" });
    seedAdminJob({ id: "b", kind: "check", status: "queued", created: "2026-09-06 11:51:00.000000" });
    seedAdminJob({ id: "c", kind: "check", status: "running", created: "2026-09-06 11:52:00.000000" });
    seedAdminJob({ id: "d", kind: "check", status: "done", created: "2026-09-06 10:00:00.000000", finished: "2026-09-06 10:01:00.000000" });
    seedAdminJob({ id: "e", kind: "check", status: "done", created: "2026-09-06 09:00:00.000000", finished: "2026-09-06 09:01:00.000000" });
    seedAdminJob({ id: "f", kind: "check", status: "failed", created: "2026-09-06 08:00:00.000000", finished: "2026-09-06 08:01:00.000000", error: "boom" });

    const { res, html } = await getJobs();

    expect(res.status).toBe(200);
    const tiles = statTiles(html);
    expect(tiles["Crawls Running"]).toEqual({ value: "2", red: false });
    expect(tiles["Queued Messages"]).toEqual({ value: "11", red: false });
    expect(tiles["Dead Letter"]).toEqual({ value: "4", red: true });
    expect(tiles["Admin Jobs Outstanding"]).toEqual({ value: "3", red: false });
    expect(tiles["Admin Jobs 24h"]).toEqual({ value: "3", red: false });
  });

  // SUSPECT, PINNED AS IT BEHAVES. jobs.ts:100-103 says the dead letter count
  // is "broken out from queued_messages rather than added to it: a message in
  // a DLQ is not work in progress". The code does not do that -- queuedMessages
  // reduces over EVERY queue including the DLQs, so the 4 messages below are
  // counted in both tiles and "Queued Messages" reads 11 for 7 messages of
  // actual work in progress. Nothing errors; the number is simply not the one
  // the comment promises. Asserted as-is (11, not 7) rather than fixed here,
  // per this suite's rule: if the reduce is ever changed to skip DLQs, this
  // test fails and says why.
  it("counts dead letter messages in Queued Messages as well, despite the comment saying otherwise", async () => {
    stubFetch({
      queues: async () => jsonResponse(queueList(["q1", "givefood2-purge"], ["q2", "givefood2-needcheck-dlq"])),
      graphql: async () => jsonResponse(backlog(["q1", 7, "2026-09-06T11:59:00Z"], ["q2", 4, "2026-09-06T11:58:00Z"])),
    });

    const tiles = statTiles((await getJobs()).html);

    expect(tiles["Queued Messages"]!.value).toBe("11");
    expect(tiles["Dead Letter"]!.value).toBe("4");
  });

  // THE NULL-NOT-ZERO CONTRACT, which is the most load-bearing line on the
  // page (jobs.ts:85-89: "null messages means depth unknown, which must not
  // total as zero"). The GraphQL half is refused -- the exact production
  // failure, a token without Account Analytics:Read -- while the REST half
  // still names both queues. Every row's depth is unknown, so both tiles must
  // print an em dash. A zero here would say "the dead letter queue is empty"
  // on the strength of a call that never returned, and the DLQ is the one
  // thing on this page nobody is watching any other way.
  it("prints a dash, never a nought, when the depths could not be fetched", async () => {
    silenceDegradationLog();
    stubFetch({
      queues: async () => jsonResponse(queueList(["q1", "givefood2-purge"], ["q2", "givefood2-needcheck-dlq"])),
      graphql: async () => jsonResponse({ errors: [{ message: "not entitled" }] }),
    });

    const { res, html } = await getJobs();

    expect(res.status).toBe(200);
    const tiles = statTiles(html);
    expect(tiles["Queued Messages"]).toEqual({ value: "&mdash;", red: false });
    // Unknown is not an alarm either: the dash is grey, not red.
    expect(tiles["Dead Letter"]).toEqual({ value: "&mdash;", red: false });
    // Both queues are still listed, with unknown depths -- names without
    // depths still tells an admin which queues exist.
    expect(cells(html, "Queues").map((row) => [row[0], row[1]])).toEqual([
      ["givefood2-needcheck-dlq", "&mdash;"],
      ["givefood2-purge", "&mdash;"],
    ]);
  });

  // A queue that produced no sample in the 15-minute window is IDLE, and idle
  // is a known nought rather than an unknown -- getQueueBacklog fills it in as
  // 0 because the depths call succeeded. So the tiles must total, and the
  // dash must not appear: an idle queue and an unfetchable one are exactly the
  // two states this page has to keep apart.
  it("totals a known-empty queue as zero, unlike an unknown one", async () => {
    stubFetch({
      queues: async () => jsonResponse(queueList(["q1", "givefood2-purge"], ["q2", "givefood2-needcheck-dlq"])),
      graphql: async () => jsonResponse(backlog(["q1", 0, "2026-09-06T11:59:00Z"])),
    });

    const tiles = statTiles((await getJobs()).html);

    expect(tiles["Queued Messages"]).toEqual({ value: "0", red: false });
    expect(tiles["Dead Letter"]).toEqual({ value: "0", red: false });
  });

  // SUSPECT, PINNED. `haveDepths` is derived from the ROWS (`queues.some(q =>
  // q.messages !== null)`) rather than from whether the depths call succeeded,
  // so an account whose queue list comes back EMPTY -- both calls perfectly
  // healthy -- takes the unknown branch and shows two dashes where the true
  // answer is nought. Harmless today (this account has queues, and a dash is
  // at worst uninformative rather than reassuring) and recorded because it is
  // the one input that makes a successful fetch indistinguishable from a
  // failed one.
  it("shows dashes for an account with no queues at all, though the depths were fetched fine", async () => {
    stubFetch({
      queues: async () => jsonResponse(queueList()),
      graphql: async () => jsonResponse(backlog()),
    });

    const { res, html } = await getJobs();

    expect(res.status).toBe(200);
    expect(statTiles(html)["Queued Messages"]!.value).toBe("&mdash;");
    expect(statTiles(html)["Dead Letter"]!.value).toBe("&mdash;");
    expect(cells(html, "Queues")).toEqual([["No queues."]]);
  });
});

// ---------------------------------------------------------------------------
// Running Now
// ---------------------------------------------------------------------------

describe("the Running Now table", () => {
  // Every column of a running row, read back off the page, from values that
  // cannot be mistaken for one another (expected 1100, remaining 420, so
  // `done` is 680 and no two numbers coincide). `done` is DERIVED
  // (expected - remaining, crawlSets.ts:127) rather than stored, so a
  // subtraction the wrong way round is a plausible mutation that still
  // renders a number.
  it("renders every column of a running crawl set, with its icon and detail link", async () => {
    seedCrawlSet({ id: 7, crawl_type: "need", start: "2026-09-06 11:58:30.000000", expected: 1100, remaining: 420 });

    const { res, html } = await getJobs();

    expect(res.status).toBe(200);
    // Django's `|date:"N j, Y, P"` -- AP-style month, then Django's "P" time.
    expect(cells(html, "Running Now")).toEqual([["need", "Sept. 6, 2026, 11:58 a.m.", "0:01:30", "680 of 1100", "420"]]);
    expect(html).toContain('<a href="/admin/crawl-set/7/"><span class="mdi mdi-cart"></span> need</a>');
  });

  // THE PREDICATE THAT MAKES THE PANEL MEAN ANYTHING. "Running" is
  // `finish IS NULL` and nothing else, so a finished set -- however recent,
  // however long it took -- must be absent from both the table and the
  // counter. Drop the WHERE clause and this page reports the entire crawl
  // history as in flight, which reads as a catastrophe rather than as a bug.
  it("excludes finished crawl sets, however recently they finished", async () => {
    seedCrawlSet({ id: 1, crawl_type: "need", start: "2026-09-06 11:58:30.000000" });
    seedCrawlSet({ id: 2, crawl_type: "article", start: "2026-09-06 11:59:00.000000", finish: "2026-09-06 11:59:30.000000" });

    const { html } = await getJobs();

    expect(cells(html, "Running Now").map((row) => row[0])).toEqual(["need"]);
    expect(section(html, "Running Now")).not.toContain('href="/admin/crawl-set/2/"');
    expect(statTiles(html)["Crawls Running"]!.value).toBe("1");
  });

  // WHAT THIS PANEL IS ACTUALLY FOR. A crawl set whose consumer died keeps
  // finish NULL forever and nothing cleans it up (crawlSets.ts:110-114), so an
  // old start here is a STUCK sweep rather than a busy one -- and "running
  // for" is the only thing on the page that tells them apart. Python's
  // str(timedelta) borrows a day for the plural, which is why three days reads
  // "3 days, 0:00:00" and not "72:00:00".
  it("shows a stuck sweep's age in days, which is how a dead crawl is spotted", async () => {
    seedCrawlSet({ id: 1, crawl_type: "need", start: "2026-09-03 12:00:00.000000" });
    seedCrawlSet({ id: 2, crawl_type: "article", start: "2026-09-05 12:00:00.000000" });

    const { html } = await getJobs();

    expect(cells(html, "Running Now").map((row) => [row[0], row[2]])).toEqual([
      // Newest first (ORDER BY start DESC), so the freshest crawl is at the
      // top and the ancient one is the outlier at the bottom.
      ["article", "1 day, 0:00:00"],
      ["need", "3 days, 0:00:00"],
    ]);
  });

  // The queue's own countdown columns are nullable -- a crawl type that does
  // not fan out (or a set written before the columns existed) has neither --
  // and jobs.njk prints nothing at all rather than "null of null" or a
  // misleading "0 of 0". A row with no counters is still a running crawl and
  // must still be listed.
  it("leaves the progress cells empty when the set records no expected/remaining", async () => {
    seedCrawlSet({ id: 1, crawl_type: "charity", start: "2026-09-06 11:00:00.000000" });

    expect(cells((await getJobs()).html, "Running Now")).toEqual([["charity", "Sept. 6, 2026, 11 a.m.", "1:00:00", "", ""]]);
  });

  // A NOUGHT IS AN ANSWER; A BLANK CELL IS NOT -- the same null-vs-zero
  // contract the stat tiles get tested for, applied to the two cells that
  // actually carry the countdown. Both guards in jobs.njk are `!= null`
  // rather than a bare truthiness test, and both zeroes below are states a
  // real sweep passes through:
  //
  //   * done = 0 is a sweep in its FIRST SECONDS -- expected filled in,
  //     nothing rendered yet. "0 of 1100" says the fan-out worked; a blank
  //     cell says the same thing as a set that records no counters at all,
  //     which is what an admin checking "did the 15:00 sweep actually start"
  //     is trying to tell apart.
  //   * remaining = 0 is a sweep whose last item has landed but whose set
  //     has not been finalised -- so it is still in this table, and "0" is
  //     the cell that says it is about to leave.
  //
  // MUTANTS KILLED, both of which the suite survived before this test:
  // `{% if cs.done != null %}` -> `{% if cs.done %}`, and the same widening
  // of the Remaining guard. Every other Running Now test seeds either two
  // non-zero counters or two nulls, so neither guard was load-bearing.
  //
  // The third row also kills `expected !== null && remaining !== null` ->
  // `||` in getRunningCrawlSets' `done` (crawlSets.ts:127). That derivation
  // is crawlSets.test.ts's to own, but its consequence HERE is what an admin
  // sees: JS makes `500 - null` into 500, so the mutant prints a confident
  // "500 of 500" -- a finished sweep -- for a set that has done nothing.
  it("prints a nought in the progress cells rather than blanking them", async () => {
    // Just started: everything still to do.
    seedCrawlSet({ id: 1, crawl_type: "need", start: "2026-09-06 11:59:00.000000", expected: 1100, remaining: 1100 });
    // Last item landed, set not yet finalised.
    seedCrawlSet({ id: 2, crawl_type: "article", start: "2026-09-06 11:58:00.000000", expected: 1100, remaining: 0 });
    // Half a countdown -- expected known, remaining never written.
    seedCrawlSet({ id: 3, crawl_type: "charity", start: "2026-09-06 11:57:00.000000", expected: 500, remaining: null });

    expect(cells((await getJobs()).html, "Running Now")).toEqual([
      ["need", "Sept. 6, 2026, 11:59 a.m.", "0:01:00", "0 of 1100", "1100"],
      ["article", "Sept. 6, 2026, 11:58 a.m.", "0:02:00", "1100 of 1100", "0"],
      ["charity", "Sept. 6, 2026, 11:57 a.m.", "0:03:00", "", ""],
    ]);
  });

  // Django's `{% empty %}` branch. An empty <tbody> looks like a broken page;
  // "Nothing crawling right now." is an answer -- and it is the answer this
  // page gives most of the day, so it is worth pinning.
  it("says so when nothing is crawling", async () => {
    const { res, html } = await getJobs();

    expect(res.status).toBe(200);
    expect(cells(html, "Running Now")).toEqual([["Nothing crawling right now."]]);
    expect(statTiles(html)["Crawls Running"]!.value).toBe("0");
  });

  // crawl_type is free TEXT with no CHECK constraint, so a seventh type added
  // by a future producer reaches this page before anyone adds it to
  // CRAWL_TYPE_ICONS. The fallback glyph keeps the row rendering, and the row
  // must still be LISTED -- an unrecognised type is not a filter.
  it("gives an unrecognised crawl type the fallback icon rather than dropping the row", async () => {
    seedCrawlSet({ id: 1, crawl_type: "fsa", start: "2026-09-06 11:00:00.000000" });

    const { html } = await getJobs();

    expect(cells(html, "Running Now").map((row) => row[0])).toEqual(["fsa"]);
    expect(html).toContain('<span class="mdi mdi-help-circle"></span> fsa');
  });

  // The other half of the template's `| safe` on crawl_type_icon: the ICON is
  // trusted markup from crawlTypeIcon's own constant table, the TYPE beside it
  // is not. crawl_type is stored TEXT that no constraint validates and that
  // /admin/query/ can write, so if `| safe` ever migrated from the icon to the
  // whole cell, a row would become script in the admin's own browser, where
  // the session cookie is.
  it("escapes the crawl type itself, however it was written", async () => {
    seedCrawlSet({ id: 1, crawl_type: "<img src=x onerror=alert(1)>", start: "2026-09-06 11:00:00.000000" });

    const { html } = await getJobs();

    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  // The links these two panels carry have to resolve, and they resolve
  // through the route registration rather than through anything this page
  // knows -- so they are checked by ASKING THE SAME APP for them.
  // /admin/crawl-set/:id{[0-9]+}/ renamed or regex-tightened without updating
  // jobs.njk:50 and :100 would leave the panel an admin uses mid-incident
  // linking to a 404, and nothing else here would notice: nunjucks builds
  // both hrefs by string concatenation, so nothing typechecks them.
  it("links each crawl set at a URL the admin router actually serves, from both panels", async () => {
    seedCrawlSet({ id: 7, crawl_type: "need", start: "2026-09-06 11:58:30.000000" });
    seedCrawlSet({ id: 8, crawl_type: "article", start: "2026-09-06 10:20:00.000000", finish: "2026-09-06 10:22:00.000000" });
    const { html } = await getJobs();

    const running = [...section(html, "Running Now").matchAll(/href="(\/admin\/crawl-set\/\d+\/)"/g)].map((m) => m[1]!);
    const scheduled = [...section(html, "Scheduled").matchAll(/href="(\/admin\/crawl-set\/\d+\/)"/g)].map((m) => m[1]!);
    expect(running).toEqual(["/admin/crawl-set/7/"]);
    // needcheck's last run is the unfinished set 7; getarticles' is set 8.
    expect(scheduled).toEqual(["/admin/crawl-set/7/", "/admin/crawl-set/8/"]);

    for (const href of [...running, ...scheduled]) {
      const followed = await request(href);
      expect(followed.res.status).toBe(200);
      expect(followed.html).toContain("<h2>Crawl Set</h2>");
    }
  });
});

// ---------------------------------------------------------------------------
// Scheduled
// ---------------------------------------------------------------------------

describe("the Scheduled table", () => {
  // THE DUPLICATION JOBS.TS ADMITS TO, CHECKED RATHER THAN TRUSTED.
  // CRON_JOBS (jobs.ts:47-54) is a hand-copy of workers/jobs/wrangler.jsonc's
  // triggers.crons for a DIFFERENT Worker, which workers/site cannot import
  // and no runtime API can be asked for -- the file's own comment calls the
  // drift risk real and accepts it because the alternative was showing no
  // schedule at all. This test is the thing that makes that trade honest: it
  // reads the deploy config off disk and compares. A schedule changed there
  // and not here shows the admin a stale promise about when the next sweep
  // runs, and there is no other way to find out.
  //
  // The comparison is against the wrangler file's LITERAL TEXT because that
  // is what Cloudflare is given. It has bitten before in exactly this way:
  // "30 3 * * 0" was rejected outright by the trigger-update API (Cloudflare
  // numbers Sunday as 1, not 0) and only a real deploy caught it, so the two
  // files agreeing on "30 3 * * SUN" is a fact worth holding still.
  it("shows the same seven schedules, in the same order, as workers/jobs/wrangler.jsonc", async () => {
    // `.href`, not the URL object: this package typechecks against
    // @cloudflare/workers-types, whose global URL is not node:url's, and
    // fileURLToPath takes a string just as happily.
    const path = fileURLToPath(new URL("../../../../jobs/wrangler.jsonc", import.meta.url).href);
    const source = readFileSync(path, "utf8");
    const block = /"crons"\s*:\s*\[([\s\S]*?)\]/.exec(source);
    if (!block) throw new Error(`no "crons" array in ${path}`);
    // Line comments first -- that array is more comment than cron, and one of
    // the comments quotes a rejected cron string ("30 3 * * 0") that must not
    // be mistaken for an entry.
    const declared = (block[1]!
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n")
      .match(/"([^"]*)"/g) ?? []).map((quoted) => quoted.slice(1, -1));

    const shown = cells((await getJobs()).html, "Scheduled").map((row) => row[1]);

    // Seven since github #59 reinstated the daily dump in Django's own
    // 04:30 slot. The count is pinned so a cron added to one side and not
    // the other fails here rather than showing an admin a stale table.
    expect(declared).toHaveLength(7);
    expect(shown).toEqual(declared);
  });

  // Every cron row, whether or not it has ever run. The three that write a
  // crawl set are paired with the last one of THEIR OWN TYPE; the three that
  // write none say "not recorded" rather than leaving a blank cell that would
  // read as "never ran". The two kinds of nothing are different answers and
  // the page is careful to say which.
  it("lists all seven crons, pairing each with the last run of its own crawl type", async () => {
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-06 15:00:00.000000", finish: "2026-09-06 15:04:32.000000" });
    seedCrawlSet({ id: 11, crawl_type: "article", start: "2026-09-06 10:20:00.000000", finish: "2026-09-06 10:22:00.000000" });
    seedCrawlSet({ id: 12, crawl_type: "charity", start: "2026-09-06 05:30:00.000000", finish: "2026-09-06 05:41:00.000000" });

    const { html } = await getJobs();

    expect(cells(html, "Scheduled")).toEqual([
      ["needcheck", "0 15 * * *", "Full sweep of every food bank&#39;s needs page", "Sept. 6, 2026, 3 p.m.", "Sept. 6, 2026, 3:04 p.m."],
      ["getarticles", "20 8-22/2 * * *", "News/article feeds, every 2 hours", "Sept. 6, 2026, 10:20 a.m.", "Sept. 6, 2026, 10:22 a.m."],
      ["charityinfo", "30 5 * * *", "Charity register details", "Sept. 6, 2026, 5:30 a.m.", "Sept. 6, 2026, 5:41 a.m."],
      ["days_between_needs", "30 3 * * SUN", "Weekly recompute (one SQL statement)", "not recorded", ""],
      ["crawlitem prune", "10 3 * * *", "Crawl item retention prune", "not recorded", ""],
      ["frag refresh", "*/5 * * * *", "/frag/ payload refresh into KV", "not recorded", ""],
      ["dump", "30 4 * * *", "Daily CSV dumps to R2 (github #59)", "not recorded", ""],
    ]);
    // The icon belongs to the crawl type, so the three jobs that record no
    // crawl set get an empty string rather than the fallback help glyph --
    // there is no unknown type to describe, there is no type at all.
    expect(html).toContain('<span class="mdi mdi-cart"></span> needcheck');
    expect(html).toContain('<span class="mdi mdi-newspaper"></span> getarticles');
    expect(html).toContain('<span class="mdi mdi-bank"></span> charityinfo');
    expect(section(html, "Scheduled")).not.toContain("mdi-help-circle");
  });

  // THE MUTANT THIS KILLS is the one-line kind that renders perfectly: a Map
  // keyed on the wrong field, or a lookup that ignores its key and takes the
  // first row, gives every cron row a real timestamp from a real crawl -- just
  // not from its own job. Three types, three deliberately distant times, and
  // the assertion is the pairing rather than the presence.
  it("does not hand one crawl type's last run to another cron's row", async () => {
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-06 15:00:00.000000", finish: "2026-09-06 15:04:00.000000" });
    seedCrawlSet({ id: 11, crawl_type: "article", start: "2026-09-04 10:20:00.000000", finish: "2026-09-04 10:22:00.000000" });

    const rows = cells((await getJobs()).html, "Scheduled");

    expect(rows[0]![3]).toBe("Sept. 6, 2026, 3 p.m."); // needcheck  -> the need set
    expect(rows[1]![3]).toBe("Sept. 4, 2026, 10:20 a.m."); // getarticles -> the article set
    expect(rows[2]![3]).toBe("not recorded"); // charityinfo -> no charity set at all
  });

  // The LAST run, not any run -- so the older set of the same type must be
  // excluded, and the link must point at the newer set's id. Seeded with the
  // older row inserted LAST and holding the LOWER id, because in production id
  // order and start order agree; without scrambling, "the latest" and "the
  // first row SQLite happened to return" are the same row and the test would
  // agree with a query that promised no order at all.
  it("shows the latest run of a type and links it, not an older one", async () => {
    seedCrawlSet({ id: 20, crawl_type: "need", start: "2026-09-06 15:00:00.000000", finish: "2026-09-06 15:04:00.000000" });
    seedCrawlSet({ id: 9, crawl_type: "need", start: "2026-09-05 15:00:00.000000", finish: "2026-09-05 15:03:00.000000" });

    const { html } = await getJobs();

    expect(cells(html, "Scheduled")[0]![3]).toBe("Sept. 6, 2026, 3 p.m.");
    expect(section(html, "Scheduled")).toContain('<a href="/admin/crawl-set/20/">Sept. 6, 2026, 3 p.m.</a>');
    expect(section(html, "Scheduled")).not.toContain('href="/admin/crawl-set/9/"');
  });

  // A crawl type with runs but NO cron -- `check` and `urls` are written by
  // the food bank detail page's Force buttons, on demand and never on a
  // schedule. getCrawlTypeLastRuns returns them all; the table is driven by
  // CRON_JOBS and must ignore the ones it does not schedule. A row appearing
  // here would tell an admin an ad-hoc button is a nightly job.
  it("ignores crawl types that no cron runs", async () => {
    seedCrawlSet({ id: 30, crawl_type: "check", start: "2026-09-06 11:00:00.000000", finish: "2026-09-06 11:00:20.000000" });
    seedCrawlSet({ id: 31, crawl_type: "urls", start: "2026-09-06 10:00:00.000000", finish: "2026-09-06 10:00:30.000000" });

    const { html } = await getJobs();

    expect(cells(html, "Scheduled")).toHaveLength(7);
    expect(cells(html, "Scheduled").every((row) => row[3] === "not recorded")).toBe(true);
    expect(section(html, "Scheduled")).not.toContain("/admin/crawl-set/30/");
  });

  // A cron whose last run never finished is the alarm this column exists for
  // -- the nightly needcheck that started and never came back. Red
  // "Unfinished", never a blank cell, and never the start time repeated.
  it("marks a last run that never finished, in red", async () => {
    seedCrawlSet({ id: 10, crawl_type: "need", start: "2026-09-06 11:58:30.000000", finish: null });

    const { html } = await getJobs();

    expect(cells(html, "Scheduled")[0]).toEqual([
      "needcheck",
      "0 15 * * *",
      "Full sweep of every food bank&#39;s needs page",
      "Sept. 6, 2026, 11:58 a.m.",
      "Unfinished",
    ]);
    expect(section(html, "Scheduled")).toContain('<span style="color:red;">Unfinished</span>');
  });
});

// ---------------------------------------------------------------------------
// Admin Jobs
// ---------------------------------------------------------------------------

describe("the Admin Jobs table", () => {
  // Every column of a job row, plus the one column that must NOT appear:
  // admin_job.result holds the whole JSON payload a check produced (five
  // scrapes and a model's answer), and this list deliberately renders only
  // `error`. Leaking `result` into a 25-row table would bury the page in
  // kilobytes of JSON, so its absence is a feature and is asserted as one.
  it("renders every column of a job, and never its result payload", async () => {
    seedAdminJob({
      id: "job-1",
      kind: "check",
      target: "salisbury",
      status: "failed",
      created: "2026-09-06 11:00:00.000000",
      finished: "2026-09-06 11:02:30.000000",
      error: "openrouter: 429",
      result: '{"secret":"PAYLOAD-MARKER"}',
    });

    const { res, html } = await getJobs();

    expect(res.status).toBe(200);
    expect(cells(html, "Admin Jobs")).toEqual([
      ["check", "salisbury", "failed", "Sept. 6, 2026, 11 a.m.", "Sept. 6, 2026, 11:02 a.m.", "openrouter: 429"],
    ]);
    expect(html).not.toContain("PAYLOAD-MARKER");
  });

  // The four status tags, which are the only colour on this table and the
  // thing an admin scans for. Seeded so that each status carries a distinct
  // target, because the tag markup is a four-branch if/elif chain whose final
  // `else` is "done" -- a status the chain does not know (a fifth one added
  // later, or a typo written by a job producer) would silently render as a
  // green "done", which is the most reassuring possible way to display an
  // unknown state.
  it("tags each status, and shows anything it does not recognise as done", async () => {
    seedAdminJob({ id: "a", kind: "check", target: "one", status: "queued", created: "2026-09-06 11:04:00.000000" });
    seedAdminJob({ id: "b", kind: "check", target: "two", status: "running", created: "2026-09-06 11:03:00.000000" });
    seedAdminJob({ id: "c", kind: "check", target: "three", status: "done", created: "2026-09-06 11:02:00.000000" });
    seedAdminJob({ id: "d", kind: "check", target: "four", status: "failed", created: "2026-09-06 11:01:00.000000" });
    seedAdminJob({ id: "e", kind: "check", target: "five", status: "cancelled", created: "2026-09-06 11:00:00.000000" });

    const { html } = await getJobs();

    expect(cells(html, "Admin Jobs").map((row) => [row[1], row[2]])).toEqual([
      ["two", "running"],
      ["one", "queued"],
      ["three", "done"],
      ["four", "failed"],
      // SUSPECT, PINNED: "cancelled" is not one of AdminJobStatus' four
      // values, and the template's else branch prints the word "done" in a
      // green success tag rather than the status the row actually holds.
      ["five", "done"],
    ]);
    expect(section(html, "Admin Jobs")).toContain('<span class="tag is-danger">failed</span>');
    expect(section(html, "Admin Jobs")).toContain('<span class="tag is-info">running</span>');
    expect(section(html, "Admin Jobs")).toContain('<span class="tag is-warning">queued</span>');
  });

  // THE ORDERING adminJobs.ts:66-69 exists for: running first, then queued,
  // then everything finished, and newest-first inside each band. A stuck job
  // matters more than a finished one, and a queued job whose consumer never
  // picked it up must sort to the top where it can be seen rather than ageing
  // quietly down the list. The seeds are adversarial: the finished job is the
  // NEWEST row and the running job the OLDEST, so a plain `ORDER BY created
  // DESC` -- the obvious simplification -- inverts this table exactly.
  it("floats running and queued jobs above finished ones, whatever their age", async () => {
    seedAdminJob({ id: "newest-done", kind: "check", target: "done-new", status: "done", created: "2026-09-06 11:59:00.000000", finished: "2026-09-06 11:59:30.000000" });
    seedAdminJob({ id: "older-queued", kind: "check", target: "queued-old", status: "queued", created: "2026-09-06 09:00:00.000000" });
    seedAdminJob({ id: "oldest-running", kind: "check", target: "running-oldest", status: "running", created: "2026-09-06 08:00:00.000000" });
    seedAdminJob({ id: "old-failed", kind: "check", target: "failed-old", status: "failed", created: "2026-09-06 07:00:00.000000", finished: "2026-09-06 07:01:00.000000" });

    const order = cells((await getJobs()).html, "Admin Jobs").map((row) => row[1]);

    expect(order).toEqual(["running-oldest", "queued-old", "done-new", "failed-old"]);
  });

  // ADMIN_JOB_LIMIT is 25, and which 25 matters more than how many: a LIMIT
  // applied before the sort, or an ASC ordering, returns the same COUNT and
  // the wrong half of the history. THE SEED ORDER IS SCRAMBLED, deliberately
  // -- in production insertion order and `created` order agree, so seeding 26
  // rows newest-first would make "the newest 25" identical to "the first 25
  // rowids", which is also what a query with no ORDER BY at all returns.
  // Multiplying by 7 mod 26 permutes them, and the surviving 25 are now
  // determined by `created DESC` and by nothing else.
  it("shows the newest 25 jobs and drops the oldest, whatever order the rows were written in", async () => {
    const minutesOld = (n: number) => ((n * 7) % 26) + 1;
    for (let n = 1; n <= 26; n++) {
      const created = new Date(NOW - minutesOld(n) * 60_000).toISOString().slice(0, 19).replace("T", " ");
      seedAdminJob({ id: `job-${n}`, kind: "prune", target: `fb-${n}`, status: "done", created: `${created}.000000`, finished: `${created}.000000` });
    }
    const byAge = [...Array(26)].map((_, k) => k + 1).sort((a, b) => minutesOld(a) - minutesOld(b));

    const shown = cells((await getJobs()).html, "Admin Jobs").map((row) => row[1]);

    expect(shown).toHaveLength(25);
    expect(shown[0]).toBe(`fb-${byAge[0]}`);
    expect(shown[24]).toBe(`fb-${byAge[24]}`);
    // The single oldest is the one the cap loses -- asserted against the whole
    // section, because a row dropped from the table but still counted in the
    // tiles is a different bug from a row simply missing.
    expect(section((await getJobs()).html, "Admin Jobs")).not.toContain(`fb-${byAge[25]}`);
  });

  // `kind` and `target` are free TEXT with no constraint, written by whichever
  // route enqueued the job, and `target` is a food bank slug today but is
  // documented as "whatever `kind` needs" (0013_admin_jobs.sql). Nunjucks
  // autoescapes by default; this pins that nothing on this row opts out, in
  // the admin's own browser where the session cookie is.
  it("escapes the free-text columns", async () => {
    seedAdminJob({
      id: "job-1",
      kind: "<b>check</b>",
      target: "<img src=x onerror=alert(1)>",
      status: "failed",
      created: "2026-09-06 11:00:00.000000",
      error: "<script>alert(2)</script>",
    });

    const { html } = await getJobs();

    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<script>alert(2)</script>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;b&gt;check&lt;/b&gt;");
  });

  // A stack trace or a D1 error can run to kilobytes, and 25 of them
  // unabridged would push every other table off the screen -- so the Detail
  // cell is `|truncate(120)`. The tail is asserted absent rather than the
  // exact cut point being pinned: the claim worth holding is "long errors do
  // not take over the page", not nunjucks' word-boundary arithmetic.
  it("truncates a long error rather than letting one job fill the table", async () => {
    const error = `${"failed to fetch the needs page after three attempts ".repeat(4)}TAIL-MARKER`;
    seedAdminJob({ id: "job-1", kind: "check", status: "failed", created: "2026-09-06 11:00:00.000000", error });

    const { html } = await getJobs();

    const detail = cells(html, "Admin Jobs")[0]![5]!;
    expect(detail.startsWith("failed to fetch the needs page after three attempts")).toBe(true);
    expect(detail.endsWith("...")).toBe(true);
    expect(detail.length).toBeLessThan(error.length);
    expect(html).not.toContain("TAIL-MARKER");
  });

  // Empty is the normal state of this table -- admin jobs are button-triggered
  // and most days nobody presses one -- so "None" rather than an empty tbody,
  // and a finished job with no error must leave the Detail cell blank rather
  // than printing "null".
  it("says None when no job has ever run, and leaves a clean job's detail empty", async () => {
    expect(cells((await getJobs()).html, "Admin Jobs")).toEqual([["None"]]);

    seedAdminJob({ id: "job-1", kind: "check", status: "done", created: "2026-09-06 11:00:00.000000", finished: "2026-09-06 11:01:00.000000" });

    expect(cells((await getJobs()).html, "Admin Jobs")).toEqual([
      ["check", "", "done", "Sept. 6, 2026, 11 a.m.", "Sept. 6, 2026, 11:01 a.m.", ""],
    ]);
  });
});

// ---------------------------------------------------------------------------
// The 24-hour window
// ---------------------------------------------------------------------------

describe("the admin job counters", () => {
  // THE BOUNDARY, ROW BY ROW. `since` is pyDatetime(now - 86_400_000) compared
  // against a TEXT column with `>=`, which is the exact comparison that has
  // already gone wrong once in this codebase: getAdminDashboardStats built its
  // threshold with toISOString() and silently dropped every same-day row,
  // measured at 31 of 46 (pyDatetime.ts:15-21). A window that is too wide or
  // too narrow produces a number either way, so both sides of the boundary are
  // seeded a single second apart.
  it("counts a job finished exactly on the boundary and not one a second older", async () => {
    seedAdminJob({ id: "on-boundary", kind: "check", status: "done", created: "2026-09-05 11:00:00.000000", finished: SINCE });
    seedAdminJob({ id: "just-outside", kind: "check", status: "done", created: "2026-09-05 11:00:00.000000", finished: "2026-09-05 11:59:59.000000" });
    seedAdminJob({ id: "inside", kind: "check", status: "failed", created: "2026-09-06 10:00:00.000000", finished: "2026-09-06 10:01:00.000000", error: "boom" });

    expect(statTiles((await getJobs()).html)["Admin Jobs 24h"]!.value).toBe("2");
  });

  // The two counters partition the table differently and neither is a subset
  // of the other: `outstanding` is status-only and ignores the window
  // entirely, so a job queued a week ago -- which is exactly what a consumer
  // that never picked it up looks like -- is still outstanding today. That is
  // the number worth having; a 24h-limited version would let a permanently
  // stuck job age out of the dashboard.
  it("counts an ancient queued job as outstanding, and never as finished", async () => {
    seedAdminJob({ id: "ancient", kind: "check", status: "queued", created: "2026-08-01 09:00:00.000000" });

    const tiles = statTiles((await getJobs()).html);

    expect(tiles["Admin Jobs Outstanding"]!.value).toBe("1");
    expect(tiles["Admin Jobs 24h"]!.value).toBe("0");
  });

  // The row shape that belongs to NEITHER counter, pinned because it is the
  // one an admin would query support about. markAdminJobDone always writes
  // `finished` alongside the status, so a done row with a NULL finish is a
  // half-written job (a consumer that crashed between the two, or a row
  // hand-edited in the query console) -- the FILTER's `finished >= ?` drops it
  // from the 24h count and its status drops it from outstanding. It vanishes
  // from both numbers while still being listed in the table below them.
  it("counts a done job with no finish time in neither total, though it is still listed", async () => {
    seedAdminJob({ id: "half-written", kind: "check", target: "salisbury", status: "done", created: "2026-09-06 11:00:00.000000", finished: null });

    const { html } = await getJobs();

    expect(statTiles(html)["Admin Jobs 24h"]!.value).toBe("0");
    expect(statTiles(html)["Admin Jobs Outstanding"]!.value).toBe("0");
    expect(cells(html, "Admin Jobs").map((row) => row[1])).toEqual(["salisbury"]);
  });
});

// ---------------------------------------------------------------------------
// Queues
// ---------------------------------------------------------------------------

describe("the Queues panel", () => {
  // Every column of a queue row, and the ordering that decides which one an
  // admin sees first: anything with messages ahead of anything empty, a DLQ
  // ahead of a live queue at equal depth (a non-empty DLQ is the one that
  // needs a human), then alphabetical so the idle majority is scannable. The
  // seeds are in the WRONG order on both keys, so the sort is doing the work.
  it("renders every column and puts the backed-up queues first", async () => {
    stubFetch({
      queues: async () =>
        jsonResponse(queueList(["q1", "givefood2-purge"], ["q2", "givefood2-needcheck-dlq"], ["q3", "givefood2-needcheck"], ["q4", "givefood2-articles"])),
      graphql: async () =>
        jsonResponse(backlog(["q1", 0, "2026-09-06T11:59:00Z"], ["q2", 2, "2026-09-06T11:58:00Z"], ["q3", 2, "2026-09-06T11:57:00Z"])),
    });

    const { html } = await getJobs();

    expect(cells(html, "Queues")).toEqual([
      // Equal depth, DLQ first.
      ["givefood2-needcheck-dlq", "2", "Sept. 6, 2026, 11:58 a.m."],
      ["givefood2-needcheck", "2", "Sept. 6, 2026, 11:57 a.m."],
      // Then alphabetical among the empty ones, whatever order the account
      // listed them in -- "articles" before "purge", though purge was first
      // out of the API and is the one with a sample.
      //
      // No sample in the window at all: idle, which is NOT the same as a
      // depth of nought and is not rendered as one.
      ["givefood2-articles", "0", "idle"],
      ["givefood2-purge", "0", "Sept. 6, 2026, 11:59 a.m."],
    ]);
    // The alert glyph and the red weight are the only visual difference
    // between a queue that needs a human and one that does not.
    expect(section(html, "Queues")).toContain('<span class="mdi mdi-alert-circle-outline"></span> givefood2-needcheck-dlq');
    expect(section(html, "Queues")).toContain('<td style="color:red;font-weight:bold;">2</td>');
  });

  // THE OTHER WAY THE RED CAN STOP MEANING ANYTHING. The test below proves an
  // empty DLQ is not red; this one proves a BUSY LIVE QUEUE is not either.
  // jobs.njk:73 guards on `q.messages and q.is_dlq`, and dropping the second
  // half is a plausible tidy-up that no assertion here could see: the
  // whole-column test above seeds a live queue holding two messages and a DLQ
  // holding two, and its `toContain` for the red cell passes just as happily
  // when BOTH are red.
  //
  // Widening it would light the panel red every single night. givefood2-
  // needcheck holds ~1100 messages for the duration of the 15:00 sweep, which
  // is the system working; the DLQ holding one is the system having given up.
  // The panel exists to tell those apart, so the red must appear exactly once
  // here -- on the row that has nothing in it at all.
  //
  // MUTANT KILLED: `{% if q.messages and q.is_dlq %}` -> `{% if q.messages %}`.
  it("does not red a live queue that is merely busy", async () => {
    stubFetch({
      queues: async () => jsonResponse(queueList(["q1", "givefood2-needcheck"], ["q2", "givefood2-needcheck-dlq"])),
      graphql: async () => jsonResponse(backlog(["q1", 1100, "2026-09-06T11:59:00Z"], ["q2", 0, "2026-09-06T11:59:00Z"])),
    });

    const { html } = await getJobs();

    // Deepest first, so the busy live queue is the top row and the empty DLQ
    // the bottom one -- and neither carries the alarm.
    expect(cells(html, "Queues").map((row) => [row[0], row[1]])).toEqual([
      ["givefood2-needcheck", "1100"],
      ["givefood2-needcheck-dlq", "0"],
    ]);
    expect(section(html, "Queues")).not.toContain("color:red");
    expect(statTiles(html)["Queued Messages"]).toEqual({ value: "1100", red: false });
    expect(statTiles(html)["Dead Letter"]).toEqual({ value: "0", red: false });
  });

  // An EMPTY dead letter queue must not be red. The red is the whole signal;
  // if it were on every DLQ row it would say nothing, and the panel would be
  // decoration rather than an alarm.
  it("does not red an empty dead letter queue", async () => {
    stubFetch({
      queues: async () => jsonResponse(queueList(["q2", "givefood2-needcheck-dlq"])),
      graphql: async () => jsonResponse(backlog(["q2", 0, "2026-09-06T11:59:00Z"])),
    });

    const { html } = await getJobs();

    expect(section(html, "Queues")).not.toContain("color:red");
    expect(statTiles(html)["Dead Letter"]!.red).toBe(false);
  });

  // THE PROMISE jobs.ts:62-64 MAKES: "getQueueBacklog resolves rather than
  // rejects on failure, so one dead API cannot take the page down with it".
  // Both Cloudflare calls are refused outright and the page must still be a
  // 200 with every D1-sourced panel intact -- this is the page an admin opens
  // BECAUSE something is broken, and a 500 here would take the crawl and job
  // tables away at the moment they are most wanted.
  it("still renders the whole page when Cloudflare answers nothing at all", async () => {
    silenceDegradationLog();
    stubFetch({
      queues: async () => {
        throw new Error("boom");
      },
      graphql: async () => {
        throw new Error("boom");
      },
    });
    seedCrawlSet({ id: 1, crawl_type: "need", start: "2026-09-06 11:58:30.000000" });
    seedAdminJob({ id: "job-1", kind: "check", target: "salisbury", status: "running", created: "2026-09-06 11:00:00.000000" });

    const { res, html } = await getJobs();

    expect(res.status).toBe(200);
    expect(cells(html, "Running Now").map((row) => row[0])).toEqual(["need"]);
    expect(cells(html, "Admin Jobs").map((row) => row[1])).toEqual(["salisbury"]);
    expect(statTiles(html)["Crawls Running"]!.value).toBe("1");
    // Both failures named, each with the permission its failure implies --
    // a combined "HTTP 403" was the first thing this panel said in production
    // and it did not say which permission to add.
    expect(section(html, "Queues")).toContain('<div class="notification is-warning">');
    expect(section(html, "Queues")).toContain("queue names (boom)");
    expect(section(html, "Queues")).toContain("queue depths (boom)");
  });

  // A 403 is always the token, and the page says which permission the failing
  // half needs. Asserted through the rendered warning because that string is
  // the entire remedy an admin gets -- it is not logged anywhere they can see.
  it("names the missing token permission in the warning the admin reads", async () => {
    silenceDegradationLog();
    stubFetch({
      queues: async () => jsonResponse({ success: false }, 403),
      graphql: async () => jsonResponse(backlog(["q1", 1, "2026-09-06T11:59:00Z"])),
    });

    const { res, html } = await getJobs();

    expect(res.status).toBe(200);
    expect(section(html, "Queues")).toContain("CF_API_KEY is missing Queues:Read");
    // Depths survived, so the queue is still listed -- under its id, which is
    // a poor label but a backed-up queue with an ugly name beats a blank panel.
    expect(cells(html, "Queues")).toEqual([["queue q1", "1", "Sept. 6, 2026, 11:59 a.m."]]);
    expect(statTiles(html)["Queued Messages"]!.value).toBe("1");
  });

  // The state this Worker was actually deployed in before CF_API_KEY existed
  // as a secret: no credentials at all. Same degradation shape as
  // routes/admin/clearCache.ts -- one panel disabled with a stated reason,
  // never a 500 on a page that is otherwise perfectly renderable from D1 --
  // and, importantly, no outbound call attempted with an empty token.
  it("explains itself and calls nobody when the Cloudflare credentials are unset", async () => {
    seedCrawlSet({ id: 1, crawl_type: "need", start: "2026-09-06 11:58:30.000000" });

    const { res, html } = await getJobs({ creds: false });

    expect(res.status).toBe(200);
    expect(outbound).toEqual([]);
    expect(section(html, "Queues")).toContain("CF_ACCOUNT_ID/CF_API_KEY not set -- queue depths unavailable.");
    expect(cells(html, "Queues")).toEqual([["No queues."]]);
    expect(cells(html, "Running Now").map((row) => row[0])).toEqual(["need"]);
  });

  // The healthy case has NO warning box. Worth its own assertion because a
  // warning that is always present is one nobody reads, and the degraded
  // tests above would all still pass if the box were rendered unconditionally.
  it("shows no warning when both Cloudflare calls succeed", async () => {
    const { html } = await getJobs();

    expect(section(html, "Queues")).not.toContain("notification is-warning");
    expect(outbound.sort()).toEqual([GRAPHQL_URL, QUEUES_URL].sort());
  });
});

// ---------------------------------------------------------------------------
// Read-only means read-only
// ---------------------------------------------------------------------------

describe("side effects", () => {
  // This page is linked from every admin page's navbar, so it is loaded
  // constantly and prefetched by the browser's own instant.page (page.njk's
  // data-instant-allow-query-string) -- anything this handler wrote would be
  // written by HOVERING a link. Asserted twice over: the SQL issued contains
  // no write, and every row of both tables is byte-identical afterwards.
  it("writes nothing at all", async () => {
    seedCrawlSet({ id: 1, crawl_type: "need", start: "2026-09-06 11:58:30.000000", expected: 1100, remaining: 420 });
    seedCrawlSet({ id: 2, crawl_type: "article", start: "2026-09-06 10:20:00.000000", finish: "2026-09-06 10:22:00.000000" });
    seedAdminJob({ id: "job-1", kind: "check", target: "salisbury", status: "queued", created: "2026-09-06 11:00:00.000000" });
    const before = snapshot();

    const { res, sql } = await getJobs();

    expect(res.status).toBe(200);
    expect(writeStatements(sql)).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  // FOUR STATEMENTS, ONE PER SOURCE, however many rows come back. They go out
  // through one Promise.all so they overlap rather than queue; the COUNT is
  // what catches an N+1 creeping in later -- a per-row crawl-type lookup, say,
  // which on a 25-job page would be 25 extra round trips to a replicated D1
  // for a screen a human is waiting on. Two outbound HTTP calls, and not one
  // more, for the same reason.
  it("answers the whole page in four queries and two API calls, whatever it has to show", async () => {
    for (let i = 1; i <= 10; i++) {
      seedCrawlSet({ id: i, crawl_type: "need", start: `2026-09-06 1${i % 2}:0${i % 10}:00.000000` });
      seedAdminJob({ id: `job-${i}`, kind: "check", target: `fb-${i}`, status: "queued", created: `2026-09-06 11:0${i % 10}:00.000000` });
    }

    const { sql } = await getJobs();

    expect(sql).toHaveLength(4);
    expect(outbound).toHaveLength(2);
  });

  // The `section` string, which is the only thing that lights the navbar, and
  // a real failure mode with a real precedent: routes/admin/index.ts:322 has a
  // comment about the dashboard having passed "needs" here, which lit a tab
  // pointing at a completely different page. Exactly one item can be active.
  it("lights the Jobs navbar item and no other", async () => {
    const { html } = await getJobs();

    expect([...html.matchAll(/class="navbar-item is-active"/g)]).toHaveLength(1);
    expect(html).toContain('<a class="navbar-item is-active" href="/admin/jobs/">Jobs</a>');
    // adminPageContext ran with the session requireAdminAuth resolved, not an
    // anonymous one -- page.njk's "signed in as" comes from `admin_user`.
    expect(html).toContain(ADMIN_EMAIL);
    expect(html).toContain("<title>Jobs - Give Food Admin</title>");
  });
});
