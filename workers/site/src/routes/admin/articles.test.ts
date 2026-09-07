import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { adminArticleToggleFeatured } from "./articles";
import { adminApp } from "./index";
import { requireAdminAuth } from "../../middleware/adminAuth";
import { hmacSha256Hex } from "../../lib/hmac";
import type { AppEnv } from "../../types";

// gfadmin/views.py:3399-3417 article_toggle_featured, as ported. One button,
// one column, and three ways for it to be quietly wrong:
//
//   1. THE WRITE NEVER HAPPENS. github #34's shape exactly -- the Place ID was
//      parsed, threaded through the handler, and then written by no SQL at
//      all, and the redirect made it look saved. Here the equivalent is a
//      handler that renders the ★ fragment htmx swaps in without the UPDATE
//      landing: the admin sees a filled star, presses nothing else, and the
//      home page (routes/public.ts:49 getFeaturedArticles, `WHERE a.featured
//      = 1`) never shows the article. So EVERY test below that expects a
//      toggle reads `featured` back out of SQLite; not one of them trusts the
//      status code or the returned markup as evidence of a save.
//   2. THE SWAPPED-IN BUTTON IS A DEAD END. Django's fragment
//      (views.py:3409-3414) carries no CSRF anything, because
//      CsrfViewMiddleware is commented out in production (settings.py:97).
//      This port validates CSRF for real, so its fragment had to grow an
//      `hx-vals` the Django one does not have -- and if that were ever
//      dropped to "match Django", the FIRST press would work and every press
//      after it would 403 into htmx's silent error path, leaving a star that
//      lies. `pressing the returned button again` below round-trips the
//      fragment through a second request rather than asserting on its text.
//   3. THE REFUSALS DON'T REFUSE. A 403 or a 404 that still toggled the row
//      is worse than no check, so every rejection test asserts the stored
//      integer as well as the status.
//
// REAL ROUTER, REAL MIDDLEWARE, REAL DATABASE. The route is mounted the way
// routes/admin/index.ts:83-85,275 mounts it -- inside `adminApp`, behind the
// genuine requireAdminAuth, grafted onto a parent with `app.route("/admin",
// ...)` -- because the auth gate, the path rebasing and the `:id` param are
// all things a hand-built Context would paper over. The only stubs are the
// two bindings that would otherwise leave the machine: `SESSIONS` (a KV
// namespace, faked as a Map) and `DB` (a real in-memory SQLite behind D1's
// async statement surface). verifyCsrf, toggleArticleFeatured and the SQL
// underneath them are the shipped implementations.

// 0003_homepage_data.sql:47-53, less `foodbank_name` (dropped by
// 0019_drop_foodbank_cache.sql:56), plus 0010_article_url_unique.sql:9.
// `article_published_idx` is copied in verbatim because its `WHERE featured =
// 1` is the reason "featured" has to end up as exactly 1 and not merely
// something truthy -- see the `1 - featured` arithmetic test at the end.
const SCHEMA = `
CREATE TABLE foodbankarticle (
  id INTEGER PRIMARY KEY,
  foodbank_id INTEGER,
  published_date TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
  featured INTEGER NOT NULL
);
CREATE INDEX article_published_idx ON foodbankarticle(published_date DESC) WHERE featured = 1;
CREATE UNIQUE INDEX article_url_uniq ON foodbankarticle(url);
`;

type Bindable = null | number | bigint | string | Uint8Array;

// The D1PreparedStatement surface packages/db uses, over node:sqlite. Lifted
// from donationPoint.test.ts, with one addition that matters here: `first()`
// has to honour SQLite's RETURNING clause, because toggleArticleFeatured
// (packages/db/src/adminLists.ts:330) is an UPDATE ... RETURNING read through
// first(). node:sqlite's `get()` runs a RETURNING statement and hands back
// the returned row, which is exactly what D1 does, so the flip and its
// read-back stay one round trip here as in production.
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

const ORIGIN = "https://www.givefood.org.uk";
const CSRF_SECRET = "test-csrf-secret-not-a-real-one";
const CSRF_RAW = "b".repeat(64);
const SESSION_ID = "test-session-id";

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
// Keyed exactly as lib/adminAuth.ts:250 sessionKvKey() spells it. A test that
// invented its own key would "prove" the auth gate rejects everything.
let sessions: Map<string, string>;

function seedArticle(id: number, featured: number, title = `Article ${id}`): void {
  db.prepare("INSERT INTO foodbankarticle (id, foodbank_id, published_date, title, url, featured) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    null,
    "2026-09-01 00:00:00.000000",
    title,
    `https://example.invalid/article/${id}`,
    featured,
  );
}

// The single source of truth for "did the write happen". Deliberately returns
// the raw stored INTEGER rather than a boolean: `featured = 1 - featured` can
// land on values that are neither 0 nor 1, and a boolean cast here would hide
// precisely the case the last describe block is about.
function featuredOf(id: number): number | null {
  const row = db.prepare("SELECT featured FROM foodbankarticle WHERE id = ?").get(id) as { featured: number } | undefined;
  return row ? row.featured : null;
}

function allFeatured(): number[] {
  return (db.prepare("SELECT featured FROM foodbankarticle ORDER BY id").all() as { featured: number }[]).map((r) => r.featured);
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  sessions = new Map([
    [
      `admin-session:${SESSION_ID}`,
      // expiresAt a full TTL ahead means getAdminSession()'s sliding-window
      // refresh does not fire, so no test here depends on the KV stub's put().
      JSON.stringify({ email: "someone@givefood.org.uk", name: "Some One", givenName: "Some", picture: "", expiresAt: Date.now() + 12 * 60 * 60 * 1000 }),
    ],
  ]);
});

interface RequestOptions {
  method?: string;
  /** The `csrf_token` form field. `null` omits the field entirely. */
  csrfField?: string | null;
  /** The raw half of the `__Host-csrf` cookie. `null` omits the cookie. */
  csrfCookieRaw?: string | null;
  /** Overrides the cookie's signature, to forge one that will not verify. */
  csrfCookieSignature?: string;
  /** `null` omits `__Host-gfsession`, i.e. an anonymous visitor. */
  sessionId?: string | null;
  origin?: string | null;
  secFetchSite?: string | null;
  /** `true` sends the `HX-Request: true` htmx sends; a string sends that value. */
  hx?: boolean | string;
  /**
   * `null` leaves CSRF_SECRET unset in the environment. Spelled as null rather
   * than undefined on purpose: a default parameter treats an explicitly passed
   * `undefined` as "not passed", so `{ secret: undefined }` would silently get
   * the real secret and the fail-closed test would assert nothing.
   */
  secret?: string | null;
  /**
   * Which router to send through. "mirror" (the default) is the hand-built
   * one, kept for the handler-behaviour tests because it isolates the handler
   * from 70-odd unrelated registrations. "real" is `adminApp` itself, and is
   * the only one that can notice a change to routes/admin/index.ts.
   */
  router?: "mirror" | "real";
  /**
   * Sends the body as multipart/form-data with `csrf_token` as a FILE part
   * rather than a text field, which is the only way to make `c.req.parseBody()`
   * hand the handler a non-string for that key.
   */
  csrfAsFile?: boolean;
}

// Wired exactly as routes/admin/index.ts does it: requireAdminAuth on the
// sub-app, the toggle route registered on the sub-app at the path index.ts:275
// registers it at, and the sub-app grafted onto the parent under /admin. The
// full production URL therefore has to survive the rebasing for `:id` to be
// read correctly, which a flat app would not test.
function makeApp(): Hono<AppEnv> {
  const mirror = new Hono<AppEnv>();
  mirror.use("*", requireAdminAuth);
  mirror.post("/article/:id/toggle-featured/", adminArticleToggleFeatured);

  const app = new Hono<AppEnv>();
  app.route("/admin", mirror);
  // Named rather than left to become an unhandled rejection, so a regression
  // reads as "expected 200, got 500: ..." instead of a vitest crash.
  app.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));
  return app;
}

// THE PRODUCTION ROUTER ITSELF, not a re-creation of it. makeApp() above is a
// hand-built mirror of routes/admin/index.ts:85,275, and a mirror is by
// construction incapable of failing when the thing it mirrors changes: every
// assertion above would stay green if index.ts renamed the path, renamed the
// `:id` param, dropped `use("*", requireAdminAuth)`, or registered the handler
// for GET as well as POST. Mutation-tested, and all four of those survived the
// mirror -- see the `production route registration` block at the end, which is
// what actually kills them. Mounted at "/admin" exactly as
// workers/site/src/index.ts:637 mounts it; seven sibling suites
// (query.test.ts, proxy.test.ts, jobs.test.ts and friends) import `adminApp`
// the same way, so this is the house pattern rather than a new one.
function makeRealApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.route("/admin", adminApp);
  app.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));
  return app;
}

async function send(path: string, options: RequestOptions = {}): Promise<Response> {
  const {
    method = "POST",
    csrfField = CSRF_RAW,
    csrfCookieRaw = CSRF_RAW,
    csrfCookieSignature,
    sessionId = SESSION_ID,
    origin = ORIGIN,
    secFetchSite = "same-origin",
    hx = false,
    secret = CSRF_SECRET,
    router = "mirror",
    csrfAsFile = false,
  } = options;

  const cookies: string[] = [];
  if (sessionId !== null) cookies.push(`__Host-gfsession=${sessionId}`);
  if (csrfCookieRaw !== null) {
    const signature = csrfCookieSignature ?? (await hmacSha256Hex(CSRF_SECRET, csrfCookieRaw));
    cookies.push(`__Host-csrf=${csrfCookieRaw}.${signature}`);
  }

  // No Content-Type for the multipart case: Request derives it from the
  // FormData, boundary and all. Setting it by hand would produce a body the
  // parser cannot split.
  const headers: Record<string, string> = csrfAsFile ? {} : { "Content-Type": "application/x-www-form-urlencoded" };
  if (cookies.length) headers.Cookie = cookies.join("; ");
  if (origin !== null) headers.Origin = origin;
  if (secFetchSite !== null) headers["Sec-Fetch-Site"] = secFetchSite;
  if (hx) headers["HX-Request"] = typeof hx === "string" ? hx : "true";

  let body: BodyInit = csrfField === null ? "" : new URLSearchParams({ csrf_token: csrfField }).toString();
  if (csrfAsFile) {
    const form = new FormData();
    form.set("csrf_token", new File([csrfField ?? ""], "token.txt", { type: "text/plain" }));
    body = form;
  }

  const env = {
    DB: { withSession: () => d1Session(db) },
    SESSIONS: {
      get: async (key: string) => sessions.get(key) ?? null,
      put: async (key: string, value: string) => void sessions.set(key, value),
    },
    CSRF_SECRET: secret ?? undefined,
  } as unknown as AppEnv["Bindings"];

  const app = router === "real" ? makeRealApp() : makeApp();
  return app.fetch(new Request(`${ORIGIN}${path}`, { method, headers, ...(method === "POST" ? { body } : {}) }), env, execCtx);
}

const TOGGLE_1 = "/admin/article/1/toggle-featured/";

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

describe("adminArticleToggleFeatured -- the write", () => {
  // #34's lesson in one assertion: the row, read back, not the response.
  it("flips an unfeatured article on and stores it", async () => {
    seedArticle(1, 0);
    const res = await send(TOGGLE_1, { hx: true });

    expect(res.status).toBe(200);
    expect(featuredOf(1)).toBe(1);
  });

  it("flips a featured article off and stores it", async () => {
    seedArticle(1, 1);
    const res = await send(TOGGLE_1, { hx: true });

    expect(res.status).toBe(200);
    expect(featuredOf(1)).toBe(0);
  });

  // views.py:3402 is `article.featured = not article.featured` -- a FLIP.
  // `SET featured = 1` reads correctly in a screenshot of any unfeatured
  // article and makes the button impossible to un-press; three presses is the
  // shortest sequence that tells the two apart at the route level.
  it("keeps flipping, so the button un-presses", async () => {
    seedArticle(1, 0);
    await send(TOGGLE_1, { hx: true });
    expect(featuredOf(1)).toBe(1);
    await send(TOGGLE_1, { hx: true });
    expect(featuredOf(1)).toBe(0);
    await send(TOGGLE_1, { hx: true });
    expect(featuredOf(1)).toBe(1);
  });

  // Seeded so a missing WHERE clause is VISIBLE. The dashboard renders 20-odd
  // article rows (admin/index.njk:115) and an UPDATE without the predicate
  // would feature or unfeature every article on the site from one press --
  // which the home page's `WHERE a.featured = 1` would then happily render.
  // The neighbours start on both 0 and 1 so a "set them all to 1" mutant and a
  // "flip them all" mutant both fail.
  it("touches only the article named in the path", async () => {
    seedArticle(1, 0);
    seedArticle(2, 0);
    seedArticle(3, 1);

    await send(TOGGLE_1, { hx: true });

    expect(allFeatured()).toEqual([1, 0, 1]);
  });

  // The non-htmx branch. It matters that the WRITE is not conditional on the
  // HX-Request header: a handler that only saved when it had a fragment to
  // render would redirect a JavaScript-less admin back to a dashboard showing
  // the old star, with nothing to say it had not worked.
  it("saves on a non-htmx submission too, and redirects to the dashboard", async () => {
    seedArticle(1, 0);
    const res = await send(TOGGLE_1);

    expect(featuredOf(1)).toBe(1);
    // Django's `redirect(reverse("gfadmin:index"))` -- a 302 to /admin/.
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/");
  });

  // Django tests `request.headers.get('HX-Request')` for truthiness, not for
  // the string "true", and so does this port. htmx only ever sends "true", so
  // the two agree in practice; pinned because "tighten this to === 'true'"
  // looks like a harmless cleanup and would break any caller sending anything
  // else by turning its swap into a full-page redirect.
  it("returns the fragment for any non-empty HX-Request value, as Django does", async () => {
    seedArticle(1, 0);
    const res = await send(TOGGLE_1, { hx: "false" });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<button");
    expect(featuredOf(1)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The htmx fragment
// ---------------------------------------------------------------------------

describe("adminArticleToggleFeatured -- the swapped-in button", () => {
  // The star and the colour are the entire feedback the admin gets. Asserted
  // against Django's own strings (views.py:3407-3408, 3411-3414): "★" with
  // "is-warning is-light" when featured, "☆" with a bare "is-light" when not.
  // admin/index.njk:128-129 renders the same pair as &#9733;/&#9734;, which is
  // the same two characters -- so a swapped button and a freshly rendered one
  // look identical, which is what makes the swap invisible to the admin.
  it("comes back featured-looking after a flip on", async () => {
    seedArticle(1, 0);
    const html = await (await send(TOGGLE_1, { hx: true })).text();

    expect(html).toContain('class="button is-small is-warning is-light"');
    expect(html).toContain("★");
    expect(html).not.toContain("☆");
  });

  it("comes back unfeatured-looking after a flip off", async () => {
    seedArticle(1, 1);
    const html = await (await send(TOGGLE_1, { hx: true })).text();

    expect(html).toContain('class="button is-small is-light"');
    expect(html).not.toContain("is-warning");
    expect(html).toContain("☆");
    expect(html).not.toContain("★");
  });

  // hx-swap="outerHTML" replaces the button element itself, so the fragment
  // has to be a self-contained button carrying its own hx-post -- Django's
  // comment for the same lines. A fragment that lost hx-post would swap in a
  // button that does nothing at all on the next click.
  it("is a single self-posting button aimed back at the same article", async () => {
    seedArticle(1, 0);
    const res = await send(TOGGLE_1, { hx: true });
    const html = await res.text();

    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(html).toMatch(/^<button type="submit" [\s\S]*<\/button>$/);
    expect(html).toContain('hx-post="/admin/article/1/toggle-featured/"');
    expect(html).toContain('hx-swap="outerHTML"');
  });

  // THE ROUND TRIP, and the reason it is a request rather than a string
  // assertion. Django's fragment carries no csrf_token because Django's CSRF
  // middleware is switched off in production; this port validates for real, so
  // its fragment carries `hx-vals`. Drop that to "match Django" and the first
  // press works, the second 403s, and htmx's default error handling leaves the
  // ★ on screen with nothing swapped -- an admin who then navigates away is
  // certain the article is featured and it is not. Nothing short of pressing
  // the returned button catches that.
  it("can be pressed again: the fragment carries everything the next POST needs", async () => {
    seedArticle(1, 0);
    const first = await (await send(TOGGLE_1, { hx: true })).text();
    expect(featuredOf(1)).toBe(1);

    const hxPost = /hx-post="([^"]+)"/.exec(first)?.[1];
    const hxVals = /hx-vals='([^']+)'/.exec(first)?.[1];
    expect(hxPost).toBeDefined();
    expect(hxVals).toBeDefined();
    const token = (JSON.parse(hxVals!) as { csrf_token: string }).csrf_token;

    // Exactly what htmx would send: the path from hx-post, the values from
    // hx-vals, and no hidden form field of its own (the surrounding <form> is
    // not part of an outerHTML swap of the button).
    const second = await send(hxPost!, { hx: true, csrfField: token });

    expect(second.status).toBe(200);
    expect(featuredOf(1)).toBe(0);
    expect(await second.text()).toContain("☆");
  });

  // The token is interpolated into the fragment with no escaping, so this pins
  // what actually comes back. It is NOT reachable by an attacker: verifyCsrf
  // has already required the submitted field to equal the raw half of a cookie
  // whose HMAC verifies under CSRF_SECRET, so producing a token with a quote
  // in it means already holding the secret (this test holds it). Pinned so
  // that adding escaping -- or moving to a fragment built by the template
  // engine, which autoescapes -- is a deliberate change with a test to update,
  // and so nobody later relaxes verifyCsrf's exact-match on the belief that
  // the token is inert on the way out.
  it("echoes the submitted token into hx-vals verbatim, unescaped", async () => {
    seedArticle(1, 0);
    const raw = 'a"b<c>&d';
    const html = await (await send(TOGGLE_1, { hx: true, csrfField: raw, csrfCookieRaw: raw })).text();

    expect(html).toContain(`hx-vals='{"csrf_token": "${raw}"}'`);
  });

  // The SINGLE QUOTE specifically, which the case above does not cover and
  // which is the only character that actually breaks this attribute: hx-vals
  // is delimited by ' (articles.ts:27), so a ' in the token closes it early
  // and everything after it parses as further attributes on the button. The
  // test above uses " < > &, none of which escape a single-quoted attribute.
  //
  // Same reachability argument as above -- verifyCsrf has already required
  // this exact string to equal the raw half of a correctly signed cookie, so
  // reaching here means holding CSRF_SECRET. Pinned as the honest statement of
  // what the handler does with a token it did not generate, so that the
  // Number()-and-HMAC bound in front of it is understood to be load-bearing
  // rather than incidental.
  it("does not escape a single quote either, so hx-vals is only safe because the token is", async () => {
    seedArticle(1, 0);
    const raw = "a'b";
    const html = await (await send(TOGGLE_1, { hx: true, csrfField: raw, csrfCookieRaw: raw })).text();

    expect(html).toContain(`hx-vals='{"csrf_token": "a'b"}'`);
    expect(featuredOf(1)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Articles that are not there, and ids that are not ids
// ---------------------------------------------------------------------------

describe("adminArticleToggleFeatured -- 404s", () => {
  // Django's get_object_or_404. adminLists.ts's RETURNING clause is what lets
  // the handler tell "flipped to off" (false) from "no such article" (null) --
  // collapse the two and an id that does not exist renders a plausible ☆
  // button instead of a 404.
  it("404s an unknown article and changes nothing", async () => {
    seedArticle(1, 0);
    seedArticle(2, 1);

    const res = await send("/admin/article/999/toggle-featured/", { hx: true });

    expect(res.status).toBe(404);
    expect(allFeatured()).toEqual([0, 1]);
  });

  // The user-visible outcome for an id that is not a whole number: a 404, and
  // in particular NOT a 500 -- the handler must not hand a NaN or a float down
  // to the driver and let an exception become the admin's error page.
  //
  // Stated plainly, because it was mutation-tested and the result was
  // negative: this test does NOT pin `Number.isInteger` itself. Replacing it
  // with `!Number.isNaN`, or deleting the guard outright, still passes here,
  // because SQLite binds NaN / 1.5 / Infinity happily and matches no row, so
  // the handler reaches the same 404 through `featured === null` instead. It
  // is kept for the outcome, not for the mechanism; the ordering assertion
  // below is the one that actually proves the guard runs.
  it("404s ids that are not whole numbers, with no 500", async () => {
    for (const spelling of ["abc", "1.5", "Infinity", "-"]) {
      db.exec("DELETE FROM foodbankarticle");
      seedArticle(1, 0);

      const res = await send(`/admin/article/${spelling}/toggle-featured/`, { hx: true });

      expect(res.status, `id spelling ${spelling}`).toBe(404);
      expect(featuredOf(1), `id spelling ${spelling}`).toBe(0);
    }
  });

  // THE ORDER OF THE TWO GUARDS, and the only route-visible trace the id check
  // leaves. articles.ts:13-18 parses the id and 404s BEFORE reading the body or
  // checking CSRF, so a malformed id wins over a missing token; delete the
  // guard and this same request comes back 403 instead. That makes this the
  // assertion that fails if the guard goes, which the plain 404 cases above
  // (documented as such) do not.
  it("404s a malformed id ahead of the CSRF check, not 403", async () => {
    seedArticle(1, 0);
    const res = await send("/admin/article/abc/toggle-featured/", { hx: true, csrfField: "wrong", csrfCookieRaw: null });

    expect(res.status).toBe(404);
    expect(featuredOf(1)).toBe(0);
  });

  // SUSPECT, pinned as-is rather than fixed. Django's URL is
  // `article/<int:article_id>/toggle-featured/` (gfadmin/urls/core.py:24) and
  // IntConverter's regex is [0-9]+, so every spelling below is a 404 in Django
  // -- the URL simply does not match. Here Hono's `:id` matches any segment and
  // Number() is JavaScript's, which accepts a decimal point, an exponent, a
  // leading plus and surrounding whitespace, all of which Number.isInteger
  // then waves through. The effect is a set of alternative URLs for the same
  // toggle. Harmless in itself (the action is idempotent-ish and behind admin
  // auth and CSRF), but it is the same laxness that elsewhere turns "/foo/1e3/"
  // into a write against row 1000, so it is recorded rather than assumed
  // intentional.
  it("accepts id spellings Django's <int:> converter would have 404ed", async () => {
    seedArticle(1, 0);

    for (const spelling of ["1.0", "1e0", "+1", "%201%20", "01"]) {
      db.prepare("UPDATE foodbankarticle SET featured = 0 WHERE id = 1").run();

      const res = await send(`/admin/article/${spelling}/toggle-featured/`, { hx: true });

      expect(res.status, `id spelling ${spelling}`).toBe(200);
      expect(featuredOf(1), `id spelling ${spelling}`).toBe(1);
      // And the fragment normalises: articles.ts builds hx-post from the
      // PARSED number, not from the raw path segment, so whatever spelling got
      // the admin here, the button swapped in points at the canonical URL.
      // Echoing `c.req.param("id")` instead would put an unescaped,
      // caller-supplied string inside an HTML attribute -- currently bounded
      // by the Number() guard, but bounded by nothing else.
      expect(await res.text(), `id spelling ${spelling}`).toContain('hx-post="/admin/article/1/toggle-featured/"');
    }
  });
});

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

describe("adminArticleToggleFeatured -- CSRF", () => {
  // Every case here asserts the STORED VALUE as well as the status: a 403 that
  // had already run the UPDATE would pass a status-only test while a
  // cross-site page quietly unfeatured the home page's articles.
  it("refuses a POST with no csrf_token field", async () => {
    seedArticle(1, 0);
    const res = await send(TOGGLE_1, { hx: true, csrfField: null });

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden");
    expect(featuredOf(1)).toBe(0);
  });

  it("refuses a POST whose token does not match the cookie", async () => {
    seedArticle(1, 0);
    const res = await send(TOGGLE_1, { hx: true, csrfField: "c".repeat(64) });

    expect(res.status).toBe(403);
    expect(featuredOf(1)).toBe(0);
  });

  it("refuses a POST with no __Host-csrf cookie at all", async () => {
    seedArticle(1, 0);
    const res = await send(TOGGLE_1, { hx: true, csrfCookieRaw: null });

    expect(res.status).toBe(403);
    expect(featuredOf(1)).toBe(0);
  });

  // The "signed" half of the signed double-submit. A sibling subdomain can set
  // a __Host-... -shaped cookie's value in some browsers' threat models; what
  // it cannot do is sign one. Forging the signature must not be enough even
  // when the form field agrees with the cookie, which it does here.
  it("refuses a cookie whose signature does not verify", async () => {
    seedArticle(1, 0);
    const res = await send(TOGGLE_1, { hx: true, csrfCookieSignature: "0".repeat(64) });

    expect(res.status).toBe(403);
    expect(featuredOf(1)).toBe(0);
  });

  it("refuses a cross-site request even with a matching token", async () => {
    seedArticle(1, 0);
    const res = await send(TOGGLE_1, { hx: true, secFetchSite: "cross-site" });

    expect(res.status).toBe(403);
    expect(featuredOf(1)).toBe(0);
  });

  it("refuses a request whose Origin is another site", async () => {
    seedArticle(1, 0);
    const res = await send(TOGGLE_1, { hx: true, origin: "https://evil.invalid", secFetchSite: null });

    expect(res.status).toBe(403);
    expect(featuredOf(1)).toBe(0);
  });

  // Older browsers send neither header, and verifyCsrf only checks each when
  // present. The token pair still has to carry the request, so this is the
  // case that proves the signed double-submit -- not the Origin check -- is
  // what is actually holding the door.
  it("allows a request with neither Origin nor Sec-Fetch-Site, on the token alone", async () => {
    seedArticle(1, 0);
    const res = await send(TOGGLE_1, { hx: true, origin: null, secFetchSite: null });

    expect(res.status).toBe(200);
    expect(featuredOf(1)).toBe(1);
  });

  // The `typeof body.csrf_token === "string"` guard (articles.ts:17). A
  // multipart POST whose csrf_token is a FILE part is the only way to make
  // parseBody() return a non-string for that key, and the file's CONTENTS here
  // are the valid token -- so anything that reached for the value without
  // checking its type, or stringified it, is refused all the same.
  //
  // Stated plainly, as the Number.isInteger case above is: this does NOT pin
  // the typeof guard itself. Mutation-tested and the result was negative --
  // replacing it with `String(body.csrf_token ?? "")` still passes, because a
  // File stringifies to "[object File]", which then fails verifyCsrf's
  // length-checked comparison against the cookie and 403s anyway. The guard
  // and the coercion are indistinguishable from outside the handler; the test
  // is here for the outcome (a crafted multipart body cannot get past CSRF and
  // must not write), not for the mechanism.
  it("refuses a multipart POST whose csrf_token is a file rather than a field", async () => {
    seedArticle(1, 0);
    const res = await send(TOGGLE_1, { hx: true, csrfAsFile: true });

    expect(res.status).toBe(403);
    expect(featuredOf(1)).toBe(0);
  });

  // lib/csrf.ts fails closed on a missing secret, deliberately, so that a
  // misconfigured deployment cannot be mistaken for a working one. Pinned at
  // the route so nobody "fixes" the resulting 403s by making an absent secret
  // mean "skip the check".
  it("refuses everything when CSRF_SECRET is unset", async () => {
    seedArticle(1, 0);
    const res = await send(TOGGLE_1, { hx: true, secret: null });

    expect(res.status).toBe(403);
    expect(featuredOf(1)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Auth, and the method
// ---------------------------------------------------------------------------

describe("adminArticleToggleFeatured -- the gate in front of it", () => {
  // requireAdminAuth is the real middleware, mounted the way
  // routes/admin/index.ts:85 mounts it. The CSRF token here is perfectly
  // valid, so the only thing that can stop the write is the auth gate -- which
  // makes this a test of the gate rather than of the token.
  it("never reaches the handler without a session", async () => {
    seedArticle(1, 0);
    const res = await send(TOGGLE_1, { hx: true, sessionId: null });

    expect(res.status).toBe(302);
    // The full /admin/... path has to survive the sub-app's rebasing, or the
    // admin is sent to the wrong page after signing in.
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Farticle%2F1%2Ftoggle-featured%2F");
    expect(featuredOf(1)).toBe(0);
  });

  // A cookie is not a session. An expired or revoked session id is absent from
  // KV, and getAdminSession returns null for it -- same outcome as no cookie,
  // asserted separately because "we found a cookie" is exactly the shortcut a
  // future refactor might take.
  it("never reaches the handler for a session id KV does not know", async () => {
    seedArticle(1, 0);
    const res = await send(TOGGLE_1, { hx: true, sessionId: "not-a-real-session" });

    expect(res.status).toBe(302);
    expect(featuredOf(1)).toBe(0);
  });

  // GET MUST NOT MUTATE. The route is registered POST-only (index.ts:275),
  // mirroring Django's @require_POST on the view -- so a link, a prefetch or a
  // crawler following /admin/article/1/toggle-featured/ cannot flip the star.
  //
  // Pinned divergence: Django's decorator answers 405 Method Not Allowed
  // (the URL matches, the method does not), whereas Hono's router finds no
  // route and answers 404. Same protection, different status; asserted here so
  // the difference is on the record rather than discovered from a log.
  //
  // NOTE THIS IS THE MIRROR. The handler itself contains no method check at
  // all -- `@require_POST` has no ported equivalent inside articles.ts, so
  // registration is the ONLY thing standing between a GET and the UPDATE.
  // That makes this assertion worthless against the real risk unless it is
  // also made against the real router, which the last block does.
  it("does not answer GET at all, and writes nothing", async () => {
    seedArticle(1, 0);
    const res = await send(TOGGLE_1, { method: "GET", hx: true });

    expect(res.status).toBe(404);
    expect(featuredOf(1)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The production route registration
// ---------------------------------------------------------------------------

// Everything above this line goes through makeApp(), a hand-written copy of
// two lines of routes/admin/index.ts. These four go through `adminApp` itself.
//
// The distinction is not pedantry -- it was measured. Each of the following
// edits to index.ts was applied to a scratch copy and the suite re-run, and
// every one of them SURVIVED the mirror while breaking production:
//
//   * adding `adminApp.get("/article/:id/toggle-featured/", ...)` alongside
//     the POST -- a GET now flips the star, so Googlebot, a link prefetch or
//     the browser's own back/forward cache silently unfeatures articles. This
//     is the "let a GET fall through into the POST branch" mutant, and it is
//     invisible to a test that registers its own POST-only route.
//   * renaming the path (`/articles/:id/toggle-featured/`) -- every button on
//     the dashboard 404s, because articles.ts hardcodes the old path into the
//     fragment it swaps in.
//   * renaming the param to `:articleId` -- `c.req.param("id")` goes
//     undefined, Number(undefined) is NaN, and EVERY press 404s.
//   * deleting `adminApp.use("*", requireAdminAuth)` -- the entire admin area
//     opens to the internet.
//
// Kept to four cases on purpose: this block exists to pin the wiring, not to
// re-run the handler's behaviour through a second router.
describe("adminArticleToggleFeatured -- the production route registration", () => {
  // Path, method and param name, all three at once: if any of them drifts, the
  // row does not change. Reads the row back rather than trusting the 200,
  // because a 200 from some OTHER route that happened to match would be just
  // as green and just as wrong.
  it("is reachable at the path the dashboard's button posts to, and writes", async () => {
    seedArticle(1, 0);
    const res = await send(TOGGLE_1, { hx: true, router: "real" });

    expect(res.status).toBe(200);
    expect(featuredOf(1)).toBe(1);
    // The same path came back inside the fragment, so the button that gets
    // swapped in points at a route that really exists.
    expect(await res.text()).toContain(`hx-post="${TOGGLE_1}"`);
  });

  // THE ONE THAT MATTERS MOST. articles.ts has no @require_POST equivalent, so
  // a GET reaching the handler would run the UPDATE and redirect, and the only
  // reason it cannot is that index.ts:275 registers `post` and nothing else.
  it("answers no GET on the real router, so a crawler cannot flip the star", async () => {
    seedArticle(1, 1);
    const res = await send(TOGGLE_1, { method: "GET", hx: true, router: "real" });

    expect(res.status).toBe(404);
    expect(featuredOf(1)).toBe(1);
  });

  // The real `use("*", requireAdminAuth)`, not a re-declared one. The CSRF
  // token here is entirely valid, so the gate is the only thing that can stop
  // the write -- and the row is read back because a 302 that had already run
  // the UPDATE is exactly the failure this is here to catch.
  it("puts the real admin gate in front of it", async () => {
    seedArticle(1, 0);
    const res = await send(TOGGLE_1, { hx: true, sessionId: null, router: "real" });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Farticle%2F1%2Ftoggle-featured%2F");
    expect(featuredOf(1)).toBe(0);
  });

  // And CSRF survives the trip through the real mount. Cheap, and it rules out
  // "the mirror validated but production has a middleware that swallows it".
  it("still refuses a bad token on the real router", async () => {
    seedArticle(1, 0);
    const res = await send(TOGGLE_1, { hx: true, csrfField: "c".repeat(64), router: "real" });

    expect(res.status).toBe(403);
    expect(featuredOf(1)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The arithmetic behind the flip
// ---------------------------------------------------------------------------

// packages/db/src/adminLists.ts:330 implements Django's `not article.featured`
// as `featured = 1 - featured`. Those agree for 0 and 1 and nothing else, and
// the column is a bare `INTEGER NOT NULL` with no CHECK (0003:51) -- the 0/1
// invariant comes from the data's Django-boolean origins and from
// insertArticleIfNew binding a literal 0 (articles.ts:67), not from the
// schema. This pins what the route does if that invariant ever breaks, because
// the outcome is not a crash: 2 becomes -1, the button reports "not featured",
// and the next press produces 2 again. The article then oscillates between two
// values that `WHERE featured = 1` never matches, so it can never be featured
// and never be seen to fail. Django's `not` would have normalised it to False
// on the first press. Asserted, not fixed -- fixing it is a change to another
// package's SQL.
describe("adminArticleToggleFeatured -- a featured value that is not 0 or 1", () => {
  it("subtracts rather than negating, and cannot recover", async () => {
    seedArticle(1, 2);

    const first = await send(TOGGLE_1, { hx: true });
    expect(featuredOf(1)).toBe(-1);
    expect(await first.text()).toContain("☆");

    const second = await send(TOGGLE_1, { hx: true });
    expect(featuredOf(1)).toBe(2);
    expect(await second.text()).toContain("☆");
  });
});
