import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./index";
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

async function headers(path: string) {
  const res = await app.request(url(path), {}, env);
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
