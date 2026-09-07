import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  companyDonationPointsExist,
  getAllOpenDonationPoints,
  getDonationPointBySlugs,
  getDonationPointIdByUuid,
  getDonationPointsByCompanySlug,
  getDonationPointsByFoodbankId,
  getDonationPointsByIds,
  getOpenDonationPointCoordinates,
  getOpenDonationPointsByConstituencyId,
  getOpenDonationPointsByCountry,
  mapDonationPointRow,
  type DonationPointRow,
} from "./donationpoints";
import type { Session } from "./types";

// The donation-point half of the read layer: eight queries behind
// /donationpoints/ (gfapi2), /donationpoints/company/<slug>/ (gfapi3), every
// geo.json feed, the mobile app's subscribe/unsubscribe, the admin's food
// bank page and two backfill jobs.
//
// RUN AGAINST A REAL DATABASE, NOT A FAKE. Every function in this module is
// one SQL statement plus a `.map()`, so a mock answering canned rows would be
// asserting against a second implementation of the query rather than the
// query. And the failure mode here is silence: a dropped `is_closed = 0`
// publishes shut donation points to the API, a dropped `foodbank_id`
// predicate leaks one charity's stores into another's page, an INNER JOIN
// where the view has a LEFT one loses rows. None of those throw. The only
// proof available is "these rows, in this order, and no others".
//
// THE SCHEMA IS COPIED FROM THE MIGRATIONS, NOT FROM THE TYPES ABOVE THE
// FUNCTIONS -- the disagreement between the two is exactly what a db-tier
// test is for, and two are found below: CoordinateRow declares
// `latitude: number` over a NULLABLE column, and DonationPointRow declares
// `is_closed: boolean` where mapDonationPointRow can yield null.
//
// 0019 IS REPLAYED, NOT SHORT-CUT. The fixture creates
// foodbankdonationpoint with its three denormalised parent columns, drops
// them, and only then creates foodbankdonationpoint_full -- because
// 0019_drop_foodbank_cache.sql is this repo's scar. It silently broke four
// queries that still named dropped columns and left /dashboard/beautybanks/
// a live 500 nobody noticed until it was measured. A fixture that simply
// declared the post-migration shape could not fail on a query that names
// foodbank_slug on the base table; this one fails the way D1 would.
//
// MUTATION-TESTED TWICE, per TESTING.md's convention: a copy of
// donationpoints.ts (and of types.ts, whose coerceBooleans, sortByName and
// queryCoordinates this module is mostly made of) was broken in a scratchpad
// and this file re-run against each break. The first pass claimed every
// mutant died. An adversarial second pass of 87 mutants found that seventeen
// of them in fact SURVIVED, and the tests that close them are marked
// "Mutant killed:" where they sit. They are worth naming here, because they
// are the shape of hole a confident suite hides:
//
//   - sortByName deleted from getDonationPointsByFoodbankId. The collation
//     test passed anyway: its seeds derived their slugs from their names, and
//     SQLite answers that query from dp_foodbank_slug_idx, so the rows
//     arrived pre-sorted into the very order the collator produces. A test
//     can assert the right thing and still prove nothing.
//   - `.map(mapDonationPointRow)` dropped from getAllOpenDonationPoints,
//     getOpenDonationPointsByConstituencyId and getOpenDonationPointsByCountry
//     -- no test looked at a flag column on any of those three results.
//   - `results[0]` returned instead of the whole set from the constituency
//     feed, the country feed, and (in types.ts) queryCoordinates: every test
//     of all three matched exactly one row.
//   - a sortByName ADDED to the two feeds that must not have one, for the
//     same reason.
//   - `foodbankdonationpoint_full` swapped back to `foodbankdonationpoint` in
//     those two feeds. Not a SQL error -- `SELECT *` just returns three fewer
//     columns -- which is 0019's exact failure mode, replayed.
//   - COMPANY_QUERY's need joined `ON n.foodbank_id = f.id` instead of
//     `ON f.latest_need_id = n.id`: indistinguishable while a food bank has
//     only one need row in the fixture, which was true everywhere.
//   - COMPANY_QUERY's dp_country and fb_country aliased from each other's
//     table: the fixture gave both "England".
//   - `slug = ?` swapped for `slug LIKE ?`, and the same on
//     COMPANY_QUERY's company_slug: every test queried the exact stored
//     spelling, so nothing noticed the operator had started folding case and
//     reading `%` and `_` as wildcards.
//   - `slug = ? AND foodbank_slug = ?` and `country = ?` swapped for `IS`.
//     The repo's own three-valued-logic scar: identical on every non-null
//     bind, and only the constituency feed had a null-bind test.
//
// Mutants that died on the first pass, and still do: each `is_closed = 0`
// dropped in turn, each scoping predicate neutered to a tautology, the two
// by-slug binds swapped and the two by-uuid binds swapped, normalizeUuid
// removed, the constituency filter moved to the denormalised slug column,
// `SELECT id, latitude, longitude` widened to `SELECT *` and its two columns
// transposed, the caller-order `map` replaced by the engine's order, the
// empty-ids early return removed, a LIMIT added to the by-ids fetch, a
// placeholder dropped from it, COMPANY_QUERY's INNER and LEFT joins swapped
// in both directions, its WHERE moved from company_slug to company, eight of
// its aliases pointed at the wrong source column, coerceBooleans coalescing
// null to false and widened to Boolean(), and sortByName reversed.
//
// FIVE KNOWN-EQUIVALENT MUTANTS, deliberately not chased, recorded here so
// the next reader does not spend an afternoon discovering they are
// untestable. companyDonationPointsExist's `LIMIT 1` deleted, and its base
// table swapped for the view: both change the query plan and neither can
// change what the function returns -- `.first()` already takes one row, and
// the view is the base table plus three columns this query does not select.
// `is_closed = 0` swapped for `<> 1` or `IS NOT 1`, in getAllOpenDonation
// Points and getOpenDonationPointCoordinates: the column is NOT NULL and the
// ETL only ever writes 0 or 1, so the two spellings can differ only on a
// value production cannot produce. And `foodbank_id = ?` swapped for `IS ?`:
// foodbank_id is NOT NULL, so there is no row for the null-safe form to find.
// Pinning any of them would mean asserting SQL text or seeding a state the
// schema forbids -- that pins the spelling, not the behaviour.
//
// Like articles.test.ts, this file needs "node" in the package's tsconfig
// `types` to satisfy `pnpm typecheck` (packages/db compiles against
// @cloudflare/workers-types alone). That is a config change, not a test
// change, so it is not made here; vitest's node environment has node:sqlite
// regardless and the file runs green.

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

// foodbank: 0001_core.sql:10-48 verbatim. Copied whole rather than trimmed to
// the columns COMPANY_QUERY projects, because the NOT NULL set is part of
// what makes a seeded row one production would have accepted -- and because
// `latest_need_id` being an unenforced circular reference (no FK, PLAN.md
// §4.5) is precisely the condition the LEFT JOIN in COMPANY_QUERY exists for.
const SCHEMA_FOODBANK = `
CREATE TABLE foodbank (
  id INTEGER PRIMARY KEY,
  uuid TEXT NOT NULL,
  name TEXT NOT NULL, alt_name TEXT, slug TEXT NOT NULL,
  address TEXT NOT NULL,
  postcode TEXT NOT NULL, country TEXT NOT NULL,
  lat_lng TEXT NOT NULL,
  latitude REAL, longitude REAL,
  delivery_address TEXT, delivery_lat_lng TEXT,
  network TEXT, network_id TEXT, notes TEXT,
  charity_number TEXT, charity_just_foodbank INTEGER NOT NULL,
  charity_id TEXT, charity_name TEXT, charity_type TEXT,
  charity_reg_date TEXT, charity_postcode TEXT, charity_website TEXT,
  charity_objectives TEXT, charity_purpose TEXT,
  facebook_page TEXT, bankuet_slug TEXT, fsa_id TEXT,
  contact_email TEXT NOT NULL, notification_email TEXT,
  phone_number TEXT, secondary_phone_number TEXT, delivery_phone_number TEXT,
  url TEXT NOT NULL, shopping_list_url TEXT NOT NULL,
  rss_url TEXT, news_url TEXT, donation_points_url TEXT,
  locations_url TEXT, contacts_url TEXT,
  place_id TEXT, plus_code_compound TEXT, plus_code_global TEXT,
  place_has_photo INTEGER,
  county TEXT, district TEXT, ward TEXT, lsoa TEXT, msoa TEXT,
  parliamentary_constituency_id INTEGER,
  parliamentary_constituency_name TEXT, parliamentary_constituency_slug TEXT,
  mp TEXT, mp_party TEXT, mp_parl_id INTEGER,
  address_is_administrative INTEGER NOT NULL,
  is_closed INTEGER NOT NULL, is_school INTEGER,
  no_locations INTEGER NOT NULL, no_donation_points INTEGER,
  days_between_needs INTEGER NOT NULL, footprint INTEGER,
  bounds_north REAL, bounds_south REAL, bounds_east REAL, bounds_west REAL,
  latest_need_id INTEGER,
  last_order TEXT, last_need TEXT, last_rfi TEXT, last_crawl TEXT,
  last_social_media_check TEXT, last_discrepancy_check TEXT,
  last_need_check TEXT, last_charity_check TEXT,
  created TEXT NOT NULL, modified TEXT NOT NULL, edited TEXT
);
CREATE UNIQUE INDEX foodbank_name_uniq ON foodbank(name);
CREATE UNIQUE INDEX foodbank_slug_uniq ON foodbank(slug);
`;

// foodbankchange, trimmed to 0001_core.sql:110-125 -- the LEFT JOIN target in
// COMPANY_QUERY. `need_id` is the 32-char dashless UUID, `created` a
// Django-format timestamp; both are emitted straight into the gfapi3 body.
const SCHEMA_CHANGE = `
CREATE TABLE foodbankchange (
  id INTEGER PRIMARY KEY,
  need_id TEXT NOT NULL,
  foodbank_id INTEGER, foodbank_name TEXT,
  distill_id TEXT, name TEXT, uri TEXT,
  change_text TEXT NOT NULL,
  change_text_original TEXT,
  excess_change_text TEXT, excess_change_text_original TEXT,
  published INTEGER NOT NULL DEFAULT 0,
  nonpertinent INTEGER,
  is_categorised INTEGER,
  notified TEXT, input_method TEXT NOT NULL,
  created TEXT NOT NULL, modified TEXT NOT NULL
);
CREATE UNIQUE INDEX need_need_id_uniq ON foodbankchange(need_id);
`;

// foodbankdonationpoint built the way production was built: created in full
// by 0001_core.sql:84-107 (denormalised parent columns and all), stripped of
// those three columns by 0019_drop_foodbank_cache.sql:52-54, then re-exposed
// through the view at :78-84. See the header note on why the DROP COLUMNs are
// replayed rather than skipped.
//
// The indexes come along because two of them are load-bearing claims made in
// donationpoints.ts's own comments and asserted below: dp_open_latlng_idx is
// the partial covering index getOpenDonationPointCoordinates is written for,
// and dp_fb_name_uniq is UNIQUE(foodbank_id, name), so a fixture cannot seed
// two same-named stores under one food bank -- a pair production refuses.
const SCHEMA_DONATIONPOINT = `
CREATE TABLE foodbankdonationpoint (
  id INTEGER PRIMARY KEY, uuid TEXT NOT NULL,
  foodbank_id INTEGER NOT NULL,
  foodbank_name TEXT NOT NULL, foodbank_slug TEXT NOT NULL, foodbank_network TEXT NOT NULL,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  address TEXT NOT NULL, postcode TEXT NOT NULL, country TEXT,
  lat_lng TEXT NOT NULL, latitude REAL, longitude REAL,
  place_id TEXT, plus_code_compound TEXT, plus_code_global TEXT, place_has_photo INTEGER,
  county TEXT, district TEXT, ward TEXT, lsoa TEXT, msoa TEXT,
  parliamentary_constituency_id INTEGER,
  parliamentary_constituency_name TEXT, parliamentary_constituency_slug TEXT,
  mp TEXT, mp_party TEXT, mp_parl_id INTEGER,
  is_closed INTEGER NOT NULL, in_store_only INTEGER NOT NULL,
  phone_number TEXT, url TEXT, opening_hours TEXT,
  wheelchair_accessible INTEGER,
  company TEXT, company_slug TEXT, store_id TEXT, notes TEXT,
  modified TEXT NOT NULL, edited TEXT
);
CREATE UNIQUE INDEX dp_fb_name_uniq  ON foodbankdonationpoint(foodbank_id, name);
CREATE INDEX dp_foodbank_slug_idx    ON foodbankdonationpoint(foodbank_id, slug);
CREATE INDEX dp_uuid_idx             ON foodbankdonationpoint(uuid);
CREATE INDEX dp_parlcon_slug_idx     ON foodbankdonationpoint(parliamentary_constituency_slug);
CREATE INDEX dp_company_slug_name    ON foodbankdonationpoint(company_slug, name);
CREATE INDEX dp_open_latlng_idx      ON foodbankdonationpoint(latitude, longitude) WHERE is_closed = 0;

ALTER TABLE foodbankdonationpoint DROP COLUMN foodbank_name;
ALTER TABLE foodbankdonationpoint DROP COLUMN foodbank_slug;
ALTER TABLE foodbankdonationpoint DROP COLUMN foodbank_network;

CREATE VIEW foodbankdonationpoint_full AS
  SELECT d.*,
         f.name    AS foodbank_name,
         f.slug    AS foodbank_slug,
         f.network AS foodbank_network
    FROM foodbankdonationpoint d
    LEFT JOIN foodbank f ON f.id = d.foodbank_id;
`;

// ---------------------------------------------------------------------------
// The Session adapter
// ---------------------------------------------------------------------------

type Bindable = null | number | bigint | string | Uint8Array;

// Same shape as articles.test.ts's adapter, plus a log of the SQL actually
// prepared. That log is load-bearing for exactly one claim -- that
// getDonationPointsByIds([]) issues NO statement -- which cannot be observed
// from its return value, since a query that matched nothing would also return
// [].
function d1Session(db: DatabaseSync, prepared: string[] = []) {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      const info = db.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql: string) => {
      prepared.push(sql);
      return statement(sql, []);
    },
    getBookmark: () => null,
  } as unknown as Session;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let db: DatabaseSync;
let session: Session;
let prepared: string[];

// Ids deliberately out of slug and name order throughout, so "ordered by
// name" and "ordered by id" can never both be true of the same expectation.
const SALISBURY = 22;
const WESTBURY = 12;

// Two constituencies, so a per-constituency feed has something to exclude.
const SALISBURY_PCON = 4001;
const SOUTH_WEST_WILTS_PCON = 4002;

interface FoodbankSeed {
  id: number;
  slug: string;
  name?: string;
  network?: string | null;
  latestNeedId?: number | null;
}

// Every NOT NULL column filled, so a seeded parent is one the real schema
// would accept. Only the six columns COMPANY_QUERY and the view actually read
// are parameterised.
function seedFoodbank({ id, slug, name, network = "Trussell Trust", latestNeedId = null }: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank (
       id, uuid, name, alt_name, slug, address, postcode, country, lat_lng,
       network, charity_number, charity_just_foodbank, contact_email,
       phone_number, secondary_phone_number, url, shopping_list_url,
       address_is_administrative, is_closed, no_locations, days_between_needs,
       latest_need_id, created, modified
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 0, 0, 0, 14, ?, ?, ?)`,
  ).run(
    id,
    `${slug.replace(/-/g, "")}00000000000000000000000000`.slice(0, 32),
    name ?? `${slug.replace(/(^|-)(\w)/g, (_m, _p, c: string) => c.toUpperCase())} Foodbank`,
    `${slug} alt`,
    slug,
    "1 High Street\r\nSalisbury",
    "SP1 1AA",
    "England",
    "51.0688,-1.7945",
    network,
    "1130854",
    `info@${slug}.foodbank.org.uk`,
    "01722 411900",
    "07700 900123",
    `https://${slug}.foodbank.org.uk/`,
    `https://${slug}.foodbank.org.uk/shopping-list/`,
    latestNeedId,
    "2020-01-01 00:00:00.000000",
    "2026-08-01 09:15:22.412000",
  );
}

interface DonationPointSeed {
  id: number;
  foodbankId: number;
  name: string;
  slug?: string;
  uuid?: string;
  isClosed?: 0 | 1;
  country?: string | null;
  pconId?: number | null;
  companySlug?: string | null;
  company?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  wheelchairAccessible?: 0 | 1 | null;
  placeHasPhoto?: 0 | 1 | null;
  inStoreOnly?: 0 | 1;
  storeId?: string | null;
}

// A donation point as the ETL wrote it. Note there is no foodbank_name /
// foodbank_slug / foodbank_network to write: 0019 dropped them, and an INSERT
// naming any of the three fails here exactly as it would against D1.
function seedDonationPoint(row: DonationPointSeed): void {
  db.prepare(
    `INSERT INTO foodbankdonationpoint (
       id, uuid, foodbank_id, name, slug, address, postcode, country,
       lat_lng, latitude, longitude, place_id, place_has_photo,
       parliamentary_constituency_id, parliamentary_constituency_name,
       parliamentary_constituency_slug, mp, mp_party, mp_parl_id,
       is_closed, in_store_only, phone_number, url, opening_hours,
       wheelchair_accessible, company, company_slug, store_id, notes,
       modified, edited
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.uuid ?? `${String(row.id).padStart(32, "d")}`,
    row.foodbankId,
    row.name,
    row.slug ?? row.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    "12 Castle Street",
    "SP1 3TA",
    row.country === undefined ? "England" : row.country,
    `${row.latitude ?? 51.07},${row.longitude ?? -1.79}`,
    row.latitude === undefined ? 51.07 : row.latitude,
    row.longitude === undefined ? -1.79 : row.longitude,
    "ChIJdd4hrwug2EcRmSrV3Vo6llI",
    row.placeHasPhoto === undefined ? 1 : row.placeHasPhoto,
    row.pconId === undefined ? SALISBURY_PCON : row.pconId,
    "Salisbury",
    "salisbury",
    "John Glen",
    "Conservative",
    4051,
    row.isClosed ?? 0,
    row.inStoreOnly ?? 0,
    "01722 000000",
    "https://example.org/store/",
    "Mon-Sat 08:00-20:00",
    row.wheelchairAccessible === undefined ? 1 : row.wheelchairAccessible,
    row.company ?? null,
    row.companySlug ?? null,
    row.storeId ?? null,
    null,
    "2026-08-14 11:02:03.918000",
    null,
  );
}

// A need row, timestamped the way Django writes them: space-separated, six
// fractional digits, no offset. gfapi3 re-emits `created` verbatim, so the
// format is contract, not decoration.
function seedNeed(row: { id: number; needId: string; foodbankId: number | null; changeText: string; excess?: string | null; created?: string }): void {
  db.prepare(
    `INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, excess_change_text, published, input_method, created, modified)
     VALUES (?, ?, ?, ?, ?, 1, 'scrape', ?, ?)`,
  ).run(
    row.id,
    row.needId,
    row.foodbankId,
    row.changeText,
    row.excess ?? null,
    row.created ?? "2026-09-01 06:30:11.220000",
    "2026-09-01 06:30:11.220000",
  );
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_FOODBANK);
  db.exec(SCHEMA_CHANGE);
  db.exec(SCHEMA_DONATIONPOINT);
  prepared = [];
  session = d1Session(db, prepared);
});

const ids = (rows: readonly { id: number }[]): number[] => rows.map((r) => r.id);
const names = (rows: readonly { name: string }[]): string[] => rows.map((r) => r.name);

// ---------------------------------------------------------------------------
// mapDonationPointRow
// ---------------------------------------------------------------------------

describe("mapDonationPointRow", () => {
  // D1 has no boolean type, so these four arrive as 0/1/null. Every consumer
  // downstream -- packages/serialise, the templates' `{% if %}` -- treats a
  // truthy value as yes, and the integer 0 is falsy in JS by luck rather than
  // design. The coercion is what makes that luck a contract.
  it("turns the four INTEGER flag columns into real booleans", () => {
    const row = mapDonationPointRow({
      id: 101,
      name: "Tesco Extra",
      place_has_photo: 1,
      is_closed: 0,
      in_store_only: 1,
      wheelchair_accessible: 0,
    });

    expect(row.place_has_photo).toBe(true);
    expect(row.is_closed).toBe(false);
    expect(row.in_store_only).toBe(true);
    expect(row.wheelchair_accessible).toBe(false);
  });

  // THE TRI-STATE. `wheelchair_accessible` NULL means "nobody has checked",
  // which the templates render differently from a known "no". Coalescing null
  // to false here would silently publish "not wheelchair accessible" for
  // every store that has never been surveyed -- a factual claim about a real
  // building, made up by a type coercion. 0001_core.sql marks the column
  // "TRI-STATE: NULL/0/1, do not coalesce"; this is that comment, executed.
  it("preserves NULL rather than coalescing it to false", () => {
    const row = mapDonationPointRow({ wheelchair_accessible: null, place_has_photo: null });

    expect(row.wheelchair_accessible).toBeNull();
    expect(row.place_has_photo).toBeNull();
  });

  // The coercion is `value === 1`, not `Boolean(value)` -- so anything that
  // is not the integer 1 becomes false, including the string "1" a hand-run
  // `wrangler d1 execute` could leave behind in SQLite's dynamically typed
  // columns. Pinned because the two spellings differ only for bad data, which
  // is when it matters.
  it("treats any value other than the integer 1 as false", () => {
    expect(mapDonationPointRow({ is_closed: "1" }).is_closed).toBe(false);
    expect(mapDonationPointRow({ is_closed: 2 }).is_closed).toBe(false);
    expect(mapDonationPointRow({ is_closed: true as unknown as number }).is_closed).toBe(false);
  });

  // A column absent from the row (a projected SELECT, not `SELECT *`) becomes
  // null, not undefined -- so the key always exists. Worth pinning because
  // DonationPointRow declares `is_closed: boolean`, non-nullable, and this is
  // the path by which a null reaches it. Harmless today only because every
  // caller of this function selects `*` from a view whose is_closed column is
  // NOT NULL.
  it("invents the four flag keys as null when the row does not carry them", () => {
    const row = mapDonationPointRow({ id: 101 });

    expect(row.is_closed).toBeNull();
    expect(row.in_store_only).toBeNull();
    expect(row.place_has_photo).toBeNull();
    expect(row.wheelchair_accessible).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The view itself
// ---------------------------------------------------------------------------

// Every column DonationPointRow declares, which is also every column the view
// must produce. This list is the direct guard against 0019's failure mode:
// the migration dropped three columns and four queries went on naming them,
// returning wrong or missing data with no exception anywhere. If a future
// migration drops or renames a column here, this fails with the column's name
// in the diff rather than as a blank field on a live page.
const DECLARED_COLUMNS: (keyof DonationPointRow)[] = [
  "id", "uuid", "foodbank_id", "foodbank_name", "foodbank_slug", "foodbank_network",
  "name", "slug", "address", "postcode", "country", "lat_lng", "latitude", "longitude",
  "place_id", "plus_code_compound", "plus_code_global", "place_has_photo",
  "county", "district", "ward", "lsoa", "msoa",
  "parliamentary_constituency_id", "parliamentary_constituency_name", "parliamentary_constituency_slug",
  "mp", "mp_party", "mp_parl_id",
  "is_closed", "in_store_only", "phone_number", "url", "opening_hours",
  "wheelchair_accessible", "company", "company_slug", "store_id", "notes",
  "modified", "edited",
];

describe("foodbankdonationpoint_full", () => {
  it("supplies exactly the columns DonationPointRow declares, no more and no fewer", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra" });

    const [row] = await getDonationPointsByFoodbankId(session, SALISBURY);

    expect(Object.keys(row!).sort()).toEqual([...DECLARED_COLUMNS].sort());
  });

  // THE WHOLE POINT OF 0019. The parent's name/slug/network used to be copied
  // onto the child and refreshed only in the CHILD's save(), so renaming a
  // food bank left its donation points holding the old value -- 24 rows
  // disagreed with their parent's slug in production, and because
  // getDonationPointBySlugs FINDS a child by that slug, a stale copy 404s the
  // child's own page. The join makes staleness unrepresentable; this proves
  // the join is live and not a copy taken at view-creation time.
  it("reads the parent's name, slug and network live, so a rename propagates immediately", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", name: "Salisbury Foodbank", network: "Trussell Trust" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra" });

    db.prepare("UPDATE foodbank SET name = ?, slug = ?, network = ? WHERE id = ?").run(
      "Salisbury & District Foodbank",
      "salisbury-and-district",
      "IFAN",
      SALISBURY,
    );

    const [row] = await getDonationPointsByFoodbankId(session, SALISBURY);

    expect(row!.foodbank_name).toBe("Salisbury & District Foodbank");
    expect(row!.foodbank_slug).toBe("salisbury-and-district");
    expect(row!.foodbank_network).toBe("IFAN");
  });

  // LEFT JOIN, not JOIN, and 0019's own comment says why: D1 declares no
  // foreign keys (PLAN.md §4.5), so nothing enforces that the parent exists.
  // An inner join would make a donation point vanish from the API the moment
  // its food bank row was deleted -- rather than surfacing as an obviously
  // broken row somebody notices. Swap LEFT for INNER and this test is the one
  // that fails.
  it("keeps a donation point whose parent food bank is missing, with null parent fields", async () => {
    seedDonationPoint({ id: 104, foodbankId: 999, name: "Orphaned Co-op" });

    const rows = await getDonationPointsByFoodbankId(session, 999);

    expect(ids(rows)).toEqual([104]);
    expect(rows[0]!.foodbank_name).toBeNull();
    expect(rows[0]!.foodbank_slug).toBeNull();
    expect(rows[0]!.foodbank_network).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getDonationPointsByFoodbankId
// ---------------------------------------------------------------------------

describe("getDonationPointsByFoodbankId", () => {
  it("returns only the named food bank's donation points", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedFoodbank({ id: WESTBURY, slug: "westbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra" });
    seedDonationPoint({ id: 102, foodbankId: WESTBURY, name: "Morrisons Westbury" });

    expect(ids(await getDonationPointsByFoodbankId(session, SALISBURY))).toEqual([101]);
  });

  // NO is_closed FILTER, deliberately. Django's `Foodbank.donation_points()`
  // is `FoodbankDonationPoint.objects.filter(foodbank=self).order_by("name")`
  // (givefood/models/foodbank.py:552) with no `is_closed` clause, and PLAN.md
  // §7.2 records that a food bank's own donation-point list stays unfiltered
  // even when the food bank itself is open. Adding the filter that "obviously
  // belongs" here would quietly empty the admin's donation-point table and
  // drop closed stores off /needs/at/<slug>/ -- so this asserts the absence.
  it("includes CLOSED donation points, matching Django's unfiltered queryset", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra", isClosed: 0 });
    seedDonationPoint({ id: 102, foodbankId: SALISBURY, name: "Wilko Salisbury", isClosed: 1 });

    const rows = await getDonationPointsByFoodbankId(session, SALISBURY);

    expect(ids(rows).sort((a, b) => a - b)).toEqual([101, 102]);
    expect(rows.find((r) => r.id === 102)!.is_closed).toBe(true);
  });

  // SORTED IN JS, NOT SQL, and the difference is visible rather than
  // theoretical. D1/SQLite's default collation is byte-wise, so a literal
  // `ORDER BY name` puts every capital before every lowercase and every
  // accented letter after "z": Sainsbury's, Tesco, Zeds, aldi, Éire. The
  // source Postgres sorts under en_US.utf8, which Intl.Collator("en-US")
  // reproduces: aldi, Éire, Sainsbury's, Tesco, Zeds. Both orderings were
  // executed to write this expectation -- the byte order is the second array,
  // and it is what a "simplification" back to SQL ORDER BY would produce.
  //
  // THE SLUGS AND IDS ARE DELIBERATELY COUNTER-ORDERED, and that is not
  // decoration. An earlier version of this test let each seed derive its slug
  // from its name, which made the slugs sort aldi-salisbury, ire-stores,
  // sainsburys-local, tesco-extra, zeds-convenience -- SQLite answers
  // `WHERE foodbank_id = ?` from dp_foodbank_slug_idx (foodbank_id, slug), so
  // the rows arrived in exactly the order the collator would have produced and
  // the test passed with sortByName DELETED. It proved nothing. Now the ids
  // descend as the names ascend and the slugs descend with them, so all three
  // orders a planner could hand back -- rowid, dp_foodbank_slug_idx,
  // dp_fb_name_uniq's byte order -- differ from the answer, and the engineOrder
  // assertion below fails the test if a future schema change makes them
  // coincide again. Mutant killed: `sortByName(...)` dropped from the return.
  it("sorts by name under a linguistic collation, not SQLite's byte order", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 105, foodbankId: SALISBURY, name: "aldi Salisbury", slug: "dp-5" });
    seedDonationPoint({ id: 104, foodbankId: SALISBURY, name: "Éire Stores", slug: "dp-4" });
    seedDonationPoint({ id: 103, foodbankId: SALISBURY, name: "Sainsburys Local", slug: "dp-3" });
    seedDonationPoint({ id: 102, foodbankId: SALISBURY, name: "Tesco Extra", slug: "dp-2" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Zeds Convenience", slug: "dp-1" });

    const rows = await getDonationPointsByFoodbankId(session, SALISBURY);
    const collated = ["aldi Salisbury", "Éire Stores", "Sainsburys Local", "Tesco Extra", "Zeds Convenience"];

    expect(names(rows)).toEqual(collated);
    expect(names(rows)).not.toEqual([
      "Sainsburys Local",
      "Tesco Extra",
      "Zeds Convenience",
      "aldi Salisbury",
      "Éire Stores",
    ]);

    // The premise, executed rather than assumed: whatever the planner does
    // with this fixture, its own row order is NOT the collated one, so a
    // missing sortByName cannot pass this test by luck the way it once did.
    const engineOrder = db
      .prepare("SELECT name FROM foodbankdonationpoint_full WHERE foodbank_id = ?")
      .all(SALISBURY)
      .map((r: unknown) => String((r as { name: unknown }).name));
    expect(engineOrder).not.toEqual(collated);
  });

  it("returns an empty array for a food bank with no donation points", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedFoodbank({ id: WESTBURY, slug: "westbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra" });

    expect(await getDonationPointsByFoodbankId(session, WESTBURY)).toEqual([]);
  });

  // The mapping runs per row, not just on the first: a `.map` that lost its
  // callback for later rows would leave raw 0/1 integers in the tail, and
  // `{% if dp.wheelchair_accessible %}` would then render "yes" for a store
  // that stores 0.
  it("coerces the flag columns on every row it returns", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Aldi", wheelchairAccessible: 0 });
    seedDonationPoint({ id: 102, foodbankId: SALISBURY, name: "Booths", wheelchairAccessible: null });
    seedDonationPoint({ id: 103, foodbankId: SALISBURY, name: "Co-op", wheelchairAccessible: 1 });

    const rows = await getDonationPointsByFoodbankId(session, SALISBURY);

    expect(rows.map((r) => r.wheelchair_accessible)).toEqual([false, null, true]);
  });
});

// ---------------------------------------------------------------------------
// getDonationPointIdByUuid
// ---------------------------------------------------------------------------

const TESCO_UUID = "8a1f3c2b4d5e6f708192a3b4c5d6e7f8";

describe("getDonationPointIdByUuid", () => {
  // UUIDs are stored 32-char dashless (PLAN.md §4.4) but the mobile app POSTs
  // whatever form it holds, which for an id that came out of gfapi1/gfapi2 is
  // the dashed one Django's JSON encoder emits. Without normalizeUuid the
  // dashed form matches nothing and every subscribe from the app 404s.
  it("accepts the dashed form of a dashless-stored uuid", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra", uuid: TESCO_UUID });

    const dashed = "8a1f3c2b-4d5e-6f70-8192-a3b4c5d6e7f8";
    expect(await getDonationPointIdByUuid(session, dashed, SALISBURY)).toBe(101);
    expect(await getDonationPointIdByUuid(session, TESCO_UUID, SALISBURY)).toBe(101);
  });

  it("accepts an uppercased uuid", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra", uuid: TESCO_UUID });

    expect(await getDonationPointIdByUuid(session, TESCO_UUID.toUpperCase(), SALISBURY)).toBe(101);
  });

  // THE SCOPING THIS FUNCTION EXISTS FOR. Django's
  // `get_object_or_404(FoodbankDonationPoint, foodbank=foodbank,
  // uuid=donationpoint_uuid)` (gfwfbn/views.py:1371) 404s a real UUID that
  // belongs to a different food bank; without the foodbank_id predicate the
  // mobile app could subscribe a device to Westbury's Tesco under Salisbury's
  // food bank and receive that food bank's needs forever. Drop the predicate
  // and this is the test that fails.
  it("returns null for a real uuid belonging to a DIFFERENT food bank", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedFoodbank({ id: WESTBURY, slug: "westbury" });
    seedDonationPoint({ id: 101, foodbankId: WESTBURY, name: "Tesco Extra", uuid: TESCO_UUID });

    expect(await getDonationPointIdByUuid(session, TESCO_UUID, SALISBURY)).toBeNull();
    expect(await getDonationPointIdByUuid(session, TESCO_UUID, WESTBURY)).toBe(101);
  });

  it("returns null for an unknown uuid", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra", uuid: TESCO_UUID });

    expect(await getDonationPointIdByUuid(session, "ffffffffffffffffffffffffffffffff", SALISBURY)).toBeNull();
  });

  // Reads the BASE table, not the view -- so it neither needs nor consults
  // the parent row. A subscribe would still resolve if the food bank row went
  // missing, which is the right behaviour for a lookup whose only job is to
  // turn a UUID into a local id.
  it("resolves against the base table, with no dependency on the parent row existing", async () => {
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra", uuid: TESCO_UUID });

    expect(await getDonationPointIdByUuid(session, TESCO_UUID, SALISBURY)).toBe(101);
  });
});

// ---------------------------------------------------------------------------
// getDonationPointBySlugs
// ---------------------------------------------------------------------------

describe("getDonationPointBySlugs", () => {
  // Donation-point slugs are unique only WITHIN a food bank (dp_foodbank_slug
  // _idx is not unique, and dozens of food banks have a "tesco-extra"). The
  // pair is the key; on the slug alone this returns whichever row the scan
  // reaches first, so /westbury/donationpoint/tesco-extra/ would serve
  // Salisbury's store. Two same-slugged rows under different parents is the
  // seed that makes a dropped foodbank_slug predicate fail rather than pass.
  it("scopes the slug to its parent food bank", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedFoodbank({ id: WESTBURY, slug: "westbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra Salisbury", slug: "tesco-extra" });
    seedDonationPoint({ id: 102, foodbankId: WESTBURY, name: "Tesco Extra Westbury", slug: "tesco-extra" });

    expect((await getDonationPointBySlugs(session, "salisbury", "tesco-extra"))!.id).toBe(101);
    expect((await getDonationPointBySlugs(session, "westbury", "tesco-extra"))!.id).toBe(102);
  });

  it("returns null when the donation point exists but under another food bank", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedFoodbank({ id: WESTBURY, slug: "westbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra", slug: "tesco-extra" });

    expect(await getDonationPointBySlugs(session, "westbury", "tesco-extra")).toBeNull();
  });

  // foodbank_slug in the WHERE now resolves through the view's join, so this
  // matches the parent's CURRENT slug. Before 0019 it matched a copy written
  // at the child's last save, which is how 24 production rows came to be
  // findable only at a URL that no longer existed. Renaming the parent must
  // move the child's URL with it, in both directions.
  it("matches the parent's current slug, not a copy taken when the child was saved", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra", slug: "tesco-extra" });

    db.prepare("UPDATE foodbank SET slug = ? WHERE id = ?").run("salisbury-and-district", SALISBURY);

    expect(await getDonationPointBySlugs(session, "salisbury", "tesco-extra")).toBeNull();
    expect((await getDonationPointBySlugs(session, "salisbury-and-district", "tesco-extra"))!.id).toBe(101);
  });

  it("returns null for an unknown donation-point slug", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra", slug: "tesco-extra" });

    expect(await getDonationPointBySlugs(session, "salisbury", "asda-superstore")).toBeNull();
  });

  // `= ?`, NEVER `LIKE ?`, on both halves. Swapping the operator is the kind
  // of edit that gets made to "be forgiving about URLs", and every test above
  // passes afterwards because they all query the exact stored spelling. It is
  // not equivalent: SQLite's LIKE folds ASCII case, so /donationpoint/
  // Tesco-Extra/ would start answering 200 where Django's `slug=dpslug`
  // get_object_or_404 404s -- two URLs for one page, which is a canonical-URL
  // and sitemap problem rather than a crash -- and it reads `_` and `%` in the
  // path as wildcards, so a crafted slug matches a row it does not name.
  // Mutant killed: `slug = ? AND foodbank_slug = ?` swapped for LIKE.
  it("matches both slugs exactly, with no case folding and no LIKE wildcards", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra", slug: "tesco-extra" });

    expect(await getDonationPointBySlugs(session, "salisbury", "Tesco-Extra")).toBeNull();
    expect(await getDonationPointBySlugs(session, "Salisbury", "tesco-extra")).toBeNull();
    expect(await getDonationPointBySlugs(session, "salisbury", "tesco-%")).toBeNull();
    expect(await getDonationPointBySlugs(session, "salisbury", "tesco_extra")).toBeNull();
    expect((await getDonationPointBySlugs(session, "salisbury", "tesco-extra"))!.id).toBe(101);
  });

  // `= ?`, NOT `IS ?` -- the three-valued-logic bug class this repo already
  // has scars from. The two operators agree on every non-null bind, so
  // nothing above can tell them apart; they part company on NULL, and
  // foodbank_slug is NULL for real rows, namely any donation point whose
  // parent food bank row has gone (the view's LEFT JOIN, see above). Under
  // `IS` a null food bank slug reaching this lookup would stop matching
  // nothing and start matching exactly the orphans -- serving a donation
  // point whose charity the page cannot name. Mutant killed: `slug = ? AND
  // foodbank_slug = ?` swapped for `slug IS ? AND foodbank_slug IS ?`.
  it("matches nothing when a bound slug is NULL, orphaned rows included", async () => {
    seedDonationPoint({ id: 104, foodbankId: 999, name: "Orphaned Co-op", slug: "orphaned-co-op" });

    expect(await getDonationPointBySlugs(session, null as unknown as string, "orphaned-co-op")).toBeNull();
    expect(await getDonationPointBySlugs(session, "salisbury", null as unknown as string)).toBeNull();
  });

  // A found row goes through mapDonationPointRow, unlike `.first()` results
  // elsewhere in this package that return raw rows -- the detail page reads
  // `donationpoint.wheelchair_accessible` directly.
  it("maps the flag columns on the single row it returns", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({
      id: 101,
      foodbankId: SALISBURY,
      name: "Tesco Extra",
      slug: "tesco-extra",
      isClosed: 1,
      inStoreOnly: 1,
      wheelchairAccessible: null,
    });

    const row = (await getDonationPointBySlugs(session, "salisbury", "tesco-extra"))!;

    expect(row.is_closed).toBe(true);
    expect(row.in_store_only).toBe(true);
    expect(row.wheelchair_accessible).toBeNull();
    expect(row.foodbank_slug).toBe("salisbury");
  });
});

// ---------------------------------------------------------------------------
// getAllOpenDonationPoints
// ---------------------------------------------------------------------------

describe("getAllOpenDonationPoints", () => {
  // The filter that keeps shut stores off the sitemap, the /donationpoints/
  // API feed and every geo.json. A filter that does nothing passes any test
  // that seeds only open rows, so the closed row here is the entire point.
  it("excludes closed donation points", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra", isClosed: 0 });
    seedDonationPoint({ id: 102, foodbankId: SALISBURY, name: "Wilko Salisbury", isClosed: 1 });
    seedDonationPoint({ id: 103, foodbankId: SALISBURY, name: "Aldi Salisbury", isClosed: 0 });

    const rows = await getAllOpenDonationPoints(session);

    expect(ids(rows).sort((a, b) => a - b)).toEqual([101, 103]);
  });

  // UNSORTED, unlike getDonationPointsByFoodbankId -- Django's equivalent
  // (`FoodbankDonationPoint.objects.filter(is_closed=False)` in
  // gfwfbn/views.py:248 and givefood/views.py:309) has no `.order_by()`, and
  // the callers -- sitemaps.ts, md.ts, buildGeojson.ts -- emit rows in
  // whatever order arrives. Asserted as "not alphabetical" rather than as an
  // exact sequence because the row order here is the engine's scan order
  // (SQLite answers `is_closed = 0` from the partial dp_open_latlng_idx, so
  // it comes back in latitude order, not rowid order) and pinning a query
  // plan is not this function's contract. What IS its contract is that no
  // sortByName crept in: adding one would change 5,700 sitemap URLs and every
  // geo.json feature order for no reason.
  it("does not sort by name", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Zeds Convenience", latitude: 51.01 });
    seedDonationPoint({ id: 102, foodbankId: SALISBURY, name: "Aldi Salisbury", latitude: 51.02 });
    seedDonationPoint({ id: 103, foodbankId: SALISBURY, name: "Morrisons Daily", latitude: 51.03 });

    const rows = await getAllOpenDonationPoints(session);

    expect(names(rows)).not.toEqual(["Aldi Salisbury", "Morrisons Daily", "Zeds Convenience"]);
    expect(names(rows).sort()).toEqual(["Aldi Salisbury", "Morrisons Daily", "Zeds Convenience"]);
  });

  it("keeps an open donation point whose parent food bank is missing", async () => {
    seedDonationPoint({ id: 104, foodbankId: 999, name: "Orphaned Co-op" });

    const rows = await getAllOpenDonationPoints(session);

    expect(ids(rows)).toEqual([104]);
    expect(rows[0]!.foodbank_slug).toBeNull();
  });

  // THE MAPPING RUNS HERE TOO. Nothing above this test looks at a flag column
  // on these rows -- they assert ids and names -- so dropping
  // `.map(mapDonationPointRow)` from this function passed the whole file. It
  // is the worst place for that to happen: this feeds /donationpoints/, whose
  // JSON would start publishing `"is_closed": 0` and `"in_store_only": 1`
  // where every other endpoint publishes `false` and `true`, and
  // `wheelchair_accessible: 0` would render as an unchecked store rather than
  // an inaccessible one in the templates' `{% if %}`. Asserted per id rather
  // than positionally because this feed is deliberately unordered.
  // Mutant killed: `result.results.map(mapDonationPointRow)` returned raw.
  it("coerces the flag columns on the rows it returns", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Aldi Salisbury", wheelchairAccessible: 0, inStoreOnly: 1 });
    seedDonationPoint({ id: 102, foodbankId: SALISBURY, name: "Booths", wheelchairAccessible: null, inStoreOnly: 0 });

    const byId = new Map((await getAllOpenDonationPoints(session)).map((r) => [r.id, r]));

    expect(byId.get(101)!.is_closed).toBe(false);
    expect(byId.get(101)!.in_store_only).toBe(true);
    expect(byId.get(101)!.wheelchair_accessible).toBe(false);
    expect(byId.get(102)!.in_store_only).toBe(false);
    expect(byId.get(102)!.wheelchair_accessible).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getOpenDonationPointCoordinates
// ---------------------------------------------------------------------------

describe("getOpenDonationPointCoordinates", () => {
  // THREE COLUMNS, NOT `SELECT *`. WP 2.5's measurement was that fetching
  // every column of every open row (5,700+ rows, ~38 columns) to rank by
  // distance and then discard all but 20 dominated the cost of every uncached
  // search. If someone "simplifies" this to reuse getAllOpenDonationPoints,
  // the site still works and only the bill changes -- which is why the
  // projection is asserted as an exact key set rather than by spot-checking a
  // field.
  it("projects exactly id, latitude and longitude", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra", latitude: 51.07, longitude: -1.79 });

    const [row] = await getOpenDonationPointCoordinates(session);

    expect(Object.keys(row!).sort()).toEqual(["id", "latitude", "longitude"]);
    expect(row).toEqual({ id: 101, latitude: 51.07, longitude: -1.79 });
  });

  it("excludes closed donation points from the candidate set", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra", isClosed: 0, latitude: 51.01 });
    seedDonationPoint({ id: 102, foodbankId: SALISBURY, name: "Wilko Salisbury", isClosed: 1, latitude: 51.02 });

    expect(ids(await getOpenDonationPointCoordinates(session))).toEqual([101]);
  });

  // THE WHOLE CANDIDATE SET, NOT ITS FIRST ROW. Every other test in this
  // describe matched a single row, so `queryCoordinates` returning
  // `results.slice(0, 1)` passed all of them -- and that is the most dangerous
  // survivable mutant in this file. It throws nothing, logs nothing and is
  // fast: /search/ and /nearby/ would simply rank one donation point out of
  // 5,700 and answer with it, every time, looking for all the world like a
  // real result. Three rows with distinct coordinates, asserted as an exact
  // set of triples, is what makes that visible.
  it("returns every open row's coordinates, not just the first", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra", latitude: 51.01, longitude: -1.71 });
    seedDonationPoint({ id: 102, foodbankId: SALISBURY, name: "Aldi Salisbury", latitude: 51.02, longitude: -1.72 });
    seedDonationPoint({ id: 103, foodbankId: SALISBURY, name: "Morrisons Daily", latitude: 51.03, longitude: -1.73 });

    const rows = await getOpenDonationPointCoordinates(session);

    // Latitude order, because the covering index the test above pins IS
    // (latitude, longitude) -- so this happens to be id order here too.
    expect(rows).toEqual([
      { id: 101, latitude: 51.01, longitude: -1.71 },
      { id: 102, latitude: 51.02, longitude: -1.72 },
      { id: 103, latitude: 51.03, longitude: -1.73 },
    ]);
  });

  // The comment on this function claims it is "covered entirely by
  // dp_open_latlng_idx". That is a claim about a query plan, so it is checked
  // by asking the engine for the plan rather than by believing the comment.
  // D1 is SQLite, and the index is the partial
  // `(latitude, longitude) WHERE is_closed = 0` from 0001_core.sql:107 -- if
  // a column is ever added to this SELECT, the plan stops saying COVERING and
  // the query starts touching the table for 5,700 rows on every search.
  it("is answered as a covering index scan, never a table scan", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra" });

    const plan = db
      .prepare("EXPLAIN QUERY PLAN SELECT id, latitude, longitude FROM foodbankdonationpoint WHERE is_closed = 0")
      .all()
      .map((r) => String((r as { detail: unknown }).detail));

    expect(plan).toEqual(["SCAN foodbankdonationpoint USING COVERING INDEX dp_open_latlng_idx"]);
  });

  // SUSPECT, PINNED AS-IS. latitude/longitude are NULLABLE (0001_core.sql:89)
  // but CoordinateRow declares them `number`, and this query has no
  // `latitude IS NOT NULL` clause -- so an open donation point that has never
  // been geocoded reaches nearest() as {latitude: null}. JS coerces null to 0
  // in the haversine arithmetic, so it ranks as if it stood at 0°N 0°E, ~5,000
  // km off Salisbury: never a winner, never an error, never visible. Recorded
  // rather than fixed, per the pin-current-behaviour rule.
  it("returns open rows with NULL coordinates, contradicting CoordinateRow's types", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Ungeocoded Store", latitude: null, longitude: null });

    const rows = await getOpenDonationPointCoordinates(session);

    expect(rows).toEqual([{ id: 101, latitude: null, longitude: null }]);
  });
});

// ---------------------------------------------------------------------------
// getOpenDonationPointsByConstituencyId
// ---------------------------------------------------------------------------

describe("getOpenDonationPointsByConstituencyId", () => {
  // Both halves of the predicate matter and each hides the other's absence:
  // seed a closed row inside the constituency and an open row outside it, so
  // dropping either clause changes the result.
  it("returns open donation points in that constituency only", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra", pconId: SALISBURY_PCON, isClosed: 0 });
    seedDonationPoint({ id: 102, foodbankId: SALISBURY, name: "Wilko Salisbury", pconId: SALISBURY_PCON, isClosed: 1 });
    seedDonationPoint({ id: 103, foodbankId: SALISBURY, name: "Aldi Warminster", pconId: SOUTH_WEST_WILTS_PCON, isClosed: 0 });

    expect(ids(await getOpenDonationPointsByConstituencyId(session, SALISBURY_PCON))).toEqual([101]);
  });

  // parliamentary_constituency_id is nullable -- a donation point outside the
  // geocoder's coverage, or one added by hand, carries NULL. SQLite's `= ?`
  // is never true against NULL, so such a row belongs to no constituency feed
  // at all. That is the correct outcome (it has no constituency), but it is
  // the same three-valued logic that makes `id != ?` a live bug class in this
  // repo, so it is executed rather than assumed.
  it("excludes rows whose constituency is NULL", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra", pconId: SALISBURY_PCON });
    seedDonationPoint({ id: 102, foodbankId: SALISBURY, name: "Unplaced Store", pconId: null });

    expect(ids(await getOpenDonationPointsByConstituencyId(session, SALISBURY_PCON))).toEqual([101]);
  });

  // The mirror image: binding NULL matches nothing, INCLUDING the NULL rows.
  // The caller resolves a constituency slug to an id before calling, and a
  // failed resolution reaching here returns an empty feed rather than every
  // ungeocoded donation point in the country.
  it("matches nothing at all when the bound constituency id is NULL", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra", pconId: SALISBURY_PCON });
    seedDonationPoint({ id: 102, foodbankId: SALISBURY, name: "Unplaced Store", pconId: null });

    expect(await getOpenDonationPointsByConstituencyId(session, null as unknown as number)).toEqual([]);
  });

  // THREE MATCHING ROWS, NOT ONE. Every test above this one is satisfied by a
  // single surviving row, and three separate wrong implementations hid in that
  // gap: returning `results[0]` instead of the whole set (a constituency feed
  // with one feature in it), adding a sortByName this function does not have
  // (which would reorder every feature in /constituency/<slug>/geo.json for no
  // reason), and dropping mapDonationPointRow (raw 0/1 in the feed's
  // properties). The names descend as the ids ascend, so the engine's own scan
  // order -- there is no index on parliamentary_constituency_id, so this is a
  // scan of the view -- is never the alphabetical one.
  //
  // The foodbank_slug assertion kills a fourth: `foodbankdonationpoint_full`
  // swapped back to `foodbankdonationpoint`. That is NOT a SQL error, because
  // `SELECT *` simply returns three fewer columns -- it is 0019's exact
  // failure mode, and it would strip the food bank's name and slug out of
  // every feature in the feed with nothing raised anywhere.
  it("returns every open row in the constituency, unsorted, mapped and joined", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", name: "Salisbury Foodbank" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Zeds Convenience", wheelchairAccessible: null });
    seedDonationPoint({ id: 102, foodbankId: SALISBURY, name: "Morrisons Daily", wheelchairAccessible: 0 });
    seedDonationPoint({ id: 103, foodbankId: SALISBURY, name: "Aldi Salisbury", wheelchairAccessible: 1 });

    const rows = await getOpenDonationPointsByConstituencyId(session, SALISBURY_PCON);
    const byId = new Map(rows.map((r) => [r.id, r]));

    expect(ids(rows).sort((a, b) => a - b)).toEqual([101, 102, 103]);
    expect(names(rows)).not.toEqual(["Aldi Salisbury", "Morrisons Daily", "Zeds Convenience"]);
    expect(byId.get(101)!.wheelchair_accessible).toBeNull();
    expect(byId.get(102)!.wheelchair_accessible).toBe(false);
    expect(byId.get(103)!.wheelchair_accessible).toBe(true);
    expect(byId.get(101)!.is_closed).toBe(false);
    expect(rows.map((r) => r.foodbank_slug)).toEqual(["salisbury", "salisbury", "salisbury"]);
    expect(byId.get(101)!.foodbank_name).toBe("Salisbury Foodbank");
  });
});

// ---------------------------------------------------------------------------
// getOpenDonationPointsByCountry
// ---------------------------------------------------------------------------

describe("getOpenDonationPointsByCountry", () => {
  it("returns open donation points in that country only", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra", country: "England", isClosed: 0 });
    seedDonationPoint({ id: 102, foodbankId: SALISBURY, name: "Wilko Salisbury", country: "England", isClosed: 1 });
    seedDonationPoint({ id: 103, foodbankId: SALISBURY, name: "Scotmid Leith", country: "Scotland", isClosed: 0 });

    expect(ids(await getOpenDonationPointsByCountry(session, "England"))).toEqual([101]);
    expect(ids(await getOpenDonationPointsByCountry(session, "Scotland"))).toEqual([103]);
  });

  // `country` is declared NOT NULL by the Django model but is NULLABLE in
  // production -- 1 of 5,744 rows, per 0001_core.sql:90. That row appears in
  // /donationpoints/ and in its own food bank's page, and in no country
  // geo.json at all. Pinned so the count of a country feed is understood to
  // be "open rows with this exact country", not "all open rows".
  it("excludes the row whose country is NULL from every country feed", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra", country: "England" });
    seedDonationPoint({ id: 102, foodbankId: SALISBURY, name: "Countryless Store", country: null });

    expect(ids(await getOpenDonationPointsByCountry(session, "England"))).toEqual([101]);
    expect(await getOpenDonationPointsByCountry(session, "Scotland")).toEqual([]);
  });

  // The caller maps a URL slug through COUNTRY_MAPPING to get the exact
  // stored spelling, because this comparison is case- and space-sensitive on
  // both engines. "england" returning nothing is the behaviour that makes
  // that mapping load-bearing rather than cosmetic.
  it("matches the country name exactly, case included", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra", country: "England" });

    expect(await getOpenDonationPointsByCountry(session, "england")).toEqual([]);
    expect(await getOpenDonationPointsByCountry(session, "England ")).toEqual([]);
  });

  // The mirror of the constituency feed's null-bind test, and the same
  // `= ?` vs `IS ?` bug class. It bites harder here because a NULL-country
  // row genuinely exists in production (1 of 5,744): under `IS`, a country
  // that failed to resolve through COUNTRY_MAPPING would stop returning an
  // empty feed and start returning precisely the rows that belong to no
  // country -- a /<country>/geo.json for a country that does not exist,
  // populated. Mutant killed: `country = ?` swapped for `country IS ?`.
  it("matches nothing at all when the bound country is NULL, NULL-country rows included", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra", country: "England" });
    seedDonationPoint({ id: 102, foodbankId: SALISBURY, name: "Countryless Store", country: null });

    expect(await getOpenDonationPointsByCountry(session, null as unknown as string)).toEqual([]);
  });

  // The same four mutants as the constituency feed's multi-row test, and for
  // the same reason -- every test above matches exactly one row, so
  // `results[0]`, an added sortByName, a dropped mapDonationPointRow and the
  // view swapped for the base table all survived here too. This feed is
  // /scotland/geo.json and its siblings, the biggest of them ~4,000 features,
  // so "the first one" and "all of them" look identical in a test and nothing
  // alike on the page.
  it("returns every open row in the country, unsorted, mapped and joined", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", name: "Salisbury Foodbank" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Zeds Convenience", country: "Wales", wheelchairAccessible: null });
    seedDonationPoint({ id: 102, foodbankId: SALISBURY, name: "Morrisons Daily", country: "Wales", wheelchairAccessible: 0 });
    seedDonationPoint({ id: 103, foodbankId: SALISBURY, name: "Aldi Cardiff", country: "Wales", wheelchairAccessible: 1 });
    seedDonationPoint({ id: 104, foodbankId: SALISBURY, name: "Scotmid Leith", country: "Scotland" });

    const rows = await getOpenDonationPointsByCountry(session, "Wales");
    const byId = new Map(rows.map((r) => [r.id, r]));

    expect(ids(rows).sort((a, b) => a - b)).toEqual([101, 102, 103]);
    expect(names(rows)).not.toEqual(["Aldi Cardiff", "Morrisons Daily", "Zeds Convenience"]);
    expect(byId.get(101)!.wheelchair_accessible).toBeNull();
    expect(byId.get(102)!.wheelchair_accessible).toBe(false);
    expect(byId.get(103)!.wheelchair_accessible).toBe(true);
    expect(byId.get(101)!.is_closed).toBe(false);
    expect(rows.map((r) => r.foodbank_slug)).toEqual(["salisbury", "salisbury", "salisbury"]);
    expect(byId.get(101)!.foodbank_name).toBe("Salisbury Foodbank");
  });
});

// ---------------------------------------------------------------------------
// getDonationPointsByIds
// ---------------------------------------------------------------------------

describe("getDonationPointsByIds", () => {
  // No ids means no statement -- not a statement that matches nothing. Both
  // return [], so the only way to tell them apart is to watch what was
  // prepared. Worth pinning because search issues this call on every request
  // whose 20 nearest results happen to be all locations and no donation
  // points, which is common outside cities.
  it("issues no SQL at all for an empty id list", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra" });

    expect(await getDonationPointsByIds(session, [])).toEqual([]);
    expect(prepared).toEqual([]);
  });

  // THE REASON THIS FUNCTION RE-ORDERS IN JS. The ids arrive already ranked
  // by distance from nearest(), and `WHERE id IN (...)` gives no ordering
  // guarantee whatsoever -- SQLite here returns them in rowid order, which is
  // ascending id. Returning the rows in the engine's order would silently
  // re-sort the search results page by database id, i.e. by the order rows
  // were imported. The descending-id request is what makes the two orders
  // distinguishable.
  it("returns rows in the caller's id order, not the table's", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra" });
    seedDonationPoint({ id: 102, foodbankId: SALISBURY, name: "Aldi Salisbury" });
    seedDonationPoint({ id: 103, foodbankId: SALISBURY, name: "Morrisons Daily" });

    expect(ids(await getDonationPointsByIds(session, [103, 101, 102]))).toEqual([103, 101, 102]);
    expect(ids(await getDonationPointsByIds(session, [102, 103, 101]))).toEqual([102, 103, 101]);
  });

  // A ranked id whose row has since been deleted is dropped, not returned as
  // an undefined hole -- the callers build a Map from the result and then
  // look each ranked id up again, so a hole here would become a
  // `Cannot read properties of undefined` on the results page.
  it("drops ids with no matching row rather than returning holes", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra" });

    expect(ids(await getDonationPointsByIds(session, [101, 999]))).toEqual([101]);
    expect(await getDonationPointsByIds(session, [998, 999])).toEqual([]);
  });

  // A duplicated id yields the row twice, because the re-ordering is a
  // `map` over the CALLER's list rather than over the query's results.
  // nearest() cannot produce duplicates, so this is latent rather than live;
  // pinned because it is the visible difference between mapping the input and
  // mapping the output, and a future caller passing a concatenated list would
  // get silent duplicates rather than a dedupe.
  it("repeats a row when its id appears twice in the request", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra" });

    expect(ids(await getDonationPointsByIds(session, [101, 101]))).toEqual([101, 101]);
  });

  it("maps the flag columns on the rows it returns", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra", inStoreOnly: 1, wheelchairAccessible: null });

    const [row] = await getDonationPointsByIds(session, [101]);

    expect(row!.in_store_only).toBe(true);
    expect(row!.wheelchair_accessible).toBeNull();
    expect(row!.foodbank_slug).toBe("salisbury");
  });

  // D1's 100-BOUND-PARAMETER LIMIT. This builds one placeholder per id with
  // no chunking, so the statement's parameter count IS the caller's list
  // length. 100 is D1's documented cap and is fine.
  it("builds a single statement at D1's 100-parameter limit", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    const wanted: number[] = [];
    for (let i = 0; i < 100; i++) {
      seedDonationPoint({ id: 1000 + i, foodbankId: SALISBURY, name: `Store ${String(i).padStart(3, "0")}` });
      wanted.push(1000 + i);
    }

    const rows = await getDonationPointsByIds(session, wanted);

    expect(rows).toHaveLength(100);
    expect(prepared).toHaveLength(1);
    expect((prepared[0]!.match(/\?/g) ?? []).length).toBe(100);
  });

  // ...AND OVER IT. SUSPECT, PINNED AS-IS. node:sqlite's own limit is 32,766,
  // so 150 ids succeed here; D1 would reject the statement outright. It is
  // unreachable today -- the only callers (findDonationpoints.ts and
  // api2/donationpoints.ts) pass at most the 20 survivors of nearest() -- but
  // nothing in the function's signature says so, and needAdmin.ts:315 chunks
  // at 90 for exactly this reason. Asserted as what the code does, with the
  // divergence between the two engines named, rather than as a red test for
  // the chunking it does not have.
  it("builds a 150-parameter statement over D1's limit, which only this engine accepts", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    const wanted: number[] = [];
    for (let i = 0; i < 150; i++) {
      seedDonationPoint({ id: 1000 + i, foodbankId: SALISBURY, name: `Store ${String(i).padStart(3, "0")}` });
      wanted.push(1000 + i);
    }

    const rows = await getDonationPointsByIds(session, wanted);

    expect(rows).toHaveLength(150);
    expect(prepared).toHaveLength(1);
    expect((prepared[0]!.match(/\?/g) ?? []).length).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// companyDonationPointsExist
// ---------------------------------------------------------------------------

describe("companyDonationPointsExist", () => {
  it("is true when the company has at least one donation point, false otherwise", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra", company: "Tesco", companySlug: "tesco" });

    expect(await companyDonationPointsExist(session, "tesco")).toBe(true);
    expect(await companyDonationPointsExist(session, "waitrose")).toBe(false);
  });

  // Returns a real boolean, not the truthy `{"1": 1}` row SQLite hands back
  // for `SELECT 1`. api3.ts branches on it directly.
  it("returns a boolean rather than the row itself", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra", companySlug: "tesco" });

    expect(await companyDonationPointsExist(session, "tesco")).toBe(true);
  });

  // company_slug is nullable and most donation points carry NULL. A null
  // slug reaching the bind must not match those rows -- `= NULL` is never
  // true, which happens to be the behaviour the 404 needs.
  it("does not match the NULL-company rows when the slug is null", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Independent Shop", companySlug: null });

    expect(await companyDonationPointsExist(session, null as unknown as string)).toBe(false);
  });

  // A DIVERGENCE BETWEEN THE TWO HALVES OF gfapi3's `company`, pinned rather
  // than fixed. This reads the base table; getDonationPointsByCompanySlug
  // INNER JOINs foodbank. A donation point whose parent row is missing is
  // therefore counted by the existence check but dropped by the fetch, so
  // /donationpoints/company/<slug>/ answers 200 with an empty JSON array
  // instead of the 404 the check was there to produce. Unreachable in
  // Postgres, where a foreign key forbade the orphan; reachable in D1, which
  // declares none (PLAN.md §4.5).
  it("counts a donation point whose parent food bank is missing, though the fetch will drop it", async () => {
    seedDonationPoint({ id: 104, foodbankId: 999, name: "Orphaned Co-op", companySlug: "co-op" });

    expect(await companyDonationPointsExist(session, "co-op")).toBe(true);
    expect(await getDonationPointsByCompanySlug(session, "co-op")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getDonationPointsByCompanySlug
// ---------------------------------------------------------------------------

describe("getDonationPointsByCompanySlug", () => {
  // The exact projected shape of Django's `.only(...)` at gfapi3/views.py:26
  // -- eight donation-point fields, fourteen food bank fields and four from
  // the latest need, all in one query so the handler needs none per row. An
  // aliasing mistake in COMPANY_QUERY (dp.postcode landing in fb_postcode,
  // say) produces a plausible-looking response with one charity's postcode on
  // another's store, so the whole nested object is asserted at once with
  // deliberately distinguishable values.
  it("returns the full nested donation point / food bank / latest need shape", async () => {
    seedNeed({
      id: 900,
      needId: "aaaabbbbccccddddeeeeffff00001111",
      foodbankId: SALISBURY,
      changeText: "Tinned tomatoes\nRice\nUHT milk",
      excess: "Baked beans",
      created: "2026-09-05 19:28:08.853000",
    });
    seedFoodbank({ id: SALISBURY, slug: "salisbury", name: "Salisbury Foodbank", network: "Trussell Trust", latestNeedId: 900 });
    seedDonationPoint({
      id: 101,
      foodbankId: SALISBURY,
      name: "Tesco Extra Salisbury",
      uuid: TESCO_UUID,
      country: "England",
      company: "Tesco",
      companySlug: "tesco",
      storeId: "2996",
    });

    const rows = await getDonationPointsByCompanySlug(session, "tesco");

    expect(rows).toEqual([
      {
        uuid: TESCO_UUID,
        name: "Tesco Extra Salisbury",
        address: "12 Castle Street",
        postcode: "SP1 3TA",
        country: "England",
        lat_lng: "51.07,-1.79",
        place_id: "ChIJdd4hrwug2EcRmSrV3Vo6llI",
        store_id: "2996",
        foodbank: {
          // 32-char dashless, as every UUID in this database is stored
          // (PLAN.md §4.4); api3.ts re-dashes it on the way out.
          uuid: "salisbury00000000000000000000000",
          name: "Salisbury Foodbank",
          alt_name: "salisbury alt",
          slug: "salisbury",
          url: "https://salisbury.foodbank.org.uk/",
          shopping_list_url: "https://salisbury.foodbank.org.uk/shopping-list/",
          phone_number: "01722 411900",
          secondary_phone_number: "07700 900123",
          contact_email: "info@salisbury.foodbank.org.uk",
          address: "1 High Street\r\nSalisbury",
          postcode: "SP1 1AA",
          country: "England",
          lat_lng: "51.0688,-1.7945",
          charity_number: "1130854",
          network: "Trussell Trust",
          latestNeed: {
            need_id: "aaaabbbbccccddddeeeeffff00001111",
            change_text: "Tinned tomatoes\nRice\nUHT milk",
            excess_change_text: "Baked beans",
            // Django's own format, carried through untouched. gfapi3 formats
            // it downstream; a query that re-derived it (via an ISO
            // conversion, say) would change every "found" value in the
            // public API and sort wrongly against the stored TEXT.
            created: "2026-09-05 19:28:08.853000",
          },
        },
      },
    ]);
  });

  // Django's queryset ends `.order_by("name")` (gfapi3/views.py:35), which
  // Postgres answered under en_US.utf8. Sorted in JS for the same reason as
  // getDonationPointsByFoodbankId -- byte order would put "aldi" after
  // "Tesco" and the mobile app's company store list would look broken.
  it("sorts by donation point name under the same linguistic collation", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Winchester", companySlug: "tesco" });
    seedDonationPoint({ id: 102, foodbankId: SALISBURY, name: "tesco andover", companySlug: "tesco" });
    seedDonationPoint({ id: 103, foodbankId: SALISBURY, name: "Tesco Basingstoke", companySlug: "tesco" });

    expect(names(await getDonationPointsByCompanySlug(session, "tesco"))).toEqual([
      "tesco andover",
      "Tesco Basingstoke",
      "Tesco Winchester",
    ]);
  });

  // A filter that does nothing passes every test that seeds only its own
  // company's rows, so the Sainsbury's row exists purely to be excluded.
  it("excludes another company's donation points", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra", companySlug: "tesco" });
    seedDonationPoint({ id: 102, foodbankId: SALISBURY, name: "Sainsburys Local", companySlug: "sainsburys" });
    seedDonationPoint({ id: 103, foodbankId: SALISBURY, name: "Independent Shop", companySlug: null });

    expect(names(await getDonationPointsByCompanySlug(session, "tesco"))).toEqual(["Tesco Extra"]);
  });

  // NO is_closed FILTER, matching gfapi3/views.py:19-35, which has none
  // either. A shut Tesco stays in the company feed.
  it("includes closed donation points, matching the source queryset", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra", companySlug: "tesco", isClosed: 1 });

    expect(names(await getDonationPointsByCompanySlug(session, "tesco"))).toEqual(["Tesco Extra"]);
  });

  // LEFT JOIN on the need, so a food bank that has never had one still
  // produces its donation points. api3.ts then does `dp.foodbank.latestNeed!`
  // and throws -- deliberately, to reproduce Django's own unguarded
  // `dp.foodbank.latest_need.change_text`. This function's job is to report
  // the null honestly; turning the LEFT JOIN into an INNER one would instead
  // drop the stores from the feed silently, which is the worse failure.
  it("reports latestNeed as null when the food bank has no latest_need_id", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", latestNeedId: null });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra", companySlug: "tesco" });

    const rows = await getDonationPointsByCompanySlug(session, "tesco");

    expect(rows).toHaveLength(1);
    expect(rows[0]!.foodbank.latestNeed).toBeNull();
  });

  // latest_need_id is an unenforced circular reference -- no foreign key
  // (0001_core.sql:42, PLAN.md §4.5) -- so it can point at a deleted need.
  // The dangling pointer must behave like no pointer, not like a row of
  // undefineds: mapCompanyRow decides on `need_need_id === null`, which is
  // what an unmatched LEFT JOIN produces.
  it("reports latestNeed as null when latest_need_id points at a row that no longer exists", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", latestNeedId: 12345 });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra", companySlug: "tesco" });

    expect((await getDonationPointsByCompanySlug(session, "tesco"))[0]!.foodbank.latestNeed).toBeNull();
  });

  // JOINED ON latest_need_id, NOT ON foodbank_id. Every other test here seeds
  // at most ONE foodbankchange row per food bank, and with one need in the
  // table the two joins are indistinguishable -- so
  // `ON n.foodbank_id = f.id` passed all of them. Production has the opposite
  // shape: a food bank accumulates one foodbankchange per need it has ever
  // published (hundreds, over years), and `latest_need_id` is the pointer that
  // picks today's. Under the wrong join every donation point would be
  // multiplied by that whole history -- three rows here for one store, and
  // ~200 in the real table -- and gfapi3 would publish a years-old shopping
  // list against a live store. Mutant killed:
  // `LEFT JOIN foodbankchange n ON f.latest_need_id = n.id` swapped for
  // `ON n.foodbank_id = f.id`.
  //
  // latest_need_id deliberately does NOT name the newest row by `created`,
  // which also kills the plausible "just take the most recent need" rewrite.
  // Django's own model does the same: `latest_need` is a foreign key the ETL
  // sets, not a max() over the history.
  it("joins the one need latest_need_id names, not the food bank's whole need history", async () => {
    seedNeed({
      id: 898,
      needId: "11112222333344445555666677778888",
      foodbankId: SALISBURY,
      changeText: "Soup",
      created: "2026-07-14 08:01:02.100000",
    });
    seedNeed({
      id: 899,
      needId: "22223333444455556666777788889999",
      foodbankId: SALISBURY,
      changeText: "Pasta",
      created: "2026-08-20 08:01:02.100000",
    });
    seedNeed({
      id: 900,
      needId: "33334444555566667777888899990000",
      foodbankId: SALISBURY,
      changeText: "Rice",
      created: "2026-09-02 08:01:02.100000",
    });
    seedFoodbank({ id: SALISBURY, slug: "salisbury", latestNeedId: 899 });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra", companySlug: "tesco" });

    const rows = await getDonationPointsByCompanySlug(session, "tesco");

    expect(names(rows)).toEqual(["Tesco Extra"]);
    expect(rows[0]!.foodbank.latestNeed).toEqual({
      need_id: "22223333444455556666777788889999",
      change_text: "Pasta",
      excess_change_text: null,
      created: "2026-08-20 08:01:02.100000",
    });
  });

  // TWO COUNTRIES, ONE PER TABLE. The full-shape test above gives the donation
  // point and its food bank the same country, "England" -- true of nearly
  // every row in production, and it makes `dp.country AS dp_country` and
  // `f.country AS fb_country` indistinguishable, so aliasing either one from
  // the wrong table passed. Cross-border pairs are real: food banks near the
  // Welsh and Scottish borders take donations at stores on the other side, and
  // gfapi3 publishes both countries in the same object -- one of them feeds
  // the store's own record, the other the charity's. Mutants killed:
  // dp_country sourced from `f`, and fb_country sourced from `dp`.
  it("reads the donation point's country and the food bank's country from their own tables", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Newtown", country: "Wales", companySlug: "tesco" });

    const [row] = await getDonationPointsByCompanySlug(session, "tesco");

    expect(row!.country).toBe("Wales");
    expect(row!.foodbank.country).toBe("England");
  });

  // Cardinality: one food bank with two stores and a second food bank with
  // one, all under the same company, must give three rows -- not two, and not
  // a cross product. The shared need row is joined once per donation point.
  it("returns one row per donation point across several parent food banks", async () => {
    seedNeed({ id: 900, needId: "aaaabbbbccccddddeeeeffff00001111", foodbankId: SALISBURY, changeText: "Rice" });
    seedNeed({ id: 901, needId: "bbbbccccddddeeeeffff000011112222", foodbankId: WESTBURY, changeText: "Pasta" });
    seedFoodbank({ id: SALISBURY, slug: "salisbury", latestNeedId: 900 });
    seedFoodbank({ id: WESTBURY, slug: "westbury", latestNeedId: 901 });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Amesbury", companySlug: "tesco" });
    seedDonationPoint({ id: 102, foodbankId: SALISBURY, name: "Tesco Bishopdown", companySlug: "tesco" });
    seedDonationPoint({ id: 103, foodbankId: WESTBURY, name: "Tesco Warminster", companySlug: "tesco" });

    const rows = await getDonationPointsByCompanySlug(session, "tesco");

    expect(names(rows)).toEqual(["Tesco Amesbury", "Tesco Bishopdown", "Tesco Warminster"]);
    expect(rows.map((r) => r.foodbank.slug)).toEqual(["salisbury", "salisbury", "westbury"]);
    expect(rows.map((r) => r.foodbank.latestNeed!.change_text)).toEqual(["Rice", "Rice", "Pasta"]);
  });

  it("returns an empty array for an unknown company", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra", companySlug: "tesco" });

    expect(await getDonationPointsByCompanySlug(session, "waitrose")).toEqual([]);
  });

  // The company slug comes straight off the /donationpoints/company/<slug>/
  // path, and this predicate must be exact for the same reasons
  // getDonationPointBySlugs's is. It is worth pinning separately because the
  // two halves of gfapi3 would disagree: companyDonationPointsExist uses `=`
  // and would 404 "Tesco", while a LIKE here would happily have served it --
  // so the divergence shows up only when the two are read together, which is
  // how the orphan divergence three describes up went unnoticed too.
  // Mutant killed: `WHERE dp.company_slug = ?` swapped for LIKE.
  it("matches the company slug exactly, with no case folding and no LIKE wildcards", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedDonationPoint({ id: 101, foodbankId: SALISBURY, name: "Tesco Extra", companySlug: "tesco" });

    expect(await getDonationPointsByCompanySlug(session, "Tesco")).toEqual([]);
    expect(await getDonationPointsByCompanySlug(session, "tesco%")).toEqual([]);
    expect(await getDonationPointsByCompanySlug(session, "tesc_")).toEqual([]);
    expect(names(await getDonationPointsByCompanySlug(session, "tesco"))).toEqual(["Tesco Extra"]);
  });
});
