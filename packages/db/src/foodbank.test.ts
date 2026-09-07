import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MIGRATIONS_SQL as SCHEMA } from "./schema.testkit";
import {
  getAllFoodbanks,
  getAllOpenFoodbanks,
  getFoodbankBySlug,
  getFoodbankIdBySlug,
  getFoodbankIdByUuid,
  getFoodbankRssCrawlTargetById,
  getFoodbankSlugAndUrlById,
  getFoodbankSlugById,
  getFoodbankSlugByUuid,
  getFoodbanksByConstituencyId,
  getFoodbanksByCountry,
  getFoodbanksByIds,
  getOpenFoodbankCoordinates,
  getOpenFoodbanksWithDeliveryAddress,
  mapFoodbankRow,
} from "./foodbank";
import type { Session } from "./types";

// The `foodbank` table's read layer -- fifteen queries that between them feed
// gfapi1, gfapi2, gfapi3, the WFBN pages, every nearest-food-bank search, the
// admin's need-review queue and the article crawler. Every one of them is one
// SQL statement and nothing else.
//
// WHY THIS RUNS A REAL ENGINE. Nothing in this module can fail loudly. There
// is no 500 and no log line when a query returns the wrong rows -- there is
// just a wrong page:
//
//   * A lost `is_closed = 0` puts closed food banks back into every search
//     result and every GeoJSON feed. The endpoints still return 200.
//   * A gained `is_closed = 0` on getAllFoodbanks or getFoodbankBySlug
//     silently retires half of gfapi1's contract (frozen bug B8) and 404s
//     every closed food bank's page, which is exactly the page people reach
//     from an old Google result.
//   * getFoodbanksByIds re-sorting into rowid order instead of the caller's
//     order turns "nearest 10 food banks" into "10 food banks", ranked by
//     whatever D1 felt like. Still ten results, still a 200.
//   * `latest_need_id` resolving to the wrong row publishes one food bank's
//     shopping list under another's name.
//
// A mocked session that hands back canned rows would prove none of that: this
// module contains no logic to test APART from the SQL, so a fake engine
// tests a second implementation of the query rather than the query. Every
// test below therefore seeds real rows into real SQLite and asserts WHICH
// ROWS come back, in WHICH ORDER -- never that "an array is returned".
//
// THE SCHEMA IS THE MIGRATION FILES THEMSELVES, applied in order, as
// charity.test.ts and adminSubscribers.test.ts do it. That is this repo's own
// scar tissue: 0019 dropped `foodbank_name` off five tables and four queries
// elsewhere went on naming a column that no longer existed, silently, until
// somebody measured /dashboard/beautybanks/ and found a live 500. A
// hand-transcribed CREATE TABLE in a test file is a second copy of the truth
// and second copies drift; reading the real migrations means this file fails
// on the day a migration and this module stop agreeing. It also means
// `foodbankchange_full` -- the VIEW getFoodbankBySlug reaches through for
// `latestNeed` -- is the real view, joined the real way, rather than a
// stand-in row that would make the whole latest-need half of this file
// circular.
//
// WHY THE SUPPRESSED IMPORTS. packages/db typechecks with
// `"types": ["@cloudflare/workers-types"]` and no @types/node, so tsc reports
// TS2591 on the `node:sqlite` and `node:fs` specifiers and TS2339 on
// `import.meta.url`. `@ts-ignore` rather than `@ts-expect-error`, following
// adminStats.test.ts and charity.test.ts: if @types/node is ever added to this
// package an @ts-expect-error would itself become the error, and a suite that
// breaks when the tooling is FIXED is worse than three lines of suppression.
// @ts-ignore -- no @types/node under this package's tsconfig; vitest runs in node, where this module is real
import { DatabaseSync } from "node:sqlite";
// @ts-ignore -- as above

// @ts-ignore -- import.meta.url is real under vitest's node environment

// ===========================================================================
// HARNESS
// ===========================================================================

type Bindable = null | number | bigint | string | Uint8Array;

interface SqliteStatement {
  all(...params: Bindable[]): Record<string, unknown>[];
  get(...params: Bindable[]): Record<string, unknown> | undefined;
  run(...params: Bindable[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface Sent {
  sql: string;
  params: Bindable[];
}

interface FakeStatement extends Sent {
  bind(...values: unknown[]): FakeStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}

// The slice of the D1 Sessions API this module uses, over node:sqlite.
// Deliberately dumb: it carries SQL to a real engine and never interprets it,
// or these tests would be asserting against a second implementation of the
// thing under test.
//
// `calls` records statements AT EXECUTION TIME, not at prepare() time, and it
// is load-bearing rather than decoration. getFoodbanksByIds exists in its
// current shape because every list and search endpoint was issuing one
// `latest_need` lookup PER RESULT -- N+1 round trips, measured against
// production as the slowest thing in the whole API. "The right rows come
// back" is true of both the fast and the slow version, so the only way to
// pin the fix is to count the statements that actually reached the engine.
//
// bind() returns a NEW statement rather than mutating this one, matching D1's
// immutable prepared statements.
function d1Session(db: SqliteDatabase): { session: Session; calls: Sent[] } {
  const calls: Sent[] = [];

  function statement(sql: string, params: Bindable[]): FakeStatement {
    return {
      sql,
      params,
      bind: (...values: unknown[]) => statement(sql, values as Bindable[]),
      first: async <T,>() => {
        calls.push({ sql, params });
        return (db.prepare(sql).get(...params) ?? null) as T | null;
      },
      all: async <T,>() => {
        calls.push({ sql, params });
        return { results: db.prepare(sql).all(...params) as T[] };
      },
    };
  }

  const session = { prepare: (sql: string) => statement(sql, []) } as unknown as Session;
  return { session, calls };
}

// ===========================================================================
// FIXTURES
// ===========================================================================

let db: SqliteDatabase;
let session: Session;
let calls: Sent[];

interface FoodbankSeed {
  id: number;
  slug: string;
  name?: string;
  uuid?: string;
  country?: string;
  isClosed?: 0 | 1;
  latitude?: number | null;
  longitude?: number | null;
  deliveryAddress?: string | null;
  constituencyId?: number | null;
  latestNeedId?: number | null;
  rssUrl?: string | null;
  url?: string;
  isSchool?: 0 | 1 | null;
  placeHasPhoto?: 0 | 1 | null;
}

// Fills every NOT NULL column the real table declares, so a seeded row is one
// production would actually have accepted, and leaves the rest NULL. The two
// UNIQUE indexes (name, slug) come from the migrations, so a fixture that
// reused either would fail to insert rather than quietly testing a state the
// database cannot hold.
//
// `uuid` defaults to a 32-char dashless LOWERCASE value because that is what
// the ETL writes (tools/pg-to-d1/extract_core.py:391-394,
// `str(value).replace("-", "").lower()`), and both uuid lookups here depend on
// that being true -- see the case-sensitivity test under getFoodbankIdByUuid.
function seedFoodbank(seed: FoodbankSeed): void {
  const {
    id,
    slug,
    name = slug.replace(/(^|-)(\w)/g, (_m: string, _p: string, c: string) => c.toUpperCase()),
    uuid = `${id}`.padStart(32, "a"),
    country = "England",
    isClosed = 0,
    latitude = 51.0688,
    longitude = -1.7945,
    deliveryAddress = null,
    constituencyId = null,
    latestNeedId = null,
    rssUrl = null,
    url = `https://${slug}.foodbank.org.uk/`,
    isSchool = null,
    placeHasPhoto = null,
  } = seed;

  db.prepare(
    `INSERT INTO foodbank (
       id, uuid, name, slug, address, postcode, country, lat_lng, latitude, longitude,
       delivery_address, charity_just_foodbank, contact_email, url, shopping_list_url,
       rss_url, place_has_photo, parliamentary_constituency_id,
       address_is_administrative, is_closed, is_school, no_locations, days_between_needs,
       latest_need_id, created, modified
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, 14, ?, ?, ?)`,
  ).run(
    id,
    uuid,
    name,
    slug,
    "1 High Street\r\nSalisbury",
    "SP1 1AA",
    country,
    `${latitude ?? ""},${longitude ?? ""}`,
    latitude,
    longitude,
    deliveryAddress,
    `info@${slug}.foodbank.org.uk`,
    url,
    `https://${slug}.foodbank.org.uk/shopping-list/`,
    rssUrl,
    placeHasPhoto,
    constituencyId,
    isClosed,
    isSchool,
    latestNeedId,
    // Django's own timestamp format, six fractional digits -- see
    // 0022_normalise_timestamps.sql. Not toISOString(): these columns are TEXT
    // and SQLite compares TEXT byte-wise, so mixing the two formats in a
    // fixture would make any ordering assertion agree with a bug.
    "2020-03-11 09:00:00.000000",
    "2026-08-01 09:15:22.412000",
  );
}

// A need row as the ETL wrote it. `foodbankId` is separate from the food bank
// that POINTS at this need via latest_need_id, because foodbankchange_full
// joins on the NEED's own foodbank_id -- and that column is nullable (an
// unassigned need), which is why 0019 made that view a LEFT JOIN.
function seedNeed(row: {
  id: number;
  needId: string;
  foodbankId: number | null;
  changeText: string;
  published?: 0 | 1;
  created?: string;
}): void {
  db.prepare(
    `INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, published, nonpertinent,
       is_categorised, input_method, created, modified)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, 'scrape', ?, ?)`,
  ).run(
    row.id,
    row.needId,
    row.foodbankId,
    row.changeText,
    row.published ?? 1,
    row.created ?? "2026-07-30 14:02:11.917000",
    "2026-07-30 14:02:11.917000",
  );
}

const slugs = (rows: { slug: string }[]): string[] => rows.map((row) => row.slug);
const sortedSlugs = (rows: { slug: string }[]): string[] => slugs(rows).sort();

beforeEach(() => {
  db = new DatabaseSync(":memory:") as unknown as SqliteDatabase;
  db.exec(SCHEMA);
  ({ session, calls } = d1Session(db));
});

afterEach(() => {
  db.close();
});

// ===========================================================================
// mapFoodbankRow -- the 0/1 -> boolean coercion every query above runs through
// ===========================================================================

describe("mapFoodbankRow", () => {
  // The five columns in BOOLEAN_COLUMNS, and only those five. Getting this
  // list wrong is invisible from the row shape: `is_closed: 1` and
  // `is_closed: true` both look fine in a console.log, but `if (fb.is_closed)`
  // is true for BOTH 0 and 1 if the coercion is skipped, which would mark
  // every food bank in the country closed.
  it("turns the five INTEGER boolean columns into real booleans", () => {
    const mapped = mapFoodbankRow({
      id: 1,
      charity_just_foodbank: 1,
      place_has_photo: 1,
      address_is_administrative: 0,
      is_closed: 0,
      is_school: 1,
    });

    expect(mapped.charity_just_foodbank).toBe(true);
    expect(mapped.place_has_photo).toBe(true);
    expect(mapped.address_is_administrative).toBe(false);
    expect(mapped.is_closed).toBe(false);
    expect(mapped.is_school).toBe(true);
  });

  // The tri-state contract from PLAN.md §4.4, kept for the two nullable
  // columns of the five. `place_has_photo: null` means "we have never looked",
  // and coalescing it to false would have the photo pipeline treat every
  // unchecked food bank as one it has already checked and found nothing for.
  it("preserves NULL as null rather than coalescing it to false", () => {
    const mapped = mapFoodbankRow({ place_has_photo: null, is_school: null, is_closed: 0 });

    expect(mapped.place_has_photo).toBeNull();
    expect(mapped.is_school).toBeNull();
  });

  // A projected row (`SELECT slug, url ...`) has no `is_closed` key at all.
  // coerceBooleans turns the missing key into an explicit null rather than
  // leaving it absent, so a mapped partial row gains five keys it did not
  // have. Pinned because it is surprising, not because it is desirable: it is
  // the reason the projection helpers below return their raw rows and do NOT
  // go through mapFoodbankRow.
  it("materialises absent boolean columns as null", () => {
    const mapped = mapFoodbankRow({ slug: "salisbury" });

    expect(mapped.is_closed).toBeNull();
    expect(Object.keys(mapped).sort()).toEqual([
      "address_is_administrative",
      "charity_just_foodbank",
      "is_closed",
      "is_school",
      "place_has_photo",
      "slug",
    ]);
  });

  // `value === 1`, not `!!value`. SQLite's INTEGER column will hold anything
  // an INSERT puts in it -- there is no CHECK constraint on any of these five
  // -- so a stray 2 reads back as FALSE, not true. Pinned so that a future
  // "tidy-up" to `Boolean(value)` has to be a deliberate decision rather than
  // an accident.
  it("treats any integer other than 1 as false", () => {
    expect(mapFoodbankRow({ is_closed: 2 }).is_closed).toBe(false);
    expect(mapFoodbankRow({ is_closed: -1 }).is_closed).toBe(false);
  });

  it("leaves every non-boolean column exactly as the engine returned it", () => {
    const mapped = mapFoodbankRow({
      id: 42,
      slug: "salisbury",
      latitude: 51.0688,
      lat_lng: "51.0688,-1.7945",
      alt_name: null,
      is_closed: 0,
    });

    expect(mapped.id).toBe(42);
    expect(mapped.slug).toBe("salisbury");
    expect(mapped.latitude).toBe(51.0688);
    // The API emits lat_lng verbatim (foodbank.ts:22) -- it must stay the
    // string the ETL copied, not become a number pair.
    expect(mapped.lat_lng).toBe("51.0688,-1.7945");
    expect(mapped.alt_name).toBeNull();
  });

  it("does not mutate the row the engine handed it", () => {
    const raw = { is_closed: 1 };
    mapFoodbankRow(raw);

    expect(raw.is_closed).toBe(1);
  });
});

// ===========================================================================
// getAllFoodbanks -- gfapi1 `api_foodbanks`
// ===========================================================================

describe("getAllFoodbanks", () => {
  // FROZEN BUG B8 (PLAN.md §7.3). v1 includes closed food banks and v2 does
  // not, and that difference is the shipped contract of two public APIs.
  // Django's get_all_foodbanks() is `Foodbank.objects.all()` with no filter
  // (givefood/utils/cache.py:37-45), and "harmonising" the two versions would
  // silently shrink a response third parties parse.
  it("includes closed food banks, unlike every other list query here", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    seedFoodbank({ id: 2, slug: "closed-town", isClosed: 1 });

    expect(sortedSlugs(await getAllFoodbanks(session))).toEqual(["closed-town", "salisbury"]);
  });

  // No ORDER BY in the query and none in Django either -- Foodbank.Meta
  // declares indexes but no `ordering` (givefood/models/foodbank.py:577), so
  // `Foodbank.objects.all()` is unordered in Postgres too. Asserted as a
  // SORTED set rather than a literal array on purpose: pinning the order rows
  // happen to come back in would be pinning an accident of the storage
  // engine, and the next test that seeds in a different order would break.
  it("returns every row, and coerces the booleans on all of them", async () => {
    seedFoodbank({ id: 3, slug: "salisbury" });
    seedFoodbank({ id: 1, slug: "closed-town", isClosed: 1 });
    seedFoodbank({ id: 2, slug: "bath" });

    const rows = await getAllFoodbanks(session);

    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.slug === "closed-town")!.is_closed).toBe(true);
    expect(rows.find((r) => r.slug === "salisbury")!.is_closed).toBe(false);
  });

  it("returns an empty array, not null, for an empty table", async () => {
    expect(await getAllFoodbanks(session)).toEqual([]);
  });

  // THE 0019 TRIPWIRE. This is a `SELECT *`, so the row handed to
  // packages/serialise is whatever the table currently has -- and FoodbankRow
  // is a hand-maintained transcription of it. When 0019 dropped a column off
  // five tables, four queries went on naming a column that no longer existed
  // and nothing said so until a page 500ed in production.
  //
  // The list below is FoodbankRow's 79 fields (foodbank.ts:13-93). If a
  // migration adds a column, this fails and the type needs the field; if one
  // drops a column, this fails and every consumer reading that field needs
  // finding. Either way it fails HERE, in a second, rather than in a
  // dashboard nobody visits.
  it("returns exactly the 79 columns FoodbankRow declares", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });

    const [row] = await getAllFoodbanks(session);

    expect(Object.keys(row!).sort()).toEqual(
      [
        "address",
        "address_is_administrative",
        "alt_name",
        "bankuet_slug",
        "bounds_east",
        "bounds_north",
        "bounds_south",
        "bounds_west",
        "charity_id",
        "charity_just_foodbank",
        "charity_name",
        "charity_number",
        "charity_objectives",
        "charity_postcode",
        "charity_purpose",
        "charity_reg_date",
        "charity_type",
        "charity_website",
        "contact_email",
        "contacts_url",
        "country",
        "county",
        "created",
        "days_between_needs",
        "delivery_address",
        "delivery_lat_lng",
        "delivery_phone_number",
        "district",
        "donation_points_url",
        "edited",
        "facebook_page",
        "footprint",
        "fsa_id",
        "id",
        "is_closed",
        "is_school",
        "last_charity_check",
        "last_crawl",
        "last_discrepancy_check",
        "last_need",
        "last_need_check",
        "last_order",
        "last_rfi",
        "last_social_media_check",
        "lat_lng",
        "latest_need_id",
        "latitude",
        "locations_url",
        "longitude",
        "lsoa",
        "modified",
        "mp",
        "mp_parl_id",
        "mp_party",
        "msoa",
        "name",
        "network",
        "network_id",
        "news_url",
        "no_donation_points",
        "no_locations",
        "notes",
        "notification_email",
        "parliamentary_constituency_id",
        "parliamentary_constituency_name",
        "parliamentary_constituency_slug",
        "phone_number",
        "place_has_photo",
        "place_id",
        "plus_code_compound",
        "plus_code_global",
        "postcode",
        "rss_url",
        "secondary_phone_number",
        "shopping_list_url",
        "slug",
        "url",
        "uuid",
        "ward",
      ].sort(),
    );
  });
});

// ===========================================================================
// getAllOpenFoodbanks -- gfapi2 `foodbanks`, and every search's candidate set
// ===========================================================================

describe("getAllOpenFoodbanks", () => {
  // The mutant this kills is the one-character edit `is_closed = 0` ->
  // nothing: every closed food bank reappears in gfapi2's list endpoint and in
  // the candidate set for every nearest-food-bank search, and the site starts
  // sending people to food banks that shut. Seeding a closed row is what makes
  // the filter testable at all -- a fixture of only open rows passes whether
  // the WHERE clause is there or not.
  it("excludes closed food banks", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    seedFoodbank({ id: 2, slug: "closed-town", isClosed: 1 });
    seedFoodbank({ id: 3, slug: "bath" });

    expect(sortedSlugs(await getAllOpenFoodbanks(session))).toEqual(["bath", "salisbury"]);
  });

  // No coordinate filter, deliberately: a food bank with no geocode is still a
  // food bank and still appears in gfapi2's list. It is the RANKING layer
  // (@givefood/geo) that has to cope, not this query -- see the
  // getOpenFoodbankCoordinates note below on what that costs.
  it("keeps open food banks that have never been geocoded", async () => {
    seedFoodbank({ id: 1, slug: "ungeocoded", latitude: null, longitude: null });

    expect(slugs(await getAllOpenFoodbanks(session))).toEqual(["ungeocoded"]);
  });

  it("maps the booleans on the rows it returns", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", isSchool: 1, placeHasPhoto: 0 });

    const [row] = await getAllOpenFoodbanks(session);

    expect(row!.is_school).toBe(true);
    expect(row!.place_has_photo).toBe(false);
    expect(row!.is_closed).toBe(false);
  });
});

// ===========================================================================
// getOpenFoodbankCoordinates -- WP 2.5's covering-index candidate set
// ===========================================================================

describe("getOpenFoodbankCoordinates", () => {
  // THE WHOLE POINT OF THIS FUNCTION IS THE NARROW PROJECTION. `foodbank_open
  // _latlng_idx` is a partial index on exactly (latitude, longitude) WHERE
  // is_closed = 0, so selecting only these three columns is answered from the
  // index without touching a table row. Widening it to `SELECT *` -- 79
  // columns x every open food bank in the country, to rank by distance and
  // then throw all but ten away -- was measured as the dominant cost on every
  // uncached search request (PLAN.md, WP 2.5).
  //
  // toEqual on the whole object, not a property check: extra keys fail it,
  // which is the only way a test can notice a projection quietly widening.
  it("returns id and coordinates and nothing else", async () => {
    seedFoodbank({ id: 7, slug: "salisbury", latitude: 51.0688, longitude: -1.7945 });

    expect(await getOpenFoodbankCoordinates(session)).toEqual([{ id: 7, latitude: 51.0688, longitude: -1.7945 }]);
  });

  it("excludes closed food banks, so they can never be ranked into a search", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", latitude: 51.06, longitude: -1.79 });
    seedFoodbank({ id: 2, slug: "closed-town", isClosed: 1, latitude: 51.07, longitude: -1.8 });

    expect((await getOpenFoodbankCoordinates(session)).map((r) => r.id)).toEqual([1]);
  });

  // MUTANT KILLED: `return (await queryCoordinates(...)).slice(0, 1)` -- the
  // "return the first row instead of all rows" edit. Every other test in this
  // describe seeds ONE open food bank, so a truncating implementation passed
  // all of them; it then hands @givefood/geo a candidate set of one, and every
  // postcode search in the country ranks the same food bank first because it
  // is the only thing there was to rank. Nothing throws, nothing 500s, and the
  // page looks exactly like a working nearest-food-bank result.
  //
  // Sorted by id before comparing, not asserted in scan order: the query has
  // no ORDER BY and pinning rowid order would pin an accident of the engine.
  it("returns every open food bank, not just the first", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", latitude: 51.0688, longitude: -1.7945 });
    seedFoodbank({ id: 2, slug: "bath", latitude: 51.3811, longitude: -2.359 });
    seedFoodbank({ id: 3, slug: "closed-town", isClosed: 1, latitude: 51.5, longitude: -2.0 });
    seedFoodbank({ id: 4, slug: "devizes", latitude: 51.3521, longitude: -1.9959 });

    const rows = [...(await getOpenFoodbankCoordinates(session))].sort((a, b) => a.id - b.id);

    expect(rows).toEqual([
      { id: 1, latitude: 51.0688, longitude: -1.7945 },
      { id: 2, latitude: 51.3811, longitude: -2.359 },
      { id: 4, latitude: 51.3521, longitude: -1.9959 },
    ]);
  });

  // SUSPECT, PINNED AS-IS. `latitude`/`longitude` are NULLABLE columns
  // (0001_core.sql:17) but CoordinateRow declares them `number`, and this
  // query has no `latitude IS NOT NULL` guard -- so an un-geocoded open food
  // bank arrives at @givefood/geo's nearest() as `latitude: null`, where the
  // haversine arithmetic produces NaN and the row sorts to the end rather than
  // being excluded. queryCoordinates casts rather than validates, so
  // TypeScript never sees it.
  //
  // Asserted as the CURRENT behaviour, not the desired one: adding the guard
  // is a behaviour change (it would also change which rows the partial index
  // can answer from), and a red test would tell nobody anything. If the guard
  // is ever added, this test is the thing that says what it changed.
  it("returns un-geocoded open rows with null coordinates, despite the number type", async () => {
    seedFoodbank({ id: 1, slug: "ungeocoded", latitude: null, longitude: null });

    expect(await getOpenFoodbankCoordinates(session)).toEqual([{ id: 1, latitude: null, longitude: null }]);
  });

  // REAL, not TEXT: the coordinates go straight into distance arithmetic, and
  // a string would make `lat - lat2` NaN without anything raising.
  it("returns the coordinates as numbers", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", latitude: 51.0688, longitude: -1.7945 });

    const [row] = await getOpenFoodbankCoordinates(session);

    expect(typeof row!.latitude).toBe("number");
    expect(typeof row!.longitude).toBe("number");
  });
});

// ===========================================================================
// getFoodbankBySlug -- gfapi1 `api_foodbank` / gfapi2 `foodbank`
// ===========================================================================

describe("getFoodbankBySlug", () => {
  it("returns null for a slug that does not exist", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });

    expect(await getFoodbankBySlug(session, "no-such-foodbank")).toBeNull();
  });

  // NO is_closed FILTER, on purpose: neither Django detail view has one, and a
  // closed food bank's page is still servable by slug. Adding the filter here
  // would 404 the exact page somebody reaches from a two-year-old link or a
  // Google result, which is the page most likely to be visited by somebody who
  // needs to know it has closed.
  it("serves a closed food bank by slug", async () => {
    seedFoodbank({ id: 1, slug: "closed-town", isClosed: 1 });

    const row = await getFoodbankBySlug(session, "closed-town");

    expect(row!.slug).toBe("closed-town");
    expect(row!.is_closed).toBe(true);
  });

  // SQLite's default collation is BINARY and Postgres's `=` is case-sensitive
  // too, so this is parity, not an accident. Pinned because `COLLATE NOCASE`
  // looks like a harmless kindness and would make /needs/at/Salisbury/ and
  // /needs/at/salisbury/ two URLs for one page -- a duplicate-content split
  // the canonical-URL work exists to prevent.
  it("matches the slug case-sensitively", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });

    expect(await getFoodbankBySlug(session, "Salisbury")).toBeNull();
  });

  // `select_related("latest_need")` in both Django detail views. The need is
  // read through foodbankchange_full (the VIEW), not the base table, so this
  // also pins that the view's joined columns survive the trip -- a template
  // reading `need.foodbank_name` renders blank, silently, if this ever drops
  // back to the base table.
  it("attaches the latest need, with its own booleans coerced and the view's join intact", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", latestNeedId: 500 });
    seedNeed({ id: 500, needId: "ab".repeat(16), foodbankId: 1, changeText: "Tinned tomatoes\nUHT milk", published: 1 });

    const row = await getFoodbankBySlug(session, "salisbury");

    expect(row!.latestNeed).toEqual({
      id: 500,
      need_id: "abababababababababababababababab",
      foodbank_id: 1,
      distill_id: null,
      name: null,
      uri: null,
      change_text: "Tinned tomatoes\nUHT milk",
      change_text_original: null,
      excess_change_text: null,
      excess_change_text_original: null,
      published: true,
      nonpertinent: null,
      is_categorised: null,
      notified: null,
      input_method: "scrape",
      created: "2026-07-30 14:02:11.917000",
      modified: "2026-07-30 14:02:11.917000",
      foodbank_name: "Salisbury",
      foodbank_slug: "salisbury",
    });
  });

  // The need_id stays 32-char DASHLESS here. Django's JSON encoder emits the
  // dashed form, so the dashing is packages/serialise's job (uuid.ts's
  // toDashedUuid) -- doing it in the db layer as well would double-dash it.
  it("leaves the need_id in its stored dashless form", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", latestNeedId: 500 });
    seedNeed({ id: 500, needId: "8c1e9a3f4b7d4e2fa1c05d6b8e9f0a12", foodbankId: 1, changeText: "Beans" });

    const row = await getFoodbankBySlug(session, "salisbury");

    expect(row!.latestNeed!.need_id).toBe("8c1e9a3f4b7d4e2fa1c05d6b8e9f0a12");
  });

  // A food bank that has never had a need at all. `latest_need_id === null`
  // short-circuits BEFORE the query, so this is also the assertion that the
  // second round trip is skipped -- see the call count.
  it("returns latestNeed null, and issues no second query, when latest_need_id is null", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", latestNeedId: null });

    const row = await getFoodbankBySlug(session, "salisbury");

    expect(row!.latestNeed).toBeNull();
    expect(calls).toHaveLength(1);
  });

  // D1 HAS NO FOREIGN KEYS (PLAN.md §4.5), so `latest_need_id` can outlive the
  // row it points at -- a hard-deleted need leaves every food bank that
  // pointed at it dangling. This must come back as `latestNeed: null` rather
  // than throwing, because the detail endpoint is a public page and a throw
  // here is a 500 for a food bank whose only sin is an admin deletion.
  it("survives a latest_need_id pointing at a row that no longer exists", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", latestNeedId: 999 });

    const row = await getFoodbankBySlug(session, "salisbury");

    expect(row!.latestNeed).toBeNull();
  });

  it("returns the food bank's own columns alongside the need", async () => {
    seedFoodbank({ id: 4, slug: "salisbury", latestNeedId: 500, url: "https://salisburyfoodbank.org.uk/" });
    seedNeed({ id: 500, needId: "cd".repeat(16), foodbankId: 4, changeText: "Beans" });

    const row = await getFoodbankBySlug(session, "salisbury");

    expect(row!.id).toBe(4);
    expect(row!.url).toBe("https://salisburyfoodbank.org.uk/");
    expect(row!.latest_need_id).toBe(500);
  });
});

// ===========================================================================
// getFoodbanksByIds -- the ranked-set enricher
// ===========================================================================

describe("getFoodbanksByIds", () => {
  // `IN ()` with no placeholders is a SYNTAX ERROR in SQLite, so the early
  // return is not a micro-optimisation -- without it, every search that
  // matched nothing would 500. findLocationsByCategory.ts calls this with an
  // empty array on every query that finds no food bank in range.
  it("returns an empty array without touching the database", async () => {
    expect(await getFoodbanksByIds(session, [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  // THE CLAIM THIS FUNCTION IS BUILT AROUND. `WHERE id IN (...)` gives no
  // ordering guarantee -- SQLite returns rowid order here, which is ASCENDING
  // ID, the exact opposite of a distance ranking that happens to start with a
  // high id. The caller has already ranked these ids by distance; losing that
  // turns "your nearest food bank" into "the food bank with the lowest id
  // within 20km", with no error and a plausible-looking page.
  //
  // The ids below are deliberately requested in an order that disagrees with
  // both rowid order and insertion order, so neither can pass by accident.
  it("returns the rows in the caller's id order, not the database's", async () => {
    seedFoodbank({ id: 1, slug: "aaa-first-by-rowid" });
    seedFoodbank({ id: 2, slug: "bbb" });
    seedFoodbank({ id: 3, slug: "ccc" });

    expect(slugs(await getFoodbanksByIds(session, [3, 1, 2]))).toEqual(["ccc", "aaa-first-by-rowid", "bbb"]);
  });

  // ONE PLACEHOLDER PER ID AND NOTHING ELSE IN THE WHERE. This is the one
  // claim in this describe that no row assertion can make, because the re-sort
  // above hides it: a predicate that had stopped narrowing -- `id IN (...) OR
  // 1 = 1` -- returns every food bank in the country and `byId.get()` then
  // throws all but the asked-for ones away, so every other test here still
  // passes. The rows are right; the bill is not. D1 meters rows READ, not rows
  // returned (PLAN.md §4.3), and this query runs on every search request.
  // That mutant survived a first pass of this file, which is why this
  // assertion exists.
  it("narrows to the asked-for ids in the statement, not afterwards in JavaScript", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    seedFoodbank({ id: 2, slug: "bath" });
    seedFoodbank({ id: 3, slug: "devizes" });

    await getFoodbanksByIds(session, [3, 1]);

    expect(calls[0]!.sql).toBe("SELECT * FROM foodbank WHERE id IN (?, ?)");
    expect(calls[0]!.params).toEqual([3, 1]);
  });

  // Frozen behaviour B12's other half: a dangling id (a food bank deleted
  // between the coordinate scan and this fetch, or a location whose
  // foodbank_id points nowhere) is DROPPED, not returned as an undefined hole.
  // The callers index the result by id and would otherwise crash on a hole
  // they never checked for.
  it("drops ids with no matching row instead of leaving a gap", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    seedFoodbank({ id: 3, slug: "bath" });

    expect(slugs(await getFoodbanksByIds(session, [1, 2, 3]))).toEqual(["salisbury", "bath"]);
  });

  // Duplicates in, duplicates out: the re-sort maps over the CALLER's array,
  // so an id listed twice yields the row twice. Pinned rather than praised --
  // it is what the code does, and a caller that de-dupes (findDonationpoints
  // does, via a Set) is relying on itself, not on this function.
  it("repeats a row when the caller repeats its id", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });

    expect(slugs(await getFoodbanksByIds(session, [1, 1]))).toEqual(["salisbury", "salisbury"]);
  });

  // THE N+1 FIX, WHICH NO ROW ASSERTION CAN SEE. Before it, this function
  // called getNeedById once per row: with 20 search results that is 21 D1
  // round trips, and it was measured against production as the slowest thing
  // in the whole API. The rows are identical either way, so the only
  // observable difference is the number of statements that reach the engine.
  it("fetches every latest_need in ONE extra query, not one per row", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", latestNeedId: 501 });
    seedFoodbank({ id: 2, slug: "bath", latestNeedId: 502 });
    seedFoodbank({ id: 3, slug: "devizes", latestNeedId: 503 });
    seedNeed({ id: 501, needId: "01".repeat(16), foodbankId: 1, changeText: "Beans" });
    seedNeed({ id: 502, needId: "02".repeat(16), foodbankId: 2, changeText: "Pasta" });
    seedNeed({ id: 503, needId: "03".repeat(16), foodbankId: 3, changeText: "Rice" });

    const rows = await getFoodbanksByIds(session, [1, 2, 3]);

    expect(rows.map((r) => r.latestNeed!.change_text)).toEqual(["Beans", "Pasta", "Rice"]);
    expect(calls).toHaveLength(2);
  });

  // The batched path must read the same VIEW the single-row path does.
  // Pinned separately from getFoodbankBySlug's equivalent because the two are
  // different functions (needs.ts's getNeedsByIds vs getNeedById) and only the
  // single-row one is exercised above: pointing the batch at the base
  // `foodbankchange` table returns rows that still have an id, a change_text
  // and a published flag, so every other assertion in this describe still
  // passes -- and `foodbank_name` silently becomes undefined on every search
  // result and every donation-point listing. That mutant was run; this is the
  // assertion that killed it.
  it("reads the batched needs through foodbankchange_full, joined columns and all", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", latestNeedId: 501 });
    seedNeed({ id: 501, needId: "01".repeat(16), foodbankId: 1, changeText: "Beans" });

    const rows = await getFoodbanksByIds(session, [1]);

    expect(rows[0]!.latestNeed).toEqual({
      id: 501,
      need_id: "01010101010101010101010101010101",
      foodbank_id: 1,
      distill_id: null,
      name: null,
      uri: null,
      change_text: "Beans",
      change_text_original: null,
      excess_change_text: null,
      excess_change_text_original: null,
      published: true,
      nonpertinent: null,
      is_categorised: null,
      notified: null,
      input_method: "scrape",
      created: "2026-07-30 14:02:11.917000",
      modified: "2026-07-30 14:02:11.917000",
      foodbank_name: "Salisbury",
      foodbank_slug: "salisbury",
    });
  });

  // Distinct ids only. Two food banks sharing a latest_need row is real -- the
  // admin's need-copy tools do it -- and binding the same id twice would waste
  // a parameter out of D1's ceiling of 100 for no rows.
  it("de-duplicates the need ids it asks for", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", latestNeedId: 501 });
    seedFoodbank({ id: 2, slug: "bath", latestNeedId: 501 });
    seedNeed({ id: 501, needId: "01".repeat(16), foodbankId: 1, changeText: "Beans" });

    const rows = await getFoodbanksByIds(session, [1, 2]);

    expect(rows.map((r) => r.latestNeed!.id)).toEqual([501, 501]);
    expect(calls[1]!.params).toEqual([501]);
  });

  // A null latest_need_id must not become a bound NULL in the IN list: `id IN
  // (NULL)` matches nothing but still costs a parameter, and more importantly
  // the row must come back with `latestNeed: null` rather than being dropped.
  it("skips null latest_need_ids entirely and still returns the row", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", latestNeedId: null });
    seedFoodbank({ id: 2, slug: "bath", latestNeedId: 502 });
    seedNeed({ id: 502, needId: "02".repeat(16), foodbankId: 2, changeText: "Pasta" });

    const rows = await getFoodbanksByIds(session, [1, 2]);

    expect(rows[0]!.latestNeed).toBeNull();
    expect(rows[1]!.latestNeed!.change_text).toBe("Pasta");
    expect(calls[1]!.params).toEqual([502]);
  });

  // When NO row in the batch has a latest need, getNeedsByIds returns early
  // and the second query never runs. One round trip, not two.
  it("issues no need query at all when nothing in the batch has a latest need", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    seedFoodbank({ id: 2, slug: "bath" });

    await getFoodbanksByIds(session, [1, 2]);

    expect(calls).toHaveLength(1);
  });

  it("resolves a dangling latest_need_id to null rather than throwing", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", latestNeedId: 999 });

    expect((await getFoodbanksByIds(session, [1]))[0]!.latestNeed).toBeNull();
  });

  it("includes closed food banks when asked for them by id", async () => {
    // No is_closed predicate here, and there should not be one: the callers
    // have already chosen these ids from an open-only candidate set, and a
    // second filter would only make a mismatch between the two silent.
    seedFoodbank({ id: 1, slug: "closed-town", isClosed: 1 });

    expect(slugs(await getFoodbanksByIds(session, [1]))).toEqual(["closed-town"]);
  });

  // MUTANT KILLED: `const rows = result.results.map((r) => r as FoodbankRow)`
  // -- the map through mapFoodbankRow dropped from THIS function only. It
  // survived every other test in this describe, because they all read `slug`,
  // `id`, `latestNeed` or a call count, and none of those change. What changes
  // is that `is_closed` arrives as 1 rather than true on every search result
  // and every donation-point listing: packages/serialise then emits
  // `"is_closed": 1` into a public API response third parties parse, and
  // `is_school: 0` reads as a number in every template that tests it. The
  // three sibling list queries each need their own version of this assertion
  // for the same reason -- the mutation is per-function, so one test cannot
  // cover four call sites.
  it("coerces the boolean columns on the rows it returns", async () => {
    seedFoodbank({ id: 1, slug: "closed-town", isClosed: 1, isSchool: 1, placeHasPhoto: 0 });

    const [row] = await getFoodbanksByIds(session, [1]);

    expect(row!.is_closed).toBe(true);
    expect(row!.is_school).toBe(true);
    expect(row!.place_has_photo).toBe(false);
    expect(row!.charity_just_foodbank).toBe(false);
  });

  // D1'S 100-BOUND-PARAMETER CEILING. This function builds ONE statement with
  // one placeholder per id and does not chunk, so 101 ids is one statement
  // with 101 binds -- which node:sqlite (limit 32,766) runs happily and D1
  // rejects outright. Both live callers pass a quantity-bounded 20, so this is
  // a landmine rather than a live bug; it is pinned so that anyone raising
  // that quantity, or calling this from somewhere new, finds the ceiling here
  // rather than in production.
  //
  // The need query has the same shape and the same ceiling: 101 food banks
  // with 101 distinct needs is a second 101-parameter statement.
  it("builds a single un-chunked statement, one parameter per id, past D1's cap of 100", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    for (const id of ids) {
      seedFoodbank({ id, slug: `foodbank-${id}`, latestNeedId: 1000 + id });
      seedNeed({ id: 1000 + id, needId: `${id}`.padStart(32, "e"), foodbankId: id, changeText: `Need ${id}` });
    }

    const rows = await getFoodbanksByIds(session, ids);

    expect(rows).toHaveLength(101);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.params).toHaveLength(101);
    expect(calls[1]!.params).toHaveLength(101);
    // ...and the ordering still holds at that size, which is the thing a
    // future chunked implementation is most likely to lose.
    expect(rows[0]!.id).toBe(1);
    expect(rows[100]!.id).toBe(101);
  });

  it("stays inside the cap at exactly 100 ids", async () => {
    const ids = Array.from({ length: 100 }, (_, i) => i + 1);
    for (const id of ids) seedFoodbank({ id, slug: `foodbank-${id}` });

    const rows = await getFoodbanksByIds(session, ids);

    expect(rows).toHaveLength(100);
    expect(calls[0]!.params).toHaveLength(100);
  });
});

// ===========================================================================
// The single-row projections
// ===========================================================================

// gfapi3 `slugfromid` -- `.only("slug")`.
describe("getFoodbankSlugByUuid", () => {
  const DASHLESS = "8c1e9a3f4b7d4e2fa1c05d6b8e9f0a12";
  const DASHED = "8c1e9a3f-4b7d-4e2f-a1c0-5d6b8e9f0a12";

  beforeEach(() => {
    seedFoodbank({ id: 1, slug: "salisbury", uuid: DASHLESS });
  });

  // The column holds the DASHLESS form (PLAN.md §4.4) but every caller-facing
  // uuid in the wild is dashed -- Django's JSON encoder emits `str(UUID)`, so
  // that is the form third parties copied out of the v1 and v2 APIs and put
  // into their own code. Dropping normalizeUuid would 404 every one of them.
  it("finds the row from the dashed form callers actually have", async () => {
    expect(await getFoodbankSlugByUuid(session, DASHED)).toBe("salisbury");
  });

  it("finds the row from the dashless form too", async () => {
    expect(await getFoodbankSlugByUuid(session, DASHLESS)).toBe("salisbury");
  });

  it("finds the row from an uppercase uuid", async () => {
    expect(await getFoodbankSlugByUuid(session, DASHED.toUpperCase())).toBe("salisbury");
  });

  it("returns null for an unknown uuid", async () => {
    expect(await getFoodbankSlugByUuid(session, "0".repeat(32))).toBeNull();
  });

  // Django's `.only("slug")`, and the reason this function exists rather than
  // getFoodbankBySlug being reused: gfapi3 needs one string, and a `SELECT *`
  // here would drag 79 columns (and, worse, invite somebody to add the
  // latest_need round trip) into a redirect.
  it("projects to the slug column alone", async () => {
    await getFoodbankSlugByUuid(session, DASHED);

    expect(calls[0]!.sql).toContain("SELECT slug FROM foodbank");
    expect(calls[0]!.sql).not.toContain("*");
  });
});

// The stored-side case sensitivity, which normalizeUuid cannot fix.
describe("getFoodbankIdByUuid", () => {
  const DASHLESS = "8c1e9a3f4b7d4e2fa1c05d6b8e9f0a12";

  // wfbn-generic `mobsub`/`delete_mobsub` -- the shipped mobile app identifies
  // a food bank by uuid, so this is a contract with binaries already on
  // people's phones, not something a redeploy can change.
  it("resolves a dashed uuid to the numeric id the FK needs", async () => {
    seedFoodbank({ id: 42, slug: "salisbury", uuid: DASHLESS });

    expect(await getFoodbankIdByUuid(session, "8c1e9a3f-4b7d-4e2f-a1c0-5d6b8e9f0a12")).toBe(42);
  });

  it("returns null for an unknown uuid rather than throwing", async () => {
    seedFoodbank({ id: 42, slug: "salisbury", uuid: DASHLESS });

    expect(await getFoodbankIdByUuid(session, "f".repeat(32))).toBeNull();
  });

  // normalizeUuid lowercases the NEEDLE, and SQLite's `=` is case-sensitive,
  // so a row STORED with an uppercase uuid can never be found. That is fine
  // only because the ETL lowercases on the way in
  // (tools/pg-to-d1/extract_core.py:391-394) -- this test is what says that
  // lowercasing is load-bearing, so nobody removes it as tidying.
  it("cannot find a row whose stored uuid is uppercase", async () => {
    seedFoodbank({ id: 42, slug: "salisbury", uuid: DASHLESS.toUpperCase() });

    expect(await getFoodbankIdByUuid(session, DASHLESS)).toBeNull();
  });

  // MUTANT KILLED: `SELECT * FROM foodbank WHERE uuid = ?`. It survived the
  // first pass of this file because `row.id` is right either way -- the only
  // observable difference is 79 columns read to answer a subscribe or
  // unsubscribe call from the shipped mobile app, on an engine that bills by
  // rows SCANNED rather than rows returned (PLAN.md §4.3). Pinned the same way
  // getFoodbankSlugByUuid's `.only("slug")` is, because the projection is the
  // entire reason this function exists rather than getFoodbankBySlug.
  it("projects to the id column alone", async () => {
    seedFoodbank({ id: 42, slug: "salisbury", uuid: DASHLESS });

    await getFoodbankIdByUuid(session, DASHLESS);

    expect(calls[0]!.sql).toContain("SELECT id FROM foodbank");
    expect(calls[0]!.sql).not.toContain("*");
  });

  // MUTANT KILLED: `return row?.id || null`, one careless tidy-up away from
  // the `row ? row.id : null` that is actually there. `id INTEGER PRIMARY KEY`
  // accepts 0, so food bank 0 is a legal row, and `|| null` reports it as "no
  // such food bank" -- for mobsub that is a subscription silently dropped
  // instead of a 404, and the caller cannot tell the two apart. Every other
  // fixture in this file uses a truthy id, which is exactly why this mutant
  // had nothing to fail against.
  it("distinguishes food bank 0 from no food bank at all", async () => {
    seedFoodbank({ id: 0, slug: "zero", uuid: DASHLESS });

    expect(await getFoodbankIdByUuid(session, DASHLESS)).toBe(0);
  });
});

// WP 6.4 -- the need-review queue's detail page.
describe("getFoodbankSlugById", () => {
  it("returns the slug for a known id", async () => {
    seedFoodbank({ id: 7, slug: "salisbury" });

    expect(await getFoodbankSlugById(session, 7)).toBe("salisbury");
  });

  // A SECOND ROW IS SEEDED ON PURPOSE. A `WHERE id = ?` that had stopped
  // filtering -- an `OR 1 = 1` left behind by debugging, a bind that never
  // reached the statement -- returns the first row in the table, and against a
  // fixture holding only the row being asked for that is indistinguishable
  // from working. With a second row present, an unfiltered query answers with
  // the WRONG food bank's slug, which is what it would do in the review queue.
  it("returns null for an id with no row, without falling back to another", async () => {
    seedFoodbank({ id: 7, slug: "salisbury" });
    seedFoodbank({ id: 9, slug: "bath" });

    expect(await getFoodbankSlugById(session, 8)).toBeNull();
  });

  // The same `.only("slug")` projection as getFoodbankSlugByUuid: the review
  // queue wants one string to build a preview link with, not 79 columns.
  it("projects to the slug column alone", async () => {
    seedFoodbank({ id: 7, slug: "salisbury" });

    await getFoodbankSlugById(session, 7);

    expect(calls[0]!.sql).toContain("SELECT slug FROM foodbank");
    expect(calls[0]!.sql).not.toContain("*");
  });

  // The review queue holds needs for food banks that have since closed, and
  // the reviewer still has to be able to open them.
  it("finds a closed food bank", async () => {
    seedFoodbank({ id: 7, slug: "closed-town", isClosed: 1 });

    expect(await getFoodbankSlugById(session, 7)).toBe("closed-town");
  });
});

// WP 6.4 -- the discrepancy-review page's proxy-preview guard.
describe("getFoodbankSlugAndUrlById", () => {
  // toEqual on the whole object: this feeds a guard that asks "is
  // discrepancy.url actually THIS food bank's own url?" before offering a
  // preview through the WP-6.3 allowlisted proxy. A widened projection would
  // not break the guard, but it would put 77 unneeded columns behind an admin
  // page that renders two of them -- and toEqual is the only assertion that
  // notices a projection growing.
  it("returns exactly the slug/url pair, and nothing else", async () => {
    seedFoodbank({ id: 7, slug: "salisbury", url: "https://salisburyfoodbank.org.uk/" });

    expect(await getFoodbankSlugAndUrlById(session, 7)).toEqual({
      slug: "salisbury",
      url: "https://salisburyfoodbank.org.uk/",
    });
  });

  // `first()` gives undefined-free null, and `row ?? null` keeps it that way:
  // the caller checks `=== null`, and an undefined would slip past a `!== null`
  // guard into `row.url` and 500 the admin page. The other row exists so that
  // an id predicate which had stopped filtering would answer with the wrong
  // food bank's url instead of null -- and this guard decides whether an
  // arbitrary URL is offered through the WP-6.3 proxy allowlist, so "some
  // other food bank's url" is the failure that matters here.
  it("returns null, not undefined, for an unknown id", async () => {
    seedFoodbank({ id: 9, slug: "bath", url: "https://bathfoodbank.org/" });

    expect(await getFoodbankSlugAndUrlById(session, 7)).toBeNull();
  });
});

// gfadmin/views.py:1984-1986 -- need_notifications' article crawl.
describe("getFoodbankRssCrawlTargetById", () => {
  // Exactly three columns: the two the ARTICLES_Q message carries and the one
  // the `if foodbank.rss_url` guard reads.
  it("returns exactly id, slug and rss_url", async () => {
    seedFoodbank({ id: 7, slug: "salisbury", rssUrl: "https://salisburyfoodbank.org.uk/feed/" });

    expect(await getFoodbankRssCrawlTargetById(session, 7)).toEqual({
      id: 7,
      slug: "salisbury",
      rss_url: "https://salisburyfoodbank.org.uk/feed/",
    });
  });

  // The guard's whole purpose. `rss_url` is nullable and most food banks have
  // no feed; coalescing the null to "" here would make `if (target.rss_url)`
  // still false, but a coalesce to something truthy would enqueue a crawl of
  // the empty string for every food bank that has never had a feed.
  it("preserves a null rss_url so the caller's guard can see it", async () => {
    seedFoodbank({ id: 7, slug: "salisbury", rssUrl: null });

    expect(await getFoodbankRssCrawlTargetById(session, 7)).toEqual({ id: 7, slug: "salisbury", rss_url: null });
  });

  // Another row present, for the same reason as the two above: an unfiltered
  // lookup would enqueue an article crawl of somebody else's feed under this
  // need's food bank slug, and every article it found would be filed against
  // the wrong food bank.
  it("returns null for an unknown id", async () => {
    seedFoodbank({ id: 9, slug: "bath", rssUrl: "https://bathfoodbank.org/feed/" });

    expect(await getFoodbankRssCrawlTargetById(session, 7)).toBeNull();
  });
});

// wfbn-generic `foodbank_hit` -- existence check only.
describe("getFoodbankIdBySlug", () => {
  it("returns the id for a known slug", async () => {
    seedFoodbank({ id: 7, slug: "salisbury" });

    expect(await getFoodbankIdBySlug(session, "salisbury")).toBe(7);
  });

  // gfwfbn/views.py:1210-1212 404s an unknown slug, so the beacon must be
  // able to tell "no such food bank" from "food bank 0".
  //
  // Two rows are seeded even though the slug asked for matches neither: a
  // `slug = ?` predicate that had stopped filtering would return the first row
  // in the table, and against an EMPTY fixture that is indistinguishable from
  // a correct null. This is the mutant that survived the first pass of this
  // file -- `WHERE slug = ? OR 1 = 1` -- and the reason the seeds are here.
  it("returns null for an unknown slug rather than whatever row comes first", async () => {
    seedFoodbank({ id: 7, slug: "salisbury" });
    seedFoodbank({ id: 8, slug: "bath" });

    expect(await getFoodbankIdBySlug(session, "no-such-foodbank")).toBeNull();
  });

  it("finds a closed food bank, whose page is still served and still counted", async () => {
    seedFoodbank({ id: 7, slug: "closed-town", isClosed: 1 });

    expect(await getFoodbankIdBySlug(session, "closed-town")).toBe(7);
  });

  // The distinction the comment above CLAIMS -- "no such food bank" versus
  // "food bank 0" -- and which, until this test, nothing actually checked.
  // MUTANT KILLED: `return row?.id || null`, a plausible tidy-up of `row ?
  // row.id : null` that is invisible to every other fixture here because they
  // all use a truthy id. Food bank 0 is a legal row under `id INTEGER PRIMARY
  // KEY`, and reporting it as absent 404s a page that exists.
  it("returns 0 for food bank 0, rather than reporting it missing", async () => {
    seedFoodbank({ id: 0, slug: "zero" });

    expect(await getFoodbankIdBySlug(session, "zero")).toBe(0);
  });
});

// ===========================================================================
// getFoodbanksByConstituencyId -- ParliamentaryConstituency.foodbank_obj()
// ===========================================================================

describe("getFoodbanksByConstituencyId", () => {
  const SALISBURY_CON = 601;
  const BATH_CON = 602;

  // Both halves of the WHERE, with a row seeded that each half alone would let
  // through: the closed food bank IN the constituency (killed by is_closed =
  // 0) and the open food bank in ANOTHER constituency (killed by the id
  // predicate). A fixture with only matching rows would pass with either
  // predicate deleted.
  it("returns the open food banks in that constituency and no others", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", constituencyId: SALISBURY_CON });
    seedFoodbank({ id: 2, slug: "wilton", constituencyId: SALISBURY_CON });
    seedFoodbank({ id: 3, slug: "closed-town", constituencyId: SALISBURY_CON, isClosed: 1 });
    seedFoodbank({ id: 4, slug: "bath", constituencyId: BATH_CON });

    expect(sortedSlugs(await getFoodbanksByConstituencyId(session, SALISBURY_CON))).toEqual(["salisbury", "wilton"]);
  });

  // NULL IS NEVER EQUAL TO ANYTHING, including whatever id is bound. A food
  // bank whose constituency has not been resolved yet (a new row, or one whose
  // postcode lookup failed) belongs to no constituency page rather than to all
  // of them -- and this is the same three-valued-logic trap that `id IS NOT ?`
  // exists for elsewhere in this package, in its benign direction.
  it("never matches a food bank with no constituency", async () => {
    seedFoodbank({ id: 1, slug: "unresolved", constituencyId: null });

    expect(await getFoodbanksByConstituencyId(session, SALISBURY_CON)).toEqual([]);
  });

  it("returns an empty array for a constituency with no food banks", async () => {
    seedFoodbank({ id: 1, slug: "bath", constituencyId: BATH_CON });

    expect(await getFoodbanksByConstituencyId(session, SALISBURY_CON)).toEqual([]);
  });

  it("coerces the booleans on the rows it returns", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", constituencyId: SALISBURY_CON });

    expect((await getFoodbanksByConstituencyId(session, SALISBURY_CON))[0]!.is_closed).toBe(false);
  });
});

// ===========================================================================
// getOpenFoodbanksWithDeliveryAddress -- gfapi2 `donationpoints`
// ===========================================================================

describe("getOpenFoodbanksWithDeliveryAddress", () => {
  it("returns open food banks that have a delivery address", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", deliveryAddress: "Unit 3, Southampton Road\r\nSalisbury" });
    seedFoodbank({ id: 2, slug: "bath", deliveryAddress: "12 Widcombe Hill\r\nBath" });

    expect(sortedSlugs(await getOpenFoodbanksWithDeliveryAddress(session))).toEqual(["bath", "salisbury"]);
  });

  it("excludes an empty-string delivery address", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", deliveryAddress: "" });

    expect(await getOpenFoodbanksWithDeliveryAddress(session)).toEqual([]);
  });

  // The closed half of the WHERE. A closed food bank with a delivery address
  // would otherwise appear as a GeoJSON feature telling somebody to drive
  // food to a shut warehouse.
  it("excludes a closed food bank even when it has a delivery address", async () => {
    seedFoodbank({ id: 1, slug: "closed-town", isClosed: 1, deliveryAddress: "Unit 3, Southampton Road" });

    expect(await getOpenFoodbanksWithDeliveryAddress(session)).toEqual([]);
  });

  // SUSPECT, PINNED AS-IS -- AND THE MODULE'S OWN COMMENT IS WRONG ABOUT IT.
  // foodbank.ts:257-261 says this "matches Django's
  // `.exclude(delivery_address__exact='')`" because "both Postgres and SQLite
  // exclude NULL here too". The first half of that is not what Django emits.
  // `delivery_address` is `TextField(null=True, blank=True)`
  // (givefood/models/foodbank.py:69), and for a NULLABLE field Django's
  // exclude() adds an IS NOT NULL guard INSIDE the negation -- verified by
  // running Django 5.2.6 and printing the query, not by reading the docs:
  //
  //   NOT ("delivery_address" = '' AND "delivery_address" IS NOT NULL)
  //
  // For a NULL row that inner clause is (NULL AND FALSE) = FALSE, so NOT FALSE
  // is TRUE and DJANGO INCLUDES IT. This port's `delivery_address != ''` is
  // NULL for that row and EXCLUDES it. The two disagree.
  //
  // The port's behaviour is the safer of the two -- Django's own view would
  // then call `delivery_lat_lng.split(",")` on a None and 500
  // (gfapi2/views.py:656, models/foodbank.py:290-294) -- so this is asserted
  // as current behaviour, not fixed. Reported as a suspect comment rather than
  // a suspect query.
  it("excludes a NULL delivery address, which Django's exclude() would have kept", async () => {
    seedFoodbank({ id: 1, slug: "no-delivery", deliveryAddress: null });
    seedFoodbank({ id: 2, slug: "salisbury", deliveryAddress: "Unit 3, Southampton Road" });

    expect(slugs(await getOpenFoodbanksWithDeliveryAddress(session))).toEqual(["salisbury"]);
  });

  // Whitespace is not emptiness under either engine, and Django's
  // `__exact=''` agrees -- a single space is a delivery address as far as both
  // are concerned. Pinned so a well-meaning `trim()`-equivalent (`TRIM
  // (delivery_address) != ''`) is recognised as a behaviour change.
  it("keeps a whitespace-only delivery address, matching Django's __exact=''", async () => {
    seedFoodbank({ id: 1, slug: "whitespace", deliveryAddress: " " });

    expect(slugs(await getOpenFoodbanksWithDeliveryAddress(session))).toEqual(["whitespace"]);
  });

  // MUTANT KILLED: mapFoodbankRow dropped from this query's result map, as
  // under getFoodbanksByIds above. Every other test in this describe asserts
  // slugs, which the mutation does not touch; what it does touch is gfapi2's
  // donationpoints feed, which starts carrying `is_closed: 0` instead of false
  // on every synthetic delivery-address feature.
  it("coerces the boolean columns on the rows it returns", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", deliveryAddress: "Unit 3, Southampton Road", isSchool: 1 });

    const [row] = await getOpenFoodbanksWithDeliveryAddress(session);

    expect(row!.is_closed).toBe(false);
    expect(row!.is_school).toBe(true);
  });
});

// ===========================================================================
// getFoodbanksByCountry -- givefood `country_geojson`
// ===========================================================================

describe("getFoodbanksByCountry", () => {
  it("returns the open food banks in that country and no others", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", country: "England" });
    seedFoodbank({ id: 2, slug: "bangor", country: "Wales" });
    seedFoodbank({ id: 3, slug: "aberdeen", country: "Scotland" });
    seedFoodbank({ id: 4, slug: "closed-town", country: "England", isClosed: 1 });

    expect(sortedSlugs(await getFoodbanksByCountry(session, "England"))).toEqual(["salisbury"]);
  });

  // The country column is the denormalised name the geocoder wrote, and the
  // caller passes COUNTRY_MAPPING's value for the URL slug -- both sides are
  // exact strings, both engines compare them case-sensitively, and a
  // `COLLATE NOCASE` here would quietly change which rows a public feed
  // contains. Django's filter is a plain `country = %s` (verified by printing
  // the queryset's SQL), so this is parity.
  it("matches the country name case-sensitively", async () => {
    seedFoodbank({ id: 1, slug: "lowercase-england", country: "england" });
    seedFoodbank({ id: 2, slug: "proper-england", country: "England" });

    expect(slugs(await getFoodbanksByCountry(session, "England"))).toEqual(["proper-england"]);
  });

  // Multi-word country names go through as one bound parameter, not as
  // something a LIKE would split. "Northern Ireland" is the case that would
  // break under any attempt to make the match fuzzier.
  it("matches a multi-word country name whole", async () => {
    seedFoodbank({ id: 1, slug: "belfast", country: "Northern Ireland" });
    seedFoodbank({ id: 2, slug: "dublin-road", country: "Ireland" });

    expect(slugs(await getFoodbanksByCountry(session, "Northern Ireland"))).toEqual(["belfast"]);
  });

  // The open English food bank is what makes this test able to fail: a
  // country predicate that had stopped filtering would return it, and a
  // fixture holding only the closed Welsh row would call that empty result a
  // pass.
  it("returns an empty array for a country with no open food banks", async () => {
    seedFoodbank({ id: 1, slug: "closed-town", country: "Wales", isClosed: 1 });
    seedFoodbank({ id: 2, slug: "salisbury", country: "England" });

    expect(await getFoodbanksByCountry(session, "Wales")).toEqual([]);
  });

  // MUTANT KILLED: `result.results.slice(0, 1).map(mapFoodbankRow)` -- the
  // "first row instead of all rows" edit. Every OTHER test in this describe
  // expects exactly one matching row (one English, one properly-cased, one
  // Northern Irish, none at all), so a truncating implementation passed the
  // lot of them, and country_geojson would ship a feed containing a single
  // food bank per country. Four rows, three of them matching, is the smallest
  // fixture that can tell the difference.
  it("returns every open food bank in the country, not just the first", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", country: "England" });
    seedFoodbank({ id: 2, slug: "bath", country: "England" });
    seedFoodbank({ id: 3, slug: "devizes", country: "England" });
    seedFoodbank({ id: 4, slug: "bangor", country: "Wales" });

    expect(sortedSlugs(await getFoodbanksByCountry(session, "England"))).toEqual(["bath", "devizes", "salisbury"]);
  });

  // MUTANT KILLED: mapFoodbankRow dropped, third of the four list queries that
  // needed its own copy of this assertion. The country feed is public JSON, so
  // the visible symptom is `"is_closed": 0` and `"is_school": 1` in a response
  // that has always emitted booleans.
  it("coerces the boolean columns on the rows it returns", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", country: "England", isSchool: 0, placeHasPhoto: 1 });

    const [row] = await getFoodbanksByCountry(session, "England");

    expect(row!.is_closed).toBe(false);
    expect(row!.is_school).toBe(false);
    expect(row!.place_has_photo).toBe(true);
  });

  it("binds the country name rather than interpolating it", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", country: "England" });

    await getFoodbanksByCountry(session, "England");

    expect(calls[0]!.params).toEqual(["England"]);
    expect(calls[0]!.sql).not.toContain("England");
  });
});
