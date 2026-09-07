// @ts-ignore -- node:sqlite has no types under this package's tsconfig, whose
// `"types": ["@cloudflare/workers-types"]` deliberately excludes @types/node
// (adminLists.test.ts's header explains the same constraint, and why this is
// `@ts-ignore` rather than `@ts-expect-error`: if someone later adds
// @types/node to this package, an expect-error directive would itself become
// the error and break `pnpm typecheck` for everyone).
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getArticlesByFoodbankId,
  getFeaturedArticles,
  getMostViewed,
  getMostViewedByCountry,
  getRecentArticles,
  getRecentlyUpdated,
  getRecentlyUpdatedByCountry,
  getSiteStats,
} from "./homepage";
import type { Session } from "./types";

// homepage.ts is eight functions and nothing but SQL. It backs the root page
// (givefood/views.py index()), the four country pages (country()), /news/,
// the RSS feeds, the per-food-bank news pages and the articles dashboard --
// every one of which renders happily against wrong rows. There is no
// exception to catch: a dropped GROUP BY silently ranks by one day's hits
// instead of the week's, an INNER-for-LEFT swap silently loses articles, an
// `>=` turned `>` silently loses a day. Migration 0019 is this repo's own
// scar -- it dropped the cached `foodbank_name` columns, four queries kept
// naming them, and nothing went red until /dashboard/beautybanks/ was
// measured and found to be a silent 500.
//
// So this file runs the real statements against a real SQLite database built
// from packages/db/migrations, and asserts ROWS -- which slugs, in which
// order, with which values -- not shapes. A recording fake could not tell
// you any of it: an ORDER BY that sorts the wrong way, a SUM that became a
// MAX, a window boundary off by one day, a filter that was deleted -- none
// of those change the shape of anything.
//
// THE VIEW IS THE REAL VIEW. getRecentlyUpdated reads `foodbankchange_full`,
// so that view is created here verbatim from 0019_drop_foodbank_cache.sql:86
// -89. Substituting a hand-built table with `foodbank_name` already flattened
// in would make the test circular -- post-0019 the join direction IS what
// decides whether an unparented change appears, and it is the only thing that
// still produces that column at all.
//
// SIX MUTANTS SURVIVE THIS FILE AND CANNOT BE MADE TO DIE, recorded here so
// the next person to run a mutation pass does not spend an afternoon
// rediscovering them. Each was executed; each is equivalent, not uncovered.
//
//   * getSiteStats with `WHERE id = 1` DELETED. `site_stats` is declared
//     `id INTEGER PRIMARY KEY CHECK (id = 1)`, so a second row cannot exist
//     and the predicate can never select differently. Pointing it somewhere
//     else DOES die (`WHERE id = 2` fails two tests), so what is untestable
//     is the clause's presence, not its target.
//
//   * getRecentlyUpdated, getRecentlyUpdatedByCountry and getFeaturedArticles
//     with their `ORDER BY` DELETED. Each of those three filters on exactly
//     the column a partial index leads with -- `change_pub_created_idx` is
//     `(published, created DESC) WHERE published = 1`, `article_published_idx`
//     is `(published_date DESC) WHERE featured = 1` -- so the planner uses
//     that index to satisfy the WHERE and the rows arrive pre-sorted in the
//     very order the ORDER BY asks for. `EXPLAIN QUERY PLAN` confirms the
//     plan is identical with and without the clause. This is a property of
//     the schema, NOT slack in the fixtures: delete those two indexes from
//     SCHEMA above and all three mutants die immediately, which is the check
//     that proves the fixtures discriminate on order. The sibling queries
//     that no partial index covers -- getRecentArticles and
//     getArticlesByFoodbankId, neither of which filters on `featured` --
//     kill the same mutant with the indexes in place.
//
//   * getRecentlyUpdatedByCountry and getMostViewedByCountry with their
//     `JOIN` widened to `LEFT JOIN`. Both put a predicate on the joined table
//     in the WHERE (`f.name IS NOT NULL`, `f.country = ?`), and a
//     NULL-extended row fails either one under three-valued logic, so the
//     outer join is narrowed straight back to an inner one. getMostViewed's
//     join has no such predicate protecting it and DOES die -- which is the
//     asymmetry worth remembering: the same edit is harmless in two of these
//     statements and a bug in the third.
//
//   * Five rewrites that are the same statement said differently, listed so
//     nobody mistakes them for gaps: `a.foodbank_id = ?` written as
//     `f.id = ?`, and `GROUP BY h.foodbank_id` written as `GROUP BY f.id` --
//     the join equates those columns, so either side names the same value;
//     `published = 1` written as `published != 0`, where the column is
//     `INTEGER NOT NULL` holding a Django boolean and 0/1 is the whole
//     domain; `foodbank_name IS NOT NULL` written as
//     `foodbank_slug IS NOT NULL`, both produced by the same LEFT JOIN from
//     columns declared NOT NULL in `foodbank`, so they are null together or
//     not at all; and `.first()` written as `.all()` taking element zero.
//     Killing any of these would take a row the schema or the ETL cannot
//     produce, which pins a fiction rather than a behaviour.
//
// THE D1 100-PARAMETER LIMIT does not apply to this module: no function here
// builds a variable-length IN list or chunks its bindings. The three
// `change_text NOT IN (...)` sentinels are literals in the SQL text, not
// bindings, and the most any statement binds is four (getMostViewedByCountry's
// since/until/country/limit). If a future change turns the sentinel list into
// bound parameters, or adds an IN list over ids, it needs a test at 100 and
// 101.

// ---------------------------------------------------------------------------
// The schema, as it stands after every migration in packages/db/migrations.
// Column definitions are copied from the migrations, not inferred from the
// TypeScript interfaces -- catching a disagreement between the two is half
// the point of running real SQL. Post-0019 means `foodbankchange.foodbank_name`
// and `foodbankarticle.foodbank_name` are GONE; a query that still names one
// dies here with "no such column", which is precisely the 0019 regression.
//
// EVERY INDEX THE MIGRATIONS DECLARE ON THESE FOUR TABLES IS HERE, AND THAT
// IS LOAD-BEARING RATHER THAN TIDY. An index changes which rows the planner
// serves and in what order, so an incomplete index set gives these statements
// a plan they would never get in production -- and a test that passes under a
// fictional plan is evidence about nothing.
//
// Concretely, measured: with only `change_pub_created_idx` present (the two
// partial indexes were the ones an earlier draft of this file kept, on the
// reasoning that only partial indexes affect row *visibility*), DELETING THE
// `ORDER BY created DESC` FROM getRecentlyUpdated AND getRecentlyUpdatedByCountry
// CHANGED NOTHING AND EVERY TEST STILL PASSED. That index is
// `(published, created DESC) WHERE published = 1`, so a plan that used it for
// the `published = 1` filter handed the rows over already in created-DESC
// order and the sort was pure decoration. Restoring
// `change_published_foodbank_idx` -- `(published, foodbank_id)`, equally
// eligible for that same filter and cheaper without a sort to satisfy --
// makes the planner pick it the moment the ORDER BY goes, rows arrive in
// foodbank_id order instead, and the mutant dies. `EXPLAIN QUERY PLAN`
// confirms the swap. Deleting an index from this block is therefore deleting
// test coverage, silently, somewhere else in the file.
// ---------------------------------------------------------------------------
const SCHEMA = `
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
CREATE UNIQUE INDEX foodbank_name_uniq   ON foodbank(name);
CREATE UNIQUE INDEX foodbank_slug_uniq   ON foodbank(slug);
CREATE INDEX foodbank_uuid_idx           ON foodbank(uuid);
CREATE INDEX foodbank_parlcon_slug_idx   ON foodbank(parliamentary_constituency_slug);
CREATE INDEX foodbank_modified_idx       ON foodbank(modified);
CREATE INDEX foodbank_edited_idx         ON foodbank(edited);
CREATE INDEX foodbank_last_need_idx      ON foodbank(last_need);
CREATE INDEX foodbank_closed_edited_idx  ON foodbank(is_closed, edited DESC);
CREATE INDEX foodbank_open_latlng_idx    ON foodbank(latitude, longitude) WHERE is_closed = 0;

-- 0001_core.sql:110-127, less foodbank_name (0019)
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
CREATE UNIQUE INDEX need_need_id_uniq      ON foodbankchange(need_id);
CREATE INDEX change_foodbank_created_idx   ON foodbankchange(foodbank_id, created DESC);
CREATE INDEX change_published_foodbank_idx ON foodbankchange(published, foodbank_id);
CREATE INDEX change_pub_created_idx        ON foodbankchange(published, created DESC) WHERE published = 1;
CREATE INDEX change_uncategorised_idx      ON foodbankchange(is_categorised) WHERE is_categorised IS NULL;

-- 0003_homepage_data.sql:40-53, less foodbankarticle.foodbank_name (0019),
-- plus 0010_article_url_unique.sql:8
CREATE TABLE foodbankhit (
  foodbank_id INTEGER NOT NULL, day TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (foodbank_id, day)
) WITHOUT ROWID;
CREATE INDEX hit_day_foodbank_idx ON foodbankhit(day, foodbank_id, hits);

CREATE TABLE foodbankarticle (
  id INTEGER PRIMARY KEY,
  foodbank_id INTEGER,
  published_date TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
  featured INTEGER NOT NULL
);
CREATE INDEX article_published_idx ON foodbankarticle(published_date DESC) WHERE featured = 1;
CREATE UNIQUE INDEX article_url_uniq ON foodbankarticle(url);

-- 0003_homepage_data.sql:55-60. The CHECK is load-bearing -- see the
-- getSiteStats block below.
CREATE TABLE site_stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  foodbanks INTEGER NOT NULL, donationpoints INTEGER NOT NULL,
  items INTEGER NOT NULL, meals INTEGER NOT NULL,
  computed_at TEXT NOT NULL
);

-- 0019_drop_foodbank_cache.sql:86-89, verbatim. LEFT JOIN, not JOIN:
-- foodbankchange.foodbank_id is nullable (an unassigned need) and an inner
-- join would silently drop those rows.
CREATE VIEW foodbankchange_full AS
  SELECT c.*, f.name AS foodbank_name, f.slug AS foodbank_slug
    FROM foodbankchange c
    LEFT JOIN foodbank f ON f.id = c.foodbank_id;
`;

// ---------------------------------------------------------------------------
// The D1 Sessions API surface homepage.ts actually uses, over node:sqlite.
// Copied from adminLists.test.ts's d1Session, less the `meta.changes` it
// added for deleteSubscription -- nothing in this module writes.
// ---------------------------------------------------------------------------
type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
};

function d1Session(db: SqliteDb) {
  const statement = (sql: string, params: unknown[]) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
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

// A generic INSERT built from the object's own keys, so a seed helper names
// only the columns a test cares about and the NOT NULL filler lives in one
// place per table. Values are inlined as SQL literals rather than bound
// because the seeds are all test-authored constants.
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

let uuidCounter = 0;
const nextUuid = () => `${(uuidCounter += 1)}`.padStart(32, "0");

// EVERY TIMESTAMP FILLER IS DISTINCT, AND THAT IS THE POINT. These columns
// used to be seeded as one shared constant, which quietly disabled a whole
// class of test: `foodbankchange` carries `created`, `modified` AND
// `notified`, `foodbank` carries `created`, `modified` and `edited`, and
// picking the wrong one in an ORDER BY is the single most plausible careless
// edit these statements are exposed to. With every row holding the same
// `modified`, sorting by it is an all-ties no-op that leaves the rows in the
// order the index handed them over -- which is `created DESC` -- so the
// answer came out right by accident and the test passed.
//
// MEASURED: five mutants survived the suite before this changed --
// getRecentlyUpdated ordered by `modified` and by `notified`, and
// getRecentlyUpdatedByCountry ordered by `fc.modified`, by `f.created` and by
// `f.modified`. That last pair is the nastiest, because BOTH tables have a
// column called `created` and the statement has to qualify it; `f.created` is
// a one-character slip that reorders the country pages and raises no error.
// All five die now.
//
// The values run FORWARD with insertion order while the `created` values the
// ordering fixtures use run against it, so no two of these columns agree on a
// ranking and no sort can be right for the wrong reason.
let stampCounter = 0;
const nextStamp = () => {
  const n = (stampCounter += 1);
  return `2021-03-01 ${`${Math.floor(n / 60) % 24}`.padStart(2, "0")}:${`${n % 60}`.padStart(2, "0")}:00.000000`;
};

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
    created: nextStamp(),
    modified: nextStamp(),
    edited: nextStamp(),
    ...row,
  });
}

// `need_id` is UNIQUE (need_need_id_uniq), so every change needs its own --
// a shared filler would make the second seed in any test throw rather than
// fail an assertion, which is a much more confusing way to learn about it.
let needIdCounter = 0;
function seedChange(row: Record<string, unknown>): void {
  insert("foodbankchange", {
    need_id: `${(needIdCounter += 1)}`.padStart(32, "n"),
    change_text: "Beans, pasta, UHT milk",
    published: 1,
    input_method: "typed",
    modified: nextStamp(),
    notified: nextStamp(),
    ...row,
  });
}

// `url` is UNIQUE (article_url_uniq), same reasoning as need_id above.
let articleUrlCounter = 0;
function seedArticle(row: Record<string, unknown>): void {
  insert("foodbankarticle", {
    featured: 0,
    title: "Untitled",
    url: `https://news.example.org/${(articleUrlCounter += 1)}`,
    ...row,
  });
}

const seedHit = (foodbankId: number, day: string, hits: number) => insert("foodbankhit", { foodbank_id: foodbankId, day, hits });

// Django-format timestamps throughout: "YYYY-MM-DD HH:MM:SS.ffffff", the form
// 0022_normalise_timestamps.sql settled on and packages/models's pyNow()/
// pyDatetime() now write. These columns are TEXT and SQLite compares TEXT
// bytewise, so the format is load-bearing for every ORDER BY below. Wherever
// ordering matters, the values share a date and differ only in the time -- a
// comparison that only looked at the date prefix (needAdminExtras.ts does
// exactly that elsewhere, deliberately) would pass a date-only fixture.
const SALISBURY = 1;
const ABERDEEN = 2;
const CARDIFF = 3;
const BALLYMENA = 4;
const CLOSED_TOWN = 5;

function seedFiveFoodbanks(): void {
  seedFoodbank({ id: SALISBURY, name: "Salisbury", slug: "salisbury", country: "England" });
  seedFoodbank({ id: ABERDEEN, name: "Aberdeen", slug: "aberdeen", country: "Scotland" });
  seedFoodbank({ id: CARDIFF, name: "Cardiff", slug: "cardiff", country: "Wales" });
  seedFoodbank({ id: BALLYMENA, name: "Ballymena", slug: "ballymena", country: "Northern Ireland" });
  seedFoodbank({ id: CLOSED_TOWN, name: "Closed Town", slug: "closed-town", country: "England", is_closed: 1 });
}

// The window public.ts and country.ts build: `isoDate(today)` and
// `isoDate(today - 7 days)`, both 'YYYY-MM-DD'. Chosen to straddle a month
// boundary on purpose -- '2026-08-31' < '2026-09-07' only because the dates
// are zero-padded, and a comparison that got at the day number instead of the
// text would order 31 after 07.
const SINCE_DAY = "2026-08-31";
const UNTIL_DAY = "2026-09-07";

const names = (rows: Array<{ name: string }>) => rows.map((r) => r.name);
const slugs = (rows: Array<{ slug: string }>) => rows.map((r) => r.slug);

// ===========================================================================
// getSiteStats
// ===========================================================================
describe("getSiteStats", () => {
  const STATS = {
    id: 1,
    foodbanks: 1071,
    donationpoints: 5744,
    items: 1_234_567,
    // Deliberately over 2^31. `meals` is get_site_stats()'s sum of
    // Order.calories across every order ever placed; if anything in the
    // stack narrowed an INTEGER column to 32 bits this is where it would
    // show up, as a number that quietly wrapped instead of an error.
    meals: 4_100_000_000,
    computed_at: "2026-09-05 19:28:08.853000",
  };

  it("returns the single precomputed row, values verbatim", async () => {
    insert("site_stats", STATS);

    // Whole-object equality, not field-by-field: the extraction tool writes
    // this row and four separate templates read it, so a column landing in
    // the wrong property is a wrong number rendered on the homepage with no
    // error anywhere. `computed_at` comes back as the stored TEXT, not a
    // Date -- nothing in this layer parses it.
    expect(await getSiteStats(session)).toEqual({
      foodbanks: 1071,
      donationpoints: 5744,
      items: 1_234_567,
      meals: 4_100_000_000,
      computed_at: "2026-09-05 19:28:08.853000",
    });
  });

  // 0003_homepage_data.sql is explicit that this table is refreshed by
  // re-running tools/pg-to-d1/extract_core.py -- so on a database migrated
  // but not yet loaded, the table is empty. public.ts and textFiles.ts both
  // have to survive that, and they only do because this returns null rather
  // than throwing or handing back undefined.
  it("returns null when the extraction tool has not run yet", async () => {
    expect(await getSiteStats(session)).toBeNull();
  });

  // Named columns, not `SELECT *`. Two things depend on it: `id` never
  // reaches the template context, and a migration that renames one of the
  // five fails LOUDLY here ("no such column") instead of handing the
  // template `undefined` -- which is the 0019 failure mode this whole file
  // exists for.
  it("projects exactly the five stat columns, never SELECT *", async () => {
    insert("site_stats", STATS);

    expect(Object.keys((await getSiteStats(session))!)).toEqual(["foodbanks", "donationpoints", "items", "meals", "computed_at"]);
  });

  // Why `WHERE id = 1` can never be wrong, rather than merely happening to
  // be right today: the CHECK constraint makes a second row impossible, so
  // the predicate is belt-and-braces and there is no ordering question to
  // get wrong. Someone tempted to drop the WHERE (or to add a second
  // "previous stats" row) should see this fail first.
  //
  // MUTANT NOTE: deleting the WHERE clause outright survives this whole file,
  // necessarily -- with one storable row there is nothing for the predicate
  // to discriminate between. Repointing it (`WHERE id = 2`) fails "returns
  // the single precomputed row" and "projects exactly the five stat columns",
  // so the binding is pinned even though its presence cannot be. The test
  // below is the honest substitute: it pins the CHECK that makes the deletion
  // safe, so if someone relaxes the constraint to store history, this goes
  // red and the missing WHERE becomes a real bug at the same moment.
  it("cannot be fooled by a second row, because the schema forbids one", () => {
    insert("site_stats", STATS);
    expect(() => insert("site_stats", { ...STATS, id: 2 })).toThrow();
  });
});

// ===========================================================================
// getRecentlyUpdated -- index()'s `recently_updated`
// (givefood/views.py:160-167)
// ===========================================================================
describe("getRecentlyUpdated", () => {
  beforeEach(seedFiveFoodbanks);

  it("returns the most recent published changes, newest first, truncated to the limit", async () => {
    // Three of these share a date and differ in the time; two of those differ
    // only in the sixth fractional digit, which is the resolution Python's
    // str(datetime) writes. The seeds go in deliberately out of order so the
    // assertion is a claim about the ORDER BY and not about the order rows
    // happened to be written in.
    //
    // ONE MUTANT THIS CANNOT KILL, recorded so nobody wastes an afternoon
    // trying: `ORDER BY date(created) DESC`. It was run. With
    // change_pub_created_idx in place (0001_core.sql:123, `(published,
    // created DESC) WHERE published = 1`) the planner feeds the sort rows
    // that are ALREADY in created-DESC order, and the temp b-tree leaves ties
    // where it found them -- so truncating the sort key to the date still
    // produces the right answer, whatever the insertion order. It is not a
    // hazard for this query for the same reason. The mutants that do matter
    // -- a flipped DESC, ordering by id, a DISTINCT, a dropped LIMIT -- all
    // die here.
    seedChange({ foodbank_id: SALISBURY, created: "2026-09-05 19:28:08.853000" });
    seedChange({ foodbank_id: CARDIFF, created: "2026-09-05 08:00:00.000000" });
    seedChange({ foodbank_id: ABERDEEN, created: "2026-09-05 19:28:08.853001" });
    seedChange({ foodbank_id: BALLYMENA, created: "2026-09-04 23:59:59.999999" });

    expect((await getRecentlyUpdated(session, 8)).map((r) => r.foodbank_name)).toEqual(["Aberdeen", "Salisbury", "Cardiff", "Ballymena"]);
    // index() asks for 8; the LIMIT is bound, so it has to actually cut.
    expect((await getRecentlyUpdated(session, 2)).map((r) => r.foodbank_name)).toEqual(["Aberdeen", "Salisbury"]);
  });

  // Django's `.filter(published=True)`. An unpublished change is a need that
  // has been scraped but not yet checked by a human -- putting one on the
  // homepage publishes it, which is the one thing the admin queue exists to
  // prevent.
  it("excludes unpublished changes", async () => {
    seedChange({ foodbank_id: SALISBURY, published: 0, created: "2026-09-05 12:00:00.000000" });
    seedChange({ foodbank_id: ABERDEEN, published: 1, created: "2026-09-04 12:00:00.000000" });

    expect((await getRecentlyUpdated(session, 8)).map((r) => r.foodbank_name)).toEqual(["Aberdeen"]);
  });

  // Django's `.exclude(change_text__in=["Unknown", "Facebook", "Nothing"])`.
  // 0001_core.sql calls these three "contract": they are sentinels meaning
  // "the crawler could not read the page", "we only have a Facebook post" and
  // "the food bank says it needs nothing" -- none of which is an update worth
  // showing as one.
  it("excludes the three sentinel change_texts", async () => {
    seedChange({ foodbank_id: SALISBURY, change_text: "Unknown", created: "2026-09-05 12:00:00.000000" });
    seedChange({ foodbank_id: ABERDEEN, change_text: "Facebook", created: "2026-09-05 11:00:00.000000" });
    seedChange({ foodbank_id: CARDIFF, change_text: "Nothing", created: "2026-09-05 10:00:00.000000" });
    seedChange({ foodbank_id: BALLYMENA, change_text: "Beans", created: "2026-09-05 09:00:00.000000" });

    expect((await getRecentlyUpdated(session, 8)).map((r) => r.foodbank_name)).toEqual(["Ballymena"]);
  });

  // The exclusion is an exact-equality IN list, not a LIKE and not a
  // case-insensitive match. Both halves matter: a real need list beginning
  // "Nothing perishable please" must survive, and if anyone ever puts
  // COLLATE NOCASE on this column the lowercase row below would silently
  // start disappearing from the homepage. change_text is NOT NULL in the
  // schema, so the NULL arm of `NOT IN` (which yields NULL, i.e. excluded)
  // is unreachable and is not tested.
  it("matches the sentinels exactly -- not as substrings, not case-insensitively", async () => {
    seedChange({ foodbank_id: SALISBURY, change_text: "Nothing perishable please", created: "2026-09-05 12:00:00.000000" });
    seedChange({ foodbank_id: ABERDEEN, change_text: "nothing", created: "2026-09-05 11:00:00.000000" });
    seedChange({ foodbank_id: CARDIFF, change_text: "Nothing", created: "2026-09-05 10:00:00.000000" });

    expect((await getRecentlyUpdated(session, 8)).map((r) => r.foodbank_name)).toEqual(["Salisbury", "Aberdeen"]);
  });

  // POST-0019 SEMANTICS, and the reason this test is worth more than it
  // looks. `foodbank_name` used to be a denormalised column on
  // foodbankchange; 0019 dropped it and foodbankchange_full now derives it
  // from a LEFT JOIN. So `foodbank_name IS NOT NULL` no longer means "the
  // cached copy was filled in" -- it now means "this change has a parent food
  // bank row". Both an unassigned change (foodbank_id NULL, which the column
  // is explicitly nullable for) and a change pointing at a food bank that no
  // longer exists (D1 has no foreign keys, PLAN.md §4.5) fall out here.
  //
  // This is a DELIBERATE divergence from Django, which has no such filter and
  // would hand the template a None: public.ts does slugify(r.foodbank_name)
  // on every row it gets back, so a null would become a broken link with a
  // food bank's name missing from the homepage.
  it("excludes changes with no parent food bank, and changes whose parent is gone", async () => {
    seedChange({ foodbank_id: null, created: "2026-09-05 12:00:00.000000" });
    seedChange({ foodbank_id: 9999, created: "2026-09-05 11:00:00.000000" });
    seedChange({ foodbank_id: SALISBURY, created: "2026-09-05 10:00:00.000000" });

    expect((await getRecentlyUpdated(session, 8)).map((r) => r.foodbank_name)).toEqual(["Salisbury"]);
  });

  // The whole point of 0019, executed rather than asserted in a comment. The
  // name comes from the parent row at read time, so renaming a food bank
  // fixes the homepage immediately -- no cascade, no re-save of every child.
  // Before 0019, 24 rows in production disagreed with their parent's name.
  it("reports the parent's CURRENT name, with no cached copy to go stale", async () => {
    seedChange({ foodbank_id: SALISBURY, created: "2026-09-05 12:00:00.000000" });

    expect((await getRecentlyUpdated(session, 8)).map((r) => r.foodbank_name)).toEqual(["Salisbury"]);

    db.exec("UPDATE foodbank SET name = 'Salisbury Foodbank' WHERE id = 1");
    expect((await getRecentlyUpdated(session, 8)).map((r) => r.foodbank_name)).toEqual(["Salisbury Foodbank"]);
  });

  // Django's `.only('foodbank_name')`. The view hands out `c.*` plus
  // foodbank_name and foodbank_slug, so this projection is a real narrowing
  // and not an accident -- and RecentlyUpdatedRow declares exactly one field.
  it("projects only foodbank_name", async () => {
    seedChange({ foodbank_id: SALISBURY, created: "2026-09-05 12:00:00.000000" });

    expect(Object.keys((await getRecentlyUpdated(session, 8))[0]!)).toEqual(["foodbank_name"]);
  });

  // index() does NOT deduplicate -- country() does (givefood/views.py:233-241),
  // and the port mirrors that split exactly: getRecentlyUpdatedByCountry's
  // caller runs a dedupe loop, publicIndex's does not. If someone "tidies"
  // this query with a DISTINCT or a GROUP BY to stop the homepage repeating a
  // busy food bank, they change the page's row count as well as its contents
  // and diverge from the Django original in the same move.
  it("keeps duplicates -- the homepage query does not deduplicate", async () => {
    seedChange({ foodbank_id: SALISBURY, created: "2026-09-05 12:00:00.000000" });
    seedChange({ foodbank_id: SALISBURY, created: "2026-09-05 11:00:00.000000" });
    seedChange({ foodbank_id: ABERDEEN, created: "2026-09-05 10:00:00.000000" });

    expect((await getRecentlyUpdated(session, 8)).map((r) => r.foodbank_name)).toEqual(["Salisbury", "Salisbury", "Aberdeen"]);
  });

  // DOCUMENTED, NOT ENDORSED. `created` is TEXT and this ORDER BY is a
  // bytewise text sort with no normalisation of its own, so the whole
  // module's ordering rests on every writer agreeing on Django's format.
  // 'T' is 0x54 and ' ' is 0x20, so a stray JavaScript toISOString() value
  // sorts AFTER every Django value of the same day regardless of the actual
  // time -- ticket #9, measured returning the wrong "latest published need"
  // in production, repaired in the data by 0022_normalise_timestamps.sql and
  // at the write sites by packages/models's pyNow()/pyDatetime(). Pinned here
  // so that if it ever comes back, it comes back with a name on it.
  it("sorts an ISO-format created ahead of a later Django-format one (ticket #9)", async () => {
    seedChange({ foodbank_id: SALISBURY, created: "2026-09-05T08:00:00.000Z" });
    seedChange({ foodbank_id: ABERDEEN, created: "2026-09-05 20:00:00.000000" });

    // Salisbury's change is twelve hours EARLIER and still comes first.
    expect((await getRecentlyUpdated(session, 8)).map((r) => r.foodbank_name)).toEqual(["Salisbury", "Aberdeen"]);
  });

  it("returns an empty array when nothing qualifies", async () => {
    expect(await getRecentlyUpdated(session, 8)).toEqual([]);
  });
});

// ===========================================================================
// getMostViewed -- index()'s `most_viewed` (givefood/views.py:170-178)
// ===========================================================================
describe("getMostViewed", () => {
  beforeEach(seedFiveFoodbanks);

  // Django's `.annotate(total_hits=Sum('foodbankhit__hits')).order_by('-total_hits')`.
  // Salisbury's three modest days beat Aberdeen's single big one, so this
  // fails for a query that ranked by MAX(hits), by the newest day's hits, or
  // by hits without any aggregation at all. The row COUNT is the GROUP BY:
  // drop it and SQLite collapses everything into one row.
  it("ranks by the week's SUM of hits, not by any single day's", async () => {
    seedHit(SALISBURY, "2026-09-01", 10);
    seedHit(SALISBURY, "2026-09-02", 10);
    seedHit(SALISBURY, "2026-09-03", 10);
    seedHit(ABERDEEN, "2026-09-04", 25);

    const rows = await getMostViewed(session, SINCE_DAY, UNTIL_DAY, 8);
    expect(slugs(rows)).toEqual(["salisbury", "aberdeen"]);
    // One row per food bank, not one per hit day.
    expect(rows).toHaveLength(2);
  });

  // THREE MUTANTS IN ONE ASSERTION. Django's filter is `day__gte=today-7`
  // AND `day__lte=today`, both inclusive.
  //   * `>=` weakened to `>` loses Salisbury, whose only hits are on the
  //     since day.
  //   * `<=` weakened to `<` loses Aberdeen, whose only hits are on today.
  //   * either bound dropped promotes Cardiff to first place with 2002.
  // The window also straddles a month boundary, so a comparison that got at
  // the day-of-month rather than the zero-padded text would put 08-31 after
  // 09-07 and lose Salisbury too.
  it("includes both window boundaries and nothing outside them", async () => {
    seedHit(SALISBURY, SINCE_DAY, 8);
    seedHit(ABERDEEN, UNTIL_DAY, 6);
    seedHit(CARDIFF, "2026-08-30", 999);
    seedHit(CARDIFF, "2026-09-08", 999);
    seedHit(CARDIFF, "2026-09-02", 4);

    expect(slugs(await getMostViewed(session, SINCE_DAY, UNTIL_DAY, 8))).toEqual(["salisbury", "aberdeen", "cardiff"]);
  });

  // A food bank whose only hits are outside the window is absent entirely --
  // not present with a zero or null total. Django's queryset is an inner
  // join too, so a LEFT JOIN here would add rows the original never had, and
  // ORDER BY on a NULL total would scatter them unpredictably through the
  // list.
  it("omits a food bank with no hits inside the window", async () => {
    seedHit(SALISBURY, "2026-09-02", 5);
    seedHit(ABERDEEN, "2026-08-01", 5000);

    expect(slugs(await getMostViewed(session, SINCE_DAY, UNTIL_DAY, 8))).toEqual(["salisbury"]);
  });

  // The join is INNER, so hit rows for a food bank that no longer exists
  // vanish rather than producing a row with a null name and slug -- which
  // would render as an empty link on the homepage. foodbankAdmin.ts's
  // deleteFoodbank does clear foodbankhit, so this is the defensive case,
  // but D1 has no foreign keys (PLAN.md §4.5) and the hit table is
  // ETL-loaded independently.
  it("drops hits belonging to a food bank that is not in the table", async () => {
    seedHit(9999, "2026-09-02", 5000);
    seedHit(SALISBURY, "2026-09-02", 5);

    expect(slugs(await getMostViewed(session, SINCE_DAY, UNTIL_DAY, 8))).toEqual(["salisbury"]);
  });

  // NO is_closed FILTER, and that is deliberate: Django's most_viewed has
  // none either. A closed food bank's page still exists and still gets
  // traffic (often a spike, which is why people are looking it up), and
  // "most viewed" means most viewed. Anyone adding `WHERE f.is_closed = 0`
  // here would be diverging from the original, so make them break a test
  // saying so.
  it("does not exclude closed food banks", async () => {
    seedHit(CLOSED_TOWN, "2026-09-02", 100);
    seedHit(SALISBURY, "2026-09-02", 5);

    expect(slugs(await getMostViewed(session, SINCE_DAY, UNTIL_DAY, 8))).toEqual(["closed-town", "salisbury"]);
  });

  // The LIMIT must apply AFTER the ranking, which is what makes it a "top N"
  // rather than "any N". Four candidates, limit 2, and the two that survive
  // are the two biggest -- a LIMIT applied before the aggregation (or an
  // ORDER BY that lost its DESC) picks a different pair.
  it("takes the top N after ranking, not the first N found", async () => {
    seedHit(SALISBURY, "2026-09-02", 1);
    seedHit(ABERDEEN, "2026-09-02", 40);
    seedHit(CARDIFF, "2026-09-02", 2);
    seedHit(BALLYMENA, "2026-09-02", 30);

    expect(slugs(await getMostViewed(session, SINCE_DAY, UNTIL_DAY, 2))).toEqual(["aberdeen", "ballymena"]);
  });

  // Django's `.only('name', 'slug')`. The template builds a link from the
  // real foodbank.slug here -- unlike recently_updated, which slugifies a
  // name -- so both columns have to arrive, under these exact keys.
  it("projects exactly name and slug", async () => {
    seedHit(SALISBURY, "2026-09-02", 5);

    const rows = await getMostViewed(session, SINCE_DAY, UNTIL_DAY, 8);
    expect(Object.keys(rows[0]!)).toEqual(["name", "slug"]);
    expect(rows[0]).toEqual({ name: "Salisbury", slug: "salisbury" });
  });

  it("returns an empty array when the window is empty", async () => {
    expect(await getMostViewed(session, SINCE_DAY, UNTIL_DAY, 8)).toEqual([]);
  });
});

// ===========================================================================
// The three article functions. They share ARTICLE_SELECT, so the join and the
// projection are tested once and each function's own WHERE is tested against
// rows that must be excluded.
// ===========================================================================

// Two food banks, six articles, distinct published_dates -- two of them
// sharing a date and differing only in the time, for the same reason as
// getRecentlyUpdated's ordering fixture. Ties in published_date are left
// untested on purpose: the ORDER BY has no tiebreak, so their relative order
// is whatever the planner happens to produce and asserting it would pin an
// accident.
//
// THE ids ARE SCRAMBLED AGAINST THE DATES, DELIBERATELY, AND NEITHER RUNS
// WITH THE OTHER NOR EXACTLY AGAINST IT. Read in published_date DESC order
// the ids go 2, 9, 4, 7, 3 -- not ascending, not descending, and the same is
// true of the featured-only subset (9, 4, 7) and of Salisbury's own three
// (9, 1, 7) in getArticlesByFoodbankId below. That is a fixture property two
// separate mutants depend on, and getting only one of them right is easy:
//
//   * ids ASCENDING with the dates (the original fixture: id 1 = newest) let
//     a table scan in rowid order produce the right answer by luck, so
//     DELETING the ORDER BY passed once the covering index was out of the way.
//   * ids exactly DESCENDING with the dates -- the obvious correction, and
//     one this file briefly shipped -- fixes that and breaks the other side:
//     `ORDER BY a.id DESC` then means the same thing as
//     `ORDER BY a.published_date DESC`, and sorting by the wrong column
//     passes every test in the block.
//
// Two featured rows cannot discriminate both directions at once (with two
// rows, any id order is either the answer or its reverse), which is why there
// are THREE featured articles here rather than the two this fixture used to
// carry. "Featured middle" is Aberdeen's, so it also gives
// getArticlesByFoodbankId a featured article belonging to somebody else.
function seedArticles(): void {
  seedFiveFoodbanks();
  seedArticle({ id: 2, foodbank_id: ABERDEEN, title: "Plain newest", featured: 0, published_date: "2026-09-05 21:00:00.000000" });
  seedArticle({ id: 9, foodbank_id: SALISBURY, title: "Featured newest", featured: 1, published_date: "2026-09-05 20:00:00.000000" });
  seedArticle({ id: 4, foodbank_id: ABERDEEN, title: "Featured middle", featured: 1, published_date: "2026-09-03 12:00:00.000000" });
  seedArticle({ id: 7, foodbank_id: SALISBURY, title: "Featured older", featured: 1, published_date: "2026-09-01 09:00:00.000000" });
  seedArticle({ id: 3, foodbank_id: ABERDEEN, title: "Plain older", featured: 0, published_date: "2026-08-20 09:00:00.000000" });
  seedArticle({ id: 5, foodbank_id: null, title: "Orphan featured", featured: 1, published_date: "2026-09-06 09:00:00.000000" });
  seedArticle({ id: 6, foodbank_id: 9999, title: "Dangling parent", featured: 1, published_date: "2026-09-07 09:00:00.000000" });
}

const titles = (rows: Array<{ title: string }>) => rows.map((r) => r.title);

describe("getFeaturedArticles", () => {
  beforeEach(seedArticles);

  // Django's `.filter(featured=True).order_by('-published_date')[:5]`. "Plain
  // newest" is the newest parented article in the fixture and must NOT be
  // here -- a fixture of featured rows only would pass with the filter
  // deleted.
  it("returns only featured articles, newest first", async () => {
    expect(titles(await getFeaturedArticles(session, 5))).toEqual(["Featured newest", "Featured middle", "Featured older"]);
  });

  // LIMIT 1 over a fixture whose newest featured article is neither the first
  // row written nor the lowest id, so "took the top one" and "took whichever
  // came to hand" give different answers. Kills `ORDER BY a.id DESC` and an
  // ASC flip; the one mutant it cannot kill is the ORDER BY deleted entirely,
  // because `article_published_idx` re-supplies exactly that order -- see the
  // equivalent-mutant note in this file's header.
  it("truncates to the limit after ordering", async () => {
    expect(titles(await getFeaturedArticles(session, 1))).toEqual(["Featured newest"]);
  });

  // coerceBooleans (types.ts:19-26) turning the stored INTEGER into a real
  // boolean. packages/serialise and the templates expect `true`, not `1`;
  // `1` is truthy so a missing coercion looks fine in a template and wrong
  // in JSON.
  it("hands back featured as a real boolean", async () => {
    const [first] = await getFeaturedArticles(session, 5);
    expect(first!.featured).toBe(true);
  });

  // The projection FeaturedArticleRow declares, in order. mapArticleRow
  // (packages/models) reads every one of these by name; a renamed column
  // arrives as undefined rather than as an error.
  it("projects the eight columns of FeaturedArticleRow", async () => {
    const [first] = await getFeaturedArticles(session, 5);
    expect(Object.keys(first!)).toEqual(["id", "foodbank_id", "foodbank_name", "foodbank_slug", "published_date", "title", "url", "featured"]);
    expect(first).toMatchObject({
      // id 9, and it is the HIGHEST id in the fixture while being neither
      // the first nor the last row written -- so this also witnesses that the
      // newest article is being returned rather than the lowest-numbered or
      // first-inserted one.
      id: 9,
      foodbank_id: SALISBURY,
      foodbank_name: "Salisbury",
      foodbank_slug: "salisbury",
      published_date: "2026-09-05 20:00:00.000000",
      featured: true,
    });
  });

  // Same 0019 point as getRecentlyUpdated's: the name and slug come from the
  // parent at read time. This one matters more, because foodbank_slug is what
  // builds the article's link and its favicon URL -- a stale slug is a 404,
  // which is exactly the failure 0019's header describes.
  it("reads foodbank_name and foodbank_slug from the parent at read time", async () => {
    db.exec("UPDATE foodbank SET name = 'Salisbury Foodbank', slug = 'salisbury-foodbank' WHERE id = 1");

    const [first] = await getFeaturedArticles(session, 5);
    expect(first).toMatchObject({ foodbank_name: "Salisbury Foodbank", foodbank_slug: "salisbury-foodbank" });
  });

  // SUSPECT, PINNED AS-IS. ARTICLE_SELECT uses an INNER JOIN, so the two
  // parentless rows in the fixture -- "Orphan featured" (foodbank_id NULL)
  // and "Dangling parent" (a foodbank_id with no row) -- disappear, even
  // though both are `featured = 1` and both are NEWER than everything that
  // survives. Django's `select_related('foodbank')` over a nullable FK
  // (givefood/models/articles.py:20, `null=True, blank=True`) compiles to a
  // LEFT OUTER JOIN and keeps them; adminLists.ts:318 runs the same listing
  // over the same table with a LEFT JOIN. The port's own ETL copies
  // foodbank_id verbatim from Postgres, NULLs included
  // (tools/pg-to-d1/extract_core.py:215-217).
  //
  // Not "fixed" here, and not asserted as a failing wish: this is what the
  // code does, and swapping the join would change what /news/ and the
  // homepage show. Reported instead. If it is ever changed to LEFT JOIN,
  // this test should go red -- that is the point of it.
  it("drops articles with no parent food bank -- INNER JOIN, unlike Django's LEFT OUTER (suspect)", async () => {
    const found = titles(await getFeaturedArticles(session, 5));
    expect(found).not.toContain("Orphan featured");
    expect(found).not.toContain("Dangling parent");
  });
});

describe("getRecentArticles", () => {
  beforeEach(seedArticles);

  // news()'s query (givefood/views.py:586) is getFeaturedArticles' minus the
  // featured filter -- so the one row that separates the two functions is
  // "Plain newest", and it has to be first. A copy-paste that left the
  // `featured = 1` in would make /news/ a second, smaller featured page and
  // nothing would error.
  it("includes unfeatured articles, newest first", async () => {
    expect(titles(await getRecentArticles(session, 100))).toEqual([
      "Plain newest",
      "Featured newest",
      "Featured middle",
      "Featured older",
      "Plain older",
    ]);
  });

  it("truncates to the limit after ordering", async () => {
    expect(titles(await getRecentArticles(session, 2))).toEqual(["Plain newest", "Featured newest"]);
  });

  // The other half of the coerceBooleans contract: 0 becomes false, not
  // null and not 0. Both arms need a test, because a coercion that returned
  // the raw value would pass a true-only assertion.
  it("coerces featured to false for an unfeatured article", async () => {
    const rows = await getRecentArticles(session, 100);
    expect(rows.map((r) => [r.title, r.featured])).toEqual([
      ["Plain newest", false],
      ["Featured newest", true],
      ["Featured middle", true],
      ["Featured older", true],
      ["Plain older", false],
    ]);
  });

  // Same INNER JOIN as getFeaturedArticles -- see that block's comment. It
  // bites harder here: /news/ is meant to be "every recent article", and
  // these two are the newest in the table.
  it("drops parentless articles too (suspect -- see getFeaturedArticles)", async () => {
    const found = titles(await getRecentArticles(session, 100));
    expect(found).not.toContain("Orphan featured");
    expect(found).not.toContain("Dangling parent");
  });
});

describe("getArticlesByFoodbankId", () => {
  beforeEach(seedArticles);

  // Foodbank.articles() (givefood/models/foodbank.py:307-309) --
  // `.filter(foodbank=self).order_by('-published_date')[:20]`, with NO
  // featured filter. Both halves are asserted: Aberdeen's articles are
  // absent, and Salisbury's unfeatured one would be present if it had one --
  // so the fixture below adds it rather than relying on the shared seed.
  // id 1 for the added row, so Salisbury's three run 9, 1, 7 in
  // published_date DESC order -- neither ascending nor descending, for the
  // reason seedArticles' header gives.
  it("returns only that food bank's articles, newest first, featured or not", async () => {
    seedArticle({ id: 1, foodbank_id: SALISBURY, title: "Salisbury plain", featured: 0, published_date: "2026-09-03 09:00:00.000000" });

    expect(titles(await getArticlesByFoodbankId(session, SALISBURY, 20))).toEqual(["Featured newest", "Salisbury plain", "Featured older"]);
  });

  // The filter that a fixture of one food bank's rows could never prove. If
  // `WHERE a.foodbank_id = ?` were dropped, every food bank's news page would
  // show every food bank's news and nothing would error.
  // "Featured middle" is Aberdeen's and IS featured, so this also rules out a
  // `featured = 1` filter creeping in and masking the scoping: a query that
  // returned every featured article would contain it.
  it("excludes another food bank's articles", async () => {
    const found = titles(await getArticlesByFoodbankId(session, SALISBURY, 20));
    expect(found).not.toContain("Plain newest");
    expect(found).not.toContain("Plain older");
    expect(found).not.toContain("Featured middle");
  });

  it("truncates to the limit after ordering", async () => {
    expect(titles(await getArticlesByFoodbankId(session, SALISBURY, 1))).toEqual(["Featured newest"]);
  });

  // A food bank with no articles gets an empty list, not the whole table --
  // the case wfbn/newsCharity.ts renders as "no news yet".
  it("returns an empty array for a food bank with no articles", async () => {
    expect(await getArticlesByFoodbankId(session, CARDIFF, 20)).toEqual([]);
  });

  // Same row shape as the other two, because they share ARTICLE_SELECT.
  // rss.ts picks between getArticlesByFoodbankId and getRecentArticles at
  // runtime and feeds either into one mapper, so the shapes must not drift
  // apart.
  it("projects the same eight columns as the other two", async () => {
    const [first] = await getArticlesByFoodbankId(session, SALISBURY, 20);
    expect(Object.keys(first!)).toEqual(["id", "foodbank_id", "foodbank_name", "foodbank_slug", "published_date", "title", "url", "featured"]);
    expect(first!.featured).toBe(true);
  });
});

// ===========================================================================
// getRecentlyUpdatedByCountry -- country()'s `recent_changes`
// (givefood/views.py:226-232)
// ===========================================================================
describe("getRecentlyUpdatedByCountry", () => {
  beforeEach(seedFiveFoodbanks);

  it("returns only that country's changes, newest first", async () => {
    seedChange({ foodbank_id: ABERDEEN, created: "2026-09-05 20:00:00.000000" });
    seedChange({ foodbank_id: SALISBURY, created: "2026-09-05 19:00:00.000000" });
    seedChange({ foodbank_id: CLOSED_TOWN, created: "2026-09-05 18:00:00.000000" });
    seedChange({ foodbank_id: CARDIFF, created: "2026-09-05 17:00:00.000000" });

    // Aberdeen (Scotland) is the newest overall and must be absent; Closed
    // Town is England, closed, and must be PRESENT -- country() has no
    // is_closed filter either, same as most_viewed.
    expect((await getRecentlyUpdatedByCountry(session, "England", 50)).map((r) => r.foodbank_name)).toEqual(["Salisbury", "Closed Town"]);
  });

  // `f.country = ?` is a plain equality under SQLite's BINARY collation.
  // country.ts passes COUNTRY_MAPPING's values ("England", "Scotland",
  // "Wales", "Northern Ireland"), which match the stored casing exactly; a
  // slug reaching this function instead of a name gets an empty page rather
  // than an error, which is worth knowing about before someone debugs it
  // from the template end.
  it("matches the country name exactly, case included", async () => {
    seedChange({ foodbank_id: SALISBURY, created: "2026-09-05 12:00:00.000000" });

    expect(await getRecentlyUpdatedByCountry(session, "england", 50)).toEqual([]);
    expect(await getRecentlyUpdatedByCountry(session, "Northern Ireland", 50)).toEqual([]);
  });

  it("returns Northern Ireland's changes under its full name", async () => {
    seedChange({ foodbank_id: BALLYMENA, created: "2026-09-05 12:00:00.000000" });

    expect((await getRecentlyUpdatedByCountry(session, "Northern Ireland", 50)).map((r) => r.foodbank_name)).toEqual(["Ballymena"]);
  });

  // THE CONTRACT THE CALLER DEPENDS ON. country.ts over-fetches 50 rows and
  // then walks them in order keeping the first appearance of each name, to
  // reach 10 uniques -- Django's own fetch-then-dedupe (views.py:230-241),
  // because D1 has no "distinct on, keep original order" primitive. Add a
  // DISTINCT or a GROUP BY here and the loop still runs, still produces
  // plausible output, and quietly changes which 10 food banks the country
  // page shows.
  it("keeps duplicates, in created order, for the caller's dedupe loop", async () => {
    seedChange({ foodbank_id: SALISBURY, created: "2026-09-05 12:00:00.000000" });
    seedChange({ foodbank_id: SALISBURY, created: "2026-09-05 11:00:00.000000" });
    seedChange({ foodbank_id: CLOSED_TOWN, created: "2026-09-05 10:00:00.000000" });
    seedChange({ foodbank_id: SALISBURY, created: "2026-09-05 09:00:00.000000" });

    expect((await getRecentlyUpdatedByCountry(session, "England", 50)).map((r) => r.foodbank_name)).toEqual([
      "Salisbury",
      "Salisbury",
      "Closed Town",
      "Salisbury",
    ]);
  });

  it("applies the same published and sentinel filters as the homepage twin", async () => {
    seedChange({ foodbank_id: SALISBURY, published: 0, created: "2026-09-05 12:00:00.000000" });
    seedChange({ foodbank_id: SALISBURY, change_text: "Unknown", created: "2026-09-05 11:00:00.000000" });
    seedChange({ foodbank_id: SALISBURY, change_text: "Facebook", created: "2026-09-05 10:00:00.000000" });
    seedChange({ foodbank_id: SALISBURY, change_text: "Nothing", created: "2026-09-05 09:00:00.000000" });
    seedChange({ foodbank_id: CLOSED_TOWN, change_text: "Beans", created: "2026-09-05 08:00:00.000000" });

    expect((await getRecentlyUpdatedByCountry(session, "England", 50)).map((r) => r.foodbank_name)).toEqual(["Closed Town"]);
  });

  // This function reads the BASE foodbankchange table with its own INNER
  // JOIN, not foodbankchange_full -- so unlike its homepage twin it excludes
  // unparented changes twice over, and either mechanism alone would do it.
  // The join drops them because it is inner; `f.name IS NOT NULL` would drop
  // them even if it were made LEFT, which is why swapping the join is the one
  // mutation of this statement these tests cannot see. Under the join as
  // written the NULL check can never fire at all -- foodbank.name is declared
  // NOT NULL (0001_core.sql:12), as the second assertion shows -- so it is
  // the belt to the join's braces, kept for symmetry with
  // getRecentlyUpdated's, where post-0019 it is the only thing doing the work.
  it("drops changes with no parent food bank, by the join and the NULL check both", async () => {
    seedChange({ foodbank_id: null, created: "2026-09-05 12:00:00.000000" });
    seedChange({ foodbank_id: 9999, created: "2026-09-05 11:00:00.000000" });
    seedChange({ foodbank_id: SALISBURY, created: "2026-09-05 10:00:00.000000" });

    expect((await getRecentlyUpdatedByCountry(session, "England", 50)).map((r) => r.foodbank_name)).toEqual(["Salisbury"]);
    // The only rows `f.name IS NOT NULL` could exclude are rows the schema
    // refuses to store.
    expect(() => seedFoodbank({ id: 6, name: null, slug: "nameless" })).toThrow();
  });

  // WHICH three, not merely three. The original of this test asserted only
  // `toHaveLength(3)`, which a LIMIT applied before the ordering satisfies
  // just as happily as one applied after -- and "any 3 of the 5" is exactly
  // the wrong answer for a country page that then dedupes down to 10 names.
  // Seeding two food banks and naming the survivors makes the assertion a
  // claim about the ranking as well as the count.
  it("truncates to the over-fetch limit country() asks for, keeping the newest", async () => {
    seedFoodbank({ id: 6, name: "Andover", slug: "andover", country: "England" });
    seedChange({ foodbank_id: SALISBURY, created: "2026-09-05 10:00:00.000000" });
    seedChange({ foodbank_id: 6, created: "2026-09-05 14:00:00.000000" });
    seedChange({ foodbank_id: SALISBURY, created: "2026-09-05 11:00:00.000000" });
    seedChange({ foodbank_id: 6, created: "2026-09-05 13:00:00.000000" });
    seedChange({ foodbank_id: SALISBURY, created: "2026-09-05 12:00:00.000000" });

    expect((await getRecentlyUpdatedByCountry(session, "England", 3)).map((r) => r.foodbank_name)).toEqual([
      "Andover",
      "Andover",
      "Salisbury",
    ]);
  });

  it("projects only foodbank_name", async () => {
    seedChange({ foodbank_id: SALISBURY, created: "2026-09-05 12:00:00.000000" });

    expect(Object.keys((await getRecentlyUpdatedByCountry(session, "England", 50))[0]!)).toEqual(["foodbank_name"]);
  });
});

// ===========================================================================
// getMostViewedByCountry -- country()'s `most_viewed`
// (givefood/views.py:244-253)
// ===========================================================================
describe("getMostViewedByCountry", () => {
  beforeEach(seedFiveFoodbanks);

  // The country filter, proved by a food bank that would otherwise win. An
  // England page showing Aberdeen at the top is exactly the kind of wrong
  // that renders perfectly.
  it("excludes a busier food bank in another country", async () => {
    seedHit(ABERDEEN, "2026-09-02", 5000);
    seedHit(SALISBURY, "2026-09-02", 5);
    seedHit(CLOSED_TOWN, "2026-09-02", 7);

    expect(slugs(await getMostViewedByCountry(session, SINCE_DAY, UNTIL_DAY, "England", 10))).toEqual(["closed-town", "salisbury"]);
  });

  // Hit rows whose food bank is missing are absent here too, as they are in
  // getMostViewed -- but for a DIFFERENT reason, and the difference is worth
  // knowing before someone "simplifies" one of the two statements to match
  // the other. getMostViewed relies on the join being INNER, and widening it
  // to LEFT JOIN breaks that test. Here the widening is harmless: an
  // unmatched row is NULL-extended, `f.country = ?` is then NULL rather than
  // true, and the row falls out anyway. So the LEFT JOIN mutant survives this
  // statement no matter what is seeded. This test pins the OBSERVABLE
  // behaviour rather than the mechanism, so it still fails if someone removes
  // both the join's inner-ness and the country filter.
  it("drops hits belonging to a food bank that is not in the table", async () => {
    seedHit(9999, "2026-09-02", 5000);
    seedHit(SALISBURY, "2026-09-02", 5);

    expect(slugs(await getMostViewedByCountry(session, SINCE_DAY, UNTIL_DAY, "England", 10))).toEqual(["salisbury"]);
  });

  // The same three window mutants as getMostViewed's boundary test, since
  // this is a separate statement with its own copy of the predicates and a
  // fix applied to one has repeatedly not been applied to the other in this
  // codebase's history.
  it("includes both window boundaries and nothing outside them", async () => {
    seedFoodbank({ id: 6, name: "Andover", slug: "andover", country: "England" });
    seedHit(SALISBURY, SINCE_DAY, 8);
    seedHit(6, UNTIL_DAY, 6);
    seedHit(CLOSED_TOWN, "2026-08-30", 999);
    seedHit(CLOSED_TOWN, "2026-09-08", 999);
    seedHit(CLOSED_TOWN, "2026-09-02", 4);

    expect(slugs(await getMostViewedByCountry(session, SINCE_DAY, UNTIL_DAY, "England", 10))).toEqual(["salisbury", "andover", "closed-town"]);
  });

  it("ranks by the week's SUM of hits, one row per food bank", async () => {
    seedFoodbank({ id: 6, name: "Andover", slug: "andover", country: "England" });
    seedHit(SALISBURY, "2026-09-01", 10);
    seedHit(SALISBURY, "2026-09-02", 10);
    seedHit(SALISBURY, "2026-09-03", 10);
    seedHit(6, "2026-09-04", 25);

    const rows = await getMostViewedByCountry(session, SINCE_DAY, UNTIL_DAY, "England", 10);
    expect(slugs(rows)).toEqual(["salisbury", "andover"]);
    expect(rows).toHaveLength(2);
  });

  it("takes the top N after ranking", async () => {
    seedFoodbank({ id: 6, name: "Andover", slug: "andover", country: "England" });
    seedHit(SALISBURY, "2026-09-02", 1);
    seedHit(CLOSED_TOWN, "2026-09-02", 40);
    seedHit(6, "2026-09-02", 30);

    expect(slugs(await getMostViewedByCountry(session, SINCE_DAY, UNTIL_DAY, "England", 2))).toEqual(["closed-town", "andover"]);
  });

  it("matches the country name exactly, case included", async () => {
    seedHit(SALISBURY, "2026-09-02", 5);

    expect(await getMostViewedByCountry(session, SINCE_DAY, UNTIL_DAY, "england", 10)).toEqual([]);
  });

  it("projects exactly name and slug", async () => {
    seedHit(ABERDEEN, "2026-09-02", 5);

    const rows = await getMostViewedByCountry(session, SINCE_DAY, UNTIL_DAY, "Scotland", 10);
    expect(Object.keys(rows[0]!)).toEqual(["name", "slug"]);
    expect(names(rows)).toEqual(["Aberdeen"]);
  });

  it("returns an empty array when the country has no hits in the window", async () => {
    seedHit(ABERDEEN, "2026-09-02", 5);

    expect(await getMostViewedByCountry(session, SINCE_DAY, UNTIL_DAY, "Wales", 10)).toEqual([]);
  });
});
