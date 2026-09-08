import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/wfbn/newsCharity.ts -- wfbnFoodbankNews (GET /needs/at/<slug>/news/)
// and wfbnFoodbankCharity (GET /needs/at/<slug>/charity/), each with its three
// locale-prefixed twins. Ported from gfwfbn/views.py:620-656 (`foodbank_news`
// and `foodbank_charity`), read in full alongside this file together with
// gfwfbn/templates/wfbn/foodbank/news.html, charity.html and the menu/pagetitle
// includes both versions share, and givefood/models/foodbank.py's articles(),
// has_charity_details(), open_charities_url() and charity_purpose_list().
//
// WHY THIS FILE EXISTS. Both handlers are eleven lines of guard-and-render, and
// everything that can go wrong with them renders a perfectly convincing 200:
//
//   * the news page's ONLY reason to exist is the article list, and every one
//     of its rows is a computed value -- a title run through capwords and an
//     acronym table, a url with ?ref= merged into whatever query it already
//     had, and a date formatted with Django's `N j, Y, P`. All three are
//     silent when wrong: a mangled title still looks like a title.
//   * `published_date` is TEXT compared LEXICOGRAPHICALLY by SQLite, and the
//     list is ordered by it. The newest article is the whole point of the page
//     and nothing on it says which order it was meant to be in.
//   * the article query is scoped by foodbank_id. A filter that stopped
//     filtering would put a neighbouring food bank's news on this page, which
//     no shape-only assertion could see -- so a foreign article and an orphan
//     article are both seeded and both asserted ABSENT.
//   * BOTH handlers are guarded, and a dropped guard is a 200 where production
//     serves a 404: a food bank with no feed at all would get an empty news
//     page, and one in Jersey a charity page whose Regulator row is blank
//     because no branch matches its country.
//   * `has_charity_details` is passed by the news handler purely to decide
//     whether the shared menu offers a Charity link -- to a page that would
//     404. Hardcode it true and the only symptom is a dead link in a sidebar.
//   * charity_purpose is split with a PYTHON splitlines port; a plain
//     .split("\n") differs only for a trailing terminator, i.e. only by one
//     empty bullet at the end of a list nobody re-reads.
//
// So every assertion below reads a VALUE out of the rendered body, out of the
// statement log, or off a response header -- never a bare status code where a
// body assertion was available.
//
// REAL EVERYTHING, the harness routes/wfbn/foodbank.test.ts already uses: the
// real production app (src/index.ts's default export), so the four locale
// registrations, resolveLanguage, slugRedirect, cacheTag, geoJsonPreload and
// pageCacheControl are the genuine articles rather than a hand-built router;
// the real Nunjucks templates and the real .po catalogues; the real
// packages/db queries over real in-memory SQLite whose DDL comes from
// schemaFor(), i.e. from the migrations. Nothing either route touches leaves
// the machine, so NOTHING is mocked -- there is not a single vi.fn() in this
// file except a console.error silencer.
//
// PARITY CLAIMS. Where a comment says "Django does X", X was read out of
// /Users/jasoncartwright/Sites/foodcharity (gfwfbn/views.py,
// givefood/models/foodbank.py, givefood/middleware.py and the wfbn/foodbank
// templates). No Python was EXECUTED for this file -- where a claim would need
// a running Django or Python to settle it, the comment says "not verified"
// rather than inventing a citation.
//
// MUTATION-TESTED, in an rsync'd copy of the tree OUTSIDE the repo (TESTING.md's
// "several suites were mutation-tested"). 27 mutants across these two handlers,
// wfbn/md/newsCharity.ts's three shared helpers and packages/db's
// getArticlesByFoodbankId; ALL 27 KILLED, none survived. Every one was actually
// applied and run rather than imagined:
//   - the news feed guard deleted; each half of it deleted on its own; and the
//     whole thing rewritten as `=== null` instead of falsy -- 4
//   - the charity guard's charity_name half and its country half deleted -- 2
//   - the article limit 20 -> 100, and the ORDER BY flipped to ASC -- 2
//   - getArticlesByFoodbankId's WHERE loosened, so every food bank's articles
//     appear on every news page -- 1
//   - mapArticleRow skipped, i.e. raw rows handed to the template -- 1
//   - has_charity_details hardcoded true on the news page, and hardcoded false
//     on the charity page -- 2
//   - pythonSplitlines replaced with .split("\n") -- 1
//   - openCharitiesUrl's NIC strip dropped, and its Scotland branch pointed at
//     the England/Wales path -- 2
//   - formatCharityRegDate's 11/12/13 exception dropped -- 1
//   - charity_reg_date passed through unformatted -- 1
//   - fullNameLocaleAware given a null alt_name, and render() called with a
//     fixed "en" on each page -- 3
//   - section renamed on each page -- 2
//   - pageTranslatable false, unprefixedPath dropped, render_time_ms dropped,
//     charity_years given a non-empty array -- 4
//   - a second D1 session opened for the article query -- 1

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
// shim as routes/wfbn/foodbank.test.ts, including its `batch` --
// getFoodbankBySlug sends the food bank row and its latest need as ONE batch
// and indexes straight into the result array, so this must run them in order
// and return one result per input.
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
    D1_DATABASE_NAME: "givefood-test",
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
  noLocations?: number;
  noDonationPoints?: number | null;
}

function seedFoodbank(s: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, alt_name, slug, address, postcode, country, lat_lng,
       latitude, longitude, network, charity_number, charity_just_foodbank, charity_name,
       charity_type, charity_reg_date, charity_objectives, charity_purpose, contact_email,
       url, shopping_list_url, rss_url, news_url, address_is_administrative, is_closed,
       no_locations, no_donation_points, days_between_needs, latest_need_id, created, modified)
     VALUES (?, ?, ?, ?, ?, '12 High Street\r\nHarnham', 'SP2 8LZ', ?, '51.0688,-1.7945',
       51.0688, -1.7945, 'Trussell', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 14, NULL,
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
    s.noLocations ?? 0,
    s.noDonationPoints ?? null,
  );
}

// published_date is TEXT in Django's own spelling ("2026-09-05 19:28:08.853000",
// a space and six digits of microseconds) throughout, because that is what the
// ETL copied out of Postgres, what migrations/0022_normalise_timestamps.sql
// rewrote the port's own 9 ISO-shaped rows INTO, and what the lexicographic
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

// THE FIXTURE IS THE TEST: each food bank turns exactly one guard or one
// computed field on or off relative to its neighbour.
//
//   1  salisbury    the full page: rss_url only, an England charity with every
//                   optional charity column populated, a lowercase charity_name
//                   (django_title's proof), a trailing newline on
//                   charity_purpose and a CRLF inside charity_objectives
//   2  bath         NO rss_url and NO news_url, NO charity_name -- the food
//                   bank both guards reject. It OWNS ARTICLES anyway, which is
//                   what makes the news 404 mean something
//   3  truro        Jersey: a real charity_name and number, outside
//                   CHARITY_DETAIL_COUNTRIES. news_url only, no rss_url
//   4  caerdydd     Wales, alt_name set -- full_name's cy branch, and the
//                   England/Wales opencharities branch on a non-England country
//   5  glaschu      Scotland, charity_just_foodbank = 1, and NONE of the four
//                   optional charity columns
//   6  beul-feirste Northern Ireland, charity_number carrying the "NIC" prefix
//                   openCharitiesUrl strips
//   7  empty-feeds  rss_url AND news_url both the EMPTY STRING, not NULL
//   8  closed-town  is_closed = 1, with both pages available
//   9  no-number    an England charity_name with a NULL charity_number
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
    noLocations: 2,
    noDonationPoints: 3,
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

  // Seeded HERE rather than inside the test that uses it, because
  // middleware/slugRedirect.ts memoises the whole map at module scope for five
  // minutes: a row inserted after beforeEach's warm-up call would not be in the
  // memo, and the test would silently assert the fall-through instead of the
  // redirect it names.
  db.prepare(
    "INSERT INTO slugredirect (id, old_slug, new_slug, created, modified) VALUES (1, 'old-sarum', 'salisbury', '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')",
  ).run();
}

beforeEach(async () => {
  db = new DatabaseSync(":memory:");
  // schemaFor, not hand-written DDL: getFoodbankBySlug reads through the
  // `foodbankchange_full` VIEW (github #51 -- eight suites 500'd at once when it
  // started doing so), `foodbankarticle` lost its foodbank_name column in
  // migration 0019 and gained a UNIQUE index on url in 0010, and `slugredirect`
  // is read by the slugRedirect middleware on every /needs/at/ URL whether
  // these routes want it or not.
  db.exec(schemaFor("foodbank", "foodbankchange", "foodbankchange_full", "foodbankarticle", "slugredirect"));
  seed();
  prepared = [];
  sessions = 0;

  // WARM THE SLUG-REDIRECT MEMO BEFORE COUNTING ANYTHING. middleware/
  // slugRedirect.ts holds its map in a MODULE-level memo with a 5-minute TTL,
  // so the first /needs/at/ request through this file's isolate opens a second
  // D1 session and issues a `SELECT ... FROM slugredirect` that no later
  // request repeats. Without this line the statement-log assertions below would
  // depend on which test ran first -- exactly the order-dependence that makes a
  // suite flaky the day someone adds a `.only`.
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

// The <ul class="news"> block, one entry per rendered <li>, in document order.
// Reading the three computed values out of each row is the point: the href, the
// capitalised title and the formatted date are three separate ports and each
// can be wrong on its own.
interface RenderedArticle {
  href: string;
  title: string;
  date: string;
}

function newsItems(html: string): RenderedArticle[] {
  const list = /<ul class="news">([\s\S]*?)<\/ul>/.exec(html);
  if (!list) throw new Error("no <ul class=\"news\"> in the rendered page");
  const rows = [...(list[1] as string).matchAll(/<a href="([^"]*)">([^<]*)<\/a><br>\s*<span class="is-size-7">([^<]*)<\/span>/g)];
  return rows.map((m) => ({ href: m[1] as string, title: m[2] as string, date: m[3] as string }));
}

// The <dl> the charity page's left column is, as { term: definition } -- the
// definitions carry markup (the Regulator row is a link), so they are kept raw
// and trimmed rather than stripped.
function charityTerms(html: string): Record<string, string> {
  const list = /<dl>([\s\S]*?)<\/dl>/.exec(html);
  if (!list) throw new Error("no <dl> in the rendered charity page");
  const out: Record<string, string> = {};
  for (const m of (list[1] as string).matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)) {
    out[(m[1] as string).trim()] = (m[2] as string).trim();
  }
  return out;
}

describe("wfbnFoodbankNews -- the response envelope", () => {
  // Django's `foodbank_news` carries @cache_page(SECONDS_IN_DAY)
  // (gfwfbn/views.py:619), and middleware/pageCacheControl.ts's fall-through
  // rule is that same day. The browser number is deliberately NOT Django's --
  // BROWSER_MAX_AGE is 300 because a browser cache cannot be purged.
  it("serves cacheable HTML: five minutes in the browser, a day at the purgeable edge", async () => {
    const res = await get("/needs/at/salisbury/news/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    expect(res.headers.get("Content-Language")).toBe("en");
  });

  // THE TAG IS WHY THE DAY ABOVE IS SAFE. cacheTag.ts derives `fb-<slug>` from
  // the path, so every page under a food bank -- this one included -- is purged
  // by the same queue message that purges its needs page. Cloudflare strips
  // Cache-Tag before the browser sees it, so nobody would notice its absence
  // from outside.
  it("stamps the food bank's own purge tag in every locale", async () => {
    expect((await get("/needs/at/salisbury/news/")).headers.get("Cache-Tag")).toBe("fb-salisbury");
    expect((await get("/cy/needs/at/salisbury/news/")).headers.get("Cache-Tag")).toBe("fb-salisbury");
  });

  // Django's GeoJSONPreload (givefood/middleware.py:95-135) lists `index`,
  // `foodbank`, `foodbank_locations`, `foodbank_donationpoints`,
  // `foodbank_location`, `foodbank_nearby` and `constituency` -- NOT
  // `foodbank_news` or `foodbank_charity`, because neither page has a map. The
  // port's geoJsonPreload lists the same set. Asserted because the news page's
  // route template (/needs/at/:slug/news/) is one URL shape away from the
  // catch-all location route (/needs/at/:slug/:locslug/) that IS listed: if
  // registration order ever changed and the location route matched first, this
  // page would start preloading a geojson it never uses.
  it("sends no geojson preload hint, matching Django's own middleware list", async () => {
    expect((await get("/needs/at/salisbury/news/")).headers.get("Link")).toBeNull();
    expect((await get("/needs/at/salisbury/charity/")).headers.get("Link")).toBeNull();
  });

  // ONE D1 SESSION, THREE STATEMENTS, AND THE SHAPE OF THEM.
  //
  // lib/session.ts opens a single withSession("first-unconstrained") per
  // request so every query sees one snapshot of a replicated database. A
  // handler that opened one per query would render identically.
  //
  // The first two statements are getFoodbankBySlug's BATCH -- one round trip,
  // not two. The third is the article list, and its `20` is Django's own slice
  // (Foodbank.articles(), models/foodbank.py:307-309, `[:20]`) arriving as a
  // BOUND parameter, which is the only place a limit change would show.
  it("reads the page from one session: the batched foodbank+need pair, then twenty articles", async () => {
    await get("/needs/at/salisbury/news/");

    expect(sessions).toBe(1);
    expect(prepared.map((p) => [p.sql, p.params])).toEqual([
      [FOODBANK_SQL, ["salisbury"]],
      [LATEST_NEED_SQL, ["salisbury"]],
      [ARTICLES_SQL, [1, 20]],
    ]);
  });

  // A GET THAT WRITES IS THE FAILURE THIS ASSERTS AGAINST -- a route in this
  // repo has been caught with one before. A page stamped `public,
  // s-maxage=86400` cannot afford a side effect: the edge would serve it once
  // and swallow every subsequent one.
  it("issues nothing but SELECTs, in every locale", async () => {
    for (const prefix of ["", "/cy", "/ga", "/gd"]) await get(`${prefix}/needs/at/salisbury/news/`);

    expect(prepared).not.toHaveLength(0);
    for (const { sql } of prepared) expect(sql).toMatch(/^SELECT /);
  });

  // An unknown slug is Django's get_object_or_404. It must reach the real 404
  // page and, above all, must NOT be stamped cacheable: pageCacheControl only
  // touches 200s and cacheTag only touches ok responses, so a mistyped slug
  // cannot poison the edge with a day-long negative entry.
  it("404s an unknown slug, uncached and untagged, without asking for its articles", async () => {
    const res = await get("/needs/at/nowhere/news/");

    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(res.headers.get("Cache-Tag")).toBeNull();
    // The guard runs BEFORE the article query, so a bad slug costs two
    // statements and not three.
    expect(prepared.map((p) => p.sql)).toEqual([FOODBANK_SQL, LATEST_NEED_SQL]);
  });

  // lib/appendSlash.ts, Django's APPEND_SLASH -- the slashless spelling is what
  // a hand-typed URL and a good many inbound links look like.
  it("redirects the slashless spelling rather than 404ing it", async () => {
    const res = await get("/needs/at/salisbury/news");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/needs/at/salisbury/news/`);
  });

  // GET ONLY, matching Django's `foodbank_news`. index.ts registers this with
  // app.get; a stray app.all would hand a POST to a handler whose response
  // pageCacheControl then stamps public for a day.
  it("does not answer a POST at all", async () => {
    expect((await get("/needs/at/salisbury/news/", { method: "POST" })).status).toBe(404);
  });

  // The slug comparison is SQLite's default case-sensitive `=` on TEXT, so a
  // shouted URL is a 404 rather than a second, uncanonical spelling of the
  // page. A `COLLATE NOCASE` on the column would silently create duplicate
  // content for every food bank's news page too.
  it("does not answer a differently-cased slug", async () => {
    expect((await get("/needs/at/SALISBURY/news/")).status).toBe(404);
  });

  // "en" is never a URL prefix (prefix_default_language=False in Django, and
  // resolveLanguage's PREFIXES set excludes it), and /de/ is not a locale at
  // all -- neither is a second spelling of this page.
  it("does not answer at /en/ or under an unsupported language prefix", async () => {
    expect((await get("/en/needs/at/salisbury/news/")).status).toBe(404);
    expect((await get("/de/needs/at/salisbury/news/")).status).toBe(404);
  });

  // A D1 outage must produce the 500 page, not a news page with an empty list
  // -- and must not be cached, or "this food bank has published nothing" goes
  // out to everyone for a day.
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

    const res = await app.fetch(new Request(`${ORIGIN}/needs/at/salisbury/news/`), broken, execCtx);

    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(await res.text()).not.toContain('<ul class="news">');
  });

  // elapsedMs() reports WHOLE milliseconds, deliberately unlike Django's three
  // decimal places -- on Workers performance.now() is coarsened and the
  // fraction was always ".000". A revert to toFixed(3) shows up here as "Took
  // 0.000ms"; dropping render_time_ms leaves "Took ms". Only the FORMAT is
  // asserted: 0 is a legitimate value on the clock this exists to describe.
  it("stamps the debug comment with a whole-millisecond render time", async () => {
    expect(/⏱️ Took (\S+)/.exec(await body("/needs/at/salisbury/news/"))?.[1]).toMatch(/^\d+ms$/);
  });

  // middleware/slugRedirect.ts's SLUG_PATTERN has an optional third group for
  // exactly this: a renamed food bank's SUB-PAGES must survive the rename too,
  // not just its index. A redirect that dropped the subpath would land a
  // /news/ link on the needs page instead, which looks like a working link.
  it("follows a renamed food bank's slug redirect and keeps the /news/ subpage", async () => {
    const res = await get("/needs/at/old-sarum/news/");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("/needs/at/salisbury/news/");
    // The locale prefix survives the rewrite too -- SLUG_PATTERN captures it
    // as its own group and puts it back, so a Welsh reader of a renamed food
    // bank is not silently dropped into the English page.
    expect((await get("/cy/needs/at/old-sarum/charity/")).headers.get("Location")).toBe("/cy/needs/at/salisbury/charity/");
  });
});

describe("wfbnFoodbankNews -- the feed guard, which is not about articles", () => {
  // gfwfbn/views.py:627-628, `if not foodbank.rss_url and not foodbank.news_url:
  // return HttpResponseNotFound()`. The page exists because the food bank
  // PUBLISHES, not because we happen to hold articles for it -- Bath owns an
  // article and still has no news page.
  it("404s a food bank with neither feed url, even though it has an article", async () => {
    const res = await get("/needs/at/bath/news/");

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("Bath has news too");
    // And the guard short-circuits the query: the article Bath owns is never
    // even fetched.
    expect(prepared.map((p) => p.sql)).toEqual([FOODBANK_SQL, LATEST_NEED_SQL]);
  });

  // EITHER url is enough, and they are checked independently. Truro has
  // news_url and NO rss_url; Salisbury the reverse. A guard that had collapsed
  // into a single-column check would 404 exactly one of these two.
  it("serves the page for rss_url alone and for news_url alone", async () => {
    expect((await get("/needs/at/salisbury/news/")).status).toBe(200);
    expect((await get("/needs/at/truro/news/")).status).toBe(200);
  });

  // THE EMPTY STRING IS NOT A URL. `!foodbank.rss_url` is falsiness, not a NULL
  // test, and D1 holds both spellings of "no feed" -- a scraped-then-blanked
  // column arrives as ''. Django's `not foodbank.rss_url` is falsy for '' too,
  // so this is parity; pinned because "IS NOT NULL" is the obvious-looking way
  // to write the same guard and would 200 this page over an empty list.
  it("treats empty-string feed urls as no feed at all", async () => {
    expect((await get("/needs/at/empty-feeds/news/")).status).toBe(404);
  });

  // The guard runs on the FEED columns and nothing else -- a closed food bank
  // with a feed keeps its news page, and only picks up the noindex meta the
  // template adds. Losing that meta alone leaves a closed food bank's news in
  // the search index indefinitely, with no visible symptom.
  it("still serves a closed food bank's news page, marked noindex", async () => {
    const html = await body("/needs/at/closed-town/news/");

    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(await body("/needs/at/salisbury/news/")).not.toContain('content="noindex"');
  });
});

describe("wfbnFoodbankNews -- the article list, which is the whole page", () => {
  // THE THREE COMPUTED VALUES OF ONE ROW, all from @givefood/models'
  // mapArticleRow:
  //   * url_with_ref is Foodbank.url_with_ref()'s merge, NOT the donation point
  //     variant -- the existing utm_source SURVIVES and ref is added beside it.
  //   * title_captialised is capwords() plus the acronym table plus a
  //     trailing-period strip plus whitespace collapse. "SOUP" is lowered to
  //     "Soup" while "uk" is RESTORED to "UK", which is the pair that says the
  //     acronym pass ran in the right order.
  //   * published_date goes through `|date("N j, Y, P")`, Django's
  //     DATETIME_FORMAT: "Sept." not "Sep." (MONTHS_AP), and a 12-hour clock.
  it("renders each article's ref-merged url, capitalised title and Django-formatted date", async () => {
    seedArticle({
      id: 11,
      foodbankId: 1,
      publishedDate: "2026-09-05 19:28:08.853000",
      title: "SOUP  drive at the uk warehouse.",
      url: "https://salisburyfoodbank.org.uk/news/soup?utm_source=newsletter",
    });

    expect(newsItems(await body("/needs/at/salisbury/news/"))).toEqual([
      {
        href: "https://salisburyfoodbank.org.uk/news/soup?utm_source=newsletter&amp;ref=givefood.org.uk",
        title: "Soup Drive At The UK Warehouse",
        date: "Sept. 5, 2026, 7:28 p.m.",
      },
    ]);
  });

  // Django's `P` token has two special cases the port copies verbatim
  // (django.utils.dateformat.DateFormat.P): an exact midnight and an exact noon
  // print the WORD, not "12 a.m."/"12 p.m.". An article scraped from a feed
  // that carries a date but no time lands on exactly midnight, so this is the
  // ordinary case and not an exotic one.
  it("prints midnight and noon as words, and drops :00 minutes", async () => {
    seedArticle({ id: 12, foodbankId: 1, publishedDate: "2026-09-03 00:00:00.000000", title: "Midnight", url: "https://a.invalid/1" });
    seedArticle({ id: 13, foodbankId: 1, publishedDate: "2026-09-02 12:00:00.000000", title: "Noon", url: "https://a.invalid/2" });
    seedArticle({ id: 14, foodbankId: 1, publishedDate: "2026-09-01 15:00:00.000000", title: "Three", url: "https://a.invalid/3" });

    expect(newsItems(await body("/needs/at/salisbury/news/")).map((a) => a.date)).toEqual([
      "Sept. 3, 2026, midnight",
      "Sept. 2, 2026, noon",
      "Sept. 1, 2026, 3 p.m.",
    ]);
  });

  // ORDER BY published_date DESC, ON TEXT. SQLite compares these
  // lexicographically, which agrees with chronological order ONLY because every
  // stored value has the same fixed width -- the reason
  // migrations/0022_normalise_timestamps.sql exists at all. Two articles on the
  // same day an hour apart is the case a broken comparison gets wrong while
  // still looking sorted.
  it("lists the newest article first, including within a single day", async () => {
    seedArticle({ id: 15, foodbankId: 1, publishedDate: "2026-09-05 09:00:00.000000", title: "Same day morning", url: "https://a.invalid/4" });
    seedArticle({ id: 16, foodbankId: 1, publishedDate: "2026-09-05 21:00:00.000000", title: "Same day evening", url: "https://a.invalid/5" });
    seedArticle({ id: 17, foodbankId: 1, publishedDate: "2025-12-31 23:59:59.999000", title: "Last year", url: "https://a.invalid/6" });

    expect(newsItems(await body("/needs/at/salisbury/news/")).map((a) => a.title)).toEqual(["Same Day Evening", "Same Day Morning", "Last Year"]);
  });

  // THE SCOPE. Caerdydd's article is NEWER than any of Salisbury's, so a
  // `WHERE a.foodbank_id = ?` that stopped filtering would put it at the TOP of
  // Salisbury's list -- and an orphan article (foodbank_id NULL, which the
  // table permits) would be dropped by the JOIN rather than crashing the page.
  // Seeding both and asserting their absence is the only thing that
  // distinguishes a working filter from no filter at all.
  it("shows only this food bank's articles, and never an orphan row", async () => {
    seedArticle({ id: 18, foodbankId: 1, publishedDate: "2026-09-05 19:00:00.000000", title: "Salisbury only", url: "https://a.invalid/7" });
    seedArticle({ id: 19, foodbankId: null, publishedDate: "2026-09-09 19:00:00.000000", title: "Orphan article", url: "https://a.invalid/8" });

    const titles = newsItems(await body("/needs/at/salisbury/news/")).map((a) => a.title);
    expect(titles).toEqual(["Salisbury Only"]);
    expect(titles).not.toContain("Newyddion Caerdydd");
    expect(titles).not.toContain("Orphan Article");
  });

  // Foodbank.articles() slices `[:20]` (givefood/models/foodbank.py:307-309) and
  // the port binds that 20 as the LIMIT. 22 articles in, 20 out, and the two
  // that fall off are the two OLDEST -- so a limit applied before the sort, or
  // a limit quietly raised, both show up here.
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

    const titles = newsItems(await body("/needs/at/salisbury/news/")).map((a) => a.title);
    expect(titles).toHaveLength(20);
    expect(titles[0]).toBe("Story 22");
    expect(titles[19]).toBe("Story 03");
    expect(titles).not.toContain("Story 02");
    expect(titles).not.toContain("Story 01");
  });

  // A food bank with a feed but nothing scraped from it yet is a 200 with an
  // EMPTY list, not a 404 and not an error. Django renders the same empty <ul>.
  // Also the state md/newsCharity.ts's KNOWN DATA-SCOPE GAP comment describes:
  // D1 only recently gained the non-featured articles, so an empty list here is
  // ordinary rather than alarming.
  it("renders an empty list, not an error, when the feed has produced nothing", async () => {
    const html = await body("/needs/at/truro/news/");

    expect(newsItems(html)).toEqual([]);
    expect(html).toContain("<title>News - Truro Foodbank - Give Food</title>");
  });

  // `featured` scopes the HOMEPAGE query, not this one. getArticlesByFoodbankId
  // has no featured predicate, and an article this food bank published is its
  // news whether or not anyone promoted it.
  it("does not filter on featured", async () => {
    seedArticle({ id: 20, foodbankId: 1, publishedDate: "2026-07-01 12:00:00.000000", title: "Unfeatured", url: "https://a.invalid/9", featured: 0 });
    seedArticle({ id: 22, foodbankId: 1, publishedDate: "2026-07-02 12:00:00.000000", title: "Featured", url: "https://a.invalid/10", featured: 1 });

    expect(newsItems(await body("/needs/at/salisbury/news/")).map((a) => a.title)).toEqual(["Featured", "Unfeatured"]);
  });

  // AUTOESCAPING HOLDS ON BOTH HALVES OF A ROW THAT CAME OFF SOMEBODY ELSE'S
  // WEB SITE. A scraped feed is untrusted input by construction, and this is
  // the only page on the site that renders one into an anchor -- title into
  // element text, url into an href attribute. The url additionally goes through
  // WHATWG URL serialisation on its way (searchParams.set re-encodes the whole
  // query, which is why the `=` and the parens come back percent-encoded),
  // so the attribute cannot be broken out of even before escaping runs.
  //
  // `&quot;` is NUNJUCKS' spelling; Django's escape() emits `&#34;` for the
  // same character. A cosmetic divergence with no behavioural difference,
  // recorded here because the byte sequence is what this test asserts.
  it("escapes a hostile title and url out of a scraped feed", async () => {
    seedArticle({
      id: 23,
      foodbankId: 1,
      publishedDate: "2026-06-01 12:00:00.000000",
      title: '<script>alert(1)</script> & "quotes"',
      url: 'https://evil.invalid/?a="onmouseover=alert(1)',
    });

    const html = await body("/needs/at/salisbury/news/");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(newsItems(html)).toEqual([
      {
        href: "https://evil.invalid/?a=%22onmouseover%3Dalert%281%29&amp;ref=givefood.org.uk",
        title: "&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;",
        date: "June 1, 2026, noon",
      },
    ]);
  });
});

describe("wfbnFoodbankCharity -- the response envelope", () => {
  // Django's `foodbank_charity` carries @cache_page(SECONDS_IN_DAY) too
  // (gfwfbn/views.py:637), and gets the same fall-through day here.
  it("serves cacheable HTML with the food bank's purge tag", async () => {
    const res = await get("/needs/at/salisbury/charity/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
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
    await get("/needs/at/salisbury/charity/");

    expect(sessions).toBe(1);
    expect(prepared.map((p) => [p.sql, p.params])).toEqual([
      [FOODBANK_SQL, ["salisbury"]],
      [LATEST_NEED_SQL, ["salisbury"]],
    ]);
  });

  it("issues nothing but SELECTs, in every locale", async () => {
    for (const prefix of ["", "/cy", "/ga", "/gd"]) await get(`${prefix}/needs/at/salisbury/charity/`);

    expect(prepared).not.toHaveLength(0);
    for (const { sql } of prepared) expect(sql).toMatch(/^SELECT /);
  });

  it("404s an unknown slug, uncached and untagged", async () => {
    const res = await get("/needs/at/nowhere/charity/");

    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(res.headers.get("Cache-Tag")).toBeNull();
  });

  it("redirects the slashless spelling and refuses a POST", async () => {
    const redirect = await get("/needs/at/salisbury/charity");
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("Location")).toBe(`${ORIGIN}/needs/at/salisbury/charity/`);

    expect((await get("/needs/at/salisbury/charity/", { method: "POST" })).status).toBe(404);
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

    const res = await app.fetch(new Request(`${ORIGIN}/needs/at/salisbury/charity/`), broken, execCtx);

    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(await res.text()).not.toContain("1130237");
  });
});

describe("wfbnFoodbankCharity -- the two guards, which are an AND of unrelated things", () => {
  // gfwfbn/views.py:645-646, `if not foodbank.charity_name or not
  // foodbank.has_charity_details()`. BOTH halves are separately load-bearing
  // and the fixture separates them: Bath has a UK country and no charity_name,
  // Truro has a charity_name and a country with no register page. Test only one
  // and a dropped half is invisible.
  it("404s a UK food bank with no charity_name and a named charity outside the register countries", async () => {
    expect((await get("/needs/at/bath/charity/")).status).toBe(404);

    const jersey = await get("/needs/at/truro/charity/");
    expect(jersey.status).toBe(404);
    expect(await jersey.text()).not.toContain("Truro Trust");
  });

  // CHARITY_DETAIL_COUNTRIES is the four UK nations
  // (@givefood/models, from givefood/models/foodbank.py:321). All four must
  // serve the page -- a Set that lost a member would 404 an entire nation's
  // charity pages while the other three stayed perfect.
  it("serves all four register countries", async () => {
    for (const slug of ["salisbury", "caerdydd", "glaschu", "beul-feirste"]) {
      expect((await get(`/needs/at/${slug}/charity/`)).status).toBe(200);
    }
  });

  // The empty string is not a charity name. `!foodbank.charity_name` is
  // falsiness, matching Django's `not foodbank.charity_name`; an ETL that wrote
  // '' rather than NULL must not produce a page whose first line reads
  // " operates under a registered charity."
  it("treats an empty-string charity_name as no charity", async () => {
    db.prepare("UPDATE foodbank SET charity_name = '' WHERE slug = 'salisbury'").run();

    expect((await get("/needs/at/salisbury/charity/")).status).toBe(404);
  });

  // charity_NUMBER is not part of either guard -- only charity_name and the
  // country are. So a charity with no number renders, and the number row's
  // anchor gets an EMPTY href because openCharitiesUrl returns null for it and
  // Nunjucks prints null as "". SUSPECT, pinned as-is: Django's charity.html is
  // identical (`<a href="{{ foodbank.open_charities_url }}">`, ungated, with
  // open_charities_url returning None), so this is the port faithfully
  // reproducing a link-to-nowhere rather than a port defect -- but it is a link
  // to the CURRENT PAGE, which is worse than no link.
  it("SUSPECT: renders a self-linking empty href when the charity has a name but no number", async () => {
    const terms = charityTerms(await body("/needs/at/no-number/charity/"));

    expect(terms["Charity number"]).toBe('<a href=""></a>');
  });
});

describe("wfbnFoodbankCharity -- the charity panel", () => {
  // THE WHOLE <dl>, as one value. Every row is a separate branch and reading
  // them together is what catches a row rendered into the wrong term.
  // `charity_name|django_title` is Python's str.title(): the seeded name is
  // deliberately lowercase so the filter's presence is provable.
  it("renders every populated charity row, title-casing the name", async () => {
    expect(charityTerms(await body("/needs/at/salisbury/charity/"))).toEqual({
      "Charity name": "Salisbury Foodbank Trust",
      Regulator: '<a href="https://www.gov.uk/government/organisations/charity-commission?ref=givefood.org.uk">Charity Commission for England &amp; Wales</a>',
      "Charity number": '<a href="https://opencharities.uk/ew/1130237">1130237</a>',
      "Charity type": "Charitable Incorporated Organisation",
      "Registration date": "3rd August 2009",
    });
  });

  // The four optional columns are each gated in the template. Glaschu has none
  // of them, so its <dl> is the two mandatory rows plus the number -- a gate
  // that stopped gating would print "Charity type" over an empty <dd>.
  it("omits the optional rows and both prose sections when the columns are empty", async () => {
    const html = await body("/needs/at/glaschu/charity/");

    expect(Object.keys(charityTerms(html))).toEqual(["Charity name", "Regulator", "Charity number"]);
    expect(html).not.toContain("<h3>Objectives</h3>");
    expect(html).not.toContain("<h3>Purposes</h3>");
  });

  // charity_just_foodbank picks between two whole sentences, and it is the one
  // thing on the page that says whether this charity IS the food bank or merely
  // hosts it. Both spellings are asserted because the flag is a 0/1 INTEGER in
  // D1 and a boolean in Django -- coerceBooleans is what makes `{% if %}` agree,
  // and a 0 that stayed a 0 would still be falsy while a 1 that became "1"
  // would still be truthy, so only the pair proves the branch.
  it("switches the opening sentence on charity_just_foodbank", async () => {
    expect(await body("/needs/at/salisbury/charity/")).toContain("<p>Salisbury Foodbank operates under a registered charity.</p>");
    expect(await body("/needs/at/glaschu/charity/")).toContain("<p>Glaschu Foodbank is a registered charity.</p>");
  });

  // The Regulator row is three independent {% if %}s over the country column
  // -- not an if/elif chain -- so a country matching none of them (impossible
  // past the guard) renders an empty <dd>, and a country matching two would
  // render two links. Each of the four countries is checked because the
  // England/Wales row is a SHARED branch and the other two are their own.
  it("names the right regulator for each of the four countries", async () => {
    expect(charityTerms(await body("/needs/at/caerdydd/charity/")).Regulator).toContain("Charity Commission for England &amp; Wales");
    expect(charityTerms(await body("/needs/at/glaschu/charity/")).Regulator).toContain("Office of the Scottish Charity Regulator");
    expect(charityTerms(await body("/needs/at/beul-feirste/charity/")).Regulator).toContain("The Charity Commission for Northern Ireland");
    // One link, not two -- the un-chained {% if %}s only ever match once.
    expect((charityTerms(await body("/needs/at/salisbury/charity/")).Regulator ?? "").match(/<a /g)).toHaveLength(1);
  });

  // charity_objectives goes through |linebreaksbr, so the CRLF the regulator
  // APIs return becomes a single <br> rather than a literal newline swallowed
  // by HTML whitespace collapsing.
  it("renders the objectives paragraph with its line breaks preserved", async () => {
    expect(await body("/needs/at/salisbury/charity/")).toContain("<p>To relieve financial hardship<br>in and around the city</p>");
  });

  // THE DELIBERATE GAP. `charity_years` is hardcoded `[]` because D1 has no
  // charityyear table (packages/db/migrations/*.sql), so the Income &
  // Expenditure table Django renders is permanently absent. Pinned so that the
  // day a migration adds the table, THIS test fails and someone remembers the
  // handler still passes an empty array -- which is exactly the kind of stub
  // that otherwise survives forever.
  it("renders no income and expenditure table, because D1 has no charityyear table", async () => {
    const html = await body("/needs/at/salisbury/charity/");

    expect(html).not.toContain("Expenditure");
    expect(html).not.toContain("<table");
  });
});

describe("wfbnFoodbankCharity -- open_charities_url, one path segment per regulator", () => {
  // Foodbank.open_charities_url() (givefood/models/foodbank.py:339-348).
  // opencharities.uk is a THIRD-PARTY aggregator and is NOT the same target as
  // charity_register_url()'s official register -- the /needs/at/<slug>/ page
  // links to the latter, this page to the former, and the two have been
  // conflated before. Each country gets its own two-letter segment.
  it("builds the country's own opencharities path", async () => {
    expect(charityTerms(await body("/needs/at/salisbury/charity/"))["Charity number"]).toContain('href="https://opencharities.uk/ew/1130237"');
    expect(charityTerms(await body("/needs/at/caerdydd/charity/"))["Charity number"]).toContain('href="https://opencharities.uk/ew/1155555"');
    expect(charityTerms(await body("/needs/at/glaschu/charity/"))["Charity number"]).toContain('href="https://opencharities.uk/sc/SC012345"');
  });

  // NORTHERN IRELAND IS THE ONE THAT TRANSFORMS ITS INPUT: the stored number
  // carries the regulator's "NIC" prefix and opencharities' NI path does not
  // want it. The link text keeps the prefix, the href drops it -- both halves
  // asserted, because a strip applied to the wrong one is still a plausible
  // page.
  it("strips the NIC prefix from the Northern Irish href but not from the visible number", async () => {
    const number = charityTerms(await body("/needs/at/beul-feirste/charity/"))["Charity number"];

    expect(number).toBe('<a href="https://opencharities.uk/ni/104444">NIC104444</a>');
  });
});

describe("wfbnFoodbankCharity -- charity_reg_date, an ordinal date nobody re-reads", () => {
  // formatCharityRegDate (wfbn/md/newsCharity.ts) exists because djangoDate's
  // token table has no S or F, so Django's `jS F Y` is formatted here instead.
  // The 11th/12th/13th exception is the whole reason ordinal suffixes are a
  // function rather than a lookup on the last digit, and 21st/22nd/23rd are
  // what says the exception is scoped to the teens rather than to "any 1".
  it("suffixes every ordinal day correctly, including the teens", async () => {
    const rendered = async (day: string): Promise<string | undefined> => {
      db.prepare("UPDATE foodbank SET charity_reg_date = ? WHERE slug = 'salisbury'").run(`2009-08-${day}`);
      return charityTerms(await body("/needs/at/salisbury/charity/"))["Registration date"];
    };

    expect(await rendered("01")).toBe("1st August 2009");
    expect(await rendered("02")).toBe("2nd August 2009");
    expect(await rendered("03")).toBe("3rd August 2009");
    expect(await rendered("04")).toBe("4th August 2009");
    expect(await rendered("11")).toBe("11th August 2009");
    expect(await rendered("12")).toBe("12th August 2009");
    expect(await rendered("13")).toBe("13th August 2009");
    expect(await rendered("21")).toBe("21st August 2009");
    expect(await rendered("22")).toBe("22nd August 2009");
    expect(await rendered("23")).toBe("23rd August 2009");
  });

  // TWO SPELLINGS OF THE SAME DATE LIVE IN THIS COLUMN. PLAN.md:4504 has the
  // ETL writing `(charity_reg_date AT TIME ZONE 'UTC')::date::text`, i.e. a bare
  // "YYYY-MM-DD", while workers/jobs/src/charity/crawlOpenCharities.ts's own
  // header records that the pre-existing D1 values carried a
  // "00:00:00.000000" suffix. Both must format identically or a charity page
  // would change its wording the first time the daily crawl touched it.
  it("formats the bare date and the midnight-suffixed date identically", async () => {
    db.prepare("UPDATE foodbank SET charity_reg_date = '2009-08-03 00:00:00.000000' WHERE slug = 'salisbury'").run();

    expect(charityTerms(await body("/needs/at/salisbury/charity/"))["Registration date"]).toBe("3rd August 2009");
  });

  // The month name comes from a full-name table, not from an abbreviation --
  // Django's `F` token. December is the one that catches an off-by-one on the
  // zero-based getUTCMonth().
  it("names the first and last months in full", async () => {
    db.prepare("UPDATE foodbank SET charity_reg_date = '2011-01-31' WHERE slug = 'salisbury'").run();
    expect(charityTerms(await body("/needs/at/salisbury/charity/"))["Registration date"]).toBe("31st January 2011");

    db.prepare("UPDATE foodbank SET charity_reg_date = '2011-12-25' WHERE slug = 'salisbury'").run();
    expect(charityTerms(await body("/needs/at/salisbury/charity/"))["Registration date"]).toBe("25th December 2011");
  });

  // A NULL date omits the row entirely rather than rendering an empty one --
  // the handler passes null and the template gates on it.
  it("omits the registration date row when the column is null", async () => {
    db.prepare("UPDATE foodbank SET charity_reg_date = NULL WHERE slug = 'salisbury'").run();

    expect(charityTerms(await body("/needs/at/salisbury/charity/"))).not.toHaveProperty("Registration date");
  });

  // SUSPECT, PINNED AS-IS, AND THE FIRST HALF IS THE WORSE ONE.
  // formatCharityRegDate has no unparseable-value guard, unlike the shared
  // djangoDate filter -- which was given one precisely because a bad stored
  // value 500'd the admin dashboard. Neither branch here throws:
  //
  //   * "registered in 2009" is SALVAGED by V8's lenient Date parser into
  //     2009-01-01, so the page states a precise registration day that is not
  //     in the data at all. Nothing about "1st January 2009" looks wrong.
  //   * "not a date" is genuinely unparseable, and the token substitution
  //     prints "NaNth undefined NaN" -- ugly, but at least visibly broken.
  //
  // Both outputs were produced by running this test, not reasoned about. The
  // column is regulator-supplied so neither is a state today's data reaches,
  // which is exactly why they need a test rather than an observation.
  it("SUSPECT: invents a date from a salvageable string and prints NaN for an unsalvageable one", async () => {
    db.prepare("UPDATE foodbank SET charity_reg_date = 'registered in 2009' WHERE slug = 'salisbury'").run();
    expect(charityTerms(await body("/needs/at/salisbury/charity/"))["Registration date"]).toBe("1st January 2009");

    db.prepare("UPDATE foodbank SET charity_reg_date = 'not a date' WHERE slug = 'salisbury'").run();
    expect(charityTerms(await body("/needs/at/salisbury/charity/"))["Registration date"]).toBe("NaNth undefined NaN");
  });
});

describe("wfbnFoodbankCharity -- charity_purpose_list, a Python splitlines port", () => {
  // Foodbank.charity_purpose_list() (givefood/models/foodbank.py:410-414) is
  // `self.charity_purpose.splitlines()`. Python's splitlines does NOT emit a
  // trailing empty element for a single trailing terminator; JS's plain
  // .split("\n") does, and the symptom is one empty <li> at the end of a bullet
  // list -- invisible in a diff, visible on the page as a stray bullet. The
  // seeded value ends in "\n" on purpose.
  it("drops a trailing newline without dropping a real bullet", async () => {
    const html = await body("/needs/at/salisbury/charity/");
    const purposes = [...html.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]);

    expect(purposes).toEqual(["The prevention or relief of poverty", "General charitable purposes"]);
  });

  // An INTERNAL blank line is a real (empty) line in Python and stays one here
  // -- pythonSplitlines only strips the TRAILING terminator. Pinned as the
  // faithful port: "tidying" the empty bullet away would diverge from Django.
  it("keeps an internal blank line as an empty bullet, as Python does", async () => {
    db.prepare("UPDATE foodbank SET charity_purpose = 'Poverty\n\nEducation' WHERE slug = 'salisbury'").run();

    const purposes = [...(await body("/needs/at/salisbury/charity/")).matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]);
    expect(purposes).toEqual(["Poverty", "", "Education"]);
  });

  // The three line terminators Python's splitlines recognises in ASCII text,
  // mixed in one value. OSCR's purposes arrive comma-joined and are rewritten
  // to lines by workers/jobs/src/charity/crawlOpenCharities.ts's toLines(), so
  // the separator this column holds is not a single fixed one.
  it("splits on CRLF, lone CR and LF alike", async () => {
    db.prepare("UPDATE foodbank SET charity_purpose = 'One\r\nTwo\rThree\nFour\r\n' WHERE slug = 'salisbury'").run();

    const purposes = [...(await body("/needs/at/salisbury/charity/")).matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]);
    expect(purposes).toEqual(["One", "Two", "Three", "Four"]);
  });

  // A single-line purpose has no terminator at all and must survive untouched
  // -- the trailing-strip regex is anchored, so it cannot eat a real character.
  it("leaves a single unterminated line alone", async () => {
    const purposes = [...(await body("/needs/at/caerdydd/charity/")).matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]);

    expect(purposes).toEqual(["Atal tlodi"]);
  });

  // A purpose that is nothing but a newline is truthy, so it reaches
  // pythonSplitlines and produces ONE empty bullet -- CPython's
  // "\n".splitlines() is [''] too, so this is parity and not a port defect.
  // (Not verified by running CPython on this machine; read from the
  // splitlines documentation and from the port's own comment.)
  it("renders a lone newline as a single empty bullet", async () => {
    db.prepare("UPDATE foodbank SET charity_purpose = '\n' WHERE slug = 'salisbury'").run();

    const html = await body("/needs/at/salisbury/charity/");
    expect(html).toContain("<h3>Purposes</h3>");
    expect([...html.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1])).toEqual([""]);
  });
});

describe("both pages -- the shared furniture the handlers are responsible for", () => {
  // `section` is what the shared menu include compares against to mark the
  // current page. Get it wrong and the sidebar highlights the wrong entry --
  // the kind of thing nobody files a bug about and nobody notices in review.
  it("marks its own menu entry active and no other", async () => {
    const news = await body("/needs/at/salisbury/news/");
    expect(news).toContain('<li><a class="is-active" href="/needs/at/salisbury/news/">News</a></li>');
    expect(news).toContain('<li><a href="/needs/at/salisbury/charity/">Charity</a></li>');

    const charity = await body("/needs/at/salisbury/charity/");
    expect(charity).toContain('<li><a class="is-active" href="/needs/at/salisbury/charity/">Charity</a></li>');
    expect(charity).toContain('<li><a href="/needs/at/salisbury/news/">News</a></li>');
  });

  // has_charity_details EXISTS ON THE NEWS PAGE ONLY to gate that menu entry.
  // Truro has a charity_name and a country with no register, so the entry must
  // be absent -- if it were hardcoded true (the obvious simplification, since
  // the charity page passes exactly that) the news page would offer a link to a
  // page that 404s.
  it("hides the Charity menu entry on the news page of a food bank whose charity page would 404", async () => {
    const truro = await body("/needs/at/truro/news/");

    expect(truro).not.toContain(">Charity</a>");
    expect((await get("/needs/at/truro/charity/")).status).toBe(404);
  });

  // The charity page passes `has_charity_details: true` unconditionally,
  // annotated in the source as safe "because the guard above already confirms
  // this". Asserting it means the day the guard changes, the comment is
  // checkable rather than aspirational.
  it("always offers the Charity entry on the charity page itself", async () => {
    expect(await body("/needs/at/beul-feirste/charity/")).toContain('<li><a class="is-active" href="/needs/at/beul-feirste/charity/">Charity</a></li>');
  });

  // Foodbank.full_name() via fullNameLocaleAware: four locales, three rules.
  // Both pages print it in the <title>, the <h1>, the breadcrumb and three
  // <meta>s, so a wrong one is loud -- but a wrong one in ONE locale is silent
  // to an English-speaking reviewer.
  it("appends Foodbank in English and Irish and translates the word in Welsh and Gaelic", async () => {
    expect(await body("/needs/at/salisbury/news/")).toContain("<title>News - Salisbury Foodbank - Give Food</title>");
    expect(await body("/ga/needs/at/salisbury/news/")).toContain("Salisbury Foodbank - Give Food</title>");
    expect(await body("/cy/needs/at/salisbury/news/")).toContain("<title>Newyddion - Banc Bwyd Salisbury - Give Food</title>");
    expect(await body("/gd/needs/at/salisbury/charity/")).toContain("Banca-bìdh Salisbury - Give Food</title>");
  });

  // The cy-with-alt_name branch: alt_name wins OUTRIGHT, no prefix and no
  // suffix, and every other locale ignores it. "Banc Bwyd Caerdydd" is what the
  // cy branch would produce if alt_name were ignored, so its absence is what
  // says alt_name actually won.
  it("uses alt_name verbatim in Welsh only", async () => {
    const cy = await body("/cy/needs/at/caerdydd/charity/");
    expect(cy).toContain("<title>Elusen - Pantri Bwyd Bae Caerdydd - Give Food</title>");
    expect(cy).not.toContain("Banc Bwyd Caerdydd");

    expect(await body("/needs/at/caerdydd/charity/")).toContain("<title>Charity - Caerdydd Foodbank - Give Food</title>");
    expect(await body("/gd/needs/at/caerdydd/charity/")).toContain("Banca-bìdh Caerdydd - Give Food</title>");
  });

  // The real .po catalogue really is loaded and really is applied to the
  // page's own strings -- not just to the shared chrome. If it were not, every
  // locale assertion above would still pass on an all-English page.
  it("renders the charity panel's own labels from the real Welsh catalogue", async () => {
    const terms = charityTerms(await body("/cy/needs/at/salisbury/charity/"));

    expect(Object.keys(terms)).toEqual(["Enw'r elusen", "Rheoleiddiwr", "Rhif elusen", "Math o elusen", "Dyddiad cofrestru"]);
    expect(await body("/cy/needs/at/salisbury/charity/")).toContain("<p>Mae Banc Bwyd Salisbury yn gweithredu o dan elusen gofrestredig.</p>");
    expect(await body("/cy/needs/at/salisbury/charity/")).toContain("<h3>Dibenion</h3>");
  });

  // pageTranslatable: true gates BOTH the four hreflang alternates and the
  // language switcher. Passing false (or forgetting it) delists three languages
  // from search engines while the page still looks perfect. The alternate URLs
  // are built from unprefixedPath, so this also pins that the /news/ and
  // /charity/ suffixes survive the prefix swap -- a dropped unprefixedPath
  // would point every alternate at the site root.
  it("advertises all four language variants of the same sub-page", async () => {
    for (const [page, path] of [
      ["news", "/needs/at/salisbury/news/"],
      ["charity", "/needs/at/salisbury/charity/"],
    ] as const) {
      const html = await body(`/cy${path}`);
      expect(html, page).toContain(`<link rel="alternate" hreflang="en" href="${ORIGIN}${path}">`);
      expect(html, page).toContain(`<link rel="alternate" hreflang="cy" href="${ORIGIN}/cy${path}">`);
      expect(html, page).toContain(`<link rel="alternate" hreflang="ga" href="${ORIGIN}/ga${path}">`);
      expect(html, page).toContain(`<link rel="alternate" hreflang="gd" href="${ORIGIN}/gd${path}">`);
      expect(html, page).toContain('<div class="langswitcher');
      expect(html, page).toContain(`<link rel="canonical" href="${ORIGIN}/cy${path}">`);
    }
  });

  // Every in-site link is built through render()'s locale-bound url(), so the
  // menu and breadcrumb carry the prefix -- while the MARKDOWN alternate does
  // not, because the /md/ views are outside i18n_patterns and have no locale
  // variant to point at.
  it("prefixes in-site links on a locale page but leaves the markdown alternate bare", async () => {
    const html = await body("/cy/needs/at/salisbury/news/");

    expect(html).toContain('href="/cy/needs/at/salisbury/charity/"');
    expect(html).toContain('href="/cy/needs/at/salisbury/nearby/"');
    expect(html).toContain('<link rel="alternate" type="text/markdown" href="/md/needs/at/salisbury/news/">');
  });

  // The hit beacon feeds foodbankhit, which the homepage's "most viewed this
  // week" panel ranks on. A wrong slug here silently attributes one food bank's
  // traffic to another.
  it("fires the hit beacon at this food bank's own endpoint from both pages", async () => {
    const beacon = 'fetch("/needs/at/salisbury/hit/", {method: "POST", keepalive: true});';
    expect(await body("/needs/at/salisbury/news/")).toContain(beacon);
    expect(await body("/needs/at/salisbury/charity/")).toContain(beacon);
  });

  // SUSPECT, AND IT IS A REAL DIVERGENCE. Both templates emit
  // `place:location:latitude`/`longitude` from `latt`/`long`, and NEITHER
  // handler passes them -- routes/wfbn/foodbank.ts does (foodbank.ts:96-97),
  // which is where the templates' expectation came from. Django's news.html and
  // charity.html read `{{ foodbank.latt }}`/`{{ foodbank.long }}`, model methods
  // that always resolve, so production emits real coordinates on both pages and
  // this port emits two empty attributes. Harmless to a reader, wrong to an
  // Open Graph consumer, and one line to fix -- which this file may not do.
  // geo.position is populated from the lat_lng COLUMN on the same pages, which
  // is what makes the empty pair look deliberate rather than missing.
  it("SUSPECT: emits empty place:location meta on both pages, where Django emits the coordinates", async () => {
    for (const path of ["/needs/at/salisbury/news/", "/needs/at/salisbury/charity/"]) {
      const html = await body(path);
      expect(html).toContain('<meta property="place:location:latitude" content="">');
      expect(html).toContain('<meta property="place:location:longitude" content="">');
      expect(html).toContain('<meta name="geo.position" content="51.0688,-1.7945">');
    }
  });

  // SUSPECT, PINNED. news.njk advertises the RSS feed UNCONDITIONALLY, so Truro
  // -- which has a news_url and no rss_url -- tells every feed reader it has a
  // feed at /needs/at/truro/rss.xml. Django's news.html has the same ungated
  // <link>, so this is ported behaviour rather than a port defect; noted
  // because the food bank page's own copy of this link IS gated, so the two
  // pages disagree about whether the same food bank has a feed.
  it("SUSPECT: advertises an RSS feed on the news page of a food bank that has no rss_url", async () => {
    expect(await body("/needs/at/truro/news/")).toContain(
      '<link rel="alternate" type="application/rss+xml" title="RSS feed for Truro Foodbank" href="/needs/at/truro/rss.xml">',
    );
  });

  // The description meta differs between the two templates on purpose, and it
  // is the one place the news page prints the BARE name rather than the full
  // one: Django's news.html uses `{{ foodbank }}` (the model's __str__, i.e.
  // the name) followed by the literal words "food bank", where charity.html
  // uses full_name. Pinned because "make these consistent" is a tidy-up that
  // would change what every news page tells a search engine.
  it("describes the news page with the bare name and the charity page with the full one", async () => {
    expect(await body("/needs/at/salisbury/news/")).toContain('<meta name="description" content="Find what Salisbury food bank is requesting to have donated">');
    expect(await body("/needs/at/salisbury/charity/")).toContain(
      '<meta name="description" content="Find what Salisbury Foodbank is requesting to have donated">',
    );
  });

  // The h1 carries a translated PREFIX on both pages, from the shared
  // pagetitle include -- unlike the food bank page itself, which passes no
  // prefix at all. That include is shared with the locations and donation-point
  // pages, so a prefix lost here would be lost there too.
  it("prefixes the h1 with the translated section name", async () => {
    expect(await body("/needs/at/salisbury/news/")).toMatch(/<h1>\s*News -\s*Salisbury Foodbank\s*<\/h1>/);
    expect(await body("/needs/at/salisbury/charity/")).toMatch(/<h1>\s*Charity -\s*Salisbury Foodbank\s*<\/h1>/);
    expect(await body("/cy/needs/at/salisbury/charity/")).toMatch(/<h1>\s*Elusen -\s*Banc Bwyd Salisbury\s*<\/h1>/);
  });
});
