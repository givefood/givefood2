import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { getFoodbankForArticleCrawl, getFoodbanksWithRss, insertArticleIfNew, updateFoodbankLastCrawl } from "./articles";
import { pyDatetime } from "@givefood/models";
import type { Session } from "./types";

// The getarticles pipeline's D1 layer (PLAN.md §8.6): the cron's enqueue
// query, the consumer's re-fetch, the dedup insert and the last_crawl stamp.
//
// RUN AGAINST A REAL DATABASE, NOT A FAKE. Every function here is one SQL
// statement and nothing else, so a mock that answers canned rows would be
// testing a second implementation of the query rather than the query. The
// failures this module can produce are all silent -- a dropped predicate
// enqueues closed food banks, a lost `OR IGNORE` duplicates 17,000 articles,
// a wrong bind writes a URL into the title column -- and none of them throw,
// so the only proof available is "these rows, in this order, and no others".
//
// The schema below is copied from the migrations, not derived from the
// TypeScript interfaces above the functions, because the disagreements
// between those two is precisely what a db-tier test is for. (One is found:
// ArticleCrawlFoodbankRow declares `rss_url: string`, the column is nullable
// -- see "returns a row whose rss_url has since been cleared" below.)
//
// MUTATION-TESTED, per TESTING.md's convention: a copy of articles.ts was
// broken 44 ways in a scratchpad and this file re-run against each one.
// Killed: dropped is_closed filter, dropped `!= ''` filter, dropped/reversed/
// re-keyed ORDER BY, SELECT *, a narrowed projection, an added LIMIT 2, an
// added `AND is_closed = 0` or `AND rss_url IS NOT NULL` on the re-fetch, a
// dropped or negated WHERE on either the re-fetch or the last_crawl UPDATE,
// OR IGNORE -> OR REPLACE and -> plain INSERT, every same-typed bind swap in
// both write statements, featured 0 -> 1, the featured column dropped
// entirely, `changes > 0` -> `>= 0`/true/false/last_row_id, a `modified` bump
// added, a reformatted published_date or last_crawl, and an INNER JOIN onto
// foodbankarticle.
//
// FOUR SURVIVED. Three were real gaps and the last three tests in the
// getFoodbanksWithRss block below were written to close them -- an added
// LIMIT 100, an added predicate on a column every fixture leaves NULL
// (`AND last_crawl IS NULL`), and a LEFT JOIN onto foodbankarticle; each of
// those tests names its mutant. The fourth is not a gap but a fact about SQL
// -- see "drops a NULL feed URL under `!= ''` alone" below.
//
// Two mutants are genuinely equivalent and no test can or should catch them:
// `WHERE id = ?2` -> `WHERE rowid = ?2` (id is INTEGER PRIMARY KEY, so it IS
// the rowid) and `is_closed = 0` -> `COALESCE(is_closed, 0) = 0` (the column
// is NOT NULL).
//
// Sibling packages/db suites (locationsAdmin.test.ts, foodbankAdmin.test.ts)
// explain that they hand-model SQLite's semantics instead of running them,
// because packages/db typechecks with @cloudflare/workers-types only and has
// no @types/node. That is still true of `pnpm typecheck` -- this file needs
// "node" adding to the package's tsconfig `types` to typecheck, which is a
// config change and not a test change. It runs correctly under vitest, whose
// node environment has node:sqlite regardless.

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

// foodbank: 0001_core.sql:10-48 verbatim, unaltered by any later migration.
// Copied in full rather than trimmed to the four columns these queries touch,
// because two of the details that matter are things a trimmed table would
// quietly get wrong: `rss_url` is NULLABLE (so `IS NOT NULL` is a real filter,
// not decoration) and `is_closed` is NOT NULL (so `is_closed = 0` needs no
// three-valued-logic care, unlike the nullable booleans elsewhere in this
// schema). The two UNIQUE indexes come with it so a fixture row cannot be one
// production would have refused.
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

// foodbankarticle, built the way production was built: created by
// 0003_homepage_data.sql:47-53, given its URL constraint by
// 0010_article_url_unique.sql, then stripped of its denormalised parent name
// by 0019_drop_foodbank_cache.sql and re-exposed through a view.
//
// The DROP COLUMN is replayed rather than the table simply being declared
// without foodbank_name, because 0019 is this repo's scar: it silently broke
// four queries that still named dropped columns, and /dashboard/beautybanks/
// was a live 500 nobody noticed. A fixture that declares the post-migration
// shape directly could not catch an INSERT that named foodbank_name; this one
// fails with "no column named foodbank_name", which is what D1 would say.
const SCHEMA_ARTICLE = `
CREATE TABLE foodbankarticle (
  id INTEGER PRIMARY KEY,
  foodbank_id INTEGER, foodbank_name TEXT,
  published_date TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
  featured INTEGER NOT NULL
);
CREATE INDEX article_published_idx ON foodbankarticle(published_date DESC) WHERE featured = 1;
CREATE UNIQUE INDEX article_url_uniq ON foodbankarticle(url);
ALTER TABLE foodbankarticle DROP COLUMN foodbank_name;
CREATE VIEW foodbankarticle_full AS
  SELECT a.*, f.name AS foodbank_name, f.slug AS foodbank_slug
    FROM foodbankarticle a
    LEFT JOIN foodbank f ON f.id = a.foodbank_id;
`;

// ---------------------------------------------------------------------------
// The Session adapter
// ---------------------------------------------------------------------------

type Bindable = null | number | bigint | string | Uint8Array;

// Same shape as workers/site/src/routes/admin/foodbankLocation.test.ts's
// adapter, with one addition that is load-bearing here: `meta.changes` is the
// engine's own sqlite3_changes(), not a hand-rolled count. insertArticleIfNew
// returns `meta.changes > 0` and the queue consumer turns that into
// foundNew -> a cache purge, so "the second insert of the same URL reports
// false" is a claim about what SQLite does with OR IGNORE. A fake that
// returned `changes: 1` unconditionally would agree with an implementation
// that had lost the OR IGNORE entirely.
function d1Session(db: DatabaseSync) {
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
// Fixtures
// ---------------------------------------------------------------------------

let db: DatabaseSync;
let session: Session;

interface FoodbankSeed {
  id: number;
  slug: string;
  name?: string;
  rssUrl?: string | null;
  isClosed?: 0 | 1;
  lastCrawl?: string | null;
}

// Fills every NOT NULL column the real table declares, so a seeded row is one
// the production schema would actually accept. The values are deliberately
// dull except for the four columns these queries read.
function seedFoodbank({ id, slug, name, rssUrl = null, isClosed = 0, lastCrawl = null }: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank (
       id, uuid, name, slug, address, postcode, country, lat_lng,
       charity_just_foodbank, contact_email, url, shopping_list_url,
       rss_url, address_is_administrative, is_closed, no_locations,
       days_between_needs, last_crawl, created, modified
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, ?, 0, 14, ?, ?, ?)`,
  ).run(
    id,
    `${slug.replace(/-/g, "")}00000000000000000000000000`.slice(0, 32),
    name ?? slug.replace(/(^|-)(\w)/g, (_m, _p, c: string) => c.toUpperCase()),
    slug,
    "1 High Street",
    "SP1 1AA",
    "England",
    "51.0688,-1.7945",
    `info@${slug}.foodbank.org.uk`,
    `https://${slug}.foodbank.org.uk/`,
    `https://${slug}.foodbank.org.uk/shopping-list/`,
    rssUrl,
    isClosed,
    lastCrawl,
    "2020-01-01 00:00:00.000000",
    "2026-08-01 09:15:22.412000",
  );
}

// An article row as the ETL wrote it (tools/pg-to-d1/extract_core.py's
// strftime, normalised by 0022_normalise_timestamps.sql): Django-format
// timestamp, explicit id, featured 0/1. Not written through
// insertArticleIfNew, because these stand in for the 17,196 rows that were
// already there before the crawler ever ran -- the population the crawler's
// own rows have to sort correctly against.
function seedArticle(row: { id: number; foodbankId: number | null; publishedDate: string; title: string; url: string; featured?: 0 | 1 }): void {
  db.prepare("INSERT INTO foodbankarticle (id, foodbank_id, published_date, title, url, featured) VALUES (?, ?, ?, ?, ?, ?)").run(
    row.id,
    row.foodbankId,
    row.publishedDate,
    row.title,
    row.url,
    row.featured ?? 0,
  );
}

// Ids that are deliberately not in slug order, so that "ordered by slug" and
// "ordered by id" cannot both be true of the same expected array.
const SALISBURY = 22;
const WESTBURY = 12;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_FOODBANK);
  db.exec(SCHEMA_ARTICLE);
  session = d1Session(db);
});

// ---------------------------------------------------------------------------
// getFoodbanksWithRss -- the cron's enqueue query
// ---------------------------------------------------------------------------

describe("getFoodbanksWithRss", () => {
  // Ids assigned out of slug order on purpose: an ORDER BY that was dropped,
  // or written as ORDER BY id, returns 7, 12, 41, 88 and fails here. Rows are
  // also inserted in a third order so that "whatever the table happens to
  // return" is not accidentally right either.
  function seedTheCountry(): void {
    seedFoodbank({ id: WESTBURY, slug: "westbury", rssUrl: "https://westbury.foodbank.org.uk/feed/" });
    seedFoodbank({ id: 88, slug: "west-norfolk", rssUrl: "https://westnorfolk.foodbank.org.uk/feed/" });
    seedFoodbank({ id: 7, slug: "bath", rssUrl: "https://bath.foodbank.org.uk/feed/" });
    seedFoodbank({ id: 41, slug: "aberdeen-north", rssUrl: "https://aberdeennorth.foodbank.org.uk/feed/" });
  }

  it("returns every open food bank with a feed, as id/slug pairs in slug order", async () => {
    seedTheCountry();

    // toEqual on the whole array, not a length or a set of slugs: it pins the
    // ORDER BY, and it pins that the SELECT is still `id, slug` and nothing
    // else. The narrow projection is deliberate (the consumer re-fetches the
    // full row at dequeue time via getFoodbankForArticleCrawl), and widening
    // it would put ~80 columns x 470 food banks into a cron that needs two.
    expect(await getFoodbanksWithRss(session)).toEqual([
      { id: 41, slug: "aberdeen-north" },
      { id: 7, slug: "bath" },
      { id: 88, slug: "west-norfolk" },
      { id: WESTBURY, slug: "westbury" },
    ]);
  });

  // The ordering above is SQLite's BINARY collation: byte-wise, "-" (0x2D)
  // sorts before every letter, so "west-norfolk" precedes "westbury".
  //
  // types.ts:28-37 warns that a raw `ORDER BY` on this engine reorders lists
  // the source Postgres sorted under en_US.utf8, and offers sortByName() as
  // the fix -- so the question this test answers is whether that warning
  // applies here. It does not, and both halves are run rather than assumed:
  // for the lowercase-ASCII slugs this column holds (they are slugify()
  // output, so there is no case or accent for the collations to disagree
  // about) a default en-US collator agrees with the database exactly. The
  // only way to get a different answer is to ask a collator to ignore
  // punctuation, which reorders this pair -- and that is the mutant this test
  // kills: moving the enqueue order into JS "for consistency with the rest of
  // the site" would silently change it. Nothing user-facing reads this list;
  // a stable, deterministic order is all it owes anyone (PLAN.md §8.5.2).
  it("orders byte-wise, which for slugs matches a locale collator but not a punctuation-blind one", async () => {
    seedTheCountry();
    const slugs = (await getFoodbanksWithRss(session)).map((row) => row.slug);

    expect(slugs.indexOf("west-norfolk")).toBeLessThan(slugs.indexOf("westbury"));
    expect([...slugs].sort(new Intl.Collator("en-US").compare)).toEqual(slugs);
    expect([...slugs].sort(new Intl.Collator("en-US", { ignorePunctuation: true }).compare)).not.toEqual(slugs);
  });

  // getarticles.py:21's own filter, `rss_url__isnull=False`. A food bank with
  // no feed has nothing to crawl; without this predicate the cron would
  // enqueue every food bank in the country, and each of the several hundred
  // feedless messages would open a CrawlItem, fetch nothing and close it
  // again.
  it("excludes a food bank with no feed at all", async () => {
    seedFoodbank({ id: 50, slug: "carlisle", rssUrl: null });
    seedFoodbank({ id: 51, slug: "chester", rssUrl: "https://chester.foodbank.org.uk/feed/" });

    expect(await getFoodbanksWithRss(session)).toEqual([{ id: 51, slug: "chester" }]);
  });

  // WHY THE TEST ABOVE CANNOT TELL YOU WHICH PREDICATE DID THE WORK, run
  // rather than reasoned about. Deleting `rss_url IS NOT NULL` from the query
  // changes nothing: under SQLite's three-valued logic `NULL != ''` is NULL,
  // not true, and a WHERE clause keeps a row only when its expression is TRUE
  // -- so `rss_url != ''` already drops the feedless rows on its own. The
  // IS NOT NULL is belt-and-braces, and it is worth knowing that it is,
  // because the asymmetry is the trap: the redundant half is the one that
  // reads like the important one, and deleting the OTHER half (thinking the
  // NULL check covers it) silently starts enqueueing every food bank whose
  // feed URL is an empty string. That direction is caught, by the blank-string
  // test below. This is the same NULL semantics that locationsAdmin.ts's
  // `id IS NOT ?` exists for, seen from the other side.
  it("drops a NULL feed URL under `!= ''` alone, which is what makes the IS NOT NULL redundant", () => {
    seedFoodbank({ id: 50, slug: "carlisle", rssUrl: null });

    expect(db.prepare("SELECT id FROM foodbank WHERE rss_url != ''").all()).toEqual([]);
    expect(db.prepare("SELECT (rss_url != '') AS cmp FROM foodbank WHERE id = 50").get()).toEqual({ cmp: null });
  });

  // DIVERGENCE FROM DJANGO, and the reason it is right. Django filtered on
  // `rss_url__isnull=False` alone, and Foodbank.rss_url is a
  // URLField(null=True, blank=True) whose admin form stores an emptied box as
  // "" rather than NULL -- so Django's own queryset enqueued those rows and
  // handed "" to feedparser. `rss_url != ''` is this port's addition. If it
  // were ever dropped, nothing here would throw: the consumer would call
  // fetch(""), and log one fetch failure per feedless food bank per night.
  it("excludes a food bank whose feed URL was emptied to a blank string", async () => {
    seedFoodbank({ id: 51, slug: "chester", rssUrl: "" });
    seedFoodbank({ id: 52, slug: "dover", rssUrl: "https://dover.foodbank.org.uk/feed/" });

    expect(await getFoodbanksWithRss(session)).toEqual([{ id: 52, slug: "dover" }]);
  });

  // The `!= ''` test is byte equality, not a trim, so a feed URL of a single
  // space survives it. Pinned as a hazard rather than endorsed: the consumer
  // would call fetch(" "), which throws inside its own try/catch and is logged
  // as a fetch failure (queues/articles.ts:82-86), so the cost is one noisy log
  // line a day rather than anything worse. Anyone tightening this should tighten
  // the admin form that let a space be saved, not this query.
  it("keeps a whitespace-only feed URL, because the filter is byte equality", async () => {
    seedFoodbank({ id: 53, slug: "epsom", rssUrl: " " });

    expect(await getFoodbanksWithRss(session)).toEqual([{ id: 53, slug: "epsom" }]);
  });

  // A SECOND DIVERGENCE FROM DJANGO, in the other direction: getarticles.py:21
  // has no is_closed filter, so Django crawled closed food banks' feeds every
  // night. This port skips them, matching needcheck's cron
  // (needcheck.ts:26's `WHERE is_closed = 0`) rather than getarticles'.
  // Nothing on the site shows a closed food bank's articles, so the rows would
  // be write-only.
  //
  // This is also the filter most likely to be lost in a rewrite, and losing it
  // is silent: the crawl still works, it just quietly resumes writing articles
  // for food banks that shut down.
  it("excludes a closed food bank even when it still has a feed", async () => {
    seedFoodbank({ id: 54, slug: "frome", rssUrl: "https://frome.foodbank.org.uk/feed/", isClosed: 1 });
    seedFoodbank({ id: 55, slug: "gosport", rssUrl: "https://gosport.foodbank.org.uk/feed/" });

    expect(await getFoodbanksWithRss(session)).toEqual([{ id: 55, slug: "gosport" }]);
  });

  // THE FILTERS ARE rss_url AND is_closed, AND NOTHING ELSE -- and the four
  // tests above cannot tell you that, which is why this one exists.
  //
  // Every row seedFoodbank() writes leaves the rest of the table's ~70 columns
  // at NULL or 0: no network, no last_crawl, is_school NULL, latest_need_id
  // NULL. So an ADDED predicate on any of them passes all four. Both of these
  // survived the mutation sweep before this test was written:
  //
  //   ... AND last_crawl IS NULL ...   (a "skip the ones we crawled recently"
  //                                     throttle -- the plausible one, because
  //                                     adminDashboardStats.ts:59-62 already
  //                                     reads a sibling last_* column exactly
  //                                     that way, so it is a copy-paste away)
  //   ... AND network IS NULL ...      (the same shape on any other column)
  //
  // Neither throws, neither logs, and in production the first would enqueue
  // the ~470 feed-carrying food banks on night one and then nothing ever
  // again -- last_crawl is stamped at the end of every message, so the query
  // would empty itself out. The article crawl would simply stop, with a green
  // CrawlSet of expected 0 every night to say so.
  //
  // So: three food banks that qualify, differing in every column the query is
  // NOT allowed to care about, including one crawled a minute ago and one
  // crawled a year ago. All three come back.
  it("filters on the feed URL and is_closed only, not on last_crawl or anything else", async () => {
    seedFoodbank({ id: 60, slug: "hereford", rssUrl: "https://hereford.foodbank.org.uk/feed/", lastCrawl: null });
    seedFoodbank({ id: 61, slug: "ipswich", rssUrl: "https://ipswich.foodbank.org.uk/feed/", lastCrawl: "2026-09-05 03:11:52.004000" });
    seedFoodbank({ id: 62, slug: "jarrow", rssUrl: "https://jarrow.foodbank.org.uk/feed/", lastCrawl: "2025-09-05 03:09:41.882000" });
    // The other columns a stray predicate might reach for, given values rather
    // than left at the fixture's NULLs so that `IS NULL`/`= 0` cannot match
    // them all by accident.
    db.exec(`
      UPDATE foodbank SET network = 'Trussell', is_school = 1, no_locations = 3, latest_need_id = 4001 WHERE id = 61;
      UPDATE foodbank SET network = 'IFAN', is_school = 0, no_locations = 12, latest_need_id = 4002, edited = '2026-08-30 11:02:14.000000' WHERE id = 62;
    `);

    expect(await getFoodbanksWithRss(session)).toEqual([
      { id: 60, slug: "hereford" },
      { id: 61, slug: "ipswich" },
      { id: 62, slug: "jarrow" },
    ]);
  });

  // ONE ROW PER FOOD BANK, HOWEVER MANY ARTICLES IT ALREADY HAS. The query
  // reads `foodbank` alone, and this is the test that keeps it that way: a
  // LEFT JOIN onto foodbankarticle -- added by anyone wanting "how many
  // articles does it have" in the same statement -- survived the mutation
  // sweep, because the tests above seed no articles at all and a join with no
  // child rows is invisible.
  //
  // In production it is anything but. foodbankarticle holds 17,196 rows, so a
  // LEFT JOIN would fan each food bank out to one enqueue message per stored
  // article: Salisbury alone would be crawled dozens of times in one night,
  // the CrawlSet's `expected` would be tens of thousands, and every one of
  // those messages would re-fetch the feed. Nothing would error -- it would
  // just cost.
  //
  // The childless food bank is here for the other direction: an INNER JOIN
  // (or the LEFT JOIN written the wrong way round) drops exactly the food
  // banks that have never had an article, which are the ones a first crawl
  // matters most for.
  it("returns one row per food bank whether it has many stored articles or none", async () => {
    seedFoodbank({ id: 63, slug: "kendal", rssUrl: "https://kendal.foodbank.org.uk/feed/" });
    seedFoodbank({ id: 64, slug: "louth", rssUrl: "https://louth.foodbank.org.uk/feed/" });
    seedArticle({ id: 910, foodbankId: 63, publishedDate: "2026-08-11 10:00:00.000000", title: "One", url: "https://k/1" });
    seedArticle({ id: 911, foodbankId: 63, publishedDate: "2026-08-12 10:00:00.000000", title: "Two", url: "https://k/2" });
    // Louth has never had an article -- the childless parent.

    expect(await getFoodbanksWithRss(session)).toEqual([
      { id: 63, slug: "kendal" },
      { id: 64, slug: "louth" },
    ]);
  });

  // THE WHOLE POPULATION, NOT A PAGE OF IT. There is no LIMIT in this query
  // and there must not be one: scheduled/index.ts:191-193 turns the length of
  // this array into the CrawlSet's `expected`, so a cap would not look like a
  // truncation, it would look like a smaller country. Every food bank past the
  // cap simply stops being crawled, the CrawlSet closes complete, and the only
  // symptom is that the newest article on some food bank's page is from the
  // day the LIMIT landed.
  //
  // The four-row fixtures above cannot see this: `LIMIT 2` dies there, but
  // `LIMIT 100` -- the number already on screen in this file's neighbour,
  // enqueueChunked's BATCH_SIZE -- survived the mutation sweep untouched. 250
  // rows is chosen to sit past any plausible cap while staying well under
  // production's ~470 feed-carrying food banks, and it crosses that
  // BATCH_SIZE=100 chunk boundary twice, which is the number most likely to be
  // copied into this statement by mistake.
  //
  // The slugs are zero-padded so byte order and numeric order agree, which
  // makes "the last one is still here" a real assertion about the tail of the
  // ORDER BY rather than about whichever row happened to come back last.
  it("returns every qualifying food bank, with no implicit page size", async () => {
    for (let n = 0; n < 250; n++) {
      const slug = `fb-${String(n).padStart(3, "0")}`;
      seedFoodbank({ id: 1000 + n, slug, rssUrl: `https://${slug}.example.org/feed/` });
    }
    // Two that must not be counted, so "returns 250" cannot be satisfied by a
    // query that returns everything.
    seedFoodbank({ id: 2001, slug: "fb-900-closed", rssUrl: "https://closed.example.org/feed/", isClosed: 1 });
    seedFoodbank({ id: 2002, slug: "fb-901-feedless", rssUrl: null });

    const rows = await getFoodbanksWithRss(session);

    expect(rows).toHaveLength(250);
    expect(rows[0]).toEqual({ id: 1000, slug: "fb-000" });
    expect(rows[249]).toEqual({ id: 1249, slug: "fb-249" });
    expect(rows.map((row) => row.slug)).toEqual([...rows.map((row) => row.slug)].sort());
  });

  // scheduled/index.ts:192-197 reads `.length` for the CrawlSet's expected
  // count and hands the array straight to enqueueChunked. An undefined here
  // would take the whole articles cron down with a TypeError rather than
  // recording an empty run.
  it("returns an empty array, not null, when nothing qualifies", async () => {
    seedFoodbank({ id: 50, slug: "carlisle", rssUrl: null });

    expect(await getFoodbanksWithRss(session)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getFoodbankForArticleCrawl -- the consumer's re-fetch at dequeue time
// ---------------------------------------------------------------------------

describe("getFoodbankForArticleCrawl", () => {
  beforeEach(() => {
    seedFoodbank({ id: 7, slug: "bath", name: "Bath", rssUrl: "https://bath.foodbank.org.uk/feed/" });
    seedFoodbank({ id: SALISBURY, slug: "salisbury", name: "Salisbury", rssUrl: "https://salisbury.foodbank.org.uk/feed/" });
    seedFoodbank({ id: 88, slug: "west-norfolk", name: "West Norfolk", rssUrl: "https://westnorfolk.foodbank.org.uk/feed/" });
  });

  // Deep equality again, and for the same two reasons: it pins the projection
  // (four columns, all four of which the consumer uses -- rss_url to fetch and
  // to stamp the CrawlItem's url, slug for the cache purge tag, name for logs)
  // and it pins that the id predicate actually binds. Asked for the middle
  // row of three, a statement that had lost its WHERE would answer with Bath.
  it("returns exactly the four columns the consumer needs, for the id asked for", async () => {
    expect(await getFoodbankForArticleCrawl(session, SALISBURY)).toEqual({
      id: SALISBURY,
      slug: "salisbury",
      name: "Salisbury",
      rss_url: "https://salisbury.foodbank.org.uk/feed/",
    });
  });

  // The window this re-fetch exists to cover (crawlers.py:579-590's pattern):
  // a food bank deleted between enqueue and dequeue. `.first()` must answer
  // null rather than undefined, because queues/articles.ts:50 tests `!foodbank`
  // to throw its "no longer exists" error, and the DLQ consumer depends on
  // that throw to decrement the CrawlSet.
  it("returns null for a food bank deleted since the message was enqueued", async () => {
    expect(await getFoodbankForArticleCrawl(session, 999)).toBeNull();
  });

  // SUSPECT, PINNED AS-IS. ArticleCrawlFoodbankRow declares `rss_url: string`,
  // but the column is nullable and this query has no `rss_url IS NOT NULL`
  // guard -- the cron's filter is not repeated here. An admin clearing the
  // feed URL between enqueue and dequeue therefore hands the consumer a row
  // whose rss_url is null while TypeScript believes it is a string:
  // insertCrawlItem stores url NULL and fetch(null) requests the string
  // "null" (caught and logged by the consumer's own try/catch, so it is a
  // noisy no-op rather than a crash). Asserting the null is what makes the
  // type's claim visibly false; do not "fix" it by widening the interface
  // without deciding what the consumer should do with it.
  it("returns a row whose rss_url has since been cleared, despite the row type saying string", async () => {
    db.prepare("UPDATE foodbank SET rss_url = NULL WHERE id = ?").run(SALISBURY);

    const row = await getFoodbankForArticleCrawl(session, SALISBURY);
    expect(row).not.toBeNull();
    expect(row?.rss_url).toBeNull();
  });

  // The other half of that missing filter, and the deliberate one: unlike the
  // cron above, this lookup has no is_closed predicate, so a food bank closed
  // during the enqueue-to-dequeue window is still crawled once. That matches
  // Django, which never filtered on is_closed here at all, and it keeps the
  // consumer's failure mode to "one more crawl than necessary" rather than a
  // thrown "no longer exists" that would retry three times and then land in
  // the DLQ for a food bank that is merely closed.
  it("still returns a food bank closed since the message was enqueued", async () => {
    db.prepare("UPDATE foodbank SET is_closed = 1 WHERE id = ?").run(SALISBURY);

    expect(await getFoodbankForArticleCrawl(session, SALISBURY)).toMatchObject({ id: SALISBURY, slug: "salisbury" });
  });
});

// ---------------------------------------------------------------------------
// insertArticleIfNew -- the dedup insert
// ---------------------------------------------------------------------------

// A real feed item shape: title and URL from a food bank's WordPress feed,
// published_date already through pyDatetime() at the call site
// (queues/articles.ts:75), which is what makes the stored spelling match the
// 17,196 ETL rows.
const ITEM = {
  foodbankId: SALISBURY,
  title: "Harvest collections at St Thomas's this Sunday",
  url: "https://salisbury.foodbank.org.uk/2026/09/02/harvest-collections/",
  publishedDate: "2026-09-02 09:30:00.000000",
};

function storedArticles(): Array<Record<string, unknown>> {
  return db.prepare("SELECT id, foodbank_id, published_date, title, url, featured FROM foodbankarticle ORDER BY id").all() as Array<
    Record<string, unknown>
  >;
}

describe("insertArticleIfNew", () => {
  beforeEach(() => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", name: "Salisbury", rssUrl: "https://salisbury.foodbank.org.uk/feed/" });
    seedFoodbank({ id: 7, slug: "bath", name: "Bath", rssUrl: "https://bath.foodbank.org.uk/feed/" });
  });

  // Each of the four bound values is a different shape, so a swapped ?n --
  // a URL written into title, a timestamp into url -- fails here rather than
  // appearing as a mangled headline on the /news/ page. featured is asserted
  // too: it is a hard 0 in the VALUES tuple, and 0003_homepage_data.sql:51
  // declares the column NOT NULL with no DB default behind it -- so a tidy-up
  // that dropped the column and its literal from the statement together would
  // violate NOT NULL on every insert, and the OR IGNORE below would swallow
  // every one of them. The article crawl would store nothing, report nothing,
  // and log nothing.
  it("writes the row and reports that it created one", async () => {
    expect(await insertArticleIfNew(session, ITEM)).toBe(true);

    expect(storedArticles()).toEqual([
      {
        id: 1,
        foodbank_id: SALISBURY,
        published_date: ITEM.publishedDate,
        title: ITEM.title,
        url: ITEM.url,
        featured: 0,
      },
    ]);
  });

  // A crawled article is never featured. The homepage's article block is
  // `WHERE a.featured = 1` (homepage.ts:92) behind article_published_idx's
  // own `WHERE featured = 1` partial index, so featuring is an admin act
  // (adminLists.ts:330's toggle) and this literal is what keeps 17,000
  // crawled articles off the front page.
  it("leaves the article unfeatured, so the crawl cannot push anything onto the homepage", async () => {
    await insertArticleIfNew(session, ITEM);

    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbankarticle WHERE featured = 1").get()).toEqual({ n: 0 });
  });

  // THE WHOLE POINT OF THE FUNCTION, and the thing that makes a Cloudflare
  // Queues redelivery harmless. Every cron run re-reads the same feed, so this
  // is the common path, not an edge: ~470 feeds a night, nearly all of whose
  // items are already stored. The `false` is not cosmetic -- it is what keeps
  // foundNew false, which is what stops the consumer sending a cache purge for
  // every food bank every night (queues/articles.ts:90).
  it("ignores a URL already stored and reports that nothing was created", async () => {
    expect(await insertArticleIfNew(session, ITEM)).toBe(true);
    expect(await insertArticleIfNew(session, ITEM)).toBe(false);

    expect(storedArticles()).toHaveLength(1);
  });

  // Django's crawlers.py:44-49 looked the URL up and skipped the create if it
  // found one, so the first crawl's title is the one that sticks there too.
  // Same here, for a different reason: `OR IGNORE` is not an upsert. A feed
  // that fixes a typo in a headline, or a WordPress plugin that starts
  // appending the site name, never updates the stored row.
  it("does not update the stored row when the same URL comes back with a different title", async () => {
    await insertArticleIfNew(session, ITEM);

    expect(await insertArticleIfNew(session, { ...ITEM, title: "Harvest collections at St Thomas's -- Salisbury Foodbank" })).toBe(false);
    expect(storedArticles()[0]).toMatchObject({ title: ITEM.title });
  });

  // article_url_uniq is UNIQUE(url) -- the URL alone, NOT (foodbank_id, url),
  // whatever 0010_article_url_unique.sql's own comment says about
  // "foodbank_id/url". So a syndicated post that appears in two food banks'
  // feeds (a Trussell network announcement, a shared county newsletter) is
  // stored once, attached to whichever food bank's message happened to reach
  // it first -- and with the consumers running concurrently, which one that is
  // is not decided by the cron's slug ordering. The second food bank never
  // shows the article at all.
  //
  // This matches Django exactly (crawlers.py:44's filter is on url alone), so
  // it is parity rather than a defect, and it is asserted here because the
  // obvious "improvement" -- making the index (foodbank_id, url) so both food
  // banks keep a copy -- would change what the second food bank's page shows
  // and needs to be a decision, not a migration nobody noticed.
  it("dedups on the URL alone, so a syndicated article stays with the first food bank to crawl it", async () => {
    expect(await insertArticleIfNew(session, ITEM)).toBe(true);
    expect(await insertArticleIfNew(session, { ...ITEM, foodbankId: 7 })).toBe(false);

    expect(storedArticles()).toEqual([expect.objectContaining({ foodbank_id: SALISBURY })]);
  });

  // The dedup is byte-exact, because a UNIQUE index is. Two URLs that a person
  // would call the same article -- a trailing slash, a tracking parameter a
  // feed plugin started appending -- are two rows. Pinned as the known cost of
  // "url is UNIQUE, dedup is the DB's job" (PLAN.md §8.6): the alternative is
  // normalising URLs before insert, which nobody has decided to do.
  it("treats a trailing slash or an added query parameter as a different article", async () => {
    await insertArticleIfNew(session, ITEM);

    expect(await insertArticleIfNew(session, { ...ITEM, url: ITEM.url.slice(0, -1) })).toBe(true);
    expect(await insertArticleIfNew(session, { ...ITEM, url: `${ITEM.url}?utm_source=rss` })).toBe(true);
    expect(storedArticles()).toHaveLength(3);
  });

  // One food bank's feed is many articles: nothing about the insert is scoped
  // per food bank per day, so a first crawl of a feed with 20 items writes 20
  // rows and reports true 20 times.
  it("stores every distinct article from the same feed", async () => {
    for (const n of [1, 2, 3]) {
      expect(await insertArticleIfNew(session, { ...ITEM, url: `${ITEM.url}${n}/`, title: `Update ${n}` })).toBe(true);
    }

    expect(storedArticles()).toHaveLength(3);
  });

  // WHAT `OR IGNORE` ALSO SWALLOWS, pinned because it is the silent-failure
  // shape of this statement. IGNORE skips a row on ANY constraint violation,
  // not just the UNIQUE one it was added for -- a NOT NULL title or
  // published_date is dropped just as quietly, with no throw, no log, and a
  // `false` that the consumer reads as "already had it".
  //
  // Unreachable from today's caller: parseFeed drops item-less and dateless
  // items, and pyDatetime(undefined) would throw before D1 was reached. It is
  // asserted anyway because the next caller of this function is the one that
  // needs to know, and because a future migration adding a NOT NULL column
  // without a default would turn the entire article crawl into a no-op that
  // reports success. If that ever happens, this is the test that says why.
  it("silently stores nothing when a NOT NULL column is violated, because OR IGNORE swallows that too", async () => {
    const dateless = { ...ITEM, publishedDate: null as unknown as string };

    await expect(insertArticleIfNew(session, dateless)).resolves.toBe(false);
    expect(storedArticles()).toHaveLength(0);
  });

  // The row has to be reachable through 0019's view, not just present in the
  // base table, because that is where the read path looks. homepage.ts:85
  // goes further and uses an INNER JOIN to foodbank, so an article written
  // with a foodbank_id no parent matches would not merely lose its name --
  // it would vanish from /news/ entirely while sitting in the table looking
  // fine. D1 has no foreign keys (PLAN.md §4.5), so nothing but this bind
  // stops that.
  it("writes a row that joins to its parent through foodbankarticle_full", async () => {
    await insertArticleIfNew(session, ITEM);

    expect(db.prepare("SELECT foodbank_name, foodbank_slug, title FROM foodbankarticle_full WHERE url = ?").get(ITEM.url)).toEqual({
      foodbank_name: "Salisbury",
      foodbank_slug: "salisbury",
      title: ITEM.title,
    });
  });

  // TICKET #9, WHICH THIS COLUMN ALREADY COST ONCE. published_date is TEXT and
  // every reader orders on it lexicographically (foodbankTabs.ts:105,
  // homepage.ts:92, needAdminExtras.ts:148). This function stores exactly the
  // string it is handed -- no parsing, no normalising -- so the correctness
  // lives entirely at the call site, which is why queues/articles.ts:75 spells
  // it pyDatetime(...) and says so in a comment.
  //
  // The first half proves a pyDatetime row sorts correctly against ETL rows
  // either side of it. The second half is the regression itself: an earlier
  // version of the crawler wrote toISOString(), and " " (0x20) sorts before
  // "T" (0x54), so a 09:30 ISO-spelled row jumps ahead of a 22:00 Django-format
  // row from the same day -- 12 hours out of order, on a page nobody would
  // think to check. 0022_normalise_timestamps.sql had to go back and repair
  // nine of these rows. Executed rather than reasoned about, per TESTING.md.
  it("stores the timestamp verbatim, in the spelling the ORDER BY on this column depends on", async () => {
    seedArticle({ id: 900, foodbankId: SALISBURY, publishedDate: "2026-09-01 08:12:44.523000", title: "Older", url: "https://s/1" });
    seedArticle({ id: 901, foodbankId: SALISBURY, publishedDate: "2026-09-02 22:00:00.000000", title: "Evening", url: "https://s/2" });
    seedArticle({ id: 902, foodbankId: SALISBURY, publishedDate: "2026-09-03 06:00:00.000000", title: "Newest", url: "https://s/3" });

    const morning = new Date(Date.UTC(2026, 8, 2, 9, 30, 0));
    expect(pyDatetime(morning)).toBe(ITEM.publishedDate); // the exact string ITEM carries
    await insertArticleIfNew(session, { ...ITEM, title: "Morning" });

    const inOrder = () =>
      (db.prepare("SELECT title FROM foodbankarticle WHERE foodbank_id = ? ORDER BY published_date DESC").all(SALISBURY) as Array<{
        title: string;
      }>).map((row) => row.title);

    expect(inOrder()).toEqual(["Newest", "Evening", "Morning", "Older"]);

    // Same instant, wrong spelling, one row later in the day overtaken.
    await insertArticleIfNew(session, { ...ITEM, url: `${ITEM.url}iso/`, title: "Morning, ISO-spelled", publishedDate: morning.toISOString() });
    expect(inOrder()).toEqual(["Newest", "Morning, ISO-spelled", "Evening", "Morning", "Older"]);
  });
});

// ---------------------------------------------------------------------------
// updateFoodbankLastCrawl -- the unconditional stamp at the end of a crawl
// ---------------------------------------------------------------------------

describe("updateFoodbankLastCrawl", () => {
  const STAMP = "2026-09-05 03:14:07.891000";

  beforeEach(() => {
    seedFoodbank({ id: SALISBURY, slug: "salisbury", rssUrl: "https://salisbury.foodbank.org.uk/feed/", lastCrawl: "2026-09-04 03:11:52.004000" });
    seedFoodbank({ id: 7, slug: "bath", rssUrl: "https://bath.foodbank.org.uk/feed/", lastCrawl: "2026-09-04 03:11:19.771000" });
  });

  function lastCrawlOf(id: number): string | null {
    return (db.prepare("SELECT last_crawl FROM foodbank WHERE id = ?").get(id) as { last_crawl: string | null }).last_crawl;
  }

  // crawlers.py:58 stamps last_crawl whether or not anything new was found, so
  // the column means "when we last looked", not "when we last found". The
  // WHERE clause is the assertion that matters: an UPDATE that lost it would
  // stamp all 1,071 food banks on every message, 470 times a night, and
  // nothing would report an error.
  it("stamps the food bank asked for and leaves its neighbours alone", async () => {
    await updateFoodbankLastCrawl(session, SALISBURY, STAMP);

    expect(lastCrawlOf(SALISBURY)).toBe(STAMP);
    expect(lastCrawlOf(7)).toBe("2026-09-04 03:11:19.771000");
  });

  // Verbatim, like published_date above: last_crawl is TEXT shared with the
  // 470 rows 0022_normalise_timestamps.sql had to repair, and this function
  // neither parses nor reformats what it is given. What it stores must
  // therefore compare correctly against a Django-format value already in the
  // column -- which is a property of the caller's pyNow(), asserted here
  // because this is the statement that would make a regression permanent.
  it("stores the string it is given, and pyNow()'s spelling compares correctly against the ETL's", async () => {
    await updateFoodbankLastCrawl(session, SALISBURY, STAMP);

    expect(lastCrawlOf(SALISBURY)).toBe(STAMP);
    expect(STAMP).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
    expect(pyDatetime(new Date(Date.UTC(2026, 8, 5, 3, 14, 7, 891)))).toBe(STAMP);
    // Later than yesterday's stamp, under the byte comparison this column is
    // read with.
    expect(db.prepare("SELECT last_crawl > ? AS newer FROM foodbank WHERE id = ?").get("2026-09-04 03:11:52.004000", SALISBURY)).toEqual({
      newer: 1,
    });
    // And the spelling that would break it, executed rather than described:
    // an ISO "2026-09-05T03:00:00.000Z" is fourteen minutes EARLIER than the
    // stamp above and still compares greater, because the two spellings only
    // diverge at position 10, where "T" (0x54) outranks " " (0x20). Within a
    // single day that is a silent reordering; it is what 0022_normalise
    // _timestamps.sql had to go back and repair across this column's 470 rows.
    expect(db.prepare("SELECT ? > ? AS wrongly_newer").get("2026-09-05T03:00:00.000Z", STAMP)).toEqual({ wrongly_newer: 1 });
  });

  // DIVERGENCE FROM DJANGO, pinned rather than fixed. Django reached this
  // column through foodbank.save(), and Foodbank is a TimestampedModel
  // (models/base.py:12-16) whose `modified` is auto_now=True -- so every
  // nightly crawl bumped `modified` on every food bank with a feed. This
  // UPDATE touches one column. The visible consequence is frag.ts:15-17's
  // "last-updated", which is MAX(modified) over foodbank and therefore now
  // advances only on a real edit rather than every night at 03:00.
  //
  // The whole port is consistent about this -- needcheck.ts:199 and
  // needAdmin.ts:195 stamp their columns the same narrow way, and orderWrite
  // .ts:364 is the one place that deliberately writes `modified` alongside --
  // so this reads as a decision rather than an oversight, and the test exists
  // so that the next person to compare "last updated" against production
  // finds the answer here instead of re-deriving it.
  it("does not bump modified, though Django's save() did", async () => {
    const before = db.prepare("SELECT modified, edited, created FROM foodbank WHERE id = ?").get(SALISBURY);

    await updateFoodbankLastCrawl(session, SALISBURY, STAMP);

    expect(db.prepare("SELECT modified, edited, created FROM foodbank WHERE id = ?").get(SALISBURY)).toEqual(before);
  });

  // The silent no-op. queues/articles.ts:89 ignores the result, so a stamp for
  // a food bank deleted mid-crawl updates nothing, throws nothing and is
  // reported nowhere -- worth knowing when last_crawl "stops advancing" for a
  // food bank rather than assuming the cron never ran.
  it("is a silent no-op for a food bank that no longer exists", async () => {
    await expect(updateFoodbankLastCrawl(session, 999, STAMP)).resolves.toBeUndefined();

    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbank WHERE last_crawl = ?").get(STAMP)).toEqual({ n: 0 });
  });

  // Closed food banks are excluded by the cron, not by this write, so a crawl
  // already in flight when a food bank closes still stamps it. Same reasoning
  // as getFoodbankForArticleCrawl's own missing filter: the consumer finishes
  // the message it was given.
  it("stamps a closed food bank if a message for it is still in flight", async () => {
    db.prepare("UPDATE foodbank SET is_closed = 1 WHERE id = ?").run(SALISBURY);

    await updateFoodbankLastCrawl(session, SALISBURY, STAMP);

    expect(lastCrawlOf(SALISBURY)).toBe(STAMP);
  });
});
