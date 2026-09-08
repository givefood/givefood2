import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/wfbn/screenshot.ts -- wfbnFoodbankScreenshot, the only exported
// symbol in the file. Ported from gfwfbn `foodbank_screenshot`
// (gfwfbn/views.py:527-554) over get_screenshot()
// (givefood/utils/general.py:27-58), registered at gfwfbn/urls/generic.py:14.
// All three read in full alongside this file.
//
// WHY THIS FILE EXISTS. This is the most expensive request the public site
// can serve, and nothing about the response says so. Every hit that misses
// the cache launches a REAL BROWSER through the BROWSER binding, loads a
// third-party website to networkidle0 with a 45-second budget, and holds one
// of a per-account-capped number of Browser Rendering sessions for the whole
// of it. Three consequences shape every test below:
//
//   * A WRONG COLUMN IS INVISIBLE. Five page names map to five different
//     URL columns on the food bank row (views.py:534-544's if-chain, PAGE_FIELDS
//     here). Swap two of them and every request still answers 200 with a
//     perfectly good PNG -- of the wrong page. So the fixture gives all five
//     columns DIFFERENT urls and every mapping test reads the url puppeteer
//     was actually navigated to, never the status.
//   * THE FAILURE PATH IS A 404, DELIBERATELY, AND IS NOT CACHED. A food bank
//     whose site is down is the common case, not an exception (the module says
//     so), so the handler logs and 404s. That means a persistently broken site
//     re-launches a browser on EVERY request forever, and the only trace is a
//     console.error. Both halves are pinned.
//   * THE WEEK-LONG CACHE IS THE ONLY THING MAKING ANY OF IT AFFORDABLE.
//     @cache_page(SECONDS_IN_WEEK) in Django, `public, max-age=604800` plus a
//     caches.default write here. Whatever bytes were on hand at that instant
//     are what that food bank's screenshot URL serves for seven days, and the
//     cached copy carries no Cache-Tag, so a purge cannot reach it (pinned at
//     the bottom, same defect the sibling favicon suite records).
//
// REAL EVERYTHING, the same harness as the sibling routes/wfbn/favicon.test.ts:
//   * THE REAL PRODUCTION APP (workers/site/src/index.ts's default export),
//     because the ROUTE REGISTRATION is half of what is being tested. Hono
//     cannot match a param followed by literal text inside one segment, so the
//     obvious spelling `:page{...}.png` matches NOTHING, silently, and this
//     route is the one index.ts:377-384 names as having been written that way.
//     The fix -- putting ".png" inside the param's own regex and stripping it
//     in the handler -- is only observably correct through the real router; a
//     hand-built copy would assert a registration that does not exist.
//   * REAL SQLITE built by schemaFor() from the real migrations, so
//     getFoodbankBySlug's two-statement batch runs against production's columns
//     -- including the fact that `url`/`shopping_list_url` are NOT NULL (so
//     "no page" is the EMPTY STRING) while the other three are nullable.
//   * The real 404 page, the real securityHeaders/cacheTag/pageCacheControl
//     chain, and the real APPEND_SLASH probe.
//
// MOCKED, and only these: `@cloudflare/puppeteer` (a Browser Rendering session
// is a paid, capped, remote resource -- there is nothing local to call),
// `caches` (node has no CacheStorage at all), and D1 wrapped over node:sqlite.
//
// AND NOTHING ON THE SITE LINKS THESE URLS. Grepping every template, .njk and
// .js in this repo and in the Django one for "screenshots" turns up only
// /static/img/appscreenshots/ on the apps page: no <img>, no og:image, no
// admin link. So there is no page that goes blank when this route breaks --
// which is exactly how a route can be registered with a spelling that matches
// nothing and stay that way. This file is the only thing that would notice.
//
// PARITY CLAIMS HERE WERE RUN, NOT REASONED. The Django URL-regex outputs
// quoted in the registration block came from CPython 3.13.0 on this machine
// (`python3 -c "import re; ..."` against the verbatim pattern from
// gfwfbn/urls/generic.py:14), the two Python truthiness claims from the same
// interpreter, and the two @cache_page claims from reading
// django/middleware/cache.py in the Django 5.2.6 installed here -- none of
// them from memory. What is NOT verified: anything about how workerd's real
// Cache API or real Browser Rendering behave. This suite has neither, and
// says so at each point where it would otherwise look like evidence.
//
// MUTATION-TESTED, per TESTING.md's convention: the repo was cloned into a
// scratchpad OUTSIDE this tree (no source file here was ever edited), and
// screenshot.ts -- plus, for the registration tests, index.ts's one route line
// -- broken there one change at a time, with this file re-run against each
// mutant. 54 mutants, 3 survivors, all three provably equivalent:
//
//   * `.replace(/\.png$/, "")` losing its `$` anchor. The route regex
//     constrains the segment to `<one of five names>.png`, so ".png" can only
//     occur once and only at the end; anchored and unanchored strip the same
//     character range for every string that can reach the line.
//   * `if (!field) return c.notFound();` deleted. Redundant twice over from
//     the outside: the router already restricts the segment to the five names,
//     and even if it did not, `PAGE_FIELDS[unknown]` is undefined and
//     `foodbank[undefined]` is undefined, so the url guard four lines down
//     returns the same 404. It is still the right line to keep -- it is what
//     the module's own comment means by "adding a sixth means touching one
//     list rather than discovering the omission in production".
//   * index.ts's `\.png` written Django-style as `.png` (unescaped). Widens
//     the route to "homepageXpng", which then dies on the `if (!field)` guard
//     before any I/O, so nothing observable changes.
//
// Those last two are equivalent SEPARATELY and not TOGETHER: applying both at
// once lets "homepageXpng" reach getFoodbankBySlug, which the D1 assertion in
// the DIVERGENCE test below catches. That assertion exists for exactly this.
//
// The 51 that died include: each of the five PAGE_FIELDS entries remapped or
// swapped, and the whole map collapsed onto one column (a mutation worth
// spelling out: editing only the TYPE UNION above the map changes nothing at
// runtime and "survives" everything, which is why it is the object literal
// that must be edited); both viewport dimensions; the goto timeout; waitUntil dropped and
// each alternative value; the #ccc style tag dropped, reselected, or its typo
// "fixed"; the screenshot type; setViewport moved after goto and addStyleTag
// moved before it; launch handed a different binding; the .png strip removed;
// each of the four guards (field, foodbank, url, png) removed or narrowed to
// `=== null`; the Content-Type and Cache-Control each dropped or altered; the
// response status; the try/catch removed; the console.error dropped or
// stripped of its URL; browser.close() moved out of the finally or losing its
// .catch; the cache lookup skipped, ignored, hoisted above the D1 read, moved
// below the capture, keyed on a fixed URL or on a query-stripped one; the
// cache write removed, awaited instead of waitUntil'd, storing the un-cloned
// response, or extended to cache the failure 404; getFoodbankBySlug given a
// hardcoded slug; screenshot() returning null for zero bytes (Django's own
// behaviour -- see the suspect that pins the port's); and, on the route line
// itself, the `:page{...}.png` spelling index.ts warns about, an unconstrained
// `:page`, app.all in place of app.get, and a locale-prefixed registration.

const ORIGIN = "https://www.givefood.org.uk";

// @cache_page(SECONDS_IN_WEEK). Retyped rather than imported: screenshot.ts
// exports only the handler, and a second copy here is the point -- it makes
// the TTL a fact a test can break on rather than a value that silently
// follows whatever the source says today.
const CACHE_CONTROL_WEEK = "public, max-age=604800";

// general.py:50's addStyleTag content, character for character. The stray
// semicolon inside the CSS is in Django too; the module comment calls it out
// as "verbatim, typo and all", so a "tidy-up" that removed it would be a
// silent divergence from the page Django screenshots.
const HIDE_CCC_STYLE = "#ccc {display:none};";

type Bindable = null | number | bigint | string | Uint8Array;

// ---------------------------------------------------------------------------
// The puppeteer double
// ---------------------------------------------------------------------------
//
// Hoisted, because vi.mock's factory is lifted above the imports and a plain
// module-scope `const` would not exist yet when it runs. Same shape as
// workers/jobs/src/needcheck/scrape.test.ts, which mocks the same module for
// the same reason.
//
// screenshot.ts's entire external surface is
//   launch(binding) -> newPage() -> setViewport() -> goto() -> addStyleTag()
//   -> screenshot() -> close()
// and the ORDER of those is load-bearing in two places a status code cannot
// see: a viewport set after navigation would lay the page out at puppeteer's
// default size first, and a style tag added before navigation would be thrown
// away by the navigation. So the double records an ordered call log, not just
// per-method counters.
const { launchMock } = vi.hoisted(() => ({ launchMock: vi.fn() }));
vi.mock("@cloudflare/puppeteer", () => ({ default: { launch: launchMock } }));

/** What the scripted browser should do, mutated per test. An Error means that call rejects. */
interface BrowserPlan {
  launch: Error | null;
  newPage: Error | null;
  setViewport: Error | null;
  goto: Error | null;
  addStyleTag: Error | null;
  /** The bytes page.screenshot() resolves with, or an Error meaning it rejects. */
  screenshot: Uint8Array | Error;
  /** browser.close() rejecting -- it runs in a `finally`, so it must not surface. */
  close: Error | null;
}

let plan: BrowserPlan;
/**
 * Ordered names of every browser call AND every cache call, in one log, so the
 * sequence itself is assertable -- including the one ordering that decides
 * whether this route is affordable at all: cache.match before launch.
 */
let calls: string[];
/** Everything puppeteer.launch() was handed -- must be `env.BROWSER` and nothing else. */
let launchArgs: unknown[];
let viewports: unknown[];
let gotoCalls: { url: string; options: unknown }[];
let styleTags: unknown[];
let screenshotOptions: unknown[];
let closeCalls: number;

function fakeBrowser(): unknown {
  const page = {
    setViewport: async (viewport: unknown) => {
      calls.push("setViewport");
      viewports.push(viewport);
      if (plan.setViewport) throw plan.setViewport;
    },
    goto: async (url: string, options: unknown) => {
      calls.push("goto");
      gotoCalls.push({ url, options });
      if (plan.goto) throw plan.goto;
      return null;
    },
    addStyleTag: async (tag: unknown) => {
      calls.push("addStyleTag");
      styleTags.push(tag);
      if (plan.addStyleTag) throw plan.addStyleTag;
    },
    screenshot: async (options: unknown) => {
      calls.push("screenshot");
      screenshotOptions.push(options);
      if (plan.screenshot instanceof Error) throw plan.screenshot;
      return plan.screenshot;
    },
  };
  return {
    newPage: async () => {
      calls.push("newPage");
      if (plan.newPage) throw plan.newPage;
      return page;
    },
    close: async () => {
      calls.push("close");
      closeCalls += 1;
      if (plan.close) throw plan.close;
    },
  };
}

// ---------------------------------------------------------------------------
// The D1 Sessions surface packages/db uses, over node:sqlite -- copied from
// routes/wfbn/favicon.test.ts rather than reinvented. batch() is not optional:
// getFoodbankBySlug sends the food bank row and its latest need as ONE batch
// (packages/db/src/foodbank.ts:246) and indexes straight into the result
// array, so this must run the statements in order and return one result per
// input.
//
// `prepared` records the SQL that actually reached the engine, which is the
// only way to see the claim below that a screenshot served entirely from the
// Workers cache STILL pays a D1 round trip.
// ---------------------------------------------------------------------------

interface Prepared {
  sql: string;
  params: Bindable[];
}

function d1Session(database: DatabaseSync, prepared: Prepared[]): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    sql,
    params,
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (database.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: database.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      database.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return {
    prepare: (sql: string) => {
      prepared.push({ sql, params: [] });
      return statement(sql, []);
    },
    batch: async (statements: Array<{ sql: string; params: Bindable[] }>) =>
      statements.map((s) => ({ results: database.prepare(s.sql).all(...s.params), success: true, meta: {} })),
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

// ---------------------------------------------------------------------------
// caches.default
//
// Node has no CacheStorage, so unlike D1 there is nothing real to wrap. This
// models only what screenshot.ts uses -- match(request) and put(request,
// response) -- keyed on the request's METHOD AND FULL URL, query string
// included, because Cloudflare's cache key includes it and the
// "?cachebuster=1" test below is the whole reason to say so.
//
// WHAT IT DELIBERATELY DOES NOT MODEL, so nothing here is mistaken for
// evidence about workerd: Vary; put()'s documented refusal of non-GET
// requests (`putThrows` drives the handler's behaviour when a put rejects, it
// does not claim which puts workerd would reject); and header immutability on
// a match() result.
// ---------------------------------------------------------------------------

interface CacheEntry {
  body: string;
  headers: [string, string][];
}

/** One cache.put, flattened so assertions read as values rather than streams. */
interface PutRecord {
  key: string;
  method: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

let cacheStore: Map<string, CacheEntry>;
let cacheMatches: { key: string; method: string }[];
let cachePuts: PutRecord[];
/** Makes cache.put reject, to see whether a failed write can take the response down with it. */
let putThrows: boolean;

function cachesStub(): unknown {
  return {
    default: {
      match: async (request: Request): Promise<Response | undefined> => {
        calls.push("cache.match");
        cacheMatches.push({ key: request.url, method: request.method });
        const hit = cacheStore.get(`${request.method} ${request.url}`);
        return hit ? new Response(hit.body, { headers: hit.headers }) : undefined;
      },
      put: async (request: Request, response: Response): Promise<void> => {
        calls.push("cache.put");
        const body = await response.text();
        cachePuts.push({
          key: request.url,
          method: request.method,
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body,
        });
        if (putThrows) throw new TypeError("Cannot cache response to non-GET request");
        cacheStore.set(`${request.method} ${request.url}`, { body, headers: [...response.headers.entries()] });
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let db: DatabaseSync;
let prepared: Prepared[];
let waited: Promise<unknown>[];
let errorLogs: string[];

const execCtx = {
  waitUntil: (p: Promise<unknown>) => void waited.push(p),
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

// A sentinel with no behaviour at all: the ONLY thing the handler may do with
// c.env.BROWSER is hand it to puppeteer.launch(), so identity is the whole
// contract. A mutant that launched against some other binding would come back
// with a different object here.
const BROWSER_BINDING = { __sentinel: "BROWSER binding" };

function env(): AppEnv["Bindings"] {
  return {
    DB: { withSession: () => d1Session(db, prepared) },
    BROWSER: BROWSER_BINDING,
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

// foodbankchange/foodbankchange_full are here because getFoodbankBySlug reads
// the view unconditionally in its batch (github #51 -- the change that broke
// eight narrow fixtures at once), not because this route uses a need.
//
// foodbanklocation and its view are here for a different reason again:
// `/needs/at/<slug>/screenshots/` (no page name) does not fall through to a
// 404, it MATCHES `/needs/at/:slug/:locslug/` with locslug="screenshots" and
// runs the location-detail handler. Without these two objects that request
// comes back a 500 from a table that does not exist -- exactly the shared-
// fixture breakage schema.testkit.ts's own header describes.
const SCHEMA = schemaFor("foodbank", "foodbankchange", "foodbankchange_full", "foodbanklocation", "foodbanklocation_full");

// THE FIXTURE IS THE TEST. `url` and `shopping_list_url` are TEXT NOT NULL on
// foodbank (0001_core.sql:27) so their "absent" value is the EMPTY STRING;
// `donation_points_url`, `locations_url` and `contacts_url` are nullable
// (:28-29) so theirs is a genuine SQL NULL. The handler's single `if
// (!targetUrl)` has to cover both, and Django's `if not url:` did too.
function seedFoodbank(o: {
  id: number;
  slug: string;
  name: string;
  url: string;
  shoppingListUrl: string;
  donationPointsUrl: string | null;
  locationsUrl: string | null;
  contactsUrl: string | null;
}): void {
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, slug, address, postcode, country, lat_lng, network,
       charity_just_foodbank, contact_email, url, shopping_list_url, donation_points_url,
       locations_url, contacts_url, address_is_administrative, is_closed, no_locations,
       days_between_needs, created, modified)
     VALUES (?, ?, ?, ?, '1 High Street', 'SP1 1AA', 'England', '51.07,-1.79', 'Trussell Trust',
       0, ?, ?, ?, ?, ?, ?, 0, 0, 0, 14, '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run(
    o.id,
    String(o.id).padStart(32, "a"),
    o.name,
    o.slug,
    `info@${o.slug}.invalid`,
    o.url,
    o.shoppingListUrl,
    o.donationPointsUrl,
    o.locationsUrl,
    o.contactsUrl,
  );
}

// salisbury    all five columns populated, each with a DIFFERENT url, so a
//              mis-mapped page name shows up as the wrong navigation rather
//              than as a passing test.
// no-pages     every one of the five absent, in the two ways the schema
//              permits: "" for the NOT NULL pair, NULL for the other three.
// bath         a second food bank, so the per-food-bank cache key and the
//              slug scoping are visible rather than assumed.
function seed(): void {
  seedFoodbank({
    id: 1,
    slug: "salisbury",
    name: "Salisbury Foodbank",
    url: "https://salisburyfoodbank.org.uk/",
    shoppingListUrl: "https://salisburyfoodbank.org.uk/give-help/shopping-list/",
    donationPointsUrl: "https://salisburyfoodbank.org.uk/give-help/donation-points/",
    locationsUrl: "https://salisburyfoodbank.org.uk/get-help/where-we-are/",
    contactsUrl: "https://salisburyfoodbank.org.uk/about/contact-us/",
  });
  seedFoodbank({
    id: 2,
    slug: "no-pages",
    name: "No Pages Foodbank",
    url: "",
    shoppingListUrl: "",
    donationPointsUrl: null,
    locationsUrl: null,
    contactsUrl: null,
  });
  seedFoodbank({
    id: 3,
    slug: "bath",
    name: "Bath Foodbank",
    url: "https://bathfoodbank.org.uk/",
    shoppingListUrl: "https://bathfoodbank.org.uk/shopping-list/",
    donationPointsUrl: null,
    locationsUrl: null,
    contactsUrl: null,
  });
}

const PNG = new TextEncoder().encode("PNG-BYTES");

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  seed();

  prepared = [];
  waited = [];
  errorLogs = [];
  cacheStore = new Map<string, CacheEntry>();
  cacheMatches = [];
  cachePuts = [];
  putThrows = false;

  plan = { launch: null, newPage: null, setViewport: null, goto: null, addStyleTag: null, screenshot: PNG, close: null };
  calls = [];
  launchArgs = [];
  viewports = [];
  gotoCalls = [];
  styleTags = [];
  screenshotOptions = [];
  closeCalls = 0;

  launchMock.mockReset();
  launchMock.mockImplementation(async (binding: unknown) => {
    calls.push("launch");
    launchArgs.push(binding);
    if (plan.launch) throw plan.launch;
    return fakeBrowser();
  });

  vi.stubGlobal("caches", cachesStub());
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errorLogs.push(args.map(String).join(" ")));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  db.close();
});

interface Result {
  res: Response;
  body: string;
}

async function get(path: string, init: RequestInit = {}): Promise<Result> {
  const res = await app.fetch(new Request(`${ORIGIN}${path}`, init), env(), execCtx);
  return { res, body: await res.text() };
}

/** Every waitUntil promise settled, so the cache write is observable. allSettled: one rejects on purpose. */
async function drain(): Promise<void> {
  await Promise.allSettled(waited);
}

const PATH = "/needs/at/salisbury/screenshots/homepage.png";

// ===========================================================================
// Registration: which URLs reach the handler at all
// ===========================================================================
//
// gfwfbn/urls/generic.py:14 is the ONLY re_path in that module, and the
// reason is the five-name alternation plus the extension. index.ts:377-384
// reproduces it as a whole-segment Hono param,
// `:page{(?:homepage|shoppinglist|donationpoints|contacts|locations)\.png}`,
// after the obvious spelling (`:page{...}.png`, a param followed by literal
// text in one segment) was found to match nothing at all, silently.
//
// AND SILENTLY IS THE WHOLE PROBLEM. Nothing in either codebase links these
// URLs: grepping every template, .njk and .js in this repo and in the Django
// one for "screenshots" finds only /static/img/appscreenshots/ on the apps
// page. So no page on the site goes blank when this route breaks, and no page
// goes right when it is fixed -- the only way anyone learns either way is a
// test. That is why the whole registered URL set is asserted here in both
// directions rather than just the happy path: a form that stopped working is
// invisible, and a form that started working is a second cache entry and a
// second BROWSER SESSION for identical bytes.

describe("wfbnFoodbankScreenshot: the registered URL set", () => {
  // The registration regression test. If `:page{...}` ever goes back to the
  // spelling index.ts warns about, every one of these 404s and the whole rest
  // of this file fails with it -- which is the intended blast radius.
  it.each([
    ["homepage", "https://salisburyfoodbank.org.uk/"],
    ["shoppinglist", "https://salisburyfoodbank.org.uk/give-help/shopping-list/"],
    ["donationpoints", "https://salisburyfoodbank.org.uk/give-help/donation-points/"],
    ["contacts", "https://salisburyfoodbank.org.uk/about/contact-us/"],
    ["locations", "https://salisburyfoodbank.org.uk/get-help/where-we-are/"],
  ])("serves %s.png, screenshotting the column views.py:534-544 maps it to", async (page, expected) => {
    const { res, body } = await get(`/needs/at/salisbury/screenshots/${page}.png`);

    expect(res.status).toBe(200);
    expect(body).toBe("PNG-BYTES");
    // The assertion that matters: a swapped pair in PAGE_FIELDS still answers
    // 200 with a valid PNG, so only the navigated URL can catch it.
    expect(gotoCalls.map((g) => g.url)).toEqual([expected]);
  });

  // Every URL that must NOT reach the handler. Each one is a browser session
  // that would otherwise be launched by a request nobody's templates emit.
  it.each([
    ["/cy/needs/at/salisbury/screenshots/homepage.png", "Welsh: gfwfbn/urls/generic.py is included outside i18n_patterns"],
    ["/gd/needs/at/salisbury/screenshots/homepage.png", "Scots Gaelic, same reason"],
    ["/needs/at/salisbury/screenshots/homepage.PNG", "the extension is part of the param regex, and that regex is case-sensitive"],
    ["/needs/at/salisbury/screenshots/HOMEPAGE.png", "so is the page name"],
    ["/needs/at/salisbury/screenshots/homepage.jpg", "the URL Django registered is .png"],
    ["/needs/at/salisbury/screenshots/homepage", "no extension at all"],
    ["/needs/at/salisbury/screenshots/photo.png", "not one of the five names in the URL pattern"],
    ["/needs/at/salisbury/screenshots/", "no page name -- this is the location-detail route with locslug=screenshots, and no such location exists"],
    ["/needs/at/screenshots/homepage.png", "the slug segment missing, so 'screenshots' lands in it and the literal has nothing to match"],
    ["/needs/at/salisbury/screenshot/homepage.png", "the registered literal is plural -- 'screenshots' -- and this is not"],
  ])("404s %s (%s), never launching a browser", async (path) => {
    const { res } = await get(path);
    await drain();

    expect(res.status).toBe(404);
    expect(launchMock).not.toHaveBeenCalled();
    expect(cachePuts).toEqual([]);
  });

  // PARITY, MEASURED. Run against the verbatim pattern from
  // gfwfbn/urls/generic.py:14 under CPython 3.13.0 on this machine
  // (`python3 -c "import re; ..."`): re.search() on
  // "at/x/screenshots/homepageXpng" matches with page_name="homepage", and so
  // does "at/x/screenshots/homepage.pngZZZ" -- Django's `.` there is an
  // unescaped regex dot, the pattern carries no trailing `$`, and
  // URLPattern.resolve() discards the unmatched remainder. Both therefore
  // served a real screenshot in Django.
  //
  // The port answers 404 to both, and to "homepageXpng" it does so THREE
  // times over: Hono's `\.png` is an escaped dot, PAGE_FIELDS has no such
  // key, and `foodbank[undefined]` is undefined so the url guard catches it.
  // Measured, not assumed -- removing the escape and the `if (!field)` guard
  // together in a scratchpad copy still 404s. The `.pngZZZ` case is the
  // router alone: Hono anchors a `:param{...}` regex to the WHOLE segment
  // (checked directly against hono 4.13.7, the version installed here).
  //
  // The `prepared` assertion is what makes this test load-bearing rather than
  // decorative: it says the 404 costs nothing at all -- not even the D1 round
  // trip it would cost if the request reached the handler.
  it.each([
    ["/needs/at/salisbury/screenshots/homepageXpng", "Django's unescaped dot matched any character here"],
    ["/needs/at/salisbury/screenshots/homepage.pngZZZ", "Django's pattern has no trailing anchor"],
  ])("DIVERGENCE (stricter than Django): 404s %s (%s), before D1", async (path) => {
    const { res } = await get(path);

    expect(res.status).toBe(404);
    expect(launchMock).not.toHaveBeenCalled();
    expect(prepared).toEqual([]);
    expect(cacheMatches).toEqual([]);
  });

  // GET-only, as Django's urlpatterns registers it. Not tidiness: the handler
  // launches a browser and writes a week-long cache entry, so any method that
  // reached it would be an unauthenticated way to consume Browser Rendering
  // sessions.
  it.each(["POST", "PUT", "DELETE", "PATCH"])("does not answer %s at all", async (method) => {
    const { res } = await get(PATH, { method });
    await drain();

    expect(res.status).toBe(404);
    expect(launchMock).not.toHaveBeenCalled();
    expect(cacheMatches).toEqual([]);
  });

  // The 404 is the real site 404 page, not a bare status -- an <img> pointing
  // at it receives an HTML document, exactly as Django's HttpResponseNotFound
  // did.
  it("renders the site 404 page for an unknown food bank, not an empty body", async () => {
    const { res, body } = await get("/needs/at/no-such-foodbank/screenshots/homepage.png");

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(body).toContain("<html");
  });

  // SQLite's `=` on TEXT is case-sensitive and foodbank_slug_uniq declares no
  // COLLATE NOCASE, so a capitalised slug is simply an unknown food bank --
  // the same answer Django's get_object_or_404 on a SlugField gives. Pinned
  // because "the URL still works if you shout it" would double every cache
  // entry and every browser session if it were true.
  it("404s a slug in the wrong case rather than resolving it", async () => {
    const { res } = await get("/needs/at/Salisbury/screenshots/homepage.png");

    expect(res.status).toBe(404);
    expect(launchMock).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// PAGE_FIELDS: the five columns, and the four that are usually empty
// ===========================================================================
//
// views.py:534-544 is five bare `if` statements, no `elif` and no `else`, so
// `url` is simply never bound when page_name is outside the five -- an
// UnboundLocalError that the URL pattern makes unreachable. PAGE_FIELDS is
// that if-chain as data, with the same unreachable case answered as a 404
// instead. Both are only reachable by calling the handler directly, which
// this suite deliberately does not do: it is not an exported entry point.

describe("wfbnFoodbankScreenshot: page name to column", () => {
  // The cross-check the it.each above cannot make on its own: prove that
  // `homepage` is NOT reading one of the other four, by emptying the other
  // four and watching it still work. A PAGE_FIELDS that mapped everything to
  // the same column would pass the mapping table and fail this.
  it("reads `url` for homepage even when every other page column is empty", async () => {
    db.prepare("UPDATE foodbank SET shopping_list_url = '', donation_points_url = NULL, locations_url = NULL, contacts_url = NULL WHERE slug = 'salisbury'").run();

    const { res } = await get(PATH);

    expect(res.status).toBe(200);
    expect(gotoCalls[0]!.url).toBe("https://salisburyfoodbank.org.uk/");
  });

  // And the reverse: emptying `url` alone must not break shoppinglist. This is
  // the pair that dies if PAGE_FIELDS collapses to a single column.
  it("reads `shopping_list_url` for shoppinglist even when `url` is empty", async () => {
    db.prepare("UPDATE foodbank SET url = '' WHERE slug = 'salisbury'").run();

    const { res } = await get("/needs/at/salisbury/screenshots/shoppinglist.png");

    expect(res.status).toBe(200);
    expect(gotoCalls[0]!.url).toBe("https://salisburyfoodbank.org.uk/give-help/shopping-list/");
  });

  // views.py:546-547, `if not url: return HttpResponseNotFound()`. The module
  // comment calls this "the ordinary answer for four of the five pages, not an
  // error" -- most food banks have no shopping list or contacts page -- so the
  // important half is that it costs NOTHING: no browser, no cache lookup, no
  // cache write.
  it.each(["homepage", "shoppinglist", "donationpoints", "contacts", "locations"])(
    "404s %s for a food bank with no such page, without launching a browser or touching the cache",
    async (page) => {
      const { res } = await get(`/needs/at/no-pages/screenshots/${page}.png`);
      await drain();

      expect(res.status).toBe(404);
      expect(launchMock).not.toHaveBeenCalled();
      expect(cacheMatches).toEqual([]);
      expect(cachePuts).toEqual([]);
    },
  );

  // The NOT NULL pair and the nullable trio take the same `if (!targetUrl)`
  // branch by two different routes -- "" and SQL NULL. Asserted separately
  // from the loop above so a guard rewritten as `=== null` (which would let
  // "" through and navigate a browser to the empty string) fails on the first
  // row and a guard rewritten as `=== ""` fails on the second.
  it("treats an empty-string url and a NULL url as the same absence", async () => {
    const empty = await get("/needs/at/no-pages/screenshots/homepage.png"); // url is "" (NOT NULL column)
    const nulled = await get("/needs/at/no-pages/screenshots/contacts.png"); // contacts_url is NULL

    expect(empty.res.status).toBe(404);
    expect(nulled.res.status).toBe(404);
    expect(gotoCalls).toEqual([]);
  });

  // A whitespace-only url is truthy, so it is navigated to. Django agrees --
  // `not " "` is False, run under CPython 3.13.0 on this machine, not recalled
  // -- and puppeteer's goto would then reject, landing on the 404 path anyway,
  // but by way of a launched browser and up to 45 seconds. Pinned because the
  // two "no page" answers are indistinguishable from outside and cost wildly
  // different amounts, so a data-cleanup that turned "" into " " would move
  // every no-page 404 onto the expensive path with nothing to show for it.
  it("SUSPECT: a whitespace-only url still launches a browser, as Django still called the API", async () => {
    db.prepare("UPDATE foodbank SET url = ' ' WHERE slug = 'salisbury'").run();

    await get(PATH);

    expect(gotoCalls.map((g) => g.url)).toEqual([" "]);
  });
});

// ===========================================================================
// The Browser Rendering call
// ===========================================================================
//
// get_screenshot(url, width=1280, height=1280) (general.py:27-58) POSTs a
// JSON body to Cloudflare's REST endpoint with `viewport`, `gotoOptions` and
// `addStyleTag`. This port sends the same four values through the BROWSER
// binding instead -- same service, two fewer secrets on the site Worker (the
// REST call needs CF_ACCOUNT_ID and a browser API key; the binding needs
// neither). Every value is asserted exactly, because they are the difference
// between a screenshot of the page and a screenshot of a loading spinner.

describe("wfbnFoodbankScreenshot: what it asks the browser to do", () => {
  it("launches against the BROWSER binding itself, once, and nothing else", async () => {
    await get(PATH);

    expect(launchArgs).toEqual([BROWSER_BINDING]);
    expect(launchArgs[0]).toBe(BROWSER_BINDING); // identity, not a lookalike
  });

  // general.py:38-41's `"viewport": {"width": 1280, "height": 1280}`, which
  // is get_screenshot's default and the only value any caller passes. Pinned
  // as both numbers because the height is the unusual one -- a 1280-tall
  // viewport captures far more of a page than a normal 720/800, and quietly
  // halving it would change every image without changing anything a test that
  // only counted bytes could see.
  it("sets Django's 1280x1280 viewport", async () => {
    await get(PATH);

    expect(viewports).toEqual([{ width: 1280, height: 1280 }]);
  });

  // general.py:42-45's gotoOptions, both keys. networkidle0 (not `load`) is
  // what makes a lazy-loading page finish, and the 45s timeout is the number
  // Django chose; the module comment defends it explicitly against being
  // shortened, so it is pinned as a value rather than as "some timeout".
  it("navigates with waitUntil networkidle0 and Django's 45-second timeout", async () => {
    await get(PATH);

    expect(gotoCalls).toEqual([{ url: "https://salisburyfoodbank.org.uk/", options: { waitUntil: "networkidle0", timeout: 45000 } }]);
  });

  // general.py:47-52's addStyleTag, which hides whatever `#ccc` is on a food
  // bank's own site -- neither codebase says, and this suite does not guess.
  // The trailing `;` after the closing brace is a stray top-level semicolon
  // that a CSS parser discards; the module's own comment keeps it deliberately
  // ("verbatim from general.py:50, typo and all"), so this asserts the exact
  // string rather than "contains #ccc". A tidy-up that removed the semicolon
  // would be a silent divergence from what Django injects.
  it("injects general.py's #ccc-hiding style verbatim, stray semicolon included", async () => {
    await get(PATH);

    expect(styleTags).toEqual([{ content: HIDE_CCC_STYLE }]);
    expect(HIDE_CCC_STYLE).toBe("#ccc {display:none};");
  });

  it("asks for a PNG, matching the image/png the response declares", async () => {
    await get(PATH);

    expect(screenshotOptions).toEqual([{ type: "png" }]);
  });

  // THE ORDERING TEST, and the reason the double keeps a call log at all.
  // setViewport must precede goto (a viewport applied afterwards lays the page
  // out twice, and a responsive site can settle on the wrong breakpoint), and
  // addStyleTag must FOLLOW goto (a style tag injected into about:blank is
  // discarded by the navigation, so the cookie banner would be in every
  // image). Neither mistake changes the status, the content type or the
  // presence of bytes.
  it("orders the calls viewport -> navigate -> style -> capture -> close", async () => {
    await get(PATH);
    await drain();

    expect(calls).toEqual(["cache.match", "launch", "newPage", "setViewport", "goto", "addStyleTag", "screenshot", "close", "cache.put"]);
  });

  // One session per request. The module's header says Browser Rendering
  // "limits how many browsers an account may run at once", and workers/jobs
  // declares the SAME binding on the same account (jobs/wrangler.jsonc:202,
  // used by needcheck/scrape.ts:289), so a retry loop added here would not
  // just be slow -- it would starve the need-extraction pipeline too.
  it("opens exactly one browser and one page per request, with no retry", async () => {
    await get(PATH);

    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(calls.filter((name) => name === "newPage")).toHaveLength(1);
    expect(calls.filter((name) => name === "goto")).toHaveLength(1);
  });
});

// ===========================================================================
// The response
// ===========================================================================

describe("wfbnFoodbankScreenshot: the response it builds", () => {
  // views.py:551 `HttpResponse(photo, content_type='image/png')`. The type is
  // DECLARED, and there is no upstream content type to forward -- the bytes
  // come back from the binding, not from an HTTP response.
  it("returns the captured bytes as image/png", async () => {
    plan.screenshot = new TextEncoder().encode("THE-ACTUAL-CAPTURE");
    const { res, body } = await get(PATH);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(body).toBe("THE-ACTUAL-CAPTURE");
  });

  // @cache_page(SECONDS_IN_WEEK). This is the only thing making a live browser
  // launch affordable at all, so it is asserted as the exact string rather
  // than by parsing a max-age out of it.
  it("sends the week-long Cache-Control @cache_page(SECONDS_IN_WEEK) sent", async () => {
    const { res } = await get(PATH);

    expect(res.headers.get("Cache-Control")).toBe(CACHE_CONTROL_WEEK);
  });

  // middleware/pageCacheControl.ts's CACHEABLE_TYPES is
  // /^(?:text\/html|application\/rss\+xml|text\/markdown)/, so image/png is
  // outside it and the middleware neither adds nor overrides anything here.
  // Pinned from this side too: if the route's own header went missing there
  // would be NO substitute, and every visitor's browser would re-request a
  // screenshot it already had -- turning a cached image into a live one.
  it("keeps its own Cache-Control rather than the middleware's page default", async () => {
    const { res } = await get(PATH);

    expect(res.headers.get("Cache-Control")).toBe(CACHE_CONTROL_WEEK);
    expect(res.headers.get("Cache-Control")).not.toContain("s-maxage");
  });

  it("carries the site-wide security headers, like every other response", async () => {
    const { res } = await get(PATH);

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
  });

  // SUSPECT, pinned not fixed. `if (!png)` is false for a ZERO-LENGTH
  // Uint8Array -- every typed array is truthy in JS -- so a capture that came
  // back with no bytes is served as a 200 image/png with an empty body AND
  // written into the cache for a week. Django could not do this: views.py:551
  // guards on `if photo:` and `not b""` is True (run under CPython 3.13.0 on
  // this machine), so it returned HttpResponseNotFound and nothing was cached.
  // Whether Browser Rendering can actually answer with zero bytes is NOT
  // verified -- this suite has no Browser Rendering -- but it is the one place
  // the port's truthiness and Python's provably disagree on the same guard,
  // and the consequence is a week of a blank image rather than a retry.
  it("SUSPECT: an empty capture is served as a 200 PNG and cached, where Django 404'd", async () => {
    plan.screenshot = new Uint8Array(0);
    const { res, body } = await get(PATH);
    await drain();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(body).toBe("");
    expect(cachePuts).toHaveLength(1);
    expect(cachePuts[0]!.body).toBe("");
    expect(errorLogs).toEqual([]); // nothing anywhere records that this happened
  });
});

// ===========================================================================
// Failure: everything a food bank's own website can do to us
// ===========================================================================
//
// views.py:551-554 returns 404 when get_screenshot() is falsy, and
// general.py:55-56 returns False on any non-200. The module's comment is
// explicit that this is the ordinary case rather than an exception -- "a food
// bank whose site is down, slow or hostile to a headless browser" -- so it is
// logged and 404'd, not 500'd. What that buys, and what it costs, are both
// below.

describe("wfbnFoodbankScreenshot: when the capture fails", () => {
  it.each([
    ["puppeteer.launch rejects (no session available)", "launch"],
    ["browser.newPage rejects", "newPage"],
    ["page.setViewport rejects", "setViewport"],
    ["page.goto times out or the site refuses the headless browser", "goto"],
    ["page.addStyleTag rejects", "addStyleTag"],
    ["page.screenshot rejects", "screenshot"],
  ] as [string, keyof BrowserPlan][])("404s rather than 500s when %s", async (_why, step) => {
    const boom = new Error(`${step} exploded`);
    if (step === "screenshot") plan.screenshot = boom;
    else (plan as unknown as Record<string, Error>)[step] = boom;

    const { res } = await get(PATH);

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/html"); // the real 404 page
  });

  // The console.error is the ONLY signal that a food bank's screenshot is
  // broken -- there is no dead-letter queue and no admin flag on this path --
  // so the target URL being IN the log line is what makes it actionable. A log
  // that said only "screenshot: failed" would be useless across 1,000+ food
  // banks.
  it("logs the failure with the URL it was trying to capture", async () => {
    plan.goto = new Error("Navigation timeout of 45000 ms exceeded");

    await get(PATH);

    expect(errorLogs.join("\n")).toContain("screenshot: failed for https://salisburyfoodbank.org.uk/");
    expect(errorLogs.join("\n")).toContain("Navigation timeout of 45000 ms exceeded");
  });

  // THE SESSION-LEAK TEST, and the reason the `finally` exists at all: the
  // module says leaking a browser "starves every later request until it times
  // out on its own". A close that only ran on the success path would leak one
  // session per broken food bank, which is the exact shape of an outage that
  // looks like nothing until the account cap is hit.
  it("closes the browser even when the navigation throws", async () => {
    plan.goto = new Error("net::ERR_CONNECTION_REFUSED");

    await get(PATH);

    expect(closeCalls).toBe(1);
    expect(calls).toEqual(["cache.match", "launch", "newPage", "setViewport", "goto", "close"]);
  });

  // launch() rejecting means there is no browser object to close, and `if
  // (browser)` guards it -- so this asserts the absence of a close, which is
  // the branch a `browser!.close()` mutant would turn into a TypeError inside
  // a finally and therefore into a 500.
  it("does not try to close a browser that never launched", async () => {
    plan.launch = new Error("Browser Rendering: too many concurrent sessions");

    const { res } = await get(PATH);

    expect(res.status).toBe(404);
    expect(closeCalls).toBe(0);
    expect(calls).toEqual(["cache.match", "launch"]);
  });

  // close() runs in a `finally` with `.catch(() => {})`, so a close that
  // rejects must not turn a successful capture into an error. Without the
  // catch this would be an unhandled rejection replacing an already-computed
  // PNG with a 500.
  it("still serves the image when browser.close() rejects", async () => {
    plan.close = new Error("Target closed");
    const { res, body } = await get(PATH);

    expect(res.status).toBe(200);
    expect(body).toBe("PNG-BYTES");
    expect(errorLogs).toEqual([]); // swallowed entirely -- not even logged
  });

  // A failed capture is deliberately NOT cached (screenshot.ts:104 says so:
  // "a site that is down today may work tomorrow"). The cost of that choice is
  // what this test measures: every single request for a persistently broken
  // food bank pays a fresh browser launch and up to 45 seconds, forever, with
  // only a console.error to show for it -- and since nothing rate-limits the
  // URL, "persistently broken" plus a crawler is a self-inflicted load test.
  //
  // INHERITED, NOT INTRODUCED. Django's @cache_page could not cache the 404
  // either: UpdateCacheMiddleware.process_response bails on
  // `response.status_code not in (200, 304)` -- read at
  // django/middleware/cache.py:91 in the Django 5.2.6 installed on this
  // machine, not recalled.
  it("SUSPECT: a failing site re-launches a browser on every request, forever", async () => {
    plan.goto = new Error("Navigation timeout of 45000 ms exceeded");

    const first = await get(PATH);
    await drain();
    const second = await get(PATH);
    await drain();

    expect(first.res.status).toBe(404);
    expect(second.res.status).toBe(404);
    expect(launchMock).toHaveBeenCalledTimes(2);
    expect(cachePuts).toEqual([]);
    expect(errorLogs).toHaveLength(2);
  });
});

// ===========================================================================
// The Workers Cache API
// ===========================================================================
//
// Same cache-then-render-then-write shape as routes/wfbn/favicon.ts, but with
// a far more expensive miss behind it, so the read side is what matters here:
// every one of these tests is really asking "did this request avoid launching
// a browser?".

describe("wfbnFoodbankScreenshot: the cache", () => {
  // The one ordering that decides whether this route costs a browser session
  // or nothing: a cache.match hoisted BELOW the launch would still serve the
  // right bytes and still hit on the second request -- it would just pay for a
  // screenshot it then threw away, every time, invisibly. Only the interleaved
  // call log can see that, which is why the cache stub writes into it.
  it("looks in the cache BEFORE launching a browser, keyed on the request itself", async () => {
    await get(PATH);

    expect(cacheMatches).toEqual([{ key: `${ORIGIN}${PATH}`, method: "GET" }]);
    expect(calls.slice(0, 2)).toEqual(["cache.match", "launch"]);
  });

  // The stored entry is the response as the HANDLER built it: 200, image/png,
  // the week. Read back as values -- "cache.put was called" would pass with an
  // empty body or a 404 in it.
  it("writes the built response into the cache, bytes and headers", async () => {
    await get(PATH);
    await drain();

    expect(cachePuts).toHaveLength(1);
    expect(cachePuts[0]!.key).toBe(`${ORIGIN}${PATH}`);
    expect(cachePuts[0]!.status).toBe(200);
    expect(cachePuts[0]!.body).toBe("PNG-BYTES");
    expect(cachePuts[0]!.headers["content-type"]).toBe("image/png");
    expect(cachePuts[0]!.headers["cache-control"]).toBe(CACHE_CONTROL_WEEK);
  });

  // THE WHOLE ECONOMIC ARGUMENT OF THIS ROUTE. The module header justifies
  // doing the work live rather than pre-rendering into R2 on the grounds that
  // "a week-cached screenshot is made once". If the second request launched a
  // browser too, that argument is void and the route should never have left
  // routes/media.ts.
  it("serves the second request from the cache, launching no browser at all", async () => {
    await get(PATH);
    await drain();
    launchMock.mockClear();
    calls = [];

    const { res, body } = await get(PATH);
    await drain();

    expect(res.status).toBe(200);
    expect(body).toBe("PNG-BYTES");
    expect(launchMock).not.toHaveBeenCalled();
    // A hit does exactly one thing and then returns: no browser, and no
    // re-write of what it just read (which would reset the week's TTL on
    // every request and make the entry effectively immortal).
    expect(calls).toEqual(["cache.match"]);
    expect(cachePuts).toHaveLength(1);
  });

  // A cache hit returns the STORED response, headers included, so the
  // week-long Cache-Control survives the round trip. If it did not, every
  // browser would re-request the image on every page view while the edge kept
  // serving it from here.
  it("returns the cached headers on a hit, not a freshly built set", async () => {
    await get(PATH);
    await drain();

    const { res } = await get(PATH);

    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe(CACHE_CONTROL_WEEK);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff"); // still through the middleware chain
  });

  // Five page names, five entries, five different captures. Asserted with
  // different bytes per page so a key collision surfaces as the WRONG IMAGE
  // rather than as a missing one -- a shoppinglist URL serving the homepage
  // screenshot is exactly the failure nobody would report.
  it("keys per page name, so one page's capture never serves as another's", async () => {
    plan.screenshot = new TextEncoder().encode("HOMEPAGE-CAPTURE");
    await get(PATH);
    await drain();

    plan.screenshot = new TextEncoder().encode("CONTACTS-CAPTURE");
    const contacts = await get("/needs/at/salisbury/screenshots/contacts.png");
    await drain();

    const homepage = await get(PATH);

    expect(contacts.body).toBe("CONTACTS-CAPTURE");
    expect(homepage.body).toBe("HOMEPAGE-CAPTURE");
  });

  // And per food bank, which is what the URL-keyed design is actually for.
  it("keys per food bank, so one food bank's screenshot never serves as another's", async () => {
    plan.screenshot = new TextEncoder().encode("SALISBURY-CAPTURE");
    await get(PATH);
    await drain();

    plan.screenshot = new TextEncoder().encode("BATH-CAPTURE");
    const bath = await get("/needs/at/bath/screenshots/homepage.png");
    await drain();

    const salisbury = await get(PATH);

    expect(bath.body).toBe("BATH-CAPTURE");
    expect(salisbury.body).toBe("SALISBURY-CAPTURE");
    expect(cachePuts.map((p) => p.key)).toEqual([`${ORIGIN}${PATH}`, `${ORIGIN}/needs/at/bath/screenshots/homepage.png`]);
  });

  // waitUntil, not await: the visitor's image must not wait on a cache write.
  // Proved by never resolving the put -- an awaited write would hang this test
  // rather than fail it.
  it("answers before the cache write settles", async () => {
    vi.stubGlobal("caches", {
      default: {
        match: async () => undefined,
        put: () => new Promise<void>(() => {}),
      },
    });

    const { res, body } = await get(PATH);

    expect(res.status).toBe(200);
    expect(body).toBe("PNG-BYTES");
    expect(waited).toHaveLength(1);
  });

  // A rejected cache.put is an unhandled rejection inside waitUntil, not a
  // failed request -- the response has already been returned. Pinned because
  // it means a cache refusing writes degrades to "launch a browser every time"
  // silently, which on THIS route is the difference between one session a week
  // and one per request.
  it("still serves the image when the cache write rejects", async () => {
    putThrows = true;
    const { res, body } = await get(PATH);
    await drain();

    expect(res.status).toBe(200);
    expect(body).toBe("PNG-BYTES");
    expect(cachePuts).toHaveLength(1);
  });

  // The response is cloned before being handed to cache.put, so the body the
  // visitor gets has not been consumed by the write. A missing .clone() would
  // make the two mutually exclusive; asserting both at once is what catches it.
  it("gives the cache a clone, so the visitor's body is still readable", async () => {
    const { body } = await get(PATH);
    await drain();

    expect(body).toBe("PNG-BYTES");
    expect(cachePuts[0]!.body).toBe("PNG-BYTES");
  });

  // SUSPECT, pinned not fixed, and materially worse here than on the sibling
  // favicon route. The cache key is `c.req.raw`, so the query string a CLIENT
  // sends is part of it: appending a counter mints an unbounded number of
  // cache entries AND an unbounded number of BROWSER SESSIONS, each holding
  // one of a per-account-capped resource for up to 45 seconds. On favicon.ts
  // the same hole spends free Google requests; here it is a denial-of-service
  // against every other Browser Rendering consumer on the account, including
  // workers/jobs' needcheck scrape. routes/media.ts's `?s=` allowlist exists to
  // stop exactly this on the neighbouring route family.
  it("SUSPECT: a client-supplied query string mints a new cache entry and a new browser session", async () => {
    await get(PATH);
    await drain();
    launchMock.mockClear();

    const { res } = await get(`${PATH}?cachebuster=1`);
    await drain();

    expect(res.status).toBe(200);
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(cachePuts).toHaveLength(2);
    expect(cachePuts[1]!.key).toBe(`${ORIGIN}${PATH}?cachebuster=1`);
  });

  // SUSPECT, pinned not fixed. Hono answers HEAD from the GET handler, so a
  // HEAD launches a browser, captures a full screenshot, and then attempts a
  // cache.put whose KEY IS A HEAD REQUEST -- which Cloudflare documents as
  // rejected, meaning the work can never be served from cache. NOT verified
  // against workerd here (there is none), which is why this asserts what the
  // handler does rather than what the runtime would answer. Either way it is a
  // free way to make the Worker do the most expensive thing it can do.
  it("SUSPECT: HEAD launches a browser and tries to cache under a HEAD key", async () => {
    const { res } = await get(PATH, { method: "HEAD" });
    await drain();

    expect(res.status).toBe(200);
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(cachePuts).toHaveLength(1);
    expect(cachePuts[0]!.method).toBe("HEAD");
  });

  // A 404 must never reach the cache: there is nothing to store, and a cached
  // 404 for a food bank that is about to gain a shopping list would outlast it
  // by a week. The match is not even attempted -- the D1 read gates it.
  it("never touches the cache for an unknown food bank", async () => {
    const { res } = await get("/needs/at/no-such-foodbank/screenshots/homepage.png");
    await drain();

    expect(res.status).toBe(404);
    expect(cacheMatches).toEqual([]);
    expect(cachePuts).toEqual([]);
  });

  // SUSPECT, pinned not fixed -- the same shape the sibling favicon suite
  // records. A screenshot served entirely from the Workers cache STILL runs
  // getFoodbankBySlug's two-statement batch, because the D1 read happens
  // before cache.match and the row is used only to reach the URL column, which
  // a cache hit does not need.
  //
  // Django did not pay this: FetchFromCacheMiddleware.process_request returns
  // the cached response and the view never runs, so no query is issued --
  // read at django/middleware/cache.py:151-175 in the Django 5.2.6 installed
  // on this machine. Port-only, and paid by every cached screenshot request.
  it("SUSPECT: a cache hit still pays the D1 lookup, which Django's @cache_page skipped", async () => {
    await get(PATH);
    await drain();
    prepared = [];

    await get(PATH);

    expect(prepared.map((p) => p.sql)).toEqual([
      "SELECT * FROM foodbank WHERE slug = ?",
      "SELECT * FROM foodbankchange_full WHERE id = (SELECT latest_need_id FROM foodbank WHERE slug = ?)",
    ]);
  });
});

// ===========================================================================
// Cache tags: what a purge can and cannot reach
// ===========================================================================
//
// middleware/cacheTag.ts stamps `fb-<slug>` on everything under
// /needs/at/<slug>/, so queues/cachePurge.ts can drop a food bank's pages when
// it changes -- including its screenshots, which go stale the moment the food
// bank redesigns its website. The interesting half is what that cannot reach.

describe("wfbnFoodbankScreenshot: cache tags", () => {
  it("leaves the response tagged with its food bank, so a purge covers it", async () => {
    const { res } = await get(PATH);

    expect(res.headers.get("Cache-Tag")).toBe("fb-salisbury");
  });

  // SUSPECT, pinned not fixed, and the reason a week-long TTL on a wrong image
  // matters. cacheTag runs on the way OUT; the cache write happens INSIDE the
  // handler, before it. So the copy sitting in the Workers cache has no
  // Cache-Tag at all and a tag purge cannot evict it -- only the edge copy,
  // which was tagged, goes. The Worker then re-serves the same stale bytes
  // from its own cache and re-tags them on the way out, so the purge appears
  // to have worked and has not.
  it("SUSPECT: the CACHED copy carries no Cache-Tag, so a purge cannot evict it", async () => {
    await get(PATH);
    await drain();

    expect(cachePuts[0]!.headers["cache-tag"]).toBeUndefined();
    expect(Object.keys(cachePuts[0]!.headers).sort()).toEqual(["cache-control", "content-type"]);
  });

  // A 404 gets no tag (cacheTag returns early on a non-ok response), which is
  // right here -- there are no bytes to purge -- but is pinned next to the
  // above so the two rules are not confused for one.
  it("puts no tag on the 404 for a food bank with no such page", async () => {
    const { res } = await get("/needs/at/no-pages/screenshots/homepage.png");

    expect(res.headers.get("Cache-Tag")).toBeNull();
  });
});
