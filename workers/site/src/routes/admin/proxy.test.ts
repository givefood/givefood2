import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "./index";
import type { AppEnv } from "../../types";

// routes/admin/proxy.ts -- the preview iframe four admin templates embed
// (need_new.njk:120, generic_form.njk:67, foodbank_form.njk:62,
// foodbank_check.njk:247) so a reviewer sees the food bank's live page beside
// the extracted shopping list. Driven here through its PRODUCTION
// registration (routes/admin/index.ts:86 -- GET only, inside adminApp and so
// behind requireAdminAuth) rather than through a hand-built Context, because
// the two worst things that can happen to a server-side fetcher -- registered
// outside the auth gate, or reachable on a verb nothing uses -- happen
// entirely in the route table.
//
// WHAT THIS HANDLER IS FOR. Django's proxy (gfadmin/views.py:3326) is
// `requests.get(request.GET.get("url"))`: an unauthenticated-shaped,
// unvalidated, fully general SSRF that only Django's login middleware stood
// in front of. The port refuses to take a URL at all. The caller names a food
// bank slug and one of five known columns; the URL is read out of D1 on every
// request. So the entire attack surface is (a) which field names are
// accepted, (b) what the column is allowed to contain, and (c) the `target`
// escape hatch that exists for in-iframe navigation. Every test in the
// allowlist, resolution and target sections is aimed at one of those three.
//
// WHAT ISSUE #34 LOOKS LIKE FOR A HANDLER THAT WRITES NO ROWS. #34 was a form
// that parsed a value, passed it down, wrote it with no SQL at all, and
// redirected as though it had worked -- invisible from the status code. The
// same shape is available here in both directions: a 200 that fetched
// something other than what the admin asked for, or a refusal that happened
// to 403 for the wrong reason. A status code is therefore never the whole
// assertion below; every request that should reach the network asserts the
// EXACT URL the fetch mock recorded, and every request that should not
// asserts `fetchMock` was never called.
//
// MOCKED, and only this:
//   * `fetch` -- the one thing that leaves the machine.
//   * the SESSIONS KV the auth gate reads.
//   * `HTMLRewriter`, because it is a workerd primitive and this suite runs in
//     plain node (vitest.config.mts). See the stand-in's own comment below for
//     exactly what it does and does not prove.
// The router, requireAdminAuth, getFoodbankBySlug, dbSession and the handler
// are all the shipped implementations, and D1 is a REAL in-memory SQLite
// behind a real binding -- the field URL genuinely comes back out of a SELECT.

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORIGIN = "https://www.givefood.org.uk";
const SESSION_ID = "test-admin-session-id";

// migrations/0001_core.sql:10-46, reduced to what this handler's path touches:
// the slug it looks up by, the five proxyable columns, three real columns that
// hold URLs and are deliberately NOT proxyable, and `latest_need_id`.
//
// latest_need_id is not optional scenery. getFoodbankBySlug hands its row to
// attachLatestNeed (packages/db/src/foodbank.ts:103), which tests
// `latest_need_id === null` -- a column missing from the fixture would read as
// `undefined`, fail that test and send the real getNeedById at a foodbankchange
// table that does not exist here. Present and NULL is the shape production has
// for a food bank with no need on file.
//
// `url` and `shopping_list_url` are NOT NULL in production and nullable here on
// purpose: the empty-string case below is the one production can actually
// reach, and NULL is what the other three columns can hold.
const SCHEMA = `
CREATE TABLE foodbank (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  url TEXT, shopping_list_url TEXT,
  locations_url TEXT, contacts_url TEXT, donation_points_url TEXT,
  rss_url TEXT, news_url TEXT, charity_website TEXT,
  latest_need_id INTEGER,
  modified TEXT NOT NULL
);
CREATE UNIQUE INDEX foodbank_slug_uniq ON foodbank(slug);
`;

// Written out rather than inferred from the first fixture: every URL column is
// nullable here (three of them genuinely are in production), and inference
// from SALISBURY would type them all `string` and reject the NULL rows below.
type FoodbankFixture = {
  id: number;
  name: string;
  slug: string;
  url: string | null;
  shopping_list_url: string | null;
  locations_url: string | null;
  contacts_url: string | null;
  donation_points_url: string | null;
  rss_url: string | null;
  news_url: string | null;
  charity_website: string | null;
  latest_need_id: number | null;
  modified: string;
};

// The five columns PROXYABLE_FIELDS admits, each with a DIFFERENT path, so a
// handler that read the wrong column is caught by the URL assertion rather
// than passing on a shared value.
const SALISBURY = {
  id: 1,
  name: "Salisbury",
  slug: "salisbury",
  url: "https://salisbury.foodbank.org.uk/",
  shopping_list_url: "https://salisbury.foodbank.org.uk/give-help/donate-food/",
  locations_url: "https://salisbury.foodbank.org.uk/locations/",
  contacts_url: "https://salisbury.foodbank.org.uk/contact-us/",
  donation_points_url: "https://salisbury.foodbank.org.uk/give-help/donation-points/",
  // Three real, populated columns that are NOT on the allowlist. rss_url and
  // news_url are same-origin and harmless-looking; charity_website points at a
  // third party. All three are what a "just add the field the admin asked for"
  // regression would start fetching.
  rss_url: "https://salisbury.foodbank.org.uk/feed/",
  news_url: "https://salisbury.foodbank.org.uk/news/",
  charity_website: "https://register-of-charities.charitycommission.gov.uk/charity-details/?regId=1156050",
  latest_need_id: null,
  modified: "2026-01-01 00:00:00.000000",
};

// A second food bank whose every URL differs, so "the slug selected the row"
// is a measurement. A handler that ignored the slug and took whatever row came
// back first would pass every single-row test in this file.
const SID_VALLEY: FoodbankFixture = {
  ...SALISBURY,
  id: 2,
  name: "Sid Valley",
  slug: "sid-valley",
  url: "https://sidvalleyfoodbank.org.uk/",
  shopping_list_url: "https://sidvalleyfoodbank.org.uk/what-we-need/",
  locations_url: "https://sidvalleyfoodbank.org.uk/where/",
  contacts_url: "https://sidvalleyfoodbank.org.uk/contact/",
  donation_points_url: "https://sidvalleyfoodbank.org.uk/drop-off/",
  rss_url: null,
  news_url: null,
  charity_website: null,
};

// The rows that make "no usable URL" reachable on every one of its causes:
// blank, NULL, a non-http scheme, and text that is not a URL at all. The
// scheme rows are the ones that matter -- a stored `file://` or `javascript:`
// is the only way a value already inside D1 could turn this handler back into
// Django's SSRF, and safeOrigin() is the thing that stops it.
const EDGE: FoodbankFixture = {
  ...SALISBURY,
  id: 3,
  name: "Edge Cases",
  slug: "edge-cases",
  url: "", // blank: what production's NOT NULL columns degrade to
  shopping_list_url: null, // NULL: what the nullable columns hold
  locations_url: "javascript:alert(document.cookie)",
  contacts_url: "not a url at all",
  donation_points_url: "file:///etc/passwd",
  rss_url: null,
  news_url: null,
  charity_website: null,
};

type Bindable = null | number | bigint | string | Uint8Array;

// The D1PreparedStatement surface packages/db uses, over node:sqlite -- the
// same shim as gmapProxy.test.ts and foodbankLocation.test.ts. Real SQL, real
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

// ---------------------------------------------------------------------------
// The HTMLRewriter stand-in
// ---------------------------------------------------------------------------
//
// HTMLRewriter is a workerd global. This suite runs in node (vitest.config.mts
// pins `environment: "node"` and explains why), so there is no real one to
// call and no way to add one without a dependency this repo does not have --
// miniflare exists in the pnpm store but is nobody's declared dependency, and
// running workerd would mean a different test runner.
//
// WHAT THIS DOUBLE PROVES AND WHAT IT DOES NOT. The only code
// routes/admin/proxy.ts owns on this path is the `element(el)` callback: given
// an `href` attribute, a target URL and a field origin, decide what `href` and
// `target` should become. That decision is entirely deterministic and it is
// what the tests below assert -- through `rewrittenLinks()`, which records the
// attribute map each element carried in and the one it carried out. The
// STREAMING PARSER is workerd's and is not under test: this double finds
// anchors with a regex, so it does not model malformed markup, anchors inside
// comments or CDATA, chunk boundaries, or HTMLRewriter's own attribute-value
// escaping. Nothing below asserts on serialised markup except the one
// round-trip test, which follows the recorded href rather than a parsed one.
//
// It is also load-bearing as an oracle in the other direction: `on()` records
// its selector, so "the handler asked for a[href]" is asserted rather than
// assumed -- and `rewriterConstructed` lets the passthrough tests prove that
// a PDF never reaches a rewriter at all.

type FakeElementHandler = { element(el: FakeElement): void };

class FakeElement {
  constructor(readonly attrs: Map<string, string>) {}
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
}

type RecordedLink = { before: Record<string, string>; after: Record<string, string> };

let rewriterConstructed = 0;
let rewriterSelectors: string[] = [];
let recordedLinks: RecordedLink[] = [];

const ANCHOR_TAG = /<a\b([^>]*)>/gi;
const ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of raw.matchAll(ATTRIBUTE)) {
    attrs.set(match[1]!, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

function serialiseAnchor(attrs: Map<string, string>): string {
  const parts = [...attrs].map(([name, value]) => ` ${name}="${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`);
  return `<a${parts.join("")}>`;
}

class FakeHTMLRewriter {
  private handlers: FakeElementHandler[] = [];

  constructor() {
    rewriterConstructed += 1;
  }

  on(selector: string, handler: FakeElementHandler): this {
    rewriterSelectors.push(selector);
    this.handlers.push(handler);
    return this;
  }

  transform(res: Response): Response {
    const handlers = this.handlers;
    const rewritten = res.text().then((html) =>
      html.replace(ANCHOR_TAG, (whole, rawAttrs: string) => {
        const attrs = parseAttributes(rawAttrs);
        // The registered selector is `a[href]`, so an anchor with no href
        // attribute at all is never dispatched. `href=""` IS dispatched --
        // which is what makes the handler's own `if (!href) return` guard
        // reachable, and what the empty-href test below turns on.
        if (!attrs.has("href")) return whole;
        const before = Object.fromEntries(attrs);
        for (const handler of handlers) handler.element(new FakeElement(attrs));
        recordedLinks.push({ before, after: Object.fromEntries(attrs) });
        return serialiseAnchor(attrs);
      }),
    );
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(await rewritten));
        controller.close();
      },
    });
    // Status and headers carried across, as workerd's transform() does -- the
    // upstream-header passthrough test below depends on that being modelled.
    return new Response(stream, { status: res.status, headers: res.headers });
  }
}

/** The links the handler's own element() callback actually rewrote, in order. */
function rewrittenLinks(): RecordedLink[] {
  return recordedLinks;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

// THE PRODUCTION WIRING. adminApp carries requireAdminAuth and the real route
// table, so "GET /admin/proxy/ exists, POST does not, and neither is reachable
// signed out" is answered by the shipped registration.
const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  c.set("requestStartTime", performance.now());
  c.set("lang", "en");
  await next();
});
app.route("/admin", adminApp);
// A 500 here means the handler threw. Labelled so a regression reads as
// "expected 502, got 500: ..." rather than as a bare unhandled rejection.
app.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let sessions: ReturnType<typeof fakeKv>;
let withSession: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
let upstreamCalls: { url: string; init: RequestInit | undefined }[];
let replies: (() => Response)[];

function env(): AppEnv["Bindings"] {
  return { DB: { withSession }, SESSIONS: sessions } as unknown as AppEnv["Bindings"];
}

function insertFoodbank(row: FoodbankFixture): void {
  db.prepare(
    `INSERT INTO foodbank
       (id, name, slug, url, shopping_list_url, locations_url, contacts_url, donation_points_url,
        rss_url, news_url, charity_website, latest_need_id, modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.name,
    row.slug,
    row.url,
    row.shopping_list_url,
    row.locations_url,
    row.contacts_url,
    row.donation_points_url,
    row.rss_url,
    row.news_url,
    row.charity_website,
    row.latest_need_id,
    row.modified,
  );
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  insertFoodbank(SALISBURY);
  insertFoodbank(SID_VALLEY);
  insertFoodbank(EDGE);
  withSession = vi.fn(() => d1Session(db));

  sessions = fakeKv();
  // A live admin session exactly as lib/adminAuth.ts createSession() writes
  // one. expiresAt a full TTL out so getAdminSession's sliding refresh does not
  // fire and add an incidental SESSIONS.put to every request.
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
  // Default: any outbound call is a test bug. Tests that expect one queue a
  // modelled reply, so an unplanned second request -- a retry that should not
  // have happened -- fails loudly here rather than in production.
  replies = [];
  fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
    upstreamCalls.push({ url: String(input), init });
    const next = replies.shift();
    if (!next) throw new Error(`fetch not stubbed for call ${upstreamCalls.length} to ${String(input)}`);
    return next();
  });
  vi.stubGlobal("fetch", fetchMock);

  rewriterConstructed = 0;
  rewriterSelectors = [];
  recordedLinks = [];
  vi.stubGlobal("HTMLRewriter", FakeHTMLRewriter);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Signed in, unless `cookie` says otherwise. */
async function get(path: string, options: { cookie?: string } = {}): Promise<Response> {
  const cookie = options.cookie ?? `__Host-gfsession=${SESSION_ID}`;
  return app.fetch(new Request(`${ORIGIN}${path}`, { method: "GET", headers: { Cookie: cookie } }), env(), execCtx);
}

/** The single URL the handler asked for. Fails loudly on 0 or 2. */
function upstream(): string {
  expect(upstreamCalls).toHaveLength(1);
  return upstreamCalls[0]!.url;
}

function html(body: string, contentType = "text/html; charset=UTF-8"): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": contentType } });
}

/** Queue one reply for the next fetch. */
function willReply(make: () => Response): void {
  replies.push(make);
}

/** Every column this route must never touch. */
function foodbankRows(): unknown[] {
  return db.prepare("SELECT * FROM foodbank ORDER BY id").all();
}

// ---------------------------------------------------------------------------
// Getting to the handler at all: the gate, the verb, the path
// ---------------------------------------------------------------------------

describe("adminProxy -- reaching the handler", () => {
  // requireAdminAuth is applied to adminApp as a whole (routes/admin/index.ts:85),
  // so this is a test of the MOUNT as much as of the middleware. Registered
  // above the gate -- or on the wrong app -- and this becomes an anonymous
  // server-side fetcher pointed at any URL in the food bank table, which is
  // most of Django's bug back with a smaller allowlist. Django's own proxy has
  // exactly that shape and only its login middleware stands in front of it.
  it("never reaches the network without a session", async () => {
    const res = await get("/admin/proxy/?foodbank=salisbury&field=url", { cookie: "" });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fproxy%2F");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(withSession).not.toHaveBeenCalled();
  });

  // A cookie is not a session. Sign-out and expiry both work by dropping the
  // KV entry (lib/adminAuth.ts revokeAdminSession), leaving the browser holding
  // a cookie that still looks valid -- and a stale admin tab whose iframe is
  // still reloading is exactly how a revoked session would keep making
  // outbound requests from the Worker's IP.
  it("never reaches the network for a session cookie KV no longer knows", async () => {
    sessions.store.clear();
    const res = await get("/admin/proxy/?foodbank=salisbury&field=url");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fproxy%2F");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The gate runs before any validation, so a signed-out caller cannot use the
  // 400-vs-404 difference to enumerate which food bank slugs exist.
  it("answers a signed-out request identically whatever the querystring", async () => {
    for (const path of [
      "/admin/proxy/?foodbank=salisbury&field=url",
      "/admin/proxy/?foodbank=does-not-exist&field=url",
      "/admin/proxy/?foodbank=salisbury&field=rss_url",
      "/admin/proxy/",
    ]) {
      const res = await get(path, { cookie: "" });
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fproxy%2F");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // GET only (routes/admin/index.ts:86). Django's `path("proxy/", proxy)`
  // accepted any method -- the view reads request.GET regardless -- so this is
  // a deliberate narrowing to the one verb an iframe uses. There is no POST on
  // this route and therefore no CSRF token to check; the CSRF question for
  // this handler is answered by the route table refusing the verb outright.
  it("404s a POST rather than proxying one", async () => {
    const res = await app.fetch(
      new Request(`${ORIGIN}/admin/proxy/?foodbank=salisbury&field=url`, {
        method: "POST",
        headers: { Cookie: `__Host-gfsession=${SESSION_ID}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: "foodbank=salisbury&field=url",
      }),
      env(),
      execCtx,
    );

    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The trailing slash is part of the route, as it is in Django's
  // `path("proxy/")`, and every template's iframe src sends it. Pinned so that
  // dropping it -- or "helpfully" adding a slashless alias -- is a visible
  // decision rather than a silent widening of a fetcher's surface.
  it("404s the slashless spelling of the path", async () => {
    const res = await get("/admin/proxy?foodbank=salisbury&field=url");

    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The allowlist -- the thing that replaces Django's ?url=
// ---------------------------------------------------------------------------

describe("adminProxy -- the field allowlist", () => {
  // THE HEADLINE TEST. Django's entire interface was `?url=`, and its whole
  // defect. Sending it here must not fetch anything, ever -- not the URL, not
  // a default, not a food bank's homepage. If this test ever goes green on a
  // 200 the port has grown Django's bug back.
  it("ignores Django's ?url= entirely and fetches nothing", async () => {
    const res = await get("/admin/proxy/?url=https%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data%2F");

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Bad request");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The half of the same claim that a "both parameters present" request would
  // hide: `url` is not read even when the request is otherwise well formed, so
  // it cannot override, append to, or redirect the resolved column value.
  it("still fetches the column when a ?url= rides alongside a valid request", async () => {
    willReply(() => html("<p>salisbury</p>"));
    const res = await get("/admin/proxy/?foodbank=salisbury&field=url&url=https%3A%2F%2Fevil.example%2F");

    expect(res.status).toBe(200);
    expect(upstream()).toBe(SALISBURY.url);
  });

  it("400s with no foodbank, no field, or neither -- without a lookup or a fetch", async () => {
    for (const path of ["/admin/proxy/", "/admin/proxy/?foodbank=salisbury", "/admin/proxy/?field=url", "/admin/proxy/?foodbank=&field=url"]) {
      const res = await get(path);
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("Bad request");
    }
    expect(fetchMock).not.toHaveBeenCalled();
    // The field check comes BEFORE the D1 read, so a bad request costs no
    // database round trip -- worth pinning because the ordering is the only
    // thing stopping this route being a slug-enumeration oracle for anyone who
    // gets past the gate.
    expect(withSession).not.toHaveBeenCalled();
  });

  // THE "EVERY FIELD ROUND-TRIPS" TEST, in the shape this handler has one.
  // There is no form here, so the round trip is column -> SELECT -> fetch: each
  // of the five allowlisted names must reach the network at ITS OWN column's
  // value. A handler that resolved every field to `foodbank.url` would serve a
  // plausible preview for all five and be wrong for four of them, which is
  // precisely #34's shape -- and it is also the exact set of names
  // workers/jobs/src/adminJobs/foodbankCheck.ts:118-127 emits as `proxyField`
  // into foodbank_check.njk:247's iframe, so a name dropped from the allowlist
  // breaks that page's preview with a 400 and no other signal.
  const ALLOWED: [string, string][] = [
    ["url", SALISBURY.url],
    ["shopping_list_url", SALISBURY.shopping_list_url],
    ["locations_url", SALISBURY.locations_url],
    ["contacts_url", SALISBURY.contacts_url],
    ["donation_points_url", SALISBURY.donation_points_url],
  ];

  for (const [field, expected] of ALLOWED) {
    it(`fetches the ${field} column, and only that column`, async () => {
      willReply(() => html("<p>ok</p>"));
      const res = await get(`/admin/proxy/?foodbank=salisbury&field=${field}`);

      expect(res.status).toBe(200);
      expect(upstream()).toBe(expected);
    });
  }

  // The columns that are NOT on the list. All three are real, populated, and
  // full of URLs an admin might plausibly want to preview -- which is exactly
  // why the refusal has to be asserted rather than assumed. charity_website in
  // particular points at a third party, so admitting it would turn this into a
  // relay to an origin no food bank controls.
  for (const field of ["rss_url", "news_url", "charity_website", "place_id", "facebook_page", "delivery_address"]) {
    it(`400s field=${field} without fetching it`, async () => {
      const res = await get(`/admin/proxy/?foodbank=salisbury&field=${field}`);

      expect(res.status).toBe(400);
      expect(await res.text()).toBe("Bad request");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  // The allowlist is an exact string match, so no casing or whitespace variant
  // slips past it. Pinned because `includes()` on a readonly array is easy to
  // "improve" into a case-insensitive or trimming comparison, and every such
  // improvement widens what a querystring can name.
  it("matches the field name byte-for-byte", async () => {
    for (const field of ["URL", "Url", "url%20", "%20url", "url/", "urlx", "shopping_list_URL"]) {
      const res = await get(`/admin/proxy/?foodbank=salisbury&field=${field}`);
      expect(res.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Hono's c.req.query() returns the FIRST occurrence; Django's
  // request.GET.get() returns the LAST. A genuine divergence, harmless because
  // no template ever repeats the parameter, and pinned so that only one field
  // can ever be in play -- a repeated parameter must not become a way to name
  // an allowlisted field and have a different one fetched.
  it("takes the first of a repeated field, where Django took the last", async () => {
    willReply(() => html("<p>ok</p>"));
    await get("/admin/proxy/?foodbank=salisbury&field=url&field=locations_url");

    expect(upstream()).toBe(SALISBURY.url);
  });

  it("takes the first of a repeated foodbank too", async () => {
    willReply(() => html("<p>ok</p>"));
    await get("/admin/proxy/?foodbank=salisbury&foodbank=sid-valley&field=url");

    expect(upstream()).toBe(SALISBURY.url);
  });
});

// ---------------------------------------------------------------------------
// Resolving the URL out of D1
// ---------------------------------------------------------------------------

describe("adminProxy -- resolving the URL from the database", () => {
  // c.notFound(), not the 400 above: the field name was fine, the food bank
  // was not. Distinct statuses because they are distinct mistakes -- a
  // template with a stale slug versus a template asking for a field that no
  // longer exists.
  it("404s an unknown slug without fetching anything", async () => {
    const res = await get("/admin/proxy/?foodbank=no-such-foodbank&field=url");

    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The slug reaches the SELECT verbatim, so the match is byte-exact.
  // packages/db/migrations/0001_core.sql:13 declares `slug TEXT NOT NULL` and
  // :48 indexes it with no NOCASE collation, so SQLite compares it BINARY in
  // production exactly as it does in this fixture -- and Django's own
  // `get_object_or_404(Foodbank, slug=slug)` was case-sensitive too.
  //
  // MUTANT KILLED: `getFoodbankBySlug(dbSession(c), slug.toLowerCase())`.
  // Every fixture slug here is already lower case, so normalising the slug on
  // the way into the lookup passed all 80 of the tests that existed before
  // this one. It is not cosmetic: it would make /admin/proxy/ resolve slugs
  // that no other admin page, no template link and no crawl job resolves, so
  // a preview would work from a URL that 404s everywhere else in the admin.
  it("matches the slug byte-for-byte rather than normalising it", async () => {
    for (const slug of ["Salisbury", "SALISBURY", "salisbury%20", "%20salisbury"]) {
      const res = await get(`/admin/proxy/?foodbank=${slug}&field=url`);
      expect(res.status).toBe(404);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The slug really does select the row. Without a second food bank in the
  // fixture every URL assertion in this file would also pass for a handler
  // that ignored the slug entirely and took the first row it found.
  it("resolves each food bank's own URL, not the first row in the table", async () => {
    willReply(() => html("<p>sid valley</p>"));
    await get("/admin/proxy/?foodbank=sid-valley&field=shopping_list_url");

    expect(upstream()).toBe(SID_VALLEY.shopping_list_url);
  });

  // proxy.ts:14-15's claim -- "resolved fresh from D1 on every request, not
  // cached" -- executed rather than believed. An admin who fixes a wrong URL
  // on the edit form and reloads the preview must see the new page; a cached
  // resolution would show the old site indefinitely and there would be nothing
  // on screen to say why.
  it("re-reads the column on every request rather than caching it", async () => {
    willReply(() => html("<p>before</p>"));
    await get("/admin/proxy/?foodbank=salisbury&field=locations_url");
    expect(upstreamCalls[0]!.url).toBe(SALISBURY.locations_url);

    db.prepare("UPDATE foodbank SET locations_url = ? WHERE slug = ?").run("https://salisbury.foodbank.org.uk/find-us/", "salisbury");

    willReply(() => html("<p>after</p>"));
    await get("/admin/proxy/?foodbank=salisbury&field=locations_url");
    expect(upstreamCalls[1]!.url).toBe("https://salisbury.foodbank.org.uk/find-us/");
    expect(withSession).toHaveBeenCalledTimes(2);
  });

  // The URL goes out exactly as stored -- no trailing slash added or removed,
  // no query string dropped, no re-encoding. The stored value is what an admin
  // typed and what every other consumer of the column (the check job, the
  // public site) uses; a preview of a normalised variant is a preview of a
  // different page.
  it("fetches the stored value verbatim, query string and all", async () => {
    db.prepare("UPDATE foodbank SET shopping_list_url = ? WHERE slug = ?").run(
      "https://salisbury.foodbank.org.uk/give-help/?tab=food&utm_source=givefood",
      "salisbury",
    );
    willReply(() => html("<p>ok</p>"));
    await get("/admin/proxy/?foodbank=salisbury&field=shopping_list_url");

    expect(upstream()).toBe("https://salisbury.foodbank.org.uk/give-help/?tab=food&utm_source=givefood");
  });

  it("404s a blank column with a message naming the cause", async () => {
    const res = await get("/admin/proxy/?foodbank=edge-cases&field=url");

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("No usable URL set for this field");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404s a NULL column the same way", async () => {
    const res = await get("/admin/proxy/?foodbank=edge-cases&field=shopping_list_url");

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("No usable URL set for this field");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The same refusal on a food bank whose OTHER columns are perfectly good.
  // Both "no usable URL" tests above use the edge-cases row, whose `url` is
  // blank as well, so they cannot tell "refused" from "fell back to something
  // that was also unusable".
  //
  // MUTANT KILLED: `foodbank[field] ?? foodbank.url` (and its `||` twin) --
  // the kind of edit that reads as a helpful default. It is #34's shape
  // exactly: the admin asks to preview contacts_url, the iframe fills with a
  // page, and the only thing on screen says the request succeeded. They would
  // conclude the contacts URL is set and working when the column is empty, and
  // the crawl jobs that read that column would go on finding nothing.
  it("404s an empty column rather than falling back to the food bank's homepage", async () => {
    for (const stored of [null, ""]) {
      db.prepare("UPDATE foodbank SET contacts_url = ? WHERE slug = ?").run(stored, "salisbury");
      const res = await get("/admin/proxy/?foodbank=salisbury&field=contacts_url");

      expect(res.status).toBe(404);
      expect(await res.text()).toBe("No usable URL set for this field");
    }
    // The homepage is present and valid throughout -- if it were ever going to
    // be fetched instead, it would have been here.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // THE LAST DOOR BACK TO DJANGO'S BUG. The allowlist controls which COLUMN is
  // read; safeOrigin controls what that column is allowed to contain. Anyone
  // who can edit a food bank -- which is any admin, and was historically any
  // crawl that filled a field in -- could otherwise store `file:///etc/passwd`
  // or `javascript:` and have the Worker fetch it. All three of these are
  // refused before fetch is reached.
  it("refuses a stored non-http scheme rather than fetching it", async () => {
    for (const field of ["locations_url", "donation_points_url"]) {
      const res = await get(`/admin/proxy/?foodbank=edge-cases&field=${field}`);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("No usable URL set for this field");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a stored value that is not a URL at all", async () => {
    const res = await get("/admin/proxy/?foodbank=edge-cases&field=contacts_url");

    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // A bare hostname is the commonest way a URL column goes wrong by hand, and
  // `new URL()` rejects it -- so the admin gets the "no usable URL" 404 rather
  // than a fetch of the string relative to nothing.
  it("refuses a scheme-less hostname", async () => {
    db.prepare("UPDATE foodbank SET url = ? WHERE slug = ?").run("salisbury.foodbank.org.uk", "salisbury");
    const res = await get("/admin/proxy/?foodbank=salisbury&field=url");

    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The brief's "a GET must never write", measured against a real engine on
  // every branch this handler has. There is no reason for a preview to touch a
  // row, and withSession() is where every write in this codebase begins.
  it("moves no rows on any path, successful or not", async () => {
    const before = foodbankRows();

    willReply(() => html("<a href='/x'>x</a>"));
    await get("/admin/proxy/?foodbank=salisbury&field=url");
    await get("/admin/proxy/?foodbank=salisbury&field=rss_url");
    await get("/admin/proxy/?foodbank=nope&field=url");
    await get("/admin/proxy/?foodbank=edge-cases&field=url");
    await get("/admin/proxy/?foodbank=salisbury&field=url&target=https%3A%2F%2Fevil.example%2F");
    willReply(() => new Response("gone", { status: 404 }));
    await get("/admin/proxy/?foodbank=salisbury&field=url");

    expect(foodbankRows()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// ?target= -- the in-iframe navigation escape hatch
// ---------------------------------------------------------------------------

describe("adminProxy -- the target parameter", () => {
  it("follows a same-origin target instead of the field URL", async () => {
    willReply(() => html("<p>deep page</p>"));
    const res = await get(`/admin/proxy/?foodbank=salisbury&field=url&target=${encodeURIComponent("https://salisbury.foodbank.org.uk/news/2026/")}`);

    expect(res.status).toBe(200);
    expect(upstream()).toBe("https://salisbury.foodbank.org.uk/news/2026/");
  });

  // THE WHOLE POINT OF THE ORIGIN CHECK. Without it `target` is Django's
  // `?url=` under another name: an admin opening a preview of a food bank's
  // site, clicking a link a defaced or compromised page planted, and having
  // the Worker fetch an arbitrary host from inside Cloudflare's network. The
  // allowlist is the FIELD URL's origin -- resolved from D1 on this request --
  // not anything the client sent.
  it("403s a cross-origin target and never fetches it", async () => {
    const res = await get(`/admin/proxy/?foodbank=salisbury&field=url&target=${encodeURIComponent("https://evil.example/pwn")}`);

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("URL not allowed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The comparison is on ORIGIN, so scheme and port count. That is stricter
  // than Django, which compared `urlparse(...).netloc` -- host and port only.
  // A DELIBERATE DIVERGENCE and a small usability cost: a food bank site that
  // links to its own pages over plain http gets those links opened in a new
  // tab rather than followed inside the iframe. Pinned in all three shapes so
  // that loosening origin to hostname is a visible decision.
  it("403s a target that differs only by scheme, where Django would have allowed it", async () => {
    const res = await get(`/admin/proxy/?foodbank=salisbury&field=url&target=${encodeURIComponent("http://salisbury.foodbank.org.uk/news/")}`);

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("403s a target on a different port", async () => {
    const res = await get(`/admin/proxy/?foodbank=salisbury&field=url&target=${encodeURIComponent("https://salisbury.foodbank.org.uk:8443/admin")}`);

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("403s a subdomain and a suffix-extended lookalike host", async () => {
    for (const target of [
      "https://staging.salisbury.foodbank.org.uk/",
      "https://salisbury.foodbank.org.uk.evil.example/",
      "https://salisbury.foodbank.org.uk@evil.example/",
    ]) {
      const res = await get(`/admin/proxy/?foodbank=salisbury&field=url&target=${encodeURIComponent(target)}`);
      expect(res.status).toBe(403);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // safeOrigin() returns null for anything that is not http(s), and null never
  // equals the field's origin string -- so a non-URL, a relative path and a
  // dangerous scheme all take the same refusal, without any of them needing
  // their own branch in the handler.
  it("403s a target that is not an absolute http(s) URL", async () => {
    for (const target of ["/news/", "not a url", "javascript:alert(1)", "file:///etc/passwd", "//salisbury.foodbank.org.uk/x"]) {
      const res = await get(`/admin/proxy/?foodbank=salisbury&field=url&target=${encodeURIComponent(target)}`);
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("URL not allowed");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // An empty `target=` is falsy, so it is treated as absent rather than as a
  // target that fails the origin check. That is the friendly outcome -- a
  // template rendering `target={{ nothing }}` shows the field's own page
  // instead of a 403 -- and it is pinned because `if (requestedTarget)` vs
  // `if (requestedTarget !== undefined)` is a one-character difference with a
  // visible consequence.
  it("treats an empty target as absent and previews the field URL", async () => {
    willReply(() => html("<p>home</p>"));
    const res = await get("/admin/proxy/?foodbank=salisbury&field=url&target=");

    expect(res.status).toBe(200);
    expect(upstream()).toBe(SALISBURY.url);
  });

  // The origin check runs against the FIELD, so which field is named changes
  // which targets are legal. Both of Salisbury's fields happen to share an
  // origin; Sid Valley's do not overlap with Salisbury's at all, and a target
  // valid for one food bank must not be valid for another.
  it("scopes the allowed origin to the named food bank's own field", async () => {
    const res = await get(`/admin/proxy/?foodbank=sid-valley&field=url&target=${encodeURIComponent("https://salisbury.foodbank.org.uk/news/")}`);

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The 404 for an unusable column is reached BEFORE the target is considered,
  // so a food bank with a blank field cannot be used as a way to smuggle a
  // target past a check that never ran. If the ordering were reversed, a
  // fieldOrigin of null compared against a target's origin would still refuse
  // -- but only by accident, and only while safeOrigin keeps returning null.
  it("refuses a target when the field itself has no usable URL", async () => {
    const res = await get(`/admin/proxy/?foodbank=edge-cases&field=url&target=${encodeURIComponent("https://salisbury.foodbank.org.uk/")}`);

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("No usable URL set for this field");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// What goes out on the wire
// ---------------------------------------------------------------------------

describe("adminProxy -- the outbound request", () => {
  // proxy.ts:35-43's stated reason for diverging from Django's bare
  // `headers={"User-Agent": ...}`: `requests` sends Accept, Accept-Encoding and
  // Accept-Language by default and a Workers fetch does not, and several food
  // bank sites' bot protection scores "bot UA, no Accept" as automated. The
  // exact set is asserted rather than spot-checked, because a header quietly
  // dropped here shows up only as an intermittent 403 on someone else's site.
  it("sends the bot UA plus the two headers requests would have sent", async () => {
    willReply(() => html("<p>ok</p>"));
    await get("/admin/proxy/?foodbank=salisbury&field=url");

    expect(upstreamCalls[0]!.init?.headers).toEqual({
      "User-Agent": "Mozilla/5.0 (compatible; GiveFoodBot/1.0; +https://www.givefood.org.uk/bot/)",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-GB,en;q=0.9",
    });
  });

  // The UA is a promise to the sites being fetched: it names the bot and links
  // to a page explaining it, and food banks' operators allowlist on exactly
  // this string. Asserted by value so a "modernise the UA" edit is a decision
  // someone has to make on purpose.
  it("identifies itself as GiveFoodBot with the documented contact URL", async () => {
    willReply(() => html("<p>ok</p>"));
    await get("/admin/proxy/?foodbank=salisbury&field=url");

    const ua = (upstreamCalls[0]!.init?.headers as Record<string, string>)["User-Agent"]!;
    expect(ua).toContain("GiveFoodBot/1.0");
    expect(ua).toContain("https://www.givefood.org.uk/bot/");
  });

  // The timeout has to be REQUESTED for the 502 branch to ever fire. Without a
  // signal a stalled food bank site holds the request until the platform kills
  // it, and the admin sees a blank iframe and a spinner rather than a message.
  it("attaches an abort signal to every attempt", async () => {
    willReply(() => html("<p>ok</p>"));
    await get("/admin/proxy/?foodbank=salisbury&field=url");

    expect(upstreamCalls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  // The timeout VALUE, not merely its presence. An AbortSignal exposes no
  // readable deadline, so watching the constructor is the only way to pin the
  // twenty seconds proxy.ts:57 names.
  //
  // MUTANT KILLED: `AbortSignal.timeout(200)`. The test above is satisfied by
  // any signal at all, so shortening the deadline -- a one-character slip on a
  // numeric separator, `20_000` to `2_000` -- changed nothing anyone could
  // see. In production it would make the shared-hosting WordPress sites this
  // proxy exists to preview start reporting "could not be reached. You should
  // check the URL" for URLs that are correct and simply slow, which is the
  // precise misdiagnosis previewFailureMessage was rewritten to stop giving.
  it("asks for a twenty second deadline, not some other number", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    willReply(() => html("<p>ok</p>"));
    await get("/admin/proxy/?foodbank=salisbury&field=url");

    expect(timeout.mock.calls).toEqual([[20_000]]);
  });

  // No cookies, no Authorization, no forwarded client headers -- the outbound
  // request carries only what PREVIEW_HEADERS names. Pinned because the
  // admin's own session cookie is on this request and forwarding request
  // headers wholesale is a plausible "make bot protection happier" change.
  it("forwards nothing from the admin's own request", async () => {
    willReply(() => html("<p>ok</p>"));
    await get("/admin/proxy/?foodbank=salisbury&field=url");

    const headers = upstreamCalls[0]!.init?.headers as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual(["Accept", "Accept-Language", "User-Agent"]);
    expect(JSON.stringify(headers)).not.toContain(SESSION_ID);
  });

  // Two options go out and no others. `redirect` in particular is left unset,
  // so fetch's default -- follow -- stands, which is what makes the "reports
  // an unfollowed redirect" test below unreachable in production.
  //
  // MUTANT KILLED: adding `redirect: "manual"` to the fetch init. Nothing that
  // asserts on the RESPONSE can catch that here, because a mocked fetch does
  // not follow redirects either -- only the request options can. It matters a
  // great deal: bare-http URLs and moved pages are everywhere in this table,
  // every one of them answers 301, and under "manual" each becomes a 502
  // "returned 301. That is the site erroring" for a URL that works perfectly.
  it("passes only headers and a signal, leaving redirect handling at fetch's default", async () => {
    willReply(() => html("<p>ok</p>"));
    await get("/admin/proxy/?foodbank=salisbury&field=url");

    expect(Object.keys(upstreamCalls[0]!.init ?? {}).sort()).toEqual(["headers", "signal"]);
  });
});

// ---------------------------------------------------------------------------
// Retries and failures
// ---------------------------------------------------------------------------

describe("adminProxy -- retrying the two statuses that mean 'bot filter'", () => {
  // The 750ms sleep is real code and a real wait. Faked so the suite does not
  // spend three quarters of a second per retry test; only setTimeout is faked,
  // because AbortSignal.timeout does not go through it and faking Date or
  // queueMicrotask would change how the awaits interleave.
  async function getThroughRetry(path: string): Promise<Response> {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const pending = get(path);
      await vi.advanceTimersByTimeAsync(750);
      return await pending;
    } finally {
      vi.useRealTimers();
    }
  }

  // proxy.ts:50-54: a 403 from a food bank's site usually means Cloudflare or
  // WP Engine turned this particular request away, not that the URL is wrong --
  // the module's comment names faversham.foodbank.org.uk, which serves fine by
  // hand and intermittently 403s the Worker. One retry turns most of those into
  // a working preview.
  it("retries a 403 once and serves the second attempt's page", async () => {
    willReply(() => new Response("Attention Required!", { status: 403 }));
    willReply(() => html("<p>second time lucky</p>"));

    const res = await getThroughRetry("/admin/proxy/?foodbank=salisbury&field=url");

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("second time lucky");
    expect(upstreamCalls).toHaveLength(2);
    expect(upstreamCalls[1]!.url).toBe(SALISBURY.url);
  });

  // THE PAUSE IS THE RETRY. A bot filter that just turned this request away
  // will turn an instant repeat away too, so a retry with no gap buys nothing
  // and costs a second request to a small charity's website.
  //
  // MUTANT KILLED: deleting the `await new Promise((resolve) =>
  // setTimeout(resolve, 750))` line. Every other retry test in this file
  // advances the clock before it looks at anything, so all of them stayed
  // green with the backoff gone. The gap can only be asserted from MID-FLIGHT
  // -- one attempt made, the clock not yet at 750 -- or it is not asserted at
  // all, which is why this test drives the timer in two steps.
  it("waits out the backoff instead of firing the retry immediately", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      willReply(() => new Response("blocked", { status: 403 }));
      willReply(() => html("<p>ok</p>"));
      const pending = get("/admin/proxy/?foodbank=salisbury&field=url");

      // 749ms in: the 403 has come back and the retry has NOT gone out.
      await vi.advanceTimersByTimeAsync(749);
      expect(upstreamCalls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(upstreamCalls).toHaveLength(2);
      expect((await pending).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  // The retry is a retry of the SAME request: the same bot UA and Accept
  // headers, and its own fresh 20s deadline rather than the first attempt's
  // part-spent one.
  //
  // MUTANT KILLED: `return fetch(url);` for the second attempt. It survived
  // every pre-existing test because they all read upstreamCalls[0], and it is
  // the worst available version of this bug: PREVIEW_HEADERS exists precisely
  // to get past the bot protection that produced the 403 (proxy.ts:35-43), so
  // a bare retry is one more guaranteed-blocked request and an admin who waits
  // an extra 750ms to be told the same thing.
  it("repeats the same headers and a fresh deadline on the second attempt", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    willReply(() => new Response("blocked", { status: 403 }));
    willReply(() => html("<p>ok</p>"));

    await getThroughRetry("/admin/proxy/?foodbank=salisbury&field=url");

    expect(upstreamCalls).toHaveLength(2);
    expect(upstreamCalls[1]!.init?.headers).toEqual({
      "User-Agent": "Mozilla/5.0 (compatible; GiveFoodBot/1.0; +https://www.givefood.org.uk/bot/)",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-GB,en;q=0.9",
    });
    expect(upstreamCalls[1]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(upstreamCalls[1]!.init?.signal).not.toBe(upstreamCalls[0]!.init?.signal);
    expect(timeout.mock.calls).toEqual([[20_000], [20_000]]);
  });

  it("retries a 429 once as well", async () => {
    willReply(() => new Response("Too Many Requests", { status: 429 }));
    willReply(() => html("<p>ok</p>"));

    const res = await getThroughRetry("/admin/proxy/?foodbank=salisbury&field=url");

    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(2);
  });

  // Exactly ONE retry. A loop here would multiply every blocked preview by the
  // number of attempts against a small charity's website, from Cloudflare's
  // network, while an admin sits watching an iframe.
  it("gives up after the second attempt rather than looping", async () => {
    willReply(() => new Response("blocked", { status: 403 }));
    willReply(() => new Response("blocked again", { status: 403 }));

    const res = await getThroughRetry("/admin/proxy/?foodbank=salisbury&field=url");

    expect(res.status).toBe(502);
    expect(upstreamCalls).toHaveLength(2);
  });

  // The retry follows the TARGET, not the field URL -- otherwise a blocked
  // deep page would quietly fall back to previewing the homepage, which looks
  // like a working preview of the wrong thing.
  it("retries the target URL, not the field URL", async () => {
    willReply(() => new Response("blocked", { status: 403 }));
    willReply(() => html("<p>ok</p>"));
    const target = "https://salisbury.foodbank.org.uk/news/2026/";

    await getThroughRetry(`/admin/proxy/?foodbank=salisbury&field=url&target=${encodeURIComponent(target)}`);

    expect(upstreamCalls.map((call) => call.url)).toEqual([target, target]);
  });

  // Everything that is not 403/429 is reported on the first attempt. A 404 is
  // a wrong URL and a 500 is the site's own fault; retrying either just doubles
  // the admin's wait for the same answer.
  it("does not retry a 404 or a 500", async () => {
    willReply(() => new Response("Not Found", { status: 404 }));
    await get("/admin/proxy/?foodbank=salisbury&field=url");
    expect(upstreamCalls).toHaveLength(1);

    willReply(() => new Response("Server Error", { status: 500 }));
    await get("/admin/proxy/?foodbank=salisbury&field=url");
    expect(upstreamCalls).toHaveLength(2);
  });
});

describe("adminProxy -- reporting a failure", () => {
  // proxy.ts:63-67's whole reason for existing. Django answered every non-200
  // with "You should check the URL", which for a 403 sends an admin looking for
  // a fault in a URL that is correct. The wording is asserted rather than
  // described because it is the entire user-visible behaviour of this branch.
  it("tells the truth about a 403 instead of blaming the URL", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    willReply(() => new Response("blocked", { status: 403 }));
    willReply(() => new Response("blocked", { status: 403 }));
    const pending = get("/admin/proxy/?foodbank=salisbury&field=url");
    await vi.advanceTimersByTimeAsync(750);
    const res = await pending;
    vi.useRealTimers();

    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain(`${SALISBURY.url} refused this request (HTTP 403).`);
    expect(body).toContain("The URL looks fine");
    expect(body).toContain("Open it directly in a new tab instead");
    // The misleading sentence must NOT be here -- that is the fix.
    expect(body).not.toContain("You should check the URL");
  });

  // The other half of the same branch. A 429 is a rate limit, so the URL is
  // not merely "fine" -- it is provably reachable, since the site had to
  // recognise it to refuse it -- and blaming the URL is even more misleading
  // here than for a 403.
  //
  // MUTANT KILLED: narrowing `if (status === 403 || status === 429)` to
  // `status === 403`. The retry section above exercises a 429 twice but only
  // ever counts requests and reads a status, so a 429 dropping through to the
  // generic "That is the site erroring" text was invisible -- the bug class
  // this whole function was written to remove, reintroduced for one status.
  it("gives a 429 the same honest wording it gives a 403", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    willReply(() => new Response("Too Many Requests", { status: 429 }));
    willReply(() => new Response("Too Many Requests", { status: 429 }));
    const pending = get("/admin/proxy/?foodbank=salisbury&field=url");
    await vi.advanceTimersByTimeAsync(750);
    const res = await pending;
    vi.useRealTimers();

    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain(`${SALISBURY.url} refused this request (HTTP 429).`);
    expect(body).toContain("The URL looks fine");
    expect(body).not.toContain("That is the site erroring");
    expect(body).not.toContain("You should check the URL");
  });

  // A 404 is the one case where Django's wording was right, so it is kept
  // verbatim -- including the missing full stop, which is Django's.
  it("keeps Django's own wording for a 404, where it was correct", async () => {
    willReply(() => new Response("Not Found", { status: 404 }));
    const res = await get("/admin/proxy/?foodbank=salisbury&field=shopping_list_url");

    expect(res.status).toBe(502);
    expect(await res.text()).toBe(`${SALISBURY.shopping_list_url} returned 404. You should check the URL`);
  });

  it("distinguishes a site erroring from a bad URL on a 5xx", async () => {
    willReply(() => new Response("Server Error", { status: 503 }));
    const res = await get("/admin/proxy/?foodbank=salisbury&field=url");

    expect(res.status).toBe(502);
    expect(await res.text()).toBe(
      `${SALISBURY.url} returned 503. That is the site erroring, not necessarily a bad URL -- try opening it directly.`,
    );
  });

  // DIVERGENCE FROM DJANGO, pinned deliberately. Django's proxy returned its
  // failure text inside an HTTP 200 (`HttpResponse(...)` with no status), so
  // the iframe rendered the message as the page. The port answers 502 with the
  // same message in the body -- the iframe still shows the text, and a
  // monitor or a curl can now tell a failed preview from a successful one.
  it("answers a failed preview with 502, where Django answered 200", async () => {
    for (const status of [404, 410, 500, 502, 503]) {
      willReply(() => new Response("nope", { status }));
      const res = await get("/admin/proxy/?foodbank=salisbury&field=url");
      expect(res.status).toBe(502);
      expect(await res.text()).toContain(String(status));
    }
  });

  // A redirect that comes back unfollowed is reported like any other non-200.
  // Not reachable through a default `fetch`, which follows redirects, but the
  // branch is `res.status !== 200` and the message it produces reads oddly for
  // a 301 -- worth having written down if redirect handling is ever changed.
  it("reports an unfollowed redirect as a site error rather than following it", async () => {
    willReply(() => new Response(null, { status: 301, headers: { Location: "https://salisbury.foodbank.org.uk/new/" } }));
    const res = await get("/admin/proxy/?foodbank=salisbury&field=url");

    expect(res.status).toBe(502);
    expect(await res.text()).toContain("returned 301. That is the site erroring");
    expect(upstreamCalls).toHaveLength(1);
  });

  // DNS gone, connection refused, TLS refused: a throw from fetch, not a
  // status. 502 rather than the site-wide 500 page, because a broken URL on
  // one food bank must not look like the admin itself falling over.
  it("turns an unreachable site into a 502, not a 500", async () => {
    willReply(() => {
      throw new TypeError("network error");
    });
    const res = await get("/admin/proxy/?foodbank=salisbury&field=url");

    expect(res.status).toBe(502);
    expect(await res.text()).toBe(`${SALISBURY.url} could not be reached. You should check the URL`);
  });

  // The 20s AbortSignal firing arrives as a rejection, so it takes the same
  // branch. Simulated with the DOMException fetch really throws.
  it("turns the 20s timeout into the same 502", async () => {
    willReply(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const res = await get("/admin/proxy/?foodbank=salisbury&field=url");

    expect(res.status).toBe(502);
    expect(await res.text()).toContain("could not be reached");
  });

  // A throw on the FIRST attempt is not retried -- only a 403/429 response is.
  // So a transient DNS blip costs one attempt, matching the comment's "they are
  // genuinely transient" claim being scoped to those two statuses only.
  it("does not retry a thrown fetch", async () => {
    willReply(() => {
      throw new TypeError("network error");
    });
    await get("/admin/proxy/?foodbank=salisbury&field=url");

    expect(upstreamCalls).toHaveLength(1);
  });

  // The failure message names the URL that actually failed, which for a
  // followed link is the target rather than the field's own page. An admin
  // debugging a dead link needs to see the link, not the homepage.
  it("names the target URL in the message when a target was followed", async () => {
    const target = "https://salisbury.foodbank.org.uk/news/2026/gone/";
    willReply(() => new Response("Not Found", { status: 404 }));
    const res = await get(`/admin/proxy/?foodbank=salisbury&field=url&target=${encodeURIComponent(target)}`);

    expect(await res.text()).toBe(`${target} returned 404. You should check the URL`);
  });
});

// ---------------------------------------------------------------------------
// Non-HTML: the shopping list that is a PDF
// ---------------------------------------------------------------------------

describe("adminProxy -- passing non-HTML through untouched", () => {
  // A great many shopping_list_url values are PDFs or images. Running those
  // through an HTML rewriter would corrupt them, so the upstream Response is
  // returned as-is. Asserted with real bytes, and with rewriterConstructed --
  // "no rewriter was even built" is the claim, and a rewriter that merely
  // happened not to match any anchors would satisfy a bytes-only test.
  it("returns a PDF byte-for-byte without constructing a rewriter", async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0xde, 0xad, 0xbe, 0xef]);
    willReply(() => new Response(pdf, { status: 200, headers: { "Content-Type": "application/pdf" } }));

    const res = await get("/admin/proxy/?foodbank=salisbury&field=shopping_list_url");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(pdf);
    expect(rewriterConstructed).toBe(0);
  });

  it("passes an image and a JSON body through the same way", async () => {
    for (const type of ["image/png", "application/json", "text/plain; charset=utf-8"]) {
      willReply(() => new Response("body", { status: 200, headers: { "Content-Type": type } }));
      const res = await get("/admin/proxy/?foodbank=salisbury&field=url");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("body");
    }
    expect(rewriterConstructed).toBe(0);
  });

  // No Content-Type at all falls to `?? ""`, which contains no "html", so the
  // body is passed through. The safe direction: an untyped body is far more
  // likely to be a file than a page, and passing a page through unrewritten
  // costs only the in-iframe navigation, while rewriting a file corrupts it.
  it("passes a body with no Content-Type through unrewritten", async () => {
    willReply(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const res = await get("/admin/proxy/?foodbank=salisbury&field=url");

    expect(res.status).toBe(200);
    expect(rewriterConstructed).toBe(0);
  });

  // Both of the types the handler's own Accept header asks for reach the
  // rewriter: "application/xhtml+xml" contains the substring "html" too. Worth
  // pinning because it is a substring test, not a media-type parse, and the
  // xhtml case is easy to break by "tightening" it to startsWith("text/html").
  it("sends text/html and application/xhtml+xml to the rewriter", async () => {
    for (const type of ["text/html", "text/html;charset=iso-8859-1", "application/xhtml+xml"]) {
      willReply(() => html("<a href='/x'>x</a>", type));
      const res = await get("/admin/proxy/?foodbank=salisbury&field=url");
      expect(res.status).toBe(200);
    }
    expect(rewriterConstructed).toBe(3);
  });

  // SUSPECT, PINNED AS-IS. `.includes("html")` is case-SENSITIVE, and media
  // types are case-insensitive per RFC 9110. A site serving `Content-Type:
  // TEXT/HTML` -- legal, and old IIS and some CMSes do it -- gets its page
  // passed through with no link rewriting at all, so every link inside the
  // preview iframe navigates the iframe away to the live site instead of
  // staying in the proxy. Silent: status 200, page renders, only the
  // navigation is wrong. Reported rather than fixed.
  it("does not rewrite an upper-case TEXT/HTML content type (suspect: case-sensitive includes)", async () => {
    willReply(() => html("<a href='/donate'>Donate</a>", "TEXT/HTML; charset=UTF-8"));
    const res = await get("/admin/proxy/?foodbank=salisbury&field=url");

    expect(res.status).toBe(200);
    expect(rewriterConstructed).toBe(0);
    expect(await res.text()).toBe("<a href='/donate'>Donate</a>");
  });

  // SUSPECT, PINNED AS-IS. The upstream Response is handed back whole, so the
  // food bank's own response headers -- Set-Cookie included -- reach the
  // browser on www.givefood.org.uk's origin, inside an authenticated admin
  // page. routes/admin/gmapProxy.ts builds a fresh Response for exactly this
  // reason and says so in its own tests. Django had the same hole (it returned
  // `HttpResponse(str(soup))` but with no header copying, so in fact Django was
  // narrower here). Reported rather than fixed.
  it("relays the upstream's own response headers, Set-Cookie included (suspect)", async () => {
    willReply(
      () =>
        new Response("body", {
          status: 200,
          headers: { "Content-Type": "application/pdf", "Set-Cookie": "wordpress_logged_in=x; Path=/", "X-Powered-By": "PHP/7.4" },
        }),
    );
    const res = await get("/admin/proxy/?foodbank=salisbury&field=shopping_list_url");

    expect(res.headers.get("Set-Cookie")).toBe("wordpress_logged_in=x; Path=/");
    expect(res.headers.get("X-Powered-By")).toBe("PHP/7.4");
  });
});

// ---------------------------------------------------------------------------
// Rewriting links
// ---------------------------------------------------------------------------

describe("adminProxy -- rewriting the anchors", () => {
  const PROXY_PREFIX = `${ORIGIN}/admin/proxy/?foodbank=salisbury&field=url&target=`;

  /** Preview Salisbury's homepage with `body`, and return the rewritten links. */
  async function preview(body: string, query = "foodbank=salisbury&field=url"): Promise<RecordedLink[]> {
    willReply(() => html(body));
    const res = await get(`/admin/proxy/?${query}`);
    expect(res.status).toBe(200);
    await res.text(); // drain, so the transform stream actually runs
    return rewrittenLinks();
  }

  // The selector is what makes `if (!href) return` reachable only for an empty
  // href; asserted so the guard's meaning is fixed rather than incidental.
  it("registers a single handler on a[href]", async () => {
    await preview("<a href='/donate'>Donate</a>");

    expect(rewriterSelectors).toEqual(["a[href]"]);
  });

  // Django's behaviour, ported: a same-domain link is rewritten back through
  // the proxy so clicking it keeps the preview inside the iframe, and any
  // `target` is removed so it cannot break out.
  it("routes a relative same-origin link back through the proxy and drops its target", async () => {
    const [link] = await preview(`<a href="/give-help/" target="_blank">Give help</a>`);

    expect(link!.after.href).toBe(`${PROXY_PREFIX}${encodeURIComponent("https://salisbury.foodbank.org.uk/give-help/")}`);
    expect("target" in link!.after).toBe(false);
    expect(link!.before.target).toBe("_blank"); // it really was there to remove
  });

  it("routes an absolute same-origin link through the proxy too", async () => {
    const [link] = await preview(`<a href="https://salisbury.foodbank.org.uk/news/">News</a>`);

    expect(link!.after.href).toBe(`${PROXY_PREFIX}${encodeURIComponent("https://salisbury.foodbank.org.uk/news/")}`);
  });

  // A cross-origin link is absolutised and forced to a new tab, so following it
  // leaves the admin's iframe rather than proxying a third party. This is the
  // rewriting half of the same allowlist the `target` check enforces on the way
  // back in: the proxy never offers itself a link it would then refuse.
  it("sends a cross-origin link to a new tab instead of through the proxy", async () => {
    const [link] = await preview(`<a href="https://www.facebook.com/salisburyfoodbank">Facebook</a>`);

    expect(link!.after.href).toBe("https://www.facebook.com/salisburyfoodbank");
    expect(link!.after.target).toBe("_blank");
    expect(link!.after.href).not.toContain("/admin/proxy/");
  });

  it("absolutises a protocol-relative cross-origin link against the page's scheme", async () => {
    const [link] = await preview(`<a href="//twitter.com/salisburyfb">Twitter</a>`);

    expect(link!.after.href).toBe("https://twitter.com/salisburyfb");
    expect(link!.after.target).toBe("_blank");
  });

  // mailto: and tel: have no http origin, so they fall to the cross-origin
  // branch and gain target="_blank". Harmless -- the browser hands them to a
  // mail or dialler app either way -- and identical to Django, whose
  // `urlparse("mailto:...").netloc` is "" and never matched the proxy domain.
  it("gives mailto: and tel: links target=_blank, as Django did", async () => {
    const links = await preview(`<a href="mailto:info@salisbury.foodbank.org.uk">Email</a><a href="tel:+441722349556">Call</a>`);

    expect(links[0]!.after.href).toBe("mailto:info@salisbury.foodbank.org.uk");
    expect(links[0]!.after.target).toBe("_blank");
    expect(links[1]!.after.href).toBe("tel:+441722349556");
  });

  // An in-page anchor resolves to the current page plus a fragment, which is
  // same-origin, so it is rewritten through the proxy -- meaning a "back to
  // top" link reloads the whole preview. A real (small) UX cost, and exactly
  // what Django did, so it is pinned as ported behaviour rather than fixed.
  it("routes a fragment-only link through the proxy, reloading the page (ported quirk)", async () => {
    const [link] = await preview(`<a href="#main">Skip to content</a>`);

    expect(link!.after.href).toBe(`${PROXY_PREFIX}${encodeURIComponent("https://salisbury.foodbank.org.uk/#main")}`);
  });

  // DIVERGENCE FROM DJANGO, pinned. `a[href]` matches `href=""`, but the
  // handler's `if (!href) return` leaves it exactly as it was. Django's
  // `find_all('a', href=True)` also matched it, and `urljoin(url, "")` gave the
  // page itself, so BeautifulSoup rewrote it through the proxy. The port leaves
  // a same-page link unrewritten; the practical effect is that clicking it
  // navigates the iframe to /admin/proxy/ with the same querystring anyway, so
  // nothing visible changes.
  it("leaves an empty href alone, where Django rewrote it", async () => {
    const [link] = await preview(`<a href="">Home</a>`);

    expect(link!.after.href).toBe("");
    expect("target" in link!.after).toBe(false);
  });

  // `new URL(href, base)` throwing is the only way an anchor is skipped other
  // than an empty href, and the handler swallows it rather than 500ing the
  // whole preview. One malformed link on a food bank's page must not take out
  // the page.
  it("skips an unparseable href instead of failing the whole page", async () => {
    const links = await preview(`<a href="http://[">Broken</a><a href="/ok/">Fine</a>`);

    expect(links[0]!.after.href).toBe("http://[");
    expect(links[1]!.after.href).toContain("/admin/proxy/");
  });

  // Relative links resolve against the TARGET, not against the field URL --
  // otherwise every relative link on a deep page would resolve against the
  // homepage and land on a 404 one level up. `../` is the case that proves it:
  // resolved against the homepage it would give /give-help/, against the deep
  // page it gives /news/.
  it("resolves relative links against the page actually being previewed", async () => {
    const target = "https://salisbury.foodbank.org.uk/news/2026/january/";
    const links = await preview(
      `<a href="../">Up one</a><a href="story/">Deeper</a>`,
      `foodbank=salisbury&field=url&target=${encodeURIComponent(target)}`,
    );

    expect(links[0]!.after.href).toBe(`${PROXY_PREFIX}${encodeURIComponent("https://salisbury.foodbank.org.uk/news/2026/")}`);
    expect(links[1]!.after.href).toBe(
      `${PROXY_PREFIX}${encodeURIComponent("https://salisbury.foodbank.org.uk/news/2026/january/story/")}`,
    );
  });

  // The rewritten link keeps the FIELD it came from, so navigating inside a
  // shopping_list_url preview stays a shopping_list_url preview. If the field
  // were hard-coded to "url" the second hop would be origin-checked against the
  // wrong column -- fine while a food bank's fields share an origin, and a 403
  // the moment one does not.
  it("keeps the field the preview was opened with", async () => {
    const [link] = await preview(
      `<a href="/give-help/other/">Other</a>`,
      "foodbank=salisbury&field=shopping_list_url",
    );

    expect(link!.after.href).toContain("&field=shopping_list_url&");
  });

  // The proxy origin comes from the request, not from a constant, so the
  // preview works on a preview deployment and on localhost as well as on
  // production. A hard-coded www.givefood.org.uk would send an admin working
  // against a staging Worker to production's proxy, with production's data.
  it("builds the proxy link from the request's own origin", async () => {
    willReply(() => html(`<a href="/x">x</a>`));
    const res = await app.fetch(
      new Request("https://givefood-beta.example.workers.dev/admin/proxy/?foodbank=salisbury&field=url", {
        headers: { Cookie: `__Host-gfsession=${SESSION_ID}` },
      }),
      env(),
      execCtx,
    );
    await res.text();

    expect(rewrittenLinks()[0]!.after.href).toBe(
      `https://givefood-beta.example.workers.dev/admin/proxy/?foodbank=salisbury&field=url&target=${encodeURIComponent("https://salisbury.foodbank.org.uk/x")}`,
    );
  });

  // THE ROUND TRIP, and the closest this handler has to "save it and load it
  // back". A rewritten href is only worth anything if the handler ACCEPTS it on
  // the next request: the whole in-iframe navigation feature is one link
  // produced here being parsed there. A target that were left unencoded would
  // lose everything after its first `&` and either 403 or preview the wrong
  // page, and nothing about the first response would have said so.
  it("produces a link this same handler accepts, fetching exactly the target", async () => {
    const [link] = await preview(`<a href="/give-help/donate-food/?tab=list&sort=az">Donate food</a>`);

    upstreamCalls = [];
    willReply(() => html("<p>second hop</p>"));
    const followed = await get(link!.after.href!.slice(ORIGIN.length));

    expect(followed.status).toBe(200);
    expect(upstream()).toBe("https://salisbury.foodbank.org.uk/give-help/donate-food/?tab=list&sort=az");
  });

  // DEFENCE IN DEPTH, pinned as such. Django derives every slug from
  // `slugify(self.name)` (givefood/models/foodbank.py:634), which emits
  // [a-z0-9-] and nothing else, so no slug in production needs escaping today
  // -- which is exactly why dropping the escape is invisible.
  //
  // MUTANT KILLED: `foodbank=${slug}` in place of
  // `foodbank=${encodeURIComponent(slug)}`. A slug that reached the table by
  // any route other than slugify -- a bulk import, a hand-edited row, a future
  // model change -- and contains an `&` splits the rewritten link's own
  // querystring in two, so the next hop looks up a truncated slug and the
  // iframe 404s on a link this handler itself produced. Asserted through the
  // full round trip rather than on the href alone, because the claim is that
  // the link the proxy emits is a link the proxy accepts back.
  it("percent-encodes the slug it writes into the rewritten link", async () => {
    const oddSlug = "a&b c";
    insertFoodbank({ ...SALISBURY, id: 4, name: "Odd Slug", slug: oddSlug });

    const links = await preview(`<a href="/x">x</a>`, `foodbank=${encodeURIComponent(oddSlug)}&field=url`);
    const href = links[0]!.after.href!;
    expect(href).toContain(`foodbank=${encodeURIComponent(oddSlug)}&field=url&target=`);

    upstreamCalls = [];
    willReply(() => html("<p>second hop</p>"));
    const followed = await get(href.slice(ORIGIN.length));

    expect(followed.status).toBe(200);
    expect(upstream()).toBe("https://salisbury.foodbank.org.uk/x");
  });

  // The rewriter runs over every anchor on the page, not just the first, and
  // each one is judged on its own origin. A per-page short-circuit would leave
  // most of a real food bank's navigation unrewritten.
  it("judges every anchor on the page independently", async () => {
    const links = await preview(
      `<a href="/">Home</a>
       <a href="https://salisbury.foodbank.org.uk/contact/">Contact</a>
       <a href="https://www.trusselltrust.org/">Trussell</a>
       <a href="mailto:info@example.org">Mail</a>`,
    );

    expect(links).toHaveLength(4);
    expect(links.filter((l) => (l.after.href ?? "").startsWith(`${ORIGIN}/admin/proxy/`))).toHaveLength(2);
    expect(links.filter((l) => l.after.target === "_blank")).toHaveLength(2);
  });

  // An anchor with no href at all is not selected by `a[href]`, so it is never
  // dispatched and never gains a target. Named anchors (`<a name="top">`) are
  // still common on the older sites this proxy exists to preview.
  it("leaves an anchor with no href untouched", async () => {
    const links = await preview(`<a name="top"></a><a href="/x">x</a>`);

    expect(links).toHaveLength(1);
    expect(links[0]!.before.href).toBe("/x");
  });
});
