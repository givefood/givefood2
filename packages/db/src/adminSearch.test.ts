import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_SEARCH_MIN_QUERY_LENGTH, searchAdmin } from "./adminSearch";
import type { Session } from "./types";

// gfadmin/views.py:111-231 search_results(), ported to adminSearch.ts as eight
// statements in one D1 batch. THIS FILE RUNS THE SQL. Everything adminSearch.ts
// contains is SQL -- there is no branch to unit test, no value to format -- so a
// fake session handing back canned rows would assert nothing except that the
// module can read an array. The failures this module can have are all of the
// same silent shape: a dropped predicate returns MORE rows, an INNER JOIN
// returns FEWER, a wrong ORDER BY returns the same rows in the wrong order, and
// none of the three raises anything or logs anything. Migration 0019 is the
// scar: it quietly broke four queries and nobody found out until someone
// measured. So every test below seeds a real in-memory SQLite from the real
// migration DDL and asserts the actual rows, in order.
//
// THE SCHEMA IS COPIED FROM packages/db/migrations, NOT FROM THE TYPESCRIPT
// TYPES. The whole point is to catch the two disagreeing. Column lists are
// 0001_core.sql (plus 0004_subscribers.sql, 0011, 0020) with 0019's DROP COLUMNs
// applied, and the three views are 0019's own CREATE VIEW statements verbatim --
// foodbanklocation_full, foodbankdonationpoint_full and foodbankchange_full are
// where the denormalised foodbank_name/foodbank_slug this module selects now
// come from, and a hand-rolled stand-in row would have made the LEFT JOIN tests
// below circular.
//
// The UNIQUE indexes are here too, so a fixture cannot set up a state
// production would have refused -- same reasoning as foodbankAdmin.test.ts.

const SCHEMA = `
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

CREATE TABLE foodbanklocation (
  id INTEGER PRIMARY KEY, uuid TEXT NOT NULL,
  foodbank_id INTEGER NOT NULL,
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
CREATE UNIQUE INDEX loc_fb_name_uniq ON foodbanklocation(foodbank_id, name);

CREATE TABLE foodbankdonationpoint (
  id INTEGER PRIMARY KEY, uuid TEXT NOT NULL,
  foodbank_id INTEGER NOT NULL,
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
CREATE UNIQUE INDEX dp_fb_name_uniq ON foodbankdonationpoint(foodbank_id, name);

CREATE TABLE foodbankchange (
  id INTEGER PRIMARY KEY,
  need_id TEXT NOT NULL,
  foodbank_id INTEGER,
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

CREATE TABLE parliamentaryconstituency (
  id INTEGER PRIMARY KEY,
  name TEXT, slug TEXT NOT NULL, country TEXT,
  mp TEXT, mp_party TEXT, mp_parl_id INTEGER NOT NULL, mp_display_name TEXT, email TEXT,
  centroid TEXT NOT NULL,
  latitude REAL, longitude REAL,
  boundary_geojson TEXT,
  pcon24cd TEXT
);
CREATE INDEX parlcon_slug_idx ON parliamentaryconstituency(slug);

CREATE TABLE foodbanksubscriber (
  id INTEGER PRIMARY KEY,
  created TEXT NOT NULL, last_contacted TEXT,
  foodbank_id INTEGER NOT NULL,
  email TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0,
  sub_key TEXT NOT NULL, unsub_key TEXT NOT NULL
);
CREATE UNIQUE INDEX sub_email_fb_uniq ON foodbanksubscriber(email, foodbank_id);
CREATE UNIQUE INDEX sub_key_idx ON foodbanksubscriber(sub_key);
CREATE UNIQUE INDEX unsub_key_idx ON foodbanksubscriber(unsub_key);

CREATE TABLE webpushsubscription (
  id INTEGER PRIMARY KEY,
  created TEXT NOT NULL,
  foodbank_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
  browser TEXT
);
CREATE UNIQUE INDEX webpush_fb_endpoint_uniq ON webpushsubscription(foodbank_id, endpoint);

CREATE TABLE mobilesubscriber (
  id INTEGER PRIMARY KEY,
  created TEXT NOT NULL,
  device_id TEXT NOT NULL, platform TEXT NOT NULL,
  timezone TEXT, locale TEXT, app_version TEXT, os_version TEXT,
  device_model TEXT, sub_type TEXT,
  foodbank_id INTEGER NOT NULL, donationpoint_id INTEGER
);

CREATE TABLE whatsappsubscriber (
  id INTEGER PRIMARY KEY,
  phone_number TEXT NOT NULL,
  foodbank_id INTEGER,
  created TEXT,
  last_notified TEXT
);

CREATE VIEW foodbanklocation_full AS
  SELECT l.*,
         f.name          AS foodbank_name,
         f.slug          AS foodbank_slug,
         f.network       AS foodbank_network,
         f.phone_number  AS foodbank_phone_number,
         f.contact_email AS foodbank_email
    FROM foodbanklocation l
    LEFT JOIN foodbank f ON f.id = l.foodbank_id;

CREATE VIEW foodbankdonationpoint_full AS
  SELECT d.*,
         f.name    AS foodbank_name,
         f.slug    AS foodbank_slug,
         f.network AS foodbank_network
    FROM foodbankdonationpoint d
    LEFT JOIN foodbank f ON f.id = d.foodbank_id;

CREATE VIEW foodbankchange_full AS
  SELECT c.*, f.name AS foodbank_name, f.slug AS foodbank_slug
    FROM foodbankchange c
    LEFT JOIN foodbank f ON f.id = c.foodbank_id;
`;

type Bindable = null | number | bigint | string;
type Row = Record<string, Bindable>;

interface FakeStatement {
  sql: string;
  params: Bindable[];
  bind: (...values: unknown[]) => FakeStatement;
}

// THE ONE THING THIS HARNESS ADDS TO SQLITE, AND WHY. D1 caps LIKE/GLOB
// patterns at 50 BYTES and rejects the statement outright over it; stock SQLite
// ships a 50,000-byte limit, node:sqlite exposes no way to lower it, and
// SQLITE_LIMIT_LIKE_PATTERN_LENGTH has no SQL-level setter. Without this, the
// entire instr() fallback would be unobservable -- raise MAX_PATTERN_BYTES to
// 5,000 and every test in this file would still pass while production started
// answering "LIKE or GLOB pattern too complex" for any URL an admin pasted.
// So the cap D1 enforces is enforced here, on the same operand D1 measures:
// the parameter used as a LIKE right-hand side.
const D1_LIKE_PATTERN_BYTES = 50;

function enforceD1PatternLimit(sql: string, params: Bindable[]): void {
  // The module binds its patterns to ?1 (the substring test) and ?3 (the food
  // bank prefix test); ?2 is an equality operand and no LIKE ever sees it.
  for (const [slot, index] of [
    ["?1", 0],
    ["?3", 2],
  ] as const) {
    const value = params[index];
    if (!sql.includes(`LIKE ${slot}`) || typeof value !== "string") continue;
    if (new TextEncoder().encode(value).length > D1_LIKE_PATTERN_BYTES) {
      throw new Error("D1_ERROR: LIKE or GLOB pattern too complex");
    }
  }
}

// A Session over real SQLite. Only `batch` is implemented, because searchAdmin
// issues nothing else -- and the batch is counted, so "one round trip for all
// eight statements" (the module's own claim, and the reason this page is
// affordable against a 29.4 MB foodbankchange) is an assertion rather than a
// comment. Otherwise deliberately dumb: apart from the D1 limit above it never
// interprets the SQL, so it cannot become a second implementation of the thing
// under test.
//
// The last batch's SQL TEXT is kept as well as its rows, for exactly one
// reason: LIKE mode and instr() mode are designed to return IDENTICAL rows, so
// no assertion over a result set can tell which one ran. Dropping the LIKE
// branch and always using instr() would be invisible to every row-level test in
// this file -- and would make every admin search materialise a lower() copy of
// all 29.4 MB of foodbankchange (PLAN.md §7.1), which is precisely the cost the
// LIKE branch is kept to avoid. The SQL is the only evidence there is.
interface Stats {
  batches: number;
  statements: number;
  sql: string[];
}

function d1Session(db: DatabaseSync, stats: Stats): Session {
  const statement = (sql: string, params: Bindable[]): FakeStatement => ({
    sql,
    params,
    bind: (...values: unknown[]) => statement(sql, values as Bindable[]),
  });
  return {
    prepare: (sql: string) => statement(sql, []),
    batch: async (statements: FakeStatement[]) => {
      stats.batches += 1;
      stats.statements += statements.length;
      stats.sql = statements.map((s) => s.sql);
      return statements.map((s) => {
        enforceD1PatternLimit(s.sql, s.params);
        return { results: db.prepare(s.sql).all(...s.params), success: true, meta: {} };
      });
    },
    getBookmark: () => null,
  } as unknown as Session;
}

// The food bank statement out of the most recent batch -- `AS match_rank` is
// unique to it. Used only by the two mode tests below.
function foodbankStatementSql(): string {
  const sql = stats.sql.find((candidate) => candidate.includes("AS match_rank"));
  if (sql === undefined) throw new Error("the batch contained no food bank statement");
  return sql;
}

// Python's str(datetime), which is what Django and the ETL write and what
// migration 0022 normalised every JavaScript-written value into. Every seeded
// timestamp in this file is in this form on purpose: these columns are TEXT,
// SQLite compares TEXT byte by byte, and 0022's header shows what happens when
// two formats share one column.
const PY_NOW = "2026-09-05 19:28:08.853000";

let db: DatabaseSync;
let stats: Stats;
let session: Session;
let nextId: number;

function insert(table: string, row: Row): void {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(
    ...columns.map((column) => row[column] as Bindable),
  );
}

// Every column the table declares NOT NULL, filled with something that cannot
// accidentally satisfy a search. Anything a test actually searches on it passes
// in explicitly, so a match in a fixture is always deliberate.
function seedFoodbank(over: Row): number {
  const id = (nextId += 1);
  insert("foodbank", {
    id,
    uuid: `fb-uuid-${id}`,
    address: "1 Market Place\r\nTown",
    postcode: "SP1 1AA",
    country: "England",
    lat_lng: "51.0688,-1.7945",
    charity_just_foodbank: 0,
    contact_email: `info-${id}@example.org`,
    url: `https://example.org/fb/${id}/`,
    shopping_list_url: `https://example.org/fb/${id}/list/`,
    address_is_administrative: 0,
    is_closed: 0,
    no_locations: 0,
    days_between_needs: 7,
    created: PY_NOW,
    modified: PY_NOW,
    ...over,
  });
  return id;
}

function seedLocation(over: Row): number {
  const id = (nextId += 1);
  insert("foodbanklocation", {
    id,
    uuid: `loc-uuid-${id}`,
    address: "9 Back Lane",
    postcode: "SP2 2BB",
    country: "England",
    lat_lng: "51.0812,-1.8231",
    is_closed: 0,
    modified: PY_NOW,
    ...over,
  });
  return id;
}

function seedDonationPoint(over: Row): number {
  const id = (nextId += 1);
  insert("foodbankdonationpoint", {
    id,
    uuid: `dp-uuid-${id}`,
    address: "9 Back Lane",
    postcode: "SP3 3CC",
    country: "England",
    lat_lng: "51.0812,-1.8231",
    is_closed: 0,
    in_store_only: 0,
    modified: PY_NOW,
    ...over,
  });
  return id;
}

function seedNeed(over: Row): number {
  const id = (nextId += 1);
  insert("foodbankchange", {
    id,
    need_id: `${id}`.padStart(32, "0"),
    change_text: "Nothing",
    published: 1,
    input_method: "scrape",
    created: PY_NOW,
    modified: PY_NOW,
    ...over,
  });
  return id;
}

function seedConstituency(over: Row): number {
  const id = (nextId += 1);
  insert("parliamentaryconstituency", { id, mp_parl_id: 1000 + id, centroid: "51.0,-1.8", ...over });
  return id;
}

function seedEmailSub(over: Row): number {
  const id = (nextId += 1);
  insert("foodbanksubscriber", { id, created: PY_NOW, confirmed: 1, sub_key: `sub-${id}`, unsub_key: `unsub-${id}`, ...over });
  return id;
}

function seedMobileSub(over: Row): number {
  const id = (nextId += 1);
  insert("mobilesubscriber", { id, created: PY_NOW, ...over });
  return id;
}

function seedWebpushSub(over: Row): number {
  const id = (nextId += 1);
  insert("webpushsubscription", { id, created: PY_NOW, p256dh: "p256dh", auth: "auth", ...over });
  return id;
}

// Three food banks whose NAME order (Alpha, Bravo, Charlie) is the exact
// reverse of their SLUG order (x-charlie, y-bravo, z-alpha). The locations and
// donation points statements both order by `foodbank_name` as their middle key,
// and the two columns sit next to each other in the same view -- so ordering by
// the wrong one is a one-word edit that no fixture with matching name and slug
// order can see.
function seedThreeParents(): { id: number; slug: string }[] {
  return [
    { id: seedFoodbank({ name: "Alpha Foodbank", slug: "z-alpha" }), slug: "z-alpha" },
    { id: seedFoodbank({ name: "Bravo Foodbank", slug: "y-bravo" }), slug: "y-bravo" },
    { id: seedFoodbank({ name: "Charlie Foodbank", slug: "x-charlie" }), slug: "x-charlie" },
  ];
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  stats = { batches: 0, statements: 0, sql: [] };
  session = d1Session(db, stats);
  nextId = 0;
});

// searchAdmin resolves to null for a query it declines to run, and the route
// (routes/admin/search.ts:47) turns "not null" into the results page and "null"
// into the too-long message. Anything that made an ordinary search return null
// would therefore tell an admin their query was too long.
async function search(query: string) {
  const results = await searchAdmin(session, query);
  if (results === null) throw new Error(`searchAdmin declined the query ${JSON.stringify(query)}`);
  return results;
}

describe("the guard states, which cost no D1 query at all", () => {
  // F3's floor. Django has no minimum, so a single character there scans every
  // one of these tables -- foodbankchange included, 33,931 rows and 29.4 MB --
  // to return 600 rows of noise. The number is exported so the route can name
  // it in the message without restating it; pinned here so a change to it is a
  // visible decision rather than a silent one.
  it("declines a query below the exported minimum without touching the database", async () => {
    expect(ADMIN_SEARCH_MIN_QUERY_LENGTH).toBe(2);
    seedFoodbank({ name: "Salisbury", slug: "salisbury" });

    expect(await searchAdmin(session, "a")).toBeNull();
    expect(await searchAdmin(session, "")).toBeNull();
    // The whole point of returning null before the batch: no round trip.
    expect(stats.batches).toBe(0);
  });

  // The trim happens BEFORE the length test, so "  a  " is one character, not
  // five. A guard that measured the raw string would let a space-padded single
  // character through and run the full-table scan the floor exists to prevent.
  it("measures the TRIMMED query against the floor", async () => {
    seedFoodbank({ name: "Salisbury", slug: "salisbury" });

    expect(await searchAdmin(session, "   a   ")).toBeNull();
    expect(stats.batches).toBe(0);

    // ... and the trimmed value is what gets searched, so the padding cannot
    // stop an ordinary two-character query matching.
    const padded = await search("  sa  ");
    expect(padded.foodbanks.map((f) => f.slug)).toEqual(["salisbury"]);
  });

  // MAX_QUERY_LENGTH, the sanity cap on a pasted document. Nothing in D1 needs
  // it -- instr() has no pattern limit -- so its only job is to keep a
  // pathological paste off the page, and it sits far past the ~190-character
  // push endpoint that is the longest thing anyone legitimately searches here.
  it("declines a query past 500 characters but runs one of exactly 500", async () => {
    expect(await searchAdmin(session, "x".repeat(501))).toBeNull();
    expect(stats.batches).toBe(0);

    expect(await searchAdmin(session, "x".repeat(500))).not.toBeNull();
    expect(stats.batches).toBe(1);

    // BOTH guards measure the TRIMMED query, not the raw one -- the ceiling as
    // well as the floor. Pasting into a browser text field routinely brings
    // trailing whitespace with it, and a 500-character push endpoint pasted
    // with a space on each end is a query Django runs and this page must too:
    // measuring `rawQuery` here would answer "that search is too long" for a
    // value that is exactly at the limit.
    expect(await searchAdmin(session, `  ${"x".repeat(500)}  `)).not.toBeNull();
    expect(stats.batches).toBe(2);
  });

  // A search that matches nothing is NOT null. The route reads null as "too
  // long" (search.ts:47), so a no-results search returning null would show an
  // admin the wrong message for a perfectly good query.
  it("returns empty groups, not null, when a runnable query matches nothing", async () => {
    seedFoodbank({ name: "Salisbury", slug: "salisbury" });

    expect(await search("nothinghere")).toEqual({
      foodbanks: [],
      locations: [],
      donationpoints: [],
      constituencies: [],
      needs: [],
      subscriptions: [],
      total: 0,
    });
  });

  // The module's own performance claim, made assertable. Eight separate
  // awaits against a replicated D1 would be eight round trips on a page whose
  // largest table is 29.4 MB; the batch is the reason this design is
  // affordable at all, and nothing else in the module would fail if it were
  // unpicked.
  it("issues all eight statements as one batch", async () => {
    await search("salisbury");

    expect(stats.batches).toBe(1);
    expect(stats.statements).toBe(8);
  });
});

describe("food banks: the ranking Django does not have", () => {
  // F5. Django applies no order_by before its [:100] slice, so which 100 of
  // 1,071 rows come back is plan-dependent and can differ between runs. These
  // four rows are the four bands: exact, prefix, substring, and substring on a
  // closed food bank.
  function seedRankingCorpus(): void {
    seedFoodbank({ name: "Salisbury", slug: "salisbury" });
    seedFoodbank({ name: "Salisbury Vale", slug: "salisbury-vale" });
    seedFoodbank({ name: "North Salisbury", slug: "north-salisbury" });
    seedFoodbank({ name: "Old Salisbury", slug: "old-salisbury", is_closed: 1 });
  }

  it("orders exact, then prefix, then substring, with closed last inside each band", async () => {
    seedRankingCorpus();

    expect((await search("salisbury")).foodbanks.map((f) => f.slug)).toEqual([
      "salisbury",
      "salisbury-vale",
      "north-salisbury",
      "old-salisbury",
    ]);
  });

  // is_closed is the SECOND key, not the first: a closed exact match still
  // beats an open substring match. Swapping the two would bury the food bank
  // whose name the admin actually typed under every incidental mention of it.
  it("keeps a CLOSED exact match ahead of an OPEN substring match", async () => {
    seedFoodbank({ name: "Salisbury", slug: "salisbury", is_closed: 1 });
    seedFoodbank({ name: "North Salisbury", slug: "north-salisbury" });

    const { foodbanks } = await search("salisbury");
    expect(foodbanks.map((f) => f.slug)).toEqual(["salisbury", "north-salisbury"]);
    // is_closed reaches the template as the raw 0/1 the column holds; the
    // search page renders a "closed" flag off it.
    expect(foodbanks.map((f) => f.is_closed)).toEqual([1, 0]);
  });

  // THE SLUG HALVES OF BOTH BANDS, WHICH NO NAME CAN STAND IN FOR. `slug = ?2`
  // is OR'd with `lower(name) = ?2`, and `slug LIKE ?3` with `name LIKE ?3`, so
  // a corpus whose names happen to match the same way the slugs do lets EITHER
  // half be deleted with no visible effect -- which is how a ranking test ends
  // up proving only half of what it claims. Not one of these three names
  // contains the hyphenated query, so each row's band is decided by its SLUG
  // alone.
  //
  // Names are chosen to sort against the ranking, not with it: "Alpha" is the
  // prefix-slug row and "Zeta" the exact-slug row, so a collapsed band shows up
  // as a swap. is_closed does the same job for the substring row, which is the
  // only OPEN one here.
  //
  // MUTANTS: drop `slug = ?2` (Zeta falls into the prefix band and Alpha's name
  // sorts ahead of it); drop `${startsWithSql("slug", mode)}` (Alpha falls into
  // the substring band, where the open Friends row outranks it on is_closed).
  it("ranks a food bank by its SLUG alone, exact band then prefix band", async () => {
    seedFoodbank({ name: "Zeta Aberdeen North", slug: "aberdeen-north", is_closed: 1 });
    seedFoodbank({ name: "Alpha Aberdeen North", slug: "aberdeen-north-city", is_closed: 1 });
    seedFoodbank({ name: "Friends of Aberdeen North Larder", slug: "friends-aberdeen-north" });

    expect((await search("aberdeen-north")).foodbanks.map((f) => f.slug)).toEqual([
      "aberdeen-north",
      "aberdeen-north-city",
      "friends-aberdeen-north",
    ]);
  });

  // F6, and the reason sortFoodbanks exists at all. SQLite's default collation
  // is byte-wise, so `ORDER BY name` puts every capital ahead of every
  // lowercase: "North", "Zebra", "aa". The JS collator re-sort puts them in the
  // order a human reads. Delete sortFoodbanks and this is the test that fails
  // -- the rows are all present and all in the wrong order, which is exactly
  // the failure nobody notices.
  it("re-sorts each rank band with the JS collator, not SQLite's byte order", async () => {
    seedFoodbank({ name: "Zebra Salisbury", slug: "zebra-salisbury" });
    seedFoodbank({ name: "aa Salisbury", slug: "aa-salisbury" });
    seedFoodbank({ name: "North Salisbury", slug: "north-salisbury" });

    // Byte order would be North, Zebra, aa -- proved right here so this test
    // cannot pass by accident on a build where the two orders agree.
    const byteOrder = db.prepare("SELECT name FROM foodbank ORDER BY name").all() as { name: string }[];
    expect(byteOrder.map((row) => row.name)).toEqual(["North Salisbury", "Zebra Salisbury", "aa Salisbury"]);
    expect((await search("salisbury")).foodbanks.map((f) => f.name)).toEqual(["aa Salisbury", "North Salisbury", "Zebra Salisbury"]);
  });

  // F10, the one place this page's result set intentionally differs from
  // production. alt_name is the Welsh/alternative name; Django's field list
  // (views.py:118-129) does not include it, so today a Welsh-language name
  // finds nothing on a site that serves Welsh as a first-class language. Added
  // here as a deliberate 13th field, and this is the test that says so.
  it("searches alt_name, which Django does not", async () => {
    seedFoodbank({ name: "North Wales Foodbank", slug: "north-wales", alt_name: "Banc Bwyd Gogledd Cymru" });

    expect((await search("Gogledd")).foodbanks.map((f) => f.slug)).toEqual(["north-wales"]);
  });

  // THE FILTER TEST THAT ONLY WORKS BECAUSE THE ROW MUST BE EXCLUDED. Django
  // does not search these eight columns and neither does this port; a fixture
  // that only ever seeds matching rows would pass just as happily against a
  // `SELECT * FROM foodbank` with no WHERE at all. Every value below is the
  // same distinctive token, so any one column creeping into
  // FOODBANK_SEARCH_COLUMNS shows up here immediately.
  it("does NOT search network, contact_email, phone_number, notes, facebook_page, fsa_id or charity_number", async () => {
    seedFoodbank({
      name: "Quiet Larder",
      slug: "quiet-larder",
      network: "zzhaystack",
      network_id: "zzhaystack",
      charity_number: "zzhaystack",
      contact_email: "zzhaystack@example.org",
      phone_number: "zzhaystack",
      notes: "zzhaystack",
      facebook_page: "https://facebook.com/zzhaystack",
      fsa_id: "zzhaystack",
    });

    expect((await search("zzhaystack")).foodbanks).toEqual([]);
  });

  // ... and the other half: the twelve columns that ARE searched, one row
  // each, so a column silently dropped from the list is a failure here rather
  // than a food bank an admin can no longer find. charity_name is the one
  // people actually reach for -- it is how you find "Salisbury Foodbank" when
  // the Charity Commission calls it something else entirely.
  it("searches every one of Django's twelve columns", async () => {
    const columns = [
      "address",
      "postcode",
      "url",
      "shopping_list_url",
      "rss_url",
      "news_url",
      "donation_points_url",
      "locations_url",
      "contacts_url",
      "charity_name",
    ];
    columns.forEach((column, i) => {
      seedFoodbank({ name: `Row ${i}`, slug: `row-${i}`, [column]: `finds-via-${column}` });
    });

    // The SLUG, not the count: a length of 1 would be satisfied by the query
    // matching some other row on some other column, which is exactly what a
    // mis-copied column name in the list would produce.
    for (const [i, column] of columns.entries()) {
      expect((await search(`finds-via-${column}`)).foodbanks.map((f) => f.slug)).toEqual([`row-${i}`]);
    }
    // slug and name, the remaining two, are covered by the ranking tests above.
  });

  // LIMIT 100 IS DJANGO'S [:100], VERBATIM -- and F5's ranking is what decides
  // WHICH 100 survive it. 101 rows match; the SQL orders by match_rank first,
  // so the exact match is kept and the byte-last fringe row is the one dropped.
  // Remove the ORDER BY and the exact match becomes the row SQLite happens to
  // drop, which is the plan-dependent behaviour the port set out to fix.
  it("keeps 100 rows, and all three ORDER BY keys decide which 100", async () => {
    // EVERY DETAIL OF THIS FIXTURE IS LOAD-BEARING, because the SQL ORDER BY on
    // this statement changes NOTHING an admin can see except through the LIMIT
    // -- sortFoodbanks re-sorts the survivors in JS afterwards. The only way any
    // of its three keys is observable at all is by which row falls off the end.
    //
    // The fringe rows go in REVERSE name order, so rowid order and name order
    // disagree: without the trailing `name` key the 100 rank-2 rows tie and
    // SQLite keeps them in scan order, which drops 001 instead of 100.
    //
    // Each row's SLUG is its name's MIRROR (name 001 has slug ...-100), so
    // `ORDER BY match_rank, is_closed, slug` -- one word away from the real
    // statement, and slug is the column right beside name in the SELECT --
    // keeps a completely different 99 rows. Hence the assertions below are on
    // names, not slugs.
    for (let i = 100; i >= 1; i -= 1) {
      const n = `${i}`.padStart(3, "0");
      const mirror = `${101 - i}`.padStart(3, "0");
      seedFoodbank({ name: `Fringe Limitrow ${n}`, slug: `fringe-limitrow-${mirror}` });
    }
    // The exact match is CLOSED and inserted LAST. Closed makes `match_rank,
    // is_closed` and `is_closed, match_rank` different orderings -- with the
    // keys swapped the 100 open fringe rows fill the slice and the one row the
    // admin typed the name of is the row that gets dropped. Last makes it the
    // highest rowid, so dropping the ORDER BY drops it too.
    seedFoodbank({ name: "Limitrow", slug: "limitrow", is_closed: 1 });

    const { foodbanks, total } = await search("limitrow");
    expect(foodbanks).toHaveLength(100);
    expect(total).toBe(100);
    // Rank 0 beats is_closed, so the closed exact match is first even in the
    // JS re-sort.
    expect(foodbanks.map((f) => f.slug)[0]).toBe("limitrow");
    // Ranks 0 then 2, and within rank 2 the zero-padded names sort the same way
    // byte-wise and by collator, so the surviving NAMES are exactly 001-099.
    const names = foodbanks.map((f) => f.name);
    expect(names.includes("Fringe Limitrow 001")).toBe(true);
    expect(names.includes("Fringe Limitrow 099")).toBe(true);
    expect(names.includes("Fringe Limitrow 100")).toBe(false);
  });

  // The remaining ORDER BY key, and the same argument the locations crowding
  // test makes: `is_closed` in the SQL is not decoration duplicated by the JS
  // re-sort, it decides WHICH 100 rows the re-sort ever gets to see. Drop it and
  // a hundred closed food banks -- this database has 178 of them -- sort ahead
  // of every open one on name and quietly consume the whole slice.
  it("never lets closed food banks crowd an open one out of the 100", async () => {
    for (let i = 1; i <= 100; i += 1) {
      const n = `${i}`.padStart(3, "0");
      seedFoodbank({ name: `Fringe Crowdrow C${n}`, slug: `crowd-c${n}`, is_closed: 1 });
    }
    for (let i = 1; i <= 5; i += 1) {
      seedFoodbank({ name: `Fringe Crowdrow Z00${i}`, slug: `crowd-z00${i}` });
    }

    const { foodbanks } = await search("crowdrow");
    expect(foodbanks).toHaveLength(100);
    expect(foodbanks.filter((f) => f.is_closed === 0).map((f) => f.slug)).toEqual([
      "crowd-z001",
      "crowd-z002",
      "crowd-z003",
      "crowd-z004",
      "crowd-z005",
    ]);
  });

  // No is_closed filter anywhere in this module -- closed food banks, closed
  // locations and closed donation points all appear, exactly as they do in
  // Django. This is an ADMIN page: a closed food bank is precisely the row
  // someone comes here to find.
  it("returns a closed food bank rather than filtering it out", async () => {
    seedFoodbank({ name: "Old Salisbury", slug: "old-salisbury", is_closed: 1 });

    expect((await search("salisbury")).foodbanks).toEqual([{ name: "Old Salisbury", slug: "old-salisbury", is_closed: 1 }]);
  });

  // match_rank is a ranking device, not data: it exists to order the group and
  // must never reach the template, which iterates the object.
  it("does not leak match_rank into the result rows", async () => {
    seedFoodbank({ name: "Salisbury", slug: "salisbury" });

    expect(Object.keys((await search("salisbury")).foodbanks[0] ?? {}).sort()).toEqual(["is_closed", "name", "slug"]);
    // F9, and the one group where the row shape CANNOT show it: sortFoodbanks
    // projects to {name, slug, is_closed}, so any extra column added to the
    // SELECT is stripped in JS and every assertion above still passes while
    // D1 hauls charity_objectives and notes back for 100 rows on every search.
    // The statement text is the only place that is visible.
    expect(foodbankStatementSql().startsWith("SELECT name, slug, is_closed,\n")).toBe(true);
    expect(foodbankStatementSql()).not.toContain("SELECT *");
  });
});

describe("LIKE escaping, which SQLite gives no default for", () => {
  // THE BUG THE `ESCAPE '\'` CLAUSE PREVENTS. Django's __icontains runs its
  // parameter through prep_for_like_query and relies on Postgres's DEFAULT
  // backslash escape character. SQLite has none, so without the explicit
  // ESCAPE the `\%` escapeLike() produces would be matched as a literal
  // backslash followed by a wildcard: the row an admin typed the exact name of
  // would be missing, and a pile of unrelated rows would be present.
  it("treats % in the query as a literal percent sign, not a wildcard", async () => {
    seedFoodbank({ name: "A%B Larder", slug: "a-pc-b" });
    seedFoodbank({ name: "AxxB Larder", slug: "axxb" });

    expect((await search("A%B")).foodbanks.map((f) => f.slug)).toEqual(["a-pc-b"]);
  });

  it("treats _ in the query as a literal underscore, not a single-character wildcard", async () => {
    seedFoodbank({ name: "C_D Larder", slug: "c-us-d" });
    seedFoodbank({ name: "CxD Larder", slug: "cxd" });

    expect((await search("C_D")).foodbanks.map((f) => f.slug)).toEqual(["c-us-d"]);
  });

  // The escape character escaping itself. escapeLike doubles backslashes FIRST
  // and then escapes % and _, so `\` -> `\\` -> matched as one literal
  // backslash. Getting that order backwards turns `%` into `\\%`, a literal
  // backslash followed by a wildcard, and every query containing a percent
  // sign silently matches nothing.
  it("matches a literal backslash in the query", async () => {
    seedFoodbank({ name: "E\\F Larder", slug: "e-bs-f" });
    seedFoodbank({ name: "EF Larder", slug: "ef" });

    expect((await search("E\\F")).foodbanks.map((f) => f.slug)).toEqual(["e-bs-f"]);
  });

  // THE SECOND ESCAPE CLAUSE, which is a separate statement fragment and a
  // separate mutant: ?3, the food bank prefix test. Dropping ESCAPE here loses
  // no rows -- it silently demotes them, from the prefix band to the substring
  // band -- so it is invisible to every test that only counts results. The
  // prefix row is CLOSED and the substring row is OPEN, so the bands are what
  // decide the order and a demotion flips it.
  it("escapes the prefix pattern too, so a name starting with % still ranks as a prefix match", async () => {
    seedFoodbank({ name: "A%B Larder", slug: "a-pc-b", is_closed: 1 });
    seedFoodbank({ name: "Zulu A%B Larder", slug: "zulu-a-pc-b" });

    expect((await search("A%B")).foodbanks.map((f) => f.slug)).toEqual(["a-pc-b", "zulu-a-pc-b"]);
  });

  // ?2 IS THE RAW QUERY, LOWERCASED -- NOT THE ESCAPED ONE. `slug = ?2` and
  // `lower(name) = ?2` are equality tests, so they compare against the literal
  // the admin typed; ?1 and ?3 are LIKE patterns and carry the backslashes.
  // Three parameters, two of them escaped and one not, is a genuinely easy
  // thing to get wrong, and getting it wrong loses only the exact-match BAND
  // for any query containing %, _ or \ -- every row is still returned, just in
  // the wrong order, which is the failure nobody reports.
  //
  // The exact row is CLOSED and the prefix row OPEN, so the demotion from band
  // 0 to band 1 is what flips the order.
  it("compares the exact-match band against the UNescaped query", async () => {
    seedFoodbank({ name: "A%B", slug: "a-pc-b", is_closed: 1 });
    seedFoodbank({ name: "A%B Larder", slug: "a-pc-b-larder" });

    expect((await search("A%B")).foodbanks.map((f) => f.slug)).toEqual(["a-pc-b", "a-pc-b-larder"]);
  });

  // A bare `%` is two characters short of the floor on its own, but two of them
  // are a legal query -- and the one that would return every non-NULL row in
  // six tables if the escaping were dropped. The one seeded row must be the
  // only hit.
  it("does not turn a query of only wildcards into a match-everything search", async () => {
    seedFoodbank({ name: "Contains %% Larder", slug: "double-pc" });
    seedFoodbank({ name: "Ordinary Larder", slug: "ordinary" });
    seedLocation({ foodbank_id: 1, name: "Ordinary Room", slug: "ordinary-room" });

    const results = await search("%%");
    expect(results.foodbanks.map((f) => f.slug)).toEqual(["double-pc"]);
    expect(results.locations).toEqual([]);
    expect(results.total).toBe(1);
  });
});

// The 50-byte D1 cap and the instr() fallback behind it. PLAN.md line 10198
// names this search box specifically: D1 rejects a LIKE pattern over 50 BYTES,
// with no Postgres equivalent, and the page used to answer "That search is too
// long" for queries Django searches fine -- seven of the twelve columns it
// searches are URLs, and a push endpoint is ~190 characters by construction.
//
// The two modes are supposed to be EXACTLY equivalent: SQLite's LIKE folds
// ASCII case on both sides, which is what instr() over lower() does, and
// instr() takes its needle literally so nothing needs escaping. The tests below
// straddle the boundary with the same corpus so that a divergence between the
// two shows up as a difference in the rows, which is the only way it ever
// would in production.
describe("the 50-byte pattern cap and the instr() fallback", () => {
  const LONG_NAME = "Aberdeenshire North and Moray East Community Larder";

  // THE EXACT ROW IS THE CLOSED ONE, AND THE OTHER TWO ARE OPEN. That is what
  // makes these three assertions able to see a rank at all: match_rank is the
  // FIRST sort key and is_closed the second, so a ranking that collapsed would
  // put the two open rows ahead of the closed one and the row order would
  // change. Ordering alone cannot separate the bands when the names happen to
  // sort the same way the ranks do -- which is how a ranking test passes
  // against no ranking whatsoever.
  //
  // "Aaa hosted by ..." is the substring-only row, named so it sorts FIRST by
  // collator: if `instr(...) = 1` ever became `instr(...) > 0`, it would be
  // promoted into the prefix band and jump the annexe, which is visible here
  // and nowhere else in this file.
  function seedLongCorpus(): void {
    seedFoodbank({ name: LONG_NAME, slug: "aberdeenshire-north", is_closed: 1 });
    seedFoodbank({ name: `${LONG_NAME} Annexe`, slug: "aberdeenshire-north-annexe" });
    seedFoodbank({ name: `Aaa hosted by ${LONG_NAME}`, slug: "aaa-hosted" });
  }

  // 48 characters wrap to a 50-byte pattern, which is exactly the cap and so
  // still LIKE; 49 wrap to 51 and switch to instr. The byte arithmetic is
  // asserted rather than described, because it is the thing that decides which
  // branch runs and a reader cannot check it by eye. The two queries are two
  // characters apart and must produce byte-identical output -- that equality
  // IS the claim that LIKE and instr() are equivalent here.
  it("stays on LIKE at exactly 50 pattern bytes", async () => {
    seedLongCorpus();
    const query = LONG_NAME.slice(0, 48);

    expect(new TextEncoder().encode(`%${query}%`)).toHaveLength(50);
    // No row's name EQUALS a 48-character prefix, so nothing reaches band 0
    // and the open annexe outranks the closed exact row on is_closed.
    expect((await search(query)).foodbanks.map((f) => f.slug)).toEqual([
      "aberdeenshire-north-annexe",
      "aberdeenshire-north",
      "aaa-hosted",
    ]);
    // MUTANTS: `mode = "instr"` unconditionally, and `>= MAX_PATTERN_BYTES`
    // instead of `>`. Both leave every row in this file untouched -- the two
    // modes are built to be equivalent -- and both make the common short query
    // scan a lower() copy of the whole 29.4 MB foodbankchange table. The SQL
    // text is the only place either shows up.
    expect(foodbankStatementSql()).toContain("LIKE ?1 ESCAPE");
    expect(foodbankStatementSql()).not.toContain("instr(");
  });

  it("switches to instr() one byte over the cap and returns the identical order", async () => {
    seedLongCorpus();
    const query = LONG_NAME.slice(0, 49);

    expect(new TextEncoder().encode(`%${query}%`)).toHaveLength(51);
    expect((await search(query)).foodbanks.map((f) => f.slug)).toEqual([
      "aberdeenshire-north-annexe",
      "aberdeenshire-north",
      "aaa-hosted",
    ]);
    // The other half of the same claim: one byte past the cap the statement
    // really has changed shape, rather than the harness having quietly let an
    // over-length LIKE pattern through.
    expect(foodbankStatementSql()).toContain("instr(lower(name), ?1) > 0");
    expect(foodbankStatementSql()).not.toContain("LIKE");
  });

  // The ranking survives the mode switch. `instr(lower(col), ?3) = 1` is a
  // completely different expression from `col LIKE ?3 ESCAPE '\'`, and it is
  // the one nobody looks at, because the common short query never reaches it.
  // Same corpus as the two tests above, two more characters of query, and the
  // CLOSED exact match jumps from second place to first -- which it can only
  // do by reaching band 0.
  it("still ranks exact before prefix before substring in instr() mode", async () => {
    seedLongCorpus();

    expect(new TextEncoder().encode(`%${LONG_NAME}%`).length).toBeGreaterThan(50);
    expect((await search(LONG_NAME)).foodbanks.map((f) => f.slug)).toEqual([
      "aberdeenshire-north",
      "aberdeenshire-north-annexe",
      "aaa-hosted",
    ]);
  });

  // The cap is measured in UTF-8 BYTES, not characters -- a distinction with no
  // effect until someone searches an accented name. 24 e-acutes are a 50-byte
  // pattern (LIKE); 25 are 52 (instr). Counting characters instead would send a
  // 52-byte pattern to D1 and get the statement rejected outright.
  it("measures the cap in UTF-8 bytes, so a multi-byte query crosses it sooner", async () => {
    seedFoodbank({ name: `Larder ${"é".repeat(25)}`, slug: "accents" });

    expect(new TextEncoder().encode(`%${"é".repeat(24)}%`)).toHaveLength(50);
    expect(new TextEncoder().encode(`%${"é".repeat(25)}%`)).toHaveLength(52);

    expect((await search("é".repeat(24))).foodbanks.map((f) => f.slug)).toEqual(["accents"]);
    expect((await search("é".repeat(25))).foodbanks.map((f) => f.slug)).toEqual(["accents"]);
  });

  // WHY asciiLower() EXISTS, and the mutant it kills. SQLite's lower() folds
  // A-Z and nothing else, so lower('Ärhusgade') keeps its capital A-umlaut.
  // A JS toLowerCase() needle would arrive as 'ärhusgade', find no match, and
  // the food bank would vanish from the search results of the only people who
  // would ever look for it. Swap asciiLower for toLowerCase and this fails.
  it("folds only the ASCII range in instr() mode, exactly as SQLite's lower() does", async () => {
    const name = "Ärhusgade Community Food Larder And Pantry Project";
    seedFoodbank({ name, slug: "arhusgade" });

    expect(new TextEncoder().encode(`%${name}%`).length).toBeGreaterThan(50);
    expect((await search(name)).foodbanks.map((f) => f.slug)).toEqual(["arhusgade"]);
    // ASCII case still folds, in the same query, so the fold is narrowed and
    // not simply removed.
    expect((await search(name.toUpperCase())).foodbanks.map((f) => f.slug)).toEqual(["arhusgade"]);
  });

  // The same limit on the LIKE side, pinned because it is a limit rather than
  // a feature: SQLite's LIKE is case-insensitive for ASCII only, so an admin
  // searching "arhus" in lower case does not find "Ärhus". Django on Postgres
  // DOES find it -- UPPER() there is locale-aware -- so this is a real parity
  // gap, faithful to the engine and recorded rather than hidden.
  it("does not fold non-ASCII case in LIKE mode either", async () => {
    seedFoodbank({ name: "Ärhus Larder", slug: "arhus" });

    expect((await search("Ärhus")).foodbanks.map((f) => f.slug)).toEqual(["arhus"]);
    expect((await search("ärhus")).foodbanks).toEqual([]);
  });

  // SUSPECT, PINNED AS-IS. ?2 (the exact-match test) is `query.toLowerCase()`
  // -- JavaScript's full-Unicode fold -- while the column side is SQLite's
  // ASCII-only lower(). So for a name holding a non-ASCII letter the two can
  // never be equal, and typing the name exactly gets band 1 (prefix) instead of
  // band 0 (exact). Asserted as it behaves, not as it should; see suspectedBugs.
  //
  // A prefix row is always an EXTENSION of the query, so it can never sort
  // ahead of the exact row on name -- which means the only way to see the two
  // bands come apart is is_closed. The exact row is closed in both halves
  // below, so band 0 pulls it ahead of an open row and band 1 does not.
  it("cannot reach the exact-match band for a name containing a non-ASCII letter", async () => {
    const accented = "Ärhusgade Community Food Larder And Pantry Project";
    seedFoodbank({ name: accented, slug: "arhusgade", is_closed: 1 });
    seedFoodbank({ name: `${accented} Annexe`, slug: "arhusgade-annexe" });

    // Both rows land in band 1, so the OPEN annexe wins on is_closed.
    expect((await search(accented)).foodbanks.map((f) => f.slug)).toEqual(["arhusgade-annexe", "arhusgade"]);

    // The ASCII control, identical in every other respect: here the exact row
    // really does reach band 0, and a band beats is_closed, so the closed row
    // comes first. The day ?2 folds the same range the column does, the two
    // halves of this test agree and this one fails.
    const plain = "Zeta Community Food Larder And Pantry Project Wing";
    seedFoodbank({ name: plain, slug: "zeta", is_closed: 1 });
    seedFoodbank({ name: `${plain} Annexe`, slug: "zeta-annexe" });
    expect((await search(plain)).foodbanks.map((f) => f.slug)).toEqual(["zeta", "zeta-annexe"]);
  });
});

describe("locations, read through foodbanklocation_full", () => {
  // Migration 0019 dropped foodbanklocation.foodbank_name/foodbank_slug and
  // put them back as a LEFT JOIN in the view, because the stored copies went
  // stale on a rename: 24 production rows disagreed with their parent's slug
  // and name. That is the migration whose four silently-broken queries this
  // whole tier exists to prevent a repeat of.
  it("takes foodbank_name and foodbank_slug from the parent through the view", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", slug: "salisbury" });
    seedLocation({ foodbank_id: salisbury, name: "Bemerton Heath Centre", slug: "bemerton-heath-centre" });

    expect((await search("bemerton")).locations).toEqual([
      {
        name: "Bemerton Heath Centre",
        slug: "bemerton-heath-centre",
        foodbank_name: "Salisbury",
        foodbank_slug: "salisbury",
        is_closed: 0,
      },
    ]);
  });

  // LEFT JOIN, NOT JOIN -- 0019's own emphasis. D1 has no foreign keys, so
  // nothing enforces that a location's parent exists; an INNER JOIN would drop
  // an orphan silently, which is precisely the row an admin searching for a
  // mess most needs to see. Two children and a childless parent, so an
  // INNER/LEFT swap changes the row COUNT and not just a column.
  it("keeps a location whose parent food bank is missing, with a NULL parent name", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", slug: "salisbury" });
    seedFoodbank({ name: "Childless", slug: "childless" });
    seedLocation({ foodbank_id: salisbury, name: "Bemerton A", slug: "bemerton-a" });
    seedLocation({ foodbank_id: salisbury, name: "Bemerton B", slug: "bemerton-b" });
    seedLocation({ foodbank_id: 9999, name: "Bemerton Orphan", slug: "bemerton-orphan" });

    const { locations } = await search("bemerton");
    expect(locations.map((l) => l.slug)).toEqual(["bemerton-a", "bemerton-b", "bemerton-orphan"]);
    expect(locations.map((l) => l.foodbank_name)).toEqual(["Salisbury", "Salisbury", null]);
  });

  // All four of LOCATION_SEARCH_COLUMNS, one row each. Django searches slug,
  // name, address and postcode on locations (views.py:132-137); address and
  // postcode were the two nothing else in this file exercised, and a column
  // quietly dropped from the list is a location an admin can no longer find by
  // the only detail they have -- with no error anywhere to say so. Postcode
  // especially: it is how you find the room when nobody remembers its name.
  it("searches a location's slug, name, address and postcode", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", slug: "salisbury" });
    seedLocation({ foodbank_id: salisbury, name: "By Slug", slug: "finds-via-slug" });
    seedLocation({ foodbank_id: salisbury, name: "Finds Via Name", slug: "by-name" });
    seedLocation({ foodbank_id: salisbury, name: "By Address", slug: "by-address", address: "12 Finds Via Address Road" });
    seedLocation({ foodbank_id: salisbury, name: "By Postcode", slug: "by-postcode", postcode: "FINDSVIAPOSTCODE" });

    expect((await search("finds-via-slug")).locations.map((l) => l.slug)).toEqual(["finds-via-slug"]);
    expect((await search("finds via name")).locations.map((l) => l.slug)).toEqual(["by-name"]);
    expect((await search("finds via address")).locations.map((l) => l.slug)).toEqual(["by-address"]);
    expect((await search("findsviapostcode")).locations.map((l) => l.slug)).toEqual(["by-postcode"]);
  });

  // The parent's name is IN the view but NOT in LOCATION_SEARCH_COLUMNS, and
  // that asymmetry is deliberate: searching a food bank's name returns the food
  // bank, not its 1,972 locations. Adding foodbank_name to the column list
  // would flood the locations group on every food bank search, and no test that
  // only seeds matching rows would notice.
  it("does not match a location on its parent's name", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", slug: "salisbury" });
    seedLocation({ foodbank_id: salisbury, name: "The Kitchen", slug: "the-kitchen", address: "9 Back Lane", postcode: "SP2 2BB" });

    const results = await search("salisbury");
    expect(results.foodbanks.map((f) => f.slug)).toEqual(["salisbury"]);
    expect(results.locations).toEqual([]);
  });

  // Open before closed, then collator order -- and NOT the SQL's
  // `is_closed, foodbank_name, name`. sortChildren re-sorts by name alone, so
  // two food banks' locations INTERLEAVE in the display. Pinned because it is a
  // deliberate divergence from the statement two lines above it in the source,
  // and a future reader could easily "fix" the one to match the other.
  it("shows open before closed and interleaves food banks by location name", async () => {
    const alpha = seedFoodbank({ name: "Alpha Foodbank", slug: "alpha" });
    const zulu = seedFoodbank({ name: "Zulu Foodbank", slug: "zulu" });
    seedLocation({ foodbank_id: alpha, name: "Bemerton Middle", slug: "bemerton-middle" });
    seedLocation({ foodbank_id: zulu, name: "Bemerton Early", slug: "bemerton-early" });
    seedLocation({ foodbank_id: alpha, name: "Bemerton Shut", slug: "bemerton-shut", is_closed: 1 });

    const { locations } = await search("bemerton");
    expect(locations.map((l) => l.slug)).toEqual(["bemerton-early", "bemerton-middle", "bemerton-shut"]);
    // Grouped by food bank it would be Alpha's two then Zulu's; it is not.
    expect(locations.map((l) => l.foodbank_slug)).toEqual(["zulu", "alpha", "alpha"]);
  });

  it("caps the group at 100 rows", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", slug: "salisbury" });
    for (let i = 1; i <= 105; i += 1) {
      const n = `${i}`.padStart(3, "0");
      seedLocation({ foodbank_id: salisbury, name: `Room ${n}`, slug: `room-${n}` });
    }

    expect((await search("room")).locations).toHaveLength(100);
  });

  // THE MIDDLE KEY, `foodbank_name`, WHICH ONLY EXISTS TO BREAK TIES ACROSS
  // PARENTS. sortChildren re-sorts the survivors by location name alone, so
  // this key changes nothing an admin sees except WHICH food banks' locations
  // made the 100 -- and every earlier fixture here gives each parent a
  // different set of location names, where it therefore does nothing at all.
  //
  // Three parents each with the same 35 room names is the shape that makes it
  // visible: ordered by parent, Alpha and Bravo are complete and Charlie is
  // cut short. Ordered by room name instead, all three are cut short and every
  // food bank looks like it is missing rooms.
  //
  // MUTANTS: drop `foodbank_name` (33/33/34 instead of 35/35/30); put `name`
  // ahead of it (same); order by `foodbank_slug`, the column right beside it in
  // the view, which reverses the three parents because their slugs deliberately
  // do not sort like their names.
  it("fills the 100 parent by parent, ordered by the parent's NAME not its slug", async () => {
    const parents = seedThreeParents();
    for (const parent of parents) {
      for (let i = 1; i <= 35; i += 1) {
        const n = `${i}`.padStart(3, "0");
        seedLocation({ foodbank_id: parent.id, name: `Sharedroom ${n}`, slug: `${parent.slug}-sharedroom-${n}` });
      }
    }

    const { locations } = await search("sharedroom");
    expect(locations).toHaveLength(100);
    expect(parents.map((parent) => locations.filter((l) => l.foodbank_slug === parent.slug).length)).toEqual([35, 35, 30]);
  });

  // WHY is_closed LEADS THE SQL ORDER BY AND NOT JUST THE JS RE-SORT. The two
  // do different jobs: the SQL one decides WHICH 100 rows survive the LIMIT,
  // the JS one only reorders the survivors. Drop is_closed from the statement
  // and the JS sort still puts open before closed, every existing assertion
  // still passes -- and an open location silently stops appearing at all
  // because 100 closed ones sorted ahead of it and used up the slice.
  //
  // The closed rows are named so they sort FIRST without the is_closed key, so
  // this fails the moment the key goes. The donation point statement is
  // identical and depends on the same thing.
  it("never lets closed locations crowd an open one out of the 100", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", slug: "salisbury" });
    for (let i = 1; i <= 100; i += 1) {
      const n = `${i}`.padStart(3, "0");
      seedLocation({ foodbank_id: salisbury, name: `Room C${n}`, slug: `room-c${n}`, is_closed: 1 });
    }
    for (let i = 1; i <= 5; i += 1) {
      seedLocation({ foodbank_id: salisbury, name: `Room Z00${i}`, slug: `room-z00${i}` });
    }

    const { locations } = await search("room");
    expect(locations).toHaveLength(100);
    expect(locations.filter((l) => l.is_closed === 0).map((l) => l.slug)).toEqual([
      "room-z001",
      "room-z002",
      "room-z003",
      "room-z004",
      "room-z005",
    ]);
  });
});

describe("donation points, and the slug asymmetry Django has", () => {
  // views.py:132-143. Locations are searched on slug; donation points are NOT.
  // The asymmetry is real, it is Django's, and it is preserved -- so a slug
  // typed into the box finds the location and not the donation point that
  // shares it. The two rows below differ ONLY in which table they are in, which
  // is the only way to state this claim without it passing by accident.
  it("searches a location's slug but not a donation point's", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", slug: "salisbury" });
    seedLocation({ foodbank_id: salisbury, name: "Old Manor", slug: "annexe-42" });
    seedDonationPoint({ foodbank_id: salisbury, name: "Old Depot", slug: "annexe-42" });

    const results = await search("annexe-42");
    expect(results.locations.map((l) => l.slug)).toEqual(["annexe-42"]);
    expect(results.donationpoints).toEqual([]);
  });

  it("searches a donation point's name, address and postcode", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", slug: "salisbury" });
    seedDonationPoint({ foodbank_id: salisbury, name: "Tesco Churchfields", slug: "tesco-1" });
    seedDonationPoint({ foodbank_id: salisbury, name: "Co-op", slug: "coop-1", address: "3 Churchfields Road" });
    seedDonationPoint({ foodbank_id: salisbury, name: "Spar", slug: "spar-1", postcode: "CHURCHFIELDS9" });

    expect((await search("churchfields")).donationpoints.map((d) => d.slug).sort()).toEqual(["coop-1", "spar-1", "tesco-1"]);
  });

  // Same LEFT JOIN as locations, same reason -- foodbankdonationpoint_full is
  // 0019's other view and the 5,744-row table is the one most likely to hold
  // an orphan after a food bank is deleted.
  it("keeps an orphaned donation point, with a NULL parent name", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", slug: "salisbury" });
    seedDonationPoint({ foodbank_id: salisbury, name: "Tesco Churchfields", slug: "tesco-1" });
    seedDonationPoint({ foodbank_id: 9999, name: "Orphan Churchfields", slug: "orphan-1" });

    const { donationpoints } = await search("churchfields");
    expect(donationpoints.map((d) => d.slug)).toEqual(["orphan-1", "tesco-1"]);
    expect(donationpoints.map((d) => d.foodbank_name)).toEqual([null, "Salisbury"]);
  });

  it("shows open before closed, in collator name order", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", slug: "salisbury" });
    seedDonationPoint({ foodbank_id: salisbury, name: "aldi Churchfields", slug: "aldi" });
    seedDonationPoint({ foodbank_id: salisbury, name: "Tesco Churchfields", slug: "tesco" });
    seedDonationPoint({ foodbank_id: salisbury, name: "Boots Churchfields", slug: "boots", is_closed: 1 });

    expect((await search("churchfields")).donationpoints.map((d) => d.slug)).toEqual(["aldi", "tesco", "boots"]);
  });

  // THE STATEMENT ABOVE THIS ONE IN THE SOURCE HAS THE SAME SHAPE AS THE
  // LOCATION STATEMENT AND WAS THE ONLY GROUP WITH NO LIMIT TEST AT ALL --
  // `LIMIT 100` could have been deleted from it outright and every other
  // assertion in this file would still have passed. foodbankdonationpoint is
  // the biggest of these tables at 5,744 rows, and "Tesco" alone matches
  // hundreds of them, so it is also the group most likely to hit the cap in
  // production.
  //
  // Same crowding shape as the locations test, and for the same reason: the SQL
  // `is_closed` key decides which 100 rows survive, the JS re-sort only reorders
  // the ones that did. The closed names sort FIRST without it, so its removal is
  // an open donation point that silently stops appearing.
  it("caps the group at 100 and never lets closed points crowd an open one out", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", slug: "salisbury" });
    for (let i = 1; i <= 100; i += 1) {
      const n = `${i}`.padStart(3, "0");
      seedDonationPoint({ foodbank_id: salisbury, name: `Depot C${n} Churchfields`, slug: `depot-c${n}`, is_closed: 1 });
    }
    for (let i = 1; i <= 5; i += 1) {
      seedDonationPoint({ foodbank_id: salisbury, name: `Depot Z00${i} Churchfields`, slug: `depot-z00${i}` });
    }

    const { donationpoints } = await search("churchfields");
    expect(donationpoints).toHaveLength(100);
    expect(donationpoints.filter((d) => d.is_closed === 0).map((d) => d.slug)).toEqual([
      "depot-z001",
      "depot-z002",
      "depot-z003",
      "depot-z004",
      "depot-z005",
    ]);
  });

  // The donation point twin of the locations middle-key test. The two
  // statements are separate strings that only LOOK identical, which is exactly
  // how this group ended up with no LIMIT test of its own -- so `foodbank_name`
  // gets asserted here too rather than assumed to follow.
  it("fills the 100 parent by parent, ordered by the parent's NAME not its slug", async () => {
    const parents = seedThreeParents();
    for (const parent of parents) {
      for (let i = 1; i <= 35; i += 1) {
        const n = `${i}`.padStart(3, "0");
        seedDonationPoint({ foodbank_id: parent.id, name: `Shareddepot ${n}`, slug: `${parent.slug}-shareddepot-${n}` });
      }
    }

    const { donationpoints } = await search("shareddepot");
    expect(donationpoints).toHaveLength(100);
    expect(parents.map((parent) => donationpoints.filter((d) => d.foodbank_slug === parent.slug).length)).toEqual([35, 35, 30]);
  });
});

describe("constituencies", () => {
  // F9. parliamentaryconstituency.boundary_geojson runs to 1,568 kB per row;
  // `SELECT *` over 100 of them would be 150 MB through a Worker to render two
  // columns. The explicit column list is not tidiness, it is the difference
  // between a page and an outage -- and the only way to catch a `SELECT *`
  // creeping back in is to assert the row has exactly two keys.
  it("returns name and slug only, never the 1.5 MB boundary_geojson", async () => {
    seedConstituency({ name: "Salisbury", slug: "salisbury", mp: "John Glen", boundary_geojson: "x".repeat(2000) });

    const { constituencies } = await search("salisbury");
    expect(constituencies).toEqual([{ name: "Salisbury", slug: "salisbury" }]);
  });

  // `mp` is searched and never displayed, exactly as in Django (views.py:145-148
  // filters on it; admin/search.html shows the constituency). Dropping it from
  // the WHERE would break the one way an admin finds a seat by its member's
  // name, and nothing on the rendered page would look any different.
  it("finds a constituency by its MP's name without returning the MP", async () => {
    seedConstituency({ name: "Salisbury", slug: "salisbury", mp: "John Glen" });
    seedConstituency({ name: "Bristol West", slug: "bristol-west", mp: "Someone Else" });

    const { constituencies } = await search("John Glen");
    expect(constituencies).toEqual([{ name: "Salisbury", slug: "salisbury" }]);
  });

  // F6 for this group, and the only thing that proves sortConstituencies runs
  // at all. Its SQL already orders by name, so on any corpus whose byte order
  // and collator order agree the JS re-sort is invisible and deleting it
  // changes nothing -- the rows come back in the same order either way. Mixed
  // case is what separates them: SQLite's default collation is byte-wise, so
  // every capital sorts ahead of every lowercase.
  it("re-sorts constituencies with the JS collator, not SQLite's byte order", async () => {
    seedConstituency({ name: "Zebra Salisbury", slug: "zebra", mp: "A" });
    seedConstituency({ name: "aa Salisbury", slug: "aa", mp: "B" });
    seedConstituency({ name: "North Salisbury", slug: "north", mp: "C" });

    // Proved rather than asserted from memory, so this cannot pass by accident
    // on a build where the two orders agree.
    const byteOrder = db.prepare("SELECT name FROM parliamentaryconstituency ORDER BY name").all() as { name: string }[];
    expect(byteOrder.map((row) => row.name)).toEqual(["North Salisbury", "Zebra Salisbury", "aa Salisbury"]);
    expect((await search("salisbury")).constituencies.map((c) => c.slug)).toEqual(["aa", "north", "zebra"]);
  });

  // parliamentaryconstituency.name is NULLABLE (0001_core.sql:131). Two things
  // have to survive that: the SQL's `ORDER BY (name IS NULL), name`, and
  // sortConstituencies, which sorts a `name ?? slug` PROJECTION rather than
  // coalescing the value it displays -- sortByName would throw on a null name,
  // and coalescing would put the slug on the page as if it were the seat's
  // name. Both are asserted here: the null comes back as null, and the row
  // sorts under its slug.
  it("keeps a NULL-named constituency, sorting it under its slug", async () => {
    seedConstituency({ name: "Salisbury", slug: "salisbury", mp: "John Glen" });
    seedConstituency({ name: null, slug: "vacant-seat", mp: "Jo Salisbury" });
    seedConstituency({ name: "Salisbury Plain", slug: "salisbury-plain", mp: "Another" });

    expect((await search("salisbury")).constituencies).toEqual([
      { name: "Salisbury", slug: "salisbury" },
      { name: "Salisbury Plain", slug: "salisbury-plain" },
      { name: null, slug: "vacant-seat" },
    ]);
  });

  // WHAT `(name IS NULL)` IS ACTUALLY FOR, which the three-row case above
  // cannot show: SQLite sorts NULL FIRST, so without the guard a handful of
  // unnamed seats would take the first slots of the LIMIT and push named ones
  // out of the result set entirely. The JS re-sort happens afterwards and can
  // only reorder the 100 rows that survived, so it cannot put them back. 105
  // rows, five of them unnamed -- exactly the shape that makes the difference
  // visible.
  it("lets named constituencies win the LIMIT over unnamed ones", async () => {
    // The unnamed seats are seeded FIRST, so they hold the lowest rowids and a
    // statement with NO ORDER BY at all keeps them -- otherwise SQLite's scan
    // order happens to agree with the right answer and the whole ORDER BY can be
    // deleted with this test still green.
    for (let i = 1; i <= 5; i += 1) {
      seedConstituency({ name: null, slug: `vacant-${i}`, mp: "Member for Salisbury" });
    }
    for (let i = 1; i <= 100; i += 1) {
      const n = `${i}`.padStart(3, "0");
      seedConstituency({ name: `Seat ${n}`, slug: `seat-${n}`, mp: "Member for Salisbury" });
    }

    const { constituencies } = await search("salisbury");
    expect(constituencies).toHaveLength(100);
    expect(constituencies.filter((c) => c.name === null)).toEqual([]);
  });
});

describe("needs, read through foodbankchange_full", () => {
  // 32-char dashless hex, the shape 0001_core.sql:111 documents.
  const NEED_IDS = [
    "0f3c1a9b4e5d6c7a8b9c0d1e2f3a4b5c",
    "1a2b3c4d5e6f708192a3b4c5d6e7f809",
    "2b3c4d5e6f708192a3b4c5d6e7f80912",
    "3c4d5e6f708192a3b4c5d6e7f8091223",
  ];

  // Django-format timestamps, deliberately. These columns are TEXT and SQLite
  // compares TEXT byte by byte, so `ORDER BY created DESC` is only chronological
  // while every value shares one format -- which is what migration 0022 went
  // and made true. Two of the four are on the same DAY so that an ordering that
  // only compared dates would still fail here.
  function seedNeedCorpus(salisbury: number): void {
    seedNeed({ need_id: NEED_IDS[0]!, foodbank_id: salisbury, change_text: "Tinned beans", created: "2026-09-01 10:00:00.000000" });
    seedNeed({
      need_id: NEED_IDS[1]!,
      foodbank_id: null,
      change_text: "Nothing",
      excess_change_text: "Too many beans",
      created: "2026-09-03 09:00:00.000000",
    });
    seedNeed({
      need_id: NEED_IDS[2]!,
      foodbank_id: salisbury,
      change_text: "Baked beans",
      created: "2026-09-02 23:00:00.000000",
      published: 0,
      nonpertinent: 1,
    });
    seedNeed({ need_id: NEED_IDS[3]!, foodbank_id: salisbury, change_text: "Beans please", created: "2026-09-03 08:00:00.000000" });
  }

  it("orders by created DESC, resolving two needs on the same day by their time", async () => {
    seedNeedCorpus(seedFoodbank({ name: "Salisbury", slug: "salisbury" }));

    expect((await search("beans")).needs.map((n) => n.need_id)).toEqual([NEED_IDS[1], NEED_IDS[3], NEED_IDS[2], NEED_IDS[0]]);
  });

  // The needs group is the ONLY one Django orders, and the only one this module
  // does not re-sort in JS -- so the SQL order is the display order, and a
  // stray sortByName here would silently replace "newest first" with
  // "alphabetical by need id".
  it("leaves the SQL order alone rather than re-sorting by name", async () => {
    seedNeedCorpus(seedFoodbank({ name: "Salisbury", slug: "salisbury" }));

    const ids = (await search("beans")).needs.map((n) => n.need_id);
    expect(ids).not.toEqual([...ids].sort());
  });

  // excess_change_text is the second searched column and the one an admin
  // reaches for when a food bank says it has TOO MUCH of something. NEED_IDS[1]
  // matches on it alone -- its change_text is the 'Nothing' sentinel.
  it("searches excess_change_text as well as change_text", async () => {
    seedNeedCorpus(seedFoodbank({ name: "Salisbury", slug: "salisbury" }));

    expect((await search("Too many")).needs.map((n) => n.need_id)).toEqual([NEED_IDS[1]]);
  });

  // Same LEFT JOIN point as locations, and 0019 calls this one out by name:
  // foodbankchange.foodbank_id is NULLABLE -- an unassigned need -- so an INNER
  // JOIN would drop exactly the rows an admin comes to this page to assign.
  it("keeps an unassigned need, with a NULL foodbank_name", async () => {
    seedNeedCorpus(seedFoodbank({ name: "Salisbury", slug: "salisbury" }));

    const { needs } = await search("beans");
    expect(needs.map((n) => n.foodbank_name)).toEqual([null, "Salisbury", "Salisbury", "Salisbury"]);
  });

  // No published / nonpertinent filter, same as Django. NEED_IDS[2] is both
  // unpublished and non-pertinent and still comes back; a filter added here
  // "for tidiness" would hide the unpublished needs this page exists to find.
  it("returns unpublished and non-pertinent needs", async () => {
    seedNeedCorpus(seedFoodbank({ name: "Salisbury", slug: "salisbury" }));

    expect((await search("beans")).needs.map((n) => n.need_id)).toContain(NEED_IDS[2]);
  });

  // F9 again, and the biggest one: foodbankchange's four large text columns are
  // what make the table 29.4 MB across 33,931 rows, and nothing on this page
  // renders them. `created` is not selected either -- it exists in the
  // statement only to order by. need_id_short is the one computed field:
  // FoodbankChange.need_id_short() is str(need_id)[:7] (needs.py:81-82).
  it("returns four fields only, with the 7-character short id Django's model computes", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", slug: "salisbury" });
    seedNeed({
      need_id: NEED_IDS[0]!,
      foodbank_id: salisbury,
      change_text: "Tinned beans",
      created: "2026-09-01 10:00:00.000000",
      modified: "2026-09-04 11:22:33.444000",
    });

    expect((await search("beans")).needs).toEqual([
      {
        need_id: NEED_IDS[0],
        need_id_short: "0f3c1a9",
        foodbank_name: "Salisbury",
        // `modified` is what the template displays even though `created` is
        // what the query orders by. Django does the same, and both are kept.
        modified: "2026-09-04 11:22:33.444000",
      },
    ]);
  });

  // THE GROUP WITH THE LARGEST TABLE BEHIND IT AND, UNTIL THIS TEST, NO LIMIT
  // TEST AT ALL. foodbankchange is 33,931 rows and 29.4 MB (PLAN.md §7.1), so a
  // deleted `LIMIT 100` here is not a cosmetic overrun -- an admin searching
  // "beans" would pull thousands of rows through the Worker for a page that
  // shows a hundred. The five oldest needs are seeded FIRST so that a statement
  // with no ORDER BY keeps them in scan order: that makes this a test of which
  // 100 survive, not just of how many.
  it("caps needs at 100, and created DESC decides which 100", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", slug: "salisbury" });
    for (let i = 1; i <= 5; i += 1) {
      seedNeed({
        need_id: `old${i}`.padEnd(32, "0"),
        foodbank_id: salisbury,
        change_text: "Beans wanted",
        created: `2026-08-0${i} 09:00:00.000000`,
      });
    }
    for (let i = 1; i <= 100; i += 1) {
      seedNeed({
        need_id: `new${`${i}`.padStart(3, "0")}`.padEnd(32, "0"),
        foodbank_id: salisbury,
        change_text: "Beans wanted",
        created: "2026-09-01 10:00:00.000000",
      });
    }

    const { needs, total } = await search("beans");
    expect(needs).toHaveLength(100);
    expect(total).toBe(100);
    expect(needs.filter((n) => n.need_id.startsWith("old"))).toEqual([]);
  });

  // THE HAZARD MIGRATION 0022 EXISTS FOR, executed rather than described. 'T'
  // is 0x54 and space is 0x20, so within a single day EVERY toISOString() value
  // sorts after EVERY Django value regardless of the real time. Here the ISO
  // row is chronologically the EARLIEST of the three and comes back FIRST under
  // `ORDER BY created DESC`. This is not a defect in adminSearch -- it is the
  // reason adminSearch is allowed to trust an ORDER BY on a TEXT column at all,
  // and if a new write path ever starts writing ISO into foodbankchange.created
  // again, this is what that regression looks like.
  it("sorts a stray ISO-format created value wrongly, which is why 0022 normalised them", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", slug: "salisbury" });
    seedNeed({ need_id: NEED_IDS[0]!, foodbank_id: salisbury, change_text: "Beans A", created: "2026-09-01 10:00:00.000000" });
    seedNeed({ need_id: NEED_IDS[1]!, foodbank_id: salisbury, change_text: "Beans B", created: "2026-09-02 10:00:00.000000" });
    // 08:00 on the 1st: earlier than both of the above.
    seedNeed({ need_id: NEED_IDS[2]!, foodbank_id: salisbury, change_text: "Beans C", created: "2026-09-01T08:00:00.000Z" });

    expect((await search("beans")).needs.map((n) => n.need_id)).toEqual([NEED_IDS[1], NEED_IDS[2], NEED_IDS[0]]);
  });
});

describe("subscriptions", () => {
  // F7. The food bank name and slug come from a JOIN, never from a
  // denormalised copy -- 0019 dropped foodbanksubscriber.foodbank_name for the
  // same reason it dropped the others, and Django's own foodbank_slug() is
  // slugify() over that stale copy, so it only agreed with reality while the
  // copy was current.
  it("takes the food bank name and slug from the join, for all three types", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", slug: "salisbury" });
    seedEmailSub({ foodbank_id: salisbury, email: "alice@example.org" });
    seedMobileSub({ foodbank_id: salisbury, device_id: "alice-device", platform: "ios" });
    seedWebpushSub({ foodbank_id: salisbury, endpoint: "https://push/alice", browser: "Firefox" });

    const { subscriptions } = await search("alice");
    expect(subscriptions.map((s) => s.foodbank_name)).toEqual(["Salisbury", "Salisbury", "Salisbury"]);
    expect(subscriptions.map((s) => s.foodbank_slug)).toEqual(["salisbury", "salisbury", "salisbury"]);
  });

  // Django appends email, then WhatsApp, then mobile, then webpush, and never
  // re-sorts across the types (views.py:155-219); neither does this. The icons
  // are the mdi NAMES from views.py:167/198/214 -- F8 passes a whitelisted name
  // rather than the raw <span> Django puts in its context dict and renders
  // through |safe, so autoescaping stays on for every field on the page.
  it("appends the types in Django's fixed order with Django's own mdi icon names", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", slug: "salisbury" });
    // Seeded in the WRONG order, so a group that sorted by anything but its
    // position in the batch would give itself away.
    seedWebpushSub({ foodbank_id: salisbury, endpoint: "https://push/alice", browser: "Firefox" });
    seedMobileSub({ foodbank_id: salisbury, device_id: "alice-device", platform: "ios" });
    seedEmailSub({ foodbank_id: salisbury, email: "alice@example.org" });

    const { subscriptions } = await search("alice");
    expect(subscriptions.map((s) => s.type)).toEqual(["email", "mobile", "webpush"]);
    expect(subscriptions.map((s) => s.icon)).toEqual(["email", "cellphone", "bell"]);
    // MUTANT: swap results[5] and results[6] in the spread. The types and icons
    // are literals in the spread itself, so they stay in this exact order while
    // the ROWS underneath them change places -- an email address labelled as a
    // mobile device and vice versa, on an admin page whose whole job is telling
    // you who is subscribed to what. Only the identifiers show it.
    expect(subscriptions.map((s) => s.identifier)).toEqual(["alice@example.org", "ios - alice-device", "Firefox - https://push/alice"]);
  });

  // `confirmed = 1`, Django's `Q(confirmed=True)`. An unconfirmed subscriber is
  // someone who typed an address and never clicked the link -- often someone
  // else's address entirely -- and this page must not display it. A predicate
  // that stopped working would only ever be visible as EXTRA rows, so the
  // unconfirmed row is seeded and asserted absent.
  it("returns confirmed email subscribers only", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", slug: "salisbury" });
    seedEmailSub({ foodbank_id: salisbury, email: "alice-yes@example.org", confirmed: 1 });
    seedEmailSub({ foodbank_id: salisbury, email: "alice-no@example.org", confirmed: 0 });

    expect((await search("alice")).subscriptions.map((s) => s.identifier)).toEqual(["alice-yes@example.org"]);
  });

  // INNER JOIN, unlike the three views above -- and matching Django, whose
  // select_related over a non-nullable FK is an inner join too. Recorded as a
  // behaviour rather than endorsed: D1 has no foreign keys, so a subscriber
  // whose food bank has been deleted disappears from this page entirely
  // instead of showing up as the orphan it is.
  //
  // ALL THREE STATEMENTS, not just the email one: they are three separate
  // `JOIN foodbank f ON f.id = s.foodbank_id` clauses, so a careless edit that
  // relaxes one to a LEFT JOIN leaves the other two alone -- and the mobile and
  // webpush ones were, until this test seeded an orphan for each, free to
  // change in either direction. A LEFT JOIN here would put a row on the page
  // with a blank food bank name and a link to /admin/foodbank/null/.
  it("drops a subscriber of ANY type whose food bank row is missing", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", slug: "salisbury" });
    seedEmailSub({ foodbank_id: salisbury, email: "alice@example.org" });
    seedEmailSub({ foodbank_id: 9999, email: "alice-orphan@example.org" });
    seedMobileSub({ foodbank_id: salisbury, device_id: "alice-device", platform: "ios" });
    seedMobileSub({ foodbank_id: 9998, device_id: "alice-orphan-device", platform: "ios" });
    seedWebpushSub({ foodbank_id: salisbury, endpoint: "https://push/alice", browser: "Firefox" });
    seedWebpushSub({ foodbank_id: 9997, endpoint: "https://push/alice-orphan", browser: "Firefox" });

    expect((await search("alice")).subscriptions.map((s) => s.identifier)).toEqual([
      "alice@example.org",
      "ios - alice-device",
      "Firefox - https://push/alice",
    ]);
  });

  it("orders each subscription group by created DESC", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", slug: "salisbury" });
    seedEmailSub({ foodbank_id: salisbury, email: "alice-old@example.org", created: "2026-09-01 09:00:00.000000" });
    seedEmailSub({ foodbank_id: salisbury, email: "alice-new@example.org", created: "2026-09-04 09:00:00.000000" });
    seedEmailSub({ foodbank_id: salisbury, email: "alice-mid@example.org", created: "2026-09-02 09:00:00.000000" });

    expect((await search("alice")).subscriptions.map((s) => s.identifier)).toEqual([
      "alice-new@example.org",
      "alice-mid@example.org",
      "alice-old@example.org",
    ]);
  });

  // views.py:195's `sub.device_id[:20] + "..." if len(...) > 20`. SQLite's
  // length()/substr() count CHARACTERS, which is what makes them equal to
  // Python's len()/[:20]; a byte-counting equivalent would cut a multi-byte id
  // mid-character. The boundary is tested from both sides because `>` and `>=`
  // are one keystroke apart and the difference is invisible on any id that is
  // not exactly 20 long.
  it("truncates a device id at exactly Django's boundary, counting characters", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", slug: "salisbury" });
    const twenty = "devtok01234567890123";
    const twentyOne = "devtok012345678901234";
    expect(twenty).toHaveLength(20);
    expect(twentyOne).toHaveLength(21);
    // Seeded OLDEST FIRST, so rowid order is the reverse of the order asserted
    // below: `ORDER BY s.created DESC` can be deleted from this statement
    // without D1 raising anything, and a fixture whose insertion order happened
    // to match the answer would never notice.
    //
    // 21 CHARACTERS, 27 bytes: substr() must cut at 20 characters, so the
    // ellipsis appears and the last accented character is not split.
    seedMobileSub({ foodbank_id: salisbury, device_id: `devtok${"é".repeat(15)}`, platform: "web", created: "2026-09-01 09:00:00.000000" });
    seedMobileSub({ foodbank_id: salisbury, device_id: twentyOne, platform: "android", created: "2026-09-02 09:00:00.000000" });
    seedMobileSub({ foodbank_id: salisbury, device_id: twenty, platform: "ios", created: "2026-09-03 09:00:00.000000" });

    expect((await search("devtok")).subscriptions.map((s) => s.identifier)).toEqual([
      `ios - ${twenty}`,
      `android - ${twentyOne.slice(0, 20)}...`,
      `web - devtok${"é".repeat(14)}...`,
    ]);
  });

  // views.py:215's `sub.browser or 'Unknown'` is PYTHON TRUTHINESS, so an empty
  // string is 'Unknown' too. A bare COALESCE would pass the empty string
  // through and render " - https://..." with a blank where the browser goes;
  // the CASE is why that does not happen, and the empty-string row is the only
  // thing that tells the two apart.
  it("shows Unknown for a NULL browser AND for an empty-string one", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", slug: "salisbury" });
    // Oldest first again, for the same reason as the device id test: rowid order
    // must disagree with `ORDER BY s.created DESC` or the ORDER BY is untested.
    seedWebpushSub({ foodbank_id: salisbury, endpoint: "https://push/c", browser: "Firefox", created: "2026-09-01 09:00:00.000000" });
    seedWebpushSub({ foodbank_id: salisbury, endpoint: "https://push/b", browser: "", created: "2026-09-02 09:00:00.000000" });
    seedWebpushSub({ foodbank_id: salisbury, endpoint: "https://push/a", browser: null, created: "2026-09-03 09:00:00.000000" });

    expect((await search("push/")).subscriptions.map((s) => s.identifier)).toEqual([
      "Unknown - https://push/a",
      "Unknown - https://push/b",
      "Firefox - https://push/c",
    ]);
  });

  // views.py:211's `sub.endpoint[:30]`, same boundary reasoning as the device
  // id. A push endpoint is ~190 characters in production, so the truncation is
  // the normal case and the untruncated one is the edge.
  it("truncates a push endpoint at exactly 30 characters", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", slug: "salisbury" });
    const thirty = "https://push.example.org/wp001";
    const thirtyOne = "https://push.example.org/wp0012";
    expect(thirty).toHaveLength(30);
    expect(thirtyOne).toHaveLength(31);
    seedWebpushSub({ foodbank_id: salisbury, endpoint: thirty, browser: "Firefox", created: "2026-09-02 09:00:00.000000" });
    seedWebpushSub({ foodbank_id: salisbury, endpoint: thirtyOne, browser: "Firefox", created: "2026-09-01 09:00:00.000000" });

    expect((await search("push.example.org")).subscriptions.map((s) => s.identifier)).toEqual([
      `Firefox - ${thirty}`,
      `Firefox - ${thirty}...`,
    ]);
  });

  // A push endpoint is ~190 characters, which is the case that motivated the
  // instr() fallback in the first place: pasting one is an ordinary thing to do
  // on this page, and it used to be answered with "That search is too long".
  it("finds a subscription by a pasted push endpoint, far past the 50-byte cap", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", slug: "salisbury" });
    const endpoint = `https://fcm.googleapis.com/fcm/send/${"c9F2xK1p".repeat(18)}`;
    expect(endpoint.length).toBeGreaterThan(150);
    seedWebpushSub({ foodbank_id: salisbury, endpoint, browser: "Chrome" });

    const { subscriptions } = await search(endpoint);
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]?.identifier).toBe(`Chrome - ${endpoint.slice(0, 30)}...`);
  });

  // SUSPECT, PINNED AS-IS. Django searches WhatsApp subscribers between email
  // and mobile (views.py:175-187), and adminSearch.ts's closing comment says
  // the branch is not built because "no `whatsappsubscriber` table exists in
  // D1". Migration 0020 created that table -- and says Postgres holds 51 rows
  // -- so the comment is now stale and the WhatsApp group is silently missing
  // from this page. Asserted as it behaves, not as it should; see
  // suspectedBugs.
  it("does not search WhatsApp subscribers, even though 0020 created the table", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", slug: "salisbury" });
    insert("whatsappsubscriber", { id: 1, phone_number: "+447700900123", foodbank_id: salisbury, created: PY_NOW, last_notified: null });

    expect((await search("447700900")).subscriptions).toEqual([]);
  });

  it("caps each subscription group at 100, so all three together can reach 300", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", slug: "salisbury" });
    for (let i = 1; i <= 105; i += 1) {
      const n = `${i}`.padStart(3, "0");
      seedEmailSub({ foodbank_id: salisbury, email: `alice-${n}@example.org` });
      seedMobileSub({ foodbank_id: salisbury, device_id: `alice-${n}`, platform: "ios" });
      seedWebpushSub({ foodbank_id: salisbury, endpoint: `https://push/alice-${n}`, browser: "Firefox" });
    }

    const { subscriptions } = await search("alice");
    expect(subscriptions).toHaveLength(300);
    expect(subscriptions.filter((s) => s.type === "email")).toHaveLength(100);
    expect(subscriptions.filter((s) => s.type === "mobile")).toHaveLength(100);
    expect(subscriptions.filter((s) => s.type === "webpush")).toHaveLength(100);
  });
});

describe("the whole result set", () => {
  // `total` is what the page renders as "N results" and what tells an admin
  // whether their search found anything at all. It is a sum over all six
  // groups, subscriptions counted as one flat list -- so a group omitted from
  // the sum would show a smaller number beside a longer page.
  it("counts every group, including all three subscription types", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury Foodbank", slug: "salisbury" });
    seedLocation({ foodbank_id: salisbury, name: "Salisbury Room", slug: "salisbury-room" });
    seedDonationPoint({ foodbank_id: salisbury, name: "Salisbury Depot", slug: "salisbury-depot" });
    seedConstituency({ name: "Salisbury", slug: "salisbury-con", mp: "John Glen" });
    seedNeed({ need_id: "aaaabbbbccccddddeeeeffff00001111", foodbank_id: salisbury, change_text: "Salisbury needs beans" });
    seedEmailSub({ foodbank_id: salisbury, email: "salisbury@example.org" });
    seedMobileSub({ foodbank_id: salisbury, device_id: "salisbury-device", platform: "ios" });
    seedWebpushSub({ foodbank_id: salisbury, endpoint: "https://push/salisbury", browser: "Firefox" });

    const results = await search("salisbury");
    expect(results.foodbanks).toHaveLength(1);
    expect(results.locations).toHaveLength(1);
    expect(results.donationpoints).toHaveLength(1);
    expect(results.constituencies).toHaveLength(1);
    expect(results.needs).toHaveLength(1);
    expect(results.subscriptions).toHaveLength(3);
    expect(results.total).toBe(8);
  });

  // A query that matches in one table must not drag rows out of the other
  // five. Each group has its own WHERE, and this is the assertion that would
  // fail if one of them lost its predicate entirely -- the failure mode that
  // returns MORE rows and therefore raises nothing.
  it("keeps the six groups independent", async () => {
    const salisbury = seedFoodbank({ name: "Salisbury", slug: "salisbury" });
    seedLocation({ foodbank_id: salisbury, name: "Bemerton Heath Centre", slug: "bemerton-heath-centre" });
    seedDonationPoint({ foodbank_id: salisbury, name: "Tesco Churchfields", slug: "tesco" });
    seedConstituency({ name: "Bristol West", slug: "bristol-west", mp: "Someone" });
    seedNeed({ need_id: "aaaabbbbccccddddeeeeffff00001111", foodbank_id: salisbury, change_text: "Tinned beans" });
    seedEmailSub({ foodbank_id: salisbury, email: "alice@example.org" });

    const results = await search("bemerton");
    expect(results.locations).toHaveLength(1);
    expect(results.foodbanks).toEqual([]);
    expect(results.donationpoints).toEqual([]);
    expect(results.constituencies).toEqual([]);
    expect(results.needs).toEqual([]);
    expect(results.subscriptions).toEqual([]);
    expect(results.total).toBe(1);
  });
});
