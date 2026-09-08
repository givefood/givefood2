import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/wfbn/foodbank.ts -- wfbnFoodbank, GET /needs/at/<slug>/ and its
// three locale-prefixed twins. Ported from gfwfbn/views.py:363-395
// (`foodbank`), read in full alongside this file, together with
// gfwfbn/templates/wfbn/foodbank/index.html and the six includes both
// versions share.
//
// WHY THIS FILE EXISTS. This is the busiest page family on the site (~1,070
// food banks x 4 locales) and the ONLY page that tells a donor what to buy.
// Everything that can go wrong with it renders a beautiful 200:
//
//   * the Unknown/Nothing gate is deliberately on the RAW English
//     `change_text` while the text SHOWN is the translated one. Collapse the
//     two -- the obvious tidy-up -- and nothing changes in English while every
//     Welsh page with a translated need silently swaps branch;
//   * a food bank with no need row at all is NOT the "Nothing" sentinel. It
//     falls through the gate as the empty string and prints "is currently
//     requesting the following items to be donated:" above nothing;
//   * has_service_area is short-circuited on `no_locations`, so a stale
//     counter hides a real service area (Django does exactly the same, which
//     is why the test asserts the hiding rather than the fixing);
//   * map_config is a JSON STRING handed to the map JS. Its `bounds` key is
//     gated on bounds_north ALONE -- three of the four bounds present and the
//     map silently forgets it was ever bounded;
//   * schema_org_str is JSON-LD nobody looks at until a search engine does;
//   * ?turnstilefail= and ?email= are the only two pieces of user input this
//     page takes, and they are echoed back into an HTML attribute.
//
// So every assertion below reads a VALUE out of the rendered body, out of a
// parsed JSON-LD block, or off a response header -- never a bare status code.
//
// REAL EVERYTHING, the harness routes/public/country.test.ts and
// routes/api1.test.ts already use: the real production app (src/index.ts's
// default export), so the four locale registrations, resolveLanguage,
// slugRedirect, cacheTag, geoJsonPreload and pageCacheControl are the genuine
// articles rather than a hand-built router; the real Nunjucks templates and
// the real .po catalogues; the real packages/db queries over real in-memory
// SQLite whose DDL comes from schemaFor(), i.e. from the migrations. Nothing
// this route touches leaves the machine, so NOTHING is mocked -- there is not
// a single vi.fn() in this file except a console.error silencer.
//
// PARITY CLAIMS. Where a comment says "Django does X", X was read out of
// /Users/jasoncartwright/Sites/foodcharity (gfwfbn/views.py,
// givefood/models/foodbank.py, givefood/const/general.py,
// givefood/context_processors.py and the wfbn/foodbank templates). No Python
// was EXECUTED for this file -- where a claim would need a running Django to
// settle it, the comment says so rather than inventing a citation.
//
// MUTATION-TESTED, in an rsync'd copy of the tree OUTSIDE the repo
// (TESTING.md's "several suites were mutation-tested"). 40 mutants across
// this route, packages/db's getFoodbankBySlug and the service-area count,
// lib/needDisplay.ts and lib/schemaOrg.ts; 39 killed, and the fortieth killed
// too once github #52 item 3 landed -- see the note below. A sample, each
// actually run rather than imagined:
//   - the raw/translated split collapsed in EITHER direction -- 2 and 4
//   - the no_locations short circuit dropped, and has_service_area forced
//     false -- 3 and 2
//   - either of the two has_service_area context keys deleted (nested and
//     top-level are read by different templates) -- 1 each
//   - the bounds gate reading bounds_south, or becoming a truthiness test
//     that drops a zero bound -- 1 each
//   - latt and long swapped -- 1
//   - the service-area count losing its NULL predicate, or its `!= ''` one --
//     1 and 2
//   - getFoodbankBySlug gaining `published = 1`, or `is_closed = 0` -- 2 each
//   - the translation lookup issued in English too -- 2
//   - `email` no longer echoed, i.e. the DJANGO behaviour -- 2 (which is what
//     makes the SUSPECT test below a real record of a divergence)
//   - pageTranslatable false, unprefixedPath dropped, prefix set, section
//     renamed, render_time_ms dropped -- 2, 2, 2, 2, 1
//   - a second D1 session opened for the service-area query -- 1
//
// A MUTANT THAT USED TO SURVIVE HERE NOW DIES, and that is github #52 item 3's
// doing. It was: unroll the handler's Promise.all into two sequential awaits.
// Nothing observable from a Request/Response pair could see it -- same page,
// same statements, same order, one more serialised round trip -- because the
// shim counted STATEMENTS and a round trip is not a statement. The shim now
// logs the trips too, and the count that used to be raced against
// resolveNeedDisplay is inside getFoodbankBySlug's batch, so the whole page is
// one wait plus (in Welsh only) a translation lookup. Re-run in a fresh copy
// after that change, with the same method: reverting this handler to the
// pre-#52 pair of round trips, and each of the twelve mutants aimed at
// packages/db's getFoodbankBySlugWithServiceArea, are all killed -- 20 of 20
// across this suite, locationDetail's and packages/db/src/foodbank.test.ts's,
// whose header carries the per-mutant breakdown.

const ORIGIN = "https://www.givefood.org.uk";

type Bindable = null | number | bigint | string | Uint8Array;

// One statement as it reached the engine: the SQL text and the values bound
// to it. The bindings matter as much as the text here -- `getNeedTranslation`
// is a conditional round trip whose ABSENCE is the documented behaviour
// (locale === "en"), and an absent query is invisible in a rendered page.
interface Prepared {
  sql: string;
  params: Bindable[];
}

// STATEMENTS AND ROUND TRIPS ARE DIFFERENT COUNTS, and this page is now a
// change to the second while the first stays put. github #52 item 3 moved
// has_service_area's COUNT(*) out of a serial hop of its own and INTO
// getFoodbankBySlug's batch: three statements either way, one D1 wait instead
// of two. `prepared` alone cannot see that -- both versions prepare the same
// three SQL strings, in the same order, with the same bindings -- so the shim
// below logs the trips as well, one entry per network call, exactly as
// packages/db/src/foodbank.test.ts does.
type RoundTrip = Array<{ sql: string; params: Bindable[] }>;

// The slice of the D1 Sessions API packages/db uses, over node:sqlite. Same
// shim as routes/api1.test.ts, including its `batch` -- getFoodbankBySlug
// sends the food bank row, its latest need and (on this page) the service-area
// count as ONE batch and indexes straight into the result array, so this must
// run them in order and return one result per input.
function d1Session(db: DatabaseSync, prepared: Prepared[], roundTrips: RoundTrip[]): D1DatabaseSession {
  const statement = (sql: string, entry: Prepared) => ({
    sql,
    get params() {
      return entry.params;
    },
    bind: (...next: unknown[]) => {
      entry.params = next as Bindable[];
      return statement(sql, entry);
    },
    first: async <T>() => {
      roundTrips.push([{ sql, params: entry.params }]);
      return (db.prepare(sql).get(...entry.params) as T | undefined) ?? null;
    },
    all: async () => {
      roundTrips.push([{ sql, params: entry.params }]);
      return { results: db.prepare(sql).all(...entry.params), success: true, meta: {} };
    },
    run: async () => {
      roundTrips.push([{ sql, params: entry.params }]);
      db.prepare(sql).run(...entry.params);
      return { success: true, meta: {} };
    },
  });
  return {
    prepare: (sql: string) => {
      const entry: Prepared = { sql, params: [] };
      prepared.push(entry);
      return statement(sql, entry);
    },
    batch: async (statements: Array<{ sql: string; params: Bindable[] }>) => {
      roundTrips.push(statements.map((s) => ({ sql: s.sql, params: s.params })));
      return statements.map((s) => ({ results: db.prepare(s.sql).all(...s.params), success: true, meta: {} }));
    },
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let prepared: Prepared[];
let roundTrips: RoundTrip[];
let sessions: number;

// The trips this page's HANDLER made, with the slug-redirect middleware's own
// lookup filtered out the way `prepared` is reset past it below.
const handlerTrips = (): RoundTrip[] => roundTrips.filter((t) => !t.some((s) => s.sql.includes("slugredirect")));

function env(): AppEnv["Bindings"] {
  return {
    DB: {
      withSession: () => {
        sessions += 1;
        return d1Session(db, prepared, roundTrips);
      },
    },
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: { get: async () => null, put: async () => {}, delete: async () => {} },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

// ---------------------------------------------------------------------------
// Seeds. Only the columns this page reads are parameterised; every other NOT
// NULL column is filled with something the real migration accepts, so a seeded
// row is one production would have taken.
// ---------------------------------------------------------------------------

interface FoodbankSeed {
  id: number;
  slug: string;
  name: string;
  altName?: string | null;
  country?: string;
  latLng?: string;
  network?: string | null;
  charityNumber?: string | null;
  charityName?: string | null;
  bankuetSlug?: string | null;
  fsaId?: string | null;
  facebookPage?: string | null;
  phoneNumber?: string | null;
  secondaryPhoneNumber?: string | null;
  url?: string;
  rssUrl?: string | null;
  newsUrl?: string | null;
  plusCodeGlobal?: string | null;
  placeId?: string | null;
  placeHasPhoto?: 0 | 1 | null;
  addressIsAdministrative?: 0 | 1;
  district?: string | null;
  constituencyName?: string | null;
  deliveryAddress?: string | null;
  deliveryLatLng?: string | null;
  isClosed?: 0 | 1;
  isSchool?: 0 | 1 | null;
  noLocations?: number;
  noDonationPoints?: number | null;
  latestNeedId?: number | null;
  bounds?: [number | null, number | null, number | null, number | null];
  address?: string;
  postcode?: string;
  contactEmail?: string;
}

function seedFoodbank(s: FoodbankSeed): void {
  const [north, south, east, west] = s.bounds ?? [null, null, null, null];
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, alt_name, slug, address, postcode, country, lat_lng,
       latitude, longitude, delivery_address, delivery_lat_lng, network, charity_number,
       charity_just_foodbank, charity_name, facebook_page, bankuet_slug, fsa_id, contact_email,
       phone_number, secondary_phone_number, url, shopping_list_url, rss_url, news_url,
       place_id, plus_code_global, place_has_photo, district, parliamentary_constituency_name,
       address_is_administrative, is_closed, is_school, no_locations, no_donation_points,
       days_between_needs, bounds_north, bounds_south, bounds_east, bounds_west, latest_need_id,
       created, modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 14, ?, ?, ?, ?, ?,
       '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run(
    s.id,
    String(s.id).padStart(32, "a"),
    s.name,
    s.altName ?? null,
    s.slug,
    s.address ?? "12 High Street\r\nHarnham",
    s.postcode ?? "SP2 8LZ",
    s.country ?? "England",
    s.latLng ?? "51.0688,-1.7945",
    s.deliveryAddress ?? null,
    s.deliveryLatLng ?? null,
    s.network ?? null,
    s.charityNumber ?? null,
    s.charityName ?? null,
    s.facebookPage ?? null,
    s.bankuetSlug ?? null,
    s.fsaId ?? null,
    s.contactEmail ?? `info@${s.slug}.invalid`,
    s.phoneNumber ?? null,
    s.secondaryPhoneNumber ?? null,
    s.url ?? `https://${s.slug}.invalid/`,
    `https://${s.slug}.invalid/list/`,
    s.rssUrl ?? null,
    s.newsUrl ?? null,
    s.placeId ?? null,
    s.plusCodeGlobal ?? null,
    s.placeHasPhoto ?? null,
    s.district ?? null,
    s.constituencyName ?? null,
    s.addressIsAdministrative ?? 0,
    s.isClosed ?? 0,
    s.isSchool ?? null,
    s.noLocations ?? 0,
    s.noDonationPoints ?? null,
    north,
    south,
    east,
    west,
    s.latestNeedId ?? null,
  );
}

// `created`/`modified` are TEXT and are written in Django's own spelling
// ("2026-09-05 19:28:08.853000", a space and six digits of microseconds)
// throughout, because that is what the ETL copied out of Postgres and what
// every lexicographic comparison in this codebase is written against.
function seedNeed(o: { id: number; foodbankId: number; changeText: string; excess?: string | null; published?: 0 | 1 }): void {
  db.prepare(
    `INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, excess_change_text,
       published, input_method, created, modified)
     VALUES (?, ?, ?, ?, ?, ?, 'scrape', '2026-09-05 19:28:08.853000', '2026-09-05 19:28:08.853000')`,
  ).run(o.id, String(o.id).padStart(32, "b"), o.foodbankId, o.changeText, o.excess ?? null, o.published ?? 1);
}

function seedTranslation(o: { id: number; needId: number; language: string; changeText?: string | null; excess?: string | null }): void {
  db.prepare(
    "INSERT INTO foodbankchangetranslation (id, need_id, foodbank_id, language, change_text, excess_change_text) VALUES (?, ?, NULL, ?, ?, ?)",
  ).run(o.id, o.needId, o.language, o.changeText ?? null, o.excess ?? null);
}

function seedLocation(o: { id: number; foodbankId: number; name: string; slug: string; boundary?: string | null }): void {
  db.prepare(
    `INSERT INTO foodbanklocation (id, uuid, foodbank_id, name, slug, address, postcode, country,
       lat_lng, is_closed, boundary_geojson, modified)
     VALUES (?, ?, ?, ?, ?, '1 Side Street', 'SP1 1AA', 'England', '51.07,-1.79', 0, ?,
       '2020-01-01 00:00:00.000000')`,
  ).run(o.id, String(o.id).padStart(32, "e"), o.foodbankId, o.name, o.slug, o.boundary ?? null);
}

// THE FIXTURE IS THE TEST: each food bank turns exactly one branch of the
// page on or off relative to its neighbour.
//
//   1  salisbury      a full, real-looking food bank: a need list with a
//                     blank line in it, an excess list, a Trussell
//                     membership, a charity number, Bankuet, an FSA id, a
//                     Facebook page, two phone numbers, a photo, a service
//                     area, and a url that already has a querystring
//   2  bath           change_text "Unknown" -- the sentinel branch. ALSO
//                     no_locations = 0 while owning a location WITH a
//                     boundary, which is the has_service_area short circuit
//   3  truro          change_text "Nothing", country "Jersey" (outside
//                     CHARITY_DETAIL_COUNTRIES), network "Independent"
//   4  fb-town        change_text "Facebook" -- the embed branch
//   5  caerdydd       alt_name set, for full_name()'s Welsh branch
//   6  closed-town    is_closed = 1
//   7  salvation-army a DONT_APPEND_FOOD_BANK name, and charitynetwork.njk's
//                     own Salvation Army branch
//   8  bounded        all four bounds columns set
//   9  half-bounded   bounds_north NULL, the other three set
//  10  no-need-town   latest_need_id NULL -- no need row exists at all
//  11  school-town    is_school = 1, with a real need list
function seed(): void {
  seedFoodbank({
    id: 1,
    slug: "salisbury",
    name: "Salisbury",
    latLng: "51.0688,-1.7945",
    network: "Trussell",
    charityNumber: "1130237",
    charityName: "Salisbury Foodbank Trust",
    bankuetSlug: "salisbury",
    fsaId: "654321",
    facebookPage: "salisburyfoodbank",
    phoneNumber: "01722 580180",
    secondaryPhoneNumber: "07700 900123",
    url: "https://salisburyfoodbank.org.uk/?utm_source=newsletter",
    rssUrl: "https://salisburyfoodbank.org.uk/feed/",
    plusCodeGlobal: "9C3W3QCJ+2V",
    placeId: "ChIJsalisbury",
    placeHasPhoto: 1,
    district: "Wiltshire",
    constituencyName: "Salisbury",
    noLocations: 2,
    noDonationPoints: 3,
    latestNeedId: 101,
  });
  seedNeed({ id: 101, foodbankId: 1, changeText: "Tinned soup\n\nLong life milk\nNappies (size 5)", excess: "Baked beans\n\nPasta" });
  seedLocation({ id: 11, foodbankId: 1, name: "Amesbury Centre", slug: "amesbury", boundary: '{"type":"Polygon","coordinates":[]}' });
  seedLocation({ id: 12, foodbankId: 1, name: "Wilton Centre", slug: "wilton" });

  seedFoodbank({ id: 2, slug: "bath", name: "Bath", network: "IFAN", charityNumber: "1170875", latestNeedId: 102, noLocations: 0 });
  seedNeed({ id: 102, foodbankId: 2, changeText: "Unknown" });
  // no_locations says zero; this location says otherwise. Django's
  // has_service_area() short-circuits on the counter, so this row must not
  // reach the map legend.
  seedLocation({ id: 21, foodbankId: 2, name: "Twerton Centre", slug: "twerton", boundary: '{"type":"Polygon","coordinates":[]}' });

  seedFoodbank({
    id: 3,
    slug: "truro",
    name: "Truro",
    country: "Jersey",
    network: "Independent",
    charityNumber: "NPO123",
    charityName: "Truro Trust",
    latestNeedId: 103,
  });
  seedNeed({ id: 103, foodbankId: 3, changeText: "Nothing" });

  seedFoodbank({ id: 4, slug: "fb-town", name: "Fbtown", facebookPage: "fbtownfoodbank", latestNeedId: 104 });
  seedNeed({ id: 104, foodbankId: 4, changeText: "Facebook" });

  // alt_name is deliberately NOT "Banc Bwyd Caerdydd": that is exactly what
  // the cy prefix branch would produce from the bare name anyway, so an
  // alt_name-shaped alt_name makes the test unable to tell "alt_name won"
  // from "alt_name was ignored". Mutation-tested -- passing `null` in place
  // of alt_name survived until this row was changed.
  seedFoodbank({ id: 5, slug: "caerdydd", name: "Caerdydd", altName: "Pantri Bwyd Bae Caerdydd", country: "Wales", latestNeedId: 105 });
  seedNeed({ id: 105, foodbankId: 5, changeText: "Ffa pob\nPasta" });

  seedFoodbank({ id: 6, slug: "closed-town", name: "Closed Town", isClosed: 1, latestNeedId: 106 });
  seedNeed({ id: 106, foodbankId: 6, changeText: "Rice" });

  seedFoodbank({
    id: 7,
    slug: "salvation-army",
    name: "Salvation Army",
    charityNumber: "214779",
    network: "Independent",
    latestNeedId: 107,
  });
  seedNeed({ id: 107, foodbankId: 7, changeText: "Nothing" });

  seedFoodbank({ id: 8, slug: "bounded", name: "Bounded", bounds: [52.5, 51.5, -1.5, -2.5], latestNeedId: 108 });
  seedNeed({ id: 108, foodbankId: 8, changeText: "Soup" });

  seedFoodbank({ id: 9, slug: "half-bounded", name: "Half Bounded", bounds: [null, 51.5, -1.5, -2.5], latestNeedId: 109 });
  seedNeed({ id: 109, foodbankId: 9, changeText: "Soup tins" });

  seedFoodbank({ id: 10, slug: "no-need-town", name: "No Need Town", latestNeedId: null });

  seedFoodbank({ id: 11, slug: "school-town", name: "School Town", isSchool: 1, latestNeedId: 111 });
  seedNeed({ id: 111, foodbankId: 11, changeText: "Cereal" });
}

beforeEach(async () => {
  db = new DatabaseSync(":memory:");
  // schemaFor, not hand-written DDL: getFoodbankBySlug reads through the
  // `foodbankchange_full` VIEW (github #51 -- eight suites 500'd at once when
  // it started doing so), and `slugredirect` is read by the slugRedirect
  // middleware on every /needs/at/ URL whether this route wants it or not.
  db.exec(schemaFor("foodbank", "foodbankchange", "foodbankchange_full", "foodbanklocation", "foodbankchangetranslation", "slugredirect"));
  seed();
  prepared = [];
  roundTrips = [];
  sessions = 0;

  // WARM THE SLUG-REDIRECT MEMO BEFORE COUNTING ANYTHING. middleware/
  // slugRedirect.ts holds its map in a MODULE-level memo with a 5-minute TTL,
  // so the first /needs/at/ request through this file's isolate opens a
  // second D1 session and issues a `SELECT ... FROM slugredirect` that no
  // later request repeats. Without this line the query-count assertions below
  // would depend on which test ran first -- which is exactly the kind of
  // order-dependence that makes a suite flaky when someone adds a `.only`.
  await get("/needs/at/warm-the-memo/");
  prepared = [];
  roundTrips = [];
  sessions = 0;
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

// `async`, not a bare arrow: app.fetch is typed Response | Promise<Response>.
const get = async (path: string, init?: RequestInit): Promise<Response> => app.fetch(new Request(`${ORIGIN}${path}`, init), env(), execCtx);
const body = async (path: string): Promise<string> => (await get(path)).text();

// The JSON-LD block the page emits for search engines, parsed. It is inside
// `<script type="application/ld+json">`, emitted `|safe` (unescaped), so
// this is the literal document a crawler would parse.
async function schemaOrg(path: string): Promise<Record<string, unknown>> {
  const html = await body(path);
  const match = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error("no ld+json block in the rendered page");
  return JSON.parse(match[1] as string) as Record<string, unknown>;
}

// includes/mapconfig.njk drops `map_config` into a <script> verbatim, so the
// string between "= " and ";" is exactly what the map JS parses.
function mapConfigOf(html: string): string {
  const match = /window\.gfMapConfig = ([\s\S]*?);\n/.exec(html);
  if (!match) throw new Error("no gfMapConfig in the rendered page");
  return match[1] as string;
}

describe("wfbnFoodbank -- the response envelope", () => {
  // Django's `foodbank` view has its @cache_page COMMENTED OUT
  // (gfwfbn/views.py:362), so the origin sets no TTL of its own and
  // middleware/pageCacheControl.ts's fall-through DAY rule is what this page
  // gets. The browser number is deliberately NOT Django's -- BROWSER_MAX_AGE
  // is 300 because a browser cache cannot be purged and this page's entire
  // purpose is the currency of the list on it.
  it("serves cacheable HTML: five minutes in the browser, a day at the purgeable edge", async () => {
    const res = await get("/needs/at/salisbury/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    expect(res.headers.get("Content-Language")).toBe("en");
  });

  // THE TAG IS WHY THE DAY ABOVE IS SAFE. queues/cachePurge.ts purges by
  // `fb-<slug>` when a need is published; without this header an edge copy of
  // yesterday's shopping list would sit there for 24 hours with no way to
  // revoke it. Cloudflare strips Cache-Tag before the browser sees it, so
  // nobody would notice its absence from outside.
  it("stamps the food bank's own purge tag", async () => {
    expect((await get("/needs/at/salisbury/")).headers.get("Cache-Tag")).toBe("fb-salisbury");
    expect((await get("/cy/needs/at/salisbury/")).headers.get("Cache-Tag")).toBe("fb-salisbury");
  });

  // Django's GeoJSONPreload (givefood/middleware.py:95-135) lists this view's
  // url_name, and the port reproduces it for the unprefixed route. The
  // locale-prefixed page gets NO hint, because index.ts registers
  // "/cy/needs/at/:slug/" as its own route and geoJsonPreload compares
  // routePath against the unprefixed literal -- a real divergence from
  // Django, already pinned in middleware/geoJsonPreload.test.ts and asserted
  // here because this is the page it costs.
  // github #30: the Welsh half used to assert null, "divergently". Django
  // sends this header on /cy/ pages -- LocaleMiddleware runs outside
  // GeoJSONPreload, so resolve() has already stripped the prefix -- and the
  // port sent nothing on any of cy/ga/gd. Through the REAL router here, which
  // is what geoJsonPreload.test.ts's hand-built apps cannot be.
  it("preloads the food bank's geojson in English and, now, in Welsh with the prefix", async () => {
    expect((await get("/needs/at/salisbury/")).headers.get("Link")).toBe(
      "</needs/at/salisbury/geo.json>; rel=preload; as=fetch; crossorigin=anonymous",
    );
    // The PREFIXED url, matching what the Welsh page actually fetches:
    // map_config.geojson is built with urlForLocale(), so preloading the
    // unprefixed file would warm a cache entry the page never reads.
    expect((await get("/cy/needs/at/salisbury/")).headers.get("Link")).toBe(
      "</cy/needs/at/salisbury/geo.json>; rel=preload; as=fetch; crossorigin=anonymous",
    );
  });

  // ONE D1 SESSION, THREE STATEMENTS, AND -- SINCE github #52 -- ONE WAIT.
  //
  // lib/session.ts opens a single withSession("first-unconstrained") per
  // request so every query sees one snapshot of a replicated database. A
  // handler that opened one per query would render identically.
  //
  // All three statements are getFoodbankBySlugWithServiceArea's BATCH: the
  // food bank row, its latest need, and has_service_area's COUNT(*). The count
  // used to be a fourth-line serial await after the batch, and its answer is
  // false for 1,016 of the 1,023 open food banks -- ~16-22 ms of pure
  // round-trip latency, measured against production, for a `false`.
  //
  // THE COUNT IS BOUND TO THE SLUG, NOT THE ID, and that is the whole trick:
  // an id-keyed count could not join this batch, because the id only exists in
  // the batch's own first result. `foodbank_slug_uniq` is UNIQUE so the
  // scalar subquery is the same predicate, at a cost of one extra rows_read
  // (10 vs 9 for salisbury, measured on production D1).
  //
  // Nothing here is bound to anything but the slug, which is what says the
  // page cannot be made per-visitor by a query string.
  it("reads the page from one session, in ONE round trip carrying all three statements", async () => {
    await get("/needs/at/salisbury/");

    expect(sessions).toBe(1);
    expect(prepared.map((p) => [p.sql, p.params])).toEqual([
      ["SELECT * FROM foodbank WHERE slug = ?", ["salisbury"]],
      ["SELECT * FROM foodbankchange_full WHERE id = (SELECT latest_need_id FROM foodbank WHERE slug = ?)", ["salisbury"]],
      [
        "SELECT COUNT(*) AS n FROM foodbanklocation l WHERE l.foodbank_id = (SELECT id FROM foodbank WHERE slug = ?) " +
          "AND l.boundary_geojson IS NOT NULL AND l.boundary_geojson != ''",
        ["salisbury"],
      ],
    ]);
    // The statement list above is IDENTICAL in shape to the pre-#52 one (three
    // statements, same order, count last), so it cannot tell the two apart.
    // This can: one network wait, carrying three.
    expect(handlerTrips().map((t) => t.length)).toEqual([3]);
  });

  // English NEVER queries FoodbankChangeTranslation. Django's get_text()
  // takes the `current_language == "en"` branch (needs.py:221-225) and reads
  // the column directly, and this is the site's busiest page: a lookup here
  // would be a wasted round trip on the large majority of all requests.
  it("issues no translation lookup on the English page, and exactly one on the Welsh one", async () => {
    await get("/needs/at/salisbury/");
    expect(prepared.map((p) => p.sql).filter((s) => s.includes("foodbankchangetranslation"))).toEqual([]);

    prepared = [];
    await get("/cy/needs/at/salisbury/");
    expect(prepared.filter((p) => p.sql.includes("foodbankchangetranslation"))).toEqual([
      {
        sql: "SELECT change_text, excess_change_text FROM foodbankchangetranslation WHERE language = ? AND need_id = ?",
        params: ["cy", 101],
      },
    ]);
  });

  // An unknown slug is Django's get_object_or_404. It must reach the real 404
  // page and, above all, must NOT be stamped cacheable: pageCacheControl only
  // touches 200s and cacheTag only touches ok responses, so a mistyped slug
  // cannot poison the edge with a day-long negative entry.
  it("404s an unknown slug, uncached and untagged", async () => {
    const res = await get("/needs/at/nowhere/");

    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(res.headers.get("Cache-Tag")).toBeNull();
    expect(await res.text()).not.toContain("is currently requesting the following items");
  });

  // lib/appendSlash.ts, Django's APPEND_SLASH. The slashless spelling is what
  // a hand-typed URL and a good many inbound links look like.
  it("redirects the slashless spelling rather than 404ing it", async () => {
    const res = await get("/needs/at/salisbury");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/needs/at/salisbury/`);
  });

  // GET ONLY, matching Django's `foodbank`. index.ts registers this with
  // app.get; a stray app.all would hand a POST to a handler whose response
  // pageCacheControl then stamps public for a day. The handler reads nothing
  // from a body, so a POST that reached it would render and be cached.
  it("does not answer a POST at all", async () => {
    expect((await get("/needs/at/salisbury/", { method: "POST" })).status).toBe(404);
  });

  // A GET THAT WRITES IS THE FAILURE THIS ASSERTS AGAINST -- a route in this
  // repo has been caught with one before. Every statement that reaches the
  // engine on the fullest page in the fixture is a SELECT, in every locale
  // and with the query string this page accepts. A page stamped
  // `public, s-maxage=86400` cannot afford a side effect: the edge would
  // serve it once and swallow every subsequent one.
  it("issues nothing but SELECTs, in any locale and with any query string", async () => {
    await get("/needs/at/salisbury/?turnstilefail=1&email=donor%40example.org");
    await get("/cy/needs/at/salisbury/");

    expect(prepared).not.toHaveLength(0);
    for (const { sql } of prepared) expect(sql).toMatch(/^SELECT /);
  });

  // The slug comparison is SQLite's default case-sensitive `=` on TEXT, so a
  // shouted URL is a 404 rather than a second, uncanonical spelling of the
  // page. Django's slug lookup is exact too. A `COLLATE NOCASE` added to the
  // column would silently create duplicate content for every food bank.
  it("does not answer a differently-cased slug", async () => {
    expect((await get("/needs/at/SALISBURY/")).status).toBe(404);
    expect((await get("/needs/at/Salisbury/")).status).toBe(404);
  });

  // A D1 outage must produce the 500 page, not a food bank page with an empty
  // shopping list -- and must not be cached, or an hour of "this food bank
  // needs nothing" goes out to everyone.
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

    const res = await app.fetch(new Request(`${ORIGIN}/needs/at/salisbury/`), broken, execCtx);

    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(await res.text()).not.toContain("Tinned soup");
  });

  // elapsedMs() reports WHOLE milliseconds, deliberately unlike Django's
  // three decimal places -- on Workers performance.now() is coarsened and the
  // fraction was always ".000", decoration that reads like precision. A
  // revert to toFixed(3) shows up here as "Took 0.000ms"; dropping
  // render_time_ms leaves "Took ms". Only the FORMAT is asserted: 0 is a
  // legitimate value on the clock this exists to describe.
  it("stamps the debug comment with a whole-millisecond render time", async () => {
    expect(/⏱️ Took (\S+)/.exec(await body("/needs/at/salisbury/"))?.[1]).toMatch(/^\d+ms$/);
  });
});

describe("wfbnFoodbank -- full_name, which is locale-aware and is not the slug", () => {
  // Foodbank.full_name() (givefood/models/foodbank.py) via
  // @givefood/models' fullNameLocaleAware. Four locales, three different
  // rules, and the page prints it in the <title>, the <h1>, the breadcrumb,
  // three <meta>s and the RSS link title -- so getting it wrong is loud, but
  // getting it wrong in ONE locale is silent to an English-speaking reviewer.
  it("appends Foodbank in English and Irish, translates the word in Welsh and Gaelic", async () => {
    expect(await body("/needs/at/salisbury/")).toContain("<title>Salisbury Foodbank - Give Food</title>");
    expect(await body("/ga/needs/at/salisbury/")).toContain("<title>Salisbury Foodbank - Give Food</title>");
    expect(await body("/cy/needs/at/salisbury/")).toContain("<title>Banc Bwyd Salisbury - Give Food</title>");
    expect(await body("/gd/needs/at/salisbury/")).toContain("<title>Banca-bìdh Salisbury - Give Food</title>");
  });

  // The cy-with-alt_name branch: alt_name wins OUTRIGHT, with no prefix and
  // no suffix. Every other locale ignores alt_name entirely -- including gd,
  // which is the pair most easily conflated with cy.
  it("uses alt_name verbatim in Welsh only", async () => {
    const cy = await body("/cy/needs/at/caerdydd/");
    expect(cy).toContain("<title>Pantri Bwyd Bae Caerdydd - Give Food</title>");
    expect(cy).toMatch(/<h1>\s*Pantri Bwyd Bae Caerdydd\s*<\/h1>/);
    // "Banc Bwyd Caerdydd" is what the cy branch would produce if alt_name
    // were ignored, so its absence is what says alt_name actually won.
    expect(cy).not.toContain("Banc Bwyd Caerdydd");

    expect(await body("/needs/at/caerdydd/")).toContain("<title>Caerdydd Foodbank - Give Food</title>");

    // gd takes the translated-prefix branch and never looks at alt_name --
    // the pair most easily conflated with cy, since both prefix a word.
    const gd = await body("/gd/needs/at/caerdydd/");
    expect(gd).toContain("<title>Banca-bìdh Caerdydd - Give Food</title>");
    expect(gd).toMatch(/<h1>\s*Banca-bìdh Caerdydd\s*<\/h1>/);
  });

  // DONT_APPEND_FOOD_BANK (givefood/const/general.py) is checked BEFORE the
  // cy/gd prefix branch, so these names get no suffix and no prefix in any
  // language. "Salvation Army Foodbank" is not a thing that exists.
  it("leaves a DONT_APPEND_FOOD_BANK name bare in every locale", async () => {
    expect(await body("/needs/at/salvation-army/")).toContain("<title>Salvation Army - Give Food</title>");
    expect(await body("/cy/needs/at/salvation-army/")).toContain("<title>Salvation Army - Give Food</title>");
  });

  it("puts the same name in the h1, the breadcrumb and the social meta", async () => {
    const html = await body("/needs/at/salisbury/");

    expect(html).toContain('<meta property="og:title" content="Salisbury Foodbank">');
    expect(html).toContain('<meta name="description" content="Find what Salisbury Foodbank is requesting to have donated">');
    expect(html).toContain('<meta property="og:image:alt" content="Map of Salisbury Foodbank">');
    expect(html).toContain('<meta name="geo.placename" content="Salisbury Foodbank">');
    expect(html).toContain('<li class="is-active"><a href="#" aria-current="page">Salisbury Foodbank</a></li>');
    expect(html).toMatch(/<h1>\s*Salisbury Foodbank\s*<\/h1>/);
  });

  // `prefix` is passed as null unconditionally. pagetitle.njk is shared with
  // the locations/donation-point pages, which DO set it ("Locations - X"), so
  // the food bank page's own h1 must not inherit one.
  it("renders the page title with no prefix segment", async () => {
    expect(await body("/needs/at/salisbury/")).not.toMatch(/<h1>[\s\S]*? - [\s\S]*?Salisbury Foodbank/);
  });
});

describe("wfbnFoodbank -- the need list, and the gate that decides which page you get", () => {
  // THE HAPPY PATH, and the blank-line strip inside it. The stored
  // change_text has an empty line in it (a scrape of a <ul> with gaps
  // routinely does); get_change_text() drops it so |linebreaksbr does not
  // emit a run of empty <br>s.
  it("prints the shopping list, blank lines removed, as <br>-joined text", async () => {
    const html = await body("/needs/at/salisbury/");

    expect(html).toContain("Salisbury Foodbank is currently requesting the following items to be donated:");
    expect(html).toContain("Tinned soup<br>Long life milk<br>Nappies (size 5)");
    expect(html).not.toContain("<br><br>");
  });

  // excess_text_list is the joined "They don't need any more X, Y." line, and
  // its blank line is stripped the same way -- a stray ", ," in that sentence
  // is the visible symptom.
  it("lists the excess items comma-separated, without the blank line", async () => {
    // The apostrophe is NOT entity-escaped: blocktrans output is wrapped in a
    // nunjucks SafeString (Django's own {% blocktrans %} is equally
    // autoescape-exempt), so this is the byte sequence a browser receives.
    expect(await body("/needs/at/salisbury/")).toContain("<p>They don't need any more Baked beans, Pasta.</p>");
  });

  // The excess paragraph is gated on the RAW excess column, so a food bank
  // with no excess text must not emit an empty "They don't need any more ."
  it("omits the excess sentence entirely when there is no excess text", async () => {
    expect(await body("/needs/at/school-town/")).not.toContain("They don't need any more");
  });

  // THE SENTINEL BRANCH. "Unknown" and "Nothing" both take the else: no
  // shopping list, no subscribe box, and a contacts block plus the charity
  // and FSA panels instead. need_text.njk's own two sentinel strings are NOT
  // reached from this page for these two values -- the outer gate wins first.
  it("replaces the shopping list with contact details for the Unknown and Nothing sentinels", async () => {
    for (const slug of ["bath", "truro"]) {
      const html = await body(`/needs/at/${slug}/`);
      expect(html).not.toContain("is currently requesting the following items to be donated:");
      expect(html).not.toContain('<div class="subscribe">');
      expect(html).toContain('<div class="contacts">');
    }
  });

  // The RSS alternate link is gated on the same raw sentinel test: a food
  // bank with nothing to say has no feed worth advertising. Django's
  // index.html:7 does the same.
  it("advertises the RSS feed only when there is a real need list", async () => {
    expect(await body("/needs/at/salisbury/")).toContain(
      '<link rel="alternate" type="application/rss+xml" title="RSS feed for Salisbury Foodbank" href="/needs/at/salisbury/rss.xml">',
    );
    expect(await body("/needs/at/bath/")).not.toContain('type="application/rss+xml"');
  });

  // SUSPECT, PINNED AS-IS -- and it is the port faithfully reproducing
  // Django, not a port defect. A food bank whose latest_need_id is NULL has
  // NO need row, so changeText is "" -- a real, distinct value, not the
  // "Nothing" sentinel. "" is neither "Unknown" nor "Nothing", so the page
  // falls through the gate into the HAS-A-LIST branch and announces that the
  // food bank "is currently requesting the following items to be donated:"
  // above an empty paragraph, with a subscribe box under it.
  //
  // Django lands in the same place by a different road: `foodbank.latest_need`
  // is None, `{{ foodbank.latest_need.change_text }}` silently resolves to
  // Django's string_if_invalid (""), and `"" != "Unknown"` is True there too.
  // foodbank.ts's own comment names this as the semantics it is matching. All
  // 1,070 production rows have a latest_need_id (packages/db/src/foodbank.ts
  // records that), so this is a state the data does not currently reach --
  // which is exactly why it needs a test rather than an observation.
  it("SUSPECT: a food bank with no need row at all advertises an empty shopping list", async () => {
    const html = await body("/needs/at/no-need-town/");

    expect(html).toContain("No Need Town Foodbank is currently requesting the following items to be donated:");
    expect(html).toMatch(/<p class="needs">\s*<\/p>/);
    expect(html).toContain('<div class="subscribe">');
  });

  // NEITHER STATEMENT FILTERS ON `published`. latest_need_id is a plain FK
  // and getFoodbankBySlug follows it wherever it points, so an unpublished
  // need that some admin action has made "latest" is shown to the public
  // exactly as a published one would be. Django's
  // `select_related("latest_need")` does the same, so this is parity and not
  // a port defect -- pinned because "add published = 1, obviously" is a
  // one-line change that would blank the shopping list on any food bank
  // whose latest need has not been published yet, which is the state a
  // half-finished admin edit leaves behind.
  it("shows an UNPUBLISHED need if latest_need_id points at one", async () => {
    db.prepare("UPDATE foodbankchange SET published = 0 WHERE id = 101").run();

    expect(await body("/needs/at/salisbury/")).toContain("Tinned soup<br>Long life milk");
  });

  // need_text.njk's own sentinel branches ARE reachable, just not from a raw
  // "Unknown"/"Nothing". They exist for the case where the DISPLAY text is a
  // sentinel while the raw text is not -- see the translated-sentinel test in
  // the locale section below, which is the only way this page produces one.
  it("renders the school notice above the list, gated on the same sentinel test", async () => {
    expect(await body("/needs/at/school-town/")).toContain(
      "🏫 This food bank is located at a school, so may not be open to the public.",
    );
    expect(await body("/needs/at/salisbury/")).not.toContain("located at a school");
  });

  // is_closed drives two independent things: the visible banner and the
  // robots meta. Losing the meta alone leaves a closed food bank's page in
  // the index indefinitely, with no visible symptom at all.
  it("marks a closed food bank noindex and says so on the page", async () => {
    const html = await body("/needs/at/closed-town/");

    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain("This food bank is closed");

    const open = await body("/needs/at/salisbury/");
    expect(open).not.toContain('content="noindex"');
    expect(open).not.toContain("This food bank is closed");
  });
});

describe("wfbnFoodbank -- the Facebook branch", () => {
  // The inner branch tests the DISPLAY text ("Facebook"), the outer one the
  // raw column -- Django's `{% with foodbank.latest_need.get_change_text as
  // change_text %}{% if change_text == "Facebook" %}`. The embed replaces the
  // shopping list entirely.
  it("embeds the food bank's Facebook page instead of a list", async () => {
    const html = await body("/needs/at/fb-town/");

    expect(html).toContain("<p>You can find out what is needed on the foodbank's Facebook page:</p>");
    expect(html).toContain('data-href="https://www.facebook.com/fbtownfoodbank"');
    expect(html).not.toContain("is currently requesting the following items to be donated:");
  });

  // FACEBOOK_LOCALES, and the one place this module keeps a table of its own.
  // en/cy match givefood/const/general.py exactly. ga is absent from Django's
  // map, so Django's `.get(language_code, "en_GB")` yields en_GB and the port
  // agrees.
  it("hands the Facebook SDK the locale-specific script for English and Welsh", async () => {
    expect(await body("/needs/at/fb-town/")).toContain("https://connect.facebook.net/en_GB/sdk.js");
    expect(await body("/cy/needs/at/fb-town/")).toContain("https://connect.facebook.net/cy_GB/sdk.js");
    expect(await body("/ga/needs/at/fb-town/")).toContain("https://connect.facebook.net/en_GB/sdk.js");
  });

  // SUSPECTED BUG, PINNED RATHER THAN FIXED. givefood/const/general.py:188-196
  // maps "gd" to "gd_GB"; this module's FACEBOOK_LOCALES maps it to "en_GB",
  // and its comment claims Facebook's supported-locale list has neither ga nor
  // gd. That is true of ga, which Django also has no entry for -- but Django
  // DOES carry gd_GB, so a Scottish Gaelic visitor gets an English Facebook
  // widget here and a Gaelic one in production. Whether Facebook actually
  // serves gd_GB is not something this repo can settle, and is not why the
  // test exists: the divergence from the file it says it ports is.
  it("SUSPECTED BUG: serves the Scottish Gaelic page an en_GB Facebook SDK where Django sends gd_GB", async () => {
    expect(await body("/gd/needs/at/fb-town/")).toContain("https://connect.facebook.net/en_GB/sdk.js");
    expect(await body("/gd/needs/at/fb-town/")).not.toContain("gd_GB");
  });
});

describe("wfbnFoodbank -- the raw/translated split, which only shows in cy, ga and gd", () => {
  // THE SPLIT THIS ROUTE EXISTS TO MAINTAIN, and the single mistake most
  // likely to be made in it: `latest_need_change_text` is the RAW English
  // column that index.njk's Unknown/Nothing gates compare against, while
  // `latest_need_get_change_text` is the translated DISPLAY text. Collapse
  // them into one value and English is unaffected while every translated page
  // changes.
  it("shows the Welsh translation while still gating on the English column", async () => {
    seedTranslation({ id: 1, needId: 101, language: "cy", changeText: "Cawl tun\n\nLlaeth hir oes", excess: "Ffa pob\nPasta" });

    const html = await body("/cy/needs/at/salisbury/");

    expect(html).toContain("Cawl tun<br>Llaeth hir oes");
    // The English list is gone from the VISIBLE page. It is deliberately not
    // gone from the page altogether -- schema_org_str still seeks "Tinned
    // soup", which the JSON-LD section below pins on purpose -- so the
    // negative has to name the rendered form of it.
    expect(html).not.toContain("Tinned soup<br>");
    // Blank-line stripping applies to the translated text too.
    expect(html).not.toContain("<br><br>");
    expect(html).toContain("<p>Nid oes angen mwy arnynt Ffa pob, Pasta.</p>");
  });

  // The translation is keyed on (language, need_id), so a cy row must not
  // reach the Irish page -- which falls back to the raw English column, not
  // to the other translation.
  it("falls back to English for a locale with no translation row", async () => {
    seedTranslation({ id: 1, needId: 101, language: "cy", changeText: "Cawl tun" });

    const ga = await body("/ga/needs/at/salisbury/");
    expect(ga).toContain("Tinned soup");
    expect(ga).not.toContain("Cawl tun");
  });

  // A NULL change_text on a real translation row is not a translation. Django's
  // get_text() falls back on falsiness (`if translated_text:`), not on row
  // existence, so a row that only translated the excess list must still show
  // the English need list.
  it("falls back to English when the row exists but the column is NULL", async () => {
    seedTranslation({ id: 1, needId: 101, language: "cy", changeText: null, excess: "Ffa pob" });

    const html = await body("/cy/needs/at/salisbury/");
    expect(html).toContain("Tinned soup");
    expect(html).toContain("Ffa pob.");
  });

  // PLAN.md §6.11 item H, pinned as the current behaviour. The translation
  // pipeline translates SENTINEL needs too (needs.py's sentinel branch is
  // unconditionally overwritten by the language check that follows it), so a
  // translated "Unknown" is a real production row. Here the OUTER gate reads
  // the raw "Unknown" and takes the contacts branch, so the translated
  // sentinel never reaches need_text.njk's literal comparison at all -- the
  // Welsh page looks exactly like the English one.
  it("keeps the sentinel branch even when the sentinel itself has been translated", async () => {
    seedTranslation({ id: 1, needId: 102, language: "cy", changeText: "Anhysbys" });

    const html = await body("/cy/needs/at/bath/");
    expect(html).toContain('<div class="contacts">');
    expect(html).not.toContain("Anhysbys");
    expect(html).not.toContain("is currently requesting");
  });

  // THE MIRROR IMAGE, and the one route by which need_text.njk's sentinel
  // strings are reachable from this page: a real need list whose TRANSLATION
  // is the literal string "Unknown". The outer gate passes (the raw text is a
  // shopping list), and the inner template then matches its own "Unknown"
  // branch and prints the "we don't know what is needed" sentence on a page
  // whose English twin lists three items. Suspect, and pinned rather than
  // worked around -- PLAN.md flags the fix as its own piece of work.
  it("SUSPECT: a translation that reads Unknown turns a real list into the unknown sentence", async () => {
    seedTranslation({ id: 1, needId: 101, language: "cy", changeText: "Unknown" });

    const html = await body("/cy/needs/at/salisbury/");
    // packages/templates/locale/cy/django.po:478-484, the msgstr for
    // need_text.njk's own "We currently don't know what is needed" branch.
    expect(html).toContain("Ar hyn o bryd dydyn ni ddim yn gwybod beth sydd ei angen yn y banc bwyd hwn.");
    // As above: still in the JSON-LD, gone from the page a donor reads.
    expect(html).not.toContain("Tinned soup<br>");
  });

  // The Welsh catalogue really is loaded and really is applied -- if it were
  // not, every assertion above would still pass on an all-English page.
  it("renders the surrounding page in Welsh, from the real .po catalogue", async () => {
    const html = await body("/cy/needs/at/salisbury/");

    expect(html).toContain('<html lang="cy" dir="ltr"');
    expect(html).toContain("Banc Bwyd Salisbury");
    expect(html).toContain('<li><a class="is-active" href="/cy/needs/at/salisbury/">Manylion</a></li>');
    expect(html).toContain("<p>Banc Bwyd Salisbury ar hyn o bryd yn gofyn i'r eitemau canlynol gael eu rhoi:</p>");
  });
});

describe("wfbnFoodbank -- has_service_area, and the counter that can hide it", () => {
  // hasServiceArea() counts locations with a non-empty boundary_geojson, and
  // the value is passed TWICE: nested under `foodbank` (maplegend.njk reads
  // `foodbank.has_service_area`, a level the top-level key never reaches) and
  // at the top level (serviceareadisclaimer.njk reads the bare name). Dropping
  // either one silently removes one of the two, and the other keeps working.
  it("adds both the map legend entry and the disclaimer when a location has a boundary", async () => {
    const html = await body("/needs/at/salisbury/");

    expect(html).toContain("Service area");
    expect(html).toContain("Service areas are approximate. You should check with the food bank");
  });

  // A food bank with locations but no boundaries: the query runs and returns
  // zero, and both pieces disappear. Seeding a location WITHOUT a boundary is
  // the point -- a `COUNT(*)` that lost its boundary_geojson predicate would
  // pass any test whose only locations have boundaries.
  it("drops both when the locations have no boundary at all", async () => {
    db.prepare("UPDATE foodbanklocation SET boundary_geojson = NULL WHERE foodbank_id = 1").run();

    const html = await body("/needs/at/salisbury/");
    expect(html).not.toContain("Service area");
    expect(html).not.toContain("Service areas are approximate");
  });

  // The empty string is not a boundary. `boundary_geojson != ''` is a
  // separate predicate from the NULL check, and D1 holds both spellings of
  // "no boundary".
  it("treats an empty-string boundary as no boundary", async () => {
    db.prepare("UPDATE foodbanklocation SET boundary_geojson = '' WHERE foodbank_id = 1").run();

    expect(await body("/needs/at/salisbury/")).not.toContain("Service area");
  });

  // THE SHORT CIRCUIT, WHICH IS PARITY AND NOT A BUG. Django's
  // has_service_area() (givefood/models/foodbank.py:296-302) returns False
  // immediately when no_locations == 0:
  //
  //     def has_service_area(self):
  //         if self.no_locations == 0:
  //             return False
  //         locations = FoodbankLocation.objects.filter(foodbank = self)...count()
  //
  // Bath's counter says zero while it owns a location WITH a boundary, so the
  // service area must stay hidden. no_locations is a denormalised column
  // maintained by the admin, so this is a reachable production state, not a
  // hypothetical -- though as of today no production row is in it (0 of 1,070
  // food banks have no_locations = 0 while owning a location), which is
  // exactly why it needs a test and not an eyeball.
  //
  // WHAT github #52 ITEM 3 CHANGED HERE, AND WHAT IT DID NOT. Before, the
  // counter also skipped the QUERY -- the guard was a `?:` in the handler. It
  // cannot be any more: no_locations is a column of the very row the batch is
  // fetching, so nothing can be decided before the batch lands, and the count
  // now always travels. The ANSWER is unchanged, and the answer is the whole
  // of the observable behaviour. Both halves are asserted: the count really is
  // sent (this test would otherwise still pass against the old code and prove
  // nothing about the new), and the page is still bare.
  it("shows no service area when no_locations is zero, even with a boundary in the table and the count in flight", async () => {
    const html = await body("/needs/at/bath/");

    expect(prepared.map((p) => p.sql)).toContain(
      "SELECT COUNT(*) AS n FROM foodbanklocation l WHERE l.foodbank_id = (SELECT id FROM foodbank WHERE slug = ?) " +
        "AND l.boundary_geojson IS NOT NULL AND l.boundary_geojson != ''",
    );
    expect(html).not.toContain("Service area");
    expect(html).not.toContain("Service areas are approximate");
  });

  // The disclaimer is additionally gated on the need branch: a sentinel page
  // has no map disclaimer even when the legend entry is there. Django's
  // index.html does the same, in the same {% if %}.
  //
  // It doubles as the non-vacuity half of the guard test above: it corrects
  // bath's counter and nothing else -- same rows, same boundary, same
  // statement -- and the legend entry appears. So "shows nothing" up there is
  // the counter's doing, not a `false` hardcoded somewhere in the new batched
  // path.
  it("keeps the legend entry but drops the disclaimer on a sentinel page", async () => {
    db.prepare("UPDATE foodbank SET no_locations = 1 WHERE id = 2").run();

    const html = await body("/needs/at/bath/");
    expect(html).toContain("Service area");
    expect(html).not.toContain("Service areas are approximate");
  });
});

describe("wfbnFoodbank -- map_config, the string the map JS parses", () => {
  // JSON.stringify of the handler's object, verbatim. `max_zoom` is an
  // INTEGER, which JSON.stringify prints without a decimal point just as
  // Python's json.dumps does -- so this string is byte-comparable with what
  // Django emitted for the same food bank.
  it("points the map at this food bank's own geojson, with no bounds when there are none", async () => {
    expect(mapConfigOf(await body("/needs/at/salisbury/"))).toBe('{"geojson":"/needs/at/salisbury/geo.json","max_zoom":14}');
  });

  // The geojson URL is locale-prefixed, because foodbank_geojson is an
  // i18n_patterns route: a Welsh page fetching /needs/at/x/geo.json would
  // work, but would defeat the preload and split the edge cache.
  it("prefixes the geojson url on a locale page", async () => {
    expect(mapConfigOf(await body("/cy/needs/at/salisbury/"))).toBe('{"geojson":"/cy/needs/at/salisbury/geo.json","max_zoom":14}');
    expect(mapConfigOf(await body("/gd/needs/at/salisbury/"))).toBe('{"geojson":"/gd/needs/at/salisbury/geo.json","max_zoom":14}');
  });

  // All four precomputed bounds, in the key order the handler writes them.
  // These come from the food bank's own service-area geometry and are what
  // stops the map opening on the whole of Great Britain.
  it("adds the precomputed bounds when they exist", async () => {
    expect(mapConfigOf(await body("/needs/at/bounded/"))).toBe(
      '{"geojson":"/needs/at/bounded/geo.json","max_zoom":14,"bounds":{"north":52.5,"south":51.5,"east":-1.5,"west":-2.5}}',
    );
  });

  // THE GATE IS bounds_north ALONE, matching gfwfbn/views.py:374's
  // `if foodbank.bounds_north is not None`. A row with three of the four set
  // gets no bounds key at all -- not a partial one, and not a crash. Pinned
  // because the alternative (checking all four, or checking any) is a
  // reasonable-looking change that alters what a real page does.
  it("emits no bounds when bounds_north alone is missing, even with the other three present", async () => {
    expect(mapConfigOf(await body("/needs/at/half-bounded/"))).toBe('{"geojson":"/needs/at/half-bounded/geo.json","max_zoom":14}');
  });

  // A zero bound is a legitimate coordinate -- the Greenwich meridian runs
  // through England, and `bounds_east: 0` is real. `!== null` is what keeps
  // it; a truthiness check would drop the whole bounds block for it.
  it("keeps a bounds block whose north is zero", async () => {
    db.prepare("UPDATE foodbank SET bounds_north = 0, bounds_south = 0, bounds_east = 0, bounds_west = 0 WHERE slug = 'bounded'").run();

    expect(mapConfigOf(await body("/needs/at/bounded/"))).toBe(
      '{"geojson":"/needs/at/bounded/geo.json","max_zoom":14,"bounds":{"north":0,"south":0,"east":0,"west":0}}',
    );
  });
});

describe("wfbnFoodbank -- coordinates, addresses and outbound links", () => {
  // latt/long are Number()s of the two halves of the lat_lng column, and the
  // column itself goes out verbatim in geo.position. Swapping the two halves
  // is the classic version of this mistake and puts the marker in the North
  // Sea; both spellings are on the page, which is what makes it assertable.
  it("splits lat_lng into the two place meta tags and emits the column verbatim", async () => {
    const html = await body("/needs/at/salisbury/");

    expect(html).toContain('<meta name="geo.position" content="51.0688,-1.7945">');
    expect(html).toContain('<meta property="place:location:latitude" content="51.0688">');
    expect(html).toContain('<meta property="place:location:longitude" content="-1.7945">');
  });

  // Foodbank.url_with_ref() MERGES ref into the existing querystring rather
  // than replacing it -- the fixture url already carries a utm_source, and
  // that must survive (unlike the donation point version, which strips
  // tracking params first). The link is printed twice on the page, in the
  // CTA and in the contacts block.
  it("adds ref=givefood.org.uk to the food bank's url without dropping its existing query", async () => {
    const html = await body("/needs/at/salisbury/");

    expect(html).toContain('<a href="https://salisburyfoodbank.org.uk/?utm_source=newsletter&amp;ref=givefood.org.uk" class="button is-info is-medium is-light" id="donate_btn">');
    expect(html).toContain('<a href="https://salisburyfoodbank.org.uk/?utm_source=newsletter&amp;ref=givefood.org.uk" class="website">');
  });

  // bankuet_url is null for a food bank with no bankuet_slug and the CTA is
  // gated on the slug, so the two must agree -- a null url behind a rendered
  // button would be an `href="undefined"` on a live donate path.
  it("offers the Bankuet button only for a food bank that has a Bankuet slug", async () => {
    expect(await body("/needs/at/salisbury/")).toContain(
      '<a href="https://www.bankuet.co.uk/salisbury/?ref=givefood.org.uk" class="button is-info is-small is-light" id="bankuet_btn">',
    );
    expect(await body("/needs/at/bath/")).not.toContain("bankuet_btn");
  });

  // The address block, the plus code link and the Directions button all read
  // straight off the row. `address` is CRLF-separated in production (1,066 of
  // 1,071 rows are) and |linebreaksbr turns that into a <br>.
  it("renders the address, the plus code and a directions link", async () => {
    const html = await body("/needs/at/salisbury/");

    expect(html).toContain("12 High Street<br>Harnham<br>");
    expect(html).toContain("SP2 8LZ<br>");
    expect(html).toContain('href="https://www.google.co.uk/maps/place/9C3W3QCJ%2B2V/"');
    expect(html).toContain('href="https://www.google.com/maps?saddr=My+Location&daddr=51.0688,-1.7945"');
  });

  // An administrative address is not a place anyone can visit, so the
  // Directions button is replaced by a heading. Django's index.html branches
  // the same way.
  it("replaces the directions button with an Administrative heading for an administrative address", async () => {
    db.prepare("UPDATE foodbank SET address_is_administrative = 1 WHERE slug = 'salisbury'").run();

    const html = await body("/needs/at/salisbury/");
    expect(html).toContain("<h3>Administrative</h3>");
    expect(html).not.toContain("directions-btn");
  });

  // A delivery address is a separate block with its own Directions button
  // pointed at delivery_lat_lng, not at lat_lng.
  it("adds a delivery block with its own coordinates when there is a delivery address", async () => {
    db.prepare("UPDATE foodbank SET delivery_address = 'Depot Road', delivery_lat_lng = '51.1,-1.8' WHERE slug = 'salisbury'").run();

    const html = await body("/needs/at/salisbury/");
    expect(html).toContain("<h3>Delivery</h3>");
    expect(html).toContain('href="https://www.google.com/maps?saddr=My+Location&daddr=51.1,-1.8"');
    expect(html).toContain("Depot Road");
  });

  // The photo is gated on place_has_photo AND NOT address_is_administrative
  // -- an administrative address's Street View photo is of a council office.
  it("shows the place photo only when there is one and the address is a real place", async () => {
    expect(await body("/needs/at/salisbury/")).toContain('<img src="/needs/at/salisbury/photo.jpg?s=540" alt="Salisbury" loading="lazy" class="placephoto">');

    db.prepare("UPDATE foodbank SET address_is_administrative = 1 WHERE slug = 'salisbury'").run();
    expect(await body("/needs/at/salisbury/")).not.toContain("placephoto");
  });
});

describe("wfbnFoodbank -- the charity, network and FSA panels", () => {
  // has_charity_details is CHARITY_DETAIL_COUNTRIES membership. England is in
  // it, so the number links to this food bank's own charity page; Jersey is
  // not, so the same number is printed as plain text. A helper that returned
  // true unconditionally would render a link to a page that 404s.
  it("links the charity number for a UK country and prints it plainly for one without a register", async () => {
    expect(await body("/needs/at/salisbury/")).toContain('<a href="/needs/at/salisbury/charity/" id="charity_link">1130237</a>');

    const jersey = await body("/needs/at/truro/");
    expect(jersey).toContain("Charity Registration NPO123");
    expect(jersey).not.toContain("charity_link");
  });

  // The same flag gates the Charity entry in the left-hand menu, which
  // additionally needs a charity_name. Both halves matter: Truro HAS a
  // charity_name and still gets no menu entry, because its country has no
  // register page to send anyone to.
  it("hides the Charity menu entry for a country outside the register list", async () => {
    expect(await body("/needs/at/salisbury/")).toContain('href="/needs/at/salisbury/charity/">Charity</a>');
    expect(await body("/needs/at/truro/")).not.toContain(">Charity</a>");
  });

  // network_url() returns the network's own site for Trussell and IFAN and
  // `false` for everything else. The "Part of" line is separately suppressed
  // for "Independent" -- so an independent food bank with a charity number
  // shows the number and nothing else.
  it("links the network for a member and says nothing for an independent", async () => {
    expect(await body("/needs/at/salisbury/")).toContain('Part of\n                <a href="https://www.trussell.org.uk/?ref=givefood.org.uk">Trussell</a>');
    expect(await body("/needs/at/bath/")).toContain('<a href="https://www.foodaidnetwork.org.uk/?ref=givefood.org.uk">IFAN</a>');

    const independent = await body("/needs/at/truro/");
    expect(independent).not.toContain("Part of");
    expect(independent).not.toContain("?ref=givefood.org.uk\">Independent");
  });

  // charitynetwork.njk's own Salvation Army branch, and the reason its header
  // comment exists: `not X == Y` parses differently in Nunjucks than in
  // Django, and the un-parenthesised version sent EVERY food bank down this
  // branch. So the positive case and the negative case are both asserted --
  // the negative one is the regression that actually happened.
  it("gives the Salvation Army its own hardcoded registration block and nobody else", async () => {
    const sa = await body("/needs/at/salvation-army/");
    expect(sa).toContain("<p>Salvation Army is a registered charity in England &amp; Wales");
    expect(sa).toContain("charity-details/214779/charity-overview");

    // Not a bare "is a registered charity" search: the site FOOTER carries
    // Give Food's own registration on every page, so the negative has to name
    // the Salvation Army block specifically or it can never fail.
    expect(await body("/needs/at/salisbury/")).not.toContain("<p>Salvation Army is a registered charity");
  });

  // The FSA hygiene-rating badge, and its Welsh flag -- data-welsh is driven
  // by language_code, so it is the one attribute on this page that changes
  // with the locale without any text changing.
  it("embeds the FSA badge with the food bank's business id, in Welsh on the Welsh page", async () => {
    expect(await body("/needs/at/salisbury/")).toContain('data-business-id="654321" data-rating-style="3" data-welsh="false"');
    expect(await body("/cy/needs/at/salisbury/")).toContain('data-welsh="true"');
    expect(await body("/needs/at/bath/")).not.toContain("fsarating");
  });

  // Both panels are inside the sentinel branch as well as the list branch --
  // index.njk includes them twice, in different columns. A sentinel page must
  // still show the charity registration, which is often the only verifiable
  // thing on it.
  it("shows the charity panel on a sentinel page too", async () => {
    expect(await body("/needs/at/bath/")).toContain("Charity Registration");
  });
});

describe("wfbnFoodbank -- the subscribe box and the two query parameters", () => {
  // The only user input this page takes. Django sets all three template vars
  // ONLY inside `if request.GET.get("turnstilefail")` (gfwfbn/views.py:389-392),
  // and the port reproduces the flag and the autofocus that way.
  it("shows the failure notice and autofocuses the box when turnstilefail is set", async () => {
    const html = await body("/needs/at/salisbury/?turnstilefail=true&email=donor%40example.org");

    expect(html).toContain("Sorry, the security check failed. Please try again.");
    expect(html).toContain('value="donor@example.org"');
    expect(html).toContain(" autofocus>");
  });

  // An EMPTY turnstilefail is falsy in Python and falsy here: `?turnstilefail=`
  // must not put a scary red notice on an ordinary page arrived at from a
  // stale link.
  it("treats an empty turnstilefail as absent", async () => {
    const html = await body("/needs/at/salisbury/?turnstilefail=");

    expect(html).not.toContain("Sorry, the security check failed");
    expect(html).not.toContain(" autofocus>");
  });

  // SUSPECT, PINNED. `email` is read UNCONDITIONALLY here, where Django only
  // populates it inside the turnstilefail branch. So /needs/at/x/?email=...
  // renders an attacker-chosen address into the subscribe form on a page that
  // pageCacheControl then stamps `public, s-maxage=86400` -- so a link can be
  // sent that shows a stranger's address pre-filled in a form whose submit
  // button subscribes it, and the edge may then hold that page. (Whether the
  // ?email= variant gets its own edge object depends on this zone's cache-key
  // configuration, which is not something this repo can settle -- so the
  // claim here stops at "it is marked shareable", which the assertion below
  // proves.) Autoescaping holds, so this is a phishing-shaped nuisance rather
  // than an injection. Asserted as-is because the fix is one line in the
  // source and this file may not touch it.
  it("SUSPECT: echoes ?email= into the form even without turnstilefail, unlike Django", async () => {
    const res = await get("/needs/at/salisbury/?email=someone%40example.org");
    const html = await res.text();

    expect(html).toContain('value="someone@example.org"');
    expect(html).not.toContain("Sorry, the security check failed");
    // And it is stamped shareable, which is the half that makes the echo
    // worth writing down rather than shrugging at.
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");

    // The escaping half, on the same path.
    const hostile = await body('/needs/at/salisbury/?turnstilefail=1&email=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E');
    expect(hostile).not.toContain("<script>alert(1)</script>");
    expect(hostile).toContain('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
  });

  // The subscribe form posts to /human/ with the real target URL in a hidden
  // field, and the WhatsApp deep link carries the slug. Both are built from
  // the food bank's own slug, so a wrong one subscribes a donor to a
  // different food bank's list -- with no visible symptom until the first
  // email arrives.
  it("wires the subscribe form and the WhatsApp link to this food bank", async () => {
    const html = await body("/needs/at/salisbury/");

    expect(html).toContain('<input type="hidden" name="target" value="/needs/at/salisbury/updates/subscribe/">');
    expect(html).toContain('href="https://wa.me/442039206758?text=subscribe%20salisbury"');
    expect(html).toContain("initWebPush('salisbury', '/needs/webpush/config/');");
  });

  // The hit beacon at the bottom of every food bank page: it is what feeds
  // foodbankhit, which the homepage's "most viewed this week" panel ranks on.
  // A wrong slug here silently attributes one food bank's traffic to another.
  it("fires the hit beacon at this food bank's own endpoint", async () => {
    expect(await body("/needs/at/salisbury/")).toContain('fetch("/needs/at/salisbury/hit/", {method: "POST", keepalive: true});');
  });
});

describe("wfbnFoodbank -- the JSON-LD block", () => {
  // schema_org_str is `|safe`, so what is in the <script> is a real JSON
  // document rather than an escaped one -- asserted by parsing it. The
  // identity fields are what a search engine keys a knowledge panel on.
  it("emits parseable JSON-LD naming this food bank and its own canonical url", async () => {
    const schema = await schemaOrg("/needs/at/salisbury/");

    expect(schema["@context"]).toBe("https://schema.org");
    expect(schema["@type"]).toBe("NGO");
    expect(schema["@id"]).toBe("https://www.givefood.org.uk/needs/at/salisbury/");
    expect(schema.name).toBe("Salisbury Foodbank");
    expect(schema.email).toBe("info@salisbury.invalid");
    expect(schema.identifier).toBe("1130237");
    expect(schema.areaServed).toEqual({ "@type": "AdministrativeArea", name: "Salisbury" });
  });

  // `seeks` is one Demand per line of the RAW change text -- and unlike the
  // visible list, it does NOT strip the blank line: buildFoodbankSchemaOrg
  // splits change_text directly rather than going through get_change_text().
  // Pinned as current behaviour: the empty Product name is what a crawler
  // actually receives today.
  it("SUSPECT: lists one Demand per raw line, blank line included", async () => {
    const schema = await schemaOrg("/needs/at/salisbury/");

    expect(schema.seeks).toEqual([
      { "@type": "Demand", itemOffered: { "@type": "Product", name: "Tinned soup" } },
      { "@type": "Demand", itemOffered: { "@type": "Product", name: "" } },
      { "@type": "Demand", itemOffered: { "@type": "Product", name: "Long life milk" } },
      { "@type": "Demand", itemOffered: { "@type": "Product", name: "Nappies (size 5)" } },
    ]);
  });

  // The three sentinels seek nothing, and the key is omitted rather than sent
  // empty. A food bank with no need row at all is treated as "Nothing" by
  // buildFoodbankSchemaOrg's own default -- which is NOT how the page above
  // treats it (it prints an empty shopping list), so these two readings of
  // the same missing row genuinely differ.
  it("omits seeks for a sentinel and for a food bank with no need row", async () => {
    expect(await schemaOrg("/needs/at/bath/")).not.toHaveProperty("seeks");
    expect(await schemaOrg("/needs/at/truro/")).not.toHaveProperty("seeks");
    expect(await schemaOrg("/needs/at/no-need-town/")).not.toHaveProperty("seeks");
  });

  // The name follows the LOCALE, because the handler passes its own
  // locale-aware fullName in -- but `seeks` does not, because schemaOrgStr
  // reads the raw English column. So the Welsh page advertises a Welsh
  // organisation name seeking English groceries. Pinned as-is: Django's
  // schema_org() reads self.latest_need.change_text the same way, so this is
  // ported behaviour rather than a port defect.
  it("translates the organisation name but not the items it seeks", async () => {
    seedTranslation({ id: 1, needId: 101, language: "cy", changeText: "Cawl tun" });

    const schema = await schemaOrg("/cy/needs/at/salisbury/");
    expect(schema.name).toBe("Banc Bwyd Salisbury");
    expect(schema.seeks).toContainEqual({ "@type": "Demand", itemOffered: { "@type": "Product", name: "Tinned soup" } });
  });

  // sameAs is the crawler's identity graph: the food bank's own site, its
  // uuid permalink on this site, its Google Maps place, its charity register
  // entry, its FSA rating and its Facebook page -- in that order.
  it("builds the sameAs list from every external identifier the row carries", async () => {
    const schema = await schemaOrg("/needs/at/salisbury/");

    expect(schema.sameAs).toEqual([
      "https://salisburyfoodbank.org.uk/?utm_source=newsletter",
      "https://www.givefood.org.uk/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1/",
      "https://www.google.co.uk/maps/place/9C3W3QCJ%2B2V/",
      "https://register-of-charities.charitycommission.gov.uk/charity-details/?regid=1130237&subid=0",
      "https://ratings.food.gov.uk/business/654321",
      "https://www.facebook.com/salisburyfoodbank",
    ]);
  });

  // memberOf is the network's whole NGO block, verbatim from
  // givefood/const/general.py, and `{}` -- not null, not absent -- for
  // anything else.
  it("expands the network into its own NGO block, or an empty object", async () => {
    expect(await schemaOrg("/needs/at/salisbury/")).toMatchObject({ memberOf: { name: "Trussell", identifier: "1110522" } });
    expect(await schemaOrg("/needs/at/bath/")).toMatchObject({ memberOf: { name: "IFAN", identifier: "1180382" } });
    expect((await schemaOrg("/needs/at/truro/")).memberOf).toEqual({});
  });
});

describe("wfbnFoodbank -- the menu, the locale switcher and the alternates", () => {
  // The left-hand menu's entries are each gated on a counter or a column, and
  // every one of them links to a sibling route. Locations is hidden for a
  // food bank with none; Donation points is hidden the same way; News needs
  // an rss_url or a news_url. Details and Nearby are unconditional.
  it("shows only the sub-pages this food bank actually has", async () => {
    const salisbury = await body("/needs/at/salisbury/");
    expect(salisbury).toContain('href="/needs/at/salisbury/locations/">Locations</a>');
    expect(salisbury).toContain('href="/needs/at/salisbury/donationpoints/">Donation points</a>');
    expect(salisbury).toContain('href="/needs/at/salisbury/news/">News</a>');
    expect(salisbury).toContain('href="/needs/at/salisbury/nearby/">Nearby</a>');
    expect(salisbury).toContain('<a class="is-active" href="/needs/at/salisbury/">Details</a>');

    // bath: no_locations 0, no_donation_points NULL, no feeds. NULL is not 0,
    // so the donation points entry SURVIVES -- `{% if x != 0 %}` is true for
    // null, which is Django's behaviour for the same template expression and
    // is why no_donation_points being nullable matters.
    const bath = await body("/needs/at/bath/");
    expect(bath).not.toContain("/locations/");
    expect(bath).not.toContain(">News</a>");
    expect(bath).toContain('href="/needs/at/bath/donationpoints/">Donation points</a>');
  });

  // Every menu link, the RSS link, the API alternates and the markdown
  // alternate carry the locale prefix on a locale page, because they are all
  // built through render()'s locale-bound url() rather than a hardcoded path.
  it("prefixes every in-site link on a locale page", async () => {
    const html = await body("/cy/needs/at/salisbury/");

    expect(html).toContain('href="/cy/needs/at/salisbury/locations/"');
    expect(html).toContain('href="/cy/needs/at/salisbury/rss.xml"');
    expect(html).toContain('<link rel="canonical" href="https://www.givefood.org.uk/cy/needs/at/salisbury/">');
  });

  // The JSON/XML/YAML/markdown alternates are NOT locale-prefixed: api2 is
  // outside i18n_patterns (the JSON API has no language prefix -- see
  // packages/models' own note that its full_name port is English-only), so
  // these four must stay bare on every page.
  it("leaves the API and markdown alternates unprefixed in every locale", async () => {
    for (const path of ["/needs/at/salisbury/", "/cy/needs/at/salisbury/"]) {
      const html = await body(path);
      expect(html).toContain('<link rel="alternate" type="application/json" href="/api/2/foodbank/salisbury/">');
      expect(html).toContain('<link rel="alternate" type="application/xml" href="/api/2/foodbank/salisbury/?format=xml">');
      expect(html).toContain('<link rel="alternate" type="text/markdown" href="/md/needs/at/salisbury/">');
    }
  });

  // pageTranslatable: true gates BOTH the four hreflang alternates and the
  // whole language switcher. Passing false (or forgetting it) delists three
  // languages from search engines while the page still looks perfect. The
  // alternate URLs are built from pathAfterPrefix, so this also pins that the
  // slug survives the prefix swap.
  it("advertises all four language variants of the same food bank", async () => {
    const html = await body("/cy/needs/at/salisbury/");

    for (const [code, url] of [
      ["en", "/needs/at/salisbury/"],
      ["cy", "/cy/needs/at/salisbury/"],
      ["ga", "/ga/needs/at/salisbury/"],
      ["gd", "/gd/needs/at/salisbury/"],
    ]) {
      expect(html).toContain(`<link rel="alternate" hreflang="${code}" href="${ORIGIN}${url}">`);
    }
    expect(html).toContain('<div class="langswitcher');
  });

  // SUSPECT, PINNED. buildPageContext takes an optional `querystring`, and
  // this handler does not pass it (routes/wfbn/index.ts does). Django's
  // context_processors.py:37-47 appends request.META['QUERY_STRING'] to every
  // language URL and to flag_path, so on a ?turnstilefail= page Django's
  // language switcher preserved the failure state and this one does not --
  // switching language silently discards the typed email address the
  // turnstilefail round trip exists to preserve.
  it("SUSPECT: drops the query string from the language switcher and the flag link", async () => {
    const html = await body("/cy/needs/at/salisbury/?turnstilefail=1&email=donor%40example.org");

    expect(html).toContain(`<link rel="alternate" hreflang="en" href="${ORIGIN}/needs/at/salisbury/">`);
    expect(html).not.toContain("hreflang=\"en\" href=\"https://www.givefood.org.uk/needs/at/salisbury/?turnstilefail=1");
    expect(html).not.toContain("/flag/?url=https%3A%2F%2Fwww.givefood.org.uk%2Fcy%2Fneeds%2Fat%2Fsalisbury%2F%3Fturnstilefail");
  });

  // "en" is never a URL prefix (prefix_default_language=False in Django, and
  // resolveLanguage's PREFIXES set excludes it), so /en/needs/at/x/ is not a
  // second spelling of this page -- it is a 404, as it is in production.
  it("does not answer at /en/needs/at/<slug>/", async () => {
    expect((await get("/en/needs/at/salisbury/")).status).toBe(404);
  });

  // An unrecognised prefix is not a locale, and the path with it is not this
  // page: Django's own /de/ falls through to "no prefix => en" and then finds
  // no route.
  it("does not answer under an unsupported language prefix", async () => {
    expect((await get("/de/needs/at/salisbury/")).status).toBe(404);
    expect((await get("/pl/needs/at/salisbury/")).status).toBe(404);
  });
});
