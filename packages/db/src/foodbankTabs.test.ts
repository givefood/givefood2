import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "./schema.testkit";
import { describe, expect, it } from "vitest";
import {
  parseD1Timestamp,
  formatTimedelta,
  crawlTypeIcon,
  getNeedsForFoodbankTab,
  getOrdersForFoodbankTab,
  getArticlesForFoodbankTab,
  getSubscribersForFoodbankTab,
  getCrawlItemsForFoodbankTab,
  getCrawlSetJson,
} from "./foodbankTabs";
import type { Session } from "./types";

// gfadmin/views.py:640-724's four lazy tab data-builders
// (foodbank_needsorders_tab / foodbank_articles_tab /
// foodbank_subscribers_tab / foodbank_crawls_tab) and :3283-3323's
// crawl_set_json(), plus the two duration helpers all five share.
//
// WHY A REAL DATABASE, NOT A MOCK. Five of the eight exports are a SELECT
// and a `.map()`, so a session handing back canned rows would agree with any
// SQL at all -- including SQL that names a column 0019 dropped, orders by the
// wrong key, or loses half the rows to an inner join. Every failure this
// module can have is silent: the orders half of the needs/orders tab sorted
// by `created` instead of `delivery_datetime` renders a full, plausible table
// of the WRONG 200 orders; a subscribers query that lost its `confirmed = 1`
// inflates a count nobody can check by eye. Nothing throws, nothing logs.
// This package already carries that exact scar -- migration 0019 dropped six
// tables' cached parent columns and four queries went on naming them until
// /dashboard/beautybanks/ was measured and found to be a live 500. So the
// statements below are run, by SQLite, against the real schema.
//
// THE FIXTURE IS THE MIGRATION FILES THEMSELVES, applied in order (same
// approach as crawlSets.test.ts, which covers this module's siblings): a
// CREATE TABLE transcribed into a test file is a second copy of the truth and
// drifts from the first. Four facts it supplies that a hand-written schema
// would probably have got wrong, and that tests below depend on:
//   * foodbankchange, foodbankarticle and foodbanksubscriber all LOST their
//     `foodbank_name` copy in 0019, so the needs tab's name can only come off
//     the foodbankchange_full view's join -- which is why the view is created
//     here from the migration rather than stood in for.
//   * that view's join is a LEFT JOIN, so a need whose parent row is missing
//     survives with a null name instead of vanishing.
//   * crawlitem.crawl_set_id is NULLABLE (0008) -- an ad-hoc "Force Check"
//     item -- and the crawls TAB shows those alongside sweep items, unlike
//     the Ad Hoc Crawls table on /admin/crawl_sets/.
//   * crawlitem_crawlset_foodbank_uniq is UNIQUE(crawl_set_id, foodbank_id),
//     so every multi-item crawl set seeded here spans several food banks, as
//     production's do.
//
// NOT COVERED, deliberately: D1's 100-bound-parameter statement limit. No
// function in this module builds a variable-length IN list -- every statement
// here binds two parameters or fewer -- so there is no chunking boundary to
// probe. If one ever grows one, that is the test to add.

type Bindable = null | number | bigint | string | Uint8Array;

// The slice of the D1 Sessions API this package is handed, backed by
// node:sqlite. Copied verbatim from crawlSets.test.ts (itself copied from
// adminDashboardStats.test.ts, itself from
// workers/site/src/routes/admin/foodbankLocation.test.ts) so every tier drives
// the real code through one adapter. Deliberately dumb -- it forwards the SQL
// untouched and interprets nothing, so the engine decides which rows come
// back, not this file.
function d1Session(db: DatabaseSync): Session {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return { prepare: (sql: string) => statement(sql, []), getBookmark: () => null } as unknown as Session;
}

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return db;
}

// EVERY TIMESTAMP IN THIS FILE IS DJANGO'S FORMAT: "YYYY-MM-DD HH:MM:SS.ffffff",
// which is what pyNow() writes and what migration 0022 rewrote the imported
// Postgres rows into. That is not decoration. These columns are TEXT and every
// ORDER BY over them is a byte-wise string comparison, so the format is
// load-bearing twice over: a toISOString() value ("2026-09-05T...Z") sorts
// ABOVE every space-separated one because 'T' (0x54) beats ' ' (0x20) -- which
// is the bug 0022 exists to repair -- and parseD1Timestamp has already been
// bitten once by a double-"Z" producing a silent NaN (see foodbankTabs.ts's
// own header). Seeding ISO here would test a database this app does not have.

const SALISBURY = 7;
const AMESBURY = 12;

function seedFoodbank(db: DatabaseSync, id: number, name: string, slug: string): void {
  db.prepare(
    `INSERT INTO foodbank (
       id, uuid, name, slug, address, postcode, country, lat_lng,
       charity_just_foodbank, contact_email, url, shopping_list_url,
       address_is_administrative, is_closed, no_locations, days_between_needs,
       created, modified
     ) VALUES (?, ?, ?, ?, 'Address', 'SP2 9DY', 'England', '51.06,-1.79',
       0, 'info@example.org', 'https://example.org/', 'https://example.org/list/',
       0, 0, 0, 7,
       '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run(id, `uuid-${id}`, name, slug);
}

// `needId` is the 32-char dashless UUID, NOT the row's integer primary key --
// they are different columns, both called "need_id" in their own tables, and
// crawlitem.need_id holds the INTEGER while foodbankchange.need_id holds the
// UUID. Seeded as visibly different values (id 41, uuid "aaaa...") so a query
// that returned the wrong one could not accidentally look right.
interface NeedSeed {
  id: number;
  needId: string;
  foodbankId: number | null;
  created: string;
  modified?: string;
  changeText?: string;
  excessChangeText?: string | null;
  published?: 0 | 1;
  nonpertinent?: 0 | 1 | null;
  isCategorised?: 0 | 1 | null;
  inputMethod?: string;
}

function seedNeed(db: DatabaseSync, need: NeedSeed): void {
  db.prepare(
    `INSERT INTO foodbankchange
       (id, need_id, foodbank_id, change_text, excess_change_text, published, nonpertinent, is_categorised, input_method, created, modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    need.id,
    need.needId,
    need.foodbankId,
    need.changeText ?? "Beans, Rice",
    need.excessChangeText ?? null,
    need.published ?? 1,
    need.nonpertinent === undefined ? 0 : need.nonpertinent,
    need.isCategorised === undefined ? 1 : need.isCategorised,
    need.inputMethod ?? "scrape",
    need.created,
    need.modified ?? need.created,
  );
}

interface OrderSeed {
  id: number;
  orderId: string;
  foodbankId: number | null;
  created: string;
  deliveryDatetime: string;
  deliveryProvider?: string | null;
  noItems?: number;
  cost?: number;
  actualCost?: number | null;
  notificationEmailSent?: string | null;
}

function seedOrder(db: DatabaseSync, order: OrderSeed): void {
  db.prepare(
    `INSERT INTO orders
       (id, order_id, items_text, country, created, modified, notification_email_sent,
        delivery_date, delivery_hour, delivery_datetime, delivery_provider,
        weight, calories, cost, actual_cost, no_lines, no_items, foodbank_id)
     VALUES (?, ?, 'Beans x2', 'England', ?, ?, ?, ?, ?, ?, ?, 12000, 30000, ?, ?, 4, ?, ?)`,
  ).run(
    order.id,
    order.orderId,
    order.created,
    order.created,
    order.notificationEmailSent ?? null,
    // delivery_date and delivery_hour are DERIVED from delivery_datetime here
    // because Django derives them the other way round and cannot let them
    // disagree: Order.save() (models/orders.py:110-116) rebuilds
    // delivery_datetime as datetime(date.y, date.m, date.d, hour, 0) on every
    // write. A fixture that let the three drift apart would be testing a row
    // shape this database cannot hold, and would make an ORDER BY on the wrong
    // one of them look catchable when it is not.
    order.deliveryDatetime.slice(0, 10),
    Number(order.deliveryDatetime.slice(11, 13)),
    order.deliveryDatetime,
    order.deliveryProvider ?? null,
    order.cost ?? 4250,
    order.actualCost ?? null,
    order.noItems ?? 42,
    order.foodbankId,
  );
}

// `foodbank_name` is NOT a column here: 0019 dropped foodbankarticle's copy
// along with the other five. An INSERT naming it would fail outright, which is
// exactly the protection the migration-as-fixture buys.
function seedArticle(db: DatabaseSync, article: { id: number; foodbankId: number | null; publishedDate: string; title: string; url?: string; featured?: 0 | 1 }): void {
  db.prepare("INSERT INTO foodbankarticle (id, foodbank_id, published_date, title, url, featured) VALUES (?, ?, ?, ?, ?, ?)").run(
    article.id,
    article.foodbankId,
    article.publishedDate,
    article.title,
    article.url ?? `https://example.org/news/${article.id}/`,
    article.featured ?? 0,
  );
}

function seedEmailSubscriber(db: DatabaseSync, sub: { id: number; foodbankId: number; email: string; confirmed: 0 | 1; created: string }): void {
  db.prepare("INSERT INTO foodbanksubscriber (id, created, foodbank_id, email, confirmed, sub_key, unsub_key) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    sub.id,
    sub.created,
    sub.foodbankId,
    sub.email,
    sub.confirmed,
    `sub-${sub.id}`,
    `unsub-${sub.id}`,
  );
}

function seedWebpushSubscription(db: DatabaseSync, sub: { id: number; foodbankId: number; endpoint: string; browser: string | null; created: string }): void {
  db.prepare("INSERT INTO webpushsubscription (id, created, foodbank_id, endpoint, p256dh, auth, browser) VALUES (?, ?, ?, ?, 'p256dh', 'auth', ?)").run(
    sub.id,
    sub.created,
    sub.foodbankId,
    sub.endpoint,
    sub.browser,
  );
}

function seedMobileSubscriber(db: DatabaseSync, sub: { id: number; foodbankId: number; deviceId: string; platform: string; created: string }): void {
  db.prepare("INSERT INTO mobilesubscriber (id, created, device_id, platform, foodbank_id) VALUES (?, ?, ?, ?, ?)").run(sub.id, sub.created, sub.deviceId, sub.platform, sub.foodbankId);
}

function seedWhatsappSubscriber(db: DatabaseSync, sub: { id: number; foodbankId: number; phoneNumber: string; created: string }): void {
  db.prepare("INSERT INTO whatsappsubscriber (id, phone_number, foodbank_id, created) VALUES (?, ?, ?, ?)").run(sub.id, sub.phoneNumber, sub.foodbankId, sub.created);
}

function seedCrawlSet(db: DatabaseSync, cs: { id: number; crawl_type: string; start: string; finish?: string | null }): void {
  db.prepare("INSERT INTO crawlset (id, crawl_type, run_id, start, finish, expected, remaining) VALUES (?, ?, NULL, ?, ?, NULL, NULL)").run(cs.id, cs.crawl_type, cs.start, cs.finish ?? null);
}

function seedCrawlItem(
  db: DatabaseSync,
  ci: { id: number; crawl_set_id: number | null; crawl_type?: string; start: string; finish?: string | null; foodbank_id: number; url?: string | null; need_id?: number | null },
): void {
  db.prepare("INSERT INTO crawlitem (id, crawl_set_id, crawl_type, start, finish, foodbank_id, url, need_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    ci.id,
    ci.crawl_set_id,
    ci.crawl_type ?? "need",
    ci.start,
    ci.finish ?? null,
    ci.foodbank_id,
    ci.url ?? null,
    ci.need_id ?? null,
  );
}

// ---------------------------------------------------------------------------
// parseD1Timestamp -- the seam every duration in this file passes through
// ---------------------------------------------------------------------------

describe("parseD1Timestamp", () => {
  // Django's own format, as the ETL and pyNow() write it: a SPACE separator
  // and SIX fractional digits, neither of which `new Date()` is obliged to
  // accept. The absolute epoch value is asserted, not just a difference,
  // because a parser that read the string as local time would still give the
  // right difference between two of them and the wrong answer everywhere a
  // single timestamp is compared against a clock (getRunningCrawlSets's
  // `now`, for one).
  it("reads Django's space-separated, six-digit format as UTC", () => {
    expect(parseD1Timestamp("2026-09-05 15:00:00.000000")).toBe(Date.parse("2026-09-05T15:00:00.000Z"));
  });

  // THE BUG THIS FUNCTION EXISTS TO FIX, found 2026-09-02. The old code
  // appended "Z" unconditionally, so a value that already carried one became
  // "...ZZ" -- which `new Date()` turns into an Invalid Date (getTime() = NaN)
  // rather than throwing. NaN then flows all the way to the page as
  // "NaN:NaN:NaN" or a blank ms cell. Both spellings must land on the same
  // instant, and neither may be NaN.
  it("accepts a value that already ends in Z, without producing NaN", () => {
    const withZ = parseD1Timestamp("2026-09-05T19:28:08.639Z");
    expect(withZ).toBe(Date.parse("2026-09-05T19:28:08.639Z"));
    expect(Number.isNaN(withZ)).toBe(false);
    expect(parseD1Timestamp("2026-09-05 19:28:08.639000")).toBe(withZ);
  });

  // Both formats are live in this database at once. 0022 rewrote the ISO rows
  // the port had already written, but the write sites it fixed had produced
  // them for a fortnight, and any row restored from a pre-0022 backup is ISO
  // again. Parsing has to be blind to which one it got.
  it("parses a pre-0022 ISO row and a post-0022 Django row to the same instant", () => {
    expect(parseD1Timestamp("2026-09-05T19:28:08.639Z")).toBe(parseD1Timestamp("2026-09-05 19:28:08.639000"));
  });

  // Microseconds are TRUNCATED to milliseconds, not rounded: .999999 is 999
  // ms, not the next whole second. That matters because the crawls tab prints
  // the difference of two of these in raw milliseconds, so a rounding change
  // here would move every number on that column by up to 1.
  it("truncates Django's microseconds to milliseconds rather than rounding", () => {
    const base = Date.parse("2026-09-05T15:00:00.000Z");
    expect(parseD1Timestamp("2026-09-05 15:00:00.123456") - base).toBe(123);
    expect(parseD1Timestamp("2026-09-05 15:00:00.999999") - base).toBe(999);
  });

  // Not every timestamp column carries fractional digits -- foodbank.last_need
  // and friends are written by hand and by the ETL at second resolution.
  it("parses a value with no fractional part at all", () => {
    expect(parseD1Timestamp("2026-09-05 15:00:00")).toBe(Date.parse("2026-09-05T15:00:00.000Z"));
  });

  // PINNED, NOT ENDORSED. Garbage in gives NaN, silently -- there is no throw
  // to catch and no log line. This is the whole reason the two "Z" cases above
  // are tested: the failure mode of this function is a number that poisons
  // every arithmetic result downstream while looking like a number. Only ONE
  // trailing Z is stripped, so a doubled suffix still fails.
  it("returns NaN rather than throwing when the text is not a timestamp", () => {
    expect(parseD1Timestamp("not a timestamp")).toBeNaN();
    expect(parseD1Timestamp("")).toBeNaN();
    expect(parseD1Timestamp("2026-09-05 15:00:00.000000ZZ")).toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// formatTimedelta -- Python's str(timedelta), reimplemented
// ---------------------------------------------------------------------------

describe("formatTimedelta", () => {
  // The three call sites (crawl_sets.html:57, crawl_set.html:30 and the JSON
  // the detail page polls) all render this string, so an SSR row and the poll
  // that overwrites it have to be indistinguishable. Note the hour is NOT
  // zero-padded while minutes and seconds are -- that asymmetry is Python's,
  // and "00:04:32" here would be visibly different from the value Django
  // printed for the same crawl.
  it("prints Python's h:mm:ss, padding minutes and seconds but not hours", () => {
    expect(formatTimedelta(0)).toBe("0:00:00");
    expect(formatTimedelta(272_000)).toBe("0:04:32");
    expect(formatTimedelta(8_047_000)).toBe("2:14:07");
    expect(formatTimedelta(36_309_000)).toBe("10:05:09");
  });

  // A `need` sweep whose consumer died keeps a NULL finish until maintenance
  // backfills it days later, so the day-carrying form is a real shape here,
  // not a curiosity. timedelta uses the SINGULAR for exactly one day.
  it("carries whole days out of the clock, singular for exactly one", () => {
    expect(formatTimedelta(93_784_000)).toBe("1 day, 2:03:04");
    expect(formatTimedelta(273_906_000)).toBe("3 days, 4:05:06");
    expect(formatTimedelta(86_400_000)).toBe("1 day, 0:00:00");
  });

  // Math.floor is Python's floor division, so a negative duration BORROWS a
  // day exactly as timedelta does. All three values below were run through
  // CPython (`str(timedelta(seconds=round(ms/1000)))`) rather than reasoned
  // about, per TESTING.md's rule on parity claims. A "-0:00:01" here would be
  // a nicer string and a different one from Django's.
  it("borrows a day for negative durations, as timedelta does", () => {
    expect(formatTimedelta(-1_000)).toBe("-1 day, 23:59:59");
    expect(formatTimedelta(-86_400_000)).toBe("-1 day, 0:00:00");
    expect(formatTimedelta(-93_784_000)).toBe("-2 days, 21:56:56");
  });

  // KNOWN DIVERGENCE, pinned rather than fixed -- the module's own header
  // names it. Math.round is half-up; Python's round() is half-to-even. Verified
  // against CPython: round(0.5) is 0, round(2.5) is 2, round(-1.5) is -2, so
  // Django prints "0:00:00", "0:00:02" and "-1 day, 23:59:58" for these three.
  // Reachable only when a duration lands on an exact half-second, which for a
  // millisecond-resolution clock is one crawl in a thousand, and the cost is
  // one second on a printed duration. Asserting the wish instead would leave
  // the suite permanently red and tell nobody anything.
  it("rounds an exact half-second half-UP, where Python rounds half-to-even", () => {
    expect(formatTimedelta(500)).toBe("0:00:01"); // CPython: "0:00:00"
    expect(formatTimedelta(2_500)).toBe("0:00:03"); // CPython: "0:00:02"
    expect(formatTimedelta(-1_500)).toBe("-1 day, 23:59:59"); // CPython: "-1 day, 23:59:58"
    // Away from the exact half, the two agree -- including on the .499 case
    // that proves the rounding is happening at all rather than truncation.
    expect(formatTimedelta(1_500)).toBe("0:00:02");
    expect(formatTimedelta(499)).toBe("0:00:00");
    expect(formatTimedelta(501)).toBe("0:00:01");
  });

  // What a NaN out of parseD1Timestamp actually looks like on the page. Pinned
  // because it is the visible end of the silent failure the "Z" tests guard --
  // if anyone ever sees "NaN days, NaN:NaN:NaN" in the admin, this test says
  // where to look. Note it is the PLURAL form: Math.abs(NaN) === 1 is false.
  it("renders a NaN duration as a visible NaN rather than a plausible zero", () => {
    expect(formatTimedelta(NaN)).toBe("NaN days, NaN:NaN:NaN");
  });
});

// ---------------------------------------------------------------------------
// crawlTypeIcon
// ---------------------------------------------------------------------------

describe("crawlTypeIcon", () => {
  // givefood/const/general.py:62-70, verbatim. These strings are rendered
  // through Nunjucks' `| safe`, so a typo inside the markup is invisible in
  // review and shows as a missing glyph on the page.
  it("maps each of Django's six crawl types to its own icon", () => {
    expect(crawlTypeIcon("need")).toBe('<span class="mdi mdi-cart"></span>');
    expect(crawlTypeIcon("article")).toBe('<span class="mdi mdi-newspaper"></span>');
    expect(crawlTypeIcon("charity")).toBe('<span class="mdi mdi-bank"></span>');
    expect(crawlTypeIcon("discrepancy")).toBe('<span class="mdi mdi-alert"></span>');
    expect(crawlTypeIcon("check")).toBe('<span class="mdi mdi-clipboard-check"></span>');
    expect(crawlTypeIcon("urls")).toBe('<span class="mdi mdi-link"></span>');
  });

  // CRAWL_TYPE_ICON_DEFAULT, matching .get(type, DEFAULT). crawl_type is free
  // TEXT in the schema (0008's own note) and is stored lower-case, so a
  // capitalised or pluralised value is a realistic way to arrive here -- and
  // the answer must be a question-mark glyph, not an empty cell.
  it("falls back to the question-mark icon for anything else", () => {
    const fallback = '<span class="mdi mdi-help-circle"></span>';
    expect(crawlTypeIcon("photos")).toBe(fallback);
    expect(crawlTypeIcon("Need")).toBe(fallback); // stored lower-case; the lookup is case-sensitive
    expect(crawlTypeIcon("needs")).toBe(fallback);
    expect(crawlTypeIcon("")).toBe(fallback);
  });

  // SUSPECT, PINNED AS-IS. The lookup table is an object literal, so it
  // inherits Object.prototype -- and `?? DEFAULT` only fires on null/undefined.
  // A crawl_type of "toString" or "constructor" therefore resolves to an
  // inherited FUNCTION, not to the default icon, and the declared return type
  // (string) is a lie for those inputs. Nunjucks would stringify it into the
  // page as JavaScript source.
  //
  // Not currently reachable: every value in crawlitem.crawl_type /
  // crawlset.crawl_type / admin_job.crawl_type is written by this app's own
  // cron code. Recorded rather than fixed because this file pins behaviour,
  // and because it is the same class isCrawlTypeOption already guards against
  // in crawlSets.ts -- which is the evidence that the class is considered live
  // in this repo.
  it("does NOT default inherited Object.prototype keys, returning a function instead", () => {
    expect(typeof crawlTypeIcon("toString")).toBe("function");
    expect(typeof crawlTypeIcon("constructor")).toBe("function");
    expect(crawlTypeIcon("toString")).not.toBe('<span class="mdi mdi-help-circle"></span>');
    // "__proto__" resolves through the prototype getter to an object.
    expect(typeof crawlTypeIcon("__proto__")).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// getNeedsForFoodbankTab -- the LEFT half of the needs/orders tab
// ---------------------------------------------------------------------------

describe("getNeedsForFoodbankTab", () => {
  // gfadmin/views.py:644 is
  // `FoodbankChange.objects.filter(foodbank=foodbank).order_by("-created")[:200]`.
  // The cap keeps the NEWEST rows -- a LIMIT applied before the sort hands back
  // the same COUNT of rows and the wrong page.
  //
  // THE IDS ARE SCRAMBLED (3, 1, 4, 2 in `created` order) rather than merely
  // reversed. An earlier version of this fixture had ids ascending against
  // descending dates, which kills `ORDER BY id DESC` but blesses `ORDER BY id`
  // and, worse, blesses deleting the ORDER BY altogether: an unordered SELECT
  // comes back in rowid order, which was exactly the expected answer. Both
  // directions have to be wrong for the assertion to mean anything.
  //
  // `modified` is seeded to DISAGREE with `created` -- needs 1 and 2 were
  // edited days after they were written, which is what happens when an admin
  // re-categorises or corrects one. Without that, `ORDER BY modified DESC` is
  // a one-word edit that no test in this file could see, and it would silently
  // reorder the tab (and re-cut the 200-row window) the first time anyone
  // touched an old need.
  it("orders by created DESC -- not by id, not by modified -- and applies LIMIT after the sort", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedNeed(db, { id: 3, needId: "c".repeat(32), foodbankId: SALISBURY, created: "2026-09-05 18:00:00.000000", modified: "2026-09-05 18:00:00.000000" });
    seedNeed(db, { id: 1, needId: "a".repeat(32), foodbankId: SALISBURY, created: "2026-09-05 16:00:00.000000", modified: "2026-09-06 09:00:00.000000" });
    seedNeed(db, { id: 4, needId: "d".repeat(32), foodbankId: SALISBURY, created: "2026-09-05 14:00:00.000000", modified: "2026-09-05 14:00:00.000000" });
    seedNeed(db, { id: 2, needId: "b".repeat(32), foodbankId: SALISBURY, created: "2026-09-05 12:00:00.000000", modified: "2026-09-07 09:00:00.000000" });

    // created DESC = [3,1,4,2]; id ASC = [1,2,3,4]; id DESC = [4,3,2,1];
    // created ASC = [2,4,1,3]; modified DESC = [2,1,3,4]. All four wrong
    // answers are distinct from the right one, in the full read and the capped
    // one alike.
    expect((await getNeedsForFoodbankTab(d1Session(db), SALISBURY, 200)).map((r) => r.id)).toEqual([3, 1, 4, 2]);
    expect((await getNeedsForFoodbankTab(d1Session(db), SALISBURY, 2)).map((r) => r.id)).toEqual([3, 1]);
  });

  // AN ADMITTED BLIND SPOT, recorded so the next reviewer does not spend an
  // afternoon rediscovering it. DELETING the `ORDER BY` from two of this
  // module's four tab queries is undetectable from any fixture, because an
  // index already answers them in the right order:
  //   * foodbankchange -- change_foodbank_created_idx (0001_core.sql:124) is
  //     `(foodbank_id, created DESC)`, so `WHERE foodbank_id = ?` on its own
  //     seeks that index and the rows arrive sorted;
  //   * orders -- order_foodbank_delivery_idx (0005:34) is
  //     `(foodbank_id, delivery_datetime DESC)`, the same shape, which is also
  //     why `ORDER BY delivery_date DESC` (the same key one resolution
  //     coarser) cannot be caught: the sorter is handed rows already in
  //     delivery_datetime order and leaves the ties as it found them.
  // Nothing above is true of foodbankarticle or crawlitem, whose ORDER BY
  // deletions ARE killed by the fixtures in their own describes.
  //
  // The clauses are still load-bearing -- they are the only thing that holds
  // when an index is dropped or the planner picks a different path, and this is
  // D1, where we do not control the planner version. So the invariant the two
  // indexes are quietly providing is asserted here rather than assumed: if
  // either index goes, this fails and the two queries silently become
  // order-dependent on the clause alone.
  it("leans on two indexes for its ordering, which is why deleting those ORDER BYs is untestable", () => {
    const db = freshDb();
    const plan = (sql: string) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail).join(" ");

    expect(plan("SELECT * FROM foodbankchange_full WHERE foodbank_id = 7 LIMIT 200")).toContain("change_foodbank_created_idx");
    expect(plan("SELECT id, delivery_datetime FROM orders WHERE foodbank_id = 7 LIMIT 200")).toContain("order_foodbank_delivery_idx");
    // The counter-example, and the reason the articles fixture had to be
    // rebuilt: article_published_idx (0003:53) is PARTIAL -- `WHERE featured =
    // 1` -- so it cannot serve this tab at all and the plan is a bare scan.
    expect(plan("SELECT id, published_date FROM foodbankarticle WHERE foodbank_id = 7 LIMIT 20")).not.toContain("article_published_idx");
  });

  // MIXED TIMESTAMP FORMATS, which migration 0022 exists to repair and a
  // restore from a pre-0022 backup would reintroduce. This column is TEXT and
  // the comparison is byte-wise, so within a single day an ISO value sorts
  // ABOVE every space-separated one: the date prefixes match to the character,
  // and then 'T' (0x54) beats ' ' (0x20). Need 3 below is the OLDEST of the
  // three -- six hours behind the others -- and comes out at the head of a tab
  // labelled newest-first, with nothing thrown and nothing logged.
  //
  // Note it is a WITHIN-DAY hazard, not a global one: the year, month and day
  // are compared first and still dominate, so a 2025 ISO row does sort below a
  // 2026 Django one. That is what makes the bug so quiet -- the list looks
  // right until you read the top of it.
  it("sorts an unnormalised ISO timestamp above every same-day Django-format one, whatever instant it names", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedNeed(db, { id: 1, needId: "a".repeat(32), foodbankId: SALISBURY, created: "2026-09-05 18:00:00.000000" });
    seedNeed(db, { id: 2, needId: "b".repeat(32), foodbankId: SALISBURY, created: "2026-09-05 16:00:00.000000" });
    seedNeed(db, { id: 3, needId: "c".repeat(32), foodbankId: SALISBURY, created: "2026-09-05T12:00:00.000Z" });

    expect((await getNeedsForFoodbankTab(d1Session(db), SALISBURY, 200)).map((r) => r.id)).toEqual([3, 1, 2]);
  });

  // A filter is the one thing that passes every test written only from rows it
  // is supposed to keep, so the rows that MUST be excluded are seeded and
  // outnumber the kept one: another food bank's need, and an unassigned need
  // (foodbank_id IS NULL -- a real state, see FoodbankChange.clean(), which
  // only forbids publishing one). Binding [foodbankId, limit] against
  // `WHERE ... = ? ... LIMIT ?` in the wrong order would bind 200 as the food
  // bank id and return an empty tab rather than an error, so the kept result
  // is asserted non-empty too.
  it("returns only this food bank's needs, excluding another's and the unassigned", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedFoodbank(db, AMESBURY, "Amesbury", "amesbury");
    seedNeed(db, { id: 1, needId: "a".repeat(32), foodbankId: AMESBURY, created: "2026-09-05 18:00:00.000000" });
    seedNeed(db, { id: 2, needId: "b".repeat(32), foodbankId: null, created: "2026-09-05 17:00:00.000000" });
    seedNeed(db, { id: 3, needId: "c".repeat(32), foodbankId: SALISBURY, created: "2026-09-05 16:00:00.000000" });
    seedNeed(db, { id: 4, needId: "d".repeat(32), foodbankId: AMESBURY, created: "2026-09-05 15:00:00.000000" });

    const rows = await getNeedsForFoodbankTab(d1Session(db), SALISBURY, 200);
    expect(rows.map((r) => r.id)).toEqual([3]);
  });

  // These columns are TEXT and the comparison is byte-wise, so the sort is
  // only chronological because the format is fixed-width and zero-padded.
  // Crossing a month boundary and a day boundary at once is where a format
  // that dropped its leading zeros ("2026-9-9" > "2026-10-01") comes apart,
  // and the sub-second pair is the resolution two needs actually land at when
  // a crawl writes several in one batch.
  it("sorts Django-format timestamps chronologically across month and sub-second boundaries", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedNeed(db, { id: 1, needId: "a".repeat(32), foodbankId: SALISBURY, created: "2026-09-09 15:00:00.000000" });
    seedNeed(db, { id: 2, needId: "b".repeat(32), foodbankId: SALISBURY, created: "2026-10-01 15:00:00.000000" });
    seedNeed(db, { id: 3, needId: "c".repeat(32), foodbankId: SALISBURY, created: "2026-09-09 15:00:00.001000" });

    expect((await getNeedsForFoodbankTab(d1Session(db), SALISBURY, 200)).map((r) => r.id)).toEqual([2, 3, 1]);
  });

  // MIGRATION 0019'S SCAR, tested rather than described. foodbankchange USED
  // to carry a `foodbank_name` copy, refreshed only in the child's save(), and
  // 24 production rows had drifted from their parent by the time it was
  // dropped. The name now comes off foodbankchange_full's join, live --
  // renaming the parent and re-reading is the only way to tell the two apart,
  // because a stale copy and a fresh join look identical in a single read.
  it("reads foodbank_name and foodbank_slug live from the parent, never from a copy", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedNeed(db, { id: 1, needId: "a".repeat(32), foodbankId: SALISBURY, created: "2026-09-05 18:00:00.000000" });

    const before = await getNeedsForFoodbankTab(d1Session(db), SALISBURY, 200);
    expect([before[0]!.foodbank_name, (before[0] as unknown as { foodbank_slug: string }).foodbank_slug]).toEqual(["Salisbury", "salisbury"]);

    db.prepare("UPDATE foodbank SET name = 'Salisbury Foodbank', slug = 'salisbury-foodbank' WHERE id = ?").run(SALISBURY);
    const after = await getNeedsForFoodbankTab(d1Session(db), SALISBURY, 200);
    expect([after[0]!.foodbank_name, (after[0] as unknown as { foodbank_slug: string }).foodbank_slug]).toEqual(["Salisbury Foodbank", "salisbury-foodbank"]);
  });

  // foodbankchange_full is a LEFT JOIN (0019's own comment says why:
  // foodbank_id is nullable and D1 declares no foreign keys, so nothing stops
  // a parent row being deleted out from under a need). Turn it inner and the
  // orphaned need disappears from the tab entirely -- a silently shorter list,
  // never an error. The needs tab is where an admin would go looking for it.
  it("keeps a need whose food bank row has vanished, with a null name", async () => {
    const db = freshDb();
    seedNeed(db, { id: 1, needId: "a".repeat(32), foodbankId: 404, created: "2026-09-05 18:00:00.000000" });

    const rows = await getNeedsForFoodbankTab(d1Session(db), 404, 200);
    expect(rows.map((r) => r.id)).toEqual([1]);
    expect(rows[0]!.foodbank_name).toBeNull();
  });

  // mapNeedRow's coerceBooleans, through the real column values D1 stores.
  // `nonpertinent` is documented tri-state (0001_core.sql: "NULLABLE: NULL is
  // NOT 0") and the needsorders template branches on it -- so NULL must stay
  // null rather than becoming false. It matters here more than most places
  // because getCrawlSetJson, four functions down this same file, collapses the
  // same column to false; a reader who assumes one behaviour from the other
  // gets it wrong.
  it("coerces 0/1 to booleans while preserving a tri-state NULL", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedNeed(db, { id: 1, needId: "a".repeat(32), foodbankId: SALISBURY, created: "2026-09-05 18:00:00.000000", published: 1, nonpertinent: null, isCategorised: null });
    seedNeed(db, { id: 2, needId: "b".repeat(32), foodbankId: SALISBURY, created: "2026-09-05 17:00:00.000000", published: 0, nonpertinent: 1, isCategorised: 0 });

    const [first, second] = await getNeedsForFoodbankTab(d1Session(db), SALISBURY, 200);
    expect([first!.published, first!.nonpertinent, first!.is_categorised]).toEqual([true, null, null]);
    expect([second!.published, second!.nonpertinent, second!.is_categorised]).toEqual([false, true, false]);
  });

  // The template contract, pinned as a set. `SELECT *` on the view means the
  // row is whatever foodbankchange currently holds plus the join's two
  // columns; needsorders.njk reads need_id, change_text, excess_change_text,
  // created and modified by name, and Nunjucks renders a missing one as the
  // empty string -- so a column dropped by a future migration shows up as a
  // blank cell, never as an error. That is migration 0019's failure mode
  // exactly. foodbank_slug is in the set although FoodbankChangeRow does not
  // declare it: `SELECT *` on foodbankchange_full returns it regardless, and
  // pinning the truth beats pinning the type.
  it("returns every foodbankchange column plus the view's two joined ones", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedNeed(db, { id: 1, needId: "a".repeat(32), foodbankId: SALISBURY, created: "2026-09-05 18:00:00.000000" });

    const [row] = await getNeedsForFoodbankTab(d1Session(db), SALISBURY, 200);
    expect(Object.keys(row!).sort()).toEqual([
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
    ]);
  });
});

// ---------------------------------------------------------------------------
// getOrdersForFoodbankTab -- the RIGHT half of the same tab
// ---------------------------------------------------------------------------

describe("getOrdersForFoodbankTab", () => {
  // THE MUTANT THIS FUNCTION'S OWN COMMENT WARNS ABOUT. gfadmin/views.py:645
  // is `.order_by("-delivery_datetime")`, NOT the "-created" its neighbour on
  // the same screen uses. The orders table renders delivery_datetime as its
  // Date column (foodbank.html:522), so sorting by `created` shows a Date
  // column out of date order -- and applies the 200-row cap to a different
  // 200 rows. Seeded so the two keys DISAGREE completely (created ascends as
  // delivery descends), which is realistic: orders are entered days before
  // they are delivered, and back-dated corrections are entered afterwards.
  //
  // Ids are SCRAMBLED (3, 1, 4, 2 in delivery order), not merely reversed, so
  // that `ORDER BY id` fails in both directions -- a fixture whose rowid order
  // happens to be the right answer blesses an unordered SELECT.
  //
  // The first two orders share a delivery DATE and differ only in the hour,
  // which is the one shape `unique_together = ('foodbank', 'delivery_date',
  // 'delivery_provider')` (models/orders.py:57) still allows: two providers
  // delivering to one food bank on one day. It is also the only shape that can
  // tell `delivery_datetime` apart from `delivery_date`, which are otherwise
  // the same key at different resolutions.
  it("orders by delivery_datetime DESC, never by created", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedOrder(db, { id: 3, orderId: "same-day-pm", foodbankId: SALISBURY, created: "2026-01-01 09:00:00.000000", deliveryDatetime: "2026-09-05 17:00:00.000000", deliveryProvider: "Tesco" });
    seedOrder(db, { id: 1, orderId: "same-day-am", foodbankId: SALISBURY, created: "2026-02-01 09:00:00.000000", deliveryDatetime: "2026-09-05 09:00:00.000000", deliveryProvider: "Sainsbury's" });
    // 19:00 and 06:00 -- both in DELIVERY_HOURS (const/general.py:1, 6 to 22).
    // The HOURS are deliberately out of step with the dates, so that ordering
    // on `delivery_hour` alone (the third column that looks like this key)
    // puts yesterday's evening delivery above today's afternoon one.
    seedOrder(db, { id: 4, orderId: "day-before", foodbankId: SALISBURY, created: "2026-03-01 09:00:00.000000", deliveryDatetime: "2026-09-04 19:00:00.000000" });
    seedOrder(db, { id: 2, orderId: "months-back", foodbankId: SALISBURY, created: "2026-04-01 09:00:00.000000", deliveryDatetime: "2026-07-05 06:00:00.000000" });

    expect((await getOrdersForFoodbankTab(d1Session(db), SALISBURY, 200)).map((r) => r.order_id)).toEqual(["same-day-pm", "same-day-am", "day-before", "months-back"]);
    // The cap keeps the most recently DELIVERED, which here is the oldest
    // created -- an `ORDER BY created DESC LIMIT 2` returns months-back and
    // day-before, a completely disjoint pair.
    expect((await getOrdersForFoodbankTab(d1Session(db), SALISBURY, 2)).map((r) => r.order_id)).toEqual(["same-day-pm", "same-day-am"]);
  });

  // orders.foodbank_id is NULLABLE (0005) -- a delivery not yet attributed to
  // a food bank. Both it and another food bank's orders must be absent; a
  // filter that did nothing would show one food bank another's spending.
  it("returns only this food bank's orders, excluding another's and the unattributed", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedFoodbank(db, AMESBURY, "Amesbury", "amesbury");
    seedOrder(db, { id: 1, orderId: "amesbury-1", foodbankId: AMESBURY, created: "2026-01-01 09:00:00.000000", deliveryDatetime: "2026-09-05 09:00:00.000000" });
    seedOrder(db, { id: 2, orderId: "unattributed", foodbankId: null, created: "2026-01-01 09:00:00.000000", deliveryDatetime: "2026-09-04 09:00:00.000000" });
    seedOrder(db, { id: 3, orderId: "salisbury-1", foodbankId: SALISBURY, created: "2026-01-01 09:00:00.000000", deliveryDatetime: "2026-09-03 09:00:00.000000" });

    expect((await getOrdersForFoodbankTab(d1Session(db), SALISBURY, 200)).map((r) => r.order_id)).toEqual(["salisbury-1"]);
  });

  // `actual_cost` is deliberately NOT selected -- the module's own comment
  // says so, and the template's Cost column is Order.natural_cost()
  // (models/orders.py:74-75), a bare float(cost/100) with no actual_cost
  // branch. The row is seeded with a WILDLY different actual_cost so that a
  // SELECT which quietly started returning it, and a template that then
  // preferred it, would be a visible failure here rather than a 20% error in
  // the admin's spend figures.
  //
  // The other absentees matter for a different reason: items_text, weight and
  // calories are the heavy columns on this table, and `SELECT *` here would
  // pull all of them for 200 rows on every tab open. D1 meters rows scanned,
  // but the payload is real.
  it("selects exactly the eight columns the template reads -- no actual_cost, no items_text", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedOrder(db, {
      id: 1,
      orderId: "GF-2026-0001",
      foodbankId: SALISBURY,
      created: "2026-08-30 11:04:00.000000",
      deliveryDatetime: "2026-09-05 09:00:00.000000",
      deliveryProvider: "Sainsbury's",
      noItems: 138,
      cost: 4250,
      actualCost: 999_999,
      notificationEmailSent: "2026-09-05 09:12:00.000000",
    });

    const [row] = await getOrdersForFoodbankTab(d1Session(db), SALISBURY, 200);
    expect(Object.keys(row!).sort()).toEqual(["cost", "created", "delivery_datetime", "delivery_provider", "id", "no_items", "notification_email_sent", "order_id"]);
    expect({ ...row! }).toEqual({
      id: 1,
      order_id: "GF-2026-0001",
      created: "2026-08-30 11:04:00.000000",
      delivery_datetime: "2026-09-05 09:00:00.000000",
      delivery_provider: "Sainsbury's",
      no_items: 138,
      cost: 4250,
      notification_email_sent: "2026-09-05 09:12:00.000000",
    });
  });

  // The nullable pair, which the template branches on: no provider means no
  // icon cell, no notification_email_sent means no envelope. Coercing either
  // to a string would put an empty <img> and a permanent envelope on every
  // row.
  it("hands back nulls for an order with no provider and no notification", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedOrder(db, { id: 1, orderId: "ord-1", foodbankId: SALISBURY, created: "2026-01-01 09:00:00.000000", deliveryDatetime: "2026-09-05 09:00:00.000000" });

    const [row] = await getOrdersForFoodbankTab(d1Session(db), SALISBURY, 200);
    expect(row!.delivery_provider).toBeNull();
    expect(row!.notification_email_sent).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getArticlesForFoodbankTab
// ---------------------------------------------------------------------------

describe("getArticlesForFoodbankTab", () => {
  // gfadmin/views.py:659 is
  // `FoodbankArticle.objects.filter(foodbank=foodbank).order_by("-published_date")[:20]`.
  //
  // THE ONLY ORDER BY IN THIS MODULE THAT NO INDEX BACKS. The one index on this
  // table, article_published_idx (0003:53), is PARTIAL -- `WHERE featured = 1`
  // -- so it cannot answer this query and the plan is a bare
  // "SCAN foodbankarticle". Deleting the ORDER BY therefore hands back rowid
  // order, which is why the ids here are SCRAMBLED (3, 1, 4, 2 in publication
  // order) rather than simply reversed: with ids ascending against descending
  // dates, an unordered SELECT returns precisely the expected answer and the
  // deletion is invisible. Both `ORDER BY id` directions and the missing clause
  // all fail against this fixture.
  it("orders by published_date DESC, not by id or insertion order, and applies Django's cap after the sort", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedArticle(db, { id: 3, foodbankId: SALISBURY, publishedDate: "2026-09-05 08:00:00.000000", title: "Newest" });
    seedArticle(db, { id: 1, foodbankId: SALISBURY, publishedDate: "2026-08-05 08:00:00.000000", title: "Second" });
    seedArticle(db, { id: 4, foodbankId: SALISBURY, publishedDate: "2026-07-05 08:00:00.000000", title: "Third" });
    seedArticle(db, { id: 2, foodbankId: SALISBURY, publishedDate: "2026-06-05 08:00:00.000000", title: "Oldest" });

    expect((await getArticlesForFoodbankTab(d1Session(db), SALISBURY, 20)).map((r) => r.title)).toEqual(["Newest", "Second", "Third", "Oldest"]);
    expect((await getArticlesForFoodbankTab(d1Session(db), SALISBURY, 2)).map((r) => r.title)).toEqual(["Newest", "Second"]);
  });

  // foodbankarticle.foodbank_id is NULLABLE (0003) and 17,196 rows share this
  // table across every food bank in the country, so the filter is the only
  // thing standing between this tab and the whole news archive.
  it("returns only this food bank's articles, excluding another's and the orphaned", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedFoodbank(db, AMESBURY, "Amesbury", "amesbury");
    seedArticle(db, { id: 1, foodbankId: AMESBURY, publishedDate: "2026-09-05 08:00:00.000000", title: "Amesbury news" });
    seedArticle(db, { id: 2, foodbankId: null, publishedDate: "2026-09-04 08:00:00.000000", title: "Orphan" });
    seedArticle(db, { id: 3, foodbankId: SALISBURY, publishedDate: "2026-09-03 08:00:00.000000", title: "Salisbury news" });

    expect((await getArticlesForFoodbankTab(d1Session(db), SALISBURY, 20)).map((r) => r.title)).toEqual(["Salisbury news"]);
  });

  // NO `featured` FILTER, matching Django -- and this is the one that would
  // silently empty the tab if someone "tidied" the query to match the
  // homepage's `WHERE featured = 1`. insertArticleIfNew writes featured=0 for
  // every row the crawler finds (articles.ts: "every new row from the crawler
  // is unfeatured until an admin curates it"), so in this table the unfeatured
  // rows ARE the content: 17,028 of 17,196.
  it("includes unfeatured articles -- the crawler writes nothing else", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedArticle(db, { id: 1, foodbankId: SALISBURY, publishedDate: "2026-09-05 08:00:00.000000", title: "Featured", featured: 1 });
    seedArticle(db, { id: 2, foodbankId: SALISBURY, publishedDate: "2026-09-04 08:00:00.000000", title: "Unfeatured", featured: 0 });

    expect((await getArticlesForFoodbankTab(d1Session(db), SALISBURY, 20)).map((r) => r.title)).toEqual(["Featured", "Unfeatured"]);
  });

  // Four columns, and `featured` is deliberately not among them: the articles
  // partial (foodbank.html:591-604) is title and timesince, with no featured
  // column at all. The toggle lives on the admin dashboard. A star rendered
  // here would be a column Django does not have.
  it("selects exactly the four columns the template reads, and not featured", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedArticle(db, { id: 41, foodbankId: SALISBURY, publishedDate: "2026-09-05 08:00:00.000000", title: "Harvest festival", url: "https://salisbury.foodbank.org.uk/harvest/", featured: 1 });

    const [row] = await getArticlesForFoodbankTab(d1Session(db), SALISBURY, 20);
    expect(Object.keys(row!).sort()).toEqual(["id", "published_date", "title", "url"]);
    expect({ ...row! }).toEqual({
      id: 41,
      published_date: "2026-09-05 08:00:00.000000",
      title: "Harvest festival",
      url: "https://salisbury.foodbank.org.uk/harvest/",
    });
  });
});

// ---------------------------------------------------------------------------
// getSubscribersForFoodbankTab -- three tables, one merged list
// ---------------------------------------------------------------------------

describe("getSubscribersForFoodbankTab", () => {
  // THE SWAP MUTANT. Three queries are fired through one Promise.all and
  // destructured as [email, webpush, mobile] -- an order that does NOT match
  // the order the results are later spread into the list (email, mobile,
  // webpush). Transposing two of those names is a one-line edit that produces
  // no error at all: `r.platform` on a webpush row is undefined, so the tab
  // renders "undefined - undefined" identifiers and swapped counts. Seeded
  // with DELIBERATELY UNEQUAL counts (1 email, 2 mobile, 3 webpush) so no two
  // channels can be mistaken for each other.
  it("counts each channel separately, from its own table", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedEmailSubscriber(db, { id: 1, foodbankId: SALISBURY, email: "a@example.org", confirmed: 1, created: "2026-09-01 09:00:00.000000" });
    seedMobileSubscriber(db, { id: 1, foodbankId: SALISBURY, deviceId: "device-1", platform: "iOS", created: "2026-09-02 09:00:00.000000" });
    seedMobileSubscriber(db, { id: 2, foodbankId: SALISBURY, deviceId: "device-2", platform: "Android", created: "2026-09-03 09:00:00.000000" });
    seedWebpushSubscription(db, { id: 1, foodbankId: SALISBURY, endpoint: "https://fcm.googleapis.com/1", browser: "Chrome", created: "2026-09-04 09:00:00.000000" });
    seedWebpushSubscription(db, { id: 2, foodbankId: SALISBURY, endpoint: "https://fcm.googleapis.com/2", browser: "Firefox", created: "2026-09-05 09:00:00.000000" });
    seedWebpushSubscription(db, { id: 3, foodbankId: SALISBURY, endpoint: "https://fcm.googleapis.com/3", browser: "Safari", created: "2026-09-06 09:00:00.000000" });

    const { subscription_counts } = await getSubscribersForFoodbankTab(d1Session(db), SALISBURY);
    expect(subscription_counts).toEqual({ email: 1, whatsapp: 0, mobile: 2, webpush: 3 });
  });

  // gfadmin/views.py:674-682's `if sub.confirmed` -- an unconfirmed email
  // subscriber counts towards NOTHING and appears in NO list; it is a
  // half-finished double opt-in, not a subscriber. The unconfirmed rows are
  // seeded to outnumber the confirmed one, because a `confirmed = 1` that went
  // missing would inflate this count with people who never replied and no page
  // would look broken.
  it("excludes unconfirmed email subscribers from both the count and the list", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedEmailSubscriber(db, { id: 1, foodbankId: SALISBURY, email: "unconfirmed-1@example.org", confirmed: 0, created: "2026-09-01 09:00:00.000000" });
    seedEmailSubscriber(db, { id: 2, foodbankId: SALISBURY, email: "unconfirmed-2@example.org", confirmed: 0, created: "2026-09-02 09:00:00.000000" });
    seedEmailSubscriber(db, { id: 3, foodbankId: SALISBURY, email: "confirmed@example.org", confirmed: 1, created: "2026-09-03 09:00:00.000000" });

    const { subscription_counts, all_subscriptions } = await getSubscribersForFoodbankTab(d1Session(db), SALISBURY);
    expect(subscription_counts.email).toBe(1);
    expect(all_subscriptions.map((s) => s.identifier)).toEqual(["confirmed@example.org"]);
  });

  // Web push and mobile have NO confirmation step, so no equivalent filter --
  // and none must be invented. Every row in those two tables is a live
  // subscription the moment it is written.
  it("does not filter web push or mobile rows the way it filters email", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedWebpushSubscription(db, { id: 1, foodbankId: SALISBURY, endpoint: "https://fcm.googleapis.com/1", browser: null, created: "2026-09-04 09:00:00.000000" });
    seedMobileSubscriber(db, { id: 1, foodbankId: SALISBURY, deviceId: "device-1", platform: "iOS", created: "2026-09-02 09:00:00.000000" });

    const { subscription_counts, all_subscriptions } = await getSubscribersForFoodbankTab(d1Session(db), SALISBURY);
    expect([subscription_counts.webpush, subscription_counts.mobile]).toEqual([1, 1]);
    // Content, not length: a `toHaveLength(2)` here passes just as happily when
    // the two rows are the same subscription twice, or when a `confirmed = 1`
    // copy-pasted onto these queries dropped one and a fan-out added another.
    expect(all_subscriptions.map((s) => [s.type, s.identifier])).toEqual([
      ["webpush", "Unknown - https://fcm.googleapis.com/1"], // created 09-04
      ["mobile", "iOS - device-1"], // created 09-02
    ]);
  });

  // All three queries are scoped by foodbank_id, and each is a separate
  // statement -- so the filter can go missing from ONE of them and the other
  // two go on looking right. Every channel therefore gets a row belonging to
  // another food bank.
  it("scopes every one of the three tables to this food bank", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedFoodbank(db, AMESBURY, "Amesbury", "amesbury");
    seedEmailSubscriber(db, { id: 1, foodbankId: AMESBURY, email: "amesbury@example.org", confirmed: 1, created: "2026-09-01 09:00:00.000000" });
    seedMobileSubscriber(db, { id: 1, foodbankId: AMESBURY, deviceId: "amesbury-device", platform: "iOS", created: "2026-09-02 09:00:00.000000" });
    seedWebpushSubscription(db, { id: 1, foodbankId: AMESBURY, endpoint: "https://fcm.googleapis.com/amesbury", browser: "Chrome", created: "2026-09-03 09:00:00.000000" });
    seedEmailSubscriber(db, { id: 2, foodbankId: SALISBURY, email: "salisbury@example.org", confirmed: 1, created: "2026-09-04 09:00:00.000000" });

    const { subscription_counts, all_subscriptions } = await getSubscribersForFoodbankTab(d1Session(db), SALISBURY);
    expect(subscription_counts).toEqual({ email: 1, whatsapp: 0, mobile: 0, webpush: 0 });
    expect(all_subscriptions.map((s) => s.identifier)).toEqual(["salisbury@example.org"]);
  });

  // gfadmin/views.py:712 is `all_subscriptions.sort(key=..., reverse=True)` --
  // ONE chronological list across every channel, matching
  // /admin/subscriptions/'s own shape, not three tables stacked. The rows are
  // seeded so the three channels must INTERLEAVE: a concatenation that forgot
  // to sort would return them grouped by type, which still renders a populated
  // table and is the wrong answer. Newest first.
  it("merges all three channels into one list ordered newest first", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedEmailSubscriber(db, { id: 1, foodbankId: SALISBURY, email: "oldest@example.org", confirmed: 1, created: "2026-09-01 09:00:00.000000" });
    seedWebpushSubscription(db, { id: 1, foodbankId: SALISBURY, endpoint: "https://fcm.googleapis.com/1", browser: "Chrome", created: "2026-09-02 09:00:00.000000" });
    seedMobileSubscriber(db, { id: 1, foodbankId: SALISBURY, deviceId: "device-1", platform: "iOS", created: "2026-09-03 09:00:00.000000" });
    seedEmailSubscriber(db, { id: 2, foodbankId: SALISBURY, email: "newest@example.org", confirmed: 1, created: "2026-09-04 09:00:00.000000" });

    const { all_subscriptions } = await getSubscribersForFoodbankTab(d1Session(db), SALISBURY);
    expect(all_subscriptions.map((s) => [s.type, s.created])).toEqual([
      ["email", "2026-09-04 09:00:00.000000"],
      ["mobile", "2026-09-03 09:00:00.000000"],
      ["webpush", "2026-09-02 09:00:00.000000"],
      ["email", "2026-09-01 09:00:00.000000"],
    ]);
  });

  // The sort is a byte-wise string comparison on TEXT columns, not a date
  // comparison -- these values never reach a Date. Crossing a month boundary
  // is where a format with unpadded components would come apart, and it is the
  // same class of bug 0022 was written to repair.
  it("compares Django-format timestamps as text, correctly across a month boundary", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedEmailSubscriber(db, { id: 1, foodbankId: SALISBURY, email: "september@example.org", confirmed: 1, created: "2026-09-09 15:00:00.000000" });
    seedEmailSubscriber(db, { id: 2, foodbankId: SALISBURY, email: "october@example.org", confirmed: 1, created: "2026-10-01 15:00:00.000000" });

    const { all_subscriptions } = await getSubscribersForFoodbankTab(d1Session(db), SALISBURY);
    expect(all_subscriptions.map((s) => s.identifier)).toEqual(["october@example.org", "september@example.org"]);
  });

  // PINNED, NOT ENDORSED. The comparator returns 0 for equal timestamps, so a
  // tie falls back to the order the three result sets were concatenated in:
  // email, then mobile, then webpush. That holds only because Array.prototype
  // .sort is stable (required since ES2019). Two subscriptions can genuinely
  // share a `created` -- the ETL wrote whole tables in one pass. Recorded so
  // that if a future change reorders the concatenation, the resulting reshuffle
  // of the tab is a deliberate edit here rather than a mystery.
  it("breaks a tie on created by concatenation order: email, mobile, webpush", async () => {
    const db = freshDb();
    const SAME = "2026-09-05 09:00:00.000000";
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedWebpushSubscription(db, { id: 1, foodbankId: SALISBURY, endpoint: "https://fcm.googleapis.com/1", browser: "Chrome", created: SAME });
    seedMobileSubscriber(db, { id: 1, foodbankId: SALISBURY, deviceId: "device-1", platform: "iOS", created: SAME });
    seedEmailSubscriber(db, { id: 1, foodbankId: SALISBURY, email: "a@example.org", confirmed: 1, created: SAME });

    const { all_subscriptions } = await getSubscribersForFoodbankTab(d1Session(db), SALISBURY);
    expect(all_subscriptions.map((s) => s.type)).toEqual(["email", "mobile", "webpush"]);
  });

  // gfadmin/views.py:42-43's DEVICE_ID_TRUNCATE_LENGTH = 20 and
  // ENDPOINT_TRUNCATE_LENGTH = 30, and Python's `if len(x) > LENGTH` -- so a
  // value of EXACTLY the limit is left alone, and one character more is cut to
  // the limit with an ellipsis appended (the result is longer than the limit,
  // which is Django's behaviour, not a bug). Both boundaries are asserted
  // because `>` and `>=` are one character apart and the difference is
  // invisible on any value that is not exactly at the limit.
  it("truncates a device id past 20 characters and an endpoint past 30, exclusive of the limit itself", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedMobileSubscriber(db, { id: 1, foodbankId: SALISBURY, deviceId: "d".repeat(20), platform: "iOS", created: "2026-09-04 09:00:00.000000" });
    seedMobileSubscriber(db, { id: 2, foodbankId: SALISBURY, deviceId: "e".repeat(21), platform: "Android", created: "2026-09-03 09:00:00.000000" });
    seedWebpushSubscription(db, { id: 1, foodbankId: SALISBURY, endpoint: "f".repeat(30), browser: "Chrome", created: "2026-09-02 09:00:00.000000" });
    seedWebpushSubscription(db, { id: 2, foodbankId: SALISBURY, endpoint: "g".repeat(31), browser: "Firefox", created: "2026-09-01 09:00:00.000000" });

    const { all_subscriptions } = await getSubscribersForFoodbankTab(d1Session(db), SALISBURY);
    expect(all_subscriptions.map((s) => s.identifier)).toEqual([
      `iOS - ${"d".repeat(20)}`, // exactly 20: untouched
      `Android - ${"e".repeat(20)}...`, // 21: cut to 20 plus an ellipsis
      `Chrome - ${"f".repeat(30)}`, // exactly 30: untouched
      `Firefox - ${"g".repeat(30)}...`,
    ]);
  });

  // webpushsubscription.browser is NULLABLE (0004) and is null for every row
  // written before the column existed. Django's `sub.browser or 'Unknown'`
  // prints a word; a bare null would render the literal "null - https://..."
  // through Nunjucks, and an empty string would leave a dangling " - ".
  it("labels a web push row with no browser as Unknown", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedWebpushSubscription(db, { id: 1, foodbankId: SALISBURY, endpoint: "https://fcm.googleapis.com/x", browser: null, created: "2026-09-04 09:00:00.000000" });

    const { all_subscriptions } = await getSubscribersForFoodbankTab(d1Session(db), SALISBURY);
    expect(all_subscriptions[0]!.identifier).toBe("Unknown - https://fcm.googleapis.com/x");
  });

  // KNOWN GAP, pinned as-is, and the reason it needs a test rather than a
  // comment: the whatsappsubscriber TABLE now exists (0020) and is populated,
  // so the zero is no longer "there is nothing to count" -- it is a hardcoded
  // literal sitting next to three real counts on the same <dl>. Django's
  // foodbank_subscribers_tab counts these rows and lists them with a
  // mdi-whatsapp icon. Until this port grows the query, the tab under-reports.
  // Seeded rows prove the zero is a literal and not an empty table.
  it("reports whatsapp as a hardcoded 0 even when subscribers exist, and omits them from the list", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedWhatsappSubscriber(db, { id: 1, foodbankId: SALISBURY, phoneNumber: "+447700900001", created: "2026-09-05 09:00:00.000000" });
    seedWhatsappSubscriber(db, { id: 2, foodbankId: SALISBURY, phoneNumber: "+447700900002", created: "2026-09-04 09:00:00.000000" });

    const { subscription_counts, all_subscriptions } = await getSubscribersForFoodbankTab(d1Session(db), SALISBURY);
    expect(subscription_counts.whatsapp).toBe(0);
    expect(all_subscriptions).toEqual([]);
  });

  // A food bank with no subscribers at all is the common case -- most have
  // none. Four zeroes and an empty array, never undefined: subscribers.njk
  // prints the counts unconditionally and would render "undefined" in the
  // <dd>.
  it("returns four zeroes and an empty list for a food bank nobody follows", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");

    expect(await getSubscribersForFoodbankTab(d1Session(db), SALISBURY)).toEqual({
      subscription_counts: { email: 0, whatsapp: 0, mobile: 0, webpush: 0 },
      all_subscriptions: [],
    });
  });

  // The four keys the template reads off each row, and the exact emoji markup
  // (rendered through `| safe`, so a typo is a missing glyph rather than an
  // error). The identifier formats are Django's f-strings verbatim:
  // "platform - device", "browser - endpoint", and the bare email address.
  it("builds each row's type, emoji and identifier the way Django's f-strings do", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedEmailSubscriber(db, { id: 1, foodbankId: SALISBURY, email: "a@example.org", confirmed: 1, created: "2026-09-03 09:00:00.000000" });
    seedMobileSubscriber(db, { id: 1, foodbankId: SALISBURY, deviceId: "device-1", platform: "iOS", created: "2026-09-02 09:00:00.000000" });
    seedWebpushSubscription(db, { id: 1, foodbankId: SALISBURY, endpoint: "https://fcm.googleapis.com/x", browser: "Chrome", created: "2026-09-01 09:00:00.000000" });

    const { all_subscriptions } = await getSubscribersForFoodbankTab(d1Session(db), SALISBURY);
    expect(all_subscriptions).toEqual([
      { type: "email", type_emoji: '<span class="mdi mdi-email"></span>', identifier: "a@example.org", created: "2026-09-03 09:00:00.000000" },
      { type: "mobile", type_emoji: '<span class="mdi mdi-cellphone"></span>', identifier: "iOS - device-1", created: "2026-09-02 09:00:00.000000" },
      { type: "webpush", type_emoji: '<span class="mdi mdi-bell"></span>', identifier: "Chrome - https://fcm.googleapis.com/x", created: "2026-09-01 09:00:00.000000" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// getCrawlItemsForFoodbankTab
// ---------------------------------------------------------------------------

describe("getCrawlItemsForFoodbankTab", () => {
  // gfadmin/views.py:723 is
  // `CrawlItem.objects.filter(foodbank=foodbank).order_by("-start")[:100]`.
  //
  // `start` AND `finish` DELIBERATELY DISAGREE, and that is the whole point of
  // this fixture. The only index on this table is
  // crawlitem_foodbank_finish_idx (0008:45) -- `(foodbank_id, finish DESC)` --
  // so `WHERE foodbank_id = ?` with the ORDER BY deleted is answered straight
  // out of that index and comes back in FINISH order. With every row seeded
  // finish-NULL, or with finish agreeing with start, both "delete the ORDER BY"
  // and "order by finish instead" return exactly the right answer and no
  // assertion can see them. Item 1 is the disagreement: it started second but
  // took three and a half hours, so it finished last. That is not contrived --
  // a `need` crawl waits on a food bank's own web server, and the slow ones are
  // slow by minutes or hours.
  //
  // Ids are also scrambled (3, 1, 4, 2 in start order) so `ORDER BY id` fails
  // in both directions, and item 2 is left unfinished because a stalled row is
  // the normal state of the newest entries on this tab.
  it("orders by start DESC -- not by id, not by finish, not by insertion -- and applies Django's 100-cap after the sort", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedCrawlItem(db, { id: 3, crawl_set_id: null, start: "2026-09-05 18:00:00.000000", finish: "2026-09-05 18:00:05.000000", foodbank_id: SALISBURY });
    seedCrawlItem(db, { id: 1, crawl_set_id: null, start: "2026-09-05 16:00:00.000000", finish: "2026-09-05 19:30:00.000000", foodbank_id: SALISBURY });
    seedCrawlItem(db, { id: 4, crawl_set_id: null, start: "2026-09-05 14:00:00.000000", finish: "2026-09-05 14:00:02.000000", foodbank_id: SALISBURY });
    seedCrawlItem(db, { id: 2, crawl_set_id: null, start: "2026-09-05 12:00:00.000000", finish: null, foodbank_id: SALISBURY });

    // start DESC = [3,1,4,2]; finish DESC (NULLs last) = [1,3,4,2]; id ASC =
    // [1,2,3,4]; id DESC = [4,3,2,1]; start ASC = [2,4,1,3].
    expect((await getCrawlItemsForFoodbankTab(d1Session(db), SALISBURY, 100)).map((r) => r.id)).toEqual([3, 1, 4, 2]);
    expect((await getCrawlItemsForFoodbankTab(d1Session(db), SALISBURY, 2)).map((r) => r.id)).toEqual([3, 1]);
  });

  // This tab is per FOOD BANK, so unlike /admin/crawl_sets/'s Ad Hoc table it
  // must show BOTH the ad-hoc items (crawl_set_id NULL, from the page's own
  // Force Check button) AND the items produced by the nightly sweeps. Copying
  // getOrphanedCrawlItems' `crawl_set_id IS NULL` over here would hide the
  // nightly crawls, which are the overwhelming majority -- and leave a
  // populated-looking tab holding only the buttons the admin pressed himself.
  it("shows sweep items and ad-hoc items alike, filtered only by food bank", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedFoodbank(db, AMESBURY, "Amesbury", "amesbury");
    seedCrawlSet(db, { id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });
    seedCrawlItem(db, { id: 100, crawl_set_id: 10, start: "2026-09-05 18:00:00.000000", foodbank_id: SALISBURY });
    seedCrawlItem(db, { id: 101, crawl_set_id: null, start: "2026-09-05 17:00:00.000000", foodbank_id: SALISBURY });
    // Another food bank's item, in the same sweep -- the row the filter exists
    // to exclude.
    seedCrawlItem(db, { id: 102, crawl_set_id: 10, start: "2026-09-05 19:00:00.000000", foodbank_id: AMESBURY });

    expect((await getCrawlItemsForFoodbankTab(d1Session(db), SALISBURY, 100)).map((r) => r.id)).toEqual([100, 101]);
  });

  // time_taken_ms is derived here rather than stored, matching
  // CrawlItem.time_taken_ms() (models/analytics.py:73-76). The template prints
  // it raw ("{{ item.time_taken_ms }} ms"), so this number IS the cell.
  it("derives time_taken_ms as finish minus start, in milliseconds", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedCrawlItem(db, { id: 1, crawl_set_id: null, start: "2026-09-05 18:00:00.000000", finish: "2026-09-05 18:00:02.500000", foodbank_id: SALISBURY });

    expect((await getCrawlItemsForFoodbankTab(d1Session(db), SALISBURY, 100))[0]!.time_taken_ms).toBe(2500);
  });

  // A crawl item with no finish is a stalled or crashed run (0008's own
  // comment: "a row with finish IS NULL is exactly how a stalled/crashed run
  // is detected"), and the template prints a red "Unfinished" for it. NULL,
  // never 0 -- a 0 would claim the crawl completed instantly, which is the
  // opposite of what the row means. `item.finish ? ... : null` is a
  // truthiness check, so this also pins that no empty-string finish sneaks
  // through as a duration.
  it("leaves time_taken_ms null for an unfinished item rather than reporting 0", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedCrawlItem(db, { id: 1, crawl_set_id: null, start: "2026-09-05 18:00:00.000000", finish: null, foodbank_id: SALISBURY });

    const [row] = await getCrawlItemsForFoodbankTab(d1Session(db), SALISBURY, 100);
    expect(row!.time_taken_ms).toBeNull();
    expect(row!.finish).toBeNull();
  });

  // KNOWN SUB-MILLISECOND DIVERGENCE, pinned rather than fixed. Django
  // computes `int((finish - start).total_seconds() * 1000)` at MICROSECOND
  // resolution and truncates once; the port truncates EACH timestamp to
  // milliseconds first (JavaScript's Date has no finer unit) and subtracts. On
  // a one-microsecond crawl that straddles a millisecond boundary the port
  // says 1 ms where Django says 0. The two agree everywhere else -- the second
  // case here is the ordinary one, and it is asserted alongside so this test
  // reads as "one boundary artefact", not "the arithmetic is wrong".
  it("can differ from Django by 1ms when a duration straddles a millisecond boundary", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    // 1 microsecond of real elapsed time. Django: int(0.000001 * 1000) = 0.
    seedCrawlItem(db, { id: 1, crawl_set_id: null, start: "2026-09-05 18:00:00.999999", finish: "2026-09-05 18:00:01.000000", foodbank_id: SALISBURY });
    // 123.456 ms. Django: int(123.456) = 123, and so does this.
    seedCrawlItem(db, { id: 2, crawl_set_id: null, start: "2026-09-05 17:00:00.000000", finish: "2026-09-05 17:00:00.123456", foodbank_id: SALISBURY });

    const byId = new Map((await getCrawlItemsForFoodbankTab(d1Session(db), SALISBURY, 100)).map((r) => [r.id, r.time_taken_ms]));
    expect(byId.get(1)).toBe(1); // Django: 0
    expect(byId.get(2)).toBe(123); // Django: 123
  });

  // The template contract, pinned as a set: a column dropped from the SELECT
  // renders as a blank cell through Nunjucks, never as an error. `need_id` is
  // in the list although crawls.njk does not print it -- it is selected, so it
  // is part of the contract, and pinning what IS returned is what catches the
  // day someone adds a column nothing renders. `crawl_set_id`, `foodbank_id`
  // and the raw crawl_type icon are deliberately absent.
  it("returns exactly the seven keys the crawls tab reads", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedNeed(db, { id: 41, needId: "a".repeat(32), foodbankId: SALISBURY, created: "2026-09-05 18:00:00.000000" });
    seedCrawlItem(db, {
      id: 100,
      crawl_set_id: null,
      crawl_type: "check",
      start: "2026-09-05 18:00:00.000000",
      finish: "2026-09-05 18:00:04.320000",
      foodbank_id: SALISBURY,
      url: "https://salisbury.foodbank.org.uk/shopping-list/",
      need_id: 41,
    });

    const [row] = await getCrawlItemsForFoodbankTab(d1Session(db), SALISBURY, 100);
    expect(Object.keys(row!).sort()).toEqual(["crawl_type", "finish", "id", "need_id", "start", "time_taken_ms", "url"]);
    expect({ ...row! }).toEqual({
      id: 100,
      crawl_type: "check",
      start: "2026-09-05 18:00:00.000000",
      finish: "2026-09-05 18:00:04.320000",
      url: "https://salisbury.foodbank.org.uk/shopping-list/",
      need_id: 41,
      time_taken_ms: 4320,
    });
  });
});

// ---------------------------------------------------------------------------
// getCrawlSetJson -- the crawl set page AND the JSON it polls
// ---------------------------------------------------------------------------

describe("getCrawlSetJson", () => {
  // get_object_or_404(CrawlSet, pk=crawl_set_id). Null, not an empty
  // CrawlSetJson: the two routes that call this (crawlSet.ts and
  // crawlSets.ts's JSON endpoint) turn it into a 404, and an empty-but-present
  // object would render a crawl set page for a crawl set that does not exist.
  it("returns null for a crawl set id that does not exist", async () => {
    expect(await getCrawlSetJson(d1Session(freshDb()), 999)).toBeNull();
  });

  // THE POSTGRES NULL-ORDERING EMULATION, which is the reason the leading
  // `(ci.need_id IS NULL)` key exists at all. Django runs on Postgres
  // (settings.py:141), where an ASC sort puts NULLs LAST, so views.py:3273's
  // order_by("object_id", "-start") floats the items that actually produced a
  // need to the TOP. SQLite sorts NULLs FIRST, which buried the only
  // interesting rows on a several-hundred-row `need` crawl past the end of the
  // first screenful. Seeded so all three ORDER BY keys are load-bearing:
  //   * the two need-bearing items are NOT the newest, so a plain start DESC
  //     puts them in the middle;
  //   * need 40 started LATER than need 41, so ordering the need-bearing pair
  //     by start instead of need_id reverses them;
  //   * the three null-need items descend by start, so an ASC there fails.
  // One item per food bank, because crawlitem_crawlset_foodbank_uniq is
  // UNIQUE(crawl_set_id, foodbank_id).
  it("floats items that produced a need to the top, need_id ascending, then the rest newest first", async () => {
    const db = freshDb();
    for (const id of [1, 2, 3, 4, 5]) seedFoodbank(db, id, `FB ${id}`, `fb-${id}`);
    seedNeed(db, { id: 40, needId: "4".repeat(32), foodbankId: 2, created: "2026-09-05 15:00:00.000000" });
    seedNeed(db, { id: 41, needId: "5".repeat(32), foodbankId: 1, created: "2026-09-05 15:00:00.000000" });
    seedCrawlSet(db, { id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });
    seedCrawlItem(db, { id: 1, crawl_set_id: 10, start: "2026-09-05 15:00:01.000000", foodbank_id: 1, need_id: 41 });
    seedCrawlItem(db, { id: 2, crawl_set_id: 10, start: "2026-09-05 15:00:09.000000", foodbank_id: 2, need_id: 40 });
    seedCrawlItem(db, { id: 3, crawl_set_id: 10, start: "2026-09-05 15:00:20.000000", foodbank_id: 3, need_id: null });
    seedCrawlItem(db, { id: 4, crawl_set_id: 10, start: "2026-09-05 15:00:10.000000", foodbank_id: 4, need_id: null });
    seedCrawlItem(db, { id: 5, crawl_set_id: 10, start: "2026-09-05 15:00:30.000000", foodbank_id: 5, need_id: null });

    const data = await getCrawlSetJson(d1Session(db), 10);
    expect(data!.items.map((i) => i.foodbank_slug)).toEqual(["fb-2", "fb-1", "fb-5", "fb-3", "fb-4"]);
  });

  // The crawl set's own items and nothing else. Another set's items and the
  // ad-hoc ones (crawl_set_id NULL, which `= ?` is never true for) both have
  // to be absent -- a missing predicate here would show every crawl item in
  // the database on one page and report an item_count in the thousands.
  it("returns only this crawl set's items, not another set's and not the ad-hoc ones", async () => {
    const db = freshDb();
    for (const id of [1, 2, 3]) seedFoodbank(db, id, `FB ${id}`, `fb-${id}`);
    seedCrawlSet(db, { id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });
    seedCrawlSet(db, { id: 11, crawl_type: "need", start: "2026-09-04 15:00:00.000000" });
    seedCrawlItem(db, { id: 100, crawl_set_id: 10, start: "2026-09-05 15:00:01.000000", foodbank_id: 1 });
    seedCrawlItem(db, { id: 101, crawl_set_id: 11, start: "2026-09-04 15:00:01.000000", foodbank_id: 1 });
    seedCrawlItem(db, { id: 102, crawl_set_id: null, start: "2026-09-05 16:00:00.000000", foodbank_id: 2 });

    const data = await getCrawlSetJson(d1Session(db), 10);
    expect(data!.item_count).toBe(1);
    expect(data!.items.map((i) => i.foodbank_slug)).toEqual(["fb-1"]);
  });

  // views.py:3286-3299's three-way branch on the generic FK, which this port
  // collapses to crawlitem.need_id:
  //   need_id NULL                       -> object is null (the crawl found
  //                                         nothing; most items)
  //   need_id set, foodbankchange gone   -> {"status": "deleted"} (D1 has no
  //                                         foreign keys, so deleting a need
  //                                         by hand leaves the pointer behind)
  //   need_id set, row present           -> the full object
  // The middle case is the whole reason the join is LEFT: make it inner and
  // those rows vanish from the page instead of being labelled deleted, which
  // is a silently shorter list.
  it("distinguishes no need, a deleted need and a live need", async () => {
    const db = freshDb();
    for (const id of [1, 2, 3]) seedFoodbank(db, id, `FB ${id}`, `fb-${id}`);
    seedNeed(db, { id: 41, needId: "abcdef1234567890abcdef1234567890", foodbankId: 1, created: "2026-09-05 15:00:00.000000", published: 1, nonpertinent: 0 });
    seedCrawlSet(db, { id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });
    seedCrawlItem(db, { id: 100, crawl_set_id: 10, start: "2026-09-05 15:00:01.000000", foodbank_id: 1, need_id: 41 });
    // Points at a foodbankchange row that no longer exists.
    seedCrawlItem(db, { id: 101, crawl_set_id: 10, start: "2026-09-05 15:00:02.000000", foodbank_id: 2, need_id: 999 });
    seedCrawlItem(db, { id: 102, crawl_set_id: 10, start: "2026-09-05 15:00:03.000000", foodbank_id: 3, need_id: null });

    const data = await getCrawlSetJson(d1Session(db), 10);
    expect(data!.items.map((i) => i.object)).toEqual([
      {
        // FoodbankChange.get_absolute_url()'s admin equivalent, built from the
        // 32-char UUID -- NOT the crawl item's integer need_id, which would
        // link to nowhere.
        url: "/admin/need/abcdef1234567890abcdef1234567890/",
        class_name: "FoodbankChange",
        // models/needs.py:81-82's need_id_short(): str(need_id)[:7]. SEVEN,
        // not eight -- an off-by-one here changes every link label on the page.
        need_id_short: "abcdef1",
        nonpertinent: false,
        published: true,
      },
      { status: "deleted" },
      null,
    ]);
  });

  // KNOWN DIVERGENCE, pinned rather than fixed, and worth knowing about
  // precisely because the SAME COLUMN is handled differently 200 lines up this
  // file: getNeedsForFoodbankTab preserves nonpertinent's documented tri-state
  // (0001_core.sql: "NULLABLE: NULL is NOT 0"), while this function's
  // `=== 1` collapses NULL to false. Django's JSON would emit null here.
  // Nothing in the crawl set page distinguishes the two -- both render an
  // unhighlighted row -- so the cost today is nil; the risk is a reader
  // assuming one function's behaviour from the other's.
  it("collapses a NULL nonpertinent to false, unlike the needs tab's tri-state", async () => {
    const db = freshDb();
    seedFoodbank(db, 1, "FB 1", "fb-1");
    seedNeed(db, { id: 41, needId: "a".repeat(32), foodbankId: 1, created: "2026-09-05 15:00:00.000000", published: 0, nonpertinent: null });
    seedCrawlSet(db, { id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });
    seedCrawlItem(db, { id: 100, crawl_set_id: 10, start: "2026-09-05 15:00:01.000000", foodbank_id: 1, need_id: 41 });

    const [item] = (await getCrawlSetJson(d1Session(db), 10))!.items;
    expect(item!.object).toMatchObject({ nonpertinent: false, published: false });
  });

  // CrawlSet.item_count() vs object_count() (models/analytics.py:48-53) --
  // "items that produced a need" against "every item regardless of outcome".
  // The two numbers are printed side by side, so a filter that did nothing
  // would make every crawl look 100% productive and one that inverted would
  // make every crawl look barren. The FINISHED-BUT-FRUITLESS item is the point
  // of the third row: `finish` is not what is being counted.
  it("counts every item, and separately only those that produced a need", async () => {
    const db = freshDb();
    for (const id of [1, 2, 3]) seedFoodbank(db, id, `FB ${id}`, `fb-${id}`);
    seedNeed(db, { id: 41, needId: "a".repeat(32), foodbankId: 1, created: "2026-09-05 15:00:00.000000" });
    seedCrawlSet(db, { id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });
    seedCrawlItem(db, { id: 100, crawl_set_id: 10, start: "2026-09-05 15:00:01.000000", finish: "2026-09-05 15:00:03.000000", foodbank_id: 1, need_id: 41 });
    seedCrawlItem(db, { id: 101, crawl_set_id: 10, start: "2026-09-05 15:00:02.000000", finish: "2026-09-05 15:00:04.000000", foodbank_id: 2, need_id: null });
    seedCrawlItem(db, { id: 102, crawl_set_id: 10, start: "2026-09-05 15:00:03.000000", finish: null, foodbank_id: 3, need_id: null });

    const data = await getCrawlSetJson(d1Session(db), 10);
    expect(data!.item_count).toBe(3);
    expect(data!.object_count).toBe(1);
  });

  // The per-item duration, on the page that polls itself while the crawl is
  // still running -- so an item with no finish yet is the NORMAL state here,
  // not an edge case, and it is the majority of the list for the first few
  // minutes of a 1,071-food-bank sweep. NULL, never 0 and never a NaN: the
  // template prints the number raw, so a NaN would read as "NaN ms" on every
  // in-flight row and a 0 would claim each one finished instantly. Found by
  // mutation testing -- an unconditional subtraction here survived every other
  // test in this file.
  it("leaves an unfinished item's time_taken_ms null while the crawl is still running", async () => {
    const db = freshDb();
    for (const id of [1, 2]) seedFoodbank(db, id, `FB ${id}`, `fb-${id}`);
    seedCrawlSet(db, { id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000", finish: null });
    seedCrawlItem(db, { id: 100, crawl_set_id: 10, start: "2026-09-05 15:00:01.000000", finish: "2026-09-05 15:00:03.500000", foodbank_id: 1 });
    seedCrawlItem(db, { id: 101, crawl_set_id: 10, start: "2026-09-05 15:00:02.000000", finish: null, foodbank_id: 2 });

    // Neither item produced a need, so both sit in the second group and the
    // start DESC tie-break decides: item 101, started a second later, leads.
    const data = await getCrawlSetJson(d1Session(db), 10);
    expect(data!.items.map((i) => [i.finish, i.time_taken_ms])).toEqual([
      [null, null],
      ["2026-09-05 15:00:03.500000", 2500],
    ]);
  });

  // A crawl set with no items at all still renders: Django's item_count() is a
  // COUNT over an empty queryset, not a 404, and the poll has to be able to
  // report "0 of 1071 done" for the seconds between a set being created and
  // its first item finishing. An implementation that inner-joined its way to
  // the header would hand back null here and 404 a live crawl.
  it("returns the header with zero counts for a crawl set that has no items yet", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000", finish: null });

    expect(await getCrawlSetJson(d1Session(db), 10)).toEqual({
      crawl_type: "need",
      start: "2026-09-05 15:00:00.000000",
      finish: null,
      time_taken: null,
      item_count: 0,
      object_count: 0,
      items: [],
    });
  });

  // views.py:3317 -- `str(crawl_set.time_taken())`, the SAME string the two
  // templates render, so the value the poll writes into the Time Taken row is
  // indistinguishable from the server-rendered one. And null while the crawl
  // is still going: CrawlSet.time_taken() returns None there, and "0:00:00"
  // would tell an admin that a sweep still in flight finished instantly.
  it("formats time_taken as str(timedelta) and leaves it null while unfinished", async () => {
    const db = freshDb();
    seedCrawlSet(db, { id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000", finish: "2026-09-05 17:14:07.000000" });
    seedCrawlSet(db, { id: 11, crawl_type: "article", start: "2026-09-03 08:20:00.000000", finish: "2026-09-04 10:23:04.000000" });
    seedCrawlSet(db, { id: 12, crawl_type: "charity", start: "2026-09-05 15:00:00.000000", finish: null });

    expect((await getCrawlSetJson(d1Session(db), 10))!.time_taken).toBe("2:14:07");
    expect((await getCrawlSetJson(d1Session(db), 11))!.time_taken).toBe("1 day, 2:03:04"); // singular for exactly one day
    expect((await getCrawlSetJson(d1Session(db), 12))!.time_taken).toBeNull();
  });

  // MIGRATION 0019'S SCAR again, on the other side of the join: crawlitem
  // never cached a foodbank_name, but its sibling tables did, and this query
  // is the shape that replaced them. Renaming the parent and re-reading is the
  // only way to prove the name is joined rather than copied.
  it("reads each item's foodbank_name and slug live from the parent", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedCrawlSet(db, { id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });
    seedCrawlItem(db, { id: 100, crawl_set_id: 10, start: "2026-09-05 15:00:01.000000", foodbank_id: SALISBURY });

    const before = (await getCrawlSetJson(d1Session(db), 10))!.items[0]!;
    expect([before.foodbank_name, before.foodbank_slug]).toEqual(["Salisbury", "salisbury"]);

    db.prepare("UPDATE foodbank SET name = 'Salisbury Foodbank', slug = 'salisbury-foodbank' WHERE id = ?").run(SALISBURY);
    const after = (await getCrawlSetJson(d1Session(db), 10))!.items[0]!;
    expect([after.foodbank_name, after.foodbank_slug]).toEqual(["Salisbury Foodbank", "salisbury-foodbank"]);
  });

  // SUSPECT, PINNED AS-IS. The food bank join is INNER, matching Django's
  // select_related('foodbank') over a non-nullable FK -- and in Postgres that
  // FK is enforced, so a crawl item without a parent cannot exist. D1 declares
  // no foreign keys (PLAN.md §4.5), so it can. The consequence here is worse
  // than on the Ad Hoc table, because item_count and object_count are counted
  // from the JOINED result rather than from crawlitem: an orphaned item is not
  // merely hidden, it is subtracted from the totals, so Django's
  // CrawlSet.item_count() (a bare COUNT with no join) and this page would
  // disagree. Recorded rather than fixed because this file pins behaviour.
  it("drops an item whose food bank row is gone -- and quietly lowers item_count with it", async () => {
    const db = freshDb();
    seedFoodbank(db, 1, "FB 1", "fb-1");
    seedNeed(db, { id: 41, needId: "a".repeat(32), foodbankId: 1, created: "2026-09-05 15:00:00.000000" });
    seedCrawlSet(db, { id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });
    seedCrawlItem(db, { id: 100, crawl_set_id: 10, start: "2026-09-05 15:00:01.000000", foodbank_id: 1 });
    // A food bank row that was deleted after its crawl item was written. Its
    // need survives too, so object_count loses a point as well.
    seedCrawlItem(db, { id: 101, crawl_set_id: 10, start: "2026-09-05 15:00:02.000000", foodbank_id: 404, need_id: 41 });

    const data = await getCrawlSetJson(d1Session(db), 10);
    expect(data!.items.map((i) => i.foodbank_slug)).toEqual(["fb-1"]);
    expect([data!.item_count, data!.object_count]).toEqual([1, 0]); // Django would say [2, 1]
  });

  // Cardinality. Both joins are to a primary key, so one crawl item can only
  // ever produce one row -- but the page is read as "one line per crawl item",
  // and a join that fanned out (to foodbankchange.foodbank_id, say, which is
  // NOT unique) would DUPLICATE lines and inflate both counts rather than
  // fail. Two needs for the same food bank is the seed that exposes it.
  it("returns one row per crawl item even when the food bank has several needs", async () => {
    const db = freshDb();
    seedFoodbank(db, 1, "FB 1", "fb-1");
    seedNeed(db, { id: 41, needId: "a".repeat(32), foodbankId: 1, created: "2026-09-05 15:00:00.000000" });
    seedNeed(db, { id: 42, needId: "b".repeat(32), foodbankId: 1, created: "2026-09-05 16:00:00.000000" });
    seedCrawlSet(db, { id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });
    seedCrawlItem(db, { id: 100, crawl_set_id: 10, start: "2026-09-05 15:00:01.000000", foodbank_id: 1, need_id: 41 });

    const data = await getCrawlSetJson(d1Session(db), 10);
    expect(data!.items).toHaveLength(1);
    expect([data!.item_count, data!.object_count]).toEqual([1, 1]);
    // WHICH need it joined to, not merely how many rows came back. A join
    // rewritten onto foodbank_id fans out to two rows, which the length above
    // catches -- but a join rewritten onto the OTHER key of a one-to-one pair
    // still returns one row, and only the identity of that row shows it picked
    // need 42 instead of the 41 the crawl item actually points at.
    expect(data!.items[0]!.object).toMatchObject({ need_id_short: "aaaaaaa", url: `/admin/need/${"a".repeat(32)}/` });
  });

  // SUSPECT, PINNED AS-IS, and the reason it needs a test of its own: the
  // branch is `item.need_id !== null`, an identity check, while the duration
  // three lines above it is `item.finish ? ...`, a truthiness check. Rewriting
  // the first to match the second -- `if (item.need_id)` -- is a one-word
  // tidy-up that survives every other test in this file, because the only
  // value that separates the two spellings is a need_id of 0, and nothing else
  // here seeds one.
  //
  // Zero is not reachable from this app's own writes: crawlitem.need_id comes
  // from insertFoodbankChange's `meta.last_row_id` (needcheck.ts:170) and
  // SQLite rowids start at 1. It is reachable from an ETL or a hand-run
  // UPDATE, and the two spellings then disagree about whether the item shows
  // as "deleted" or as no object at all. Recorded rather than fixed, because
  // this file pins behaviour -- and so the next reader knows the difference is
  // deliberate on one line and incidental on the other.
  it("treats a need_id of 0 as a pointer to a deleted need, not as no need at all", async () => {
    const db = freshDb();
    seedFoodbank(db, 1, "FB 1", "fb-1");
    seedCrawlSet(db, { id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000" });
    seedCrawlItem(db, { id: 100, crawl_set_id: 10, start: "2026-09-05 15:00:01.000000", foodbank_id: 1, need_id: 0 });

    const data = await getCrawlSetJson(d1Session(db), 10);
    expect(data!.items[0]!.object).toEqual({ status: "deleted" });
    // object_count uses the same `!== null` test, so the 0 counts as an object.
    expect(data!.object_count).toBe(1);
  });

  // The JSON shape, pinned as a whole -- views.py:3305-3322's dict is
  // test-pinned in Django too (test_crawl_set_json.py), and this endpoint's
  // consumer is a polling script that overwrites a server-rendered table with
  // these exact keys. A renamed or added key is a column that stops updating
  // when the poll fires, which looks like a stalled crawl rather than a bug.
  // The item's `id` is selected by the SQL but deliberately NOT in the output:
  // Django's item dict has no id either.
  it("returns exactly Django's seven top-level keys and seven per-item keys", async () => {
    const db = freshDb();
    seedFoodbank(db, SALISBURY, "Salisbury", "salisbury");
    seedCrawlSet(db, { id: 10, crawl_type: "need", start: "2026-09-05 15:00:00.000000", finish: "2026-09-05 15:04:32.000000" });
    seedCrawlItem(db, {
      id: 100,
      crawl_set_id: 10,
      start: "2026-09-05 15:00:01.000000",
      finish: "2026-09-05 15:00:03.500000",
      foodbank_id: SALISBURY,
      url: "https://salisbury.foodbank.org.uk/shopping-list/",
    });

    const data = (await getCrawlSetJson(d1Session(db), 10))!;
    expect(Object.keys(data).sort()).toEqual(["crawl_type", "finish", "item_count", "items", "object_count", "start", "time_taken"]);
    expect(Object.keys(data.items[0]!).sort()).toEqual(["finish", "foodbank_name", "foodbank_slug", "object", "start", "time_taken_ms", "url"]);
    expect(data).toEqual({
      crawl_type: "need",
      start: "2026-09-05 15:00:00.000000",
      finish: "2026-09-05 15:04:32.000000",
      time_taken: "0:04:32",
      item_count: 1,
      object_count: 0,
      items: [
        {
          foodbank_name: "Salisbury",
          foodbank_slug: "salisbury",
          start: "2026-09-05 15:00:01.000000",
          finish: "2026-09-05 15:00:03.500000",
          time_taken_ms: 2500,
          url: "https://salisbury.foodbank.org.uk/shopping-list/",
          object: null,
        },
      ],
    });
  });
});
