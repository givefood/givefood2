import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import app from "../../index";
import type { AppEnv } from "../../types";
import { publicCountry, publicCountryGeojson } from "./country";

// routes/public/country.ts -- publicCountry (/<country>/) and
// publicCountryGeojson (/<country>/geo.json). Django's `country()` at
// givefood/views.py:213-281 and `country_geojson()` at 285-427, both read in
// full alongside this file.
//
// WHY THIS FILE EXISTS. Four near-identical pages that differ ONLY by a
// WHERE clause on a denormalised `country` column. Every way of getting that
// wrong renders a perfect-looking page with a 200:
//
//   * a lost country filter shows Scottish food banks on /wales/ -- the page
//     still has a Welsh flag, Welsh headings and ten plausible names on it;
//   * the two panels link food banks by DIFFERENT rules, as they do on the
//     homepage (recently_updated by slugify(name) per
//     FoodbankChange.foodbank_name_slug(), most_viewed by the real
//     foodbank.slug), and swapping either produces a URL that 404s;
//   * this view's dedup loop is the ONLY place on the site that dedupes the
//     recently-updated panel (index() deliberately does not), and it is
//     driven by two constants -- fetch 50, keep 10 -- that appear nowhere in
//     the SQL and nowhere in the page until a food bank is busy enough to
//     overflow them;
//   * COUNTRY_MAP_CONFIG is keyed by DISPLAY NAME while the route param is a
//     SLUG, so a lookup done with the wrong one of the two yields undefined
//     and the map silently centres on the Atlantic (or throws);
//   * geo.json is filtered by each ROW's own country column, not its food
//     bank's -- an English food bank's Welsh outreach centre belongs on
//     /wales/geo.json, and "filter by the parent instead" is both an easy
//     mistake and invisible unless a fixture actually has such a row.
//
// So the assertions below read VALUES out of the rendered page and out of
// the serialised geo.json body -- names, hrefs, the map config string, whole
// FeatureCollections -- never just a status code.
//
// REAL EVERYTHING, the same harness as routes/public.test.ts and
// routes/public/sitemaps.test.ts: the real production app
// (workers/site/src/index.ts's default export), so the route regex, the four
// locale registrations, resolveLanguage, cacheTag and pageCacheControl are
// the genuine articles; the real Nunjucks templates and .po catalogues; and
// real in-memory SQLite built by schemaFor() from the real migrations --
// which matters here because the geo.json legs read through the
// foodbanklocation_full / foodbankdonationpoint_full VIEWS, whose LEFT JOIN
// is where each feature's "foodbank" property comes from. Mocked: only the
// two KV namespaces, which are Maps, because there is no local double.

const ORIGIN = "https://www.givefood.org.uk";

// Tuesday 8 September 2026, mid-morning UTC. "Most viewed this week" is
// computed from `new Date()` inside the handler, so without a frozen clock
// every hit-window assertion below would be untestable. Date only --
// elapsedMs() uses performance.now() and must stay real for the "Took Nms"
// test.
const NOW = new Date("2026-09-08T09:30:00.000Z");

type Bindable = null | number | bigint | string | Uint8Array;

// One statement as it reached the engine: the SQL text AND the values bound
// to it. The bindings are the load-bearing half -- RECENTLY_UPDATED_FETCH_LIMIT
// (50), MOST_VIEWED_LIMIT (10) and MOST_VIEWED_DAYS (7) are module constants
// that never appear in the SQL text and are invisible in the rendered page
// until a fixture happens to overflow one of them.
interface Prepared {
  sql: string;
  params: Bindable[];
}

// The slice of the D1 Sessions API packages/db uses, over node:sqlite -- the
// same shim routes/public.test.ts uses.
function d1Session(db: DatabaseSync, prepared: Prepared[]): D1DatabaseSession {
  return {
    prepare: (sql: string) => {
      const entry: Prepared = { sql, params: [] };
      prepared.push(entry);
      const statement = (params: Bindable[]): unknown => ({
        bind: (...next: unknown[]) => {
          entry.params = next as Bindable[];
          return statement(next as Bindable[]);
        },
        first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
        all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
        run: async () => {
          db.prepare(sql).run(...params);
          return { success: true, meta: {} };
        },
      });
      return statement([]);
    },
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let prepared: Prepared[];
let sessions: number;
let kv: Map<string, string>;

function env(): AppEnv["Bindings"] {
  return {
    DB: {
      withSession: () => {
        sessions += 1;
        return d1Session(db, prepared);
      },
    },
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => void kv.set(key, value),
      delete: async (key: string) => void kv.delete(key),
    },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

// ---------------------------------------------------------------------------
// Seeds. Only the columns these five queries read are parameterised; every
// other NOT NULL column is filled with whatever the real migration insists
// on, so a seeded row is one production would have accepted.
// ---------------------------------------------------------------------------

interface FoodbankSeed {
  id: number;
  slug: string;
  name: string;
  country: string;
  isClosed?: 0 | 1;
  address?: string;
  postcode?: string;
  latLng?: string;
  deliveryAddress?: string | null;
  deliveryLatLng?: string | null;
  altName?: string | null;
}

// `name` is stored BARE ("Salisbury"), which is how the production column
// really reads -- Foodbank.full_name() is what appends " Foodbank", and
// givefood/const/general.py's DONT_APPEND_FOOD_BANK exists precisely because
// a handful of names already carry their own. The distinction is load-bearing
// in this file: the two page panels print the raw `name`, while every
// geo.json feature prints full_name().
function seedFoodbank(s: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, alt_name, slug, address, postcode, country, lat_lng,
       delivery_address, delivery_lat_lng, network, charity_just_foodbank, contact_email, url,
       shopping_list_url, address_is_administrative, is_closed, no_locations, days_between_needs,
       created, modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Trussell Trust', 0, ?, ?, ?, 0, ?, 0, 14,
       '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run(
    s.id,
    String(s.id).padStart(32, "a"),
    s.name,
    s.altName ?? null,
    s.slug,
    s.address ?? `${s.id} High Street`,
    s.postcode ?? "SP1 1AA",
    s.country,
    s.latLng ?? "51.07,-1.79",
    s.deliveryAddress ?? null,
    s.deliveryLatLng ?? null,
    `info@${s.slug}.invalid`,
    `https://${s.slug}.invalid/`,
    `https://${s.slug}.invalid/list/`,
    s.isClosed ?? 0,
  );
}

// `created` is TEXT and is compared lexicographically, so every fixture
// timestamp is written in Django's own spelling -- "2026-09-05 19:28:08.853000",
// a space and six digits of microseconds.
function seedChange(o: { id: number; foodbankId: number | null; created: string; text?: string; published?: 0 | 1 }): void {
  db.prepare(
    `INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, published, input_method, created, modified)
     VALUES (?, ?, ?, ?, ?, 'scrape', ?, ?)`,
  ).run(o.id, `need-${o.id}`, o.foodbankId, o.text ?? "Beans\nPasta", o.published ?? 1, o.created, o.created);
}

function seedHit(foodbankId: number, day: string, hits: number): void {
  db.prepare("INSERT INTO foodbankhit (foodbank_id, day, hits) VALUES (?, ?, ?)").run(foodbankId, day, hits);
}

// `country` on the LOCATION row, not on its food bank: that column is what
// country_geojson filters on (givefood/views.py:307), and location 13 below
// is the row that makes the difference visible.
function seedLocation(o: {
  id: number;
  foodbankId: number;
  name: string;
  slug: string;
  country: string;
  address?: string | null;
  postcode?: string | null;
  latLng: string;
  isClosed?: 0 | 1;
  boundary?: string | null;
}): void {
  db.prepare(
    `INSERT INTO foodbanklocation (id, uuid, foodbank_id, name, slug, address, postcode, country,
       lat_lng, is_closed, boundary_geojson, modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2020-01-01 00:00:00.000000')`,
  ).run(
    o.id,
    String(o.id).padStart(32, "e"),
    o.foodbankId,
    o.name,
    o.slug,
    o.address ?? null,
    o.postcode ?? null,
    o.country,
    o.latLng,
    o.isClosed ?? 0,
    o.boundary ?? null,
  );
}

function seedDonationPoint(o: {
  id: number;
  foodbankId: number;
  name: string;
  slug: string;
  country: string;
  address: string;
  postcode: string;
  latLng: string;
  isClosed?: 0 | 1;
}): void {
  db.prepare(
    `INSERT INTO foodbankdonationpoint (id, uuid, foodbank_id, name, slug, address, postcode, country,
       lat_lng, is_closed, in_store_only, modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '2020-01-01 00:00:00.000000')`,
  ).run(o.id, String(o.id).padStart(32, "d"), o.foodbankId, o.name, o.slug, o.address, o.postcode, o.country, o.latLng, o.isClosed ?? 0);
}

// THE FIXTURE IS THE TEST, so each row turns exactly one rule on or off
// relative to its neighbour.
//
// Food banks -- four in England, one in each of the other three countries so
// "the filter does nothing" cannot pass, plus a CLOSED English one:
//   1 salisbury    "Salisbury"           England
//   2 vineyard     "St. Mary's & Pantry" England  slug != slugify(name)
//   3 bath         "Bath"                England
//   4 truro        "Truro"               England
//   5 cardiff      "Cardiff"             Wales    has a delivery address
//   6 belfast      "Belfast"             Northern Ireland
//   7 glasgow      "Glasgow"             Scotland
//   8 closed-town  "Closed Town"         England  is_closed = 1
//
// Changes -- three eligible English ones plus a SECOND change for Salisbury
// (the dedup case), then one instance of every exclusion, each stamped NEWER
// than all of them so a lost filter shows up at the TOP of the panel rather
// than somewhere in the middle where it might be missed.
//
// Hits -- today is 2026-09-08, so the window is 2026-09-01..2026-09-08:
//   bath      100 today + 50 yesterday = 150  (summing across days)
//   salisbury 120 on 2026-09-01, exactly seven days back -- INCLUDED
//   truro     10 today + 999 TOMORROW         (the future row must not count;
//                                              if it did, truro would rank first)
//   vineyard  999 on 2026-08-31, eight days back -- EXCLUDED entirely
//   cardiff   5000 today -- a Welsh food bank that would top the English
//                           ranking if the country filter were lost
function seed(): void {
  seedFoodbank({ id: 1, slug: "salisbury", name: "Salisbury", country: "England", latLng: "51.0688,-1.7945" });
  seedFoodbank({ id: 2, slug: "vineyard", name: "St. Mary's & Pantry", country: "England" });
  seedFoodbank({ id: 3, slug: "bath", name: "Bath", country: "England" });
  seedFoodbank({ id: 4, slug: "truro", name: "Truro", country: "England" });
  seedFoodbank({
    id: 5,
    slug: "cardiff",
    name: "Cardiff",
    country: "Wales",
    address: "1 Bute Street",
    postcode: "CF10 1NS",
    latLng: "51.4816,-3.1791",
    deliveryAddress: "Depot Road, Cardiff",
    deliveryLatLng: "51.5,-3.2",
  });
  seedFoodbank({ id: 6, slug: "belfast", name: "Belfast", country: "Northern Ireland" });
  seedFoodbank({ id: 7, slug: "glasgow", name: "Glasgow", country: "Scotland" });
  seedFoodbank({ id: 8, slug: "closed-town", name: "Closed Town", country: "England", isClosed: 1 });

  seedChange({ id: 1, foodbankId: 2, created: "2026-09-07 08:00:00.000000" });
  seedChange({ id: 2, foodbankId: 1, created: "2026-09-06 23:59:59.999999" });
  seedChange({ id: 3, foodbankId: 1, created: "2026-09-06 12:00:00.000000" });
  seedChange({ id: 4, foodbankId: 3, created: "2026-09-05 19:28:08.853000" });
  seedChange({ id: 5, foodbankId: 4, created: "2026-09-08 09:00:00.000000", published: 0 });
  seedChange({ id: 6, foodbankId: 4, created: "2026-09-08 08:00:00.000000", text: "Unknown" });
  seedChange({ id: 7, foodbankId: 4, created: "2026-09-08 07:00:00.000000", text: "Facebook" });
  seedChange({ id: 8, foodbankId: 4, created: "2026-09-08 06:00:00.000000", text: "Nothing" });
  seedChange({ id: 9, foodbankId: 5, created: "2026-09-08 05:00:00.000000" });
  seedChange({ id: 10, foodbankId: null, created: "2026-09-08 04:00:00.000000" });
  seedChange({ id: 11, foodbankId: 999, created: "2026-09-08 03:00:00.000000" });

  seedHit(3, "2026-09-08", 100);
  seedHit(3, "2026-09-07", 50);
  seedHit(1, "2026-09-01", 120);
  seedHit(4, "2026-09-08", 10);
  seedHit(4, "2026-09-09", 999);
  seedHit(2, "2026-08-31", 999);
  seedHit(5, "2026-09-08", 5000);

  // Locations. 13 is the interesting one: it belongs to food bank 1, which is
  // in ENGLAND, but the centre itself is in WALES.
  seedLocation({ id: 11, foodbankId: 1, name: "Amesbury Centre", slug: "amesbury", country: "England", address: "2 Low Street", postcode: "SP2 2BB", latLng: "51.1662,-1.7827" });
  seedLocation({ id: 12, foodbankId: 1, name: "Wilton Centre", slug: "wilton", country: "England", address: "3 Mid Street", postcode: "SP3 3CC", latLng: "51.08,-1.86", isClosed: 1 });
  seedLocation({ id: 13, foodbankId: 1, name: "Wrexham Centre", slug: "wrexham-centre", country: "Wales", address: "4 Border Road", postcode: "LL11 1AA", latLng: "53,-3" });

  seedDonationPoint({ id: 21, foodbankId: 3, name: "Tesco Extra", slug: "tesco-extra", country: "England", address: "5 Retail Park", postcode: "BA1 1AA", latLng: "51.3811,-2.3590" });
  seedDonationPoint({ id: 22, foodbankId: 3, name: "Boarded Up", slug: "boarded-up", country: "England", address: "6 Empty Row", postcode: "BA2 2BB", latLng: "51.38,-2.36", isClosed: 1 });
  seedDonationPoint({ id: 23, foodbankId: 5, name: "Cardiff Co-op", slug: "cardiff-co-op", country: "Wales", address: "9 Queen Street", postcode: "CF10 2BB", latLng: "51.48,-3.17" });
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  // schemaFor rather than hand-written DDL: the two geo.json legs read the
  // _full VIEWS, and a hand-built fixture that lacked them would fail
  // somewhere else entirely with "no such table".
  db.exec(
    schemaFor(
      "foodbank",
      "foodbankchange",
      "foodbankhit",
      "foodbanklocation",
      "foodbanklocation_full",
      "foodbankdonationpoint",
      "foodbankdonationpoint_full",
    ),
  );
  seed();
  prepared = [];
  sessions = 0;
  kv = new Map();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// `async`, not a bare arrow: app.fetch is typed Response | Promise<Response>.
const get = async (path: string, init?: RequestInit): Promise<Response> => app.fetch(new Request(`${ORIGIN}${path}`, init), env(), execCtx);
const getBody = async (path: string): Promise<string> => (await get(path)).text();

// ---------------------------------------------------------------------------
// Reading the rendered page. Each panel is a <ul> with a stable class and
// every row in it is one <a>, so the assertions can talk in hrefs and names
// rather than in HTML.
// ---------------------------------------------------------------------------

function ul(body: string, cls: string): string {
  const start = body.indexOf(`<ul class="${cls}">`);
  if (start === -1) throw new Error(`no <ul class="${cls}"> in the rendered page`);
  const end = body.indexOf("</ul>", start);
  return body.slice(start, end);
}

function anchors(html: string): { href: string; text: string }[] {
  return [...html.matchAll(/<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({ href: m[1] as string, text: (m[2] as string).trim() }));
}

const panel = (body: string, cls: string) => anchors(ul(body, cls));

// The `"name": "..."` values a geo.json body carries, in emission order --
// enough to say "these features, in this order, and nothing else" without
// spelling out four full Point literals. The byte-exact shape of one of those
// is pinned by the whole-body test instead.
function featureNames(body: string): string[] {
  return [...body.matchAll(/"name": "([^"]*)"/g)].map((m) => m[1] as string);
}

describe("publicCountry -- the response envelope", () => {
  // Django's country() carried @cache_page(SECONDS_IN_HOUR), and
  // middleware/pageCacheControl.ts has a COUNTRY rule that reproduces the
  // shared half of it. An hour rather than a day is the point: this page has
  // "recently updated" and "most viewed" panels on it.
  it("serves cacheable HTML for an hour at the edge, five minutes in the browser", async () => {
    const res = await get("/england/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=3600");
    expect(res.headers.get("Content-Language")).toBe("en");
  });

  // NO CACHE-TAG, AND NO PRELOAD LINK, PINNED AS THE CURRENT BEHAVIOUR.
  //
  // Cache-Tag: middleware/cacheTag.ts tags a response from its PATH, and its
  // AGGREGATE_PATHS list covers "/", the sitemaps and the site-wide feeds but
  // not "/<country>/". So these four pages carry both panels' data and nothing
  // purges them -- a renamed or newly updated food bank keeps its old entry
  // here for up to the hour above. Suspect rather than wrong (the tag set is
  // cacheTag.ts's decision, not this module's) and recorded here because this
  // is the page where the staleness would actually be seen.
  //
  // Link: middleware/geoJsonPreload.ts recognises five wfbn route templates
  // and is inert everywhere else. The country page draws a map from a geo.json
  // feed and still gets no preload hint -- which is what Django does too,
  // because givefood/middleware.py:95-135's GeoJSONPreload lists 'index', the
  // four foodbank url_names and 'constituency', and never 'country'. Pinned so
  // the absence reads as ported rather than forgotten.
  //
  // Server-Timing is asserted alongside them as the control: both of those
  // middlewares run on the way OUT, and serverTiming is the outermost of the
  // three, so its header proves the whole unwind ran and the two nulls above
  // are decisions rather than a middleware chain that never executed. The
  // positive cases for each live in middleware/cacheTag.test.ts and
  // middleware/geoJsonPreload.test.ts.
  it("carries neither a cache tag nor a geojson preload hint (suspect, pinned)", async () => {
    const res = await get("/england/");

    expect(res.headers.get("Cache-Tag")).toBeNull();
    expect(res.headers.get("Link")).toBeNull();
    expect(res.headers.get("Server-Timing")).toMatch(/^render;dur=/);
  });

  // THE THREE CONSTANTS, WHICH ARE OTHERWISE INVISIBLE.
  // RECENTLY_UPDATED_FETCH_LIMIT (50), MOST_VIEWED_LIMIT (10) and
  // MOST_VIEWED_DAYS (7) never appear in the SQL text and never show on a page
  // whose fixture is smaller than the limit, so they are asserted on the
  // bindings that actually reached the engine -- alongside the display name
  // "England", which is the value stored in the column and NOT the route's
  // "england" slug.
  //
  // ONE SESSION FOR BOTH READS. lib/session.ts opens a single
  // withSession("first-unconstrained") per request precisely so the two
  // parallel queries see one consistent snapshot of a replicated database; a
  // handler that opened one per query would still render and would still pass
  // every other test in this file.
  it("reads both panels from one D1 session, with the display name and the limits the constants declare", async () => {
    await get("/england/");

    expect(sessions).toBe(1);
    expect(prepared.map((p) => p.params)).toEqual([
      ["England", 50],
      ["2026-09-01", "2026-09-08", "England", 10],
    ]);
    expect(prepared.map((p) => p.sql)).toEqual([
      "SELECT f.name AS foodbank_name FROM foodbankchange fc JOIN foodbank f ON f.id = fc.foodbank_id WHERE fc.published = 1 AND fc.change_text NOT IN ('Unknown', 'Facebook', 'Nothing') AND f.name IS NOT NULL AND f.country = ? ORDER BY fc.created DESC LIMIT ?",
      "SELECT f.name, f.slug FROM (SELECT h.foodbank_id AS foodbank_id, SUM(h.hits) AS total_hits FROM foodbankhit h JOIN foodbank fb ON fb.id = h.foodbank_id WHERE h.day >= ? AND h.day <= ? AND fb.country = ? GROUP BY h.foodbank_id ORDER BY total_hits DESC LIMIT ?) t JOIN foodbank f ON f.id = t.foodbank_id ORDER BY t.total_hits DESC",
    ]);
  });

  // The window is date arithmetic (setUTCDate(x - 7)), not string arithmetic,
  // and the difference only shows at a month boundary -- across the end of
  // February in a leap year most of all. A handler that sliced the ISO string
  // and subtracted 7 from the day field produces "2024-03--4" here and matches
  // no row at all, which on a live country page is an empty "most viewed"
  // panel and nothing else.
  it("walks the seven-day window back across a month boundary", async () => {
    vi.setSystemTime(new Date("2024-03-02T00:05:00.000Z"));

    await get("/england/");

    expect(prepared[1]?.params).toEqual(["2024-02-24", "2024-03-02", "England", 10]);
  });

  // GET only, matching Django's country(). Worth asserting rather than
  // assuming: the route is registered with app.get, and a stray app.all would
  // hand a POST to a handler that renders a page pageCacheControl then stamps
  // public for an hour.
  it("does not answer a POST", async () => {
    expect((await get("/england/", { method: "POST" })).status).toBe(404);
  });
});

describe("publicCountry -- which country is which", () => {
  // COUNTRY_MAPPING's four slug -> display-name pairs, end to end. The
  // display name is what the `country` column actually stores, so querying
  // with the slug instead returns zero rows for all four -- and
  // "northern-ireland" is the pair where the difference is impossible to
  // miss. The heading text also proves the name reached the template rather
  // than only the query.
  it("maps each of the four slugs to the display name the page shows and the query binds", async () => {
    for (const [slug, name] of [
      ["scotland", "Scotland"],
      ["england", "England"],
      ["wales", "Wales"],
      ["northern-ireland", "Northern Ireland"],
    ]) {
      prepared = [];
      const body = await getBody(`/${slug}/`);

      expect(body).toContain(`<title>Give Food ${name}</title>`);
      expect(prepared[0]?.params?.[0]).toBe(name);
      expect(prepared[1]?.params?.[2]).toBe(name);
    }
  });

  // country.njk's `{% if country_name != 'Northern Ireland' %}` -- there is
  // no static/img/flags/northern-ireland.svg, so the three that DO have a
  // flag must get one and the fourth must not get a broken image. The
  // comparison is against the display NAME, and the file is named after the
  // SLUG, which is the one place both spellings appear in the same line.
  it("shows a flag for three countries and none for Northern Ireland", async () => {
    for (const slug of ["scotland", "england", "wales"]) {
      expect(await getBody(`/${slug}/`)).toContain(`<img src="/static/img/flags/${slug}.svg" alt="`);
    }

    const ni = await getBody("/northern-ireland/");
    expect(ni).not.toContain("/static/img/flags/");
    expect(ni).toContain("Northern Ireland");
  });

  // The whole point of the page. Each country's panels contain only its own
  // food banks -- asserted with the positive list AND the names that must be
  // absent, because a filter that does nothing passes any test that only
  // checks the rows it seeded.
  it("keeps each country's food banks to its own page", async () => {
    const england = panel(await getBody("/england/"), "recently-updated").map((a) => a.text);
    expect(england).toEqual(["St. Mary&#39;s &amp; Pantry", "Salisbury", "Bath"]);
    expect(england).not.toContain("Cardiff");

    const wales = await getBody("/wales/");
    expect(panel(wales, "recently-updated").map((a) => a.text)).toEqual(["Cardiff"]);
    expect(panel(wales, "most-viewed").map((a) => a.text)).toEqual(["Cardiff"]);
    expect(panel(wales, "most-viewed").map((a) => a.text)).not.toContain("Bath");

    // Scotland and Northern Ireland have a food bank each but no changes and
    // no hits, so both panels come up empty rather than falling back to
    // everything.
    const scotland = await getBody("/scotland/");
    expect(panel(scotland, "recently-updated")).toEqual([]);
    expect(panel(scotland, "most-viewed")).toEqual([]);
  });

  // The route param's alternation is case-sensitive and hyphen-exact, so a
  // slug that merely resembles one of the four gets nowhere. "/england"
  // without the trailing slash is the interesting one: lib/appendSlash.ts
  // redirects it, matching Django's APPEND_SLASH, rather than 404ing.
  it("404s an unrelated slug, and redirects the slashless spelling", async () => {
    for (const path of ["/france/", "/England/", "/SCOTLAND/", "/northern_ireland/"]) {
      expect((await get(path)).status).toBe(404);
    }

    const redirect = await get("/england");
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("Location")).toBe(`${ORIGIN}/england/`);
  });

  // SUSPECTED BUG, PINNED RATHER THAN FIXED, AND IT IS NOT IN THIS FILE.
  //
  // country.ts opens with "Routing itself constrains `:countrySlug` to these 4
  // values (index.ts's `{scotland|england|wales|northern-ireland}` route
  // param)". That is not true of this app. Django's
  // `re_path(r"^(?P<country_slug>(scotland|england|wales|northern-ireland))/$")`
  // is anchored at both ends and 404s every path below; here they all render a
  // real, cacheable country page at a made-up URL, with a canonical link and
  // four hreflang alternates pointing at that URL.
  //
  // THE MECHANISM, established in this session rather than assumed. Hono's
  // default SmartRouter tries RegExpRouter first and falls back to TrieRouter
  // for the whole app if any route is unsupported. index.ts:469-471 registers
  // TWO differently-named regex params at the same position -- :countrySlug
  // and :year -- and adding the second throws UnsupportedPathError in
  // RegExpRouter (reproduced directly against hono 4.13.7's RegExpRouter, and
  // app.router.name below reports the fallback). RegExpRouter anchors a param
  // pattern to its segment; TrieRouter does not, so it accepts any segment
  // CONTAINING a match and hands the handler the matched SUBSTRING -- which is
  // why /xengland/ renders England rather than 404ing or passing "xengland"
  // through to the module's own guard. Registering the same route on a bare
  // RegExpRouter 404s all of these; on a bare TrieRouter all of them match.
  //
  // Not fixed here (the fix is index.ts's or the router choice's, and this
  // file may not touch source). The cost is unbounded duplicate content on
  // four of the site's landing pages, each stamped public for an hour.
  it("SUSPECTED BUG: serves a whole country page at any url merely CONTAINING a country name", async () => {
    for (const [path, title] of [
      ["/englandshire/", "England"],
      ["/xengland/", "England"],
      ["/wales-x/", "Wales"],
      ["/x-wales/", "Wales"],
      ["/cy/englandshire/", "England"],
    ]) {
      const body = await getBody(path as string);
      expect(body).toContain(`<title>Give Food ${title}</title>`);
      expect(body).toContain(`<link rel="canonical" href="${ORIGIN}${path}">`);
    }

    // The geo.json twin goes the same way, and it is the one that can be
    // fetched in bulk.
    const geojson = await get("/englandshire/geo.json");
    expect(geojson.status).toBe(200);
    expect(featureNames(await geojson.text())).toContain("Salisbury Foodbank");

    // The router this app actually ended up with, named in the response to a
    // request rather than at import time -- SmartRouter only resolves which
    // inner router it is using on the first match.
    expect(app.router.name).toBe("SmartRouter + TrieRouter");
  });
});

describe("publicCountry -- the recently updated panel", () => {
  // Order, content and DEDUPLICATION in one assertion. Salisbury has two
  // changes in the fixture (2026-09-06 23:59:59 and 12:00) and appears once,
  // at the position of its NEWER one -- the loop keeps the first row it sees
  // in `-created` order and skips the rest. This is the behaviour that differs
  // from the homepage: index() has no dedup loop at all and repeats a food
  // bank that changed twice, which routes/public.test.ts pins the other way
  // round. Dropping the loop here would fill this panel with one busy food
  // bank's morning.
  //
  // (The dedup KEY is the name rather than the id, following
  // givefood/views.py:233-241's `change.foodbank_name` set. That is not
  // separately testable: `foodbank.name` is UNIQUE in the real schema, so
  // name-keyed and id-keyed dedup cannot be told apart by any fixture the
  // migrations would accept.)
  it("lists each food bank once, at its newest change", async () => {
    expect(panel(await getBody("/england/"), "recently-updated").map((a) => a.text)).toEqual([
      "St. Mary&#39;s &amp; Pantry",
      "Salisbury",
      "Bath",
    ]);
  });

  // THE FOUR EXCLUSIONS, each seeded newer than every eligible row so any one
  // of them failing puts "Truro" at the TOP of the panel:
  //   published = 0                              a draft; showing it publishes
  //                                              a food bank's need list early
  //   change_text 'Unknown'/'Facebook'/'Nothing' sentinels, not needs
  //   foodbank_id NULL / dangling                the query INNER JOINs
  //                                              foodbank, so both vanish --
  //                                              unlike the homepage's
  //                                              foodbankchange_full LEFT JOIN,
  //                                              which lets them through as a
  //                                              NULL name
  it("shows neither unpublished changes, sentinel change_texts, nor changes whose food bank has gone", async () => {
    const rows = panel(await getBody("/england/"), "recently-updated");

    expect(rows).toHaveLength(3);
    expect(rows.map((a) => a.text)).not.toContain("Truro");
    expect(rows.map((a) => a.href)).not.toContain("/needs/at//");
  });

  // THE TARGET. Ten uniques and then stop -- givefood/views.py:239-241's
  // `if len(recently_updated) >= 10: break`. Twelve eligible English food
  // banks are seeded here; the two oldest fall off.
  it("stops at ten unique food banks, dropping the oldest", async () => {
    for (let i = 0; i < 9; i += 1) {
      seedFoodbank({ id: 50 + i, slug: `extra-${i}`, name: `Extra ${i}`, country: "England" });
      seedChange({ id: 50 + i, foodbankId: 50 + i, created: `2026-09-0${i + 1} 01:00:00.000000` });
    }

    const rows = panel(await getBody("/england/"), "recently-updated");

    expect(rows).toHaveLength(10);
    // Extra 0 (2026-09-01) and Extra 1 (2026-09-02) are the two oldest of the
    // twelve; Bath, at 2026-09-05 19:28, is the last one that fits.
    expect(rows.map((a) => a.text)).not.toContain("Extra 0");
    expect(rows.map((a) => a.text)).not.toContain("Extra 1");
    expect(rows.map((a) => a.text)).toContain("Extra 2");
    expect(rows.map((a) => a.text)).toContain("Bath");
  });

  // THE FETCH LIMIT, WHICH IS THE OTHER HALF OF THE DEDUP AND HAS TEETH.
  // The query asks for 50 rows and the loop dedupes what it gets, so a food
  // bank that changed 50 times today consumes the ENTIRE fetch and the panel
  // comes back with one entry -- not ten. Django has exactly the same
  // behaviour (the comment on views.py:230 says "Fetch more to ensure we have
  // 10 unique", which is a hope rather than a guarantee), so this is parity
  // and not a port defect; pinned because "the country page's panel has one
  // name on it" is otherwise a baffling bug report, and because raising or
  // lowering the 50 changes what the page shows with no other symptom.
  it("can return fewer than ten when one food bank fills the whole 50-row fetch", async () => {
    db.prepare("DELETE FROM foodbankchange").run();
    for (let i = 0; i < 55; i += 1) {
      seedChange({ id: 100 + i, foodbankId: 1, created: `2026-09-08 0${Math.floor(i / 10)}:${String(i % 10).padStart(2, "0")}:00.000000` });
    }
    // Older than all 55, so it is row 56 and never fetched.
    seedChange({ id: 200, foodbankId: 3, created: "2026-09-01 00:00:00.000000" });

    const rows = panel(await getBody("/england/"), "recently-updated");

    expect(rows.map((a) => a.text)).toEqual(["Salisbury"]);
    expect(rows.map((a) => a.text)).not.toContain("Bath");
  });

  // THE LINKING RULE, AND IT IS NOT THE OBVIOUS ONE. Django's template calls
  // FoodbankChange.foodbank_name_slug() -- slugify() of the name -- and never
  // reaches the real slug. This port reproduces that: food bank id 2 is
  // stored with slug "vineyard" and the panel still links
  // /needs/at/st-mary-s-pantry/. Joining to foodbank.slug here would be an
  // improvement and a divergence.
  it("links by slugify(name), never by the food bank's real slug", async () => {
    const rows = panel(await getBody("/england/"), "recently-updated");

    expect(rows.map((a) => a.href)).toEqual(["/needs/at/st-mary-s-pantry/", "/needs/at/salisbury/", "/needs/at/bath/"]);
    // "vineyard" is the real slug of the food bank at the top of the panel,
    // and it is the one URL this panel must never emit.
    expect(rows.map((a) => a.href)).not.toContain("/needs/at/vineyard/");
  });

  // SUSPECT, PINNED AS-IS. @givefood/models' slugify() replaces every run of
  // non-[a-z0-9] with a hyphen, where django.utils.text.slugify() first
  // DELETES apostrophes and full stops and only then hyphenates whitespace.
  // So the href above is "/needs/at/st-mary-s-pantry/" where Django emitted
  // "/needs/at/st-marys-pantry/", and for any food bank whose name carries
  // punctuation the country page's link 404s. Identical to the defect
  // routes/public.test.ts records on the homepage -- same helper, same
  // consequence -- and asserting Django's answer instead would leave the
  // suite red and fix nothing. Not verified against a Django checkout in this
  // session; the divergence is read off @givefood/models' own source.
  it("hyphenates punctuation where Django would have deleted it (suspect, pinned)", async () => {
    expect(panel(await getBody("/england/"), "recently-updated")[0]?.href).toBe("/needs/at/st-mary-s-pantry/");
  });

  // NO is_closed FILTER, on either panel. Django's country() filters
  // FoodbankChange on published and country only, and Foodbank on hits and
  // country only -- neither excludes a closed food bank, and neither does
  // this port. So a closed food bank that was updated recently still appears
  // here and links to a page that says it has closed, while being absent from
  // the map beside it (geo.json DOES filter is_closed). Parity, pinned:
  // "adding the obvious filter" would be a divergence.
  it("still lists a CLOSED food bank in both panels, though the map beside it drops one", async () => {
    seedChange({ id: 60, foodbankId: 8, created: "2026-09-08 02:00:00.000000" });
    seedHit(8, "2026-09-08", 9999);

    const body = await getBody("/england/");
    expect(panel(body, "recently-updated")[0]?.text).toBe("Closed Town");
    expect(panel(body, "most-viewed")[0]?.text).toBe("Closed Town");

    expect(featureNames(await getBody("/england/geo.json"))).not.toContain("Closed Town Foodbank");
  });

  // `created` is TEXT compared lexicographically and 'T' (0x54) sorts after
  // ' ' (0x20), so a row written by anything that stamps toISOString() sorts
  // ABOVE every Django-format row of the same date regardless of the time in
  // it -- 10:00Z here beats 23:59 on the same day. Not a defect in this
  // handler, which only asks for ORDER BY created DESC; pinned because the
  // dedup loop makes the consequence worse than on the homepage, where the
  // row would merely be misplaced: here the mis-sorted row decides WHICH of a
  // food bank's changes is the one kept.
  it("orders by the raw text of `created`, so an ISO-8601 timestamp outranks a same-day Django one", async () => {
    seedChange({ id: 70, foodbankId: 4, created: "2026-09-07T01:00:00.000Z" });

    expect(panel(await getBody("/england/"), "recently-updated")[0]?.text).toBe("Truro");
  });
});

describe("publicCountry -- the most viewed panel", () => {
  // Ranking, summing and BOTH window edges in one assertion:
  //   bath 150 (100 today + 50 yesterday) > salisbury 120 (exactly seven days
  //   back, the inclusive edge) > truro 10 (whose 999 hits TOMORROW must not
  //   count, or it would rank first). Vineyard's 999 hits eight days back are
  //   outside the window entirely, and Cardiff's 5,000 today are outside the
  //   country.
  it("ranks by hits summed over the trailing seven days, within the country", async () => {
    const rows = panel(await getBody("/england/"), "most-viewed");

    expect(rows.map((a) => a.text)).toEqual(["Bath", "Salisbury", "Truro"]);
    expect(rows.map((a) => a.text)).not.toContain("St. Mary&#39;s &amp; Pantry");
    expect(rows.map((a) => a.text)).not.toContain("Cardiff");
  });

  // The other half of the linking rule: this panel DOES join foodbank, so it
  // links the real slug. Food bank id 2 is absent from the base fixture's
  // panel (its hits are outside the window), so it gets a hit inside it here
  // -- the point being "vineyard", not "st-mary-s-pantry".
  it("links the real foodbank.slug, not a slugify of the name", async () => {
    seedHit(2, "2026-09-08", 5);

    expect(panel(await getBody("/england/"), "most-viewed").at(-1)).toEqual({
      href: "/needs/at/vineyard/",
      text: "St. Mary&#39;s &amp; Pantry",
    });
  });

  // MOST_VIEWED_LIMIT is 10, applied inside the subquery. Eleven ranked
  // English food banks here; the least viewed falls off.
  it("stops at ten, dropping the least viewed", async () => {
    for (let i = 0; i < 8; i += 1) {
      seedFoodbank({ id: 80 + i, slug: `viewed-${i}`, name: `Viewed ${i}`, country: "England" });
      seedHit(80 + i, "2026-09-08", 200 + i);
    }

    const rows = panel(await getBody("/england/"), "most-viewed");

    expect(rows).toHaveLength(10);
    // Truro's 10 hits are the smallest of the eleven totals; Salisbury's 120
    // is the smallest that still fits.
    expect(rows.map((a) => a.text)).not.toContain("Truro");
    expect(rows.map((a) => a.text)).toContain("Salisbury");
  });

  // Unlike getMostViewed (the homepage's, issue #43), this query keeps its
  // foodbank join INSIDE the LIMIT -- `country` lives on foodbank, so it has
  // to. The consequence is that an orphaned foodbankhit row, which on the
  // homepage silently consumes one of the eight slots, cannot reach the
  // ranking here at all: the panel stays full. packages/db/src/homepage.ts
  // spells out both halves; this is the visible one.
  it("never lets an orphaned hit row consume a slot", async () => {
    seedHit(999, "2026-09-08", 100_000);

    const rows = panel(await getBody("/england/"), "most-viewed");

    expect(rows.map((a) => a.text)).toEqual(["Bath", "Salisbury", "Truro"]);
    expect(rows.map((a) => a.href)).not.toContain("/needs/at//");
  });
});

describe("publicCountry -- the map, the search box and the rest of the page", () => {
  // map_config is JSON.stringify'd in the handler and dropped into a <script>
  // by includes/mapconfig.njk, so the exact string is what the map JS parses.
  // COUNTRY_MAP_CONFIG is keyed by DISPLAY NAME while the geojson url is built
  // from the SLUG, and both spellings appear in this one line -- which is
  // exactly why all four are asserted rather than one. Verbatim from
  // givefood/views.py:44-65; note lng -4 and zoom 6/7 as INTEGERS, which
  // JSON.stringify prints without a decimal point just as json.dumps does.
  it("centres the map on each country and points it at that country's geojson", async () => {
    for (const [slug, config] of [
      ["scotland", '{"geojson":"/scotland/geo.json","lat":57.7,"lng":-4,"zoom":6,"location_marker":false}'],
      ["england", '{"geojson":"/england/geo.json","lat":53,"lng":-1.8,"zoom":6,"location_marker":false}'],
      ["wales", '{"geojson":"/wales/geo.json","lat":52.3,"lng":-3.7,"zoom":7,"location_marker":false}'],
      ["northern-ireland", '{"geojson":"/northern-ireland/geo.json","lat":54.6,"lng":-6.5,"zoom":7,"location_marker":false}'],
    ]) {
      expect(await getBody(`/${slug}/`)).toContain(`window.gfMapConfig = ${config};`);
    }
  });

  // location_marker: false is what stops the map dropping a "you are here"
  // pin at the country centroid. It is a boolean the template hands straight
  // to the map JS, so losing it would put a spurious marker in the middle of
  // the Irish Sea on /northern-ireland/ and nowhere else visible.
  it("tells the map not to draw a location marker", async () => {
    expect(await getBody("/england/")).toContain('"location_marker":false');
  });

  // COUNTRY_PLACEHOLDERS holds the LITERAL ENGLISH MSGID, not a translation
  // -- the handler cannot translate it (it has no catalogue) and the template
  // does it with `{{ _(placeholder) }}`, the same dynamic-msgid pattern
  // wfbn/index.njk uses for its category labels. So this is the test that
  // says the round trip works: the right placeholder per country in English,
  // and the .po's msgstr in Welsh.
  it("puts each country's example postcode in the search box, translated at render time", async () => {
    for (const [slug, placeholder] of [
      ["scotland", "e.g. EH12 5PJ or Glasgow"],
      ["england", "e.g. HA9 0WS or Manchester"],
      ["wales", "e.g. CF10 1NS or Cardiff"],
      ["northern-ireland", "e.g. BT12 6LW or Belfast"],
    ]) {
      expect(await getBody(`/${slug}/`)).toContain(`placeholder="${placeholder}"`);
    }

    // packages/templates/locale/cy/django.po:1529-1530.
    expect(await getBody("/cy/england/")).toContain('placeholder="e.e. HA9 0WS neu Fanceinion"');
  });

  // `address` is passed as the empty string, unconditionally. Django's
  // country() takes no input at all -- the search box submits to wfbn:index,
  // which is a different view -- so a handler that "helpfully" echoed
  // ?address= here would both diverge and make the page per-visitor while
  // pageCacheControl is still stamping it public for an hour.
  it("leaves the address box empty even when the url carries an address", async () => {
    const body = await getBody("/england/?address=Sheffield&lat_lng=51,-1");

    expect(body).toContain('value="" required>');
    expect(body).not.toContain("Sheffield");
  });

  // ENABLE_WRITE is a hardcoded constant in givefood/const/general.py, not an
  // env flag, so the "Write to your MP" entry is always present. The template
  // gates on it; if the handler stopped passing it the link would vanish with
  // no other symptom.
  it("offers the Write to your MP link", async () => {
    expect(await getBody("/england/")).toContain('<li><a href="/write/">Write to your MP</a></li>');
  });

  // elapsedMs() reports WHOLE milliseconds, deliberately unlike Django's
  // three decimal places: on Workers performance.now() is coarsened, so the
  // fraction was always ".000" -- decoration that reads like precision. A
  // revert to toFixed(3) shows up here as "Took 0.000ms", and dropping
  // render_time_ms from the context leaves "Took ms"; both fail this pattern.
  // The FORMAT is all that is asserted, not the magnitude: 0 is a legitimate
  // value on the coarsened clock this exists to describe, so a handler that
  // hardcoded 0 would pass -- which is the honest limit of a timing test.
  it("stamps the debug comment with a whole-millisecond render time", async () => {
    expect(/⏱️ Took (\S+)/.exec(await getBody("/england/"))?.[1]).toMatch(/^\d+ms$/);
  });

  // An empty database must still render -- a fresh D1, or an extract that has
  // not run yet. Both panels come up empty, the map still gets its config,
  // and nothing throws.
  it("renders with both panels empty when the country has no data at all", async () => {
    for (const table of ["foodbankchange", "foodbankhit", "foodbank"]) db.prepare(`DELETE FROM ${table}`).run();

    const body = await getBody("/england/");

    expect(panel(body, "recently-updated")).toEqual([]);
    expect(panel(body, "most-viewed")).toEqual([]);
    expect(body).toContain('window.gfMapConfig = {"geojson":"/england/geo.json"');
  });

  // A D1 outage must produce the 500 page, NOT a country page with two empty
  // panels -- and above all must not be cached: pageCacheControl only stamps
  // 200s, so the s-maxage=3600 above cannot attach itself to this. An hour of
  // edge-cached emptiness on a country landing page is the failure this
  // guards.
  it("500s, uncached, when the database is unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      ...env(),
      DB: {
        withSession: () => {
          throw new Error("D1_ERROR: network");
        },
      },
    } as unknown as AppEnv["Bindings"];

    const res = await app.fetch(new Request(`${ORIGIN}/england/`), broken, execCtx);

    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(await res.text()).not.toContain('<ul class="recently-updated">');
  });
});

describe("publicCountry -- languages", () => {
  // The handler reads c.get("lang") and passes it to render(), and passes
  // c.get("pathAfterPrefix") so the language switcher can offer "/england/"
  // rather than "/cy/england/" for English. Both are easy to drop and neither
  // changes the status code. The geojson url inside map_config is
  // locale-prefixed too, because country_geojson is an i18n_patterns route.
  it("renders the Welsh country page, with prefixed links and the Welsh geojson", async () => {
    const body = await getBody("/cy/england/");

    expect(body).toContain('<html lang="cy" dir="ltr"');
    expect(body).toContain("<h2>Diweddarwyd yn ddiweddar</h2>");
    expect(body).toContain("<h2>Edrychwyd arno fwyaf yr wythnos hon</h2>");
    expect(body).toContain('window.gfMapConfig = {"geojson":"/cy/england/geo.json","lat":53,"lng":-1.8,"zoom":6,"location_marker":false};');
    expect(body).toContain('<link rel="canonical" href="https://www.givefood.org.uk/cy/england/">');
    expect(panel(body, "recently-updated")[1]?.href).toBe("/cy/needs/at/salisbury/");
    expect(panel(body, "most-viewed")[0]?.href).toBe("/cy/needs/at/bath/");
  });

  // pageTranslatable: true. It gates BOTH the four hreflang alternates in
  // page.njk and the whole language switcher in includes/langswitcher.njk, so
  // passing false (or forgetting it) silently delists three languages from
  // search engines while the page still looks perfect. The alternate URLs are
  // built from pathAfterPrefix, so this also pins that the country segment
  // survives the prefix swap.
  it("advertises all four language variants of the same country", async () => {
    const body = await getBody("/cy/england/");

    for (const [code, url] of [
      ["en", "/england/"],
      ["cy", "/cy/england/"],
      ["ga", "/ga/england/"],
      ["gd", "/gd/england/"],
    ]) {
      expect(body).toContain(`<link rel="alternate" hreflang="${code}" href="${ORIGIN}${url}">`);
    }
    expect(body).toContain('<div class="langswitcher is-pulled is-pulled-right">');
  });

  it("serves the Irish and Scottish Gaelic country pages too", async () => {
    expect((await get("/ga/wales/")).status).toBe(200);
    expect((await get("/gd/scotland/")).status).toBe(200);
  });

  // "en" is never a URL prefix (prefix_default_language=False in Django, and
  // resolveLanguage's PREFIXES set excludes it here), so /en/england/ is not a
  // second spelling of the page -- it is a 404, as it is in production.
  it("does not answer at /en/england/", async () => {
    expect((await get("/en/england/")).status).toBe(404);
  });
});

describe("publicCountryGeojson -- the response envelope", () => {
  // Django's country_geojson carried @cache_page(SECONDS_IN_HOUR), NOT the
  // wfbn geojson feeds' SECONDS_IN_WEEK, and the module comment says that was
  // verified against a live /england/geo.json's max-age=3600. The header is
  // written by the route itself, so pageCacheControl's "never override" guard
  // must leave it alone -- if it did not, this would come back with
  // `public, max-age=300, s-maxage=...` instead.
  it("serves JSON with a bare one-hour max-age that the page middleware does not touch", async () => {
    const res = await get("/england/geo.json");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("max-age=3600");
    expect(res.headers.get("Cache-Tag")).toBeNull();
  });

  // The three country-scoped queries, in one session, each bound with the
  // DISPLAY NAME. All three filter is_closed = 0; the page's own two queries
  // (above) filter nothing of the sort, which is why a closed food bank shows
  // in the panels and not on the map.
  it("reads the three feeds from one session, by display name, excluding closed rows", async () => {
    await get("/england/geo.json");

    expect(sessions).toBe(1);
    expect(prepared.map((p) => [p.sql, p.params])).toEqual([
      ["SELECT * FROM foodbank WHERE country = ? AND is_closed = 0", ["England"]],
      ["SELECT * FROM foodbanklocation_full WHERE country = ? AND is_closed = 0", ["England"]],
      ["SELECT * FROM foodbankdonationpoint_full WHERE country = ? AND is_closed = 0", ["England"]],
    ]);
  });

  it("does not answer a POST", async () => {
    expect((await get("/england/geo.json", { method: "POST" })).status).toBe(404);
  });

  // The router's rejection, not the handler's: a slug sharing nothing with the
  // four names never reaches publicCountryGeojson at all. The handler's own
  // null-to-404 path is exercised under "the defensive guards" at the bottom
  // of this file, where the input can be chosen exactly.
  it("404s a geo.json for a country outside the four", async () => {
    expect((await get("/france/geo.json")).status).toBe(404);
    expect(prepared).toEqual([]);
  });
});

describe("publicCountryGeojson -- the body", () => {
  // THE WHOLE FEED FOR ONE COUNTRY, BYTE FOR BYTE. geo.json is in PLAN.md's
  // strict byte-equality corpus, so this asserts the complete string rather
  // than a parsed object: json.dumps's `, `/`: ` separators and a Python
  // float printed as "53.0" where JSON.stringify prints "53" are both
  // invisible to JSON.parse. Feature ORDER (food banks, then locations, then
  // donation points -- the Python view's loop order) and property KEY ORDER
  // are the other reason; the map front end draws in receive order.
  //
  // Every rule this scope combines is visible in this one string:
  //   * "address" is KEPT (unlike the all-items feed, which pops it)
  //   * coordinates are 4dp (unlike the other three scoped feeds' 6)
  //   * the delivery address is a SECOND "f" feature reusing the food bank's
  //     own url, with `delivery_address` verbatim -- no postcode line appended
  //   * "Wrexham Centre" belongs to an ENGLISH food bank and is here anyway,
  //     because the filter is on the LOCATION's own country column
  //   * its "foodbank" property is the raw name "Salisbury", while the food
  //     bank feature's own "name" is full_name()'s "Cardiff Foodbank"
  //   * 53/-3 come back as "53.0"/"-3.0", Python's repr() of a whole float
  it("renders the whole Welsh feed in Django's json.dumps formatting", async () => {
    expect(await getBody("/wales/geo.json")).toBe(
      '{"type": "FeatureCollection", "features": [' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-3.1791, 51.4816]}, ' +
        '"properties": {"type": "f", "name": "Cardiff Foodbank", "address": "1 Bute Street\\r\\nCF10 1NS", ' +
        '"url": "/needs/at/cardiff/"}}, ' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-3.2, 51.5]}, ' +
        '"properties": {"type": "f", "name": "Cardiff Foodbank Delivery Address", "address": "Depot Road, Cardiff", ' +
        '"url": "/needs/at/cardiff/"}}, ' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-3.0, 53.0]}, ' +
        '"properties": {"type": "l", "name": "Wrexham Centre", "foodbank": "Salisbury", ' +
        '"address": "4 Border Road\\r\\nLL11 1AA", "url": "/needs/at/salisbury/wrexham-centre/"}}, ' +
        '{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-3.17, 51.48]}, ' +
        '"properties": {"type": "d", "name": "Cardiff Co-op", "foodbank": "Cardiff", ' +
        '"address": "9 Queen Street\\r\\nCF10 2BB", "url": "/needs/at/cardiff/donationpoint/cardiff-co-op/"}}]}',
    );
  });

  // THE ROW-LEVEL COUNTRY FILTER, stated as its own rule because it is the
  // easiest thing in this file to get wrong in a way nothing else notices.
  // Location 13 belongs to English food bank 1 and sits in Wales: it must
  // appear on /wales/geo.json (asserted above) and must NOT appear on
  // /england/geo.json, even though its parent food bank does.
  it("scopes locations and donation points by their OWN country, not their food bank's", async () => {
    const england = featureNames(await getBody("/england/geo.json"));

    expect(england).toContain("Salisbury Foodbank");
    expect(england).toContain("Amesbury Centre");
    expect(england).not.toContain("Wrexham Centre");
    expect(england).not.toContain("Cardiff Foodbank");
  });

  // Closed rows, all three kinds, in one place. A fixture of only open rows
  // passes whether the `is_closed = 0` clauses survived or not, so each of
  // the three has a closed sibling seeded next to it.
  it("drops closed food banks, closed locations and closed donation points", async () => {
    const names = featureNames(await getBody("/england/geo.json"));

    expect(names).toEqual([
      "Salisbury Foodbank",
      "St. Mary's & Pantry Foodbank",
      "Bath Foodbank",
      "Truro Foodbank",
      "Amesbury Centre",
      "Tesco Extra",
    ]);
    expect(names).not.toContain("Closed Town Foodbank");
    expect(names).not.toContain("Wilton Centre");
    expect(names).not.toContain("Boarded Up");
  });

  // country_geojson's location loop (givefood/views.py:367-392) has NO
  // `if location.boundary_geojson` branch at all -- unlike the
  // foodbank/location/constituency feeds, every location here is a plain
  // point. lib/buildGeojson.ts encodes that as `includeBoundary = !allItems
  // && scope.kind !== "country"`, and this is the country half of it running
  // against a real stored polygon rather than a mock.
  it("never renders a location's boundary polygon, only its point", async () => {
    db.prepare("UPDATE foodbanklocation SET boundary_geojson = ? WHERE id = 11").run(
      '{"type":"Feature","properties":{"stored":"gone"},"geometry":{"type":"Polygon","coordinates":[[[-1.78000,51.16]]]}}',
    );

    const body = await getBody("/england/geo.json");

    expect(body).toContain('"type": "l", "name": "Amesbury Centre"');
    expect(body).toContain('"coordinates": [-1.7827, 51.1662]');
    expect(body).not.toContain("Polygon");
    expect(body).not.toContain('"lb"');
  });

  // 4 decimal places, hardcoded at givefood/views.py:318 -- the same as the
  // all-items feed and NOT the 6 the other three scoped feeds use. Food bank 1
  // is seeded at a coordinate whose 5th and 6th digits differ under the two
  // rules, so a 6dp regression shows up here rather than silently.
  it("rounds coordinates to four decimal places, not six", async () => {
    db.prepare("UPDATE foodbank SET lat_lng = '51.1234567,-0.1234567' WHERE id = 1").run();

    const body = await getBody("/england/geo.json");

    expect(body).toContain('"coordinates": [-0.1235, 51.1235]');
    expect(body).not.toContain("0.123457");
  });

  // reverse() inside an i18n_patterns request carries the current language
  // prefix, and all three url names in these features are in @givefood/urls'
  // I18N_SCOPED set. An unprefixed url would bounce a Welsh visitor out of
  // Welsh the moment they clicked a map pin. full_name() is locale-aware too,
  // and cy without an alt_name takes the translated PREFIX rather than the
  // English suffix -- so the name changes shape, not just the url.
  it("prefixes every url with the request's language and localises the food bank name", async () => {
    const body = await getBody("/cy/wales/geo.json");

    expect(body).toContain('"name": "Banc Bwyd Cardiff"');
    expect(body).toContain('"url": "/cy/needs/at/cardiff/"');
    expect(body).toContain('"url": "/cy/needs/at/salisbury/wrexham-centre/"');
    expect(body).toContain('"url": "/cy/needs/at/cardiff/donationpoint/cardiff-co-op/"');
    // English is the unprefixed default, not a "/en" prefix.
    expect(await getBody("/wales/geo.json")).not.toContain("/en/needs/");
  });

  // json.dumps's ensure_ascii=True default: a curly apostrophe or an accented
  // letter comes back \u-escaped. JS's JSON.stringify would emit raw UTF-8
  // and break byte parity on a large fraction of real food bank names --
  // "Ynys Môn" is a real Welsh one.
  it("escapes non-ASCII characters as \\uXXXX", async () => {
    db.prepare("UPDATE foodbank SET name = 'Ynys Môn' WHERE id = 5").run();

    const body = await getBody("/wales/geo.json");

    expect(body).toContain('"name": "Ynys M\\u00f4n Foodbank"');
    expect(body).not.toContain("Môn");
  });

  // A valid country with nothing in it is an EMPTY FeatureCollection, not a
  // 404: buildGeojsonResponse reserves null for the "no such thing" cases, and
  // a caller that 404'd here would break the map on a page that renders fine.
  // /northern-ireland/ has one food bank in the base fixture, so it is emptied
  // rather than relying on a country nothing was seeded for.
  it("returns an empty feature list, not a 404, for a country with no open rows", async () => {
    db.prepare("DELETE FROM foodbank WHERE country = 'Northern Ireland'").run();

    const res = await get("/northern-ireland/geo.json");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"type": "FeatureCollection", "features": []}');
  });
});

// ---------------------------------------------------------------------------
// THE DEFENSIVE GUARDS -- publicCountry's `if (!countryName) return
// c.notFound()` and buildGeojsonResponse's matching null return.
//
// Everything above goes through the production app. These do not, and
// deliberately. The module calls the guard unreachable because the route
// param constrains the slug; the SUSPECTED BUG above shows it is reachable
// after all, but WHICH strings reach it is a TrieRouter implementation detail
// (/anorthern-ireland/ 404s while /xengland/ renders England), and pinning a
// handler's own contract to that would be pinning the wrong thing.
//
// So this is NOT a second copy of the router and asserts nothing about
// routing: it mounts the REAL exported handlers on a deliberately looser path
// so the guard can be exercised with an exact input. Every routing claim in
// this file is made against `app`, above.
// ---------------------------------------------------------------------------
const guardHarness = new Hono<AppEnv>();
guardHarness.get("/:countrySlug/", publicCountry);
guardHarness.get("/:countrySlug/geo.json", publicCountryGeojson);

const guard = async (path: string): Promise<Response> => guardHarness.fetch(new Request(`${ORIGIN}${path}`), env(), execCtx);

describe("publicCountry / publicCountryGeojson -- the defensive guards", () => {
  // Both handlers 404 rather than querying with `country = undefined`, which
  // would render a country page for a country that does not exist, or an
  // empty map, instead of a 404.
  it("404s an unmapped slug without touching D1", async () => {
    expect((await guard("/france/")).status).toBe(404);
    expect((await guard("/france/geo.json")).status).toBe(404);
    expect(prepared).toEqual([]);
  });

  // The lookup is case-sensitive and by slug, so both of the spellings a
  // mis-plumbed caller would most plausibly pass are rejected too.
  it("404s the display name and an upper-case slug", async () => {
    expect((await guard("/England/")).status).toBe(404);
    expect((await guard("/SCOTLAND/")).status).toBe(404);
  });

  // SUSPECTED BUG, pinned rather than fixed. COUNTRY_MAPPING is a plain object
  // literal, so it inherits from Object.prototype and
  // COUNTRY_MAPPING["constructor"] is the Object function -- truthy. The
  // `if (!countryName)` guard therefore does NOT fire, and the handler goes on
  // to bind a FUNCTION as the `country` value of a D1 query (the declared
  // Record<string, string> is a lie for inherited keys). node:sqlite refuses
  // the bind here and D1 would refuse it too, so the request 500s instead of
  // 404ing; had it got past that, COUNTRY_MAP_CONFIG[Object] is undefined and
  // `mapSettings.lat` throws a second time.
  //
  // Not reachable through the production router (the alternation contains no
  // prototype key, so even TrieRouter's loose matching cannot produce one) and
  // NOT fixed here, because the fix (Object.hasOwn, or a null-prototype map)
  // belongs in lib/countries.ts and this file may not touch source.
  // lib/buildGeojson.test.ts pins the same inherited-key hole on the geojson
  // twin, where a mocked D1 lets it get one step further.
  it("500s rather than 404s for a slug naming an Object.prototype key (suspect, pinned)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    // A bare Hono app has no onError of its own, so it turns the throw into a
    // plain 500 -- the production app's onError would render the 500 page.
    // Either way the point is that it is not the 404 the guard exists to give.
    expect((await guard("/constructor/")).status).toBe(500);

    // ...and it got as far as binding that function into BOTH panel queries
    // before anything complained, which is the part worth writing down: the
    // guard did not fire, and the value handed to D1 is not a string.
    expect(prepared).toHaveLength(2);
    expect(typeof prepared[0]?.params?.[0]).toBe("function");
    expect(typeof prepared[1]?.params?.[2]).toBe("function");
  });
});
