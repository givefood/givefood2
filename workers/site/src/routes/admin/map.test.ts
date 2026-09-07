import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { url, urlForLocale } from "@givefood/urls";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/admin/map.ts -- /admin/map/, the whole-country MapLibre view.
//
// THE HANDLER COMPUTES ALMOST NOTHING, WHICH IS THE POINT. Django's
// admin_map() (gfadmin/views.py:2730-2743) touches no ORM at all: it builds a
// five-key dict, json.dumps()es it into the template, and the BROWSER fetches
// the ~8,700 features itself from the public /needs/geo.json feed. So there is
// no row to read back and no write to prove -- and the interesting ways for
// this page to break are therefore all OUTSIDE the function:
//
//   - the config is a JSON literal pasted into a <script>. Lose the `|safe`
//     filter in mapconfig.njk and Nunjucks autoescapes it into `&#34;`, the
//     script is a syntax error, the map never initialises -- and the server
//     still returns a perfectly good 200. Nobody sees an error.
//   - `geojson` names a URL. If that route moves, is renamed, or acquires a
//     locale prefix, the browser gets a 404 and draws an EMPTY map. Again a
//     200, again no error anywhere the maintainer looks.
//   - the route is registered on one line of routes/admin/index.ts, inside
//     adminApp and therefore behind requireAdminAuth. Registered on the wrong
//     app, or with the wrong method, and the whole of this is moot.
//   - #map has no intrinsic height. Lose the stylesheet block and MapLibre
//     initialises into a 0px-high div: a blank page with a working map in it.
//
// That is issue #34's shape (a Place ID parsed, passed down, written by no SQL
// at all, and redirected as though it had worked) transposed to a read-only
// page: everything reports success, nothing is actually delivered. So these
// tests drive the REAL PRODUCTION APP -- workers/site/src/index.ts's default
// export, the same object the Worker runs -- rather than calling adminMap(c)
// with a hand-built Context. That gets the real mount, the real auth gate, the
// real APPEND_SLASH fallback and the real cache-control middleware, and it
// lets the config's `geojson` URL be FETCHED, from this same app, against a
// real seeded database, rather than merely string-compared.
//
// REAL EVERYTHING. Real Hono router, real Nunjucks templates, real in-memory
// SQLite built from the real migrations. Mocked: only what leaves the machine
// or has no local implementation -- the SESSIONS/DATA KV namespaces (Maps) and
// global fetch (stubbed to THROW, since this page must make no outbound call
// at all).
//
// MUTATION-TESTED (TESTING.md's "some suites were mutation-tested"), twice.
// The whole chain -- routes/admin/map.ts, its two mount lines, the precompiled
// templates, the feed's db queries and the surrounding middleware -- was
// transformed in memory by a vite plugin outside the repo and this file re-run
// against each mutant. 41 mutants: 40 killed, 1 deliberately left alive and
// explained at the bottom of this comment. The tests carrying the second round
// are marked "MUTANT:" below, and every one of them was written because the
// mutant SURVIVED the 25 tests that were here first:
//
//   - maplibre-gl.js `defer` -> `async`. Nothing asserted the attribute, and
//     it is the one that decides whether init() can see maplibregl at all.
//   - the maplibre-gl.css <link> deleted, and the `?v=` cache-buster removed
//     from both maplibre assets. Only wfbn.js's tag was ever asserted.
//   - adminPageContext's `admin_user` dropped. The handler spreads that whole
//     context into the page and only `section` and the Google keys were
//     checked -- so the unauthenticated test's `not.toContain(ADMIN_EMAIL)`
//     was passing without anything ever proving the email renders when it
//     SHOULD. A vacuous negative is worse than no negative.
//   - the APPEND_SLASH redirect rebuilt from origin+pathname, dropping the
//     query string.
//   - Content-Language deleted, and language switched to Accept-Language.
//
// The same pass found the file asserting a REDIRECT IT NEVER FOLLOWED, which
// is the read-only shape of issue #34. lib/appendSlash.ts probes with a
// cookie-less HEAD, so requireAdminAuth's 302 satisfies its "not a 404" guard
// and EVERY slash-less /admin/ URL 301s, existing or not -- meaning the
// original "301s the slash-less URL" test would have passed with the map route
// deleted outright. It now follows the Location, and the divergence it depends
// on is pinned in its own test and reported.
//
// The one mutant NOT killed by following the feed is the interesting result:
// /cy/needs/geo.json answers 200 with valid GeoJSON, so a map pointed at the
// locale-prefixed feed still draws. That is precisely why the unprefixed-feed
// test compares the URL as well as fetching it -- "it resolves" is not the
// claim, "it is the URL Django's reverse() produces outside i18n_patterns" is.
//
// ONE MUTANT IS DELIBERATELY LEFT ALIVE, and it is documented rather than
// chased: replacing pageCacheControl.ts:158's `c.get("csrfIssued")` guard with
// `false` changes nothing here. It cannot: noStore has already set a
// Cache-Control by then and pageCacheControl.ts:135 returns before the guard
// is reached. That flag's own regression test lives where it belongs, in
// middleware/pageCacheControl.test.ts:595. See the CSRF test below, whose
// comment used to claim this file pinned it.

const ORIGIN = "https://www.givefood.org.uk";
const SESSION_ID = "test-admin-session-id";
const ADMIN_EMAIL = "someone@givefood.org.uk";

// Distinctive, so "the key is in the page" and "the key is in the map config"
// are separable assertions rather than two views of the same substring.
const STATIC_KEY = "gmap-static-key-not-a-real-one";
const GEOCODE_KEY = "gmap-geocode-key-not-a-real-one";

type Bindable = null | number | bigint | string | Uint8Array;

// The D1PreparedStatement surface packages/db uses, over node:sqlite -- the
// same shim donationPoint.test.ts and clearCache.test.ts use. D1 is async and
// node:sqlite synchronous; the SQL text, the binding and the NULL semantics
// are SQLite's on both sides.
//
// `log` records every statement prepared and the counter below every
// withSession() call, because for THIS handler the load-bearing assertion is
// that both stay empty: Django's view issues no query, and a port that quietly
// grew one would be running it on a page whose data comes from elsewhere.
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

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let statements: string[];
let withSessionCalls: number;
let kv: Map<string, string>;
let sessionKv: Map<string, string>;
let fetchMock: ReturnType<typeof vi.fn>;

function env(): AppEnv["Bindings"] {
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
      put: async (key: string, value: string) => void kv.set(key, value),
      delete: async (key: string) => void kv.delete(key),
    },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    GMAP_STATIC_KEY: STATIC_KEY,
    GMAP_GEOCODE_KEY: GEOCODE_KEY,
    D1_DATABASE_NAME: "givefood-test",
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

// ---------------------------------------------------------------------------
// Seed data for the feed the map fetches.
//
// One OPEN food bank, location and donation point -- the three feature types
// the handler's own comment claims the feed carries -- and a CLOSED one of
// each, which must NOT appear. The closed rows are the point: a feed that lost
// its `WHERE is_closed = 0` would pass every test that only ever seeded rows
// it wanted back, and would put markers on the admin's map for food banks that
// shut years ago.
// ---------------------------------------------------------------------------

function seed(): void {
  const latOf = (latLng: string) => Number(latLng.split(",")[0]);
  const lngOf = (latLng: string) => Number(latLng.split(",")[1]);

  const foodbank = (id: number, name: string, slug: string, latLng: string, isClosed: number) =>
    db
      .prepare(
        `INSERT INTO foodbank (id, uuid, name, slug, address, postcode, country, lat_lng, latitude, longitude,
           network, charity_just_foodbank, contact_email, url, shopping_list_url, address_is_administrative,
           is_closed, no_locations, days_between_needs, created, modified)
         VALUES (?, ?, ?, ?, '1 Old Road', 'SP1 1AA', 'England', ?, ?, ?,
           'Trussell', 0, 'a@b.invalid', 'https://example.invalid/', 'https://example.invalid/list', 0,
           ?, 0, 7, '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
      )
      .run(id, `uuid-fb-${id}`, name, slug, latLng, latOf(latLng), lngOf(latLng), isClosed);

  const location = (id: number, name: string, slug: string, latLng: string, isClosed: number) =>
    db
      .prepare(
        `INSERT INTO foodbanklocation (id, uuid, foodbank_id, name, slug, address, postcode, country,
           lat_lng, latitude, longitude, is_closed, modified)
         VALUES (?, ?, 1, ?, ?, '2 New Road', 'SP1 2BB', 'England', ?, ?, ?, ?, '2020-01-01 00:00:00.000000')`,
      )
      .run(id, `uuid-loc-${id}`, name, slug, latLng, latOf(latLng), lngOf(latLng), isClosed);

  const donationPoint = (id: number, name: string, slug: string, latLng: string, isClosed: number) =>
    db
      .prepare(
        `INSERT INTO foodbankdonationpoint (id, uuid, foodbank_id, name, slug, address, postcode, country,
           lat_lng, latitude, longitude, is_closed, in_store_only, modified)
         VALUES (?, ?, 1, ?, ?, '3 High Street', 'SP1 3CC', 'England', ?, ?, ?, ?, 0, '2020-01-01 00:00:00.000000')`,
      )
      .run(id, `uuid-dp-${id}`, name, slug, latLng, latOf(latLng), lngOf(latLng), isClosed);

  foodbank(1, "Salisbury", "salisbury", "51.0700,-1.7900", 0);
  foodbank(2, "Long Gone", "long-gone", "52.0000,-2.0000", 1);
  location(1, "Bemerton Heath", "bemerton-heath", "51.0800,-1.8000", 0);
  location(2, "Shut Hall", "shut-hall", "51.0900,-1.8100", 1);
  donationPoint(1, "Tesco Extra", "tesco-extra", "51.0600,-1.7800", 0);
  donationPoint(2, "Boarded Up", "boarded-up", "51.0500,-1.7700", 1);
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  seed();
  statements = [];
  withSessionCalls = 0;
  kv = new Map();
  sessionKv = new Map([
    [
      // Exactly as lib/adminAuth.ts createSession() writes one. expiresAt a
      // full TTL out so getAdminSession's sliding refresh does not fire and
      // add an incidental SESSIONS.put to every request.
      `admin-session:${SESSION_ID}`,
      JSON.stringify({ email: ADMIN_EMAIL, name: "Some One", givenName: "Some", picture: "", expiresAt: Date.now() + 12 * 60 * 60 * 1000 }),
    ],
  ]);
  // Nothing on this page may leave the machine -- the tiles come from a
  // keyless third-party server the BROWSER talks to, and the features come
  // from this same Worker. An outbound call added here fails loudly rather
  // than silently costing a subrequest on every map view.
  fetchMock = vi.fn(async (input: unknown) => {
    throw new Error(`unmodelled fetch: ${String(input)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Fetched {
  res: Response;
  body: string;
}

/** A request through the production app, signed in as an admin by default.
 *  `csrfCookie` is the signed `__Host-csrf` value a browser would already be
 *  holding from an earlier admin page -- the returning-visitor path, which
 *  lib/csrf.ts treats completely differently from a first visit. */
async function request(path: string, opts: { method?: string; signedIn?: boolean; csrfCookie?: string } = {}): Promise<Fetched> {
  const headers: Record<string, string> = {};
  const cookies: string[] = [];
  if (opts.signedIn !== false) cookies.push(`__Host-gfsession=${SESSION_ID}`);
  if (opts.csrfCookie) cookies.push(`__Host-csrf=${opts.csrfCookie}`);
  if (cookies.length) headers.Cookie = cookies.join("; ");
  const res = await app.fetch(new Request(`${ORIGIN}${path}`, { method: opts.method ?? "GET", headers }), env(), execCtx);
  return { res, body: await res.text() };
}

/** The signed `__Host-csrf` cookie value a response hands the browser. */
function csrfCookieFrom(res: Response): string {
  const value = res.headers.get("Set-Cookie")?.match(/__Host-csrf=([^;]+)/)?.[1];
  if (!value) throw new Error("response set no __Host-csrf cookie");
  return value;
}

const getMap = (): Promise<Fetched> => request("/admin/map/");

/** The JSON literal mapconfig.njk writes into `window.gfMapConfig`, parsed.
 *  Deliberately parsed rather than substring-matched: the browser has to
 *  JSON-parse it too, and a page that merely CONTAINS the right characters
 *  while being HTML-escaped around them is exactly the failure this catches. */
function rawMapConfig(html: string): string {
  const match = html.match(/window\.gfMapConfig = (.+);/);
  if (!match) throw new Error("no window.gfMapConfig assignment in the page");
  return match[1]!;
}

function mapConfig(html: string): Record<string, unknown> {
  return JSON.parse(rawMapConfig(html)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Getting to the page at all -- the mount, the gate, the method
// ---------------------------------------------------------------------------

describe("adminMap -- reaching the page", () => {
  // gfadmin/tests/test_map_view.py::test_map_page_returns_200, ported.
  it("renders for a signed-in admin", async () => {
    const { res, body } = await getMap();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(body).toContain('<div id="map"></div>');
  });

  // requireAdminAuth is applied to adminApp as a whole (routes/admin/index.ts:
  // 85), so this is a test of the MOUNT as much as of the middleware. The
  // config this page carries is not a secret, but the nav it renders leaks the
  // admin's email address, and a page registered above the gate would be one
  // more admin URL served to the internet.
  it("sends an unauthenticated visitor to sign in, and renders nothing", async () => {
    const { res, body } = await request("/admin/map/", { signedIn: false });

    expect(res.status).toBe(302);
    // The path travels as a query param, so the admin lands back on the map
    // after Google rather than on /admin/.
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fmap%2F");
    expect(body).not.toContain("gfMapConfig");
    expect(body).not.toContain(ADMIN_EMAIL);
    // adminPageContext mints a CSRF token for every page it builds. A gate
    // that ran AFTER the handler would show up here as a token issued to an
    // anonymous request.
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  // A DELIBERATE NARROWING, not parity, and it is written down here because
  // the obvious guess about Django is wrong. routes/admin/index.ts:216 is
  // `adminApp.get(...)`, singular, so a POST 404s. Django's urls/core.py:13 is
  // a plain function view with no `require_POST` and no method branch, and
  // CsrfViewMiddleware is COMMENTED OUT at givefood/settings.py:97 -- so a POST
  // there did not 405 and did not 403, it rendered the page and returned 200.
  // Checked by running it (TESTING.md's "parity claims are checked by running
  // Python"): Django 5.2.6, the same middleware list minus the commented-out
  // CSRF entry, plain function view -- GET 200, POST 200.
  //
  // Refusing POST on a view that reads nothing and writes nothing costs
  // nothing and is the right call; what it must not do is quietly become a
  // route that ACCEPTS a POST later. Asserted with a VALID session, so the 404
  // proves the route is absent rather than that the auth gate fired first.
  it("is registered on GET only, so a POST never reaches the handler -- unlike Django, which answered it", async () => {
    const { res, body } = await request("/admin/map/", { method: "POST" });

    expect(res.status).toBe(404);
    expect(body).not.toContain("gfMapConfig");
  });

  // The MOUNT-side half of the handler's own "gfadmin is mounted OUTSIDE
  // i18n_patterns" claim -- the other half being the unprefixed `geojson` URL
  // asserted further down. Django's admin is included at givefood/urls.py:97,
  // in the untranslated block, so /cy/admin/map/ resolves to nothing there and
  // must resolve to nothing here either. It matters beyond tidiness: index.ts
  // registers a noStore for "/admin/*" (index.ts:137-138) and nothing for
  // "/:locale/admin/*", so a locale-prefixed twin of this page would be an
  // admin page carrying an admin's email address and a CSRF cookie WITHOUT the
  // no-store header -- the exact shape of the beta incident middleware/
  // noStore.ts's header records, where Cloudflare cached authenticated admin
  // pages at the edge and served them, uncached-Worker, to anonymous visitors.
  it("has no locale-prefixed twin", async () => {
    expect((await request("/cy/admin/map/")).res.status).toBe(404);
    // Not even via the APPEND_SLASH fallback, which 301s /admin/map above.
    expect((await request("/cy/admin/map")).res.status).toBe(404);
  });

  // PLAN.md §3.5 APPEND_SLASH, via index.ts's app.notFound() ->
  // tryAppendSlashRedirect. Django ran with APPEND_SLASH for a decade, so the
  // slash-less form is what a maintainer's muscle memory and browser history
  // will produce. A 301, not a rewrite, exactly as Django's.
  // THE REDIRECT IS FOLLOWED, not merely read. "A 301 with the right Location"
  // is the read-only twin of issue #34's "it redirected as though it had
  // worked" -- and on this route that is not a hypothetical worry, because of
  // the divergence pinned in the very next test: /admin/<anything> 301s,
  // whether or not <anything> exists. So the Location alone proves nothing
  // about this page, and the second half of this test is what makes the first
  // half mean anything.
  it("301s the slash-less URL to the canonical one, which really serves the map", async () => {
    const { res } = await request("/admin/map");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/admin/map/`);

    const followed = await request(new URL(res.headers.get("Location")!).pathname);
    expect(followed.res.status).toBe(200);
    expect(followed.body).toContain("window.gfMapConfig");
  });

  // SUSPECT, PINNED AS-IS, AND REPORTED RATHER THAN FIXED (TESTING.md: tests
  // pin current behaviour). A signed-in admin who mistypes any /admin/ URL
  // without a trailing slash gets a 301 to a page that then 404s, instead of
  // the 404 Django gives.
  //
  // The cause is in lib/appendSlash.ts, and it is a good one: the probe it
  // sends is `new Request(slashed, { method: "HEAD" })` -- a fresh request with
  // NO headers copied from the original, so no Cookie, so no session. Every
  // path under /admin therefore answers that probe with requireAdminAuth's 302,
  // and the guard is `probe.status !== 404 && probe.status !== 501`, which a
  // 302 passes. The redirect fires for admin URLs that do not exist.
  //
  // Django does not do this. CommonMiddleware.should_redirect_with_slash()
  // calls is_valid_path(), which only RESOLVES the path against the URLconf --
  // it never runs the view and never touches authentication -- so an
  // unresolvable /admin/nonexistent 404s directly (read from
  // django/middleware/common.py in the reference tree).
  //
  // Harmless today: one wasted round trip, and the 404 still arrives. It is
  // written down because the shape is a trap for anyone who later asserts
  // "/admin/<x> 301s, therefore /admin/<x>/ is a real route" -- which is
  // exactly what the test above would otherwise have been claiming.
  it("301s slash-less admin URLs that do not exist either -- so the 301 above is not evidence the route exists", async () => {
    const { res } = await request("/admin/mapp");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/admin/mapp/`);
    // ...and following it lands on the 404 the request should have got first.
    expect((await request("/admin/mapp/")).res.status).toBe(404);
  });

  // MUTANT: `new URL(url.toString())` -> `new URL(url.origin + url.pathname)`
  // in lib/appendSlash.ts. Survived every test above, because none of them
  // ever sent a query string. Django's CommonMiddleware builds the APPEND_SLASH
  // target with `request.get_full_path(force_append_slash=True)`, which keeps
  // the query, and the port keeps it only as a side effect of copying the whole
  // URL before touching `.pathname` -- a one-line "tidy-up" to build the target
  // from its parts is exactly how that gets lost.
  //
  // It is not academic on THIS page even though adminMap reads no parameters:
  // the admin arrives here from links and pasted URLs that carry Cloudflare's
  // and Google's own tracking parameters, and every ported admin list page
  // behind the same redirect DOES read ?page= and ?q=. A redirect that silently
  // drops the query sends the maintainer to page 1 of a 40-page list with no
  // indication anything was thrown away.
  it("keeps the query string on that redirect, as Django's get_full_path does", async () => {
    const { res } = await request("/admin/map?foo=bar&x=1");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/admin/map/?foo=bar&x=1`);
  });

  // MUTANT: delete resolveLanguage.ts's `c.header("Content-Language", ...)`,
  // and separately make it read Accept-Language instead of the path prefix.
  // Both survived, because nothing in this file had ever sent an
  // Accept-Language header or looked at the response's language at all.
  //
  // PLAN.md §3.5 is emphatic -- "Language resolution: reproduce exactly, do not
  // improve". The URL prefix is the ONLY thing that ever selects a language;
  // Django computes Accept-Language and then discards it. /admin/map/ has no
  // prefix and (per the locale-twin test above) must never acquire one, so this
  // page is English for everyone, and its legend strings -- which really do go
  // through `_()` in maplegend.njk -- must not start translating themselves for
  // an admin whose browser asks for Welsh.
  //
  // `Vary: Accept-Language` is nonetheless appended, on a response that ignores
  // Accept-Language entirely. That is not a defect: resolveLanguage adds it for
  // any first path segment that is neither a registered prefix nor "en", which
  // is what Django emits for the same URLs, and it costs nothing here because
  // noStore has already made the response unstoreable. Pinned in the same
  // assertion as `Vary: Cookie` so that the two -- one from noStore, one from
  // resolveLanguage, appended to the same header by different middleware -- are
  // known to coexist rather than overwrite one another.
  it("is English whatever the browser asks for, and varies on a header it never reads", async () => {
    const res = await app.fetch(
      new Request(`${ORIGIN}/admin/map/`, { headers: { Cookie: `__Host-gfsession=${SESSION_ID}`, "Accept-Language": "cy, en;q=0.5" } }),
      env(),
      execCtx,
    );
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Language")).toBe("en");
    expect(res.headers.get("Vary")).toBe("Cookie, Accept-Language");
    // maplegend.njk's rows come from the catalogue, so an accidental switch to
    // content negotiation shows up here as Welsh rather than as a header.
    expect(body).toContain("Organisation");
    expect(body).toContain("Donation point");
  });

  // THE "GET DOES NOT MUTATE" TEST, in the only form that means anything for a
  // view whose Django original has no ORM access at all: it must not open a
  // database session, never mind write through one. A page that grew an
  // incidental query would be doing it on the one admin page whose payload is
  // already ~8,700 features fetched by a separate request.
  //
  // The DATA namespace is checked for the same reason one step out: several
  // ported handlers memoise a rendered fragment into KV, and this page has
  // nothing worth memoising and no key that could be scoped to one admin.
  // A write appearing here is a mutation on a GET however harmless it looks.
  it("opens no database session, issues no SQL and writes nothing to KV", async () => {
    const { res } = await getMap();

    expect(res.status).toBe(200);
    expect(withSessionCalls).toBe(0);
    expect(statements).toEqual([]);
    expect(kv.size).toBe(0);
  });

  // The map's tiles are fetched by the BROWSER from a keyless third-party
  // server (wfbn.js:112) and its features by the browser from this same
  // Worker. The Worker itself calls nothing.
  it("makes no outbound request of its own", async () => {
    await getMap();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // adminPageContext issues a CSRF token on every admin page, so this response
  // carries a per-visitor __Host-csrf cookie -- and middleware/noStore.ts's own
  // header records the beta 2026-09-02 incident in which admin pages were
  // served from Cloudflare's cache to anonymous visitors, WITHOUT the Worker
  // (and therefore requireAdminAuth) ever running. /admin/* is covered by that
  // middleware at index.ts:137-138; this asserts the map page is really inside
  // the cover, which is a fact about the mount, not about the handler.
  it("is never stored by any cache", async () => {
    const { res } = await getMap();

    expect(res.headers.get("Set-Cookie")).toContain("__Host-csrf=");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("Cache-Control")).toContain("private");
    expect(res.headers.get("CDN-Cache-Control")).toBe("no-store");
    expect(res.headers.get("Vary")).toContain("Cookie");
  });

  // THE RETURNING-VISITOR PATH, and the reason this page -- which has no form
  // of its own and so looks like it could not possibly cost anyone their work
  // -- gets a test about CSRF at all. lib/csrf.ts's issueCsrfToken has two
  // return paths, and BOTH have already caused an incident:
  //
  //   - minting unconditionally REPLACED the cookie on every admin render, and
  //     verifyCsrf requires the submitted field to equal the cookie exactly. So
  //     a rotation here would mean: open a food bank's edit form, glance at the
  //     map in a second tab, come back, press Save, 403 -- with the form's
  //     contents gone. Every admin page calls this via adminPageContext, and a
  //     map is exactly the sort of page an admin leaves open in another tab.
  //   - the reuse path that fixed it sends NO Set-Cookie, and
  //     middleware/pageCacheControl.ts had keyed its per-visitor guard on
  //     Set-Cookie: on 2026-09-06 a returning visitor's page was therefore
  //     stamped `public, s-maxage=86400` and served to everyone else. The
  //     guard is now the causal `csrfIssued` flag.
  //
  // So the second visit is asserted rather than assumed: the token is reused,
  // and the response is still uncacheable WITHOUT a Set-Cookie to hint at it.
  //
  // BE PRECISE ABOUT WHICH HALF OF THAT THIS TEST ACTUALLY PINS, because the
  // comment here previously claimed both and mutation testing said otherwise.
  // The reuse IS pinned (blanking csrf.ts's `if (existing)` branch fails this
  // test). The csrfIssued guard is NOT, and cannot be on an /admin/ URL:
  // noStore has already set a Cache-Control, so pageCacheControl.ts:135
  // returns long before reaching the guard on :158 -- replacing that guard
  // with `false` leaves every test in this file green. What the second half of
  // this test really pins is that noStore covers the returning-visitor path
  // too, which is worth having (deleting index.ts's `app.use("/admin/*",
  // noStore)` fails here) but is a different claim. The 2026-09-06 regression
  // itself is covered by middleware/pageCacheControl.test.ts:595, on a public
  // CSRF-bearing page where the flag is the only thing standing up.
  it("reuses an existing CSRF cookie and stays uncacheable on the visit that sets none", async () => {
    const first = await getMap();
    const held = csrfCookieFrom(first.res);

    const { res } = await request("/admin/map/", { csrfCookie: held });

    expect(res.status).toBe(200);
    // Not rotated: nothing an admin has open in another tab was invalidated.
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("Cache-Control")).toContain("private");
    expect(res.headers.get("CDN-Cache-Control")).toBe("no-store");
  });
});

// ---------------------------------------------------------------------------
// The config -- the only thing this view computes
// ---------------------------------------------------------------------------

describe("adminMap -- the map config", () => {
  // gfadmin/tests/test_map_view.py::test_map_page_contains_map_config, ported
  // and then taken considerably further: Django's test asserts the STRING
  // "window.gfMapConfig" appears. That passes just as happily when the object
  // beside it is HTML-escaped rubbish.
  it("reaches the browser as parseable JSON, not as escaped HTML", async () => {
    const { body } = await getMap();

    // The `|safe` in includes/mapconfig.njk. Without it Nunjucks renders
    // `{&#34;geojson&#34;:...}`, the <script> throws a SyntaxError, init()
    // never runs, and the server still says 200.
    expect(body).toContain('window.gfMapConfig = {"geojson"');
    expect(body).not.toContain("&#34;geojson&#34;");
    expect(() => mapConfig(body)).not.toThrow();
  });

  // views.py:2733-2737, key for key. 55.4,-4 is the centre of Great Britain
  // at zoom 5 -- the whole country in frame. Transposed to -4,55.4 it is the
  // Southern Ocean, which is why the pair is asserted as values and not just
  // as "two numbers are present".
  it("carries exactly Django's five keys and values", async () => {
    const { body } = await getMap();

    expect(mapConfig(body)).toEqual({
      geojson: "/needs/geo.json",
      lat: 55.4,
      lng: -4,
      zoom: 5,
      location_marker: false,
    });
  });

  // wfbn.js:246 is `if (hasPosition && config.location_marker === true)` --
  // STRICT equality against `true`, so the flag has to survive as a real
  // boolean. The failure is silent and one-directional: JSON.stringify on the
  // string "false" emits `"location_marker":"false"`, which is truthy, and
  // every admin's map grows a "you are here" dot at 55.4,-4 -- a field near
  // Dumfries -- with nothing logged anywhere.
  //
  // The three number assertions are a weaker claim, deliberately kept as one:
  // wfbn.js:121 reads the coordinates through parseFloat, which would swallow
  // "55.4" quite happily, so a stringified lat/lng is a wire-format regression
  // rather than a broken map. Pinned because Django's json.dumps emits numbers
  // here and the config is a documented shape that other readers may grow.
  it("keeps the JSON types the browser's strict comparisons need", async () => {
    const config = mapConfig((await getMap()).body);

    expect(config.location_marker).toBe(false);
    expect(typeof config.location_marker).toBe("boolean");
    expect(typeof config.lat).toBe("number");
    expect(typeof config.lng).toBe("number");
    expect(typeof config.zoom).toBe("number");
  });

  // The handler uses url(), not urlForLocale(), and the difference is not
  // cosmetic: "wfbn:geojson" IS in @givefood/urls' I18N_SCOPED set, so the
  // locale-aware form yields a DIFFERENT, equally live feed. Django reaches
  // the same answer structurally -- gfadmin is mounted outside i18n_patterns
  // (givefood/urls.py:97), so reverse() there cannot produce a prefix. Both
  // URLs are fetched here, so this pins a real choice between two working
  // endpoints rather than an accident that only one exists.
  it("names the unprefixed feed, as Django's reverse() outside i18n_patterns does", async () => {
    const config = mapConfig((await getMap()).body);

    expect(config.geojson).toBe(url("wfbn:geojson"));
    expect(config.geojson).toBe("/needs/geo.json");
    expect(urlForLocale("cy", "wfbn:geojson")).toBe("/cy/needs/geo.json");
    expect(config.geojson).not.toBe(urlForLocale("cy", "wfbn:geojson"));
    expect((await request("/cy/needs/geo.json")).res.status).toBe(200);
  });

  // The handler's header is emphatic that NO API KEY of any kind is involved
  // in this map -- MapLibre against a keyless tile server, features from this
  // Worker. page.njk nonetheless publishes two Google keys to EVERY admin page
  // for admin.js's lookup buttons, so "the page contains a key" is true and
  // "the map uses one" is not. Both halves are asserted so that a future
  // attempt to wire the map to Google Maps has to change a test that says why
  // it is keyless.
  // THE WIRE FORMAT, which the toEqual above cannot see: JSON.parse is blind
  // to key order and to whitespace, so a config rebuilt in a different order,
  // or "helpfully" pretty-printed, passes every other test in this file. Pinned
  // as the exact literal because this is a documented shape other readers may
  // grow (wfbn.js:447 already reaches for a `max_zoom` key that is not here),
  // and because the ordering is Django's dict literal order, key for key.
  //
  // AND IT RECORDS A REAL DIVERGENCE. Django's `json.dumps(map_config)` uses
  // the default separators `(', ', ': ')`, so views.py:2739 emits
  // `{"geojson": "/needs/geo.json", "lat": 55.4, ...}` -- with a space after
  // every colon and comma. JSON.stringify emits none. Checked by running
  // CPython, per TESTING.md, not by reading the docs. It is invisible to
  // JSON.parse and therefore harmless, but it is worth writing down: this
  // codebase reproduces those exact separators elsewhere on purpose (see
  // lib/buildGeojson.ts's header on toDjangoJsonFormat, where byte-equality
  // with Django IS the contract), so the next person to find this difference
  // should find the note saying it is deliberate rather than "fix" a config
  // that no byte-comparison anywhere depends on.
  it("emits the port's compact JSON, not Django's spaced json.dumps", async () => {
    const { body } = await getMap();

    expect(rawMapConfig(body)).toBe('{"geojson":"/needs/geo.json","lat":55.4,"lng":-4,"zoom":5,"location_marker":false}');
  });

  it("contains no API key, on a page that does carry two", async () => {
    const { body } = await getMap();
    const rawConfig = rawMapConfig(body);

    expect(Object.keys(mapConfig(body))).toHaveLength(5);
    expect(rawConfig).not.toContain(STATIC_KEY);
    expect(rawConfig).not.toContain(GEOCODE_KEY);
    // ...while the page-wide globals admin.js reads are present as ever, two
    // populated and two deliberately empty (see pageContext.ts).
    expect(body).toContain(`const gmap_static_key = "${STATIC_KEY}";`);
    expect(body).toContain(`const gmap_geocode_key = "${GEOCODE_KEY}";`);
    expect(body).toContain('const gmap_key = "";');
    expect(body).toContain('const gmap_places_key = "";');
  });
});

// ---------------------------------------------------------------------------
// The feed the config points at -- followed, not just string-compared
// ---------------------------------------------------------------------------

describe("adminMap -- the feed the config names", () => {
  // The round-trip equivalent of reloading an edit form: take the URL the page
  // just told the browser to fetch, fetch it from the same app against the
  // same database, and look at what comes back. A config naming a path nobody
  // serves is precisely issue #34's failure mode in read-only form -- 200 on
  // the page, 404 in the background, a blank map, and no error anywhere.
  it("is really served by this app, and answers with GeoJSON", async () => {
    const config = mapConfig((await getMap()).body);
    const { res, body } = await request(config.geojson as string, { signedIn: false });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(body).type).toBe("FeatureCollection");
  });

  // The handler's comment describes the payload as "every open food bank,
  // location and donation point". Both halves are checked, because a feed that
  // returned only food banks, or that had lost its is_closed filter, would
  // still satisfy a test that merely counted features. The closed rows seeded
  // in seed() exist for exactly this assertion.
  it("carries the three open features and none of the closed ones", async () => {
    const config = mapConfig((await getMap()).body);
    const { body } = await request(config.geojson as string, { signedIn: false });
    const features = (JSON.parse(body) as { features: { properties: { type: string; url: string } }[] }).features;

    expect([...features.map((f) => f.properties.type)].sort()).toEqual(["d", "f", "l"]);
    expect(features.map((f) => f.properties.url)).toEqual([
      "/needs/at/salisbury/",
      "/needs/at/salisbury/bemerton-heath/",
      "/needs/at/salisbury/donationpoint/tesco-extra/",
    ]);
    expect(body).not.toContain("long-gone");
    expect(body).not.toContain("shut-hall");
    expect(body).not.toContain("boarded-up");
  });

  // ...and the feed is NOT preloaded, which is worth pinning precisely because
  // it looks like an oversight. middleware/geoJsonPreload.ts is mounted on "*"
  // (index.ts:118) and this response is a 200 text/html, so the middleware
  // really does run on this page and really does decide to add nothing: it
  // branches on `c.req.routePath`, and "/admin/map/" is in none of its cases.
  // Django reaches the same answer the same way -- givefood/middleware.py:106
  // branches on `resolve(request.path).url_name`, and there is no 'map' branch
  // -- so the public /needs/ page gets a preload for this exact feed and the
  // admin map, which fetches the same ~8,700 features, does not.
  //
  // Faithful, therefore, and not a bug. Asserted so that adding the preload is
  // a decision someone makes on purpose (it would be a real improvement) and
  // so that a `geojsonUrl ?? ""`-shaped change to that middleware, which would
  // stamp a Link header on every admin page, fails here.
  it("gets no preload Link header, exactly as Django's url_name branch does not add one", async () => {
    const { res } = await getMap();

    expect(res.headers.get("Link")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The page itself -- gfadmin/tests/test_map_view.py, ported line for line
// ---------------------------------------------------------------------------

describe("adminMap -- the page a browser gets", () => {
  // The four remaining assertions from Django's own test file. They are worth
  // keeping verbatim because each names a piece of the chain that is inert on
  // its own: the div MapLibre mounts into, the library, and the script whose
  // init() actually builds the map.
  it("has the div, the library and the initialiser Django's tests assert", async () => {
    const { body } = await getMap();

    expect(body).toContain('id="map"'); // test_map_page_contains_map_div
    expect(body).toContain("window.gfMapConfig"); // test_map_page_contains_map_config
    expect(body).toContain("/static/js/maplibre-gl.js"); // test_map_page_contains_maplibre
    expect(body).toContain("/static/js/wfbn.js"); // test_map_page_contains_wfbn_js
  });

  // THE ATTRIBUTE THAT ACTUALLY DRAWS THE MAP, which Django's own test file
  // does not check and which "the src is in the page" would not miss. wfbn.js
  // defines init() and calls it from NOWHERE -- the only caller on this page is
  // the inline `onload="init()"` on its own script tag, and the tag is `defer`,
  // so nothing else would ever run it. Drop that one attribute and the page is
  // 200, the config is perfect, the library loads, the feed answers, and the
  // admin gets an empty grey rectangle with nothing in the console.
  //
  // The `?v=` is the other half of the same tag. pageContext.ts's header
  // records that `version` was going missing on every deploy, which is exactly
  // the condition in which an admin keeps a cached wfbn.js from before a fix.
  // The value is not pinned (it is "unknown" without a version binding, the
  // commit in production); its PRESENCE is, because that is what varies per
  // deploy.
  it("wires the initialiser to the script's onload, with a cache-buster on it", async () => {
    const { body } = await getMap();

    expect(body).toMatch(/<script src="\/static\/js\/wfbn\.js\?v=[^"]+" defer onload="init\(\)"><\/script>/);
  });

  // MUTANT: `defer` -> `async` on maplibre-gl.js's own tag, in
  // includes/mapconfig.njk. It survived all 25 tests that were here first,
  // which asserted only that the string "/static/js/maplibre-gl.js" appears
  // somewhere -- and it is the single most dangerous edit anyone can make to
  // this page.
  //
  // The two scripts are coupled by nothing but their loading semantics.
  // wfbn.js:139 does `new maplibregl.Map(mapOptions)` inside initMap(), called
  // from init(), called from wfbn.js's own `onload` attribute. Both tags are
  // `defer`, and deferred scripts execute in DOCUMENT ORDER after parsing --
  // so maplibre-gl.js is guaranteed to have run before wfbn.js loads and fires
  // init(). Make either one `async` and that guarantee is gone: on a fast
  // connection wfbn.js can win, init() throws `maplibregl is not defined` into
  // a console nobody has open, and the admin gets a grey rectangle. Server:
  // 200. Config: perfect. Feed: answering. The ordering test below cannot see
  // this, because `async` does not move the tag.
  //
  // The stylesheet is asserted in the same test for the same reason -- it was
  // the other survivor. MapLibre's canvas, controls and popups are positioned
  // entirely by maplibre-gl.css; without it the map "works" and is unusable,
  // and again nothing anywhere reports it.
  it("loads MapLibre's stylesheet, and keeps its script deferred rather than async", async () => {
    const { body } = await getMap();

    expect(body).toMatch(/<link rel="stylesheet" href="\/static\/css\/maplibre-gl\.css\?v=[^"]+">/);
    expect(body).toMatch(/<script src="\/static\/js\/maplibre-gl\.js\?v=[^"]+" defer><\/script>/);
    expect(body).not.toMatch(/<script[^>]*maplibre-gl\.js[^>]*\basync\b/);
    expect(body).not.toMatch(/<script[^>]*wfbn\.js[^>]*\basync\b/);
  });

  // MUTANT: `?v=` removed from either maplibre asset. Survived, because only
  // wfbn.js's cache-buster was ever asserted -- and all three come from the
  // same `version` context value, so they fail together and were being watched
  // one third of the way.
  //
  // A DELIBERATE IMPROVEMENT ON DJANGO, pinned so it is not "tidied" back.
  // givefood/templates/public/includes/mapconfig.html has bare hrefs:
  // `/static/css/maplibre-gl.css` and `/static/js/maplibre-gl.js`, no `?v=` on
  // either -- only wfbn.js's tag (in map.html itself) carries one. So a
  // MapLibre upgrade in Django shipped to browsers holding the old file, which
  // is the worst version of this bug: the library and the code that drives it
  // are then from different releases. The port busts all three.
  //
  // The value is not pinned -- it is "unknown" without a version binding here
  // and the commit in production. Its PRESENCE is, because pageContext.ts's
  // own header records `version` going missing on every deploy, and a page
  // whose three assets silently lose their cache-busters is how an admin keeps
  // running last month's wfbn.js against this month's config shape.
  it("cache-busts all three of the map's assets, unlike Django's include", async () => {
    const { body } = await getMap();
    const busted = [...body.matchAll(/\/static\/(?:js|css)\/(maplibre-gl\.js|maplibre-gl\.css|wfbn\.js)\?v=([^"]+)"/g)];

    expect(busted.map((m) => m[1])).toEqual(["maplibre-gl.css", "maplibre-gl.js", "wfbn.js"]);
    // One `version` feeds all three, so they must agree -- a page serving two
    // different cache-buster values is a page rendered from two contexts.
    expect(new Set(busted.map((m) => m[2])).size).toBe(1);
  });

  // wfbn.js's init() runs on that script's onload and reads both the #map
  // element and window.gfMapConfig (wfbn.js:39 checks for both), so both must
  // already be in the document. Ordering, not mere presence -- an initialiser
  // that runs before its config is a blank map with a console error nobody is
  // watching for.
  it("emits the div, the config and the library before the initialiser", async () => {
    const { body } = await getMap();

    expect(body.indexOf('<div id="map">')).toBeLessThan(body.indexOf("window.gfMapConfig"));
    expect(body.indexOf("maplibre-gl.js")).toBeLessThan(body.indexOf("wfbn.js"));
    expect(body.indexOf("window.gfMapConfig")).toBeLessThan(body.indexOf("wfbn.js"));
  });

  // map.njk's own comment calls these three rules load-bearing, and they are:
  // #map is an empty div, so without an explicit height it is 0px tall and
  // MapLibre initialises into nothing. The page renders, the config is right,
  // the feed answers, and the admin sees white. Nothing anywhere reports it.
  it("gives #map a height and clears the chrome that would push it off-screen", async () => {
    const { body } = await getMap();

    expect(body).toMatch(/#map\s*\{[^}]*height:\s*calc\(100vh - 52px\)/);
    expect(body).toMatch(/\.footer\s*\{[^}]*display:\s*none/);
    expect(body).toMatch(/\.main\s*\{[^}]*padding:\s*0/);
  });

  // includes/maplegend.njk's service-area row is gated on
  // `foodbank.has_service_area and show_service_area`, and the admin context
  // defines neither -- so this page shows the same three rows Django's does.
  // Pinned because the gate is on two UNDEFINED names: Nunjucks resolves those
  // to undefined and the row stays hidden, but a template edit that inverted
  // or dropped the condition would add a legend entry for a layer this map
  // never draws.
  it("shows the three-row legend and no service-area row", async () => {
    const { body } = await getMap();

    expect(body).toContain('id="legendtemplate"');
    expect(body).toContain("Organisation");
    expect(body).toContain("Donation point");
    expect(body).not.toContain("Service area");
  });
});

// ---------------------------------------------------------------------------
// The admin chrome around it -- two deliberate divergences from Django
// ---------------------------------------------------------------------------

describe("adminMap -- the admin chrome", () => {
  // Django's own title block is "Map - GF Admin"; admin/page.njk hard-codes
  // the " - Give Food Admin" suffix for every ported admin page, so this one
  // reads differently on purpose. Asserted so the divergence is recorded
  // rather than rediscovered.
  it("titles the page Map, with the port's own admin suffix", async () => {
    const { body } = await getMap();

    expect(body).toContain("<title>Map - Give Food Admin</title>");
  });

  // The other deliberate divergence. Django passes this view no `section`, so
  // nothing in its nav highlights; the port says "settings" because the port's
  // own admin/settings.njk is the only page that links here, and an admin who
  // arrives from it should still see where they came from. Exactly one item
  // may be active -- a section string that matched nothing (a typo, a renamed
  // nav key) would highlight none, and the page would look orphaned.
  it("highlights Settings in the nav, and only Settings", async () => {
    const { body } = await getMap();
    const active = [...body.matchAll(/<a class="navbar-item is-active" href="([^"]+)"/g)].map((m) => m[1]);

    expect(active).toEqual(["/admin/settings/"]);
  });

  // MUTANT: `admin_user: adminUser` -> `admin_user: undefined` in
  // adminPageContext. It survived every test that was here first, and that is
  // the "every field round-trips" hole in a page that writes nothing: this
  // handler's entire body is `{...(await adminPageContext(c, "settings")),
  // map_config}`, so the spread IS half of what it produces, and only
  // `section` and the four Google keys were ever read back out.
  //
  // Worse, the survival was CONCEALING a vacuous assertion. The
  // unauthenticated test above asserts `not.toContain(ADMIN_EMAIL)` as proof
  // the gate ran before the handler -- but a page that never renders the email
  // for anyone satisfies that too. This is the positive half that gives the
  // negative one its meaning.
  //
  // Both halves of admin/page.njk:60-64's `{% if admin_user %}` block are
  // asserted, because the same undefined kills both: the "signed in as"
  // identity AND the sign-out link. Commit 1d02cf1 is the reminder that sign
  // out is not decoration -- it had already spent a release doing nothing.
  it("renders the signed-in admin's identity and sign-out link, which nothing else here reads back", async () => {
    const { body } = await getMap();

    expect(body).toContain(ADMIN_EMAIL);
    expect(body).toContain('<a href="/auth/sign-out/">Sign out</a>');
  });

  // In Django this URL is an orphan: `grep -rn "admin:map"` across the Django
  // tree hits nothing but its own test file, so it is reachable only by typing
  // it. The port gives it one entry point -- settings.njk's "Map" link -- and
  // that link is therefore the whole of this page's discoverability. Followed
  // rather than asserted as a string: the href is read out of the rendered
  // settings page and fetched, so a route renamed on one side only shows up
  // here as a 404 instead of as a link nobody notices is dead.
  it("is reachable by following the one link that points at it", async () => {
    const settings = await request("/admin/settings/");
    expect(settings.res.status).toBe(200);

    const href = settings.body.match(/href="([^"]*\/map\/)"/)?.[1];
    expect(href).toBe("/admin/map/");

    const { res, body } = await request(href!);
    expect(res.status).toBe(200);
    expect(body).toContain("window.gfMapConfig");
  });
});
