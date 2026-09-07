import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "./index";
import type { AppEnv } from "../../types";

// routes/admin/gmapProxy.ts -- the CORS shim behind admin.js's "Lookup
// Location" and "Lookup Donation Point" buttons, driven here through its
// PRODUCTION registration (routes/admin/index.ts:90 -- GET only, inside
// adminApp and therefore behind requireAdminAuth) rather than through a
// hand-built Context. That distinction is load-bearing rather than
// aesthetic: this handler is a relay to Google with a secret attached, and
// the two worst things that can happen to it -- registered outside the auth
// gate, or reachable on a method admin.js never uses -- happen entirely in
// the route table and would not fail a test that called adminGmapProxy(c)
// directly.
//
// WHAT ISSUE #34 LOOKS LIKE FOR A HANDLER THAT WRITES NO ROWS. #34 was a
// location form that parsed a Place ID, passed it down, wrote it with no SQL
// at all, and redirected as though it had worked. The same shape is
// available here without a database in sight: a 200 carrying a body Google
// never sent, or an upstream URL that quietly lost the one parameter the
// admin typed. Neither is visible from a status code -- and the caller is a
// script, so nobody reads the JSON either. So every test below asserts one
// of the two things that actually carry meaning: the EXACT upstream URL the
// mock recorded, or the bytes handed back, deep-equal to the Google payload
// they came from. The specific paths admin.js reads
// (`results[0].geometry.location`, `result.opening_hours.weekday_text`, ...)
// are additionally asserted by name, because a body reshaped into something
// self-consistent would satisfy a deep-equal against itself and still break
// both buttons.
//
// THE SECOND THING THIS FILE GUARDS is the reason the port diverges from
// Django at all. gfadmin/views.py:3362 gmap_proxy() forwards
// `request.GET.dict()` -- every query parameter verbatim -- so Django has to
// publish the Places key to every admin page (gfadmin/context_processors.py's
// gmap_keys()) for the buttons to work, and the proxy is then a plain open
// relay to two Google endpoints. The port reads the key from the Worker
// secret and allows two parameters per type. Both halves are asserted here:
// the secret is on the upstream URL, a client-supplied `key` is not, and an
// injected `fields=` / `pagetoken=` / `location=` never leaves the machine.
//
// MOCKED: `fetch` (the only thing that leaves the machine) and the SESSIONS
// KV the auth gate reads. The router, requireAdminAuth and the handler are
// the shipped implementations. D1 is a REAL in-memory SQLite behind a real
// binding -- not because this handler queries it (it must not), but so that
// "this route touches no database" is a measurement instead of an
// assumption: if a future edit adds a query it will really run, against real
// rows, and the counts below will move.

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORIGIN = "https://www.givefood.org.uk";
const SESSION_ID = "test-admin-session-id";

// Shaped like a Google key so a leak into a response body or an error string
// is recognisable in a diff, but not one -- the point of the whole module is
// that this value stays server-side.
const PLACES_KEY = "AIzaSy-server-side-only-not-a-real-key";

const TEXTSEARCH_ENDPOINT = "https://maps.googleapis.com/maps/api/place/textsearch/json";
const DETAILS_ENDPOINT = "https://maps.googleapis.com/maps/api/place/details/json";

// The two URLs admin.js actually builds (dist/static/static/js/admin.js:119-120),
// verbatim including the now-empty `key=` it still appends. Written out rather
// than constructed so a change to either side of that contract is a visible
// edit here: the shipped script is byte-identical to Django's and is not going
// to be regenerated to suit the port.
const ADMIN_JS_TEXTSEARCH = "/admin/proxy/gmaps/textsearch/?region=uk&key=&query=Tesco%20Extra%2C%20Brixton%2C%20UK";
const ADMIN_JS_PLACEDETAILS = "/admin/proxy/gmaps/placedetails/?region=uk&key=&placeid=ChIJnotarealplaceid";

// Every parameter ALLOWED_PARAMS lets through, per type, each with a value
// chosen to be unmistakable if it is dropped, hardcoded or bound to the wrong
// slot. `region` is deliberately "ie" and NOT "uk": every other test in this
// file sends the uk that admin.js sends, so an implementation that stopped
// reading the parameter and wrote a constant "uk" instead would satisfy all of
// them. That is the list-page failure -- seed only rows that match the filter
// and a filter that does nothing passes -- in its query-string form.
const ALLOWED_PARAMS_FIXTURE: Record<string, Record<string, string>> = {
  textsearch: { query: "Sid Valley Food Bank, Sidmouth", region: "ie" },
  placedetails: { placeid: "ChIJdistinctplaceid", region: "ie" },
};

// A real Places textsearch envelope, trimmed to the fields admin.js reads
// plus enough of the rest to prove nothing is being filtered out. The
// coordinates are the ones initDonationPointLookup() feeds straight into
// #id_lat_lng, so they are the payload's whole reason for existing.
const TEXTSEARCH_BODY = {
  html_attributions: [],
  results: [
    {
      business_status: "OPERATIONAL",
      formatted_address: "17 Acre Ln, London SW2 5TN, UK",
      geometry: {
        location: { lat: 51.4622817, lng: -0.1145622 },
        viewport: { northeast: { lat: 51.4636, lng: -0.1132 }, southwest: { lat: 51.4609, lng: -0.1159 } },
      },
      name: "Tesco Extra",
      place_id: "ChIJnotarealplaceid",
      types: ["supermarket", "grocery_or_supermarket", "store", "point_of_interest", "establishment"],
    },
  ],
  status: "OK",
};

// A real Places details envelope. `wheelchair_accessible_entrance` is
// deliberately FALSE: admin.js copies it into #id_wheelchair_accessible with
// an `!== undefined` test, so a passthrough that dropped falsy values would
// turn "we checked, it is not accessible" into "unknown" on the saved
// donation point -- silently, and only for the accessible=false half of the
// data.
const DETAILS_BODY = {
  html_attributions: [],
  result: {
    formatted_address: "17 Acre Ln, London SW2 5TN, UK",
    formatted_phone_number: "020 7274 1234",
    opening_hours: {
      open_now: true,
      weekday_text: ["Monday: 7:00 AM – 11:00 PM", "Tuesday: 7:00 AM – 11:00 PM"],
    },
    website: "https://www.tesco.com/store-locator/brixton",
    wheelchair_accessible_entrance: false,
  },
  status: "OK",
};

// migrations/0001_core.sql:20-51, reduced to what a row needs to exist. This
// database is never queried by anything in this file's request path -- it is
// here so that "no D1 session was opened and no row moved" is checked against
// a real engine rather than against a stub that could not have moved anything
// anyway.
const SCHEMA = `
CREATE TABLE foodbank (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  modified TEXT NOT NULL
);
`;

type Bindable = null | number | bigint | string | Uint8Array;

// The D1PreparedStatement surface packages/db uses, over node:sqlite -- the
// same shim as donationPoint.test.ts and clearCache.test.ts. Real SQL, real
// bindings, synchronous underneath.
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

/** The one KV namespace the auth gate reads. */
function fakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string): Promise<string | null> => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string): Promise<void> => void store.set(key, value)),
    delete: vi.fn(async (key: string): Promise<void> => void store.delete(key)),
  };
}

// THE PRODUCTION WIRING. adminApp carries requireAdminAuth and the real route
// table, so "GET /admin/proxy/gmaps/:type/ exists, POST does not, and neither
// is reachable signed out" is answered by the shipped registration rather than
// by this file's opinion of it.
const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  c.set("requestStartTime", performance.now());
  c.set("lang", "en");
  await next();
});
app.route("/admin", adminApp);
// A 500 here means the handler threw. Labelled rather than left to vitest so a
// regression reads as "expected 200, got 500: Unexpected token" instead of an
// unhandled rejection with no route attached -- and so the one place this
// handler genuinely does throw (see the non-JSON body test) can be asserted
// on rather than merely observed.
app.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let sessions: ReturnType<typeof fakeKv>;
let withSession: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
let upstreamCalls: { url: URL; init: RequestInit | undefined }[];
let reply: (url: URL) => Response | Promise<Response>;

function env(overrides: Record<string, unknown> = {}): AppEnv["Bindings"] {
  return {
    DB: { withSession },
    SESSIONS: sessions,
    GMAP_PLACES_KEY: PLACES_KEY,
    GMAP_STATIC_KEY: "",
    GMAP_GEOCODE_KEY: "",
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    D1_DATABASE_NAME: "givefood-test",
    ...overrides,
  } as unknown as AppEnv["Bindings"];
}

/** A JSON reply in Google's own encoding. */
function googleJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=UTF-8", ...headers } });
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  db.prepare("INSERT INTO foodbank (id, name, slug, modified) VALUES (?, ?, ?, ?)").run(1, "Brixton", "brixton", "2026-01-01T00:00:00");
  db.prepare("INSERT INTO foodbank (id, name, slug, modified) VALUES (?, ?, ?, ?)").run(2, "Sid Valley", "sid-valley", "2026-01-02T00:00:00");
  withSession = vi.fn(() => d1Session(db));

  sessions = fakeKv();
  // A live admin session exactly as lib/adminAuth.ts createSession() writes
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

  upstreamCalls = [];
  // Default: any outbound call is a test bug. Individual tests install a
  // modelled reply, so an added second request to Google (a retry, a
  // follow-up details lookup) fails loudly here rather than in production.
  reply = () => {
    throw new Error("fetch not stubbed for this test");
  };
  fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    upstreamCalls.push({ url, init });
    return reply(url);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Signed in, unless `cookie` says otherwise. */
async function get(
  path: string,
  options: { cookie?: string; env?: Record<string, unknown>; headers?: Record<string, string> } = {},
): Promise<Response> {
  const cookie = options.cookie ?? `__Host-gfsession=${SESSION_ID}`;
  return app.fetch(
    new Request(`${ORIGIN}${path}`, { method: "GET", headers: { Cookie: cookie, ...options.headers } }),
    env(options.env),
    execCtx,
  );
}

/** The single URL the handler asked Google for. Fails loudly on 0 or 2. */
function upstream(): URL {
  expect(upstreamCalls).toHaveLength(1);
  return upstreamCalls[0]!.url;
}

/** The rows this route must never touch. */
function foodbankRows(): unknown[] {
  return db.prepare("SELECT id, name, slug, modified FROM foodbank ORDER BY id").all();
}

// ---------------------------------------------------------------------------
// Getting to the handler at all: the gate, the method, and the :type union
// ---------------------------------------------------------------------------

describe("adminGmapProxy -- reaching the handler", () => {
  // requireAdminAuth is applied to adminApp as a whole (routes/admin/index.ts:85),
  // so this is a test of the MOUNT as much as of the middleware. Registered
  // above the gate -- or on the wrong app -- and this becomes an open relay to
  // two paid Google endpoints, billed to the charity, with the key supplied
  // for free by the Worker. Django's version has exactly that property, and
  // only its own login middleware stands in front of it.
  it("never reaches Google without a session", async () => {
    const res = await get("/admin/proxy/gmaps/textsearch/?query=Tesco", { cookie: "" });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fproxy%2Fgmaps%2Ftextsearch%2F");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The gate runs before the :type union is checked, so an unauthenticated
  // caller cannot even use the 404-vs-503 difference to learn which types
  // exist or whether the key is configured.
  it("answers a signed-out request the same way whatever the type", async () => {
    const bad = await get("/admin/proxy/gmaps/nearbysearch/?query=Tesco", { cookie: "" });
    expect(bad.status).toBe(302);
    expect(bad.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fproxy%2Fgmaps%2Fnearbysearch%2F");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // A cookie is not a session. Sign-out and expiry both work by dropping the
  // KV entry (lib/adminAuth.ts revokeAdminSession), leaving the browser
  // holding a cookie that still looks valid -- and a stale tab retrying a
  // lookup is exactly how a revoked admin would keep spending the key.
  it("never reaches Google for a session cookie KV no longer knows", async () => {
    sessions.store.clear();
    const res = await get("/admin/proxy/gmaps/textsearch/?query=Tesco");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fproxy%2Fgmaps%2Ftextsearch%2F");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Django's re_path (gfadmin/urls/core.py:20) restricts the type in the URL
  // pattern, so an unknown one is a Django 404 and the port matches. Worth
  // pinning at the route level because the port moved the check INTO the
  // handler (index.ts:88-89 says so): if isProxyType() were ever loosened, the
  // handler would index UPSTREAM[type] as undefined and `new URL(undefined)`
  // would throw a 500 -- which is roughly what Django's own view would do too
  // (`url` is unbound if neither `if` matches, giving UnboundLocalError).
  it("404s an unknown :type without asking Google anything", async () => {
    const res = await get("/admin/proxy/gmaps/nearbysearch/?query=Tesco");

    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The union is case-sensitive, like Django's regex.
  it("404s a differently-cased :type", async () => {
    const res = await get("/admin/proxy/gmaps/TextSearch/?query=Tesco");

    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Ordering: isProxyType() runs BEFORE the GMAP_PLACES_KEY read, so a
  // misconfigured Worker still answers a bogus type with 404 rather than
  // advertising through a 503 that the type would otherwise have been fine.
  it("validates the type before it looks at the secret", async () => {
    const res = await get("/admin/proxy/gmaps/nearbysearch/?query=Tesco", { env: { GMAP_PLACES_KEY: "" } });

    expect(res.status).toBe(404);
  });

  // GET only (routes/admin/index.ts:90). Django's re_path would have accepted
  // any method -- the view reads request.GET regardless -- so this is a
  // deliberate narrowing to the one verb admin.js uses, and it is what stops a
  // form post or a fetch with a body from reaching a paid upstream.
  it("404s a POST rather than proxying one", async () => {
    const res = await app.fetch(
      new Request(`${ORIGIN}/admin/proxy/gmaps/textsearch/?query=Tesco`, {
        method: "POST",
        headers: { Cookie: `__Host-gfsession=${SESSION_ID}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: "query=Tesco",
      }),
      env(),
      execCtx,
    );

    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The trailing slash is part of the route, as it is in Django's `$`-anchored
  // regex, and admin.js always sends it. Pinned so that dropping it from the
  // registration -- or "helpfully" adding a slashless alias -- is a visible
  // decision rather than a silent widening of a proxy's surface.
  it("404s the slashless spelling of the path", async () => {
    const res = await get("/admin/proxy/gmaps/textsearch?query=Tesco");

    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The secret: the entire reason this handler is not Django's
// ---------------------------------------------------------------------------

describe("adminGmapProxy -- the Places key", () => {
  it("attaches the Worker secret to the upstream call", async () => {
    reply = () => googleJson(TEXTSEARCH_BODY);
    await get("/admin/proxy/gmaps/textsearch/?query=Tesco");

    expect(upstream().searchParams.get("key")).toBe(PLACES_KEY);
  });

  // THE DIVERGENCE FROM DJANGO, asserted rather than described. Django
  // forwards whatever `key` the browser sent; here a client-supplied one is
  // not in ALLOWED_PARAMS, so it is never copied, and the secret is `set`
  // afterwards so there is exactly one `key` on the wire. Two params named
  // `key` would be a Google 400 at best and the caller's key winning at worst.
  it("discards a client-supplied key entirely", async () => {
    reply = () => googleJson(TEXTSEARCH_BODY);
    await get("/admin/proxy/gmaps/textsearch/?query=Tesco&key=AIzaSy-someone-elses-key");

    expect(upstream().searchParams.getAll("key")).toEqual([PLACES_KEY]);
  });

  // The URL admin.js really builds: `key=` is empty because
  // routes/admin/pageContext.ts:56 publishes `gmap_places_key: ""` on
  // purpose. The shipped script is byte-identical to Django's and appends the
  // param unconditionally, so "an empty key param is simply ignored" is the
  // compatibility claim gmapProxy.ts:18-20 makes, and this is it running.
  it("serves the exact URL admin.js builds, empty key param and all", async () => {
    reply = () => googleJson(TEXTSEARCH_BODY);
    const res = await get(ADMIN_JS_TEXTSEARCH);

    expect(res.status).toBe(200);
    expect(upstream().searchParams.get("key")).toBe(PLACES_KEY);
    expect(upstream().searchParams.get("query")).toBe("Tesco Extra, Brixton, UK");
  });

  // Nothing about the upstream request may come back out. An error message
  // that echoed the URL it failed on -- an easy, well-meaning improvement --
  // would put the Places key into the browser's console and into any admin's
  // screenshot of a broken lookup, undoing the whole point of the module.
  it("keeps the key out of every response body it can produce", async () => {
    const bodies: string[] = [];

    reply = () => googleJson(TEXTSEARCH_BODY);
    bodies.push(await (await get("/admin/proxy/gmaps/textsearch/?query=Tesco")).text());

    upstreamCalls = [];
    reply = () => googleJson({ error_message: "The provided API key is invalid." }, 500);
    bodies.push(await (await get("/admin/proxy/gmaps/textsearch/?query=Tesco")).text());

    upstreamCalls = [];
    reply = () => {
      throw new TypeError("network error");
    };
    bodies.push(await (await get("/admin/proxy/gmaps/textsearch/?query=Tesco")).text());

    for (const body of bodies) expect(body).not.toContain(PLACES_KEY);
  });

  // No secret, no request. A Worker whose key was rotated away must not spend
  // a round trip discovering that Google agrees.
  it("503s without calling Google when the secret is unset", async () => {
    const res = await get("/admin/proxy/gmaps/textsearch/?query=Tesco", { env: { GMAP_PLACES_KEY: "" } });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: "REQUEST_DENIED",
      error_message: "GMAP_PLACES_KEY is not configured on this Worker",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // `""` is what an unset secret looks like in .dev.vars (PLAN.md:10340) and
  // `undefined` is what a revoked one looks like at runtime; both are falsy
  // and both must take the same branch, on both types.
  it("503s on either type whether the secret is empty or absent", async () => {
    for (const path of ["/admin/proxy/gmaps/textsearch/?query=Tesco", "/admin/proxy/gmaps/placedetails/?placeid=ChIJx"]) {
      expect((await get(path, { env: { GMAP_PLACES_KEY: "" } })).status).toBe(503);
      expect((await get(path, { env: { GMAP_PLACES_KEY: undefined } })).status).toBe(503);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // MUTANT KILLED: `const key = c.env.GMAP_PLACES_KEY || c.req.query("key")`.
  // That one-word "fallback" survived every other test in this file, because
  // every test that exercises the unset-secret branch sends no `key` of its
  // own and every test that sends one has the secret configured. It is also
  // the single most likely edit anyone will ever make here -- it is precisely
  // Django's behaviour (gfadmin/views.py:3366 forwards request.GET.dict()),
  // it makes the buttons work again on a Worker whose secret was never set,
  // and it silently restores the open relay this whole module exists to
  // close: any signed-in admin, or anything running as one, could then bill
  // arbitrary Places calls to a key of their choosing through givefood.org.uk.
  // So the unconfigured case must refuse EVEN WHEN handed a usable key.
  it("will not accept a client-supplied key in place of the missing secret", async () => {
    for (const path of [
      "/admin/proxy/gmaps/textsearch/?query=Tesco&key=AIzaSy-someone-elses-key",
      "/admin/proxy/gmaps/placedetails/?placeid=ChIJx&key=AIzaSy-someone-elses-key",
    ]) {
      const res = await get(path, { env: { GMAP_PLACES_KEY: "" } });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { status: string }).status).toBe("REQUEST_DENIED");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // NOTE, not a wish: the 503's error_message never reaches a human.
  // admin.js's fetchJSON() throws on `!response.ok` BEFORE reading the body
  // (admin.js:160-170), and its callers catch that with a fixed
  // `alert('Error looking up donation point. Please try again.')`
  // (admin.js:310-312). So gmapProxy.ts:49-52's "this text reaches the admin"
  // is true only of the browser console line `HTTP error! status: 503`. The
  // JSON is still worth having -- it is what a maintainer sees curling the
  // endpoint -- so this pins the shape rather than arguing with it.
  it("uses Google's own REQUEST_DENIED vocabulary for the unconfigured case", async () => {
    const res = await get("/admin/proxy/gmaps/textsearch/?query=Tesco", { env: { GMAP_PLACES_KEY: "" } });

    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(((await res.json()) as { status: string }).status).toBe("REQUEST_DENIED");
  });
});

// ---------------------------------------------------------------------------
// The parameter allowlist: the other half of what Django got wrong
// ---------------------------------------------------------------------------

describe("adminGmapProxy -- the parameter allowlist", () => {
  it("builds the textsearch URL admin.js's Lookup buttons depend on", async () => {
    reply = () => googleJson(TEXTSEARCH_BODY);
    await get(ADMIN_JS_TEXTSEARCH);

    // Whole URL, not a param at a time: the endpoint, the two allowed params
    // in ALLOWED_PARAMS order, and the key appended last. URLSearchParams
    // encodes a space as `+` and a comma as `%2C`; Google accepts both, and
    // spelling it out here means any change to how the URL is assembled shows
    // up as a diff rather than as a lookup that quietly returns the wrong shop.
    expect(upstream().toString()).toBe(`${TEXTSEARCH_ENDPOINT}?query=Tesco+Extra%2C+Brixton%2C+UK&region=uk&key=${PLACES_KEY}`);
  });

  it("builds the placedetails URL admin.js's second call depends on", async () => {
    reply = () => googleJson(DETAILS_BODY);
    await get(ADMIN_JS_PLACEDETAILS);

    expect(upstream().toString()).toBe(`${DETAILS_ENDPOINT}?placeid=ChIJnotarealplaceid&region=uk&key=${PLACES_KEY}`);
  });

  // The two endpoints return incompatible shapes -- `results[]` versus
  // `result{}` -- so swapping them would leave admin.js reading
  // `undefined.geometry` and both buttons dead with a generic alert. Asserted
  // separately from the URL tests above so the failure names the cause.
  it("sends each type to its own Google endpoint", async () => {
    reply = () => googleJson(TEXTSEARCH_BODY);
    await get("/admin/proxy/gmaps/textsearch/?query=Tesco");
    expect(upstream().origin + upstream().pathname).toBe(TEXTSEARCH_ENDPOINT);

    upstreamCalls = [];
    reply = () => googleJson(DETAILS_BODY);
    await get("/admin/proxy/gmaps/placedetails/?placeid=ChIJx");
    expect(upstream().origin + upstream().pathname).toBe(DETAILS_ENDPOINT);
  });

  // gmapProxy.ts:21-23's stated fix for Django's second defect. Each of these
  // is a real Places parameter with a real cost: `fields` drives what Details
  // bills for and returns, `location`/`radius`/`rankby` re-aim a search
  // anywhere on earth, `pagetoken` walks result pages, `language`/`type`
  // change what comes back. Django forwards every one of them.
  it("drops every Places parameter admin.js does not send (textsearch)", async () => {
    reply = () => googleJson(TEXTSEARCH_BODY);
    await get(
      "/admin/proxy/gmaps/textsearch/?query=Tesco&region=uk" +
        "&fields=ALL&location=0,0&radius=50000&rankby=distance&type=atm&opennow=true&pagetoken=CmRaAAAA&language=fr&minprice=0",
    );

    expect([...upstream().searchParams.keys()].sort()).toEqual(["key", "query", "region"]);
  });

  it("drops every Places parameter admin.js does not send (placedetails)", async () => {
    reply = () => googleJson(DETAILS_BODY);
    await get("/admin/proxy/gmaps/placedetails/?placeid=ChIJx&region=uk&fields=ALL&sessiontoken=abc&reviews_sort=newest&language=fr");

    expect([...upstream().searchParams.keys()].sort()).toEqual(["key", "placeid", "region"]);
  });

  // The allowlist is per-type, not one shared list: `placeid` means nothing to
  // textsearch and `query` means nothing to details, and neither may cross
  // over. A single merged list would pass every test above and quietly widen
  // both endpoints' surface.
  it("keeps the two types' allowlists apart", async () => {
    reply = () => googleJson(TEXTSEARCH_BODY);
    await get("/admin/proxy/gmaps/textsearch/?query=Tesco&placeid=ChIJx");
    expect(upstream().searchParams.has("placeid")).toBe(false);

    upstreamCalls = [];
    reply = () => googleJson(DETAILS_BODY);
    await get("/admin/proxy/gmaps/placedetails/?placeid=ChIJx&query=Tesco");
    expect(upstream().searchParams.has("query")).toBe(false);
  });

  // A donation point named "Tesco & Son's #1, SW2 5SG" is not exotic -- the
  // Lookup button sends `${name}, UK` straight through. Assembling the URL by
  // string concatenation instead of searchParams would split this at the `&`
  // into a truncated query plus a smuggled parameter, and truncation is the
  // dangerous half: the search still succeeds, on the wrong shop, and its
  // coordinates get saved.
  it("percent-encodes a query containing & # and + rather than splitting on them", async () => {
    reply = () => googleJson(TEXTSEARCH_BODY);
    const nasty = "Tesco & Son's #1, SW2 5SG + annexe";
    await get(`/admin/proxy/gmaps/textsearch/?query=${encodeURIComponent(nasty)}`);

    expect(upstream().searchParams.get("query")).toBe(nasty);
    expect([...upstream().searchParams.keys()].sort()).toEqual(["key", "query"]);
  });

  // `if (value)` skips an empty string, so a blank name reaches Google as a
  // search with no query at all. SUSPECT, pinned rather than fixed: Google
  // answers INVALID_REQUEST, admin.js finds no `results` and logs "No results
  // found" to the console with no alert, so an admin who clicks Lookup on an
  // empty Name field gets silence. Django would have forwarded `query=` and
  // got the same INVALID_REQUEST, so this is a port faithful in outcome; the
  // cost is a wasted upstream call either way.
  it("omits an empty parameter instead of forwarding it (suspect: silent no-op)", async () => {
    reply = () => googleJson({ ...TEXTSEARCH_BODY, results: [], status: "INVALID_REQUEST" });
    const res = await get("/admin/proxy/gmaps/textsearch/?query=&region=uk");

    expect(upstream().searchParams.has("query")).toBe(false);
    expect(upstream().toString()).toBe(`${TEXTSEARCH_ENDPOINT}?region=uk&key=${PLACES_KEY}`);
    expect(res.status).toBe(200);
  });

  // EVERY ALLOWED PARAMETER CARRIES ITS OWN VALUE. This is the brief's "every
  // field round-trips" in the only form a handler that writes no rows can
  // have it: for each type, every parameter the allowlist declares is sent
  // with a distinct value and read back off the recorded upstream URL.
  //
  // MUTANT KILLED: `set(name, name === "region" ? "uk" : value)`. Hardcoding
  // region survived the entire original file, because admin.js sends
  // `region=uk` and so did every fixture -- the assertion and the mutant
  // agreed. It is a plausible edit too ("we only ever search the UK"), and it
  // is wrong: `region` biases Places ranking, so pinning it would silently
  // mis-rank lookups for the Irish and Northern Irish food banks in the
  // dataset and hand the admin the wrong shop's coordinates to save.
  it("forwards each allowed parameter's own value, none of them hardcoded", async () => {
    for (const [type, params] of Object.entries(ALLOWED_PARAMS_FIXTURE)) {
      upstreamCalls = [];
      reply = () => googleJson(type === "textsearch" ? TEXTSEARCH_BODY : DETAILS_BODY);
      await get(`/admin/proxy/gmaps/${type}/?${new URLSearchParams(params).toString()}`);

      for (const [name, value] of Object.entries(params)) {
        expect(upstream().searchParams.get(name)).toBe(value);
      }
      // ...and nothing beyond them plus the secret, so a parameter that
      // round-trips is not doing so by being echoed twice under two names.
      expect([...upstream().searchParams.keys()].sort()).toEqual([...Object.keys(params), "key"].sort());
    }
  });

  // Each allowed parameter also has to work ALONE. Sent as a set, a parameter
  // read from the wrong slot can still look right if the sibling it stole
  // from happens to be present; sent one at a time it comes back empty and
  // the assertion names which parameter broke. admin.js itself always sends
  // both (dist/static/static/js/admin.js:119-120 build `region=uk` into every
  // call), so this is coverage of the handler's own contract rather than of a
  // shape the shipped script produces.
  it("forwards an allowed parameter sent on its own", async () => {
    for (const [type, params] of Object.entries(ALLOWED_PARAMS_FIXTURE)) {
      for (const [name, value] of Object.entries(params)) {
        upstreamCalls = [];
        reply = () => googleJson(type === "textsearch" ? TEXTSEARCH_BODY : DETAILS_BODY);
        await get(`/admin/proxy/gmaps/${type}/?${name}=${encodeURIComponent(value)}`);

        expect(upstream().searchParams.get(name)).toBe(value);
        expect([...upstream().searchParams.keys()].sort()).toEqual([name, "key"].sort());
      }
    }
  });

  // NOTHING OF THE ADMIN'S REQUEST BUT THOSE PARAMETERS LEAVES THE MACHINE.
  //
  // MUTANT KILLED: `fetch(upstream, { signal, headers: c.req.raw.headers })`.
  // Forwarding the inbound headers is the reflex move when a proxy misbehaves
  // ("pass the User-Agent through"), it looks harmless, and the original file
  // asserted only that `init.signal` existed -- so it survived all 40 tests.
  // What it actually does is hand Google the admin's `__Host-gfsession`
  // cookie, i.e. a live admin session credential for givefood.org.uk, on
  // every lookup button press. The session cookie is HttpOnly and SameSite,
  // so this is the one route by which it could ever reach a third party.
  //
  // The recorded init is asserted whole rather than header by header, because
  // the danger is not a specific header but the habit of forwarding: a body,
  // a method, or `credentials` appearing here would each be their own version
  // of the same mistake.
  it("sends Google nothing of the admin's own request -- no cookie, no headers at all", async () => {
    reply = () => googleJson(TEXTSEARCH_BODY);
    await get("/admin/proxy/gmaps/textsearch/?query=Tesco", {
      headers: { Authorization: "Bearer an-admin-token", "X-Forwarded-For": "203.0.113.7", "User-Agent": "Mozilla/5.0 (admin's laptop)" },
    });

    const init = upstreamCalls[0]!.init;
    expect(Object.keys(init ?? {})).toEqual(["signal"]);
    // Named explicitly so a failure says what leaked, not just "extra key".
    const forwarded = new Headers((init?.headers as HeadersInit | undefined) ?? {});
    expect(forwarded.get("cookie")).toBeNull();
    expect(forwarded.get("authorization")).toBeNull();
  });

  // Hono's c.req.query() returns the FIRST occurrence. Django's
  // `request.GET.dict()` returns the LAST -- a genuine divergence, harmless
  // because admin.js never repeats a parameter, and pinned so it is a known
  // difference rather than a discovery. Whichever end wins, only one value
  // reaches Google.
  it("takes the first of a repeated parameter, where Django took the last", async () => {
    reply = () => googleJson(TEXTSEARCH_BODY);
    await get("/admin/proxy/gmaps/textsearch/?query=first&query=second");

    expect(upstream().searchParams.getAll("query")).toEqual(["first"]);
  });
});

// ---------------------------------------------------------------------------
// The body: what admin.js actually consumes
// ---------------------------------------------------------------------------

describe("adminGmapProxy -- passing Google's response through", () => {
  // gmapProxy.ts:71-73 promises the body goes through unreshaped because
  // admin.js reads Google's own field names. Deep equality is the only
  // assertion that covers "and nothing was dropped on the way".
  it("returns the textsearch envelope byte-for-byte in meaning", async () => {
    reply = () => googleJson(TEXTSEARCH_BODY);
    const res = await get("/admin/proxy/gmaps/textsearch/?query=Tesco");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(TEXTSEARCH_BODY);
  });

  // The four paths initDonationPointLookup() / initLocationLookup() actually
  // dereference (admin.js:265-310). A body that deep-equals its own fixture
  // but had, say, `geometry` flattened would still break every lookup button,
  // so these are named individually.
  it("keeps the exact paths the Lookup buttons dereference", async () => {
    reply = () => googleJson(TEXTSEARCH_BODY);
    const body = (await (await get("/admin/proxy/gmaps/textsearch/?query=Tesco")).json()) as typeof TEXTSEARCH_BODY;

    expect(body.results[0]!.geometry.location).toEqual({ lat: 51.4622817, lng: -0.1145622 });
    expect(body.results[0]!.place_id).toBe("ChIJnotarealplaceid");
  });

  it("returns the placedetails envelope unreshaped, falsy fields included", async () => {
    reply = () => googleJson(DETAILS_BODY);
    const res = await get("/admin/proxy/gmaps/placedetails/?placeid=ChIJnotarealplaceid");
    const body = (await res.json()) as typeof DETAILS_BODY;

    expect(body).toEqual(DETAILS_BODY);
    expect(body.result.formatted_address).toBe("17 Acre Ln, London SW2 5TN, UK");
    expect(body.result.formatted_phone_number).toBe("020 7274 1234");
    expect(body.result.website).toBe("https://www.tesco.com/store-locator/brixton");
    // Joined with "\n" into #id_opening_hours -- an array that arrived as a
    // string would be pasted in as "Monday: ...,Tuesday: ...".
    expect(body.result.opening_hours.weekday_text).toEqual(["Monday: 7:00 AM – 11:00 PM", "Tuesday: 7:00 AM – 11:00 PM"]);
    // The `!== undefined` field: false must stay false and must not vanish.
    expect(body.result.wheelchair_accessible_entrance).toBe(false);
    expect("wheelchair_accessible_entrance" in body.result).toBe(true);
  });

  it("labels the response as JSON", async () => {
    reply = () => googleJson(TEXTSEARCH_BODY);
    const res = await get("/admin/proxy/gmaps/textsearch/?query=Tesco");

    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  // Google reports its own failures inside a 200. Both of these pass straight
  // through with the upstream's own status, exactly as Django did, because
  // admin.js is written against Google's envelope and handles ZERO_RESULTS
  // itself. REQUEST_DENIED is the quiet one worth knowing about: a revoked or
  // over-quota key produces a 200 here, admin.js finds no `results`, logs "No
  // results found" and shows the admin nothing at all.
  it("passes Google's own ZERO_RESULTS and REQUEST_DENIED through as 200s", async () => {
    reply = () => googleJson({ html_attributions: [], results: [], status: "ZERO_RESULTS" });
    const zero = await get("/admin/proxy/gmaps/textsearch/?query=Nowhere");
    expect(zero.status).toBe(200);
    expect(await zero.json()).toEqual({ html_attributions: [], results: [], status: "ZERO_RESULTS" });

    upstreamCalls = [];
    reply = () => googleJson({ error_message: "The provided API key is expired.", results: [], status: "REQUEST_DENIED" });
    const denied = await get("/admin/proxy/gmaps/textsearch/?query=Tesco");
    expect(denied.status).toBe(200);
    expect(((await denied.json()) as { status: string }).status).toBe("REQUEST_DENIED");
  });

  // A fresh Response is built rather than Google's relayed, so nothing of
  // Google's own header set reaches the admin's browser -- notably any
  // Set-Cookie, which on a same-origin /admin/ path would be a third party
  // writing cookies into the admin session's origin.
  it("does not relay Google's response headers", async () => {
    reply = () => googleJson(TEXTSEARCH_BODY, 200, { "Set-Cookie": "NID=notarealcookie; Path=/", "X-Goog-Trace": "abc123" });
    const res = await get("/admin/proxy/gmaps/textsearch/?query=Tesco");

    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(res.headers.get("X-Goog-Trace")).toBeNull();
  });

  // MUTANT KILLED: `c.header("Access-Control-Allow-Origin", "*")` before the
  // return. It survived the original file, and it is the obvious thing to
  // reach for when a shim called "the CORS proxy" appears not to work -- the
  // module's own name invites it. This endpoint is same-origin by
  // construction: admin.js fetches it from a givefood.org.uk admin page, so
  // it has never needed a CORS header, and adding one advertises an
  // authenticated, Google-billing endpoint to every other origin. The session
  // cookie is SameSite=Lax (lib/adminAuth.ts:305), so a cross-origin caller
  // would not carry it today -- which makes this a widening to refuse now
  // rather than a live hole, and exactly the kind that gets added by
  // accident and never noticed.
  it("advertises no CORS access to any other origin", async () => {
    reply = () => googleJson(TEXTSEARCH_BODY);
    const res = await get("/admin/proxy/gmaps/textsearch/?query=Tesco", { headers: { Origin: "https://evil.example" } });

    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// When Google does not cooperate
// ---------------------------------------------------------------------------

describe("adminGmapProxy -- upstream failures", () => {
  it("turns an unreachable Google into a 502, not a 500", async () => {
    reply = () => {
      throw new TypeError("network error");
    };
    const res = await get("/admin/proxy/gmaps/textsearch/?query=Tesco");

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ status: "UNKNOWN_ERROR", error_message: "Google Places could not be reached" });
  });

  // The 20s AbortSignal firing arrives as a rejection from fetch, so it takes
  // the same branch. Simulated with the DOMException fetch really throws --
  // the point is that a hung upstream ends as a 502 rather than as an
  // unhandled rejection and a 500 page inside the admin's lookup.
  it("turns the 20s timeout into the same 502", async () => {
    reply = () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    const res = await get("/admin/proxy/gmaps/textsearch/?query=Tesco");

    expect(res.status).toBe(502);
    expect(((await res.json()) as { status: string }).status).toBe("UNKNOWN_ERROR");
  });

  // The timeout has to be REQUESTED for the branch above to ever fire in
  // production. Without a signal a stalled Google connection holds the request
  // until the platform kills it, and the admin sees a spinner rather than an
  // alert.
  it("asks for the request with an abort signal attached", async () => {
    reply = () => googleJson(TEXTSEARCH_BODY);
    await get("/admin/proxy/gmaps/textsearch/?query=Tesco");

    expect(upstreamCalls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  // A non-2xx from Google is reported with its status so a maintainer curling
  // the endpoint can tell 429 (over quota) from 403 (key revoked or referrer-
  // restricted) from 500 (Google's problem). All become 502 here, because from
  // the browser's point of view the gateway is what failed.
  it("reports the upstream status on a 5xx", async () => {
    reply = () => new Response("upstream exploded", { status: 500 });
    const res = await get("/admin/proxy/gmaps/textsearch/?query=Tesco");

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ status: "UNKNOWN_ERROR", error_message: "Google Places returned 500" });
  });

  it("reports the upstream status on a 403 and a 429", async () => {
    reply = () => new Response("forbidden", { status: 403 });
    const forbidden = await get("/admin/proxy/gmaps/textsearch/?query=Tesco");
    expect(forbidden.status).toBe(502);
    expect(((await forbidden.json()) as { error_message: string }).error_message).toBe("Google Places returned 403");

    upstreamCalls = [];
    reply = () => new Response("slow down", { status: 429 });
    const throttled = await get("/admin/proxy/gmaps/textsearch/?query=Tesco");
    expect(throttled.status).toBe(502);
    expect(((await throttled.json()) as { error_message: string }).error_message).toBe("Google Places returned 429");
  });

  // Unlike routes/admin/proxy.ts, a 403/429 is NOT retried here. Pinned
  // because the sibling module does retry those two statuses and the two
  // handlers are easily conflated: this one talks to Google's API, where a
  // 403 means the key is wrong and a second identical call would only burn
  // another request.
  it("does not retry a rejected upstream call", async () => {
    reply = () => new Response("forbidden", { status: 403 });
    await get("/admin/proxy/gmaps/textsearch/?query=Tesco");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // SUSPECT, PINNED AS-IS. `await res.json()` sits OUTSIDE the try/catch
  // (gmapProxy.ts:74), so a 200 whose body is not JSON -- an HTML interstitial
  // or captcha page from an intermediary, an empty body -- throws past the
  // handler and becomes the site's 500 page, which is exactly the outcome the
  // 502 branch four lines above exists to avoid. admin.js gets a 500 with an
  // HTML body where it expected JSON and shows its generic alert. Asserted
  // here as a 500 (labelled by this file's own onError) rather than "fixed":
  // the test says what happens today, and the report says it is wrong.
  it("500s on a 200 whose body is not JSON (suspect: res.json() is outside the try)", async () => {
    reply = () => new Response("<html><body>Are you a robot?</body></html>", { status: 200, headers: { "Content-Type": "text/html" } });
    const res = await get("/admin/proxy/gmaps/textsearch/?query=Tesco");

    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/^five hundred: /);
  });

  it("500s on an empty 200 body for the same reason", async () => {
    reply = () => new Response("", { status: 200, headers: { "Content-Type": "application/json" } });
    const res = await get("/admin/proxy/gmaps/textsearch/?query=Tesco");

    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// The stores this route must never write to
// ---------------------------------------------------------------------------

describe("adminGmapProxy -- no side-channel writes", () => {
  // The brief's "a GET must never write", answered against a real engine. The
  // handler has no reason to open a D1 session at all, and withSession() is
  // where every read and write in this codebase begins -- so a future edit
  // that reached for the database (caching lookups, logging them) shows up
  // here before it shows up on the bill or in the audit trail.
  it("opens no D1 session and moves no rows on a successful proxy", async () => {
    const before = foodbankRows();
    reply = () => googleJson(TEXTSEARCH_BODY);
    const res = await get("/admin/proxy/gmaps/textsearch/?query=Tesco");

    expect(res.status).toBe(200);
    expect(withSession).not.toHaveBeenCalled();
    expect(foodbankRows()).toEqual(before);
  });

  it("opens no D1 session on the 404, 502 and 503 paths either", async () => {
    const before = foodbankRows();

    await get("/admin/proxy/gmaps/nearbysearch/?query=Tesco");
    await get("/admin/proxy/gmaps/textsearch/?query=Tesco", { env: { GMAP_PLACES_KEY: "" } });
    reply = () => new Response("nope", { status: 500 });
    await get("/admin/proxy/gmaps/textsearch/?query=Tesco");

    expect(withSession).not.toHaveBeenCalled();
    expect(foodbankRows()).toEqual(before);
  });

  // D1 is not the only store a "let's not pay Google twice for the same
  // lookup" edit could reach for, and KV is the nearer one -- the SESSIONS
  // binding is already in scope here because the auth gate reads it.
  //
  // MUTANT KILLED: `await c.env.SESSIONS.put("gmap:" + upstream, body)` on the
  // success path. It survived the original file, and it is worse than a
  // wasted write: `upstream` has the Places secret on it, so a cache keyed by
  // the outbound URL persists the secret into a KV namespace whose entries
  // are listable and dumpable with `wrangler kv key list` -- the one place
  // this module's whole design says the key must never end up. The assertion
  // is on `put` (and `delete`) only, because `get` is the auth gate doing its
  // job on every request.
  //
  // The fixture session is written with a full TTL left precisely so
  // getAdminSession()'s sliding refresh does not fire and put a write here
  // that this test would then have to tolerate.
  it("writes nothing to KV -- no lookup cache keyed by a URL carrying the secret", async () => {
    reply = () => googleJson(TEXTSEARCH_BODY);
    const res = await get("/admin/proxy/gmaps/textsearch/?query=Tesco");

    expect(res.status).toBe(200);
    expect(sessions.put).not.toHaveBeenCalled();
    expect(sessions.delete).not.toHaveBeenCalled();
    expect([...sessions.store.keys()]).toEqual([`admin-session:${SESSION_ID}`]);
  });
});
