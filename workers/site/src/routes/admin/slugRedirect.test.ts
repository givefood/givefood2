import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSlugRedirectMap } from "@givefood/db";
import { adminSlugRedirectForm, adminSlugRedirectsList } from "./slugRedirect";
import { requireAdminAuth } from "../../middleware/adminAuth";
import { hmacSha256Hex } from "../../lib/hmac";
import type { AppEnv } from "../../types";

// The two handlers behind gfadmin/views.py:2276-2308, driven the way a
// browser drives them: the real Hono routes from routes/admin/index.ts:
// 225-229 (including the requireAdminAuth the whole sub-app is gated by), the
// real handlers, the real parseAdminFields, the real lib/csrf, the real
// Nunjucks templates and a real in-memory SQLite built from
// migrations/0016_slugredirect.sql. Nothing is faked except the two bindings
// that genuinely leave the machine -- D1 (node:sqlite behind the same
// Sessions-API shim donationPoint.test.ts uses) and the SESSIONS KV namespace
// (a Map that stores what it is given).
//
// WHY A ROUTE-LEVEL FILE WHEN packages/db/src/slugRedirects.test.ts EXISTS.
// That file proves the five statements do what they say against a real
// engine. It cannot prove that the route CALLS them, or calls them with the
// right arguments -- which is exactly the shape of the two bugs this admin
// shipped in a day:
//
//   * #12 -- a duplicate reached the UNIQUE index, SQLite raised, and the 500
//     page took every field the admin had typed with it.
//   * #34 -- the location form parsed a Place ID, passed it down, and no SQL
//     ever named the column. It redirected as though it had worked.
//
// Neither produced an error anyone saw, and neither could have been caught by
// a test that stopped at the redirect. So EVERY assertion here about a save
// reads the row back out of SQLite and checks its columns, and every
// assertion about a refusal reads the whole table back and checks that
// nothing moved. A 302 is not evidence of a write and a 400 is not evidence
// that a write was avoided.

// migrations/0016_slugredirect.sql, verbatim -- five columns, both NOT NULLs
// and BOTH indexes. The UNIQUE one is not decoration: it is the constraint
// the route's pre-flight check exists to keep an admin from hitting, and a
// fixture without it would let these tests reach a state the real database
// refuses, quietly turning every "duplicate is rejected" assertion below into
// an assertion about nothing.
const SCHEMA = `
CREATE TABLE slugredirect (
  id INTEGER PRIMARY KEY,
  old_slug TEXT NOT NULL,            -- CharField(max_length=200, unique=True)
  new_slug TEXT NOT NULL,            -- CharField(max_length=200)
  created TEXT NOT NULL,
  modified TEXT NOT NULL
);
CREATE UNIQUE INDEX slugredirect_old_slug_uniq ON slugredirect(old_slug);
CREATE INDEX slugredirect_created_idx ON slugredirect(created DESC);
`;

type Bindable = null | number | bigint | string | Uint8Array;

// Every SQL string the handlers have asked D1 to prepare during the current
// request, in order. A passthrough recorder, NOT a stand-in: the statement
// still runs against the real engine below and every other assertion in this
// file still reads real rows back. It exists for one claim the row-level
// assertions cannot make -- "this code path never reached the database" --
// which is exactly what slugRedirect.ts:79-82 says its `<int:id>` guard is
// for ("a non-numeric id 404s here rather than reaching the query"). See
// "404s a non-numeric id without preparing a single statement" below for the
// mutant that made this necessary.
const preparedSql: string[] = [];

// The D1 Sessions-API surface packages/db actually uses, over node:sqlite.
// Copied from donationPoint.test.ts rather than reinvented, so the admin
// route suites agree about what D1 does -- in particular that `.first()`
// answers null (never undefined) for no row, which is the difference between
// slugRedirect.ts:86's `if (!existing) return c.notFound()` and a TypeError.
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
    prepare: (sql: string) => {
      preparedSql.push(sql);
      return statement(sql, []);
    },
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

const ORIGIN = "https://www.givefood.org.uk";
const CSRF_SECRET = "test-csrf-secret-not-a-real-one";
const CSRF_RAW = "a".repeat(64);
// lib/adminAuth.ts:61 and :250-252 -- the cookie the session id travels in
// and the key it is stored under. Spelled out rather than imported because
// both are private to that module; if either changes, the sign-in tests in
// auth.test.ts fail first and this file's constants follow.
const SESSION_COOKIE = "__Host-gfsession";
const SESSION_ID = "test-session-id";
const SESSION_TTL_SECONDS = 12 * 60 * 60;

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

// Django's `str(datetime)` -- "YYYY-MM-DD HH:MM:SS.ffffff", which is what the
// ETL wrote into these 57 rows and what pyNow() writes on every save. The
// format is load-bearing for `ORDER BY created DESC`: these columns are TEXT,
// SQLite compares TEXT bytewise, and 'T' (0x54) sorts above ' ' (0x20), so a
// stray toISOString() value would sort above every Django-format value from
// the same day (packages/models/src/pyDatetime.ts, ticket #9).
const T = {
  jan2020: "2020-01-14 09:31:02.114000",
  mar2024: "2024-03-02 11:04:59.000000",
  sep05am: "2026-09-05 08:12:03.140000",
  sep05pm: "2026-09-05 19:28:08.853000",
  sep06: "2026-09-06 05:00:00.000000",
};

let db: DatabaseSync;
let sessions: Map<string, string>;
let app: Hono<AppEnv>;
let env: AppEnv["Bindings"];
// Every message routes/admin/slugRedirect.ts enqueued, in order. A save has
// to purge the OLD slug's pages or the redirect is invisible behind the
// edge cache for the full s-maxage=86400 -- the bug that made
// `north-enfield` -> `enfield` look broken on 2026-09-11.
let purged: { tags: string[] }[];

// routes/admin/index.ts:83-85 and :225-229, reproduced exactly -- the same
// five registrations behind the same requireAdminAuth, mounted at the same
// /admin prefix. Built here rather than importing adminApp because importing
// it drags in every other admin route (and every binding they touch); what
// matters is that the METHOD/PATH table and the auth gate are the real ones,
// since "POST /admin/slug-redirects/ is not a route" and "/slug-redirect/new/
// must beat /slug-redirect/:id/edit/" are both properties of this table
// rather than of either handler.
function buildApp(): Hono<AppEnv> {
  const adminApp = new Hono<AppEnv>();
  adminApp.use("*", requireAdminAuth);
  adminApp.get("/slug-redirects/", adminSlugRedirectsList);
  adminApp.get("/slug-redirect/new/", adminSlugRedirectForm);
  adminApp.post("/slug-redirect/new/", adminSlugRedirectForm);
  adminApp.get("/slug-redirect/:id/edit/", adminSlugRedirectForm);
  adminApp.post("/slug-redirect/:id/edit/", adminSlugRedirectForm);

  const outer = new Hono<AppEnv>();
  // middleware/serverTiming.ts sets this app-wide in the real worker;
  // adminPageContext reads it through elapsedMs() on every render.
  outer.use("*", async (c, next) => {
    c.set("requestStartTime", performance.now());
    await next();
  });
  outer.route("/admin", adminApp);
  // The 500 page issue #12 was actually about. Caught and labelled rather
  // than left to become an unhandled rejection, so a regression reads as
  // "expected 400, got 500: UNIQUE constraint failed" instead of a crash.
  outer.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));
  return outer;
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  preparedSql.length = 0;

  // A real (in-memory) KV namespace rather than a vi.fn(), for the same
  // reason auth.test.ts uses one: requireAdminAuth's answer is a claim about
  // storage, and "the unauthenticated request never reached the handler" is
  // only worth asserting if the authenticated one demonstrably did.
  sessions = new Map<string, string>();
  sessions.set(
    `admin-session:${SESSION_ID}`,
    // expiresAt a full TTL out, so getAdminSession's sliding-refresh branch
    // (lib/adminAuth.ts:286-293) does not fire and rewrite KV mid-test.
    JSON.stringify({
      email: "someone@givefood.org.uk",
      name: "Some One",
      givenName: "Some",
      picture: "",
      expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
    }),
  );

  purged = [];
  env = {
    DB: { withSession: () => d1Session(db) },
    SESSIONS: {
      get: async (key: string) => sessions.get(key) ?? null,
      put: async (key: string, value: string) => void sessions.set(key, value),
      delete: async (key: string) => void sessions.delete(key),
    },
    CSRF_SECRET,
    GMAP_STATIC_KEY: "",
    GMAP_GEOCODE_KEY: "",
    PURGE_Q: { send: async (msg: { tags: string[] }) => void purged.push(msg) },
  } as unknown as AppEnv["Bindings"];

  app = buildApp();
});

afterEach(() => {
  vi.useRealTimers();
});

// ===================== driving it like a browser =====================

interface Sent {
  res: Response;
  html: string;
}

interface Options {
  /** Omit the session cookie entirely -- an anonymous request. */
  anonymous?: boolean;
  /** The value of the hidden csrf_token field; omit the field with null. */
  csrfToken?: string | null;
  /** Send no __Host-csrf cookie at all. */
  noCsrfCookie?: boolean;
  /**
   * Send this __Host-csrf cookie value verbatim instead of the properly
   * signed one -- a cookie the server never minted.
   */
  csrfCookie?: string;
  /** Override the Origin header -- an off-site form posting at us. */
  origin?: string;
  /** Override Sec-Fetch-Site; the empty string omits the header entirely. */
  secFetchSite?: string;
}

function cookieHeader(signedCsrf: string, options: Options): string | undefined {
  const parts: string[] = [];
  if (!options.anonymous) parts.push(`${SESSION_COOKIE}=${SESSION_ID}`);
  if (!options.noCsrfCookie) parts.push(`__Host-csrf=${options.csrfCookie ?? signedCsrf}`);
  return parts.length ? parts.join("; ") : undefined;
}

async function send(method: "GET" | "POST", path: string, fields: Record<string, string> | null, options: Options = {}): Promise<Sent> {
  const signedCsrf = `${CSRF_RAW}.${await hmacSha256Hex(CSRF_SECRET, CSRF_RAW)}`;
  const headers: Record<string, string> = { Origin: options.origin ?? ORIGIN };
  const secFetchSite = options.secFetchSite ?? "same-origin";
  if (secFetchSite) headers["Sec-Fetch-Site"] = secFetchSite;
  const cookie = cookieHeader(signedCsrf, options);
  if (cookie) headers["Cookie"] = cookie;

  let body: string | undefined;
  if (method === "POST") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    const token = options.csrfToken === undefined ? CSRF_RAW : options.csrfToken;
    const params = new URLSearchParams(fields ?? {});
    if (token !== null) params.set("csrf_token", token);
    body = params.toString();
  }

  const res = await app.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body }), env, execCtx);
  // Read the body once, here: several assertions want it and a Response body
  // can only be consumed once.
  const html = res.status === 302 ? "" : await res.text();
  return { res, html };
}

const get = (path: string, options: Options = {}) => send("GET", path, null, options);
const post = (path: string, fields: Record<string, string>, options: Options = {}) => send("POST", path, fields, options);

// ===================== reading the rendered page =====================

// The (old_slug, new_slug) pairs of admin/slug_redirects.njk's table, in the
// order the page shows them. Scoped to <tbody> and matched as two ADJACENT
// bare <td>s, which is only true of those two cells: the created cell holds a
// <br>, the Edit cell holds an <a>, and the empty-state cell carries
// colspan="4". Returning the pairs rather than a row count is deliberate --
// "page 2 has 1 row" passes for a pager that returns the wrong row.
function tableRows(html: string): [string, string][] {
  const body = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
  return [...body.matchAll(/<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>/g)].map((m) => [m[1] as string, m[2] as string]);
}

const oldSlugsOnPage = (html: string) => tableRows(html).map(([oldSlug]) => oldSlug);

// The whole `<form method="post">` block generic_form.njk renders -- the
// search box in admin/page.njk:55 is method="get", so this is unambiguous.
function postForm(html: string): string {
  const start = html.indexOf('<form method="post"');
  return html.slice(start, html.indexOf("</form>", start));
}

// Every input/textarea/select name the admin's browser would submit from the
// form, in document order.
function formFieldNames(html: string): string[] {
  return [...postForm(html).matchAll(/name="([^"]+)"/g)].map((m) => m[1] as string);
}

// The value a text input comes back holding. Nunjucks autoescapes into the
// attribute, so the raw HTML is decoded here rather than asserted around --
// the expectation stays the string an admin would read in the box.
function inputValue(html: string, name: string): string | null {
  const match = postForm(html).match(new RegExp(`<input[^>]*name="${name}"[^>]*value="([^"]*)"`));
  if (!match) return null;
  return (match[1] as string)
    .replace(/&#34;|&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// ===================== reading the database back =====================

interface Row {
  id: number;
  old_slug: string;
  new_slug: string;
  created: string;
  modified: string;
}

function wholeTable(): Row[] {
  return db.prepare("SELECT * FROM slugredirect ORDER BY id").all().map((row) => ({ ...(row as unknown as Row) }));
}

function stored(oldSlug: string): Row | null {
  const row = db.prepare("SELECT * FROM slugredirect WHERE old_slug = ?").get(oldSlug);
  return row ? { ...(row as unknown as Row) } : null;
}

// Read a row back by its PRIMARY KEY rather than by old_slug. Needed by the
// per-field round-trip test below, which changes old_slug itself: looking the
// row up by the value under test would make "the UPDATE never wrote it" and
// "the UPDATE wrote it" equally satisfiable (the first finds the old row, the
// second finds the new one) and is precisely how the earlier version of that
// test let a dropped `old_slug = ?` column through.
function byId(id: number): Row | null {
  const row = db.prepare("SELECT * FROM slugredirect WHERE id = ?").get(id);
  return row ? { ...(row as unknown as Row) } : null;
}

function seedRedirect(row: { id?: number; old_slug: string; new_slug: string; created?: string; modified?: string }): void {
  db.prepare("INSERT INTO slugredirect (id, old_slug, new_slug, created, modified) VALUES (?, ?, ?, ?, ?)").run(
    row.id ?? null,
    row.old_slug,
    row.new_slug,
    row.created ?? T.mar2024,
    row.modified ?? row.created ?? T.mar2024,
  );
}

// Ids DELIBERATELY scrambled against the created order: the expected
// `-created` sequence is ids 3, 5, 1, 4, 2, which is neither ascending nor
// descending by id, so a list that lost its ORDER BY (or sorted by id) cannot
// produce the right answer by luck.
function seedFiveRenames(): void {
  seedRedirect({ id: 3, old_slug: "durham", new_slug: "county-durham", created: T.sep06 });
  seedRedirect({ id: 5, old_slug: "hull", new_slug: "kingston-upon-hull", created: T.sep05pm });
  seedRedirect({ id: 1, old_slug: "brixton", new_slug: "norwood-and-brixton", created: T.sep05am });
  seedRedirect({ id: 4, old_slug: "epsom", new_slug: "epsom-and-ewell", created: T.mar2024 });
  seedRedirect({ id: 2, old_slug: "salisbury-old", new_slug: "salisbury", created: T.jan2020 });
}

const NEWEST_FIRST = ["durham", "hull", "brixton", "epsom", "salisbury-old"];

// Date only, so the awaits in these tests still resolve on a real event loop.
function freezeClock(instant: string): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(instant));
}

// ===========================================================================
// adminSlugRedirectsList
// ===========================================================================

describe("adminSlugRedirectsList", () => {
  // gfadmin/views.py:2278 is `SlugRedirect.objects.all().order_by("-created")`
  // -- newest first, and Django's list is unpaginated so the ordering is the
  // one piece of this page ported straight across. It is also the failure an
  // admin notices last: a list sorted the wrong way still renders, still holds
  // every row, and just buries the redirect that was added thirty seconds ago.
  it("renders every redirect newest-created first", async () => {
    seedFiveRenames();

    const { res, html } = await get("/admin/slug-redirects/");

    expect(res.status).toBe(200);
    expect(oldSlugsOnPage(html)).toEqual(NEWEST_FIRST);
  });

  // Both columns, in the right cells. A template that rendered old_slug twice
  // (or swapped the pair) passes the ordering test above and tells the admin
  // that "durham" redirects to itself.
  it("puts the old slug and the new slug in their own columns", async () => {
    seedRedirect({ old_slug: "durham", new_slug: "county-durham", created: T.sep06 });

    expect(tableRows((await get("/admin/slug-redirects/")).html)).toEqual([["durham", "county-durham"]]);
  });

  // The count is the port's own addition (Django's template has none), and it
  // comes from the COUNT(*) rather than from the page of rows -- so it must
  // stay right when a page is not full and when there are more pages than one.
  it("shows the whole table's count in the heading, not the page's", async () => {
    seedFiveRenames();

    expect((await get("/admin/slug-redirects/")).html).toContain("Slug Redirects (5)");
  });

  // The empty state, also a port addition -- Django renders an unconditional
  // loop and shows a bare table. A brand-new database must not 500 on
  // totalPages(0, 100), which is why that helper is Math.max(1, ...).
  it("renders the empty state and a single page for an empty table", async () => {
    const { res, html } = await get("/admin/slug-redirects/");

    expect(res.status).toBe(200);
    expect(tableRows(html)).toEqual([]);
    expect(html).toContain('<td colspan="4">None</td>');
    expect(html).toContain("Slug Redirects (0)");
    expect(html).toContain("Page 1 of 1");
  });

  // Every row's Edit link has to carry that row's OWN id. With the ids
  // scrambled against the display order, a template using the loop index --
  // or the route dropping `id` from the row objects -- sends the admin to a
  // different redirect's form, which they then edit believing it is the one
  // they clicked. getSlugRedirectById cannot catch that: id 1 is a real row.
  it("links each row's Edit button at that row's own id", async () => {
    seedFiveRenames();

    const { html } = await get("/admin/slug-redirects/");

    // durham is id 3 and displayed FIRST; salisbury-old is id 2 and displayed
    // last. An index-derived href would give them 1 and 5.
    expect(html).toContain('href="/admin/slug-redirect/3/edit/"');
    expect(html).toContain('href="/admin/slug-redirect/2/edit/"');
    expect([...html.matchAll(/\/admin\/slug-redirect\/(\d+)\/edit\//g)].map((m) => m[1])).toEqual(["3", "5", "1", "4", "2"]);
  });

  // The two-line date cell: Django's DATETIME_FORMAT on the first line,
  // relative time beneath (Django's own template uses `|naturaltime`, which
  // has no port equivalent -- a superset of the same information).
  //
  // THE MUTANT THIS KILLS is `timesince(row.modified, now)`, an easy slip
  // given the row carries both. The seed here makes created and modified
  // years apart in opposite directions, so exactly one of the two possible
  // implementations can produce this string. It matters because the relative
  // time is the only thing on the page an admin uses to answer "is this the
  // redirect I added last week?", and `modified` would answer a different
  // question while looking identical.
  it("dates each row from created, not modified", async () => {
    seedRedirect({ old_slug: "epsom", new_slug: "epsom-and-ewell", created: T.mar2024, modified: T.sep06 });
    freezeClock("2026-09-06T05:00:00.000Z");

    const { html } = await get("/admin/slug-redirects/");

    expect(html).toContain("March 2, 2024, 11:04 a.m.");
    expect(html).toContain("2 years, 6 months ago");
    expect(html).not.toContain("0 minutes ago");
  });

  // views.py:2282's `"section":"settings"`, which is what lights the nav's
  // Settings entry. Cheap to get wrong (every other admin list picks a
  // different section) and invisible until someone notices the nav no longer
  // tells them where they are.
  it("marks the page as the settings section, matching views.py:2282", async () => {
    const { html } = await get("/admin/slug-redirects/");

    expect(html).toContain('<a class="navbar-item is-active" href="/admin/settings/">Settings</a>');
    // ...and exactly one entry is lit, so this is not passing on a nav that
    // marks everything active.
    expect(html).toContain('<a class="navbar-item" href="/admin/foodbanks/">Food Banks</a>');
  });

  it("offers the New Slug Redirect button", async () => {
    expect((await get("/admin/slug-redirects/")).html).toContain('href="/admin/slug-redirect/new/"');
  });

  // A GET is not a mutation. Trivial to satisfy and trivial to break -- this
  // handler and adminSlugRedirectForm both branch on the METHOD inside one
  // function, so "the list page wrote something" is one misplaced call away.
  it("writes nothing", async () => {
    seedFiveRenames();
    const before = wholeTable();

    await get("/admin/slug-redirects/");

    expect(wholeTable()).toEqual(before);
  });

  // PAGE_SIZE is 100 and Django's list has no pagination at all, so this is
  // entirely the port's. 101 rows is the smallest seed that can prove the
  // LIMIT excludes anything: the oldest row MUST NOT be on page 1, and a
  // pager that ignored its LIMIT (or its OFFSET) passes every test that only
  // seeds rows it expects to see.
  describe("pagination", () => {
    // 101 distinct `created` values, descending with i, so row 0 is newest
    // and row 100 is oldest -- a deterministic order with no ties, which
    // matters because `ORDER BY created DESC` has no secondary sort and
    // LIMIT/OFFSET over an unstable sort can repeat one row and drop another.
    // They differ only in the microseconds field, zero-padded to six digits so
    // that SQLite's bytewise TEXT comparison is also the numeric one.
    function seed101(): void {
      for (let i = 0; i < 101; i += 1) {
        const micros = String(101 - i).padStart(6, "0");
        seedRedirect({ old_slug: `old-${i}`, new_slug: `new-${i}`, created: `2026-01-14 12:00:00.${micros}` });
      }
    }

    it("shows the first hundred and excludes the hundred-and-first", async () => {
      seed101();

      const { html } = await get("/admin/slug-redirects/");

      const slugs = oldSlugsOnPage(html);
      expect(slugs).toHaveLength(100);
      expect(slugs[0]).toBe("old-0");
      expect(slugs[99]).toBe("old-99");
      // THE ASSERTION THE WHOLE 101-ROW SEED EXISTS FOR. A filter that does
      // nothing passes every test that only seeds matching rows.
      expect(slugs).not.toContain("old-100");
      expect(html).toContain("Slug Redirects (101)");
      expect(html).toContain("Page 1 of 2");
      expect(html).toContain('href="?page=2"');
    });

    it("shows the hundred-and-first, and only it, on page two", async () => {
      seed101();

      const { html } = await get("/admin/slug-redirects/?page=2");

      expect(oldSlugsOnPage(html)).toEqual(["old-100"]);
      expect(html).toContain("Page 2 of 2");
      expect(html).toContain('href="?page=1"'); // Previous
      expect(html).not.toContain('href="?page=3"'); // hasNext is false on the last page
    });

    // ?page=99 is a URL anyone can type or bookmark. It has to render an
    // empty table with the real total, not 500 and not claim there is more.
    it("renders an empty page past the end without losing the count", async () => {
      seedFiveRenames();

      const { res, html } = await get("/admin/slug-redirects/?page=9");

      expect(res.status).toBe(200);
      expect(tableRows(html)).toEqual([]);
      expect(html).toContain("Slug Redirects (5)");
      expect(html).not.toContain('href="?page=10"');
    });

    // parsePage's guard, exercised through the URL rather than asserted
    // about. A NaN reaching the query binds as NULL, `LIMIT 100 OFFSET NULL`
    // returns NOTHING, and the admin sees an empty list for a table with 57
    // rows in it -- an empty page being indistinguishable from an empty
    // table is the reason this is worth pinning at all.
    it.each([
      ["?page=abc", "not a number"],
      ["?page=0", "zero"],
      ["?page=-3", "negative"],
      ["?page=", "empty"],
      ["?page=1e5", "exponent notation, which parseInt reads as 1"],
    ])("falls back to page 1 for %s (%s)", async (query) => {
      seedFiveRenames();

      const { res, html } = await get(`/admin/slug-redirects/${query}`);

      expect(res.status).toBe(200);
      expect(oldSlugsOnPage(html)).toEqual(NEWEST_FIRST);
      expect(html).toContain("Page 1 of 1");
    });

    // DOCUMENTED, NOT ENDORSED: parseInt stops at the first non-digit, so
    // "2abc" and "2.9" are both page 2 rather than a fallback to 1. Harmless
    // here -- an out-of-range page renders empty and nothing mutates -- and
    // pinned only because the SAME parseInt shape on the :id parameter below
    // is not harmless.
    it("reads a trailing-garbage page number as its leading digits", async () => {
      seedFiveRenames();

      expect((await get("/admin/slug-redirects/?page=2abc")).html).toContain("Page 2 of 1");
      expect((await get("/admin/slug-redirects/?page=1.9")).html).toContain("Page 1 of 1");
    });
  });
});

// ===========================================================================
// adminSlugRedirectForm -- GET
// ===========================================================================

describe("adminSlugRedirectForm (GET)", () => {
  // views.py:2294's page_title, verbatim. The title is also slugified into
  // the form's class name (generic_form.njk:35), which static/js/admin.js
  // matches on -- so it is not only cosmetic.
  it("opens a blank create form", async () => {
    const { res, html } = await get("/admin/slug-redirect/new/");

    expect(res.status).toBe(200);
    expect(html).toContain("New Slug Redirect");
    expect(inputValue(html, "old_slug")).toBe("");
    expect(inputValue(html, "new_slug")).toBe("");
  });

  // views.py:2291's page_title on the edit branch, and the reason the two
  // URLs share one view at all.
  it("opens an edit form titled for editing, holding the stored row", async () => {
    seedFiveRenames();

    const { res, html } = await get("/admin/slug-redirect/4/edit/");

    expect(res.status).toBe(200);
    expect(html).toContain("Edit Slug Redirect");
    expect(inputValue(html, "old_slug")).toBe("epsom");
    expect(inputValue(html, "new_slug")).toBe("epsom-and-ewell");
  });

  // THE FIELD LIST, PINNED. Issue #34 was a field that existed on the form
  // and was written by no SQL; the cheapest guard against its recurrence on
  // THIS form is to fail the moment its shape changes, so that whoever adds a
  // third field has to come here and extend the round-trip test below rather
  // than discovering months later that it never saved. givefood/forms.py:
  // 219-222's `fields = "__all__"` on SlugRedirect yields exactly these two:
  // `id` is the auto PK and created/modified are editable=False on
  // TimestampedModel, so Django's ModelForm excludes all three too.
  it("renders exactly the two fields Django's ModelForm does, and the CSRF token", async () => {
    const { html } = await get("/admin/slug-redirect/new/");

    expect(formFieldNames(html)).toEqual(["csrf_token", "old_slug", "new_slug"]);
    // Both required, so the browser blocks an empty submit before the server
    // has to -- and so `*` appears beside both labels.
    expect(html).toContain("Old slug *");
    expect(html).toContain("New slug *");
    // Django shows no help text here; these two lines are the port's, and
    // they are the only thing on the page saying "slug" means a bare path
    // segment. Typing a full URL in is the obvious mistake and nothing
    // validates against it (see the "accepts a slug that can never match"
    // test below), so the help text is the whole guard.
    expect(html).toContain("no leading or trailing slash");
  });

  // Django has NO delete view for SlugRedirect -- the list and this form are
  // the only two, verified against gfadmin/views.py. delete_url is passed as
  // null so generic_form.njk:50 renders no Delete button, and a redirect can
  // therefore only be retired by pointing it somewhere harmless. Pinned so
  // that a Delete button appearing here is a decision someone made, not one
  // that arrived with a copy-paste from donationPoint.ts.
  it("offers no Delete button, because Django has no delete for this model", async () => {
    seedFiveRenames();

    const { html } = await get("/admin/slug-redirect/4/edit/");

    expect(html).not.toContain("Delete");
    expect(html).not.toContain("is-danger");
  });

  // views.py:2290's get_object_or_404.
  it("404s an id that does not exist", async () => {
    seedFiveRenames();

    expect((await get("/admin/slug-redirect/999/edit/")).res.status).toBe(404);
  });

  it("404s an id in a gap rather than opening the next row along", async () => {
    seedRedirect({ id: 1, old_slug: "brixton", new_slug: "norwood-and-brixton" });
    seedRedirect({ id: 5, old_slug: "hull", new_slug: "kingston-upon-hull" });

    expect((await get("/admin/slug-redirect/3/edit/")).res.status).toBe(404);
  });

  it("404s a wholly non-numeric id, as Django's <int:id> converter would", async () => {
    seedFiveRenames();

    expect((await get("/admin/slug-redirect/abc/edit/")).res.status).toBe(404);
    expect((await get("/admin/slug-redirect/edit/edit/")).res.status).toBe(404);
  });

  // views.py:2292/2295 pass "section":"settings" on BOTH form branches, same
  // as the list. Pinned separately from the list's own section test because
  // the two handlers call adminPageContext independently and the form's call
  // was unasserted: changing it to any other section survived the whole
  // suite. The symptom is small and permanent -- the admin opens New Slug
  // Redirect and the nav claims they are in Food Banks -- and the nav is the
  // only thing on an admin page that says where you are.
  it("marks both form branches as the settings section too", async () => {
    seedFiveRenames();

    for (const path of ["/admin/slug-redirect/new/", "/admin/slug-redirect/4/edit/"]) {
      const { html } = await get(path);
      expect(html).toContain('<a class="navbar-item is-active" href="/admin/settings/">Settings</a>');
      // ...and exactly one entry is lit, so this cannot pass on a nav that
      // marks everything active.
      expect(html).toContain('<a class="navbar-item" href="/admin/foodbanks/">Food Banks</a>');
    }
  });

  // slugRedirect.ts:79-82's guard, asserted as the thing it claims to be
  // rather than by its status code. The 404 alone proves nothing: DELETING
  // the guard outright still yields a 404, because parseInt's NaN reaches
  // getSlugRedirectById, matches no row, and falls into views.py:2290's
  // get_object_or_404 branch instead. That mutant survived the whole suite.
  //
  // It is not a harmless equivalence. node:sqlite binds a NaN happily; D1
  // does not have to, and the port's own comment ("404s here rather than
  // reaching the query") is a promise that the query is never attempted. So
  // the assertion is that no statement was prepared at all -- the one claim
  // a row read-back cannot make. preparedSql is a passthrough recorder on
  // the real session, not a stand-in for it.
  it("404s a non-numeric id without preparing a single statement", async () => {
    seedFiveRenames();
    preparedSql.length = 0;

    const { res } = await get("/admin/slug-redirect/abc/edit/");

    expect(res.status).toBe(404);
    // Scoped to this table rather than to "no statement whatsoever", so that
    // a future session lookup somewhere in the middleware chain does not fail
    // this test for a reason it is not about.
    expect(preparedSql.filter((sql) => sql.includes("slugredirect"))).toEqual([]);
  });

  // The same on the write path, where reaching the query would also mean
  // reaching everything after it.
  it("404s a POST to a non-numeric id without preparing a statement or writing a row", async () => {
    seedFiveRenames();
    const before = wholeTable();
    preparedSql.length = 0;

    const { res } = await post("/admin/slug-redirect/abc/edit/", { old_slug: "durham", new_slug: "hijacked" });

    expect(res.status).toBe(404);
    expect(preparedSql.filter((sql) => sql.includes("slugredirect"))).toEqual([]);
    expect(wholeTable()).toEqual(before);
  });

  // SUSPECT, PINNED AS-IS. slugRedirect.ts:79-82 says "a non-numeric id 404s
  // here rather than reaching the query", but the check is
  // Number.parseInt + Number.isInteger, and parseInt stops at the first
  // non-digit: "4abc" is a number to it. Django's `<int:id>` converter is
  // `[0-9]+` and would not have matched this URL at all, so this is a real
  // divergence from both the port's own comment and the view it cites.
  //
  // The damage is small but is the familiar shape: a mistyped or
  // truncated URL silently opens SOMEBODY ELSE'S redirect, pre-filled, and
  // the admin edits it believing it is the row they asked for. Not fixed
  // here (the fix is a /^\d+$/ test on idParam, in the source); asserted so
  // the divergence is on the record.
  it("treats an id with trailing garbage as its leading digits (suspect: parseInt, not <int:id>)", async () => {
    seedFiveRenames();

    const { res, html } = await get("/admin/slug-redirect/4abc/edit/");

    expect(res.status).toBe(200);
    expect(inputValue(html, "old_slug")).toBe("epsom"); // id 4's row
  });

  it("writes nothing on either branch", async () => {
    seedFiveRenames();
    const before = wholeTable();

    await get("/admin/slug-redirect/new/");
    await get("/admin/slug-redirect/4/edit/");
    await get("/admin/slug-redirect/999/edit/");

    expect(wholeTable()).toEqual(before);
  });
});

// ===========================================================================
// adminSlugRedirectForm -- POST, the write path
// ===========================================================================

describe("adminSlugRedirectForm (POST) -- creating", () => {
  // THE BASELINE ISSUE #34 DID NOT HAVE. A 302 to the list is what the
  // location form gave for months while writing no Place ID at all, so the
  // redirect is asserted alongside the ROW, read straight out of SQLite.
  it("writes the row and returns to the list", async () => {
    const { res } = await post("/admin/slug-redirect/new/", { old_slug: "durham", new_slug: "county-durham" });

    expect(res.status).toBe(302);
    // views.py:2300's `redirect("admin:slug_redirects")`, which resolves to
    // gfadmin/urls/core.py:8 -- the plural path, not this form's singular one.
    expect(res.headers.get("Location")).toBe("/admin/slug-redirects/");
    expect(stored("durham")).toMatchObject({ old_slug: "durham", new_slug: "county-durham" });
    expect(wholeTable()).toHaveLength(1);
  });

  // TimestampedModel (givefood/models/base.py:12-19) is auto_now_add on
  // `created` and auto_now on `modified`; SQLite has neither, so the route's
  // writer stamps both. Frozen clock, so this is the exact string rather than
  // a regex that would also accept an ISO value -- and an ISO value here
  // would pin every new redirect to the top of the admin list forever
  // (ticket #9), which looks right and is not.
  it("stamps created and modified in Django's format, not ISO", async () => {
    freezeClock("2026-09-05T19:28:08.853Z");

    await post("/admin/slug-redirect/new/", { old_slug: "durham", new_slug: "county-durham" });

    expect(stored("durham")).toEqual({
      id: 1,
      old_slug: "durham",
      new_slug: "county-durham",
      created: T.sep05pm,
      modified: T.sep05pm,
    });
  });

  // parseAdminFields trims, and here that is not cosmetic. The middleware
  // looks the raw path segment up in a map keyed on the stored bytes
  // (getSlugRedirectMap keys verbatim, proved in slugRedirects.test.ts), so a
  // stored "durham " matches no URL that exists and the redirect is dead on
  // arrival with nothing anywhere saying so.
  it("trims the slugs, so a pasted trailing space cannot make a dead redirect", async () => {
    await post("/admin/slug-redirect/new/", { old_slug: "  durham  ", new_slug: "\tcounty-durham\n" });

    expect(stored("durham")).toMatchObject({ old_slug: "durham", new_slug: "county-durham" });
  });

  // The save is immediately visible to the middleware's own reader -- the
  // property the removal of the DATA-KV blob was meant to guarantee
  // (middleware/slugRedirect.ts:14-21: "the 57 rows loaded on 2026-09-05 all
  // 404'd until someone pressed the button, because loading the table is not
  // the same as writing the blob"). The route deliberately purges no cache;
  // this is the assertion that says it does not need to.
  it("is live in the redirect map the middleware reads, with no cache to rebuild", async () => {
    await post("/admin/slug-redirect/new/", { old_slug: "durham", new_slug: "county-durham" });

    expect(await getSlugRedirectMap(d1Session(db) as never)).toEqual({ durham: "county-durham" });
  });

  // Nothing is asserted about a redirect the admin cannot see, so the round
  // trip is closed here: create, then open the edit form the list links to
  // and read the values back out of the rendered inputs. This is the test
  // that would have caught issue #34 on day one for THIS form -- a field
  // parsed, passed down and written by no SQL comes back empty here while
  // every status code stays green.
  it("hands both fields back to the edit form it just created", async () => {
    await post("/admin/slug-redirect/new/", { old_slug: "durham", new_slug: "county-durham" });
    const id = stored("durham")!.id;

    const { res, html } = await get(`/admin/slug-redirect/${id}/edit/`);

    expect(res.status).toBe(200);
    expect(inputValue(html, "old_slug")).toBe("durham");
    expect(inputValue(html, "new_slug")).toBe("county-durham");
  });

  // ...and the whole way round again: re-submit exactly what the browser
  // would send from that form. The field the admin left alone survives the
  // trip out of storage, into the input, back through the POST and into the
  // UPDATE.
  //
  // CORRECTED CLAIM. This test used to say it caught an UPDATE that dropped
  // `old_slug = ?` from its column list -- issue #34's exact shape. It does
  // not, and the mutant proved it: the row's old_slug here is already
  // "durham" and the POST resubmits "durham", so an UPDATE that never writes
  // the column leaves exactly the value this asserts. What it DOES kill is
  // the same drop of `new_slug`. The old_slug half is covered by "changes
  // %s alone..." in the editing block below, which is the only test in this
  // file that ever changes an old_slug successfully.
  it("round-trips a value the admin did not touch, through the form and back into the UPDATE", async () => {
    await post("/admin/slug-redirect/new/", { old_slug: "durham", new_slug: "county-durham" });
    const id = stored("durham")!.id;
    const { html } = await get(`/admin/slug-redirect/${id}/edit/`);

    // Built from the rendered form, not from the database row: a value only
    // returns on a POST if a field exists for it and the form was given it,
    // which is the link being tested.
    const body: Record<string, string> = {};
    for (const name of formFieldNames(html)) {
      if (name === "csrf_token") continue;
      body[name] = inputValue(html, name) ?? "";
    }
    expect(body).toEqual({ old_slug: "durham", new_slug: "county-durham" });

    const { res } = await post(`/admin/slug-redirect/${id}/edit/`, { ...body, new_slug: "durham-city" });

    expect(res.status).toBe(302);
    expect(wholeTable()).toHaveLength(1);
    expect(stored("durham")).toMatchObject({ id, old_slug: "durham", new_slug: "durham-city" });
  });
});

// The two fields generic_form.njk renders for this model, and therefore the
// two an edit has to be able to change. Kept as a list rather than two tests
// so that adding a third field to SLUG_REDIRECT_FIELDS without extending this
// one is caught by the guard assertion inside the loop, not left to be
// noticed months later -- which is the process failure behind issue #34 as
// much as the missing column was.
const EDITABLE_FIELDS = ["old_slug", "new_slug"] as const;

describe("adminSlugRedirectForm (POST) -- editing", () => {
  // THE TEST ISSUE #34 WOULD HAVE FAILED ON DAY ONE, and the one this file
  // was missing. Every other edit test here resubmits the row's own old_slug
  // unchanged, so all of them pass against an UPDATE whose column list has
  // lost `old_slug = ?` entirely -- the mutant was run and survived the whole
  // 72-test suite. So did the handler-level variant that passes
  // `existing.old_slug` down instead of the value the admin typed. Both are
  // #34 exactly: a field the form offers, the admin fills in, the handler
  // parses, and no SQL ever writes -- answered with a 302 to the list as
  // though it had worked.
  //
  // Each field is changed ON ITS OWN so the assertion is unambiguous about
  // which column moved, the row is read back BY ID (never by the value under
  // test -- see byId's comment), the untouched field is asserted to have
  // survived, and the rendered form is reloaded to prove the new value is
  // what the admin would see rather than something only SELECT knows about.
  //
  // MUTANTS THIS KILLS, all of which survived the suite before it existed:
  //   * UPDATE ... SET new_slug = ?, modified = ? WHERE id = ?   (old_slug dropped)
  //   * upsertSlugRedirect(db, { oldSlug: existing.old_slug, newSlug }, ...)
  it.each(EDITABLE_FIELDS)("changes %s alone and reads the new value back out of the row and the form", async (field) => {
    seedRedirect({ id: 4, old_slug: "epsom", new_slug: "epsom-and-ewell", created: T.mar2024 });

    const { html: before } = await get("/admin/slug-redirect/4/edit/");
    // The guard: if a third field is ever added to SLUG_REDIRECT_FIELDS this
    // fails here, forcing whoever added it to extend EDITABLE_FIELDS rather
    // than shipping a field nothing proves is written.
    expect(formFieldNames(before).filter((name) => name !== "csrf_token")).toEqual([...EDITABLE_FIELDS]);

    // Built from the rendered inputs, exactly as the browser would submit
    // them, then one value changed -- so this exercises the same read -> form
    // -> POST -> write path the admin does.
    const body: Record<string, string> = {};
    for (const name of EDITABLE_FIELDS) body[name] = inputValue(before, name) ?? "";
    const untouched = EDITABLE_FIELDS.find((name) => name !== field)!;
    const survives = body[untouched] as string;
    const changed = `${body[field]}-renamed`;
    body[field] = changed;

    const { res } = await post("/admin/slug-redirect/4/edit/", body);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/slug-redirects/");
    // An UPDATE, not a second row: the old value must be GONE, not merely
    // joined by the new one.
    expect(wholeTable()).toHaveLength(1);
    expect(byId(4)?.[field]).toBe(changed);
    expect(byId(4)?.[untouched]).toBe(survives);
    // ...and the admin sees it, which is the half a SELECT cannot promise.
    expect(inputValue((await get("/admin/slug-redirect/4/edit/")).html, field)).toBe(changed);
  });

  // The same write with BOTH fields changed at once. Separate from the loop
  // above because an UPDATE that bound its two same-typed parameters the
  // wrong way round (`bind(newSlug, oldSlug, ...)`) is invisible while only
  // one of them moves, and swapping two adjacent binds of the same type is
  // the classic careless edit here -- the columns are adjacent in the SET
  // list and both are TEXT, so nothing complains at any layer.
  it("changes both slugs in one save without transposing them", async () => {
    seedRedirect({ id: 4, old_slug: "epsom", new_slug: "epsom-and-ewell", created: T.mar2024 });

    const { res } = await post("/admin/slug-redirect/4/edit/", { old_slug: "ewell", new_slug: "epsom-and-ewell-borough" });

    expect(res.status).toBe(302);
    expect(byId(4)).toMatchObject({ old_slug: "ewell", new_slug: "epsom-and-ewell-borough" });
    // The middleware's own view of the change: the retired slug is the KEY
    // and the destination the VALUE, so a transposition shows up here as a
    // redirect pointing the wrong way rather than as a missing row.
    expect(await getSlugRedirectMap(d1Session(db) as never)).toEqual({ ewell: "epsom-and-ewell-borough" });
  });

  // Renaming onto a slug NOTHING holds has to be allowed -- the mirror of
  // "refuses a rename onto another redirect's old slug" below. Without this,
  // a uniqueness pre-flight that simply returned true for every non-empty
  // slug would look correct: every duplicate test would pass and the only
  // symptom would be that no old_slug could ever be edited, which is a
  // support ticket rather than a test failure.
  it("allows a rename onto a slug no other row holds", async () => {
    seedFiveRenames();

    const { res } = await post("/admin/slug-redirect/4/edit/", { old_slug: "epsom-borough", new_slug: "epsom-and-ewell" });

    expect(res.status).toBe(302);
    expect(byId(4)).toMatchObject({ old_slug: "epsom-borough" });
    expect(stored("epsom")).toBeNull(); // the slug it was renamed away from
    expect(wholeTable()).toHaveLength(5);
  });

  // givefood/models/operations.py:46-47's max_length=200 is a property of the
  // COLUMN, so it binds the edit path as tightly as the create path -- but
  // every length test in this file posted to /new/, and the mutant that
  // scoped the guard to creates only (`existing === null && ...`) survived
  // the suite. An admin pasting a URL over an existing slug is at least as
  // likely as doing it on a fresh one.
  it("applies the 200-character limit on the edit path too", async () => {
    seedRedirect({ id: 4, old_slug: "epsom", new_slug: "epsom-and-ewell" });
    const before = wholeTable();
    const tooLong = "a".repeat(201);

    const first = await post("/admin/slug-redirect/4/edit/", { old_slug: tooLong, new_slug: "epsom-and-ewell" });
    const second = await post("/admin/slug-redirect/4/edit/", { old_slug: "epsom", new_slug: tooLong });

    expect(first.res.status).toBe(400);
    expect(first.html).toBe("Slugs are limited to 200 characters");
    expect(second.res.status).toBe(400);
    expect(second.html).toBe("Slugs are limited to 200 characters");
    expect(wholeTable()).toEqual(before);
  });

  // UPDATE, not INSERT. Two rows for one old_slug is the state the UNIQUE
  // index exists to make impossible, so the failure mode of an edit that
  // inserted would be a constraint error over the admin's typed values.
  it("updates the row in place and keeps its id", async () => {
    seedFiveRenames();

    const { res } = await post("/admin/slug-redirect/4/edit/", { old_slug: "epsom", new_slug: "epsom-and-ewell-borough" });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/slug-redirects/");
    expect(wholeTable()).toHaveLength(5);
    expect(stored("epsom")).toMatchObject({ id: 4, new_slug: "epsom-and-ewell-borough" });
  });

  // auto_now_add means `created` is set once. Re-stamping it on an edit would
  // reshuffle the admin list every time someone fixed a typo in a two-year-old
  // redirect, pushing whatever was genuinely newest off the first page.
  it("moves modified forward and leaves created alone", async () => {
    seedRedirect({ id: 4, old_slug: "epsom", new_slug: "epsom-and-ewel", created: T.mar2024, modified: T.mar2024 });
    freezeClock("2026-09-06T05:00:00.000Z");

    await post("/admin/slug-redirect/4/edit/", { old_slug: "epsom", new_slug: "epsom-and-ewell" });

    expect(stored("epsom")).toEqual({
      id: 4,
      old_slug: "epsom",
      new_slug: "epsom-and-ewell",
      created: T.mar2024,
      modified: T.sep06,
    });
  });

  // The `WHERE id = ?` on the UPDATE, which is the difference between editing
  // one redirect and rewriting all 57 with the same pair of slugs. A missing
  // WHERE leaves the edited row correct, so the assertion has to be about the
  // other four.
  it("leaves every other row untouched", async () => {
    seedFiveRenames();
    const before = wholeTable().filter((row) => row.id !== 4);

    await post("/admin/slug-redirect/4/edit/", { old_slug: "epsom", new_slug: "epsom-and-ewell-borough" });

    expect(wholeTable().filter((row) => row.id !== 4)).toEqual(before);
  });

  // THE REGRESSION exceptId EXISTS FOR. The commonest edit on this form is
  // "the old slug is right, the destination is wrong" -- which re-submits the
  // row's own old_slug. A uniqueness check that matched the row against
  // itself would make that permanently unsavable, with no workaround short of
  // deleting a row the admin has no Delete button for.
  it("lets a redirect keep its own old slug", async () => {
    seedFiveRenames();

    const { res } = await post("/admin/slug-redirect/3/edit/", { old_slug: "durham", new_slug: "durham-city" });

    expect(res.status).toBe(302);
    expect(stored("durham")).toMatchObject({ id: 3, new_slug: "durham-city" });
  });

  // ...but only ITS own. Retyping another row's old_slug is a genuine clash,
  // and if the pre-flight let it through the UNIQUE index would raise and
  // app.onError would render a 500 over the form: issue #12, on this table.
  it("refuses a rename onto another redirect's old slug, and changes nothing", async () => {
    seedFiveRenames();
    const before = wholeTable();

    const { res, html } = await post("/admin/slug-redirect/5/edit/", { old_slug: "durham", new_slug: "somewhere-else" });

    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
    expect(html).toBe('A redirect from "durham" already exists');
    expect(wholeTable()).toEqual(before);
  });

  // views.py:2290's get_object_or_404 runs before the POST branch in Django
  // too, so a form submitted against a row someone else has deleted 404s
  // rather than creating a replacement. Worth pinning because the writer
  // would NOT have complained: upsertSlugRedirect's UPDATE against a missing
  // id matches no rows, changes nothing and reports success, so without this
  // 404 the admin would get their 302 back to the list and their edit would
  // simply not be there (pinned in slugRedirects.test.ts as "silently does
  // nothing"; this is the caller-side guard that keeps it unreachable).
  it("404s a POST to an id that no longer exists, rather than silently saving nothing", async () => {
    seedFiveRenames();
    const before = wholeTable();

    const { res } = await post("/admin/slug-redirect/999/edit/", { old_slug: "durham-city", new_slug: "county-durham" });

    expect(res.status).toBe(404);
    expect(wholeTable()).toEqual(before);
  });
});

// ===========================================================================
// Refusals -- every one of these must leave the table exactly as it was
// ===========================================================================

describe("adminSlugRedirectForm (POST) -- cache purge", () => {
  // THE BUG THIS FILE MISSED ENTIRELY. `north-enfield` -> `enfield` was
  // added in the live admin on 2026-09-11 and /needs/at/north-enfield/ kept
  // serving its own 200 page afterwards. The middleware was right -- the
  // same URL with a cache-buster returned the 301 immediately -- but the
  // plain URL was already in the Cloudflare cache under `s-maxage=86400`,
  // and index.ts:131 spells out why that is fatal: "because wrangler.jsonc
  // enables the Workers Cache a HIT never executes the Worker". The route
  // carried a comment asserting there was "no cache to invalidate", which
  // was true of the middleware's 5-minute memo and false of the edge.
  //
  // So the assertion is on the enqueued message, not on a 302: every save
  // in this file already returned 302 while purging nothing at all.
  it("purges the old slug's pages, or the redirect stays invisible behind the edge cache", async () => {
    await post("/admin/slug-redirect/new/", { old_slug: "north-enfield", new_slug: "enfield" });

    expect(purged).toEqual([{ tags: ["fb-north-enfield"] }]);
  });

  // The NEW slug is deliberately absent. Its pages are unchanged by a
  // redirect -- /needs/at/enfield/ served the same bytes before and after --
  // so purging it would evict a live page to no effect.
  it("does not purge the new slug", async () => {
    await post("/admin/slug-redirect/new/", { old_slug: "north-enfield", new_slug: "enfield" });

    expect(purged[0]!.tags).not.toContain("fb-enfield");
  });

  // AGGREGATE_TAG covers the home page, the map, every API collection and
  // every constituency page -- the site's hot set. A redirect changes none
  // of them, and foodbank.ts purges it only because a food bank's DATA
  // appears in those lists. Purging it here would turn a two-field admin
  // save into a site-wide eviction.
  it("does not purge the aggregates", async () => {
    await post("/admin/slug-redirect/new/", { old_slug: "north-enfield", new_slug: "enfield" });

    expect(purged[0]!.tags).not.toContain("fb-all");
  });

  // Editing old_slug strands the PREVIOUS one: it is no longer redirected,
  // but its 301 may already be cached. `existing` is read before the UPDATE,
  // so the route still has that value -- a handler that purged only the
  // submitted slug would leave the old 301 serving forever.
  it("also purges the previous old_slug when an edit moves it", async () => {
    seedRedirect({ id: 7, old_slug: "north-enfield", new_slug: "enfield", created: T.mar2024 });

    await post("/admin/slug-redirect/7/edit/", { old_slug: "enfield-north", new_slug: "enfield" });

    expect(purged).toHaveLength(1);
    expect(purged[0]!.tags.slice().sort()).toEqual(["fb-enfield-north", "fb-north-enfield"]);
  });

  // ...and does NOT double up when the edit leaves old_slug alone, which is
  // what every other edit test in this file posts.
  it("purges the slug once when an edit leaves old_slug unchanged", async () => {
    seedRedirect({ id: 7, old_slug: "north-enfield", new_slug: "enfield", created: T.mar2024 });

    await post("/admin/slug-redirect/7/edit/", { old_slug: "north-enfield", new_slug: "enfield-borough" });

    expect(purged).toEqual([{ tags: ["fb-north-enfield"] }]);
  });

  // A rejected save wrote nothing, so there is nothing stale to evict. The
  // guard matters because the enqueue sits after the validation block: move
  // it above one of those early returns and every 400 starts purging.
  it.each([
    ["a clashing old_slug", { old_slug: "taken", new_slug: "somewhere" }],
    ["old and new the same", { old_slug: "loop", new_slug: "loop" }],
  ])("purges nothing when the save is rejected for %s", async (_label, body) => {
    seedRedirect({ id: 9, old_slug: "taken", new_slug: "elsewhere", created: T.mar2024 });

    const { res } = await post("/admin/slug-redirect/new/", body);

    expect(res.status).toBe(400);
    expect(purged).toEqual([]);
  });
});

describe("adminSlugRedirectForm (POST) -- validation", () => {
  // The unique=True clash Django reports as "Slug redirect with this Old slug
  // already exists." The UNIQUE index in 0016_slugredirect.sql is the real
  // guard; this check is what turns it into a sentence instead of a 500.
  it("refuses a duplicate old slug on create, and writes nothing", async () => {
    seedFiveRenames();
    const before = wholeTable();

    const { res, html } = await post("/admin/slug-redirect/new/", { old_slug: "durham", new_slug: "somewhere-else" });

    expect(res.status).toBe(400);
    expect(html).toBe('A redirect from "durham" already exists');
    expect(wholeTable()).toEqual(before);
  });

  // THE CREATE-PATH MUTANT KILLER, at the route level. On a create there is
  // no row to exclude, so exceptId binds NULL -- and spelled `id != ?` the
  // pre-flight matches nothing, reports "free", and the INSERT hits the
  // UNIQUE index for real. The assertion is on the RESPONSE rather than on
  // the helper because the bug was never "the SQL is wrong", it was "the
  // admin gets a 500 and loses the form".
  it("is not defeated by the NULL exclusion of a create", async () => {
    seedRedirect({ old_slug: "durham", new_slug: "county-durham" });

    const { res, html } = await post("/admin/slug-redirect/new/", { old_slug: "durham", new_slug: "somewhere-else" });

    expect(res.status).toBe(400);
    expect(html).not.toContain("five hundred"); // the onError backstop above
    expect(wholeTable()).toHaveLength(1);
  });

  // THE SENTINEL, at the route level. `existing?.id` is undefined on a create
  // and slugRedirects.ts binds `exceptId ?? null`, because NULL is the only
  // value no row can hold. MUTANT `existing?.id ?? 0` -- the shape of an edit
  // made to quiet a "number | undefined" complaint -- is indistinguishable
  // from the real thing for every id from 1 up, and survives every other test
  // in this file. Id 0 is the single input that tells them apart: under
  // `?? 0` the row excludes ITSELF from the create-time check, the pre-flight
  // reports a plainly-taken slug as free, and the UNIQUE index turns the
  // refusal into the 500 over the admin's typed values that issue #12 was
  // about. Id 0 is reachable -- SQLite honours an explicitly inserted 0 in an
  // INTEGER PRIMARY KEY, and the ETL that loaded these 57 rows carried
  // Django's own ids across.
  it("still catches a duplicate held by a row with id 0", async () => {
    seedRedirect({ id: 0, old_slug: "durham", new_slug: "county-durham" });

    const { res, html } = await post("/admin/slug-redirect/new/", { old_slug: "durham", new_slug: "somewhere-else" });

    expect(res.status).toBe(400);
    expect(html).toBe('A redirect from "durham" already exists');
    expect(wholeTable()).toHaveLength(1);
  });

  // Byte-for-byte, exactly as strict as the index it stands in for:
  // parseAdminFields trims but does not case-fold, and neither does SQLite's
  // default BINARY collation. So "Durham" saves alongside "durham" -- which
  // matches Django on Postgres (a plain unique=True CharField is
  // case-sensitive) and is therefore a faithful port, but means the admin
  // now holds a redirect that can never fire, since every food bank slug on
  // the site is lowercase. Pinned as inherited behaviour, not endorsed.
  it("compares old slugs case-sensitively, so 'Durham' is a different redirect", async () => {
    seedRedirect({ old_slug: "durham", new_slug: "county-durham" });

    const { res } = await post("/admin/slug-redirect/new/", { old_slug: "Durham", new_slug: "county-durham" });

    expect(res.status).toBe(302);
    expect(wholeTable().map((row) => row.old_slug).sort()).toEqual(["Durham", "durham"]);
  });

  // A PORT ADDITION with no Django equivalent: Django will happily save
  // old == new, and the moment the map reaches the middleware
  // /needs/at/durham/ 301s to /needs/at/durham/ forever.
  it("refuses a redirect that points at itself", async () => {
    const { res, html } = await post("/admin/slug-redirect/new/", { old_slug: "durham", new_slug: "durham" });

    expect(res.status).toBe(400);
    expect(html).toBe("Old slug and new slug are the same");
    expect(wholeTable()).toEqual([]);
  });

  // The same guard on the edit path -- an admin "fixing" a redirect by
  // pasting the same slug into both boxes is the likelier way to reach it.
  it("refuses to edit a redirect into pointing at itself", async () => {
    seedFiveRenames();
    const before = wholeTable();

    const { res } = await post("/admin/slug-redirect/3/edit/", { old_slug: "durham", new_slug: "durham" });

    expect(res.status).toBe(400);
    expect(wholeTable()).toEqual(before);
  });

  // givefood/models/operations.py:46-47 -- CharField(max_length=200) on both,
  // enforced by Django's ModelForm. parseAdminFields has no length rule and
  // SQLite's TEXT has no length at all, so this route is the ONLY thing
  // standing between a pasted 4KB string and the column.
  it("refuses either slug over 200 characters", async () => {
    const tooLong = "a".repeat(201);

    const first = await post("/admin/slug-redirect/new/", { old_slug: tooLong, new_slug: "county-durham" });
    const second = await post("/admin/slug-redirect/new/", { old_slug: "durham", new_slug: tooLong });

    expect(first.res.status).toBe(400);
    expect(first.html).toBe("Slugs are limited to 200 characters");
    expect(second.res.status).toBe(400);
    expect(wholeTable()).toEqual([]);
  });

  // The boundary itself, in the accepting direction -- an off-by-one here
  // rejects a slug Django and the column would both have taken.
  it("accepts a slug of exactly 200 characters", async () => {
    const exactly = "a".repeat(200);

    const { res } = await post("/admin/slug-redirect/new/", { old_slug: exactly, new_slug: "county-durham" });

    expect(res.status).toBe(302);
    expect(stored(exactly)).not.toBeNull();
  });

  // Django's own required-field validation, which the port does by hand.
  // The label in the message is Django's auto verbose_name -- capfirst() of
  // the field name with underscores spaced, so "Old slug", never "Old Slug".
  it.each([
    [{ old_slug: "", new_slug: "county-durham" }, "Old slug is required"],
    [{ old_slug: "durham", new_slug: "" }, "New slug is required"],
    [{ old_slug: "   ", new_slug: "county-durham" }, "Old slug is required"],
    [{}, "Old slug is required"],
  ])("refuses %j with %s", async (fields, message) => {
    const { res, html } = await post("/admin/slug-redirect/new/", fields as Record<string, string>);

    expect(res.status).toBe(400);
    expect(html).toBe(message);
    expect(wholeTable()).toEqual([]);
  });

  // The order the three checks run in, pinned because each message is the
  // only thing telling the admin what to change. Length before uniqueness
  // (an over-long slug's clash is not the useful complaint), uniqueness
  // before self-reference.
  it("reports the length problem ahead of the duplicate one", async () => {
    const tooLong = "a".repeat(201);
    seedRedirect({ old_slug: tooLong, new_slug: "county-durham" });

    const { html } = await post("/admin/slug-redirect/new/", { old_slug: tooLong, new_slug: "somewhere-else" });

    expect(html).toBe("Slugs are limited to 200 characters");
  });

  it("reports the duplicate ahead of the points-at-itself one", async () => {
    seedRedirect({ old_slug: "durham", new_slug: "county-durham" });

    const { html } = await post("/admin/slug-redirect/new/", { old_slug: "durham", new_slug: "durham" });

    expect(html).toBe('A redirect from "durham" already exists');
  });

  // SUSPECT, PINNED AS-IS -- and the reason every refusal test above also
  // asserts the plain-text body. A rejected save on THIS form replies
  // `c.text(...)`: no form, no values, no CSRF token, nothing to press Save
  // from. The admin's only way back is the browser's Back button.
  //
  // slugRedirect.ts:98-102 justifies it as "the port's established
  // convention, see routes/admin/parlcon.ts:28,31" -- but that comment is
  // now STALE. parlcon.ts:27-36 re-renders the bound form with an `error`
  // banner, and so do foodbankLocation.ts and donationPoint.ts, both changed
  // for exactly this reason when issue #12 was fixed. This handler is the
  // last one in the admin that still throws the admin's typing away on a
  // refusal, and generic_form.njk already has the `error` slot the comment
  // says it lacks (:27). Two fields is a smaller loss than ten, which is
  // presumably why it was left -- but the duplicate-old-slug case is the
  // MOST likely refusal on this form, and it is the one where the admin has
  // just looked both slugs up.
  //
  // Not fixed here, and deliberately not a failing test: this asserts what
  // the code does.
  it("replies in plain text and discards what the admin typed (suspect: form not re-rendered)", async () => {
    seedRedirect({ old_slug: "durham", new_slug: "county-durham" });

    const { res, html } = await post("/admin/slug-redirect/new/", { old_slug: "durham", new_slug: "somewhere-else" });

    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("somewhere-else"); // the value the admin typed, gone
    expect(html).not.toContain("csrf_token");
  });

  // SUSPECT, PINNED AS-IS. The `oldSlug === newSlug` guard exists because
  // "old == new is an infinite 301 loop the moment the blob reaches the
  // middleware" -- but so is a TWO-ROW cycle, and nothing looks for one.
  // Both saves below are accepted, and from that moment /needs/at/durham/
  // 301s to /needs/at/county-durham/ which 301s back, until the browser
  // gives up with ERR_TOO_MANY_REDIRECTS. It is the exact failure the
  // one-row check was added to prevent, one row further out.
  //
  // Reachable by ordinary means: a food bank renamed and then renamed back,
  // or an admin correcting a redirect they entered the wrong way round and
  // adding the reverse instead of editing the original. Nothing in the admin
  // shows it, because each row reads correctly on its own. A cheap guard
  // would be to refuse a newSlug that is already some row's old_slug.
  it("saves a two-row redirect cycle, which loops forever (suspect: only the one-row case is checked)", async () => {
    const first = await post("/admin/slug-redirect/new/", { old_slug: "durham", new_slug: "county-durham" });
    const second = await post("/admin/slug-redirect/new/", { old_slug: "county-durham", new_slug: "durham" });

    expect(first.res.status).toBe(302);
    expect(second.res.status).toBe(302);
    expect(await getSlugRedirectMap(d1Session(db) as never)).toEqual({ durham: "county-durham", "county-durham": "durham" });
  });

  // SUSPECT, PINNED AS-IS. Neither slug is validated for SHAPE, and the help
  // text ("no leading or trailing slash") is the only thing that says one is
  // wanted. middleware/slugRedirect.ts:46 matches the path with
  // `^(/(?:<prefixes>))?/needs/at/([-\w]+)(/[-\w]+)?/?$`, so a stored
  // old_slug containing a slash, a space or any other non-`[-\w]` character
  // can never be the captured segment -- the row saves, appears in the admin
  // list looking correct, and never fires. That is issue #34's shape exactly:
  // accepted, stored, and silently inert.
  //
  // A `new_slug` of the same shape is worse, because it DOES take effect --
  // the middleware interpolates it straight into the Location header, so
  // "/needs/at/county durham/" is what the visitor is sent to.
  it("accepts a slug the redirect middleware can never match (suspect: no shape validation)", async () => {
    const withSlash = await post("/admin/slug-redirect/new/", { old_slug: "/durham/", new_slug: "county-durham" });
    const withSpace = await post("/admin/slug-redirect/new/", { old_slug: "county durham", new_slug: "county-durham" });
    const fullUrl = await post("/admin/slug-redirect/new/", {
      old_slug: "https://www.givefood.org.uk/needs/at/durham/",
      new_slug: "county-durham",
    });

    expect([withSlash.res.status, withSpace.res.status, fullUrl.res.status]).toEqual([302, 302, 302]);
    expect(wholeTable().map((row) => row.old_slug)).toEqual(["/durham/", "county durham", "https://www.givefood.org.uk/needs/at/durham/"]);
  });
});

// ===========================================================================
// Auth and CSRF -- every refusal here also asserts that no row moved
// ===========================================================================

describe("authentication", () => {
  // routes/admin/index.ts:85's `adminApp.use("*", requireAdminAuth)`. These
  // two handlers carry no auth check of their own, so the gate is the mount,
  // and a route registered outside adminApp would be world-writable with
  // nothing failing.
  it("bounces an anonymous GET to sign-in without rendering the list", async () => {
    seedFiveRenames();

    const { res, html } = await get("/admin/slug-redirects/", { anonymous: true });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fslug-redirects%2F");
    expect(html).not.toContain("durham");
  });

  it("bounces an anonymous GET of the edit form, which would otherwise leak the row", async () => {
    seedFiveRenames();

    const { res, html } = await get("/admin/slug-redirect/4/edit/", { anonymous: true });

    expect(res.status).toBe(302);
    expect(html).not.toContain("epsom");
  });

  // THE ONE THAT MATTERS. A perfectly-formed POST, valid CSRF token and all,
  // from someone with no session: it must not reach the handler, and the
  // proof is the table, not the status code.
  it("refuses an anonymous POST and writes nothing", async () => {
    seedFiveRenames();
    const before = wholeTable();

    const { res } = await post("/admin/slug-redirect/new/", { old_slug: "wolverhampton", new_slug: "wolves" }, { anonymous: true });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fslug-redirect%2Fnew%2F");
    expect(wholeTable()).toEqual(before);
  });

  it("refuses an anonymous POST to the edit form and writes nothing", async () => {
    seedFiveRenames();
    const before = wholeTable();

    await post("/admin/slug-redirect/4/edit/", { old_slug: "epsom", new_slug: "hijacked" }, { anonymous: true });

    expect(wholeTable()).toEqual(before);
  });

  // A session cookie whose id is not in KV is not a session. Pinned because
  // "the cookie exists" is the check a shortcut would make.
  it("refuses a session cookie KV has never heard of", async () => {
    sessions.clear();

    const { res } = await get("/admin/slug-redirects/");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("/auth/");
  });
});

describe("CSRF", () => {
  // Django's admin has no CSRF middleware at all (settings.py:97 comments it
  // out), so its `{% csrf_token %}` tags are decorative and this whole
  // describe block is a port addition. It is also the only thing standing
  // between a signed-in admin visiting a malicious page and that page
  // rewriting the site's redirect table.
  //
  // The last two entries are the two shapes a REAL attack arrives in, and
  // both were missing: deleting the Sec-Fetch-Site branch of verifyCsrf, and
  // deleting its cookie-signature check, each survived this file's whole
  // suite. (lib/csrf.test.ts covers both at unit level; these are here
  // because what this file asserts is that the ROUTE is wired to the real
  // verifyCsrf, and a route wired to a weakened one must fail somewhere.)
  it.each([
    ["no csrf_token field", { csrfToken: null } as Options],
    ["a csrf_token that does not match the cookie", { csrfToken: "b".repeat(64) } as Options],
    ["an empty csrf_token", { csrfToken: "" } as Options],
    ["no __Host-csrf cookie", { noCsrfCookie: true } as Options],
    ["a cross-site Origin", { origin: "https://evil.example" } as Options],
    // A cross-site form POST that omits Origin -- Sec-Fetch-Site is then the
    // only header saying where the request came from.
    ["Sec-Fetch-Site: cross-site", { secFetchSite: "cross-site", origin: "" } as Options],
    // The attack lib/csrf.ts's header describes: a cookie planted from
    // elsewhere, with the hidden field set to match its raw half. The
    // double-submit pair agrees with itself perfectly; only the HMAC says it
    // was never minted here.
    ["a __Host-csrf cookie this server never signed", { csrfCookie: `${"c".repeat(64)}.${"0".repeat(64)}`, csrfToken: "c".repeat(64) } as Options],
  ])("refuses a create with %s, and writes nothing", async (_label, options) => {
    const { res, html } = await post("/admin/slug-redirect/new/", { old_slug: "durham", new_slug: "county-durham" }, options);

    expect(res.status).toBe(403);
    expect(html).toBe("Forbidden");
    expect(wholeTable()).toEqual([]);
  });

  it("refuses an edit with a bad token, and leaves the row alone", async () => {
    seedFiveRenames();
    const before = wholeTable();

    const { res } = await post("/admin/slug-redirect/4/edit/", { old_slug: "epsom", new_slug: "hijacked" }, { csrfToken: "b".repeat(64) });

    expect(res.status).toBe(403);
    expect(wholeTable()).toEqual(before);
  });

  // The check runs BEFORE parseAdminFields (slugRedirect.ts:91 vs :93), so a
  // forged request learns nothing about the form's contents -- not which
  // field it got wrong, not whether a slug is already taken. A validation
  // failure reported ahead of the CSRF failure would turn this endpoint into
  // an oracle for the redirect table.
  it("rejects on CSRF before it says anything about the submitted values", async () => {
    seedRedirect({ old_slug: "durham", new_slug: "county-durham" });

    const { res, html } = await post("/admin/slug-redirect/new/", { old_slug: "durham", new_slug: "" }, { csrfToken: "b".repeat(64) });

    expect(res.status).toBe(403);
    expect(html).toBe("Forbidden");
    expect(html).not.toContain("already exists");
    expect(html).not.toContain("required");
  });

  // The token the page renders has to be the one the page's own POST is
  // accepted with, or the form is decorative in the other direction: every
  // save 403s. Taken from the rendered HTML, not from the constant, so this
  // is the real double-submit loop -- issueCsrfToken minted or reused it,
  // generic_form.njk:36 embedded it, verifyCsrf accepted it.
  it("accepts the token the form itself was rendered with", async () => {
    const { html } = await get("/admin/slug-redirect/new/");
    const token = html.match(/name="csrf_token" value="([^"]*)"/)?.[1];

    expect(token).toBe(CSRF_RAW); // reused from the cookie the request carried

    const { res } = await post("/admin/slug-redirect/new/", { old_slug: "durham", new_slug: "county-durham" }, { csrfToken: token });

    expect(res.status).toBe(302);
    expect(stored("durham")).not.toBeNull();
  });

  // views.py:2290's get_object_or_404 runs before the POST branch, so a
  // forged POST at a missing id gets the 404 rather than the 403. Harmless
  // (nothing is written either way) and pinned only because it is the one
  // place where a CSRF failure is not what comes back.
  it("404s ahead of the CSRF check when the id does not exist", async () => {
    const { res } = await post("/admin/slug-redirect/999/edit/", { old_slug: "durham", new_slug: "county-durham" }, { csrfToken: null });

    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// The route table itself
// ===========================================================================

describe("the registered routes", () => {
  // routes/admin/index.ts:223-224's own warning: Hono matches in
  // registration order, so /slug-redirect/new/ must precede
  // /slug-redirect/:id/edit/ or the literal loses to the parameter. It does
  // not collide today (the paths differ in shape), but the create route
  // resolving as an edit of redirect "new" would be a 404 on the button
  // every admin uses to add one.
  it("routes /slug-redirect/new/ to the create form, not to an edit of id 'new'", async () => {
    seedFiveRenames();

    const { res, html } = await get("/admin/slug-redirect/new/");

    expect(res.status).toBe(200);
    expect(html).toContain("New Slug Redirect");
  });

  // The list is registered GET-only and the form GET+POST, matching
  // gfadmin/urls/core.py:8-10 -- so a POST at the list, or any other method
  // anywhere, is refused by the router before a handler sees it. Asserted
  // because "the handler branches on c.req.method" invites the assumption
  // that every method reaches it.
  it("does not accept a POST at the list page", async () => {
    seedFiveRenames();
    const before = wholeTable();

    const { res } = await post("/admin/slug-redirects/", { old_slug: "durham", new_slug: "county-durham" });

    expect(res.status).toBe(404);
    expect(wholeTable()).toEqual(before);
  });
});
