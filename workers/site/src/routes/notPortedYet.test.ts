import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { ExecutionContext } from "hono";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../index";
import { tryAppendSlashRedirect } from "../lib/appendSlash";
import type { AppEnv } from "../types";
import { gone, notPortedPath, notPortedSubtree } from "./notPortedYet";

// routes/notPortedYet.ts -- the three ways this port says "there is nothing
// here": 501 for one path (notPortedPath), 501 for a subtree
// (notPortedSubtree), and a real 404 for a subtree that is never coming
// (gone(), mounted at /dumps in index.ts:658).
//
// WHY THIS FILE EXISTS. Everything in this module is three lines long and
// none of it renders anything, which makes it look like there is nothing to
// get wrong. What is actually encoded here is a STATUS CODE POLICY, and every
// past bug in it was invisible on the page:
//
//   * 501 vs 404 is a live-domain decision, not a stylistic one. A crawler
//     reads 501 as "the server is broken, come back later" and keeps
//     retrying; 404 tells it the page is gone and to stop. index.ts once had
//     three catch-all mounts (over /needs, /api and /) answering 501, so
//     every misspelled URL on the site claimed the site was unbuilt. That is
//     the mistake the module header is written against, and the reason the
//     "nothing answers 501 any more" test below drives the REAL app rather
//     than a copy of it.
//   * an `app.all("*")` mount is a MATCHED route as far as Hono's router is
//     concerned, so it pre-empts app.notFound() -- and with it the whole of
//     Django's APPEND_SLASH (givefood/givefood2#3). Every ported page on the
//     site requested without its trailing slash answered "not ported yet".
//     notPortedSubtree() is still exactly that shape, so the trap is pinned
//     below rather than assumed gone.
//   * gone() answers by DELEGATING (`c.notFound()`), which is what makes
//     /dumps/... serve the site's real 404 page -- rendered through the same
//     Nunjucks pipeline as everything else -- instead of Hono's bare
//     "404 Not Found" string. A "simplification" to c.text(..., 404)
//     keeps the status and loses the page, and nothing about the status code
//     would reveal it.
//
// gfdumps is the real thing behind gone(): Django mounts it at
// `path('dumps/', include('gfdumps.urls', namespace="dumps"))`
// (foodcharity givefood/urls.py:99) with five URL patterns under it --
// dump_index, dump_type, dump_format, dump_latest and dump_serve
// (gfdumps/urls.py, read 2026-09-08). PLAN.md §8.8's maintainer decision
// dropped the lot, so all five must 404 here; they are each requested below
// rather than one representative path, because a subtree mount that stopped
// covering deeper paths would still answer for the shallow one.
//
// REAL EVERYTHING. gone() is exercised through the app from ../index -- the
// real router, the real middleware chain, the real render404() -- because the
// interesting half of gone() is what the HOST app does with the c.notFound()
// it delegates to, which a hand-built parent would not reproduce. The other
// two exports are mounted into a real Hono<AppEnv> the way index.ts's own
// comment says to mount them (exact paths, plus the real
// tryAppendSlashRedirect in notFound), since -- deliberately -- nothing in
// index.ts calls them today.
//
// MUTATION-TESTED, in a clone of the repo outside it, against nine mutants:
// 501->404; the message with "(see PLAN.md)" dropped; `what` hardcoded;
// notPortedSubtree's all() weakened to get(); its "*" narrowed so the bare
// mount point falls through; gone() answering c.text("Not Found", 404)
// itself; gone() returning an empty Hono; index.ts's /dumps mount deleted;
// and /dumps swapped to notPortedSubtree("dumps"). Every one of them turns
// this file red -- the last three by exactly one or two tests each, which is
// why those tests are worded the way they are.

const ORIGIN = "https://www.givefood.org.uk";

type Bindable = null | number | bigint | string | Uint8Array;

// Records every statement the real app prepares while answering. The /dumps
// subtree is the single cheapest thing this Worker can serve -- a matched
// route that immediately delegates to a template render -- and "costs no D1
// read" is a property worth holding: these are dead URLs that crawlers and
// old API clients will keep asking for for years. Backed by a real SQLite so
// that a query which DOES appear runs rather than silently returning nothing.
function d1Session(db: DatabaseSync, prepared: string[]): D1DatabaseSession {
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
      prepared.push(sql);
      return statement(sql, []);
    },
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

// Nothing under /dumps reads the database, so the schema only has to be real
// enough that an unexpected query fails as a query rather than as a missing
// table. Still schemaFor() rather than hand-written DDL: hand-built fixtures
// drift from the real migrations, which is the whole reason that helper
// exists, and "the fixture was wrong" is a bad way to discover that a route
// started querying.
const SCHEMA = schemaFor("foodbank");

let db: DatabaseSync;
let prepared: string[];

function env(): AppEnv["Bindings"] {
  return {
    DB: { withSession: () => d1Session(db, prepared) },
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: { get: async () => null, put: async () => {}, delete: async () => {} },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  prepared = [];
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

// `async`, not a bare arrow: app.fetch is typed Response | Promise<Response>.
const req = async (path: string, method = "GET"): Promise<Response> =>
  app.fetch(new Request(`${ORIGIN}${path}`, { method }), env(), execCtx);

/**
 * Mounts the two 501 helpers into a real Hono<AppEnv> shaped like index.ts:
 * some genuinely-ported routes, and a notFound() that calls the real
 * tryAppendSlashRedirect against the same router. The redirect probe is not
 * decoration -- it is how a 501 becomes visible to a slashless URL, and it is
 * what the historical shadowing bug was measured on.
 */
function harness(register: (h: Hono<AppEnv>) => void) {
  const h = new Hono<AppEnv>();
  h.get("/about-us/", (c) => c.text("about us"));
  register(h);
  h.notFound(async (c) => (await tryAppendSlashRedirect(c, h)) ?? c.text("the real 404 page", 404));
  return {
    fetch: (path: string, method = "GET") => h.fetch(new Request(`${ORIGIN}${path}`, { method }), env(), execCtx),
  };
}

// ---------------------------------------------------------------------------
// notPortedPath -- one handler, one exact path, 501
// ---------------------------------------------------------------------------

describe("notPortedPath", () => {
  it("answers 501 with a plain-text message naming the feature and PLAN.md", async () => {
    // The body is the ONLY place anyone learns which feature is missing -- a
    // 501 with a generic body sends the next maintainer to the logs. The
    // exact string is asserted (not a /not ported/ match) because it is what
    // a human reads out of curl, and text/plain is asserted because a 501
    // that arrived as HTML would mean someone had turned this into a page,
    // which is the beginning of it being linked to.
    const h = harness((a) => a.all("/unbuilt/", notPortedPath("the offline needs page")));
    const res = await h.fetch("/unbuilt/");

    expect(res.status).toBe(501);
    expect(await res.text()).toBe("givefood: the offline needs page is not ported yet (see PLAN.md)");
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=UTF-8");
  });

  it("carries each call's own `what`, so two gaps never report each other's name", async () => {
    // The factory closes over its argument; a refactor to a module-level
    // "current gap" string would pass a single-mount test and mislabel every
    // page the moment a second gap existed. Two mounts, two names, in one app.
    const h = harness((a) => {
      a.all("/one/", notPortedPath("feature one"));
      a.all("/two/", notPortedPath("feature two"));
    });

    expect(await (await h.fetch("/one/")).text()).toBe("givefood: feature one is not ported yet (see PLAN.md)");
    expect(await (await h.fetch("/two/")).text()).toBe("givefood: feature two is not ported yet (see PLAN.md)");
  });

  it("answers on every method, not just GET", async () => {
    // Call sites register it with app.all() (see notPortedSubtree, which does
    // exactly that), and an unbuilt endpoint that 501s a GET but 404s a POST
    // would tell an API client the resource does not exist rather than that
    // the server has not implemented it -- the difference between "stop" and
    // "try again after the next deploy".
    const h = harness((a) => a.all("/unbuilt/", notPortedPath("x")));

    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect((await h.fetch("/unbuilt/", method)).status, `${method} /unbuilt/`).toBe(501);
    }
  });

  it("covers the exact path only, and nothing beneath it", async () => {
    // THE POINT OF THE 2026-09-05 REWRITE. The helper used to be mounted as a
    // subtree, which meant every nonexistent URL under the prefix claimed to
    // be "not built yet". Registered as an exact path, a child URL that
    // exists in neither codebase gets the truthful 404.
    const h = harness((a) => a.all("/unbuilt/", notPortedPath("x")));

    expect((await h.fetch("/unbuilt/")).status).toBe(501);
    const child = await h.fetch("/unbuilt/child/");
    expect(child.status).toBe(404);
    expect(await child.text()).toBe("the real 404 page");
  });

  it("does not shadow a ported route requested without its trailing slash", async () => {
    // givefood/givefood2#3, from the other side. Because this registers ONE
    // path rather than a catch-all, app.notFound() still runs for everything
    // else and Django's APPEND_SLASH survives -- /about-us still 301s while
    // /unbuilt/ 501s in the same app.
    const h = harness((a) => a.all("/unbuilt/", notPortedPath("x")));
    const res = await h.fetch("/about-us");

    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/about-us/`);
  });

  it("is never redirected into: a slashless URL whose twin is 501 stays a 404", async () => {
    // lib/appendSlash.ts:28 suppresses on 404 AND 501 for this exact case. If
    // it did not, /unbuilt would 301 to /unbuilt/ and land the visitor (or
    // crawler) on "not ported yet" -- a permanent redirect pointing at a
    // "server is broken" status, which is worse than either answer alone.
    // The 501 the suppression sees comes from a HEAD probe, not a GET, so
    // this is also the one place the handler is exercised under HEAD.
    // (Verified in this hono, 4.13.7: a GET-only route answers HEAD too, with
    // the body stripped -- so HEAD coverage is not what is at stake here, the
    // status is.)
    const h = harness((a) => a.all("/unbuilt/", notPortedPath("x")));
    const res = await h.fetch("/unbuilt");

    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toBe("the real 404 page");
  });
});

// ---------------------------------------------------------------------------
// notPortedSubtree -- the same 501 over a whole prefix
// ---------------------------------------------------------------------------

describe("notPortedSubtree", () => {
  it("answers the mount point itself as well as every path under it", async () => {
    // The bare mount point is the half that is easy to lose: Hono matches a
    // sub-app's "*" against the prefix WITH and WITHOUT further segments, and
    // index.ts:654-657 relies on exactly that ("matching the bare mount path
    // too, not just subpaths") when it uses this shape for /dumps. A version
    // that only covered subpaths would leave the front door of an unbuilt
    // feature falling through to the 404 page.
    const h = harness((a) => a.route("/gap", notPortedSubtree("the gap")));

    for (const path of ["/gap", "/gap/", "/gap/deep/", "/gap/deeper/still/and/further/"]) {
      const res = await h.fetch(path);
      expect(res.status, path).toBe(501);
      expect(await res.text(), path).toBe("givefood: the gap is not ported yet (see PLAN.md)");
    }
  });

  it("answers on every method across the subtree", async () => {
    const h = harness((a) => a.route("/gap", notPortedSubtree("the gap")));

    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect((await h.fetch("/gap/anything/", method)).status, `${method} /gap/anything/`).toBe(501);
    }
  });

  it("stops at the segment boundary rather than swallowing a lookalike prefix", async () => {
    // "/gap" is a path segment, not a string prefix: a sibling route whose
    // name merely starts with the same characters must be untouched. Seeded
    // as a real route so the assertion is "the sibling still answers", not
    // just "something 404s".
    const h = harness((a) => {
      a.route("/gap", notPortedSubtree("the gap"));
      a.get("/gapless/", (c) => c.text("a real page"));
    });

    expect((await h.fetch("/gap/x/")).status).toBe(501);
    const sibling = await h.fetch("/gapless/");
    expect(sibling.status).toBe(200);
    expect(await sibling.text()).toBe("a real page");
  });

  it("returns a fresh sub-app per call, so two subtrees keep their own names", async () => {
    // A module-level `const app` reused by every call would answer both
    // mounts with whichever name was passed last -- and the failure is a
    // wrong word in a message, which no status-code test would catch.
    const h = harness((a) => {
      a.route("/alpha", notPortedSubtree("alpha"));
      a.route("/beta", notPortedSubtree("beta"));
    });

    expect(await (await h.fetch("/alpha/x/")).text()).toBe("givefood: alpha is not ported yet (see PLAN.md)");
    expect(await (await h.fetch("/beta/x/")).text()).toBe("givefood: beta is not ported yet (see PLAN.md)");
  });

  it("SHADOWS APPEND_SLASH when mounted broadly -- the trap that removed it from index.ts", async () => {
    // givefood/givefood2#3, reproduced with the real helper. This module's
    // own header describes the shape index.ts used to carry -- "a
    // `notPortedYet()` that mounted `app.all("*")` over a whole prefix --
    // including `/`, the entire site" -- and notPortedSubtree() is still that
    // shape, so mounting it at "/" reproduces the bug exactly. The catch-all
    // is a MATCHED route, so app.notFound() -- and therefore
    // tryAppendSlashRedirect -- never runs, and a perfectly real, ported page
    // requested without its trailing slash answers "not ported yet" instead
    // of 301'ing to itself. This is CURRENT behaviour of this helper, pinned
    // so that the next person tempted to mount it over a broad prefix finds
    // the cost written down rather than discovering it on the live domain.
    const h = harness((a) => a.route("/", notPortedSubtree("the site")));
    const res = await h.fetch("/about-us");

    expect(res.status).toBe(501);
    expect(res.headers.get("location")).toBeNull();
    // The slashed form still works, which is what made this so hard to see:
    // the site looked fine to anyone typing URLs correctly.
    expect((await h.fetch("/about-us/")).status).toBe(200);
  });

  it("answers a slashless URL inside itself directly, with no APPEND_SLASH redirect", async () => {
    // The shadowing above, contained to the prefix it is mounted on: within
    // the subtree the catch-all matches everything, so app.notFound() -- and
    // tryAppendSlashRedirect with it -- never runs, and /gap/deep answers 501
    // rather than 301'ing to /gap/deep/. Harmless while the subtree really is
    // unbuilt (there is no page to redirect to), and it is exactly this
    // property that stops being harmless the moment the mount covers ported
    // routes, which is why notPortedPath() is the one to prefer.
    const h = harness((a) => a.route("/gap", notPortedSubtree("the gap")));
    const res = await h.fetch("/gap/deep");

    expect(res.status).toBe(501);
    expect(res.headers.get("location")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// gone -- the permanent 404, mounted at /dumps by the real app
// ---------------------------------------------------------------------------

describe("gone", () => {
  it("serves the site's real 404 page for /dumps/, not a bare status", async () => {
    // What a visitor following a years-old /dumps/ bookmark actually gets:
    // the site's own 404 page, with its links back into the site, because
    // `c.notFound()` hands the request to index.ts's notFound handler and
    // that renders 404.njk through the same Nunjucks pipeline as every other
    // page. Replace it with c.text("Not Found", 404) -- an obvious-looking
    // simplification -- and the status is identical while the page becomes a
    // bare string. (This body is also what an UNMOUNTED /dumps would produce,
    // by falling through to the same handler; the two tests below are the
    // ones that distinguish gone() from nothing at all.)
    const res = await req("/dumps/");
    const html = await res.text();

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(html).toContain("<h1>404 - Not Found</h1>");
    expect(html).toContain('<li><a href="/needs/">Find what food banks need</a></li>');
  });

  it("404s all five of Django's gfdumps URLs", async () => {
    // gfdumps/urls.py (read in the foodcharity checkout 2026-09-08): "",
    // "<dump_type>/", "<dump_type>/<dump_format>/",
    // "<dump_type>/<dump_format>/latest/" and
    // "<dump_type>/<dump_format>/<year>-<month>-<day>/". Every one of them was
    // a live URL on givefood.org.uk, so every one of them is what an old
    // client or a crawler still asks for. Depth is the assertion: a mount that
    // stopped covering the subtree would still answer the first two.
    const paths = [
      "/dumps/",
      "/dumps/foodbanks/",
      "/dumps/foodbanks/json/",
      "/dumps/foodbanks/json/latest/",
      "/dumps/foodbanks/json/2026-09-08/",
    ];

    for (const path of paths) {
      const res = await req(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toContain("<h1>404 - Not Found</h1>");
    }
  });

  it("is a 404 and emphatically not the 501 its neighbours in this file produce", async () => {
    // The whole reason gone() exists rather than notPortedSubtree("dumps").
    // PLAN.md §8.8's maintainer decision (2026-09-02) dropped gfdumps
    // permanently -- the Container-based generation cron and the R2-served
    // download pages both -- so "not ported yet" would be a promise nobody
    // intends to keep, and would keep crawlers retrying a dead subtree
    // indefinitely.
    const res = await req("/dumps/foodbanks/json/latest/");

    expect(res.status).not.toBe(501);
    expect(await res.text()).not.toContain("not ported yet");
    // AND NOT 410 EITHER, despite the function's name. HTTP has a status that
    // means precisely "this existed and is permanently gone", and these URLs
    // are the textbook case for it, but gone() answers 404 -- its own comment
    // says "a real 404 rather than the 501" and index.ts:653 agrees. Pinned
    // because a neighbouring comment already believes otherwise
    // (lib/appendSlash.test.ts calls /dumps "every other 410"), so the next
    // reader has one assertion that settles which it is.
    expect(res.status).toBe(404);
  });

  it("answers every method, so a POST to a dead dump URL 404s rather than 405s", async () => {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      expect((await req("/dumps/foodbanks/json/", method)).status, method).toBe(404);
    }
  });

  it("never 301s a slashless dump URL into the subtree", async () => {
    // The interesting consequence of gone() delegating: index.ts's notFound
    // probes for the slashed twin, the twin is ALSO handled by gone() and
    // also 404s, so lib/appendSlash suppresses the redirect. /dumps and
    // /dumps/foodbanks therefore terminate immediately instead of sending a
    // crawler a 301 that lands on a 404 -- one dead response instead of two.
    for (const path of ["/dumps", "/dumps/foodbanks", "/dumps/foodbanks/json/latest"]) {
      const res = await req(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("location"), path).toBeNull();
    }
  });

  it("costs no database query, however deep the URL", async () => {
    // These are dead URLs that will be requested for years. A matched route
    // that delegates straight to a template render is the cheapest thing this
    // Worker can serve, and it should stay that way -- a stray D1 read here
    // would be paid for by crawler traffic nobody is watching.
    await req("/dumps/foodbanks/json/2026-09-08/");

    expect(prepared).toEqual([]);
  });

  it("delegates to the host app's notFound handler rather than answering itself", async () => {
    // Stated as a property rather than inferred from the rendered page: the
    // handler must produce whatever 404 the app it is mounted in produces. A
    // custom notFound with a distinctive body is the only way to tell
    // "delegated" from "returned its own 404" -- both are status 404.
    const host = new Hono<AppEnv>();
    let notFoundCalls = 0;
    host.route("/dumps", gone());
    host.notFound((c) => {
      notFoundCalls += 1;
      return c.text("HOST 404", 404);
    });

    const res = await host.fetch(new Request(`${ORIGIN}/dumps/foodbanks/json/`), env(), execCtx);

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("HOST 404");
    expect(notFoundCalls).toBe(1);
  });

  it("claims the whole subtree, so a route added under it later cannot revive a dump URL", async () => {
    // gone() is a sub-app with a catch-all, not an empty app, and this is the
    // only test that can tell those two apart: both 404 for every URL that
    // nothing else handles. Hono runs matching handlers in registration
    // order, so the catch-all answers and the later route never runs. That
    // difference is the whole reason index.ts:654-657 chose a `.route()` +
    // catch-everything sub-app over a list of paths -- the subtree is gone,
    // not named parts of it, and a future /dumps/... route should be a
    // deliberate act rather than something that quietly starts serving.
    const host = new Hono<AppEnv>();
    host.route("/dumps", gone());
    host.get("/dumps/foodbanks/json/", (c) => c.text("a revived dump endpoint"));
    host.notFound((c) => c.text("HOST 404", 404));

    const res = await host.fetch(new Request(`${ORIGIN}/dumps/foodbanks/json/`), env(), execCtx);

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("HOST 404");
  });

  it("is really mounted at /dumps by index.ts", async () => {
    // The one thing about the mount that a request cannot reveal: delete
    // `app.route("/dumps", gone())` from index.ts and every test above still
    // passes, because an unmounted /dumps falls through to the same 404 page.
    // The mount earns its place through the claim tested above, so the
    // registration itself is asserted directly -- one ALL route at /dumps/*,
    // which is what Hono's route() turns `app.all("*")` on a "/dumps" mount
    // into.
    const mounts = app.routes.filter((r) => r.path === "/dumps/*");

    expect(mounts.map((r) => r.method)).toEqual(["ALL"]);
  });

  it("returns a fresh sub-app per call", async () => {
    // Same reasoning as notPortedSubtree's: mounting the same instance at two
    // prefixes would double-register its routes on one router.
    expect(gone()).not.toBe(gone());
  });
});

// ---------------------------------------------------------------------------
// The claim in this module's own header: nothing answers 501 today
// ---------------------------------------------------------------------------

describe("the real app's 501 surface", () => {
  it("answers 404, never 501, for nonexistent URLs under the old catch-all prefixes", async () => {
    // notPortedYet.ts's header says it plainly: "as of 2026-09-05 the public
    // URL surface is fully ported or deliberately out of scope, so index.ts
    // has no 501s left at all". This test is what keeps that true. The three
    // prefixes below are the three catch-alls that used to exist (/needs,
    // /api and /), and each path is a URL that exists in NEITHER codebase --
    // exactly the traffic the catch-alls were mislabelling as "unbuilt" while
    // crawlers retried it.
    const paths = ["/no-such-page/", "/needs/no-such-thing/", "/api/no-such-endpoint/", "/api/2/no-such-endpoint/", "/dumps/"];

    for (const path of paths) {
      const res = await req(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toContain("<h1>404 - Not Found</h1>");
    }
  });
});
