import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../types";
import { securityHeaders } from "./securityHeaders";

// This middleware is the whole of what survives of
// django.middleware.security.SecurityMiddleware, which sits FIRST in
// settings.py's MIDDLEWARE list and so runs on the way out of every single
// response Django produces. index.ts:113 mounts it the same way --
// `app.use("*", securityHeaders)`, second only to serverTiming -- so "on
// every response" is the contract, not "on pages".
//
// The module was written after a beta-vs-production header diff on
// 2026-09-05 found both headers missing. These tests are the shape of that
// diff, frozen.
//
// A note on what "boundaries" mean for this module, because it looks
// untestable at first glance: securityHeaders takes NO input. It has no
// arguments, no config, no request-derived values -- it writes two constants.
// So there is no empty-string/null/NaN surface to probe; the entire input
// space is the SHAPE OF THE RESPONSE the handler below it produced, and the
// SHAPE OF THE MIDDLEWARE CHAIN it sits in. That is what is enumerated here:
// bodyless responses, 304s, redirects, thrown errors, immutable responses,
// responses that already carry the same headers, responses carrying multiple
// Set-Cookie lines, sub-apps, double mounts, and neighbours that run before
// and after it. Anything that only asserts the two constants is a tautology
// dressed as a test; the tests below are written to fail against a plausible
// wrong implementation, and each one names the wrong implementation it kills.
const env = {} as unknown as AppEnv["Bindings"];

// The mounting index.ts uses. Every test builds a real Hono app rather than a
// fake Context, because the two behaviours most likely to regress here --
// running post-response, and being beaten or not beaten by other middleware
// -- only exist inside Hono's onion, not in the handler in isolation.
function mounted(register: (app: Hono<AppEnv>) => void): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", securityHeaders);
  register(app);
  return app;
}

describe("securityHeaders", () => {
  it("sends SecurityMiddleware's two always-on defaults, with Django's exact values", async () => {
    // django/middleware/security.py process_response(), driven by
    // global_settings.py's SECURE_CONTENT_TYPE_NOSNIFF = True and
    // SECURE_REFERRER_POLICY = "same-origin". Not "no-referrer", not
    // "strict-origin-when-cross-origin" -- production sends literally
    // `same-origin`, and the site's outbound referrer behaviour to food bank
    // websites depends on it.
    const app = mounted((a) => a.get("/", (c) => c.html("<p>home</p>")));
    const res = await app.request("https://x/", {}, env);

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    // Exactly one line each. `.get()` joins duplicates with ", ", so an
    // implementation that used append() rather than set() would still satisfy
    // a naive .toContain("nosniff") -- and "nosniff, nosniff" is not a value
    // any scanner accepts.
    expect([...res.headers].filter(([k]) => k === "x-content-type-options")).toHaveLength(1);
    expect([...res.headers].filter(([k]) => k === "referrer-policy")).toHaveLength(1);
  });

  it("covers every response kind, not just rendered pages", async () => {
    // SecurityMiddleware is the outermost entry in MIDDLEWARE, so in Django
    // these headers are on the 404 page, the API JSON, the slug redirect and
    // the error page alike. A port that only decorated HTML would look fine in
    // a browser and still hand a scanner a bare 404. This is the test that
    // kills a `if (c.res.headers.get("Content-Type")?.startsWith("text/html"))`
    // guard, and the bodyless cases (204, 304) kill an
    // `if (c.res.body)` guard -- both are tempting "optimisations".
    //
    // The 500 case matters most: Hono catches a handler throw inside compose()
    // and assigns the error response to c.res, so `await next()` RESOLVES
    // rather than rejecting, and the headers land on the error response too.
    const app = mounted((a) => {
      a.get("/", (c) => c.html("<p>home</p>"));
      a.get("/api", (c) => c.json({ ok: true }));
      a.get("/old", (c) => c.redirect("/", 302)); // as slugRedirect produces
      a.get("/png", () => new Response("bytes", { status: 200, headers: { "Content-Type": "image/png" } }));
      a.get("/empty", (c) => c.body(null, 204)); // bodyless: still a response
      a.get("/nm", (c) => c.body(null, 304)); // conditional GET, also bodyless
      a.get("/boom", () => {
        throw new Error("kaboom");
      });
      a.post("/write", (c) => c.text("posted"));
      a.notFound((c) => c.html("<p>nope</p>", 404));
    });

    const cases: [string, RequestInit, number][] = [
      ["https://x/", {}, 200],
      ["https://x/api", {}, 200],
      ["https://x/old", {}, 302],
      ["https://x/png", {}, 200],
      ["https://x/empty", {}, 204],
      ["https://x/nm", {}, 304],
      ["https://x/boom", {}, 500],
      ["https://x/write", { method: "POST" }, 200],
      ["https://x/missing/", {}, 404],
      ["https://x/", { method: "HEAD" }, 200],
      ["https://x/cy/", {}, 404], // a language-prefixed path, mounted on "*" too
    ];

    for (const [url, init, status] of cases) {
      const res = await app.request(url, init, env);
      const method = init.method ?? "GET";
      expect([url, method, res.status]).toEqual([url, method, status]);
      expect([url, res.headers.get("X-Content-Type-Options")]).toEqual([url, "nosniff"]);
      expect([url, res.headers.get("Referrer-Policy")]).toEqual([url, "same-origin"]);
    }

    // HEAD is dispatched by Hono as a GET whose body is then discarded
    // (hono-base #dispatch: `new Response(null, await dispatch(..., "GET"))`).
    // Asserting the empty body proves the headers were carried across that
    // re-wrap rather than the HEAD case quietly running some other path.
    const head = await app.request("https://x/", { method: "HEAD" }, env);
    expect(await head.text()).toBe("");
    expect(head.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("sets the headers AFTER next(), which only a chain-order probe can prove", async () => {
    // The single most plausible regression: someone reads the two `set` calls,
    // decides post-response middleware is confusing, and hoists them above
    // `await next()`.
    //
    // BEWARE THE OBVIOUS TEST HERE. The intuitive way to catch that is a route
    // returning its own `new Response(...)` (media.ts, favicon.ts and
    // screenshot.ts all do), on the theory that it replaces c.res wholesale and
    // a hoisted `set` would be lost. THAT IS FALSE, and this test used to
    // assert it. Hono's `set res` (context.js:119-139) copies every header
    // already on the old c.res onto the incoming response -- so a hoisted
    // version passes the raw-Response test identically. Verified by running
    // both variants; the raw-Response route discriminates nothing.
    //
    // What actually discriminates is WHEN the header exists. Hono unwinds
    // post-response middleware in reverse registration order, so a middleware
    // registered BELOW securityHeaders reaches its own post-next() code first
    // -- and at that instant the header must not exist yet. A hoisted version
    // records "nosniff" here; the real one records null.
    const observedMidUnwind: (string | null)[] = [];
    const app = new Hono<AppEnv>();
    app.use("*", securityHeaders);
    app.use("*", async (c, next) => {
      await next();
      observedMidUnwind.push(c.res.headers.get("X-Content-Type-Options"));
    });
    app.get("/media/x.png", () => new Response("bytes", { status: 200, headers: { "Content-Type": "image/png" } }));

    const res = await app.request("https://x/media/x.png", {}, env);

    expect(observedMidUnwind).toEqual([null]); // hoisted => ["nosniff"]
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    // ...and the handler's own raw Response really is the one that came back,
    // unmodified apart from the two headers.
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(await res.text()).toBe("bytes");
  });

  it("adds ONLY those two headers -- no HSTS, no CSP, no X-Frame-Options, no COOP", async () => {
    // The module comment's load-bearing claim: production sends no HSTS and no
    // CSP, and XFrameOptionsMiddleware is not in settings.py's MIDDLEWARE, so
    // adding any of them here would be a behaviour change smuggled in as a
    // port. Diffing against an identical app with no middleware is the only way
    // to state "and nothing else" precisely; a list of toBeNull() calls can
    // only ever cover headers we thought of.
    //
    // The diff runs over FOUR response kinds, not just the HTML one. A version
    // that added `Content-Security-Policy: frame-ancestors 'none'` to the JSON
    // API, or X-Frame-Options only to the 404, would slip past a single-route
    // diff -- and those are exactly the shapes a well-meaning "harden the API"
    // commit takes.
    const routes = (app: Hono<AppEnv>) => {
      app.get("/", (c) => c.html("<p>home</p>"));
      app.get("/api/2/foodbanks/", (c) => c.json({ foodbanks: [] }));
      app.get("/old", (c) => c.redirect("/", 302));
      app.notFound((c) => c.html("<p>nope</p>", 404));
    };

    for (const path of ["/", "/api/2/foodbanks/", "/old", "/missing/"]) {
      const bare = new Hono<AppEnv>();
      routes(bare);
      const before = await bare.request(`https://x${path}`, {}, env);
      const after = await mounted(routes).request(`https://x${path}`, {}, env);

      const beforeNames = new Set([...before.headers.keys()]);
      const added = [...after.headers.keys()].filter((n) => !beforeNames.has(n)).sort();
      expect([path, added]).toEqual([path, ["referrer-policy", "x-content-type-options"]]);
      // ...and nothing that was already there was removed either.
      const afterNames = new Set([...after.headers.keys()]);
      expect([path, [...beforeNames].filter((n) => !afterNames.has(n))]).toEqual([path, []]);
    }

    // Named explicitly as well, because these four are what a reviewer copying
    // Django's SECURE_* defaults list would be tempted to add.
    // Cross-Origin-Opener-Policy is the interesting one: Django DOES default
    // SECURE_CROSS_ORIGIN_OPENER_POLICY to "same-origin", so SecurityMiddleware
    // would emit it -- the module deliberately went with the observed live
    // headers over the defaults list. Pinned as-is.
    const res = await mounted((a) => a.get("/", (c) => c.html("<p>home</p>"))).request("https://x/", {}, env);
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expect(res.headers.get("X-Frame-Options")).toBeNull();
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBeNull();
  });

  it("DIVERGES from Django: it overwrites values the handler already set, and collapses duplicates", async () => {
    // django/middleware/security.py uses response.headers.setdefault() for both
    // headers, so a Django view that sets its own Referrer-Policy keeps it.
    // This port uses c.res.headers.set(), which clobbers. No route in
    // workers/site sets either header today, so the divergence is currently
    // invisible -- pinned here so that whoever first needs a per-route
    // Referrer-Policy (an outbound-link page, say) discovers from a failing
    // test that this middleware will eat it, rather than from production.
    const res = await mounted((app) =>
      app.get("/", (c) => {
        // Appended twice on purpose: two Referrer-Policy lines is the state a
        // response can genuinely reach, and `set` must leave exactly one line
        // holding Django's value -- not "no-referrer, unsafe-url, same-origin",
        // which is what an append-based implementation produces and what
        // .get()-only assertions fail to notice.
        c.header("Referrer-Policy", "no-referrer", { append: true });
        c.header("Referrer-Policy", "unsafe-url", { append: true });
        c.header("X-Content-Type-Options", "off");
        return c.text("careful page");
      }),
    ).request("https://x/", {}, env);

    expect(res.headers.get("Referrer-Policy")).toBe("same-origin"); // Django would say "no-referrer"
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff"); // Django would say "off"
    expect([...res.headers].filter(([k]) => k === "referrer-policy")).toEqual([["referrer-policy", "same-origin"]]);
  });

  it("wins over any middleware registered after it", async () => {
    // Hono unwinds post-response middleware in REVERSE registration order, so
    // being registered near the top of index.ts means running LAST on the way
    // out. That is what lets cacheTag, runtimeIdentity, slugRedirect,
    // resolveLanguage, geoJsonPreload, pageCacheControl and noStore all be
    // registered below it (index.ts:114-144) without any of them being able to
    // strip or weaken these two headers on their way past.
    //
    // This is also the test that kills a `next()` without `await`: an unawaited
    // next() lets the later middleware's post-response code run after the set
    // calls instead of before them, and the weakened value survives.
    const app = new Hono<AppEnv>();
    app.use("*", securityHeaders);
    app.use("*", async (c, next) => {
      await next();
      c.res.headers.set("X-Content-Type-Options", "weakened-by-a-later-middleware");
      c.res.headers.delete("Referrer-Policy");
    });
    app.get("/", (c) => c.text("x"));

    const res = await app.request("https://x/", {}, env);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
  });

  it("does not collapse multiple Set-Cookie headers", async () => {
    // It runs on the admin sign-in response too, which sets a session cookie
    // (and, on rotation, more than one). Mutating c.res.headers is safe for
    // Set-Cookie -- but Hono's Context special-cases set-cookie when a response
    // is reassigned (context.js:126-131), and a future refactor of this
    // middleware into `c.res = new Response(...)` is exactly the shape of
    // change that silently drops all but the last cookie and logs every admin
    // out. Order and count are both asserted: getSetCookie() returning one
    // joined string, or the pair reversed, are both real failure modes.
    const res = await mounted((app) =>
      app.get("/auth/receiver", (c) => {
        c.header("Set-Cookie", "gfsession=a; Path=/; HttpOnly", { append: true });
        c.header("Set-Cookie", "gfold=; Max-Age=0; Path=/", { append: true });
        return c.text("signed in");
      }),
    ).request("https://x/auth/receiver", {}, env);

    expect(res.headers.getSetCookie()).toEqual(["gfsession=a; Path=/; HttpOnly", "gfold=; Max-Age=0; Path=/"]);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
  });

  it("leaves status, body and content-type exactly as the handler left them", async () => {
    // It is a header-adding middleware and nothing else: no rewriting, no
    // buffering, no status fiddling. A JSON API response must come back
    // byte-identical, or every /api/2 consumer sees it. The non-200 status is
    // deliberate -- an implementation that rebuilt the response as
    // `new Response(body, { headers })` would silently reset 201 to 200.
    const res = await mounted((app) => app.get("/api/2/foodbanks/", (c) => c.json({ foodbanks: [] }, 201))).request(
      "https://x/api/2/foodbanks/",
      {},
      env,
    );

    expect(res.status).toBe(201);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.text()).toBe('{"foodbanks":[]}');
  });

  it("applies to responses from a sub-app routed into the parent", async () => {
    // index.ts routes whole sub-apps in (the /api/2 app, the admin app). Those
    // are separate Hono instances with their own middleware stacks, and a
    // reader could reasonably expect the parent's `use("*")` not to reach
    // inside one. It does -- which is why the sub-apps deliberately do NOT
    // mount securityHeaders themselves, and why this must keep working or the
    // entire JSON API loses both headers at once.
    const api = new Hono<AppEnv>();
    api.get("/foodbanks/", (c) => c.json({ foodbanks: [] }));
    api.notFound((c) => c.json({ error: "not found" }, 404));

    const app = new Hono<AppEnv>();
    app.use("*", securityHeaders);
    app.route("/api/2", api);

    for (const path of ["/api/2/foodbanks/", "/api/2/nope/"]) {
      const res = await app.request(`https://x${path}`, {}, env);
      expect([path, res.headers.get("X-Content-Type-Options")]).toEqual([path, "nosniff"]);
      expect([path, res.headers.get("Referrer-Policy")]).toEqual([path, "same-origin"]);
    }
  });

  it("is safe to mount twice: setting is idempotent, never appended", async () => {
    // Header values must never become "nosniff, nosniff". index.ts mounts it
    // once today, but sub-apps are routed into the parent (see above), and a
    // second `app.use("*", securityHeaders)` inside one of them would be an
    // easy mistake to make. `set` semantics make it harmless -- an `append`
    // would not, which is why the line COUNT is asserted and not just .get().
    const app = new Hono<AppEnv>();
    app.use("*", securityHeaders);
    app.use("*", securityHeaders);
    app.get("/", (c) => c.text("x"));

    const res = await app.request("https://x/", {}, env);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    expect([...res.headers].filter(([k]) => k === "x-content-type-options")).toHaveLength(1);
    expect([...res.headers].filter(([k]) => k === "referrer-policy")).toHaveLength(1);
  });

  it("reaches index.ts's own onError 500 page, not just Hono's default one", async () => {
    // index.ts:625 registers `app.onError(async (err, c) => c.html(await
    // render500(c), 500))` -- Django's 500.html. That is a DIFFERENT path from
    // the bare Hono error response the previous test exercises, and a reader
    // could reasonably assume a custom error handler runs outside the chain and
    // therefore misses these headers. It does not: compose() invokes the error
    // handler and assigns c.res while securityHeaders is still on the stack,
    // so the rendered 500 page carries both. Worth pinning, because the 500
    // page is the one response nobody looks at until a scanner does.
    const app = new Hono<AppEnv>();
    app.use("*", securityHeaders);
    app.get("/boom", () => {
      throw new Error("kaboom");
    });
    app.onError((_err, c) => c.html("<p>Sorry, something went wrong</p>", 500));

    const res = await app.request("https://x/boom", {}, env);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("<p>Sorry, something went wrong</p>"); // the real 500 page, not Hono's
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
  });

  it("only covers routes registered BELOW it -- the index.ts mount position is load-bearing", async () => {
    // Hono composes handlers in registration order, so a route registered
    // ABOVE `app.use("*", securityHeaders)` runs without it entirely: the
    // handler returns and next() is never reached. index.ts registers all
    // 600-odd routes below line 113, so this is correct today -- and it is
    // precisely the invariant that a new `app.get(...)` added near the imports
    // (to keep it "out of the way of the big route block") would break, with no
    // other symptom than one silently unprotected URL.
    const app = new Hono<AppEnv>();
    app.get("/registered-first", (c) => c.text("early"));
    app.use("*", securityHeaders);
    app.get("/registered-after", (c) => c.text("late"));

    const early = await app.request("https://x/registered-first", {}, env);
    const late = await app.request("https://x/registered-after", {}, env);

    expect(early.headers.get("X-Content-Type-Options")).toBeNull(); // NOT protected
    expect(late.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("BUG PINNED: an immutable-headers Response turns the whole request into a bare 500", async () => {
    // c.res.headers.set() throws `TypeError: immutable` when the response the
    // handler returned has an immutable headers guard -- true of anything
    // returned straight from fetch(), from caches.default.match(), or from
    // Response.redirect(). Hono catches the throw and serves its own 500, so
    // the caller loses the real response AND both security headers.
    // Response.redirect() is used here because it is immutable by
    // specification, with no network and no Workers runtime involved.
    //
    // The damage is asserted in full rather than just the status, because the
    // failure is worse than "a 500": the Location header of the redirect the
    // handler wanted SURVIVES onto the 500, so the response is a self-
    // contradictory 500-with-a-Location that browsers render as an error page
    // while a naive client following redirects sees something else entirely.
    //
    // NOT fixed here, per the rule that tests pin current behaviour; reported
    // as a suspected bug instead. The one-word fix is `c.header(name, value)`
    // instead of `c.res.headers.set(name, value)`: Hono's c.header clones a
    // finalized response into a mutable one first (context.js:214-216). When
    // someone applies that fix, THIS test is the one that will fail, and the
    // correct response is to rewrite it to assert the 302 survives -- not to
    // revert the fix.
    const res = await mounted((app) => app.get("/go", () => Response.redirect("https://example.org/", 302))).request(
      "https://x/go",
      {},
      env,
    );

    expect(res.status).toBe(500); // not the 302 the handler returned
    expect(await res.text()).toBe("Internal Server Error"); // Hono's bare default, not render500()
    expect(res.headers.get("Location")).toBe("https://example.org/"); // leaked onto the 500
    expect(res.headers.get("X-Content-Type-Options")).toBeNull();
    expect(res.headers.get("Referrer-Policy")).toBeNull();
  });

  it("...but the deployed chain defuses that bug by accident, via resolveLanguage", async () => {
    // Why the bug above has never been seen in production. resolveLanguage is
    // mounted BELOW securityHeaders (index.ts:117) and unconditionally calls
    // `c.header("Content-Language", ...)` after its own next()
    // (resolveLanguage.ts). c.header on a finalized context replaces c.res with
    // a mutable clone -- so by the time securityHeaders runs, the immutable
    // response is gone and the set calls succeed. The redirect survives WITH
    // both headers.
    //
    // A stand-in middleware is used rather than importing resolveLanguage,
    // because this file must not fail when that module's internals change --
    // but the dependency is real and one-directional: DELETING the post-next
    // c.header call from resolveLanguage.ts (or reordering it above
    // securityHeaders) resurrects a hard 500 on every immutable response. That
    // is not a fact either module's tests would otherwise record.
    const contentLanguageShaped: MiddlewareHandler<AppEnv> = async (c, next) => {
      await next();
      c.header("Content-Language", "en");
    };

    const app = new Hono<AppEnv>();
    app.use("*", securityHeaders);
    app.use("*", contentLanguageShaped);
    app.get("/go", () => Response.redirect("https://example.org/", 302));

    const res = await app.request("https://x/go", {}, env);
    expect(res.status).toBe(302); // survives, unlike the bare-chain case above
    expect(res.headers.get("Location")).toBe("https://example.org/");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
  });
});
