import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import app from "../../index";
import { wfbnGetLocation } from "./getLocation";
import type { AppEnv } from "../../types";
import type { Env } from "../../../worker-configuration";

// routes/wfbn/getLocation.ts -- the "Use my location" link on the wfbn index
// (gfwfbn/templates/wfbn/index.html:60, an <a> with data-no-instant, so this
// is the NO-JAVASCRIPT path to a nearest-food-bank search). Django's
// gfwfbn/views.py:192-204 `@never_cache def get_location`, read at
// /Users/jasoncartwright/Sites/foodcharity.
//
// WHY A ROUTE THIS SMALL IS WORTH THIS MUCH TEST. Everything it produces is
// in a header. There is no body to look wrong, no template to fail to render,
// and no database row to read back afterwards -- so every one of its failure
// modes lands the visitor on a *working* /needs/ page that simply has not
// geolocated them, which looks like "the browser did not share my location"
// and gets blamed on the browser. A swapped lat/lng pair sends someone in
// Devon to a food bank in Kazakhstan; a dropped locale prefix drops a Welsh
// visitor out of Welsh; a `&&` for a `||` sends "50.1,undefined" downstream.
// None of those is visible from the outside without asserting the exact
// Location string, which is what nearly every test below does.
//
// REAL APP, REAL MIDDLEWARE ORDER. `app` is the default export of
// workers/site/src/index.ts, so each request unwinds through the real chain
// (serverTiming, securityHeaders, cacheTag, runtimeIdentity, slugRedirect,
// resolveLanguage, geoJsonPreload, pageCacheControl) and through the real
// route registrations -- the bare /needs/getlocation/ and the three
// LOCALES-derived prefixed ones. That matters more here than for most
// handlers: the ONLY input to the locale half of this function is
// `c.get("lang")`, which nothing but resolveLanguage sets, and the only
// evidence the four registrations exist is that four URLs answer. A
// hand-built router with `lang` stuffed in by the test would assert neither.
//
// THE ARCHITECTURE CHANGE IS NOT A BUG, and these tests do not treat it as
// one: Django calls freeipapi.com over HTTP on every request; the Worker
// reads `request.cf.latitude`/`.longitude`, which Cloudflare has already
// computed at the edge. The observable contract (302 to the index carrying
// lat_lng, 400 when the coordinates cannot be had) is the same, and that
// contract is what is pinned. See the module's own header for the reasoning.
//
// MUTATION TESTED, not assumed. The repo was copied outside the tree (see
// TESTING.md's "No scratch files") and getLocation.ts -- plus its two
// registration lines in index.ts -- broken one edit at a time in the COPY:
// 22 mutants, all 22 caught. Weakening the guard four ways (`||` -> `&&`,
// deleted, latitude only, longitude only, `=== undefined` instead of
// falsy), changing the 400's status to 404/200, giving it a body or
// c.html() for c.text(), hardcoding the locale, swapping latitude and
// longitude, renaming the lat_lng parameter, encoding the comma, adding
// encodeURIComponent, making the Location absolute, merging the inbound
// query string in, 301/307 for 302, stamping a Cache-Control, registering
// the route as app.all, and dropping the prefixed registration.
//
// `||` -> `&&` is the one that took the most tests to corner: it is
// invisible unless exactly one coordinate is missing, which is why the 400
// block below has a row per single-field cf rather than one "no cf" test.

const ORIGIN = "https://www.givefood.org.uk";

// Hono's fetch() wants an ExecutionContext; nothing on this path touches it.
const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

// NO BINDINGS, AND THE ONES THAT WOULD MATTER THROW. This route must answer
// from `request.cf` alone -- that is the entire point of the divergence from
// Django's freeipapi call, and the reason it cannot fail the way a live
// third-party lookup can. An env whose D1/KV/R2/queue getters raise turns
// "someone added a database read to the geolocation redirect" from a silent
// latency regression into a 500 that every test in this file fails on.
// CF_VERSION_METADATA is left plainly absent because middleware/runtimeIdentity.ts
// legitimately reads it on every request; it is not this route's dependency.
const env = (() => {
  const forbidden = [
    "DB",
    "MEDIA",
    "GEO",
    "STATIC_MEDIA",
    "ASSETS",
    "IMAGES",
    "BROWSER",
    "SESSIONS",
    "DATA",
    "HITS",
    "PURGE_Q",
    "JOBS_Q",
    "WHATSAPP_Q",
    "RENDER_Q",
  ];
  const bindings: Record<string, unknown> = {};
  for (const name of forbidden) {
    Object.defineProperty(bindings, name, {
      get() {
        throw new Error(`getLocation must not touch the ${name} binding`);
      },
      enumerable: true,
    });
  }
  return bindings as unknown as Env;
})();

/**
 * One request through the real app. `cf` is defined on the Request rather than
 * passed in an init bag because node's Request has no such field and workerd's
 * does -- the handler has to read it off `c.req.raw.cf` exactly as it does in
 * production. Omitting the argument entirely means "no cf at all", which is
 * the non-Cloudflare-proxied case (`wrangler dev`, a direct-to-origin request).
 */
async function serve(path: string, cf?: Record<string, unknown> | null, method = "GET"): Promise<Response> {
  const request = new Request(`${ORIGIN}${path}`, { method });
  if (cf !== undefined) Object.defineProperty(request, "cf", { value: cf, enumerable: true });
  return app.fetch(request, env, execCtx);
}

/** Sidmouth, to five decimal places -- the shape Cloudflare actually puts in `cf`: strings, not numbers. */
const SIDMOUTH = { latitude: "50.68740", longitude: "-3.24050" };

describe("wfbnGetLocation: the redirect", () => {
  it("302s to the wfbn index carrying the edge's own coordinates as lat_lng", async () => {
    // The whole contract, and the assertion every other test in the file
    // leans on. Django built "%s?lat_lng=%s,%s" % (reverse("wfbn:index"),
    // latitude, longitude) and returned redirect(); this is the same string
    // from `cf` instead of freeipapi's JSON.
    //
    // The Location is asserted WHOLE. A `toContain("lat_lng")` would survive
    // the swapped-arguments mutant, the wrong-separator mutant and the
    // absolute-URL mutant all at once, and those are three of the four things
    // that can actually go wrong here.
    const res = await serve("/needs/getlocation/", SIDMOUTH);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/needs/?lat_lng=50.68740,-3.24050");
    // Relative, like Django's reverse() output -- not rewritten to an
    // absolute https://www.givefood.org.uk/... form, which would pin the
    // redirect to one hostname and break beta/preview deployments.
    expect(res.headers.get("Location")!.startsWith("/")).toBe(true);
    // A redirect has nothing to say; Django's HttpResponseRedirect has no
    // body either.
    expect(await res.text()).toBe("");
  });

  it("prefixes the index with the requesting locale, in every language the router registers", async () => {
    // gfwfbn/urls/i18n.py:12 puts getlocation/ inside i18n_patterns and
    // givefood/urls.py:58 sets prefix_default_language=False, so Django's
    // reverse("wfbn:index") under an active language returns "/cy/needs/"
    // and under English returns "/needs/". packages/urls' urlForLocale does
    // the same via I18N_SCOPED, and this is the test that says so.
    //
    // KILLS THE HARDCODED-LOCALE MUTANT: `url("wfbn:index")`, or
    // urlForLocale("en", ...), passes the English test above and sends every
    // Welsh, Irish and Scottish Gaelic visitor who clicks "Use my location"
    // out of their own language for the rest of the session.
    //
    // Content-Language is asserted alongside as the evidence that the locale
    // reaching the handler is the one resolveLanguage resolved from the path,
    // rather than something the test arranged.
    for (const [prefix, locale] of [
      ["", "en"],
      ["/cy", "cy"],
      ["/ga", "ga"],
      ["/gd", "gd"],
    ]) {
      const res = await serve(`${prefix}/needs/getlocation/`, SIDMOUTH);
      expect(res.status, locale).toBe(302);
      expect(res.headers.get("Location"), locale).toBe(`${prefix}/needs/?lat_lng=50.68740,-3.24050`);
      expect(res.headers.get("Content-Language"), locale).toBe(locale);
    }
  });

  it("throws away the incoming query string instead of merging into it", async () => {
    // The target is BUILT from urlForLocale, not derived from the request
    // URL, so a caller cannot smuggle parameters through -- and, more to the
    // point, an inbound `lat_lng` of their own cannot survive alongside the
    // real one. Two lat_lng parameters would leave which coordinates the
    // index page reads up to its own client-side parser.
    const res = await serve("/needs/getlocation/?foo=bar&lat_lng=1,2", SIDMOUTH);

    expect(res.headers.get("Location")).toBe("/needs/?lat_lng=50.68740,-3.24050");
    expect(res.headers.get("Location")).not.toContain("foo=bar");
  });

  it("answers HEAD with the same redirect it answers GET with", async () => {
    // Hono resolves HEAD against a GET registration, so a browser or link
    // prefetcher sending HEAD gets a real, visitor-specific Location back.
    // Recorded rather than assumed: it is the reason the slashless 301 below
    // works at all (lib/appendSlash.ts probes with HEAD), and the reason the
    // missing Cache-Control in the next block is worth caring about.
    const res = await serve("/needs/getlocation/", SIDMOUTH, "HEAD");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/needs/?lat_lng=50.68740,-3.24050");
  });

  it("gives the same answer twice for the same request, writing nothing", async () => {
    // There is no state here -- no counter, no hit row, no queue send -- and
    // this pins that there is not. The throwing bindings on `env` mean a
    // handler that started recording locations would fail rather than pass
    // quietly, and two identical requests producing two identical Locations
    // means nothing accumulated between them.
    const first = await serve("/needs/getlocation/", SIDMOUTH);
    const second = await serve("/needs/getlocation/", SIDMOUTH);

    expect(second.headers.get("Location")).toBe(first.headers.get("Location"));
    expect(second.status).toBe(first.status);
  });
});

describe("wfbnGetLocation: when the edge has no coordinates", () => {
  it("400s with an empty body and no Location when `cf` is absent entirely", async () => {
    // The one case the module's header calls out as a divergence from
    // Django's always-attempt-a-lookup behaviour: a request that did not come
    // through Cloudflare's proxy (local `wrangler dev` without a simulated
    // `cf`, or a direct-to-origin hit) has no coordinates to redirect with.
    // Django's failed freeipapi lookup returned HttpResponseBadRequest(), and
    // so does this -- verified against Django 5.2.6 on this machine: an empty
    // body, exactly as here.
    const res = await serve("/needs/getlocation/");

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("");
    // KILLS THE "REDIRECT ANYWAY" MUTANT. Dropping the guard produces a 302
    // to "/needs/?lat_lng=undefined,undefined", which is a 200 page for the
    // visitor and a nonsense search -- the failure this endpoint's whole
    // guard exists to prevent, and one that no status-code assertion alone
    // would catch if the status were left at 302.
    expect(res.headers.get("Location")).toBeNull();
  });

  it("400s when either coordinate alone is missing, not just when both are", async () => {
    // THE `||` -> `&&` MUTANT, and the only shape that catches it: with
    // `&&`, a cf carrying just a latitude redirects to
    // "/needs/?lat_lng=50.1,undefined". Every other test in this file passes
    // under that mutation, because every other test supplies both fields or
    // neither.
    //
    // `null` is in the table because `c.req.raw.cf as {...} | undefined` is a
    // cast, not a check: the optional chain is what actually handles it, and
    // a rewrite to `const cf = c.req.raw.cf ?? {}` would throw on null.
    for (const cf of [{ latitude: "50.68740" }, { longitude: "-3.24050" }, {}, null]) {
      const res = await serve("/needs/getlocation/", cf);
      expect(res.status, JSON.stringify(cf)).toBe(400);
      expect(res.headers.get("Location"), JSON.stringify(cf)).toBeNull();
    }
  });

  it("treats empty-string coordinates as absent", async () => {
    // `!cf.latitude` is a falsiness test, not a presence test. Cloudflare
    // does occasionally hand back an empty string rather than omitting a
    // field, and "" would otherwise redirect to "/needs/?lat_lng=," -- a
    // request the index page's own nearest-search cannot do anything with.
    const res = await serve("/needs/getlocation/", { latitude: "", longitude: "" });

    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
  });

  it('does NOT reject "0","0" -- null island is a location, and a string zero is truthy', async () => {
    // The boundary that makes the falsiness test above safe for real data:
    // `cf` fields are STRINGS, and "0" is truthy in JavaScript, so the Gulf
    // of Guinea redirects like anywhere else. Anyone tightening the guard to
    // an explicit `=== ""` or a Number() coercion has to keep this working.
    const res = await serve("/needs/getlocation/", { latitude: "0", longitude: "0" });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/needs/?lat_lng=0,0");
  });

  it("400s on a NUMERIC zero, which is a latent trap rather than a reachable one", async () => {
    // SUSPECT, PINNED AS-IS. `cf` is typed `any` by @cloudflare/workers-types
    // and the module narrows it to `{ latitude?: string }` by cast, so
    // nothing checks that the runtime really sends strings. If it ever sent
    // numbers, a latitude or longitude of exactly 0 would be falsy and this
    // endpoint would 400 on the equator and the prime meridian while working
    // everywhere else -- an intermittent failure nobody would reproduce.
    //
    // Not a bug today: Cloudflare documents these as strings, and the
    // string-typed case immediately above is the one production takes. The
    // numeric case is pinned so that the day someone "simplifies" the guard,
    // the difference between the two rows is on the record.
    const zero = await serve("/needs/getlocation/", { latitude: 0, longitude: 0 });
    expect(zero.status).toBe(400);

    // Non-zero numbers do go through, which is what makes the above a
    // zero-specific trap rather than a type check.
    const nonZero = await serve("/needs/getlocation/", { latitude: 50.6874, longitude: -3.2405 });
    expect(nonZero.status).toBe(302);
    expect(nonZero.headers.get("Location")).toBe("/needs/?lat_lng=50.6874,-3.2405");
  });
});

describe("wfbnGetLocation: cacheability", () => {
  it("sets no Cache-Control on the redirect, and nothing downstream fills the gap", async () => {
    // WHAT THIS PROTECTS. The Location on a 200-shaped response would be
    // stamped `public, max-age=300, s-maxage=86400` by
    // middleware/pageCacheControl.ts, which fills the gap on any GET that
    // reaches it without a Cache-Control of its own. It does not here for one
    // reason only -- its `c.res.status !== 200` guard -- and this response is
    // as per-visitor as anything on the site: it carries the requester's own
    // coordinates. That is precisely the shape of the /frag/ip-address/ leak
    // recorded in pageCacheControl.ts's own comments (a stranger's IPv6
    // served from the edge at age 1427). Anyone converting this route to an
    // interstitial 200 page has to notice this test.
    //
    // DIVERGENCE FROM DJANGO, and the module header overstates the parity:
    // it says "@never_cache in Django -- no Cache-Control set here either,
    // matching that", but @never_cache does not withhold a header, it ADDS
    // one. Verified by running Django 5.2.6 on this machine (the version
    // `python3 -c "import django"` reports here) with a @never_cache view:
    // the response comes back with `Cache-Control: max-age=0, no-cache,
    // no-store, must-revalidate, private` and an `Expires` header. This port
    // sends neither. Pinned as the current behaviour, and reported.
    for (const path of ["/needs/getlocation/", "/cy/needs/getlocation/"]) {
      const res = await serve(path, SIDMOUTH);
      expect(res.headers.get("Cache-Control"), path).toBeNull();
      expect(res.headers.get("CDN-Cache-Control"), path).toBeNull();
      // middleware/cacheTag.ts skips non-2xx, so there is no tag on this
      // response and queues/cachePurge.ts could never purge it if the edge
      // did hold a copy. Recorded together with the line above because the
      // two facts only matter as a pair.
      expect(res.headers.get("Cache-Tag"), path).toBeNull();
    }
  });

  it("sets no Cache-Control on the 400 either", async () => {
    // Same guard, other branch: the 400 is text/plain, and text/plain was
    // deliberately removed from pageCacheControl.ts's CACHEABLE_TYPES after
    // the /frag/ip-address/ incident. Both reasons it is uncached are worth
    // keeping true, so both branches are asserted rather than one.
    const res = await serve("/needs/getlocation/");

    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=UTF-8");
  });
});

describe("wfbnGetLocation: where the route does and does not exist", () => {
  it("answers at exactly the four registered spellings and 404s at any other prefix", async () => {
    // /en/ must 404 -- prefix_default_language=False means Django never had
    // an /en/ URL either, and resolveLanguage.ts's PREFIXES comment says so
    // explicitly. /pl/ stands for the seventeen Django languages this port
    // does not serve (PLAN.md §2.7.1): they fall through to the same "no
    // prefix => en" path, which means no route matches and the 404 page is
    // rendered in English.
    //
    // A real cf is supplied so a failure here cannot be mistaken for the 400
    // branch firing.
    for (const path of ["/en/needs/getlocation/", "/pl/needs/getlocation/"]) {
      const res = await serve(path, SIDMOUTH);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("Location"), path).toBeNull();
    }
  });

  it("404s a POST, where Django's view would have geolocated it", async () => {
    // DIVERGENCE, PINNED. gfwfbn/views.py's get_location carries no
    // @require_GET, so Django answered any method; index.ts registers this
    // handler with app.get() alone. Unreachable in practice -- the only
    // caller is an <a href> in wfbn/index.html -- and the 404 is the safer
    // of the two behaviours, but it is a difference, and a difference nobody
    // wrote down is a difference someone eventually "fixes" in the wrong
    // direction.
    const res = await serve("/needs/getlocation/", SIDMOUTH, "POST");

    expect(res.status).toBe(404);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("301s the slashless URL onto the slashed one even for a request with no cf", async () => {
    // Django's APPEND_SLASH, reproduced by lib/appendSlash.ts, which decides
    // by sending a HEAD probe at the slashed path and redirecting unless it
    // 404s. The probe Request is built fresh and therefore carries NO `cf`,
    // so the probe's answer is this route's 400 -- not a 404 -- and the
    // redirect happens. A future guard that answered 404 instead of 400 for
    // a missing `cf` would silently take /needs/getlocation away from every
    // visitor who typed it without the trailing slash.
    for (const [path, expected] of [
      ["/needs/getlocation", `${ORIGIN}/needs/getlocation/`],
      ["/cy/needs/getlocation", `${ORIGIN}/cy/needs/getlocation/`],
    ]) {
      const res = await serve(path!);
      expect(res.status, path).toBe(301);
      expect(res.headers.get("Location"), path).toBe(expected);
    }
  });
});

describe("wfbnGetLocation: what it does with the value in `cf`", () => {
  it("interpolates the coordinates verbatim -- there is no encoding step", async () => {
    // TRIPWIRE, NOT AN ENDORSEMENT. Neither coordinate goes through
    // encodeURIComponent, so whatever `cf` holds is spliced straight into a
    // Location header's query string. Django did the same ("%s?lat_lng=%s,%s"
    // over freeipapi's JSON), so this is faithful, and it is latent rather
    // than exploitable: `cf` is computed by Cloudflare at the edge, not by
    // the client, and no request header influences it.
    //
    // It is pinned because the day that stops being true, this is the line
    // that has to change: the "#" below ends the query string as far as any
    // browser is concerned, so the lat_lng the index page receives is not the
    // one this handler thought it sent.
    //
    // If encodeURIComponent is ever added ON PURPOSE, update this test rather
    // than deleting it -- the comma between the two values must stay
    // unencoded either way or the index page's parser stops splitting on it.
    const res = await serve("/needs/getlocation/", { latitude: "1 2&x=y#z", longitude: "3" });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/needs/?lat_lng=1 2&x=y#z,3");
  });

  it("reads the locale from the context, with no fallback if nothing set it", async () => {
    // The handler's only non-`cf` input is `c.get("lang")`, and it casts it
    // to the four-locale union rather than checking it. Mounted without
    // middleware/resolveLanguage.ts -- which is how it would behave if these
    // routes were ever moved into a sub-app mounted above that middleware --
    // it does not fall back to English: it builds a literal "/undefined/"
    // prefix, because packages/urls' urlForLocale treats anything that is not
    // "en" as a prefixable locale.
    //
    // The real app never produces this (resolveLanguage is app.use("*") and
    // is registered before every route), which is exactly why it is worth
    // recording: the failure would be a 302 into a 404, on every language,
    // and nothing in the handler would flag it.
    const bare = new Hono<AppEnv>();
    bare.get("/needs/getlocation/", wfbnGetLocation);

    const request = new Request(`${ORIGIN}/needs/getlocation/`);
    Object.defineProperty(request, "cf", { value: SIDMOUTH, enumerable: true });
    const res = await bare.fetch(request, env, execCtx);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/undefined/needs/?lat_lng=50.68740,-3.24050");
  });
});
