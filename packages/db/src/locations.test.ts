import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getAllOpenLocationSlugs,
  getAllOpenLocationSlugsWithNames,
  getAllOpenLocations,
  getAllOpenLocationsFlagged,
  getFoodbankLocationBySlugs,
  getLocationLatLngsByFoodbankId,
  getLocationsByFoodbankId,
  getLocationsByFoodbankIdFlagged,
  getLocationsByFoodbankIdNarrow,
  getLocationsByFoodbankIdUnsorted,
  getLocationsByIds,
  getOpenDonationPointLocationCoordinates,
  getOpenDonationPointLocations,
  getOpenLocationCoordinates,
  getOpenLocationCoordinatesWithFoodbankId,
  getOpenLocationsByConstituencyId,
  getOpenLocationsByCountry,
  hasServiceArea,
  LOCATION_BOOLEAN_COLUMNS,
  LOCATION_COLUMNS_NARROW,
  mapLocationRow,
  type FoodbankLocationRow,
  type FoodbankLocationRowNarrow,
} from "./locations";
import type { Session } from "./types";

// The location half of the read layer: fifteen queries behind /locations/
// (gfapi2), every geo.json feed, both sitemaps, /needs/at/<slug>/<locslug>/,
// the location branch of search and of donationpoint_search, the food bank
// page's service-area flag, the admin's duplicate-lat_lng check and the
// map.png backfill.
//
// RUN AGAINST A REAL DATABASE, NOT A FAKE. Every function here is one SQL
// statement plus a `.map()`, so a session answering canned rows would be
// asserting against a second implementation of the query rather than against
// the query. And every failure mode in this file is SILENT: a dropped
// `is_closed = 0` publishes shut locations to the API and the sitemap, a
// dropped `foodbank_id` predicate leaks one charity's locations into
// another's page, a `sortByName` added where there is none reorders 2,000
// geo.json features, an INNER JOIN where the view has a LEFT one loses rows.
// None of those throw. The only proof available is "these rows, in this
// order, and no others".
//
// THE SCHEMA IS COPIED FROM THE MIGRATIONS, NOT FROM FoodbankLocationRow --
// the disagreement between the two is exactly what a db-tier test is for, and
// three are pinned below: CoordinateRow declares `latitude: number` over a
// NULLABLE column, FoodbankLocationRow declares `is_closed: boolean` where
// mapLocationRow can yield null, and getAllOpenLocationSlugs declares
// `foodbank_slug: string` over a LEFT JOIN that can produce null.
//
// 0019 IS REPLAYED, NOT SHORT-CUT. The fixture creates foodbanklocation with
// its five denormalised parent columns, drops them, and only then creates
// foodbanklocation_full -- because 0019_drop_foodbank_cache.sql is this
// repo's scar. It silently broke four queries that still named dropped
// columns and left /dashboard/beautybanks/ a live 500 nobody noticed until it
// was measured. A fixture that simply declared the post-migration shape could
// not fail on a query that names foodbank_slug on the base table; this one
// fails the way D1 would. Note which functions here read the VIEW and which
// read the BASE table -- that split is itself asserted, because a query moved
// to the wrong one either throws (naming a dropped column) or quietly stops
// seeing the parent's current values.
//
// Like donationpoints.test.ts, this file needs "node" in the package's
// tsconfig `types` to satisfy `pnpm typecheck` (packages/db compiles against
// @cloudflare/workers-types alone). That is a config change, not a test
// change, so it is not made here; vitest's node environment has node:sqlite
// regardless and the file runs green.

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

// foodbank: 0001_core.sql:10-48 verbatim. Copied whole rather than trimmed to
// the five columns foodbanklocation_full projects, because the NOT NULL set
// is part of what makes a seeded parent one production would have accepted --
// and because `phone_number` being NULLABLE on the parent while
// `contact_email` is NOT NULL is the difference the view carries straight
// through into FoodbankLocationRow's `foodbank_phone_number: string | null`.
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

// foodbanklocation built the way production was built: created in full by
// 0001_core.sql:57-82 (denormalised parent columns and all), stripped of those
// five by 0019_drop_foodbank_cache.sql:46-50, then re-exposed through the view
// at :68-76. See the header note on why the DROP COLUMNs are replayed rather
// than skipped.
//
// The indexes come along because three of them are load-bearing claims made in
// locations.ts's own comments and asserted below: loc_open_latlng_idx and
// loc_open_dp_latlng_idx are the partial covering indexes the two coordinate
// queries are written for, and loc_fb_name_uniq is UNIQUE(foodbank_id, name),
// so a fixture cannot seed two same-named locations under one food bank -- a
// pair production refuses.
const SCHEMA_LOCATION = `
CREATE TABLE foodbanklocation (
  id INTEGER PRIMARY KEY, uuid TEXT NOT NULL,
  foodbank_id INTEGER NOT NULL,
  foodbank_name TEXT NOT NULL, foodbank_slug TEXT NOT NULL,
  foodbank_network TEXT NOT NULL, foodbank_phone_number TEXT, foodbank_email TEXT NOT NULL,
  name TEXT NOT NULL, slug TEXT NOT NULL,
  address TEXT, postcode TEXT,
  country TEXT NOT NULL, lat_lng TEXT NOT NULL, latitude REAL, longitude REAL,
  place_id TEXT, plus_code_compound TEXT, plus_code_global TEXT, place_has_photo INTEGER,
  county TEXT, district TEXT, ward TEXT, lsoa TEXT, msoa TEXT,
  parliamentary_constituency_id INTEGER,
  parliamentary_constituency_name TEXT, parliamentary_constituency_slug TEXT,
  mp TEXT, mp_party TEXT, mp_parl_id INTEGER,
  is_closed INTEGER NOT NULL,
  is_donation_point INTEGER, is_mobile INTEGER,
  boundary_geojson TEXT,
  phone_number TEXT, email TEXT,
  modified TEXT NOT NULL, edited TEXT
);
CREATE UNIQUE INDEX loc_fb_name_uniq    ON foodbanklocation(foodbank_id, name);
CREATE INDEX loc_foodbank_slug_idx      ON foodbanklocation(foodbank_id, slug);
CREATE INDEX loc_uuid_idx               ON foodbanklocation(uuid);
CREATE INDEX loc_parlcon_slug_idx       ON foodbanklocation(parliamentary_constituency_slug);
CREATE INDEX loc_open_latlng_idx        ON foodbanklocation(latitude, longitude) WHERE is_closed = 0;
CREATE INDEX loc_open_dp_latlng_idx     ON foodbanklocation(latitude, longitude)
                                        WHERE is_closed = 0 AND is_donation_point = 1;

ALTER TABLE foodbanklocation DROP COLUMN foodbank_name;
ALTER TABLE foodbanklocation DROP COLUMN foodbank_slug;
ALTER TABLE foodbanklocation DROP COLUMN foodbank_network;
ALTER TABLE foodbanklocation DROP COLUMN foodbank_phone_number;
ALTER TABLE foodbanklocation DROP COLUMN foodbank_email;

CREATE VIEW foodbanklocation_full AS
  SELECT l.*,
         f.name          AS foodbank_name,
         f.slug          AS foodbank_slug,
         f.network       AS foodbank_network,
         f.phone_number  AS foodbank_phone_number,
         f.contact_email AS foodbank_email
    FROM foodbanklocation l
    LEFT JOIN foodbank f ON f.id = l.foodbank_id;
`;

// ---------------------------------------------------------------------------
// The Session adapter
// ---------------------------------------------------------------------------

type Bindable = null | number | bigint | string | Uint8Array;

// Same adapter as donationpoints.test.ts, plus a log of the SQL actually
// prepared. That log is load-bearing for exactly one claim -- that
// getLocationsByIds([]) issues NO statement -- which cannot be observed from
// the return value, since a query matching nothing would also return [].
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
  phoneNumber?: string | null;
  contactEmail?: string;
  isClosed?: 0 | 1;
}

// Every NOT NULL column filled, so a seeded parent is one the real schema
// would accept. Only the five columns the view reads are parameterised.
function seedFoodbank({
  id,
  slug,
  name,
  network = "Trussell Trust",
  phoneNumber = "01722 411900",
  contactEmail,
  isClosed = 0,
}: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank (
       id, uuid, name, alt_name, slug, address, postcode, country, lat_lng,
       network, charity_number, charity_just_foodbank, contact_email,
       phone_number, url, shopping_list_url,
       address_is_administrative, is_closed, no_locations, days_between_needs,
       created, modified
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, ?, 0, 14, ?, ?)`,
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
    contactEmail ?? `info@${slug}.foodbank.org.uk`,
    phoneNumber,
    `https://${slug}.foodbank.org.uk/`,
    `https://${slug}.foodbank.org.uk/shopping-list/`,
    isClosed,
    "2020-01-01 00:00:00.000000",
    "2026-08-01 09:15:22.412000",
  );
}

interface LocationSeed {
  id: number;
  foodbankId: number;
  name: string;
  slug?: string;
  uuid?: string;
  isClosed?: 0 | 1;
  isDonationPoint?: 0 | 1 | null;
  isMobile?: 0 | 1 | null;
  placeHasPhoto?: 0 | 1 | null;
  country?: string;
  pconId?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  latLng?: string;
  boundaryGeojson?: string | null;
  phoneNumber?: string | null;
  email?: string | null;
}

// A location as the ETL wrote it. Note there is no foodbank_name /
// foodbank_slug / foodbank_network / foodbank_phone_number / foodbank_email to
// write: 0019 dropped all five, and an INSERT naming any of them fails here
// exactly as it would against D1.
function seedLocation(row: LocationSeed): void {
  const latitude = row.latitude === undefined ? 51.07 : row.latitude;
  const longitude = row.longitude === undefined ? -1.79 : row.longitude;
  db.prepare(
    `INSERT INTO foodbanklocation (
       id, uuid, foodbank_id, name, slug, address, postcode, country,
       lat_lng, latitude, longitude, place_id, plus_code_compound, plus_code_global,
       place_has_photo, county, district, ward, lsoa, msoa,
       parliamentary_constituency_id, parliamentary_constituency_name,
       parliamentary_constituency_slug, mp, mp_party, mp_parl_id,
       is_closed, is_donation_point, is_mobile, boundary_geojson,
       phone_number, email, modified, edited
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.uuid ?? String(row.id).padStart(32, "e"),
    row.foodbankId,
    row.name,
    row.slug ??
      row.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, ""),
    "Pembroke Road",
    "SP2 9DY",
    row.country ?? "England",
    row.latLng ?? `${latitude ?? ""},${longitude ?? ""}`,
    latitude,
    longitude,
    "ChIJVXealLU_xkcRja_At0z9AGY",
    "2C4W+MX Salisbury",
    "9C2W2C4W+MX",
    row.placeHasPhoto === undefined ? 1 : row.placeHasPhoto,
    "Wiltshire",
    "Salisbury",
    "Bemerton",
    "Wiltshire 021A",
    "Wiltshire 021",
    row.pconId === undefined ? SALISBURY_PCON : row.pconId,
    "Salisbury",
    "salisbury",
    "John Glen",
    "Conservative",
    4051,
    row.isClosed ?? 0,
    row.isDonationPoint === undefined ? 0 : row.isDonationPoint,
    row.isMobile === undefined ? 0 : row.isMobile,
    row.boundaryGeojson ?? null,
    row.phoneNumber ?? null,
    row.email ?? null,
    // Django's timestamp format: space-separated, six fractional digits, no
    // offset. Stored as TEXT and compared lexicographically everywhere in this
    // database, so an ISO "T" would sort wrongly against the existing rows.
    "2026-08-14 11:02:03.918000",
    null,
  );
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_FOODBANK);
  db.exec(SCHEMA_LOCATION);
  prepared = [];
  session = d1Session(db, prepared);
});

const ids = (rows: readonly { id: number }[]): number[] => rows.map((r) => r.id);
const names = (rows: readonly { name: string }[]): string[] => rows.map((r) => r.name);
const asc = (values: readonly number[]): number[] => [...values].sort((a, b) => a - b);

// The columns the VIEW actually has, read from the engine rather than from a
// list typed into this file -- the drift detector getAllOpenLocationsFlagged's
// block leans on. Same helper, and the same reasoning, as
// constituencies.test.ts:170.
const columnsOf = (table: string): string[] =>
  db
    .prepare("SELECT name FROM pragma_table_info(?)")
    .all(table)
    .map((row) => String((row as { name: unknown }).name));

// EXPLAIN QUERY PLAN for the statement the MODULE prepared, never for a copy
// of it typed into the test. Planning a hand-typed string proves only that the
// string in the test is indexable; it says nothing about the query that
// actually ran, so the covering-index claims below survived a mutant that
// moved both coordinate queries onto foodbanklocation_full -- the exact change
// those claims exist to forbid.
const planFor = (sql: string): string[] =>
  db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all()
    .map((r) => String((r as { detail: unknown }).detail));

// ---------------------------------------------------------------------------
// mapLocationRow / LOCATION_BOOLEAN_COLUMNS
// ---------------------------------------------------------------------------

describe("LOCATION_BOOLEAN_COLUMNS", () => {
  // Exported so constituencies.ts's getFoodbanksForConstituency can coerce the
  // same columns on its narrower, boundary_geojson-excluding row shape without
  // a second copy of the list. Pinned exactly, because the failure of a
  // FORGOTTEN entry is invisible: add a sixth boolean column to
  // FoodbankLocationRow and leave this list alone, and the constituency page
  // silently starts treating the integer 0 as a real value in
  // `{% if location.is_whatever %}` -- true in Nunjucks only by the accident
  // that 0 is falsy in JS, and false for any other spelling of "no".
  it("lists exactly the four INTEGER flag columns on foodbanklocation", () => {
    expect([...LOCATION_BOOLEAN_COLUMNS]).toEqual(["place_has_photo", "is_closed", "is_donation_point", "is_mobile"]);
  });
});

describe("mapLocationRow", () => {
  // D1 has no boolean type, so these four arrive as 0/1/null. Every consumer
  // downstream -- packages/serialise, the templates' `{% if %}` -- treats a
  // truthy value as yes, and the integer 0 is falsy in JS by luck rather than
  // design. The coercion is what makes that luck a contract.
  it("turns the four INTEGER flag columns into real booleans", () => {
    const row = mapLocationRow({
      id: 401,
      name: "Amesbury",
      place_has_photo: 1,
      is_closed: 0,
      is_donation_point: 1,
      is_mobile: 0,
    });

    expect(row.place_has_photo).toBe(true);
    expect(row.is_closed).toBe(false);
    expect(row.is_donation_point).toBe(true);
    expect(row.is_mobile).toBe(false);
  });

  // NULL IS PRESERVED, NOT COALESCED. is_donation_point and is_mobile are
  // declared NOT NULL by the Django model but are NULLABLE in production --
  // 567 and 1,773 of 1,972 rows respectively, per 0001_core.sql:71. Coalescing
  // those to false here would be a defensible-looking one-liner that quietly
  // rewrote gfapi2's `"is_donation_point": null` into `false` for a quarter of
  // the location feed, i.e. a factual claim about a real building invented by
  // a type coercion.
  it("preserves NULL rather than coalescing it to false", () => {
    const row = mapLocationRow({ is_donation_point: null, is_mobile: null, place_has_photo: null });

    expect(row.is_donation_point).toBeNull();
    expect(row.is_mobile).toBeNull();
    expect(row.place_has_photo).toBeNull();
  });

  // The coercion is `value === 1`, not `Boolean(value)` -- so anything that is
  // not the integer 1 becomes false, including the string "1" a hand-run
  // `wrangler d1 execute` could leave behind in SQLite's dynamically typed
  // columns. Pinned because the two spellings differ only for bad data, which
  // is precisely when it matters.
  it("treats any value other than the integer 1 as false", () => {
    expect(mapLocationRow({ is_closed: "1" }).is_closed).toBe(false);
    expect(mapLocationRow({ is_closed: 2 }).is_closed).toBe(false);
    expect(mapLocationRow({ is_mobile: true as unknown as number }).is_mobile).toBe(false);
  });

  // SUSPECT, PINNED AS-IS. A column absent from the row becomes null, not
  // undefined -- so the key always exists, but FoodbankLocationRow declares
  // `is_closed: boolean`, non-nullable, and this is the path by which a null
  // reaches it. Harmless today only because every caller of this function
  // selects `*` from a view whose is_closed column is NOT NULL; a future
  // projected SELECT that omitted it would hand the templates a null that the
  // type says cannot happen.
  it("invents the four flag keys as null when the row does not carry them", () => {
    const row = mapLocationRow({ id: 401 });

    expect(row.is_closed).toBeNull();
    expect(row.is_donation_point).toBeNull();
    expect(row.is_mobile).toBeNull();
    expect(row.place_has_photo).toBeNull();
  });

  // Non-boolean columns pass through untouched, and the input is copied rather
  // than mutated -- coerceBooleans spreads into a fresh object. Worth pinning
  // because getLocationsByIds maps the same rows into a Map and then reads
  // them again; an in-place coercion that ran twice would still be correct,
  // but one that returned the SAME object for two ids would not.
  it("copies the row rather than mutating the one it was given", () => {
    const raw: Record<string, unknown> = { id: 401, name: "Amesbury", is_closed: 1 };
    const row = mapLocationRow(raw);

    expect(row.name).toBe("Amesbury");
    expect(row.is_closed).toBe(true);
    expect(raw.is_closed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The view itself
// ---------------------------------------------------------------------------

// Every column FoodbankLocationRow declares, which is also every column the
// view must produce. This list is the direct guard against 0019's failure
// mode: the migration dropped five columns and four queries elsewhere went on
// naming them, returning wrong or missing data with no exception anywhere. If
// a future migration drops or renames a column here, this fails with the
// column's name in the diff rather than as a blank field on a live page.
const DECLARED_COLUMNS: (keyof FoodbankLocationRow)[] = [
  "id", "uuid", "foodbank_id",
  "foodbank_name", "foodbank_slug", "foodbank_network", "foodbank_phone_number", "foodbank_email",
  "name", "slug", "address", "postcode", "country", "lat_lng", "latitude", "longitude",
  "place_id", "plus_code_compound", "plus_code_global", "place_has_photo",
  "county", "district", "ward", "lsoa", "msoa",
  "parliamentary_constituency_id", "parliamentary_constituency_name", "parliamentary_constituency_slug",
  "mp", "mp_party", "mp_parl_id",
  "is_closed", "is_donation_point", "is_mobile", "boundary_geojson",
  "phone_number", "email", "modified", "edited",
];

// The same list minus the one column the projected row type drops, DERIVED from
// it rather than retyped -- two hand-written 38/39-name lists that had to agree
// would be the very drift this file exists to catch. The predicate's return type
// is what does the work: `keyof FoodbankLocationRowNarrow` does not include
// boundary_geojson, so a filter that let it through stops compiling, and the
// list cannot silently describe a shape the type does not.
const DECLARED_COLUMNS_NARROW = DECLARED_COLUMNS.filter(
  (column): column is keyof FoodbankLocationRowNarrow => column !== "boundary_geojson",
);

describe("foodbanklocation_full", () => {
  it("supplies exactly the columns FoodbankLocationRow declares, no more and no fewer", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury" });

    const [row] = await getLocationsByFoodbankId(session, SALISBURY);

    expect(Object.keys(row!).sort()).toEqual([...DECLARED_COLUMNS].sort());
  });

  // THE WHOLE POINT OF 0019. The parent's name/slug/network/phone/email used
  // to be copied onto the child and refreshed only in the CHILD's save(), so
  // renaming a food bank left every one of its locations holding the old value
  // -- measured against production, 24 rows disagreed with their parent's slug
  // and name, 44 with its phone number, 38 with its email. And because
  // getFoodbankLocationBySlugs FINDS a location by that slug, a stale copy 404s
  // the location's own page. The join makes staleness unrepresentable; this
  // proves the join is live and not a copy taken at view-creation time.
  it("reads all five parent fields live, so a rename propagates immediately", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", name: "Salisbury Foodbank" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury" });

    db.prepare("UPDATE foodbank SET name = ?, slug = ?, network = ?, phone_number = ?, contact_email = ? WHERE id = ?").run(
      "Salisbury & District Foodbank",
      "salisbury-and-district",
      "IFAN",
      "01722 000111",
      "hello@salisbury.foodbank.org.uk",
      SALISBURY,
    );

    const [row] = await getLocationsByFoodbankId(session, SALISBURY);

    expect(row!.foodbank_name).toBe("Salisbury & District Foodbank");
    expect(row!.foodbank_slug).toBe("salisbury-and-district");
    expect(row!.foodbank_network).toBe("IFAN");
    expect(row!.foodbank_phone_number).toBe("01722 000111");
    expect(row!.foodbank_email).toBe("hello@salisbury.foodbank.org.uk");
  });

  // LEFT JOIN, not JOIN, and 0019's own comment says why: D1 declares no
  // foreign keys (PLAN.md §4.5), so nothing enforces that the parent exists.
  // An inner join would make a location vanish from the API and every geo.json
  // the moment its food bank row was deleted -- rather than surfacing as an
  // obviously broken row somebody notices. Swap LEFT for INNER and this is the
  // test that fails.
  it("keeps a location whose parent food bank is missing, with null parent fields", async () => {
    seedLocation({ id: 404, foodbankId: 999, name: "Orphaned Outreach" });

    const rows = await getLocationsByFoodbankId(session, 999);

    expect(ids(rows)).toEqual([404]);
    expect(rows[0]!.foodbank_name).toBeNull();
    expect(rows[0]!.foodbank_slug).toBeNull();
    expect(rows[0]!.foodbank_network).toBeNull();
    expect(rows[0]!.foodbank_phone_number).toBeNull();
    expect(rows[0]!.foodbank_email).toBeNull();
  });

  // Cardinality, stated as a row count rather than left to a spot-check: one
  // parent with two children and a childless parent. A join written the wrong
  // way round (foodbank LEFT JOIN foodbanklocation) would produce a row for
  // the childless food bank too, which reads as a location with no name and
  // renders as a blank entry on the locations page.
  it("produces exactly one row per location, and none for a childless food bank", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedFoodbank({ id: WESTBURY, slug: "westbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury" });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Wilton" });

    expect(ids(await getLocationsByFoodbankId(session, SALISBURY))).toEqual([401, 402]);
    expect(await getLocationsByFoodbankId(session, WESTBURY)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The VIEW / BASE TABLE split
// ---------------------------------------------------------------------------

// Which table each statement names, asserted as one table rather than left to
// each function's own tests -- because for five of these it is INVISIBLE from
// the return value. `SELECT lat_lng FROM foodbanklocation_full` and
// `... FROM foodbanklocation` return identical rows: the view is a LEFT JOIN
// that adds columns and drops none. Mutation-tested, and four mutants survived
// the rest of this file with every assertion still green --
// getLocationLatLngsByFoodbankId, hasServiceArea,
// getOpenLocationCoordinates(WithFoodbankId) and
// getOpenDonationPointLocationCoordinates all moved onto the view and nothing
// noticed. That is not cosmetic: the two coordinate queries exist ONLY to be
// answered as covering index scans of a partial index on the base table (WP
// 2.5), and a view cannot be covered -- every open location in the country
// gains a per-row lookup into foodbank on every uncached search. The reverse
// swap, a view-reading query moved to the base table, is the 0019 scar itself:
// it names foodbank_slug, which no longer exists there.
const READS_THE_VIEW: Array<[string, (s: Session) => Promise<unknown>]> = [
  ["getLocationsByFoodbankId", (s) => getLocationsByFoodbankId(s, SALISBURY)],
  ["getLocationsByFoodbankIdFlagged", (s) => getLocationsByFoodbankIdFlagged(s, SALISBURY)],
  ["getLocationsByFoodbankIdNarrow", (s) => getLocationsByFoodbankIdNarrow(s, SALISBURY)],
  ["getLocationsByFoodbankIdUnsorted", (s) => getLocationsByFoodbankIdUnsorted(s, SALISBURY)],
  ["getAllOpenLocations", (s) => getAllOpenLocations(s)],
  ["getAllOpenLocationSlugs", (s) => getAllOpenLocationSlugs(s)],
  ["getAllOpenLocationSlugsWithNames", (s) => getAllOpenLocationSlugsWithNames(s)],
  ["getOpenDonationPointLocations", (s) => getOpenDonationPointLocations(s)],
  ["getLocationsByIds", (s) => getLocationsByIds(s, [401])],
  ["getFoodbankLocationBySlugs", (s) => getFoodbankLocationBySlugs(s, "salisbury", "amesbury")],
  ["getOpenLocationsByConstituencyId", (s) => getOpenLocationsByConstituencyId(s, SALISBURY_PCON)],
  ["getOpenLocationsByCountry", (s) => getOpenLocationsByCountry(s, "England")],
];

const READS_THE_BASE_TABLE: Array<[string, (s: Session) => Promise<unknown>]> = [
  ["getLocationLatLngsByFoodbankId", (s) => getLocationLatLngsByFoodbankId(s, SALISBURY)],
  ["getOpenLocationCoordinates", (s) => getOpenLocationCoordinates(s)],
  ["getOpenDonationPointLocationCoordinates", (s) => getOpenDonationPointLocationCoordinates(s)],
  ["getOpenLocationCoordinatesWithFoodbankId", (s) => getOpenLocationCoordinatesWithFoodbankId(s)],
  ["hasServiceArea", (s) => hasServiceArea(s, SALISBURY)],
];

const tableIn = (sql: string): string => sql.match(/FROM\s+(\w+)/)![1]!;

describe("the view / base table split", () => {
  beforeEach(() => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", slug: "amesbury" });
    prepared.length = 0;
  });

  for (const [name, call] of READS_THE_VIEW) {
    it(`${name} reads foodbanklocation_full`, async () => {
      await call(session);

      expect(prepared).toHaveLength(1);
      expect(tableIn(prepared[0]!)).toBe("foodbanklocation_full");
    });
  }

  for (const [name, call] of READS_THE_BASE_TABLE) {
    it(`${name} reads the base foodbanklocation table`, async () => {
      await call(session);

      expect(prepared).toHaveLength(1);
      expect(tableIn(prepared[0]!)).toBe("foodbanklocation");
    });
  }
});

// ---------------------------------------------------------------------------
// getLocationsByFoodbankId
// ---------------------------------------------------------------------------

describe("getLocationsByFoodbankId", () => {
  it("returns only the named food bank's locations", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedFoodbank({ id: WESTBURY, slug: "westbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury" });
    seedLocation({ id: 402, foodbankId: WESTBURY, name: "Warminster" });

    expect(ids(await getLocationsByFoodbankId(session, SALISBURY))).toEqual([401]);
  });

  // NO is_closed FILTER, deliberately. Django's `Foodbank.locations()` is
  // `FoodbankLocation.objects.filter(foodbank = self).order_by("name")`
  // (givefood/models/foodbank.py:545-546) with no `is_closed` clause, and a
  // food bank's location list can and does include closed locations even while
  // the food bank itself is open. Adding the filter that "obviously belongs"
  // here would quietly empty rows out of /needs/at/<slug>/locations/, out of
  // the admin's location table and out of gfapi2's foodbank detail -- so this
  // asserts the ABSENCE of a filter, which no test seeding only open rows can.
  it("includes CLOSED locations, matching Django's unfiltered queryset", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", isClosed: 0 });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Wilton", isClosed: 1 });

    const rows = await getLocationsByFoodbankId(session, SALISBURY);

    expect(ids(rows)).toEqual([401, 402]);
    expect(rows.map((r) => r.is_closed)).toEqual([false, true]);
  });

  // SORTED IN JS, NOT SQL, and the difference is visible rather than
  // theoretical. D1/SQLite's default collation is byte-wise, so a literal
  // `ORDER BY name` puts every capital before every lowercase and every
  // accented letter after "z". The source Postgres sorted under en_US.utf8,
  // which Intl.Collator("en-US") reproduces. Both orderings were executed to
  // write this expectation -- the byte order is the second array, and it is
  // exactly what a "simplification" back to SQL ORDER BY would produce.
  //
  // AND THE SLUGS ARE EXPLICIT, which is what makes the claim testable at all.
  // The statement is answered from `loc_foodbank_slug_idx (foodbank_id, slug)`,
  // so rows arrive in SLUG order -- and seedLocation derives a slug from the
  // name, so for any set of names anyone would naturally pick, the engine hands
  // the sort a list that is ALREADY in the expected order and doing nothing
  // passes. Mutation-tested: with derived slugs, deleting sortByName from this
  // function left this assertion green. These five slugs are chosen to disagree
  // with the names.
  it("sorts by name under a linguistic collation, not SQLite's byte order", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Wilton", slug: "aaa" });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "amesbury Hub", slug: "bbb" });
    seedLocation({ id: 403, foodbankId: SALISBURY, name: "Éire Centre", slug: "ccc" });
    seedLocation({ id: 404, foodbankId: SALISBURY, name: "Bemerton Heath", slug: "ddd" });
    seedLocation({ id: 405, foodbankId: SALISBURY, name: "Zeals Outreach", slug: "eee" });

    const rows = await getLocationsByFoodbankId(session, SALISBURY);

    // The premise: the rows really do arrive out of name order, so the two
    // expectations below cannot be satisfied by a function that never sorts.
    expect(names(await getLocationsByFoodbankIdUnsorted(session, SALISBURY))).toEqual([
      "Wilton",
      "amesbury Hub",
      "Éire Centre",
      "Bemerton Heath",
      "Zeals Outreach",
    ]);
    expect(names(rows)).toEqual(["amesbury Hub", "Bemerton Heath", "Éire Centre", "Wilton", "Zeals Outreach"]);
    expect(names(rows)).not.toEqual(["Bemerton Heath", "Wilton", "Zeals Outreach", "amesbury Hub", "Éire Centre"]);
  });

  // The mapping runs per row, not just on the first: a `.map` that lost its
  // callback for later rows would leave raw 0/1/null integers in the tail, and
  // `{% if location.is_mobile %}` would then render "mobile" for a location
  // that stores 0.
  it("coerces the flag columns on every row it returns", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", isMobile: 0 });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Bemerton Heath", isMobile: null });
    seedLocation({ id: 403, foodbankId: SALISBURY, name: "Coombe Bissett", isMobile: 1 });

    const rows = await getLocationsByFoodbankId(session, SALISBURY);

    expect(rows.map((r) => r.is_mobile)).toEqual([false, null, true]);
  });

  // Binding NULL where a food bank id belongs matches nothing, rather than
  // matching every row: `foodbank_id = NULL` is never true. The same
  // three-valued logic is a live bug class in this repo (`id != ?` vs
  // `id IS NOT ?`, see locationsAdmin.ts), so it is executed here rather than
  // assumed.
  //
  // AND THE SCHEMA IS WHY THAT IS SAFE, so the schema is asserted too. Mutating
  // this statement to the null-safe `foodbank_id IS ?` -- the spelling
  // locationsAdmin.ts is required to use one file away -- changes nothing
  // observable, because NOT NULL means no row can carry the NULL that `IS`
  // would newly match. That makes the mutant equivalent TODAY and dangerous the
  // day the column becomes nullable, which is exactly what this PRAGMA is a
  // trip-wire for: relax foodbank_id and a null-bound call starts returning
  // every parentless location instead of none.
  it("matches nothing at all when the bound food bank id is NULL", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury" });

    const column = db
      .prepare("PRAGMA table_info(foodbanklocation)")
      .all()
      .find((r) => (r as { name: string }).name === "foodbank_id") as { notnull: number };

    expect(column.notnull).toBe(1);
    expect(await getLocationsByFoodbankId(session, null as unknown as number)).toEqual([]);
    expect(await getLocationsByFoodbankIdUnsorted(session, null as unknown as number)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getLocationsByFoodbankIdFlagged -- getLocationsByFoodbankId with the blob
// replaced by a 0/1 flag, for /needs/at/<slug>/locations/
// ---------------------------------------------------------------------------
//
// That page reads boundary_geojson TWICE and prints it NEITHER time: once to
// derive has_service_area (routes/wfbn/locations.ts) and once to suppress a
// place photo (wfbn/foodbank/locations.njk's `{% if location.place_has_photo
// and not location.has_boundary %}`). The map on the page fetches its geometry
// separately from /needs/at/<slug>/geo.json, which has its own query. So the
// blob was crossing the wire to answer two booleans -- 2,299,936 of the
// 2,319,826 bytes this statement returned for canterbury, the largest of the
// seven production food banks that own a boundary at all. Measured read-only
// against production D1, 7 interleaved runs of each: 2,319,826 -> 19,890 bytes
// (-99.1%), median sql_duration 17.8 ms (12.7-23.3) -> 5.4 ms (3.9-7.4),
// rows_read unchanged at 43.
//
// EVERY FAILURE MODE HERE IS SILENT, which is why this block repeats the shape
// of getAllOpenLocationsFlagged's rather than trusting it: the two functions
// share LOCATION_COLUMNS_FLAGGED but not the WHERE, the sort or the caller. A
// column missing from the projection blanks a field on ~1,000 pages; a
// has_boundary that gets the empty string wrong flips the service-area map on
// or off; a lost sortByName reorders every location list on the site.
//
// MUTATION-TESTED alongside foodbankDetail.test.ts and
// routes/wfbn/locations.test.ts -- thirteen mutants, all killed. The list, and
// the one that looks equivalent and is not (`IS NOT NULL` dropped, which makes
// has_boundary NULL rather than 0), is in foodbankDetail.test.ts's header.

describe("getLocationsByFoodbankIdFlagged", () => {
  // THE DRIFT DETECTOR, same one the sibling carries and for the same reason:
  // LOCATION_COLUMNS_NARROW is a hand-maintained 38-name string and the view is
  // defined in a migration. Read from the engine's pragma, so the next ALTER
  // TABLE updates the constant or turns this red.
  it("returns every column of foodbanklocation_full except boundary_geojson, plus has_boundary", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", boundaryGeojson: '{"type":"Polygon"}' });

    const [row] = await getLocationsByFoodbankIdFlagged(session, SALISBURY);

    const expected = columnsOf("foodbanklocation_full")
      .filter((column) => column !== "boundary_geojson")
      .concat("has_boundary");
    expect(Object.keys(row!).sort()).toEqual(expected.sort());
    expect(Object.keys(row!)).not.toContain("boundary_geojson");
  });

  // THE PARITY CHECK against the unprojected function this one stands in for,
  // built by subtracting the blob and recomputing the flag from it in JS. Not a
  // loosened comparison: a projection that dropped five more columns, or a
  // has_boundary that disagreed with the value the blob held on any row, fails
  // here. Ids, slugs and names are all in different orders, so "same rows in
  // the same order" cannot be satisfied by luck.
  it("returns the same rows, in the same order, as getLocationsByFoodbankId with the blob traded for the flag", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedFoodbank({ id: WESTBURY, slug: "westbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Zeals Outreach", slug: "aaa", boundaryGeojson: '{"type":"Polygon"}' });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Amesbury", slug: "zzz", isDonationPoint: null });
    seedLocation({ id: 403, foodbankId: SALISBURY, name: "Milford", slug: "mmm", isClosed: 1, boundaryGeojson: "" });
    seedLocation({ id: 404, foodbankId: WESTBURY, name: "Warminster" });

    const wide = await getLocationsByFoodbankId(session, SALISBURY);
    const flagged = await getLocationsByFoodbankIdFlagged(session, SALISBURY);

    expect(flagged).toEqual(wide.map(({ boundary_geojson, ...rest }) => ({ ...rest, has_boundary: boundary_geojson ? 1 : 0 })));
    expect(names(flagged)).toEqual(["Amesbury", "Milford", "Zeals Outreach"]);
    expect(flagged.map((r) => r.has_boundary)).toEqual([0, 0, 1]);
  });

  // The three stored spellings, each seeded on its own so the flag is not
  // graded on a fixture where only one of them appears. The empty string is the
  // one a naive `IS NOT NULL` gets wrong, and it is the one an admin edit
  // actually produces: clear the field in the admin and the column holds '',
  // not NULL.
  it.each([
    ["a stored polygon", '{"type":"Polygon","coordinates":[[[0,0]]]}', 1],
    ["NULL", null, 0],
    ["the empty string", "", 0],
    ["whitespace only", "  ", 1],
  ])("flags %s as %o -> has_boundary %i", async (_label, stored, expected) => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", boundaryGeojson: stored });

    const [row] = await getLocationsByFoodbankIdFlagged(session, SALISBURY);

    expect(row!.has_boundary).toBe(expected);
    expect(row!.has_boundary).not.toBeNull();
    // 0/1, never a boolean: has_boundary is deliberately outside
    // LOCATION_BOOLEAN_COLUMNS and routes/wfbn/locations.ts reads it as `=== 1`.
    expect(typeof row!.has_boundary).toBe("number");
  });

  // SCOPED, and CLOSED ROWS KEPT. Both are inherited from the function this
  // replaces and neither is visible in a fixture of one open location: without
  // the foodbank_id predicate the first service area in the country would give
  // every food bank a service-area map, and an `AND is_closed = 0` bolted on
  // here would silently delete shut branches from ~1,000 location lists AND
  // change has_service_area for any food bank whose only boundary sits on one.
  // Django's `Foodbank.locations()` has no is_closed filter
  // (givefood/models/foodbank.py:546), and neither did hasServiceArea's count.
  it("returns only this food bank's locations, closed ones included", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedFoodbank({ id: WESTBURY, slug: "westbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", isClosed: 0 });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Wilton", isClosed: 1, boundaryGeojson: '{"type":"Polygon"}' });
    seedLocation({ id: 403, foodbankId: WESTBURY, name: "Warminster", boundaryGeojson: '{"type":"Polygon"}' });

    const rows = await getLocationsByFoodbankIdFlagged(session, SALISBURY);

    expect(ids(rows)).toEqual([401, 402]);
    expect(rows.map((r) => r.is_closed)).toEqual([false, true]);
    // The closed row's boundary still counts -- this is the case that kills a
    // `.filter((l) => !l.is_closed)` in the caller's derivation.
    expect(rows.some((r) => r.has_boundary === 1)).toBe(true);
  });

  // SORTED IN JS UNDER en-US, not SQLite's byte order -- the same claim
  // getLocationsByFoodbankId's own block makes, restated because this function
  // has its own `.map()` and could lose the sort on its own. The second array
  // is exactly what an SQL `ORDER BY name` would have produced.
  it("sorts by name under a linguistic collation, not SQLite's byte order", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Wilton" });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "amesbury Hub" });
    seedLocation({ id: 403, foodbankId: SALISBURY, name: "Éire Centre" });
    seedLocation({ id: 404, foodbankId: SALISBURY, name: "Bemerton Heath" });

    expect(names(await getLocationsByFoodbankIdFlagged(session, SALISBURY))).toEqual([
      "amesbury Hub",
      "Bemerton Heath",
      "Éire Centre",
      "Wilton",
    ]);
  });

  it("coerces the four flag columns on every row, and leaves has_boundary alone", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", isDonationPoint: null, placeHasPhoto: 0, isMobile: 1 });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Bemerton Heath", isMobile: null, boundaryGeojson: '{"type":"Polygon"}' });

    const rows = await getLocationsByFoodbankIdFlagged(session, SALISBURY);

    // Name order, so Amesbury (no boundary) is first and Bemerton Heath is
    // second -- the ids are seeded the other way round on purpose.
    expect(names(rows)).toEqual(["Amesbury", "Bemerton Heath"]);
    expect(rows.map((r) => r.is_mobile)).toEqual([true, null]);
    expect(rows[0]!.is_donation_point).toBeNull();
    expect(rows[0]!.place_has_photo).toBe(false);
    expect(rows.map((r) => r.has_boundary)).toEqual([0, 1]);
  });

  // THE WHOLE REASON THE FUNCTION EXISTS, asserted on the SQL the MODULE
  // prepared rather than on a copy retyped here -- see planFor's comment for
  // why that distinction matters. A "tidy-up" back to getLocationsByFoodbankId's
  // `SELECT *` returns a superset of these columns and leaves every other test
  // in this block green while putting 2.3 MB back on the wire.
  it("names its columns instead of issuing SELECT *, and never selects the blob", async () => {
    await getLocationsByFoodbankIdFlagged(session, SALISBURY);
    await getLocationsByFoodbankId(session, SALISBURY);
    const [flaggedSql, wideSql] = prepared;

    expect(flaggedSql!).not.toContain("SELECT *");
    expect(flaggedSql!).toContain("FROM foodbanklocation_full WHERE foodbank_id = ?");
    expect(flaggedSql!.match(/boundary_geojson/g)).toEqual(["boundary_geojson", "boundary_geojson"]);
    expect(flaggedSql!).toContain("(boundary_geojson IS NOT NULL AND boundary_geojson != '') AS has_boundary");
    // THE PLAN IS UNCHANGED, asserted against the plan of the statement this
    // replaces rather than against a hardcoded string -- the same index search
    // and the same LEFT-JOIN probe of the parent, so this is bytes on the wire
    // and nothing else. (Production agrees: `SEARCH l USING INDEX
    // loc_foodbank_slug_idx (foodbank_id=?)`, read-only against D1.)
    expect(planFor(flaggedSql!.replace("?", String(SALISBURY)))).toEqual(planFor(wideSql!.replace("?", String(SALISBURY))));
    expect(planFor(flaggedSql!.replace("?", String(SALISBURY)))).toEqual([
      "SEARCH l USING INDEX loc_foodbank_slug_idx (foodbank_id=?)",
      "SEARCH f USING INTEGER PRIMARY KEY (rowid=?) LEFT-JOIN",
    ]);
  });

  it("matches nothing at all when the bound food bank id is NULL", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury" });

    expect(await getLocationsByFoodbankIdFlagged(session, null as unknown as number)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getLocationsByFoodbankIdNarrow -- getLocationsByFoodbankId with the blob
// simply LEFT OUT, for /md/needs/at/<slug>/locations/ and /api/1/foodbank/<slug>/
// ---------------------------------------------------------------------------
//
// THE THIRD SIBLING, AND WHY IT IS NOT THE SECOND ONE. Both of its callers read
// this row and neither prints a boundary OR asks whether there is one:
// wfbn/foodbank/md/locations.njk prints name/address/postcode and links by
// slug (no place photos, no service-area map -- that is the HTML twin, which
// is what getLocationsByFoodbankIdFlagged exists for), and api1.ts's
// /foodbank/<slug>/ maps every row to a fixed ten-field object. So has_boundary
// would be a column nothing reads, and the projection is the plain one.
// Pointing either caller at the Flagged function instead would be a silent,
// harmless-looking widening; the statement assertion below is what forbids it.
//
// Measured read-only against production D1 on canterbury (foodbank_id
// 5712046691713024, 21 locations, all 21 with a boundary -- the largest of the
// only 7 food banks that have one at all): 2,319,826 -> 19,532 bytes of result
// payload, -99.2%, median sql_duration 18.4 ms (13.0-23.5) -> 4.5 ms (3.1-7.7)
// over 7 interleaved runs of each. rows_read is unchanged at 43, so this is
// wire bytes and latency, not D1 billing.
//
// THE FAILURE MODES ARE THE FLAGGED SIBLING'S, and this block repeats their
// shape rather than trusting that block: the two functions share
// LOCATION_COLUMNS_NARROW but not the mapper, the projection tail, the sort
// call or the callers. A column missing from the hand-written list blanks a
// field on ~1,000 markdown pages and drops it out of a live v1 API document; a
// lost sortByName reorders every one of those lists; a lost mapLocationRowNarrow
// hands back raw 0/1 where the row type promises booleans.

describe("getLocationsByFoodbankIdNarrow", () => {
  // THE DRIFT DETECTOR, the same one both Flagged functions carry and for the
  // same reason: LOCATION_COLUMNS_NARROW is a hand-maintained 38-name string
  // and the view is defined in a migration -- two copies of one list, which is
  // exactly what 0019 let drift. Read from the engine's pragma, so the next
  // ALTER TABLE either updates the constant or turns this red.
  //
  // AND NO has_boundary: this is the plain narrow row, not the flagged one, so
  // the key set is the view's columns minus one and nothing else.
  it("returns every column of foodbanklocation_full except boundary_geojson, and no extras", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", boundaryGeojson: '{"type":"Polygon"}' });

    const [row] = await getLocationsByFoodbankIdNarrow(session, SALISBURY);

    const expected = columnsOf("foodbanklocation_full").filter((column) => column !== "boundary_geojson");
    expect(Object.keys(row!).sort()).toEqual(expected.sort());
    expect(Object.keys(row!)).not.toContain("boundary_geojson");
    expect(Object.keys(row!)).not.toContain("has_boundary");
  });

  // THE SAME KEY SET, ANCHORED TO THE TYPE INSTEAD OF THE ENGINE -- the
  // guarantee foodbanklocation_full's own block already makes for
  // FoodbankLocationRow, restated for the projected row because the two
  // anchors fail on DIFFERENT mutations and neither implies the other. The
  // pragma test above compares the row against the VIEW, so it goes red when a
  // migration and LOCATION_COLUMNS_NARROW disagree; this one compares it
  // against what FoodbankLocationRowNarrow PROMISES ITS CALLERS, so it goes
  // red when the projection and the declared type disagree -- a column dropped
  // from both the string and the fixture view would satisfy the pragma test
  // and still hand api1.ts a row missing a field its serialiser names.
  //
  // The count is pinned too. `Object.keys` equality already forces it, but the
  // number is the one thing every comment about this constant quotes ("a
  // hand-typed 38-name string"), and a silent 37 would make all of them wrong.
  it("supplies exactly the columns FoodbankLocationRowNarrow declares, no more and no fewer", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", boundaryGeojson: '{"type":"Polygon"}' });

    const [row] = await getLocationsByFoodbankIdNarrow(session, SALISBURY);

    expect(Object.keys(row!).sort()).toEqual([...DECLARED_COLUMNS_NARROW].sort());
    expect(DECLARED_COLUMNS_NARROW).toHaveLength(38);
    expect(LOCATION_COLUMNS_NARROW.split(",").map((c) => c.trim())).toEqual([...DECLARED_COLUMNS_NARROW]);
  });

  // THE PARITY CHECK against the unprojected function this one stands in for --
  // THE VALUE DID NOT MOVE, stated as an exact whole-row equality rather than a
  // spot-check. A projection that quietly dropped five more columns, or a lost
  // boolean coercion, or a different sort, all fail here. Ids, slugs and names
  // each imply a DIFFERENT sequence, so "same rows in the same order" cannot be
  // satisfied by luck, and one row is closed and one holds a boundary so that
  // neither of the two behaviours inherited from the wide function is graded on
  // a fixture where it cannot show.
  it("returns the same rows, in the same order and with the same values, as getLocationsByFoodbankId minus the blob", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedFoodbank({ id: WESTBURY, slug: "westbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Zeals Outreach", slug: "aaa", boundaryGeojson: '{"type":"Polygon"}' });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Amesbury", slug: "zzz", isDonationPoint: null });
    seedLocation({ id: 403, foodbankId: SALISBURY, name: "Milford", slug: "mmm", isClosed: 1, boundaryGeojson: "" });
    seedLocation({ id: 404, foodbankId: WESTBURY, name: "Warminster" });

    const wide = await getLocationsByFoodbankId(session, SALISBURY);
    const narrow = await getLocationsByFoodbankIdNarrow(session, SALISBURY);

    expect(narrow).toEqual(wide.map(({ boundary_geojson, ...rest }) => rest));
    expect(names(narrow)).toEqual(["Amesbury", "Milford", "Zeals Outreach"]);
    expect(ids(narrow)).toEqual([402, 403, 401]);
  });

  // DUPLICATE NAMES -- what production actually permits, asserted rather than
  // assumed, because it decides what the tie test below has to be. Two
  // locations of ONE food bank cannot share a name at all: `CREATE UNIQUE INDEX
  // loc_fb_name_uniq ON foodbanklocation(foodbank_id, name)` (0001_core.sql:76),
  // which this fixture carries. Confirmed live, read-only against production D1
  // on 2026-09-08: 1,973 location rows, 0 duplicate (foodbank_id, name) pairs.
  // Without this test the collation-tie case below reads as an exotic stand-in
  // for the "obvious" duplicate case, and the obvious case is unrepresentable.
  it("cannot be handed two locations of one food bank with the same name at all", () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", slug: "amesbury" });

    expect(() => seedLocation({ id: 402, foodbankId: SALISBURY, name: "Amesbury", slug: "amesbury-two" })).toThrow(
      /UNIQUE constraint failed/,
    );
  });

  // SO THE TIE THAT CAN HAPPEN IS THE COLLATION ONE, and it is the case where
  // narrowing a SELECT could move the answer with nothing else noticing. Two
  // names that differ as bytes but compare EQUAL under Intl.Collator("en-US")
  // -- a soft hyphen is ignorable at every collation strength -- are two rows
  // the unique index accepts and a tie sortByName's comparator cannot break.
  //
  // Array.prototype.sort is stable, so a tie leaves those rows in the order the
  // ENGINE returned them. That makes tie order a property of the STATEMENT, not
  // of the sort: it is the one thing a changed projection could plausibly
  // reorder while every other assertion in this block stayed green -- same
  // rows, same names, silently swapped in an API document. Pinned as an exact
  // whole-row equality against the wide function AND as a literal id sequence,
  // so it fails whichever of the two moved.
  //
  // No production food bank holds such a pair today either (same read-only
  // check, 345 food banks with locations, 0 collator-equal name pairs within
  // one) -- but "no row is in that state today" is exactly the reasoning that
  // makes an untested path safe to break.
  it("breaks a collation tie exactly the way getLocationsByFoodbankId does", async () => {
    // Written as an escape, not as the character itself: a soft hyphen is
    // invisible in every editor and diff, and a paste that quietly dropped it
    // would turn this into two identical names -- which the unique index above
    // refuses, so the test would error rather than silently stop testing a tie.
    const TIED_NAME = "Ames\u00ADbury";

    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 403, foodbankId: SALISBURY, name: TIED_NAME, slug: "ames-bury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", slug: "amesbury" });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Wilton", slug: "wilton" });

    const wide = await getLocationsByFoodbankId(session, SALISBURY);
    const narrow = await getLocationsByFoodbankIdNarrow(session, SALISBURY);

    // The premise, executed rather than asserted in prose: these two really are
    // a tie the comparator cannot break, and they really are distinct rows.
    expect(TIED_NAME).not.toBe("Amesbury");
    expect(new Intl.Collator("en-US").compare(TIED_NAME, "Amesbury")).toBe(0);
    expect(names(wide)).toEqual([TIED_NAME, "Amesbury", "Wilton"]);

    expect(narrow).toEqual(wide.map(({ boundary_geojson, ...rest }) => rest));
    expect(ids(narrow)).toEqual([403, 401, 402]);
    expect(ids(narrow)).toEqual(ids(wide));
  });

  // THE BLOB'S CONTENT CHANGES NOTHING, whatever is stored. The wide function
  // returned four different values here (a polygon, NULL, '', whitespace) and
  // the narrow one has to return the identical row in all four cases -- not
  // "roughly the same", not "the same except for a stray key". This is the case
  // that would catch a projection that reintroduced the column under an alias.
  it.each([
    ["a stored polygon", '{"type":"Polygon","coordinates":[[[0,0]]]}'],
    ["NULL", null],
    ["the empty string", ""],
    ["whitespace only", "  "],
  ])("returns the identical row whether boundary_geojson holds %s", async (_label, stored) => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", boundaryGeojson: stored });

    const [wide] = await getLocationsByFoodbankId(session, SALISBURY);
    const [narrow] = await getLocationsByFoodbankIdNarrow(session, SALISBURY);

    const { boundary_geojson, ...rest } = wide!;
    expect(boundary_geojson).toBe(stored);
    expect(narrow).toEqual(rest);
  });

  // SCOPED, AND CLOSED ROWS KEPT -- both inherited from the function this
  // replaces and neither visible in a fixture of one open location. An
  // `AND is_closed = 0` bolted on here (the filter that "obviously belongs")
  // would silently delete shut branches from every markdown location list and
  // from every /api/1/foodbank/<slug>/ document, and Django's
  // `Foodbank.locations()` has no such filter (givefood/models/foodbank.py:546).
  it("returns only this food bank's locations, closed ones included", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedFoodbank({ id: WESTBURY, slug: "westbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", isClosed: 0 });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Wilton", isClosed: 1 });
    seedLocation({ id: 403, foodbankId: WESTBURY, name: "Warminster" });

    const rows = await getLocationsByFoodbankIdNarrow(session, SALISBURY);

    expect(ids(rows)).toEqual([401, 402]);
    expect(rows.map((r) => r.is_closed)).toEqual([false, true]);
  });

  // SORTED IN JS UNDER en-US, not SQLite's byte order -- the same claim
  // getLocationsByFoodbankId's own block makes, restated because this function
  // has its own `.map()` and its own sortByName call and could lose either on
  // its own. The second array is exactly what an SQL `ORDER BY name` would have
  // produced, and it is the order every markdown location page would silently
  // acquire.
  // EXPLICIT SLUGS, and they are the difference between this test proving the
  // sort and this test proving nothing. The statement is answered from
  // `loc_foodbank_slug_idx (foodbank_id, slug)`, so rows arrive in SLUG order
  // -- and seedLocation derives a slug from the name, which makes the engine's
  // own order agree with the expectation for almost any set of names anyone
  // would think to write. Mutation-tested: with derived slugs, deleting
  // sortByName from this function left this assertion GREEN. The slugs below
  // are chosen to disagree with the names, so the arriving order is Wilton,
  // amesbury Hub, Éire Centre, Bemerton Heath and only a real sort can produce
  // the expectation.
  it("sorts by name under a linguistic collation, not SQLite's byte order", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Wilton", slug: "aaa" });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "amesbury Hub", slug: "bbb" });
    seedLocation({ id: 403, foodbankId: SALISBURY, name: "Éire Centre", slug: "ccc" });
    seedLocation({ id: 404, foodbankId: SALISBURY, name: "Bemerton Heath", slug: "ddd" });

    const rows = await getLocationsByFoodbankIdNarrow(session, SALISBURY);

    // The fixture really does hand the sort something out of order to begin
    // with -- otherwise the two expectations below are satisfied by doing
    // nothing at all.
    expect(names(await getLocationsByFoodbankIdUnsorted(session, SALISBURY))).toEqual([
      "Wilton",
      "amesbury Hub",
      "Éire Centre",
      "Bemerton Heath",
    ]);
    expect(names(rows)).toEqual(["amesbury Hub", "Bemerton Heath", "Éire Centre", "Wilton"]);
    expect(names(rows)).not.toEqual(["Bemerton Heath", "Wilton", "amesbury Hub", "Éire Centre"]);
  });

  // mapLocationRowNarrow RUNS, AND ON EVERY ROW. Dropping it -- returning
  // `result.results` straight, which type-checks after a cast and reads as a
  // simplification -- leaves raw 0/1/null integers where the row type promises
  // booleans. Nothing throws; `{% if location.is_mobile %}` is still right by
  // the accident that 0 is falsy, and any consumer that writes `=== true` is
  // silently wrong. The tail row is what catches a `.map()` that lost its
  // callback after the first.
  it("coerces the four flag columns on every row it returns", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", isMobile: 0, placeHasPhoto: 1, isDonationPoint: null });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Bemerton Heath", isMobile: null });
    seedLocation({ id: 403, foodbankId: SALISBURY, name: "Coombe Bissett", isMobile: 1, placeHasPhoto: 0 });

    const rows = await getLocationsByFoodbankIdNarrow(session, SALISBURY);

    expect(rows.map((r) => r.is_mobile)).toEqual([false, null, true]);
    expect(rows.map((r) => r.place_has_photo)).toEqual([true, true, false]);
    expect(rows[0]!.is_donation_point).toBeNull();
    expect(rows.map((r) => r.is_closed)).toEqual([false, false, false]);
  });

  // Reads the VIEW, and the JOIN stays LEFT: a location whose parent row is
  // gone keeps its place with NULL parent fields rather than vanishing from
  // the API document. Same case the wide function pins.
  it("keeps a location whose parent food bank is missing", async () => {
    seedLocation({ id: 404, foodbankId: 999, name: "Orphaned Outreach" });

    const rows = await getLocationsByFoodbankIdNarrow(session, 999);

    expect(ids(rows)).toEqual([404]);
    expect(rows[0]!.foodbank_slug).toBeNull();
    expect(rows[0]!.foodbank_name).toBeNull();
  });

  // THE WHOLE REASON THE FUNCTION EXISTS, asserted on the SQL the MODULE
  // prepared rather than on a copy retyped here -- see planFor's comment for
  // why that distinction matters. A "tidy-up" back to getLocationsByFoodbankId's
  // `SELECT *` returns a superset of these columns and leaves every other test
  // in this block green while putting 2.3 MB back on the wire for canterbury.
  //
  // ZERO mentions of boundary_geojson, not two: the Flagged sibling names it
  // twice inside its has_boundary expression, and this one must not name it at
  // all. That is the assertion that separates the two projections, and it is
  // what stops a caller being quietly moved onto the wrong sibling.
  it("names its columns instead of issuing SELECT *, and never names the blob at all", async () => {
    await getLocationsByFoodbankIdNarrow(session, SALISBURY);
    await getLocationsByFoodbankId(session, SALISBURY);
    const [narrowSql, wideSql] = prepared;

    expect(narrowSql!).not.toContain("SELECT *");
    expect(narrowSql!).toContain("FROM foodbanklocation_full WHERE foodbank_id = ?");
    expect(narrowSql!.match(/boundary_geojson/g)).toBeNull();
    expect(narrowSql!).not.toContain("has_boundary");
    // THE PLAN IS UNCHANGED, asserted against the plan of the statement this
    // replaces rather than against a hardcoded string -- the same index search
    // and the same LEFT-JOIN probe of the parent, so this is bytes on the wire
    // and nothing else. (Production agrees: both spellings return `SEARCH l
    // USING INDEX loc_foodbank_slug_idx (foodbank_id=?)` then the LEFT-JOIN
    // probe, read-only against D1.)
    expect(planFor(narrowSql!.replace("?", String(SALISBURY)))).toEqual(planFor(wideSql!.replace("?", String(SALISBURY))));
    expect(planFor(narrowSql!.replace("?", String(SALISBURY)))).toEqual([
      "SEARCH l USING INDEX loc_foodbank_slug_idx (foodbank_id=?)",
      "SEARCH f USING INTEGER PRIMARY KEY (rowid=?) LEFT-JOIN",
    ]);
  });

  it("matches nothing at all when the bound food bank id is NULL", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury" });

    expect(await getLocationsByFoodbankIdNarrow(session, null as unknown as number)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getLocationsByFoodbankIdUnsorted
// ---------------------------------------------------------------------------

describe("getLocationsByFoodbankIdUnsorted", () => {
  // THE ONLY DIFFERENCE FROM getLocationsByFoodbankId IS THE SORT, and that is
  // the entire reason the second function exists: gfwfbn `geojson`'s slug
  // branch builds its own `FoodbankLocation.objects.filter(foodbank__slug =
  // slug)` (gfwfbn/views.py:237) rather than calling `foodbank.locations()`,
  // so it carries no `.order_by("name")`. Deleting one function and pointing
  // its caller at the other -- the obvious tidy-up, since the SQL is identical
  // -- would silently reorder every feature in every per-food-bank geo.json.
  // Seeded so that name order and the engine's own order genuinely differ:
  // ids, slugs and names each imply a different sequence.
  it("returns the same rows as the sorted version but does NOT name-sort them", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Wilton", slug: "a-wilton" });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Amesbury", slug: "b-amesbury" });
    seedLocation({ id: 403, foodbankId: SALISBURY, name: "Bemerton Heath", slug: "c-bemerton" });

    const unsorted = await getLocationsByFoodbankIdUnsorted(session, SALISBURY);
    const sorted = await getLocationsByFoodbankId(session, SALISBURY);

    expect(names(unsorted)).not.toEqual(["Amesbury", "Bemerton Heath", "Wilton"]);
    expect(names(sorted)).toEqual(["Amesbury", "Bemerton Heath", "Wilton"]);
    expect(asc(ids(unsorted))).toEqual([401, 402, 403]);
  });

  it("returns only the named food bank's locations", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedFoodbank({ id: WESTBURY, slug: "westbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury" });
    seedLocation({ id: 402, foodbankId: WESTBURY, name: "Warminster" });

    expect(ids(await getLocationsByFoodbankIdUnsorted(session, SALISBURY))).toEqual([401]);
  });

  // Same "no is_closed filter" behaviour as getLocationsByFoodbankId: the
  // Django queryset at gfwfbn/views.py:237 has none either, so a closed
  // location still draws its marker on that food bank's own map.
  it("includes closed locations, matching the source queryset", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", isClosed: 1 });

    expect(ids(await getLocationsByFoodbankIdUnsorted(session, SALISBURY))).toEqual([401]);
  });

  it("coerces the flag columns", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", isDonationPoint: 1, isMobile: null });

    const [row] = await getLocationsByFoodbankIdUnsorted(session, SALISBURY);

    expect(row!.is_donation_point).toBe(true);
    expect(row!.is_mobile).toBeNull();
    expect(row!.foodbank_slug).toBe("salisbury");
  });
});

// ---------------------------------------------------------------------------
// getLocationLatLngsByFoodbankId
// ---------------------------------------------------------------------------

describe("getLocationLatLngsByFoodbankId", () => {
  // RETURNS STRINGS, NOT ROWS. Both callers interpolate the result straight
  // into a URL -- mapImage.ts:110 joins them with "|" into a Google Static
  // Maps `markers` parameter, and donationPoint.ts:88 builds a Set of them to
  // refuse a donation point standing on a location. A `.map()` that lost its
  // property access would send Google the string "[object Object]" as a
  // marker, which fails as a blank map image rather than as an exception.
  it("returns the bare lat_lng strings, not row objects", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", latLng: "51.1725,-1.7825" });

    expect(await getLocationLatLngsByFoodbankId(session, SALISBURY)).toEqual(["51.1725,-1.7825"]);
  });

  it("returns only the named food bank's lat_lngs", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedFoodbank({ id: WESTBURY, slug: "westbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", latLng: "51.1725,-1.7825" });
    seedLocation({ id: 402, foodbankId: WESTBURY, name: "Warminster", latLng: "51.2050,-2.1810" });

    expect(await getLocationLatLngsByFoodbankId(session, SALISBURY)).toEqual(["51.1725,-1.7825"]);
    expect(await getLocationLatLngsByFoodbankId(session, WESTBURY)).toEqual(["51.2050,-2.1810"]);
  });

  // NO is_closed FILTER, and Django's is the same shape: donationPoint.ts's
  // duplicate check is a port of FoodbankDonationPoint.clean()
  // (models/foodbank.py:1247-1256), which compares against `locations()` --
  // all of them, closed included. Adding the filter would let an admin place a
  // donation point on top of a closed location's marker.
  it("includes closed locations", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", isClosed: 1, latLng: "51.1725,-1.7825" });

    expect(await getLocationLatLngsByFoodbankId(session, SALISBURY)).toEqual(["51.1725,-1.7825"]);
  });

  // Two locations sharing a lat_lng yield two entries. The dedupe is the
  // caller's (`new Set(...)` in donationPoint.ts:88) and mapImage.ts wants the
  // duplicates, since two markers at one point is a real thing to draw.
  it("does not deduplicate repeated lat_lngs", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", latLng: "51.1725,-1.7825" });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Amesbury Annexe", latLng: "51.1725,-1.7825" });

    expect(await getLocationLatLngsByFoodbankId(session, SALISBURY)).toEqual(["51.1725,-1.7825", "51.1725,-1.7825"]);
  });

  // Reads the BASE table, not the view -- it needs no parent field, so an
  // orphaned location still contributes its marker. Also the reason this one
  // survives if the view is ever rebuilt: it names no denormalised column.
  it("resolves against the base table, with no dependency on the parent row existing", async () => {
    seedLocation({ id: 404, foodbankId: 999, name: "Orphaned Outreach", latLng: "51.0,-1.0" });

    expect(await getLocationLatLngsByFoodbankId(session, 999)).toEqual(["51.0,-1.0"]);
  });

  it("returns an empty array for a food bank with no locations", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedFoodbank({ id: WESTBURY, slug: "westbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury" });

    expect(await getLocationLatLngsByFoodbankId(session, WESTBURY)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getAllOpenLocations
// ---------------------------------------------------------------------------

describe("getAllOpenLocations", () => {
  // The filter that keeps shut locations off gfapi2's /locations/ feed and out
  // of every unscoped geo.json. A filter that does nothing passes any test
  // that seeds only open rows, so the closed row here is the entire point.
  it("excludes closed locations", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", isClosed: 0 });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Wilton", isClosed: 1 });
    seedLocation({ id: 403, foodbankId: SALISBURY, name: "Bemerton Heath", isClosed: 0 });

    expect(asc(ids(await getAllOpenLocations(session)))).toEqual([401, 403]);
  });

  // THE LOCATION'S OWN is_closed, NOT THE PARENT'S. The ETL derives the
  // child's flag from the parent (0019's closing comment), but the queryset
  // this ports -- `FoodbankLocation.objects.filter(is_closed = False)` in
  // givefood/utils/cache.py:76 -- filters the child's column and joins nothing.
  // A "tidier" `AND f.is_closed = 0` on the view would drop open locations
  // whose parent food bank has since closed, and would also drop every
  // orphaned row, since NULL = 0 is never true.
  it("keeps an open location whose parent food bank is closed", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", isClosed: 1 });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", isClosed: 0 });

    expect(ids(await getAllOpenLocations(session))).toEqual([401]);
  });

  // UNSORTED, unlike getLocationsByFoodbankId -- the Django queryset has no
  // `.order_by()`, and the callers (buildGeojson.ts, gfapi2's locations view)
  // emit rows in whatever order arrives. Asserted as "not alphabetical" rather
  // than as an exact sequence because the row order here is the engine's scan
  // order (SQLite answers `is_closed = 0` from the partial loc_open_latlng_idx,
  // so rows come back in latitude order, not rowid order) and pinning a query
  // plan is not this function's contract. What IS its contract is that no
  // sortByName crept in: adding one would reorder every feature in the
  // national geo.json for no reason.
  it("does not sort by name", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Zeals Outreach", latitude: 51.01 });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Amesbury", latitude: 51.02 });
    seedLocation({ id: 403, foodbankId: SALISBURY, name: "Milford", latitude: 51.03 });

    const rows = await getAllOpenLocations(session);

    expect(names(rows)).not.toEqual(["Amesbury", "Milford", "Zeals Outreach"]);
    expect([...names(rows)].sort()).toEqual(["Amesbury", "Milford", "Zeals Outreach"]);
  });

  it("keeps an open location whose parent food bank is missing", async () => {
    seedLocation({ id: 404, foodbankId: 999, name: "Orphaned Outreach" });

    const rows = await getAllOpenLocations(session);

    expect(ids(rows)).toEqual([404]);
    expect(rows[0]!.foodbank_slug).toBeNull();
  });

  it("coerces the flag columns on the rows it returns", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", isDonationPoint: null, placeHasPhoto: 0 });

    const [row] = await getAllOpenLocations(session);

    expect(row!.is_closed).toBe(false);
    expect(row!.is_donation_point).toBeNull();
    expect(row!.place_has_photo).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getAllOpenLocationsFlagged -- getAllOpenLocations with the blob replaced
// by a 0/1 flag, for /api/2/locations/ and the all-items /needs/geo.json
// ---------------------------------------------------------------------------
//
// Those two routes read this whole row and NEITHER emits boundary_geojson:
// api2/locations.ts names its fields explicitly in both the json and geojson
// branches, and buildGeojson.ts passes includeBoundary=false for the
// all-items scope. Measured against production D1: 6,504,107 -> 3,037,895
// bytes of result payload (-53%) and a median 161 -> 99 ms (n=7 each,
// interleaved), over 1,962 open rows of which only 40 carry a boundary at
// all. rows_read is identical (3,924), so this is wire bytes and latency,
// not D1 billing.
//
// THE FAILURE MODES ARE ALL SILENT, and they are why this block is long:
//   * a column missing from the hand-written list vanishes from the row with
//     no error -- /api/2/locations/ just stops publishing a field.
//   * a reordering changes ~2,000 geo.json features and ~2,000 API entries.
//   * has_boundary getting the empty-string case wrong flips the service-area
//     branch on a food bank page from "map" to "no map", or back.
// Every case below therefore compares against getAllOpenLocations over the
// same fixture, or against the view's real columns read from the pragma.

describe("getAllOpenLocationsFlagged", () => {
  // THE DRIFT DETECTOR, ported from constituencies.test.ts:961-969 (the
  // header of that test explains why it exists). LOCATION_COLUMNS_NARROW in
  // locations.ts is a hand-maintained 38-name string and the view is defined
  // in a migration; those are two copies of one list and they drift -- which
  // is exactly what 0019 did to four other queries. Comparing the returned
  // row's keys against the view's ACTUAL columns means the next ALTER TABLE
  // either updates the constant or turns this red, rather than silently
  // dropping a column out of the site's largest API payload.
  it("returns every column of foodbanklocation_full except boundary_geojson, plus has_boundary", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", boundaryGeojson: '{"type":"Polygon"}' });

    const [row] = await getAllOpenLocationsFlagged(session);

    const expected = columnsOf("foodbanklocation_full")
      .filter((column) => column !== "boundary_geojson")
      .concat("has_boundary");
    expect(Object.keys(row!).sort()).toEqual(expected.sort());
    expect(Object.keys(row!)).not.toContain("boundary_geojson");
  });

  // THE PARITY CHECK: same rows, same order, same values as the SELECT * it
  // replaced -- everything except the one column neither caller reads. Ids
  // ascend while latitudes descend, so rowid order and index order are two
  // different sequences and "same order" cannot be satisfied by luck.
  it("returns the same rows, in the same order, as getAllOpenLocations minus the blob", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedFoodbank({ id: WESTBURY, slug: "westbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Zeals Outreach", latitude: 51.03, isDonationPoint: 1 });
    seedLocation({ id: 402, foodbankId: WESTBURY, name: "Amesbury", latitude: 51.02, placeHasPhoto: null });
    seedLocation({ id: 403, foodbankId: SALISBURY, name: "Milford", latitude: 51.01, boundaryGeojson: '{"type":"Polygon"}' });
    seedLocation({ id: 404, foodbankId: SALISBURY, name: "Shut Hall", latitude: 51.0, isClosed: 1 });

    const wide = await getAllOpenLocations(session);
    const flagged = await getAllOpenLocationsFlagged(session);

    expect(flagged).toEqual(
      wide.map(({ boundary_geojson, ...rest }) => ({ ...rest, has_boundary: boundary_geojson ? 1 : 0 })),
    );
    expect(ids(flagged)).toEqual(ids(wide));
    expect(flagged).toHaveLength(3);
  });

  // `(x IS NOT NULL AND x != '')` has to agree with JS/Nunjucks truthiness of
  // the raw string for EVERY stored value, because the three sites that read
  // it are a Nunjucks `not`, a Nunjucks `and` and a JS ternary. The two that
  // a naive `boundary_geojson IS NOT NULL` gets wrong are the empty string
  // (falsy in JS, NOT NULL in SQL) and, in the other direction,
  // whitespace-only (truthy in JS, and `'  ' != ''` is 1, so it agrees).
  // Production holds 40 non-empty boundaries out of 1,962 open rows; the
  // empty-string case is the one that decides whether a food bank page draws
  // a service-area map.
  it.each([
    ["a stored polygon", '{"type":"Polygon","coordinates":[[[0,0]]]}', 1],
    ["NULL", null, 0],
    ["the empty string", "", 0],
    ["whitespace only", "  ", 1],
  ])("flags %s as %o -> has_boundary %i", async (_label, stored, expected) => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", boundaryGeojson: stored });

    const [row] = await getAllOpenLocationsFlagged(session);

    expect(row!.has_boundary).toBe(expected);
    // Never null, whatever the column held -- `NULL IS NOT NULL` is 0 and
    // `0 AND x` short-circuits, so the expression cannot yield NULL.
    expect(row!.has_boundary).not.toBeNull();
  });

  // has_boundary is an INTEGER and stays one: it is NOT in
  // LOCATION_BOOLEAN_COLUMNS, deliberately. 0/1 is falsy/truthy in both JS
  // and Nunjucks exactly as the raw string was, and coercing it would be a
  // second, needless divergence from the column it stands in for.
  it("coerces the four flag columns but leaves has_boundary as 0/1", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({
      id: 401,
      foodbankId: SALISBURY,
      name: "Amesbury",
      isDonationPoint: null,
      placeHasPhoto: 0,
      boundaryGeojson: '{"type":"Polygon"}',
    });

    const [row] = await getAllOpenLocationsFlagged(session);

    expect(row!.is_closed).toBe(false);
    expect(row!.is_donation_point).toBeNull();
    expect(row!.place_has_photo).toBe(false);
    expect(row!.has_boundary).toBe(1);
    expect(typeof row!.has_boundary).toBe("number");
  });

  // TWO SURVIVORS, NOT ONE -- the same `results.slice(0, 1)` mutant
  // getAllOpenLocationSlugs's own test exists to kill. It would cut
  // /api/2/locations/ from ~1,960 entries to one and still return a 200.
  it("excludes closed locations and returns every open one, not just the first", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", isClosed: 0, latitude: 51.01 });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Wilton", isClosed: 1, latitude: 51.02 });
    seedLocation({ id: 403, foodbankId: SALISBURY, name: "Bemerton Heath", isClosed: 0, latitude: 51.03 });

    expect(asc(ids(await getAllOpenLocationsFlagged(session)))).toEqual([401, 403]);
  });

  // Reads the VIEW, and the JOIN stays LEFT: a location whose parent row is
  // gone keeps its place in the feed with NULL parent fields, rather than
  // disappearing. Same case getAllOpenLocations pins above.
  it("keeps an open location whose parent food bank is missing", async () => {
    seedLocation({ id: 404, foodbankId: 999, name: "Orphaned Outreach" });

    const rows = await getAllOpenLocationsFlagged(session);

    expect(ids(rows)).toEqual([404]);
    expect(rows[0]!.foodbank_slug).toBeNull();
    expect(rows[0]!.has_boundary).toBe(0);
  });

  // The whole reason the function exists, asserted on the SQL the MODULE
  // prepared rather than on a copy retyped here -- see planFor's comment
  // above for why that distinction matters. A "tidy-up" back to `SELECT *`
  // would leave every other test in this block green.
  it("names its columns instead of issuing SELECT *, and never names the blob", async () => {
    await getAllOpenLocationsFlagged(session);

    const sql = prepared[0]!;
    expect(sql).not.toContain("SELECT *");
    expect(sql).toContain("FROM foodbanklocation_full WHERE is_closed = 0");
    // boundary_geojson appears ONLY inside the has_boundary expression, never
    // as a selected column of its own.
    expect(sql.match(/boundary_geojson/g)).toEqual(["boundary_geojson", "boundary_geojson"]);
    expect(sql).toContain("(boundary_geojson IS NOT NULL AND boundary_geojson != '') AS has_boundary");
  });
});

// ---------------------------------------------------------------------------
// getAllOpenLocationSlugs / getAllOpenLocationSlugsWithNames
// ---------------------------------------------------------------------------

describe("getAllOpenLocationSlugs", () => {
  // TWO COLUMNS, NOT `SELECT *`. PLAN.md's hard rule -- "nothing in the
  // codebase issues SELECT * on parliamentaryconstituency or
  // foodbanklocation" -- exists specifically because boundary_geojson is a
  // large TEXT blob on this table, and the sitemap reads ~2,000 rows to build
  // ~2,000 <loc> elements out of two short strings each. Reusing
  // getAllOpenLocations here would still produce a correct sitemap and only
  // change the bill, which is exactly why the projection is asserted as an
  // exact key set rather than by spot-checking a field.
  it("projects exactly foodbank_slug and slug", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", slug: "amesbury", boundaryGeojson: '{"type":"Polygon"}' });

    const rows = await getAllOpenLocationSlugs(session);

    expect(rows).toEqual([{ foodbank_slug: "salisbury", slug: "amesbury" }]);
    expect(Object.keys(rows[0]!).sort()).toEqual(["foodbank_slug", "slug"]);
  });

  // TWO SURVIVORS, NOT ONE. Seeding a single open row makes "excludes the
  // closed one" and "returns only the first row" indistinguishable, and the
  // second is a mutant this suite used to let through: `results.slice(0, 1)`
  // here passed every assertion in the file while cutting the XML sitemap from
  // ~2,000 URLs to one. Latitudes ascend with the ids so the expectation holds
  // whether SQLite scans by rowid or through the partial loc_open_latlng_idx.
  it("excludes closed locations and returns every open one, not just the first", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", slug: "amesbury", isClosed: 0, latitude: 51.01 });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Wilton", slug: "wilton", isClosed: 1, latitude: 51.02 });
    seedLocation({ id: 403, foodbankId: SALISBURY, name: "Bemerton Heath", slug: "bemerton", isClosed: 0, latitude: 51.03 });

    expect(await getAllOpenLocationSlugs(session)).toEqual([
      { foodbank_slug: "salisbury", slug: "amesbury" },
      { foodbank_slug: "salisbury", slug: "bemerton" },
    ]);
  });

  // Reads the VIEW, so foodbank_slug is the parent's CURRENT slug. Before 0019
  // it was a copy written at the child's last save, which is how production
  // came to hold 24 locations whose sitemap URL pointed at a food bank slug
  // that no longer existed -- a 404 in the sitemap, invisible except to
  // Google.
  it("emits the parent's current slug, not a copy taken when the location was saved", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", slug: "amesbury" });

    db.prepare("UPDATE foodbank SET slug = ? WHERE id = ?").run("salisbury-and-district", SALISBURY);

    expect(await getAllOpenLocationSlugs(session)).toEqual([{ foodbank_slug: "salisbury-and-district", slug: "amesbury" }]);
  });

  // SUSPECT, PINNED AS-IS. The return type declares `foodbank_slug: string`,
  // but the view's LEFT JOIN yields null for an orphaned location and this
  // function casts rather than maps, so nothing converts or filters it.
  // sitemaps.ts:55 then interpolates that null straight into a URL and the
  // sitemap gains a `/needs/at/null/amesbury/` entry. Unreachable in Postgres,
  // where a foreign key forbade the orphan; reachable in D1, which declares
  // none (PLAN.md §4.5). Recorded rather than fixed, per the
  // pin-current-behaviour rule.
  it("returns a null foodbank_slug for an orphaned location, contradicting its own type", async () => {
    seedLocation({ id: 404, foodbankId: 999, name: "Orphaned Outreach", slug: "orphaned-outreach" });

    expect(await getAllOpenLocationSlugs(session)).toEqual([{ foodbank_slug: null, slug: "orphaned-outreach" }]);
  });

  // No mapLocationRow, on purpose -- there are no boolean columns in a
  // two-column projection to coerce, and the raw D1 rows go straight to the
  // template. Pinned so a well-meaning `.map(mapLocationRow)` added "for
  // consistency" fails here rather than quietly adding four null flag keys to
  // 2,000 sitemap rows.
  it("returns raw rows with no invented flag keys", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", slug: "amesbury" });

    expect(Object.keys((await getAllOpenLocationSlugs(session))[0]!)).not.toContain("is_closed");
  });
});

describe("getAllOpenLocationSlugsWithNames", () => {
  // Three columns, not two and not all thirty-nine: sitemap.md needs the name
  // as link text, which the XML sitemap has no use for. Same narrow-projection
  // reasoning as above -- and the reason there are two functions rather than
  // one, since widening the cheaper one would pull an extra column through
  // ~2,000 rows on the hotter of the two routes.
  it("projects exactly foodbank_slug, slug and name", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", slug: "amesbury" });

    const rows = await getAllOpenLocationSlugsWithNames(session);

    expect(rows).toEqual([{ foodbank_slug: "salisbury", slug: "amesbury", name: "Amesbury" }]);
  });

  // Same two-survivor seed as the XML sitemap's, and for the same mutant: a
  // `slice(0, 1)` here truncated sitemap.md to a single link and no assertion
  // in this file noticed.
  it("excludes closed locations and returns every open one, not just the first", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", slug: "amesbury", isClosed: 0, latitude: 51.01 });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Wilton", slug: "wilton", isClosed: 1, latitude: 51.02 });
    seedLocation({ id: 403, foodbankId: SALISBURY, name: "Bemerton Heath", slug: "bemerton", isClosed: 0, latitude: 51.03 });

    expect(await getAllOpenLocationSlugsWithNames(session)).toEqual([
      { foodbank_slug: "salisbury", slug: "amesbury", name: "Amesbury" },
      { foodbank_slug: "salisbury", slug: "bemerton", name: "Bemerton Heath" },
    ]);
  });

  // UNSORTED, like every other feed function here. The markdown sitemap lists
  // locations in arrival order; a sortByName added here and not to
  // getAllOpenLocationSlugs would silently desynchronise the two sitemaps,
  // which is the kind of difference nobody reads a diff for.
  it("does not sort by name", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Zeals Outreach", latitude: 51.01 });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Amesbury", latitude: 51.02 });
    seedLocation({ id: 403, foodbankId: SALISBURY, name: "Milford", latitude: 51.03 });

    expect(names(await getAllOpenLocationSlugsWithNames(session))).not.toEqual(["Amesbury", "Milford", "Zeals Outreach"]);
  });
});

// ---------------------------------------------------------------------------
// getOpenDonationPointLocations
// ---------------------------------------------------------------------------

describe("getOpenDonationPointLocations", () => {
  // Both halves of the predicate matter and each hides the other's absence, so
  // the seed carries a closed donation-point location AND an open
  // non-donation-point one. Ports
  // `FoodbankLocation.objects.filter(is_closed = False,
  // is_donation_point = True)` (givefood/utils/geo.py:423) -- the candidate set
  // for the location branch of donationpoint_search.
  // TWO ROWS SURVIVE THE FILTER, deliberately. With a single survivor this
  // test could not tell a working WHERE clause from `results.slice(0, 1)` --
  // a mutant that passed the whole file and would have cut the
  // donationpoint_search candidate set to one location nationwide, silently
  // returning "no donation points near you" everywhere but one street.
  it("returns only open locations that are donation points, and all of them", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", isClosed: 0, isDonationPoint: 1, latitude: 51.01 });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Wilton", isClosed: 1, isDonationPoint: 1, latitude: 51.02 });
    seedLocation({ id: 403, foodbankId: SALISBURY, name: "Bemerton Heath", isClosed: 0, isDonationPoint: 0, latitude: 51.03 });
    seedLocation({ id: 404, foodbankId: SALISBURY, name: "Coombe Bissett", isClosed: 0, isDonationPoint: 1, latitude: 51.04 });

    expect(asc(ids(await getOpenDonationPointLocations(session)))).toEqual([401, 404]);
  });

  // THE NULL CASE, WHICH IS THE COMMON ONE. is_donation_point is NULL on 567
  // of 1,972 production rows despite the model declaring it NOT NULL
  // (0001_core.sql:71). `is_donation_point = 1` drops those under SQLite's
  // three-valued logic, which is what Django's `is_donation_point=True` did on
  // Postgres too. A "defensive" rewrite to `is_donation_point IS NOT 0` or
  // `!= 0` would silently add ~28% of every location in the country to the
  // donation-point search results.
  it("excludes rows whose is_donation_point is NULL, not just those set to 0", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", isDonationPoint: 1 });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Wilton", isDonationPoint: null });
    seedLocation({ id: 403, foodbankId: SALISBURY, name: "Bemerton Heath", isDonationPoint: 0 });

    expect(ids(await getOpenDonationPointLocations(session))).toEqual([401]);
  });

  it("coerces the flag columns and carries the parent's fields", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", isDonationPoint: 1, isMobile: null });

    const [row] = await getOpenDonationPointLocations(session);

    expect(row!.is_donation_point).toBe(true);
    expect(row!.is_closed).toBe(false);
    expect(row!.is_mobile).toBeNull();
    expect(row!.foodbank_slug).toBe("salisbury");
  });
});

// ---------------------------------------------------------------------------
// getOpenLocationCoordinates
// ---------------------------------------------------------------------------

describe("getOpenLocationCoordinates", () => {
  // THREE COLUMNS, NOT `SELECT *`. WP 2.5's measurement was that fetching
  // every column of every open row -- ~2,000 locations, 39 columns each, one
  // of them a boundary GeoJSON blob -- to rank by distance and then discard
  // all but 20 dominated the cost of every uncached search. If someone
  // "simplifies" this to reuse getAllOpenLocations the site still works and
  // only the bill changes, which is why the projection is asserted as an exact
  // key set.
  it("projects exactly id, latitude and longitude", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", latitude: 51.1725, longitude: -1.7825 });

    const [row] = await getOpenLocationCoordinates(session);

    expect(Object.keys(row!).sort()).toEqual(["id", "latitude", "longitude"]);
    expect(row).toEqual({ id: 401, latitude: 51.1725, longitude: -1.7825 });
  });

  // Two open rows, one closed. The second open row is what separates a live
  // `is_closed = 0` from `queryCoordinates` returning `results.slice(0, 1)` --
  // and that mutant survived this file, leaving nearest() a candidate set of
  // one location for the entire country. Every search result would still
  // render, just with the wrong locations in it.
  it("excludes closed locations but keeps every open one in the candidate set", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", isClosed: 0, latitude: 51.01 });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Wilton", isClosed: 1, latitude: 51.02 });
    seedLocation({ id: 403, foodbankId: SALISBURY, name: "Bemerton Heath", isClosed: 0, latitude: 51.03 });

    expect(asc(ids(await getOpenLocationCoordinates(session)))).toEqual([401, 403]);
  });

  // The comment on this function claims it is "covered entirely by
  // loc_open_latlng_idx". That is a claim about a query plan, so it is checked
  // by asking the engine for the plan rather than by believing the comment.
  // D1 is SQLite, and the index is the partial `(latitude, longitude) WHERE
  // is_closed = 0` from 0001_core.sql:80 -- add a column to this SELECT and
  // the plan stops saying COVERING, at which point the query starts touching
  // the table (boundary_geojson blob and all) for every open location on every
  // uncached search.
  //
  // THE PLAN IS TAKEN FROM prepared[0], i.e. from the statement this function
  // really issued. An earlier version of this test planned a hand-typed copy
  // of the SQL, which meant the mutant that mattered -- swapping
  // foodbanklocation for foodbanklocation_full, whose LEFT JOIN cannot be
  // covered by any index on the child -- passed it untouched, along with every
  // other assertion in this file, because the view returns identical rows.
  it("is answered as a covering index scan of the statement it actually issues", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury" });

    await getOpenLocationCoordinates(session);

    expect(planFor(prepared[0]!)).toEqual(["SCAN foodbanklocation USING COVERING INDEX loc_open_latlng_idx"]);
  });

  // SUSPECT, PINNED AS-IS. latitude/longitude are NULLABLE (0001_core.sql:64)
  // but CoordinateRow declares them `number`, and this query has no
  // `latitude IS NOT NULL` clause -- so an open location that has never been
  // geocoded reaches nearest() as {latitude: null}. JS coerces null to 0 in the
  // haversine arithmetic, so it ranks as if it stood at 0°N 0°E, ~5,000 km off
  // Salisbury: never a winner, never an error, never visible. The identical
  // gap exists on the donation-point side.
  it("returns open rows with NULL coordinates, contradicting CoordinateRow's types", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Ungeocoded Hub", latitude: null, longitude: null });

    expect(await getOpenLocationCoordinates(session)).toEqual([{ id: 401, latitude: null, longitude: null }]);
  });

  // Reads the BASE table, not the view -- the join would defeat the covering
  // index entirely (the plan for the same SELECT against foodbanklocation_full
  // adds a SEARCH on foodbank per row), and no parent field is wanted here.
  it("includes orphaned locations, since it never consults the parent", async () => {
    seedLocation({ id: 404, foodbankId: 999, name: "Orphaned Outreach", latitude: 51.5, longitude: -0.1 });

    expect(await getOpenLocationCoordinates(session)).toEqual([{ id: 404, latitude: 51.5, longitude: -0.1 }]);
  });
});

// ---------------------------------------------------------------------------
// getOpenDonationPointLocationCoordinates
// ---------------------------------------------------------------------------

describe("getOpenDonationPointLocationCoordinates", () => {
  // Two rows survive both predicates, for the same reason as the plain
  // coordinate query: one survivor cannot distinguish a working WHERE clause
  // from a truncating `.slice(0, 1)`. The exact-object assertion stays, since
  // it is what pins the three-column projection.
  it("projects exactly id, latitude and longitude for every open donation-point location", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", isDonationPoint: 1, latitude: 51.1725, longitude: -1.7825 });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Wilton", isDonationPoint: 1, isClosed: 1, latitude: 51.08 });
    seedLocation({ id: 403, foodbankId: SALISBURY, name: "Bemerton Heath", isDonationPoint: 0, latitude: 51.09 });
    seedLocation({ id: 404, foodbankId: SALISBURY, name: "Coombe Bissett", isDonationPoint: 1, latitude: 51.21, longitude: -1.75 });

    const rows = await getOpenDonationPointLocationCoordinates(session);

    expect(asc(ids(rows))).toEqual([401, 404]);
    expect(rows.find((r) => r.id === 401)).toEqual({ id: 401, latitude: 51.1725, longitude: -1.7825 });
  });

  // Same NULL exclusion as getOpenDonationPointLocations, asserted separately
  // because these are two independent statements: the cheap candidate set and
  // the full-row fetch must agree about which rows are donation points, or
  // ranking would score a row the fetch then cannot return.
  it("excludes rows whose is_donation_point is NULL", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", isDonationPoint: 1, latitude: 51.01 });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Wilton", isDonationPoint: null, latitude: 51.02 });

    expect(ids(await getOpenDonationPointLocationCoordinates(session))).toEqual([401]);
  });

  // The second half of the same query-plan claim: a SEPARATE partial index
  // (0001_core.sql:81-82) exists for exactly this two-predicate candidate set.
  // If the WHERE clause is ever reordered or a predicate reworded, SQLite
  // silently falls back to loc_open_latlng_idx plus a table lookup per row --
  // still correct, quietly slower on every donation-point search.
  it("is answered as a covering scan of the two-predicate partial index", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", isDonationPoint: 1 });

    await getOpenDonationPointLocationCoordinates(session);

    expect(planFor(prepared[0]!)).toEqual(["SCAN foodbanklocation USING COVERING INDEX loc_open_dp_latlng_idx"]);
  });
});

// ---------------------------------------------------------------------------
// getOpenLocationCoordinatesWithFoodbankId
// ---------------------------------------------------------------------------

describe("getOpenLocationCoordinatesWithFoodbankId", () => {
  // FOUR COLUMNS. foodbank_id is here because "does this location's food bank
  // need this category" can only be answered against the location's PARENT,
  // not the location row itself (PLAN.md §4.8.5). Asserted as an exact key set
  // for the same reason as the three-column version: widening it to `SELECT *`
  // would work, and only the bill would change.
  it("projects exactly id, latitude, longitude and foodbank_id", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", latitude: 51.1725, longitude: -1.7825 });

    const rows = await getOpenLocationCoordinatesWithFoodbankId(session);

    expect(rows).toEqual([{ id: 401, latitude: 51.1725, longitude: -1.7825, foodbank_id: SALISBURY }]);
  });

  // The foodbank_id must be the location's own parent, not a constant or the
  // location's id -- findLocationsByCategory.ts looks each one up in a map of
  // "food banks needing this category", so a wrong id here returns the wrong
  // food banks' locations with no error anywhere.
  it("carries each location's own parent id across several food banks", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedFoodbank({ id: WESTBURY, slug: "westbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", latitude: 51.01 });
    seedLocation({ id: 402, foodbankId: WESTBURY, name: "Warminster", latitude: 51.02 });

    const byId = new Map((await getOpenLocationCoordinatesWithFoodbankId(session)).map((r) => [r.id, r.foodbank_id]));

    expect(byId.get(401)).toBe(SALISBURY);
    expect(byId.get(402)).toBe(WESTBURY);
  });

  it("excludes closed locations", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", isClosed: 0, latitude: 51.01 });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Wilton", isClosed: 1, latitude: 51.02 });

    expect(ids(await getOpenLocationCoordinatesWithFoodbankId(session))).toEqual([401]);
  });

  // The function's own comment states this is "not a covering-index scan the
  // way the plain coordinate query is (foodbank_id isn't in
  // loc_open_latlng_idx)". Executed rather than believed, and asserted as the
  // exact plan so that the day someone adds foodbank_id to that index -- which
  // WOULD make it covering -- this test says so instead of the comment quietly
  // becoming false.
  it("still uses the partial index but is NOT a covering scan", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury" });

    await getOpenLocationCoordinatesWithFoodbankId(session);
    const plan = planFor(prepared[0]!);

    expect(plan).toEqual(["SCAN foodbanklocation USING INDEX loc_open_latlng_idx"]);
    expect(plan[0]).not.toContain("COVERING");
  });
});

// ---------------------------------------------------------------------------
// hasServiceArea
// ---------------------------------------------------------------------------

// A real service-area boundary is a GeoJSON string; only its emptiness is
// tested by the query, so the shape here is short but structurally honest.
const BOUNDARY = '{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[-1.8,51.0],[-1.7,51.0],[-1.7,51.1],[-1.8,51.0]]]}}';

describe("hasServiceArea", () => {
  it("is true when the food bank has a location with a boundary, false when it has none", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedFoodbank({ id: WESTBURY, slug: "westbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", boundaryGeojson: BOUNDARY });
    seedLocation({ id: 402, foodbankId: WESTBURY, name: "Warminster", boundaryGeojson: null });

    expect(await hasServiceArea(session, SALISBURY)).toBe(true);
    expect(await hasServiceArea(session, WESTBURY)).toBe(false);
  });

  // BOTH HALVES OF THE PREDICATE, EACH SEEDED SEPARATELY. Django's queryset is
  // `.exclude(boundary_geojson__isnull = True).exclude(boundary_geojson = '')`
  // (models/foodbank.py:299) -- two exclusions, because the column holds both.
  // Drop the `!= ''` half and a location whose boundary was cleared to an
  // empty string in the admin still claims a service area, and
  // /needs/at/<slug>/ renders a "Service area" map that draws nothing.
  it("does not count an empty-string boundary as a service area", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", boundaryGeojson: "" });

    expect(await hasServiceArea(session, SALISBURY)).toBe(false);
  });

  // The mirror: drop the IS NOT NULL half and SQLite's `'' != NULL` is UNKNOWN
  // rather than true, so a NULL row is excluded anyway -- meaning THAT mutant
  // is invisible from the outside. Seeded together so the count is 1, not 2:
  // the function reports "at least one", and a rewrite that counted NULLs as
  // boundaries would be caught by the empty-string case above.
  it("counts only the locations that really have a boundary", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", boundaryGeojson: BOUNDARY });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Wilton", boundaryGeojson: null });
    seedLocation({ id: 403, foodbankId: SALISBURY, name: "Bemerton Heath", boundaryGeojson: "" });

    const row = db
      .prepare("SELECT COUNT(*) AS n FROM foodbanklocation WHERE foodbank_id = ? AND boundary_geojson IS NOT NULL AND boundary_geojson != ''")
      .get(SALISBURY) as { n: number };

    expect(row.n).toBe(1);
    expect(await hasServiceArea(session, SALISBURY)).toBe(true);
  });

  // Scoped to the food bank. Without the foodbank_id predicate the first
  // service area anywhere in the country would give every food bank on the
  // site a service-area map -- 1,071 pages wrong, no error.
  it("does not count another food bank's boundary", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedFoodbank({ id: WESTBURY, slug: "westbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", boundaryGeojson: BOUNDARY });

    expect(await hasServiceArea(session, WESTBURY)).toBe(false);
  });

  // NO is_closed FILTER, matching Django's `.filter(foodbank = self)` exactly:
  // a closed location's boundary still counts. That is the ported behaviour,
  // not an oversight -- the flag it feeds is "this food bank has a service-area
  // map to show", and the map still draws.
  it("counts a CLOSED location's boundary, matching the Django queryset", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", isClosed: 1, boundaryGeojson: BOUNDARY });

    expect(await hasServiceArea(session, SALISBURY)).toBe(true);
  });

  it("is false for a food bank with no locations at all", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });

    expect(await hasServiceArea(session, SALISBURY)).toBe(false);
  });

  // Django's has_service_area() opens with `if self.no_locations == 0: return
  // False` (models/foodbank.py:296-298), a short-circuit this function does NOT
  // carry -- it needs the parent's cached counter and this one is given only an
  // id. It lives with whoever holds that counter: since github #52 item 3 that
  // is foodbank.ts's getFoodbankBySlugWithServiceArea, whose slug-keyed twin of
  // the statement below is the spelling all three WFBN page routes now use.
  // Pinned here so the split stays deliberate and visible: called directly on a
  // food bank whose cached no_locations is a stale 0, this function answers
  // from the rows and says true, where Django -- and that other spelling --
  // would have said false.
  it("answers from the rows, not from the parent's cached no_locations count", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", boundaryGeojson: BOUNDARY });

    expect(
      (db.prepare("SELECT no_locations AS n FROM foodbank WHERE id = ?").get(SALISBURY) as { n: number }).n,
    ).toBe(0);
    expect(await hasServiceArea(session, SALISBURY)).toBe(true);
  });

  // Returns a real boolean, not the count row SQLite hands back. The template
  // reads `has_service_area` as a `{% if %}` and the API serialises it into
  // JSON, where a `{n: 1}` would render as an object.
  it("returns a boolean rather than the count", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", boundaryGeojson: BOUNDARY });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Wilton", boundaryGeojson: BOUNDARY });

    expect(await hasServiceArea(session, SALISBURY)).toBe(true);
    expect(await hasServiceArea(session, WESTBURY)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getLocationsByIds
// ---------------------------------------------------------------------------

describe("getLocationsByIds", () => {
  // No ids means no statement -- not a statement that matches nothing. Both
  // return [], so the only way to tell them apart is to watch what was
  // prepared. Worth pinning because search issues this call on every request
  // whose 20 nearest results happen to be all food banks and no locations,
  // which is common outside cities. An `IN ()` with no placeholders is also a
  // syntax error on some engines, so the guard is load-bearing, not just
  // thrifty.
  it("issues no SQL at all for an empty id list", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury" });

    expect(await getLocationsByIds(session, [])).toEqual([]);
    expect(prepared).toEqual([]);
  });

  // THE REASON THIS FUNCTION RE-ORDERS IN JS. The ids arrive already ranked by
  // distance from nearest(), and `WHERE id IN (...)` gives no ordering
  // guarantee whatsoever -- SQLite here returns them in rowid order, i.e.
  // ascending id. Returning the engine's order would silently re-sort the
  // search results page by database id, which is the order rows were imported
  // in: the nearest food bank would stop being first and nothing would throw.
  it("returns rows in the caller's id order, not the table's", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury" });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Wilton" });
    seedLocation({ id: 403, foodbankId: SALISBURY, name: "Bemerton Heath" });

    expect(ids(await getLocationsByIds(session, [403, 401, 402]))).toEqual([403, 401, 402]);
    expect(ids(await getLocationsByIds(session, [402, 403, 401]))).toEqual([402, 403, 401]);
  });

  // NOT NAME-SORTED either, which is a different claim from the one above: the
  // ids are already in distance order, and a sortByName here -- the habit this
  // package has everywhere else -- would alphabetise the search results page.
  it("does not re-sort the ranked ids by name", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Zeals Outreach" });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Amesbury" });

    expect(names(await getLocationsByIds(session, [401, 402]))).toEqual(["Zeals Outreach", "Amesbury"]);
  });

  // A ranked id whose row has since been deleted is dropped, not returned as
  // an undefined hole -- the callers build a Map from the result and look each
  // ranked id up again, so a hole here would become a `Cannot read properties
  // of undefined` on the results page.
  it("drops ids with no matching row rather than returning holes", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury" });

    expect(ids(await getLocationsByIds(session, [401, 999]))).toEqual([401]);
    expect(await getLocationsByIds(session, [998, 999])).toEqual([]);
  });

  // A duplicated id yields the row twice, because the re-ordering maps over
  // the CALLER's list rather than over the query's results. nearest() cannot
  // produce duplicates, so this is latent rather than live; pinned because it
  // is the visible difference between mapping the input and mapping the
  // output, and a future caller passing a concatenated list would get silent
  // duplicates rather than a dedupe.
  it("repeats a row when its id appears twice in the request", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury" });

    expect(ids(await getLocationsByIds(session, [401, 401]))).toEqual([401, 401]);
  });

  // NO is_closed FILTER: the ids came from a candidate set that already
  // filtered on it, and re-filtering here would be dead weight -- but it also
  // means this function will happily return a closed location if handed its
  // id. Pinned so the division of labour between the ranking query and the
  // fetch is a decision on record rather than an omission.
  it("returns a closed location when explicitly asked for it by id", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", isClosed: 1 });

    expect(ids(await getLocationsByIds(session, [401]))).toEqual([401]);
  });

  it("maps the flag columns and carries the parent's fields", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", isDonationPoint: 1, isMobile: null });

    const [row] = await getLocationsByIds(session, [401]);

    expect(row!.is_donation_point).toBe(true);
    expect(row!.is_mobile).toBeNull();
    expect(row!.foodbank_slug).toBe("salisbury");
  });

  // D1's 100-BOUND-PARAMETER LIMIT. This builds one placeholder per id with no
  // chunking, so the statement's parameter count IS the caller's list length.
  // 100 is D1's documented cap and is fine.
  it("builds a single statement at D1's 100-parameter limit", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    const wanted: number[] = [];
    for (let i = 0; i < 100; i++) {
      seedLocation({ id: 1000 + i, foodbankId: SALISBURY, name: `Outreach ${String(i).padStart(3, "0")}` });
      wanted.push(1000 + i);
    }

    const rows = await getLocationsByIds(session, wanted);

    // The ids, not just the count: a length check alone would pass for any 100
    // rows in any order, and the whole contract of this function is that the
    // caller's distance ranking survives the round trip at full width too.
    expect(ids(rows)).toEqual(wanted);
    expect(prepared).toHaveLength(1);
    expect((prepared[0]!.match(/\?/g) ?? []).length).toBe(100);
  });

  // ...AND OVER IT. SUSPECT, PINNED AS-IS. node:sqlite's own limit is 32,766,
  // so 150 ids succeed here; D1 would reject the statement outright with
  // "too many SQL variables". It is unreachable today -- the callers
  // (findDonationpoints.ts:70, findLocationsByCategory.ts:87) pass at most the
  // 20 survivors of nearest() -- but nothing in the signature says so, and
  // needAdmin.ts:315 chunks at 90 for exactly this reason. Asserted as what
  // the code does, with the divergence between the two engines named, rather
  // than as a red test for the chunking it does not have.
  it("builds a 150-parameter statement over D1's limit, which only this engine accepts", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    const wanted: number[] = [];
    for (let i = 0; i < 150; i++) {
      seedLocation({ id: 1000 + i, foodbankId: SALISBURY, name: `Outreach ${String(i).padStart(3, "0")}` });
      wanted.push(1000 + i);
    }

    const rows = await getLocationsByIds(session, wanted);

    // Asserted as the ids in order, so a "helpful" chunk-and-concatenate added
    // later has to preserve the ranking across chunk boundaries to pass -- a
    // 90-id chunker that returned chunk order rather than caller order would
    // otherwise still hit 150 rows.
    expect(ids(rows)).toEqual(wanted);
    expect(prepared).toHaveLength(1);
    expect((prepared[0]!.match(/\?/g) ?? []).length).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// getFoodbankLocationBySlugs
// ---------------------------------------------------------------------------

describe("getFoodbankLocationBySlugs", () => {
  // THE BIND ORDER, WHICH IS THE ONE THING THAT CANNOT BE SEEN BY READING.
  // The signature takes (foodbankSlug, locationSlug); the statement reads
  // `WHERE slug = ? AND foodbank_slug = ?` and therefore binds them the other
  // way round. The seed is deliberately palindromic -- a food bank "salisbury"
  // with a location "amesbury", and a food bank "amesbury" with a location
  // "salisbury" -- so a swapped bind returns the WRONG ROW rather than no row,
  // which is the failure a null-only test would miss entirely.
  it("binds the location slug and the food bank slug the right way round", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedFoodbank({ id: WESTBURY, slug: "amesbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury Hub", slug: "amesbury" });
    seedLocation({ id: 402, foodbankId: WESTBURY, name: "Salisbury Hub", slug: "salisbury" });

    expect((await getFoodbankLocationBySlugs(session, "salisbury", "amesbury"))!.id).toBe(401);
    expect((await getFoodbankLocationBySlugs(session, "amesbury", "salisbury"))!.id).toBe(402);
  });

  // Location slugs are unique only WITHIN a food bank (loc_foodbank_slug_idx
  // is NOT unique, and dozens of food banks have a "city-centre"). The pair is
  // the key; on the slug alone this returns whichever row the scan reaches
  // first, so /needs/at/westbury/city-centre/ would serve Salisbury's location.
  // Two same-slugged rows under different parents is the seed that makes a
  // dropped foodbank_slug predicate fail rather than pass.
  it("scopes the location slug to its parent food bank", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedFoodbank({ id: WESTBURY, slug: "westbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Salisbury City Centre", slug: "city-centre" });
    seedLocation({ id: 402, foodbankId: WESTBURY, name: "Westbury City Centre", slug: "city-centre" });

    expect((await getFoodbankLocationBySlugs(session, "salisbury", "city-centre"))!.id).toBe(401);
    expect((await getFoodbankLocationBySlugs(session, "westbury", "city-centre"))!.id).toBe(402);
  });

  it("returns null when the location exists but under another food bank", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedFoodbank({ id: WESTBURY, slug: "westbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", slug: "amesbury" });

    expect(await getFoodbankLocationBySlugs(session, "westbury", "amesbury")).toBeNull();
  });

  // foodbank_slug in the WHERE now resolves through the view's join, so this
  // matches the parent's CURRENT slug. Before 0019 it matched a copy written
  // at the child's last save, which is how production came to hold locations
  // findable only at a URL that no longer existed. Renaming the parent must
  // move the child's URL with it, in both directions.
  it("matches the parent's current slug, not a copy taken when the location was saved", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", slug: "amesbury" });

    db.prepare("UPDATE foodbank SET slug = ? WHERE id = ?").run("salisbury-and-district", SALISBURY);

    expect(await getFoodbankLocationBySlugs(session, "salisbury", "amesbury")).toBeNull();
    expect((await getFoodbankLocationBySlugs(session, "salisbury-and-district", "amesbury"))!.id).toBe(401);
  });

  it("returns null for an unknown location slug", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", slug: "amesbury" });

    expect(await getFoodbankLocationBySlugs(session, "salisbury", "wilton")).toBeNull();
  });

  // NO is_closed FILTER: a closed location keeps its own page and its own
  // geo.json, which is what the admin needs (foodbankLocation.ts:31 loads the
  // row it is about to edit through this function -- filtering closed rows
  // would make a closed location uneditable, and therefore unreopenable).
  it("finds a CLOSED location, which the admin edit form depends on", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", slug: "amesbury", isClosed: 1 });

    const row = await getFoodbankLocationBySlugs(session, "salisbury", "amesbury");

    expect(row!.id).toBe(401);
    expect(row!.is_closed).toBe(true);
  });

  // The single row goes through mapLocationRow, unlike the raw `.first()`
  // results elsewhere in this package -- the location detail page reads
  // `location.is_mobile` and the admin form checkboxes read all four flags
  // directly.
  it("maps the flag columns on the single row it returns", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({
      id: 401,
      foodbankId: SALISBURY,
      name: "Amesbury",
      slug: "amesbury",
      isDonationPoint: 1,
      isMobile: null,
      placeHasPhoto: 0,
    });

    const row = (await getFoodbankLocationBySlugs(session, "salisbury", "amesbury"))!;

    expect(row.is_donation_point).toBe(true);
    expect(row.is_mobile).toBeNull();
    expect(row.place_has_photo).toBe(false);
    expect(row.foodbank_email).toBe("info@salisbury.foodbank.org.uk");
  });

  // An orphaned location has a NULL foodbank_slug, and `NULL = ?` is never
  // true for any bound value -- so it is unreachable by URL entirely, rather
  // than reachable at some accidental slug. Worth pinning because it is the
  // three-valued-logic case doing something desirable for once.
  //
  // THE NULL BIND IS THE MUTANT-KILLER. `=` and `IS` are indistinguishable
  // until one side is NULL: swap the statement to the null-safe
  // `foodbank_slug IS ?` -- the spelling locationsAdmin.ts is required to use
  // one file away, so the habit is right there -- and a caller reaching here
  // with a null slug would be handed every orphaned location in the database,
  // one arbitrary row at a time. That is the same `= ?` / `IS ?` pair that
  // this repo already has a live bug class around, pointing the other way.
  it("cannot find an orphaned location under any food bank slug, NULL included", async () => {
    seedLocation({ id: 404, foodbankId: 999, name: "Orphaned Outreach", slug: "orphaned-outreach" });

    expect(await getFoodbankLocationBySlugs(session, "salisbury", "orphaned-outreach")).toBeNull();
    expect(await getFoodbankLocationBySlugs(session, "", "orphaned-outreach")).toBeNull();
    expect(await getFoodbankLocationBySlugs(session, null as unknown as string, "orphaned-outreach")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getOpenLocationsByConstituencyId
// ---------------------------------------------------------------------------

describe("getOpenLocationsByConstituencyId", () => {
  // Both halves of the predicate matter and each hides the other's absence:
  // seed a closed location inside the constituency and an open one outside it,
  // so dropping either clause changes the result. Ports
  // `ParliamentaryConstituency.location_obj()`
  // (givefood/models/political.py:94-96), which filters on the FK plus
  // is_closed = False.
  // Four rows, TWO of which survive: a constituency with a single location
  // cannot tell the filters from `results.slice(0, 1)`, and that mutant
  // survived this file -- /constituency/<slug>/ would have drawn one marker
  // where a city has six, with no error and no missing page.
  it("returns open locations in that constituency only, and all of them", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", pconId: SALISBURY_PCON, isClosed: 0, latitude: 51.01 });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Wilton", pconId: SALISBURY_PCON, isClosed: 1, latitude: 51.02 });
    seedLocation({ id: 403, foodbankId: SALISBURY, name: "Warminster", pconId: SOUTH_WEST_WILTS_PCON, isClosed: 0, latitude: 51.03 });
    seedLocation({ id: 404, foodbankId: SALISBURY, name: "Bemerton Heath", pconId: SALISBURY_PCON, isClosed: 0, latitude: 51.04 });

    expect(asc(ids(await getOpenLocationsByConstituencyId(session, SALISBURY_PCON)))).toEqual([401, 404]);
  });

  // FILTERS THE ID COLUMN, NOT THE DENORMALISED SLUG. Django's location_obj()
  // uses the foreign key (`parliamentary_constituency = self`), and the row
  // carries BOTH parliamentary_constituency_id and
  // parliamentary_constituency_slug. The two can disagree -- the slug is
  // written by the geocoder, the id resolved separately -- so a query moved to
  // the slug column would answer a different question. Seeded with a
  // deliberately mismatched slug so that swap fails here.
  it("matches on the constituency id even when the denormalised slug disagrees", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", pconId: SALISBURY_PCON });
    db.prepare("UPDATE foodbanklocation SET parliamentary_constituency_slug = ? WHERE id = ?").run("east-wiltshire", 401);

    expect(ids(await getOpenLocationsByConstituencyId(session, SALISBURY_PCON))).toEqual([401]);
  });

  // parliamentary_constituency_id is nullable -- a location outside the
  // geocoder's coverage, or one added by hand, carries NULL. SQLite's `= ?` is
  // never true against NULL, so such a row belongs to no constituency feed at
  // all. That is the correct outcome (it has no constituency), but it is the
  // same three-valued logic that makes `id != ?` a live bug class in this
  // repo, so it is executed rather than assumed.
  it("excludes rows whose constituency is NULL", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", pconId: SALISBURY_PCON });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Unplaced Hub", pconId: null });

    expect(ids(await getOpenLocationsByConstituencyId(session, SALISBURY_PCON))).toEqual([401]);
  });

  // The mirror image: binding NULL matches nothing, INCLUDING the NULL rows.
  // The caller resolves a constituency slug to an id before calling, and a
  // failed resolution reaching here returns an empty feed rather than every
  // ungeocoded location in the country.
  it("matches nothing at all when the bound constituency id is NULL", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", pconId: SALISBURY_PCON });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Unplaced Hub", pconId: null });

    expect(await getOpenLocationsByConstituencyId(session, null as unknown as number)).toEqual([]);
  });

  // Unsorted, like the other feed queries -- location_obj() has no
  // `.order_by()` either, and buildGeojson.ts emits features in arrival order.
  it("does not sort by name", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Zeals Outreach", pconId: SALISBURY_PCON, latitude: 51.01 });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Amesbury", pconId: SALISBURY_PCON, latitude: 51.02 });

    expect(names(await getOpenLocationsByConstituencyId(session, SALISBURY_PCON))).not.toEqual(["Amesbury", "Zeals Outreach"]);
  });

  it("coerces the flag columns and carries the parent's fields", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", pconId: SALISBURY_PCON, isDonationPoint: null });

    const [row] = await getOpenLocationsByConstituencyId(session, SALISBURY_PCON);

    expect(row!.is_donation_point).toBeNull();
    expect(row!.is_closed).toBe(false);
    expect(row!.foodbank_name).toBe("Salisbury Foodbank");
  });
});

// ---------------------------------------------------------------------------
// getOpenLocationsByCountry
// ---------------------------------------------------------------------------

describe("getOpenLocationsByCountry", () => {
  // Ports `FoodbankLocation.objects.filter(country = country_name,
  // is_closed = False)` (givefood/views.py:302-305). Both predicates seeded
  // against a row that would survive dropping either one.
  // England keeps TWO of its three rows. A one-row answer would be produced
  // just as happily by `results.slice(0, 1)`, which survived this file until
  // this seed grew: England's geo.json holds ~1,700 features, and that mutant
  // reduces it to one without touching Scotland's or raising anything.
  it("returns open locations in that country only, and all of them", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", country: "England", isClosed: 0, latitude: 51.01 });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Wilton", country: "England", isClosed: 1, latitude: 51.02 });
    seedLocation({ id: 403, foodbankId: SALISBURY, name: "Leith Hub", country: "Scotland", isClosed: 0, latitude: 51.03 });
    seedLocation({ id: 404, foodbankId: SALISBURY, name: "Bemerton Heath", country: "England", isClosed: 0, latitude: 51.04 });

    expect(asc(ids(await getOpenLocationsByCountry(session, "England")))).toEqual([401, 404]);
    expect(ids(await getOpenLocationsByCountry(session, "Scotland"))).toEqual([403]);
  });

  // THE LOCATION'S OWN country, NOT THE PARENT'S. A Scottish outreach point of
  // an English food bank belongs in Scotland's geo.json, which is exactly why
  // the column is denormalised onto the child and why 0019 did NOT drop it
  // (unlike name/slug/network/phone/email, which are pure copies). Filtering
  // through the view's `f.country` would put this row in the wrong country's
  // feed with no error anywhere.
  it("filters on the location's country, not its parent food bank's", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Gretna Outreach", country: "Scotland" });

    expect(
      (db.prepare("SELECT country FROM foodbank WHERE id = ?").get(SALISBURY) as { country: string }).country,
    ).toBe("England");
    expect(ids(await getOpenLocationsByCountry(session, "Scotland"))).toEqual([401]);
    expect(await getOpenLocationsByCountry(session, "England")).toEqual([]);
  });

  // The caller maps a URL slug through COUNTRY_MAPPING to get the exact stored
  // spelling, because this comparison is case- and space-sensitive on both
  // engines. "england" returning nothing is the behaviour that makes that
  // mapping load-bearing rather than cosmetic -- and the reason a bare slug
  // reaching this function silently yields an empty map instead of a 404.
  it("matches the country name exactly, case and whitespace included", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", country: "England" });

    expect(await getOpenLocationsByCountry(session, "england")).toEqual([]);
    expect(await getOpenLocationsByCountry(session, "England ")).toEqual([]);
    expect(ids(await getOpenLocationsByCountry(session, "England"))).toEqual([401]);
  });

  // Unlike foodbankdonationpoint, whose `country` is NULLABLE in production
  // (1/5,744 rows, 0001_core.sql:89), foodbanklocation declares it NOT NULL and
  // production holds none -- so there is no orphan-country row to exclude here.
  // The schema is what guarantees that, so the guarantee is asserted against
  // the schema rather than trusted.
  it("cannot hold a NULL country, unlike the donation point table", () => {
    const column = db
      .prepare("PRAGMA table_info(foodbanklocation)")
      .all()
      .find((r) => (r as { name: string }).name === "country") as { notnull: number };

    expect(column.notnull).toBe(1);
  });

  it("does not sort by name", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Zeals Outreach", latitude: 51.01 });
    seedLocation({ id: 402, foodbankId: SALISBURY, name: "Amesbury", latitude: 51.02 });

    expect(names(await getOpenLocationsByCountry(session, "England"))).not.toEqual(["Amesbury", "Zeals Outreach"]);
  });

  it("keeps an orphaned location in its country's feed", async () => {
    seedLocation({ id: 404, foodbankId: 999, name: "Orphaned Outreach", country: "Wales" });

    const rows = await getOpenLocationsByCountry(session, "Wales");

    expect(ids(rows)).toEqual([404]);
    expect(rows[0]!.foodbank_slug).toBeNull();
  });

  // THE ONE PLACE WHERE A MISSING mapLocationRow WOULD BE INVISIBLE TODAY, and
  // therefore the one that most needs asserting. buildGeojson's
  // locationFeature() reads name, slug, address and coordinates -- none of the
  // four flag columns -- so dropping the `.map(mapLocationRow)` from this
  // function alone would change nothing anyone could see, while leaving the
  // declared FoodbankLocationRow return type a lie and the next caller to
  // reach for `location.is_mobile` holding the integer 0. Five functions here
  // return this type and all five must honour it; this is the one a mutation
  // test found unguarded.
  it("coerces the flag columns, keeping the country feed's rows the same shape as every other feed's", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    seedLocation({ id: 401, foodbankId: SALISBURY, name: "Amesbury", isDonationPoint: 1, isMobile: null, placeHasPhoto: 0 });

    const [row] = await getOpenLocationsByCountry(session, "England");

    expect(row!.is_closed).toBe(false);
    expect(row!.is_donation_point).toBe(true);
    expect(row!.is_mobile).toBeNull();
    expect(row!.place_has_photo).toBe(false);
  });
});
