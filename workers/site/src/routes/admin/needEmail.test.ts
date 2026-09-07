import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../../types";
import { adminApp } from "./index";
import { adminNeedEmail } from "./needEmail";

// gfadmin/views.py:2023-2038 need_email -- GET /admin/need/<id>/email/, the
// two links admin/need.njk:147-148 puts under "Notification Preview".
//
// THIS PAGE IS AN ORACLE, WHICH IS WHY IT IS WORTH TESTING HARD. It writes
// nothing, so it cannot lose an admin's typing the way issue #12 did; what it
// can do is worse in its own way, which is to show the maintainer a body that
// is not the body 5,855 people will receive. Every decision to press Notify is
// taken on the strength of what this route renders. A preview that quietly
// drops the news block, shows another food bank's articles, escapes an
// ampersand the real mail leaves literal, or renders the HTML half when the
// admin asked for the text one is a wrong answer that looks exactly like a
// right one -- no error, no log line, 200 either way. That is issue #34's
// class (a value threaded through the code and then used by nothing) pointed
// at a read path.
//
// REAL ROUTER, REAL AUTH, REAL TEMPLATES, REAL SQLITE. The app under test is
// `adminApp` itself mounted at /admin, exactly as workers/site/src/index.ts:637
// mounts it, so these tests go through the real route registration (GET only --
// see the method tests) and the real requireAdminAuth. Only two bindings are
// faked: D1 is node:sqlite behind the D1 Sessions surface, and SESSIONS is a
// Map. Nothing else is touched, because this page sends no mail, enqueues
// nothing and calls no external API -- so nothing here is mocked that could
// hide a divergence between the preview and the send.
//
// ASSERTIONS ARE ON THE BYTES SERVED, not on the context handed to render().
// packages/db/src/needEmailContext.test.ts already pins the context builder in
// detail against a real database. What it cannot see is the half of the email
// that lives in the templates: the `{% if articles.length %}` guard,
// `{% autoescape false %}` on the text half, `|safe` on eight utm querystrings,
// and -- the reason this matters -- the article date, which
// need_notification.njk formats a SECOND time and thereby renders as nothing at
// all (see "the article date is blank" below). No context-level assertion can
// see any of that. The text body is pinned WHOLE, once, because it is a body
// already sitting in delivered inboxes and a whitespace change to it is a
// change to the product.
//
// WHAT WAS RUN RATHER THAN REASONED ABOUT. Django 5.2.6 was executed under the
// original site's own install for the two parity claims that are not obvious:
// QueryDict.get() returns the LAST repeated value (the port takes the first),
// and HttpResponse(content_type="text/plain") sends that string bare, with no
// charset (the port appends one). Both are pinned below as the port behaves,
// with the Django result in the comment.
//
// MUTATION-TESTED where a mutant can be injected without editing a source file:
// every input this handler has beyond the query string arrives through
// @givefood/db, so getNeedByUuid and buildNeedEmailContext were temporarily
// mocked from this file, the suite re-run, and the mock removed. getNeedByUuid
// ignoring its uuid (returning the first row) fails 4 tests; buildNeedEmailContext
// returning a context for a food-bank-less need fails 3. The handler's own two
// decisions -- the `=== "html"` format test and the Content-Type that follows
// it -- are asserted directly on the response of six different query strings,
// so every loosening of that comparison (includes, startsWith, toLowerCase,
// `!== undefined`) is caught by one of them.

// Reduced from migrations/0001_core.sql (foodbank, foodbankchange),
// 0003_homepage_data.sql (foodbankarticle) and 0019_drop_foodbank_cache.sql
// (which dropped two columns and created the view) -- the columns these three
// statements name and nothing else, following the convention of the other
// workers/site suites (foodbankLocation.test.ts, donationPoint.test.ts,
// crawlSets.test.ts) rather than packages/db's shared migration loader.
//
// 0019 IS THE REASON foodbank_name IS ABSENT from both child tables here. It
// dropped foodbankchange.foodbank_name and foodbankarticle.foodbank_name (the
// App Engine-era copies of the parent's fields) and put `f.name AS
// foodbank_name` in the view instead. Transcribing them back in -- which is
// what typing this fixture out from the interfaces rather than from the
// migrations produces -- does not fail loudly: node:sqlite keeps BOTH columns
// and renames the second to "foodbank_name:1", so the row silently carries the
// stale copy and the utm_campaign in every link of the HTML half changes. This
// file made that mistake once; the schema is written down here as the
// migrations leave it precisely so the next reader does not have to rediscover
// it. See the last describe block for what the column's removal actually did
// to the campaign name.
const SCHEMA = `
CREATE TABLE foodbank (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL, alt_name TEXT, slug TEXT NOT NULL,
  no_donation_points INTEGER
);
CREATE TABLE foodbankchange (
  id INTEGER PRIMARY KEY,
  need_id TEXT NOT NULL,
  foodbank_id INTEGER,
  distill_id TEXT, name TEXT, uri TEXT,
  change_text TEXT NOT NULL,
  change_text_original TEXT,
  excess_change_text TEXT, excess_change_text_original TEXT,
  published INTEGER NOT NULL DEFAULT 0,
  nonpertinent INTEGER,
  is_categorised INTEGER,
  notified TEXT, input_method TEXT NOT NULL,
  created TEXT NOT NULL, modified TEXT NOT NULL
);
CREATE UNIQUE INDEX need_need_id_uniq ON foodbankchange(need_id);
CREATE TABLE foodbankarticle (
  id INTEGER PRIMARY KEY,
  foodbank_id INTEGER,
  published_date TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
  featured INTEGER NOT NULL
);
CREATE VIEW foodbankchange_full AS
  SELECT c.*, f.name AS foodbank_name, f.slug AS foodbank_slug
    FROM foodbankchange c
    LEFT JOIN foodbank f ON f.id = c.foodbank_id;
`;

type Bindable = null | number | bigint | string | Uint8Array;

// The D1DatabaseSession surface packages/db uses, over node:sqlite -- the same
// adapter donationPoint.test.ts and crawlSets.test.ts use, with crawlSets'
// statement log. The log is how "a preview never writes" is asserted as a claim
// about the SQL ISSUED rather than only about the rows left behind: an UPDATE
// that happened to match nothing in this fixture would leave the snapshot
// identical and still be a mutation of production data. It is also how "the
// preview asks for exactly three things" is asserted at all -- a fourth query
// (a subscriber, a translation) is invisible in the rendered body until the
// day it changes what the body says.
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

// Ids deliberately not in insertion, name or slug order, so a query that
// returned "the first row" could not accidentally look right.
const SALISBURY = 22;
const WEST_NORFOLK = 88;

// The stored spelling: dashless (0001_core.sql:111), which is what
// admin/need.njk builds its two preview links from. The dashed form is what
// every URL Django ever emitted carries, and both are exercised below.
const NEED_DASHLESS = "0b9ab6b8c9f24bd6a5b7d0c1e2f34567";
const NEED_DASHED = "0b9ab6b8-c9f2-4bd6-a5b7-d0c1e2f34567";

// A second, unrelated need, belonging to a second food bank -- the row that
// must be EXCLUDED when the first one is asked for, and vice versa. Its first
// byte sorts after NEED_DASHLESS's and its id is higher, so "the first row" and
// "the newest row" both name the wrong one deliberately.
const OTHER_NEED = "7c4d3e2f1a0b49c8bd6e5f4a3b2c1d0e";

// Django's timestamp spelling -- "YYYY-MM-DD HH:MM:SS.ffffff", a space and six
// fractional digits, never a "T" and never a "Z". These columns are TEXT and
// every comparison over them is bytewise, which is why migration 0022 had to go
// back and rewrite the ISO-spelled rows. Seeding ISO here would be testing a
// database this app does not have.
const CREATED = "2026-09-05 19:28:08.853000";

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let sessionStore: Map<string, string>;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  // The shape lib/adminAuth.ts's getAdminSession reads back out of KV.
  // expiresAt a full TTL ahead so the sliding-refresh branch does not fire and
  // put() noise into these tests.
  sessionStore = new Map([
    [
      `admin-session:${SESSION_ID}`,
      JSON.stringify({ email: ADMIN_EMAIL, name: "Some One", givenName: "Some", picture: "", expiresAt: Date.now() + 12 * 60 * 60 * 1000 }),
    ],
  ]);
});

function buildEnv(log: string[]): AppEnv["Bindings"] {
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
    D1_DATABASE_NAME: "givefood-test",
  } as unknown as AppEnv["Bindings"];
}

// A real Hono app with adminApp mounted at the production prefix. onError is
// caught and labelled rather than left to become an unhandled rejection, so a
// regression reads as "expected 200, got 500: <message>" instead of a crash --
// which matters more here than usual, since Django's own version of this view
// 500s on the food-bank-less need the port answers with a 400.
function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("requestStartTime", performance.now());
    await next();
  });
  app.route("/admin", adminApp);
  app.onError((err, c) => c.text(`five hundred: ${(err as Error).message}`, 500));
  return app;
}

interface Fetched {
  res: Response;
  body: string;
  /** Every SQL statement the request prepared, in order. Empty means the handler never ran. */
  sql: string[];
}

async function request(path: string, opts: { signedIn?: boolean; method?: string } = {}): Promise<Fetched> {
  const sql: string[] = [];
  const headers: Record<string, string> = {};
  if (opts.signedIn !== false) headers.Cookie = `__Host-gfsession=${SESSION_ID}`;
  const res = await buildApp().fetch(new Request(`${ORIGIN}${path}`, { headers, method: opts.method ?? "GET" }), buildEnv(sql), execCtx);
  // Read the body once, here: several assertions want it and a Response body
  // can only be consumed once.
  const body = res.status === 302 ? "" : await res.text();
  return { res, body, sql };
}

/** The URL admin/need.njk:147-148 builds, with the format param it puts on it. */
function previewUrl(needId: string = NEED_DASHLESS, format?: string): string {
  return `/admin/need/${needId}/email/${format === undefined ? "" : `?format=${format}`}`;
}

function seedFoodbank(fb: { id: number; name: string; slug: string; altName?: string | null; noDonationPoints?: number | null }): void {
  db.prepare("INSERT INTO foodbank (id, name, alt_name, slug, no_donation_points) VALUES (?, ?, ?, ?, ?)").run(
    fb.id,
    fb.name,
    fb.altName ?? null,
    fb.slug,
    fb.noDonationPoints === undefined ? 3 : fb.noDonationPoints,
  );
}

// A published, scraped need -- the ordinary case that produces an email. There
// is no foodbank_name to seed: 0019 dropped it, and the name the context
// builder reads now arrives from the view's join.
function seedNeed(
  need: {
    id?: number;
    needId?: string;
    foodbankId?: number | null;
    changeText?: string;
    excessChangeText?: string | null;
    published?: number;
    created?: string;
  } = {},
): void {
  db.prepare(
    "INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, excess_change_text, published, input_method, created, modified) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'scrape', ?, ?)",
  ).run(
    need.id ?? 4211,
    need.needId ?? NEED_DASHLESS,
    need.foodbankId === undefined ? SALISBURY : need.foodbankId,
    need.changeText ?? "Tinned Meat\nUHT Milk\nTinned Fruit",
    need.excessChangeText ?? null,
    need.published ?? 1,
    need.created ?? CREATED,
    CREATED,
  );
}

function seedArticle(article: { id: number; foodbankId: number; publishedDate: string; title: string; url: string }): void {
  db.prepare("INSERT INTO foodbankarticle (id, foodbank_id, published_date, title, url, featured) VALUES (?, ?, ?, ?, ?, 0)").run(
    article.id,
    article.foodbankId,
    article.publishedDate,
    article.title,
    article.url,
  );
}

// Foodbank.articles_month()'s window is measured from Date.now() at request
// time (ARTICLES_MONTH_DAYS = 28), so article fixtures are positioned relative
// to the real clock rather than to a hardcoded date -- a literal would quietly
// fall out of the window as the calendar moved and the news block would start
// passing for the wrong reason. Everything else in this file is a fixed
// timestamp, because nothing else is compared against now.
function daysAgo(days: number): string {
  const at = new Date(Date.now() - days * 86_400_000);
  at.setUTCHours(9, 30, 0, 0);
  return `${at.toISOString().slice(0, 19).replace("T", " ")}.000000`;
}

// The three statements a successful preview issues, in order, and nothing else.
// Asserted as a whole array rather than a count: it is simultaneously the proof
// that the food bank is fetched by id (not scanned for), that the articles
// query is the windowed one, and -- the point Django's view makes by passing
// ONLY {need} (views.py:2035) -- that NO SUBSCRIBER IS READ. A preview that
// borrowed a real subscriber to fill in the last paragraph would be a preview
// of somebody's personal unsubscribe key, and it would look more correct than
// the blank the shipped page shows.
const PREVIEW_STATEMENTS = [
  "SELECT * FROM foodbankchange_full WHERE need_id = ?",
  "SELECT id, slug, name, alt_name, no_donation_points FROM foodbank WHERE id = ?",
  "SELECT id, published_date, title, url FROM foodbankarticle WHERE foodbank_id = ?1 AND substr(published_date, 1, 10) >= ?2 ORDER BY published_date DESC",
];

// ===========================================================================
// The gate
// ===========================================================================

describe("the sign-in gate", () => {
  beforeEach(() => {
    seedFoodbank({ id: SALISBURY, name: "Salisbury", slug: "salisbury" });
    seedNeed();
  });

  // requireAdminAuth (middleware/adminAuth.ts, Django's LoginRequiredAccess) is
  // registered on adminApp with use("*"), so it must run before this handler
  // for every path under /admin/. Asserted through the SQL log as well as the
  // status, because the body of this particular page is the whole of a
  // subscriber email: a redirect that still ran the queries would have built
  // one for a signed-out caller, and the 302 alone cannot tell that apart.
  it("redirects a signed-out caller to sign-in without running a single query", async () => {
    const { res, sql } = await request(previewUrl(), { signedIn: false });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fneed%2F0b9ab6b8c9f24bd6a5b7d0c1e2f34567%2Femail%2F");
    expect(sql).toEqual([]);
  });

  // The gate is before the lookup, not after it, so a signed-out caller cannot
  // use the 404 as an oracle for which need ids exist. Cheap to get backwards
  // and only ever checked once.
  it("redirects a signed-out caller for an unknown need too, rather than 404ing", async () => {
    const { res, sql } = await request(previewUrl("11111111111111111111111111111111"), { signedIn: false });

    expect(res.status).toBe(302);
    expect(sql).toEqual([]);
  });

  // THE OTHER WAY TO BE SIGNED OUT, and the one that actually happens. The
  // tests above send NO cookie, so they stop at getAdminSession's first branch
  // (lib/adminAuth.ts:273's `if (!sessionId) return null`). A maintainer coming
  // back the next morning, or anyone guessing a session id, takes the SECOND
  // one -- line 277's `if (!raw) return null`, the KV record having expired or
  // been deleted by Sign Out -- and nothing here reached it. Mutating that
  // branch to hand back a session ("X4") survived all 57 tests in this file:
  // an expired cookie would have been served a subscriber email body, and the
  // 302 tests above would still have been green because they never get that
  // far. Asserted on the SQL log too, for the same reason they are: a redirect
  // that had already built the email is not a refusal.
  it("redirects a caller whose session cookie has expired out of KV", async () => {
    sessionStore.clear();

    const { res, sql } = await request(previewUrl());

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fneed%2F0b9ab6b8c9f24bd6a5b7d0c1e2f34567%2Femail%2F");
    expect(sql).toEqual([]);
  });

  it("serves a signed-in caller", async () => {
    const { res } = await request(previewUrl());

    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// Method and routing
// ===========================================================================

describe("the method the route accepts", () => {
  beforeEach(() => {
    seedFoodbank({ id: SALISBURY, name: "Salisbury", slug: "salisbury" });
    seedNeed();
  });

  // routes/admin/index.ts:267 registers this path with .get() only. Django
  // restricts nothing (need_email takes any method and reads request.GET), so
  // a POST there renders the same page; here it never reaches the handler.
  // Pinned because the difference is invisible from the admin UI -- the only
  // two links are GETs -- and because "no route" is what makes the absence of
  // CSRF protection on this handler correct rather than an oversight.
  it("does not answer a POST at all, and runs no query when it refuses", async () => {
    const { res, sql } = await request(previewUrl(), { method: "POST" });

    expect(res.status).toBe(404);
    expect(sql).toEqual([]);
  });

  // ...and the refusal is the ROUTE's, not the handler's. Mounted on a POST
  // route of its own, the exported handler serves the email quite happily,
  // which is what the module comment means by "Django does not restrict the
  // method and the view is a pure read". Worth having as a separate claim: if
  // someone ever adds adminApp.post() for this path, nothing in the handler
  // will stop it, and the test above is then the only thing that notices.
  it("is a pure read that would answer a POST if one were ever registered", async () => {
    const sql: string[] = [];
    const app = new Hono<AppEnv>();
    app.post("/probe/:id/email/", adminNeedEmail);

    const res = await app.fetch(new Request(`${ORIGIN}/probe/${NEED_DASHLESS}/email/`, { method: "POST" }), buildEnv(sql), execCtx);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("We've found a new list of items requested by Salisbury Foodbank");
    expect(sql.every((statement) => statement.startsWith("SELECT"))).toBe(true);
  });
});

// ===========================================================================
// Finding the need
// ===========================================================================

describe("finding the need", () => {
  beforeEach(() => {
    seedFoodbank({ id: SALISBURY, name: "Salisbury", slug: "salisbury" });
    seedNeed();
  });

  it("finds the row from the dashless id the admin page links to", async () => {
    expect((await request(previewUrl(NEED_DASHLESS))).res.status).toBe(200);
  });

  // getNeedByUuid runs its input through normalizeUuid, which is what stops the
  // dashed form -- the spelling every Django-era URL carries, and the one a
  // maintainer pasting a need id out of the API or an old email will have --
  // from 404ing on a dashless column.
  it("finds it from the dashed and the upper-case spellings of the same id", async () => {
    expect((await request(previewUrl(NEED_DASHED))).res.status).toBe(200);
    expect((await request(previewUrl(NEED_DASHED.toUpperCase()))).res.status).toBe(200);
  });

  // Django's get_object_or_404(FoodbankChange, need_id=id) -- a 404, not a 500
  // and not an empty email. The body assertion is the one that matters: this
  // route serves a raw email body with no page chrome, so "did it render
  // something" is not answered by the status alone.
  it("404s an unknown need, having asked the database for it", async () => {
    const { res, body, sql } = await request(previewUrl("11111111111111111111111111111111"));

    expect(res.status).toBe(404);
    expect(body).not.toContain("We've found a new list");
    // The lookup ran and stopped there -- no food bank, no articles.
    expect(sql).toEqual([PREVIEW_STATEMENTS[0]]);
  });

  // A truncated id (a copy-paste out of a wrapped email) and a LIKE
  // metacharacter both have to find nothing. The second is the one worth
  // spelling out: normalizeUuid strips dashes and lower-cases but does not
  // touch "%", so if the lookup were ever loosened to a LIKE this URL would
  // return an arbitrary need -- and this route would then email-preview it.
  it("404s a truncated id and a wildcard, rather than matching something", async () => {
    expect((await request(previewUrl(NEED_DASHLESS.slice(0, 8)))).res.status).toBe(404);
    expect((await request(previewUrl("%"))).res.status).toBe(404);
  });

  // THE ROW THAT MUST BE EXCLUDED, which none of the lookups above can supply.
  // Every test before this one proves that an id matching NOTHING finds
  // nothing; this is the other half -- that an id matching SOMETHING finds the
  // right something while a second need sits in the table beside it. The admin
  // queue is never one need long (admin/needs.njk lists every unpublished one,
  // each carrying its own pair of preview links), so which row this page picks
  // is a live question on every visit, and a lookup that had drifted onto the
  // wrong binding -- `WHERE id = ?`, or a `.first()` over a predicate that no
  // longer discriminates -- would hand the maintainer one charity's shopping
  // list under another charity's name at 200, with nothing in the page, the
  // status or the log to say so. She would then press Notify on it.
  //
  // Both halves of the swap are asserted: the wanted need's items and food bank
  // AND the absence of the other's slug, which is what every link in the body
  // is built from and therefore the part a reader would actually act on.
  it("renders the need named in the URL, not the other one sitting in the table", async () => {
    seedFoodbank({ id: WEST_NORFOLK, name: "West Norfolk", slug: "west-norfolk" });
    seedNeed({ id: 4212, needId: OTHER_NEED, foodbankId: WEST_NORFOLK, changeText: "Nappies\nWashing Powder" });

    const { res, body } = await request(previewUrl(OTHER_NEED));

    expect(res.status).toBe(200);
    expect(body).toContain("requested by West Norfolk Foodbank");
    expect(body).toContain("Nappies\nWashing Powder");
    expect(body).toContain("/needs/at/west-norfolk/");
    expect(body).not.toContain("Tinned Meat");
    expect(body).not.toContain("/needs/at/salisbury/");
  });

  // The workflow this page exists for. A need is unpublished exactly while it
  // is waiting to be reviewed, and the preview links sit on that review page --
  // so a `published = 1` predicate anywhere in this path would break the only
  // moment the preview is ever used. Neither Django nor the port has one.
  it("previews an unpublished need, which is the only state it is ever used in", async () => {
    db.prepare("UPDATE foodbankchange SET published = 0 WHERE need_id = ?").run(NEED_DASHLESS);

    const { res, body } = await request(previewUrl());

    expect(res.status).toBe(200);
    expect(body).toContain("We've found a new list of items requested by Salisbury Foodbank");
  });
});

// ===========================================================================
// Which template, and the content type
// ===========================================================================

describe("the format parameter", () => {
  beforeEach(() => {
    seedFoodbank({ id: SALISBURY, name: "Salisbury", slug: "salisbury" });
    seedNeed();
  });

  // views.py:2028's `if format == "html"`, kept exactly. The two links on the
  // need page pass "html" and "txt", and everything that is not the exact
  // string "html" -- including "HTML", which is what a maintainer typing the
  // URL by hand is most likely to produce -- is the text half.
  it("serves HTML for exactly ?format=html", async () => {
    const { res, body } = await request(previewUrl(NEED_DASHLESS, "html"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(body).toContain("<!doctype html>");
  });

  it("serves plain text for ?format=txt, the other link on the need page", async () => {
    const { res, body } = await request(previewUrl(NEED_DASHLESS, "txt"));

    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(body).not.toContain("<!doctype html>");
  });

  it("serves plain text when no format is given at all", async () => {
    const { res, body } = await request(previewUrl());

    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(body).not.toContain("<!doctype html>");
  });

  // The case-sensitivity is Django's and is deliberately not "fixed": a
  // case-insensitive comparison here would be a divergence from the shipped
  // site with nothing to gain, since the only callers pass the two exact
  // values. Each of these also kills a specific loosening of the comparison --
  // toLowerCase(), includes(), startsWith(), and "any format at all".
  it.each(["HTML", "Html", "htm", "html5", "text/html", "", "json"])("falls through to plain text for ?format=%s", async (format) => {
    const { res, body } = await request(previewUrl(NEED_DASHLESS, format));

    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(body).not.toContain("<!doctype html>");
  });

  // A DIVERGENCE, pinned as the port behaves. Hono's c.req.query() returns the
  // FIRST value of a repeated parameter; Django's QueryDict.get() returns the
  // LAST (run under Django 5.2.6: QueryDict("format=html&format=txt").get("format")
  // is "txt"). So this URL is HTML here and text there. Unreachable from the
  // admin's own links, harmless, and pinned only so that the day someone
  // reaches for c.req.queries() the change is a decision rather than a
  // side effect.
  it("takes the first of a repeated format parameter, where Django took the last", async () => {
    const { res } = await request("/admin/need/0b9ab6b8c9f24bd6a5b7d0c1e2f34567/email/?format=html&format=txt");

    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  // ANOTHER DIVERGENCE, and the more visible one. Django's
  // render(..., content_type="text/plain") sends that string BARE -- verified
  // by running HttpResponse("x", content_type="text/plain")["Content-Type"]
  // under Django 5.2.6, which is "text/plain", while the default-constructed
  // response is "text/html; charset=utf-8". The port appends charset=utf-8 to
  // both. That is an improvement (the text half contains 🛒 and 🗺️, which a
  // charset-less text/plain leaves to the browser to guess) and it is asserted
  // here so it stays a deliberate one.
  it("labels the charset on both halves, which Django did not", async () => {
    const text = await request(previewUrl(NEED_DASHLESS, "txt"));
    const html = await request(previewUrl(NEED_DASHLESS, "html"));

    expect(text.res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(html.res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });
});

// ===========================================================================
// The text body
// ===========================================================================

describe("the text body", () => {
  beforeEach(() => {
    seedFoodbank({ id: SALISBURY, name: "Salisbury", slug: "salisbury" });
    seedNeed();
  });

  // THE WHOLE BODY, ONCE. Everything else in this file asserts a fragment;
  // this asserts the bytes, because they are the bytes 5,855 people receive
  // and every blank line in them is one the Django original leaves behind
  // too. need_notification_txt.njk's header says "do not tidy it" -- this is
  // what makes that instruction enforceable rather than advisory, including
  // the leading newline the two comment blocks leave, the double blank line
  // where the empty {% if articles.length %} block was, and the trailing
  // space at the end of the file.
  //
  // It is also the only assertion here that would notice the text half being
  // rendered through the HTML template's context by mistake, or the two
  // templates being swapped: every fragment test below would still pass on a
  // body that had drifted anywhere it does not look.
  it("renders the whole plain-text email, blank lines and all", async () => {
    const { body } = await request(previewUrl());

    expect(body).toBe(
      "\nWe've found a new list of items requested by Salisbury Foodbank. They are...\n" +
        "\n" +
        "Tinned Meat\nUHT Milk\nTinned Fruit\n" +
        "\n" +
        "\n" +
        "You can find more details at https://www.givefood.org.uk/needs/at/salisbury/\n" +
        "\n" +
        "🛒 Find donation points https://www.givefood.org.uk/needs/at/salisbury/donationpoints/\n" +
        "🗺️ See other nearby food banks https://www.givefood.org.uk/needs/at/salisbury/nearby/\n" +
        "\n" +
        "Download our app to get notifications when you are at a donation point https://www.givefood.org.uk/apps/\n" +
        "\n" +
        "You're getting these emails because you subscribed to them at www.givefood.org.uk on  at . " +
        "To unsubscribe visit https://www.givefood.org.uk/needs/at/salisbury/updates/unsubscribe/?key= ",
    );
  });

  // THE PARAGRAPH THE PREVIEW DELIBERATELY GETS WRONG, and the reason this
  // route passes subscriber = null. Django's view passes ONLY {need}
  // (views.py:2035), so both date and time render empty and the unsubscribe
  // key is blank -- "on  at ." with two spaces. Reproduced rather than
  // repaired: a plausible fake subscriber would make the preview lie about the
  // one paragraph that is per-recipient in the real mail, and a real
  // subscriber would put a stranger's unsubscribe key on an admin page.
  it("leaves the subscriber sentence blank, exactly as the shipped preview does", async () => {
    const { body } = await request(previewUrl());

    expect(body).toContain("you subscribed to them at www.givefood.org.uk on  at .");
    expect(body).toContain("/updates/unsubscribe/?key=");
    expect(body).not.toContain("?key=undefined");
    expect(body).not.toContain("?key=null");
  });

  // A DELIBERATE DIVERGENCE from Django, recorded 2026-09-05 in the template's
  // own header: notification.txt:21 hardcodes http:// on the unsubscribe link,
  // and the port sends https://. It is the link a recipient clicks to STOP
  // receiving mail, so it should not depend on a 301, and http in bulk mail is
  // what a link scanner flags. (Note that the template's OLDER inner comment
  // still claims the http:// was preserved verbatim; the code, and this test,
  // are the authority.)
  it("sends the unsubscribe link over https, where Django hardcoded http", async () => {
    const { body } = await request(previewUrl());

    expect(body).toContain("https://www.givefood.org.uk/needs/at/salisbury/updates/unsubscribe/");
    expect(body).not.toContain("http://www.givefood.org.uk");
  });

  // change_text is the whole point of the email and goes through byte for
  // byte: no cleaning, no trimming, no re-wrapping, and -- the assertion that
  // matters -- NO HTML ESCAPING. The file is wrapped in {% autoescape false %}
  // because this package's Environment sets autoescape: true globally, which
  // would otherwise put "Tea &amp; Coffee" in a plain-text email. The item
  // names really do contain ampersands ("Rice & Pasta" is a stock line).
  it("does not HTML-escape a plain-text body", async () => {
    db.prepare("UPDATE foodbankchange SET change_text = ? WHERE need_id = ?").run("Tea & Coffee\nSalt & Pepper", NEED_DASHLESS);

    const { body } = await request(previewUrl());

    expect(body).toContain("Tea & Coffee\nSalt & Pepper");
    expect(body).not.toContain("&amp;");
  });

  // The excess block is `{% if has_excess %}`, and excess_list is a plain
  // split on "\n" -- no tidying, so a list Django rendered comma-joined is
  // comma-joined here too, full stop included.
  it("lists the excess items comma-separated when the need has any", async () => {
    db.prepare("UPDATE foodbankchange SET excess_change_text = ? WHERE need_id = ?").run("Beans\nPasta\nSoup", NEED_DASHLESS);

    const { body } = await request(previewUrl());

    expect(body).toContain("Salisbury Foodbank currently doesn't need anymore of these items: Beans, Pasta, Soup.");
  });

  // THE TWO LISTS ARE NOT INTERCHANGEABLE, and until this test nothing seeded
  // both at once: every other test here either sets excess_change_text and
  // asserts only the excess sentence, or leaves it null and asserts only
  // change_text. So `change_text: need.excess_change_text ?? need.change_text`
  // in the context builder -- one wrong-column edit, issue #34's exact shape
  // pointed at a read -- passed all 57 tests in this file ("X1"). The email it
  // produces is self-contradicting: the items it tells 5,855 people a food
  // bank NEEDS are the items the next sentence says it has too many of. Every
  // word of it is a real column out of the real row, which is why no status
  // code, no log line and no template error would have shown it.
  it("keeps the needed list and the excess list apart when a need has both", async () => {
    db.prepare("UPDATE foodbankchange SET excess_change_text = ? WHERE need_id = ?").run("Beans\nPasta\nSoup", NEED_DASHLESS);

    const { body } = await request(previewUrl());

    // The needed items are still change_text's, in full and in order...
    expect(body).toContain("They are...\n\nTinned Meat\nUHT Milk\nTinned Fruit");
    // ...and the excess sentence is still the excess column's.
    expect(body).toContain("currently doesn't need anymore of these items: Beans, Pasta, Soup.");
    // Neither list has borrowed the other's rows.
    expect(body).not.toContain("They are...\n\nBeans");
    expect(body).not.toContain("anymore of these items: Tinned Meat");
  });

  it("omits the excess sentence entirely when there is none", async () => {
    const { body } = await request(previewUrl());

    expect(body).not.toContain("currently doesn't need anymore");
  });

  // `!= 0` in the Django original (notification.txt:16), where None != 0 is
  // TRUE -- so a food bank whose donation-point count has never been computed
  // still gets the line, and only an explicit zero suppresses it. The NULL case
  // is the one worth seeding: it is the state every newly-added food bank is in
  // until the count job first runs, and plain truthiness would silently drop
  // the line for exactly those.
  it("shows the donation points line for a counted food bank", async () => {
    const { body } = await request(previewUrl());

    expect(body).toContain("🛒 Find donation points https://www.givefood.org.uk/needs/at/salisbury/donationpoints/");
  });

  it("shows it for an uncounted (NULL) food bank too, because Python's None != 0", async () => {
    db.prepare("UPDATE foodbank SET no_donation_points = NULL WHERE id = ?").run(SALISBURY);

    const { body } = await request(previewUrl());

    expect(body).toContain("🛒 Find donation points");
  });

  it("hides it only for a food bank with an explicit zero", async () => {
    db.prepare("UPDATE foodbank SET no_donation_points = 0 WHERE id = ?").run(SALISBURY);

    const { body } = await request(previewUrl());

    expect(body).not.toContain("Find donation points");
    // The line below it is unconditional, so its presence is what proves the
    // block was skipped rather than the whole tail of the email being lost.
    expect(body).toContain("🗺️ See other nearby food banks");
  });

  // Foodbank.full_name() -- the emails are English-only (no wfbn/emails/*
  // template loads i18n), so fullNameLocaleAware is called with a fixed "en"
  // and alt_name is never consulted. Seeding a Welsh alt_name that must NOT
  // appear is the only way to assert that: with locale "cy" this email would
  // address 5,855 English-language recipients in Welsh.
  it('appends "Foodbank" to the name and ignores the Welsh alt_name', async () => {
    db.prepare("UPDATE foodbank SET alt_name = ? WHERE id = ?").run("Banc Bwyd Caersallog", SALISBURY);

    const { body } = await request(previewUrl());

    expect(body).toContain("requested by Salisbury Foodbank.");
    expect(body).not.toContain("Banc Bwyd");
  });

  // THE TEXT HALF CARRIES NO UTM PARAMS AT ALL. The Django original has none
  // (unlike the HTML one, which has eight), and the port keeps it that way --
  // so a "harmonising" change that added them to both would be a change to
  // every link in an email already in inboxes. The only "?" in the whole body
  // is the unsubscribe key's, which is why that is asserted as the sole one
  // rather than just grepping for "utm".
  it("carries no tracking parameters, unlike the HTML half", async () => {
    const { body } = await request(previewUrl());

    expect(body).not.toContain("utm_source");
    expect(body.match(/\?/g)).toEqual(["?"]);
    expect(body).toContain("unsubscribe/?key=");
  });
});

// ===========================================================================
// The news block
// ===========================================================================

// Foodbank.articles_month() -- foodbank.py:573-575, the last 28 days of that
// food bank's own RSS. Three independent things can go wrong here and none of
// them throws: the wrong food bank's news, news from outside the window, or
// the right rows in the wrong order. So every test in this block seeds rows
// that MUST BE EXCLUDED alongside the ones that must appear -- a filter that
// did nothing passes any test written only from rows it is supposed to show.
describe("the news block", () => {
  beforeEach(() => {
    seedFoodbank({ id: SALISBURY, name: "Salisbury", slug: "salisbury" });
    seedFoodbank({ id: WEST_NORFOLK, name: "West Norfolk", slug: "west-norfolk" });
    seedNeed();
  });

  // `{% if articles.length %}`, not `{% if articles %}`: an empty JS array is
  // TRUTHY in nunjucks while an empty Django queryset is not, so the naive
  // port of this tag renders a "News from..." heading with nothing under it in
  // every email for every food bank with no recent news -- which is most of
  // them, most weeks.
  it("is absent entirely when the food bank has no recent news", async () => {
    seedArticle({ id: 1, foodbankId: SALISBURY, publishedDate: daysAgo(90), title: "old news", url: "https://example.org/old" });

    const { body } = await request(previewUrl());

    expect(body).not.toContain("News from");
  });

  // The title goes through FoodbankArticle.title_captialised() (articles.py:35-49)
  // and the url through url_with_ref(), both resolved in the context builder
  // because nunjucks cannot call a method on a D1 row. "uht" -> "UHT" is the
  // visible proof the real function ran rather than the raw column being
  // printed: it is in the NO_CAP_WORDS list, so a plain title-case would give
  // "Uht".
  it("prints each article's capitalised title and its ref-tagged url", async () => {
    seedArticle({
      id: 1,
      foodbankId: SALISBURY,
      publishedDate: daysAgo(3),
      title: "uht milk appeal on bbc radio",
      url: "https://salisburyfoodbank.org.uk/news/uht",
    });

    const { body } = await request(previewUrl());

    expect(body).toContain("News from Salisbury Foodbank...");
    expect(body).toContain("UHT Milk Appeal On BBC Radio");
    expect(body).toContain("https://salisburyfoodbank.org.uk/news/uht?ref=givefood.org.uk");
  });

  // TITLE THEN URL, ADJACENT, AND EVERY STORY PRESENT. Two same-typed strings
  // sitting next to each other in the context object and next to each other in
  // the template, which makes swapping them a plausible one-line edit -- and
  // one that leaves BOTH values in the body, so every toContain in this block
  // still passes ("X2"). Today that swap is caught by exactly one test, the
  // HTML half's pinned-empty-date one, which is the test a fix to the
  // double-formatting defect is expected to rewrite; asserting the whole news
  // block here means the pairing survives that fix.
  //
  // The block is asserted entire rather than as two fragments so it also pins
  // what is NOT in it: a LIMIT sneaking into getArticlesForNeedEmail ("X3")
  // would drop every story but the newest, silently, in the preview and in the
  // send alike, and a body that still had a "News from..." heading and one
  // article in it would look completely normal.
  it("pairs each title with its own url and prints every article in the window", async () => {
    seedArticle({ id: 1, foodbankId: SALISBURY, publishedDate: daysAgo(20), title: "older story", url: "https://example.org/older" });
    seedArticle({ id: 2, foodbankId: SALISBURY, publishedDate: daysAgo(2), title: "newer story", url: "https://example.org/newer" });

    const { body } = await request(previewUrl());

    expect(body).toContain(
      "News from Salisbury Foodbank...\n" +
        "\nNewer Story\nhttps://example.org/newer?ref=givefood.org.uk\n" +
        "\nOlder Story\nhttps://example.org/older?ref=givefood.org.uk\n",
    );
  });

  // THE WINDOW. 28 days, measured from now, and the 90-day row is the one that
  // makes the test mean something: without it a query that ignored the cutoff
  // would pass. The text half deliberately prints no date (the Django original
  // omits it), so an article leaking in from 2019 would be indistinguishable
  // from this week's news to the reader.
  it("includes news from inside the 28-day window and excludes news from outside it", async () => {
    seedArticle({ id: 1, foodbankId: SALISBURY, publishedDate: daysAgo(3), title: "recent appeal", url: "https://example.org/recent" });
    seedArticle({ id: 2, foodbankId: SALISBURY, publishedDate: daysAgo(90), title: "ancient appeal", url: "https://example.org/ancient" });

    const { body } = await request(previewUrl());

    expect(body).toContain("Recent Appeal");
    expect(body).not.toContain("Ancient Appeal");
    expect(body).not.toContain("https://example.org/ancient");
  });

  // The foodbank_id predicate, with a row that must be excluded. A dropped
  // filter here puts another charity's news in this charity's email -- 200,
  // no error, and only a recipient who knows both food banks would ever spot
  // it.
  it("excludes another food bank's news from the same window", async () => {
    seedArticle({ id: 1, foodbankId: SALISBURY, publishedDate: daysAgo(3), title: "salisbury appeal", url: "https://example.org/sal" });
    seedArticle({ id: 2, foodbankId: WEST_NORFOLK, publishedDate: daysAgo(3), title: "norfolk appeal", url: "https://example.org/nor" });

    const { body } = await request(previewUrl());

    expect(body).toContain("Salisbury Appeal");
    expect(body).not.toContain("Norfolk Appeal");
    expect(body).not.toContain("https://example.org/nor");
  });

  // ORDER BY published_date DESC. Seeded in the opposite order to the ids, so
  // a query that lost its ORDER BY (or sorted on id, which is what an insertion
  // order looks like) puts the older story at the top of the news block.
  it("puts the newest article first, whatever order the rows were written in", async () => {
    seedArticle({ id: 1, foodbankId: SALISBURY, publishedDate: daysAgo(20), title: "older story", url: "https://example.org/older" });
    seedArticle({ id: 2, foodbankId: SALISBURY, publishedDate: daysAgo(2), title: "newer story", url: "https://example.org/newer" });

    const { body } = await request(previewUrl());

    expect(body.indexOf("Newer Story")).toBeGreaterThan(-1);
    expect(body.indexOf("Newer Story")).toBeLessThan(body.indexOf("Older Story"));
  });

  // FoodbankArticle.url_with_ref() goes through Python's PreparedRequest,
  // which tolerates a lot; the port's urlWithRefFoodbank uses new URL(), which
  // throws. One malformed row in a food bank's RSS history must not 500 the
  // preview -- the maintainer would have no way to tell that apart from a
  // broken page, and the need behind it still needs publishing.
  it("survives an article whose stored url will not parse", async () => {
    seedArticle({ id: 1, foodbankId: SALISBURY, publishedDate: daysAgo(3), title: "broken link", url: "not a url at all" });

    const { res, body } = await request(previewUrl());

    expect(res.status).toBe(200);
    expect(body).toContain("Broken Link");
    expect(body).toContain("not a url at all");
  });
});

// ===========================================================================
// The HTML body
// ===========================================================================

describe("the HTML body", () => {
  beforeEach(() => {
    seedFoodbank({ id: SALISBURY, name: "Salisbury", slug: "salisbury" });
    seedNeed();
  });

  async function html(): Promise<string> {
    return (await request(previewUrl(NEED_DASHLESS, "html"))).body;
  }

  // The HTML half extends emails/page.njk (Django's admin/emails/page.html) --
  // the 3-level table shell every HTML email shares. The preview renders it
  // whole, chrome and all, because that is what the recipient's client will
  // get; a body block served without its shell would look fine in a browser
  // and wrong in Outlook.
  it("renders inside the shared email shell, not as a bare fragment", async () => {
    const body = await html();

    expect(body).toContain("<!doctype html>");
    expect(body).toContain('<img src="https://www.givefood.org.uk/static/img/logo_full.png"');
    expect(body).toContain("Give Food, 61 Bridge Street, Kington, HR5 3DJ");
  });

  // change_text through |linebreaks: escaped, then wrapped in a <p> with the
  // single newlines becoming <br>. The text half prints the same column raw,
  // so this is the one place the two halves legitimately differ in more than
  // markup.
  it("wraps the item list in a paragraph with line breaks", async () => {
    expect(await html()).toContain("<p>Tinned Meat<br>UHT Milk<br>Tinned Fruit</p>");
  });

  // ...and here the autoescaping is CORRECT, where in the text half it would
  // be a defect. Same column, same request, opposite expectation -- which is
  // exactly why the text template carries {% autoescape false %} and this one
  // does not.
  it("escapes an ampersand in the item list, unlike the text half", async () => {
    db.prepare("UPDATE foodbankchange SET change_text = ? WHERE need_id = ?").run("Tea & Coffee", NEED_DASHLESS);

    expect(await html()).toContain("<p>Tea &amp; Coffee</p>");
  });

  // The four utm params, rendered with |safe so the "&" stays a literal "&"
  // rather than "&amp;" -- byte-identical to the Django original's
  // hand-written querystrings. If |safe were dropped, every one of the eight
  // links in this email would carry "&amp;" and the campaign would break in
  // one go, which is why the whole querystring is asserted rather than a
  // fragment of it. The date is the NEED's created, not today.
  it("puts the four utm params on the food bank links, with literal ampersands", async () => {
    const body = await html();

    expect(body).toContain(
      '<a href="https://www.givefood.org.uk/needs/at/salisbury/?utm_source=notificationemail&utm_medium=email&utm_campaign=salisbury-2026-09-05">Salisbury Foodbank</a>',
    );
    expect(body).not.toContain("utm_source=notificationemail&amp;");
  });

  // The unsubscribe link is the one URL in this email that deliberately
  // carries NO utm -- it is pointed at by the List-Unsubscribe header, and a
  // tracking param on it would be both rude and a chance to get the key wrong.
  // Blank here, as the preview intends.
  it("leaves the unsubscribe link unparameterised and its key blank", async () => {
    const body = await html();

    expect(body).toContain('<a href="https://www.givefood.org.uk/needs/at/salisbury/updates/unsubscribe/?key=">clicking here</a>');
  });

  // SUSPECT -- PINNED AS IT BEHAVES, NOT AS IT SHOULD. need_notification.njk:31
  // renders `{{ article.published_date|date("N j, Y, P") }}`, but
  // packages/db/src/needEmailContext.ts:99 has ALREADY formatted that value
  // with the identical format string. djangoDate is therefore handed
  // "Sept. 3, 2026, 9:30 a.m." instead of a stored timestamp, cannot parse it,
  // and -- by the deliberate design of its own NaN guard -- returns "". So the
  // <span class="articledate"> in every HTML notification email is EMPTY, in
  // the preview and in the send alike (workers/jobs/src/notify/needEmail.ts
  // renders the same template from the same context).
  //
  // Django's original prints `{{ article.published_date }}` bare and gets the
  // localised date, so this is a port regression, not a Django quirk. It is
  // silent in the strictest sense: the markup is still there, the block is
  // still there, and only the date is missing. Left alone here per TESTING.md
  // -- the fix is one filter call to delete in the template, but the template
  // is not this file's to change, and a failing test would tell nobody
  // anything.
  it("renders an EMPTY article date -- the double-formatting defect, pinned", async () => {
    seedArticle({ id: 1, foodbankId: SALISBURY, publishedDate: daysAgo(3), title: "harvest appeal", url: "https://example.org/harvest" });

    const body = await html();

    // The article itself is there...
    expect(body).toContain(">Harvest Appeal</a>");
    // ...and its date is not. Asserted as the whole element rather than as an
    // absent substring: "the date is missing" is only meaningful next to the
    // proof that the span it belongs in was rendered.
    expect(body).toContain('<span class="articledate"></span>');
    expect(body).not.toMatch(/<span class="articledate">[^<]/);
    // What the context handed the template, and therefore what a reader would
    // have seen had the template not formatted it a second time.
    expect(body).not.toContain("2026,");
  });

  // The same three guards the text half has, asserted here because the two
  // templates carry their own independent copies of each condition and a
  // divergence between the halves is invisible unless both are checked.
  it("applies the excess, donation-point and news conditions independently of the text half", async () => {
    db.prepare("UPDATE foodbankchange SET excess_change_text = ? WHERE need_id = ?").run("Beans\nPasta", NEED_DASHLESS);
    db.prepare("UPDATE foodbank SET no_donation_points = 0 WHERE id = ?").run(SALISBURY);

    const body = await html();

    expect(body).toContain("currently doesn't need anymore of these items: Beans, Pasta.");
    // ...and the needed-items paragraph is still change_text's, not a second
    // copy of the excess list. Same wrong-column mutant as the text half's
    // "keeps the needed list and the excess list apart" test ("X1"), asserted
    // again here because the two halves read the context independently.
    expect(body).toContain("<p>Tinned Meat<br>UHT Milk<br>Tinned Fruit</p>");
    expect(body).not.toContain("Find <a");
    expect(body).not.toContain("<b>News from");
  });
});

// ===========================================================================
// The guards
// ===========================================================================

describe("a need with no food bank", () => {
  // Django's view would 500 here: every line of both templates dereferences
  // need.foodbank, and `{{ None.slug }}` inside a URL is a TemplateSyntaxError
  // at render time. The port refuses with a 400 and a sentence instead -- a
  // deliberate change, and the one behaviour on this route that is NOT a
  // faithful port. Worth pinning precisely because an admin who sees it needs
  // to understand it is the need that is wrong, not the page.
  it("answers 400 with an explanation rather than 500ing like Django", async () => {
    seedNeed({ foodbankId: null });

    const { res, body } = await request(previewUrl());

    expect(res.status).toBe(400);
    expect(body).toBe("This need has no food bank set, so it has no notification email");
  });

  // The guard short-circuits BEFORE the food bank lookup -- buildNeedEmailContext
  // returns on `need.foodbank_id === null` without querying. Binding null into
  // `WHERE id = ?` would match nothing and cost a round trip, and a future `IS ?`
  // spelling of that predicate would match a NULL id and hand the email a food
  // bank at random. Asserted on the SQL log because no assertion on the
  // response can see it.
  it("does not look up a food bank it knows is not there", async () => {
    seedNeed({ foodbankId: null });

    const { sql } = await request(previewUrl());

    expect(sql).toEqual([PREVIEW_STATEMENTS[0]]);
  });

  // The other way to have no food bank: an id pointing at a row that is not
  // there. Not reachable through the admin (nothing deletes a food bank while
  // its needs remain), but it is the second `if (!context)` branch and it must
  // land in the same place rather than rendering an email addressed to
  // "undefined Foodbank" with links to /needs/at//.
  it("answers 400 for a need whose food bank id resolves to nothing", async () => {
    seedNeed({ foodbankId: 9999 });

    const { res, body, sql } = await request(previewUrl());

    expect(res.status).toBe(400);
    expect(body).toBe("This need has no food bank set, so it has no notification email");
    // It got as far as asking, and stopped before the articles.
    expect(sql).toEqual([PREVIEW_STATEMENTS[0], PREVIEW_STATEMENTS[1]]);
  });

  // The refusal is a refusal in both formats -- ?format=html does not route
  // around the guard into a shell rendered with an empty context, which would
  // be a 200 page that looks like an email and is not one.
  it("refuses the HTML half too, not just the text one", async () => {
    seedNeed({ foodbankId: null });

    const { res, body } = await request(previewUrl(NEED_DASHLESS, "html"));

    expect(res.status).toBe(400);
    expect(body).not.toContain("<!doctype html>");
  });
});

// ===========================================================================
// A preview never writes
// ===========================================================================

describe("a preview never writes", () => {
  beforeEach(() => {
    seedFoodbank({ id: SALISBURY, name: "Salisbury", slug: "salisbury" });
    seedNeed();
    seedArticle({ id: 1, foodbankId: SALISBURY, publishedDate: daysAgo(3), title: "harvest appeal", url: "https://example.org/harvest" });
  });

  function snapshot(): string {
    return JSON.stringify([
      db.prepare("SELECT * FROM foodbankchange ORDER BY id").all(),
      db.prepare("SELECT * FROM foodbank ORDER BY id").all(),
      db.prepare("SELECT * FROM foodbankarticle ORDER BY id").all(),
    ]);
  }

  // gfadmin/views.py:2023-2038 is a pure read and so is this, but the two
  // things that make it worth asserting are next door: /need/:id/notify/ is a
  // POST on the same id that mails 5,855 people, and Django's own view has no
  // method restriction. A preview that touched `notified`, or that marked the
  // need seen, would be a mutation reached by a GET -- the exact shape a
  // crawler or a prefetching browser turns into a production incident.
  //
  // Asserted twice over: the SQL issued (which catches a write that happened to
  // match no rows in this fixture) and the rows themselves.
  it("issues nothing but the three SELECTs, and leaves every row untouched", async () => {
    const before = snapshot();

    const { res, sql } = await request(previewUrl());

    expect(res.status).toBe(200);
    expect(sql).toEqual(PREVIEW_STATEMENTS);
    expect(snapshot()).toBe(before);
  });

  it("writes nothing on the HTML half either", async () => {
    const before = snapshot();

    const { sql } = await request(previewUrl(NEED_DASHLESS, "html"));

    expect(sql).toEqual(PREVIEW_STATEMENTS);
    expect(snapshot()).toBe(before);
  });

  it("writes nothing when it 404s", async () => {
    const before = snapshot();

    await request(previewUrl("11111111111111111111111111111111"));

    expect(snapshot()).toBe(before);
  });
});

// ===========================================================================
// Which food bank name the campaign reports under
// ===========================================================================

describe("the utm campaign name", () => {
  // SUSPECT, PINNED AS IT BEHAVES. needs.py:90-91's foodbank_name_slug is
  // slugify() over the DENORMALISED foodbankchange.foodbank_name column, and
  // packages/db/src/needEmailContext.ts:84-86 keeps that promise in as many
  // words: "not over the live foodbank.name -- they can differ after a rename",
  // so that "a renamed food bank keeps reporting under its old campaign".
  //
  // IT CANNOT, because migration 0019 dropped that column. `need.foodbank_name`
  // now comes from foodbankchange_full's `f.name AS foodbank_name`, which is
  // the live parent by definition, and both callers of the builder (this
  // preview through getNeedByUuid, the send through getNeedById) read that same
  // view. A rename therefore DOES split the campaign, in exactly the way the
  // comment says it does not. packages/db's own unit test for that promise
  // constructs its FoodbankChangeRow by hand, so it is asserting a value the
  // schema can no longer produce.
  //
  // Analytics only -- no link target depends on it -- and following the live
  // name is arguably the better behaviour now that a stale copy is impossible.
  // Pinned as it behaves, per TESTING.md, and reported rather than fixed: what
  // is wrong here is a comment (and a promise) that the database stopped being
  // able to keep, not a line of this route.
  it("reports under the live food bank name, so a rename does split the campaign", async () => {
    seedFoodbank({ id: SALISBURY, name: "Salisbury and District", slug: "salisbury" });
    seedNeed();

    const { body } = await request(previewUrl(NEED_DASHLESS, "html"));

    expect(body).toContain("utm_campaign=salisbury-and-district-2026-09-05");
    expect(body).not.toContain("utm_campaign=salisbury-2026-09-05");
  });

  // The slug is @givefood/models' simplified slugify (lowercase, then every run
  // of non-alphanumerics becomes a "-"), NOT django.utils.text.slugify, which
  // strips apostrophes first -- run under the original site's own install,
  // slugify("King's Lynn") is "kings-lynn" there and "king-s-lynn" here. Pinned
  // at the route level as well as in packages/db because this is where an admin
  // can actually see it: the campaign name is in the href of every link on the
  // preview page.
  it("slugifies the name the port's way, not Django's", async () => {
    seedFoodbank({ id: SALISBURY, name: "King's Lynn", slug: "kings-lynn" });
    seedNeed();

    const { body } = await request(previewUrl(NEED_DASHLESS, "html"));

    expect(body).toContain("utm_campaign=king-s-lynn-2026-09-05");
    expect(body).not.toContain("utm_campaign=kings-lynn");
  });

  // The date half of the campaign, which is the need's own created and not
  // today: a need detected on the 5th and published on the 6th must report
  // under the 5th, and the send path can retry across midnight. Both stored
  // timestamp spellings are accepted, because this column has held two.
  it("dates the campaign from the need's created, in either stored spelling", async () => {
    seedFoodbank({ id: SALISBURY, name: "Salisbury", slug: "salisbury" });
    seedNeed({ created: "2026-08-14T06:02:11.004Z" });

    const { body } = await request(previewUrl(NEED_DASHLESS, "html"));

    expect(body).toContain("utm_campaign=salisbury-2026-08-14");
  });
});
