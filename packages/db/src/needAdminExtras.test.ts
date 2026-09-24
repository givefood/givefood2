import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "./schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getArticlesForNeedEmail, getFoodbankForNeedEmail, insertAdminNeed } from "./needAdminExtras";
import type { Session } from "./types";

// WP 6.8's two need endpoints: /admin/need/new/ (gfadmin/views.py:1916-1946
// need_form's create branch) and /admin/need/:id/email/'s two reads
// (gfadmin/views.py:2023-2038 need_email).
//
// WHY A REAL DATABASE. Every function in this file is one SQL statement and
// nothing else, and every way it can be wrong is SILENT. A `nonpertinent`
// left NULL instead of 0 puts a brand-new need outside the review queue's
// `nonpertinent = 0` and nobody ever sees it. A recompute skipped on an
// unpublished insert leaves `last_need` reading a date from six weeks ago on
// a food bank page. An `ORDER BY` on the wrong spelling of a timestamp puts
// yesterday's news above today's in mail that goes to 5,855 subscribers.
// None of those raise, none of them log, and a mocked session handing back
// canned rows would agree with all three, because the bug would be in the
// SQL and the mock does not run SQL.
//
// THE FIXTURE IS THE MIGRATION FILES THEMSELVES, applied in order, exactly
// as adminDashboardStats.test.ts does and for the same reason: migration
// 0019 dropped `foodbank_name` off six tables and queries elsewhere went on
// naming it, silently, until /dashboard/beautybanks/ was measured and found
// to be a live 500. A hand-copied CREATE TABLE in a test file is a second
// copy of the truth and drifts the same way. Applying the real files means
// this suite fails the way D1 would -- "no such column: foodbank_name" --
// rather than passing against a schema production no longer has.
//
// MUTATION-TESTED, per TESTING.md's convention: the module is broken in a
// scratchpad and this file re-run against each mutant. 47 mutants in the
// latest round, 46 dead -- input_method 'typed' -> 'scrape'; nonpertinent and
// is_categorised each written NULL instead of 0; the recompute deleted, moved
// ahead of the INSERT, left un-awaited, narrowed to Django's published-only
// guard, and pointed at the wrong food bank; published pinned to 1 and to 0;
// pyNow() reverted to toISOString(); change_text/excess_change_text binds
// swapped; need_id/foodbank_id binds swapped; the uuid left dashed, upper-
// cased, and de-dashed without the /g flag; a null foodbank_id coalesced to
// 0; last_row_id read as changes; modified given its own later value; a NULL
// excess written as ""; the INSERT re-naming the foodbank_name column 0019
// dropped; SELECT * on both reads; an is_closed filter and a COALESCE added
// to the food bank read; its WHERE dropped, re-pointed at another column, and
// its parameter replaced by a literal; the articles substr() dropped, started
// at 0, cut to 7 characters, and applied to the cutoff too; >= narrowed to >;
// AND typoed to OR; ORDER BY flipped to ASC, deleted, changed to id, and
// made "consistent" with the WHERE's substr; a LIMIT 20 and a LIMIT 29 added;
// only the first row returned; the foodbank_id filter dropped; a featured
// predicate added in both directions; the two article parameters bound the
// wrong way round; and both text columns concatenated into the SQL instead of
// bound.
//
// ONE survived, and it is a fact about the query rather than a gap: see
// "touches no food bank at all when the need has none".
//
// FOUR of those mutants survived an earlier draft of this file and are the
// reason three fixtures below look the way they do. Each is named at the test
// that now kills it, so nobody deletes the odd-looking detail that does the
// killing: the article ids in the ordering test (ORDER BY deleted, and ORDER
// BY substr(published_date, 1, 10)), the one featured article beside them
// (`WHERE featured = 0`), and the apostrophes in the verbatim-text test
// (change_text concatenated into the statement instead of bound). A fifth
// gap needed a new assertion rather than a new fixture -- the LEFT JOIN in
// foodbankchange_full, in "touches no food bank at all".
//
// Three details of that real schema are load-bearing below:
//   * foodbankchange.nonpertinent and .is_categorised are NULLABLE, which is
//     what makes "explicit 0, not NULL" a claim with consequences;
//   * foodbank.no_donation_points and .alt_name are NULLABLE, which is what
//     makes the email context's `no_donation_points !== 0` reachable;
//   * foodbankchange no longer has foodbank_name (0019), which is what makes
//     the INSERT's column list a thing worth proving rather than assuming.

type Bindable = null | number | bigint | string | Uint8Array;

// The D1 Sessions API surface this package is handed, backed by node:sqlite.
// Copied from articles.test.ts rather than reinvented, and deliberately dumb:
// it forwards the SQL untouched, so the engine decides which rows come back.
//
// `meta.last_row_id` is the engine's own sqlite3_last_insert_rowid(), not a
// counter this file keeps. insertAdminNeed RETURNS that value, and
// needNew.ts hands it straight to the translate queue as the message's
// `needId` -- so "the id it returns is the id of the row it wrote" is a
// claim about SQLite, and a fake that answered `last_row_id: 1` would agree
// with an implementation that returned `meta.changes` by mistake.
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

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

// The instant from pyDatetime.ts's own header, so every timestamp this suite
// expects is written out in full rather than recomputed. A test that rebuilt
// the expectation with the same helper the code uses would pass against any
// helper at all, including the toISOString() the whole ticket-#9 convention
// exists to keep out.
const NOW = new Date("2026-09-05T19:28:08.853Z");
const PY_NOW = "2026-09-05 19:28:08.853000";

// What buildNeedEmailContext (needEmailContext.ts:73) actually passes as
// getArticlesForNeedEmail's cutoff at that instant: ARTICLES_MONTH_DAYS = 28
// days back, sliced to a bare date. Anchored by arithmetic rather than typed
// from memory, because every boundary expectation below hangs off it.
const CUTOFF = "2026-08-08";

let db: DatabaseSync;
let session: Session;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  session = d1Session(db);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Ids deliberately not in slug order, and not 1/2/3, so "ordered by id" and
// "the first row in the table" cannot be accidentally right.
const SALISBURY = 22;
const WESTBURY = 12;
const BATH = 5;

interface FoodbankSeed {
  id: number;
  slug: string;
  name?: string;
  altName?: string | null;
  noDonationPoints?: number | null;
  isClosed?: 0 | 1;
  lastNeed?: string | null;
  latestNeedId?: number | null;
}

// Fills every NOT NULL column nothing here reads, so a call site can say what
// the test is actually about. The five that matter -- name, alt_name,
// no_donation_points, last_need, latest_need_id -- are explicit at each call.
function seedFoodbank({ id, slug, name, altName = null, noDonationPoints = null, isClosed = 0, lastNeed = null, latestNeedId = null }: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank (
       id, uuid, name, alt_name, slug, address, postcode, country, lat_lng,
       charity_just_foodbank, contact_email, url, shopping_list_url,
       address_is_administrative, is_closed, no_locations, no_donation_points,
       days_between_needs, last_need, latest_need_id, created, modified
     ) VALUES (?, ?, ?, ?, ?, '1 High Street', 'SP2 9DY', 'England', '51.0688,-1.7945',
       0, 'info@example.org', 'https://example.org/', 'https://example.org/list/',
       0, ?, 0, ?, 14, ?, ?, '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run(id, `uuid-${id}`, name ?? `${slug} foodbank`, altName, slug, isClosed, noDonationPoints, lastNeed, latestNeedId);
}

// A need row as the ETL and the needcheck pipeline already left them:
// explicit id, Django-format timestamps, `input_method` set. Not written
// through insertAdminNeed, because these stand in for the 21,000 rows that
// were there before this endpoint existed -- the population a newly inserted
// row has to sort correctly against.
function seedNeed(row: { id: number; foodbankId: number | null; created: string; published?: 0 | 1; nonpertinent?: 0 | 1 | null }): void {
  db.prepare(
    `INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, published, nonpertinent, is_categorised, input_method, created, modified)
     VALUES (?, ?, ?, 'Beans', ?, ?, 0, 'scrape', ?, ?)`,
  ).run(row.id, `seeded${row.id}`.padEnd(32, "0"), row.foodbankId, row.published ?? 0, row.nonpertinent ?? 0, row.created, row.created);
}

// `featured` defaults to 0 because that is what the crawler writes
// (articles.ts:67's `VALUES (..., 0)`), but it is a PARAMETER and not a
// literal here on purpose -- see the featured article in the ordering test
// below. A fixture where every row shares a column value cannot test a
// predicate on that column in the direction that drops rows.
function seedArticle(row: { id: number; foodbankId: number | null; publishedDate: string; title?: string; url?: string; featured?: 0 | 1 }): void {
  db.prepare("INSERT INTO foodbankarticle (id, foodbank_id, published_date, title, url, featured) VALUES (?, ?, ?, ?, ?, ?)").run(
    row.id,
    row.foodbankId,
    row.publishedDate,
    row.title ?? `Article ${row.id}`,
    row.url ?? `https://example.org/news/${row.id}/`,
    row.featured ?? 0,
  );
}

function needRow(needId: string): Record<string, unknown> {
  return db.prepare("SELECT * FROM foodbankchange WHERE need_id = ?").get(needId) as Record<string, unknown>;
}

function foodbankRow(id: number): Record<string, unknown> {
  return db.prepare("SELECT * FROM foodbank WHERE id = ?").get(id) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// insertAdminNeed -- the row it writes
// ---------------------------------------------------------------------------

describe("insertAdminNeed: the row", () => {
  beforeEach(() => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", name: "Salisbury Foodbank" });
  });

  // Column by column, against the real table, because this is the one place
  // in the port where a FoodbankChange is conjured from nothing rather than
  // copied from a crawl. Every value below is either a literal in the
  // statement or a parameter, and asserting the whole row at once is what
  // catches a bind list that has slipped by one against its own column list.
  it("writes exactly one row with every column Django's save() would have set", async () => {
    const created = await insertAdminNeed(session, {
      foodbankId: SALISBURY,
      changeText: "Beans\nRice",
      excessChangeText: "Pasta",
      published: false,
    });

    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbankchange").get()).toEqual({ n: 1 });
    expect(needRow(created.needId)).toEqual({
      id: created.id,
      need_id: created.needId,
      foodbank_id: SALISBURY,
      distill_id: null,
      name: null,
      uri: null,
      change_text: "Beans\nRice",
      // change_text_original / excess_change_text_original stay NULL: NeedForm
      // excludes both and Django's save() never populates them on a typed need
      // either. Only needcheck.ts's `VALUES (..?4, ?4..)` writes them, for the
      // AI extraction path where the "original" genuinely differs.
      change_text_original: null,
      excess_change_text: "Pasta",
      excess_change_text_original: null,
      published: 0,
      nonpertinent: 0,
      is_categorised: 0,
      notified: null,
      input_method: "typed",
      created: PY_NOW,
      modified: PY_NOW,
    });
  });

  // set_input_method() (needs.py:108-112) returns "scrape" only when
  // distill_id is set, and distill_id is one of NeedForm's excludes
  // (forms.py:231-236) -- so a need created through this form can only ever
  // be "typed". It is a literal in the statement, not a parameter, and the
  // admin need list renders it in a column reviewers filter by eye: an "ai"
  // or "scrape" here would attribute a hand-typed list to the crawler.
  it("hardcodes input_method 'typed', never the crawler's value", async () => {
    const created = await insertAdminNeed(session, { foodbankId: SALISBURY, changeText: "Beans", excessChangeText: null, published: false });
    expect(needRow(created.needId).input_method).toBe("typed");
  });

  // THE FILTER THAT DOES NOTHING IF THIS IS WRONG. The review queue is
  // `WHERE published = 0 AND nonpertinent = 0` (needAdmin.ts's
  // getUnpublishedNeeds, matching Django's own filter verbatim), and in SQL
  // `nonpertinent = 0` excludes NULL -- three-valued logic, not a quirk. The
  // column is NULLABLE with no default, so leaving it out of the INSERT
  // would store NULL and the brand-new need would never appear in the queue
  // it was created to sit in. Asserted through the real queue predicate, not
  // just as a column value, because that is the consequence that matters.
  it("stamps nonpertinent 0 explicitly, so the new need lands in the review queue", async () => {
    const created = await insertAdminNeed(session, { foodbankId: SALISBURY, changeText: "Beans", excessChangeText: null, published: false });

    expect(needRow(created.needId).nonpertinent).toBe(0);
    const queued = db.prepare("SELECT need_id FROM foodbankchange WHERE published = 0 AND nonpertinent = 0").all();
    expect(queued).toEqual([{ need_id: created.needId }]);
  });

  // The other half of the same decision, and the one with a cost: an explicit
  // 0 keeps the need OUT of the categorisation backlog, which selects on
  // `is_categorised IS NULL` (Django's `is_categorised__isnull=True`, and the
  // partial index change_uncategorised_idx that 0001_core.sql builds for it).
  // That is deliberate and matches needcheck.ts's insertFoodbankChange, which
  // writes 0 for the same reason -- pinned here so nobody "fixes" it into a
  // NULL and silently changes which needs the categoriser picks up.
  it("stamps is_categorised 0, which keeps the need out of the IS NULL backlog", async () => {
    const created = await insertAdminNeed(session, { foodbankId: SALISBURY, changeText: "Beans", excessChangeText: null, published: false });

    expect(needRow(created.needId).is_categorised).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbankchange WHERE is_categorised IS NULL").get()).toEqual({ n: 0 });
  });

  // 0019 dropped foodbank_name off this table and replaced it with the
  // foodbankchange_full view. The module's own comment still lists step 3 as
  // "foodbank_name denormalised from the chosen food bank (needs.py:292-293)"
  // -- it is, but by the view at read time, not by this INSERT. Both halves
  // are asserted: the column really is gone from the fixture (so the INSERT
  // succeeding is evidence rather than luck), and the name the email context
  // reads as `need.foodbank_name` still resolves for a row this function
  // wrote.
  it("does not name the foodbank_name column 0019 dropped, and the view supplies it anyway", async () => {
    const columns = (db.prepare("PRAGMA table_info(foodbankchange)").all() as { name: string }[]).map((c) => c.name);
    expect(columns).not.toContain("foodbank_name");

    const created = await insertAdminNeed(session, { foodbankId: SALISBURY, changeText: "Beans", excessChangeText: null, published: false });
    expect(db.prepare("SELECT foodbank_name, foodbank_slug FROM foodbankchange_full WHERE need_id = ?").get(created.needId)).toEqual({
      foodbank_name: "Salisbury Foodbank",
      foodbank_slug: "salisbury",
    });
  });

  // NULL, never "". needNew.ts only passes a string when the textarea had
  // non-whitespace content, and excess_list downstream is
  // `need.excess_change_text ? split("\n") : []` -- an empty string would
  // still be falsy there, but `has_excess` and the whole "Excess" block in
  // notification.html hang off the same value, and production holds NULLs.
  it("stores a missing excess list as NULL, not an empty string", async () => {
    const created = await insertAdminNeed(session, { foodbankId: SALISBURY, changeText: "Beans", excessChangeText: null, published: false });
    expect(needRow(created.needId).excess_change_text).toBeNull();
  });

  // VERBATIM, deliberately. clean_foodbank_need_text() (utils/text.py:91-115)
  // unescapes entities, collapses double spaces, drops blank lines, strips
  // each line and rewrites "Uht" -> "UHT" -- and Django ran it inside
  // save(), i.e. below this layer. The port runs it in the ROUTE instead
  // (needNew.ts, where ticket #6's CRLF damage was diagnosed), so this
  // function must pass its argument through untouched or the text would be
  // cleaned twice, or cleaned differently, depending on the caller.
  //
  // The module's own comment still says the route does NOT clean ("see the
  // UNCLEANED TEXT note on the route handler"); that note is gone and the
  // route cleans. Stale comment, correct code -- the behaviour pinned here
  // is what the SQL layer should do either way.
  //
  // THE APOSTROPHES ARE LOAD-BEARING. Both strings carry a `'`, which is
  // the character that decides whether this text is BOUND or CONCATENATED.
  // Every other fixture in this file is apostrophe-free, so a "just inline
  // it" edit -- `'${params.changeText}'` in place of `?3`, the single most
  // plausible careless rewrite of a parameterised INSERT -- ran the whole
  // suite green. With a `'` in the value it is a SQL syntax error instead,
  // loudly, on the first call. Need lists genuinely contain them:
  // "children's toothpaste" and "men's razors" are ordinary lines on a real
  // shopping list, so this is the fixture being realistic, not contrived.
  it("stores the text exactly as handed to it, cleaning nothing", async () => {
    const dirty = "Uht  Milk\n\nChildren's toothpaste\n  Beans &amp; Peas  ";
    const excess = "  Men's razors  ";
    const created = await insertAdminNeed(session, { foodbankId: SALISBURY, changeText: dirty, excessChangeText: excess, published: false });

    const row = needRow(created.needId);
    expect(row.change_text).toBe(dirty);
    expect(row.excess_change_text).toBe(excess);
  });

  it("stores published as 1 when the box was ticked", async () => {
    const created = await insertAdminNeed(session, { foodbankId: SALISBURY, changeText: "Beans", excessChangeText: null, published: true });
    expect(needRow(created.needId).published).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// insertAdminNeed -- what it returns
// ---------------------------------------------------------------------------

describe("insertAdminNeed: the identifiers it returns", () => {
  beforeEach(() => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", name: "Salisbury Foodbank" });
  });

  // 32 hex characters, no dashes -- the shape needcheck.ts's
  // insertFoodbankChange writes, the shape the 21,000 migrated rows hold, and
  // the shape getNeedByUuid's normalizeUuid() reduces a URL to before it
  // compares. A dashed uuid would insert happily (the column is plain TEXT)
  // and then fail to match anything the rest of the app looks up.
  it("returns a 32-character dashless uuid, the shape every other writer uses", async () => {
    const created = await insertAdminNeed(session, { foodbankId: SALISBURY, changeText: "Beans", excessChangeText: null, published: false });

    expect(created.needId).toMatch(/^[0-9a-f]{32}$/);
    expect(created.needId).not.toContain("-");
    expect(needRow(created.needId).need_id).toBe(created.needId);
  });

  // need_need_id_uniq is UNIQUE on this column, so a constant or a reused
  // value would not merely collide in the URL space -- the second insert
  // would raise SQLITE_CONSTRAINT and 500 the form.
  it("mints a fresh need_id per call", async () => {
    const first = await insertAdminNeed(session, { foodbankId: SALISBURY, changeText: "Beans", excessChangeText: null, published: false });
    const second = await insertAdminNeed(session, { foodbankId: SALISBURY, changeText: "Rice", excessChangeText: null, published: false });

    expect(first.needId).not.toBe(second.needId);
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbankchange").get()).toEqual({ n: 2 });
  });

  // `id` is the numeric rowid, and it is what needNew.ts puts on the
  // translate-need queue message; `needId` is what the redirect uses. Seeded
  // at 5000 so a returned 1 (a counter, or meta.changes mistaken for
  // last_row_id) cannot pass, and asserted against the row actually on disk
  // rather than against the return value alone.
  it("returns the real rowid of the row it wrote, not a count", async () => {
    seedNeed({ id: 5000, foodbankId: SALISBURY, created: "2026-08-01 09:00:00.000000", published: 1 });

    const created = await insertAdminNeed(session, { foodbankId: SALISBURY, changeText: "Beans", excessChangeText: null, published: false });

    expect(created.id).toBe(5001);
    expect(needRow(created.needId).id).toBe(created.id);
  });
});

// ---------------------------------------------------------------------------
// insertAdminNeed -- the foodbank recompute
// ---------------------------------------------------------------------------

describe("insertAdminNeed: the foodbank recompute", () => {
  // A food bank whose cached fields are six weeks stale, pointing at its one
  // existing published need. Every case below is about which of those two
  // columns moves.
  function seedStaleSalisbury(): void {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", name: "Salisbury Foodbank", lastNeed: "2026-08-01 09:00:00.000000", latestNeedId: 900 });
    seedNeed({ id: 900, foodbankId: SALISBURY, created: "2026-08-01 09:00:00.000000", published: 1 });
  }

  it("moves last_need and latest_need_id onto a newly published need", async () => {
    seedStaleSalisbury();

    const created = await insertAdminNeed(session, { foodbankId: SALISBURY, changeText: "Beans", excessChangeText: null, published: true });

    const foodbank = foodbankRow(SALISBURY);
    expect(foodbank.last_need).toBe(PY_NOW);
    expect(foodbank.latest_need_id).toBe(created.id);
  });

  // THE DELIBERATE DIVERGENCE, and the reason this function calls the
  // recompute unconditionally. Django guards it with `if self.foodbank and
  // self.published and do_foodbank_save` (needs.py:301-302), so creating an
  // unpublished need leaves `last_need` -- a plain "when did we last see ANY
  // need" timestamp, rendered on the food bank's admin page and used by the
  // needcheck scheduler -- reading a date from before the need existed.
  //
  // Both columns are asserted, because the fix must not overreach either:
  // last_need moves to the unpublished need, latest_need_id does NOT, since
  // an unpublished need is not the latest PUBLISHED one and promoting it
  // would put an unreviewed shopping list on the public page.
  it("moves last_need but not latest_need_id when the new need is unpublished", async () => {
    seedStaleSalisbury();

    await insertAdminNeed(session, { foodbankId: SALISBURY, changeText: "Beans", excessChangeText: null, published: false });

    const foodbank = foodbankRow(SALISBURY);
    expect(foodbank.last_need).toBe(PY_NOW);
    expect(foodbank.latest_need_id).toBe(900);
  });

  // The site-wide "Last updated" footer is MAX(foodbank.modified), so a
  // published need has to stamp it, as Django's foodbank.save() did. An
  // unpublished one changes nothing the public can see and must not.
  it("stamps the food bank's modified for a published need, and leaves it for an unpublished one", async () => {
    seedStaleSalisbury();

    await insertAdminNeed(session, { foodbankId: SALISBURY, changeText: "Beans", excessChangeText: null, published: false });
    expect(foodbankRow(SALISBURY).modified).toBe("2020-01-01 00:00:00.000000");

    await insertAdminNeed(session, { foodbankId: SALISBURY, changeText: "Rice", excessChangeText: null, published: true });
    expect(foodbankRow(SALISBURY).modified).toBe(PY_NOW);
  });

  // TICKET #9, executed rather than argued. The recompute is
  // `ORDER BY created DESC LIMIT 1` over TEXT, so the format this function
  // writes decides which row wins. Salisbury already has a need created at
  // 20:00 today, in the Django spelling the ETL and pyNow() both use; the new
  // need is created at 19:28 and must LOSE.
  //
  // Under a toISOString() mutant the new row's created would be
  // "2026-09-05T19:28:08.853Z", and 'T' (0x54) sorts above ' ' (0x20), so an
  // 19:28 row would beat a 20:00 row and last_need would come back holding an
  // ISO string. That is not hypothetical: it is the exact failure that needed
  // a replace() workaround during the 2026-09-05 migration.
  it("writes a Django-format timestamp, so it sorts correctly against rows already stored", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", name: "Salisbury Foodbank", lastNeed: null, latestNeedId: null });
    seedNeed({ id: 901, foodbankId: SALISBURY, created: "2026-09-05 20:00:00.000000", published: 0 });

    const created = await insertAdminNeed(session, { foodbankId: SALISBURY, changeText: "Beans", excessChangeText: null, published: false });

    expect(needRow(created.needId).created).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
    expect(foodbankRow(SALISBURY).last_need).toBe("2026-09-05 20:00:00.000000");
  });

  // created and modified come from ONE pyNow() bound once as `?6`. Two
  // separate calls could straddle a millisecond and give a brand-new row a
  // modified later than its created, which the admin renders as "edited".
  it("gives created and modified the same instant", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", name: "Salisbury Foodbank" });

    const created = await insertAdminNeed(session, { foodbankId: SALISBURY, changeText: "Beans", excessChangeText: null, published: false });

    const row = needRow(created.needId);
    expect(row.created).toBe(row.modified);
  });

  // An orphan need is legal (foodbank_id is NULLABLE, and need_form's
  // foodbank field is not required) and there is nothing to recompute.
  //
  // THE ONE MUTANT THIS FILE DOES NOT KILL is deleting the `!== null` guard
  // in front of the recompute, and that is a fact about the query rather
  // than a hole here: recomputeFoodbankNeedFields(session, null) reads
  // `WHERE foodbank_id = ?` (never true against NULL, so no rows) and then
  // writes `UPDATE foodbank SET ... WHERE id = ?`, which matches no row
  // either. The guard saves three round trips; it does not prevent damage,
  // and no observable state distinguishes the two. Recorded rather than
  // papered over with an assertion on how many statements ran, which would
  // pin the implementation instead of the behaviour.
  //
  // What IS asserted -- and what dies the moment the recompute is aimed at
  // anything other than the named food bank -- is that Salisbury's cached
  // fields come through the call untouched.
  it("touches no food bank at all when the need has none", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", name: "Salisbury Foodbank", lastNeed: "2026-08-01 09:00:00.000000", latestNeedId: 900 });
    seedNeed({ id: 900, foodbankId: SALISBURY, created: "2026-08-01 09:00:00.000000", published: 1 });

    const created = await insertAdminNeed(session, { foodbankId: null, changeText: "Beans", excessChangeText: null, published: false });

    expect(needRow(created.needId).foodbank_id).toBeNull();
    const foodbank = foodbankRow(SALISBURY);
    expect(foodbank.last_need).toBe("2026-08-01 09:00:00.000000");
    expect(foodbank.latest_need_id).toBe(900);

    // AND THE ORPHAN IS STILL VISIBLE. foodbankchange_full is a LEFT JOIN
    // (0019_drop_foodbank_cache.sql:86-89) and every admin need list reads
    // the view rather than the table, so the join direction decides whether
    // a need with no food bank can be found again after it is created. An
    // INNER JOIN there -- the one-word edit a reader who has only ever seen
    // rows WITH a food bank would make without hesitating -- would delete
    // every orphan need from the admin UI while leaving the rows on disk and
    // raising nothing. The test above proves the row exists; this proves it
    // is reachable, with a NULL name rather than no row.
    expect(db.prepare("SELECT foodbank_id, foodbank_name, foodbank_slug FROM foodbankchange_full WHERE need_id = ?").get(created.needId)).toEqual({
      foodbank_id: null,
      foodbank_name: null,
      foodbank_slug: null,
    });
  });

  // The recompute's UPDATE carries `WHERE id = ?`. Without it -- or with the
  // wrong id bound -- every food bank in the country would take Salisbury's
  // latest need, which is the kind of thing that reads fine in review and
  // rewrites 470 rows in production.
  it("recomputes only the chosen food bank", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", name: "Salisbury Foodbank", lastNeed: null, latestNeedId: null });
    seedFoodbank({ id: WESTBURY, slug: "westbury", name: "Westbury Foodbank", lastNeed: "2026-01-01 00:00:00.000000", latestNeedId: 800 });
    seedNeed({ id: 800, foodbankId: WESTBURY, created: "2026-01-01 00:00:00.000000", published: 1 });

    await insertAdminNeed(session, { foodbankId: SALISBURY, changeText: "Beans", excessChangeText: null, published: true });

    const westbury = foodbankRow(WESTBURY);
    expect(westbury.last_need).toBe("2026-01-01 00:00:00.000000");
    expect(westbury.latest_need_id).toBe(800);
  });

  // The recompute reads `WHERE foodbank_id = ?`, so another food bank's
  // needs -- and orphan needs -- must not be able to become Salisbury's
  // latest. Westbury's need is NEWER than the one being inserted, so a
  // recompute that had lost its foodbank_id predicate would hand Salisbury a
  // latest_need_id belonging to a different food bank entirely.
  it("ignores other food banks' needs and orphan needs when recomputing", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", name: "Salisbury Foodbank", lastNeed: null, latestNeedId: null });
    seedFoodbank({ id: WESTBURY, slug: "westbury", name: "Westbury Foodbank" });
    seedNeed({ id: 800, foodbankId: WESTBURY, created: "2026-09-06 08:00:00.000000", published: 1 });
    seedNeed({ id: 801, foodbankId: null, created: "2026-09-06 09:00:00.000000", published: 1 });

    const created = await insertAdminNeed(session, { foodbankId: SALISBURY, changeText: "Beans", excessChangeText: null, published: true });

    const salisbury = foodbankRow(SALISBURY);
    expect(salisbury.last_need).toBe(PY_NOW);
    expect(salisbury.latest_need_id).toBe(created.id);
  });
});

// ---------------------------------------------------------------------------
// getFoodbankForNeedEmail
// ---------------------------------------------------------------------------

describe("getFoodbankForNeedEmail", () => {
  // A narrow SELECT is the whole point of this function existing beside
  // getFoodbankBySlug, which does `SELECT *` over ~80 columns and then a
  // second query for latest_need. Asserting the exact key set (and its order,
  // which is the statement's column order) is what keeps a well-meaning
  // `SELECT *` from landing here unnoticed -- it would still make every test
  // below pass on values.
  it("returns exactly the five columns the notification templates read", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", name: "Salisbury Foodbank", altName: "Salisbury & District", noDonationPoints: 6 });

    const row = await getFoodbankForNeedEmail(session, SALISBURY);
    expect(Object.keys(row!)).toEqual(["id", "slug", "name", "alt_name", "no_donation_points"]);
    expect(row).toEqual({ id: SALISBURY, slug: "salisbury", name: "Salisbury Foodbank", alt_name: "Salisbury & District", no_donation_points: 6 });
  });

  // buildNeedEmailContext returns null on a missing food bank and the preview
  // route turns that into a 404 rather than rendering an email addressed to
  // nobody, so "no row" has to arrive as null and not as undefined.
  it("returns null for a food bank id nothing holds", async () => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury" });
    expect(await getFoodbankForNeedEmail(session, 999)).toBeNull();
  });

  // Looks up by primary key, and the id it is given comes from the need. With
  // three rows present a statement that had lost its WHERE would answer with
  // whichever row SQLite reached first and the preview would show a different
  // food bank's name over this food bank's shopping list.
  it("looks the row up by id, not by whatever comes back first", async () => {
    seedFoodbank({ id: BATH, slug: "bath", name: "Bath Foodbank" });
    seedFoodbank({ id: WESTBURY, slug: "westbury", name: "Westbury Foodbank" });
    seedFoodbank({ id: SALISBURY, slug: "salisbury", name: "Salisbury Foodbank" });

    expect((await getFoodbankForNeedEmail(session, WESTBURY))?.slug).toBe("westbury");
  });

  // NO is_closed FILTER, deliberately pinned. Needs outlive their food bank's
  // closure and the admin can still open the email preview for one; every
  // other read path in this package filters `is_closed = 0` by habit, so the
  // absence here is worth an assertion rather than an assumption. Adding the
  // filter would 404 the preview for exactly the needs most likely to be
  // under review.
  it("returns a closed food bank, because a need for one still has a preview", async () => {
    seedFoodbank({ id: BATH, slug: "bath", name: "Bath Foodbank", isClosed: 1 });
    expect((await getFoodbankForNeedEmail(session, BATH))?.slug).toBe("bath");
  });

  // Both columns are NULLABLE and both nulls are load-bearing downstream:
  // fullNameLocaleAware() renders "name" alone rather than "name (alt_name)",
  // and buildNeedEmailContext's show_donation_points is
  // `no_donation_points !== 0` -- reproducing Python's `None != 0` being TRUE,
  // so a NULL count still shows the "Find donation points" line. A COALESCE
  // to 0 anywhere in this statement would silently delete that line from the
  // mail 5,855 subscribers get.
  it("passes NULL alt_name and NULL no_donation_points through as null", async () => {
    seedFoodbank({ id: WESTBURY, slug: "westbury", name: "Westbury Foodbank", altName: null, noDonationPoints: null });

    const row = await getFoodbankForNeedEmail(session, WESTBURY);
    expect(row?.alt_name).toBeNull();
    expect(row?.no_donation_points).toBeNull();
    expect(row?.no_donation_points === 0).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getArticlesForNeedEmail
// ---------------------------------------------------------------------------

describe("getArticlesForNeedEmail", () => {
  beforeEach(() => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", name: "Salisbury Foodbank" });
    seedFoodbank({ id: WESTBURY, slug: "westbury", name: "Westbury Foodbank" });
  });

  // The cutoff every case here uses is the one the real caller derives, not a
  // number chosen to make an assertion work: 28 days back from the pinned
  // clock, sliced to a bare date. Anchored so that moving the clock or
  // ARTICLES_MONTH_DAYS breaks this test rather than quietly shifting every
  // boundary below.
  it("is exercised at the cutoff buildNeedEmailContext actually computes", () => {
    expect(new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)).toBe(CUTOFF);
  });

  // Everything at once: the foodbank_id filter, the cutoff, the ordering and
  // the projection.
  //
  // THE IDS ARE THE TEST. Expected order is 31, 88, 14, 60 -- which is not id
  // ascending (14, 31, 60, 88), not id descending (88, 60, 31, 14), and not
  // rowid order either, since `id INTEGER PRIMARY KEY` IS the rowid, so a
  // statement with no ORDER BY at all comes back in id-ascending order. An
  // earlier draft of this test numbered the rows 12/40/77 with the newest as
  // 12, which made id-ascending order identical to the expected order: the
  // "ORDER BY deleted" mutant PASSED this test and died two tests further
  // down, in a case that only exists to pin a bug and could legitimately be
  // rewritten the day that bug is fixed. Renumbering costs nothing and makes
  // the flagship ordering test the thing that actually catches it.
  //
  // TWO ARTICLES ON THE SAME DAY, both in the Django spelling, because the
  // WHERE clause compares only substr(published_date, 1, 10) and the obvious
  // "make the ORDER BY consistent with the WHERE" edit -- ORDER BY
  // substr(published_date, 1, 10) DESC -- is invisible unless a day holds
  // more than one article. 88 (20:00) must lead 14 (06:00).
  //
  // ONE FEATURED ARTICLE, because every other fixture row in this file is
  // featured = 0 and a `featured` predicate that dropped rows would have
  // passed the entire suite. Production really does hold featured = 1 rows --
  // 0003_homepage_data.sql's initial load copied ONLY the featured ones (168
  // of 17,194), and adminLists.ts's toggleArticleFeatured flips the flag
  // whenever an admin curates the homepage -- while Django's articles_month()
  // (foodbank.py:573-575) does not filter on it, so a curated article belongs
  // in the "News from..." block like any other.
  it("returns one food bank's articles inside the window, newest first", async () => {
    seedArticle({ id: 88, foodbankId: SALISBURY, publishedDate: "2026-08-20 20:00:00.000000" });
    seedArticle({ id: 31, foodbankId: SALISBURY, publishedDate: "2026-09-01 10:00:00.000000" });
    seedArticle({ id: 60, foodbankId: SALISBURY, publishedDate: "2026-08-08 06:00:00.000000", featured: 1 });
    seedArticle({ id: 14, foodbankId: SALISBURY, publishedDate: "2026-08-20 06:00:00.000000" });
    // Excluded: too old by one day.
    seedArticle({ id: 5, foodbankId: SALISBURY, publishedDate: "2026-08-07 23:59:59.999999" });
    // Excluded: another food bank's news, inside the window.
    seedArticle({ id: 6, foodbankId: WESTBURY, publishedDate: "2026-09-02 08:00:00.000000" });
    // Excluded: an orphan article. `foodbank_id = ?1` is never true for NULL,
    // which is the right answer here and is asserted rather than assumed --
    // the same three-valued logic bites the other way elsewhere in this repo.
    seedArticle({ id: 7, foodbankId: null, publishedDate: "2026-09-03 08:00:00.000000" });

    expect(await getArticlesForNeedEmail(session, SALISBURY, CUTOFF)).toEqual([
      { id: 31, published_date: "2026-09-01 10:00:00.000000", title: "Article 31", url: "https://example.org/news/31/" },
      { id: 88, published_date: "2026-08-20 20:00:00.000000", title: "Article 88", url: "https://example.org/news/88/" },
      { id: 14, published_date: "2026-08-20 06:00:00.000000", title: "Article 14", url: "https://example.org/news/14/" },
      { id: 60, published_date: "2026-08-08 06:00:00.000000", title: "Article 60", url: "https://example.org/news/60/" },
    ]);
  });

  // The projection again, on its own, because the whole-row toEqual above
  // would also pass if the SELECT grew a column that happened to be absent
  // from the expectation... it would not, but a future `SELECT *` reviewed in
  // isolation reads harmlessly and would start shipping `featured` into the
  // template context. Post-0019 there is no foodbank_name on this table to
  // pick up, so the four names below are the whole surface.
  it("selects four named columns, not the whole row", async () => {
    seedArticle({ id: 12, foodbankId: SALISBURY, publishedDate: "2026-09-01 10:00:00.000000" });
    const [article] = await getArticlesForNeedEmail(session, SALISBURY, CUTOFF);
    expect(Object.keys(article!)).toEqual(["id", "published_date", "title", "url"]);
  });

  // COMPARED ON THE DATE PREFIX. substr(published_date, 1, 10) is identical
  // in both spellings this column has held -- "YYYY-MM-DD HH:MM:SS.ffffff"
  // from the Postgres ETL and "YYYY-MM-DDTHH:MM:SS.sssZ" from the crawler
  // before it was changed to write pyDatetime -- so inclusion is decided by
  // the ten characters the two spellings share and nothing else. All four
  // decisions are asserted together: a predicate that concatenated a time
  // onto the cutoff (`?2 || 'T00:00:00Z'`, say) would agree with two of them
  // and drop the other two, which is exactly the half-right failure a
  // single-spelling fixture would miss.
  it("decides inclusion on the date prefix alone, in either timestamp spelling", async () => {
    seedArticle({ id: 1, foodbankId: SALISBURY, publishedDate: "2026-08-08 06:00:00.000000" });
    seedArticle({ id: 2, foodbankId: SALISBURY, publishedDate: "2026-08-08T05:00:00.000Z" });
    seedArticle({ id: 3, foodbankId: SALISBURY, publishedDate: "2026-08-07 23:00:00.000000" });
    seedArticle({ id: 4, foodbankId: SALISBURY, publishedDate: "2026-08-07T23:00:00.000Z" });

    const ids = (await getArticlesForNeedEmail(session, SALISBURY, CUTOFF)).map((a) => a.id);
    expect(ids.sort()).toEqual([1, 2]);
  });

  // The documented cost of day granularity, stated as a test so it is a
  // decision rather than an accident. Django's articles_month() compares
  // against `timezone.now() - timedelta(days=28)`, an exact instant -- 19:28
  // on the cutoff day -- and would drop this 06:00 article. The port keeps
  // it. Bounded to under 24 hours on a "news from the last month" block, and
  // preferable to an off-by-a-day on the crawler's own rows.
  it("includes an article published earlier on the cutoff day than Django would", async () => {
    seedArticle({ id: 1, foodbankId: SALISBURY, publishedDate: "2026-08-08 06:00:00.000000" });
    expect((await getArticlesForNeedEmail(session, SALISBURY, CUTOFF)).map((a) => a.id)).toEqual([1]);
  });

  // SUSPECT, pinned as-is rather than fixed (TESTING.md: tests pin current
  // behaviour). The WHERE clause is spelling-agnostic; the ORDER BY is not --
  // it sorts the RAW column, and 'T' (0x54) sorts above ' ' (0x20), so an
  // ISO-spelled article at 08:00 comes back ABOVE a Django-spelled one at
  // 20:00 the same day. That is the wrong order in the "News from..." block.
  //
  // Not reachable from clean data today: 0022_normalise_timestamps.sql
  // rewrote the 9 ISO rows this column held, and workers/jobs' articles.ts
  // now writes pyDatetime explicitly for this exact reason. So the module's
  // own comment -- which cites articles.ts's toISOString() as a live source
  // of ISO rows -- is out of date, and the substr() it justifies is now belt
  // and braces. The ordering hole it leaves open is real if an ISO row ever
  // returns, which is why it is asserted here instead of assumed impossible.
  it("mis-orders same-day articles when the two timestamp spellings are mixed", async () => {
    seedArticle({ id: 20, foodbankId: SALISBURY, publishedDate: "2026-08-20 20:00:00.000000" });
    seedArticle({ id: 21, foodbankId: SALISBURY, publishedDate: "2026-08-20T08:00:00.000Z" });

    // Chronologically 20 (20:00) should lead. It does not.
    expect((await getArticlesForNeedEmail(session, SALISBURY, CUTOFF)).map((a) => a.id)).toEqual([21, 20]);
  });

  // SUSPECT, and a landmine for the next caller. substr() cuts the stored
  // value down to ten characters, so a cutoff carrying a time is compared
  // against a bare date: "2026-08-08" >= "2026-08-08 12:00:00.000000" is
  // FALSE (the shorter string is a prefix, so it sorts first), and the whole
  // cutoff day disappears instead of half of it. The only caller passes
  // `.toISOString().slice(0, 10)`, so this is latent -- pinned so that a
  // future caller reaching for exact-instant granularity finds a test saying
  // what actually happens rather than discovering it in a subscriber's inbox.
  it("silently drops the entire cutoff day if given a full timestamp as the cutoff", async () => {
    seedArticle({ id: 1, foodbankId: SALISBURY, publishedDate: "2026-08-08 18:00:00.000000" });
    seedArticle({ id: 2, foodbankId: SALISBURY, publishedDate: "2026-08-09 06:00:00.000000" });

    // 18:00 is after the 12:00 threshold and is dropped anyway.
    expect((await getArticlesForNeedEmail(session, SALISBURY, "2026-08-08 12:00:00.000000")).map((a) => a.id)).toEqual([2]);
  });

  // UNBOUNDED, matching Django. A LIMIT here would silently change what 5,855
  // subscribers see in the "News from..." block, and would not fail anything
  // else -- 30 rows is above every plausible cap someone might add for
  // "safety" while still being a realistic month for a busy food bank's feed.
  it("applies no LIMIT", async () => {
    for (let i = 0; i < 30; i += 1) {
      seedArticle({ id: 100 + i, foodbankId: SALISBURY, publishedDate: `2026-08-${String(10 + i).padStart(2, "0")} 09:00:00.000000` });
    }

    const rows = await getArticlesForNeedEmail(session, SALISBURY, CUTOFF);
    expect(rows).toHaveLength(30);
    expect(rows[0]!.id).toBe(129);
    expect(rows[29]!.id).toBe(100);
  });

  // An empty array, never null: buildNeedEmailContext maps over this
  // unconditionally, and the templates render the "News from..." block from
  // its length.
  it("returns an empty array for a food bank with no articles in the window", async () => {
    seedArticle({ id: 1, foodbankId: SALISBURY, publishedDate: "2026-01-01 09:00:00.000000" });
    expect(await getArticlesForNeedEmail(session, SALISBURY, CUTOFF)).toEqual([]);
  });
});
