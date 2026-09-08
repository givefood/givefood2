import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminJobRow, AdminJobStatus } from "@givefood/db";
import type { AppEnv } from "../../types";
import { hmacSha256Hex } from "../../lib/hmac";
import { requireAdminAuth } from "../../middleware/adminAuth";

// WP 6.8's check page, which is the one admin screen whose GET is pure and
// whose POST writes exactly one row -- so the failures it can have are all
// of the quiet kind this tier exists to hunt.
//
// Issue #34 was "the value was parsed, passed down, and written by no SQL at
// all; it redirected as though it had worked". The same shape is available
// here in three places, none of which raises anything:
//
//   * the POST inserts an admin_job and enqueues a message. If the INSERT
//     named the wrong columns, or the queue message used the wrong field
//     names, the admin still gets a 302 to a spinner -- and the spinner is
//     indistinguishable from a check that is genuinely still running. So
//     every enqueue test below READS THE ROW BACK out of SQLite and asserts
//     its columns, and asserts the queue message against the exact shape
//     workers/jobs/src/queues/jobs.ts:37-38 destructures.
//   * the GET decides WHICH job to show. getLatestAdminJob filters on kind
//     and target; a dropped predicate returns somebody else's job and the
//     page renders it perfectly happily. So the fixture seeds rows that MUST
//     BE EXCLUDED -- a newer check for another food bank, a newer job of
//     another kind on the same target -- rather than only the row that
//     should win.
//   * `?debug=` reads the stored result instead of re-running Django's
//     scrape. If it read the wrong half of the payload nothing would throw;
//     it would just print the wrong text.
//
// REAL SQLITE, REAL ROUTER, REAL EVERYTHING EXCEPT THE TEMPLATE. The
// database is node:sqlite seeded from migrations/0013_admin_jobs.sql and the
// foodbank half of 0001_core.sql; @givefood/db, lib/csrf, lib/session,
// lib/timesince and routes/admin/pageContext are all the shipped code, and
// the handlers are mounted on a real Hono app at the paths
// routes/admin/index.ts:148-149 and :286 register. Only `render` is stubbed,
// and only because packages/templates/src/generated/ is a gitignored build
// artefact (same reasoning as foodbankLocation.test.ts): asserting on the
// CONTEXT is also the more direct claim, since "the page shows the right
// job" is a statement about `job`, not about markup. Where a branch of
// foodbank_check.njk is what makes a context value matter, the assertion
// says which line.
//
// MUTATION-TESTED, in a scratchpad copy of the whole tree (with the workspace
// symlinks repointed INTO the copy, so a mutation of packages/db is really the
// module the test loads), never in src/. An authoring pass ran 18; a later
// adversarial pass ran 105 more, widened to packages/db/src/adminJobs.ts and
// lib/csrf.ts because a careless edit to the query or the token check reaches
// this route just as surely as one to the handler. Ninety-six of the 105
// failed the file. The kills worth naming, because each is a test's reason to
// exist: dropping the insertAdminJob call (7 tests);
// bug #34's own shape, a column dropped from the INSERT's column list; two
// same-typed binds swapped in that INSERT and in getLatestAdminJob's; storing
// the wrong `kind`; dropping `?job=` from either redirect; renaming the queue
// message's `foodbankSlug`; removing the CSRF check (7 tests); moving it below
// the write; falling back to the latest job when an explicit `?job=` misses;
// dropping either predicate from the fallback's WHERE, or reversing its ORDER
// BY; losing the `status === "done"` guard on the debug branch or the parsed
// result; serving the whole envelope from `?debug=json`; spelling url_fields
// as a Set; reading `modified` instead of `edited`; and letting a GET fall
// through into the POST branch (31 tests).
//
// Thirteen of that pass's survivors are closed by the seven tests that name
// them below: the nav `section`; a relabelled or swapped-in-pairs use-ai
// label; a `?slug=` or a body field steering the write; a csrf_token read from
// the query string; an unset CSRF_SECRET accepted as valid; issueCsrfToken
// minting on every render (the two-tab 403 csrf.ts:52-63 records as a real
// production bug); `?debug=` restricted to an explicit `?job=`; and the poll
// reading its id from `?id=` rather than the path.
//
// Nine survivors were left, and are survivors on purpose:
//   * FIVE are equivalent mutants -- `LIMIT 1` dropped from a query read
//     through `.first()`; `?debug=` matching neither branch either way;
//     `foodbank.slug` for the identical `slug` from the URL; and two
//     spellings of an empty token that fail the next comparison regardless.
//   * THREE belong to lib/csrf.test.ts, which already covers them far more
//     thoroughly than a route test could: adopting an unsigned cookie, a
//     cookie with no dot, and Sec-Fetch-Site: none (csrf.test.ts:348, :388,
//     :648). Re-asserting them here would duplicate that suite, not add to it.
//   * ONE IS A REAL GAP AND IS REPORTED, NOT PAPERED OVER: dropping the
//     `await` from insertAdminJob. node:sqlite executes the write
//     synchronously inside the promise, so the row is there by the time the
//     redirect is built and no assertion can see the difference. Only a
//     deliberately deferred database could catch it -- which would mean
//     mocking the database and testing the mock.
//
// One earlier version of the null-result test SURVIVED "parse the result
// whatever the status", because its fixture had no stored payload to leak and
// JSON.parse of a NULL column answers null either way; it now seeds one, and
// says so. (The ignored-debug test was re-checked the same way and killed its
// mutant with the empty fixture too -- an unguarded debug branch 500s on the
// null -- but it seeds a payload as well, so it fails for the stated reason
// rather than by accident.)

const mocks = vi.hoisted(() => ({
  render: vi.fn(async (template: string, _context: Record<string, unknown>) => `<html data-template="${template}"></html>`),
}));

// `translate` and `buildPageContext` are here because they are pulled in
// transitively -- lib/timesince.ts imports the first, routes/admin/
// pageContext.ts the second -- and a mock factory that omits an export the
// module graph imports fails at import time, not at the call. buildPageContext
// is a stand-in rather than the real thing: nothing here asserts on the
// canonical path or the version string, and importing the original would drag
// in env.ts's static import of the generated template bundle.
vi.mock("@givefood/templates", () => ({
  render: mocks.render,
  buildPageContext: () => ({}),
  translate: (_catalogue: Record<string, string>, text: string) => text,
}));

const { adminFoodbankCheck, adminJobStatus } = await import("./foodbankCheck");

// migrations/0013_admin_jobs.sql verbatim (columns, NOT NULLs and the index),
// plus a reduced foodbank table. The foodbank columns are the ones
// getFoodbankBySlug's `SELECT *` feeds to the handler and the template --
// including every NOT NULL in 0001_core.sql:10-47 that has no default, so an
// INSERT here fails the same way production's would. `latest_need_id` is
// present but never populated: nothing on this path reads the need. Since
// github #51 getFoodbankBySlug batches that lookup and sends it whether or not
// the column is set, so foodbankchange and its view are appended to SCHEMA
// below -- leaving latest_need_id NULL now only keeps the need rows out, not
// the tables.
//
// The index matters for the same reason packages/db/src/adminJobs.test.ts
// keeps it: getLatestAdminJob orders by `created`, and a fixture without the
// index is exercising a different query plan from production's.
const SCHEMA = `
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
  uuid TEXT NOT NULL,
  name TEXT NOT NULL, alt_name TEXT, slug TEXT NOT NULL,
  address TEXT NOT NULL, postcode TEXT NOT NULL, country TEXT NOT NULL,
  lat_lng TEXT NOT NULL, latitude REAL, longitude REAL,
  delivery_address TEXT, delivery_lat_lng TEXT,
  network TEXT, network_id TEXT, notes TEXT,
  charity_number TEXT, charity_just_foodbank INTEGER NOT NULL,
  facebook_page TEXT, bankuet_slug TEXT,
  contact_email TEXT NOT NULL, notification_email TEXT,
  phone_number TEXT,
  url TEXT NOT NULL, shopping_list_url TEXT NOT NULL,
  rss_url TEXT, news_url TEXT, donation_points_url TEXT,
  locations_url TEXT, contacts_url TEXT,
  place_id TEXT,
  address_is_administrative INTEGER NOT NULL,
  is_closed INTEGER NOT NULL,
  no_locations INTEGER NOT NULL, days_between_needs INTEGER NOT NULL,
  latest_need_id INTEGER,
  created TEXT NOT NULL, modified TEXT NOT NULL, edited TEXT
);
CREATE UNIQUE INDEX foodbank_slug_uniq ON foodbank(slug);
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

// The D1 Sessions API surface packages/db uses, over node:sqlite -- copied
// from foodbankLocation.test.ts rather than reinvented so the suites agree
// about what D1 does. `.first()` answering null (not undefined) for no row is
// the specific detail this handler leans on: `if (!job)` and `job.status`.
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
const ADMIN_USER = { email: "someone@givefood.org.uk", name: "Some One", givenName: "Some", picture: "" };

// Frozen clock, so `created` is an exact string rather than "something near
// now" -- the format is load-bearing (see the pyNow test below) and an
// assertion on a moving value would have to be loose enough to miss it.
const NOW = new Date("2026-09-07T09:20:00.000Z");
const NOW_PY = "2026-09-07 09:20:00.000000";

// Django's `str(datetime)`, six fractional digits, spread across days so the
// ordering tests cannot pass by accident on a same-instant fixture. The food
// bank's `created`, `modified` and `edited` are deliberately three DIFFERENT
// instants: the last-edit interval below is a claim about `edited`
// specifically, and a fixture where the three agreed would pass just as
// happily if the handler read the wrong one.
const T = {
  sep01: "2026-09-01 00:00:00.000000",
  sep05: "2026-09-05 07:15:00.000000",
  sep06: "2026-09-06 11:00:00.000000",
  sep07early: "2026-09-07 06:00:00.000000",
  sep07late: "2026-09-07 08:00:00.000000",
};

// A stored FoodbankCheckResult, shaped exactly as workers/jobs/src/adminJobs/
// foodbankCheck.ts:64-73 declares it and markAdminJobDone JSON.stringifies it.
// Every key the template reads is present, because `result` is handed to
// foodbank_check.njk whole and a payload missing half of it would render an
// empty comparison table without complaining.
const CHECK_RESULT = {
  prompt: "You are checking Salisbury Foodbank.\n\nHere is the text of every page we fetched.",
  aiResponse: {
    details: {
      address: "Unit 1\nBemerton Heath",
      postcode: "SP2 9DY",
      phone_number: "01722 349556",
      contact_email: "info@salisbury.foodbank.org.uk",
      charity_number: "1122447",
      facebook_page: "https://www.facebook.com/salisburyfoodbank",
      bankuet_slug: "salisbury",
      rss_url: "https://salisbury.foodbank.org.uk/feed/",
      news_url: "https://salisbury.foodbank.org.uk/news/",
      donation_points_url: "https://salisbury.foodbank.org.uk/give-help/donate-food/",
      locations_url: "https://salisbury.foodbank.org.uk/locations/",
      contacts_url: "https://salisbury.foodbank.org.uk/contact/",
    },
    locations: [{ name: "Wilton", address: "The Hollows", postcode: "SP2 0HR" }],
    donation_points: [],
  },
  fetchedPages: [
    { name: "homepage", url: "https://salisbury.foodbank.org.uk/", found: true, proxyField: "url" },
    { name: "shopping_list", url: "https://salisbury.foodbank.org.uk/give-help/", found: false, proxyField: "shopping_list_url" },
  ],
  detailChanges: { address: false, phone_number: true, contact_email: false },
  ourLocations: [{ slug: "bemerton-heath", name: "Bemerton Heath", address: "Pembroke Road", postcode: "SP2 9DY", discrepancy: false }],
  foundLocations: [{ name: "Wilton", address: "The Hollows", postcode: "SP2 0HR", discrepancy: true }],
  ourDonationPoints: [],
  foundDonationPoints: [],
};

// A different food bank's result, so a leak between the two is visible as a
// value rather than as a shape.
const OXFORD_RESULT = {
  prompt: "You are checking Oxford Foodbank.",
  aiResponse: { details: { phone_number: "01865 000000", contact_email: "info@oxford.example" }, locations: [], donation_points: [] },
  fetchedPages: [],
  detailChanges: { phone_number: true },
  ourLocations: [],
  foundLocations: [],
  ourDonationPoints: [],
  foundDonationPoints: [],
};

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let env: AppEnv["Bindings"];
let queueSend: ReturnType<typeof vi.fn>;

function seedFoodbank(row: { id: number; name: string; slug: string; edited: string | null }): void {
  db.prepare(
    `INSERT INTO foodbank
       (id, uuid, name, slug, address, postcode, country, lat_lng, contact_email, phone_number,
        url, shopping_list_url, charity_just_foodbank, address_is_administrative, is_closed,
        no_locations, days_between_needs, created, modified, edited)
     VALUES (?, ?, ?, ?, ?, 'SP2 9DY', 'England', '51.0688,-1.7945', ?, '01722349556',
             ?, ?, 0, 0, 0, 0, 0, ?, ?, ?)`,
  ).run(
    row.id,
    `uuid${row.id}`.padEnd(32, "0"),
    row.name,
    row.slug,
    "Unit 1\r\nBemerton Heath",
    `info@${row.slug}.example`,
    `https://${row.slug}.example/`,
    `https://${row.slug}.example/list/`,
    T.sep01,
    T.sep06,
    row.edited,
  );
}

function seedJob(job: {
  id: string;
  kind?: string;
  target?: string | null;
  status?: AdminJobStatus;
  result?: unknown;
  error?: string | null;
  created?: string;
  finished?: string | null;
}): string {
  db.prepare("INSERT INTO admin_job (id, kind, target, status, result, error, created, finished) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    job.id,
    job.kind ?? "check",
    job.target === undefined ? "salisbury" : job.target,
    job.status ?? "done",
    job.result === undefined ? null : JSON.stringify(job.result),
    job.error ?? null,
    job.created ?? T.sep06,
    job.finished ?? null,
  );
  return job.id;
}

function jobRows(): AdminJobRow[] {
  return db.prepare("SELECT * FROM admin_job ORDER BY id").all() as unknown as AdminJobRow[];
}

function jobRow(id: string): AdminJobRow | undefined {
  return db.prepare("SELECT * FROM admin_job WHERE id = ?").get(id) as unknown as AdminJobRow | undefined;
}

// The production registrations: routes/admin/index.ts:148-149 mount the check
// page as separate GET and POST entries on one handler, and :286 mounts the
// poll target as GET only. Registered here as the same two verbs on the same
// function, because "GET reads, POST enqueues" is a branch INSIDE the handler
// (`c.req.method === "POST"`) and a hand-built Context would let a change in
// how that branch is drawn slip through.
//
// `auth: true` swaps the fake session for the REAL requireAdminAuth
// middleware, which is how the unauthenticated tests reach the same gate
// production puts in front of adminApp.
function buildApp(opts: { auth?: boolean } = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    // adminPageContext -> elapsedMs reads this; unset it renders "NaN" into
    // the debug comment rather than throwing, which is exactly the sort of
    // thing a test should not be the first to introduce.
    c.set("requestStartTime", performance.now());
    await next();
  });
  if (opts.auth) {
    app.use("*", requireAdminAuth);
  } else {
    app.use("*", async (c, next) => {
      c.set("adminUser", ADMIN_USER);
      await next();
    });
  }
  app.get("/admin/foodbank/:slug/check/", adminFoodbankCheck);
  app.post("/admin/foodbank/:slug/check/", adminFoodbankCheck);
  app.get("/admin/job/:id/", adminJobStatus);
  // Labelled rather than left to become an unhandled rejection, so a
  // regression reads as "expected 302, got 500: ..." instead of a crash.
  app.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));
  return app;
}

let app: Hono<AppEnv>;

async function csrfCookie(): Promise<string> {
  return `__Host-csrf=${CSRF_RAW}.${await hmacSha256Hex(CSRF_SECRET, CSRF_RAW)}`;
}

// `async`, not a bare `return app.fetch(...)`: Hono types fetch() as
// `Response | Promise<Response>`, so the sync half has to be awaited away
// somewhere -- and vitest transpiles without typechecking, so a file that
// left it would run green here and fail `pnpm typecheck` for everyone.
async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return await app.fetch(new Request(`${ORIGIN}${path}`, { headers }), env, execCtx);
}

// A POST shaped like the browser's: same-origin, the signed cookie the page's
// render set, and the raw token the page embedded as a hidden field. Each
// piece is overridable, because each piece on its own is what the CSRF tests
// take away. `extra` adds further body fields -- this form declares exactly
// one, so anything else arriving in the body is either a stale field from an
// older template or an attacker's, and the write must ignore both.
async function post(
  path: string,
  opts: {
    token?: string | null;
    cookie?: string | null;
    origin?: string | null;
    secFetchSite?: string | null;
    extra?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  const cookie = opts.cookie === undefined ? await csrfCookie() : opts.cookie;
  if (cookie !== null) headers.Cookie = cookie;
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin !== null) headers.Origin = origin;
  const secFetchSite = opts.secFetchSite === undefined ? "same-origin" : opts.secFetchSite;
  if (secFetchSite !== null) headers["Sec-Fetch-Site"] = secFetchSite;

  const body = new URLSearchParams();
  const token = opts.token === undefined ? CSRF_RAW : opts.token;
  if (token !== null) body.set("csrf_token", token);
  for (const [name, value] of Object.entries(opts.extra ?? {})) body.set(name, value);

  return app.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: body.toString() }), env, execCtx);
}

function lastRender(): { template: string; context: Record<string, unknown> } {
  const call = mocks.render.mock.calls.at(-1);
  if (!call) throw new Error("the handler rendered nothing");
  return { template: call[0], context: call[1] };
}

function renderedJob(): AdminJobRow | null {
  return lastRender().context.job as AdminJobRow | null;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);

  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  seedFoodbank({ id: 1, name: "Salisbury Foodbank", slug: "salisbury", edited: T.sep05 });
  seedFoodbank({ id: 2, name: "Oxford Foodbank", slug: "oxford", edited: null });

  queueSend = vi.fn(async (_message: unknown) => {});
  env = {
    DB: { withSession: () => d1Session(db) },
    // Never reached unless a request carries an admin session cookie, which
    // only the unauthenticated tests care about -- and those send none.
    SESSIONS: { get: async () => null, put: async () => {} },
    JOBS_Q: { send: queueSend },
    CSRF_SECRET,
    GMAP_STATIC_KEY: "",
    GMAP_GEOCODE_KEY: "",
  } as unknown as AppEnv["Bindings"];

  app = buildApp();
});

afterEach(() => {
  vi.useRealTimers();
});

// ===========================================================================
// POST -- the one write this page has
// ===========================================================================
describe("POST /admin/foodbank/:slug/check/ -- enqueuing a check", () => {
  // THE ISSUE-#34 ASSERTION. A 302 to `?job=<uuid>` looks identical whether
  // the INSERT stored a row or stored nothing, because the page it lands on
  // renders "queued" for a missing job exactly as readily as it renders the
  // Run Check button. So the row is read back out of SQLite, column by
  // column, and the redirect is checked to point at THAT id.
  it("writes a queued admin_job and sends the admin to it", async () => {
    const res = await post("/admin/foodbank/salisbury/check/");

    expect(res.status).toBe(302);
    const location = res.headers.get("Location");
    expect(location).toMatch(/^\/admin\/foodbank\/salisbury\/check\/\?job=[0-9a-f-]{36}$/);

    const rows = jobRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(location).toBe(`/admin/foodbank/salisbury/check/?job=${row.id}`);
    expect(row.kind).toBe("check");
    expect(row.target).toBe("salisbury");
    expect(row.status).toBe("queued");
    // Nothing has run yet: a result or a finished time on a freshly enqueued
    // job would make getAdminJobCounts (adminJobs.ts:86-97) count it as
    // finished before the consumer has touched it.
    expect(row.result).toBeNull();
    expect(row.error).toBeNull();
    expect(row.finished).toBeNull();
  });

  // pyNow(), never toISOString(). getLatestAdminJob's `ORDER BY created DESC`
  // is a TEXT sort, and 'T' (0x54) sorts after ' ' (0x20), so a single
  // ISO-formatted row would win that comparison against every Django-format
  // row on the same day regardless of the actual time -- the exact failure
  // packages/models/src/pyDatetime.ts's header records happening twice in
  // production. Asserted here because this handler is one of the write sites.
  it("stamps `created` in Django's format, not ISO", async () => {
    await post("/admin/foodbank/salisbury/check/");

    expect(jobRows()[0]!.created).toBe(NOW_PY);
    expect(jobRows()[0]!.created).not.toContain("T");
  });

  // THE CROSS-WORKER CONTRACT. workers/jobs/src/queues/jobs.ts:37-38
  // switches on `type` and destructures `jobId`/`foodbankSlug`; a message
  // with the right values under the wrong names is accepted by the queue,
  // dispatched to nothing, and the job sits at "queued" forever with the
  // page spinning. Nothing on this side would notice.
  it("sends the queue message workers/jobs actually destructures", async () => {
    await post("/admin/foodbank/salisbury/check/");

    expect(queueSend).toHaveBeenCalledTimes(1);
    expect(queueSend.mock.calls[0]![0]).toEqual({
      type: "foodbank-check",
      jobId: jobRows()[0]!.id,
      foodbankSlug: "salisbury",
    });
  });

  // The round trip the admin actually experiences: press the button, follow
  // the redirect, and find the job the button created. This is what proves
  // the id in the URL, the id in the row and the id the page reads are one
  // value rather than three that happen to be generated near each other.
  it("lands on a page showing the job it just created", async () => {
    const res = await post("/admin/foodbank/salisbury/check/");
    const followed = await get(res.headers.get("Location")!);

    expect(followed.status).toBe(200);
    expect(lastRender().template).toBe("admin/foodbank_check.njk");
    expect(renderedJob()?.id).toBe(jobRows()[0]!.id);
    expect(renderedJob()?.status).toBe("queued");
    // Still "queued", so no result is handed to the template -- the done
    // branch of foodbank_check.njk:57 is the only one that reads it.
    expect(lastRender().context.result).toBeNull();
  });

  // Re-run is a first-class action (foodbank_check.njk:61-64's Re-run button
  // and :52-55's Retry both POST here), so a second press must create a
  // second job rather than resurrect or overwrite the first. Both rows are
  // stamped at the same frozen instant on purpose: `ORDER BY created DESC
  // LIMIT 1` cannot break that tie, which is precisely why the redirect
  // carries `?job=` instead of relying on "latest".
  it("creates a second, distinct job on a re-run rather than reusing the first", async () => {
    const first = await post("/admin/foodbank/salisbury/check/");
    const second = await post("/admin/foodbank/salisbury/check/");

    const rows = jobRows();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    expect(first.headers.get("Location")).not.toBe(second.headers.get("Location"));
    expect(queueSend).toHaveBeenCalledTimes(2);

    // Each `?job=` resolves to its own row, tie or no tie.
    for (const row of rows) {
      await get(`/admin/foodbank/salisbury/check/?job=${row.id}`);
      expect(renderedJob()?.id).toBe(row.id);
    }
  });

  // get_object_or_404, before anything else -- and deliberately before the
  // CSRF check, which is why this sends a token that would otherwise be
  // rejected. Pinned because the ORDER is the observable part: a 403 here
  // would mean the CSRF check had moved above the lookup.
  it("404s an unknown food bank without writing or enqueuing anything", async () => {
    const res = await post("/admin/foodbank/nowhere/check/", { token: "not-the-token" });

    expect(res.status).toBe(404);
    expect(jobRows()).toHaveLength(0);
    expect(queueSend).not.toHaveBeenCalled();
  });

  // THE PATH IS THE ONLY INPUT. Issue #34 was a value that reached the write
  // from the wrong place; the mirror-image failure is a value reaching it from
  // one place too many. Every identifier this write uses comes from the route
  // pattern, so a query param or a body field of the same name must be inert
  // -- and inertness is invisible unless something sends one. This POST sends
  // `slug` and `target` twice over, in the query string and in the body, both
  // naming a food bank that exists (so a handler that read either would write
  // a perfectly valid row for the WRONG food bank, redirect to it, and queue a
  // scrape of it, with nothing anywhere to raise).
  //
  // Mutants killed: `const slug = c.req.query("slug") ?? c.req.param("slug")!`
  // and `target: typeof body.target === "string" ? body.target : slug`. Both
  // survived every other test in this file.
  it("takes the food bank from the path alone, ignoring a ?slug= or a body field that disagrees", async () => {
    const res = await post("/admin/foodbank/salisbury/check/?slug=oxford&job=whatever", {
      extra: { slug: "oxford", target: "oxford", foodbankSlug: "oxford" },
    });

    expect(res.status).toBe(302);
    const rows = jobRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target).toBe("salisbury");
    expect(res.headers.get("Location")).toBe(`/admin/foodbank/salisbury/check/?job=${rows[0]!.id}`);
    expect(queueSend.mock.calls[0]![0]).toEqual({ type: "foodbank-check", jobId: rows[0]!.id, foodbankSlug: "salisbury" });
  });

  // SUSPECT (reported, not fixed): the row is inserted BEFORE the queue send,
  // and a failed send leaves it behind at "queued" forever. That is not a
  // cosmetic leak -- foodbank_check.njk:38 gates the Run Check button on
  // `not job`, and getLatestAdminJob happily returns this orphan, so the page
  // shows a spinner polling every 2s and offers the reviewer no way to try
  // again. Pinned as it stands: a 500, and the row still there.
  it("leaves the job row behind when the queue send fails", async () => {
    queueSend.mockRejectedValueOnce(new Error("queue unavailable"));

    const res = await post("/admin/foodbank/salisbury/check/");

    expect(res.status).toBe(500);
    expect(jobRows()).toHaveLength(1);
    expect(jobRows()[0]!.status).toBe("queued");

    // And this is what the reviewer then sees: a job, so no Run Check form.
    await get("/admin/foodbank/salisbury/check/");
    expect(renderedJob()).not.toBeNull();
    expect(renderedJob()?.status).toBe("queued");
  });
});

// ===========================================================================
// CSRF -- WP 4.6's signed double-submit, on the one mutating route here
// ===========================================================================
describe("POST -- CSRF", () => {
  // Every refusal below asserts the same two things as well as the status:
  // NO ROW and NO QUEUE MESSAGE. "403" on its own would still pass if the
  // insert had already happened above the check.
  function assertNothingHappened(): void {
    expect(jobRows()).toHaveLength(0);
    expect(queueSend).not.toHaveBeenCalled();
  }

  it("refuses a POST with no csrf_token field", async () => {
    const res = await post("/admin/foodbank/salisbury/check/", { token: null });

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden");
    assertNothingHappened();
  });

  it("refuses a token that does not match the cookie", async () => {
    const res = await post("/admin/foodbank/salisbury/check/", { token: "c".repeat(64) });

    expect(res.status).toBe(403);
    assertNothingHappened();
  });

  it("refuses a token with no cookie at all", async () => {
    const res = await post("/admin/foodbank/salisbury/check/", { cookie: null });

    expect(res.status).toBe(403);
    assertNothingHappened();
  });

  // An unsigned cookie an attacker could plant from a sibling subdomain: the
  // raw halves match, so a plain double-submit would accept it. Only the HMAC
  // rejects it.
  it("refuses a cookie whose signature does not verify", async () => {
    const res = await post("/admin/foodbank/salisbury/check/", { cookie: `__Host-csrf=${CSRF_RAW}.${"0".repeat(64)}` });

    expect(res.status).toBe(403);
    assertNothingHappened();
  });

  // The cross-site half. A queued check is five scrapes and a Gemini call
  // billed to this account, so a cross-origin form POST that got through
  // would be a cost amplifier as well as an unwanted write.
  it("refuses a cross-origin POST that carries a valid token", async () => {
    const res = await post("/admin/foodbank/salisbury/check/", { origin: "https://evil.example" });

    expect(res.status).toBe(403);
    assertNothingHappened();
  });

  it("refuses a cross-site POST by Sec-Fetch-Site alone", async () => {
    const res = await post("/admin/foodbank/salisbury/check/", { origin: null, secFetchSite: "cross-site" });

    expect(res.status).toBe(403);
    assertNothingHappened();
  });

  // THE TOKEN COMES OUT OF THE FORM BODY, never the URL. The handler reads
  // `body.csrf_token` after parseBody(); widening that to
  // `c.req.query("csrf_token") ?? body.csrf_token` -- the shape a "make it work
  // for the fetch() call too" edit takes -- survived every other CSRF test
  // here, because they all put the token where the real form does. A token in
  // a query string is a token in the access log, the Referer header and the
  // browser's history, which is the whole reason it is a hidden field.
  it("ignores a csrf_token in the query string when the body carries none", async () => {
    const res = await post(`/admin/foodbank/salisbury/check/?csrf_token=${CSRF_RAW}`, { token: null });

    expect(res.status).toBe(403);
    assertNothingHappened();
  });

  // FAIL CLOSED WITH NO SECRET, at this route rather than in the abstract.
  // lib/csrf.test.ts already proves verifyCsrf() returns false when
  // CSRF_SECRET is unset; what this asserts is the consequence here, which is
  // the part a deployment actually meets: issueCsrfToken renders an EMPTY
  // hidden field (csrf.ts:44-48), and the POST of that empty field is refused
  // with no row and no queue message. The mutant is `if (!secret) return true`
  // -- an unset binding on a fresh environment silently accepting every
  // cross-site POST on the one route here that costs money to run.
  it("refuses every submission, and renders an empty token, when CSRF_SECRET is unset", async () => {
    // issueCsrfToken and verifyCsrf both log their refusal by design; silenced
    // so the run stays readable, and asserted only as "it said something",
    // since the wording belongs to lib/csrf.ts and not to this test.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    env = { ...env, CSRF_SECRET: undefined } as unknown as AppEnv["Bindings"];

    const rendered = await get("/admin/foodbank/salisbury/check/");
    expect(lastRender().context.csrf_token).toBe("");
    expect(rendered.headers.get("Set-Cookie")).toBeNull();

    const res = await post("/admin/foodbank/salisbury/check/", { token: "" });

    expect(res.status).toBe(403);
    assertNothingHappened();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  // THE TWO-TAB FLOW, through this route. issueCsrfToken REUSES a still-valid
  // cookie instead of minting per render, and csrf.ts:52-63 records why: while
  // it minted unconditionally, each render replaced the cookie, so only the
  // most recently rendered admin page could submit -- open a second food bank,
  // go back to the first, press Run Check, get a 403 and lose the page.
  //
  // The single-render test below cannot see that regression, because one
  // render's token and cookie always agree with each other. This one renders
  // TWICE, keeps tab 1's hidden field, and submits it against the cookie jar
  // as it stands after tab 2 -- which is exactly what the browser does. Mutant
  // killed: disabling the reuse branch in issueCsrfToken.
  it("still accepts tab one's token after a second tab has rendered the page", async () => {
    const first = await get("/admin/foodbank/salisbury/check/");
    const tabOneToken = lastRender().context.csrf_token as string;
    const cookie = first.headers.get("Set-Cookie")!.split(";")[0]!;

    const second = await get("/admin/foodbank/oxford/check/", { Cookie: cookie });
    expect(lastRender().context.csrf_token).toBe(tabOneToken);
    // The jar keeps whatever the second render set, or the first cookie if it
    // set nothing -- which is the behaviour under test, so it is read rather
    // than assumed either way.
    const jar = second.headers.get("Set-Cookie")?.split(";")[0] ?? cookie;

    const res = await post("/admin/foodbank/salisbury/check/", { token: tabOneToken, cookie: jar });

    expect(res.status).toBe(302);
    expect(jobRows()).toHaveLength(1);
    expect(jobRows()[0]!.target).toBe("salisbury");
  });

  // THE END-TO-END CLAIM, and the one the individual refusals cannot make:
  // the token this page RENDERS is the token this page ACCEPTS. issueCsrfToken
  // mints a raw value into the context and a signed cookie onto the response
  // (lib/csrf.ts:95-99); if those two ever drifted apart, every button on the
  // check page would 403 while all six tests above still passed.
  it("accepts the token the page's own render issued", async () => {
    const rendered = await get("/admin/foodbank/salisbury/check/");
    const token = lastRender().context.csrf_token as string;
    const cookie = rendered.headers.get("Set-Cookie")!.split(";")[0]!;

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(cookie).toContain(token);

    const res = await post("/admin/foodbank/salisbury/check/", { token, cookie });

    expect(res.status).toBe(302);
    expect(jobRows()).toHaveLength(1);
  });
});

// ===========================================================================
// Auth -- the gate adminApp puts in front of every route in this file
// ===========================================================================
describe("auth", () => {
  beforeEach(() => {
    app = buildApp({ auth: true });
  });

  // A valid CSRF token is deliberately included: the point is that the
  // request never reaches the handler, not that it fails some later check.
  it("bounces an unauthenticated POST to sign-in without writing anything", async () => {
    const res = await post("/admin/foodbank/salisbury/check/");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Ffoodbank%2Fsalisbury%2Fcheck%2F");
    expect(jobRows()).toHaveLength(0);
    expect(queueSend).not.toHaveBeenCalled();
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it("bounces an unauthenticated GET before it renders anything", async () => {
    seedJob({ id: "job-done", result: CHECK_RESULT });

    const res = await get("/admin/foodbank/salisbury/check/");

    expect(res.status).toBe(302);
    expect(mocks.render).not.toHaveBeenCalled();
  });

  // The poll target is under the same gate. It leaks less than the page, but
  // a job's status, kind, target and error are still admin data, and htmx
  // following an unauthenticated redirect would replace the fragment with a
  // sign-in page.
  it("bounces an unauthenticated poll of the job status endpoint", async () => {
    seedJob({ id: "job-queued", status: "queued" });

    const res = await get("/admin/job/job-queued/");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fjob%2Fjob-queued%2F");
  });
});

// ===========================================================================
// GET -- which job the page decides to show
// ===========================================================================
describe("GET -- choosing the job", () => {
  it("404s an unknown food bank", async () => {
    const res = await get("/admin/foodbank/nowhere/check/");

    expect(res.status).toBe(404);
    expect(mocks.render).not.toHaveBeenCalled();
  });

  // No job yet: `job` is null, which is the ONLY state in which
  // foodbank_check.njk:38 offers the Run Check button. If this ever came back
  // non-null the page would open on a spinner for a check nobody started.
  it("hands the template a null job when this food bank has never been checked", async () => {
    seedJob({ id: "someone-elses", target: "oxford" });

    const res = await get("/admin/foodbank/salisbury/check/");

    expect(res.status).toBe(200);
    expect(renderedJob()).toBeNull();
    expect(lastRender().context.result).toBeNull();
  });

  // THE FILTER TEST. getLatestAdminJob's WHERE has two predicates and its
  // ORDER BY one column; every row here exists to fail if one of the three
  // goes missing. Seeding only the row that should win would pass with no
  // WHERE clause at all.
  it("falls back to the newest check for THIS food bank, excluding every other row", async () => {
    seedJob({ id: "older-salisbury", created: T.sep06 });
    seedJob({ id: "newest-salisbury", created: T.sep07early });
    // Newer, but another food bank -- kills a dropped `target = ?`.
    seedJob({ id: "newer-oxford", target: "oxford", created: T.sep07late });
    // Newer, same target, different kind -- kills a dropped `kind = ?`.
    // order-lines targets an order id, but a `kind`-blind query would not
    // care, and this is the shape that reaches this table in production.
    seedJob({ id: "newer-other-kind", kind: "order-lines", created: T.sep07late });

    await get("/admin/foodbank/salisbury/check/");

    expect(renderedJob()?.id).toBe("newest-salisbury");
  });

  // `?job=` is what the POST redirect and the poll's HX-Redirect both carry,
  // so it has to beat "latest" -- otherwise pressing Re-run twice would leave
  // the first tab silently watching the second job.
  it("prefers an explicit ?job= over the newest one", async () => {
    seedJob({ id: "older", created: T.sep06 });
    seedJob({ id: "newest", created: T.sep07late });

    await get("/admin/foodbank/salisbury/check/?job=older");

    expect(renderedJob()?.id).toBe("older");
  });

  // A stale bookmark, or a job deleted out from under a tab. `getAdminJob`
  // answers null and the page falls back to the Run Check form rather than
  // quietly substituting a DIFFERENT job's result under the requested id --
  // which is what a `?? getLatestAdminJob(...)` here would do.
  it("shows no job at all for an unknown ?job=, rather than falling back to the latest", async () => {
    seedJob({ id: "real-job", result: CHECK_RESULT });

    await get("/admin/foodbank/salisbury/check/?job=no-such-job");

    expect(renderedJob()).toBeNull();
    expect(lastRender().context.result).toBeNull();
  });

  // `?job=` with nothing after it is falsy, so it takes the latest branch --
  // not a lookup for the empty string. Pinned because it is the difference
  // between a link with a lost query value showing the newest check and
  // showing the Run Check button.
  it("treats an empty ?job= as absent", async () => {
    seedJob({ id: "latest", result: CHECK_RESULT });

    await get("/admin/foodbank/salisbury/check/?job=");

    expect(renderedJob()?.id).toBe("latest");
  });

  // SUSPECT (reported, not fixed): getAdminJob is looked up by id ALONE, so a
  // job belonging to another food bank renders in full under this food bank's
  // heading. This is not merely confusing to read. foodbank_check.njk:120-124
  // builds every "Use" button as
  //   POST /admin/foodbank/{{ foodbank.slug }}/use-ai/<field>/  value=<found>
  // where `foodbank` comes from the URL and the value comes from the job --
  // so one click on this page writes Oxford's phone number onto Salisbury,
  // and useAi.ts (which validates the field name and the value's format, but
  // never the job) accepts it. Pinned as it stands.
  it("renders another food bank's job when its id is passed as ?job=", async () => {
    seedJob({ id: "oxford-job", target: "oxford", result: OXFORD_RESULT });

    const res = await get("/admin/foodbank/salisbury/check/?job=oxford-job");

    expect(res.status).toBe(200);
    expect(renderedJob()?.target).toBe("oxford");
    expect((lastRender().context.foodbank as { slug: string }).slug).toBe("salisbury");
    const result = lastRender().context.result as typeof OXFORD_RESULT;
    expect(result.aiResponse.details.phone_number).toBe("01865 000000");
  });

  // GET IS A READ. Django's foodbank_check did five fetches and a Gemini call
  // in the GET (views.py:1138-1156); the whole point of WP 6.8's redesign is
  // that this one only ever reads admin_job. A snapshot of the entire table
  // either side of every GET shape this route has is the assertion that says
  // so -- including the debug ones, which are the branches most likely to
  // acquire a "mark it seen" write later.
  it("never writes, on any GET shape", async () => {
    seedJob({ id: "done-job", result: CHECK_RESULT, finished: T.sep06 });
    seedJob({ id: "queued-job", status: "queued", created: T.sep05 });
    const before = JSON.stringify(jobRows());

    await get("/admin/foodbank/salisbury/check/");
    await get("/admin/foodbank/salisbury/check/?job=done-job");
    await get("/admin/foodbank/salisbury/check/?job=done-job&debug=prompt");
    await get("/admin/foodbank/salisbury/check/?job=done-job&debug=json");
    await get("/admin/foodbank/salisbury/check/?job=no-such-job");
    await get("/admin/job/queued-job/");
    await get("/admin/job/done-job/");

    expect(JSON.stringify(jobRows())).toBe(before);
    expect(queueSend).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// GET -- what the template is handed
// ===========================================================================
describe("GET -- the render context", () => {
  it("renders the check template at 200 with the food bank from the URL", async () => {
    const res = await get("/admin/foodbank/salisbury/check/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(lastRender().template).toBe("admin/foodbank_check.njk");
    expect((lastRender().context.foodbank as { name: string; slug: string }).name).toBe("Salisbury Foodbank");
    expect((lastRender().context.foodbank as { slug: string }).slug).toBe("salisbury");
    // `section` is what admin/page.njk marks as the current nav item, and it
    // is the only thing in this context nothing else here would notice going
    // wrong: `adminPageContext(c, "dashboard")` renders a page that is
    // correct in every particular except that the admin is told they are
    // somewhere else. Every other check route passes "foodbanks" too.
    expect(lastRender().context.section).toBe("foodbanks");
  });

  // The stored JSON is parsed exactly once, here, and handed over whole --
  // foodbank_check.njk reads seven different top-level keys off it
  // (detailChanges, ourLocations, foundLocations, ourDonationPoints,
  // foundDonationPoints, fetchedPages, aiResponse), so a handler that passed
  // the raw string, or only the aiResponse, would render an empty comparison
  // table with no error anywhere.
  it("parses the stored result and hands the whole payload over on a done job", async () => {
    seedJob({ id: "done-job", result: CHECK_RESULT, finished: T.sep06 });

    await get("/admin/foodbank/salisbury/check/?job=done-job");

    expect(lastRender().context.result).toEqual(CHECK_RESULT);
  });

  // The three not-done states all render the SAME page with `result` null;
  // the template picks its branch from job.status. A `result` that survived
  // into the failed branch would be a stale payload from an earlier run
  // displayed beside a failure banner.
  //
  // The fixture stores a payload on a job that is NOT done, which the
  // consumer would never write (markAdminJobDone sets status and result in
  // one statement). That is the point: with an empty result column the
  // assertion holds even for a status-blind handler, because JSON.parse of a
  // NULL column answers null. Only a row carrying a payload can tell the two
  // apart.
  it.each(["queued", "running", "failed"] as const)("hands over a null result for a %s job", async (status) => {
    seedJob({ id: "job-x", status, result: CHECK_RESULT, error: status === "failed" ? "Gemini timed out" : null });

    await get("/admin/foodbank/salisbury/check/?job=job-x");

    expect(renderedJob()?.status).toBe(status);
    expect(lastRender().context.result).toBeNull();
  });

  it("passes a failed job's error through for the banner", async () => {
    seedJob({ id: "failed-job", status: "failed", error: "Gemini timed out", finished: T.sep06 });

    await get("/admin/foodbank/salisbury/check/?job=failed-job");

    expect(renderedJob()?.error).toBe("Gemini timed out");
  });

  // gfadmin/views.py:1321-1326's ALLOWED_FIELDS, in order. This list is not
  // decoration: it is the <dt> order down both halves of the comparison
  // table, the key set of the job's detailChanges, and the `<field>` segment
  // of the /use-ai/<field>/ URL each Use button posts to. useAi.ts holds its
  // own copy of the same ten and rejects anything else with a 400, so a name
  // that drifted here would render a button that always fails.
  const DJANGO_ALLOWED_FIELDS = [
    "phone_number",
    "contact_email",
    "charity_number",
    "facebook_page",
    "bankuet_slug",
    "rss_url",
    "news_url",
    "donation_points_url",
    "locations_url",
    "contacts_url",
  ];

  it("hands over Django's ten use-ai fields, in Django's order", async () => {
    await get("/admin/foodbank/salisbury/check/");

    expect(lastRender().context.use_ai_fields).toEqual(DJANGO_ALLOWED_FIELDS);
  });

  // check.html:48-67's hardcoded <dt> labels, as a parallel map. A missing
  // key renders an empty <dt> rather than raising -- nunjucks is configured
  // throwOnUndefined:false (packages/templates/src/env.ts) -- so "every field
  // has a label" has to be asserted rather than assumed.
  //
  // Asserted as the WHOLE map, not as "every key is present and truthy" plus
  // a spot check. That weaker pair survived two mutants worth having: a single
  // relabelled field (`phone_number: "Telephone"`), and a swapped PAIR
  // (rss_url labelled "News URL" and news_url "RSS URL"). The swap is the one
  // that matters -- both labels stay truthy, both keys stay present, and the
  // reviewer is shown the AI's proposed news URL under the heading "RSS URL"
  // with a Use button that writes it to the other column.
  it("labels every one of those fields, with Django's exact label text", async () => {
    await get("/admin/foodbank/salisbury/check/");

    const labels = lastRender().context.use_ai_labels as Record<string, string>;
    expect(Object.keys(labels)).toEqual(DJANGO_ALLOWED_FIELDS);
    expect(labels).toEqual({
      phone_number: "Phone",
      contact_email: "Email",
      charity_number: "Charity",
      facebook_page: "Facebook",
      bankuet_slug: "Bankuet",
      rss_url: "RSS URL",
      news_url: "News URL",
      donation_points_url: "Donation Points URL",
      locations_url: "Locations URL",
      contacts_url: "Contacts URL",
    });
  });

  // AN ARRAY, NOT A SET -- and the handler's own comment says why: nunjucks'
  // `in` operator falls back to JS `key in obj` for anything that is not an
  // array or a string, and `"rss_url" in new Set([...])` is false. The
  // template's new-window links (check.html:59-67) are gated on exactly that
  // test, so a Set here would silently drop every one of them. Instanceof is
  // the assertion because a Set would satisfy any membership check written
  // with `.includes`-style reasoning.
  it("hands the url fields over as a real array, which is what nunjucks' `in` needs", async () => {
    await get("/admin/foodbank/salisbury/check/");

    const urlFields = lastRender().context.url_fields;
    expect(Array.isArray(urlFields)).toBe(true);
    expect(urlFields).toEqual(["rss_url", "news_url", "donation_points_url", "locations_url", "contacts_url"]);
    // Every URL field must also be a use-ai field, or the template loops over
    // a name that has no row to attach the link to.
    for (const field of urlFields as string[]) expect(DJANGO_ALLOWED_FIELDS).toContain(field);
  });

  // The preview tab strip. The keys are workers/jobs' internal page names
  // (adminJobs/foodbankCheck.ts:118-128) and the values are Django's display
  // names (views.py:935-993); the handler's comment records that renaming
  // them job-side would orphan every stored result, so the mapping is the
  // seam and this is where it is pinned. A missing key renders the raw slug
  // ("shopping_list") in the tab, which is what it used to do.
  it("maps every fetched page name to its Django display label", async () => {
    await get("/admin/foodbank/salisbury/check/");

    expect(lastRender().context.page_labels).toEqual({
      homepage: "Home",
      shopping_list: "Shopping List",
      locations: "Locations",
      contacts: "Contacts",
      donation_points: "Donation Points",
    });
  });

  // check.html:19's `Last edit: {{ foodbank.edited|timesince }} ago`, computed
  // in the handler because there is no nunjucks timesince filter. Django's
  // timesince puts a non-breaking space inside each unit (avoid_wrapping) and
  // joins the two units with ", " -- asserted with the literal U+00A0 so a
  // "tidy-up" to a plain space is visible here rather than as a wrapped line
  // in the admin.
  it("computes the last-edit interval the way Django's timesince filter did", async () => {
    await get("/admin/foodbank/salisbury/check/");

    // Seeded 2026-09-05 07:15:00, frozen now 2026-09-07 09:20:00.
    expect(lastRender().context.foodbank_edited_timesince).toBe("2 days, 2 hours");
  });

  // A food bank that has never been edited. Django renders the whole "Last
  // edit" paragraph only when there is one (foodbank_check.njk:23 gates on
  // this value), and timesince(null) would be an epoch-relative nonsense
  // string rather than nothing at all.
  it("hands over null rather than an interval when the food bank was never edited", async () => {
    await get("/admin/foodbank/oxford/check/");

    expect(lastRender().context.foodbank_edited_timesince).toBeNull();
  });
});

// ===========================================================================
// ?debug= -- Django's two re-scraping debug views, folded onto this page
// ===========================================================================
describe("GET ?debug=", () => {
  beforeEach(() => {
    seedJob({ id: "done-job", result: CHECK_RESULT, finished: T.sep06 });
  });

  // gfadmin/views.py:1218-1222 foodbank_check_prompt returned the prompt as
  // text/plain. The port serves the STORED prompt instead of rebuilding it,
  // which is the whole saving -- Django re-ran the five scrapes to print a
  // string it had already computed. The render assertion is what proves the
  // short-circuit: the page is not rendered first and then discarded.
  it("serves the stored prompt as plain text, without rendering the page", async () => {
    const res = await get("/admin/foodbank/salisbury/check/?job=done-job&debug=prompt");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(await res.text()).toBe(CHECK_RESULT.prompt);
    expect(mocks.render).not.toHaveBeenCalled();
  });

  // views.py:1225-1238 foodbank_check_result returned the AI's response, not
  // the port's whole result envelope. `prompt` is many kilobytes of scraped
  // page text; emitting the envelope would bury the JSON the debug view
  // exists to show under it.
  it("serves the AI response as JSON -- the response, not the envelope", async () => {
    const res = await get("/admin/foodbank/salisbury/check/?job=done-job&debug=json");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual(CHECK_RESULT.aiResponse);
    expect(body.prompt).toBeUndefined();
    expect(body.detailChanges).toBeUndefined();
  });

  // The two debug links are rendered only inside the done branch
  // (foodbank_check.njk:59-60), but a URL survives a re-run in a bookmark or
  // a back button. Falling through to the page is what keeps that from
  // becoming a JSON.parse of a null result.
  //
  // The unfinished job is seeded WITH a payload, for the same reason as the
  // null-result test above: a debug branch that had lost its `status ===
  // "done"` guard would serve this prompt as text/plain, and only a row that
  // has one can catch that.
  it.each(["queued", "running", "failed"] as const)("ignores ?debug= while the job is %s and renders the page", async (status) => {
    seedJob({ id: "not-done", status, result: CHECK_RESULT, created: T.sep07late });

    const res = await get(`/admin/foodbank/salisbury/check/?job=not-done&debug=prompt`);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(lastRender().template).toBe("admin/foodbank_check.njk");
  });

  // `?debug=` sits BELOW the job lookup, not inside the `?job=` branch, so it
  // reads whatever job the page would have shown -- including the one the
  // fallback picked. That is the shape a hand-typed debug URL takes (the
  // rendered links carry `?job=`, but nobody types those), and every other
  // test in this block supplies an explicit id, so `if (jobId && job && ...)`
  // survived all of them.
  //
  // The two done checks are seeded with DIFFERENT payloads, and the newer
  // oxford row keeps the fallback's own filters honest: if this served the
  // older result, or another food bank's, the difference is a value in the
  // body rather than a shape.
  it("serves ?debug= against the fallback job when no ?job= is given", async () => {
    seedJob({ id: "older-done", result: OXFORD_RESULT, created: T.sep05, finished: T.sep05 });
    seedJob({ id: "newest-done", result: CHECK_RESULT, created: T.sep07early, finished: T.sep07early });
    seedJob({ id: "newer-oxford", target: "oxford", result: OXFORD_RESULT, created: T.sep07late, finished: T.sep07late });

    const res = await get("/admin/foodbank/salisbury/check/?debug=json");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(CHECK_RESULT.aiResponse);
  });

  it("ignores ?debug= when there is no job to read", async () => {
    const res = await get("/admin/foodbank/salisbury/check/?job=no-such-job&debug=json");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(renderedJob()).toBeNull();
  });

  // Only the two names Django had. An unrecognised value renders the page
  // rather than 400ing or serving the prompt by default -- pinned so that a
  // future `?debug=pages` is a deliberate addition and not something that has
  // already been silently answering.
  it("renders the page for a debug value it does not recognise", async () => {
    const res = await get("/admin/foodbank/salisbury/check/?job=done-job&debug=everything");

    expect(res.status).toBe(200);
    expect(lastRender().template).toBe("admin/foodbank_check.njk");
    expect(lastRender().context.result).toEqual(CHECK_RESULT);
  });

  // The debug branch reads `result.prompt` off whatever JSON the job stored,
  // and getAdminJob is not scoped by kind -- so the id of a done order-lines
  // job (orderForm.ts:375, the other producer of rows in this table) reaches
  // it and finds no such key. Pinned as it behaves today: a 200 with an empty
  // body rather than a 500 or a 404. Harmless, and worth knowing it is the
  // outcome, because the same unscoped lookup is what makes the cross-food-
  // bank case above dangerous.
  it("answers a foreign job's ?debug=prompt with an empty 200", async () => {
    seedJob({ id: "order-job", kind: "order-lines", target: "gf-1234", result: { lines: [{ item: "Beans" }] }, created: T.sep07late });

    const res = await get("/admin/foodbank/salisbury/check/?job=order-job&debug=prompt");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});

// ===========================================================================
// adminJobStatus -- the htmx poll target, shared by every admin_job kind
// ===========================================================================
describe("GET /admin/job/:id/", () => {
  it("404s an unknown job", async () => {
    const res = await get("/admin/job/no-such-job/");

    expect(res.status).toBe(404);
    expect(mocks.render).not.toHaveBeenCalled();
  });

  // Same claim as the POST's, for the poll: the id comes from the route
  // pattern and a query param of the same name is inert. htmx builds this URL
  // from the fragment's own hx-get, so a `c.req.query("id") ?? param` widening
  // would never show up in normal use -- it would just mean any admin_job's
  // state could be read by appending `?id=` to a job the reader does have.
  it("reads the job id from the path, not from a ?id= that disagrees", async () => {
    seedJob({ id: "mine", status: "running" });
    seedJob({ id: "someone-elses", target: "oxford", result: OXFORD_RESULT, finished: T.sep06 });

    const res = await get("/admin/job/mine/?id=someone-elses");

    expect(res.status).toBe(200);
    expect(res.headers.get("HX-Redirect")).toBeNull();
    expect((lastRender().context.job as AdminJobRow).id).toBe("mine");
  });

  // The fragment's markup has to match the page's own initial render of this
  // state byte for byte (job_status.njk's header comment says why: an
  // outerHTML swap that restyles itself every 2 seconds), which is a claim
  // about the template. What the HANDLER owes it is the job -- with the kind,
  // which is how the fragment picks between its two shells.
  it.each(["queued", "running"] as const)("keeps polling while the job is %s", async (status) => {
    seedJob({ id: "job-1", status });

    const res = await get("/admin/job/job-1/");

    expect(res.status).toBe(200);
    expect(res.headers.get("HX-Redirect")).toBeNull();
    expect(lastRender().template).toBe("admin/includes/job_status.njk");
    expect((lastRender().context.job as AdminJobRow).status).toBe(status);
    expect((lastRender().context.job as AdminJobRow).kind).toBe("check");
  });

  // Done: stop polling and send the browser back to the check page, which
  // renders the result in one place rather than duplicating that rendering
  // into the fragment. The body must be empty -- htmx acts on the header, and
  // anything in the body would be swapped in on the way out.
  it("redirects a finished check back to its own page, carrying the job id", async () => {
    seedJob({ id: "done-job", result: CHECK_RESULT, finished: T.sep06 });

    const res = await get("/admin/job/done-job/");

    expect(res.status).toBe(200);
    expect(res.headers.get("HX-Redirect")).toBe("/admin/foodbank/salisbury/check/?job=done-job");
    expect(await res.text()).toBe("");
    expect(mocks.render).not.toHaveBeenCalled();
  });

  // A failure goes to the SAME place, not to an error page: foodbank_check
  // .njk:50-55 is where the reviewer sees the message and the Retry button.
  it("redirects a failed check to the same page, where the error and Retry live", async () => {
    seedJob({ id: "failed-job", status: "failed", error: "Gemini timed out", finished: T.sep06 });

    const res = await get("/admin/job/failed-job/");

    expect(res.headers.get("HX-Redirect")).toBe("/admin/foodbank/salisbury/check/?job=failed-job");
  });

  // THE ROUND TRIP, end to end through the real router: poll, follow the
  // header the poll returned, and land on the result. A redirect target that
  // dropped `?job=` would still 200 here -- and would show whatever the
  // LATEST check happened to be, which for a re-run tab is the wrong one.
  it("sends the poll to a URL that really does render that job's result", async () => {
    seedJob({ id: "older", result: OXFORD_RESULT, created: T.sep05 });
    seedJob({ id: "done-job", result: CHECK_RESULT, created: T.sep06, finished: T.sep06 });
    seedJob({ id: "newer", status: "queued", created: T.sep07late });

    const poll = await get("/admin/job/done-job/");
    const followed = await get(poll.headers.get("HX-Redirect")!);

    expect(followed.status).toBe(200);
    expect(renderedJob()?.id).toBe("done-job");
    expect(lastRender().context.result).toEqual(CHECK_RESULT);
  });

  // SUSPECT (reported, not fixed): every kind that is not "check" is sent to
  // /admin/ instead of back to where it was being watched. The other producer
  // in this table is orderForm.ts:375's "order-lines", whose `target` holds
  // the very order id the redirect would need -- and admin/order.njk:21-23
  // polls this endpoint from the order page. So an admin who saves an order
  // and waits for its lines to parse is thrown to the dashboard the moment it
  // finishes. Pinned as it stands.
  it("sends every other kind to the dashboard, even though target names the page it came from", async () => {
    seedJob({ id: "order-job", kind: "order-lines", target: "gf-1234-tesco-2026-09-07", result: { lines: [] }, finished: T.sep06 });

    const res = await get("/admin/job/order-job/");

    expect(res.headers.get("HX-Redirect")).toBe("/admin/");
    // The value that would have made a page-specific redirect possible is
    // right there on the row.
    expect(jobRow("order-job")?.target).toBe("gf-1234-tesco-2026-09-07");
  });

  it("writes nothing, whatever state the job is in", async () => {
    seedJob({ id: "queued-job", status: "queued", created: T.sep05 });
    seedJob({ id: "running-job", status: "running", created: T.sep06 });
    seedJob({ id: "done-job", result: CHECK_RESULT, created: T.sep07early, finished: T.sep07early });
    seedJob({ id: "failed-job", status: "failed", error: "nope", created: T.sep07late, finished: T.sep07late });
    const before = JSON.stringify(jobRows());

    for (const id of ["queued-job", "running-job", "done-job", "failed-job"]) await get(`/admin/job/${id}/`);

    expect(JSON.stringify(jobRows())).toBe(before);
    expect(queueSend).not.toHaveBeenCalled();
  });
});
