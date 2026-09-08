import { DatabaseSync } from "node:sqlite";
import { LOCATION_COLUMNS_NARROW } from "@givefood/db";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../../index";
import type { AppEnv } from "../../../types";

// routes/wfbn/md/locations.ts -- BOTH of its exports:
//
//   mdFoodbankLocations  GET /md/needs/at/<slug>/locations/
//   mdFoodbankLocation   GET /md/needs/at/<slug>/<locslug>/
//
// Ported from gfwfbn/views.py:703-734 (`md_foodbank_locations` and
// `md_foodbank_location`), read in full alongside this file together with
// gfwfbn/templates/wfbn/foodbank/md/{locations,location}.md, gfwfbn/urls/md.py
// and givefood/models/foodbank.py's `locations()`/`full_name()`.
//
// WHY THIS FILE EXISTS. The /md/ mirror is the surface LLMs and scrapers read,
// and it is the one part of the site where nobody is looking: a human notices
// a broken HTML page, but a markdown twin can serve the wrong food bank's
// address for months with no visible symptom at all. Every way these two
// handlers can be wrong still returns 200 text/markdown:
//
//   * THE LIST'S ORDER IS A JS COLLATOR, NOT SQL. Django's
//     `Foodbank.locations()` is `.order_by("name")` under Postgres's
//     en_US.utf8; packages/db sorts in JS instead (types.ts's sortByName,
//     with its own comment on why). D1 answers the un-ORDER-BY'd query
//     through `loc_foodbank_slug_idx`, so a lost sort silently reorders
//     ~1,000 lists into slug order -- which is why one fixture row below is
//     deliberately named out of slug order, and a second food bank exists
//     purely to separate "sorted" from "sorted BY A COLLATOR".
//
//   * THE 404 GATE IS A DENORMALISED COUNTER, not the location table.
//     `no_locations === 0` 404s a food bank that owns location rows, exactly
//     as Django's `if foodbank.no_locations == 0` does. The strict `=== 0` is
//     safe only because no_locations is NOT NULL (0001_core.sql:38) -- unlike
//     its nullable no_donation_points sibling, whose truthy-guard twin in
//     ./donationpoints.ts really does diverge for NULL.
//
//   * THE DETAIL PAGE HAS NO SUCH GATE, so a location of a
//     no_locations = 0 food bank is reachable while its own parent's list
//     page 404s. Django is identical. Asserted from both ends.
//
//   * THE PAIR IS THE IDENTITY. getFoodbankLocationBySlugs scopes on
//     (location slug, food bank slug) together, because child slugs are not
//     globally unique. Drop the second leg and /md/needs/at/cardiff/amesbury/
//     serves Salisbury's Amesbury centre under Cardiff's heading -- right
//     shape, wrong address. Both fixtures below therefore carry a COLLIDING
//     child slug and both directions are asserted.
//
//   * THE TEMPLATES ARE `{% autoescape false %}`, matching Django's
//     `{% autoescape off %}`. Markdown is not HTML, so this is correct -- and
//     it means an `&` or a `<` in a food bank name reaches the reader raw.
//     Pinned, because "add escaping for safety" would corrupt every name that
//     contains one.
//
// So every assertion below reads a VALUE out of the rendered markdown, out of
// the statements that reached the engine, or off a response header -- never a
// bare status code on its own. Six of them assert the WHOLE document, because
// on a page this small the whitespace between sections is the format.
//
// REAL EVERYTHING, the harness routes/wfbn/locationDetail.test.ts already
// uses: the REAL production app (src/index.ts's default export), so the route
// ORDER that makes /md/needs/at/x/locations/ a list page rather than a
// location called "locations" is the genuine one, and so are cacheTag,
// slugRedirect, resolveLanguage and pageCacheControl; the REAL Nunjucks
// templates; the real packages/db queries over real in-memory SQLite whose
// DDL comes from schemaFor(), i.e. from the migrations -- which matters
// because both lookups read through `foodbanklocation_full`, a VIEW, and
// getFoodbankBySlug reads `foodbankchange_full` unconditionally. Nothing
// either handler touches leaves the machine, so the only mocks are the two
// KV namespaces (no local double, and neither route reads them) and a
// console.error silencer in the one test that forces a 500.
//
// PARITY CLAIMS. Where a comment says "Django does X", X was read out of
// /Users/jasoncartwright/Sites/foodcharity at the paths named above. No Python
// was EXECUTED for this file -- there is no configured Django environment on
// this machine to execute it in -- so where a claim would need a running
// Django to settle, the comment says "not verified" rather than inventing a
// citation.
//
// MUTATION-TESTED (TESTING.md's convention). The whole repo was copied to a
// scratchpad outside it -- never edited in place -- and 35 single-line breaks
// were applied one at a time to locations.ts, packages/db's locations.ts, both
// .njk templates, index.ts's route table, cacheTag.ts and pageCacheControl.ts,
// with this file re-run against each. 34 were caught, including both lookups
// losing their food bank scoping, the counter gate loosening to a truthy
// check, the two slugs swapping at the call site, the catch-all route moving
// above /locations/, a second D1 session opening for the child lookup, and
// autoescape being turned back on. The one survivor is an EQUIVALENT mutant
// and is named where it lives, below the whole-document list assertion.

const ORIGIN = "https://www.givefood.org.uk";

// The location SELECT the list page now sends: every column of
// foodbanklocation_full EXCEPT the boundary blob, and NOT the has_boundary flag
// its HTML twin asks for -- this template has no place photos and no
// service-area map, so it needs neither. Built from packages/db's own exported
// fragment rather than retyped, so this file pins the SHAPE of the statement
// (named columns, no blob, view, WHERE) while the 38-name list keeps its single
// definition -- see packages/db/src/locations.test.ts for the drift detector
// that holds that list to the view's real columns.
const LOCATIONS_SQL = `SELECT ${LOCATION_COLUMNS_NARROW} FROM foodbanklocation_full WHERE foodbank_id = ?`;

type Bindable = null | number | bigint | string | Uint8Array;

// One statement as it reached the engine: which SESSION opened it, the SQL,
// and the values bound to it. All three matter. The session id is what proves
// lib/session.ts's one-session-per-request contract -- two sessions against a
// replicated database can see two different snapshots, and both pages would
// still render. The bindings are what prove the food bank slug reaches the
// child lookup at all. And the ABSENCE of a statement is half of what this
// file pins: the markdown list page issues NO hasServiceArea count, unlike
// its HTML twin, and a skipped query is invisible in a rendered page.
interface Prepared {
  session: number;
  sql: string;
  params: Bindable[];
}

let db: DatabaseSync;
let prepared: Prepared[];
let sessions: number;

// The slice of the D1 Sessions API packages/db uses, over node:sqlite,
// including `batch` -- getFoodbankBySlug sends the food bank row and its
// latest need as ONE round trip and indexes straight into the result array,
// so this must run them in order and return one result per input.
// Deliberately dumb otherwise: it never inspects or rewrites SQL, it hands
// every statement to real SQLite.
function d1Session(): D1DatabaseSession {
  sessions += 1;
  const id = sessions;
  const statement = (sql: string, params: Bindable[], entry: Prepared) => ({
    sql,
    params,
    bind: (...next: unknown[]) => {
      entry.params = next as Bindable[];
      return statement(sql, next as Bindable[], entry);
    },
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return {
    prepare: (sql: string) => {
      const entry: Prepared = { session: id, sql, params: [] };
      prepared.push(entry);
      return statement(sql, [], entry);
    },
    batch: async (statements: Array<{ sql: string; params: Bindable[] }>) =>
      statements.map((s) => ({ results: db.prepare(s.sql).all(...s.params), success: true, meta: {} })),
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

function env(): AppEnv["Bindings"] {
  return {
    DB: { withSession: () => d1Session() },
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: { get: async () => null, put: async () => {}, delete: async () => {} },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

// ---------------------------------------------------------------------------
// Seeds. Only the columns these two handlers and their two templates read are
// parameterised; every other NOT NULL column is filled with something the real
// migration accepts, so a seeded row is one production would have taken.
// ---------------------------------------------------------------------------

interface FoodbankSeed {
  id: number;
  slug: string;
  name: string;
  address?: string;
  postcode?: string;
  deliveryAddress?: string | null;
  phone?: string | null;
  email?: string;
  url?: string;
  isClosed?: 0 | 1;
  noLocations?: number;
  latestNeedId?: number | null;
}

// `name` is stored BARE ("Salisbury"): fullNameFoodbank() is what appends
// " Foodbank", and a fixture already carrying the suffix would hide that
// helper behind "Salisbury Foodbank Foodbank".
//
// `address` defaults to a CRLF-separated value because that is what production
// holds -- 1,066 of 1,071 rows contain \r\n (0001_core.sql:14) -- and neither
// markdown template applies a linebreaks filter, so the CR travels to the
// reader intact. That is asserted below rather than normalised away here.
function seedFoodbank(s: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, slug, address, postcode, country, lat_lng,
       latitude, longitude, delivery_address, network, charity_just_foodbank,
       contact_email, phone_number, url, shopping_list_url,
       address_is_administrative, is_closed, no_locations, no_donation_points, days_between_needs,
       latest_need_id, created, modified)
     VALUES (?, ?, ?, ?, ?, ?, 'England', '51.07,-1.79',
       51.07, -1.79, ?, 'Trussell', 0,
       ?, ?, ?, 'https://example.invalid/list/',
       0, ?, ?, 1, 14,
       ?, '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run(
    s.id,
    String(s.id).padStart(32, "a"),
    s.name,
    s.slug,
    s.address ?? "12 High Street\r\nHarnham",
    s.postcode ?? "SP2 8LZ",
    s.deliveryAddress ?? null,
    s.email ?? `info@${s.slug}.invalid`,
    s.phone ?? null,
    s.url ?? `https://${s.slug}.invalid/`,
    s.isClosed ?? 0,
    // `?? 1` on a deliberate 0 would silently delete the counter-gate tests,
    // which are the whole reason this column is parameterised.
    s.noLocations === undefined ? 1 : s.noLocations,
    s.latestNeedId ?? null,
  );
}

interface LocationSeed {
  id: number;
  foodbankId: number;
  name: string;
  slug: string;
  address?: string | null;
  postcode?: string | null;
  isClosed?: 0 | 1;
}

// address and postcode are BOTH nullable on this table (0001_core.sql:63) and
// both templates branch on each independently, so `undefined` means "give me
// the default" and an explicit `null` means "store NULL" -- a plain `??` would
// make the four-state address tests untestable.
function seedLocation(s: LocationSeed): void {
  db.prepare(
    `INSERT INTO foodbanklocation (id, uuid, foodbank_id, name, slug, address, postcode, country,
       lat_lng, is_closed, modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'England', '51.07,-1.79', ?, '2020-01-01 00:00:00.000000')`,
  ).run(
    s.id,
    String(s.id).padStart(32, "e"),
    s.foodbankId,
    s.name,
    s.slug,
    s.address === undefined ? "1 Side Street" : s.address,
    s.postcode === undefined ? "SP1 1AA" : s.postcode,
    s.isClosed ?? 0,
  );
}

// `created`/`modified` are TEXT compared lexicographically, so every fixture
// timestamp is written in Django's own spelling -- "2026-09-05 19:28:08.853000",
// a space and six digits of microseconds, never toISOString()'s.
function seedNeed(o: { id: number; foodbankId: number; changeText: string; excess?: string | null }): void {
  db.prepare(
    `INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, excess_change_text, published,
       input_method, created, modified)
     VALUES (?, ?, ?, ?, ?, 1, 'scrape', '2026-09-05 19:28:08.853000', '2026-09-05 19:28:08.853000')`,
  ).run(o.id, String(o.id).padStart(32, "c"), o.foodbankId, o.changeText, o.excess ?? null);
}

// THE FIXTURE IS THE TEST: each food bank turns exactly one branch of one of
// the two handlers on or off relative to its neighbour.
//
//    1  salisbury       the full list page: four locations covering every
//                       combination of address/postcode/closed, a need with
//                       blank lines in it and an excess list
//    2  bath            no_locations = 0 while OWNING a location -- the list
//                       page's 404, and the detail page that renders anyway
//    3  cardiff         a location whose slug COLLIDES with Salisbury's
//    4  ghost-town      no_locations = 3 with no location rows at all
//    5  salvation-army  a DONT_APPEND_FOOD_BANK name -- no " Foodbank" suffix
//    6  closed-town     is_closed + a delivery address + no phone number
//    7  unknown-town    latest need "Unknown"      } the three sentinels that
//    8  facebook-town   latest need "Facebook"     } suppress "Items needed"
//   11  nothing-town    latest need "Nothing"      }
//    9  shadow-town     a location slugged "locations", which the router's
//                       literal route permanently shadows
//   10  amp-town        `&` and `<` in every field autoescape would have eaten
//   12  collator-town   a lowercase-initial name, which a byte-wise SQL sort
//                       and a linguistic collator order DIFFERENTLY
function seed(): void {
  seedFoodbank({ id: 1, slug: "salisbury", name: "Salisbury", phone: "01722 555000", latestNeedId: 1001, noLocations: 4 });
  seedNeed({ id: 1001, foodbankId: 1, changeText: "Tinned tomatoes\n\nPasta\n   \nUHT milk", excess: "Baked beans\n\nSoup" });
  // ONE ROW IS DELIBERATELY NAMED OUT OF SLUG ORDER. Ids ascending in a
  // non-alphabetical order is not enough on its own: `SELECT * FROM
  // foodbanklocation_full WHERE foodbank_id = ?` is answered through
  // `loc_foodbank_slug_idx` (foodbank_id, slug), so with every slug agreeing
  // with its name a lost sort would change nothing and the list assertion
  // would pass against a sort that was not happening. "Alderholt Rooms"
  // (slug closed-centre) is the fix, and it is what production looks like
  // anyway: slugs are stable URL identifiers minted once, names get edited
  // afterwards when a centre is renamed.
  seedLocation({ id: 11, foodbankId: 1, name: "Zeals Centre", slug: "zeals", address: "3 Church Lane", postcode: "BA12 6NZ" });
  seedLocation({ id: 12, foodbankId: 1, name: "Amesbury Centre", slug: "amesbury", address: "1 Side Street", postcode: "SP4 7AA" });
  seedLocation({ id: 13, foodbankId: 1, name: "Alderholt Rooms", slug: "closed-centre", isClosed: 1, address: null, postcode: null });
  seedLocation({ id: 14, foodbankId: 1, name: "Bemerton Heath", slug: "bemerton", address: null, postcode: "SP2 9DJ" });

  seedFoodbank({ id: 2, slug: "bath", name: "Bath", noLocations: 0 });
  seedLocation({ id: 31, foodbankId: 2, name: "Twerton Centre", slug: "twerton", address: "5 Twerton Road", postcode: "BA2 1AA" });

  seedFoodbank({ id: 3, slug: "cardiff", name: "Cardiff" });
  seedLocation({ id: 41, foodbankId: 3, name: "Cardiff Amesbury Hall", slug: "amesbury", address: "9 Cardiff Way", postcode: "CF10 1AA" });

  seedFoodbank({ id: 4, slug: "ghost-town", name: "Ghost Town", noLocations: 3 });

  seedFoodbank({ id: 5, slug: "salvation-army", name: "Salvation Army" });
  seedLocation({ id: 51, foodbankId: 5, name: "Citadel", slug: "citadel" });

  seedFoodbank({
    id: 6,
    slug: "closed-town",
    name: "Closed Town",
    isClosed: 1,
    phone: null,
    deliveryAddress: "Depot Road\r\nIndustrial Estate",
    latestNeedId: 1006,
  });
  seedNeed({ id: 1006, foodbankId: 6, changeText: "Nothing" });
  seedLocation({ id: 61, foodbankId: 6, name: "Shut Centre", slug: "shut" });

  seedFoodbank({ id: 7, slug: "unknown-town", name: "Unknown Town", latestNeedId: 1007 });
  seedNeed({ id: 1007, foodbankId: 7, changeText: "Unknown" });
  seedLocation({ id: 71, foodbankId: 7, name: "Unknown Hall", slug: "unknown-hall" });

  seedFoodbank({ id: 8, slug: "facebook-town", name: "Facebook Town", latestNeedId: 1008 });
  seedNeed({ id: 1008, foodbankId: 8, changeText: "Facebook" });
  seedLocation({ id: 81, foodbankId: 8, name: "Facebook Hall", slug: "facebook-hall" });

  seedFoodbank({ id: 11, slug: "nothing-town", name: "Nothing Town", latestNeedId: 1011 });
  seedNeed({ id: 1011, foodbankId: 11, changeText: "Nothing" });
  seedLocation({ id: 111, foodbankId: 11, name: "Nothing Hall", slug: "nothing-hall" });

  seedFoodbank({ id: 9, slug: "shadow-town", name: "Shadow Town", noLocations: 2 });
  seedLocation({ id: 91, foodbankId: 9, name: "Locations Hall", slug: "locations" });
  seedLocation({ id: 92, foodbankId: 9, name: "News Room", slug: "news" });

  seedFoodbank({ id: 10, slug: "amp-town", name: "Bread & Butter", url: "https://amp.invalid/?a=1&b=2", latestNeedId: 1010 });
  seedNeed({ id: 1010, foodbankId: 10, changeText: "Rice & beans\n<b>Pasta</b>" });
  seedLocation({ id: 101, foodbankId: 10, name: "St Mary's <Hall> & Rooms", slug: "st-marys", address: "1 & 2 Church St", postcode: "AM1 1PP" });

  seedFoodbank({ id: 12, slug: "collator-town", name: "Collator Town", noLocations: 2 });
  seedLocation({ id: 121, foodbankId: 12, name: "Zebra Hall", slug: "zebra" });
  seedLocation({ id: 122, foodbankId: 12, name: "the Old Mill", slug: "old-mill" });
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  // schemaFor, not hand-written DDL: both lookups read through the
  // `foodbanklocation_full` VIEW, getFoodbankBySlug reads
  // `foodbankchange_full` unconditionally (github #51 -- eight suites 500'd at
  // once when it started doing so), and `slugredirect` is read by the
  // slugRedirect middleware in the one test below that exercises it.
  db.exec(schemaFor("foodbank", "foodbankchange", "foodbankchange_full", "foodbanklocation", "foodbanklocation_full", "slugredirect"));
  seed();
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

// Every `## ` heading in document order. Both templates use h2 for every
// section AND for every location name, so this is exactly the list of blocks
// a reader scrolls past -- and on the list page it is the ordering contract.
const headings = (md: string): string[] => [...md.matchAll(/^## (.*)$/gm)].map((m) => m[1] as string);

describe("mdFoodbankLocations -- the response envelope", () => {
  // Django's `md_foodbank_locations` carries @cache_page(SECONDS_IN_DAY)
  // (gfwfbn/views.py:703) and renders with
  // content_type='text/markdown; charset=utf-8' -- both reproduced exactly,
  // the charset in Django's own lowercase spelling. The BROWSER number is
  // deliberately NOT Django's: BROWSER_MAX_AGE is 300 because a browser cache
  // cannot be purged and a location can close overnight
  // (middleware/pageCacheControl.ts's own reasoning).
  //
  // The Content-Type is load-bearing beyond politeness: pageCacheControl only
  // stamps text/html, RSS and text/markdown, so a handler that dropped to
  // text/plain would lose its Cache-Control silently.
  it("serves markdown that is cacheable for five minutes in the browser and Django's day at the edge", async () => {
    const res = await get("/md/needs/at/salisbury/locations/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    expect(res.headers.get("Content-Language")).toBe("en");
  });

  // THE TAG IS WHY THE DAY ABOVE IS SAFE. cacheTag.ts's FOODBANK_PATH carries
  // an explicit optional `/md` prefix for exactly these routes; without it,
  // editing a food bank would purge its HTML pages and leave the markdown
  // mirror serving yesterday's locations for 24 hours with nothing able to
  // invalidate it.
  it("stamps the food bank's own purge tag on both markdown pages", async () => {
    expect((await get("/md/needs/at/salisbury/locations/")).headers.get("Cache-Tag")).toBe("fb-salisbury");
    expect((await get("/md/needs/at/salisbury/amesbury/")).headers.get("Cache-Tag")).toBe("fb-salisbury");
  });

  // ONE D1 SESSION, THREE STATEMENTS, AND THE SHAPE OF THEM.
  //
  // lib/session.ts opens a single withSession("first-unconstrained") per
  // request so every query sees one snapshot of a replicated database; a
  // handler that opened one per query would render identically.
  //
  // The first two are getFoodbankBySlug's BATCH -- one round trip, not two.
  // NOTE THE SECOND ONE: this page reads `foodbankchange_full`, the food
  // bank's latest need, and neither the handler nor locations.njk ever looks
  // at it. That is a whole D1 round trip (~20 ms, packages/db/src/foodbank.ts's
  // own measurement) spent on a value this page discards, on a surface that
  // misses the edge cache ~99% of the time. Pinned as measured behaviour, not
  // endorsed.
  //
  // And note what is NOT here: no `SELECT COUNT(*) ... boundary_geojson`. The
  // HTML twin (routes/wfbn/locations.ts) issued that unconditionally until
  // github #52; the markdown page has no map and no service-area disclaimer,
  // so it never did and must not start.
  //
  // THE THIRD STATEMENT IS PROJECTED, not `SELECT *` -- #52's closing
  // observation, third instalment. Nothing on this page prints a boundary or
  // asks whether there is one, and the blob it was pulling runs to 2.30 MB for
  // one production food bank (canterbury: 2,319,826 -> 19,532 bytes for this
  // statement, -99.2%, rows_read unchanged at 43). The expected SQL is BUILT
  // from packages/db's LOCATION_COLUMNS_NARROW, so a reverted projection fails
  // here rather than merely making the page slow again.
  it("reads the list page from one session in three statements, and issues no service-area count", async () => {
    await get("/md/needs/at/salisbury/locations/");

    expect(sessions).toBe(1);
    expect(prepared.map((p) => [p.session, p.sql, p.params])).toEqual([
      [1, "SELECT * FROM foodbank WHERE slug = ?", ["salisbury"]],
      [1, "SELECT * FROM foodbankchange_full WHERE id = (SELECT latest_need_id FROM foodbank WHERE slug = ?)", ["salisbury"]],
      [1, LOCATIONS_SQL, [1]],
    ]);
    // Stated separately from the equality above, because a reader scanning that
    // list sees one long string and not the two claims inside it: the blob is
    // never named, and neither is the flag the HTML twin computes from it.
    expect(LOCATIONS_SQL).not.toContain("SELECT *");
    expect(LOCATIONS_SQL).not.toContain("boundary_geojson");
    expect(LOCATIONS_SQL).not.toContain("has_boundary");
  });

  // THE VALUE DID NOT MOVE. The projection is invisible in the rendered page --
  // that is exactly the risk -- so this renders the SAME page against a fixture
  // where every one of Salisbury's locations carries a boundary and asserts the
  // document is character for character what the unprojected query produced. If
  // the narrow column list ever loses `name`, `address`, `postcode` or `slug`,
  // this markdown quietly loses a heading, an address line or a working link.
  it("renders the identical document whether or not the locations carry a boundary blob", async () => {
    const before = await body("/md/needs/at/salisbury/locations/");

    db.prepare("UPDATE foodbanklocation SET boundary_geojson = ? WHERE foodbank_id = 1").run(
      '{"type":"Polygon","coordinates":[[[-1.8,51.0],[-1.7,51.0],[-1.7,51.1],[-1.8,51.0]]]}',
    );
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbanklocation WHERE foodbank_id = 1 AND boundary_geojson IS NOT NULL").get()).toEqual({
      n: 4,
    });

    expect(await body("/md/needs/at/salisbury/locations/")).toBe(before);
    // Not vacuously equal: the page really does list all four locations, with
    // the headings, addresses and links the narrow projection has to carry.
    expect(headings(before)).toEqual(["Main", "Alderholt Rooms", "Amesbury Centre", "Bemerton Heath", "Zeals Centre"]);
    expect(before).toContain("SP4 7AA");
    expect(before).toContain("/md/needs/at/salisbury/amesbury/");
  });

  // An unknown slug is Django's get_object_or_404. It must reach the real 404
  // page and, above all, must NOT be stamped cacheable: pageCacheControl only
  // touches 200s and cacheTag only touches ok responses, so a mistyped slug
  // cannot poison the edge with a day-long negative entry.
  it("404s an unknown slug, uncached and untagged", async () => {
    const res = await get("/md/needs/at/nowhere/locations/");

    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(res.headers.get("Cache-Tag")).toBeNull();
  });

  // THE COUNTER GATE, matching gfwfbn/views.py:710-711 exactly. Bath's
  // no_locations says zero while it owns a location row, and the page 404s
  // anyway -- the counter is what decides, not the table. Django is identical,
  // which is why this pins the 404 rather than the (arguably more useful)
  // listing. The row is asserted present first, so this cannot pass by
  // accident on an empty table.
  it("404s a food bank whose no_locations counter is zero, even though it owns a location", async () => {
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbanklocation WHERE foodbank_id = 2").get()).toEqual({ n: 1 });

    expect((await get("/md/needs/at/bath/locations/")).status).toBe(404);
  });

  // The opposite disagreement: a counter above zero with nothing behind it.
  // no_locations is denormalised (Django recomputes it in Foodbank.save()), so
  // it can be stale in either direction -- and THIS direction renders a
  // perfectly valid page whose only entry is the food bank's own address,
  // rather than 404ing or erroring.
  it("renders a Main-only page when the counter says locations exist and none do", async () => {
    const res = await get("/md/needs/at/ghost-town/locations/");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("# Locations - Ghost Town Foodbank\n\n## Main\n\n12 High Street\r\nHarnham\nSP2 8LZ\n\n\n\n");
  });

  // lib/appendSlash.ts, Django's APPEND_SLASH. The slashless spelling is what
  // a hand-typed URL and a good many inbound links look like -- and on this
  // route family a lost redirect is not merely a 404: /md/needs/at/salisbury/
  // + "locations" without the trailing slash would otherwise be indexed as a
  // dead URL by the very crawlers this mirror exists for.
  it("redirects the slashless spelling rather than 404ing it", async () => {
    const res = await get("/md/needs/at/salisbury/locations");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/md/needs/at/salisbury/locations/`);
  });

  // GET ONLY, matching gfwfbn/urls/md.py, where neither view takes a request
  // body. A stray app.all would hand a POST to a handler whose response
  // pageCacheControl then stamps public for a day.
  it("does not answer a POST at all", async () => {
    expect((await get("/md/needs/at/salisbury/locations/", { method: "POST" })).status).toBe(404);
    expect((await get("/md/needs/at/salisbury/amesbury/", { method: "POST" })).status).toBe(404);
  });

  // A GET THAT WRITES IS THE FAILURE THIS ASSERTS AGAINST -- a route in this
  // repo has been caught with one before. Both pages are stamped
  // `public, s-maxage=86400`, so a side effect would run once and then be
  // swallowed by the edge for a day.
  it("issues nothing but SELECTs, on both pages", async () => {
    await get("/md/needs/at/salisbury/locations/");
    await get("/md/needs/at/salisbury/amesbury/?anything=1");

    expect(prepared).not.toHaveLength(0);
    for (const { sql } of prepared) expect(sql).toMatch(/^SELECT /);
  });

  // The slug comparison is SQLite's default case-sensitive `=` on TEXT, so a
  // shouted URL is a 404 rather than a second, uncanonical spelling of the
  // page. A `COLLATE NOCASE` on the column would silently create duplicate
  // content for every food bank -- which on a machine-readable mirror means
  // duplicate content in whatever index is consuming it.
  it("does not answer a differently-cased slug", async () => {
    expect((await get("/md/needs/at/SALISBURY/locations/")).status).toBe(404);
    expect((await get("/md/needs/at/Salisbury/amesbury/")).status).toBe(404);
  });

  // /md/ is registered OUTSIDE i18n_patterns -- givefood/urls.py's "Markdown
  // versions" block, reproduced by index.ts registering these two paths with
  // no locale loop. So there is no Welsh markdown mirror, and asking for one
  // is a 404 rather than an English page served under a Welsh URL (which
  // would be a second, uncanonical address for the same bytes).
  it("has no locale-prefixed twin: /cy/md/... is a 404", async () => {
    expect((await get("/cy/md/needs/at/salisbury/locations/")).status).toBe(404);
    expect((await get("/cy/md/needs/at/salisbury/amesbury/")).status).toBe(404);
  });

  // A D1 outage must produce the 500 page, not a locations page with an empty
  // list -- and must not be cached, or a day of "this food bank has one
  // address and no branches" goes out to everyone who asks.
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

    const res = await app.fetch(new Request(`${ORIGIN}/md/needs/at/salisbury/locations/`), broken, execCtx);

    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(await res.text()).not.toContain("Amesbury Centre");
  });

  // SUSPECT, PINNED AS-IS: THE MARKDOWN MIRROR DOES NOT FOLLOW SLUG RENAMES.
  //
  // Django's SlugRedirectMiddleware matches r'^(/[a-z]{2})?/needs/at/...'
  // (givefood/middleware.py:176). "/md" IS two lowercase letters, so that
  // pattern matches the markdown mirror by accident and redirects it
  // correctly, rebuilding the path with the same "/md" prefix it captured as
  // a language. middleware/slugRedirect.ts deliberately replaced `[a-z]{2}`
  // with the real prefix set (cy|ga|gd) to fix the "zh-hans"/"tlh" hole that
  // pattern also has -- and in doing so dropped the accidental /md/ coverage
  // with it. So a renamed food bank's HTML pages 301 and its markdown twins
  // 404, where Django 301'd both.
  //
  // Asserted, not fixed: this file may not touch the source. Whether any
  // renamed slug is actually being fetched at its /md/ address is not
  // something this repo can settle and is NOT verified here -- the divergence
  // is what is pinned.
  //
  // This is the ONLY test in the file that requests a non-/md/ URL, on
  // purpose: slugRedirect.ts memoises its map at MODULE scope for five
  // minutes, so a second test doing so would depend on which ran first.
  it("SUSPECT: 404s a renamed food bank's markdown URL while its HTML twin 301s", async () => {
    db.prepare(
      "INSERT INTO slugredirect (id, old_slug, new_slug, created, modified) VALUES (1, 'sarum', 'salisbury', ?, ?)",
    ).run("2026-09-05 19:28:08.853000", "2026-09-05 19:28:08.853000");

    const html = await get("/needs/at/sarum/locations/");
    expect(html.status).toBe(301);
    expect(html.headers.get("Location")).toBe("/needs/at/salisbury/locations/");

    expect((await get("/md/needs/at/sarum/locations/")).status).toBe(404);
    expect((await get("/md/needs/at/sarum/amesbury/")).status).toBe(404);
  });
});

describe("mdFoodbankLocations -- the document a machine actually reads", () => {
  // THE WHOLE DOCUMENT, BYTE FOR BYTE. On a page this small the blank lines
  // between sections ARE the format -- a markdown heading with no blank line
  // after it stops being a heading in most parsers -- so a substring
  // assertion would let a whitespace regression through unnoticed. This single
  // expectation carries six separate contracts, each with its own quiet
  // failure mode:
  //
  //   * ORDER is packages/db's Intl.Collator applied in JS, not an SQL ORDER
  //     BY. D1 answers through (foodbank_id, slug), so an unsorted result
  //     would read Amesbury, Bemerton, Alderholt, Zeals;
  //   * "Alderholt Rooms" is is_closed = 1 and is STILL LISTED, because
  //     Django's Foodbank.locations() has no is_closed filter either
  //     (givefood/models/foodbank.py:546). Adding the "obvious" filter would
  //     delete rows from real pages;
  //   * the food bank's own address heads the list under "## Main", with its
  //     stored \r\n intact and NO linebreaks filter applied;
  //   * a location with neither address nor postcode still gets its heading
  //     and its link, leaving an empty gap where the address would be;
  //   * every "View details" link is built from wfbn-md:md_foodbank_location,
  //     i.e. /md/... -- a link built from the HTML route would send every
  //     crawler following this mirror straight back into the HTML site;
  //   * nothing belonging to another food bank appears.
  it("renders the whole list document exactly, in collator order, closed branches included", async () => {
    expect(await body("/md/needs/at/salisbury/locations/")).toBe(
      "# Locations - Salisbury Foodbank\n" +
        "\n" +
        "## Main\n" +
        "\n" +
        "12 High Street\r\nHarnham\n" +
        "SP2 8LZ\n" +
        "\n" +
        "\n" +
        "## Alderholt Rooms\n" +
        "\n" +
        "\n" +
        "\n" +
        "[View details](/md/needs/at/salisbury/closed-centre/)\n" +
        "\n" +
        "## Amesbury Centre\n" +
        "\n" +
        "1 Side Street\n" +
        "SP4 7AA\n" +
        "\n" +
        "[View details](/md/needs/at/salisbury/amesbury/)\n" +
        "\n" +
        "## Bemerton Heath\n" +
        "\n" +
        "SP2 9DJ\n" +
        "\n" +
        "[View details](/md/needs/at/salisbury/bemerton/)\n" +
        "\n" +
        "## Zeals Centre\n" +
        "\n" +
        "3 Church Lane\n" +
        "BA12 6NZ\n" +
        "\n" +
        "[View details](/md/needs/at/salisbury/zeals/)\n" +
        "\n" +
        "\n",
    );
  });

  // THE ONE SURVIVING MUTANT, RECORDED RATHER THAN CHASED. locations.njk
  // guards its postcode with `{% if location.postcode %}{{ location.postcode }}{% endif %}`,
  // and deleting that guard changes NOTHING: nunjucks renders null as "" (the
  // environment is built with throwOnUndefined: false, env.ts:49) and the
  // guard wraps no literal text of its own -- unlike the address guard one
  // line above it, which encloses a newline and whose deletion IS caught by
  // the assertion above. So the postcode guard is inert, and no test can kill
  // its removal. Verified by mutating it two ways against the scratchpad copy:
  // deleting it survived, and adding a newline inside it was caught. Left
  // untested on purpose -- a test contrived to cover it would assert nothing.

  // The negative half of the filter, spelled out. A `WHERE foodbank_id = ?`
  // that lost its predicate would still pass the whole-document assertion
  // above only by luck of ordering, and a reviewer reading a diff would never
  // spot which of those forty lines was the guard. These three rows exist in
  // the same table, one of them under a COLLIDING slug, and must not be here.
  it("excludes every other food bank's locations", async () => {
    const md = await body("/md/needs/at/salisbury/locations/");

    expect(md).not.toContain("Twerton Centre");
    expect(md).not.toContain("Cardiff Amesbury Hall");
    expect(md).not.toContain("Citadel");
    expect(headings(md)).toEqual(["Main", "Alderholt Rooms", "Amesbury Centre", "Bemerton Heath", "Zeals Centre"]);
  });

  // SORTED, AND SORTED BY A COLLATOR. This is the case a plain `ORDER BY name`
  // in SQL would get wrong rather than merely differently: SQLite's default
  // BINARY collation puts every uppercase letter before every lowercase one,
  // so "Zebra Hall" (Z = 0x5A) would sort before "the Old Mill" (t = 0x74),
  // while types.ts's Intl.Collator("en-US") -- chosen to match the source
  // Postgres's en_US.utf8 -- orders them t, z as a reader expects.
  // Lowercase-initial names are real ("the Trussell Trust" spellings, "de
  // Beauvoir", "y Bala"), which is why that collator exists at all.
  it("orders lowercase-initial names linguistically, not by byte", async () => {
    expect(headings(await body("/md/needs/at/collator-town/locations/"))).toEqual(["Main", "the Old Mill", "Zebra Hall"]);
  });

  // The delivery-address block is gated on foodbank.delivery_address alone and
  // sits BETWEEN the main address and the location list. Salisbury has none,
  // so the section must be absent entirely rather than present-and-empty --
  // an empty "## Delivery" would read, to anything parsing this, as a food
  // bank that accepts deliveries at an unknown address.
  it("prints the delivery address only for a food bank that has one", async () => {
    const closed = await body("/md/needs/at/closed-town/locations/");
    expect(headings(closed)).toEqual(["Main", "Delivery", "Shut Centre"]);
    expect(closed).toContain("## Delivery\n\nDepot Road\r\nIndustrial Estate\n");

    expect(headings(await body("/md/needs/at/salisbury/locations/"))).not.toContain("Delivery");
  });

  // full_name is fullNameFoodbank(), Django's Foodbank.full_name_en(): the
  // nine names in DONT_APPEND_FOOD_BANK (givefood/const/general.py:164) are
  // already complete and must not be suffixed. "Salvation Army Foodbank" is
  // not a thing, and this heading is what an LLM reads as the organisation's
  // name.
  it("does not append Foodbank to a name that already carries its own", async () => {
    expect(await body("/md/needs/at/salvation-army/locations/")).toContain("# Locations - Salvation Army\n");
    expect(await body("/md/needs/at/salisbury/locations/")).toContain("# Locations - Salisbury Foodbank\n");
  });

  // `{% autoescape false %}`, matching Django's `{% autoescape off %}`.
  // Markdown is not HTML, so escaping here would be the bug: a food bank
  // called "Bread & Butter" would become "Bread &amp; Butter" in the heading
  // every machine reads as its name. Asserted on the name, the location name
  // and the address at once, because the wrapping tag covers the whole file
  // and a partial regression is not a thing that can happen.
  it("leaves ampersands and angle brackets raw, as a markdown document must", async () => {
    const md = await body("/md/needs/at/amp-town/locations/");

    expect(md).toContain("# Locations - Bread & Butter Foodbank\n");
    expect(md).toContain("## St Mary's <Hall> & Rooms\n");
    expect(md).toContain("1 & 2 Church St\n");
    expect(md).not.toContain("&amp;");
    expect(md).not.toContain("&lt;");
  });

  // A LOCATION SLUGGED "locations" CAN NEVER BE READ. index.ts registers the
  // literal sub-pages before the generic :locslug catch-all -- the same
  // relative order as gfwfbn/urls/md.py, so this is ported behaviour, not a
  // port defect -- which means /md/needs/at/shadow-town/locations/ is the LIST
  // page even though a real location owns that slug. The list therefore prints
  // a "View details" link that points back at itself. Pinned because the
  // "obvious" reordering (catch-all first, so every location is reachable)
  // would take every food bank's /locations/, /news/, /charity/ and /nearby/
  // page off the site.
  it("lets the literal locations route shadow a location that owns that slug", async () => {
    const md = await body("/md/needs/at/shadow-town/locations/");

    expect(headings(md)).toEqual(["Main", "Locations Hall", "News Room"]);
    // The self-link: this document's own URL, offered as the way to read one
    // of the entries in it.
    expect(md).toContain("## Locations Hall\n\n1 Side Street\nSP1 1AA\n\n[View details](/md/needs/at/shadow-town/locations/)\n");
  });
});

describe("mdFoodbankLocation -- the envelope, and the pair that is the identity", () => {
  // Same @cache_page(SECONDS_IN_DAY) and content type as its sibling
  // (gfwfbn/views.py:720). Worth its own assertion rather than a shared
  // helper: the two handlers build their Response objects independently, with
  // two separately-written header literals, and a typo in one is exactly the
  // kind of thing a shared helper would hide.
  it("serves markdown with the same day-long edge TTL as the list page", async () => {
    const res = await get("/md/needs/at/salisbury/amesbury/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
  });

  // ONE SESSION, THREE STATEMENTS -- and the BINDING ORDER is the assertion.
  // getFoodbankLocationBySlugs's SQL is
  // "WHERE slug = ? AND foodbank_slug = ?", i.e. the LOCATION slug binds
  // first. Swapping the two arguments at the call site produces a query that
  // is still valid, still returns at most one row, and returns nothing at all
  // for every real request -- a site-wide 404 that no type would have caught.
  it("reads the detail page from one session, binding the location slug before the food bank's", async () => {
    await get("/md/needs/at/salisbury/amesbury/");

    expect(sessions).toBe(1);
    expect(prepared.map((p) => [p.session, p.sql, p.params])).toEqual([
      [1, "SELECT * FROM foodbank WHERE slug = ?", ["salisbury"]],
      [1, "SELECT * FROM foodbankchange_full WHERE id = (SELECT latest_need_id FROM foodbank WHERE slug = ?)", ["salisbury"]],
      [1, "SELECT * FROM foodbanklocation_full WHERE slug = ? AND foodbank_slug = ?", ["amesbury", "salisbury"]],
    ]);
  });

  // THE COLLISION, FROM BOTH SIDES. "amesbury" is a real location slug under
  // TWO food banks, which is legal: 0001_core.sql's uniqueness on
  // foodbanklocation is (foodbank_id, name), never the slug alone. Django's
  // get_object_or_404(FoodbankLocation, slug=locslug, foodbank=foodbank)
  // scopes by both; so does getFoodbankLocationBySlugs. Drop the second leg
  // and whichever row the engine returns first is served under BOTH food
  // banks' headings -- right template, right parent name, wrong address,
  // wrong postcode. The addresses are what separate them here, because the
  // heading alone would not.
  it("serves each food bank its own location when two share a location slug", async () => {
    const salisbury = await body("/md/needs/at/salisbury/amesbury/");
    expect(salisbury).toContain("# Amesbury Centre - Salisbury Foodbank\n");
    expect(salisbury).toContain("1 Side Street\nSP4 7AA");
    expect(salisbury).not.toContain("Cardiff");

    const cardiff = await body("/md/needs/at/cardiff/amesbury/");
    expect(cardiff).toContain("# Cardiff Amesbury Hall - Cardiff Foodbank\n");
    expect(cardiff).toContain("9 Cardiff Way\nCF10 1AA");
    expect(cardiff).not.toContain("Side Street");
  });

  // The other half of the scoping: a location slug that exists, but not under
  // THIS food bank, is a 404 rather than someone else's page.
  it("404s a location slug belonging to a different food bank", async () => {
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbanklocation WHERE slug = 'zeals'").get()).toEqual({ n: 1 });

    expect((await get("/md/needs/at/cardiff/zeals/")).status).toBe(404);
    expect((await get("/md/needs/at/salisbury/twerton/")).status).toBe(404);
  });

  it("404s an unknown food bank and an unknown location alike, uncached", async () => {
    const unknownFoodbank = await get("/md/needs/at/nowhere/amesbury/");
    expect(unknownFoodbank.status).toBe(404);
    expect(unknownFoodbank.headers.get("Cache-Control")).toBeNull();

    const unknownLocation = await get("/md/needs/at/salisbury/no-such-branch/");
    expect(unknownLocation.status).toBe(404);
    expect(unknownLocation.headers.get("Cache-Control")).toBeNull();
  });

  // THE DETAIL PAGE HAS NO COUNTER GATE, and that is Django's behaviour too:
  // md_foodbank_location (gfwfbn/views.py:721-734) is two get_object_or_404
  // calls and nothing else, where md_foodbank_locations above it checks
  // no_locations first. So a stale zero counter takes the LIST page off the
  // site while leaving every branch page under it reachable and correct.
  // Asserted as a pair, because either half alone looks like a bug.
  it("serves a location whose parent's list page 404s on its stale counter", async () => {
    expect((await get("/md/needs/at/bath/locations/")).status).toBe(404);

    const res = await get("/md/needs/at/bath/twerton/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("# Twerton Centre - Bath Foodbank\n");
  });

  it("redirects the slashless spelling of a location page", async () => {
    const res = await get("/md/needs/at/salisbury/amesbury");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/md/needs/at/salisbury/amesbury/`);
  });
});

describe("mdFoodbankLocation -- the document, and the need text inside it", () => {
  // THE WHOLE DOCUMENT AGAIN, BYTE FOR BYTE, for the ordinary case. Carries:
  //
  //   * the h1 as "<location name> - <full food bank name>";
  //   * the need list with its BLANK LINES STRIPPED -- the stored text is
  //     "Tinned tomatoes\n\nPasta\n   \nUHT milk", including a
  //     whitespace-only line, and nonEmptyLines() is what removes both. A
  //     raw change_text here would print blank lines that markdown reads as
  //     paragraph breaks, turning one list into three;
  //   * the excess list COMMA-JOINED on one line, not one per line, which is
  //     the template's `{% for %}{{ item }}{% if not loop.last %}, {% endif %}`
  //     and matches Django's forloop.last spelling of the same;
  //   * the location's own address block, gated on address-or-postcode;
  //   * the contact block, whose phone line is conditional;
  //   * the parent link back to /md/needs/at/<slug>/, the markdown index --
  //     not the HTML page.
  it("renders the whole location document exactly, with blank lines stripped from the need", async () => {
    expect(await body("/md/needs/at/salisbury/amesbury/")).toBe(
      "# Amesbury Centre - Salisbury Foodbank\n" +
        "\n" +
        "## Items needed\n" +
        "\n" +
        "Tinned tomatoes\nPasta\nUHT milk\n" +
        "\n" +
        "## Items not needed\n" +
        "\n" +
        "Baked beans, Soup\n" +
        "\n" +
        "\n" +
        "## Address\n" +
        "\n" +
        "1 Side Street\n" +
        "SP4 7AA\n" +
        "\n" +
        "\n" +
        "\n" +
        "## Contact\n" +
        "\n" +
        "- Website: [https://salisbury.invalid/](https://salisbury.invalid/)\n" +
        "- Phone: [01722 555000](tel:01722 555000)\n" +
        "- Email: [info@salisbury.invalid](mailto:info@salisbury.invalid)\n" +
        "\n" +
        "## Parent food bank\n" +
        "\n" +
        "[Salisbury Foodbank](/md/needs/at/salisbury/)\n" +
        "\n",
    );
  });

  // THE THREE SENTINELS. "Unknown", "Nothing" and "Facebook" are contract
  // values in change_text (0001_core.sql:114), not shopping lists, and the
  // template's three-way `!=` chain is what keeps them from being printed as
  // things to donate. All three are checked because the chain is three
  // separate comparisons and a lost one is invisible unless a food bank
  // happens to be sitting on that exact sentinel -- which is why each gets
  // its own food bank rather than one row edited three times.
  it("prints no Items needed section at all for any of the three need sentinels", async () => {
    for (const [slug, locslug] of [
      ["unknown-town", "unknown-hall"],
      ["nothing-town", "nothing-hall"],
      ["facebook-town", "facebook-hall"],
    ] as const) {
      const md = await body(`/md/needs/at/${slug}/${locslug}/`);

      expect(headings(md)).toEqual(["Address", "Contact", "Parent food bank"]);
      expect(md).not.toContain("Items needed");
      expect(md).not.toContain("Items not needed");
    }
  });

  // SUSPECT, PINNED AS-IS. A food bank with NO latest_need at all renders an
  // "## Items needed" heading with nothing under it -- a document that
  // announces a shopping list and then supplies none, which is materially
  // worse for a machine reader than the sentinel case above (where the
  // section is omitted outright and the absence is unambiguous).
  //
  // It comes from the handler's `foodbank.latestNeed?.change_text ?? ""`: ""
  // is not one of the three sentinels, so the template's exclusion chain lets
  // it through. That fallback is deliberate and documented in
  // ../foodbank.ts's mdFoodbank -- Django's `foodbank.latest_need.change_text`
  // on a None latest_need resolves to string_if_invalid, i.e. '', and reaches
  // the same comparison -- so this reads as faithful to Django rather than a
  // port defect. NOT VERIFIED against a running Django; the port's behaviour
  // is what is pinned here, and a "fix" that emitted "Nothing" instead would
  // be a divergence, not a repair.
  it("SUSPECT: announces an empty Items needed section when the food bank has no need at all", async () => {
    expect(db.prepare("SELECT latest_need_id AS n FROM foodbank WHERE slug = 'cardiff'").get()).toEqual({ n: null });

    const md = await body("/md/needs/at/cardiff/amesbury/");
    expect(headings(md)).toEqual(["Items needed", "Address", "Contact", "Parent food bank"]);
    expect(md).toContain("# Cardiff Amesbury Hall - Cardiff Foodbank\n\n## Items needed\n\n\n\n\n## Address\n");
  });

  // The excess block is gated separately on excess_change_text, and it is
  // NESTED inside the sentinel check -- so a food bank with a real need and no
  // excess prints one section, not two, and never an empty "Items not needed".
  // amp-town's need has excess_change_text NULL for exactly this.
  it("omits Items not needed when there is a need but no excess list", async () => {
    expect(headings(await body("/md/needs/at/amp-town/st-marys/"))).toEqual(["Items needed", "Address", "Contact", "Parent food bank"]);
    expect(headings(await body("/md/needs/at/salisbury/amesbury/"))).toEqual([
      "Items needed",
      "Items not needed",
      "Address",
      "Contact",
      "Parent food bank",
    ]);
  });

  // The address block is gated on `location.address or location.postcode`,
  // with the two lines gated independently inside it. All four states are
  // reachable in production (both columns are nullable), and "Alderholt Rooms"
  // is the both-null case: the whole section vanishes, rather than leaving a
  // "## Address" heading over empty space that a reader would take for a
  // missing-data bug in the food bank's record.
  it("drops the whole Address section when a location has neither address nor postcode", async () => {
    const md = await body("/md/needs/at/salisbury/closed-centre/");

    expect(headings(md)).toEqual(["Items needed", "Items not needed", "Contact", "Parent food bank"]);
    expect(md).not.toContain("## Address");
  });

  // Postcode-only, the third of the four states -- and the one where a
  // mis-written guard shows up as a leading blank line rather than as
  // anything a reviewer would notice.
  it("prints a postcode with no address line above it", async () => {
    expect(await body("/md/needs/at/salisbury/bemerton/")).toContain("## Address\n\nSP2 9DJ\n");
  });

  // is_closed on the PARENT food bank, printed above everything else. This is
  // the single most important line on the page for a donor who is about to
  // drive somewhere with a bag of food, and it is a plain `{% if %}` on a
  // boolean that mapFoodbankRow coerces from an INTEGER column -- a coercion
  // that, if it broke, would leave 0 truthy and put this banner on every open
  // food bank instead.
  it("leads with the closure banner for a closed food bank, and never for an open one", async () => {
    expect(await body("/md/needs/at/closed-town/shut/")).toContain(
      "# Shut Centre - Closed Town Foodbank\n\n**This food bank is closed.**\n",
    );
    expect(await body("/md/needs/at/salisbury/amesbury/")).not.toContain("closed");
  });

  // The delivery address is the PARENT food bank's, printed under its own
  // heading after the location's own address -- so a reader is told both where
  // this branch is and where the food bank takes deliveries. Absent entirely
  // when the food bank has no delivery address.
  it("prints the parent's delivery address under its own heading, and only when set", async () => {
    const closed = await body("/md/needs/at/closed-town/shut/");
    expect(headings(closed)).toEqual(["Address", "Delivery address", "Contact", "Parent food bank"]);
    expect(closed).toContain("## Delivery address\n\nDepot Road\r\nIndustrial Estate\n");

    expect(headings(await body("/md/needs/at/salisbury/amesbury/"))).not.toContain("Delivery address");
  });

  // The phone line is conditional and the other two are not, so a food bank
  // with no number prints a two-item contact list rather than an empty
  // "- Phone: [](tel:)" that a scraper would read as a real, blank number.
  it("omits the phone line for a food bank with no phone number", async () => {
    const md = await body("/md/needs/at/closed-town/shut/");

    expect(md).toContain("- Website: [https://closed-town.invalid/](https://closed-town.invalid/)\n- Email: ");
    expect(md).not.toContain("tel:");
  });

  // SUSPECT, PINNED AS-IS: the tel: link is not a valid markdown link.
  // UK numbers are stored with spaces ("01722 555000"), and the template
  // interpolates the raw value into the link destination --
  // `[01722 555000](tel:01722 555000)` -- where an unescaped space ends the
  // destination and turns the remainder into a title, so most parsers produce
  // a link to "tel:01722" or no link at all. Django's own location.md does
  // exactly the same thing (`(tel:{{ foodbank.phone_number }})`), so this is a
  // FAITHFUL PORT OF A DEFECT rather than a port defect -- which is precisely
  // why it needs pinning: it looks like an obvious typo to fix, and fixing it
  // is a deliberate divergence from Django, not a tidy-up.
  it("SUSPECT: emits an unescaped space inside the tel: link destination", async () => {
    expect(await body("/md/needs/at/salisbury/amesbury/")).toContain("- Phone: [01722 555000](tel:01722 555000)\n");
  });

  // autoescape again, on the detail template this time -- and on the need text
  // in particular, which is scraped from food banks' own web pages and
  // genuinely contains "&" ("Rice & beans") and stray markup. Escaping it
  // would put "&amp;" in front of a reader; the raw value is what Django's
  // `{% autoescape off %}` produces.
  it("leaves ampersands and markup raw in the need text and the contact URL", async () => {
    const md = await body("/md/needs/at/amp-town/st-marys/");

    expect(md).toContain("# St Mary's <Hall> & Rooms - Bread & Butter Foodbank\n");
    expect(md).toContain("## Items needed\n\nRice & beans\n<b>Pasta</b>\n");
    expect(md).toContain("[https://amp.invalid/?a=1&b=2](https://amp.invalid/?a=1&b=2)");
    expect(md).not.toContain("&amp;");
  });

  // The last line of every location page, and the only link off it. It must
  // point at the MARKDOWN index (/md/needs/at/<slug>/), not the HTML one: this
  // mirror exists so a crawler can stay inside it, and a link to the HTML page
  // sends it back to the surface the mirror was built to replace.
  it("links back to the parent food bank's markdown index, not its HTML page", async () => {
    expect(await body("/md/needs/at/salisbury/amesbury/")).toContain(
      "## Parent food bank\n\n[Salisbury Foodbank](/md/needs/at/salisbury/)\n",
    );
    expect(await body("/md/needs/at/salvation-army/citadel/")).toContain("[Salvation Army](/md/needs/at/salvation-army/)\n");
  });
});
