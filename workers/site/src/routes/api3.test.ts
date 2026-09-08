import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../index";
import type { AppEnv } from "../types";

// routes/api3.ts -- the whole of gfapi3, which is three routes: an index
// string, `company` (GET /api/3/donationpoints/company/<slug>/) and
// `slugfromid` (GET /api/3/slugfromid/<uuid>/). Ported from
// /Users/jasoncartwright/Sites/foodcharity/gfapi3/views.py, read in full for
// this file; every "Django does X" claim below is from that file or the
// model method it calls, not from memory.
//
// WHY THIS FILE EXISTS. `company` is the only endpoint on the site that
// publishes a food bank's CURRENT NEED LIST to a third party keyed by
// supermarket rather than by food bank -- it is what a retailer's own
// in-store screens read. Everything it emits is a hand-written dict of 24
// keys built out of four different helper functions (toDashedUuid,
// changeList/excessList, charityRegisterUrl, formatPyStrDatetime), and NOT
// ONE of those helpers throws on wrong input: a dropped `.map`, a swapped
// pair of same-typed fields, a sentinel spelt wrong, a timestamp passed
// through raw -- every one of them produces a 200 with a perfectly
// well-formed body that says the wrong thing. A retailer's screen showing
// the wrong shopping list looks exactly like one showing the right one.
//
// So the assertions here are WHOLE-BODY and by VALUE. The fixture is built
// so that each of the four rows exercises a different branch of every
// helper at once: four charityRegisterUrl countries (England, Scotland,
// Isle of Man, and one that falls off the end), three of Django's four
// change_text shapes (real items, a sentinel, and a trailing newline that
// the raw split must keep), three timestamp shapes, and null vs non-null
// for every nullable column in the dict.
//
// REAL EVERYTHING: the real app from ../index (so the real mount points at
// index.ts:239-240, the real middleware stack, and the real
// app.notFound()/app.onError()), real @givefood/db queries, real Nunjucks
// for the error pages, and node:sqlite seeded from the real migrations.
// Only the D1 binding is a double, and only because there is no local D1.
// Same harness as routes/api2/donationpoints.test.ts, copied rather than
// reinvented.

const ORIGIN = "https://www.givefood.org.uk";

type Bindable = null | number | bigint | string | Uint8Array;

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

function env(): AppEnv["Bindings"] {
  return {
    DB: { withSession: () => d1Session(db, prepared) },
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: { get: async () => null, put: async () => {}, delete: async () => {} },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    D1_DATABASE_NAME: "givefood-test",
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

interface FoodbankSeed {
  id: number;
  uuid: string;
  slug: string;
  name: string;
  altName?: string | null;
  country: string;
  charityNumber?: string | null;
  network?: string | null;
  phone?: string | null;
  secondaryPhone?: string | null;
  latestNeedId?: number | null;
}

// Every NOT NULL column of `foodbank` after 0019 dropped the denormalised
// cache columns, with the fifteen this endpoint actually publishes given
// per-row values and the rest given constants. `latest_need_id` is the
// circular reference 0001_core.sql documents (no FK, so it can and does
// dangle -- see the two 500 tests at the bottom).
function seedFoodbank(s: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, alt_name, slug, address, postcode, country, lat_lng,
       network, charity_number, charity_just_foodbank, contact_email,
       phone_number, secondary_phone_number, url, shopping_list_url,
       address_is_administrative, is_closed, no_locations, days_between_needs,
       latest_need_id, created, modified)
     VALUES (?, ?, ?, ?, ?, ?, 'SP1 1AA', ?, '51.07,-1.79',
       ?, ?, 0, ?, ?, ?, ?, ?, 0, 0, 0, 14, ?,
       '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run(
    s.id,
    s.uuid,
    s.name,
    s.altName ?? null,
    s.slug,
    // CRLF-joined, as 1,066 of 1,071 production rows are -- the API emits
    // `address` verbatim, so the separator is part of the contract.
    `1 High Street\r\n${s.name}`,
    s.country,
    s.network ?? null,
    s.charityNumber ?? null,
    `info@${s.slug}.invalid`,
    s.phone ?? null,
    s.secondaryPhone ?? null,
    `https://${s.slug}.invalid/`,
    `https://${s.slug}.invalid/list/`,
    s.latestNeedId ?? null,
  );
}

interface NeedSeed {
  id: number;
  needId: string;
  foodbankId: number;
  changeText: string;
  excessChangeText?: string | null;
  created: string;
}

function seedNeed(s: NeedSeed): void {
  db.prepare(
    `INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, excess_change_text,
       published, input_method, created, modified)
     VALUES (?, ?, ?, ?, ?, 1, 'scrape', ?, '2020-01-01 00:00:00.000000')`,
  ).run(s.id, s.needId, s.foodbankId, s.changeText, s.excessChangeText ?? null, s.created);
}

interface DonationPointSeed {
  id: number;
  uuid: string;
  foodbankId: number;
  name: string;
  slug: string;
  companySlug: string | null;
  country?: string | null;
  placeId?: string | null;
  storeId?: string | null;
  isClosed?: 0 | 1;
}

// The columns this endpoint must NOT publish -- opening_hours, notes,
// plus_code_*, county/ward/district, wheelchair_accessible, company (the
// display name, as opposed to company_slug), in_store_only, phone_number,
// url, the parliamentary constituency block and `modified` -- are all filled
// with recognisable values, so a handler that started spreading the row
// instead of naming its 8 fields would show up in the negative assertions
// below rather than passing silently.
function seedDonationPoint(s: DonationPointSeed): void {
  db.prepare(
    `INSERT INTO foodbankdonationpoint (id, uuid, foodbank_id, name, slug, address, postcode,
       country, lat_lng, latitude, longitude, place_id, plus_code_compound, plus_code_global,
       place_has_photo, county, district, ward, lsoa, msoa,
       parliamentary_constituency_id, parliamentary_constituency_name, parliamentary_constituency_slug,
       mp, mp_party, mp_parl_id, is_closed, in_store_only, phone_number, url, opening_hours,
       wheelchair_accessible, company, company_slug, store_id, notes, modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 51.03, -1.79,
       ?, 'PLUSCODECOMPOUND', 'PLUSCODEGLOBAL', 1,
       'Wiltshire', 'Salisbury District', 'Bemerton Ward', 'E01032015', 'E02006697',
       4001, 'Salisbury', 'salisbury', 'John Glen', 'Conservative', 4051,
       ?, 1, '01722 000000', 'https://tesco.invalid/store/?utm_source=spam',
       'Mon-Sat 08:00-20:00', 1, 'Tesco Stores Ltd', ?, ?,
       'Internal note, never published', '2026-08-14 11:02:03.918000')`,
  ).run(
    s.id,
    s.uuid,
    s.foodbankId,
    s.name,
    s.slug,
    `${s.id} Castle Street`,
    `SP1 ${s.id}TA`,
    s.country === undefined ? "England" : s.country,
    `51.0${s.id},-1.79`,
    s.placeId ?? null,
    s.isClosed ?? 0,
    s.companySlug,
    s.storeId ?? null,
  );
}

// FOUR DONATION POINTS AT ONE COMPANY, ONE PER FOOD BANK, chosen so that
// every branch this handler can take is live in the same response:
//
//   charityRegisterUrl  England / Scotland / Isle of Man / unlisted-country
//   change_text         items / "Nothing" sentinel / trailing newline /
//                       "Facebook" sentinel
//   created             Django's str(datetime) / zero-microsecond / ISO
//   nullable columns    alt_name, network, both phone numbers, dp.country,
//                       place_id and store_id are each null on some row and
//                       set on another, so a swapped or dropped key cannot
//                       hide behind a matching null.
//
// The names are the ordering fixture too: sorted bytewise (what a SQL
// `ORDER BY name` on this engine gives, and what the dp_company_slug_name
// index is in) they are Closed, Zetland, ashford, Ávila; sorted by
// @givefood/db's Intl.Collator they are ashford, Ávila, Closed, Zetland.
// The two sequences share no position, so the body assertion below pins
// which one the endpoint actually serves.
function seed(): void {
  seedFoodbank({
    id: 1,
    uuid: "0123456789abcdef0123456789abcdef",
    slug: "salisbury",
    name: "Salisbury Foodbank",
    altName: "Sarum Foodbank",
    country: "England",
    charityNumber: "1130334",
    network: "Trussell Trust",
    phone: "01722 411900",
    secondaryPhone: "01722 411901",
    latestNeedId: 101,
  });
  seedFoodbank({
    id: 2,
    uuid: "fedcba9876543210fedcba9876543210",
    slug: "sid-valley",
    name: "Sid Valley Foodbank",
    country: "Scotland",
    charityNumber: "SC044171",
    latestNeedId: 102,
  });
  seedFoodbank({
    id: 3,
    uuid: "abcdef0123456789abcdef0123456789",
    slug: "isle-of-man",
    name: "Isle of Man Foodbank",
    country: "Isle of Man",
    charityNumber: "1234",
    network: "IFAN",
    phone: "01624 000000",
    latestNeedId: 103,
  });
  seedFoodbank({
    id: 4,
    uuid: "99887766554433221100aabbccddeeff",
    slug: "jersey",
    name: "Jersey Foodbank",
    // Not one of charityRegisterUrl()'s five countries. It HAS a charity
    // number, so the null below is the function's implicit `return None`
    // rather than its explicit "no number" guard -- two different lines.
    country: "Jersey",
    charityNumber: "5678",
    network: "IFAN",
    phone: "01534 000000",
    latestNeedId: 104,
  });

  seedNeed({
    id: 101,
    needId: "7b1c2d3e4f5061728394a5b6c7d8e9fa",
    foodbankId: 1,
    changeText: "Tinned tomatoes\nPasta sauce\nRice",
    excessChangeText: "Baked beans\nSoup",
    // Python's str(datetime), which is what the ETL copied out of Postgres
    // and what migration 0022 normalised everything else to.
    created: "2020-01-24 16:30:23.173268",
  });
  seedNeed({
    id: 102,
    needId: "00112233445566778899aabbccddeeff",
    foodbankId: 2,
    changeText: "Nothing",
    // DELIBERATELY NON-EMPTY. gfapi3/views.py:44-46 empties BOTH lists when
    // change_text is a sentinel, so this text must not reach the response;
    // a handler that only guarded `items` would publish it.
    excessChangeText: "Tinned tomatoes\nSoup",
    created: "2024-03-04 09:15:00.500000",
  });
  seedNeed({
    id: 103,
    needId: "0f0f0f0f1e1e2d2d3c3c4b4b5a5a6969",
    foodbankId: 3,
    // TRAILING NEWLINE. change_list() is a raw `.split("\n")` with no
    // blank-line filtering (packages/models nonEmptyLines() is the filtered
    // sibling and is NOT what this endpoint uses), so the empty string is
    // part of the published contract.
    changeText: "Beans\nPasta\n",
    excessChangeText: null,
    // Microsecond 0: Python prints NO fractional part at all, which is the
    // rule packages/serialise/src/pyDatetime.ts exists to reproduce.
    created: "2021-06-01 00:00:00",
  });
  seedNeed({
    id: 104,
    needId: "cafebabecafebabecafebabecafebabe",
    foodbankId: 4,
    changeText: "Facebook",
    excessChangeText: null,
    created: "2025-12-31 23:59:59.000001",
  });

  seedDonationPoint({
    id: 11,
    uuid: "11112222333344445555666677778888",
    foodbankId: 1,
    name: "Zetland Tesco",
    slug: "zetland",
    companySlug: "tesco",
    placeId: "ChIJdd4hrwug2EcRmSrV3Vo6llI",
    storeId: "STORE-4471",
  });
  seedDonationPoint({
    id: 12,
    uuid: "aaaabbbbccccddddeeeeffff00001111",
    foodbankId: 2,
    name: "ashford Tesco",
    slug: "ashford",
    companySlug: "tesco",
    // NULL country: 1 of 5,744 production rows, contrary to the Django
    // model's declared NOT NULL (0001_core.sql:89 says so).
    country: null,
    placeId: null,
    storeId: null,
  });
  seedDonationPoint({
    id: 13,
    // Stored DASHED and UPPERCASE. Nothing writes this shape today, but
    // toDashedUuid normalises before it regroups, and that normalisation is
    // the difference between a stable id and one that changes shape the day
    // an import writes a dashed value.
    uuid: "0F0F0F0F-1E1E-2D2D-3C3C-4B4B4B4B4B4B",
    foodbankId: 3,
    name: "Ávila Tesco",
    slug: "avila",
    companySlug: "tesco",
    placeId: "ChIJAvilaPlaceIdentifier",
    storeId: null,
  });
  seedDonationPoint({
    id: 17,
    uuid: "99998888777766665555444433332222",
    foodbankId: 4,
    name: "Closed Tesco Metro",
    slug: "closed-metro",
    companySlug: "tesco",
    placeId: null,
    storeId: "STORE-0001",
    // CLOSED, AND STILL PUBLISHED. Django's queryset filters on
    // company_slug alone -- no is_closed guard, unlike every other
    // donation-point endpoint on the site (gfapi2's list, the geojson, the
    // sitemap). Seeded in the main fixture rather than a test of its own
    // because the mistake to catch is someone "tidying up" by adding the
    // filter they saw next door, and that mistake must break the body.
    isClosed: 1,
  });

  // MUST NOT APPEAR. A filter that did nothing would pass every assertion
  // that only seeds matching rows, so the fixture carries the three ways a
  // row can fail to match: another company, no company at all, and a
  // company_slug differing only in case.
  seedDonationPoint({
    id: 21,
    uuid: "deadbeefdeadbeefdeadbeefdeadbeef",
    foodbankId: 1,
    name: "Sainsburys Local Salisbury",
    slug: "sainsburys-local",
    companySlug: "sainsburys",
  });
  seedDonationPoint({
    id: 22,
    uuid: "0000111122223333444455556666aaaa",
    foodbankId: 1,
    name: "Independent Church Hall",
    slug: "church-hall",
    companySlug: null,
  });
  seedDonationPoint({
    id: 23,
    uuid: "5555555555555555555555555555aaaa",
    foodbankId: 1,
    name: "TESCO Shouty Branch",
    slug: "shouty",
    companySlug: "TESCO",
  });
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  seed();
  prepared = [];
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

// `async`, not a bare arrow: app.fetch is typed Response | Promise<Response>.
const get = async (path: string): Promise<Response> => app.fetch(new Request(`${ORIGIN}${path}`), env(), execCtx);
const request = async (path: string, init: RequestInit): Promise<Response> =>
  app.fetch(new Request(`${ORIGIN}${path}`, init), env(), execCtx);

// The two food bank blocks that repeat inside the body below, named so the
// expectation reads as "which food bank", not as 40 lines of near-identical
// object literal. Every value is still asserted, once per row.
const SALISBURY = {
  id: "01234567-89ab-cdef-0123-456789abcdef",
  name: "Salisbury Foodbank",
  alt_name: "Sarum Foodbank",
  slug: "salisbury",
  url: "https://salisbury.invalid/",
  shopping_list_url: "https://salisbury.invalid/list/",
  phone_number: "01722 411900",
  secondary_phone_number: "01722 411901",
  email: "info@salisbury.invalid",
  address: "1 High Street\r\nSalisbury Foodbank",
  postcode: "SP1 1AA",
  country: "England",
  lat_lng: "51.07,-1.79",
  charity_number: "1130334",
  charity_register_url: "https://register-of-charities.charitycommission.gov.uk/charity-details/?regid=1130334&subid=0",
  network: "Trussell Trust",
  need: {
    id: "7b1c2d3e-4f50-6172-8394-a5b6c7d8e9fa",
    items: ["Tinned tomatoes", "Pasta sauce", "Rice"],
    excess: ["Baked beans", "Soup"],
    found: "2020-01-24 16:30:23.173268",
  },
};

describe("api3 -- GET /api/3/donationpoints/company/:slug/", () => {
  // THE WHOLE BODY, every key and every value, in emission order. This is
  // the endpoint's entire published contract; anything short of asserting
  // all of it lets a wrong-but-well-formed field through, which is the only
  // kind of failure this endpoint has.
  it("publishes every field of every donation point at the company, name-ordered", async () => {
    const res = await get("/api/3/donationpoints/company/tesco/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(await res.text())).toEqual([
      // "ashford" first, although its id is not lowest and a bytewise sort
      // would put it third: @givefood/db sorts in JS with an
      // Intl.Collator("en-US"), because D1's own collation is bytewise and
      // would disagree with the Postgres `en_US.utf8` ordering Django's
      // `.order_by("name")` produced.
      {
        id: "aaaabbbb-cccc-dddd-eeee-ffff00001111",
        name: "ashford Tesco",
        foodbank: {
          id: "fedcba98-7654-3210-fedc-ba9876543210",
          name: "Sid Valley Foodbank",
          alt_name: null,
          slug: "sid-valley",
          url: "https://sid-valley.invalid/",
          shopping_list_url: "https://sid-valley.invalid/list/",
          phone_number: null,
          secondary_phone_number: null,
          email: "info@sid-valley.invalid",
          address: "1 High Street\r\nSid Valley Foodbank",
          postcode: "SP1 1AA",
          country: "Scotland",
          lat_lng: "51.07,-1.79",
          charity_number: "SC044171",
          charity_register_url:
            "https://www.oscr.org.uk/about-charities/search-the-register/charity-details?number=SC044171",
          network: null,
          need: {
            id: "00112233-4455-6677-8899-aabbccddeeff",
            // "Nothing" is one of the three EMPTY_NEEDS sentinels, so BOTH
            // lists are empty -- the excess text seeded on this need
            // ("Tinned tomatoes\nSoup") is deliberately non-empty and must
            // not appear anywhere in this body.
            items: [],
            excess: [],
            found: "2024-03-04 09:15:00.500000",
          },
        },
        address: "12 Castle Street",
        postcode: "SP1 12TA",
        country: null,
        lat_lng: "51.012,-1.79",
        place_id: null,
        store_id: null,
      },
      {
        // Dashed and uppercase in the column, dashless and lowercase out.
        id: "0f0f0f0f-1e1e-2d2d-3c3c-4b4b4b4b4b4b",
        name: "Ávila Tesco",
        foodbank: {
          id: "abcdef01-2345-6789-abcd-ef0123456789",
          name: "Isle of Man Foodbank",
          alt_name: null,
          slug: "isle-of-man",
          url: "https://isle-of-man.invalid/",
          shopping_list_url: "https://isle-of-man.invalid/list/",
          phone_number: "01624 000000",
          secondary_phone_number: null,
          email: "info@isle-of-man.invalid",
          address: "1 High Street\r\nIsle of Man Foodbank",
          postcode: "SP1 1AA",
          country: "Isle of Man",
          lat_lng: "51.07,-1.79",
          charity_number: "1234",
          // The one branch that ignores the charity number entirely and
          // returns a static index page.
          charity_register_url:
            "https://www.gov.im/about-the-government/offices/attorney-generals-chambers/crown-office/charities/index-of-charities-registered-in-the-isle-of-man/",
          network: "IFAN",
          need: {
            id: "0f0f0f0f-1e1e-2d2d-3c3c-4b4b5a5a6969",
            // THE TRAILING EMPTY STRING IS THE POINT. change_list() does
            // not filter blanks; a consumer rendering this list gets a
            // blank bullet, and that is what production does.
            items: ["Beans", "Pasta", ""],
            excess: [],
            // Microsecond 0 prints no fraction at all, exactly as
            // str(datetime) does in Python.
            found: "2021-06-01 00:00:00",
          },
        },
        address: "13 Castle Street",
        postcode: "SP1 13TA",
        country: "England",
        lat_lng: "51.013,-1.79",
        place_id: "ChIJAvilaPlaceIdentifier",
        store_id: null,
      },
      {
        id: "99998888-7777-6666-5555-444433332222",
        name: "Closed Tesco Metro",
        foodbank: {
          id: "99887766-5544-3322-1100-aabbccddeeff",
          name: "Jersey Foodbank",
          alt_name: null,
          slug: "jersey",
          url: "https://jersey.invalid/",
          shopping_list_url: "https://jersey.invalid/list/",
          phone_number: "01534 000000",
          secondary_phone_number: null,
          email: "info@jersey.invalid",
          address: "1 High Street\r\nJersey Foodbank",
          postcode: "SP1 1AA",
          country: "Jersey",
          lat_lng: "51.07,-1.79",
          charity_number: "5678",
          // Has a charity number, but "Jersey" is not one of the five
          // countries charityRegisterUrl() handles -- Python's implicit
          // `return None` at the end of the function, kept verbatim rather
          // than "fixed" into an else branch.
          charity_register_url: null,
          network: "IFAN",
          need: {
            id: "cafebabe-cafe-babe-cafe-babecafebabe",
            items: [],
            excess: [],
            found: "2025-12-31 23:59:59.000001",
          },
        },
        address: "17 Castle Street",
        postcode: "SP1 17TA",
        country: "England",
        lat_lng: "51.017,-1.79",
        place_id: null,
        store_id: "STORE-0001",
      },
      {
        id: "11112222-3333-4444-5555-666677778888",
        name: "Zetland Tesco",
        foodbank: SALISBURY,
        address: "11 Castle Street",
        postcode: "SP1 11TA",
        country: "England",
        lat_lng: "51.011,-1.79",
        place_id: "ChIJdd4hrwug2EcRmSrV3Vo6llI",
        store_id: "STORE-4471",
      },
    ]);
  });

  // The ordering claim on its own, stated as the sequence rather than as
  // four separate positions, because the two candidate orders share no
  // position: a raw SQL `ORDER BY name` (or reading the
  // dp_company_slug_name index in its own order) gives
  // Closed/Zetland/ashford/Ávila, and dropping sortByName gives insertion
  // order. Neither can pass this.
  it("orders by name with a linguistic collator, not bytewise and not by id", async () => {
    const body = JSON.parse(await (await get("/api/3/donationpoints/company/tesco/")).text()) as { name: string }[];

    expect(body.map((dp) => dp.name)).toEqual(["ashford Tesco", "Ávila Tesco", "Closed Tesco Metro", "Zetland Tesco"]);
  });

  // charityRegisterUrl()'s FIRST line, `if (!charity_number) return None`,
  // which the four rows above cannot reach because every one of them has a
  // number. Not a hypothetical: plenty of food banks are projects of a
  // church or a school and hold no registration of their own, and the
  // response must carry a null link rather than a URL ending in `regid=`
  // with nothing after it -- which is precisely what deleting that guard
  // produces, and it is a live link to the wrong page, not an error.
  //
  // Added after a mutation run: dropping the guard survived every other
  // test in this file.
  it("publishes a null charity_register_url for a food bank with no charity number", async () => {
    seedFoodbank({
      id: 61,
      uuid: "77777777777777777777777777777777",
      slug: "church-project",
      name: "Church Project Foodbank",
      country: "England", // a country that DOES have a register, so only the missing number can produce the null
      charityNumber: null,
      latestNeedId: 105,
    });
    seedNeed({
      id: 105,
      needId: "88888888888888888888888888888888",
      foodbankId: 61,
      changeText: "Beans",
      created: "2026-02-02 02:02:02.000002",
    });
    seedDonationPoint({
      id: 62,
      uuid: "66666666666666666666666666666666",
      foodbankId: 61,
      name: "Spar Church Project",
      slug: "spar-church",
      companySlug: "spar",
    });

    const body = JSON.parse(await (await get("/api/3/donationpoints/company/spar/")).text()) as {
      foodbank: { charity_number: string | null; charity_register_url: string | null };
    }[];

    expect(body).toHaveLength(1);
    expect(body[0]!.foodbank.charity_number).toBeNull();
    expect(body[0]!.foodbank.charity_register_url).toBeNull();
  });

  // A filter that did nothing would pass every assertion above -- all four
  // expected rows would still be there, just with three extras. This is the
  // negative half, with the positive control in the same body so it cannot
  // pass vacuously on an empty response.
  it("returns only that company's donation points, and matches company_slug case-sensitively", async () => {
    const body = await (await get("/api/3/donationpoints/company/tesco/")).text();

    expect(body).toContain("Zetland Tesco");
    // Another company entirely.
    expect(body).not.toContain("Sainsburys Local Salisbury");
    // company_slug IS NULL -- an independent collection point.
    expect(body).not.toContain("Independent Church Hall");
    // Differs from "tesco" only in case. SQLite's `=` on TEXT is
    // byte-comparing unless a column declares COLLATE NOCASE, and
    // foodbankdonationpoint.company_slug does not, so this row is excluded
    // -- which matches Postgres, where Django's `filter(company_slug=slug)`
    // is equally case-sensitive.
    expect(body).not.toContain("TESCO Shouty Branch");
  });

  // The mirror of the case-sensitivity assertion above, from the other end:
  // asking for the shouty spelling finds ONLY the shouty row. Together the
  // two prove the case sensitivity is real rather than an artefact of the
  // exists-check answering first.
  it("finds the differently-cased company only under its own exact slug", async () => {
    const res = await get("/api/3/donationpoints/company/TESCO/");
    const body = JSON.parse(await res.text()) as { name: string }[];

    expect(res.status).toBe(200);
    expect(body.map((dp) => dp.name)).toEqual(["TESCO Shouty Branch"]);
  });

  // gfapi3/views.py:19-20 -- the exists() check, and the exact body it
  // returns. Asserted as the whole object, not just the status: a consumer
  // branches on this payload, and "404" alone would still pass if the body
  // became Hono's own text 404 page.
  it("404s an unknown company with the JSON error body, not the site 404 page", async () => {
    const res = await get("/api/3/donationpoints/company/waitrose/");

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(await res.text())).toEqual({ error: "Company not found" });
  });

  // A company whose only donation points are orphaned. companyDonationPoints
  // Exist reads the BASE TABLE (so it says yes), while the list query INNER
  // JOINs foodbank (so it drops the row) -- the two disagree, and the result
  // is a 200 with an empty array rather than the 404 the exists check was
  // meant to guarantee.
  //
  // PINNED, NOT WISHED AWAY. Django could not reach this state (Postgres
  // enforces the FK; D1 has no foreign keys at all, PLAN.md §4.5), so there
  // is no Django behaviour to match. `[]` is what a consumer gets today.
  it("returns an empty array when every donation point at a company is orphaned", async () => {
    seedDonationPoint({
      id: 31,
      uuid: "beefbeefbeefbeefbeefbeefbeefbeef",
      foodbankId: 999, // no such foodbank row
      name: "Orphaned Co-op",
      slug: "orphan",
      companySlug: "coop",
    });

    const res = await get("/api/3/donationpoints/company/coop/");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("[]");
  });

  // Every column the handler does not name. The dict at gfapi3/views.py:
  // 51-82 lists 8 donation-point fields and 16 food bank fields; a handler
  // that spread the row instead, or a query widened back to `SELECT *` with
  // a spread downstream, would leak the internal note, the phone number and
  // the opening hours of every store at the company.
  it("publishes none of the donation-point columns outside the dict", async () => {
    const body = await (await get("/api/3/donationpoints/company/tesco/")).text();

    expect(body).toContain("Zetland Tesco"); // positive control
    for (const unread of [
      "Internal note, never published", // notes
      "Mon-Sat 08:00-20:00", // opening_hours
      "PLUSCODECOMPOUND",
      "PLUSCODEGLOBAL",
      "Wiltshire", // county
      "Salisbury District", // district
      "Bemerton Ward", // ward
      "E01032015", // lsoa
      "E02006697", // msoa
      "John Glen", // mp
      "Conservative", // mp_party
      "01722 000000", // the donation point's OWN phone, not the food bank's
      "tesco.invalid/store", // url
      "Tesco Stores Ltd", // company (the display name; company_slug is the key, not a field)
      "2026-08-14", // modified
      "wheelchair_accessible",
      "in_store_only",
      "is_closed",
    ]) {
      expect(body).not.toContain(unread);
    }
  });

  // The three EMPTY_NEEDS sentinels are a CONTRACT, spelt exactly, and the
  // list is closed. "Nothing" and "Facebook" are already in the body test
  // above; this covers "Unknown" and, more importantly, the near misses --
  // a case-insensitive comparison or a `.includes()` on the text would
  // empty a real need list and tell a retailer a food bank wants nothing.
  it("empties both lists for exactly the three sentinels, and for nothing else", async () => {
    const cases: [text: string, items: string[]][] = [
      ["Unknown", []],
      ["Facebook", []],
      ["Nothing", []],
      // Near misses, all of which must be treated as real item lists.
      ["nothing", ["nothing"]],
      ["NOTHING", ["NOTHING"]],
      ["Nothing needed", ["Nothing needed"]],
      ["Nothing\nBeans", ["Nothing", "Beans"]],
      [" Nothing", [" Nothing"]],
    ];

    for (const [index, [text, items]] of cases.entries()) {
      const fbId = 200 + index;
      const needId = 300 + index;
      seedFoodbank({
        id: fbId,
        uuid: String(fbId).padStart(32, "0"),
        slug: `sentinel-${index}`,
        name: `Sentinel ${index} Foodbank`,
        country: "England",
        latestNeedId: needId,
      });
      seedNeed({
        id: needId,
        needId: String(needId).padStart(32, "f"),
        foodbankId: fbId,
        changeText: text,
        // Always non-empty: for a sentinel this must be dropped, and for a
        // near miss it must survive. One fixture, both claims.
        excessChangeText: "Excess marker",
        created: "2026-01-01 00:00:00.000000",
      });
      seedDonationPoint({
        id: 400 + index,
        uuid: String(400 + index).padStart(32, "b"),
        foodbankId: fbId,
        name: `Sentinel Store ${index}`,
        slug: `sentinel-store-${index}`,
        companySlug: "sentinels",
      });
    }

    const body = JSON.parse(await (await get("/api/3/donationpoints/company/sentinels/")).text()) as {
      name: string;
      foodbank: { need: { items: string[]; excess: string[] } };
    }[];
    const byName = new Map(body.map((dp) => [dp.name, dp.foodbank.need]));

    for (const [index, [text, items]] of cases.entries()) {
      const need = byName.get(`Sentinel Store ${index}`);
      expect(need, `change_text ${JSON.stringify(text)}`).toBeDefined();
      expect(need!.items, `items for ${JSON.stringify(text)}`).toEqual(items);
      // The excess list is emptied by the SENTINEL, not by being empty
      // itself -- so it is [] exactly when items is [].
      expect(need!.excess, `excess for ${JSON.stringify(text)}`).toEqual(items.length === 0 ? [] : ["Excess marker"]);
    }
  });

  // `found` is gfapi3/views.py:75's `str(dp.foodbank.latest_need.created)`,
  // which packages/serialise reproduces. The column has held two formats
  // (migration 0022's header records the repair), so every shape it has
  // ever held is asserted here rather than only the current one -- and the
  // unparseable case is asserted BECAUSE it is a pass-through: a bad row
  // must degrade to its raw text, not 500 the whole company's feed.
  it("renders `found` as Python's str(datetime) for every shape the column has held", async () => {
    const cases: [stored: string, found: string][] = [
      // What the ETL copied out of Postgres.
      ["2020-01-24 16:30:23.173268", "2020-01-24 16:30:23.173268"],
      // What the port wrote before pyNow() was fixed and 0022 repaired the
      // rows -- normalised on the way out, so a re-introduced ISO write
      // would not change this endpoint's output shape.
      ["2026-09-05T15:21:42.853Z", "2026-09-05 15:21:42.853000"],
      // Microsecond 0: no fractional part at all.
      ["2021-06-01 00:00:00", "2021-06-01 00:00:00"],
      // Sub-microsecond digits are padded, not rounded.
      ["2022-02-02 03:04:05.5", "2022-02-02 03:04:05.500000"],
      // Unparseable -- returned verbatim rather than thrown on.
      ["not a datetime at all", "not a datetime at all"],
    ];

    for (const [index, [stored]] of cases.entries()) {
      const fbId = 500 + index;
      const needId = 600 + index;
      seedFoodbank({
        id: fbId,
        uuid: String(fbId).padStart(32, "0"),
        slug: `stamp-${index}`,
        name: `Stamp ${index} Foodbank`,
        country: "England",
        latestNeedId: needId,
      });
      seedNeed({
        id: needId,
        needId: String(needId).padStart(32, "e"),
        foodbankId: fbId,
        changeText: "Beans",
        created: stored,
      });
      seedDonationPoint({
        id: 700 + index,
        uuid: String(700 + index).padStart(32, "c"),
        foodbankId: fbId,
        name: `Stamp Store ${index}`,
        slug: `stamp-store-${index}`,
        companySlug: "stamps",
      });
    }

    const body = JSON.parse(await (await get("/api/3/donationpoints/company/stamps/")).text()) as {
      name: string;
      foodbank: { need: { found: string } };
    }[];
    const byName = new Map(body.map((dp) => [dp.name, dp.foodbank.need.found]));

    for (const [index, [stored, found]] of cases.entries()) {
      expect(byName.get(`Stamp Store ${index}`), `stored ${JSON.stringify(stored)}`).toBe(found);
    }
  });

  // gfapi3/views.py:47 accesses `dp.foodbank.latest_need.change_text` with
  // no null guard, and routes/api3.ts:36's `!` reproduces that deliberately
  // (its own comment says so). A food bank with no need at all therefore
  // takes the WHOLE COMPANY's feed down, not just its own row.
  //
  // ASSERTED, NOT FIXED: this is the module's documented intent, so a test
  // demanding a fallback would be a wishlist item. What it does pin is the
  // blast radius -- one bad row, zero rows served -- which is the fact
  // anyone deciding whether to add a guard actually needs.
  it("500s the entire response when any food bank at the company has no latest need", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    seedFoodbank({
      id: 41,
      uuid: "11111111111111111111111111111111",
      slug: "needless",
      name: "Needless Foodbank",
      country: "England",
      latestNeedId: null,
    });
    seedDonationPoint({
      id: 42,
      uuid: "22222222222222222222222222222222",
      foodbankId: 41,
      name: "Aldi Needless",
      slug: "aldi-needless",
      companySlug: "aldi",
    });
    // A perfectly good row at the same company, which is what makes this
    // about blast radius rather than about one broken row.
    seedDonationPoint({
      id: 43,
      uuid: "33333333333333333333333333333333",
      foodbankId: 1,
      name: "Aldi Salisbury",
      slug: "aldi-salisbury",
      companySlug: "aldi",
    });

    const res = await get("/api/3/donationpoints/company/aldi/");
    const body = await res.text();

    expect(res.status).toBe(500);
    // The site's own 500 page, through app.onError -- not a JSON error and
    // not a partial list.
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(body).not.toContain("Aldi Salisbury");
    expect(errors).toHaveBeenCalled();
  });

  // The same crash by a different route: latest_need_id points at a row
  // that no longer exists. 0001_core.sql:41 calls this out ("circular ref
  // to foodbankchange; fine, no FK declared"), so nothing stops a need
  // being deleted out from under a food bank -- and the LEFT JOIN then
  // hands the handler the same null the case above does.
  it("500s the same way when latest_need_id dangles", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    seedFoodbank({
      id: 51,
      uuid: "44444444444444444444444444444444",
      slug: "dangling",
      name: "Dangling Foodbank",
      country: "England",
      latestNeedId: 99999, // no such foodbankchange row
    });
    seedDonationPoint({
      id: 52,
      uuid: "55555555555555555555555555555555",
      foodbankId: 51,
      name: "Lidl Dangling",
      slug: "lidl-dangling",
      companySlug: "lidl",
    });

    expect((await get("/api/3/donationpoints/company/lidl/")).status).toBe(500);
    expect(errors).toHaveBeenCalled();
  });

  // The exists-check comes FIRST, and short-circuits. If it were dropped,
  // an unknown company would still answer (with `[]`, from the list query)
  // instead of 404ing -- so this asserts the two queries by their SQL and
  // by their count, which is the only place that ordering is visible.
  it("asks the cheap exists question first, and does not run the join for an unknown company", async () => {
    await get("/api/3/donationpoints/company/waitrose/");

    expect(prepared).toEqual(["SELECT 1 FROM foodbankdonationpoint WHERE company_slug = ? LIMIT 1"]);
  });

  it("runs exactly two queries for a known company: the exists check then one join", async () => {
    await get("/api/3/donationpoints/company/tesco/");

    expect(prepared).toHaveLength(2);
    expect(prepared[0]).toBe("SELECT 1 FROM foodbankdonationpoint WHERE company_slug = ? LIMIT 1");
    // One query for four rows across four food banks and four needs -- the
    // projected join in packages/db, not a per-row lookup. An N+1 here
    // would be invisible in the body and is exactly what the `.only(...)`
    // /select_related shape in Django was protecting against.
    expect(prepared[1]).toContain("FROM foodbankdonationpoint_full dp");
    expect(prepared[1]).toContain("JOIN foodbank f ON dp.foodbank_id = f.id");
    expect(prepared[1]).toContain("LEFT JOIN foodbankchange n ON f.latest_need_id = n.id");
    expect(prepared[1]).not.toContain("SELECT *");
  });

  // THE "GET THAT RAN AN UPDATE" GUARD. gfapi3 is read-only in Django -- no
  // save(), no queue, no counter -- and nothing about a public, cached,
  // unauthenticated endpoint should ever write. Asserted over the SQL that
  // actually reached the engine rather than by reading the handler.
  it("issues no write of any kind", async () => {
    await get("/api/3/donationpoints/company/tesco/");
    await get("/api/3/donationpoints/company/waitrose/");
    await get("/api/3/slugfromid/01234567-89ab-cdef-0123-456789abcdef/");

    expect(prepared.filter((sql) => /\b(INSERT|UPDATE|DELETE|REPLACE|DROP|CREATE)\b/i.test(sql))).toEqual([]);
  });

  // gfapi3's own header comment: "every endpoint here is JSON-only, with no
  // CORS header and no Cache-Control". Both halves asserted, because both
  // are DIVERGENCES from the Django source rather than ports of it --
  // gfapi3/views.py:16 decorates `company` with @cache_page(SECONDS_IN_HOUR),
  // which made Django send `Cache-Control: max-age=3600`. Nothing here
  // sends one, and middleware/pageCacheControl.ts does not fill the gap
  // (its CACHEABLE_TYPES covers html/rss/markdown only), so a browser
  // caches this for zero seconds where Django had it caching for an hour.
  // Pinned as the current behaviour; reported, not fixed.
  it("sends no Cache-Control and no CORS header, unlike every gfapi2 endpoint", async () => {
    const res = await get("/api/3/donationpoints/company/tesco/");

    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  // middleware/cacheTag.ts's AGGREGATE_PATHS matches /api/[123]/donation
  // points, so this response IS purgeable by the fb-all tag even though it
  // carries no Cache-Control of its own -- which matters because the zone's
  // Cache Rule can still give it an edge TTL. Without the tag, a food bank
  // changing its need list would leave this endpoint stale to TTL with no
  // way to purge it but by URL, and there is one URL per supermarket.
  it("is tagged fb-all so a need change purges it", async () => {
    const res = await get("/api/3/donationpoints/company/tesco/");

    expect(res.headers.get("Cache-Tag")).toBe("fb-all");
  });

  it("carries the three security headers every response on the site gets", async () => {
    const res = await get("/api/3/donationpoints/company/tesco/");

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  });

  // APPEND_SLASH, and the fact that it is DATA-DEPENDENT here:
  // lib/appendSlash.ts decides by probing the slashed URL with a HEAD, so a
  // known company redirects and an unknown one does not (the probe 404s, so
  // the request falls through to the site's own 404 page). Worth pinning
  // because it means a slash-less URL's status depends on the database.
  it("301s a slash-less URL for a known company, and 404s one for an unknown company", async () => {
    const known = await get("/api/3/donationpoints/company/tesco");
    expect(known.status).toBe(301);
    expect(known.headers.get("Location")).toBe(`${ORIGIN}/api/3/donationpoints/company/tesco/`);

    const unknown = await get("/api/3/donationpoints/company/waitrose");
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("Content-Type")).toContain("text/html");
  });

  // DIVERGENCE, pinned. Django's `path()` restricts nothing and `company`
  // carries no @require_GET, so a POST to this URL returned the same 200
  // JSON there. Hono registers the route for GET alone, so a POST reaches
  // app.notFound() and gets the HTML 404 page. Reported rather than
  // "fixed": a read-only endpoint answering only GET is the safer of the
  // two, and no consumer can have depended on POSTing to it.
  it("answers a POST with the site 404 page, where Django answered with the data", async () => {
    const res = await request("/api/3/donationpoints/company/tesco/", { method: "POST" });

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("Zetland Tesco");
  });
});

describe("api3 -- GET /api/3/slugfromid/:uuid/", () => {
  // gfapi3/views.py:88-92. Two lines of Django, and the entire point of
  // them is that the response body IS the slug -- no JSON wrapper, no
  // newline, nothing to strip. A helper that returned `c.json(slug)` or
  // appended a newline would still be a 200 and would break every caller.
  it("returns the bare slug as text/plain for a dashed uuid", async () => {
    const res = await get("/api/3/slugfromid/01234567-89ab-cdef-0123-456789abcdef/");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("salisbury");
    // Hono's c.text() adds the charset; Django's HttpResponse(content_type=
    // "text/plain") did not. A cosmetic divergence, pinned so it is a
    // decision rather than a surprise.
    expect(res.headers.get("Content-Type")).toBe("text/plain;charset=UTF-8");
  });

  // The column holds 32-char dashless uuids (PLAN.md §4.4), and
  // normalizeUuid strips dashes from the INPUT before comparing -- so both
  // spellings resolve. DIVERGENCE: Django's `<uuid:uuid>` path converter
  // requires the dashed 8-4-4-4-12 form, so the dashless URL 404'd at the
  // ROUTER there and never reached the view. The port is strictly more
  // permissive; pinned because a caller who found the dashless form works
  // is now depending on it.
  it("also resolves the dashless and the uppercase spellings of the same uuid", async () => {
    expect(await (await get("/api/3/slugfromid/0123456789abcdef0123456789abcdef/")).text()).toBe("salisbury");
    expect(await (await get("/api/3/slugfromid/01234567-89AB-CDEF-0123-456789ABCDEF/")).text()).toBe("salisbury");
  });

  it("resolves each seeded food bank to its own slug, not to the first row", async () => {
    // A single-row fixture cannot tell "looks the uuid up" from "returns
    // whatever row it found", so every food bank in the fixture is asked
    // for by its own uuid.
    expect(await (await get("/api/3/slugfromid/fedcba98-7654-3210-fedc-ba9876543210/")).text()).toBe("sid-valley");
    expect(await (await get("/api/3/slugfromid/abcdef01-2345-6789-abcd-ef0123456789/")).text()).toBe("isle-of-man");
    expect(await (await get("/api/3/slugfromid/99887766-5544-3322-1100-aabbccddeeff/")).text()).toBe("jersey");
  });

  // gfapi3/views.py:91-92's `HttpResponse("Not found", status=404)` -- a
  // plain-text body, NOT the site's 404 page, and the difference is visible
  // to every caller that reads the body before checking the status.
  it("404s an unknown uuid with the plain-text body Django sends", async () => {
    const res = await get("/api/3/slugfromid/00000000-0000-0000-0000-000000000000/");

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
  });

  // DIVERGENCE, pinned. `<uuid:uuid>` would have refused to match this URL
  // in Django, giving the standard HTML 404 page; here the segment is an
  // unconstrained `:uuid`, so the handler runs, the lookup misses, and the
  // caller gets the plain-text "Not found" instead. Same status, different
  // body -- and it means the D1 query runs for any garbage that arrives.
  it("runs the query and answers 'Not found' for input that is not a uuid at all", async () => {
    const res = await get("/api/3/slugfromid/salisbury/");

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
    expect(prepared).toEqual(["SELECT slug FROM foodbank WHERE uuid = ?"]);
  });

  // The lookup is BY UUID. Asking with a slug or a numeric id must miss --
  // a query that had drifted to `WHERE slug = ?` would pass the happy-path
  // test above only if the caller happened to pass a slug, and fail
  // everything else silently.
  it("never resolves a food bank by its slug or its numeric id", async () => {
    expect((await get("/api/3/slugfromid/sid-valley/")).status).toBe(404);
    expect((await get("/api/3/slugfromid/1/")).status).toBe(404);
    expect((await get("/api/3/slugfromid/2/")).status).toBe(404);
  });

  // Projected to one column, matching Django's `.only("slug")`. The
  // foodbank table is ~80 columns wide including boundary/charity text, and
  // this endpoint is the cheapest read on the site; a `SELECT *` here would
  // be invisible in the body.
  it("selects only the slug column", async () => {
    await get("/api/3/slugfromid/01234567-89ab-cdef-0123-456789abcdef/");

    expect(prepared).toEqual(["SELECT slug FROM foodbank WHERE uuid = ?"]);
  });

  // Same two divergences as `company`, on an endpoint Django cached for a
  // WHOLE DAY (gfapi3/views.py:86, @cache_page(SECONDS_IN_DAY)). It also
  // gets no cache tag -- cacheTag.ts's FOODBANK_API pattern matches
  // /api/N/foodbank/<slug>/, not /api/3/slugfromid/ -- so if the zone's
  // Cache Rule ever does cache it, renaming a food bank cannot purge it.
  // Pinned as-is; reported, not fixed.
  it("sends no Cache-Control and gets no cache tag", async () => {
    const res = await get("/api/3/slugfromid/01234567-89ab-cdef-0123-456789abcdef/");

    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(res.headers.get("Cache-Tag")).toBeNull();
  });
});

describe("api3 -- GET /api/3/", () => {
  // gfapi3/views.py:12-13's `HttpResponse("Give Food API 3")`. The string is
  // the whole response; some monitors match on it exactly.
  it("serves the index string at the bare mount point", async () => {
    const res = await get("/api/3");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Give Food API 3");
    expect(res.headers.get("Content-Type")).toBe("text/plain;charset=UTF-8");
  });

  // THE SLASHED FORM IS SERVED BY A DIFFERENT HANDLER. index.ts:239
  // registers `/api/3/` on the app itself, because mounting a sub-app whose
  // root route is `.get("/")` matches the bare prefix but not the prefix
  // with a slash (index.ts:230-235 documents the quirk). So there are two
  // copies of this string in the tree and they must not drift -- which is
  // the only reason this test is separate from the one above.
  it("serves the same string at the slashed form, from index.ts's own copy", async () => {
    const res = await get("/api/3/");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Give Food API 3");
  });

  // No database read for either -- the index is a constant, and a query
  // here would be one per uptime check.
  it("touches the database for neither form", async () => {
    await get("/api/3");
    await get("/api/3/");

    expect(prepared).toEqual([]);
  });

  // The sub-app owns /api/3/donationpoints/ and /api/3/slugfromid/ only.
  // gfapi2 is dual-mounted at /api/ as well as /api/2/ (index.ts:229/241);
  // gfapi3 is not, and neither is it reachable under /api/2/ -- so a
  // caller who guessed either form gets a 404 rather than a working alias
  // nobody knows to purge.
  it("is not reachable under /api/ or /api/2/", async () => {
    expect((await get("/api/donationpoints/company/tesco/")).status).toBe(404);
    expect((await get("/api/2/slugfromid/01234567-89ab-cdef-0123-456789abcdef/")).status).toBe(404);
    expect((await get("/api/3/foodbanks/")).status).toBe(404);
  });
});
