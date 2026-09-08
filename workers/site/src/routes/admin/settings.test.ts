import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "@givefood/db/src/schema.testkit";
import { FRAG_KV_KEY_LAST_UPDATED, FRAG_KV_KEY_NEED_HITS } from "@givefood/db";
// Namespace import purely so ONE test can watch the render boundary with a
// call-through spy -- see "hands the template a narrowed cache_result". The
// handler still calls the real Nunjucks renderer; nothing here is a stub.
import * as templates from "@givefood/templates";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/admin/settings.ts -- /admin/settings/, ported from gfadmin/views.py's
// settings() (2747-2764).
//
// THE HANDLER IS A LINK HUB WITH ONE PIECE OF ARITHMETIC IN IT, and both
// halves fail silently, which is why this file exists at all:
//
//   - THE LINKS. Sixteen <a href>s and two forms of its own, hand-written into
//     settings.njk as literal strings rather than through @givefood/urls'
//     reverse()-equivalent. Rename a route in routes/admin/index.ts and this
//     page still renders a perfect 200; the maintainer finds out by clicking.
//     That is issue #34's shape (a Place ID parsed, passed down, written by no
//     SQL, redirected as though it had worked) transposed onto a read-only
//     page: everything reports success, nothing is delivered. So every href on
//     the page is FETCHED here, from the same app, rather than compared as a
//     string.
//   - THE QUARTER DATES. The "Dated Stats" form is pre-filled with the current
//     calendar quarter so that "this quarter's numbers" is one click. A
//     quarter boundary computed one month out still renders two plausible
//     dates in two date inputs, the report still comes back 200, and the
//     figures are simply for the wrong three months. Nothing anywhere says so.
//     So the range is asserted at every month boundary, and the form is
//     SUBMITTED to the page it targets rather than merely inspected.
//
// REAL EVERYTHING, following map.test.ts next door: the production app
// (workers/site/src/index.ts's default export -- the same object the Worker
// runs), so the real mount, the real requireAdminAuth gate, the real
// APPEND_SLASH fallback and the real no-store middleware are all in the path;
// real Nunjucks templates; real in-memory SQLite built from the real
// migrations. Mocked: only what leaves the machine or has no local
// implementation -- the SESSIONS/DATA KV namespaces (Maps) and global fetch,
// which is stubbed to THROW because this page must make no outbound call.
//
// NOT REPEATED HERE: clearCache.test.ts already drives each of the four
// ?cache= outcomes out of adminClearCache and follows the redirect into this
// page's banner. What this file adds from the settings side is the other
// direction -- that the allowlist admits those four values and NOTHING else,
// and that the Clear Cache button on THIS page, carrying the token THIS page
// minted, is actually accepted when pressed.
//
// MUTATION-TESTED (TESTING.md's "some suites were mutation-tested"), on the
// arithmetic, in a scratchpad rather than in the repo: eight plausible wrong
// spellings of currentQuarterRange were run over the 27 dates the quarter
// tests below actually sample, and each was compared against the CPython
// transcript described at QUARTER_OF_MONTH. Seven differ on at least six of
// those dates and so fail here -- the quarter computed without its `+ 1`, the
// month read as 1-indexed the way Django's is, the end taken as day 1 of the
// next quarter, the end taken from startMonth + 2, Q4's end written as month
// 12 rather than 11, the start taken as day 0, and start/end transposed. The
// eighth SURVIVES and is meant to: dropping the `quarter === 4` branch
// entirely produces identical output, because day 0 of month 12 is 31
// December. The source comment (settings.ts:15-18) says exactly that and keeps
// the branch anyway so the port reads against Django's original, so this file
// does not pretend to pin a difference that does not exist.
//
// REVIEWED ADVERSARIALLY on 2026-09-07, by RUNNING the mutants rather than
// reading for them: 46 deliberate breakages applied one at a time to a copy of
// the repo in a scratchpad -- settings.ts, routes/admin/index.ts,
// clearCache.ts, pageContext.ts, lib/csrf.ts, index.ts's middleware mounts,
// and settings.njk itself. (The template half needs saying out loud: rendering
// goes through packages/templates/src/generated/precompiled.js, NOT the .njk on
// disk, so a harness that edits only the template proves nothing -- five
// template mutants "survived" a first pass purely because they were never
// compiled in. Each one is re-precompiled inside the copy before the suite
// runs.) Eight survived. One is the deliberate Q4 case above; one -- the
// footer's render_time_ms -- belongs to pageContext.test.ts. The other six were
// real holes, and each is now killed by a test that names it as MUTANT:
//   - the ?cache= allowlist deleted, and the same allowlist widened to a
//     prefix match  ->  "hands the template a narrowed cache_result"
//   - clearCache no longer deleting the frag KV keys, and clearCache writing
//     the cooldown marker on every outcome  ->  "mints a token the purge
//     endpoint accepts"
//   - verifyCsrf without its double-submit comparison, and verifyCsrf without
//     its Origin comparison  ->  "refuses the same POST when the token is
//     missing, wrong, or from another origin"

const ORIGIN = "https://www.givefood.org.uk";
const SESSION_ID = "test-admin-session-id";
const ADMIN_EMAIL = "someone@givefood.org.uk";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

type Bindable = null | number | bigint | string | Uint8Array;

// The D1PreparedStatement surface packages/db uses, over node:sqlite -- the
// same shim map.test.ts, clearCache.test.ts and donationPoint.test.ts use. D1
// is async and node:sqlite synchronous; the SQL text, the binding and the NULL
// semantics are SQLite's on both sides.
//
// `log` records every statement prepared and the counter below every
// withSession() call, because for THIS handler the load-bearing assertion is
// that both stay empty on the settings page itself: Django's settings() view
// touches no ORM, and a port that quietly grew a query would be running it on
// every visit to a page made entirely of static links.
function d1Session(db: DatabaseSync, log: string[]): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    sql,
    params,
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  type FakeStatement = ReturnType<typeof statement>;
  return {
    prepare: (sql: string) => {
      log.push(sql);
      return statement(sql, []);
    },
    // The stats pages the hub links to send their SELECTs as one batch
    // (packages/db/src/adminStats.ts:47), so the link-following test below
    // needs it even though the settings page itself issues nothing. Same
    // implementation as search.test.ts's.
    batch: async (batched: FakeStatement[]) =>
      batched.map((one) => ({ results: db.prepare(one.sql).all(...one.params), success: true, meta: {} })),
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let statements: string[];
let withSessionCalls: number;
let kv: Map<string, string>;
let kvWrites: string[];
let sessionKv: Map<string, string>;
let fetchMock: ReturnType<typeof vi.fn>;

function env(overrides: Record<string, unknown> = {}): AppEnv["Bindings"] {
  return {
    DB: {
      withSession: () => {
        withSessionCalls++;
        return d1Session(db, statements);
      },
    },
    SESSIONS: {
      get: async (key: string) => sessionKv.get(key) ?? null,
      put: async (key: string, value: string) => void sessionKv.set(key, value),
      delete: async (key: string) => void sessionKv.delete(key),
    },
    DATA: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => {
        kvWrites.push(key);
        kv.set(key, value);
      },
      delete: async (key: string) => {
        kvWrites.push(key);
        kv.delete(key);
      },
    },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    GMAP_STATIC_KEY: "gmap-static-key-not-a-real-one",
    GMAP_GEOCODE_KEY: "gmap-geocode-key-not-a-real-one",
    SITE_DOMAIN: ORIGIN,
    ...overrides,
  } as unknown as AppEnv["Bindings"];
}

/** A live admin session, exactly as lib/adminAuth.ts createSession() writes
 *  one. `expiresAt` is a full TTL from whatever "now" currently is -- which
 *  matters because half this file runs under a faked clock: seeded from the
 *  real clock and then read from 2027, getAdminSession's sliding refresh would
 *  fire and add an incidental SESSIONS.put to every request. */
function seedSession(): void {
  sessionKv.set(
    `admin-session:${SESSION_ID}`,
    JSON.stringify({ email: ADMIN_EMAIL, name: "Some One", givenName: "Some", picture: "", expiresAt: Date.now() + SESSION_TTL_MS }),
  );
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  statements = [];
  withSessionCalls = 0;
  kv = new Map();
  kvWrites = [];
  sessionKv = new Map();
  seedSession();
  // Nothing on this page may leave the machine. An outbound call added here
  // fails loudly rather than silently costing a subrequest on every visit to
  // the admin's most-used page.
  fetchMock = vi.fn(async (input: unknown) => {
    throw new Error(`unmodelled fetch: ${String(input)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

interface Fetched {
  res: Response;
  body: string;
}

interface RequestOptions {
  method?: string;
  signedIn?: boolean;
  /** The signed `__Host-csrf` value a browser would already be holding from an
   *  earlier admin page -- the returning-visitor path, which lib/csrf.ts
   *  treats completely differently from a first visit. */
  csrfCookie?: string;
  body?: string;
  /** Overrides the same-origin `Origin` a form POST carries by default; `null`
   *  omits the header. The only way to reach verifyCsrf's cross-origin
   *  refusal, which is otherwise unreachable from this harness because every
   *  POST it builds looks same-origin. */
  origin?: string | null;
  /** Same, for `Sec-Fetch-Site`. Defaults to whatever `origin` implies.
   *  Settable independently because verifyCsrf judges on EITHER, and a test
   *  that sends both cannot tell which one refused. */
  secFetchSite?: string | null;
  env?: Record<string, unknown>;
}

/** A request through the production app, signed in as an admin by default. */
async function request(path: string, opts: RequestOptions = {}): Promise<Fetched> {
  const headers: Record<string, string> = {};
  const cookies: string[] = [];
  if (opts.signedIn !== false) cookies.push(`__Host-gfsession=${SESSION_ID}`);
  if (opts.csrfCookie) cookies.push(`__Host-csrf=${opts.csrfCookie}`);
  if (cookies.length) headers.Cookie = cookies.join("; ");
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    const origin = opts.origin === undefined ? ORIGIN : opts.origin;
    const fetchSite = opts.secFetchSite === undefined ? (origin === ORIGIN ? "same-origin" : "cross-site") : opts.secFetchSite;
    if (origin !== null) headers.Origin = origin;
    if (fetchSite !== null) headers["Sec-Fetch-Site"] = fetchSite;
  }
  const res = await app.fetch(
    new Request(`${ORIGIN}${path}`, { method: opts.method ?? "GET", headers, body: opts.body }),
    env(opts.env),
    execCtx,
  );
  return { res, body: await res.text() };
}

const getSettings = (query = ""): Promise<Fetched> => request(`/admin/settings/${query}`);

/** The signed `__Host-csrf` cookie value a response hands the browser. */
function csrfCookieFrom(res: Response): string {
  const value = res.headers.get("Set-Cookie")?.match(/__Host-csrf=([^;]+)/)?.[1];
  if (!value) throw new Error("response set no __Host-csrf cookie");
  return value;
}

/** The raw token the page rendered into its Clear Cache form -- the other half
 *  of the double submit, and the thing a browser would actually post back. */
function csrfFieldFrom(html: string): string {
  const value = html.match(/<input type="hidden" name="csrf_token" value="([^"]*)">/)?.[1];
  if (!value) throw new Error("page rendered no csrf_token field");
  return value;
}

/** The two dates the "Dated Stats" form is pre-filled with, read out of the
 *  rendered inputs exactly as the browser would submit them. */
function datedStats(html: string): { start: string | undefined; end: string | undefined } {
  return {
    start: html.match(/<input type="date" name="start" value="([^"]*)"/)?.[1],
    end: html.match(/<input type="date" name="end" value="([^"]*)"/)?.[1],
  };
}

/** The DANGER ZONE banner as a human reads it: its Bulma colour and its text,
 *  entity-decoded and tag-stripped. */
function banner(html: string): { kind: string; text: string } | null {
  const match = html.match(/<div class="notification is-([a-z]+) is-light">([\s\S]*?)<\/div>/);
  if (!match) return null;
  return {
    kind: match[1]!,
    text: match[2]!
      .replace(/<[^>]+>/g, "")
      .replace(/&mdash;/g, "—")
      .replace(/\s+/g, " ")
      .trim(),
  };
}

/** Every `/admin/` href inside the page's own <ul class="settings"> blocks --
 *  i.e. the hub's links, and not the eight nav items page.njk renders above
 *  them or anything in the footer. */
function hubLinks(html: string): string[] {
  const links: string[] = [];
  for (const block of html.matchAll(/<ul class="settings">([\s\S]*?)<\/ul>/g)) {
    for (const href of block[1]!.matchAll(/href="([^"]+)"/g)) links.push(href[1]!);
  }
  return links;
}

/** Runs `fn` with the system clock pinned to midday UTC on `isoDate`.
 *
 *  Date only -- `toFake: ["Date"]` leaves setTimeout and friends real, because
 *  the app's own async work (template rendering, the KV shims) must still
 *  settle while the clock is held still. Midday rather than midnight so that a
 *  test failure can never be an off-by-one hour rather than the off-by-one
 *  month it is looking for. */
async function atDate(isoDate: string, fn: () => Promise<void>): Promise<void> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${isoDate}T12:00:00.000Z`));
  seedSession(); // re-stamped against the faked clock -- see seedSession's note
  try {
    await fn();
  } finally {
    vi.useRealTimers();
  }
}

// ---------------------------------------------------------------------------
// Getting to the page at all -- the mount, the gate, the method
// ---------------------------------------------------------------------------

describe("adminSettings -- reaching the page", () => {
  it("renders for a signed-in admin", async () => {
    const { res, body } = await getSettings();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(body).toContain("<h2>Settings</h2>");
  });

  // requireAdminAuth is applied to adminApp as a whole (routes/admin/index.ts:
  // 85), so this is a test of the MOUNT as much as of the middleware. This
  // particular page is the admin's index of everything dangerous -- the Clear
  // Cache button, the Query Console, the subscriber list -- and the nav it
  // renders leaks the signed-in admin's email address.
  it("sends an unauthenticated visitor to sign in, and renders nothing", async () => {
    const { res, body } = await request("/admin/settings/", { signedIn: false });

    expect(res.status).toBe(302);
    // The path travels as a query param, so the admin lands back on Settings
    // after Google rather than on /admin/.
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fsettings%2F");
    expect(body).not.toContain("DANGER ZONE");
    expect(body).not.toContain(ADMIN_EMAIL);
    // adminPageContext mints a CSRF token for every page it builds, and that
    // token is what the Clear Cache button submits. A gate that ran AFTER the
    // handler would show up here as a token issued to an anonymous request.
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  // A DELIBERATE NARROWING, not parity. routes/admin/index.ts:91 is
  // `adminApp.get(...)`, singular, so a POST 404s. Django's urls/core.py:12 is
  // a plain function view with no require_POST and no method branch, and
  // CsrfViewMiddleware is COMMENTED OUT at givefood/settings.py:97, so a POST
  // there rendered the page and returned 200. Asserted with a VALID session,
  // so the 404 proves the route is absent rather than that the gate fired
  // first.
  it("is registered on GET only, so a POST never reaches the handler", async () => {
    const { res, body } = await request("/admin/settings/", { method: "POST", body: "" });

    expect(res.status).toBe(404);
    expect(body).not.toContain("DANGER ZONE");
  });

  // gfadmin is included at givefood/urls.py:97, OUTSIDE i18n_patterns, so
  // /cy/admin/settings/ resolves to nothing in Django and must resolve to
  // nothing here. It matters beyond tidiness: index.ts:137-138 registers
  // noStore for "/admin" and "/admin/*" and nothing for "/:locale/admin/*", so
  // a locale-prefixed twin would be an admin page carrying an admin's email
  // and a CSRF cookie WITHOUT the no-store header -- the exact shape of the
  // beta incident middleware/noStore.ts's header records.
  it("has no locale-prefixed twin", async () => {
    expect((await request("/cy/admin/settings/")).res.status).toBe(404);
    // Not even via the APPEND_SLASH fallback, which 301s /admin/settings.
    expect((await request("/cy/admin/settings")).res.status).toBe(404);
  });

  // PLAN.md §3.5 APPEND_SLASH, via index.ts's app.notFound(). Django ran with
  // APPEND_SLASH for a decade, so the slash-less form is what a maintainer's
  // muscle memory and browser history will produce. A 301, not a rewrite,
  // exactly as Django's.
  it("301s the slash-less URL to the canonical one", async () => {
    const { res } = await request("/admin/settings");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/admin/settings/`);
  });

  // adminPageContext issues a CSRF token on every admin page, so this response
  // carries a per-visitor __Host-csrf cookie -- and middleware/noStore.ts's own
  // header records the beta 2026-09-02 incident in which admin pages were
  // served from Cloudflare's cache to anonymous visitors WITHOUT the Worker
  // (and therefore requireAdminAuth) ever running.
  it("is never stored by any cache", async () => {
    const { res } = await getSettings();

    expect(res.headers.get("Set-Cookie")).toContain("__Host-csrf=");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("Cache-Control")).toContain("private");
    expect(res.headers.get("CDN-Cache-Control")).toBe("no-store");
    expect(res.headers.get("Vary")).toContain("Cookie");
  });

  // THE RETURNING-VISITOR PATH. lib/csrf.ts's issueCsrfToken has two return
  // paths and both have already caused an incident: minting unconditionally
  // REPLACED the cookie on every admin render, so glancing at Settings in a
  // second tab invalidated the edit form open in the first (403 on Save, every
  // typed value gone); and the reuse path that fixed it sends no Set-Cookie,
  // which middleware/pageCacheControl.ts had been keying its per-visitor guard
  // on, so a returning admin's page was stamped `public, s-maxage=86400` and
  // served to everyone else. Settings is exactly the page an admin bounces off
  // mid-edit, so both halves are asserted rather than assumed.
  it("reuses an existing CSRF cookie and stays uncacheable on the visit that sets none", async () => {
    const held = csrfCookieFrom((await getSettings()).res);

    const { res } = await request("/admin/settings/", { csrfCookie: held });

    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("Cache-Control")).toContain("private");
    expect(res.headers.get("CDN-Cache-Control")).toBe("no-store");
  });
});

// ---------------------------------------------------------------------------
// A GET that changes nothing
// ---------------------------------------------------------------------------

describe("adminSettings -- a GET that mutates nothing", () => {
  // Django's settings() touches no ORM at all: it computes two dates and
  // renders. The port must not have grown a query on the way, and this is the
  // only form "GET does not mutate" can take for a handler with no write path
  // -- it must not even open a session.
  it("opens no database session, issues no SQL and writes nothing to KV", async () => {
    const { res } = await getSettings();

    expect(res.status).toBe(200);
    expect(withSessionCalls).toBe(0);
    expect(statements).toEqual([]);
    expect(kvWrites).toEqual([]);
  });

  it("makes no outbound request of its own", async () => {
    await getSettings();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // THE ?cache= BANNER IS A REPORT, NOT AN ACTION. The value arrives on a GET,
  // from a querystring anyone can type or link to, and it names a cache purge.
  // If rendering the banner ever came to imply performing the purge, a link
  // prefetcher following /admin/settings/?cache=purged out of an admin's
  // history would evict the whole site's cache -- which is precisely the
  // GET-mutation hole clearCache.ts:45 says the port closes by making the
  // button a POST. The two frag keys are seeded and read back to prove the
  // page left them alone.
  it("does not purge anything when asked to render the purged banner", async () => {
    kv.set(FRAG_KV_KEY_LAST_UPDATED, "2019-01-01T00:00:00");
    kv.set(FRAG_KV_KEY_NEED_HITS, "11");

    const { res, body } = await getSettings("?cache=purged");

    expect(res.status).toBe(200);
    expect(banner(body)?.text).toBe("Cache purged.");
    expect(kvWrites).toEqual([]);
    expect(kv.get(FRAG_KV_KEY_LAST_UPDATED)).toBe("2019-01-01T00:00:00");
    expect(kv.get(FRAG_KV_KEY_NEED_HITS)).toBe("11");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The quarter range -- the only thing this view computes
// ---------------------------------------------------------------------------

// Django's own arithmetic (views.py:2749-2757), run in CPython over every day
// of 2024-2027 and compared against the port's currentQuarterRange -- 1,461
// days, no mismatches. TESTING.md's rule: a parity claim is checked by running
// Python, not by reasoning about it. The table below is the result, expressed
// as the month-to-quarter mapping a reader can check by eye; the sweep further
// down walks the first and last day of all twelve months against it, which is
// where an off-by-one in `Math.floor(month / 3) + 1` or in the day-0
// end-of-quarter trick actually shows up.
//
// The one thing this cannot check by running Python is the clock the two
// implementations read. Django's `date.today()` is the PROCESS-LOCAL date;
// the port reads getUTCFullYear/getUTCMonth explicitly. They agree only
// because both run under UTC -- givefood/settings.py:210 is TIME_ZONE = "UTC"
// with USE_TZ = False, the deployment pins TZ to UTC, the Workers runtime is
// UTC by construction, and vitest.config.mts pins TZ=UTC for this suite. The
// port's spelling is the more robust of the two; the note is here so that
// "why UTC?" has an answer that is not "it looked tidier".
const QUARTER_OF_MONTH: [string, string][] = [
  ["01-01", "03-31"], // January
  ["01-01", "03-31"], // February
  ["01-01", "03-31"], // March
  ["04-01", "06-30"], // April
  ["04-01", "06-30"], // May
  ["04-01", "06-30"], // June
  ["07-01", "09-30"], // July
  ["07-01", "09-30"], // August
  ["07-01", "09-30"], // September
  ["10-01", "12-31"], // October
  ["10-01", "12-31"], // November
  ["10-01", "12-31"], // December
];

/** The last day of `month` (1-indexed) in `year`, computed independently of
 *  the handler's own day-0 trick so the sweep's dates are not derived from the
 *  thing under test. */
function lastDayOfMonth(year: number, month: number): number {
  return [31, (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

describe("adminSettings -- the pre-filled quarter", () => {
  // The whole sweep in one test: 24 renders, the first and last day of every
  // month of a non-leap year. A quarter boundary drawn one month out still
  // produces two plausible dates in two date inputs and a report that comes
  // back 200 -- for the wrong three months, with nothing to see. The last-day
  // half is what kills the off-by-one: on 31 March the handler must still say
  // Q1, and on 1 April it must have moved on.
  it("gives every month of the year Django's quarter", async () => {
    for (let month = 1; month <= 12; month++) {
      const [start, end] = QUARTER_OF_MONTH[month - 1]!;
      const mm = String(month).padStart(2, "0");
      for (const day of [1, lastDayOfMonth(2026, month)]) {
        const dd = String(day).padStart(2, "0");
        await atDate(`2026-${mm}-${dd}`, async () => {
          const { body } = await getSettings();
          expect(datedStats(body)).toEqual({ start: `2026-${start}`, end: `2026-${end}` });
        });
      }
    }
  });

  // The four boundary days that matter most, spelled out individually so a
  // failure names the quarter rather than a loop index -- and so the Q4
  // special case (Django hardcodes December 31 because month 13 does not
  // exist; the port keeps the branch explicit) has a test of its own.
  it("turns over on the first day of each quarter", async () => {
    const boundaries: [string, string, string][] = [
      ["2026-01-01", "2026-01-01", "2026-03-31"],
      ["2026-04-01", "2026-04-01", "2026-06-30"],
      ["2026-07-01", "2026-07-01", "2026-09-30"],
      ["2026-10-01", "2026-10-01", "2026-12-31"],
    ];
    for (const [today, start, end] of boundaries) {
      await atDate(today, async () => {
        expect(datedStats((await getSettings()).body)).toEqual({ start, end });
      });
    }
  });

  // New Year's Eve, which is both the Q4 special case and the year rollover:
  // the range must stay inside 2026 and not borrow January's from 2027.
  it("stays inside the year on 31 December", async () => {
    await atDate("2026-12-31", async () => {
      expect(datedStats((await getSettings()).body)).toEqual({ start: "2026-10-01", end: "2026-12-31" });
    });
    await atDate("2027-01-01", async () => {
      expect(datedStats((await getSettings()).body)).toEqual({ start: "2027-01-01", end: "2027-03-31" });
    });
  });

  // 29 February exists in exactly one year in four and is the day a naive
  // `new Date(year, month, day)` arithmetic slips. The quarter it falls in has
  // no February boundary of its own, so the answer is simply Q1 -- asserted
  // because the way to get it wrong is to compute the START by counting days
  // rather than by naming a month.
  it("handles a leap day", async () => {
    await atDate("2024-02-29", async () => {
      expect(datedStats((await getSettings()).body)).toEqual({ start: "2024-01-01", end: "2024-03-31" });
    });
  });

  // THE FORM IS SUBMITTED, not just read. The two values are pre-filled into
  // <input type="date"> and posted -- as a GET -- to a route that parses them
  // with parseIsoDate and answers 400 for anything it cannot read
  // (stats.ts:96-98, where Django instead handed the raw value to strptime and
  // 500ed). YYYY-MM-DD is also the only format an <input type="date"> will
  // accept as its own value: anything else and the browser renders the picker
  // EMPTY, so a wrong prefill is invisible in the HTML and shows up only as
  // two blank boxes on the page.
  //
  // The second half of the test is what makes the first mean something: a
  // plausible-looking DD/MM/YYYY really is rejected, so the 200 above is
  // evidence about the format rather than about the route being lenient.
  it("pre-fills dates the stats page it targets actually accepts", async () => {
    await atDate("2026-05-20", async () => {
      const { body } = await getSettings();
      const { start, end } = datedStats(body);
      expect([start, end]).toEqual(["2026-04-01", "2026-06-30"]);
      expect(body).toContain('<form action="/admin/stats/quarter/" method="get">');

      const submitted = await request(`/admin/stats/quarter/?start=${start}&end=${end}`);
      expect(submitted.res.status).toBe(200);
      expect(submitted.body).toContain("Start Date");
      // AND THE REPORT IS FOR THOSE DATES. A 200 is not evidence of that:
      // adminQuarterStats could ignore both parameters, or read them under
      // other names, and still render a full page of plausible figures for
      // whatever range it defaulted to -- the read-only twin of issue #34.
      // stats.ts:120-121 echoes them back through Django's "N j, Y".
      expect(submitted.body).toContain("April 1, 2026");
      expect(submitted.body).toContain("June 30, 2026");

      const wrongFormat = await request("/admin/stats/quarter/?start=01%2F04%2F2026&end=30%2F06%2F2026");
      expect(wrongFormat.res.status).toBe(400);
    });
  });
});

// ---------------------------------------------------------------------------
// The ?cache= allowlist
// ---------------------------------------------------------------------------

describe("adminSettings -- the cache-purge banner", () => {
  // The four values clearCache.ts redirects with, each mapped to the banner
  // settings.njk:75-86 renders for it. Three independent lists have to agree
  // (the handler's Outcome type, this allowlist, the template's if/elif
  // chain); drop or rename a value on any one of them and the admin presses
  // Clear Cache, gets a redirect, and sees NOTHING -- no confirmation, no
  // error, no way to tell a purge from a rate-limited no-op. clearCache.test.ts
  // asserts the same four from the other end; this is the settings-side half,
  // including the Bulma colour, which is the only thing distinguishing "done"
  // from "did not happen" at a glance.
  const outcomes: [string, string, string][] = [
    ["purged", "success", "Cache purged."],
    [
      "purged-kv-only",
      "warning",
      "Cleared the KV fragments, but the CDN cache was not purged: CF_API_KEY / CF_ZONE_ID are not set on this Worker.",
    ],
    ["cooldown", "warning", "Not purged — a purge already ran in the last minute."],
    ["failed", "danger", "Cloudflare rejected the purge. Check the Worker logs."],
  ];

  for (const [value, kind, text] of outcomes) {
    it(`renders the ${value} banner`, async () => {
      const { res, body } = await getSettings(`?cache=${value}`);

      expect(res.status).toBe(200);
      expect(banner(body)).toEqual({ kind, text });
    });
  }

  it("renders no banner at all on a plain visit", async () => {
    const { body } = await getSettings();

    expect(banner(body)).toBeNull();
    // The absence is asserted against the words too, in case a banner ever
    // moves out of the <div class="notification"> this file matches on.
    expect(body).not.toContain("Cache purged.");
    expect(body).not.toContain("Cloudflare rejected the purge");
  });

  // Every one of these is a value that would sail through a laxer check -- a
  // prefix, a suffix, a case fold, a near-miss -- and each must produce the
  // same page as no ?cache= at all.
  //
  // WHAT THIS DOES AND DOES NOT PIN, stated plainly because the obvious
  // reading is wrong. settings.ts:27's allowlist is not observable through
  // this page: settings.njk only ever COMPARES cache_result, never prints it,
  // so deleting the allowlist entirely would render exactly the same HTML for
  // every value below. The allowlist is defence in depth for a template that
  // one day does print it, and the handler's own comment says so. What these
  // cases really pin is the TEMPLATE's four-way comparison -- that it is an
  // equality chain and not a truthiness test or a lowercased/prefix match,
  // any of which would put a green "Cache purged." banner in front of an
  // admin who had purged nothing. (Confirmed by mutation, both ways round:
  // rewriting the {% elif cache_result == "cooldown" %} arm as a bare
  // {% elif cache_result %} fails here, and deleting the handler's allowlist
  // does not -- which is what the next test is for.)
  //
  // "purged " and " purged" are the pair worth understanding: a querystring
  // carries whitespace perfectly well, nothing in the chain trims, and a
  // redirect built with a stray space would silently produce a purge with no
  // confirmation. They are here as the shape of that failure, not as a hazard
  // anyone has hit.
  it.each(["PURGED", "Purged", "purged ", " purged", "purge", "purgedx", "purged-kv", "purged-kv-only-really", "", "null", "undefined"])(
    "ignores %j",
    async (value) => {
      const { res, body } = await getSettings(`?cache=${encodeURIComponent(value)}`);

      expect(res.status).toBe(200);
      expect(banner(body)).toBeNull();
    },
  );

  // THE ALLOWLIST ITSELF, asserted at the only place it is observable.
  //
  // The comment above says this page's HTML cannot pin settings.ts:36's
  // narrowing. That is true, and mutation proved it rather than assuming it:
  // TWO MUTANTS SURVIVED every other test in this file --
  //   - the allowlist deleted outright (`cache_result: rawCache ?? null`)
  //   - the allowlist widened to a prefix match, which admits "purged " and
  //     "purged-kv-only-really"
  // -- because the template only ever compares, so the bytes on the wire are
  // identical either way.
  //
  // That is a reason to test it somewhere else, not a reason to leave it
  // untested. The handler's own comment (settings.ts:24-26) states the intent
  // -- "the querystring is attacker-controllable, and nothing arbitrary should
  // reach the template context" -- and the guard's entire value is realised on
  // the day someone adds `{{ cache_result }}` to settings.njk. If the
  // narrowing has been quietly gone for six months by then, that one-line
  // template edit is a reflected-XSS sink and this file said nothing.
  //
  // So this is the one test here that watches the boundary rather than the
  // page: vi.spyOn with NO mock implementation, so the real Nunjucks render
  // still runs, the real HTML still comes back, and the assertions are made on
  // the context that was actually handed over. Nothing is faked, and the
  // status check below keeps it honest -- a spy that stopped intercepting
  // would fail on the missing call, not pass on an empty one.
  it("hands the template a narrowed cache_result, never the raw querystring", async () => {
    const rendered = vi.spyOn(templates, "render");
    try {
      const contextFor = async (query: string): Promise<Record<string, unknown>> => {
        rendered.mockClear();
        const { res } = await getSettings(query);
        expect(res.status).toBe(200);
        const call = rendered.mock.calls.find(([name]) => name === "admin/settings.njk");
        if (!call?.[1]) throw new Error("admin/settings.njk was never rendered");
        return call[1];
      };

      // The four clearCache.ts actually redirects with, each arriving intact.
      for (const outcome of ["purged", "purged-kv-only", "cooldown", "failed"]) {
        expect(await contextFor(`?cache=${outcome}`)).toMatchObject({ cache_result: outcome });
      }

      // Everything else arrives as null rather than as the visitor's string --
      // the near-misses, a bare `?cache=`, no parameter at all, and a payload
      // that would matter if it were ever printed.
      for (const rejected of [
        "PURGED",
        "purged ",
        " purged",
        "purge",
        "purgedx",
        "purged-kv",
        "purged-kv-only-really",
        "",
        "<img src=x onerror=zzreflectedzz()>",
      ]) {
        expect(await contextFor(`?cache=${encodeURIComponent(rejected)}`)).toMatchObject({ cache_result: null });
      }
      expect(await contextFor("")).toMatchObject({ cache_result: null });
    } finally {
      rendered.mockRestore();
    }
  });

  // NOTHING from the querystring reaches this page's HTML -- escaped or
  // otherwise. Worth asserting rather than assuming, because reflection is a
  // live pattern in this exact template family: admin/page.njk's nav search
  // box renders `value="{{ q or "" }}"`, and `q` is a context key that
  // routes/admin/search.ts fills from ITS querystring. Nothing populates it
  // here, so ?q= must come back empty on this page; a context builder that
  // grew a "just pass the query through" convenience would light that box up
  // on every admin page at once.
  //
  // The marker is a nonsense word rather than something like "alert" because
  // the page's own DANGER ZONE heading is `mdi mdi-alert` -- a marker that
  // collides with real template content fails for a reason that has nothing
  // to do with reflection.
  it("never reflects a query parameter into the page, escaped or not", async () => {
    const payload = '<script>zzreflectedzz("1")</script>';
    const { res, body } = await getSettings(`?cache=${encodeURIComponent(payload)}&q=${encodeURIComponent(payload)}`);

    expect(res.status).toBe(200);
    expect(banner(body)).toBeNull();
    expect(body).not.toContain("zzreflectedzz");
    expect(body).not.toContain("&lt;script&gt;");
    // The box the value would have landed in, still empty.
    expect(body).toContain('placeholder="Search everything..." aria-label="Search query" value=""');
  });

  // Hono's c.req.query() returns the FIRST occurrence of a repeated key, so
  // the allowlist is applied to the value that would be used and not to some
  // other copy of it. Pinned in both directions because a change to that
  // resolution (last-wins, or an array) would move which value is checked --
  // and an allowlist checking a different string from the one it renders is
  // the shape of every bypass ever written.
  it("narrows the first value of a repeated ?cache=, not a later one", async () => {
    expect(banner((await getSettings("?cache=purged&cache=cooldown")).body)?.text).toBe("Cache purged.");
    expect(banner((await getSettings("?cache=nonsense&cache=purged")).body)).toBeNull();
  });

  // Other querystrings are simply not this page's business -- Django's view
  // reads none at all -- and must not disturb the render.
  it("ignores unrelated query parameters", async () => {
    const { res, body } = await getSettings("?next=%2Fadmin%2F&q=tesco&cache=cooldown");

    expect(res.status).toBe(200);
    expect(banner(body)?.text).toBe("Not purged — a purge already ran in the last minute.");
  });
});

// ---------------------------------------------------------------------------
// The link hub -- followed, not string-compared
// ---------------------------------------------------------------------------

describe("adminSettings -- the links", () => {
  // The page's whole job, pinned as a list. Every href is a hand-written
  // literal in settings.njk (Django used {% url %}, which at least failed
  // loudly on a renamed route -- this port has no such backstop), so a link
  // dropped in a template edit would otherwise be invisible: the page still
  // renders, the section still has a heading, one row is just gone.
  it("offers exactly the sixteen links the hub is made of", async () => {
    const { body } = await getSettings();

    expect(hubLinks(body)).toEqual([
      "/admin/items/",
      "/admin/slug-redirects/",
      "/admin/order-groups/",
      "/admin/crawl-sets/",
      "/admin/stats/editing/",
      "/admin/stats/orders/",
      "/admin/stats/subscribers/",
      "/admin/stats/subscribers/graph/",
      "/admin/stats/needs/",
      "/admin/subscriptions/",
      "/admin/politics/",
      "/admin/places/",
      "/admin/foodbanks/dupe_postcodes/",
      "/admin/map/",
      "/admin/foodbanks/without_need/",
      "/admin/query/",
    ]);
  });

  // AND EVERY ONE OF THEM IS FETCHED. This is the test that would have caught
  // the read-only form of issue #34: a hub that reports success while
  // delivering nothing. Each link is followed against the same app and the
  // same (empty but real) database, so a route renamed, moved behind a
  // different method, or registered on the wrong sub-app shows up as a 404
  // here rather than as a click in six months' time.
  //
  // The status is asserted as 200 exactly, not merely "not 404": /admin/query/
  // is a console whose template comment calls it POST-only, and a GET landing
  // on a 405 or a redirect would be just as broken a link from this page.
  it("has no dead ones -- every link answers 200", async () => {
    const { body } = await getSettings();
    const links = hubLinks(body);

    // Counted first, because "every link answers 200" is vacuously true of no
    // links at all: rename the <ul class="settings"> this file scrapes and
    // hubLinks() returns [], and without this line the test would go green on
    // a page with nothing on it.
    expect(links).toHaveLength(16);

    const statuses: Record<string, number> = {};
    for (const href of links) statuses[href] = (await request(href)).res.status;

    expect(Object.entries(statuses).filter(([, status]) => status !== 200)).toEqual([]);
  });

  // The two Django sections that were deliberately NOT ported, asserted as
  // absent so that "it is missing" stays a decision rather than becoming a
  // rediscovered omission. settings.njk:101-110 gives the reasons: Django's
  // /admin/credential/<name>/ returns any secret as text/plain and there is no
  // secret store left for it to read (PLAN.md §2.9.1 replaced the whole
  // GfCredential table with Worker secrets), and the three Testers each send a
  // real email / push / WhatsApp message through a live third-party account.
  it("does not port Django's Credentials link or its three Testers", async () => {
    const { body } = await getSettings();

    expect(body).not.toContain("Credentials");
    expect(body).not.toContain("/admin/credential");
    expect(body).not.toContain("Email Tester");
    expect(body).not.toContain("Web Push Tester");
    expect(body).not.toContain("WhatsApp Tester");
  });

  // The three headings Django has and the two the port adds, in the order the
  // page presents them. Django's settings.html has no "Data quality" section:
  // both its entries are pages that exist on the Django side too but that no
  // Django template links (a repo-wide grep for admin:map and
  // admin:foodbanks_without_need under gfadmin/templates/ returns nothing), so
  // the port surfaces them rather than inventing them.
  it("keeps Django's section order and adds the port's own", async () => {
    const { body } = await getSettings();
    const headings = [...body.matchAll(/<h3>(?:<span[^>]*><\/span> )?([A-Za-z ]+)<\/h3>/g)].map((m) => m[1]);

    expect(headings).toEqual(["Stats", "User Data", "Geo", "Data quality", "DANGER ZONE"]);
  });
});

// ---------------------------------------------------------------------------
// The DANGER ZONE button, pressed
// ---------------------------------------------------------------------------

describe("adminSettings -- the Clear Cache button", () => {
  // Django renders this as a plain <a href> GET (settings.html:59), which
  // PLAN.md lists as one of the GET-mutation holes the port closes: a link
  // prefetcher, a crawler behind the admin's session or a back/forward
  // restore could purge the cache with no click at all.
  it("renders the purge as a POST form with a confirmation, not a link", async () => {
    const { body } = await getSettings();

    expect(body).toContain('<form action="/admin/clearcache/" method="post"');
    expect(body).toContain("confirm('Purge the whole cache?')");
    expect(body).not.toMatch(/<a[^>]+href="\/admin\/clearcache\/"/);
  });

  // THE BUTTON, ACTUALLY PRESSED, with the token THIS page minted and the
  // cookie THIS response set. clearCache.test.ts proves the handler works
  // given a valid pair; this proves the pair the settings page hands a browser
  // IS valid -- the two halves of a double-submit are minted in different
  // functions (issueCsrfToken sets the cookie, the template renders the field)
  // and a mismatch between them would be a 403 on every press of the one
  // button on the page, with the form rendering perfectly right up until then.
  //
  // Followed all the way back into the banner, so this single test covers the
  // whole round trip the admin actually performs: render, press, redirect,
  // read the result. CF_API_KEY/CF_ZONE_ID are unset on this Worker today, so
  // purged-kv-only is the outcome production would produce.
  it("mints a token the purge endpoint accepts, and the outcome comes back as a banner", async () => {
    // Seeded so the purge has something to clear. The banner this round trip
    // ends on says the KV fragments were cleared; a banner is not evidence
    // that they were, which is what the second half of this test is for.
    kv.set(FRAG_KV_KEY_LAST_UPDATED, "2019-01-01T00:00:00");
    kv.set(FRAG_KV_KEY_NEED_HITS, "11");

    const page = await getSettings();
    const cookie = csrfCookieFrom(page.res);
    const token = csrfFieldFrom(page.body);

    // The field carries the RAW token; the cookie carries `raw.signature`.
    expect(cookie.split(".")[0]).toBe(token);

    const posted = await request("/admin/clearcache/", {
      method: "POST",
      csrfCookie: cookie,
      body: new URLSearchParams({ csrf_token: token }).toString(),
    });
    expect(posted.res.status).toBe(302);
    expect(posted.res.headers.get("Location")).toBe("/admin/settings/?cache=purged-kv-only");

    // THE CLEAR ACTUALLY HAPPENED -- read back out of the store rather than
    // inferred from the redirect, which is the whole lesson of issue #34.
    // MUTANT: deleting clearCache.ts's
    // `Promise.allSettled([DATA.delete(...), DATA.delete(...)])` survived every
    // other test in this file -- the button still redirected, this page still
    // said "Cleared the KV fragments", and both fragments were still sitting
    // there stale, which for FRAG_KV_KEY_LAST_UPDATED means the site keeps
    // advertising a data freshness date that is years old.
    //
    // Asserted as an EMPTY map rather than two absences, because that also
    // kills a second mutant: writing the `clearcache:last` cooldown marker on
    // every outcome instead of only on a real purge. That one is invisible on
    // the first press and turns the second into "a purge already ran in the
    // last minute" -- a cooldown charged for an API call that was never made.
    expect([...kv.keys()]).toEqual([]);

    const followed = await request(posted.res.headers.get("Location")!, { csrfCookie: cookie });
    expect(followed.res.status).toBe(200);
    expect(banner(followed.body)?.kind).toBe("warning");

    // And pressing it again immediately gives the same answer rather than a
    // cooldown, for the same reason: a KV-only clear never touched the
    // rate-limited API, so there is nothing to be cooling down from.
    const again = await request("/admin/clearcache/", {
      method: "POST",
      csrfCookie: cookie,
      body: new URLSearchParams({ csrf_token: token }).toString(),
    });
    expect(again.res.headers.get("Location")).toBe("/admin/settings/?cache=purged-kv-only");
  });

  // The other direction, in the four ways this page's double submit can be
  // wrong -- so the 302 above is evidence about THE PAIR THIS PAGE MINTED
  // rather than about the endpoint being open to anyone who finds the URL.
  // clearCache.test.ts owns the exhaustive CSRF matrix (forged signatures,
  // JSON bodies, a missing secret); these four are here because each of them
  // SURVIVED this file until it was written, and because "without a token"
  // alone proves only that some token is required:
  //   - no token at all
  //   - MUTANT: verifyCsrf without its `timingSafeEqual(cookieRaw, formToken)`
  //     line, i.e. the double-submit half deleted, leaving "a token was sent"
  //     as the entire check. A well-formed token that is not the cookie's
  //     sails straight through it.
  //   - MUTANT: verifyCsrf without its Origin comparison, i.e. this page's own
  //     valid token replayed from another site's form. Sent with NO
  //     Sec-Fetch-Site, deliberately: a request carrying both headers is
  //     refused by either check, so it cannot tell which one is still there --
  //     the first attempt at this test sent both and the mutant survived it.
  //     An Origin without a Sec-Fetch-Site is also a real shape (older
  //     browsers, header-stripping intermediaries), not a contrivance.
  //   - MUTANT: verifyCsrf without its Sec-Fetch-Site comparison -- the same
  //     replay with the Origin stripped instead, for the same reason.
  // Each is checked for the refusal AND for the fragments surviving it, since
  // a 403 returned after the purge had already run would be no protection.
  it("refuses the same POST when the token is missing, wrong, or from another origin", async () => {
    kv.set(FRAG_KV_KEY_NEED_HITS, "11");
    const page = await getSettings();
    const cookie = csrfCookieFrom(page.res);
    const token = csrfFieldFrom(page.body);

    const missing = await request("/admin/clearcache/", { method: "POST", csrfCookie: cookie, body: "" });
    expect(missing.res.status).toBe(403);

    // Same length and same hex alphabet as the real one -- issueCsrfToken
    // mints 32 random bytes -- so the only thing wrong with it is that it is
    // not the token the cookie carries.
    const wrongToken = token.replace(/^./, (first) => (first === "0" ? "1" : "0"));
    expect(wrongToken).not.toBe(token);
    const wrong = await request("/admin/clearcache/", {
      method: "POST",
      csrfCookie: cookie,
      body: new URLSearchParams({ csrf_token: wrongToken }).toString(),
    });
    expect(wrong.res.status).toBe(403);

    // The valid token replayed from somebody else's form, twice: once with
    // Origin as the only evidence, once with Sec-Fetch-Site as the only
    // evidence. Split because verifyCsrf refuses on EITHER, so a single
    // request carrying both cannot show that both checks are still there.
    const replay = new URLSearchParams({ csrf_token: token }).toString();
    const byOrigin = await request("/admin/clearcache/", {
      method: "POST",
      csrfCookie: cookie,
      origin: "https://evil.example",
      secFetchSite: null,
      body: replay,
    });
    expect(byOrigin.res.status).toBe(403);

    const byFetchMetadata = await request("/admin/clearcache/", {
      method: "POST",
      csrfCookie: cookie,
      origin: null,
      secFetchSite: "cross-site",
      body: replay,
    });
    expect(byFetchMetadata.res.status).toBe(403);

    expect(kvWrites).toEqual([]);
    expect(kv.get(FRAG_KV_KEY_NEED_HITS)).toBe("11");
  });

  // lib/csrf.ts's fail-closed convention, seen from the page: with no
  // CSRF_SECRET on the Worker, issueCsrfToken mints nothing and sets no
  // cookie, so this page renders 200 with an EMPTY hidden field and the
  // button below it is dead on arrival (a 403, not a purge). Pinned because
  // the degradation is invisible on the page itself -- the form looks
  // identical -- and because the alternative reading, that a missing secret
  // should 500 the whole admin, is a change someone could make believing it
  // to be the safer one. It is not: it would take out every admin page at
  // once, and the log line issueCsrfToken emits is the actual signal.
  it("still renders with no CSRF_SECRET, with an empty token and a button that will be refused", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const page = await request("/admin/settings/", { env: { CSRF_SECRET: undefined } });

    expect(page.res.status).toBe(200);
    expect(page.body).toContain('<input type="hidden" name="csrf_token" value="">');
    expect(page.res.headers.get("Set-Cookie")).toBeNull();
    expect(log).toHaveBeenCalled();

    const posted = await request("/admin/clearcache/", { method: "POST", body: "csrf_token=", env: { CSRF_SECRET: undefined } });
    expect(posted.res.status).toBe(403);
    expect(kvWrites).toEqual([]);
    log.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// The admin chrome around it
// ---------------------------------------------------------------------------

describe("adminSettings -- the admin chrome", () => {
  // Django's own title block is "Settings - GF Admin"; admin/page.njk
  // hard-codes " - Give Food Admin" for every ported admin page, so this one
  // reads differently on purpose. Asserted so the divergence is recorded
  // rather than rediscovered.
  it("titles the page Settings, with the port's own admin suffix", async () => {
    const { body } = await getSettings();

    expect(body).toContain("<title>Settings - Give Food Admin</title>");
  });

  // views.py:2760 passes "section": "settings" and the port passes the same
  // string to adminPageContext. Exactly one nav item may be active -- a
  // section string that matched nothing (a typo, a renamed nav key) would
  // highlight none and the page would look orphaned, and one that matched two
  // would be a nav that lies about where you are.
  it("highlights Settings in the nav, and only Settings", async () => {
    const { body } = await getSettings();
    const active = [...body.matchAll(/<a class="navbar-item is-active" href="([^"]+)"/g)].map((m) => m[1]);

    expect(active).toEqual(["/admin/settings/"]);
  });

  // pageContext.ts publishes four Google-key globals to every admin page
  // because admin.js initialises unconditionally and a missing name throws a
  // ReferenceError that kills every lookup button in the admin. Two are
  // populated and two are deliberately empty -- `places` because
  // routes/admin/gmapProxy.ts supplies it server-side and it must never reach
  // a browser, `gmap_key` because no ported template has a consumer for it.
  // Asserted here as well as in map.test.ts because this page is the one an
  // admin lands on first, and because "empty on purpose" is indistinguishable
  // from "lost the binding" without a test saying which.
  it("publishes the two Google keys admin.js needs and neither of the two it does not", async () => {
    const { body } = await getSettings();

    expect(body).toContain('const gmap_static_key = "gmap-static-key-not-a-real-one";');
    expect(body).toContain('const gmap_geocode_key = "gmap-geocode-key-not-a-real-one";');
    expect(body).toContain('const gmap_key = "";');
    expect(body).toContain('const gmap_places_key = "";');
  });
});
