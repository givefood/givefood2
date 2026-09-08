import { Hono } from "hono";
import type { Handler, MiddlewareHandler } from "hono";
import { describe, expect, it } from "vitest";
import { geoJsonPreload } from "./geoJsonPreload";

// Port of givefood/middleware.py's GeoJSONPreload. The middleware has no
// return value and no inputs of its own -- everything it does is decided by
// the ROUTE THAT MATCHED, so every test here drives a real Hono app rather
// than calling the handler with a stub context. A hand-made context could be
// given any `routePath` at all, including ones the production router can
// never produce, and would happily "pass" while the live site sent nothing.
//
// The route list below is a faithful copy of the wfbn registrations in
// index.ts, IN THE SAME ORDER. Order is load-bearing twice over:
//   * `/needs/at/:slug/:locslug/` is a catch-all sibling of nearby/,
//     locations/, donationpoints/, news/ and charity/. Hono runs matching
//     handlers in registration order and stops at the first that returns,
//     so registering :locslug early silently swallows every one of them --
//     and this middleware would then hand a food bank's own geo.json to the
//     /nearby/ page, which is the one page that must NOT get it. That is not
//     a hypothetical: it is asserted directly in "a router that registers
//     the :locslug catch-all too early..." below.
//   * this middleware reads `c.req.routePath`, which only becomes the
//     matched route AFTER `next()` (asserted at the bottom of this file).
const html: Handler = (c) => c.html("<!doctype html><p>needs</p>");

// The exact parameter list every emitted header must carry. Kept in one
// place so that the "same parameters on every branch" test below is checking
// a single spelling rather than five independently-typed strings that could
// drift apart without any test noticing.
const PARAMS = "; rel=preload; as=fetch; crossorigin=anonymous";

function siteApp() {
  const app = new Hono();
  app.use("*", geoJsonPreload);
  app.get("/needs/", html);
  app.get("/needs/at/:slug/", html);
  app.get("/needs/at/:slug/nearby/", html);
  app.get("/needs/at/:slug/locations/", html);
  app.get("/needs/at/:slug/donationpoints/", html);
  app.get("/needs/at/:slug/donationpoint/:dpslug/", html);
  app.get("/needs/at/:slug/news/", html);
  app.get("/needs/at/:slug/charity/", html);
  app.get("/needs/geo.json", (c) => c.json({ type: "FeatureCollection" }));
  app.get("/needs/at/:slug/geo.json", (c) => c.json({ type: "FeatureCollection" }));
  app.get("/needs/in/constituencies/", html);
  app.get("/needs/in/constituency/:slug/", html);
  // Registered last, exactly as index.ts does it, for the reason above.
  app.get("/needs/at/:slug/:locslug/", html);
  // The Welsh half of the i18n_patterns loop -- one locale is enough to pin
  // the behaviour of all of cy/ga/gd.
  app.get("/cy/needs/", html);
  app.get("/cy/needs/at/:slug/", html);
  return app;
}

const link = async (path: string, app = siteApp()) => (await app.request(path)).headers.get("Link");

describe("geoJsonPreload", () => {
  it("preloads the all-food-banks geo.json on the index page", async () => {
    // Django: url_name 'index' -> reverse('wfbn:geojson') -> /needs/geo.json.
    expect(await link("/needs/")).toBe(`</needs/geo.json>${PARAMS}`);
  });

  it("preloads the food bank's own geo.json on all four food bank pages", async () => {
    // Django's list is exactly ['foodbank', 'foodbank_locations',
    // 'foodbank_donationpoints', 'foodbank_location'] -- four url_names, one
    // shared reverse('wfbn:foodbank_geojson', slug). All four render the same
    // map, so all four want the same file warmed. A route dropped from this
    // set costs that page its preload silently; nothing else fails.
    const expected = `</needs/at/sid-valley/geo.json>${PARAMS}`;
    const app = siteApp();
    expect(await link("/needs/at/sid-valley/", app)).toBe(expected);
    expect(await link("/needs/at/sid-valley/locations/", app)).toBe(expected);
    expect(await link("/needs/at/sid-valley/donationpoints/", app)).toBe(expected);
    // foodbank_location: the :locslug catch-all, which is why the route order
    // in siteApp() matters -- see the file header. Note the expectation names
    // the FIRST path parameter: an implementation that read the last param,
    // or that pasted c.req.path in, would say .../twerton/geo.json here.
    expect(await link("/needs/at/sid-valley/twerton/", app)).toBe(expected);
  });

  it("gives the /nearby/ page the ALL-food-banks geo.json, not the food bank's own", async () => {
    // Not an oversight, and not worth "tidying" into the branch above: the
    // nearby page plots OTHER food banks near this one, so the file it
    // actually fetches is the national one. Django says the same thing in
    // its own branch (url_name 'foodbank_nearby' -> reverse('wfbn:geojson')).
    // Fold this into the foodbank branch and the page preloads a file it
    // never requests, then fetches the 1MB national one unhinted.
    expect(await link("/needs/at/sid-valley/nearby/")).toBe(`</needs/geo.json>${PARAMS}`);
  });

  it("keeps crossorigin=anonymous, without which the browser discards the preload", async () => {
    // Ticket #11, recorded at length in routes/wfbn/locationDetail.ts: the
    // map JS fetches the geojson with fetch(url, {credentials:'same-origin'})
    // -- CORS mode. A preload with no `crossorigin` is issued in no-cors
    // mode, matches nothing, and the browser throws it away, refetches, and
    // logs "was preloaded ... but not used within a few seconds". The whole
    // header is inert without this one token.
    //
    // Checked across EVERY emitting route, not just the index, because the
    // parameters are re-typed per branch in the source: a branch that grew a
    // `; nopush`, lost the crossorigin token, or dropped the angle brackets
    // while the other branches stayed correct would still satisfy a
    // single-route assertion.
    const app = siteApp();
    const emitting = [
      "/needs/",
      "/needs/at/sid-valley/",
      "/needs/at/sid-valley/locations/",
      "/needs/at/sid-valley/donationpoints/",
      "/needs/at/sid-valley/twerton/",
      "/needs/at/sid-valley/nearby/",
    ];
    for (const path of emitting) {
      const value = await link(path, app);
      // Angle-bracketed URI-reference first, then exactly the three
      // parameters, and nothing after them.
      expect(value, path).toMatch(/^<\/needs\/[^>]*geo\.json>; rel=preload; as=fetch; crossorigin=anonymous$/);
    }
  });

  it("adds nothing on routes it does not recognise", async () => {
    // The fail-open half of the contract: Django wraps resolve() in a bare
    // try/except and simply omits the header when it cannot name the view.
    // These are all live, HTML, 200 pages that legitimately have no map.
    const app = siteApp();
    expect(await link("/needs/at/sid-valley/news/", app)).toBeNull();
    expect(await link("/needs/at/sid-valley/charity/", app)).toBeNull();
    expect(await link("/needs/at/sid-valley/donationpoint/tesco-exeter/", app)).toBeNull();
    expect(await link("/needs/in/constituencies/", app)).toBeNull();
  });

  it("leaves an unrecognised route's OWN Link header completely alone", async () => {
    // The live case, and the one that "adds nothing" above does not cover:
    // /needs/at/:slug/donationpoint/:dpslug/ (routes/wfbn/locationDetail.ts)
    // sets its own Link preload for the openinghours fragment, and that route
    // is deliberately absent from this middleware's match list. So the
    // middleware must be additive-on-match and a complete no-op otherwise.
    //
    // An implementation that hoisted the `headers.set` out of the
    // `if (geojsonUrl)` -- setting `geojsonUrl ?? ""`, or clearing Link first
    // "to be safe" -- passes every other test in this file while silently
    // deleting a preload another page depends on. Ticket #11 was exactly this
    // class of bug (a preload present but useless); this is the version where
    // it disappears entirely.
    const own = `</needs/at/sid-valley/donationpoint/tesco-exeter/openinghours/>${PARAMS}`;
    const app = new Hono();
    app.use("*", geoJsonPreload);
    app.get("/needs/at/:slug/donationpoint/:dpslug/", (c) => {
      c.header("Link", own);
      return c.html("<p>x</p>");
    });
    expect(await link("/needs/at/sid-valley/donationpoint/tesco-exeter/", app)).toBe(own);
  });

  it("does not preload a geo.json from the geo.json endpoints themselves", async () => {
    // Two guards catch these: the route templates end in /geo.json (never in
    // the match list), and the responses are application/json. Belt and
    // braces, but a self-referential preload would be a real waste of a
    // header on the largest responses the site serves.
    const app = siteApp();
    expect(await link("/needs/geo.json", app)).toBeNull();
    expect(await link("/needs/at/sid-valley/geo.json", app)).toBeNull();
  });

  it("never fires on a locale-prefixed page -- a real divergence from Django", async () => {
    // DOCUMENTS CURRENT BEHAVIOUR, NOT DESIRED BEHAVIOUR. Django's
    // /needs/ include sits inside i18n_patterns (givefood/urls.py:47), and
    // resolve('/cy/needs/at/x/') strips the prefix and returns url_name
    // 'foodbank' -- so the Django site DOES send this header on Welsh, Irish
    // and Gaelic pages. index.ts registers the locale variants as separate
    // routes ("/cy/needs/at/:slug/"), whose routePath does not equal any
    // literal in the middleware, so the port sends nothing. Reported as a
    // suspected bug rather than fixed here.
    const app = siteApp();
    expect(await link("/cy/needs/", app)).toBeNull();
    expect(await link("/cy/needs/at/sid-valley/", app)).toBeNull();
    // The nearby page too, so a partial fix that only re-listed the two
    // simplest locale routes cannot pass this test while leaving the rest of
    // the i18n_patterns loop (index.ts:276-301) unported.
    expect(await link("/cy/needs/at/sid-valley/nearby/", siteApp())).toBeNull();
  });

  // github #29. This pair used to assert the opposite of what it asserts now,
  // labelled "DOCUMENTS CURRENT BEHAVIOUR ... reported as a suspected bug":
  // the middleware's literal was "/in/constituency/:slug/" while index.ts
  // registers the page at "/needs/in/constituency/:slug/", so the branch was
  // unreachable and ~650 constituency pages sent no Link header at all.
  // Django's middleware.py:135 has the branch and does send it.
  it("preloads the constituency geo.json on a constituency page", async () => {
    // Requested through siteApp(), which registers the page at the literal
    // index.ts really uses -- that is the whole substance of the fix. A test
    // that built its own app around the middleware's literal would pass on
    // either spelling, which is exactly how the bug survived.
    expect(await link("/needs/in/constituency/bath-and-north-east-somerset/")).toBe(
      `</needs/in/constituency/bath-and-north-east-somerset/geo.json>${PARAMS}`,
    );
  });

  it("does not fire on the unprefixed path the broken literal named", async () => {
    // The inverse of the fix, and the reason it is a fix rather than a
    // widening: "/in/constituency/:slug/" is not a route this site has -- grep
    // finds no registration for it anywhere in workers/ -- so the middleware
    // must not answer to it. Without this, replacing the literal with
    // something loose enough to match both spellings would pass every other
    // test in this file.
    const app = new Hono();
    app.use("*", geoJsonPreload);
    app.get("/in/constituency/:slug/", html);
    expect(await link("/in/constituency/bath/", app)).toBeNull();
  });

  // The URL the branch emits, pinned separately from the match that reaches
  // it. Django reverses wfbn:constituency_geojson with
  // kwargs={'parlcon_slug': slug}, giving /needs/in/constituency/<slug>/geo.json
  // -- precisely the route index.ts registers for wfbnConstituencyGeojson, and
  // the same URL constituencies.ts:234 puts in the page's own map_config. A
  // mismatch between the two would preload a file the page never asks for,
  // which is worse than no preload: it is a wasted request that also warms
  // the wrong cache entry.
  it("preloads the same geo.json URL the page's map_config asks for", async () => {
    expect(await link("/needs/in/constituency/bath/")).toBe(`</needs/in/constituency/bath/geo.json>${PARAMS}`);
  });

  it("only touches 200 responses", async () => {
    // Django: `response.status_code == 200`, an equality test and not a
    // 2xx range or a `< 400`. Each status below breaks a different plausible
    // rewrite of that guard:
    //   404 -- an unknown food bank slug, which is most of this site's 404s.
    //          Rendered as HTML by a recognised route, so only the status
    //          check stops it advertising a geo.json that does not exist.
    //   201 -- would slip through a `< 300` or `>= 400` test.
    //   304 -- the common one in production: Cloudflare revalidating a
    //          cached page. The header would be attached to a body-less
    //          response, and `2xx`-style checks miss it too.
    //   302 -- /needs/in/constituency/ redirects to the plural (index.ts).
    const app = new Hono();
    app.use("*", geoJsonPreload);
    app.get("/needs/at/:slug/", (c) => c.html("<p>no such food bank</p>", 404));
    app.get("/needs/", (c) => c.html("<p>created</p>", 201));
    app.get("/needs/at/:slug/nearby/", () =>
      new Response(null, { status: 304, headers: { "Content-Type": "text/html; charset=utf-8" } }));
    app.get("/needs/at/:slug/locations/", (c) => c.redirect("/needs/at/x/", 302));
    expect(await link("/needs/at/nonexistent/", app)).toBeNull();
    expect(await link("/needs/", app)).toBeNull();
    expect(await link("/needs/at/x/nearby/", app)).toBeNull();
    expect(await link("/needs/at/x/locations/", app)).toBeNull();
  });

  it("only touches text/html responses, matching Django's case-sensitive test", async () => {
    // Django asks `'text/html' in response.get('Content-Type', '')`, which is
    // a case-sensitive substring test; this port's .includes() is the same
    // test with the same case sensitivity, so an upper-cased Content-Type is
    // skipped by BOTH implementations. Pinned deliberately: "fixing" the port
    // to lower-case first would make it diverge from the Django original it
    // is checked against, and every real response here is lower-case anyway.
    const app = new Hono();
    app.use("*", geoJsonPreload);
    app.get("/needs/", (c) => c.json({ ok: true }));
    expect(await link("/needs/", app)).toBeNull();

    const shouty = new Hono();
    shouty.use("*", geoJsonPreload);
    shouty.get("/needs/", () => new Response("<p>x</p>", { headers: { "Content-Type": "TEXT/HTML" } }));
    expect(await link("/needs/", shouty)).toBeNull();

    // A multi-value Content-Type still contains the substring, so it passes
    // -- again identical to Django's `in`, and NOT to a `===` or a
    // startsWith() rewrite, both of which would reject this.
    const multi = new Hono();
    multi.use("*", geoJsonPreload);
    multi.get("/needs/", () => new Response("<p>x</p>", { headers: { "Content-Type": "application/xhtml+xml, text/html" } }));
    expect(await link("/needs/", multi)).toBe(`</needs/geo.json>${PARAMS}`);

    // And the charset suffix that c.html() actually emits must pass too --
    // this is the only Content-Type the live site ever sends on these pages,
    // so a `===` comparison would disable the header everywhere.
    const charset = new Hono();
    charset.use("*", geoJsonPreload);
    charset.get("/needs/", (c) => c.html("<p>x</p>"));
    const res = await charset.request("/needs/");
    expect(res.headers.get("Content-Type")).toContain(";");
    expect(res.headers.get("Link")).toBe(`</needs/geo.json>${PARAMS}`);
  });

  it("survives a response with no Content-Type at all", async () => {
    // The `?? ""` in the guard. Django's response.get('Content-Type', '')
    // has the same default; without it this throws on .includes(null) and
    // takes down a page that had already rendered successfully.
    const app = new Hono();
    app.use("*", geoJsonPreload);
    // A binary body gets no Content-Type from the Response constructor,
    // unlike a string one (which is given text/plain).
    app.get("/needs/", () => new Response(new Uint8Array([0x3c, 0x70, 0x3e]), { status: 200 }));
    const res = await app.request("/needs/");
    expect(res.headers.get("Content-Type")).toBeNull();
    expect(res.status).toBe(200);
    expect(res.headers.get("Link")).toBeNull();
  });

  it("replaces a Link header the route set for itself, rather than adding a second", async () => {
    // `headers.set`, not `.append`. Today no recognised route sets its own
    // Link -- the one route that does, the donation point page
    // (locationDetail.ts, its openinghours fragment preload), is deliberately
    // not in the match list (see the "leaves an unrecognised route's OWN Link
    // header alone" test). This test is the tripwire for that changing:
    // adding e.g. the donation point route to the list above would silently
    // delete a preload that a page genuinely needs.
    const app = new Hono();
    app.use("*", geoJsonPreload);
    app.get("/needs/", (c) => {
      c.header("Link", "</needs/at/sid-valley/openinghours/>; rel=preload; as=fetch; crossorigin=anonymous");
      return c.html("<p>x</p>");
    });
    const res = await app.request("/needs/");
    expect(res.headers.get("Link")).toBe(`</needs/geo.json>${PARAMS}`);
    // Not "a, b" -- the route's own value is gone, not merged.
    expect(res.headers.get("Link")).not.toContain("openinghours");
  });

  it("changes nothing else about the response it decorates", async () => {
    // The middleware mutates one header on the existing `c.res`; it must not
    // replace the response object, drain the body, or disturb the headers the
    // route set for caching and language negotiation. A rewrite that did
    // `c.res = new Response(c.res.body, {headers: {Link: url}})` -- a
    // tempting way to sidestep the immutable-headers problem -- would pass
    // every assertion above this one and quietly strip Cache-Control and Vary
    // from every food bank page on the site.
    const app = new Hono();
    app.use("*", geoJsonPreload);
    app.get("/needs/at/:slug/", (c) => {
      c.header("Cache-Control", "public, max-age=300");
      c.header("Vary", "Accept-Language");
      c.header("X-GF-Cache-Tag", "foodbank:sid-valley");
      return c.html("<!doctype html><p>sid valley</p>");
    });
    const res = await app.request("/needs/at/sid-valley/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<!doctype html><p>sid valley</p>");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(res.headers.get("Vary")).toBe("Accept-Language");
    expect(res.headers.get("X-GF-Cache-Tag")).toBe("foodbank:sid-valley");
    expect(res.headers.get("Link")).toBe(`</needs/at/sid-valley/geo.json>${PARAMS}`);
  });

  it("does not run at all when the route handler throws", async () => {
    // The middleware's work happens after `await next()`, so an exception
    // from downstream propagates straight past it -- Django's try/except
    // guards only resolve(), never the view. Worth pinning because the
    // 500 page is HTML and would otherwise be a candidate for the header.
    const app = new Hono();
    app.use("*", geoJsonPreload);
    app.get("/needs/", () => {
      throw new Error("D1 unavailable");
    });
    const res = await app.request("/needs/");
    expect(res.status).toBe(500);
    expect(res.headers.get("Link")).toBeNull();
  });

  it("preloads the plain geo.json regardless of query string", async () => {
    // The food bank pages are linked with ?lat=&lng= tracking parameters from
    // the getlocation flow, and /needs/ takes them from the search box. The
    // preloaded URL must stay the bare static file -- it is a different cache
    // entry per query string otherwise, and the map JS requests it unadorned,
    // so a hinted `/needs/geo.json?lat=1` matches nothing and is discarded.
    //
    // This is the test that separates reading `c.req.param()` from reading
    // `c.req.url` or `c.req.path` + a suffix: the latter would emit
    // "/needs/at/sid-valley/?lat=51geo.json" here and pass everywhere else.
    const app = siteApp();
    expect(await link("/needs/?lat=51.5&lng=-0.1", app)).toBe(`</needs/geo.json>${PARAMS}`);
    expect(await link("/needs/at/sid-valley/?lat=51.5&lng=-0.1", app)).toBe(
      `</needs/at/sid-valley/geo.json>${PARAMS}`,
    );
  });

  it("percent-decodes the slug into the header, and 500s on bytes a header cannot hold", async () => {
    // DOCUMENTS CURRENT BEHAVIOUR. c.req.param() returns the DECODED segment
    // and it goes into the header value unescaped and unvalidated. Real food
    // bank slugs are ASCII kebab-case and an unknown slug 404s before this
    // runs (see the 200-only test above), so this is latent rather than live
    // -- but it is the sharp edge to know about if slugs ever widen.
    const app = new Hono();
    let caught: unknown;
    app.onError((err, c) => {
      caught = err;
      return c.text("error", 500);
    });
    app.use("*", geoJsonPreload);
    app.get("/needs/at/:slug/", html);

    // Latin-1 range: passes through decoded, as a raw non-ASCII byte. Note
    // this also rules out a "defensive" encodeURIComponent(slug), which would
    // emit caf%C3%A9 and be indistinguishable on every ASCII slug.
    expect(await link("/needs/at/caf%C3%A9/", app)).toBe(`</needs/at/café/geo.json>${PARAMS}`);

    // The QUIET failures: characters that are legal in a header value but
    // illegal in the Link grammar. `>` closes the URI-reference early and
    // a space ends it, so the header is emitted, accepted by the platform,
    // and then silently mis-parsed or dropped by the browser. Nothing in the
    // middleware notices. This is the worst outcome of the three and the
    // reason the slug validation lives upstream, in the route.
    expect(await link("/needs/at/a%3Eb/", app)).toBe(`</needs/at/a>b/geo.json>${PARAMS}`);
    expect(await link("/needs/at/a%20b/", app)).toBe(`</needs/at/a b/geo.json>${PARAMS}`);

    // Above U+00FF a header value cannot represent the character at all, and
    // Headers.set throws -- turning a rendered 200 page into a 500.
    const euro = await app.request("/needs/at/%E2%82%AC/");
    expect(euro.status).toBe(500);
    expect(caught).toBeInstanceOf(TypeError);

    // Same outcome for CR/LF, which is what stops this being a header
    // injection: the platform rejects the value instead of splitting it.
    caught = undefined;
    const crlf = await app.request("/needs/at/a%0d%0aX%3A%20y/");
    expect(crlf.status).toBe(500);
    expect(crlf.headers.get("X")).toBeNull();
    expect(caught).toBeInstanceOf(TypeError);

    // ...and for a NUL byte, the other classic smuggling probe.
    caught = undefined;
    expect((await app.request("/needs/at/a%00b/")).status).toBe(500);
    expect(caught).toBeInstanceOf(TypeError);

    // No length cap anywhere in the middleware: the whole slug goes into the
    // header however long it is. Cloudflare rejects responses whose headers
    // exceed its own limit, so a pathological URL becomes a 5xx at the edge
    // rather than a truncated hint. Recorded, not defended against, because
    // slugs come from the database and not from the request on live routes.
    const long = "a".repeat(20000);
    expect((await link(`/needs/at/${long}/`, app))?.length).toBe(long.length + 67);
  });

  it("cannot be reached with an empty slug, which is why the `if (slug)` guard never fires", async () => {
    // Hono's :slug matches one-or-more non-slash characters, so /needs/at//
    // is a 404 and no branch that reads a slug can see an empty one. The
    // guard mirrors Django's `if slug:` and stays as belt-and-braces; this
    // test records that the belt is doing the work, so nobody reads the
    // guard as evidence that empty slugs are a live case.
    const res = await siteApp().request("/needs/at//");
    expect(res.status).toBe(404);
    expect(res.headers.get("Link")).toBeNull();

    // The constituency branch has its own copy of the guard, so it gets its
    // own check -- on the app shape where that branch is actually reachable,
    // since on the real router it never is (see the unreachable-branch test).
    const con = new Hono();
    con.use("*", geoJsonPreload);
    con.get("/in/constituency/:slug/", html);
    const conRes = await con.request("/in/constituency//");
    expect(conRes.status).toBe(404);
    expect(conRes.headers.get("Link")).toBeNull();
  });

  it("matches on the trailing slash, so a slash-less registration gets no preload", async () => {
    // Every literal in the middleware ends in "/", inherited from Django's
    // APPEND_SLASH URLconf. Hono treats "/needs/at/:slug" and
    // "/needs/at/:slug/" as different templates and does not normalise
    // between them, so registering a page without its trailing slash -- an
    // easy thing to do by hand, and the shape most Hono examples use --
    // silently costs that page its preload with no error anywhere.
    const app = new Hono();
    app.use("*", geoJsonPreload);
    app.get("/needs/at/:slug", html);
    expect(await link("/needs/at/sid-valley", app)).toBeNull();
  });

  it("still matches when the routes are moved into a mounted sub-app", async () => {
    // The module comment asks that its literals "stay in sync with
    // routes/wfbn.ts as that file is built out". The likeliest form of that
    // build-out is app.route("/needs", wfbnApp), and Hono reports the
    // MOUNT-PREFIXED template as routePath -- so the literals below stay
    // correct through that refactor. If a Hono upgrade ever changed
    // routePath to the sub-app-relative path instead, every preload on the
    // site would vanish silently; this test fails loudly first.
    const wfbn = new Hono();
    wfbn.get("/at/:slug/", html);
    const app = new Hono();
    app.use("*", geoJsonPreload);
    app.route("/needs", wfbn);
    expect(await link("/needs/at/sid-valley/", app)).toBe(
      `</needs/at/sid-valley/geo.json>${PARAMS}`,
    );

    // The one route that could NOT survive that move is the index page, and
    // for the reason index.ts already records: a sub-app's own "/" route
    // answers the bare mount point and not the trailing-slash form, so the
    // template becomes "/needs" and no longer equals the "/needs/" literal
    // the middleware looks for. That is why index.ts keeps these root-ish
    // pages registered directly on `app`.
    const rooted = new Hono();
    rooted.get("/", html);
    const app2 = new Hono();
    app2.use("*", geoJsonPreload);
    app2.route("/needs", rooted);
    expect(await link("/needs", app2)).toBeNull();
  });

  it("a router that registers the :locslug catch-all too early mislabels its siblings", async () => {
    // The file header claims route ORDER in index.ts is load-bearing for this
    // middleware. That claim is worth an assertion rather than a comment,
    // because it is the failure mode with no symptom: the pages still render,
    // the header is still present, it just names the wrong file.
    //
    // With :locslug first, Hono matches it for /nearby/ and /news/ too, and
    // routePath becomes "/needs/at/:slug/:locslug/" -- so:
    //   * /nearby/ is handed the food bank's OWN geo.json, the single page
    //     the source has a dedicated branch to keep it away from;
    //   * /news/, which should get no header at all, gets one.
    // Both are invisible until someone measures the map's fetch waterfall.
    //
    // This also guards a Hono upgrade: if the router ever switched to
    // longest-literal-wins instead of registration order, index.ts's careful
    // ordering would become dead weight and this test would say so.
    const misordered = new Hono();
    misordered.use("*", geoJsonPreload);
    misordered.get("/needs/at/:slug/:locslug/", html);
    misordered.get("/needs/at/:slug/nearby/", html);
    misordered.get("/needs/at/:slug/news/", html);
    expect(await link("/needs/at/sid-valley/nearby/", misordered)).toBe(
      `</needs/at/sid-valley/geo.json>${PARAMS}`,
    );
    expect(await link("/needs/at/sid-valley/news/", misordered)).toBe(
      `</needs/at/sid-valley/geo.json>${PARAMS}`,
    );

    // Registered the way index.ts does it, both are correct again. Asserting
    // the corrected pair here (as well as in the tests above) keeps the
    // before/after in one place, so the test explains the ordering rule
    // rather than merely enforcing it.
    const app = siteApp();
    expect(await link("/needs/at/sid-valley/nearby/", app)).toBe(`</needs/geo.json>${PARAMS}`);
    expect(await link("/needs/at/sid-valley/news/", app)).toBeNull();
  });

  it("depends on routePath only being the matched route AFTER next()", async () => {
    // The single assumption the whole middleware rests on, and the reason
    // the module comment says "Runs after routing (it wraps next())". A
    // wildcard-registered middleware sees its OWN pattern, "/*", before
    // next() -- so moving the routePath read above the await, which looks
    // like a harmless tidy-up, matches nothing and disables the header
    // everywhere. Asserted through a sibling middleware because it is a
    // property of Hono, not of this file, and a Hono upgrade could change it.
    const observed: string[] = [];
    const spy: MiddlewareHandler = async (c, next) => {
      observed.push(c.req.routePath);
      await next();
      observed.push(c.req.routePath);
    };
    const app = new Hono();
    app.use("*", spy);
    app.get("/needs/at/:slug/", html);
    await app.request("/needs/at/sid-valley/");
    expect(observed).toEqual(["/*", "/needs/at/:slug/"]);

    // The same asymmetry for params: before next() there is no :slug to read,
    // which is the other half of why the read cannot be hoisted -- a hoisted
    // version would not just miss the route, it would build
    // "/needs/at/undefined/geo.json" if the routePath check somehow passed.
    const params: unknown[] = [];
    const paramSpy: MiddlewareHandler = async (c, next) => {
      params.push(c.req.param("slug"));
      await next();
      params.push(c.req.param("slug"));
    };
    const app2 = new Hono();
    app2.use("*", paramSpy);
    app2.get("/needs/at/:slug/", html);
    await app2.request("/needs/at/sid-valley/");
    expect(params).toEqual([undefined, "sid-valley"]);
  });
});
