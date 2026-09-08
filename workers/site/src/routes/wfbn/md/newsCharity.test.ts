import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../../index";
import type { AppEnv } from "../../../types";
import { formatCharityRegDate, openCharitiesUrl, pythonSplitlines } from "./newsCharity";

// routes/wfbn/md/newsCharity.ts -- the /md/ mirror's two charity/news pages
// (GET /md/needs/at/<slug>/news/ and .../charity/), plus the THREE HELPERS
// this file owns and ../newsCharity.ts imports back out of it:
// formatCharityRegDate, pythonSplitlines and openCharitiesUrl. Ported from
// gfwfbn/views.py:779-813 (`md_foodbank_news`, `md_foodbank_charity`) and
// gfwfbn/templates/wfbn/foodbank/md/news.md + charity.md, all four read in
// full alongside givefood/models/foodbank.py's articles(),
// has_charity_details(), open_charities_url() and charity_purpose_list().
//
// WHY THIS FILE EXISTS, GIVEN ../newsCharity.test.ts ALREADY COVERS THE HTML
// TWIN. The two handlers look like the same eleven lines twice, and they are
// not:
//
//   * the markdown news page prints `{{ article.url }}` -- the RAW scraped
//     url. The HTML page prints url_with_ref, mapArticleRow's ?ref= merge.
//     Both are correct (Django's news.md and news.html differ in exactly the
//     same way), and "make these two handlers share mapArticleRow" is a tidy-
//     up that would silently start attributing markdown traffic to us. The
//     seeded article's url carries a querystring precisely so that a ref
//     appearing there fails a test.
//   * full_name here is fullNameFoodbank -- ENGLISH ONLY. The /md/ views sit
//     outside i18n_patterns (givefood/urls.py's "Markdown versions" block, and
//     index.ts registers them outside its LOCALES loop), so there is no locale
//     to be aware of and alt_name must never win. The HTML twin's
//     fullNameLocaleAware would look identical on every English page and
//     change the Welsh ones.
//   * markdown has NO ESCAPING. Both templates are `{% autoescape false %}`,
//     so every value on these pages -- a scraped feed title above all -- lands
//     in the output verbatim, where a stray `]` or `(` re-punctuates somebody
//     else's link. The HTML twin's escaping tests say nothing about that.
//   * the three helpers are only reachable as functions from HERE. The twin
//     exercises them through rendered HTML, which cannot reach the branches
//     the pages never take -- an unparseable date, a country outside the four,
//     the empty string the module's own comment says never arrives.
//
// REAL EVERYTHING, the harness ../newsCharity.test.ts and ./donationpoints.
// test.ts already use: the real production app (src/index.ts's default
// export), so route registration order, resolveLanguage, slugRedirect,
// cacheTag and pageCacheControl are the genuine articles rather than a
// hand-built router; the real Nunjucks templates; the real packages/db queries
// over real in-memory SQLite whose DDL comes from schemaFor(), i.e. from the
// migrations. Nothing either route touches leaves the machine, so NOTHING is
// mocked -- the only vi.* call in this file is a console.error silencer on the
// two D1-outage tests.
//
// PARITY CLAIMS, AND WHICH ONES WERE ACTUALLY RUN. Django source was read out
// of /Users/jasoncartwright/Sites/foodcharity. Three claims were EXECUTED on
// this machine rather than reasoned about, and are marked where they are used:
//   * CPython 3.13.0 -- str.splitlines() on every input the pythonSplitlines
//     tests below use, including the four divergent ones.
//   * Django 5.2.6 -- django.utils.dateformat.format(d, "jS F Y") on twelve
//     dates, and str.title() on the three charity names seeded here.
//   * Django 5.2.6 -- django.conf.locale.en.formats.DATETIME_FORMAT, which is
//     "N j, Y, P": the format news.njk spells out explicitly and Django's
//     news.md gets implicitly from `{{ article.published_date }}` under
//     USE_L10N=True, TIME_ZONE="UTC", USE_TZ=False (givefood/settings.py:210).
// Anything not on that list is "read from the source", and where a claim would
// need a running Django to settle it the comment says so rather than inventing
// a citation.
//
// MUTATION-TESTED in an rsync'd copy of the tree OUTSIDE the repo (TESTING.md's
// "several suites were mutation-tested"). 23 mutants across these two handlers
// and the three helpers; ALL 23 KILLED, none survived. Every one was actually
// applied to the copy and run:
//   - the news feed guard deleted; each half deleted on its own; the whole
//     thing rewritten as `=== null` instead of falsy -- 4
//   - the charity guard's charity_name half and its country half deleted -- 2
//   - the article limit 20 -> 100 -- 1
//   - titleCapitalised dropped (raw titles) -- 1
//   - the article rows mapped through models' mapArticleRow, i.e. the HTML
//     twin's ?ref=-merging shape -- 1
//   - pythonSplitlines replaced with .split("\n"); its trailing-strip regex
//     un-anchored so it eats the FIRST terminator -- 2
//   - openCharitiesUrl's NIC strip dropped; its Scotland branch pointed at the
//     England/Wales path; its falsy-number guard deleted; its final `return
//     null` turned into the England/Wales url -- 4
//   - formatCharityRegDate's 11/12/13 exception dropped; its getUTCMonth()
//     given a +1 -- 2
//   - charity_reg_date passed through unformatted -- 1
//   - charity_purpose handed to pythonSplitlines unconditionally -- 1
//   - charity_years given a non-empty array -- 1
//   - the news response's Content-Type changed to text/html -- 1
//   - the article query given its own D1 session, spelled both ways (a fresh
//     c.env.DB.withSession(), and a second dbSession(c) call) -- 2

const ORIGIN = "https://www.givefood.org.uk";

type Bindable = null | number | bigint | string | Uint8Array;

// One statement as it reached the engine: the SQL text and the values bound to
// it. The bindings matter as much as the text -- the article query's LIMIT is a
// BOUND parameter, so a limit change is invisible in the SQL string alone, and
// the charity page's whole claim to being cheap is that this query is ABSENT
// from its log.
interface Prepared {
  sql: string;
  params: Bindable[];
}

// The slice of the D1 Sessions API packages/db uses, over node:sqlite. Same
// shim as ../newsCharity.test.ts, including its `batch` -- getFoodbankBySlug
// sends the food bank row and its latest need as ONE batch and indexes straight
// into the result array, so this must run them in order and return one result
// per input.
function d1Session(db: DatabaseSync, prepared: Prepared[]): D1DatabaseSession {
  const statement = (sql: string, entry: Prepared) => ({
    sql,
    get params() {
      return entry.params;
    },
    bind: (...next: unknown[]) => {
      entry.params = next as Bindable[];
      return statement(sql, entry);
    },
    first: async <T>() => (db.prepare(sql).get(...entry.params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...entry.params), success: true, meta: {} }),
    run: async () => {
      db.prepare(sql).run(...entry.params);
      return { success: true, meta: {} };
    },
  });
  return {
    prepare: (sql: string) => {
      const entry: Prepared = { sql, params: [] };
      prepared.push(entry);
      return statement(sql, entry);
    },
    batch: async (statements: Array<{ sql: string; params: Bindable[] }>) =>
      statements.map((s) => ({ results: db.prepare(s.sql).all(...s.params), success: true, meta: {} })),
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let prepared: Prepared[];
let sessions: number;

function env(): AppEnv["Bindings"] {
  return {
    DB: {
      withSession: () => {
        sessions += 1;
        return d1Session(db, prepared);
      },
    },
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: { get: async () => null, put: async () => {}, delete: async () => {} },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

// The two statements getFoodbankBySlug batches, spelled out so the per-page
// statement-log assertions can say "these two AND NOTHING ELSE".
const FOODBANK_SQL = "SELECT * FROM foodbank WHERE slug = ?";
const LATEST_NEED_SQL = "SELECT * FROM foodbankchange_full WHERE id = (SELECT latest_need_id FROM foodbank WHERE slug = ?)";
// packages/db/src/homepage.ts's getArticlesByFoodbankId, verbatim.
const ARTICLES_SQL =
  "SELECT a.id, a.foodbank_id, f.name AS foodbank_name, f.slug AS foodbank_slug, a.published_date, a.title, a.url, a.featured " +
  "FROM foodbankarticle a JOIN foodbank f ON f.id = a.foodbank_id WHERE a.foodbank_id = ? ORDER BY a.published_date DESC LIMIT ?";

// ---------------------------------------------------------------------------
// Seeds. Only the columns these two pages read are parameterised; every other
// NOT NULL column is filled with something the real migration accepts, so a
// seeded row is one production would have taken.
// ---------------------------------------------------------------------------

interface FoodbankSeed {
  id: number;
  slug: string;
  name: string;
  altName?: string | null;
  country?: string;
  rssUrl?: string | null;
  newsUrl?: string | null;
  charityNumber?: string | null;
  charityName?: string | null;
  charityJustFoodbank?: 0 | 1;
  charityType?: string | null;
  charityRegDate?: string | null;
  charityObjectives?: string | null;
  charityPurpose?: string | null;
  isClosed?: 0 | 1;
}

function seedFoodbank(s: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, alt_name, slug, address, postcode, country, lat_lng,
       latitude, longitude, network, charity_number, charity_just_foodbank, charity_name,
       charity_type, charity_reg_date, charity_objectives, charity_purpose, contact_email,
       url, shopping_list_url, rss_url, news_url, address_is_administrative, is_closed,
       no_locations, no_donation_points, days_between_needs, latest_need_id, created, modified)
     VALUES (?, ?, ?, ?, ?, '12 High Street\r\nHarnham', 'SP2 8LZ', ?, '51.0688,-1.7945',
       51.0688, -1.7945, 'Trussell', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, NULL, 14, NULL,
       '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run(
    s.id,
    String(s.id).padStart(32, "a"),
    s.name,
    s.altName ?? null,
    s.slug,
    s.country ?? "England",
    s.charityNumber ?? null,
    s.charityJustFoodbank ?? 0,
    s.charityName ?? null,
    s.charityType ?? null,
    s.charityRegDate ?? null,
    s.charityObjectives ?? null,
    s.charityPurpose ?? null,
    `info@${s.slug}.invalid`,
    `https://${s.slug}.invalid/`,
    `https://${s.slug}.invalid/list/`,
    s.rssUrl ?? null,
    s.newsUrl ?? null,
    s.isClosed ?? 0,
  );
}

// published_date is TEXT in Django's own spelling ("2026-09-05 19:28:08.853000",
// a space and six digits of microseconds) throughout, because that is what the
// ETL copied out of Postgres, what migrations/0022_normalise_timestamps.sql
// rewrote the port's own ISO-shaped rows INTO, and what the LEXICOGRAPHIC
// ORDER BY in getArticlesByFoodbankId is written against.
function seedArticle(a: { id: number; foodbankId: number | null; publishedDate: string; title: string; url: string; featured?: 0 | 1 }): void {
  db.prepare("INSERT INTO foodbankarticle (id, foodbank_id, published_date, title, url, featured) VALUES (?, ?, ?, ?, ?, ?)").run(
    a.id,
    a.foodbankId,
    a.publishedDate,
    a.title,
    a.url,
    a.featured ?? 0,
  );
}

// Only used by the route-ordering test: a LOCATION whose slug is the literal
// word "news" or "charity", i.e. the thing the generic /md/needs/at/:slug/
// :locslug/ route would happily serve if it were registered first.
function seedTrapLocation(o: { id: number; foodbankId: number; name: string; slug: string }): void {
  db.prepare(
    `INSERT INTO foodbanklocation (id, uuid, foodbank_id, name, slug, address, postcode, country,
       lat_lng, latitude, longitude, is_closed, modified)
     VALUES (?, ?, ?, ?, ?, '1 Trap Street', 'SP1 1AA', 'England', '51.07,-1.79', 51.07, -1.79, 0,
       '2020-01-01 00:00:00.000000')`,
  ).run(o.id, String(o.id).padStart(32, "e"), o.foodbankId, o.name, o.slug);
}

// THE FIXTURE IS THE TEST: each food bank turns exactly one guard or one
// computed field on or off relative to its neighbour.
//
//   1  salisbury     the full page: rss_url only, an England charity with every
//                    optional charity column populated, a lowercase
//                    charity_name (django_title's proof), a trailing newline on
//                    charity_purpose, a CRLF inside charity_objectives, and one
//                    article whose url already carries a querystring
//   2  bath          NO rss_url and NO news_url, NO charity_name -- the food
//                    bank both guards reject. It OWNS AN ARTICLE anyway, which
//                    is what makes the news 404 mean something
//   3  truro         Jersey: a real charity_name and number, outside
//                    CHARITY_DETAIL_COUNTRIES. news_url only, no rss_url, and
//                    no articles at all
//   4  caerdydd      Wales, alt_name set -- proof the /md/ mirror ignores it
//   5  glaschu       Scotland, charity_just_foodbank = 1, and NONE of the four
//                    optional charity columns
//   6  beul-feirste  Northern Ireland, charity_number carrying the "NIC" prefix
//                    openCharitiesUrl strips
//   7  empty-feeds   rss_url AND news_url both the EMPTY STRING, not NULL
//   8  closed-town   is_closed = 1, with both pages available
//   9  no-number     an England charity_name with a NULL charity_number
//  10  salvation-army  a DONT_APPEND_FOOD_BANK name -- full_name is the name
function seed(): void {
  seedFoodbank({
    id: 1,
    slug: "salisbury",
    name: "Salisbury",
    rssUrl: "https://salisburyfoodbank.org.uk/feed/",
    charityName: "salisbury foodbank trust",
    charityNumber: "1130237",
    charityType: "Charitable Incorporated Organisation",
    charityRegDate: "2009-08-03",
    charityObjectives: "To relieve financial hardship\r\nin and around the city",
    charityPurpose: "The prevention or relief of poverty\nGeneral charitable purposes\n",
  });
  seedArticle({
    id: 11,
    foodbankId: 1,
    publishedDate: "2026-09-05 19:28:08.853000",
    title: "SOUP  drive at the uk warehouse.",
    url: "https://salisburyfoodbank.org.uk/news/soup?utm_source=newsletter",
  });

  seedFoodbank({ id: 2, slug: "bath", name: "Bath" });
  // Bath has news to show and no way to be asked for it. If the feed guard
  // ever stops running, this article is what appears on the page.
  seedArticle({ id: 21, foodbankId: 2, publishedDate: "2026-08-01 10:00:00.000000", title: "Bath has news too", url: "https://bath.invalid/news/1" });

  seedFoodbank({
    id: 3,
    slug: "truro",
    name: "Truro",
    country: "Jersey",
    newsUrl: "https://truro.invalid/news/",
    charityName: "Truro Trust",
    charityNumber: "NPO123",
  });

  seedFoodbank({
    id: 4,
    slug: "caerdydd",
    name: "Caerdydd",
    altName: "Pantri Bwyd Bae Caerdydd",
    country: "Wales",
    rssUrl: "https://caerdydd.invalid/feed/",
    charityName: "Pantri Bwyd Bae Caerdydd Cyf",
    charityNumber: "1155555",
    charityPurpose: "Atal tlodi",
  });
  seedArticle({ id: 41, foodbankId: 4, publishedDate: "2026-09-06 08:00:00.000000", title: "Newyddion Caerdydd", url: "https://caerdydd.invalid/news/1" });

  seedFoodbank({
    id: 5,
    slug: "glaschu",
    name: "Glaschu",
    country: "Scotland",
    rssUrl: "https://glaschu.invalid/feed/",
    charityName: "Glaschu Foodbank SCIO",
    charityNumber: "SC012345",
    charityJustFoodbank: 1,
  });

  seedFoodbank({
    id: 6,
    slug: "beul-feirste",
    name: "Beul Feirste",
    country: "Northern Ireland",
    charityName: "Beul Feirste Foodbank",
    charityNumber: "NIC104444",
  });

  seedFoodbank({ id: 7, slug: "empty-feeds", name: "Empty Feeds", rssUrl: "", newsUrl: "" });

  seedFoodbank({
    id: 8,
    slug: "closed-town",
    name: "Closed Town",
    isClosed: 1,
    rssUrl: "https://closed-town.invalid/feed/",
    charityName: "Closed Town Trust",
    charityNumber: "1199999",
  });

  seedFoodbank({ id: 9, slug: "no-number", name: "No Number", charityName: "No Number Trust", charityNumber: null });

  seedFoodbank({
    id: 10,
    slug: "salvation-army",
    name: "Salvation Army",
    rssUrl: "https://sa.invalid/feed/",
    charityName: "The Salvation Army",
    charityNumber: "214779",
  });

  // Seeded HERE rather than inside the test that uses it, because
  // middleware/slugRedirect.ts memoises the whole map at module scope for five
  // minutes: a row inserted after beforeEach's warm-up call would not be in the
  // memo, and the test that asserts /md/ URLs do NOT redirect would pass for
  // the wrong reason -- an empty map rather than an unmatched path.
  db.prepare(
    "INSERT INTO slugredirect (id, old_slug, new_slug, created, modified) VALUES (1, 'old-sarum', 'salisbury', '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')",
  ).run();
}

beforeEach(async () => {
  db = new DatabaseSync(":memory:");
  // schemaFor, not hand-written DDL: getFoodbankBySlug reads through the
  // `foodbankchange_full` VIEW (github #51 -- eight suites 500'd at once when
  // it started doing so), `foodbankarticle` lost its foodbank_name column in
  // migration 0019, `foodbanklocation` is here only for the route-ordering
  // trap below, and `slugredirect` is read by the slugRedirect middleware on
  // every /needs/at/ URL whether these routes want it or not.
  db.exec(schemaFor("foodbank", "foodbankchange", "foodbankchange_full", "foodbankarticle", "foodbanklocation", "foodbanklocation_full", "slugredirect"));
  seed();
  prepared = [];
  sessions = 0;

  // WARM THE SLUG-REDIRECT MEMO BEFORE COUNTING ANYTHING, and warm it with a
  // NON-/md/ path on purpose. slugRedirect's SLUG_PATTERN is anchored at "^",
  // so no /md/ URL ever matches it and no /md/ request would load the map --
  // which would leave the memo empty and make "the /md/ mirror does not follow
  // a slug redirect" a test that proves nothing. Loading it here means that
  // test runs against a map that really does contain old-sarum.
  await get("/needs/at/warm-the-memo/");
  prepared = [];
  sessions = 0;
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

// `async`, not a bare arrow: app.fetch is typed Response | Promise<Response>.
const get = async (path: string, init?: RequestInit): Promise<Response> => app.fetch(new Request(`${ORIGIN}${path}`, init), env(), execCtx);
const body = async (path: string): Promise<string> => (await get(path)).text();

// One rendered `- [title](url) (date)` line, split back into its three
// independently-portable pieces. Reading them apart is the point: the title is
// titleCapitalised, the url is the RAW column and the date is djangoDate, and
// each can be wrong on its own.
interface RenderedArticle {
  title: string;
  url: string;
  date: string;
}

function newsItems(md: string): RenderedArticle[] {
  return md
    .split("\n")
    .filter((line) => line.startsWith("- ["))
    .map((line) => {
      const m = /^- \[(.*)\]\((.*)\) \((.*)\)$/.exec(line);
      if (!m) throw new Error(`unparseable news line: ${JSON.stringify(line)}`);
      return { title: m[1] as string, url: m[2] as string, date: m[3] as string };
    });
}

// The charity page's bullet block, as { label: value } -- everything between
// "- " and the first ": ". Kept raw (the number row is a markdown link) rather
// than stripped.
function charityFields(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of md.split("\n")) {
    const m = /^- ([^:]+): (.*)$/.exec(line);
    if (m) out[m[1] as string] = m[2] as string;
  }
  return out;
}

// The "## Purposes" bullets only -- charityFields above cannot see them
// (a purpose has no "label: value" shape) and they must not be confused with
// the field bullets above them.
function purposeBullets(md: string): string[] {
  const section = md.split("## Purposes\n\n")[1];
  if (section === undefined) return [];
  return section
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
}

// ---------------------------------------------------------------------------
// The three exported helpers, called directly. ../newsCharity.ts imports all
// three back out of this module, so each is on two pages; and each has
// branches no page can reach, which is what these unit tests are for.
// ---------------------------------------------------------------------------

describe("formatCharityRegDate", () => {
  // Django's `jS F Y` (charity.md line 8's `|date:'jS F Y'`), formatted here
  // rather than by the shared djangoDate filter because filters.ts's token
  // table has no S and no F. VERIFIED by running Django 5.2.6 on this machine:
  // django.utils.dateformat.format(date.fromisoformat(d), "jS F Y") returns
  // exactly these twelve strings for these twelve dates.
  it("suffixes every ordinal day the way Django's jS does, teens included", () => {
    const on = (day: string) => formatCharityRegDate(`2009-08-${day}`);

    expect(on("01")).toBe("1st August 2009");
    expect(on("02")).toBe("2nd August 2009");
    expect(on("03")).toBe("3rd August 2009");
    expect(on("04")).toBe("4th August 2009");
    // 11/12/13 are the whole reason the suffix is a function and not a lookup
    // on the last digit.
    expect(on("11")).toBe("11th August 2009");
    expect(on("12")).toBe("12th August 2009");
    expect(on("13")).toBe("13th August 2009");
    // ...and 21/22/23 are what says the exception is scoped to the teens
    // rather than to "any day ending 1".
    expect(on("21")).toBe("21st August 2009");
    expect(on("22")).toBe("22nd August 2009");
    expect(on("23")).toBe("23rd August 2009");
  });

  // MONTH_NAMES is indexed by the ZERO-BASED getUTCMonth(), so January and
  // December are the two that catch an off-by-one -- one would read "February"
  // and the other would run off the end of the table into `undefined`.
  it("names the first and last months in full, from a zero-based index", () => {
    expect(formatCharityRegDate("2011-01-31")).toBe("31st January 2011");
    expect(formatCharityRegDate("2011-12-25")).toBe("25th December 2011");
  });

  // TWO SPELLINGS OF THE SAME DATE LIVE IN THIS COLUMN. The ETL writes a bare
  // "YYYY-MM-DD" while the values that predate it carry a "00:00:00.000000"
  // suffix (workers/jobs/src/charity/crawlOpenCharities.ts's own header records
  // this). Both must format identically or a charity page would change its
  // wording the first time the daily crawl touched it. The single .replace()
  // is what handles the second spelling -- and the appended "Z" is what makes
  // both TZ-independent, which matters because a late-evening UTC timestamp
  // read in a west-of-UTC zone would otherwise print the previous day.
  it("formats the bare date and the midnight-suffixed date identically, in UTC", () => {
    expect(formatCharityRegDate("2009-08-03")).toBe("3rd August 2009");
    expect(formatCharityRegDate("2009-08-03 00:00:00.000000")).toBe("3rd August 2009");
    expect(formatCharityRegDate("2009-08-03 23:59:59.000000")).toBe("3rd August 2009");
  });

  // SUSPECT, PINNED AS-IS -- three ways this returns a wrong answer instead of
  // throwing, and the FIRST is the worst because nothing about it looks wrong.
  // Unlike the shared djangoDate filter, which was given an isNaN guard
  // precisely because a bad stored value 500'd the admin dashboard, this
  // function has none:
  //
  //   * "registered in 2009" is SALVAGED by V8's lenient Date parser into
  //     2009-01-01, so the page states a precise registration day that is not
  //     in the data at all.
  //   * "2009-02-30" does not exist; JS rolls it forward to 2 March.
  //   * an already-ISO value gets a SECOND "Z" appended ("...T00:00:00ZZ") and
  //     is unparseable -- so the one spelling djangoDate learned to handle
  //     (filters.ts strips a trailing Z for exactly this reason) is the one
  //     this helper breaks on. Junk prints "NaNth undefined NaN": ugly, but at
  //     least visibly broken.
  //
  // All four outputs were produced by running this test, not reasoned about.
  // charity_reg_date is regulator-supplied and none of these is a state today's
  // data reaches, which is exactly why they need a test rather than a glance.
  it("SUSPECT: invents a date from a salvageable string, rolls an impossible one over, and NaNs an ISO one", () => {
    expect(formatCharityRegDate("registered in 2009")).toBe("1st January 2009");
    expect(formatCharityRegDate("2009-02-30")).toBe("2nd March 2009");
    expect(formatCharityRegDate("2009-08-03T00:00:00Z")).toBe("NaNth undefined NaN");
    expect(formatCharityRegDate("not a date")).toBe("NaNth undefined NaN");
    expect(formatCharityRegDate("")).toBe("NaNth undefined NaN");
  });
});

describe("pythonSplitlines", () => {
  // Foodbank.charity_purpose_list() (givefood/models/foodbank.py:410-414) is
  // `self.charity_purpose.splitlines()`. EVERY EXPECTATION IN THIS TEST WAS
  // PRODUCED BY RUNNING CPython 3.13.0 ON THIS MACHINE -- `python3 -c
  // "print(repr('a\\nb\\n'.splitlines()))"` and friends -- not read off the
  // documentation.
  //
  // The trailing terminator is the whole point: JS's plain .split("\n") turns
  // "a\nb\n" into ["a","b",""] and Python does not, and the symptom of getting
  // it wrong is one empty "- " bullet at the end of a list nobody re-reads.
  it("drops a single trailing terminator, exactly as CPython does", () => {
    expect(pythonSplitlines("a\nb\n")).toEqual(["a", "b"]);
    expect(pythonSplitlines("a\r\nb\r\n")).toEqual(["a", "b"]);
    expect(pythonSplitlines("a\rb\r")).toEqual(["a", "b"]);
    // Unterminated, so there is nothing to strip -- and the strip regex is
    // anchored, so it cannot eat a real character off the end.
    expect(pythonSplitlines("a")).toEqual(["a"]);
    expect(pythonSplitlines("a\nb")).toEqual(["a", "b"]);
  });

  // ONLY the trailing one. An internal blank line is a real (empty) line in
  // Python, and so is the one left behind by a DOUBLE trailing terminator:
  // CPython's "a\n\n".splitlines() is ['a', ''], and this returns the same.
  // "Tidy the empty bullet away" would diverge from Django.
  it("keeps internal and doubled blank lines, which are real lines in Python", () => {
    expect(pythonSplitlines("a\n\nb")).toEqual(["a", "", "b"]);
    expect(pythonSplitlines("a\n\n")).toEqual(["a", ""]);
    expect(pythonSplitlines("\n")).toEqual([""]);
  });

  // The three ASCII line terminators, mixed in one value. OSCR's purposes
  // arrive comma-joined and are rewritten to lines by
  // workers/jobs/src/charity/crawlOpenCharities.ts's toLines(), so the
  // separator this column holds is not a single fixed one. CPython agrees:
  // 'One\r\nTwo\rThree\nFour\r\n'.splitlines() == ['One','Two','Three','Four'].
  it("splits on CRLF, lone CR and LF alike, without splitting CRLF twice", () => {
    expect(pythonSplitlines("One\r\nTwo\rThree\nFour\r\n")).toEqual(["One", "Two", "Three", "Four"]);
  });

  // SUSPECT, AND BOTH HALVES WERE CONFIRMED AGAINST CPython 3.13.0 HERE.
  // Python's splitlines is not a three-terminator split:
  //
  //   * ''.splitlines() is [], but this returns [''] -- one empty bullet where
  //     Django renders none. The module's own comment says the empty string
  //     never reaches this function because the call site guards on
  //     truthiness, and that is true of BOTH call sites today (this file's
  //     mdFoodbankCharity and ../newsCharity.ts's wfbnFoodbankCharity). Pinned
  //     because "the guard is over there" is exactly the kind of invariant a
  //     third caller breaks.
  //   * Python also splits on VT (\x0b), FF (\x0c), \x1c-\x1e, NEL (\x85)
  //     and U+2028/U+2029; this port splits on CR and LF only. Confirmed by
  //     running CPython here: 'A\x0bB'.splitlines() is ['A','B'] where this
  //     returns ['A\x0bB']. A regulator's API emitting a vertical tab is
  //     far-fetched; U+2028, which scraped web text does carry, less so.
  //     Spelled with a \u escape below because a LITERAL U+2028 is a line
  //     terminator to a JS parser and would end this comment mid-sentence.
  it("SUSPECT: diverges from CPython on the empty string and on the non-CR/LF line terminators", () => {
    expect(pythonSplitlines("")).toEqual([""]); // CPython: []
    expect(pythonSplitlines("A\x0bB")).toEqual(["A\x0bB"]); // CPython: ['A', 'B']
    expect(pythonSplitlines("A\x85B")).toEqual(["A\x85B"]); // CPython: ['A', 'B']
    expect(pythonSplitlines("A\u2028B")).toEqual(["A\u2028B"]); // CPython: ['A', 'B']
  });
});

describe("openCharitiesUrl", () => {
  // Foodbank.open_charities_url() (givefood/models/foodbank.py:339-348).
  // opencharities.uk is a THIRD-PARTY aggregator and is NOT the same target as
  // charity_register_url()'s official register (ported separately in
  // lib/fields.ts) -- the /needs/at/<slug>/ page links to the latter, this page
  // to the former, and the two have been conflated before. Each country gets
  // its own two-letter path segment, and England and Wales SHARE one.
  it("builds each country's own opencharities path", () => {
    expect(openCharitiesUrl("1130237", "England")).toBe("https://opencharities.uk/ew/1130237");
    expect(openCharitiesUrl("1155555", "Wales")).toBe("https://opencharities.uk/ew/1155555");
    expect(openCharitiesUrl("SC012345", "Scotland")).toBe("https://opencharities.uk/sc/SC012345");
  });

  // NORTHERN IRELAND IS THE ONE THAT TRANSFORMS ITS INPUT: the stored number
  // carries the regulator's "NIC" prefix and opencharities' NI path does not
  // want it. Django uses .replace("NIC","") -- Python's str.replace is
  // GLOBAL, so the port's /NIC/g matches it rather than JS's default
  // first-occurrence-only behaviour, which is why the doubled case is here.
  // A row that never had the prefix must pass through untouched.
  it("strips every NIC prefix for Northern Ireland, and tolerates a number without one", () => {
    expect(openCharitiesUrl("NIC104444", "Northern Ireland")).toBe("https://opencharities.uk/ni/104444");
    expect(openCharitiesUrl("NICNIC1", "Northern Ireland")).toBe("https://opencharities.uk/ni/1");
    expect(openCharitiesUrl("104444", "Northern Ireland")).toBe("https://opencharities.uk/ni/104444");
  });

  // NO NUMBER, NO LINK -- Django's `if not self.charity_number: return None`,
  // falsiness rather than a null test, so the empty string an ETL might write
  // instead of NULL is treated the same. Returning a bare
  // "https://opencharities.uk/ew/" for a blank number would be a link to the
  // aggregator's own error page from every charity page missing a number.
  it("returns null for a missing or empty charity number, whatever the country", () => {
    expect(openCharitiesUrl(null, "England")).toBeNull();
    expect(openCharitiesUrl("", "England")).toBeNull();
    expect(openCharitiesUrl(null, "Scotland")).toBeNull();
  });

  // THE COUNTRIES WITH NO BRANCH. Django's method has an Isle of Man branch in
  // charity_register_url() and NOT in open_charities_url(), so both fall
  // through to an implicit None -- the port's explicit `return null` matches.
  // Moot for the page (CHARITY_DETAIL_COUNTRIES rejects these countries before
  // this is called) and NOT moot for ../newsCharity.ts, which calls the same
  // helper. The comparison is also case-SENSITIVE, matching Django's `==`.
  it("returns null for a country with no aggregator page, and is case-sensitive", () => {
    expect(openCharitiesUrl("NPO123", "Jersey")).toBeNull();
    expect(openCharitiesUrl("1130237", "Isle of Man")).toBeNull();
    expect(openCharitiesUrl("1130237", "Guernsey")).toBeNull();
    expect(openCharitiesUrl("1130237", "")).toBeNull();
    expect(openCharitiesUrl("1130237", "england")).toBeNull();
  });

  // Django interpolates the number with a bare "%s" and so does this, with no
  // encodeURIComponent -- a number containing a space or a slash produces a
  // broken url rather than an escaped one. PARITY, pinned rather than
  // "fixed": charity numbers are regulator-issued alphanumerics, and encoding
  // here would silently change every existing NI/SC url if one ever were not.
  it("interpolates the number verbatim, encoding nothing, as Django's %s does", () => {
    expect(openCharitiesUrl("a b/c?d", "England")).toBe("https://opencharities.uk/ew/a b/c?d");
  });
});

// ---------------------------------------------------------------------------
// mdFoodbankNews
// ---------------------------------------------------------------------------

describe("mdFoodbankNews -- the response envelope", () => {
  // Django's `md_foodbank_news` carries @cache_page(SECONDS_IN_DAY)
  // (gfwfbn/views.py:778), and pageCacheControl's fall-through rule is that
  // same day. text/markdown is one of the three types that middleware will
  // stamp at all (CACHEABLE_TYPES), so getting the Content-Type wrong does not
  // merely mislabel the body -- it silently un-caches the page.
  it("serves markdown, cacheable for five minutes in the browser and a day at the edge", async () => {
    const res = await get("/md/needs/at/salisbury/news/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    expect(res.headers.get("Content-Language")).toBe("en");
    // No map on this page, so no geojson preload hint -- cacheTag's FOODBANK
    // pattern covers /md/ but geoJsonPreload's route list does not.
    expect(res.headers.get("Link")).toBeNull();
  });

  // THE TAG IS WHY THE DAY ABOVE IS SAFE. cacheTag.ts's FOODBANK_PATH has an
  // optional "/md" prefix precisely so the markdown mirror is purged by the
  // same queue message as the HTML page. Without it, editing a food bank would
  // leave its /md/ pages stale for a day with nothing able to clear them --
  // and Cloudflare strips Cache-Tag before a browser sees it, so nobody would
  // notice from outside.
  it("stamps the food bank's own purge tag on the markdown mirror too", async () => {
    expect((await get("/md/needs/at/salisbury/news/")).headers.get("Cache-Tag")).toBe("fb-salisbury");
    expect((await get("/md/needs/at/truro/news/")).headers.get("Cache-Tag")).toBe("fb-truro");
  });

  // ONE D1 SESSION, THREE STATEMENTS, AND THE SHAPE OF THEM.
  //
  // The first two are getFoodbankBySlug's BATCH -- one round trip, not two.
  // The third is the article list, and its `20` is Django's own slice
  // (Foodbank.articles(), models/foodbank.py:307-309, `[:20]`) arriving as a
  // BOUND parameter, which is the only place a limit change would show.
  //
  // THE SESSION COUNT IS NOT DECORATION. lib/session.ts's dbSession() is a
  // one-line wrapper around c.env.DB.withSession("first-unconstrained") with NO
  // memo, so calling it a second time really does open a second session --
  // meaning the article list could be read from a different replica snapshot
  // than the food bank row it belongs to. Both spellings of that mistake (a
  // second dbSession(c), and an inline withSession()) were applied as mutants
  // and both were caught here, by the count alone.
  it("reads the page from one session: the batched foodbank+need pair, then twenty articles", async () => {
    await get("/md/needs/at/salisbury/news/");

    expect(sessions).toBe(1);
    expect(prepared.map((p) => [p.sql, p.params])).toEqual([
      [FOODBANK_SQL, ["salisbury"]],
      [LATEST_NEED_SQL, ["salisbury"]],
      [ARTICLES_SQL, [1, 20]],
    ]);
  });

  // A GET THAT WRITES is the failure this asserts against -- a route in this
  // repo has been caught with one before. A page stamped `s-maxage=86400`
  // cannot afford a side effect: the edge would serve it once and swallow
  // every subsequent one.
  it("issues nothing but SELECTs", async () => {
    await get("/md/needs/at/salisbury/news/");
    await get("/md/needs/at/salisbury/charity/");

    expect(prepared).not.toHaveLength(0);
    for (const { sql } of prepared) expect(sql).toMatch(/^SELECT /);
  });

  // An unknown slug is Django's get_object_or_404. It must reach the real 404
  // page -- which is HTML, not markdown, because the 404 is the site's own
  // page and not this route's output -- and above all must NOT be stamped
  // cacheable: pageCacheControl only touches 200s, so a mistyped slug cannot
  // poison the edge with a day-long negative entry.
  it("404s an unknown slug, uncached and untagged, without asking for its articles", async () => {
    const res = await get("/md/needs/at/nowhere/news/");

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(res.headers.get("Cache-Tag")).toBeNull();
    // The lookup fails BEFORE the article query, so a bad slug costs two
    // statements and not three.
    expect(prepared.map((p) => p.sql)).toEqual([FOODBANK_SQL, LATEST_NEED_SQL]);
  });

  // lib/appendSlash.ts, Django's APPEND_SLASH. The redirect is issued only
  // after a HEAD probe of the slashed URL comes back non-404, so this also
  // pins that the probe finds the route at all.
  it("redirects the slashless spelling rather than 404ing it", async () => {
    const res = await get("/md/needs/at/salisbury/news");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/md/needs/at/salisbury/news/`);
  });

  // ...and does NOT redirect to a page the guard would 404 anyway. Bath's
  // slashless news URL stays a 404 because appendSlash's probe gets one, which
  // is the difference between a dead end and a redirect to a dead end.
  it("does not redirect the slashless spelling of a page the feed guard rejects", async () => {
    expect((await get("/md/needs/at/bath/news")).status).toBe(404);
  });

  // GET ONLY, matching Django. index.ts registers this with app.get; a stray
  // app.all would hand a POST to a handler whose response pageCacheControl
  // then... would not stamp, as it happens (it is GET-only too), but the
  // handler would still run its queries for a method Django refuses.
  it("does not answer a POST at all", async () => {
    expect((await get("/md/needs/at/salisbury/news/", { method: "POST" })).status).toBe(404);
  });

  // HEAD IS NOT DECORATION HERE: appendSlash's own probe is a HEAD request, so
  // a route that failed to answer one would break every slashless URL on the
  // markdown mirror. The body is empty and the headers are the GET's.
  it("answers HEAD with the markdown headers and no body", async () => {
    const res = await get("/md/needs/at/salisbury/news/", { method: "HEAD" });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(await res.text()).toBe("");
  });

  // The slug comparison is SQLite's default case-sensitive `=` on TEXT, so a
  // shouted URL is a 404 rather than a second, uncanonical spelling of the
  // page.
  it("does not answer a differently-cased slug", async () => {
    expect((await get("/md/needs/at/SALISBURY/news/")).status).toBe(404);
  });

  // THE /md/ MIRROR HAS NO LOCALE VARIANTS AT ALL. givefood/urls.py keeps the
  // "Markdown versions" block outside i18n_patterns and index.ts registers
  // these routes outside its LOCALES loop, so /cy/md/... is not a page -- and
  // it 404s BEFORE any database work, which is what the empty statement log
  // says.
  it("does not answer under a language prefix, and spends no query finding out", async () => {
    const res = await get("/cy/md/needs/at/salisbury/news/");

    expect(res.status).toBe(404);
    expect(prepared).toEqual([]);
  });

  // A D1 outage must produce the 500 page, not a news page with an empty list
  // -- and must not be cached, or "this food bank has published nothing" goes
  // out to every LLM and reader for a day.
  it("500s, uncached, when the database is unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      ...env(),
      DB: {
        withSession: () => {
          throw new Error("D1_ERROR: network");
        },
      },
    } as unknown as AppEnv["Bindings"];

    const res = await app.fetch(new Request(`${ORIGIN}/md/needs/at/salisbury/news/`), broken, execCtx);

    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(await res.text()).not.toContain("# News");
  });
});

describe("mdFoodbankNews -- the feed guard, which is not about articles", () => {
  // gfwfbn/views.py:785-786, `if not foodbank.rss_url and not
  // foodbank.news_url: return HttpResponseNotFound()`. The page exists because
  // the food bank PUBLISHES, not because we happen to hold articles for it --
  // Bath owns an article and still has no news page.
  it("404s a food bank with neither feed url, even though it has an article", async () => {
    const res = await get("/md/needs/at/bath/news/");

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("Bath has news too");
    // And the guard short-circuits the query: Bath's article is never fetched.
    expect(prepared.map((p) => p.sql)).toEqual([FOODBANK_SQL, LATEST_NEED_SQL]);
  });

  // EITHER url is enough, and they are checked independently. Truro has
  // news_url and NO rss_url; Salisbury the reverse. A guard collapsed into a
  // single-column check would 404 exactly one of these two.
  it("serves the page for rss_url alone and for news_url alone", async () => {
    expect((await get("/md/needs/at/salisbury/news/")).status).toBe(200);
    expect((await get("/md/needs/at/truro/news/")).status).toBe(200);
  });

  // THE EMPTY STRING IS NOT A URL. `!foodbank.rss_url` is falsiness, not a
  // NULL test, and D1 holds both spellings of "no feed" -- a scraped-then-
  // blanked column arrives as ''. Django's `not foodbank.rss_url` is falsy for
  // '' too, so this is parity; pinned because "IS NOT NULL" is the
  // obvious-looking way to write the same guard and would 200 this page over
  // an empty list.
  it("treats empty-string feed urls as no feed at all", async () => {
    expect((await get("/md/needs/at/empty-feeds/news/")).status).toBe(404);
  });

  // The guard runs on the FEED columns and nothing else -- a closed food bank
  // with a feed keeps its news page. Unlike the HTML twin there is no noindex
  // meta to add here: news.njk has no closed-bank branch at all, matching
  // Django's news.md, which is why the whole body is asserted.
  it("still serves a closed food bank's news page, with no closure notice in the markdown", async () => {
    expect(await body("/md/needs/at/closed-town/news/")).toBe("# News - Closed Town Foodbank\n\n\n\n");
  });
});

describe("mdFoodbankNews -- the article list, which is the whole page", () => {
  // THE WHOLE BODY, AS ONE VALUE, because in markdown the whitespace IS the
  // document: the blank line after the h1 and the newline ending each bullet
  // are what make this parse as a heading and a list rather than one
  // paragraph. Three computed values sit inside it:
  //   * title_captialised -- capwords plus the acronym table plus a
  //     trailing-period strip plus whitespace collapse. "SOUP" is lowered to
  //     "Soup" while "uk" is RESTORED to "UK", the pair that says the acronym
  //     pass ran in the right order, and the doubled space is collapsed.
  //   * the url -- RAW, exactly as scraped. See the header: the HTML twin
  //     merges ?ref=givefood.org.uk here and this page must not, matching
  //     Django's news.md (`{{ article.url }}`) against news.html.
  //   * published_date through `|date("N j, Y, P")` -- Django's
  //     DATETIME_FORMAT for the en locale, which is what
  //     `{{ article.published_date }}` resolves to in news.md under
  //     USE_L10N=True (verified by importing
  //     django.conf.locale.en.formats on this machine, Django 5.2.6):
  //     "Sept." not "Sep.", and a 12-hour clock.
  it("renders the h1, the blank line and one bullet carrying the raw url", async () => {
    expect(await body("/md/needs/at/salisbury/news/")).toBe(
      "# News - Salisbury Foodbank\n\n" +
        "- [Soup Drive At The UK Warehouse](https://salisburyfoodbank.org.uk/news/soup?utm_source=newsletter) (Sept. 5, 2026, 7:28 p.m.)\n\n\n",
    );
  });

  // THE ONE ASSERTION THAT SEPARATES THIS PAGE FROM ITS HTML TWIN, stated on
  // its own so it cannot be lost in a whole-body diff. The seeded url already
  // carries a querystring, so a ref merged in would appear as "&ref=" and a
  // ref appended to a bare url as "?ref=" -- neither may be here.
  it("does not merge a ?ref= tracking parameter into the article url", async () => {
    const [article] = newsItems(await body("/md/needs/at/salisbury/news/"));

    expect(article?.url).toBe("https://salisburyfoodbank.org.uk/news/soup?utm_source=newsletter");
    expect(article?.url).not.toContain("ref=givefood.org.uk");
  });

  // Django's `P` token has two special cases the port copies verbatim
  // (django.utils.dateformat.DateFormat.P): an exact midnight and an exact
  // noon print the WORD. An article scraped from a feed that carries a date
  // but no time lands on exactly midnight, so this is the ordinary case.
  it("prints midnight and noon as words, and drops :00 minutes", async () => {
    db.prepare("DELETE FROM foodbankarticle WHERE foodbank_id = 1").run();
    seedArticle({ id: 12, foodbankId: 1, publishedDate: "2026-09-03 00:00:00.000000", title: "Midnight", url: "https://a.invalid/1" });
    seedArticle({ id: 13, foodbankId: 1, publishedDate: "2026-09-02 12:00:00.000000", title: "Noon", url: "https://a.invalid/2" });
    seedArticle({ id: 14, foodbankId: 1, publishedDate: "2026-09-01 15:00:00.000000", title: "Three", url: "https://a.invalid/3" });

    expect(newsItems(await body("/md/needs/at/salisbury/news/")).map((a) => a.date)).toEqual([
      "Sept. 3, 2026, midnight",
      "Sept. 2, 2026, noon",
      "Sept. 1, 2026, 3 p.m.",
    ]);
  });

  // ORDER BY published_date DESC, ON TEXT. SQLite compares these
  // lexicographically, which agrees with chronological order ONLY because
  // every stored value has the same fixed width -- the reason
  // migrations/0022_normalise_timestamps.sql exists at all. Two articles on
  // the same day an hour apart is the case a broken comparison gets wrong
  // while still looking sorted.
  it("lists the newest article first, including within a single day", async () => {
    seedArticle({ id: 15, foodbankId: 1, publishedDate: "2026-09-05 09:00:00.000000", title: "Same day morning", url: "https://a.invalid/4" });
    seedArticle({ id: 16, foodbankId: 1, publishedDate: "2026-09-05 21:00:00.000000", title: "Same day evening", url: "https://a.invalid/5" });
    seedArticle({ id: 17, foodbankId: 1, publishedDate: "2025-12-31 23:59:59.999000", title: "Last year", url: "https://a.invalid/6" });

    expect(newsItems(await body("/md/needs/at/salisbury/news/")).map((a) => a.title)).toEqual([
      "Same Day Evening",
      "Soup Drive At The UK Warehouse",
      "Same Day Morning",
      "Last Year",
    ]);
  });

  // THE SCOPE. Caerdydd's article is NEWER than any of Salisbury's, so a
  // `WHERE a.foodbank_id = ?` that stopped filtering would put it at the TOP
  // of Salisbury's list -- and an orphan article (foodbank_id NULL, which the
  // table permits) would be dropped by the JOIN rather than crashing the page.
  // Seeding both and asserting their absence is the only thing that
  // distinguishes a working filter from no filter at all.
  it("shows only this food bank's articles, and never an orphan row", async () => {
    seedArticle({ id: 19, foodbankId: null, publishedDate: "2030-09-09 19:00:00.000000", title: "Orphan article", url: "https://a.invalid/8" });

    const titles = newsItems(await body("/md/needs/at/salisbury/news/")).map((a) => a.title);
    expect(titles).toEqual(["Soup Drive At The UK Warehouse"]);
    expect(titles).not.toContain("Newyddion Caerdydd");
    expect(titles).not.toContain("Orphan Article");
  });

  // Foodbank.articles() slices `[:20]` (givefood/models/foodbank.py:307-309)
  // and the port binds that 20 as the LIMIT. 22 more articles in, 20 lines
  // out, and the ones that fall off are the OLDEST -- so a limit applied
  // before the sort, or a limit quietly raised to the /news/ page's 100, both
  // show up here.
  it("shows at most the twenty newest, dropping the oldest", async () => {
    for (let n = 1; n <= 22; n += 1) {
      seedArticle({
        id: 100 + n,
        foodbankId: 1,
        publishedDate: `2026-01-${String(n).padStart(2, "0")} 12:00:00.000000`,
        title: `Story ${String(n).padStart(2, "0")}`,
        url: `https://salisburyfoodbank.org.uk/news/${n}`,
      });
    }

    const titles = newsItems(await body("/md/needs/at/salisbury/news/")).map((a) => a.title);
    expect(titles).toHaveLength(20);
    // The seeded September article outranks every January one.
    expect(titles[0]).toBe("Soup Drive At The UK Warehouse");
    expect(titles[1]).toBe("Story 22");
    expect(titles[19]).toBe("Story 04");
    expect(titles).not.toContain("Story 03");
    expect(titles).not.toContain("Story 01");
  });

  // A food bank with a feed but nothing scraped from it yet is a 200 with an
  // EMPTY list, not a 404 and not an error -- and the exact body matters,
  // because a heading followed by three newlines is what the `{% for %}`
  // leaves behind and is what any downstream markdown consumer sees. The
  // article query still runs (the guard is about feeds, not rows).
  it("renders a bare heading, not an error, when the feed has produced nothing", async () => {
    expect(await body("/md/needs/at/truro/news/")).toBe("# News - Truro Foodbank\n\n\n\n");
    expect(prepared.map((p) => p.sql)).toEqual([FOODBANK_SQL, LATEST_NEED_SQL, ARTICLES_SQL]);
  });

  // `featured` scopes the HOMEPAGE query, not this one. getArticlesByFoodbankId
  // has no featured predicate, and an article this food bank published is its
  // news whether or not anyone promoted it.
  it("does not filter on featured", async () => {
    db.prepare("DELETE FROM foodbankarticle WHERE foodbank_id = 1").run();
    seedArticle({ id: 20, foodbankId: 1, publishedDate: "2026-07-01 12:00:00.000000", title: "Unfeatured", url: "https://a.invalid/9", featured: 0 });
    seedArticle({ id: 22, foodbankId: 1, publishedDate: "2026-07-02 12:00:00.000000", title: "Featured", url: "https://a.invalid/10", featured: 1 });

    expect(newsItems(await body("/md/needs/at/salisbury/news/")).map((a) => a.title)).toEqual(["Featured", "Unfeatured"]);
  });

  // SUSPECT, PINNED, AND IT IS PARITY: news.njk is `{% autoescape false %}`
  // and Django's news.md is `{% autoescape off %}`, so a scraped feed title
  // -- untrusted text off somebody else's web site -- lands in the markdown
  // VERBATIM. The "]" closes the link text early and the "(" opens a second
  // target, so a hostile title rewrites its own bullet into a link pointing
  // wherever the attacker likes, and any markdown a title contains is live.
  // The same is true of the url's own ")".
  //
  // Not a port defect, and NOT nothing either: /md/ exists to be read by
  // language models (routes/public/md.ts, llms.txt), which is a more
  // credulous consumer than a browser with an HTML escaper in front of it.
  // Left exactly as Django has it; recorded here so the next person to look
  // does not have to rediscover it.
  it("SUSPECT: lets a scraped title inject markdown, exactly as Django's autoescape-off template does", async () => {
    db.prepare("DELETE FROM foodbankarticle WHERE foodbank_id = 1").run();
    seedArticle({
      id: 200,
      foodbankId: 1,
      publishedDate: "2026-06-01 00:00:00.000000",
      title: "Hostile ] and ( ) [link](https://evil.invalid) <b>",
      url: "https://evil.invalid/?a=1)&b=2",
    });

    expect(await body("/md/needs/at/salisbury/news/")).toBe(
      "# News - Salisbury Foodbank\n\n" + "- [Hostile ] And ( ) [link](https://evil.invalid) <b>](https://evil.invalid/?a=1)&b=2) (June 1, 2026, midnight)\n\n\n",
    );
  });

  // The two degenerate rows the scraper can produce: a title that cleaned down
  // to nothing renders an empty link label, and an unparseable published_date
  // renders "()" because djangoDate returns "" for it rather than throwing.
  // Both are ugly and neither may 500 the page -- this route has no try/catch,
  // so a filter that threw would take out the whole markdown mirror for that
  // food bank.
  it("renders an empty label and an empty date rather than failing on a degenerate row", async () => {
    db.prepare("DELETE FROM foodbankarticle WHERE foodbank_id = 1").run();
    seedArticle({ id: 201, foodbankId: 1, publishedDate: "2026-06-02 12:00:00.000000", title: "", url: "https://a.invalid/empty" });
    seedArticle({ id: 202, foodbankId: 1, publishedDate: "not a date", title: "Bad date", url: "https://a.invalid/bad" });

    expect(newsItems(await body("/md/needs/at/salisbury/news/"))).toEqual([
      // "not a date" sorts after "2026-..." lexicographically, so it leads.
      { title: "Bad Date", url: "https://a.invalid/bad", date: "" },
      { title: "", url: "https://a.invalid/empty", date: "June 2, 2026, noon" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// mdFoodbankCharity
// ---------------------------------------------------------------------------

describe("mdFoodbankCharity -- the response envelope", () => {
  // Django's `md_foodbank_charity` carries @cache_page(SECONDS_IN_DAY) too
  // (gfwfbn/views.py:795), and gets the same fall-through day here.
  it("serves markdown with the food bank's purge tag", async () => {
    const res = await get("/md/needs/at/salisbury/charity/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    expect(res.headers.get("Cache-Tag")).toBe("fb-salisbury");
  });

  // TWO STATEMENTS, NOT THREE. Every value this page shows is a column on the
  // food bank row, so the batch is the whole of its database work -- and in
  // particular it must NOT pay for the news page's article query. An
  // accidentally shared helper that fetched articles for both would be
  // invisible in the rendered page and would cost a round trip on every
  // charity view.
  it("reads the page from one session and asks for no articles at all", async () => {
    await get("/md/needs/at/salisbury/charity/");

    expect(sessions).toBe(1);
    expect(prepared.map((p) => [p.sql, p.params])).toEqual([
      [FOODBANK_SQL, ["salisbury"]],
      [LATEST_NEED_SQL, ["salisbury"]],
    ]);
  });

  it("404s an unknown slug, uncached and untagged, and redirects the slashless spelling", async () => {
    const missing = await get("/md/needs/at/nowhere/charity/");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).toBeNull();
    expect(missing.headers.get("Cache-Tag")).toBeNull();

    const redirect = await get("/md/needs/at/salisbury/charity");
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("Location")).toBe(`${ORIGIN}/md/needs/at/salisbury/charity/`);

    expect((await get("/md/needs/at/salisbury/charity/", { method: "POST" })).status).toBe(404);
  });

  it("500s, uncached, when the database is unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      ...env(),
      DB: {
        withSession: () => {
          throw new Error("D1_ERROR: network");
        },
      },
    } as unknown as AppEnv["Bindings"];

    const res = await app.fetch(new Request(`${ORIGIN}/md/needs/at/salisbury/charity/`), broken, execCtx);

    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(await res.text()).not.toContain("1130237");
  });
});

describe("mdFoodbankCharity -- the two guards, which are an AND of unrelated things", () => {
  // gfwfbn/views.py:803, `if not foodbank.charity_name or not
  // foodbank.has_charity_details()`. BOTH halves are separately load-bearing
  // and the fixture separates them: Bath has a UK country and no charity_name,
  // Truro has a charity_name and a country with no aggregator page. Test only
  // one and a dropped half is invisible.
  it("404s a UK food bank with no charity_name, and a named charity outside the four countries", async () => {
    expect((await get("/md/needs/at/bath/charity/")).status).toBe(404);

    const jersey = await get("/md/needs/at/truro/charity/");
    expect(jersey.status).toBe(404);
    expect(await jersey.text()).not.toContain("Truro Trust");
  });

  // CHARITY_DETAIL_COUNTRIES is the four UK nations (@givefood/models, from
  // givefood/models/foodbank.py:321). All four must serve the page -- a Set
  // that lost a member would 404 an entire nation's charity pages while the
  // other three stayed perfect.
  it("serves all four register countries", async () => {
    for (const slug of ["salisbury", "caerdydd", "glaschu", "beul-feirste"]) {
      expect((await get(`/md/needs/at/${slug}/charity/`)).status, slug).toBe(200);
    }
  });

  // The empty string is not a charity name. `!foodbank.charity_name` is
  // falsiness, matching Django's `not foodbank.charity_name`; an ETL that
  // wrote '' rather than NULL must not produce a page whose second line reads
  // " operates under a registered charity."
  it("treats an empty-string charity_name as no charity", async () => {
    db.prepare("UPDATE foodbank SET charity_name = '' WHERE slug = 'salisbury'").run();

    expect((await get("/md/needs/at/salisbury/charity/")).status).toBe(404);
  });
});

describe("mdFoodbankCharity -- the rendered page", () => {
  // THE WHOLE DOCUMENT, AS ONE VALUE. In markdown every newline is content:
  // the bullets must each end one line, "## Objectives" must have a blank line
  // above and below it, and the CRLF inside charity_objectives must survive
  // RAW -- the HTML twin runs that column through |linebreaksbr and this one
  // must not (Django's charity.md prints `{{ foodbank.charity_objectives }}`
  // bare). Every computed value the handler passes appears here at once:
  // full_name, django_title'd charity_name, open_charities_url,
  // charity_reg_date and charity_purpose_list.
  it("renders every populated row, the raw objectives and the purpose bullets", async () => {
    expect(await body("/md/needs/at/salisbury/charity/")).toBe(
      "# Charity - Salisbury Foodbank\n\n" +
        "Salisbury Foodbank operates under a registered charity.\n\n" +
        "- Charity name: Salisbury Foodbank Trust\n" +
        "- Charity number: [1130237](https://opencharities.uk/ew/1130237)\n" +
        "- Charity type: Charitable Incorporated Organisation\n" +
        "- Registration date: 3rd August 2009\n\n" +
        "## Objectives\n\nTo relieve financial hardship\r\nin and around the city\n\n" +
        "## Purposes\n\n- The prevention or relief of poverty\n- General charitable purposes\n\n\n\n",
    );
  });

  // GLASCHU'S WHOLE PAGE, the negative of Salisbury's: none of the four
  // optional columns, so both prose sections and both optional bullets are
  // absent and only the trailing newlines the skipped `{% if %}` blocks leave
  // behind remain. A gate that stopped gating would print "- Charity type: "
  // over nothing.
  //
  // It also pins `charity_name|django_title` -- Python's str.title(). VERIFIED
  // by running CPython 3.13.0 on this machine: 'salisbury foodbank
  // trust'.title() is 'Salisbury Foodbank Trust', and -- the interesting one --
  // 'Glaschu Foodbank SCIO'.title() is 'Glaschu Foodbank Scio'. Django LOWERS
  // that acronym too, so the port doing it is parity, and "fix the acronym"
  // would be the divergence.
  it("renders Glaschu's whole page: no optional rows, no prose sections, and a lowered acronym", async () => {
    expect(await body("/md/needs/at/glaschu/charity/")).toBe(
      "# Charity - Glaschu Foodbank\n\n" +
        "Glaschu Foodbank is a registered charity.\n\n" +
        "- Charity name: Glaschu Foodbank Scio\n" +
        "- Charity number: [SC012345](https://opencharities.uk/sc/SC012345)\n\n\n\n\n\n",
    );
  });

  // charity_just_foodbank picks between two whole sentences, and it is the one
  // thing on the page that says whether this charity IS the food bank or
  // merely hosts it. Both spellings are asserted because the flag is a 0/1
  // INTEGER in D1 and a boolean in Django -- coerceBooleans is what makes
  // `{% if %}` agree, and a 0 that stayed a 0 is still falsy while a 1 that
  // became "1" is still truthy, so only the pair proves the branch.
  it("switches the opening sentence on charity_just_foodbank", async () => {
    expect(await body("/md/needs/at/salisbury/charity/")).toContain("Salisbury Foodbank operates under a registered charity.");
    expect(await body("/md/needs/at/glaschu/charity/")).toContain("Glaschu Foodbank is a registered charity.");
  });

  // Each optional row is gated on its own column. An empty string must omit
  // the row entirely rather than print a label over nothing -- Django's
  // `{% if foodbank.charity_type %}` is falsy for '' too.
  it("omits the type and registration rows when their columns are empty strings", async () => {
    db.prepare("UPDATE foodbank SET charity_type = '', charity_reg_date = '' WHERE slug = 'salisbury'").run();

    const fields = charityFields(await body("/md/needs/at/salisbury/charity/"));
    expect(Object.keys(fields)).toEqual(["Charity name", "Charity number"]);
  });

  // A NULL date omits the row rather than rendering an empty one: the handler
  // passes null (not the unformatted column) and the template gates on it.
  it("omits the registration date row when the column is null", async () => {
    db.prepare("UPDATE foodbank SET charity_reg_date = NULL WHERE slug = 'salisbury'").run();

    expect(charityFields(await body("/md/needs/at/salisbury/charity/"))).not.toHaveProperty("Registration date");
  });

  // FULL_NAME IS fullNameFoodbank, NOT fullNameLocaleAware -- English only,
  // because the /md/ mirror has no locale variants (see the envelope test that
  // 404s /cy/md/...). Caerdydd HAS an alt_name, which the Welsh HTML page uses
  // verbatim; here it must be ignored and the English suffix appended instead.
  // Swapping in the locale-aware helper would look identical on every English
  // page and would be wrong on exactly this one.
  it("appends Foodbank in English and ignores alt_name entirely", async () => {
    // The heading and the sentence are the two places full_name appears, so
    // both are read; asserting them as whole lines is what stops the seeded
    // charity_name (which begins with the alt_name) from making a bare
    // "does not contain" pass for the wrong reason.
    const lines = (await body("/md/needs/at/caerdydd/charity/")).split("\n");

    expect(lines[0]).toBe("# Charity - Caerdydd Foodbank");
    expect(lines[2]).toBe("Caerdydd Foodbank operates under a registered charity.");
    // What the Welsh HTML page would say instead, and this one must not.
    expect(lines[0]).not.toBe("# Charity - Pantri Bwyd Bae Caerdydd");
  });

  // DONT_APPEND_FOOD_BANK: "Salvation Army" is already a name that reads
  // wrongly with "Foodbank" bolted on, and fullNameFoodbank leaves it alone.
  // The sentence beneath the heading uses the same value, so a broken helper
  // shows up twice.
  it("leaves a DONT_APPEND_FOOD_BANK name unsuffixed in both places it appears", async () => {
    const md = await body("/md/needs/at/salvation-army/charity/");

    expect(md).toContain("# Charity - Salvation Army\n");
    expect(md).toContain("Salvation Army operates under a registered charity.");
    expect(md).not.toContain("Salvation Army Foodbank");
  });

  // THE DELIBERATE GAP. `charity_years` is hardcoded `[]` because D1 has no
  // charityyear table (packages/db/migrations/*.sql), so the Income &
  // Expenditure table Django renders is permanently absent. Pinned so that the
  // day a migration adds the table, THIS test fails and someone remembers the
  // handler still passes an empty array -- exactly the kind of stub that
  // otherwise survives forever. Note the template gates on `.length`, not on
  // truthiness: an empty ARRAY is truthy in JS, so `{% if charity_years %}`
  // (the literal translation of Django's `{% if charity_years %}`, where an
  // empty queryset is falsy) would print a headed, empty table.
  it("renders no income and expenditure section, because D1 has no charityyear table", async () => {
    const md = await body("/md/needs/at/salisbury/charity/");

    expect(md).not.toContain("Income & Expenditure");
    expect(md).not.toContain("| Year |");
  });
});

describe("mdFoodbankCharity -- the computed fields, through the page", () => {
  // The helpers are unit-tested above; these assert the HANDLER actually wires
  // each one into the template rather than passing the raw column.
  it("formats charity_reg_date rather than printing the stored value", async () => {
    expect(charityFields(await body("/md/needs/at/salisbury/charity/"))["Registration date"]).toBe("3rd August 2009");
    expect(await body("/md/needs/at/salisbury/charity/")).not.toContain("2009-08-03");
  });

  it("builds the country's own opencharities link, stripping NIC for Northern Ireland", async () => {
    expect(charityFields(await body("/md/needs/at/salisbury/charity/"))["Charity number"]).toBe("[1130237](https://opencharities.uk/ew/1130237)");
    expect(charityFields(await body("/md/needs/at/caerdydd/charity/"))["Charity number"]).toBe("[1155555](https://opencharities.uk/ew/1155555)");
    expect(charityFields(await body("/md/needs/at/glaschu/charity/"))["Charity number"]).toBe("[SC012345](https://opencharities.uk/sc/SC012345)");
    // The link TEXT keeps the prefix, the target drops it -- a strip applied
    // to the wrong one is still a plausible-looking page.
    expect(charityFields(await body("/md/needs/at/beul-feirste/charity/"))["Charity number"]).toBe("[NIC104444](https://opencharities.uk/ni/104444)");
  });

  // charity_NUMBER is not part of either guard -- only charity_name and the
  // country are -- so a charity with no number renders, and the number row
  // becomes the empty markdown link "[]()". SUSPECT, pinned as-is: Django's
  // charity.md is identical (`[{{ foodbank.charity_number }}]({{
  // foodbank.open_charities_url }})`, ungated, with open_charities_url
  // returning None), so this is the port faithfully reproducing a
  // link-to-nowhere. In markdown it is worse than in HTML: "[]()" is an empty
  // link with an empty target, which several renderers emit as a link to the
  // current document and others leave as literal text.
  it("SUSPECT: renders an empty markdown link when the charity has a name but no number", async () => {
    expect(await body("/md/needs/at/no-number/charity/")).toContain("- Charity number: []()\n");
  });

  // charity_purpose_list is pythonSplitlines, and the seeded value ends in
  // "\n" on purpose: a plain .split("\n") would add a trailing "- " bullet.
  it("drops a trailing newline without dropping a real bullet", async () => {
    expect(purposeBullets(await body("/md/needs/at/salisbury/charity/"))).toEqual([
      "The prevention or relief of poverty",
      "General charitable purposes",
    ]);
  });

  // An INTERNAL blank line is a real (empty) line in Python and stays one
  // here, rendering a bare "- " bullet. Pinned as the faithful port: tidying
  // it away would diverge from Django.
  it("keeps an internal blank line as an empty bullet, as Python does", async () => {
    db.prepare("UPDATE foodbank SET charity_purpose = 'Poverty\n\nEducation' WHERE slug = 'salisbury'").run();

    expect(purposeBullets(await body("/md/needs/at/salisbury/charity/"))).toEqual(["Poverty", "", "Education"]);
  });

  it("splits on CRLF, lone CR and LF alike", async () => {
    db.prepare("UPDATE foodbank SET charity_purpose = 'One\r\nTwo\rThree\nFour\r\n' WHERE slug = 'salisbury'").run();

    expect(purposeBullets(await body("/md/needs/at/salisbury/charity/"))).toEqual(["One", "Two", "Three", "Four"]);
  });

  it("leaves a single unterminated line alone", async () => {
    expect(purposeBullets(await body("/md/needs/at/caerdydd/charity/"))).toEqual(["Atal tlodi"]);
  });

  // THE GUARD AT THE CALL SITE IS WHAT KEEPS pythonSplitlines OFF NULL. The
  // handler's `foodbank.charity_purpose ? ... : []` is not a tidy-up: the
  // helper takes a string and would throw on null, and this route has no
  // try/catch, so an unconditional call would 500 the charity page of every
  // food bank whose purposes have not been crawled -- which is most of them.
  // Glaschu's page (200, above) already proves the null case; this proves the
  // empty-string case, where the template's own `{% if %}` then omits the
  // whole section rather than printing a heading over nothing.
  it("omits the Purposes section entirely for a null or empty charity_purpose", async () => {
    expect(await body("/md/needs/at/glaschu/charity/")).not.toContain("## Purposes");

    db.prepare("UPDATE foodbank SET charity_purpose = '' WHERE slug = 'salisbury'").run();
    expect(await body("/md/needs/at/salisbury/charity/")).not.toContain("## Purposes");
  });

  // A purpose that is nothing but a newline is TRUTHY, so it passes the
  // template's gate and reaches pythonSplitlines, which returns [''] --
  // producing a "## Purposes" heading over one empty bullet. CPython's
  // "\n".splitlines() is [''] too (run here), so this is parity.
  it("renders a lone newline as a heading over a single empty bullet", async () => {
    db.prepare("UPDATE foodbank SET charity_purpose = '\n' WHERE slug = 'salisbury'").run();

    const md = await body("/md/needs/at/salisbury/charity/");
    expect(md).toContain("## Purposes\n\n- \n");
    expect(purposeBullets(md)).toEqual([""]);
  });
});

// ---------------------------------------------------------------------------
// Both routes, and the things only the /md/ mirror has to get right
// ---------------------------------------------------------------------------

describe("both markdown routes -- registration order and the mirror's own rules", () => {
  // index.ts's own comment claims the literal-segment sub-pages are registered
  // "before the generic :locslug catch-all, so news/charity/nearby/etc. aren't
  // captured by it". That claim is only checkable with a food bank that HAS a
  // location slugged "news" -- which is not far-fetched, since location slugs
  // come from location names. If the order ever flipped, these two URLs would
  // quietly start serving a location page: a 200 with a plausible heading,
  // which no status-code assertion could tell from the right page.
  it("serves the news and charity pages, not a location that happens to be slugged news or charity", async () => {
    seedTrapLocation({ id: 501, foodbankId: 1, name: "Trap News Centre", slug: "news" });
    seedTrapLocation({ id: 502, foodbankId: 1, name: "Trap Charity Centre", slug: "charity" });
    db.prepare("UPDATE foodbank SET no_locations = 2 WHERE slug = 'salisbury'").run();

    const news = await body("/md/needs/at/salisbury/news/");
    expect(news.startsWith("# News - Salisbury Foodbank\n")).toBe(true);
    expect(news).not.toContain("Trap News Centre");

    const charity = await body("/md/needs/at/salisbury/charity/");
    expect(charity.startsWith("# Charity - Salisbury Foodbank\n")).toBe(true);
    expect(charity).not.toContain("Trap Charity Centre");
  });

  // SUSPECT, AND IT IS PARITY WITH DJANGO. middleware/slugRedirect.ts's
  // SLUG_PATTERN is anchored `^(/<locale>)?/needs/at/...`, so a /md/ URL never
  // matches and a renamed food bank's markdown pages 404 instead of
  // redirecting -- while its HTML pages 301 correctly (asserted in
  // ../newsCharity.test.ts). Django's SlugRedirectMiddleware
  // (givefood/middleware.py:177-178) uses the same anchored pattern with
  // re.match, so production behaves identically; this is a faithful port of a
  // gap, not a port defect.
  //
  // The memo is warmed with a real /needs/at/ request in beforeEach precisely
  // so this proves the PATH does not match, rather than proving the redirect
  // map happened to be empty -- the HTML spelling below is the control.
  it("SUSPECT: does not follow a renamed food bank's slug redirect on /md/, though the HTML page does", async () => {
    expect((await get("/md/needs/at/old-sarum/news/")).status).toBe(404);
    expect((await get("/md/needs/at/old-sarum/charity/")).status).toBe(404);

    const html = await get("/needs/at/old-sarum/news/");
    expect(html.status).toBe(301);
    expect(html.headers.get("Location")).toBe("/needs/at/salisbury/news/");
  });

  // Neither markdown page emits any site chrome: no menu, no breadcrumb, no
  // hit beacon, no render-time comment. The HTML twins carry all four, and the
  // markdown templates extend nothing -- so a base template accidentally
  // introduced here would put a <script> tag in a text/markdown response.
  it("emits no HTML chrome, no beacon and no render-time comment", async () => {
    for (const path of ["/md/needs/at/salisbury/news/", "/md/needs/at/salisbury/charity/"]) {
      const md = await body(path);
      expect(md, path).not.toContain("<");
      expect(md, path).not.toContain("Took");
      expect(md, path).not.toContain("hit/");
    }
  });

  // Both handlers build their own Response rather than going through Hono's
  // c.html/c.text, so the charset is theirs to get right -- and it is the
  // LOWERCASE "utf-8" spelling Django's `content_type='text/markdown;
  // charset=utf-8'` uses, not the "UTF-8" the HTML pages carry.
  it("declares the markdown content type in Django's exact spelling on both pages", async () => {
    expect((await get("/md/needs/at/salisbury/news/")).headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect((await get("/md/needs/at/salisbury/charity/")).headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
  });
});
