import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";
import { noStore } from "./noStore";
import { requireAdminAuth } from "./adminAuth";
import { cacheTag } from "./cacheTag";
import { pageCacheControl } from "./pageCacheControl";
import { PREFIXES } from "./resolveLanguage";

// This middleware is the fix for a live data exposure, not a tidy-up: on beta
// 2026-09-02 Cloudflare was serving authenticated admin pages -- including the
// subscribers tab, which lists subscriber identifiers -- to anonymous visitors
// with `cf-cache-status: HIT`. wrangler.jsonc turns the Workers Cache on, and a
// HIT never executes the Worker, so requireAdminAuth was not bypassed: it was
// never reached. The ONLY thing standing between /admin/ and that hit today is
// the three headers this file sets.
//
// So every test below is written as "what breaks in production if this stops",
// and the headers are asserted as EXACT strings rather than by substring: a
// directive quietly dropped in a refactor is precisely the failure that put
// subscriber data in a shared cache the first time.

const env = {} as unknown as AppEnv["Bindings"];

// The complete Cache-Control this middleware promises. Written out here rather
// than imported so that a change to noStore.ts has to be made twice, on
// purpose, and shows up in this file's diff.
const NO_STORE = "private, no-store, max-age=0, must-revalidate";

/** An app with noStore on "*", for the header behaviour that has nothing to do with paths. */
function appWith(register: (app: Hono<AppEnv>) => void) {
  const app = new Hono<AppEnv>();
  app.use("*", noStore);
  register(app);
  return app;
}

/**
 * The six mounts from index.ts:137-144, copied verbatim. noStore itself has no
 * path awareness at all -- it stamps whatever response reaches it -- so "which
 * URLs are protected" is entirely a question of this mount list, and the list
 * is therefore part of the contract these tests pin.
 */
function mountedLikeIndex() {
  const app = new Hono<AppEnv>();
  app.use("/admin", noStore);
  app.use("/admin/*", noStore);
  app.use("/auth", noStore);
  app.use("/auth/*", noStore);
  app.use("/needs/at/*/updates/*", noStore);
  app.use("/write/to/*/email/done/*", noStore);
  app.all("*", (c) => c.html("<p>page</p>"));
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("noStore", () => {
  it("bars every cache that could hold an admin page: browser, proxy and Cloudflare edge", async () => {
    // The documented happy path, one assertion per cache that was actually
    // capable of holding the leaked page.
    //
    // CDN-Cache-Control is the load-bearing one for the 2026-09-02 incident:
    // Cloudflare reads it on the response path and skips storing the object.
    // Cache-Control alone is what was missing then, and `Vary: Cookie` alone
    // would not have helped either -- Cloudflare does not vary on Cookie by
    // default, which is exactly how an anonymous request got the signed-in
    // page. All three, or the bug is back.
    const app = appWith((a) => a.get("/admin/foodbank/sid-valley/subscribers/", (c) => c.html("<td>subscriber@example.com</td>")));
    const res = await app.request("https://www.givefood.org.uk/admin/foodbank/sid-valley/subscribers/", {}, env);

    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
    expect(res.headers.get("CDN-Cache-Control")).toBe("no-store");
    expect(res.headers.get("Vary")).toBe("Cookie");

    // The identical three for a request that DOES carry a session cookie.
    // Every other request in this file is cookieless, so without this row a
    // cookie-conditional guard would pass the whole suite -- and both
    // directions of that guard are wrong. "Only stamp signed-in responses"
    // re-opens 2026-09-02 exactly, because the ANONYMOUS request is the one
    // whose response Cloudflare stored and replayed. "Only stamp anonymous
    // ones" leaves the admin's own dashboard in their browser cache and in any
    // proxy between them and us, which is the same page and the same
    // subscriber identifiers.
    const signedIn = await app.request(
      "https://www.givefood.org.uk/admin/foodbank/sid-valley/subscribers/",
      { headers: { Cookie: "__Host-gfsession=abc123" } },
      env,
    );
    expect(signedIn.headers.get("Cache-Control")).toBe(NO_STORE);
    expect(signedIn.headers.get("CDN-Cache-Control")).toBe("no-store");
    expect(signedIn.headers.get("Vary")).toBe("Cookie");
  });

  it("emits Django never_cache's directives minus no-cache, and adds nothing beyond its three headers", async () => {
    // Django's equivalent is @never_cache, used on gfauth/views.py:10's
    // sign_in and gfwfbn/views.py:192/1205. django.utils.cache's
    // add_never_cache_headers() sends
    // "max-age=0, no-cache, no-store, must-revalidate, private" AND an
    // Expires header pinned to now.
    //
    // This port deliberately sends a subset: no-store already forbids writing
    // the response down anywhere, so no-cache (revalidate before reuse) and
    // Expires (the HTTP/1.0 spelling of the same idea) add nothing a 2026
    // cache reads. Keeping that divergence DELIBERATE is the job here -- if
    // someone later restores them to match Django exactly, that is a decision,
    // and this test is where it gets made rather than drifted into.
    //
    // Written as a comparison against Django's actual directive list and as a
    // header-name diff against the same app WITHOUT the middleware. The
    // obvious spelling -- `expect(cc).not.toContain("no-cache")` next to an
    // exact-string assertion -- proves nothing, because the exact string
    // already implies it. These two do real work: the first fails if the port
    // drops one of the four Django directives it does keep OR quietly restores
    // no-cache, and the second fails if noStore ever grows a fourth header
    // (Django's companion `Expires`, or the `Pragma: no-cache` that usually
    // travels with it) while Cache-Control still looks right.
    // One registrar used for both apps, so the ONLY difference between the two
    // responses is the middleware -- a second copy of the handler could drift
    // and turn the diff below into a comparison of two different pages.
    const signIn = (a: Hono<AppEnv>) => a.get("/auth/", (c) => c.html("<p>sign in</p>"));
    const guarded = appWith(signIn);
    const control = new Hono<AppEnv>();
    signIn(control);

    const res = await guarded.request("https://www.givefood.org.uk/auth/", {}, env);
    const bare = await control.request("https://www.givefood.org.uk/auth/", {}, env);

    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);

    // django.utils.cache.add_never_cache_headers()'s Cache-Control, verbatim.
    const DJANGO_NEVER_CACHE = ["max-age=0", "no-cache", "no-store", "must-revalidate", "private"];
    const sent = new Set(res.headers.get("Cache-Control")!.split(", "));
    expect(DJANGO_NEVER_CACHE.filter((d) => sent.has(d))).toEqual(["max-age=0", "no-store", "must-revalidate", "private"]);
    expect(DJANGO_NEVER_CACHE.filter((d) => !sent.has(d))).toEqual(["no-cache"]);

    const before = new Set(bare.headers.keys());
    const added = [...res.headers.keys()].filter((name) => !before.has(name)).sort();
    expect(added).toEqual(["cache-control", "cdn-cache-control", "vary"]);
    expect(res.headers.get("Expires")).toBeNull();
  });

  it("stamps the real requireAdminAuth 302, which is the response an anonymous visitor gets", async () => {
    // The case the module comment calls out by name -- and the one that
    // matters most, because the signed-out redirect is the response an
    // anonymous request to /admin/ actually produces, so it is the response
    // most likely to be cached. A cached 302 to /auth/ would then be served to
    // a signed-IN admin, locking them out of their own dashboard.
    //
    // Uses the real requireAdminAuth rather than a stand-in redirect:
    // getAdminSession() short-circuits to null before touching KV when there
    // is no __Host-gfsession cookie, so this exercises the genuine article
    // with no bindings.
    //
    // And wired the way index.ts:603 actually wires it, which a flat app does
    // not reproduce: requireAdminAuth is mounted INSIDE adminApp
    // (routes/admin/index.ts:85, `adminApp.use("*", requireAdminAuth)`), the
    // sub-app is grafted on with `app.route("/admin", adminApp)`, and noStore
    // sits on the PARENT above it. So the response being stamped is one
    // produced by a different Hono instance's middleware chain, and the
    // redirect target has to survive the sub-app's path rebasing -- assert the
    // full /admin/... path, because a Location of "/auth/?next=%2Ffoodbank..."
    // would send the admin to the wrong page after sign-in.
    const adminApp = new Hono<AppEnv>();
    adminApp.use("*", requireAdminAuth);
    adminApp.get("/foodbank/sid-valley/", (c) => c.html("<p>secret</p>"));

    const app = new Hono<AppEnv>();
    app.use("/admin", noStore);
    app.use("/admin/*", noStore);
    app.route("/admin", adminApp);

    const res = await app.request("https://www.givefood.org.uk/admin/foodbank/sid-valley/", {}, env);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Ffoodbank%2Fsid-valley%2F");
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
    expect(res.headers.get("CDN-Cache-Control")).toBe("no-store");
    expect(res.headers.get("Vary")).toBe("Cookie");
  });

  it("has no status guard, so 404s and 500s are covered as well as 200s", async () => {
    // pageCacheControl bails on anything that is not a 200; this deliberately
    // does not, and the 500 is the interesting half. index.ts:625's onError
    // renders a real error page, and an admin error page can carry a food bank
    // name, a query, or a stack. Cached, that is the same leak in a different
    // wrapper.
    //
    // It survives a THROWN error because Hono's compose() catches at the
    // dispatch level of the handler that threw, hands the error to onError
    // there, and returns that response up the chain -- so `await next()` in
    // this middleware resolves normally and the header lines below it still
    // run. That is behaviour of Hono's, not of this file, so it is worth a
    // test: a compose() change that let the rejection propagate would silently
    // leave every admin 500 cacheable.
    vi.spyOn(console, "error").mockImplementation(() => {}); // hono's default onError logs the throw
    const app = appWith((a) => {
      a.get("/admin/boom/", () => {
        throw new Error("D1 unavailable");
      });
    });

    const missing = await app.request("https://www.givefood.org.uk/admin/no-such-page/", {}, env);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).toBe(NO_STORE);

    const thrown = await app.request("https://www.givefood.org.uk/admin/boom/", {}, env);
    expect(thrown.status).toBe(500);
    expect(thrown.headers.get("Cache-Control")).toBe(NO_STORE);
    expect(thrown.headers.get("CDN-Cache-Control")).toBe("no-store");
  });

  it("has no method guard either, so HEAD and POST are covered too", async () => {
    // A HEAD is how a cache revalidates and how several crawlers probe, and
    // Hono answers it by re-wrapping the GET response -- worth proving the
    // headers survive that wrapper. POST is included because /auth/receiver/
    // and the RFC 8058 one-click unsubscribe are both POSTs whose responses
    // are visitor-specific.
    const app = appWith((a) => a.all("/admin/", (c) => c.html("<p>dashboard</p>")));

    for (const method of ["GET", "HEAD", "POST"]) {
      const res = await app.request("https://www.givefood.org.uk/admin/", { method }, env);
      expect(res.headers.get("Cache-Control"), `${method} must be uncacheable`).toBe(NO_STORE);
      expect(res.headers.get("CDN-Cache-Control"), `${method} must bypass the edge`).toBe("no-store");
    }
  });

  it("overwrites BOTH cache headers the handler set for itself, CDN-Cache-Control included", async () => {
    // Unconditional set(), not a fill-the-gap like pageCacheControl's. That is
    // the difference that makes this safe: an admin route that copied a
    // `public, max-age=...` line from a public handler cannot re-open the
    // hole, and neither can a future route added under /admin/ by someone who
    // has never read this file.
    //
    // CDN-Cache-Control is asserted here and not only in the happy path
    // because it is the header that decides the 2026-09-02 outcome, and a
    // plausible wrong version -- `if (!c.res.headers.has("CDN-Cache-Control"))`,
    // written to let routes/media.ts keep its own edge TTL -- passes every
    // other test in this file while leaving an admin page cacheable AT THE
    // EDGE, which is the only cache that served subscriber data to strangers.
    // Cache-Control being right is no comfort at all if this one is stale:
    // CDN-Cache-Control takes precedence over Cache-Control at Cloudflare, so
    // the two disagreeing means the edge obeys the wrong one.
    //
    // The handler is async and sets its headers AFTER an await, because every
    // real handler in this codebase awaits D1 before it renders. A synchronous
    // handler runs to completion inside the `next()` call whether or not the
    // caller awaits it, so it cannot tell a correct middleware apart from one
    // that forgot the await.
    const app = appWith((a) =>
      a.get("/admin/stats/", async (c) => {
        await Promise.resolve();
        c.header("Cache-Control", "public, max-age=3600, s-maxage=86400");
        c.header("CDN-Cache-Control", "max-age=86400");
        return c.html("<p>stats</p>");
      }),
    );
    const res = await app.request("https://www.givefood.org.uk/admin/stats/", {}, env);
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
    expect(res.headers.get("CDN-Cache-Control")).toBe("no-store");
  });

  it("appends to Vary instead of replacing it", async () => {
    // `{ append: true }` is not decoration. A response that already varies on
    // Accept-Language (content negotiation) or Accept-Encoding (compression)
    // would, if this overwrote Vary, start being served to the wrong language
    // or in an encoding the client cannot read -- a worse bug than the one
    // this middleware fixes. Order is "what was there, then Cookie".
    const app = appWith((a) =>
      a.get("/admin/", (c) => {
        c.header("Vary", "Accept-Language");
        return c.html("<p>dashboard</p>");
      }),
    );
    const res = await app.request("https://www.givefood.org.uk/admin/", {}, env);
    expect(res.headers.get("Vary")).toBe("Accept-Language, Cookie");
  });

  it("leaves the body, the status and any Set-Cookie exactly as it found them", async () => {
    // The whole /auth/ flow works by setting __Host-oauth and
    // __Host-gfsession, and lib/adminAuth.ts sets both with { append: true }
    // so a single response can carry two. This middleware touches three named
    // headers and nothing else; if it ever normalised or rebuilt the header
    // set, sign-in would break in the least obvious way possible -- the
    // redirect would still arrive, just without the session.
    const app = appWith((a) =>
      a.get("/auth/receiver/", (c) => {
        c.header("Set-Cookie", "__Host-oauth=; Max-Age=0; Path=/", { append: true });
        c.header("Set-Cookie", "__Host-gfsession=abc123; Path=/", { append: true });
        return c.text("signed in", 201);
      }),
    );
    const res = await app.request("https://www.givefood.org.uk/auth/receiver/", {}, env);

    expect(res.status).toBe(201);
    expect(await res.text()).toBe("signed in");
    expect(res.headers.getSetCookie()).toEqual(["__Host-oauth=; Max-Age=0; Path=/", "__Host-gfsession=abc123; Path=/"]);
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
  });

  it("stamps a Response the handler built itself, whose headers are immutable", async () => {
    // Handlers here do return bare Responses (routes/media.ts proxies one;
    // cacheTag.ts's own comment calls the case out), and a Response produced
    // by Response.redirect() has a guarded, read-only header list. Hono's
    // c.header() copes by rebuilding the response -- proving it here means
    // nobody has to wonder whether a proxied or redirect Response silently
    // skips the protection.
    const app = appWith((a) => a.get("/auth/", () => Response.redirect("https://accounts.google.com/o/oauth2/v2/auth?x=1", 302)));
    const res = await app.request("https://www.givefood.org.uk/auth/", {}, env);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://accounts.google.com/o/oauth2/v2/auth?x=1");
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
    expect(res.headers.get("Vary")).toBe("Cookie");

    // And a hand-built Response that already carries both headers, which is
    // the proxying shape routes/media.ts uses. The append has to survive
    // whatever Hono does to graft headers onto a Response it did not create;
    // if the rebuild dropped the incoming Vary, a compressed proxied response
    // would start being served to clients that cannot decode it.
    const proxying = appWith((a) =>
      a.get("/admin/photo/", () => new Response("jpegbytes", { headers: { Vary: "Accept-Encoding", "Cache-Control": "public, max-age=99" } })),
    );
    const proxied = await proxying.request("https://www.givefood.org.uk/admin/photo/", {}, env);
    expect(proxied.headers.get("Vary")).toBe("Accept-Encoding, Cookie");
    expect(proxied.headers.get("Cache-Control")).toBe(NO_STORE);
    expect(await proxied.text()).toBe("jpegbytes");
  });

  it("covers the bare mount points as well as their subpaths", async () => {
    // The whole admin surface, in one table, because the incident was not
    // "one page leaked" -- it was /admin/, /admin/foodbank/<slug>/ and its tab
    // fragments, all at once. If any row here goes null, that is the bug back.
    //
    // index.ts registers FOUR patterns for two prefixes, on the stated belief
    // that Hono matches "/admin/*" against subpaths only. On hono 4.13.7 that
    // is no longer so -- "/admin/*" on its own already matches "/admin" and
    // "/admin/" -- so the two bare mounts are redundant belt-and-braces rather
    // than the load-bearing thing the comment describes. Harmless, and worth
    // keeping (a router change that narrowed "*" again would be caught by the
    // mounts, not by anyone reading a comment), but the OUTCOME below is what
    // is actually pinned, not the mechanism.
    const app = mountedLikeIndex();
    for (const path of [
      "/admin",
      "/admin/",
      "/admin/foodbank/sid-valley/subscribers/",
      "/auth",
      "/auth/",
      "/auth/receiver/",
      // Slashless. Django ran with APPEND_SLASH, so the whole internet has
      // learned it can leave the trailing slash off this site's URLs, and
      // crawlers and hand-typed links arrive that way constantly. Whatever
      // that request produces here -- a 404, a redirect -- it is a response
      // ABOUT an admin page, and it must not be stored. Covered only because
      // Hono's trailing "*" also matches an empty remainder.
      "/admin/foodbank/sid-valley/subscribers",
    ]) {
      const res = await app.request(`https://www.givefood.org.uk${path}`, {}, env);
      expect(res.headers.get("Cache-Control"), `${path} must be uncacheable`).toBe(NO_STORE);
    }
  });

  it("covers the three public routes that mutate or echo a visitor back to themselves", async () => {
    // Not access control, same root cause. GET .../updates/confirm/ confirms a
    // subscriber and GET .../updates/unsubscribe/ deletes one (both mutate and
    // send mail in routes/wfbn/updates.ts), so a cache HIT would show
    // "You have been unsubscribed" without the Worker running and the row
    // would survive. /write/to/<slug>/email/done/?email=... renders the
    // visitor's own address, which must not sit in a shared cache -- note the
    // query string, since that is how the address arrives.
    const app = mountedLikeIndex();
    for (const path of [
      "/needs/at/sid-valley/updates/confirm/?key=abc",
      "/needs/at/sid-valley/updates/unsubscribe/?key=abc",
      "/needs/at/sid-valley/updates/subscribe/",
      "/write/to/sid-valley/email/done/?email=someone%40example.com",
      // The trailing "*" matches an EMPTY remainder too, so the action-less
      // /needs/at/<slug>/updates/ -- which no route registers, and which
      // therefore 404s -- is covered as well. Listed so that nobody
      // "tightens" the pattern to "*/updates/*something" and discovers the
      // subtlety on a live 404 page instead.
      "/needs/at/sid-valley/updates/",
      // Same APPEND_SLASH reasoning as the admin table above, and it matters
      // more here: an unsubscribe link travels through mail clients and
      // scanners that rewrite URLs, so the slashless form is a real request
      // this site receives, not a hypothetical.
      "/needs/at/sid-valley/updates/unsubscribe",
      "/write/to/sid-valley/email/done",
    ]) {
      const res = await app.request(`https://www.givefood.org.uk${path}`, {}, env);
      expect(res.headers.get("Cache-Control"), `${path} must be uncacheable`).toBe(NO_STORE);
    }
  });

  it("leaves ordinary public pages cacheable, which is the point of mounting it narrowly", async () => {
    // The other half of the contract. This is mounted on six patterns rather
    // than "*" because the site's edge hit rate is what makes it cheap to run;
    // a mount that crept wider would quietly turn every food bank page into an
    // origin hit. /administrator/ is in the list because "/admin" must be
    // matched as a path segment, not as a string prefix.
    const app = mountedLikeIndex();
    for (const path of [
      "/needs/at/sid-valley/",
      "/write/to/sid-valley/email/",
      "/write/to/sid-valley/",
      "/administrator/",
      "/",
      // The two boundaries where "uncovered" needs a reason rather than a
      // shrug, both recorded here so that finding them mid-incident does not
      // cost an hour. Hono's router is CASE-SENSITIVE, so "/ADMIN/" is not
      // matched by any mount above; it is not a leak, because it is not
      // matched by any admin ROUTE either (index.ts registers them lowercase),
      // so the response is a public 404 with nothing in it. The same goes for
      // the empty slug: "*" needs at least one character, so
      // "/needs/at//updates/confirm/" is uncovered, and it is likewise a 404
      // because ":slug" will not match an empty segment. Both would stop being
      // harmless the moment a route were registered case-insensitively or with
      // an optional slug -- which is the change this row is here to catch.
      "/ADMIN/",
      "/needs/at//updates/confirm/",
    ]) {
      const res = await app.request(`https://www.givefood.org.uk${path}`, {}, env);
      expect(res.headers.get("Cache-Control"), `${path} should be left alone`).toBeNull();
      expect(res.headers.get("Vary"), `${path} should be left alone`).toBeNull();
    }
  });

  it("does NOT cover the locale-prefixed subscriber routes -- current behaviour, reported as a gap", async () => {
    // Documenting what the code does today, not endorsing it. index.ts:298-299
    // registers the updates routes under /cy/, /ga/ and /gd/ as well as
    // unprefixed, but the mount at index.ts:143 is "/needs/at/*/updates/*",
    // which matches on the path as it arrives -- resolveLanguage runs after
    // routing and cannot strip the prefix in time. So the Welsh, Irish and
    // Scots Gaelic forms of the confirm and unsubscribe URLs get no header at
    // all, and are eligible for the same cache-HIT-without-executing behaviour
    // the unprefixed ones were mounted to prevent.
    //
    // Left as a failing-in-spirit test that passes on today's behaviour, per
    // the brief; if the mount list gains the locale prefixes this assertion
    // should be inverted to match.
    // Driven off resolveLanguage's own PREFIXES rather than a hardcoded
    // ["cy","ga","gd"], because index.ts:295 builds the prefixed routes from
    // that same set: adding a fourth language would create a fourth uncovered
    // URL, and this loop grows with it instead of quietly continuing to check
    // three. The size guard is not ceremony -- a `for...of` over an empty set
    // passes every assertion inside it, so a refactor that emptied PREFIXES
    // would turn this test green and meaningless.
    expect(PREFIXES.size).toBeGreaterThan(0);
    const app = mountedLikeIndex();
    for (const locale of PREFIXES) {
      const res = await app.request(`https://www.givefood.org.uk/${locale}/needs/at/sid-valley/updates/unsubscribe/?key=abc`, {}, env);
      expect(res.headers.get("Cache-Control"), `/${locale}/ is currently uncovered`).toBeNull();
      expect(res.headers.get("CDN-Cache-Control")).toBeNull();
      expect(res.headers.get("Vary")).toBeNull();
    }
  });

  it("repeats Cookie in Vary when two mounts both match, which is harmless", async () => {
    // The visible consequence of the redundant mounts noted above: "/admin"
    // and "/admin/*" BOTH match the slashless "/admin", so noStore runs twice
    // and appends Cookie twice. RFC 9111 treats a Vary field list as a set, so
    // "Cookie, Cookie" behaves identically to "Cookie" -- pinned here so the
    // duplicate is recognised as known and cosmetic rather than mistaken for a
    // bug mid-incident. Cache-Control is set(), not appended, so the double
    // run leaves it untouched -- which is the property that makes running this
    // middleware more than once safe in the first place.
    const app = mountedLikeIndex();
    const res = await app.request("https://www.givefood.org.uk/admin", {}, env);
    expect(res.headers.get("Vary")).toBe("Cookie, Cookie");
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
    // The third header has to survive the double run intact too. A copy-paste
    // of the Vary line's `{ append: true }` onto this one would produce
    // "no-store, no-store" here and nowhere else in this file -- and unlike
    // Vary, CDN-Cache-Control is not a set: a repeated directive is a
    // malformed value, and a malformed value is one Cloudflare may ignore, on
    // the exact responses that most need it honoured.
    expect(res.headers.get("CDN-Cache-Control")).toBe("no-store");
  });

  it("wins over pageCacheControl and suppresses cacheTag, in index.ts's registration order", async () => {
    // The three-middleware interaction index.ts:119-144 explains in prose,
    // exercised for real: cacheTag and pageCacheControl mount on "*" ABOVE the
    // noStore mounts, so Hono unwinds them after it and each sees the
    // no-store already in place. pageCacheControl's "never override" guard
    // must then leave it alone, and cacheTag must not attach a Cache-Tag to a
    // response that will never be in a cache to purge.
    //
    // The failure this prevents is specific and silent: an unsubscribe page
    // going out with "public, max-age=300, s-maxage=86400", which is the
    // original incident with extra steps.
    const app = new Hono<AppEnv>();
    app.use("*", cacheTag);
    app.use("*", pageCacheControl);
    app.use("/needs/at/*/updates/*", noStore);
    app.get("/needs/at/sid-valley/updates/unsubscribe/", (c) => c.html("<p>You have been unsubscribed.</p>"));
    app.get("/needs/at/sid-valley/", (c) => c.html("<p>needs</p>"));

    const guarded = await app.request("https://www.givefood.org.uk/needs/at/sid-valley/updates/unsubscribe/", {}, env);
    expect(guarded.headers.get("Cache-Control")).toBe(NO_STORE);
    expect(guarded.headers.get("Cache-Tag")).toBeNull();

    // The control: same app, same food bank, a page with no noStore mount.
    // Without this, the assertions above would also pass if the two other
    // middlewares had simply stopped working.
    const public_ = await app.request("https://www.givefood.org.uk/needs/at/sid-valley/", {}, env);
    expect(public_.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    expect(public_.headers.get("Cache-Tag")).toBe("fb-sid-valley");
  });
});
