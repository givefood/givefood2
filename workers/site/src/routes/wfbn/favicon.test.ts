import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/wfbn/favicon.ts -- wfbnFoodbankFavicon and
// wfbnFoodbankDonationpointFavicon, the two <img> tags that put a food
// bank's (or a shop's) own site icon next to its link. Ported from gfwfbn
// `foodbank_favicon` (gfwfbn/views.py:509-524) and
// `foodbank_donationpoint_favicon` (:1027-1043) over get_favicon()
// (givefood/utils/general.py:167-176), all three read in full alongside
// this file.
//
// WHY THIS FILE EXISTS. A favicon is the single least-noticed pixel on the
// page, and every way this route can go wrong produces a 200 with an image
// in it. There is no broken-image icon to see and no error to log:
//
//   * THE WEEK-LONG CACHE MAKES EVERY MISTAKE STICKY. A response is written
//     into the Workers Cache API with `public, max-age=604800` from inside
//     the handler. Whatever bytes were on hand at that instant -- Google's
//     icon, the bundled default, or the body of a 404 from this site's own
//     asset layer -- are what that food bank's favicon URL serves for the
//     next seven days. There is no purge path for it: the tag that would
//     make one possible is added by middleware AFTER the cache write (see
//     the cache-tag block at the bottom, which pins exactly that).
//   * THE FALLBACK IS INDISTINGUISHABLE FROM SUCCESS. Django kept the
//     default favicon in memory (views.py:30-32 reads it off disk at import
//     time); this port fetches it over HTTP on every fallback, and returns
//     it with status 200 and Content-Type image/png whatever came back.
//     A site-wide outage of the default asset therefore does not fail --
//     it caches an error body as a PNG for a week, per food bank.
//   * IT IS THE ONE ROUTE THAT CALLS A THIRD PARTY LIVE, ON THE REQUEST
//     PATH. Everything else billed or rate-limited goes through R2 and the
//     media-backfill queue (routes/media.ts); the module's header explains
//     why Google's favicon service is the exception. That makes the exact
//     upstream URL a contract with a service nobody here controls, so it is
//     asserted character by character rather than by shape.
//
// So every test below reads the upstream URL, the response body, the cache
// entry or the seeded row -- never merely the status code.
//
// REAL EVERYTHING, the same harness as routes/public/frag.test.ts and
// routes/public/manifest.test.ts:
//   * THE REAL PRODUCTION APP (workers/site/src/index.ts's default export),
//     because the route REGISTRATIONS are half of what is being tested here.
//     `/needs/at/:slug/favicon.png` is a param followed by a literal in the
//     same segment only by luck -- the ".png" is its own literal segment
//     tail, and index.ts:377-384 documents the sibling screenshot route
//     silently 404ing for getting exactly this wrong. A hand-built router
//     would assert a registration that does not exist.
//   * REAL SQLITE built by schemaFor() from the real migrations, so
//     getFoodbankBySlug's two-statement batch and getDonationPointBySlugs'
//     view read run against the columns production has.
//   * The real 404 page, the real securityHeaders/cacheTag/pageCacheControl
//     middleware chain, and the real APPEND_SLASH probe.
//
// MOCKED, and only these: `fetch` (it leaves the machine -- Google and this
// site's own asset layer), `caches` (node has no CacheStorage at all; see
// the stub's own comment for what it does and does not model), and D1,
// wrapped over node:sqlite.
//
// PARITY CLAIMS HERE WERE RUN, NOT REASONED. The urlparse() outputs quoted
// in the "domain extraction" block came from CPython 3.13.0 on this machine
// (`python3 -c "from urllib.parse import urlparse; ..."`), not from memory.
// The module's claim that google.com/s2/favicons 301s to this gstatic
// endpoint is NOT verified here -- it needs the network, and this suite has
// none.
//
// MUTATION-TESTED, per TESTING.md's convention: the repo was copied to a
// scratchpad OUTSIDE this tree (no source file here was ever edited),
// favicon.ts broken there one change at a time, and this file re-run against
// each mutant. 34 mutants, 1 survivor, provably equivalent and left alone:
//
//   * `if (!url) return null;` deleted from fetchFaviconFor. The guard is
//     redundant given the try/catch immediately below it: `new URL("")` and
//     `new URL(null)` both throw TypeError (run, not assumed), so an empty
//     or null url reaches the same `return null` one line later either way.
//     It is still the right line to keep -- it is what makes the parameter's
//     `string | null` type work without a cast, and it says the intent
//     Django's `if foodbank.url:` says.
//
// The 33 that died include: hostname widened to host (the port comes back);
// each of the five gstatic parameters altered or dropped; the size changed;
// the endpoint swapped for Django's google.com/s2/favicons; the `url`
// parameter sent as https or as the whole stored URL; `response.ok` deleted;
// the URL-parse catch falling through to a fetch instead of returning null;
// the Content-Type, the Cache-Control and the response body each altered or
// dropped; the upstream response's own headers passed through; the cache
// lookup skipped, its result ignored, hoisted above the D1 read, keyed on a
// fixed URL, or keyed on a query-stripped one; the cache write removed,
// awaited instead of waitUntil'd, or storing the un-cloned response; the
// default-favicon fallback removed and its URL altered; both 404 guards; the
// donation point served with its food bank's url; the donation point lookup
// losing its foodbank scope or taking the wrong slug; and -- the two that
// matter most for the suspects below -- the upstream fetch given the
// try/catch its own header comment claims it has, and the default-asset
// fetch given an ok check.

const ORIGIN = "https://www.givefood.org.uk";

// The upstream call, spelled out rather than imported: nothing in favicon.ts
// is exported but the two handlers, and a constant retyped here is a second
// copy on purpose -- it is what makes "the URL Google is asked for" a fact a
// test can break on rather than a value that silently follows the source.
const GSTATIC_PREFIX = "https://t0.gstatic.com/faviconV2";
const DEFAULT_FAVICON_URL = "https://www.givefood.org.uk/static/img/default_favicon.png";

// @cache_page(SECONDS_IN_WEEK) on both Django views.
const CACHE_CONTROL_WEEK = "public, max-age=604800";

type Bindable = null | number | bigint | string | Uint8Array;

// ---------------------------------------------------------------------------
// The D1 Sessions surface packages/db uses, over node:sqlite -- copied from
// routes/api1.test.ts rather than reinvented. batch() is not optional here:
// getFoodbankBySlug sends the food bank row and its latest need as ONE batch
// (packages/db/src/foodbank.ts:246) and indexes straight into the result
// array, so this must run the statements in order and return one result per
// input.
//
// `prepared` records the SQL that actually reached the engine, which is the
// only way to see the two claims this suite makes about cost: that a favicon
// served entirely from cache STILL pays a D1 round trip, and that an unknown
// food bank never gets as far as the donation point lookup.
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
// Node has no CacheStorage, so unlike D1 there is nothing real to wrap. What
// this models is only what favicon.ts uses: match(request) and put(request,
// response), keyed on the request's METHOD AND FULL URL -- query string
// included, because Cloudflare's cache key includes it and the "different
// query string, different entry" test below is the whole reason to say so.
//
// WHAT IT DELIBERATELY DOES NOT MODEL, so that nothing here is mistaken for
// evidence about the real thing:
//   * Vary. The real key is URL plus whatever Vary says; header-only
//     differences between two requests are one entry here.
//   * put()'s documented refusals (non-GET requests, 206/302 responses).
//     `putThrows` exists to drive the handler's behaviour when a put
//     rejects, not to claim which puts workerd would reject.
//   * Header mutability. match() here returns a freshly constructed Response
//     whose headers the middleware chain can write to. Whether workerd's
//     cache.match() returns an immutable Response has NOT been checked, and
//     if it does, securityHeaders would throw on every cache hit -- see the
//     note in the cache-hit block.
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
        cacheMatches.push({ key: request.url, method: request.method });
        const hit = cacheStore.get(`${request.method} ${request.url}`);
        return hit ? new Response(hit.body, { headers: hit.headers }) : undefined;
      },
      put: async (request: Request, response: Response): Promise<void> => {
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
// fetch: Google's favicon service and this site's own asset layer
// ---------------------------------------------------------------------------

let fetchCalls: string[];
/** Google's answer. "network-error" makes fetch REJECT, which is not the same as a non-200. */
let gstatic: { status: number; body: string; contentType: string } | "network-error";
/** The bundled default, fetched over HTTP from /static/ rather than held in memory as Django holds it. */
let defaultAsset: { status: number; body: string };

async function stubFetch(input: unknown): Promise<Response> {
  const url = String(input);
  fetchCalls.push(url);

  if (url.startsWith(GSTATIC_PREFIX)) {
    if (gstatic === "network-error") throw new TypeError("Network connection lost.");
    // 204/205/304 are null-body statuses: `new Response("", { status: 304 })`
    // throws in undici and in workerd alike, so the stub has to model that
    // rather than fabricate a 304 with bytes in it.
    const nullBody = gstatic.status === 204 || gstatic.status === 205 || gstatic.status === 304;
    return new Response(nullBody ? null : gstatic.body, { status: gstatic.status, headers: { "Content-Type": gstatic.contentType } });
  }
  if (url === DEFAULT_FAVICON_URL) {
    return new Response(defaultAsset.body, { status: defaultAsset.status, headers: { "Content-Type": "image/png" } });
  }
  throw new Error(`unexpected fetch: ${url}`);
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

function env(): AppEnv["Bindings"] {
  return {
    DB: { withSession: () => d1Session(db, prepared) },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    D1_DATABASE_NAME: "givefood-test",
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

// foodbanklocation and its view are here only because of the APPEND_SLASH
// probe: index.ts's notFound handler re-dispatches `<path>/` through the whole
// app, and `/needs/at/<slug>/favicon.png/` matches the location detail route
// with locslug="favicon.png". Without these two objects a 404 from this route
// would come back a 500 from a table that does not exist -- which is precisely
// the shared-fixture breakage schema.testkit.ts's own header describes.
const SCHEMA = schemaFor(
  "foodbank",
  "foodbankchange",
  "foodbankchange_full",
  "foodbankdonationpoint",
  "foodbankdonationpoint_full",
  "foodbanklocation",
  "foodbanklocation_full",
);

// `url` is TEXT NOT NULL on foodbank (0001_core.sql) -- so "no website" is the
// EMPTY STRING here, never SQL NULL, and that is what the handler's `if (!url)`
// guard actually meets in production.
function seedFoodbank(o: { id: number; slug: string; name: string; url: string }): void {
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, slug, address, postcode, country, lat_lng, network,
       charity_just_foodbank, contact_email, url, shopping_list_url, address_is_administrative,
       is_closed, no_locations, days_between_needs, created, modified)
     VALUES (?, ?, ?, ?, '1 High Street', 'SP1 1AA', 'England', '51.07,-1.79', 'Trussell Trust',
       0, ?, ?, '', 0, 0, 0, 14, '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run(o.id, String(o.id).padStart(32, "a"), o.name, o.slug, `info@${o.slug}.invalid`, o.url);
}

// `url` IS nullable on foodbankdonationpoint, so the donation point half of
// this route has a null case its food bank half cannot have.
function seedDonationPoint(o: { id: number; foodbankId: number; slug: string; name: string; url: string | null }): void {
  db.prepare(
    `INSERT INTO foodbankdonationpoint (id, uuid, foodbank_id, name, slug, address, postcode, country,
       lat_lng, latitude, longitude, is_closed, in_store_only, url, modified)
     VALUES (?, ?, ?, ?, ?, '3 Retail Park', 'SP3 3CC', 'England', '51.06,-1.78', 51.06, -1.78, 0, 0, ?,
       '2020-01-01 00:00:00.000000')`,
  ).run(o.id, String(o.id).padStart(32, "d"), o.foodbankId, o.name, o.slug, o.url);
}

// THE FIXTURE IS THE TEST. Every row here exists to turn exactly one rule on
// or off relative to its neighbour:
//
//   salisbury      a normal food bank whose url carries a PATH AND A QUERY,
//                  so "domain only" is visible in the upstream URL rather
//                  than assumed.
//   no-website     url = "" -- Django's `if foodbank.url:` false branch.
//   bare-domain    url with no scheme, which `new URL()` rejects and
//                  CPython's urlparse() accepts. The one place the port and
//                  Django provably answer differently.
//   bath           a SECOND food bank whose donation point has the SAME slug
//                  as salisbury's. It must never be reachable through
//                  salisbury's URL: getDonationPointBySlugs scopes on
//                  foodbank_slug, and a lost scope would serve one shop's
//                  icon under another food bank's address.
function seed(): void {
  seedFoodbank({ id: 1, slug: "salisbury", name: "Salisbury Foodbank", url: "https://salisburyfoodbank.org.uk/give-help/shopping-list/?ref=givefood" });
  seedFoodbank({ id: 2, slug: "no-website", name: "No Website Foodbank", url: "" });
  seedFoodbank({ id: 3, slug: "bare-domain", name: "Bare Domain Foodbank", url: "barefoodbank.org.uk" });
  seedFoodbank({ id: 4, slug: "bath", name: "Bath Foodbank", url: "https://bathfoodbank.org.uk/" });

  seedDonationPoint({ id: 10, foodbankId: 1, slug: "tesco-castle-street", name: "Tesco Castle Street", url: "https://www.tesco.com/store-locator/castle-street" });
  seedDonationPoint({ id: 11, foodbankId: 1, slug: "no-url-shop", name: "No URL Shop", url: null });
  // Same slug as salisbury's, different food bank, different domain.
  seedDonationPoint({ id: 12, foodbankId: 4, slug: "tesco-castle-street", name: "Tesco Castle Street", url: "https://www.sainsburys.co.uk/bath" });
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  seed();

  prepared = [];
  waited = [];
  errorLogs = [];
  fetchCalls = [];
  cacheStore = new Map<string, CacheEntry>();
  cacheMatches = [];
  cachePuts = [];
  putThrows = false;
  gstatic = { status: 200, body: "GOOGLE-ICON-BYTES", contentType: "image/x-icon" };
  defaultAsset = { status: 200, body: "BUNDLED-DEFAULT-BYTES" };

  vi.stubGlobal("fetch", stubFetch);
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

/** Every waitUntil promise settled, so the cache write is observable. allSettled: one of them rejects on purpose. */
async function drain(): Promise<void> {
  await Promise.allSettled(waited);
}

/** The one gstatic call this request made. Fails loudly rather than returning undefined. */
function onlyGstaticCall(): string {
  const calls = fetchCalls.filter((url) => url.startsWith(GSTATIC_PREFIX));
  expect(calls).toHaveLength(1);
  return calls[0]!;
}

const FB_PATH = "/needs/at/salisbury/favicon.png";
const DP_PATH = "/needs/at/salisbury/donationpoint/tesco-castle-street/favicon.png";

// ===========================================================================
// Registration: which URLs reach these two handlers at all
// ===========================================================================
//
// gfwfbn/urls/generic.py:14,17 registers both patterns OUTSIDE i18n_patterns
// (givefood/urls.py includes that module directly), so neither has ever had a
// language-prefixed form in Django, and index.ts:376/385 registers them the
// same way. Worth pinning in both directions: a prefixed form that started
// working would be a fifth cache entry per food bank for identical bytes, and
// a bare form that stopped working would blank the icon on every page that
// links one.

describe("favicon routes: the registered URL set", () => {
  it("serves the food bank favicon at the bare, unprefixed path", async () => {
    const { res, body } = await get(FB_PATH);

    expect(res.status).toBe(200);
    expect(body).toBe("GOOGLE-ICON-BYTES");
  });

  it("serves the donation point favicon at its own five-segment path", async () => {
    const { res, body } = await get(DP_PATH);

    expect(res.status).toBe(200);
    expect(body).toBe("GOOGLE-ICON-BYTES");
  });

  // The whole point of asserting these: index.ts:377-384 records the sibling
  // screenshot route being registered as `:page{...}.png` and matching
  // NOTHING, silently, because Hono cannot match a param followed by literal
  // text inside one segment. `favicon.png` is a plain literal segment and so
  // is fine -- but "fine" is exactly what the broken spelling also looked
  // like until someone requested one.
  it.each([
    ["/cy/needs/at/salisbury/favicon.png", "Welsh, and gfwfbn/urls/generic.py is outside i18n_patterns"],
    ["/ga/needs/at/salisbury/donationpoint/tesco-castle-street/favicon.png", "Irish, same reason"],
    ["/needs/at/salisbury/favicon.PNG", "the extension is a literal, and literals are case-sensitive"],
    ["/needs/at/salisbury/favicon.ico", "the URL Django registered is .png"],
    ["/needs/at/salisbury/donationpoint/favicon.png", "a donation point path with no dpslug"],
    ["/needs/at/favicon.png", "no slug at all"],
  ])("404s %s (%s), never reaching Google", async (path) => {
    const { res } = await get(path);
    await drain();

    expect(res.status).toBe(404);
    expect(fetchCalls).toEqual([]);
    expect(cachePuts).toEqual([]);
  });

  // GET-only, as Django's urls.py registers them. Not merely tidiness: the
  // handler makes an outbound third-party call and writes a week-long cache
  // entry, so any method that reached it would be an unauthenticated way to
  // spend Google requests and fill the cache.
  it.each(["POST", "PUT", "DELETE", "PATCH"])("does not answer %s at all", async (method) => {
    const { res } = await get(FB_PATH, { method });
    await drain();

    expect(res.status).toBe(404);
    expect(fetchCalls).toEqual([]);
    expect(cacheMatches).toEqual([]);
  });
});

// ===========================================================================
// The Google call
// ===========================================================================
//
// get_favicon() (givefood/utils/general.py:167-176) builds
// "https://www.google.com/s2/favicons?domain=%s&sz=64". This port calls
// t0.gstatic.com/faviconV2 with five parameters instead; the module's header
// says the former is a 301 to the latter, which is NOT verified here (it
// needs the network). What IS pinned is the exact URL that leaves the Worker,
// because it is a contract with a service that will not tell us when we start
// sending it something it does not recognise -- it will just answer with a
// grey globe, forever, in a shape indistinguishable from success.

describe("wfbnFoodbankFavicon: the upstream request", () => {
  it("asks gstatic for the DOMAIN ONLY, at size 64, with the exact five parameters", async () => {
    await get(FB_PATH);

    expect(onlyGstaticCall()).toBe(
      "https://t0.gstatic.com/faviconV2" +
        "?client=SOCIAL" +
        "&type=FAVICON" +
        "&fallback_opts=TYPE%2CSIZE%2CURL" +
        "&url=http%3A%2F%2Fsalisburyfoodbank.org.uk" +
        "&size=64",
    );
  });

  // The seeded url is https with a path and a query. All three are dropped:
  // get_favicon() takes urlparse().netloc and nothing else, and this port
  // takes URL().hostname and re-spells the scheme as http.
  it("drops the path, the query and the https scheme from the stored url", async () => {
    await get(FB_PATH);
    const called = onlyGstaticCall();

    expect(called).toContain("url=http%3A%2F%2Fsalisburyfoodbank.org.uk&");
    expect(called).not.toContain("shopping-list");
    expect(called).not.toContain("ref%3Dgivefood");
    expect(called).not.toContain("https%3A%2F%2Fsalisburyfoodbank");
  });

  // sz=64 became size=64 with the endpoint change; both mean the same thing
  // and the number is the part that matters, because the <img> is rendered at
  // a fixed size and a 16px icon scaled up is visibly mushy.
  it("keeps Django's 64-pixel size", async () => {
    await get(FB_PATH);

    expect(onlyGstaticCall()).toContain("&size=64");
  });

  // ONE call per uncached request, not one per redirect-chasing retry, and
  // not one speculative call for the default alongside it.
  it("makes exactly one outbound request when Google answers", async () => {
    await get(FB_PATH);

    expect(fetchCalls).toHaveLength(1);
  });
});

// ===========================================================================
// Domain extraction, and where it parts company with Django
// ===========================================================================
//
// PARITY, MEASURED. Each urlparse() value below was printed by CPython 3.13.0
// on this machine, not recalled. The port uses `new URL(url).hostname`, which
// differs from `urlparse(url).netloc` in three ways that reach production
// data. All three are pinned as they behave, not as anyone might prefer.

describe("wfbnFoodbankFavicon: domain extraction", () => {
  // urlparse("http://x.example:8080/a").netloc == "x.example:8080"; hostname
  // is "x.example". Harmless in itself -- Google is being asked about the
  // site, not the port -- and arguably better, since a :8080 in the parameter
  // is unlikely to resolve to anything Google has an icon for.
  it("drops a port that Django's netloc would have kept", async () => {
    db.prepare("UPDATE foodbank SET url = ? WHERE slug = 'salisbury'").run("http://salisburyfoodbank.org.uk:8080/list/");
    await get(FB_PATH);

    expect(onlyGstaticCall()).toContain("url=http%3A%2F%2Fsalisburyfoodbank.org.uk&");
  });

  // urlparse("https://user:pw@Example.COM/").netloc == "user:pw@Example.COM";
  // hostname is "example.com". The credential strip is a straight improvement
  // (Django was sending stored basic-auth credentials to Google in a query
  // string); the lowercasing is DNS-correct either way.
  it("strips userinfo and lowercases the host, unlike Django's netloc", async () => {
    db.prepare("UPDATE foodbank SET url = ? WHERE slug = 'salisbury'").run("https://user:pw@Example.COM/");
    await get(FB_PATH);

    const called = onlyGstaticCall();
    expect(called).toContain("url=http%3A%2F%2Fexample.com&");
    expect(called).not.toContain("user");
    expect(called).not.toContain("pw");
  });

  // THE ONE THAT CHANGES THE ANSWER. urlparse("barefoodbank.org.uk").netloc
  // is "" -- Django would still call Google, with an empty domain, and serve
  // whatever came back with a 200. `new URL()` throws on a scheme-less
  // string, so this port never calls Google at all and serves the bundled
  // default instead. Both are icons; only one of them cost a subrequest.
  it("SUSPECT-BY-DIVERGENCE: a scheme-less url never reaches Google, where Django would have called it with an empty domain", async () => {
    const { res, body } = await get("/needs/at/bare-domain/favicon.png");

    expect(res.status).toBe(200);
    expect(body).toBe("BUNDLED-DEFAULT-BYTES");
    expect(fetchCalls).toEqual([DEFAULT_FAVICON_URL]);
  });

  // A non-http scheme parses fine and yields an EMPTY hostname, so the
  // parameter goes out as `url=http://` with nothing after it. Pinned
  // because it is the one shape that still spends a Google request on a
  // question that cannot have an answer -- and because it is the case where
  // the port and Django agree, both sending an empty domain.
  it("SUSPECT: a mailto: url still spends a Google request, on an empty domain", async () => {
    db.prepare("UPDATE foodbank SET url = ? WHERE slug = 'salisbury'").run("mailto:info@salisburyfoodbank.org.uk");
    await get(FB_PATH);

    expect(onlyGstaticCall()).toContain("&url=http%3A%2F%2F&");
  });

  // Django's `if not url` and this port's `if (!url)` agree exactly here, and
  // this is the branch most food banks without a website actually take: the
  // column is NOT NULL, so "no website" is stored as "".
  //
  // This test also passes with that guard DELETED -- it is this suite's one
  // surviving mutant, and the survival is a property of the code rather than
  // a gap here: `new URL("")` throws, so the catch two lines down returns the
  // same null. See the header comment.
  it("skips Google entirely for an empty url, as Django's `if foodbank.url:` does", async () => {
    const { res, body } = await get("/needs/at/no-website/favicon.png");

    expect(res.status).toBe(200);
    expect(body).toBe("BUNDLED-DEFAULT-BYTES");
    expect(fetchCalls).toEqual([DEFAULT_FAVICON_URL]);
  });
});

// ===========================================================================
// The response
// ===========================================================================

describe("wfbnFoodbankFavicon: the response it builds", () => {
  // views.py:524 `HttpResponse(favicon, content_type='image/png')` -- the type
  // is DECLARED, never taken from upstream. Google answers with image/x-icon
  // here on purpose: a route that forwarded the upstream type would serve an
  // .ico labelled as one, which most browsers cope with and Django never did.
  it("declares image/png whatever Google actually sent", async () => {
    gstatic = { status: 200, body: "GOOGLE-ICON-BYTES", contentType: "image/x-icon" };
    const { res, body } = await get(FB_PATH);

    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(body).toBe("GOOGLE-ICON-BYTES");
  });

  // @cache_page(SECONDS_IN_WEEK) on both views. This is the ONLY thing making
  // the live third-party call affordable, so it is asserted as the exact
  // string rather than by parsing a max-age out of it.
  it("sends the week-long Cache-Control @cache_page(SECONDS_IN_WEEK) sent", async () => {
    const { res } = await get(FB_PATH);

    expect(res.headers.get("Cache-Control")).toBe(CACHE_CONTROL_WEEK);
  });

  // middleware/pageCacheControl.ts fills a Cache-Control gap on HTML, RSS and
  // markdown only -- and never overrides. Pinned from this side too, because
  // if the route's own header ever went missing the middleware would NOT
  // supply a substitute (image/png is not in CACHEABLE_TYPES) and the favicon
  // would silently become uncacheable in every browser.
  it("keeps its own Cache-Control rather than the middleware's page default", async () => {
    const { res } = await get(FB_PATH);

    expect(res.headers.get("Cache-Control")).toBe(CACHE_CONTROL_WEEK);
    expect(res.headers.get("Cache-Control")).not.toContain("s-maxage");
  });

  it("carries the site-wide security headers, like every other response", async () => {
    const { res } = await get(FB_PATH);

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
  });

  // The status is built by hand as a bare `new Response(body, { headers })`,
  // so it is 200 on EVERY path through the handler -- Google's icon, the
  // fallback, and (see the suspect block) an error body from the fallback
  // fetch. There is no upstream status this route can propagate.
  it.each([
    ["Google answers", 200, "UPSTREAM-BYTES"],
    ["Google 404s the domain", 404, "BUNDLED-DEFAULT-BYTES"],
    ["Google 500s", 500, "BUNDLED-DEFAULT-BYTES"],
    ["Google rate-limits", 429, "BUNDLED-DEFAULT-BYTES"],
  ])("answers 200 when %s", async (_why, status, expectedBody) => {
    // The same bytes for every row, so the assertion is genuinely about which
    // SOURCE was used and not about which fixture string was set.
    gstatic = { status, body: "UPSTREAM-BYTES", contentType: "text/html" };
    const { res, body } = await get(FB_PATH);

    expect(res.status).toBe(200);
    expect(body).toBe(expectedBody);
  });

  // `response.ok` is the guard, so a 3xx that fetch did not follow falls back
  // too. Worth pinning next to the 4xx/5xx rows above because "ok" and
  // "status < 400" are two different readings of the same intent.
  it("treats a 304 from Google as a failure and falls back", async () => {
    gstatic = { status: 304, body: "", contentType: "image/png" };
    const { body } = await get(FB_PATH);

    expect(body).toBe("BUNDLED-DEFAULT-BYTES");
  });

  // The fallback fetch goes to the ASSET the site itself serves, hardcoded to
  // www.givefood.org.uk rather than derived from c.env.SITE_DOMAIN or from
  // the incoming request -- so a preview deployment's fallback pulls
  // production's bytes. Harmless (it is the same file) but pinned, because
  // the hardcoding is invisible from any response.
  it("fetches the default from production's own /static/ URL, not from the requested origin", async () => {
    gstatic = { status: 503, body: "", contentType: "text/html" };
    await get(FB_PATH);

    expect(fetchCalls[1]).toBe("https://www.givefood.org.uk/static/img/default_favicon.png");
  });
});

// ===========================================================================
// The Workers Cache API
// ===========================================================================
//
// The module's own header calls this "this repo's first use of the Cache
// API", which is the reason for the density here: there is no other route to
// compare its behaviour against, and every mistake it can make is a wrong
// image served for a week with no way to purge it.

describe("wfbnFoodbankFavicon: the cache", () => {
  it("looks in the cache before calling Google, keyed on the request itself", async () => {
    await get(FB_PATH);

    expect(cacheMatches).toEqual([{ key: `${ORIGIN}${FB_PATH}`, method: "GET" }]);
  });

  // The stored entry is the response as the HANDLER built it: 200, image/png,
  // the week. Read back as values -- "cache.put was called" would pass with
  // an empty body or a 404 in it.
  it("writes the built response into the cache, bytes and headers", async () => {
    await get(FB_PATH);
    await drain();

    expect(cachePuts).toHaveLength(1);
    expect(cachePuts[0]!.key).toBe(`${ORIGIN}${FB_PATH}`);
    expect(cachePuts[0]!.status).toBe(200);
    expect(cachePuts[0]!.body).toBe("GOOGLE-ICON-BYTES");
    expect(cachePuts[0]!.headers["content-type"]).toBe("image/png");
    expect(cachePuts[0]!.headers["cache-control"]).toBe(CACHE_CONTROL_WEEK);
  });

  // The second request must not call Google. This is the entire economics of
  // serving a favicon live rather than through the media-backfill queue, and
  // it is what the module's header trades against media.ts's R2 design.
  it("serves the second request from the cache, with no second Google call", async () => {
    await get(FB_PATH);
    await drain();
    fetchCalls = [];

    const { res, body } = await get(FB_PATH);

    expect(res.status).toBe(200);
    expect(body).toBe("GOOGLE-ICON-BYTES");
    expect(fetchCalls).toEqual([]);
    expect(cachePuts).toHaveLength(1); // and no second write
  });

  // A cache hit returns the STORED response object and stops. The headers on
  // it are the stored ones, so the week-long Cache-Control survives the round
  // trip -- if it did not, a cached favicon would be re-fetched by every
  // browser on every page view while the edge kept serving it.
  it("returns the cached headers, not a freshly built set", async () => {
    await get(FB_PATH);
    await drain();

    const { res } = await get(FB_PATH);

    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe(CACHE_CONTROL_WEEK);
  });

  // NOTE, not an assertion about workerd: this stub's match() returns a newly
  // constructed Response, whose headers securityHeaders and cacheTag can
  // write to on the way out. Whether Cloudflare's cache.match() returns an
  // immutable Response has not been checked here -- if it does, that
  // middleware would throw on every cache HIT, which is a failure this suite
  // cannot see. Recorded so nobody reads the test above as evidence either
  // way.
  it("comes back through the middleware chain intact on a hit", async () => {
    await get(FB_PATH);
    await drain();

    const { res } = await get(FB_PATH);

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  // waitUntil, not await: the visitor's image must not wait on a cache write.
  // Proved by never resolving the put -- an awaited write would hang this
  // test rather than fail it.
  it("answers before the cache write settles", async () => {
    vi.stubGlobal("caches", {
      default: {
        match: async () => undefined,
        put: () => new Promise<void>(() => {}),
      },
    });

    const { res, body } = await get(FB_PATH);

    expect(res.status).toBe(200);
    expect(body).toBe("GOOGLE-ICON-BYTES");
    expect(waited).toHaveLength(1);
  });

  // A rejected cache.put is an unhandled rejection inside waitUntil, not a
  // failed request: the response has already been returned. Pinned because it
  // means a cache that is refusing writes degrades to "call Google every
  // time" silently -- expensive, and visible only on Google's side.
  it("still serves the image when the cache write rejects", async () => {
    putThrows = true;
    const { res, body } = await get(FB_PATH);
    await drain();

    expect(res.status).toBe(200);
    expect(body).toBe("GOOGLE-ICON-BYTES");
    expect(cachePuts).toHaveLength(1);
  });

  // A 404 must never reach the cache: there is nothing to store, and a cached
  // 404 for a food bank that is about to be created would outlast it by a
  // week. The match is not even attempted -- the D1 lookup gates it.
  it("never touches the cache for an unknown food bank", async () => {
    const { res } = await get("/needs/at/no-such-foodbank/favicon.png");
    await drain();

    expect(res.status).toBe(404);
    expect(cacheMatches).toEqual([]);
    expect(cachePuts).toEqual([]);
  });

  // SUSPECT, pinned not fixed. The module's header says the key is
  // "query-string-free, so no fragmentation risk" -- true of the URLs the
  // TEMPLATES emit, but the key is `c.req.raw`, so the query string a CLIENT
  // sends is part of it. Anyone can mint an unbounded number of cache entries
  // AND an unbounded number of live Google calls by appending a counter,
  // which is exactly the unbounded-minting problem routes/media.ts's `?s=`
  // allowlist exists to prevent on the neighbouring route family.
  it("SUSPECT: a client-supplied query string mints a new cache entry and a new Google call", async () => {
    await get(FB_PATH);
    await drain();
    fetchCalls = [];

    const { res } = await get(`${FB_PATH}?cachebuster=1`);
    await drain();

    expect(res.status).toBe(200);
    expect(fetchCalls.filter((url) => url.startsWith(GSTATIC_PREFIX))).toHaveLength(1);
    expect(cachePuts).toHaveLength(2);
    expect(cachePuts[1]!.key).toBe(`${ORIGIN}${FB_PATH}?cachebuster=1`);
  });

  // Two different food banks are two different entries, which is the thing
  // the URL-keyed design is actually for. Asserted with different upstream
  // bytes per food bank so a key collision shows up as the WRONG IMAGE rather
  // than as a missing one.
  it("keys per food bank, so one food bank's icon never serves as another's", async () => {
    gstatic = { status: 200, body: "SALISBURY-ICON", contentType: "image/png" };
    await get(FB_PATH);
    await drain();

    gstatic = { status: 200, body: "BATH-ICON", contentType: "image/png" };
    const first = await get("/needs/at/bath/favicon.png");
    await drain();

    // and back to the first, which must still be its own bytes
    const second = await get(FB_PATH);

    expect(first.body).toBe("BATH-ICON");
    expect(second.body).toBe("SALISBURY-ICON");
  });

  // SUSPECT, pinned not fixed. A favicon served entirely from the cache STILL
  // runs getFoodbankBySlug's two-statement batch: the D1 lookup happens
  // before cache.match, and the food bank row is used only to reach `.url`,
  // which the cache hit does not need. Every cached favicon on a page of
  // search results is therefore a D1 round trip. Django had the same shape
  // (@cache_page short-circuits the whole view, so it did NOT) -- this is a
  // port-only cost.
  it("SUSPECT: a cache hit still pays the D1 lookup, which Django's @cache_page skipped", async () => {
    await get(FB_PATH);
    await drain();
    prepared = [];

    await get(FB_PATH);

    expect(prepared.map((p) => p.sql)).toEqual([
      "SELECT * FROM foodbank WHERE slug = ?",
      "SELECT * FROM foodbankchange_full WHERE id = (SELECT latest_need_id FROM foodbank WHERE slug = ?)",
    ]);
  });
});

// ===========================================================================
// Suspects: the failure modes that answer 200, or do not answer at all
// ===========================================================================

describe("wfbnFoodbankFavicon: what happens when things break", () => {
  // SUSPECT, pinned not fixed, and the clearest thing this suite found.
  //
  // The module's own header says the route "falls back to a bundled default
  // image on any failure (no url, non-200, NETWORK ERROR)". There is no
  // try/catch around the fetch in fetchFaviconFor (favicon.ts:45), so a
  // rejected fetch -- a DNS failure, a connection reset, a Workers subrequest
  // limit -- propagates out of the handler to index.ts's app.onError, which
  // renders the 500 page. A food bank page then has an <img> pointing at a
  // 500 that returns text/html.
  //
  // Django could not hit this either: requests.get() raises the same way and
  // get_favicon() does not catch it. So the comment is wrong about both
  // implementations rather than about this one. Pinned as it behaves.
  it("SUSPECT: a rejected fetch 500s, contrary to the module's own 'network error' claim", async () => {
    gstatic = "network-error";
    const { res } = await get(FB_PATH);

    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(errorLogs.join("\n")).toContain("Network connection lost.");
  });

  it("does not cache anything when the fetch rejects", async () => {
    gstatic = "network-error";
    await get(FB_PATH);
    await drain();

    expect(cachePuts).toEqual([]);
  });

  // SUSPECT, pinned not fixed. The fallback's own `fetch(DEFAULT_FAVICON_URL)`
  // is NOT ok-checked (favicon.ts:57), so if the asset layer answers 404 or
  // 500, that error body is served as image/png with status 200 -- and then
  // written into the cache with a week-long TTL under this food bank's
  // favicon URL. A five-minute deploy blip becomes seven days of a broken
  // icon per food bank that fell back during it, with no purge path (see the
  // cache-tag block below) and nothing logged.
  it("SUSPECT: an error body from the default asset is served as a PNG and cached for a week", async () => {
    gstatic = { status: 503, body: "", contentType: "text/html" };
    defaultAsset = { status: 404, body: "<!doctype html>not found" };

    const { res, body } = await get(FB_PATH);
    await drain();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(body).toBe("<!doctype html>not found");
    expect(cachePuts[0]!.body).toBe("<!doctype html>not found");
    expect(cachePuts[0]!.headers["cache-control"]).toBe(CACHE_CONTROL_WEEK);
    expect(errorLogs).toEqual([]); // nothing anywhere records that this happened
  });

  // The same shape, one layer worse: if the default asset ALSO rejects, the
  // request 500s. Pinned so the two failure ladders are on the record
  // together -- non-200 is silent, rejection is a 500, and neither is what
  // the header comment describes.
  it("SUSPECT: 500s when the default asset fetch itself rejects", async () => {
    gstatic = { status: 503, body: "", contentType: "text/html" };
    vi.stubGlobal("fetch", async (input: unknown) => {
      fetchCalls.push(String(input));
      if (String(input) === DEFAULT_FAVICON_URL) throw new TypeError("Network connection lost.");
      return new Response("", { status: 503 });
    });

    const { res } = await get(FB_PATH);

    expect(res.status).toBe(500);
  });

  // SUSPECT, pinned not fixed. Hono answers HEAD from the GET handler, so a
  // HEAD reaches this route, calls Google live, and attempts a cache.put
  // whose KEY IS A HEAD REQUEST. Cloudflare's Cache API documents put() as
  // rejecting a non-GET request -- not verified against workerd here, which
  // is why this asserts what the handler does (attempt it) rather than what
  // the runtime would answer. Either way it is a free way to make the Worker
  // call Google without ever getting a cache hit back.
  it("SUSPECT: HEAD reaches the handler, calls Google, and tries to cache under a HEAD key", async () => {
    const { res } = await get(FB_PATH, { method: "HEAD" });
    await drain();

    expect(res.status).toBe(200);
    expect(fetchCalls.filter((url) => url.startsWith(GSTATIC_PREFIX))).toHaveLength(1);
    expect(cachePuts).toHaveLength(1);
    expect(cachePuts[0]!.method).toBe("HEAD");
  });

  // SQLite's `=` on TEXT is case-sensitive and no COLLATE NOCASE is declared
  // on foodbank_slug_uniq, so a capitalised slug is simply an unknown food
  // bank. Django's get_object_or_404 on a SlugField behaves the same way.
  // Asserted because "the URL still works if you shout it" is a plausible
  // assumption that would quietly double every cache entry if it were true.
  it("404s a slug in the wrong case rather than resolving it", async () => {
    const { res } = await get("/needs/at/Salisbury/favicon.png");

    expect(res.status).toBe(404);
    expect(fetchCalls).toEqual([]);
  });

  // The 404 is the real 404 page (index.ts's app.notFound -> render404), not
  // a bare status -- an <img> pointing at it gets an HTML document, which is
  // what Django's HttpResponseNotFound did too.
  it("renders the site 404 page, not an empty body", async () => {
    const { res, body } = await get("/needs/at/no-such-foodbank/favicon.png");

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(body).toContain("<html");
  });
});

// ===========================================================================
// wfbnFoodbankDonationpointFavicon
// ===========================================================================
//
// views.py:1032-1043 -- two get_object_or_404 calls, the second SCOPED to the
// first (`FoodbankDonationPoint, slug=dpslug, foodbank=foodbank`), then the
// same get_favicon()/DEFAULT_FAVICON pair. The port reproduces the scope by
// passing `foodbank.slug` -- the value read back out of the row, not the URL
// param -- to getDonationPointBySlugs.

describe("wfbnFoodbankDonationpointFavicon", () => {
  it("uses the DONATION POINT's url, not its food bank's", async () => {
    await get(DP_PATH);

    // salisbury's own url is salisburyfoodbank.org.uk; the shop's is tesco.com.
    expect(onlyGstaticCall()).toContain("&url=http%3A%2F%2Fwww.tesco.com&");
    expect(onlyGstaticCall()).not.toContain("salisburyfoodbank");
  });

  // THE SCOPE TEST. Both food banks have a donation point slugged
  // "tesco-castle-street", with different urls. If the WHERE lost its
  // foodbank_slug clause, Salisbury's page would show Bath's shop icon --
  // a wrong image that looks exactly like a right one. Both directions are
  // asserted so a query that always returned the LAST match would fail too.
  it("scopes the donation point to its own food bank, both ways round", async () => {
    await get(DP_PATH);
    expect(onlyGstaticCall()).toContain("&url=http%3A%2F%2Fwww.tesco.com&");

    fetchCalls = [];
    await get("/needs/at/bath/donationpoint/tesco-castle-street/favicon.png");
    expect(onlyGstaticCall()).toContain("&url=http%3A%2F%2Fwww.sainsburys.co.uk&");
  });

  // The two lookups are ordered and the first one short-circuits: an unknown
  // food bank must never run the donation point query. Read off the SQL,
  // because both paths answer 404 and the response cannot tell them apart.
  it("does not query donation points at all when the food bank is unknown", async () => {
    const { res } = await get("/needs/at/no-such-foodbank/donationpoint/tesco-castle-street/favicon.png");

    expect(res.status).toBe(404);
    expect(prepared.map((p) => p.sql)).not.toContain("SELECT * FROM foodbankdonationpoint_full WHERE slug = ? AND foodbank_slug = ?");
    expect(fetchCalls).toEqual([]);
  });

  it("404s a known food bank's unknown donation point, without calling Google", async () => {
    const { res } = await get("/needs/at/salisbury/donationpoint/no-such-shop/favicon.png");
    await drain();

    expect(res.status).toBe(404);
    expect(fetchCalls).toEqual([]);
    expect(cacheMatches).toEqual([]);
  });

  // A donation point whose foodbank_id points nowhere the URL names: the
  // second lookup runs and finds nothing, which is the 404 above by a
  // different route. Asserted separately because it is the case a JOIN-less
  // "SELECT ... WHERE slug = ?" would get wrong while passing every test
  // that only ever seeds one food bank.
  it("404s when the donation point exists but belongs to another food bank", async () => {
    seedDonationPoint({ id: 13, foodbankId: 4, slug: "bath-only-shop", name: "Bath Only Shop", url: "https://bathonly.example/" });
    const { res } = await get("/needs/at/salisbury/donationpoint/bath-only-shop/favicon.png");

    expect(res.status).toBe(404);
    expect(fetchCalls).toEqual([]);
  });

  // foodbankdonationpoint.url IS nullable (unlike foodbank.url), so this
  // branch takes a genuine SQL NULL rather than an empty string -- and
  // `if (!url)` catches both. Django's `if donationpoint.url:` agrees.
  it("serves the bundled default for a donation point with no url", async () => {
    const { res, body } = await get("/needs/at/salisbury/donationpoint/no-url-shop/favicon.png");

    expect(res.status).toBe(200);
    expect(body).toBe("BUNDLED-DEFAULT-BYTES");
    expect(fetchCalls).toEqual([DEFAULT_FAVICON_URL]);
  });

  it("declares image/png and the week-long Cache-Control, same as the food bank route", async () => {
    const { res } = await get(DP_PATH);

    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe(CACHE_CONTROL_WEEK);
  });

  // The cache is shared between the two handlers -- one caches.default, keyed
  // by URL -- so the donation point's entry must be its own. Different bytes
  // per entry so a collision is a wrong icon, not a missing one.
  it("caches per donation point URL, independently of its food bank's favicon", async () => {
    gstatic = { status: 200, body: "SHOP-ICON", contentType: "image/png" };
    await get(DP_PATH);
    await drain();

    gstatic = { status: 200, body: "FOODBANK-ICON", contentType: "image/png" };
    const fb = await get(FB_PATH);
    await drain();

    const shop = await get(DP_PATH);

    expect(fb.body).toBe("FOODBANK-ICON");
    expect(shop.body).toBe("SHOP-ICON");
    expect(cachePuts.map((p) => p.key)).toEqual([`${ORIGIN}${DP_PATH}`, `${ORIGIN}${FB_PATH}`]);
  });

  it("serves a repeat request from the cache, with no second Google call", async () => {
    await get(DP_PATH);
    await drain();
    fetchCalls = [];

    const { res, body } = await get(DP_PATH);

    expect(res.status).toBe(200);
    expect(body).toBe("GOOGLE-ICON-BYTES");
    expect(fetchCalls).toEqual([]);
  });
});

// ===========================================================================
// Cache tags: what a purge can and cannot reach
// ===========================================================================
//
// middleware/cacheTag.ts stamps `fb-<slug>` on everything under
// /needs/at/<slug>/, so queues/cachePurge.ts can drop a food bank's pages
// when it changes -- including, on the way out, its favicon. The interesting
// half is what that CANNOT reach.

describe("favicon routes: cache tags", () => {
  it("leaves the response tagged with its food bank, so a purge covers it", async () => {
    const { res } = await get(FB_PATH);

    expect(res.headers.get("Cache-Tag")).toBe("fb-salisbury");
  });

  // The donation point favicon is tagged with the FOOD BANK, not the shop:
  // FOODBANK_PATH captures the first segment after /needs/at/. That is what
  // makes "purge this food bank" take its shops' icons with it.
  it("tags a donation point favicon with the food bank's slug", async () => {
    const { res } = await get(DP_PATH);

    expect(res.headers.get("Cache-Tag")).toBe("fb-salisbury");
  });

  // SUSPECT, pinned not fixed, and the reason the week-long TTL on a wrong
  // image matters. cacheTag runs on the way OUT; the cache write happens
  // INSIDE the handler, before it. So the copy sitting in the Workers cache
  // has no Cache-Tag on it at all, and a tag purge cannot evict it -- only
  // the edge copy, which was tagged, goes. The Worker then re-serves the same
  // stale bytes from its own cache and re-tags them on the way out, so the
  // purge appears to have worked and has not.
  it("SUSPECT: the CACHED copy carries no Cache-Tag, so a purge cannot evict it", async () => {
    await get(FB_PATH);
    await drain();

    expect(cachePuts[0]!.headers["cache-tag"]).toBeUndefined();
    expect(Object.keys(cachePuts[0]!.headers).sort()).toEqual(["cache-control", "content-type"]);
  });

  // A 404 gets no tag (cacheTag returns early on a non-ok response), which is
  // correct here -- there are no bytes to purge -- but is worth pinning next
  // to the above so the two are not confused for one rule.
  it("puts no tag on the 404 for an unknown food bank", async () => {
    const { res } = await get("/needs/at/no-such-foodbank/favicon.png");

    expect(res.headers.get("Cache-Tag")).toBeNull();
  });
});
