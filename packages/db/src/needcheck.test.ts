import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "./schema.testkit";
import { beforeEach, describe, expect, it } from "vitest";
import { pyNow } from "@givefood/models";
import {
  decrementCrawlSetRemaining,
  findCrawlSetByRunId,
  finishCrawlItem,
  getFoodbankForNeedCheck,
  getLastPublishedNeed,
  getLastUnpublishedNeeds,
  getOpenFoodbanksForNeedCheck,
  insertCrawlItem,
  insertCrawlSet,
  insertFoodbankChange,
  insertFoodbankDiscrepancy,
  setCrawlSetExpected,
  updateFoodbankLastNeedCheck,
} from "./needcheck";
import type { Session } from "./types";

// WP 5.2 (PLAN.md §8.5): the needcheck pipeline's own D1 access -- the cron
// that enqueues one message per open food bank, and the RENDER_Q consumer's
// crawlset/crawlitem bookkeeping, change-detection reads and
// foodbankchange/foodbankdiscrepancy writes.
//
// WHY A REAL DATABASE, NOT A MOCK. Every function here is one statement and
// nothing else, so a session handing back canned rows would agree with any
// SQL at all -- including SQL that no longer means what its name says. The
// failures this module can actually have are the silent kind:
//
//   * `is_closed = 0` quietly dropped, and the daily cron scrapes ~380 dead
//     websites, each one writing a discrepancy into the queue a human reads;
//   * `finish IS NULL` decaying to `finish = NULL`, which is never true in
//     SQLite -- finishCrawlItem would then report "already closed" for every
//     item, and `crawlset.remaining` would never reach 0 again;
//   * `remaining > 0` dropped, and a redelivered queue message drives the
//     counter negative so the sweep never stamps `finish`;
//   * the upsert in insertCrawlItem losing its ON CONFLICT, so a Queues
//     redelivery (at-least-once, documented) orphans a second crawlitem row
//     whose `finish` is never stamped -- indistinguishable from a stall;
//   * `nonpertinent` written as NULL instead of 0, which keeps the new need
//     out of the review queue entirely (`nonpertinent = 0` excludes NULL --
//     PLAN.md §8.5.3's own warning, and needAdmin.ts:34's real query).
//
// None of those throws, none logs, and each leaves a plausible-looking
// database behind. This package already carries that scar: migration 0019
// dropped six tables' cached parent columns and four queries went on naming
// them until /dashboard/beautybanks/ was measured and found to be a live 500.
// So the statements below are run, by SQLite, against the real schema.
//
// MUTATION-TESTED (TESTING.md's convention: the evidence a test is
// load-bearing rather than decoration). The module was copied into a
// scratchpad, broken 148 ways across five passes, and this file re-run against
// each. Killed, among others: `is_closed = 0` dropped and `ORDER BY slug`
// swapped for id and for name; facebook_page dropped from the cron's SELECT;
// an is_closed filter ADDED to the consumer's re-read; findCrawlSetByRunId's
// WHERE dropped; insertCrawlSet's pyNow() replaced with toISOString();
// setCrawlSetExpected writing only `expected`; the decrement's `remaining > 0`
// guard dropped, its subtraction inverted, its finish stamped one item early,
// never, and every time; insertCrawlItem's ON CONFLICT removed and its no-op
// SET turned into a "helpful" start/url refresh; finishCrawlItem's `finish IS
// NULL` changed to `= NULL` and its `changes > 0` to `>= 0`, and its need_id
// assignment dropped; getLastPublishedNeed reading the base table instead of
// the view, ordering by id, ordering ASC, and losing `published = 1`; the
// suppression window losing its LIMIT, its `published = 0`, its foodbank
// scope, and having its two binds transposed; the new need written with
// `published = 1`, with `nonpertinent` NULL, with NULL _original columns, with
// a dashed uuid and with no uri; the discrepancy written as 'new', with a
// created/modified pair that disagree, and with foodbank_id/url transposed;
// last_need_check written to every row, with its binds transposed, and made to
// bump `modified` too; and both mapNeedRow calls removed.
//
// ELEVEN MUTANTS SURVIVED THE DRAFT SUITE, and they are the reason several
// tests below look more awkward than they need to -- shuffled ids, a food bank
// numbered 7, two discrepancy types where one would read more simply. Each is
// named in the comment on the test that now kills it, so that a future edit
// which "tidies" the awkwardness away can see what it is throwing out. Every
// one of them is a wrong answer with no exception attached:
//   1. insertCrawlItem's crawl_set_id and foodbank_id binds TRANSPOSED --
//      invisible while the first crawl set (id 1) crawls the first food bank
//      (id 1);
//   2. insertCrawlItem's crawl_type hardcoded to 'need' -- every assertion
//      passed "need", though charity.ts and articles.ts use this same writer;
//   3./4. both need readers ordering by `modified` instead of `created` --
//      invisible while the fixture writes modified = created;
//   5./6. the suppression window ordering by `id ASC`, or not ordering at all
//      -- both identical to `created DESC` while ids ascend as created
//      descends;
//   7. the suppression window's `foodbank_id = ?1` decayed to a literal 1 --
//      every draft test asked about food bank 1;
//   8./9. insertFoodbankChange's foodbank_id and uri hardcoded -- every draft
//      test wrote the same PARAMS;
//   10. insertFoodbankDiscrepancy's discrepancy_type hardcoded to 'website' --
//      the one value all four callers pass, and the only one the draft tried;
//   11. mapNeedRow applied to the FIRST row of the suppression window only --
//      the draft read `[0]` and no further.
// A twelfth, `AND expected IS NULL` bolted onto setCrawlSetExpected, is
// unreachable through today's call sites but was untested either way; the
// overwrite test below now says which way it goes.
//
// FIVE EQUIVALENT (OR UNREACHABLE) MUTANTS, stated rather than hidden, because
// an unkillable mutant looks exactly like an untested one:
//   * duplicating the VALUES tuple in insertCrawlItem's INSERT -- the second
//     tuple conflicts with the first inside the same statement and ON CONFLICT
//     folds it back onto the same row;
//   * findCrawlSetByRunId's `run_id = ?1` written as `run_id IS ?1` -- runId
//     is typed `string`, and IS is = for every non-NULL value;
//   * `is_closed = 0` written as `is_closed IS NOT 1` -- 0001_core.sql:37
//     declares the column NOT NULL, so there is no third state to tell them
//     apart;
//   * decrementCrawlSetRemaining's `=== 0` written as `<= 0` -- the
//     `remaining > 0` guard makes a negative unreachable;
//   * getLastPublishedNeed's `LIMIT 1` deleted -- `.first()` takes the first
//     row either way. It is a real waste of D1 row reads, not a wrong answer,
//     so it belongs in review rather than in an assertion.
// The one deliberately unkilled mutant is a LIMIT 100 ADDED to the cron's
// list: killing it means seeding 101 food banks in a suite that runs on every
// save, to catch an edit nobody has a reason to make.
//
// THE FIXTURE IS THE MIGRATION FILES THEMSELVES, applied in order (same
// approach as crawlSets.test.ts, adminDashboardStats.test.ts): a CREATE TABLE
// transcribed into a test file is a second copy of the truth and drifts from
// the first. Four facts it supplies that a hand-written schema would probably
// have got wrong, and that tests below depend on:
//   * crawlset_runid_uniq is a PARTIAL unique index (`WHERE run_id IS NOT
//     NULL`), so the cron's dedup is real while Force Check can create any
//     number of run_id-less sets;
//   * crawlitem_crawlset_foodbank_uniq is UNIQUE(crawl_set_id, foodbank_id)
//     and does NOT include crawl_type -- which is what makes insertCrawlItem's
//     upsert work, and is also the hazard pinned at the end of that block;
//   * foodbankchange.nonpertinent and .is_categorised are NULLABLE, so
//     "explicit 0" is a decision with a visible consequence rather than a
//     formality;
//   * 0019 DROPPED foodbankdiscrepancy.foodbank_name and foodbankchange
//     .foodbank_name, so both parents' names can now only come from the
//     _full views' LEFT JOINs.
//
// NO CHUNKING TO TEST. D1 caps a statement at 100 bound parameters, which is
// the boundary every variable-length IN list in this package has to be tested
// at. Nothing here builds one: the widest statement binds six values, and
// every filter is a single equality, so the parameter count is fixed no
// matter how many food banks exist. The 100-item batching in this pipeline is
// Queues' sendBatch cap, and it lives in workers/jobs/src/scheduled/index.ts,
// not in the SQL.

type Bindable = null | number | bigint | string | Uint8Array;

// The slice of the D1 Sessions API this package is handed, backed by
// node:sqlite. Copied from articles.test.ts (itself copied from
// workers/site/src/routes/admin/foodbankLocation.test.ts) so every tier drives
// the real code through one adapter. Deliberately dumb -- it forwards the SQL
// untouched and interprets nothing, so the engine decides what comes back.
//
// `meta` is load-bearing in this module and is the engine's own numbers, not
// invented ones: insertCrawlSet/insertCrawlItem/insertFoodbankChange/
// insertFoodbankDiscrepancy return `meta.last_row_id` (sqlite3_last_insert_
// rowid), and finishCrawlItem returns `meta.changes > 0` (sqlite3_changes) --
// which is the whole double-decrement guard. A fake that always answered
// `changes: 1` would agree with an implementation that had lost the
// `finish IS NULL` predicate.
function d1Session(db: DatabaseSync): Session {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      const info = db.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    },
  });
  return { prepare: (sql: string) => statement(sql, []), getBookmark: () => null } as unknown as Session;
}

let db: DatabaseSync;
let session: Session;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  session = d1Session(db);
});

// ---------------------------------------------------------------------------
// Seeds
//
// EVERY TIMESTAMP IN THIS FILE IS DJANGO'S FORMAT, "YYYY-MM-DD HH:MM:SS.ffffff"
// -- what pyDatetime() writes and what migration 0022 rewrote the imported
// Postgres rows into. That is not decoration. These columns are TEXT and every
// ORDER BY over them is a byte-wise string comparison, so a toISOString()
// value ("2026-09-05T08:00:00.000Z") sorts ABOVE every space-separated value
// from the same day, because 'T' (0x54) beats ' ' (0x20). Seeding ISO here
// would be testing a database this app does not have -- except in the one
// place below where that hazard is pinned deliberately.
// ---------------------------------------------------------------------------

interface FoodbankSeed {
  id: number;
  slug: string;
  name?: string;
  url?: string;
  shoppingListUrl?: string;
  facebookPage?: string | null;
  isClosed?: 0 | 1;
  lastNeedCheck?: string | null;
}

function seedFoodbank(fb: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank (
       id, uuid, name, slug, address, postcode, country, lat_lng,
       charity_just_foodbank, contact_email, url, shopping_list_url, facebook_page,
       address_is_administrative, is_closed, no_locations, days_between_needs,
       last_need_check, created, modified
     ) VALUES (?, ?, ?, ?, 'Address', 'SP2 9DY', 'England', '51.06,-1.79',
       0, 'info@example.org', ?, ?, ?,
       0, ?, 0, 7,
       ?, '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run(
    fb.id,
    `uuid-${fb.id}`,
    fb.name ?? `${fb.slug} Foodbank`,
    fb.slug,
    fb.url ?? `https://${fb.slug}.foodbank.org.uk/`,
    fb.shoppingListUrl ?? `https://${fb.slug}.foodbank.org.uk/give-help/donate-food/`,
    fb.facebookPage ?? null,
    fb.isClosed ?? 0,
    fb.lastNeedCheck ?? null,
  );
}

interface NeedSeed {
  id: number;
  foodbankId: number | null;
  created: string;
  published: 0 | 1;
  changeText?: string;
  excessChangeText?: string | null;
  nonpertinent?: 0 | 1 | null;
  isCategorised?: 0 | 1 | null;
  needId?: string;
  // Defaults to `created`, which is what a never-edited need really looks
  // like -- but it MUST be settable independently, because a fixture where
  // every row's modified equals its created blesses `ORDER BY modified DESC`
  // as indistinguishable from `ORDER BY created DESC`. It is not: Django's
  // queryset is `.latest("created")` (crawlers.py:404-407), and `modified`
  // moves whenever a reviewer edits or publishes a need in the admin, so an
  // ancient need touched this morning would become the "last published need"
  // the whole change comparison is measured against. That mutant survived
  // this file's first draft; the ordering tests below now set the two apart.
  modified?: string;
}

// `need_id` is the 32-char dashless UUID, NOT the row's integer primary key --
// two different columns, and insertFoodbankChange writes the former while
// returning the latter. Seeded as visibly different values so a query that
// confused them could not accidentally look right.
function seedNeed(n: NeedSeed): void {
  db.prepare(
    `INSERT INTO foodbankchange
       (id, need_id, foodbank_id, uri, change_text, change_text_original,
        excess_change_text, excess_change_text_original,
        published, nonpertinent, is_categorised, input_method, created, modified)
     VALUES (?, ?, ?, 'https://example.org/list/', ?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?)`,
  ).run(
    n.id,
    n.needId ?? `${String(n.id).padStart(2, "0")}${"a".repeat(30)}`,
    n.foodbankId,
    n.changeText ?? "Beans\nRice",
    n.changeText ?? "Beans\nRice",
    n.excessChangeText ?? null,
    n.excessChangeText ?? null,
    n.published,
    // `?? 0` would be wrong here: an EXPLICIT null is the state several tests
    // are about (the 18,943 legacy rows where nonpertinent IS NULL), so
    // "omitted" and "null" have to stay distinguishable in the fixture.
    n.nonpertinent === undefined ? 0 : n.nonpertinent,
    n.isCategorised === undefined ? 0 : n.isCategorised,
    n.created,
    n.modified ?? n.created,
  );
}

function crawlSetRow(id: number): Record<string, unknown> {
  return { ...(db.prepare("SELECT * FROM crawlset WHERE id = ?").get(id) as Record<string, unknown>) };
}

function crawlItemRow(id: number): Record<string, unknown> {
  return { ...(db.prepare("SELECT * FROM crawlitem WHERE id = ?").get(id) as Record<string, unknown>) };
}

function changeRow(id: number): Record<string, unknown> {
  return { ...(db.prepare("SELECT * FROM foodbankchange WHERE id = ?").get(id) as Record<string, unknown>) };
}

function discrepancyRow(id: number): Record<string, unknown> {
  return { ...(db.prepare("SELECT * FROM foodbankdiscrepancy WHERE id = ?").get(id) as Record<string, unknown>) };
}

function foodbankRow(id: number): Record<string, unknown> {
  return { ...(db.prepare("SELECT * FROM foodbank WHERE id = ?").get(id) as Record<string, unknown>) };
}

const DJANGO_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;

// A timestamp this module stamped itself (pyNow()) must be in Django's shape
// AND be the real clock. Both halves are asserted by comparing it as a STRING
// against pyNow() readings taken either side of the call -- string comparison
// precisely because that is the only comparison SQLite will ever do to this
// value. An ISO stamp would fail the regex; a hardcoded or reformatted one
// would fall outside the window.
function expectStampedNow(value: unknown, before: string, after: string): void {
  expect(String(value)).toMatch(DJANGO_TIMESTAMP);
  expect(String(value) >= before).toBe(true);
  expect(String(value) <= after).toBe(true);
}

// ---------------------------------------------------------------------------
// getOpenFoodbanksForNeedCheck -- the cron's enqueue list
// ---------------------------------------------------------------------------

describe("getOpenFoodbanksForNeedCheck", () => {
  // needcheck.py:20's `Foodbank.objects.exclude(is_closed = True)`. This one
  // predicate decides how many messages land on RENDER_Q: lose it and the
  // daily sweep also scrapes every closed food bank, spends an OpenRouter
  // call on each, and writes each failure into the discrepancy queue a human
  // reads every morning. Closed rows are seeded FIRST and outnumber the open
  // ones, because a filter that did nothing passes every test written only
  // from rows it is supposed to keep.
  it("excludes closed food banks", async () => {
    seedFoodbank({ id: 1, slug: "closed-one", isClosed: 1 });
    seedFoodbank({ id: 2, slug: "closed-two", isClosed: 1 });
    seedFoodbank({ id: 3, slug: "closed-three", isClosed: 1 });
    seedFoodbank({ id: 4, slug: "amesbury" });
    seedFoodbank({ id: 5, slug: "salisbury" });

    const rows = await getOpenFoodbanksForNeedCheck(session);
    expect(rows.map((r) => r.slug)).toEqual(["amesbury", "salisbury"]);
  });

  // PLAN.md §8.5.2's deliberate divergence from Django's `.order_by("?")`:
  // a Queue makes enqueue order irrelevant, and a deterministic order makes a
  // partial run easy to reason about. Seeded so that id order, name order and
  // slug order all DISAGREE -- in production they mostly agree, so a fixture
  // that let them agree would bless an `ORDER BY id` or an `ORDER BY name`
  // forever. (Name order really is different: SQLite's default collation is
  // byte-wise, so "Zion" (0x5A) sorts before "iCare" (0x69), while their slugs
  // sort the other way round. That is the same trap types.ts's sortByName
  // exists for.)
  it("orders by slug -- not by id, and not by name", async () => {
    seedFoodbank({ id: 1, slug: "zion", name: "Zion Foodbank" });
    seedFoodbank({ id: 2, slug: "icare", name: "iCare Foodbank" });
    seedFoodbank({ id: 3, slug: "amesbury", name: "Amesbury Foodbank" });

    const rows = await getOpenFoodbanksForNeedCheck(session);
    expect(rows.map((r) => r.id)).toEqual([3, 2, 1]);
    expect(rows.map((r) => r.slug)).toEqual(["amesbury", "icare", "zion"]);
  });

  // The queue message is built field-by-field from this row
  // (scheduled/index.ts:163-172), so a column dropped from the SELECT arrives
  // at the consumer as `undefined` -- a fetch to "undefined", not an error.
  // An EXTRA column matters too: this row is serialised into ~1,024 queue
  // messages, and 256 KB per sendBatch is a real cap.
  it("returns exactly the six columns the queue message is built from", async () => {
    seedFoodbank({
      id: 7,
      slug: "salisbury",
      name: "Salisbury Foodbank",
      url: "https://salisbury.foodbank.org.uk/",
      shoppingListUrl: "https://salisbury.foodbank.org.uk/give-help/donate-food/",
      facebookPage: null,
    });

    const [row] = await getOpenFoodbanksForNeedCheck(session);
    expect(Object.keys(row!).sort()).toEqual(["facebook_page", "id", "name", "shopping_list_url", "slug", "url"]);
    expect({ ...row! }).toEqual({
      id: 7,
      slug: "salisbury",
      name: "Salisbury Foodbank",
      url: "https://salisbury.foodbank.org.uk/",
      shopping_list_url: "https://salisbury.foodbank.org.uk/give-help/donate-food/",
      facebook_page: null,
    });
  });

  // facebook_page is only ever populated for the food banks whose shopping
  // list IS a Facebook page, and it is the ONLY field that tells the consumer
  // which page to fetch (needcheckRender.ts's scrape_type branch, crawlers.py
  // :297-301). It is nullable, so a query that dropped it would look correct
  // on the ~1,000 web food banks and silently break the handful of Facebook
  // ones -- the least-watched corner of the pipeline.
  it("carries the Facebook page through for the food banks scraped that way", async () => {
    seedFoodbank({
      id: 1,
      slug: "facebook-fb",
      shoppingListUrl: "https://www.facebook.com/examplefoodbank",
      facebookPage: "examplefoodbank",
    });

    const [row] = await getOpenFoodbanksForNeedCheck(session);
    expect(row!.facebook_page).toBe("examplefoodbank");
    expect(row!.shopping_list_url).toBe("https://www.facebook.com/examplefoodbank");
  });

  // The empty answer has to be an empty ARRAY, not a throw or a null: the cron
  // goes straight on to setCrawlSetExpected(crawlSetId, foodbanks.length),
  // and `expected = 0 / remaining = 0` is the state the sweep must be able to
  // reach and close.
  it("returns an empty list rather than failing when nothing is open", async () => {
    seedFoodbank({ id: 1, slug: "closed", isClosed: 1 });

    expect(await getOpenFoodbanksForNeedCheck(session)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getFoodbankForNeedCheck -- the consumer's re-read at dequeue time
// ---------------------------------------------------------------------------

describe("getFoodbankForNeedCheck", () => {
  it("returns the row by id, with the same six columns the cron selected", async () => {
    seedFoodbank({ id: 1, slug: "amesbury" });
    seedFoodbank({ id: 2, slug: "salisbury", name: "Salisbury Foodbank" });

    const row = await getFoodbankForNeedCheck(session, 2);
    expect(Object.keys(row!).sort()).toEqual(["facebook_page", "id", "name", "shopping_list_url", "slug", "url"]);
    expect(row!.slug).toBe("salisbury");
    expect(row!.name).toBe("Salisbury Foodbank");
  });

  // THE WHOLE REASON THIS FUNCTION EXISTS (crawlers.py:579-590 re-fetches
  // Foodbank.objects.get(slug=...) immediately before scraping, every time).
  // The cron's snapshot can be multi-minute stale at max_concurrency 25 over
  // ~1,024 messages, so an admin who fixes a broken shopping list URL while
  // the sweep is running must have that fix used -- not the enqueue-time copy
  // in the message body.
  it("reads the row's CURRENT values, not the enqueue-time snapshot", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", shoppingListUrl: "https://old.example.org/list/" });
    db.prepare("UPDATE foodbank SET shopping_list_url = ? WHERE id = 1").run("https://new.example.org/list/");

    expect((await getFoodbankForNeedCheck(session, 1))!.shopping_list_url).toBe("https://new.example.org/list/");
  });

  // Deleted between enqueue and dequeue. The consumer turns this null into a
  // thrown error and lets Queues retry (matching Django's uncaught
  // Foodbank.DoesNotExist), so returning a null rather than a partially-filled
  // object is what keeps that branch reachable.
  it("returns null for a food bank that no longer exists", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });

    expect(await getFoodbankForNeedCheck(session, 404)).toBeNull();
  });

  // PINNED, NOT ENDORSED: no is_closed predicate here. A food bank closed by
  // an admin during the sweep is still scraped, because Django's
  // `.get(slug=...)` had no such filter either -- the exclusion happens once,
  // at enqueue. The window is minutes and the cost is one wasted scrape, so
  // this is parity rather than a bug; it is written down because "the cron
  // excludes closed food banks" is otherwise easy to read as "the pipeline
  // never touches closed food banks".
  it("still returns a food bank that was closed after the enqueue", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    db.prepare("UPDATE foodbank SET is_closed = 1 WHERE id = 1").run();

    expect((await getFoodbankForNeedCheck(session, 1))!.slug).toBe("salisbury");
  });
});

// ---------------------------------------------------------------------------
// findCrawlSetByRunId / insertCrawlSet -- the cron's free dedup
// ---------------------------------------------------------------------------

describe("findCrawlSetByRunId", () => {
  // WAS "returns only its id" until 2026-09-09. `start` is now selected too,
  // and deliberately so: getOrCreateCrawlSet compares it against the
  // timestamp it passed to its own INSERT, which is how a retry after a
  // committed-but-unacknowledged write tells its own row apart from a
  // concurrent invocation's. Widened rather than deleted so the shape stays
  // pinned -- a future "select fewer columns" tidy-up would break the cron's
  // crash recovery silently.
  it("finds the run's crawl set and returns its id and start", async () => {
    const id = await insertCrawlSet(session, "need", "needcheck-2026-09-05T07:45", "2026-09-05 07:45:00.123000");

    const found = await findCrawlSetByRunId(session, "needcheck-2026-09-05T07:45");
    expect(found).toEqual({ id, start: "2026-09-05 07:45:00.123000" });
  });

  // The ownership check is only as good as `start` round-tripping verbatim.
  it("returns the start exactly as insertCrawlSet wrote it", async () => {
    await insertCrawlSet(session, "need", "needcheck-2026-09-06T07:45", "2026-09-06 07:45:09.000000");

    expect((await findCrawlSetByRunId(session, "needcheck-2026-09-06T07:45"))!.start).toBe("2026-09-06 07:45:09.000000");
  });

  // The common case, and the one the whole cron depends on: a first delivery
  // must find nothing, or every needcheck run after the first would no-op and
  // the site's needs would quietly stop updating.
  it("returns null for a run_id nothing holds yet", async () => {
    await insertCrawlSet(session, "need", "needcheck-2026-09-04T07:45");

    expect(await findCrawlSetByRunId(session, "needcheck-2026-09-05T07:45")).toBeNull();
  });

  it("picks the right run out of several", async () => {
    const yesterday = await insertCrawlSet(session, "need", "needcheck-2026-09-04T07:45");
    const today = await insertCrawlSet(session, "need", "needcheck-2026-09-05T07:45");
    await insertCrawlSet(session, "article", "getarticles-2026-09-05T06:00");

    expect((await findCrawlSetByRunId(session, "needcheck-2026-09-05T07:45"))!.id).toBe(today);
    expect((await findCrawlSetByRunId(session, "needcheck-2026-09-04T07:45"))!.id).toBe(yesterday);
  });

  // Most rows in this table have run_id NULL -- every Force Check from the
  // admin (foodbankForceCrawl.ts:61) and every crawl set imported from
  // Django. `run_id = ?1` is never true against a NULL column value in
  // SQLite, which is the behaviour being pinned: the dedup lookup can never
  // collide with an ad-hoc set, whatever string it is given.
  it("never matches the ad-hoc crawl sets whose run_id is NULL", async () => {
    await insertCrawlSet(session, "need", null);
    await insertCrawlSet(session, "need", null);

    expect(await findCrawlSetByRunId(session, "needcheck-2026-09-05T07:45")).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM crawlset").get()).toEqual({ n: 2 });
  });
});

describe("insertCrawlSet", () => {
  it("writes the row and returns its new id", async () => {
    const first = await insertCrawlSet(session, "need", "needcheck-2026-09-05T07:45");
    const second = await insertCrawlSet(session, "article", "getarticles-2026-09-05T06:00");

    expect(second).toBe(first + 1);
    expect(crawlSetRow(first)).toMatchObject({ crawl_type: "need", run_id: "needcheck-2026-09-05T07:45" });
    expect(crawlSetRow(second)).toMatchObject({ crawl_type: "article", run_id: "getarticles-2026-09-05T06:00" });
  });

  // `start` is what /admin/jobs/ sorts and subtracts on, and it is TEXT --
  // so the format is the sort. A toISOString() value would sort above every
  // Django-format row from the same day ('T' 0x54 > ' ' 0x20), putting a
  // month-old ISO row at the top of "newest first" forever. That exact bug
  // has been live twice in this repo (pyDatetime.ts's header records both).
  it("stamps start with pyNow(), in Django's format and on the real clock", async () => {
    const before = pyNow();
    const id = await insertCrawlSet(session, "need", "needcheck-2026-09-05T07:45");
    const after = pyNow();

    const start = crawlSetRow(id).start;
    expectStampedNow(start, before, after);
    expect(String(start)).not.toContain("T");
    expect(String(start)).not.toContain("Z");
  });

  // The three columns a brand-new crawl set must NOT have. `remaining` NULL
  // in particular is why scheduled/index.ts:161 calls setCrawlSetExpected
  // BEFORE it sends a single message: decrementCrawlSetRemaining's
  // `remaining > 0` guard matches nothing while the column is NULL, so a
  // message that finished first would silently fail to decrement and this run
  // would never close. The next test proves that, rather than asserting it.
  it("leaves finish, expected and remaining NULL", async () => {
    const id = await insertCrawlSet(session, "need", null);

    expect(crawlSetRow(id)).toMatchObject({ finish: null, expected: null, remaining: null });
  });

  it("cannot be decremented until setCrawlSetExpected has run", async () => {
    const id = await insertCrawlSet(session, "need", null);

    expect(await decrementCrawlSetRemaining(session, id)).toBeNull();
    expect(crawlSetRow(id)).toMatchObject({ remaining: null, finish: null });
  });

  // crawlset_runid_uniq, and the reason getOrCreateCrawlSet
  // (scheduled/index.ts:96-102) has a catch block at all: on a genuinely
  // concurrent duplicate Cron Trigger delivery both invocations pass the
  // find-by-run_id check, and the loser has to recognise its own throw. That
  // recogniser is `message.includes("UNIQUE constraint failed")`, so the
  // exact substring is asserted here -- a driver that reworded this message
  // would turn a handled no-op into an unhandled rejection inside
  // ctx.waitUntil, and ~1,024 duplicate need checks would go out with it.
  it("refuses a second crawl set with the same run_id", async () => {
    await insertCrawlSet(session, "need", "needcheck-2026-09-05T07:45");

    await expect(insertCrawlSet(session, "need", "needcheck-2026-09-05T07:45")).rejects.toThrow(/UNIQUE constraint failed/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM crawlset").get()).toEqual({ n: 1 });
  });

  // The index is PARTIAL (`WHERE run_id IS NOT NULL`), so the dedup applies
  // only to the crons. Every Force Check button press creates a run_id-less
  // set of its own, and an admin clicking twice must not get a 500.
  it("allows any number of crawl sets with no run_id", async () => {
    const a = await insertCrawlSet(session, "need", null);
    const b = await insertCrawlSet(session, "need", null);
    const c = await insertCrawlSet(session, "article", null);

    expect(new Set([a, b, c]).size).toBe(3);
    expect(db.prepare("SELECT COUNT(*) AS n FROM crawlset WHERE run_id IS NULL").get()).toEqual({ n: 3 });
  });
});

// ---------------------------------------------------------------------------
// setCrawlSetExpected / decrementCrawlSetRemaining -- the countdown
// ---------------------------------------------------------------------------

describe("setCrawlSetExpected", () => {
  // One bound value, written into two columns (`SET expected = ?1,
  // remaining = ?1`). They are the progress bar's denominator and its
  // countdown, and /admin/jobs/ derives `done` as expected - remaining -- so a
  // statement that filled only one of them would render a sweep as either
  // 0% or 100% done from the moment it started.
  it("sets expected and remaining to the same value from one bind", async () => {
    const id = await insertCrawlSet(session, "need", null);

    await setCrawlSetExpected(session, id, 1071);

    expect(crawlSetRow(id)).toMatchObject({ expected: 1071, remaining: 1071 });
  });

  it("touches only the crawl set it names", async () => {
    const mine = await insertCrawlSet(session, "need", null);
    const other = await insertCrawlSet(session, "article", null);
    await setCrawlSetExpected(session, other, 42);

    await setCrawlSetExpected(session, mine, 1071);

    expect(crawlSetRow(other)).toMatchObject({ expected: 42, remaining: 42 });
  });

  // The empty sweep: `foodbanks.length` is 0 when every food bank is closed
  // or the list query returns nothing. The set must be able to sit at 0/0
  // rather than being left un-initialised -- and it must not be decremented
  // into negative territory by a stray redelivery, which the next block pins.
  it("accepts zero for a sweep with nothing to check", async () => {
    const id = await insertCrawlSet(session, "need", null);

    await setCrawlSetExpected(session, id, 0);

    expect(crawlSetRow(id)).toMatchObject({ expected: 0, remaining: 0 });
  });

  // An UNCONDITIONAL update, pinned rather than merely observed: every call
  // site today (scheduled/index.ts:161/:193/:226, foodbankForceCrawl.ts:62/
  // :89/:113, admin/needs.ts:241) writes a virgin crawl set exactly once, so a
  // "helpful" `AND expected IS NULL` guard would be invisible in production
  // AND invisible to a test that only ever writes a virgin row -- which is
  // what the draft did. It is worth knowing which way this goes before
  // somebody writes the resume path that re-counts a partially-enqueued sweep:
  // today the last write wins, and the counter it leaves behind is the one the
  // countdown will run down.
  it("overwrites a counter that was already set", async () => {
    const id = await insertCrawlSet(session, "need", null);
    await setCrawlSetExpected(session, id, 1071);
    await decrementCrawlSetRemaining(session, id);

    await setCrawlSetExpected(session, id, 42);

    expect(crawlSetRow(id)).toMatchObject({ expected: 42, remaining: 42 });
  });
});

describe("decrementCrawlSetRemaining", () => {
  // UPDATE...RETURNING in one round trip: the decrement and the read of the
  // new value are the same statement, so two consumer invocations finishing
  // at the same moment cannot both read "1" and both stamp `finish`. The
  // assertion that matters is that the value RETURNED and the value STORED
  // agree -- a read-then-write implementation would pass a returns-2 check
  // while leaving 3 in the row.
  it("decrements by one, returns the new value, and stores it", async () => {
    const id = await insertCrawlSet(session, "need", null);
    await setCrawlSetExpected(session, id, 3);

    expect(await decrementCrawlSetRemaining(session, id)).toBe(2);
    expect(crawlSetRow(id).remaining).toBe(2);
    expect(await decrementCrawlSetRemaining(session, id)).toBe(1);
    expect(crawlSetRow(id).remaining).toBe(1);
  });

  // Nothing in Django's needcheck.py ever stamps `finish` for a 'need' crawl
  // set -- confirmed on production, where every such row has finish IS NULL
  // and CrawlSet.time_taken() therefore always returns None (PLAN.md §8.5.2).
  // Stamping it here is the port's own fix, and the moment it happens is the
  // transition to 0: earlier would report a running sweep as finished, later
  // would never happen at all.
  it("stamps finish exactly when remaining reaches zero, and not before", async () => {
    const id = await insertCrawlSet(session, "need", null);
    await setCrawlSetExpected(session, id, 2);

    expect(await decrementCrawlSetRemaining(session, id)).toBe(1);
    expect(crawlSetRow(id).finish).toBeNull();

    const before = pyNow();
    expect(await decrementCrawlSetRemaining(session, id)).toBe(0);
    const after = pyNow();

    expectStampedNow(crawlSetRow(id).finish, before, after);
  });

  // `AND remaining > 0` is the guard against Cloudflare Queues' at-least-once
  // delivery. Without it a redelivered message drives the counter to -1, the
  // `=== 0` test never fires again, and the sweep shows as running forever on
  // /admin/jobs/ -- which is exactly how a stuck crawl is supposed to look, so
  // nobody would ever know it had actually completed.
  it("refuses to go below zero and leaves the original finish alone", async () => {
    const id = await insertCrawlSet(session, "need", null);
    await setCrawlSetExpected(session, id, 1);
    await decrementCrawlSetRemaining(session, id);
    const stampedAt = crawlSetRow(id).finish;

    expect(await decrementCrawlSetRemaining(session, id)).toBeNull();
    expect(crawlSetRow(id)).toMatchObject({ remaining: 0, finish: stampedAt });
  });

  // The window between insertCrawlSet and setCrawlSetExpected. `NULL > 0` is
  // UNKNOWN in SQLite, never true, so the UPDATE matches no row and the
  // function reports null rather than writing NULL - 1 (which is NULL) into
  // the counter and losing the run's whole countdown.
  it("returns null while remaining is still NULL, without touching the row", async () => {
    const id = await insertCrawlSet(session, "need", null);

    expect(await decrementCrawlSetRemaining(session, id)).toBeNull();
    expect(crawlSetRow(id)).toMatchObject({ remaining: null, finish: null });
  });

  // The DLQ handlers (needcheckRenderDlq.ts:38, articlesDlq.ts, charityDlq.ts)
  // decrement by an id carried in a message body that may be days old, and
  // maintenance.ts prunes crawl sets on a schedule. A missing row has to be a
  // null, not a throw -- a throw there would fail the whole DLQ batch.
  it("returns null for a crawl set that no longer exists", async () => {
    expect(await decrementCrawlSetRemaining(session, 404)).toBeNull();
  });

  it("decrements only the crawl set it names", async () => {
    const mine = await insertCrawlSet(session, "need", null);
    const other = await insertCrawlSet(session, "article", null);
    await setCrawlSetExpected(session, mine, 5);
    await setCrawlSetExpected(session, other, 5);

    await decrementCrawlSetRemaining(session, mine);

    expect(crawlSetRow(other)).toMatchObject({ remaining: 5, finish: null });
  });

  // The whole countdown, end to end, because the interesting property is a
  // sequence rather than any single call: a three-food-bank sweep closes
  // exactly once, at exactly the right moment, and stays closed.
  it("closes a whole sweep once and only once", async () => {
    const id = await insertCrawlSet(session, "need", "needcheck-2026-09-05T07:45");
    await setCrawlSetExpected(session, id, 3);

    expect(await decrementCrawlSetRemaining(session, id)).toBe(2);
    expect(await decrementCrawlSetRemaining(session, id)).toBe(1);
    expect(await decrementCrawlSetRemaining(session, id)).toBe(0);
    const finish = crawlSetRow(id).finish;
    expect(finish).not.toBeNull();

    expect(await decrementCrawlSetRemaining(session, id)).toBeNull();
    expect(crawlSetRow(id)).toMatchObject({ expected: 3, remaining: 0, finish });
  });
});

// ---------------------------------------------------------------------------
// insertCrawlItem / finishCrawlItem -- the per-food-bank record
// ---------------------------------------------------------------------------

describe("insertCrawlItem", () => {
  // THE FOOD BANK IS ID 7, NOT ID 1, AND THAT IS THE POINT. crawl_set_id and
  // foodbank_id are adjacent INTEGER binds (?1 and ?4) into adjacent INTEGER
  // columns, so SQLite accepts them transposed without a murmur -- and a
  // fixture where the sweep's first crawl set (id 1) crawls the first food
  // bank (id 1) cannot tell the two apart. That mutant survived this file's
  // first draft: every crawlitem row would be filed against the wrong food
  // bank and the wrong sweep, /admin/jobs/ would show the wrong item counts,
  // and crawlitem_foodbank_finish_idx's "when was this food bank last
  // crawled" lookup would answer about a different one. Nothing throws.
  it("opens an unfinished row against the crawl set and food bank it names", async () => {
    seedFoodbank({ id: 7, slug: "salisbury" });
    const crawlSetId = await insertCrawlSet(session, "need", null);
    // The guard on the guard: if a later edit made these equal again, the
    // transposition would silently stop being tested.
    expect(crawlSetId).not.toBe(7);

    const before = pyNow();
    const itemId = await insertCrawlItem(session, {
      crawlSetId,
      crawlType: "need",
      foodbankId: 7,
      url: "https://salisbury.foodbank.org.uk/give-help/donate-food/",
    });
    const after = pyNow();

    const row = crawlItemRow(itemId);
    expect(row).toMatchObject({
      crawl_set_id: crawlSetId,
      crawl_type: "need",
      foodbank_id: 7,
      url: "https://salisbury.foodbank.org.uk/give-help/donate-food/",
      // finish IS NULL is how a stalled or crashed run is detected
      // (0008_needcheck.sql's own comment), so an item that opened already
      // closed would make every crash invisible.
      finish: null,
      need_id: null,
    });
    expectStampedNow(row.start, before, after);
  });

  // THE UPSERT, and the reason it is not a plain INSERT. Cloudflare Queues is
  // at-least-once: a transient failure between here and finish() re-enters
  // processOne from scratch. A plain INSERT would leave a second crawlitem
  // row for the same food bank whose `finish` is never stamped -- which is
  // indistinguishable from a genuine stall on /admin/jobs/, and would inflate
  // every sweep's item_count on the crawl sets page.
  it("reopens the SAME row on a redelivery instead of orphaning a second one", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    const crawlSetId = await insertCrawlSet(session, "need", null);
    const params = { crawlSetId, crawlType: "need", foodbankId: 1, url: "https://salisbury.example.org/list/" };

    const first = await insertCrawlItem(session, params);
    const second = await insertCrawlItem(session, params);

    expect(second).toBe(first);
    expect(db.prepare("SELECT COUNT(*) AS n FROM crawlitem").get()).toEqual({ n: 1 });
  });

  // `DO UPDATE SET crawl_set_id = crawl_set_id` is a deliberate no-op: SQLite
  // requires a SET clause for RETURNING to hand the existing id back, and
  // this one exists so the retry touches nothing. The visible consequence is
  // that `start` keeps the FIRST attempt's time -- which is the honest
  // reading of "when did we start crawling this food bank" -- and that the url
  // is the first attempt's too, even if an admin changed it in between. Pinned
  // rather than endorsed: the fresh URL IS used for the actual scrape
  // (getFoodbankForNeedCheck re-reads it); only this audit row keeps the old
  // one.
  it("leaves start, url and crawl_type as the first attempt wrote them", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    const crawlSetId = await insertCrawlSet(session, "need", null);
    const itemId = await insertCrawlItem(session, { crawlSetId, crawlType: "need", foodbankId: 1, url: "https://old.example.org/list/" });
    db.prepare("UPDATE crawlitem SET start = '2020-01-01 00:00:00.000000' WHERE id = ?").run(itemId);

    await insertCrawlItem(session, { crawlSetId, crawlType: "need", foodbankId: 1, url: "https://new.example.org/list/" });

    expect(crawlItemRow(itemId)).toMatchObject({
      start: "2020-01-01 00:00:00.000000",
      url: "https://old.example.org/list/",
      crawl_type: "need",
    });
  });

  // The half of the guard chain that lives here rather than in
  // finishCrawlItem: the upsert must NOT clear `finish`, or a redelivery
  // arriving after the original attempt committed would look brand new,
  // finishCrawlItem would report true again, and crawlset.remaining would be
  // decremented twice for one food bank.
  it("does not reopen an item that already finished", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    const crawlSetId = await insertCrawlSet(session, "need", null);
    const params = { crawlSetId, crawlType: "need", foodbankId: 1, url: "https://salisbury.example.org/list/" };
    const itemId = await insertCrawlItem(session, params);
    await finishCrawlItem(session, itemId, null);
    const closedAt = crawlItemRow(itemId).finish;

    expect(await insertCrawlItem(session, params)).toBe(itemId);
    expect(crawlItemRow(itemId).finish).toBe(closedAt);
  });

  // Cardinality in both directions, so a conflict target that had drifted to
  // just (crawl_set_id) or just (foodbank_id) fails here rather than in
  // production: one row per food bank per sweep, and the same food bank gets
  // a fresh row in tomorrow's sweep.
  it("gives every food bank in a sweep its own row, and a fresh row in the next sweep", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    seedFoodbank({ id: 2, slug: "amesbury" });
    const today = await insertCrawlSet(session, "need", "needcheck-2026-09-05T07:45");
    const tomorrow = await insertCrawlSet(session, "need", "needcheck-2026-09-06T07:45");

    const a = await insertCrawlItem(session, { crawlSetId: today, crawlType: "need", foodbankId: 1, url: null });
    const b = await insertCrawlItem(session, { crawlSetId: today, crawlType: "need", foodbankId: 2, url: null });
    const c = await insertCrawlItem(session, { crawlSetId: tomorrow, crawlType: "need", foodbankId: 1, url: null });

    expect(new Set([a, b, c]).size).toBe(3);
    expect(db.prepare("SELECT COUNT(*) AS n FROM crawlitem").get()).toEqual({ n: 3 });
  });

  // THIS FUNCTION IS NOT THE NEEDCHECK PIPELINE'S ALONE. queues/charity.ts:48
  // opens a "charity" item with a null url, and queues/articles.ts:54 opens an
  // "article" item with the food bank's rss_url -- so crawl_type is a bind,
  // not the constant every other test in this block happens to pass. A
  // statement that hardcoded 'need' survived this file's first draft: it
  // throws nothing, and the damage is that /admin/jobs/ renders every charity
  // and article crawl with the need icon (CRAWL_TYPE_ICONS keys on this
  // column) while the crawl sets page counts them under the wrong type.
  it("stores the crawl type it was given, and a null url", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    const crawlSetId = await insertCrawlSet(session, "charity", null);

    const itemId = await insertCrawlItem(session, { crawlSetId, crawlType: "charity", foodbankId: 1, url: null });

    expect(crawlItemRow(itemId)).toMatchObject({ crawl_type: "charity", url: null });
  });

  // A HAZARD, PINNED, not a bug today. crawlitem_crawlset_foodbank_uniq is
  // (crawl_set_id, foodbank_id) and does NOT include crawl_type, so two
  // different crawls of the same food bank inside ONE crawl set silently
  // collapse into a single row: the second gets the first's id, keeps the
  // first's crawl_type, and closing "it" closes the other crawl's item. That
  // is unreachable today because every crawl set is created for exactly one
  // crawl type (scheduled/index.ts, foodbankForceCrawl.ts:61/:89/:113 all
  // create their own), and it is written down here so that the day someone
  // reuses one crawl set for two crawl types, this test says so out loud
  // instead of the loss being discovered from a wrong item_count.
  it("collapses two crawl types in one crawl set onto a single row", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    const crawlSetId = await insertCrawlSet(session, "need", null);

    const need = await insertCrawlItem(session, { crawlSetId, crawlType: "need", foodbankId: 1, url: "https://example.org/list/" });
    const article = await insertCrawlItem(session, { crawlSetId, crawlType: "article", foodbankId: 1, url: "https://example.org/feed/" });

    expect(article).toBe(need);
    expect(crawlItemRow(need).crawl_type).toBe("need");
    expect(db.prepare("SELECT COUNT(*) AS n FROM crawlitem").get()).toEqual({ n: 1 });
  });
});

describe("finishCrawlItem", () => {
  async function openItem(foodbankId = 1): Promise<{ crawlSetId: number; itemId: number }> {
    seedFoodbank({ id: foodbankId, slug: `fb-${foodbankId}` });
    const crawlSetId = await insertCrawlSet(session, "need", null);
    const itemId = await insertCrawlItem(session, { crawlSetId, crawlType: "need", foodbankId, url: "https://example.org/list/" });
    return { crawlSetId, itemId };
  }

  // `WHERE ... AND finish IS NULL`, never `finish = NULL`: the latter is
  // UNKNOWN for every row in SQLite, so it would match nothing, this would
  // return false on the FIRST call, and needcheckRender.ts's finish() would
  // then skip updateFoodbankLastNeedCheck and decrementCrawlSetRemaining for
  // every food bank -- no error, no log, just a sweep that never closes and a
  // last_need_check that never moves.
  it("stamps finish and need_id on a fresh item, and reports true", async () => {
    const { itemId } = await openItem();
    seedNeed({ id: 41, foodbankId: 1, created: "2026-09-05 15:00:00.000000", published: 0 });

    const before = pyNow();
    expect(await finishCrawlItem(session, itemId, 41)).toBe(true);
    const after = pyNow();

    const row = crawlItemRow(itemId);
    expect(row.need_id).toBe(41);
    expectStampedNow(row.finish, before, after);
  });

  // THE DOUBLE-DECREMENT GUARD. A queue message redelivered after its
  // original attempt committed must report false here, so the caller skips
  // the counter decrement. Both the returned boolean and the untouched
  // columns are asserted: a second stamp would also rewrite `finish` and
  // `need_id`, quietly re-dating the audit trail and detaching the need this
  // crawl actually produced.
  it("reports false on a second call and changes nothing", async () => {
    const { itemId } = await openItem();
    seedNeed({ id: 41, foodbankId: 1, created: "2026-09-05 15:00:00.000000", published: 0 });
    await finishCrawlItem(session, itemId, 41);
    const closed = crawlItemRow(itemId);

    expect(await finishCrawlItem(session, itemId, null)).toBe(false);
    expect(crawlItemRow(itemId)).toEqual(closed);
  });

  // The no-change path, which is the overwhelming majority of every sweep:
  // the page was read, nothing changed, no FoodbankChange was written. The
  // item still has to close -- a null need_id must not be read as "nothing to
  // do here".
  it("closes an item that produced no need", async () => {
    const { itemId } = await openItem();

    expect(await finishCrawlItem(session, itemId, null)).toBe(true);
    expect(crawlItemRow(itemId).need_id).toBeNull();
  });

  it("reports false for an item id that does not exist", async () => {
    expect(await finishCrawlItem(session, 404, null)).toBe(false);
  });

  it("closes only the item it names", async () => {
    const mine = await openItem(1);
    const other = await insertCrawlItem(session, { crawlSetId: mine.crawlSetId, crawlType: "need", foodbankId: 2, url: null });

    await finishCrawlItem(session, mine.itemId, null);

    expect(crawlItemRow(other)).toMatchObject({ finish: null, need_id: null });
  });

  // THE INVARIANT THE WHOLE BOOKKEEPING EXISTS FOR, run end to end across the
  // three functions that implement it: a food bank whose message is delivered
  // twice is counted once. Any one of the three parts failing -- the upsert
  // returning a new id, finishCrawlItem re-stamping, or the `remaining > 0`
  // guard missing -- shows up here as a counter that has run twice.
  it("counts a redelivered food bank exactly once", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    const crawlSetId = await insertCrawlSet(session, "need", "needcheck-2026-09-05T07:45");
    await setCrawlSetExpected(session, crawlSetId, 2);
    const params = { crawlSetId, crawlType: "need", foodbankId: 1, url: "https://example.org/list/" };

    // First delivery: opens, closes, decrements.
    const firstId = await insertCrawlItem(session, params);
    expect(await finishCrawlItem(session, firstId, null)).toBe(true);
    await decrementCrawlSetRemaining(session, crawlSetId);

    // Redelivery of the SAME logical message, post-commit.
    const secondId = await insertCrawlItem(session, params);
    expect(secondId).toBe(firstId);
    expect(await finishCrawlItem(session, secondId, null)).toBe(false);
    // needcheckRender.ts's finish() returns here without decrementing.

    expect(crawlSetRow(crawlSetId)).toMatchObject({ remaining: 1, finish: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM crawlitem").get()).toEqual({ n: 1 });
  });
});

// ---------------------------------------------------------------------------
// getLastPublishedNeed -- crawlers.py:404-407
// ---------------------------------------------------------------------------

describe("getLastPublishedNeed", () => {
  // Django's `.latest("created")` is ORDER BY created DESC LIMIT 1. THREE
  // columns are deliberately made to disagree here, because in production all
  // three agree (rows are appended and never touched again) and a fixture that
  // let them agree would bless the wrong one forever:
  //   * `id` is SHUFFLED, and specifically the newest row holds neither the
  //     highest nor the lowest id -- which is what it takes to kill `ORDER BY
  //     id` in BOTH directions at once, and, on a view with no rowid to fall
  //     back on, an ORDER BY dropped altogether;
  //   * `modified` is INVERTED against created -- the oldest need is the one
  //     edited most recently, which is what a reviewer reopening an old need
  //     in the admin really produces. `ORDER BY modified DESC` survived this
  //     file's first draft, and it is not a cosmetic difference: it would feed
  //     the change comparison a months-old list as "what the site currently
  //     says", so a genuine change would be missed and a stale one re-filed.
  // The month/day boundary is in there because these are TEXT comparisons: a
  // format that dropped its leading zeros would put "2026-9-9" after
  // "2026-10-01".
  it("returns the newest published need, ordered by created -- not by id, and not by modified", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    seedNeed({ id: 2, foodbankId: 1, created: "2026-10-01 15:00:00.000000", modified: "2026-10-01 15:00:00.000000", published: 1, changeText: "Newest" });
    seedNeed({ id: 3, foodbankId: 1, created: "2026-09-09 15:00:00.000000", modified: "2026-11-20 09:00:00.000000", published: 1, changeText: "Middle" });
    seedNeed({ id: 1, foodbankId: 1, created: "2026-09-05 15:00:00.000000", modified: "2026-12-24 09:00:00.000000", published: 1, changeText: "Oldest" });

    expect((await getLastPublishedNeed(session, 1))!.change_text).toBe("Newest");
  });

  // `published = 1` is the difference between "what the site currently says
  // this food bank needs" and "what a reviewer has not looked at yet". Drop it
  // and every scrape would be compared against the previous scrape rather than
  // against the published need -- so a genuine change that a reviewer had not
  // yet approved would stop being re-detected, and the review queue would
  // quietly go empty.
  it("ignores unpublished needs, however new", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    seedNeed({ id: 1, foodbankId: 1, created: "2026-09-05 15:00:00.000000", published: 1, changeText: "Published" });
    seedNeed({ id: 2, foodbankId: 1, created: "2026-09-06 15:00:00.000000", published: 0, changeText: "Awaiting review" });
    seedNeed({ id: 3, foodbankId: 1, created: "2026-09-07 15:00:00.000000", published: 0, changeText: "Also awaiting" });

    expect((await getLastPublishedNeed(session, 1))!.change_text).toBe("Published");
  });

  // The other food bank's rows are NEWER, so a missing foodbank_id predicate
  // would return them -- and the consumer would then compare Salisbury's
  // scraped list against Amesbury's published need, declare a change, and file
  // a review-queue row proposing to replace one food bank's needs with
  // another's.
  it("is scoped to the food bank", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    seedFoodbank({ id: 2, slug: "amesbury" });
    seedNeed({ id: 1, foodbankId: 1, created: "2026-09-05 15:00:00.000000", published: 1, changeText: "Salisbury list" });
    seedNeed({ id: 2, foodbankId: 2, created: "2026-09-06 15:00:00.000000", published: 1, changeText: "Amesbury list" });

    expect((await getLastPublishedNeed(session, 1))!.change_text).toBe("Salisbury list");
    expect((await getLastPublishedNeed(session, 2))!.change_text).toBe("Amesbury list");
  });

  // Django's `FoodbankChange.DoesNotExist` branch. The consumer reads this
  // null as "First need" and treats any scraped list as a change
  // (crawlers.py:520-524), so returning a row here for a food bank that has
  // none would suppress a brand-new food bank's first ever need.
  it("returns null for a food bank with no published need", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    seedNeed({ id: 1, foodbankId: 1, created: "2026-09-05 15:00:00.000000", published: 0 });

    expect(await getLastPublishedNeed(session, 1)).toBeNull();
  });

  // The sentinels are contract (PLAN.md §7): 'Nothing' means "checked, needs
  // nothing", 'Facebook'/'Unknown' are legacy placeholders. Django's queryset
  // excludes none of them, and the S6 empty-extraction safeguard depends on
  // seeing them -- it asks "is there an existing published need with text?"
  // before deciding an empty scrape is a failed render.
  it("returns a sentinel need like every other published need", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    seedNeed({ id: 1, foodbankId: 1, created: "2026-09-05 15:00:00.000000", published: 1, changeText: "Nothing" });

    expect((await getLastPublishedNeed(session, 1))!.change_text).toBe("Nothing");
  });

  // mapNeedRow's coerceBooleans, on the real integers SQLite hands back. The
  // three-state distinction is the point: NULL is NOT false. 18,943 legacy
  // rows have nonpertinent IS NULL, and needAdmin.ts's queue filters on
  // `nonpertinent = 0`, so a coercion that turned NULL into false here would
  // make this module disagree with the queue about which rows exist.
  it("coerces the flag columns to booleans and keeps NULL as null", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    seedNeed({ id: 1, foodbankId: 1, created: "2026-09-05 15:00:00.000000", published: 1, nonpertinent: null, isCategorised: 0 });

    const need = await getLastPublishedNeed(session, 1);
    expect(need!.published).toBe(true);
    expect(need!.nonpertinent).toBeNull();
    expect(need!.is_categorised).toBe(false);
  });

  // MIGRATION 0019'S SCAR, tested rather than described. foodbankchange lost
  // its cached `foodbank_name` column, so this query reads the view
  // (foodbankchange_full), whose LEFT JOIN supplies the parent's name and slug
  // live. Renaming the parent and re-reading is what proves it: a denormalised
  // copy would still say "Salisbury". A query pointed back at the base table
  // would not throw either -- it would just return a row with no foodbank_name
  // at all.
  it("reads the parent's name and slug live through the view", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", name: "Salisbury Foodbank" });
    seedNeed({ id: 1, foodbankId: 1, created: "2026-09-05 15:00:00.000000", published: 1 });

    const before = await getLastPublishedNeed(session, 1);
    expect(before!.foodbank_name).toBe("Salisbury Foodbank");
    expect((before as unknown as Record<string, unknown>).foodbank_slug).toBe("salisbury");

    db.prepare("UPDATE foodbank SET name = 'Salisbury & District Foodbank', slug = 'salisbury-district' WHERE id = 1").run();

    const after = await getLastPublishedNeed(session, 1);
    expect(after!.foodbank_name).toBe("Salisbury & District Foodbank");
    expect((after as unknown as Record<string, unknown>).foodbank_slug).toBe("salisbury-district");
  });

  // The view's join is LEFT, so a need whose food bank row was deleted still
  // comes back (with a null name) rather than vanishing. D1 declares no
  // foreign keys (PLAN.md §4.5), so this state is reachable -- and an INNER
  // join here would make the pipeline treat an orphaned food bank's next
  // scrape as a first need.
  it("still returns a need whose food bank row is gone", async () => {
    seedNeed({ id: 1, foodbankId: 99, created: "2026-09-05 15:00:00.000000", published: 1, changeText: "Orphaned" });

    const need = await getLastPublishedNeed(session, 99);
    expect(need!.change_text).toBe("Orphaned");
    expect(need!.foodbank_name).toBeNull();
  });

  // LIMIT 1 means one row, even when the ORDER BY cannot break the tie. Two
  // needs sharing a `created` to the microsecond is reachable (a double-click
  // in the admin, or a redelivery that slipped both guards), and Django's own
  // `.latest()` resolved that tie arbitrarily too. WHICH row comes back is
  // deliberately not asserted -- that depends on the index SQLite picks, and
  // pinning it would be pinning the query planner.
  it("returns exactly one row when two published needs share a created time", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    seedNeed({ id: 1, foodbankId: 1, created: "2026-09-05 15:00:00.000000", published: 1, changeText: "One" });
    seedNeed({ id: 2, foodbankId: 1, created: "2026-09-05 15:00:00.000000", published: 1, changeText: "Two" });

    const need = await getLastPublishedNeed(session, 1);
    expect(["One", "Two"]).toContain(need!.change_text);
  });

  // THE FORMAT HAZARD, pinned deliberately with the one ISO row this file
  // contains. `created` is TEXT and this ORDER BY is a byte comparison, so a
  // single toISOString() value ('T' = 0x54) outranks EVERY Django-format row
  // (' ' = 0x20) from the same day -- an 08:00 row beating a 20:00 row. That
  // is not cosmetic: it is the wrong "last published need" fed into the change
  // comparison, and therefore a change detected or missed on the wrong
  // baseline. It is why insertFoodbankChange writes pyNow() and why migration
  // 0022 rewrote the imported rows; this test is what would fail if anything
  // in this pipeline switched to toISOString().
  it("would rank an ISO-format created above every same-day Django one", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    seedNeed({ id: 1, foodbankId: 1, created: "2026-09-05 20:00:00.000000", published: 1, changeText: "Actually newest" });
    seedNeed({ id: 2, foodbankId: 1, created: "2026-09-05T08:00:00.000Z", published: 1, changeText: "ISO intruder" });

    expect((await getLastPublishedNeed(session, 1))!.change_text).toBe("ISO intruder");
  });
});

// ---------------------------------------------------------------------------
// getLastUnpublishedNeeds -- crawlers.py:484's [:10] suppression window
// ---------------------------------------------------------------------------

describe("getLastUnpublishedNeeds", () => {
  // Ids SHUFFLED and `modified` INVERTED, for the reasons spelled out on
  // getLastPublishedNeed's first test. This statement's draft was weaker than
  // that one and three separate mutants lived here: `ORDER BY id ASC`, `ORDER
  // BY modified DESC`, and the ORDER BY deleted outright -- all three survived
  // an ids-ascend-as-created-descends fixture, because in it every one of them
  // produces the same answer as `ORDER BY created DESC`. Getting this window's
  // order wrong is not cosmetic: it is the dedup window (§8.5.5), so the wrong
  // ten rows means the same rejected wording is filed into the review queue
  // again on every single sweep.
  it("returns the newest unpublished needs first, ordered by created -- not by id, and not by modified", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    seedNeed({ id: 2, foodbankId: 1, created: "2026-10-01 15:00:00.000000", modified: "2026-10-01 15:00:00.000000", published: 0, changeText: "Newest" });
    seedNeed({ id: 3, foodbankId: 1, created: "2026-09-09 15:00:00.000000", modified: "2026-11-20 09:00:00.000000", published: 0, changeText: "Middle" });
    seedNeed({ id: 1, foodbankId: 1, created: "2026-09-05 15:00:00.000000", modified: "2026-12-24 09:00:00.000000", published: 0, changeText: "Oldest" });

    const needs = await getLastUnpublishedNeeds(session, 1, 10);
    expect(needs.map((n) => n.change_text)).toEqual(["Newest", "Middle", "Oldest"]);
  });

  // THE LIMIT IS THE DEDUP WINDOW (§8.5.5), so it has to cap the NEWEST rows,
  // not the oldest. Twelve rows, window of ten: if the LIMIT ran before the
  // sort, the window would hold the twelve-days-ago rejections instead of
  // yesterday's, the same rejected wording would fail to match, and every
  // re-scrape would file another identical row into the review queue --
  // forever.
  //
  // The ids are a SHUFFLE, not a sequence, so that "newest ten" and "lowest
  // ten ids" are different sets of rows. Written as an ascending run (id 1
  // newest, id 12 oldest) this test passed just as happily with `ORDER BY id
  // ASC` or with no ORDER BY at all, which is what the first draft did.
  const BY_CREATED_DESC = [4, 11, 2, 9, 6, 1, 12, 7, 3, 10, 5, 8];
  it("keeps the newest rows when the window is full", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    BY_CREATED_DESC.forEach((id, rank) => {
      // rank 0 is the newest; the day counts down as the rank rises.
      const day = String(30 - rank).padStart(2, "0");
      seedNeed({ id, foodbankId: 1, created: `2026-09-${day} 15:00:00.000000`, published: 0, changeText: `Need ${id}` });
    });

    const needs = await getLastUnpublishedNeeds(session, 1, 10);
    expect(needs.map((n) => n.id)).toEqual(BY_CREATED_DESC.slice(0, 10));
  });

  // Published rows are the ones a reviewer ACCEPTED. If they leaked into this
  // window, a scrape matching the currently-published need would be marked
  // "Nonpub same" -- nonpertinent -- and a food bank returning to a list it
  // published a month ago would silently never be re-published.
  it("excludes published needs", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    seedNeed({ id: 1, foodbankId: 1, created: "2026-09-07 15:00:00.000000", published: 1, changeText: "Published" });
    seedNeed({ id: 2, foodbankId: 1, created: "2026-09-06 15:00:00.000000", published: 0, changeText: "Rejected once" });

    const needs = await getLastUnpublishedNeeds(session, 1, 10);
    expect(needs.map((n) => n.change_text)).toEqual(["Rejected once"]);
  });

  // Scoping, with the other food bank's rows both NEWER and NUMEROUS enough to
  // fill the window on their own -- a missing foodbank_id predicate would
  // return ten of Amesbury's rows and none of Salisbury's, and Salisbury's
  // genuine repeat would stop being suppressed while Amesbury's wording
  // started suppressing Salisbury's.
  //
  // BOTH food banks are asked, in both directions. Every other test in this
  // block queries food bank 1, so a statement whose `?1` had decayed into a
  // literal `foodbank_id = 1` -- a plausible artefact of debugging a query by
  // hand -- passed the whole draft suite, including this one when it only
  // asked about Salisbury. Asking Amesbury for its own window is what makes
  // the bind a bind.
  it("is scoped to the food bank, in both directions, even when another could fill the window", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    seedFoodbank({ id: 2, slug: "amesbury" });
    for (let i = 1; i <= 10; i++) {
      seedNeed({ id: i, foodbankId: 2, created: `2026-10-${String(i).padStart(2, "0")} 15:00:00.000000`, published: 0, changeText: `Amesbury ${i}` });
    }
    seedNeed({ id: 20, foodbankId: 1, created: "2026-09-05 15:00:00.000000", published: 0, changeText: "Salisbury only" });

    expect((await getLastUnpublishedNeeds(session, 1, 10)).map((n) => n.change_text)).toEqual(["Salisbury only"]);
    // Amesbury's own window: its ten rows, newest first, and none of
    // Salisbury's -- which is also a second, independent reading of the
    // ORDER BY over a full window.
    expect((await getLastUnpublishedNeeds(session, 2, 10)).map((n) => n.id)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  });

  // The binds are [foodbankId, limit] against `foodbank_id = ?1 ... LIMIT ?2`.
  // Transposing them binds the food bank id to LIMIT, which SQLite accepts --
  // it would return the first `foodbankId` rows of whichever food bank has id
  // `limit`, quietly, with no error. Asking for fewer rows than exist is what
  // makes that visible.
  it("applies the limit to this food bank's rows", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    // Ids shuffled again: with them in created order, "the first two rows" and
    // "the two newest rows" are the same two, and the LIMIT would look right
    // even applied to an unsorted read.
    seedNeed({ id: 3, foodbankId: 1, created: "2026-09-07 15:00:00.000000", published: 0, changeText: "Newest" });
    seedNeed({ id: 1, foodbankId: 1, created: "2026-09-06 15:00:00.000000", published: 0, changeText: "Middle" });
    seedNeed({ id: 2, foodbankId: 1, created: "2026-09-05 15:00:00.000000", published: 0, changeText: "Oldest" });

    expect((await getLastUnpublishedNeeds(session, 1, 2)).map((n) => n.change_text)).toEqual(["Newest", "Middle"]);
  });

  it("returns an empty array for a food bank with nothing unpublished", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    seedNeed({ id: 1, foodbankId: 1, created: "2026-09-05 15:00:00.000000", published: 1 });

    expect(await getLastUnpublishedNeeds(session, 1, 10)).toEqual([]);
  });

  // The dedup comparison reads change_text AND excess_change_text, and the
  // excess column is nullable -- 0001_core.sql declares it so, and the migrated
  // Django rows use NULL where this port's own writer uses "". A NULL that
  // arrived as the string "null" (or as undefined) would make every comparison
  // against a legacy row fail, so the suppression window would stop suppressing
  // exactly the oldest rows in it.
  //
  // TWO ROWS, and both of them checked. mapNeedRow runs per row inside a
  // .map(), so a mapping applied to only part of the result is a live shape --
  // and a draft that read `[0]` alone could not see it. The window's OLDER
  // rows are the legacy ones (`nonpertinent` NULL, excess NULL), so a mapping
  // that quietly stopped after the first row would break exactly the
  // comparisons this window exists to make.
  it("hands back a NULL excess as null, and the booleans as booleans, for every row", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    seedNeed({ id: 1, foodbankId: 1, created: "2026-09-06 15:00:00.000000", published: 0, excessChangeText: "Pasta", nonpertinent: 1 });
    seedNeed({ id: 2, foodbankId: 1, created: "2026-09-05 15:00:00.000000", published: 0, excessChangeText: null, nonpertinent: null });

    const needs = await getLastUnpublishedNeeds(session, 1, 10);
    expect(needs.map((n) => n.excess_change_text)).toEqual(["Pasta", null]);
    expect(needs.map((n) => n.published)).toEqual([false, false]);
    expect(needs.map((n) => n.nonpertinent)).toEqual([true, null]);
  });

  // Same view, same 0019 reasoning as getLastPublishedNeed: the parent's name
  // is joined, not stored. Kept as its own assertion because these are two
  // separate statements and only one of them was checked above.
  it("reads the parent's name live through the view", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", name: "Salisbury Foodbank" });
    seedNeed({ id: 1, foodbankId: 1, created: "2026-09-05 15:00:00.000000", published: 0 });
    db.prepare("UPDATE foodbank SET name = 'Renamed Foodbank' WHERE id = 1").run();

    expect((await getLastUnpublishedNeeds(session, 1, 10))[0]!.foodbank_name).toBe("Renamed Foodbank");
  });
});

// ---------------------------------------------------------------------------
// insertFoodbankChange -- crawlers.py:540-549, the review queue's only writer
// ---------------------------------------------------------------------------

describe("insertFoodbankChange", () => {
  const PARAMS = {
    foodbankId: 1,
    uri: "https://salisbury.foodbank.org.uk/give-help/donate-food/",
    changeText: "Tinned Tomatoes\nUHT Milk",
    excessChangeText: "Baked Beans",
  };

  it("writes every column the review queue reads, and returns the new row's id", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });

    const before = pyNow();
    const id = await insertFoodbankChange(session, PARAMS);
    const after = pyNow();

    const row = changeRow(id);
    expect(row).toMatchObject({
      foodbank_id: 1,
      uri: PARAMS.uri,
      // The _original pair is written from the SAME bind (?4 / ?5): Django
      // stored the untouched extraction alongside the editable text so a
      // reviewer's rewording can always be compared with what was scraped.
      // A statement that bound them separately could drift.
      change_text: PARAMS.changeText,
      change_text_original: PARAMS.changeText,
      excess_change_text: PARAMS.excessChangeText,
      excess_change_text_original: PARAMS.excessChangeText,
      input_method: "ai",
      published: 0,
      nonpertinent: 0,
      is_categorised: 0,
      // Untouched by this writer, and NOT defaulted to "": distill_id is the
      // old scraper's id and `name` is a human label, both meaningless here.
      distill_id: null,
      name: null,
      notified: null,
    });
    expectStampedNow(row.created, before, after);
    // created and modified come from ONE pyNow() call bound twice (?6), so a
    // brand-new need must not look edited.
    expect(row.modified).toBe(row.created);
  });

  // PLAN.md §8.5.3'S OWN WARNING, executed. `nonpertinent = 0` in SQL EXCLUDES
  // NULL, and needAdmin.ts:34's review queue is exactly
  // `WHERE published = 0 AND nonpertinent = 0`. So writing NULL here -- by
  // leaving the column to its (absent) default -- would put every new need in
  // the table and none of them in front of a reviewer: no error, no empty
  // page, just a queue that stops growing while the crawl looks healthy. The
  // legacy row seeded alongside is one of the 18,943 that really are NULL, and
  // it is there to show the predicate is doing real work.
  it("writes explicit 0s, so the new need actually lands in the review queue", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    seedNeed({ id: 500, foodbankId: 1, created: "2020-01-01 00:00:00.000000", published: 0, nonpertinent: null });

    const id = await insertFoodbankChange(session, PARAMS);

    const queue = db.prepare("SELECT id FROM foodbankchange WHERE published = 0 AND nonpertinent = 0 ORDER BY created DESC").all();
    expect(queue).toEqual([{ id }]);
  });

  // need_id is the public identifier: /admin/need/<uuid>/ and the API's
  // `?need_id=` both key on it, getNeedByUuid normalises dashed input to this
  // dashless form, and need_need_id_uniq is UNIQUE -- so a constant or a
  // dashed value would either collide on the second need of the day or route
  // to nothing.
  it("gives each need a fresh 32-character dashless uuid", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });

    const first = changeRow(await insertFoodbankChange(session, PARAMS));
    const second = changeRow(await insertFoodbankChange(session, PARAMS));

    expect(first.need_id).toMatch(/^[0-9a-f]{32}$/);
    expect(second.need_id).toMatch(/^[0-9a-f]{32}$/);
    expect(first.need_id).not.toBe(second.need_id);
  });

  // The round trip that matters most, through this module's own readers: what
  // stage 10 writes is what the NEXT check's suppression window reads, and it
  // must NOT become the "last published need" until a human publishes it.
  // Testing the write with the reader beside it is what catches a `published`
  // written as 1, which no column-by-column assertion of the write alone would
  // describe as a live incident (a scraped list on the public site, unreviewed).
  it("lands in the suppression window and not in the published baseline", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });

    const id = await insertFoodbankChange(session, PARAMS);

    const unpublished = await getLastUnpublishedNeeds(session, 1, 10);
    expect(unpublished.map((n) => n.id)).toEqual([id]);
    expect(unpublished[0]!.change_text).toBe(PARAMS.changeText);
    expect(await getLastPublishedNeed(session, 1)).toBeNull();
  });

  // foodbank_id AND uri are binds, proven by writing two needs that differ in
  // both and reading each back. Every other test in this block writes the same
  // PARAMS for food bank 1, so hardcoding EITHER value into the VALUES list --
  // `1` for the food bank, or the literal donate-food URL -- survived the
  // whole draft suite. Both are live failures with no exception attached: a
  // fixed foodbank_id files every scraped list against one food bank (whose
  // published needs then get replaced by other people's), and a fixed uri
  // breaks the "where did this come from" link the reviewer decides on.
  it("keeps each need's own food bank and source url", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    seedFoodbank({ id: 42, slug: "amesbury" });

    const salisbury = await insertFoodbankChange(session, PARAMS);
    const amesbury = await insertFoodbankChange(session, {
      foodbankId: 42,
      uri: "https://amesbury.foodbank.org.uk/donate/",
      changeText: "Nappies\nTea Bags",
      excessChangeText: "",
    });

    expect(changeRow(salisbury)).toMatchObject({ foodbank_id: 1, uri: PARAMS.uri, change_text: PARAMS.changeText });
    expect(changeRow(amesbury)).toMatchObject({
      foodbank_id: 42,
      uri: "https://amesbury.foodbank.org.uk/donate/",
      change_text: "Nappies\nTea Bags",
    });
    // ...and the readers agree about which food bank owns which, so a wrong
    // foodbank_id could not hide behind a correct-looking write.
    expect((await getLastUnpublishedNeeds(session, 42, 10)).map((n) => n.id)).toEqual([amesbury]);
    expect((await getLastUnpublishedNeeds(session, 1, 10)).map((n) => n.id)).toEqual([salisbury]);
  });

  // The empty-excess case, which is most of them: the decision code hands over
  // "" when the model found no surplus items, and it is stored as "" rather
  // than folded to NULL. Pinned because the two are different values to the
  // dedup comparison and to `excess_change_text IS NOT NULL` filters -- and
  // because the legacy Django rows really do hold NULL here, so both shapes
  // exist in the table on purpose.
  it("stores an empty excess as an empty string, not as NULL", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });

    const id = await insertFoodbankChange(session, { ...PARAMS, excessChangeText: "" });

    expect(changeRow(id)).toMatchObject({ excess_change_text: "", excess_change_text_original: "" });
  });
});

// ---------------------------------------------------------------------------
// insertFoodbankDiscrepancy -- needs.py:28-47
// ---------------------------------------------------------------------------

describe("insertFoodbankDiscrepancy", () => {
  it("writes a New discrepancy against a food bank and returns its id", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });

    const before = pyNow();
    const id = await insertFoodbankDiscrepancy(session, {
      foodbankId: 1,
      url: "https://salisbury.foodbank.org.uk/",
      discrepancyType: "website",
      discrepancyText: "Website https://salisbury.foodbank.org.uk/ render failed",
    });
    const after = pyNow();

    const row = discrepancyRow(id);
    expect(row).toMatchObject({
      foodbank_id: 1,
      url: "https://salisbury.foodbank.org.uk/",
      discrepancy_type: "website",
      discrepancy_text: "Website https://salisbury.foodbank.org.uk/ render failed",
      // 'New', with that capital N: needAdmin.ts:73's dashboard panel is
      // `WHERE status = 'New'` and SQLite's = is case-sensitive, so a lower-
      // case 'new' would file the discrepancy into a status nothing lists.
      status: "New",
      // Neither needcheck call site attaches a discrepancy to a particular
      // FoodbankChange (crawlers.py:311-333 and :486-514 both leave `need`
      // unset), so this stays NULL rather than pointing at an unrelated row.
      need_id: null,
    });
    expectStampedNow(row.created, before, after);
    expect(row.modified).toBe(row.created);
  });

  // The cron-level discrepancy: scheduled/index.ts:132 records a partial
  // enqueue failure that belongs to no single food bank. It is the ONLY record
  // that food banks were skipped that day, so both halves have to hold -- the
  // NULL foodbank_id must be writable, and the row must still surface through
  // foodbankdiscrepancy_full, whose LEFT JOIN is what keeps it visible. An
  // INNER join there would silently hide exactly the failures nobody else
  // reports.
  it("accepts a NULL food bank, and the row still surfaces through the view", async () => {
    const id = await insertFoodbankDiscrepancy(session, {
      foodbankId: null,
      url: null,
      discrepancyType: "website",
      discrepancyText: "needcheck: 100 food bank(s) across 1 chunk(s) failed to enqueue and were not crawled today",
    });

    expect(discrepancyRow(id)).toMatchObject({ foodbank_id: null, url: null });
    const viaView = db.prepare("SELECT * FROM foodbankdiscrepancy_full WHERE status = 'New' ORDER BY created DESC").all() as Record<
      string,
      unknown
    >[];
    expect(viaView.map((r) => r.id)).toEqual([id]);
    expect(viaView[0]!.foodbank_name).toBeNull();
  });

  // MIGRATION 0019 AGAIN: `ALTER TABLE foodbankdiscrepancy DROP COLUMN
  // foodbank_name`. Django's FoodbankDiscrepancy.save() copied the parent's
  // name into the row (models/needs.py:43-46); this writer does not, and must
  // not -- the name now comes from the view's join. Renaming the parent and
  // re-reading is the proof, and it is also why a hand-written fixture would
  // have been useless here: it would probably still have had the column.
  it("takes the food bank's name from the join, never from a stored copy", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", name: "Salisbury Foodbank" });
    const id = await insertFoodbankDiscrepancy(session, {
      foodbankId: 1,
      url: null,
      discrepancyType: "website",
      discrepancyText: "Empty needs extracted despite an existing published need",
    });

    db.prepare("UPDATE foodbank SET name = 'Salisbury & District Foodbank' WHERE id = 1").run();

    const row = db.prepare("SELECT foodbank_name, foodbank_slug FROM foodbankdiscrepancy_full WHERE id = ?").get(id);
    expect(row).toEqual({ foodbank_name: "Salisbury & District Foodbank", foodbank_slug: "salisbury" });
  });

  // discrepancy_type is free TEXT, not an enum (0008_needcheck.sql's own
  // note): DISCREPANCY_TYPES (const/general.py:44-52 -- postcode, address,
  // phone, email, charity_number, need, website) is an app-level allowlist.
  // The value is stored verbatim rather than normalised, and the admin's
  // filter is an equality on this column.
  //
  // TWO DIFFERENT TYPES, because all four of today's callers
  // (needcheckRender.ts:57 and :118, needcheckRenderDlq.ts:26,
  // scheduled/index.ts:135) pass "website" -- so a statement that had baked
  // 'website' into its VALUES list would be indistinguishable from a correct
  // one, and it survived the draft suite for exactly that reason. A test that
  // only ever passes the one value it expects back is not testing the bind at
  // all; it would hand the next caller to reach for this helper (the admin's
  // own discrepancy writers use the other six types) a silent rewrite of
  // whatever it asked for into "website".
  it("stores the discrepancy type it was given, not a hardcoded one", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });

    const website = await insertFoodbankDiscrepancy(session, {
      foodbankId: 1,
      url: null,
      discrepancyType: "website",
      discrepancyText: "Need check failed: OpenRouter 402",
    });
    const need = await insertFoodbankDiscrepancy(session, {
      foodbankId: 1,
      url: null,
      discrepancyType: "need",
      discrepancyText: "Empty needs extracted despite an existing published need",
    });

    expect(discrepancyRow(website).discrepancy_type).toBe("website");
    expect(discrepancyRow(need).discrepancy_type).toBe("need");
  });
});

// ---------------------------------------------------------------------------
// updateFoodbankLastNeedCheck
// ---------------------------------------------------------------------------

describe("updateFoodbankLastNeedCheck", () => {
  it("stamps the timestamp on the food bank it names", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", lastNeedCheck: "2026-09-04 07:50:00.000000" });

    await updateFoodbankLastNeedCheck(session, 1, "2026-09-05 07:52:13.417000");

    expect(foodbankRow(1).last_need_check).toBe("2026-09-05 07:52:13.417000");
  });

  // This one takes its timestamp as an ARGUMENT rather than calling pyNow()
  // itself (needcheckRender.ts:110 passes pyNow()), so the format is the
  // caller's responsibility -- and it is stored verbatim. That matters because
  // adminDashboardStats.ts:59-62 finds the oldest and newest checks with
  // `ORDER BY last_need_check ASC/DESC LIMIT 1` over this TEXT column: one ISO
  // value would sort above every Django-format row and pin that food bank at
  // the top of "most recently checked" permanently. The comparison below is
  // done by SQLite, on the stored values, for exactly that reason.
  it("stores the value verbatim, and the stored value sorts chronologically", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", lastNeedCheck: "2026-09-04 07:50:00.000000" });
    seedFoodbank({ id: 2, slug: "amesbury", lastNeedCheck: "2026-09-05 07:50:00.000000" });

    await updateFoodbankLastNeedCheck(session, 1, "2026-09-05 07:52:13.417000");

    const newest = db.prepare("SELECT slug FROM foodbank WHERE last_need_check IS NOT NULL ORDER BY last_need_check DESC LIMIT 1").get();
    expect(newest).toEqual({ slug: "salisbury" });
  });

  it("touches no other food bank", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", lastNeedCheck: null });
    seedFoodbank({ id: 2, slug: "amesbury", lastNeedCheck: "2026-09-04 07:50:00.000000" });

    await updateFoodbankLastNeedCheck(session, 1, "2026-09-05 07:52:13.417000");

    expect(foodbankRow(2).last_need_check).toBe("2026-09-04 07:50:00.000000");
  });

  // PINNED DIVERGENCE. Django reached this through
  // `foodbank.save(do_decache=False, do_geoupdate=False)`, and `modified` is
  // auto_now=True on TimestampedModel -- so every need check bumped the food
  // bank's `modified`, roughly 1,071 rows a day. This statement names one
  // column and leaves `modified` alone, which is the better behaviour (nothing
  // about the food bank's own record changed) but IS a difference: anything
  // reading `modified` as "when did this food bank last change" sees a much
  // quieter table than Django's. Recorded here rather than in a comment alone
  // so that a future change to either side is a deliberate one.
  it("does not bump the food bank's modified, unlike Django's save()", async () => {
    seedFoodbank({ id: 1, slug: "salisbury" });
    const before = foodbankRow(1);

    await updateFoodbankLastNeedCheck(session, 1, "2026-09-05 07:52:13.417000");

    const after = foodbankRow(1);
    expect(after.modified).toBe(before.modified);
    expect(after.edited).toBe(before.edited);
    expect(after.name).toBe(before.name);
  });

  // The food bank was deleted between the scrape and the write. A silent
  // no-op is what the caller wants: needcheckRender.ts's finish() does not
  // check a result here, and a throw would fail the message and have Queues
  // redeliver a crawl whose food bank no longer exists.
  it("is a silent no-op for a food bank that no longer exists", async () => {
    seedFoodbank({ id: 1, slug: "salisbury", lastNeedCheck: "2026-09-04 07:50:00.000000" });

    await expect(updateFoodbankLastNeedCheck(session, 404, "2026-09-05 07:52:13.417000")).resolves.toBeUndefined();
    expect(foodbankRow(1).last_need_check).toBe("2026-09-04 07:50:00.000000");
  });
});
