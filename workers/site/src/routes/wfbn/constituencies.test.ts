import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";
import { constituencySlugFromPostcode, mpPhotoUrl } from "./constituencies";

// routes/wfbn/constituencies.ts -- the three constituency surfaces:
// wfbnConstituencies (/needs/in/constituencies/), wfbnConstituency
// (/needs/in/constituency/<slug>/) and wfbnMpPhotoRedirect
// (.../mp_photo_threefour.png), plus the two exported helpers
// constituencySlugFromPostcode() and mpPhotoUrl().
//
// Django source read in full at /Users/jasoncartwright/Sites/foodcharity:
// gfwfbn/views.py:1046-1097 (`constituencies`, `constituency`,
// `mp_photo_redirect`), givefood/models/political.py:38-135
// (`nearby`/`latt`/`long`/`mp_photo_url`/`schema_org`/`foodbanks`),
// givefood/utils/geo.py:452-471 (`find_parlcons`) and :508-532
// (`admin_regions_from_postcode`), givefood/models/needs.py:216-259
// (`get_text`), and both Django templates
// (gfwfbn/templates/wfbn/constituency/{index,constituency}.html).
//
// WHY THESE PAGES ARE WORTH THIS MUCH TEST. 650 rows, one page each, and
// every way of getting one wrong renders a 200 that looks completely
// healthy:
//
//   * the food bank list is TWO concatenated queries (the constituency's own
//     open food banks, then the open LOCATIONS sitting in it) and a location's
//     parent can live in a DIFFERENT constituency -- so the parent set is a
//     union, not a subset. Drop the union and every such location silently
//     renders a blank "what they need" cell instead of the parent's need list;
//   * neither sub-list is sorted, deliberately (frozen bug B3). A fixture
//     seeded in alphabetical order cannot tell "not sorted" from "sorted";
//   * the need text is locale-aware through a SEPARATE table, and the
//     Unknown/Facebook branches in the template compare the ALREADY-TRANSLATED
//     string -- so a Welsh translation of the literal word "Unknown" changes
//     which branch of the template runs, on a page that still looks fine;
//   * `nearby` is an in-memory haversine over all ~650 rows with skip_first,
//     i.e. the page's own constituency is dropped by POSITION, not by id;
//   * the postcode box does a live api.postcodes.io lookup and 302s on
//     success. Slugifying its answer wrongly 404s the visitor -- and two of
//     the real 650 names ("Ynys Môn", "Montgomeryshire and Glyndŵr") need
//     NFKD folding that @givefood/models' own slugify() does not do.
//
// So the assertions below read VALUES out of the rendered HTML -- names,
// hrefs, JSON-LD, the map config, the order of the rows -- and read the SQL
// that was actually issued. Never just a status code.
//
// REAL EVERYTHING, the same harness as routes/public/country.test.ts and
// routes/human.test.ts: the real production app (workers/site/src/index.ts's
// default export), so the route patterns, the four locale registrations and
// the whole middleware chain (serverTiming, securityHeaders, cacheTag,
// runtimeIdentity, slugRedirect, resolveLanguage, geoJsonPreload,
// pageCacheControl) are the genuine articles; the real Nunjucks templates
// and the real .po catalogues; and real in-memory SQLite built by
// schemaFor() from the real migrations -- which matters here because
// getFoodbanksForConstituency reads the `foodbanklocation_full` VIEW and
// getNeedsByIds reads `foodbankchange_full`, and a hand-written fixture
// schema without them fails with "no such table" somewhere unrelated.
//
// MOCKED: only `fetch`, which is the leg that leaves the machine
// (api.postcodes.io), and the two KV namespaces, which have no local double.
//
// MUTATION TESTED, not assumed. The repo was copied OUTSIDE the tree and
// routes/wfbn/constituencies.ts broken one edit at a time in the COPY:
// 57 mutants, all 57 now caught. Among them: dropping either 404 guard (or
// answering the 404 with an empty body instead of the real page), losing the
// locale on the postcode redirect, 302 -> 301 on either redirect, dropping
// the redirect entirely, removing or re-keying the country grouping, sorting
// by name instead of country, `||` -> `??` on the 2024-boundary preference,
// swapping that preference order, dropping the response.ok guard, dropping
// `?decache=true` or the percent-encoding, removing the NFKD fold, adding
// Django's outer-hyphen strip, narrowing the slug's allowed-character class,
// building the parent-id list from rawFoodbanks alone, SORTING either
// sub-list, skipFirst -> false, quantity 5 -> 10, swapping lat/lng at either
// end, max_zoom 14 -> 12, un-prefixing the geojson URL, 2024-mp -> 2019-mp,
// querying the translations table in English, ignoring the translation
// entirely, reading excess_change_text instead of change_text, "" -> "Nothing"
// for a missing need, dropping either location contact fallback or the
// parent's facebook_page, mislabelling a location as an organisation,
// swapping the location URL's two arguments, guessing the parent slug from
// its name, dropping the locations from the JSON-LD, using the bare name
// instead of the locale-aware full name, week -> day and bare -> `public` on
// the Cache-Control, dropping that header, hardcoding either page's
// render_time_ms, passing c.req.path where unprefixedPath is wanted,
// withholding `locale` from either render(), reading the vestigial
// latitude/longitude COLUMNS instead of the centroid, enable_write -> false,
// dropping the need-id dedup, and reversing the nearby ranking.
//
// TWO SURVIVED THE FIRST ROUND and shaped the file: hardcoding the DETAIL
// page's render_time_ms (the index page's timer was asserted, the detail
// page's was not), and dropping the `new Set` around the need ids (no two
// fixture food banks shared a latest need, so the deduplicated and
// non-deduplicated lists were identical). Both now have a test of their own.

const ORIGIN = "https://www.givefood.org.uk";

type Bindable = null | number | bigint | string | Uint8Array;

// One statement as it reached the engine: the SQL text AND the values bound
// to it. Both halves are load-bearing here -- the locale gate on the
// translations lookup is invisible in the SQL text (the query simply is not
// issued at all for English), and the id list handed to the batched
// WHERE-IN is only visible in the bindings.
interface Prepared {
  sql: string;
  params: Bindable[];
}

// The slice of the D1 Sessions API packages/db uses, over node:sqlite --
// routes/public/country.test.ts's shim plus `batch`, which
// getFoodbanksForConstituency needs (it sends its two independent SELECTs in
// one round trip). batch() runs its statements IN ORDER and returns one
// result per input in that order, which is the contract packages/db indexes
// straight into; deliberately dumb otherwise -- it never inspects or
// rewrites SQL, it hands each statement to real SQLite.
//
// `roundTrips` counts WAITS, not statements: a batch of two is one wait.
// That is the only way to see the optimisation the module's own comments
// claim (two queries in one trip, one batched WHERE-IN instead of an N+1),
// and a statement count cannot.
function d1Session(db: DatabaseSync, prepared: Prepared[], roundTrips: string[][]): D1DatabaseSession {
  const statement = (sql: string, entry: Prepared) => ({
    sql,
    get params(): Bindable[] {
      return entry.params;
    },
    bind: (...next: unknown[]) => {
      entry.params = next as Bindable[];
      return statement(sql, entry);
    },
    first: async <T>() => {
      roundTrips.push([sql]);
      return (db.prepare(sql).get(...entry.params) as T | undefined) ?? null;
    },
    all: async () => {
      roundTrips.push([sql]);
      return { results: db.prepare(sql).all(...entry.params), success: true, meta: {} };
    },
    run: async () => {
      roundTrips.push([sql]);
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
      roundTrips.push(statements.map((s) => s.sql));
      return statements.map((s) => ({ results: db.prepare(s.sql).all(...s.params), success: true, meta: {} }));
    },
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let prepared: Prepared[];
let roundTrips: string[][];

function env(): AppEnv["Bindings"] {
  return {
    DB: { withSession: () => d1Session(db, prepared, roundTrips) },
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: { get: async () => null, put: async () => {}, delete: async () => {} },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    D1_DATABASE_NAME: "givefood-test",
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

const get = async (path: string): Promise<Response> => app.fetch(new Request(`${ORIGIN}${path}`), env(), execCtx);
const body = async (path: string): Promise<string> => (await get(path)).text();

// ===========================================================================
// SEEDS
// ===========================================================================

// Django's own timestamp spelling (0022_normalise_timestamps.sql): space
// separator, six fractional digits, no offset. These columns are TEXT and
// compared lexicographically, so a toISOString() would sort wrongly against
// real rows even though nothing in THIS module orders by one.
const CREATED = "2026-09-05 19:28:08.853000";

const uuidFor = (prefix: string, id: number): string => (prefix + String(id).padStart(31, "0")).slice(0, 32);

interface ConstituencySeed {
  id: number;
  name: string | null;
  slug: string;
  country: string | null;
  centroid: string;
  mp?: string;
  mpParty?: string;
  mpParlId?: number;
}

function seedConstituency(s: ConstituencySeed): void {
  db.prepare(
    `INSERT INTO parliamentaryconstituency
       (id, name, slug, country, mp, mp_party, mp_parl_id, mp_display_name, email, centroid,
        latitude, longitude, boundary_geojson, pcon24cd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
  ).run(
    s.id,
    s.name,
    s.slug,
    s.country,
    s.mp ?? `MP for ${s.slug}`,
    s.mpParty ?? "Labour",
    s.mpParlId ?? 5000 + s.id,
    `The Rt Hon MP for ${s.slug}`,
    `${s.slug}@parliament.invalid`,
    s.centroid,
    `E1400${s.id}`,
  );
}

interface FoodbankSeed {
  id: number;
  name: string;
  slug: string;
  constituencyId: number | null;
  isClosed?: 0 | 1;
  latestNeedId?: number | null;
  phone?: string | null;
  email?: string;
  facebook?: string | null;
  altName?: string | null;
  latLng?: string;
}

// `name` is stored BARE ("Wilton"); Foodbank.full_name() is what appends
// " Foodbank". The distinction is load-bearing on this page: the food-bank
// table prints the raw `name`, while the JSON-LD prints the locale-aware
// full name (fullNameLocaleAware -- "Banc Bwyd Wilton" in Welsh).
function seedFoodbank(s: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank
       (id, uuid, name, alt_name, slug, address, postcode, country, lat_lng, latitude, longitude,
        network, charity_number, facebook_page, contact_email, phone_number, url, shopping_list_url,
        parliamentary_constituency_id, parliamentary_constituency_name, parliamentary_constituency_slug,
        district, charity_just_foodbank, address_is_administrative, is_closed, no_locations,
        days_between_needs, latest_need_id, created, modified)
     VALUES (?, ?, ?, ?, ?, ?, 'SP1 1AA', 'England', ?, NULL, NULL,
        'Trussell', '1110522', ?, ?, ?, ?, ?,
        ?, 'Salisbury', 'salisbury',
        'Salisbury District', 0, 0, ?, 0,
        14, ?, ?, ?)`,
  ).run(
    s.id,
    uuidFor("f", s.id),
    s.name,
    s.altName ?? null,
    s.slug,
    `${s.id} High Street`,
    s.latLng ?? "51.0688,-1.7945",
    s.facebook ?? null,
    s.email ?? `info@${s.slug}.invalid`,
    s.phone ?? null,
    `https://${s.slug}.invalid/`,
    `https://${s.slug}.invalid/list/`,
    s.constituencyId,
    s.isClosed ?? 0,
    s.latestNeedId ?? null,
    CREATED,
    CREATED,
  );
}

interface LocationSeed {
  id: number;
  foodbankId: number;
  name: string;
  slug: string;
  constituencyId: number | null;
  isClosed?: 0 | 1;
  phone?: string | null;
  email?: string | null;
  latLng?: string;
}

function seedLocation(s: LocationSeed): void {
  db.prepare(
    `INSERT INTO foodbanklocation
       (id, uuid, foodbank_id, name, slug, address, postcode, country, lat_lng, latitude, longitude,
        district, parliamentary_constituency_id, parliamentary_constituency_name,
        parliamentary_constituency_slug, is_closed, is_donation_point, is_mobile,
        phone_number, email, modified)
     VALUES (?, ?, ?, ?, ?, ?, 'SP2 2BB', 'England', ?, NULL, NULL,
        'Salisbury District', ?, 'Salisbury',
        'salisbury', ?, 0, 0,
        ?, ?, ?)`,
  ).run(
    s.id,
    uuidFor("l", s.id),
    s.foodbankId,
    s.name,
    s.slug,
    `${s.id} Low Street`,
    s.latLng ?? "51.07,-1.80",
    s.constituencyId,
    s.isClosed ?? 0,
    s.phone ?? null,
    s.email ?? null,
    CREATED,
  );
}

function seedNeed(o: { id: number; foodbankId: number; text: string }): void {
  db.prepare(
    `INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, published, input_method, created, modified)
     VALUES (?, ?, ?, ?, 1, 'scrape', ?, ?)`,
  ).run(o.id, uuidFor("n", o.id), o.foodbankId, o.text, CREATED, CREATED);
}

function seedTranslation(o: { id: number; needId: number; foodbankId: number; language: string; changeText: string }): void {
  db.prepare(
    "INSERT INTO foodbankchangetranslation (id, need_id, foodbank_id, language, change_text, excess_change_text) VALUES (?, ?, ?, ?, ?, NULL)",
  ).run(o.id, o.needId, o.foodbankId, o.language, o.changeText);
}

// ---------------------------------------------------------------------------
// THE FIXTURE IS THE TEST: every row turns exactly one rule on or off
// relative to its neighbour, and the rows that must be EXCLUDED are seeded
// first-class so a filter that does nothing cannot pass.
//
// Constituencies -- 41 is the subject of every detail-page test. The five
// nearest to it are chosen so the haversine ranking is unambiguous (18.2 km,
// 22.4 km, 25.2 km, 26.6 km, 31.4 km, then a 292 km gap to Chorley), and the
// far ones exist to be excluded from `nearby` and to give the index page a
// group per country:
//
//   41 Salisbury                              England  <- the subject
//   42 South West Wiltshire                   England  18.2 km
//   43 Romsey and Southampton North           England  22.4 km
//   44 New Forest West                        England  25.2 km
//   45 Andover and Mid Hampshire              England  26.6 km  (parent of fb 8)
//   46 East Wiltshire                         England  31.4 km  (holds the excluded rows)
//   47 Middlesbrough South and East Cleveland England  the collation pair
//   48 Middlesbrough and Thornaby East        England  ...
//   49 Chorley                                England  mp_party "Speaker"
//   50 Ynys Môn                               Wales    the NFKD slug case
//   51 Glasgow North                          Scotland
//   52 Belfast East                           Northern Ireland
//   53 Unassigned Area                        NULL     the null-country group
//
// Food banks -- five OPEN ones in 41, seeded in an order that is NOT
// alphabetical (Wilton first) so "the list is deliberately unsorted" is
// testable, plus one closed, one in another constituency, and one in
// Andover that only reaches this page as a location's parent:
//
//   1 Wilton         41  need 100 "Beans\nPasta\n\nRice"  (blank line stripped)
//   2 Alderbury      41  need 101 "Unknown"               phone + email set
//   3 Bemerton       41  need 102 "Facebook"              facebook_page set
//   4 Coombe Bissett 41  need 103 "Nothing"
//   5 Downton        41  NO latest need                   -> blank cell, not "Nothing"
//   6 Zed Closed     41  need 104, is_closed = 1          -> excluded, but IS a parent
//   7 Devizes        46  need 105                         -> excluded (other constituency)
//   8 Andover Mission 45 need 106                         -> parent of location 12
//
// Locations in 41 -- again seeded unsorted, and covering all four parent
// states (same-constituency, other-constituency, CLOSED, and missing):
//
//   11 Wilton Centre        parent 1   own phone + email
//   12 Andover Outreach     parent 8   no phone/email -> parent's, via the view
//   13 Closed Parent Centre parent 6   parent is is_closed = 1
//   14 Orphan Centre        parent 999 no such food bank at all
//   15 Shut Centre          parent 1   is_closed = 1        -> excluded
//   16 Devizes Centre       parent 7   in constituency 46   -> excluded
// ---------------------------------------------------------------------------
function seed(): void {
  seedConstituency({ id: 41, name: "Salisbury", slug: "salisbury", country: "England", centroid: "51.0688,-1.7945", mp: "John Glen", mpParty: "Conservative", mpParlId: 4051 });
  seedConstituency({ id: 42, name: "South West Wiltshire", slug: "south-west-wiltshire", country: "England", centroid: "51.10,-2.05" });
  seedConstituency({ id: 43, name: "Romsey and Southampton North", slug: "romsey-and-southampton-north", country: "England", centroid: "50.99,-1.50" });
  seedConstituency({ id: 44, name: "New Forest West", slug: "new-forest-west", country: "England", centroid: "50.85,-1.70" });
  seedConstituency({ id: 45, name: "Andover and Mid Hampshire", slug: "andover-and-mid-hampshire", country: "England", centroid: "51.2113,-1.4871" });
  seedConstituency({ id: 46, name: "East Wiltshire", slug: "east-wiltshire", country: "England", centroid: "51.35,-1.75" });
  seedConstituency({ id: 47, name: "Middlesbrough South and East Cleveland", slug: "middlesbrough-south-and-east-cleveland", country: "England", centroid: "54.52,-1.15" });
  seedConstituency({ id: 48, name: "Middlesbrough and Thornaby East", slug: "middlesbrough-and-thornaby-east", country: "England", centroid: "54.57,-1.23" });
  seedConstituency({ id: 49, name: "Chorley", slug: "chorley", country: "England", centroid: "53.65,-2.63", mp: "Lindsay Hoyle", mpParty: "Speaker", mpParlId: 467 });
  seedConstituency({ id: 50, name: "Ynys Môn", slug: "ynys-mon", country: "Wales", centroid: "53.28,-4.35" });
  seedConstituency({ id: 51, name: "Glasgow North", slug: "glasgow-north", country: "Scotland", centroid: "55.87,-4.27" });
  seedConstituency({ id: 52, name: "Belfast East", slug: "belfast-east", country: "Northern Ireland", centroid: "54.60,-5.85" });
  seedConstituency({ id: 53, name: "Unassigned Area", slug: "unassigned-area", country: null, centroid: "0,0" });

  seedFoodbank({ id: 1, name: "Wilton", slug: "wilton", constituencyId: 41, latestNeedId: 100, altName: "Banc Bwyd Wilton", facebook: "wiltonfoodbank", phone: "01722111111", latLng: "51.0800,-1.8600" });
  seedFoodbank({ id: 2, name: "Alderbury", slug: "alderbury", constituencyId: 41, latestNeedId: 101, phone: "01722222222", email: "help@alderbury.invalid" });
  seedFoodbank({ id: 3, name: "Bemerton", slug: "bemerton", constituencyId: 41, latestNeedId: 102, facebook: "bemertonheath" });
  seedFoodbank({ id: 4, name: "Coombe Bissett", slug: "coombe-bissett", constituencyId: 41, latestNeedId: 103 });
  seedFoodbank({ id: 5, name: "Downton", slug: "downton", constituencyId: 41, latestNeedId: null });
  seedFoodbank({ id: 6, name: "Zed Closed", slug: "zed-closed", constituencyId: 41, latestNeedId: 104, isClosed: 1, facebook: "zedclosedfb" });
  seedFoodbank({ id: 7, name: "Devizes", slug: "devizes", constituencyId: 46, latestNeedId: 105 });
  // slug deliberately != slugify(name) -- see the "Part of" test.
  seedFoodbank({ id: 8, name: "Andover Mission", slug: "andover-mission-town", constituencyId: 45, latestNeedId: 106, phone: "01264888888", email: "hello@andover.invalid", facebook: "andovermission" });

  seedNeed({ id: 100, foodbankId: 1, text: "Beans\nPasta\n\nRice" });
  seedNeed({ id: 101, foodbankId: 2, text: "Unknown" });
  seedNeed({ id: 102, foodbankId: 3, text: "Facebook" });
  seedNeed({ id: 103, foodbankId: 4, text: "Nothing" });
  seedNeed({ id: 104, foodbankId: 6, text: "Nappies" });
  seedNeed({ id: 105, foodbankId: 7, text: "Sugar" });
  seedNeed({ id: 106, foodbankId: 8, text: "Tea\nCoffee" });

  seedLocation({ id: 11, foodbankId: 1, name: "Wilton Centre", slug: "wilton-centre", constituencyId: 41, phone: "01722999111", email: "centre@wilton.invalid" });
  seedLocation({ id: 12, foodbankId: 8, name: "Andover Outreach", slug: "andover-outreach", constituencyId: 41 });
  seedLocation({ id: 13, foodbankId: 6, name: "Closed Parent Centre", slug: "closed-parent-centre", constituencyId: 41 });
  seedLocation({ id: 14, foodbankId: 999, name: "Orphan Centre", slug: "orphan-centre", constituencyId: 41 });
  seedLocation({ id: 15, foodbankId: 1, name: "Shut Centre", slug: "shut-centre", constituencyId: 41, isClosed: 1 });
  seedLocation({ id: 16, foodbankId: 7, name: "Devizes Centre", slug: "devizes-centre", constituencyId: 46 });

  // cy only. English never queries this table at all (needs.py:216-259's
  // `current_language == "en"` branch), which is asserted directly below.
  seedTranslation({ id: 1, needId: 100, foodbankId: 1, language: "cy", changeText: "Ffa\nPasta\n\nReis" });
  // A translation of the literal sentinel "Unknown". Real: translate_need()
  // (givefood/utils/general.py:203-221) translates change_text
  // unconditionally, sentinels included. See the test that reads this.
  seedTranslation({ id: 2, needId: 101, foodbankId: 2, language: "cy", changeText: "Anhysbys" });
  // ga is seeded for need 100 with a DIFFERENT string so "the language
  // binding is passed through" is separable from "some translation was found".
  seedTranslation({ id: 3, needId: 100, foodbankId: 1, language: "ga", changeText: "Pónairí" });
}

const SCHEMA_OBJECTS = [
  "parliamentaryconstituency",
  "foodbank",
  "foodbankchange",
  "foodbankchange_full",
  "foodbanklocation",
  "foodbanklocation_full",
  "foodbankchangetranslation",
];

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(schemaFor(...SCHEMA_OBJECTS));
  seed();
  prepared = [];
  roundTrips = [];
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Reading the rendered page.
// ---------------------------------------------------------------------------

function anchors(html: string): Array<{ href: string; text: string }> {
  return [...html.matchAll(/<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({ href: m[1] as string, text: (m[2] as string).trim() }));
}

/** The index page's <details> groups, in document order, as country -> constituency names. */
function countryGroups(html: string): Array<{ country: string; names: string[] }> {
  return [...html.matchAll(/<details>[\s\S]*?<summary class="is-size-6">([^<]*)<\/summary>([\s\S]*?)<\/details>/g)].map((m) => ({
    country: m[1] as string,
    names: anchors(m[2] as string).map((a) => a.text),
  }));
}

/** The detail page's food-bank table, one entry per <tr>, cells trimmed of whitespace runs. */
function rows(html: string): Array<{ name: string; href: string; needCell: string }> {
  const table = html.slice(html.indexOf('<table class="table is-narrow is-fullwidth">'), html.indexOf("</table>"));
  return [...table.matchAll(/<tr>\s*<td class="foodbank_name">([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/g)].map((m) => {
    const nameCell = m[1] as string;
    const first = anchors(nameCell)[0];
    return {
      name: first?.text ?? "",
      href: first?.href ?? "",
      needCell: (m[2] as string).replace(/\s+/g, " ").trim(),
    };
  });
}

/** The "Nearby Constituencies" list, in rank order. */
function nearbyNames(html: string): string[] {
  const start = html.indexOf("Nearby Constituencies</h2>");
  return anchors(html.slice(start, html.indexOf("</ul>", start))).map((a) => a.text);
}

/** The page's own JSON-LD block (the second one -- the first is page.njk's site-wide NGO). */
function constituencyJsonLd(html: string): Record<string, unknown> {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => (m[1] as string).trim());
  const area = blocks.find((b) => b.includes('"AdministrativeArea"'));
  if (!area) throw new Error("no AdministrativeArea JSON-LD block in the rendered page");
  return JSON.parse(area) as Record<string, unknown>;
}

// ===========================================================================
// mpPhotoUrl -- ParliamentaryConstituency.mp_photo_url(),
// givefood/models/political.py:47-48
// ===========================================================================

describe("mpPhotoUrl", () => {
  it("builds the 2024 photo-service URL from the MP's Parliament id", () => {
    // Verbatim from the Python: "https://photos.givefood.org.uk/2024-mp/%s.jpg".
    // Worth pinning as a unit even though the two handlers below both exercise
    // it: the "2024-mp" path segment is a boundary-review generation, so a
    // future 2029 review changes this string and nothing else, and this is the
    // one place that fact is written down.
    expect(mpPhotoUrl(4051)).toBe("https://photos.givefood.org.uk/2024-mp/4051.jpg");
  });

  it("interpolates whatever number it is given, including 0 -- no guard, as in Python", () => {
    // mp_parl_id is NOT NULL in the schema but is not validated anywhere, and
    // Python's %s would print 0 too. Pinned so "add a fallback photo for a
    // missing id" is a visible behaviour change rather than a tidy-up.
    expect(mpPhotoUrl(0)).toBe("https://photos.givefood.org.uk/2024-mp/0.jpg");
  });
});

// ===========================================================================
// constituencySlugFromPostcode -- admin_regions_from_postcode(),
// givefood/utils/geo.py:508-532, plus the module's private slugify
// ===========================================================================

describe("constituencySlugFromPostcode", () => {
  /** Stub api.postcodes.io. Records every URL asked for. */
  function stubPostcodesIo(reply: { ok?: boolean; status?: number; json?: unknown }, calls: string[] = []): string[] {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      calls.push(typeof input === "string" ? input : input.toString());
      return {
        ok: reply.ok ?? true,
        status: reply.status ?? 200,
        json: async () => reply.json ?? {},
      } as unknown as Response;
    });
    return calls;
  }

  it("calls api.postcodes.io with decache=true and the postcode percent-encoded", async () => {
    // Django: "https://api.postcodes.io/postcodes/%s?decache=true" %
    // urllib.parse.quote(postcode) (geo.py:510). `decache=true` is not
    // decoration -- postcodes.io serves a cached answer without it, and a
    // freshly-changed constituency boundary is precisely what this lookup is
    // for. The space in a real postcode is the reason quote() is there at all.
    const calls = stubPostcodesIo({ json: { result: { parliamentary_constituency_2024: "Salisbury" } } });
    await constituencySlugFromPostcode("SP1 1AA");
    expect(calls).toEqual(["https://api.postcodes.io/postcodes/SP1%201AA?decache=true"]);
  });

  it("prefers the 2024 boundary name over the pre-2024 one", async () => {
    // geo.py:515-518's exact preference order. The two differ for most of the
    // country after the 2024 review, and taking the old one would send the
    // visitor to a constituency that no longer exists -- a 404, since D1 only
    // holds the 650 new ones.
    stubPostcodesIo({ json: { result: { parliamentary_constituency_2024: "East Wiltshire", parliamentary_constituency: "Devizes" } } });
    expect(await constituencySlugFromPostcode("SN10 1AA")).toBe("east-wiltshire");
  });

  it("falls back to the pre-2024 name when the 2024 field is null, absent or empty", async () => {
    // `||`, not `??`, in the port -- matching Python's `if
    // pc_api_json["result"]["parliamentary_constituency_2024"]:`, which is a
    // truthiness test. All three falsy shapes are asserted because
    // postcodes.io emits null for a postcode with no 2024 mapping and the
    // difference between `||` and `??` is one character.
    for (const value of [null, undefined, ""]) {
      stubPostcodesIo({ json: { result: { parliamentary_constituency_2024: value, parliamentary_constituency: "Devizes" } } });
      expect(await constituencySlugFromPostcode("SN10 1AA"), String(value)).toBe("devizes");
    }
  });

  it("returns null when neither field is set, and when there is no result at all", async () => {
    // The port's `json.result?...` optional chaining is a DIVERGENCE in
    // mechanism, not outcome: Django indexes with [] and would raise a
    // KeyError, which the view does not catch. Both end with the visitor on
    // the index page -- Django's 500 handler versus this null -- so the port
    // is the friendlier of the two, but it means a postcodes.io response
    // shape change fails silently here and loudly there.
    stubPostcodesIo({ json: { result: { parliamentary_constituency_2024: null, parliamentary_constituency: null } } });
    expect(await constituencySlugFromPostcode("SP1 1AA")).toBeNull();

    stubPostcodesIo({ json: { status: 404, error: "Postcode not found" } });
    expect(await constituencySlugFromPostcode("ZZ99 9ZZ")).toBeNull();
  });

  it("returns null on a non-2xx response without reading the body", async () => {
    // geo.py:531-532's `else: return {}`. postcodes.io answers an unknown
    // postcode with a 404 and a JSON error object, so the guard is on the
    // hot path, not an edge case.
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return {
        ok: false,
        status: 404,
        json: async () => {
          throw new Error("body must not be read on a non-ok response");
        },
      } as unknown as Response;
    });
    expect(await constituencySlugFromPostcode("ZZ99 9ZZ")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("accepts any 2xx, where Django accepted only 200 -- a divergence, pinned", async () => {
    // `response.ok` is 200-299; geo.py:512 is `if request.status_code == 200`.
    // On a 203 (a proxy that rewrote the body) or a 226, Django would take its
    // `else: return {}` branch and re-render the index with the
    // not-recognised notice, while this redirects on whatever the rewritten
    // body said. postcodes.io does not send those today, so it is dormant
    // rather than live -- recorded because the two spellings look identical
    // and only one of them is what was ported.
    stubPostcodesIo({ ok: true, status: 203, json: { result: { parliamentary_constituency_2024: "East Wiltshire" } } });
    expect(await constituencySlugFromPostcode("SN10 1AA")).toBe("east-wiltshire");
  });

  it("NFKD-folds accented names, which is why this does not reuse @givefood/models' slugify()", async () => {
    // THE WHOLE REASON THE PRIVATE slugify LIVES IN THIS MODULE. Two of the
    // real 650 constituency names carry combining marks, and Django's
    // slugify() decomposes then ASCII-drops them
    // (unicodedata.normalize("NFKD", value).encode("ascii", "ignore")).
    // @givefood/models' slugify() treats non-ASCII as noise to hyphenate
    // instead, so it would produce "ynys-m-n" -- a 404 for every visitor who
    // types an Anglesey postcode into the box.
    stubPostcodesIo({ json: { result: { parliamentary_constituency_2024: "Ynys Môn" } } });
    expect(await constituencySlugFromPostcode("LL77 7AA")).toBe("ynys-mon");

    stubPostcodesIo({ json: { result: { parliamentary_constituency_2024: "Montgomeryshire and Glyndŵr" } } });
    expect(await constituencySlugFromPostcode("SY16 1AA")).toBe("montgomeryshire-and-glyndwr");
  });

  it("drops apostrophes and ampersands rather than hyphenating them, as Django's slugify does", async () => {
    // The `[^a-z0-9\s-]` strip runs BEFORE the whitespace/hyphen collapse, so
    // "Bishop's" becomes "bishops", not "bishop-s". Same rule Django's real
    // slugify uses, and the reason "Cities of London and Westminster"-style
    // names round-trip cleanly.
    stubPostcodesIo({ json: { result: { parliamentary_constituency_2024: "Bishop's & Stortford" } } });
    expect(await constituencySlugFromPostcode("CM23 1AA")).toBe("bishops-stortford");
  });

  it("collapses runs of spaces and hyphens into one hyphen, and lowercases", async () => {
    // "Kingston upon Hull East" and the hyphenated Welsh names both depend on
    // this final collapse. Note what it does NOT do: no leading/trailing
    // hyphen strip (Django's slugify has one), which the next test pins.
    stubPostcodesIo({ json: { result: { parliamentary_constituency_2024: "Kingston  upon --Hull EAST" } } });
    expect(await constituencySlugFromPostcode("HU1 1AA")).toBe("kingston-upon-hull-east");
  });

  it("leaves a leading or trailing hyphen in place, unlike Django's real slugify -- pinned", async () => {
    // SUSPECT, and dormant. django.utils.text.slugify ends with
    // `re.sub(r"[-\s]+", "-", value).strip("-_")`; this port omits the strip,
    // and its own trim() runs BEFORE the punctuation strip, so it cannot
    // remove a hyphen that only becomes leading afterwards. "- Salisbury -"
    // slugs to "-salisbury-" here and "salisbury" in Django -- a URL that
    // 404s against a slug column Django populated. No real constituency name
    // has outer punctuation, so nothing is broken today; recorded because the
    // two implementations are not the same function and this is the only
    // place that says so.
    stubPostcodesIo({ json: { result: { parliamentary_constituency_2024: "- Salisbury -" } } });
    expect(await constituencySlugFromPostcode("SP1 1AA")).toBe("-salisbury-");
  });

  it("strips edge punctuation that is not a hyphen, leaving no separator behind", async () => {
    // The other half of the rule above: "(" and ")" are removed by the
    // `[^a-z0-9\s-]` strip rather than turned into separators, so a
    // parenthesised name comes back clean. Together the two tests say exactly
    // which characters survive to the edges of a slug and which do not.
    stubPostcodesIo({ json: { result: { parliamentary_constituency_2024: "(Salisbury)" } } });
    expect(await constituencySlugFromPostcode("SP1 1AA")).toBe("salisbury");
  });
});

// ===========================================================================
// wfbnConstituencies -- GET /needs/in/constituencies/
// ===========================================================================

describe("the constituencies index", () => {
  it("groups by country and orders the groups alphabetically, null country first", async () => {
    // Django: `{% regroup constituencies|dictsort:"country" by country %}`.
    // dictsort sorts by country, regroup then breaks the (now contiguous)
    // list into groups -- so group order IS country order. The port does the
    // same with a sort + Map, and Map preserves first-insertion order.
    //
    // The NULL-country row is the case a fixture of tidy data cannot see:
    // `constituency.country ?? ""` puts it in a group whose <summary> is
    // EMPTY, and "" sorts before every real country name. Django's dictsort
    // on None would raise a TypeError comparing None to str in Python 3 --
    // so this row would 500 the page there. Production has no such row; the
    // port survives one, which is a divergence in the safe direction.
    const groups = countryGroups(await body("/needs/in/constituencies/"));
    expect(groups.map((g) => g.country)).toEqual(["", "England", "Northern Ireland", "Scotland", "Wales"]);
    expect(groups[0]?.names).toEqual(["Unassigned Area"]);
    expect(groups[2]?.names).toEqual(["Belfast East"]);
    expect(groups[3]?.names).toEqual(["Glasgow North"]);
    expect(groups[4]?.names).toEqual(["Ynys Môn"]);
  });

  it("keeps the by-name order inside each group, which requires a STABLE sort by country", async () => {
    // getAllConstituenciesOrderedByName does `ORDER BY name`; the handler then
    // re-sorts by country only. If that sort were not stable -- or if it
    // compared anything but country -- the England group would come back in
    // some other order and 650 links would be unbrowsable. Asserted as the
    // whole list, not a spot check, because a partially-correct order is the
    // failure that looks fine.
    const groups = countryGroups(await body("/needs/in/constituencies/"));
    expect(groups[1]?.names).toEqual([
      "Andover and Mid Hampshire",
      "Chorley",
      "East Wiltshire",
      "Middlesbrough South and East Cleveland",
      "Middlesbrough and Thornaby East",
      "New Forest West",
      "Romsey and Southampton North",
      "Salisbury",
      "South West Wiltshire",
    ]);
  });

  it("orders names BYTE-WISE, not linguistically -- a live divergence from Django", async () => {
    // SUSPECT, pinned, and it bites on the real data. `ORDER BY name` runs in
    // SQLite's BINARY collation, so uppercase sorts before lowercase:
    // "Middlesbrough South and East Cleveland" precedes "Middlesbrough and
    // Thornaby East" ('S' = 0x53 < 'a' = 0x61). Django's Postgres sorts
    // en_US.utf8, where "and" precedes "South", giving the opposite order.
    //
    // MEASURED, not reasoned: the 650 real PCON24NM names from
    // workers/site/dist/static/static/geojson/parlcon.json were loaded into
    // node:sqlite and sorted both ways in this working tree -- 17 of the 650
    // positions differ, all of them "<Word> and ..." pairs of exactly this
    // shape. packages/db/src/types.ts already provides sortByName() (an
    // Intl.Collator) for precisely this problem, and
    // getAllConstituenciesOrderedByName does not use it.
    //
    // Consequence: on /needs/in/constituencies/ 17 links sit one or two rows
    // away from where a Django-era bookmark or screenshot puts them. Cosmetic,
    // but it is a real difference in shipped output, so it is recorded rather
    // than left to be rediscovered.
    const england = countryGroups(await body("/needs/in/constituencies/"))[1]?.names ?? [];
    expect(england.indexOf("Middlesbrough South and East Cleveland")).toBeLessThan(england.indexOf("Middlesbrough and Thornaby East"));
  });

  it("links each constituency at its own page, prefixed in a non-English locale", async () => {
    // `url('wfbn:constituency', slug)` inside the template resolves through
    // the locale-bound helper env.ts injects, and wfbn:constituency IS in
    // I18N_SCOPED -- so the Welsh index must link to /cy/... or every link on
    // it drops the visitor back into English.
    expect(await body("/needs/in/constituencies/")).toContain('<li><a href="/needs/in/constituency/ynys-mon/">Ynys Môn</a></li>');
    expect(await body("/cy/needs/in/constituencies/")).toContain('<li><a href="/cy/needs/in/constituency/ynys-mon/">Ynys Môn</a></li>');
    // The accented name reaches the page as itself, not as an entity or a
    // mojibake -- the response is UTF-8 and the .njk output is not
    // transliterated on its way through. Only the SLUG is folded.
    expect(await body("/needs/in/constituencies/")).not.toContain("Ynys M&#244;n");
  });

  it("shows no postcode notice and an empty search box when no postcode was given", async () => {
    // The notice is the template's `{% if postcode %}` branch. It must not
    // appear on the plain page -- a permanent "we didn't recognise this
    // postcode" on the bare index would be a bug visible to every visitor.
    const html = await body("/needs/in/constituencies/");
    expect(html).not.toContain("Sorry, we didn't recognise this postcode");
    expect(html).toContain('<input id="postcode_field" type="text" name="postcode" class="input" placeholder="Search by postcode" value="" autofocus');
  });

  it("302s to the resolved constituency when postcodes.io recognises the postcode", async () => {
    // views.py:1052-1057. The redirect is the entire point of the search box:
    // it is how a visitor who knows their postcode and not their constituency
    // gets to the right one of 650 pages.
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json: async () => ({ result: { parliamentary_constituency_2024: "East Wiltshire" } }) }) as unknown as Response);
    const res = await get("/needs/in/constituencies/?postcode=SN10+1AA");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/needs/in/constituency/east-wiltshire/");
  });

  it("keeps the visitor in their language when it redirects", async () => {
    // urlForLocale(), not url(). Django reverse()s inside the request, which
    // resolves under the active language and gives the same prefixed answer.
    // Getting this wrong is invisible in English and drops every Welsh,
    // Irish and Gaelic visitor into the English site at the exact moment they
    // have just used the search box.
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json: async () => ({ result: { parliamentary_constituency_2024: "East Wiltshire" } }) }) as unknown as Response);
    for (const locale of ["cy", "ga", "gd"]) {
      const res = await get(`/${locale}/needs/in/constituencies/?postcode=SN10+1AA`);
      expect(res.status, locale).toBe(302);
      expect(res.headers.get("Location"), locale).toBe(`/${locale}/needs/in/constituency/east-wiltshire/`);
    }
  });

  it("redirects to a slug that need not exist -- the lookup is never checked against D1", async () => {
    // PINNED AS CURRENT BEHAVIOUR, and it is Django's too (views.py:1057
    // reverses the slug straight out of slugify() with no existence check).
    // A postcode in a constituency D1 does not hold -- or a postcodes.io name
    // that slugs differently from the stored slug -- sends the visitor to a
    // 404. Worth knowing because the failure surfaces one hop away from its
    // cause, on a page that looks like a plain missing constituency.
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json: async () => ({ result: { parliamentary_constituency_2024: "Nowhere At All" } }) }) as unknown as Response);
    const res = await get("/needs/in/constituencies/?postcode=SP1+1AA");
    expect(res.headers.get("Location")).toBe("/needs/in/constituency/nowhere-at-all/");
    expect((await get("/needs/in/constituency/nowhere-at-all/")).status).toBe(404);
  });

  it("renders the index with the not-recognised notice when the lookup fails", async () => {
    // views.py:1055's `if parl_con:` falls through to render(). The template
    // uses the still-set `postcode` to show the notice AND to refill the box,
    // so the visitor can correct a typo instead of retyping. Both halves are
    // asserted -- an empty box after a failed search is the same bug as a
    // missing notice, just quieter.
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response);
    const res = await get("/needs/in/constituencies/?postcode=ZZ99+9ZZ");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div class="notification is-warning">');
    expect(html).toContain("Sorry, we didn't recognise this postcode. Could you try again?");
    expect(html).toContain('value="ZZ99 9ZZ"');
    // ...and the full list is still there, so the page remains usable.
    expect(countryGroups(html)).toHaveLength(5);
  });

  it("escapes the postcode it echoes back, so the box cannot be an injection point", async () => {
    // The ONLY attacker-controlled string on this page, reflected into an
    // attribute value on a cacheable page. Nunjucks autoescape is what stops
    // it (packages/templates/src/env.ts); asserted rather than assumed because
    // a future `|safe` here would be a reflected XSS on www.givefood.org.uk.
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response);
    const html = await body(`/needs/in/constituencies/?postcode=${encodeURIComponent('"><script>alert(1)</script>')}`);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
  });

  it("does NOT look anything up for an empty postcode= parameter", async () => {
    // `?postcode=` yields "" from c.req.query, and `if (postcode)` is falsy
    // for it -- matching Python's `if postcode:` on the "" that
    // request.GET.get returns. A port written as `!== null` would fire a
    // postcodes.io request for every visitor who submits the box empty, and
    // then show them the "we didn't recognise this postcode" notice for a
    // postcode they never typed.
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });
    const html = await body("/needs/in/constituencies/?postcode=");
    expect(calls).toEqual([]);
    expect(html).not.toContain("Sorry, we didn't recognise this postcode");
  });

  it("500s when postcodes.io is unreachable, rather than falling back to the index", async () => {
    // PINNED AS CURRENT BEHAVIOUR, and the honest answer to "what happens when
    // the downstream fails". `fetch` rejecting propagates out of the handler
    // and index.ts's onError renders the 500 page. Django's requests.get()
    // raising a ConnectionError does exactly the same thing (the view has no
    // try/except), so this is parity -- but it means an api.postcodes.io
    // outage takes out the constituencies index for anyone who submits the
    // search box, not just the search itself.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("network error");
    });
    expect((await get("/needs/in/constituencies/?postcode=SP1+1AA")).status).toBe(500);
    expect(consoleError).toHaveBeenCalled();
  });

  it("is cacheable for a week, as @cache_page(SECONDS_IN_WEEK) said", async () => {
    // The handler sets a BARE max-age with no `public`/`s-maxage`, the same
    // convention routes/wfbn/geojson.ts uses. pageCacheControl.ts would
    // otherwise have filled this gap with `public, max-age=300,
    // s-maxage=604800` (WEEKLY_PAGES matches "constituencies/"), so this
    // assertion is also the proof that its never-override guard held.
    const res = await get("/needs/in/constituencies/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("max-age=604800");
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
  });

  it("stamps the week-long header on the REDIRECT too, where Django sent none", async () => {
    // SUSPECT, pinned. The handler returns c.redirect() BEFORE it reaches
    // `c.header("Cache-Control", ...)`, so a 302 carries no Cache-Control of
    // its own -- and pageCacheControl skips non-200s. So the redirect is
    // uncacheable, which is correct: it is a function of a query parameter,
    // and a cached one would send everyone to one visitor's constituency.
    // Asserted as an absence precisely because "stamp the header at the top of
    // the handler" is a plausible tidy-up that would break it.
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json: async () => ({ result: { parliamentary_constituency_2024: "Salisbury" } }) }) as unknown as Response);
    const res = await get("/needs/in/constituencies/?postcode=SP1+1AA");
    expect(res.status).toBe(302);
    expect(res.headers.get("Cache-Control")).toBeNull();
  });

  it("declares itself translatable with all four alternates, and renders in the URL's language", async () => {
    // pageTranslatable: true plus the unprefixedPath the handler passes.
    // Passing c.req.path there instead is invisible in English and turns the
    // Welsh page's alternates into /cy/cy/... -- so the assertion lives on the
    // /cy/ page, where the two spellings disagree.
    const cy = await body("/cy/needs/in/constituencies/");
    expect(cy).toContain('<html lang="cy" dir="ltr"');
    expect(cy).toContain(`<link rel="alternate" hreflang="en" href="${ORIGIN}/needs/in/constituencies/">`);
    expect(cy).toContain(`<link rel="alternate" hreflang="cy" href="${ORIGIN}/cy/needs/in/constituencies/">`);
    expect(cy).toContain(`<link rel="alternate" hreflang="ga" href="${ORIGIN}/ga/needs/in/constituencies/">`);
    expect(cy).toContain(`<link rel="alternate" hreflang="gd" href="${ORIGIN}/gd/needs/in/constituencies/">`);
    expect(cy).toContain(`<link rel="canonical" href="${ORIGIN}/cy/needs/in/constituencies/">`);
    // The catalogue really was consulted: this heading is translated.
    expect(cy).toContain("Etholaethau Seneddol");
  });

  it("DROPS the ?postcode= querystring from the alternates and the flag link -- a divergence", async () => {
    // SUSPECT, pinned, and traced to a one-word omission. Django's
    // context_processors.py:37-47 appends request.META['QUERY_STRING'] to
    // every language-switcher URL and to flag_path; buildPageContext takes a
    // `querystring` option for exactly that, and routes/wfbn/index.ts passes
    // it -- this handler does not. So a visitor who has just failed a postcode
    // search and clicks "Cymraeg" loses the postcode from the box, and a
    // "Something wrong in this page?" report arrives without the input that
    // caused the problem, which is the one thing that report needed to carry.
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response);
    const html = await body("/needs/in/constituencies/?postcode=ZZ99+9ZZ");
    expect(html).toContain(`<link rel="alternate" hreflang="cy" href="${ORIGIN}/cy/needs/in/constituencies/">`);
    expect(html).not.toContain("hreflang=\"cy\" href=\"https://www.givefood.org.uk/cy/needs/in/constituencies/?postcode");
    expect(html).toContain(`href="/flag/#${ORIGIN}/needs/in/constituencies/"`);
  });

  it("reports the whole request's elapsed time, not a timer this handler started", async () => {
    // elapsedMs(c) subtracts serverTiming's requestStartTime. A handler that
    // started its own timer would report ~0 and quietly stop measuring the
    // thing the debug comment claims to measure. Driven from a fixed clock so
    // the NUMBER is the assertion.
    const readings = [1000, 1064.6, 1099];
    let i = 0;
    vi.spyOn(performance, "now").mockImplementation(() => readings[Math.min(i++, readings.length - 1)] ?? 0);
    expect(await body("/needs/in/constituencies/")).toContain("⏱️ Took 65ms");
  });

  it("asks D1 for exactly one narrow query -- never SELECT *, never boundary_geojson", async () => {
    // PLAN.md's hard rule, and the reason getAllConstituenciesOrderedByName
    // exists at all: boundary_geojson runs to ~1.6 MB on the largest
    // constituencies, so a SELECT * here would pull ~650 blobs to print 650
    // names. That regression would not change a single byte of the rendered
    // page -- only the latency and the D1 bill -- so the SQL text is the only
    // place it can be caught.
    await get("/needs/in/constituencies/");
    expect(prepared.map((p) => p.sql)).toEqual(["SELECT name, slug, country, centroid FROM parliamentaryconstituency ORDER BY name"]);
    expect(roundTrips).toHaveLength(1);
  });

  it("is bare /needs/in/constituency/ redirected here, and answers the same page under every prefix", async () => {
    // gfwfbn/urls/i18n.py:44's slug-less RedirectView, registered in
    // index.ts:286. Bundled with the prefix check because both are statements
    // about the same route table: a missing locale registration 404s the page
    // for a whole language while English works perfectly.
    const redirect = await get("/needs/in/constituency/");
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("Location")).toBe("/needs/in/constituencies/");
    for (const locale of ["cy", "ga", "gd"]) {
      expect((await get(`/${locale}/needs/in/constituency/`)).headers.get("Location"), locale).toBe(`/${locale}/needs/in/constituencies/`);
      expect((await get(`/${locale}/needs/in/constituencies/`)).status, locale).toBe(200);
    }
    // /en/ is not a prefix and must 404, as it does in production.
    expect((await get("/en/needs/in/constituencies/")).status).toBe(404);
  });
});

// ===========================================================================
// wfbnConstituency -- GET /needs/in/constituency/<slug>/
// ===========================================================================

describe("the constituency page: which rows appear", () => {
  it("lists the constituency's open food banks then its open locations, NEITHER sorted", async () => {
    // ParliamentaryConstituency.foodbanks() (political.py:100-135) --
    // frozen bug B3. The two sub-lists are concatenated in that order and
    // neither is sorted, so the page shows food banks in rowid order. The
    // fixture is seeded deliberately out of alphabetical order (Wilton is id
    // 1) so that "sorted alphabetically" and "sorted by anything at all"
    // both fail here. Asserted as the WHOLE list including the excluded rows'
    // absence -- a filter that does nothing passes any test that only seeds
    // matching rows.
    const table = rows(await body("/needs/in/constituency/salisbury/"));
    expect(table.map((r) => r.name)).toEqual([
      "Wilton",
      "Alderbury",
      "Bemerton",
      "Coombe Bissett",
      "Downton",
      "Wilton Centre",
      "Andover Outreach",
      "Closed Parent Centre",
      "Orphan Centre",
    ]);
  });

  it("excludes closed food banks, closed locations, and everything in another constituency", async () => {
    // The negative half of the test above, stated as the four rows that MUST
    // NOT be there. "Zed Closed" is named to sort last precisely so a lost
    // is_closed filter would show up at the END of the list, where an
    // eyeballed fixture is least likely to notice it.
    const names = rows(await body("/needs/in/constituency/salisbury/")).map((r) => r.name);
    expect(names).not.toContain("Zed Closed"); // is_closed = 1
    expect(names).not.toContain("Devizes"); // constituency 46
    expect(names).not.toContain("Shut Centre"); // location is_closed = 1
    expect(names).not.toContain("Devizes Centre"); // location in constituency 46
  });

  it("404s an unknown slug with the real 404 PAGE, not an empty body", async () => {
    // get_object_or_404(ParliamentaryConstituency, slug=slug). Worth its own
    // test because getConstituencyBySlugNarrow returns null rather than
    // throwing, so a missing `if (!constituency)` would not crash -- it would
    // render a page for `undefined` with somebody else's food banks on it.
    //
    // c.notFound(), not a bare 404 response: index.ts's app.notFound renders
    // 404.njk through the real pipeline, so the visitor who mistypes a
    // constituency gets the site's own page with a way back rather than a
    // blank browser error. Asserting the status alone cannot tell those two
    // apart -- a mutant returning `c.body(null, 404)` survives it.
    const res = await get("/needs/in/constituency/no-such-place/");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("<h1>404 - Not Found</h1>");
    expect(html).not.toContain("Wilton");
    // ...and in the visitor's own language, since resolveLanguage runs
    // globally and the 404 render sees it.
    expect(await (await get("/cy/needs/in/constituency/no-such-place/")).text()).toContain('<html lang="cy"');
  });

  it("links each organisation at its own food bank page and each location at its parent's sub-page", async () => {
    // url('wfbn:foodbank', slug) vs url('wfbn:foodbank_location', parent,
    // loc) -- frozen bug B3's other half is that nothing validates which list
    // an entry came from, so building a location's URL with the food bank
    // pattern produces /needs/at/<location-slug>/, which 404s.
    const table = rows(await body("/needs/in/constituency/salisbury/"));
    expect(table.find((r) => r.name === "Wilton")?.href).toBe("/needs/at/wilton/");
    expect(table.find((r) => r.name === "Wilton Centre")?.href).toBe("/needs/at/wilton/wilton-centre/");
    expect(table.find((r) => r.name === "Andover Outreach")?.href).toBe("/needs/at/andover-mission-town/andover-outreach/");
  });

  it("labels a location with its parent, using the parent's REAL slug -- a divergence from Django", async () => {
    // Django's template builds this link with `foodbank.foodbank_name|slugify`
    // (constituency.html:74) because ParliamentaryConstituency.foodbanks()
    // never put a slug in the location dict. The port passes the stored
    // foodbank_slug instead. Food bank 8 is seeded with name "Andover Mission"
    // and slug "andover-mission-town" so the two answers differ: Django emits
    // /needs/at/andover-mission/ (a 404 -- no such food bank), this emits
    // /needs/at/andover-mission-town/ (correct). A deliberate improvement,
    // pinned so it is not "tidied" back to a slugify().
    const html = await body("/needs/in/constituency/salisbury/");
    expect(html).toContain('<div class="parent_org">Part of <a href="/needs/at/andover-mission-town/">Andover Mission</a></div>');
    expect(html).not.toContain('href="/needs/at/andover-mission/"');
  });

  it("keeps a location whose parent food bank is CLOSED, and shows the closed parent's need", async () => {
    // getFoodbanksForConstituency filters `is_closed = 0` on the LOCATION
    // (and separately on the food bank list), while getFoodbanksByIds -- which
    // resolves the parents -- has no such filter. So an open location under a
    // closed food bank stays listed with the closed parent's need text. That
    // is Django's behaviour too: location_obj() filters the LOCATION's
    // is_closed, and location.latest_need() reaches through
    // self.foodbank.latest_need unconditionally.
    const table = rows(await body("/needs/in/constituency/salisbury/"));
    expect(table.find((r) => r.name === "Closed Parent Centre")?.needCell).toBe("Nappies");
    // ...while the closed parent's own ORGANISATION row is still gone.
    expect(table.map((r) => r.name)).not.toContain("Zed Closed");
  });

  it("renders a location whose parent food bank does not exist at all, with a blank need cell", async () => {
    // SUSPECT, pinned. `byId.get(loc.foodbank_id)` is undefined for an orphan
    // row, so get_change_text is "" and facebook_page is null -- the row
    // renders with an empty second cell and no error. Django would raise
    // RelatedObjectDoesNotExist on location.foodbank and 500 the page, so the
    // port is the more forgiving of the two; recorded because a silent blank
    // cell is exactly how referential damage in `foodbanklocation` would hide.
    // (The foodbanklocation_full view is a LEFT JOIN, which is what lets the
    // row reach the page at all.)
    const table = rows(await body("/needs/in/constituency/salisbury/"));
    expect(table.find((r) => r.name === "Orphan Centre")?.needCell).toBe("");
    expect(table.find((r) => r.name === "Orphan Centre")?.href).toBe("/needs/at/null/orphan-centre/");
  });

  it("fetches parents from OTHER constituencies too -- the union that keeps a cell from going blank", async () => {
    // foodbankIds is the union of this constituency's own food banks and
    // EVERY location's parent id. Location 12 sits in Salisbury while its
    // parent food bank 8 is registered in Andover, so a parent set built from
    // rawFoodbanks alone would miss it -- and the row would render blank,
    // indistinguishable from a food bank with no current need. Asserted by
    // the need text and by the id list actually bound to the WHERE-IN.
    const table = rows(await body("/needs/in/constituency/salisbury/"));
    expect(table.find((r) => r.name === "Andover Outreach")?.needCell).toBe("Tea<br>Coffee");

    const byIds = prepared.find((p) => p.sql.startsWith("SELECT * FROM foodbank WHERE id IN"));
    // 1-5 are the constituency's own, then the parents in location order:
    // 1 again (deduped away), 8 (Andover), 6 (closed) and 999 (the orphan).
    expect(byIds?.params).toEqual([1, 2, 3, 4, 5, 8, 6, 999]);
  });
});

describe("the constituency page: what each need cell says", () => {
  it("prints the need list with blank lines stripped and newlines as <br>", async () => {
    // resolveNeedText -> nonEmptyLines (FoodbankChange.get_text()'s
    // "Remove empty lines" step), then the template's |linebreaksbr. Need 100
    // is seeded "Beans\nPasta\n\nRice" so a port that skipped the strip would
    // render a stray empty line, and one that skipped linebreaksbr would run
    // the three items together.
    const table = rows(await body("/needs/in/constituency/salisbury/"));
    expect(table.find((r) => r.name === "Wilton")?.needCell).toBe("Beans<br>Pasta<br>Rice");
  });

  it("shows phone and email instead of a need list when the need is the Unknown sentinel", async () => {
    // constituency.njk:77-84. "Unknown" is a contract value in change_text,
    // not free text, and the page turns it into a "ring them and ask" cell.
    // The tel: href goes through |full_phone and the visible text through
    // |friendly_phone, which is why both spellings of the number are asserted.
    const html = await body("/needs/in/constituency/salisbury/");
    const cell = rows(html).find((r) => r.name === "Alderbury")?.needCell ?? "";
    expect(cell).toContain('<a href="tel:+441722222222">01722 222 222</a>');
    expect(cell).toContain('<a href="mailto:help@alderbury.invalid">help@alderbury.invalid</a>');
    expect(cell).not.toContain("Unknown");
  });

  it("points at the food bank's Facebook page when the need is the Facebook sentinel", async () => {
    // constituency.njk:85-92, including the ?ref=givefood.org.uk the charity
    // uses to see referrals from this site.
    const cell = rows(await body("/needs/in/constituency/salisbury/")).find((r) => r.name === "Bemerton")?.needCell ?? "";
    expect(cell).toContain('<a href="https://www.facebook.com/bemertonheath?ref=givefood.org.uk">Facebook page</a>');
  });

  it("falls back to the need_text include when a Facebook-sentinel food bank has no Facebook page", async () => {
    // constituency.njk:90-91's `{% else %}`. The row would otherwise render an
    // empty cell -- a food bank that says "check our Facebook" with no link to
    // it. need_text.njk has no branch for "Facebook", so what actually gets
    // printed is the literal word, which is what this pins.
    db.prepare("UPDATE foodbank SET facebook_page = NULL WHERE id = 3").run();
    const cell = rows(await body("/needs/in/constituency/salisbury/")).find((r) => r.name === "Bemerton")?.needCell ?? "";
    expect(cell).toBe("Facebook");
  });

  it("prints the long 'isn't requesting anything' sentence for the Nothing sentinel", async () => {
    // wfbn/includes/need_text.njk's second branch, reached through the
    // template's final `{% else %}`.
    const cell = rows(await body("/needs/in/constituency/salisbury/")).find((r) => r.name === "Coombe Bissett")?.needCell ?? "";
    expect(cell).toBe(
      "This food bank isn't requesting anything, but may appreciate other support like a financial donation or volunteers. Please contact them to find out.",
    );
  });

  it("renders a BLANK cell, not 'Nothing', for a food bank with no latest need at all", async () => {
    // THE DIVERGENCE THIS MODULE DOCUMENTS AND DELIBERATELY REPRODUCES.
    // Elsewhere on the site latest_need_text() substitutes the "Nothing"
    // sentinel for a null FK; here Django's template reads the raw nullable
    // `foodbank.needs`, so None resolves to the invalid-variable default ('')
    // and the cell is empty. Food bank 5 has latest_need_id NULL, so this is
    // the difference between "we know they want nothing" and "we know
    // nothing" -- two different statements to a visitor, and the port keeps
    // the one Django made.
    const table = rows(await body("/needs/in/constituency/salisbury/"));
    expect(table.find((r) => r.name === "Downton")?.needCell).toBe("");
    expect(table.find((r) => r.name === "Downton")?.needCell).not.toContain("isn't requesting anything");
  });

  it("shows a location's own phone and email when it has them, and the parent's when it does not", async () => {
    // FoodbankLocation.phone_or_foodbank_phone() /
    // email_or_foodbank_email(), fed from the foodbanklocation_full view's
    // joined foodbank_phone_number / foodbank_email. Both are only visible in
    // the Unknown branch, so the two locations are temporarily given an
    // Unknown need to make the fallback observable at all -- location 11 has
    // its own contacts, location 12 has none and must inherit food bank 8's.
    db.prepare("UPDATE foodbankchange SET change_text = 'Unknown' WHERE id IN (100, 106)").run();
    const table = rows(await body("/needs/in/constituency/salisbury/"));
    expect(table.find((r) => r.name === "Wilton Centre")?.needCell).toContain('<a href="tel:+441722999111">01722 999 111</a>');
    expect(table.find((r) => r.name === "Wilton Centre")?.needCell).toContain("centre@wilton.invalid");
    expect(table.find((r) => r.name === "Andover Outreach")?.needCell).toContain('<a href="tel:+441264888888">01264 888 888</a>');
    expect(table.find((r) => r.name === "Andover Outreach")?.needCell).toContain("hello@andover.invalid");
  });

  it("uses the PARENT's Facebook page for a location row", async () => {
    // The location table has no facebook_page column at all -- the handler
    // reads parentFb.facebook_page. A location whose parent is on Facebook
    // must therefore link to the parent's page, and location 12's parent (food
    // bank 8) is the case that proves the lookup crossed constituencies.
    db.prepare("UPDATE foodbankchange SET change_text = 'Facebook' WHERE id = 106").run();
    const cell = rows(await body("/needs/in/constituency/salisbury/")).find((r) => r.name === "Andover Outreach")?.needCell ?? "";
    expect(cell).toContain("https://www.facebook.com/andovermission?ref=givefood.org.uk");
  });
});

describe("the constituency page: locale-aware need text", () => {
  it("never touches the translations table in English", async () => {
    // needs.py:216-259's `current_language == "en"` branch never queries
    // FoodbankChangeTranslation, and the handler reproduces that with a
    // `locale !== "en"` gate. The gate is invisible in the rendered page --
    // English output is identical either way -- so the SQL is the only
    // evidence. It matters: this is one D1 round trip on the site's most
    // heavily visited constituency pages.
    await get("/needs/in/constituency/salisbury/");
    expect(prepared.filter((p) => p.sql.includes("foodbankchangetranslation"))).toEqual([]);
  });

  it("swaps in the Welsh need list, batched into ONE query for the whole page", async () => {
    // getNeedTranslationsByIds' WHERE-IN, not one lookup per row -- the N+1
    // this page would otherwise do once per food bank. The bound parameters
    // are asserted because the language is the FIRST binding and a swapped
    // argument order would return nothing and silently fall back to English
    // on every row.
    const html = await body("/cy/needs/in/constituency/salisbury/");
    expect(rows(html).find((r) => r.name === "Wilton")?.needCell).toBe("Ffa<br>Pasta<br>Reis");

    const lookup = prepared.filter((p) => p.sql.includes("foodbankchangetranslation"));
    expect(lookup).toHaveLength(1);
    expect(lookup[0]?.params).toEqual(["cy", 100, 101, 102, 103, 106, 104]);
  });

  it("asks for each need id ONCE, even when two food banks share a latest need", async () => {
    // The `new Set` around constituencyNeedIds. Two food banks pointing at one
    // foodbankchange row is a data anomaly rather than a schema state
    // (foodbankchange.foodbank_id is a single FK), but nothing prevents it,
    // and without the dedup every duplicate adds a bound parameter to a
    // WHERE-IN that already carries one per food bank. D1 caps a statement at
    // 100 bound parameters, and the largest constituencies are exactly where
    // this list is longest -- so the failure would be a 500 on the biggest
    // pages only, which is the worst possible place for it to appear first.
    // Set up here rather than in the shared fixture so the anomaly does not
    // quietly change every other assertion in the file.
    db.prepare("UPDATE foodbank SET latest_need_id = 100 WHERE id = 6").run();
    await get("/cy/needs/in/constituency/salisbury/");
    const lookup = prepared.filter((p) => p.sql.includes("foodbankchangetranslation"));
    expect(lookup[0]?.params).toEqual(["cy", 100, 101, 102, 103, 106]);
  });

  it("falls back to the English text for a need with no row in the requested language", async () => {
    // resolveNeedText's `locale !== "en" && translatedText ? ... : rawText`.
    // Needs 102/103/106 have no cy row, so their cells must be the English
    // ones -- a fallback that returned "" instead would blank most of a
    // Welsh page while the one translated row looked fine.
    const html = await body("/cy/needs/in/constituency/salisbury/");
    expect(rows(html).find((r) => r.name === "Andover Outreach")?.needCell).toBe("Tea<br>Coffee");
  });

  it("uses the requested language's row, not merely any row that exists", async () => {
    // Need 100 has BOTH a cy and a ga translation, deliberately different.
    // A lookup that ignored the language binding would pass the cy test above
    // and hand Welsh text to an Irish visitor.
    expect(rows(await body("/ga/needs/in/constituency/salisbury/")).find((r) => r.name === "Wilton")?.needCell).toBe("Pónairí");
  });

  it("compares the TRANSLATED text against the Unknown sentinel, so a translated sentinel changes the branch", async () => {
    // PARITY, not a bug -- and surprising enough to be worth a test of its
    // own. translate_need() (givefood/utils/general.py:203-221) translates
    // change_text unconditionally, sentinels included, and get_text() returns
    // that translated string; Django's own template then compares it against
    // the ENGLISH literal "Unknown". So need 101, whose cy row reads
    // "Anhysbys", takes the plain need_text branch on the Welsh page and the
    // phone/email branch on the English one. This module's header comment
    // states exactly this, and the assertion is what makes the statement
    // checkable.
    const cy = rows(await body("/cy/needs/in/constituency/salisbury/")).find((r) => r.name === "Alderbury")?.needCell ?? "";
    expect(cy).toBe("Anhysbys");
    expect(cy).not.toContain("tel:");

    const en = rows(await body("/needs/in/constituency/salisbury/")).find((r) => r.name === "Alderbury")?.needCell ?? "";
    expect(en).toContain("tel:+441722222222");
  });

  it("renders the whole page in the URL's language and links back to the prefixed home page", async () => {
    // The locale reaches the template twice -- buildPageContext's `locale`
    // (html lang, alternates) and render()'s third argument (the .po
    // catalogue and the url() prefix). A mutant dropping the third argument
    // still produces lang="cy" with an English page, so both are asserted.
    const html = await body("/cy/needs/in/constituency/salisbury/");
    expect(html).toContain('<html lang="cy" dir="ltr"');
    expect(html).toContain("Banciau bwyd yn Salisbury");
    expect(html).toContain('<a href="/cy/" class="logo">');
    expect(html).toContain(`<link rel="alternate" hreflang="gd" href="${ORIGIN}/gd/needs/in/constituency/salisbury/">`);
  });

  it("links food banks WITHOUT the locale prefix from a Welsh page -- a known, pre-existing divergence", async () => {
    // The module's own KNOWN DIVERGENCE note. `gf_url` is built with url(),
    // not urlForLocale(), so /cy/needs/in/constituency/salisbury/ links out to
    // /needs/at/wilton/ where Django's in-request reverse() would have given
    // /cy/needs/at/wilton/. Both names ARE in I18N_SCOPED, so this is one line
    // from being fixed -- but fixing it changes rendered output on every
    // non-English constituency page, which is a parity decision rather than a
    // refactor. Pinned so the decision stays deliberate.
    const table = rows(await body("/cy/needs/in/constituency/salisbury/"));
    expect(table.find((r) => r.name === "Wilton")?.href).toBe("/needs/at/wilton/");
    expect(table.find((r) => r.name === "Wilton Centre")?.href).toBe("/needs/at/wilton/wilton-centre/");
    // ...while the map config's geojson URL, built with urlForLocale, IS
    // prefixed -- the two spellings sitting side by side in one response.
    expect(await body("/cy/needs/in/constituency/salisbury/")).toContain('"geojson":"/cy/needs/in/constituency/salisbury/geo.json"');
  });
});

describe("the constituency page: the MP, the map and the nearby list", () => {
  it("ranks the five nearest constituencies and never the page's own", async () => {
    // ParliamentaryConstituency.nearby() = find_parlcons(centroid, 5, True)
    // -- an in-memory haversine over every constituency with skip_first, so
    // the subject is dropped by POSITION (it is always index 0 at distance 0),
    // not by id. Distances from Salisbury's centroid, computed with
    // R_PYTHON in this working tree: 18.2 km, 22.4 km, 25.2 km, 26.6 km,
    // 31.4 km, then a 292 km gap. The order is the assertion -- a ranking
    // that merely returned five plausible constituencies would look right on
    // a page and be useless to a visitor.
    expect(nearbyNames(await body("/needs/in/constituency/salisbury/"))).toEqual([
      "South West Wiltshire",
      "Romsey and Southampton North",
      "New Forest West",
      "Andover and Mid Hampshire",
      "East Wiltshire",
    ]);
  });

  it("stops at five and excludes the sixth-nearest", async () => {
    // The quantity+skip_first arithmetic: Django slices [1:quantity+1] and the
    // port slices [1:1+5]. An off-by-one either way is invisible unless the
    // count is asserted AND a specific just-missed constituency is named.
    const names = nearbyNames(await body("/needs/in/constituency/salisbury/"));
    expect(names).toHaveLength(5);
    expect(names).not.toContain("Chorley"); // 292 km, the next one out
    expect(names).not.toContain("Salisbury");
  });

  it("reads the centroid string, not the latitude/longitude columns", async () => {
    // political.py:41-45's latt()/long() split `centroid`; the latitude and
    // longitude COLUMNS are vestigial and NULL for 646 of the 650 production
    // rows. Every fixture row here has them NULL, so a port that read the
    // columns would rank by NaN -- which is why the ranking above is evidence
    // for this, and why the meta tags below print real numbers.
    const html = await body("/needs/in/constituency/salisbury/");
    expect(html).toContain('<meta name="geo.position" content="51.0688,-1.7945">');
    expect(html).toContain('<meta property="place:location:latitude" content="51.0688">');
    expect(html).toContain('<meta property="place:location:longitude" content="-1.7945">');
  });

  it("still renders a 200 with a nonsense nearby list when the centroid is unparseable", async () => {
    // SUSPECT, pinned. `centroid` is NOT NULL but nothing validates its shape.
    // An empty string gives Number("") = 0 for the latitude and
    // Number(undefined) = NaN for the longitude, every haversine comes back
    // NaN, the comparator returns NaN (treated as 0, so the sort is a no-op),
    // and skip_first then drops whichever constituency happened to sort first
    // by name. The visitor gets five arbitrary constituencies presented as
    // "nearby" and nothing anywhere records a problem. Asserted as the exact
    // current output so the day someone adds validation, this test is what
    // tells them the page's shape changed.
    db.prepare("UPDATE parliamentaryconstituency SET centroid = '' WHERE id = 41").run();
    const res = await get("/needs/in/constituency/salisbury/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(nearbyNames(html)).toEqual(["Belfast East", "Chorley", "East Wiltshire", "Glasgow North", "Middlesbrough South and East Cleveland"]);
    expect(html).toContain('<meta property="place:location:latitude" content="0">');
    expect(html).toContain('<meta property="place:location:longitude" content="NaN">');
  });

  it("renders the MP photo, the MP's name and the party sentence", async () => {
    // ENABLE_WRITE is a hardcoded `true` in @givefood/models (matching
    // givefood/const/general.py), so this block is always on. The Google
    // search link is urlencoded, which is where a name with a space would
    // otherwise break the href.
    const html = await body("/needs/in/constituency/salisbury/");
    expect(html).toContain('<img src="https://photos.givefood.org.uk/2024-mp/4051.jpg" alt="John Glen" class="mp_photo">');
    expect(html).toContain('<meta property="og:image" content="https://photos.givefood.org.uk/2024-mp/4051.jpg">');
    expect(html).toContain('<a href="https://www.google.co.uk/search?q=John%20Glen%20MP">John Glen MP</a>');
    expect(html).toContain("of the Conservative party.");
  });

  it("says 'Speaker of the House of Commons' instead of a party for the Speaker's seat", async () => {
    // constituency.njk:57-61. The Speaker sits as an independent, so
    // "of the Speaker party" would be wrong in a way that is one string
    // comparison away and only ever visible on one of the 650 pages.
    const html = await body("/needs/in/constituency/chorley/");
    expect(html).toContain("who is the Speaker of the House of Commons.");
    expect(html).not.toContain("of the Speaker party.");
  });

  it("hands the map its own constituency's geojson feed and a max zoom of 14", async () => {
    // views.py:1074-1078, JSON-encoded into the page for wfbn.js. `|safe`
    // in the include means this string is injected into a <script> unescaped,
    // so a wrong slug here is a map that silently draws nothing.
    expect(await body("/needs/in/constituency/salisbury/")).toContain(
      'window.gfMapConfig = {"geojson":"/needs/in/constituency/salisbury/geo.json","max_zoom":14};',
    );
  });

  it("emits AdministrativeArea JSON-LD containing every listed food bank and location", async () => {
    // ParliamentaryConstituency.schema_org() (political.py:56-72). The
    // containsPlace array is built from the SAME two lists the table renders,
    // with the orphan location dropped (no parent to build a sub-property
    // from) -- so a mismatch between the visible table and the structured data
    // is exactly what this catches. sameAs is the Wikipedia URL Django builds
    // with quote_plus on the underscored name.
    const ld = constituencyJsonLd(await body("/needs/in/constituency/salisbury/"));
    expect(ld["@type"]).toBe("AdministrativeArea");
    expect(ld.name).toBe("Salisbury");
    expect(ld.sameAs).toBe("https://en.wikipedia.org/wiki/Salisbury_(UK_Parliament_constituency)");
    const places = ld.containsPlace as Array<Record<string, unknown>>;
    expect(places.map((p) => p.name)).toEqual([
      "Wilton Foodbank",
      "Alderbury Foodbank",
      "Bemerton Foodbank",
      "Coombe Bissett Foodbank",
      "Downton Foodbank",
      "Wilton Centre, Wilton Foodbank",
      "Andover Outreach, Andover Mission Foodbank",
      "Closed Parent Centre, Zed Closed Foodbank",
    ]);
    // The orphan location has no parent food bank, so it cannot become a
    // sub-property and is filtered out -- the one row where the table and the
    // JSON-LD legitimately disagree.
    expect(places.map((p) => p.name)).not.toContain("Orphan Centre, Foodbank");
  });

  it("uses the locale-aware full name in the JSON-LD, alt_name and all", async () => {
    // fullNameLocaleAware: Welsh with an alt_name set returns the alt_name
    // verbatim (no "Foodbank" suffix, no "Banc Bwyd" prefix); Welsh without
    // one takes the prefix. Food bank 1 has an alt_name and food bank 2 does
    // not, so both branches are visible in one response.
    const places = constituencyJsonLd(await body("/cy/needs/in/constituency/salisbury/")).containsPlace as Array<Record<string, unknown>>;
    expect(places[0]?.name).toBe("Banc Bwyd Wilton");
    expect(places[1]?.name).toBe("Banc Bwyd Alderbury");
  });

  it("percent-encodes a constituency name with a space and an accent into its Wikipedia URL", async () => {
    // quotePlus in lib/schemaOrg.ts, mirroring Python's
    // urllib.parse.quote_plus -- "Ynys Môn" underscores to "Ynys_Môn" and the
    // ô is percent-encoded. A raw name here would be an invalid URL in
    // structured data that search engines read.
    const ld = constituencyJsonLd(await body("/needs/in/constituency/ynys-mon/"));
    expect(ld.sameAs).toBe("https://en.wikipedia.org/wiki/Ynys_M%C3%B4n_(UK_Parliament_constituency)");
  });

  it("renders a constituency with no food banks at all without breaking", async () => {
    // 172 of the 650 real constituencies have no food bank in them. Both
    // loops are empty, the batched WHERE-IN is skipped entirely
    // (getFoodbanksByIds returns [] for an empty id list rather than issuing
    // `IN ()`, which is a SQLite syntax error), and containsPlace is empty.
    const html = await body("/needs/in/constituency/belfast-east/");
    expect(rows(html)).toEqual([]);
    expect((constituencyJsonLd(html).containsPlace as unknown[]).length).toBe(0);
    expect(prepared.some((p) => p.sql.includes("IN ()"))).toBe(false);
    // ...and the rest of the page is intact.
    expect(nearbyNames(html)).toHaveLength(5);
  });

  it("is cacheable for a week and carries no cache tag or geojson preload hint", async () => {
    // The week matches @cache_page(SECONDS_IN_WEEK); the two nulls are
    // PRE-EXISTING BUGS ALREADY REPORTED against their own modules, asserted
    // here because this is the page that suffers them:
    //   * middleware/cacheTag.ts's CONSTITUENCY_PATH expects /constituency/
    //     at the root, not /needs/in/constituency/, so nothing purges this
    //     page when a food bank on it changes -- for a week (see
    //     cacheTag.test.ts's "SUSPECTED BUG" case);
    //   * middleware/geoJsonPreload.ts tests routePath ===
    //     "/in/constituency/:slug/", which the real registration never
    //     matches, so the preload Django emitted here is missing (see
    //     geoJsonPreload.test.ts's "the branch is unreachable" case).
    // Server-Timing is the control: both of those middlewares run on the way
    // out, so its presence proves the unwind happened and the nulls are the
    // bugs rather than a chain that never executed.
    const res = await get("/needs/in/constituency/salisbury/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("max-age=604800");
    expect(res.headers.get("Cache-Tag")).toBeNull();
    expect(res.headers.get("Link")).toBeNull();
    expect(res.headers.get("Server-Timing")).toMatch(/^render;dur=/);
  });

  it("issues four D1 round trips, with the two independent SELECTs batched into one", async () => {
    // The module's own claims about its query plan, made checkable:
    //   1. the constituency lookup and the all-constituencies list, in
    //      parallel via Promise.all -- two waits, since they are separate
    //      statements, not a batch;
    //   2. getFoodbanksForConstituency's session.batch() -- ONE wait for the
    //      food banks AND the locations;
    //   3. the batched foodbank-by-ids WHERE-IN;
    //   4. the needs-by-ids WHERE-IN.
    // The narrow projections are asserted alongside, because PLAN.md's hard
    // rule (never SELECT * on parliamentaryconstituency) is invisible in the
    // rendered page and boundary_geojson is ~1.6 MB a row.
    await get("/needs/in/constituency/salisbury/");
    expect(roundTrips).toEqual([
      ["SELECT id, name, slug, country, mp, mp_party, mp_parl_id, mp_display_name, email, centroid, latitude, longitude FROM parliamentaryconstituency WHERE slug = ?"],
      ["SELECT name, slug, country, centroid FROM parliamentaryconstituency ORDER BY name"],
      [
        "SELECT * FROM foodbank WHERE parliamentary_constituency_id = ? AND is_closed = 0",
        expect.stringContaining("FROM foodbanklocation_full WHERE parliamentary_constituency_id = ? AND is_closed = 0") as unknown as string,
      ],
      ["SELECT * FROM foodbank WHERE id IN (?, ?, ?, ?, ?, ?, ?, ?)"],
      ["SELECT * FROM foodbankchange_full WHERE id IN (?, ?, ?, ?, ?, ?)"],
    ]);
    expect(prepared.every((p) => !p.sql.includes("boundary_geojson"))).toBe(true);
  });

  it("reports the whole request's elapsed time, including the four D1 waits", async () => {
    // elapsedMs(c) again, and it matters more here than on the index: this
    // page issues four round trips and a template render, so a handler that
    // timed only its own render would report a number that stayed flat while
    // the page got slower. The debug comment is the only place this page's
    // real timing is visible in production.
    const readings = [2000, 2137.2, 2199];
    let i = 0;
    vi.spyOn(performance, "now").mockImplementation(() => readings[Math.min(i++, readings.length - 1)] ?? 0);
    expect(await body("/needs/in/constituency/salisbury/")).toContain("⏱️ Took 137ms");
  });

  it("gives two identical requests identical pages", async () => {
    // Idempotence stated as the property that matters: this page is a pure
    // function of the database, and a week-long edge TTL means whatever it
    // emits once is what everyone sees. The debug comment's clock and timer
    // legitimately differ between requests, so both are frozen and the WHOLE
    // body is compared -- a chosen subset could not notice a new element
    // appearing.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-08T09:30:00.000Z"));
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const first = await body("/needs/in/constituency/salisbury/");
    const second = await body("/needs/in/constituency/salisbury/");
    expect(second).toBe(first);
    expect(first).toContain("Food banks in Salisbury");
  });
});

// ===========================================================================
// wfbnMpPhotoRedirect -- GET
// /needs/in/constituency/<slug>/mp_photo_threefour.png
// ===========================================================================

describe("the MP photo redirect", () => {
  it("302s to the photo service for the constituency's MP", async () => {
    // views.py:1091-1097. This URL is the OLD photo location and still gets
    // traffic from cached pages and third-party embeds, so the redirect is
    // the only thing keeping those images alive.
    const res = await get("/needs/in/constituency/salisbury/mp_photo_threefour.png");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://photos.givefood.org.uk/2024-mp/4051.jpg");
  });

  it("404s an unknown constituency rather than redirecting to a nonsense photo", async () => {
    // get_object_or_404 again. Without the null guard the Location would read
    // ".../2024-mp/undefined.jpg" and every one of those requests would be a
    // 404 fetched from the photo service instead of from here. The absent
    // Location is the load-bearing half: a 404 that still redirects is a
    // status nobody looks at attached to a header browsers act on.
    const res = await get("/needs/in/constituency/no-such-place/mp_photo_threefour.png");
    expect(res.status).toBe(404);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("carries no Cache-Control, matching the un-decorated Django view", async () => {
    // The two page handlers set a week; this one deliberately does not,
    // because gfwfbn/views.py:1091 has no @cache_page either. pageCacheControl
    // skips it as well (302, not 200), so the absence is genuine rather than
    // accidental. It matters: an MP changes and the photo URL should follow
    // within the hour, not the week.
    const res = await get("/needs/in/constituency/salisbury/mp_photo_threefour.png");
    expect(res.headers.get("Cache-Control")).toBeNull();
  });

  it("makes exactly ONE narrow query and never touches the food bank tables", async () => {
    // It needs one integer. A handler that reused the page's data loading
    // would put four queries and a template render behind a redirect that
    // browsers follow automatically -- and the pages linking here are cached
    // for a week, so the traffic is real.
    await get("/needs/in/constituency/salisbury/mp_photo_threefour.png");
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.sql).toContain("FROM parliamentaryconstituency WHERE slug = ?");
    expect(prepared[0]?.params).toEqual(["salisbury"]);
  });

  it("is registered under every language prefix, and resolves ahead of the :locslug catch-all", async () => {
    // gfwfbn/urls/i18n.py puts this inside i18n_patterns, so the prefixed
    // forms must exist -- a page cached in Welsh links to the Welsh spelling
    // of this URL. Redirect target is the same absolute photo URL in every
    // language, since it leaves the site.
    for (const locale of ["cy", "ga", "gd"]) {
      const res = await get(`/${locale}/needs/in/constituency/salisbury/mp_photo_threefour.png`);
      expect(res.status, locale).toBe(302);
      expect(res.headers.get("Location"), locale).toBe("https://photos.givefood.org.uk/2024-mp/4051.jpg");
    }
  });
});
