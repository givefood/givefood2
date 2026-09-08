import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";
import { gfdashHeatmap } from "./heatmap";

// routes/dashboards/heatmap.ts -- gfdash's `heatmap`
// (gfdash/views.py:467-469 in the Django repo, read alongside this file),
// served at /dashboard/heatmap/ (gfdash/urls.py:26).
//
// WHY THIS FILE EXISTS. The handler is one line and can only fail in ways
// that still produce a 200 with a page on it. Django's view is literally
// `return render(request, "dash/heatmap.html")` -- no template_vars at all --
// so there is no query to get wrong and no number to check. What there IS:
//
//   * THE MAP IS A CLIENT-SIDE CONTRACT WITH THREE HALVES, and every one of
//     them fails silently. The template hardcodes `fetch('/needs/geo.json')`,
//     mounts into a div by id, and filters the returned features by
//     `properties.type === 'f' || 'l'`. Rename the endpoint, rename the div,
//     or change the type codes buildGeojson emits, and this page renders
//     perfectly with a blank grey rectangle where the heatmap was. Nothing
//     server-side notices, and the page is shared-cached for 24 hours while
//     it happens. All three are cross-checked below against the REAL router,
//     the REAL /needs/geo.json response and the rendered page's own script.
//   * "FULLY STATIC: NO DB READS" is the module's own claim about itself and
//     the reason this page cannot go stale against the database. It is
//     asserted here against a database that HAS rows in it, so an empty
//     `prepared` means "the handler did not look" rather than "there was
//     nothing to find".
//   * the two maplibre assets are cache-busted with `?v={{ version }}`, which
//     the Django template (gfdash/templates/dash/heatmap.html, read in full)
//     does not do -- a port addition, and the only thing on this page that
//     comes from a binding.
//
// REAL EVERYTHING, the harness routes/dashboards/charityIncomeExpenditure.test.ts
// uses: the real production app (workers/site/src/index.ts's default export),
// so the route registration, resolveLanguage, cacheTag, geoJsonPreload and
// pageCacheControl are the shipped articles rather than a hand-built router;
// the real Nunjucks templates through the real render(); and real in-memory
// SQLite built by schemaFor() from the real migrations, so the geo.json
// cross-check reads the same _full views production does. Mocked: the two KV
// namespaces, because there is no local double and nothing on this path
// touches them.
//
// MUTATION-TESTED in a copy of the repo outside it -- the list is at the foot
// of this file.

const ORIGIN = "https://www.givefood.org.uk";
const PATH = "/dashboard/heatmap/";

// A version id with no tag, which is the normal production state (see
// middleware/runtimeIdentity.ts: nothing currently tags a deploy). readVersion
// takes the first 8 characters of the id, so every `?v=` on the page below is
// "0192ab34" -- pinned rather than left as the "unknown" fallback, because a
// literal "unknown" would also be what a page that never got the binding
// showed.
const VERSION_ID = "0192ab34-cdef-4567-89ab-cdef01234567";
const VERSION = "0192ab34";

type Bindable = null | number | bigint | string | Uint8Array;

// The slice of the D1 Sessions API packages/db uses, over node:sqlite. Every
// statement text is recorded, because on this page the interesting number is
// zero.
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

let db: DatabaseSync;
let prepared: string[];
let sessions: number;

function env(): AppEnv["Bindings"] {
  return {
    DB: {
      withSession: () => {
        sessions += 1;
        return d1Session(db, prepared);
      },
    },
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: { get: async () => null, put: async () => {}, delete: async () => {} },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    SITE_DOMAIN: ORIGIN,
    CF_VERSION_METADATA: { id: VERSION_ID, tag: "", timestamp: "2026-09-08T09:00:00Z" },
  } as unknown as AppEnv["Bindings"];
}

// ---------------------------------------------------------------------------
// Seeds. Nothing on this page reads them -- that is the point of seeding them:
// they exist so "the handler ran no query" is distinguishable from "the
// database was empty". They are also the fixture for the /needs/geo.json
// cross-check, which is the one place this page's real dependency is visible.
//
// One food bank and one location, at two distinguishable points, because the
// rendered script filters for exactly those two feature type codes ("f" and
// "l") and a fixture with only one of them would pass a filter that had lost
// the other.
// ---------------------------------------------------------------------------

function seed(): void {
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, slug, address, postcode, country, lat_lng, network,
       charity_just_foodbank, contact_email, url, shopping_list_url, address_is_administrative,
       is_closed, no_locations, days_between_needs, created, modified)
     VALUES (1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Salisbury', 'salisbury', '1 High Street', 'SP1 1AA',
       'England', '51.0688,-1.7945', 'Trussell', 0, 'info@salisbury.invalid', 'https://salisbury.invalid/',
       'https://salisbury.invalid/list/', 0, 0, 0, 14, '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run();
  db.prepare(
    `INSERT INTO foodbanklocation (id, uuid, foodbank_id, name, slug, address, postcode, country, lat_lng, is_closed, modified)
     VALUES (1, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 1, 'St Marks', 'st-marks', '2 Low Street', 'SP1 3AA',
       'England', '51.0800,-1.8000', 0, '2020-01-01 00:00:00.000000')`,
  ).run();
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  // The two _full VIEWS are here because /needs/geo.json reads them (not the
  // base tables) -- schemaFor rather than hand-written DDL precisely so that
  // stays true when the view changes underneath this file.
  db.exec(schemaFor("foodbank", "foodbanklocation", "foodbanklocation_full", "foodbankdonationpoint", "foodbankdonationpoint_full"));
  seed();
  prepared = [];
  sessions = 0;
});

afterEach(() => {
  db.close();
});

// `async`, not a bare arrow: app.fetch is typed Response | Promise<Response>.
const get = async (path: string, init?: RequestInit): Promise<Response> => app.fetch(new Request(`${ORIGIN}${path}`, init), env(), execCtx);
const getBody = async (path: string): Promise<string> => (await get(path)).text();

// ---------------------------------------------------------------------------
// Reading the page. Everything the map needs is a literal in the inline
// script, so these pull the literals back out rather than asserting on a blob
// of HTML -- a changed value then fails as a value, not as a missing
// substring.
// ---------------------------------------------------------------------------

const mapContainerId = (body: string) => /container: '([^']*)'/.exec(body)?.[1];
const mapDivId = (body: string) => /<div id="([^"]*)" style="width:700px;height:1000px;"><\/div>/.exec(body)?.[1];
const fetchedUrl = (body: string) => /fetch\('([^']*)'\)/.exec(body)?.[1];
const filteredTypeCodes = (body: string) => [...body.matchAll(/f\.properties\.type === '([^']*)'/g)].map((m) => m[1] as string);

// The debug comment carries the wall clock and the render timer, the only two
// things on this page that CAN differ between two identical requests. Stripped
// so the rest can be compared byte for byte.
const withoutDebugComment = (body: string) => body.replace(/<!--[\s\S]*?-->/, "");

describe("gfdashHeatmap -- GET /dashboard/heatmap/", () => {
  // -------------------------------------------------------------------
  // The one thing the handler does.
  // -------------------------------------------------------------------

  // NO DATABASE, AT ALL -- against a seeded database, so this says the handler
  // did not look rather than that there was nothing to find. lib/session.ts
  // opens exactly one withSession("first-unconstrained") per request that
  // needs one, so `sessions` catches a handler that opened a session and then
  // read nothing, which `prepared` alone would not. Both are the module's own
  // claim about itself ("Fully static: no DB reads") and the reason this page
  // can be shared-cached for a day without going stale against the data.
  it("renders the page without opening a D1 session or preparing a single statement", async () => {
    const res = await get(PATH);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(prepared).toEqual([]);
    expect(sessions).toBe(0);
    expect(body).toContain("<title>Food Bank Heatmap - Give Food</title>");
    expect(body).toContain("<h1>Food Bank Heatmap</h1>");
    expect(body).toContain("<p>Heatmap of food bank and location density across the UK</p>");
  });

  // The breadcrumb is the only navigation on the page and both links go
  // through the real url() reverse table (@givefood/urls), not through
  // hardcoded hrefs -- so these are the values that table produces for
  // 'index' and 'dash:index'. A wrong name there does not render an empty
  // href, it throws at render time; a name pointing at the WRONG route
  // renders a link to the wrong page, which is what these two values pin.
  it("links the breadcrumb at the home page and the dashboard index", async () => {
    const body = await getBody(PATH);

    expect(body).toContain('<li><a href="/">Home</a></li>');
    expect(body).toContain('<li><a href="/dashboard/">Dashboards</a></li>');
    expect(body).toContain('<li class="is-active"><a href="#" aria-current="page">Heatmap</a></li>');
  });

  // -------------------------------------------------------------------
  // The client-side contract. Everything below is a way this page can be
  // completely broken while returning 200 and looking fine in a diff.
  // -------------------------------------------------------------------

  // THE DIV AND THE SCRIPT MUST AGREE ON ONE STRING. maplibre's
  // `container: 'the-map'` is looked up by id at DOMContentLoaded; when it
  // misses, the constructor throws inside an event listener -- server-side
  // there is nothing to see, and in the browser the page is complete except
  // for a 700x1000 hole. Both halves are read out of the rendered page and
  // compared to each other, so renaming one alone fails here however it is
  // spelled.
  //
  // The 700x1000 pixel box is fixed, not responsive, and is byte-identical to
  // the Django template it was ported from (gfdash/templates/dash/heatmap.html
  // line 29, read directly) -- pinned as ported behaviour, not endorsed.
  it("mounts the map into the div it actually renders", async () => {
    const body = await getBody(PATH);

    expect(mapDivId(body)).toBe("the-map");
    expect(mapContainerId(body)).toBe("the-map");
    expect(body).toContain('<div id="the-map" style="width:700px;height:1000px;"></div>');
  });

  // THE FETCH TARGET IS A HARDCODED STRING IN A TEMPLATE, checked here against
  // the real app's own route table. /needs/geo.json is registered by
  // index.ts (and, separately, under each locale prefix); if it were renamed
  // or moved, every server-side test of THAT route would follow it and this
  // page would be the only casualty -- a 404 inside a .catch() that does
  // nothing but console.error.
  it("fetches a URL that is really a GET route on this app", async () => {
    const body = await getBody(PATH);

    expect(fetchedUrl(body)).toBe("/needs/geo.json");
    expect(app.routes.some((route) => route.method === "GET" && route.path === "/needs/geo.json")).toBe(true);
  });

  // THE TYPE CODES, END TO END. The script keeps only features whose
  // `properties.type` is "f" or "l" and whose geometry is a Point;
  // lib/buildGeojson.ts writes those codes as string literals at the other
  // end. Nothing connects the two but this assertion: change either side and
  // the filter quietly matches nothing, which is a blank map on a 200 page.
  //
  // Done against the REAL /needs/geo.json on the REAL app with the fixture's
  // one food bank and one location, and the script's own predicate applied to
  // the parsed body -- so it is the actual filter running over the actual
  // feed, not two constants compared to each other.
  it("filters for exactly the feature types /needs/geo.json emits", async () => {
    const codes = filteredTypeCodes(await getBody(PATH));
    expect(codes).toEqual(["f", "l"]);

    const geo = await get("/needs/geo.json");
    expect(geo.status).toBe(200);
    const collection = JSON.parse(await geo.text()) as {
      features: Array<{ geometry: { type: string }; properties: { type: string; name: string } }>;
    };

    // The template's predicate, transcribed.
    const kept = collection.features.filter((f) => (f.properties.type === codes[0] || f.properties.type === codes[1]) && f.geometry.type === "Point");

    // "Salisbury Foodbank" from a food bank seeded as "Salisbury": the feed
    // builds display names through @givefood/models' fullNameLocaleAware, and
    // the name is asserted here only to prove these are the two seeded rows
    // rather than two features from anywhere else.
    expect(kept.map((f) => [f.properties.type, f.properties.name])).toEqual([
      ["f", "Salisbury Foodbank"],
      ["l", "St Marks"],
    ]);
  });

  // NO Link: rel=preload, EVEN THOUGH THIS PAGE FETCHES geo.json ON LOAD.
  // middleware/geoJsonPreload.ts adds the hint only for /needs/ and the food
  // bank pages, and Django's GeoJSONPreload (givefood/middleware.py:95-130)
  // is the same list keyed on url_name -- 'heatmap' is in neither. So the
  // absence is faithful to the original rather than a porting slip, and it is
  // pinned here because it is a missed round trip somebody may want to close
  // deliberately rather than discover by accident.
  it("sends no geojson preload hint, matching the Django middleware's route list", async () => {
    const res = await get(PATH);

    expect(res.headers.get("Link")).toBeNull();
  });

  // -------------------------------------------------------------------
  // The version stamp -- the only value on this page that comes from a
  // binding.
  // -------------------------------------------------------------------

  // `?v={{ version }}` ON THE TWO MAPLIBRE ASSETS. The Django template links
  // /static/css/maplibre-gl.css and /static/js/maplibre-gl.js with no query
  // string at all (read directly, lines 38-39), so this is a port addition:
  // the static assets are served immutable, and the query string is how a new
  // deploy stops a browser using the previous build's copy. Rendering
  // "unknown" here (buildPageContext's fallback when middleware/runtimeIdentity
  // never ran) would look identical on any single deploy and pin every visitor
  // to whichever maplibre they cached first.
  it("cache-busts both maplibre assets with the deployed Worker version", async () => {
    const body = await getBody(PATH);

    expect(body).toContain(`<link rel="stylesheet" href="/static/css/maplibre-gl.css?v=${VERSION}">`);
    expect(body).toContain(`<script src="/static/js/maplibre-gl.js?v=${VERSION}" defer></script>`);
    expect(body).not.toContain("?v=unknown");
  });

  // -------------------------------------------------------------------
  // The response envelope.
  // -------------------------------------------------------------------

  // THE ONE PAGE IN THIS DIRECTORY WHOSE TTL MATCHES DJANGO EXACTLY.
  // gfdash's heatmap carries @cache_page(SECONDS_IN_DAY) and
  // givefood/const/cache_times.py defines that as 24 * SECONDS_IN_HOUR =
  // 86400 -- the same s-maxage middleware/pageCacheControl.ts's fall-through
  // gives it. (The browser's max-age=300 is that middleware's documented,
  // deliberate divergence, applied site-wide.) Cache-Tag is null because
  // middleware/cacheTag.ts has no rule for /dashboard/, which is correct
  // here in a way it is not for the data-backed dashboards: this page has no
  // dependency for a purge to be triggered by.
  it("serves cacheable, untagged HTML for a day, the same day Django cached it for", async () => {
    const res = await get(PATH);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    expect(res.headers.get("Cache-Tag")).toBeNull();
    expect(res.headers.get("Content-Language")).toBe("en");
  });

  // A DAY IN A SHARED CACHE IS ONLY SAFE IF ONE URL HAS ONE REPRESENTATION.
  // resolveLanguage.ts deliberately emits no `Vary: Accept-Language` (issue
  // #39) and ignores the header entirely, so a Welsh-preferring visitor gets
  // the identical English page and the edge keeps one object. Asserted on
  // this page because it is cached for 86400 seconds: a Vary appearing here
  // would fragment that, and negotiation appearing here would serve one
  // visitor's language to everyone.
  it("ignores Accept-Language, and offers the edge no reason to vary on it", async () => {
    const res = await get(PATH, { headers: { "Accept-Language": "cy,en;q=0.9" } });

    expect(res.headers.get("Content-Language")).toBe("en");
    expect(res.headers.get("Vary")).toBeNull();
  });

  // buildPageContext + elapsedMs, the two halves of pageContext(). The debug
  // comment in includes/debugcomment.njk is the only consumer of
  // render_time_ms, and with the key missing it renders "Took ms" -- a page
  // that still looks perfect. `Took \d+` also pins the whole-millisecond
  // rounding elapsedMs() does deliberately (see its comment: three digits of
  // guaranteed ".000" read like precision Workers' coarsened timers cannot
  // supply).
  it("puts the canonical URL, the flag link and a numeric render time on the page", async () => {
    const body = await getBody(PATH);

    expect(body).toContain(`<link rel="canonical" href="${ORIGIN}${PATH}">`);
    expect(body).toContain(`<a href="/flag/#${ORIGIN}${PATH}"`);
    expect(body).toMatch(/⏱️ Took \d+ms/);
  });

  // "FULLY STATIC" IN THE STRONGEST FORM AVAILABLE: two requests, byte-identical
  // once the debug comment (wall clock, render timer) is removed. Everything
  // else on the page -- the version stamp, the isolate id, the language, the
  // whole map config -- is a constant, and this is the assertion that would
  // catch a value quietly becoming request-dependent, which on a page cached
  // for 24 hours means one visitor's copy is served to everyone.
  it("renders the same bytes twice over, apart from the clock in the debug comment", async () => {
    const first = await getBody(PATH);
    const second = await getBody(PATH);

    expect(withoutDebugComment(second)).toBe(withoutDebugComment(first));
    // Two empty strings are also equal: this is what makes the line above an
    // assertion about a whole page rather than about a failed render.
    expect(withoutDebugComment(first)).toContain("<h1>Food Bank Heatmap</h1>");
    // And the comment really was there to strip -- otherwise the clock and the
    // timer were being compared too, and this test would be flaky rather than
    // strict.
    expect(first).toMatch(/<!--[\s\S]*Took \d+ms[\s\S]*-->/);
  });

  // -------------------------------------------------------------------
  // The routing around it.
  // -------------------------------------------------------------------

  // ONE REGISTRATION, GET ONLY, AND IT IS THIS MODULE'S EXPORT. Read off the
  // real app's route table rather than inferred from a response, so it fails
  // on an `app.all()` creeping in (this repo has already shipped a GET route
  // able to run an UPDATE) and on the path being wired to a different
  // handler -- gfdashIndex and gfdashHeatmap are the same three lines apart
  // from a template name, and swapping them would still 200.
  it("is registered exactly once, as GET, pointing at gfdashHeatmap", async () => {
    const rows = app.routes.filter((route) => route.path === PATH);

    expect(rows.map((route) => route.method)).toEqual(["GET"]);
    expect(rows[0]?.handler).toBe(gfdashHeatmap);
  });

  // The router half of the same fact. The query count is what makes this mean
  // "the handler did not run" rather than "the response happened to be a 404".
  it("does not answer POST at all", async () => {
    const res = await get(PATH, { method: "POST" });

    expect(res.status).toBe(404);
    expect(prepared).toEqual([]);
    expect(sessions).toBe(0);
  });

  // HEAD MUST WORK, and not only because browsers send it: lib/appendSlash.ts
  // probes the slashed URL with HEAD to decide whether to 301, so a route
  // that answered GET alone would silently turn the redirect below into a 404
  // page.
  it("answers HEAD with the same headers and no body", async () => {
    const res = await get(PATH, { method: "HEAD" });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(await res.text()).toBe("");
  });

  // Django's APPEND_SLASH, via lib/appendSlash.ts. gfdash/urls.py registers
  // this path WITH the slash and every inbound link uses it, so the unslashed
  // form only ever arrives hand-typed or from an old bookmark.
  it("301s the unslashed URL onto the canonical one", async () => {
    const res = await get("/dashboard/heatmap");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}${PATH}`);
  });

  // gfdash sits in givefood/urls.py's "Untranslated apps" block (line 91
  // onwards), outside i18n_patterns -- so there is no /cy/dashboard/... URL,
  // and buildPageContext is called with no locale, which is what leaves
  // `languages` empty and suppresses the hreflang block in page.njk. A route
  // registered under index.ts's LOCALES loop by mistake would 200 here.
  it("has no language-prefixed form and advertises no translations", async () => {
    const welsh = await get(`/cy${PATH}`);
    expect(welsh.status).toBe(404);
    // Nothing was rendered-then-discarded for it: the 404 is the router's.
    expect(sessions).toBe(0);

    expect(await getBody(PATH)).not.toContain('rel="alternate" hreflang');
  });

  // The querystring is dropped from `flag_path` because pageContext() passes
  // only `c.req.path` to buildPageContext (no `querystring`), unlike the
  // routes that do. Pinned rather than filed: this page takes no query
  // parameters, so the only thing a query can do is arrive from a tracking
  // link, and the flag link should point at the page rather than at the link
  // that reached it. Every other gfdash handler is written the same way.
  it("ignores the querystring entirely, including in the canonical and flag links", async () => {
    const body = await getBody(`${PATH}?utm_source=newsletter`);

    expect(body).toContain(`<link rel="canonical" href="${ORIGIN}${PATH}">`);
    expect(body).toContain(`<a href="/flag/#${ORIGIN}${PATH}"`);
    expect(body).not.toContain("utm_source");
  });
});

// MUTANTS KILLED, in a copy of this repo under the scratchpad (never edited in
// place). Each was applied alone -- to heatmap.ts, to dash/heatmap.njk, to
// index.ts's route line, or to the middleware the assertion names -- and this
// file re-run:
//   1. template "dash/heatmap.njk" -> "dash/index.njk"  -> title/h1/map div,
//                                                          and 6 others
//   2. c.html(...) -> c.text(...)                       -> Content-Type, and
//                                                          the Cache-Control
//                                                          that vanishes with it
//   3. `render_time_ms` dropped from pageContext()      -> "Took Nms"
//   4. buildPageContext({ path: "/dashboard/" })        -> canonical/flag link
//   5. a getAllOpenFoodbanks(dbSession(c)) added to the handler
//                                                       -> prepared/sessions
//   6. app.get(PATH, ...) -> app.all(PATH, ...)         -> the registration
//                                                          test and POST
//   7. app.get(PATH, gfdashIndex)                       -> the registration test
//   8. template's `container: 'the-map'` -> 'themap'    -> the mount test
//   9. template's div id "the-map" -> "map", script left alone
//                                                       -> the mount test
//                                                          (the other direction)
//  10. template's `fetch('/needs/geo.json')` -> '/needs/geojson'
//                                                       -> the route-table test
//  11. template's type filter 'f'/'l' -> 'fb'/'loc'     -> the end-to-end
//                                                          geo.json test
//  12. `?v={{ version }}` dropped from the maplibre <script>
//                                                       -> the cache-bust test
//  13. the same, from the maplibre <link> instead       -> the cache-bust test
//  14. geoJsonPreload.ts given a "/dashboard/heatmap/" rule
//                                                       -> the no-Link test
//  15. the route also registered under every locale prefix
//                                                       -> the /cy/ 404 test
//  16. pageCacheControl.ts's fall-through DAY -> HOUR   -> the TTL test
//  17. cacheTag.ts extended to tag "/dashboard/"        -> the Cache-Tag test
//
// ONE MUTANT SURVIVED, AND IS A NO-OP RATHER THAN A GAP: dropping the `await`
// in `c.html(await render(...))` changes not one byte of the response, because
// Hono's c.html() accepts a Promise<string> and resolves it itself. Recorded
// here so nobody spends the afternoon writing the test that catches it.
