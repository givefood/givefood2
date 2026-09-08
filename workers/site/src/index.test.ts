import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./index";
import { PREFIXES } from "./middleware/resolveLanguage";
import type { Env } from "../worker-configuration";

// THE MOUNT LIST, and nothing else. index.ts is 700 lines of route
// registration; what this file pins is the one part of it that is a security
// and cost decision rather than a URL map -- which paths get
// middleware/noStore.ts wrapped round them.
//
// Issue #40 removed two of those mounts. /flag/ was 16.94% of the zone's
// 200s and permanently at cf-cache-status BYPASS because
// routes/public/flag.ts embedded a per-visitor CSRF token Django never had;
// with the token gone the page is the same for everybody and belongs back on
// the edge. THE TWO EDITS ARE ONE CHANGE -- see routes/public/flag.test.ts
// for the other half, and for why shipping either alone is a live incident.
//
// The mount list is exactly the kind of thing that rots by subtraction. It
// was itself written in response to Cloudflare serving authenticated admin
// pages -- including the subscribers tab -- to anonymous visitors with
// `cf-cache-status: HIT` on 2026-09-02, and a cache HIT never executes the
// Worker, so requireAdminAuth was not bypassed, it was never reached. So the
// interesting assertions here are not the one path that changed but the nine
// that did NOT: a future edit that generalises "/flag/ doesn't need this" one
// mount too far has to fail a test to do it.
//
// Issue #32 is the same list rotting the other way, by omission rather than
// subtraction, and has its own describe block at the foot of this file.
//
// REAL APP, REAL MIDDLEWARE ORDER. `app` is index.ts's own default export,
// so these requests unwind through the real registration order rather than a
// copy of the mount list transcribed into the test (which is what
// middleware/noStore.test.ts does, deliberately, to pin the middleware's own
// behaviour -- a copy cannot notice index.ts changing, which is precisely
// what this file is for).

// No bindings beyond CSRF_SECRET, which is here only to keep
// /register-foodbank/ off lib/csrf.ts's "not set" log line -- nothing in this
// file reads a token. Every path below either needs no binding at all, or
// throws on the missing D1 and is answered by app.onError, which is a case
// worth covering on its own (see the third test).
const env = { CSRF_SECRET: "test-csrf-secret" } as unknown as Env;

const NO_STORE = "private, no-store, max-age=0, must-revalidate";
const url = (path: string) => `https://www.givefood.org.uk${path}`;

async function headers(path: string, method = "GET") {
  const res = await app.request(url(path), { method }, env);
  return {
    status: res.status,
    cacheControl: res.headers.get("Cache-Control"),
    cdn: res.headers.get("CDN-Cache-Control"),
    vary: res.headers.get("Vary"),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("noStore mounts: what issue #40 removed", () => {
  it("no longer covers /flag/, in English or any prefixed locale", async () => {
    // index.ts used to carry `app.use("/flag/", noStore)` and, inside the
    // LOCALES loop, `app.use(`/${locale}/flag/`, noStore)`. Both are gone, so
    // middleware/pageCacheControl.ts's gap-filler is reached instead and the
    // page gets a real TTL. CDN-Cache-Control is the load-bearing absence:
    // index.ts's own comment records that removing Cache-Control alone was
    // NOT enough (the zone Cache Rule gives HTML an edge TTL of its own, and
    // /flag/ came back HIT age=47 with no header at all), and that
    // CDN-Cache-Control: no-store was the only thing that actually stopped
    // the edge. Its absence is therefore what makes the page cacheable again,
    // not the Cache-Control value.
    for (const path of ["/flag/", "/cy/flag/", "/ga/flag/", "/gd/flag/"]) {
      expect(await headers(path), path).toEqual({
        status: 200,
        // givefood/views.py:1098's @cache_page(SECONDS_IN_DAY), reached via
        // pageCacheControl.ts's fallthrough -- which is why issue #40 says
        // explicitly to add NO SHARED_TTL rule for this path. A
        // SECONDS_IN_WEEK entry would silently diverge from Django's number.
        cacheControl: "public, max-age=300, s-maxage=86400",
        cdn: null,
        vary: null,
      });
    }
  });

  it("still covers every other path in the list, unchanged", async () => {
    // The nine that must not move. /register-foodbank/ is the one that hurts
    // most if it does: it is the same shape as /flag/ (same relay, same
    // shared verifyHumanGate) and issue #40 names it as a possible follow-on
    // -- explicitly "not part of this finding's numbers". Until that is
    // measured and decided on its own, it keeps both halves of the old
    // arrangement, and this row is where that stays deliberate.
    for (const path of [
      "/admin/",
      "/admin/foodbank/sid-valley/",
      "/auth/",
      "/auth/start/",
      "/register-foodbank/",
      "/cy/register-foodbank/",
      "/ga/register-foodbank/",
      "/gd/register-foodbank/",
    ]) {
      const h = await headers(path);
      expect(h.cacheControl, path).toBe(NO_STORE);
      expect(h.cdn, path).toBe("no-store");
      expect(h.vary, path).toBe("Cookie");
    }
  });

  it("stamps the two D1-backed mounts even when the handler throws", async () => {
    // /needs/at/<slug>/updates/* and /write/to/* need a database, so with no
    // binding they raise and app.onError renders the 500 page. noStore runs
    // on the way OUT and therefore still stamps it -- which is the behaviour
    // to want (an unsigned-out admin's error page is no more cacheable than
    // their dashboard) and the only way to reach these mounts without a
    // seeded D1. The 500 is the point of the test, not an accident of it.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    for (const path of ["/needs/at/sid-valley/updates/unsubscribe/", "/write/to/sid-valley/"]) {
      const h = await headers(path);
      expect(h.status, path).toBe(500);
      expect(h.cacheControl, path).toBe(NO_STORE);
      expect(h.cdn, path).toBe("no-store");
      expect(h.vary, path).toBe("Cookie");
    }

    // /write/to/<slug>/email/done/ matches TWO mounts ("/write/to/*" and
    // "/write/to/*/email/done/"), so noStore runs twice and Vary -- appended,
    // not set -- comes out doubled. Harmless (a repeated field value means
    // the same thing to every cache) and pre-existing, pinned so that the
    // doubling is understood rather than rediscovered as a bug.
    const done = await headers("/write/to/sid-valley/email/done/");
    expect(done.cacheControl).toBe(NO_STORE);
    expect(done.cdn).toBe("no-store");
    expect(done.vary).toBe("Cookie, Cookie");

    expect(consoleError).toHaveBeenCalled();
  });

  it("leaves an ordinary cacheable page exactly as it was", async () => {
    // The control. /about-us/ never had a noStore mount and is one of
    // pageCacheControl.ts's WEEKLY_PAGES, so it pins that this change moved
    // /flag/ specifically rather than perturbing the middleware chain -- and
    // that /flag/'s new TTL really is the DAY fallthrough and not whatever
    // every page happens to get.
    expect(await headers("/about-us/")).toEqual({
      status: 200,
      cacheControl: "public, max-age=300, s-maxage=604800",
      cdn: null,
      vary: null,
    });
  });
});

// ISSUE #32. The same mount list, from the other direction: what it must cover
// that it did not.
//
// GET /needs/at/<slug>/updates/confirm/ and .../unsubscribe/ MUTATE -- they
// confirm a subscriber row and send a "thank you" mail, or delete the row --
// and index.ts has mounted noStore on them since 2026-09-02 for exactly that
// reason. index.ts registers the SAME handler under /cy/, /ga/ and /gd/, and
// Hono matches app.use() against the path AS IT ARRIVES: resolveLanguage is a
// middleware, so it runs after the router has already chosen handlers and
// cannot strip the prefix in time. So "/needs/at/*/updates/*" missed the
// prefixed forms entirely.
//
// The result was worse than a missing header. pageCacheControl is mounted on
// "*" and its "never override" guard only skips a response that ALREADY
// carries Cache-Control, so with noStore absent it filled the gap and stamped
// `public, max-age=300, s-maxage=86400` on a mutating GET whose URL carries a
// per-subscriber capability key -- and wrangler.jsonc enables the Workers
// Cache, where a HIT is served WITHOUT EXECUTING THE WORKER. An unsubscribe
// answered from that cache tells the visitor it worked while the row survives.
// The first test in the file above is the live proof that the gap-filler does
// exactly this to a prefixed 200 that has no mount (/cy/flag/).
//
// Latent when found -- every link the site emits for these actions is
// unprefixed, and the language switcher's prefixed variants drop the query
// string, so they 404/403 rather than reaching a cacheable 200. Nothing
// STRUCTURAL held that in place, which is why the mount is the fix rather than
// the link-building.
describe("noStore mounts: the locale-prefixed subscriber routes (issue #32)", () => {
  // DRIVEN OFF PREFIXES, NEVER A LITERAL ["cy","ga","gd"]. index.ts builds
  // both the prefixed ROUTES and (now) the prefixed MOUNTS from this one set,
  // so a fourth language cannot add a fourth uncovered URL without this loop
  // growing to check it. The size guard is not ceremony: a `for...of` over an
  // empty set passes every assertion inside it, so a refactor that emptied
  // PREFIXES would turn this whole block green and meaningless.
  const prefixes = [...PREFIXES];

  it("has at least one prefix to test", () => {
    expect(prefixes.length).toBeGreaterThan(0);
  });

  it("stamps no-store on every locale form of every updates action", async () => {
    // 500, not 200: these need D1 and the test env has no binding, so the
    // handler throws and app.onError renders the error page. noStore runs on
    // the way OUT and stamps it regardless -- which is the whole reason the
    // sibling test above can reach the unprefixed mounts at all, and is a
    // stronger check than a 200 would be, because pageCacheControl bails on a
    // non-200 and therefore contributes NOTHING here. Before the fix these
    // three headers were all null on a 500 and `public, max-age=300,
    // s-maxage=86400` on a 200; the only thing that can put NO_STORE on this
    // response is the mount actually matching.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    // TRAILING SLASHES AND THE QUERY STRING ARE BOTH LOAD-BEARING and both
    // appear here as they appear in the wild. Hono matches "/x" and "/x/" as
    // different paths -- index.ts says so in its own comment about /flag -- so
    // a mount written without the slash-swallowing "*" would fail open,
    // silently. The ?key= is the per-subscriber capability key from the issue's
    // reproduction: it is what makes a cached copy of this page a leak as well
    // as a lost mutation, and it must not affect which mount matches.
    const paths = prefixes.flatMap((locale) => [
      `/${locale}/needs/at/sid-valley/updates/confirm/?key=SUBKEY`,
      `/${locale}/needs/at/sid-valley/updates/unsubscribe/?key=UNSUBKEY`,
      `/${locale}/needs/at/sid-valley/updates/subscribe/`,
    ]);

    for (const path of paths) {
      expect(await headers(path), path).toEqual({
        status: 500,
        cacheControl: NO_STORE,
        cdn: "no-store",
        // EXACTLY "Cookie", not "Cookie, Cookie". The doubling pinned in the
        // test above is what two overlapping mounts look like; one value here
        // proves the prefixed URL is matched by its own mount only, and that
        // adding it did not widen the unprefixed one to reach across a locale.
        vary: "Cookie",
      });
    }

    expect(consoleError).toHaveBeenCalled();
  });

  it("gives the prefixed forms byte-identical headers to the unprefixed one", async () => {
    // The parity statement the issue is actually about. Not "the prefixed URLs
    // have some cache header" but "the /cy/ URL and the / URL of the same
    // mutating handler are told the same thing", which is the property that
    // stops a locale-aware confirm mail -- the obvious next step for a site
    // shipping three non-English locales -- from turning this back into the
    // incident noStore.ts was written for.
    vi.spyOn(console, "error").mockImplementation(() => {});

    // BOTH METHODS. index.ts registers .get() AND .post() for these routes,
    // and the POST is not a duplicate of the GET: it is the RFC 8058
    // one-click unsubscribe an email client fires by itself, the one branch
    // in routes/wfbn/updates.ts that deletes the row and then returns a bare
    // 200 with no body at all. `app.use()` is method-agnostic in Hono, so a
    // single mount covers both today -- this row is what fails if the mount
    // is ever narrowed to `app.on("GET", ...)`, which would leave the
    // unattended, no-human-in-the-loop request as the uncovered one.
    for (const method of ["GET", "POST"]) {
      const control = await headers("/needs/at/sid-valley/updates/unsubscribe/?key=UNSUBKEY", method);
      expect(control.cacheControl, method).toBe(NO_STORE);

      for (const locale of prefixes) {
        const h = await headers(`/${locale}/needs/at/sid-valley/updates/unsubscribe/?key=UNSUBKEY`, method);
        expect(h, `${method} ${locale}`).toEqual(control);
      }
    }
  });

  it("does not cover a path segment that merely looks like a locale", async () => {
    // /de/ is one of the 17 Django languages this Worker does NOT serve
    // (resolveLanguage.ts: no prefix match => "en"), so no route is registered
    // under it and it 404s. This row exists to kill the lazy version of the
    // fix -- a mount written as "/:locale/needs/at/*/updates/*", or with a
    // "[a-z]{2}" character class, would match here too. It has to be PREFIXES
    // or it is not derived from anything.
    for (const path of [
      "/de/needs/at/sid-valley/updates/unsubscribe/?key=UNSUBKEY",
      "/en/needs/at/sid-valley/updates/unsubscribe/?key=UNSUBKEY",
    ]) {
      const h = await headers(path);
      expect(h.status, path).toBe(404);
      expect(h.cdn, path).toBeNull();
    }
  });

  it("does not widen to the rest of a locale's food bank pages", async () => {
    // THE COST HALF, and the reason the mount stops at "/updates/*". Issue #40
    // is the cautionary tale in the other direction: a noStore mount left on
    // /flag/ held 16.94% of the zone's 200s at cf-cache-status BYPASS. A
    // prefixed mount that crept up to "/<locale>/needs/at/*" would do the same
    // to every Welsh, Irish and Gaelic food bank page -- the most-requested
    // HTML on the site. These paths need D1 too, so they 500 and
    // pageCacheControl (200-only) leaves them alone; the assertion is that
    // NOTHING stamped them, which is only true if the mount is narrow.
    vi.spyOn(console, "error").mockImplementation(() => {});

    const paths = prefixes.flatMap((locale) => [
      `/${locale}/needs/at/sid-valley/`,
      `/${locale}/needs/at/sid-valley/news/`,
      `/${locale}/needs/at/sid-valley/locations/`,
    ]);

    for (const path of paths) {
      expect(await headers(path), path).toEqual({
        status: 500,
        cacheControl: null,
        cdn: null,
        vary: null,
      });
    }
  });
});
