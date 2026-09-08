import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { Context } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, setRuntimeIdentity } from "@givefood/templates";
import type { AppEnv } from "../../types";
import type { AdminSessionData } from "../../lib/adminAuth";
import { requireAdminAuth } from "../../middleware/adminAuth";
import { serverTiming } from "../../middleware/serverTiming";
import { pageCacheControl } from "../../middleware/pageCacheControl";
import { verifyCsrf } from "../../lib/csrf";
import { adminPageContext } from "./pageContext";

// adminPageContext is not a page -- it is the base every one of the ~35 admin
// page renders is built on (grep: 60-odd call sites across routes/admin/*).
// That is exactly what makes it worth this much test: nothing here throws when
// it goes wrong. A key that stops being emitted does not 500, it renders as an
// empty string somewhere in admin/page.njk, and the failure surfaces days later
// as "the Lookup button does nothing" or "the footer says d1" -- the same
// silent-wrong class as issues #12 and #34, one level further down where it
// hits every admin page at once instead of one form.
//
// Four properties are defended below, each because a specific real failure is
// on the other side of it:
//
//   1. THE FOUR GOOGLE-KEY GLOBALS EXIST AND CARRY THE RIGHT VALUES. The
//      module's own comment records what happened when they did not: admin.js
//      initialises unconditionally on every admin page, so a missing global
//      threw ReferenceError on the first button click and took every lookup
//      button in the admin with it. Two of the four are deliberately published
//      EMPTY -- a divergence from Django's gmap_keys(), which puts all of them
//      in the page -- so "empty" is asserted as the required value, not
//      tolerated as an absence.
//
//   2. A CSRF TOKEN ON EVERY ADMIN PAGE, AND THE SAME ONE ACROSS RENDERS. This
//      function is the ONLY thing that calls issueCsrfToken on an admin page,
//      so it owns two live incidents by proxy: the two-tab 403 (lib/csrf.ts's
//      reuse comment) and the shared-cache leak that stamped one admin's token
//      onto everyone else's copy of the page (middleware/pageCacheControl.ts,
//      "Reproduced against production 2026-09-07"). Both are asserted through
//      the real csrf module and the real cache middleware, not restated.
//
//   3. IT IS SIDE-EFFECT-FREE APART FROM THAT COOKIE. It runs on every admin
//      page load, including POST re-renders, so a query added here is a query
//      added ~35 times over. There is a real, seeded, working D1-shaped
//      database wired into the env below for the sole purpose of proving
//      nothing asks it anything.
//
//   4. THE KEY NAMES ARE THE ONES admin/page.njk READS. Pinned by rendering
//      the real template at the bottom of this file rather than by inspection:
//      renaming any of them is invisible to every key-by-key assertion above
//      and silently blanks a footer line on every admin page for good. That
//      footer is github #35's five debug-comment facts; the `d1_database`
//      line this note used to name was removed with them.

// MUTATION TESTED, not assumed. The module and the two collaborators this
// file deliberately runs for real (lib/csrf.ts, middleware/adminAuth.ts) were
// copied into a scratchpad, broken one edit at a time, and re-run against this
// file. 45 mutants; the record is kept here because a test whose comment
// claims it is load-bearing should say what it was measured against.
//
// 28 mutants of adminPageContext itself, 27 caught: publishing
// env.GMAP_PLACES_KEY the Django way (2 tests fail); swapping the static and
// geocode binds (2); dropping csrf_token, admin_user, d1_database,
// render_time_ms or gmap_geocode_key from the returned object (6, 2, 5, 4, 4)
// -- the #34 shape, a value computed and then written by nothing; renaming
// d1_database or csrf_token (5, 6); a hardcoded and a lower-cased section
// (2, 1); c.req.url for c.req.path (2); passing the querystring through (1);
// hardcoded render_time_ms (2); a blank, constant, per-render-random,
// unawaited or GET-only csrf_token (5, 6, 5, 5, 2); a hardcoded CSRF secret
// (3); dropping the `?? ""` and `?? "d1"` fallbacks (1, 1); re-reading the
// session from KV (5); reading the wrong context var for it (2); a stray D1
// query (1); a stray KV write (1); one extra context key (1). The one
// survivor is equivalent, not a hole: spreading buildPageContext LAST changes
// nothing while the two key sets stay disjoint, and the 23-key lock is what
// notices if they ever stop being.
//
// 17 mutants of the collaborators, 8 caught outright. SEVEN SURVIVORS WERE
// REAL HOLES IN THIS FILE and are closed by the tests marked below: verifyCsrf
// reduced to `return true`; verifyCsrf with the cookie-vs-field comparison
// deleted; verifyCsrf with the Origin check deleted; issueCsrfToken adopting
// an unsigned cookie; and the CSRF cookie losing Secure, losing HttpOnly or
// being scoped Path=/admin. Two more -- a gate that only covers GETs, and one
// that trusts the session cookie's presence over KV's record -- survived
// everything here because the only anonymous case was a GET with no cookie at
// all. Each is now named in the comment of the test that kills it.
//
// The two CSRF reuse tests were REWRITTEN by the earlier round -- they
// originally compared two renders' tokens with each other, which is equally
// true of two empty strings, and both survived the blank-token mutant until
// they were changed to compare against the cookie's raw half. The round-trip
// test below had the same defect in a subtler form and is fixed the same way:
// an assertion that only ever expects success cannot tell an accepted request
// from an unchecked one.

// Hono's fetch() wants an ExecutionContext; nothing on this path touches it.
const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

const ORIGIN = "https://www.givefood.org.uk";
const CSRF_SECRET = "csrf-secret-under-test";
const CSRF_COOKIE = "__Host-csrf";
const SESSION_COOKIE = "__Host-gfsession";
const SESSION_ID = "notARealSessionIdJustLongEnough";

const ADMIN: AdminSessionData = {
  email: "someone@givefood.org.uk",
  name: "Some One",
  givenName: "Some",
  picture: "https://lh3.googleusercontent.com/a/example",
};

// Distinctive values, so an assertion can tell "the env's key came through"
// apart from "some key came through" -- the Places/Maps-JS tests below turn on
// exactly that difference.
const ENV_DEFAULTS = {
  CSRF_SECRET,
  GMAP_STATIC_KEY: "static-key-from-env",
  GMAP_GEOCODE_KEY: "geocode-key-from-env",
  GMAP_PLACES_KEY: "places-key-that-must-never-reach-the-browser",
};

// The five columns of packages/db/migrations/0001_core.sql's `foodbank` that
// any admin page would plausibly read. This database exists to be NOT queried
// (see property 3 above): a stub that threw on prepare() would prove the same
// thing far less honestly, because it would also fail if a caller merely built
// a statement it never ran. A working database that returns rows means the
// "no query" assertions are about restraint, not about breakage.
const SCHEMA = `
CREATE TABLE foodbank (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  contact_email TEXT NOT NULL, url TEXT NOT NULL
);
INSERT INTO foodbank (id, name, slug, contact_email, url)
  VALUES (1, 'Salisbury', 'salisbury', 'info@salisbury.foodbank.org.uk', 'https://salisbury.foodbank.org.uk/');
`;

type Bindable = null | number | bigint | string | Uint8Array;

// The D1 surface packages/db uses, over node:sqlite. Every prepare() is
// recorded, which is the whole point of it being here.
function countingD1(db: DatabaseSync, prepares: string[]): D1Database {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  const prepare = (sql: string) => {
    prepares.push(sql);
    return statement(sql, []);
  };
  return { prepare, withSession: () => ({ prepare, getBookmark: () => null }) } as unknown as D1Database;
}

interface RunOptions {
  /** Path (and query) of the request; the origin is always the production host. */
  path?: string;
  method?: string;
  /** The `section` argument -- what admin/page.njk highlights in the nav. */
  section?: string;
  /** Raw Cookie header. Omit for a visitor arriving with nothing. */
  cookie?: string;
  /** Form body, for the POST (validation-failure re-render) cases. */
  body?: Record<string, string>;
  /** Merged over ENV_DEFAULTS; set a key to undefined to delete it entirely. */
  env?: Record<string, string | undefined>;
  /** Mount the REAL requireAdminAuth in front, with KV holding a live session. */
  auth?: boolean;
  /** KV contents, keyed as lib/adminAuth.ts keys them. Defaults to one live session. */
  kv?: Record<string, string>;
  /** Mount serverTiming, as index.ts:112 does on "*". On by default. */
  timing?: boolean;
  /** Mount the real pageCacheControl, for the shared-cache tests. */
  cacheControl?: boolean;
  /** Mount the handler inside a sub-app routed at /admin, as routes/admin/index.ts does. */
  mounted?: boolean;
}

interface RunResult {
  res: Response;
  /** The context object itself -- captured, not JSON round-tripped, so an
   *  `undefined` VALUE stays distinguishable from a MISSING KEY. */
  ctx: Record<string, unknown>;
  /** Every SQL string the handler's request put to D1. Expected: none. */
  prepares: string[];
  kvGet: ReturnType<typeof vi.fn>;
  kvPut: ReturnType<typeof vi.fn>;
  /** True when the gated handler ran at all -- the anonymous cases turn on this. */
  reached: boolean;
  db: DatabaseSync;
}

// A real Hono app with the real middleware, not a hand-rolled Context.
// adminPageContext reads three things off the context that only a real request
// through a real chain produces: c.req.path (routed, possibly through a mount
// prefix), c.get("adminUser") (set by requireAdminAuth) and c.get(
// "requestStartTime") (set by serverTiming). A synthesised context would let a
// change in any of those three couplings pass unnoticed.
async function run(options: RunOptions = {}): Promise<RunResult> {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  const prepares: string[] = [];

  const store = options.kv ?? { [`admin-session:${SESSION_ID}`]: JSON.stringify({ ...ADMIN, expiresAt: Date.now() + 12 * 60 * 60 * 1000 }) };
  const kvGet = vi.fn(async (key: string) => store[key] ?? null);
  const kvPut = vi.fn(async () => {});

  const env = { ...ENV_DEFAULTS, ...options.env, DB: countingD1(db, prepares), SESSIONS: { get: kvGet, put: kvPut } } as unknown as AppEnv["Bindings"];
  for (const [key, value] of Object.entries(options.env ?? {})) {
    // `{ GMAP_STATIC_KEY: undefined }` has to actually REMOVE the key, not set
    // it to undefined -- "the secret was rotated away" is the case the `?? ""`
    // fallbacks in the module exist for, and a present-but-undefined property
    // is not what a missing binding looks like.
    if (value === undefined) delete (env as unknown as Record<string, unknown>)[key];
  }

  let ctx: Record<string, unknown> = {};
  let reached = false;

  const app = new Hono<AppEnv>();
  if (options.timing !== false) app.use("*", serverTiming);
  if (options.cacheControl) app.use("*", pageCacheControl);
  if (options.auth) app.use("*", requireAdminAuth);

  const handler = async (c: Context<AppEnv>) => {
    reached = true;
    ctx = await adminPageContext(c, options.section ?? "foodbanks");
    return c.html("<p>an admin page</p>");
  };

  if (options.mounted) {
    // Exactly routes/admin/index.ts's shape: a sub-app routed under /admin.
    // Hono rewrites the matched path inside a mounted app, which is why
    // canonical_path is worth asserting from here rather than from a flat app.
    const sub = new Hono<AppEnv>();
    sub.all("*", handler);
    app.route("/admin", sub);
  } else {
    app.all("*", handler);
  }

  const headers = new Headers();
  if (options.cookie !== undefined) headers.set("Cookie", options.cookie);
  let body: string | undefined;
  if (options.body) {
    headers.set("Content-Type", "application/x-www-form-urlencoded");
    body = new URLSearchParams(options.body).toString();
  }

  const res = await app.fetch(new Request(`${ORIGIN}${options.path ?? "/admin/foodbanks/"}`, { method: options.method ?? (body ? "POST" : "GET"), headers, body }), env, execCtx);
  return { res, ctx, prepares, kvGet, kvPut, reached, db };
}

/** The signed cookie value the browser would send back on the next request. */
function csrfCookieFrom(res: Response): string | null {
  const setCookie = res.headers.getSetCookie().find((value) => value.startsWith(`${CSRF_COOKIE}=`));
  return setCookie ? (setCookie.split(";")[0] ?? null) : null;
}

/** The raw token half of that cookie -- what verifyCsrf compares the form field with. */
function rawTokenIn(cookie: string): string {
  return cookie.slice(`${CSRF_COOKIE}=`.length).split(".")[0] ?? "";
}

/** The Cookie header of an admin whose session KV record is still live. */
const SIGNED_IN = `${SESSION_COOKIE}=${SESSION_ID}`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the shape handed to every admin template", () => {
  it("emits exactly these 22 keys, and no more", async () => {
    // A LOCK, not a description. This object is spread FIRST at every call
    // site (`...(await adminPageContext(c, "needs")), foodbank, ...`), so a
    // new key added here is a new global on ~35 admin pages at once, and one
    // that happens to collide with a route's own variable name would be
    // shadowed on the pages that set it and leak on the pages that do not --
    // a difference no per-page test would show. Adding a key is fine; adding
    // one without noticing this list is what this catches.
    const { ctx } = await run();
    expect(Object.keys(ctx).sort()).toEqual([
      "admin_user",
      "canonical_path",
      "colo",
      "commit",
      "csrf_token",
      "domain",
      "flag_path",
      "gmap_geocode_key",
      "gmap_key",
      "gmap_places_key",
      "gmap_static_key",
      "headless",
      "instance_id",
      "is_flag_page",
      "language_code",
      "language_direction",
      "language_name",
      "languages",
      "page_translatable",
      "render_time_ms",
      "section",
      "version",
    ]);
  });

  it("passes `section` straight through, because the nav highlight is the only consumer", async () => {
    // admin/page.njk compares it with eight literals ("foodbanks",
    // "locations", ... "settings"). Nothing validates it, nothing derives it
    // from the path, and a section nobody matches simply highlights nothing --
    // pinned so that a future "helpfully" normalising it (lower-casing,
    // slugifying, defaulting) is a visible change rather than a quiet one that
    // un-highlights half the nav.
    expect((await run({ section: "needs" })).ctx.section).toBe("needs");
    expect((await run({ section: "Crawl Sets" })).ctx.section).toBe("Crawl Sets");
    expect((await run({ section: "", path: "/admin/settings/" })).ctx.section).toBe("");
  });
});

describe("the Google keys admin.js reads off the page", () => {
  it("publishes the geocode and static keys, which the browser genuinely needs", async () => {
    // Both are browser-side by construction: admin.js calls
    // maps.googleapis.com/maps/api/geocode directly (that endpoint sends CORS
    // headers), and the staticmap preview is an <img src>. The value has to be
    // IN the page for either to work, so this is the pair that must never
    // become "" the way the other two deliberately are.
    const { ctx } = await run();
    expect(ctx.gmap_geocode_key).toBe("geocode-key-from-env");
    expect(ctx.gmap_static_key).toBe("static-key-from-env");
  });

  it("never puts the Places key in the page, even when the Worker has one", async () => {
    // THE DIVERGENCE FROM DJANGO, and the one assertion here with a security
    // consequence. gfadmin/context_processors.py's gmap_keys() ships
    // gmap_places_key to the browser on every admin page; this port routes
    // Places through routes/admin/gmapProxy.ts server-side instead and keeps
    // the key on the server. env.GMAP_PLACES_KEY is deliberately SET in this
    // run, so a change that "completes" the port by wiring it up the Django
    // way fails here rather than shipping quietly.
    const { ctx } = await run();
    expect(ctx.gmap_places_key).toBe("");
    // The Maps JS API key has no binding at all and no consumer in any ported
    // admin template. It exists in the context only so admin.js's `const
    // gmap_key = ...` has something to be.
    expect(ctx.gmap_key).toBe("");
  });

  it("degrades to empty strings, not to a 500, when the keys have been rotated away", async () => {
    // The module's stated reason for `?? ""` over a hard read: a revoked key
    // should break the one button that needs it, not every page in the admin.
    // Deleting the bindings outright is what a rotated-away secret looks like
    // to the Worker -- and all four names must still be present and still be
    // strings, because admin.js interpolates them into `const` declarations.
    const { ctx, res } = await run({ env: { GMAP_STATIC_KEY: undefined, GMAP_GEOCODE_KEY: undefined } });
    expect(res.status).toBe(200);
    expect(ctx.gmap_static_key).toBe("");
    expect(ctx.gmap_geocode_key).toBe("");
    for (const key of ["gmap_key", "gmap_places_key", "gmap_static_key", "gmap_geocode_key"]) {
      expect(typeof ctx[key]).toBe("string");
    }
  });

  it("does not port Django's fifth key", async () => {
    // gmap_keys() also supplied `offline_key`, read by Django's
    // admin/foodbank.html:268 to build the Force Check link's ?key=. The port
    // has no equivalent: force-check is routes/admin/foodbankForceCrawl.ts, a
    // POST behind the same admin session as everything else, and no ported
    // template references offline_key (verified by grep across
    // packages/templates/templates). Asserted rather than assumed, so that if
    // a template ever starts reading it, this says where it has to come from.
    expect("offline_key" in (await run()).ctx).toBe(false);
  });
});

// github #35 replaced the footer's "which database am I looking at" line --
// and `d1_database`, its only reader -- with the five facts the public
// debug comment carries. These are the context half; the render half is at
// the bottom of this file.
describe("the admin footer's runtime identity", () => {
  it("carries colo, machine and code, so the footer has something to print", async () => {
    const { ctx } = await run();
    // The values come from middleware/runtimeIdentity via buildPageContext,
    // which is not running here -- so these are its unknown-identity
    // fallbacks. That they are STRINGS rather than undefined is the point:
    // the footer renders on an isolate that has not been through the
    // middleware (a 500 page, a direct render in a test) and must not print
    // "undefined" at an admin.
    expect(typeof ctx.colo).toBe("string");
    expect(typeof ctx.instance_id).toBe("string");
    expect(typeof ctx.version).toBe("string");
  });

  it("no longer carries d1_database, whose only reader was the line #35 removed", async () => {
    // Not merely absent from the key list above -- asserted by name, because
    // "the footer stopped reading it" and "the context stopped providing it"
    // are two separate changes and leaving only the first is how a value
    // computed for nobody survives (the #34 shape this file's header names).
    expect((await run()).ctx).not.toHaveProperty("d1_database");
  });
});

describe("the signed-in admin", () => {
  it("hands the template the session requireAdminAuth resolved, with no second KV read", async () => {
    // adminPageContext must not go back to KV for something the middleware
    // already put on the context (see requireAdminAuth's own comment -- "so
    // every downstream handler can read it without a second KV lookup"). One
    // GET for the session, and no more; on a busy admin the difference is one
    // KV read per page against two.
    const { ctx, kvGet } = await run({ auth: true, cookie: SIGNED_IN });
    expect(ctx.admin_user).toEqual(ADMIN);
    expect(kvGet).toHaveBeenCalledTimes(1);
  });

  it("leaves admin_user undefined -- the key still present -- when no middleware set one", async () => {
    // Reachable in production for anything mounted outside adminApp's gate.
    // admin/page.njk guards with `{% if admin_user %}`, so this renders a nav
    // with no "signed in as" and no Sign out link rather than throwing; pinned
    // because the alternative (a hard read that assumed the middleware had
    // run) would turn that into a 500 on those routes.
    const { ctx } = await run();
    expect("admin_user" in ctx).toBe(true);
    expect(ctx.admin_user).toBeUndefined();
  });

  it("is never reached at all by an anonymous request, and mints no token for one", async () => {
    // The auth half of the CSRF story: an unauthenticated GET is turned away
    // by requireAdminAuth before the handler runs, so no token is minted and
    // no __Host-csrf cookie is handed out. A token issued to an anonymous
    // caller would not be a vulnerability by itself, but it would put a
    // Set-Cookie on the sign-in redirect and make the anonymous and
    // authenticated paths indistinguishable from the outside.
    const { res, reached, ctx } = await run({ auth: true, path: "/admin/foodbanks/" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Ffoodbanks%2F");
    expect(reached).toBe(false);
    expect(ctx).toEqual({});
    expect(csrfCookieFrom(res)).toBeNull();
  });

  it("turns a signed-out POST away too, and the seeded row is still there afterwards", async () => {
    // The GET above is the case an admin sees; the POST is the case that
    // costs something. Every mutating route in the admin is a POST behind this
    // same gate, so a gate written as `if (!session && c.req.method ===
    // "GET")` -- an entirely plausible line to write while exempting a webhook
    // -- leaves every save open to an anonymous request while the admin pages
    // themselves still look locked. That mutant survived this whole file,
    // because the only anonymous case here was a GET.
    //
    // The seeded row is read back out of SQLite rather than the 302 being
    // taken as proof: a redirect is not evidence that nothing was written.
    // Issue #34 redirected as though it had worked while writing nothing, and
    // the same reasoning runs in reverse here.
    const { res, reached, prepares, db } = await run({
      auth: true,
      method: "POST",
      body: { name: "Renamed By Nobody" },
      path: "/admin/foodbank/salisbury/edit/",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Ffoodbank%2Fsalisbury%2Fedit%2F");
    expect(reached).toBe(false);
    expect(prepares).toEqual([]);
    expect(db.prepare("SELECT name FROM foodbank WHERE id = 1").get()).toEqual({ name: "Salisbury" });
    expect(csrfCookieFrom(res)).toBeNull();
  });

  it("treats a session cookie KV no longer holds as anonymous, cookie or no cookie", async () => {
    // The state the maintainer is in most mornings: the browser still sends
    // __Host-gfsession, KV expired the record overnight (expiry is KV's
    // expirationTtl, so an expired session is simply an absent one -- see
    // lib/adminAuth.ts's getAdminSession, which has no expiresAt check of its
    // own). The cookie's mere PRESENCE must not be what authenticates. A gate
    // that fell back to it would keep a long-dead session admin indefinitely
    // and would still pass the no-cookie-at-all test above, which is the only
    // signed-out case this file used to have -- so that mutant survived too.
    const { res, reached, ctx } = await run({ auth: true, cookie: SIGNED_IN, kv: {} });
    expect(res.status).toBe(302);
    expect(reached).toBe(false);
    expect(ctx).toEqual({});
    expect(csrfCookieFrom(res)).toBeNull();
  });
});

describe("the CSRF token every admin form is submitted with", () => {
  it("issues a raw token and the signed cookie that will validate it", async () => {
    const { res, ctx } = await run();
    const token = ctx.csrf_token as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    // The cookie's raw half must be the token verbatim -- verifyCsrf compares
    // them with timingSafeEqual, so anything else (a signed value in the form
    // field, a truncated token) fails every save in the admin at once.
    const cookie = csrfCookieFrom(res);
    expect(cookie).not.toBeNull();
    expect(cookie).toMatch(new RegExp(`^${CSRF_COOKIE}=${token}\\.[0-9a-f]{64}$`));

    // AND ITS ATTRIBUTES, which csrfCookieFrom() above deliberately throws
    // away. Three mutants lived in that gap: dropping Secure, dropping
    // HttpOnly, and scoping the cookie `Path=/admin` -- which reads like the
    // more careful choice and is the one that breaks everything, because the
    // __Host- prefix is browser-enforced and requires Path=/ exactly, with
    // Secure and no Domain. A __Host- cookie the browser refuses to store is
    // not a weaker token, it is no token at all: verifyCsrf then finds no
    // cookie and every Save in the admin 403s, discarding the form. Compared
    // as an exact sorted set rather than with toContain, because "; Path=/" is
    // a substring of "; Path=/admin" and would have waved that mutant through.
    expect(cookie).not.toBeNull();
    const attributes = res.headers.getSetCookie().find((v) => v.startsWith(`${CSRF_COOKIE}=`))!.split("; ").slice(1);
    expect(attributes.sort()).toEqual(["HttpOnly", "Path=/", "SameSite=Lax", "Secure"]);
  });

  it("issues a token the real verifyCsrf accepts back -- and refuses every near miss", async () => {
    // END TO END, through the shipped verifier rather than by inspecting the
    // string: render a page, take the token and the cookie exactly as a
    // browser would, and post them back. This is the assertion that would have
    // caught the token and the cookie drifting apart -- which is not
    // hypothetical, it is what the two-tab bug in lib/csrf.ts's comment was.
    //
    // THE THREE REJECTIONS ARE THE LOAD-BEARING HALF, and this test did not
    // have them. `verified === true` is exactly what a verifyCsrf reduced to
    // `return true` also returns, so the prompt's own first mutant -- delete
    // the CSRF check -- survived a test whose entire stated purpose was to run
    // the real one. So did deleting `timingSafeEqual(cookieRaw, formToken)`,
    // which IS the double-submit, and deleting the Origin comparison. A
    // round-trip test that only ever asserts success proves a request was
    // accepted, not that anything looked at it.
    const first = await run();
    const token = first.ctx.csrf_token as string;
    const cookie = csrfCookieFrom(first.res)!;

    // Returns `undefined` rather than false when the inner handler never ran,
    // and every expectation below is toBe(true)/toBe(false) rather than a
    // truthiness check, so a submission that failed to route cannot pass for
    // the wrong reason -- which is how a negative control quietly stops being
    // one.
    const submit = async (extraHeaders: Record<string, string>, formToken: string): Promise<boolean | undefined> => {
      let verified: boolean | undefined;
      const app = new Hono<AppEnv>();
      app.post("*", async (c) => {
        verified = await verifyCsrf(c, c.env.CSRF_SECRET, (await c.req.parseBody()).csrf_token as string);
        return c.text("ok");
      });
      await app.fetch(
        new Request(`${ORIGIN}/admin/foodbank/salisbury/edit/`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, "Sec-Fetch-Site": "same-origin", ...extraHeaders },
          body: new URLSearchParams({ csrf_token: formToken }).toString(),
        }),
        { CSRF_SECRET } as unknown as AppEnv["Bindings"],
        execCtx,
      );
      return verified;
    };

    // What a real admin's Save looks like.
    expect(await submit({ Cookie: cookie }, token)).toBe(true);
    // A well-formed token this admin was never issued, against their own valid
    // cookie -- kills a verifier that stops comparing the two halves.
    expect(await submit({ Cookie: cookie }, "0".repeat(64))).toBe(false);
    // The right token with no cookie to double-submit against: what a
    // cross-site post can actually manage, since it cannot read the response.
    expect(await submit({}, token)).toBe(false);
    // Both halves genuine, submitted from somewhere else entirely.
    expect(await submit({ Cookie: cookie, Origin: "https://evil.example" }, token)).toBe(false);
  });

  it("mints a fresh token rather than adopting one out of a cookie it never signed", async () => {
    // The reuse test below hands back a cookie this Worker minted itself, so
    // on its own it is equally true of an issueCsrfToken that echoed ANY
    // cookie it was given: deleting the signature check on the existing cookie
    // left every test in this file green. That is worth pinning HERE and not
    // only in lib/csrf.test.ts, because adminPageContext is the thing that
    // writes the returned value into the hidden field of every admin form -- an
    // adopted cookie means an attacker-chosen token rendered into the admin's
    // own page, which is the precise scenario issueCsrfToken's "attacker-
    // planted cookie from a sibling subdomain" comment exists for (a __Host-
    // cookie cannot be set cross-site, but *.givefood.org.uk can, and the
    // signature is what makes that useless).
    const forgedRaw = "a".repeat(64);
    const { ctx, res } = await run({ cookie: `${CSRF_COOKIE}=${forgedRaw}.${"b".repeat(64)}` });
    expect(ctx.csrf_token).not.toBe(forgedRaw);
    expect(ctx.csrf_token).toMatch(/^[0-9a-f]{64}$/);

    // ...and the forged cookie is REPLACED, not merely ignored, so the admin's
    // next Save has a cookie that matches the field they were just handed.
    // Without this the page would render a token with nothing to validate it
    // and every form on it would 403 -- silently, and only for whoever was
    // targeted.
    const replacement = csrfCookieFrom(res);
    expect(replacement).not.toBeNull();
    expect(rawTokenIn(replacement!)).toBe(ctx.csrf_token);
  });

  it("reuses the token an admin already holds, so a form left open in another tab still submits", async () => {
    // The two-tab 403. Every admin page goes through this function, so if it
    // minted per render, opening a second food bank replaced the cookie and
    // Save on the first tab 403'd -- discarding everything typed. Asserted
    // here (not only in lib/csrf.test.ts) because adminPageContext is what
    // makes it happen on EVERY admin page rather than on forms alone.
    const first = await run();
    const cookie = csrfCookieFrom(first.res)!;
    const second = await run({ cookie, path: "/admin/needs/" });

    // Compared with the COOKIE's raw half, not just with the first render's
    // token: "both pages returned the same value" is also true when both
    // return "", which is what a token that had quietly stopped being issued
    // would look like. The token in tab two's form has to be the one tab one's
    // cookie still holds, or neither tab can save.
    expect(second.ctx.csrf_token).toBe(rawTokenIn(cookie));
    expect(second.ctx.csrf_token).toBe(first.ctx.csrf_token);
    expect(csrfCookieFrom(second.res)).toBeNull(); // nothing re-set, so tab one's cookie survives
  });

  it("hands a rejected POST back the same token it was submitted with", async () => {
    // Issue #12's re-render path. A duplicate name comes back as a 400 with
    // the form re-rendered -- and that re-render goes through adminPageContext
    // like any other, so the token in the returned form has to be the one the
    // admin's cookie still holds, or the "fix your name and press Save again"
    // instruction 403s and loses the form for real the second time.
    const first = await run();
    const token = first.ctx.csrf_token as string;
    const cookie = csrfCookieFrom(first.res)!;

    const rerender = await run({ method: "POST", cookie, body: { csrf_token: token, name: "Salisbury" }, path: "/admin/foodbank/salisbury/location/new/" });
    expect(rerender.ctx.csrf_token).toBe(token);
    expect(rerender.ctx.csrf_token).toBe(rawTokenIn(cookie)); // and it is still the cookie's, not merely stable
  });

  it("fails closed with no token and no cookie when CSRF_SECRET is unset", async () => {
    // Same convention as lib/turnstile.ts: an unset secret must never be
    // silently indistinguishable from "working". The page still renders (200) --
    // the admin can read it -- but every form on it carries an empty token and
    // every submission is refused, which is the loud half of failing closed.
    const { ctx, res } = await run({ env: { CSRF_SECRET: undefined } });
    expect(ctx.csrf_token).toBe("");
    expect(res.status).toBe(200);
    expect(csrfCookieFrom(res)).toBeNull();
  });
});

describe("an admin page must never enter a shared cache", () => {
  it("marks the response per-visitor even when it sets no cookie", async () => {
    // THE 2026-09-07 PRODUCTION INCIDENT, from the side that caused it.
    // pageCacheControl's first version keyed its per-visitor guard on
    // Set-Cookie. issueCsrfToken REUSES a valid cookie and returns without
    // re-emitting it, so a returning admin's page carried a token and NO
    // Set-Cookie, was stamped `public, s-maxage=...` and went into the shared
    // cache with that admin's token in the HTML.
    //
    // noStore also covers /admin in production (index.ts registers four
    // patterns for it), and that is the primary defence -- it is deliberately
    // NOT mounted here, so this test isolates the second one: the csrfIssued
    // flag adminPageContext causes to be set. Both layers exist because the
    // same leak on /flag/ and /write/to/<slug>/ has no noStore in front of it.
    const first = await run({ cacheControl: true });
    const cookie = csrfCookieFrom(first.res)!;

    const returning = await run({ cacheControl: true, cookie });
    expect(csrfCookieFrom(returning.res)).toBeNull(); // the condition that broke it
    expect(returning.res.headers.get("Cache-Control")).toBeNull();
  });

  it("still marks it when CSRF_SECRET is missing -- because then there is no token to leak", async () => {
    // The one path that does NOT set csrfIssued: issueCsrfToken returns before
    // the flag when the secret is unset. Pinned as current behaviour, and it
    // is safe for the reason the name gives -- the flag means "this response
    // carries a token", and this response carries an empty one. The page IS
    // therefore left cacheable by this middleware alone, which is why noStore
    // over /admin/* is the layer that actually has to hold. A change that made
    // the flag unconditional would flip this assertion, and that would be an
    // improvement, not a regression -- but it should be a decision, not a
    // surprise.
    const { res } = await run({ cacheControl: true, env: { CSRF_SECRET: undefined } });
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
  });
});

describe("render_time_ms", () => {
  it("is whole milliseconds, measured from the serverTiming middleware's start", async () => {
    // Django's footer prints a real fraction; this port rounds, because
    // Workers coarsens timers and the fraction was always exactly ".000" (see
    // middleware/serverTiming.ts). Driven from a fixed clock so the number is
    // the assertion rather than "is a string of digits": reading 1 is
    // serverTiming's t0, reading 2 is elapsedMs inside adminPageContext.
    const readings = [1000, 1064.6, 1099];
    let i = 0;
    vi.spyOn(performance, "now").mockImplementation(() => readings[Math.min(i++, readings.length - 1)] ?? 0);

    expect((await run()).ctx.render_time_ms).toBe("65");
  });

  it("reads 'NaN' when the page is served without serverTiming in front of it", async () => {
    // SUSPECT, pinned rather than fixed. elapsedMs subtracts an unset
    // requestStartTime, giving NaN, and admin/page.njk's footer prints it
    // verbatim as "NaN ms". Not a live bug -- index.ts:112 mounts serverTiming
    // on "*" above every route -- but it is an undeclared coupling: this
    // function depends on a middleware it neither mounts nor checks for, and
    // the failure mode is a footer that quietly reads NaN rather than anything
    // that would draw attention.
    expect((await run({ timing: false })).ctx.render_time_ms).toBe("NaN");
  });
});

describe("the public-site half, spread in from buildPageContext", () => {
  it("builds canonical_path from the FULL request path, mount prefix included", async () => {
    // routes/admin/index.ts mounts adminApp with app.route("/admin", ...), and
    // Hono rewrites the path a sub-app matches against. c.req.path must still
    // be the browser's path here, or every canonical URL in the admin loses
    // its /admin prefix.
    const { ctx } = await run({ mounted: true, path: "/admin/foodbank/salisbury/" });
    expect(ctx.canonical_path).toBe("https://www.givefood.org.uk/admin/foodbank/salisbury/");
    expect(ctx.domain).toBe("https://www.givefood.org.uk");
  });

  it("drops the querystring, so flag_path and canonical_path are always equal here", async () => {
    // buildPageContext takes an optional `querystring` and adminPageContext
    // passes none, so an admin list page's filters (?q=, ?page=) never reach
    // either path. Pinned as CURRENT BEHAVIOUR, not endorsed: neither variable
    // is read by any admin template today, so nothing observes it -- which is
    // exactly why it would drift unnoticed if a template ever started to.
    const { ctx } = await run({ path: "/admin/foodbanks/?q=salisbury&page=2" });
    expect(ctx.canonical_path).toBe("https://www.givefood.org.uk/admin/foodbanks/");
    expect(ctx.flag_path).toBe(ctx.canonical_path);
  });

  it("offers no translations, because the admin is English-only", async () => {
    // No `locale` is passed, so buildPageContext returns an EMPTY alternates
    // list rather than four bogus /cy/admin/... URLs. admin/page.njk hardcodes
    // lang="en-GB" and has no language switcher, so a non-empty list here
    // would be four alternate URLs pointing at pages behind an auth gate.
    const { ctx } = await run();
    expect(ctx.languages).toEqual([]);
    expect(ctx.language_code).toBe("en");
    expect(ctx.language_name).toBe("English");
    expect(ctx.page_translatable).toBe(false);
    expect(ctx.headless).toBe(false);
    expect(ctx.is_flag_page).toBe(false);
  });

  it("carries the isolate's version, which is every ?v= cache-buster in the admin", async () => {
    // The bug the module comment records: nothing passed a version, context.ts
    // fell back to a constant, and every shipped CSS/JS change kept being
    // served under the same ?v= key. The identity is module state inside
    // @givefood/templates (set once per isolate by middleware/runtimeIdentity),
    // so it is set and restored around this test rather than left set --
    // otherwise the assertion above that an un-identified isolate reports
    // "unknown" would depend on file order.
    expect((await run()).ctx.version).toBe("unknown");
    try {
      setRuntimeIdentity({ colo: "LHR", instanceId: "a1b2c3d", version: "9b11b27", commit: "9b11b27" });
      const { ctx } = await run();
      expect(ctx.version).toBe("9b11b27");
      expect(ctx.commit).toBe("9b11b27");
      expect(ctx.colo).toBe("LHR");
      expect(ctx.instance_id).toBe("a1b2c3d");
    } finally {
      // context.ts's own UNKNOWN_IDENTITY, restored verbatim -- there is no
      // reset function, so this is the only way back to the default.
      setRuntimeIdentity({ colo: "unknown", instanceId: "unknown", version: "unknown", commit: null });
    }
  });
});

describe("side effects", () => {
  it("asks the database nothing, on a page load or on a POST re-render", async () => {
    // ~35 admin pages are built on this function, so a query added here is a
    // query added 35 times over -- and it would be invisible, because every
    // one of those pages is already querying for its own content. The D1
    // binding wired into `run()` is a real, seeded, working SQLite; this
    // asserts restraint rather than breakage.
    const get = await run({ auth: true, cookie: SIGNED_IN });
    expect(get.prepares).toEqual([]);
    const post = await run({ method: "POST", body: { name: "Salisbury" } });
    expect(post.prepares).toEqual([]);

    // And the seeded row is untouched, which is the same claim made where it
    // cannot be argued with.
    expect(post.db.prepare("SELECT COUNT(*) AS n FROM foodbank").get()).toEqual({ n: 1 });
  });

  it("writes nothing to KV", async () => {
    // The session store is read-mostly by design (lib/adminAuth.ts's sliding
    // refresh is bounded to roughly one write per 6h of use, precisely because
    // KV allows ~1 write/sec/key). A put from a per-page-render helper would
    // blow through that on a busy admin session.
    const { kvPut } = await run({ auth: true, cookie: SIGNED_IN });
    expect(kvPut).not.toHaveBeenCalled();
  });

  it("is called on GETs and POSTs alike and behaves identically", async () => {
    // Several admin routes are one function serving both verbs (foodbank.ts,
    // foodbankLocation.ts, needs.ts), and the POST arm calls this on the
    // validation-failure re-render. Anything method-dependent in here would
    // make the re-rendered form differ from the one first served -- which is
    // the failure mode issue #12 is about.
    //
    // The whole object is compared rather than a chosen subset, so a new
    // method-dependent key cannot slip past by not being on a list. That means
    // freezing the clock: render_time_ms is the one field that legitimately
    // differs between two requests, and leaving it live made this test fail
    // roughly one run in four when the second request happened to cross a
    // millisecond boundary. Frozen, both reads are the same instant and every
    // remaining difference is a real one.
    vi.spyOn(performance, "now").mockReturnValue(1_000);

    const cookie = csrfCookieFrom((await run()).res)!;
    const get = await run({ cookie, path: "/admin/foodbank/salisbury/edit/", section: "foodbanks" });
    const post = await run({ cookie, path: "/admin/foodbank/salisbury/edit/", section: "foodbanks", method: "POST", body: { name: "x" } });
    expect(post.ctx).toEqual(get.ctx);
  });
});

describe("as admin/page.njk actually consumes it", () => {
  it("renders the real chrome: nav, footer and the four JS globals", async () => {
    // THE KEY-NAME PROOF, and the reason it is worth rendering a real template
    // in a unit test. Every assertion above names a key; none of them would
    // notice if the TEMPLATE read a different one -- a renamed key leaves the
    // footer silently blank on every admin page, forever, with nothing
    // failing. That is the #34 shape: parsed, passed down, consumed by nobody.
    const { ctx } = await run({ auth: true, cookie: SIGNED_IN, section: "needs" });
    const html = await render("admin/page.njk", ctx);

    // github #35's footer: the five facts the public debug comment carries.
    //
    // RENDERED WITH THREE DISTINCT SENTINELS, and that is not decoration.
    // Outside the runtimeIdentity middleware -- which is not running here --
    // `colo`, `instance_id` and `version` ALL fall back to the same "unknown"
    // string, so a footer with all three lines wired to one variable renders
    // identically to a correct one and passes any assertion made against the
    // real context. Measured: mutating `In colo` to read `{{ version }}`
    // survived the first version of this test. Distinct values are what make
    // each line prove it reads its OWN key.
    const wired = await render("admin/page.njk", { ...ctx, colo: "LHR", instance_id: "2ce04f4", version: "0f39cb09" });
    expect(wired).toContain(`<dt>🌐 In colo</dt>\n      <dd>LHR</dd>`);
    expect(wired).toContain(`<dt>🖥️ By machine</dt>\n      <dd>2ce04f4</dd>`);
    expect(wired).toContain(`<dt>💾 Using code</dt>\n      <dd>0f39cb09</dd>`);
    expect(wired).toContain(`<dt>⏱️ Took</dt>\n      <dd>${ctx.render_time_ms}ms</dd>`);
    // now() is the renderer's own clock, so it is matched by shape rather
    // than by value -- RFC 2822, the same spelling debugcomment.njk uses.
    expect(wired).toMatch(/<dt>🕰️ Generated at<\/dt>\n      <dd>[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000<\/dd>/);
    // And the same five against the UNMODIFIED context, so the sentinels above
    // cannot hide a template that ignores the real key names.
    expect(html).toContain(`<dd>${ctx.colo}</dd>`);
    expect(html).toContain(`<dd>${ctx.render_time_ms}ms</dd>`);
    // The removed line, asserted gone: the wrangler var is still in this
    // test's env, so a footer that still read it would still print it.
    expect(html).not.toContain("givefood-under-test");
    expect(html).not.toContain("Database");
    // The cache-buster on every static asset, from the same `version`.
    expect(html).toContain(`/static/css/admin.css?v=${ctx.version}`);
    // The nav's identity block, from admin_user.
    expect(html).toContain("someone@givefood.org.uk");
    expect(html).toContain('href="/auth/sign-out/"');
    expect(html).toContain('<a class="navbar-item is-active" href="/admin/needs/">Needs</a>');
    // The four globals admin.js reads, with the two deliberately-empty ones
    // still DECLARED -- an absent `const` is the ReferenceError the module
    // comment describes, which kills every lookup button on the page.
    expect(html).toContain('const gmap_key = "";');
    expect(html).toContain('const gmap_places_key = "";');
    expect(html).toContain('const gmap_static_key = "static-key-from-env";');
    expect(html).toContain('const gmap_geocode_key = "geocode-key-from-env";');
  });

  it("renders the same chrome, minus the identity block, for a context with no admin_user", async () => {
    // The `{% if admin_user %}` guard -- proof that the undefined case above
    // is genuinely survivable in the template rather than merely permitted by
    // the type.
    const html = await render("admin/page.njk", (await run()).ctx);
    expect(html).not.toContain("someone@givefood.org.uk");
    expect(html).not.toContain('href="/auth/sign-out/"');
    // The footer is outside the identity guard, so it renders either way.
    expect(html).toContain("💾 Using code");
  });
});
