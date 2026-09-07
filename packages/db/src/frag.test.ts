import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { FRAG_KV_KEY_LAST_UPDATED, FRAG_KV_KEY_NEED_HITS, getLastModifiedFoodbank, getRecentHitsTotal } from "./frag";
import type { Session } from "./types";

// frag.ts is two aggregate queries and two KV key strings, and both queries
// fail SILENTLY when they are wrong: MAX() over the wrong column still
// returns a timestamp, SUM() over the wrong window still returns a number,
// and /frag/last-updated and /frag/need-hits render whatever came back. The
// only failure mode a human notices is the 403 the route serves when the
// value is null -- every other wrong answer looks exactly like a right one.
//
// So this file runs the REAL SQL against a REAL SQLite database seeded from
// the REAL DDL (migrations/0001_core.sql:10-56 for foodbank, 0003_homepage
// _data.sql:40-45 for foodbankhit, both verbatim -- no migration has ALTERed
// either table since). A hand-built fixture table would have made every
// assertion below circular: the question these tests exist to answer is
// whether the SQL in the module agrees with the schema in the migrations,
// and a schema retyped from the TypeScript interfaces cannot answer it.
//
// The scar this guards is on record in TESTING.md and in 0019_drop_foodbank
// _cache.sql: migration 0019 silently broke four queries and nobody noticed
// until someone measured /dashboard/beautybanks/.
//
// KNOWN, AND NOT FIXABLE FROM INSIDE A TEST FILE: `pnpm test` is green but
// `pnpm typecheck` is not, because packages/db/tsconfig.json pins
// `"types": ["@cloudflare/workers-types"]` and the workspace has no
// @types/node, so `import { DatabaseSync } from "node:sqlite"` has nothing
// to resolve against. foodbankAdmin.test.ts:35-37 called this out before
// this file existed ("a test importing node:sqlite fails `pnpm typecheck`
// for everyone") and locationsAdmin.test.ts:22-32 worked around it by
// putting its engine-level proof in workers/site, whose tsconfig differs.
// That workaround does not scale -- 42 files under packages/db/src now
// import node:sqlite. The repair is one dependency and one tsconfig line
// (add @types/node, add "node" to that types array), which is a build
// change rather than a test change and so is deliberately not made here.
// Weakening this file back to a mocked Session to dodge it would be the
// wrong trade: a mock cannot answer the question these tests exist for.

// Verbatim from packages/db/migrations/0001_core.sql and
// 0003_homepage_data.sql. The indexes come along because they are how
// SQLite actually ANSWERS these two queries in production -- MAX(modified)
// is served off foodbank_modified_idx and the SUM off the covering
// hit_day_foodbank_idx -- and because foodbankhit's WITHOUT ROWID primary
// key is what stops a test seeding two rows for one food bank on one day, a
// state the real table would have refused and whose totals would therefore
// mean nothing. foodbank_edited_idx sits directly beside foodbank_modified
// _idx in the migration, which is exactly why the "reads modified, not
// edited" test below is worth having.
const SCHEMA = `
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
CREATE INDEX foodbank_modified_idx       ON foodbank(modified);
CREATE INDEX foodbank_edited_idx         ON foodbank(edited);
CREATE INDEX foodbank_closed_edited_idx  ON foodbank(is_closed, edited DESC);

CREATE TABLE foodbankhit (
  foodbank_id INTEGER NOT NULL, day TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (foodbank_id, day)
) WITHOUT ROWID;
CREATE INDEX hit_day_foodbank_idx ON foodbankhit(day, foodbank_id, hits);
`;

type Bindable = null | number | bigint | string | Uint8Array;

// The same adapter workers/site/src/routes/admin/foodbankLocation.test.ts
// uses, copied rather than reinvented: node:sqlite's synchronous statement
// API dressed as the async D1 Sessions API this package is typed against.
// Deliberately dumb -- it never inspects the SQL, so it cannot quietly agree
// with a query that says something other than what it means.
function d1Session(db: DatabaseSync) {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return { prepare: (sql: string) => statement(sql, []), getBookmark: () => null };
}

let db: DatabaseSync;
let session: Session;
// Reset alongside the database, so seedFoodbank() hands out 1, 2, 3 in every
// test and the ids seedHit() references are the ones that actually exist.
let nextId = 1;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  session = d1Session(db) as unknown as Session;
  nextId = 1;
});

// Every NOT NULL column on foodbank gets a value; only the ones any test
// actually reads are parameters. `created` defaults to something OLDER than
// `modified` and `edited` to something NEWER, so a query that reached for
// the wrong one of the three would come back with an obviously wrong answer
// rather than the right one by luck.
function seedFoodbank(opts: { modified: string; created?: string; edited?: string | null; isClosed?: 0 | 1; name?: string }): number {
  const id = nextId++;
  const name = opts.name ?? `Food Bank ${id}`;
  db.prepare(
    `INSERT INTO foodbank (
       id, uuid, name, slug, address, postcode, country, lat_lng,
       contact_email, url, shopping_list_url,
       charity_just_foodbank, address_is_administrative, is_closed,
       no_locations, days_between_needs,
       created, modified, edited
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0, 14, ?, ?, ?)`,
  ).run(
    id,
    `uuid${id}`,
    name,
    name.toLowerCase().replace(/\W+/g, "-"),
    "1 High Street",
    "SP1 1AA",
    "England",
    "51.0688,-1.7945",
    `info@example${id}.org`,
    "https://example.org/",
    "https://example.org/list/",
    opts.isClosed ?? 0,
    opts.created ?? "2019-01-01 00:00:00.000000",
    opts.modified,
    opts.edited === undefined ? "2099-12-31 23:59:59.999999" : opts.edited,
  );
  return id;
}

function seedHit(foodbankId: number, day: string, hits: number): void {
  db.prepare("INSERT INTO foodbankhit (foodbank_id, day, hits) VALUES (?, ?, ?)").run(foodbankId, day, hits);
}

// -------------------------------------------------------------------------
// KV keys
// -------------------------------------------------------------------------

// These two strings exist precisely so they are NOT hand-synced literals in
// two independently-deployable Workers (frag.ts:3-7). Pinning the literal
// values, not just their equality to themselves, because the two Workers do
// not deploy together: workers/jobs' fragRefresh writes these keys and
// workers/site's frag handler reads them, and clearCache.ts:128 deletes
// them. Change the string and the already-deployed half keeps writing the
// old key, the new half reads a key nobody writes, and -- because neither
// put() sets an expiration -- the orphaned old value sits in the shared DATA
// namespace forever, no longer reachable by the admin's Clear Cache button.
// Renaming the CONSTANT is free; changing the VALUE is not, and this is
// where a reviewer finds that out.
describe("KV key names", () => {
  it("are the exact strings the site Worker, the jobs cron and clearCache all agree on", () => {
    expect(FRAG_KV_KEY_LAST_UPDATED).toBe("frag:last-updated");
    expect(FRAG_KV_KEY_NEED_HITS).toBe("frag:need-hits");
  });

  // DATA is a general-purpose namespace shared with everything else the site
  // caches. The `frag:` prefix is the only thing keeping these from
  // colliding with another feature's key, and a bare "last-updated" would be
  // a plausible name for half a dozen unrelated things.
  it("are namespaced and distinct from each other", () => {
    expect(FRAG_KV_KEY_LAST_UPDATED.startsWith("frag:")).toBe(true);
    expect(FRAG_KV_KEY_NEED_HITS.startsWith("frag:")).toBe(true);
    expect(FRAG_KV_KEY_LAST_UPDATED).not.toBe(FRAG_KV_KEY_NEED_HITS);
  });
});

// -------------------------------------------------------------------------
// getLastModifiedFoodbank
// -------------------------------------------------------------------------

describe("getLastModifiedFoodbank", () => {
  // The Django line being ported is givefood/views.py:1052 --
  // `Foodbank.objects.latest("modified").modified`. Not a max over some
  // subset: Foodbank declares no custom manager (givefood/models/foodbank
  // .py:55, checked), so `objects` is the plain default and the queryset is
  // unfiltered.
  it("returns the largest modified value across every row", () => {
    seedFoodbank({ modified: "2026-09-03 11:00:00.000000" });
    seedFoodbank({ modified: "2026-09-05 19:28:08.853000" });
    seedFoodbank({ modified: "2026-09-04 23:59:59.999999" });

    return expect(getLastModifiedFoodbank(session)).resolves.toBe("2026-09-05 19:28:08.853000");
  });

  // Kills the MAX -> MIN mutant, which is otherwise invisible: both return a
  // real, plausible-looking timestamp and /frag/last-updated renders it as
  // "5 years ago" instead of "2 minutes ago". Seeded with the newest row
  // inserted FIRST so a query that accidentally answered "whatever rowid 1
  // holds" also fails here.
  it("is not fooled by insertion order", () => {
    seedFoodbank({ modified: "2026-09-05 19:28:08.853000" });
    seedFoodbank({ modified: "2020-01-01 00:00:00.000000" });
    seedFoodbank({ modified: "2019-06-30 12:00:00.000000" });

    return expect(getLastModifiedFoodbank(session)).resolves.toBe("2026-09-05 19:28:08.853000");
  });

  // foodbank carries THREE timestamp columns -- created, modified, edited --
  // and foodbank_edited_idx sits on the line right after foodbank_modified
  // _idx in 0001_core.sql. `edited` is seeded far in the future and `created`
  // far in the past on every row, so a query that reached for either comes
  // back with a value no assertion here would accept. Django says
  // `latest("modified")`, and "modified" is the one that means "the data
  // changed", including by the crawler; "edited" means "a human touched it".
  it("reads modified, not created and not edited", async () => {
    seedFoodbank({ created: "2015-01-01 00:00:00.000000", modified: "2026-09-05 19:28:08.853000", edited: "2099-12-31 23:59:59.999999" });

    await expect(getLastModifiedFoodbank(session)).resolves.toBe("2026-09-05 19:28:08.853000");
  });

  // Django's queryset has no is_closed filter, and /frag/last-updated is a
  // "when did this site last change" indicator -- closing a food bank IS a
  // change. Half the queries in this package legitimately carry
  // `WHERE is_closed = 0`, which makes adding one here a very easy and very
  // quiet mistake: the fragment would freeze at the last OPEN food bank's
  // timestamp and drift further behind reality every time a closure was the
  // most recent edit.
  it("counts closed food banks", async () => {
    seedFoodbank({ modified: "2026-09-01 09:00:00.000000", isClosed: 0 });
    seedFoodbank({ modified: "2026-09-05 19:28:08.853000", isClosed: 1 });

    await expect(getLastModifiedFoodbank(session)).resolves.toBe("2026-09-05 19:28:08.853000");
  });

  // MUTANT KILLED: `FROM foodbank` narrowed to `FROM foodbank WHERE edited
  // IS NOT NULL`. Until this test existed that mutant SURVIVED the whole
  // file, because seedFoodbank() hands every other row a non-null `edited`
  // -- the classic "every seeded row matches, so the filter is untested"
  // hole, and the reason a predicate can be added to this query and caught
  // by nothing. `edited` is genuinely nullable (0001_core.sql declares it
  // without NOT NULL, unlike `created` and `modified` beside it) and it
  // means "a human touched this record": a food bank the crawler has
  // updated but no human has ever edited is the ORDINARY case in
  // production, not an edge case. So if that row is the most recent change
  // -- which is exactly when /frag/last-updated should move -- an
  // accidental `edited`-shaped predicate freezes the fragment on an older
  // timestamp, and once no row survives the filter MAX() goes NULL and the
  // fragment 403s instead.
  it("counts a food bank that has never been edited", async () => {
    seedFoodbank({ modified: "2026-09-01 09:00:00.000000", edited: "2026-09-01 09:00:00.000000" });
    seedFoodbank({ modified: "2026-09-05 19:28:08.853000", edited: null });

    await expect(getLastModifiedFoodbank(session)).resolves.toBe("2026-09-05 19:28:08.853000");
  });

  // THE WHOLE "ADDED A WHERE CLAUSE" FAMILY, IN ONE TEST. Everything above
  // catches a predicate on a column the fixture VARIES -- modified, edited,
  // is_closed. It cannot catch a predicate on a column every seeded row
  // holds the same value for: mutants adding `WHERE country = 'England'`,
  // `WHERE latest_need_id IS NULL` or `WHERE network IS NULL` all survived
  // the rest of this file, because seedFoodbank() leaves those at one
  // constant and a filter that matches every fixture row is a filter that
  // does nothing here while quietly discarding most of production.
  //
  // So this seeds a winner that is atypical on every axis at once: closed,
  // never edited, not in England, on a named network, carrying a latest
  // need, flagged as a school, with no locations, a charity that does more
  // than run a food bank and an address that is not administrative. Django's
  // line is `Foodbank.objects.latest("modified")` on the plain default
  // manager -- no filter of any kind -- and a copy-pasted predicate from one
  // of the network-filtered dashboard queries (the /dashboard/beautybanks/
  // family, where migration 0019's silent breakage was eventually noticed)
  // is exactly the shape of edit that lands here by accident.
  //
  // MUTANTS KILLED, none of which any other test in this file notices:
  // `WHERE country = 'England'`, `WHERE network IS NULL`, `WHERE network !=
  // 'Beauty Banks'`, `WHERE latest_need_id IS NULL`, `WHERE is_school IS
  // NULL`, `WHERE no_locations = 0`. Not a complete guard -- foodbank has
  // ~60 columns and this pins nine -- but it covers every column a filter
  // would plausibly be written against, and the nine are chosen so that
  // both polarities (`= 0` and `IS NULL`) of each are fatal.
  it("is filtered by nothing at all: an atypical food bank still wins", async () => {
    seedFoodbank({ modified: "2026-09-01 09:00:00.000000" });
    const winner = seedFoodbank({ modified: "2026-09-05 19:28:08.853000", isClosed: 1, edited: null });
    db.prepare(
      `UPDATE foodbank
          SET country = ?, network = ?, latest_need_id = ?, is_school = ?,
              no_locations = ?, charity_just_foodbank = ?, address_is_administrative = ?
        WHERE id = ?`,
    ).run("Scotland", "Independent", 99, 1, 1, 1, 1, winner);

    await expect(getLastModifiedFoodbank(session)).resolves.toBe("2026-09-05 19:28:08.853000");
  });

  // A single row is the case where MAX and "just read the column" agree, so
  // it proves only that the column name resolves against the real DDL -- but
  // that is exactly the thing migration 0019 broke elsewhere.
  it("returns the single row's value when there is only one food bank", async () => {
    seedFoodbank({ modified: "2026-09-05 19:28:08.853000" });

    await expect(getLastModifiedFoodbank(session)).resolves.toBe("2026-09-05 19:28:08.853000");
  });

  // THE DIVERGENCE FROM DJANGO, PINNED. `Foodbank.objects.latest()` raises
  // Foodbank.DoesNotExist on an empty table -- a 500. This returns null,
  // because SQLite's MAX() over zero rows is one row holding NULL (verified
  // against node:sqlite, not assumed), which frag.ts's `if (!modified)`
  // turns into the 403 the Django view would only have reached for a
  // different reason. Nobody will ever see it on production data, and it is
  // the behaviour the caller is written against.
  it("returns null on an empty table rather than throwing", async () => {
    await expect(getLastModifiedFoodbank(session)).resolves.toBeNull();
  });

  // The module's own claim, checked rather than trusted: frag.ts:12-14 says
  // MAX() "is the same answer as ORDER BY modified DESC LIMIT 1, without
  // needing a row shape back". Asserted against the same seeded rows so the
  // two cannot drift apart -- if a future change swaps one form for the
  // other, this says whether that was safe.
  it("agrees with ORDER BY modified DESC LIMIT 1, as its comment claims", async () => {
    seedFoodbank({ modified: "2026-09-03 11:00:00.000000" });
    seedFoodbank({ modified: "2026-09-05 19:28:08.853000" });
    seedFoodbank({ modified: "2026-09-04 23:59:59.999999" });

    const ordered = db.prepare("SELECT modified FROM foodbank ORDER BY modified DESC LIMIT 1").get() as { modified: string };
    await expect(getLastModifiedFoodbank(session)).resolves.toBe(ordered.modified);
  });

  // TICKET #9, THE HAZARD THIS COLUMN LIVES UNDER. `modified` is TEXT and
  // SQLite compares TEXT byte-wise, so "latest" means "lexicographically
  // largest", not "chronologically latest". 'T' is 0x54 and space is 0x20,
  // so ONE row written by a JavaScript toISOString() outranks every
  // Django-format row from the same day no matter what time it says.
  // Migration 0022 rewrote the 470-odd values this had already produced and
  // packages/models' pyNow()/pyDatetime() fixed the write sites -- this test
  // is the tripwire for the next write site that forgets, and it asserts
  // SQLite's real behaviour (run, not reasoned about) rather than the
  // behaviour anyone wants.
  it("SUSPECT-BY-DESIGN: an ISO-format value beats a later Django-format value from the same day", async () => {
    seedFoodbank({ modified: "2026-09-05 20:00:00.000000" }); // 20:00, Django format
    seedFoodbank({ modified: "2026-09-05T08:00:00.639Z" }); // 08:00, twelve hours EARLIER

    await expect(getLastModifiedFoodbank(session)).resolves.toBe("2026-09-05T08:00:00.639Z");
  });

  // The other half of 0022's repair, and the reason it appends `|| '000'`
  // rather than just swapping T for space: Python writes six fractional
  // digits, JavaScript writes three, and a shorter string is a prefix of the
  // longer one, so it sorts FIRST. Padding to a common length is what makes
  // lexicographic order and chronological order agree.
  it("SUSPECT-BY-DESIGN: three fractional digits sort before six at the same instant", async () => {
    seedFoodbank({ modified: "2026-09-05 20:00:00.639" });
    seedFoodbank({ modified: "2026-09-05 20:00:00.639000" });

    await expect(getLastModifiedFoodbank(session)).resolves.toBe("2026-09-05 20:00:00.639000");
  });

  // The `row?.` in `row?.modified ?? null` is unreachable against a real
  // engine -- an aggregate with no GROUP BY always yields exactly one row,
  // which is why the empty-table case above comes back as a row holding
  // NULL. D1's own type for .first() is `T | null` though, so the guard is
  // load-bearing against the TYPE even where it is dead against the data.
  // A stub is the only way to reach it; it is the one assertion in this file
  // that no database can make.
  //
  // EQUIVALENT MUTANT, RECORDED SO NOBODY HUNTS IT AGAIN: mutating `??` to
  // `||` here survives, and should. Its sibling in getRecentHitsTotal has a
  // second job -- `?? null` there preserves a real 0 that `|| null` would
  // erase, which is why that side has a test of its own -- but on THIS side
  // `modified` is NOT NULL and the only falsy string it could hold is "",
  // which both call sites already treat exactly as they treat null
  // (workers/site/.../frag.ts:74 `if (!modified)`, workers/jobs/.../index
  // .ts:305 `if (modified)`). Nothing observable changes, so this file does
  // not pin a value the column cannot hold just to turn the mutant red.
  it("survives a null row without throwing", async () => {
    const nullSession = { prepare: () => ({ first: async () => null }) } as unknown as Session;

    await expect(getLastModifiedFoodbank(nullSession)).resolves.toBeNull();
  });
});

// -------------------------------------------------------------------------
// getRecentHitsTotal
// -------------------------------------------------------------------------

// givefood/views.py:1060 --
//   FoodbankHit.objects.filter(day__gte=timezone.now() - timedelta(days=7))
//                      .aggregate(Sum('hits'))["hits__sum"]
//
// FoodbankHit.day is a DateField (givefood/models/analytics.py:17), so
// Django's DateField.to_python() truncates that datetime to a date before it
// reaches SQL. settings.py:210-213 pins TIME_ZONE = "UTC" with USE_TZ =
// False, so timezone.now() is a naive UTC datetime and .date() is the UTC
// date -- exactly what the callers' isoDate(new Date(Date.now() - 7d))
// produces. The two agree, and the settings were read to confirm it rather
// than assumed.
describe("getRecentHitsTotal", () => {
  it("sums hits from the threshold day onwards and excludes everything before it", async () => {
    seedFoodbank({ modified: "2026-09-05 19:28:08.853000" });
    // Deliberately large, so a missing WHERE clause returns a number no
    // assertion here could mistake for the right one.
    seedHit(1, "2026-08-01", 999_000);
    seedHit(1, "2026-08-28", 5_000);
    seedHit(1, "2026-08-30", 11);
    seedHit(1, "2026-09-01", 22);
    seedHit(1, "2026-09-04", 33);

    await expect(getRecentHitsTotal(session, "2026-08-30")).resolves.toBe(66);
  });

  // `>=`, not `>`. The threshold day is the eighth day of the window and
  // Django's day__gte includes it; an off-by-one here silently discards a
  // whole day of traffic from the headline number on the homepage, which is
  // the sort of drift nobody can spot by looking.
  it("includes rows dated exactly on the threshold day", async () => {
    seedFoodbank({ modified: "2026-09-05 19:28:08.853000" });
    seedHit(1, "2026-08-29", 100); // one day before -- must not count
    seedHit(1, "2026-08-30", 7); // exactly on it -- must count

    await expect(getRecentHitsTotal(session, "2026-08-30")).resolves.toBe(7);
  });

  // frag.ts's comment is explicit that this reproduces Django's day__gte
  // with NO day__lte, so "a future-dated row, if one ever existed, would
  // count too". Pinned as behaviour rather than left as prose, because
  // adding a tidy-looking `AND day <= ?` upper bound would be a real change
  // in what the number means, and this is where that shows up.
  it("has no upper bound, so a future-dated row counts", async () => {
    seedFoodbank({ modified: "2026-09-05 19:28:08.853000" });
    seedHit(1, "2026-09-04", 10);
    seedHit(1, "2099-01-01", 5);

    await expect(getRecentHitsTotal(session, "2026-08-30")).resolves.toBe(15);
  });

  // Django's queryset filters on the day alone. foodbankhit is the
  // PER-FOOD-BANK-PER-DAY table -- the whole point of this aggregate is the
  // site-wide total across all of them, and a stray foodbank_id predicate
  // would turn the homepage's "needs viewed this week" into one food bank's
  // figure while still rendering a perfectly believable number.
  it("sums across every food bank, not just one", async () => {
    seedFoodbank({ modified: "2026-09-05 19:28:08.853000" });
    seedFoodbank({ modified: "2026-09-05 19:28:08.853000" });
    seedFoodbank({ modified: "2026-09-05 19:28:08.853000" });
    seedHit(1, "2026-09-04", 1);
    seedHit(2, "2026-09-04", 20);
    seedHit(3, "2026-09-04", 300);

    await expect(getRecentHitsTotal(session, "2026-08-30")).resolves.toBe(321);
  });

  // And across days as well as food banks: one row per (foodbank, day) is
  // enforced by foodbankhit's WITHOUT ROWID primary key, so a realistic week
  // is a grid, not a list.
  it("sums across days as well as food banks", async () => {
    seedFoodbank({ modified: "2026-09-05 19:28:08.853000" });
    seedFoodbank({ modified: "2026-09-05 19:28:08.853000" });
    for (const day of ["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"]) {
      seedHit(1, day, 2);
      seedHit(2, day, 3);
    }
    seedHit(1, "2026-08-29", 1_000); // outside the window

    await expect(getRecentHitsTotal(session, "2026-08-30")).resolves.toBe(35);
  });

  // NULL AND ZERO ARE DIFFERENT ANSWERS, and the caller acts on the
  // difference: frag.ts:83 maps null to a 403 and any number to a rendered
  // string, matching Django's intcomma(None, False) falling through to
  // HttpResponseForbidden. `?? null` preserves 0; the `|| null` a reviewer
  // might "simplify" it to would not, and a real all-zero week -- the
  // counter having been reset, say -- would 403 the fragment instead of
  // printing "0". This is the mutant this test exists for.
  it("returns 0, not null, when matching rows all have zero hits", async () => {
    seedFoodbank({ modified: "2026-09-05 19:28:08.853000" });
    seedHit(1, "2026-09-04", 0);
    seedHit(1, "2026-09-05", 0);

    await expect(getRecentHitsTotal(session, "2026-08-30")).resolves.toBe(0);
  });

  // SUM() over an empty set is NULL in SQLite exactly as it is in Postgres,
  // which is what makes Django's aggregate()['hits__sum'] None here too --
  // so the port and the original agree on the 403 without either side
  // special-casing it.
  it("returns null when no row matches", async () => {
    seedFoodbank({ modified: "2026-09-05 19:28:08.853000" });
    seedHit(1, "2026-08-01", 500);

    await expect(getRecentHitsTotal(session, "2026-08-30")).resolves.toBeNull();
  });

  it("returns null when the table is empty", async () => {
    await expect(getRecentHitsTotal(session, "2026-08-30")).resolves.toBeNull();
  });

  // WHY isoDate()'s slice(0, 10) IS LOAD-BEARING. day holds 'YYYY-MM-DD' and
  // the comparison is lexicographic, so 'YYYY-MM-DD' < 'YYYY-MM-DD 00:00:00'
  // -- the shorter string is a prefix of the longer one. Hand this function a
  // datetime threshold instead of a date and the threshold day's rows
  // silently vanish from the total, with no error and no clue. Both callers
  // (workers/site/src/routes/public/frag.ts:81 and workers/jobs/src/scheduled
  // /index.ts:308) truncate to ten characters first, which is the only reason
  // this does not happen in production; this test is what tells the next
  // person that the truncation is not cosmetic.
  it("SUSPECT-BY-DESIGN: a datetime threshold silently drops the whole threshold day", async () => {
    seedFoodbank({ modified: "2026-09-05 19:28:08.853000" });
    seedHit(1, "2026-08-30", 7);
    seedHit(1, "2026-08-31", 3);

    await expect(getRecentHitsTotal(session, "2026-08-30")).resolves.toBe(10);
    await expect(getRecentHitsTotal(session, "2026-08-30 00:00:00")).resolves.toBe(3);
  });

  // THE THRESHOLD IS BOUND, NOT INTERPOLATED, and this test had to be
  // rewritten to prove it. MUTANT KILLED: `.bind(sinceDay)` replaced by a
  // template literal, `WHERE day >= '${sinceDay}'`. The earlier version of
  // this test used the folklore payload "' OR 1=1 --" and SURVIVED that
  // mutant outright, for two compounding reasons worth writing down:
  //
  //   * pasted, it yields `day >= '' OR 1=1 --'`, which is every row;
  //   * bound, it compares against the literal string "' OR 1=1 --", and
  //     "'" is 0x27 while "2" is 0x32, so every 'YYYY-MM-DD' day already
  //     sorts above it -- also every row.
  //
  // Both forms returned the same total over a single seeded row, so the
  // assertion could not tell them apart. The payload below can: bound, it
  // is a year-9999 threshold that no 2026 day reaches (null); pasted, it
  // closes the literal and leaves `OR '1'='1'`, matching everything (42).
  //
  // Neither call site takes this value from a request -- both compute it
  // from isoDate(Date.now() - 7d) -- which is precisely why interpolating
  // it would read as harmless in review, and why the guard belongs here
  // rather than in a caller. It doubles as the check that a quote in a
  // bound value does not blow the statement up. Nothing in this module
  // builds a variable-length IN list or takes a second parameter, so D1's
  // 100-bound-parameter limit is out of reach and there is no pair of
  // same-typed binds to swap; both queries are single-row aggregates, so
  // there is likewise no ORDER BY or LIMIT to mutate. Stated so the next
  // reader knows those cases are absent, not forgotten.
  it("binds the threshold as a parameter rather than pasting it into the SQL", async () => {
    seedFoodbank({ modified: "2026-09-05 19:28:08.853000" });
    seedHit(1, "2026-09-04", 42);

    await expect(getRecentHitsTotal(session, "9999-01-01' OR '1'='1")).resolves.toBeNull();
    // The mirror image, so the mutant cannot pass by answering null to
    // everything: an ordinary threshold over the same seeded row still sums.
    await expect(getRecentHitsTotal(session, "2026-08-30")).resolves.toBe(42);
  });

  it("survives a null row without throwing", async () => {
    const nullSession = { prepare: () => ({ bind: () => ({ first: async () => null }) }) } as unknown as Session;

    await expect(getRecentHitsTotal(nullSession, "2026-08-30")).resolves.toBeNull();
  });
});
