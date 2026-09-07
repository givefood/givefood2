// @ts-ignore -- node:sqlite has no types under this package's tsconfig, whose
// `"types": ["@cloudflare/workers-types"]` deliberately excludes @types/node
// (adminLists.test.ts and foodbankAdmin.test.ts carry the same note). The
// import works at runtime -- vitest runs this file in a node environment --
// and the cast in beforeEach is the whole cost of getting a real SQL engine
// in here. `@ts-ignore` rather than `@ts-expect-error`: if someone later adds
// @types/node to this package, an expect-error directive would itself become
// the error and break `pnpm typecheck` for everyone.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOrderGroupBySlug, getOrderGroupOrders, getOrderGroupsPage, upsertOrderGroup } from "./orderGroupAdmin";
import type { Session } from "./types";

// orderGroupAdmin.ts is five statements and a slugify. Nothing in it can
// throw on a wrong query: a broken ORDER BY still returns rows, an INNER
// JOIN where a LEFT JOIN belongs still returns rows, a missing WHERE still
// returns rows. They are just the WRONG rows, on a page that renders fine.
// Migration 0019 is this repo's own scar -- four queries kept naming columns
// it had dropped and /dashboard/beautybanks/ was a silent 500 nobody noticed
// until it was measured. So this file runs the real SQL against a real
// in-memory SQLite built from packages/db/migrations, and asserts ROWS:
// which slugs, in which order, with which values.
//
// WHY IT MATTERS MORE HERE THAN ON MOST LIST PAGES. getOrderGroupOrders is
// deliberately unbounded because the detail page's six totals (items,
// weight, calories, cost, and the order count) are summed in JavaScript from
// exactly the rows it returns -- routes/admin/orderGroup.ts:172-177. A LIMIT
// sneaking in, an INNER JOIN dropping the unassigned orders, or a filter that
// leaks another group's orders does not produce an error; it produces a
// number on a page, wrong, with no way to tell from looking at it.
//
// MUTATION-TESTED, per TESTING.md, twice: once as this file was written and
// again in an adversarial review pass that assumed it was weaker than it
// looked. 82 plausible wrong implementations were built in a scratchpad and
// this file re-run against each. Among the ones that went red first time:
// `created DESC` -> `ASC`, `ORDER BY o.delivery_datetime` -> `DESC`,
// `LEFT JOIN` -> `JOIN`, the `order_group_id = ?` filter deleted, the
// collision pre-check deleted and inverted, `.bind(pageSize, offset)`
// swapped, `hasNext`'s `<` -> `<=`, `pyNow()` -> `toISOString()`, the
// empty-slug guard removed, the UPDATE's `WHERE id = ?` -> `IS NOT ?`, the
// UPDATE also rewriting `created`, the COUNT picking up the page's bound,
// `COUNT(*)` -> `COUNT(key)`, `weight`/`calories` swapped in the SELECT
// list, `slug = ?` -> a LIKE prefix, and a `LIMIT 100` added to
// getOrderGroupOrders.
//
// FIVE SURVIVED that pass, and the tests naming them below were added to
// close them: a `f.is_closed = 0` predicate added to the join and to the
// WHERE, an `f.is_school IS NULL` one added to the join, `existingId ===
// undefined` relaxed to `!existingId`, and slugify's ASCII strip deleted.
// Every one was invisible because the fixture only ever seeded rows that
// matched -- open food banks, ids from 1, names whose non-ASCII characters
// `[^\w\s-]` would have removed anyway. That is the failure mode to watch
// for when adding to this file, and the reason the seeds below deliberately
// include a closed food bank, an order outside England, and a group at id 0.
//
// Four further mutants survive and are left alive on purpose, because they
// do not change behaviour: adding `, id ASC` / `, o.order_id` as an ORDER BY
// tiebreak, computing `hasNext` from `result.results.length` instead of
// `pageSize`, and deleting the COMBINING_MARKS_RE replace -- U+0300-U+036F
// are all non-ASCII, so the ASCII strip on the next line already subsumes
// it. That last one means orderGroupAdmin.ts:92-97's combining-mark pass is
// dead code; harmless, and noted here rather than in a test that would
// assert nothing.
//
// THE D1 100-PARAMETER LIMIT does not bite in this module: no function here
// builds a variable-length IN list or chunks its bindings. The most any
// statement binds is six (upsertOrderGroup's INSERT). If a future change
// adds an IN list -- "orders in any of these groups", say -- it needs its own
// tests at 100 and 101 bindings, because D1 rejects the statement outright
// at 101 while SQLite locally does not.

// ---------------------------------------------------------------------------
// The schema, copied from the migrations rather than inferred from the
// TypeScript interfaces above the functions -- catching a disagreement
// between the two is half the reason for running real SQL at all.
//
// `ordergroup` is 0015_ordergroup.sql:41-51 verbatim, unique index included.
// That index is load-bearing for the collision tests: without it a missing
// pre-check would quietly write a second row instead of raising, and every
// "refuses the duplicate" test below would pass against code that refuses
// nothing. There is a test at the bottom of the upsert block that proves the
// index really is here.
//
// `orders` is 0005_orders_and_charity.sql:19-35 plus 0015's partial index on
// order_group_id. `foodbank` is 0001_core.sql:10-55 in full (0019 dropped
// the cached `foodbank_*` copies from the CHILD tables, never from this
// one) -- kept whole rather than trimmed to the two columns the join reads,
// so that a rename on the parent table surfaces here as "no such column"
// rather than as a test that was written against a made-up table.
// ---------------------------------------------------------------------------
const SCHEMA = `
-- 0015_ordergroup.sql:41-50
CREATE TABLE ordergroup (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  public INTEGER NOT NULL DEFAULT 0,
  key TEXT,
  created TEXT NOT NULL,
  modified TEXT NOT NULL
);
CREATE UNIQUE INDEX ordergroup_slug_uniq ON ordergroup(slug);

-- 0005_orders_and_charity.sql:19-35
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  order_id TEXT NOT NULL,
  items_text TEXT NOT NULL,
  country TEXT NOT NULL,
  created TEXT NOT NULL, modified TEXT NOT NULL,
  notification_email_sent TEXT,
  source_url TEXT,
  delivery_date TEXT NOT NULL, delivery_hour INTEGER NOT NULL, delivery_datetime TEXT NOT NULL,
  delivery_provider TEXT, delivery_provider_id TEXT,
  weight INTEGER NOT NULL, calories INTEGER NOT NULL,
  cost INTEGER NOT NULL, actual_cost INTEGER,
  no_lines INTEGER NOT NULL, no_items INTEGER NOT NULL,
  foodbank_id INTEGER, need_id INTEGER, order_group_id INTEGER
);
CREATE INDEX order_foodbank_delivery_idx ON orders(foodbank_id, delivery_datetime DESC);
CREATE INDEX order_delivery_datetime_idx ON orders(delivery_datetime);
-- 0015_ordergroup.sql:51
CREATE INDEX order_ordergroup_idx ON orders(order_group_id) WHERE order_group_id IS NOT NULL;

-- 0001_core.sql:10-55
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

// ---------------------------------------------------------------------------
// The slice of the D1 Sessions API this module uses, over node:sqlite.
// Copied from adminLists.test.ts's d1Session, itself copied from
// workers/site/src/routes/admin/foodbankLocation.test.ts.
// ---------------------------------------------------------------------------
type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number | bigint };
  };
};

function d1Session(db: SqliteDb): Session {
  const statement = (sql: string, params: unknown[]) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      const info = db.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(info.changes) } };
    },
  });
  return { prepare: (sql: string) => statement(sql, []), getBookmark: () => null } as unknown as Session;
}

let db: SqliteDb;
let session: Session;

beforeEach(() => {
  // @ts-ignore -- see the import comment
  db = new DatabaseSync(":memory:") as SqliteDb;
  db.exec(SCHEMA);
  session = d1Session(db);
});

afterEach(() => {
  vi.useRealTimers();
});

// Date only, so the awaits in these tests still resolve on a real event loop.
function freezeClock(instant: string): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(instant));
}

// A generic INSERT built from the object's own keys, so a seed names only the
// columns a test cares about and the NOT NULL filler lives in one place per
// table. Values are inlined as SQL literals rather than bound because the
// seeds are all test-authored constants.
function insert(table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  const values = columns.map((c) => {
    const v = row[c];
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number") return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  });
  db.exec(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${values.join(", ")})`);
}

// Django-format timestamps throughout: "YYYY-MM-DD HH:MM:SS.ffffff", the form
// 0022_normalise_timestamps.sql settled on and packages/models's pyNow() now
// writes. These columns are TEXT and SQLite compares TEXT bytewise, so the
// format is load-bearing for both ORDER BYs in this module. Wherever ordering
// matters below, two rows share a date and differ only in the time, so a
// comparison that only reached as far as the date would fail.
const DJANGO = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;

function seedGroup(row: Record<string, unknown>): void {
  insert("ordergroup", {
    public: 0,
    key: null,
    created: "2020-01-01 00:00:00.000000",
    modified: "2020-01-01 00:00:00.000000",
    ...row,
  });
}

let uuidCounter = 0;
const nextUuid = () => `${(uuidCounter += 1)}`.padStart(32, "0");

function seedFoodbank(row: Record<string, unknown>): void {
  insert("foodbank", {
    uuid: nextUuid(),
    address: "1 Test Street",
    postcode: "SP1 1AA",
    country: "England",
    lat_lng: "51.0,-1.8",
    charity_just_foodbank: 0,
    contact_email: "info@example.org",
    url: "https://example.org/",
    shopping_list_url: "https://example.org/list/",
    address_is_administrative: 0,
    is_closed: 0,
    no_locations: 0,
    days_between_needs: 7,
    created: "2020-01-01 00:00:00.000000",
    modified: "2020-01-01 00:00:00.000000",
    ...row,
  });
}

function seedOrder(row: Record<string, unknown>): void {
  insert("orders", {
    items_text: "beans",
    country: "England",
    created: "2020-01-01 00:00:00.000000",
    modified: "2020-01-01 00:00:00.000000",
    delivery_date: "2020-01-02",
    delivery_hour: 9,
    delivery_datetime: "2020-01-02 09:00:00.000000",
    weight: 1000,
    calories: 2000,
    cost: 5000,
    no_lines: 1,
    no_items: 10,
    ...row,
  });
}

// Reads the table back directly, so an assertion about what a write did is
// never routed through the read function it is being used to check.
function groupRows(): Record<string, unknown>[] {
  return db.prepare("SELECT * FROM ordergroup ORDER BY id").all() as Record<string, unknown>[];
}

// ===========================================================================
describe("getOrderGroupsPage", () => {
  // gfadmin/views.py:2769 -- `OrderGroup.objects.all().order_by("-created")`.
  // Newest first is the whole ordering contract of the Order Groups list, and
  // it is invisible on a page that renders eight plausible-looking rows in
  // the wrong sequence. The seeds go in deliberately out of order, and two of
  // them share a date and differ only in the time, so neither insertion order
  // nor a date-only comparison can produce the expected answer by accident.
  it("returns newest first, by created, not by id", async () => {
    seedGroup({ name: "Easter 2024", slug: "easter-2024", created: "2024-03-01 09:00:00.000000" });
    seedGroup({ name: "Christmas 2025", slug: "christmas-2025", created: "2025-12-01 09:00:00.000000" });
    seedGroup({ name: "Harvest 2025", slug: "harvest-2025", created: "2025-09-01 09:00:00.000000" });
    // Same day as Harvest, later hour: a `substr(created, 1, 10)` comparison
    // or an ORDER BY on a DATE-typed column would tie these two and let
    // insertion order decide.
    seedGroup({ name: "Harvest 2025 Late", slug: "harvest-2025-late", created: "2025-09-01 21:00:00.000000" });

    const result = await getOrderGroupsPage(session, 1, 10);

    expect(result.rows.map((g) => g.slug)).toEqual(["christmas-2025", "harvest-2025-late", "harvest-2025", "easter-2024"]);
  });

  // Ticket #9, pinned rather than endorsed. `created` is TEXT and SQLite
  // compares it bytewise, so a row whose timestamp was written by
  // toISOString() sorts above EVERY same-day Django-format row no matter the
  // real time: 'T' is 0x54 and ' ' is 0x20. That is exactly the defect
  // 0022_normalise_timestamps.sql went through the database to repair and
  // pyNow() exists to stop recurring. If a future edit to upsertOrderGroup
  // reaches for toISOString(), this list silently reorders itself and nothing
  // else in the suite would notice.
  it("sorts an ISO-format created above a later Django-format one, bytewise", async () => {
    seedGroup({ name: "Evening", slug: "evening", created: "2026-09-05 20:00:00.000000" });
    seedGroup({ name: "Morning", slug: "morning", created: "2026-09-05T08:00:00.000Z" });

    const result = await getOrderGroupsPage(session, 1, 10);

    // Chronologically wrong, lexicographically correct -- which is the point.
    expect(result.rows.map((g) => g.slug)).toEqual(["morning", "evening"]);
  });

  // The pager is the reason this diverges from Django at all (Django renders
  // the whole table into one page), so LIMIT/OFFSET is port-only behaviour
  // with no upstream to fall back on. A swapped `LIMIT ? OFFSET ?` binding --
  // pageSize and offset are both integers, so SQLite accepts either order
  // without complaint -- shows up here as the wrong window of rows.
  it("windows the ordered list by page, with no row appearing twice", async () => {
    for (let i = 1; i <= 5; i += 1) {
      seedGroup({ name: `Group ${i}`, slug: `group-${i}`, created: `2025-01-0${i} 09:00:00.000000` });
    }

    const first = await getOrderGroupsPage(session, 1, 2);
    const second = await getOrderGroupsPage(session, 2, 2);
    const third = await getOrderGroupsPage(session, 3, 2);

    expect(first.rows.map((g) => g.slug)).toEqual(["group-5", "group-4"]);
    expect(second.rows.map((g) => g.slug)).toEqual(["group-3", "group-2"]);
    expect(third.rows.map((g) => g.slug)).toEqual(["group-1"]);
  });

  // `total` counts the TABLE, not the page. The list template prints it next
  // to the pager and feeds it to totalPages(); a COUNT that had picked up the
  // LIMIT would report "1 of 1" over five rows and make pages 2 and 3
  // unreachable from the UI even though the query behind them works.
  it("reports the whole table's count on every page, not the page's length", async () => {
    for (let i = 1; i <= 5; i += 1) {
      seedGroup({ name: `Group ${i}`, slug: `group-${i}`, created: `2025-01-0${i} 09:00:00.000000` });
    }

    const first = await getOrderGroupsPage(session, 1, 2);
    const third = await getOrderGroupsPage(session, 3, 2);

    expect([first.total, first.rows.length]).toEqual([5, 2]);
    expect([third.total, third.rows.length]).toEqual([5, 1]);
  });

  // hasNext drives whether the template renders a "Next" link at all. The
  // boundary that matters is the page that is exactly full with nothing after
  // it: an off-by-one (`<=` for `<`) offers a Next link to an empty page, and
  // an inverted one hides the pager the moment there is a second page.
  it("clears hasNext on a last page that is exactly full", async () => {
    for (let i = 1; i <= 4; i += 1) {
      seedGroup({ name: `Group ${i}`, slug: `group-${i}`, created: `2025-01-0${i} 09:00:00.000000` });
    }

    expect((await getOrderGroupsPage(session, 1, 2)).hasNext).toBe(true);
    expect((await getOrderGroupsPage(session, 2, 2)).hasNext).toBe(false);
  });

  it("echoes back the page and pageSize it was asked for", async () => {
    seedGroup({ name: "Only", slug: "only" });

    const result = await getOrderGroupsPage(session, 1, 25);

    expect({ page: result.page, pageSize: result.pageSize }).toEqual({ page: 1, pageSize: 25 });
  });

  // An empty table has to produce a page, not a crash: `first()` returns null
  // when COUNT(*) somehow yields no row and the `?? 0` is what keeps `total`
  // a number. totalPages() then floors it at 1 so the pager reads "1 of 1".
  it("returns an empty page for an empty table", async () => {
    const result = await getOrderGroupsPage(session, 1, 10);

    expect(result).toEqual({ rows: [], total: 0, page: 1, pageSize: 10, hasNext: false });
  });

  // A hand-edited ?page= beyond the end is reachable from the address bar.
  // The count must still be right, or the pager renders a dead end with no
  // way back to page 1.
  it("returns no rows but the real total for a page past the end", async () => {
    seedGroup({ name: "Only", slug: "only" });

    const result = await getOrderGroupsPage(session, 9, 10);

    expect(result.rows).toEqual([]);
    expect(result.total).toBe(1);
    expect(result.hasNext).toBe(false);
  });

  // ORDER_GROUP_COLUMNS is an explicit list, not `SELECT *`, and the list
  // template plus routes/admin/orderGroup.ts read every one of these seven by
  // name (`g.slug`, `g.name`, `g.created`, `g.public`, `g.key`). A column
  // dropped from the list does not throw -- it renders as blank, or as the
  // literal "undefined", or silently kills the donor Link anchor.
  it("selects exactly the seven declared columns, with public as 0/1", async () => {
    seedGroup({ name: "Christmas 2025", slug: "christmas-2025", public: 1, key: "k3n7pqrs" });

    const result = await getOrderGroupsPage(session, 1, 10);

    expect(Object.keys(result.rows[0]!).sort()).toEqual(["created", "id", "key", "modified", "name", "public", "slug"]);
    // `public` reaches the template as a number and is used for truthiness
    // there (orderGroupPublicCell's `if (!g.public)`), so 0/1 rather than
    // false/true is the contract -- coerceBooleans is deliberately NOT
    // applied to this row type.
    expect(result.rows[0]!.public).toBe(1);
    expect(result.rows[0]!.key).toBe("k3n7pqrs");
  });

  // The NULL key is the ordinary case for a private group, and the list
  // template branches on it (a tick with no anchor rather than a "None" link).
  // A read that turned it into "" would pass a truthiness check and render a
  // dead /donate/managed/<slug>-/ URL.
  it("returns a NULL key as null, never an empty string", async () => {
    seedGroup({ name: "Private", slug: "private", public: 0, key: null });

    const result = await getOrderGroupsPage(session, 1, 10);

    expect(result.rows[0]!.key).toBeNull();
  });

  // Pinned as a known sharp edge, not as a blessing. `ORDER BY created DESC`
  // has no tiebreaker, and the eight production rows came out of the same ETL
  // run, so ties are realistic rather than theoretical. SQLite's sorter is
  // deterministic for one query against one database state, so pages still
  // partition the table -- but the ORDER of tied rows is not something the SQL
  // promises. This asserts the property that actually matters (no row lost
  // between pages, no row shown twice) and deliberately stops short of
  // asserting a sequence the query does not guarantee.
  it("still partitions the table across pages when every created is identical", async () => {
    for (let i = 1; i <= 5; i += 1) {
      seedGroup({ name: `Group ${i}`, slug: `group-${i}`, created: "2025-01-01 09:00:00.000000" });
    }

    const first = await getOrderGroupsPage(session, 1, 2);
    const second = await getOrderGroupsPage(session, 2, 2);
    const third = await getOrderGroupsPage(session, 3, 2);
    const seen = [...first.rows, ...second.rows, ...third.rows].map((g) => g.slug);

    expect(seen.length).toBe(5);
    expect([...seen].sort()).toEqual(["group-1", "group-2", "group-3", "group-4", "group-5"]);
  });
});

// ===========================================================================
describe("getOrderGroupBySlug", () => {
  // gfadmin/views.py:2780/2812 -- get_object_or_404(OrderGroup, slug=slug).
  // Both the detail page and the edit form hang off this one lookup, and the
  // route turns a null into a 404 (routes/admin/orderGroup.ts:164, :203).
  it("returns the row whose slug matches", async () => {
    seedGroup({ name: "Christmas 2025", slug: "christmas-2025", public: 1, key: "k3n7pqrs", created: "2025-12-01 09:00:00.000000" });
    seedGroup({ name: "Easter 2024", slug: "easter-2024" });

    const group = await getOrderGroupBySlug(session, "christmas-2025");

    expect(group).toMatchObject({ name: "Christmas 2025", slug: "christmas-2025", public: 1, key: "k3n7pqrs" });
  });

  it("returns null for a slug nothing holds", async () => {
    seedGroup({ name: "Christmas 2025", slug: "christmas-2025" });

    expect(await getOrderGroupBySlug(session, "christmas-2024")).toBeNull();
  });

  // `slug = ?`, never a LIKE or a prefix match. Group slugs nest by
  // construction -- "christmas" and "christmas-2025" are both names an admin
  // would type -- and a LIKE would hand the detail page whichever row the
  // scan reached first, then let the edit form save over it.
  it("matches the slug exactly, not as a prefix", async () => {
    seedGroup({ name: "Christmas", slug: "christmas" });
    seedGroup({ name: "Christmas 2025", slug: "christmas-2025" });

    expect((await getOrderGroupBySlug(session, "christmas"))!.name).toBe("Christmas");
    expect((await getOrderGroupBySlug(session, "christmas-2025"))!.name).toBe("Christmas 2025");
  });

  // Bytewise, because SQLite's default collation is and because
  // ordergroup_slug_uniq is. Slugs are lowercased at the point they are
  // derived, so a mixed-case URL is a 404 -- the same answer Django gives,
  // and worth pinning so nobody "fixes" it into a COLLATE NOCASE that would
  // then disagree with the unique index about what a duplicate is.
  it("is case-sensitive", async () => {
    seedGroup({ name: "Christmas 2025", slug: "christmas-2025" });

    expect(await getOrderGroupBySlug(session, "Christmas-2025")).toBeNull();
  });

  it("selects exactly the seven declared columns", async () => {
    seedGroup({ name: "Christmas 2025", slug: "christmas-2025" });

    const group = await getOrderGroupBySlug(session, "christmas-2025");

    expect(Object.keys(group!).sort()).toEqual(["created", "id", "key", "modified", "name", "public", "slug"]);
  });
});

// ===========================================================================
describe("getOrderGroupOrders", () => {
  // givefood/models/orders.py:321-322 OrderGroup.orders() --
  // `.filter(order_group=self)`. THE filter test: every row seeded here that
  // is not in group 1 must be absent. A dropped WHERE clause passes any test
  // that only ever seeds matching rows, and would silently inflate all six of
  // the detail page's totals with other groups' orders.
  it("returns only this group's orders, excluding other groups and ungrouped ones", async () => {
    seedGroup({ id: 1, name: "Christmas 2025", slug: "christmas-2025" });
    seedGroup({ id: 2, name: "Easter 2024", slug: "easter-2024" });
    // Scotland, not England, on the row that MUST come back. Every other
    // order in this file takes the seed's default country, so a predicate
    // added to this WHERE for any reason -- `AND o.country = 'England'`
    // survived the first mutation pass -- would have been invisible.
    seedOrder({ order_id: "mine-a", order_group_id: 1, country: "Scotland" });
    seedOrder({ order_id: "theirs", order_group_id: 2 });
    // The overwhelming majority of the 1,050 production orders belong to no
    // group at all -- 0015_ordergroup.sql's partial index exists because of
    // it. `order_group_id = ?` against a number already excludes NULL under
    // SQLite's three-valued logic, but only if the predicate is there.
    seedOrder({ order_id: "ungrouped", order_group_id: null });

    const rows = await getOrderGroupOrders(session, 1);

    expect(rows.map((o) => o.order_id)).toEqual(["mine-a"]);
  });

  // ASCENDING, deliberately: `order_by("delivery_datetime")` with no minus,
  // unlike the list page above and unlike every other order table in the
  // admin (0005's own index on this column is DESC). The two rows here share
  // a date and differ only in the hour, so a comparison that stopped at the
  // date could not produce this answer.
  it("orders by delivery_datetime ascending", async () => {
    seedGroup({ id: 1, name: "Christmas 2025", slug: "christmas-2025" });
    seedOrder({ order_id: "second", order_group_id: 1, delivery_datetime: "2025-12-02 09:00:00.000000" });
    seedOrder({ order_id: "fourth", order_group_id: 1, delivery_datetime: "2025-12-03 21:00:00.000000" });
    seedOrder({ order_id: "first", order_group_id: 1, delivery_datetime: "2025-12-01 09:00:00.000000" });
    seedOrder({ order_id: "third", order_group_id: 1, delivery_datetime: "2025-12-03 09:00:00.000000" });

    const rows = await getOrderGroupOrders(session, 1);

    expect(rows.map((o) => o.order_id)).toEqual(["first", "second", "third", "fourth"]);
  });

  // LEFT JOIN, and it has to stay one. Order.foodbank is
  // `ForeignKey(Foodbank, null=True, on_delete=SET_NULL)`
  // (givefood/models/orders.py:30), so Django's select_related('foodbank')
  // emits a LEFT OUTER JOIN and an unassigned order stays in the queryset. D1
  // declares no foreign keys at all (PLAN.md 4.5), so a dangling
  // foodbank_id is possible too. Under an INNER JOIN both of these rows
  // vanish -- no error, just a shorter table and five understated totals on
  // the detail page.
  it("keeps orders with no food bank, and orders pointing at a missing one", async () => {
    seedGroup({ id: 1, name: "Christmas 2025", slug: "christmas-2025" });
    seedFoodbank({ id: 7, name: "Salisbury", slug: "salisbury" });
    seedOrder({ order_id: "assigned", order_group_id: 1, foodbank_id: 7, delivery_datetime: "2025-12-01 09:00:00.000000" });
    seedOrder({ order_id: "unassigned", order_group_id: 1, foodbank_id: null, delivery_datetime: "2025-12-02 09:00:00.000000" });
    seedOrder({ order_id: "dangling", order_group_id: 1, foodbank_id: 999, delivery_datetime: "2025-12-03 09:00:00.000000" });

    const rows = await getOrderGroupOrders(session, 1);

    expect(rows.map((o) => [o.order_id, o.foodbank_name, o.foodbank_slug])).toEqual([
      ["assigned", "Salisbury", "salisbury"],
      ["unassigned", null, null],
      ["dangling", null, null],
    ]);
  });

  // The join filters NOTHING about the food bank, and must not start to.
  // givefood/models/orders.py:321 is `select_related('foodbank')` -- a join
  // for fetching, with no predicate on the parent at all -- so a group's
  // orders outlive their food bank being closed or reclassified as a school.
  // That is the behaviour that matters, not a technicality: closure is the
  // ordinary end state of a food bank in this data, and the six totals on the
  // detail page are money that was actually spent. They do not shrink because
  // a recipient has since shut.
  //
  // THE TWO MUTANTS THIS EXISTS FOR both survived the first pass of this
  // file: `ON f.id = o.foodbank_id AND f.is_closed = 0` (the row stays but
  // its name and link go silently NULL) and
  // `WHERE ... AND (f.is_closed = 0 OR f.id IS NULL)` (the row goes, and
  // every total on the page is quietly short by it). Both are the kind of
  // edit someone makes while "tidying closed food banks out of the admin",
  // and neither errors. They were invisible because every other food bank in
  // this file is seeded open -- a filter that does nothing passes every test
  // that only seeds rows it would have kept. `is_school` is here for the same
  // reason: it is the other nullable status flag on the parent, and
  // `AND f.is_school IS NULL` survived too.
  it("keeps the orders of a closed food bank, and of one flagged as a school", async () => {
    seedGroup({ id: 1, name: "Christmas 2025", slug: "christmas-2025" });
    seedFoodbank({ id: 7, name: "Salisbury", slug: "salisbury", is_closed: 0, is_school: 0 });
    seedFoodbank({ id: 8, name: "Andover", slug: "andover", is_closed: 1 });
    seedFoodbank({ id: 9, name: "Romsey School", slug: "romsey-school", is_school: 1 });
    seedOrder({ order_id: "open", order_group_id: 1, foodbank_id: 7, delivery_datetime: "2025-12-01 09:00:00.000000" });
    seedOrder({ order_id: "closed", order_group_id: 1, foodbank_id: 8, delivery_datetime: "2025-12-02 09:00:00.000000" });
    seedOrder({ order_id: "school", order_group_id: 1, foodbank_id: 9, delivery_datetime: "2025-12-03 09:00:00.000000" });

    const rows = await getOrderGroupOrders(session, 1);

    // Named, not counted: a predicate on the join leaves the row and blanks
    // the name, so `toHaveLength(3)` would pass against half of it.
    expect(rows.map((o) => [o.order_id, o.foodbank_name, o.foodbank_slug])).toEqual([
      ["open", "Salisbury", "salisbury"],
      ["closed", "Andover", "andover"],
      ["school", "Romsey School", "romsey-school"],
    ]);
  });

  // Join CARDINALITY, the other half of the join direction. One food bank
  // with two orders must yield two rows, and a food bank with no orders in
  // this group must yield none -- a join written the other way round (FROM
  // foodbank LEFT JOIN orders) produces a phantom row for the childless
  // parent, which the detail page would count as an order with no items.
  it("returns one row per order, and nothing for a food bank with no orders", async () => {
    seedGroup({ id: 1, name: "Christmas 2025", slug: "christmas-2025" });
    seedFoodbank({ id: 7, name: "Salisbury", slug: "salisbury" });
    seedFoodbank({ id: 8, name: "Camden", slug: "camden" }); // no orders anywhere
    seedOrder({ order_id: "sal-1", order_group_id: 1, foodbank_id: 7, delivery_datetime: "2025-12-01 09:00:00.000000" });
    seedOrder({ order_id: "sal-2", order_group_id: 1, foodbank_id: 7, delivery_datetime: "2025-12-02 09:00:00.000000" });

    const rows = await getOrderGroupOrders(session, 1);

    expect(rows.map((o) => o.order_id)).toEqual(["sal-1", "sal-2"]);
    expect(rows.every((o) => o.foodbank_name === "Salisbury")).toBe(true);
  });

  // The unbounded promise in the function's own comment, tested rather than
  // asserted in prose. routes/admin/orderGroup.ts:172-177 sums items, weight,
  // calories and cost from exactly these rows and prints them as the group's
  // totals; a LIMIT added here "for safety" would not error, it would just
  // make every one of those numbers quietly too small. 150 is over the
  // largest page size in the admin (PAGE_SIZE is 100 on the list beside it)
  // and over D1's 100-bound-parameter statement limit, so a chunking rewrite
  // that lost its last chunk fails here too.
  it("returns every order in the group with no limit", async () => {
    seedGroup({ id: 1, name: "Christmas 2025", slug: "christmas-2025" });
    for (let i = 0; i < 150; i += 1) {
      const minute = String(i).padStart(2, "0");
      seedOrder({ order_id: `bulk-${i}`, order_group_id: 1, no_items: 1, delivery_datetime: `2025-12-01 09:${minute}:00.000000` });
    }

    const rows = await getOrderGroupOrders(session, 1);

    expect(rows).toHaveLength(150);
    expect(rows.reduce((sum, o) => sum + o.no_items, 0)).toBe(150);
  });

  it("returns an empty array for a group with no orders", async () => {
    seedGroup({ id: 1, name: "Christmas 2025", slug: "christmas-2025" });
    seedGroup({ id: 2, name: "Easter 2024", slug: "easter-2024" });
    seedOrder({ order_id: "theirs", order_group_id: 2 });

    expect(await getOrderGroupOrders(session, 1)).toEqual([]);
  });

  // An id nothing points at -- a group deleted out from under the orders, or
  // a hand-typed URL. Django has no delete view for OrderGroup, but nothing
  // stops a row being removed in the D1 console, and there is no FK to
  // cascade or restrain it.
  it("returns an empty array for a group id that does not exist", async () => {
    seedOrder({ order_id: "orphan", order_group_id: 1 });

    expect(await getOrderGroupOrders(session, 999)).toEqual([]);
  });

  // The nine columns the detail template and its aggregate loop read by name.
  // The units are the reason the values are asserted individually and all
  // different: `weight` is GRAMS and gets divided by 1000 and multiplied by
  // the packaging constant, `cost` is PENCE and gets divided by 100. Swap two
  // aliases in the SELECT list and the page reports 5 kg as 2 kg and a cost of
  // GBP 10 as GBP 50, with nothing anywhere to say so.
  it("returns exactly the nine declared columns, with each value in its own", async () => {
    seedGroup({ id: 1, name: "Christmas 2025", slug: "christmas-2025" });
    seedFoodbank({ id: 7, name: "Salisbury", slug: "salisbury" });
    seedOrder({
      order_id: "abc123",
      order_group_id: 1,
      foodbank_id: 7,
      delivery_datetime: "2025-12-01 09:00:00.000000",
      no_items: 11,
      weight: 22000,
      calories: 33000,
      cost: 4400,
      created: "2025-11-20 14:03:02.100000",
    });

    const rows = await getOrderGroupOrders(session, 1);

    expect(Object.keys(rows[0]!).sort()).toEqual([
      "calories",
      "cost",
      "created",
      "delivery_datetime",
      "foodbank_name",
      "foodbank_slug",
      "no_items",
      "order_id",
      "weight",
    ]);
    expect(rows[0]).toEqual({
      order_id: "abc123",
      foodbank_name: "Salisbury",
      foodbank_slug: "salisbury",
      delivery_datetime: "2025-12-01 09:00:00.000000",
      no_items: 11,
      weight: 22000,
      calories: 33000,
      cost: 4400,
      created: "2025-11-20 14:03:02.100000",
    });
  });

  // orders.order_id is the human-facing TEXT reference (0005:21), NOT the
  // integer primary key -- and orderline's own FK column is called order_id
  // too, while pointing at orders.id. Selecting `o.id` here would look
  // plausible, typecheck (the interface says string, and D1 rows are
  // untyped at runtime), and put a row number where the order reference
  // belongs in the table and its link.
  it("returns the TEXT order_id, not the integer primary key", async () => {
    seedGroup({ id: 1, name: "Christmas 2025", slug: "christmas-2025" });
    seedOrder({ id: 500, order_id: "GF-2025-0001", order_group_id: 1 });

    expect((await getOrderGroupOrders(session, 1))[0]!.order_id).toBe("GF-2025-0001");
  });
});

// ===========================================================================
describe("upsertOrderGroup", () => {
  // The fixture's own guard rail. Every "refuses the duplicate" test below is
  // only worth something if the database would really have refused it too --
  // otherwise the pre-check could be deleted and those tests would pass
  // against a port that silently writes a second row and 500s the detail page
  // with MultipleObjectsReturned's D1 equivalent forever after. This proves
  // ordergroup_slug_uniq (0015:50) is present in this fixture.
  it("(fixture) ordergroup_slug_uniq really refuses a second row with the same slug", () => {
    seedGroup({ name: "Christmas 2025", slug: "christmas-2025" });

    expect(() => seedGroup({ name: "Anything Else", slug: "christmas-2025" })).toThrow(/UNIQUE/);
  });

  describe("create", () => {
    // givefood/models/orders.py:324-327 -- slug = slugify(name) on every
    // save. The NAME is stored verbatim; only the slug is derived.
    it("inserts one row with the slugified name and the name untouched", async () => {
      const result = await upsertOrderGroup(session, { name: "St. Mary's Christmas Appeal 2025", public: 0, key: null }, undefined);

      expect(result).toEqual({ ok: true, slug: "st-marys-christmas-appeal-2025" });
      expect(groupRows()).toMatchObject([{ name: "St. Mary's Christmas Appeal 2025", slug: "st-marys-christmas-appeal-2025" }]);
    });

    // django.utils.text.slugify, ported at orderGroupAdmin.ts:92-104. The
    // slug is not cosmetic here -- it is the group's admin URL and, for a
    // public group, half of the donor-facing /donate/managed/<slug>-<key>/
    // address. A drift in any of these rules changes URLs already in
    // circulation.
    //
    // Every expected value on the right was produced by running CPython's
    // django.utils.text.slugify over the name on the left, per TESTING.md's
    // rule that parity claims are executed rather than reasoned about. Two of
    // these names slugify to the SAME string, which is why the table is
    // cleared between cases -- and is itself the reason the collision
    // pre-check in the next block exists.
    it("strips accents, punctuation and edge separators the way Django's slugify does", async () => {
      const cases: [string, string][] = [
        ["Café Group", "cafe-group"], // NFKD + drop combining marks
        ["  Christmas   2025  ", "christmas-2025"], // runs of whitespace collapse to one hyphen, edges trimmed
        ["--Christmas--2025--", "christmas-2025"], // runs of hyphens collapse too, edges trimmed
        ["Christmas & Co.", "christmas-co"], // ampersand and full stop dropped, not hyphenated
        ["Winter_Appeal", "winter_appeal"], // underscore is a \w character: kept INSIDE
        ["_Winter_", "winter"], // ...but stripped at the edges, same as a hyphen
      ];

      for (const [name, slug] of cases) {
        db.exec("DELETE FROM ordergroup");
        expect(await upsertOrderGroup(session, { name, public: 0, key: null }, undefined)).toEqual({ ok: true, slug });
      }
    });

    // THE ASCII STRIP -- `.replace(/[^\x00-\x7F]/g, "")`, orderGroupAdmin.ts:98
    // -- is the load-bearing half of the accent handling, and deleting it
    // survived the first mutation pass of this file. It is invisible on every
    // name in the table above, because a non-ASCII letter or punctuation mark
    // that reaches the NEXT line is removed by `[^\w\s-]` anyway: JavaScript's
    // `\w` is ASCII-only, so "Café", "北京" and "&" all come out the same
    // either way.
    //
    // What tells the two apart is the Unicode SEPARATORS that NFKD does not
    // fold, because JavaScript's `\s` does match those -- so `[^\w\s-]` keeps
    // them and `[-\s]+` then turns each one into a hyphen. Without the ASCII
    // strip, "Line\u2028Break" slugifies to "line-break" instead of
    // "linebreak", and a group's URL changes on a character nobody can see.
    //
    // Every expected value below came out of CPython running
    // django.utils.text.slugify (Django 5.2.6, the version the reference repo
    // pins), which reaches the same answers by the other route --
    // `.encode("ascii", "ignore")`. So this is a parity test as well as the
    // one that kills "the ASCII strip looks redundant, delete it".
    it("drops unfoldable separators and letters, matching Django's ascii-ignore", async () => {
      const cases: [string, string][] = [
        // U+2028/U+2029: matched by JS `\s`, NOT decomposed by NFKD. Only the
        // ASCII strip removes them, and Django removes them too.
        ["Line\u2028Break", "linebreak"],
        ["Winter\u2029Appeal", "winterappeal"],
        // NFKD does not expand ß to "ss" or Æ to "AE" -- that is case folding,
        // not compatibility decomposition -- so both letters are simply
        // deleted and the word is left misspelt. Django does the same, which
        // is why this is pinned rather than repaired.
        ["Straße Appeal", "strae-appeal"],
        ["Æther Appeal", "ther-appeal"],
        // ...but a non-breaking space, the one non-ASCII character a paste
        // from Word really does produce, DOES fold to a plain space under
        // NFKD -- so it survives the ASCII strip and becomes a hyphen. The
        // asymmetry is the reason both halves are tested.
        ["Christmas\u00a02025", "christmas-2025"],
      ];

      for (const [name, slug] of cases) {
        db.exec("DELETE FROM ordergroup");
        expect(await upsertOrderGroup(session, { name, public: 0, key: null }, undefined)).toEqual({ ok: true, slug });
      }
    });

    // A REAL DIVERGENCE FROM DJANGO, pinned rather than fixed. Python's `\s`
    // on a str matches the C0 separators \x1c-\x1f; JavaScript's does not. So
    // `re.sub(r'[^\w\s-]', '', ...)` KEEPS a \x1c and the next substitution
    // turns it into a hyphen, while this port's first replace deletes it
    // outright and the two halves of the name fuse:
    //
    //   CPython slugify("Winter\x1cAppeal")  -> "winter-appeal"
    //   this port                            -> "winterappeal"
    //
    // Both were run, not reasoned about. It needs a C0 control character
    // inside a group name to reach, which no browser form produces on its own
    // -- so it is recorded, not repaired. The point of the test is that if
    // someone ever aligns the two, this file says which behaviour was
    // deliberate and which was the accident.
    it("differs from Django on a C0 separator inside the name (documented divergence)", async () => {
      expect(await upsertOrderGroup(session, { name: "Winter\x1cAppeal", public: 0, key: null }, undefined)).toEqual({ ok: true, slug: "winterappeal" });
    });

    // orderGroupAdmin.ts:134-136's guard. Django stores an empty slug happily
    // and then 404s the group's own admin URL forever, with no way back
    // through the UI to rename it. Refusing at the door is this port's fix --
    // and the refusal must leave the table untouched, not write the row and
    // report an error.
    it("refuses a name that slugifies to nothing, and writes no row", async () => {
      for (const name of ["!!!", "   ", "___", "北京", "---"]) {
        const result = await upsertOrderGroup(session, { name, public: 0, key: null }, undefined);
        expect(result).toEqual({ ok: false, error: "Name must contain at least one letter or number" });
      }

      expect(groupRows()).toEqual([]);
    });

    // TimestampedModel (givefood/models/base.py:12-19): created is
    // auto_now_add, modified is auto_now, and on the first save they are the
    // same instant. The FORMAT is ticket #9's whole subject -- these columns
    // are TEXT, the list page orders by `created` bytewise, and a
    // toISOString() here would sort every new group above every imported one
    // regardless of date.
    it("stamps created and modified with one Django-format timestamp", async () => {
      freezeClock("2026-09-05T19:28:08.853Z");

      await upsertOrderGroup(session, { name: "Christmas 2025", public: 0, key: null }, undefined);

      const [row] = groupRows();
      expect(row!.created).toBe("2026-09-05 19:28:08.853000");
      expect(row!.modified).toBe(row!.created);
      expect(String(row!.created)).toMatch(DJANGO);
    });

    // `public` is INTEGER NOT NULL in D1 and the route hands it Number(...).
    // The read path returns it untouched for template truthiness, so a
    // boolean or a "1" reaching the column would change what `if (!g.public)`
    // decides on the list page.
    it("stores public as the integer it was given", async () => {
      await upsertOrderGroup(session, { name: "Public Group", public: 1, key: "k3n7pqrs" }, undefined);
      await upsertOrderGroup(session, { name: "Private Group", public: 0, key: null }, undefined);

      expect(groupRows().map((r) => [r.slug, r.public, r.key])).toEqual([
        ["public-group", 1, "k3n7pqrs"],
        ["private-group", 0, null],
      ]);
    });
  });

  describe("collision pre-check", () => {
    // 0015_ordergroup.sql's stated reason for existing. Two DIFFERENT names
    // that slugify the same is the realistic case, because there is no unique
    // index on `name` at all and Django's own form does not check either -- so
    // the name check a reviewer might expect to be enough is not the check
    // being made here.
    it("refuses a second group whose different name yields an existing slug", async () => {
      await upsertOrderGroup(session, { name: "Christmas 2025", public: 0, key: null }, undefined);

      const result = await upsertOrderGroup(session, { name: "  Christmas, 2025!  ", public: 0, key: null }, undefined);

      expect(result).toEqual({ ok: false, error: 'An order group with the slug "christmas-2025" already exists' });
      expect(groupRows()).toHaveLength(1);
    });

    // The refusal has to come back as a value, not as an exception: the route
    // turns it into a 400 with the message in it
    // (routes/admin/orderGroup.ts:231), and a thrown SQLITE_CONSTRAINT_UNIQUE
    // would reach app.onError and render the 500 page over the admin's typed
    // form instead -- GitHub issue #12's exact shape, on a different table.
    it("returns the clash as a value rather than letting the UNIQUE index throw", async () => {
      await upsertOrderGroup(session, { name: "Christmas 2025", public: 0, key: null }, undefined);

      await expect(upsertOrderGroup(session, { name: "Christmas 2025", public: 0, key: null }, undefined)).resolves.toMatchObject({ ok: false });
    });

    // THE self-exclusion. Every ordinary edit re-posts the unchanged name and
    // therefore re-derives the row's own existing slug; without
    // `clash.id !== existingId` the group's own row would be read back as a
    // collision and no group could ever be edited again -- not its Public
    // flag, not its key, nothing.
    it("does not report a group's own slug back to it on an edit", async () => {
      await upsertOrderGroup(session, { name: "Christmas 2025", public: 0, key: null }, undefined);
      const id = Number(groupRows()[0]!.id);

      const result = await upsertOrderGroup(session, { name: "Christmas 2025", public: 1, key: "k3n7pqrs" }, id);

      expect(result).toEqual({ ok: true, slug: "christmas-2025" });
      expect(groupRows()).toMatchObject([{ slug: "christmas-2025", public: 1, key: "k3n7pqrs" }]);
    });

    // The other side of the same line: excluding the row being edited must
    // not switch the check off. Renaming one group onto another's slug is
    // still a collision, and the OTHER row must survive it untouched.
    it("still refuses an edit that renames a group onto another group's slug", async () => {
      await upsertOrderGroup(session, { name: "Christmas 2025", public: 0, key: null }, undefined);
      await upsertOrderGroup(session, { name: "Easter 2024", public: 0, key: null }, undefined);
      const easterId = Number(groupRows()[1]!.id);

      const result = await upsertOrderGroup(session, { name: "Christmas 2025", public: 0, key: null }, easterId);

      expect(result).toEqual({ ok: false, error: 'An order group with the slug "christmas-2025" already exists' });
      expect(groupRows().map((r) => [r.name, r.slug])).toEqual([
        ["Christmas 2025", "christmas-2025"],
        ["Easter 2024", "easter-2024"],
      ]);
    });

    // The empty-slug guard runs BEFORE the collision lookup, so a group whose
    // name is all punctuation is refused for the reason that actually applies
    // rather than for a clash with some other unslugifiable row. Order
    // matters because the messages differ and both are shown to the admin.
    it("reports the empty slug, not a clash, when a second unslugifiable name arrives", async () => {
      seedGroup({ name: "!!!", slug: "" });

      const result = await upsertOrderGroup(session, { name: "???", public: 0, key: null }, undefined);

      expect(result).toEqual({ ok: false, error: "Name must contain at least one letter or number" });
    });
  });

  describe("edit", () => {
    // auto_now_add versus auto_now: the UPDATE names `modified` and must NOT
    // name `created`. Touching `created` on an edit would silently reorder the
    // whole list page -- the group would jump to the top for no reason a
    // reader could see, and 0015's own data is ordered by nothing else.
    it("updates modified but leaves created alone", async () => {
      freezeClock("2026-09-05T19:28:08.853Z");
      await upsertOrderGroup(session, { name: "Christmas 2025", public: 0, key: null }, undefined);
      const id = Number(groupRows()[0]!.id);

      freezeClock("2026-09-07T11:00:00.500Z");
      await upsertOrderGroup(session, { name: "Christmas 2025", public: 1, key: "k3n7pqrs" }, id);

      expect(groupRows()[0]).toMatchObject({
        created: "2026-09-05 19:28:08.853000",
        modified: "2026-09-07 11:00:00.500000",
      });
    });

    // KEPT FOR PARITY, and the module says so out loud: Django re-slugifies
    // on every save, so renaming a PUBLIC group silently changes its
    // donor-facing /donate/managed/<slug>-<key>/ URL and breaks every link
    // already handed out. The form's help text warns about it. Pinned here
    // because it looks exactly like a bug, and the next person to "fix" it
    // should have to delete a test that explains why it is not one.
    it("re-slugifies on a rename, changing a public group's donor URL", async () => {
      await upsertOrderGroup(session, { name: "Christmas 2025", public: 1, key: "k3n7pqrs" }, undefined);
      const id = Number(groupRows()[0]!.id);

      const result = await upsertOrderGroup(session, { name: "Christmas 2026", public: 1, key: "k3n7pqrs" }, id);

      expect(result).toEqual({ ok: true, slug: "christmas-2026" });
      expect(groupRows()).toMatchObject([{ name: "Christmas 2026", slug: "christmas-2026" }]);
      // The old admin URL is gone with it -- nothing writes a slugredirect row
      // for order groups (0016_slugredirect.sql covers food banks only).
      expect(await getOrderGroupBySlug(session, "christmas-2025")).toBeNull();
    });

    // `WHERE id = ?`, and only that row. A missing or mis-bound WHERE on an
    // UPDATE rewrites the whole table -- which, with a UNIQUE index on slug
    // and two rows, would actually raise rather than corrupt silently, so the
    // real risk is the two-row case here: the wrong row edited, both still
    // present, nothing to see.
    it("writes to the identified row only", async () => {
      await upsertOrderGroup(session, { name: "Christmas 2025", public: 0, key: null }, undefined);
      await upsertOrderGroup(session, { name: "Easter 2024", public: 0, key: null }, undefined);
      const easterId = Number(groupRows()[1]!.id);

      await upsertOrderGroup(session, { name: "Easter 2025", public: 1, key: "aabbccdd" }, easterId);

      expect(groupRows().map((r) => [r.name, r.slug, r.public, r.key])).toEqual([
        ["Christmas 2025", "christmas-2025", 0, null],
        ["Easter 2025", "easter-2025", 1, "aabbccdd"],
      ]);
    });

    // `existingId === undefined`, never `!existingId` -- which is exactly the
    // tidy-up someone reaches for, and which survived the first mutation pass
    // of this file because nothing here had an id of 0. SQLite takes 0 as an
    // INTEGER PRIMARY KEY perfectly happily: Django's own sequence starts at
    // 1, but 0015's schema has no AUTOINCREMENT and nothing stops a 0
    // arriving from an import or the D1 console. Under the truthiness check
    // that row's edit takes the INSERT branch instead, hits
    // ordergroup_slug_uniq, and throws SQLITE_CONSTRAINT_UNIQUE out of the
    // form -- the 500 the pre-check above exists to prevent, reintroduced
    // from the other end.
    it("updates a group whose id is 0 rather than inserting a second row", async () => {
      seedGroup({ id: 0, name: "Christmas 2025", slug: "christmas-2025" });

      const result = await upsertOrderGroup(session, { name: "Christmas 2025", public: 1, key: "k3n7pqrs" }, 0);

      expect(result).toEqual({ ok: true, slug: "christmas-2025" });
      expect(groupRows()).toMatchObject([{ id: 0, name: "Christmas 2025", public: 1, key: "k3n7pqrs" }]);
    });

    // An UPDATE never inserts: an edit of a row that has gone must not
    // resurrect it under a new id. See also the next test, which pins what it
    // reports back when that happens.
    it("does not create a row when the id matches nothing", async () => {
      await upsertOrderGroup(session, { name: "Christmas 2025", public: 0, key: null }, 999);

      expect(groupRows()).toEqual([]);
    });

    // SUSPECT, pinned as-is rather than fixed. An existingId that matches no
    // row updates nothing and still returns { ok: true }, so the route
    // redirects to the list as if the save had worked and the admin's edit is
    // gone without a word. It is not reachable through
    // routes/admin/orderGroup.ts today -- existing?.id only ever comes from a
    // row getOrderGroupBySlug just returned -- but it is a silent success on a
    // write path, which is the failure mode this whole tier exists to catch.
    // Reported, not repaired: a red suite helps nobody.
    it("reports ok for an edit of a row that does not exist (suspect)", async () => {
      expect(await upsertOrderGroup(session, { name: "Christmas 2025", public: 0, key: null }, 999)).toEqual({ ok: true, slug: "christmas-2025" });
    });

    // SUSPECT, and the more reachable of the two. The db layer writes `key`
    // exactly as given, so a null CLEARS an existing capability token and
    // every /donate/managed/<slug>-<key>/ URL already circulating with donors
    // stops resolving. The only thing standing between an admin who blanks
    // the Key field and that outcome is routes/admin/orderGroup.ts:225's
    // `if (!key && existing?.key) key = existing.key` -- one line, in the
    // other package, with nothing here to enforce it. Pinned so that a future
    // caller of upsertOrderGroup knows what it will do rather than assuming
    // the guard lives in the query.
    it("clears an existing key when passed null (suspect: no protection at this layer)", async () => {
      await upsertOrderGroup(session, { name: "Christmas 2025", public: 1, key: "k3n7pqrs" }, undefined);
      const id = Number(groupRows()[0]!.id);

      await upsertOrderGroup(session, { name: "Christmas 2025", public: 1, key: null }, id);

      expect(groupRows()[0]!.key).toBeNull();
    });
  });

  // End to end across both halves of the module, with a real clock: the
  // timestamps upsertOrderGroup writes have to be the timestamps
  // getOrderGroupsPage can order by. Each half can be individually correct
  // and still disagree -- that is precisely what ticket #9 was, an ISO write
  // site feeding a bytewise ORDER BY -- so the agreement is worth its own
  // test rather than being inferred from the two above.
  it("writes timestamps the list page can order by, newest first", async () => {
    freezeClock("2026-09-05T09:00:00.000Z");
    await upsertOrderGroup(session, { name: "First", public: 0, key: null }, undefined);
    freezeClock("2026-09-05T21:00:00.000Z"); // same day, later hour
    await upsertOrderGroup(session, { name: "Second", public: 0, key: null }, undefined);
    freezeClock("2026-09-06T09:00:00.000Z");
    await upsertOrderGroup(session, { name: "Third", public: 0, key: null }, undefined);

    const page = await getOrderGroupsPage(session, 1, 10);

    expect(page.rows.map((g) => g.slug)).toEqual(["third", "second", "first"]);
  });
});
