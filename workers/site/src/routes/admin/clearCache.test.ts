import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRAG_KV_KEY_LAST_UPDATED, FRAG_KV_KEY_NEED_HITS } from "@givefood/db";
import { adminApp } from "./index";
import { frag } from "../public/frag";
import { hmacSha256Hex } from "../../lib/hmac";
import type { AppEnv } from "../../types";

// routes/admin/clearCache.ts -- the DANGER ZONE "Clear Cache" button, reached
// here through its PRODUCTION registration (routes/admin/index.ts:219 mounts
// adminApp at /admin, POST-only, behind requireAdminAuth) rather than through
// a hand-built route. That distinction is the point of this file rather than
// an aesthetic one: the handler is correct today and the interesting ways for
// this button to break are all OUTSIDE it -- registered on GET as well as
// POST, mounted outside the auth gate, or redirecting to a ?cache= value the
// settings page silently drops on the floor. None of those would fail a test
// that called adminClearCache(c) directly with a hand-made Context.
//
// WHAT "THE WRITE ACTUALLY HAPPENED" MEANS FOR THIS HANDLER. It writes no
// rows. Its entire durable effect is three KV operations and one outbound
// POST, and it reports all of them through a 302 -- which is precisely the
// shape of issue #34 (a location form that parsed a Place ID, passed it down,
// wrote it with no SQL at all, and redirected as though it had worked). So a
// 302 is never the assertion here. Every purge test either
//   (a) reads the KV store back and asserts the two frag keys are GONE, or
//   (b) goes further and asks the REAL /frag/ route -- against a REAL
//       in-memory SQLite seeded from the real migrations -- what it now
//       serves, which is the only way to prove the delete evicted the keys
//       that actually feed a page rather than two similarly-named strings.
// (b) is the round-trip equivalent of reloading an edit form: the value the
// admin's click was supposed to invalidate is followed all the way out of KV,
// back through the SQL that recomputes it, and into a response body.
//
// THE OTHER SILENT FAILURE THIS FILE EXISTS FOR: `outcome` is a four-value
// enum that leaves this module as a querystring and is re-narrowed against a
// SEPARATE allowlist in routes/admin/settings.ts:27 before settings.njk:75-86
// can render a banner for it. Three independent lists that must agree. Drop or
// rename one value on either side and the admin presses Clear Cache, gets a
// redirect, and sees NOTHING -- no confirmation, no error, no way to tell a
// purge from a rate-limited no-op. So each of the four outcomes below is
// followed through the redirect into the real settings page and its banner
// asserted, not just its querystring.
//
// Mocked: fetch (Cloudflare's purge API -- the only thing that leaves the
// machine) and the two KV namespaces. The router, the auth middleware, the
// CSRF verifier, the templates, the D1 queries behind /frag/ and the handler
// itself are all the shipped implementations.

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORIGIN = "https://www.givefood.org.uk";
const CSRF_SECRET = "test-csrf-secret-not-a-real-one";
const CSRF_RAW = "a".repeat(64);
const SESSION_ID = "test-admin-session-id";

const ZONE_ID = "zone-abc123";
const API_KEY = "cf-api-token-not-a-real-one";
const PURGE_URL = `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/purge_cache`;

// clearCache.ts:50's COOLDOWN_KV_KEY, which is module-private. Duplicated here
// deliberately: it is the only name that identifies the marker in production
// KV, it outlives any single deploy, and a rename would both reset the guard
// and orphan the old key with nothing to notice. Spelling it out means the
// rename is a visible decision instead of an invisible one.
const COOLDOWN_KEY = "clearcache:last";
const COOLDOWN_MS = 60_000;

// Reduced transcription of the two tables /frag/ actually queries:
// migrations/0001_core.sql:20-51 (foodbank, of which only `modified` is read
// -- getLastModifiedFoodbank is MAX(modified)) and
// migrations/0003_homepage_data.sql:40-45 (foodbankhit, verbatim, WITHOUT
// ROWID and composite PK included so the seeded rows behave like production's).
const SCHEMA = `
CREATE TABLE foodbank (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  modified TEXT NOT NULL
);
CREATE INDEX foodbank_modified_idx ON foodbank(modified);
CREATE TABLE foodbankhit (
  foodbank_id INTEGER NOT NULL, day TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (foodbank_id, day)
) WITHOUT ROWID;
CREATE INDEX hit_day_foodbank_idx ON foodbankhit(day, foodbank_id, hits);
`;

// What the seeded database says, once /frag/ has been forced to recompute.
// Deliberately unlike the stale KV values below in every digit, so "the KV
// value was evicted" and "the page still shows the old number" cannot both
// be true and pass.
const DB_LAST_MODIFIED = "2026-09-04T11:22:33";
const DB_HITS_TOTAL = 4321;

// The values primed into KV before each purge: what a visitor sees while the
// cache is warm, and what must STOP being served once the button works.
const STALE_LAST_MODIFIED = "2019-01-01T00:00:00";
const STALE_HITS = "11";

type Bindable = null | number | bigint | string | Uint8Array;

// The D1PreparedStatement surface packages/db uses, over node:sqlite -- same
// shim as donationPoint.test.ts and foodbankLocation.test.ts. D1 is async and
// node:sqlite is synchronous; the SQL text, the binding and the NULL semantics
// are SQLite's on both sides, which is all getLastModifiedFoodbank and
// getRecentHitsTotal depend on.
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
  return { prepare: (sql: string) => statement(sql, []), getBookmark: () => null } as unknown as D1DatabaseSession;
}

// A KV namespace that can be made to fail one operation at a time. The
// handler's three degradation branches (a failed cooldown read, a failed frag
// delete, a failed marker write) are each documented as "must not turn the
// button into a 500", and none of them is reachable without an injectable
// failure -- a Map on its own can only test the happy path.
function fakeKv() {
  const store = new Map<string, string>();
  const failing = { get: false, put: false, deleteKeys: new Set<string>() };
  return {
    store,
    failing,
    get: vi.fn(async (key: string): Promise<string | null> => {
      if (failing.get) throw new Error("KV get unavailable");
      return store.get(key) ?? null;
    }),
    put: vi.fn(async (key: string, value: string): Promise<void> => {
      if (failing.put) throw new Error("KV put unavailable");
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string): Promise<void> => {
      if (failing.deleteKeys.has(key)) throw new Error(`KV delete of ${key} unavailable`);
      store.delete(key);
    }),
  };
}

type FakeKv = ReturnType<typeof fakeKv>;

// THE PRODUCTION WIRING, built once. adminApp carries requireAdminAuth and
// every real route registration, so "POST /admin/clearcache/ exists and GET
// does not" is answered by the shipped route table rather than by this file's
// opinion of it. /frag/ is registered at index.ts:488's exact path constraint
// so the round-trip tests below read through the same route a visitor does.
const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  c.set("requestStartTime", performance.now());
  c.set("lang", "en");
  await next();
});
app.route("/admin", adminApp);
app.get("/frag/:frag{ip-address|last-updated|need-hits|news}/", frag);
// A 500 here would mean the handler threw. Labelled rather than left to
// vitest, so a regression reads as "expected 302, got 500: KV get
// unavailable" instead of an unhandled rejection with no route attached.
app.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));

let db: DatabaseSync;
let kv: FakeKv;
let sessions: FakeKv;
let fetchMock: ReturnType<typeof vi.fn>;
let consoleError: ReturnType<typeof vi.spyOn>;
let consoleLog: ReturnType<typeof vi.spyOn>;

function env(overrides: Record<string, unknown> = {}): AppEnv["Bindings"] {
  return {
    DB: { withSession: () => d1Session(db) },
    DATA: kv,
    SESSIONS: sessions,
    CSRF_SECRET,
    CF_API_KEY: API_KEY,
    CF_ZONE_ID: ZONE_ID,
    D1_DATABASE_NAME: "givefood-test",
    GMAP_STATIC_KEY: "",
    GMAP_GEOCODE_KEY: "",
    ...overrides,
  } as unknown as AppEnv["Bindings"];
}

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

type Reply = (init: RequestInit) => Promise<Response>;

/** Cloudflare's v4 success envelope. */
const purgeOk: Reply = async () => new Response(JSON.stringify({ success: true, result: { id: ZONE_ID } }), { status: 200 });

/** Answers the purge endpoint and throws on anything else, so an added
 *  outbound call fails loudly here rather than in production. */
function stubFetch(reply: Reply) {
  fetchMock = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    if (url === PURGE_URL) return reply(init);
    throw new Error(`unmodelled fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  db.prepare("INSERT INTO foodbank (id, name, slug, modified) VALUES (?, ?, ?, ?)").run(1, "Salisbury", "salisbury", "2024-05-05T09:00:00");
  db.prepare("INSERT INTO foodbank (id, name, slug, modified) VALUES (?, ?, ?, ?)").run(2, "Brixton", "brixton", DB_LAST_MODIFIED);
  // Inside getRecentHitsTotal's trailing-7-day window...
  db.prepare("INSERT INTO foodbankhit (foodbank_id, day, hits) VALUES (?, ?, ?)").run(1, isoToday(0), 4000);
  db.prepare("INSERT INTO foodbankhit (foodbank_id, day, hits) VALUES (?, ?, ?)").run(2, isoToday(3), 321);
  // ...and one that must NOT count, so a frag route that dropped the `day >=`
  // predicate would be visible as a wrong total rather than as a passing test
  // that only ever seeded matching rows.
  db.prepare("INSERT INTO foodbankhit (foodbank_id, day, hits) VALUES (?, ?, ?)").run(1, "2019-01-01", 999_000);

  kv = fakeKv();
  sessions = fakeKv();
  // A live admin session, exactly as lib/adminAuth.ts createSession() writes
  // one. expiresAt a full TTL out so getAdminSession's sliding refresh does
  // not fire and add an incidental SESSIONS.put to every request.
  sessions.store.set(
    `admin-session:${SESSION_ID}`,
    JSON.stringify({
      email: "someone@givefood.org.uk",
      name: "Some One",
      givenName: "Some",
      picture: "",
      expiresAt: Date.now() + 12 * 60 * 60 * 1000,
    }),
  );

  // Default: any outbound call at all is a test bug. Individual tests replace
  // this with a modelled reply.
  stubFetch(async () => {
    throw new Error("fetch not stubbed for this test");
  });

  // The handler narrates every degradation. Silenced by default (half these
  // tests are degradations) but kept as spies so the logging can be asserted
  // where it is the only signal an operator gets.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A YYYY-MM-DD `offsetDays` days ago, the shape foodbankhit.day holds. */
function isoToday(offsetDays: number): string {
  return new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/** Primes KV as a warm cache: both frag keys holding values that predate the
 *  database's, so "still serving the stale one" is detectable. */
function warmFragCache() {
  kv.store.set(FRAG_KV_KEY_LAST_UPDATED, STALE_LAST_MODIFIED);
  kv.store.set(FRAG_KV_KEY_NEED_HITS, STALE_HITS);
}

interface PostOptions {
  /** Full Cookie header. Defaults to a valid session + a valid signed CSRF cookie. */
  cookie?: string;
  /** The csrf_token form field. `null` omits it entirely. */
  csrfToken?: string | null;
  /** Merged over the defaults. An explicit `undefined` REMOVES the default
   *  header rather than sending it empty -- needed to test Origin and
   *  Sec-Fetch-Site one at a time, because a request carrying both cannot say
   *  which of the two checks refused it. */
  headers?: Record<string, string | undefined>;
  env?: Record<string, unknown>;
  /** Raw body + content type, for the non-form submissions. */
  body?: string;
  contentType?: string;
  path?: string;
}

async function csrfCookie(raw = CSRF_RAW, secret = CSRF_SECRET): Promise<string> {
  return `__Host-csrf=${raw}.${await hmacSha256Hex(secret, raw)}`;
}

async function signedInCookie(): Promise<string> {
  return `__Host-gfsession=${SESSION_ID}; ${await csrfCookie()}`;
}

async function post(options: PostOptions = {}): Promise<Response> {
  const cookie = options.cookie ?? (await signedInCookie());
  const token = options.csrfToken === undefined ? CSRF_RAW : options.csrfToken;
  const body = options.body ?? new URLSearchParams(token === null ? {} : { csrf_token: token }).toString();
  const merged: Record<string, string | undefined> = {
    "Content-Type": options.contentType ?? "application/x-www-form-urlencoded",
    Cookie: cookie,
    Origin: ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    ...options.headers,
  };
  const headers = Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)) as Record<string, string>;
  return app.fetch(
    new Request(`${ORIGIN}${options.path ?? "/admin/clearcache/"}`, {
      method: "POST",
      headers,
      body,
    }),
    env(options.env),
    execCtx,
  );
}

/** GETs a path on the same app with the same session -- used to follow the
 *  handler's own redirect, and to read /frag/ back after a purge. */
async function get(path: string): Promise<Response> {
  return app.fetch(
    new Request(`${ORIGIN}${path}`, { method: "GET", headers: { Cookie: await signedInCookie() } }),
    env(),
    execCtx,
  );
}

/** True when both frag keys survived -- i.e. nothing was cleared. */
function fragCacheIntact(): boolean {
  return kv.store.get(FRAG_KV_KEY_LAST_UPDATED) === STALE_LAST_MODIFIED && kv.store.get(FRAG_KV_KEY_NEED_HITS) === STALE_HITS;
}

// ---------------------------------------------------------------------------
// Auth, method and CSRF: the three ways in that must never reach the purge
// ---------------------------------------------------------------------------

describe("adminClearCache -- getting to the handler at all", () => {
  // requireAdminAuth (middleware/adminAuth.ts, Django's LoginRequiredAccess)
  // is applied to adminApp as a whole, so this is a test of the MOUNT as much
  // as of the middleware: a purge endpoint registered on the wrong app, or
  // above the gate, is a full-site cache purge available to the internet.
  it("never reaches the handler without a session", async () => {
    warmFragCache();
    const res = await post({ cookie: await csrfCookie() }); // valid CSRF, no session

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fclearcache%2F");
    // The assertions that matter: an unauthenticated request costs nothing.
    expect(fragCacheIntact()).toBe(true);
    expect(kv.delete).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // THE MUTANT THIS KILLS AND THE ONE ABOVE DOES NOT: a gate that checks the
  // session cookie is PRESENT without looking it up. Verified by making
  // lib/adminAuth.ts's getAdminSession() synthesise a session when
  // SESSIONS.get misses -- every test above still passed, because "no session"
  // there means "no cookie at all", which such a gate also refuses. A cookie
  // is attacker-supplied; only the KV lookup makes it evidence of a sign-in,
  // and the thing behind this particular gate is a one-click purge of the zone
  // in front of the live site.
  it("never reaches the handler on a session id that is not in KV", async () => {
    warmFragCache();
    const res = await post({ cookie: `__Host-gfsession=forged-session-id; ${await csrfCookie()}` });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fclearcache%2F");
    expect(fragCacheIntact()).toBe(true);
    expect(kv.delete).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // PLAN.md:10082 lists Django's clearcache as one of the GET-mutation holes
  // the port closes -- `| clearcache | 3116 | clears both caches on GET |
  // POST + CSRF |`. (clearCache.ts:45 cites 10049 for that row; the table has
  // since moved down the document, so the line to look at is 10082.)
  // gfadmin/templates/admin/settings.html:59 is a plain
  // <a href>, so a link prefetcher, a crawler behind the admin's session, or
  // a browser's back/forward cache could clear both Django caches with no
  // click at all. routes/admin/index.ts:219 registers POST only, and this is
  // the assertion that keeps it that way. It runs WITH a valid session, so
  // the 404 proves the route is absent rather than that the gate fired first.
  it("404s a GET rather than purging on one", async () => {
    warmFragCache();
    const res = await get("/admin/clearcache/");

    expect(res.status).toBe(404);
    expect(fragCacheIntact()).toBe(true);
    expect(kv.delete).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a POST with no csrf_token field", async () => {
    warmFragCache();
    const res = await post({ csrfToken: null });

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden");
    expect(fragCacheIntact()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a POST whose token does not match the cookie", async () => {
    warmFragCache();
    const res = await post({ csrfToken: "b".repeat(64) });

    expect(res.status).toBe(403);
    expect(fragCacheIntact()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The "signed" half of the signed double-submit. An attacker who can set a
  // cookie on a sibling subdomain can make the cookie and the form field agree
  // with each other; only the HMAC stops that pair being accepted.
  it("refuses a cookie whose signature does not verify", async () => {
    warmFragCache();
    const forged = `__Host-gfsession=${SESSION_ID}; __Host-csrf=${CSRF_RAW}.${"0".repeat(64)}`;
    const res = await post({ cookie: forged });

    expect(res.status).toBe(403);
    expect(fragCacheIntact()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin POST even with a valid token pair", async () => {
    warmFragCache();
    const res = await post({ headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" } });

    expect(res.status).toBe(403);
    expect(fragCacheIntact()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // MUTANTS THESE TWO KILL, AND THE ONE ABOVE DOES NOT. A real browser sends
  // Origin AND Sec-Fetch-Site on a cross-site POST, so the test above passes
  // with EITHER of lib/csrf.ts's two checks deleted -- the survivor covers for
  // the corpse. Verified by deleting each in turn: both mutants survived the
  // combined test and both die here. csrf.test.ts owns the exhaustive matrix
  // of header values; what these pin is that BOTH signals are still live on
  // the one route where a forged submission costs a full-zone cache purge.
  it("refuses on the Origin header alone, when Sec-Fetch-Site is absent", async () => {
    warmFragCache();
    // A browser old enough to send neither Fetch Metadata header, or a
    // stripping intermediary: Origin is the only thing left to judge on.
    const res = await post({ headers: { Origin: "https://evil.example", "Sec-Fetch-Site": undefined } });

    expect(res.status).toBe(403);
    expect(fragCacheIntact()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses on Sec-Fetch-Site alone, when Origin is absent", async () => {
    warmFragCache();
    const res = await post({ headers: { Origin: undefined, "Sec-Fetch-Site": "cross-site" } });

    expect(res.status).toBe(403);
    expect(fragCacheIntact()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // lib/csrf.ts fails closed on an unset secret, and this endpoint is the one
  // where failing OPEN would be worst: a misconfigured Worker would expose an
  // unauthenticated-in-effect full-zone purge.
  it("refuses everything when CSRF_SECRET is unset", async () => {
    warmFragCache();
    const res = await post({ env: { CSRF_SECRET: "" } });

    expect(res.status).toBe(403);
    expect(fragCacheIntact()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Hono's parseBody returns {} for any content type that is not a form
  // (hono/utils/body.js:11-14), so a JSON POST arrives with no csrf_token and
  // is refused. Pinned because the alternative -- a throw out of parseBody --
  // would surface as a 500 from app.onError, and a 500 on a purge button is
  // indistinguishable to the admin from "the purge failed", which it is not:
  // nothing happened at all.
  it("refuses a JSON POST as a plain 403, not a 500", async () => {
    warmFragCache();
    const res = await post({ body: JSON.stringify({ csrf_token: CSRF_RAW }), contentType: "application/json" });

    expect(res.status).toBe(403);
    expect(fragCacheIntact()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The purge itself
// ---------------------------------------------------------------------------

describe("adminClearCache -- the purge that succeeds", () => {
  it("redirects to the settings page with the purged outcome", async () => {
    stubFetch(purgeOk);
    const res = await post();

    // Django redirects to admin:index (gfadmin/views.py:3122). This port
    // redirects to /admin/settings/ instead -- where the button lives -- and
    // that divergence is deliberate and documented in clearCache.ts:154-159.
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/settings/?cache=purged");
  });

  // givefood/utils/cache.py:166's endpoint and Bearer-token shape, with
  // purge_everything in place of files/prefixes. Asserted field by field
  // because every one of them is a way to get a 200 back for a purge that
  // did not happen: the wrong zone purges someone else's cache, a missing
  // body is a no-op, and a `files: []` body clears nothing.
  it("sends exactly the documented purge_everything request", async () => {
    const fetchSpy = stubFetch(purgeOk);
    await post();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(PURGE_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({ purge_everything: true });
    // A purge that can hang forever holds the admin's request open and gives
    // no answer either way; clearCache.ts:64 caps it.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  // THE WRITE. Both frag keys gone from the store -- read back, not inferred
  // from the redirect. A handler that deleted neither, or deleted one, still
  // returns ?cache=purged.
  it("deletes both frag KV keys, and only those", async () => {
    warmFragCache();
    kv.store.set("something:else", "left alone");
    stubFetch(purgeOk);
    await post();

    expect(kv.store.has(FRAG_KV_KEY_LAST_UPDATED)).toBe(false);
    expect(kv.store.has(FRAG_KV_KEY_NEED_HITS)).toBe(false);
    expect(kv.store.get("something:else")).toBe("left alone");
    expect(kv.delete.mock.calls.map(([key]) => key).sort()).toEqual([FRAG_KV_KEY_NEED_HITS, FRAG_KV_KEY_LAST_UPDATED].sort());
  });

  it("starts the cooldown by writing the marker", async () => {
    stubFetch(purgeOk);
    const before = Date.now();
    await post();
    const marker = Number(kv.store.get(COOLDOWN_KEY));

    expect(kv.store.has(COOLDOWN_KEY)).toBe(true);
    expect(marker).toBeGreaterThanOrEqual(before);
    expect(marker).toBeLessThanOrEqual(Date.now());
  });
});

// ---------------------------------------------------------------------------
// The round trip: prove the eviction through the route that reads the keys
// ---------------------------------------------------------------------------

// clearCache.ts:110-113 justifies deleting the frag keys with a claim about a
// DIFFERENT module: "routes/public/frag.ts's readOrCompute() recomputes and
// rewrites either one on a miss, so the worst case is one live query". These
// two tests are that claim, executed. They are the closest this handler has to
// "save the row, reload the form, assert the value came back": the purge is
// only real if the thing the admin was looking at changes, and it is only safe
// if what replaces it is the database's answer rather than an empty page.
describe("adminClearCache -- what the site serves after the purge", () => {
  it("serves the stale cached values until the button is pressed", async () => {
    warmFragCache();

    // The control. Without it, the assertions below would pass just as well
    // against a /frag/ route that ignored KV entirely and always recomputed,
    // which would make the purge meaningless and this file blind to it.
    expect(await (await get("/frag/need-hits/")).text()).toBe("11");
    expect(kv.store.get(FRAG_KV_KEY_LAST_UPDATED)).toBe(STALE_LAST_MODIFIED);
  });

  it("recomputes both fragments from D1 on the next request after a purge", async () => {
    warmFragCache();
    stubFetch(purgeOk);
    expect((await post()).headers.get("Location")).toBe("/admin/settings/?cache=purged");

    // need-hits: SUM(hits) over the trailing seven days -- 4000 + 321, with
    // the 999,000-hit 2019 row correctly outside the window. Rendered through
    // intcomma exactly as the homepage renders it.
    const hits = await get("/frag/need-hits/");
    expect(hits.status).toBe(200);
    expect(await hits.text()).toBe("4,321");

    // last-updated is a rendered "x ago" string, so the assertion that
    // survives a clock is on what got WRITTEN BACK: MAX(modified) out of the
    // real table, not the 2019 value that was there a moment ago.
    const lastUpdated = await get("/frag/last-updated/");
    expect(lastUpdated.status).toBe(200);
    expect(kv.store.get(FRAG_KV_KEY_LAST_UPDATED)).toBe(DB_LAST_MODIFIED);
    expect(kv.store.get(FRAG_KV_KEY_NEED_HITS)).toBe(String(DB_HITS_TOTAL));
  });
});

// ---------------------------------------------------------------------------
// The four outcomes, and the banner each one has to produce
// ---------------------------------------------------------------------------

/** Follows the handler's redirect into the REAL settings page and returns the
 *  notification banner's text, entity-decoded as a human reads it. */
async function bannerAfter(res: Response): Promise<string | null> {
  const location = res.headers.get("Location")!;
  const page = await get(location);
  expect(page.status).toBe(200);
  const html = await page.text();
  const match = html.match(/<div class="notification is-[a-z]+ is-light">([\s\S]*?)<\/div>/);
  if (!match) return null;
  return match[1]!
    .replace(/<[^>]+>/g, "")
    .replace(/&mdash;/g, "—")
    .replace(/\s+/g, " ")
    .trim();
}

describe("adminClearCache -- every outcome reaches the admin as a banner", () => {
  it("purged", async () => {
    stubFetch(purgeOk);
    expect(await bannerAfter(await post())).toBe("Cache purged.");
  });

  it("purged-kv-only", async () => {
    const res = await post({ env: { CF_API_KEY: "" } });
    expect(res.headers.get("Location")).toBe("/admin/settings/?cache=purged-kv-only");
    expect(await bannerAfter(res)).toBe(
      "Cleared the KV fragments, but the CDN cache was not purged: CF_API_KEY / CF_ZONE_ID are not set on this Worker.",
    );
  });

  it("cooldown", async () => {
    kv.store.set(COOLDOWN_KEY, String(Date.now() - 10_000));
    const res = await post();
    expect(res.headers.get("Location")).toBe("/admin/settings/?cache=cooldown");
    expect(await bannerAfter(res)).toBe("Not purged — a purge already ran in the last minute.");
  });

  it("failed", async () => {
    stubFetch(async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000 }] }), { status: 200 }));
    const res = await post();
    expect(res.headers.get("Location")).toBe("/admin/settings/?cache=failed");
    expect(await bannerAfter(res)).toBe("Cloudflare rejected the purge. Check the Worker logs.");
  });
});

// ---------------------------------------------------------------------------
// Degrading instead of 500ing
// ---------------------------------------------------------------------------

describe("adminClearCache -- unset Cloudflare credentials", () => {
  // clearCache.ts:130-135: the secrets are not on this Worker yet, and the
  // branch is explicitly marked "do not tidy this branch away". The KV clear
  // still has to happen -- that half needs no credentials -- and the admin has
  // to be told the CDN was not touched rather than shown a success banner.
  it("clears KV, skips the CDN and says so when CF_API_KEY is unset", async () => {
    warmFragCache();
    const res = await post({ env: { CF_API_KEY: "" } });

    expect(res.headers.get("Location")).toBe("/admin/settings/?cache=purged-kv-only");
    expect(kv.store.has(FRAG_KV_KEY_LAST_UPDATED)).toBe(false);
    expect(kv.store.has(FRAG_KV_KEY_NEED_HITS)).toBe(false);
    // No half-formed request goes out unauthenticated.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(consoleLog).toHaveBeenCalledWith("clearcache: CF_API_KEY/CF_ZONE_ID unset -- KV cleared, CDN not purged");
  });

  // The zone id is a plain var and the API key is a secret, so in practice
  // these go missing for entirely different reasons. One branch covers both;
  // assert it does not quietly become an API-key-only check, which would send
  // a purge to `zones//purge_cache`.
  it("does the same when CF_ZONE_ID is the missing half", async () => {
    warmFragCache();
    const res = await post({ env: { CF_ZONE_ID: "" } });

    expect(res.headers.get("Location")).toBe("/admin/settings/?cache=purged-kv-only");
    expect(kv.store.has(FRAG_KV_KEY_NEED_HITS)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // A KV-only clear never touched the rate-limited API, so it must stay
  // instantly repeatable -- otherwise a Worker with no credentials would put
  // the admin in a 60-second cooldown for an operation that cost Cloudflare
  // nothing.
  it("starts no cooldown, because nothing rate-limited happened", async () => {
    await post({ env: { CF_API_KEY: "" } });
    expect(kv.store.has(COOLDOWN_KEY)).toBe(false);
  });
});

describe("adminClearCache -- Cloudflare says no", () => {
  // The v4 API answers 200 with {"success": false} for a token missing
  // Zone.Cache Purge. res.ok alone would report that as a success, and the
  // admin would walk away believing the cache was cleared. Django checks
  // neither (cache.py:172/196 discards the response entirely).
  it("treats a 200 with success:false as a failure", async () => {
    stubFetch(async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] })));
    const res = await post();

    expect(res.headers.get("Location")).toBe("/admin/settings/?cache=failed");
    expect(consoleError).toHaveBeenCalledWith("clearcache: Cloudflare purge_cache failed (HTTP 200)", [
      { code: 10000, message: "Authentication error" },
    ]);
  });

  it("treats a non-2xx as a failure", async () => {
    stubFetch(async () => new Response(JSON.stringify({ success: false, errors: [] }), { status: 403 }));
    expect((await post()).headers.get("Location")).toBe("/admin/settings/?cache=failed");
  });

  // THE MUTANT THIS KILLS: dropping `!res.ok` and trusting the body alone.
  // That mutant survived every other test in this file, including the one
  // directly above -- its 403 also carries success:false, so the body check
  // covers for the status check and the two halves of clearCache.ts:82 are
  // never told apart. Which makes deleting `!res.ok` look like a safe tidy:
  // every failure Cloudflare produces TODAY says success:false in the body.
  // It is not safe. The status check is the half that does not depend on the
  // envelope's shape surviving contact with something that is not Cloudflare
  // -- a TLS-inspecting corporate proxy, a captive portal, or a cached error
  // page -- any of which can hand back a 5xx whose body still parses as a
  // success. Believing that is the exact failure mode this handler was
  // written to avoid: the admin is told the cache was purged when it was not.
  it("fails on the HTTP status alone, even when the body claims success", async () => {
    stubFetch(async () => new Response(JSON.stringify({ success: true, result: { id: ZONE_ID } }), { status: 503 }));
    const res = await post();

    expect(res.headers.get("Location")).toBe("/admin/settings/?cache=failed");
    // The status is in the log because it is the operator's only clue as to
    // which of the two halves refused it.
    expect(consoleError).toHaveBeenCalledWith("clearcache: Cloudflare purge_cache failed (HTTP 503)", undefined);
    // And a failure is a failure however it was detected: no cooldown, so the
    // admin can retry the moment the proxy stops lying.
    expect(kv.store.has(COOLDOWN_KEY)).toBe(false);
  });

  // Cloudflare's edge serves an HTML error page often enough that this is a
  // real shape. It fails INSIDE res.json(), after the ok check has passed, so
  // a handler without the try/catch would 500 here rather than report failure.
  it("treats a 200 whose body is not JSON as a failure", async () => {
    stubFetch(async () => new Response("<html>520</html>", { status: 200 }));
    expect((await post()).headers.get("Location")).toBe("/admin/settings/?cache=failed");
  });

  // Includes the AbortSignal.timeout case: whatever the reason fetch rejects,
  // the admin gets an answer rather than a stack trace.
  it("treats an unreachable API as a failure, not a 500", async () => {
    stubFetch(async () => {
      throw new TypeError("network error");
    });
    const res = await post();

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/settings/?cache=failed");
    expect(consoleError).toHaveBeenCalledWith("clearcache: Cloudflare purge_cache could not be reached", expect.any(TypeError));
  });

  // Two things at once, and both are deliberate. The frag keys ARE gone even
  // though the CDN purge failed -- the KV clear happens first and is not
  // rolled back -- and NO cooldown is recorded, because a failed purge has to
  // be retryable immediately (clearCache.ts:143-145). An admin hitting the
  // button again after a transient 5xx must not be told to wait a minute.
  it("still clears KV, and leaves the button immediately retryable", async () => {
    warmFragCache();
    stubFetch(async () => new Response(JSON.stringify({ success: false, errors: [] }), { status: 500 }));
    await post();

    expect(kv.store.has(FRAG_KV_KEY_LAST_UPDATED)).toBe(false);
    expect(kv.store.has(FRAG_KV_KEY_NEED_HITS)).toBe(false);
    expect(kv.store.has(COOLDOWN_KEY)).toBe(false);

    // And the retry genuinely goes through rather than hitting a cooldown.
    stubFetch(purgeOk);
    expect((await post()).headers.get("Location")).toBe("/admin/settings/?cache=purged");
  });

  // SUSPECT, PINNED AS-IS: `payload?.success !== true` is a strict identity
  // check, so a v4 envelope carrying the string "true" reads as a failure.
  // Cloudflare sends a real boolean, so this is right today; it is asserted
  // rather than left implicit so that loosening it to `== true` (which would
  // also accept 1, "1" and " ") is a decision someone has to make on purpose.
  it("does not accept a stringly-typed success flag", async () => {
    stubFetch(async () => new Response(JSON.stringify({ success: "true" })));
    expect((await post()).headers.get("Location")).toBe("/admin/settings/?cache=failed");
  });
});

describe("adminClearCache -- KV itself failing", () => {
  // "A KV failure must not turn the button into a 500, so a failed read just
  // means no cooldown known" (clearCache.ts:97-98). Failing CLOSED here would
  // be worse than useless: KV read errors would make the purge button
  // permanently dead at exactly the moment an operator most wants it.
  it("purges anyway when the cooldown read fails", async () => {
    warmFragCache();
    kv.failing.get = true;
    stubFetch(purgeOk);
    const res = await post();

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/settings/?cache=purged");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith("clearcache: KV read of the cooldown marker failed, proceeding", expect.any(Error));
  });

  // THE MUTANT allSettled EXISTS TO KILL. Spell line 128 as Promise.all and
  // this test gets a 500 -- one flaky KV delete would abort the request
  // before the Cloudflare purge, which is the part that actually matters,
  // and the admin would see a stack trace for a cache that was left entirely
  // intact.
  it("still purges the CDN when one frag delete rejects", async () => {
    warmFragCache();
    kv.failing.deleteKeys.add(FRAG_KV_KEY_LAST_UPDATED);
    stubFetch(purgeOk);
    const res = await post();

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/settings/?cache=purged");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The sibling delete still landed -- allSettled runs both, it does not
    // stop at the first rejection.
    expect(kv.store.has(FRAG_KV_KEY_NEED_HITS)).toBe(false);
    expect(kv.store.get(FRAG_KV_KEY_LAST_UPDATED)).toBe(STALE_LAST_MODIFIED);
  });

  // SUSPECT, PINNED AS-IS: allSettled swallows the rejection with no logging
  // of any kind, so the outcome is still `purged` and the admin is told the
  // cache was cleared while one frag key survived -- the site keeps serving
  // a stale "last updated" until the 5-minute fragRefresh cron overwrites it.
  // Recoverable and low-harm, which is presumably why it is written this way,
  // but it is the one failure in this handler that produces no signal at all.
  it("reports success even though a frag key survived, and logs nothing", async () => {
    warmFragCache();
    kv.failing.deleteKeys.add(FRAG_KV_KEY_NEED_HITS);
    stubFetch(purgeOk);
    const res = await post();

    expect(res.headers.get("Location")).toBe("/admin/settings/?cache=purged");
    expect(kv.store.get(FRAG_KV_KEY_NEED_HITS)).toBe(STALE_HITS);
    expect(consoleError).not.toHaveBeenCalled();

    // And the visible consequence: /frag/need-hits/ still serves the stale
    // number after a purge the admin was told succeeded.
    expect(await (await get("/frag/need-hits/")).text()).toBe("11");
  });

  // The cooldown is a courtesy guard, not a lock. Losing the marker write
  // costs a possible second purge; failing the request would cost the purge
  // that already succeeded, which is strictly worse.
  it("still reports success when the marker write fails", async () => {
    kv.failing.put = true;
    stubFetch(purgeOk);
    const res = await post();

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/settings/?cache=purged");
    expect(kv.store.has(COOLDOWN_KEY)).toBe(false);
    expect(consoleError).toHaveBeenCalledWith("clearcache: KV write of the cooldown marker failed", expect.any(Error));
  });
});

// ---------------------------------------------------------------------------
// The cooldown
// ---------------------------------------------------------------------------

describe("adminClearCache -- the 60s cooldown", () => {
  // The double-click this guard exists for, end to end through the real
  // handler twice rather than through a hand-set marker.
  it("refuses a second press moments after the first", async () => {
    warmFragCache();
    stubFetch(purgeOk);
    expect((await post()).headers.get("Location")).toBe("/admin/settings/?cache=purged");

    const second = await post();
    expect(second.headers.get("Location")).toBe("/admin/settings/?cache=cooldown");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // A cooldown is a COMPLETE no-op, not "KV cleared but the CDN skipped": the
  // whole else-branch is behind it. Worth pinning because the alternative
  // reading -- clear the free thing, skip the rate-limited one -- is a
  // plausible "improvement" that would make the second click of a double-click
  // silently different from the first.
  it("touches nothing at all: no delete, no fetch, no new marker", async () => {
    warmFragCache();
    const marker = String(Date.now() - 10_000);
    kv.store.set(COOLDOWN_KEY, marker);
    await post();

    expect(fragCacheIntact()).toBe(true);
    expect(kv.delete).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    // The original marker stands -- the cooldown does not slide forward on a
    // refused press, so it expires 60s after the PURGE rather than 60s after
    // the last impatient click.
    expect(kv.store.get(COOLDOWN_KEY)).toBe(marker);
  });

  it("lets a purge through once the marker is a minute old", async () => {
    kv.store.set(COOLDOWN_KEY, String(Date.now() - COOLDOWN_MS));
    stubFetch(purgeOk);
    expect((await post()).headers.get("Location")).toBe("/admin/settings/?cache=purged");
  });

  // The boundary is `elapsed < 60_000`, strictly. Pinned with a frozen clock
  // because a real one cannot tell 59,999ms from 60,000ms reliably, and an
  // off-by-one here is the difference between a guard and a guard that lets
  // every second press through.
  it("is strict about the boundary: 59,999ms blocks, 60,000ms does not", async () => {
    const now = Date.parse("2026-09-06T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    kv.store.set(COOLDOWN_KEY, String(now - (COOLDOWN_MS - 1)));
    expect((await post()).headers.get("Location")).toBe("/admin/settings/?cache=cooldown");

    kv.store.set(COOLDOWN_KEY, String(now - COOLDOWN_MS));
    stubFetch(purgeOk);
    expect((await post()).headers.get("Location")).toBe("/admin/settings/?cache=purged");
  });

  // SUSPECT, PINNED AS-IS: `Number(last)` on a marker KV never wrote -- a
  // hand-edited key, a partial write, a value from some future format -- is
  // NaN, and `NaN < 60_000` is false, so the guard silently disappears. That
  // is the right way round (a purge button that works is better than one
  // wedged shut by a bad cache key) but it means the guard's failure mode is
  // invisible: nothing logs, and the only symptom is that the cooldown no
  // longer exists.
  it("ignores a marker it cannot parse and purges", async () => {
    kv.store.set(COOLDOWN_KEY, "not-a-timestamp");
    stubFetch(purgeOk);
    const res = await post();

    expect(res.headers.get("Location")).toBe("/admin/settings/?cache=purged");
    // ...and the unparseable value is replaced with a good one, so the state
    // is self-healing rather than permanently degraded.
    expect(Number(kv.store.get(COOLDOWN_KEY))).toBeGreaterThan(0);
  });

  // SUSPECT, PINNED AS-IS: the check is a subtraction, not a comparison
  // against a window, so a marker dated in the FUTURE yields a negative
  // elapsed time, which is `< 60_000`, which is a cooldown -- and the button
  // stays dead until real time catches up. Only this handler writes the key
  // (always with Date.now()), so the only routes in are a hand-run
  // `wrangler kv key put` or a clock that moved backwards. Asserted so that
  // the failure is documented rather than discovered during an incident,
  // which is exactly when this button gets pressed.
  it("treats a future-dated marker as an indefinite cooldown", async () => {
    kv.store.set(COOLDOWN_KEY, String(Date.now() + 60 * 60 * 1000));
    const res = await post();

    expect(res.headers.get("Location")).toBe("/admin/settings/?cache=cooldown");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // An empty string is falsy, so it fails the `last &&` guard before Number()
  // is ever reached -- the same end as the NaN case, by a different route.
  it("ignores an empty marker", async () => {
    kv.store.set(COOLDOWN_KEY, "");
    stubFetch(purgeOk);
    expect((await post()).headers.get("Location")).toBe("/admin/settings/?cache=purged");
  });
});
