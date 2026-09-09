import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MIGRATIONS_SQL as SCHEMA } from "./schema.testkit";
import {
  getAllFoodbanks,
  getAllOpenFoodbankSlugs,
  getAllOpenFoodbankSlugsWithNames,
  getAllOpenFoodbanks,
  getAllOpenFoodbanksForSitemap,
  getFoodbankBySlug,
  getFoodbankBySlugWithOpenCoordinates,
  getFoodbankBySlugWithServiceArea,
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
// The oracle for github #51's "the rows did not move" comparison -- the
// dependent PK lookup getFoodbankBySlug used to await after its food bank row.
// Still live code, still used by the notify/translate queue consumers.
import { getNeedById } from "./needs";
// And the oracle for github #52 item 3's: the id-keyed COUNT(*) the three page
// routes used to issue as a round trip of their own. Imported here rather than
// re-spelled, so the comparison is against the definition locations.test.ts
// already pins against Django, not against a second copy of it.
import { hasServiceArea } from "./locations";
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

// One entry per D1 ROUND TRIP, each holding the statements that trip carried:
// a bare `.first()`/`.all()` is a one-element array, a `batch()` of N is one
// N-element array. STATEMENTS AND ROUND TRIPS ARE DIFFERENT COUNTS and both are
// asserted below -- getFoodbankBySlug sends two statements in ONE trip, and
// `calls` alone cannot tell that apart from the two sequential awaits it
// replaced.
type RoundTrip = Sent[];

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
// `roundTrips` is the same log grouped by NETWORK CALL, and it exists for the
// same reason one step further on: getFoodbankBySlug sends two statements in
// one batch(), so the statement count alone cannot distinguish it from the two
// sequential awaits it replaced. Both versions execute two SELECTs; only one of
// them waits for D1 twice.
//
// bind() returns a NEW statement rather than mutating this one, matching D1's
// immutable prepared statements.
//
// batch() RUNS ITS STATEMENTS IN ORDER AND RETURNS ONE RESULT PER INPUT, in
// that order, copied from foodbankDetail.test.ts's adapter. That ordering is
// part of what these tests defend: getFoodbankBySlug indexes straight into
// `results[0]` and `results[1]`, and a batch that reordered or coalesced them
// would attach one food bank's need row to another food bank without erroring.
function d1Session(db: SqliteDatabase): { session: Session; calls: Sent[]; roundTrips: RoundTrip[] } {
  const calls: Sent[] = [];
  const roundTrips: RoundTrip[] = [];

  // Every path into the engine goes through here, so `calls` counts statements
  // whether they arrived alone or inside a batch. The round trip is recorded by
  // the caller instead, which is what keeps the two counts independent.
  function exec(sql: string, params: Bindable[]): Record<string, unknown>[] {
    calls.push({ sql, params });
    return db.prepare(sql).all(...params);
  }

  function statement(sql: string, params: Bindable[]): FakeStatement {
    return {
      sql,
      params,
      bind: (...values: unknown[]) => statement(sql, values as Bindable[]),
      first: async <T,>() => {
        roundTrips.push([{ sql, params }]);
        return (exec(sql, params)[0] ?? null) as T | null;
      },
      all: async <T,>() => {
        roundTrips.push([{ sql, params }]);
        return { results: exec(sql, params) as T[] };
      },
    };
  }

  async function batch(statements: FakeStatement[]): Promise<Array<{ results: unknown[] }>> {
    roundTrips.push(statements.map((s) => ({ sql: s.sql, params: s.params })));
    return statements.map((s) => ({ results: exec(s.sql, s.params) }));
  }

  const session = { prepare: (sql: string) => statement(sql, []), batch } as unknown as Session;
  return { session, calls, roundTrips };
}

// ===========================================================================
// FIXTURES
// ===========================================================================

let db: SqliteDatabase;
let session: Session;
let calls: Sent[];
let roundTrips: RoundTrip[];

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
  // The five extra columns sitemap.xml's <url> loop branches on. Only these
  // and rssUrl decide which of a food bank's six possible entries the sitemap
  // emits, so a projection that dropped one would change the BODY, not just
  // the row shape -- see the getAllOpenFoodbanksForSitemap block below.
  // Defaults match the pre-existing hardcoded values so no existing test moves.
  newsUrl?: string | null;
  charityName?: string | null;
  noLocations?: number;
  noDonationPoints?: number | null;
  daysBetweenNeeds?: number;
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
    newsUrl = null,
    charityName = null,
    noLocations = 0,
    noDonationPoints = null,
    daysBetweenNeeds = 14,
  } = seed;

  db.prepare(
    `INSERT INTO foodbank (
       id, uuid, name, slug, address, postcode, country, lat_lng, latitude, longitude,
       delivery_address, charity_just_foodbank, charity_name, contact_email, url, shopping_list_url,
       rss_url, news_url, place_has_photo, parliamentary_constituency_id,
       address_is_administrative, is_closed, is_school, no_locations, no_donation_points,
       days_between_needs, latest_need_id, created, modified
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    charityName,
    `info@${slug}.foodbank.org.uk`,
    url,
    `https://${slug}.foodbank.org.uk/shopping-list/`,
    rssUrl,
    newsUrl,
    placeHasPhoto,
    constituencyId,
    isClosed,
    isSchool,
    noLocations,
    noDonationPoints,
    daysBetweenNeeds,
    latestNeedId,
    // Django's own timestamp format, six fractional digits -- see
    // 0022_normalise_timestamps.sql. Not toISOString(): these columns are TEXT
    // and SQLite compares TEXT byte-wise, so mixing the two formats in a
    // fixture would make any ordering assertion agree with a bug.
    "2020-03-11 09:00:00.000000",
    "2026-08-01 09:15:22.412000",
  );
}

// A location row, for getFoodbankBySlugWithServiceArea's COUNT(*) alone --
// which reads exactly two of these columns, foodbank_id and boundary_geojson.
// Every other NOT NULL column is filled with something the migrations would
// have accepted, so a seeded row is one production could hold. Note the ABSENT
// foodbank_name/_slug/_network/_email: 0019_drop_foodbank_cache.sql dropped
// those five denormalised columns off this table, and because the schema here
// is the real migration files applied in order, naming one is an insert-time
// error rather than a silently different fixture.
//
// `isClosed` is parameterised because the count deliberately does NOT filter
// on it (Django's queryset is a bare `.filter(foodbank = self)`), and a
// behaviour that is asserted has to be seedable.
function seedLocation(row: {
  id: number;
  foodbankId: number;
  name: string;
  boundaryGeojson?: string | null;
  isClosed?: 0 | 1;
}): void {
  db.prepare(
    `INSERT INTO foodbanklocation (id, uuid, foodbank_id, name, slug, country, lat_lng,
       is_closed, boundary_geojson, modified)
     VALUES (?, ?, ?, ?, ?, 'England', '51.0688,-1.7945', ?, ?, ?)`,
  ).run(
    row.id,
    `${row.id}`.padStart(32, "b"),
    row.foodbankId,
    row.name,
    row.name.toLowerCase().replace(/\s+/g, "-"),
    row.isClosed ?? 0,
    row.boundaryGeojson ?? null,
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
  ({ session, calls, roundTrips } = d1Session(db));
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
// getAllOpenFoodbanksForSitemap / getAllOpenFoodbankSlugs /
// ...SlugsWithNames -- the three column-projected variants behind
// /sitemap.xml, /md/sitemap.xml and /md/sitemap.md
// ===========================================================================
//
// These exist ONLY to stop `SELECT *` dragging 3.59 MB of D1 result payload
// per render out of the 1,023 open food banks to read seven short columns
// (measured on production: 3,590,727 -> 279,644 bytes, a median 94 -> 8 ms,
// rows_read identical at 1,024). So the thing worth asserting is not that
// they return rows -- it is that they return the SAME rows, in the SAME
// order, with the SAME values as the `SELECT *` they replaced. A projection
// that silently dropped `no_donation_points` would still return 1,023 rows
// and still render a sitemap; it would just be missing 700-odd <url>
// entries, which no status code and no log line would ever mention.
//
// Order matters as much as content: none of these queries has an ORDER BY
// (neither did the wide one), the sitemap emits rows in arrival order, and a
// projection narrow enough to be answered from an index instead of the table
// would come back in a different order. Every case below compares against
// getAllOpenFoodbanks over the same fixture rather than against a
// hand-written expectation, so "the output did not move" is the assertion.

describe("getAllOpenFoodbanksForSitemap", () => {
  // The seven columns sitemap.xml's loop reads, and no eighth. Pinned by
  // name because the failure of a MISSING one is invisible: the row is still
  // there, the branch that reads it just goes quiet.
  it("returns exactly the seven columns the sitemap loop branches on", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });

    const [row] = await getAllOpenFoodbanksForSitemap(session);

    expect(Object.keys(row!).sort()).toEqual(
      ["charity_name", "days_between_needs", "news_url", "no_donation_points", "no_locations", "rss_url", "slug"].sort(),
    );
    expect(Object.keys(row!)).not.toContain("boundary_geojson");
    expect(Object.keys(row!)).not.toContain("charity_objectives");
  });

  // THE PARITY CHECK. Every value the sitemap can branch on, set to
  // something that is neither the column default nor falsy, and compared
  // against what `SELECT *` returned for the same rows. Three of these are
  // the ones a careless projection loses first, and each has its own visible
  // consequence in the emitted XML:
  //   days_between_needs -> the <changefreq> of the food bank's own page
  //   no_locations / no_donation_points -> whether those two <url>s exist
  //   rss_url / news_url / charity_name -> whether the news and charity
  //     <url>s exist
  it("returns the same values, for the same rows, in the same order, as SELECT *", async () => {
    seedFoodbank({
      id: 1,
      slug: "salisbury",
      daysBetweenNeeds: 3,
      noLocations: 4,
      noDonationPoints: 75,
      rssUrl: "https://salisbury.foodbank.org.uk/feed/",
      newsUrl: "https://salisbury.foodbank.org.uk/news/",
      charityName: "Salisbury Foodbank Trust",
    });
    // Seeded in an order that is NOT the slug order, and with the closed row
    // between the two open ones, so the expected sequence below is neither
    // alphabetical nor "the order the fixture inserted them".
    seedFoodbank({ id: 3, slug: "bath", daysBetweenNeeds: 21, noLocations: 0, noDonationPoints: null });
    seedFoodbank({ id: 2, slug: "closed-town", isClosed: 1, noLocations: 9 });

    const wide = await getAllOpenFoodbanks(session);
    const narrow = await getAllOpenFoodbanksForSitemap(session);

    expect(narrow).toEqual(
      wide.map((row) => ({
        slug: row.slug,
        days_between_needs: row.days_between_needs,
        no_locations: row.no_locations,
        no_donation_points: row.no_donation_points,
        rss_url: row.rss_url,
        news_url: row.news_url,
        charity_name: row.charity_name,
      })),
    );
    expect(slugs(narrow)).toEqual(["salisbury", "bath"]);
  });

  // no_donation_points is NULLABLE in production where no_locations is not,
  // and sitemaps.ts branches on it with `Boolean(...)` precisely so NULL and
  // 0 behave alike. NULL must therefore survive the projection AS null --
  // coerced to 0 it would still be falsy today, but the column is read as a
  // count elsewhere and "unknown" is not "none".
  it("preserves a NULL no_donation_points rather than coercing it", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", noDonationPoints: null });

    const [row] = await getAllOpenFoodbanksForSitemap(session);

    expect(row!.no_donation_points).toBeNull();
  });

  it("excludes closed food banks", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    seedFoodbank({ id: 2, slug: "closed-town", isClosed: 1 });

    expect(sortedSlugs(await getAllOpenFoodbanksForSitemap(session))).toEqual(["salisbury"]);
  });

  // The whole reason this function exists. Asserted on the SQL the module
  // actually sent, not on a string retyped here: a "tidy-up" that put
  // `SELECT *` back would leave every other test in this block green.
  it("names its columns instead of issuing SELECT *", async () => {
    await getAllOpenFoodbanksForSitemap(session);

    expect(calls[0]!.sql).not.toContain("*");
    expect(calls[0]!.sql).toContain("SELECT slug, days_between_needs");
  });
});

describe("getAllOpenFoodbankSlugs / getAllOpenFoodbankSlugsWithNames", () => {
  // md_sitemap()'s loop reads .slug and nothing else, so this returns bare
  // strings, matching getAllConstituencySlugs in constituencies.ts. Order is
  // the wide query's order for the same reason as above -- /md/sitemap.xml
  // lists food banks in arrival order.
  it("returns the slugs of the open food banks, in SELECT * order", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    seedFoodbank({ id: 3, slug: "bath" });
    seedFoodbank({ id: 2, slug: "closed-town", isClosed: 1 });

    const wide = await getAllOpenFoodbanks(session);

    expect(await getAllOpenFoodbankSlugs(session)).toEqual(wide.map((row) => row.slug));
    expect(await getAllOpenFoodbankSlugs(session)).toEqual(["salisbury", "bath"]);
  });

  // md_sitemap_md() renders `[{{ foodbank.name }}](...)`, so the name is the
  // LINK TEXT -- drop it and every food bank on /md/sitemap.md becomes an
  // empty-labelled link, a 200 with a page nobody can read. Django narrows
  // this queryset identically (`.only('slug', 'name')`, views.py:793).
  it("returns slug AND name, matching SELECT * row for row", async () => {
    // Ids ascend while names descend, so rowid order and name order are two
    // different sequences: an ORDER BY name quietly added here would reorder
    // /md/sitemap.md's whole food-bank section, and without this arrangement
    // the comparison below would agree with it.
    seedFoodbank({ id: 1, slug: "salisbury", name: "Salisbury Foodbank" });
    seedFoodbank({ id: 3, slug: "bath", name: "Bath Foodbank" });
    seedFoodbank({ id: 2, slug: "closed-town", name: "Closed Town Foodbank", isClosed: 1 });

    const wide = await getAllOpenFoodbanks(session);

    expect(await getAllOpenFoodbankSlugsWithNames(session)).toEqual(
      wide.map((row) => ({ slug: row.slug, name: row.name })),
    );
    expect(await getAllOpenFoodbankSlugsWithNames(session)).toEqual([
      { slug: "salisbury", name: "Salisbury Foodbank" },
      { slug: "bath", name: "Bath Foodbank" },
    ]);
  });

  it("both name their columns instead of issuing SELECT *", async () => {
    await getAllOpenFoodbankSlugs(session);
    await getAllOpenFoodbankSlugsWithNames(session);

    expect(calls[0]!.sql).toBe("SELECT slug FROM foodbank WHERE is_closed = 0");
    expect(calls[1]!.sql).toBe("SELECT slug, name FROM foodbank WHERE is_closed = 0");
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

  // A food bank that has never had a need at all. There is no longer a
  // `latest_need_id === null` guard in front of the second statement -- the
  // batch sends it either way and `id = (SELECT NULL)` is NULL, which matches
  // nothing under SQLite's three-valued WHERE logic and returns zero rows. The
  // OUTCOME is what the old short-circuit produced; what changed is that it now
  // costs one extra rows_read instead of a saved statement. Pinned in both
  // directions: the second statement IS sent (statement count 2) and it still
  // arrives inside the single round trip (round-trip count 1).
  it("returns latestNeed null when latest_need_id is null, without a second round trip", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", latestNeedId: null });

    const row = await getFoodbankBySlug(session, "salisbury");

    expect(row!.latestNeed).toBeNull();
    expect(calls).toHaveLength(2);
    expect(roundTrips).toHaveLength(1);
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

  // -------------------------------------------------------------------------
  // ONE ROUND TRIP -- github #51
  // -------------------------------------------------------------------------
  //
  // This function used to await the food bank row and THEN await the need row,
  // two sequential D1 waits for data that depends only on the slug. It is the
  // most-called query in the port: 53 call sites across 36 files, 25 of them
  // (in 16 files) on the public site -- every /needs/at/<slug>/ page, its /md/
  // twin, the RSS feeds, gfapi1, gfapi2, the GeoJSON scope builder -- and those
  // pages mostly miss the edge cache (11.9% HTML hit rate measured, 1.3% md),
  // so ~88% of food bank page views paid for both waits.
  //
  // A round trip was measured at ~19-22 ms against production, by interleaving
  // cache-busted requests and reading Server-Timing `render;dur` (which on
  // these pages IS the D1 wait -- Workers' performance.now() only advances at
  // I/O boundaries, see middleware/serverTiming.ts). /md/needs/at/<slug>/ calls
  // this function and nothing else and ran a median 37 ms over 8 samples.
  //
  // THE ROWS ARE IDENTICAL EITHER WAY, which is exactly why this needs pinning
  // by counting round trips: every assertion above passes on the slow version
  // too. Nothing else stops someone "simplifying" the batch back into two
  // awaits, or into the JOIN that needs a ~95-column alias list to dodge the
  // four column names the two tables share.
  //
  // MUTATION-TESTED (TESTING.md's convention -- the evidence that a test is
  // load-bearing rather than decoration). foodbank.ts was copied to a
  // scratchpad, broken one way at a time, and this file re-run against each
  // break. Twelve mutants, all caught: the batch unrolled back into two
  // sequential awaits, and split into two batches of one; the two result
  // indexes swapped, and the two statements swapped inside batch() with the
  // indexes left alone; the subquery re-keyed onto `foodbank_id = (SELECT id
  // ...)`; the second statement's bind put through `.toLowerCase()`; the slug
  // string-interpolated into the SQL instead of bound; mapNeedRow replaced with
  // a bare cast; the spread reversed to `{ latestNeed, ...foodbank }`; the
  // `if (!row) return null` dropped; the view reverted to its base table; and
  // the need statement made a copy-paste of the food bank one.
  //
  // ONE OF THOSE TWELVE SURVIVED the first version of this block --
  // `.toLowerCase()` on the second bind -- because every fixture slug was
  // already lowercase, so the mutated value was byte-identical. See the note on
  // the binding test below for what now kills it. Verified against production
  // D1 as well as here: for all 1,070 food banks, the slug-keyed subquery
  // resolves to exactly the need id the old `latest_need_id` lookup did, and
  // the full row comes back byte-identical (rows_read 3 against 2).
  it("fetches the food bank and its latest need in ONE round trip, not two", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", latestNeedId: 500 });
    seedNeed({ id: 500, needId: "ab".repeat(16), foodbankId: 1, changeText: "Beans" });

    await getFoodbankBySlug(session, "salisbury");

    expect(roundTrips).toHaveLength(1);
    expect(roundTrips[0]).toHaveLength(2);
  });

  // The second statement reaches the need through a scalar subquery on the
  // SLUG, not through the id it just read -- that is what makes the two
  // independent enough to batch. Pinned as SQL text because a mutant that binds
  // anything else (the food bank's id, a literal) returns a plausible row for
  // the fixtures above and a wrong one in production. Both statements bind the
  // caller's slug, verbatim, and nothing else.
  //
  // THE FIXTURE SLUG HAS A CAPITAL IN IT, deliberately. Every other slug in
  // this file is lowercase, and `bind(slug.toLowerCase())` on the second
  // statement SURVIVED an earlier version of this test for exactly that reason:
  // the mutated value was byte-identical to the original. Production has no
  // mixed-case slug (checked: 0 of 1,070), so this fixture is not a claim about
  // the data -- it is the only way to tell "the caller's slug" apart from "a
  // slug that has been through a transform" at all.
  it("binds the slug to both statements, verbatim, and interpolates neither", async () => {
    seedFoodbank({ id: 7, slug: "Salisbury", latestNeedId: 500 });
    seedNeed({ id: 500, needId: "ab".repeat(16), foodbankId: 7, changeText: "Beans" });

    const row = await getFoodbankBySlug(session, "Salisbury");

    expect(row!.latestNeed!.id).toBe(500);
    expect(roundTrips[0]).toEqual([
      { sql: "SELECT * FROM foodbank WHERE slug = ?", params: ["Salisbury"] },
      {
        sql: "SELECT * FROM foodbankchange_full WHERE id = (SELECT latest_need_id FROM foodbank WHERE slug = ?)",
        params: ["Salisbury"],
      },
    ]);
  });

  // The scalar subquery follows `latest_need_id`, NOT `foodbank_id`. A food
  // bank's needs accumulate -- foodbankchange is every historical need, not
  // just the current one -- so `WHERE foodbank_id = (SELECT id FROM foodbank
  // WHERE slug = ?)` would also return rows, in rowid order, and hand back the
  // OLDEST need as `latestNeed`. Every other test here seeds exactly one need
  // per food bank, where that mutant is invisible.
  it("follows latest_need_id, not the need's own foodbank_id", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", latestNeedId: 502 });
    seedNeed({ id: 500, needId: "aa".repeat(16), foodbankId: 1, changeText: "Superseded, two months ago" });
    seedNeed({ id: 501, needId: "bb".repeat(16), foodbankId: 1, changeText: "Superseded, last month" });
    seedNeed({ id: 502, needId: "cc".repeat(16), foodbankId: 1, changeText: "Tinned tomatoes" });

    const row = await getFoodbankBySlug(session, "salisbury");

    expect(row!.latestNeed!.id).toBe(502);
    expect(row!.latestNeed!.change_text).toBe("Tinned tomatoes");
  });

  // The two statements are resolved independently, so a subquery keyed on the
  // wrong food bank would publish one town's shopping list under another town's
  // name -- a 200, with wrong content, on a page people act on. Two food banks
  // whose ids, need ids and slugs are all distinct, queried one after the other
  // on the same session.
  it("does not cross food banks over when several exist", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", latestNeedId: 500 });
    seedFoodbank({ id: 2, slug: "andover", latestNeedId: 501 });
    seedNeed({ id: 500, needId: "aa".repeat(16), foodbankId: 1, changeText: "Salisbury needs beans" });
    seedNeed({ id: 501, needId: "bb".repeat(16), foodbankId: 2, changeText: "Andover needs pasta" });

    const salisbury = await getFoodbankBySlug(session, "salisbury");
    const andover = await getFoodbankBySlug(session, "andover");

    expect(salisbury!.latestNeed!.change_text).toBe("Salisbury needs beans");
    expect(andover!.latestNeed!.change_text).toBe("Andover needs pasta");
    expect(roundTrips).toHaveLength(2);
  });

  // THE ROWS DID NOT MOVE. The batch is only a legitimate replacement for the
  // two sequential awaits if it returns the same object -- same keys, same
  // order, same values -- for every state the database can be in. Rather than
  // trusting that, this runs the SUPERSEDED IMPLEMENTATION against the same
  // seeded rows and compares, over the five shapes production actually holds.
  //
  // `toEqual` alone would not catch a reordered spread (`{ latestNeed, ...fb }`
  // instead of `{ ...fb, latestNeed }`), which JSON.stringify -- and therefore
  // every cached API response body -- WOULD notice, so the key order is
  // asserted separately.
  describe("returns exactly what the two sequential round trips returned", () => {
    // github #51's "before": food bank row, then a dependent PK lookup on
    // latest_need_id, with a JS short-circuit when it is NULL. Transcribed from
    // the implementation this replaced (foodbank.ts's attachLatestNeed, deleted
    // in that commit) and left here as the oracle rather than as live code.
    async function beforeTheFix(slug: string): Promise<Record<string, unknown> | null> {
      const row = await session.prepare("SELECT * FROM foodbank WHERE slug = ?").bind(slug).first();
      if (!row) return null;
      const foodbank = mapFoodbankRow(row as Record<string, unknown>);
      const latestNeed =
        foodbank.latest_need_id === null ? null : await getNeedById(session, foodbank.latest_need_id);
      return { ...foodbank, latestNeed };
    }

    beforeEach(() => {
      // Every state the production table holds, plus the two it can degrade
      // into. `latest_need_id` is non-NULL on all 1,070 production rows today,
      // but nothing enforces that and a brand-new food bank has none.
      seedFoodbank({ id: 1, slug: "salisbury", latestNeedId: 502 });
      seedFoodbank({ id: 2, slug: "closed-town", isClosed: 1, latestNeedId: 503 });
      seedFoodbank({ id: 3, slug: "never-had-a-need", latestNeedId: null });
      seedFoodbank({ id: 4, slug: "dangling", latestNeedId: 999 });
      seedNeed({ id: 500, needId: "aa".repeat(16), foodbankId: 1, changeText: "Superseded" });
      seedNeed({ id: 502, needId: "cc".repeat(16), foodbankId: 1, changeText: "Tinned tomatoes\nUHT milk" });
      seedNeed({ id: 503, needId: "dd".repeat(16), foodbankId: 2, changeText: "Nothing", published: 0 });
      // An unassigned need: foodbankchange_full is a LEFT JOIN precisely so
      // these survive it, and the joined foodbank_name/foodbank_slug come back
      // NULL rather than dropping the row.
      seedNeed({ id: 504, needId: "ee".repeat(16), foodbankId: null, changeText: "Orphan" });
    });

    for (const slug of ["salisbury", "closed-town", "never-had-a-need", "dangling", "no-such-foodbank"]) {
      it(`matches for /${slug}/`, async () => {
        const now = await getFoodbankBySlug(session, slug);
        const before = await beforeTheFix(slug);

        expect(now).toEqual(before);
        expect(now === null ? null : Object.keys(now)).toEqual(before === null ? null : Object.keys(before));
      });
    }

    // And the same equality for a food bank whose latest_need is an UNASSIGNED
    // need (foodbank_id NULL). The old code found it by primary key, which
    // never touched the view's join condition; the new one still finds it by
    // primary key, but through a subquery -- so this pins that the LEFT JOIN is
    // still a LEFT JOIN and the row is not silently dropped.
    it("matches when latest_need points at a need with no foodbank_id", async () => {
      db.prepare("UPDATE foodbank SET latest_need_id = 504 WHERE slug = 'salisbury'").run();

      const now = await getFoodbankBySlug(session, "salisbury");
      const before = await beforeTheFix("salisbury");

      expect(now!.latestNeed!.id).toBe(504);
      expect(now!.latestNeed!.foodbank_name).toBeNull();
      expect(now).toEqual(before);
    });
  });
});

// ===========================================================================
// getFoodbankBySlugWithOpenCoordinates -- gfapi2 `foodbank`'s first wave
// ===========================================================================
// github #49. /api/2/foodbank/<slug>/ needs the food bank, its latest need and
// -- for nearby_foodbanks -- the coordinates of every open food bank, and the
// third of those depends on nothing whatsoever. Awaiting it separately cost a
// round trip measured at 23-28 ms against production, on a route whose whole
// cost is round trips (every statement on the path is index-covered).
//
// THE RISK IS NOT THAT IT RETURNS THE WRONG ROWS. It is that it returns the
// RIGHT rows while quietly ceasing to be one round trip, or while scanning
// 1,024 open food banks for a geojson request that discards them. Neither
// shows up in any assertion about the data, so both are asserted directly, on
// the round-trip log.
//
// MUTATION-TESTED against a scratchpad copy of the repo, never by editing a
// source file in place. Caught here: the batch unrolled into three sequential
// awaits; `wantOpenCoordinates` ignored so the scan always runs; the scan's
// rows thrown away; and the coordinates read out of results[1] (the need
// statement) instead of results[2], which returns need rows cast to
// CoordinateRow and throws nowhere.

describe("getFoodbankBySlugWithOpenCoordinates", () => {
  beforeEach(() => {
    seedFoodbank({ id: 1, slug: "salisbury", latestNeedId: 500, latitude: 51.0688, longitude: -1.7945 });
    seedFoodbank({ id: 2, slug: "andover", latestNeedId: null, latitude: 51.2113, longitude: -1.4871 });
    seedFoodbank({ id: 3, slug: "closed-town", isClosed: 1, latitude: 51.3, longitude: -1.3 });
    seedNeed({ id: 500, needId: "ab".repeat(16), foodbankId: 1, changeText: "Beans" });
  });

  // THE EQUIVALENCE THE WHOLE CHANGE RESTS ON, against the two functions it
  // folds together, both of which are still live for their other callers. If
  // these ever drift, /api/2/foodbank/<slug>/ and /needs/at/<slug>/ start
  // disagreeing about the same food bank, and every row here would still look
  // perfectly plausible.
  it("returns exactly what getFoodbankBySlug and getOpenFoodbankCoordinates return separately", async () => {
    const combined = await getFoodbankBySlugWithOpenCoordinates(session, "salisbury", true);

    expect(combined.foodbank).toEqual(await getFoodbankBySlug(session, "salisbury"));
    expect(combined.openCoordinates).toEqual(await getOpenFoodbankCoordinates(session));
    // Neither comparison may pass vacuously.
    expect(combined.foodbank!.latestNeed!.change_text).toBe("Beans");
    expect(combined.openCoordinates).toHaveLength(2);
    // Key order too: `toEqual` ignores it, and JSON.stringify -- therefore every
    // cached API response body -- does not.
    expect(Object.keys(combined.foodbank!)).toEqual(Object.keys((await getFoodbankBySlug(session, "salisbury"))!));
  });

  it("waits for D1 once, with all three statements in the one batch", async () => {
    await getFoodbankBySlugWithOpenCoordinates(session, "salisbury", true);

    expect(roundTrips).toHaveLength(1);
    expect(roundTrips[0]).toHaveLength(3);
    expect(roundTrips[0]![2]!.sql).toBe("SELECT id, latitude, longitude FROM foodbank WHERE is_closed = 0");
  });

  // THE GATE, and it is the point rather than a tidy-up: ?format=geojson has no
  // nearby_foodbanks section, so hoisting the candidate scan unconditionally
  // would add a 1,024-row scan to every geojson request to save nothing. The
  // empty array is asserted alongside the absent statement because a version
  // that sent the query and threw the rows away would pass the second
  // assertion on its own.
  it("sends no candidate scan at all when the caller does not want one", async () => {
    const combined = await getFoodbankBySlugWithOpenCoordinates(session, "salisbury", false);

    expect(roundTrips).toHaveLength(1);
    expect(roundTrips[0]).toHaveLength(2);
    expect(calls.some((c) => c.sql.includes("latitude, longitude"))).toBe(false);
    expect(combined.openCoordinates).toEqual([]);
    // The food bank half is untouched by the gate.
    expect(combined.foodbank!.slug).toBe("salisbury");
    expect(combined.foodbank!.latestNeed!.change_text).toBe("Beans");
  });

  // THE 404 PATH SPECULATES, deliberately and with a cost: an unknown slug pays
  // one wasted candidate scan (~4 ms of D1 SQL, and rows_read on a 404 goes
  // from 1 to ~1,025). Accepted in exchange for a round trip on every good
  // slug, and pinned here so it is a decision on record rather than a surprise
  // in a billing report. What must NOT happen is a throw: `foodbank` is null
  // and the caller 404s, exactly as before.
  it("returns a null food bank for an unknown slug without throwing, having scanned anyway", async () => {
    const combined = await getFoodbankBySlugWithOpenCoordinates(session, "no-such-foodbank", true);

    expect(combined.foodbank).toBeNull();
    expect(combined.openCoordinates).toHaveLength(2);
  });

  // The same NULL-latest_need and closed-food-bank cases getFoodbankBySlug
  // carries, through the combined path: the scalar subquery still yields no
  // row rather than a wrong one, and a closed food bank is still servable by
  // slug even though it is absent from its own candidate set.
  it("keeps latestNeed null where there is none, and still serves a closed food bank", async () => {
    const andover = await getFoodbankBySlugWithOpenCoordinates(session, "andover", true);
    expect(andover.foodbank!.latestNeed).toBeNull();

    const closed = await getFoodbankBySlugWithOpenCoordinates(session, "closed-town", true);
    expect(closed.foodbank!.is_closed).toBe(true);
    expect(closed.openCoordinates.map((c) => c.id)).toEqual([1, 2]);
  });
});

// ===========================================================================
// getFoodbankBySlugWithServiceArea -- the WFBN pages' first wave
// ===========================================================================
// github #52 item 3. /needs/at/<slug>/, /<locslug>/ and
// /donationpoint/<dpslug>/ render `has_service_area` and fetch no location
// rows of their own, so unlike /locations/ and /donationpoints/ (which derive
// it from rows they already hold, 9464049) they have to ask the database. They
// used to ask it in a hop of ITS OWN, ~16-22 ms of serial round trip measured
// against production, for an answer that is `false` for 1,016 of the 1,023
// open food banks.
//
// TWO THINGS ARE UNDER TEST HERE AND THEY FAIL DIFFERENTLY.
//
// The first is the TRANSPORT: the count now rides in getFoodbankBySlug's
// batch. That is only possible because it was re-keyed from the food bank's id
// onto its SLUG -- the id is in the result of the very batch the statement has
// to join, so an id-keyed count could never have travelled in it. Nothing
// about the returned data can see this, so the round-trip log is asserted
// directly.
//
// The second is THE GUARD, and it is the one that could silently change a
// page. Django's has_service_area() (givefood/models/foodbank.py:296-302)
// checks `if self.no_locations == 0: return False` BEFORE it queries. The
// count cannot be skipped any more -- no_locations is a column of the row the
// batch is fetching -- so the short circuit survives on the ANSWER instead,
// and every case below that involves a stale counter exists to hold it there.
// Both spellings of "no boundary" (NULL and '') and the absent is_closed
// filter are re-asserted rather than assumed, because this is a SECOND
// spelling of a predicate locations.ts already owns and second copies drift.
//
// THE ORACLE IS hasServiceArea() ITSELF, run against the same rows -- not a
// second copy of the expected answer written out longhand here. If the two
// ever disagree, /needs/at/<slug>/ and any future id-keyed caller start
// telling different stories about the same food bank.
//
// MUTATION-TESTED in an rsync'd copy of the tree OUTSIDE the repo, together
// with the two route suites that consume this function. 20 mutants, 20 killed,
// each actually run rather than imagined -- the twelve aimed at this module,
// with the number of tests each took down:
//
//   the `no_locations !== 0` guard deleted                          3
//   `count > 0` widened to `count >= 0`                             4
//   the flag hardcoded false                                        6
//   the `foodbank !== null` guard dropped (throws on a 404)         1
//   the count read out of results[1], the need statement            6
//   the batch unrolled, count awaited separately                    3
//   the count statement never pushed                               14
//   the count bound to a constant slug                              3
//   `l.foodbank_id = (...)` weakened to `(...) IS NOT NULL`         5
//   `boundary_geojson != ''` dropped                                2
//   `is_closed = 0` gained (Django's queryset has no such filter)   2
//   `boundary_geojson IS NOT NULL` dropped                          1
//
// THE LAST ONE IS HONEST RATHER THAN IMPRESSIVE, and locations.test.ts says
// the same of its own twin: dropping the NULL half changes NO answer, because
// SQLite's `NULL != ''` is UNKNOWN and the row is excluded anyway. It dies
// only on the statement-text assertion. It is left in the list so nobody
// reads a coverage claim into it.

describe("getFoodbankBySlugWithServiceArea", () => {
  const BOUNDARY = '{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[-1.8,51.0],[-1.7,51.0],[-1.7,51.1],[-1.8,51.0]]]}}';

  beforeEach(() => {
    // salisbury: two locations, one of them with a real boundary, counter
    // correct. The everyday true case.
    seedFoodbank({ id: 1, slug: "salisbury", latestNeedId: 500, noLocations: 2 });
    seedLocation({ id: 401, foodbankId: 1, name: "Amesbury", boundaryGeojson: BOUNDARY });
    seedLocation({ id: 402, foodbankId: 1, name: "Wilton", boundaryGeojson: null });
    // andover: locations, none with a boundary, no latest need.
    seedFoodbank({ id: 2, slug: "andover", latestNeedId: null, noLocations: 1 });
    seedLocation({ id: 403, foodbankId: 2, name: "Andover Centre", boundaryGeojson: null });
    // stale-town: THE GUARD'S CASE. A boundary in the table and a counter that
    // says the food bank has no locations at all.
    seedFoodbank({ id: 3, slug: "stale-town", latestNeedId: null, noLocations: 0 });
    seedLocation({ id: 404, foodbankId: 3, name: "Stale Centre", boundaryGeojson: BOUNDARY });
    seedNeed({ id: 500, needId: "ab".repeat(16), foodbankId: 1, changeText: "Beans" });
  });

  // THE FOOD BANK HALF DID NOT MOVE. ~50 call sites take getFoodbankBySlug's
  // object and three of them take this one; if the two ever return different
  // shapes, the same food bank renders differently depending on which page you
  // are on. Key order as well as values: `toEqual` ignores it and
  // JSON.stringify does not.
  it("returns exactly the food bank getFoodbankBySlug returns", async () => {
    const combined = await getFoodbankBySlugWithServiceArea(session, "salisbury");
    const plain = await getFoodbankBySlug(session, "salisbury");

    expect(combined.foodbank).toEqual(plain);
    expect(Object.keys(combined.foodbank!)).toEqual(Object.keys(plain!));
    // Not vacuous: there is a real need row on the other end of that join.
    expect(combined.foodbank!.latestNeed!.change_text).toBe("Beans");
  });

  // AND has_service_area IS NOT ON IT. It is a live count over another table,
  // not a column of the row, and FoodbankWithLatestNeed is spread straight
  // into API response bodies at ~50 call sites -- a key that appeared there
  // would leak into serialised output on every one of them.
  it("keeps the flag beside the food bank, never on it", async () => {
    const combined = await getFoodbankBySlugWithServiceArea(session, "salisbury");

    expect(combined.hasServiceArea).toBe(true);
    expect(Object.keys(combined.foodbank!)).not.toContain("hasServiceArea");
    expect(Object.keys(combined.foodbank!)).not.toContain("has_service_area");
  });

  // THE WHOLE POINT OF THE CHANGE, and invisible in every value it returns.
  // Three statements, ONE wait. Unroll the count into its own await and every
  // other assertion in this block still passes.
  it("waits for D1 once, with all three statements in the one batch", async () => {
    await getFoodbankBySlugWithServiceArea(session, "salisbury");

    expect(roundTrips).toHaveLength(1);
    expect(roundTrips[0]).toHaveLength(3);
  });

  // BOUND TO THE SLUG, NOT THE ID -- the enabling constraint, not a style
  // choice. The id only exists in results[0] of this very batch, so a version
  // that bound `foodbank.id` could not have been batched at all; it would have
  // had to await the first statement, which is the round trip being removed.
  // Pinned on the statement because a correct answer proves nothing about it.
  it("asks for the count by slug, so that it can travel with the lookup that finds the id", async () => {
    await getFoodbankBySlugWithServiceArea(session, "salisbury");

    const count = calls.find((c) => c.sql.includes("COUNT(*)"))!;
    expect(count.sql).toBe(
      "SELECT COUNT(*) AS n FROM foodbanklocation l WHERE l.foodbank_id = (SELECT id FROM foodbank WHERE slug = ?) " +
        "AND l.boundary_geojson IS NOT NULL AND l.boundary_geojson != ''",
    );
    expect(count.params).toEqual(["salisbury"]);
  });

  // THE ANSWER DID NOT MOVE EITHER, against the id-keyed function the three
  // routes used to call, over every state the fixture holds -- INCLUDING the
  // stale-counter one, where the two are deliberately allowed to differ and
  // the guard is what makes them. Written as `no_locations !== 0 && oracle` so
  // that the guard appears once on the expected side, explicitly, instead of
  // being hidden inside a hardcoded true/false.
  for (const slug of ["salisbury", "andover", "stale-town"]) {
    it(`agrees with hasServiceArea(), through the guard, for /${slug}/`, async () => {
      const combined = await getFoodbankBySlugWithServiceArea(session, slug);
      const oracle = await hasServiceArea(session, combined.foodbank!.id);

      expect(combined.hasServiceArea).toBe(combined.foodbank!.no_locations !== 0 && oracle);
    });
  }

  // ...and those three cases are not all the same answer, which the loop above
  // cannot tell you on its own. stale-town is the one that matters: the raw
  // count says TRUE and the flag says false.
  it("answers true, false and false -- the last of them against its own count", async () => {
    expect((await getFoodbankBySlugWithServiceArea(session, "salisbury")).hasServiceArea).toBe(true);
    expect((await getFoodbankBySlugWithServiceArea(session, "andover")).hasServiceArea).toBe(false);

    expect(await hasServiceArea(session, 3)).toBe(true);
    expect((await getFoodbankBySlugWithServiceArea(session, "stale-town")).hasServiceArea).toBe(false);
  });

  // THE GUARD, ONE ASSERTION, NO ROOM FOR DOUBT. Django:
  //
  //     def has_service_area(self):
  //         if self.no_locations == 0:
  //             return False
  //
  // Delete `foodbank.no_locations !== 0` from the implementation and only this
  // and its two siblings above go red. The counter is a denormalised column
  // the admin maintains, so a stale zero is a state the database can really be
  // in -- none of the 1,070 production rows is in it today, which is precisely
  // why it needs a test.
  it("returns false when no_locations is 0, whatever the boundaries say", async () => {
    const stale = await getFoodbankBySlugWithServiceArea(session, "stale-town");

    expect(stale.foodbank!.no_locations).toBe(0);
    expect(stale.hasServiceArea).toBe(false);

    // The counter, and nothing else, is what is suppressing it: correct it and
    // the same untouched row lights the flag.
    db.prepare("UPDATE foodbank SET no_locations = 1 WHERE slug = 'stale-town'").run();
    expect((await getFoodbankBySlugWithServiceArea(session, "stale-town")).hasServiceArea).toBe(true);
  });

  // THE COUNT STILL GOES OUT even when the guard has already decided the
  // answer -- not a bug, an unavoidable consequence of batching: no_locations
  // arrives in results[0] of the same trip. Pinned so the extra statement is a
  // recorded decision rather than something discovered in a billing report.
  // It costs ~1 + N rows_read on a food bank whose answer was never in doubt,
  // and buys a whole round trip on the other 1,070.
  it("issues the count even for a food bank the guard has already ruled out", async () => {
    await getFoodbankBySlugWithServiceArea(session, "stale-town");

    expect(roundTrips).toHaveLength(1);
    expect(roundTrips[0]!.filter((s) => s.sql.includes("COUNT(*)"))).toHaveLength(1);
  });

  // BOTH SPELLINGS OF "NO BOUNDARY", re-asserted on this statement rather than
  // inherited from locations.test.ts's coverage of the other one. D1 holds
  // NULL and '' both, Django excludes both
  // (`.exclude(boundary_geojson__isnull = True).exclude(boundary_geojson = '')`),
  // and dropping the `!= ''` half here would give a food bank whose boundary
  // was cleared in the admin a "Service area" legend over a map that draws
  // nothing.
  it("treats an empty-string boundary as no boundary", async () => {
    db.prepare("UPDATE foodbanklocation SET boundary_geojson = '' WHERE foodbank_id = 1").run();

    expect((await getFoodbankBySlugWithServiceArea(session, "salisbury")).hasServiceArea).toBe(false);
  });

  // SCOPED TO THE FOOD BANK. Without the foodbank_id predicate the first
  // service area anywhere in the country would put a service-area map on all
  // 1,070 pages -- every one of them a 200.
  it("does not count another food bank's boundary", async () => {
    expect((await getFoodbankBySlugWithServiceArea(session, "andover")).hasServiceArea).toBe(false);
    // Salisbury's boundary exists and is one row away.
    expect((await getFoodbankBySlugWithServiceArea(session, "salisbury")).hasServiceArea).toBe(true);
  });

  // NO is_closed FILTER, matching Django's bare `.filter(foodbank = self)`: a
  // closed location's boundary still counts, because the flag means "there is
  // a service-area map to draw" and the map still draws. Ported behaviour, not
  // an oversight -- locations.test.ts pins the same thing on the id-keyed
  // spelling, and the two must not diverge.
  it("counts a closed location's boundary, matching the Django queryset", async () => {
    db.prepare("UPDATE foodbanklocation SET is_closed = 1 WHERE foodbank_id = 1").run();

    expect((await getFoodbankBySlugWithServiceArea(session, "salisbury")).hasServiceArea).toBe(true);
  });

  // AN UNKNOWN SLUG must not throw: COUNT(*) returns one row of 0 (the scalar
  // subquery is NULL, `foodbank_id = NULL` matches nothing), the food bank is
  // null, and the caller 404s exactly as it did before. The flag is false
  // rather than undefined, because three templates read it as a `{% if %}`.
  it("returns a null food bank and a false flag for an unknown slug", async () => {
    const missing = await getFoodbankBySlugWithServiceArea(session, "no-such-foodbank");

    expect(missing.foodbank).toBeNull();
    expect(missing.hasServiceArea).toBe(false);
    expect(roundTrips).toHaveLength(1);
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

  // THESE THREE USED TO ASSERT THE TWO-STEP SHAPE (github #53), binding need
  // ids that this function had read out of the food bank rows first. It now
  // issues both statements TOGETHER and lets SQL find the need ids --
  // `WHERE id IN (SELECT latest_need_id FROM foodbank WHERE id IN (...))` --
  // so the second query no longer waits on the first. One wave, not two, at
  // 13 call sites; on the search pages it is the difference between five
  // serial waves and three.
  //
  // What they were really protecting is unchanged and is still asserted: the
  // ROWS. Two food banks sharing a need still both get it, a null
  // latest_need_id still yields `latestNeed: null` rather than a dropped row,
  // and the parameters are still the food bank ids the caller passed --
  // deduplication of need ids now happens inside the subquery, where a
  // repeated or NULL latest_need_id costs nothing, rather than in JS.
  it("gives two food banks that share one need the same need row", async () => {
    // Real: the admin's need-copy tools do this.
    seedFoodbank({ id: 1, slug: "salisbury", latestNeedId: 501 });
    seedFoodbank({ id: 2, slug: "bath", latestNeedId: 501 });
    seedNeed({ id: 501, needId: "01".repeat(16), foodbankId: 1, changeText: "Beans" });

    const rows = await getFoodbanksByIds(session, [1, 2]);

    expect(rows.map((r) => r.latestNeed!.id)).toEqual([501, 501]);
    // The binds are the FOOD BANK ids now, not the need ids -- and there are
    // two statements, issued together.
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.params)).toEqual([
      [1, 2],
      [1, 2],
    ]);
  });

  it("returns a row whose latest_need_id is null, with latestNeed null", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", latestNeedId: null });
    seedFoodbank({ id: 2, slug: "bath", latestNeedId: 502 });
    seedNeed({ id: 502, needId: "02".repeat(16), foodbankId: 2, changeText: "Pasta" });

    const rows = await getFoodbanksByIds(session, [1, 2]);

    expect(rows[0]!.latestNeed).toBeNull();
    expect(rows[1]!.latestNeed!.change_text).toBe("Pasta");
    // A NULL latest_need_id inside the subquery matches nothing, which is the
    // same outcome the old code got by filtering nulls out in JS first.
    expect(rows).toHaveLength(2);
  });

  // A DELIBERATE COST, recorded rather than hidden. The old code returned
  // early and issued NO second query when nothing in the batch had a need;
  // the subquery form always issues it. That is one wasted query -- but zero
  // wasted WAVES, since it runs concurrently with the row read, which is the
  // whole point of the change. It is also unreachable in production: all
  // 1,023 open food banks carry a latest_need_id (read-only count, github
  // #13), so the old early return never fired there either.
  it("issues both statements even when nothing in the batch has a latest need", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    seedFoodbank({ id: 2, slug: "bath" });

    const rows = await getFoodbanksByIds(session, [1, 2]);

    expect(calls).toHaveLength(2);
    expect(rows.map((r) => r.latestNeed)).toEqual([null, null]);
  });

  it("issues the two statements CONCURRENTLY, which is the whole change", async () => {
    // The assertion that distinguishes this from a tidier rewrite of the same
    // two sequential trips: both statements must be prepared before either
    // resolves. A sequential implementation interleaves them and fails here,
    // while passing every row assertion above.
    seedFoodbank({ id: 1, slug: "salisbury", latestNeedId: 501 });
    seedNeed({ id: 501, needId: "01".repeat(16), foodbankId: 1, changeText: "Beans" });

    await getFoodbanksByIds(session, [1]);

    expect(calls).toHaveLength(2);
    // Both are food-bank-id binds; neither is a need-id bind derived from the
    // other's result, which is what made them sequential.
    expect(calls.every((c) => JSON.stringify(c.params) === "[1]")).toBe(true);
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
