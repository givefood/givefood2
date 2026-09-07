import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "./schema.testkit";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getFoodbankIdsByCategory,
  getNeedById,
  getNeedByUuid,
  getNeedsByIds,
  getPublishedNeeds,
  getRecentPublishedNeedsForRss,
  mapNeedRow,
} from "./needs";
import type { Session } from "./types";

// needs.ts is the PUBLIC read path for needs: gfapi1's api_needs/api_need
// (gfapi1/views.py:215-258), gfapi2's needs/need, gfwfbn's rss feed
// (gfwfbn/views.py:132-189), foodbank.ts's `latest_need` resolution, and the
// /needs/?item= category filter (givefood/utils/geo.py:304-404). Six
// functions, six SQL statements, and essentially nothing else.
//
// WHY A REAL DATABASE, NOT A MOCK. A mock that hands back canned rows tests
// only that the module can map an object, which is not where this module can
// fail. Every failure mode it has is SILENT and returns a 200:
//
//   * `published = 1` dropped   -> unpublished needs leak into the public API
//   * INNER instead of LEFT JOIN -> unassigned needs vanish from /api/needs/
//   * ORDER BY flipped to ASC    -> the feed shows 2019 and nobody scrolls
//   * the category JOIN dropped  -> "by item" matches a food bank whose need
//                                   was for pasta three years ago
//
// None of those raise. Two of that family have already shipped here:
// migration 0019's column drops broke four queries with no log line until
// /dashboard/beautybanks/ was measured and found to be a live 500, and
// ticket #9's ISO timestamps silently dropped 31 of 46 rows from a
// lexicographic threshold. So the tests below run the module's real
// statements against real SQLite and assert the ROWS that come back.
//
// MUTATION-TESTED, and several tests below exist only because a mutant
// survived the first draft -- each one names its mutant. Four families were
// executed and found to be EQUIVALENT under this schema, and are recorded
// here so nobody spends the afternoon rediscovering them:
//
//   * `published = 1` -> `published <> 0`, and `is_closed = 0` ->
//     `is_closed IS NOT 1`. Both columns are NOT NULL and only ever hold
//     Django's 0/1, so the two spellings cannot disagree on reachable data.
//   * `latest_need_id = need_id` -> `IS`, and `category = ?` -> `IS ?`. The
//     `IS NOT ?` vs `!= ?` family has bitten this repo before, but not here:
//     foodbankchangeline.need_id, .category and .type are all NOT NULL
//     (0003_homepage_data.sql:31-32), so the right-hand side is never NULL
//     and three-valued logic never engages.
//   * the RSS food bank filter on `f.id` rather than `fc.foodbank_id` -- the
//     INNER JOIN is on exactly that equality, so the two are the same set.
//   * `.first()` -> `.all()[0]` in getNeedByUuid, guarded by the UNIQUE
//     index need_need_id_uniq (0001_core.sql:123).
//
// THE FIXTURE IS THE MIGRATION FILES THEMSELVES, applied in order, rather
// than a CREATE TABLE transcribed into this file -- the convention
// adminDashboardStats.test.ts set and needAdmin.test.ts inherited. It is
// load-bearing here specifically: migration 0019 DROPPED
// `foodbankchange.foodbank_name` and replaced it with the joined
// `foodbankchange_full` view that four of these six functions read. A
// hand-written schema in this file could quite happily still declare that
// column, every test below would pass, and production would 500.

type Bindable = null | number | bigint | string | Uint8Array;

interface Executed {
  sql: string;
  params: Bindable[];
}

// Every statement the module actually sent, in order. Three behaviours below
// are about the STATEMENTS rather than the rows: getNeedsByIds' early return
// (an empty id list must not become the syntax error `IN ()`), its
// unchunked one-placeholder-per-id list against D1's 100-bound-parameter
// cap, and getFoodbankIdsByCategory's promise that its parameter count never
// grows with the number of matching food banks.
let executed: Executed[] = [];

// The D1 Sessions API surface this package is handed, backed by node:sqlite.
// Copied verbatim from needAdmin.test.ts so every tier drives the real code
// through one adapter rather than five. Deliberately dumb: it forwards the
// SQL untouched, so the ENGINE -- not JavaScript -- decides which rows come
// back and in what order.
function d1Session(db: DatabaseSync): Session {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => {
      executed.push({ sql, params });
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    all: async () => {
      executed.push({ sql, params });
      return { results: db.prepare(sql).all(...params), success: true, meta: {} };
    },
    run: async () => {
      executed.push({ sql, params });
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return { prepare: (sql: string) => statement(sql, []), getBookmark: () => null } as unknown as Session;
}

let db: DatabaseSync;
let session: Session;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  executed = [];
  session = d1Session(db);
});

// -------------------------------------------------------------------------
// Seeds
// -------------------------------------------------------------------------

// A 32-char dashless lowercase hex id -- the shape 0001_core.sql:111
// documents and the shape the migration normalised every row into. NOT a
// plain "need-1": getNeedByUuid runs its input through normalizeUuid, and a
// test that never binds a realistic UUID cannot see what that does.
const uuid = (n: number): string => n.toString(16).padStart(32, "0");

// Django's `str(datetime)` -- `YYYY-MM-DD HH:MM:SS.ffffff`, which is what
// pyNow() writes and what migration 0022 rewrote every stored value into.
// Used everywhere below rather than toISOString(), because `created` is TEXT
// and SQLite orders TEXT lexicographically: mixing the two formats reorders
// the feed, and is pinned deliberately in its own test.
const at = (day: number, hour = 9): string => `2026-09-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:00:00.000000`;

interface FoodbankSeed {
  id: number;
  name?: string;
  alt_name?: string | null;
  slug?: string;
  network?: string | null;
  is_closed?: number;
  latest_need_id?: number | null;
}

// Fills in the eighteen NOT NULL columns nothing in this module reads. The
// four that matter -- name, alt_name and slug (the joined values the views
// supply now that 0019 dropped the cached copies) and latest_need_id (the
// join key getFoodbankIdsByCategory hangs everything on) -- are explicit at
// the call site whenever a test is about them.
function seedFoodbank(fb: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank (
       id, uuid, name, alt_name, slug, network, address, postcode, country, lat_lng,
       charity_just_foodbank, contact_email, url, shopping_list_url,
       address_is_administrative, is_closed, no_locations, days_between_needs,
       created, modified, latest_need_id
     ) VALUES (?, ?, ?, ?, ?, ?, 'Address', 'SP2 9DY', 'England', '51.06,-1.79',
       0, 'info@example.org', 'https://example.org/', 'https://example.org/list/',
       0, ?, 0, 7,
       '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000', ?)`,
  ).run(
    fb.id,
    `uuid-${fb.id}`,
    fb.name ?? `Foodbank ${fb.id}`,
    fb.alt_name === undefined ? null : fb.alt_name,
    fb.slug ?? `foodbank-${fb.id}`,
    fb.network === undefined ? "Trussell Trust" : fb.network,
    fb.is_closed ?? 0,
    fb.latest_need_id === undefined ? null : fb.latest_need_id,
  );
}

interface NeedSeed {
  id: number;
  need_id?: string;
  foodbank_id?: number | null;
  created: string;
  modified?: string;
  published?: number;
  // Explicitly nullable, both of them. 0001_core.sql:118-119 spells out
  // "NULLABLE: NULL is NOT 0" -- these are the tri-state columns
  // coerceBooleans must not collapse.
  nonpertinent?: number | null;
  is_categorised?: number | null;
  change_text?: string;
  excess_change_text?: string | null;
  notified?: string | null;
  input_method?: string;
  uri?: string | null;
}

function seedNeed(need: NeedSeed): void {
  db.prepare(
    `INSERT INTO foodbankchange (
       id, need_id, foodbank_id, distill_id, name, uri,
       change_text, change_text_original, excess_change_text, excess_change_text_original,
       published, nonpertinent, is_categorised, notified, input_method, created, modified
     ) VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    need.id,
    need.need_id ?? uuid(need.id),
    need.foodbank_id === undefined ? 1 : need.foodbank_id,
    need.uri ?? null,
    need.change_text ?? "Beans, Pasta, Nappies",
    need.excess_change_text === undefined ? null : need.excess_change_text,
    need.published ?? 1,
    need.nonpertinent === undefined ? 0 : need.nonpertinent,
    need.is_categorised === undefined ? 0 : need.is_categorised,
    need.notified === undefined ? null : need.notified,
    need.input_method ?? "scrape",
    need.created,
    need.modified ?? need.created,
  );
}

interface LineSeed {
  id: number;
  need_id: number; // FK to foodbankchange.id -- an INTEGER, not the need_id UUID
  foodbank_id: number;
  item?: string;
  type?: string;
  category?: string;
  group_name?: string;
  created?: string;
}

function seedLine(line: LineSeed): void {
  db.prepare(
    `INSERT INTO foodbankchangeline (id, need_id, foodbank_id, item, type, category, group_name, created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    line.id,
    line.need_id,
    line.foodbank_id,
    line.item ?? "Pasta",
    line.type ?? "need",
    line.category ?? "Pasta",
    line.group_name ?? "Dried Goods",
    line.created ?? at(5),
  );
}

const needIds = (rows: { need_id: string }[]): string[] => rows.map((row) => row.need_id);
const ids = (rows: { id: number }[]): number[] => rows.map((row) => row.id);
const ascending = (values: number[]): number[] => [...values].sort((a, b) => a - b);

// =========================================================================
// mapNeedRow -- the boolean coercion four other modules import
// =========================================================================

describe("mapNeedRow", () => {
  // Driven through real stored values read back off the real view, not
  // through a hand-written literal. The thing being proved is that what D1
  // actually hands back (INTEGER 0/1/NULL) becomes what packages/serialise
  // and the templates actually expect (true/false/null) -- a literal
  // `{ published: 1 }` would prove only that the test author knows what
  // coerceBooleans does.
  function readViewRow(id: number): Record<string, unknown> {
    return db.prepare("SELECT * FROM foodbankchange_full WHERE id = ?").get(id) as Record<string, unknown>;
  }

  it("turns the three INTEGER flag columns into real booleans", () => {
    seedFoodbank({ id: 1 });
    seedNeed({ id: 1, created: at(5), published: 1, nonpertinent: 0, is_categorised: 1 });

    const row = mapNeedRow(readViewRow(1));

    expect(row.published).toBe(true);
    expect(row.nonpertinent).toBe(false);
    expect(row.is_categorised).toBe(true);
  });

  // THE TRI-STATE. `nonpertinent` and `is_categorised` are NULLABLE and
  // 0001_core.sql says so in as many words: NULL means "never reviewed",
  // which is not the same as "reviewed and found pertinent". A `?? false`
  // anywhere in this mapping would move every legacy unreviewed need into
  // the reviewed bucket, and the admin queue that counts on the difference
  // (needAdmin.ts's getUnpublishedNeeds) would quietly shrink.
  it("preserves NULL rather than collapsing it to false", () => {
    seedFoodbank({ id: 1 });
    seedNeed({ id: 1, created: at(5), nonpertinent: null, is_categorised: null });

    const row = mapNeedRow(readViewRow(1));

    expect(row.nonpertinent).toBeNull();
    expect(row.is_categorised).toBeNull();
  });

  // `published` is NOT NULL DEFAULT 0, so it is the one flag that can never
  // arrive as NULL -- but it still has to come back as `false`, not `0`,
  // because the templates test it with a plain truthiness check and the
  // serialiser emits it into JSON.
  it("maps a stored 0 to false, not to the number 0", () => {
    seedFoodbank({ id: 1 });
    seedNeed({ id: 1, created: at(5), published: 0 });

    expect(mapNeedRow(readViewRow(1)).published).toBe(false);
  });

  // Everything else passes through byte-identical, INCLUDING columns the
  // FoodbankChangeRow interface does not declare. `foodbank_slug` is one:
  // the view supplies it (0019_drop_foodbank_cache.sql:87), the type does
  // not mention it, and callers such as getRecentlyUpdated's siblings reach
  // for it anyway. A "tidier" mapping that built the row key-by-key from
  // the interface would drop it, with no type error to say so.
  it("passes every other column through untouched, declared in the type or not", () => {
    seedFoodbank({ id: 1, name: "Salisbury Foodbank", slug: "salisbury" });
    seedNeed({
      id: 1,
      created: at(5, 14),
      notified: at(6, 8),
      change_text: "Beans, Pasta",
      excess_change_text: "Baked Beans",
      uri: "https://salisbury.foodbank.org.uk/give-help/donate-food/",
      input_method: "typed",
    });

    const row = mapNeedRow(readViewRow(1)) as unknown as Record<string, unknown>;

    expect(row.need_id).toBe(uuid(1));
    expect(row.change_text).toBe("Beans, Pasta");
    expect(row.excess_change_text).toBe("Baked Beans");
    expect(row.uri).toBe("https://salisbury.foodbank.org.uk/give-help/donate-food/");
    expect(row.input_method).toBe("typed");
    expect(row.created).toBe(at(5, 14));
    expect(row.foodbank_name).toBe("Salisbury Foodbank");
    expect(row.foodbank_slug).toBe("salisbury");
    // `notified` reads like a flag and is not one -- it is the TEXT
    // timestamp of the subscriber send. Adding it to BOOLEAN_COLUMNS is a
    // one-word mutation that would turn every notified-at time into `false`
    // and every un-notified need into `null`, which looks identical in the
    // admin until someone tries to display the date.
    expect(row.notified).toBe(at(6, 8));
  });
});

// =========================================================================
// getPublishedNeeds -- gfapi1 api_needs (views.py:224) / gfapi2 needs
// =========================================================================

describe("getPublishedNeeds", () => {
  beforeEach(() => {
    seedFoodbank({ id: 1, name: "Salisbury Foodbank", slug: "salisbury" });
    seedFoodbank({ id: 2, name: "Brixton Foodbank", slug: "brixton" });
    // These are inserted in an order that is neither the answer nor its
    // reverse. That buys less than it looks like it does, and the correction
    // is worth leaving here because it is what made the first draft of this
    // file believe its ORDER BY was covered: INSERT order is not scan order.
    // Rowid is, these ids ARE the rowids, and they ascend as `created`
    // descends -- so an unordered scan returns the right answer anyway. See
    // the two ORDER BY tests below for what actually pins the clause.
    seedNeed({ id: 3, foodbank_id: 1, created: at(3), published: 1 });
    seedNeed({ id: 1, foodbank_id: 2, created: at(7), published: 1 });
    seedNeed({ id: 4, foodbank_id: 1, created: at(9), published: 0 });
    seedNeed({ id: 2, foodbank_id: 2, created: at(5), published: 1 });
  });

  it("returns the published needs newest first", async () => {
    // The 09-09 row is the newest of all four and is deliberately the
    // unpublished one, so a dropped `published = 1` shows up here as an
    // extra row at the TOP of the list, not buried in the tail.
    expect(needIds(await getPublishedNeeds(session, 50))).toEqual([uuid(1), uuid(2), uuid(3)]);
  });

  it("excludes unpublished needs entirely", async () => {
    expect(needIds(await getPublishedNeeds(session, 50))).not.toContain(uuid(4));
  });

  it("takes the LIMIT off the top of the ordering, not off the insertion order", async () => {
    // Two of three: if LIMIT were applied before ORDER BY (or the ORDER BY
    // were missing) the natural rowid order would hand back needs 3 and 1.
    expect(needIds(await getPublishedNeeds(session, 2))).toEqual([uuid(1), uuid(2)]);
  });

  // gfapi1's api_needs allow-lists limit to 100 or 1000 before it gets here,
  // so neither of these reaches production through that door -- but
  // apiDocs.ts calls this with a literal 5 and gfapi2 with a hardcoded 100,
  // and nothing in the signature stops a future caller passing 0. Pinned so
  // the SQLite semantics are on the record rather than discovered.
  it("returns nothing for a limit of 0, and everything for a negative limit", async () => {
    expect(await getPublishedNeeds(session, 0)).toEqual([]);
    // SQLite treats a negative LIMIT as "no limit" -- not as zero, and not
    // as an error.
    expect(await getPublishedNeeds(session, -1)).toHaveLength(3);
  });

  // gfapi1's api_needs has NO change_text exclusion -- read views.py:224:
  // `FoodbankChange.objects.filter(published=True).order_by("-created")`,
  // and nothing else. The three sentinels are excluded by the RSS view and
  // by the homepage's "recently updated" strip, and by neither API. Copying
  // the RSS filter into here would silently shrink a documented public
  // endpoint, and the shrink would look like "quiet week for food banks".
  it("keeps the Nothing / Unknown / Facebook sentinels, which only the RSS feed filters", async () => {
    seedNeed({ id: 5, foodbank_id: 1, created: at(11), change_text: "Nothing" });
    seedNeed({ id: 6, foodbank_id: 1, created: at(12), change_text: "Unknown" });
    seedNeed({ id: 7, foodbank_id: 1, created: at(13), change_text: "Facebook" });

    expect(needIds(await getPublishedNeeds(session, 50))).toEqual([uuid(7), uuid(6), uuid(5), uuid(1), uuid(2), uuid(3)]);
  });

  // MIGRATION 0019, THE ONE THAT ALREADY BROKE THINGS. `foodbank_name` is no
  // longer a column on foodbankchange -- it is joined live from the parent
  // by the foodbankchange_full view. This test renames the parent WITHOUT
  // touching foodbankchange and demands the API see the new name, which is
  // the entire point of the migration: the old cached copy went stale on
  // every rename and 24 rows in production were measured disagreeing.
  it("joins foodbank_name live from the parent, so a rename is visible immediately", async () => {
    db.prepare("UPDATE foodbank SET name = ? WHERE id = ?").run("Salisbury & District Foodbank", 1);

    const renamed = (await getPublishedNeeds(session, 50)).find((need) => need.need_id === uuid(3));

    expect(renamed!.foodbank_name).toBe("Salisbury & District Foodbank");
  });

  // LEFT JOIN, NOT JOIN -- 0019_drop_foodbank_cache.sql:28-32 states this as
  // a rule and this is the row that proves it. foodbankchange.foodbank_id is
  // nullable (an unassigned need, straight off the scraper before a human
  // has attached it), and an INNER JOIN would drop it from /api/needs/ with
  // no error at all. api1.ts:321 is written for exactly this shape --
  // `slugify(need.foodbank_name ?? "")`.
  it("still returns an unassigned need, with a null foodbank_name", async () => {
    seedNeed({ id: 8, foodbank_id: null, created: at(20) });

    const rows = await getPublishedNeeds(session, 50);

    expect(needIds(rows)[0]).toBe(uuid(8));
    expect(rows[0]!.foodbank_id).toBeNull();
    expect(rows[0]!.foodbank_name).toBeNull();
  });

  // D1 declares no foreign keys at all (PLAN.md §4.5), so nothing stops a
  // foodbank_id pointing at a row that no longer exists -- deleting a food
  // bank through any path that misses foodbankAdmin.ts's cascade leaves
  // exactly this. The LEFT JOIN keeps the need visible instead of making it
  // disappear from the API.
  it("still returns a need whose foodbank_id dangles", async () => {
    seedNeed({ id: 9, foodbank_id: 4242, created: at(21) });

    const rows = await getPublishedNeeds(session, 50);

    expect(rows[0]!.need_id).toBe(uuid(9));
    expect(rows[0]!.foodbank_id).toBe(4242);
    expect(rows[0]!.foodbank_name).toBeNull();
  });

  // TICKET #9, EXECUTED RATHER THAN ASSERTED. `created` is TEXT and SQLite
  // orders TEXT byte by byte, so the ordering depends on the FORMAT of the
  // stored string, not on the instant it names. Django writes
  // "2026-09-05 09:00:00.000000"; `new Date().toISOString()` writes
  // "2026-09-05T01:00:00.000Z", and 'T' (0x54) sorts above ' ' (0x20) --
  // so an ISO-formatted 1am row outranks a Django-formatted 5pm row on the
  // same day. Migration 0022 rewrote the 7 rows that had this shape, and
  // this test is the guard rail for the next person tempted to write
  // toISOString() into pyNow()'s place: the symptom is not an exception, it
  // is /api/needs/ leading with a stale need for the rest of the day.
  it("orders lexicographically, so an ISO-8601 timestamp outranks a later Django one", async () => {
    seedNeed({ id: 10, foodbank_id: 1, created: "2026-09-09T01:00:00.000Z" });
    seedNeed({ id: 11, foodbank_id: 1, created: "2026-09-09 17:00:00.000000" });

    // Chronologically 11 (5pm) is newer than 10 (1am). Lexicographically it
    // is not, and lexicographically is what runs.
    expect(needIds(await getPublishedNeeds(session, 2))).toEqual([uuid(10), uuid(11)]);
  });

  // MUTANT: `ORDER BY created DESC` -> `ORDER BY modified DESC` (and the same
  // for `notified`). Both survived the original suite, because seedNeed
  // defaults `modified` to the same value as `created` and leaves `notified`
  // NULL -- so every row agreed with itself and any datetime column produced
  // the same answer. These three rows disagree on purpose: created says
  // 12/13/14, modified says 14/13/12, notified says 13/14/12. Only one of
  // those is Django's `order_by("-created")` (views.py:224).
  //
  // `modified` is the realistic wrong answer, not a contrived one: it is
  // touched by every admin edit and every re-categorisation, so ordering by
  // it would float an old need to the top of /api/needs/ the moment somebody
  // fixed a typo on it.
  it("orders by created, not by modified or notified", async () => {
    seedNeed({ id: 12, foodbank_id: 1, created: at(25), modified: at(11), notified: at(20) });
    seedNeed({ id: 13, foodbank_id: 1, created: at(24), modified: at(12), notified: at(22) });
    seedNeed({ id: 14, foodbank_id: 1, created: at(23), modified: at(13), notified: at(21) });

    expect(needIds(await getPublishedNeeds(session, 50))).toEqual([uuid(12), uuid(13), uuid(14), uuid(1), uuid(2), uuid(3)]);
  });

  // MUTANT: drop `.map(mapNeedRow)` and return `result.results` directly.
  // It survived: every boolean assertion in this file used to run through
  // mapNeedRow directly or through the two single-row lookups, so the LIST
  // path -- the one gfapi1 and gfapi2 actually serve -- never proved it
  // coerced anything. The symptom is not an exception; it is
  // `"published": 1` and `"is_categorised": 1` in public JSON where every
  // documented example says `true`, for every consumer parsing the feed.
  it("coerces the flag columns on every row of the list, not only on the single-row lookups", async () => {
    seedNeed({ id: 15, foodbank_id: 1, created: at(25), published: 1, nonpertinent: null, is_categorised: 1 });

    const row = (await getPublishedNeeds(session, 50))[0]!;

    expect(row.need_id).toBe(uuid(15));
    expect(row.published).toBe(true);
    expect(row.is_categorised).toBe(true);
    expect(row.nonpertinent).toBeNull();
  });

  // MUTANT: delete the ORDER BY clause outright. Asserted against the SQL
  // rather than against rows, and that is deliberate -- it is the one
  // mutation in this describe that ROWS CANNOT CATCH, verified by running it.
  //
  // 0001_core.sql:126 declares
  // `change_pub_created_idx ON foodbankchange(published, created DESC) WHERE published = 1`,
  // a partial index that exactly matches this WHERE clause and already holds
  // its entries in created-DESC order. EXPLAIN QUERY PLAN confirms SQLite
  // picks it with or without the ORDER BY, so an unordered query returns
  // newest-first anyway, for every arrangement of seed data. The ordering is
  // currently a gift from the index, not from the query.
  //
  // That gift is revocable: index choice is a planner decision that turns on
  // table statistics, and it is not guaranteed to survive an ANALYZE, a
  // schema change that drops or narrows this index, or D1's planner
  // disagreeing with node:sqlite's. If the ORDER BY were ever deleted the
  // suite would stay green here and /api/needs/ would keep working right up
  // until one of those happened. So the clause is pinned where it is
  // observable at all: in the statement the module sends.
  it("asks for the ordering in SQL rather than relying on the partial index that happens to supply it", async () => {
    await getPublishedNeeds(session, 50);

    expect(executed[0]!.sql).toContain("ORDER BY created DESC");
  });

  it("binds the limit and nothing else", async () => {
    await getPublishedNeeds(session, 100);

    expect(executed).toHaveLength(1);
    expect(executed[0]!.params).toEqual([100]);
  });
});

// =========================================================================
// getRecentPublishedNeedsForRss -- gfwfbn rss (views.py:132-189)
// =========================================================================

describe("getRecentPublishedNeedsForRss", () => {
  beforeEach(() => {
    // Ids chosen so foodbank.id and foodbankchange.id can never coincide --
    // the RSS row's `id` is the NEED's, and getNeedTranslationsByIds is
    // handed it directly. If the SELECT list ever picked up `f.id` instead,
    // the feed would silently render every need in English.
    seedFoodbank({ id: 30, name: "Salisbury Foodbank", alt_name: "Salisbury Trussell", slug: "salisbury" });
    seedFoodbank({ id: 31, name: "Brixton Foodbank", alt_name: null, slug: "brixton" });
    seedNeed({ id: 3, foodbank_id: 30, created: at(3), change_text: "Beans" });
    seedNeed({ id: 1, foodbank_id: 31, created: at(7), change_text: "Pasta" });
    seedNeed({ id: 2, foodbank_id: 30, created: at(5), change_text: "Nappies" });
  });

  it("returns the joined parent's slug, name and alt_name alongside the need", async () => {
    const rows = await getRecentPublishedNeedsForRss(session, 10);

    expect(rows.map((row) => row.foodbank_slug)).toEqual(["brixton", "salisbury", "salisbury"]);
    expect(rows.map((row) => row.foodbank_name)).toEqual(["Brixton Foodbank", "Salisbury Foodbank", "Salisbury Foodbank"]);
    // alt_name is what fullNameLocaleAware() renders the "(also known as)"
    // half of the feed title from; a null must stay null, not become "".
    expect(rows.map((row) => row.foodbank_alt_name)).toEqual([null, "Salisbury Trussell", "Salisbury Trussell"]);
  });

  // The `id` in the SELECT list is `fc.id`, and RssNeedRow's own comment
  // says why: rss.ts hands it straight to getNeedTranslationsByIds, whose FK
  // is foodbankchange.id. The food banks here are numbered 30/31 and the
  // needs 1/2/3 precisely so a `f.id` mutant produces a visibly wrong answer
  // instead of an accidentally-right one.
  it("returns the NEED's numeric id, not the food bank's", async () => {
    expect(ids(await getRecentPublishedNeedsForRss(session, 10))).toEqual([1, 2, 3]);
  });

  it("orders newest first and honours the limit", async () => {
    expect(needIds(await getRecentPublishedNeedsForRss(session, 2))).toEqual([uuid(1), uuid(2)]);
  });

  // MUTANT: `fc.created` -> `f.created` in the SELECT list. It survived,
  // because nothing here ever looked at the VALUE of `created` -- only at the
  // order it produced, and the ORDER BY still said `fc.created`, so the rows
  // came back in the right sequence carrying the wrong dates.
  //
  // rss.ts feeds this column into each item's `<pubDate>`. The food bank rows
  // in this fixture were all created 2020-01-01, which is exactly what the
  // mutant emits: a feed of today's needs every one of which claims to be six
  // years old. Readers sort by pubDate, so the whole feed would silently sink.
  it("returns the NEED's created timestamp, not the food bank's", async () => {
    expect((await getRecentPublishedNeedsForRss(session, 10)).map((row) => row.created)).toEqual([at(7), at(5), at(3)]);
  });

  // MUTANT: `ORDER BY fc.created DESC` -> `ORDER BY fc.modified DESC`, the
  // same hole as in getPublishedNeeds and it survived here for the same
  // reason -- seedNeed defaults modified to created, so no seeded row could
  // tell the two apart. Django's rss view orders by `-created`
  // (views.py:144); ordering by modified would reshuffle the feed every time
  // an admin re-categorised an old need, and re-notify subscribers about it.
  it("orders by the need's created, not by its modified", async () => {
    seedNeed({ id: 40, foodbank_id: 30, created: at(25), modified: at(11) });
    seedNeed({ id: 41, foodbank_id: 30, created: at(24), modified: at(12) });
    seedNeed({ id: 42, foodbank_id: 30, created: at(23), modified: at(13) });

    expect(needIds(await getRecentPublishedNeedsForRss(session, 10))).toEqual([
      uuid(40),
      uuid(41),
      uuid(42),
      uuid(1),
      uuid(2),
      uuid(3),
    ]);
  });

  // MUTANT: delete the ORDER BY. Unlike getPublishedNeeds -- where a partial
  // index donates created-DESC order and no data can expose the deletion --
  // this one IS catchable, but only through the SCOPED query, and only with
  // ids that run the same way as the timestamps.
  //
  // EXPLAIN QUERY PLAN, run against this schema: the unscoped feed is
  // answered by `change_pub_created_idx (published, created DESC)`, which is
  // already in the right order; add `AND fc.foodbank_id = ?` and the planner
  // switches to `change_published_foodbank_idx (published, foodbank_id)`,
  // which is not, and an unordered query then comes back in rowid order.
  // Every other scoped row in this file has its ids descending as its
  // timestamps descend, so rowid order and the correct answer coincide and
  // the mutant slips through. These three ASCEND together, so the unordered
  // result is the exact reverse of the assertion.
  it("orders a single food bank's feed by created even when the planner's index does not", async () => {
    seedFoodbank({ id: 33, name: "Tisbury Foodbank", slug: "tisbury" });
    seedNeed({ id: 43, foodbank_id: 33, created: at(10), change_text: "Rice" });
    seedNeed({ id: 44, foodbank_id: 33, created: at(11), change_text: "Soup" });
    seedNeed({ id: 45, foodbank_id: 33, created: at(12), change_text: "Tea" });

    expect(needIds(await getRecentPublishedNeedsForRss(session, 10, 33))).toEqual([uuid(45), uuid(44), uuid(43)]);
  });

  // The statement-level half of the same guard, for the unscoped path where
  // the index makes the deletion invisible in the rows. See the matching
  // comment in getPublishedNeeds for why an index-donated ordering is not
  // one the site should be resting on.
  it("asks for the ordering in SQL on the unscoped feed too", async () => {
    await getRecentPublishedNeedsForRss(session, 10);

    expect(executed[0]!.sql).toContain("ORDER BY fc.created DESC");
  });

  it("excludes unpublished needs", async () => {
    seedNeed({ id: 4, foodbank_id: 30, created: at(20), published: 0 });

    expect(needIds(await getRecentPublishedNeedsForRss(session, 10))).not.toContain(uuid(4));
  });

  // The three sentinels are contract, not data: "Nothing" means the food
  // bank published an empty list, "Unknown" means the scrape failed,
  // "Facebook" means the need lives somewhere this site cannot read. Django
  // chains three .exclude() calls (views.py:144) and the feed would
  // otherwise carry an item titled "0 items requested at ...".
  it("excludes the Unknown / Facebook / Nothing sentinels", async () => {
    seedNeed({ id: 5, foodbank_id: 30, created: at(20), change_text: "Nothing" });
    seedNeed({ id: 6, foodbank_id: 30, created: at(21), change_text: "Unknown" });
    seedNeed({ id: 7, foodbank_id: 30, created: at(22), change_text: "Facebook" });

    // All three are newer than everything else, so a broken exclusion puts
    // them at the top of the assertion rather than hiding in the tail.
    expect(needIds(await getRecentPublishedNeedsForRss(session, 10))).toEqual([uuid(1), uuid(2), uuid(3)]);
  });

  // Exact match, not substring: `NOT IN ('Unknown', ...)` compares whole
  // values. A real need whose text merely begins with one of the words must
  // survive, or a food bank asking for "Nothing perishable please" vanishes
  // from its own feed.
  it("excludes only exact sentinel matches, never a need that contains one", async () => {
    seedNeed({ id: 8, foodbank_id: 30, created: at(20), change_text: "Nothing perishable please" });

    expect(needIds(await getRecentPublishedNeedsForRss(session, 10))[0]).toBe(uuid(8));
  });

  // SQLite's default collation is BINARY, so the comparison is
  // case-SENSITIVE. Pinned because it is the current behaviour and because
  // the opposite (a column declared COLLATE NOCASE, or a LOWER() creeping
  // into the predicate) would start silently dropping real needs whose text
  // happens to be the lowercase word.
  it("does not exclude a lowercase 'nothing' -- the comparison is case-sensitive", async () => {
    seedNeed({ id: 9, foodbank_id: 30, created: at(20), change_text: "nothing" });

    expect(needIds(await getRecentPublishedNeedsForRss(session, 10))[0]).toBe(uuid(9));
  });

  describe("scoped to one food bank", () => {
    it("returns only that food bank's needs", async () => {
      expect(needIds(await getRecentPublishedNeedsForRss(session, 10, 30))).toEqual([uuid(2), uuid(3)]);
    });

    // PARAMETER ORDER. The filter clause is spliced into the middle of the
    // SQL but its binding is prepended to the array, so the two must agree:
    // `[foodbankId, limit]` when scoped, `[limit]` when not. Swapping them
    // does not throw -- it asks for the food bank whose id is 10 and limits
    // to 30 rows, which on a site with 1,071 food banks returns a plausible
    // feed for the wrong charity.
    it("binds the food bank id before the limit", async () => {
      await getRecentPublishedNeedsForRss(session, 10, 30);

      expect(executed).toHaveLength(1);
      expect(executed[0]!.params).toEqual([30, 10]);
    });

    it("binds only the limit when no food bank is given", async () => {
      await getRecentPublishedNeedsForRss(session, 10);

      expect(executed[0]!.params).toEqual([10]);
      expect(executed[0]!.sql).not.toContain("fc.foodbank_id = ?");
    });

    // `foodbankId !== undefined`, not a truthiness check. Food bank id 0 is
    // a legal INTEGER PRIMARY KEY in SQLite, and `if (foodbankId)` would
    // silently widen a scoped feed into the site-wide one -- the failure
    // being extra items, not missing ones, which nobody reports.
    it("treats food bank id 0 as a real filter, not as absent", async () => {
      seedFoodbank({ id: 0, name: "Zero Foodbank", slug: "zero" });
      seedNeed({ id: 10, foodbank_id: 0, created: at(4), change_text: "Rice" });

      const rows = await getRecentPublishedNeedsForRss(session, 10, 0);

      expect(needIds(rows)).toEqual([uuid(10)]);
      expect(executed[0]!.params).toEqual([0, 10]);
    });

    it("returns nothing for a food bank with no published needs", async () => {
      seedFoodbank({ id: 32, name: "Wilton Foodbank", slug: "wilton" });

      expect(await getRecentPublishedNeedsForRss(session, 10, 32)).toEqual([]);
    });
  });

  // INNER JOIN, and this is the one query in the module that has one. Django
  // reaches `need.foodbank.full_name()` in the template loop
  // (views.py:159-160), so a published need with no food bank raises
  // AttributeError and 500s the whole feed there; here the join simply drops
  // it and the other nine items still render. That is a DIVERGENCE, pinned
  // as behaviour rather than fixed -- the port is the more forgiving of the
  // two, and "fixing" it to a LEFT JOIN would put a null through
  // fullNameLocaleAware() and urlForLocale() in rss.ts and reintroduce the
  // 500 this port does not have.
  it("drops an unassigned need rather than emitting a feed item with no food bank", async () => {
    seedNeed({ id: 11, foodbank_id: null, created: at(25) });

    expect(needIds(await getRecentPublishedNeedsForRss(session, 10))).toEqual([uuid(1), uuid(2), uuid(3)]);
  });

  it("drops a need whose foodbank_id dangles", async () => {
    seedNeed({ id: 12, foodbank_id: 9999, created: at(25) });

    expect(needIds(await getRecentPublishedNeedsForRss(session, 10))).not.toContain(uuid(12));
  });

  // ITEMS_LIMIT is 10 in rss.ts, matching Django's `[:10]`. Seeded past it
  // so the limit is doing real work: with 12 candidates a missing LIMIT
  // returns 12 and a LIMIT applied before the sort returns the wrong 10.
  it("takes the newest 10 of 12, not the first 10 inserted", async () => {
    for (let n = 20; n < 30; n++) seedNeed({ id: n, foodbank_id: 30, created: at(n - 10) });

    const rows = await getRecentPublishedNeedsForRss(session, 10);

    expect(rows).toHaveLength(10);
    // 09-19 down to 09-10: the ten newest, and none of the three from the
    // outer seed (09-03/05/07) survive the cut.
    expect(ids(rows)).toEqual([29, 28, 27, 26, 25, 24, 23, 22, 21, 20]);
  });
});

// =========================================================================
// getNeedByUuid -- gfapi1 api_need / gfapi2 need, and every admin need page
// =========================================================================

describe("getNeedByUuid", () => {
  const DASHLESS = "3f2504e04f8911d39a0c0305e82c3301";
  const DASHED = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

  beforeEach(() => {
    seedFoodbank({ id: 1, name: "Salisbury Foodbank", slug: "salisbury" });
    seedNeed({ id: 1, need_id: DASHLESS, foodbank_id: 1, created: at(5), change_text: "Beans, Pasta" });
  });

  // The stored form is dashless (PLAN.md §4.4, and 0001_core.sql:111 says
  // so) but every URL Django ever emitted carries the dashed str(UUID) form,
  // and those URLs are in the wild -- in the API docs, in bookmarks, in
  // other people's code. normalizeUuid is what stops those 404ing.
  it("finds a dashless row from the dashed UUID in a public URL", async () => {
    const need = await getNeedByUuid(session, DASHED);

    expect(need!.need_id).toBe(DASHLESS);
    expect(executed[0]!.params).toEqual([DASHLESS]);
  });

  it("finds it from the dashless form too", async () => {
    expect((await getNeedByUuid(session, DASHLESS))!.id).toBe(1);
  });

  it("lowercases an uppercase UUID before binding", async () => {
    expect((await getNeedByUuid(session, DASHED.toUpperCase()))!.id).toBe(1);
    expect(executed[0]!.params).toEqual([DASHLESS]);
  });

  // The normalisation is ONE WAY: it strips dashes from the input, it does
  // not add them. So the dashless-storage invariant migration 0022's
  // predecessors established is load-bearing -- a row written back in the
  // dashed form by some future importer becomes permanently unreachable
  // through this function, and its /need/<id>/ page 404s while the row sits
  // there in the admin list.
  it("cannot find a row that was stored in the dashed form", async () => {
    const OTHER_DASHED = "11111111-2222-3333-4444-555555555555";
    seedNeed({ id: 2, need_id: OTHER_DASHED, foodbank_id: 1, created: at(6) });

    // Asked for by its own stored key, in its own stored spelling -- and
    // still not found, because normalizeUuid strips the dashes off the
    // question and nothing ever puts them back on.
    expect(await getNeedByUuid(session, OTHER_DASHED)).toBeNull();
    expect(executed.at(-1)!.params).toEqual(["11111111222233334444555555555555"]);
  });

  it("returns null for an unknown UUID rather than throwing", async () => {
    expect(await getNeedByUuid(session, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  // MUTANT: `need_id = ?` -> `need_id LIKE ? || '%'`. It survived the
  // original suite, because every id asked for was a full 32 characters and
  // no 32-character string is a strict prefix of another -- so a prefix match
  // and an exact match returned the same row every time.
  //
  // Both inputs below are things a real URL hands over. A truncated UUID is
  // what a copy-paste out of a spreadsheet or a line-wrapped email produces,
  // and it must 404 rather than serving whichever need happens to share those
  // eight characters. `%` is worse: normalizeUuid strips dashes and
  // lowercases but does not touch LIKE metacharacters, so under the mutant
  // `/need/%/` matches EVERY row and returns an arbitrary one -- including
  // unpublished needs, which this function deliberately does not filter out.
  // An enumeration hole reached by one character in a path.
  it("matches the need_id exactly, so a truncated or wildcard id finds nothing", async () => {
    expect(await getNeedByUuid(session, DASHLESS.slice(0, 8))).toBeNull();
    expect(await getNeedByUuid(session, "%")).toBeNull();
  });

  // No `published` predicate, matching Django's
  // `get_object_or_404(FoodbankChange, need_id=id)` (views.py:246) exactly.
  // gfapi1's /need/<id>/ therefore serves an unpublished need to anyone
  // holding its UUID -- and the admin's own need page (admin/needs.ts:97)
  // depends on that, since a need is unpublished precisely while it is
  // waiting to be reviewed there.
  it("returns an unpublished need, because neither the API nor the admin filters on published", async () => {
    seedNeed({ id: 3, need_id: uuid(3), foodbank_id: 1, created: at(6), published: 0 });

    const need = await getNeedByUuid(session, uuid(3));

    expect(need!.published).toBe(false);
  });

  it("reads the view, so foodbank_name comes from the live parent", async () => {
    db.prepare("UPDATE foodbank SET name = ? WHERE id = ?").run("Salisbury & District Foodbank", 1);

    expect((await getNeedByUuid(session, DASHED))!.foodbank_name).toBe("Salisbury & District Foodbank");
  });

  it("returns an unassigned need with a null foodbank_name, not null", async () => {
    seedNeed({ id: 4, need_id: uuid(4), foodbank_id: null, created: at(6) });

    const need = await getNeedByUuid(session, uuid(4));

    expect(need).not.toBeNull();
    expect(need!.foodbank_name).toBeNull();
  });

  it("coerces the flag columns on the single row too", async () => {
    seedNeed({ id: 5, need_id: uuid(5), foodbank_id: 1, created: at(6), published: 1, nonpertinent: null, is_categorised: 0 });

    const need = await getNeedByUuid(session, uuid(5));

    expect(need!.published).toBe(true);
    expect(need!.nonpertinent).toBeNull();
    expect(need!.is_categorised).toBe(false);
  });
});

// =========================================================================
// getNeedById -- foodbank.ts's single-row `latest_need` resolution
// =========================================================================

describe("getNeedById", () => {
  beforeEach(() => {
    seedFoodbank({ id: 1, name: "Salisbury Foodbank", slug: "salisbury", latest_need_id: 501 });
    seedNeed({ id: 501, foodbank_id: 1, created: at(5), change_text: "Beans, Pasta", is_categorised: 1 });
  });

  it("looks the row up by primary key and maps it", async () => {
    const need = await getNeedById(session, 501);

    expect(need!.need_id).toBe(uuid(501));
    expect(need!.change_text).toBe("Beans, Pasta");
    expect(need!.is_categorised).toBe(true);
    expect(executed[0]!.params).toEqual([501]);
  });

  // foodbank.ts:104 calls this with whatever latest_need_id holds, and D1
  // has no foreign keys to stop that pointing at a deleted need. Returning
  // null is what lets `latestNeed: null` flow through instead of a throw.
  it("returns null for an id that no longer exists", async () => {
    expect(await getNeedById(session, 999)).toBeNull();
  });

  // The LEFT JOIN again, on the hottest path in the site. A food bank's own
  // page resolves latest_need through here; an INNER JOIN would return null
  // for any need whose foodbank_id is null or dangling, and the page would
  // render "no current need" for a food bank that has one.
  it("returns a need whose foodbank_id is null, with a null foodbank_name", async () => {
    seedNeed({ id: 502, foodbank_id: null, created: at(6) });

    const need = await getNeedById(session, 502);

    expect(need!.id).toBe(502);
    expect(need!.foodbank_name).toBeNull();
  });

  // No `published` predicate here either. latest_need_id is set by
  // needAdmin.ts's recomputeFoodbankNeedFields from the newest PUBLISHED
  // need, so in practice this only ever sees published rows -- but the
  // filtering lives there, not here, and adding a second one would make the
  // two silently disagree the moment that logic changes.
  it("does not filter on published", async () => {
    seedNeed({ id: 503, foodbank_id: 1, created: at(6), published: 0 });

    expect((await getNeedById(session, 503))!.published).toBe(false);
  });
});

// =========================================================================
// getNeedsByIds -- the batched form foodbank.ts uses for list endpoints
// =========================================================================

describe("getNeedsByIds", () => {
  beforeEach(() => {
    seedFoodbank({ id: 1, name: "Salisbury Foodbank", slug: "salisbury" });
    seedFoodbank({ id: 2, name: "Brixton Foodbank", slug: "brixton" });
    seedNeed({ id: 501, foodbank_id: 1, created: at(5), change_text: "Beans" });
    seedNeed({ id: 502, foodbank_id: 2, created: at(6), change_text: "Pasta" });
    seedNeed({ id: 503, foodbank_id: 1, created: at(7), change_text: "Nappies" });
  });

  // THE `IN ()` GUARD. Without the early return this builds
  // `WHERE id IN ()`, which SQLite parses but D1 rejects, and it would fire
  // on every list endpoint where no result had a latest need. The assertion
  // that matters is the second one: no statement was sent at all.
  it("returns an empty map for an empty id list without touching the database", async () => {
    expect(await getNeedsByIds(session, [])).toEqual(new Map());
    expect(executed).toHaveLength(0);
  });

  it("keys the map by foodbankchange.id and maps every row", async () => {
    const needs = await getNeedsByIds(session, [503, 501]);

    expect(ascending([...needs.keys()])).toEqual([501, 503]);
    expect(needs.get(501)!.change_text).toBe("Beans");
    expect(needs.get(503)!.change_text).toBe("Nappies");
    expect(needs.get(501)!.foodbank_name).toBe("Salisbury Foodbank");
  });

  // Absent, not present-and-undefined. foodbank.ts:174 reads
  // `needsById.get(id) ?? null`, so a missing id has to fall through to
  // null rather than becoming an entry -- and a food bank whose
  // latest_need_id dangles must still render, minus its need.
  it("omits ids that match no row instead of inventing entries for them", async () => {
    const needs = await getNeedsByIds(session, [501, 9999]);

    expect(needs.size).toBe(1);
    expect(needs.has(9999)).toBe(false);
  });

  // No dedupe in here -- getFoodbanksByIds does it (via a Set) before
  // calling. Pinned in both halves: the Map collapses duplicates for free,
  // but the PARAMETER count does not, which is what actually matters
  // against the cap tested below. A caller that stopped deduping would
  // double its parameter count with no visible change to the result.
  it("sends one placeholder per id even when the caller repeats one", async () => {
    const needs = await getNeedsByIds(session, [501, 501, 502]);

    expect(ascending([...needs.keys()])).toEqual([501, 502]);
    expect(executed[0]!.params).toEqual([501, 501, 502]);
  });

  it("issues exactly one statement however many ids it is given", async () => {
    await getNeedsByIds(session, [501, 502, 503]);

    expect(executed).toHaveLength(1);
  });

  // MUTANT: drop `.map(mapNeedRow)` and put the raw D1 rows in the Map. It
  // survived, exactly as the same mutation survived in getPublishedNeeds:
  // this describe checked change_text and foodbank_name, both of which pass
  // through untouched, and never a flag column.
  //
  // This is the batched path every list and search endpoint resolves
  // `latest_need` through, so the raw INTEGER would reach the serialiser and
  // surface as `"published": 1` in /api/2/foodbanks/ -- valid JSON, wrong
  // type, and identical to the correct output under any truthiness check,
  // which is why no template would reveal it.
  it("coerces the flag columns on every row of the batch too", async () => {
    seedNeed({ id: 504, foodbank_id: 1, created: at(8), published: 1, nonpertinent: null, is_categorised: 1 });

    const need = (await getNeedsByIds(session, [504])).get(504)!;

    expect(need.published).toBe(true);
    expect(need.is_categorised).toBe(true);
    expect(need.nonpertinent).toBeNull();
  });

  it("returns rows for every id at exactly 100, D1's bound-parameter cap", async () => {
    const batch = Array.from({ length: 100 }, (_, i) => 600 + i);
    for (const id of batch) seedNeed({ id, foodbank_id: 1, created: at(5) });

    const needs = await getNeedsByIds(session, batch);

    expect(needs.size).toBe(100);
    expect(executed).toHaveLength(1);
    expect(executed[0]!.params).toHaveLength(100);
  });

  // D1'S 100-BOUND-PARAMETER CEILING, ONE OVER. This function builds ONE
  // statement with one placeholder per id and does NOT chunk (unlike
  // needAdmin.ts:315, which slices at 90 for exactly this reason), so 101
  // ids is a single 101-parameter statement -- which node:sqlite (limit
  // 32,766) runs happily and D1 rejects outright.
  //
  // Asserted as WHAT IT DOES, not as the chunking it does not have, so this
  // suite stays green and the landmine is on the record. Today's callers are
  // safe by accident: getFoodbanksByIds passes the distinct latest_need_ids
  // of an already-truncated result page (20 for the searches, and it dedupes
  // first). Anyone raising that quantity, or calling this from somewhere
  // new, should find the ceiling here rather than in production.
  it("builds a single un-chunked 101-parameter statement, which D1 would reject", async () => {
    const batch = Array.from({ length: 101 }, (_, i) => 600 + i);
    for (const id of batch) seedNeed({ id, foodbank_id: 1, created: at(5) });

    const needs = await getNeedsByIds(session, batch);

    expect(needs.size).toBe(101);
    expect(executed).toHaveLength(1);
    expect(executed[0]!.params).toHaveLength(101);
  });
});

// =========================================================================
// getFoodbankIdsByCategory -- the /needs/?item= filter, the food-bank half
// of givefood/utils/geo.py's find_locations_by_category() (:304-404)
// =========================================================================

describe("getFoodbankIdsByCategory", () => {
  beforeEach(() => {
    // Salisbury's current need wants Pasta; its previous one did too.
    seedFoodbank({ id: 1, name: "Salisbury Foodbank", slug: "salisbury", latest_need_id: 501 });
    // Brixton's current need wants Nappies only.
    seedFoodbank({ id: 2, name: "Brixton Foodbank", slug: "brixton", latest_need_id: 502 });

    seedNeed({ id: 500, foodbank_id: 1, created: at(1) });
    seedNeed({ id: 501, foodbank_id: 1, created: at(5) });
    seedNeed({ id: 502, foodbank_id: 2, created: at(5) });

    seedLine({ id: 1, need_id: 500, foodbank_id: 1, item: "Pasta", category: "Pasta" });
    seedLine({ id: 2, need_id: 501, foodbank_id: 1, item: "Penne", category: "Pasta" });
    seedLine({ id: 3, need_id: 502, foodbank_id: 2, item: "Nappies", category: "Baby" });
  });

  it("returns the food bank whose CURRENT need asks for the category", async () => {
    expect(await getFoodbankIdsByCategory(session, "Pasta")).toEqual([1]);
    expect(await getFoodbankIdsByCategory(session, "Baby")).toEqual([2]);
  });

  // THE `OuterRef('latest_need')` JOIN, AND THE WHOLE REASON IT IS THERE.
  // foodbankchangeline is a verbatim mirror of every historical need's line
  // items -- 332,478 rows, not 1,071 -- so matching on category+type alone
  // would return every food bank that has EVER wanted pasta. The site would
  // send someone across town with a bag of penne to a food bank whose
  // current need is nappies. Need 500 is Salisbury's previous need and is
  // the only Pasta line for food bank 3 here.
  it("ignores a category that only appears in a food bank's PAST needs", async () => {
    seedFoodbank({ id: 3, name: "Wilton Foodbank", slug: "wilton", latest_need_id: 504 });
    seedNeed({ id: 503, foodbank_id: 3, created: at(1) });
    seedNeed({ id: 504, foodbank_id: 3, created: at(5) });
    seedLine({ id: 4, need_id: 503, foodbank_id: 3, item: "Fusilli", category: "Pasta" });
    seedLine({ id: 5, need_id: 504, foodbank_id: 3, item: "Soup", category: "Tinned Soup" });

    expect(await getFoodbankIdsByCategory(session, "Pasta")).toEqual([1]);
  });

  // `is_closed = 0` lives in the JOIN's ON clause, mirroring
  // find_locations_by_category's own `is_closed=False` on the same
  // queryset. Moving it to the WHERE clause would be equivalent here (an
  // inner join), but dropping it entirely would put shut food banks on the
  // "who needs pasta near me" map.
  it("excludes closed food banks", async () => {
    seedFoodbank({ id: 4, name: "Closed Foodbank", slug: "closed", latest_need_id: 505, is_closed: 1 });
    seedNeed({ id: 505, foodbank_id: 4, created: at(5) });
    seedLine({ id: 6, need_id: 505, foodbank_id: 4, item: "Spaghetti", category: "Pasta" });

    expect(await getFoodbankIdsByCategory(session, "Pasta")).toEqual([1]);
  });

  // `type = 'need'` is Django's own filter (geo.py:325). The other type is
  // 'excess' -- items the food bank has TOO MANY of. Dropping this predicate
  // inverts the meaning of the page for those rows: it would direct donors
  // to bring exactly what a food bank has asked people to stop bringing.
  it("ignores 'excess' lines, which mean the opposite of a need", async () => {
    seedFoodbank({ id: 5, name: "Amesbury Foodbank", slug: "amesbury", latest_need_id: 506 });
    seedNeed({ id: 506, foodbank_id: 5, created: at(5) });
    seedLine({ id: 7, need_id: 506, foodbank_id: 5, item: "Beans", category: "Pasta", type: "excess" });

    expect(await getFoodbankIdsByCategory(session, "Pasta")).toEqual([1]);
  });

  // A food bank that has never had a need has latest_need_id NULL, and
  // `foodbank.latest_need_id = foodbankchangeline.need_id` is never true for
  // NULL under SQL's three-valued logic -- which reproduces Django's
  // explicit `latest_need__isnull=False` (geo.py:341) for free. This is the
  // `id IS NOT ?` vs `id != ?` family that has bitten this repo before, so
  // it is executed rather than reasoned about: the row simply is not there.
  it("excludes a food bank with no latest_need at all", async () => {
    seedFoodbank({ id: 6, name: "New Foodbank", slug: "new", latest_need_id: null });
    // Line rows exist for it, and still must not match -- an accidental
    // cross join, or a join moved onto foodbank_id, would return id 6.
    seedNeed({ id: 507, foodbank_id: 6, created: at(5) });
    seedLine({ id: 8, need_id: 507, foodbank_id: 6, item: "Macaroni", category: "Pasta" });

    expect(await getFoodbankIdsByCategory(session, "Pasta")).toEqual([1]);
  });

  // DISTINCT is doing real work: a 13-item need routinely has several lines
  // in one category (Pasta covers penne, fusilli, spaghetti...). Without it
  // findLocationsByCategory's `new Set(...)` would still dedupe, so the bug
  // would be invisible there -- but the row count crossing the wire, which
  // is what D1 bills, would multiply.
  it("returns one id per food bank however many lines share the category", async () => {
    seedLine({ id: 9, need_id: 501, foodbank_id: 1, item: "Spaghetti", category: "Pasta" });
    seedLine({ id: 10, need_id: 501, foodbank_id: 1, item: "Fusilli", category: "Pasta" });

    expect(await getFoodbankIdsByCategory(session, "Pasta")).toEqual([1]);
  });

  // Exact, case-sensitive equality. workers/site's ITEM_CATEGORIES dropdown
  // and packages/db's ITEM_CATEGORY_GROUPS are the two halves that have to
  // agree on the exact string; itemCategories.test.ts asserts that agreement
  // from the other side, and this is what makes a disagreement matter -- an
  // almost-right category is not a near miss, it is a permanently empty
  // results page that reports "nothing near you needs this".
  it("matches the category exactly, not case-insensitively", async () => {
    expect(await getFoodbankIdsByCategory(session, "pasta")).toEqual([]);
    expect(await getFoodbankIdsByCategory(session, "Pas")).toEqual([]);
    expect(await getFoodbankIdsByCategory(session, "Pasta ")).toEqual([]);
  });

  it("returns an empty array for a category nobody needs", async () => {
    expect(await getFoodbankIdsByCategory(session, "Tinned Tomatoes")).toEqual([]);
  });

  // MUTANT: `type = 'need'` -> `type LIKE 'need%'`. It survived, because the
  // only types seeded anywhere in this file were exactly 'need' and 'excess',
  // so a prefix match and an equality match agreed on every row. The category
  // string has an exactness test directly above; the type discriminator --
  // which is what separates "please bring this" from "please stop bringing
  // this" -- did not have one, and it is the half where being wrong inverts
  // the meaning of the page rather than merely emptying it.
  it("matches the type exactly, so a near-miss discriminator does not count as a need", async () => {
    seedFoodbank({ id: 10, name: "Downton Foodbank", slug: "downton", latest_need_id: 510 });
    seedNeed({ id: 510, foodbank_id: 10, created: at(5) });
    seedLine({ id: 13, need_id: 510, foodbank_id: 10, item: "Linguine", category: "Pasta", type: "needs" });

    expect(await getFoodbankIdsByCategory(session, "Pasta")).toEqual([1]);
  });

  // THE PROPERTY findLocationsByCategory IS BUILT ON. PLAN.md §4.8.5 flags
  // that a mechanical port of Django's `foodbank_id__in=[...]` hits D1's
  // 100-bound-parameter cap for any common category and sketches an R2
  // precompute to escape it; this query escapes it instead by returning the
  // ids as a RESULT SET rather than binding them. So the parameter count
  // must stay at one no matter how many food banks match -- 120 here, well
  // past the cap, is the assertion that the escape actually holds.
  //
  // ('need' is a SQL literal in the statement, not a bound parameter, so it
  // is one param and not the two the module's comment claims.)
  it("binds one parameter for 120 matching food banks, the same as for one", async () => {
    for (let n = 100; n < 220; n++) {
      seedFoodbank({ id: n, name: `Foodbank ${n}`, slug: `foodbank-${n}`, latest_need_id: 1000 + n });
      seedNeed({ id: 1000 + n, foodbank_id: n, created: at(5) });
      seedLine({ id: 1000 + n, need_id: 1000 + n, foodbank_id: n, item: "Penne", category: "Pasta" });
    }

    const matched = await getFoodbankIdsByCategory(session, "Pasta");

    expect(matched).toHaveLength(121);
    expect(executed).toHaveLength(1);
    expect(executed[0]!.params).toEqual(["Pasta"]);
  });

  // SUSPECT -- PINNED AS-IS, NOT FIXED. The SELECT list is
  // `foodbankchangeline.foodbank_id`, but the row was CHOSEN by joining
  // `foodbank.latest_need_id`; Django's equivalent returns the FOODBANK's id
  // (`Foodbank.objects...values_list('id', flat=True)`, geo.py:347-356). The
  // two disagree whenever a line's cached foodbank_id has drifted from its
  // need's, which needAdmin.ts:291 makes reachable: reassigning a need to a
  // different food bank updates foodbankchange.foodbank_id and leaves every
  // foodbankchangeline.foodbank_id behind at the old value. Nothing
  // repairs them.
  //
  // The consequence is silent and wrong-in-both-directions:
  // findLocationsByCategory tests these ids against FOOD BANK ids
  // (`categoryIds.has(coord.id)`), so the reassigned food bank drops off the
  // "by item" map and the food bank that no longer has that need appears on
  // it. Selecting `foodbank.id` would be a one-word fix; this test asserts
  // the CURRENT behaviour so the suite stays honest, and would fail loudly
  // the moment someone makes that change -- at which point the fix is to
  // update this test, deliberately.
  it("returns the LINE's foodbank_id, not the joined food bank's, when the two disagree", async () => {
    seedFoodbank({ id: 7, name: "Tisbury Foodbank", slug: "tisbury", latest_need_id: 508 });
    // Need 508 belongs to food bank 7 now -- but its line still carries the
    // food bank it was scraped under, exactly as a reassignment leaves it.
    seedNeed({ id: 508, foodbank_id: 7, created: at(5) });
    seedLine({ id: 11, need_id: 508, foodbank_id: 8, item: "Rigatoni", category: "Pasta" });

    // 8 -- the stale line value -- not 7, the food bank the join matched.
    // Food bank 8 does not even exist.
    expect(ascending(await getFoodbankIdsByCategory(session, "Pasta"))).toEqual([1, 8]);
  });

  // No ORDER BY in the statement, so the order is whatever the planner
  // happens to produce and asserting it would be asserting an SQLite
  // implementation detail. Every assertion above with more than one result
  // sorts first, and this says out loud that it does so on purpose --
  // findLocationsByCategory only ever builds a Set out of these.
  it("makes no ordering promise, so callers must not rely on one", async () => {
    seedFoodbank({ id: 9, name: "Andover Foodbank", slug: "andover", latest_need_id: 509 });
    seedNeed({ id: 509, foodbank_id: 9, created: at(5) });
    seedLine({ id: 12, need_id: 509, foodbank_id: 9, item: "Penne", category: "Pasta" });

    expect(ascending(await getFoodbankIdsByCategory(session, "Pasta"))).toEqual([1, 9]);
    expect(executed[0]!.sql).not.toContain("ORDER BY");
  });
});
