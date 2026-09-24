import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "./schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteNeedByUuid,
  deleteNeedsByUuids,
  getAllNeedsForCsv,
  getCrawlSetForNeed,
  getDiscrepancyById,
  getNeedSubscriberCounts,
  getOpenDiscrepancies,
  getPrevNonpertinentNeed,
  getPrevPublishedNeed,
  getPublishedNeedsForAdmin,
  getTranslationCountForNeed,
  getUnpublishedNeeds,
  recomputeFoodbankNeedFields,
  setDiscrepancyStatus,
  setNeedCategorised,
  setNeedNonpertinent,
  setNeedNotified,
  setNeedPublished,
  updateNeedRawFields,
} from "./needAdmin";
import type { Session } from "./types";

// WP 6.4's admin need-review queue -- gfadmin/views.py:46-53 index(),
// :1774-1810 need(), :1929-1976 the publish/reject/delete transitions,
// :423-428 needs_deleteall, :431-442 needs_csv, :2206-2217
// discrepancy_action.
//
// WHY A REAL DATABASE, NOT A MOCK. Every function in this module is one SQL
// statement and nothing else, so a mock that hands back canned rows is
// asserting against a second implementation of the thing under test. The
// failures this module can have are all SILENT: a dropped `nonpertinent = 0`
// makes the reviewer's queue quietly grow by every rejected need; an
// INNER JOIN where the view has a LEFT one makes unassigned needs vanish
// from the queue with no error anywhere; an ORDER BY flipped to ASC puts
// 2019 at the top of a page nobody scrolls. None of those raise. Two have
// already happened in this repo -- migration 0019's column drops broke four
// queries with no log line until /dashboard/beautybanks/ was measured and
// found to be a live 500, and ticket #9's ISO timestamps silently dropped 31
// of 46 rows from a threshold comparison. So these tests run the module's
// real statements against real SQLite and assert the ROWS that come back.
//
// MUTATION-TESTED (TESTING.md's convention: the evidence that a test is
// load-bearing rather than decoration). The module was copied into a
// throwaway directory, broken 131 ways one at a time, and this file re-run
// against each. Among them: every filter deleted one at a time
// (`nonpertinent = 0`, `published = 0`, `confirmed = 1`, `status = 'New'`,
// `foodbank_id = ?`, `AND foodbank_id IS NOT NULL`); ASC/DESC flipped on each
// of the seven ordered queries, and each of them re-pointed at `modified` and
// at `id`; `created < ?` widened to `<=`; `= ?` widened to `>= ?` on every id
// and need_id lookup and on every single-row UPDATE; every `WHERE` clause on
// an UPDATE deleted outright; `foodbankchange_full` reverted to
// `foodbankchange` at all six read sites (the 0019 failure, reproduced);
// pyNow() reverted to toISOString(); the crawl-set join made LEFT and each of
// its four selected columns read off the item instead of the set; the
// Promise.all destructurings permuted in both functions that have one;
// DELETE_CHUNK set to 89, 100 and 100000; the bulk delete's recompute moved
// before the deletes, into the chunk loop, and removed; both Set dedupes
// replaced by arrays; the orphan-publish guard removed and widened; and
// Django's double `.save()` reinstated.
//
// 128 of the 131 fail this file. THE THREE THAT DO NOT are equivalent
// mutants, executed and recorded rather than quietly omitted: calling pyNow()
// twice instead of once in setNeedNotified (both calls land in the same
// millisecond -- see that test), deleting deleteNeedsByUuids' `length === 0`
// early return (the chunk loop is already empty -- see that test), and
// reversing the bind order of a `need_id IN (...)` list (set membership does
// not care).
//
// TWELVE MUTANTS SURVIVED AN EARLIER PASS and each is now named at the test
// that kills it. They are worth reading as a group, because they share one
// shape: every one of them was invisible because two things in the FIXTURE
// were accidentally equal that are not equal in production -- `modified` to
// `created`, a food bank's id to a need's id, a crawl item's timings to its
// set's, the email subscriber count to the WhatsApp one -- or because a
// fixture held exactly one row where the statement's WHERE was the only thing
// stopping it hitting all of them.
//
// THE FIXTURE IS THE MIGRATION FILES THEMSELVES, applied in order, rather
// than a CREATE TABLE transcribed into this file -- copied from
// adminDashboardStats.test.ts, which explains the reasoning at length. It
// matters more here than almost anywhere: migration 0019 dropped
// `foodbankchange.foodbank_name` and `foodbankdiscrepancy.foodbank_name`
// and replaced them with the joined `_full` views this module reads. A
// hand-written schema in this file could still carry those columns, every
// test would pass, and production would 500.

type Bindable = null | number | bigint | string | Uint8Array;

interface Executed {
  sql: string;
  params: Bindable[];
}

// Every statement the module actually sent, in order. Needed because three
// of the behaviours below are about HOW MANY statements run, not what they
// return: deleteNeedsByUuids' 90-id chunking (D1 caps a statement at 100
// bound parameters), its dedupe of recomputeFoodbankNeedFields across
// chunks, and the early return that stops an empty id list becoming the
// syntax error `IN ()`.
let executed: Executed[] = [];

// The D1 Sessions API surface this package is handed, backed by node:sqlite.
// Copied from adminDashboardStats.test.ts / foodbankLocation.test.ts so every
// tier drives the real code through one adapter rather than three.
// Deliberately dumb: it forwards the SQL untouched, so the engine -- not
// JavaScript -- decides which rows come back.
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
  seedSeq = 0;
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

// -------------------------------------------------------------------------
// Seeds
// -------------------------------------------------------------------------

// A 32-char dashless hex id, the shape 0001_core.sql:111 documents and the
// shape every admin URL carries. Not a plain "need-1": need_id is compared
// as TEXT with no normalisation in this module (unlike needs.ts's
// getNeedByUuid, which calls normalizeUuid first), so the tests should be
// binding something that looks like what production binds.
const uuid = (n: number): string => n.toString(16).padStart(32, "0");

// A need_id that sorts BELOW every id these fixtures seed -- 32 zeroes, one
// less than uuid(1). The obvious "unknown id" probe, uuid(999), sorts ABOVE
// them all and is therefore unmatched by `need_id = ?` and `need_id >= ?`
// alike, so on its own it says nothing about which comparison the SQL uses.
// This one does, and it is the same hole getDiscrepancyById's own "id in a
// gap" test was already written to close -- the writer found it for the
// numeric lookup and not for the six UUID ones.
//
// MUTANTS KILLED (`need_id = ?` widened to `need_id >= ?`): on
// setNeedNonpertinent's and deleteNeedByUuid's and updateNeedRawFields'
// existence checks, where it turns a 404 into a silent "success" that wrote
// nothing; and on setNeedNotified's UPDATE, where it stamps every need in the
// table at or after the one asked for.
const UUID_BELOW_ALL = uuid(0);

// Every seeded need gets a `modified` EARLIER than the one before it, so the
// column's order is the exact reverse of insertion order and can never
// accidentally agree with `created`'s. It used to default to `created`, which
// made the two columns interchangeable to the engine -- and they are anything
// but. `modified` is restamped by six of the writes in this module (publish,
// reject, categorise, notify, edit, discrepancy action), so a query ordered on
// it reshuffles itself every time a reviewer touches anything, while `created`
// -- what Django's `order_by("-created")` actually means -- never moves.
//
// MUTANTS KILLED: `ORDER BY modified DESC` in place of `ORDER BY created
// DESC`, in all five ordered statements that have both columns to choose
// from -- getUnpublishedNeeds, getPublishedNeedsForAdmin, getAllNeedsForCsv,
// getPrevPublishedNeed/getPrevNonpertinentNeed and
// recomputeFoodbankNeedFields. Every one of them survived the whole file
// while modified == created.
let seedSeq = 0;
function descendingModified(): string {
  const secondsIntoDay = 86_399 - seedSeq++;
  const hh = String(Math.floor(secondsIntoDay / 3600)).padStart(2, "0");
  const mm = String(Math.floor((secondsIntoDay % 3600) / 60)).padStart(2, "0");
  const ss = String(secondsIntoDay % 60).padStart(2, "0");
  return `2030-01-01 ${hh}:${mm}:${ss}.000000`;
}

// Django's `str(datetime)` -- `YYYY-MM-DD HH:MM:SS.ffffff`, which is what
// pyNow() writes and what migration 0022 rewrote every stored value into.
// Used everywhere below rather than toISOString(), because these columns are
// TEXT and SQLite compares TEXT lexicographically: mixing the two formats is
// the whole subject of ticket #9 and is pinned deliberately in its own test.
const at = (day: number, hour = 9): string => `2026-09-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:00:00.000000`;

interface FoodbankSeed {
  id: number;
  name?: string;
  slug?: string;
  last_need?: string | null;
  latest_need_id?: number | null;
}

// Fills in the seventeen NOT NULL columns nothing in this module reads. The
// two that matter -- last_need and latest_need_id, the pair
// recomputeFoodbankNeedFields writes -- are always explicit at the call site
// when a test is about them.
function seedFoodbank(db: DatabaseSync, fb: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank (
       id, uuid, name, slug, address, postcode, country, lat_lng,
       charity_just_foodbank, contact_email, url, shopping_list_url,
       address_is_administrative, is_closed, no_locations, days_between_needs,
       created, modified, last_need, latest_need_id
     ) VALUES (?, ?, ?, ?, 'Address', 'SP2 9DY', 'England', '51.06,-1.79',
       0, 'info@example.org', 'https://example.org/', 'https://example.org/list/',
       0, 0, 0, 7,
       '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000', ?, ?)`,
  ).run(
    fb.id,
    `uuid-${fb.id}`,
    fb.name ?? `Foodbank ${fb.id}`,
    fb.slug ?? `foodbank-${fb.id}`,
    fb.last_need === undefined ? null : fb.last_need,
    fb.latest_need_id === undefined ? null : fb.latest_need_id,
  );
}

interface NeedSeed {
  id: number;
  foodbank_id?: number | null;
  created: string;
  modified?: string;
  published?: number;
  // Explicitly nullable: `nonpertinent` is NOT NULL-free (0001_core.sql:118
  // spells out "NULLABLE: NULL is NOT 0"), and the queue's exclusion of those
  // legacy rows is a documented parity behaviour tested below.
  nonpertinent?: number | null;
  is_categorised?: number | null;
  change_text?: string;
  excess_change_text?: string | null;
  input_method?: string;
  notified?: string | null;
  uri?: string | null;
}

function seedNeed(db: DatabaseSync, need: NeedSeed): void {
  db.prepare(
    `INSERT INTO foodbankchange (
       id, need_id, foodbank_id, distill_id, name, uri,
       change_text, change_text_original, excess_change_text, excess_change_text_original,
       published, nonpertinent, is_categorised, notified, input_method, created, modified
     ) VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    need.id,
    uuid(need.id),
    need.foodbank_id === undefined ? 1 : need.foodbank_id,
    need.uri ?? null,
    need.change_text ?? "Beans, Pasta, Nappies",
    need.excess_change_text === undefined ? null : need.excess_change_text,
    need.published ?? 0,
    need.nonpertinent === undefined ? 0 : need.nonpertinent,
    need.is_categorised === undefined ? 0 : need.is_categorised,
    need.notified === undefined ? null : need.notified,
    need.input_method ?? "scrape",
    need.created,
    need.modified ?? descendingModified(),
  );
}

interface DiscrepancySeed {
  id: number;
  foodbank_id?: number | null;
  need_id?: number | null;
  status?: string;
  created: string;
  modified?: string;
  discrepancy_type?: string;
  discrepancy_text?: string;
  url?: string | null;
}

function seedDiscrepancy(db: DatabaseSync, d: DiscrepancySeed): void {
  db.prepare(
    `INSERT INTO foodbankdiscrepancy (id, foodbank_id, need_id, url, discrepancy_type, discrepancy_text, status, created, modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    d.id,
    d.foodbank_id === undefined ? 1 : d.foodbank_id,
    d.need_id === undefined ? null : d.need_id,
    d.url === undefined ? "https://example.org/needs/" : d.url,
    d.discrepancy_type ?? "phone",
    d.discrepancy_text ?? "Phone number on the site does not match",
    d.status ?? "New",
    d.created,
    d.modified ?? d.created,
  );
}

// Read the stored row back with the engine, never through the module under
// test -- a write test that verified itself with the module's own read path
// would pass for any pair of statements that agreed with each other.
function storedNeed(id: number): Record<string, unknown> {
  const row = db.prepare("SELECT * FROM foodbankchange WHERE id = ?").get(id);
  if (!row) throw new Error(`no foodbankchange row with id ${id}`);
  return { ...(row as Record<string, unknown>) };
}

function storedFoodbank(id: number): Record<string, unknown> {
  const row = db.prepare("SELECT * FROM foodbank WHERE id = ?").get(id);
  if (!row) throw new Error(`no foodbank row with id ${id}`);
  return { ...(row as Record<string, unknown>) };
}

const needIds = (rows: { need_id: string }[]): string[] => rows.map((row) => row.need_id);
const ids = (rows: { id: number }[]): number[] => rows.map((row) => row.id);

// Django's `str(datetime)`, and specifically NOT `new Date().toISOString()`.
// Asserted as a shape wherever a test does not freeze the clock, because a
// revert to toISOString() reintroduces ticket #9 -- and ticket #9's symptom
// is not an exception, it is `ORDER BY created DESC LIMIT 1` returning the
// wrong row for the rest of that day.
const PY_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;

const countStatements = (pattern: RegExp): number => executed.filter((e) => pattern.test(e.sql)).length;

// foodbank.modified as seedFoodbank stores it, and as a frozen pyNow() writes
// it. The site-wide "Last updated" footer is MAX(foodbank.modified) (frag.ts),
// so which need writes move it off the seeded value is user-visible.
const SEEDED_MODIFIED = "2020-01-01 00:00:00.000000";
const FROZEN_INSTANT = "2026-09-06T11:22:33.444Z";
const FROZEN_PY = "2026-09-06 11:22:33.444000";

// =========================================================================
// getUnpublishedNeeds -- gfadmin/views.py:46-53's real review queue
// =========================================================================

describe("getUnpublishedNeeds", () => {
  beforeEach(() => {
    seedFoodbank(db, { id: 1, name: "Salisbury", slug: "salisbury" });
    seedFoodbank(db, { id: 2, name: "Brixton", slug: "brixton" });
    // Queue members, deliberately inserted in an order that is neither the
    // answer nor its reverse, so a missing ORDER BY cannot pass by luck.
    seedNeed(db, { id: 1, foodbank_id: 1, created: at(1) });
    seedNeed(db, { id: 2, foodbank_id: 1, created: at(3) });
    seedNeed(db, { id: 3, foodbank_id: 2, created: at(2) });
    // Must be excluded: already reviewed.
    seedNeed(db, { id: 4, foodbank_id: 1, created: at(4), published: 1 });
    // Must be excluded: rejected.
    seedNeed(db, { id: 5, foodbank_id: 1, created: at(5), nonpertinent: 1 });
    // Must be excluded, and this one is the interesting one -- see below.
    seedNeed(db, { id: 6, foodbank_id: 1, created: at(6), nonpertinent: null });
    // Must be INCLUDED: a need the crawler could not attach to a food bank.
    seedNeed(db, { id: 7, foodbank_id: null, created: at(7) });
  });

  // The filter tested by what it EXCLUDES, not only by what it returns. A
  // `WHERE published = 0 AND nonpertinent = 0` that lost either predicate
  // still passes any test that seeds only matching rows -- the reviewer would
  // simply find published and rejected needs back in a queue they had already
  // cleared, with nothing raising.
  it("returns exactly the unreviewed, unrejected needs, newest first", async () => {
    const rows = await getUnpublishedNeeds(session);
    expect(needIds(rows)).toEqual([uuid(7), uuid(2), uuid(3), uuid(1)]);
  });

  // INTENTIONAL PARITY, NOT A BUG, and the module's header comment says so at
  // length: Django's `filter(nonpertinent=False)` compiles to `nonpertinent =
  // false`, which under three-valued logic excludes NULL, and this port's
  // `nonpertinent = 0` excludes it for the same reason. A never-triaged
  // legacy row therefore stays out of the queue in BOTH systems. Pinned so
  // that a future "fix" to `(nonpertinent = 0 OR nonpertinent IS NULL)` is a
  // deliberate divergence someone chose, not a tidy-up that silently changes
  // what a reviewer sees.
  it("keeps a legacy need with nonpertinent IS NULL out of the queue, exactly as Django does", async () => {
    const rows = await getUnpublishedNeeds(session);
    expect(needIds(rows)).not.toContain(uuid(6));
    // The row really is there and really is NULL -- otherwise this test would
    // pass against a fixture that never inserted it.
    expect(storedNeed(6).nonpertinent).toBeNull();
  });

  // foodbankchange_full is a LEFT JOIN (0019_drop_foodbank_cache.sql:86-89,
  // whose comment gives this exact reason: foodbankchange.foodbank_id is
  // nullable and an inner join would silently drop those rows). An unassigned
  // need is precisely the kind a reviewer must see -- it cannot be published
  // until someone attaches a food bank to it -- so an INNER-vs-LEFT swap
  // would hide the only needs that need a human.
  it("keeps an unassigned need in the queue, with null name and slug", async () => {
    const rows = await getUnpublishedNeeds(session);
    const orphan = rows.find((row) => row.need_id === uuid(7));
    expect(orphan?.foodbank_id).toBeNull();
    expect(orphan?.foodbank_name).toBeNull();
    expect(orphan?.foodbank_slug).toBeNull();
  });

  // Migration 0019's whole point, and this package's own scar. foodbank_name
  // used to be a copy stored on foodbankchange and refreshed only by the
  // child's own save, so a rename left the queue showing the old name for
  // ever. Reading it through the view means the rename is visible with no
  // cascade at all -- and a query that went back to `SELECT * FROM
  // foodbankchange` would still return rows, just without these two columns,
  // which is how 0019 broke four queries without one log line.
  it("reads the food bank's CURRENT name and slug through the view, not a stored copy", async () => {
    db.prepare("UPDATE foodbank SET name = ?, slug = ? WHERE id = 1").run("Salisbury Foodbank", "salisbury-foodbank");
    const rows = await getUnpublishedNeeds(session);
    const row = rows.find((r) => r.need_id === uuid(1));
    expect(row?.foodbank_name).toBe("Salisbury Foodbank");
    expect(row?.foodbank_slug).toBe("salisbury-foodbank");
  });

  // The AdminNeedRow interface and the real schema, checked against each
  // other rather than assumed to agree. This is the assertion that fails the
  // day someone adds a column to foodbankchange, or the day another migration
  // drops one -- which is the failure 0019 actually produced.
  it("returns exactly the columns AdminNeedRow declares", async () => {
    const rows = await getUnpublishedNeeds(session);
    expect(Object.keys(rows[0]!).sort()).toEqual(
      [
        "change_text",
        "change_text_original",
        "created",
        "distill_id",
        "excess_change_text",
        "excess_change_text_original",
        "foodbank_id",
        "foodbank_name",
        "foodbank_slug",
        "id",
        "input_method",
        "is_categorised",
        "modified",
        "name",
        "need_id",
        "nonpertinent",
        "notified",
        "published",
        "uri",
      ].sort(),
    );
  });

  // mapNeedRow/coerceBooleans, exercised on real D1-shaped values (INTEGER
  // 0/1/NULL) rather than on hand-written booleans. The tri-state matters:
  // `nonpertinent: null` and `nonpertinent: false` mean different things to
  // every consumer downstream, and coercing NULL to false here would tell the
  // admin a legacy need had been explicitly triaged when it never was.
  it("maps 0/1/NULL to false/true/null, preserving the tri-state", async () => {
    db.prepare("UPDATE foodbankchange SET is_categorised = NULL WHERE id = 1").run();
    const rows = await getUnpublishedNeeds(session);
    const row = rows.find((r) => r.need_id === uuid(1))!;
    expect(row.published).toBe(false);
    expect(row.nonpertinent).toBe(false);
    expect(row.is_categorised).toBeNull();
  });

  // UNBOUNDED, unlike the `/needs/` audit list's 200-row cap (gfadmin/urls/
  // needs.py:6) that the module's header comment is careful to distinguish it
  // from. Reported 2026-09-05 with 116 unreviewed needs on the dashboard; a
  // LIMIT slipped in here would silently hide the oldest of them, and the
  // reviewer would never know the tail existed.
  it("applies no limit -- every unreviewed need is returned", async () => {
    db.exec("DELETE FROM foodbankchange");
    for (let i = 1; i <= 205; i++) seedNeed(db, { id: i, foodbank_id: 1, created: `2026-01-01 00:00:${String(i % 60).padStart(2, "0")}.000000` });
    expect(await getUnpublishedNeeds(session)).toHaveLength(205);
  });
});

// =========================================================================
// getPublishedNeedsForAdmin -- gfadmin/views.py:50's published_needs panel
// =========================================================================

describe("getPublishedNeedsForAdmin", () => {
  beforeEach(() => {
    seedFoodbank(db, { id: 1, name: "Salisbury", slug: "salisbury" });
    seedNeed(db, { id: 1, created: at(1), published: 1 });
    seedNeed(db, { id: 2, created: at(4), published: 1 });
    seedNeed(db, { id: 3, created: at(2), published: 1 });
    seedNeed(db, { id: 4, created: at(3), published: 1 });
    // Newest of all, and must not appear: this panel is the published list.
    seedNeed(db, { id: 5, created: at(9), published: 0 });
  });

  // LIMIT and ORDER BY together. Four published rows and a limit of two means
  // an ASC/DESC flip returns a different pair, not merely a different order --
  // which is the version of this bug that survives a "returns 2 rows" test.
  it("returns the newest published needs first, cut to the limit", async () => {
    expect(needIds(await getPublishedNeedsForAdmin(session, 2))).toEqual([uuid(2), uuid(4)]);
  });

  it("returns every published need when the limit exceeds the row count", async () => {
    expect(needIds(await getPublishedNeedsForAdmin(session, 50))).toEqual([uuid(2), uuid(4), uuid(3), uuid(1)]);
  });

  // Django's published_needs filters on `published=True` ALONE -- there is no
  // nonpertinent predicate on views.py:50, unlike the queue on the line
  // above it. A need that was published and later marked non-pertinent
  // therefore still shows in this panel, in both systems. Pinned because the
  // two queries sit next to each other in the module and "tidying" the second
  // to match the first would be a silent behaviour change.
  it("includes a published need that has also been marked non-pertinent", async () => {
    db.prepare("UPDATE foodbankchange SET nonpertinent = 1 WHERE id = 2").run();
    expect(needIds(await getPublishedNeedsForAdmin(session, 2))).toEqual([uuid(2), uuid(4)]);
  });

  // SQLite hazards on the bound limit, pinned rather than guarded. LIMIT 0
  // returns nothing; LIMIT -1 means NO LIMIT AT ALL in SQLite, so a caller
  // that computed a negative page size would dump every published need on the
  // dashboard instead of erroring. Neither is validated in this function --
  // the route is where a limit is decided -- and knowing that is the point.
  it("returns nothing for a limit of 0, and everything for a negative limit", async () => {
    expect(await getPublishedNeedsForAdmin(session, 0)).toEqual([]);
    expect(await getPublishedNeedsForAdmin(session, -1)).toHaveLength(4);
  });

  // The reason this exists at all rather than reusing needs.ts's
  // getPublishedNeeds: the dashboard links each need's food bank to its admin
  // page, which needs a slug the shared read path does not select.
  it("carries the joined foodbank_slug the admin nav link needs", async () => {
    const rows = await getPublishedNeedsForAdmin(session, 1);
    expect(rows[0]!.foodbank_slug).toBe("salisbury");
  });
});

// =========================================================================
// Discrepancies -- gfadmin/views.py:52 and :2206-2217
// =========================================================================

describe("getOpenDiscrepancies", () => {
  beforeEach(() => {
    seedFoodbank(db, { id: 1, name: "Salisbury", slug: "salisbury" });
    // `modified` is seeded in the OPPOSITE order to `created`, because the two
    // columns are interchangeable to the SQL and must not be interchangeable
    // to this fixture. MUTANT KILLED: `ORDER BY modified DESC`, which survived
    // every assertion here while the seeds left modified == created. It is not
    // a hypothetical edit -- foodbankdiscrepancy has both columns, this panel
    // is the "newest unactioned first" list, and setDiscrepancyStatus below
    // restamps modified on every action. Ordering on modified would therefore
    // shuffle the queue every time a reviewer touched anything, and would look
    // completely normal doing it.
    seedDiscrepancy(db, { id: 1, created: at(1), modified: at(20) });
    seedDiscrepancy(db, { id: 2, created: at(4), modified: at(11) });
    seedDiscrepancy(db, { id: 3, created: at(2), modified: at(12) });
    // Already actioned -- both terminal statuses, both of which
    // setDiscrepancyStatus below can write.
    seedDiscrepancy(db, { id: 4, created: at(9), status: "Done" });
    seedDiscrepancy(db, { id: 5, created: at(8), status: "Invalid" });
    // SQLite's `=` on TEXT is case-sensitive by default, so a row whose
    // status was written in the wrong case is invisible to this panel and
    // sits in the table for ever. Seeded so the behaviour is recorded rather
    // than discovered.
    seedDiscrepancy(db, { id: 6, created: at(7), status: "new" });
  });

  it("returns only status 'New', newest first, cut to the limit", async () => {
    expect(ids(await getOpenDiscrepancies(session, 2))).toEqual([2, 3]);
  });

  it("excludes Done, Invalid, and a lowercase 'new' -- the match is case-sensitive", async () => {
    expect(ids(await getOpenDiscrepancies(session, 20))).toEqual([2, 3, 1]);
  });

  // 0019 dropped foodbankdiscrepancy.foodbank_name (line 58) even though
  // 0008_needcheck.sql:60 had created it as a denormalised copy. The name
  // now comes from the join, and the slug -- which was never denormalised at
  // all -- is what the dashboard's link to the admin food bank page is built
  // from.
  it("joins the live name and slug rather than reading a stored copy", async () => {
    db.prepare("UPDATE foodbank SET name = ?, slug = ? WHERE id = 1").run("Salisbury Foodbank", "salisbury-foodbank");
    const [row] = await getOpenDiscrepancies(session, 1);
    expect(row?.foodbank_name).toBe("Salisbury Foodbank");
    expect(row?.foodbank_slug).toBe("salisbury-foodbank");
  });

  // foodbankdiscrepancy.foodbank_id is nullable (0008_needcheck.sql:59) and
  // foodbankdiscrepancy_full is a LEFT JOIN, so a discrepancy raised against
  // nothing in particular still reaches the dashboard.
  it("keeps a discrepancy with no food bank", async () => {
    seedDiscrepancy(db, { id: 7, foodbank_id: null, created: at(10) });
    const [row] = await getOpenDiscrepancies(session, 1);
    expect(row?.id).toBe(7);
    expect(row?.foodbank_name).toBeNull();
  });

  // DiscrepancyRow versus the real schema, same reasoning as the AdminNeedRow
  // check above: the interface is a claim about the database, and this is the
  // only thing that checks it.
  it("returns exactly the columns DiscrepancyRow declares", async () => {
    const [row] = await getOpenDiscrepancies(session, 1);
    expect(Object.keys(row!).sort()).toEqual(
      ["created", "discrepancy_text", "discrepancy_type", "foodbank_id", "foodbank_name", "foodbank_slug", "id", "modified", "need_id", "status", "url"].sort(),
    );
  });
});

describe("getDiscrepancyById", () => {
  beforeEach(() => {
    seedFoodbank(db, { id: 1, name: "Salisbury", slug: "salisbury" });
    seedDiscrepancy(db, { id: 1, created: at(1), status: "New", discrepancy_text: "Phone number is wrong" });
    seedDiscrepancy(db, { id: 2, created: at(2), status: "Done" });
    // A gap in the id sequence, which is what production looks like once
    // anything has ever been deleted -- and the only shape that can tell
    // `id = ?` apart from a comparison that would happily return a
    // NEIGHBOURING row. See the "unknown id" case below.
    seedDiscrepancy(db, { id: 5, created: at(3), status: "New" });
  });

  // No status filter here, unlike the dashboard panel -- the detail page has
  // to open an already-actioned discrepancy, or the "Done" link on the
  // dashboard would 404 the moment it was used.
  it("finds a discrepancy whatever its status", async () => {
    expect((await getDiscrepancyById(session, 2))?.status).toBe("Done");
  });

  it("returns the joined row for an existing id", async () => {
    const row = await getDiscrepancyById(session, 1);
    expect(row?.discrepancy_text).toBe("Phone number is wrong");
    expect(row?.foodbank_slug).toBe("salisbury");
  });

  // MUTATION-TESTED, and this is the case that closed the hole: an id ABOVE
  // every row (999) is null under `id = ?` and under `id >= ?` alike, so on
  // its own it proves nothing about the comparison. An id in a GAP does --
  // `id >= 3` would hand the route discrepancy 5 while the URL said 3, and
  // the page would render someone else's discrepancy with no error anywhere.
  it("returns null rather than a neighbouring row for an id nothing matches", async () => {
    expect(await getDiscrepancyById(session, 3)).toBeNull();
    expect(await getDiscrepancyById(session, 999)).toBeNull();
  });
});

describe("setDiscrepancyStatus", () => {
  beforeEach(() => {
    seedFoodbank(db, { id: 1 });
    seedDiscrepancy(db, { id: 1, created: at(1), modified: at(1) });
    seedDiscrepancy(db, { id: 2, created: at(2), modified: at(2) });
  });

  const stored = (id: number): Record<string, unknown> => ({ ...(db.prepare("SELECT * FROM foodbankdiscrepancy WHERE id = ?").get(id) as Record<string, unknown>) });

  // The two values gfadmin/views.py:2206-2217 can write, and only the row
  // named. A missing `WHERE id = ?` would resolve every open discrepancy the
  // first time a reviewer dismissed one, with a 302 and no error.
  it("writes the status and a fresh modified to that row alone", async () => {
    freezeClock("2026-09-06T11:22:33.444Z");
    await setDiscrepancyStatus(session, 1, "Done");

    expect(stored(1).status).toBe("Done");
    expect(stored(1).modified).toBe("2026-09-06 11:22:33.444000");
    // created is untouched -- the dashboard orders on it, so restamping it
    // would move an actioned row back to the top of every list it appears in.
    expect(stored(1).created).toBe(at(1));
    expect(stored(2)).toEqual({ ...stored(2), status: "New", modified: at(2) });
  });

  it("writes Invalid for the dismiss action", async () => {
    await setDiscrepancyStatus(session, 2, "Invalid");
    expect(stored(2).status).toBe("Invalid");
  });

  // Django format, not toISOString(). foodbankdiscrepancy.modified is one of
  // the columns migration 0022 had to repair (776 rows), and the write site
  // that made it necessary was exactly this kind of UPDATE.
  it("stamps modified in Django's str(datetime) format, never ISO", async () => {
    await setDiscrepancyStatus(session, 1, "Done");
    expect(stored(1).modified as string).toMatch(PY_DATETIME);
    expect(stored(1).modified as string).not.toContain("T");
  });

  it("is a silent no-op for an unknown id", async () => {
    await expect(setDiscrepancyStatus(session, 999, "Done")).resolves.toBeUndefined();
    expect(stored(1).status).toBe("New");
  });
});

// =========================================================================
// getAllNeedsForCsv -- gfadmin/views.py:431-442 needs_csv()
// =========================================================================

describe("getAllNeedsForCsv", () => {
  beforeEach(() => {
    seedFoodbank(db, { id: 1, name: "Salisbury", slug: "salisbury" });
    seedNeed(db, { id: 1, created: at(1), published: 1 });
    seedNeed(db, { id: 2, created: at(3), published: 0 });
    seedNeed(db, { id: 3, created: at(2), nonpertinent: 1 });
    seedNeed(db, { id: 4, created: at(4), nonpertinent: null });
    seedNeed(db, { id: 5, foodbank_id: null, created: at(5) });
  });

  // `FoodbankChange.objects.all().order_by("-created")` -- ALL of them. The
  // export is the one place a rejected or never-triaged need must still
  // appear, so every filter this module applies elsewhere would be a bug
  // here, and none of them would raise.
  it("returns every need regardless of published, nonpertinent or food bank", async () => {
    expect(needIds(await getAllNeedsForCsv(session))).toEqual([uuid(5), uuid(4), uuid(2), uuid(3), uuid(1)]);
  });

  // The CSV's `foodbank` column is `need.foodbank_name` (views.py:440), which
  // since 0019 is the joined value -- and NULL for an unassigned need rather
  // than a missing column or a crash mid-export.
  it("supplies foodbank_name for the CSV's food bank column, null when unassigned", async () => {
    const rows = await getAllNeedsForCsv(session);
    expect(rows.find((r) => r.need_id === uuid(1))?.foodbank_name).toBe("Salisbury");
    expect(rows.find((r) => r.need_id === uuid(5))?.foodbank_name).toBeNull();
  });

  it("is unbounded -- no LIMIT hiding the tail of the export", async () => {
    db.exec("DELETE FROM foodbankchange");
    for (let i = 1; i <= 205; i++) seedNeed(db, { id: i, created: `2026-01-01 00:00:${String(i % 60).padStart(2, "0")}.000000` });
    expect(await getAllNeedsForCsv(session)).toHaveLength(205);
  });
});

// =========================================================================
// getPrevPublishedNeed / getPrevNonpertinentNeed
// gfadmin/views.py:1774-1791 -- the need page's two diff baselines
// =========================================================================

describe("getPrevPublishedNeed", () => {
  beforeEach(() => {
    seedFoodbank(db, { id: 1, name: "Salisbury", slug: "salisbury" });
    seedFoodbank(db, { id: 2, name: "Brixton", slug: "brixton" });
    seedNeed(db, { id: 1, foodbank_id: 1, created: at(1), published: 1 }); // older published
    seedNeed(db, { id: 2, foodbank_id: 1, created: at(3), published: 1 }); // the answer
    seedNeed(db, { id: 3, foodbank_id: 1, created: at(4), published: 0 }); // unpublished, before
    seedNeed(db, { id: 4, foodbank_id: 1, created: at(6), published: 1 }); // published, but AFTER
    seedNeed(db, { id: 5, foodbank_id: 2, created: at(4), published: 1 }); // other food bank
    seedNeed(db, { id: 6, foodbank_id: 1, created: at(5), published: 1 }); // exactly the boundary
  });

  // `filter(foodbank=..., created__lt=..., published=True).latest("created")`
  // -- three predicates, and a test that seeded only matching rows would pass
  // with any two of them. The one that matters most in practice is
  // foodbank_id: without it the diff on a need page would be against some
  // other food bank's shopping list, which renders perfectly and is nonsense.
  it("returns the newest published need for THIS food bank strictly before the given time", async () => {
    const row = await getPrevPublishedNeed(session, 1, at(5));
    expect(row?.need_id).toBe(uuid(2));
  });

  // `created__lt`, not `lte`. The need being viewed is itself in the table,
  // so a `<=` would diff a need against itself and show a reviewer an empty
  // diff for every single need -- a failure that looks exactly like "nothing
  // changed".
  it("excludes a need at exactly the threshold", async () => {
    const row = await getPrevPublishedNeed(session, 1, at(5));
    expect(row?.need_id).not.toBe(uuid(6));
  });

  it("returns null when the food bank has no earlier published need", async () => {
    expect(await getPrevPublishedNeed(session, 1, at(1))).toBeNull();
    expect(await getPrevPublishedNeed(session, 2, at(3))).toBeNull();
  });

  it("returns a mapped row with real booleans, not raw 0/1", async () => {
    const row = await getPrevPublishedNeed(session, 1, at(5));
    expect(row?.published).toBe(true);
    expect(row?.nonpertinent).toBe(false);
  });

  // TICKET #9, PINNED AS A HAZARD. `created` is TEXT and SQLite compares TEXT
  // byte by byte: 'T' is 0x54 and ' ' is 0x20, so an ISO-format value sorts
  // AFTER every Django-format value from the same day no matter what time it
  // says. Migration 0022 rewrote the 7 stored rows that had this shape and
  // pyNow() stops new ones appearing, but nothing in the schema enforces it --
  // so this records what would happen if a writer regressed: an 08:00 need
  // stored as ISO is not "before" a 20:00 Django threshold, and the diff
  // baseline silently disappears.
  it("compares created lexicographically -- an ISO-format row sorts after a same-day Django threshold", async () => {
    db.exec("DELETE FROM foodbankchange");
    seedNeed(db, { id: 10, foodbank_id: 1, created: "2026-09-05T08:00:00.000Z", published: 1 });
    expect(await getPrevPublishedNeed(session, 1, "2026-09-05 20:00:00.000000")).toBeNull();
    // The same row, stored in the format migration 0022 normalised everything
    // to, is found -- so the difference really is the format, not the times.
    db.prepare("UPDATE foodbankchange SET created = ? WHERE id = 10").run("2026-09-05 08:00:00.000000");
    expect((await getPrevPublishedNeed(session, 1, "2026-09-05 20:00:00.000000"))?.id).toBe(10);
  });
});

describe("getPrevNonpertinentNeed", () => {
  beforeEach(() => {
    seedFoodbank(db, { id: 1, name: "Salisbury", slug: "salisbury" });
    seedFoodbank(db, { id: 2, name: "Brixton", slug: "brixton" });
    seedNeed(db, { id: 1, foodbank_id: 1, created: at(1), nonpertinent: 1 });
    seedNeed(db, { id: 2, foodbank_id: 1, created: at(3), nonpertinent: 1 }); // the answer
    seedNeed(db, { id: 3, foodbank_id: 1, created: at(4), nonpertinent: 0 });
    seedNeed(db, { id: 4, foodbank_id: 1, created: at(6), nonpertinent: 1 }); // after
    seedNeed(db, { id: 5, foodbank_id: 2, created: at(4), nonpertinent: 1 }); // other food bank
    seedNeed(db, { id: 6, foodbank_id: 1, created: at(5), nonpertinent: 1 }); // exactly the boundary
  });

  it("returns the newest rejected need for THIS food bank strictly before the given time", async () => {
    expect((await getPrevNonpertinentNeed(session, 1, at(5)))?.need_id).toBe(uuid(2));
  });

  // MUTANT KILLED: `created <= ?`. The sibling getPrevPublishedNeed had a row
  // seeded at exactly the threshold and this one did not, so widening the
  // comparison here was invisible -- even though it is the same edit, in the
  // same shape of statement, four lines further down the file. The need being
  // viewed is itself in the table and is itself often the non-pertinent one
  // (rejecting is what this baseline is compared against), so a `<=` diffs a
  // need against itself and renders an empty diff that reads as "nothing
  // changed".
  it("excludes a rejected need at exactly the threshold", async () => {
    expect((await getPrevNonpertinentNeed(session, 1, at(5)))?.need_id).not.toBe(uuid(6));
  });

  // The NULL-versus-0 distinction again, on the other side of the comparison.
  // `nonpertinent = 1` cannot match NULL, so a legacy row is never offered as
  // a diff baseline -- consistent with the queue, which will not show it
  // either.
  it("ignores a need whose nonpertinent is NULL", async () => {
    db.exec("DELETE FROM foodbankchange");
    seedNeed(db, { id: 10, foodbank_id: 1, created: at(2), nonpertinent: null });
    expect(await getPrevNonpertinentNeed(session, 1, at(5))).toBeNull();
  });

  it("returns null when there is no earlier rejected need", async () => {
    expect(await getPrevNonpertinentNeed(session, 2, at(3))).toBeNull();
  });
});

// =========================================================================
// getNeedSubscriberCounts -- gfadmin/views.py:1795-1801
// =========================================================================

describe("getNeedSubscriberCounts", () => {
  beforeEach(() => {
    seedFoodbank(db, { id: 1, name: "Salisbury", slug: "salisbury" });
    seedFoodbank(db, { id: 2, name: "Brixton", slug: "brixton" });

    const email = db.prepare("INSERT INTO foodbanksubscriber (id, created, foodbank_id, email, confirmed, sub_key, unsub_key) VALUES (?, ?, ?, ?, ?, ?, ?)");
    email.run(1, at(1), 1, "a@example.org", 1, "sub-1", "unsub-1");
    email.run(2, at(1), 1, "b@example.org", 1, "sub-2", "unsub-2");
    // Confirmed = 0: signed up but never clicked the link. Django's
    // `filter(foodbank=..., confirmed=True)` excludes it, and so must this --
    // counting it would tell a reviewer an email is going somewhere it isn't.
    email.run(3, at(1), 1, "c@example.org", 0, "sub-3", "unsub-3");
    // Another food bank's subscribers, every table, so a dropped
    // `foodbank_id = ?` shows up as an inflated count rather than as nothing.
    email.run(4, at(1), 2, "d@example.org", 1, "sub-4", "unsub-4");

    const push = db.prepare("INSERT INTO webpushsubscription (id, created, foodbank_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, 'p', 'a')");
    push.run(1, at(1), 1, "https://push.example/1");
    push.run(2, at(1), 1, "https://push.example/2");
    push.run(3, at(1), 1, "https://push.example/3");
    push.run(4, at(1), 2, "https://push.example/4");

    const mobile = db.prepare("INSERT INTO mobilesubscriber (id, created, device_id, platform, foodbank_id) VALUES (?, ?, ?, 'ios', ?)");
    mobile.run(1, at(1), "device-1", 1);
    mobile.run(2, at(1), "device-2", 2);

    // FOUR subscribers, not two, purely so no two channels share a count.
    // MUTANT KILLED: swapping `email` and `whatsapp` in the destructuring of
    // Promise.all -- four awaits and four names on one line, which is exactly
    // the shape a careless edit reorders. While email and whatsapp were both
    // 2 the swap produced an identical result object and every assertion here
    // passed. The counts are now 2/3/1/4, so any permutation of the four
    // fails.
    const whatsapp = db.prepare("INSERT INTO whatsappsubscriber (id, phone_number, foodbank_id, created) VALUES (?, ?, ?, ?)");
    whatsapp.run(1, "+447700900001", 1, at(1));
    whatsapp.run(2, "+447700900002", 1, at(1));
    whatsapp.run(3, "+447700900003", 2, at(1));
    whatsapp.run(4, "+447700900004", 1, at(1));
    whatsapp.run(5, "+447700900005", 1, at(1));
  });

  it("counts each channel for one food bank only, and only confirmed email", async () => {
    expect(await getNeedSubscriberCounts(session, 1)).toEqual({ email: 2, webpush: 3, mobile: 1, whatsapp: 4 });
  });

  // The specific regression this function's own comment records: whatsapp was
  // hardcoded to 0 while the table did not exist (migration 0020 created it),
  // and the admin's Notify confirmation showed that 0 to a human about the
  // 51 people who really were subscribed. A real COUNT, from the real table.
  it("counts WhatsApp subscribers for real, rather than the hardcoded 0 it used to return", async () => {
    expect((await getNeedSubscriberCounts(session, 1)).whatsapp).toBe(4);
  });

  // COUNT(*) always returns a row, so the `?? 0` fallbacks are belt and
  // braces -- but the zeroes must come out as numbers, not nulls, because the
  // caller sums them for the confirmation dialog.
  it("returns four zeroes for a food bank nobody has subscribed to", async () => {
    seedFoodbank(db, { id: 3, name: "Wilton", slug: "wilton" });
    expect(await getNeedSubscriberCounts(session, 3)).toEqual({ email: 0, webpush: 0, mobile: 0, whatsapp: 0 });
  });
});

// =========================================================================
// getCrawlSetForNeed / getTranslationCountForNeed -- views.py:1805-1810
// =========================================================================

describe("getCrawlSetForNeed", () => {
  // EVERY NUMBER IN THIS FIXTURE IS DIFFERENT, deliberately: the food bank is
  // 4, the needs are 1 and 2, the crawl item is 1 and the crawl set is 7.
  // MUTANT KILLED: `WHERE ci.foodbank_id = ?`. crawlitem carries both a
  // foodbank_id and a need_id and this function is handed one bare integer, so
  // matching the wrong column is a one-word edit -- and while the food bank
  // was also id 1, it returned the right row for the wrong reason and nothing
  // here noticed. On a real database that mutant returns whichever crawl item
  // touched food bank #<needId> that day, and the need page renders another
  // food bank's crawl timings with no error.
  beforeEach(() => {
    seedFoodbank(db, { id: 4 });
    seedNeed(db, { id: 1, foodbank_id: 4, created: at(1) });
    seedNeed(db, { id: 2, foodbank_id: 4, created: at(2) });
    db.prepare("INSERT INTO crawlset (id, crawl_type, run_id, start, finish) VALUES (?, ?, ?, ?, ?)").run(7, "need", "needcheck-2026-09-01", at(1, 3), at(1, 4));
    // crawl_type, start and finish ALL differ between the item and the set ON
    // PURPOSE. The function selects cs.*; a mutant reading ci.crawl_type,
    // ci.start or ci.finish returns equally plausible values, and this is the
    // only thing that would notice. The times are not padding either: a crawl
    // set spans a whole run and an item is one page inside it, so an item's
    // start is genuinely later than its set's on every real row.
    db.prepare("INSERT INTO crawlitem (id, crawl_set_id, crawl_type, start, finish, foodbank_id, need_id) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      1,
      7,
      "article",
      at(1, 5),
      at(1, 6),
      4,
      1,
    );
  });

  it("returns the crawl SET's id, type and times for the item that produced this need", async () => {
    expect(await getCrawlSetForNeed(session, 1)).toEqual({ crawl_set_id: 7, crawl_type: "need", start: at(1, 3), finish: at(1, 4) });
  });

  it("returns exactly the columns NeedCrawlSetRow declares", async () => {
    expect(Object.keys((await getCrawlSetForNeed(session, 1))!).sort()).toEqual(["crawl_set_id", "crawl_type", "finish", "start"]);
  });

  // crawlitem.need_id is "set only when this run inserted a change"
  // (0008_needcheck.sql:43), so most crawl items have none -- a query that
  // lost this predicate would attach an arbitrary crawl set to every need
  // page.
  it("returns null for a need no crawl item points at", async () => {
    expect(await getCrawlSetForNeed(session, 2)).toBeNull();
  });

  // An INNER JOIN, and crawlitem.crawl_set_id is nullable. This pins that a
  // crawl item with no set produces null rather than a row of nulls -- the
  // page renders a "no crawl information" block, not a broken panel.
  it("returns null when the crawl item has no crawl set", async () => {
    db.prepare("UPDATE crawlitem SET crawl_set_id = NULL WHERE id = 1").run();
    expect(await getCrawlSetForNeed(session, 1)).toBeNull();
  });

  // D1 declares no foreign keys (PLAN.md §4.5), so a crawl_set_id pointing at
  // a row that no longer exists is genuinely reachable -- and the inner join
  // is what makes it harmless.
  it("returns null when the referenced crawl set has been deleted", async () => {
    db.prepare("DELETE FROM crawlset WHERE id = 7").run();
    expect(await getCrawlSetForNeed(session, 1)).toBeNull();
  });

  // `LIMIT 1` with NO ORDER BY. Which of two crawl items wins is unspecified,
  // and asserting a particular one would be pinning an engine implementation
  // detail rather than this code's behaviour. What IS this code's behaviour
  // is that it returns one of them and never errors, so that is what is
  // asserted -- and the fact that the choice is arbitrary is now written
  // down.
  it("returns one of several matching crawl items, unordered", async () => {
    db.prepare("INSERT INTO crawlset (id, crawl_type, run_id, start, finish) VALUES (8, 'need', 'needcheck-2026-09-02', ?, NULL)").run(at(2, 3));
    db.prepare("INSERT INTO crawlitem (id, crawl_set_id, crawl_type, start, finish, foodbank_id, need_id) VALUES (2, 8, 'need', ?, NULL, 4, 1)").run(at(2, 3));
    expect([7, 8]).toContain((await getCrawlSetForNeed(session, 1))?.crawl_set_id);
  });
});

describe("getTranslationCountForNeed", () => {
  beforeEach(() => {
    seedFoodbank(db, { id: 1 });
    seedNeed(db, { id: 1, created: at(1) });
    seedNeed(db, { id: 2, created: at(2) });
    const t = db.prepare("INSERT INTO foodbankchangetranslation (id, need_id, foodbank_id, language, change_text) VALUES (?, ?, 1, ?, 'Ffa, Pasta')");
    t.run(1, 1, "cy");
    t.run(2, 1, "ga");
    t.run(3, 1, "gd");
    t.run(4, 2, "cy");
  });

  // The three languages this app serves (0006_need_translations.sql), counted
  // for one need. `need_id` here is foodbankchange.id -- the numeric FK, not
  // the 32-char UUID -- and passing the wrong one of the two would count 0
  // for every need without raising.
  it("counts only this need's translations", async () => {
    expect(await getTranslationCountForNeed(session, 1)).toBe(3);
    expect(await getTranslationCountForNeed(session, 2)).toBe(1);
  });

  it("returns 0 for a need with no translations", async () => {
    expect(await getTranslationCountForNeed(session, 999)).toBe(0);
  });
});

// =========================================================================
// recomputeFoodbankNeedFields -- models/foodbank.py:694-712's cache-on-save
// =========================================================================

describe("recomputeFoodbankNeedFields", () => {
  beforeEach(() => {
    seedFoodbank(db, { id: 1, name: "Salisbury", slug: "salisbury", last_need: "STALE", latest_need_id: 999 });
    seedFoodbank(db, { id: 2, name: "Brixton", slug: "brixton", last_need: "STALE", latest_need_id: 998 });
  });

  // TWO DIFFERENT QUESTIONS, and the source is careful about it:
  // `last_need` is the newest need of ANY kind (foodbank.py:698's
  // `filter(foodbank=self).latest("created")`), `latest_need` is the newest
  // PUBLISHED one (:707). Seeding a newest-but-unpublished need is what makes
  // a mutant that answers both with the same query fail.
  it("sets last_need from the newest need of any kind and latest_need_id from the newest PUBLISHED one", async () => {
    seedNeed(db, { id: 1, foodbank_id: 1, created: at(1), published: 1 });
    seedNeed(db, { id: 2, foodbank_id: 1, created: at(2), published: 1 });
    seedNeed(db, { id: 3, foodbank_id: 1, created: at(3), published: 0 });

    await recomputeFoodbankNeedFields(session, 1);

    expect(storedFoodbank(1).last_need).toBe(at(3));
    expect(storedFoodbank(1).latest_need_id).toBe(2);
  });

  // The clearing half. foodbank.py:700 and :712 assign None when there is
  // nothing to find, so a food bank whose last need was just deleted must
  // come back to NULL rather than keep the value it had -- otherwise
  // latest_need_id points at a row that no longer exists and every consumer
  // that joins on it silently loses the food bank.
  it("clears both fields to NULL when the food bank has no needs at all", async () => {
    await recomputeFoodbankNeedFields(session, 1);
    expect(storedFoodbank(1).last_need).toBeNull();
    expect(storedFoodbank(1).latest_need_id).toBeNull();
  });

  it("clears latest_need_id but keeps last_need when every need is unpublished", async () => {
    seedNeed(db, { id: 1, foodbank_id: 1, created: at(2), published: 0 });
    await recomputeFoodbankNeedFields(session, 1);
    expect(storedFoodbank(1).last_need).toBe(at(2));
    expect(storedFoodbank(1).latest_need_id).toBeNull();
  });

  // `WHERE foodbank_id = ?` on both reads and the write. Without it on the
  // reads, every food bank would inherit the newest need on the site; without
  // it on the UPDATE, every food bank on the site would be rewritten by one
  // reviewer clicking Publish.
  it("touches only the named food bank, and reads only its own needs", async () => {
    seedNeed(db, { id: 1, foodbank_id: 1, created: at(1), published: 1 });
    seedNeed(db, { id: 2, foodbank_id: 2, created: at(9), published: 1 });

    await recomputeFoodbankNeedFields(session, 1);

    expect(storedFoodbank(1).last_need).toBe(at(1));
    expect(storedFoodbank(1).latest_need_id).toBe(1);
    expect(storedFoodbank(2).last_need).toBe("STALE");
    expect(storedFoodbank(2).latest_need_id).toBe(998);
  });

  // Reads the BASE table, not foodbankchange_full. Functionally identical
  // today, but pinned because the alternative would make the hottest write
  // path in the admin do a join it does not need.
  it("is a silent no-op for a food bank id that does not exist", async () => {
    await expect(recomputeFoodbankNeedFields(session, 404)).resolves.toBeUndefined();
  });

  // TICKET #9, at the exact write site pyDatetime.ts names as one of its two
  // live consequences ("recomputeFoodbankNeedFields picked the wrong latest
  // published need during the 2026-09-05 migration"). With one row stored in
  // ISO form and one in Django form, the byte-wise ORDER BY puts the 08:00
  // ISO row above the 20:00 Django row -- so last_need ends up being the
  // EARLIER of the two. Pinned as the hazard it is; migration 0022 removed
  // the rows that triggered it, nothing prevents new ones.
  it("orders created byte-wise, so a stray ISO-format row wins over a later Django-format one", async () => {
    seedNeed(db, { id: 1, foodbank_id: 1, created: "2026-09-05 20:00:00.000000", published: 1 });
    seedNeed(db, { id: 2, foodbank_id: 1, created: "2026-09-05T08:00:00.000Z", published: 1 });

    await recomputeFoodbankNeedFields(session, 1);

    expect(storedFoodbank(1).last_need).toBe("2026-09-05T08:00:00.000Z");
    expect(storedFoodbank(1).latest_need_id).toBe(2);
  });

  // publicChange. Off by default, so a reject or a delete of a need nobody
  // could see does not claim the site was updated; on, it stamps only the
  // food bank named.
  it("stamps modified only when told the change was public, and only on the named food bank", async () => {
    freezeClock(FROZEN_INSTANT);
    seedNeed(db, { id: 1, foodbank_id: 1, created: at(1), published: 1 });

    await recomputeFoodbankNeedFields(session, 1);
    expect(storedFoodbank(1).modified).toBe(SEEDED_MODIFIED);

    await recomputeFoodbankNeedFields(session, 1, true);
    expect(storedFoodbank(1).modified).toBe(FROZEN_PY);
    expect(storedFoodbank(1).latest_need_id).toBe(1);
    expect(storedFoodbank(2).modified).toBe(SEEDED_MODIFIED);
  });
});

// =========================================================================
// setNeedPublished -- gfadmin/views.py:1966-1976 need_publish
// =========================================================================

// A need this describe never names, present in every test purely to be left
// alone. MUTANT KILLED, in all three of the single-row UPDATE functions below
// (setNeedPublished, setNeedNonpertinent, updateNeedRawFields): dropping
// `WHERE need_id = ?`. Each fixture held exactly one need, so an UPDATE with
// no WHERE at all wrote the right value to the right row and every assertion
// passed. On production that mutant publishes -- or rejects, or overwrites the
// change_text of -- EVERY need in the table on one button press, returns a 302,
// and logs nothing. It is the single worst failure this module can have and it
// was the one thing untested.
//
// foodbank_id is null on this row so it cannot disturb the recompute
// assertions, and it is id 9 so it cannot collide with the ids the individual
// tests seed for themselves.
const BYSTANDER = 9;
function seedBystander(published = 0): void {
  seedNeed(db, { id: BYSTANDER, foodbank_id: null, created: at(2), published, change_text: "Bystander", modified: at(2) });
}
function expectBystanderUntouched(): void {
  const row = storedNeed(BYSTANDER);
  expect(row.modified).toBe(at(2));
  expect(row.change_text).toBe("Bystander");
  expect(row.nonpertinent).toBe(0);
}

describe("setNeedPublished", () => {
  beforeEach(() => {
    seedFoodbank(db, { id: 1, name: "Salisbury", slug: "salisbury" });
    seedNeed(db, { id: 1, foodbank_id: 1, created: at(1), published: 0, modified: at(1) });
    seedBystander();
  });

  it("returns null and writes nothing for a need_id that does not exist", async () => {
    expect(await setNeedPublished(session, uuid(999), true)).toBeNull();
    // ...at either end of the id range. See UUID_BELOW_ALL: an id above every
    // stored one is unmatched by `= ?` and `>= ?` alike and so proves nothing
    // about which of the two the statement uses.
    expect(await setNeedPublished(session, UUID_BELOW_ALL, true)).toBeNull();
    expect(countStatements(/^UPDATE/)).toBe(0);
  });

  // THE NEW GUARD, and the reason it exists: FoodbankChange.clean()
  // (needs.py:77-79) declares a published need with no food bank invalid, but
  // need_publish never calls clean(), so Django's own Publish button will
  // happily create one. This port refuses -- and the refusal has to leave the
  // row alone, or "refused" would still have published it.
  it("refuses to publish a need with no food bank, and leaves the row untouched", async () => {
    seedNeed(db, { id: 2, foodbank_id: null, created: at(2), published: 0, modified: at(2) });

    expect(await setNeedPublished(session, uuid(2), true)).toBe("needs-foodbank");
    expect(storedNeed(2).published).toBe(0);
    expect(storedNeed(2).modified).toBe(at(2));
    expect(countStatements(/^UPDATE/)).toBe(0);
  });

  // The guard is on `publish` only. Unpublishing a food-bank-less need is
  // still allowed, because the invariant is about the published state, not
  // about touching the row -- and refusing here would leave a bad row
  // unfixable through the admin.
  it("still allows UNpublishing a need with no food bank", async () => {
    seedNeed(db, { id: 2, foodbank_id: null, created: at(2), published: 1, modified: at(2) });

    const result = await setNeedPublished(session, uuid(2), false);

    expect(result).not.toBe("needs-foodbank");
    expect(storedNeed(2).published).toBe(0);
    // No food bank means nothing to recompute -- the UPDATE on the need is
    // the only write.
    expect(countStatements(/^UPDATE foodbank /)).toBe(0);
  });

  it("writes published = 1 and a fresh modified, and recomputes the food bank", async () => {
    freezeClock("2026-09-06T11:22:33.444Z");

    const result = await setNeedPublished(session, uuid(1), true);

    expect(storedNeed(1).published).toBe(1);
    expect(storedNeed(1).modified).toBe("2026-09-06 11:22:33.444000");
    expect(storedFoodbank(1).latest_need_id).toBe(1);
    expect(storedFoodbank(1).last_need).toBe(at(1));
    // Every other need in the table is untouched -- see seedBystander above
    // for the mutant this exists to kill.
    expect(storedNeed(BYSTANDER).published).toBe(0);
    expectBystanderUntouched();
    // The returned row carries the NEW state, not the row as it was read --
    // handlePublishTransition redirects on it and the templates render it.
    //
    // toEqual, NOT toMatchObject. MUTANT KILLED: reverting the read from
    // `foodbankchange_full` to `foodbankchange` -- migration 0019's exact
    // failure, and the one place in this module where it produces no missing
    // rows and no error, only a returned FoodbankChangeRow silently missing
    // the foodbank_name the interface promises. toMatchObject cannot see a
    // column that has gone.
    expect(result).toEqual({
      id: 1,
      need_id: uuid(1),
      foodbank_id: 1,
      foodbank_name: "Salisbury",
      foodbank_slug: "salisbury",
      distill_id: null,
      name: null,
      uri: null,
      change_text: "Beans, Pasta, Nappies",
      change_text_original: null,
      excess_change_text: null,
      excess_change_text_original: null,
      published: true,
      nonpertinent: false,
      is_categorised: false,
      notified: null,
      input_method: "scrape",
      created: at(1),
      modified: "2026-09-06 11:22:33.444000",
    });
  });

  // THE DELIBERATE DIVERGENCE FROM DJANGO, stated in the module's comment and
  // worth a test of its own: Django's need_publish only recomputes on
  // publish (`if self.foodbank and self.published`), so unpublishing a food
  // bank's current latest_need leaves latest_need_id pointing at a need that
  // is no longer public. Here it is recomputed on both transitions, so
  // unpublishing the only published need clears it.
  it("recomputes on UNpublish too, clearing a latest_need_id Django would have left stale", async () => {
    db.prepare("UPDATE foodbankchange SET published = 1 WHERE id = 1").run();
    db.prepare("UPDATE foodbank SET latest_need_id = 1, last_need = ? WHERE id = 1").run(at(1));

    await setNeedPublished(session, uuid(1), false);

    expect(storedNeed(1).published).toBe(0);
    expect(storedFoodbank(1).latest_need_id).toBeNull();
    // last_need is "newest need of any kind", so unpublishing does not clear
    // it -- the need still exists.
    expect(storedFoodbank(1).last_need).toBe(at(1));
  });

  // THE "LAST UPDATED" FOOTER. Django's need.save() on publish ran
  // foodbank.save(), whose auto_now bumped modified, and the footer is
  // MAX(foodbank.modified). Before this, a week of publishing needs left the
  // footer reading "6 days ago" -- the last food bank form edit.
  it("stamps the food bank's modified on publish, and on unpublishing a published need", async () => {
    freezeClock(FROZEN_INSTANT);

    await setNeedPublished(session, uuid(1), true);
    expect(storedFoodbank(1).modified).toBe(FROZEN_PY);

    db.prepare("UPDATE foodbank SET modified = ? WHERE id = 1").run(SEEDED_MODIFIED);
    await setNeedPublished(session, uuid(1), false);
    expect(storedFoodbank(1).modified).toBe(FROZEN_PY);
  });

  it("leaves the food bank's modified alone when unpublishing a need that was never published", async () => {
    await setNeedPublished(session, uuid(1), false);
    expect(storedFoodbank(1).modified).toBe(SEEDED_MODIFIED);
  });

  // ONE WRITE, not two. Django calls `.save()` twice back to back and doubles
  // every side effect (38 translate tasks instead of 19, two decache cycles);
  // the port collapses that to a single UPDATE, and this is what stops the
  // double creeping back in.
  it("issues exactly one UPDATE against foodbankchange", async () => {
    await setNeedPublished(session, uuid(1), true);
    expect(countStatements(/^UPDATE foodbankchange /)).toBe(1);
  });

  // No normalizeUuid here, unlike needs.ts's getNeedByUuid, which accepts
  // either form. The admin's own links always carry the dashless id straight
  // out of the database, so this is currently unreachable -- pinned because
  // the two spellings sit in sibling modules and the difference is invisible
  // until a dashed id reaches this one and the publish silently no-ops.
  it("matches need_id byte for byte -- a dashed UUID finds nothing", async () => {
    const dashed = `${uuid(1).slice(0, 8)}-${uuid(1).slice(8, 12)}-${uuid(1).slice(12, 16)}-${uuid(1).slice(16, 20)}-${uuid(1).slice(20)}`;
    expect(await setNeedPublished(session, dashed, true)).toBeNull();
  });
});

// =========================================================================
// setNeedNonpertinent -- gfadmin/views.py:1949-1955, the de-facto reject
// =========================================================================

describe("setNeedNonpertinent", () => {
  beforeEach(() => {
    seedFoodbank(db, { id: 1, name: "Salisbury", slug: "salisbury" });
    seedNeed(db, { id: 1, foodbank_id: 1, created: at(1), published: 0, nonpertinent: 0, modified: at(1) });
    // Published, so it stays out of the queue assertion below -- but still
    // nonpertinent = 0, which is what a missing WHERE would flip.
    seedBystander(1);
  });

  // Both ends of the id range -- see UUID_BELOW_ALL. Under `need_id >= ?` the
  // uuid(999) half still passes, the uuid(0) half finds need 1, and the reject
  // returns a row (and recomputes a food bank) for a need id that does not
  // exist, which the route turns into a 302 instead of a 404.
  it("returns null for an unknown need, whether its id sorts above or below the real ones", async () => {
    expect(await setNeedNonpertinent(session, uuid(999))).toBeNull();
    expect(await setNeedNonpertinent(session, UUID_BELOW_ALL)).toBeNull();
    expect(countStatements(/^UPDATE/)).toBe(0);
  });

  it("sets nonpertinent = 1, stamps modified, and returns the updated row", async () => {
    freezeClock("2026-09-06T11:22:33.444Z");

    const result = await setNeedNonpertinent(session, uuid(1));

    expect(storedNeed(1).nonpertinent).toBe(1);
    expect(storedNeed(1).modified).toBe("2026-09-06 11:22:33.444000");
    // Rejecting one need must not reject every need -- see seedBystander.
    expectBystanderUntouched();
    // toEqual, NOT toMatchObject, for the same reason as setNeedPublished's:
    // MUTANT KILLED, reverting this function's read from `foodbankchange_full`
    // to `foodbankchange`. It is migration 0019's exact failure and it raises
    // nothing here -- the row still exists, the reject still works, and the
    // returned FoodbankChangeRow is simply missing the foodbank_name its own
    // interface promises. Only an exact-shape assertion can see a column that
    // has stopped being there.
    expect(result).toEqual({
      id: 1,
      need_id: uuid(1),
      foodbank_id: 1,
      foodbank_name: "Salisbury",
      foodbank_slug: "salisbury",
      distill_id: null,
      name: null,
      uri: null,
      change_text: "Beans, Pasta, Nappies",
      change_text_original: null,
      excess_change_text: null,
      excess_change_text_original: null,
      published: false,
      nonpertinent: true,
      is_categorised: false,
      notified: null,
      input_method: "scrape",
      created: at(1),
      modified: "2026-09-06 11:22:33.444000",
    });
    // The row leaves the queue -- which is the whole observable point of the
    // reject button.
    expect(needIds(await getUnpublishedNeeds(session))).toEqual([]);
  });

  // Rejecting does NOT unpublish, in this port or in Django (need_nonpertinent
  // sets one attribute and saves). So a published need that is rejected stays
  // published AND stays the food bank's latest_need, because
  // recomputeFoodbankNeedFields only ever looks at `published`. Faithful
  // parity, and surprising enough to be worth writing down.
  it("does not unpublish an already-published need, and leaves it as the food bank's latest_need", async () => {
    db.prepare("UPDATE foodbankchange SET published = 1 WHERE id = 1").run();

    await setNeedNonpertinent(session, uuid(1));

    expect(storedNeed(1).published).toBe(1);
    expect(storedFoodbank(1).latest_need_id).toBe(1);
  });

  it("recomputes the food bank's fields", async () => {
    await setNeedNonpertinent(session, uuid(1));
    expect(countStatements(/^UPDATE foodbank /)).toBe(1);
    expect(storedFoodbank(1).last_need).toBe(at(1));
  });

  // Rejecting is the review queue's commonest action and, on an unpublished
  // need, invisible to the public -- so it must not move "Last updated".
  it("leaves the food bank's modified alone when rejecting an unpublished need", async () => {
    await setNeedNonpertinent(session, uuid(1));
    expect(storedFoodbank(1).modified).toBe(SEEDED_MODIFIED);
  });

  it("stamps the food bank's modified when the rejected need is published", async () => {
    freezeClock(FROZEN_INSTANT);
    db.prepare("UPDATE foodbankchange SET published = 1 WHERE id = 1").run();

    await setNeedNonpertinent(session, uuid(1));

    expect(storedFoodbank(1).modified).toBe(FROZEN_PY);
  });

  it("skips the recompute for a need with no food bank", async () => {
    seedNeed(db, { id: 2, foodbank_id: null, created: at(2) });
    await setNeedNonpertinent(session, uuid(2));
    expect(storedNeed(2).nonpertinent).toBe(1);
    expect(countStatements(/^UPDATE foodbank /)).toBe(0);
  });
});

// =========================================================================
// setNeedCategorised / setNeedNotified -- the two flag stamps
// =========================================================================

describe("setNeedCategorised", () => {
  beforeEach(() => {
    seedFoodbank(db, { id: 1 });
    seedNeed(db, { id: 1, created: at(1), is_categorised: null, modified: at(1) });
    seedNeed(db, { id: 2, created: at(2), is_categorised: null, modified: at(2) });
  });

  it("flags the named need only, and restamps modified", async () => {
    freezeClock("2026-09-06T11:22:33.444Z");
    await setNeedCategorised(session, uuid(1));

    expect(storedNeed(1).is_categorised).toBe(1);
    expect(storedNeed(1).modified).toBe("2026-09-06 11:22:33.444000");
    // change_uncategorised_idx is a partial index on `is_categorised IS NULL`
    // (0001_core.sql:127) -- the backlog query it serves would silently shrink
    // if this UPDATE lost its WHERE.
    expect(storedNeed(2).is_categorised).toBeNull();
    expect(storedNeed(2).modified).toBe(at(2));
  });

  it("is a silent no-op for an unknown need at either end of the id range", async () => {
    await expect(setNeedCategorised(session, uuid(999))).resolves.toBeUndefined();
    await expect(setNeedCategorised(session, UUID_BELOW_ALL)).resolves.toBeUndefined();
    expect(storedNeed(1).is_categorised).toBeNull();
    expect(storedNeed(2).is_categorised).toBeNull();
  });
});

describe("setNeedNotified", () => {
  beforeEach(() => {
    seedFoodbank(db, { id: 1 });
    seedNeed(db, { id: 1, created: at(1), notified: null, modified: at(1) });
    // A SECOND need, with a HIGHER need_id than the one every test here acts
    // on. MUTANT KILLED: `UPDATE ... WHERE need_id >= ?`. With one row in the
    // table both the correct statement and the widened one stamped exactly
    // that row. On production the widened one stamps `notified` on every need
    // created after this one, and `notified` is what the admin reads to answer
    // "have subscribers already been told about this?" -- so the next
    // reviewer is told yes about needs nobody has been notified of.
    seedNeed(db, { id: 2, created: at(2), notified: null, modified: at(2) });
  });

  // ONE pyNow() call bound twice, so `notified` and `modified` are identical
  // -- which is what makes "when was this notified" answerable from either
  // column.
  //
  // HONEST LIMIT, recorded rather than papered over: this does NOT kill a
  // mutant that calls pyNow() twice. Both calls land in the same millisecond
  // (and under this file's frozen clock, always), so the two columns come out
  // equal either way. It is an equivalent mutant in practice, and the
  // assertion below is a statement of intent, not a trap. What it does catch
  // is either column being bound from something else entirely, or from the
  // wrong clock.
  it("writes the same instant into notified and modified", async () => {
    freezeClock("2026-09-06T11:22:33.444Z");
    await setNeedNotified(session, uuid(1));

    expect(storedNeed(1).notified).toBe("2026-09-06 11:22:33.444000");
    expect(storedNeed(1).modified).toBe(storedNeed(1).notified);
    // ...and only that need. See the fixture's second row.
    expect(storedNeed(2).notified).toBeNull();
    expect(storedNeed(2).modified).toBe(at(2));
  });

  // foodbankchange.notified is one of the columns migration 0022 repaired,
  // and this is its only write site.
  it("stamps Django's format, never ISO", async () => {
    await setNeedNotified(session, uuid(1));
    expect(storedNeed(1).notified as string).toMatch(PY_DATETIME);
  });

  it("is a silent no-op for an unknown need at either end of the id range", async () => {
    await expect(setNeedNotified(session, uuid(999))).resolves.toBeUndefined();
    await expect(setNeedNotified(session, UUID_BELOW_ALL)).resolves.toBeUndefined();
    expect(storedNeed(1).notified).toBeNull();
    expect(storedNeed(2).notified).toBeNull();
  });
});

// =========================================================================
// deleteNeedByUuid -- gfadmin/views.py:1929-1935 need_delete
// =========================================================================

describe("deleteNeedByUuid", () => {
  beforeEach(() => {
    seedFoodbank(db, { id: 1, name: "Salisbury", slug: "salisbury" });
    seedNeed(db, { id: 1, foodbank_id: 1, created: at(1), published: 1 });
    seedNeed(db, { id: 2, foodbank_id: 1, created: at(2), published: 1 });
  });

  it("returns false and deletes nothing for an unknown need", async () => {
    expect(await deleteNeedByUuid(session, uuid(999))).toBe(false);
    // The other end of the range, and the half that carries the information.
    // MUTANT KILLED: `SELECT foodbank_id ... WHERE need_id >= ?` on the
    // existence check. uuid(999) is unmatched either way; uuid(0) matches need
    // 1 under `>=`, so the function returns TRUE having deleted nothing, and
    // adminNeedDelete redirects to the dashboard as though it had worked.
    expect(await deleteNeedByUuid(session, UUID_BELOW_ALL)).toBe(false);
    expect(countStatements(/^DELETE/)).toBe(0);
    expect(db.prepare("SELECT id FROM foodbankchange ORDER BY id").all()).toEqual([{ id: 1 }, { id: 2 }]);
  });

  // Deletes the LOWER of the two ids on purpose. MUTANT KILLED: `DELETE FROM
  // foodbankchange WHERE need_id >= ?`. Deleting uuid(2) -- the highest id in
  // the fixture -- left exactly one survivor under both the correct statement
  // and the widened one, so the assertion held while the delete had become
  // "this need and every need created after it". On the review queue's own
  // Delete button that is the whole tail of the table.
  it("deletes only the named need and returns true", async () => {
    expect(await deleteNeedByUuid(session, uuid(1))).toBe(true);
    expect(db.prepare("SELECT id FROM foodbankchange").all()).toEqual([{ id: 2 }]);
  });

  // needs.py:324-328 recomputes REGARDLESS of the deleted need's published
  // state -- the one place the module's comment says Django gets right. After
  // deleting the newest published need, latest_need_id must fall back to the
  // one before it, not be left pointing at a deleted row.
  it("recomputes the food bank so latest_need_id falls back to the surviving need", async () => {
    db.prepare("UPDATE foodbank SET latest_need_id = 2, last_need = ? WHERE id = 1").run(at(2));

    await deleteNeedByUuid(session, uuid(2));

    expect(storedFoodbank(1).latest_need_id).toBe(1);
    expect(storedFoodbank(1).last_need).toBe(at(1));
  });

  it("recomputes even when the deleted need was unpublished", async () => {
    seedNeed(db, { id: 3, foodbank_id: 1, created: at(3), published: 0 });
    db.prepare("UPDATE foodbank SET last_need = ? WHERE id = 1").run(at(3));

    await deleteNeedByUuid(session, uuid(3));

    expect(storedFoodbank(1).last_need).toBe(at(2));
  });

  it("stamps the food bank's modified when the deleted need was published, and not when it was unpublished", async () => {
    freezeClock(FROZEN_INSTANT);
    seedNeed(db, { id: 3, foodbank_id: 1, created: at(3), published: 0 });

    await deleteNeedByUuid(session, uuid(3));
    expect(storedFoodbank(1).modified).toBe(SEEDED_MODIFIED);

    await deleteNeedByUuid(session, uuid(2));
    expect(storedFoodbank(1).modified).toBe(FROZEN_PY);
  });

  it("skips the recompute for a need with no food bank", async () => {
    seedNeed(db, { id: 3, foodbank_id: null, created: at(3) });
    expect(await deleteNeedByUuid(session, uuid(3))).toBe(true);
    expect(countStatements(/^UPDATE foodbank /)).toBe(0);
  });

  // DIVERGENCE FROM DJANGO, pinned as CURRENT behaviour rather than fixed --
  // asserting the wish here would leave the suite red and tell nobody
  // anything. FoodbankChange.delete() (givefood/models/needs.py:319-323)
  // explicitly deletes the need's FoodbankChangeLine and
  // FoodbankChangeTranslation rows before calling super(); this port deletes
  // neither, and D1 has no FK constraints to cascade for it (§4.5), so both
  // survive pointing at a need_id that is gone. needAdmin.ts's own comment
  // asserts the opposite ("Django's model delete() doesn't touch them
  // either"), and the source contradicts it.
  //
  // WHY THIS TEST IS NOT COSMETIC. foodbankchange.id is `INTEGER PRIMARY KEY`
  // with no AUTOINCREMENT (0001_core.sql:110), so SQLite reuses max(rowid)+1
  // -- verified by running it, not by reading the docs. Deleting the newest
  // need (which is exactly what the review queue's Delete all does) frees its
  // id for the next need needcheck.ts inserts, and that new need then inherits
  // the deleted one's orphaned lines and translations, for a different food
  // bank. dashboards.ts:106 and :121 also COUNT foodbankchangeline with no
  // join to a surviving need, so every orphan permanently inflates the public
  // "most needed items" figures.
  it("leaves change lines and translations behind, orphaned against the deleted need", async () => {
    db.prepare("INSERT INTO foodbankchangeline (id, need_id, foodbank_id, item, type, category, group_name, created) VALUES (1, 2, 1, 'Pasta', 'need', 'Food', 'Dry', ?)").run(
      at(2),
    );
    db.prepare("INSERT INTO foodbankchangetranslation (id, need_id, foodbank_id, language, change_text) VALUES (1, 2, 1, 'cy', 'Pasta')").run();

    await deleteNeedByUuid(session, uuid(2));

    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbankchangeline WHERE need_id = 2").get()).toEqual({ n: 1 });
    expect(await getTranslationCountForNeed(session, 2)).toBe(1);
  });
});

// =========================================================================
// updateNeedRawFields -- gfadmin/views.py:1916-1946 need_form / NeedForm
// =========================================================================

describe("updateNeedRawFields", () => {
  beforeEach(() => {
    seedFoodbank(db, { id: 1, name: "Salisbury", slug: "salisbury" });
    seedFoodbank(db, { id: 2, name: "Brixton", slug: "brixton" });
    seedNeed(db, { id: 1, foodbank_id: 1, created: at(1), published: 0, change_text: "Beans", excess_change_text: null, modified: at(1) });
    seedBystander();
  });

  const params = {
    changeText: "Pasta, Nappies",
    excessChangeText: "Baked beans",
    published: true,
    foodbankId: 1 as number | null,
  };

  // Both ends of the id range again -- MUTANT KILLED: `SELECT foodbank_id ...
  // WHERE need_id >= ?`, which under uuid(0) finds need 1, reports the save as
  // a success and recomputes a food bank, while the UPDATE itself matched
  // nothing. The reviewer's edit form would redirect as though it had saved.
  it("returns false and writes nothing for an unknown need", async () => {
    expect(await updateNeedRawFields(session, uuid(999), params)).toBe(false);
    expect(await updateNeedRawFields(session, UUID_BELOW_ALL, params)).toBe(false);
    expect(countStatements(/^UPDATE/)).toBe(0);
  });

  // The four fields NeedForm actually exposes, plus modified. Asserted as a
  // whole row rather than field by field, because the failure this catches is
  // a .bind() drifting out of step with its own SET list -- change_text
  // landing in excess_change_text is two TEXT columns swapping silently, and
  // SQLite will not object.
  it("writes exactly change_text, excess_change_text, published, foodbank_id and modified", async () => {
    freezeClock("2026-09-06T11:22:33.444Z");

    expect(await updateNeedRawFields(session, uuid(1), params)).toBe(true);

    expect(storedNeed(1)).toEqual({
      id: 1,
      need_id: uuid(1),
      foodbank_id: 1,
      distill_id: null,
      name: null,
      uri: null,
      change_text: "Pasta, Nappies",
      change_text_original: null,
      excess_change_text: "Baked beans",
      excess_change_text_original: null,
      published: 1,
      nonpertinent: 0,
      is_categorised: 0,
      notified: null,
      input_method: "scrape",
      // created is NOT restamped: it is what every ordering in this module
      // sorts on, so an edit must not move the need to the top of the queue.
      created: at(1),
      modified: "2026-09-06 11:22:33.444000",
    });
    // ...and nothing else in the table moved. A NeedForm save with no WHERE
    // would overwrite every need on the site with this one's change_text; see
    // seedBystander for the mutant.
    expectBystanderUntouched();
    expect(storedNeed(BYSTANDER).foodbank_id).toBeNull();
  });

  it("stores NULL, not an empty string, when there is no excess text", async () => {
    await updateNeedRawFields(session, uuid(1), { ...params, excessChangeText: null });
    expect(storedNeed(1).excess_change_text).toBeNull();
  });

  it("writes published = 0 for false", async () => {
    await updateNeedRawFields(session, uuid(1), { ...params, published: false });
    expect(storedNeed(1).published).toBe(0);
  });

  // BOTH food banks recomputed, which is the whole reason this function does
  // not just call recompute once. Reassigning a need moves which food bank's
  // latest_need it counts toward; recomputing only the new one would leave
  // the old one pointing at a need that is no longer its own.
  it("recomputes the OLD and the NEW food bank when the need is reassigned", async () => {
    db.prepare("UPDATE foodbankchange SET published = 1 WHERE id = 1").run();
    db.prepare("UPDATE foodbank SET latest_need_id = 1, last_need = ? WHERE id = 1").run(at(1));

    await updateNeedRawFields(session, uuid(1), { ...params, foodbankId: 2 });

    expect(storedFoodbank(1).latest_need_id).toBeNull();
    expect(storedFoodbank(1).last_need).toBeNull();
    expect(storedFoodbank(2).latest_need_id).toBe(1);
    expect(storedFoodbank(2).last_need).toBe(at(1));
  });

  // Map dedupe. An edit that leaves the food bank alone is by far the
  // common case, and recomputing it twice is two extra reads and a redundant
  // write on every save.
  it("recomputes once when the food bank has not changed", async () => {
    await updateNeedRawFields(session, uuid(1), params);
    expect(countStatements(/^UPDATE foodbank /)).toBe(1);
  });

  // `.filter(id => id !== null)` -- unassigning still has to fix up the food
  // bank that just lost the need, and NULL is not a food bank to recompute.
  it("recomputes only the old food bank when the need is unassigned", async () => {
    await updateNeedRawFields(session, uuid(1), { ...params, published: false, foodbankId: null });

    expect(storedNeed(1).foodbank_id).toBeNull();
    expect(countStatements(/^UPDATE foodbank /)).toBe(1);
    expect(storedFoodbank(1).last_need).toBeNull();
  });

  // foodbank.modified moves only for a food bank whose PUBLIC needs changed:
  // the one a published need left, and the one it is published on now.
  it("leaves the food bank's modified alone for an edit that stays unpublished", async () => {
    await updateNeedRawFields(session, uuid(1), { ...params, published: false });
    expect(storedFoodbank(1).modified).toBe(SEEDED_MODIFIED);
  });

  it("stamps the food bank's modified when the edit publishes the need", async () => {
    freezeClock(FROZEN_INSTANT);
    await updateNeedRawFields(session, uuid(1), params);
    expect(storedFoodbank(1).modified).toBe(FROZEN_PY);
  });

  // Same food bank on both sides, so the old side's "was published" and the
  // new side's "is not" land on one Map entry -- and must OR, not overwrite.
  it("stamps the food bank's modified when the edit unpublishes a published need", async () => {
    freezeClock(FROZEN_INSTANT);
    db.prepare("UPDATE foodbankchange SET published = 1 WHERE id = 1").run();

    await updateNeedRawFields(session, uuid(1), { ...params, published: false });

    expect(storedFoodbank(1).modified).toBe(FROZEN_PY);
  });

  it("stamps the food bank that lost a published need, not the one that gained an unpublished one", async () => {
    freezeClock(FROZEN_INSTANT);
    db.prepare("UPDATE foodbankchange SET published = 1 WHERE id = 1").run();

    await updateNeedRawFields(session, uuid(1), { ...params, published: false, foodbankId: 2 });

    expect(storedFoodbank(1).modified).toBe(FROZEN_PY);
    expect(storedFoodbank(2).modified).toBe(SEEDED_MODIFIED);
  });

  // NO GUARD HERE, unlike setNeedPublished -- this function will happily
  // write published = 1 with foodbank_id = NULL, the state
  // FoodbankChange.clean() calls invalid. The check lives in the route
  // (routes/admin/needs.ts:494-496), so this is pinned as a statement about
  // where the invariant is enforced: adding a second caller to this function
  // without that check reintroduces the orphan-published row.
  it("does NOT itself refuse a published need with no food bank -- the route is what enforces that", async () => {
    await updateNeedRawFields(session, uuid(1), { ...params, published: true, foodbankId: null });
    expect(storedNeed(1)).toMatchObject({ published: 1, foodbank_id: null });
  });
});

// =========================================================================
// deleteNeedsByUuids -- gfadmin/views.py:423-428 needs_deleteall
// =========================================================================

describe("deleteNeedsByUuids", () => {
  // Bound-parameter counts, per statement. D1 refuses a statement with more
  // than 100 of them, and the refusal is a 500 -- which is what this function
  // used to do, and did so only once the review queue had grown past 100,
  // i.e. exactly when someone wanted the "Delete all" button.
  const boundCounts = (): number[] => executed.filter((e) => /need_id IN \(/.test(e.sql)).map((e) => e.params.length);

  function seedMany(count: number, foodbankId: number | null = 1): string[] {
    for (let i = 1; i <= count; i++) seedNeed(db, { id: i, foodbank_id: foodbankId, created: `2026-01-01 00:00:${String(i % 60).padStart(2, "0")}.000000` });
    return Array.from({ length: count }, (_, i) => uuid(i + 1));
  }

  beforeEach(() => {
    seedFoodbank(db, { id: 1, name: "Salisbury", slug: "salisbury" });
    seedFoodbank(db, { id: 2, name: "Brixton", slug: "brixton" });
  });

  // The dashboard's "Delete all" with nothing ticked. What must never happen
  // is a statement reaching D1 with an empty `need_id IN ()`, which SQLite
  // rejects as a syntax error and the admin would see as a 500.
  //
  // CHECKED, NOT ASSUMED (this file was mutation-tested): deleting the
  // `if (needIds.length === 0) return;` line does NOT reintroduce that -- the
  // chunk loop's own `i < needIds.length` is already false, so nothing runs
  // either way. The early return is belt and braces, and this test pins the
  // behaviour that actually matters, which is that zero statements are sent.
  it("issues no statement at all for an empty list", async () => {
    await deleteNeedsByUuids(session, []);
    expect(executed).toEqual([]);
  });

  it("deletes exactly the named needs and leaves the rest", async () => {
    seedMany(5);
    await deleteNeedsByUuids(session, [uuid(2), uuid(4)]);
    expect(db.prepare("SELECT id FROM foodbankchange ORDER BY id").all()).toEqual([{ id: 1 }, { id: 3 }, { id: 5 }]);
  });

  it("ignores ids that match nothing", async () => {
    seedMany(2);
    await deleteNeedsByUuids(session, [uuid(1), uuid(999)]);
    expect(db.prepare("SELECT id FROM foodbankchange").all()).toEqual([{ id: 2 }]);
  });

  // AT the boundary: 90 ids is one chunk, because DELETE_CHUNK is 90.
  //
  // The bound VALUES are deliberately not asserted, only their count. Checked,
  // not assumed: reversing the order of a chunk's binds is an equivalent
  // mutant, because `need_id IN (?, ?, ?)` is set membership. Asserting an
  // order here would pin something the SQL does not have.
  it("sends 90 ids as a single chunk", async () => {
    const all = seedMany(90);
    await deleteNeedsByUuids(session, all);

    expect(boundCounts()).toEqual([90, 90]); // one SELECT, one DELETE
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbankchange").get()).toEqual({ n: 0 });
  });

  // ONE OVER the boundary -- the case a test that stopped at 90 would miss,
  // and the shape of the bug that actually shipped. Every id must still be
  // deleted, and no statement may bind more than 90.
  it("splits 91 ids into two chunks and still deletes all of them", async () => {
    const all = seedMany(91);
    await deleteNeedsByUuids(session, all);

    expect(boundCounts()).toEqual([90, 90, 1, 1]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbankchange").get()).toEqual({ n: 0 });
  });

  // WELL over it: 181 is three chunks, and 116 is the real number that was
  // reported on the dashboard. Neither may bind more than D1's cap.
  it("chunks 181 ids into three, none of them anywhere near D1's 100-parameter cap", async () => {
    const all = seedMany(181);
    await deleteNeedsByUuids(session, all);

    expect(boundCounts()).toEqual([90, 90, 90, 90, 1, 1]);
    expect(Math.max(...boundCounts())).toBeLessThanOrEqual(100);
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbankchange").get()).toEqual({ n: 0 });
  });

  it("deletes a real 116-need backlog without exceeding the parameter cap", async () => {
    const all = seedMany(116);
    await deleteNeedsByUuids(session, all);

    expect(Math.max(...boundCounts())).toBeLessThanOrEqual(100);
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbankchange").get()).toEqual({ n: 0 });
  });

  // The dedupe. Django's queryset .delete() bypasses the model's delete()
  // entirely and recomputes NOTHING; this recomputes each affected food bank
  // exactly once, however many of its needs were in the batch -- which is the
  // common shape of a backlog.
  it("recomputes each affected food bank once, not once per deleted need", async () => {
    seedNeed(db, { id: 1, foodbank_id: 1, created: at(1) });
    seedNeed(db, { id: 2, foodbank_id: 1, created: at(2) });
    seedNeed(db, { id: 3, foodbank_id: 1, created: at(3) });
    seedNeed(db, { id: 4, foodbank_id: 2, created: at(4) });

    await deleteNeedsByUuids(session, [uuid(1), uuid(2), uuid(3), uuid(4)]);

    expect(countStatements(/^UPDATE foodbank /)).toBe(2);
  });

  // Deduped ACROSS chunks, not merely within one. The Map lives outside the
  // loop; moving it inside would recompute a food bank once per chunk, which
  // no assertion on a single-chunk batch could ever notice.
  it("dedupes a food bank that appears in more than one chunk", async () => {
    const all = seedMany(120);
    await deleteNeedsByUuids(session, all);

    expect(boundCounts()).toEqual([90, 90, 30, 30]);
    expect(countStatements(/^UPDATE foodbank /)).toBe(1);
  });

  // Clearing a backlog of unreviewed needs is invisible to the public and
  // must not move "Last updated"; losing a published need is not.
  it("stamps modified only on the food banks that lost a published need", async () => {
    freezeClock(FROZEN_INSTANT);
    seedNeed(db, { id: 1, foodbank_id: 1, created: at(1), published: 0 });
    seedNeed(db, { id: 2, foodbank_id: 1, created: at(2), published: 1 });
    seedNeed(db, { id: 3, foodbank_id: 2, created: at(3), published: 0 });

    await deleteNeedsByUuids(session, [uuid(1), uuid(2), uuid(3)]);

    expect(storedFoodbank(1).modified).toBe(FROZEN_PY);
    expect(storedFoodbank(2).modified).toBe(SEEDED_MODIFIED);
  });

  // The published flag ORs across chunks: a published need in the first
  // chunk is not forgotten because the second chunk's needs were not.
  it("remembers a published need from an earlier chunk", async () => {
    freezeClock(FROZEN_INSTANT);
    const all = seedMany(120);
    db.prepare("UPDATE foodbankchange SET published = 1 WHERE id = 1").run();

    await deleteNeedsByUuids(session, all);

    expect(storedFoodbank(1).modified).toBe(FROZEN_PY);
  });

  // `AND foodbank_id IS NOT NULL` on the grouped select. Without it the Map
  // would collect a null and recomputeFoodbankNeedFields would run an UPDATE
  // with `WHERE id = NULL`, matching nothing -- harmless, but a wasted round
  // trip on the one query per chunk that already costs the most.
  it("does not try to recompute a NULL food bank", async () => {
    seedNeed(db, { id: 1, foodbank_id: null, created: at(1) });
    seedNeed(db, { id: 2, foodbank_id: null, created: at(2) });

    await deleteNeedsByUuids(session, [uuid(1), uuid(2)]);

    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbankchange").get()).toEqual({ n: 0 });
    expect(countStatements(/^UPDATE foodbank /)).toBe(0);
  });

  // The recompute has to happen AFTER the deletes, or it would rebuild
  // last_need/latest_need_id from rows that are about to disappear. Ordering
  // is the only thing that makes the result correct here, and it is invisible
  // in any assertion that only looks at the final row.
  it("recomputes from what survives, not from what was about to be deleted", async () => {
    seedNeed(db, { id: 1, foodbank_id: 1, created: at(1), published: 1 });
    seedNeed(db, { id: 2, foodbank_id: 1, created: at(5), published: 1 });
    db.prepare("UPDATE foodbank SET latest_need_id = 2, last_need = ? WHERE id = 1").run(at(5));

    await deleteNeedsByUuids(session, [uuid(2)]);

    expect(storedFoodbank(1).latest_need_id).toBe(1);
    expect(storedFoodbank(1).last_need).toBe(at(1));
  });

  // NOT ATOMIC across chunks, and the module says so. Nothing here can force
  // a mid-run failure, but the re-run is what makes partial progress
  // recoverable -- so the idempotence the comment relies on is asserted
  // instead: deleting the same ids twice is not an error.
  it("is idempotent -- re-running over already-deleted ids is a no-op, not an error", async () => {
    const all = seedMany(3);
    await deleteNeedsByUuids(session, all);
    await expect(deleteNeedsByUuids(session, all)).resolves.toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbankchange").get()).toEqual({ n: 0 });
  });
});
