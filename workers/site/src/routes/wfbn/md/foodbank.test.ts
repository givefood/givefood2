import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../../index";
import type { AppEnv } from "../../../types";

// routes/wfbn/md/foodbank.ts -- mdFoodbank (GET /md/needs/at/<slug>/) and
// mdFoodbankNearby (GET /md/needs/at/<slug>/nearby/). Ported from
// gfwfbn/views.py:688-700 (`md_foodbank`) and :816-830 (`md_foodbank_nearby`),
// read in full alongside this file together with their two Django templates
// (gfwfbn/templates/wfbn/foodbank/md/index.md and .../md/nearby.md),
// givefood/models/foodbank.py's full_name()/network_url() and
// givefood/models/needs.py's get_text()/get_excess_text_list().
//
// WHY THIS FILE EXISTS. The /md/ mirror is the half of this site NOBODY LOOKS
// AT. It exists for LLM crawlers and for `curl`; there is no design, no
// screenshot, no browser rendering it, and no human who would notice it
// changing. Every failure mode below therefore produces a 200 with plausible
// text in it:
//
//   * these two handlers are OUTSIDE i18n_patterns (givefood/urls.py's
//     "Markdown versions" block), so they call render() with no locale and
//     fullNameFoodbank() rather than fullNameLocaleAware(). Nothing on the
//     page says which of the two it used, and the English page is identical
//     either way;
//   * the Unknown/Nothing/Facebook gate is on the RAW `change_text` and takes
//     the ITEMS NOT NEEDED section down with it -- so a food bank with a real
//     excess list and a sentinel need prints neither, which looks exactly like
//     a food bank with no excess list;
//   * `excess_text_list` is comma-joined by the template, so a stray line in
//     it becomes a stray comma in a sentence nobody reads;
//   * `network_url` is a helper that returns `false`, and the template drops
//     it straight into a markdown link target;
//   * the nearby list is twelve lines of place names with a mileage against
//     each, and a plausible one is indistinguishable from a correct one;
//   * /md/needs/at/<slug>/nearby/ is registered in index.ts IMMEDIATELY BEFORE
//     the catch-all /md/needs/at/<slug>/<locslug>/, so its whole existence is
//     a matter of registration order.
//
// So the two happy-path tests assert the ENTIRE response body byte for byte
// rather than a handful of `toContain`s: on a plain-text format there is no
// markup to hang a narrower assertion off, and the blank lines the template
// emits between sections are load-bearing markdown.
//
// REAL EVERYTHING, the harness routes/wfbn/foodbank.test.ts and
// routes/wfbn/nearby.test.ts already use: the real production app
// (src/index.ts's default export), so the router, cacheTag, slugRedirect,
// geoJsonPreload and pageCacheControl are the genuine articles rather than a
// hand-built copy; the real @givefood/geo ranking; the real Nunjucks
// templates; the real packages/db queries over real in-memory SQLite whose DDL
// comes from schemaFor(), i.e. from the migrations. Nothing these two routes
// touch leaves the machine, so NOTHING is mocked -- there is not a single
// vi.fn() in this file except a console.error silencer.
//
// PARITY CLAIMS. Where a comment says "Django does X", X was read out of
// /Users/jasoncartwright/Sites/foodcharity (gfwfbn/views.py, givefood/urls.py,
// givefood/settings.py, givefood/models/{foodbank,needs}.py,
// givefood/const/general.py and the wfbn/foodbank/md templates). Two claims
// needed Python actually RUN to settle, and it was -- CPython 3.13.0 on this
// machine, see the CRLF test below. Nothing here cites a Django version or a
// production measurement, because neither was available to this file.
//
// MUTATION-TESTED, in an rsync'd copy of the tree OUTSIDE the repo
// (TESTING.md's "several suites were mutation-tested"). 29 mutants across
// these two handlers, index.ts's route-registration order, middleware/
// cacheTag.ts and middleware/pageCacheControl.ts, @givefood/models,
// @givefood/urls, packages/db's foodbank/location queries and
// lib/findLocations.ts; 27 killed. A sample, each actually run rather than
// imagined:
//   - fullNameFoodbank swapped for fullNameLocaleAware with a locale -- 1
//   - the null-latestNeed fallback "" turned into the "Nothing" sentinel -- 1
//   - the blank-line strip dropped from the need list, and from the excess
//     list -- 1 each
//   - the excess heading gated on the stripped list instead of the raw
//     column -- 1
//   - skip_first turned off, the quantity cut to 19, lat and lng swapped, and
//     the origin hardcoded -- 1 each
//   - the nearby 404 guard removed, so a bad slug scanned before it threw -- 1
//   - /md/needs/at/:slug/:locslug/ registered ahead of .../nearby/ -- 1
//   - cacheTag's `(?:/md)?` deleted, pageCacheControl's nearby rule anchored
//     at ^/needs/at/, and text/markdown dropped from CACHEABLE_TYPES -- 1 each
//   - either Content-Type changed to text/html or text/plain -- 1 each
//   - networkUrl returning null instead of false; fullNameFoodbank losing its
//     DONT_APPEND_FOOD_BANK check; nonEmptyLines splitting on /\r?\n/ -- 1 each
//   - getFoodbankBySlug gaining `published = 1`; either candidate scan losing
//     `is_closed = 0`; a genuinely second D1 session opened -- 1 each
//
// ONE MUTANT SURVIVED AND THE FILE WAS STRENGTHENED FOR IT: feeding the
// template's sentinel gate the STRIPPED text instead of the raw column. The
// "Unknown\n" test in the need-gate section below was written to kill it, and
// does.
//
// TWO SURVIVORS ARE EQUIVALENT and were left alone. Keying findLocations'
// parent lookup on the wrong food bank changes nothing here, because
// nearby.njk reads `foodbank_name`/`foodbank_slug` off the
// foodbanklocation_full view and the parent row supplies only `facebook_page`
// and `latest_need_*`, none of which this template renders. And hoisting
// `const session = dbSession(c)` into its call site is one session either way
// -- a mutant that opens a real second one IS killed.

const ORIGIN = "https://www.givefood.org.uk";

type Bindable = null | number | bigint | string | Uint8Array;

// One statement as it reached the engine: the SQL text and the values bound to
// it. The bindings matter as much as the text -- the difference between
// mdFoodbank costing one round trip and costing three is invisible in a body
// assertion, and so is a nearby page that hydrated every food bank in the
// country instead of the twelve it ranked.
interface Prepared {
  sql: string;
  params: Bindable[];
}

// The slice of the D1 Sessions API packages/db uses, over node:sqlite. Same
// shim as routes/wfbn/foodbank.test.ts and routes/wfbn/nearby.test.ts,
// including its `batch` -- getFoodbankBySlug sends the food bank row and its
// latest need as ONE batch and indexes straight into the result array, so this
// must run them in order and return one result per input.
function d1Session(db: DatabaseSync, prepared: Prepared[]): D1DatabaseSession {
  const statement = (sql: string, entry: Prepared) => ({
    sql,
    get params() {
      return entry.params;
    },
    bind: (...next: unknown[]) => {
      entry.params = next as Bindable[];
      return statement(sql, entry);
    },
    first: async <T>() => (db.prepare(sql).get(...entry.params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...entry.params), success: true, meta: {} }),
    run: async () => {
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
    batch: async (statements: Array<{ sql: string; params: Bindable[] }>) =>
      statements.map((s) => ({ results: db.prepare(s.sql).all(...s.params), success: true, meta: {} })),
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let prepared: Prepared[];
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
  } as unknown as AppEnv["Bindings"];
}

// ---------------------------------------------------------------------------
// Seeds. Only the columns these two pages read are parameterised; every other
// NOT NULL column is filled with something the real migration accepts, so a
// seeded row is one production would have taken.
//
// latitude/longitude are REAL columns SEPARATE from the lat_lng TEXT string,
// and the nearby page uses both: lat_lng is split for the search ORIGIN, while
// latitude/longitude are what the two candidate scans rank. Every seed sets
// them consistently, which is what production does -- but they are genuinely
// independent columns, and the junk-lat_lng test below relies on that.
// ---------------------------------------------------------------------------

interface FoodbankSeed {
  id: number;
  slug: string;
  name: string;
  lat: number;
  lng: number;
  latLng?: string;
  altName?: string | null;
  address?: string;
  postcode?: string;
  country?: string;
  deliveryAddress?: string | null;
  network?: string | null;
  url?: string;
  contactEmail?: string;
  phoneNumber?: string | null;
  secondaryPhoneNumber?: string | null;
  facebookPage?: string | null;
  isClosed?: 0 | 1;
  latestNeedId?: number | null;
}

function seedFoodbank(s: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, alt_name, slug, address, postcode, country, lat_lng,
       latitude, longitude, delivery_address, network, charity_number, charity_just_foodbank,
       charity_name, facebook_page, contact_email, phone_number, secondary_phone_number, url,
       shopping_list_url, address_is_administrative, is_closed, no_locations, no_donation_points,
       days_between_needs, latest_need_id, created, modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?, ?, ?, ?, ?, 0, ?, 0, 0, 14, ?,
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
    s.latLng ?? `${s.lat},${s.lng}`,
    s.lat,
    s.lng,
    s.deliveryAddress ?? null,
    s.network ?? null,
    s.facebookPage ?? null,
    s.contactEmail ?? `info@${s.slug}.invalid`,
    s.phoneNumber ?? null,
    s.secondaryPhoneNumber ?? null,
    s.url ?? `https://${s.slug}.invalid/`,
    `https://${s.slug}.invalid/list/`,
    s.isClosed ?? 0,
    s.latestNeedId ?? null,
  );
}

// `created`/`modified` are TEXT and are written in Django's own spelling
// ("2026-09-05 19:28:08.853000", a space and six digits of microseconds)
// throughout, because that is what the ETL copied out of Postgres and what
// every lexicographic comparison in this codebase is written against.
function seedNeed(o: { id: number; foodbankId: number; changeText: string; excess?: string | null }): void {
  db.prepare(
    `INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, excess_change_text,
       published, input_method, created, modified)
     VALUES (?, ?, ?, ?, ?, 1, 'scrape', '2026-09-05 19:28:08.853000', '2026-09-05 19:28:08.853000')`,
  ).run(o.id, String(o.id).padStart(32, "b"), o.foodbankId, o.changeText, o.excess ?? null);
}

function seedLocation(o: { id: number; foodbankId: number; name: string; slug: string; lat: number; lng: number; isClosed?: 0 | 1 }): void {
  db.prepare(
    `INSERT INTO foodbanklocation (id, uuid, foodbank_id, name, slug, address, postcode, country,
       lat_lng, latitude, longitude, is_closed, modified)
     VALUES (?, ?, ?, ?, ?, '1 Side Street', 'SP1 1AA', 'England', ?, ?, ?, ?,
       '2020-01-01 00:00:00.000000')`,
  ).run(o.id, String(o.id).padStart(32, "e"), o.foodbankId, o.name, o.slug, `${o.lat},${o.lng}`, o.lat, o.lng, o.isClosed ?? 0);
}

// THE FIXTURE IS BOTH TESTS AT ONCE. Ids 1-5 and every location carry real
// Wiltshire coordinates, so the nearby ranking INTERLEAVES the two row kinds
// (location, location, organisation, location, location, organisation,
// organisation) -- a port that ranked food banks and locations as two separate
// lists and concatenated them renders a plausible page and fails that
// assertion. Ids 6-11 exist for the INDEX page's branches and are strung out
// due north on a single meridian at 0.1 degree intervals, so they land in a
// known order at the far end of the same list rather than muddling the
// interesting part of it.
//
// Distances from Salisbury (51.0688,-1.7945) in the miles the page prints,
// computed independently of the code under test with CPython at
// @givefood/geo's own R_EARTHDISTANCE (6378168 m) and its haversine form:
//
//   fb   1 salisbury        0.000000   the page's own subject -- index 0
//   loc 101 harnham         0.000000   ties with it, on the same spot
//   loc 102 bemerton        0.798603
//   fb   2 wilton           2.950225
//   loc 104 downton         5.137572
//   loc 105 tisbury        12.245657
//   fb   3 andover         16.587269
//   fb   5 shaftesbury     18.034474
//   fb   6 bath            64.412092
//   fb   7 truro           71.329198
//   fb   8 fb-town         78.246304
//   fb   9 salvation-army  85.163410
//   fb  11 crlf-town       98.997622
//
// And two rows that MUST NEVER APPEAR, both sited ~13 metres from Salisbury so
// they would rank second and third if the is_closed filters stopped working:
//
//   fb   4 closed-bank     is_closed = 1
//   loc 103 closed-outreach is_closed = 1
//
// (fb 10 closed-town is closed too, and sits at 92.080516 mi -- between
// salvation-army and crlf-town, so its absence from the list is an omission in
// the MIDDLE of a sequence rather than a missing tail.)
//
// What each food bank turns on or off on the INDEX page:
//
//   1  salisbury       the full one -- a need list with a blank line in it, an
//                      excess list with one too, a Trussell membership, a
//                      delivery address, two phone numbers, a Facebook page, a
//                      url that already has a querystring, and an address
//                      containing both an apostrophe and a CRLF
//   2  wilton          plain; the row whose latest_need_id the no-need-row and
//                      B12 tests null out
//   6  bath            change_text "Unknown" -- the sentinel branch -- WITH an
//                      excess list, which the sentinel takes down with it.
//                      alt_name set, which this page must ignore
//   7  truro           change_text "Nothing", network "Independent"
//   8  fb-town         change_text "Facebook", with a facebook_page
//   9  salvation-army  a DONT_APPEND_FOOD_BANK name, and no network at all
//  10  closed-town     is_closed = 1
//  11  crlf-town       need and excess text with Windows line endings, and a
//                      network value outside FOODBANK_NETWORK_CHOICES
function seed(): void {
  seedFoodbank({
    id: 1,
    slug: "salisbury",
    name: "Salisbury",
    lat: 51.0688,
    lng: -1.7945,
    // The apostrophe is the character an autoescape regression turns into
    // &#39; in a plain-text response, and the CRLF is what the ETL copied out
    // of Django's own address column. Both are printed verbatim below.
    address: "12 St John's Street\r\nHarnham",
    deliveryAddress: "Unit 4, Churchfields Industrial Estate",
    network: "Trussell",
    url: "https://salisburyfoodbank.org.uk/?utm_source=newsletter",
    contactEmail: "info@salisburyfoodbank.org.uk",
    phoneNumber: "01722 580180",
    secondaryPhoneNumber: "07700 900123",
    facebookPage: "salisburyfoodbank",
    latestNeedId: 101,
  });
  seedNeed({ id: 101, foodbankId: 1, changeText: "Tinned soup\n\nLong life milk\nNappies (size 5)", excess: "Baked beans\n\nPasta" });

  seedFoodbank({ id: 2, slug: "wilton", name: "Wilton", lat: 51.08, lng: -1.86, latestNeedId: 102 });
  seedNeed({ id: 102, foodbankId: 2, changeText: "Nappies" });

  seedFoodbank({ id: 3, slug: "andover", name: "Andover", lat: 51.2113, lng: -1.4871, latestNeedId: 103 });
  seedNeed({ id: 103, foodbankId: 3, changeText: "Rice" });

  // Closed, and sited about thirteen metres from Salisbury -- so it is the
  // second nearest thing in the fixture and would head the nearby list if
  // `is_closed = 0` ever fell out of getOpenFoodbankCoordinates. It keeps a
  // page of its own (Django's get_object_or_404 does not filter is_closed),
  // which is what the closed-subject nearby test below is about.
  seedFoodbank({ id: 4, slug: "closed-bank", name: "Closed Bank", lat: 51.0689, lng: -1.7946, isClosed: 1, latestNeedId: 104 });
  seedNeed({ id: 104, foodbankId: 4, changeText: "Nothing" });

  seedFoodbank({ id: 5, slug: "shaftesbury", name: "Shaftesbury", lat: 51.0057, lng: -2.1968, latestNeedId: 105 });
  seedNeed({ id: 105, foodbankId: 5, changeText: "Pasta" });

  // alt_name is deliberately NOT "Banc Bwyd Bath": that is what the cy branch
  // of fullNameLocaleAware would build from the bare name anyway, so an
  // alt_name-shaped alt_name would leave the test unable to tell "alt_name was
  // ignored" from "alt_name was used".
  seedFoodbank({
    id: 6,
    slug: "bath",
    name: "Bath",
    altName: "Pantri Bwyd Caerfaddon",
    lat: 52.0,
    lng: -1.7945,
    network: "IFAN",
    latestNeedId: 106,
  });
  seedNeed({ id: 106, foodbankId: 6, changeText: "Unknown", excess: "Baked beans" });

  seedFoodbank({ id: 7, slug: "truro", name: "Truro", lat: 52.1, lng: -1.7945, network: "Independent", latestNeedId: 107 });
  seedNeed({ id: 107, foodbankId: 7, changeText: "Nothing" });

  seedFoodbank({ id: 8, slug: "fb-town", name: "Fbtown", lat: 52.2, lng: -1.7945, facebookPage: "fbtownfoodbank", latestNeedId: 108 });
  seedNeed({ id: 108, foodbankId: 8, changeText: "Facebook" });

  seedFoodbank({ id: 9, slug: "salvation-army", name: "Salvation Army", lat: 52.3, lng: -1.7945, latestNeedId: 109 });
  seedNeed({ id: 109, foodbankId: 9, changeText: "Soup" });

  seedFoodbank({ id: 10, slug: "closed-town", name: "Closed Town", lat: 52.4, lng: -1.7945, isClosed: 1, latestNeedId: 110 });
  seedNeed({ id: 110, foodbankId: 10, changeText: "Cereal" });

  seedFoodbank({ id: 11, slug: "crlf-town", name: "Crlf Town", lat: 52.5, lng: -1.7945, network: "Trussell Trust", latestNeedId: 111 });
  seedNeed({ id: 111, foodbankId: 11, changeText: "Beans\r\n\r\nRice\r\n", excess: "Squash\r\nCoffee" });

  seedLocation({ id: 101, foodbankId: 1, name: "Harnham Centre", slug: "harnham", lat: 51.0688, lng: -1.7945 });
  seedLocation({ id: 102, foodbankId: 2, name: "Bemerton Pantry", slug: "bemerton", lat: 51.075, lng: -1.81 });
  seedLocation({ id: 103, foodbankId: 2, name: "Closed Outreach", slug: "closed-outreach", lat: 51.0689, lng: -1.7946, isClosed: 1 });
  seedLocation({ id: 104, foodbankId: 3, name: "Downton Hub", slug: "downton", lat: 51.0, lng: -1.75 });
  seedLocation({ id: 105, foodbankId: 5, name: "Tisbury Store", slug: "tisbury", lat: 51.062, lng: -2.076 });

  // A renamed food bank, for the "the /md/ mirror is not slug-redirected"
  // test. Seeded HERE rather than inside that test on purpose: the memo warmed
  // in beforeEach caches whatever the table held at that moment, so a row
  // inserted later would never be seen.
  db.prepare(
    "INSERT INTO slugredirect (id, old_slug, new_slug, created, modified) VALUES (1, 'sarum', 'salisbury', '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')",
  ).run();
}

beforeEach(async () => {
  db = new DatabaseSync(":memory:");
  // schemaFor, not hand-written DDL: getFoodbankBySlug reads through the
  // `foodbankchange_full` VIEW and findLocations' hydration reads through
  // `foodbanklocation_full` (github #51 -- eight suites 500'd at once when the
  // first of those started doing so), and `slugredirect` is what the
  // slugRedirect middleware reads.
  db.exec(schemaFor("foodbank", "foodbankchange", "foodbankchange_full", "foodbanklocation", "foodbanklocation_full", "slugredirect"));
  seed();
  prepared = [];
  sessions = 0;

  // WARM THE SLUG-REDIRECT MEMO BEFORE COUNTING ANYTHING. middleware/
  // slugRedirect.ts holds its map in a MODULE-level memo with a 5-minute TTL.
  // No /md/ URL ever triggers that lookup (its SLUG_PATTERN is anchored at
  // /needs/at/, which /md/needs/at/ does not start with -- see the test that
  // pins exactly this), but the two tests here that DO fetch an unprefixed
  // /needs/at/ URL would otherwise open a second D1 session and issue a
  // `SELECT ... FROM slugredirect` on whichever of them ran first. Warming it
  // here removes that order-dependence, which is what makes a suite go flaky
  // the day someone adds a `.only`.
  await get("/needs/at/warm-the-memo/");
  prepared = [];
  sessions = 0;
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

// `async`, not a bare arrow: app.fetch is typed Response | Promise<Response>.
const get = async (path: string, init?: RequestInit): Promise<Response> => app.fetch(new Request(`${ORIGIN}${path}`, init), env(), execCtx);
const body = async (path: string): Promise<string> => (await get(path)).text();

// The nearby page is one bullet per line and nothing else, so its rows are
// simply the lines that start one. Kept as raw lines rather than parsed into
// fields because on a plain-text format the punctuation IS the contract.
const nearbyRows = async (path: string): Promise<string[]> => (await body(path)).split("\n").filter((line) => line.startsWith("- "));

describe("mdFoodbank -- the whole document", () => {
  // THE ONE ASSERTION THIS FILE IS REALLY FOR. Markdown has no elements to
  // assert against, so the contract is the exact byte sequence: which sections
  // appear, in which order, and how many blank lines separate them. Every
  // `{% if %}` in index.njk is exercised in the positive here and in the
  // negative by the tests that follow.
  //
  // Things worth naming inside it, because each is a real hazard:
  //   * "Tinned soup\nLong life milk" -- the stored text has a BLANK LINE
  //     between those two, dropped by get_change_text(). On the HTML page a
  //     surviving blank line is a stray <br>; here it is a paragraph break,
  //     which in markdown ends the list;
  //   * "Baked beans, Pasta" -- the excess list is comma-joined by the
  //     template's own `{% for %}`/`{% if not loop.last %}`, from the
  //     blank-line-stripped list. Django spells the same loop with
  //     `forloop.last`;
  //   * the address keeps its CRLF and its apostrophe -- `{% autoescape
  //     false %}`, matching Django's `{% autoescape off %}`. An autoescape
  //     regression prints `12 St John&#39;s Street` to a markdown client;
  //   * the website link's target is the RAW url, querystring and all. It is
  //     NOT url_with_ref() -- this page does not add `ref=givefood.org.uk`,
  //     and Django's index.md does not either;
  //   * the THREE blank lines before "## Address" and the two before
  //     "## Contact" are template artefacts, present in Django's index.md
  //     too -- pinned so that "tidying up the whitespace" registers as a
  //     change rather than passing silently.
  it("renders the full document, byte for byte, for a food bank with every optional section", async () => {
    expect(await body("/md/needs/at/salisbury/")).toBe(
      "# Salisbury Foodbank\n" +
        "\n" +
        "## Items needed\n" +
        "\n" +
        "Tinned soup\nLong life milk\nNappies (size 5)\n" +
        "\n" +
        "## Items not needed\n" +
        "\n" +
        "Baked beans, Pasta\n" +
        "\n\n" +
        "## Address\n" +
        "\n" +
        "12 St John's Street\r\nHarnham\n" +
        "SP2 8LZ\n" +
        "England\n" +
        "\n" +
        "## Delivery address\n" +
        "\n" +
        "Unit 4, Churchfields Industrial Estate\n" +
        "\n\n" +
        "## Contact\n" +
        "\n" +
        "- Website: [https://salisburyfoodbank.org.uk/?utm_source=newsletter](https://salisburyfoodbank.org.uk/?utm_source=newsletter)\n" +
        "- Phone: [01722 580180](tel:01722 580180)\n" +
        "- Phone: [07700 900123](tel:07700 900123)\n" +
        "- Email: [info@salisburyfoodbank.org.uk](mailto:info@salisburyfoodbank.org.uk)\n" +
        "- Facebook: [salisburyfoodbank](https://www.facebook.com/salisburyfoodbank)\n" +
        "\n" +
        "## Network\n" +
        "\n" +
        "[Trussell](https://www.trussell.org.uk/)\n" +
        "\n" +
        "## Links\n" +
        "\n" +
        "- [Locations](/md/needs/at/salisbury/locations/)\n" +
        "- [Donation points](/md/needs/at/salisbury/donationpoints/)\n" +
        "- [News](/md/needs/at/salisbury/news/)\n" +
        "- [Charity](/md/needs/at/salisbury/charity/)\n" +
        "- [Nearby](/md/needs/at/salisbury/nearby/)\n" +
        "\n",
    );
  });

  // THE OTHER END OF THE SAME TEMPLATE: every optional section absent. Whole
  // body again, because what matters is that the gaps CLOSE cleanly -- a
  // missing phone number must leave no "- Phone: [](tel:)" line, and a missing
  // delivery address no empty "## Delivery address" heading.
  //
  // salvation-army additionally pins two things at once: DONT_APPEND_FOOD_BANK
  // (givefood/const/general.py) so the heading is a bare "Salvation Army" with
  // no "Foodbank" appended, and a NULL network so the whole "## Network"
  // section disappears rather than emitting an empty link.
  it("closes every gap when the optional columns are all empty", async () => {
    expect(await body("/md/needs/at/salvation-army/")).toBe(
      "# Salvation Army\n" +
        "\n" +
        "## Items needed\n" +
        "\n" +
        "Soup\n" +
        "\n\n" +
        "## Address\n" +
        "\n" +
        "12 High Street\r\nHarnham\n" +
        "SP2 8LZ\n" +
        "England\n" +
        "\n\n" +
        "## Contact\n" +
        "\n" +
        "- Website: [https://salvation-army.invalid/](https://salvation-army.invalid/)\n" +
        "- Email: [info@salvation-army.invalid](mailto:info@salvation-army.invalid)\n" +
        "\n\n" +
        "## Links\n" +
        "\n" +
        "- [Locations](/md/needs/at/salvation-army/locations/)\n" +
        "- [Donation points](/md/needs/at/salvation-army/donationpoints/)\n" +
        "- [News](/md/needs/at/salvation-army/news/)\n" +
        "- [Charity](/md/needs/at/salvation-army/charity/)\n" +
        "- [Nearby](/md/needs/at/salvation-army/nearby/)\n" +
        "\n",
    );
  });

  // "Foodbank" is appended for every name NOT in DONT_APPEND_FOOD_BANK, and
  // alt_name is not consulted at all. That second half is the mutant worth
  // killing: fullNameLocaleAware() exists three lines away in the same module
  // and takes alt_name, and swapping it in here is exactly the kind of
  // "shouldn't these be the same function?" edit that reads as a tidy-up. It
  // would be Django-correct on THIS page only by accident -- md_foodbank is
  // outside i18n_patterns so get_language() is "en", where full_name() ignores
  // alt_name too.
  it("appends Foodbank to the name and never looks at alt_name", async () => {
    expect(await body("/md/needs/at/bath/")).toContain("# Bath Foodbank\n");
    expect(await body("/md/needs/at/bath/")).not.toContain("Pantri Bwyd Caerfaddon");
  });
});

describe("mdFoodbank -- the need gate, which takes the excess list down with it", () => {
  // The three sentinels are compared against the RAW change_text, and the
  // whole Items-needed block -- INCLUDING the "Items not needed" section
  // nested inside it -- vanishes for all three. Bath is the one that shows the
  // nesting: it has a real excess list ("Baked beans") and prints neither
  // heading, because the excess `{% if %}` lives inside the sentinel one.
  // Django's index.md nests them identically, so this is parity rather than a
  // port defect -- and it is worth pinning precisely because "the excess list
  // is unrelated to the need list, pull it out one level" is a plausible edit
  // that would start showing an excess list on 200-odd sentinel pages.
  it("drops the needs AND the excess list for Unknown, Nothing and Facebook alike", async () => {
    for (const slug of ["bath", "truro", "fb-town"]) {
      const md = await body(`/md/needs/at/${slug}/`);
      expect(md).not.toContain("## Items needed");
      expect(md).not.toContain("## Items not needed");
      expect(md).not.toContain("Unknown");
      expect(md).not.toContain("Nothing");
    }
    // Bath really does own an excess list, so the negative above is about the
    // gate and not about an empty column.
    expect(await body("/md/needs/at/bath/")).not.toContain("Baked beans");
    expect(db.prepare("SELECT excess_change_text FROM foodbankchange WHERE id = 106").get()).toEqual({ excess_change_text: "Baked beans" });
  });

  // The sentinel gate is the ONLY thing it turns off. Contact details, the
  // address and the links all still render -- which is the point of the page
  // for a food bank whose needs are unknown. The HTML twin swaps in a whole
  // different block here; the markdown one just omits two sections.
  it("keeps the address, contact and links sections on a sentinel page", async () => {
    const md = await body("/md/needs/at/truro/");

    expect(md).toContain("# Truro Foodbank\n");
    expect(md).toContain("## Address\n");
    expect(md).toContain("- Email: [info@truro.invalid](mailto:info@truro.invalid)");
    expect(md).toContain("- [Nearby](/md/needs/at/truro/nearby/)");
  });

  // A "Facebook" need means the HTML page embeds the food bank's Facebook
  // feed. There is no embed to render in markdown, so this page simply says
  // nothing about needs at all -- the Facebook LINK it prints is the ordinary
  // contact-section one every food bank with a facebook_page gets, not a
  // substitute for the missing list. Documented, not endorsed: an LLM reading
  // /md/needs/at/fb-town/ has no way to learn that a list exists elsewhere.
  it("SUSPECT: the Facebook sentinel leaves the markdown page with no needs and no explanation", async () => {
    const md = await body("/md/needs/at/fb-town/");

    expect(md).not.toContain("## Items needed");
    expect(md).not.toContain("facebook.com/fbtownfoodbank/posts");
    // Only the ordinary contact line, which every food bank with a page gets.
    expect(md).toContain("- Facebook: [fbtownfoodbank](https://www.facebook.com/fbtownfoodbank)");
  });

  // SUSPECT, PINNED AS-IS -- and it is the port faithfully reproducing Django,
  // not a port defect. A food bank whose latest_need_id is NULL has NO need
  // row, so the handler's `?? ""` makes change_text the empty string -- a
  // real, distinct value, not the "Nothing" sentinel. "" is none of the three
  // sentinels, so the page falls through into the HAS-A-LIST branch and prints
  // an "## Items needed" heading above nothing.
  //
  // Django lands in the same place by a different road: `foodbank.latest_need`
  // is None, `{{ foodbank.latest_need.change_text }}` silently resolves to
  // Django's string_if_invalid (""), and `"" != "Unknown"` is True there too.
  // foodbank.ts's own comment names this as the semantics it is matching.
  //
  // On the HTML page the same state produces an empty <p>; here it produces a
  // heading with three blank lines under it, which a markdown-to-text pipeline
  // will render as a section claiming the food bank needs nothing in
  // particular. Asserted rather than fixed because the fix is in a source file
  // this test may not touch.
  it("SUSPECT: a food bank with no need row at all gets an empty Items needed section", async () => {
    db.prepare("UPDATE foodbank SET latest_need_id = NULL WHERE slug = 'wilton'").run();

    const md = await body("/md/needs/at/wilton/");
    expect(md).toContain("# Wilton Foodbank\n\n## Items needed\n\n\n\n\n## Address\n");
    expect(md).not.toContain("Nappies");
  });

  // THE RAW/STRIPPED SPLIT, WHICH IS THE HANDLER'S WHOLE REASON FOR PASSING
  // TWO VALUES. `latest_need_change_text` is the RAW column the template's
  // sentinel comparison reads; `latest_need_get_change_text` is the
  // blank-line-stripped text it PRINTS. They differ only in whitespace, so
  // collapsing them looks free -- and is, on every food bank whose need text
  // is not a sentinel with a stray newline on it.
  //
  // A scrape that stored "Unknown\n" is exactly that food bank. The raw value
  // is not equal to "Unknown", so the gate opens and the page prints an Items
  // needed section whose single item is the word Unknown; feed the gate the
  // stripped value instead and the section vanishes. Django compares
  // `foodbank.latest_need.change_text` (the raw field) and prints
  // `get_change_text` (the stripped one), so this is parity, and it is the
  // mutant this pair of context keys exists to prevent.
  it("gates on the raw column, so a sentinel with a trailing newline is not a sentinel", async () => {
    db.prepare("UPDATE foodbankchange SET change_text = 'Unknown\n' WHERE id = 107").run();

    expect(await body("/md/needs/at/truro/")).toContain("## Items needed\n\nUnknown\n");
  });

  // NEITHER STATEMENT FILTERS ON `published`. latest_need_id is a plain FK and
  // getFoodbankBySlug follows it wherever it points, so an unpublished need
  // that some admin action has made "latest" is served to the public exactly
  // as a published one would be. Django's select_related("latest_need") does
  // the same, so this is parity -- pinned because "add published = 1,
  // obviously" is a one-line change that would blank the list on any food bank
  // whose latest need has not been published yet, which is the state a
  // half-finished admin edit leaves behind.
  it("shows an UNPUBLISHED need if latest_need_id points at one", async () => {
    db.prepare("UPDATE foodbankchange SET published = 0 WHERE id = 101").run();

    expect(await body("/md/needs/at/salisbury/")).toContain("Tinned soup\nLong life milk\nNappies (size 5)");
  });

  // The excess `{% if %}` is on the RAW column while the LIST it prints is the
  // blank-line-stripped one, and those two disagree for whitespace-only text:
  // "  \n \n" is truthy, so the heading renders, but every line strips to
  // empty so the list is empty. The result is a heading with nothing under it.
  //
  // Django produces the same thing by a slightly different route --
  // get_excess_text() returns "" and get_excess_text_list() is `"".split("\n")`
  // == [""], one empty item, which prints as nothing -- so the bytes match and
  // this is parity. Pinned because it is the concrete case that says the gate
  // and the list are read from two different values, which is the handler's
  // whole reason for keeping `latest_need_excess_text` separate from
  // `excess_text_list`.
  it("emits an empty Items not needed heading for whitespace-only excess text", async () => {
    db.prepare("UPDATE foodbankchange SET excess_change_text = '  \n \n' WHERE id = 101").run();

    const md = await body("/md/needs/at/salisbury/");
    expect(md).toContain("## Items not needed\n\n\n\n\n## Address\n");
    expect(md).not.toContain("Baked beans");
  });

  // An excess column that is genuinely NULL takes the heading with it, which
  // is the other half of the gate above.
  it("omits the Items not needed heading entirely when the column is NULL", async () => {
    expect(await body("/md/needs/at/wilton/")).not.toContain("## Items not needed");
  });

  // SUSPECTED BUG, PINNED RATHER THAN FIXED, AND VERIFIED AGAINST PYTHON.
  // Django's get_text() strips blank lines with `the_text.splitlines()`
  // (givefood/models/needs.py:257), which is UNIVERSAL newlines -- it splits
  // on \r\n and \r as well as \n and discards the separator.
  // @givefood/models' nonEmptyLines(), which this handler uses for both the
  // need list and the excess list, is `text.split("\n")`, so a carriage return
  // survives on the end of every line of a Windows-line-ending scrape.
  //
  // Run on this machine, CPython 3.13.0, not reasoned about:
  //   '\n'.join([l for l in 'Beans\r\n\r\nRice\r\n'.splitlines() if l.strip()])
  //     -> 'Beans\nRice'
  // where this page emits 'Beans\r\nRice\r'.
  //
  // In the NEED list the stray \r is invisible in most renderers. In the
  // EXCESS list it is not: the template comma-joins the items, so a CR lands
  // in the middle of a sentence -- "Squash\r, Coffee". Both are pinned below.
  //
  // NOTE FOR ANYONE FIXING IT: workers/site/src/lib/needDisplay.test.ts
  // carries a test whose comment says "Django splits on the literal \n, never
  // on a universal-newlines regex". That is true of get_change_text_list()
  // (needs.py:135) and NOT of get_text(), which is the method both that module
  // and this one reproduce. The behaviour those two files pin agrees with each
  // other and disagrees with Django.
  it("SUSPECTED BUG: a CRLF scrape keeps its carriage returns, where Django's splitlines() drops them", async () => {
    const md = await body("/md/needs/at/crlf-town/");

    expect(md).toContain("## Items needed\n\nBeans\r\nRice\r\n");
    expect(md).toContain("## Items not needed\n\nSquash\r, Coffee\n");
    // Django would have produced these instead.
    expect(md).not.toContain("Beans\nRice\n");
    expect(md).not.toContain("Squash, Coffee");
  });
});

describe("mdFoodbank -- the network section", () => {
  // Foodbank.network_url() (givefood/models/foodbank.py:356-361), and the
  // template's own `network != "Independent"` guard on top of it. Only two of
  // FOODBANK_NETWORKS have a URL, and the third is suppressed by name.
  it("links Trussell and IFAN to their own sites and says nothing for Independent", async () => {
    expect(await body("/md/needs/at/salisbury/")).toContain("## Network\n\n[Trussell](https://www.trussell.org.uk/)\n");
    expect(await body("/md/needs/at/bath/")).toContain("## Network\n\n[IFAN](https://www.foodaidnetwork.org.uk/)\n");
    expect(await body("/md/needs/at/truro/")).not.toContain("## Network");
    expect(await body("/md/needs/at/salvation-army/")).not.toContain("## Network");
  });

  // SUSPECT, and a divergence from Django on an unreachable input. networkUrl()
  // returns the boolean `false` for anything that is neither Trussell nor
  // IFAN, and the template drops that straight into a link target -- so a
  // network value outside FOODBANK_NETWORK_CHOICES yields the literal
  // "[Trussell Trust](false)". Django's Python-side `return False` renders as
  // "[Trussell Trust](False)", capitalised, so even the broken output differs.
  //
  // NOT REACHABLE through the admin, which offers exactly three choices
  // (givefood/const/general.py:37-42) and whose "Trussell Trust" was renamed
  // to "Trussell" -- but the D1 column has no CHECK constraint and the ETL
  // copies whatever Postgres held. Pinned as the mutant-killer for
  // networkUrl()'s fallback: returning null or "" instead of false renders an
  // empty target, which no other test in this repo would notice.
  it("SUSPECT: an unrecognised network renders the literal string false as its link target", async () => {
    expect(await body("/md/needs/at/crlf-town/")).toContain("## Network\n\n[Trussell Trust](false)\n");
  });
});

describe("mdFoodbank -- the response envelope", () => {
  // Django's md_foodbank is @cache_page(SECONDS_IN_DAY) (gfwfbn/views.py:688),
  // and middleware/pageCacheControl.ts has no rule matching this path, so it
  // falls through to that same DAY default. text/markdown is one of the three
  // CACHEABLE_TYPES -- lose it from that regex and this whole family goes
  // uncached with nothing visible to show for it.
  //
  // The browser number is deliberately NOT Django's: BROWSER_MAX_AGE is 300
  // because a browser cache cannot be purged and this page's entire purpose is
  // the currency of the list on it.
  it("serves cacheable markdown: five minutes in the browser, a day at the purgeable edge", async () => {
    const res = await get("/md/needs/at/salisbury/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    expect(res.headers.get("Content-Language")).toBe("en");
  });

  // THE TAG IS WHY THE DAY ABOVE IS SAFE. cacheTag.ts's FOODBANK_PATH regex
  // begins `^(?:/md)?`, precisely so the markdown mirror is purged by the same
  // `fb-<slug>` queues/cachePurge.ts already sends when a need is published.
  // Drop those five characters and an edge copy of yesterday's shopping list
  // sits at /md/needs/at/<slug>/ for 24 hours with no way to revoke it -- and
  // because Cloudflare strips Cache-Tag before a browser sees it, nobody
  // outside could ever notice its absence.
  it("stamps the food bank's own purge tag on the markdown mirror too", async () => {
    expect((await get("/md/needs/at/salisbury/")).headers.get("Cache-Tag")).toBe("fb-salisbury");
    expect((await get("/md/needs/at/salisbury/nearby/")).headers.get("Cache-Tag")).toBe("fb-salisbury");
  });

  // ONE D1 SESSION, ONE ROUND TRIP, TWO STATEMENTS -- and nothing else.
  //
  // lib/session.ts opens a single withSession("first-unconstrained") per
  // request so every query sees one snapshot of a replicated database. The two
  // statements are getFoodbankBySlug's BATCH: one trip, not two.
  //
  // The negatives are the point. This page renders no map, no service area and
  // no locations, so unlike its HTML twin it must NOT issue hasServiceArea's
  // count; and being outside i18n_patterns it must never query
  // foodbankchangetranslation. The exhaustive list is what says so.
  it("reads the page from one session with nothing but the batched foodbank+need pair", async () => {
    await get("/md/needs/at/salisbury/");

    expect(sessions).toBe(1);
    expect(prepared.map((p) => [p.sql, p.params])).toEqual([
      ["SELECT * FROM foodbank WHERE slug = ?", ["salisbury"]],
      ["SELECT * FROM foodbankchange_full WHERE id = (SELECT latest_need_id FROM foodbank WHERE slug = ?)", ["salisbury"]],
    ]);
  });

  // An unknown slug is Django's get_object_or_404. It must reach the real 404
  // page and, above all, must NOT be stamped cacheable: pageCacheControl only
  // touches 200s and cacheTag only touches ok responses, so a mistyped slug
  // cannot poison the edge with a day-long negative entry.
  //
  // The 404 comes back as text/html, not text/markdown -- render404() is the
  // site's ordinary HTML page. Django does the same (its 404 handler knows
  // nothing about the view that raised), so this is parity; pinned because a
  // markdown client asking for a dead slug gets a page of HTML and this is the
  // only place that is written down.
  it("404s an unknown slug with the HTML error page, uncached and untagged", async () => {
    const res = await get("/md/needs/at/nowhere/");

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(res.headers.get("Cache-Tag")).toBeNull();
    expect(await res.text()).not.toContain("## Items needed");
  });

  // lib/appendSlash.ts, Django's APPEND_SLASH. The slashless spelling is what
  // a hand-typed URL and a good many inbound links look like -- and on a
  // format fetched by `curl` and by crawlers, more of them than on the HTML
  // side.
  it("redirects the slashless spelling of both routes rather than 404ing them", async () => {
    const index = await get("/md/needs/at/salisbury");
    expect(index.status).toBe(301);
    expect(index.headers.get("Location")).toBe(`${ORIGIN}/md/needs/at/salisbury/`);

    const nearby = await get("/md/needs/at/salisbury/nearby");
    expect(nearby.status).toBe(301);
    expect(nearby.headers.get("Location")).toBe(`${ORIGIN}/md/needs/at/salisbury/nearby/`);
  });

  // GET ONLY, matching Django. index.ts registers both with app.get; a stray
  // app.all would hand a POST to a handler whose response pageCacheControl
  // then stamps public for a day. Neither handler reads a body, so a POST that
  // reached one would render and be cached.
  it("does not answer a POST at all", async () => {
    expect((await get("/md/needs/at/salisbury/", { method: "POST" })).status).toBe(404);
    expect((await get("/md/needs/at/salisbury/nearby/", { method: "POST" })).status).toBe(404);
  });

  // A GET THAT WRITES IS THE FAILURE THIS ASSERTS AGAINST -- a route in this
  // repo has been caught with one before. A page stamped `public,
  // s-maxage=86400` cannot afford a side effect: the edge would serve it once
  // and swallow every subsequent one.
  it("issues nothing but SELECTs, on both routes and with any query string", async () => {
    await get("/md/needs/at/salisbury/?utm_source=newsletter&email=donor%40example.org");
    await get("/md/needs/at/salisbury/nearby/");

    expect(prepared).not.toHaveLength(0);
    for (const { sql } of prepared) expect(sql).toMatch(/^SELECT /);
  });

  // NOTHING ON EITHER PAGE COMES FROM THE VISITOR, which is the property that
  // makes `public, s-maxage=86400` safe. The HTML twin echoes ?email= into a
  // form field; these take no input at all, so two requests differing only in
  // their query string must produce identical bytes. Unlike the HTML pages
  // there is no render-time comment to normalise away first -- these handlers
  // never call buildPageContext -- so the comparison is exact.
  it("renders identical bytes whatever the query string says", async () => {
    const plain = await body("/md/needs/at/salisbury/");
    const noisy = await body("/md/needs/at/salisbury/?email=donor%40example.org&utm_source=x&q=%3Cscript%3E");

    expect(noisy).toBe(plain);
    expect(noisy).not.toContain("donor@example.org");
  });

  // The slug comparison is SQLite's default case-sensitive `=` on TEXT, so a
  // shouted URL is a 404 rather than a second, uncanonical spelling of the
  // page. Django's slug lookup is exact too.
  it("does not answer a differently-cased slug", async () => {
    expect((await get("/md/needs/at/SALISBURY/")).status).toBe(404);
    expect((await get("/md/needs/at/Salisbury/nearby/")).status).toBe(404);
  });

  // A D1 outage must produce the 500 page, not a markdown page with an empty
  // shopping list -- and must not be cached, or a day of "this food bank needs
  // nothing" goes out to everyone.
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

    const res = await app.fetch(new Request(`${ORIGIN}/md/needs/at/salisbury/`), broken, execCtx);

    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(await res.text()).not.toContain("Tinned soup");
  });

  // Django's GeoJSONPreload (givefood/middleware.py) lists url_names, and
  // neither md_foodbank nor md_foodbank_nearby is among them -- a markdown
  // response has no map to preload for. The port's geoJsonPreload compares
  // routePath against the unprefixed HTML literals, so it does not fire here
  // either. Asserted because that middleware runs on "*": a rule that matched
  // on the /needs/at/<slug>/ SUFFIX rather than the whole path would attach a
  // several-hundred-kilobyte preload hint to every markdown response.
  it("attaches no geojson preload hint to a markdown response", async () => {
    expect((await get("/md/needs/at/salisbury/")).headers.get("Link")).toBeNull();
    expect((await get("/md/needs/at/salisbury/nearby/")).headers.get("Link")).toBeNull();
    // The HTML twin does get one, so this is a per-route decision rather than
    // the middleware being switched off in this fixture.
    expect((await get("/needs/at/salisbury/")).headers.get("Link")).toBe(
      "</needs/at/salisbury/geo.json>; rel=preload; as=fetch; crossorigin=anonymous",
    );
  });
});

describe("mdFoodbank -- outside i18n_patterns, which is a routing fact and a rendering one", () => {
  // givefood/urls.py's "Markdown versions" block sits OUTSIDE i18n_patterns,
  // so there is no /cy/md/... and no /md/cy/... in Django and none here.
  // index.ts registers these two routes once, not once per locale like the
  // HTML family. Both spellings must 404 rather than becoming a second,
  // uncanonical copy of a document the edge is told to keep for a day.
  it("has no locale-prefixed spelling in either position", async () => {
    for (const locale of ["cy", "ga", "gd"]) {
      expect((await get(`/${locale}/md/needs/at/salisbury/`)).status).toBe(404);
      expect((await get(`/md/${locale}/needs/at/salisbury/`)).status).toBe(404);
      expect((await get(`/${locale}/md/needs/at/salisbury/nearby/`)).status).toBe(404);
    }
  });

  // DIVERGENCE FROM DJANGO, and this is the family where it actually bites.
  // Django's settings.py:100 has LocaleMiddleware active for every URL, not
  // just the i18n_patterns ones, so a `curl -H 'Accept-Language: cy'` at
  // /md/needs/at/bath/ activates Welsh in production: full_name() would return
  // the alt_name and get_text() would go looking for a FoodbankChangeTranslation.
  // This port resolves language from the path prefix ALONE
  // (middleware/resolveLanguage.ts, PLAN.md §3.5 "reproduce exactly, do not
  // improve" plus the deliberate removal of `Vary: Accept-Language` in issue
  // #39), and these routes have no prefix to read, so they are English for
  // everyone.
  //
  // Pinned rather than reported as a defect: it is a documented, deliberate
  // site-wide decision, and reversing it here alone would put one visitor's
  // language into a shared cache entry with no Vary to separate them. Recorded
  // here because /md/ is where a Django reader would most expect the old
  // behaviour to have survived.
  it("ignores Accept-Language entirely, unlike Django's LocaleMiddleware", async () => {
    const res = await get("/md/needs/at/bath/", { headers: { "Accept-Language": "cy,cy-GB;q=0.9" } });

    expect(res.headers.get("Content-Language")).toBe("en");
    const md = await res.text();
    expect(md).toContain("# Bath Foodbank\n");
    expect(md).not.toContain("Pantri Bwyd Caerfaddon");
    // And no translation lookup was even attempted.
    expect(prepared.map((p) => p.sql).filter((s) => s.includes("foodbankchangetranslation"))).toEqual([]);
  });

  // Every url() call in both templates goes through render()'s locale-bound
  // helper at the DEFAULT locale, because neither handler passes one. So every
  // link on a markdown page is an unprefixed /md/... path. A handler that
  // started threading c.get("lang") through would produce /cy/md/... links to
  // URLs that do not exist -- 404s in the one document format whose whole
  // audience follows links mechanically.
  it("emits only unprefixed /md/ links", async () => {
    const md = await body("/md/needs/at/salisbury/");

    for (const suffix of ["locations", "donationpoints", "news", "charity", "nearby"]) {
      expect(md).toContain(`(/md/needs/at/salisbury/${suffix}/)`);
    }
    expect(md).not.toContain("/cy/");
    // And no link back to the HTML page: index.md carries none, and neither
    // does the .njk. So the markdown mirror advertises the HTML site nowhere,
    // while the HTML page does advertise the markdown one.
    expect(md).not.toContain("](/needs/at/salisbury/)");
    expect(await body("/needs/at/salisbury/")).toContain('<link rel="alternate" type="text/markdown" href="/md/needs/at/salisbury/">');
  });

  // middleware/slugRedirect.ts's SLUG_PATTERN is anchored at
  // `^(/<locale>)?/needs/at/`, which /md/needs/at/ does not match -- so a
  // renamed food bank's markdown URL 404s where its HTML URL 301s. Django's
  // SlugRedirectMiddleware anchors its own pattern the same way --
  // givefood/middleware.py:177, `r'^(/[a-z]{2})?/needs/at/([-\w]+)(/[-\w]+)?/?$'`
  // (slugRedirect.ts's header comment cites :171 for it; the line is :177 in
  // the tree read here) -- so this IS parity and is pinned as such:
  // "obviously the redirect should cover /md/ too" is a one-character regex
  // edit that would silently diverge from production.
  //
  // Both halves are asserted from the same seeded row, so the negative cannot
  // pass by the redirect map simply being empty.
  it("does not slug-redirect the markdown mirror, matching Django's own anchoring", async () => {
    const html = await get("/needs/at/sarum/");
    expect(html.status).toBe(301);
    expect(html.headers.get("Location")).toBe("/needs/at/salisbury/");

    expect((await get("/md/needs/at/sarum/")).status).toBe(404);
    expect((await get("/md/needs/at/sarum/nearby/")).status).toBe(404);
  });
});

describe("mdFoodbankNearby -- the list, which is the whole page", () => {
  // THE HAPPY PATH, as the whole document rather than a handful of
  // `toContain`s. Every part of a row is here: the URL shape (two segments for
  // a location, one for an organisation), the name, the parent name a location
  // prints in brackets and an organisation does not, and the mileage.
  //
  // The order interleaves the two kinds -- location, location, organisation,
  // location, location, organisation, organisation -- which is what PLAN.md
  // §7.5.2's "rank as ONE list" means in practice. A port that took the
  // nearest N food banks and the nearest N locations and concatenated them
  // renders a perfectly plausible page and fails this.
  //
  // The three trailing newlines are the template's, and are pinned for the
  // same reason as the blank lines on the index page: they are what a markdown
  // parser sees.
  it("renders the whole nearby document, nearest first, with the right shape per kind", async () => {
    expect(await body("/md/needs/at/salisbury/nearby/")).toBe(
      "# Nearby - Salisbury Foodbank\n" +
        "\n" +
        "- [Harnham Centre](/md/needs/at/salisbury/harnham/) (Salisbury) - 0.0mi away\n" +
        "- [Bemerton Pantry](/md/needs/at/wilton/bemerton/) (Wilton) - 0.8mi away\n" +
        "- [Wilton](/md/needs/at/wilton/) - 3.0mi away\n" +
        "- [Downton Hub](/md/needs/at/andover/downton/) (Andover) - 5.1mi away\n" +
        "- [Tisbury Store](/md/needs/at/shaftesbury/tisbury/) (Shaftesbury) - 12.2mi away\n" +
        "- [Andover](/md/needs/at/andover/) - 16.6mi away\n" +
        "- [Shaftesbury](/md/needs/at/shaftesbury/) - 18.0mi away\n" +
        "- [Bath](/md/needs/at/bath/) - 64.4mi away\n" +
        "- [Truro](/md/needs/at/truro/) - 71.3mi away\n" +
        "- [Fbtown](/md/needs/at/fb-town/) - 78.2mi away\n" +
        "- [Salvation Army](/md/needs/at/salvation-army/) - 85.2mi away\n" +
        "- [Crlf Town](/md/needs/at/crlf-town/) - 99.0mi away\n" +
        "\n\n",
    );
  });

  // THE ROWS THAT ARE NOT THERE, which is the only kind of assertion that can
  // fail when a filter stops filtering. Both closed rows sit about thirteen
  // metres from Salisbury, so if `WHERE is_closed = 0` fell out of either
  // coordinate scan they would be second and third in the list above -- and
  // this site sending someone to a food bank that has shut is the worst single
  // thing it can do. Seeding them far away instead would have made this test
  // pass against a scan with no filter at all.
  //
  // closed-town is the third: it is 92.1 miles out, between salvation-army and
  // crlf-town, so a lost filter shows up as an inserted line in the MIDDLE of
  // the sequence rather than only at the top.
  it("excludes closed food banks and closed locations even when they are the nearest things there are", async () => {
    const rows = await nearbyRows("/md/needs/at/salisbury/nearby/");

    expect(rows.join("\n")).not.toContain("Closed Bank");
    expect(rows.join("\n")).not.toContain("Closed Outreach");
    expect(rows.join("\n")).not.toContain("Closed Town");
    // And the closed pair really are nearer than everything that IS listed --
    // otherwise the negatives above would hold for a filter that never ran.
    expect(rows[0]).toBe("- [Harnham Centre](/md/needs/at/salisbury/harnham/) (Salisbury) - 0.0mi away");
    expect(rows).toHaveLength(12);
  });

  // skip_first=True, the whole reason md_foodbank_nearby calls find_locations
  // with a third argument. Salisbury is at distance zero from itself and is
  // dropped; its own location, on the very same spot, is NOT -- only index 0
  // goes.
  //
  // Both halves matter. A port that filtered "any row belonging to this food
  // bank" would silently lose Harnham Centre, and a port that dropped nothing
  // would head every nearby page with "Salisbury - 0.0mi away".
  it("drops the food bank itself but keeps its own co-located outreach centre", async () => {
    const rows = await nearbyRows("/md/needs/at/salisbury/nearby/");

    expect(rows.some((row) => row.includes("(/md/needs/at/salisbury/)"))).toBe(false);
    expect(rows[0]).toBe("- [Harnham Centre](/md/needs/at/salisbury/harnham/) (Salisbury) - 0.0mi away");
  });

  // SUSPECT, PINNED AS-IS, AND IT IS PARITY RATHER THAN A PORT DEFECT.
  // skip_first drops index 0 of the ranking on the assumption that index 0 is
  // the food bank whose page this is. For a CLOSED food bank that assumption
  // is false: the candidate scans filter is_closed = 0, so the subject is not
  // in the ranking at all and the item dropped is a real, open neighbour.
  //
  // Closed Bank sits thirteen metres from Salisbury, so Salisbury is genuinely
  // its nearest neighbour -- and is exactly what disappears from its page.
  // Django does the same: find_locations() filters is_closed=False on both
  // querysets and then slices [1:], while md_foodbank_nearby's
  // get_object_or_404 does not filter is_closed. Closed food banks keep their
  // pages indefinitely, so this is a live state, not a hypothetical.
  it("SUSPECT: a closed food bank's nearby page silently drops a real neighbour instead of itself", async () => {
    const rows = await nearbyRows("/md/needs/at/closed-bank/nearby/");

    // Salisbury is the nearest open thing to Closed Bank, and it is gone.
    expect(rows.some((row) => row.includes("(/md/needs/at/salisbury/)"))).toBe(false);
    // Its co-located location, one place further down the ranking, survives --
    // which is what makes the omission look like a rendering quirk rather than
    // a missing row.
    expect(rows[0]).toBe("- [Harnham Centre](/md/needs/at/salisbury/harnham/) (Salisbury) - 0.0mi away");
    expect(rows).toHaveLength(12);
  });

  // The window is TWENTY items after the skip, not nineteen: Django writes it
  // as `first_item = 1; quantity = quantity + 1` then `[first_item:quantity]`,
  // so the window SHIFTS by one rather than shrinking. Fifteen extra open food
  // banks strung out due north at 0.01 degrees (~0.69 miles) apart must
  // therefore yield exactly twenty rows -- and the last of them is the
  // twenty-FIRST nearest candidate overall, because Salisbury itself took the
  // slot the window moved off.
  it("caps the list at twenty, shifting the window rather than shrinking it", async () => {
    for (let i = 0; i < 15; i++) {
      const id = 200 + i;
      seedFoodbank({ id, slug: `filler-${id}`, name: `Filler ${id}`, lat: 51.0688 + 0.01 * (i + 1), lng: -1.7945, latestNeedId: id });
      seedNeed({ id, foodbankId: id, changeText: "Soup" });
    }

    const rows = await nearbyRows("/md/needs/at/salisbury/nearby/");
    expect(rows).toHaveLength(20);
    // Still nearest-first across the join: the fillers interleave with the
    // fixture's own rows rather than being appended after them, which is the
    // half a bare length check cannot see.
    expect(rows.slice(0, 4)).toEqual([
      "- [Harnham Centre](/md/needs/at/salisbury/harnham/) (Salisbury) - 0.0mi away",
      "- [Filler 200](/md/needs/at/filler-200/) - 0.7mi away",
      "- [Bemerton Pantry](/md/needs/at/wilton/bemerton/) (Wilton) - 0.8mi away",
      "- [Filler 201](/md/needs/at/filler-201/) - 1.4mi away",
    ]);
    // The window's far edge. Twenty rows starting at ranking index 1 end on
    // Tisbury Store at 12.2 mi; a window that shrank instead of shifting would
    // stop one row short of it, at Filler 214, and one that skipped nothing
    // would end there too with Salisbury itself at the top. Andover, the
    // twenty-FIRST nearest candidate, is what falls off the end.
    expect(rows[19]).toBe("- [Tisbury Store](/md/needs/at/shaftesbury/tisbury/) (Shaftesbury) - 12.2mi away");
    expect(rows.join("\n")).not.toContain("Andover]");
  });

  // The mileage is Django's `|floatformat:1`, i.e. exactly one decimal place,
  // always -- "3.0mi", never "3mi". The 0.0 at the top is the load-bearing
  // one: a truncating or rounding-to-integer formatter prints "0mi" there and
  // looks fine everywhere else in the list.
  it("prints one decimal place on every distance, including the zero", async () => {
    const rows = await nearbyRows("/md/needs/at/salisbury/nearby/");

    for (const row of rows) expect(row).toMatch(/ - \d+\.\dmi away$/);
    expect(rows[0]!.endsWith(" - 0.0mi away")).toBe(true);
  });

  // The distances are measured with R_EARTHDISTANCE (6378168 m), the api/2
  // radius, not api/1's R_PYTHON -- PLAN.md §7.5.1 keeps both and says "do not
  // unify". The two differ by 0.175%, which is invisible in a smoke test and a
  // changed number on rows of this page. These figures were derived from the
  // fixture coordinates independently, with CPython at that radius and the
  // same haversine form; they are quoted to six places in the fixture comment
  // so a radius change shows up as a diff rather than rounding to the same
  // single decimal.
  it("publishes real-world mileages, not kilometres and not metres", async () => {
    const rows = await nearbyRows("/md/needs/at/salisbury/nearby/");

    // Wilton is a shade under three miles from Salisbury on the ground
    // (2.950225 mi). A units slip lands at 4.7 (km) or in the thousands
    // (metres left unconverted).
    expect(rows[2]).toBe("- [Wilton](/md/needs/at/wilton/) - 3.0mi away");
    // And crlf-town, the far end of the list, at 98.997622 mi -- which also
    // pins that floatformat ROUNDS rather than truncates, since a truncating
    // formatter prints 98.9 here.
    expect(rows[11]).toBe("- [Crlf Town](/md/needs/at/crlf-town/) - 99.0mi away");
  });

  // A location's bracketed name is its PARENT food bank's, read from the
  // foodbanklocation_full view -- not its own, and not the subject's. Tisbury
  // Store belongs to Shaftesbury, and the pair appear in the list separately
  // as well, so a lookup keyed on the wrong id would produce a page where
  // every bracket said the same thing.
  it("labels each location with its own parent, not with the page's food bank", async () => {
    const rows = await nearbyRows("/md/needs/at/salisbury/nearby/");

    expect(rows[1]).toBe("- [Bemerton Pantry](/md/needs/at/wilton/bemerton/) (Wilton) - 0.8mi away");
    expect(rows[4]).toBe("- [Tisbury Store](/md/needs/at/shaftesbury/tisbury/) (Shaftesbury) - 12.2mi away");
    // Only Salisbury's own location says Salisbury.
    expect(rows.filter((row) => row.includes("(Salisbury)"))).toHaveLength(1);
  });

  // Names in the list are the RAW `name` column, never full_name() -- so
  // "Salvation Army" appears without a suffix here for the same reason it does
  // on its own page, but "Wilton" appears WITHOUT the "Foodbank" the heading
  // would have added. Django's nearby.md renders `{{ location.name }}` too, so
  // this is parity; pinned because "use full_name in the list as well,
  // obviously" is a one-line template change.
  it("lists neighbours by their bare name, not their full name", async () => {
    const rows = await nearbyRows("/md/needs/at/salisbury/nearby/");

    expect(rows[2]).toContain("[Wilton]");
    expect(rows.join("\n")).not.toContain("Wilton Foodbank");
    // The heading on the same page does use the full name, so the two really
    // are different values and not one shared one.
    expect(await body("/md/needs/at/salisbury/nearby/")).toContain("# Nearby - Salisbury Foodbank\n");
  });

  // THE ONLY-CANDIDATE CASE. Reachable in production for the last open food
  // bank in a region, and for every food bank at once during a bad ETL run. It
  // must render the page, not 500 and not print a stray empty bullet -- an
  // empty `{% for %}` in markdown is the difference between a heading and a
  // heading followed by a dangling "- ".
  it("renders a heading and nothing else when the food bank is the only candidate", async () => {
    db.prepare("DELETE FROM foodbanklocation").run();
    db.prepare("DELETE FROM foodbank WHERE id != 1").run();

    const res = await get("/md/needs/at/salisbury/nearby/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("# Nearby - Salisbury Foodbank\n\n\n\n");
  });

  // github #13. This asserted a 500, on the grounds that "Django's
  // find_locations() reads `foodbank.latest_need.change_text` against None and
  // errors in the same place". It does not read it at all. The whole of
  // geo.py:246-303 mentions latest_need exactly once, and it is an
  // ASSIGNMENT: `location.latest_need = location.foodbank.latest_need`, which
  // stores None without complaint. The claim was checked against the
  // read-only Django source rather than inherited.
  it("renders the whole page when a listed neighbour has no need row", async () => {
    db.prepare("UPDATE foodbank SET latest_need_id = NULL WHERE slug = 'wilton'").run();

    const res = await get("/md/needs/at/salisbury/nearby/");

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Harnham Centre");
  });

  // THE OTHER SIDE OF THAT, and the asymmetry is the point. The SUBJECT food
  // bank's need row is fetched (it rides in getFoodbankBySlug's batch) and
  // then never read: this page renders no need text at all. So a food bank
  // with no need row has a perfectly good nearby page -- provided it is not
  // also somebody's listed neighbour or somebody's parent.
  //
  // closed-bank is the fixture row that shows this cleanly: closed, so it is
  // filtered out of both candidate scans, and childless, so no location drags
  // it into the parent read either.
  it("renders fine for a subject with no need row, because this page never reads one", async () => {
    db.prepare("UPDATE foodbank SET latest_need_id = NULL WHERE slug = 'closed-bank'").run();

    const res = await get("/md/needs/at/closed-bank/nearby/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("- [Harnham Centre](/md/needs/at/salisbury/harnham/) (Salisbury) - 0.0mi away");
  });

  // SUSPECT, PINNED AS-IS. Nothing validates lat_lng. A value with no comma in
  // it -- an admin typo, a half-written geocode, a "0" from geocode()'s own
  // failure path -- makes lngStr undefined and lng NaN, and two things then go
  // quietly wrong at once on a page that still returns 200 and still gets
  // stamped `public, s-maxage=604800`:
  //
  //   * every haversine returns NaN, so the sort comparator returns NaN for
  //     every pair and the list comes out in whatever order the engine's sort
  //     happened to leave -- NOT a distance ranking, and not reliably the scan
  //     order either;
  //   * floatformat prints "NaNmi away" against every row, which on this
  //     format is the only visible symptom there is.
  //
  // The exact row ORDER is deliberately not asserted: a comparator that
  // returns NaN puts Array.prototype.sort outside anything the spec pins down,
  // so the sequence is a property of V8's TimSort on this exact input and
  // would change under a Node upgrade without the behaviour under test
  // changing at all. What IS asserted is everything that stays true
  // regardless: the NaN mileages, the set of rows, the surviving is_closed
  // filters, and that the order is not the correct one.
  it("SUSPECT: a lat_lng with no comma yields an unranked list of NaNs, still stamped cacheable", async () => {
    const ranked = await nearbyRows("/md/needs/at/salisbury/nearby/");

    db.prepare("UPDATE foodbank SET lat_lng = '51.0688' WHERE slug = 'salisbury'").run();

    const res = await get("/md/needs/at/salisbury/nearby/");
    expect(res.status).toBe(200);
    // Still stamped shareable for a week, which is the half that makes a
    // silently-wrong page worth writing down rather than shrugging at.
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=604800");

    const rows = (await res.text()).split("\n").filter((line) => line.startsWith("- "));
    expect(rows.every((row) => row.endsWith(" - NaNmi away"))).toBe(true);
    // Twelve rows out of thirteen open candidates: the slice still drops
    // exactly one, and the closed rows are still excluded -- the is_closed
    // filters run in SQL and are untouched by a junk origin.
    expect(rows).toHaveLength(12);
    expect(rows.join("\n")).not.toContain("Closed Bank");
    expect(rows.join("\n")).not.toContain("Closed Outreach");
    // The same rows as the good page, in a different order. Compared on the
    // link targets and sorted, so this says "the set is intact" without
    // pretending the sequence is meaningful.
    const href = (row: string) => /\((\/md[^)]*)\)/.exec(row)![1]!;
    expect(rows.map(href).sort()).toEqual(ranked.map(href).sort());
    expect(rows.map(href)).not.toEqual(ranked.map(href));
  });
});

describe("mdFoodbankNearby -- the envelope, and the route that nearly is not one", () => {
  // Django's md_foodbank_nearby is @cache_page(SECONDS_IN_WEEK)
  // (gfwfbn/views.py:816, the decorator above the def at 817), and
  // middleware/pageCacheControl.ts carries a rule for exactly this suffix --
  // `p.endsWith("/nearby/")` -> 604800 -- rather than letting it fall through
  // to the DAY default every other food bank page gets. That rule is written
  // as a bare suffix test, with no /md/ of its own, which is the only reason
  // this route gets Django's week; a rule anchored at `^/needs/at/` would give
  // the markdown mirror a day and nothing would look wrong.
  //
  // A week is right because the answer only changes when a NEIGHBOUR opens or
  // closes, not when this food bank's shopping list does.
  it("gets Django's week at the edge where the index page gets a day", async () => {
    const res = await get("/md/needs/at/salisbury/nearby/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=604800");
    // The sibling index page is the one that falls through to DAY. Asserted
    // here because the two rules live in one ordered list and a reordering
    // that broke the suffix rule would be invisible on this page alone.
    expect((await get("/md/needs/at/salisbury/")).headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
  });

  // THE REGISTRATION-ORDER HAZARD. index.ts:539 registers
  // /md/needs/at/:slug/nearby/ and index.ts:540 registers the catch-all
  // /md/needs/at/:slug/:locslug/, so "nearby" is a literal segment competing
  // with a parameter. Swap the two lines and every nearby URL is handled by
  // mdFoodbankLocation instead, which 404s -- and the ONLY thing that would
  // show it is a request for this exact URL.
  //
  // The stronger half is the second: a food bank that really does own a
  // location slugged "nearby" cannot reach its location page at all, because
  // this route shadows it. That is Django's behaviour too (gfwfbn/urls/md.py
  // lists the literal path first), so it is pinned as parity rather than
  // reported.
  it("routes /nearby/ to the nearby page even for a food bank with a location of that slug", async () => {
    seedLocation({ id: 106, foodbankId: 1, name: "Nearby Hall", slug: "nearby", lat: 51.3, lng: -1.7945 });

    const md = await body("/md/needs/at/salisbury/nearby/");
    expect(md).toContain("# Nearby - Salisbury Foodbank\n");
    // The location page's own two markers, neither of which appears here.
    expect(md).not.toContain("## Parent food bank");
    expect(md).not.toContain("# Nearby Hall - Salisbury Foodbank");
    // And the location itself is merely one more row in the ranking, at the
    // distance its coordinates put it -- proof it exists and is simply
    // unreachable at its own URL.
    expect(md).toContain("- [Nearby Hall](/md/needs/at/salisbury/nearby/)");
  });

  // ONE D1 SESSION AND THE SHAPE OF WHAT IT SENDS.
  //
  // That matters more here than on most pages: the ranking is computed in
  // application code from one scan and then hydrated by a second, so two
  // snapshots could rank an id that the hydration read no longer returns --
  // which findLocations turns into a 500, not a shortened list.
  //
  // The shape is the WP 2.5 pattern: getFoodbankBySlug's batch, then TWO
  // covering-index scans over three columns of every open row (no bindings at
  // all), then full rows for the ranked winners only, then one more pair for
  // the winning LOCATIONS' parent food banks -- a location row carries no
  // latest_need of its own. If the two scans ever grew a `SELECT *`, this page
  // would pull thousands of 40-80 column rows to render twelve.
  //
  // The second statement of the batch is Django's one real divergence here:
  // md_foodbank_nearby uses a bare get_object_or_404(Foodbank, ...) with NO
  // select_related, so Django never fetches the subject's need row and this
  // port always does. It rides in the same round trip as the row it is fetched
  // with, so it costs latency nothing -- but it is why the B12 asymmetry above
  // is only about NEIGHBOURS.
  it("reads the page from one session: the batched pair, two coordinate scans, then hydration by id", async () => {
    await get("/md/needs/at/salisbury/nearby/");

    expect(sessions).toBe(1);
    expect(prepared.map((p) => [p.sql, p.params])).toEqual([
      ["SELECT * FROM foodbank WHERE slug = ?", ["salisbury"]],
      ["SELECT * FROM foodbankchange_full WHERE id = (SELECT latest_need_id FROM foodbank WHERE slug = ?)", ["salisbury"]],
      ["SELECT id, latitude, longitude FROM foodbank WHERE is_closed = 0", []],
      ["SELECT id, latitude, longitude FROM foodbanklocation WHERE is_closed = 0", []],
      ["SELECT * FROM foodbank WHERE id IN (?, ?, ?, ?, ?, ?, ?, ?)", [2, 3, 5, 6, 7, 8, 9, 11]],
      ["SELECT * FROM foodbanklocation_full WHERE id IN (?, ?, ?, ?)", [101, 102, 104, 105]],
      ["SELECT * FROM foodbankchange_full WHERE id IN (?, ?, ?, ?, ?, ?, ?, ?)", [102, 103, 105, 106, 107, 108, 109, 111]],
      // The winning locations' parents, deduplicated (Wilton appears twice
      // over -- as a winner in its own right and as Bemerton's parent) and,
      // per findLocations' documented redundancy, re-read even though the
      // statement two lines up already had most of them.
      ["SELECT * FROM foodbank WHERE id IN (?, ?, ?, ?)", [1, 2, 3, 5]],
      ["SELECT * FROM foodbankchange_full WHERE id IN (?, ?, ?, ?)", [101, 102, 103, 105]],
    ]);
  });

  // The `if (!foodbank) return c.notFound()` guard comes BEFORE
  // findLocations, so a bad slug costs the batch and nothing else. Two
  // full covering-index scans per 404 would be a cheap way to make a crawler
  // expensive -- and this is the format crawlers actually fetch.
  it("404s an unknown slug without scanning anything", async () => {
    const res = await get("/md/needs/at/nowhere/nearby/");

    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(res.headers.get("Cache-Tag")).toBeNull();
    expect(prepared.map((p) => p.sql)).toEqual([
      "SELECT * FROM foodbank WHERE slug = ?",
      "SELECT * FROM foodbankchange_full WHERE id = (SELECT latest_need_id FROM foodbank WHERE slug = ?)",
    ]);
  });

  // A D1 outage must produce the 500 page, not a nearby page with an empty
  // list -- and must not be cached, or a WEEK of "there is nothing near you"
  // goes out to everyone.
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

    const res = await app.fetch(new Request(`${ORIGIN}/md/needs/at/salisbury/nearby/`), broken, execCtx);

    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(await res.text()).not.toContain("Harnham Centre");
  });
});
