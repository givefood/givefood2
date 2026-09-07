import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS_SQL as SCHEMA } from "./schema.testkit";
import { djangoDate } from "@givefood/templates";
import { buildNeedEmailContext, formatSubscribedDate, formatSubscribedTime } from "./needEmailContext";
import type { FoodbankChangeRow } from "./needs";
import type { Session } from "./types";

// The context behind the notification email 5,855 people receive when a food
// bank's needs change -- gfwfbn/templates/wfbn/emails/notification.{txt,html},
// ported to packages/templates/templates/emails/need_notification{_txt,}.njk.
// ONE builder with two callers: the admin preview
// (workers/site/src/routes/admin/needEmail.ts) and the real send
// (workers/jobs/src/notify/needEmail.ts). The preview's whole purpose is that
// the maintainer can trust it matches what goes out, so a divergence between
// the two would be invisible in exactly the place it matters.
//
// RUN AGAINST A REAL DATABASE, NOT A FAKE. buildNeedEmailContext is half
// SQL -- getFoodbankForNeedEmail's id lookup and getArticlesForNeedEmail's
// 28-day window -- and every failure that layer can produce is silent: a
// dropped foodbank_id predicate puts another food bank's news in the email, a
// mishandled cutoff quietly empties the "News from..." block, a lost ORDER BY
// shuffles it. None of them throw. The schema comes from
// packages/db/migrations/*.sql applied in order (the same harness
// charity.test.ts uses), not from a hand-written CREATE TABLE and not from the
// TypeScript interfaces -- 0019_drop_foodbank_cache.sql is this repo's scar,
// where four queries kept naming columns a migration had dropped and
// /dashboard/beautybanks/ was a live 500 nobody noticed. A fixture built from
// the real migrations fails loudly instead.
//
// The clock is frozen for the whole file. ARTICLES_MONTH_DAYS is measured
// from Date.now(), so without a fixed clock the cutoff-day tests below would
// mean something different every day they ran -- and the cutoff is the one
// piece of this module with a deliberate divergence from Django.
//
// THREE DIVERGENCES ARE PINNED HERE RATHER THAN FIXED, per TESTING.md: the
// utm_campaign slug (this module uses @givefood/models' simplified slugify,
// not Django's), the empty campaign name for a need with no denormalised
// food bank name, and the missing NaN guard in the two subscriber
// formatters. Each is asserted as it behaves today and commented as suspect.
// Parity claims are executed, not reasoned about: every "Django does X" in
// this file was run under the original site's own venv
// (/Users/jasoncartwright/Sites/foodcharity) before it was written down.
//
// MUTATION-TESTED TWICE, per TESTING.md's convention. Once when it was
// written, and again in an adversarial review pass that cloned the repo to a
// scratchpad, broke needEmailContext.ts and needAdminExtras.ts sixty-four
// ways there, and re-ran this file against each. Every mutant that changes
// what a subscriber receives died: locale "en" -> "cy", the utm slug taken
// from the live name instead of the denormalised one, the utm date taken from
// modified instead of created, the two utm params reordered, `!== 0` ->
// truthiness on the donation-points line, a tidied excess split, a trimmed
// change_text, the 28-day window widened, narrowed, or measured from the
// need's own created instead of from now, the cutoff spelled as a full
// instant or truncated to a month, ORDER BY dropped, reversed or moved to id,
// a LIMIT bolted on, the foodbank_id filter dropped, negated or respelled `IS
// NOT`, the cutoff predicate dropped or flipped, the two article bind
// parameters swapped, only the first row returned, `WHERE id = ?` bent to
// `>=`, `<=` or nothing at all, an is_closed filter added to the food bank
// lookup, the slug or the donation-point count read from a neighbouring
// column, either null guard deleted or loosened to a falsy test,
// safeUrlWithRef's catch removed, a missing title_captialised /
// url_with_ref / date, the unsubscribe key blanked, a plausible fake
// subscriber invented for the preview, the two subscriber formatters swapped,
// and every arithmetic slip in the ordinal, the 12-hour clock, the am/pm
// boundary, the minute padding and the month index.
//
// SIX SURVIVORS, recorded rather than papered over, and each argued to be
// EQUIVALENT rather than merely uncaught -- a survivor that is only uncaught
// is a hole, and the two this review found (a falsy null guard, and a LIMIT
// on the articles query) were closed with the two tests that name them:
//
//  * `fullNameLocaleAware(name, alt_name, "en")` -> `(name, null, "en")`.
//    alt_name is consulted only for cy (models/index.ts:93-97), so pinning
//    the locale to "en" is precisely what makes that column unobservable
//    here -- which is the point the Welsh-alt_name test below is making.
//  * `!== 0` -> `!= 0` on the donation-points line: `null != 0` and
//    `null !== 0` are both true, and the column is INTEGER, so no value this
//    schema holds distinguishes them.
//  * `WHERE id = ?` -> `WHERE id IS ?` in getFoodbankForNeedEmail. Those
//    differ only for a NULL bind, and buildNeedEmailContext's
//    `foodbank_id === null` guard returns before the query ever runs -- which
//    is exactly what the first two tests in this file hold. Reachable only
//    through needAdminExtras.ts's other callers, so it is that file's mutant.
//  * dropping `substr(published_date, 1, 10)` from the window -- see the test
//    that says so, the honest version of a claim the module overstates.
//  * reading the articles through 0019's foodbankarticle_full view instead of
//    the base table: equivalent for the four columns selected, and it buys a
//    LEFT JOIN for nothing, which is why the module does not.
//  * `getUTCDate()` -> `getDate()`, and a bare date parsed as local rather
//    than UTC. Both are identity mutations under the TZ=UTC that
//    vitest.config.mts pins and the Workers runtime guarantees; killing them
//    would mean asserting a timezone this code never runs in.

// The @ts-ignore comments below carry the same reasoning as
// charity.test.ts:70-75: this package typechecks with
// @cloudflare/workers-types only, so node:sqlite and node:fs have no types
// here, and adding "node" to tsconfig is a config change rather than a test
// change. vitest's node environment has both modules for real.
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

interface FakeStatement {
  bind(...values: unknown[]): FakeStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}

// The two D1 Sessions API calls this module's queries make, over a real
// engine. Deliberately dumb: it carries SQL to node:sqlite and nothing else.
// A session that interpreted the SQL, or answered canned rows, would be a
// second implementation of the very thing under test -- and since these two
// functions are one statement each, there would be nothing left to test.
//
// bind() returns a NEW statement rather than mutating, matching D1's
// immutable prepared statements, and `first()` answers null (never undefined)
// because buildNeedEmailContext's `if (!foodbank)` guard and the preview
// route's 400 both hang off that.
//
// `calls` is recorded so a test can assert how MANY queries ran, not just
// what came back: the null-food-bank guard returning early, and the absence
// of any translation lookup, are both claims about queries that must NOT
// happen, and no assertion on the returned context can see them.
function d1Session(db: SqliteDatabase): { session: Session; calls: Sent[] } {
  const calls: Sent[] = [];

  function statement(sql: string, params: Bindable[]): FakeStatement {
    return {
      bind: (...values: unknown[]) => statement(sql, values as Bindable[]),
      first: async <T,>() => {
        calls.push({ sql, params });
        return (db.prepare(sql).get(...params) ?? null) as T | null;
      },
      all: async <T,>() => {
        calls.push({ sql, params });
        return { results: db.prepare(sql).all(...params) as T[] };
      },
    };
  }

  const session = { prepare: (sql: string) => statement(sql, []), getBookmark: () => null };
  return { session: session as unknown as Session, calls };
}

// ===========================================================================
// FIXTURES
// ===========================================================================

// The spelling Django and the ETL write -- a SPACE separator and six
// fractional digits, never a 'T' and never a 'Z'. These columns are TEXT and
// SQLite compares TEXT bytewise, so the spelling is not cosmetic: " " (0x20)
// sorts before "T" (0x54), which is what 0022_normalise_timestamps.sql had to
// go back and repair across nine foodbankarticle rows.
const DJANGO_NOW = "2026-09-05 19:28:08.853000";
const NOW = new Date("2026-09-05T19:28:08.853Z");

// Date.now() - 28 days, as an ISO date prefix. Asserted rather than assumed
// because every article test below is positioned relative to it, and a
// silently-wrong constant here would make the whole articles section agree
// with itself and with nothing else.
const CUTOFF = "2026-08-08";

// Ids deliberately not in name, slug or article-date order, so "ordered by
// id" can never be accidentally right.
const SALISBURY = 22;
const WEST_NORFOLK = 88;

let db: SqliteDatabase;
let session: Session;
let calls: Sent[];

interface FoodbankSeed {
  id: number;
  slug: string;
  name?: string;
  altName?: string | null;
  noDonationPoints?: number | null;
}

// Every NOT NULL column 0001_core.sql declares, plus the five this module
// actually reads. Spelt out in full rather than trimmed because the real DDL
// is what the fixture applies -- a shorter INSERT simply will not run -- and
// because that is the property worth having: a migration adding a NOT NULL
// column breaks this file loudly instead of leaving it green against a schema
// production no longer has.
function seedFoodbank(seed: FoodbankSeed): void {
  db.prepare(
    "INSERT INTO foodbank (id, uuid, name, alt_name, slug, address, postcode, country, lat_lng, " +
      "charity_just_foodbank, contact_email, url, shopping_list_url, address_is_administrative, " +
      "is_closed, no_locations, no_donation_points, days_between_needs, created, modified) " +
      "VALUES (?, ?, ?, ?, ?, '1 High Street', 'SP1 1AA', 'England', '51.0688,-1.7945', 0, " +
      "'info@example.org', 'https://example.org/', 'https://example.org/list/', 0, 0, 0, ?, 14, ?, ?)",
  ).run(
    seed.id,
    `uuid-${seed.slug}`,
    seed.name ?? seed.slug,
    seed.altName ?? null,
    seed.slug,
    seed.noDonationPoints === undefined ? 3 : seed.noDonationPoints,
    DJANGO_NOW,
    DJANGO_NOW,
  );
}

// An article row as the ETL wrote it and as the crawler writes them today
// (queues/articles.ts:75 goes through pyDatetime, so both populations share
// the Django spelling). Written straight to the table rather than through
// insertArticleIfNew: these stand in for rows that were already there.
function seedArticle(row: { id: number; foodbankId: number | null; publishedDate: string; title: string; url: string }): void {
  db.prepare("INSERT INTO foodbankarticle (id, foodbank_id, published_date, title, url, featured) VALUES (?, ?, ?, ?, ?, 0)").run(
    row.id,
    row.foodbankId,
    row.publishedDate,
    row.title,
    row.url,
  );
}

// A published, scraped need for Salisbury -- the ordinary case that produces
// an email. `foodbank_name` is the DENORMALISED copy (needs.py:292-293), and
// it is deliberately seeded equal to the food bank's real name here so that
// the tests which make them DIFFER are visibly making a point.
function needRow(overrides: Partial<FoodbankChangeRow> = {}): FoodbankChangeRow {
  return {
    id: 4211,
    need_id: "0b9ab6b8c9f24bd6a5b7d0c1e2f34567",
    foodbank_id: SALISBURY,
    foodbank_name: "Salisbury",
    distill_id: "3d9f1c2a",
    name: null,
    uri: null,
    change_text: "Tinned Meat\nUHT Milk\nTinned Fruit",
    change_text_original: null,
    excess_change_text: null,
    excess_change_text_original: null,
    published: true,
    nonpertinent: false,
    is_categorised: true,
    notified: null,
    input_method: "scrape",
    created: DJANGO_NOW,
    modified: DJANGO_NOW,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db = new DatabaseSync(":memory:") as SqliteDatabase;
  db.exec(SCHEMA);
  ({ session, calls } = d1Session(db));
  seedFoodbank({ id: SALISBURY, slug: "salisbury", name: "Salisbury" });
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
});

// ===========================================================================
// The guards
// ===========================================================================

describe("buildNeedEmailContext -- the guards", () => {
  // Django's view would 500 here: every line of both templates dereferences
  // need.foodbank. The port returns null so the preview route can answer 400
  // with an explanation and the send path can log and drop the message
  // (notify/needEmail.ts:67-70 also checks, belt and braces).
  //
  // The call count is the real assertion. `foodbank_id === null` must
  // short-circuit BEFORE the lookup, because binding null into `WHERE id = ?`
  // matches nothing but still costs a D1 round trip on every message of a
  // fan-out -- and, worse, a future `IS ?` spelling of that predicate would
  // match a food bank whose id was somehow null and hand the email a
  // completely unrelated parent.
  it("returns null for a need with no food bank, without asking the database anything", async () => {
    expect(await buildNeedEmailContext(session, needRow({ foodbank_id: null }), null)).toBeNull();

    expect(calls).toEqual([]);
  });

  // D1 has no foreign keys (PLAN.md §4.5), so a need can outlive its food
  // bank -- and the send path fans out across queue messages, so the parent
  // can disappear between the publish and the last page of subscribers. The
  // call-count assertion is what stops that becoming an email with an empty
  // "News from..." block and a broken /needs/at//: no food bank means no
  // articles query at all, and no context to render.
  //
  // BOTH SIDES of the seeded ids are asked for, and that is not padding. The
  // lookup is `WHERE id = ?`, and the two one-character mutations of it are
  // silent in opposite directions: `id >= ?` answers a missing LOW id with
  // the next food bank up the table, `id <= ?` answers a missing HIGH id with
  // the first one down. Either sends Salisbury's subscribers West Norfolk's
  // news over Salisbury's name, with a 200 and no log line. A single missing
  // id can only ever catch one of the two.
  it("returns null when the need points at a food bank that no longer exists, above or below the ones that do", async () => {
    seedFoodbank({ id: WEST_NORFOLK, slug: "west-norfolk", name: "West Norfolk" });

    expect(await buildNeedEmailContext(session, needRow({ foodbank_id: 5 }), null)).toBeNull();
    expect(await buildNeedEmailContext(session, needRow({ foodbank_id: 999 }), null)).toBeNull();

    expect(calls).toHaveLength(2);
    expect(calls[0]!.sql).toContain("FROM foodbank ");
  });

  // KILLS `if (!need.foodbank_id) return null;` -- the careless spelling of
  // the guard above, and the one mutant of it that survived this file's first
  // pass. Zero is the only falsy number, so the two spellings disagree about
  // exactly one food bank id, and for that one the falsy version is silent in
  // the worst way available: null returned, no query, no exception, no log
  // line, and a subscriber list that simply never hears from its food bank.
  //
  // Nothing in production is id 0 -- Django's AutoField starts at 1 and the
  // ETL preserved those ids -- so what this pins is the guard's SHAPE, not a
  // live row. That shape is load-bearing on its own terms: this guard exists
  // to skip a D1 round trip for a need with no parent at all, and it is a
  // different question from "has the food bank gone", which is the `!foodbank`
  // guard below. Collapsing the two into one truthiness test is how they
  // become one bug.
  it("guards on foodbank_id being null specifically, not on it being falsy", async () => {
    seedFoodbank({ id: 0, slug: "zero-id", name: "Zero Id" });

    const context = await buildNeedEmailContext(session, needRow({ foodbank_id: 0, foodbank_name: "Zero Id" }), null);

    expect(context?.foodbank_slug).toBe("zero-id");
    expect(calls).toHaveLength(2);
  });

  // Two queries, and only two: the food bank and its articles. Pinned as a
  // count because the things that must NOT happen here are invisible in the
  // returned object -- no translation lookup (the emails are English-only, no
  // wfbn/emails/* template loads {% i18n %}, and localising mail 5,855 people
  // already receive would be a visible change), no per-article second query,
  // and no `SELECT *` on foodbank to feed a full row nobody reads.
  it("issues exactly two queries: the food bank, then its articles", async () => {
    await buildNeedEmailContext(session, needRow(), null);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.params).toEqual([SALISBURY]);
    expect(calls[1]!.params).toEqual([SALISBURY, CUTOFF]);
  });
});

// ===========================================================================
// The food bank half
// ===========================================================================

describe("buildNeedEmailContext -- the food bank half", () => {
  // Foodbank.full_name() is locale-aware and this call site pins it to "en"
  // on purpose. A Welsh food bank with an alt_name renders as its alt_name in
  // a cy request (models/index.ts:94), so threading the request's locale in
  // here -- which looks like an improvement -- would silently switch 5,855
  // recipients' subject lines and salutations to Welsh for those food banks.
  // The subject line in notify/needEmail.ts:112 is built from this same
  // value, so it is not one paragraph, it is the whole mail.
  it("names the food bank in English even when it has a Welsh alt_name", async () => {
    seedFoodbank({ id: 41, slug: "ynys-mon", name: "Ynys Mon", altName: "Banc Bwyd Ynys Mon" });

    const context = await buildNeedEmailContext(session, needRow({ foodbank_id: 41, foodbank_name: "Ynys Mon" }), null);

    expect(context?.full_name).toBe("Ynys Mon Foodbank");
  });

  // The nine names in DONT_APPEND_FOOD_BANK already say what they are;
  // "Salvation Army Foodbank" is not a thing anyone calls it. Parity with
  // Foodbank.full_name()'s own list.
  it("leaves a name that already says what it is without a Foodbank suffix", async () => {
    seedFoodbank({ id: 30, slug: "salvation-army", name: "Salvation Army" });

    const context = await buildNeedEmailContext(session, needRow({ foodbank_id: 30, foodbank_name: "Salvation Army" }), null);

    expect(context?.full_name).toBe("Salvation Army");
  });

  // THE POINT OF 0019, restated for this module. foodbankchange keeps a
  // denormalised foodbank_name that is refreshed only when the NEED is saved,
  // so after a rename the two disagree -- 24 rows disagreed with their
  // parent's name and slug when 0019 was measured against production. Every
  // link in the email is built from foodbank_slug, and the name a recipient
  // reads is the LIVE one; only utm_campaign is allowed to keep the stale
  // copy (see below, and needs.py:90-91 for why).
  it("reads the live food bank row for the name and slug, not the need's stale copy", async () => {
    seedFoodbank({ id: 60, slug: "salisbury-and-district", name: "Salisbury and District" });

    const context = await buildNeedEmailContext(session, needRow({ foodbank_id: 60, foodbank_name: "Salisbury" }), null);

    expect(context?.full_name).toBe("Salisbury and District Foodbank");
    expect(context?.foodbank_slug).toBe("salisbury-and-district");
  });

  // A statement that had lost its WHERE would answer with whichever row came
  // back first. Asked for the second of three, with ids out of insertion
  // order, this is the test that notices.
  //
  // The seeded slug is deliberately NOT derivable from the name. Every link
  // in the email is built from foodbank_slug, and production holds plenty of
  // pairs where the two diverge (a food bank renamed after its slug was
  // minted); a `slugify(foodbank.name)` standing in for the column would
  // agree with the row for most food banks and 404 for those, which is the
  // failure 0019's own header records against getDonationPointBySlugs.
  it("fetches the food bank the need points at, and takes the slug from the column", async () => {
    seedFoodbank({ id: WEST_NORFOLK, slug: "kings-lynn-and-west-norfolk", name: "West Norfolk" });
    seedFoodbank({ id: 7, slug: "bath", name: "Bath" });

    const context = await buildNeedEmailContext(session, needRow({ foodbank_id: WEST_NORFOLK, foodbank_name: "West Norfolk" }), null);

    expect(context?.foodbank_slug).toBe("kings-lynn-and-west-norfolk");
    expect(context?.full_name).toBe("West Norfolk Foodbank");
  });

  // A closed food bank still produces an email. There is no is_closed filter
  // in getFoodbankForNeedEmail and Django had none either -- the queue
  // message finishes what it was given, exactly like
  // getFoodbankForArticleCrawl's own missing filter (articles.test.ts). Worth
  // pinning so that adding one later is a decision about subscribers rather
  // than a tidy-up: the people who would stop receiving mail are the ones who
  // subscribed to a food bank that has since shut.
  it("still builds a context for a closed food bank", async () => {
    db.prepare("UPDATE foodbank SET is_closed = 1 WHERE id = ?").run(SALISBURY);

    expect(await buildNeedEmailContext(session, needRow(), null)).toMatchObject({ foodbank_slug: "salisbury" });
  });
});

// ===========================================================================
// utm
// ===========================================================================

describe("buildNeedEmailContext -- the utm campaign", () => {
  // notification.html hand-writes these four params into eight separate
  // hrefs; the port builds the string once and renders it with |safe so the
  // "&" stays a literal "&" rather than "&amp;". Asserted as one whole string
  // because the ORDER is part of what already-sent mail carries, and because
  // an "&amp;" here would break every link in the HTML half at once.
  it("builds the four params in order, with literal ampersands", async () => {
    const context = await buildNeedEmailContext(session, needRow(), null);

    expect(context?.utm).toBe("utm_source=notificationemail&utm_medium=email&utm_campaign=salisbury-2026-09-05");
    expect(context?.utm).not.toContain("&amp;");
  });

  // needs.py:90-91's foodbank_name_slug is slugify() over the DENORMALISED
  // column, NOT over the live foodbank.name -- so a renamed food bank keeps
  // reporting under its old campaign, which is what makes the port's
  // analytics continuous with the mail Django already sent. Reading
  // foodbank.name here instead would look tidier and would silently split
  // every renamed food bank's campaign in two.
  it("slugifies the need's denormalised name, so a rename does not split the campaign", async () => {
    seedFoodbank({ id: 60, slug: "salisbury-and-district", name: "Salisbury and District" });

    const context = await buildNeedEmailContext(session, needRow({ foodbank_id: 60, foodbank_name: "Salisbury" }), null);

    expect(context?.utm).toContain("utm_campaign=salisbury-2026-09-05");
  });

  // The date is the NEED's created, not today: a need published a day after
  // it was detected must report under the day it was detected, and the send
  // path can retry across midnight. djangoDate reads both spellings this
  // column has held (0022_normalise_timestamps.sql rewrote the ISO ones, but
  // the parser still copes), so the campaign is stable either way -- unlike
  // an `ORDER BY` on the same column, which is not.
  it("dates the campaign from the need's created, in either stored spelling", async () => {
    const django = await buildNeedEmailContext(session, needRow({ created: "2026-08-14 06:02:11.004000" }), null);
    const iso = await buildNeedEmailContext(session, needRow({ created: "2026-08-14T06:02:11.004Z" }), null);

    expect(django?.utm).toContain("utm_campaign=salisbury-2026-08-14");
    expect(iso?.utm).toContain("utm_campaign=salisbury-2026-08-14");
  });

  // SUSPECT, PINNED AS-IS. `slugify` here is @givefood/models' simplified one
  // (index.ts:248-253 -- lowercase, then every run of non-alphanumerics
  // becomes a "-"), not django.utils.text.slugify, which strips apostrophes
  // and folds accents to ASCII before collapsing. Run under the original
  // site's venv:
  //
  //   slugify("King's Lynn")  Django "kings-lynn"   port "king-s-lynn"
  //   slugify("Ynys Môn")     Django "ynys-mon"     port "ynys-m-n"
  //
  // Analytics only -- no link target depends on it -- but it does mean a
  // campaign the port sends does not aggregate with the same food bank's
  // Django-era campaign. packages/templates already exports a Django-faithful
  // slugify (filters.ts:37-44) that would close it. Not changed here, because
  // switching mid-flight splits those campaigns a second time and that is a
  // decision for whoever owns the reporting, not for a test.
  it("uses the port's simplified slugify, which differs from Django's on apostrophes and accents", async () => {
    seedFoodbank({ id: 51, slug: "kings-lynn", name: "King's Lynn" });

    const context = await buildNeedEmailContext(session, needRow({ foodbank_id: 51, foodbank_name: "King's Lynn" }), null);

    expect(context?.utm).toContain("utm_campaign=king-s-lynn-2026-09-05");
    expect(context?.utm).not.toContain("kings-lynn");
  });

  // SUSPECT, PINNED AS-IS. foodbank_name is nullable, and `?? ""` turns a
  // NULL into an empty campaign name -- the string becomes
  // "utm_campaign=-2026-09-05". Django would not: slugify(None) stringifies
  // first and returns "none" (run under the original venv), so the same row
  // produced "utm_campaign=none-2026-09-05" there. Both are junk; neither
  // breaks a link. Pinned so that a future `?? "unknown"` is recognised as a
  // change to reporting rather than a tidy-up of a null check.
  it("leaves the campaign name empty when the need has no denormalised food bank name", async () => {
    const context = await buildNeedEmailContext(session, needRow({ foodbank_name: null }), null);

    expect(context?.utm).toBe("utm_source=notificationemail&utm_medium=email&utm_campaign=-2026-09-05");
  });
});

// ===========================================================================
// change_text and the excess list
// ===========================================================================

describe("buildNeedEmailContext -- change text and the excess list", () => {
  // The body of the email, passed through byte for byte: no cleaning, no
  // translation, no line filtering, and no trim. notification.txt prints it
  // raw and notification.html runs it through |linebreaks, so the newlines
  // ARE the formatting and anything that normalised them would reflow the
  // mail -- a .trim() here is invisible in every fixture whose text happens
  // to be tidy, and rewrites the spacing of every scraped need whose text is
  // not. Django applies no filter to this variable at all.
  it("passes change_text through byte for byte, whitespace included", async () => {
    const context = await buildNeedEmailContext(session, needRow(), null);
    const untidy = await buildNeedEmailContext(session, needRow({ change_text: "\nTinned Meat\nUHT Milk\n\n" }), null);

    expect(context?.change_text).toBe("Tinned Meat\nUHT Milk\nTinned Fruit");
    expect(untidy?.change_text).toBe("\nTinned Meat\nUHT Milk\n\n");
  });

  // FoodbankChange.excess_list() -- needs.py:137-141, `self
  // .excess_change_text.split("\n")` when set, `[]` when not. Both templates
  // join the list with ", ", so an element boundary is a comma a recipient
  // reads.
  it("splits the excess list on newlines, the way excess_list() does", async () => {
    const context = await buildNeedEmailContext(session, needRow({ excess_change_text: "Beans\nPasta\nSoup" }), null);

    expect(context?.excess_list).toEqual(["Beans", "Pasta", "Soup"]);
    expect(context?.has_excess).toBe(true);
  });

  // NULL and "" are both "no excess". has_excess is what gates the whole
  // paragraph (`{% if has_excess %}`, mirroring Django's `{% if
  // need.excess_change_text %}`), and an empty string that slipped through as
  // truthy would print "...doesn't need anymore of these items: ." -- the
  // exact sentence a subscriber would report as a bug.
  it("treats NULL and an empty string alike as no excess at all", async () => {
    for (const excess of [null, ""]) {
      const context = await buildNeedEmailContext(session, needRow({ excess_change_text: excess }), null);

      expect(context?.excess_list).toEqual([]);
      expect(context?.has_excess).toBe(false);
    }
  });

  // A single item is one element, not a split that swallowed it.
  it("keeps a single-line excess list as one item", async () => {
    const context = await buildNeedEmailContext(session, needRow({ excess_change_text: "Baked Beans" }), null);

    expect(context?.excess_list).toEqual(["Baked Beans"]);
  });

  // PYTHON PARITY, executed under the original venv rather than reasoned
  // about: `"Tea\n".split("\n")` is `['Tea', '']` in CPython too, so the
  // trailing empty element -- and the "Tea, ." it renders as -- is Django's
  // behaviour, not a porting bug. Anyone tempted to filter empties here
  // should know they would be changing the mail, not fixing it, and that the
  // cleaner place is whatever wrote a trailing newline into the column.
  it("keeps the empty trailing element a trailing newline produces, as CPython does", async () => {
    const context = await buildNeedEmailContext(session, needRow({ excess_change_text: "Tea\n" }), null);

    expect(context?.excess_list).toEqual(["Tea", ""]);
  });

  // Same source, same check: CPython's split("\n") leaves the CR attached
  // ("a\r\nb" -> ['a\r', 'b']), so a Windows-edited textarea produces items
  // with a trailing carriage return in Django exactly as it does here.
  it("leaves the carriage return attached under CRLF, as CPython does", async () => {
    const context = await buildNeedEmailContext(session, needRow({ excess_change_text: "Beans\r\nPasta" }), null);

    expect(context?.excess_list).toEqual(["Beans\r", "Pasta"]);
  });
});

// ===========================================================================
// The articles block
// ===========================================================================

// Foodbank.articles_month() -- foodbank.py:573-575. The "News from..." block
// in both templates. The seed below is the shape every one of these tests
// needs: three qualifying articles for Salisbury whose ids run in neither
// date order nor insertion order, one article a day too old, one belonging to
// another food bank and one with no parent at all -- so a dropped ORDER BY, a
// dropped cutoff and a dropped foodbank_id predicate each produce a different
// wrong answer, and all three are visible.
const HARVEST = "https://salisbury.foodbank.org.uk/2026/09/harvest/";
const VAN = "https://salisbury.foodbank.org.uk/2026/08/van/";
const NHS = "https://salisbury.foodbank.org.uk/2026/08/nhs/";

function seedTheNewsroom(): void {
  seedFoodbank({ id: WEST_NORFOLK, slug: "west-norfolk", name: "West Norfolk" });

  seedArticle({ id: 3, foodbankId: SALISBURY, publishedDate: "2026-08-20 15:45:00.000000", title: "our new  van is here", url: VAN });
  seedArticle({
    id: 5,
    foodbankId: SALISBURY,
    publishedDate: "2026-09-04 09:30:00.000000",
    title: "HARVEST festival collections across the UK.",
    url: HARVEST,
  });
  seedArticle({ id: 9, foodbankId: SALISBURY, publishedDate: "2026-08-08 00:00:00.000000", title: "thank you to the NHS staff", url: NHS });

  // One day outside the window.
  seedArticle({
    id: 7,
    foodbankId: SALISBURY,
    publishedDate: "2026-08-07 23:59:59.000000",
    title: "Too old to appear",
    url: "https://salisbury.foodbank.org.uk/2026/08/old/",
  });
  // Another food bank's newest article, and a parentless one: both would sort
  // to the TOP of the list if the foodbank_id predicate were lost.
  seedArticle({
    id: 4,
    foodbankId: WEST_NORFOLK,
    publishedDate: "2026-09-05 08:00:00.000000",
    title: "Not this food bank",
    url: "https://westnorfolk.foodbank.org.uk/2026/09/news/",
  });
  seedArticle({
    id: 6,
    foodbankId: null,
    publishedDate: "2026-09-05 09:00:00.000000",
    title: "Orphaned by a deleted food bank",
    url: "https://example.org/2026/09/orphan/",
  });
}

describe("buildNeedEmailContext -- the articles block", () => {
  // The whole block in one assertion, deep-equal and ordered. It pins four
  // separate things at once, each of which fails silently on its own: the
  // foodbank_id filter (two intruders are seeded newer than everything that
  // should appear), the 28-day cutoff, ORDER BY published_date DESC, and the
  // three derived fields the templates read -- title_captialised()
  // (articles.py:35-49), url_with_ref() (:29-33) and the localised date.
  //
  // The expected strings are Django's own output, taken from the original
  // site's venv: capwords + the acronym pass turns "HARVEST festival
  // collections across the UK." into "Harvest Festival Collections Across The
  // UK", and `date:"N j, Y, P"` -- the en DATETIME_FORMAT that a bare
  // `{{ article.published_date }}` localises through -- spells September
  // "Sept." and midnight "midnight".
  it("returns this food bank's recent articles, newest first, rendered the way the templates need", async () => {
    seedTheNewsroom();

    const context = await buildNeedEmailContext(session, needRow(), null);

    expect(context?.articles).toEqual([
      {
        title_captialised: "Harvest Festival Collections Across The UK",
        url_with_ref: `${HARVEST}?ref=givefood.org.uk`,
        published_date: "Sept. 4, 2026, 9:30 a.m.",
      },
      {
        title_captialised: "Our New Van Is Here",
        url_with_ref: `${VAN}?ref=givefood.org.uk`,
        published_date: "Aug. 20, 2026, 3:45 p.m.",
      },
      {
        title_captialised: "Thank You To The NHS Staff",
        url_with_ref: `${NHS}?ref=givefood.org.uk`,
        published_date: "Aug. 8, 2026, midnight",
      },
    ]);
  });

  // KILLS `... ORDER BY published_date DESC LIMIT 10` -- a LIMIT bolted onto
  // the articles query, which is the SQL mutant this file's first pass
  // missed. Nothing in it seeded more than four qualifying articles, and
  // every LIMIT anyone would carelessly reach for is a round number above
  // four, so the whole section agreed with a query that silently truncated.
  // needAdminExtras.ts:122-125 states the property in words -- "Unbounded in
  // Django and unbounded here ... a LIMIT would silently change what 5,855
  // subscribers see in the News from... block" -- and words are not a test.
  // Fifteen rows kill every LIMIT below fifteen, which covers 5 and 10; a
  // LIMIT of 20 would still survive, and saying so is more use than implying
  // the bound is absolute.
  //
  // The long list does a second job the three-row block above cannot. Ids are
  // `(i * 7) % 12`, a permutation, so insertion order, id order and date order
  // are three genuinely different orders across fifteen rows: ORDER BY
  // published_date DESC has to be doing the entire sort, where a three-row
  // fixture can be accidentally right. The newsroom's excluded rows are still
  // seeded underneath, so the foodbank_id and cutoff filters are re-checked at
  // this size too -- a filter that works on three rows and not on fifteen is
  // exactly the shape a LIMIT-plus-filter mistake takes.
  it("returns every article in the window with no upper bound, sorted across the whole list", async () => {
    seedTheNewsroom();

    const days = [11, 24, 15, 30, 12, 28, 19, 22, 14, 26, 17, 13];
    days.forEach((day, i) =>
      seedArticle({
        id: 100 + ((i * 7) % 12),
        foodbankId: SALISBURY,
        publishedDate: `2026-08-${day} 09:00:00.000000`,
        title: `Bulletin ${day}`,
        url: `https://salisbury.foodbank.org.uk/2026/08/bulletin-${day}/`,
      }),
    );

    const titles = (await buildNeedEmailContext(session, needRow(), null))?.articles.map((article) => article.title_captialised);

    expect(titles).toEqual([
      "Harvest Festival Collections Across The UK", // 2026-09-04
      "Bulletin 30",
      "Bulletin 28",
      "Bulletin 26",
      "Bulletin 24",
      "Bulletin 22",
      "Our New Van Is Here", // 2026-08-20
      "Bulletin 19",
      "Bulletin 17",
      "Bulletin 15",
      "Bulletin 14",
      "Bulletin 13",
      "Bulletin 12",
      "Bulletin 11",
      "Thank You To The NHS Staff", // 2026-08-08, the cutoff day
    ]);
  });

  // DELIBERATE DIVERGENCE FROM DJANGO, and the reason the cutoff is a DATE.
  // Django compares instants (`published_date__gte = timezone.now() -
  // timedelta(days=28)`); the port compares `substr(published_date, 1, 10)`
  // against an ISO date, because foodbankarticle has held two timestamp
  // spellings and a plain `>=` between them mis-sorts on the cutoff day
  // itself. The cost is day granularity: the 00:00 article below is 19 hours
  // older than Django's threshold and is included anyway, while the one a
  // second before midnight the previous day is not. Bounded to under 24
  // hours, on a "news from the last month" block.
  //
  // Both edges are asserted together because only the pair distinguishes a
  // day-granular cutoff from a broken one.
  it("includes an article dated on the cutoff day itself, and excludes the day before", async () => {
    seedTheNewsroom();

    const titles = (await buildNeedEmailContext(session, needRow(), null))?.articles.map((article) => article.title_captialised);

    expect(titles).toContain("Thank You To The NHS Staff"); // 2026-08-08 00:00, the cutoff day
    expect(titles).not.toContain("Too Old To Appear"); // 2026-08-07 23:59:59
    expect(calls[1]!.params).toEqual([SALISBURY, CUTOFF]);
  });

  // WHICH HALF OF THE WINDOW ACTUALLY DOES THE WORK, run rather than
  // reasoned about -- the same question articles.test.ts asks of its
  // `rss_url IS NOT NULL`. needAdminExtras.ts:128-139 credits
  // `substr(published_date, 1, 10)` with making the comparison
  // format-agnostic across the two spellings this column holds. Against the
  // threshold this module actually builds -- a bare "YYYY-MM-DD", ten
  // characters -- the substr changes nothing: for any value whose first ten
  // characters are the date, a shorter-but-equal prefix and a longer string
  // compare the same way round. Dropping it is a mutant these tests cannot
  // kill, and knowing that is worth more than pretending otherwise.
  //
  // It is the DATE-ONLY CUTOFF, not the substr, that makes the window
  // format-agnostic. The second pair is why the substr should stay anyway:
  // the moment anyone tightens the cutoff to a real instant -- which is the
  // obvious way to "fix" the day-granularity divergence above -- the two
  // forms stop agreeing, and the plain comparison lets in an ISO-spelled row
  // that the substr correctly excludes, because "T" (0x54) outranks " "
  // (0x20). That is ticket #9's whole shape, one predicate away.
  it("gets its format-agnosticism from the date-only cutoff, not from the substr", () => {
    const compare = (stored: string, cutoff: string) =>
      db.prepare("SELECT substr(?1, 1, 10) >= ?2 AS with_substr, ?1 >= ?2 AS without_substr").get(stored, cutoff);

    // A date-only cutoff: the two forms agree, on both spellings.
    expect(compare("2026-08-08 00:00:00.000000", CUTOFF)).toEqual({ with_substr: 1, without_substr: 1 });
    expect(compare("2026-08-08T05:00:00.000Z", CUTOFF)).toEqual({ with_substr: 1, without_substr: 1 });

    // A full-timestamp cutoff, as Django compares: they disagree, and the
    // substr is the one that is right about the instant.
    expect(compare("2026-08-08T05:00:00.000Z", DJANGO_NOW.replace("2026-09-05", "2026-08-08"))).toEqual({
      with_substr: 0,
      without_substr: 1,
    });
  });

  // No upper bound, in Django or here. A feed that publishes with a wrong or
  // deliberately future date (WordPress scheduled posts do this) puts that
  // article at the top of the block until it is fixed. Pinned as known
  // behaviour: the fix, if anyone wants one, is a `<= now` in the query, and
  // it would be a change to what the email shows.
  it("keeps an article dated in the future, and sorts it first", async () => {
    seedTheNewsroom();
    seedArticle({
      id: 11,
      foodbankId: SALISBURY,
      publishedDate: "2026-12-25 10:00:00.000000",
      title: "Christmas appeal",
      url: "https://salisbury.foodbank.org.uk/2026/12/christmas/",
    });

    const context = await buildNeedEmailContext(session, needRow(), null);

    expect(context?.articles[0]?.title_captialised).toBe("Christmas Appeal");
    expect(context?.articles).toHaveLength(4);
  });

  // Both templates gate the block on `{% if articles.length %}`, not `{% if
  // articles %}` -- an empty JS array is truthy in nunjucks where an empty
  // Django queryset is not. So this must be an array, and it must be empty
  // rather than null, or the "News from..." heading appears above nothing.
  it("returns an empty array, not null, when the food bank has no recent news", async () => {
    seedArticle({
      id: 7,
      foodbankId: SALISBURY,
      publishedDate: "2026-01-04 10:00:00.000000",
      title: "Ancient history",
      url: "https://salisbury.foodbank.org.uk/2026/01/old/",
    });

    expect((await buildNeedEmailContext(session, needRow(), null))?.articles).toEqual([]);
  });

  // WHY safeUrlWithRef EXISTS. FoodbankArticle.url_with_ref() goes through
  // Python's PreparedRequest, which tolerates a lot; urlWithRefFoodbank uses
  // `new URL()`, which throws on a stored url with no scheme. One bad row in
  // one food bank's RSS history would otherwise 500 the admin preview page --
  // and, on the send path, throw inside the per-page loop and put the whole
  // message in the DLQ, so the subscribers after it in that page get nothing.
  // The raw url is used as-is instead: a dead link in one line of one email,
  // rather than no email.
  it("falls back to the raw url when a stored url will not parse", async () => {
    seedArticle({
      id: 12,
      foodbankId: SALISBURY,
      publishedDate: "2026-09-01 12:00:00.000000",
      title: "Malformed link",
      url: "salisbury.foodbank.org.uk/news/no-scheme",
    });

    const context = await buildNeedEmailContext(session, needRow(), null);

    expect(context?.articles).toEqual([
      { title_captialised: "Malformed Link", url_with_ref: "salisbury.foodbank.org.uk/news/no-scheme", published_date: "Sept. 1, 2026, noon" },
    ]);
  });

  // An existing ?ref is replaced, not appended twice -- searchParams.set(),
  // not append(). A feed whose links already carry our own ref (a food bank
  // copying a URL back off this site) would otherwise produce
  // "?ref=givefood.org.uk&ref=givefood.org.uk".
  it("replaces an existing ref parameter rather than appending a second one", async () => {
    seedArticle({
      id: 13,
      foodbankId: SALISBURY,
      publishedDate: "2026-09-01 12:00:00.000000",
      title: "Already referred",
      url: "https://salisbury.foodbank.org.uk/news/?ref=twitter&utm_source=feed",
    });

    const context = await buildNeedEmailContext(session, needRow(), null);

    // utm_source survives: unlike FoodbankDonationPoint.url_with_ref(), the
    // article version strips nothing (articles.py:29-33 against
    // foodbank.py's donation-point version). Parity, not oversight.
    expect(context?.articles[0]?.url_with_ref).toBe("https://salisbury.foodbank.org.uk/news/?ref=givefood.org.uk&utm_source=feed");
  });

  // TICKET #9's SHAPE, seen from this module. published_date is TEXT and the
  // ORDER BY is bytewise, so the WINDOW is format-agnostic (substr of the
  // date prefix is identical in both spellings) while the ORDER is not:
  // "2026-09-03T08:00:00.000Z" outranks "2026-09-03 22:00:00.000000" because
  // "T" (0x54) beats " " (0x20), putting a morning article above an evening
  // one from the same day.
  //
  // 0022_normalise_timestamps.sql repaired the nine rows that had it and
  // queues/articles.ts writes pyDatetime now, so this is a hazard rather than
  // a live bug -- pinned because the block it would scramble is 5,855
  // people's mail, and because the next writer of this column needs to find
  // out here rather than from a reader's email.
  it("orders on the raw TEXT column, so a stray ISO-spelled row sorts out of place", async () => {
    seedArticle({
      id: 20,
      foodbankId: SALISBURY,
      publishedDate: "2026-09-03 22:00:00.000000",
      title: "Evening edition, Django-spelled",
      url: "https://salisbury.foodbank.org.uk/2026/09/evening/",
    });
    seedArticle({
      id: 21,
      foodbankId: SALISBURY,
      publishedDate: "2026-09-03T08:00:00.000Z",
      title: "Morning edition, ISO-spelled",
      url: "https://salisbury.foodbank.org.uk/2026/09/morning/",
    });

    const context = await buildNeedEmailContext(session, needRow(), null);

    // "Iso", not "ISO": title_captialised() lowercases every word it does not
    // recognise as one of its fourteen acronyms, and ISO is not on that list
    // (articles.py:37). Incidental here, and left visible rather than worked
    // around, because it is the same function's output the block above pins.
    expect(context?.articles.map((article) => article.title_captialised)).toEqual([
      "Morning Edition, Iso-spelled",
      "Evening Edition, Django-spelled",
    ]);
    // The window itself is unaffected, which is the half that was designed:
    // substr(published_date, 1, 10) is "2026-09-03" in both spellings.
    expect(context?.articles).toHaveLength(2);
  });

  // SUSPECT, PINNED AS-IS -- and the reason this test imports the template
  // layer's own filter rather than describing what it would do. This module
  // formats published_date for display, then need_notification.njk:33 applies
  // `|date("N j, Y, P")` to the already-formatted string. djangoDate cannot
  // parse "Sept. 4, 2026, 9:30 a.m." and returns "" for anything unparseable
  // (filters.ts:152-155), so `<span class="articledate">` renders EMPTY in
  // the HTML half of the email. The plain-text half prints no date at all, so
  // nothing anywhere shows an article's date today.
  //
  // Only the HTML template is affected and only cosmetically, which is
  // exactly why it went unnoticed. Fixing it is a one-line choice -- drop the
  // filter in the template, or pass the raw column here -- but it changes
  // rendered mail, so it is reported rather than taken.
  it("pre-formats published_date, which the HTML template's second |date filter then blanks", async () => {
    seedTheNewsroom();

    const first = (await buildNeedEmailContext(session, needRow(), null))?.articles[0]!;

    expect(first.published_date).toBe("Sept. 4, 2026, 9:30 a.m.");
    expect(djangoDate(first.published_date, "N j, Y, P")).toBe("");
  });
});

// ===========================================================================
// The donation points line
// ===========================================================================

describe("buildNeedEmailContext -- the donation points line", () => {
  it("shows the line for a food bank with donation points", async () => {
    seedFoodbank({ id: 70, slug: "bath", name: "Bath", noDonationPoints: 12 });

    expect(await buildNeedEmailContext(session, needRow({ foodbank_id: 70 }), null)).toMatchObject({ show_donation_points: true });
  });

  // THE PYTHON TRUTH TABLE THIS REPRODUCES. Both templates say `{% if
  // need.foodbank.no_donation_points != 0 %}`, and in Python `None != 0` is
  // TRUE -- so a food bank whose count has never been computed has always
  // been shown the line. `!== 0` on a nullable column reproduces it; plain
  // truthiness (`if (foodbank.no_donation_points)`) would not, and would
  // silently drop the line for every never-counted food bank.
  //
  // routes/wfbn/updates.ts's confirmedEmailBodies deliberately does use plain
  // truthiness, because ITS Django original does. The two must not be
  // "harmonised" -- that comment is on the module, and this is the test that
  // makes deleting it fail.
  it("shows the line when the count has never been computed, matching Python's None != 0", async () => {
    seedFoodbank({ id: 71, slug: "frome", name: "Frome", noDonationPoints: null });

    expect(await buildNeedEmailContext(session, needRow({ foodbank_id: 71 }), null)).toMatchObject({ show_donation_points: true });
  });

  // The only value that hides it. A food bank with zero donation points has
  // nothing behind /donationpoints/, so the link would be a dead end.
  it("hides the line only for an explicit zero", async () => {
    seedFoodbank({ id: 72, slug: "gosport", name: "Gosport", noDonationPoints: 0 });

    expect(await buildNeedEmailContext(session, needRow({ foodbank_id: 72 }), null)).toMatchObject({ show_donation_points: false });
  });
});

// ===========================================================================
// The subscriber paragraph
// ===========================================================================

describe("buildNeedEmailContext -- the subscriber paragraph", () => {
  // gfadmin/views.py:2035 passes ONLY {need}, never {subscriber}, so the
  // shipped preview really does render "...you subscribed to them at
  // www.givefood.org.uk on  at ." with "?key=" on the unsubscribe link.
  // Reproduced, not "fixed": inventing a plausible-looking fake subscriber
  // would make the preview lie about the one paragraph that is per-recipient,
  // which is the paragraph most likely to be wrong in the real mail.
  it("renders the preview's blank subscriber paragraph when there is no subscriber", async () => {
    const context = await buildNeedEmailContext(session, needRow(), null);

    expect(context).toMatchObject({ subscriber_created_date: "", subscriber_created_time: "", unsub_key: "" });
  });

  // The send path's half (notify/needEmail.ts:98-103 overrides these same
  // three keys per recipient, so this is also the shape that must not drift
  // from what that loop writes). unsub_key is passed through untouched: it is
  // the key in the RFC 8058 List-Unsubscribe header as well as the link, and
  // any transformation here would break one-click unsubscribe for everyone.
  it("fills the paragraph from the subscriber the send path passes", async () => {
    const context = await buildNeedEmailContext(session, needRow(), {
      created: "2026-03-01 07:05:00.000000",
      unsub_key: "9f2b6c1d4e8a4f0b9c3d5e7a1b2c3d4e",
    });

    expect(context).toMatchObject({
      subscriber_created_date: "1st March 2026",
      subscriber_created_time: "7:05 a.m.",
      unsub_key: "9f2b6c1d4e8a4f0b9c3d5e7a1b2c3d4e",
    });
  });
});

// ===========================================================================
// formatSubscribedDate -- `{{ subscriber.created|date:"jS F Y" }}`
// ===========================================================================

// Both formatters are hand-rolled rather than routed through
// @givefood/templates' djangoDate, because its token table has no F, g or a
// (filters.ts:99-117). Every expectation below is Django's own output for the
// same instant, produced by running django.template.defaultfilters.date under
// the original site's venv -- not by reading the token docs.
describe("formatSubscribedDate", () => {
  it("matches Django's jS F Y on a stored Django-format timestamp", () => {
    expect(formatSubscribedDate("2026-09-05 19:28:08.853000")).toBe("5th September 2026");
  });

  // Django's S token has the 11th/12th/13th exception, and getting it wrong
  // produces "11st" -- the kind of thing a recipient notices and nobody
  // tests. All four suffixes plus the three exceptions, in one pass.
  it("gets every ordinal suffix right, including the 11th-to-13th exception", () => {
    const suffixes = [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 30, 31].map((day) =>
      formatSubscribedDate(`2026-01-${String(day).padStart(2, "0")} 09:00:00.000000`),
    );

    expect(suffixes).toEqual([
      "1st January 2026",
      "2nd January 2026",
      "3rd January 2026",
      "4th January 2026",
      "11th January 2026",
      "12th January 2026",
      "13th January 2026",
      "21st January 2026",
      "22nd January 2026",
      "23rd January 2026",
      "30th January 2026",
      "31st January 2026",
    ]);
  });

  // F is the month's full name, which is NOT what djangoDate's N token gives
  // ("Sept.", AP style) -- that is the whole reason this function exists
  // instead of a djangoDate call. Asserted against the N-token output of the
  // same instant so a future "just use djangoDate" change fails here rather
  // than shipping "5th Sept. 2026" to 5,855 inboxes.
  it("spells the month in full, unlike djangoDate's AP-style N token", () => {
    expect(formatSubscribedDate("2026-09-05 19:28:08.853000")).toContain("September");
    expect(djangoDate("2026-09-05 19:28:08.853000", "N")).toBe("Sept.");
  });

  // Every month, because MONTHS_FULL is an index-into-array and an off-by-one
  // in it is invisible for eleven twelfths of any single-month test.
  it("names all twelve months", () => {
    const months = Array.from({ length: 12 }, (_, i) => formatSubscribedDate(`2026-${String(i + 1).padStart(2, "0")}-15 12:00:00.000000`));

    expect(months).toEqual([
      "15th January 2026",
      "15th February 2026",
      "15th March 2026",
      "15th April 2026",
      "15th May 2026",
      "15th June 2026",
      "15th July 2026",
      "15th August 2026",
      "15th September 2026",
      "15th October 2026",
      "15th November 2026",
      "15th December 2026",
    ]);
  });

  // The two spellings this column has held, and one it should not have but
  // might: a bare date. All three are read as UTC, which is what the frozen
  // TZ=UTC in vitest.config.mts and the Workers runtime both guarantee -- a
  // developer in BST reading "2026-07-01 23:30" as local time would print
  // the 2nd of July.
  it("reads the ISO spelling and a bare date as the same UTC instant", () => {
    expect(formatSubscribedDate("2026-07-01T23:30:00.000Z")).toBe("1st July 2026");
    expect(formatSubscribedDate("2026-07-01 23:30:00.000000")).toBe("1st July 2026");
    expect(formatSubscribedDate("2026-07-01")).toBe("1st July 2026");
  });

  // SUSPECT, PINNED AS-IS. djangoDate guards its parse (`Number.isNaN(date
  // .getTime())` -> ""), these two do not -- so an unparseable or empty
  // `created` renders literal "NaNth undefined NaN" into the email body
  // instead of the blank the preview deliberately shows. Unreachable today:
  // foodbanksubscriber.created is TEXT NOT NULL and every writer goes through
  // pyNow(). It is asserted because the failure is loud in the worst possible
  // place -- a bulk send, already in flight -- and because the fix, if anyone
  // takes it, must be a decision about what an email should say rather than a
  // silent copy of djangoDate's guard.
  it("renders NaN garbage for an unparseable created, where djangoDate would render nothing", () => {
    expect(formatSubscribedDate("")).toBe("NaNth undefined NaN");
    expect(formatSubscribedDate("not a timestamp")).toBe("NaNth undefined NaN");
    expect(djangoDate("", "jS F Y")).toBe("");
  });
});

// ===========================================================================
// formatSubscribedTime -- `{{ subscriber.created|date:"g:i a" }}`
// ===========================================================================

describe("formatSubscribedTime", () => {
  // Django's `a` is "a.m."/"p.m." WITH the full stops -- and the .txt
  // template's own trailing full stop after it is what makes the shipped mail
  // say "at 7:28 p.m.." Both halves are deliberate; see the njk header.
  it("matches Django's g:i a across the twelve-hour boundary", () => {
    expect(formatSubscribedTime("2026-09-05 19:28:08.853000")).toBe("7:28 p.m.");
    expect(formatSubscribedTime("2026-09-05 09:05:00.000000")).toBe("9:05 a.m.");
    expect(formatSubscribedTime("2026-09-05 13:00:00.000000")).toBe("1:00 p.m.");
    expect(formatSubscribedTime("2026-09-05 23:59:00.000000")).toBe("11:59 p.m.");
  });

  // g:i ALWAYS prints minutes; the P token used for article dates drops ":00"
  // and says "midnight"/"noon" instead. Two formats, two behaviours, one
  // email -- asserted side by side so that "unifying" them is a failing test
  // rather than a quiet change to the subscriber paragraph.
  it("keeps :00 minutes and the numeric hour, unlike the P token used for article dates", () => {
    expect(formatSubscribedTime("2026-09-05 00:00:00.000000")).toBe("12:00 a.m.");
    expect(formatSubscribedTime("2026-09-05 12:00:00.000000")).toBe("12:00 p.m.");
    expect(djangoDate("2026-09-05 00:00:00.000000", "P")).toBe("midnight");
    expect(djangoDate("2026-09-05 12:00:00.000000", "P")).toBe("noon");
  });

  // 12:30 a.m. and 12:30 p.m. are the two the modulo gets wrong if it is
  // written `hours % 12` without the zero case -- "0:30 a.m." is not a time
  // anyone writes.
  it("calls the hour after midnight and the hour after noon 12, not 0", () => {
    expect(formatSubscribedTime("2026-09-05 00:30:00.000000")).toBe("12:30 a.m.");
    expect(formatSubscribedTime("2026-09-05 12:30:00.000000")).toBe("12:30 p.m.");
  });

  // Minutes are zero-padded, hours are not -- `g:i`, not `G:i` or `h:i`.
  it("zero-pads the minutes but never the hour", () => {
    expect(formatSubscribedTime("2026-09-05 08:07:00.000000")).toBe("8:07 a.m.");
  });

  // A bare date is midnight, matching the same value's date rendering above.
  it("reads a bare date as midnight UTC", () => {
    expect(formatSubscribedTime("2026-07-01")).toBe("12:00 a.m.");
  });

  // The other half of the missing guard -- see formatSubscribedDate's note.
  it("renders NaN garbage for an unparseable created, where djangoDate would render nothing", () => {
    expect(formatSubscribedTime("")).toBe("NaN:NaN p.m.");
    expect(djangoDate("", "g:i a")).toBe("");
  });
});
